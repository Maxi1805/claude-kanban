/**
 * Per-task schema route + inspector tests, over REAL git repositories.
 *
 * Mirrors the production shape: a repo on `main`, a task branch in a real
 * `git worktree`, and an extractor SCRIPT in the board's data dir standing in
 * for one an agent generated. The extractor here just prints a JSON file that
 * lives in the repo, which makes the base-branch comparison meaningful — the
 * inspector has to check out the base commit and run the same script there.
 *
 * Generation is exercised with a FAKE agent command (a stub that prints an
 * extractor), so the whole generate → validate → save → inspect path is covered
 * without invoking a real model.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSchemaRouter } from "./schema.js";
import { SchemaInspectorServiceImpl } from "../services/schema-inspector.js";
import { scriptPathFor } from "../services/schema-script.js";
import type { Repositories } from "../../shared/interfaces.js";
import type {
  ProjectRepo,
  Task,
  TaskRepo,
  TaskSchemaRepo,
  TaskSchemaResponse,
} from "../../shared/types.js";

/** The schema as declared on the base branch. */
const BASE_DECL = {
  dialect: "test",
  entities: [
    {
      name: "users",
      sourceFile: "schema.json",
      sourceLine: 2,
      fields: [
        { name: "id", type: "bigint", nullable: false, primaryKey: true },
        { name: "email", type: "string", nullable: false },
      ],
    },
    {
      name: "posts",
      sourceFile: "schema.json",
      sourceLine: 9,
      fields: [
        { name: "id", type: "bigint", nullable: false, primaryKey: true },
        { name: "user_id", type: "bigint", nullable: false },
      ],
    },
  ],
  relations: [
    {
      from: "posts",
      fromField: "user_id",
      to: "users",
      onDelete: "cascade",
      sourceFile: "schema.json",
      sourceLine: 20,
    },
  ],
};

/** What the task's agent added: a table, a relation and a column. */
const TASK_DECL = {
  ...BASE_DECL,
  entities: [
    ...BASE_DECL.entities.map((e) =>
      e.name === "posts"
        ? {
            ...e,
            fields: [
              ...e.fields,
              { name: "category_id", type: "bigint", nullable: true },
            ],
          }
        : e,
    ),
    {
      name: "categories",
      sourceFile: "schema.json",
      sourceLine: 30,
      fields: [
        { name: "id", type: "bigint", nullable: false, primaryKey: true },
        { name: "name", type: "string", nullable: false },
      ],
    },
  ],
  relations: [
    ...BASE_DECL.relations,
    {
      from: "posts",
      fromField: "category_id",
      to: "categories",
      onDelete: null,
      sourceFile: "schema.json",
      sourceLine: 35,
    },
  ],
};

/** An extractor that prints the repo's declaration file, as a real one would. */
const EXTRACTOR = `#!/usr/bin/env bash
set -euo pipefail
cat schema.json
`;

let tmpDir: string;
let dataDir: string;
let repoDir: string;
let worktreeDir: string;
let server: http.Server | null;
let baseUrl: string;
let agentCommand: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function initRepo(dir: string, declaration: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(declaration, null, 2));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
}

