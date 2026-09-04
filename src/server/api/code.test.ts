/**
 * Per-task code route + inspector tests, over REAL source files on disk —
 * plain directories, not even git repos: analyzeRepo/worktreeSignature only
 * ever touch the filesystem, so a temp dir with a couple of JS files is
 * enough to exercise duplication detection, caching, invalidation and the
 * per-repo error path. The F2 (persistent facts + discards) tests further
 * below use REAL git repos where the persistent tier needs one — see their
 * own comments for why.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodeRouter } from "./code.js";
import { CodeInspectorServiceImpl } from "../services/code-inspector.js";
import * as codeAnalyzer from "../services/code-analyzer.js";
import { initDb, type DB } from "../db/index.js";
import type { Repositories } from "../../shared/interfaces.js";
import type { Task, TaskCodeResponse, TaskRepo } from "../../shared/types.js";

/**
 * Two functions, identical in SHAPE (only the identifiers differ), long
 * enough to clear the analyzer's node/line thresholds. Structural hashing
 * ignores identifiers, so these register as a duplication finding.
 */
const DUPLICATED_SOURCE = `
function calculatePriceA(amount) {
  let total = 0;
  if (amount > 100) {
    total = amount * 0.8;
  } else if (amount > 50) {
    total = amount * 0.9;
  } else {
    total = amount;
  }
  total = total + 1;
  total = total + 2;
  total = total + 3;
  return total;
}

function calculatePriceB(value) {
  let total = 0;
  if (value > 100) {
    total = value * 0.8;
  } else if (value > 50) {
    total = value * 0.9;
  } else {
    total = value;
  }
  total = total + 1;
  total = total + 2;
  total = total + 3;
  return total;
}
`;

/** A third clone, appended later to prove cache invalidation on file change. */
const WITH_THIRD_CLONE = `${DUPLICATED_SOURCE}
function calculatePriceC(input) {
  let total = 0;
  if (input > 100) {
    total = input * 0.8;
  } else if (input > 50) {
    total = input * 0.9;
  } else {
    total = input;
  }
  total = total + 1;
  total = total + 2;
  total = total + 3;
  return total;
}
`;

let tmpDir: string;
let server: http.Server | null;
let baseUrl: string;
let db: DB;

function fakeRepos(taskRepos: TaskRepo[]): Repositories {
  const task: Task = {
    id: "task-1",
    projectId: "proj-1",
    title: "Refactor pricing",
    description: null,
    status: "running",
    slug: "refactor-pricing",
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
    projects: {},
    projectRepos: {},
    taskRepos: {},
  } as unknown as Repositories;
}

const taskRepo = (
  id: string,
  name: string,
  worktreePath: string,
): TaskRepo => ({
  id,
  taskId: "task-1",
  projectRepoId: `pr-${id}`,
  repoName: name,
  branchName: "refactor-pricing",
  worktreePath,
  remotePushed: false,
});

