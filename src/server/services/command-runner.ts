/**
 * CommandRunnerService — ONE persistent interactive shell per `(taskId, repoId)`.
 *
 * The command panel is a REAL terminal. For each `(taskId, repoId)` the runner
 * keeps a single `bash -il` (interactive login) shell, spawned at the repo's
 * WORKTREE cwd with the parent env, with a capped in-memory replay buffer
 * (~256KB tail) and onData/onExit fan-out — mirroring the claude pty. The user
 * types into it (keystrokes → shell). The shell persists across reconnects and
 * exits only when killed (teardown).
 *
 * The Setup / Run / Teardown BUTTONS no longer spawn their own processes — they
 * INJECT the configured script into the shell:
 *   • setup / teardown → write `<script>\n`.
 *   • run              → allocate a fresh free `$PORT`, write `export PORT=<port>\n`
 *                        then `<script>\n` (so the dev server binds `$PORT`). The
 *                        user presses Ctrl+C in the shell to stop it — there is no
 *                        separate stop/▶■ state.
 *
 * For each `(taskId, repoId)` the runner:
 *   • resolves the worktree cwd from the task's matching TaskRepo
 *     (`task.repos.find(projectRepoId === repoId).worktreePath`),
 *   • resolves a script's text from the matching ProjectRepo (`id === repoId`)
 *     for the requested kind when injecting,
 *   • refuses to inject (clear error) when that script is empty/undefined,
 *   • spawns `bash -il` at the worktree cwd with the parent env on first need.
 *
 * `killAllForTask` always takes down the whole process GROUP(s) for the task so
 * a dev server (and its children) dies with the shell, then forgets the shells.
 *
 * Implements the shared {@link CommandRunnerService} interface. Cross-module
 * dependencies (Repositories) are consumed as the shared types only.
 */
import net from "node:net";
import os from "node:os";
import * as pty from "node-pty";

