/**
 * Server bootstrap.
 *
 * Instantiates the full dependency graph (db → repositories → git/pty/cleanup
 * services → task lifecycle), mounts the HTTP API, attaches the two WebSocket
 * bridges (pty terminal I/O + board-event broadcasts) onto the same port,
 * serves the built frontend statically in production, reconciles orphaned
 * worktrees on boot, and starts listening.
 *
 * The board-event broadcaster (the EventsHub) is the single source of truth for
 * `board:event` frames: it is injected into both the API routers (project/task
 * mutations) and the task lifecycle (worktree/pty side effects) so every state
 * change reaches connected boards exactly once.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { config, projectRoot } from "./config.js";
import { initDb } from "./db/index.js";
import { createRepositories } from "./db/repositories.js";
import { GitServiceImpl } from "./services/git-service.js";
import { PtyServiceImpl } from "./services/pty-service.js";
import { CleanupServiceImpl } from "./services/cleanup-service.js";
import { CommandRunnerServiceImpl } from "./services/command-runner.js";
import { FsBrowserServiceImpl } from "./services/fs-browser.js";
import { TaskLifecycleImpl } from "./lifecycle/task-lifecycle.js";
import { AgentActivityMonitor } from "./services/agent-activity-monitor.js";
import { DbViewerServiceImpl } from "./services/db-viewer.js";
import { createApiRouter, type BoardEventEmitter } from "./api/index.js";
import { setup as setupPtyBridge } from "./ws/pty-bridge.js";
import { setup as setupCmdBridge } from "./ws/cmd-bridge.js";
import { createEventsHub } from "./ws/events.js";
import { ensureAgentHooksFile } from "./services/agent-hooks.js";
import type { BoardEventMsg } from "../shared/types.js";

/** Absolute path to the built frontend (vite outputs to web/dist). */
const WEB_DIST = path.join(projectRoot, "web", "dist");

