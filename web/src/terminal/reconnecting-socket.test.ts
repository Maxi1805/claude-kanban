/**
 * CHARACTERIZATION TEST for the two terminal composables (Ola BG / BG1).
 *
 * These composables wire an xterm Terminal to a backend WebSocket that
 * reconnects with capped backoff. They touch the user's LIVE terminals and had
 * NO tests, so this locks their OBSERVABLE behaviour before the
 * `useReconnectingSocket` extraction: the initial frame sent on open, incoming
 * frames reaching the terminal / reactive state, capped-backoff reconnect, that
 * unmount closes the socket WITHOUT reconnecting, and that a resize refits and
 * emits a resize frame. The refactor must keep every assertion here green.
 *
 * There is no jsdom in this project, so instead of a real DOM we replace the
 * Vue lifecycle hooks (to run onMounted/onBeforeUnmount by hand), the xterm
 * modules, and the DOM globals (WebSocket / window / location / ResizeObserver)
 * with fakes. The composables are exercised only through their public API.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ref } from "vue";

/* ── Capture Vue's mount/unmount callbacks so the test can fire them. ──────── */
const hooks = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  unmount: [] as Array<() => void>,
}));
vi.mock("vue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue")>();
  return {
    ...actual,
    onMounted: (fn: () => void) => {
      hooks.mounted.push(fn);
    },
    onBeforeUnmount: (fn: () => void) => {
      hooks.unmount.push(fn);
    },
  };
});

/* ── Fake xterm Terminal + FitAddon. ──────────────────────────────────────── */
const xtermState = vi.hoisted(() => ({ instances: [] as FakeTerminalShape[] }));
interface FakeTerminalShape {
  cols: number;
  rows: number;
  written: string[];
  focusCount: number;
  resetCount: number;
  disposed: boolean;
  dataHandler: ((d: string) => void) | null;
}
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    written: string[] = [];
    focusCount = 0;
    resetCount = 0;
    disposed = false;
    dataHandler: ((d: string) => void) | null = null;
    constructor(public opts: unknown) {
      xtermState.instances.push(this as unknown as FakeTerminalShape);
    }
    loadAddon(): void {}
    open(): void {}
    onData(fn: (d: string) => void): void {
      this.dataHandler = fn;
    }
    write(d: string): void {
      this.written.push(d);
    }
    focus(): void {
      this.focusCount++;
    }
    reset(): void {
      this.resetCount++;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { Terminal };
});
const fitState = vi.hoisted(() => ({ fitCount: 0 }));
vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit(): void {
      fitState.fitCount++;
    }
  }
  return { FitAddon };
});

// Imported AFTER the mocks above are registered.
import { useCommandTerminal } from "./useCommandTerminal";
import { useTerminal } from "./useTerminal";

/* ── Fake DOM globals. ────────────────────────────────────────────────────── */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
  /* test helpers */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
  simulateDrop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const winListeners: Record<string, Array<() => void>> = {};
