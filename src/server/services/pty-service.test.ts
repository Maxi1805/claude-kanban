/**
 * PtyService output-capture + replay tests.
 *
 * These verify the fix for "re-entering a task terminal loses the conversation":
 * every output chunk is persisted to a per-task log and `getReplay` returns it,
 * including AFTER the pty exits. No real `claude` (or any real process) is
 * spawned — `node-pty` is mocked with a controllable fake whose `emit`/`exit`
 * helpers feed output through the real capture path.
 *
 * The server config module is mocked so the log dir points at a per-run temp dir.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../../shared/types.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Mocked config — points ptyLogDir at a per-run temp dir.
 * ────────────────────────────────────────────────────────────────────────── */

const configHolder = {
  dataDir: path.join(os.tmpdir(), "ck-pty-data"),
  ptyLogDir: path.join(os.tmpdir(), "ck-pty-fallback"),
  ptyReplayBytes: 2 * 1024 * 1024,
  ptyLogMaxBytes: 10 * 1024 * 1024,
  // A slash-containing command is treated as "present" by isOnPath (no real PATH
  // probe), so the agent (not the shell fallback) is what gets spawned — letting
  // us assert the resume args reach the spawn deterministically.
  defaultAgentCommand: "/usr/bin/claude",
  defaultAgentArgs: [] as string[],
  agentResumeArgs: ["--continue"],
};

vi.mock("../config.js", () => ({
  get config() {
    return {
      port: 8787,
      dataDir: configHolder.dataDir,
      worktreeBaseDir: os.tmpdir(),
      dbPath: ":memory:",
      ptyLogDir: configHolder.ptyLogDir,
      ptyReplayBytes: configHolder.ptyReplayBytes,
      ptyLogMaxBytes: configHolder.ptyLogMaxBytes,
      defaultAgentCommand: configHolder.defaultAgentCommand,
      defaultAgentArgs: configHolder.defaultAgentArgs,
      agentResumeArgs: configHolder.agentResumeArgs,
      templateRepoPath: null,
      browseRoots: [os.homedir()],
      idleThresholdMs: 3000,
      idleTickMs: 1000,
    };
  },
  projectRoot: process.cwd(),
}));

/** The hooks settings file the pty service appends via `--settings` for claude. */
const HOOKS_FILE = path.join(configHolder.dataDir, "claude-kanban-hooks.json");

/* ──────────────────────────────────────────────────────────────────────────
 * Mocked node-pty — a controllable fake process.
 * ────────────────────────────────────────────────────────────────────────── */

interface FakeProc {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
  /* test helpers */
  emit(d: string): void;
  exit(code: number, signal?: number): void;
}

let lastProc: FakeProc | null = null;
/** The (command, args) the last spawn was invoked with — for resume-arg asserts. */
let lastSpawn: { command: string; args: string[] } | null = null;

function makeFakeProc(): FakeProc {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const writes: string[] = [];
  const proc: FakeProc = {
    pid: 4242,
    onData(cb) {
      dataCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    write(d) {
      writes.push(d);
    },
    resize() {},
    kill() {},
    emit(d) {
      dataCb?.(d);
    },
    exit(code, signal) {
      exitCb?.({ exitCode: code, signal });
    },
  };
  return proc;
}

vi.mock("node-pty", () => ({
  spawn: (command: string, args: string[]) => {
    lastSpawn = { command, args };
    const proc = makeFakeProc();
    lastProc = proc;
    return proc;
  },
}));

import { PtyServiceImpl } from "./pty-service.js";
import { attach } from "../ws/pty-bridge.js";
import type { PtyMessage } from "../../shared/types.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Convenience: the replayed data string (getReplay now returns {data, offset}). */
async function replayData(svc: PtyServiceImpl, taskId: string): Promise<string> {
  return (await svc.getReplay(taskId)).data;
}

/**
 * Minimal WebSocket fake the bridge can drive — records the `pty:output` /
 * `pty:exit` frames it is sent. Used to verify the real bridge+service interleave
 * over REAL disk capture (not a static fake replay).
 */
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
  /** The concatenation of all `pty:output` data frames, in send order. */
  outputText(): string {
    return this.sent
      .filter((m) => m.type === "pty:output")
      .map((m) => (m as { data: string }).data)
      .join("");
  }
}

/** Attach the real bridge to a fake socket (structurally compatible). */
function attachBridge(
  ws: FakeWebSocket,
  taskId: string,
  svc: PtyServiceImpl,
): void {
  attach(ws as unknown as Parameters<typeof attach>[0], taskId, svc);
}

