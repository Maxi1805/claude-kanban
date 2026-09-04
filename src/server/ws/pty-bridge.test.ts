/**
 * PTY bridge replay-on-connect tests.
 *
 * Verify the fix for "re-entering a task loses the conversation" at the bridge
 * layer: on attach, the FULL captured history is sent as `pty:output` frames
 * BEFORE any live frame, nothing live is dropped or reordered, and an
 * already-exited task is replayed then followed by a `pty:exit`.
 *
 * Drives `attach` with a fake PtyService (controllable replay + live emit) and a
 * fake WebSocket that records sent frames. No real sockets or processes.
 */
import { describe, expect, it } from "vitest";

import type {
  PtyService,
  PtyDataListener,
  PtyExitListener,
  PtyExitAnyListener,
  PtyHandle,
  PtyReplay,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type { Task, PtyMessage } from "../../shared/types.js";

import { attach } from "./pty-bridge.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Fakes
 * ────────────────────────────────────────────────────────────────────────── */

/** Controllable PtyService: a settable replay string + manual live emit/exit. */
class FakePtyService implements PtyService {
  private dataListeners = new Set<PtyDataListener>();
  private exitListeners = new Set<PtyExitListener>();
  replay = "";
  exited = false;
  storedExit: { exitCode: number; signal: number | null } | null = null;
  /**
   * Byte position of the session's captured stream. `emitData` advances it so
   * the bridge's replay/live byte-gating is exercised; `replayOffset` is what
   * `getReplay` reports as the cut (defaults to the live position at the time of
   * the read, mirroring the real service capturing every chunk it fans out).
   */
  bytePos = 0;
  /** Optional explicit replay cut; when null, getReplay uses the current bytePos. */
  replayOffset: number | null = null;
  forgotten: string[] = [];
  /** Resolves the next getReplay; lets a test hold replay open to race live. */
  private gate: Promise<void> = Promise.resolve();

  /** Make getReplay wait on an external trigger; returns the release fn. */
  holdReplay(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((r) => (release = r));
    return release;
  }

  async spawnForTask(task: Task): Promise<PtyHandle> {
    return { taskId: task.id, pid: 0, cols: 80, rows: 24 };
  }
  has(_taskId: string): boolean {
    return true;
  }
  /** Recorded client → server keystrokes, in order. */
  writes: string[] = [];
  /** Recorded client → server geometry changes, in order. */
  resizes: Array<{ cols: number; rows: number }> = [];
  write(_taskId: string, data: string): void {
    this.writes.push(data);
  }
  resize(_taskId: string, cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {}
  onData(_taskId: string, cb: PtyDataListener): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }
  onExit(_taskId: string, cb: PtyExitListener): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
  onExitAny(_cb: PtyExitAnyListener): Unsubscribe {
    return () => {};
  }
  async getReplay(_taskId: string): Promise<PtyReplay> {
    this.calls.push("getReplay");
    // Snapshot the cut at CALL time (before the gate releases), mirroring the
    // real service sequencing the tail read on the write chain: live chunks that
    // arrive while the read is held open are NOT part of this replay's offset and
    // must be forwarded live by the bridge.
    const offset = this.replayOffset ?? this.bytePos;
    await this.gate;
    return { data: this.replay, offset };
  }
  /** Records the order of significant service touches for ordering asserts. */
  calls: string[] = [];
  bytePosition(_taskId: string): number {
    this.calls.push("bytePosition");
    return this.bytePos;
  }
  isExited(_taskId: string): boolean {
    return this.exited;
  }
  lastExit(_taskId: string): { exitCode: number; signal: number | null } | null {
    return this.storedExit;
  }
  getIdleMs(_taskId: string): number | undefined {
    return undefined;
  }
  getLastOutputAt(_taskId: string): number | undefined {
    return undefined;
  }
  markActivity(_taskId: string): void {}
  markIdle(_taskId: string): void {}
  async forget(taskId: string): Promise<void> {
    this.forgotten.push(taskId);
  }

  /* test drivers */
  emitData(d: string): void {
    this.bytePos += Buffer.byteLength(d, "utf8");
    for (const cb of this.dataListeners) cb(d);
  }
  emitExit(code: number, signal: number | null): void {
    for (const cb of this.exitListeners) cb(code, signal);
  }
}

/** Minimal WebSocket fake matching the surface the bridge touches. */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readyState = FakeWebSocket.OPEN;
  sent: PtyMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private handlers = new Map<string, (arg: unknown) => void>();

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as PtyMessage);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.handlers.get("close")?.(undefined);
  }
  on(event: string, cb: (arg: unknown) => void): void {
    this.handlers.set(event, cb);
  }

  /** Deliver one raw client → server frame to the bridge's `message` handler. */
  emitMessage(raw: string): void {
    this.handlers.get("message")?.(raw);
  }

  /** Frames of a given type, in order. */
  outputs(): string[] {
    return this.sent
      .filter((m) => m.type === "pty:output")
      .map((m) => (m as { data: string }).data);
  }
  exits(): Array<{ exitCode: number; signal: number | null }> {
    return this.sent
      .filter((m) => m.type === "pty:exit")
      .map((m) => {
        const e = m as { exitCode: number; signal: number | null };
        return { exitCode: e.exitCode, signal: e.signal };
      });
  }
}

