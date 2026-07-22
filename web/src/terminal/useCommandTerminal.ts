/**
 * useCommandTerminal — wires an @xterm/xterm Terminal to a repo's persistent
 * SHELL pty over the `/ws/cmd` channel (the bottom command panel).
 *
 * In the SHELL MODEL a command terminal is a REAL interactive shell, one per
 * (taskId, repoId). The user TYPES into it; the Setup/Run/Teardown buttons just
 * inject scripts into this same shell (server-side), so their output appears
 * inline. There is no per-kind pty and no running/exit toggle — the shell only
 * exits when killed (teardown), surfaced as a one-off cmd:exit.
 *
 * Given a `taskId`, a reactive `repoId` ref and a container element ref, this
 * composable:
 *   • creates a Terminal + FitAddon, opens it into the container, fits it on
 *     mount / window resize / container resize (emitting cmd:resize),
 *   • opens a WebSocket to /ws/cmd?taskId=&repoId= (NO kind; relative, proxied
 *     by Vite). On connect the server ensures+REPLAYS the shell's buffer, then
 *     streams live — so re-entering the panel shows the shell's history,
 *   • pipes server cmd:output frames → term.write and EVERY keystroke/paste →
 *     cmd:input frames over the socket (real interactive typing),
 *   • FOCUSES the terminal on mount, on every (re)connect, and on container
 *     click, so the user can immediately type (mirrors useTerminal's fix),
 *   • reconnects with a small capped backoff if the socket drops,
 *   • surfaces a one-off cmd:exit (shell killed) as a reactive exit code,
 *   • re-targets to a new repo via reconnect() when the repoId ref changes,
 *   • tears everything down on unmount.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** Connection state surfaced to the panel for status display. */
export type CommandTerminalStatus = "connecting" | "open" | "closed";

export interface UseCommandTerminalResult {
  /** Reactive socket connection status. */
  status: Ref<CommandTerminalStatus>;
  /** Last exit code seen on this channel; null until the shell is killed. */
  exitCode: Ref<number | null>;
  /** Move keyboard focus into the terminal (so keystrokes reach the shell). */
  focus(): void;
  /**
   * Re-target the terminal to the current `repoId` ref: clears the screen and
   * reconnects so the newly selected repo shell's buffer is replayed. Call this
   * after changing the repoId ref (e.g. switching the repo tab).
   */
  reconnect(): void;
}

/* ── Wire frames for the /ws/cmd channel (see SHARED CONTRACT). ────────────── */
interface CmdOutputFrame {
  type: "cmd:output";
  data: string;
}
interface CmdExitFrame {
  type: "cmd:exit";
  exitCode: number | null;
}
type CmdServerFrame = CmdOutputFrame | CmdExitFrame;

interface CmdInputFrame {
  type: "cmd:input";
  data: string;
}
interface CmdResizeFrame {
  type: "cmd:resize";
  cols: number;
  rows: number;
}
type CmdClientFrame = CmdInputFrame | CmdResizeFrame;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

/** Build the relative ws URL for a repo shell channel (Vite proxies /ws). */
function cmdWsUrl(taskId: string, repoId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const qs = new URLSearchParams({ taskId, repoId });
  return `${proto}://${location.host}/ws/cmd?${qs.toString()}`;
}

export function useCommandTerminal(
  taskId: string,
  repoId: Ref<string | null>,
  container: Ref<HTMLElement | null>,
): UseCommandTerminalResult {
  const status = ref<CommandTerminalStatus>("connecting");
  const exitCode = ref<number | null>(null);

  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let socket: WebSocket | null = null;

  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let resizeObserver: ResizeObserver | null = null;

  /** Send a typed cmd frame if the socket is open. */
  function send(msg: CmdClientFrame): void {
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
    send({ type: "cmd:resize", cols: term.cols, rows: term.rows });
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
    let msg: CmdServerFrame;
    try {
      msg = JSON.parse(raw) as CmdServerFrame;
    } catch {
      return;
    }
    switch (msg.type) {
      case "cmd:output":
        term?.write(msg.data);
        break;
      case "cmd:exit":
        exitCode.value = msg.exitCode;
        term?.write(
          `\r\n\x1b[33m[shell exited${
            msg.exitCode === null ? "" : ` with code ${msg.exitCode}`
          }]\x1b[0m\r\n`,
        );
        break;
      default:
        break;
    }
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
    const rid = repoId.value;
    // No repo selected yet — stay idle until reconnect() runs with a target.
    if (!rid) {
      status.value = "connecting";
      return;
    }
    status.value = "connecting";

    const ws = new WebSocket(cmdWsUrl(taskId, rid));
    socket = ws;

    ws.onopen = () => {
      if (disposed) {
        ws.close();
        return;
      }
      status.value = "open";
      reconnectDelay = RECONNECT_MIN_MS;
      // Re-sync backend pty size to the current terminal dimensions, then focus
      // so the user can keep typing after navigating away and back without
      // having to click the terminal again.
      fit();
      term?.focus();
    };

    ws.onmessage = (ev) => {
      handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (disposed) return;
      status.value = "closed";
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  /**
   * Re-target the terminal to the current `repoId` ref: clears the screen,
   * drops the current socket, and reconnects to that repo's shell channel
   * (which ensures+replays its buffer).
   */
  function reconnect(): void {
    if (disposed) return;
    clearReconnectTimer();
    closeSocket();
    exitCode.value = null;
    term?.reset();
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
  }

  function focus(): void {
    term?.focus();
  }

  onMounted(() => {
    const el = container.value;
    if (!el) return;

    term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      fontSize: 12.5,
      scrollback: 10000,
      theme: { background: "#161616", foreground: "#d4d4d4" },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Pipe EVERY local keystroke/paste to the repo shell pty.
    term.onData((data) => {
      send({ type: "cmd:input", data });
    });

    fit();
    // Focus the terminal on mount so keystrokes reach the shell immediately —
    // without this the xterm holds no keyboard focus until clicked, so you
    // appear unable to type until you click the terminal first.
    term.focus();
    // Clicking anywhere in the container keeps focus on the terminal (so typing
    // continues right after clicking the terminal or a panel button).
    el.addEventListener("mousedown", onContainerMouseDown);
    window.addEventListener("resize", onWindowResize);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => fit());
      resizeObserver.observe(el);
    }

    connect();
  });

  function onContainerMouseDown(): void {
    term?.focus();
  }

  onBeforeUnmount(() => {
    disposed = true;
    clearReconnectTimer();
    window.removeEventListener("resize", onWindowResize);
    container.value?.removeEventListener("mousedown", onContainerMouseDown);
    resizeObserver?.disconnect();
    resizeObserver = null;
    closeSocket();

    fitAddon = null;
    if (term) {
      term.dispose();
      term = null;
    }
  });

  return { status, exitCode, focus, reconnect };
}
