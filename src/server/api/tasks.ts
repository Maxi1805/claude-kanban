/**
 * Tasks router. Dependency-injected with the repositories handle, the
 * {@link TaskLifecycle} orchestrator (create/delete side effects: worktrees,
 * session root, pty spawn, full teardown), and an optional board-event emitter.
 *
 * Routes (mounted under /api):
 *   GET    /api/tasks?projectId=&withRepos=1   list tasks for the board
 *   POST   /api/tasks                          create a task (-> lifecycle)
 *   GET    /api/tasks/:id                       fetch one task (hydrated)
 *   PATCH  /api/tasks/:id                       update title/description/status
 *   DELETE /api/tasks/:id                       delete a task (-> lifecycle)
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Repositories, TaskLifecycle } from "../../shared/interfaces.js";
import type {
  CreateTaskDTO,
  Task,
  TaskStatus,
  UpdateTaskDTO,
} from "../../shared/types.js";
import type { BoardEventEmitter } from "./projects.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "running",
  "review",
  "done",
];

export interface TasksRouterDeps {
  repos: Repositories;
  lifecycle: TaskLifecycle;
  emit?: BoardEventEmitter;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function createTasksRouter(deps: TasksRouterDeps): Router {
  const { repos, lifecycle } = deps;
  const emit: BoardEventEmitter = deps.emit ?? (() => {});
  const router = Router();

  /* GET /api/tasks?projectId=&withRepos=0
   * Repos are hydrated by DEFAULT so the board always knows each task's repos
   * (otherwise a plain refresh/board re-mount would overwrite created tasks with
   * un-hydrated copies and the cards would flip to "sin repos"). Pass
   * ?withRepos=0 to opt out. */
  router.get("/", (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const withRepos =
      req.query.withRepos !== "0" && req.query.withRepos !== "false";
    const tasks = repos.tasks.list({ projectId, withRepos });
    res.json(tasks);
  });

  /* POST /api/tasks — delegates to TaskLifecycle.createTask. */
  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "Request body must be an object" });
      return;
    }
    const b = body as Record<string, unknown>;

    if (!isNonEmptyString(b.projectId)) {
      res
        .status(400)
        .json({ error: "`projectId` is required and must be a non-empty string" });
      return;
    }
    if (!isNonEmptyString(b.title)) {
      res
        .status(400)
        .json({ error: "`title` is required and must be a non-empty string" });
      return;
    }
    if (
      b.description !== undefined &&
      b.description !== null &&
      typeof b.description !== "string"
    ) {
      res.status(400).json({ error: "`description` must be a string or null" });
      return;
    }
    if (b.slug !== undefined && !isNonEmptyString(b.slug)) {
      res.status(400).json({ error: "`slug` must be a non-empty string" });
      return;
    }
    if (b.projectRepoIds !== undefined) {
      if (
        !Array.isArray(b.projectRepoIds) ||
        !b.projectRepoIds.every((v) => typeof v === "string")
      ) {
        res
          .status(400)
          .json({ error: "`projectRepoIds` must be an array of strings" });
        return;
      }
    }

    const project = repos.projects.getById(b.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const dto: CreateTaskDTO = {
      projectId: b.projectId,
      title: b.title,
      description: (b.description as string | null | undefined) ?? null,
      slug: b.slug as string | undefined,
      projectRepoIds: b.projectRepoIds as string[] | undefined,
    };

    try {
      const task = await lifecycle.createTask(dto);
      emit({ kind: "task:created", taskId: task.id, projectId: task.projectId, task });
      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  });

  /* GET /api/tasks/:id */
  router.get("/:id", (req: Request, res: Response) => {
    const task = repos.tasks.getById(req.params.id, { withRepos: true });
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  /* PATCH /api/tasks/:id — title/description/status. */
  router.patch("/:id", (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "Request body must be an object" });
      return;
    }
    const b = body as Record<string, unknown>;
    const patch: UpdateTaskDTO = {};

    if (b.title !== undefined) {
      if (!isNonEmptyString(b.title)) {
        res.status(400).json({ error: "`title` must be a non-empty string" });
        return;
      }
      patch.title = b.title;
    }
    if (b.description !== undefined) {
      if (b.description !== null && typeof b.description !== "string") {
        res.status(400).json({ error: "`description` must be a string or null" });
        return;
      }
      patch.description = b.description as string | null;
    }
    if (b.status !== undefined) {
      if (!isTaskStatus(b.status)) {
        res.status(400).json({
          error: `\`status\` must be one of: ${TASK_STATUSES.join(", ")}`,
        });
        return;
      }
      patch.status = b.status;
    }

    const existing = repos.tasks.getById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const statusChanged =
      patch.status !== undefined && patch.status !== existing.status;

    const updated = repos.tasks.update(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const task: Task = repos.tasks.getById(updated.id, { withRepos: true }) ?? updated;
    emit({
      kind: statusChanged ? "task:status" : "task:updated",
      taskId: task.id,
      projectId: task.projectId,
      task,
    });
    res.json(task);
  });

  /* DELETE /api/tasks/:id — delegates to TaskLifecycle.deleteTask (teardown). */
  router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const task = repos.tasks.getById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    try {
      await lifecycle.deleteTask(id);
      emit({ kind: "task:deleted", taskId: id, projectId: task.projectId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
