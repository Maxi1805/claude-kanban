/**
 * claude-kanban — shared contracts.
 *
 * Single source of truth for domain types and WebSocket message types.
 * Imported by the server directly and by the frontend via the `@shared` alias.
 * Responses across the API/WS boundary use these exact shapes (camelCase).
 */

/* ────────────────────────────────────────────────────────────────────────
 * Domain entities
 * ──────────────────────────────────────────────────────────────────────── */

/** A logical project that groups one or more git repos. */
export interface Project {
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /**
   * Absolute path to a per-project folder containing `CLAUDE.md` and/or
   * `.claude`, symlinked into each task's session root. Null/absent falls back
   * to the global `config.templateRepoPath`.
   *
   * @deprecated Legacy single-folder selector, kept for backward-compatibility.
   * Prefer the two independent {@link claudeMdPath} / {@link claudeDirPath}
   * selectors. When those are unset this folder's `CLAUDE.md` / `.claude` still
   * act as the per-project source (see the lifecycle precedence).
   */
  claudeConfigPath?: string | null;
  /**
   * Absolute path to a FILE used as this project's `CLAUDE.md`, symlinked to
   * `<sessionRoot>/CLAUDE.md` for every task. Independently optional; when set
   * it takes precedence over {@link claudeConfigPath} and the global template.
   * Null/absent falls back to the legacy folder, then the global template.
   */
  claudeMdPath?: string | null;
  /**
   * Absolute path to a DIRECTORY used as this project's `.claude`, symlinked to
   * `<sessionRoot>/.claude` for every task. Independently optional; when set it
   * takes precedence over {@link claudeConfigPath} and the global template.
   * Null/absent falls back to the legacy folder, then the global template.
   */
  claudeDirPath?: string | null;
  /**
   * Absolute path to a FILE used as this project's `.mcp.json`, symlinked to
   * `<sessionRoot>/.mcp.json` for every task (exactly like {@link claudeMdPath}
   * → CLAUDE.md). Independently optional. Null/absent falls back to the legacy
   * folder's `.mcp.json`, then the global template's `.mcp.json`.
   */
  mcpConfigPath?: string | null;
  /**
   * Per-project list of untracked files/dirs to COPY (not symlink) from each
   * source repo's working dir into the corresponding task worktree after it is
   * created. Each entry is a path RELATIVE to the repo root; a simple `*`/`?`
   * wildcard is allowed in the final path segment (e.g. `.env*`). Best-effort:
   * missing or unsafe patterns are skipped and never fail task creation.
   */
  copyFiles?: string[];
  /** Hydrated by repositories when requested; absent on bare reads. */
  repos?: ProjectRepo[];
}

/** A single git repo registered under a Project, with its lifecycle scripts. */
export interface ProjectRepo {
  id: string;
  projectId: string;
  /** Display name; also used as the worktree dir name under the session root. */
  name: string;
  /** Absolute path to the source git repository (the worktree origin). */
  repoPath: string;
  /** Branch to base new task worktrees on (e.g. "main"). */
  baseBranch: string;
  /** Optional shell script run after the worktree is created. */
  setupScript: string | null;
  /** Optional shell script run to start the repo (dev server, etc.). */
  runScript: string | null;
  /** Optional shell script run during teardown, before worktree removal. */
  teardownScript: string | null;
}

/** Kanban status lifecycle for a Task. */
export type TaskStatus = "todo" | "running" | "review" | "done";

/* ────────────────────────────────────────────────────────────────────────
 * Per-repo command shell (NEW SHELL MODEL)
 *
 * The command panel is a REAL interactive terminal: ONE persistent `bash -il`
 * shell per `(taskId, repoId)`, spawned at the repo's worktree cwd. The
 * Setup / Run / Teardown buttons no longer spawn their own processes — they
 * WRITE the configured script into that shell (and `run` first exports a fresh
 * `$PORT`). `CommandKind` only selects WHICH of a repo's three lifecycle scripts
 * a button injects; the shell itself, and its WS/input addressing, are keyed by
 * `(taskId, repoId)` alone. There is no per-kind running state.
 * ──────────────────────────────────────────────────────────────────────── */

/** Which of a repo's three lifecycle scripts a button injects into the shell. */
export type CommandKind = "setup" | "run" | "teardown";

/**
 * Body of `POST /api/tasks/:taskId/repos/:repoId/run/:kind`: the script for the
 * chosen kind has been injected into the repo's shell. `port` is the fresh TCP
 * port exported as `$PORT` just before a `run` script (so its dev server binds a
 * known port); it is null for setup/teardown.
 */
