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
import { SchemaInspectorServiceImpl } from "./services/schema-inspector.js";
import { CodeInspectorServiceImpl } from "./services/code-inspector.js";
import { createApiRouter, type BoardEventEmitter } from "./api/index.js";
import { setup as setupPtyBridge } from "./ws/pty-bridge.js";
import { setup as setupCmdBridge } from "./ws/cmd-bridge.js";
import { createEventsHub } from "./ws/events.js";
import { ensureAgentHooksFile } from "./services/agent-hooks.js";
import { applyCavemanOnSpawn } from "./services/caveman.js";
import type { BoardEventMsg } from "../shared/types.js";

/** Absolute path to the built frontend (vite outputs to web/dist). */
const WEB_DIST = path.join(projectRoot, "web", "dist");

export async function main(): Promise<void> {
  const services = buildServices();

  await prepareAgentHooksFile();
  wireCavemanOnSpawn(services);

  const server = createHttpServer(services);
  attachWebSocketBridges(server, services);

  clearStaleAgentStates(services);
  // Start demoting quiet "working" tasks to "waiting" (promotion stays hook-driven).
  services.activityMonitor.start();
  await sweepOrphanWorktrees(services);

  await listenAndAnnounce(server);
}

/** Everything {@link main} builds once and hands to the phases that follow. */
type BootServices = ReturnType<typeof buildServices>;

/**
 * Instantiate the whole dependency graph, in dependency order: db →
 * repositories → git/pty/command-runner/cleanup services → task lifecycle →
 * the read-only inspectors and the activity monitor. Pure construction —
 * nothing here listens, spawns, or reconciles.
 */
function buildServices() {
  const db = initDb(config.dbPath);
  const repos = createRepositories(db);

  const git = new GitServiceImpl(config.worktreeBaseDir);
  const pty = new PtyServiceImpl();

  const { eventsHub, broadcast, emit } = createBoardEventWiring();

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

  const { fsBrowser, schemaInspector, codeInspector } = buildInspectors(
    repos,
    db,
  );

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

  return {
    repos,
    pty,
    commandRunner,
    cleanup,
    lifecycle,
    fsBrowser,
    schemaInspector,
    codeInspector,
    eventsHub,
    emit,
    activityMonitor,
  };
}

/**
 * The board-event broadcaster wiring. The events hub is the single fan-out; the
 * lifecycle (which emits canonical BoardEventMsg frames) gets `broadcast`
 * directly, while the API routers get `emit` — a thin adapter that stamps the
 * `board:event` `type` discriminant onto their inner events.
 */
function createBoardEventWiring(): {
  eventsHub: ReturnType<typeof createEventsHub>;
  broadcast: (event: BoardEventMsg) => void;
  emit: BoardEventEmitter;
} {
  const eventsHub = createEventsHub();
  const broadcast = (event: BoardEventMsg): void => eventsHub.broadcast(event);
  const emit: BoardEventEmitter = (event) =>
    broadcast({ type: "board:event", ...event });
  return { eventsHub, broadcast, emit };
}

/**
 * The read-only inspectors backing the panel tabs — none depend on each other,
 * so they build together off the shared repositories/db:
 *   • fsBrowser      — the local-only filesystem browser behind the repo picker;
 *   • schemaInspector — per-task schema diagram (runs each repo's extractor and
 *     diffs against its base branch; opens no database, assumes no stack);
 *   • codeInspector   — the "Código" tab's tree-sitter hotspot detection, cached
 *     against a cheap worktree signature so parsing re-runs only when the tree
 *     actually moved.
 */
function buildInspectors(
  repos: ReturnType<typeof createRepositories>,
  db: ReturnType<typeof initDb>,
): {
  fsBrowser: FsBrowserServiceImpl;
  schemaInspector: SchemaInspectorServiceImpl;
  codeInspector: CodeInspectorServiceImpl;
} {
  const fsBrowser = new FsBrowserServiceImpl(config);
  const schemaInspector = new SchemaInspectorServiceImpl(repos, {
    dataDir: config.dataDir,
    agentCommand: config.defaultAgentCommand,
  });
  const codeInspector = new CodeInspectorServiceImpl(repos, db);
  return { fsBrowser, schemaInspector, codeInspector };
}

/**
 * Materialize the Claude Code hooks settings file the spawned `claude` is given
 * via `--settings` (per-task agent-state detection). Best-effort: a write
 * failure must not block startup — the pty just spawns without the hooks.
 * Each spawn then writes its OWN copy of this file (plus that task's caveman
 * plugin switch); this shared one is the fallback when that write fails.
 */
