/**
 * Live DB viewer tests — service + router over a real sqlite file.
 *
 * A writer connection creates a temp database with two related tables; the
 * DbViewerServiceImpl then opens it read-only and serves the /api/db routes on
 * a live http server. We assert:
 *   • GET /api/db lists user tables with columns, PK/FK metadata and counts
 *     (sqlite_* internals excluded),
 *   • GET /api/db/tables/:name/rows pages rows, clamps limits, and encodes
 *     NULL/BLOB cells for JSON transport,
 *   • an unknown table answers 404 (never reaching SQL),
 *   • the data_version watcher broadcasts db:changed when ANOTHER connection
 *     commits, and stays quiet otherwise.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbRouter } from "./db.js";
import { DbViewerServiceImpl } from "../services/db-viewer.js";
import type {
  DbChangedMsg,
  DbOverviewResponse,
  DbTableRowsResponse,
} from "../../shared/types.js";

let tmpDir: string;
let dbPath: string;
let writer: Database.Database;
let viewer: DbViewerServiceImpl | null;
let server: http.Server | null;
let baseUrl: string;

function seedDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES authors(id),
      title TEXT NOT NULL,
      notes TEXT,
      cover BLOB
    );
    INSERT INTO authors (id, name) VALUES (1, 'Borges'), (2, 'Cortázar');
  `);
  const insert = db.prepare(
    "INSERT INTO books (author_id, title, notes, cover) VALUES (?, ?, ?, ?)",
  );
  for (let i = 1; i <= 5; i++) {
    insert.run(1, `Libro ${i}`, i === 1 ? null : `nota ${i}`, null);
  }
  insert.run(2, "Rayuela", null, Buffer.from([1, 2, 3]));
  return db;
}

async function startServer(v: DbViewerServiceImpl): Promise<void> {
  const app = express();
  app.use("/api/db", createDbRouter({ viewer: v }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-dbviewer-"));
  dbPath = path.join(tmpDir, "test.db");
  writer = seedDatabase(dbPath);
  viewer = new DbViewerServiceImpl({ dbPath });
  await startServer(viewer);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  viewer?.close();
  viewer = null;
  writer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/db (overview)", () => {
  it("lists user tables with schema metadata and live row counts", async () => {
    const res = await fetch(`${baseUrl}/api/db`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DbOverviewResponse;

    expect(body.path).toBe(dbPath);
    expect(body.tables.map((t) => t.name)).toEqual(["authors", "books"]);

    const authors = body.tables[0];
    expect(authors.rowCount).toBe(2);
    expect(authors.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(authors.columns.find((c) => c.name === "name")?.notNull).toBe(true);
    expect(authors.ddl).toContain("CREATE TABLE authors");

    const books = body.tables[1];
    expect(books.rowCount).toBe(6);
    expect(books.foreignKeys).toEqual([
      { from: "author_id", toTable: "authors", toColumn: "id" },
    ]);
  });

  it("reflects external writes on the next read", async () => {
    writer.prepare("INSERT INTO authors (id, name) VALUES (3, 'Ocampo')").run();
    const res = await fetch(`${baseUrl}/api/db`);
    const body = (await res.json()) as DbOverviewResponse;
    expect(body.tables.find((t) => t.name === "authors")?.rowCount).toBe(3);
  });
});

describe("GET /api/db/tables/:name/rows", () => {
  it("returns aligned columns/rows and encodes NULL and BLOB cells", async () => {
    const res = await fetch(`${baseUrl}/api/db/tables/books/rows`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DbTableRowsResponse;

    expect(body.table).toBe("books");
    expect(body.total).toBe(6);
    expect(body.columns).toEqual(["id", "author_id", "title", "notes", "cover"]);

    const first = body.rows[0];
    expect(first[body.columns.indexOf("title")]).toBe("Libro 1");
    expect(first[body.columns.indexOf("notes")]).toBeNull();

    const rayuela = body.rows.find(
      (r) => r[body.columns.indexOf("title")] === "Rayuela",
    );
    expect(rayuela?.[body.columns.indexOf("cover")]).toBe("[BLOB 3 bytes]");
  });

  it("pages with limit/offset and clamps garbage limits", async () => {
    const res = await fetch(
      `${baseUrl}/api/db/tables/books/rows?limit=2&offset=2`,
    );
    const body = (await res.json()) as DbTableRowsResponse;
    expect(body.rows).toHaveLength(2);
    expect(body.offset).toBe(2);
    expect(body.rows[0][body.columns.indexOf("title")]).toBe("Libro 3");

    // A limit beyond the cap is clamped, not honored verbatim.
    const capped = await fetch(
      `${baseUrl}/api/db/tables/books/rows?limit=999999`,
    );
    const cappedBody = (await capped.json()) as DbTableRowsResponse;
    expect(cappedBody.limit).toBeLessThanOrEqual(1000);
  });

  it("answers 404 for a table that does not exist", async () => {
    const res = await fetch(
      `${baseUrl}/api/db/tables/${encodeURIComponent('no"such')}/rows`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown table");
  });
});

describe("data_version watcher", () => {
  it("broadcasts db:changed when another connection commits", async () => {
    const events: DbChangedMsg[] = [];
    const watched = new DbViewerServiceImpl({
      dbPath,
      broadcast: (msg) => events.push(msg),
      tickMs: 20,
    });
    watched.start();
    try {
      // Quiet period first: no writes → no frames.
      await sleep(80);
      expect(events).toHaveLength(0);

      writer.prepare("INSERT INTO authors (id, name) VALUES (9, 'Piglia')").run();
      await waitFor(() => events.length > 0);
      expect(events[0].type).toBe("db:changed");
      expect(typeof events[0].dataVersion).toBe("number");
    } finally {
      watched.close();
    }
  });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}
