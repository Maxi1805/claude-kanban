/**
 * Caveman integration tests.
 *
 * Two halves, matching the two mechanisms:
 *   • plugin-id resolution — pure filesystem probing, exercised against a fake
 *     home dir so no test depends on what this machine has installed.
 *   • session typing — a fake PtyService records what would be typed, and the
 *     timings are compressed to milliseconds so the quiet-wait is real (not
 *     stubbed) yet instant.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PtyService, Unsubscribe } from "../../shared/interfaces.js";
import type { PtyDataListener, PtyHandle, PtyReplay } from "../../shared/interfaces.js";
import type { Task } from "../../shared/types.js";
import {
  CAVEMAN_OFF_INPUT,
  applyCavemanOnSpawn,
  applyCavemanToLiveSession,
  cavemanLevelCommand,
  effectiveLevel,
  resolveCavemanPluginId,
  sessionHasPlugin,
  submitToSession,
  type SubmitTiming,
} from "./caveman.js";

/** Fast timings: the quiet-wait is genuinely awaited, just in milliseconds. */
const FAST: SubmitTiming = { quietMs: 5, timeoutMs: 200, submitDelayMs: 1 };

/**
 * Minimal PtyService double. Only the members caveman touches are real; the rest
 * throw, so a future caveman change that reaches for more of the pty surface
 * fails loudly here instead of silently doing something in production.
 */
class FakePty implements Partial<PtyService> {
  written: string[] = [];
  live = true;
  /** When the "user" last typed. Undefined = never, which never blocks. */
  lastInputAt: number | undefined;
  private listeners = new Set<PtyDataListener>();

  has(_taskId: string): boolean {
    return this.live;
  }

  write(_taskId: string, data: string): void {
    this.written.push(data);
  }

  onData(_taskId: string, cb: PtyDataListener): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getLastInputAt(_taskId: string): number | undefined {
    return this.lastInputAt;
  }

  /** Simulate the terminal producing output (restarts the quiet window). */
  emit(data: string): void {
    for (const cb of this.listeners) cb(data);
  }

  /** How many listeners are still subscribed — leak check. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** The full text typed into the session, Enter included. */
  typed(): string {
    return this.written.join("");
  }

  spawnForTask(): Promise<PtyHandle> {
    throw new Error("not implemented");
  }
  getReplay(): Promise<PtyReplay> {
    throw new Error("not implemented");
  }
}

/** The double, typed as the interface the production code consumes. */
const asPty = (fake: FakePty): PtyService => fake as unknown as PtyService;

function makeTask(over: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "t1",
    projectId: "p1",
    title: "t",
    description: null,
    status: "running",
    slug: "t1",
    sessionRoot: "/tmp/x",
    ptyPid: null,
    claudeSessionId: null,
    port: null,
    cavemanEnabled: false,
    cavemanLevel: null,
    cavemanSession: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("caveman: commands and levels", () => {
  it("builds the plugin's slash command per level", () => {
    expect(cavemanLevelCommand("lite")).toBe("/caveman:caveman lite");
    expect(cavemanLevelCommand("ultra")).toBe("/caveman:caveman ultra");
    expect(cavemanLevelCommand("wenyan-ultra")).toBe("/caveman:caveman wenyan-ultra");
  });

  it("falls back to the plugin's own default level when none is stored", () => {
    expect(effectiveLevel({ cavemanLevel: null })).toBe("full");
    expect(effectiveLevel({ cavemanLevel: "ultra" })).toBe("ultra");
  });
});

describe("caveman: plugin id resolution", () => {
  let home: string;
  const savedOverride = process.env.CK_CAVEMAN_PLUGIN_ID;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "ck-caveman-home-"));
    delete process.env.CK_CAVEMAN_PLUGIN_ID;
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    if (savedOverride === undefined) delete process.env.CK_CAVEMAN_PLUGIN_ID;
    else process.env.CK_CAVEMAN_PLUGIN_ID = savedOverride;
  });

  it("prefers the explicit env override over anything on disk", async () => {
    await fsp.mkdir(path.join(home, ".claude", "skills", "caveman"), {
      recursive: true,
    });
    process.env.CK_CAVEMAN_PLUGIN_ID = "caveman@mine";
    expect(resolveCavemanPluginId(home)).toBe("caveman@mine");
  });

  it("detects a skills-dir install", async () => {
    await fsp.mkdir(path.join(home, ".claude", "skills", "caveman"), {
      recursive: true,
    });
    expect(resolveCavemanPluginId(home)).toBe("caveman@skills-dir");
  });

  it("detects a marketplace install and carries the marketplace name", async () => {
    await fsp.mkdir(
      path.join(home, ".claude", "plugins", "marketplaces", "acme", "plugins", "caveman"),
      { recursive: true },
    );
    expect(resolveCavemanPluginId(home)).toBe("caveman@acme");
  });

  it("falls back to caveman@caveman when nothing is installed", () => {
    // An id matching no installed plugin is inert: Claude Code skips orphaned
    // enabledPlugins entries. So an un-installed caveman costs nothing.
    expect(resolveCavemanPluginId(home)).toBe("caveman@caveman");
  });
});

