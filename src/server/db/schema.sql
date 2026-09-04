-- claude-kanban schema. Applied idempotently at server boot.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  claude_config_path  TEXT,
  claude_md_path      TEXT,
  claude_dir_path     TEXT,
  mcp_config_path     TEXT,
  copy_files          TEXT
);

CREATE TABLE IF NOT EXISTS project_repos (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  repo_path        TEXT NOT NULL,
  base_branch      TEXT NOT NULL,
  setup_script     TEXT,
  run_script       TEXT,
  teardown_script  TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'todo',
  slug               TEXT NOT NULL,
  session_root       TEXT,
  pty_pid            INTEGER,
  claude_session_id  TEXT,
  port               INTEGER,
  agent_state        TEXT,
  agent_state_at     TEXT,
  caveman_enabled    INTEGER NOT NULL DEFAULT 0,
  caveman_level      TEXT,
  caveman_session    INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_repos (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_repo_id  TEXT NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  repo_name        TEXT NOT NULL,
  branch_name      TEXT NOT NULL,
  worktree_path    TEXT NOT NULL,
  remote_pushed    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project         ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_task_repos_task        ON task_repos(task_id);

-- OLA BC, FRENTE BC1 — LAS TRES TABLAS DEL MOTOR (`code_file_facts`,
-- `code_finding_decisions`, `code_graphs`) YA NO SE DECLARAN ACÁ. Viven en
-- `src/server/services/engine/schema.sql` y las aplica `ensureEngineSchema`,
-- que `db/index.ts` llama justo después de ejecutar este archivo — el
-- resultado sobre la base es idéntico al de antes de esta ola.
--
-- POR QUÉ SE MOVIERON. No tienen ni una clave foránea a `tasks`/`projects`:
-- `repo_key` es TEXT opaco. Son el almacenamiento del ANALIZADOR, y el
-- analizador tiene que poder arrancar contra una conexión que el tablero no
-- abrió (ver `engine/index.ts`). Dejar el DDL en dos lugares habría dejado
-- dos verdades que se separan en silencio; hay UNA sola, la del motor.