async function startServer(repos: Repositories, sharedDb?: DB): Promise<CodeInspectorServiceImpl> {
  const app = express();
  app.use(express.json());
  const inspector = new CodeInspectorServiceImpl(repos, sharedDb ?? db);
  app.use("/api/tasks", createCodeRouter({ inspector }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return inspector;
}

const getCode = async (): Promise<TaskCodeResponse> =>
  (await (await fetch(`${baseUrl}/api/tasks/task-1/code`)).json()) as TaskCodeResponse;

/** P3: same GET, with a raw query string appended — for offset/limit pagination. */
const getCodeQs = async (qs: string): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${baseUrl}/api/tasks/task-1/code?${qs}`);
  return { status: res.status, body: await res.json() };
};

/**
 * Analysis runs in the BACKGROUND: the GET returns at once and the work lands
 * later, so tests poll `analyzing` the way the UI does.
 */
async function waitForAnalysis(repoName: string): Promise<TaskCodeResponse> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const body = await getCode();
    const repo = body.repos.find((r) => r.repoName === repoName);
    if (repo && repo.analyzing !== true) return body;
    if (Date.now() > deadline) throw new Error("el análisis no terminó a tiempo");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-code-"));
  db = initDb(":memory:");
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

describe("GET /api/tasks/:taskId/code", () => {
  it("answers analyzing:true on the first look, then the findings once analysis lands", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);

    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));

    const first = await getCode();
    expect(first.repos[0].analyzing).toBe(true);
    expect(first.repos[0].analysis).toBeNull();
    expect(first.repos[0].error).toBeUndefined();

    const settled = await waitForAnalysis("backend");
    const repo = settled.repos[0];
    expect(repo.error).toBeUndefined();
    expect(repo.analysis).not.toBeNull();
    expect(repo.analysis!.findings.length).toBeGreaterThan(0);
    expect(repo.analysis!.findings.some((f) => f.kind === "duplication")).toBe(true);
    expect(repo.analysis!.analysedFiles).toBe(1);
  });

  it("reuses the cached analysis on a second call instead of re-analysing", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);

    // Every response round-trips through JSON, so object identity cannot
    // prove reuse; counting real calls to the analyzer does.
    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");

    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    const settled = await waitForAnalysis("backend");
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await getCode();
    expect(second.repos[0].analysis).toEqual(settled.repos[0].analysis);
    expect(second.repos[0].analyzing).not.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("invalidates the cache when a file in the repo changes", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    const file = path.join(repoDir, "pricing.js");
    fs.writeFileSync(file, DUPLICATED_SOURCE);

    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    const before = (await waitForAnalysis("backend")).repos[0].analysis!;

    // A different size guarantees a different worktree signature regardless
    // of filesystem mtime resolution.
    fs.writeFileSync(file, WITH_THIRD_CLONE);

    const afterFirstLook = await getCode();
    expect(afterFirstLook.repos[0].analyzing).toBe(true);

    const after = (await waitForAnalysis("backend")).repos[0].analysis!;
    expect(after).not.toBe(before);
    const dup = after.findings.find((f) => f.kind === "duplication");
    expect(dup?.locations.length).toBe(3);
  });

  it("answers 404 for an unknown task", async () => {
    await startServer(fakeRepos([]));
    expect((await fetch(`${baseUrl}/api/tasks/nope/code`)).status).toBe(404);
  });

  it("reports an unreadable repo as a per-repo error, without failing the request", async () => {
    const goodDir = path.join(tmpDir, "backend");
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, "pricing.js"), DUPLICATED_SOURCE);
    const missingDir = path.join(tmpDir, "does-not-exist");

    await startServer(
      fakeRepos([
        taskRepo("tr-1", "backend", goodDir),
        taskRepo("tr-2", "frontend", missingDir),
      ]),
    );

    const res = await fetch(`${baseUrl}/api/tasks/task-1/code`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskCodeResponse;

    const broken = body.repos.find((r) => r.repoName === "frontend")!;
    expect(broken.analysis).toBeNull();
    expect(broken.analyzing).not.toBe(true);
    expect(broken.error).toBeTruthy();

    // The other repo in the same task is unaffected.
    const good = await waitForAnalysis("backend");
    expect(good.repos.find((r) => r.repoName === "backend")!.analysis).not.toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * P3 — paginación real end-to-end (offset/limit por HTTP, propagados hasta
 * `analyzeRepo`). `DUPLICATED_SOURCE` en un único archivo produce
 * exactamente 2 grupos hoy (`duplication` + `orphan-file` — el archivo no
 * tiene ninguna arista hacia/desde el resto del repo), verificado corriendo
 * `analyzeRepo` directamente sobre este mismo fixture antes de escribir este
 * describe: suficiente para probar offset/limit con `limit=1` sin depender
 * de ningún número medido en un repo real.
 * ──────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────
 * OLA BA, FRENTE BA1 — LA CAPA CRUZA HTTP.
 *
 * `layer` está en `hypotheses/types.ts` (servidor), en `shared/types.ts` (el
 * tipo que viaja) y lo copia `code-analyzer.ts#toPublicHypothesis`. Nada de eso
 * prueba que llegue: `missingEdgeKinds` está escrito en el tipo del servidor y
 * MUERE ahí porque el tipo que viaja no lo tiene. Este test mira el JSON que
 * sale de verdad por la ruta, parseado por `fetch`, no un tipo.
 * ──────────────────────────────────────────────────────────────────────── */

/** Cadena de >=5 ramas con discriminante — ancla real de Strategy (misma forma que `registries.test.ts`). */
const CHAIN_SOURCE = `
function classify(kind) {
  if (kind === "a") {
    return handleA(kind);
  } else if (kind === "b") {
    return handleB(kind);
  } else if (kind === "c") {
    return handleC(kind);
  } else if (kind === "d") {
    return handleD(kind);
  } else if (kind === "e") {
    return handleE(kind);
  } else {
    return 0;
  }
}
`;

describe("OLA BA: `layer` en la respuesta HTTP", () => {
  it("cada hipótesis del JSON servido trae su capa ('patron' o 'refactorizacion')", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "classify.js"), CHAIN_SOURCE);
    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    await waitForAnalysis("backend");

    const res = await getCodeQs("");
    expect(res.status).toBe(200);
    const analysis = (res.body as TaskCodeResponse).repos[0].analysis!;
    const hipotesis = analysis.findings.flatMap((f) => f.hypotheses ?? []);
    expect(hipotesis.length, "el fixture tiene que publicar al menos una hipótesis (Strategy)").toBeGreaterThan(0);
    for (const h of hipotesis) {
      expect(["patron", "refactorizacion"], `"${h.pattern}" llegó por HTTP sin capa (${String(h.layer)})`).toContain(h.layer);
    }
    expect(hipotesis.find((h) => h.pattern === "Strategy")?.layer).toBe("patron");
  });
});