/** Resolve after `n` macrotask turns so async fs + promise chains settle. */
async function settle(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeTask(id: string, sessionRoot: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    projectId: "p",
    title: `task ${id}`,
    description: null,
    status: "running",
    slug: id,
    sessionRoot,
    ptyPid: null,
    claudeSessionId: null,
    port: null,
    createdAt: now,
    updatedAt: now,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ck-pty-"));
  configHolder.ptyLogDir = path.join(tmp, "pty-logs");
  configHolder.ptyReplayBytes = 2 * 1024 * 1024;
  configHolder.ptyLogMaxBytes = 10 * 1024 * 1024;
  configHolder.defaultAgentCommand = "/usr/bin/claude";
  configHolder.defaultAgentArgs = [];
  configHolder.agentResumeArgs = ["--continue"];
  lastProc = null;
  lastSpawn = null;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */

describe("PtyService output capture + replay", () => {
  it("captures output and getReplay returns it", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t1", tmp));
    const proc = lastProc!;

    proc.emit("hello ");
    proc.emit("world\r\n");

    expect(await replayData(svc, "t1")).toBe("hello world\r\n");
  });

  it("a NEW subscriber replays prior output, then receives live", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t2", tmp));
    const proc = lastProc!;

    // Output produced BEFORE anyone subscribes (the bug: this was lost).
    proc.emit("PRIOR-1");
    proc.emit("PRIOR-2");

    // Reconnect: replay first.
    const replay = await replayData(svc, "t2");
    expect(replay).toBe("PRIOR-1PRIOR-2");

    // Now subscribe and receive live output.
    const live: string[] = [];
    const off = svc.onData("t2", (d) => live.push(d));
    proc.emit("LIVE-1");
    off();
    proc.emit("AFTER-OFF");

    expect(live).toEqual(["LIVE-1"]);
    // Everything (including post-unsubscribe output) is still captured for the
    // next reconnect.
    expect(await replayData(svc, "t2")).toBe("PRIOR-1PRIOR-2LIVE-1AFTER-OFF");
  });

  it("getReplay still works AFTER the pty exits (history survives exit)", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t3", tmp));
    const proc = lastProc!;

    proc.emit("session output\r\n");
    proc.exit(0);

    // No live pty anymore …
    expect(svc.has("t3")).toBe(false);
    // … but the conversation is still replayable, and the exit is recorded.
    expect(await replayData(svc, "t3")).toBe("session output\r\n");
    expect(svc.isExited("t3")).toBe(true);
    expect(svc.lastExit("t3")).toEqual({ exitCode: 0, signal: null });
  });

  it("records the exit code/signal for a non-zero exit", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t4", tmp));
    const proc = lastProc!;

    proc.emit("crashing\r\n");
    proc.exit(7, 15);

    expect(svc.isExited("t4")).toBe(true);
    expect(svc.lastExit("t4")).toEqual({ exitCode: 7, signal: 15 });
    expect(await replayData(svc, "t4")).toBe("crashing\r\n");
  });

  it("a fresh spawn for the same task id starts a clean log (no stale replay)", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t5", tmp));
    lastProc!.emit("first-session");
    lastProc!.exit(0);
    expect(await replayData(svc, "t5")).toBe("first-session");

    // Recreate the task's pty: the previous session's output must NOT replay.
    await svc.spawnForTask(makeTask("t5", tmp));
    lastProc!.emit("second-session");
    expect(await replayData(svc, "t5")).toBe("second-session");
    // Exit record from the old run was cleared on respawn.
    expect(svc.isExited("t5")).toBe(false);
    expect(svc.lastExit("t5")).toBeNull();
  });

  it("getReplay is capped to the last N bytes of the log", async () => {
    configHolder.ptyReplayBytes = 10; // tiny cap for the test
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t6", tmp));
    lastProc!.emit("ABCDEFGHIJKLMNOPQRSTUVWXYZ"); // 26 bytes

    const replay = await replayData(svc, "t6");
    expect(replay).toBe("QRSTUVWXYZ"); // last 10 bytes only
  });

  it("bounds the on-disk log: trims a runaway session to ~half the max", async () => {
    configHolder.ptyLogMaxBytes = 1000; // small cap to trigger a trim
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("t7", tmp));
    const proc = lastProc!;

    // Write well past the max so a trim fires.
    const chunk = "x".repeat(400);
    for (let i = 0; i < 6; i++) proc.emit(chunk); // 2400 bytes total

    // Let the fire-and-forget capture + trim chain settle.
    await replayData(svc, "t7");
    // Poll the on-disk size down to the bound (trim is async after each append).
    const logFile = path.join(configHolder.ptyLogDir, "t7.log");
    let size = Infinity;
    for (let i = 0; i < 50; i++) {
      const stat = await fs.stat(logFile);
      size = stat.size;
      if (size <= configHolder.ptyLogMaxBytes) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(size).toBeLessThanOrEqual(configHolder.ptyLogMaxBytes);
  });

  it("returns empty replay for an unknown task", async () => {
    const svc = new PtyServiceImpl();
    expect(await svc.getReplay("never")).toEqual({ data: "", offset: 0 });
    expect(svc.bytePosition("never")).toBe(0);
    expect(svc.isExited("never")).toBe(false);
    expect(svc.lastExit("never")).toBeNull();
  });

  it("spawnForTask() WITHOUT resume does not append the resume args", async () => {
    configHolder.defaultAgentArgs = ["--foo"];
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("plain", tmp));
    expect(lastSpawn?.command).toBe("/usr/bin/claude");
    // No --continue on a fresh spawn; the kanban --settings hooks file is appended.
    expect(lastSpawn?.args).toEqual(["--foo", "--settings", HOOKS_FILE]);
  });

  it("spawnForTask(task, { resume: true }) appends config.agentResumeArgs", async () => {
    configHolder.defaultAgentArgs = ["--foo"];
    configHolder.agentResumeArgs = ["--continue"];
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("resumed", tmp), { resume: true });
    // The resume args follow the default args (`claude --foo --continue`), then
    // the kanban hooks file via --settings.
    expect(lastSpawn?.command).toBe("/usr/bin/claude");
    expect(lastSpawn?.args).toEqual([
      "--foo",
      "--continue",
      "--settings",
      HOOKS_FILE,
    ]);
  });

  it("does NOT append --settings for the shell fallback (agent not on PATH)", async () => {
    // A bare command name that is not on PATH forces the interactive-shell
    // fallback, which must spawn `-i` only — no --settings (bash can't parse it).
    configHolder.defaultAgentCommand = "definitely-not-a-real-binary-xyz";
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("fallback", tmp));
    expect(lastSpawn?.command).not.toBe("definitely-not-a-real-binary-xyz");
    expect(lastSpawn?.args).toEqual(["-i"]);
    expect(lastSpawn?.args).not.toContain("--settings");
  });

  it("onExitAny fires with (taskId, exitCode, signal) when a pty exits", async () => {
    const svc = new PtyServiceImpl();
    const events: Array<{ taskId: string; code: number; signal: number | null }> =
      [];
    const off = svc.onExitAny((taskId, code, signal) =>
      events.push({ taskId, code, signal }),
    );

    await svc.spawnForTask(makeTask("ea1", tmp));
    lastProc!.emit("work\r\n");
    // No exit yet → no event.
    expect(events).toEqual([]);

    lastProc!.exit(0);
    expect(events).toEqual([{ taskId: "ea1", code: 0, signal: null }]);

    // Carries the real exit code/signal.
    await svc.spawnForTask(makeTask("ea2", tmp));
    lastProc!.exit(9, 15);
    expect(events).toContainEqual({ taskId: "ea2", code: 9, signal: 15 });

    // After unsubscribe, no further global exit events are delivered.
    off();
    await svc.spawnForTask(makeTask("ea3", tmp));
    lastProc!.exit(1);
    expect(events.find((e) => e.taskId === "ea3")).toBeUndefined();
  });

  it("getReplay returns a byte offset matching the captured length", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("toff", tmp));
    lastProc!.emit("über"); // multi-byte: 'ü' is 2 bytes in UTF-8 → 5 bytes total

    const { data, offset } = await svc.getReplay("toff");
    expect(data).toBe("über");
    expect(offset).toBe(Buffer.byteLength("über", "utf8")); // 5, not 4
    expect(svc.bytePosition("toff")).toBe(offset);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Activity clock — the per-task lastOutputAt the AgentActivityMonitor reads.
 * ────────────────────────────────────────────────────────────────────────── */

