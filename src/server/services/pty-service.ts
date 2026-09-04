/**
 * PtyService — manages one interactive node-pty process per task.
 *
 * Each task gets a single pseudo-terminal running the configured agent command
 * (default "claude") at the task's session root, with the parent process env
 * inherited so the agent reuses the user's existing Claude login. Output is
 * fanned out to subscribers (the ws pty bridge) via `onData`; process exit is
 * signalled via `onExit`. `kill` tears down both the pty and its entire process
 * group so child dev servers started inside the agent session also die.
 *
 * Every output chunk is ALSO appended (fire-and-forget) to a per-task log under
 * `config.ptyLogDir` so a terminal can replay the whole conversation when it
 * (re)connects — that is what fixes "re-entering a task loses the conversation".
 * The exit record is retained after the process dies so replay still works for a
 * finished session. The log is size-capped so a long session can't grow without
 * bound; `getReplay` reads only the last `config.ptyReplayBytes` of the tail.
 *
 * Implements the shared `PtyService` interface from `../../shared/interfaces`.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import * as pty from "node-pty";

import type {
  PtyDataListener,
  PtyExitListener,
  PtyExitAnyListener,
  PtyHandle,
  PtyReplay,
  PtyService as IPtyService,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type { Task } from "../../shared/types.js";
import { config } from "../config.js";
import {
  agentHooksFilePath,
  ensureTaskSettingsFile,
} from "./agent-hooks.js";

/** Internal record tracking one live pty and its subscriber sets. */
interface PtyRecord {
  taskId: string;
  proc: pty.IPty;
  pid: number;
  cols: number;
  rows: number;
  dataListeners: Set<PtyDataListener>;
  exitListeners: Set<PtyExitListener>;
}

/**
 * What we remember once a pty has EXITED. We deliberately keep this (rather than
 * wiping all state) so a terminal reconnecting after the agent finished can
 * still replay the conversation from disk and then be shown the exit.
 */
interface ExitRecord {
  exitCode: number;
  signal: number | null;
}

/** Sensible defaults for an interactive terminal before the client fits it. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Optional hook so lifecycle can persist the spawned pid. */
export type PtySpawnListener = (taskId: string, pid: number) => void;

/**
 * The server's environment, stripped of everything a task's agent must NOT
 * inherit:
 *
 *  - CLAUDECODE + CLAUDE_CODE_* (SESSION_ID, CHILD_SESSION, ENTRYPOINT,
 *    EXECPATH...) — the Claude Code session identity this server may itself have
 *    been launched with. Left in, they make the spawned `claude` run in
 *    nested/child mode and NOT persist a normal per-cwd transcript, which
 *    silently breaks resume (`claude --continue` then finds "no conversation").
 *    Removing them makes each task a first-class session that resumes correctly.
 *  - NODE_ENV — the kanban SERVER's `production` value. Inside the task the agent
 *    runs dev tooling (npm install / dev servers), and production mode makes npm
 *    OMIT devDependencies, breaking dev builds (nuxt/vite plugins live there).
 */
function cleanAgentEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  delete env.NODE_ENV;
  return env;
}

