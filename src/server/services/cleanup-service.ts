/**
 * CleanupService — the heart of claude-kanban's reliability story.
 *
 * Tearing a task down sloppily is the exact pain this tool replaces: orphaned
 * `claude` processes, dev servers still bound to ports, half-removed worktrees
 * that wedge git, and dangling branches. Every step here is therefore run in a
 * strict, deterministic order and wrapped so a single failure can never abort
 * the rest of the teardown — failures are downgraded to collected warnings.
 *
 * Anti-corruption rule: we NEVER force-remove a worktree another tool may be
 * holding open. If `GitService.isWorktreeBusy` reports busy, we log a warning
 * and skip the destructive removal for that tree.
 *
 * Cross-module contracts (GitService, PtyService, Repositories) are consumed as
 * TYPES from the shared interfaces only — never as concrete sibling imports.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { Task, TaskRepo } from "../../shared/types.js";
import type {
  CleanupService as ICleanupService,
  CommandRunnerService,
  GitService,
  PtyService,
  Repositories,
  SweepResult,
} from "../../shared/interfaces.js";
import { config } from "../config.js";

const execAsync = promisify(exec);

/** Injectable logger so tests can assert / silence output. Defaults to console. */
export interface CleanupLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Optional knobs (injected in tests; production uses sensible defaults). */
export interface CleanupServiceOptions {
  /**
   * Base directory under which session roots live:
   * `<worktreeBaseDir>/<projectName>/<slug>`. Defaults to
   * `~/claude-kanban-sessions` (mirrors server config) when omitted.
   */
  worktreeBaseDir?: string;
  /** Directory holding Claude session transcripts. Defaults to `~/.claude/projects`. */
  claudeProjectsDir?: string;
  /**
   * Directory holding per-task pty capture logs (`<taskId>.log`). Defaults to
   * the server config's `ptyLogDir`. Teardown deletes a task's log here, and the
   * orphan sweep removes logs whose taskId has no live DB task.
   */
  ptyLogDir?: string;
  /** Logger sink. Defaults to a thin console adapter. */
  logger?: CleanupLogger;
  /**
   * How long (ms) to wait for a killed pty's process group to actually die
   * before giving up and continuing. Best-effort.
   */
  ptyDeathTimeoutMs?: number;
  /**
   * How long (ms) a user-defined teardown script may run before it is killed.
   * Prevents a hung cleanup command from wedging the whole teardown.
   */
  scriptTimeoutMs?: number;
  /**
   * The per-repo command runner. When provided, teardown kills every interactive
   * shell for the task (all repos) BEFORE removing worktrees, so a dev server
   * still bound to a port / holding a worktree open (started inside the shell) is
   * gone first. Optional so existing tests can construct a CleanupService without it.
   */
  commandRunner?: CommandRunnerService;
}

const DEFAULT_PTY_DEATH_TIMEOUT_MS = 5_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;

const defaultLogger: CleanupLogger = {
  info: (m) => console.log(`[cleanup] ${m}`),
  warn: (m) => console.warn(`[cleanup] WARN ${m}`),
};

export class CleanupServiceImpl implements ICleanupService {
  private readonly git: GitService;
  private readonly pty: PtyService;
  private readonly repos: Repositories;
  private readonly worktreeBaseDir: string;
  private readonly claudeProjectsDir: string;
  private readonly ptyLogDir: string;
  private readonly log: CleanupLogger;
  private readonly ptyDeathTimeoutMs: number;
  private readonly scriptTimeoutMs: number;
  private readonly commandRunner: CommandRunnerService | null;