describe("PtyService activity clock (lastOutputAt / getIdleMs / markActivity / markIdle)", () => {
  it("seeds the clock on spawn so a fresh agent is barely idle", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("clk1", tmp));
    // Seeded to ~now on spawn → tiny idle time, defined clock.
    expect(svc.getLastOutputAt("clk1")).toBeTypeOf("number");
    expect(svc.getIdleMs("clk1")).toBeLessThan(1000);
  });

  it("bumps lastOutputAt on every output chunk", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("clk2", tmp));
    const proc = lastProc!;

    // Force a stale clock, then emit output and assert it advanced to ~now.
    svc.markIdle("clk2");
    const stale = svc.getLastOutputAt("clk2")!;
    proc.emit("some output");
    const bumped = svc.getLastOutputAt("clk2")!;
    expect(bumped).toBeGreaterThan(stale);
    expect(svc.getIdleMs("clk2")).toBeLessThan(1000);
  });

  it("markActivity resets the clock to ~now (working)", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("clk3", tmp));
    svc.markIdle("clk3");
    expect(svc.getIdleMs("clk3")!).toBeGreaterThanOrEqual(3000);
    svc.markActivity("clk3");
    expect(svc.getIdleMs("clk3")!).toBeLessThan(1000);
  });

  it("markIdle pushes the clock just past the idle threshold (waiting next tick)", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("clk4", tmp));
    svc.markIdle("clk4");
    // idleThresholdMs is 3000 in the mocked config; markIdle sets it just beyond.
    expect(svc.getIdleMs("clk4")!).toBeGreaterThan(3000);
  });

  it("markActivity / markIdle are no-ops for a task with no live pty", () => {
    const svc = new PtyServiceImpl();
    svc.markActivity("ghost");
    svc.markIdle("ghost");
    expect(svc.getLastOutputAt("ghost")).toBeUndefined();
    expect(svc.getIdleMs("ghost")).toBeUndefined();
  });

  it("clears the clock on forget()", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("clk5", tmp));
    lastProc!.emit("x");
    lastProc!.exit(0);
    await replayData(svc, "clk5");
    expect(svc.getLastOutputAt("clk5")).toBeTypeOf("number");

    await svc.forget("clk5");
    expect(svc.getLastOutputAt("clk5")).toBeUndefined();
    expect(svc.getIdleMs("clk5")).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Regression: concurrency / edge cases of persist-and-replay (bridge + REAL
 * on-disk capture interleave — NOT a static fake getReplay).
 * ────────────────────────────────────────────────────────────────────────── */

