<script setup lang="ts">
/**
 * One kanban column. Renders a draggable list of TaskCards for a single status.
 *
 * Drag-and-drop is handled by vuedraggable using a shared `group` so cards can
 * move between columns. We bind the column's tasks with `v-model` and emit a
 * `move` event whenever a card is dropped into THIS column (the `add` event),
 * which the parent translates into a status PATCH.
 */
import type { Component } from "vue";
import draggableComponent from "vuedraggable";
import TaskCard from "@/board/TaskCard.vue";
import type { Task, TaskStatus } from "@/types";

// vuedraggable's bundled types only declare a subset of its props/events
// (it forwards the rest to SortableJS). Cast to a permissive Component so the
// template can use `group`, `animation`, `ghost-class`, `drag-class` and the
// `@add` event without tripping vue-tsc.
const draggable = draggableComponent as unknown as Component;

defineProps<{
  status: TaskStatus;
  label: string;
  tasks: Task[];
}>();

const emit = defineEmits<{
  /** A card was dropped into this column → move it to `status`. */
  (e: "move", payload: { taskId: string; status: TaskStatus }): void;
}>();

interface DraggableAddEvent {
  item: HTMLElement;
}

function onAdd(status: TaskStatus, evt: DraggableAddEvent): void {
  const taskId = evt.item?.dataset?.taskId;
  if (taskId) emit("move", { taskId, status });
}
</script>

<template>
  <section class="column" :data-status="status">
    <header class="column__head">
      <span class="column__dot" :data-status="status" />
      <h2 class="column__title">{{ label }}</h2>
      <span class="column__count">{{ tasks.length }}</span>
    </header>

    <draggable
      class="column__list"
      :model-value="tasks"
      :group="{ name: 'tasks', pull: true, put: true }"
      item-key="id"
      :animation="160"
      ghost-class="column__ghost"
      drag-class="column__drag"
      @add="(evt: DraggableAddEvent) => onAdd(status, evt)"
    >
      <template #item="{ element }">
        <div class="column__item" :data-task-id="(element as Task).id">
          <TaskCard :task="element as Task" />
        </div>
      </template>

      <template #footer>
        <p v-if="tasks.length === 0" class="column__empty">
          Arrastra tarjetas aquí
        </p>
      </template>
    </draggable>
  </section>
</template>

<style scoped>
.column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--ck-surface);
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  max-height: 100%;
}

.column__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ck-border);
}
.column__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ck-status-todo);
  flex: none;
}
.column__dot[data-status="running"] {
  background: var(--ck-status-running);
}
.column__dot[data-status="review"] {
  background: var(--ck-status-review);
}
.column__dot[data-status="done"] {
  background: var(--ck-status-done);
}
.column__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  flex: 1;
}
.column__count {
  font-size: 12px;
  font-weight: 600;
  color: var(--ck-text-muted);
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-radius: 999px;
  min-width: 22px;
  text-align: center;
  padding: 1px 7px;
}

.column__list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  min-height: 60px;
}

.column__item {
  /* wrapper carries data-task-id so vuedraggable's add event can read it */
}

.column__empty {
  margin: 8px 0;
  padding: 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--ck-text-muted);
  border: 1px dashed var(--ck-border);
  border-radius: var(--ck-radius);
}

.column__ghost {
  opacity: 0.4;
}
.column__drag {
  cursor: grabbing;
}
</style>