// `attach` is typed against ws.WebSocket; our fake is structurally compatible
// for the methods it uses. Cast through unknown at the call boundary.
function attachFake(ws: FakeWebSocket, taskId: string, svc: FakePtyService): void {
  attach(ws as unknown as Parameters<typeof attach>[0], taskId, svc);
}

/** Variant of {@link attachFake} that also passes an ensureAgent hook. */
function attachFakeWithEnsure(
  ws: FakeWebSocket,
  taskId: string,
  svc: FakePtyService,
  ensureAgent: (taskId: string) => Promise<void>,
): void {
  attach(
    ws as unknown as Parameters<typeof attach>[0],
    taskId,
    svc,
    ensureAgent,
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */

const TID = "task-1";

describe("pty-bridge attach: replay on connect", () => {
  it("replays captured output as pty:output before any live frame", async () => {
    const svc = new FakePtyService();
    svc.replay = "PRIOR-HISTORY\r\n";
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc);
    // Let the async replay read + flush chain resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.outputs()[0]).toBe("PRIOR-HISTORY\r\n");

    // Live output after replay is appended in order.
    svc.emitData("LIVE-1");
    expect(ws.outputs()).toEqual(["PRIOR-HISTORY\r\n", "LIVE-1"]);
  });

  it("buffers live chunks arriving DURING replay and flushes them after, in order", async () => {
    const svc = new FakePtyService();
    svc.replay = "REPLAY";
    const release = svc.holdReplay(); // hold getReplay open
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc);

    // Live output races in while replay is still pending — must be buffered.
    svc.emitData("LIVE-A");
    svc.emitData("LIVE-B");
    // Nothing sent yet (replay not resolved).
    expect(ws.outputs()).toEqual([]);

    release();
    // Drain the replay promise chain (.then/.finally).
    await new Promise((r) => setTimeout(r, 0));

    // Replay precedes the buffered live chunks, in arrival order.
    expect(ws.outputs()).toEqual(["REPLAY", "LIVE-A", "LIVE-B"]);
  });

  it("post-exit reconnect: replays history then sends pty:exit and closes", async () => {
    const svc = new FakePtyService();
    svc.replay = "FINISHED SESSION\r\n";
    svc.exited = true;
    svc.storedExit = { exitCode: 0, signal: null };
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc);
    await new Promise((r) => setTimeout(r, 0));

    // History replayed …
    expect(ws.outputs()).toEqual(["FINISHED SESSION\r\n"]);
    // … then a trailing exit so the UI shows a finished (not hanging) session.
    expect(ws.exits()).toEqual([{ exitCode: 0, signal: null }]);
    expect(ws.closed?.code).toBe(1000);
  });

  it("a live exit during replay is delivered after the replay, once", async () => {
    const svc = new FakePtyService();
    svc.replay = "HEAD";
    const release = svc.holdReplay();
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc);

    // Exit fires while replay is still pending.
    svc.emitExit(3, null);
    expect(ws.exits()).toEqual([]); // buffered, not sent yet

    release();
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.outputs()).toEqual(["HEAD"]);
    expect(ws.exits()).toEqual([{ exitCode: 3, signal: null }]);
    expect(ws.closed?.code).toBe(1000);
  });

  it("ws close detaches listeners without killing (live output stops)", async () => {
    const svc = new FakePtyService();
    svc.replay = "";
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc);
    await new Promise((r) => setTimeout(r, 0));

    ws.close(1000, "bye");
    const before = ws.outputs().length;
    svc.emitData("AFTER-CLOSE");
    // Detached: no new frames sent after close.
    expect(ws.outputs().length).toBe(before);
  });

  it("byte-gating: a live chunk the replay already covered is NOT re-sent (dedup)", async () => {
    // Model the dup-chunk race at the bridge layer: a chunk arrives DURING the
    // held-open replay (so it is buffered), but the replay's `offset` cut lands
    // AFTER that chunk — i.e. the chunk's bytes are already part of the replayed
    // history. The bridge must drop it on flush, not double-render it.
    const svc = new FakePtyService();
    svc.bytePos = 5; // "ALPHA" was captured before attach
    svc.replay = "ALPHARACER"; // replay tail already includes the racing chunk
    // The replay cut is the FULL captured length (10): the racing chunk's bytes
    // (5..10) fall INSIDE the replay, so it was already rendered via replay.
    svc.replayOffset = 10;
    const release = svc.holdReplay();
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc); // getReplay snapshots offset=10 here

    // "RACER" raced in during replay — its bytes are 5..10, within the cut.
    svc.emitData("RACER"); // bytePos 5 → 10

    release();
    await new Promise((r) => setTimeout(r, 0));

    // The racing chunk appears EXACTLY once — only via the replay, never re-sent.
    expect(ws.outputs()).toEqual(["ALPHARACER"]);
    expect(ws.outputs().join("").match(/RACER/g)).toHaveLength(1);
  });

  it("byte-gating: a live chunk produced AFTER the replay cut is forwarded once", async () => {
    // Counterpart: the racing chunk is NOT in the replay (cut precedes it), so
    // it must be forwarded live — exactly once, after the replay.
    const svc = new FakePtyService();
    svc.bytePos = 5; // "ALPHA" before attach
    svc.replay = "ALPHA"; // replay does NOT include the racer
    svc.replayOffset = 5; // cut is before the racing chunk
    const release = svc.holdReplay();
    const ws = new FakeWebSocket();

    attachFake(ws, TID, svc);

    svc.emitData("BETA"); // bytePos 5 → 9, beyond the cut

    release();
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.outputs()).toEqual(["ALPHA", "BETA"]);
    expect(ws.outputs().join("").match(/BETA/g)).toHaveLength(1);
  });
});

