/**
 * Projects router tests — focused on validation + forwarding of the two new
 * per-project Claude source selectors (claudeMdPath / claudeDirPath).
 *
 * The router is mounted on a real Express app (with json() body parsing) over a
 * real in-memory sqlite (schema + migration applied by initDb), and requests are
 * fired through node's fetch so the full POST/PATCH/GET path round-trips through
 * the real validators and the real `claude_md_path` / `claude_dir_path` columns.
 *
 * Validation contract under test:
 *   • claudeMdPath  — when set, must be an existing FILE (else 400).
 *   • claudeDirPath — when set, must be an existing DIRECTORY (else 400).
 *   • absent / null / empty string → unset (null), never an error.
 *   • GET returns both fields.
 */
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import express, { json } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, type DB } from "../db/index.js";
import { createRepositories } from "../db/repositories.js";
import { createProjectsRouter } from "./projects.js";
import type { Repositories, TaskLifecycle } from "../../shared/interfaces.js";
import type { Project } from "../../shared/types.js";

let db: DB;
let repos: Repositories;
let server: http.Server;
let baseUrl: string;
let tmpRoot: string;
/** An existing FILE and an existing DIRECTORY to point the selectors at. */
let fileSrc: string;
let dirSrc: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ck-projects-api-"));
  fileSrc = path.join(tmpRoot, "CLAUDE.md");
  dirSrc = path.join(tmpRoot, "dot-claude");
  await fsp.writeFile(fileSrc, "# md\n");
  await fsp.mkdir(dirSrc, { recursive: true });

  db = initDb(":memory:");
  repos = createRepositories(db);

  const app = express();
  app.use(json());
  app.use("/api/projects", createProjectsRouter({ repos }));

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/** POST a JSON body to /api/projects, returning { status, body }. */
async function post(
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** PATCH a JSON body to /api/projects/:id, returning { status, body }. */
async function patch(
  id: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** GET /api/projects/:id, returning the Project body. */
async function get(id: string): Promise<Project> {
  const res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
  return (await res.json()) as Project;
}

/** PATCH /api/projects/:projectId/repos/:repoId, returning { status, body }. */
async function patchRepo(
  projectId: string,
  repoId: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

describe("POST /api/projects — claudeMdPath / claudeDirPath validation", () => {
  it("accepts + persists an existing FILE and an existing DIRECTORY", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      claudeMdPath: fileSrc,
      claudeDirPath: dirSrc,
    });
    expect(status).toBe(201);
    expect(body.claudeMdPath).toBe(path.resolve(fileSrc));
    expect(body.claudeDirPath).toBe(path.resolve(dirSrc));

    // GET returns them too.
    const fetched = await get(body.id as string);
    expect(fetched.claudeMdPath).toBe(path.resolve(fileSrc));
    expect(fetched.claudeDirPath).toBe(path.resolve(dirSrc));
  });

  it("treats absent / null / empty claudeMdPath+claudeDirPath as unset (null)", async () => {
    const { status, body } = await post({
      name: "bare",
      repos: [],
      claudeMdPath: "",
      claudeDirPath: null,
    });
    expect(status).toBe(201);
    expect(body.claudeMdPath).toBeNull();
    expect(body.claudeDirPath).toBeNull();
  });

  it("rejects a claudeMdPath that points at a DIRECTORY (must be a file)", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      claudeMdPath: dirSrc, // a dir, not a file
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/claudeMdPath.*must be a file/);
  });

  it("rejects a claudeDirPath that points at a FILE (must be a directory)", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      claudeDirPath: fileSrc, // a file, not a dir
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/claudeDirPath.*must be a directory/);
  });

  it("rejects a claudeMdPath that does not exist", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      claudeMdPath: path.join(tmpRoot, "missing", "CLAUDE.md"),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/claudeMdPath.*does not exist/);
  });

  it("rejects a non-string claudeMdPath", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      claudeMdPath: 42,
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/claudeMdPath.*must be a string or null/);
  });
});

describe("PATCH /api/projects/:id — claudeMdPath / claudeDirPath", () => {
  async function makeProject(): Promise<string> {
    const { body } = await post({ name: "p", repos: [] });
    return body.id as string;
  }

  it("sets the two selectors independently and GET reflects them", async () => {
    const id = await makeProject();

    const setMd = await patch(id, { claudeMdPath: fileSrc });
    expect(setMd.status).toBe(200);
    expect(setMd.body.claudeMdPath).toBe(path.resolve(fileSrc));
    expect(setMd.body.claudeDirPath).toBeNull();

    const setDir = await patch(id, { claudeDirPath: dirSrc });
    expect(setDir.status).toBe(200);
    expect(setDir.body.claudeMdPath).toBe(path.resolve(fileSrc));
    expect(setDir.body.claudeDirPath).toBe(path.resolve(dirSrc));

    const fetched = await get(id);
    expect(fetched.claudeMdPath).toBe(path.resolve(fileSrc));
    expect(fetched.claudeDirPath).toBe(path.resolve(dirSrc));
  });

  it("clears a selector via empty string and leaves the other intact", async () => {
    const id = await makeProject();
    await patch(id, { claudeMdPath: fileSrc, claudeDirPath: dirSrc });

    const cleared = await patch(id, { claudeMdPath: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.claudeMdPath).toBeNull();
    expect(cleared.body.claudeDirPath).toBe(path.resolve(dirSrc));
  });

  it("400s on a wrong-kind claudeMdPath (a directory) and does not mutate", async () => {
    const id = await makeProject();
    await patch(id, { claudeMdPath: fileSrc });

    const bad = await patch(id, { claudeMdPath: dirSrc });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/claudeMdPath.*must be a file/);

    // The earlier valid value is preserved (the failed PATCH never ran).
    const fetched = await get(id);
    expect(fetched.claudeMdPath).toBe(path.resolve(fileSrc));
  });

  it("400s on a wrong-kind claudeDirPath (a file)", async () => {
    const id = await makeProject();
    const bad = await patch(id, { claudeDirPath: fileSrc });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/claudeDirPath.*must be a directory/);
  });
});

