/**
 * DbViewerService implementation — the read-only backend of the `/db` live
 * database viewer.
 *
 * Opens its OWN read-only better-sqlite3 connection to the app's database file
 * (never shares the writer). That separation is also the change detector:
 * `PRAGMA data_version` moves only when a DIFFERENT connection commits, so from
 * this connection's viewpoint every write by the app — or by any external
 * process — bumps it. A 1s poll compares versions and broadcasts a `db:changed`
 * frame over the events hub; the frontend refetches on receipt.
 *
 * All introspection is generic (sqlite_master + pragma table functions), so the
 * viewer needs no updates when the schema evolves. Table names arriving from
 * the API are validated against sqlite_master before ever being interpolated,
 * and identifiers are double-quote escaped — user input can never reach SQL raw.
 */
import Database from "better-sqlite3";

import {
  DbViewerError,
  type DbViewerService,
} from "../../shared/interfaces.js";
import type {
  DbCellValue,
  DbChangedMsg,
  DbColumn,
  DbForeignKey,
  DbOverviewResponse,
  DbTableInfo,
  DbTableRowsResponse,
} from "../../shared/types.js";

/** Default and hard-cap page sizes for row reads. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** How often (ms) the watcher polls `PRAGMA data_version`. */
const DEFAULT_TICK_MS = 1000;

interface DbViewerOptions {
  /** Absolute path to the sqlite file (must already exist — initDb ran first). */
  dbPath: string;
  /** Sink for `db:changed` frames (the events hub). Omit to disable watching. */
  broadcast?: (msg: DbChangedMsg) => void;
  /** Poll interval override (tests). */
  tickMs?: number;
}

export class DbViewerServiceImpl implements DbViewerService {
  private readonly db: Database.Database;
  private readonly opts: DbViewerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastVersion: number | null = null;

  constructor(opts: DbViewerOptions) {
    this.opts = opts;
    this.db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
  }

  /* ── Introspection ──────────────────────────────────────────────────── */

  overview(): DbOverviewResponse {
    const tables = this.listTables().map((t): DbTableInfo => {
      const columns = (
        this.db
          .prepare("SELECT * FROM pragma_table_info(?)")
          .all(t.name) as {
          name: string;
          type: string;
          notnull: number;
          pk: number;
          dflt_value: string | null;
        }[]
      ).map(
        (c): DbColumn => ({
          name: c.name,
          type: c.type,
          notNull: c.notnull !== 0,
          primaryKey: c.pk !== 0,
          defaultValue: c.dflt_value,
        }),
      );

      const foreignKeys = (
        this.db
          .prepare("SELECT * FROM pragma_foreign_key_list(?)")
          .all(t.name) as { from: string; table: string; to: string | null }[]
      ).map(
        (fk): DbForeignKey => ({
          from: fk.from,
          toTable: fk.table,
          toColumn: fk.to,
        }),
      );

      const { n: rowCount } = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.name)}`)
        .get() as { n: number };

      return { name: t.name, rowCount, columns, foreignKeys, ddl: t.sql };
    });

    return { path: this.opts.dbPath, dataVersion: this.dataVersion(), tables };
  }

  tableRows(
    name: string,
    opts?: { limit?: number; offset?: number },
  ): DbTableRowsResponse {
    // Validate against the real table list BEFORE interpolating anything.
    const known = this.listTables().some((t) => t.name === name);
    if (!known) throw new DbViewerError(`Unknown table: ${name}`);

    const limit = clamp(opts?.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = Math.max(0, opts?.offset ?? 0);

    const { n: total } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)
      .get() as { n: number };

    const stmt = this.db.prepare(
      `SELECT * FROM ${quoteIdent(name)} LIMIT ? OFFSET ?`,
    );
    const columns = stmt.columns().map((c) => c.name);
    const rows = (stmt.raw(true).all(limit, offset) as unknown[][]).map((row) =>
      row.map(encodeCell),
    );

    return { table: name, total, limit, offset, columns, rows };
  }

  /* ── Change watching ────────────────────────────────────────────────── */

  start(): void {
    if (this.timer || !this.opts.broadcast) return;
    this.lastVersion = this.dataVersion();
    this.timer = setInterval(() => {
      let version: number;
      try {
        version = this.dataVersion();
      } catch {
        return; // transient read failure — try again next tick
      }
      if (this.lastVersion !== null && version !== this.lastVersion) {
        this.opts.broadcast?.({ type: "db:changed", dataVersion: version });
      }
      this.lastVersion = version;
    }, this.opts.tickMs ?? DEFAULT_TICK_MS);
    // Never hold the process open just to watch the db.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.stop();
    this.db.close();
  }

  /* ── Internals ──────────────────────────────────────────────────────── */

  private dataVersion(): number {
    return this.db.pragma("data_version", { simple: true }) as number;
  }

  private listTables(): { name: string; sql: string | null }[] {
    return this.db
      .prepare(
        "SELECT name, sql FROM sqlite_master " +
          "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string; sql: string | null }[];
  }
}

/** Double-quote an identifier, escaping embedded quotes (SQL standard). */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Serialize one sqlite value for JSON transport (BLOB → placeholder). */
function encodeCell(value: unknown): DbCellValue {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `[BLOB ${value.length} bytes]`;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Factory mirroring the other services' construction style. */
export const createDbViewerService = (
  opts: DbViewerOptions,
): DbViewerServiceImpl => new DbViewerServiceImpl(opts);