export class PtyServiceImpl implements IPtyService {
  private readonly ptys = new Map<string, PtyRecord>();
  private readonly spawnListeners = new Set<PtySpawnListener>();
  /**
   * GLOBAL exit listeners, fired with `(taskId, exitCode, signal)` whenever ANY
   * task's pty exits. The symmetric counterpart of `spawnListeners`: lifecycle
   * subscribes once to clear a task's persisted live `agent_state` the moment its
   * agent process dies. Distinct from the per-task `exitListeners` (kept on each
   * PtyRecord) the ws bridge uses, so adding this never disturbs that path.
   */
  private readonly exitAnyListeners = new Set<PtyExitAnyListener>();
  /**
   * Exit records for ptys that have FINISHED. Survives `ptys.delete` so replay
   * still works after the agent exits (the on-disk log is the source of truth
   * for the bytes; this map is the "session is over, here is its exit code").
   */
  private readonly exited = new Map<string, ExitRecord>();
  /**
   * Per-task append serialisation chain. Every capture write is appended to its
   * task's chain so on-disk ordering matches arrival order without ever blocking
   * the live stream (the chain is awaited only internally, fire-and-forget).
   * The log reset on respawn is also routed through this chain so a truncate is
   * always ordered before the first append of the new session.
   */
  private readonly writeChains = new Map<string, Promise<void>>();
  /** Tracks tasks whose log is currently being size-trimmed, to avoid overlap. */
  private readonly trimming = new Set<string>();
  /**
   * Running count of bytes captured (appended) per task since the current
   * session's log was reset. Incremented INSIDE the write chain so it advances
   * in lock-step with the on-disk append order. This is the cursor the ws bridge
   * gates on: `getReplay` snapshots it under the same chain, and the bridge only
   * forwards live bytes produced AFTER that snapshot — making replay and live
   * mutually exclusive (no chunk both replayed and re-sent, and none dropped).
   */
  private readonly logBytes = new Map<string, number>();
  /**
   * Per-task ACTIVITY CLOCK: the epoch-ms timestamp (`Date.now()`) of the most
   * recent output chunk produced by the task's pty. Seeded to "now" on spawn and
   * bumped inside the `proc.onData` handler on every output chunk. This is the
   * single source the AgentActivityMonitor samples (via `getIdleMs`) to derive
   * working vs. waiting; the agent-event hooks nudge it forward (`markActivity`)
   * or backward past the idle threshold (`markIdle`) so transitions are near
   * instant without ever parsing terminal text. Cleared in `forget`.
   */
  private readonly lastOutputAt = new Map<string, number>();

  /**
   * Per-task epoch ms of the last byte written INTO the pty. Mirrors
   * {@link lastOutputAt} for the opposite direction: that one says "the agent is
   * still talking", this one says "the user is still typing".
   */
  private readonly lastInputAt = new Map<string, number>();

  /**
   * Register a callback invoked with `(taskId, pid)` whenever a pty is spawned.
   * Lifecycle uses this to persist `tasks.pty_pid`. Returns an unsubscribe fn.
   */
  onSpawn(cb: PtySpawnListener): Unsubscribe {
    this.spawnListeners.add(cb);
    return () => this.spawnListeners.delete(cb);
  }

  /**
   * Register a global exit callback invoked with `(taskId, exitCode, signal)`
   * whenever ANY task's pty exits. Lifecycle uses this to clear `tasks.agent_state`
   * so a card never shows a stale live state after its agent is gone. Returns an
   * unsubscribe fn.
   */
  onExitAny(cb: PtyExitAnyListener): Unsubscribe {
    this.exitAnyListeners.add(cb);
    return () => this.exitAnyListeners.delete(cb);
  }

  async spawnForTask(
    task: Task,
    opts?: { resume?: boolean },
  ): Promise<PtyHandle> {
    if (!task.sessionRoot) {
      throw new Error(
        `Cannot spawn pty for task ${task.id}: no session root assembled`,
      );
    }
    if (this.ptys.has(task.id)) {
      throw new Error(`A pty already exists for task ${task.id}`);
    }

    this.beginFreshSession(task.id);

    const cwd = task.sessionRoot;
    const env = cleanAgentEnv();
    const cols = DEFAULT_COLS;
    const rows = DEFAULT_ROWS;

    const settingsFile = await this.settingsFileFor(task);
    const { command, args } = this.resolveCommand(
      opts?.resume === true,
      settingsFile,
    );

    const proc = pty.spawn(command, args, {
      name: "xterm-color",
      cwd,
      env,
      cols,
      rows,
    });

    const record: PtyRecord = {
      taskId: task.id,
      proc,
      pid: proc.pid,
      cols,
      rows,
      dataListeners: new Set(),
      exitListeners: new Set(),
    };
    this.ptys.set(task.id, record);

    this.maybeWarnFallbackShell(record, command);

    this.wireProcessOutput(record);

    for (const cb of this.spawnListeners) cb(task.id, record.pid);

    return { taskId: task.id, pid: record.pid, cols, rows };
  }

