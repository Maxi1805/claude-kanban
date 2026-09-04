/**
 * Per-task schema routes — the declared structure behind the diagram.
 *
 *   GET    /api/tasks/:taskId/schema                     → TaskSchemaResponse
 *   POST   /api/tasks/:taskId/schema/:repoName/generate  → TaskSchemaRepo
 *   DELETE /api/tasks/:taskId/schema/:repoName           → 204
 *
 * Mounted on the /tasks path BEFORE the tasks router so these match ahead of
 * its `/:id`. An unknown task or repo answers 404; per-repo problems travel
 * inside the payload, not as failures.
 *
 * Generation runs an agent over the repo and can take minutes, so the POST is
 * deliberately long-lived — the client shows progress and waits.
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import type { SchemaInspectorService } from "../../shared/interfaces.js";
import { SchemaInspectorError } from "../services/schema-inspector.js";
import { SchemaScriptError } from "../services/schema-script.js";

export interface SchemaRouterDeps {
  inspector: SchemaInspectorService;
}

export function createSchemaRouter({ inspector }: SchemaRouterDeps): Router {
  const router = Router();

  router.get(
    "/:taskId/schema",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await inspector.forTask(req.params.taskId));
      } catch (err) {
        handle(err, res, next);
      }
    },
  );

  router.post(
    "/:taskId/schema/:repoName/generate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(
          await inspector.generateForRepo(req.params.taskId, req.params.repoName),
        );
      } catch (err) {
        handle(err, res, next);
      }
    },
  );

  router.delete(
    "/:taskId/schema/:repoName",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await inspector.deleteForRepo(req.params.taskId, req.params.repoName);
        res.status(204).end();
      } catch (err) {
        handle(err, res, next);
      }
    },
  );

  return router;
}

/**
 * Unknown task/repo → 404. A script that could not be generated or trusted is
 * the user's problem to see, not a server fault → 422 with the reason.
 */
function handle(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof SchemaInspectorError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof SchemaScriptError) {
    res.status(422).json({ error: err.message });
    return;
  }
  next(err);
}