describe("POST /api/projects — mcpConfigPath / copyFiles validation", () => {
  it("accepts + persists an existing FILE as mcpConfigPath and a copyFiles array", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      mcpConfigPath: fileSrc,
      copyFiles: ["  .env  ", "secrets", "", "   "],
    });
    expect(status).toBe(201);
    expect(body.mcpConfigPath).toBe(path.resolve(fileSrc));
    // Entries trimmed; empties dropped.
    expect(body.copyFiles).toEqual([".env", "secrets"]);

    const fetched = await get(body.id as string);
    expect(fetched.mcpConfigPath).toBe(path.resolve(fileSrc));
    expect(fetched.copyFiles).toEqual([".env", "secrets"]);
  });

  it("treats absent / null / empty mcpConfigPath + copyFiles as unset", async () => {
    const { status, body } = await post({
      name: "bare",
      repos: [],
      mcpConfigPath: "",
      copyFiles: null,
    });
    expect(status).toBe(201);
    expect(body.mcpConfigPath).toBeNull();
    expect(body.copyFiles).toEqual([]);
  });

  it("rejects an mcpConfigPath that points at a DIRECTORY (must be a file)", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      mcpConfigPath: dirSrc, // a dir, not a file
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/mcpConfigPath.*must be a file/);
  });

  it("rejects an mcpConfigPath that does not exist", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      mcpConfigPath: path.join(tmpRoot, "missing", ".mcp.json"),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/mcpConfigPath.*does not exist/);
  });

  it("rejects a copyFiles that is not an array", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      copyFiles: ".env",
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/copyFiles.*must be an array/);
  });

  it("rejects a copyFiles array with a non-string entry", async () => {
    const { status, body } = await post({
      name: "p",
      repos: [],
      copyFiles: [".env", 42],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/copyFiles.*entries must be strings/);
  });
});

describe("PATCH /api/projects/:id — mcpConfigPath / copyFiles", () => {
  async function makeProject(): Promise<string> {
    const { body } = await post({ name: "p", repos: [] });
    return body.id as string;
  }

  it("sets mcpConfigPath + copyFiles and GET reflects them", async () => {
    const id = await makeProject();

    const setMcp = await patch(id, { mcpConfigPath: fileSrc });
    expect(setMcp.status).toBe(200);
    expect(setMcp.body.mcpConfigPath).toBe(path.resolve(fileSrc));
    expect(setMcp.body.copyFiles).toEqual([]);

    const setCopy = await patch(id, { copyFiles: [".env", "config/local.yml"] });
    expect(setCopy.status).toBe(200);
    expect(setCopy.body.mcpConfigPath).toBe(path.resolve(fileSrc));
    expect(setCopy.body.copyFiles).toEqual([".env", "config/local.yml"]);

    const fetched = await get(id);
    expect(fetched.mcpConfigPath).toBe(path.resolve(fileSrc));
    expect(fetched.copyFiles).toEqual([".env", "config/local.yml"]);
  });

  it("clears mcpConfigPath via empty string and copyFiles via empty array", async () => {
    const id = await makeProject();
    await patch(id, { mcpConfigPath: fileSrc, copyFiles: [".env"] });

    const cleared = await patch(id, { mcpConfigPath: "", copyFiles: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.mcpConfigPath).toBeNull();
    expect(cleared.body.copyFiles).toEqual([]);
  });

  it("400s on a wrong-kind mcpConfigPath (a directory) and does not mutate", async () => {
    const id = await makeProject();
    await patch(id, { mcpConfigPath: fileSrc });

    const bad = await patch(id, { mcpConfigPath: dirSrc });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/mcpConfigPath.*must be a file/);

    // The earlier valid value is preserved (the failed PATCH never ran).
    const fetched = await get(id);
    expect(fetched.mcpConfigPath).toBe(path.resolve(fileSrc));
  });
});