  /**
   * Reset all per-session state so a fresh spawn does not inherit the previous
   * run's output or exit. Drops any stale exit record, restarts the byte cursor
   * at 0, seeds the activity clock so the monitor reads the freshly spawned agent
   * as "working" from tick one (a spawn is activity even before any output; the
   * lifecycle also calls markActivity right after), and truncates a leftover log.
   *
   * CRUCIAL: the truncate is routed THROUGH the write chain (not fire-and-forget)
   * so the very first append from proc.onData→capture() is ordered AFTER the rm
   * completes — otherwise an append racing the async rm could be silently dropped.
   */
  private beginFreshSession(taskId: string): void {
    this.exited.delete(taskId);
    this.logBytes.set(taskId, 0);
    this.lastOutputAt.set(taskId, Date.now());
    this.writeChains.set(taskId, this.resetLog(taskId));
  }

  /**
   * When `resolveCommand` fell back to an interactive shell (the configured agent
   * was not on PATH), print a one-time hint into the terminal so the user knows
   * why they got a bare shell and how to fix it. No-op when the configured agent
   * did resolve. The hint is captured to disk and fanned out on a microtask, the
   * same path live output takes, so a reconnecting terminal replays it too.
   */
  private maybeWarnFallbackShell(record: PtyRecord, command: string): void {
    if (command === this.configuredCommand()) return;
    const hint =
      `\r\n\x1b[33m[claude-kanban] "${this.configuredCommand()}" not found on PATH; ` +
      `falling back to an interactive shell.\r\n` +
      `Install the Claude CLI (or set CK_AGENT_COMMAND) and recreate the task ` +
      `to launch the agent automatically.\x1b[0m\r\n`;
    queueMicrotask(() => {
      this.capture(record.taskId, hint);
      for (const cb of record.dataListeners) cb(hint);
    });
  }

  /**
   * Subscribe this service to a freshly spawned pty's output and exit: capture
   * every chunk to disk and fan it out to live terminals, and on exit remember
   * the status, notify per-task then global listeners, and drop the record.
   */
  private wireProcessOutput(record: PtyRecord): void {
    const taskId = record.taskId;

    record.proc.onData((data) => {
      // Bump the per-task activity clock on every output chunk. The clock keeps a
      // "working" task working while claude streams, and the AgentActivityMonitor
      // lapses it to "waiting" once output goes quiet. It is NOT used to PROMOTE
      // (waiting → working) — that is hook-driven (api/agent-events.ts) — so the
      // redraw burst from merely opening/resizing a terminal can't flip an idle
      // task to "working". No terminal text is parsed — just the time.
      this.lastOutputAt.set(taskId, Date.now());
      // Capture to disk FIRST (fire-and-forget) so reconnecting terminals can
      // replay it, then fan out to live listeners. Capturing never blocks fan-out.
      this.capture(taskId, data);
      for (const cb of record.dataListeners) cb(data);
    });

    record.proc.onExit(({ exitCode, signal }) => {
      const sig = typeof signal === "number" ? signal : null;
      // Remember the exit so post-exit reconnects replay-then-show-finished.
      // CRUCIAL: do NOT wipe the on-disk log here — history must survive exit.
      this.exited.set(taskId, { exitCode, signal: sig });
      for (const cb of record.exitListeners) cb(exitCode, sig);
      // Notify global exit subscribers (lifecycle clears the task's agent_state).
      // Fired AFTER the per-task listeners so the bridge's exit handling is
      // unaffected; carries the taskId since these listeners are not task-scoped.
      for (const cb of this.exitAnyListeners) cb(taskId, exitCode, sig);
      this.ptys.delete(taskId);
    });
  }

