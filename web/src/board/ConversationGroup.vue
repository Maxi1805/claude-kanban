<script setup lang="ts">
/**
 * A labelled group of conversation rows in the sidebar (e.g. "✦ Te espera").
 *
 * Renders an icon + label + count header and the list of items. When
 * `collapsible` is set the header becomes a ▸/▾ toggle that hides the list
 * (used by the always-shown "Otras" group, which starts collapsed).
 */
import { ref } from "vue";
import ConversationItem from "@/board/ConversationItem.vue";
import type { Task } from "@/types";

const props = defineProps<{
  icon: string;
  label: string;
  tasks: Task[];
  /** Tone drives the header accent: "warn" | "calm" | "muted". */
  tone: "warn" | "calm" | "muted";
  activeTaskId: string | null;
  collapsible?: boolean;
  /** Initial collapsed state when collapsible (e.g. "Otras" starts collapsed). */
  startCollapsed?: boolean;
  /** Render the header (and a muted empty hint) even when there are no tasks. */
  showEmpty?: boolean;
}>();

const collapsed = ref(props.collapsible ? props.startCollapsed ?? false : false);

function toggle(): void {
  if (props.collapsible) collapsed.value = !collapsed.value;
}
</script>

<template>
  <section class="conv-group" :data-tone="tone">
    <component
      :is="collapsible ? 'button' : 'div'"
      class="conv-group__head"
      :type="collapsible ? 'button' : undefined"
      :aria-expanded="collapsible ? String(!collapsed) : undefined"
      @click="toggle"
    >
      <span v-if="collapsible" class="conv-group__caret" aria-hidden="true">
        {{ collapsed ? "▸" : "▾" }}
      </span>
      <span class="conv-group__icon" aria-hidden="true">{{ icon }}</span>
      <span class="conv-group__label">{{ label }}</span>
      <span class="conv-group__count">{{ tasks.length }}</span>
    </component>

    <ul v-show="!collapsed" v-if="tasks.length" class="conv-group__list">
      <ConversationItem
        v-for="task in tasks"
        :key="task.id"
        :task="task"
        :active="task.id === activeTaskId"
      />
    </ul>
    <p v-else-if="showEmpty && !collapsed" class="conv-group__empty">nada por ahora</p>
  </section>
</template>

<style scoped>
.conv-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 8px;
  margin-bottom: 6px;
  background: transparent;
  border: none;
  border-radius: var(--ck-radius);
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ck-text-faint);
}
button.conv-group__head {
  cursor: pointer;
}
button.conv-group__head:hover {
  background: var(--ck-surface-hover);
}

.conv-group__caret {
  flex: none;
  width: 12px;
  font-size: 10px;
  color: var(--ck-text-faint);
}
.conv-group__icon {
  font-size: 12px;
}
.conv-group__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-group__count {
  flex: none;
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 999px;
  text-align: center;
  font-size: 10.5px;
  font-weight: 700;
  background: var(--ck-surface-2);
  color: var(--ck-text-muted);
}

/* Tone accents — "needs you" groups read as prominent vs the calm rest. */
.conv-group[data-tone="warn"] .conv-group__head,
.conv-group[data-tone="warn"] .conv-group__icon {
  color: var(--ck-agent-waiting);
}
.conv-group[data-tone="warn"] .conv-group__count {
  background: var(--ck-agent-waiting-tint);
  color: var(--ck-agent-waiting);
}
.conv-group[data-tone="calm"] .conv-group__head,
.conv-group[data-tone="calm"] .conv-group__icon {
  color: var(--ck-agent-working);
}
.conv-group[data-tone="calm"] .conv-group__count {
  background: var(--ck-agent-working-tint);
  color: var(--ck-agent-working);
}

.conv-group__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
}
.conv-group__empty {
  margin: 0;
  padding: 2px 9px 2px 28px;
  font-size: 11.5px;
  font-style: italic;
  color: var(--ck-text-faint);
}
</style>
