/**
 * Agent-events router tests (2-state hybrid model).
 *
 * The endpoint is the primary writer of agentState: an activity hook
 * (UserPromptSubmit/PreToolUse/PostToolUse/SessionStart) writes "working" (and
 * bumps the activity clock so the monitor's long fallback timer restarts); an idle
 * hook (Stop/Notification) writes "waiting" directly. These tests mount the real
 * Express router and fire HTTP requests, asserting that:
 *   • each hook event classifies to the correct nudge (hookNudge),
 *   • the cwd resolves to a task by its session_root (realpath both sides),
 *   • an activity hook promotes that task to "working" (and bumps markActivity),
 *   • an idle hook sets "waiting",
 *   • an unknown cwd / malformed body still responds 200 and does nothing.
 *
 * The repositories run on a real in-memory sqlite (schema + migration applied by
 * initDb) so cwd→task resolution uses the real session_root column.
 */
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, type DB } from "../db/index.js";
import { createRepositories } from "../db/repositories.js";
import { createAgentEventsRouter, hookNudge } from "./agent-events.js";
import { createApiRouter } from "./index.js";
import type {
  FsBrowserService,
  PtyDataListener,
  PtyExitAnyListener,
  PtyExitListener,
  PtyHandle,
  PtyService,
  Repositories,
  TaskLifecycle,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type { Task } from "../../shared/types.js";

/* ──────────────────────────────────────────────────────────────────────────
 * A recording PtyService double: it claims every task is live and records every
 * markActivity / markIdle call so we can assert the endpoint NUDGES (not writes).
 * ────────────────────────────────────────────────────────────────────────── */

class RecordingPtyService implements PtyService {
  activityNudges: string[] = [];
  idleNudges: string[] = [];
  /**
   * Output-idle ms returned by getIdleMs — HIGH by default so a Notification is
   * honored (the agent is genuinely idle at a prompt). Set LOW to simulate the
   * agent actively streaming, where a stale Notification must be ignored.
   */
  idleMs = 999_999;

  async spawnForTask(task: Task): Promise<PtyHandle> {
    return { taskId: task.id, pid: 1, cols: 80, rows: 24 };
  }
  has(_taskId: string): boolean {
    return true;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(_taskId: string, _cb: PtyDataListener): Unsubscribe {
    return () => {};
  }
  onExit(_taskId: string, _cb: PtyExitListener): Unsubscribe {
    return () => {};
  }
  onExitAny(_cb: PtyExitAnyListener): Unsubscribe {
    return () => {};
  }
  async getReplay(_taskId: string): Promise<{ data: string; offset: number }> {
    return { data: "", offset: 0 };
  }
  bytePosition(_taskId: string): number {
    return 0;
  }
  isExited(_taskId: string): boolean {
    return false;
  }
  lastExit(_taskId: string): { exitCode: number; signal: number | null } | null {
    return null;
  }
  getIdleMs(_taskId: string): number | undefined {
    return this.idleMs;
  }
  getLastOutputAt(_taskId: string): number | undefined {
    return Date.now();
  }
  markActivity(taskId: string): void {
    this.activityNudges.push(taskId);
  }
  markIdle(taskId: string): void {
    this.idleNudges.push(taskId);
  }
  async forget(_taskId: string): Promise<void> {}
}

/* ──────────────────────────────────────────────────────────────────────────
 * Test harness: a live HTTP server hosting the router + a recording pty.
 * ────────────────────────────────────────────────────────────────────────── */

let db: DB;
let repos: Repositories;
let pty: RecordingPtyService;
let server: http.Server;
let baseUrl: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ck-agent-events-"));
  db = initDb(":memory:");
  repos = createRepositories(db);
  pty = new RecordingPtyService();

  const app = express();
  app.use("/api/agent-events", createAgentEventsRouter({ repos, pty }));

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/** POST a JSON body to /api/agent-events and resolve {status}. */
async function post(body: unknown): Promise<{ status: number }> {
  const res = await fetch(`${baseUrl}/api/agent-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Drain the body so the connection is freed.
  await res.text();
  return { status: res.status };
}

/** Create a project + a task whose session_root is a real dir under tmp. */
async function makeTaskWithSessionRoot(slug: string): Promise<{
  task: Task;
  sessionRoot: string;
}> {
  const project = repos.projects.create({ name: "proj", repos: [] });
  const task = repos.tasks.create({
    projectId: project.id,
    title: `task ${slug}`,
    description: null,
    slug,
  });
  const sessionRoot = path.join(tmpRoot, slug);
  await fsp.mkdir(sessionRoot, { recursive: true });
  repos.tasks.update(task.id, { sessionRoot });
  return { task: repos.tasks.getById(task.id)!, sessionRoot };
}

/**
 * The nudges arrive asynchronously (the route answers 200 first, then does the
 * work in setImmediate). Poll until the predicate holds or we give up.
 */
async function waitFor(pred: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * hookNudge — the pure classifier.
 * ────────────────────────────────────────────────────────────────────────── */

describe("hookNudge classification", () => {
  it("maps working events to 'activity'", () => {
    expect(hookNudge("UserPromptSubmit")).toBe("activity");
    expect(hookNudge("PreToolUse")).toBe("activity");
    expect(hookNudge("PostToolUse")).toBe("activity");
    expect(hookNudge("SessionStart")).toBe("activity");
  });

  it("maps Stop and Notification (ANY type) to 'idle'", () => {
    expect(hookNudge("Stop")).toBe("idle");
    expect(hookNudge("Notification")).toBe("idle");
  });

  it("returns null for an untracked event", () => {
    expect(hookNudge("SubagentStop")).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Route: event → nudge, resolution, no state write.
 * ────────────────────────────────────────────────────────────────────────── */

describe("POST /api/agent-events (activity → working; idle → nudge clock)", () => {
  const activityCases = [
    { hook_event_name: "UserPromptSubmit" },
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
    { hook_event_name: "PostToolUse", tool_name: "Bash" },
    { hook_event_name: "SessionStart" },
  ];

  for (const event of activityCases) {
    it(`promotes to "working" for ${event.hook_event_name}`, async () => {
      const { task, sessionRoot } = await makeTaskWithSessionRoot("alpha");

      const { status } = await post({ ...event, cwd: sessionRoot });
      expect(status).toBe(200);

      await waitFor(() => pty.activityNudges.includes(task.id));
      // Bumps the activity clock (so the monitor won't demote mid-work)…
      expect(pty.activityNudges).toContain(task.id);
      expect(pty.idleNudges).not.toContain(task.id);

      // …and PROMOTES the task to "working" (promotion is hook-driven here; the
      // AgentActivityMonitor only demotes back to "waiting" on output quiet).
      await waitFor(
        () => repos.tasks.getById(task.id)!.agentState === "working",
      );
      expect(repos.tasks.getById(task.id)!.agentState).toBe("working");
    });
  }

  it("auto-moves a 'todo' task to status='running' on a working hook (working ⇒ running)", async () => {
    // A fresh task starts in "todo"; a working hook must auto-move it to the
    // "Corriendo" (running) column via the tasks.update invariant.
    const { task, sessionRoot } = await makeTaskWithSessionRoot("todo-task");
    repos.tasks.update(task.id, { status: "todo" });
    expect(repos.tasks.getById(task.id)!.status).toBe("todo");

    const { status } = await post({
      hook_event_name: "UserPromptSubmit",
      cwd: sessionRoot,
    });
    expect(status).toBe(200);

    await waitFor(() => repos.tasks.getById(task.id)!.agentState === "working");
    const after = repos.tasks.getById(task.id)!;
    expect(after.agentState).toBe("working");
    expect(after.status).toBe("running");
  });

  const idleCases = [
    { hook_event_name: "Stop" },
    { hook_event_name: "Notification", notification_type: "permission_prompt" },
    { hook_event_name: "Notification", notification_type: "idle_prompt" },
    { hook_event_name: "Notification", notification_type: "something_else" },
    { hook_event_name: "Notification" },
  ];

  for (const event of idleCases) {
    const label = event.notification_type
      ? `${event.hook_event_name}/${event.notification_type}`
      : event.hook_event_name;
    it(`sets "waiting" for ${label}`, async () => {
      const { task, sessionRoot } = await makeTaskWithSessionRoot("alpha");

      const { status } = await post({ ...event, cwd: sessionRoot });
      expect(status).toBe(200);

      // An idle hook writes "waiting" directly (no markIdle nudge anymore).
      await waitFor(
        () => repos.tasks.getById(task.id)!.agentState === "waiting",
      );
      expect(repos.tasks.getById(task.id)!.agentState).toBe("waiting");
      expect(pty.activityNudges).not.toContain(task.id);
    });
  }

  it("ignores a STALE Notification while the agent is actively streaming", async () => {
    const { task, sessionRoot } = await makeTaskWithSessionRoot("active");
    repos.tasks.update(task.id, { agentState: "working" }); // mid-turn
    pty.idleMs = 100; // fresh output → the agent is actively producing

    const { status } = await post({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      cwd: sessionRoot,
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 40));

    // The late/stale Notification was ignored → the task stays "working".
    expect(repos.tasks.getById(task.id)!.agentState).toBe("working");
  });

  it("resolves the task by session_root through a SYMLINKED cwd (realpath both sides)", async () => {
    const { task, sessionRoot } = await makeTaskWithSessionRoot("symlinked");
    const link = path.join(tmpRoot, "link-to-symlinked");
    await fsp.symlink(sessionRoot, link);

    const { status } = await post({ hook_event_name: "Stop", cwd: link });
    expect(status).toBe(200);

    // Resolved through the symlink → the Stop hook sets "waiting".
    await waitFor(() => repos.tasks.getById(task.id)!.agentState === "waiting");
    expect(repos.tasks.getById(task.id)!.agentState).toBe("waiting");
  });

  it("ignores an unknown cwd: still 200, nudges nothing", async () => {
    await makeTaskWithSessionRoot("known");

    const { status } = await post({
      hook_event_name: "Stop",
      cwd: path.join(tmpRoot, "nope-not-a-task"),
    });
    expect(status).toBe(200);

    // Give any (erroneous) async work a chance to fire, then assert nothing did.
    await new Promise((r) => setTimeout(r, 30));
    expect(pty.activityNudges).toHaveLength(0);
    expect(pty.idleNudges).toHaveLength(0);
  });

  it("ignores an untracked event: 200, nudges nothing", async () => {
    const { sessionRoot } = await makeTaskWithSessionRoot("untracked");
    const { status } = await post({
      hook_event_name: "SubagentStop",
      cwd: sessionRoot,
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(pty.activityNudges).toHaveLength(0);
    expect(pty.idleNudges).toHaveLength(0);
  });

  it("answers 200 on a malformed/empty body (never stalls the hook)", async () => {
    const res = await fetch(`${baseUrl}/api/agent-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json",
    });
    await res.text();
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(pty.activityNudges).toHaveLength(0);
    expect(pty.idleNudges).toHaveLength(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Mounted in the FULL /api router (the real production wiring).
 *
 * Behind createApiRouter a global express.json() body parser is installed. These
 * tests pin that (a) a well-formed hook still nudges the right pty method even
 * when the body arrives pre-parsed, and (b) a malformed body still answers 200
 * (json() must not 400 the hook).
 * ────────────────────────────────────────────────────────────────────────── */

/** A do-nothing TaskLifecycle stub — the agent-events path never calls it. */
const stubLifecycle: TaskLifecycle = {
  createTask: async () => {
    throw new Error("not used");
  },
  ensureAgent: async () => {},
  deleteTask: async () => {},
  deleteProject: async () => false,
};

/** A do-nothing FsBrowserService stub — the agent-events path never calls it. */
const stubFsBrowser: FsBrowserService = {
  roots: () => ({ roots: [] }),
  list: async () => {
    throw new Error("not used");
  },
  inspect: async () => {
    throw new Error("not used");
  },
};

describe("POST /api/agent-events through the full createApiRouter", () => {
  let apiDb: DB;
  let apiRepos: Repositories;
  let apiPty: RecordingPtyService;
  let apiServer: http.Server;
  let apiBaseUrl: string;
  let apiTmpRoot: string;

  beforeEach(async () => {
    apiTmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ck-api-agent-"));
    apiDb = initDb(":memory:");
    apiRepos = createRepositories(apiDb);
    apiPty = new RecordingPtyService();

    const app = express();
    app.use(
      "/api",
      createApiRouter({
        repos: apiRepos,
        lifecycle: stubLifecycle,
        fsBrowser: stubFsBrowser,
        pty: apiPty,
      }),
    );

    apiServer = http.createServer(app);
    await new Promise<void>((resolve) =>
      apiServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = apiServer.address() as AddressInfo;
    apiBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    apiDb.close();
    await fsp.rm(apiTmpRoot, { recursive: true, force: true });
  });

  async function seedTask(slug: string): Promise<{ task: Task; sessionRoot: string }> {
    const project = apiRepos.projects.create({ name: "proj", repos: [] });
    const task = apiRepos.tasks.create({
      projectId: project.id,
      title: `task ${slug}`,
      description: null,
      slug,
    });
    const sessionRoot = path.join(apiTmpRoot, slug);
    await fsp.mkdir(sessionRoot, { recursive: true });
    apiRepos.tasks.update(task.id, { sessionRoot });
    return { task: apiRepos.tasks.getById(task.id)!, sessionRoot };
  }

  async function postJson(body: unknown): Promise<number> {
    const res = await fetch(`${apiBaseUrl}/api/agent-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  }

  async function waitForApi(pred: () => boolean, tries = 50): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("sets 'waiting' for Stop even behind the global json() parser", async () => {
    const { task, sessionRoot } = await seedTask("alpha");
    const status = await postJson({ hook_event_name: "Stop", cwd: sessionRoot });
    expect(status).toBe(200);
    await waitForApi(
      () => apiRepos.tasks.getById(task.id)!.agentState === "waiting",
    );
    expect(apiRepos.tasks.getById(task.id)!.agentState).toBe("waiting");
  });

  it("promotes to 'working' for UserPromptSubmit, then 'waiting' for Notification", async () => {
    const { task, sessionRoot } = await seedTask("beta");

    expect(
      await postJson({ hook_event_name: "UserPromptSubmit", cwd: sessionRoot }),
    ).toBe(200);
    await waitForApi(
      () => apiRepos.tasks.getById(task.id)!.agentState === "working",
    );
    expect(apiPty.activityNudges).toContain(task.id);
    expect(apiRepos.tasks.getById(task.id)!.agentState).toBe("working");

    expect(
      await postJson({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        cwd: sessionRoot,
      }),
    ).toBe(200);
    await waitForApi(
      () => apiRepos.tasks.getById(task.id)!.agentState === "waiting",
    );
    expect(apiRepos.tasks.getById(task.id)!.agentState).toBe("waiting");
  });

  it("an unknown cwd still answers 200 and nudges nothing", async () => {
    await seedTask("gamma");
    const status = await postJson({
      hook_event_name: "Stop",
      cwd: path.join(apiTmpRoot, "no-such-task"),
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(apiPty.activityNudges).toHaveLength(0);
    expect(apiPty.idleNudges).toHaveLength(0);
  });

  it("answers 200 on a MALFORMED body through the full router (json() must not 400 the hook)", async () => {
    const res = await fetch(`${apiBaseUrl}/api/agent-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "definitely not json {",
    });
    await res.text();
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(apiPty.activityNudges).toHaveLength(0);
    expect(apiPty.idleNudges).toHaveLength(0);
  });
});