  write(taskId: string, data: string): void {
    const rec = this.ptys.get(taskId);
    if (!rec) return;
    // Stamp the INPUT clock before writing. Everything the user types arrives
    // here (the ws bridge forwards `pty:input` to this method), so this is the
    // one place that knows a human is mid-keystroke — which is what keeps an
    // automated injection from landing in the middle of a half-typed prompt and
    // fusing with it (see caveman.ts#waitForQuiet).
    this.lastInputAt.set(taskId, Date.now());
    rec.proc.write(data);
  }

  /**
   * Epoch ms of the last byte written INTO this task's pty — user keystrokes as
   * well as anything the server typed. Undefined when nothing was ever written.
   */
  getLastInputAt(taskId: string): number | undefined {
    return this.lastInputAt.get(taskId);
  }

  resize(taskId: string, cols: number, rows: number): void {
    const rec = this.ptys.get(taskId);
    if (!rec) return;
    if (cols <= 0 || rows <= 0) return;
    rec.cols = cols;
    rec.rows = rows;
    try {
      rec.proc.resize(cols, rows);
    } catch {
      // pty may have exited between the check and the resize; ignore.
    }
  }

  kill(taskId: string): void {
    const rec = this.ptys.get(taskId);
    if (!rec) return;

    // Take down the whole process group first so child dev servers spawned by
    // the agent are terminated, not just the immediate pty leader.
    this.killProcessGroup(rec.pid);

    try {
      rec.proc.kill();
    } catch {
      // Already dead; the onExit handler will clean up the map entry.
    }
  }

  onData(taskId: string, cb: PtyDataListener): Unsubscribe {
    return this.addListener(taskId, (rec) => rec.dataListeners, cb);
  }

  onExit(taskId: string, cb: PtyExitListener): Unsubscribe {
    return this.addListener(taskId, (rec) => rec.exitListeners, cb);
  }

