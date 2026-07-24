/**
 * claude-kanban — service contracts.
 *
 * Pure TypeScript interfaces (no classes, no runtime). Each backend module
 * implements the interface it owns; other modules program against these shapes
 * so the parts compose without colliding. All domain shapes come from
 * `./types`.
 */
import type {
  AddRepoDTO,
  AgentState,
  CommandKind,
  CreateProjectDTO,
  CreateTaskDTO,
  DbOverviewResponse,
  DbTableRowsResponse,
  FsInspectResponse,
  FsListResponse,
  FsRootsResponse,
  Project,
  ProjectRepo,
  RunCommandResult,
  Task,
  TaskRepo,
  TaskStatus,
  UpdateRepoDTO,
  UpdateTaskDTO,
} from "./types.js";

/* ────────────────────────────────────────────────────────────────────────
 * GitService — worktree + branch lifecycle across one or more repos.
 *   Owner module: git-service
 * ──────────────────────────────────────────────────────────────────────── */

/** One repo's contribution to a multi-repo task worktree set. */
export interface WorktreeRepoSpec {
  /** ProjectRepo id this worktree derives from. */
  projectRepoId: string;
  /** Repo display name; becomes the worktree dir name under the session root. */
  repoName: string;
  /** Absolute path to the source repository (the worktree origin). */
  repoPath: string;
  /** Branch the new worktree is based on (e.g. "main"). */
  baseBranch: string;
  /** Optional setup script to run inside the worktree after creation. */
  setupScript?: string | null;
}

/** Options for assembling all worktrees of a single task. */
export interface CreateTaskWorktreesOptions {
  /** Task id the worktrees belong to. */
  taskId: string;
  /** Project name segment of the session root path. */
  projectName: string;
  /** Slug used as the new branch name and the session-root leaf dir. */
  slug: string;
  /** Repos to create worktrees for. */
  repos: WorktreeRepoSpec[];
  /** Override the configured worktree base dir for this task. */
  baseDir?: string;
  /**
   * Per-project list of untracked files/dirs to COPY (not symlink) from each
   * source repo's working dir into its freshly created worktree. Each entry is a
   * path RELATIVE to the repo root; a simple `*`/`?` wildcard is allowed in the
   * final path segment only (e.g. `.env*`). Applied to EVERY repo. Best-effort:
   * missing or unsafe (absolute / `..`-containing) patterns are skipped and a
   * copy error NEVER fails worktree/task creation. Omitted/empty ⇒ no copies.
   */
  copyFiles?: string[];
}

/** Result of creating a task's worktrees. */
export interface CreateTaskWorktreesResult {
  /** Absolute path to the assembled session root: <base>/<projectName>/<slug>. */
  sessionRoot: string;
  /** One persisted-shape row per created worktree. */
  taskRepos: TaskRepo[];
}

/** A single worktree entry as reported by `git worktree list`. */
export interface WorktreeInfo {
  /** Absolute path to the worktree. */
  path: string;
  /** Branch checked out in the worktree, if any. */
  branch: string | null;
  /** Commit the worktree HEAD points at. */
  head: string | null;
  /** True for the repo's primary (non-linked) worktree. */
  isMain: boolean;
  /** True if git reports the worktree as locked. */
  locked: boolean;
}

/** Options for symlinking an explicit CLAUDE.md file + .claude dir into a session root. */
export interface AssembleSessionRootOptions {
  /** Absolute path to the session root to populate. */
  sessionRoot: string;
  /**
   * Absolute path to a FILE symlinked to `<sessionRoot>/CLAUDE.md`. Linked only
   * when set AND the source exists. Null/absent skips the CLAUDE.md link.
   */
  claudeMdPath?: string | null;
  /**
   * Absolute path to a DIRECTORY symlinked to `<sessionRoot>/.claude`. Linked
   * only when set AND the source exists. Null/absent skips the .claude link.
   */
  claudeDirPath?: string | null;
  /**
   * Absolute path to a FILE symlinked to `<sessionRoot>/.mcp.json`. Linked only
   * when set AND the source exists. Null/absent skips the .mcp.json link.
   */
  mcpConfigPath?: string | null;
}

/**
 * Git operations for the multi-repo worktree lifecycle. Stateless: every method
 * takes the paths/branches it needs.
 */
