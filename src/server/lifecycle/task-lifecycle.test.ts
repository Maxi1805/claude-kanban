/**
 * TaskLifecycle tests.
 *
 * Focused on the create-failure path: a partial create must NOT reimplement a
 * weaker teardown. It must delegate to CleanupService.teardownTask so it
 * inherits the death-barrier, the busy-guard, session-root + transcript
 * cleanup, port reclaim, and per-step isolation.
 *
 * Cross-module dependencies are consumed through the shared interfaces only;
 * the GitService here is the real, git-backed implementation so worktrees are
 * genuinely created (and must genuinely be handed to teardown on rollback).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lifecycle reads `config.worktreeBaseDir` at call time, so we mock the
 * config module to point the worktree base at a per-run temp dir. A mutable
 * holder lets each test swap in its own base before invoking createTask.
 */
const configHolder = {
  worktreeBaseDir: path.join(os.tmpdir(), "ck-lifecycle-fallback"),
  templateRepoPath: null as string | null,
};
vi.mock("../config.js", () => ({
  get config() {
    return {
      port: 8787,
      worktreeBaseDir: configHolder.worktreeBaseDir,
      dbPath: ":memory:",
      defaultAgentCommand: "claude",
      defaultAgentArgs: [],
      agentResumeArgs: ["--continue"],
      templateRepoPath: configHolder.templateRepoPath,
    };
  },
  projectRoot: process.cwd(),
}));

import type {
  BoardEventMsg,
  Project,
  ProjectRepo,
  Task,
  TaskRepo,
  TaskStatus,
} from "../../shared/types.js";
import type {
  CleanupService,
  PtyService,
  PtyDataListener,
  PtyExitListener,
  PtyExitAnyListener,
  PtyHandle,
  Repositories,
  SweepResult,
  TaskPatch,
  Unsubscribe,
} from "../../shared/interfaces.js";

import { GitServiceImpl } from "../services/git-service.js";
import { TaskLifecycleImpl, resolveClaudeSources } from "./task-lifecycle.js";

const execFileAsync = promisify(execFile);

/* ──────────────────────────────────────────────────────────────────────────
 * Doubles
 * ────────────────────────────────────────────────────────────────────────── */

/** Records every teardownTask call so we can assert delegation on rollback. */
class RecordingCleanupService implements CleanupService {
  teardownCalls: string[] = [];
  async teardownTask(taskId: string): Promise<void> {
    this.teardownCalls.push(taskId);
  }
  async sweepOrphans(): Promise<SweepResult> {
    return { removedWorktrees: [], removedBranches: [], errors: [] };
  }
}

/** PtyService that throws on spawn to force a post-worktree create failure. */
class ThrowingPtyService implements PtyService {
  killed: string[] = [];
  async spawnForTask(_task: Task): Promise<PtyHandle> {
    throw new Error("simulated pty spawn failure");
  }
  has(_taskId: string): boolean {
    return false;
  }
  write(): void {}
  getLastInputAt(): number | undefined {
    return undefined;
  }
  resize(): void {}
  kill(taskId: string): void {
    this.killed.push(taskId);
  }
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
    return undefined;
  }
  getLastOutputAt(_taskId: string): number | undefined {
    return undefined;
  }
  markActivity(_taskId: string): void {}
  markIdle(_taskId: string): void {}
  async forget(_taskId: string): Promise<void> {}
}

/** PtyService that succeeds so createTask runs to completion. */
class SuccessfulPtyService implements PtyService {
  async spawnForTask(task: Task): Promise<PtyHandle> {
    return { taskId: task.id, pid: 4242, cols: 80, rows: 24 };
  }
  has(_taskId: string): boolean {
    return false;
  }
  write(): void {}
  getLastInputAt(): number | undefined {
    return undefined;
  }
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
    return undefined;
  }
  getLastOutputAt(_taskId: string): number | undefined {
    return undefined;
  }
  markActivity(_taskId: string): void {}
  markIdle(_taskId: string): void {}
  async forget(_taskId: string): Promise<void> {}
}

/** Minimal in-memory Repositories, mirroring the cleanup-service test fake. */
class FakeRepositories implements Repositories {
  projectsData = new Map<string, Project>();
  projectReposData = new Map<string, ProjectRepo>();
  tasksData = new Map<string, Task>();
  taskReposData = new Map<string, TaskRepo>();
  private seq = 0;

