/**
 * PTY WebSocket bridge.
 *
 * Connects an xterm.js client to a task's node-pty over the `/ws/pty` channel
 * (canonical path `/ws/pty?taskId=<id>`; a trailing `/ws/pty/<id>` path form is
 * also accepted). On connect it first REPLAYS the task's captured output (so a
 * reconnecting terminal recovers the whole conversation), then streams live
 * `PtyService.onData` to the socket as raw output frames, applies inbound
 * `pty:input` / `pty:resize` messages, and forwards pty exit to the client
 * before closing. Live chunks arriving during the async replay read are buffered
 * and flushed after the replay so output is never dropped or reordered. If the
 * task has already exited, the replay is followed by a `pty:exit` so the UI
 * shows the finished session instead of a blank/hanging terminal.
 *
 * Before any of that, attach first calls the optional `ensureAgent(taskId)` hook
 * (wired to TaskLifecycle.ensureAgent). When the task's pty died — a dev server
 * restart, a reboot, the user exiting claude, even days later — that respawns
 * the agent with resume args (`claude --continue`) so the conversation continues
 * and the freshly spawned pty is the one getReplay/onData/write bind to: the user
 * can keep working immediately. When the pty is already alive, ensureAgent is a
 * no-op and the existing replay/live/exit ordering is untouched.
 *
 * Closing the socket only detaches listeners — it does NOT kill the pty, so a
 * task's agent keeps running while no terminal is attached and survives page
 * reloads / reconnects.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { PtyService } from "../../shared/interfaces.js";
import type {
  PtyExitMsg,
  PtyMessage,
  PtyOutputMsg,
} from "../../shared/types.js";

/** Path prefix this bridge owns. */
const PTY_PATH = "/ws/pty";

/**
 * Optional hook the bridge invokes at the very START of attach to revive a dead
 * task's agent before the terminal binds to it (wired to
 * TaskLifecycle.ensureAgent). A no-op when the pty is already live.
 */
export type EnsureAgent = (taskId: string) => Promise<void>;

/** WS close code used when we reject a connection lacking a taskId. */
const CLOSE_POLICY_VIOLATION = 1008;

/**
 * Wire the PTY bridge onto an existing HTTP server. Performs its own `upgrade`
 * handling for the `/ws/pty` path so it can coexist with other ws channels on
 * the same port (the events channel claims `/ws/events`).
 */
export function setup(
  server: HttpServer,
  ptyService: PtyService,
  ensureAgent?: EnsureAgent,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parseUrl(req);
    if (!pathname.startsWith(PTY_PATH)) return;

    wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const taskId = extractTaskId(req);
    if (!taskId) {
      ws.close(CLOSE_POLICY_VIOLATION, "missing taskId");
      return;
    }
    attach(ws, taskId, ptyService, ensureAgent);
  });

  return wss;
}

/**
 * Bridge a single connected socket to a task's pty. Exported for direct use /
 * testing; `setup` calls this per connection.
 *
 * `ensureAgent` (optional) is awaited FIRST, before any service interaction, so
 * a dead task's agent is respawned (with resume args) before the terminal binds
 * to its pty — getReplay/onData/write then all target the freshly spawned pty
 * and the user can type immediately, the conversation resumed by the agent. When
 * the pty is already live (or no hook is given) it is a no-op and the existing
 * replay/live/exit ordering is unchanged.
 */
export function attach(
  ws: WebSocket,
  taskId: string,
  ptyService: PtyService,
  ensureAgent?: EnsureAgent,
): void {
  // No respawn hook → wire synchronously, exactly as before (preserves the
  // original ordering: onData/getReplay bind in the same turn as attach).
  if (!ensureAgent) {
    wire(ws, taskId, ptyService);
    return;
  }

  // Respawn a dead agent before wiring anything, THEN bind to the (possibly
  // freshly spawned) pty. The wiring is deferred behind ensureAgent so the
  // replay snapshot, the live onData subscription, and inbound writes all bind
  // to the new pty rather than the stale/absent one. ensureAgent never throws
  // (lifecycle swallows spawn errors), so wiring always proceeds.
  void Promise.resolve(ensureAgent(taskId))
    .catch(() => {
      // Defensive: even if a non-lifecycle hook rejected, still attach so the
      // terminal at least replays history rather than hanging unbound.
    })
    .then(() => wire(ws, taskId, ptyService));
}