export interface GitService {
  /** Create one worktree per repo on a new `<slug>` branch under the session root. */
  createTaskWorktrees(
    opts: CreateTaskWorktreesOptions,
  ): Promise<CreateTaskWorktreesResult>;

  /** Remove every worktree backing the given task_repos (idempotent). */
  removeTaskWorktrees(taskRepos: TaskRepo[]): Promise<void>;

  /** Delete a local branch in the source repo. */
  deleteLocalBranch(repoPath: string, branch: string): Promise<void>;

  /** Delete a branch on the repo's remote (`origin` by default). */
  deleteRemoteBranch(repoPath: string, branch: string): Promise<void>;

  /** `git worktree prune` to clear stale administrative entries. */
  pruneWorktrees(repoPath: string): Promise<void>;

  /** List the worktrees registered for a source repo. */
  listWorktrees(repoPath: string): Promise<WorktreeInfo[]>;

  /** True if the worktree at `path` is busy (locked or dirty/uncommitted). */
  isWorktreeBusy(path: string): Promise<boolean>;

  /**
   * Create the session-root dir and symlink an explicit CLAUDE.md FILE (→
   * `<sessionRoot>/CLAUDE.md`), `.claude` DIRECTORY (→ `<sessionRoot>/.claude`)
   * and `.mcp.json` FILE (→ `<sessionRoot>/.mcp.json`) into it, each only when
   * its source path is set AND exists. Idempotent.
   */
  assembleSessionRoot(opts: AssembleSessionRootOptions): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────
 * FsBrowserService — read-only, allow-rooted filesystem inspection that
 * powers the "browse, don't type" repo picker.
 *   Owner module: fs-browser
 * ──────────────────────────────────────────────────────────────────────── */

/** Raised for any path that is invalid, missing, or outside the allow-roots. */
export class FsBrowseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsBrowseError";
  }
}

/**
 * Local-only filesystem browser. Every method validates the requested path
 * against the configured allow-roots and never throws on permission errors or
 * git failures — it degrades gracefully (skips unreadable entries, returns
 * null/[] for undetectable git metadata). The only thrown error is
 * {@link FsBrowseError} for forbidden/invalid paths, which the router maps to
 * a 400.
 */
export interface FsBrowserService {
  /** The allow-roots the picker may browse from. */
  roots(): FsRootsResponse;

  /**
   * Shallow listing of one directory (defaults to the first allow-root). By
   * default only sub-directories are returned; pass `{ includeFiles: true }` to
   * also surface regular files (flagged `isFile`, sorted after directories) so
   * the picker can show files for orientation.
   */
  list(
    requestedPath?: string,
    opts?: { includeFiles?: boolean },
  ): Promise<FsListResponse>;

  /** Inspect a folder: git-repo flag, suggested name, base branch, children. */
  inspect(requestedPath: string): Promise<FsInspectResponse>;
}

/* ────────────────────────────────────────────────────────────────────────
 * PtyService — one interactive agent process per task.
 *   Owner module: pty-ws
 * ──────────────────────────────────────────────────────────────────────── */

/** Handle describing a live pty for a task. */
export interface PtyHandle {
  taskId: string;
  /** OS pid of the spawned process. */
  pid: number;
  cols: number;
  rows: number;
}

/**
 * Replay payload returned by {@link PtyService.getReplay}: the captured tail to
 * render plus the byte `offset` (total bytes captured for the session) observed
 * at the exact point the tail was read. The ws bridge gates live forwarding on
 * this offset (via {@link PtyService.bytePosition}) so a chunk arriving in the
 * getReplay/attach window is replayed OR sent live, never both, never neither.
 */
export interface PtyReplay {
  /** The captured output tail to render on (re)connect ("" when none). */
  data: string;
  /** Total bytes captured for the session as of this replay cut. */
  offset: number;
}

/** Callback for pty output chunks (raw terminal bytes as a UTF-8 string). */
export type PtyDataListener = (data: string) => void;

/** Callback for pty exit. */
export type PtyExitListener = (exitCode: number, signal: number | null) => void;

/**
 * Callback for ANY task's pty exit. Unlike {@link PtyExitListener} (scoped to a
 * single task), this global listener also receives the `taskId`, so a subscriber
 * registered once can react to every task's agent exiting — e.g. to clear that
 * task's persisted live agent state.
 */
export type PtyExitAnyListener = (
  taskId: string,
  exitCode: number,
  signal: number | null,
) => void;

