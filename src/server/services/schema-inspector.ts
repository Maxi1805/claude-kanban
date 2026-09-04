/**
 * SchemaInspectorService implementation — runs each repo's generated extractor
 * and diffs the result against the branch the task was based on.
 *
 * There is no built-in parser: what a repo's schema looks like is decided by the
 * extractor script an agent wrote for it (see schema-script.ts). This module
 * only orchestrates — locate the script, run it in the task's worktree, run the
 * SAME script against the base branch, and compare.
 *
 * The base-branch side is the subtle part. The script reads files, so comparing
 * requires those files as they exist on the base branch: a detached worktree is
 * checked out in a temp dir, the script runs there, and the result is cached by
 * the base commit sha — so the checkout happens once per base commit, not once
 * per poll.
 *
 * Per-repo failures are reported inside the response; one broken repo never
 * blanks the view for the others.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  SchemaChange,
  SchemaDiff,
  SchemaEntity,
  SchemaGraph,
  SchemaRelation,
  SchemaScriptInfo,
  TaskSchemaRepo,
  TaskSchemaResponse,
} from "../../shared/types.js";
import type {
  Repositories,
  SchemaInspectorService,
} from "../../shared/interfaces.js";
import {
  SchemaScriptError,
  deleteScript,
  generateScript,
  readMeta,
  runScript,
  saveScript,
  scriptExists,
  scriptPathFor,
  toGraph,
} from "./schema-script.js";

const execFileAsync = promisify(execFile);

export interface SchemaInspectorOptions {
  /** Board data dir holding `schema-scripts/`. */
  dataDir: string;
  /** Command used to spawn the generating agent. */
  agentCommand: string;
}

/** Raised for an unknown task or repo (the router maps it to a 404). */
export class SchemaInspectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaInspectorError";
  }
}

/**
 * OLA BE — EL REPO QUE SE ESTÁ INSPECCIONANDO. Su clave en el proyecto, su
 * nombre y dónde está su worktree en disco viajaban como tres `string` sueltos
 * y CONSECUTIVOS por cuatro firmas de esta clase (`inspectRepo`,
 * `runGeneration`, `diffAgainstBase`, `baseGraph`), que además se los pasaban
 * entre sí: tres oportunidades de cruzar dos strings sin que el compilador
 * dijera nada. Es un concepto con nombre, no tres datos que casualmente son
 * texto — de hecho `TaskRepo` ya trae los tres campos así, y por eso `forTask`
 * puede pasar su fila tal cual.
 */
export interface InspectedRepo {
  /** Clave estable del repo dentro del proyecto (dueña del script y del caché). */
  projectRepoId: string;
  /** Nombre visible, el que ve el panel. */
  repoName: string;
  /** Worktree de la tarea donde corre el extractor. */
  worktreePath: string;
}

/** A generation running (or recently finished) for one repo. */
interface GenerationJob {
  startedAt: string;
  done: boolean;
  error?: string;
}

export class SchemaInspectorServiceImpl implements SchemaInspectorService {
  /** Base-branch graphs keyed by `<projectRepoId>:<baseBranch>`. */
  private readonly baseCache = new Map<string, { sha: string; graph: SchemaGraph }>();
  /** Generation jobs by project repo, so two clicks never race and the UI can watch. */
  private readonly jobs = new Map<string, GenerationJob>();

  constructor(
    private readonly repos: Repositories,
    private readonly options: SchemaInspectorOptions,
  ) {}

  async forTask(taskId: string): Promise<TaskSchemaResponse> {
    const task = this.repos.tasks.getById(taskId, { withRepos: true });
    if (!task) throw new SchemaInspectorError(`Unknown task: ${taskId}`);

    const repos = await Promise.all(
      (task.repos ?? []).map((tr) => this.inspectRepo(tr)),
    );
    return { taskId, repos };
  }

  async generateForRepo(taskId: string, repoName: string): Promise<TaskSchemaRepo> {
    const task = this.repos.tasks.getById(taskId, { withRepos: true });
    if (!task) throw new SchemaInspectorError(`Unknown task: ${taskId}`);
    const taskRepo = (task.repos ?? []).find((r) => r.repoName === repoName);
    if (!taskRepo) {
      throw new SchemaInspectorError(`La tarea no tiene un repo llamado ${repoName}.`);
    }

    const { projectRepoId } = taskRepo;
    const running = this.jobs.get(projectRepoId);
    if (running && !running.done) {
      throw new SchemaInspectorError(
        "Ya hay una generación en curso para este repo.",
      );
    }

    // Started in the BACKGROUND: an agent reading a whole codebase routinely
    // takes many minutes, and holding an HTTP request open that long is what
    // made this fail before. The caller gets the state immediately and watches
    // `script.generating` until it clears.
    const job: GenerationJob = { startedAt: new Date().toISOString(), done: false };
    this.jobs.set(projectRepoId, job);
    void this.runGeneration(job, taskRepo);

    return await this.inspectRepo(taskRepo);
  }

