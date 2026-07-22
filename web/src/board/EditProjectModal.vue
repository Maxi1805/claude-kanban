<script setup lang="ts">
/**
 * EditProjectModal — edit the project the user is currently in.
 *
 * Opened from the ✎ button next to the board's project <select>. Pre-fills the
 * project name, its registered repos, and its Claude config (a CLAUDE.md FILE,
 * a `.claude` DIRECTORY, and a `.mcp.json` FILE — each independent/optional),
 * plus its "copy files" list, and lets the user:
 *   • rename it                       → store.updateProject(id, { name })
 *   • set / clear CLAUDE.md (file)    → store.updateProject(id, { claudeMdPath })
 *     (picked through the shared FolderBrowser in "file" mode)
 *   • set / clear .claude (dir)       → store.updateProject(id, { claudeDirPath })
 *     (picked through the shared FolderBrowser in "config" mode)
 *   • set / clear .mcp.json (file)    → store.updateProject(id, { mcpConfigPath })
 *     (picked through the shared FolderBrowser in "file" mode)
 *   • edit the copy-files list        → store.updateProject(id, { copyFiles })
 *   • add repos                       → store.addRepo(id, dto)
 *   • remove repos                    → store.removeRepo(id, repoId)
 *
 * Repo add/remove apply IMMEDIATELY (they hit the API on click) since they are
 * discrete server mutations; name + Claude/MCP config + copy files are applied
 * on "Guardar".
 */
import { computed, reactive, ref } from "vue";
import { useBoardStore } from "@/store";
import FolderBrowser from "@/board/FolderBrowser.vue";
import CopyFilesEditor from "@/board/CopyFilesEditor.vue";
import RepoScriptsEditor from "@/board/RepoScriptsEditor.vue";
import type { RepoScripts } from "@/board/RepoScriptsEditor.vue";
import type { AddRepoDTO, Project, ProjectRepo } from "@/types";
import type { UpdateProjectInput } from "@/store";

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ (e: "close"): void }>();

const board = useBoardStore();

/**
 * The two newer per-project fields the shared `Project` may not yet declare in
 * this build; read them through a widened view so pre-fill/diff stay typed.
 */
type ProjectWithExtras = Project & {
  mcpConfigPath?: string | null;
  copyFiles?: string[] | null;
};

/** Always read the live project from the store so repo add/remove reflects. */
const project = computed<ProjectWithExtras>(
  () =>
    (board.projects.find((p) => p.id === props.project.id) ??
      props.project) as ProjectWithExtras,
);

const source = props.project as ProjectWithExtras;

const name = ref(props.project.name);
/* Pre-fill ALL selectors from the project (each independent/optional). */
const claudeMdPath = ref<string | null>(props.project.claudeMdPath ?? null);
const claudeDirPath = ref<string | null>(props.project.claudeDirPath ?? null);
const mcpConfigPath = ref<string | null>(source.mcpConfigPath ?? null);
/* Pre-fill the copy-files list (a copy so edits don't mutate the store). */
const copyFiles = ref<string[]>([...(source.copyFiles ?? [])]);

const savingMeta = ref(false);
const error = ref<string | null>(null);

/* ── Delete project (danger zone) ──────────────────────────────────────── */
/** Two-step confirm so a single stray click never destroys a project. */
const confirmingDelete = ref(false);
const deleting = ref(false);

/** How many tasks this delete will tear down (shown in the confirm prompt). */
const projectTaskCount = computed(
  () => board.tasks.filter((t) => t.projectId === project.value.id).length,
);

async function deleteProject(): Promise<void> {
  deleting.value = true;
  error.value = null;
  try {
    await board.deleteProject(project.value.id);
    emit("close");
  } catch (err) {
    error.value = (err as Error).message;
    deleting.value = false;
    confirmingDelete.value = false;
  }
}

/* Repo mutation in-flight flags (per-repo for remove, single for add). */
const addingRepo = ref(false);
const removingRepoId = ref<string | null>(null);