/** Unsubscribe function returned by the `on*` registrations. */
export type Unsubscribe = () => void;

/**
 * Manages the lifetime of interactive agent processes (one per task) and the
 * fan-out of their I/O.
 */
export interface PtyService {
  /**
   * Spawn the agent in a node-pty at the task's session root. Returns the live
   * handle; throws if the task has no session root or a pty already exists.
   *
   * When `opts.resume` is true the spawn appends `config.agentResumeArgs` (e.g.
   * `--continue`) to the agent command so a RESPAWN of an existing task resumes
   * the prior on-disk conversation instead of starting a fresh one. Omitting
   * `opts` keeps the original fresh-spawn behaviour (backward compatible).
   */
  spawnForTask(task: Task, opts?: { resume?: boolean }): Promise<PtyHandle>;

  /** Whether a live pty currently exists for the task. */
  has(taskId: string): boolean;

  /**
   * Milliseconds since this task's pty last produced OUTPUT — the per-task
   * activity clock the {@link import("./types.js").AgentState} monitor reads.
   * `lastOutputAt` is bumped inside the pty's output handler (and seeded on
   * spawn), so a small idle time means claude is actively streaming ("working")
   * and a large one means it has gone quiet ("waiting"). Returns `undefined` for
   * a task that has no tracked clock (never spawned / already forgotten).
   */
  getIdleMs(taskId: string): number | undefined;

  /**
   * The raw timestamp (epoch ms, `Date.now()`) of the task's most recent pty
   * output, or `undefined` when none is tracked. The companion of
   * {@link getIdleMs} for callers that want the absolute instant rather than the
   * elapsed delta.
   */
  getLastOutputAt(taskId: string): number | undefined;

  /**
   * NUDGE the activity clock to "active now" (`lastOutputAt = Date.now()`) so the
   * next monitor tick reads the task as "working". A no-op for a task with no live
   * pty. Called by the lifecycle on (re)spawn and by the agent-event hooks for
   * working events (UserPromptSubmit / Pre/PostToolUse / SessionStart) so state
   * turns "working" within ~1 tick without parsing any terminal text.
   */
  markActivity(taskId: string): void;

  /**
   * NUDGE the activity clock to "idle now": sets `lastOutputAt` far enough in the
   * past (just beyond the idle threshold) that the next monitor tick flips the
   * task to "waiting". A no-op for a task with no live pty. Called by the
   * agent-event hooks for Stop and Notification (any type) so "waiting" becomes
   * near-instant rather than waiting out the full idle threshold.
   */
  markIdle(taskId: string): void;

  /** Write input bytes to a task's pty. No-op if the task has no live pty. */
  write(taskId: string, data: string): void;

  /** Resize a task's pty. No-op if the task has no live pty. */
  resize(taskId: string, cols: number, rows: number): void;

  /** Terminate a task's pty (idempotent). */
  kill(taskId: string): void;

  /** Subscribe to a task's pty output. Returns an unsubscribe fn. */
  onData(taskId: string, cb: PtyDataListener): Unsubscribe;

  /** Subscribe to a task's pty exit. Returns an unsubscribe fn. */
  onExit(taskId: string, cb: PtyExitListener): Unsubscribe;

  /**
   * Subscribe to EVERY task's pty exit with `(taskId, exitCode, signal)`. The
   * symmetric counterpart of the per-task {@link onExit}: a single global
   * listener fired whenever any pty exits, regardless of which task. Lifecycle
   * uses it to clear a task's persisted live `agent_state` the moment its agent
   * process dies (the user runs /exit, the agent crashes, etc.) so a stale
   * "working" state never lingers. Returns an unsubscribe fn.
   */
  onExitAny(cb: PtyExitAnyListener): Unsubscribe;

  /**
   * The captured output to replay when a terminal (re)connects, capped to the
   * last N bytes of the per-task log (config `ptyReplayBytes`), paired with the
   * byte `offset` observed at the same read. Returns `{ data: "", offset: 0 }`
   * when nothing was captured. Works AFTER the pty has exited — history survives
   * exit. The `offset` lets the bridge forward only live bytes produced after the
   * replay cut (see {@link bytePosition}) so nothing is replayed AND re-sent.
   */
  getReplay(taskId: string): Promise<PtyReplay>;

