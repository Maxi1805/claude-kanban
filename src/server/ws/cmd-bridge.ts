/**
 * Command shell WebSocket bridge — `/ws/cmd?taskId=&repoId=`.
 *
 * A simpler sibling of the pty bridge for the per-repo interactive shell. A
 * command terminal connects with `(taskId, repoId)` — NO kind. On connect the
 * bridge ENSURES the `(taskId, repoId)` shell exists (spawning `bash -il` at the
 * worktree if needed), REPLAYS its buffered output (in-memory, capped by the
 * runner) so a reconnecting terminal recovers what it missed, then streams live
 * `cmd:output`, applies inbound `cmd:input` (user keystrokes) / `cmd:resize`,
 * and forwards the shell's exit as `cmd:exit` before closing.
 *
 * Replay comes from a small in-memory buffer, so we simply send the buffer, then
 * forward subsequent live chunks. A chunk arriving during the (synchronous)
 * replay is buffered and flushed after, in order, so nothing is dropped or
 * reordered.
 *
 * Closing the socket only detaches listeners — it never kills the shell, so a
 * dev server keeps running while no terminal is attached.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { CommandRunnerService } from "../../shared/interfaces.js";
import type {
  CmdExitMsg,
  CmdMessage,
  CmdOutputMsg,
} from "../../shared/types.js";

/** Path this bridge owns. */
const CMD_PATH = "/ws/cmd";

/** WS close code used when we reject a connection lacking valid params. */
const CLOSE_POLICY_VIOLATION = 1008;

/** The resolved shell address from a connection's query params. */
interface CmdAddress {
  taskId: string;
  repoId: string;
}

/**
 * Wire the command bridge onto an existing HTTP server. Does its own `upgrade`
 * handling for the `/ws/cmd` path so it coexists with /ws/pty and /ws/events on
 * the same port.
 */
export function setup(
  server: HttpServer,
  runner: CommandRunnerService,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parseUrl(req);
    if (pathname !== CMD_PATH) return;

    wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const addr = extractAddress(req);
    if (!addr) {
      ws.close(CLOSE_POLICY_VIOLATION, "missing taskId/repoId");
      return;
    }
    attach(ws, addr, runner);
  });

  return wss;
}

/**
 * Bridge a single connected socket to a repo's shell: ensure-before-attach,
 * replay-before-live, inbound input/resize, and exit forwarding. Exported for
 * direct use / testing.
 */
export function attach(
  ws: WebSocket,
  addr: CmdAddress,
  runner: CommandRunnerService,
): void {
  const { taskId, repoId } = addr;

  // Ensure the shell exists (spawn if needed) before subscribing/replaying, so a
  // first connection sees a live shell and its buffer captures from byte one. A
  // resolution failure (unknown task/repo) closes the socket cleanly.
  try {
    runner.ensureShell(taskId, repoId);
  } catch {
    ws.close(CLOSE_POLICY_VIOLATION, "unknown task/repo");
    return;
  }

  const { send, sendOutput } = createSender(ws);
  const emitExit = (exitCode: number | null): void => {
    const msg: CmdExitMsg = { type: "cmd:exit", exitCode };
    send(msg);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1000, "shell exited");
    }
  };

  // Replay-before-live: register the live listeners up front but hold their
  // output/exit in the gate until the replay buffer has been sent, then flush in
  // arrival order. See {@link ReplayGate}.
  const gate = new ReplayGate();
  const offData = runner.onData(taskId, repoId, (data) => {
    const live = gate.observeData(data);
    if (live !== null) sendOutput(live);
  });
  const offExit = runner.onExit(taskId, repoId, (exitCode) => {
    if (!gate.observeExit(exitCode)) emitExit(exitCode);
  });

  // Send the replay buffer, then flush any live chunks / exit that arrived while
  // the gate was closed, in order.
  const replay = runner.getReplay(taskId, repoId);
  if (replay.data.length > 0) sendOutput(replay.data);
  for (const chunk of gate.open()) sendOutput(chunk);
  const pendingExit = gate.pendingExit();
  if (pendingExit !== null) emitExit(pendingExit.exitCode);

  ws.on("message", (raw) => {
    applyInboundFrame(raw.toString(), addr, runner);
  });

  // Socket closed: detach listeners only. Deliberately do NOT kill the shell
  // so a dev server survives terminal disconnects / reconnects.
  const detach = (): void => {
    offData();
    offExit();
  };
  ws.on("close", detach);
  ws.on("error", detach);
}