/* ── Per-repo script editing ───────────────────────────────────────────── */
/** repoId of each repo whose "scripts" editor is expanded. */
const expandedScriptRepoIds = ref<Set<string>>(new Set());
/** Local, editable script drafts keyed by repoId (separate from store state). */
const scriptDrafts = reactive<Record<string, RepoScripts>>({});
/** repoId currently being saved via store.updateRepo (disables its button). */
const savingScriptsRepoId = ref<string | null>(null);

/** Snapshot a repo's stored scripts into a fresh draft (pre-fill). */
function draftFromRepo(repo: ProjectRepo): RepoScripts {
  return {
    setupScript: repo.setupScript ?? null,
    runScript: repo.runScript ?? null,
    teardownScript: repo.teardownScript ?? null,
  };
}

/** Toggle the per-repo scripts expander, seeding the draft on first open. */
function toggleScripts(repo: ProjectRepo): void {
  const next = new Set(expandedScriptRepoIds.value);
  if (next.has(repo.id)) {
    next.delete(repo.id);
  } else {
    next.add(repo.id);
    if (!scriptDrafts[repo.id]) scriptDrafts[repo.id] = draftFromRepo(repo);
  }
  expandedScriptRepoIds.value = next;
}

/** The live draft for a repo (seeded from the store if not yet edited). */
function draftFor(repo: ProjectRepo): RepoScripts {
  return scriptDrafts[repo.id] ?? draftFromRepo(repo);
}

function onScriptsInput(repoId: string, scripts: RepoScripts): void {
  scriptDrafts[repoId] = scripts;
}

/** True when a repo's draft differs from its stored scripts (enables save). */
function scriptsDirty(repo: ProjectRepo): boolean {
  const d = scriptDrafts[repo.id];
  if (!d) return false;
  return (
    (d.setupScript ?? null) !== (repo.setupScript ?? null) ||
    (d.runScript ?? null) !== (repo.runScript ?? null) ||
    (d.teardownScript ?? null) !== (repo.teardownScript ?? null)
  );
}

/** Persist a repo's edited scripts via store.updateRepo and reconcile state. */
async function saveScripts(repo: ProjectRepo): Promise<void> {
  if (!scriptsDirty(repo)) return;
  savingScriptsRepoId.value = repo.id;
  error.value = null;
  try {
    const d = draftFor(repo);
    await board.updateRepo(project.value.id, repo.id, {
      setupScript: d.setupScript,
      runScript: d.runScript,
      teardownScript: d.teardownScript,
    });
    // Re-sync the draft from the now-updated store row.
    const fresh = repos.value.find((r) => r.id === repo.id);
    if (fresh) scriptDrafts[repo.id] = draftFromRepo(fresh);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    savingScriptsRepoId.value = null;
  }
}

/* ── Inline browsers — one per selector (file vs config/folder mode). ──── */
const showMdBrowser = ref(false);
const showDirBrowser = ref(false);
const showMcpBrowser = ref(false);

const repos = computed(() => project.value.repos ?? []);

/** Stable JSON for comparing the copy-files arrays (order-sensitive). */
function copyFilesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const metaDirty = computed(
  () =>
    name.value.trim() !== project.value.name ||
    (claudeMdPath.value ?? null) !== (project.value.claudeMdPath ?? null) ||
    (claudeDirPath.value ?? null) !== (project.value.claudeDirPath ?? null) ||
    (mcpConfigPath.value ?? null) !== (project.value.mcpConfigPath ?? null) ||
    !copyFilesEqual(copyFiles.value, project.value.copyFiles ?? []),
);

const canSave = computed(
  () => name.value.trim().length > 0 && metaDirty.value && !savingMeta.value,
);

/* ── Claude config selectors ───────────────────────────────────────────── */

