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

  const send = (msg: CmdMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  const sendOutput = (data: string): void => {
    if (data.length === 0) return;
    const out: CmdOutputMsg = { type: "cmd:output", data };
    send(out);
  };

  // Replay-before-live: register the live listener up front but BUFFER its chunks
  // until the (synchronous) replay buffer has been sent, then flush in order. The
  // runner's replay is in-memory so there is no async gap, but buffering keeps
  // the ordering invariant identical to the pty bridge and robust to future async.
  let replayDone = false;
  const liveBuffer: string[] = [];

  const offData = runner.onData(taskId, repoId, (data) => {
    if (!replayDone) {
      liveBuffer.push(data);
      return;
    }
    sendOutput(data);
  });

  const emitExit = (exitCode: number | null): void => {
    const msg: CmdExitMsg = { type: "cmd:exit", exitCode };
    send(msg);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1000, "shell exited");
    }
  };

  const bufferedExit: { exitCode: number | null }[] = [];
  const offExit = runner.onExit(taskId, repoId, (exitCode) => {
    if (!replayDone) {
      bufferedExit.push({ exitCode });
      return;
    }
    emitExit(exitCode);
  });

  // Send the replay buffer, then flush any live chunks that arrived meanwhile.
  const replay = runner.getReplay(taskId, repoId);
  if (replay.data.length > 0) sendOutput(replay.data);
  replayDone = true;
  for (const chunk of liveBuffer) sendOutput(chunk);
  liveBuffer.length = 0;
  if (bufferedExit.length > 0) emitExit(bufferedExit[0].exitCode);

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
