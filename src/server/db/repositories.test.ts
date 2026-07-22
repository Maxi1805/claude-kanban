/**
 * Repositories tests — focused on the per-project Claude config path.
 *
 * Exercises the real better-sqlite3 stack (in-memory) end to end: schema +
 * idempotent migration applied by initDb, then the SqliteProjectRepository
 * create/getById/list/update round-trips, mapping claudeConfigPath to/from the
 * snake_case `claude_config_path` column and normalizing empty strings to null.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDb, type DB } from "./index.js";
import { createRepositories } from "./repositories.js";
import type { Repositories } from "../../shared/interfaces.js";

describe("SqliteProjectRepository — claudeConfigPath", () => {
  let db: DB;
  let repos: Repositories;

  beforeEach(() => {
    db = initDb(":memory:");
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips claudeConfigPath through create / getById / list", () => {
    const created = repos.projects.create({
      name: "with-config",
      repos: [],
      claudeConfigPath: "/abs/config/dir",
    });
    expect(created.claudeConfigPath).toBe("/abs/config/dir");

    const fetched = repos.projects.getById(created.id);
    expect(fetched?.claudeConfigPath).toBe("/abs/config/dir");

    const listed = repos.projects.list();
    expect(listed.find((p) => p.id === created.id)?.claudeConfigPath).toBe(
      "/abs/config/dir",
    );
  });

  it("defaults claudeConfigPath to null when omitted", () => {
    const created = repos.projects.create({ name: "no-config", repos: [] });
    expect(created.claudeConfigPath).toBeNull();
    expect(repos.projects.getById(created.id)?.claudeConfigPath).toBeNull();
  });

  it("normalizes an empty-string claudeConfigPath to null on create", () => {
    const created = repos.projects.create({
      name: "blank-config",
      repos: [],
      claudeConfigPath: "   ",
    });
    expect(created.claudeConfigPath).toBeNull();
  });

  it("updates claudeConfigPath (set, then clear via empty string)", () => {
    const created = repos.projects.create({ name: "p", repos: [] });

    const set = repos.projects.update(created.id, {
      claudeConfigPath: "/new/config",
    });
    expect(set?.claudeConfigPath).toBe("/new/config");
    expect(set?.name).toBe("p");

    const cleared = repos.projects.update(created.id, {
      claudeConfigPath: "",
    });
    expect(cleared?.claudeConfigPath).toBeNull();
  });

  it("leaves claudeConfigPath untouched when only name is patched", () => {
    const created = repos.projects.create({
      name: "p",
      repos: [],
      claudeConfigPath: "/keep/me",
    });
    const renamed = repos.projects.update(created.id, { name: "renamed" });
    expect(renamed?.name).toBe("renamed");
    expect(renamed?.claudeConfigPath).toBe("/keep/me");
  });
});

describe("SqliteProjectRepository — claudeMdPath / claudeDirPath", () => {
  let db: DB;
  let repos: Repositories;

  beforeEach(() => {
    db = initDb(":memory:");
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips both new columns through create / getById / list", () => {
    const created = repos.projects.create({
      name: "with-split-config",
      repos: [],
      claudeMdPath: "/abs/CLAUDE.md",
      claudeDirPath: "/abs/.claude",
    });
    expect(created.claudeMdPath).toBe("/abs/CLAUDE.md");
    expect(created.claudeDirPath).toBe("/abs/.claude");

    const fetched = repos.projects.getById(created.id);
    expect(fetched?.claudeMdPath).toBe("/abs/CLAUDE.md");
    expect(fetched?.claudeDirPath).toBe("/abs/.claude");

    const listed = repos.projects.list().find((p) => p.id === created.id);
    expect(listed?.claudeMdPath).toBe("/abs/CLAUDE.md");
    expect(listed?.claudeDirPath).toBe("/abs/.claude");
  });

  it("defaults both new columns to null when omitted", () => {
    const created = repos.projects.create({ name: "bare", repos: [] });
    expect(created.claudeMdPath).toBeNull();
    expect(created.claudeDirPath).toBeNull();
    const fetched = repos.projects.getById(created.id);
    expect(fetched?.claudeMdPath).toBeNull();
    expect(fetched?.claudeDirPath).toBeNull();
  });

  it("normalizes empty-string md/dir paths to null on create", () => {
    const created = repos.projects.create({
      name: "blanks",
      repos: [],
      claudeMdPath: "   ",
      claudeDirPath: "",
    });
    expect(created.claudeMdPath).toBeNull();
    expect(created.claudeDirPath).toBeNull();
  });

  it("sets the two columns independently, then clears each via empty string", () => {
    const created = repos.projects.create({ name: "p", repos: [] });

    // Set only the md path; the dir path stays null.
    const setMd = repos.projects.update(created.id, {
      claudeMdPath: "/new/CLAUDE.md",
    });
    expect(setMd?.claudeMdPath).toBe("/new/CLAUDE.md");
    expect(setMd?.claudeDirPath).toBeNull();

    // Set only the dir path; the md path is untouched.
    const setDir = repos.projects.update(created.id, {
      claudeDirPath: "/new/.claude",
    });
    expect(setDir?.claudeMdPath).toBe("/new/CLAUDE.md");
    expect(setDir?.claudeDirPath).toBe("/new/.claude");

    // Clear the md path via empty string; the dir path is untouched.
    const clearedMd = repos.projects.update(created.id, { claudeMdPath: "" });
    expect(clearedMd?.claudeMdPath).toBeNull();
    expect(clearedMd?.claudeDirPath).toBe("/new/.claude");
  });

  it("keeps legacy claudeConfigPath alongside the two new columns", () => {
    const created = repos.projects.create({
      name: "all-three",
      repos: [],
      claudeConfigPath: "/legacy/folder",
      claudeMdPath: "/explicit/CLAUDE.md",
      claudeDirPath: "/explicit/.claude",
    });
    const fetched = repos.projects.getById(created.id);
    expect(fetched?.claudeConfigPath).toBe("/legacy/folder");
    expect(fetched?.claudeMdPath).toBe("/explicit/CLAUDE.md");
    expect(fetched?.claudeDirPath).toBe("/explicit/.claude");
  });
});

describe("SqliteProjectRepository — mcpConfigPath / copyFiles", () => {
  let db: DB;
  let repos: Repositories;

  beforeEach(() => {
    db = initDb(":memory:");
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips mcpConfigPath + copyFiles through create / getById / list", () => {
    const created = repos.projects.create({
      name: "with-mcp",
      repos: [],
      mcpConfigPath: "/abs/.mcp.json",
      copyFiles: [".env", "secrets", ".env.*"],
    });
    expect(created.mcpConfigPath).toBe("/abs/.mcp.json");
    expect(created.copyFiles).toEqual([".env", "secrets", ".env.*"]);

    const fetched = repos.projects.getById(created.id);
    expect(fetched?.mcpConfigPath).toBe("/abs/.mcp.json");
    expect(fetched?.copyFiles).toEqual([".env", "secrets", ".env.*"]);

    const listed = repos.projects.list().find((p) => p.id === created.id);
    expect(listed?.mcpConfigPath).toBe("/abs/.mcp.json");
    expect(listed?.copyFiles).toEqual([".env", "secrets", ".env.*"]);
  });

  it("defaults mcpConfigPath to null and copyFiles to [] when omitted", () => {
    const created = repos.projects.create({ name: "bare", repos: [] });
    expect(created.mcpConfigPath).toBeNull();
    expect(created.copyFiles).toEqual([]);
    const fetched = repos.projects.getById(created.id);
    expect(fetched?.mcpConfigPath).toBeNull();
    expect(fetched?.copyFiles).toEqual([]);
  });

  it("normalizes a blank mcpConfigPath to null and trims/drops copyFiles entries", () => {
    const created = repos.projects.create({
      name: "blanks",
      repos: [],
      mcpConfigPath: "   ",
      copyFiles: ["  .env  ", "", "   ", "ok"],
    });
    expect(created.mcpConfigPath).toBeNull();
    // Trimmed; empties/whitespace dropped.
    expect(created.copyFiles).toEqual([".env", "ok"]);
  });

  it("stores an empty copyFiles list as [] (round-trips, not a stray string)", () => {
    const created = repos.projects.create({
      name: "empty-list",
      repos: [],
      copyFiles: [],
    });
    expect(created.copyFiles).toEqual([]);
    expect(repos.projects.getById(created.id)?.copyFiles).toEqual([]);
  });

  it("updates mcpConfigPath + copyFiles independently and clears via empty inputs", () => {
    const created = repos.projects.create({ name: "p", repos: [] });

    const setMcp = repos.projects.update(created.id, {
      mcpConfigPath: "/new/.mcp.json",
    });
    expect(setMcp?.mcpConfigPath).toBe("/new/.mcp.json");
    expect(setMcp?.copyFiles).toEqual([]);

    const setCopy = repos.projects.update(created.id, {
      copyFiles: [".env", "config/local.yml"],
    });
    expect(setCopy?.mcpConfigPath).toBe("/new/.mcp.json");
    expect(setCopy?.copyFiles).toEqual([".env", "config/local.yml"]);

    // Clear the mcp path via empty string; copyFiles untouched.
    const clearedMcp = repos.projects.update(created.id, { mcpConfigPath: "" });
    expect(clearedMcp?.mcpConfigPath).toBeNull();
    expect(clearedMcp?.copyFiles).toEqual([".env", "config/local.yml"]);

    // Clear copyFiles via empty array.
    const clearedCopy = repos.projects.update(created.id, { copyFiles: [] });
    expect(clearedCopy?.copyFiles).toEqual([]);
  });

  it("leaves mcpConfigPath + copyFiles untouched when only name is patched", () => {
    const created = repos.projects.create({
      name: "p",
      repos: [],
      mcpConfigPath: "/keep/.mcp.json",
      copyFiles: [".env"],
    });
    const renamed = repos.projects.update(created.id, { name: "renamed" });
    expect(renamed?.name).toBe("renamed");
    expect(renamed?.mcpConfigPath).toBe("/keep/.mcp.json");
    expect(renamed?.copyFiles).toEqual([".env"]);
  });
});

describe("SqliteProjectRepoRepository — update (lifecycle scripts)", () => {
  let db: DB;
  let repos: Repositories;

  beforeEach(() => {
    db = initDb(":memory:");
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  function newRepo(scripts?: {
    setupScript?: string | null;
    runScript?: string | null;
    teardownScript?: string | null;
  }) {
    const project = repos.projects.create({ name: "p", repos: [] });
    return repos.projectRepos.add(project.id, {
      name: "r",
      repoPath: "/abs/r",
      baseBranch: "main",
      ...scripts,
    });
  }

  it("updates only the provided script columns, leaving the others intact", () => {
    const repo = newRepo({
      setupScript: "npm i",
      runScript: "npm run dev",
      teardownScript: "echo bye",
    });

    const updated = repos.projectRepos.update(repo.id, {
      runScript: "npm start",
    });
    expect(updated?.setupScript).toBe("npm i");
    expect(updated?.runScript).toBe("npm start");
    expect(updated?.teardownScript).toBe("echo bye");

    const fetched = repos.projectRepos.getById(repo.id)!;
    expect(fetched.runScript).toBe("npm start");
    expect(fetched.setupScript).toBe("npm i");
  });

  it("normalizes empty / whitespace scripts to null", () => {
    const repo = newRepo({ setupScript: "npm i", runScript: "npm run dev" });

    const updated = repos.projectRepos.update(repo.id, {
      setupScript: "   ",
      runScript: "",
    });
    expect(updated?.setupScript).toBeNull();
    expect(updated?.runScript).toBeNull();
  });

  it("can set all three scripts at once and trims them", () => {
    const repo = newRepo();
    const updated = repos.projectRepos.update(repo.id, {
      setupScript: "  bundle install  ",
      runScript: "  rails s  ",
      teardownScript: "  cleanup  ",
    });
    expect(updated?.setupScript).toBe("bundle install");
    expect(updated?.runScript).toBe("rails s");
    expect(updated?.teardownScript).toBe("cleanup");
  });

  it("is a no-op (returns current row) when patch sets no fields", () => {
    const repo = newRepo({ setupScript: "keep" });
    const updated = repos.projectRepos.update(repo.id, {});
    expect(updated?.setupScript).toBe("keep");
  });

  it("returns null for an unknown repo id", () => {
    expect(repos.projectRepos.update("nope", { runScript: "x" })).toBeNull();
  });
});

describe("SqliteTaskRepository — agentState", () => {
  let db: DB;
  let repos: Repositories;

  beforeEach(() => {
    db = initDb(":memory:");
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  function newTask(): string {
    const project = repos.projects.create({ name: "p", repos: [] });
    return repos.tasks.create({
      projectId: project.id,
      title: "t",
      description: null,
      slug: "t",
    }).id;
  }

  it("defaults agentState/agentStateAt to null on create", () => {
    const id = newTask();
    const task = repos.tasks.getById(id)!;
    expect(task.agentState).toBeNull();
    expect(task.agentStateAt).toBeNull();
  });

  it("persists and reads agentState + agentStateAt via update", () => {
    const id = newTask();
    const at = new Date().toISOString();
    const updated = repos.tasks.update(id, {
      agentState: "working",
      agentStateAt: at,
    });
    expect(updated?.agentState).toBe("working");
    expect(updated?.agentStateAt).toBe(at);

    const fetched = repos.tasks.getById(id)!;
    expect(fetched.agentState).toBe("working");
    expect(fetched.agentStateAt).toBe(at);
  });

  it("transitions agentState (working → waiting → working)", () => {
    const id = newTask();
    expect(repos.tasks.update(id, { agentState: "working" })?.agentState).toBe(
      "working",
    );
    expect(repos.tasks.update(id, { agentState: "waiting" })?.agentState).toBe(
      "waiting",
    );
    expect(repos.tasks.update(id, { agentState: "working" })?.agentState).toBe(
      "working",
    );
  });

  it("leaves agentState untouched when only status is patched", () => {
    const id = newTask();
    repos.tasks.update(id, { agentState: "waiting" });
    const patched = repos.tasks.update(id, { status: "review" });
    expect(patched?.status).toBe("review");
    expect(patched?.agentState).toBe("waiting");
  });

  it("forces status='running' when agentState becomes 'working' (working ⇒ running)", () => {
    const id = newTask();
    // Fresh task is in "todo".
    expect(repos.tasks.getById(id)!.status).toBe("todo");
    const updated = repos.tasks.update(id, { agentState: "working" });
    expect(updated?.agentState).toBe("working");
    expect(updated?.status).toBe("running");
    expect(repos.tasks.getById(id)!.status).toBe("running");
  });

  it("respects an EXPLICIT status alongside agentState='working' (explicit wins)", () => {
    const id = newTask();
    const updated = repos.tasks.update(id, {
      agentState: "working",
      status: "review",
    });
    expect(updated?.agentState).toBe("working");
    // The explicit status is honored — the invariant does NOT override it.
    expect(updated?.status).toBe("review");
  });

  it("does NOT change status when agentState becomes 'waiting'", () => {
    const id = newTask();
    repos.tasks.update(id, { status: "review" });
    const updated = repos.tasks.update(id, { agentState: "waiting" });
    expect(updated?.agentState).toBe("waiting");
    expect(updated?.status).toBe("review");
  });

  it("does NOT change status when agentState is cleared to null", () => {
    const id = newTask();
    // Put it in "running" first (e.g. it was working), then clear the state.
    repos.tasks.update(id, { agentState: "working" });
    expect(repos.tasks.getById(id)!.status).toBe("running");
    const updated = repos.tasks.update(id, { agentState: null });
    expect(updated?.agentState).toBeNull();
    // Status is left untouched — clearing the state never moves the card.
    expect(updated?.status).toBe("running");
  });

  it("a repeated 'working' write is no-op-safe and never re-forces a manual move", () => {
    const id = newTask();
    // Transition to working forces running.
    repos.tasks.update(id, { agentState: "working" });
    expect(repos.tasks.getById(id)!.status).toBe("running");
    // Manually drag it out of running (explicit status, no agentState change).
    repos.tasks.update(id, { status: "review" });
    expect(repos.tasks.getById(id)!.status).toBe("review");
    // A repeated identical "working" write (the agent-events path guards against
    // this, but assert update itself is safe IF it ever arrives): it still forces
    // running per the invariant — so callers MUST guard. This pins the contract:
    // only the guarded callers protect a manual move, and they do (see
    // agent-events setState). The raw update couples working ⇒ running every time.
    const reForced = repos.tasks.update(id, { agentState: "working" });
    expect(reForced?.status).toBe("running");
  });

  it("clearAllAgentStates nulls agent_state + agent_state_at for ALL tasks", () => {
    // Two tasks across two projects, each carrying a live agent state.
    const a = newTask();
    const b = newTask();
    const at = new Date().toISOString();
    repos.tasks.update(a, { agentState: "working", agentStateAt: at });
    repos.tasks.update(b, { agentState: "waiting", agentStateAt: at });

    repos.tasks.clearAllAgentStates();

    for (const id of [a, b]) {
      const task = repos.tasks.getById(id)!;
      expect(task.agentState).toBeNull();
      expect(task.agentStateAt).toBeNull();
    }
  });

  it("clearAllAgentStates is a no-op-safe call when there are no tasks", () => {
    expect(() => repos.tasks.clearAllAgentStates()).not.toThrow();
  });
});