  /** The background half of {@link generateForRepo}; never rejects. */
  private async runGeneration(
    job: GenerationJob,
    repo: InspectedRepo,
  ): Promise<void> {
    const { projectRepoId, repoName, worktreePath } = repo;
    try {
      const { script } = await generateScript({
        cwd: worktreePath,
        repoName,
        agentCommand: this.options.agentCommand,
      });

      // Validate before adopting: a script that does not produce the contract
      // is worse than none, so it is trialled from a temp location and only
      // saved once it actually runs. A failure here leaves the previous
      // extractor untouched.
      const trial = await this.trialRun(script, worktreePath);

      await saveScript({
        dataDir: this.options.dataDir,
        projectRepoId,
        script,
        summary: `${trial.entities.length} tablas, ${trial.relations.length} relaciones (${trial.dialect})`,
        now: new Date().toISOString(),
      });

      // The cached base-branch graph came from the previous script.
      this.invalidateBase(projectRepoId);
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.done = true;
    }
  }

  async deleteForRepo(taskId: string, repoName: string): Promise<void> {
    const task = this.repos.tasks.getById(taskId, { withRepos: true });
    const taskRepo = (task?.repos ?? []).find((r) => r.repoName === repoName);
    if (!taskRepo) throw new SchemaInspectorError(`Repo desconocido: ${repoName}.`);
    await deleteScript(this.options.dataDir, taskRepo.projectRepoId);
    this.invalidateBase(taskRepo.projectRepoId);
  }

  /* ── Internals ────────────────────────────────────────────────────── */