let lastRO: FakeResizeObserver | null = null;
class FakeResizeObserver {
  cb: () => void;
  observed: unknown[] = [];
  disconnected = false;
  constructor(cb: () => void) {
    this.cb = cb;
    lastRO = this;
  }
  observe(el: unknown): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

function lastWs(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket created");
  return ws;
}
function lastTerm(): FakeTerminalShape {
  const t = xtermState.instances.at(-1);
  if (!t) throw new Error("no Terminal created");
  return t;
}
function fireResize(): void {
  for (const fn of winListeners.resize ?? []) fn();
}

beforeEach(() => {
  vi.useFakeTimers();
  hooks.mounted = [];
  hooks.unmount = [];
  xtermState.instances = [];
  fitState.fitCount = 0;
  FakeWebSocket.instances = [];
  for (const k of Object.keys(winListeners)) delete winListeners[k];
  lastRO = null;

  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: () => void) => {
      (winListeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      const a = winListeners[type];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A container element stub — only needs event-listener methods. */
function fakeContainer(): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
}

function runMounted(): void {
  for (const fn of hooks.mounted) fn();
}
function runUnmount(): void {
  for (const fn of hooks.unmount) fn();
}

/* ══════════════════════════════════════════════════════════════════════════
 * useCommandTerminal — /ws/cmd channel
 * ════════════════════════════════════════════════════════════════════════ */
describe("useCommandTerminal (characterization)", () => {
  function mount(repoId = "repo-1") {
    const rid = ref<string | null>(repoId);
    const container = ref<HTMLElement | null>(fakeContainer());
    const result = useCommandTerminal("task-1", rid, container);
    runMounted();
    return { result, rid, container };
  }

  it("opens the cmd socket with taskId+repoId and no kind", () => {
    mount("repo-9");
    expect(lastWs().url).toBe(
      "ws://localhost:5173/ws/cmd?taskId=task-1&repoId=repo-9",
    );
  });

  it("stays idle (no socket) until a repo is selected", () => {
    const rid = ref<string | null>(null);
    const container = ref<HTMLElement | null>(fakeContainer());
    const r = useCommandTerminal("task-1", rid, container);
    runMounted();
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(r.status.value).toBe("connecting");
  });

  it("sends the initial resize frame and focuses on open", () => {
    const { result } = mount();
    const ws = lastWs();
    expect(ws.sent).toEqual([]); // nothing sent before OPEN
    ws.simulateOpen();
    expect(result.status.value).toBe("open");
    expect(ws.frames()).toEqual([
      { type: "cmd:resize", cols: 80, rows: 24 },
    ]);
    expect(lastTerm().focusCount).toBeGreaterThan(0);
  });

  it("writes incoming cmd:output to the terminal", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "cmd:output", data: "hello" }));
    expect(lastTerm().written).toContain("hello");
  });

