<script setup lang="ts">
/**
 * Root shell. Lays the app out as two columns on every route: a persistent,
 * collapsible conversations sidebar on the left and the active route (board or
 * terminal) on its right.
 *
 * The root owns initial data loading: it bootstraps projects/tasks and opens
 * the live events socket on mount, regardless of which route the user entered
 * on (board, or deep-linked /task/:id). This keeps the always-visible sidebar
 * populated and reactive even when the board view never mounts. It also tears
 * down the events socket on unmount.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useBoardStore } from "@/store";
import ConversationsSidebar from "@/board/ConversationsSidebar.vue";

const board = useBoardStore();

onMounted(() => {
  // Guard against a redundant load if some route already kicked one off.
  if (!board.loading && board.tasks.length === 0) void board.load();
});

onBeforeUnmount(() => board.disconnectEvents());

/** Sidebar collapsed state, persisted across reloads. */
const SIDEBAR_KEY = "ck.sidebar.collapsed";
const sidebarCollapsed = ref<boolean>(readCollapsed());

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

watch(sidebarCollapsed, (val) => {
  try {
    localStorage.setItem(SIDEBAR_KEY, val ? "1" : "0");
  } catch {
    /* storage unavailable (e.g. private mode) — ignore */
  }
});
</script>

<template>
  <div id="ck-app">
    <ConversationsSidebar v-model:collapsed="sidebarCollapsed" />
    <div class="ck-app__main">
      <!-- Key by route path so navigating between tasks (/task/A → /task/B)
           REMOUNTS the view: useTerminal then re-runs with the new id and
           reconnects its websocket. Without the key, vue-router reuses the same
           component instance on a param change and the terminal stays bound to
           the first task (only the reactive title updates). -->
      <RouterView :key="$route.path" />
    </div>
  </div>
</template>

<style>
:root {
  /* Palette — dark Notion: flat surfaces, thin low-contrast borders,
     small elevation steps (bg → surface → surface-2), muted secondary text. */
  --ck-bg: #191919; /* app background, deepest layer */
  --ck-surface: #202020; /* panels: sidebar, board columns */
  --ck-surface-2: #2a2a2a; /* elevated: cards, modals, inputs, popovers */
  --ck-surface-hover: rgba(255, 255, 255, 0.055); /* row/button hover wash */
  --ck-border: #313131; /* hairline borders */
  --ck-border-strong: #404040; /* focus / stronger separators */
  --ck-text: #e6e6e5; /* primary text */
  --ck-text-muted: #9a9a9a; /* secondary text */
  --ck-text-faint: #6b6b6b; /* tertiary / placeholders */
  --ck-primary: #2383e2; /* Notion blue accent */
  --ck-primary-hover: #4a9bea;
  --ck-danger: #eb5757;
  --ck-radius: 8px;
  --ck-shadow: 0 1px 2px rgba(0, 0, 0, 0.30);
  --ck-shadow-lg: 0 8px 28px rgba(0, 0, 0, 0.50);

  /* Status (column) accents. */
  --ck-status-todo: #8a8a8a;
  --ck-status-running: #5e8fd6;
  --ck-status-review: #ffa344;
  --ck-status-done: #4dab9a;

  /* Agent-state accents — defined centrally so sidebar and cards share them. */
  --ck-agent-working: #5e8fd6;
  --ck-agent-waiting: #ffa344;
  --ck-agent-attention: var(--ck-danger);
  --ck-agent-working-tint: rgba(94, 143, 214, 0.14);
  --ck-agent-waiting-tint: rgba(255, 163, 68, 0.14);
  --ck-agent-attention-tint: rgba(235, 87, 87, 0.14);

  font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ck-text);
  font-size: 14px;
  line-height: 1.5;
}

* {
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--ck-border) transparent;
}

html,
body,
#app {
  margin: 0;
  height: 100%;
}

body {
  background: var(--ck-bg);
  color: var(--ck-text);
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: rgba(35, 131, 226, 0.32);
  color: var(--ck-text);
}

/* Dark, low-key custom scrollbars so they don't read as bright bars. */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--ck-border);
  border: 2px solid transparent;
  background-clip: padding-box;
  border-radius: 8px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--ck-border-strong);
  border: 2px solid transparent;
  background-clip: padding-box;
}

#ck-app {
  display: flex;
  height: 100%;
  width: 100%;
  background: var(--ck-bg);
  color: var(--ck-text);
}

/* The route column (board OR terminal) fills the space beside the sidebar
   and owns its own internal scrolling, so it never blows out the layout. */
.ck-app__main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

button {
  font-family: inherit;
  cursor: pointer;
}

input,
textarea,
select {
  font-family: inherit;
  font-size: inherit;
}
</style>
