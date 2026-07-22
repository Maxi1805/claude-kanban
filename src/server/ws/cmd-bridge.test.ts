/**
 * Command WS bridge tests — NEW SHELL MODEL.
 *
 * Verify the /ws/cmd bridge over `(taskId, repoId)` (no kind): on attach it
 * ENSURES the repo shell exists, then REPLAYS the shell's buffered output before
 * any live frame, streams subsequent live `cmd:output`, forwards inbound
 * `cmd:input` (keystrokes) to the runner and `cmd:resize`, and forwards
 * `cmd:exit` (then closes). Drives `attach` with a fake CommandRunnerService + a
 * fake WebSocket — no real sockets or processes.
 */
import { describe, expect, it } from "vitest";

import type {
  CmdDataListener,
  CmdExitListener,
  CmdReplay,
  CommandRunnerService,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type {
  CmdMessage,
  CommandKind,
  RunCommandResult,
} from "../../shared/types.js";

import { attach } from "./cmd-bridge.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Fakes
 * ────────────────────────────────────────────────────────────────────────── */

class FakeCommandRunner implements CommandRunnerService {
  private dataListeners = new Set<CmdDataListener>();
  private exitListeners = new Set<CmdExitListener>();
  replay = "";
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  ensured: Array<{ taskId: string; repoId: string }> = [];
  /** When set, ensureShell throws (unresolvable task/repo). */
  ensureThrows = false;

  ensureShell(taskId: string, repoId: string): void {
    if (this.ensureThrows) throw new Error("unknown task/repo");
    this.ensured.push({ taskId, repoId });
  }
  async runScript(): Promise<RunCommandResult> {
    throw new Error("unused");
  }
  onData(_taskId: string, _repoId: string, cb: CmdDataListener): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }
  onExit(_taskId: string, _repoId: string, cb: CmdExitListener): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
  getReplay(): CmdReplay {
    return { data: this.replay };
  }
  isRunning(): boolean {
    return true;
  }
  write(_taskId: string, _repoId: string, data: string): void {
    this.writes.push(data);
  }
  resize(_taskId: string, _repoId: string, cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  killAllForTask(): void {}

  /* test drivers */
  emitData(d: string): void {
    for (const cb of this.dataListeners) cb(d);
  }
  emitExit(code: number | null): void {
    for (const cb of this.exitListeners) cb(code);
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readyState = FakeWebSocket.OPEN;
  sent: CmdMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private handlers = new Map<string, (arg: unknown) => void>();

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as CmdMessage);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.handlers.get("close")?.(undefined);
  }
  on(event: string, cb: (arg: unknown) => void): void {
    this.handlers.set(event, cb);
  }
  /** Drive an inbound message frame. */
  message(msg: CmdMessage): void {
    this.handlers.get("message")?.(JSON.stringify(msg));
  }

  outputs(): string[] {
    return this.sent
      .filter((m) => m.type === "cmd:output")
      .map((m) => (m as { data: string }).data);
  }
  exits(): Array<number | null> {
    return this.sent
      .filter((m) => m.type === "cmd:exit")
      .map((m) => (m as { exitCode: number | null }).exitCode);
  }
}

const ADDR = { taskId: "t1", repoId: "r1" };

function attachFake(ws: FakeWebSocket, runner: FakeCommandRunner): void {
  attach(ws as unknown as Parameters<typeof attach>[0], ADDR, runner);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */

describe("cmd-bridge attach: ensure-on-connect", () => {
  it("ensures the (taskId, repoId) shell exists before replaying", () => {
    const runner = new FakeCommandRunner();
    const ws = new FakeWebSocket();

    attachFake(ws, runner);

    expect(runner.ensured).toEqual([{ taskId: "t1", repoId: "r1" }]);
  });

  it("closes the socket when the shell cannot be resolved", () => {
    const runner = new FakeCommandRunner();
    runner.ensureThrows = true;
    const ws = new FakeWebSocket();

    attachFake(ws, runner);

    expect(ws.closed?.code).toBe(1008);
  });
});

describe("cmd-bridge attach: replay on connect", () => {
  it("replays the buffered output as cmd:output before any live frame", () => {
    const runner = new FakeCommandRunner();
    runner.replay = "PRIOR-OUTPUT\r\n";
    const ws = new FakeWebSocket();

    attachFake(ws, runner);

    expect(ws.outputs()[0]).toBe("PRIOR-OUTPUT\r\n");

    // Live output after replay is appended in order.
    runner.emitData("LIVE-1");
    expect(ws.outputs()).toEqual(["PRIOR-OUTPUT\r\n", "LIVE-1"]);
  });

  it("connects and replays nothing when the shell has no buffer yet", () => {
    const runner = new FakeCommandRunner();
    runner.replay = "";
    const ws = new FakeWebSocket();

    attachFake(ws, runner);

    expect(ws.outputs()).toEqual([]);
    // Live stream still works once the shell starts producing output.
    runner.emitData("FIRST");
    expect(ws.outputs()).toEqual(["FIRST"]);
  });
});

describe("cmd-bridge attach: input + resize", () => {
  it("forwards cmd:input keystrokes to the runner's shell", () => {
    const runner = new FakeCommandRunner();
    const ws = new FakeWebSocket();
    attachFake(ws, runner);

    ws.message({ type: "cmd:input", data: "ls\n" });
    expect(runner.writes).toEqual(["ls\n"]);
  });

  it("forwards a valid cmd:resize and ignores invalid dimensions", () => {
    const runner = new FakeCommandRunner();
    const ws = new FakeWebSocket();
    attachFake(ws, runner);

    ws.message({ type: "cmd:resize", cols: 120, rows: 40 });
    ws.message({ type: "cmd:resize", cols: 0, rows: 40 });
    expect(runner.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });
});

describe("cmd-bridge attach: exit", () => {
  it("forwards a live cmd:exit and closes the socket", () => {
    const runner = new FakeCommandRunner();
    runner.replay = "SOME OUTPUT";
    const ws = new FakeWebSocket();
    attachFake(ws, runner);

    runner.emitExit(0);

    expect(ws.exits()).toEqual([0]);
    expect(ws.closed?.code).toBe(1000);
  });

  it("delivers replay before an exit that fired during replay", () => {
    // With an in-memory replay there is no async window, but the bridge still
    // buffers an exit until after replay is sent. Emit the exit after attach to
    // confirm ordering: replay output precedes the exit frame.
    const runner = new FakeCommandRunner();
    runner.replay = "HISTORY";
    const ws = new FakeWebSocket();
    attachFake(ws, runner);

    runner.emitExit(3);

    expect(ws.outputs()).toEqual(["HISTORY"]);
    expect(ws.exits()).toEqual([3]);
  });
});