  it("surfaces cmd:exit as a reactive exit code", () => {
    const { result } = mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "cmd:exit", exitCode: 3 }));
    expect(result.exitCode.value).toBe(3);
    expect(lastTerm().written.join("")).toContain("shell exited");
  });

  it("pipes keystrokes as cmd:input frames when open", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.sent.length = 0;
    lastTerm().dataHandler?.("ls\n");
    expect(ws.frames()).toEqual([{ type: "cmd:input", data: "ls\n" }]);
  });

  it("refits and emits a resize frame on window resize", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.sent.length = 0;
    const before = fitState.fitCount;
    fireResize();
    expect(fitState.fitCount).toBeGreaterThan(before);
    expect(ws.frames()).toEqual([{ type: "cmd:resize", cols: 80, rows: 24 }]);
  });

  it("refits and emits a resize frame on container resize", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.sent.length = 0;
    lastRO?.cb();
    expect(ws.frames()).toEqual([{ type: "cmd:resize", cols: 80, rows: 24 }]);
  });

  it("reconnects with capped exponential backoff after a drop", () => {
    const { result } = mount();
    const ws1 = lastWs();
    ws1.simulateOpen();
    ws1.simulateDrop();
    expect(result.status.value).toBe("closed");

    // 500ms: first retry.
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);

    // Next delay doubled to 1000ms.
    lastWs().simulateDrop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);

    // 2000ms.
    lastWs().simulateDrop();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBe(4);

    // 4000ms.
    lastWs().simulateDrop();
    vi.advanceTimersByTime(4000);
    expect(FakeWebSocket.instances.length).toBe(5);

    // Capped at 5000ms from here on.
    lastWs().simulateDrop();
    vi.advanceTimersByTime(4999);
    expect(FakeWebSocket.instances.length).toBe(5);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(6);

    lastWs().simulateDrop();
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances.length).toBe(7);
  });

  it("resets backoff to the minimum after a successful reopen", () => {
    mount();
    lastWs().simulateOpen();
    lastWs().simulateDrop();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances.length).toBe(2);
    // Reopen resets the delay; the next drop retries after 500ms again.
    lastWs().simulateOpen();
    lastWs().simulateDrop();
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it("closes the socket and does NOT reconnect on unmount", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    runUnmount();
    expect(ws.closed).toBe(true);
    expect(lastTerm().disposed).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("cancels a pending reconnect on unmount", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.simulateDrop(); // schedules a reconnect timer
    runUnmount();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("reconnect() resets the screen and opens a fresh socket", () => {
    const { result } = mount();
    const ws1 = lastWs();
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({ type: "cmd:exit", exitCode: 1 }));
    expect(result.exitCode.value).toBe(1);

    result.reconnect();
    expect(lastTerm().resetCount).toBeGreaterThan(0);
    expect(result.exitCode.value).toBe(null);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(ws1.closed).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * useTerminal — /ws/pty channel
 * ════════════════════════════════════════════════════════════════════════ */
describe("useTerminal (characterization)", () => {
  function mount(taskId = "task-1") {
    const container = ref<HTMLElement | null>(fakeContainer());
    const result = useTerminal(taskId, container);
    runMounted();
    return { result, container };
  }

  it("opens the pty socket with the task id", () => {
    mount("task-42");
    expect(lastWs().url).toBe("ws://localhost:5173/ws/pty?taskId=task-42");
  });

  it("sends the initial pty:resize frame and focuses on open", () => {
    const { result } = mount();
    const ws = lastWs();
    expect(ws.sent).toEqual([]);
    ws.simulateOpen();
    expect(result.status.value).toBe("open");
    expect(ws.frames()).toEqual([
      { type: "pty:resize", taskId: "task-1", cols: 80, rows: 24 },
    ]);
    expect(lastTerm().focusCount).toBeGreaterThan(0);
  });

  it("writes incoming pty:output to the terminal", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.simulateMessage(
      JSON.stringify({ type: "pty:output", taskId: "task-1", data: "out" }),
    );
    expect(lastTerm().written).toContain("out");
  });

  it("pipes keystrokes as pty:input frames when open", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.sent.length = 0;
    lastTerm().dataHandler?.("x");
    expect(ws.frames()).toEqual([
      { type: "pty:input", taskId: "task-1", data: "x" },
    ]);
  });

  it("refits and emits a resize frame on window resize", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.sent.length = 0;
    fireResize();
    expect(ws.frames()).toEqual([
      { type: "pty:resize", taskId: "task-1", cols: 80, rows: 24 },
    ]);
  });

  it("marks status exited on pty:exit and stops reconnecting", () => {
    const { result } = mount();
    const ws = lastWs();
    ws.simulateOpen();
    ws.simulateMessage(
      JSON.stringify({
        type: "pty:exit",
        taskId: "task-1",
        exitCode: 0,
        signal: null,
      }),
    );
    expect(result.status.value).toBe("exited");
    expect(result.exitCode.value).toBe(0);
    // A close after exit must NOT schedule a reconnect.
    ws.simulateDrop();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(result.status.value).toBe("exited");
  });

  it("reconnects with capped exponential backoff after a drop", () => {
    const { result } = mount();
    const ws1 = lastWs();
    ws1.simulateOpen();
    ws1.simulateDrop();
    expect(result.status.value).toBe("closed");

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);

    lastWs().simulateDrop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);

    lastWs().simulateDrop();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBe(4);

    lastWs().simulateDrop();
    vi.advanceTimersByTime(4000);
    expect(FakeWebSocket.instances.length).toBe(5);

    // Capped at 5000ms.
    lastWs().simulateDrop();
    vi.advanceTimersByTime(4999);
    expect(FakeWebSocket.instances.length).toBe(5);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(6);
  });

  it("closes the socket and does NOT reconnect on unmount", () => {
    mount();
    const ws = lastWs();
    ws.simulateOpen();
    runUnmount();
    expect(ws.closed).toBe(true);
    expect(lastTerm().disposed).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});
