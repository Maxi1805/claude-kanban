/**
 * useTerminal — wires an @xterm/xterm Terminal to a task's backend PTY over a
 * WebSocket.
 *
 * Given a `taskId` and a container element ref, this composable:
 *   • creates a Terminal + FitAddon, opens it into the container, fits it on
 *     mount and on window resize (emitting PtyResizeMsg),
 *   • opens a WebSocket to /ws/pty?taskId=<id> (relative; proxied by Vite),
 *   • pipes server PtyOutputMsg frames → term.write and term keystrokes →
 *     PtyInputMsg frames over the socket,
 *   • reconnects with a small capped backoff if the socket drops,
 *   • tears everything down on unmount.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  PtyInputMsg,
  PtyMessage,
  PtyResizeMsg,
} from "@shared/types";

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

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

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

  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let socket: WebSocket | null = null;

  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Refits the terminal when its CONTAINER resizes (e.g. the conversations
   * sidebar collapses/expands beside it) — a window 'resize' alone misses that. */
  let resizeObserver: ResizeObserver | null = null;

  /** Send a typed pty frame if the socket is open. */
  function send(msg: PtyInputMsg | PtyResizeMsg): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  /** Fit the terminal to its container and notify the backend of the new size. */
  function fit(): void {
    if (!term || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch {
      // Container not measurable yet (e.g. display:none); ignore.
      return;
    }
    send({ type: "pty:resize", taskId, cols: term.cols, rows: term.rows });
  }

  function onWindowResize(): void {
    fit();
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (disposed) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function handleMessage(raw: string): void {
    let msg: PtyMessage;
    try {
      msg = JSON.parse(raw) as PtyMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "pty:output":
        term?.write(msg.data);
        break;
      case "pty:exit":
        exitCode.value = msg.exitCode;
        status.value = "exited";
        term?.write(
          `\r\n\x1b[33m[process exited with code ${msg.exitCode}]\x1b[0m\r\n`,
        );
        break;
      default:
        break;
    }
  }

  function connect(): void {
    if (disposed) return;
    status.value = "connecting";

    const ws = new WebSocket(ptyWsUrl(taskId));
    socket = ws;

    ws.onopen = () => {
      if (disposed) {
        ws.close();
        return;
      }
      status.value = "open";
      reconnectDelay = RECONNECT_MIN_MS;
      // Re-sync the backend pty size to the current terminal dimensions.
      fit();
      // Re-focus on (re)connect so the user can keep typing after navigating
      // away and back without having to click the terminal again.
      term?.focus();
    };

    ws.onmessage = (ev) => {
      handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (disposed || status.value === "exited") return;
      status.value = "closed";
      scheduleReconnect();
    };

    ws.onerror = () => {
      // Surface as a close; the onclose handler drives reconnection.
      ws.close();
    };
  }

  onMounted(() => {
    const el = container.value;
    if (!el) return;

    term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Pipe local keystrokes/paste to the backend pty.
    term.onData((data) => {
      send({ type: "pty:input", taskId, data });
    });

    fit();
    // Focus the terminal on mount so keystrokes go to the pty immediately.
    // Without this the xterm holds no keyboard focus until it's clicked, so on
    // entering (or returning to) a task you appear unable to type until you
    // click the terminal first.
    term.focus();
    window.addEventListener("resize", onWindowResize);
    // Also refit on CONTAINER size changes: collapsing/expanding the sidebar
    // changes our width without firing a window 'resize'. Guarded for old envs.
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => fit());
      resizeObserver.observe(el);
    }

    connect();
  });

  onBeforeUnmount(() => {
    disposed = true;
    clearReconnectTimer();
    window.removeEventListener("resize", onWindowResize);
    resizeObserver?.disconnect();
    resizeObserver = null;

    if (socket) {
      // Drop handlers so the close doesn't trigger a reconnect.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
      socket = null;
    }

    fitAddon = null;
    if (term) {
      term.dispose();
      term = null;
    }
  });

  return { status, exitCode };
}