/**
 * Wire a connected socket to a task's pty: replay-before-live, inbound
 * input/resize, and exit forwarding. Called by {@link attach} once any agent
 * respawn has completed, so every service touch binds to the live pty.
 */
function wire(ws: WebSocket, taskId: string, ptyService: PtyService): void {
  // The socket may have closed while ensureAgent was respawning; skip wiring a
  // dead socket (no listeners to leak, nothing to send).
  if (ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) return;

  const send = (msg: PtyMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  const sendOutput = (data: string): void => {
    if (data.length === 0) return;
    const out: PtyOutputMsg = { type: "pty:output", taskId, data };
    send(out);
  };

  // Replay-before-live ordering, deduped by byte position. See {@link ReplayGate}.
  const gate = new ReplayGate(ptyService.bytePosition(taskId));

  const offData = ptyService.onData(taskId, (data) => {
    const live = gate.observe(data);
    if (live !== null) sendOutput(live);
  });

  // pty exit → notify the client, then close the socket. Buffer an exit that
  // fires mid-replay so it lands after the replayed history.
  let bufferedExit: PtyExitMsg | null = null;
  const emitExit = (msg: PtyExitMsg): void => {
    send(msg);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1000, "pty exited");
    }
  };
  const offExit = ptyService.onExit(taskId, (exitCode, signal) => {
    const exit: PtyExitMsg = { type: "pty:exit", taskId, exitCode, signal };
    if (!gate.isOpen) {
      bufferedExit = exit;
      return;
    }
    emitExit(exit);
  });

  // Capture whether the task was already finished BEFORE we read replay, so a
  // post-exit reconnect (no live pty) still gets a trailing pty:exit and the UI
  // shows a finished session instead of a blank/hanging terminal.
  const alreadyExited = ptyService.isExited(taskId);
  const storedExit = ptyService.lastExit(taskId);

  void Promise.resolve(ptyService.getReplay(taskId))
    .then((replay) => {
      gate.cutAt(replay.offset);
      if (replay.data.length > 0) sendOutput(replay.data);
    })
    .catch(() => {
      // Replay is best-effort; fall through to live streaming regardless. With
      // no usable offset, the gate keeps its baseline cut so buffered live
      // chunks are still forwarded (nothing dropped).
    })
    .finally(() => {
      // Flush anything that arrived live during the async replay read, in order,
      // skipping any chunk the replay already covered.
      for (const chunk of gate.open()) sendOutput(chunk);
      // If the task had already exited (no live record will fire), surface the
      // stored exit now so the terminal shows the finished session. A live exit
      // buffered during replay takes precedence.
      if (bufferedExit) {
        emitExit(bufferedExit);
      } else if (alreadyExited && storedExit) {
        emitExit({
          type: "pty:exit",
          taskId,
          exitCode: storedExit.exitCode,
          signal: storedExit.signal,
        });
      }
    });

  ws.on("message", (raw) => {
    applyInboundFrame(raw.toString(), taskId, ptyService);
  });

  // Socket closed: detach listeners only. Deliberately do NOT kill the pty so
  // the agent process survives terminal disconnects / reconnects.
  const detach = (): void => {
    offData();
    offExit();
  };
  ws.on("close", detach);
  ws.on("error", detach);
}