export interface RunCommandResult {
  /** Port exported as `$PORT` before a `run` script; null for setup/teardown. */
  port: number | null;
}

/**
 * Live agent state for a task's Claude session, driven by a per-task activity
 * clock + periodic monitor (see AgentActivityMonitor):
 *   • "working" — the agent is actively producing terminal output (streaming).
 *   • "waiting" — output has been quiet (idle at a prompt, finished, or blocking
 *                 on a permission/question prompt — anything not streaming).
 *
 * Surfaced live on the board so a card shows whether its claude is busy or
 * needs the user. Null/absent when no state has been observed yet.
 */
export type AgentState = "working" | "waiting";

/** A kanban card: a feature/task coordinated across one or more repos. */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  /** URL/branch-safe identifier derived from the title; the branch name. */
  slug: string;
  /** Absolute path to the assembled session root: <base>/<projectName>/<slug>. */
  sessionRoot: string | null;
  /** OS pid of the running node-pty process, when alive. */
  ptyPid: number | null;
  /** Claude Code session id, if captured/resumable. */
  claudeSessionId: string | null;
  /** Optional port allocated to the task (e.g. for a run script). */
  port: number | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /**
   * Live agent state (working / waiting), driven by the activity monitor.
   * Null/absent until the first state has been observed for the task.
   */
  agentState?: AgentState | null;
  /** ISO-8601 timestamp of the last agentState transition; null/absent if none. */
  agentStateAt?: string | null;
  /** Hydrated per-repo worktree rows when requested. */
  repos?: TaskRepo[];
}

/** One git worktree created for a Task, tied to a ProjectRepo. */
export interface TaskRepo {
  id: string;
  taskId: string;
  projectRepoId: string;
  /** Repo display name (mirrors ProjectRepo.name); the worktree dir name. */
  repoName: string;
  /** Branch created for this task in this repo (typically the task slug). */
  branchName: string;
  /** Absolute path to the worktree: <sessionRoot>/<repoName>. */
  worktreePath: string;
  /** Whether the branch has been pushed to the remote. */
  remotePushed: boolean;
}

/* ────────────────────────────────────────────────────────────────────────
 * Data Transfer Objects (request payloads)
 * ──────────────────────────────────────────────────────────────────────── */

/** Payload to add/register a repo on a project. */
export interface AddRepoDTO {
  name: string;
  repoPath: string;
  baseBranch: string;
  setupScript?: string | null;
  runScript?: string | null;
  teardownScript?: string | null;
}

/** Payload to register a repo on a project (used inside CreateProjectDTO). */
export type CreateProjectRepoDTO = AddRepoDTO;

/**
 * Partial update for an existing ProjectRepo's lifecycle scripts
 * (PATCH /api/projects/:projectId/repos/:repoId). Only the provided script
 * fields are updated; each is a string|null where an empty/whitespace string is
 * normalized to null. Omitting a field leaves that script untouched.
 */
export interface UpdateRepoDTO {
  setupScript?: string | null;
  runScript?: string | null;
  teardownScript?: string | null;
}

/** Payload to create a Project plus its repos. */
export interface CreateProjectDTO {
  name: string;
  repos: AddRepoDTO[];
  /**
   * Optional absolute path to a folder containing `CLAUDE.md` and/or `.claude`
   * to symlink into this project's task session roots.
   *
   * @deprecated Prefer {@link claudeMdPath} / {@link claudeDirPath}.
   */
  claudeConfigPath?: string | null;
  /**
   * Optional absolute path to a FILE used as this project's `CLAUDE.md`. Pass an
   * empty string or null to leave it unset (fall back to the legacy folder /
   * global template).
   */
  claudeMdPath?: string | null;
  /**
   * Optional absolute path to a DIRECTORY used as this project's `.claude`. Pass
   * an empty string or null to leave it unset (fall back to the legacy folder /
   * global template).
   */
  claudeDirPath?: string | null;
  /**
   * Optional absolute path to a FILE used as this project's `.mcp.json`. Pass an
   * empty string or null to leave it unset (fall back to the legacy folder /
   * global template).
   */
  mcpConfigPath?: string | null;
  /**
   * Optional list of untracked files/dirs to copy from each repo into its task
   * worktree (relative paths, simple basename glob allowed). Omit or pass `[]`
   * for none.
   */
  copyFiles?: string[];
}

