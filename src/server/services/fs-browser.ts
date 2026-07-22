/**
 * FsBrowserServiceImpl — read-only, allow-rooted filesystem inspection that
 * powers the "browse, don't type" repo picker.
 *
 * Implements the {@link FsBrowserService} contract from `../../shared/interfaces`.
 *
 * SECURITY MODEL (this is a LOCAL single-user tool, but the boundary is still
 * enforced server-side so a crafted request can't read arbitrary disk):
 *   • Allow-roots come from Config.browseRoots, each already path.resolve()'d.
 *   • Every requested path is path.resolve()'d, then collapsed with
 *     fs.realpathSync.native() (when available) so `..`, `.` and symlinks are
 *     resolved BEFORE the boundary check.
 *   • A path is accepted only if, after resolution, it is equal to — or a
 *     path.sep-bounded descendant of — at least one allow-root. Anything else
 *     (escaping `..`, an absolute path outside the roots) throws FsBrowseError,
 *     which the router maps to a 400.
 *   • Listings are SHALLOW (immediate children only) and never follow symlinked
 *     directories (loop protection) or descend into a deny-list of heavy/system
 *     dirs. Entries are capped at MAX_ENTRIES; the response flags `truncated`.
 *
 * No GitService import — to keep modules decoupled this file has its own tiny
 * `git(args, cwd)` exec helper. Git failures NEVER reach the client: base-branch
 * detection and the branch list are best-effort and degrade to null / [].
 */
import { execFile } from "node:child_process";
import { promises as fs, realpathSync, statSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Config } from "../config.js";
import {
  FsBrowseError,
  type FsBrowserService,
} from "../../shared/interfaces.js";
import type {
  FsEntry,
  FsInspectResponse,
  FsListResponse,
  FsRoot,
  FsRootsResponse,
} from "../../shared/types.js";

const execFileAsync = promisify(execFile);

/** Max immediate-child entries returned by a single listing before truncation. */
const MAX_ENTRIES = 500;

/** Max local branches returned by an inspect call. */
const MAX_BRANCHES = 200;

/** How long (ms) any single git invocation may run before it is killed. */
const GIT_TIMEOUT_MS = 5000;

/**
 * Directory basenames we never descend into / never surface as navigable
 * entries even when inside an allow-root. These are heavy or system dirs whose
 * contents are irrelevant to picking a repo. `.git` is handled specially: it is
 * never returned as a navigable entry, but its PRESENCE is what flags a repo.
 */
const DENY_BASENAMES = new Set<string>([
  "node_modules",
  ".git",
  ".cache",
  "Library",
  ".Trash",
  "snap",
  ".npm",
  ".pnpm-store",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
]);

export class FsBrowserServiceImpl implements FsBrowserService {
  /** Allow-roots, resolved (Config already path.resolve()'s them). */
  private readonly roots_: string[];

  constructor(config: Pick<Config, "browseRoots">) {
    const roots =
      config.browseRoots && config.browseRoots.length > 0
        ? config.browseRoots
        : [os.homedir()];
    // Canonicalize (realpath) each root, not just path.resolve, so the boundary
    // check compares like-for-like: requested paths are realpath'd in
    // validateDir, so the roots must be too — otherwise a symlinked home/root
    // (common on WSL) makes every in-root path look "outside" and get rejected.
    this.roots_ = roots.map((r) => canonicalize(path.resolve(r)));
  }

  /* ──────────────────────────────────────────────────────────────────────
   * roots
   * ──────────────────────────────────────────────────────────────────── */

  roots(): FsRootsResponse {
    const home = os.homedir();
    const roots: FsRoot[] = this.roots_.map((p) => ({
      path: p,
      label: p === home ? "Home" : path.basename(p) || p,
    }));
    return { roots };
  }

  /* ──────────────────────────────────────────────────────────────────────
   * list
   * ──────────────────────────────────────────────────────────────────── */