  /**
   * Total bytes captured for a task's current session so far — the cursor the ws
   * bridge gates live forwarding on. Combined with the `offset` from `getReplay`,
   * the bridge skips any live bytes already covered by the replay so no chunk is
   * both replayed and re-sent (and none dropped). Resets to 0 on a fresh spawn;
   * unknown task → 0.
   */
  bytePosition(taskId: string): number;

  /**
   * Whether the task's pty has already exited (its agent process is gone) while
   * a captured log still exists. Distinguishes "finished session, replay then
   * show exit" from "live session, replay then stream".
   */
  isExited(taskId: string): boolean;

  /**
   * The last recorded exit of a task's pty, or null if it is still live / never
   * spawned. Used to send a trailing `pty:exit` to a terminal reconnecting to an
   * already-finished session.
   */
  lastExit(taskId: string): { exitCode: number; signal: number | null } | null;

  /**
   * Forget all in-memory state for a task after teardown: flush any pending
   * captures (so no in-flight append can re-create the log AFTER the caller
   * deletes it), then purge the task's per-task map entries so they don't leak.
   * Call after the pty is dead and around the log deletion in cleanup. Does NOT
   * delete the log file — the caller owns that.
   */
  forget(taskId: string): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────
 * CommandRunnerService — one interactive shell per (task, repo) (SHELL MODEL).
 *   Owner module: command-runner
 *
 * The command panel is a REAL terminal: the runner manages ONE persistent
 * `bash -il` shell per `(taskId, repoId)`, spawned at the repo's worktree cwd
 * with the parent env, keeping a capped in-memory replay buffer (like the claude
 * pty). The user types into it (keystrokes → shell). The Setup / Run / Teardown
 * buttons no longer spawn their own processes — they WRITE the configured script
 * into this shell (and `run` first injects `export PORT=<freshPort>`). Consumed
 * by the /ws/cmd bridge, the commands API, and CleanupService (which kills a
 * task's shells on teardown). Cross-module deps are types only.
 * ──────────────────────────────────────────────────────────────────────── */

/** Callback for a shell's output chunks (raw terminal bytes as a string). */
export type CmdDataListener = (data: string) => void;

/** Callback for a shell's exit (exitCode null only on abnormal teardown). */
export type CmdExitListener = (exitCode: number | null) => void;

/** Replay payload for a command terminal: the buffered output to render. */
export interface CmdReplay {
  /** The buffered output tail to render on (re)connect ("" when none). */
  data: string;
}

/**
 * Manages one persistent interactive shell per `(taskId, repoId)`, its capped
 * output buffer, and the injection of lifecycle scripts into it.
 */
export interface CommandRunnerService {
  /**
   * Ensure the `(taskId, repoId)` shell is live: spawn `bash -il` at the task's
   * matching worktree cwd (parent env) if not already running. Idempotent — a
   * live shell is reused. Throws when the task/repo cannot be resolved.
   */
  ensureShell(taskId: string, repoId: string): void;

  /**
   * Inject the `kind` lifecycle script into the `(taskId, repoId)` shell:
   * ensure the shell exists, resolve the script text from the matching
   * ProjectRepo (throws when empty/undefined, or when the task/repo is missing),
   * and write it followed by a newline. For `run` a fresh free port is allocated
   * and `export PORT=<port>\n` is written FIRST so the dev server binds it.
   * Returns the allocated port (null for setup/teardown).
   */
  runScript(
    taskId: string,
    repoId: string,
    kind: CommandKind,
  ): Promise<RunCommandResult>;

  /** Subscribe to a shell's output. Returns an unsubscribe fn. */
  onData(taskId: string, repoId: string, cb: CmdDataListener): Unsubscribe;

  /** Subscribe to a shell's exit. Returns an unsubscribe fn. */
  onExit(taskId: string, repoId: string, cb: CmdExitListener): Unsubscribe;

  /** The buffered output to replay when a command terminal (re)connects. */
  getReplay(taskId: string, repoId: string): CmdReplay;

  /** Whether the shell's pty is currently alive. */
  isRunning(taskId: string, repoId: string): boolean;

  /** Write input bytes (user keystrokes) to a shell. No-op if not running. */
  write(taskId: string, repoId: string, data: string): void;

  /** Resize a shell's pty. No-op if not running. */
  resize(taskId: string, repoId: string, cols: number, rows: number): void;

  /**
   * Kill every shell for a task (all repos) — process GROUP — and forget its
   * state. Called by CleanupService BEFORE worktree removal so a running dev
   * server is gone before its tree is torn down. Idempotent.
   */
  killAllForTask(taskId: string): void;
}

/* ────────────────────────────────────────────────────────────────────────
 * CleanupService — teardown + orphan sweeping.
 *   Owner module: cleanup-service
 * ──────────────────────────────────────────────────────────────────────── */

/** What was reclaimed by an orphan sweep. */
export interface SweepResult {
  /** Worktree paths removed because no task references them. */
  removedWorktrees: string[];
  /** Branches deleted because no task references them. */
  removedBranches: string[];
  /** Non-fatal problems encountered during the sweep. */
  errors: string[];
}

/** Full teardown for a single task: kill pty, remove worktrees, delete branches. */
export interface CleanupService {
  /**
   * Run the complete teardown for a task: run teardown scripts, kill its pty,
   * remove every worktree, delete local (and pushed remote) branches, prune.
   */
  teardownTask(taskId: string): Promise<void>;

  /** Find and reclaim worktrees/branches no longer referenced by any task. */
  sweepOrphans(): Promise<SweepResult>;
}

/* ────────────────────────────────────────────────────────────────────────
 * TaskLifecycle — orchestrates create/delete across git, pty, db.
 *   Owner module: lifecycle
 * ──────────────────────────────────────────────────────────────────────── */

/** Orchestration entry points for the create/delete of a task (card). */
export interface TaskLifecycle {
  /**
   * Create a task: persist it, assemble worktrees + session root, spawn the
   * agent pty, and return the fully hydrated task.
   */
  createTask(dto: CreateTaskDTO): Promise<Task>;

  /**
   * Ensure the task's agent pty is live, RESPAWNING it (with resume args, so the
   * prior on-disk conversation continues) when it has died — e.g. after a dev
   * server restart, a reboot, or the user exiting claude, even days later. A
   * no-op when the pty is already alive, or when the task is missing / has no
   * session root (nothing to resume). Concurrency-safe: two terminals connecting
   * at once respawn the agent exactly once. Never throws to the caller (spawn
   * errors are swallowed/logged) so attach can always proceed.
   */
  ensureAgent(taskId: string): Promise<void>;

  /** Delete a task and run full teardown (delegates to CleanupService). */
  deleteTask(taskId: string): Promise<void>;

  /**
   * Delete a project and EVERYTHING it owns. Runs the full per-task teardown
   * (kill pty + command shells, remove worktrees, delete local/remote branches,
   * free ports, delete Claude transcripts + pty logs, remove session roots) for
   * every task in the project — so nothing is left orphaned on disk — then
   * deletes the project row (its project_repos, and any residual task rows,
   * cascade in the DB). Broadcasts `project:deleted`. Best-effort per task: one
   * task's teardown failure never blocks removing the rest or the project.
   * Returns false when no project with that id exists (nothing torn down).
   */
  deleteProject(projectId: string): Promise<boolean>;
}

/* ────────────────────────────────────────────────────────────────────────
 * DbViewerService — read-only live inspection of the app's sqlite database.
 *   Owner module: db-viewer
 * ──────────────────────────────────────────────────────────────────────── */

/** Raised for an unknown table name (the router maps it to a 404). */
export class DbViewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbViewerError";
  }
}

