/**
 * Typed CRUD repositories over the sqlite database.
 *
 * Implements the canonical {@link Repositories} contract from
 * `src/shared/interfaces.ts`. Every method returns the camelCase shared domain
 * types — snake_case row mapping is confined to this file. Ids are generated
 * with nanoid; timestamps are ISO-8601 strings.
 */
import { nanoid } from "nanoid";
import type {
  AgentState,
  Project,
  ProjectRepo,
  Task,
  TaskRepo,
  TaskStatus,
  AddRepoDTO,
  CreateProjectDTO,
  UpdateRepoDTO,
} from "../../shared/types.js";
import type {
  Repositories,
  ProjectRepository,
  ProjectRepoRepository,
  TaskRepository,
  TaskRepoRepository,
  TaskPatch,
} from "../../shared/interfaces.js";
import type { DB } from "./index.js";

/* ────────────────────────────────────────────────────────────────────────
 * Raw row shapes (snake_case, exactly as stored in sqlite)
 * ──────────────────────────────────────────────────────────────────────── */

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  claude_config_path: string | null;
  claude_md_path: string | null;
  claude_dir_path: string | null;
  mcp_config_path: string | null;
  /** JSON-encoded string[] of copy patterns; null/empty when none. */
  copy_files: string | null;
}

interface ProjectRepoRow {
  id: string;
  project_id: string;
  name: string;
  repo_path: string;
  base_branch: string;
  setup_script: string | null;
  run_script: string | null;
  teardown_script: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  slug: string;
  session_root: string | null;
  pty_pid: number | null;
  claude_session_id: string | null;
  port: number | null;
  agent_state: string | null;
  agent_state_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRepoRow {
  id: string;
  task_id: string;
  project_repo_id: string;
  repo_name: string;
  branch_name: string;
  worktree_path: string;
  remote_pushed: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Row → domain mappers
 * ──────────────────────────────────────────────────────────────────────── */

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    claudeConfigPath: row.claude_config_path,
    claudeMdPath: row.claude_md_path,
    claudeDirPath: row.claude_dir_path,
    mcpConfigPath: row.mcp_config_path,
    copyFiles: parseCopyFiles(row.copy_files),
  };
}

