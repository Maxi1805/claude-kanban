/**
 * API assembly. Builds the `/api` router tree from injected dependencies so the
 * server bootstrap stays in control of wiring (db, lifecycle, ws broadcaster).
 *
 *   GET    /api/health
 *   *      /api/projects ...   (createProjectsRouter)
 *   *      /api/tasks ...       (createTasksRouter)
 *
 * Cross-module dependencies are referenced exclusively through the shared
 * service interfaces — never another module's concrete file.
 */
import express, { Router, json } from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import type {
  CommandRunnerService,
  DbViewerService,
  FsBrowserService,
  PtyService,
  Repositories,
  TaskLifecycle,
} from "../../shared/interfaces.js";
import { createProjectsRouter, type BoardEventEmitter } from "./projects.js";
import { createTasksRouter } from "./tasks.js";
import { createCommandsRouter } from "./commands.js";
import { createFsRouter } from "./fs.js";
import { createAgentEventsRouter } from "./agent-events.js";
import { createDbRouter } from "./db.js";

export type { BoardEventEmitter } from "./projects.js";

export interface ApiDeps {
  repos: Repositories;
  lifecycle: TaskLifecycle;
  /** Read-only filesystem browser backing the repo picker. */
  fsBrowser: FsBrowserService;
  /**
   * The pty service whose per-task activity clock the agent-event hooks nudge
   * (the AgentActivityMonitor turns those nudges into live agent state). Optional
   * so isolated tests can omit it; the hook endpoint then no-ops on the nudge.
   */
  pty?: PtyService;
  /**
   * The per-repo command runner backing the interactive shell + the manual
   * setup/run/teardown buttons (which inject scripts into that shell). Optional
   * so isolated tests can omit it; the command route is only mounted when present.
   */
  commandRunner?: CommandRunnerService;
  /** Optional board-event broadcaster, wired by the server bootstrap. */
  emit?: BoardEventEmitter;
  /**
   * Read-only live DB viewer backing the `/db` route. Optional so isolated
   * tests can omit it; the /db routes are only mounted when present.
   */
  dbViewer?: DbViewerService;
}

/**
 * Build the `/api` router tree from injected services. Mount it on an Express
 * app at `/api`. Includes JSON body parsing and a trailing JSON error handler
 * so route failures surface as clean `{ error }` envelopes.
 */
export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();

  // Sink for Claude Code hook callbacks. Local-only, no auth; always answers 200
  // FAST so a hook never stalls the claude session. The hooks only NUDGE the
  // task's pty activity clock (the AgentActivityMonitor is the single writer of
  // agent state). Mounted BEFORE the global json() body parser on purpose: this
  // router installs its OWN raw-text parser and treats any unparseable body as
  // empty, so a malformed hook payload degrades to a 200 no-op. If json() ran
  // first it would throw a SyntaxError on bad JSON and the error handler would
  // answer 400 — breaking the always-200 hook contract. (For well-formed bodies
  // the handler also accepts an already-parsed object, so order is otherwise
  // immaterial.)
  router.use(
    "/agent-events",
    createAgentEventsRouter({ repos: deps.repos, pty: deps.pty, emit: deps.emit }),
  );

  router.use(json());

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  router.use(
    "/projects",
    createProjectsRouter({
      repos: deps.repos,
      lifecycle: deps.lifecycle,
      emit: deps.emit,
    }),
  );
  // The command route shares the /tasks mount so its path reads
  // /api/tasks/:taskId/repos/:repoId/run/:kind . Mounted BEFORE the tasks router
  // so the specific command path matches first (the tasks router's /:id would
  // otherwise shadow it). Only mounted when a runner is injected.
  if (deps.commandRunner) {
    router.use(
      "/tasks",
      createCommandsRouter({ runner: deps.commandRunner }),
    );
  }
  router.use(
    "/tasks",
    createTasksRouter({
      repos: deps.repos,
      lifecycle: deps.lifecycle,
      emit: deps.emit,
    }),
  );
  router.use("/fs", createFsRouter({ fsBrowser: deps.fsBrowser }));
  if (deps.dbViewer) {
    router.use("/db", createDbRouter({ viewer: deps.dbViewer }));
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    /* Surface a JSON parse failure from express.json() as a 400. */
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  };
  router.use(errorHandler);

  return router;
}

/**
 * Convenience: build a standalone Express app exposing the API under `/api`.
 * The server bootstrap may use this directly or mount {@link createApiRouter}
 * onto its own app alongside the WS upgrade handling.
 */
export function createApiApp(deps: ApiDeps): express.Express {
  const app = express();
  app.use("/api", createApiRouter(deps));
  return app;
}