  async list(
    requestedPath?: string,
    opts?: { includeFiles?: boolean },
  ): Promise<FsListResponse> {
    // Empty/omitted → list the first allow-root (home by default).
    const target =
      requestedPath && requestedPath.trim().length > 0
        ? this.validateDir(requestedPath)
        : this.firstRoot();

    const entries = await this.readDirEntries(target.path, {
      includeFiles: opts?.includeFiles === true,
    });

    return {
      path: target.path,
      parent: this.parentWithinRoots(target.path),
      isGitRepo: isGitRepo(target.path),
      entries: entries.list,
      childGitRepos: entries.list.filter((e) => e.isGitRepo),
      truncated: entries.truncated,
    };
  }

  /* ──────────────────────────────────────────────────────────────────────
   * inspect
   * ──────────────────────────────────────────────────────────────────── */

  async inspect(requestedPath: string): Promise<FsInspectResponse> {
    if (!requestedPath || requestedPath.trim().length === 0) {
      throw new FsBrowseError("`path` is required");
    }
    const target = this.validateDir(requestedPath);
    const repo = isGitRepo(target.path);

    // inspect only needs child git repos (directories), so never include files.
    const childEntries = await this.readDirEntries(target.path, {
      includeFiles: false,
    });
    const childGitRepos = childEntries.list.filter((e) => e.isGitRepo);

    // Git metadata is best-effort: a non-repo (or any git error) yields null/[].
    const baseBranch = repo ? await detectBaseBranch(target.path) : null;
    const branches = repo ? await listBranches(target.path) : [];

    return {
      path: target.path,
      isGitRepo: repo,
      name: path.basename(target.path),
      baseBranch,
      branches,
      childGitRepos,
    };
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Path validation / boundary enforcement
   * ──────────────────────────────────────────────────────────────────── */

  /** The first allow-root, as a validated descriptor. */
  private firstRoot(): { path: string } {
    const first = this.roots_[0] ?? os.homedir();
    // Resolve symlinks for a stable canonical path; the root itself is allowed.
    return { path: canonicalize(first) };
  }

  /**
   * Resolve + canonicalize a requested path, enforce the allow-root boundary,
   * and assert it is an existing directory. Throws {@link FsBrowseError} on any
   * violation (out-of-root, non-existent, not-a-directory).
   */
  private validateDir(requestedPath: string): { path: string } {
    const resolved = canonicalize(path.resolve(requestedPath));

    if (!this.withinRoots(resolved)) {
      throw new FsBrowseError("Path is outside the allowed roots");
    }

    let stat: Stats;
    try {
      stat = statSync(resolved);
    } catch {
      throw new FsBrowseError("Path does not exist");
    }
    if (!stat.isDirectory()) {
      throw new FsBrowseError("Not a directory");
    }
    return { path: resolved };
  }

  /** True if `resolved` equals or is a sep-bounded descendant of any root. */
  private withinRoots(resolved: string): boolean {
    return this.roots_.some((root) => isWithin(root, resolved));
  }

  /** Parent dir of `dir` IF it is still inside an allow-root, else null. */
  private parentWithinRoots(dir: string): string | null {
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    return this.withinRoots(parent) ? parent : null;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Directory reading
   * ──────────────────────────────────────────────────────────────────── */

  /**
   * Read the immediate children of `dir`. Always returns navigable
   * sub-directories; when `opts.includeFiles` is true, regular files are also
   * returned (flagged `isFile`, sorted after directories) so the picker can show
   * them for orientation. Skips: symlinks (loop protection / no target chasing),
   * `.git`, and deny-listed basenames. Each surviving entry is flagged
   * `isFile`/`isGitRepo`/`hidden`. Unreadable entries are silently skipped (never
   * crash on EACCES/EPERM). Sorted: git repos first, then other dirs, then files,
   * alpha within each group. Capped at MAX_ENTRIES (after sorting).
   */
  private async readDirEntries(
    dir: string,
    opts: { includeFiles: boolean },
  ): Promise<{ list: FsEntry[]; truncated: boolean }> {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, races) → empty, never throw.
      return { list: [], truncated: false };
    }

    const list: FsEntry[] = [];

    for (const dirent of dirents) {
      const name = dirent.name;

      // `.git` is never navigable; deny-listed dirs are never surfaced.
      if (name === ".git" || DENY_BASENAMES.has(name)) continue;

      const full = path.join(dir, name);

      // Use lstat so a symlink is detected as a symlink (not its target) — we
      // skip symlinks to avoid loops and target chasing.
      let lst;
      try {
        lst = await fs.lstat(full);
      } catch {
        continue; // unreadable entry → skip
      }
      if (lst.isSymbolicLink()) continue;

      if (lst.isDirectory()) {
        list.push({
          path: full,
          name,
          isFile: false,
          isGitRepo: isGitRepo(full),
          hidden: name.startsWith("."),
        });
      } else if (opts.includeFiles && lst.isFile()) {
        list.push({
          path: full,
          name,
          isFile: true,
          isGitRepo: false,
          hidden: name.startsWith("."),
        });
      }
      // Anything else (sockets, fifos, block/char devices) is ignored.
    }

    list.sort(compareEntries);
    // Truncate AFTER sorting so the returned page is deterministically the
    // (git-repos-first, then alphabetical) prefix — not whatever order readdir
    // happened to surface first.
    if (list.length > MAX_ENTRIES) {
      return { list: list.slice(0, MAX_ENTRIES), truncated: true };
    }
    return { list, truncated: false };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Free helpers (pure / git plumbing)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve symlinks/`.`/`..` to a canonical absolute path. Uses the native
 * realpath when available; falls back to path.resolve when the path does not
 * yet resolve (e.g. a broken symlink) so the boundary check still runs on a
 * normalized form.
 */
function canonicalize(p: string): string {
  try {
    const real = realpathSync.native ?? realpathSync;
    return real(p);
  } catch {
    return path.resolve(p);
  }
}

/** True if `child` equals `root` or is a path.sep-bounded descendant of it. */
function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

/** True if `dir` contains a `.git` entry (dir for a normal repo, file for a
 *  worktree/submodule). Existence-only; never throws. */
function isGitRepo(dir: string): boolean {
  try {
    statSync(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sort comparator: directories before files; within directories, git repos
 * first; then case-insensitive alpha by name within each group.
 */
function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
  if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Best-effort base-branch detection for a repo at `cwd`:
 *   a. current branch        — `symbolic-ref --short HEAD`
 *   b. default branch        — `symbolic-ref --short refs/remotes/origin/HEAD` (strip "origin/")
 *   c. first local branch    — `branch --format=%(refname:short)`
 *   d. null
 * Any git error is swallowed and falls through to the next step / null.
 */
async function detectBaseBranch(cwd: string): Promise<string | null> {
  const head = await git(["symbolic-ref", "--short", "HEAD"], cwd);
  if (head) return head;

  const originHead = await git(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  if (originHead) return originHead.replace(/^origin\//, "");

  const first = await git(["branch", "--format=%(refname:short)"], cwd);
  if (first) {
    const line = first.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (line) return line.trim();
  }

  return null;
}

/** Best-effort local branch list (capped). Empty on any git error. */
async function listBranches(cwd: string): Promise<string[]> {
  const out = await git(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    cwd,
  );
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_BRANCHES);
}

/**
 * Run `git -C <cwd> <args>` with no shell, a fixed timeout, and stderr
 * swallowed. Returns trimmed stdout on success, or null on ANY failure (git
 * missing, non-zero exit, timeout) — callers treat null as "unknown / not a
 * repo" and never surface git errors to the client.
 */
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const text = stdout.toString().trim();
    return text.length > 0 ? text : "";
  } catch {
    return null;
  }
}

/** Default singleton wiring is left to the composition root (server bootstrap). */
export default FsBrowserServiceImpl;