  /** Run a candidate script from a temp file, without adopting it. */
  private async trialRun(script: string, cwd: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ck-schema-trial-"));
    const file = path.join(dir, "extract.sh");
    try {
      await fs.writeFile(file, script, { mode: 0o755 });
      return await runScript(file, cwd);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async inspectRepo(repo: InspectedRepo): Promise<TaskSchemaRepo> {
    const { repoName, worktreePath, projectRepoId } = repo;
    const script = await this.scriptInfo(projectRepoId);
    const result: TaskSchemaRepo = { repoName, worktreePath, script, graph: null };
    if (!script.exists) return result;

    try {
      const extracted = await runScript(script.path, worktreePath);
      result.graph = toGraph(repoName, extracted);
      if (extracted.warnings.length > 0) result.warnings = extracted.warnings;
    } catch (err) {
      result.error =
        err instanceof SchemaScriptError || err instanceof Error
          ? err.message
          : String(err);
      return result;
    }

    result.diff = await this.diffAgainstBase(repo, script.path, result.graph);
    return result;
  }

  private async scriptInfo(projectRepoId: string): Promise<SchemaScriptInfo> {
    const info: SchemaScriptInfo = {
      path: scriptPathFor(this.options.dataDir, projectRepoId),
      exists: await scriptExists(this.options.dataDir, projectRepoId),
    };
    const meta = await readMeta(this.options.dataDir, projectRepoId);
    if (meta) {
      info.generatedAt = meta.generatedAt;
      info.summary = meta.summary;
    }
    const job = this.jobs.get(projectRepoId);
    if (job) {
      if (!job.done) {
        info.generating = true;
        info.generatingSince = job.startedAt;
      } else if (job.error) {
        info.lastError = job.error;
      }
    }
    return info;
  }

  /**
   * Compare against the repo's base branch. Any failure degrades to "no diff
   * available" with a reason — the current schema is still worth showing.
   */
  private async diffAgainstBase(
    repo: InspectedRepo,
    scriptPath: string,
    current: SchemaGraph,
  ): Promise<SchemaDiff> {
    const unavailable = (reason: string): SchemaDiff => ({
      baseBranch: null,
      unavailableReason: reason,
      entities: {},
      fields: {},
      relations: {},
    });

    const baseBranch = this.repos.projectRepos.getById(repo.projectRepoId)?.baseBranch;
    if (!baseBranch) return unavailable("El repo no tiene rama base registrada.");

    try {
      const baseGraph = await this.baseGraph(repo, scriptPath, baseBranch);
      return { baseBranch, ...diffGraphs(baseGraph, current) };
    } catch (err) {
      return unavailable(
        `No se pudo leer ${baseBranch}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The base branch's graph, cached by its commit sha. On a miss the base
   * commit is checked out into a throwaway detached worktree and the same
   * extractor runs there — the only way to know what the schema looked like
   * before, given the script reads files.
   */
  private async baseGraph(
    repo: InspectedRepo,
    scriptPath: string,
    baseBranch: string,
  ): Promise<SchemaGraph> {
    const { projectRepoId, repoName, worktreePath } = repo;
    const sha = (
      await execFileAsync("git", ["rev-parse", baseBranch], { cwd: worktreePath })
    ).stdout.trim();

    const key = `${projectRepoId}:${baseBranch}`;
    const cached = this.baseCache.get(key);
    if (cached?.sha === sha) return cached.graph;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ck-schema-base-"));
    const checkout = path.join(dir, "wt");
    try {
      await execFileAsync(
        "git",
        ["worktree", "add", "--detach", "--force", checkout, sha],
        { cwd: worktreePath, timeout: 120_000 },
      );
      const graph = toGraph(repoName, await runScript(scriptPath, checkout));
      this.baseCache.set(key, { sha, graph });
      return graph;
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", checkout], {
        cwd: worktreePath,
      }).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private invalidateBase(projectRepoId: string): void {
    for (const key of this.baseCache.keys()) {
      if (key.startsWith(`${projectRepoId}:`)) this.baseCache.delete(key);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Diffing
 * ──────────────────────────────────────────────────────────────────────── */

/** Stable key for a relation: child.field -> parent. */
export const relationKey = (r: SchemaRelation): string =>
  `${r.from}.${r.fromField}->${r.to}`;

/**
 * Compare two graphs. Only differences are recorded: an entity is `added` when
 * absent from the base, `removed` when gone from the current, and `changed`
 * when its field set differs (the per-field entries say exactly how).
 */
export function diffGraphs(
  base: SchemaGraph,
  current: SchemaGraph,
): Omit<SchemaDiff, "baseBranch" | "unavailableReason"> {
  const entities: Record<string, SchemaChange> = {};
  const fields: Record<string, SchemaChange> = {};
  const relations: Record<string, SchemaChange> = {};

  diffEntities(base.entities, current.entities, entities, fields);
  diffRelations(base.relations, current.relations, relations);

  return { entities, fields, relations };
}

/**
 * Record which tables were added, removed or changed — y, de paso, las columnas
 * de las que aparecieron o desaparecieron enteras. Las de una tabla que sigue
 * estando las cuenta {@link diffFields}.
 */
function diffEntities(
  base: SchemaEntity[],
  current: SchemaEntity[],
  out: Record<string, SchemaChange>,
  fields: Record<string, SchemaChange>,
): void {
  const baseEntities = new Map(base.map((e) => [e.name, e]));
  const currentEntities = new Map(current.map((e) => [e.name, e]));

  for (const [name, entity] of currentEntities) {
    const before = baseEntities.get(name);
    if (!before) {
      out[name] = "added";
      // A brand-new table: its fields are new too, which the UI uses to tint
      // every row rather than just the header.
      for (const f of entity.fields) fields[`${name}.${f.name}`] = "added";
      continue;
    }
    if (diffFields(name, before, entity, fields)) out[name] = "changed";
  }

  for (const [name, entity] of baseEntities) {
    if (currentEntities.has(name)) continue;
    out[name] = "removed";
    for (const f of entity.fields) fields[`${name}.${f.name}`] = "removed";
  }
}

/**
 * Record which foreign keys were added, removed or re-pointed. Una relación se
 * identifica por {@link relationKey}, así que mover la FK a otro campo lee como
 * una relación nueva y otra que se fue, no como un cambio.
 */
function diffRelations(
  base: SchemaRelation[],
  current: SchemaRelation[],
  out: Record<string, SchemaChange>,
): void {
  const baseRelations = new Map(base.map((r) => [relationKey(r), r]));
  const currentRelations = new Map(current.map((r) => [relationKey(r), r]));

  for (const [key, relation] of currentRelations) {
    const before = baseRelations.get(key);
    if (!before) out[key] = "added";
    else if (before.onDelete !== relation.onDelete) out[key] = "changed";
  }
  for (const key of baseRelations.keys()) {
    if (!currentRelations.has(key)) out[key] = "removed";
  }
}

/** Record per-field changes; returns true when the entity differs at all. */
function diffFields(
  entityName: string,
  before: SchemaEntity,
  after: SchemaEntity,
  out: Record<string, SchemaChange>,
): boolean {
  const beforeFields = new Map(before.fields.map((f) => [f.name, f]));
  const afterFields = new Map(after.fields.map((f) => [f.name, f]));
  let differs = false;

  for (const [name, field] of afterFields) {
    const prev = beforeFields.get(name);
    if (!prev) {
      out[`${entityName}.${name}`] = "added";
      differs = true;
    } else if (
      prev.type !== field.type ||
      prev.nullable !== field.nullable ||
      prev.primaryKey !== field.primaryKey ||
      prev.default !== field.default
    ) {
      out[`${entityName}.${name}`] = "changed";
      differs = true;
    }
  }

  for (const name of beforeFields.keys()) {
    if (afterFields.has(name)) continue;
    out[`${entityName}.${name}`] = "removed";
    differs = true;
  }

  return differs;
}

/** Factory used by the server bootstrap. */
export const createSchemaInspector = (
  repos: Repositories,
  options: SchemaInspectorOptions,
): SchemaInspectorServiceImpl => new SchemaInspectorServiceImpl(repos, options);