function onPickMdFile(path: string): void {
  error.value = null;
  claudeMdPath.value = path;
  showMdBrowser.value = false;
}
function clearMdFile(): void {
  claudeMdPath.value = null;
  showMdBrowser.value = false;
}
function onPickDir(path: string): void {
  error.value = null;
  claudeDirPath.value = path;
  showDirBrowser.value = false;
}
function clearDir(): void {
  claudeDirPath.value = null;
  showDirBrowser.value = false;
}
function onPickMcpFile(path: string): void {
  error.value = null;
  mcpConfigPath.value = path;
  showMcpBrowser.value = false;
}
function clearMcpFile(): void {
  mcpConfigPath.value = null;
  showMcpBrowser.value = false;
}

/* ── Repos ─────────────────────────────────────────────────────────────── */

function repoExists(repoPath: string): boolean {
  return repos.value.some((r) => r.repoPath === repoPath);
}

async function onAddRepo(dto: AddRepoDTO): Promise<void> {
  if (repoExists(dto.repoPath)) return;
  addingRepo.value = true;
  error.value = null;
  try {
    await board.addRepo(project.value.id, dto);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    addingRepo.value = false;
  }
}

async function onAddManyRepos(dtos: AddRepoDTO[]): Promise<void> {
  addingRepo.value = true;
  error.value = null;
  try {
    for (const dto of dtos) {
      if (!repoExists(dto.repoPath)) {
        await board.addRepo(project.value.id, dto);
      }
    }
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    addingRepo.value = false;
  }
}

async function onRemoveRepo(repoId: string): Promise<void> {
  if (repos.value.length <= 1) {
    error.value = "Un proyecto debe conservar al menos un repo.";
    return;
  }
  removingRepoId.value = repoId;
  error.value = null;
  try {
    await board.removeRepo(project.value.id, repoId);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    removingRepoId.value = null;
  }
}

/* ── Save meta (name + CLAUDE.md file + .claude dir) ────────────────────── */

