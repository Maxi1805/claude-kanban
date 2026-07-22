/**
 * AgentActivityMonitor tests — the DEMOTE-ONLY "waiting" writer.
 *
 * The monitor owns only the working → "waiting" transition: on each tick it lapses
 * a LIVE, currently-"working" task to "waiting" once its pty output has gone quiet
 * past the idle threshold. It must NEVER promote (waiting → working) from a fresh
 * activity clock — that is the agent hook's job — so merely viewing/redrawing a
 * terminal (which bumps the clock via pty output) can't flip an idle task to
 * "working". These tests drive `tick()` directly against an in-memory repo and a
 * fake pty whose `has`/`getIdleMs` we control.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, type DB } from "../db/index.js";
import { createRepositories } from "../db/repositories.js";
import { AgentActivityMonitor } from "./agent-activity-monitor.js";
import type { PtyService, Repositories } from "../../shared/interfaces.js";
import type { AgentState, BoardEventMsg } from "../../shared/types.js";

const IDLE_THRESHOLD = 3000;

/** Minimal PtyService stub exposing only what the monitor reads. */
class FakePty {
  live = new Set<string>();
  idle = new Map<string, number>();
  has(id: string): boolean {
    return this.live.has(id);
  }
  getIdleMs(id: string): number | undefined {
    return this.idle.get(id);
  }
}

let db: DB;
let repos: Repositories;
let pty: FakePty;
let events: BoardEventMsg[];
let monitor: AgentActivityMonitor;
let seq = 0;

beforeEach(() => {
  db = initDb(":memory:");
  repos = createRepositories(db);
  pty = new FakePty();
  events = [];
  monitor = new AgentActivityMonitor({
    repos,
    pty: pty as unknown as PtyService,
    broadcast: (e) => events.push(e),
    idleThresholdMs: IDLE_THRESHOLD,
  });
});

afterEach(() => {
  monitor.stop();
  db.close();
});

/** Create a task in `state`, optionally registering it as live with `idleMs`. */
function makeTask(
  state: AgentState | null,
  opts: { live?: boolean; idleMs?: number } = {},
): string {
  const project = repos.projects.create({ name: "p", repos: [] });
  const task = repos.tasks.create({
    projectId: project.id,
    title: `t${seq}`,
    description: null,
    slug: `t-${seq++}`,
  });
  if (state) {
    repos.tasks.update(task.id, {
      agentState: state,
      agentStateAt: new Date().toISOString(),
    });
  }
  if (opts.live) pty.live.add(task.id);
  if (opts.idleMs !== undefined) pty.idle.set(task.id, opts.idleMs);
  return task.id;
}

function stateOf(id: string): AgentState | null {
  return repos.tasks.getById(id)!.agentState ?? null;
}

describe("AgentActivityMonitor — demote-only", () => {
  it("demotes a quiet 'working' task to 'waiting' and broadcasts task:updated", () => {
    const id = makeTask("working", { live: true, idleMs: IDLE_THRESHOLD + 500 });

    monitor.tick();

    expect(stateOf(id)).toBe("waiting");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "board:event",
      kind: "task:updated",
      taskId: id,
    });
  });

  it("keeps a streaming 'working' task working (fresh clock → no write)", () => {
    const id = makeTask("working", { live: true, idleMs: IDLE_THRESHOLD - 500 });

    monitor.tick();

    expect(stateOf(id)).toBe("working");
    expect(events).toHaveLength(0);
  });

  it("does NOT promote 'waiting' on a single output tick (a redraw burst)", () => {
    // Opening a terminal emits ONE redraw burst (≤1 tick) — must not promote, so a
    // merely-viewed idle task stays "waiting".
    const id = makeTask("waiting", { live: true, idleMs: 0 });

    monitor.tick();

    expect(stateOf(id)).toBe("waiting");
    expect(events).toHaveLength(0);
  });

  it("promotes 'waiting' → 'working' after SUSTAINED output (promoteTicks)", () => {
    // The agent resumed (e.g. the user answered a prompt): fresh output every tick.
    // After promoteTicks (3) consecutive ticks it promotes to "working".
    const id = makeTask("waiting", { live: true, idleMs: 0 });

    monitor.tick(); // 1
    monitor.tick(); // 2
    expect(stateOf(id)).toBe("waiting"); // not sustained enough yet
    monitor.tick(); // 3 → promote

    expect(stateOf(id)).toBe("working");
    expect(events.some((e) => e.kind === "task:updated")).toBe(true);
  });

  it("resets the sustained-output count when output goes quiet (no false promote)", () => {
    const id = makeTask("waiting", { live: true, idleMs: 0 });
    monitor.tick(); // ticks=1
    monitor.tick(); // ticks=2
    pty.idle.set(id, IDLE_THRESHOLD + 1); // a quiet tick resets the counter
    monitor.tick(); // ticks=0
    pty.idle.set(id, 0); // fresh again
    monitor.tick(); // ticks=1
    monitor.tick(); // ticks=2

    expect(stateOf(id)).toBe("waiting"); // never 3 consecutive → no promote
  });

  it("skips a task with no live pty (its state is owned by the exit path)", () => {
    const id = makeTask("working", { live: false, idleMs: IDLE_THRESHOLD + 500 });

    monitor.tick();

    expect(stateOf(id)).toBe("working"); // untouched
    expect(events).toHaveLength(0);
  });

  it("skips a live 'working' task that has no activity clock yet", () => {
    const id = makeTask("working", { live: true }); // idleMs undefined

    monitor.tick();

    expect(stateOf(id)).toBe("working");
    expect(events).toHaveLength(0);
  });

  it("leaves a null-state (never-started) task alone", () => {
    const id = makeTask(null, { live: true, idleMs: IDLE_THRESHOLD + 500 });

    monitor.tick();

    expect(stateOf(id)).toBeNull();
    expect(events).toHaveLength(0);
  });
});
