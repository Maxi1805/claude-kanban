<script setup lang="ts">
/**
 * Kanban board view — the app's home screen.
 *
 * Four fixed columns (todo / running / review / done). Cards are dragged
 * between columns with vuedraggable; a drop emits a `move` that PATCHes the
 * task status. A header carries the project selector, an inline "new project"
 * action, and the "+ Nueva tarea" button which opens CreateTaskModal.
 */
import { computed, ref } from "vue";
import { useBoardStore } from "@/store";
import Column from "@/board/Column.vue";
import CreateTaskModal from "@/board/CreateTaskModal.vue";
import CreateProjectModal from "@/board/CreateProjectModal.vue";
import EditProjectModal from "@/board/EditProjectModal.vue";
import type { TaskStatus } from "@/types";

const board = useBoardStore();

const COLUMNS: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: "todo", label: "Por hacer" },
  { status: "running", label: "Corriendo" },
  { status: "review", label: "Revisión" },
  { status: "done", label: "Hecho" },
];

const showTaskModal = ref(false);
const showProjectModal = ref(false);
const showEditProjectModal = ref(false);

const grouped = computed(() => board.tasksByStatus);
const hasProjects = computed(() => board.projects.length > 0);
const selectedProject = computed(() => board.selectedProject);

function editProject(): void {
  if (selectedProject.value) showEditProjectModal.value = true;
}

// Initial data load + live events socket are bootstrapped once in App.vue
// (the root shell), so the board simply renders off the shared store. This
// keeps data/reactivity working on any entry route, not just the board.

function onMove(payload: { taskId: string; status: TaskStatus }): void {
  void board.moveTask(payload.taskId, payload.status);
}

function newProject(): void {
  showProjectModal.value = true;
}

function openTaskModal(): void {
  if (!hasProjects.value) {
    newProject();
    return;
  }
  showTaskModal.value = true;
}
</script>

<template>
  <main class="board">
    <header class="board__bar">
      <div class="board__brand">
        <span class="board__logo">◧</span>
        <h1 class="board__title">claude-kanban</h1>
      </div>

      <div class="board__controls">
        <div v-if="hasProjects" class="board__project">
          <select
            class="board__select"
            :value="board.selectedProjectId ?? ''"
            aria-label="Proyecto"
            @change="board.setSelectedProject(($event.target as HTMLSelectElement).value || null)"
          >
            <option v-for="p in board.projects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
          <button
            class="board__edit"
            type="button"
            :disabled="!selectedProject"
            title="Editar proyecto"
            aria-label="Editar proyecto"
            @click="editProject"
          >
            ✎
          </button>
        </div>

        <RouterLink
          class="btn btn--ghost"
          to="/db"
          title="Ver la base de datos en vivo"
        >
          ⛁ BD
        </RouterLink>
        <button class="btn btn--ghost" type="button" @click="newProject">
          + Proyecto
        </button>
        <button class="btn btn--primary" type="button" @click="openTaskModal">
          + Nueva tarea
        </button>
      </div>
    </header>

    <p v-if="board.error" class="board__error">{{ board.error }}</p>

    <section v-if="board.loading && board.tasks.length === 0" class="board__state">
      Cargando…
    </section>

    <section v-else-if="!hasProjects" class="board__state board__state--empty">
      <h2>Aún no hay proyectos</h2>
      <p>Crea un proyecto y agrégale repos para empezar a crear tareas.</p>
      <button class="btn btn--primary" type="button" @click="newProject">
        Crear proyecto
      </button>
    </section>

    <div v-else class="board__columns">
      <Column
        v-for="col in COLUMNS"
        :key="col.status"
        :status="col.status"
        :label="col.label"
        :tasks="grouped[col.status]"
        @move="onMove"
      />
    </div>

    <CreateTaskModal
      v-if="showTaskModal"
      :default-project-id="board.selectedProjectId"
      @close="showTaskModal = false"
      @created="showTaskModal = false"
    />

    <CreateProjectModal
      v-if="showProjectModal"
      @close="showProjectModal = false"
      @created="showProjectModal = false"
    />

    <EditProjectModal
      v-if="showEditProjectModal && selectedProject"
      :project="selectedProject"
      @close="showEditProjectModal = false"
    />
  </main>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 20px 20px;
  gap: 14px;
}

.board__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.board__brand {
  display: flex;
  align-items: center;
  gap: 9px;
}
.board__logo {
  font-size: 20px;
  color: var(--ck-primary);
}
.board__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.board__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.board__project {
  display: flex;
  align-items: center;
  gap: 6px;
}
.board__select {
  padding: 8px 12px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface-2);
  color: var(--ck-text);
  min-width: 160px;
}
.board__select:focus {
  outline: none;
  border-color: var(--ck-border-strong);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.25);
}
.board__edit {
  flex: none;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface-2);
  color: var(--ck-text-muted);
  font-size: 14px;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.board__edit:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
  color: var(--ck-text);
}
.board__edit:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.board__error {
  margin: 0;
  padding: 10px 14px;
  background: rgba(235, 87, 87, 0.14);
  border: 1px solid rgba(235, 87, 87, 0.35);
  color: var(--ck-danger);
  border-radius: var(--ck-radius);
  font-size: 13px;
}

.board__columns {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  min-height: 0;
}

.board__state {
  flex: 1;
  display: grid;
  place-content: center;
  text-align: center;
  color: var(--ck-text-muted);
  gap: 8px;
}
.board__state--empty h2 {
  margin: 0;
  color: var(--ck-text);
  font-size: 18px;
}
.board__state--empty p {
  margin: 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  padding: 8px 15px;
  border-radius: var(--ck-radius);
  font-weight: 600;
  border: 1px solid transparent;
  text-decoration: none; /* .btn is also applied to RouterLink anchors */
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.btn--primary {
  background: var(--ck-primary);
  color: #fff;
}
.btn--primary:hover {
  background: var(--ck-primary-hover);
}
.btn--ghost {
  background: var(--ck-surface-2);
  border-color: var(--ck-border);
  color: var(--ck-text);
}
.btn--ghost:hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}

/* Responsive: collapse to fewer columns; columns scroll the page instead. */
@media (max-width: 1024px) {
  .board__columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow-y: auto;
  }
}
@media (max-width: 600px) {
  .board__columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