async function save(): Promise<void> {
  if (!canSave.value) return;
  savingMeta.value = true;
  error.value = null;
  try {
    const patch: UpdateProjectInput = {};
    if (name.value.trim() !== project.value.name) patch.name = name.value.trim();
    if ((claudeMdPath.value ?? null) !== (project.value.claudeMdPath ?? null)) {
      patch.claudeMdPath = claudeMdPath.value;
    }
    if ((claudeDirPath.value ?? null) !== (project.value.claudeDirPath ?? null)) {
      patch.claudeDirPath = claudeDirPath.value;
    }
    if ((mcpConfigPath.value ?? null) !== (project.value.mcpConfigPath ?? null)) {
      patch.mcpConfigPath = mcpConfigPath.value;
    }
    if (!copyFilesEqual(copyFiles.value, project.value.copyFiles ?? [])) {
      patch.copyFiles = [...copyFiles.value];
    }
    await board.updateProject(project.value.id, patch);
    emit("close");
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    savingMeta.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Editar proyecto">
      <header class="modal__head">
        <h2 class="modal__title">Editar proyecto</h2>
        <button class="modal__close" type="button" aria-label="Cerrar" @click="emit('close')">
          ×
        </button>
      </header>

      <div class="modal__body">
        <label class="field">
          <span class="field__label">Nombre del proyecto</span>
          <input v-model="name" class="field__control" type="text" required />
        </label>

        <!-- Repos -->
        <div class="field">
          <span class="field__label">Repos</span>
          <ul v-if="repos.length" class="repo-rows">
            <li v-for="repo in repos" :key="repo.id" class="repo-row">
              <div class="repo-row__head">
                <span class="repo-row__name">{{ repo.name }}</span>
                <span class="repo-row__branch">{{ repo.baseBranch }}</span>
                <button
                  class="repo-row__scripts-toggle"
                  type="button"
                  :aria-expanded="expandedScriptRepoIds.has(repo.id)"
                  @click="toggleScripts(repo)"
                >
                  <span class="repo-row__caret">
                    {{ expandedScriptRepoIds.has(repo.id) ? "▾" : "▸" }}
                  </span>
                  scripts
                  <span
                    v-if="repo.setupScript || repo.runScript || repo.teardownScript"
                    class="repo-row__dot"
                    aria-hidden="true"
                  />
                </button>
                <button
                  class="repo-row__remove"
                  type="button"
                  aria-label="Quitar repo"
                  :disabled="removingRepoId === repo.id || repos.length <= 1"
                  :title="repos.length <= 1 ? 'Debe quedar al menos un repo' : 'Quitar repo'"
                  @click="onRemoveRepo(repo.id)"
                >
                  {{ removingRepoId === repo.id ? "…" : "×" }}
                </button>
              </div>

              <div v-if="expandedScriptRepoIds.has(repo.id)" class="repo-row__scripts">
                <RepoScriptsEditor
                  :model-value="draftFor(repo)"
                  @update:model-value="(s) => onScriptsInput(repo.id, s)"
                />
                <div class="repo-row__scripts-foot">
                  <button
                    class="btn btn--primary btn--sm"
                    type="button"
                    :disabled="!scriptsDirty(repo) || savingScriptsRepoId === repo.id"
                    @click="saveScripts(repo)"
                  >
                    {{ savingScriptsRepoId === repo.id ? "Guardando…" : "Guardar scripts" }}
                  </button>
                </div>
              </div>
            </li>
          </ul>
          <p v-else class="hint">Este proyecto no tiene repos.</p>

          <p v-if="addingRepo" class="hint">Agregando repo…</p>

          <FolderBrowser
            mode="repos"
            @pick-repo="onAddRepo"
            @pick-repos="onAddManyRepos"
          />
        </div>

        <!-- Claude config: CLAUDE.md (file) + .claude (dir), each optional -->
        <div class="field">
          <span class="field__label">Config de Claude</span>
          <p class="hint">
            Elige por separado un archivo <code>CLAUDE.md</code>, una carpeta
            <code>.claude</code> y/o un archivo <code>.mcp.json</code>. Cada uno se
            enlaza (symlink) en el worktree de cada tarea para que Claude Code tome
            el <code>CLAUDE.md</code>, los skills y subagentes de <code>.claude</code>,
            y los servidores MCP del proyecto desde <code>.mcp.json</code>.
          </p>

          <!-- CLAUDE.md (archivo) -->
          <div class="config-row">
            <span class="config-row__label">CLAUDE.md (archivo)</span>

            <div v-if="claudeMdPath" class="config-chosen">
              <code class="config-chosen__path">{{ claudeMdPath }}</code>
              <button
                class="link-btn link-btn--muted"
                type="button"
                aria-label="Quitar CLAUDE.md"
                @click="clearMdFile"
              >
                ✕
              </button>
            </div>

            <button
              v-if="!showMdBrowser"
              class="btn btn--secondary btn--sm config-pick-btn"
              type="button"
              @click="showMdBrowser = true"
            >
              {{ claudeMdPath ? "Cambiar archivo…" : "Elegir archivo CLAUDE.md…" }}
            </button>

            <FolderBrowser
              v-if="showMdBrowser"
              mode="file"
              closable
              :initial-path="claudeMdPath"
              @pick-file="onPickMdFile"
              @close="showMdBrowser = false"
            />
          </div>

          <!-- .claude (carpeta) -->
          <div class="config-row">
            <span class="config-row__label">.claude (carpeta)</span>

            <div v-if="claudeDirPath" class="config-chosen">
              <code class="config-chosen__path">{{ claudeDirPath }}</code>
              <button
                class="link-btn link-btn--muted"
                type="button"
                aria-label="Quitar carpeta .claude"
                @click="clearDir"
              >
                ✕
              </button>
            </div>

            <button
              v-if="!showDirBrowser"
              class="btn btn--secondary btn--sm config-pick-btn"
              type="button"
              @click="showDirBrowser = true"
            >
              {{ claudeDirPath ? "Cambiar carpeta…" : "Elegir carpeta .claude…" }}
            </button>

            <FolderBrowser
              v-if="showDirBrowser"
              mode="config"
              closable
              :initial-path="claudeDirPath"
              @pick-folder="onPickDir"
              @close="showDirBrowser = false"
            />
          </div>

          <!-- Config MCP (.mcp.json, archivo) -->
          <div class="config-row">
            <span class="config-row__label">Config MCP (.mcp.json)</span>

            <div v-if="mcpConfigPath" class="config-chosen">
              <code class="config-chosen__path">{{ mcpConfigPath }}</code>
              <button
                class="link-btn link-btn--muted"
                type="button"
                aria-label="Quitar .mcp.json"
                @click="clearMcpFile"
              >
                ✕
              </button>
            </div>

            <button
              v-if="!showMcpBrowser"
              class="btn btn--secondary btn--sm config-pick-btn"
              type="button"
              @click="showMcpBrowser = true"
            >
              {{ mcpConfigPath ? "Cambiar archivo…" : "Elegir archivo .mcp.json…" }}
            </button>

            <FolderBrowser
              v-if="showMcpBrowser"
              mode="file"
              closable
              :initial-path="mcpConfigPath"
              @pick-file="onPickMcpFile"
              @close="showMcpBrowser = false"
            />
          </div>
        </div>

        <!-- Archivos a copiar (no versionados) -->
        <div class="field">
          <span class="field__label">Archivos a copiar (no versionados)</span>
          <p class="hint">
            Rutas relativas copiadas desde cada repo original al worktree, p.ej.
            <code>.env</code> — útil para archivos gitignored.
          </p>
          <CopyFilesEditor v-model="copyFiles" />
        </div>

        <!-- Zona de peligro: eliminar el proyecto por completo -->
        <div class="field danger-zone">
          <span class="field__label danger-zone__label">Zona de peligro</span>
          <p class="hint">
            Eliminar el proyecto borra el proyecto, sus repos registrados y
            <strong>todas sus tareas</strong> — incluidos worktrees, ramas,
            procesos y puertos asociados. No se puede deshacer.
          </p>

          <button
            v-if="!confirmingDelete"
            class="btn btn--danger btn--sm danger-zone__btn"
            type="button"
            @click="confirmingDelete = true"
          >
            Eliminar proyecto
          </button>

          <div v-else class="danger-confirm">
            <p class="danger-confirm__text">
              ¿Eliminar <strong>{{ project.name }}</strong>
              <template v-if="projectTaskCount > 0">
                y sus {{ projectTaskCount }}
                tarea{{ projectTaskCount === 1 ? "" : "s" }}
              </template>? Esta acción no se puede deshacer.
            </p>
            <div class="danger-confirm__actions">
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="deleting"
                @click="confirmingDelete = false"
              >
                Cancelar
              </button>
              <button
                class="btn btn--danger btn--sm"
                type="button"
                :disabled="deleting"
                @click="deleteProject"
              >
                {{ deleting ? "Eliminando…" : "Sí, eliminar todo" }}
              </button>
            </div>
          </div>
        </div>

        <p v-if="error" class="error">{{ error }}</p>
      </div>

      <footer class="modal__foot">
        <button class="btn btn--ghost" type="button" @click="emit('close')">Cerrar</button>
        <button class="btn btn--primary" type="button" :disabled="!canSave" @click="save">
          {{ savingMeta ? "Guardando…" : "Guardar cambios" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 50;
}
.modal {
  width: 100%;
  max-width: 700px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  box-shadow: var(--ck-shadow-lg);
}
.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ck-border);
}
.modal__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.modal__close {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  font-size: 20px;
  color: var(--ck-text-muted);
  background: transparent;
  border: none;
  border-radius: 8px;
}
.modal__close:hover {
  background: var(--ck-surface-hover);
}

.modal__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  overflow: auto;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.field__label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ck-text);
}
.field__control {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  color: var(--ck-text);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.field__control::placeholder {
  color: var(--ck-text-faint);
}
.field__control:focus {
  outline: none;
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}

.chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border: 1px solid var(--ck-border);
  border-radius: 999px;
  background: var(--ck-surface);
  font-size: 12.5px;
}
.chip__name {
  font-weight: 600;
}
.chip__branch {
  font-size: 11px;
  color: var(--ck-text-muted);
}
.chip__remove {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ck-text-muted);
  font-size: 15px;
  line-height: 1;
}
.chip__remove:not(:disabled):hover {
  background: var(--ck-surface-hover);
  color: var(--ck-danger);
}
.chip__remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── Editable repo rows (name + branch + scripts expander + remove) ─────── */
.repo-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.repo-row {
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  overflow: hidden;
}
.repo-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 11px;
}
.repo-row__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ck-text);
}
.repo-row__branch {
  font-size: 11px;
  color: var(--ck-text-muted);
}
.repo-row__scripts-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 3px 8px;
  border: 1px solid var(--ck-border);
  border-radius: 999px;
  background: var(--ck-surface-2);
  color: var(--ck-text-muted);
  font-size: 11.5px;
  font-weight: 600;
}
.repo-row__scripts-toggle:hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
  color: var(--ck-text);
}
.repo-row__caret {
  font-size: 10px;
  line-height: 1;
}
.repo-row__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ck-primary);
}
.repo-row__remove {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ck-text-muted);
  font-size: 16px;
  line-height: 1;
}
.repo-row__remove:not(:disabled):hover {
  background: var(--ck-surface-hover);
  color: var(--ck-danger);
}
.repo-row__remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.repo-row__scripts {
  padding: 10px 11px 11px;
  border-top: 1px solid var(--ck-border);
  background: var(--ck-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.repo-row__scripts-foot {
  display: flex;
  justify-content: flex-end;
}

.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--ck-text-muted);
}
.hint code,
.config-chosen__path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}
.error {
  margin: 0;
  color: var(--ck-danger);
  font-size: 12.5px;
}