/**
 * Keeps the replayed history and the live stream MUTUALLY EXCLUSIVE for one
 * attach, and ordered.
 *
 * We must send the FULL captured history before any live frame, or the
 * reconnecting terminal renders out of order. Reading the replay is async, so
 * the caller registers the live listener up front and hands every chunk here:
 * while the gate is closed the chunk is BUFFERED, and {@link open} flushes the
 * buffer in arrival order once the replay has been sent.
 *
 * The replay tail and the live stream can OVERLAP: a chunk captured to disk
 * after we snapshot the byte cursor but before the tail read can otherwise land
 * in BOTH the replay and the live buffer, rendering twice on reconnect. So the
 * gate tracks each live chunk's byte POSITION in the session (anchored at the
 * cursor read when we attached) and forwards only chunks whose bytes fall AFTER
 * the replay's cut. Boundaries always align (capture appends whole chunks), so
 * a chunk is either entirely replayed or entirely live — never split.
 *
 * The cut starts at the attach baseline, so a FAILED replay read (no usable
 * offset) still forwards every buffered chunk rather than dropping it.
 */
class ReplayGate {
  /** True once the replay has been sent and live chunks may flow through. */
  private open_ = false;
  /** Byte offset the replay covered up to; chunks starting before it are dropped. */
  private cut: number;
  /** Byte position of the next live chunk, advanced from the attach baseline. */
  private pos: number;
  /** Live chunks held while closed, each with its END byte position. */
  private readonly buffered: Array<{ data: string; end: number }> = [];

  constructor(baseline: number) {
    this.cut = baseline;
    this.pos = baseline;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /**
   * Account for one live chunk. Returns the data to forward NOW, or null when
   * it was buffered (gate still closed) or already covered by the replay.
   */
  observe(data: string): string | null {
    const start = this.pos;
    this.pos += Buffer.byteLength(data, "utf8");
    if (!this.open_) {
      this.buffered.push({ data, end: this.pos });
      return null;
    }
    return start >= this.cut ? data : null;
  }

  /** Record where the sent replay ended. */
  cutAt(offset: number): void {
    this.cut = offset;
  }

  /**
   * Open the gate and return the buffered chunks to send, in arrival order,
   * minus any the replay already covered (end <= cut).
   */
  open(): string[] {
    this.open_ = true;
    const flush = this.buffered
      .filter((chunk) => chunk.end > this.cut)
      .map((chunk) => chunk.data);
    this.buffered.length = 0;
    return flush;
  }
}

/**
 * Apply one client → server frame to the task's pty: keystrokes (`pty:input`)
 * and terminal geometry (`pty:resize`). Malformed JSON, a non-string payload
 * and a non-finite/non-positive geometry are all ignored rather than thrown —
 * a bad frame must never tear down a live terminal. `pty:output` / `pty:exit`
 * are server-originated and ignored if echoed back.
 */
function applyInboundFrame(
  raw: string,
  taskId: string,
  ptyService: PtyService,
): void {
  let msg: PtyMessage;
  try {
    msg = JSON.parse(raw) as PtyMessage;
  } catch {
    return; // ignore malformed frames
  }
  switch (msg.type) {
    case "pty:input":
      if (typeof msg.data === "string") ptyService.write(taskId, msg.data);
      break;
    case "pty:resize":
      if (
        Number.isFinite(msg.cols) &&
        Number.isFinite(msg.rows) &&
        msg.cols > 0 &&
        msg.rows > 0
      ) {
        ptyService.resize(taskId, msg.cols, msg.rows);
      }
      break;
    default:
      break;
  }
}

/** Parse the request URL into a pathname + searchParams (host is irrelevant). */
function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "", "http://localhost");
}

/**
 * Resolve the task id from either the canonical `?taskId=` query param or the
 * trailing path segment of `/ws/pty/<id>`.
 */
function extractTaskId(req: IncomingMessage): string | null {
  const url = parseUrl(req);
  const fromQuery = url.searchParams.get("taskId");
  if (fromQuery) return fromQuery;

  const rest = url.pathname.slice(PTY_PATH.length).replace(/^\/+/, "");
  return rest.length > 0 ? decodeURIComponent(rest) : null;
}