/** Install an extractor for a repo, as a successful generation would have. */
function installScript(projectRepoId: string, body = EXTRACTOR): void {
  const file = scriptPathFor(dataDir, projectRepoId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/** A stub standing in for `claude -p`, printing whatever script we want. */
function fakeAgent(printing: string): string {
  const file = path.join(tmpDir, `agent-${Math.abs(hash(printing))}.sh`);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash\ncat <<'CK_EOF'\n${printing}\nCK_EOF\n`,
    { mode: 0o755 },
  );
  return file;
}

const hash = (s: string): number =>
  [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

function fakeRepos(taskRepos: TaskRepo[], projectRepos: ProjectRepo[]): Repositories {
  const task: Task = {
    id: "task-1",
    projectId: "proj-1",
    title: "Add categories",
    description: null,
    status: "running",
    slug: "add-categories",
    sessionRoot: tmpDir,
    ptyPid: null,
    claudeSessionId: null,
    cavemanEnabled: false,
    cavemanLevel: null,
    cavemanSession: null,
    port: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    repos: taskRepos,
  };
  return {
    tasks: { getById: (id: string) => (id === "task-1" ? task : null) },
    projectRepos: {
      getById: (id: string) => projectRepos.find((r) => r.id === id) ?? null,
    },
    projects: {},
    taskRepos: {},
  } as unknown as Repositories;
}

const projectRepo = (id: string, name: string, repoPath: string): ProjectRepo => ({
  id,
  projectId: "proj-1",
  name,
  repoPath,
  baseBranch: "main",
  setupScript: null,
  runScript: null,
  teardownScript: null,
});

const taskRepo = (
  id: string,
  projectRepoId: string,
  name: string,
  wt: string,
): TaskRepo => ({
  id,
  taskId: "task-1",
  projectRepoId,
  repoName: name,
  branchName: "add-categories",
  worktreePath: wt,
  remotePushed: false,
});

async function startServer(repos: Repositories): Promise<void> {
  const app = express();
  app.use(
    "/api/tasks",
    createSchemaRouter({
      inspector: new SchemaInspectorServiceImpl(repos, { dataDir, agentCommand }),
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const getSchema = async (): Promise<TaskSchemaResponse> =>
  (await (await fetch(`${baseUrl}/api/tasks/task-1/schema`)).json()) as TaskSchemaResponse;

/**
 * Generation is a BACKGROUND job: the POST returns at once and the work lands
 * later, so tests wait for `script.generating` to clear the way the UI does.
 */
async function generateAndWait(repoName: string): Promise<Response> {
  const res = await fetch(
    `${baseUrl}/api/tasks/task-1/schema/${repoName}/generate`,
    { method: "POST" },
  );
  if (!res.ok) return res;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const repo = (await getSchema()).repos.find((r) => r.repoName === repoName);
    if (repo && repo.script.generating !== true) return res;
    if (Date.now() > deadline) throw new Error("la generación no terminó");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-schema-"));
  dataDir = path.join(tmpDir, "data");
  repoDir = path.join(tmpDir, "backend");
  worktreeDir = path.join(tmpDir, "wt-backend");
  agentCommand = fakeAgent(EXTRACTOR);

  initRepo(repoDir, BASE_DECL);
  git(repoDir, "worktree", "add", "-q", "-b", "add-categories", worktreeDir, "main");
  fs.writeFileSync(
    path.join(worktreeDir, "schema.json"),
    JSON.stringify(TASK_DECL, null, 2),
  );
  git(worktreeDir, "add", "-A");
  git(worktreeDir, "commit", "-qm", "add categories");
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/tasks/:taskId/schema", () => {
  it("reports a repo with no extractor yet, without failing", async () => {
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    const body = await getSchema();
    expect(body.repos[0].script.exists).toBe(false);
    expect(body.repos[0].graph).toBeNull();
    expect(body.repos[0].error).toBeUndefined();
  });

  it("runs the extractor and diffs it against the base branch", async () => {
    installScript("pr-1");
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    const repo = (await getSchema()).repos[0];
    expect(repo.script.exists).toBe(true);
    expect(repo.error).toBeUndefined();

    const graph = repo.graph!;
    expect(graph.dialect).toBe("test");
    expect(graph.entities.map((e) => e.name)).toEqual([
      "categories",
      "posts",
      "users",
    ]);
    // Direction is preserved: the child holds the key.
    expect(graph.relations.map((r) => `${r.from}.${r.fromField}->${r.to}`)).toEqual([
      "posts.category_id->categories",
      "posts.user_id->users",
    ]);

    // The base branch is checked out and run through the SAME script.
    const diff = repo.diff!;
    expect(diff.baseBranch).toBe("main");
    expect(diff.entities).toEqual({ categories: "added", posts: "changed" });
    expect(diff.fields["posts.category_id"]).toBe("added");
    expect(diff.relations).toEqual({ "posts.category_id->categories": "added" });
    expect(diff.entities.users).toBeUndefined();
  });

  it("surfaces a broken extractor as a per-repo error, not a failed request", async () => {
    installScript("pr-1", "#!/usr/bin/env bash\necho 'not json at all'\n");
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    const res = await fetch(`${baseUrl}/api/tasks/task-1/schema`);
    expect(res.status).toBe(200);
    const repo = ((await res.json()) as TaskSchemaResponse).repos[0];
    expect(repo.graph).toBeNull();
    expect(repo.error).toMatch(/JSON/i);
  });

  it("keeps the graph when the base branch cannot be read", async () => {
    installScript("pr-1");
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [{ ...projectRepo("pr-1", "backend", repoDir), baseBranch: "no-such-branch" }],
      ),
    );

    const repo = (await getSchema()).repos[0];
    expect(repo.graph).not.toBeNull();
    expect(repo.diff?.baseBranch).toBeNull();
    expect(repo.diff?.unavailableReason).toBeTruthy();
  });

  it("covers every repo of a multi-repo task independently", async () => {
    const otherRepo = path.join(tmpDir, "frontend");
    const otherWt = path.join(tmpDir, "wt-frontend");
    initRepo(otherRepo, BASE_DECL);
    git(otherRepo, "worktree", "add", "-q", "-b", "t", otherWt, "main");
    installScript("pr-1"); // only the backend has an extractor

    await startServer(
      fakeRepos(
        [
          taskRepo("tr-1", "pr-1", "backend", worktreeDir),
          taskRepo("tr-2", "pr-2", "frontend", otherWt),
        ],
        [
          projectRepo("pr-1", "backend", repoDir),
          projectRepo("pr-2", "frontend", otherRepo),
        ],
      ),
    );

    const body = await getSchema();
    expect(body.repos.map((r) => r.repoName)).toEqual(["backend", "frontend"]);
    expect(body.repos[0].graph).not.toBeNull();
    expect(body.repos[1].script.exists).toBe(false);
    expect(body.repos[1].graph).toBeNull();
  });

  it("answers 404 for an unknown task", async () => {
    await startServer(fakeRepos([], []));
    expect((await fetch(`${baseUrl}/api/tasks/nope/schema`)).status).toBe(404);
  });
});

describe("POST /api/tasks/:taskId/schema/:repoName/generate", () => {
  it("saves what the agent wrote and returns the inspected repo", async () => {
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    expect((await generateAndWait("backend")).status).toBe(200);

    const repo = (await getSchema()).repos[0];
    expect(repo.script.exists).toBe(true);
    expect(repo.script.summary).toContain("3 tablas");
    expect(repo.script.lastError).toBeUndefined();
    expect(repo.graph?.entities).toHaveLength(3);
    // It landed on disk, so later requests reuse it.
    expect(fs.existsSync(scriptPathFor(dataDir, "pr-1"))).toBe(true);
  });

  it("unwraps a script the agent fenced in markdown", async () => {
    agentCommand = fakeAgent("```bash\n" + EXTRACTOR + "```");
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    expect((await generateAndWait("backend")).status).toBe(200);
    expect(fs.readFileSync(scriptPathFor(dataDir, "pr-1"), "utf8")).not.toContain("```");
  });

  it("reports a rejected script and keeps the previous one", async () => {
    installScript("pr-1"); // a working extractor is already in place
    agentCommand = fakeAgent("#!/usr/bin/env bash\necho 'junk'\n");
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    await generateAndWait("backend");

    const repo = (await getSchema()).repos[0];
    // The failure is reported on the script state, not as a broken diagram...
    expect(repo.script.lastError).toBeTruthy();
    // ...and the previous, working extractor survived it.
    expect(fs.readFileSync(scriptPathFor(dataDir, "pr-1"), "utf8")).toBe(EXTRACTOR);
    expect(repo.graph?.entities).toHaveLength(3);
  });

  it("answers 404 for a repo the task does not have", async () => {
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );
    const res = await fetch(`${baseUrl}/api/tasks/task-1/schema/nope/generate`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/tasks/:taskId/schema/:repoName", () => {
  it("removes the extractor so the diagram asks for a new one", async () => {
    installScript("pr-1");
    await startServer(
      fakeRepos(
        [taskRepo("tr-1", "pr-1", "backend", worktreeDir)],
        [projectRepo("pr-1", "backend", repoDir)],
      ),
    );

    expect((await getSchema()).repos[0].script.exists).toBe(true);
    const res = await fetch(`${baseUrl}/api/tasks/task-1/schema/backend`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect((await getSchema()).repos[0].script.exists).toBe(false);
  });
});
