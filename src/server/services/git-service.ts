/**
 * GitService — creates and tears down git worktrees for tasks, one per repo,
 * and assembles the session root (sibling worktrees + optional template
 * symlinks).
 *
 * Implements the {@link GitService} contract from `../../shared/interfaces`.
 * All git invocations go through a promisified `execFile("git", …)` so arguments
 * are never shell-interpreted. Operations are per-repo and best-effort where the
 * contract calls for tolerance (remote branch deletion, prune, busy heuristics).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AssembleSessionRootOptions,
  CreateTaskWorktreesOptions,
  CreateTaskWorktreesResult,
  GitService as GitServiceContract,
  WorktreeInfo,
} from "../../shared/interfaces.js";
import type { TaskRepo } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

/** Result of a raw git invocation. */
interface GitRun {
  stdout: string;
  stderr: string;
}

/** Error thrown when a git command exits non-zero, carrying its output. */
export class GitCommandError extends Error {
  readonly args: string[];
  readonly cwd: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;

  constructor(
    args: string[],
    cwd: string | undefined,
    code: number | string | null,
    stdout: string,
    stderr: string,
  ) {
    super(
      `git ${args.join(" ")} failed (code ${code ?? "?"})${
        stderr ? `: ${stderr.trim()}` : ""
      }`,
    );
    this.name = "GitCommandError";
    this.args = args;
    this.cwd = cwd;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Directory names that commonly bloat a worktree and block `worktree remove`. */
const HEAVY_DIRS = ["node_modules", "vendor", ".venv", "dist", "build"] as const;

/** How many times the soft (open-files) busy probe is retried before giving up. */
const BUSY_PROBE_ATTEMPTS = 3;
/** Delay between soft busy probes, letting a just-killed child finish dying. */
const BUSY_PROBE_INTERVAL_MS = 150;

/** Error thrown by the destructive chokepoint when a worktree is genuinely busy. */
export class WorktreeBusyError extends Error {
  readonly worktreePath: string;
  constructor(worktreePath: string) {
    super(`worktree is busy (locked or held open): ${worktreePath}`);
    this.name = "WorktreeBusyError";
    this.worktreePath = worktreePath;
  }
}

export class GitServiceImpl implements GitServiceContract {
  /** Base directory under which session roots are assembled when none given. */
  private readonly defaultBaseDir: string;

  constructor(defaultBaseDir?: string) {
    this.defaultBaseDir =
      defaultBaseDir ?? path.join(os.homedir(), "claude-kanban-sessions");
  }

  /* ──────────────────────────────────────────────────────────────────────
   * createTaskWorktrees
   * ──────────────────────────────────────────────────────────────────── */

  async createTaskWorktrees(
    opts: CreateTaskWorktreesOptions,
  ): Promise<CreateTaskWorktreesResult> {
    const base = opts.baseDir ?? this.defaultBaseDir;
    const sessionRoot = path.join(base, opts.projectName, opts.slug);

    await fs.mkdir(sessionRoot, { recursive: true });

    const taskRepos: TaskRepo[] = [];
    // Track what we created so we can roll back on a partial failure.
    const created: Array<{ repoPath: string; worktreePath: string; branch: string }> =
      [];

    try {
      for (const repo of opts.repos) {
        const worktreePath = path.join(sessionRoot, repo.repoName);
        const branchName = await this.resolveBranchName(
          repo.repoPath,
          opts.slug,
        );

        await this.run(
          [
            "worktree",
            "add",
            worktreePath,
            "-b",
            branchName,
            repo.baseBranch,
          ],
          repo.repoPath,
        );

        created.push({ repoPath: repo.repoPath, worktreePath, branch: branchName });

        // Copy configured untracked files (e.g. `.env`, secrets, local-only
        // fixtures) from the ORIGINAL repo working dir into the fresh worktree.
        // Best-effort by contract: a missing/unsafe pattern or a copy error is
        // swallowed and NEVER fails worktree/task creation.
        //
        // The repo's SETUP SCRIPT is NOT run here anymore — setup is now a manual
        // panel button handled by CommandRunnerService, so worktree creation just
        // provisions files and leaves running scripts to the user.
        await this.copyUntrackedFiles(
          repo.repoPath,
          worktreePath,
          opts.copyFiles,
        );

        taskRepos.push({
          // Persisted id is assigned by the repository layer; a stable
          // placeholder keeps the shape valid for callers that do not persist.
          id: "",
          taskId: opts.taskId,
          projectRepoId: repo.projectRepoId,
          repoName: repo.repoName,
          branchName,
          worktreePath,
          remotePushed: false,
        });
      }
    } catch (err) {
      // Roll back every worktree + branch created so far, then surface the error.
      await this.rollback(created);
      throw err;
    }

    return { sessionRoot, taskRepos };
  }

  /**
   * Copy each configured `copyFiles` pattern from the ORIGINAL repo working dir
   * (`<repoPath>/<pattern>`) into the freshly created worktree
   * (`<worktreePath>/<pattern>`). A REAL recursive copy (files or dirs), NOT a
   * symlink. Best-effort throughout: a missing pattern is skipped and any copy
   * error is swallowed + logged — a bad pattern must NEVER fail task creation.
   *
   * SECURITY: patterns are relative to the repo root. Absolute patterns and any
   * pattern containing a `..` segment are rejected outright; in addition, each
   * resolved source is asserted to stay within `repoPath` and each resolved dest
   * within `worktreePath`, so a pattern can never read/write outside the repo or
   * the worktree. The lexical checks above do NOT follow symlinks, so we ALSO
   * resolve the source's REAL path (`fs.realpath`) and re-assert it stays within
   * the repo — a symlink (file OR directory) inside the repo that points outside
   * is rejected, never chased — and copy with `dereference: false` so any nested
   * symlinks inside a copied directory are preserved verbatim rather than walked
   * into and materialised as real files in the worktree.
   *
   * GLOB: a `*`/`?` wildcard is supported in the FINAL path segment only and is
   * expanded by reading the pattern's parent directory inside the repo (no
   * recursive `**`).
   */
  private async copyUntrackedFiles(
    repoPath: string,
    worktreePath: string,
    patterns: string[] | undefined,
  ): Promise<void> {
    if (!patterns || patterns.length === 0) return;

    const repoRoot = path.resolve(repoPath);
    const worktreeRoot = path.resolve(worktreePath);

    for (const raw of patterns) {
      try {
        const pattern = typeof raw === "string" ? raw.trim() : "";
        if (!pattern) continue;
        // SECURITY: reject absolute paths and any `..` traversal up front.
        if (!isSafeRelativePattern(pattern)) {
          console.warn(
            `[git-service] skipping unsafe copyFiles pattern: ${raw}`,
          );
          continue;
        }

        // Expand a trailing-segment glob (if any) into concrete relative paths.
        const relPaths = hasGlob(path.basename(pattern))
          ? await this.expandGlobPattern(repoRoot, pattern)
          : [pattern];

        for (const rel of relPaths) {
          const src = path.resolve(repoRoot, rel);
          const dest = path.resolve(worktreeRoot, rel);
          // SECURITY: confirm the resolved paths stay inside their roots — a
          // belt-and-braces check on top of the pattern validation above.
          if (!isWithin(repoRoot, src) || !isWithin(worktreeRoot, dest)) {
            console.warn(
              `[git-service] skipping copyFiles pattern escaping its root: ${rel}`,
            );
            continue;
          }
          // Skip patterns that do not exist in the source repo. Use lstat so a
          // dangling/escaping symlink is still observed (access() would follow
          // it and may report it missing or reach outside the repo).
          let lst;
          try {
            lst = await fs.lstat(src);
          } catch {
            continue;
          }

          // SECURITY: the lexical isWithin() check cannot see through symlinks.
          // Resolve the REAL on-disk path and re-assert containment so a symlink
          // (file OR directory) inside the repo pointing OUTSIDE cannot be chased
          // to exfiltrate outside content into the worktree. A symlink whose
          // target does not exist (dangling) has no realpath → skip it too.
          let realSrc: string;
          try {
            realSrc = await fs.realpath(src);
          } catch {
            if (lst.isSymbolicLink()) {
              console.warn(
                `[git-service] skipping copyFiles symlink with unresolvable target: ${rel}`,
              );
              continue;
            }
            // A non-symlink that vanished between lstat and realpath — skip.
            continue;
          }
          if (!isWithin(repoRoot, realSrc)) {
            console.warn(
              `[git-service] skipping copyFiles entry whose real path escapes the repo: ${rel}`,
            );
            continue;
          }

          await fs.mkdir(path.dirname(dest), { recursive: true });
          // `dereference: false` (+ verbatimSymlinks) so nested symlinks inside a
          // copied directory are PRESERVED, never walked into and materialised as
          // real files. Combined with the realpath check above, the top-level
          // entry is guaranteed in-repo, and any inner symlink that escapes stays
          // an inert (dangling-in-worktree) link rather than copied-out data.
          await fs.cp(src, dest, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
        }
      } catch (err) {
        // Swallow + log: a copy error must never fail worktree/task creation.
        console.warn(
          `[git-service] copyFiles pattern "${raw}" failed (continuing):`,
          err,
        );
      }
    }
  }

  /**
   * Expand a relative pattern whose FINAL segment contains a `*`/`?` wildcard by
   * listing the pattern's parent directory inside the repo and matching basenames
   * against it. Returns concrete relative paths (parentDir joined with each
   * matching name). Returns `[]` when the parent dir is unreadable or nothing
   * matches. Only the last segment may glob — parent segments are literal.
   */
  private async expandGlobPattern(
    repoRoot: string,
    pattern: string,
  ): Promise<string[]> {
    const parentRel = path.dirname(pattern); // "." when pattern is bare
    const globPart = path.basename(pattern);
    const re = globToRegExp(globPart);
    const parentAbs = path.resolve(repoRoot, parentRel);
    // SECURITY: the parent dir must still be within the repo root.
    if (!isWithin(repoRoot, parentAbs) && parentAbs !== repoRoot) return [];

    let names: string[];
    try {
      names = await fs.readdir(parentAbs);
    } catch {
      return [];
    }
    return names
      .filter((name) => re.test(name))
      .map((name) => (parentRel === "." ? name : path.join(parentRel, name)));
  }

  /** Pick a branch name; append a short suffix if the slug already exists. */
  private async resolveBranchName(
    repoPath: string,
    slug: string,
  ): Promise<string> {
    if (!(await this.branchExists(repoPath, slug))) return slug;
    // Up to a handful of attempts with random suffixes, then fall back to a
    // timestamp so we always converge on a free name.
    for (let i = 0; i < 8; i += 1) {
      const candidate = `${slug}-${randomSuffix()}`;
      if (!(await this.branchExists(repoPath, candidate))) return candidate;
    }
    return `${slug}-${Date.now().toString(36)}`;
  }

  /** True if `git rev-parse --verify refs/heads/<branch>` succeeds. */
  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.run(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        repoPath,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort teardown of worktrees + branches created during a failed run. */
  private async rollback(
    created: Array<{ repoPath: string; worktreePath: string; branch: string }>,
  ): Promise<void> {
    for (const c of created.reverse()) {
      try {
        await this.removeWorktreeAtPath(c.repoPath, c.worktreePath);
      } catch {
        /* best-effort */
      }
      try {
        await this.run(["branch", "-D", c.branch], c.repoPath);
      } catch {
        /* best-effort */
      }
      try {
        await this.run(["worktree", "prune"], c.repoPath);
      } catch {
        /* best-effort */
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * removeTaskWorktrees
   * ──────────────────────────────────────────────────────────────────── */

  async removeTaskWorktrees(taskRepos: TaskRepo[]): Promise<void> {
    for (const tr of taskRepos) {
      const repoPath = await this.findSourceRepo(tr.worktreePath);

      // DEFENSIVE CHOKEPOINT: this is the single place destructive removal
      // (`worktree remove --force` / `rm -rf`) happens, so the busy decision is
      // re-checked here — immediately before deleting — and NOT left to callers.
      // This closes the check-then-act (TOCTOU) window in which a tool could
      // open the tree between a caller's pre-guard and this call, and protects
      // any caller (e.g. rollbackCreate) that forgot to pre-guard at all. A path
      // already gone (already removed) is not busy — there is nothing to hold.
      if (
        (await this.pathExists(tr.worktreePath)) &&
        (await this.isWorktreeBusy(tr.worktreePath))
      ) {
        throw new WorktreeBusyError(tr.worktreePath);
      }

      try {
        await this.removeWorktreeAtPath(repoPath, tr.worktreePath);
      } catch {
        // Heavy untracked dirs (node_modules/vendor/…) can block removal: strip
        // them and retry, then fall back to a hard rm of the whole path.
        await this.stripHeavyDirs(tr.worktreePath);
        try {
          await this.removeWorktreeAtPath(repoPath, tr.worktreePath);
        } catch {
          await fs.rm(tr.worktreePath, { recursive: true, force: true });
        }
      } finally {
        if (repoPath) {
          try {
            await this.run(["worktree", "prune"], repoPath);
          } catch {
            /* best-effort */
          }
        }
      }
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

  /** `git worktree remove --force <path>` run from the source repo when known. */
  private async removeWorktreeAtPath(
    repoPath: string | undefined,
    worktreePath: string,
  ): Promise<void> {
    await this.run(
      ["worktree", "remove", "--force", worktreePath],
      repoPath,
    );
  }

  /** Delete known heavy untracked directories under a worktree. */
  private async stripHeavyDirs(worktreePath: string): Promise<void> {
    await Promise.all(
      HEAVY_DIRS.map((dir) =>
        fs.rm(path.join(worktreePath, dir), { recursive: true, force: true }),
      ),
    );
  }

  /**
   * Resolve the source repo a worktree belongs to by reading its `.git` file
   * (linked worktrees store a `gitdir:` pointer). Returns undefined if it cannot
   * be determined; callers then fall back to path-based removal.
   */
  private async findSourceRepo(
    worktreePath: string,
  ): Promise<string | undefined> {
    try {
      const top = (
        await this.run(["rev-parse", "--show-toplevel"], worktreePath)
      ).stdout.trim();
      // For a linked worktree this resolves to the worktree itself; we need the
      // common dir's parent (the source repo).
      const common = (
        await this.run(["rev-parse", "--git-common-dir"], worktreePath)
      ).stdout.trim();
      const commonAbs = path.isAbsolute(common)
        ? common
        : path.resolve(worktreePath, common);
      // common dir is "<sourceRepo>/.git"; its parent is the source repo.
      const sourceRepo = path.dirname(commonAbs);
      return sourceRepo || top || undefined;
    } catch {
      return undefined;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Branch deletion
   * ──────────────────────────────────────────────────────────────────── */

  async deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
    await this.run(["branch", "-D", branch], repoPath);
  }

  async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    try {
      await this.run(["push", "origin", "--delete", branch], repoPath);
    } catch (err) {
      // Tolerate a missing remote or an already-absent remote branch: those are
      // not actionable failures for teardown.
      if (this.isToleratedRemoteError(err)) return;
      throw err;
    }
  }

  /** True for "no remote" / "remote ref does not exist" style failures. */
  private isToleratedRemoteError(err: unknown): boolean {
    if (!(err instanceof GitCommandError)) return false;
    const text = `${err.stderr}\n${err.stdout}`.toLowerCase();
    return (
      text.includes("does not appear to be a git repository") ||
      text.includes("could not read from remote repository") ||
      text.includes("no such remote") ||
      text.includes("remote ref does not exist") ||
      text.includes("unable to delete") ||
      text.includes("couldn't find remote ref") ||
      text.includes("'origin' does not appear")
    );
  }

  /* ──────────────────────────────────────────────────────────────────────
   * prune / list
   * ──────────────────────────────────────────────────────────────────── */

  async pruneWorktrees(repoPath: string): Promise<void> {
    await this.run(["worktree", "prune"], repoPath);
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const { stdout } = await this.run(
      ["worktree", "list", "--porcelain"],
      repoPath,
    );
    return parsePorcelainWorktrees(stdout);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * isWorktreeBusy
   * ──────────────────────────────────────────────────────────────────── */

  async isWorktreeBusy(worktreePath: string): Promise<boolean> {
    // 1) HARD busy: a git-level lock (.git/worktrees/<name>/locked). This is a
    //    deliberate, persistent lock — never retry past it, it is not transient.
    if (await this.hasWorktreeLock(worktreePath)) return true;

    // 2) SOFT busy: a process still holding a file open under the path. Right
    //    after a group-kill this can be transient (a child winding down), so we
    //    retry a few times before declaring the tree busy and skipping removal.
    //    A pid we ourselves just killed must NOT count: we exclude pids that are
    //    no longer alive between the probe and the check.
    for (let attempt = 0; attempt < BUSY_PROBE_ATTEMPTS; attempt += 1) {
      if (!(await this.pathHasOpenFiles(worktreePath))) return false;
      if (attempt < BUSY_PROBE_ATTEMPTS - 1) {
        await delay(BUSY_PROBE_INTERVAL_MS);
      }
    }
    return true;
  }

  /** Check for a `locked` admin file in the linked worktree's git dir. */
  private async hasWorktreeLock(worktreePath: string): Promise<boolean> {
    try {
      const gitDir = (
        await this.run(["rev-parse", "--git-dir"], worktreePath)
      ).stdout.trim();
      const gitDirAbs = path.isAbsolute(gitDir)
        ? gitDir
        : path.resolve(worktreePath, gitDir);
      await fs.access(path.join(gitDirAbs, "locked"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort `lsof` to detect a LIVE process holding a file open anywhere
   * under the path. We parse pids (`-F p`) and treat the tree as busy only if at
   * least one reported pid is still alive — a pid we just killed (now reaped)
   * must never count as busy, which previously caused us to skip removal of a
   * tree that was actually free.
   *
   * lsof's exit code is unreliable as a busy signal: it exits non-zero both when
   * nothing matches AND when some paths could not be stat'd, and may emit stray
   * warnings. We therefore decide solely from the parsed live pids and never
   * infer "busy" from a non-zero exit with leftover stdout.
   */
  private async pathHasOpenFiles(worktreePath: string): Promise<boolean> {
    let stdout = "";
    try {
      // -F p → machine-readable, one field per line; pid lines start with "p".
      const res = await execFileAsync("lsof", ["-w", "-F", "p", "+D", worktreePath], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = res.stdout.toString();
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string | Buffer;
      };
      if (e && e.code === "ENOENT") return false; // lsof not installed → not busy
      // Non-zero exit: lsof still prints matches it found to stdout. Parse those
      // (a genuine match means a live holder); no parseable stdout ⇒ not busy.
      stdout = e.stdout ? e.stdout.toString() : "";
    }

    const pids = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("p")) {
        const pid = Number.parseInt(line.slice(1), 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    if (pids.size === 0) return false;

    // Only a process that is STILL alive counts. A pid we just SIGKILLed may
    // still appear in lsof output captured a moment earlier; if it is gone now,
    // the tree is free.
    for (const pid of pids) {
      if (isPidAlive(pid)) return true;
    }
    return false;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * assembleSessionRoot
   * ──────────────────────────────────────────────────────────────────── */

  async assembleSessionRoot(opts: AssembleSessionRootOptions): Promise<void> {
    await fs.mkdir(opts.sessionRoot, { recursive: true });

    // Independent links: an explicit CLAUDE.md FILE, a .claude DIRECTORY and an
    // .mcp.json FILE. Each source is symlinked into the session root under its
    // canonical name, and ONLY when the source path is set AND actually exists.
    // Any of them may be absent without affecting the others.
    await this.linkInto(
      opts.claudeMdPath,
      path.join(opts.sessionRoot, "CLAUDE.md"),
    );
    await this.linkInto(
      opts.claudeDirPath,
      path.join(opts.sessionRoot, ".claude"),
    );
    await this.linkInto(
      opts.mcpConfigPath,
      path.join(opts.sessionRoot, ".mcp.json"),
    );
  }

  /**
   * Symlink `src` to `dest` (copy fallback when symlinks are unavailable), only
   * when `src` is set AND exists. Idempotent: any pre-existing entry at `dest` is
   * removed first. A null/missing source is a no-op.
   */
  private async linkInto(
    src: string | null | undefined,
    dest: string,
  ): Promise<void> {
    if (!src) return;

    // Only link what actually exists on disk.
    try {
      await fs.access(src);
    } catch {
      return;
    }

    // Idempotent: replace any existing entry at the destination.
    try {
      await fs.rm(dest, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }

    try {
      await fs.symlink(src, dest);
    } catch {
      // Fall back to a copy when symlinks are unavailable (e.g. restricted FS).
      await fs.cp(src, dest, { recursive: true });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Low-level git runner
   * ──────────────────────────────────────────────────────────────────── */

  /** Run `git <args>` (optionally in `cwd`); throw {@link GitCommandError} on failure. */
  private async run(args: string[], cwd?: string): Promise<GitRun> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        // Keep git non-interactive so it never blocks on a prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      throw new GitCommandError(
        args,
        cwd,
        e.code ?? null,
        e.stdout ? e.stdout.toString() : "",
        e.stderr ? e.stderr.toString() : "",
      );
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Short, lowercase-alphanumeric suffix for disambiguating branch names. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** True if a string contains a `*` or `?` glob wildcard. */
function hasGlob(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

/**
 * True if `pattern` is a SAFE relative copy pattern: not absolute, and with no
 * `..` traversal segment. Normalised with POSIX + win32 separators so a `..`
 * cannot sneak in via either separator on any platform.
 */
function isSafeRelativePattern(pattern: string): boolean {
  if (path.isAbsolute(pattern)) return false;
  // Reject a Windows-style absolute / drive-letter path too (path.isAbsolute is
  // platform-dependent; on POSIX it would not flag "C:\..").
  if (/^[A-Za-z]:[\\/]/.test(pattern) || pattern.startsWith("\\")) return false;
  const segments = pattern.split(/[\\/]+/);
  return !segments.includes("..");
}

/**
 * True if `child` is the same as, or nested under, `parent`. Both are resolved
 * absolute paths. Used as a defence-in-depth boundary assertion so a copy can
 * never escape the repo (source) or worktree (dest) root.
 */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  );
}

/**
 * Compile a single-segment glob (only `*` and `?`) into an anchored RegExp.
 * `*` → any run of chars, `?` → exactly one char; every other character is
 * escaped so it matches literally. No `**`/path-separator handling — the caller
 * only ever passes a basename.
 */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out);
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if `pid` still exists (signal 0 probe; EPERM ⇒ exists). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Records are separated by a blank line. Each record begins with a `worktree`
 * line and may contain `HEAD`, `branch`, `detached`, `bare`, and `locked` lines.
 */
export function parsePorcelainWorktrees(stdout: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  const blocks = stdout
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  blocks.forEach((block, index) => {
    let wtPath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let locked = false;

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
      }
    }

    if (!wtPath) return;

    result.push({
      path: wtPath,
      branch,
      head,
      // The first record is always the repo's primary (non-linked) worktree.
      isMain: index === 0,
      locked,
    });
  });

  return result;
}

/** Default singleton wiring is left to the composition root (server bootstrap). */
export default GitServiceImpl;
