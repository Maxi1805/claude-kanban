/**
 * better-sqlite3 initialization. Opens (and creates) the database file and
 * applies the schema idempotently. Exposes a typed `Database` handle.
 *
 * The schema (src/server/db/schema.sql) is authored with `CREATE TABLE IF NOT
 * EXISTS` and `CREATE INDEX IF NOT EXISTS`, so applying it on every boot is
 * safe and non-destructive.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "../config.js";

export type DB = Database.Database;

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);

/**
 * Open the database at `dbPath` (defaults to {@link config.dbPath}), ensure the
 * containing directory exists, enable foreign keys + WAL, and run the schema
 * DDL. Pass `":memory:"` for an ephemeral database (e.g. in tests).
 */
export function initDb(dbPath: string = config.dbPath): DB {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);

  migrate(db);

  return db;
}

/**
 * Idempotent, additive migrations applied on every boot. The base schema uses
 * `CREATE TABLE IF NOT EXISTS`, which will NOT add columns to a table that
 * already exists from a previous version — so columns introduced after a table
 * shipped must be added here, guarded by a `PRAGMA table_info` check. Each step
 * is a no-op once applied, and safe to run against a database that already has
 * data.
 */
function migrate(db: DB): void {
  addColumnIfMissing(db, "projects", "claude_config_path", "TEXT");
  // Two independent per-project selectors: an explicit CLAUDE.md FILE and a
  // .claude DIRECTORY. They supersede the legacy single-folder claude_config_path
  // (kept for backward-compatibility). Added after the projects table shipped, so
  // guard each with table_info.
  addColumnIfMissing(db, "projects", "claude_md_path", "TEXT");
  addColumnIfMissing(db, "projects", "claude_dir_path", "TEXT");
  // Per-project `.mcp.json` FILE selector (symlinked like claude_md_path) and the
  // list of untracked files to copy into each task worktree (stored as a JSON
  // array string). Added after the projects table shipped, so guard with
  // table_info.
  addColumnIfMissing(db, "projects", "mcp_config_path", "TEXT");
  addColumnIfMissing(db, "projects", "copy_files", "TEXT");
  // Live agent state (working/waiting) + the ISO timestamp of its last
  // transition. Added after the tasks table shipped, so guard with table_info.
  addColumnIfMissing(db, "tasks", "agent_state", "TEXT");
  addColumnIfMissing(db, "tasks", "agent_state_at", "TEXT");
}

/** True if `table` already has a column named `column`. */
function hasColumn(db: DB, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

/** `ALTER TABLE ... ADD COLUMN` only when the column is absent. */
function addColumnIfMissing(
  db: DB,
  table: string,
  column: string,
  type: string,
): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
