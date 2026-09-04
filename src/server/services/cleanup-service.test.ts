/**
 * CleanupService tests.
 *
 * These exercise the real teardown checklist against REAL temporary git repos
 * (so worktree removal, branch deletion, and prune are genuinely verified),
 * a fake PtyService that records kills, and an in-memory Repositories fake.
 *
 * The GitService used here is a small, real, git-backed implementation that
 * satisfies the shared GitService interface — we deliberately do NOT import any
 * sibling concrete module (cross-module references go through types only).
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  Project,
  ProjectRepo,
  Task,
  TaskRepo,
  TaskStatus,
} from "../../shared/types.js";
import type {
  CreateTaskWorktreesOptions,
  CreateTaskWorktreesResult,
  GitService,
  PtyService,
  Repositories,
  WorktreeInfo,
  PtyDataListener,
  PtyExitListener,
  PtyExitAnyListener,
  Unsubscribe,
  PtyHandle,
  TaskPatch,
} from "../../shared/interfaces.js";

import {
  CleanupServiceImpl,
  type CleanupLogger,
  type CleanupServiceOptions,
} from "./cleanup-service.js";

const execAsync = promisify(exec);

/* ──────────────────────────────────────────────────────────────────────────
 * Test doubles
 * ────────────────────────────────────────────────────────────────────────── */

/** PtyService fake that records which task ids were killed and forgotten. */
class FakePtyService implements PtyService {
  killed: string[] = [];
  forgotten: string[] = [];
  /** Order of (kill | delete-log | forget) operations, to assert sequencing. */
  ops: string[] = [];
  /** Hook fired when forget() runs, so a test can assert it flushes before delete. */
  onForget: ((taskId: string) => void | Promise<void>) | null = null;
  async spawnForTask(task: Task): Promise<PtyHandle> {
    return { taskId: task.id, pid: 0, cols: 80, rows: 24 };
  }
  has(_taskId: string): boolean {
    return false;
  }
  write(): void {}
  resize(): void {}
  kill(taskId: string): void {
    this.killed.push(taskId);
    this.ops.push(`kill:${taskId}`);
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
  async forget(taskId: string): Promise<void> {
    this.forgotten.push(taskId);
    this.ops.push(`forget:${taskId}`);
    await this.onForget?.(taskId);
  }
}

/** In-memory Repositories fake. Only the methods CleanupService uses matter. */
class FakeRepositories implements Repositories {
  projectsData = new Map<string, Project>();
  projectReposData = new Map<string, ProjectRepo>();
  tasksData = new Map<string, Task>();
  taskReposData = new Map<string, TaskRepo>();

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
    create: (): Task => {
      throw new Error("unused");
    },
    getById: (id: string): Task | null => this.tasksData.get(id) ?? null,
    list: (opts?: { projectId?: string; withRepos?: boolean }): Task[] => {
      const all = [...this.tasksData.values()];
      return opts?.projectId
        ? all.filter((t) => t.projectId === opts.projectId)
        : all;
    },
    update: (id: string, patch: TaskPatch): Task | null => {
      const t = this.tasksData.get(id);
      if (!t) return null;
      const next = { ...t, ...patch } as Task;
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
      rows.map((r, i) => {
        const row: TaskRepo = { ...r, id: `tr-${i}-${Math.random()}` };
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

  /* test seeding helpers */
  addProject(p: Project): void {
    this.projectsData.set(p.id, p);
  }
  addProjectRepo(r: ProjectRepo): void {
    this.projectReposData.set(r.id, r);
  }
  addTask(t: Task): void {
    this.tasksData.set(t.id, t);
  }
  addTaskRepo(r: TaskRepo): void {
    this.taskReposData.set(r.id, r);
  }
}

/**
 * A real, minimal, git-backed GitService that satisfies the shared interface.
 * Used so worktree/branch operations are genuinely exercised. `busyOverride`
 * lets a single test force `isWorktreeBusy` to a fixed value for a path.
 */
class RealGitService implements GitService {
  pruned: string[] = [];
  localBranchesDeleted: Array<{ repoPath: string; branch: string }> = [];
  remoteBranchesDeleted: Array<{ repoPath: string; branch: string }> = [];
  /** Map of absolute worktree path -> forced busy value. */
  busyOverride = new Map<string, boolean>();

  async createTaskWorktrees(
    _opts: CreateTaskWorktreesOptions,
  ): Promise<CreateTaskWorktreesResult> {
    throw new Error("unused in these tests");
  }

  async removeTaskWorktrees(taskRepos: TaskRepo[]): Promise<void> {
    for (const tr of taskRepos) {
      // Find the owning repo by walking up to a .git or by trying each known
      // repo; here we just run from the worktree path itself.
      const repoRoot = await findSourceRepoForWorktree(tr.worktreePath);
      if (repoRoot) {
        await execAsync(
          `git worktree remove --force ${quote(tr.worktreePath)}`,
          { cwd: repoRoot },
        ).catch(async () => {
          // Fall back to forcibly removing the directory.
          await fs.rm(tr.worktreePath, { recursive: true, force: true });
        });
      } else {
        await fs.rm(tr.worktreePath, { recursive: true, force: true });
      }
    }
  }

  async deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
    this.localBranchesDeleted.push({ repoPath, branch });
    await execAsync(`git branch -D ${quote(branch)}`, { cwd: repoPath });
  }

  async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    this.remoteBranchesDeleted.push({ repoPath, branch });
    // best-effort: no remote in these tests, so swallow.
    await execAsync(`git push origin --delete ${quote(branch)}`, {
      cwd: repoPath,
    }).catch(() => undefined);
  }

  async pruneWorktrees(repoPath: string): Promise<void> {
    this.pruned.push(repoPath);
    await execAsync("git worktree prune", { cwd: repoPath });
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoPath,
    });
    const infos: WorktreeInfo[] = [];
    let cur: Partial<WorktreeInfo> = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur.path) infos.push(finalizeWt(cur));
        cur = { path: line.slice("worktree ".length), locked: false };
      } else if (line.startsWith("HEAD ")) {
        cur.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
      } else if (line === "bare" || line === "detached") {
        cur.isMain = line === "bare";
      } else if (line.startsWith("locked")) {
        cur.locked = true;
      }
    }
    if (cur.path) infos.push(finalizeWt(cur));
    return infos;
  }

  async isWorktreeBusy(p: string): Promise<boolean> {
    const abs = path.resolve(p);
    if (this.busyOverride.has(abs)) return this.busyOverride.get(abs) as boolean;
    return false;
  }

  async assembleSessionRoot(): Promise<void> {
    // unused in these tests
  }
}

