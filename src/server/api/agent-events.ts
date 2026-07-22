/**
 * Agent-events router — the sink for Claude Code hook callbacks.
 *
 * The hooks injected into each task's `claude` (see services/agent-hooks.ts)
 * `curl` the raw hook-event JSON to `POST /api/agent-events`. This route is the
 * primary writer of a task's live `agentState`, resolving the owning task by
 * matching the event's `cwd` to a task's `sessionRoot`:
 *   • a working event (UserPromptSubmit | PreToolUse | PostToolUse | SessionStart)
 *     → agentState = "working" (STICKY: stays "working" for the whole turn —
 *       thinking, streaming, tools — until an idle event flips it),
 *   • an idle event (Stop | Notification, ANY type) → agentState = "waiting".
 * Both persist on a real change + broadcast a hydrated `task:updated`.
 *
 * State is HOOK-DRIVEN ON PURPOSE: only real agent activity flips a task to
 * "working", so merely opening/redrawing a terminal (which produces pty output)
 * never promotes it. The AgentActivityMonitor is ONLY a long-timeout SAFETY NET:
 * if a "working" task's output stays quiet far longer than a turn (a missed Stop —
 * e.g. an auto-mode prompt that never fired a Notification) it demotes to
 * "waiting". An activity event bumps the pty activity clock (`markActivity`) so
 * that fallback timer restarts. Spawn → "working" / exit → null stay owned by
 * the lifecycle.
 *
 * Every write is GATED on a live pty: a hook for a task whose agent is gone must
 * not write state (the exit path owns clearing it to null).
 *
 * Local-only, no auth. It MUST always answer 200 FAST — even on a parse error,
 * an unknown cwd, or a missing task — because the hook BLOCKS the claude session
 * until the request returns. The handler is cheap and never throws to the client.
 *
 * cwd↔sessionRoot matching resolves BOTH sides through `fs.realpath` so a
 * symlinked session root (the worktree base may live behind a symlink) still
 * matches the cwd claude reports.
 */
import fs from "node:fs";
import path from "node:path";

import { Router, text } from "express";
import type { Request, Response } from "express";

import type { PtyService, Repositories } from "../../shared/interfaces.js";
import type { AgentState, Task } from "../../shared/types.js";
import type { BoardEventEmitter } from "./projects.js";

export interface AgentEventsRouterDeps {
  repos: Repositories;
  /**
   * The pty service used to GATE state writes on a live pty: a hook for a task
   * whose agent is already gone must not write state (the exit path owns null).
   * Optional so isolated tests / call sites that don't care can omit it; when
   * absent the handler resolves the task, answers 200, but writes nothing.
   */
  pty?: PtyService;
  /**
   * Emit a board event so the card updates live on a promotion to "working".
   * The same inner-event emitter the projects/tasks routers use. Optional → no-op.
   */
  emit?: BoardEventEmitter;
}

/** The subset of a Claude Code hook event we read off the POST body. */
interface HookEventBody {
  hook_event_name?: unknown;
  cwd?: unknown;
  notification_type?: unknown;
  session_id?: unknown;
}

/**
 * How a hook event maps to the task's desired live state:
 *   • "activity" — the agent is doing work → "working":
 *                  UserPromptSubmit | PreToolUse | PostToolUse | SessionStart.
 *   • "idle"     — the agent has stopped and is waiting on the user → "waiting":
 *                  Stop, and Notification of ANY notification_type (a notification
 *                  means claude is waiting on the user — a permission/question
 *                  prompt, an idle nudge, etc.).
 *   • null       — an event we do not track (the caller then does nothing).
 *
 * The Notification type is intentionally ignored: every notification is "not
 * actively working" → "waiting".
 */
export type HookNudge = "activity" | "idle";

export function hookNudge(eventName: string): HookNudge | null {
  switch (eventName) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SessionStart":
      return "activity";
    case "Stop":
    case "Notification":
      return "idle";
    default:
      return null;
  }
}

/**
 * Resolve a path to its real (symlink-followed) form, falling back to a plain
 * `path.resolve` when the path does not exist on disk (e.g. a torn-down session
 * root). Never throws — resolution is best-effort so the handler stays cheap.
 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A Notification ("waiting") is honored only when the agent's pty output has been
 * idle at least this long. A late/stale Notification that lands while the agent is
 * actively streaming (e.g. just after the user answered a prompt) is ignored, so it
 * can't clobber "working" — the monitor's sustained-output promote keeps it working.
 */
const NOTIFICATION_OUTPUT_IDLE_MS = 1500;