describe("pty-bridge attach: ensureAgent on connect (resume a dead task)", () => {
  it("calls ensureAgent BEFORE binding replay/live, then replays normally", async () => {
    const svc = new FakePtyService();
    svc.replay = "RESUMED-HISTORY\r\n";
    const ws = new FakeWebSocket();

    const order: string[] = [];
    const ensureAgent = async (taskId: string): Promise<void> => {
      order.push(`ensureAgent:${taskId}`);
      // The respawn must complete before the bridge touches the service.
      expect(svc.calls).toEqual([]);
    };

    attachFakeWithEnsure(ws, TID, svc, ensureAgent);
    // ensureAgent ran synchronously up to its first await; service untouched yet.
    expect(order).toEqual([`ensureAgent:${TID}`]);
    expect(svc.calls).toEqual([]);

    // Let the deferred wiring (behind ensureAgent) run.
    await new Promise((r) => setTimeout(r, 0));

    // Now the service was touched (bytePosition + getReplay), AFTER ensureAgent.
    expect(svc.calls).toContain("getReplay");
    expect(svc.calls).toContain("bytePosition");
    // History replays as usual once the agent is (re)spawned.
    expect(ws.outputs()).toEqual(["RESUMED-HISTORY\r\n"]);

    // The freshly bound live stream forwards new output.
    svc.emitData("LIVE");
    expect(ws.outputs()).toEqual(["RESUMED-HISTORY\r\n", "LIVE"]);
  });

  it("waits for the ensureAgent promise to resolve before reading replay", async () => {
    const svc = new FakePtyService();
    svc.replay = "AFTER-RESPAWN";
    const ws = new FakeWebSocket();

    // Hold the respawn open; the bridge must not read replay until it resolves.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ensureAgent = (): Promise<void> => gate;

    attachFakeWithEnsure(ws, TID, svc, ensureAgent);
    await new Promise((r) => setTimeout(r, 0));

    // Respawn still pending → nothing bound, nothing replayed yet.
    expect(svc.calls).toEqual([]);
    expect(ws.outputs()).toEqual([]);

    release();
    await new Promise((r) => setTimeout(r, 0));

    // Respawn done → replay now bound and sent.
    expect(svc.calls).toContain("getReplay");
    expect(ws.outputs()).toEqual(["AFTER-RESPAWN"]);
  });

  it("still attaches when no ensureAgent hook is provided (live task)", async () => {
    const svc = new FakePtyService();
    svc.replay = "PLAIN";
    const ws = new FakeWebSocket();

    // No hook: wiring is synchronous, exactly as before this feature.
    attachFake(ws, TID, svc);
    expect(svc.calls).toContain("getReplay"); // bound in the same turn

    await new Promise((r) => setTimeout(r, 0));
    expect(ws.outputs()).toEqual(["PLAIN"]);
  });

  it("a rejecting ensureAgent does not block the terminal from attaching", async () => {
    const svc = new FakePtyService();
    svc.replay = "FALLBACK";
    const ws = new FakeWebSocket();

    const ensureAgent = async (): Promise<void> => {
      throw new Error("respawn blew up");
    };

    attachFakeWithEnsure(ws, TID, svc, ensureAgent);
    await new Promise((r) => setTimeout(r, 0));

    // Even though the hook rejected, the bridge still replays history.
    expect(ws.outputs()).toEqual(["FALLBACK"]);
  });
});