/** Normalize an optional path: empty/whitespace string → null, else trimmed. */
function normalizeConfigPath(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decode the stored `copy_files` column (a JSON array of strings) into a
 * `string[]`. Null/empty/malformed values all degrade to `[]`, so callers never
 * have to defend against bad on-disk data.
 */
function parseCopyFiles(value: string | null | undefined): string[] {
  if (value == null || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/**
 * Encode a `copyFiles` array for the `copy_files` column. Trims entries, drops
 * empties, and stores `null` when nothing remains so an absent list round-trips
 * to `[]` (never a stray `"[]"`/empty string).
 */
function serializeCopyFiles(value: string[] | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

function mapProjectRepo(row: ProjectRepoRow): ProjectRepo {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    setupScript: row.setup_script,
    runScript: row.run_script,
    teardownScript: row.teardown_script,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    slug: row.slug,
    sessionRoot: row.session_root,
    ptyPid: row.pty_pid,
    claudeSessionId: row.claude_session_id,
    port: row.port,
    agentState: row.agent_state as AgentState | null,
    agentStateAt: row.agent_state_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskRepo(row: TaskRepoRow): TaskRepo {
  return {
    id: row.id,
    taskId: row.task_id,
    projectRepoId: row.project_repo_id,
    repoName: row.repo_name,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    remotePushed: row.remote_pushed !== 0,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ────────────────────────────────────────────────────────────────────────
 * ProjectRepository
 * ──────────────────────────────────────────────────────────────────────── */

class SqliteProjectRepository implements ProjectRepository {
  constructor(
    private readonly db: DB,
    private readonly repos: SqliteProjectRepoRepository,
  ) {}

  create(dto: CreateProjectDTO): Project {
    const id = nanoid();
    const createdAt = nowIso();

    const insertProject = this.db.prepare(
      `INSERT INTO projects
         (id, name, created_at, claude_config_path, claude_md_path, claude_dir_path,
          mcp_config_path, copy_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      insertProject.run(
        id,
        dto.name,
        createdAt,
        normalizeConfigPath(dto.claudeConfigPath),
        normalizeConfigPath(dto.claudeMdPath),
        normalizeConfigPath(dto.claudeDirPath),
        normalizeConfigPath(dto.mcpConfigPath),
        serializeCopyFiles(dto.copyFiles),
      );
      for (const repo of dto.repos ?? []) {
        this.repos.add(id, repo);
      }
    });
    tx();

    const project = this.getById(id);
    /* getById cannot return null immediately after a successful insert. */
    if (!project) {
      throw new Error(`Project ${id} vanished after insert`);
    }
    return project;
  }

  getById(id: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    if (!row) return null;
    const project = mapProject(row);
    project.repos = this.repos.listByProject(id);
    return project;
  }

  list(opts?: { withRepos?: boolean }): Project[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at ASC, id ASC")
      .all() as ProjectRow[];
    const projects = rows.map(mapProject);
    if (opts?.withRepos) {
      for (const project of projects) {
        project.repos = this.repos.listByProject(project.id);
      }
    }
    return projects;
  }

  update(
    id: string,
    patch: {
      name?: string;
      claudeConfigPath?: string | null;
      claudeMdPath?: string | null;
      claudeDirPath?: string | null;
      mcpConfigPath?: string | null;
      copyFiles?: string[];
    },
  ): Project | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name);
    }
    if (patch.claudeConfigPath !== undefined) {
      sets.push("claude_config_path = ?");
      values.push(normalizeConfigPath(patch.claudeConfigPath));
    }
    if (patch.claudeMdPath !== undefined) {
      sets.push("claude_md_path = ?");
      values.push(normalizeConfigPath(patch.claudeMdPath));
    }
    if (patch.claudeDirPath !== undefined) {
      sets.push("claude_dir_path = ?");
      values.push(normalizeConfigPath(patch.claudeDirPath));
    }
    if (patch.mcpConfigPath !== undefined) {
      sets.push("mcp_config_path = ?");
      values.push(normalizeConfigPath(patch.mcpConfigPath));
    }
    if (patch.copyFiles !== undefined) {
      sets.push("copy_files = ?");
      values.push(serializeCopyFiles(patch.copyFiles));
    }

    if (sets.length === 0) {
      /* Nothing to change; return the current state (or null if absent). */
      return this.getById(id);
    }

    values.push(id);
    const result = this.db
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(values as never[]));
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM projects WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * ProjectRepoRepository
 * ──────────────────────────────────────────────────────────────────────── */

class SqliteProjectRepoRepository implements ProjectRepoRepository {
  constructor(private readonly db: DB) {}

  add(projectId: string, dto: AddRepoDTO): ProjectRepo {
    const id = nanoid();
    this.db
      .prepare(
        `INSERT INTO project_repos
           (id, project_id, name, repo_path, base_branch, setup_script, run_script, teardown_script)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        dto.name,
        dto.repoPath,
        dto.baseBranch,
        dto.setupScript ?? null,
        dto.runScript ?? null,
        dto.teardownScript ?? null,
      );
    const repo = this.getById(id);
    if (!repo) {
      throw new Error(`ProjectRepo ${id} vanished after insert`);
    }
    return repo;
  }

  getById(id: string): ProjectRepo | null {
    const row = this.db
      .prepare("SELECT * FROM project_repos WHERE id = ?")
      .get(id) as ProjectRepoRow | undefined;
    return row ? mapProjectRepo(row) : null;
  }

  listByProject(projectId: string): ProjectRepo[] {
    const rows = this.db
      .prepare("SELECT * FROM project_repos WHERE project_id = ? ORDER BY name ASC, id ASC")
      .all(projectId) as ProjectRepoRow[];
    return rows.map(mapProjectRepo);
  }

  update(repoId: string, patch: UpdateRepoDTO): ProjectRepo | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.setupScript !== undefined) {
      sets.push("setup_script = ?");
      values.push(normalizeConfigPath(patch.setupScript));
    }
    if (patch.runScript !== undefined) {
      sets.push("run_script = ?");
      values.push(normalizeConfigPath(patch.runScript));
    }
    if (patch.teardownScript !== undefined) {
      sets.push("teardown_script = ?");
      values.push(normalizeConfigPath(patch.teardownScript));
    }

    if (sets.length === 0) {
      /* Nothing to change; return the current state (or null if absent). */
      return this.getById(repoId);
    }

    values.push(repoId);
    const result = this.db
      .prepare(`UPDATE project_repos SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(values as never[]));
    if (result.changes === 0) return null;
    return this.getById(repoId);
  }

  remove(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM project_repos WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * TaskRepository
 * ──────────────────────────────────────────────────────────────────────── */

class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly db: DB,
    private readonly taskRepos: SqliteTaskRepoRepository,
  ) {}

  create(
    fields: Pick<Task, "projectId" | "title" | "description" | "slug"> &
      Partial<Pick<Task, "status">>,
  ): Task {
    const id = nanoid();
    const ts = nowIso();
    const status: TaskStatus = fields.status ?? "todo";

    this.db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, title, description, status, slug,
            session_root, pty_pid, claude_session_id, port,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        fields.projectId,
        fields.title,
        fields.description ?? null,
        status,
        fields.slug,
        ts,
        ts,
      );

    const task = this.getById(id);
    if (!task) {
      throw new Error(`Task ${id} vanished after insert`);
    }
    return task;
  }

  getById(id: string, opts?: { withRepos?: boolean }): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    if (!row) return null;
    const task = mapTask(row);
    if (opts?.withRepos) {
      task.repos = this.taskRepos.listByTask(id);
    }
    return task;
  }

  list(opts?: { projectId?: string; withRepos?: boolean }): Task[] {
    let rows: TaskRow[];
    if (opts?.projectId) {
      rows = this.db
        .prepare(
          "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(opts.projectId) as TaskRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM tasks ORDER BY created_at ASC, id ASC")
        .all() as TaskRow[];
    }
    const tasks = rows.map(mapTask);
    if (opts?.withRepos) {
      for (const task of tasks) {
        task.repos = this.taskRepos.listByTask(task.id);
      }
    }
    return tasks;
  }

  update(id: string, patch: TaskPatch): Task | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    // INVARIANT (working ⇒ running): a task whose live agent becomes "working"
    // MUST live in the "running" column. Enforced here, in the single update
    // chokepoint, so EVERY caller (lifecycle create/respawn, the agent-events
    // activity hook) gets the auto-move for free without each remembering to set
    // status. We only force the move when the SAME patch does not already set an
    // explicit status — an explicit `patch.status` always wins (so a caller can
    // still write {agentState:"working", status:"review"} deliberately). Note we
    // do NOT clear agentState when status flips to a non-running value: display
    // gating hides it instead, which avoids an erratic move↔re-work fight where a
    // manual drag would yank the card back. Because every "working" write is a
    // no-op when the state is unchanged (callers guard with `if (task.agentState
    // === state) return;` before calling update), a card manually dragged out of
    // "running" while already "working" is never re-forced back — only a fresh
    // waiting→working transition (a new turn) reaches here and moves it.
    const effectiveStatus =
      patch.agentState === "working" && patch.status === undefined
        ? "running"
        : patch.status;

    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      values.push(patch.description);
    }
    if (effectiveStatus !== undefined) {
      sets.push("status = ?");
      values.push(effectiveStatus);
    }
    if (patch.slug !== undefined) {
      sets.push("slug = ?");
      values.push(patch.slug);
    }
    if (patch.sessionRoot !== undefined) {
      sets.push("session_root = ?");
      values.push(patch.sessionRoot);
    }
    if (patch.ptyPid !== undefined) {
      sets.push("pty_pid = ?");
      values.push(patch.ptyPid);
    }
    if (patch.claudeSessionId !== undefined) {
      sets.push("claude_session_id = ?");
      values.push(patch.claudeSessionId);
    }
    if (patch.port !== undefined) {
      sets.push("port = ?");
      values.push(patch.port);
    }
    if (patch.agentState !== undefined) {
      sets.push("agent_state = ?");
      values.push(patch.agentState);
    }
    if (patch.agentStateAt !== undefined) {
      sets.push("agent_state_at = ?");
      values.push(patch.agentStateAt);
    }

    if (sets.length === 0) {
      /* No-op patch: just touch updated_at and return current state. */
      return this.getById(id);
    }

    sets.push("updated_at = ?");
    values.push(nowIso());
    values.push(id);

    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(values as never[]));
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  setStatus(id: string, status: TaskStatus): Task | null {
    const result = this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  clearAllAgentStates(): void {
    // Wipe every task's live agent state in one statement. Deliberately does NOT
    // touch updated_at — this is a boot-time reconciliation of a transient field,
    // not a user-meaningful edit. After this, all cards/sidebar fall back to the
    // "no live agent" rendering until a pty respawns and a hook sets state again.
    this.db
      .prepare("UPDATE tasks SET agent_state = NULL, agent_state_at = NULL")
      .run();
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * TaskRepoRepository
 * ──────────────────────────────────────────────────────────────────────── */

class SqliteTaskRepoRepository implements TaskRepoRepository {
  constructor(private readonly db: DB) {}

  createMany(rows: Omit<TaskRepo, "id">[]): TaskRepo[] {
    const insert = this.db.prepare(
      `INSERT INTO task_repos
         (id, task_id, project_repo_id, repo_name, branch_name, worktree_path, remote_pushed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const created: TaskRepo[] = [];
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const id = nanoid();
        insert.run(
          id,
          row.taskId,
          row.projectRepoId,
          row.repoName,
          row.branchName,
          row.worktreePath,
          row.remotePushed ? 1 : 0,
        );
        created.push({ id, ...row });
      }
    });
    tx();
    return created;
  }

  getById(id: string): TaskRepo | null {
    const row = this.db
      .prepare("SELECT * FROM task_repos WHERE id = ?")
      .get(id) as TaskRepoRow | undefined;
    return row ? mapTaskRepo(row) : null;
  }

  listByTask(taskId: string): TaskRepo[] {
    const rows = this.db
      .prepare("SELECT * FROM task_repos WHERE task_id = ? ORDER BY repo_name ASC, id ASC")
      .all(taskId) as TaskRepoRow[];
    return rows.map(mapTaskRepo);
  }

  listTaskIdsByProjectRepo(projectRepoId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT task_id FROM task_repos WHERE project_repo_id = ? ORDER BY task_id ASC",
      )
      .all(projectRepoId) as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  listAll(): TaskRepo[] {
    const rows = this.db
      .prepare("SELECT * FROM task_repos ORDER BY id ASC")
      .all() as TaskRepoRow[];
    return rows.map(mapTaskRepo);
  }

  markPushed(id: string, pushed: boolean): TaskRepo | null {
    const result = this.db
      .prepare("UPDATE task_repos SET remote_pushed = ? WHERE id = ?")
      .run(pushed ? 1 : 0, id);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  deleteByTask(taskId: string): number {
    const result = this.db
      .prepare("DELETE FROM task_repos WHERE task_id = ?")
      .run(taskId);
    return result.changes;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Aggregate
 * ──────────────────────────────────────────────────────────────────────── */

/** Concrete {@link Repositories} backed by a better-sqlite3 connection. */
export class SqliteRepositories implements Repositories {
  readonly projects: ProjectRepository;
  readonly projectRepos: ProjectRepoRepository;
  readonly tasks: TaskRepository;
  readonly taskRepos: TaskRepoRepository;

  constructor(private readonly db: DB) {
    const projectRepos = new SqliteProjectRepoRepository(db);
    const taskRepos = new SqliteTaskRepoRepository(db);
    this.projectRepos = projectRepos;
    this.taskRepos = taskRepos;
    this.projects = new SqliteProjectRepository(db, projectRepos);
    this.tasks = new SqliteTaskRepository(db, taskRepos);
  }
}

/** Build the aggregate {@link Repositories} handle over an open database. */
export function createRepositories(db: DB): Repositories {
  return new SqliteRepositories(db);
}