/** Partial update for a Project (PATCH /api/projects/:id). */
export interface UpdateProjectDTO {
  name?: string;
  /**
   * Set/change/clear the per-project Claude config folder. Pass an empty string
   * or null to clear it (fall back to the global template).
   *
   * @deprecated Prefer {@link claudeMdPath} / {@link claudeDirPath}.
   */
  claudeConfigPath?: string | null;
  /**
   * Set/change/clear the per-project `CLAUDE.md` FILE. Pass an empty string or
   * null to clear it (fall back to the legacy folder / global template).
   */
  claudeMdPath?: string | null;
  /**
   * Set/change/clear the per-project `.claude` DIRECTORY. Pass an empty string
   * or null to clear it (fall back to the legacy folder / global template).
   */
  claudeDirPath?: string | null;
  /**
   * Set/change/clear the per-project `.mcp.json` FILE. Pass an empty string or
   * null to clear it (fall back to the legacy folder / global template).
   */
  mcpConfigPath?: string | null;
  /**
   * Set/replace the per-project list of files to copy into task worktrees. Pass
   * `[]` to clear it. Entries are relative paths (simple basename glob allowed).
   */
  copyFiles?: string[];
}

/** Payload to create a Task (card). */
export interface CreateTaskDTO {
  projectId: string;
  title: string;
  description?: string | null;
  /** Optional explicit slug; derived from the title when omitted. */
  slug?: string;
  /**
   * Subset of the project's repos this task spans. When omitted, all repos
   * registered on the project are used. Values are ProjectRepo ids.
   */
  projectRepoIds?: string[];
}

/** Partial update for a Task (e.g. drag-and-drop status change). */
export interface UpdateTaskDTO {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
}

/* ────────────────────────────────────────────────────────────────────────
 * WebSocket protocol
 *
 * Two channels share one ws server:
 *   • PTY bridge   — path `/ws/pty?taskId=<id>`  (terminal I/O, bidirectional)
 *   • Board events — path `/ws/events`            (server → client broadcasts)
 *
 * Every message is JSON with a discriminant `type` field.
 * ──────────────────────────────────────────────────────────────────────── */

/** Server → client: a chunk of pty output for a task's terminal. */
export interface PtyOutputMsg {
  type: "pty:output";
  taskId: string;
  /** Raw terminal bytes encoded as a UTF-8 string. */
  data: string;
}

/** Client → server: user keystrokes / input for the pty. */
export interface PtyInputMsg {
  type: "pty:input";
  taskId: string;
  data: string;
}

/** Client → server: terminal resize from the xterm fit addon. */
export interface PtyResizeMsg {
  type: "pty:resize";
  taskId: string;
  cols: number;
  rows: number;
}

/** Server → client: the pty process exited. */
export interface PtyExitMsg {
  type: "pty:exit";
  taskId: string;
  exitCode: number;
  signal: number | null;
}

/** Discriminated union of messages exchanged on the pty channel. */
export type PtyMessage = PtyOutputMsg | PtyInputMsg | PtyResizeMsg | PtyExitMsg;

/* ────────────────────────────────────────────────────────────────────────
 * Command shell channel — path `/ws/cmd?taskId=&repoId=`
 *
 * A simpler sibling of the pty channel for the per-repo interactive shell. The
 * shell is identified entirely by the connection's query params `(taskId,
 * repoId)` — no `kind` — so (unlike the pty frames) these messages carry no id
 * fields. On connect the server ensures the shell exists, REPLAYS its buffered
 * output, then streams live `cmd:output`; the client sends `cmd:input` (user
 * keystrokes written to the shell) and `cmd:resize`. The shell persists across
 * reconnects and exits only when killed (teardown) — a one-off `cmd:exit`.
 * ──────────────────────────────────────────────────────────────────────── */

/** Server → client: a chunk of the shell's output (raw terminal bytes). */
export interface CmdOutputMsg {
  type: "cmd:output";
  data: string;
}

/** Server → client: the shell process exited (only on kill/teardown). */
export interface CmdExitMsg {
  type: "cmd:exit";
  exitCode: number | null;
}

/** Client → server: user keystrokes written to the shell. */
export interface CmdInputMsg {
  type: "cmd:input";
  data: string;
}

/** Client → server: resize the shell's pty (xterm fit addon). */
export interface CmdResizeMsg {
  type: "cmd:resize";
  cols: number;
  rows: number;
}

