/**
 * Tasks router tests — focused on the per-task caveman switch.
 *
 * The router runs on a real Express app over a real in-memory sqlite (schema +
 * migration applied by initDb), so requests round-trip through the real
 * validators and the real `caveman_enabled` / `caveman_level` columns. The pty
 * is a double that records what would be typed into the session, and the typing
 * timings are compressed to milliseconds.
 *
 * Contract under test:
 *   • levels are validated against the shared list (400 otherwise);
 *   • a change a RUNNING agent can act on is typed into its session;
 *   • a change it cannot act on (level while off, or an unrelated title edit)
 *     is persisted silently — the board never types into a session for nothing.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

import express, { json } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, type DB } from "../db/index.js";
import { createRepositories } from "../db/repositories.js";
import { createTasksRouter } from "./tasks.js";
import type {
  PtyDataListener,
  PtyService,
  Repositories,
  TaskLifecycle,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type { CreateTaskDTO, Task } from "../../shared/types.js";
import type { SubmitTiming } from "../services/caveman.js";

/** Compressed timings: the quiet-wait is real, just measured in milliseconds. */
const FAST: SubmitTiming = { quietMs: 5, timeoutMs: 200, submitDelayMs: 1 };

/** Records everything the server would type into a task's session. */
class FakePty {
  written = new Map<string, string>();
  killed: string[] = [];
  live = true;

  has(_taskId: string): boolean {
    return this.live;
  }
  write(taskId: string, data: string): void {
    this.written.set(taskId, (this.written.get(taskId) ?? "") + data);
  }
  onData(_taskId: string, _cb: PtyDataListener): Unsubscribe {
    return () => {};
  }
  getLastInputAt(_taskId: string): number | undefined {
    return undefined; // no human typing in these tests
  }
  kill(taskId: string): void {
    this.killed.push(taskId);
  }
  typed(taskId: string): string {
    return this.written.get(taskId) ?? "";
  }
}

let db: DB;
let repos: Repositories;
let pty: FakePty;
let server: http.Server;
let baseUrl: string;
let task: Task;

