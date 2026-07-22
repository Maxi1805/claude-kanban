/**
 * Projects router. Dependency-injected with the repositories handle and an
 * optional board-event emitter (wired by the server bootstrap, which owns the
 * concrete WS broadcaster).
 *
 * Routes (mounted under /api):
 *   GET    /api/projects                 list projects (?withRepos=1 to hydrate)
 *   POST   /api/projects                 create a project (+ repos)
 *   GET    /api/projects/:id             fetch one project (hydrated with repos)
 *   PATCH  /api/projects/:id             update a project (name, claudeConfigPath,
 *                                        claudeMdPath, claudeDirPath,
 *                                        mcpConfigPath, copyFiles)
 *   DELETE /api/projects/:id             delete a project (cascades)
 *   POST   /api/projects/:id/repos       add a repo to a project
 *   PATCH  /api/projects/:id/repos/:rid  update a repo's lifecycle scripts
 *   DELETE /api/projects/:id/repos/:rid  remove a project repo
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Repositories, TaskLifecycle } from "../../shared/interfaces.js";
import type {
  AddRepoDTO,
  BoardEventKind,
  CreateProjectDTO,
  Project,
  Task,
  UpdateRepoDTO,
} from "../../shared/types.js";

/**
 * Emits a board event to connected clients. Provided by the server bootstrap;
 * a no-op default is used when omitted (e.g. in isolated tests). The shape
 * mirrors {@link import("../../shared/types.js").BoardEventMsg} minus its
 * literal `type` discriminant (the bootstrap fills that in when broadcasting).
 */
export type BoardEventEmitter = (event: {
  kind: BoardEventKind;
  taskId?: string;
  projectId?: string;
  project?: Project;
  task?: Task;
}) => void;

export interface ProjectsRouterDeps {
  repos: Repositories;
  /**
   * Task lifecycle orchestrator. When provided, DELETE /api/projects/:id runs
   * the FULL teardown of every task in the project (pty, worktrees, branches,
   * ports, transcripts, logs, session roots) before removing the project, so
   * nothing is orphaned on disk. Optional so isolated router tests can omit it;
   * without it, DELETE falls back to a DB-only cascade (which leaves the
   * project's on-disk task state behind).
   */
  lifecycle?: TaskLifecycle;
  emit?: BoardEventEmitter;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate + resolve the optional `claudeConfigPath` from a request body.
 *
 * Accepted inputs:
 *   • absent / null / empty string  → `{ value: null }` (clears / no override)
 *   • a non-empty string            → resolved to an absolute path; the dir must
 *                                      exist and contain `CLAUDE.md` and/or
 *                                      `.claude`, else `{ error }` (→ 400).
 *   • any other type                → `{ error }` (→ 400).
 */
function parseClaudeConfigPath(
  value: unknown,
): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") {
    return { error: "`claudeConfigPath` must be a string or null" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: null };

  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved)) {
    return {
      error: `\`claudeConfigPath\` does not exist: ${resolved}`,
    };
  }
  const hasClaudeMd = existsSync(path.join(resolved, "CLAUDE.md"));
  const hasClaudeDir = existsSync(path.join(resolved, ".claude"));
  if (!hasClaudeMd && !hasClaudeDir) {
    return {
      error: `\`claudeConfigPath\` must be a folder containing CLAUDE.md and/or .claude: ${resolved}`,
    };
  }
  return { value: resolved };
}

/**
 * Validate + resolve an optional explicit Claude source path that must be of a
 * specific kind ("file" → an existing regular file used as CLAUDE.md; "dir" → an
 * existing directory used as .claude). Best-effort `statSync` isFile/isDirectory.
 *
 * Accepted inputs:
 *   • absent / null / empty string  → `{ value: null }` (unset / no override)
 *   • a non-empty string            → resolved to an absolute path; must exist
 *                                      AND be of the expected kind, else
 *                                      `{ error }` (→ 400).
 *   • any other type                → `{ error }` (→ 400).
 */