describe("PATCH /api/projects/:projectId/repos/:repoId — lifecycle scripts", () => {
  /** Create a project with a single repo; returns { projectId, repoId }. */
  async function makeProjectWithRepo(): Promise<{
    projectId: string;
    repoId: string;
  }> {
    const { body } = await post({
      name: "p",
      repos: [
        {
          name: "r",
          repoPath: "/abs/r",
          baseBranch: "main",
          setupScript: "npm i",
          runScript: "npm run dev",
          teardownScript: "echo bye",
        },
      ],
    });
    const project = body as unknown as Project;
    return { projectId: project.id, repoId: project.repos![0].id };
  }

  it("updates a single script and returns the hydrated Project", async () => {
    const { projectId, repoId } = await makeProjectWithRepo();

    const res = await patchRepo(projectId, repoId, { runScript: "npm start" });
    expect(res.status).toBe(200);
    const project = res.body as unknown as Project;
    expect(project.id).toBe(projectId);
    const repo = project.repos!.find((r) => r.id === repoId)!;
    expect(repo.runScript).toBe("npm start");
    // Other scripts untouched.
    expect(repo.setupScript).toBe("npm i");
    expect(repo.teardownScript).toBe("echo bye");
  });

  it("normalizes blank/whitespace scripts to null", async () => {
    const { projectId, repoId } = await makeProjectWithRepo();

    const res = await patchRepo(projectId, repoId, {
      setupScript: "   ",
      runScript: "",
    });
    expect(res.status).toBe(200);
    const project = res.body as unknown as Project;
    const repo = project.repos!.find((r) => r.id === repoId)!;
    expect(repo.setupScript).toBeNull();
    expect(repo.runScript).toBeNull();
    // Untouched.
    expect(repo.teardownScript).toBe("echo bye");
  });

  it("accepts explicit null to clear a script", async () => {
    const { projectId, repoId } = await makeProjectWithRepo();
    const res = await patchRepo(projectId, repoId, { teardownScript: null });
    expect(res.status).toBe(200);
    const project = res.body as unknown as Project;
    const repo = project.repos!.find((r) => r.id === repoId)!;
    expect(repo.teardownScript).toBeNull();
  });

  it("rejects a non-string, non-null script value with 400", async () => {
    const { projectId, repoId } = await makeProjectWithRepo();
    const res = await patchRepo(projectId, repoId, { setupScript: 42 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/setupScript.*must be a string or null/);

    // Unchanged after the rejected PATCH.
    const fetched = await get(projectId);
    expect(fetched.repos!.find((r) => r.id === repoId)!.setupScript).toBe("npm i");
  });

  it("404s when the repo does not exist", async () => {
    const { projectId } = await makeProjectWithRepo();
    const res = await patchRepo(projectId, "missing", { runScript: "x" });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/not found/i);
  });

  it("404s when the repo belongs to a different project", async () => {
    const { repoId } = await makeProjectWithRepo();
    const { body: other } = await post({ name: "other", repos: [] });
    const res = await patchRepo(other.id as string, repoId, { runScript: "x" });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/not found/i);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * DELETE /api/projects/:id — cascading teardown.
 *
 * Self-contained (its own app/db) so it can inject a recording TaskLifecycle
 * and assert the route DELEGATES the full teardown to `deleteProject` (rather
 * than doing a bare DB-only cascade that would orphan on-disk task state).
 * ────────────────────────────────────────────────────────────────────────── */
describe("DELETE /api/projects/:id — delegates to lifecycle.deleteProject", () => {
  let db2: DB;
  let repos2: Repositories;
  let server2: http.Server;
  let baseUrl2: string;
  let deleteProjectCalls: string[];

  beforeEach(async () => {
    db2 = initDb(":memory:");
    repos2 = createRepositories(db2);
    deleteProjectCalls = [];

    // A recording lifecycle: deleteProject records the id, actually removes the
    // project row (so the observable end-state matches production), and reports
    // false for a missing project — exactly the router's 404 vs 204 contract.
    const lifecycle: TaskLifecycle = {
      createTask: async () => {
        throw new Error("unused");
      },
      ensureAgent: async () => {},
      deleteTask: async () => {},
      deleteProject: async (projectId: string) => {
        deleteProjectCalls.push(projectId);
        return repos2.projects.delete(projectId);
      },
    };

    const app = express();
    app.use(json());
    app.use("/api/projects", createProjectsRouter({ repos: repos2, lifecycle }));
    server2 = http.createServer(app);
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
    const { port } = server2.address() as AddressInfo;
    baseUrl2 = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
    db2.close();
  });

  async function del(id: string): Promise<number> {
    const res = await fetch(`${baseUrl2}/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return res.status;
  }

  it("runs the lifecycle teardown and 204s for an existing project", async () => {
    const project = repos2.projects.create({ name: "doomed", repos: [] });

    const status = await del(project.id);

    expect(status).toBe(204);
    expect(deleteProjectCalls).toEqual([project.id]);
    // The project is gone from the DB after the delete.
    expect(repos2.projects.getById(project.id)).toBeNull();
  });

  it("404s for a missing project WITHOUT invoking the teardown", async () => {
    const status = await del("does-not-exist");

    expect(status).toBe(404);
    expect(deleteProjectCalls).toEqual([]);
  });
});
