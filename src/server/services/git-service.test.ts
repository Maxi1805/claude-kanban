/**
 * Integration tests for GitServiceImpl.
 *
 * Each test creates throwaway git repos under os.tmpdir() (real `git init` +
 * initial commit) so worktree/branch operations exercise the actual git
 * plumbing, then cleans everything up afterwards.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateTaskWorktreesOptions,
  WorktreeRepoSpec,
} from "../../shared/interfaces.js";
import type { TaskRepo } from "../../shared/types.js";
import { GitServiceImpl, parsePorcelainWorktrees } from "./git-service.js";

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

/** True if a local branch exists in the repo. */
async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
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

describe("GitServiceImpl", () => {
  let tmpRoot: string;
  let baseDir: string;
  let svc: GitServiceImpl;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ck-git-test-"));
    baseDir = path.join(tmpRoot, "sessions");
    svc = new GitServiceImpl(baseDir);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** Build a WorktreeRepoSpec from an initialized repo dir. */
  function spec(repoDir: string, name: string): WorktreeRepoSpec {
    return {
      projectRepoId: `pr-${name}`,
      repoName: name,
      repoPath: repoDir,
      baseBranch: "main",
    };
  }

  it("creates worktrees and branches across multiple repos", async () => {
    const repoA = path.join(tmpRoot, "repoA");
    const repoB = path.join(tmpRoot, "repoB");
    await initRepo(repoA);
    await initRepo(repoB);

    const opts: CreateTaskWorktreesOptions = {
      taskId: "task-1",
      projectName: "proj",
      slug: "abc1-add-feature",
      repos: [spec(repoA, "RepoA"), spec(repoB, "RepoB")],
      baseDir,
    };

    const result = await svc.createTaskWorktrees(opts);

    expect(result.sessionRoot).toBe(
      path.join(baseDir, "proj", "abc1-add-feature"),
    );
    expect(result.taskRepos).toHaveLength(2);

    for (const tr of result.taskRepos) {
      // Worktree directory exists with the repo content checked out.
      expect(await exists(tr.worktreePath)).toBe(true);
      expect(await exists(path.join(tr.worktreePath, "README.md"))).toBe(true);
      expect(tr.branchName).toBe("abc1-add-feature");
      expect(tr.remotePushed).toBe(false);
    }

    // Branch created in each source repo.
    expect(await branchExists(repoA, "abc1-add-feature")).toBe(true);
    expect(await branchExists(repoB, "abc1-add-feature")).toBe(true);

    // git sees the linked worktrees.
    const wts = await svc.listWorktrees(repoA);
    expect(wts.length).toBe(2); // main + the new linked worktree
    expect(wts.some((w) => w.branch === "abc1-add-feature")).toBe(true);
    expect(wts[0].isMain).toBe(true);
  });

  it("appends a suffix when the branch name already exists", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);
    // Pre-create the branch that the slug would otherwise claim.
    await git(repo, "branch", "dup-slug");

    const result = await svc.createTaskWorktrees({
      taskId: "task-2",
      projectName: "proj",
      slug: "dup-slug",
      repos: [spec(repo, "Repo")],
      baseDir,
    });

    const tr = result.taskRepos[0];
    expect(tr.branchName).not.toBe("dup-slug");
    expect(tr.branchName.startsWith("dup-slug-")).toBe(true);
    expect(await branchExists(repo, tr.branchName)).toBe(true);
  });

  it("rolls back already-created worktrees when a later repo fails", async () => {
    const good = path.join(tmpRoot, "good");
    await initRepo(good);
    // A path that is not a git repo -> `git worktree add` fails there.
    const bad = path.join(tmpRoot, "not-a-repo");
    await fs.mkdir(bad, { recursive: true });

    await expect(
      svc.createTaskWorktrees({
        taskId: "task-3",
        projectName: "proj",
        slug: "rollme",
        repos: [spec(good, "Good"), spec(bad, "Bad")],
        baseDir,
      }),
    ).rejects.toBeTruthy();

    // The good repo's worktree + branch must have been rolled back.
    expect(await branchExists(good, "rollme")).toBe(false);
    const wts = await svc.listWorktrees(good);
    expect(wts.some((w) => w.branch === "rollme")).toBe(false);
  });

  it("removes worktrees and prunes them", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    const result = await svc.createTaskWorktrees({
      taskId: "task-4",
      projectName: "proj",
      slug: "remove-me",
      repos: [spec(repo, "Repo")],
      baseDir,
    });

    const tr = result.taskRepos[0];
    expect(await exists(tr.worktreePath)).toBe(true);

    await svc.removeTaskWorktrees(result.taskRepos);

    expect(await exists(tr.worktreePath)).toBe(false);
    const wts = await svc.listWorktrees(repo);
    // Only the main worktree should remain.
    expect(wts).toHaveLength(1);
    expect(wts[0].isMain).toBe(true);
  });

  it("removes a worktree even with heavy untracked dirs present", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    const result = await svc.createTaskWorktrees({
      taskId: "task-5",
      projectName: "proj",
      slug: "heavy",
      repos: [spec(repo, "Repo")],
      baseDir,
    });
    const tr = result.taskRepos[0];

    // Simulate a bulky untracked dir inside the worktree.
    const nm = path.join(tr.worktreePath, "node_modules", "pkg");
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, "index.js"), "module.exports={}\n");

    await svc.removeTaskWorktrees(result.taskRepos);
    expect(await exists(tr.worktreePath)).toBe(false);
  });

  it("refuses to remove a BUSY (locked) worktree and leaves it intact", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    const result = await svc.createTaskWorktrees({
      taskId: "task-busy-remove",
      projectName: "proj",
      slug: "busy-remove",
      repos: [spec(repo, "Repo")],
      baseDir,
    });
    const tr = result.taskRepos[0];

    // Lock the worktree so the chokepoint's busy re-check trips.
    await git(repo, "worktree", "lock", tr.worktreePath);

    // The destructive chokepoint must THROW rather than force-remove a busy tree.
    await expect(svc.removeTaskWorktrees(result.taskRepos)).rejects.toMatchObject(
      { name: "WorktreeBusyError" },
    );

    // The worktree directory must still be on disk (NOT force-removed).
    expect(await exists(tr.worktreePath)).toBe(true);

    // Unlock so afterEach cleanup can remove it.
    await git(repo, "worktree", "unlock", tr.worktreePath);
  });

  it("does NOT run the repo setup script during worktree creation (setup is now a manual command)", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    const marker = "SETUP_RAN.txt";
    // A setup script that, IF it ran, would write a marker AND fail (exit 3).
    // Auto-setup is removed, so neither effect should happen: the worktree is
    // created successfully and no marker exists.
    const setupSpec: WorktreeRepoSpec = {
      ...spec(repo, "Repo"),
      setupScript: `printf ran > ${marker}; exit 3`,
    };

    const result = await svc.createTaskWorktrees({
      taskId: "task-no-setup",
      projectName: "proj",
      slug: "no-setup",
      repos: [setupSpec],
      baseDir,
    });

    const tr = result.taskRepos[0];
    // The worktree was created (creation no longer depends on the setup script),
    // and the script never ran — so its marker is absent.
    expect(await exists(tr.worktreePath)).toBe(true);
    expect(await exists(path.join(tr.worktreePath, marker))).toBe(false);
    expect(await branchExists(repo, tr.branchName)).toBe(true);
  });

  it("copies configured untracked files (incl. a glob) into the worktree", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    // Untracked files/dirs that exist ONLY in the source repo working dir (never
    // committed, so a plain worktree checkout would not carry them over).
    await fs.writeFile(path.join(repo, ".env"), "SECRET=1\n");
    await fs.writeFile(path.join(repo, ".env.local"), "LOCAL=2\n");
    await fs.mkdir(path.join(repo, "secrets"), { recursive: true });
    await fs.writeFile(path.join(repo, "secrets", "key.pem"), "PEM\n");

    const result = await svc.createTaskWorktrees({
      taskId: "task-copy",
      projectName: "proj",
      slug: "copy-me",
      repos: [spec(repo, "Repo")],
      baseDir,
      // A literal file, a directory, and a trailing-segment glob.
      copyFiles: [".env", "secrets", ".env.*"],
    });
    const wt = result.taskRepos[0].worktreePath;

    // Literal file copied (a real copy, not a symlink).
    expect(await exists(path.join(wt, ".env"))).toBe(true);
    const envStat = await fs.lstat(path.join(wt, ".env"));
    expect(envStat.isSymbolicLink()).toBe(false);
    expect((await fs.readFile(path.join(wt, ".env"), "utf8")).trim()).toBe(
      "SECRET=1",
    );
    // Directory copied recursively.
    expect(await exists(path.join(wt, "secrets", "key.pem"))).toBe(true);
    // Glob expanded against the parent dir (`.env.*` → `.env.local`).
    expect(await exists(path.join(wt, ".env.local"))).toBe(true);
  });

  it("skips missing and unsafe copyFiles patterns without failing creation", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    // A file OUTSIDE the repo that an unsafe `..` pattern would try to reach.
    const outside = path.join(tmpRoot, "outside-secret.txt");
    await fs.writeFile(outside, "DO NOT COPY\n");
    await fs.writeFile(path.join(repo, "present.txt"), "ok\n");

    const result = await svc.createTaskWorktrees({
      taskId: "task-copy-safe",
      projectName: "proj",
      slug: "copy-safe",
      repos: [spec(repo, "Repo")],
      baseDir,
      copyFiles: [
        "present.txt", // exists → copied
        "does-not-exist.txt", // missing → skipped, no throw
        "../outside-secret.txt", // unsafe traversal → ignored
        "/etc/hostname", // absolute → ignored
      ],
    });
    const wt = result.taskRepos[0].worktreePath;

    // The valid pattern was copied.
    expect(await exists(path.join(wt, "present.txt"))).toBe(true);
    // The unsafe traversal did NOT land anywhere in the worktree.
    expect(await exists(path.join(wt, "outside-secret.txt"))).toBe(false);
    // The original outside-the-repo file is untouched (never read/copied).
    expect(await exists(outside)).toBe(true);
    // The worktree itself was created fine despite the bad patterns.
    expect(await exists(path.join(wt, "README.md"))).toBe(true);
  });

  it("does NOT exfiltrate outside content via a file-symlink or dir-symlink matching a safe copyFiles pattern", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    // A sibling directory OUTSIDE the repo holding a secret. The repo contains
    // symlinks (whose NAMES are perfectly safe relative patterns) that point at
    // it — the lexical pattern/path checks all pass; only a realpath check stops
    // the escape.
    const outsideDir = path.join(tmpRoot, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "TOP_SECRET\n");
    const outsideFile = path.join(tmpRoot, "outside-file.txt");
    await fs.writeFile(outsideFile, "ALSO_SECRET\n");

    // dir-symlink: <repo>/evil -> ../outside  (relative escape)
    await fs.symlink(
      path.relative(repo, outsideDir),
      path.join(repo, "evil"),
    );
    // file-symlink: <repo>/leak.txt -> /abs/.../outside-file.txt (absolute escape)
    await fs.symlink(outsideFile, path.join(repo, "leak.txt"));

    const result = await svc.createTaskWorktrees({
      taskId: "task-symlink-escape",
      projectName: "proj",
      slug: "symlink-escape",
      repos: [spec(repo, "Repo")],
      baseDir,
      // Both names are SAFE relative patterns (no `..`, not absolute) — the only
      // thing standing between them and the outside data is the realpath guard.
      copyFiles: ["evil", "leak.txt"],
    });
    const wt = result.taskRepos[0].worktreePath;

    // The dir-symlink must NOT have been chased: no outside content lands as a
    // real file in the worktree.
    expect(await exists(path.join(wt, "evil", "secret.txt"))).toBe(false);
    // The file-symlink must NOT have copied the outside file's content in.
    expect(await exists(path.join(wt, "leak.txt"))).toBe(false);

    // Whatever (if anything) exists at those names must not expose outside data:
    // assert no readable file at the escaping name yields the secret.
    for (const name of ["evil/secret.txt", "leak.txt"]) {
      const p = path.join(wt, name);
      let content: string | null = null;
      try {
        content = await fs.readFile(p, "utf8");
      } catch {
        content = null; // missing or dangling symlink → unreadable → good
      }
      if (content !== null) {
        expect(content).not.toContain("SECRET");
      }
    }

    // The originals outside the repo are untouched.
    expect(await exists(path.join(outsideDir, "secret.txt"))).toBe(true);
    expect(await exists(outsideFile)).toBe(true);
    // The worktree itself was still created fine.
    expect(await exists(path.join(wt, "README.md"))).toBe(true);
  });

  it("allows an IN-REPO symlinked file through copyFiles (real path stays in repo)", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);

    // A real in-repo target and an in-repo symlink pointing at it (its REAL path
    // stays inside the repo → the realpath guard must let it through, unlike an
    // escaping symlink which is rejected).
    await fs.writeFile(path.join(repo, "real.env"), "OK=1\n");
    await fs.symlink("real.env", path.join(repo, "link.env"));

    const result = await svc.createTaskWorktrees({
      taskId: "task-symlink-inrepo",
      projectName: "proj",
      slug: "symlink-inrepo",
      repos: [spec(repo, "Repo")],
      baseDir,
      copyFiles: ["link.env"],
    });
    const wt = result.taskRepos[0].worktreePath;

    // The in-repo symlink was NOT rejected: an entry exists at the dest name.
    // (It is preserved verbatim as a symlink; its target is not chased outside.)
    const lst = await fs.lstat(path.join(wt, "link.env"));
    expect(lst.isSymbolicLink() || lst.isFile()).toBe(true);
  });

  it("deletes a local branch", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);
    await git(repo, "branch", "feature-x");
    expect(await branchExists(repo, "feature-x")).toBe(true);

    await svc.deleteLocalBranch(repo, "feature-x");
    expect(await branchExists(repo, "feature-x")).toBe(false);
  });

  it("tolerates deleting a remote branch with no remote configured", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);
    // No `origin` remote -> must resolve without throwing.
    await expect(
      svc.deleteRemoteBranch(repo, "whatever"),
    ).resolves.toBeUndefined();
  });

  it("lists worktrees with main + linked entries", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);
    await svc.createTaskWorktrees({
      taskId: "task-6",
      projectName: "proj",
      slug: "listme",
      repos: [spec(repo, "Repo")],
      baseDir,
    });

    const wts = await svc.listWorktrees(repo);
    expect(wts).toHaveLength(2);
    expect(wts[0].isMain).toBe(true);
    expect(wts[1].isMain).toBe(false);
    expect(wts[1].branch).toBe("listme");
    expect(wts[1].head).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("assembleSessionRoot symlinks the explicit CLAUDE.md FILE and .claude DIR", async () => {
    const sessionRoot = path.join(tmpRoot, "session");
    // Two INDEPENDENT sources: a standalone CLAUDE.md file and a separate
    // .claude dir, deliberately under different parents to prove they are linked
    // individually (not derived from one shared folder).
    const mdSrc = path.join(tmpRoot, "md-src", "CLAUDE.md");
    const dirSrc = path.join(tmpRoot, "dir-src", "dot-claude");
    await fs.mkdir(path.dirname(mdSrc), { recursive: true });
    await fs.writeFile(mdSrc, "# orchestrator\n");
    await fs.mkdir(dirSrc, { recursive: true });
    await fs.writeFile(path.join(dirSrc, "settings.json"), "{}\n");

    await svc.assembleSessionRoot({
      sessionRoot,
      claudeMdPath: mdSrc,
      claudeDirPath: dirSrc,
    });

    // <sessionRoot>/CLAUDE.md resolves to the explicit file.
    expect(await exists(path.join(sessionRoot, "CLAUDE.md"))).toBe(true);
    expect(
      (await fs.readFile(path.join(sessionRoot, "CLAUDE.md"), "utf8")).trim(),
    ).toBe("# orchestrator");
    // <sessionRoot>/.claude resolves to the explicit directory's contents.
    expect(
      await exists(path.join(sessionRoot, ".claude", "settings.json")),
    ).toBe(true);

    // Idempotent: a second call must not throw.
    await expect(
      svc.assembleSessionRoot({
        sessionRoot,
        claudeMdPath: mdSrc,
        claudeDirPath: dirSrc,
      }),
    ).resolves.toBeUndefined();
  });

  it("assembleSessionRoot symlinks the explicit .mcp.json FILE → .mcp.json", async () => {
    const sessionRoot = path.join(tmpRoot, "session-mcp");
    // An .mcp.json under its OWN parent, independent of CLAUDE.md / .claude.
    const mcpSrc = path.join(tmpRoot, "mcp-src", ".mcp.json");
    await fs.mkdir(path.dirname(mcpSrc), { recursive: true });
    await fs.writeFile(mcpSrc, '{"mcpServers":{}}\n');

    await svc.assembleSessionRoot({
      sessionRoot,
      claudeMdPath: null,
      claudeDirPath: null,
      mcpConfigPath: mcpSrc,
    });

    // <sessionRoot>/.mcp.json resolves to the explicit file's contents.
    expect(await exists(path.join(sessionRoot, ".mcp.json"))).toBe(true);
    expect(
      (await fs.readFile(path.join(sessionRoot, ".mcp.json"), "utf8")).trim(),
    ).toBe('{"mcpServers":{}}');
    // No CLAUDE.md / .claude were requested → none created.
    expect(await exists(path.join(sessionRoot, "CLAUDE.md"))).toBe(false);
    expect(await exists(path.join(sessionRoot, ".claude"))).toBe(false);

    // Idempotent: a second call must not throw.
    await expect(
      svc.assembleSessionRoot({
        sessionRoot,
        claudeMdPath: null,
        claudeDirPath: null,
        mcpConfigPath: mcpSrc,
      }),
    ).resolves.toBeUndefined();
  });

  it("assembleSessionRoot skips a missing .mcp.json source", async () => {
    const sessionRoot = path.join(tmpRoot, "session-mcp-missing");
    await svc.assembleSessionRoot({
      sessionRoot,
      mcpConfigPath: path.join(tmpRoot, "nope", ".mcp.json"),
    });
    expect(await exists(sessionRoot)).toBe(true);
    expect(await exists(path.join(sessionRoot, ".mcp.json"))).toBe(false);
  });

  it("assembleSessionRoot links ONLY the source that is set (file without dir)", async () => {
    const sessionRoot = path.join(tmpRoot, "session-md-only");
    const mdSrc = path.join(tmpRoot, "only-md", "CLAUDE.md");
    await fs.mkdir(path.dirname(mdSrc), { recursive: true });
    await fs.writeFile(mdSrc, "# md only\n");

    await svc.assembleSessionRoot({
      sessionRoot,
      claudeMdPath: mdSrc,
      claudeDirPath: null,
    });

    expect(await exists(path.join(sessionRoot, "CLAUDE.md"))).toBe(true);
    // No .claude was requested → none created.
    expect(await exists(path.join(sessionRoot, ".claude"))).toBe(false);
  });

  it("assembleSessionRoot links ONLY the source that is set (dir without file)", async () => {
    const sessionRoot = path.join(tmpRoot, "session-dir-only");
    const dirSrc = path.join(tmpRoot, "only-dir", ".claude");
    await fs.mkdir(dirSrc, { recursive: true });
    await fs.writeFile(path.join(dirSrc, "settings.json"), "{}\n");

    await svc.assembleSessionRoot({
      sessionRoot,
      claudeMdPath: null,
      claudeDirPath: dirSrc,
    });

    expect(await exists(path.join(sessionRoot, ".claude", "settings.json"))).toBe(
      true,
    );
    // No CLAUDE.md was requested → none created.
    expect(await exists(path.join(sessionRoot, "CLAUDE.md"))).toBe(false);
  });

  it("assembleSessionRoot skips a source path that does not exist", async () => {
    const sessionRoot = path.join(tmpRoot, "session-missing-src");
    await svc.assembleSessionRoot({
      sessionRoot,
      claudeMdPath: path.join(tmpRoot, "nope", "CLAUDE.md"),
      claudeDirPath: path.join(tmpRoot, "nope", ".claude"),
    });
    expect(await exists(sessionRoot)).toBe(true);
    expect(await exists(path.join(sessionRoot, "CLAUDE.md"))).toBe(false);
    expect(await exists(path.join(sessionRoot, ".claude"))).toBe(false);
  });

  it("assembleSessionRoot is a no-op for symlinks when neither source is set", async () => {
    const sessionRoot = path.join(tmpRoot, "session-bare");
    await svc.assembleSessionRoot({
      sessionRoot,
      claudeMdPath: null,
      claudeDirPath: null,
    });
    expect(await exists(sessionRoot)).toBe(true);
    expect(await exists(path.join(sessionRoot, "CLAUDE.md"))).toBe(false);
    expect(await exists(path.join(sessionRoot, ".claude"))).toBe(false);
  });

  it("isWorktreeBusy reports false for an idle worktree", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);
    const result = await svc.createTaskWorktrees({
      taskId: "task-7",
      projectName: "proj",
      slug: "idle",
      repos: [spec(repo, "Repo")],
      baseDir,
    });
    const busy = await svc.isWorktreeBusy(result.taskRepos[0].worktreePath);
    expect(busy).toBe(false);
  });

  it("isWorktreeBusy reports true when the worktree is locked", async () => {
    const repo = path.join(tmpRoot, "repo");
    await initRepo(repo);
    const result = await svc.createTaskWorktrees({
      taskId: "task-8",
      projectName: "proj",
      slug: "locked",
      repos: [spec(repo, "Repo")],
      baseDir,
    });
    const wtPath = result.taskRepos[0].worktreePath;
    await git(repo, "worktree", "lock", wtPath);

    expect(await svc.isWorktreeBusy(wtPath)).toBe(true);

    // Unlock so cleanup can remove it.
    await git(repo, "worktree", "unlock", wtPath);
  });
});

