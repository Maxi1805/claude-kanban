/**
 * useReconnectingSocket — an @xterm/xterm Terminal cabled to a backend
 * WebSocket that reconnects with a small capped backoff.
 *
 * This is the shared engine behind `useTerminal` (the task pty on /ws/pty) and
 * `useCommandTerminal` (the repo shell on /ws/cmd). Those two composables were
 * almost the same file — same Terminal+FitAddon setup, same fit/resize/focus
 * wiring, same backoff reconnect, same teardown — differing only in their WIRE
 * PROTOCOL (which frames go over the socket) and their URL. That difference is
 * exactly what this composable takes as parameters; everything else lives here
 * once.
 *
 * The composable owns the Terminal, the FitAddon, the socket, the reconnect
 * timer, and the window/container resize listeners, and tears them all down on
 * unmount. The caller supplies:
 *   • `url()`            — the ws URL to open, or null to stay idle (no repo yet),
 *   • `terminalOptions`  — xterm construction options (font, theme, …),
 *   • `buildInputFrame`  — wrap a keystroke/paste as the client input frame,
 *   • `buildResizeFrame` — wrap the current cols/rows as the client resize frame,
 *   • `onMessage`        — decode an incoming frame (and `write` to the screen),
 *   • `onConnecting`/`onOpen`/`onClose` — surface connection state; `onClose`
 *     returns whether to schedule a reconnect (the pty channel stops after exit),
 *   • `focusOnContainerClick` — keep focus on the terminal when its box is clicked.
 */
import { onBeforeUnmount, onMounted, type Ref } from "vue";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

/** A minimal write sink handed to `onMessage` so it never sees the Terminal. */
export interface TerminalIO {
  write(data: string): void;
}

export interface ReconnectingSocketOptions {
  /** The container element the terminal is opened into. */
  container: Ref<HTMLElement | null>;
  /** xterm construction options (font, theme, scrollback, …). */
  terminalOptions: ITerminalOptions;
  /** The ws URL to open now, or null to stay idle until `reconnect()`. */
  url: () => string | null;
  /** Wrap a local keystroke/paste as the channel's client input frame. */
  buildInputFrame: (data: string) => unknown;
  /** Wrap the current terminal size as the channel's client resize frame. */
  buildResizeFrame: (cols: number, rows: number) => unknown;
  /** Decode one incoming raw frame, writing any output via `io.write`. */
  onMessage: (raw: string, io: TerminalIO) => void;
  /** Called when a (re)connection attempt starts (surface "connecting"). */
  onConnecting: () => void;
  /** Called once the socket opens, after the size resync + focus. */
  onOpen: () => void;
  /** Called when the socket closes; return true to schedule a reconnect. */
  onClose: () => boolean;
  /** When true, clicking anywhere in the container refocuses the terminal. */
  focusOnContainerClick?: boolean;
}

export interface ReconnectingSocketResult {
  /** Send a typed client frame if the socket is currently open. */
  send(msg: unknown): void;
  /** Move keyboard focus into the terminal. */
  focus(): void;
  /**
   * Reset the screen, drop the current socket, reset the backoff and reconnect
   * to `url()` now (e.g. after the URL's inputs changed). Callers that keep
   * per-channel state (like an exit code) should clear it before calling this.
   */
  reconnect(): void;
}

export function useReconnectingSocket(
  options: ReconnectingSocketOptions,
): ReconnectingSocketResult {
  const {
    container,
    terminalOptions,
    url,
    buildInputFrame,
    buildResizeFrame,
    onMessage,
    onConnecting,
    onOpen,
    onClose,
    focusOnContainerClick = false,
  } = options;

  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let socket: WebSocket | null = null;

  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let resizeObserver: ResizeObserver | null = null;

  const io: TerminalIO = {
    write(data: string): void {
      term?.write(data);
    },
  };

  /** Send a typed frame if the socket is open. */
  function send(msg: unknown): void {
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
    send(buildResizeFrame(term.cols, term.rows));
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

  /** Close the current socket without triggering a reconnect. */
  function closeSocket(): void {
    if (!socket) return;
    const s = socket;
    socket = null;
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
    try {
      s.close();
    } catch {
      // ignore
    }
  }

  function connect(): void {
    if (disposed) return;
    onConnecting();

    const target = url();
    // No target yet (e.g. no repo selected) — stay idle until reconnect() runs.
    if (target === null) return;

    const ws = new WebSocket(target);
    socket = ws;

    ws.onopen = () => {
      if (disposed) {
        ws.close();
        return;
      }
      reconnectDelay = RECONNECT_MIN_MS;
      onOpen();
      // Re-sync the backend pty size to the current terminal dimensions, then
      // focus so the user can keep typing after navigating away and back
      // without having to click the terminal again.
      fit();
      term?.focus();
    };

    ws.onmessage = (ev) => {
      onMessage(typeof ev.data === "string" ? ev.data : String(ev.data), io);
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (disposed) return;
      if (onClose()) scheduleReconnect();
    };

    ws.onerror = () => {
      // Surface as a close; the onclose handler drives reconnection.
      ws.close();
    };
  }

  function reconnect(): void {
    if (disposed) return;
    clearReconnectTimer();
    closeSocket();
    term?.reset();
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
  }

  function focus(): void {
    term?.focus();
  }

  function onContainerMouseDown(): void {
    term?.focus();
  }

  onMounted(() => {
    const el = container.value;
    if (!el) return;

    term = new Terminal(terminalOptions);
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Pipe EVERY local keystroke/paste to the backend as an input frame.
    term.onData((data) => {
      send(buildInputFrame(data));
    });

    fit();
    // Focus on mount so keystrokes reach the backend immediately — without this
    // the xterm holds no keyboard focus until it's clicked, so you appear
    // unable to type until you click the terminal first.
    term.focus();
    if (focusOnContainerClick) {
      el.addEventListener("mousedown", onContainerMouseDown);
    }
    window.addEventListener("resize", onWindowResize);
    // Also refit on CONTAINER size changes: collapsing/expanding a sidebar
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
    if (focusOnContainerClick) {
      container.value?.removeEventListener("mousedown", onContainerMouseDown);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    closeSocket();

    fitAddon = null;
    if (term) {
      term.dispose();
      term = null;
    }
  });

  return { send, focus, reconnect };
}
