<script setup lang="ts">
/**
 * A single kanban card. Shows the task title, the repos it spans, and its
 * status accent. Clicking the card opens its terminal view; the delete button
 * confirms and then asks the store to delete (which triggers backend teardown).
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useBoardStore } from "@/store";
import CavemanToggle from "./CavemanToggle.vue";
import type { AgentState, Task, TaskStatus } from "@/types";

const props = defineProps<{ task: Task }>();

const router = useRouter();
const board = useBoardStore();

const deleting = ref(false);

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Por hacer",
  running: "Corriendo",
  review: "Revisión",
  done: "Hecho",
};

/**
 * Per-task agent ACTIVITY badge — distinct from the kanban column status.
 * Reads `task.agentState`, which the store keeps live via `task:updated` WS
 * events, so the badge reacts automatically as the agent's state changes.
 */
const AGENT_BADGE: Record<AgentState, { icon: string; label: string }> = {
  working: { icon: "⚙", label: "Trabajando" },
  waiting: { icon: "✦", label: "Te espera" },
};

/**
 * The active agent state — but ONLY in the "running" ("Corriendo") column. The
 * working/waiting badge (and the card's --data-agent styling) belong exclusively
 * to a card that is actually running; in any other column the card falls through
 * to its plain stage label via the `<span v-else>`. agentState is NOT cleared in
 * the DB when a card is moved out of running — it's simply not surfaced here
 * unless the task is running. Null when not running, or when the task has no
 * agent state (older tasks).
 */
const agentState = computed<AgentState | null>(() =>
  props.task.status === "running" ? props.task.agentState ?? null : null,
);

/** Badge descriptor for the current agent state, or null to fall back. */
const agentBadge = computed(() =>
  agentState.value ? AGENT_BADGE[agentState.value] : null,
);

/** Whether this card needs the user — drives the prominent card highlight. */
const needsAction = computed(() => agentState.value === "waiting");

/** Repo names this task spans, derived from hydrated task repos when present. */
const repoNames = computed<string[]>(() => {
  const repos = props.task.repos;
  if (repos && repos.length) return repos.map((r) => r.repoName);
  return [];
});

function open(): void {
  void router.push(`/task/${props.task.id}`);
}

async function onDelete(): Promise<void> {
  const ok = window.confirm(
    `¿Eliminar "${props.task.title}"?\n\nEsto detiene la sesión y borra sus worktrees y ramas. No se puede deshacer.`,
  );
  if (!ok) return;
  deleting.value = true;
  try {
    await board.deleteTask(props.task.id);
  } catch (err) {
    window.alert(`No se pudo eliminar la tarea: ${(err as Error).message}`);
    deleting.value = false;
  }
}
</script>

<template>
  <article
    class="task-card"
    :class="{ 'is-deleting': deleting, 'needs-action': needsAction }"
    :data-status="task.status"
    :data-agent="agentState ?? undefined"
    role="button"
    tabindex="0"
    @click="open"
    @keydown.enter="open"
  >
    <header class="task-card__head">
      <h3 class="task-card__title">{{ task.title }}</h3>
      <button
        class="task-card__delete"
        type="button"
        title="Eliminar tarea"
        aria-label="Eliminar tarea"
        :disabled="deleting"
        @click.stop="onDelete"
      >
        ×
      </button>
    </header>

    <p v-if="task.description" class="task-card__desc">{{ task.description }}</p>

    <!-- Token-saving switch for THIS task's session. Its own row so the footer
         keeps reading as repos + state, and so the control never competes with
         the card's click-to-open. -->
    <CavemanToggle :task="task" compact />

    <footer class="task-card__foot">
      <ul v-if="repoNames.length" class="task-card__repos">
        <li v-for="name in repoNames" :key="name" class="task-card__repo">
          {{ name }}
        </li>
      </ul>
      <span v-else class="task-card__repos-empty">sin repos</span>

      <span
        v-if="agentBadge"
        class="task-card__agent"
        :data-agent="agentState"
        :title="`Agente: ${agentBadge.label}`"
      >
        <span class="task-card__agent-icon" aria-hidden="true">{{ agentBadge.icon }}</span>
        {{ agentBadge.label }}
      </span>
      <span v-else class="task-card__status" :data-status="task.status">
        {{ STATUS_LABEL[task.status] }}
      </span>
    </footer>
  </article>
