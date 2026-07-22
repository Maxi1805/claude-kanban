/**
 * Commands router — inject a repo's lifecycle script into its interactive shell.
 *
 * In the SHELL MODEL the Setup / Run / Teardown buttons no longer start their
 * own processes — they WRITE the configured script into the `(taskId, repoId)`
 * shell the runner owns (and `run` first exports a fresh `$PORT`). This router
 * exposes a single endpoint that triggers that injection. `repoId` is the
 * PROJECT repo id.
 *
 * Route (mounted under /api/tasks via the api assembly):
 *   POST /api/tasks/:taskId/repos/:repoId/run/:kind
 *     → ensure the repo shell exists, inject the :kind script, return { port }.
 *       404 missing task/repo, 409 empty script, 400 bad kind.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import type { CommandRunnerService } from "../../shared/interfaces.js";
import type { CommandKind } from "../../shared/types.js";

const KINDS: readonly CommandKind[] = ["setup", "run", "teardown"];

function isCommandKind(value: unknown): value is CommandKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

export interface CommandsRouterDeps {
  runner: CommandRunnerService;
}

export function createCommandsRouter(deps: CommandsRouterDeps): Router {
  const { runner } = deps;
  // mergeParams so :taskId from the parent mount (/tasks/:taskId/...) is visible.
  const router = Router({ mergeParams: true });

  /* POST /api/tasks/:taskId/repos/:repoId/run/:kind */
  router.post(
    "/:taskId/repos/:repoId/run/:kind",
    async (req: Request, res: Response) => {
      const { taskId, repoId, kind } = req.params;
      if (!isCommandKind(kind)) {
        res.status(400).json({
          error: `\`kind\` must be one of: ${KINDS.join(", ")}`,
        });
        return;
      }
      try {
        const result = await runner.runScript(taskId, repoId, kind);
        res.json(result);
      } catch (err) {
        handleCommandError(res, err);
      }
    },
  );

  return router;
}

/**
 * Map a runner error to an HTTP status:
 *   • CommandNotFoundError (missing task/repo) → 404
 *   • CommandScriptError (empty/undefined script) → 409
 *   • anything else → 500
 * Matched by error NAME so this router does not import the concrete service.
 */
function handleCommandError(res: Response, err: unknown): void {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "Internal server error";
  if (name === "CommandNotFoundError") {
    res.status(404).json({ error: message });
    return;
  }
  if (name === "CommandScriptError") {
    res.status(409).json({ error: message });
    return;
  }
  res.status(500).json({ error: message });
}
