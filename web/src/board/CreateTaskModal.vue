<script setup lang="ts">
/**
 * Modal to create a task. The user picks a project, selects which of the
 * project's repos the task spans (defaults to all), and gives it a title and
 * optional description. On submit it calls store.createTask, which triggers the
 * backend lifecycle (worktrees + session root + pty spawn).
 *
 * If the selected project has no repos yet, the user can register one inline.
 */
import { computed, ref, watch } from "vue";
import { useBoardStore } from "@/store";
import RepoPicker from "@/board/RepoPicker.vue";
import type { Project, AddRepoDTO } from "@/types";

const props = defineProps<{
  /** Preselect this project when opening. */
  defaultProjectId: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "created", taskId: string): void;
}>();

const board = useBoardStore();

const projectId = ref<string>(props.defaultProjectId ?? board.projects[0]?.id ?? "");
const title = ref("");
const description = ref("");
const selectedRepoIds = ref<string[]>([]);
const submitting = ref(false);
const error = ref<string | null>(null);
/** Whether the inline RepoPicker panel is shown. */
const showPicker = ref(false);
/** Whether a repo registration triggered by the picker is in flight. */
const addingRepo = ref(false);

const currentProject = computed<Project | null>(
  () => board.projects.find((p) => p.id === projectId.value) ?? null,
);
const repos = computed(() => currentProject.value?.repos ?? []);
const canSubmit = computed(
  () =>
    !!projectId.value &&
    title.value.trim().length > 0 &&
    // A zero-repo submit can't reach the lifecycle just to throw.
    (selectedRepoIds.value.length > 0 || repos.value.length === 0) &&
    !submitting.value,
);

// When the project changes, preselect all of its repos by default.
watch(
  () => [projectId.value, repos.value.length] as const,
  () => {
    selectedRepoIds.value = repos.value.map((r) => r.id);
    showPicker.value = repos.value.length === 0;
  },
  { immediate: true },
);

function toggleRepo(id: string): void {
  const i = selectedRepoIds.value.indexOf(id);
  if (i === -1) selectedRepoIds.value.push(id);
  else selectedRepoIds.value.splice(i, 1);
}

/** Register a single picked git folder onto the current project. */
async function onAddRepo(dto: AddRepoDTO): Promise<void> {
  if (!projectId.value) return;
  addingRepo.value = true;
  error.value = null;
  try {
    await board.addRepo(projectId.value, dto);
    showPicker.value = false;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    addingRepo.value = false;
  }
}

/** Register every discovered child repo (multi-repo) sequentially. */
async function onAddManyRepos(dtos: AddRepoDTO[]): Promise<void> {
  if (!projectId.value) return;
  addingRepo.value = true;
  error.value = null;
  try {
    for (const dto of dtos) {
      await board.addRepo(projectId.value, dto);
    }
    showPicker.value = false;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    addingRepo.value = false;
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const allSelected =
      selectedRepoIds.value.length === repos.value.length || repos.value.length === 0;
    const task = await board.createTask({
      projectId: projectId.value,
      title: title.value.trim(),
      description: description.value.trim() || null,
      // Omit projectRepoIds to mean "all repos"; otherwise send the subset.
      projectRepoIds: allSelected ? undefined : [...selectedRepoIds.value],
    });
    emit("created", task.id);
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
    <div class="modal" role="dialog" aria-modal="true" aria-label="Nueva tarea">
      <header class="modal__head">
        <h2 class="modal__title">Nueva tarea</h2>
        <button class="modal__close" type="button" aria-label="Cerrar" @click="emit('close')">
          ×
        </button>
      </header>

      <form class="modal__body" @submit.prevent="submit">
        <label class="field">
          <span class="field__label">Proyecto</span>
          <select v-model="projectId" class="field__control" required>
            <option v-if="board.projects.length === 0" value="" disabled>
              Crea un proyecto primero
            </option>
            <option v-for="p in board.projects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field__label">Título</span>
          <input
            v-model="title"
            class="field__control"
            type="text"
            placeholder="Ej. Agregar login con Google"
            required
            autofocus
          />
        </label>

        <label class="field">
          <span class="field__label">Descripción <em>(opcional)</em></span>
          <textarea
            v-model="description"
            class="field__control"
            rows="3"
            placeholder="Contexto o instrucciones para la sesión de Claude…"
          />
        </label>

        <div class="field">
          <div class="field__label-row">
            <span class="field__label">Repos</span>
            <button
              v-if="repos.length"
              class="link-btn"
              type="button"
              @click="showPicker = !showPicker"
            >
              {{ showPicker ? "Cancelar" : "+ Agregar repo" }}
            </button>
          </div>

          <ul v-if="repos.length" class="repo-list">
            <li v-for="repo in repos" :key="repo.id" class="repo-list__item">
              <label>
                <input
                  type="checkbox"
                  :checked="selectedRepoIds.includes(repo.id)"
                  @change="toggleRepo(repo.id)"
                />
                <span class="repo-list__name">{{ repo.name }}</span>
                <span class="repo-list__branch">{{ repo.baseBranch }}</span>
              </label>
            </li>
          </ul>
          <p v-else class="hint">
            Este proyecto no tiene repos. Explora y elige al menos uno.
          </p>

          <p v-if="addingRepo" class="hint">Agregando repo…</p>

          <RepoPicker
            v-if="showPicker"
            @add="onAddRepo"
            @add-many="onAddManyRepos"
            @cancel="showPicker = false"
          />
        </div>

        <p v-if="error" class="error">{{ error }}</p>

        <footer class="modal__foot">
          <button class="btn btn--ghost" type="button" @click="emit('close')">Cancelar</button>
          <button class="btn btn--primary" type="submit" :disabled="!canSubmit">
            {{ submitting ? "Creando…" : "Crear tarea" }}
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
  max-width: 460px;
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
  padding: 16px 18px;
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
  gap: 14px;
  padding: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field__label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.field__label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ck-text);
}
.field__label em {
  font-weight: 400;
  color: var(--ck-text-muted);
  font-style: normal;
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
textarea.field__control {
  resize: vertical;
}

.repo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.repo-list__item label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  cursor: pointer;
}
.repo-list__item label:hover {
  background: var(--ck-surface-hover);
}
.repo-list__name {
  font-weight: 500;
}
.repo-list__branch {
  margin-left: auto;
  font-size: 11px;
  color: var(--ck-text-muted);
  background: var(--ck-surface);
  border-radius: 999px;
  padding: 1px 8px;
}

.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--ck-text-muted);
}
.error {
  margin: 0;
  color: var(--ck-danger);
  font-size: 12.5px;
}

.link-btn {
  background: none;
  border: none;
  color: var(--ck-primary);
  font-size: 12.5px;
  font-weight: 600;
  padding: 0;
}
.link-btn:hover {
  text-decoration: underline;
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
