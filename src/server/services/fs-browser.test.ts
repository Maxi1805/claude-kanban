/**
 * Tests for FsBrowserServiceImpl.
 *
 * Builds throwaway directory trees and real `git init` repos under os.tmpdir(),
 * scopes the service's allow-roots to that tree, and exercises: out-of-root
 * rejection, `..` escape rejection, git-repo flagging (dir + worktree-file),
 * deny-list/symlink skipping, base-branch detection, and graceful degradation
 * on non-repos. Everything is cleaned up afterwards.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsBrowseError } from "../../shared/interfaces.js";
import { FsBrowserServiceImpl } from "./fs-browser.js";

const execFileAsync = promisify(execFile);

/** Run a git command in `cwd`, returning trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.toString().trim();
}

/** Create a fresh git repo with one commit on `main` at `dir`. */
async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await fs.writeFile(path.join(dir, "README.md"), "# test\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial");
}

describe("FsBrowserServiceImpl", () => {
  let tmpRoot: string;
  let svc: FsBrowserServiceImpl;

  beforeEach(async () => {
    // realpath so the canonical form matches (macOS /tmp → /private/tmp etc.).
    tmpRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ck-fs-test-")),
    );
    svc = new FsBrowserServiceImpl({ browseRoots: [tmpRoot] });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /* ── roots ──────────────────────────────────────────────────────────── */

  it("reports the configured allow-roots with labels", () => {
    const { roots } = svc.roots();
    expect(roots).toHaveLength(1);
    expect(roots[0].path).toBe(tmpRoot);
    expect(roots[0].label).toBe(path.basename(tmpRoot));
  });

  /* ── boundary enforcement ───────────────────────────────────────────── */

  it("rejects an absolute path outside the allow-roots with FsBrowseError", async () => {
    await expect(svc.list("/etc")).rejects.toBeInstanceOf(FsBrowseError);
    await expect(svc.inspect("/etc")).rejects.toBeInstanceOf(FsBrowseError);
  });

  it("rejects a `..` escape that climbs out of a root", async () => {
    const escape = path.join(tmpRoot, "..", "..", "..");
    await expect(svc.list(escape)).rejects.toBeInstanceOf(FsBrowseError);
  });

  it("rejects a non-existent path inside a root", async () => {
    await expect(
      svc.list(path.join(tmpRoot, "does-not-exist")),
    ).rejects.toThrow(/does not exist/i);
  });

  it("rejects a file (not a directory)", async () => {
    const file = path.join(tmpRoot, "a-file.txt");
    await fs.writeFile(file, "hi");
    await expect(svc.list(file)).rejects.toThrow(/not a directory/i);
  });

  /* ── listing ────────────────────────────────────────────────────────── */

  it("lists the first root when no path is given, parent null at the root", async () => {
    const res = await svc.list();
    expect(res.path).toBe(tmpRoot);
    expect(res.parent).toBeNull(); // root boundary caps "up"
  });

  it("returns only directories by default, flags git repos, sorts repos first", async () => {
    await initRepo(path.join(tmpRoot, "zzz-repo")); // a repo, alpha-last
    await fs.mkdir(path.join(tmpRoot, "aaa-plain")); // a plain dir, alpha-first
    await fs.writeFile(path.join(tmpRoot, "file.txt"), "x"); // a file → excluded

    const res = await svc.list(tmpRoot);
    const names = res.entries.map((e) => e.name);

    expect(names).not.toContain("file.txt");
    // git repo sorts before the plain dir despite alpha order.
    expect(names).toEqual(["zzz-repo", "aaa-plain"]);

    const repo = res.entries.find((e) => e.name === "zzz-repo");
    expect(repo?.isGitRepo).toBe(true);
    expect(repo?.isFile).toBe(false);
    expect(res.entries.every((e) => e.isFile === false)).toBe(true);
    expect(res.childGitRepos.map((e) => e.name)).toEqual(["zzz-repo"]);
  });

  it("excludes files when includeFiles is false/omitted", async () => {
    await fs.mkdir(path.join(tmpRoot, "dir"));
    await fs.writeFile(path.join(tmpRoot, "CLAUDE.md"), "# bare\n");

    const omitted = await svc.list(tmpRoot);
    expect(omitted.entries.map((e) => e.name)).not.toContain("CLAUDE.md");

    const explicitFalse = await svc.list(tmpRoot, { includeFiles: false });
    expect(explicitFalse.entries.map((e) => e.name)).not.toContain("CLAUDE.md");
  });

  it("includes files when includeFiles is true, flagged and sorted after dirs", async () => {
    await initRepo(path.join(tmpRoot, "zzz-repo")); // git dir, sorts first
    await fs.mkdir(path.join(tmpRoot, "aaa-dir")); // plain dir
    await fs.writeFile(path.join(tmpRoot, "CLAUDE.md"), "# bare\n"); // file
    await fs.writeFile(path.join(tmpRoot, "aaa-file.txt"), "x"); // file, alpha-first

    const res = await svc.list(tmpRoot, { includeFiles: true });
    const names = res.entries.map((e) => e.name);

    // dirs first (git repo before plain dir), then files (case-insensitive
    // alpha: "aaa-file.txt" before "CLAUDE.md").
    expect(names).toEqual(["zzz-repo", "aaa-dir", "aaa-file.txt", "CLAUDE.md"]);

    const md = res.entries.find((e) => e.name === "CLAUDE.md");
    expect(md?.isFile).toBe(true);
    expect(md?.isGitRepo).toBe(false);
    expect(md?.path).toBe(path.join(tmpRoot, "CLAUDE.md"));

    const dir = res.entries.find((e) => e.name === "aaa-dir");
    expect(dir?.isFile).toBe(false);

    // childGitRepos is unaffected by file inclusion.
    expect(res.childGitRepos.map((e) => e.name)).toEqual(["zzz-repo"]);
  });

  it("still excludes .git, deny-listed dirs, and symlinks when including files", async () => {
    await fs.mkdir(path.join(tmpRoot, ".git"));
    await fs.mkdir(path.join(tmpRoot, "node_modules"));
    await fs.mkdir(path.join(tmpRoot, "real"));
    await fs.symlink(path.join(tmpRoot, "real"), path.join(tmpRoot, "link"));
    await fs.writeFile(path.join(tmpRoot, "keep.txt"), "x");
    await fs.symlink(
      path.join(tmpRoot, "keep.txt"),
      path.join(tmpRoot, "link.txt"),
    );

    const res = await svc.list(tmpRoot, { includeFiles: true });
    const names = res.entries.map((e) => e.name);

    expect(names).toContain("real");
    expect(names).toContain("keep.txt");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("link"); // symlinked dir skipped
    expect(names).not.toContain("link.txt"); // symlinked file skipped
  });

  it("rejects an out-of-root path even when including files (still safe)", async () => {
    await expect(
      svc.list("/etc", { includeFiles: true }),
    ).rejects.toBeInstanceOf(FsBrowseError);
    const escape = path.join(tmpRoot, "..", "..", "..");
    await expect(
      svc.list(escape, { includeFiles: true }),
    ).rejects.toBeInstanceOf(FsBrowseError);
  });

  it("flags hidden entries and skips deny-listed dirs and `.git`", async () => {
    await fs.mkdir(path.join(tmpRoot, ".hidden"));
    await fs.mkdir(path.join(tmpRoot, "node_modules"));
    await fs.mkdir(path.join(tmpRoot, ".git"));
    await fs.mkdir(path.join(tmpRoot, "normal"));

    const res = await svc.list(tmpRoot);
    const names = res.entries.map((e) => e.name);

    expect(names).toContain(".hidden");
    expect(names).toContain("normal");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");

    expect(res.entries.find((e) => e.name === ".hidden")?.hidden).toBe(true);
    expect(res.entries.find((e) => e.name === "normal")?.hidden).toBe(false);
  });

  it("does not follow symlinked directories", async () => {
    await fs.mkdir(path.join(tmpRoot, "real"));
    await fs.symlink(path.join(tmpRoot, "real"), path.join(tmpRoot, "link"));

    const res = await svc.list(tmpRoot);
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("real");
    expect(names).not.toContain("link");
  });

  it("reports a parent inside the root when listing a subdirectory", async () => {
    const sub = path.join(tmpRoot, "sub");
    await fs.mkdir(sub);
    const res = await svc.list(sub);
    expect(res.path).toBe(sub);
    expect(res.parent).toBe(tmpRoot);
  });

  /* ── inspect ────────────────────────────────────────────────────────── */

  it("inspects a git repo: name, baseBranch from HEAD, branch list", async () => {
    const repo = path.join(tmpRoot, "my-repo");
    await initRepo(repo);

    const res = await svc.inspect(repo);
    expect(res.isGitRepo).toBe(true);
    expect(res.name).toBe("my-repo");
    expect(res.baseBranch).toBe("main");
    expect(res.branches).toContain("main");
  });

  it("inspects a non-repo parent: 200-shape with childGitRepos populated", async () => {
    const parent = path.join(tmpRoot, "workspace");
    await fs.mkdir(parent);
    await initRepo(path.join(parent, "Backend"));
    await initRepo(path.join(parent, "Frontend"));
    await fs.mkdir(path.join(parent, "notes")); // plain dir → not a child repo

    const res = await svc.inspect(parent);
    expect(res.isGitRepo).toBe(false);
    expect(res.baseBranch).toBeNull();
    expect(res.branches).toEqual([]);
    expect(res.childGitRepos.map((e) => e.name).sort()).toEqual([
      "Backend",
      "Frontend",
    ]);
  });

  it("flags a worktree-style `.git` FILE as a repo", async () => {
    const dir = path.join(tmpRoot, "worktree-like");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, ".git"), "gitdir: /somewhere/else\n");

    const res = await svc.list(tmpRoot);
    expect(res.entries.find((e) => e.name === "worktree-like")?.isGitRepo).toBe(
      true,
    );
  });

  it("requires a path for inspect", async () => {
    await expect(svc.inspect("")).rejects.toBeInstanceOf(FsBrowseError);
  });
});