/**
 * Read-only window onto the app's own sqlite file for the `/db` live viewer.
 * Backed by a SEPARATE read-only connection (never the app's writer), which is
 * also what makes change detection work: `PRAGMA data_version` only moves when
 * ANOTHER connection commits, so from this connection's viewpoint every app
 * write (and any external writer) bumps it. Everything is introspected via
 * sqlite_master + pragma table functions — no schema assumptions.
 */
export interface DbViewerService {
  /** Schema + row counts of every user table (sqlite_* internals excluded). */
  overview(): DbOverviewResponse;

  /**
   * One page of a table's rows. `name` must be an existing user table (checked
   * against sqlite_master — never interpolated unvalidated) or
   * {@link DbViewerError} is thrown. `limit` is clamped to a sane maximum.
   */
  tableRows(
    name: string,
    opts?: { limit?: number; offset?: number },
  ): DbTableRowsResponse;

  /**
   * Start polling `PRAGMA data_version` and broadcasting a `db:changed` frame
   * whenever it moved. Idempotent; the interval never holds the process open.
   */
  start(): void;

  /** Stop polling (idempotent). */
  stop(): void;

  /** Close the underlying read-only connection (stops polling first). */
  close(): void;
}

/* ────────────────────────────────────────────────────────────────────────
 * Repositories — persistence (better-sqlite3) returning shared types.
 *   Owner module: db-api
 * ──────────────────────────────────────────────────────────────────────── */

