/**
 * AgentActivityMonitor — the output-clock SAFETY NET around hook-driven state.
 *
 * Live agent state is primarily HOOK-DRIVEN (see api/agent-events.ts): an activity
 * hook writes "working" (sticky), an idle hook (Stop/Notification) writes "waiting".
 * But the hooks are sparse and the Notification hook is unreliable, so this monitor
 * fills the gaps using ONLY the pty output clock (`PtyService.getIdleMs`, time
 * since the last output) — never terminal text:
 *   • PROMOTE "waiting" → "working" on SUSTAINED output (output in `promoteTicks`
 *     consecutive ticks). This recovers "working" when the user answers a prompt
 *     and the agent resumes but no activity hook fires. A single redraw burst
 *     (opening a terminal) is ≤1 tick → never promotes, so merely viewing an idle
 *     task can't flip it to "working".
 *   • DEMOTE "working" → "waiting" after a LONG output silence (`idleThresholdMs`)
 *     — a missed Stop (e.g. an auto-mode prompt that never fired a Notification).
 *
 * The pty-exit path clears `agentState` to null directly (a dead task is not
 * "live" here, so the monitor never touches it).
 */
import type { PtyService, Repositories } from "../../shared/interfaces.js";
import type { AgentState, BoardEventMsg, Task } from "../../shared/types.js";

/** Broadcaster for board events (same shape lifecycle uses). Defaults to a no-op. */
export type BoardEventBroadcaster = (event: BoardEventMsg) => void;

/** Dependencies injected by the server bootstrap. */
export interface AgentActivityMonitorDeps {
  repos: Repositories;
  pty: PtyService;
  /** Broadcast a board event to connected clients. Defaults to a no-op. */
  broadcast?: BoardEventBroadcaster;
  /** Poll interval in ms. Defaults to `config.idleTickMs`. */
  tickMs?: number;
  /** Idle threshold in ms after which a quiet "working" task lapses to "waiting". */
  idleThresholdMs?: number;
}

export class AgentActivityMonitor {
  private readonly repos: Repositories;
  private readonly pty: PtyService;
  private readonly broadcast: BoardEventBroadcaster;
  private readonly tickMs: number;
  private readonly idleThresholdMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-task count of CONSECUTIVE ticks with fresh pty output — a proxy for the
   * agent actively streaming. Used to PROMOTE "waiting" → "working" only on
   * SUSTAINED output, so a one-frame redraw burst (opening a terminal) can't.
   */
  private readonly activeTicks = new Map<string, number>();
  /** Ticks of sustained output required to promote a "waiting" task to "working". */
  private readonly promoteTicks = 3;

  constructor(deps: AgentActivityMonitorDeps) {
    this.repos = deps.repos;
    this.pty = deps.pty;
    this.broadcast = deps.broadcast ?? (() => {});
    // Resolve the timing knobs lazily from the injected values; the bootstrap
    // passes config.idleTickMs / config.idleThresholdMs.
    this.tickMs = deps.tickMs ?? 1000;
    this.idleThresholdMs = deps.idleThresholdMs ?? 3000;
  }

  /** Begin polling. Idempotent — a second call without `stop` is a no-op. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Don't keep the event loop alive on behalf of the monitor (tests + clean
    // shutdown); the server's listening socket keeps the process up.
    this.timer.unref?.();
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sampling pass over every live task: promote on sustained output / demote on
   * long silence (see {@link evaluate}). Per-task errors are isolated so one bad row
   * can't kill the interval.
   */
  tick(): void {
    let tasks: Task[];
    try {
      tasks = this.repos.tasks.list();
    } catch {
      return; // a failed list just skips this pass
    }
    for (const task of tasks) {
      try {
        this.evaluate(task);
      } catch {
        // Isolate per-task failures so the interval keeps running.
      }
    }
  }

  /**
   * Per-task pass — a safety net that moves state when the hooks can't, derived
   * from the pty OUTPUT clock (never terminal text):
   *   • PROMOTE "waiting" → "working" on SUSTAINED output (fresh output in
   *     `promoteTicks` consecutive ticks). This recovers "working" when no activity
   *     hook fires — most importantly RIGHT AFTER the user answers a prompt
   *     (PreToolUse already fired before the prompt; PostToolUse only fires when the
   *     tool finishes; the Notification hook is late/unreliable). A single-frame
   *     redraw burst (opening a terminal) is ≤1 tick, so it never reaches
   *     `promoteTicks` → an idle task can't be flipped to "working" by mere viewing.
   *   • DEMOTE "working" → "waiting" when output has been quiet past
   *     `idleThresholdMs` (a missed Stop — the long fallback).
   * Live tasks only; a dead task's state is owned by the pty-exit path.
   */
  private evaluate(task: Task): void {
    if (!this.pty.has(task.id)) {
      this.activeTicks.delete(task.id);
      return;
    }

    const idleMs = this.pty.getIdleMs(task.id);
    // Count consecutive ticks with fresh output (a proxy for "actively streaming").
    const hadOutput = idleMs !== undefined && idleMs < this.tickMs;
    const ticks = hadOutput ? (this.activeTicks.get(task.id) ?? 0) + 1 : 0;
    this.activeTicks.set(task.id, ticks);

    if (task.agentState === "waiting") {
      // Sustained output → the agent resumed working (e.g. after you accepted a
      // prompt). A redraw flash won't reach promoteTicks, so viewing won't promote.
      if (ticks >= this.promoteTicks) this.setState(task, "working");
      return;
    }
    if (task.agentState === "working") {
      // Long output silence with no Stop → fall back to "waiting".
      if (idleMs !== undefined && idleMs >= this.idleThresholdMs) {
        this.setState(task, "waiting");
      }
      return;
    }
    // null / unknown → owned by the spawn/exit paths; nothing to do.
  }

  /** Persist a state change + broadcast a hydrated task:updated. */
  private setState(task: Task, state: AgentState): void {
    const updated = this.repos.tasks.update(task.id, {
      agentState: state,
      agentStateAt: new Date().toISOString(),
    });
    if (!updated) return;
    const hydrated: Task =
      this.repos.tasks.getById(updated.id, { withRepos: true }) ?? updated;
    this.broadcast({
      type: "board:event",
      kind: "task:updated",
      taskId: hydrated.id,
      projectId: hydrated.projectId,
      task: hydrated,
    });
  }
}

/** Concrete factory used by the server bootstrap. */
export const createAgentActivityMonitor = (
  deps: AgentActivityMonitorDeps,
): AgentActivityMonitor => new AgentActivityMonitor(deps);