  /**
   * Add `cb` to one of a live pty's per-task listener sets and return an
   * unsubscribe that removes it. No live pty → a no-op unsubscribe (nothing to
   * subscribe to). `pick` selects which set (data vs exit) on the record; the
   * closure captures that exact Set so unsubscribe targets the same one.
   */
  private addListener<L>(
    taskId: string,
    pick: (rec: PtyRecord) => Set<L>,
    cb: L,
  ): Unsubscribe {
    const rec = this.ptys.get(taskId);
    if (!rec) return () => {};
    const set = pick(rec);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Whether a live pty exists for the task. */
  has(taskId: string): boolean {
    return this.ptys.has(taskId);
  }

  /**
   * The raw epoch-ms timestamp of the task's most recent pty output, or
   * `undefined` when no activity clock is tracked (never spawned / forgotten).
   */
  getLastOutputAt(taskId: string): number | undefined {
    return this.lastOutputAt.get(taskId);
  }

  /**
   * Milliseconds since the task's pty last produced output — the idle time the
   * AgentActivityMonitor compares against `config.idleThresholdMs`. `undefined`
   * when no activity clock is tracked, so the monitor can distinguish "no clock"
   * from "idle for 0ms".
   */
  getIdleMs(taskId: string): number | undefined {
    const at = this.lastOutputAt.get(taskId);
    if (at === undefined) return undefined;
    return Date.now() - at;
  }

  /**
   * Nudge the activity clock to NOW so the next monitor tick reads the task as
   * "working". No-op when the task has no live pty (a dead task must not be
   * resurrected to "working"). Used by lifecycle on (re)spawn and by the working
   * agent-event hooks.
   */
  markActivity(taskId: string): void {
    if (!this.ptys.has(taskId)) return;
    this.lastOutputAt.set(taskId, Date.now());
  }

  /**
   * Nudge the activity clock just PAST the idle threshold so the next monitor
   * tick flips the task to "waiting" (no need to wait out a full quiet window).
   * No-op when the task has no live pty. Used by the Stop / Notification hooks.
   */
  markIdle(taskId: string): void {
    if (!this.ptys.has(taskId)) return;
    this.lastOutputAt.set(taskId, Date.now() - config.idleThresholdMs - 1);
  }

  /**
   * Captured output to replay on (re)connect, capped to the last
   * `config.ptyReplayBytes` of the on-disk log, paired with the byte `offset`
   * (total bytes captured for the session) observed at the SAME point the tail
   * was read. Returns `{ data: "", offset: 0 }` when nothing was captured. Works
   * whether the pty is live OR already exited (history on disk).
   *
   * The tail read is sequenced ON the per-task write chain so it observes a
   * consistent prefix: every append ordered before this read is on disk and
   * counted in `offset`; every append ordered after it is NOT in `data` and is
   * left for the bridge to forward live. This makes replay and live mutually
   * exclusive by byte position — a chunk arriving in the getReplay/attach window
   * lands in EITHER the replayed tail OR the live stream, never both, never
   * neither (see `bytePosition`, which the bridge gates on).
   */
  async getReplay(taskId: string): Promise<PtyReplay> {
    // Chain the read after all currently-queued appends so it sees their bytes
    // and nothing after. Capturing `offset` here (inside the chained step) ties
    // the byte cursor to the exact on-disk prefix this read returns.
    const prev = this.writeChains.get(taskId) ?? Promise.resolve();
    let offset = this.logBytes.get(taskId) ?? 0;
    const read = prev.then(async () => {
      offset = this.logBytes.get(taskId) ?? 0;
      const data = await this.readLogTail(taskId, config.ptyReplayBytes);
      return data;
    });
    // Keep the chain alive for subsequent appends without letting a read failure
    // poison it (a rejected read must not break future captures).
    this.writeChains.set(
      taskId,
      read.then(
        () => {},
        () => {},
      ),
    );
    let data: string;
    try {
      data = await read;
    } catch {
      data = "";
    }
    return { data, offset };
  }

  /**
   * Total bytes captured (appended to the on-disk log) for a task's current
   * session so far. The ws bridge uses this as a cursor: combined with the
   * `offset` returned by `getReplay`, it forwards only live bytes produced after
   * the replay cut, so no chunk is both replayed and re-sent. Resets to 0 on a
   * fresh spawn. Unknown task → 0.
   */
  bytePosition(taskId: string): number {
    return this.logBytes.get(taskId) ?? 0;
  }

  /** Whether the task's pty has exited but its captured history still exists. */
  isExited(taskId: string): boolean {
    return this.exited.has(taskId) && !this.ptys.has(taskId);
  }

  /** The last recorded exit for the task, or null if still live / never spawned. */
  lastExit(taskId: string): { exitCode: number; signal: number | null } | null {
    if (this.ptys.has(taskId)) return null;
    return this.exited.get(taskId) ?? null;
  }

  /**
   * Forget all in-memory state for a task after teardown. FLUSHES any pending
   * captures first so no in-flight append can re-create the log AFTER cleanup
   * deletes it (the delete-vs-late-append race), then PURGES the per-task entries
   * from `exited` / `writeChains` / `trimming` / `logBytes` / `lastOutputAt` so
   * these maps don't grow without bound over the server's lifetime.
   *
   * Call it once the pty is dead (cleanup kills first). It does not delete the
   * log file itself — the caller (CleanupService) owns that, and `forget` simply
   * guarantees every queued write has landed before that delete happens.
   */
  async forget(taskId: string): Promise<void> {
    // Drain the write chain so a queued append cannot land after the caller's
    // delete (which would resurrect the log we are about to remove).
    await this.flushWrites(taskId);
    this.exited.delete(taskId);
    this.writeChains.delete(taskId);
    this.trimming.delete(taskId);
    this.logBytes.delete(taskId);
    this.lastOutputAt.delete(taskId);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Output capture (per-task log file under config.ptyLogDir).
   * ────────────────────────────────────────────────────────────────────── */

  /** Absolute path to a task's capture log. */
  private logPath(taskId: string): string {
    return nodePath.join(config.ptyLogDir, `${encodeURIComponent(taskId)}.log`);
  }

  /**
   * Append a chunk to the task's log. Fire-and-forget: errors are swallowed and
   * the live stream is never blocked. Appends are serialised per-task through a
   * promise chain so on-disk order matches arrival order. The opportunistic
   * size-trim runs as part of the SAME chained step (after the append) so an
   * append can never interleave between the trim's read/rewrite and rename —
   * appends and the trim are mutually exclusive on the chain.
   */
  private capture(taskId: string, data: string): void {
    if (data.length === 0) return;
    const prev = this.writeChains.get(taskId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await this.ensureLogDir();
        await fsp.appendFile(this.logPath(taskId), data, "utf8");
        // Advance the byte cursor IN LOCK-STEP with the append, by the chunk's
        // real UTF-8 byte length (the unit the bridge gates on). Done inside the
        // chained step so the count never runs ahead of what is on disk.
        const written = Buffer.byteLength(data, "utf8");
        this.logBytes.set(taskId, (this.logBytes.get(taskId) ?? 0) + written);
        // Trim ON the chain (same step) so the writeFile→rename can't be raced
        // by a concurrent append landing between them and being lost.
        await this.maybeTrimLog(taskId);
      })
      .catch(() => {
        // Capture is best-effort; never surface to the live stream.
      });
    this.writeChains.set(taskId, next);
  }

  /** Await all pending appends for a task (used before reading for replay). */
  private async flushWrites(taskId: string): Promise<void> {
    const chain = this.writeChains.get(taskId);
    if (chain) await chain.catch(() => {});
  }

  /** Lazily create the configured log directory. Tolerates concurrent creation. */
  private async ensureLogDir(): Promise<void> {
    await fsp.mkdir(config.ptyLogDir, { recursive: true });
  }

  /** Truncate (or remove) a task's log so a new session starts clean. */
  private async resetLog(taskId: string): Promise<void> {
    try {
      await fsp.rm(this.logPath(taskId), { force: true });
    } catch {
      // best-effort
    }
  }

  /**
   * Read up to the last `maxBytes` of the task's log as a UTF-8 string. Reading
   * the tail (not the whole file) bounds replay cost for long sessions. Missing
   * file → "". A multi-byte UTF-8 sequence split at the cut point is harmless
   * for xterm (it re-syncs); we keep the read simple and byte-oriented.
   */
  private async readLogTail(taskId: string, maxBytes: number): Promise<string> {
    const file = this.logPath(taskId);
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(file, "r");
      const { size } = await handle.stat();
      if (size === 0) return "";
      const start = size > maxBytes ? size - maxBytes : 0;
      const length = size - start;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, start);
      return buf.toString("utf8");
    } catch {
      // A missing file (never captured) or any read error → empty replay.
      return "";
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * Bound the on-disk log so a very long session never grows without limit. When
   * the log exceeds `config.ptyLogMaxBytes`, rewrite it keeping only its last
   * ~half. Replay always reads only the capped tail, so dropping the oldest half
   * is invisible for any session longer than the replay cap. Best-effort and
   * non-overlapping (guarded by `trimming`).
   */
  private async maybeTrimLog(taskId: string): Promise<void> {
    if (this.trimming.has(taskId)) return;
    const file = this.logPath(taskId);
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(file);
    } catch {
      return; // no log yet / gone
    }
    const max = config.ptyLogMaxBytes;
    if (stat.size <= max) return;

    this.trimming.add(taskId);
    try {
      const keep = Math.floor(max / 2);
      const start = stat.size - keep;
      let handle: fsp.FileHandle | undefined;
      let tail: Buffer;
      try {
        handle = await fsp.open(file, "r");
        tail = Buffer.allocUnsafe(keep);
        await handle.read(tail, 0, keep, start);
      } finally {
        await handle?.close().catch(() => {});
      }
      // Atomic-ish replace: write the kept tail to a sibling, then rename over.
      const tmp = `${file}.trim`;
      await fsp.writeFile(tmp, tail);
      await fsp.rename(tmp, file);
    } catch {
      // best-effort: a failed trim just means the log stays large this round.
    } finally {
      this.trimming.delete(taskId);
    }
  }

