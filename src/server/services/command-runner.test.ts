/**
 * CommandRunnerService tests — NEW SHELL MODEL.
 *
 * Verifies the per-(task,repo) interactive shell: ensureShell spawns ONE
 * `bash -il` at the task's worktree cwd (parent env) and is idempotent; runScript
 * injects the right text into the shell (setup/teardown → `<script>\n`; run →
 * `export PORT=<port>\n` then `<script>\n`, returning that port); the capped
 * in-memory replay buffer + onData/onExit fan-out; the clear errors when the
 * task/repo/script is missing (and that NOTHING is injected then); write/resize
 * target the shell; and killAllForTask kills + forgets the task's shells.
 *
 * node-pty is MOCKED with a controllable fake whose `write`s are captured, so the
 * injection paths are asserted without spawning a real interactive shell.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectRepoRepository,
  Repositories,
  TaskRepoRepository,
  TaskRepository,
} from "../../shared/interfaces.js";
import type { ProjectRepo, Task, TaskRepo } from "../../shared/types.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Mocked node-pty — a controllable fake process recording spawn args + writes.
 * ────────────────────────────────────────────────────────────────────────── */

interface FakeProc {
  pid: number;
  cwd: string;
  env: Record<string, string>;
  command: string;
  args: string[];
  writes: string[];
  killed: boolean;
  onData(cb: (d: { toString?: () => string } | string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
  /* test drivers */
  emit(d: string): void;
  exit(code: number, signal?: number): void;
}

/** Every spawned fake proc, in spawn order (one per live shell). */
let spawned: FakeProc[] = [];
let nextPid = 1000;

function makeFakeProc(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): FakeProc {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const proc: FakeProc = {
    pid: nextPid++,
    cwd: opts.cwd,
    env: opts.env,
    command,
    args,
    writes: [],
    killed: false,
    onData(cb) {
      dataCb = cb as (d: string) => void;
    },
    onExit(cb) {
      exitCb = cb;
    },
    write(d) {
      proc.writes.push(d);
    },
    resize() {},
    kill() {
      proc.killed = true;
    },
    emit(d) {
      dataCb?.(d);
    },
    exit(code, signal) {
      exitCb?.({ exitCode: code, signal });
    },
  };
  return proc;
}

vi.mock("node-pty", () => ({
  spawn: (
    command: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) => {
    const proc = makeFakeProc(command, args, opts);
    spawned.push(proc);
    return proc;
  },
}));

import {
  CommandRunnerServiceImpl,
  CommandNotFoundError,
  CommandScriptError,
} from "./command-runner.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Minimal in-memory Repositories — only the methods the runner touches.
 * ────────────────────────────────────────────────────────────────────────── */

class FakeRepositories implements Repositories {
  tasksData = new Map<string, Task>();
  projectReposData = new Map<string, ProjectRepo>();

  projects = {} as Repositories["projects"];

  projectRepos: ProjectRepoRepository = {
    add: () => {
      throw new Error("unused");
    },
    getById: (id: string): ProjectRepo | null =>
      this.projectReposData.get(id) ?? null,
    listByProject: (): ProjectRepo[] => [],
    update: () => null,
    remove: () => false,
  };

  tasks: TaskRepository = {
    create: () => {
      throw new Error("unused");
    },
    getById: (id: string, opts?: { withRepos?: boolean }): Task | null => {
      const t = this.tasksData.get(id);
      if (!t) return null;
      // The runner always asks withRepos; repos are stored inline on the task.
      return opts?.withRepos ? t : { ...t, repos: undefined };
    },
    list: () => [],
    update: () => null,
    setStatus: () => null,
    clearAllAgentStates: () => {},
    delete: () => false,
  };

  taskRepos = {} as TaskRepoRepository;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Harness
 * ────────────────────────────────────────────────────────────────────────── */

let tmp: string;
let worktree: string;
let repos: FakeRepositories;

const TASK_ID = "task-1";
const REPO_ID = "repo-1";

beforeEach(async () => {
  spawned = [];
  nextPid = 1000;

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ck-cmd-"));
  worktree = path.join(tmp, "worktree");
  await fs.mkdir(worktree, { recursive: true });

  repos = new FakeRepositories();
  const taskRepo: TaskRepo = {
    id: "tr-1",
    taskId: TASK_ID,
    projectRepoId: REPO_ID,
    repoName: "repo",
    branchName: "task-1",
    worktreePath: worktree,
    remotePushed: false,
  };
  repos.tasksData.set(TASK_ID, {
    id: TASK_ID,
    projectId: "p1",
    title: "task",
    description: null,
    status: "running",
    slug: "task-1",
    sessionRoot: tmp,
    ptyPid: null,
    claudeSessionId: null,
    port: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repos: [taskRepo],
  });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function seedRepo(scripts: Partial<ProjectRepo>): void {
  repos.projectReposData.set(REPO_ID, {
    id: REPO_ID,
    projectId: "p1",
    name: "repo",
    repoPath: path.join(tmp, "src-repo"),
    baseBranch: "main",
    setupScript: null,
    runScript: null,
    teardownScript: null,
    ...scripts,
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */

describe("CommandRunnerService.ensureShell", () => {
  it("spawns ONE interactive bash at the task's worktree cwd with the parent env", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);

    runner.ensureShell(TASK_ID, REPO_ID);

    expect(spawned).toHaveLength(1);
    const proc = spawned[0];
    expect(proc.command).toBe("bash");
    // Interactive login shell so the user gets a real prompt to type into.
    expect(proc.args).toEqual(["-il"]);
    expect(proc.cwd).toBe(worktree);
    // Parent env is passed through (a representative key from process.env).
    expect(proc.env.PATH).toBe(process.env.PATH);
    expect(runner.isRunning(TASK_ID, REPO_ID)).toBe(true);
  });

  it("is idempotent — a live shell is reused, never a second pty", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);

    runner.ensureShell(TASK_ID, REPO_ID);
    runner.ensureShell(TASK_ID, REPO_ID);

    expect(spawned).toHaveLength(1);
  });

  it("throws when the task is unknown (nothing spawned)", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    expect(() => runner.ensureShell("nope", REPO_ID)).toThrow(
      CommandNotFoundError,
    );
    expect(spawned).toHaveLength(0);
  });

  it("throws when the repo is not a worktree of the task", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    expect(() => runner.ensureShell(TASK_ID, "other-repo")).toThrow(
      CommandNotFoundError,
    );
    expect(spawned).toHaveLength(0);
  });
});

describe("CommandRunnerService.runScript — injection", () => {
  it("ensures the shell and writes `<script>\\n` for setup", async () => {
    seedRepo({ setupScript: "npm install" });
    const runner = new CommandRunnerServiceImpl(repos);

    const result = await runner.runScript(TASK_ID, REPO_ID, "setup");

    expect(spawned).toHaveLength(1);
    expect(result.port).toBeNull();
    expect(spawned[0].writes).toEqual(["npm install\n"]);
  });

  it("writes `<script>\\n` for teardown", async () => {
    seedRepo({ teardownScript: "docker compose down" });
    const runner = new CommandRunnerServiceImpl(repos);

    const result = await runner.runScript(TASK_ID, REPO_ID, "teardown");

    expect(result.port).toBeNull();
    expect(spawned[0].writes).toEqual(["docker compose down\n"]);
  });

  it("exports a fresh $PORT BEFORE the run script and returns that port", async () => {
    seedRepo({ runScript: "npm run dev" });
    const runner = new CommandRunnerServiceImpl(repos);

    const result = await runner.runScript(TASK_ID, REPO_ID, "run");

    expect(result.port).toBeGreaterThan(0);
    expect(spawned[0].writes).toEqual([
      `export PORT=${result.port}\n`,
      "npm run dev\n",
    ]);
  });

  it("reuses the SAME shell across multiple injections", async () => {
    seedRepo({ setupScript: "setup.sh", runScript: "run.sh" });
    const runner = new CommandRunnerServiceImpl(repos);

    await runner.runScript(TASK_ID, REPO_ID, "setup");
    const run = await runner.runScript(TASK_ID, REPO_ID, "run");

    expect(spawned).toHaveLength(1);
    expect(spawned[0].writes).toEqual([
      "setup.sh\n",
      `export PORT=${run.port}\n`,
      "run.sh\n",
    ]);
  });

  it("throws CommandScriptError (and injects nothing) when the script is empty", async () => {
    seedRepo({ runScript: "   " }); // whitespace-only → empty
    const runner = new CommandRunnerServiceImpl(repos);

    await expect(runner.runScript(TASK_ID, REPO_ID, "run")).rejects.toBeInstanceOf(
      CommandScriptError,
    );
    // The script was resolved BEFORE the shell — nothing spawned, nothing written.
    expect(spawned).toHaveLength(0);
    expect(runner.isRunning(TASK_ID, REPO_ID)).toBe(false);
  });

  it("throws CommandNotFoundError when the task is unknown", async () => {
    seedRepo({ setupScript: "echo hi" });
    const runner = new CommandRunnerServiceImpl(repos);
    await expect(
      runner.runScript("nope", REPO_ID, "setup"),
    ).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it("throws CommandNotFoundError when the repo is not a worktree of the task", async () => {
    seedRepo({ setupScript: "echo hi" });
    const runner = new CommandRunnerServiceImpl(repos);
    await expect(
      runner.runScript(TASK_ID, "other-repo", "setup"),
    ).rejects.toBeInstanceOf(CommandNotFoundError);
  });
});

describe("CommandRunnerService — replay buffer + fan-out", () => {
  it("buffers shell output for replay and fans it out to onData subscribers", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    runner.ensureShell(TASK_ID, REPO_ID);

    const seen: string[] = [];
    runner.onData(TASK_ID, REPO_ID, (d) => seen.push(d));

    spawned[0].emit("user@host:~$ ");
    spawned[0].emit("ls\r\n");

    expect(seen).toEqual(["user@host:~$ ", "ls\r\n"]);
    expect(runner.getReplay(TASK_ID, REPO_ID).data).toBe("user@host:~$ ls\r\n");
  });

  it("onData/onExit/getReplay/isRunning work BEFORE a shell exists (placeholder record)", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);

    // Subscribing before ensureShell creates a placeholder; no spawn yet.
    const seen: string[] = [];
    runner.onData(TASK_ID, REPO_ID, (d) => seen.push(d));
    expect(runner.isRunning(TASK_ID, REPO_ID)).toBe(false);
    expect(runner.getReplay(TASK_ID, REPO_ID).data).toBe("");
    expect(spawned).toHaveLength(0);

    // The same subscription receives output once the shell spawns.
    runner.ensureShell(TASK_ID, REPO_ID);
    spawned[0].emit("hi");
    expect(seen).toEqual(["hi"]);
  });

  it("fires onExit listeners when the shell dies", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    runner.ensureShell(TASK_ID, REPO_ID);

    const exits: Array<number | null> = [];
    runner.onExit(TASK_ID, REPO_ID, (code) => exits.push(code));

    spawned[0].exit(0);
    expect(exits).toEqual([0]);
    expect(runner.isRunning(TASK_ID, REPO_ID)).toBe(false);
  });
});