/**
 * A socket's frame writers: `send` for any command frame (a no-op once the
 * socket has left OPEN) and `sendOutput` for a non-empty output chunk.
 */
function createSender(ws: WebSocket): {
  send: (msg: CmdMessage) => void;
  sendOutput: (data: string) => void;
} {
  const send = (msg: CmdMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  };
  const sendOutput = (data: string): void => {
    if (data.length === 0) return;
    const out: CmdOutputMsg = { type: "cmd:output", data };
    send(out);
  };
  return { send, sendOutput };
}

/**
 * Keeps the replayed buffer and the live stream ordered for one attach: while
 * CLOSED (before the replay has been sent) live output and an exit are BUFFERED;
 * {@link open} sends them in arrival order once the replay is out.
 *
 * The runner's replay is in-memory so there is no async gap, but buffering keeps
 * the ordering invariant identical to the pty bridge and robust to future async.
 */
class ReplayGate {
  private open_ = false;
  private readonly liveBuffer: string[] = [];
  private bufferedExit: { exitCode: number | null } | null = null;

  /** Account for one live output chunk: forward now, or buffer while closed. */
  observeData(data: string): string | null {
    if (!this.open_) {
      this.liveBuffer.push(data);
      return null;
    }
    return data;
  }

  /** Account for a shell exit. Returns true when it was buffered (still closed). */
  observeExit(exitCode: number | null): boolean {
    if (this.open_) return false;
    // First exit wins; a shell exits once, but guard against a stray second.
    this.bufferedExit ??= { exitCode };
    return true;
  }

  /** Open the gate and return the buffered live chunks to flush, in order. */
  open(): string[] {
    this.open_ = true;
    const flush = this.liveBuffer.slice();
    this.liveBuffer.length = 0;
    return flush;
  }

  /** The exit buffered while closed, if any (flush it after {@link open}). */
  pendingExit(): { exitCode: number | null } | null {
    return this.bufferedExit;
  }
}

/**
 * Apply one client → server frame to the repo's shell: keystrokes (`cmd:input`)
 * and terminal geometry (`cmd:resize`). Malformed JSON, a non-string payload
 * and a non-finite/non-positive geometry are all ignored rather than thrown — a
 * bad frame must never tear down a live shell. `cmd:output` / `cmd:exit` are
 * server-originated and ignored if echoed back.
 */
function applyInboundFrame(
  raw: string,
  addr: CmdAddress,
  runner: CommandRunnerService,
): void {
  const { taskId, repoId } = addr;
  let msg: CmdMessage;
  try {
    msg = JSON.parse(raw) as CmdMessage;
  } catch {
    return; // ignore malformed frames
  }
  switch (msg.type) {
    case "cmd:input":
      if (typeof msg.data === "string") {
        runner.write(taskId, repoId, msg.data);
      }
      break;
    case "cmd:resize":
      if (
        Number.isFinite(msg.cols) &&
        Number.isFinite(msg.rows) &&
        msg.cols > 0 &&
        msg.rows > 0
      ) {
        runner.resize(taskId, repoId, msg.cols, msg.rows);
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
 * Resolve the shell address from the `?taskId=&repoId=` query params. Returns
 * null when either is missing.
 */
function extractAddress(req: IncomingMessage): CmdAddress | null {
  const url = parseUrl(req);
  const taskId = url.searchParams.get("taskId");
  const repoId = url.searchParams.get("repoId");
  if (!taskId || !repoId) return null;
  return { taskId, repoId };
}