  projects = {
    create: (): Project => {
      throw new Error("unused");
    },
    getById: (id: string): Project | null => this.projectsData.get(id) ?? null,
    list: (): Project[] => [...this.projectsData.values()],
    update: (): Project | null => null,
    delete: (id: string): boolean => this.projectsData.delete(id),
  };

  projectRepos = {
    add: (): ProjectRepo => {
      throw new Error("unused");
    },
    getById: (id: string): ProjectRepo | null =>
      this.projectReposData.get(id) ?? null,
    listByProject: (projectId: string): ProjectRepo[] =>
      [...this.projectReposData.values()].filter(
        (r) => r.projectId === projectId,
      ),
    update: (id: string): ProjectRepo | null =>
      this.projectReposData.get(id) ?? null,
    remove: (id: string): boolean => this.projectReposData.delete(id),
  };

  tasks = {
    create: (
      fields: Pick<Task, "projectId" | "title" | "description" | "slug"> &
        Partial<Pick<Task, "status">>,
    ): Task => {
      const id = `task-${this.seq++}`;
      const now = new Date().toISOString();
      const task: Task = {
        id,
        projectId: fields.projectId,
        title: fields.title,
        description: fields.description ?? null,
        status: fields.status ?? "todo",
        slug: fields.slug,
        sessionRoot: null,
        ptyPid: null,
        claudeSessionId: null,
        cavemanEnabled: false,
        cavemanLevel: null,
        cavemanSession: null,
        port: null,
        createdAt: now,
        updatedAt: now,
      };
      this.tasksData.set(id, task);
      return task;
    },
    getById: (id: string, opts?: { withRepos?: boolean }): Task | null => {
      const t = this.tasksData.get(id);
      if (!t) return null;
      if (opts?.withRepos) {
        return { ...t, repos: this.taskRepos.listByTask(id) };
      }
      return t;
    },
    list: (opts?: { projectId?: string; withRepos?: boolean }): Task[] => {
      const all = [...this.tasksData.values()];
      return opts?.projectId
        ? all.filter((t) => t.projectId === opts.projectId)
        : all;
    },
    update: (id: string, patch: TaskPatch): Task | null => {
      const t = this.tasksData.get(id);
      if (!t) return null;
      // Mirror the real SqliteTaskRepository invariant: agentState="working"
      // forces status="running" unless the same patch sets an explicit status.
      const effective: TaskPatch =
        patch.agentState === "working" && patch.status === undefined
          ? { ...patch, status: "running" }
          : patch;
      const next = { ...t, ...effective } as Task;
      this.tasksData.set(id, next);
      return next;
    },
    setStatus: (id: string, status: TaskStatus): Task | null => {
      const t = this.tasksData.get(id);
      if (!t) return null;
      t.status = status;
      return t;
    },
    clearAllAgentStates: (): void => {
      for (const t of this.tasksData.values()) {
        t.agentState = null;
        t.agentStateAt = null;
      }
    },
    delete: (id: string): boolean => this.tasksData.delete(id),
  };