/** Persisted fields a task can be patched with internally. */
export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  slug?: string;
  sessionRoot?: string | null;
  ptyPid?: number | null;
  claudeSessionId?: string | null;
  port?: number | null;
  /** Live agent state derived from Claude Code hooks. */
  agentState?: AgentState | null;
  /** ISO-8601 timestamp of the last agentState transition. */
  agentStateAt?: string | null;
}

/** Persistence for projects. */
export interface ProjectRepository {
  create(dto: CreateProjectDTO): Project;
  getById(id: string): Project | null;
  /** All projects, optionally hydrated with their repos. */
  list(opts?: { withRepos?: boolean }): Project[];
  update(
    id: string,
    patch: {
      name?: string;
      claudeConfigPath?: string | null;
      claudeMdPath?: string | null;
      claudeDirPath?: string | null;
      mcpConfigPath?: string | null;
      copyFiles?: string[];
    },
  ): Project | null;
  delete(id: string): boolean;
}

/** Persistence for project_repos. */
export interface ProjectRepoRepository {
  add(projectId: string, dto: AddRepoDTO): ProjectRepo;
  getById(id: string): ProjectRepo | null;
  listByProject(projectId: string): ProjectRepo[];
  /**
   * Update only the provided lifecycle-script columns of an existing repo.
   * Each provided script is normalized (empty/whitespace → null). Fields left
   * `undefined` are untouched. Returns the updated repo, or null if no repo with
   * that id exists.
   */
  update(repoId: string, patch: UpdateRepoDTO): ProjectRepo | null;
  remove(id: string): boolean;
}

/** Persistence for tasks. */
export interface TaskRepository {
  create(
    fields: Pick<Task, "projectId" | "title" | "description" | "slug"> &
      Partial<Pick<Task, "status">>,
  ): Task;
  getById(id: string, opts?: { withRepos?: boolean }): Task | null;
  /** Tasks for a project (or all when omitted), optionally hydrated with repos. */
  list(opts?: { projectId?: string; withRepos?: boolean }): Task[];
  update(id: string, patch: TaskPatch): Task | null;
  setStatus(id: string, status: TaskStatus): Task | null;
  /**
   * Reset the live agent state of ALL tasks: set `agent_state` and
   * `agent_state_at` to NULL. Called once on server boot — after a (re)start no
   * per-task pty is live yet, so any persisted "working"/"waiting" state is stale
   * and must be cleared. Tasks then show no agent state until the user opens them
   * and the agent respawns.
   */
  clearAllAgentStates(): void;
  delete(id: string): boolean;
}

/** Persistence for task_repos. */
export interface TaskRepoRepository {
  createMany(rows: Omit<TaskRepo, "id">[]): TaskRepo[];
  getById(id: string): TaskRepo | null;
  listByTask(taskId: string): TaskRepo[];
  /**
   * Distinct task ids that reference the given project_repo. Used to guard
   * project-repo deletion: removing a project_repo while tasks still depend on
   * it would let the FK cascade silently drop their task_repos rows, orphaning
   * live worktrees, branches and ptys.
   */
  listTaskIdsByProjectRepo(projectRepoId: string): string[];
  /** Every task_repo across all tasks (used by the orphan sweep). */
  listAll(): TaskRepo[];
  markPushed(id: string, pushed: boolean): TaskRepo | null;
  deleteByTask(taskId: string): number;
}

/** Aggregate access object exposing all repositories. */
export interface Repositories {
  projects: ProjectRepository;
  projectRepos: ProjectRepoRepository;
  tasks: TaskRepository;
  taskRepos: TaskRepoRepository;
}

/** Re-export the update DTOs so module callers can `import { UpdateTaskDTO }` here. */
export type { UpdateRepoDTO, UpdateTaskDTO };
/** Re-export command shapes so module callers can import them from here too. */
export type { CommandKind, RunCommandResult };
