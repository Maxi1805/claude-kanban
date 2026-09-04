/**
 * Tasks router. Dependency-injected with the repositories handle, the
 * {@link TaskLifecycle} orchestrator (create/delete side effects: worktrees,
 * session root, pty spawn, full teardown), and an optional board-event emitter.
 *
 * Routes (mounted under /api):
 *   GET    /api/tasks?projectId=&withRepos=1   list tasks for the board
 *   POST   /api/tasks                          create a task (-> lifecycle)
 *   GET    /api/tasks/:id                       fetch one task (hydrated)
 *   PATCH  /api/tasks/:id                       update title/description/status
 *   DELETE /api/tasks/:id                       delete a task (-> lifecycle)
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type {
  PtyService,
  Repositories,
  TaskLifecycle,
} from "../../shared/interfaces.js";
import type {
  CavemanLevel,
  CreateTaskDTO,
  Task,
  TaskStatus,
  UpdateTaskDTO,
} from "../../shared/types.js";
import { CAVEMAN_LEVELS, cavemanPending } from "../../shared/types.js";
import {
  applyCavemanToLiveSession,
  DEFAULT_SUBMIT_TIMING,
  type SubmitTiming,
} from "../services/caveman.js";
import type { BoardEventEmitter } from "./projects.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "running",
  "review",
  "done",
];

export interface TasksRouterDeps {
  repos: Repositories;
  lifecycle: TaskLifecycle;
  emit?: BoardEventEmitter;
  /**
   * Pty service used to push a caveman change into a task's LIVE session.
   * Optional: without it the setting is still persisted and applies on the next
   * spawn — the route never fails over a missing pty.
   */
  pty?: PtyService;
  /**
   * Timings for typing into that live session (see caveman.ts). Injectable so
   * tests can compress the wait-for-quiet to milliseconds; production uses the
   * defaults.
   */
  cavemanTiming?: SubmitTiming;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
  );
}

function isCavemanLevel(value: unknown): value is CavemanLevel {
  return (
    typeof value === "string" &&
    (CAVEMAN_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Validate the optional caveman pair (`cavemanEnabled` / `cavemanLevel`) that
 * both the create and update bodies carry. Only the fields actually present are
 * returned; the caller decides what absence means (a DTO default on create, an
 * untouched field on an update patch). The type checks, the level whitelist and
 * their error messages live here once so both routes reject a bad caveman body
 * identically.
 */
function parseCavemanFields(
  b: Record<string, unknown>,
): { cavemanEnabled?: boolean; cavemanLevel?: CavemanLevel } | { error: string } {
  const out: { cavemanEnabled?: boolean; cavemanLevel?: CavemanLevel } = {};
  if (b.cavemanEnabled !== undefined) {
    if (typeof b.cavemanEnabled !== "boolean") {
      return { error: "`cavemanEnabled` must be a boolean" };
    }
    out.cavemanEnabled = b.cavemanEnabled;
  }
  if (b.cavemanLevel !== undefined) {
    if (!isCavemanLevel(b.cavemanLevel)) {
      return {
        error: `\`cavemanLevel\` must be one of: ${CAVEMAN_LEVELS.join(", ")}`,
      };
    }
    out.cavemanLevel = b.cavemanLevel;
  }
  return out;
}

/**
 * Whether a patch actually changed what the live session should be told. A level
 * change while caveman is OFF changes nothing the session can act on, so it is
 * persisted silently — editing an unchecked selector must never type into a
 * running agent.
 *
 * Whether the session can act on it AT ALL is a separate question, answered by
 * `sessionHasPlugin` inside {@link applyCavemanToLiveSession}: a session spawned
 * without the plugin cannot be talked into having it.
 */
function cavemanChanged(before: Task, after: Task): boolean {
  if (before.cavemanEnabled !== after.cavemanEnabled) return true;
  return after.cavemanEnabled && before.cavemanLevel !== after.cavemanLevel;
}

/**
 * Validate a CreateTaskDTO from an untyped request body. Pure — it neither
 * reads the repositories nor writes anything; the route turns the first
 * `{ error }` into a 400, and only then looks the project up and calls the
 * lifecycle.
 */
function parseCreateTaskDTO(body: unknown): CreateTaskDTO | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b.projectId)) {
    return { error: "`projectId` is required and must be a non-empty string" };
  }
  if (!isNonEmptyString(b.title)) {
    return { error: "`title` is required and must be a non-empty string" };
  }
  if (
    b.description !== undefined &&
    b.description !== null &&
    typeof b.description !== "string"
  ) {
    return { error: "`description` must be a string or null" };
  }
  if (b.slug !== undefined && !isNonEmptyString(b.slug)) {
    return { error: "`slug` must be a non-empty string" };
  }
  if (b.projectRepoIds !== undefined) {
    if (
      !Array.isArray(b.projectRepoIds) ||
      !b.projectRepoIds.every((v) => typeof v === "string")
    ) {
      return { error: "`projectRepoIds` must be an array of strings" };
    }
  }
  const caveman = parseCavemanFields(b);
  if ("error" in caveman) return caveman;

  return {
    projectId: b.projectId,
    title: b.title,
    description: (b.description as string | null | undefined) ?? null,
    slug: b.slug as string | undefined,
    projectRepoIds: b.projectRepoIds as string[] | undefined,
    cavemanEnabled: caveman.cavemanEnabled,
    cavemanLevel: caveman.cavemanLevel,
  };
}