function parseClaudeSourcePath(
  field: "claudeMdPath" | "claudeDirPath" | "mcpConfigPath",
  kind: "file" | "dir",
  value: unknown,
): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") {
    return { error: `\`${field}\` must be a string or null` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: null };

  const resolved = path.resolve(trimmed);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return { error: `\`${field}\` does not exist: ${resolved}` };
  }
  if (kind === "file" && !stat.isFile()) {
    return { error: `\`${field}\` must be a file: ${resolved}` };
  }
  if (kind === "dir" && !stat.isDirectory()) {
    return { error: `\`${field}\` must be a directory: ${resolved}` };
  }
  return { value: resolved };
}

/**
 * Validate + normalize the optional `copyFiles` list from a request body.
 *
 * Accepted inputs:
 *   • absent / null                 → `{ value: [] }` (none)
 *   • an array of strings           → trimmed; empty entries dropped; the
 *                                     remaining non-empty strings are returned.
 *   • any other type / non-string
 *     entry                         → `{ error }` (→ 400).
 *
 * NOTE: pattern SAFETY (absolute / `..` rejection, glob expansion) is enforced
 * at copy time in git-service against the concrete repo/worktree roots — here we
 * only guarantee the stored value is a clean array of non-empty strings.
 */
function parseCopyFiles(
  value: unknown,
): { value: string[] } | { error: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) {
    return { error: "`copyFiles` must be an array of strings" };
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { error: "`copyFiles` entries must be strings" };
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return { value: out };
}

/** Validate + normalize an AddRepoDTO from an untyped request body. */
function parseAddRepoDTO(body: unknown): AddRepoDTO | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object" };
  }
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b.name)) {
    return { error: "`name` is required and must be a non-empty string" };
  }
  if (!isNonEmptyString(b.repoPath)) {
    return { error: "`repoPath` is required and must be a non-empty string" };
  }
  if (!isNonEmptyString(b.baseBranch)) {
    return { error: "`baseBranch` is required and must be a non-empty string" };
  }
  const optionalString = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  return {
    name: b.name,
    repoPath: b.repoPath,
    baseBranch: b.baseBranch,
    setupScript: optionalString(b.setupScript),
    runScript: optionalString(b.runScript),
    teardownScript: optionalString(b.teardownScript),
  };
}

/**
 * Validate an UpdateRepoDTO (the three lifecycle scripts) from an untyped body.
 *
 * Each of `setupScript` / `runScript` / `teardownScript` is OPTIONAL; when
 * present it must be a string or null (any other type → `{ error }` → 400).
 * Only the provided fields are carried into the patch; blank/whitespace strings
 * are normalized to null by the repository layer. A body that sets none of the
 * three yields an empty patch (a no-op update that still returns the project).
 */
function parseUpdateRepoDTO(body: unknown): UpdateRepoDTO | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const patch: UpdateRepoDTO = {};
  const fields = ["setupScript", "runScript", "teardownScript"] as const;
  for (const field of fields) {
    const v = b[field];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") {
      return { error: `\`${field}\` must be a string or null` };
    }
    patch[field] = v;
  }
  return patch;
}