  constructor(
    git: GitService,
    pty: PtyService,
    repos: Repositories,
    options: CleanupServiceOptions = {},
  ) {
    this.git = git;
    this.pty = pty;
    this.repos = repos;
    this.commandRunner = options.commandRunner ?? null;
    this.worktreeBaseDir =
      options.worktreeBaseDir ??
      path.join(os.homedir(), "claude-kanban-sessions");
    this.claudeProjectsDir =
      options.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
    this.ptyLogDir = options.ptyLogDir ?? config.ptyLogDir;
    this.log = options.logger ?? defaultLogger;
    this.ptyDeathTimeoutMs =
      options.ptyDeathTimeoutMs ?? DEFAULT_PTY_DEATH_TIMEOUT_MS;
    this.scriptTimeoutMs =
      options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * teardownTask — the full, ordered, resilient checklist.
   * ────────────────────────────────────────────────────────────────────── */

  async teardownTask(taskId: string): Promise<void> {
    const warnings: string[] = [];

    // 1. Load task + task_repos. Missing → no-op.
    const task = this.repos.tasks.getById(taskId);
    if (!task) {
      this.log.info(`teardown(${taskId}): task not found — nothing to do`);
      return;
    }
    const taskRepos = this.repos.taskRepos.listByTask(taskId);

    this.log.info(
      `teardown(${taskId}): "${task.title}" with ${taskRepos.length} repo(s)`,
    );

    // 2. PROCESSES FIRST — kill the pty and its whole process GROUP. This
    //    cascades to dev servers / file watchers the agent spawned. We then
    //    wait until the recorded pid is actually dead so nothing is still
    //    holding a worktree open or a port bound when we get to removal.
    await this.step(warnings, "kill pty", async () => {
      this.pty.kill(taskId);
      await this.waitForPidDeath(task.ptyPid);
    });

    // 2b. Forget the pty's in-memory state BEFORE deleting its log. `forget`
    //     flushes any still-pending capture appends and purges the per-task maps
    //     (exited/writeChains/trimming/logBytes) so (a) those maps don't leak
    //     over the server's lifetime and (b) no late in-flight append can
    //     re-create the log AFTER we delete it on the next step.
    await this.step(warnings, "forget pty state", async () => {
      await this.pty.forget(taskId);
    });

    // 2c. Delete this task's pty capture log now that the pty is dead and its
    //     pending writes are flushed — it can no longer be appended to, and the
    //     conversation it held is moot once the task is gone. Best-effort:
    //     tolerate the log never having existed.
    await this.step(warnings, "delete pty log", async () => {
      await this.deletePtyLog(taskId);
    });

    // 2d. Kill every per-repo command SHELL for this task BEFORE touching
    //     worktrees, so a running dev server (and its children / bound port)
    //     started inside the shell is gone before its tree is removed — otherwise
    //     the busy-guard would see the holder and skip removal. No-op when no
    //     runner is wired.
    if (this.commandRunner) {
      const runner = this.commandRunner;
      await this.step(warnings, "kill task command shells", () => {
        runner.killAllForTask(taskId);
      });
    }

    // 3. Free any allocated port (best-effort) — the group kill above should
    //    already have released it; this is a belt-and-braces reclaim.
    if (task.port != null) {
      const port = task.port;
      await this.step(warnings, `free port ${port}`, async () => {
        await this.freePort(port);
      });
    }

    // 4. Delete Claude session transcript dir(s) for this task's session root.
    if (task.sessionRoot) {
      const sessionRoot = task.sessionRoot;
      await this.step(warnings, "delete claude transcripts", async () => {
        await this.deleteClaudeTranscripts(sessionRoot);
      });
    }

    // 5. Per-repo worktree teardown. NESTING: deeper paths first, so removing
    //    an outer tree never orphans an inner one's git admin files.
    for (const repo of this.orderByNestingDepth(taskRepos)) {
      await this.teardownWorktree(repo, task, warnings);
    }

    // 6. Remove the assembled config entries (CLAUDE.md/.claude) then the now-
    //    empty session root and its empty <base>/<projectName> parent dir.
    //    Unlinking a symlink removes the LINK only — never the per-project
    //    config source (e.g. the user's shared-org .claude) it points at.
    if (task.sessionRoot) {
      const sessionRoot = task.sessionRoot;
      await this.step(warnings, "remove session root", async () => {
        await this.removeSessionRootScratch(sessionRoot);
      });
    }

    // 7. Delete DB rows (children first, then the task).
    await this.step(warnings, "delete task_repos rows", () => {
      this.repos.taskRepos.deleteByTask(taskId);
    });
    await this.step(warnings, "delete task row", () => {
      this.repos.tasks.delete(taskId);
    });

    if (warnings.length > 0) {
      this.log.warn(
        `teardown(${taskId}) finished with ${warnings.length} warning(s):\n  - ${warnings.join("\n  - ")}`,
      );
    } else {
      this.log.info(`teardown(${taskId}): clean`);
    }
  }

  /**
   * Tear down one repo's worktree + branches. Respects the busy-guard: if the
   * worktree is busy (locked / held open by another tool), we LOG and SKIP the
   * destructive force-removal entirely rather than risk corrupting it.
   */
  private async teardownWorktree(
    repo: TaskRepo,
    task: Task,
    warnings: string[],
  ): Promise<void> {
    const projectRepo = this.repos.projectRepos.getById(repo.projectRepoId);
    const repoPath = projectRepo ? projectRepo.repoPath : null;

    // Run the user-defined teardown script FIRST, while the worktree files
    // still exist (the script may stop a docker compose, drop a test DB, kill
    // an external daemon, remove a named volume, deregister a service, …).
    // A failure is downgraded to a warning so it never blocks removal.
    if (projectRepo?.teardownScript && projectRepo.teardownScript.trim()) {
      const script = projectRepo.teardownScript;
      await this.step(
        warnings,
        `teardown script (${repo.repoName})`,
        async () => {
          await this.runRepoScript(script, repo.worktreePath, task.port);
        },
      );
    }

    // Unlock first (best-effort) so a stale lock from a crash doesn't block us.
    await this.step(warnings, `unlock worktree ${repo.worktreePath}`, async () => {
      await this.unlockWorktree(repo.worktreePath);
    });

    // Busy-guard: never force-remove a tree another tool may be holding open.
    let busy = false;
    try {
      busy = await this.git.isWorktreeBusy(repo.worktreePath);
    } catch (err) {
      // If we cannot even determine busyness, treat as busy and skip — the
      // conservative choice protects against corruption.
      busy = true;
      warnings.push(
        `could not check busyness of ${repo.worktreePath}: ${errMsg(err)} (skipping removal)`,
      );
    }

    if (busy) {
      this.log.warn(
        `worktree busy, SKIPPING force-removal: ${repo.worktreePath} (${repo.repoName})`,
      );
      warnings.push(`worktree busy, skipped: ${repo.worktreePath}`);
      // Still attempt a prune so we don't leave stale admin entries, but do
      // NOT touch the branch — the busy tree likely still has it checked out.
      if (repoPath) {
        await this.step(warnings, `prune ${repoPath}`, () =>
          this.git.pruneWorktrees(repoPath),
        );
      }
      return;
    }

    // Remove the worktree itself.
    await this.step(warnings, `remove worktree ${repo.worktreePath}`, () =>
      this.git.removeTaskWorktrees([repo]),
    );

    if (repoPath) {
      // Delete the local task branch.
      await this.step(
        warnings,
        `delete local branch ${repo.branchName}`,
        () => this.git.deleteLocalBranch(repoPath, repo.branchName),
      );

      // Delete the remote branch (best-effort: only meaningful if pushed).
      await this.step(
        warnings,
        `delete remote branch ${repo.branchName}`,
        () => this.git.deleteRemoteBranch(repoPath, repo.branchName),
      );

      // Prune stale worktree admin entries.
      await this.step(warnings, `prune ${repoPath}`, () =>
        this.git.pruneWorktrees(repoPath),
      );

      // Fetch with prune to drop any stale remote-tracking refs (best-effort).
      await this.step(warnings, `git fetch --prune ${repoPath}`, async () => {
        await execAsync("git fetch --prune", { cwd: repoPath });
      });
    } else {
      warnings.push(
        `could not resolve source repo path for ${repo.repoName} (${repo.projectRepoId}); skipped branch/prune`,
      );
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * sweepOrphans — reconcile DB ⇆ filesystem.
   * ────────────────────────────────────────────────────────────────────── */

  async sweepOrphans(): Promise<SweepResult> {
    const result: SweepResult = {
      removedWorktrees: [],
      removedBranches: [],
      errors: [],
    };

    const tasks = this.repos.tasks.list();
    const allTaskRepos = this.repos.taskRepos.listAll();

    // Prune every known source repo up front so git's view is fresh and stale
    // admin entries (from prior crashes) are cleared before we scan.
    const knownRepoPaths = this.collectKnownRepoPaths(allTaskRepos);
    for (const repoPath of knownRepoPaths) {
      try {
        await this.git.pruneWorktrees(repoPath);
      } catch (err) {
        result.errors.push(`prune ${repoPath}: ${errMsg(err)}`);
      }
    }

    // Set of live session roots (abs paths) keyed by DB tasks.
    const liveSessionRoots = new Set<string>();
    for (const task of tasks) {
      if (task.sessionRoot) {
        liveSessionRoots.add(path.resolve(task.sessionRoot));
      }
    }

    // A. Filesystem → DB: any session dir on disk NOT matching a live task is
    //    an orphan; remove it (subject to the busy-guard).
    await this.sweepOrphanSessionDirs(liveSessionRoots, result);

    // B. DB → filesystem: any DB task whose worktrees no longer exist on disk
    //    is stale; clean its rows.
    for (const task of tasks) {
      try {
        await this.reconcileStaleTask(task, result);
      } catch (err) {
        result.errors.push(`reconcile task ${task.id}: ${errMsg(err)}`);
      }
    }

    // C. pty-log → DB: any `<taskId>.log` whose taskId no longer backs a live DB
    //    task is an orphan from an uncleanly-removed task; delete it so the log
    //    dir does not accumulate dead conversations. Recompute live ids AFTER the
    //    stale-task reconcile above, which may have just dropped some rows.
    await this.sweepOrphanPtyLogs(result);

    this.log.info(
      `sweepOrphans: removed ${result.removedWorktrees.length} worktree(s), ` +
        `${result.removedBranches.length} branch(es), ${result.errors.length} error(s)`,
    );
    if (result.errors.length > 0) {
      this.log.warn(`sweepOrphans errors:\n  - ${result.errors.join("\n  - ")}`);
    }

    return result;
  }

  /**
   * Walk `<base>/<projectName>/<slug>` two levels deep. Any session-root dir
   * not backing a live DB task is an orphan and gets removed (busy-guard
   * respected per worktree).
   */
  private async sweepOrphanSessionDirs(
    liveSessionRoots: Set<string>,
    result: SweepResult,
  ): Promise<void> {
    const projectDirs = await this.safeReadDirs(this.worktreeBaseDir);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(this.worktreeBaseDir, projectDir);
      const sessionDirs = await this.safeReadDirs(projectPath);
      for (const sessionDir of sessionDirs) {
        const sessionRoot = path.resolve(path.join(projectPath, sessionDir));
        if (liveSessionRoots.has(sessionRoot)) continue;

        // Orphan session root. Each child dir is a (potential) worktree.
        const worktreeDirs = await this.safeReadDirs(sessionRoot);
        // Deeper paths first to respect nesting.
        const childPaths = worktreeDirs
          .map((d) => path.join(sessionRoot, d))
          .sort((a, b) => b.length - a.length);

        // Properly unregister + remove any real git worktrees first (each respects
        // its own busy-guard), THEN remove the session root. removeSessionRootScratch
        // self-guards: if a real worktree survived (still has a `.git`), it stays
        // conservative and leaves the root instead of nuking a live worktree — so
        // a non-worktree scratch dir (e.g. `docs/`) no longer blocks cleanup.
        for (const wtPath of childPaths) {
          await this.removeOrphanWorktree(wtPath, result);
        }
        try {
          await this.removeSessionRootScratch(sessionRoot);
        } catch (err) {
          result.errors.push(`rmdir ${sessionRoot}: ${errMsg(err)}`);
        }
      }
      // Prune a now-empty <base>/<projectName> dir (e.g. a fully deleted project
      // whose every task was torn down).
      await this.removeDirIfEmpty(projectPath);
    }
  }

  /**
   * Remove a single orphaned worktree directory. Returns true if it was removed
   * (or was already gone), false if it was skipped because busy.
   */
  private async removeOrphanWorktree(
    wtPath: string,
    result: SweepResult,
  ): Promise<boolean> {
    let busy = false;
    try {
      busy = await this.git.isWorktreeBusy(wtPath);
    } catch (err) {
      busy = true;
      result.errors.push(`busy-check ${wtPath}: ${errMsg(err)}`);
    }
    if (busy) {
      this.log.warn(`sweep: worktree busy, SKIPPING: ${wtPath}`);
      result.errors.push(`worktree busy, skipped: ${wtPath}`);
      return false;
    }

    // We don't have the TaskRepo row for an orphan, so synthesise the minimal
    // shape removeTaskWorktrees needs (it works off worktreePath).
    const synthetic: TaskRepo = {
      id: "",
      taskId: "",
      projectRepoId: "",
      repoName: path.basename(wtPath),
      branchName: "",
      worktreePath: wtPath,
      remotePushed: false,
    };
    try {
      await this.git.removeTaskWorktrees([synthetic]);
      result.removedWorktrees.push(wtPath);
      return true;
    } catch (err) {
      // The destructive chokepoint refused because the tree went busy between
      // our pre-check and the call — honour that and SKIP, never force-delete a
      // busy tree behind the guard's back.
      if (isWorktreeBusyError(err)) {
        this.log.warn(`sweep: worktree became busy, SKIPPING: ${wtPath}`);
        result.errors.push(`worktree busy, skipped: ${wtPath}`);
        return false;
      }
      // Otherwise fall back to a plain recursive delete so we don't leak the dir.
      try {
        await fs.rm(wtPath, { recursive: true, force: true });
        result.removedWorktrees.push(wtPath);
        return true;
      } catch (err2) {
        result.errors.push(`remove orphan worktree ${wtPath}: ${errMsg(err2)}`);
        return false;
      }
    }
  }

  /**
   * If a DB task's worktrees no longer exist on disk, the task is stale (e.g.
   * the session dir was deleted out-of-band). Clean its rows and prune.
   */
  private async reconcileStaleTask(
    task: Task,
    result: SweepResult,
  ): Promise<void> {
    const taskRepos = this.repos.taskRepos.listByTask(task.id);

    // A task with no worktree rows and no session root carries no filesystem
    // footprint to reconcile against; leave it alone.
    if (taskRepos.length === 0 && !task.sessionRoot) return;

    let anyWorktreeExists = false;
    for (const repo of taskRepos) {
      if (await this.pathExists(repo.worktreePath)) {
        anyWorktreeExists = true;
        break;
      }
    }
    const sessionRootExists = task.sessionRoot
      ? await this.pathExists(task.sessionRoot)
      : false;

    if (anyWorktreeExists || sessionRootExists) return; // still live on disk

    // Stale: filesystem footprint is gone. Prune source repos so git forgets
    // the dead worktrees, then drop the DB rows.
    for (const repo of taskRepos) {
      const repoPath = this.resolveSourceRepoPath(repo);
      if (repoPath) {
        try {
          await this.git.pruneWorktrees(repoPath);
        } catch (err) {
          result.errors.push(`prune ${repoPath}: ${errMsg(err)}`);
        }
      }
    }

    this.repos.taskRepos.deleteByTask(task.id);
    this.repos.tasks.delete(task.id);
    this.log.info(`sweep: reconciled stale DB task ${task.id} ("${task.title}")`);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Helpers
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Run `fn`, swallowing any throw into a collected warning so one failed step
   * never aborts the rest of the checklist.
   */
  private async step(
    warnings: string[],
    label: string,
    fn: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      warnings.push(`${label}: ${errMsg(err)}`);
      this.log.warn(`${label}: ${errMsg(err)}`);
    }
  }

  /**
   * Order task_repos so that when one worktree path is nested inside another,
   * the deeper one is torn down first. We sort by path depth descending, which
   * guarantees children precede their ancestors.
   */
  private orderByNestingDepth(taskRepos: TaskRepo[]): TaskRepo[] {
    return [...taskRepos].sort(
      (a, b) => pathDepth(b.worktreePath) - pathDepth(a.worktreePath),
    );
  }

  /** Resolve the source (origin) repo path for a task_repo via the DB. */
  private resolveSourceRepoPath(repo: TaskRepo): string | null {
    const projectRepo = this.repos.projectRepos.getById(repo.projectRepoId);
    return projectRepo ? projectRepo.repoPath : null;
  }

  /** Collect the unique set of source repo paths referenced by task_repos. */
  private collectKnownRepoPaths(taskRepos: TaskRepo[]): string[] {
    const set = new Set<string>();
    for (const tr of taskRepos) {
      const repoPath = this.resolveSourceRepoPath(tr);
      if (repoPath) set.add(repoPath);
    }
    return [...set];
  }

  /**
   * Wait for the pty's whole process GROUP to die — not just the recorded
   * leader pid. The pty leader can exit promptly while child dev servers /
   * file-watchers it spawned are still alive in the same group, holding files
   * open under the worktree. If we only waited on the leader, the busy-check
   * that follows could see those children and wrongly skip destructive removal.
   *
   * We poll the group (signal 0 to -pid), and if it is still alive past the
   * grace window we escalate SIGTERM → SIGKILL on the group (then the leader)
   * before giving up. Best-effort throughout: signalling a gone group is fine.
   */
  private async waitForPidDeath(pid: number | null): Promise<void> {
    if (pid == null) return;

    // Phase 1: grace window — let SIGTERM (already sent by pty.kill) take.
    const graceDeadline = Date.now() + this.ptyDeathTimeoutMs;
    while (Date.now() < graceDeadline) {
      if (!this.isGroupAlive(pid)) return;
      await delay(100);
    }
    if (!this.isGroupAlive(pid)) return;

    // Phase 2: escalate. SIGTERM the group again, then SIGKILL group + leader.
    this.signalGroup(pid, "SIGTERM");
    await delay(200);
    if (!this.isGroupAlive(pid)) return;

    this.signalGroup(pid, "SIGKILL");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }

    // Phase 3: short confirmation window for SIGKILL to be reaped.
    const killDeadline = Date.now() + 1_000;
    while (Date.now() < killDeadline) {
      if (!this.isGroupAlive(pid)) return;
      await delay(50);
    }
    // Give up: the rest of the checklist (busy-guard) protects the worktree.
  }

  /** Signal the whole process group led by `pid` (negative-pid). Best-effort. */
  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // No such group / not a group leader — try the bare pid as a fallback.
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * True if the process group led by `pid` still has any member alive. We probe
   * the group via signal 0 to `-pid`; ESRCH means the group is empty (dead),
   * EPERM means a member exists we may not signal (still alive). Falls back to
   * probing the bare leader pid when the group probe is not meaningful.
   */
  private isGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true; // a member exists, just not signalable
      if (code === "ESRCH") return this.isPidAlive(pid); // group gone; check leader
      // EINVAL or other: fall back to the bare leader probe.
      return this.isPidAlive(pid);
    }
  }

  /** True if `pid` still exists (signal 0 probe). */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists but we can't signal it (still "alive").
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Run a user-defined repo lifecycle script (here: the teardown script) inside
   * the worktree. The script runs through the user's shell so it can be a full
   * command line. The task's allocated port (if any) is exported as `PORT` so a
   * teardown script can target the same dev server its run script started.
   */
  private async runRepoScript(
    script: string,
    cwd: string,
    port: number | null,
  ): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (port != null) env.PORT = String(port);
    await execAsync(script, {
      cwd,
      env,
      timeout: this.scriptTimeoutMs,
    });
  }

  /**
   * Best-effort reclaim of a TCP port: find any listener still bound to it and
   * kill it, then wait for the port to become free. Tolerant of platforms
   * without `lsof`.
   */
  private async freePort(port: number): Promise<void> {
    let pids: number[] = [];
    try {
      const { stdout } = await execAsync(`lsof -ti tcp:${port}`);
      pids = stdout
        .split(/\s+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      // lsof missing or no process bound — nothing to do via lsof.
      pids = [];
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Confirm the port is actually free (best-effort; ignore failures).
    try {
      await this.waitForPortFree(port, 2_000);
    } catch {
      /* leave it; downstream binders handle EADDRINUSE */
    }
  }

  /** Resolve once the port can be bound (i.e. is free), or reject on timeout. */
  private waitForPortFree(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const attempt = (): void => {
        const tester = net.createServer();
        tester.once("error", () => {
          tester.close();
          if (Date.now() >= deadline) {
            reject(new Error(`port ${port} still in use`));
          } else {
            setTimeout(attempt, 100);
          }
        });
        tester.once("listening", () => {
          tester.close(() => resolve());
        });
        tester.listen(port, "127.0.0.1");
      };
      attempt();
    });
  }

  /**
   * Delete the Claude session transcript directory for a session root.
   *
   * Claude Code stores transcripts under
   * `~/.claude/projects/<encoded-cwd>/` where `<encoded-cwd>` is the absolute
   * cwd with every non-alphanumeric character replaced by `-`. We tolerate the
   * directory being absent.
   */
  private async deleteClaudeTranscripts(sessionRoot: string): Promise<void> {
    const encoded = encodeClaudeCwd(path.resolve(sessionRoot));
    const dir = path.join(this.claudeProjectsDir, encoded);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /** Absolute path to a task's pty capture log (mirrors PtyService.logPath). */
  private ptyLogPath(taskId: string): string {
    return path.join(this.ptyLogDir, `${encodeURIComponent(taskId)}.log`);
  }

  /** Delete a task's pty capture log. Tolerates the log not existing. */
  private async deletePtyLog(taskId: string): Promise<void> {
    await fs.rm(this.ptyLogPath(taskId), { force: true });
  }

  /**
   * Remove any `<taskId>.log` in the pty-log dir whose taskId no longer backs a
   * live DB task — leftovers from tasks removed uncleanly. Best-effort; a missing
   * dir or unreadable entry is skipped, not fatal.
   */
  private async sweepOrphanPtyLogs(result: SweepResult): Promise<void> {
    const liveTaskIds = new Set(this.repos.tasks.list().map((t) => t.id));
    let entries: string[];
    try {
      entries = await fs.readdir(this.ptyLogDir);
    } catch {
      return; // log dir absent → nothing to sweep
    }
    for (const entry of entries) {
      if (!entry.endsWith(".log")) continue;
      const taskId = decodeURIComponent(entry.slice(0, -".log".length));
      if (liveTaskIds.has(taskId)) continue;
      try {
        await fs.rm(path.join(this.ptyLogDir, entry), { force: true });
        this.log.info(`sweep: removed orphan pty log ${entry}`);
      } catch (err) {
        result.errors.push(`remove orphan pty log ${entry}: ${errMsg(err)}`);
      }
    }
  }

  /** `git worktree unlock` for a single worktree path (tolerant of "not locked"). */
  private async unlockWorktree(worktreePath: string): Promise<void> {
    if (!(await this.pathExists(worktreePath))) return;
    try {
      await execAsync(`git worktree unlock ${shellQuote(worktreePath)}`, {
        cwd: worktreePath,
      });
    } catch {
      // "not locked" / "is not a working tree" are expected and harmless.
    }
  }

  /**
   * Remove the config entries assembleSessionRoot places at the session root
   * (the `CLAUDE.md`, `.claude` + `.mcp.json` symlinks, or their copy-fallback
   * equivalents). For a symlink this unlinks the LINK ONLY — it never follows
   * into and deletes the per-project config source it points at. Best-effort.
   */
  private async removeConfigLinks(sessionRoot: string): Promise<void> {
    for (const entry of ["CLAUDE.md", ".claude", ".mcp.json"]) {
      const target = path.join(sessionRoot, entry);
      try {
        const st = await fs.lstat(target);
        if (st.isSymbolicLink()) {
          await fs.unlink(target);
        } else {
          // Copy-fallback (fs.cp): safe to remove our own copy recursively.
          await fs.rm(target, { recursive: true, force: true });
        }
      } catch {
        // Missing / already gone — nothing to do.
      }
    }
  }

  /**
   * Remove the assembled config symlinks at the session root, then the session
   * root itself, then prune its now-empty project parent dir.
   *
   * The session root is kanban-managed SCRATCH: by this point the git worktrees
   * have been removed, so anything left (e.g. files the agent wrote at the root,
   * like a `docs/` dir) is throwaway. We therefore remove it RECURSIVELY rather
   * than only-if-empty — leaving it only-if-empty is what was stranding stray
   * dirs after a delete. SAFETY: removeConfigLinks first unlinks the
   * CLAUDE.md/.claude/.mcp.json SYMLINKS (never following into the user's real
   * config), and `fs.rm` unlinks any symlink entry it meets (never follows it),
   * so the user's source is never touched. If a child is STILL a git worktree
   * (a `.git` entry — i.e. a busy-guard skip upstream left a registered worktree),
   * we stay conservative and only remove the root if empty, so we never rm a
   * live worktree.
   */
  private async removeSessionRootScratch(sessionRoot: string): Promise<void> {
    await this.removeConfigLinks(sessionRoot);
    let hasWorktree = false;
    for (const child of await this.safeReadDirs(sessionRoot)) {
      if (await this.pathExists(path.join(sessionRoot, child, ".git"))) {
        hasWorktree = true;
        break;
      }
    }
    if (hasWorktree) {
      await this.removeDirIfEmpty(sessionRoot);
    } else {
      await fs.rm(sessionRoot, { recursive: true, force: true });
    }
    await this.removeDirIfEmpty(path.dirname(sessionRoot));
  }

  /** Remove a directory only if it exists and is empty. */
  private async removeDirIfEmpty(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (entries.length === 0) {
      await fs.rmdir(dir);
    }
  }

  /** List immediate sub-directory names of `dir`, or [] if it doesn't exist. */
  private async safeReadDirs(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** True if a filesystem path exists. */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Free helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Depth of a path (number of separated segments). */
function pathDepth(p: string): number {
  return path.resolve(p).split(path.sep).filter(Boolean).length;
}

/**
 * Encode an absolute cwd the way Claude Code names its transcript dir: every
 * character that is not [A-Za-z0-9] becomes a single `-`.
 */
function encodeClaudeCwd(absCwd: string): string {
  return absCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Single-quote a string for safe interpolation into a shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Normalise an unknown thrown value to a message string. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Structural check for the GitService "busy" error. We deliberately do NOT
 * import the concrete git-service module (cross-module refs go through types
 * only), so we match on the error name rather than `instanceof`.
 */
function isWorktreeBusyError(err: unknown): boolean {
  return err instanceof Error && err.name === "WorktreeBusyError";
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