/**
 * Validate a task patch from an untyped body. Only the fields actually sent are
 * carried into the patch; a body that sets none of them yields an empty patch
 * (a no-op update that still returns the task).
 */
function parseUpdateTaskDTO(body: unknown): UpdateTaskDTO | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const patch: UpdateTaskDTO = {};

  if (b.title !== undefined) {
    if (!isNonEmptyString(b.title)) {
      return { error: "`title` must be a non-empty string" };
    }
    patch.title = b.title;
  }
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") {
      return { error: "`description` must be a string or null" };
    }
    patch.description = b.description as string | null;
  }
  if (b.status !== undefined) {
    if (!isTaskStatus(b.status)) {
      return {
        error: `\`status\` must be one of: ${TASK_STATUSES.join(", ")}`,
      };
    }
    patch.status = b.status;
  }
  const caveman = parseCavemanFields(b);
  if ("error" in caveman) return caveman;
  if (caveman.cavemanEnabled !== undefined) {
    patch.cavemanEnabled = caveman.cavemanEnabled;
  }
  if (caveman.cavemanLevel !== undefined) {
    patch.cavemanLevel = caveman.cavemanLevel;
  }

  return patch;
}

/**
 * Push a persisted caveman change out to the task's RUNNING session, when there
 * is one and when the change is something a session can act on. Fire-and-forget
 * by design: typing into the pty first waits for the terminal to go quiet —
 * seconds, potentially — and the board must get its updated task immediately.
 * With no live pty this is a no-op and the setting simply applies at the next
 * spawn.
 */
function propagateCavemanChange(
  deps: TasksRouterDeps,
  before: Task,
  after: Task,
): void {
  if (!cavemanChanged(before, after)) return;

  void applyCavemanToLiveSession(
    deps.pty,
    after,
    deps.cavemanTiming ?? DEFAULT_SUBMIT_TIMING,
  ).catch((err: unknown) => {
    console.error(`[tasks] failed to apply caveman to ${after.id}:`, err);
  });

  // Turning caveman ON cannot reach a session that started without the plugin —
  // only a respawn loads it. Rather than make the user ask for that separately,
  // do it here: kill the pty, and the terminal's reconnect revives it with
  // `--continue`, so the conversation carries on with the plugin loaded.
  //
  // EXCEPT while the agent is WORKING. Then the respawn would cut the turn it is
  // in the middle of, which is never worth doing behind the user's back — the
  // board leaves it pending and offers the restart as a button.
  if (cavemanPending(after) && after.agentState !== "working") {
    deps.pty?.kill(after.id);
  }
}