async function prepareAgentHooksFile(): Promise<void> {
  try {
    const hooksFile = await ensureAgentHooksFile();
    console.log(`[boot] agent hooks settings ready at ${hooksFile}`);
  } catch (err) {
    console.error("[boot] failed to write agent hooks settings file:", err);
  }
}

/**
 * Subscribe the caveman level application to every pty spawn (create, revive,
 * respawn) and record what each session actually got.
 */
function wireCavemanOnSpawn({ pty, repos, emit }: BootServices): void {
  // Caveman: the task's `--settings` file already decided whether the plugin is
  // LOADED, but its compression LEVEL has no settings key — it is only settable
  // by speaking to the session. So on every spawn (create, revive, respawn) we
  // type the level command once the terminal settles. No-op for the plugin's own
  // default level, which needs no command at all.
  pty.onSpawn((taskId) => {
    const task = repos.tasks.getById(taskId);
    if (!task) return;
    // Record what THIS session actually got. The settings file was written from
    // this same row moments ago, so the plugin is loaded iff the checkbox was on
    // at spawn. Everything after this — whether a live toggle can act, and the
    // board's "pendiente" hint — is decided against this value, not the checkbox.
    if (task.cavemanSession !== task.cavemanEnabled) {
      const updated = repos.tasks.update(taskId, {
        cavemanSession: task.cavemanEnabled,
      });
      if (updated) {
        emit({
          kind: "task:updated",
          taskId,
          projectId: updated.projectId,
          task: updated,
        });
      }
    }
    void applyCavemanOnSpawn(pty, task).catch((err: unknown) => {
      console.error(`[boot] failed to apply caveman level to ${taskId}:`, err);
    });
  });
}

/**
 * Mount the HTTP API (and, in production, the built SPA with a history-API
 * fallback) on a fresh http server. Returns it UNSTARTED: the ws bridges attach
 * to it before anything listens.
 */
function createHttpServer({
  repos,
  lifecycle,
  fsBrowser,
  pty,
  commandRunner,
  emit,
  schemaInspector,
  codeInspector,
}: BootServices): http.Server {
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
      schemaInspector,
      codeInspector,
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

  return http.createServer(app);
}

/**
 * Attach the three ws channels to the (not yet listening) http server.
 *
 * Each bridge registers its own `upgrade` handler on the shared server and
 * claims a single path, so the three channels coexist on one port:
 *   • /ws/pty?taskId=<id>                  — bidirectional agent terminal I/O
 *   • /ws/cmd?taskId=&repoId=               — bidirectional command shell I/O
 *   • /ws/events                            — server → client board events
 *
 * Pass lifecycle.ensureAgent so the pty bridge revives a dead task's agent (with
 * resume args, `claude --continue`) on connect — after a dev-server restart, a
 * reboot, or the user exiting claude — before the terminal binds to its pty, so
 * the conversation continues and input works again.
 */
function attachWebSocketBridges(
  server: http.Server,
  { pty, commandRunner, lifecycle, eventsHub }: BootServices,
): void {
  setupPtyBridge(server, pty, (taskId) => lifecycle.ensureAgent(taskId));
  setupCmdBridge(server, commandRunner);
  eventsHub.attach(server);
}

/**
 * After a (re)start NO per-task pty is live yet — every per-task claude process
 * was killed when the server stopped. Any persisted agent_state ("working", …)
 * is therefore stale and would make cards/sidebar show a phantom live agent.
 * Clear it for all tasks; state is re-established when the user opens a task and
 * its agent respawns (a Stop hook then flips it). Best-effort: never block boot.
 */
function clearStaleAgentStates({ repos }: BootServices): void {
  try {
    repos.tasks.clearAllAgentStates();
    console.log("[boot] cleared stale agent_state for all tasks");
  } catch (err) {
    console.error("[boot] failed to clear stale agent states:", err);
  }
}

/**
 * Reclaim worktrees/branches left behind by tasks that were torn down uncleanly
 * (e.g. a crash). Best-effort: never block startup on it.
 */
async function sweepOrphanWorktrees({ cleanup }: BootServices): Promise<void> {
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
}

/**
 * Start listening and print the reachable endpoints. Resolves once the server
 * is bound, so `main` only returns on a fully started board.
 */
async function listenAndAnnounce(server: http.Server): Promise<void> {
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
