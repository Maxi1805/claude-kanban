<script setup lang="ts">
/**
 * A single conversation row in the cross-project sidebar.
 *
 * Shows a state-colored dot, the task title (truncated, full title on hover),
 * the resolved project name (muted), and an optional relative "hace Xm" derived
 * from `agentStateAt`. Clicking navigates to the task's terminal view; the row
 * highlights when it matches the active route.
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useBoardStore } from "@/store";
import type { AgentState, Task } from "@/types";

const props = defineProps<{ task: Task; active: boolean }>();

const router = useRouter();
const board = useBoardStore();

/** Effective dot state; "otras" tasks (no agent state) render a neutral dot. */
const dotState = computed<AgentState | "idle">(() => props.task.agentState ?? "idle");

/** Project name resolved from the store, or a graceful fallback. */
const projectName = computed<string>(() => {
  const project = board.projects.find((p) => p.id === props.task.projectId);
  return project?.name ?? "—";
});

/** Short relative age ("hace Xm" / "Xh" / "Xd"), or null when no timestamp. */
const relativeAge = computed<string | null>(() => {
  const at = props.task.agentStateAt;
  if (!at) return null;
  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "ahora";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
});

function open(): void {
  void router.push(`/task/${props.task.id}`);
}
</script>

<template>
  <li class="conv-item">
    <button
      class="conv-item__btn"
      type="button"
      :class="{ 'is-active': active }"
      :data-agent="dotState"
      @click="open"
    >
      <span class="conv-item__dot" :data-agent="dotState" aria-hidden="true" />
      <span class="conv-item__body">
        <span class="conv-item__title" :title="task.title">{{ task.title }}</span>
        <span class="conv-item__meta">
          <span class="conv-item__project">{{ projectName }}</span>
          <span v-if="relativeAge" class="conv-item__age">· {{ relativeAge }}</span>
        </span>
      </span>
    </button>
  </li>
</template>

<style scoped>
.conv-item {
  list-style: none;
}
.conv-item__btn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--ck-text);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.conv-item__btn:hover {
  background: var(--ck-surface-hover);
}
.conv-item__btn.is-active {
  background: var(--ck-agent-working-tint);
  border-color: var(--ck-border-strong);
}
.conv-item__btn:focus-visible {
  outline: none;
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 2px rgba(35, 131, 226, 0.35);
}

.conv-item__dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 999px;
  background: var(--ck-status-todo);
}
.conv-item__dot[data-agent="working"] {
  background: var(--ck-agent-working);
}
.conv-item__dot[data-agent="waiting"] {
  background: var(--ck-agent-waiting);
}

.conv-item__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.conv-item__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv-item__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--ck-text-muted);
}
.conv-item__project {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv-item__age {
  flex: none;
  white-space: nowrap;
}
</style>