describe("PtyService + bridge: replay/live interleave over real disk capture", () => {
  it("MEDIUM 1: a chunk arriving in the getReplay/attach window renders EXACTLY once", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("dup", tmp));
    const proc = lastProc!;

    // Pre-existing history captured to disk before anyone attaches.
    proc.emit("HISTORY-");
    await replayData(svc, "dup"); // ensure it is flushed to disk

    // Attach the real bridge. It registers onData, snapshots bytePosition, and
    // kicks off the async getReplay (tail read sequenced on the write chain).
    const ws = new FakeWebSocket();
    attachBridge(ws, "dup", svc);

    // THE RACE: a chunk arrives synchronously after attach, i.e. in the window
    // between the bridge starting getReplay and the tail read completing. With
    // the old design it could land in BOTH the replay tail AND the live buffer.
    proc.emit("RACER");
    // And another a tick later, still potentially mid-replay.
    proc.emit("-TAIL");

    await settle();

    // The terminal sees each byte exactly once, in order: no duplication, none
    // dropped, correct ordering.
    expect(ws.outputText()).toBe("HISTORY-RACER-TAIL");

    // Sanity: every distinct token appears exactly once.
    const text = ws.outputText();
    expect(text.match(/RACER/g)).toHaveLength(1);
    expect(text.match(/HISTORY-/g)).toHaveLength(1);
    expect(text.match(/-TAIL/g)).toHaveLength(1);
  });

  it("MEDIUM 1: chunks emitted while the tail read is in flight are not double-counted", async () => {
    // Hammer the window: many small chunks emitted across several ticks while a
    // fresh attach is reading replay. Each must appear exactly once.
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("dup2", tmp));
    const proc = lastProc!;

    proc.emit("BASE.");
    await replayData(svc, "dup2");

    const ws = new FakeWebSocket();
    attachBridge(ws, "dup2", svc);

    // Interleave emits with microtask/macrotask turns so some land before the
    // tail read resolves and some after.
    const expected = ["c0", "c1", "c2", "c3", "c4", "c5"];
    for (const c of expected) {
      proc.emit(c);
      await new Promise((r) => setTimeout(r, 0));
    }

    await settle();

    expect(ws.outputText()).toBe("BASE." + expected.join(""));
    for (const c of expected) {
      expect(ws.outputText().match(new RegExp(c, "g"))).toHaveLength(1);
    }
  });

  it("MEDIUM 2: a fresh respawn never loses the new session's first chunk", async () => {
    const svc = new PtyServiceImpl();

    // First session writes and exits.
    await svc.spawnForTask(makeTask("re", tmp));
    lastProc!.emit("OLD-SESSION");
    lastProc!.exit(0);
    expect(await replayData(svc, "re")).toBe("OLD-SESSION");

    // Respawn for the same task. The reset (log truncate) is routed through the
    // write chain; the FIRST chunk from the new pty is appended immediately and
    // synchronously (the race the bug had: append landing before the async rm).
    await svc.spawnForTask(makeTask("re", tmp));
    lastProc!.emit("NEW-FIRST"); // <-- must survive even if it races the truncate
    lastProc!.emit("-SECOND");

    // The new session's first chunk is present; the old session is gone.
    expect(await replayData(svc, "re")).toBe("NEW-FIRST-SECOND");
    expect(svc.bytePosition("re")).toBe(
      Buffer.byteLength("NEW-FIRST-SECOND", "utf8"),
    );
  });

  it("MEDIUM 2: first chunk survives even when it is emitted before any await yields", async () => {
    // Tighten the race: emit the very first byte of the new session in the same
    // synchronous turn as the spawn, so capture()'s append is queued behind the
    // (chained) truncate. If the truncate were fire-and-forget it could land
    // AFTER the append and wipe it.
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("re2", tmp));
    lastProc!.emit("first");
    lastProc!.exit(0);
    await replayData(svc, "re2");

    await svc.spawnForTask(makeTask("re2", tmp));
    // No await between spawn and the first emit — maximal pressure on the order.
    lastProc!.emit("X");
    lastProc!.emit("Y");
    lastProc!.emit("Z");

    expect(await replayData(svc, "re2")).toBe("XYZ");
  });

  it("LOW 3: a size-trim never drops an append that interleaves with it", async () => {
    // A tiny max forces frequent trims. We emit a long stream of UNIQUE tokens
    // so that if any append were lost to a writeFile/rename interleave, the
    // surviving tail would be missing a token in its sequence.
    configHolder.ptyLogMaxBytes = 256; // small → trims fire repeatedly
    configHolder.ptyReplayBytes = 2 * 1024 * 1024; // read the whole (trimmed) log
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("trim", tmp));
    const proc = lastProc!;

    // Each token is fixed-width so the kept tail is a clean suffix of the stream.
    const total = 200;
    const tokens: string[] = [];
    for (let i = 0; i < total; i++) {
      const tok = `[${String(i).padStart(4, "0")}]`; // 6 bytes each
      tokens.push(tok);
      proc.emit(tok);
    }

    const replay = await replayData(svc, "trim");

    // The replay must be a CONTIGUOUS suffix of the full emitted stream: trims
    // only drop the OLDEST bytes, never punch a hole via a lost interleaved
    // append. Find where the replay starts and assert it matches exactly.
    const full = tokens.join("");
    expect(full.endsWith(replay)).toBe(true);
    // And it must end with the most recent token (nothing newer was lost).
    expect(replay.endsWith(tokens[total - 1])).toBe(true);
    // The replayed region is intact: it is a parseable run of consecutive ids.
    const ids = (replay.match(/\[(\d{4})\]/g) ?? []).map((s) =>
      Number.parseInt(s.slice(1, 5), 10),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1); // strictly consecutive — no gaps
    }
    expect(ids[ids.length - 1]).toBe(total - 1);
  });

  it("forget() flushes pending writes then purges the per-task maps", async () => {
    const svc = new PtyServiceImpl();
    await svc.spawnForTask(makeTask("fg", tmp));
    lastProc!.emit("captured");
    lastProc!.exit(3);

    // Let the fire-and-forget capture append settle so the byte cursor advances.
    await replayData(svc, "fg");

    // Before forget: exit recorded, byte cursor advanced.
    expect(svc.isExited("fg")).toBe(true);
    expect(svc.lastExit("fg")).toEqual({ exitCode: 3, signal: null });
    expect(svc.bytePosition("fg")).toBe(Buffer.byteLength("captured", "utf8"));

    await svc.forget("fg");

    // After forget: all per-task state is purged (maps don't leak).
    expect(svc.isExited("fg")).toBe(false);
    expect(svc.lastExit("fg")).toBeNull();
    expect(svc.bytePosition("fg")).toBe(0);
    // The replay state is gone too (offset resets); the log file itself is the
    // caller's to delete.
    expect((await svc.getReplay("fg")).offset).toBe(0);
  });
});