  /** The agent command as configured (pre-fallback). */
  private configuredCommand(): string {
    return config.defaultAgentCommand;
  }

  /**
   * Resolve the command to spawn: the configured agent if it is on PATH,
   * otherwise an interactive login shell as a fallback. When `resume` is true
   * (a RESPAWN of an existing task) the configured resume args (e.g.
   * `--continue`) are appended so the agent reattaches the prior on-disk
   * conversation instead of starting fresh. The shell fallback never resumes.
   *
   * For the real `claude` (NOT the shell fallback) we also append
   * `--settings <file>` so the kanban detection hooks are MERGED into the
   * session — Claude Code concatenates `--settings` hook arrays with the user's
   * own, so this never replaces the user's hooks. The shell fallback gets no
   * `--settings` (bash wouldn't understand it).
   *
   * `settingsFile` is the task's own settings file (hooks + its caveman plugin
   * switch), written just before the spawn. It falls back to the shared hooks
   * file when that write failed, so a full disk costs the caveman checkbox but
   * never the agent-state detection.
   */
  private resolveCommand(
    resume: boolean,
    settingsFile: string,
  ): { command: string; args: string[] } {
    const configured = config.defaultAgentCommand;
    if (this.isOnPath(configured)) {
      const args = [...config.defaultAgentArgs];
      if (resume) args.push(...config.agentResumeArgs);
      args.push("--settings", settingsFile);
      return { command: configured, args };
    }
    return { command: this.fallbackShell(), args: ["-i"] };
  }