export async function main(): Promise<void> {
  // ── Dependency graph ──────────────────────────────────────────────────────
  const db = initDb(config.dbPath);
  const repos = createRepositories(db);

  const git = new GitServiceImpl(config.worktreeBaseDir);
  const pty = new PtyServiceImpl();

  // The events hub is the board-event broadcaster. The lifecycle (which emits
  // canonical BoardEventMsg frames) gets it directly; the API routers get a
  // thin adapter that stamps the `type` discriminant.
  const eventsHub = createEventsHub();
  const broadcast = (event: BoardEventMsg): void => eventsHub.broadcast(event);
  const emit: BoardEventEmitter = (event) =>
    broadcast({ type: "board:event", ...event });

  // Per-repo interactive command shell (one `bash -il` per task,repo). The
  // setup/run/teardown buttons inject their script into this shell; there is no
  // per-kind running state to broadcast. Streamed to the panel over /ws/cmd.
  const commandRunner = new CommandRunnerServiceImpl(repos);

  // CleanupServiceImpl signature is (git, pty, repos, options?). Pass the command
  // runner so teardown kills a task's running commands before worktree removal.
  const cleanup = new CleanupServiceImpl(git, pty, repos, {
    worktreeBaseDir: config.worktreeBaseDir,
    commandRunner,
  });

  const lifecycle = new TaskLifecycleImpl(repos, git, pty, cleanup, {
    broadcast,
  });

  // Read-only filesystem browser backing the repo picker (local-only).
  const fsBrowser = new FsBrowserServiceImpl(config);

  // Live DB viewer: a SEPARATE read-only connection onto the same sqlite file
  // (so app writes bump its `data_version`), polled to broadcast `db:changed`
  // frames on the events channel. Powers the `/db` route.
  const dbViewer = new DbViewerServiceImpl({
    dbPath: config.dbPath,
    broadcast: (msg) => eventsHub.broadcast(msg),
  });

  // Owns the "waiting" half of agent state: demotes a "working" task to "waiting"
  // once its pty output goes quiet. Promotion to "working" is hook-driven (see
  // api/agent-events.ts), so merely viewing/redrawing a terminal never promotes.
  // Started after boot reconciliation; its interval is unref'd so it never holds
  // the process open.
  const activityMonitor = new AgentActivityMonitor({
    repos,
    pty,
    broadcast,
    tickMs: config.idleTickMs,
    idleThresholdMs: config.idleThresholdMs,
  });

  // Materialize the Claude Code hooks settings file the spawned `claude` is given
  // via `--settings` (per-task agent-state detection). Best-effort: a write
  // failure must not block startup — the pty just spawns without the hooks.
  try {
    const hooksFile = await ensureAgentHooksFile();
    console.log(`[boot] agent hooks settings ready at ${hooksFile}`);
  } catch (err) {
    console.error("[boot] failed to write agent hooks settings file:", err);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const app = express();
  app.use(
    "/api",
    createApiRouter({
      repos,
      lifecycle,
      fsBrowser,
      pty,
      commandRunner,
      emit,
      dbViewer,
    }),
  );

  // Serve the built SPA in production, with a history-API fallback so client
  // routes (e.g. /task/:id) resolve to index.html. In dev, Vite serves the
  // frontend on its own port and proxies /api + /ws here, so this is skipped.
  if (process.env.NODE_ENV === "production" && fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/|ws\/).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, "index.html"));
    });
  }

  const server = http.createServer(app);

  // ── WebSocket bridges ───────────────────────────────────────────────────────
  // Each bridge registers its own `upgrade` handler on the shared server and
  // claims a single path, so the two channels coexist on one port:
  //   • /ws/pty?taskId=<id>                  — bidirectional agent terminal I/O
  //   • /ws/cmd?taskId=&repoId=               — bidirectional command shell I/O
  //   • /ws/events                            — server → client board events
  // Pass lifecycle.ensureAgent so the bridge revives a dead task's agent (with
  // resume args, `claude --continue`) on connect — after a dev-server restart,
  // a reboot, or the user exiting claude — before the terminal binds to its pty,
  // so the conversation continues and input works again.
  setupPtyBridge(server, pty, (taskId) => lifecycle.ensureAgent(taskId));
  setupCmdBridge(server, commandRunner);
  eventsHub.attach(server);

  // ── Boot-time reconciliation ────────────────────────────────────────────────
  // After a (re)start NO per-task pty is live yet — every per-task claude process
  // was killed when the server stopped. Any persisted agent_state ("working", …)
  // is therefore stale and would make cards/sidebar show a phantom live agent.
  // Clear it for all tasks; state is re-established when the user opens a task and
  // its agent respawns (a Stop hook then flips it). Best-effort: never block boot.
  try {
    repos.tasks.clearAllAgentStates();
    console.log("[boot] cleared stale agent_state for all tasks");
  } catch (err) {
    console.error("[boot] failed to clear stale agent states:", err);
  }

  // Start demoting quiet "working" tasks to "waiting" (promotion stays hook-driven).
  activityMonitor.start();

  // Start watching the sqlite file for commits so the /db viewer stays live.
  dbViewer.start();

  // Reclaim worktrees/branches left behind by tasks that were torn down
  // uncleanly (e.g. a crash). Best-effort: never block startup on it.
  try {
    const swept = await cleanup.sweepOrphans();
    if (
      swept.removedWorktrees.length > 0 ||
      swept.removedBranches.length > 0 ||
      swept.errors.length > 0
    ) {
      console.log(
        `[boot] sweepOrphans: removed ${swept.removedWorktrees.length} worktree(s), ` +
          `${swept.removedBranches.length} branch(es), ${swept.errors.length} error(s)`,
      );
    }
  } catch (err) {
    console.error("[boot] sweepOrphans failed:", err);
  }

  // ── Listen ────────────────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      console.log(
        `claude-kanban server listening on http://localhost:${config.port}`,
      );
      console.log(`  • API     http://localhost:${config.port}/api`);
      console.log(`  • WS pty  ws://localhost:${config.port}/ws/pty?taskId=<id>`);
      console.log(
        `  • WS cmd  ws://localhost:${config.port}/ws/cmd?taskId=<id>&repoId=<id>`,
      );
      console.log(`  • WS evts ws://localhost:${config.port}/ws/events`);
      resolve();
    });
  });
}

/** True when this module is the process entry point (tsx src/server/index.ts). */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(invoked);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error("[fatal] server failed to start:", err);
    process.exitCode = 1;
  });
}