  taskRepos = {
    createMany: (rows: Omit<TaskRepo, "id">[]): TaskRepo[] =>
      rows.map((r) => {
        const row: TaskRepo = { ...r, id: `tr-${this.seq++}` };
        this.taskReposData.set(row.id, row);
        return row;
      }),
    getById: (id: string): TaskRepo | null =>
      this.taskReposData.get(id) ?? null,
    listByTask: (taskId: string): TaskRepo[] =>
      [...this.taskReposData.values()].filter((r) => r.taskId === taskId),
    listTaskIdsByProjectRepo: (projectRepoId: string): string[] => [
      ...new Set(
        [...this.taskReposData.values()]
          .filter((r) => r.projectRepoId === projectRepoId)
          .map((r) => r.taskId),
      ),
    ],
    listAll: (): TaskRepo[] => [...this.taskReposData.values()],
    markPushed: (): TaskRepo | null => null,
    deleteByTask: (taskId: string): number => {
      let n = 0;
      for (const [id, r] of this.taskReposData) {
        if (r.taskId === taskId) {
          this.taskReposData.delete(id);
          n++;
        }
      }
      return n;
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Fixtures
 * ────────────────────────────────────────────────────────────────────────── */

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.dev"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# t\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Build a Claude config-source folder with a CLAUDE.md and a .claude/ dir. */
async function makeConfigSource(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
  await fs.writeFile(path.join(dir, "CLAUDE.md"), "# config\n");
  await fs.writeFile(
    path.join(dir, ".claude", "agents", "demo.md"),
    "demo agent\n",
  );
}

describe("TaskLifecycle.createTask rollback", () => {
  let tmp: string;
  let baseDir: string;
  let repos: FakeRepositories;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ck-lifecycle-"));
    baseDir = path.join(tmp, "sessions");
    await fs.mkdir(baseDir, { recursive: true });
    // Point the (mocked) lifecycle config's worktree base at the temp dir.
    configHolder.worktreeBaseDir = baseDir;
    repos = new FakeRepositories();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("delegates rollback to CleanupService.teardownTask when pty spawn fails", async () => {
    const projectId = "p1";
    const repoPath = path.join(tmp, "src-repo");
    await initRepo(repoPath);

    repos.projectsData.set(projectId, {
      id: projectId,
      name: "proj",
      createdAt: new Date().toISOString(),
    });
    repos.projectReposData.set("pr1", {
      id: "pr1",
      projectId,
      name: "repo",
      repoPath,
      baseBranch: "main",
      setupScript: null,
      runScript: null,
      teardownScript: null,
    });

    const git = new GitServiceImpl(baseDir);
    const pty = new ThrowingPtyService();
    const cleanup = new RecordingCleanupService();
    const lifecycle = new TaskLifecycleImpl(repos, git, pty, cleanup);

    await expect(
      lifecycle.createTask({ projectId, title: "do a thing" }),
    ).rejects.toThrow(/pty spawn failure/);

    // The create-failure path MUST delegate to teardownTask (not a weaker,
    // hand-rolled cleanup). Exactly the just-created task id is torn down.
    expect(cleanup.teardownCalls).toHaveLength(1);
    const taskId = cleanup.teardownCalls[0];

    // The worktrees genuinely existed (the failure was AFTER worktree creation),
    // so there was real state for teardown to handle — and the task row carries
    // the session root that was persisted up front, so teardown can find it.
    const task = repos.tasksData.get(taskId);
    expect(task?.sessionRoot).toBeTruthy();
    // task_repos were persisted before the pty step, so teardown can see them.
    expect(repos.taskRepos.listByTask(taskId)).toHaveLength(1);
  });
});

describe("TaskLifecycle.createTask — per-project Claude config", () => {
  let tmp: string;
  let baseDir: string;
  let repos: FakeRepositories;
  let repoPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ck-lifecycle-cfg-"));
    baseDir = path.join(tmp, "sessions");
    await fs.mkdir(baseDir, { recursive: true });
    configHolder.worktreeBaseDir = baseDir;
    configHolder.templateRepoPath = null;
    repos = new FakeRepositories();

    repoPath = path.join(tmp, "src-repo");
    await initRepo(repoPath);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function seedProject(
    claudeConfigPath: string | null,
    extra: {
      claudeMdPath?: string | null;
      claudeDirPath?: string | null;
      mcpConfigPath?: string | null;
      copyFiles?: string[];
    } = {},
  ): string {
    const projectId = "p1";
    repos.projectsData.set(projectId, {
      id: projectId,
      name: "proj",
      createdAt: new Date().toISOString(),
      claudeConfigPath,
      claudeMdPath: extra.claudeMdPath ?? null,
      claudeDirPath: extra.claudeDirPath ?? null,
      mcpConfigPath: extra.mcpConfigPath ?? null,
      copyFiles: extra.copyFiles ?? [],
    });
    repos.projectReposData.set("pr1", {
      id: "pr1",
      projectId,
      name: "repo",
      repoPath,
      baseBranch: "main",
      setupScript: null,
      runScript: null,
      teardownScript: null,
    });
    return projectId;
  }

  it("symlinks the PROJECT's claudeConfigPath into the session root", async () => {
    const configSrc = path.join(tmp, "project-config");
    await makeConfigSource(configSrc);
    // Global template points elsewhere to prove the project path wins.
    configHolder.templateRepoPath = null;
    const projectId = seedProject(configSrc);

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "do a thing" });
    expect(task.sessionRoot).toBeTruthy();

    expect(await exists(path.join(task.sessionRoot as string, "CLAUDE.md"))).toBe(
      true,
    );
    expect(await exists(path.join(task.sessionRoot as string, ".claude"))).toBe(
      true,
    );
    // The symlinked .claude resolves through to the agent we placed.
    expect(
      await exists(
        path.join(task.sessionRoot as string, ".claude", "agents", "demo.md"),
      ),
    ).toBe(true);
  });

  it("falls back to the GLOBAL templateRepoPath when the project has none", async () => {
    const globalSrc = path.join(tmp, "global-config");
    await makeConfigSource(globalSrc);
    configHolder.templateRepoPath = globalSrc;
    const projectId = seedProject(null);

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "fallback" });

    expect(await exists(path.join(task.sessionRoot as string, "CLAUDE.md"))).toBe(
      true,
    );
    expect(await exists(path.join(task.sessionRoot as string, ".claude"))).toBe(
      true,
    );
  });

