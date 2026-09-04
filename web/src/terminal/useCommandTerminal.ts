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
 * This is a thin client over `useReconnectingSocket` (the shared xterm+socket
 * engine): it only supplies this channel's WIRE PROTOCOL and URL. Given a
 * `taskId`, a reactive `repoId` ref and a container element ref it:
 *   • opens a WebSocket to /ws/cmd?taskId=&repoId= (NO kind; relative, proxied
 *     by Vite). On connect the server ensures+REPLAYS the shell's buffer, then
 *     streams live — so re-entering the panel shows the shell's history,
 *   • pipes server cmd:output frames → the screen and EVERY keystroke/paste →
 *     cmd:input frames over the socket (resize → cmd:resize),
 *   • FOCUSES the terminal on mount, on every (re)connect, and on container
 *     click, so the user can immediately type,
 *   • reconnects with a small capped backoff if the socket drops,
 *   • surfaces a one-off cmd:exit (shell killed) as a reactive exit code,
 *   • re-targets to a new repo via reconnect() when the repoId ref changes,
 *   • tears everything down on unmount.
 */
import { ref, type Ref } from "vue";
import { useReconnectingSocket, type TerminalIO } from "./useReconnectingSocket";

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

  function handleMessage(raw: string, io: TerminalIO): void {
    let msg: CmdServerFrame;
    try {
      msg = JSON.parse(raw) as CmdServerFrame;
    } catch {
      return;
    }
    switch (msg.type) {
      case "cmd:output":
        io.write(msg.data);
        break;
      case "cmd:exit":
        exitCode.value = msg.exitCode;
        io.write(
          `\r\n\x1b[33m[shell exited${
            msg.exitCode === null ? "" : ` with code ${msg.exitCode}`
          }]\x1b[0m\r\n`,
        );
        break;
      default:
        break;
    }
  }

  const sock = useReconnectingSocket({
    container,
    terminalOptions: {
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      fontSize: 12.5,
      scrollback: 10000,
      theme: { background: "#161616", foreground: "#d4d4d4" },
    },
    // No repo selected yet → null keeps the socket idle until reconnect() runs.
    url: () => {
      const rid = repoId.value;
      return rid ? cmdWsUrl(taskId, rid) : null;
    },
    buildInputFrame: (data): CmdInputFrame => ({ type: "cmd:input", data }),
    buildResizeFrame: (cols, rows): CmdResizeFrame => ({
      type: "cmd:resize",
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
      status.value = "closed";
      return true;
    },
    focusOnContainerClick: true,
  });

  /**
   * Re-target the terminal to the current `repoId` ref: clears the exit code and
   * the screen, drops the current socket, and reconnects to that repo's shell
   * channel (which ensures+replays its buffer).
   */
  function reconnect(): void {
    exitCode.value = null;
    sock.reconnect();
  }

  return { status, exitCode, focus: sock.focus, reconnect };
}