describe("CommandRunnerService — write + resize target the shell", () => {
  it("write forwards user keystrokes to the shell pty", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    runner.ensureShell(TASK_ID, REPO_ID);

    runner.write(TASK_ID, REPO_ID, "echo hi\n");
    expect(spawned[0].writes).toEqual(["echo hi\n"]);
  });

  it("write is a no-op when no shell is live", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    // No throw, nothing spawned.
    expect(() => runner.write(TASK_ID, REPO_ID, "x")).not.toThrow();
    expect(spawned).toHaveLength(0);
  });

  it("resize remembers dimensions and applies them to a live shell", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    runner.ensureShell(TASK_ID, REPO_ID);
    // Should not throw; the fake resize is a no-op but the call path is exercised.
    expect(() => runner.resize(TASK_ID, REPO_ID, 120, 40)).not.toThrow();
  });
});

describe("CommandRunnerService.killAllForTask", () => {
  it("kills every shell for the task (process group) and forgets its state", () => {
    seedRepo({});
    const runner = new CommandRunnerServiceImpl(repos);
    runner.ensureShell(TASK_ID, REPO_ID);
    expect(runner.isRunning(TASK_ID, REPO_ID)).toBe(true);

    runner.killAllForTask(TASK_ID);

    expect(spawned[0].killed).toBe(true);
    expect(runner.isRunning(TASK_ID, REPO_ID)).toBe(false);
    // State is forgotten: replay is empty again (fresh placeholder on next read).
    expect(runner.getReplay(TASK_ID, REPO_ID).data).toBe("");
  });

  it("is a no-op for a task with no shells", () => {
    const runner = new CommandRunnerServiceImpl(repos);
    expect(() => runner.killAllForTask("ghost")).not.toThrow();
  });
});