import type {
  CmdDataListener,
  CmdExitListener,
  CmdReplay,
  CommandRunnerService as ICommandRunnerService,
  Repositories,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type {
  CommandKind,
  ProjectRepo,
  RunCommandResult,
  TaskRepo,
} from "../../shared/types.js";

/** Default terminal geometry before the client fits it. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Cap of the per-shell in-memory replay buffer (~256KB tail). */
const REPLAY_BUFFER_MAX_BYTES = 256 * 1024;

/** Internal record tracking one live (or recently-exited) shell. */
interface ShellRecord {
  taskId: string;
  repoId: string;
  /** Live pty while running; null once it has exited / been killed. */
  proc: pty.IPty | null;
  pid: number | null;
  cols: number;
  rows: number;
  /** Capped tail of output for replay (kept as a string; trimmed by bytes). */
  buffer: string;
  bufferBytes: number;
  dataListeners: Set<CmdDataListener>;
  exitListeners: Set<CmdExitListener>;
}

export class CommandRunnerServiceImpl implements ICommandRunnerService {
  /** All shell records keyed by `${taskId}\0${repoId}`. */
  private readonly shells = new Map<string, ShellRecord>();

  constructor(private readonly repos: Repositories) {}

  /* ──────────────────────────────────────────────────────────────────────
   * ensureShell — spawn the (task, repo) shell if not already live.
   * ────────────────────────────────────────────────────────────────────── */

  ensureShell(taskId: string, repoId: string): void {
    this.ensureLiveShell(taskId, repoId);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * runScript — inject a lifecycle script (button press) into the shell.
   * ────────────────────────────────────────────────────────────────────── */

  async runScript(
    taskId: string,
    repoId: string,
    kind: CommandKind,
  ): Promise<RunCommandResult> {
    // Resolve the script (ProjectRepo) FIRST so an empty/undefined script is
    // rejected before we touch the shell. resolve() throws CommandNotFoundError
    // for a missing task/repo (mapped to a 404 by the API).
    const { projectRepo } = this.resolve(taskId, repoId);
    const script = scriptFor(projectRepo, kind);
    if (!script || !script.trim()) {
      throw new CommandScriptError(
        `No ${kind} script configured for repo "${projectRepo.name}"`,
      );
    }

    // Ensure the interactive shell is live, then inject the script text.
    const record = this.ensureLiveShell(taskId, repoId);

    let port: number | null = null;
    if (kind === "run") {
      // A fresh free port for the dev server, exported into the shell BEFORE the
      // run script so `$PORT` is set when it binds (mirrors the old auto-run).
      port = await allocateFreePort();
      record.proc?.write(`export PORT=${port}\n`);
    }
    record.proc?.write(`${script}\n`);

    return { port };
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Subscriptions + replay
   * ────────────────────────────────────────────────────────────────────── */

  onData(taskId: string, repoId: string, cb: CmdDataListener): Unsubscribe {
    const record = this.ensureRecordForSub(taskId, repoId);
    record.dataListeners.add(cb);
    return () => record.dataListeners.delete(cb);
  }

  onExit(taskId: string, repoId: string, cb: CmdExitListener): Unsubscribe {
    const record = this.ensureRecordForSub(taskId, repoId);
    record.exitListeners.add(cb);
    return () => record.exitListeners.delete(cb);
  }

  getReplay(taskId: string, repoId: string): CmdReplay {
    const record = this.shells.get(makeKey(taskId, repoId));
    return { data: record?.buffer ?? "" };
  }

  isRunning(taskId: string, repoId: string): boolean {
    const record = this.shells.get(makeKey(taskId, repoId));
    return record?.proc != null;
  }

  write(taskId: string, repoId: string, data: string): void {
    const record = this.shells.get(makeKey(taskId, repoId));
    if (!record?.proc) return;
    record.proc.write(data);
  }

  resize(taskId: string, repoId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const record = this.ensureRecordForSub(taskId, repoId);
    record.cols = cols;
    record.rows = rows;
    if (!record.proc) return;
    try {
      record.proc.resize(cols, rows);
    } catch {
      // pty may have exited between the check and the resize; ignore.
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * killAllForTask — used by CleanupService before worktree removal
   * ────────────────────────────────────────────────────────────────────── */

  killAllForTask(taskId: string): void {
    for (const [key, record] of this.shells) {
      if (record.taskId !== taskId) continue;
      if (record.proc) {
        killProcessGroup(record.pid);
        try {
          record.proc.kill();
        } catch {
          /* already gone */
        }
      }
      // Drop all in-memory state for the task's shells so the map doesn't leak
      // across the server's lifetime. The pty's own onExit (if it still fires)
      // becomes a no-op against the absent record.
      this.shells.delete(key);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Helpers
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Return the (task, repo) shell, spawning a fresh `bash -il` at the worktree
   * cwd when none is live. Reuses the SAME record (and its listener sets +
   * fitted cols/rows) across reconnects so an existing /ws/cmd subscription
   * keeps receiving output. Throws when the task/repo cannot be resolved.
   */
  private ensureLiveShell(taskId: string, repoId: string): ShellRecord {
    const record = this.ensureRecordForSub(taskId, repoId);
    if (record.proc) return record;

    const { worktree } = this.resolve(taskId, repoId);

    const env = { ...process.env } as Record<string, string>;
    // Do NOT leak the kanban SERVER's NODE_ENV=production into the user's shell.
    // With NODE_ENV=production, `npm install`/`npm ci` OMIT devDependencies, which
    // breaks dev builds (e.g. nuxt/vite plugins live in devDependencies) — the
    // shell must behave like a normal dev terminal.
    delete env.NODE_ENV;
    const { command, args } = resolveShell();
    const proc = pty.spawn(command, args, {
      name: "xterm-color",
      cwd: worktree.worktreePath,
      env,
      cols: record.cols,
      rows: record.rows,
    });

    record.proc = proc;
    record.pid = proc.pid;

    proc.onData((data) => {
      // Ignore output from a pty a newer shell has already replaced.
      if (record.proc !== proc) return;
      this.appendBuffer(record, data);
      for (const cb of record.dataListeners) cb(data);
    });

    proc.onExit(({ exitCode }) => {
      // A late exit from a pty already replaced must not fire on the new shell.
      if (record.proc !== proc) return;
      record.proc = null;
      record.pid = null;
      for (const cb of record.exitListeners) cb(exitCode);
    });

    return record;
  }

  /**
   * Resolve the task's worktree row (cwd) for `repoId` and the project repo
   * (script source). Throws a clear error when the task, the task's repo row, or
   * the project repo is missing — so the API can map it to a 404.
   */
  private resolve(
    taskId: string,
    repoId: string,
  ): { worktree: TaskRepo; projectRepo: ProjectRepo } {
    const task = this.repos.tasks.getById(taskId, { withRepos: true });
    if (!task) {
      throw new CommandNotFoundError(`Task ${taskId} not found`);
    }
    const worktree = (task.repos ?? []).find(
      (r) => r.projectRepoId === repoId,
    );
    if (!worktree) {
      throw new CommandNotFoundError(
        `Task ${taskId} has no worktree for repo ${repoId}`,
      );
    }
    const projectRepo = this.repos.projectRepos.getById(repoId);
    if (!projectRepo) {
      throw new CommandNotFoundError(`Project repo ${repoId} not found`);
    }
    return { worktree, projectRepo };
  }

  /** Get the record for a (task, repo), creating an empty placeholder if none. */
  private ensureRecordForSub(taskId: string, repoId: string): ShellRecord {
    const key = makeKey(taskId, repoId);
    let record = this.shells.get(key);
    if (!record) {
      record = {
        taskId,
        repoId,
        proc: null,
        pid: null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        buffer: "",
        bufferBytes: 0,
        dataListeners: new Set(),
        exitListeners: new Set(),
      };
      this.shells.set(key, record);
    }
    return record;
  }

  /** Append a chunk to the record's capped replay buffer (last ~256KB). */
  private appendBuffer(record: ShellRecord, data: string): void {
    record.buffer += data;
    record.bufferBytes += Buffer.byteLength(data, "utf8");
    if (record.bufferBytes > REPLAY_BUFFER_MAX_BYTES) {
      // Trim from the front to the cap. Slicing by chars is approximate vs.
      // bytes, but xterm re-syncs on a split multibyte sequence; recompute the
      // real byte length so the cursor stays honest.
      const overshoot = record.bufferBytes - REPLAY_BUFFER_MAX_BYTES;
      record.buffer = record.buffer.slice(overshoot);
      record.bufferBytes = Buffer.byteLength(record.buffer, "utf8");
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Errors
 * ────────────────────────────────────────────────────────────────────────── */

/** Thrown when the addressed task/repo cannot be resolved (→ API 404). */
export class CommandNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandNotFoundError";
  }
}

/** Thrown when the resolved script is empty/undefined (→ API 409). */
export class CommandScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandScriptError";
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Free helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Compose the per-shell map key (NUL-separated so ids can't collide). */
function makeKey(taskId: string, repoId: string): string {
  return `${taskId}\0${repoId}`;
}

/** Pick the configured script text for a kind off a ProjectRepo. */
function scriptFor(repo: ProjectRepo, kind: CommandKind): string | null {
  switch (kind) {
    case "setup":
      return repo.setupScript;
    case "run":
      return repo.runScript;
    case "teardown":
      return repo.teardownScript;
    default:
      return null;
  }
}

/**
 * The interactive shell to spawn for the command panel: `bash -il` (interactive
 * login) so the user's profile (PATH, nvm, etc.) is loaded and they get a normal
 * prompt to type into.
 */
function resolveShell(): { command: string; args: string[] } {
  return { command: "bash", args: ["-il"] };
}

/**
 * Kill the process group led by `pid` (negative-pid signal on POSIX) so child
 * processes — notably a dev server started by a `run` script — are terminated.
 * Falls back to a direct kill where process groups are unavailable.
 */
function killProcessGroup(pid: number | null): void {
  if (pid == null) return;
  if (os.platform() === "win32") {
    // node-pty's own kill handles the Windows job-object teardown.
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/**
 * Ask the OS for an ephemeral free TCP port (bind :0, read it back, release).
 * There is an inherent race before the run script binds, but EADDRINUSE is the
 * dev server's to handle; this gives `$PORT` a concrete value (mirrors the old
 * lifecycle allocateFreePort).
 */
function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

/** Factory used by the server bootstrap. */
export const createCommandRunner = (
  repos: Repositories,
): CommandRunnerServiceImpl => new CommandRunnerServiceImpl(repos);