describe("caveman: typing into a live session", () => {
  it("types the text and submits it with a separate Return", async () => {
    const pty = new FakePty();
    const ok = await submitToSession(asPty(pty), "t1", "/caveman:caveman ultra", FAST);
    expect(ok).toBe(true);
    expect(pty.written).toEqual(["/caveman:caveman ultra", "\r"]);
  });

  it("waits for the terminal to go quiet before typing", async () => {
    const pty = new FakePty();
    const done = submitToSession(asPty(pty), "t1", "/caveman:caveman lite", FAST);

    // A burst of output keeps restarting the quiet window: nothing typed yet.
    for (let i = 0; i < 4; i++) {
      pty.emit("boot chunk");
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(pty.written).toEqual([]);

    await done;
    expect(pty.typed()).toBe("/caveman:caveman lite\r");
  });

  it("unsubscribes from pty output once it has typed", async () => {
    const pty = new FakePty();
    await submitToSession(asPty(pty), "t1", "hello", FAST);
    expect(pty.listenerCount()).toBe(0);
  });

  it("holds off while the user is mid-keystroke", async () => {
    // The regression: an injection landing in a half-typed prompt fused with it
    // ("Args from unknown skill: litenormal mode").
    const pty = new FakePty();
    pty.lastInputAt = Date.now();
    const started = Date.now();
    // timeoutMs caps the hold, so the test stays fast while still proving the wait.
    await submitToSession(asPty(pty), "t1", "/caveman:caveman lite", {
      quietMs: 5,
      timeoutMs: 120,
      submitDelayMs: 1,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(pty.typed()).toBe("/caveman:caveman lite\r");
  });

  it("types immediately when the user has not typed at all", async () => {
    const pty = new FakePty();
    pty.lastInputAt = undefined;
    const started = Date.now();
    await submitToSession(asPty(pty), "t1", "hello", FAST);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("does nothing when the task has no live pty", async () => {
    const pty = new FakePty();
    pty.live = false;
    expect(await submitToSession(asPty(pty), "t1", "hello", FAST)).toBe(false);
    expect(pty.written).toEqual([]);
  });

  it("does nothing when there is no pty service at all", async () => {
    expect(await submitToSession(undefined, "t1", "hello", FAST)).toBe(false);
  });
});

describe("caveman: applying a board change to a live session", () => {
  it("knows whether the live session actually has the plugin", () => {
    expect(sessionHasPlugin({ cavemanSession: true })).toBe(true);
    expect(sessionHasPlugin({ cavemanSession: false })).toBe(false);
    expect(sessionHasPlugin({ cavemanSession: null })).toBe(false);
  });

  it("types the level command when the session has the plugin", async () => {
    const pty = new FakePty();
    const task = makeTask({
      cavemanEnabled: true,
      cavemanLevel: "ultra",
      cavemanSession: true,
    });
    expect(await applyCavemanToLiveSession(asPty(pty), task, FAST)).toBe(true);
    expect(pty.typed()).toBe("/caveman:caveman ultra\r");
  });

  it("types the level command even for the default level", async () => {
    // Unlike a spawn, a running session has already passed the point where
    // enabledPlugins could decide anything — so the default level must be spoken.
    const pty = new FakePty();
    const task = makeTask({
      cavemanEnabled: true,
      cavemanLevel: "full",
      cavemanSession: true,
    });
    await applyCavemanToLiveSession(asPty(pty), task, FAST);
    expect(pty.typed()).toBe("/caveman:caveman full\r");
  });

  it("says the plugin's off phrase when disabled", async () => {
    // The plugin has no `/caveman:caveman off`; its README documents "normal mode".
    const pty = new FakePty();
    const task = makeTask({
      cavemanEnabled: false,
      cavemanLevel: "ultra",
      cavemanSession: true,
    });
    await applyCavemanToLiveSession(asPty(pty), task, FAST);
    expect(pty.typed()).toBe(`${CAVEMAN_OFF_INPUT}\r`);
  });

  it("types NOTHING at a session that was spawned without the plugin", async () => {
    // The regression this guard exists for: ticking the checkbox on a running
    // agent used to type `/caveman:caveman full` at a session where the plugin was never
    // loaded, and the session answered "Unknown command: /caveman". It cannot be
    // talked into loading it — only a respawn can.
    const pty = new FakePty();
    const task = makeTask({
      cavemanEnabled: true,
      cavemanLevel: "full",
      cavemanSession: false,
    });
    expect(await applyCavemanToLiveSession(asPty(pty), task, FAST)).toBe(false);
    expect(pty.written).toEqual([]);
  });

  it("types nothing when the session predates the setting (null)", async () => {
    const pty = new FakePty();
    const task = makeTask({ cavemanEnabled: true, cavemanSession: null });
    expect(await applyCavemanToLiveSession(asPty(pty), task, FAST)).toBe(false);
    expect(pty.written).toEqual([]);
  });
});

describe("caveman: applying on spawn", () => {
  it("stays silent for a disabled task", async () => {
    const pty = new FakePty();
    expect(
      await applyCavemanOnSpawn(asPty(pty), makeTask({ cavemanEnabled: false }), FAST),
    ).toBe(false);
    expect(pty.written).toEqual([]);
  });

  it("stays silent for the default level — enabledPlugins already did it", async () => {
    const pty = new FakePty();
    const task = makeTask({ cavemanEnabled: true, cavemanLevel: "full" });
    expect(await applyCavemanOnSpawn(asPty(pty), task, FAST)).toBe(false);
    expect(pty.written).toEqual([]);
  });

  it("stays silent when no level was ever chosen (the default applies)", async () => {
    const pty = new FakePty();
    const task = makeTask({ cavemanEnabled: true, cavemanLevel: null });
    expect(await applyCavemanOnSpawn(asPty(pty), task, FAST)).toBe(false);
    expect(pty.written).toEqual([]);
  });

  it("types the command for a non-default level", async () => {
    const pty = new FakePty();
    const task = makeTask({ cavemanEnabled: true, cavemanLevel: "lite" });
    expect(await applyCavemanOnSpawn(asPty(pty), task, FAST)).toBe(true);
    expect(pty.typed()).toBe("/caveman:caveman lite\r");
  });
});