export function createAgentEventsRouter(deps: AgentEventsRouterDeps): Router {
  const { repos, pty, emit } = deps;
  const router = Router();

  // Read the hook payload as RAW TEXT (any content type) and parse it ourselves,
  // so a malformed body can NEVER become a 400 — express.json() would throw a
  // SyntaxError on bad JSON, and a non-200 could surface as an error in the
  // claude turn. We parse defensively and treat anything unparseable as empty.
  router.use(text({ type: () => true, limit: "1mb" }));

  router.post("/", (req: Request, res: Response) => {
    // Respond 200 IMMEDIATELY, BEFORE any processing. The hook's `curl` BLOCKS the
    // claude turn and runs under a short hard timeout, so it must never wait on our
    // task resolution / DB write / broadcast. If we did that work first (as before)
    // a busy event loop — e.g. while fanning out a chatty session's pty output —
    // could push the response past curl's timeout, the POST gets silently dropped
    // (`|| true`), and since claude then goes idle (no more hooks) the state stays
    // STUCK at its last value forever. Parsing the already-buffered body is cheap;
    // answer, then do the real work off the response path. Any throw is swallowed
    // (logged) so hook processing can never surface as an error in the turn.
    const body = parseBody(req.body);
    res.status(200).json({ ok: true });
    setImmediate(() => {
      try {
        handle(body);
      } catch (err) {
        console.error("[agent-events] hook processing failed:", err);
      }
    });
  });

  /**
   * Parse the request body into a hook-event object; {} on any failure.
   *
   * Accepts BOTH shapes so the handler is robust to whatever upstream body
   * parser ran first:
   *   • a raw string (this router's own `text()` parser, or no parser) — we
   *     JSON.parse it ourselves so malformed input degrades to {} (never a 400);
   *   • an already-parsed object — when an upstream `express.json()` consumed the
   *     stream first (the API router mounts json() ahead of this sub-router), the
   *     body arrives pre-parsed and must be used as-is, not re-stringified.
   */
  function parseBody(raw: unknown): HookEventBody {
    if (typeof raw === "string") {
      if (raw.length === 0) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object"
          ? (parsed as HookEventBody)
          : {};
      } catch {
        return {};
      }
    }
    // Already parsed by an upstream JSON body parser (e.g. express.json()).
    return raw && typeof raw === "object" ? (raw as HookEventBody) : {};
  }

  /**
   * Resolve the owning task and apply the hook (both writes gated on a live pty):
   *   • activity → set "working" (sticky) + bump the activity clock so the
   *     monitor's long stale-fallback timer restarts.
   *   • idle     → set "waiting".
   * Never throws out.
   */
  function handle(body: HookEventBody): void {
    const eventName =
      typeof body.hook_event_name === "string" ? body.hook_event_name : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : "";

    if (!eventName || !cwd) return; // nothing actionable

    const nudge = hookNudge(eventName);
    if (nudge === null) return; // event we don't track

    const task = resolveTaskByCwd(cwd);
    if (!task) return; // unknown cwd → 200, do nothing

    // Only act on a task whose agent is actually live; a dead task's state is
    // owned by the pty-exit path (cleared to null) — never resurrect it.
    if (!pty?.has(task.id)) return;

    if (nudge === "idle") {
      // A late/stale Notification can land AFTER the user already answered the
      // prompt and the agent resumed — it must not clobber active work. Honor a
      // Notification only when output is actually idle; Stop always wins (the turn
      // really ended).
      if (
        eventName === "Notification" &&
        (pty?.getIdleMs(task.id) ?? Number.POSITIVE_INFINITY) <
          NOTIFICATION_OUTPUT_IDLE_MS
      ) {
        return; // agent is actively producing output → ignore the stale notification
      }
      setState(task, "waiting");
      return;
    }

    // activity → PROMOTE to "working" and keep it STICKY for the whole turn (the
    // monitor never demotes a still-streaming task). Bump the activity clock so
    // the monitor's long stale-fallback timer restarts.
    pty.markActivity(task.id);
    setState(task, "working");
  }

  /** Persist a new agentState (no-op when unchanged) and broadcast task:updated. */
  function setState(task: Task, state: AgentState): void {
    if (task.agentState === state) return;
    const updated = repos.tasks.update(task.id, {
      agentState: state,
      agentStateAt: new Date().toISOString(),
    });
    if (!updated) return;
    // Broadcast the hydrated task so the board upserts it on `task:updated`.
    const hydrated: Task =
      repos.tasks.getById(updated.id, { withRepos: true }) ?? updated;
    emit?.({
      kind: "task:updated",
      taskId: hydrated.id,
      projectId: hydrated.projectId,
      task: hydrated,
    });
  }

  /**
   * Find the task whose `sessionRoot` matches `cwd`. Both sides are resolved
   * through realpath so a symlinked session root still matches the cwd claude
   * reports. Returns null when no task matches (the caller responds 200, no-op).
   */
  function resolveTaskByCwd(cwd: string): Task | null {
    const target = realpathSafe(cwd);
    const tasks = repos.tasks.list();
    for (const task of tasks) {
      if (!task.sessionRoot) continue;
      if (realpathSafe(task.sessionRoot) === target) return task;
    }
    return null;
  }

  return router;
}
