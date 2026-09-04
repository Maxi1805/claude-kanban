/**
 * CodeInspectorService implementation — exposes {@link analyzeRepo} per task,
 * with the same caching + background-job shape as SchemaInspectorService.
 *
 * Analysing a repo means parsing every source file with tree-sitter, which
 * on a real Rails-sized codebase costs seconds, not milliseconds. Doing that
 * inline on every GET (the tab is polled) would make the panel feel frozen,
 * so the flow mirrors the schema view:
 *
 *   1. `worktreeSignature` (path+size+mtime of every analysable file) is
 *      cheap — a few file stats — and stands in for "did anything change
 *      SINCE THE LAST TIME THIS PROCESS LOOKED". If it matches the RAM
 *      `cache`, the cached CodeAnalysis is returned as-is: no I/O at all.
 *   2. Otherwise (first look in this process, or an mtime moved) a
 *      background job is kicked off and the response says `analyzing: true`
 *      immediately. The caller polls until the job lands in the cache.
 *   3. Inside that job — F2 (PLAN.md §F2) — BEFORE paying for a real
 *      `analyzeRepo`, the worktree's CONTENT (not mtime: see
 *      `code-content-signature.ts`) is checked against
 *      `code_file_facts` in sqlite. A hit there — the same commit analysed
 *      before, from THIS worktree or any other worktree of the same repo,
 *      possibly in a PREVIOUS process — serves the stored result straight
 *      from disk. Only a genuine miss calls `analyzeRepo`.
 *
 * Per-repo failures — an unreadable worktree, a parse blow-up — are reported
 * in that repo's `error` field, never thrown: one broken repo never blanks
 * the tab for the others in the same task.
 *
 * Discards (F2, `code_finding_decisions`) are applied as the LAST step
 * before a result leaves this module, read fresh from sqlite on every
 * request — so clicking "Descartar" never has to invalidate or re-run
 * anything cached above.
 *
 * OLA BC, FRENTE BC1 — QUÉ QUEDÓ ACÁ Y QUÉ SE FUE. Este archivo es ahora SÓLO
 * el traductor entre el tablero y el motor. Lo que sabe de tareas:
 * `forTask`/`discardCodeFinding`/`restoreCodeFinding` (los tres métodos
 * públicos del panel, intactos en firma y en resultado), `resolveRepoKey`, el
 * caché en RAM por worktree con su `analyzing: true` —la forma que necesita un
 * panel que hace poll— y la paginación de servido.
 *
 * Todo lo que NO sabía de tareas se mudó, tal cual, a
 * `engine/repo-analysis.ts`: el caché persistente sqlite de dos niveles, la
 * construcción incremental del grafo, el GC, los ids estables. Este archivo ya
 * no importa ni un repositorio de base de datos; le pide al motor por
 * `(dir, repoName, repoKey)` y el motor no sabe que existe un tablero. Ver el
 * docstring de `engine/index.ts` para cómo arranca un consumidor que no es el
 * panel (el MCP).
 */
import fs from "node:fs/promises";

import { worktreeSignature } from "./code-analyzer.js";
import { RepoAnalysisEngine, type CodeFindingDecision } from "./engine/repo-analysis.js";
import type { DB } from "../db/index.js";
import type { CodePageRequest, Repositories } from "../../shared/interfaces.js";
import type { CodeAnalysis, TaskCodeRepo, TaskCodeResponse } from "../../shared/types.js";

/** Raised for an unknown task or repo (the router maps it to a 404). */
export class CodeInspectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeInspectorError";
  }
}

/** The last analysis landed for a worktree, plus the signature it was run at. */
interface CacheEntry {
  signature: string;
  /** Findings already carry their stable `id` — decisions are folded in per-request. */
  analysis: CodeAnalysis;
}