  it("PREFERS the explicit claudeMdPath FILE + claudeDirPath DIR over the legacy folder", async () => {
    // Legacy folder still set (must be IGNORED when the new fields win).
    const legacy = path.join(tmp, "legacy-config");
    await makeConfigSource(legacy);
    await fs.writeFile(path.join(legacy, "CLAUDE.md"), "# LEGACY md\n");

    // Independent explicit sources: a standalone CLAUDE.md file and a separate
    // .claude dir, under different parents to prove they are picked individually.
    const mdFile = path.join(tmp, "explicit-md", "CLAUDE.md");
    await fs.mkdir(path.dirname(mdFile), { recursive: true });
    await fs.writeFile(mdFile, "# EXPLICIT md\n");
    const dirSrc = path.join(tmp, "explicit-dir", ".claude");
    await fs.mkdir(path.join(dirSrc, "agents"), { recursive: true });
    await fs.writeFile(path.join(dirSrc, "agents", "explicit.md"), "explicit\n");

    const projectId = seedProject(legacy, {
      claudeMdPath: mdFile,
      claudeDirPath: dirSrc,
    });

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "explicit" });
    const root = task.sessionRoot as string;

    // CLAUDE.md resolves to the EXPLICIT file, not the legacy folder's copy.
    expect((await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).trim()).toBe(
      "# EXPLICIT md",
    );
    // .claude resolves to the EXPLICIT dir (its unique agent is present).
    expect(
      await exists(path.join(root, ".claude", "agents", "explicit.md")),
    ).toBe(true);
    // The legacy folder's agent (demo.md) must NOT be present.
    expect(
      await exists(path.join(root, ".claude", "agents", "demo.md")),
    ).toBe(false);
  });

  it("symlinks the explicit mcpConfigPath FILE into the session root as .mcp.json", async () => {
    const mcpFile = path.join(tmp, "explicit-mcp", ".mcp.json");
    await fs.mkdir(path.dirname(mcpFile), { recursive: true });
    await fs.writeFile(mcpFile, '{"mcpServers":{"x":{}}}\n');

    const projectId = seedProject(null, { mcpConfigPath: mcpFile });

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "mcp" });
    const root = task.sessionRoot as string;

    expect(await exists(path.join(root, ".mcp.json"))).toBe(true);
    expect((await fs.readFile(path.join(root, ".mcp.json"), "utf8")).trim()).toBe(
      '{"mcpServers":{"x":{}}}',
    );
  });

  it("copies the project's copyFiles into each repo's worktree on create", async () => {
    // Untracked file in the source repo working dir (never committed).
    await fs.writeFile(path.join(repoPath, ".env"), "FROM_SRC=1\n");
    const projectId = seedProject(null, { copyFiles: [".env"] });

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "copy" });
    const root = task.sessionRoot as string;
    // The repo's worktree dir is named after the project repo ("repo").
    expect(await exists(path.join(root, "repo", ".env"))).toBe(true);
    expect(
      (await fs.readFile(path.join(root, "repo", ".env"), "utf8")).trim(),
    ).toBe("FROM_SRC=1");
  });

  it("mixes an explicit FILE with the legacy folder's .claude when only md is set", async () => {
    // Legacy folder provides the .claude dir; only claudeMdPath overrides the md.
    const legacy = path.join(tmp, "legacy-mixed");
    await makeConfigSource(legacy); // CLAUDE.md + .claude/agents/demo.md

    const mdFile = path.join(tmp, "explicit-md-only", "CLAUDE.md");
    await fs.mkdir(path.dirname(mdFile), { recursive: true });
    await fs.writeFile(mdFile, "# EXPLICIT md only\n");

    const projectId = seedProject(legacy, { claudeMdPath: mdFile });

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "mixed" });
    const root = task.sessionRoot as string;

    // md is the explicit file; .claude falls back to the legacy folder.
    expect((await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).trim()).toBe(
      "# EXPLICIT md only",
    );
    expect(
      await exists(path.join(root, ".claude", "agents", "demo.md")),
    ).toBe(true);
  });

  it("does NOT auto-run the repo's run script or allocate a port at create time", async () => {
    // A repo WITH a run script. Auto-run was removed (running is now a manual
    // command), so createTask must NOT allocate a port and must NOT launch it.
    const projectId = seedProject(null);
    const repo = repos.projectReposData.get("pr1");
    if (repo) repo.runScript = "echo SHOULD_NOT_RUN; sleep 30";

    const git = new GitServiceImpl(baseDir);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      git,
      new SuccessfulPtyService(),
      new RecordingCleanupService(),
    );

    const task = await lifecycle.createTask({ projectId, title: "no auto run" });

    // No port was allocated for the task (the old auto-run persisted one here).
    expect(task.port).toBeNull();
    expect(repos.tasksData.get(task.id)?.port).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * ensureAgent — first-class agent resume on (re)connect.
 * ────────────────────────────────────────────────────────────────────────── */

import type { GitService } from "../../shared/interfaces.js";

/**
 * Controllable PtyService for ensureAgent: a settable `live` flag (what `has`
 * reports), a record of every spawnForTask(task, opts) call, and an optional
 * gate so a test can hold a spawn open to drive the concurrent-connect race.
 */
class FakeResumePtyService implements PtyService {
  live = false;
  spawns: Array<{ taskId: string; resume: boolean | undefined }> = [];
  nextPid = 9001;
  /** When set, spawnForTask awaits this before resolving (race driver). */
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  /** When true, spawnForTask rejects (to test resilience). */
  failSpawn = false;
  /** Global exit subscribers (lifecycle wires one to clear agentState). */
  private exitAnyListeners = new Set<PtyExitAnyListener>();

  holdSpawn(): () => void {
    this.gate = new Promise<void>((r) => (this.releaseGate = r));
    return () => this.releaseGate?.();
  }

  /** Drive a pty exit: mark dead and fan out to global exit subscribers. */
  emitExit(taskId: string, exitCode = 0, signal: number | null = null): void {
    this.live = false;
    for (const cb of this.exitAnyListeners) cb(taskId, exitCode, signal);
  }

  async spawnForTask(
    task: Task,
    opts?: { resume?: boolean },
  ): Promise<PtyHandle> {
    this.spawns.push({ taskId: task.id, resume: opts?.resume });
    if (this.gate) await this.gate;
    if (this.failSpawn) throw new Error("simulated respawn failure");
    // A successful spawn means the pty is now live.
    this.live = true;
    return { taskId: task.id, pid: this.nextPid++, cols: 80, rows: 24 };
  }
  has(_taskId: string): boolean {
    return this.live;
  }
  write(): void {}
  getLastInputAt(): number | undefined {
    return undefined;
  }
  resize(): void {}
  kill(): void {}
  onData(_taskId: string, _cb: PtyDataListener): Unsubscribe {
    return () => {};
  }
  onExit(_taskId: string, _cb: PtyExitListener): Unsubscribe {
    return () => {};
  }
  onExitAny(cb: PtyExitAnyListener): Unsubscribe {
    this.exitAnyListeners.add(cb);
    return () => this.exitAnyListeners.delete(cb);
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
    return undefined;
  }
  getLastOutputAt(_taskId: string): number | undefined {
    return undefined;
  }
  /** Records markActivity calls so the spawn/respawn nudge can be asserted. */
  activityNudges: string[] = [];
  markActivity(taskId: string): void {
    this.activityNudges.push(taskId);
  }
  markIdle(_taskId: string): void {}
  async forget(_taskId: string): Promise<void> {}
}

/** GitService stub: ensureAgent never touches git, so every method just throws. */
const unusedGit = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error("git should not be called by ensureAgent");
      };
    },
  },
) as GitService;

