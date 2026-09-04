/**
 * Per-task code hotspot route — the refactor findings behind the "Código" tab.
 *
 *   GET  /api/tasks/:taskId/code?offset=&limit=                         → TaskCodeResponse
 *   POST /api/tasks/:taskId/code/:repoName/findings/:findingId/discard  → 204  (F2)
 *   POST /api/tasks/:taskId/code/:repoName/findings/:findingId/restore  → 204  (F2)
 *
 * Mounted on the /tasks path BEFORE the tasks router so this matches ahead of
 * its `/:id`, same reasoning as schema.ts. An unknown task answers 404;
 * per-repo problems (an unreadable worktree, a parse failure) travel inside
 * the payload, not as a failed request. Discard/restore key on the STABLE
 * finding id (`CodeFinding.id`, F2) — never a line number — and persist by
 * repository, so they outlive this task and this particular analysis; see
 * `code-inspector.ts` and `db/code-decisions-repository.ts`.
 *
 * P3 — `offset`/`limit` page over the GROUP ranking `code-inspector.ts`
 * already keeps cached in full (see its docstring): absent ⇒ page 1 at the
 * historical default of 200 groups, byte-identical to before these query
 * params existed. Same validation CRITERION as `code-analyzer.ts`'s own
 * `validateLimit`/`validateOffset` (not the functions themselves — they are
 * not exported, and this module must not touch `code-analyzer.ts`):
 * `offset` an integer ≥ 0; `limit` an integer ≥ 0 or the literal
 * `"unlimited"`. Garbage answers 400 in Spanish, same style as the discard
 * route's own 400 below.
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import type { CodeInspectorService, CodePageRequest } from "../../shared/interfaces.js";
import { CodeInspectorError } from "../services/code-inspector.js";

export interface CodeRouterDeps {
  inspector: CodeInspectorService;
}

export function createCodeRouter({ inspector }: CodeRouterDeps): Router {
  const router = Router();

  router.get(
    "/:taskId/code",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const page = parsePageParams(req.query);
        if ("error" in page) {
          res.status(400).json({ error: page.error });
          return;
        }
        res.json(await inspector.forTask(req.params.taskId, page.value));
      } catch (err) {
        handle(err, res, next);
      }
    },
  );

  router.post(
    "/:taskId/code/:repoName/findings/:findingId/discard",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
        if (!reason.trim()) {
          res.status(400).json({ error: "El motivo del descarte no puede estar vacío." });
          return;
        }
        await inspector.discardCodeFinding(
          req.params.taskId,
          req.params.repoName,
          req.params.findingId,
          reason,
        );
        res.status(204).end();
      } catch (err) {
        handle(err, res, next);
      }
    },
  );

  router.post(
    "/:taskId/code/:repoName/findings/:findingId/restore",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await inspector.restoreCodeFinding(
          req.params.taskId,
          req.params.repoName,
          req.params.findingId,
        );
        res.status(204).end();
      } catch (err) {
        handle(err, res, next);
      }
    },
  );

  return router;
}

/** Unknown task → 404; anything else is a genuine server error. */
function handle(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof CodeInspectorError) {
    res.status(404).json({ error: err.message });
    return;
  }
  next(err);
}

/**
 * P3 — `?offset=&limit=` on the `GET .../code` route. Both absent is the
 * valid, common case (page 1 at the historical default) — `undefined` for a
 * missing field, never a parse attempt on `undefined`. Anything PRESENT but
 * not a bare non-negative integer (or, for `limit`, the literal
 * `"unlimited"`) is rejected outright: no clamping, no silent "closest legal
 * value" — the caller gets told, in Spanish, exactly which parameter and
 * why, same as the discard route's empty-reason 400.
 */
function parsePageParams(
  query: Request["query"],
): { value: CodePageRequest } | { error: string } {
  const offsetResult = parseNonNegativeInt(query.offset);
  if (!offsetResult.ok) {
    return { error: "El parámetro 'offset' debe ser un entero mayor o igual a 0." };
  }
  const limitResult = parseLimitParam(query.limit);
  if (!limitResult.ok) {
    return { error: "El parámetro 'limit' debe ser un entero mayor o igual a 0, o 'unlimited'." };
  }
  return { value: { offset: offsetResult.value, limit: limitResult.value } };
}

type ParseResult<T> = { ok: true; value: T | undefined } | { ok: false };

/** A bare `^\d+$` string ⇒ its integer value; absent ⇒ `undefined`; anything else ⇒ invalid. */
function parseNonNegativeInt(raw: unknown): ParseResult<number> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return { ok: false };
  const n = Number(raw);
  return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: false };
}

/** Same as {@link parseNonNegativeInt}, plus the `"unlimited"` literal. */
function parseLimitParam(raw: unknown): ParseResult<number | "unlimited"> {
  if (raw === "unlimited") return { ok: true, value: "unlimited" };
  return parseNonNegativeInt(raw);
}