export function createTasksRouter(deps: TasksRouterDeps): Router {
  const { repos, lifecycle } = deps;
  const emit: BoardEventEmitter = deps.emit ?? (() => {});
  const router = Router();

  /* GET /api/tasks?projectId=&withRepos=0
   * Repos are hydrated by DEFAULT so the board always knows each task's repos
   * (otherwise a plain refresh/board re-mount would overwrite created tasks with
   * un-hydrated copies and the cards would flip to "sin repos"). Pass
   * ?withRepos=0 to opt out. */
  router.get("/", (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const withRepos =
      req.query.withRepos !== "0" && req.query.withRepos !== "false";
    const tasks = repos.tasks.list({ projectId, withRepos });
    res.json(tasks);
  });

  /* POST /api/tasks — delegates to TaskLifecycle.createTask. */
  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    const dto = parseCreateTaskDTO(req.body);
    if ("error" in dto) {
      res.status(400).json({ error: dto.error });
      return;
    }
    if (!repos.projects.getById(dto.projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    try {
      const task = await lifecycle.createTask(dto);
      emit({ kind: "task:created", taskId: task.id, projectId: task.projectId, task });
      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  });

  /* GET /api/tasks/:id */
  router.get("/:id", (req: Request, res: Response) => {
    const task = repos.tasks.getById(req.params.id, { withRepos: true });
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  /* PATCH /api/tasks/:id — title/description/status. */
  router.patch("/:id", (req: Request, res: Response) => {
    const patch = parseUpdateTaskDTO(req.body);
    if ("error" in patch) {
      res.status(400).json({ error: patch.error });
      return;
    }

    const existing = repos.tasks.getById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const statusChanged =
      patch.status !== undefined && patch.status !== existing.status;

    const updated = repos.tasks.update(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const task: Task = repos.tasks.getById(updated.id, { withRepos: true }) ?? updated;

    propagateCavemanChange(deps, existing, task);

    emit({
      kind: statusChanged ? "task:status" : "task:updated",
      taskId: task.id,
      projectId: task.projectId,
      task,
    });
    res.json(task);
  });

  registerTaskAgentRoutes(router, deps);

  /* DELETE /api/tasks/:id — delegates to TaskLifecycle.deleteTask (teardown). */
  router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const task = repos.tasks.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    try {
      await lifecycle.deleteTask(id);
      emit({ kind: "task:deleted", taskId: id, projectId: task.projectId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Register the routes of the task-AGENT sub-resource
 * (`/api/tasks/:id/agent/...`). Its own resource — operations on a task's LIVE
 * pty rather than on the task row — so it lives in its own function, mirroring
 * how the projects router splits its repos sub-resource out.
 */
function registerTaskAgentRoutes(router: Router, deps: TasksRouterDeps): void {
  const { repos } = deps;

  /* POST /api/tasks/:id/agent/restart — restart the task's agent in place.
   *
   * Kills the pty. The terminal's socket is closed by the bridge on exit and the
   * client reconnects, and every reconnect runs `ensureAgent` — which respawns
   * with the resume args (`claude --continue`), so the conversation carries over.
   * The respawn writes a FRESH settings file, which is the only way a caveman
   * checkbox toggled mid-session can take effect.
   *
   * A task with no live pty is a no-op success: its next spawn already picks the
   * new setting up. */
  router.post("/:id/agent/restart", (req: Request, res: Response) => {
    const task = repos.tasks.getById(req.params.id, { withRepos: true });
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const wasLive = deps.pty?.has(task.id) === true;
    if (wasLive) deps.pty?.kill(task.id);
    res.json({ task, restarted: wasLive });
  });
}
