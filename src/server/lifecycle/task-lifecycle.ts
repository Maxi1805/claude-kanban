/**
 * TaskLifecycle — orchestrates the high-level create/delete flows that span
 * multiple services. Creating a task is a multi-step side-effecting saga:
 *
 *   1. compute a unique slug + the session-root path,
 *   2. persist the task row (so it owns an id),
 *   3. create one git worktree per selected repo,
 *   4. assemble the session root (template CLAUDE.md/.claude symlinks),
 *   5. persist the task_repos rows,
 *   6. spawn the agent pty and persist its pid (+ claude session id),
 *   7. broadcast a board event and return the hydrated task.
 *
 * Any failure after a step that produced a side effect triggers a best-effort
 * rollback so we never leave behind orphan worktrees, branches, or DB rows.
 *
 * Deletion delegates wholesale to {@link CleanupService.teardownTask}, then
 * broadcasts a `task:deleted` board event.
 *
 * Cross-module dependencies are consumed exclusively as the shared service
 * interfaces — never as another module's concrete class.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { makeSlug } from "../services/slug.js";
import type {
  CleanupService,
  GitService,
  PtyService,
  Repositories,
  TaskLifecycle as ITaskLifecycle,
  WorktreeRepoSpec,
} from "../../shared/interfaces.js";
import type {
  BoardEventMsg,
  CreateTaskDTO,
  Project,
  ProjectRepo,
  Task,
  TaskRepo,
} from "../../shared/types.js";

/** Broadcaster for board events. Injected by the server bootstrap. */
export type BoardEventBroadcaster = (event: BoardEventMsg) => void;

/** Options bag so the bootstrap can inject the event broadcaster. */
export interface TaskLifecycleOptions {
  /** Broadcast a board event to connected clients. Defaults to a no-op. */
  broadcast?: BoardEventBroadcaster;
  /**
   * Directory holding Claude session transcripts. Defaults to
   * `~/.claude/projects` (mirrors CleanupServiceImpl). Injectable so tests can
   * point it at a temp dir to drive the resume-vs-fresh decision.
   */
  claudeProjectsDir?: string;
}

export class TaskLifecycleImpl implements ITaskLifecycle {
  private readonly broadcast: BoardEventBroadcaster;
  private readonly claudeProjectsDir: string;
  /**
   * Per-task in-flight respawn promises. When two terminals connect to the same
   * dead task at once, the first call seeds this map and the second awaits the
   * SAME promise, so the agent is respawned exactly once (no double-spawn).
   */
  private readonly ensuring = new Map<string, Promise<void>>();

  constructor(
    private readonly repos: Repositories,
    private readonly git: GitService,
    private readonly pty: PtyService,
    private readonly cleanup: CleanupService,
    options: TaskLifecycleOptions = {},
  ) {
    this.broadcast = options.broadcast ?? (() => {});
    this.claudeProjectsDir =
      options.claudeProjectsDir ??
      path.join(os.homedir(), ".claude", "projects");

    // Clear a task's persisted live agent state the moment its pty exits (the
    // user runs /exit, the agent crashes, the server tears it down). agent_state
    // must reflect a LIVE agent ONLY; once the process is gone the card/sidebar
    // must stop showing "working"/"waiting". The AgentActivityMonitor skips dead
    // tasks (no live pty), so clearing here is the sole writer for the exit case.
    // Mirrors how the spawn path seeds agentState="working": a single global
    // subscription, not per-task.
    this.pty.onExitAny((taskId) => {
      this.repos.tasks.update(taskId, {
        agentState: null,
        agentStateAt: new Date().toISOString(),
      });
    });
  }

  /* ──────────────────────────────────────────────────────────────────────
   * createTask
   * ────────────────────────────────────────────────────────────────────── */