describe("parsePorcelainWorktrees", () => {
  it("parses main + linked + locked entries", () => {
    const out = [
      "worktree /repos/main",
      "HEAD abc1234abc1234abc1234abc1234abc1234abc1",
      "branch refs/heads/main",
      "",
      "worktree /sessions/proj/slug/Repo",
      "HEAD def5678def5678def5678def5678def5678def5",
      "branch refs/heads/feature-slug",
      "locked",
      "",
    ].join("\n");

    const parsed = parsePorcelainWorktrees(out);
    expect(parsed).toHaveLength(2);

    expect(parsed[0]).toEqual({
      path: "/repos/main",
      head: "abc1234abc1234abc1234abc1234abc1234abc1",
      branch: "main",
      isMain: true,
      locked: false,
    });

    expect(parsed[1]).toEqual({
      path: "/sessions/proj/slug/Repo",
      head: "def5678def5678def5678def5678def5678def5",
      branch: "feature-slug",
      isMain: false,
      locked: true,
    });
  });

  it("handles a detached HEAD worktree (no branch line)", () => {
    const out = [
      "worktree /repos/main",
      "HEAD abc1234abc1234abc1234abc1234abc1234abc1",
      "detached",
      "",
    ].join("\n");

    const parsed = parsePorcelainWorktrees(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].branch).toBeNull();
    expect(parsed[0].isMain).toBe(true);
  });
});

/** Type-level assertion: a TaskRepo from create matches the shared shape. */
function _typecheck(tr: TaskRepo): string {
  return tr.worktreePath;
}
void _typecheck;