function finalizeWt(cur: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: cur.path as string,
    branch: cur.branch ?? null,
    head: cur.head ?? null,
    isMain: cur.isMain ?? false,
    locked: cur.locked ?? false,
  };
}

/** Capture log lines for assertions. */
class CapturingLogger implements CleanupLogger {
  infos: string[] = [];
  warns: string[] = [];
  info(m: string): void {
    this.infos.push(m);
  }
  warn(m: string): void {
    this.warns.push(m);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Git fixture helpers
 * ────────────────────────────────────────────────────────────────────────── */

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Find the source repo that owns a worktree by checking each candidate. */
async function findSourceRepoForWorktree(
  worktreePath: string,
): Promise<string | null> {
  // Read .git file inside the worktree to discover the source gitdir.
  try {
    const gitFile = path.join(worktreePath, ".git");
    const content = await fs.readFile(gitFile, "utf8");
    // "gitdir: /abs/source/.git/worktrees/<name>"
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (m) {
      const wtAdminDir = m[1].trim();
      // .../.git/worktrees/<name> -> source repo root is two levels up from .git
      const gitDir = path.resolve(wtAdminDir, "..", "..");
      return path.dirname(gitDir);
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Initialise a bare-of-remote local git repo with one commit on `main`. */
async function initRepo(repoPath: string): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true });
  await execAsync("git init -b main", { cwd: repoPath });
  await execAsync("git config user.email test@test.dev", { cwd: repoPath });
  await execAsync("git config user.name Test", { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "# test\n");
  await execAsync("git add -A", { cwd: repoPath });
  await execAsync('git commit -m init', { cwd: repoPath });
}

/** Create a worktree on a new branch under `worktreePath`. */
async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await execAsync(
    `git worktree add -b ${quote(branch)} ${quote(worktreePath)} main`,
    { cwd: repoPath },
  );
}

async function branchExists(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  try {
    await execAsync(
      `git rev-parse --verify ${quote("refs/heads/" + branch)}`,
      { cwd: repoPath },
    );
    return true;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Test scaffolding
 * ────────────────────────────────────────────────────────────────────────── */

interface Harness {
  tmp: string;
  worktreeBase: string;
  claudeProjects: string;
  ptyLogDir: string;
  repos: FakeRepositories;
  pty: FakePtyService;
  git: RealGitService;
  logger: CapturingLogger;
  service: CleanupServiceImpl;
}

let harness: Harness;

async function makeHarness(): Promise<Harness> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ck-cleanup-"));
  const worktreeBase = path.join(tmp, "sessions");
  const claudeProjects = path.join(tmp, "claude-projects");
  const ptyLogDir = path.join(tmp, "pty-logs");
  await fs.mkdir(worktreeBase, { recursive: true });
  await fs.mkdir(claudeProjects, { recursive: true });
  await fs.mkdir(ptyLogDir, { recursive: true });

  const repos = new FakeRepositories();
  const pty = new FakePtyService();
  const git = new RealGitService();
  const logger = new CapturingLogger();

  const options: CleanupServiceOptions = {
    worktreeBaseDir: worktreeBase,
    claudeProjectsDir: claudeProjects,
    ptyLogDir,
    logger,
    ptyDeathTimeoutMs: 200,
  };
  const service = new CleanupServiceImpl(git, pty, repos, options);

  return {
    tmp,
    worktreeBase,
    claudeProjects,
    ptyLogDir,
    repos,
    pty,
    git,
    logger,
    service,
  };
}

/** Write a per-task pty capture log into the harness log dir. */
async function seedPtyLog(taskId: string, content = "captured\r\n"): Promise<string> {
  const file = path.join(harness.ptyLogDir, `${encodeURIComponent(taskId)}.log`);
  await fs.writeFile(file, content);
  return file;
}

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(async () => {
  await fs.rm(harness.tmp, { recursive: true, force: true });
});

/**
 * Seed a project + N repos + a task with worktrees on disk.
 * Returns the seeded task and its source repo paths.
 */
async function seedTaskWithRepos(
  opts: {
    taskId: string;
    slug: string;
    projectName: string;
    repoCount: number;
    /** When true, the second repo's worktree nests inside the first's. */
    nested?: boolean;
    /** Create a Claude transcript dir for the session root. */
    withTranscript?: boolean;
  },
): Promise<{ task: Task; sourceRepoPaths: string[]; sessionRoot: string }> {
  const { taskId, slug, projectName, repoCount } = opts;
  const projectId = `proj-${projectName}`;
  harness.repos.addProject({
    id: projectId,
    name: projectName,
    createdAt: new Date().toISOString(),
  });

  const sessionRoot = path.join(harness.worktreeBase, projectName, slug);
  await fs.mkdir(sessionRoot, { recursive: true });

  const sourceRepoPaths: string[] = [];
  const taskReposToAdd: TaskRepo[] = [];

  for (let i = 0; i < repoCount; i++) {
    const repoName = `repo${i}`;
    const sourceRepoPath = path.join(harness.tmp, `src-${projectName}-${repoName}`);
    await initRepo(sourceRepoPath);
    sourceRepoPaths.push(sourceRepoPath);

    const projectRepoId = `pr-${projectName}-${repoName}`;
    harness.repos.addProjectRepo({
      id: projectRepoId,
      projectId,
      name: repoName,
      repoPath: sourceRepoPath,
      baseBranch: "main",
      setupScript: null,
      runScript: null,
      teardownScript: null,
    });

    // Worktree path: nested option places repo1 inside repo0's worktree.
    const worktreePath =
      opts.nested && i === 1
        ? path.join(sessionRoot, "repo0", "nested-repo1")
        : path.join(sessionRoot, repoName);

    await addWorktree(sourceRepoPath, worktreePath, slug);

    const taskRepo: TaskRepo = {
      id: `tr-${projectName}-${repoName}`,
      taskId,
      projectRepoId,
      repoName,
      branchName: slug,
      worktreePath,
      remotePushed: false,
    };
    harness.repos.addTaskRepo(taskRepo);
    taskReposToAdd.push(taskRepo);
  }

  const task: Task = {
    id: taskId,
    projectId,
    title: `task ${slug}`,
    description: null,
    status: "running",
    slug,
    sessionRoot,
    ptyPid: null,
    claudeSessionId: null,
    cavemanEnabled: false,
    cavemanLevel: null,
    cavemanSession: null,
    port: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  harness.repos.addTask(task);

  if (opts.withTranscript) {
    const encoded = path.resolve(sessionRoot).replace(/[^a-zA-Z0-9]/g, "-");
    const transcriptDir = path.join(harness.claudeProjects, encoded);
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(path.join(transcriptDir, "session.jsonl"), "{}\n");
  }

  return { task, sourceRepoPaths, sessionRoot };
}

/* ──────────────────────────────────────────────────────────────────────────
 * teardownTask
 * ────────────────────────────────────────────────────────────────────────── */

describe("CleanupService.teardownTask", () => {
  it("is a no-op when the task does not exist", async () => {
    await expect(harness.service.teardownTask("nope")).resolves.toBeUndefined();
    expect(harness.pty.killed).toEqual([]);
  });

  it("removes the assembled CLAUDE.md/.claude/.mcp.json links + session root, but never the config source", async () => {
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "t-cfg",
      slug: "feat-cfg",
      projectName: "cfgproj",
      repoCount: 1,
    });

    // A per-project config source (e.g. the user's shared-org dir).
    const cfgSrc = path.join(harness.tmp, "cfg-source");
    await fs.mkdir(path.join(cfgSrc, ".claude", "agents"), { recursive: true });
    await fs.writeFile(path.join(cfgSrc, "CLAUDE.md"), "# rules\n");
    await fs.writeFile(path.join(cfgSrc, ".claude", "agents", "a.md"), "agent\n");
    await fs.writeFile(path.join(cfgSrc, ".mcp.json"), '{"mcpServers":{}}\n');

    // Mimic GitService.assembleSessionRoot: symlink all three into the root.
    await fs.symlink(path.join(cfgSrc, "CLAUDE.md"), path.join(sessionRoot, "CLAUDE.md"));
    await fs.symlink(path.join(cfgSrc, ".claude"), path.join(sessionRoot, ".claude"));
    await fs.symlink(
      path.join(cfgSrc, ".mcp.json"),
      path.join(sessionRoot, ".mcp.json"),
    );
    expect(await exists(path.join(sessionRoot, ".claude"))).toBe(true);
    expect(await exists(path.join(sessionRoot, ".mcp.json"))).toBe(true);

    await harness.service.teardownTask("t-cfg");

    // No leftover: the session root and its now-empty project parent are gone.
    expect(await exists(sessionRoot)).toBe(false);
    expect(await exists(path.dirname(sessionRoot))).toBe(false);
    // CRUCIAL: unlinking the symlinks did NOT delete the config source.
    expect(await exists(path.join(cfgSrc, "CLAUDE.md"))).toBe(true);
    expect(await exists(path.join(cfgSrc, ".claude", "agents", "a.md"))).toBe(true);
    // The .mcp.json target is untouched — only the LINK was removed.
    expect(await exists(path.join(cfgSrc, ".mcp.json"))).toBe(true);
    expect(
      (await fs.readFile(path.join(cfgSrc, ".mcp.json"), "utf8")).trim(),
    ).toBe('{"mcpServers":{}}');
  });

  it("kills the pty, removes worktrees+branches, prunes, deletes DB rows (single repo)", async () => {
    const { task, sourceRepoPaths, sessionRoot } = await seedTaskWithRepos({
      taskId: "t1",
      slug: "feat-a",
      projectName: "alpha",
      repoCount: 1,
      withTranscript: true,
    });
    const repoPath = sourceRepoPaths[0];

    // sanity: worktree + branch + transcript exist before teardown
    expect(await exists(task.sessionRoot as string)).toBe(true);
    expect(await branchExists(repoPath, "feat-a")).toBe(true);
    const encoded = path
      .resolve(sessionRoot)
      .replace(/[^a-zA-Z0-9]/g, "-");
    const transcriptDir = path.join(harness.claudeProjects, encoded);
    expect(await exists(transcriptDir)).toBe(true);

    await harness.service.teardownTask("t1");

    // pty killed
    expect(harness.pty.killed).toContain("t1");
    // worktree dir gone
    expect(await exists(path.join(sessionRoot, "repo0"))).toBe(false);
    // local branch gone
    expect(await branchExists(repoPath, "feat-a")).toBe(false);
    expect(harness.git.localBranchesDeleted).toEqual([
      { repoPath, branch: "feat-a" },
    ]);
    // remote branch deletion attempted (best-effort)
    expect(harness.git.remoteBranchesDeleted).toEqual([
      { repoPath, branch: "feat-a" },
    ]);
    // prune happened
    expect(harness.git.pruned).toContain(repoPath);
    // transcript removed
    expect(await exists(transcriptDir)).toBe(false);
    // empty session root removed
    expect(await exists(sessionRoot)).toBe(false);
    // DB rows gone
    expect(harness.repos.tasks.getById("t1")).toBeNull();
    expect(harness.repos.taskRepos.listByTask("t1")).toEqual([]);
  });

  it("kills the task's running commands (killAllForTask) before removing worktrees", async () => {
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "tcmd",
      slug: "cmd-task",
      projectName: "cmdp",
      repoCount: 1,
    });

    // A recording command runner that captures the order of events so we can
    // assert killAllForTask ran BEFORE the worktree was removed.
    const order: string[] = [];
    const commandRunner = {
      ensureShell: () => {},
      runScript: async () => {
        throw new Error("unused");
      },
      onData: () => () => {},
      onExit: () => () => {},
      getReplay: () => ({ data: "" }),
      isRunning: () => false,
      write: () => {},
      resize: () => {},
      killAllForTask: (taskId: string) => {
        order.push(`kill:${taskId}`);
      },
    };

    // Build a fresh service wired with the command runner (the harness one is not).
    const options: CleanupServiceOptions = {
      worktreeBaseDir: harness.worktreeBase,
      claudeProjectsDir: harness.claudeProjects,
      ptyLogDir: harness.ptyLogDir,
      logger: harness.logger,
      ptyDeathTimeoutMs: 200,
      commandRunner,
    };
    const service = new CleanupServiceImpl(
      harness.git,
      harness.pty,
      harness.repos,
      options,
    );

    await service.teardownTask("tcmd");

    // The runner was asked to kill the task's commands exactly once.
    expect(order).toEqual(["kill:tcmd"]);
    // And the worktree really was torn down afterwards.
    expect(await exists(path.join(sessionRoot, "repo0"))).toBe(false);
  });

  it("deletes the task's pty capture log (and tolerates its absence)", async () => {
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "tlog",
      slug: "logged",
      projectName: "logp",
      repoCount: 1,
    });
    void sessionRoot;
    const logFile = await seedPtyLog("tlog");
    expect(await exists(logFile)).toBe(true);

    await harness.service.teardownTask("tlog");

    // The pty log is gone, with no warning (deletion succeeded).
    expect(await exists(logFile)).toBe(false);
    expect(harness.pty.killed).toContain("tlog");
    expect(harness.logger.warns.some((w) => /pty log/i.test(w))).toBe(false);
  });

  it("does not fail teardown when the task has no pty log on disk", async () => {
    await seedTaskWithRepos({
      taskId: "tnolog",
      slug: "nolog",
      projectName: "nologp",
      repoCount: 1,
    });
    // No seedPtyLog: the log never existed.
    await expect(harness.service.teardownTask("tnolog")).resolves.toBeUndefined();
    expect(harness.repos.tasks.getById("tnolog")).toBeNull();
    expect(harness.logger.warns.some((w) => /pty log/i.test(w))).toBe(false);
  });

  it("forgets pty in-memory state, ordered after kill and BEFORE deleting the log", async () => {
    await seedTaskWithRepos({
      taskId: "tforget",
      slug: "forgotten",
      projectName: "fgp",
      repoCount: 1,
    });
    await seedPtyLog("tforget");

    await harness.service.teardownTask("tforget");

    // forget() was invoked for the task (purges the service's per-task maps).
    expect(harness.pty.forgotten).toContain("tforget");
    // Ordering: kill → forget → (delete log). forget flushes pending writes
    // BEFORE the log is deleted so no in-flight append can resurrect it.
    const killIdx = harness.pty.ops.indexOf("kill:tforget");
    const forgetIdx = harness.pty.ops.indexOf("forget:tforget");
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(forgetIdx).toBeGreaterThan(killIdx);
  });

  it("a late append flushed by forget does NOT survive: the log stays deleted", async () => {
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "tresurrect",
      slug: "resurrect",
      projectName: "resp",
      repoCount: 1,
    });
    void sessionRoot;
    const logFile = await seedPtyLog("tresurrect");
    expect(await exists(logFile)).toBe(true);

    // Simulate the race: forget() (which in production flushes pending captures)
    // is where a last in-flight append would land. We re-create the log inside
    // the forget hook to model that flushed-out write. Because cleanup runs
    // forget BEFORE deletePtyLog, the subsequent delete still removes it — the
    // log must NOT be resurrected past teardown.
    harness.pty.onForget = async () => {
      await fs.writeFile(logFile, "late-in-flight-append");
    };

    await harness.service.teardownTask("tresurrect");

    // The flush happened (inside forget) and the delete ran after it → gone.
    expect(harness.pty.forgotten).toContain("tresurrect");
    expect(await exists(logFile)).toBe(false);
  });

  it("handles multiple repos, removing the more-deeply-nested worktree first", async () => {
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "t2",
      slug: "multi",
      projectName: "beta",
      repoCount: 2,
      nested: true,
    });

    await harness.service.teardownTask("t2");

    // both worktrees gone
    expect(await exists(path.join(sessionRoot, "repo0"))).toBe(false);
    expect(
      await exists(path.join(sessionRoot, "repo0", "nested-repo1")),
    ).toBe(false);
    // both local branches deleted
    expect(harness.git.localBranchesDeleted).toHaveLength(2);
    // two source repos pruned
    expect(new Set(harness.git.pruned).size).toBeGreaterThanOrEqual(2);
    // session root removed (empty)
    expect(await exists(sessionRoot)).toBe(false);
    // DB cleaned
    expect(harness.repos.tasks.getById("t2")).toBeNull();
    expect(harness.repos.taskRepos.listByTask("t2")).toEqual([]);
  });

  it("busy-guard: does NOT remove a busy worktree or its branch, but still deletes DB rows", async () => {
    const { task, sourceRepoPaths, sessionRoot } = await seedTaskWithRepos({
      taskId: "t3",
      slug: "busy",
      projectName: "gamma",
      repoCount: 1,
    });
    const repoPath = sourceRepoPaths[0];
    const worktreePath = path.join(sessionRoot, "repo0");

    // Force the worktree to report busy.
    harness.git.busyOverride.set(path.resolve(worktreePath), true);

    await harness.service.teardownTask("t3");

    // pty still killed (processes always go first)
    expect(harness.pty.killed).toContain("t3");
    // worktree NOT removed
    expect(await exists(worktreePath)).toBe(true);
    // branch NOT deleted (busy tree likely has it checked out)
    expect(await branchExists(repoPath, "busy")).toBe(true);
    expect(harness.git.localBranchesDeleted).toEqual([]);
    // a warning was logged about the busy worktree
    expect(harness.logger.warns.some((w) => /busy/i.test(w))).toBe(true);
    // DB rows are still cleaned up (the card is gone from the board)
    expect(harness.repos.tasks.getById("t3")).toBeNull();
    expect(harness.repos.taskRepos.listByTask("t3")).toEqual([]);
    void task;
  });

  it("runs the repo teardown script BEFORE removing the worktree (cwd + PORT)", async () => {
    const { sessionRoot, sourceRepoPaths } = await seedTaskWithRepos({
      taskId: "td",
      slug: "with-teardown",
      projectName: "tdproj",
      repoCount: 1,
    });
    void sourceRepoPaths;

    const worktreePath = path.join(sessionRoot, "repo0");
    const marker = path.join(harness.tmp, "teardown-ran.txt");

    // Attach a teardown script to the seeded project repo. It writes a marker
    // capturing its $PWD and $PORT, and asserts the worktree still exists when
    // it runs (i.e. it runs BEFORE worktree removal).
    const pr = harness.repos.projectReposData.get("pr-tdproj-repo0") as ProjectRepo;
    pr.teardownScript = `test -d ${quote(worktreePath)} && printf '%s|%s' "$PWD" "$PORT" > ${quote(marker)}`;

    // Give the task an allocated port so the script sees it via $PORT.
    const task = harness.repos.tasksData.get("td") as Task;
    task.port = 4321;

    await harness.service.teardownTask("td");

    // The marker exists → the script ran while the worktree was still present.
    expect(await exists(marker)).toBe(true);
    const [pwd, port] = (await fs.readFile(marker, "utf8")).split("|");
    // It ran inside the worktree …
    expect(path.resolve(pwd)).toBe(path.resolve(worktreePath));
    // … with the task's port exported.
    expect(port).toBe("4321");
    // … and the worktree was still removed afterwards.
    expect(await exists(worktreePath)).toBe(false);
    // No warning about the teardown script (it succeeded).
    expect(
      harness.logger.warns.some((w) => /teardown script/i.test(w)),
    ).toBe(false);
  });

  it("downgrades a failing teardown script to a warning and still tears down", async () => {
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "tdf",
      slug: "bad-teardown",
      projectName: "tdfproj",
      repoCount: 1,
    });

    const pr = harness.repos.projectReposData.get(
      "pr-tdfproj-repo0",
    ) as ProjectRepo;
    pr.teardownScript = "exit 7"; // non-zero → must be downgraded to a warning

    await harness.service.teardownTask("tdf");

    // Teardown continued: worktree removed, DB cleaned.
    expect(await exists(path.join(sessionRoot, "repo0"))).toBe(false);
    expect(harness.repos.tasks.getById("tdf")).toBeNull();
    // The failure surfaced as a warning, not a throw.
    expect(
      harness.logger.warns.some((w) => /teardown script/i.test(w)),
    ).toBe(true);
  });

  it("continues the checklist when one step fails (resilience)", async () => {
    const { sourceRepoPaths, sessionRoot } = await seedTaskWithRepos({
      taskId: "t4",
      slug: "resil",
      projectName: "delta",
      repoCount: 1,
    });
    const repoPath = sourceRepoPaths[0];

    // Make local branch deletion throw; teardown must still finish + clean DB.
    harness.git.deleteLocalBranch = async () => {
      throw new Error("simulated branch-delete failure");
    };

    await harness.service.teardownTask("t4");

    // worktree still removed despite the later failure
    expect(await exists(path.join(sessionRoot, "repo0"))).toBe(false);
    // prune still ran
    expect(harness.git.pruned).toContain(repoPath);
    // DB still cleaned
    expect(harness.repos.tasks.getById("t4")).toBeNull();
    // failure surfaced as a warning, not a throw
    expect(
      harness.logger.warns.some((w) => /branch-delete failure/.test(w)),
    ).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * sweepOrphans
 * ────────────────────────────────────────────────────────────────────────── */

describe("CleanupService.sweepOrphans", () => {
  it("removes a planted orphan session dir not backed by any DB task", async () => {
    // Live task (should be left alone).
    const { sessionRoot: liveRoot } = await seedTaskWithRepos({
      taskId: "live",
      slug: "keepme",
      projectName: "omega",
      repoCount: 1,
    });

    // Planted orphan: a session dir + worktree with NO matching DB task.
    const orphanSource = path.join(harness.tmp, "src-orphan");
    await initRepo(orphanSource);
    const orphanRoot = path.join(harness.worktreeBase, "omega", "orphan-slug");
    const orphanWt = path.join(orphanRoot, "repo0");
    await addWorktree(orphanSource, orphanWt, "orphan-slug");
    expect(await exists(orphanWt)).toBe(true);

    const result = await harness.service.sweepOrphans();

    // orphan worktree removed
    expect(await exists(orphanWt)).toBe(false);
    expect(result.removedWorktrees.some((p) => p.includes("orphan-slug"))).toBe(
      true,
    );
    // empty orphan root cleaned
    expect(await exists(orphanRoot)).toBe(false);
    // live task's worktree untouched
    expect(await exists(path.join(liveRoot, "repo0"))).toBe(true);
    expect(harness.repos.tasks.getById("live")).not.toBeNull();
  });

  it("reconciles a stale DB task whose worktrees no longer exist on disk", async () => {
    // Seed a normal task, then delete its filesystem footprint out-of-band so
    // the DB row is stale.
    const { sessionRoot } = await seedTaskWithRepos({
      taskId: "stale",
      slug: "ghost",
      projectName: "sigma",
      repoCount: 1,
    });
    await fs.rm(sessionRoot, { recursive: true, force: true });
    expect(await exists(sessionRoot)).toBe(false);
    expect(harness.repos.tasks.getById("stale")).not.toBeNull();

    await harness.service.sweepOrphans();

    // stale DB rows cleaned
    expect(harness.repos.tasks.getById("stale")).toBeNull();
    expect(harness.repos.taskRepos.listByTask("stale")).toEqual([]);
    expect(
      harness.logger.infos.some((m) => /reconciled stale DB task stale/.test(m)),
    ).toBe(true);
  });

  it("busy-guard in sweep: does NOT delete a busy orphan worktree", async () => {
    const orphanSource = path.join(harness.tmp, "src-busy-orphan");
    await initRepo(orphanSource);
    const orphanRoot = path.join(harness.worktreeBase, "theta", "busy-orphan");
    const orphanWt = path.join(orphanRoot, "repo0");
    await addWorktree(orphanSource, orphanWt, "busy-orphan");

    harness.git.busyOverride.set(path.resolve(orphanWt), true);

    const result = await harness.service.sweepOrphans();

    // busy orphan NOT removed
    expect(await exists(orphanWt)).toBe(true);
    expect(result.removedWorktrees).not.toContain(orphanWt);
    expect(result.errors.some((e) => /busy/i.test(e))).toBe(true);
  });

  it("removes orphan pty logs but keeps logs of live DB tasks", async () => {
    // Live task whose log must be KEPT.
    await seedTaskWithRepos({
      taskId: "live-log",
      slug: "keep-log",
      projectName: "psi",
      repoCount: 1,
    });
    const liveLog = await seedPtyLog("live-log");

    // Orphan log: a <taskId>.log with no matching DB task.
    const orphanLog = await seedPtyLog("ghost-task");
    // A non-.log file must be left alone.
    const stray = path.join(harness.ptyLogDir, "notes.txt");
    await fs.writeFile(stray, "keep me");

    const result = await harness.service.sweepOrphans();

    expect(await exists(orphanLog)).toBe(false);
    expect(await exists(liveLog)).toBe(true);
    expect(await exists(stray)).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("handles multi-repo orphan session dirs (removes all worktrees + cleans the root)", async () => {
    const src0 = path.join(harness.tmp, "src-mo-0");
    const src1 = path.join(harness.tmp, "src-mo-1");
    await initRepo(src0);
    await initRepo(src1);

    const orphanRoot = path.join(harness.worktreeBase, "kappa", "multi-orphan");
    const wt0 = path.join(orphanRoot, "repo0");
    const wt1 = path.join(orphanRoot, "repo1");
    await addWorktree(src0, wt0, "multi-orphan");
    await addWorktree(src1, wt1, "multi-orphan");

    const result = await harness.service.sweepOrphans();

    expect(await exists(wt0)).toBe(false);
    expect(await exists(wt1)).toBe(false);
    expect(await exists(orphanRoot)).toBe(false);
    expect(result.removedWorktrees).toHaveLength(2);
  });
});
