<script setup lang="ts">
/**
 * Cross-project conversations sidebar — a persistent "inbox" of every task
 * across all projects, bucketed by its live agent state.
 *
 * Grouping is a computed over the global `store.tasks` array, so when a hook
 * flips a task's `agentState` (reconciled live via the `task:updated` WS event)
 * the task moves groups automatically. The sidebar is independent of the
 * board's selected project: it always lists tasks from ALL projects.
 *
 * Collapsing into a thin rail is persisted to localStorage by the parent
 * (App.vue) via the `collapsed` model, so it survives reloads.
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useBoardStore } from "@/store";
import ConversationGroup from "@/board/ConversationGroup.vue";
import type { AgentState, Task } from "@/types";

const collapsed = defineModel<boolean>("collapsed", { default: false });

const route = useRoute();
const board = useBoardStore();

/** Id of the task open in the terminal route, or null on the board. */
const activeTaskId = computed<string | null>(() => {
  const id = route.params.id;
  return typeof id === "string" ? id : null;
});

/**
 * Sort by `agentStateAt` DESC (most recent first). Tasks lacking a timestamp
 * sink to the bottom and tie-break by title (stable, alphabetical).
 */
function byRecency(a: Task, b: Task): number {
  const ta = a.agentStateAt ? new Date(a.agentStateAt).getTime() : NaN;
  const tb = b.agentStateAt ? new Date(b.agentStateAt).getTime() : NaN;
  const aHas = !Number.isNaN(ta);
  const bHas = !Number.isNaN(tb);
  if (aHas && bHas) return tb - ta;
  if (aHas) return -1;
  if (bHas) return 1;
  return a.title.localeCompare(b.title);
}

/**
 * A task counts toward a working/waiting group ONLY when it is in the "running"
 * ("Corriendo") column — the live agent badge belongs exclusively to running
 * tasks. A task whose agentState is "working"/"waiting" but that has been moved
 * to another column (todo / review / done) falls into "Otras" instead, so the
 * sidebar grouping mirrors the board's per-card gating exactly.
 */
function inState(state: AgentState): Task[] {
  return board.tasks
    .filter((t) => t.status === "running" && t.agentState === state)
    .sort(byRecency);
}

/* ── Groups (computed over the global task list → fully reactive) ─────── */

const waiting = computed<Task[]>(() => inState("waiting"));
const working = computed<Task[]>(() => inState("working"));

/**
 * "Otras": the catch-all — anything NOT surfaced in waiting/working above. That
 * is, every task except a running task whose agentState is "waiting"/"working".
 * Covers non-running tasks (regardless of their stored agentState), running
 * tasks with no/unknown agent state, and done tasks.
 */
const otras = computed<Task[]>(() =>
  board.tasks
    .filter((t) => {
      if (t.status !== "running") return true;
      const s = t.agentState;
      return s !== "waiting" && s !== "working";
    })
    .sort(byRecency),
);

function expand(): void {
  collapsed.value = false;
}
function toggle(): void {
  collapsed.value = !collapsed.value;
}
</script>

<template>
  <aside class="convs" :class="{ 'is-collapsed': collapsed }">
    <!-- ── Collapsed rail ─────────────────────────────────────────── -->
    <template v-if="collapsed">
      <button
        class="convs__rail"
        type="button"
        title="Expandir conversaciones"
        aria-label="Expandir conversaciones"
        @click="expand"
      >
        <span class="convs__rail-toggle" aria-hidden="true">›</span>
        <span
          v-if="waiting.length"
          class="convs__chip"
          data-tone="warn"
          :title="`${waiting.length} te esperan`"
        >
          {{ waiting.length }}
        </span>
        <span
          v-if="working.length"
          class="convs__chip"
          data-tone="calm"
          :title="`${working.length} trabajando`"
        >
          {{ working.length }}
        </span>
      </button>
    </template>

    <!-- ── Expanded sidebar ───────────────────────────────────────── -->
    <template v-else>
      <header class="convs__head">
        <div class="convs__head-top">
          <h2 class="convs__title">Conversaciones</h2>
          <button
            class="convs__toggle"
            type="button"
            title="Colapsar"
            aria-label="Colapsar conversaciones"
            @click="toggle"
          >
            ‹
          </button>
        </div>
      </header>

      <div class="convs__scroll">
        <ConversationGroup
          icon="✦"
          label="Te espera"
          tone="warn"
          :tasks="waiting"
          :active-task-id="activeTaskId"
          show-empty
        />
        <ConversationGroup
          icon="⚙"
          label="Trabajando"
          tone="calm"
          :tasks="working"
          :active-task-id="activeTaskId"
          show-empty
        />

        <ConversationGroup
          icon="◦"
          label="Otras"
          tone="muted"
          :tasks="otras"
          :active-task-id="activeTaskId"
          collapsible
          start-collapsed
        />
      </div>
    </template>
  </aside>
</template>

<style scoped>
.convs {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 280px;
  flex: none;
  background: var(--ck-surface);
  border-right: 1px solid var(--ck-border);
}
.convs.is-collapsed {
  width: 48px;
}

/* ── Collapsed rail ─────────────────────────────────────────────── */
.convs__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 12px 0;
  background: transparent;
  border: none;
}
.convs__rail-toggle {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  color: var(--ck-text-muted);
}
.convs__rail:hover .convs__rail-toggle {
  color: var(--ck-text);
}
.convs__chip {
  display: grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
.convs__chip[data-tone="warn"] {
  background: var(--ck-agent-waiting-tint);
  color: var(--ck-agent-waiting);
}
.convs__chip[data-tone="calm"] {
  background: var(--ck-agent-working-tint);
  color: var(--ck-agent-working);
}

/* ── Expanded header ────────────────────────────────────────────── */
.convs__head {
  flex: none;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--ck-border);
}
.convs__head-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.convs__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.convs__toggle {
  flex: none;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  font-size: 16px;
  line-height: 1;
  color: var(--ck-text-muted);
  background: transparent;
  border: 1px solid var(--ck-border);
  border-radius: 7px;
  transition: background 0.12s ease, color 0.12s ease;
}
.convs__toggle:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

/* ── Scrollable body ────────────────────────────────────────────── */
.convs__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 26px;
  padding: 18px 8px 20px;
}
</style>