/** Poll until `predicate` holds or the deadline passes (the apply is async). */
async function eventually(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

beforeEach(async () => {
  db = initDb(":memory:");
  repos = createRepositories(db);
  pty = new FakePty();

  const project = repos.projects.create({ name: "p", repos: [] });
  task = repos.tasks.create({
    projectId: project.id,
    title: "t",
    description: null,
    slug: "t",
    status: "running",
  });

  const app = express();
  app.use(json());
  app.use(
    "/api/tasks",
    createTasksRouter({
      repos,
      // The caveman routes never touch the lifecycle; a bare double keeps the
      // test honest — any call would throw rather than pass silently.
      lifecycle: {} as TaskLifecycle,
      pty: pty as unknown as PtyService,
      cavemanTiming: FAST,
    }),
  );

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function patch(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("PATCH /api/tasks/:id — caveman", () => {
  it("defaults a new task to off with no level", () => {
    expect(task.cavemanEnabled).toBe(false);
    expect(task.cavemanLevel).toBeNull();
  });

  it("persists and returns the switch", async () => {
    const { status, json } = await patch({
      cavemanEnabled: true,
      cavemanLevel: "ultra",
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ cavemanEnabled: true, cavemanLevel: "ultra" });

    const stored = repos.tasks.getById(task.id);
    expect(stored?.cavemanEnabled).toBe(true);
    expect(stored?.cavemanLevel).toBe("ultra");
  });

  it("rejects an unknown level", async () => {
    const { status, json } = await patch({ cavemanLevel: "sarcastic" });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain("cavemanLevel");
    expect(repos.tasks.getById(task.id)?.cavemanLevel).toBeNull();
  });

  it("rejects a non-boolean switch", async () => {
    const { status } = await patch({ cavemanEnabled: "yes" });
    expect(status).toBe(400);
  });

  it("types the level command into a live session that has the plugin", async () => {
    // The session was spawned WITH caveman, so the level command means something.
    repos.tasks.update(task.id, { cavemanEnabled: true, cavemanSession: true });
    await patch({ cavemanLevel: "ultra" });
    expect(await eventually(() => pty.typed(task.id).includes("\r"))).toBe(true);
    expect(pty.typed(task.id)).toBe("/caveman:caveman ultra\r");
  });

  it("says the plugin's off phrase when switched off", async () => {
    repos.tasks.update(task.id, {
      cavemanEnabled: true,
      cavemanLevel: "lite",
      cavemanSession: true,
    });
    await patch({ cavemanEnabled: false });
    expect(await eventually(() => pty.typed(task.id).includes("\r"))).toBe(true);
    expect(pty.typed(task.id)).toBe("normal mode\r");
  });

  it("stays silent when the level changes while caveman is off", async () => {
    // Nothing a running agent can act on: the selector is just being pre-set.
    const { status } = await patch({ cavemanLevel: "wenyan-full" });
    expect(status).toBe(200);
    expect(await eventually(() => pty.typed(task.id).length > 0, 120)).toBe(false);
    expect(repos.tasks.getById(task.id)?.cavemanLevel).toBe("wenyan-full");
  });

  it("stays silent for an unrelated edit", async () => {
    repos.tasks.update(task.id, {
      cavemanEnabled: true,
      cavemanLevel: "lite",
      cavemanSession: true,
    });
    const { status } = await patch({ title: "otro título" });
    expect(status).toBe(200);
    expect(await eventually(() => pty.typed(task.id).length > 0, 120)).toBe(false);
  });

  it("types NOTHING when the live session was spawned without the plugin", async () => {
    // The bug this guards: the plugin is loaded once, at session start. Ticking
    // the box on a session that started without it produced
    // "Unknown command: /caveman" in the user's terminal and changed nothing.
    const { status, json } = await patch({ cavemanEnabled: true });
    expect(status).toBe(200);
    expect((json as { cavemanSession: boolean | null }).cavemanSession).toBeNull();
    expect(await eventually(() => pty.typed(task.id).length > 0, 120)).toBe(false);
    // Persisted all the same: the next spawn is what applies it.
    expect(repos.tasks.getById(task.id)?.cavemanEnabled).toBe(true);
  });

  it("restarts an IDLE agent by itself so the box just works", async () => {
    // Turning caveman on cannot reach a session that started without the plugin.
    // Rather than ask the user for a second action, the route respawns the agent
    // (the terminal's reconnect revives it with --continue).
    await patch({ cavemanEnabled: true });
    expect(pty.killed).toEqual([task.id]);
    expect(pty.typed(task.id)).toBe("");
  });

  it("does NOT restart an agent that is mid-turn", async () => {
    // Cutting a turn behind the user's back is never worth it; the board offers
    // the restart as a button instead.
    repos.tasks.update(task.id, { agentState: "working" });
    await patch({ cavemanEnabled: true });
    expect(pty.killed).toEqual([]);
  });

  it("does not restart when switching caveman OFF", async () => {
    // Off acts immediately ("normal mode"); the loaded plugin is merely inert
    // until the next spawn, so there is nothing to restart for.
    repos.tasks.update(task.id, { cavemanEnabled: true, cavemanSession: true });
    await patch({ cavemanEnabled: false });
    expect(await eventually(() => pty.typed(task.id).includes("\r"))).toBe(true);
    expect(pty.killed).toEqual([]);
  });

  it("still persists the switch when the task has no live agent", async () => {
    pty.live = false;
    const { status } = await patch({ cavemanEnabled: true });
    expect(status).toBe(200);
    expect(await eventually(() => pty.typed(task.id).length > 0, 120)).toBe(false);
    expect(repos.tasks.getById(task.id)?.cavemanEnabled).toBe(true);
  });
});

describe("POST /api/tasks/:id/agent/restart", () => {
  it("kills the live pty so the reconnect respawns with fresh settings", async () => {
    const res = await fetch(
      `${baseUrl}/api/tasks/${task.id}/agent/restart`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restarted: boolean; task: Task };
    expect(body.restarted).toBe(true);
    expect(pty.killed).toContain(task.id);
    expect(body.task.id).toBe(task.id);
  });

  it("is a no-op success when nothing is live", async () => {
    pty.live = false;
    const res = await fetch(
      `${baseUrl}/api/tasks/${task.id}/agent/restart`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { restarted: boolean }).restarted).toBe(false);
    expect(pty.killed).toEqual([]);
  });

  it("404s for an unknown task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nope/agent/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

/**
 * POST /api/tasks — the request validation that guards the lifecycle, and the
 * exact DTO the router hands it. Uncovered until now, and the whole point of
 * pinning it here is that the validation order is part of the contract: a bad
 * body must be a 400 BEFORE the project is looked up, so a caller never learns
 * whether a project exists by sending garbage.
 *
 * A recording lifecycle double captures the DTO; it creates the row itself so
 * the response is a real task.
 */
describe("POST /api/tasks", () => {
  let createServer: http.Server;
  let createUrl: string;
  let received: CreateTaskDTO[];
  let projectId: string;

  beforeEach(async () => {
    received = [];
    projectId = task.projectId;
    const lifecycle = {
      createTask: async (dto: CreateTaskDTO): Promise<Task> => {
        received.push(dto);
        return repos.tasks.create({
          projectId: dto.projectId,
          title: dto.title,
          description: dto.description ?? null,
          slug: dto.slug ?? "generated",
          status: "todo",
        });
      },
    } as unknown as TaskLifecycle;

    const app = express();
    app.use(json());
    app.use("/api/tasks", createTasksRouter({ repos, lifecycle }));
    createServer = http.createServer(app);
    await new Promise<void>((resolve) =>
      createServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = createServer.address() as AddressInfo;
    createUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => createServer.close(() => resolve()));
  });

  async function post(
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${createUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("creates the task and hands the lifecycle the normalized DTO", async () => {
    const res = await post({
      projectId,
      title: "nueva",
      slug: "nueva",
      projectRepoIds: ["r1"],
      cavemanEnabled: true,
      cavemanLevel: "full",
    });
    expect(res.status).toBe(201);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      projectId,
      title: "nueva",
      description: null, // absent ⇒ null, never undefined
      slug: "nueva",
      projectRepoIds: ["r1"],
      cavemanEnabled: true,
      cavemanLevel: "full",
    });
  });

  it("leaves the optional fields undefined when they were not sent", async () => {
    const res = await post({ projectId, title: "mínima" });
    expect(res.status).toBe(201);
    expect(received[0]).toEqual({
      projectId,
      title: "mínima",
      description: null,
      slug: undefined,
      projectRepoIds: undefined,
      cavemanEnabled: undefined,
      cavemanLevel: undefined,
    });
  });

  it.each([
    ["a missing projectId", { title: "t" }, "`projectId` is required and must be a non-empty string"],
    ["a blank projectId", { projectId: "  ", title: "t" }, "`projectId` is required and must be a non-empty string"],
    ["a missing title", { projectId: "p" }, "`title` is required and must be a non-empty string"],
    ["a blank title", { projectId: "p", title: " " }, "`title` is required and must be a non-empty string"],
    ["a numeric description", { projectId: "p", title: "t", description: 7 }, "`description` must be a string or null"],
    ["a blank slug", { projectId: "p", title: "t", slug: "" }, "`slug` must be a non-empty string"],
    ["projectRepoIds that is not an array", { projectId: "p", title: "t", projectRepoIds: "r1" }, "`projectRepoIds` must be an array of strings"],
    ["projectRepoIds holding a non-string", { projectId: "p", title: "t", projectRepoIds: ["r1", 2] }, "`projectRepoIds` must be an array of strings"],
    ["a non-boolean cavemanEnabled", { projectId: "p", title: "t", cavemanEnabled: "yes" }, "`cavemanEnabled` must be a boolean"],
  ])("400s on %s", async (_label, body, error) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(error);
    expect(received).toHaveLength(0);
  });

  it("400s on an unknown cavemanLevel and names the legal ones", async () => {
    const res = await post({ projectId, title: "t", cavemanLevel: "turbo" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("`cavemanLevel` must be one of:");
    expect(res.json.error).toContain("full");
    expect(received).toHaveLength(0);
  });

  it("accepts an explicit null description", async () => {
    const res = await post({ projectId, title: "t", description: null });
    expect(res.status).toBe(201);
    expect(received[0].description).toBeNull();
  });

  it("404s for an unknown project, without touching the lifecycle", async () => {
    const res = await post({ projectId: "nope", title: "t" });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("Project not found");
    expect(received).toHaveLength(0);
  });

  it("validates the body BEFORE looking the project up", async () => {
    // Unknown project AND a bad title: the body error must win, so a caller
    // can't probe for project existence with a malformed request.
    const res = await post({ projectId: "nope", title: "" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("`title` is required and must be a non-empty string");
  });

  it("400s when no body parser ran at all", async () => {
    const bare = express();
    bare.use(
      "/api/tasks",
      createTasksRouter({ repos, lifecycle: {} as TaskLifecycle }),
    );
    const srv = http.createServer(bare);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be an object" });
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});

/**
 * PATCH /api/tasks/:id — the non-caveman fields. The caveman block above covers
 * the live-session side effects; this one pins the plain field validation and
 * the task:status / task:updated split, which nothing else exercised.
 */
describe("PATCH /api/tasks/:id — title, description, status", () => {
  it("applies a partial patch and leaves untouched fields alone", async () => {
    const res = await patch({ title: "renombrada" });
    expect(res.status).toBe(200);
    const body = res.json as Task;
    expect(body.title).toBe("renombrada");
    expect(body.status).toBe("running"); // untouched
    expect(repos.tasks.getById(task.id)?.title).toBe("renombrada");
  });

  it("accepts an empty patch as a no-op that still returns the task", async () => {
    const res = await patch({});
    expect(res.status).toBe(200);
    expect((res.json as Task).title).toBe("t");
  });

  it("clears the description with an explicit null", async () => {
    const res = await patch({ description: null });
    expect(res.status).toBe(200);
    expect((res.json as Task).description).toBeNull();
  });

  it.each([
    ["a blank title", { title: "   " }, "`title` must be a non-empty string"],
    ["a numeric title", { title: 3 }, "`title` must be a non-empty string"],
    ["a numeric description", { description: 3 }, "`description` must be a string or null"],
  ])("400s on %s and writes nothing", async (_label, body, error) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe(error);
    expect(repos.tasks.getById(task.id)?.title).toBe("t");
  });

  it("400s on an unknown status and names the legal ones", async () => {
    const res = await patch({ status: "blocked" });
    expect(res.status).toBe(400);
    const { error } = res.json as { error: string };
    expect(error).toContain("`status` must be one of:");
    expect(error).toContain("review");
    expect(repos.tasks.getById(task.id)?.status).toBe("running");
  });

  it("rejects the whole patch when one field is bad, applying none of it", async () => {
    const res = await patch({ title: "ok", status: "blocked" });
    expect(res.status).toBe(400);
    expect(repos.tasks.getById(task.id)?.title).toBe("t");
  });

  it("404s for an unknown task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Task not found" });
  });

  it("checks the body before the task exists", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });
});