/**
 * OLA BE — EL REPO QUE SE ESTÁ ANALIZANDO. `repoName`, `worktreePath` y
 * `repoKey` viajaban como tres `string` sueltos y consecutivos: `forTask` se
 * los pasa a `inspectRepo`, `inspectRepo` se los pasa tal cual a `runAnalysis`
 * y `runAnalysis` se los pasa al motor, que YA los recibe como un objeto
 * (`engine.analyze({ dir, repoName, repoKey })`). Es un concepto con nombre y
 * un solo dueño, así que acá también viaja junto.
 *
 * Es interno a propósito: los tres métodos públicos —`forTask`,
 * `discardCodeFinding`, `restoreCodeFinding`— son la costura con el router HTTP
 * y con el panel, y no cambian de firma.
 */
interface AnalyzedRepo {
  /** Nombre visible, el que ve el panel. */
  repoName: string;
  /** Worktree de la tarea donde se parsea el código. */
  worktreePath: string;
  /** Clave estable del repo: la que indexa el caché persistente y los descartes. */
  repoKey: string;
}

/** An analysis running (or just finished) for one worktree. */
interface AnalysisJob {
  /** Signature the job was started for — a later signature makes it stale. */
  signature: string;
  done: boolean;
  error?: string;
}

export class CodeInspectorServiceImpl {
  /** Last good analysis per worktree path, keyed by the signature it matches — L1, RAM, per process. */
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight (or last-finished) job per worktree path. */
  private readonly jobs = new Map<string, AnalysisJob>();
  /**
   * OLA BC — L2 y todo lo demás. El motor: caché persistente sqlite, grafo
   * incremental, GC, descartes. Una instancia por inspector, así que sus dos
   * cachés en RAM (`graphBuildCache`/`intraGraphCache`) tienen exactamente la
   * misma vida que cuando eran campos de esta clase.
   */
  private readonly engine: RepoAnalysisEngine;

  constructor(
    private readonly repos: Repositories,
    db: DB,
  ) {
    this.engine = new RepoAnalysisEngine(db);
  }

  /**
   * P3 — `page` (offset/limit over the GROUP ranking) applies the SAME to
   * every repo of the task: one GET, one page number, matching the panel's
   * single toolbar (there is no per-repo pagination UI, and every repo's
   * analysis is cached "unlimited" internally anyway — see `inspectRepo`).
   */
  async forTask(taskId: string, page?: CodePageRequest): Promise<TaskCodeResponse> {
    const task = this.repos.tasks.getById(taskId, { withRepos: true });
    if (!task) throw new CodeInspectorError(`Unknown task: ${taskId}`);

    const repos = await Promise.all(
      (task.repos ?? []).map((tr) =>
        this.inspectRepo(
          { repoName: tr.repoName, worktreePath: tr.worktreePath, repoKey: tr.projectRepoId },
          page,
        ),
      ),
    );
    return { taskId, repos };
  }

  /** F2: discard a finding with a reason. Persists by (repo, stable id). */
  async discardCodeFinding(
    taskId: string,
    repoName: string,
    findingId: string,
    reason: string,
  ): Promise<void> {
    const trimmed = reason.trim();
    if (!trimmed) throw new CodeInspectorError("El motivo del descarte no puede estar vacío.");
    const repoKey = this.resolveRepoKey(taskId, repoName);
    this.engine.discard(repoKey, findingId, trimmed);
  }

  /** F2: undo a discard. A no-op if it was not discarded. */
  async restoreCodeFinding(taskId: string, repoName: string, findingId: string): Promise<void> {
    const repoKey = this.resolveRepoKey(taskId, repoName);
    this.engine.restore(repoKey, findingId);
  }

  /* ── Internals ────────────────────────────────────────────────────── */

  private resolveRepoKey(taskId: string, repoName: string): string {
    const task = this.repos.tasks.getById(taskId, { withRepos: true });
    if (!task) throw new CodeInspectorError(`Unknown task: ${taskId}`);
    const taskRepo = (task.repos ?? []).find((r) => r.repoName === repoName);
    if (!taskRepo) throw new CodeInspectorError(`La tarea no tiene un repo llamado ${repoName}.`);
    return taskRepo.projectRepoId;
  }