describe("TaskLifecycle.ensureAgent — agent resume", () => {
  let repos: FakeRepositories;
  let tmp: string;
  let claudeProjectsDir: string;

  beforeEach(async () => {
    repos = new FakeRepositories();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ck-lifecycle-resume-"));
    claudeProjectsDir = path.join(tmp, "claude-projects");
    await fs.mkdir(claudeProjectsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Seed a task row (optionally with a session root) and return its id. */
  function seedTask(sessionRoot: string | null): string {
    const task = repos.tasks.create({
      projectId: "p1",
      title: "t",
      description: null,
      slug: "t",
      status: "running",
    });
    if (sessionRoot !== null) {
      repos.tasks.update(task.id, { sessionRoot });
    }
    return task.id;
  }

  /**
   * Encode a session root the way Claude Code names its transcript dir (mirrors
   * the lifecycle + CleanupService): non-alphanumerics → `-`.
   */
  function encodeClaudeCwd(sessionRoot: string): string {
    return path.resolve(sessionRoot).replace(/[^a-zA-Z0-9]/g, "-");
  }

  /** Drop a `<encoded-sessionRoot>/x.jsonl` so a resumable transcript exists. */
  async function seedTranscript(sessionRoot: string): Promise<void> {
    const dir = path.join(claudeProjectsDir, encodeClaudeCwd(sessionRoot));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "x.jsonl"), "{}\n");
  }

  it("respawns the agent WITH resume args when a transcript exists", async () => {
    const pty = new FakeResumePtyService();
    pty.live = false; // dead pty (e.g. after a server restart)
    const sessionRoot = "/sessions/proj/t";
    await seedTranscript(sessionRoot);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
      { claudeProjectsDir },
    );
    const taskId = seedTask(sessionRoot);

    await lifecycle.ensureAgent(taskId);

    // Exactly one respawn, carrying { resume: true } so claude --continue resumes.
    expect(pty.spawns).toEqual([{ taskId, resume: true }]);
    // The freshly spawned pid was persisted on the task.
    expect(repos.tasksData.get(taskId)?.ptyPid).toBe(9001);
    // A (re)spawned agent is IDLE — waiting for the user's prompt, NOT working.
    expect(repos.tasksData.get(taskId)?.agentState).toBe("waiting");
  });

  it("broadcasts task:updated (agentState='waiting', status unchanged) when respawning a dead task", async () => {
    const pty = new FakeResumePtyService();
    pty.live = false; // dead pty (e.g. after a server restart)
    const sessionRoot = "/sessions/proj/reopen";
    await seedTranscript(sessionRoot);

    // Record every board event the lifecycle broadcasts.
    const events: BoardEventMsg[] = [];
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
      { claudeProjectsDir, broadcast: (e) => events.push(e) },
    );

    // Seed the task in "todo": reopening must NOT move it (only an activity hook
    // promotes/moves a card), but the respawn still broadcasts its "waiting" state.
    const task = repos.tasks.create({
      projectId: "p1",
      title: "t",
      description: null,
      slug: "reopen",
      status: "todo",
    });
    repos.tasks.update(task.id, { sessionRoot });

    await lifecycle.ensureAgent(task.id);

    // The respawn set "waiting" and broadcast it — WITHOUT moving the card.
    const updated = events.find(
      (e) => e.kind === "task:updated" && e.taskId === task.id,
    );
    expect(updated).toBeDefined();
    expect(updated?.type).toBe("board:event");
    expect(updated?.projectId).toBe("p1");
    expect(updated?.task?.status).toBe("todo"); // unchanged — no auto-move on reopen
    expect(updated?.task?.agentState).toBe("waiting");
    // And the persisted row reflects it.
    expect(repos.tasksData.get(task.id)?.status).toBe("todo");
    expect(repos.tasksData.get(task.id)?.agentState).toBe("waiting");
  });

  it("respawns FRESH (resume: false) when no transcript exists", async () => {
    const pty = new FakeResumePtyService();
    pty.live = false; // dead pty
    // No transcript seeded → claudeProjectsDir is empty for this session root.
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
      { claudeProjectsDir },
    );
    const taskId = seedTask("/sessions/proj/never-spoke");

    await lifecycle.ensureAgent(taskId);

    // A fresh start so the terminal is usable (no dead `claude --continue`).
    expect(pty.spawns).toEqual([{ taskId, resume: false }]);
    expect(repos.tasksData.get(taskId)?.ptyPid).toBe(9001);
  });

  it("no-ops when the pty is already alive", async () => {
    const pty = new FakeResumePtyService();
    pty.live = true; // already live
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
    );
    const taskId = seedTask("/sessions/proj/t");

    await lifecycle.ensureAgent(taskId);

    expect(pty.spawns).toEqual([]); // never respawned
  });

  it("no-ops when the task is missing (nothing to resume)", async () => {
    const pty = new FakeResumePtyService();
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
    );

    await lifecycle.ensureAgent("does-not-exist");

    expect(pty.spawns).toEqual([]);
  });

  it("no-ops when the task has no session root (nothing to resume)", async () => {
    const pty = new FakeResumePtyService();
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
    );
    const taskId = seedTask(null); // no session root assembled

    await lifecycle.ensureAgent(taskId);

    expect(pty.spawns).toEqual([]);
  });

  it("does NOT double-spawn under two concurrent connects", async () => {
    const pty = new FakeResumePtyService();
    pty.live = false;
    const sessionRoot = "/sessions/proj/t";
    await seedTranscript(sessionRoot);
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
      { claudeProjectsDir },
    );
    const taskId = seedTask(sessionRoot);

    // Hold the first spawn open so the second connect arrives while it is in
    // flight — both must collapse onto the SAME respawn.
    const release = pty.holdSpawn();
    const a = lifecycle.ensureAgent(taskId);
    const b = lifecycle.ensureAgent(taskId);
    release();
    await Promise.all([a, b]);

    // Exactly one respawn despite two simultaneous callers.
    expect(pty.spawns).toEqual([{ taskId, resume: true }]);
  });

  it("never throws when the respawn fails (resilient)", async () => {
    const pty = new FakeResumePtyService();
    pty.live = false;
    pty.failSpawn = true;
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
    );
    const taskId = seedTask("/sessions/proj/t");

    // Must resolve, not reject, even though spawnForTask rejected.
    await expect(lifecycle.ensureAgent(taskId)).resolves.toBeUndefined();
    // The in-flight slot was released, so a later connect can retry.
    expect(pty.spawns).toHaveLength(1);
  });

  it("releases the in-flight slot so a later connect can respawn again", async () => {
    const pty = new FakeResumePtyService();
    pty.live = false;
    pty.failSpawn = true; // first respawn fails, leaving the pty dead
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      pty,
      new RecordingCleanupService(),
    );
    const taskId = seedTask("/sessions/proj/t");

    await lifecycle.ensureAgent(taskId); // fails, slot released
    pty.failSpawn = false; // next attempt succeeds
    await lifecycle.ensureAgent(taskId);

    // Two distinct respawn attempts (the first failed, the second succeeded).
    expect(pty.spawns).toHaveLength(2);
    expect(pty.live).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Exit-clears-agentState — a pty exit nulls the task's live agent state so the
 * card/sidebar stop showing a stale "working"/"waiting".
 * ────────────────────────────────────────────────────────────────────────── */

describe("TaskLifecycle — pty exit clears agentState", () => {
  let repos: FakeRepositories;

  beforeEach(() => {
    repos = new FakeRepositories();
  });

  /** Seed a task carrying a live agent state and return its id. */
  function seedWorkingTask(): string {
    const task = repos.tasks.create({
      projectId: "p1",
      title: "t",
      description: null,
      slug: "t",
      status: "running",
    });
    repos.tasks.update(task.id, {
      agentState: "working",
      agentStateAt: new Date().toISOString(),
    });
    return task.id;
  }

  it("nulls agentState (+ stamps agentStateAt) when the task's pty exits", () => {
    const pty = new FakeResumePtyService();
    // Constructing the lifecycle wires its onExitAny subscription.
    new TaskLifecycleImpl(repos, unusedGit, pty, new RecordingCleanupService());
    const taskId = seedWorkingTask();
    expect(repos.tasksData.get(taskId)?.agentState).toBe("working");

    // The agent exits (user /exit, crash, teardown) while the server runs.
    pty.emitExit(taskId, 0, null);

    const task = repos.tasksData.get(taskId)!;
    expect(task.agentState).toBeNull();
    // agentStateAt is refreshed to mark the transition time (non-null ISO).
    expect(typeof task.agentStateAt).toBe("string");
  });

  it("only clears the exiting task, leaving others' agentState intact", () => {
    const pty = new FakeResumePtyService();
    new TaskLifecycleImpl(repos, unusedGit, pty, new RecordingCleanupService());
    const a = seedWorkingTask();
    const b = seedWorkingTask();

    pty.emitExit(a, 0, null);

    expect(repos.tasksData.get(a)?.agentState).toBeNull();
    expect(repos.tasksData.get(b)?.agentState).toBe("working");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * deleteProject — tear down every task, then remove the project (no orphans).
 * ────────────────────────────────────────────────────────────────────────── */

describe("TaskLifecycle.deleteProject", () => {
  let repos: FakeRepositories;

  beforeEach(() => {
    repos = new FakeRepositories();
  });

  /** Seed a project row and return its id. */
  function seedProject(id: string): string {
    repos.projectsData.set(id, {
      id,
      name: `proj-${id}`,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  /** Seed a task under a project and return its id. */
  function seedTask(projectId: string, slug: string): string {
    const task = repos.tasks.create({
      projectId,
      title: slug,
      description: null,
      slug,
      status: "running",
    });
    return task.id;
  }

  it("tears down every task, deletes the project, and broadcasts project:deleted", async () => {
    const pid = seedProject("p1");
    const a = seedTask(pid, "a");
    const b = seedTask(pid, "b");

    const cleanup = new RecordingCleanupService();
    const events: BoardEventMsg[] = [];
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      new FakeResumePtyService(),
      cleanup,
      { broadcast: (e) => events.push(e) },
    );

    const ok = await lifecycle.deleteProject(pid);

    expect(ok).toBe(true);
    // Every task in the project was handed to the full teardown.
    expect([...cleanup.teardownCalls].sort()).toEqual([a, b].sort());
    // The project row is gone.
    expect(repos.projectsData.has(pid)).toBe(false);
    // Exactly the project:deleted board event was broadcast for this project.
    const deleted = events.find(
      (e) => e.kind === "project:deleted" && e.projectId === pid,
    );
    expect(deleted).toBeDefined();
    expect(deleted?.type).toBe("board:event");
  });

  it("returns false and tears down nothing for a missing project", async () => {
    const cleanup = new RecordingCleanupService();
    const events: BoardEventMsg[] = [];
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      new FakeResumePtyService(),
      cleanup,
      { broadcast: (e) => events.push(e) },
    );

    const ok = await lifecycle.deleteProject("does-not-exist");

    expect(ok).toBe(false);
    expect(cleanup.teardownCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("only tears down tasks of the target project", async () => {
    const p1 = seedProject("p1");
    const p2 = seedProject("p2");
    const a = seedTask(p1, "a");
    seedTask(p2, "keep"); // belongs to another project — must survive

    const cleanup = new RecordingCleanupService();
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      new FakeResumePtyService(),
      cleanup,
    );

    await lifecycle.deleteProject(p1);

    // Only p1's task was torn down; p2 (and its task) are untouched.
    expect(cleanup.teardownCalls).toEqual([a]);
    expect(repos.projectsData.has(p2)).toBe(true);
  });

  it("still deletes the project when one task's teardown throws (best-effort)", async () => {
    const pid = seedProject("p1");
    const a = seedTask(pid, "a");
    const b = seedTask(pid, "b");

    // A cleanup whose teardown rejects for task `a` but not `b`.
    class FlakyCleanup extends RecordingCleanupService {
      async teardownTask(taskId: string): Promise<void> {
        this.teardownCalls.push(taskId);
        if (taskId === a) throw new Error("boom");
      }
    }
    const cleanup = new FlakyCleanup();
    const lifecycle = new TaskLifecycleImpl(
      repos,
      unusedGit,
      new FakeResumePtyService(),
      cleanup,
    );

    const ok = await lifecycle.deleteProject(pid);

    // Both tasks were attempted despite the first throwing, and the project is
    // still removed.
    expect([...cleanup.teardownCalls].sort()).toEqual([a, b].sort());
    expect(ok).toBe(true);
    expect(repos.projectsData.has(pid)).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * resolveClaudeSources — per-source precedence, incl. the new mcpConfigPath.
 * ────────────────────────────────────────────────────────────────────────── */

describe("resolveClaudeSources — mcpConfigPath precedence", () => {
  it("prefers the explicit project.mcpConfigPath when set", () => {
    const { mcpConfigPath } = resolveClaudeSources(
      {
        claudeMdPath: null,
        claudeDirPath: null,
        claudeConfigPath: "/legacy/folder",
        mcpConfigPath: "/explicit/.mcp.json",
      },
      "/global/template",
    );
    expect(mcpConfigPath).toBe("/explicit/.mcp.json");
  });

  it("falls back to <legacy folder>/.mcp.json when no explicit path", () => {
    const { mcpConfigPath } = resolveClaudeSources(
      {
        claudeMdPath: null,
        claudeDirPath: null,
        claudeConfigPath: "/legacy/folder",
        mcpConfigPath: null,
      },
      "/global/template",
    );
    expect(mcpConfigPath).toBe(path.join("/legacy/folder", ".mcp.json"));
  });

  it("falls back to <templateRepoPath>/.mcp.json when no project sources", () => {
    const { mcpConfigPath } = resolveClaudeSources(
      {
        claudeMdPath: null,
        claudeDirPath: null,
        claudeConfigPath: null,
        mcpConfigPath: null,
      },
      "/global/template",
    );
    expect(mcpConfigPath).toBe(path.join("/global/template", ".mcp.json"));
  });

  it("yields null mcpConfigPath when nothing is configured at all", () => {
    const { mcpConfigPath } = resolveClaudeSources(
      {
        claudeMdPath: null,
        claudeDirPath: null,
        claudeConfigPath: null,
        mcpConfigPath: null,
      },
      null,
    );
    expect(mcpConfigPath).toBeNull();
  });
});