/* ── Claude config selectors (file + dir) ───────────────────────────── */
.config-row {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
}
.config-row__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ck-text);
}

.config-chosen {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface-2);
}
.config-chosen__path {
  min-width: 0;
  word-break: break-all;
  color: var(--ck-text);
}
.config-pick-btn {
  align-self: flex-start;
}

.link-btn {
  background: none;
  border: none;
  color: var(--ck-primary);
  font-size: 12px;
  font-weight: 600;
  padding: 0;
}
.link-btn:hover {
  text-decoration: underline;
}
.link-btn--muted {
  flex: none;
  color: var(--ck-text-muted);
}

.modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--ck-border);
}
.btn {
  padding: 9px 16px;
  border-radius: var(--ck-radius);
  font-weight: 600;
  border: 1px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn--sm {
  padding: 6px 11px;
  font-size: 12.5px;
}
.btn--primary {
  background: var(--ck-primary);
  color: #fff;
}
.btn--primary:not(:disabled):hover {
  background: var(--ck-primary-hover);
}
.btn--secondary {
  background: var(--ck-surface);
  border-color: var(--ck-border);
  color: var(--ck-text);
}
.btn--secondary:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}
.btn--ghost {
  background: transparent;
  border-color: var(--ck-border);
  color: var(--ck-text);
}
.btn--ghost:hover {
  background: var(--ck-surface-hover);
}
.btn--danger {
  background: var(--ck-danger);
  border-color: var(--ck-danger);
  color: #fff;
}
.btn--danger:not(:disabled):hover {
  filter: brightness(0.92);
}

/* ── Danger zone (delete project) ───────────────────────────────────────── */
.danger-zone {
  padding: 12px;
  border: 1px solid rgba(235, 87, 87, 0.35);
  border-radius: var(--ck-radius);
  background: rgba(235, 87, 87, 0.06);
}
.danger-zone__label {
  color: var(--ck-danger);
}
.danger-zone__btn {
  align-self: flex-start;
}
.danger-confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.danger-confirm__text {
  margin: 0;
  font-size: 12.5px;
  color: var(--ck-text);
}
.danger-confirm__actions {
  display: flex;
  gap: 8px;
}
</style>