/**
 * Client → server frames. The bridge accepts exactly two (`pty:input`,
 * `pty:resize`) and must SILENTLY ignore everything else — a malformed or
 * hostile frame can never be allowed to tear down a live terminal.
 */
describe("pty-bridge attach: input + resize", () => {
  it("forwards pty:input keystrokes to the pty", () => {
    const svc = new FakePtyService();
    const ws = new FakeWebSocket();
    attachFake(ws, TID, svc);

    ws.emitMessage(JSON.stringify({ type: "pty:input", data: "ls -la\r" }));

    expect(svc.writes).toEqual(["ls -la\r"]);
  });

  it("ignores a pty:input whose payload is not a string", () => {
    const svc = new FakePtyService();
    const ws = new FakeWebSocket();
    attachFake(ws, TID, svc);

    ws.emitMessage(JSON.stringify({ type: "pty:input", data: 42 }));

    expect(svc.writes).toEqual([]);
  });

  it("forwards a valid pty:resize and ignores invalid geometry", () => {
    const svc = new FakePtyService();
    const ws = new FakeWebSocket();
    attachFake(ws, TID, svc);

    ws.emitMessage(JSON.stringify({ type: "pty:resize", cols: 120, rows: 40 }));
    // Zero, negative and non-finite dimensions are all rejected.
    ws.emitMessage(JSON.stringify({ type: "pty:resize", cols: 0, rows: 40 }));
    ws.emitMessage(JSON.stringify({ type: "pty:resize", cols: 80, rows: -1 }));
    ws.emitMessage(JSON.stringify({ type: "pty:resize", cols: "x", rows: 40 }));

    expect(svc.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("ignores malformed JSON and server-originated frames without throwing", () => {
    const svc = new FakePtyService();
    const ws = new FakeWebSocket();
    attachFake(ws, TID, svc);

    expect(() => ws.emitMessage("{not json")).not.toThrow();
    // pty:output / pty:exit are server → client; echoing them back is a no-op.
    ws.emitMessage(JSON.stringify({ type: "pty:output", taskId: TID, data: "X" }));
    ws.emitMessage(
      JSON.stringify({ type: "pty:exit", taskId: TID, exitCode: 0, signal: null }),
    );

    expect(svc.writes).toEqual([]);
    expect(svc.resizes).toEqual([]);
    expect(ws.closed).toBeNull();
  });
});
