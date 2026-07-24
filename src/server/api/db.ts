/**
 * Live DB viewer routes — a thin HTTP face over DbViewerService.
 *
 *   GET /api/db                       → DbOverviewResponse (schema + counts)
 *   GET /api/db/tables/:name/rows     → DbTableRowsResponse (?limit&offset)
 *
 * Read-only by construction (the service holds a readonly connection). An
 * unknown table surfaces as 404; anything else falls through to the shared
 * JSON error handler.
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import {
  DbViewerError,
  type DbViewerService,
} from "../../shared/interfaces.js";

export interface DbRouterDeps {
  viewer: DbViewerService;
}

export function createDbRouter({ viewer }: DbRouterDeps): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(viewer.overview());
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/tables/:name/rows",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = parseIntParam(req.query.limit);
        const offset = parseIntParam(req.query.offset);
        res.json(viewer.tableRows(req.params.name, { limit, offset }));
      } catch (err) {
        if (err instanceof DbViewerError) {
          res.status(404).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}

/** Parse an optional numeric query param; undefined on absent/garbage. */
function parseIntParam(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
