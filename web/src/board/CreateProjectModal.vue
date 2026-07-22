<script setup lang="ts">
/**
 * Modal to create a project — replaces the old window.prompt flow.
 *
 * The user gives the project a (prefilled, editable) name and assembles its
 * repos through the embedded RepoPicker (a FolderBrowser in "repos" mode): no
 * path/branch typing. Picking a single git folder appends one repo; pointing
 * the picker at a parent folder and hitting "Agregar los N" appends every child
 * repo at once (the multi-repo case).
 *
 * The optional Claude config is chosen through the SAME shared FolderBrowser as
 * three INDEPENDENT selectors — a CLAUDE.md FILE ("file" mode), a `.claude`
 * DIRECTORY ("config" mode), and a `.mcp.json` FILE ("file" mode) — so create
 * and edit stay consistent. Each is optional and selected directly (no folder
 * auto-detection). A separate list editor collects relative "copy files" paths.
 *
 * Submit calls board.createProject({ name, repos, claudeMdPath, claudeDirPath,
 * mcpConfigPath, copyFiles }).
 */
import { computed, ref } from "vue";
import { useBoardStore } from "@/store";
import RepoPicker from "@/board/RepoPicker.vue";
import FolderBrowser from "@/board/FolderBrowser.vue";
import CopyFilesEditor from "@/board/CopyFilesEditor.vue";
import RepoScriptsEditor from "@/board/RepoScriptsEditor.vue";
import type { RepoScripts } from "@/board/RepoScriptsEditor.vue";
import type { AddRepoDTO } from "@/types";

const emit = defineEmits<{
  (e: "close"): void;
  (e: "created", projectId: string): void;
}>();

const board = useBoardStore();

const name = ref("Nuevo proyecto");
const repos = ref<AddRepoDTO[]>([]);
const submitting = ref(false);
const error = ref<string | null>(null);
/** Track whether the user has manually edited the name (so auto-suggest stops). */
const nameTouched = ref(false);
/** repoPath of each repo whose "scripts" editor is expanded. */
const expandedScripts = ref<Set<string>>(new Set());

/** Toggle the per-repo scripts expander. */
function toggleScripts(repoPath: string): void {
  const next = new Set(expandedScripts.value);
  if (next.has(repoPath)) next.delete(repoPath);
  else next.add(repoPath);
  expandedScripts.value = next;
}

/** Read a repo's three scripts as a RepoScripts object (for v-model). */
function repoScripts(repo: AddRepoDTO): RepoScripts {
  return {
    setupScript: repo.setupScript ?? null,
    runScript: repo.runScript ?? null,
    teardownScript: repo.teardownScript ?? null,
  };
}

/** Write edited scripts back into the repo in the `repos[]` array. */
function setRepoScripts(repo: AddRepoDTO, scripts: RepoScripts): void {
  repo.setupScript = scripts.setupScript;
  repo.runScript = scripts.runScript;
  repo.teardownScript = scripts.teardownScript;
}

/** True when at least one of the repo's scripts is set (badge the expander). */
function hasScripts(repo: AddRepoDTO): boolean {
  return Boolean(repo.setupScript || repo.runScript || repo.teardownScript);
}

/* ── Claude config: two independent, optional selectors ───────────────── */
/** Chosen absolute path to a CLAUDE.md FILE; null = none. */
const claudeMdPath = ref<string | null>(null);
/** Chosen absolute path to a `.claude` DIRECTORY; null = none. */
const claudeDirPath = ref<string | null>(null);
/** Chosen absolute path to a `.mcp.json` FILE; null = none. */
const mcpConfigPath = ref<string | null>(null);
/** Inline browser visibility — one per selector (file vs config/folder mode). */
const showMdBrowser = ref(false);
const showDirBrowser = ref(false);
const showMcpBrowser = ref(false);

/* ── Copy files: relative paths copied (not symlinked) into each worktree ── */
const copyFiles = ref<string[]>([]);

const canSubmit = computed(
  () => name.value.trim().length > 0 && repos.value.length > 0 && !submitting.value,
);

/** basename of a path, used to auto-suggest the project name from a parent dir. */
function basename(repoPath: string): string {
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Parent dir of a repo path (its containing folder). */
function parentName(repoPath: string): string {
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 2] ?? "";
}

function hasRepo(repoPath: string): boolean {
  return repos.value.some((r) => r.repoPath === repoPath);
}

function onAdd(repo: AddRepoDTO): void {
  error.value = null;
  if (hasRepo(repo.repoPath)) return;
  repos.value.push(repo);
  maybeSuggestName(repo.repoPath);
}

