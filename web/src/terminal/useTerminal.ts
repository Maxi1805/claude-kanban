/**
 * useTerminal — wires an @xterm/xterm Terminal to a task's backend PTY over a
 * WebSocket.
 *
 * This is a thin client over `useReconnectingSocket` (the shared xterm+socket
 * engine): it only supplies this channel's WIRE PROTOCOL and URL. Given a
 * `taskId` and a container element ref it:
 *   • opens a WebSocket to /ws/pty?taskId=<id> (relative; proxied by Vite),
 *   • pipes server PtyOutputMsg frames → the screen and term keystrokes →
 *     PtyInputMsg frames over the socket (resize → PtyResizeMsg),
 *   • reconnects with a small capped backoff if the socket drops — except once
 *     the pty process exits, after which it stays closed,
 *   • tears everything down on unmount.
 */
import { ref, type Ref } from "vue";
import type { PtyInputMsg, PtyMessage, PtyResizeMsg } from "@shared/types";
import { useReconnectingSocket, type TerminalIO } from "./useReconnectingSocket";

/** Connection state surfaced to the view for status display. */
export type TerminalConnectionStatus =
  | "connecting"
  | "open"
  | "closed"
  | "exited";

export interface UseTerminalResult {
  /** Reactive connection status. */
  status: Ref<TerminalConnectionStatus>;
  /** Exit code, populated once the pty process exits. */
  exitCode: Ref<number | null>;
}

/** Build the relative ws URL for a task's pty channel (Vite proxies /ws). */
function ptyWsUrl(taskId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/pty?taskId=${encodeURIComponent(
    taskId,
  )}`;
}

export function useTerminal(
  taskId: string,
  container: Ref<HTMLElement | null>,
): UseTerminalResult {
  const status = ref<TerminalConnectionStatus>("connecting");
  const exitCode = ref<number | null>(null);

  function handleMessage(raw: string, io: TerminalIO): void {
    let msg: PtyMessage;
    try {
      msg = JSON.parse(raw) as PtyMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "pty:output":
        io.write(msg.data);
        break;
      case "pty:exit":
        exitCode.value = msg.exitCode;
        status.value = "exited";
        io.write(
          `\r\n\x1b[33m[process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
        );
        break;
      default:
        break;
    }
  }

  useReconnectingSocket({
    container,
    terminalOptions: {
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
    },
    url: () => ptyWsUrl(taskId),
    buildInputFrame: (data): PtyInputMsg => ({
      type: "pty:input",
      taskId,
      data,
    }),
    buildResizeFrame: (cols, rows): PtyResizeMsg => ({
      type: "pty:resize",
      taskId,
      cols,
      rows,
    }),
    onMessage: handleMessage,
    onConnecting: () => {
      status.value = "connecting";
    },
    onOpen: () => {
      status.value = "open";
    },
    onClose: () => {
      // Once the pty has exited, a socket close is terminal — don't reconnect.
      if (status.value === "exited") return false;
      status.value = "closed";
      return true;
    },
  });

  return { status, exitCode };
}
