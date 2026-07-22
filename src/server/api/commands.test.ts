/**
 * Commands API tests — NEW SHELL MODEL.
 *
 * Drives the single command route through a real Express app with a fake
 * CommandRunnerService:
 *   POST /api/tasks/:taskId/repos/:repoId/run/:kind
 *     → 200 with { port } when the script is injected,
 *     → 404 when the task/repo cannot be resolved,
 *     → 409 when the resolved script is empty/undefined,
 *     → 400 for an invalid kind.
 */
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CmdReplay,
  CommandRunnerService,
  Unsubscribe,
} from "../../shared/interfaces.js";
import type { CommandKind, RunCommandResult } from "../../shared/types.js";

import { createCommandsRouter } from "./commands.js";
import {
  CommandNotFoundError,
  CommandScriptError,
} from "../services/command-runner.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Fake runner — programmable per-(repo,kind) behaviour.
 * ────────────────────────────────────────────────────────────────────────── */

class FakeCommandRunner implements CommandRunnerService {
  /** Thrown by runScript for a given `${repoId}:${kind}`, if set. */
  runError = new Map<string, Error>();
  /** Port returned by runScript for `run` (null for setup/teardown). */
  ran: Array<{ taskId: string; repoId: string; kind: CommandKind }> = [];

  ensureShell(): void {}
  async runScript(
    taskId: string,
    repoId: string,
    kind: CommandKind,
  ): Promise<RunCommandResult> {
    const err = this.runError.get(`${repoId}:${kind}`);
    if (err) throw err;
    this.ran.push({ taskId, repoId, kind });
    return { port: kind === "run" ? 4321 : null };
  }
  onData(): Unsubscribe {
    return () => {};
  }
  onExit(): Unsubscribe {
    return () => {};
  }
  getReplay(): CmdReplay {
    return { data: "" };
  }
  isRunning(): boolean {
    return false;
  }
  write(): void {}
  resize(): void {}
  killAllForTask(): void {}
}

/* ──────────────────────────────────────────────────────────────────────────
 * Harness
 * ────────────────────────────────────────────────────────────────────────── */

let app: Express;
let runner: FakeCommandRunner;

beforeEach(() => {
  runner = new FakeCommandRunner();
  app = express();
  app.use(express.json());
  app.use("/api/tasks", createCommandsRouter({ runner }));
});

afterEach(() => {
  // no-op
});

async function post(path: string): Promise<{ status: number; body: unknown }> {
  return req("POST", path);
}

/** Issue a request against the in-process app via a throwaway listener. */
function req(
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
        });
        const text = await res.text();
        const body = text ? JSON.parse(text) : undefined;
        server.close(() => resolve({ status: res.status, body }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */

describe("POST .../repos/:repoId/run/:kind", () => {
  it("injects a run script and returns its allocated port", async () => {
    const { status, body } = await post("/api/tasks/t1/repos/r1/run/run");
    expect(status).toBe(200);
    expect(body).toEqual({ port: 4321 });
    expect(runner.ran).toEqual([{ taskId: "t1", repoId: "r1", kind: "run" }]);
  });

  it("injects a setup script and returns a null port", async () => {
    const { status, body } = await post("/api/tasks/t1/repos/r1/run/setup");
    expect(status).toBe(200);
    expect(body).toEqual({ port: null });
    expect(runner.ran).toEqual([{ taskId: "t1", repoId: "r1", kind: "setup" }]);
  });

  it("404 when the task/repo cannot be resolved", async () => {
    runner.runError.set(
      "r1:setup",
      new CommandNotFoundError("Task t1 has no worktree for repo r1"),
    );
    const { status, body } = await post("/api/tasks/t1/repos/r1/run/setup");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toContain("no worktree");
  });

  it("409 when the script is empty/undefined for that repo+kind", async () => {
    runner.runError.set(
      "r1:run",
      new CommandScriptError('No run script configured for repo "repo"'),
    );
    const { status, body } = await post("/api/tasks/t1/repos/r1/run/run");
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("No run script");
  });

  it("400 for an invalid kind (nothing injected)", async () => {
    const { status } = await post("/api/tasks/t1/repos/r1/run/bogus");
    expect(status).toBe(400);
    expect(runner.ran).toEqual([]);
  });
});