  /**
   * The `--settings` file for this spawn: the per-task one, or the shared hooks
   * file if writing it failed. Never throws — a settings problem must not be
   * able to stop a task's agent from starting.
   */
  private async settingsFileFor(task: Task): Promise<string> {
    try {
      return await ensureTaskSettingsFile(task);
    } catch (err) {
      console.error(
        `[pty] failed to write task settings for ${task.id}; ` +
          `falling back to the shared hooks file:`,
        err,
      );
      return agentHooksFilePath();
    }
  }

  /** The interactive shell used when the agent command is unavailable. */
  private fallbackShell(): string {
    return process.env.SHELL ?? (os.platform() === "win32" ? "cmd.exe" : "bash");
  }

  /**
   * Best-effort check that a command is resolvable on PATH. Absolute/relative
   * paths are assumed present (node-pty surfaces the real spawn error if not).
   */
  private isOnPath(command: string): boolean {
    if (command.includes("/") || command.includes("\\")) return true;
    const pathVar = process.env.PATH ?? "";
    const sep = os.platform() === "win32" ? ";" : ":";
    const exts =
      os.platform() === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
        : [""];
    for (const dir of pathVar.split(sep)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = nodePath.join(dir, command + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          // try next
        }
      }
    }
    return false;
  }

  /**
   * Kill the process group led by `pid` (negative-pid signal on POSIX) so any
   * child processes — notably dev servers — are also terminated. Falls back to
   * a direct kill where process groups are unavailable.
   */
  private killProcessGroup(pid: number): void {
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
        // Process already gone.
      }
    }
  }
}

/** Concrete export used by the server bootstrap. */
export const createPtyService = (): PtyServiceImpl => new PtyServiceImpl();
