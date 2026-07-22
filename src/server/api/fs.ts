/**
 * Filesystem-browser router. Dependency-injected with the FsBrowserService.
 *
 * Read-only, allow-rooted directory inspection that powers the repo picker so
 * the user never types a path or a base branch. All responses are JSON,
 * camelCase, and use the Fs* shapes from `../../shared/types`.
 *
 * Routes (mounted under /api/fs):
 *   GET /api/fs/roots                              the allow-roots the picker seeds from
 *   GET /api/fs/list?path=<abs?>&includeFiles=<bool?>  shallow listing of one directory
 *   GET /api/fs/inspect?path=<abs>                 validate a folder before saving it
 *
 * Forbidden/invalid/non-existent paths surface as 400 { error }; git failures
 * never reach the client (the service degrades to null/[]).
 */
import { Router } from "express";
import type { Request, Response } from "express";

import {
  FsBrowseError,
  type FsBrowserService,
} from "../../shared/interfaces.js";

export interface FsRouterDeps {
  fsBrowser: FsBrowserService;
}

/** Read a single optional string query param (Express may give arrays). */
function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Parse a boolean-ish query param. True for "1"/"true"/"yes"/"on" (any case);
 * everything else (including absent) is false — so the default preserves the
 * existing directories-only behaviour.
 */
function queryBool(value: unknown): boolean {
  const s = queryString(value);
  if (s === undefined) return false;
  return ["1", "true", "yes", "on"].includes(s.toLowerCase());
}

export function createFsRouter(deps: FsRouterDeps): Router {
  const { fsBrowser } = deps;
  const router = Router();

  /* GET /api/fs/roots */
  router.get("/roots", (_req: Request, res: Response) => {
    res.json(fsBrowser.roots());
  });

  /* GET /api/fs/list?path=<abs|omitted>&includeFiles=<bool|omitted> */
  router.get("/list", async (req: Request, res: Response) => {
    try {
      const listing = await fsBrowser.list(queryString(req.query.path), {
        includeFiles: queryBool(req.query.includeFiles),
      });
      res.json(listing);
    } catch (err) {
      if (err instanceof FsBrowseError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err; // unexpected → trailing JSON error handler (500)
    }
  });

  /* GET /api/fs/inspect?path=<abs> */
  router.get("/inspect", async (req: Request, res: Response) => {
    const path = queryString(req.query.path);
    if (path === undefined || path.trim().length === 0) {
      res.status(400).json({ error: "`path` query param is required" });
      return;
    }
    try {
      const inspected = await fsBrowser.inspect(path);
      res.json(inspected);
    } catch (err) {
      if (err instanceof FsBrowseError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
