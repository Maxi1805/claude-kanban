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

/* ────────────────────────────────────────────────────────────────────────
 * Caveman — per-task token-saving mode.
 *
 * `caveman` is a third-party Claude Code plugin/skill that compresses the
 * agent's PROSE (dropping articles, filler and hedging) while leaving code,
 * commands and error output byte-for-byte intact. It is NOT bundled here: the
 * board only decides, per task, whether the plugin is loaded into that task's
 * session and at which compression level.
 *
 * Two independent knobs, mirroring the UI:
 *   • `cavemanEnabled` — the checkbox. Drives `enabledPlugins` in the task's
 *     `--settings` file, so a disabled task never even LOADS the plugin (its
 *     skill description costs input tokens just by being present).
 *   • `cavemanLevel`   — the selector. Applied by typing the plugin's slash
 *     command into the live session, so switching level never needs a restart.
 *     Kept when the checkbox is unchecked, so re-enabling restores the choice.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Compression levels the caveman skill accepts, taken from its own SKILL.md
 * (not from the README, which is a version behind):
 *   • lite   — drops filler words only.
 *   • full   — fragment-style responses (the skill's own default).
 *   • ultra  — maximum terseness.
 *   • wenyan-* — the same three intensities in classical Chinese.
 */
export type CavemanLevel =
  | "lite"
  | "full"
  | "ultra"
  | "wenyan-lite"
  | "wenyan-full"
  | "wenyan-ultra";

/** Every {@link CavemanLevel}, in UI order. Runtime value: validation + <select>. */
export const CAVEMAN_LEVELS = [
  "lite",
  "full",
  "ultra",
  "wenyan-lite",
  "wenyan-full",
  "wenyan-ultra",
] as const;

/**
 * Level a task gets when caveman is switched on without an explicit choice.
 * Matches the plugin's own default so enabling and typing nothing behave alike.
 */
export const CAVEMAN_DEFAULT_LEVEL: CavemanLevel = "full";

/**
 * Whether the task WANTS caveman but its session cannot yet provide it — the
 * only state that needs a session restart.
 *
 * Asymmetric on purpose. Loading the plugin happens once, at startup, so turning
 * caveman ON reaches a running agent only through a respawn. Turning it OFF does
 * not: the session is told "normal mode" and stops compressing immediately, and
 * the plugin merely stays loaded (inert) until it next spawns. So an unticked
 * box is never "pending" — it is already doing what it says.
 */
export function cavemanPending(
  task: Pick<Task, "cavemanEnabled" | "cavemanSession">,
): boolean {
  return task.cavemanEnabled && task.cavemanSession !== true;
}

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
  /** Whether the caveman plugin is loaded into this task's session. */
  cavemanEnabled: boolean;
  /**
   * Compression level applied when {@link cavemanEnabled}. Retained while
   * disabled so unchecking and re-checking restores the same level. Null on
   * tasks created before the setting existed (treated as the default level).
   */
  cavemanLevel: CavemanLevel | null;
  /**
   * What the CURRENT session was actually spawned with — i.e. whether the plugin
   * is loaded in the live agent right now. Written at spawn from
   * {@link cavemanEnabled}; null when the task has not spawned since the setting
   * existed.
   *
   * It exists because the two knobs differ in when they can act. A LEVEL can be
   * switched by talking to a session that already has the plugin. Loading the
   * plugin cannot: `enabledPlugins` is read once, at startup. So ticking the
   * checkbox on a running agent CANNOT take effect until it respawns — and
   * typing `/caveman <level>` at it only produces "Unknown command", because in
   * that session the command does not exist. When this differs from
   * {@link cavemanEnabled}, the change is PENDING a session restart, and the
   * board says so instead of typing into a session that cannot obey.
   */
  cavemanSession: boolean | null;
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
  /**
   * Load the caveman plugin into this task's session from message one. Omitted
   * means off — the board never enables it behind the user's back.
   */
  cavemanEnabled?: boolean;
  /** Compression level for {@link cavemanEnabled}; defaults to `full`. */
  cavemanLevel?: CavemanLevel;
}