describe("P3: paginación por offset/limit", () => {
  async function analyzedRepo(): Promise<CodeInspectorServiceImpl> {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);
    const inspector = await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    await waitForAnalysis("backend");
    return inspector;
  }

  it("offset=1&limit=1 devuelve un grupo distinto de offset=0&limit=1, mismo orden que la página completa", async () => {
    await analyzedRepo();

    const whole = await getCode();
    const findings = whole.repos[0].analysis!.findings;
    expect(findings.length).toBeGreaterThanOrEqual(2);

    const first = await getCodeQs("offset=0&limit=1");
    const second = await getCodeQs("offset=1&limit=1");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = first.body as TaskCodeResponse;
    const secondBody = second.body as TaskCodeResponse;
    const firstFindings = firstBody.repos[0].analysis!.findings;
    const secondFindings = secondBody.repos[0].analysis!.findings;

    expect(firstFindings).toHaveLength(1);
    expect(secondFindings).toHaveLength(1);
    expect(firstFindings[0].id).not.toBe(secondFindings[0].id);
    // Same prefix as the unpaginated ranking, not a re-sorted or re-scored subset.
    expect(firstFindings[0].id).toBe(findings[0].id);
    expect(secondFindings[0].id).toBe(findings[1].id);

    expect(firstBody.repos[0].analysis!.page).toEqual({ offset: 0, limit: 1, hasMore: true });
    expect(secondBody.repos[0].analysis!.page).toEqual({ offset: 1, limit: 1, hasMore: false });
  });

  it("OLA BA — sin query params se sirve TODO lo guardado: ni una fila cortada, `hasMore` false", async () => {
    await analyzedRepo();
    const res = await getCode();
    const analysis = res.repos[0].analysis!;
    expect(analysis.page?.offset).toBe(0);
    // El default ya no es 200: `paginate` reporta como `limit` la cantidad
    // realmente servida cuando el pedido fue "unlimited", así que esto también
    // falla si vuelve a aparecer un corte (limit < findings.length).
    expect(analysis.page?.limit).toBe(analysis.findings.length);
    expect(analysis.page?.hasMore).toBe(false);
    expect(analysis.findings.length).toBe(analysis.groupsTotal);
  });

  it("OLA BA — un `limit` EXPLÍCITO se sigue respetando: quitar el default no rompió el parámetro", async () => {
    await analyzedRepo();
    const res = await getCodeQs("limit=1");
    expect(res.status).toBe(200);
    const analysis = (res.body as TaskCodeResponse).repos[0].analysis!;
    expect(analysis.page?.limit).toBe(1);
    expect(analysis.findings.length).toBe(1);
  });

  it("limit=unlimited devuelve todo lo guardado en una sola página", async () => {
    await analyzedRepo();
    const res = await getCodeQs("limit=unlimited");
    expect(res.status).toBe(200);
    const analysis = (res.body as TaskCodeResponse).repos[0].analysis!;
    expect(analysis.page?.hasMore).toBe(false);
    expect(analysis.findings.length).toBe(analysis.groupsTotal);
  });

  it("paginar no dispara un nuevo análisis: analyzeRepo se llama una sola vez para dos páginas distintas", async () => {
    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");
    await analyzedRepo();
    expect(spy).toHaveBeenCalledTimes(1);

    await getCodeQs("offset=0&limit=1");
    await getCodeQs("offset=1&limit=1");
    expect(spy).toHaveBeenCalledTimes(1); // still 1: both pages come from the same cached ranking

    spy.mockRestore();
  });

  it.each([
    ["offset=-1", "offset"],
    ["offset=1.5", "offset"],
    ["offset=abc", "offset"],
    ["limit=-1", "limit"],
    ["limit=abc", "limit"],
    ["limit=1.5", "limit"],
  ])("400 en castellano para %s (parámetro %s)", async (qs, param) => {
    await analyzedRepo();
    const res = await getCodeQs(qs);
    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toContain(`'${param}'`);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * F2 — descartes (over HTTP, plain non-git dirs like the suite above: a
 * discard is DB-only and does not depend on the git-based persistent cache).
 * ──────────────────────────────────────────────────────────────────────── */

describe("F2: descartar/restaurar un hallazgo", () => {
  it("descarta con motivo, y el motivo sigue apareciendo en una GET posterior", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);

    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    const settled = await waitForAnalysis("backend");
    const finding = settled.repos[0].analysis!.findings.find((f) => f.kind === "duplication")!;
    expect(finding.id).toBeTruthy();
    expect(finding.discarded).toBeUndefined();

    const discardRes = await fetch(
      `${baseUrl}/api/tasks/task-1/code/backend/findings/${encodeURIComponent(finding.id!)}/discard`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "falso positivo, ya lo revisamos" }),
      },
    );
    expect(discardRes.status).toBe(204);

    const after = await getCode();
    const same = after.repos[0].analysis!.findings.find((f) => f.id === finding.id)!;
    expect(same.discarded?.reason).toBe("falso positivo, ya lo revisamos");
  });

  it("rechaza un motivo vacío con 400, sin persistir nada", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);
    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    const settled = await waitForAnalysis("backend");
    const finding = settled.repos[0].analysis!.findings[0];

    const res = await fetch(
      `${baseUrl}/api/tasks/task-1/code/backend/findings/${finding.id}/discard`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "   " }) },
    );
    expect(res.status).toBe(400);

    const after = await getCode();
    expect(after.repos[0].analysis!.findings.find((f) => f.id === finding.id)!.discarded).toBeUndefined();
  });

  it("restaura: el hallazgo vuelve a aparecer sin `discarded`", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);
    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    const settled = await waitForAnalysis("backend");
    const finding = settled.repos[0].analysis!.findings[0];

    await fetch(`${baseUrl}/api/tasks/task-1/code/backend/findings/${finding.id}/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "motivo" }),
    });
    expect(
      (await getCode()).repos[0].analysis!.findings.find((f) => f.id === finding.id)!.discarded,
    ).toBeTruthy();

    const restoreRes = await fetch(
      `${baseUrl}/api/tasks/task-1/code/backend/findings/${finding.id}/restore`,
      { method: "POST" },
    );
    expect(restoreRes.status).toBe(204);
    expect(
      (await getCode()).repos[0].analysis!.findings.find((f) => f.id === finding.id)!.discarded,
    ).toBeUndefined();
  });

  it("sobrevive a una re-análisis: el id es estable, sin números de línea", async () => {
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    const file = path.join(repoDir, "pricing.js");
    fs.writeFileSync(file, DUPLICATED_SOURCE);
    await startServer(fakeRepos([taskRepo("tr-1", "backend", repoDir)]));
    const settled = await waitForAnalysis("backend");
    const dup = settled.repos[0].analysis!.findings.find((f) => f.kind === "duplication")!;

    await fetch(`${baseUrl}/api/tasks/task-1/code/backend/findings/${dup.id}/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "motivo" }),
    });

    // A trailing comment shifts every line number below it but leaves the
    // duplicated functions' names/anchors untouched — this is exactly the
    // "editing the file does not mint a new discard" guarantee (CONTRATOS.md §1.4).
    fs.writeFileSync(file, `${DUPLICATED_SOURCE}\n// comentario agregado\n`);
    await getCode(); // kicks off the background re-analysis for the new signature
    const after = await waitForAnalysis("backend");
    const dupAfter = after.repos[0].analysis!.findings.find((f) => f.kind === "duplication")!;
    expect(dupAfter.id).toBe(dup.id);
    expect(dupAfter.discarded?.reason).toBe("motivo");
  });

  it("404 para una tarea desconocida", async () => {
    await startServer(fakeRepos([]));
    const res = await fetch(`${baseUrl}/api/tasks/nope/code/backend/findings/x/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "motivo" }),
    });
    expect(res.status).toBe(404);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * F2 — caché persistente por hash de contenido, sobre repos GIT reales:
 * `gitContentSignature` (code-content-signature.ts) necesita `git`, así que
 * a diferencia del resto de este archivo estos casos SÍ inicializan un repo
 * de verdad. Todas estas pruebas van DIRECTO al inspector (sin `startServer`)
 * porque lo que importa es si `analyzeRepo` se vuelve a llamar entre
 * instancias, no el transporte HTTP — ya cubierto arriba.
 * ──────────────────────────────────────────────────────────────────────── */

describe("F2: caché persistente por hash de contenido", () => {
  function gitRepoWithFile(dir: string, filename: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }

  async function waitDirect(
    inspector: CodeInspectorServiceImpl,
    taskId = "task-1",
  ): Promise<TaskCodeResponse> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await inspector.forTask(taskId);
      if (res.repos.every((r) => r.analyzing !== true)) return res;
      if (Date.now() > deadline) throw new Error("el análisis no terminó a tiempo");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("una instancia NUEVA con la MISMA sqlite (simula un reinicio) no vuelve a llamar a analyzeRepo para el mismo commit", async () => {
    const repoDir = path.join(tmpDir, "backend");
    gitRepoWithFile(repoDir, "pricing.js", DUPLICATED_SOURCE);
    const repos = fakeRepos([taskRepo("tr-1", "backend", repoDir)]);
    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");

    const first = await waitDirect(new CodeInspectorServiceImpl(repos, db));
    expect(first.repos[0].analysis!.findings.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(1);

    // Fresh RAM tier (new Maps), same sqlite handle — from this module's
    // point of view, indistinguishable from a systemd restart.
    const second = await waitDirect(new CodeInspectorServiceImpl(repos, db));
    expect(spy).toHaveBeenCalledTimes(1); // NOT called again
    expect(second.repos[0].analysis).toEqual(first.repos[0].analysis);

    spy.mockRestore();
  });

  it("un worktree DISTINTO del mismo repo (mismo projectRepoId) reusa las facts sin volver a analizar", async () => {
    const repoDirA = path.join(tmpDir, "worktree-a");
    gitRepoWithFile(repoDirA, "pricing.js", DUPLICATED_SOURCE);
    const repoDirB = path.join(tmpDir, "worktree-b");
    execFileSync("git", ["clone", "-q", repoDirA, repoDirB]);

    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");

    // Same "tr-1" id ⇒ same `projectRepoId` (`taskRepo`'s `pr-${id}`) ⇒ same
    // `repoKey` — a different physical worktree of what claude-kanban
    // considers the SAME repository, exactly like a branch-off-main task.
    const resultA = await waitDirect(
      new CodeInspectorServiceImpl(fakeRepos([taskRepo("tr-1", "backend", repoDirA)]), db),
    );
    expect(spy).toHaveBeenCalledTimes(1);

    const resultB = await waitDirect(
      new CodeInspectorServiceImpl(fakeRepos([taskRepo("tr-1", "backend", repoDirB)]), db),
    );
    expect(spy).toHaveBeenCalledTimes(1); // still 1: served from the persistent cache
    expect(resultB.repos[0].analysis).toEqual(resultA.repos[0].analysis);

    spy.mockRestore();
  });

  it("cambiar un archivo invalida el snapshot: analyzeRepo se vuelve a llamar y el resultado nuevo se refleja", async () => {
    const repoDir = path.join(tmpDir, "backend");
    gitRepoWithFile(repoDir, "pricing.js", DUPLICATED_SOURCE);
    const repos = fakeRepos([taskRepo("tr-1", "backend", repoDir)]);
    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");

    await waitDirect(new CodeInspectorServiceImpl(repos, db));
    expect(spy).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(repoDir, "pricing.js"), WITH_THIRD_CLONE);

    const after = await waitDirect(new CodeInspectorServiceImpl(repos, db));
    expect(spy).toHaveBeenCalledTimes(2);
    const dup = after.repos[0].analysis!.findings.find((f) => f.kind === "duplication");
    expect(dup?.locations.length).toBe(3);

    spy.mockRestore();
  });

  it("un worktree que no es git checkout degrada a 'sin caché persistente', nunca a un análisis fallido", async () => {
    // Exactamente los directorios "planos" que usa el resto de este archivo:
    // `gitContentSignature` tira, `analyzeWithPersistentCache` lo atrapa y
    // sigue con `analyzeRepo` sin caché — cubierto indirectamente por todo
    // el describe de arriba, y aquí de forma explícita.
    const repoDir = path.join(tmpDir, "backend");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pricing.js"), DUPLICATED_SOURCE);
    const repos = fakeRepos([taskRepo("tr-1", "backend", repoDir)]);

    const result = await waitDirect(new CodeInspectorServiceImpl(repos, db));
    expect(result.repos[0].error).toBeUndefined();
    expect(result.repos[0].analysis!.findings.length).toBeGreaterThan(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * OLA BB, FRENTE BB1 — EL ESLABÓN QUE FALTABA: EL SNAPSHOT PERSISTIDO.
 *
 * Los dos tests que la Ola BA escribió para "la capa llega al cliente" paran
 * UN ESLABÓN antes del punto donde el dato muere en la máquina del usuario:
 *
 *   · `hypotheses/layer.test.ts` mide sobre `analyzeRepo`, que es el ANÁLISIS,
 *     no lo SERVIDO.
 *   · el describe "OLA BA" de más arriba sí usa la ruta HTTP, pero su fixture
 *     es un `fs.mkdtempSync` que NO es un repo git: `gitContentSignature`
 *     tira, `contentSig` queda `null` y la rama del snapshot persistido
 *     (`code-inspector.ts#analyzeWithPersistentCache`) NO SE EJECUTA NUNCA.
 *
 * Y ése es justo el camino que el panel usa casi siempre: al cerrar la Ola BA
 * había 262 filas de snapshot en `data/claude-kanban.db`, las 262 con
 * hipótesis y NINGUNA con `layer`, servidas varias veces por día. La UI nueva
 * filtra por igualdad estricta (`h.layer === capa`), así que servía CERO
 * recomendaciones.
 *
 * Estos casos cierran el eslabón: ruta HTTP real + repo GIT de verdad + DOS
 * corridas contra la MISMA sqlite. La segunda es la que pega en el snapshot;
 * sin ella el test no prueba nada.
 * ──────────────────────────────────────────────────────────────────────── */

describe("OLA BB: la capa sobrevive al snapshot persistido (ruta HTTP + repo git + 2 corridas)", () => {
  function gitRepoWithFile(dir: string, filename: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }

  /** Cierra el server de la corrida anterior y levanta uno NUEVO sobre la MISMA `db`. */
  async function relevantar(repos: Repositories): Promise<void> {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await startServer(repos, db);
  }

  const hipotesisServidas = (body: TaskCodeResponse) =>
    body.repos[0].analysis!.findings.flatMap((f) => f.hypotheses ?? []);

  /** Filas de snapshot de repo (`file_path = ''`) que hay ahora mismo en la sqlite. */
  const filasSnapshot = () =>
    db
      .prepare(`SELECT findings_json, facts_schema_version FROM code_file_facts WHERE file_path = ''`)
      .all() as { findings_json: string; facts_schema_version: number | null }[];

  it("la segunda corrida SE SIRVE del snapshot (no re-analiza) y ese snapshot trae la capa", async () => {
    const repoDir = path.join(tmpDir, "backend");
    gitRepoWithFile(repoDir, "classify.js", CHAIN_SOURCE);
    const repos = fakeRepos([taskRepo("tr-1", "backend", repoDir)]);
    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");

    await startServer(repos, db);
    const primera = await waitForAnalysis("backend");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(hipotesisServidas(primera).length).toBeGreaterThan(0);

    // El snapshot QUEDÓ escrito, con la capa adentro y estampado con su
    // versión de esquema: sin las dos cosas, la segunda corrida no prueba nada.
    const filas = filasSnapshot();
    expect(filas.length, "la primera corrida tiene que dejar UNA fila de snapshot").toBe(1);
    expect(filas[0].facts_schema_version, "el snapshot se estampa con su facts_schema_version").not.toBeNull();

    // Proceso/RAM nuevos, MISMA sqlite: indistinguible de un reinicio del
    // servicio, que es como el panel del usuario llega a este camino.
    await relevantar(repos);
    const segunda = await waitForAnalysis("backend");
    expect(spy, "la segunda corrida tiene que ACERTAR el snapshot, no re-analizar").toHaveBeenCalledTimes(1);

    const hipotesis = hipotesisServidas(segunda);
    expect(hipotesis.length, "el snapshot servido tiene que traer hipótesis").toBeGreaterThan(0);
    for (const h of hipotesis) {
      expect(["patron", "refactorizacion"], `"${h.pattern}" salió del SNAPSHOT sin capa (${String(h.layer)})`).toContain(
        h.layer,
      );
    }

    spy.mockRestore();
  });

  it("un snapshot escrito por el código PRE-BB (sin capa, sin facts_schema_version) NUNCA se sirve", async () => {
    const repoDir = path.join(tmpDir, "backend");
    gitRepoWithFile(repoDir, "classify.js", CHAIN_SOURCE);
    const repos = fakeRepos([taskRepo("tr-1", "backend", repoDir)]);
    const spy = vi.spyOn(codeAnalyzer, "analyzeRepo");

    await startServer(repos, db);
    await waitForAnalysis("backend");
    expect(spy).toHaveBeenCalledTimes(1);

    // Se degrada la fila recién escrita a la forma EXACTA de las 262 que
    // había en el disco del usuario: mismas hipótesis, `layer` borrado, y
    // `facts_schema_version` en NULL (el `putRepoSnapshot` pre-BB no escribía
    // esa columna). No se toca nada más: misma PK, misma firma de contenido.
    const fila = db
      .prepare(`SELECT rowid AS rid, findings_json FROM code_file_facts WHERE file_path = ''`)
      .get() as { rid: number; findings_json: string };
    const analisis = JSON.parse(fila.findings_json) as { findings: { hypotheses?: unknown[] }[] };
    let borradas = 0;
    for (const f of analisis.findings) {
      for (const h of f.hypotheses ?? []) {
        delete (h as { layer?: unknown }).layer;
        borradas += 1;
      }
    }
    expect(borradas, "el fixture tiene que traer hipótesis para poder degradarlas").toBeGreaterThan(0);
    db.prepare(`UPDATE code_file_facts SET findings_json = ?, facts_schema_version = NULL WHERE rowid = ?`).run(
      JSON.stringify(analisis),
      fila.rid,
    );
    expect(filasSnapshot()[0].findings_json.includes('"layer"')).toBe(false);

    // Segunda corrida, proceso nuevo, misma sqlite: es EXACTAMENTE lo que
    // pasa cuando el usuario abre el panel con la base que ya tiene.
    await relevantar(repos);
    const servido = await waitForAnalysis("backend");

    // La aserción que importa va PRIMERO: lo que el panel RECIBE. La del spy
    // viene después, y es el mecanismo (por qué lo recibe bien).
    const hipotesis = hipotesisServidas(servido);
    expect(hipotesis.length).toBeGreaterThan(0);
    for (const h of hipotesis) {
      expect(
        ["patron", "refactorizacion"],
        `"${h.pattern}" llegó al panel SIN CAPA: se sirvió un snapshot pre-BB`,
      ).toContain(h.layer);
    }
    expect(spy, "la fila de esquema viejo tiene que ser un MISS y forzar un re-análisis").toHaveBeenCalledTimes(2);

    // Y la fila degradada quedó PISADA en su lugar, no duplicada.
    const finales = filasSnapshot();
    expect(finales.length).toBe(1);
    expect(finales[0].facts_schema_version).not.toBeNull();
    expect(finales[0].findings_json.includes('"layer"')).toBe(true);

    spy.mockRestore();
  });
});