  async createTask(dto: CreateTaskDTO): Promise<Task> {
    const project = this.repos.projects.getById(dto.projectId);
    if (!project) {
      throw new Error(`Project ${dto.projectId} not found`);
    }

    // Resolve the repos this task spans: an explicit subset, or all of them.
    const allRepos = this.repos.projectRepos.listByProject(project.id);
    const selectedRepos = this.selectRepos(allRepos, dto.projectRepoIds);
    if (selectedRepos.length === 0) {
      throw new Error(
        `Project "${project.name}" has no repos to create a task worktree for`,
      );
    }

    // 1. Slug + session root. The slug doubles as the branch name and the
    //    session-root leaf dir; makeSlug embeds a random id so it is unique.
    const slug = dto.slug?.trim() || makeSlug(dto.title);
    const sessionRoot = computeSessionRoot(
      config.worktreeBaseDir,
      project.name,
      slug,
    );

    // 2. Persist the task row first so it owns an id for the worktrees + pty.
    const task = this.repos.tasks.create({
      projectId: project.id,
      title: dto.title,
      description: dto.description ?? null,
      slug,
      status: "running",
    });

    // Persist the computed session root IMMEDIATELY — before any worktree is
    // created — so that if rollback delegates to teardownTask after a partial
    // failure, the teardown can find and remove the session-root dir (with its
    // template CLAUDE.md/.claude symlinks) even though the worktree step never
    // finished. teardownTask reads sessionRoot from the persisted row.
    this.repos.tasks.update(task.id, { sessionRoot });

    // Track side effects for rollback on a partial failure.
    let persistedRepos: TaskRepo[] = [];

    try {
      // 3. Create one worktree per repo on a new `<slug>` branch.
      const repoSpecs: WorktreeRepoSpec[] = selectedRepos.map((r) => ({
        projectRepoId: r.id,
        repoName: r.name,
        repoPath: r.repoPath,
        baseBranch: r.baseBranch,
        setupScript: r.setupScript,
      }));

      const wt = await this.git.createTaskWorktrees({
        taskId: task.id,
        projectName: project.name,
        slug,
        repos: repoSpecs,
        baseDir: config.worktreeBaseDir,
        // Per-project untracked files to COPY into every repo's worktree after
        // creation (best-effort; never fails task creation — see git-service).
        copyFiles: project.copyFiles ?? [],
      });

      // 4. Assemble the session root (idempotent dir + two independent symlinks:
      //    an explicit CLAUDE.md FILE and a .claude DIRECTORY). Precedence per
      //    source, so existing projects (legacy folder) and the global fallback
      //    keep working:
      //      md  = project.claudeMdPath
      //            ?? <legacy folder>/CLAUDE.md
      //            ?? <global template>/CLAUDE.md
      //      dir = project.claudeDirPath
      //            ?? <legacy folder>/.claude
      //            ?? <global template>/.claude
      //      mcp = project.mcpConfigPath
      //            ?? <legacy folder>/.mcp.json
      //            ?? <global template>/.mcp.json
      const { claudeMdPath, claudeDirPath, mcpConfigPath } =
        resolveClaudeSources(project, config.templateRepoPath);
      await this.git.assembleSessionRoot({
        sessionRoot: wt.sessionRoot,
        claudeMdPath,
        claudeDirPath,
        mcpConfigPath,
      });

      // Record the resolved session root on the task.
      this.repos.tasks.update(task.id, { sessionRoot: wt.sessionRoot });

      // 5. Persist the task_repos rows (strip the placeholder ids). Done BEFORE
      //    the pty spawn so that a later failure's rollback (teardownTask) can
      //    see — and remove — the worktrees from the DB.
      persistedRepos = this.repos.taskRepos.createMany(
        wt.taskRepos.map((tr) => ({
          taskId: task.id,
          projectRepoId: tr.projectRepoId,
          repoName: tr.repoName,
          branchName: tr.branchName,
          worktreePath: tr.worktreePath,
          remotePushed: tr.remotePushed,
        })),
      );

      // (No auto-run here.) The repo run script is no longer launched at create
      // time with a pre-allocated port — running a repo (and allocating its
      // $PORT) is now a manual panel button handled by CommandRunnerService.

      // 6. Spawn the agent pty at the session root and persist its pid.
      const taskWithRoot: Task = {
        ...task,
        sessionRoot: wt.sessionRoot,
        status: "running",
      };
      const handle = await this.pty.spawnForTask(taskWithRoot);
      // A freshly spawned agent is alive but IDLE — waiting for the user's first
      // prompt, NOT working. "working" means a turn is in progress and is set only
      // by an activity hook (api/agent-events.ts). Keep the new task in the
      // Corriendo column (explicit status="running"); it shows "te espera" there
      // until the user starts a turn.
      this.repos.tasks.update(task.id, {
        ptyPid: handle.pid,
        status: "running",
        agentState: "waiting",
        agentStateAt: new Date().toISOString(),
      });
    } catch (err) {
      // Roll back every side effect produced so far, then re-throw. Delegating
      // to the CleanupService gives us the SAME guarantees as a normal delete:
      // the death-barrier (wait for the pty's whole process group to die), the
      // busy-guard (never force-remove a tree another tool holds open), session
      // -root + transcript cleanup, port reclaim, and per-step isolation.
      await this.rollbackCreate(task.id);
      throw err;
    }

    // 7. Re-read the fully hydrated task and broadcast its creation.
    const finalTask =
      this.repos.tasks.getById(task.id, { withRepos: true }) ?? {
        ...task,
        sessionRoot,
        repos: persistedRepos,
      };

    this.broadcast({
      type: "board:event",
      kind: "task:created",
      taskId: finalTask.id,
      projectId: finalTask.projectId,
      task: finalTask,
    });

    return finalTask;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * ensureAgent — respawn a dead task's agent so the terminal works again
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Ensure the task's agent pty is live, RESPAWNING it when it has died (dev
   * server restart, reboot, the user exiting claude — even days later). The
   * pty's in-memory record vanishes when the parent process dies, but the
   * conversation transcript persists on disk, so respawning with resume args
   * (`claude --continue`) at the session root continues the prior conversation
   * and the terminal accepts input again.
   *
   * No-op when the pty is already live, or when the task is missing / has no
   * session root (nothing to resume). Concurrency-safe: a per-task in-flight
   * promise map collapses two simultaneous connects into a SINGLE respawn — the
   * second caller awaits the first's promise. Resilient: spawn errors are
   * swallowed/logged and never thrown to the caller, so the ws bridge can always
   * proceed to attach.
   */
  async ensureAgent(taskId: string): Promise<void> {
    // Already live → nothing to do.
    if (this.pty.has(taskId)) return;

    // Collapse concurrent connects onto one respawn: if a respawn is already in
    // flight for this task, await the SAME promise instead of spawning twice.
    const inFlight = this.ensuring.get(taskId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const promise = this.respawnAgent(taskId).finally(() => {
      this.ensuring.delete(taskId);
    });
    this.ensuring.set(taskId, promise);
    await promise;
  }

  /**
   * Do the actual respawn for {@link ensureAgent}: load the task, bail if it is
   * gone or has no session root, otherwise spawn the agent and persist the new
   * pid. Resume (`claude --continue`) is used ONLY when a resumable transcript
   * actually exists on disk for the session root; otherwise we spawn a FRESH
   * `claude` ({ resume: false }) so the terminal is usable. (A bare `--continue`
   * with no transcript prints "No conversation found to continue" and exits,
   * leaving a dead terminal.) Re-checks `pty.has` under the in-flight guard to
   * avoid racing a spawn that landed between the outer check and here. Never
   * throws — a failed respawn just leaves the task without a live pty (the
   * bridge still replays history), and the error is logged.
   */
  private async respawnAgent(taskId: string): Promise<void> {
    try {
      // Re-check under the guard: a spawn may have completed between the public
      // entry's `has` check and acquiring the in-flight slot.
      if (this.pty.has(taskId)) return;

      const task = this.repos.tasks.getById(taskId);
      if (!task || !task.sessionRoot) return; // nothing to resume

      const resume = this.hasResumableTranscript(task.sessionRoot);
      const handle = await this.pty.spawnForTask(task, { resume });
      // A (re)spawned agent is alive but IDLE — waiting for the user's next prompt,
      // NOT working. Reopening a task's chat must NOT show "trabajando" (and must
      // NOT move it to Corriendo): only a real activity hook promotes it. So we
      // write "waiting" with NO status change here (no auto-move on reopen).
      const updated = this.repos.tasks.update(task.id, {
        ptyPid: handle.pid,
        agentState: "waiting",
        agentStateAt: new Date().toISOString(),
      });
      if (!updated) return;
      // Broadcast so a card already in Corriendo reflects "te espera" live (a card
      // in another column hides the agent badge). The bare update does not emit a
      // board event on its own. Re-fetch fully hydrated, falling back to the row.
      const hydrated =
        this.repos.tasks.getById(task.id, { withRepos: true }) ?? updated;
      this.broadcast({
        type: "board:event",
        kind: "task:updated",
        taskId: hydrated.id,
        projectId: hydrated.projectId,
        task: hydrated,
      });
    } catch (err) {
      console.error(`[lifecycle] ensureAgent respawn failed for ${taskId}:`, err);
    }
  }

  /**
   * True iff a resumable Claude transcript exists for this session root: i.e. the
   * session root's transcript dir contains at least one `*.jsonl` file. Mirrors
   * how CleanupService locates transcripts — Claude Code stores them under
   * `<claudeProjectsDir>/<encoded>` where `<encoded>` is the absolute session
   * root with every non-alphanumeric character replaced by `-`. Any error
   * (missing dir, unreadable, …) is treated as "no transcript" → false, so the
   * caller falls back to a fresh, usable terminal.
   */
  private hasResumableTranscript(sessionRoot: string): boolean {
    try {
      const encoded = path.resolve(sessionRoot).replace(/[^a-zA-Z0-9]/g, "-");
      const dir = path.join(this.claudeProjectsDir, encoded);
      return fs.readdirSync(dir).some((name) => name.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * deleteTask
   * ────────────────────────────────────────────────────────────────────── */

  async deleteTask(taskId: string): Promise<void> {
    // Capture the project id before teardown removes the row, so the broadcast
    // can still attribute the event to its project.
    const task = this.repos.tasks.getById(taskId);
    const projectId = task?.projectId;

    await this.cleanup.teardownTask(taskId);

    this.broadcast({
      type: "board:event",
      kind: "task:deleted",
      taskId,
      ...(projectId ? { projectId } : {}),
    });
  }

  /* ──────────────────────────────────────────────────────────────────────
   * deleteProject
   * ────────────────────────────────────────────────────────────────────── */

  async deleteProject(projectId: string): Promise<boolean> {
    const project = this.repos.projects.getById(projectId);
    if (!project) return false;

    // Tear every task down FIRST so no worktree, branch, pty, port, transcript,
    // log or session root is left orphaned on disk — the exact leak a bare DB
    // `DELETE ... ON DELETE CASCADE` would cause. teardownTask is fully
    // resilient (death-barrier, busy-guard, per-step isolation) and also drops
    // the task's own DB rows. Best-effort per task: a single task's failure is
    // logged and swallowed so it never blocks removing the rest — or the project.
    const tasks = this.repos.tasks.list({ projectId });
    for (const task of tasks) {
      try {
        await this.cleanup.teardownTask(task.id);
      } catch (err) {
        console.error(
          `[lifecycle] deleteProject(${projectId}): teardown of task ${task.id} failed:`,
          err,
        );
      }
    }

    // Delete the project row. The DB's ON DELETE CASCADE now safely drops the
    // project_repos (every task that referenced them was torn down above, so no
    // live worktree/branch/pty is left pointing at a vanished repo).
    const deleted = this.repos.projects.delete(projectId);

    // One board event is enough: the client's `project:deleted` handler removes
    // the project AND all of its tasks/selection locally, so no per-task
    // `task:deleted` fan-out is needed.
    this.broadcast({
      type: "board:event",
      kind: "project:deleted",
      projectId,
    });

    return deleted;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Helpers
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Resolve which project repos a task spans. When `ids` is omitted, every
   * repo on the project is used; otherwise the listed ids are kept in the
   * project's order. Unknown ids throw so the caller fails loudly.
   */
  private selectRepos(
    allRepos: ProjectRepo[],
    ids?: string[],
  ): ProjectRepo[] {
    if (!ids || ids.length === 0) return allRepos;
    const byId = new Map(allRepos.map((r) => [r.id, r]));
    const selected: ProjectRepo[] = [];
    for (const id of ids) {
      const repo = byId.get(id);
      if (!repo) {
        throw new Error(`Project repo ${id} is not registered on this project`);
      }
      selected.push(repo);
    }
    return selected;
  }

  /**
   * Best-effort rollback of a partially-created task. Delegates wholesale to
   * {@link CleanupService.teardownTask} so the create-failure path inherits the
   * exact same safety guarantees as a user-initiated delete — the death barrier
   * (wait for the pty's whole process group to die before touching files), the
   * busy-guard (never force-remove a tree another tool holds open), teardown
   * scripts, session-root + Claude-transcript removal, port reclaim, and
   * per-step isolation. The task row (and any persisted task_repos) still exist
   * at this point, and the session root was persisted up front, so teardownTask
   * has everything it needs to clean up. Swallows its own failures — the
   * original create error is what the caller re-throws.
   */
  private async rollbackCreate(taskId: string): Promise<void> {
    try {
      await this.cleanup.teardownTask(taskId);
    } catch {
      /* best-effort: never mask the original create failure */
    }
  }

}

/* ──────────────────────────────────────────────────────────────────────────
 * Free helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Compute the session-root path: `<base>/<projectName>/<slug>`. */
function computeSessionRoot(
  baseDir: string,
  projectName: string,
  slug: string,
): string {
  return path.join(baseDir, projectName, slug);
}

/**
 * Resolve the three explicit per-task config sources (a CLAUDE.md FILE, a
 * .claude DIRECTORY and an .mcp.json FILE) for a task's session root, applying
 * the per-source precedence:
 *
 *   md  = project.claudeMdPath
 *         ?? (project.claudeConfigPath ? <claudeConfigPath>/CLAUDE.md
 *                                      : (templateRepoPath ? <templateRepoPath>/CLAUDE.md : null))
 *   dir = project.claudeDirPath
 *         ?? (project.claudeConfigPath ? <claudeConfigPath>/.claude
 *                                      : (templateRepoPath ? <templateRepoPath>/.claude : null))
 *   mcp = project.mcpConfigPath
 *         ?? (project.claudeConfigPath ? <claudeConfigPath>/.mcp.json
 *                                      : (templateRepoPath ? <templateRepoPath>/.mcp.json : null))
 *
 * The new per-source fields win when set; otherwise existing projects with the
 * legacy folder, and the global template fallback, keep working. Existence of
 * each resolved path is checked downstream by assembleSessionRoot, so a derived
 * path that has no CLAUDE.md / .claude / .mcp.json on disk simply yields no link.
 *
 * Exported for unit testing of the precedence rules.
 */
export function resolveClaudeSources(
  project: Pick<
    Project,
    "claudeMdPath" | "claudeDirPath" | "claudeConfigPath" | "mcpConfigPath"
  >,
  templateRepoPath: string | null,
): {
  claudeMdPath: string | null;
  claudeDirPath: string | null;
  mcpConfigPath: string | null;
} {
  const fallbackBase = project.claudeConfigPath ?? templateRepoPath;
  const claudeMdPath =
    project.claudeMdPath ??
    (fallbackBase ? path.join(fallbackBase, "CLAUDE.md") : null);
  const claudeDirPath =
    project.claudeDirPath ??
    (fallbackBase ? path.join(fallbackBase, ".claude") : null);
  const mcpConfigPath =
    project.mcpConfigPath ??
    (fallbackBase ? path.join(fallbackBase, ".mcp.json") : null);
  return { claudeMdPath, claudeDirPath, mcpConfigPath };
}