</template>

<style scoped>
.task-card {
  /* Agent-activity accents are defined centrally in App.vue (--ck-agent-*)
     and shared with the sidebar; this card just consumes them. */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 10px;
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-left: 3px solid var(--ck-status-todo);
  border-radius: var(--ck-radius);
  box-shadow: var(--ck-shadow);
  cursor: pointer;
  transition: box-shadow 0.12s ease, transform 0.12s ease, border-color 0.12s ease;
  outline: none;
}
.task-card:hover {
  border-color: var(--ck-border-strong);
  box-shadow: var(--ck-shadow-lg);
}
.task-card:focus-visible {
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}
.task-card.is-deleting {
  opacity: 0.5;
  pointer-events: none;
}

.task-card[data-status="running"] {
  border-left-color: var(--ck-status-running);
}
.task-card[data-status="review"] {
  border-left-color: var(--ck-status-review);
}
.task-card[data-status="done"] {
  border-left-color: var(--ck-status-done);
}

/* ── Agent-activity highlight ─────────────────────────────────────────
   "working" stays calm (no card highlight). "waiting" makes the whole card
   stand out via a thick colored left border + tint + glow, so a card that
   needs the user is impossible to miss. Agent overrides the column border-left
   so the call-to-action wins visually. */
.task-card[data-agent="working"] {
  border-left-color: var(--ck-status-running);
}
.task-card.needs-action {
  border-left-width: 4px;
}
.task-card[data-agent="waiting"] {
  border-left-color: var(--ck-agent-waiting);
  background:
    linear-gradient(
      to right,
      var(--ck-agent-waiting-tint),
      transparent 55%
    ),
    var(--ck-surface-2);
  box-shadow:
    0 0 0 1px var(--ck-agent-waiting),
    var(--ck-shadow);
}

.task-card__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.task-card__title {
  margin: 0;
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-word;
}
.task-card__delete {
  flex: none;
  width: 22px;
  height: 22px;
  margin: -2px -2px 0 0;
  display: grid;
  place-items: center;
  font-size: 18px;
  line-height: 1;
  color: var(--ck-text-muted);
  background: transparent;
  border: none;
  border-radius: 6px;
  transition: background 0.12s ease, color 0.12s ease;
}
.task-card__delete:hover:not(:disabled) {
  background: rgba(235, 87, 87, 0.14);
  color: var(--ck-danger);
}

.task-card__desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--ck-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.task-card__repos {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: 0;
}
.task-card__repo {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--ck-surface-hover);
  border: 1px solid var(--ck-border);
  color: var(--ck-text-muted);
  white-space: nowrap;
}
.task-card__repos-empty {
  font-size: 11px;
  color: var(--ck-text-muted);
  font-style: italic;
}
.task-card__status {
  flex: none;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 999px;
  color: #fff;
  background: var(--ck-status-todo);
}
.task-card__status[data-status="running"] {
  background: var(--ck-status-running);
}
.task-card__status[data-status="review"] {
  background: var(--ck-status-review);
}
.task-card__status[data-status="done"] {
  background: var(--ck-status-done);
}

/* ── Agent-activity badge pill ────────────────────────────────────────
   Replaces the column-status pill when the task has an agent state. The
   "working" pill is calm (subtle/neutral); "waiting" is solid, saturated,
   and clearly more prominent. */
.task-card__agent {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.task-card__agent-icon {
  font-size: 11px;
  line-height: 1;
}
/* working: calm, low-chrome — soft tint, no fill. */
.task-card__agent[data-agent="working"] {
  color: var(--ck-status-running);
  background: var(--ck-agent-working-tint);
}
/* waiting: amber, solid — needs the user. */
.task-card__agent[data-agent="waiting"] {
  color: #fff;
  background: var(--ck-agent-waiting);
}
</style>
