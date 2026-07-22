/**
 * Board events hub.
 *
 * A tiny broadcaster for the `/ws/events` channel. Clients (the board UI)
 * connect to receive server-originated `board:event` frames; services and the
 * task lifecycle call `broadcast` to push project/task mutations to every
 * connected client. This channel is one-directional (server → client); inbound
 * frames are ignored.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { BoardEventMsg } from "../../shared/types.js";

/** Path this hub owns. */
const EVENTS_PATH = "/ws/events";

/** Broadcasts board events to all connected event-channel clients. */
export class EventsHub {
  private readonly clients = new Set<WebSocket>();
  private wss: WebSocketServer | null = null;

  /**
   * Wire the events hub onto an existing HTTP server. Claims the `/ws/events`
   * path during the upgrade handshake so it coexists with the pty channel.
   */
  attach(server: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on("upgrade", (req, socket, head) => {
      const { pathname } = new URL(req.url ?? "", "http://localhost");
      if (pathname !== EVENTS_PATH) return;

      wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
      this.clients.add(ws);
      const drop = (): void => {
        this.clients.delete(ws);
      };
      ws.on("close", drop);
      ws.on("error", drop);
      // This channel is server → client only; ignore any inbound frames.
    });

    return wss;
  }

  /** Broadcast a board event to every connected client. */
  broadcast(event: BoardEventMsg): void {
    const frame = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(frame);
      }
    }
  }

  /** Number of currently connected event clients (diagnostics). */
  get clientCount(): number {
    return this.clients.size;
  }
}

/** Factory used by the server bootstrap. */
export const createEventsHub = (): EventsHub => new EventsHub();
