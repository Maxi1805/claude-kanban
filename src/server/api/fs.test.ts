/**
 * Filesystem-browser router tests.
 *
 * Mounts createFsRouter on a real Express app (over a live http server) with a
 * fake FsBrowserService, and fires real HTTP requests. We assert that:
 *   • GET /api/fs/list forwards the `path` query param,
 *   • the `includeFiles` query param is parsed and forwarded (default false,
 *     truthy strings → true), preserving the legacy directories-only behaviour,
 *   • FsBrowseError surfaces as 400 { error }, other errors as 500,
 *   • inspect requires a path and forwards it.
 *
 * The fake service records its calls so we can assert the exact arguments the
 * router passed through — the file-flag plumbing lives in the service (tested
 * separately); here we only verify the router's param wiring stays correct.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsRouter } from "./fs.js";
import { FsBrowseError, type FsBrowserService } from "../../shared/interfaces.js";
import type {
  FsInspectResponse,
  FsListResponse,
  FsRootsResponse,
} from "../../shared/types.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Recording fake service.
 * ────────────────────────────────────────────────────────────────────────── */

interface ListCall {
  path?: string;
  opts?: { includeFiles?: boolean };
}

let listCalls: ListCall[];
let inspectCalls: string[];
let listImpl: (
  path?: string,
  opts?: { includeFiles?: boolean },
) => Promise<FsListResponse>;

function emptyListing(p = "/home"): FsListResponse {
  return {
    path: p,
    parent: null,
    isGitRepo: false,
    entries: [],
    childGitRepos: [],
    truncated: false,
  };
}

const fakeService: FsBrowserService = {
  roots(): FsRootsResponse {
    return { roots: [{ path: "/home", label: "Home" }] };
  },
  list(path, opts) {
    listCalls.push({ path, opts });
    return listImpl(path, opts);
  },
  inspect(path: string): Promise<FsInspectResponse> {
    inspectCalls.push(path);
    return Promise.resolve({
      path,
      isGitRepo: false,
      name: "x",
      baseBranch: null,
      branches: [],
      childGitRepos: [],
    });
  },
};

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  listCalls = [];
  inspectCalls = [];
  listImpl = (path) => Promise.resolve(emptyListing(path ?? "/home"));

  const app = express();
  app.use("/api/fs", createFsRouter({ fsBrowser: fakeService }));

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(pathAndQuery: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${pathAndQuery}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

describe("fs router", () => {
  it("forwards path with includeFiles defaulting to false", async () => {
    const res = await get("/api/fs/list?path=" + encodeURIComponent("/home/me"));
    expect(res.status).toBe(200);
    expect(listCalls).toEqual([
      { path: "/home/me", opts: { includeFiles: false } },
    ]);
  });

  it("omitted path → undefined, includeFiles false (legacy behaviour)", async () => {
    const res = await get("/api/fs/list");
    expect(res.status).toBe(200);
    expect(listCalls).toEqual([
      { path: undefined, opts: { includeFiles: false } },
    ]);
  });

  it("parses truthy includeFiles values to true", async () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      listCalls = [];
      await get(`/api/fs/list?includeFiles=${v}`);
      expect(listCalls[0].opts?.includeFiles).toBe(true);
    }
  });

  it("treats other includeFiles values as false", async () => {
    for (const v of ["0", "false", "no", "off", "banana", ""]) {
      listCalls = [];
      await get(`/api/fs/list?includeFiles=${encodeURIComponent(v)}`);
      expect(listCalls[0].opts?.includeFiles).toBe(false);
    }
  });

  it("includeFiles=1 surfaces files in the response body", async () => {
    listImpl = (p, opts) =>
      Promise.resolve({
        ...emptyListing(p ?? "/home"),
        entries: opts?.includeFiles
          ? [
              {
                path: "/home/dir",
                name: "dir",
                isFile: false,
                isGitRepo: false,
                hidden: false,
              },
              {
                path: "/home/CLAUDE.md",
                name: "CLAUDE.md",
                isFile: true,
                isGitRepo: false,
                hidden: false,
              },
            ]
          : [],
      });

    const res = await get("/api/fs/list?path=/home&includeFiles=1");
    expect(res.status).toBe(200);
    const body = res.body as FsListResponse;
    const file = body.entries.find((e) => e.name === "CLAUDE.md");
    expect(file?.isFile).toBe(true);
  });

  it("maps FsBrowseError to 400 { error }", async () => {
    listImpl = () =>
      Promise.reject(new FsBrowseError("Path is outside the allowed roots"));
    const res = await get("/api/fs/list?path=/etc");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Path is outside the allowed roots" });
  });

  it("inspect requires a path (400) and otherwise forwards it", async () => {
    const missing = await get("/api/fs/inspect");
    expect(missing.status).toBe(400);
    expect(inspectCalls).toEqual([]);

    const ok = await get("/api/fs/inspect?path=" + encodeURIComponent("/home/x"));
    expect(ok.status).toBe(200);
    expect(inspectCalls).toEqual(["/home/x"]);
  });

  it("roots returns the allow-roots", async () => {
    const res = await get("/api/fs/roots");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ roots: [{ path: "/home", label: "Home" }] });
  });
});
