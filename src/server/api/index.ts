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
import { Router, json } from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import type {
  CodeInspectorService,
  CommandRunnerService,
  FsBrowserService,
  PtyService,
  Repositories,
  SchemaInspectorService,
  TaskLifecycle,
} from "../../shared/interfaces.js";
import { createProjectsRouter, type BoardEventEmitter } from "./projects.js";
import { createTasksRouter } from "./tasks.js";
import { createCommandsRouter } from "./commands.js";
import { createFsRouter } from "./fs.js";
import { createAgentEventsRouter } from "./agent-events.js";
import { createSchemaRouter } from "./schema.js";
import { createCodeRouter } from "./code.js";

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
   * Reads the schema a task's worktrees declare, for the per-task diagram.
   * Optional so isolated tests can omit it; the route is only mounted when
   * present.
   */
  schemaInspector?: SchemaInspectorService;
  /**
   * Surfaces tree-sitter refactor hotspots for a task's repos, for the
   * per-task "Código" tab. Optional so isolated tests can omit it; the route
   * is only mounted when present.
   */
  codeInspector?: CodeInspectorService;
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
  mountTaskRouters(router, deps);
  router.use("/fs", createFsRouter({ fsBrowser: deps.fsBrowser }));
  router.use(apiErrorHandler);

  return router;
}

/**
 * Mount every router that shares the `/tasks` path, IN THE ORDER THAT MAKES
 * THEM MATCH. The per-task sub-resource routers (`/:taskId/repos/.../run/:kind`,
 * `/:taskId/schema`, `/:taskId/code`) go FIRST: the tasks router's own `/:id`
 * would otherwise shadow them. Each optional router is mounted only when its
 * service was injected, so isolated tests can omit it.
 *
 * Mount order is the whole contract of this function — keep the tasks router
 * last.
 */
function mountTaskRouters(router: Router, deps: ApiDeps): void {
  // The command route shares the /tasks mount so its path reads
  // /api/tasks/:taskId/repos/:repoId/run/:kind .
  if (deps.commandRunner) {
    router.use(
      "/tasks",
      createCommandsRouter({ runner: deps.commandRunner }),
    );
  }
  if (deps.schemaInspector) {
    router.use("/tasks", createSchemaRouter({ inspector: deps.schemaInspector }));
  }
  if (deps.codeInspector) {
    router.use("/tasks", createCodeRouter({ inspector: deps.codeInspector }));
  }
  router.use(
    "/tasks",
    createTasksRouter({
      repos: deps.repos,
      lifecycle: deps.lifecycle,
      emit: deps.emit,
      // Lets a caveman toggle reach the RUNNING session (the server types the
      // plugin's command into the pty) instead of waiting for a respawn.
      pty: deps.pty,
    }),
  );
}

/**
 * Trailing error handler: turns a route failure into a clean `{ error }` JSON
 * envelope instead of Express's default HTML page.
 */
const apiErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  /* Surface a JSON parse failure from express.json() as a 400. */
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
};
