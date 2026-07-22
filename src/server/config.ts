/**
 * Server configuration. All values are env-overridable so the same build runs
 * in different local setups.
 */
import os from "node:os";
import path from "node:path";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Config {
  /** HTTP + WS port the server listens on. */
  port: number;
  /**
   * Base data dir holding the sqlite db, pty logs, and the agent hooks settings
   * file. Env-overridable via `CK_DATA_DIR`.
   */
  dataDir: string;
  /** Base directory under which session roots are assembled. */
  worktreeBaseDir: string;
  /** Absolute path to the sqlite database file. */
  dbPath: string;
  /**
   * Directory holding one `<taskId>.log` per task: the captured pty output that
   * is replayed when a terminal (re)connects so the conversation survives page
   * reloads and the agent exiting. Defaults under `dataDir`.
   */
  ptyLogDir: string;
  /**
   * Max bytes of captured output replayed to a (re)connecting terminal. Only the
   * tail of the log is read. Env-overridable via `CK_PTY_REPLAY_BYTES`.
   */
  ptyReplayBytes: number;
  /**
   * Hard cap (bytes) on a single task's on-disk pty log. When the log grows past
   * this, it is rewritten down to roughly its last half so a very long session
   * never grows unbounded. Replay always reads only `ptyReplayBytes` of the tail.
   */
  ptyLogMaxBytes: number;
  /** Command spawned in the pty at the session root (the agent). */
  defaultAgentCommand: string;
  /** Default arguments passed to the agent command. */
  defaultAgentArgs: string[];
  /**
   * Args appended to the agent command when RESPAWNING an existing task (vs.
   * creating a fresh one) so the agent resumes the prior on-disk conversation
   * instead of starting over. Default `["--continue"]` — `claude --continue`
   * run at the task's session root reattaches the persisted transcript, even
   * days later. Env `CK_AGENT_RESUME_ARGS` is a space-separated list.
   */
  agentResumeArgs: string[];
  /**
   * Optional template repo whose `CLAUDE.md` and `.claude` are symlinked into
   * each session root so the orchestration flow works inside the task.
   * Null disables the symlinking step.
   */
  templateRepoPath: string | null;
  /**
   * Allow-roots the filesystem browser (repo picker) may navigate. Every path
   * served by /api/fs is restricted to be equal to, or a descendant of, one of
   * these. Env `CK_BROWSE_ROOTS` is a colon-separated list; defaults to the
   * user's home dir. Each entry is path.resolve()'d.
   */
  browseRoots: string[];
  /**
   * SAFETY-NET timeout (ms). Live agent state is hook-driven (api/agent-events.ts):
   * "working" is sticky from an activity hook until a Stop/Notification flips it to
   * "waiting". The AgentActivityMonitor only acts as a fallback — it demotes a
   * "working" task to "waiting" if its pty output stays quiet THIS long (a missed
   * Stop, e.g. an auto-mode prompt that never fired a Notification). It must be far
   * longer than a normal turn's output gaps (the "thinking" spinner keeps output
   * flowing) so it never demotes mid-work. Env-overridable via `CK_IDLE_MS`.
   * Default 30000 (30s).
   */
  idleThresholdMs: number;
  /**
   * How often (ms) the AgentActivityMonitor polls every live task's idle time to
   * re-derive its working/waiting state. Smaller = snappier transitions, more
   * wakeups. Env-overridable via `CK_IDLE_TICK_MS`. Default 1000.
   */
  idleTickMs: number;
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Base data dir (sqlite db, pty logs, …). Mirrors the dbPath default location. */
const DATA_DIR = path.resolve(env("CK_DATA_DIR", path.join(ROOT, "data")));

export const config: Config = {
  port: Number.parseInt(env("CK_PORT", "8787"), 10),
  dataDir: DATA_DIR,
  worktreeBaseDir: path.resolve(
    env("CK_WORKTREE_BASE", path.join(os.homedir(), "claude-kanban-sessions")),
  ),
  dbPath: path.resolve(env("CK_DB_PATH", path.join(DATA_DIR, "claude-kanban.db"))),
  ptyLogDir: path.resolve(env("CK_PTY_LOG_DIR", path.join(DATA_DIR, "pty-logs"))),
  ptyReplayBytes: envInt("CK_PTY_REPLAY_BYTES", 2 * 1024 * 1024),
  ptyLogMaxBytes: envInt("CK_PTY_LOG_MAX_BYTES", 10 * 1024 * 1024),
  defaultAgentCommand: env("CK_AGENT_COMMAND", "claude"),
  defaultAgentArgs: env("CK_AGENT_ARGS", "").split(" ").filter(Boolean),
  agentResumeArgs: env("CK_AGENT_RESUME_ARGS", "--continue")
    .split(" ")
    .filter(Boolean),
  templateRepoPath: process.env.CK_TEMPLATE_REPO
    ? path.resolve(process.env.CK_TEMPLATE_REPO)
    : null,
  browseRoots: (process.env.CK_BROWSE_ROOTS
    ? process.env.CK_BROWSE_ROOTS.split(":").filter(Boolean)
    : [os.homedir()]
  ).map((p) => path.resolve(p)),
  idleThresholdMs: envInt("CK_IDLE_MS", 30000),
  idleTickMs: envInt("CK_IDLE_TICK_MS", 1000),
};

/** Project root (directory containing package.json). */
export const projectRoot = ROOT;