function onAddMany(incoming: AddRepoDTO[]): void {
  error.value = null;
  for (const repo of incoming) {
    if (!hasRepo(repo.repoPath)) repos.value.push(repo);
  }
  // Multi-repo from a parent folder → suggest the parent's name.
  if (!nameTouched.value && incoming.length > 0) {
    const suggestion = parentName(incoming[0].repoPath);
    if (suggestion) name.value = suggestion;
  }
}

/** When the project still has the default name, suggest from the first repo. */
function maybeSuggestName(repoPath: string): void {
  if (nameTouched.value) return;
  if (repos.value.length === 1) {
    const suggestion = basename(repoPath);
    if (suggestion) name.value = suggestion;
  }
}

function removeRepo(repoPath: string): void {
  repos.value = repos.value.filter((r) => r.repoPath !== repoPath);
}

/* ── Claude config selectors (shared FolderBrowser) ────────────────────── */
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

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const project = await board.createProject({
      name: name.value.trim(),
      repos: [...repos.value],
      claudeMdPath: claudeMdPath.value,
      claudeDirPath: claudeDirPath.value,
      mcpConfigPath: mcpConfigPath.value,
      copyFiles: [...copyFiles.value],
    });
    emit("created", project.id);
    emit("close");
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Nuevo proyecto">
      <header class="modal__head">
        <h2 class="modal__title">Nuevo proyecto</h2>
        <button class="modal__close" type="button" aria-label="Cerrar" @click="emit('close')">
          ×
        </button>
      </header>

      <form class="modal__body" @submit.prevent="submit">
        <label class="field">
          <span class="field__label">Nombre del proyecto</span>
          <input
            v-model="name"
            class="field__control"
            type="text"
            required
            @input="nameTouched = true"
          />
        </label>

        <div class="field">
          <span class="field__label">Repos</span>
          <ul v-if="repos.length" class="repo-rows">
            <li v-for="repo in repos" :key="repo.repoPath" class="repo-row">
              <div class="repo-row__head">
                <span class="repo-row__name">{{ repo.name }}</span>
                <span class="repo-row__branch">{{ repo.baseBranch }}</span>
                <button
                  class="repo-row__scripts-toggle"
                  type="button"
                  :aria-expanded="expandedScripts.has(repo.repoPath)"
                  @click="toggleScripts(repo.repoPath)"
                >
                  <span class="repo-row__caret">
                    {{ expandedScripts.has(repo.repoPath) ? "▾" : "▸" }}
                  </span>
                  scripts
                  <span v-if="hasScripts(repo)" class="repo-row__dot" aria-hidden="true" />
                </button>
                <button
                  class="repo-row__remove"
                  type="button"
                  aria-label="Quitar repo"
                  @click="removeRepo(repo.repoPath)"
                >
                  ×
                </button>
              </div>

              <div v-if="expandedScripts.has(repo.repoPath)" class="repo-row__scripts">
                <RepoScriptsEditor
                  :model-value="repoScripts(repo)"
                  @update:model-value="(s) => setRepoScripts(repo, s)"
                />
              </div>
            </li>
          </ul>
          <p v-else class="hint">
            Explora y elige una carpeta git, o agrega varios repos de una carpeta padre.
          </p>

          <RepoPicker :closable="false" @add="onAdd" @add-many="onAddMany" />
        </div>

        <div class="field">
          <span class="field__label">Config de Claude</span>
          <p class="hint">
            Opcional. Elige por separado un archivo <code>CLAUDE.md</code>, una
            carpeta <code>.claude</code> y/o un archivo <code>.mcp.json</code>. Cada
            uno se enlaza (symlink) en el worktree de cada tarea del proyecto, para
            que Claude Code tome el <code>CLAUDE.md</code>, los skills y subagentes de
            <code>.claude</code>, y los servidores MCP del proyecto desde
            <code>.mcp.json</code>.
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

        <p v-if="error" class="error">{{ error }}</p>

        <footer class="modal__foot">
          <button class="btn btn--ghost" type="button" @click="emit('close')">Cancelar</button>
          <button class="btn btn--primary" type="submit" :disabled="!canSubmit">
            {{ submitting ? "Creando…" : "Crear proyecto" }}
          </button>
        </footer>
      </form>
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
  overflow: auto;
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
.chip__remove:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-danger);
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
.repo-row__remove:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-danger);
}
.repo-row__scripts {
  padding: 10px 11px 11px;
  border-top: 1px solid var(--ck-border);
  background: var(--ck-surface-2);
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

/* ── Chosen config path (file or dir) ───────────────────────────────── */
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
  margin-left: auto;
  color: var(--ck-text-muted);
}

.modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
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
</style>