/** Partial update for a Task (e.g. drag-and-drop status change). */
export interface UpdateTaskDTO {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  /**
   * Toggle the caveman plugin for this task. Applied to a LIVE session
   * immediately (the server types the plugin's command into the pty) and
   * persisted so the next spawn loads — or omits — the plugin accordingly.
   */
  cavemanEnabled?: boolean;
  /** Switch the compression level; applied live like {@link cavemanEnabled}. */
  cavemanLevel?: CavemanLevel;
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
 * Schema graph (declared structure, per task)
 *
 * The model behind the per-task schema DIAGRAM. It describes the structure a
 * project DECLARES IN ITS FILES — never a live database. That is the point: a
 * table or relation an agent just wrote appears immediately, without anyone
 * running a migration.
 *
 * Nothing here is tied to a stack. Each repo's schema is produced by an
 * extractor SCRIPT that a Claude Code agent wrote for that repo after reading
 * its code (see the `script` field on TaskSchemaRepo); this contract is the
 * only thing the script has to satisfy.
 * ──────────────────────────────────────────────────────────────────────── */

/** One field/column of an entity. */
export interface SchemaField {
  name: string;
  /** Declared type, verbatim from the source (`bigint`, `jsonb`, …). */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Default expression as written, when declared. */
  default?: string;
  /**
   * True when the extractor flagged this as declared but not yet applied (for
   * example a migration that has not been folded into a consolidated schema).
   */
  pending: boolean;
}

/** One entity (table) declared by the project's schema files. */
export interface SchemaEntity {
  name: string;
  fields: SchemaField[];
  /** Repo-relative file declaring it. */
  sourceFile: string;
  /** 1-based line of the declaration. */
  sourceLine: number;
  /** True when the extractor flagged it as declared but not yet applied. */
  pending: boolean;
}

/**
 * A directed relation. `from` is the CHILD — the entity holding the foreign
 * key — and `to` is the PARENT it references. Keeping that direction explicit
 * is what lets the diagram show that children point at parents, not the
 * reverse.
 */
export interface SchemaRelation {
  from: string;
  /** The referencing field in `from`. */
  fromField: string;
  to: string;
  /** ON DELETE behaviour, when declared. */
  onDelete: string | null;
  sourceFile: string;
  sourceLine: number;
  pending: boolean;
}

/** The declared schema of ONE repo of a task. */
export interface SchemaGraph {
  /** Repo display name (matches the task's repo). */
  repoName: string;
  /** Short label the extractor reported for the stack (`rails`, `prisma`, …). */
  dialect: string;
  /** Repo-relative files the schema was read from. */
  sourceFiles: string[];
  entities: SchemaEntity[];
  relations: SchemaRelation[];
}

/** How an element compares to the base branch. */
export type SchemaChange = "added" | "removed" | "changed";

/**
 * What this task changed relative to its base branch. Only differences are
 * listed — anything absent is unchanged. Keys: entity name, `entity.field`,
 * and `from.fromField->to` for relations.
 */
export interface SchemaDiff {
  /** Branch compared against; null when the comparison could not run. */
  baseBranch: string | null;
  /** Why the diff is unavailable, when `baseBranch` is null. */
  unavailableReason?: string;
  entities: Record<string, SchemaChange>;
  fields: Record<string, SchemaChange>;
  relations: Record<string, SchemaChange>;
}

/**
 * State of the extractor script generated for a repo, including any generation
 * currently in flight. Generation runs as a BACKGROUND job — an agent reading a
 * whole codebase can take many minutes, far longer than a request should be
 * held open — so the client starts it and then watches this state.
 */
export interface SchemaScriptInfo {
  /** False until an agent has generated one for this repo. */
  exists: boolean;
  /** Absolute path it lives at (set even before it exists). */
  path: string;
  /** ISO-8601 timestamp of the last generation. */
  generatedAt?: string;
  /** What the extractor found when it was generated. */
  summary?: string;
  /** True while an agent is writing (or rewriting) this repo's extractor. */
  generating?: boolean;
  /** ISO-8601 timestamp the running generation started at. */
  generatingSince?: string;
  /** Why the last generation failed; cleared when one succeeds. */
  lastError?: string;
}

/** One repo's contribution to the task's schema view. */
export interface TaskSchemaRepo {
  repoName: string;
  /** Absolute worktree path the schema was read from. */
  worktreePath: string;
  /** Whether this repo has an extractor yet, and where it came from. */
  script: SchemaScriptInfo;
  /** Null when there is no script yet, or it failed. */
  graph: SchemaGraph | null;
  /** Absent when no diff could be computed. */
  diff?: SchemaDiff;
  /** Non-fatal problems found while validating the script's output. */
  warnings?: string[];
  /** Set when this repo could not be inspected at all. */
  error?: string;
}

/** Response for GET /api/tasks/:taskId/schema. */
export interface TaskSchemaResponse {
  taskId: string;
  repos: TaskSchemaRepo[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Code hotspots (per task)
 *
 * The problems refactoring patterns exist to solve, found by parsing the task's
 * worktrees with tree-sitter. Same pipeline shape as the schema view — extract
 * to this contract, derive, render — but with a deterministic parser instead of
 * a generated script, since for code tree-sitter already is the universal one.
 * ──────────────────────────────────────────────────────────────────────── */

/** Where a finding lives, repo-relative. */
export interface CodeLocation {
  file: string;
  startLine: number;
  endLine: number;
  /** Enclosing function/method name, when the finding has one. */
  symbol?: string;
}

/** Whether a suggestion is a mechanical refactoring or a design pattern. */
export type CodeSuggestionKind = "refactorizacion" | "patron_de_diseno";

/** One suggested way to address a finding. */
export interface CodeSuggestion {
  /** Technique name, as its source names it. */
  name: string;
  kind: CodeSuggestionKind;
  /** Why it applies here, in one line. */
  why: string;
  /** The catalogue entry backing it. */
  source: string;
  /**
   * Only on patterns: which signal — beyond what a tree-sitter analyser can
   * see without resolving types — would confirm the pattern really applies.
   * A pattern is never prescribed as a mandate without it.
   */
  caveat?: string;
  /**
   * What the pattern COSTS, stated alongside what it buys. Every entry in
   * Kerievsky's catalogue pairs benefits with liabilities, and empirical work
   * has found patterns that made maintenance worse — so a suggestion that only
   * advertises the upside is misleading.
   */
  cost?: string;
  /**
   * How widely used the pattern is, 0-3, as refactoring.guru rates it on its
   * per-language pages. Shown because "how common is this?" is a fair thing to
   * weigh before restructuring code around a pattern.
   */
  popularity?: number;
}

/**
 * What to do about a finding.
 *
 * The primary entry is always a mechanical, safe REFACTORING; a design pattern
 * appears only when the measured signal supports it, and always as a hypothesis
 * carrying its caveat. That order is what the sources actually do: the
 * refactoring catalogue introduces patterns as the OUTCOME of a refactoring
 * (Null Object arrives via Introduce Special Case) and SonarQube never names a
 * pattern in its remediation guidance. Prescribing patterns from syntax alone
 * invites over-engineering, since the preconditions that justify them — a real
 * hierarchy, an actual point of variation — are exactly what this analyser
 * cannot verify.
 */
export interface CodeAdvice {
  primary: CodeSuggestion;
  /** Present only when the evidence reasonably supports a pattern. */
  pattern?: CodeSuggestion;
  /** Equally-valid alternatives the source lists for the same context. */
  alternatives?: CodeSuggestion[];
}

/**
 * Los `kind` que el analizador de HOY emite y que la UI conoce por nombre
 * (etiqueta en español y posición fija en la fila de totales).
 *
 * Esta lista NO es el catálogo de kinds: es el subconjunto LEGADO, congelado.
 * Un detector nuevo NO se agrega acá — ver `CodeFindingKind`.
 */
export type KnownCodeFindingKind =
  | "duplication"
  | "conditional-chain"
  | "complexity"
  | "long-function"
  | "empty-catch"
  | "long-parameter-list"
  | "large-class"
  | "repeated-switch";

/**
 * Qué clase de problema se encontró. UNIÓN ABIERTA a propósito.
 *
 * Antes era una unión CERRADA de 8 valores contra la que se tipaba
 * `DetectorBase.kind` (`server/services/detect/types.ts`). Con un catálogo de
 * ~39 problemas y muchos agentes escribiendo detectores en paralelo, eso
 * convertía ESTE archivo — el contrato compartido entre servidor y frontend —
 * en el punto de choque real de cada detector nuevo: agregar un detector
 * obligaba a editar `shared/types.ts`. Se invirtió la dirección: **el `kind`
 * lo aporta el detector que lo emite** (declara su propio literal como
 * parámetro de tipo) y el catálogo se DERIVA del registro
 * (`detect/kinds.ts#kindCatalog`), no al revés.
 *
 * `string & {}` es el idioma de TypeScript para "cualquier string, pero
 * conservando el autocompletado de los conocidos": el tipo sigue siendo un
 * string plano, estable y serializable — que es lo único que el censo
 * (`census.ts`, que cuenta claves `hallazgo:<kind>`) y el cache en disco
 * necesitan de él.
 *
 * Consecuencia para quien consume: NINGÚN `switch` sobre un `kind` puede ser
 * exhaustivo, y ningún `Record<CodeFindingKind, …>` puede estar completo. Todo
 * mapeo de kind → etiqueta/color/orden necesita un camino por defecto que no
 * explote con un kind desconocido — ver `web/src/code/findings.ts`.
 */
export type CodeFindingKind = KnownCodeFindingKind | (string & {});

/**
 * Una entrada del catálogo de kinds: qué kinds puede emitir este análisis y
 * cómo se llaman en pantalla. Viaja EN EL PAYLOAD (`CodeAnalysis.kinds`) para
 * que la etiqueta humana de un kind nuevo llegue desde el detector que lo
 * declaró, sin que nadie tenga que agregar una fila a un diccionario
 * compartido del frontend.
 */
export interface CodeFindingKindInfo {
  kind: CodeFindingKind;
  /** Nombre humano, tal como lo declara el `title` del detector que lo emite. */
  label: string;
}

/**
 * Present once a finding has been discarded — F2
 * (`code_finding_decisions`, `POST .../discard`). Carried on the item
 * itself rather than filtered server-side: the panel decides whether to hide
 * it or show it struck through, and either way the reason stays visible.
 */
export interface CodeFindingDiscard {
  reason: string;
  decidedAt: string;
}

/** One hotspot. */
export interface CodeFinding {
  /**
   * Stable id — F2 (`detect/ids.ts#findingId`: detector/kind + sorted
   * anchors, no line numbers, no metric value). What `POST
   * .../findings/:id/discard` keys on. Optional only for the same reason
   * every other field added after this contract shipped is: a cached
   * analysis from before F2 simply lacks it, and the panel then has no way
   * to discard that particular row until the next re-analysis fills it in.
   */
  id?: string;
  kind: CodeFindingKind;
  /** One-line summary, already humanized. */
  title: string;
  /** Why it matters, in plain language. */
  detail: string;
  /** The number that triggered it. */
  metric: { label: string; value: number };
  /** 0-100. The detector's own scale — never compared across detectors. See `score`. */
  severity: number;
  /**
   * F5 — CONTRATO-F5.md §1.6: the cross-detector ranking key, replacing raw
   * `severity` comparisons (measured bias: one detector's severity scale is
   * not another's — a constant-35 detector sorted next to one that saturates
   * at 100). `score = (0.40·R_sev + 0.35·impact + 0.25·reach) · conf`.
   * Optional only because an analysis cached before this shipped lacks it.
   */
  score?: number;
  /** The four factors behind `score`, so the panel can explain why a row is
   *  where it is. Present iff `score` is. */
  scoreBreakdown?: { rSev: number; impact: number; reach: number; conf: number };
  /**
   * Every place involved — duplication lists all its copies, and so does any
   * OTHER finding that F5's grouping (`memberCount`, below) collapsed: the
   * union of every member's own locations, deduplicated, never just the
   * representative's.
   */
  locations: CodeLocation[];
  /** What to do about it: refactoring first, pattern only as a hypothesis. */
  advice?: CodeAdvice;
  /** Present iff discarded for this repo — F2. */
  discarded?: CodeFindingDiscard;
  /**
   * F6 — CONTRATO-F6.md Contrato 1: hipótesis de patrón que CUELGAN de este
   * hallazgo (nunca aparecen sueltas — a diferencia de la vía vieja
   * `opportunities`, retirada, que vivía en su propia lista rankeada por
   * confianza sin ancla, precisamente el defecto que F6 corrige). Ausente/
   * vacío ⇒ ninguna hipótesis registrada cuelga de este `kind` todavía, no
   * "el motor no corrió". Ver `CodeFindingHypothesis` más abajo.
   *
   * OLA AC — CUANDO ESTA FILA ES UN GRUPO (`memberCount > 1`), ESTO ES LA
   * UNIÓN DE LAS HIPÓTESIS DE TODOS SUS MIEMBROS, no sólo las del
   * representante: mismo criterio que `locations` arriba. Se saltean las que
   * repiten patrón + estado + `places` de una que la fila ya lleva (decir dos
   * veces lo mismo sobre el mismo código no es evidencia). Cada hipótesis
   * conserva su `anchorFindingId` apuntando al miembro que la produjo, que es
   * la única traza de cuál de los N miembros la motiva. Hasta esta ola se
   * publicaban SÓLO las del representante y las demás se tiraban.
   */
  hypotheses?: readonly CodeFindingHypothesis[];
  /**
   * F5 — CONTRATO-F5.md Contrato 2 §2.2/§2.3: how many raw findings this row
   * represents — either the same root cause across N places (a detector's
   * own `groupKey`) or generic `(file, kind)` locality once a file's count
   * for that kind reaches `GROUP_MIN` (`detect/grouping.ts`). Absent, or `1`,
   * means an ungrouped singleton — an analysis cached before this field
   * shipped simply lacks it, same convention as `kinds`.
   * `title`/`detail` (unless `degenerateGroup`)/`metric`/`severity`/`score`/
   * `advice` are the BEST member's own, unmodified — never an aggregate.
   */
  memberCount?: number;
  /**
   * F5 — CONTRATO-F5.md Contrato 2 §2.4: present and `true` only when the
   * degenerate-group guard fired (`memberCount >= DEGENERATE_MIN` AND median
   * evidence quality below the floor) — many low-signal members collapsed
   * into one row because the volume itself is the more likely explanation
   * ("an idiom of this file", per `detail`, which is overwritten to say so
   * literally) rather than N distinct problems. A future confidence-aware
   * consumer can also use this flag directly instead of re-deriving it from
   * `detail`'s text.
   */
  degenerateGroup?: boolean;
}

/**
 * One analysed file. Carried so the map can size and place a circle per file
 * INCLUDING the healthy ones: a red file only reads as alarming next to the
 * green ones around it, and the directory hierarchy is the structure the user
 * already knows.
 */
export interface CodeFileSummary {
  /** Repo-relative path. */
  path: string;
  lines: number;
  language: string;
}

/**
 * How worth reviewing a pattern OPPORTUNITY is. Deliberately NOT "severidad":
 * a finding measures how bad something already is, an opportunity is a
 * hypothesis — "a pattern might belong here" — that a human still has to
 * confirm, so what it needs is a confidence label, not a badness score.
 */
export type PatternConfidence = "alta" | "media" | "baja";

/**
 * One place involved in a pattern hypothesis, WITH THE ROLE it plays there —
 * shared shape between `CodeFindingHypothesis.places` (below) and the
 * `bridgeLeaks`/graph-edge helpers on the frontend. Kept as a distinct type
 * from `CodeLocation[]` (see `oportunidades-v2.md`): a finding's locations
 * are homogeneous — every one is another copy of the SAME problem — while
 * every place here plays a DIFFERENT role (one is "the accumulator", another
 * "the duplicated guard #2"), so folding them into an interchangeable list
 * would erase the very thing that makes a hypothesis worth reading.
 */
export interface PatternOpportunityPlace {
  file: string;
  startLine: number;
  endLine: number;
  /** Enclosing function/method/class name, when there is one. */
  symbol?: string;
  /** What role THIS place plays in the hypothesis (e.g. "acumulador", "guarda duplicada #2"). */
  role: string;
}

/**
 * F-RETIRO-VÍA-VIEJA: `analyzeRepo` no produce más valores de este tipo —
 * las tres familias de detección por vocabulario/forma que lo llenaban
 * (`pattern-structural.ts`/`pattern-wrapping.ts`/`pattern-behavioral.ts`,
 * orquestadas por `code-opportunities.ts`) se retiraron enteras, decisión
 * del usuario. `CodeAnalysis` ya no tiene un campo `opportunities` que
 * cargue esto. El tipo se mantiene exportado ÚNICAMENTE porque
 * `web/src/types.ts` (fuera de alcance para este cambio — trabajo sin
 * commitear del usuario) todavía lo re-exporta por nombre; nada en el
 * servidor ni en el resto del frontend construye un valor de esta forma.
 * Candidato a borrarse el día que `web/src/types.ts` deje de nombrarlo.
 */
export interface CodePatternOpportunity {
  /** Stable id — F2, same algorithm as `CodeFinding.id` (`"pattern:" + pattern` stands in for a detector id). */
  id?: string;
  /** Pattern name, as refactoring.guru names it. */
  pattern: string;
  confidence: PatternConfidence;
  /** The concrete relation that triggered it, in plain language — no AST jargon. */
  relation: string;
  places: PatternOpportunityPlace[];
  /** What a human must confirm by hand before applying the pattern. */
  toConfirm: string[];
  /** What the pattern COSTS, alongside what it buys — never only the upside. */
  cost: string;
  /** refactoring.guru (or, where documented as absent there, its next-best source) page backing the rule. */
  source: string;
  /** Present iff discarded for this repo — F2. */
  discarded?: CodeFindingDiscard;
}

/**
 * F6 — CONTRATO-F6.md Contrato 1: una hipótesis de patrón que cuelga de un
 * `CodeFinding.hypotheses`, nunca suelta. Forma gemela, campo por campo, del
 * `PatternHypothesis` del servidor (`server/services/hypotheses/types.ts`) —
 * NO se importa desde acá porque este archivo, por diseño, no importa nada
 * (ver el comentario de cabecera: "imported by the server directly and by
 * the frontend via the `@shared` alias"). Todo campo es `readonly` para que
 * el `Finding.hypotheses` del servidor (también `readonly` de punta a punta)
 * se pueda pasar tal cual, sin copiar ni convertir.
 */
export interface CodeFindingHypothesisCheck {
  label: string;
  passed: boolean;
  why: string;
  /** Qué papel jugó este check: sin esto no hay hipótesis (`required`), sube
   *  un peldaño de la escalera de confianza (`discriminator`), o decide
   *  `state` (`applied`, el excluder fusionado). */
  role?: "required" | "discriminator" | "applied";
}

export type CodeFindingHypothesisState = "ausente" | "parcial" | "ya-aplicado" | "aplicado-eludido";

/**
 * OLA BA, FRENTE BA1 — LA CAPA, tal cual viaja al panel. Gemela de
 * `server/services/hypotheses/types.ts#HypothesisLayer` (mismo criterio que el
 * resto de este archivo: se redeclara, no se importa).
 *
 *   · `"patron"` — uno de los 12 patrones de diseno (GoF) del catalogo.
 *   · `"refactorizacion"` — una de las 17 familias de refactorizacion (Fowler).
 *
 * Son DOS capas con VARAS DISTINTAS y el panel tiene que poder separarlas sin
 * mirar el nombre del patron: `"Proxy"` y `"Proxy (inicializacion perezosa)"`
 * son la misma capa y ningun prefijo lo dice. OBLIGATORIO: el servidor lo
 * estampa en `hypotheses/run.ts` desde el `HypothesisBuilder.layer` del builder
 * que produjo la hipotesis, asi que no hay hipotesis publicada sin capa. Un
 * analisis CACHEADO de antes de esta ola puede no traerlo — mismo trato que
 * cualquier otro campo agregado (`kinds`, `memberCount`): re-analizar lo llena.
 */
export type CodeFindingHypothesisLayer = "patron" | "refactorizacion";

export interface CodeFindingHypothesis {
  /** Nombre del patrón — refactoring.guru. */
  pattern: string;
  /**
   * OLA BA, FRENTE BA1 — patrón de diseño o familia de refactorización. LA VÍA
   * ÚNICA para separar las dos capas en la UI: nunca derivar la capa del
   * `pattern` (ver {@link CodeFindingHypothesisLayer}).
   */
  layer: CodeFindingHypothesisLayer;
  state: CodeFindingHypothesisState;
  /** `null` cuando `state` ya no es una oportunidad (`ya-aplicado`/
   *  `aplicado-eludido` no compiten en el ranking) o cuando no aplica
   *  (`missingCapabilities` no vacío). CALCULADA por el servidor — nunca un
   *  literal escrito a mano. */
  confidence: PatternConfidence | null;
  /** Techo de confianza — provisional hasta re-derivarlo contra el corpus externo. */
  ceiling: PatternConfidence;
  provisional: boolean;
  /** Los checks `required` + `applied` (el excluder fusionado que decide `state`). */
  checks: readonly CodeFindingHypothesisCheck[];
  /** Separados de `checks`: cada uno confirmado sube un peldaño de la escalera. */
  discriminators: readonly CodeFindingHypothesisCheck[];
  places: readonly PatternOpportunityPlace[];
  toConfirm: readonly string[];
  cost: string;
  source: string;
  /** No vacío ⇒ "no aplicable" para el lenguaje del hallazgo — nunca "cero hallazgos". */
  missingCapabilities: readonly string[];
  /** El `CodeFinding.id` del que cuelga esta hipótesis. */
  anchorFindingId: string;
}

/**
 * F3 — resumen del grafo de código (carpeta/archivo/símbolo, aristas
 * `contains`/`references` — CONTRATO-F3.md §3). El grafo COMPLETO (decenas
 * de miles de aristas en un repo real, medido en guava) nunca viaja en este
 * payload: sólo conteos y las estadísticas de la cascada de resolución
 * (`graph/resolve.ts`), para poder medir sin inflar cada respuesta del
 * panel. Esta ola el grafo no produce hallazgos — se construye, se persiste
 * aparte (sqlite, `code_graphs`) y se mide; un consumidor futuro (F4+) que
 * necesite nodos/aristas reales lee esa tabla, no este campo. Redeclarado
 * localmente (mismos nombres que `GraphNodeKind`/`EdgeKind`/`ResolutionStats`
 * de `graph/stages.ts`/`graph/types.ts`, sin importarlos) para que este
 * archivo, compartido con el frontend, siga sin depender de nada server-only
 * — la misma razón por la que no importa nada hoy.
 */
export interface CodeGraphSummary {
  nodes: number;
  folders: number;
  files: number;
  symbols: number;
  edges: number;
  containsEdges: number;
  referencesEdges: number;
  resolution: {
    candidates: number;
    resolved: number;
    /** Sobrevivió la cascada con más de un destino posible. */
    droppedAmbiguous: number;
    /** Sobrevivió sin ningún destino. */
    unresolved: number;
    /** NUEVO, CONTRATO-F9.md §4.5. Cuántas de `droppedAmbiguous` se emitieron como arista `ambiguous`. OPCIONAL: ausente = "esta corrida no midió esto todavía" (F5 no aterrizó), no cero — mismo criterio que `graph/stages.ts#ResolutionStats.ambiguousEdges`. */
    ambiguousEdges?: number;
    /** NUEVO, CONTRATO-F9.md §4.5. Cuántas se descartaron por pasar `AMBIGUOUS_MAX_TARGETS`. Mismo motivo opcional. */
    ambiguousOverflow?: number;
    /** NUEVO, CONTRATO-F9.md §4.5. Los peores archivos sin resolver, tope 20 (recortado de `UNRESOLVED_REPORT_MAX_FILES` del lado servidor) — lo único accionable: dice DÓNDE mirar. */
    unresolvedTopFiles?: readonly { file: string; stage: string; n: number }[];
  };
  /** Cuánto tardó `buildGraph` esta corrida, en ms — para medir el costo, nunca para mostrarlo como hallazgo. */
  buildMs: number;
  /** NUEVO, CONTRATO-F9.md §2. Cuántos nodos `kind: "finding"` tiene el grafo esta corrida. Opcional, y SIEMPRE ausente por diseño: `attachFindingNodes` aterrizó su cuerpo en la Ola O, pero `summarizeGraph` (`code-inspector.ts`) resume el grafo que `onGraph` capturó — deliberadamente el grafo SIN nodos de hallazgo, mismo motivo de no persistirlos (CONTRATO-F9.md §2.4). Poblarlo de verdad exigiría un segundo call site de `summarizeGraph` sobre `graphForHypotheses`, fuera del camino de persistencia — no existe hoy. */
  findingNodes?: number;
  /** NUEVO, CONTRATO-F9.md §3. Cuántos nodos `kind: "carrier"` tiene el grafo esta corrida. Opcional: ausente hasta que F3 aterrice `portador.ts`. */
  carrierNodes?: number;
}

/**
 * F4 — mismo shape que `detect/types.ts#Scope`/`#CoverageStatus`/
 * `#DetectorCoverage` (server-only), redeclarado acá por la misma razón que
 * {@link CodeGraphSummary}: este archivo, compartido con el frontend, no
 * depende de nada server-only.
 */
export type CodeDetectorScope = "intra-function" | "intra-file" | "inter-file";

/**
 * Ver `detect/types.ts#CoverageStatus`. Ensanchado con `sin-aristas`/
 * `sin-metricas` (DIAGNÓSTICO-5B §5, Problema 3, tarea de esta ola) — ÚNICO
 * cambio que este archivo recibe de esa tarea: `crossAnalyze`
 * (`code-analyzer.ts`, fuera de mi alcance) devuelve `DetectorCoverage[]`
 * (server) donde este contrato pide `CodeDetectorCoverage[]`; sin ensanchar
 * este tipo en el mismo paso, esa asignación deja de tipar apenas el status
 * del servidor incluye un valor que este union no tiene. Aditivo puro: dos
 * miembros de unión más, ningún campo ni forma cambia.
 */
export type CodeCoverageStatus =
  | "corrio"
  | "no-aplicable"
  | "sin-grafo"
  | "sin-aristas"
  | "sin-metricas"
  | "presupuesto-agotado"
  | "error";

/**
 * Una fila de cobertura: qué detector corrió (o no) sobre qué, y por qué no
 * cuando no — F4, alimenta la pantalla "Qué no estamos viendo". Agregada por
 * `(detectorId, language)` en `crossAnalyze` antes de viajar acá; ver
 * `detect/types.ts#DetectorCoverage` para el detalle campo a campo.
 */
export interface CodeDetectorCoverage {
  detectorId: string;
  title: string;
  scope: CodeDetectorScope;
  kind: CodeFindingKind;
  /** Presente para intra-*: la cobertura es POR LENGUAJE. Ausente para inter-file. */
  language?: string;
  status: CodeCoverageStatus;
  /** Sólo con status "no-aplicable": qué capacidad falta. Nunca vacío en ese caso. */
  missingCapabilities?: readonly string[];
  unitsConsidered: number;
  findings: number;
  error?: string;
  /**
   * CONTRATO-F6.md Contrato 2 §2.4 — por qué este detector NO puede encontrar
   * nada en este lenguaje (p.ej. "Go no tiene parámetros opcionales"),
   * declarado por el propio detector (`DetectorBase.silentIn`, ver
   * `detect/types.ts` — pendiente, tarea de otro agente de esta ola: nada
   * lo llena todavía). Aditivo puro, opcional: un `DetectorCoverage` sin esto
   * simplemente no trae la propiedad, igual que `missingCapabilities` para un
   * detector que no la declaró. Presente sólo cuando `status === "corrio"` y
   * `findings === 0` — es la explicación de un "mudo" legítimo, no de otro
   * status (que ya tiene la suya: `missingCapabilities`/etc.).
   */
  silenceReason?: string;
}

/** One repo's analysis. */
export interface CodeAnalysis {
  repoName: string;
  /** Files matching a supported language (after skipping vendored trees). */
  scannedFiles: number;
  /** Files actually parsed. */
  analysedFiles: number;
  totalLines: number;
  languages: string[];
  /** Every file that was parsed, for the hotspot map. */
  files: CodeFileSummary[];
  findings: CodeFinding[];
  /**
   * Catálogo de kinds que este análisis puede emitir, con su etiqueta humana
   * — derivado del registro de detectores (`detect/kinds.ts#kindCatalog`),
   * nunca escrito a mano. Es la vía por la que la UI aprende el nombre de un
   * kind que no conocía sin editar un diccionario compartido.
   *
   * Opcional: un análisis cacheado de antes de este campo simplemente no lo
   * trae, y la UI cae entonces a sus etiquetas legadas y, si tampoco, a
   * humanizar el slug.
   */
  kinds?: CodeFindingKindInfo[];
  /**
   * F3 — resumen del grafo de código (carpeta/archivo/símbolo, aristas
   * `contains`/`references`) — ver {@link CodeGraphSummary}. Opcional por la
   * misma convención que `kinds`: un análisis cacheado de antes de este
   * campo, o corrido fuera de `code-inspector.ts` (que es quien arma y
   * persiste el grafo — ver `code-graph-repository.ts`), simplemente no lo
   * trae.
   */
  graph?: CodeGraphSummary;
  /**
   * F4 — cobertura del registro de detectores (`detect/run.ts`, 19
   * detectores), agregada por `(detectorId, language)` — ver
   * {@link CodeDetectorCoverage}. Opcional por la misma convención que
   * `kinds`/`graph`: un análisis cacheado de antes de este campo simplemente
   * no lo trae. Alimenta la pantalla "Qué no estamos viendo".
   */
  coverage?: CodeDetectorCoverage[];
  /**
   * F5 — CONTRATO-F5.md Contrato 2 §2.5: real total of raw findings, BEFORE
   * grouping and BEFORE paging — what makes "showing 100 of 2,041 groups
   * (11,379 findings)" honest instead of a cap that cuts silently. Optional
   * by the same convention as `kinds`/`graph`/`coverage`: an analysis cached
   * before this field shipped simply lacks it.
   */
  findingsTotal?: number;
  /** F5 — real total of GROUPS (after grouping, before the storage ceiling and before paging). */
  groupsTotal?: number;
  /**
   * F5 — real count per `kind`, over the raw (pre-grouping, pre-paging)
   * population — did NOT exist before this contract (a prior "TODO totalByKind
   * ya existe" turned out false on inspection: `CodeAnalysis.kinds` is a
   * kind→label catalogue, not a count). Lets the panel's per-kind bar show
   * the true volume even for a kind entirely absent from the current page.
   */
  totalByKind?: Record<string, number>;
  /**
   * F5 — which slice of the full ranking `findings` is. `offset`/`limit`
   * describe what was actually returned (`limit` reflects the resolved cap
   * even when the caller passed `"unlimited"`, never a mystery number);
   * `hasMore` is `true` whenever `groupsTotal` extends past this page —
   * including when the storage ceiling (`truncated`) is the reason more
   * can't be served.
   */
  page?: { offset: number; limit: number; hasMore: boolean };
  /**
   * F5 — CONTRATO-F5.md §2.6: `true` only when the hard STORAGE ceiling
   * (`MAX_STORED_FINDINGS`, not the caller's page `limit`) discarded the tail
   * of an already-ranked list. `findingsTotal`/`totalByKind` are computed
   * before this ceiling, so the honest count survives even when some rows
   * don't.
   */
  truncated?: boolean;
}

/** One repo's slot in the response, including failures. */
export interface TaskCodeRepo {
  repoName: string;
  worktreePath: string;
  analysis: CodeAnalysis | null;
  /** True while the first (or a refreshed) analysis is running. */
  analyzing?: boolean;
  error?: string;
}

/** Response for GET /api/tasks/:taskId/code. */
export interface TaskCodeResponse {
  taskId: string;
  repos: TaskCodeRepo[];
}

/* ────────────────────────────────────────────────────────────────────────
 * HTTP API envelopes
 * ──────────────────────────────────────────────────────────────────────── */

/** Standard error body returned by API routes on failure. */
export interface ApiError {
  error: string;
  details?: unknown;
}