export function createProjectsRouter(deps: ProjectsRouterDeps): Router {
  const { repos } = deps;
  const emit: BoardEventEmitter = deps.emit ?? (() => {});
  const router = Router();

  /* GET /api/projects?withRepos=1 */
  router.get("/", (req: Request, res: Response) => {
    const withRepos = req.query.withRepos === "1" || req.query.withRepos === "true";
    const projects = repos.projects.list({ withRepos });
    res.json(projects);
  });

  /* POST /api/projects */
  router.post("/", (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "Request body must be an object" });
      return;
    }
    const b = body as Record<string, unknown>;
    if (!isNonEmptyString(b.name)) {
      res
        .status(400)
        .json({ error: "`name` is required and must be a non-empty string" });
      return;
    }
    if (!Array.isArray(b.repos)) {
      res.status(400).json({ error: "`repos` is required and must be an array" });
      return;
    }

    const parsedRepos: AddRepoDTO[] = [];
    for (const [i, raw] of b.repos.entries()) {
      const parsed = parseAddRepoDTO(raw);
      if ("error" in parsed) {
        res.status(400).json({ error: `repos[${i}]: ${parsed.error}` });
        return;
      }
      parsedRepos.push(parsed);
    }

    const configPath = parseClaudeConfigPath(b.claudeConfigPath);
    if ("error" in configPath) {
      res.status(400).json({ error: configPath.error });
      return;
    }
    const mdPath = parseClaudeSourcePath(
      "claudeMdPath",
      "file",
      b.claudeMdPath,
    );
    if ("error" in mdPath) {
      res.status(400).json({ error: mdPath.error });
      return;
    }
    const dirPath = parseClaudeSourcePath(
      "claudeDirPath",
      "dir",
      b.claudeDirPath,
    );
    if ("error" in dirPath) {
      res.status(400).json({ error: dirPath.error });
      return;
    }
    const mcpPath = parseClaudeSourcePath(
      "mcpConfigPath",
      "file",
      b.mcpConfigPath,
    );
    if ("error" in mcpPath) {
      res.status(400).json({ error: mcpPath.error });
      return;
    }
    const copyFiles = parseCopyFiles(b.copyFiles);
    if ("error" in copyFiles) {
      res.status(400).json({ error: copyFiles.error });
      return;
    }

    const dto: CreateProjectDTO = {
      name: b.name,
      repos: parsedRepos,
      claudeConfigPath: configPath.value,
      claudeMdPath: mdPath.value,
      claudeDirPath: dirPath.value,
      mcpConfigPath: mcpPath.value,
      copyFiles: copyFiles.value,
    };
    const project = repos.projects.create(dto);
    emit({ kind: "project:created", projectId: project.id, project });
    res.status(201).json(project);
  });

  /* GET /api/projects/:id */
  router.get("/:id", (req: Request, res: Response) => {
    const project = repos.projects.getById(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  });

  /* PATCH /api/projects/:id */
  router.patch("/:id", (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "Request body must be an object" });
      return;
    }
    const b = body as Record<string, unknown>;
    const patch: {
      name?: string;
      claudeConfigPath?: string | null;
      claudeMdPath?: string | null;
      claudeDirPath?: string | null;
      mcpConfigPath?: string | null;
      copyFiles?: string[];
    } = {};
    if (b.name !== undefined) {
      if (!isNonEmptyString(b.name)) {
        res.status(400).json({ error: "`name` must be a non-empty string" });
        return;
      }
      patch.name = b.name;
    }
    if (b.claudeConfigPath !== undefined) {
      const configPath = parseClaudeConfigPath(b.claudeConfigPath);
      if ("error" in configPath) {
        res.status(400).json({ error: configPath.error });
        return;
      }
      patch.claudeConfigPath = configPath.value;
    }
    if (b.claudeMdPath !== undefined) {
      const mdPath = parseClaudeSourcePath(
        "claudeMdPath",
        "file",
        b.claudeMdPath,
      );
      if ("error" in mdPath) {
        res.status(400).json({ error: mdPath.error });
        return;
      }
      patch.claudeMdPath = mdPath.value;
    }
    if (b.claudeDirPath !== undefined) {
      const dirPath = parseClaudeSourcePath(
        "claudeDirPath",
        "dir",
        b.claudeDirPath,
      );
      if ("error" in dirPath) {
        res.status(400).json({ error: dirPath.error });
        return;
      }
      patch.claudeDirPath = dirPath.value;
    }
    if (b.mcpConfigPath !== undefined) {
      const mcpPath = parseClaudeSourcePath(
        "mcpConfigPath",
        "file",
        b.mcpConfigPath,
      );
      if ("error" in mcpPath) {
        res.status(400).json({ error: mcpPath.error });
        return;
      }
      patch.mcpConfigPath = mcpPath.value;
    }
    if (b.copyFiles !== undefined) {
      const copyFiles = parseCopyFiles(b.copyFiles);
      if ("error" in copyFiles) {
        res.status(400).json({ error: copyFiles.error });
        return;
      }
      patch.copyFiles = copyFiles.value;
    }

    const updated = repos.projects.update(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    emit({ kind: "project:updated", projectId: updated.id, project: updated });
    res.json(updated);
  });

  /* DELETE /api/projects/:id — cascades: tears down every task's on-disk state
   * (worktrees, branches, ptys, ports, transcripts, logs, session roots) before
   * removing the project, so nothing is left orphaned. */
  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      const { id } = req.params;
      // 404 up front so a missing project is a clean 404 on either path below.
      const project = repos.projects.getById(id);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        if (deps.lifecycle) {
          // Full teardown of every task, then the project row (+ project_repos
          // cascade). deleteProject broadcasts `project:deleted` itself.
          await deps.lifecycle.deleteProject(id);
        } else {
          // No lifecycle wired (isolated tests): DB-only cascade fallback.
          repos.projects.delete(id);
          emit({ kind: "project:deleted", projectId: id });
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  /* POST /api/projects/:id/repos */
  router.post("/:id/repos", (req: Request, res: Response) => {
    const project = repos.projects.getById(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const parsed = parseAddRepoDTO(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    repos.projectRepos.add(project.id, parsed);
    /* Re-read the project so clients see the updated repo set. We return the
     * hydrated Project (not the bare ProjectRepo) so the client contract
     * (addRepo → Promise<Project>) is honest and store reconciliation can
     * upsert the project directly without inventing a phantom entry. */
    const updated = repos.projects.getById(project.id) ?? project;
    emit({ kind: "project:updated", projectId: project.id, project: updated });
    res.status(201).json(updated);
  });

  /* PATCH /api/projects/:id/repos/:repoId */
  router.patch("/:id/repos/:repoId", (req: Request, res: Response) => {
    const { id, repoId } = req.params;
    const repo = repos.projectRepos.getById(repoId);
    if (!repo || repo.projectId !== id) {
      res.status(404).json({ error: "Project repo not found" });
      return;
    }
    const parsed = parseUpdateRepoDTO(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    repos.projectRepos.update(repoId, parsed);
    /* Re-read the project so clients see the updated repo set. We return the
     * hydrated Project (not the bare ProjectRepo) to mirror addRepo/removeRepo
     * so store reconciliation can upsert the project directly. */
    const updated = repos.projects.getById(id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    emit({ kind: "project:updated", projectId: id, project: updated });
    res.json(updated);
  });

  /* DELETE /api/projects/:id/repos/:repoId */
  router.delete("/:id/repos/:repoId", (req: Request, res: Response) => {
    const { id, repoId } = req.params;
    const repo = repos.projectRepos.getById(repoId);
    if (!repo || repo.projectId !== id) {
      res.status(404).json({ error: "Project repo not found" });
      return;
    }
    /* Guard against the FK cascade silently dropping task_repos rows for tasks
     * that still reference this repo. Those rows track live git worktrees,
     * branches and ptys; deleting them here would orphan all of that on disk
     * with no lifecycle teardown. Refuse with 409 and tell the caller to delete
     * the dependent tasks first (which runs the proper teardown). */
    const inUseTaskIds = repos.taskRepos.listTaskIdsByProjectRepo(repoId);
    if (inUseTaskIds.length > 0) {
      res.status(409).json({
        error: `Repo is in use by ${inUseTaskIds.length} task(s); delete those tasks first`,
      });
      return;
    }
    repos.projectRepos.remove(repoId);
    const updated = repos.projects.getById(id);
    if (updated) {
      emit({ kind: "project:updated", projectId: id, project: updated });
    }
    res.status(204).end();
  });

  return router;
}