/** Discriminated union of messages exchanged on the command channel. */
export type CmdMessage =
  | CmdOutputMsg
  | CmdExitMsg
  | CmdInputMsg
  | CmdResizeMsg;

/** Kinds of board mutations broadcast to clients. */
export type BoardEventKind =
  | "task:created"
  | "task:updated"
  | "task:deleted"
  | "task:status"
  | "project:created"
  | "project:updated"
  | "project:deleted";

/**
 * Server → client: a board-level change broadcast on the events channel.
 * `task` is present for task:* events; `project` for project:* events;
 * `taskId`/`projectId` are always populated for convenience.
 */
export interface BoardEventMsg {
  type: "board:event";
  kind: BoardEventKind;
  taskId?: string;
  projectId?: string;
  task?: Task;
  project?: Project;
}

/** Any message that can travel over the websocket layer. */
export type WSMessage = PtyMessage | CmdMessage | BoardEventMsg;

/* Back-compat aliases (the `*Msg` names above are canonical). */
/** @deprecated use {@link PtyOutputMsg}. */
export type PtyOutput = PtyOutputMsg;
/** @deprecated use {@link PtyInputMsg}. */
export type PtyInput = PtyInputMsg;
/** @deprecated use {@link PtyResizeMsg}. */
export type PtyResize = PtyResizeMsg;
/** @deprecated use {@link PtyExitMsg}. */
export type PtyExit = PtyExitMsg;
/** @deprecated use {@link BoardEventMsg}. */
export type BoardEvent = BoardEventMsg;

/* ────────────────────────────────────────────────────────────────────────
 * Filesystem browser (local-only repo picker)
 *
 * Read-only filesystem inspection that powers the "browse, don't type" create
 * flow: the user navigates allow-rooted directories and the server reports
 * which ones are git repos so the picker can fill the existing AddRepoDTO
 * fields. All shapes are camelCase, like the rest of the contract.
 * ──────────────────────────────────────────────────────────────────────── */

/** A filesystem allow-root the picker may browse from. */
export interface FsRoot {
  path: string;
  label: string;
}

/** One immediate child entry (directory or, when requested, file) from the fs browser. */
export interface FsEntry {
  /** Absolute, resolved path. */
  path: string;
  /** Basename of the entry. */
  name: string;
  /**
   * True for a regular file; false for a directory. Files are only present when
   * the listing was requested with `includeFiles` (the picker shows them
   * greyed/non-navigable for orientation, e.g. spotting a bare `CLAUDE.md`).
   */
  isFile: boolean;
  /**
   * True if the entry is a directory that has a `.git` entry (dir or file).
   * Always false for files.
   */
  isGitRepo: boolean;
  /** True if the basename starts with "." (UI collapses these by default). */
  hidden: boolean;
}

/** Response for GET /api/fs/roots — the allow-roots the picker seeds from. */
export interface FsRootsResponse {
  roots: FsRoot[];
}

/** Response for GET /api/fs/list — a shallow listing of one directory. */
export interface FsListResponse {
  /** The resolved/normalized directory actually listed. */
  path: string;
  /** Resolved parent IF still inside an allow-root, else null (caps "up"). */
  parent: string | null;
  /** Is the listed dir itself a git repo? */
  isGitRepo: boolean;
  /**
   * Immediate children, sorted: git repos first, then other directories, then
   * (only when the request set `includeFiles`) files — alpha within each group.
   * When `includeFiles` is false/omitted, files are excluded entirely.
   */
  entries: FsEntry[];
  /** Subset of `entries` where isGitRepo === true (for "add all" convenience). */
  childGitRepos: FsEntry[];
  /** True if entries were capped. */
  truncated: boolean;
}

/** Response for GET /api/fs/inspect — validates a chosen folder before saving. */
export interface FsInspectResponse {
  /** Resolved/normalized path. */
  path: string;
  /** Is a `.git` entry present? */
  isGitRepo: boolean;
  /** Basename — suggested repo name. */
  name: string;
  /** Auto-detected base branch; null if not a repo / detection failed. */
  baseBranch: string | null;
  /** Local branch names (best-effort, capped at 200; [] if not a repo). */
  branches: string[];
  /** Immediate child dirs that are git repos (for multi-repo discovery). */
  childGitRepos: FsEntry[];
}

/* ────────────────────────────────────────────────────────────────────────
 * HTTP API envelopes
 * ──────────────────────────────────────────────────────────────────────── */

/** Standard error body returned by API routes on failure. */
export interface ApiError {
  error: string;
  details?: unknown;
}