  private async inspectRepo(repo: AnalyzedRepo, page?: CodePageRequest): Promise<TaskCodeRepo> {
    const { repoName, worktreePath, repoKey } = repo;
    const result: TaskCodeRepo = { repoName, worktreePath, analysis: null };

    // Belt-and-suspenders: cualquier rechazo de acá aterriza como el `error` de
    // ESTE repo, nunca como un request fallado que blanquea la pestaña entera.
    let signature: string;
    try {
      signature = await currentSignature(worktreePath);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    const cached = this.cache.get(worktreePath);
    if (cached && cached.signature === signature) {
      const { offset, limit } = resolvePage(page);
      result.analysis = this.withDecisions(repoKey, paginate(cached.analysis, offset, limit));
      return result;
    }

    const job = this.jobs.get(worktreePath);
    if (job && job.signature === signature) {
      if (!job.done) {
        result.analyzing = true;
        return result;
      }
      // Done but never made it into the cache: the analysis itself failed.
      if (job.error) {
        result.error = job.error;
        return result;
      }
    }

    // First look at this signature, or the previous job was for a stale one
    // (the worktree moved on again while it ran). Either way, start fresh.
    const freshJob: AnalysisJob = { signature, done: false };
    this.jobs.set(worktreePath, freshJob);
    void this.runAnalysis(freshJob, repo, signature);

    result.analyzing = true;
    return result;
  }

  /** The background half of {@link inspectRepo}; never rejects. */
  private async runAnalysis(
    job: AnalysisJob,
    repo: AnalyzedRepo,
    signature: string,
  ): Promise<void> {
    try {
      const analysis = await this.engine.analyze({
        dir: repo.worktreePath,
        repoName: repo.repoName,
        repoKey: repo.repoKey,
      });
      this.cache.set(repo.worktreePath, { signature, analysis });
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.done = true;
    }
  }

  /** Folds current discards into a result — read fresh every call, never baked into what is cached. */
  private withDecisions(repoKey: string, analysis: CodeAnalysis): CodeAnalysis {
    const decisions = this.engine.decisionsFor(repoKey);
    if (decisions.size === 0) return analysis;
    return {
      ...analysis,
      findings: analysis.findings.map((f) => decorate(f, decisions)),
    };
  }
}

/**
 * La firma del worktree AHORA — lo que decide si el análisis cacheado sigue
 * sirviendo.
 *
 * `worktreeSignature`/`analyzeRepo` recorren el árbol PERMISIVAMENTE: un
 * directorio que falta o no se puede leer se saltea en vez de fallar, porque un
 * repo normal tiene subárboles vendorizados que tampoco puede ver del todo. Eso
 * está bien para un subárbol y MAL para la raíz del worktree: una raíz que ya no
 * está (un teardown que corrió justo durante un poll, una ruta mala) se leería
 * en silencio como "un repo vacío, nada para reportar" en vez de como el fallo
 * que es. Por eso se chequea explícitamente acá, y falla.
 */
async function currentSignature(worktreePath: string): Promise<string> {
  const stat = await fs.stat(worktreePath);
  if (!stat.isDirectory()) {
    throw new Error(`${worktreePath} no es un directorio.`);
  }
  return await worktreeSignature(worktreePath);
}

function decorate<T extends { id?: string; discarded?: { reason: string; decidedAt: string } }>(
  item: T,
  decisions: Map<string, CodeFindingDecision>,
): T {
  const d = item.id ? decisions.get(item.id) : undefined;
  return d ? { ...item, discarded: { reason: d.reason, decidedAt: d.decidedAt } } : item;
}

/**
 * P3 — fills in the two page params a caller may omit: absent `offset` ⇒ 0
 * (page 1).
 *
 * OLA BA, FRENTE BA1 — EL DEFAULT DE `limit` DEJA DE CORTAR: absent `limit` ⇒
 * `"unlimited"`, no los 200 de `DEFAULT_ANALYZE_LIMITS.maxFindings`. Lo pidió
 * el usuario con el síntoma exacto: *"no todos los datos se cargan al mismo
 * tiempo, lo que genera que no pueda ver todas las recomendaciones"*. Había un
 * botón opt-in en el panel que pedía `limit=unlimited`, pero se reseteaba al
 * cambiar de repo, así que por default NUNCA se veía el total.
 *
 * POR QUÉ ESTO NO CUESTA ANÁLISIS: el corte de acá es de SERVIDO, no de
 * detección — `paginate` (abajo) rebana `analysis.findings`, que ya está
 * completo en memoria (el análisis SIEMPRE corre `UNLIMITED_STORAGE_LIMITS`,
 * ver el docstring del módulo). Dejar de rebanar no agrega ni un milisegundo de
 * análisis; mueve el costo entero al render del cliente.
 *
 * EL PARÁMETRO SIGUE VIVO Y SE SIGUE RESPETANDO: un caller que pide
 * `?limit=200` recibe 200. Lo único que cambió es qué pasa cuando NO pide nada.
 * `DEFAULT_ANALYZE_LIMITS` sigue siendo el default de ANÁLISIS para los callers
 * de `analyzeRepo` que no pasan `limits` — otro eje, intacto.
 */
function resolvePage(page: CodePageRequest | undefined): { offset: number; limit: number | "unlimited" } {
  // Defensive clamp, not a substitute for `code.ts`'s own 400 on garbage
  // input: a negative offset would otherwise hit `Array.prototype.slice`'s
  // "count from the end" behaviour below, silently returning the WRONG page
  // instead of the requested one.
  const rawOffset = page?.offset ?? 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const rawLimit = page?.limit ?? "unlimited";
  const limit = rawLimit === "unlimited" || (Number.isFinite(rawLimit) && rawLimit >= 0) ? rawLimit : "unlimited";
  return { offset, limit };
}

/**
 * P3 — slices the FULL cached ranking (`analysis.findings`, always fetched
 * "unlimited" up to `MAX_STORED_FINDINGS` — ver `UNLIMITED_STORAGE_LIMITS` en `engine/repo-analysis.ts`)
 * down to the page this request asked for. Mirrors the arithmetic
 * `crossAnalyze` (`code-analyzer.ts`) uses for its own `page`/`hasMore`, with
 * ONE deliberate difference: `hasMore` here is measured against what is
 * actually IN `analysis.findings` (the real, servable ceiling —
 * `MAX_STORED_FINDINGS` when `truncated`), not against `groupsTotal` (the
 * true, possibly-larger, pre-storage-ceiling count). That is the "techo
 * honesto" this task calls for: past the stored ceiling, `hasMore` says
 * `false` — no more CAN be served — instead of `true` forever, which would
 * have the panel keep offering a "next page" that always comes back empty.
 * `groupsTotal`/`totalByKind`/`findingsTotal`/`truncated` are untouched
 * (spread through as-is): they still describe the true, pre-cap population,
 * same contract as `CodeAnalysis`'s docstring in `shared/types.ts`.
 */
function paginate(analysis: CodeAnalysis, offset: number, limit: number | "unlimited"): CodeAnalysis {
  const stored = analysis.findings;
  const findings = limit === "unlimited" ? stored.slice(offset) : stored.slice(offset, offset + limit);
  const hasMore = offset + findings.length < stored.length;
  return {
    ...analysis,
    findings,
    page: { offset, limit: limit === "unlimited" ? findings.length : limit, hasMore },
  };
}

/** Factory used by the server bootstrap. */
export const createCodeInspector = (repos: Repositories, db: DB): CodeInspectorServiceImpl =>
  new CodeInspectorServiceImpl(repos, db);
