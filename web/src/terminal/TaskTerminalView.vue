<script setup lang="ts">
/**
 * TaskTerminalView — the per-task terminal screen.
 *
 * Renders a header (task title + back link) and a body split into two stacked
 * panes by a draggable horizontal splitter:
 *   • TOP    — the task's claude terminal (the long-lived pty), via `useTerminal`.
 *   • BOTTOM — the Phase 2 CommandPanel (repo selector + setup/run/teardown
 *              buttons + a secondary command terminal).
 *
 * The splitter drag resizes the BOTTOM pane; the height is persisted to
 * localStorage so it survives reloads/navigation. The claude terminal refits
 * automatically when its container resizes (its own ResizeObserver), so nothing
 * extra is needed to keep it sized through the split.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useBoardStore } from "../store";
import { useTerminal, type TerminalConnectionStatus } from "./useTerminal";
import CommandPanel from "./CommandPanel.vue";
import CavemanToggle from "@/board/CavemanToggle.vue";
import SchemaPanel from "@/schema/SchemaPanel.vue";
import CodePanel from "@/code/CodePanel.vue";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ id: string }>();

/**
 * Which pane fills the view. The terminal half stays mounted either way (see
 * the template) so switching to the schema/code tabs and back never disturbs
 * the pty.
 */
const tab = ref<"terminal" | "schema" | "code">("terminal");

const store = useBoardStore();
const { tasks } = storeToRefs(store);

/** This task from the store, or null before the board has loaded. */
const task = computed(() => tasks.value.find((t) => t.id === props.id) ?? null);

const title = computed(() => task.value?.title ?? props.id);

const terminalEl = ref<HTMLElement | null>(null);
const { status, exitCode } = useTerminal(props.id, terminalEl);

const statusLabel: Record<TerminalConnectionStatus, string> = {
  connecting: "Conectando…",
  open: "Conectado",
  closed: "Reconectando…",
  exited: "Proceso finalizado",
};

/* ── Resizable split (bottom command panel height, persisted). ─────────────── */

const SPLIT_KEY = "ck.terminal.cmdHeight";
const MIN_PANE = 80; // px — keep both panes usable.
const DEFAULT_BOTTOM = 220; // px

const bodyEl = ref<HTMLElement | null>(null);
const bottomHeight = ref<number>(readBottomHeight());

function readBottomHeight(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BOTTOM;
  } catch {
    return DEFAULT_BOTTOM;
  }
}

function persistBottomHeight(): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(bottomHeight.value)));
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Clamp the bottom height so both panes keep at least MIN_PANE px. */
function clampBottom(px: number): number {
  const total = bodyEl.value?.clientHeight ?? 0;
  if (total <= 0) return Math.max(MIN_PANE, px);
  const max = Math.max(MIN_PANE, total - MIN_PANE);
  return Math.min(Math.max(px, MIN_PANE), max);
}

const dragging = ref(false);
let dragStartY = 0;
let dragStartHeight = 0;

function onSplitterDown(ev: PointerEvent): void {
  dragging.value = true;
  dragStartY = ev.clientY;
  dragStartHeight = bottomHeight.value;
  window.addEventListener("pointermove", onSplitterMove);
  window.addEventListener("pointerup", onSplitterUp);
  // Capture so the drag keeps tracking even over the xterm panes.
  (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}

function onSplitterMove(ev: PointerEvent): void {
  if (!dragging.value) return;
  // Dragging up (negative delta) grows the bottom pane.
  const delta = dragStartY - ev.clientY;
  bottomHeight.value = clampBottom(dragStartHeight + delta);
}

function onSplitterUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  window.removeEventListener("pointermove", onSplitterMove);
  window.removeEventListener("pointerup", onSplitterUp);
  persistBottomHeight();
}

/** Keyboard a11y: arrow keys nudge the split. */
function onSplitterKey(ev: KeyboardEvent): void {
  const step = ev.shiftKey ? 40 : 12;
  if (ev.key === "ArrowUp") bottomHeight.value = clampBottom(bottomHeight.value + step);
  else if (ev.key === "ArrowDown") bottomHeight.value = clampBottom(bottomHeight.value - step);
  else return;
  ev.preventDefault();
  persistBottomHeight();
}

function onWindowResize(): void {
  // Re-clamp on viewport change so the split stays valid.
  bottomHeight.value = clampBottom(bottomHeight.value);
}

onMounted(() => {
  bottomHeight.value = clampBottom(bottomHeight.value);
  window.addEventListener("resize", onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("pointermove", onSplitterMove);
  window.removeEventListener("pointerup", onSplitterUp);
});
</script>

<template>
  <div class="terminal-view">
    <header class="terminal-header">
      <RouterLink class="back-link" :to="{ name: 'board' }">
        ← Volver al tablero
      </RouterLink>
      <h1 class="task-title">{{ title }}</h1>

      <nav class="task-tabs">
        <button
          type="button"
          class="task-tab"
          :class="{ 'task-tab--active': tab === 'terminal' }"
          @click="tab = 'terminal'"
        >
          Terminal
        </button>
        <button
          type="button"
          class="task-tab"
          :class="{ 'task-tab--active': tab === 'schema' }"
          title="Esquema declarado por los archivos de esta tarea"
          @click="tab = 'schema'"
        >
          Esquema
        </button>
        <button
          type="button"
          class="task-tab"
          :class="{ 'task-tab--active': tab === 'code' }"
          title="Hotspots de refactorización detectados en el código de esta tarea"
          @click="tab = 'code'"
        >
          Código
        </button>
      </nav>

      <!-- Same control as the board card: toggling here types the plugin's
           command straight into the session shown below. -->
      <CavemanToggle v-if="task" :task="task" />

      <span v-show="tab === 'terminal'" class="conn-status" :data-status="status">
        {{ statusLabel[status]
        }}<template v-if="status === 'exited' && exitCode !== null">
          ({{ exitCode }})</template
        >
      </span>
    </header>

    <!-- The terminal pane stays MOUNTED across tab switches (v-show, not v-if)
         so its pty session, scrollback and websocket survive a visit to the
         schema tab. -->
    <div
      v-show="tab === 'terminal'"
      ref="bodyEl"
      class="terminal-body"
      :class="{ 'terminal-body--dragging': dragging }"
    >
      <!-- TOP: the claude terminal (flexes to fill the space above the split). -->
      <div ref="terminalEl" class="terminal-container" />

      <!-- Draggable horizontal splitter. -->
      <div
        class="terminal-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Redimensionar panel de comandos"
        tabindex="0"
        @pointerdown="onSplitterDown"
        @keydown="onSplitterKey"
      >
        <span class="terminal-splitter__grip" />
      </div>

      <!-- BOTTOM: the command panel (fixed height = bottomHeight). -->
      <div class="terminal-cmd" :style="{ height: bottomHeight + 'px' }">
        <CommandPanel :task-id="props.id" />
      </div>
    </div>

    <div v-show="tab === 'schema'" class="task-schema">
      <SchemaPanel :task-id="props.id" :active="tab === 'schema'" />
    </div>

    <div v-show="tab === 'code'" class="task-code">
      <CodePanel :task-id="props.id" :active="tab === 'code'" />
    </div>
  </div>
</template>

<style scoped>
.terminal-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background: var(--ck-bg);
}

.terminal-header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 0 0 auto;
  padding: 12px 20px;
  background: var(--ck-surface);
  border-bottom: 1px solid var(--ck-border);
  color: var(--ck-text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.back-link {
  color: var(--ck-primary);
  text-decoration: none;
  font-size: 14px;
  white-space: nowrap;
}

.back-link:hover {
  color: var(--ck-primary-hover);
  text-decoration: underline;
}

.task-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ck-text);
}

.conn-status {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--ck-text-muted);
  white-space: nowrap;
}

.conn-status[data-status="open"] {
  color: var(--ck-status-done);
}

.conn-status[data-status="closed"],
.conn-status[data-status="connecting"] {
  color: var(--ck-status-review);
}

.conn-status[data-status="exited"] {
  color: var(--ck-danger);
}

.task-tabs {
  display: flex;
  gap: 2px;
  margin-left: 6px;
}

.task-tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12.5px;
}

.task-tab:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.task-tab--active {
  background: var(--ck-surface-2);
  border-color: var(--ck-border);
  color: var(--ck-text);
}

/* The schema/code panes fill whatever the header leaves, and scroll internally. */
.task-schema,
.task-code {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.terminal-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}

/* While dragging, suppress text selection / iframe pointer capture for a clean drag. */
.terminal-body--dragging {
  cursor: row-resize;
  user-select: none;
}

.terminal-container {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  padding: 4px;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--ck-bg);
}

/* Ensure the xterm viewport fills the available space. */
.terminal-container :deep(.xterm),
.terminal-container :deep(.xterm-viewport),
.terminal-container :deep(.xterm-screen) {
  height: 100%;
  width: 100%;
}

.terminal-splitter {
  flex: 0 0 auto;
  height: 8px;
  cursor: row-resize;
  background: var(--ck-surface);
  border-top: 1px solid var(--ck-border);
  border-bottom: 1px solid var(--ck-border);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}

.terminal-splitter:hover,
.terminal-body--dragging .terminal-splitter {
  background: var(--ck-surface-hover);
}

.terminal-splitter:focus-visible {
  outline: 2px solid var(--ck-primary);
  outline-offset: -2px;
}

.terminal-splitter__grip {
  width: 36px;
  height: 3px;
  border-radius: 2px;
  background: var(--ck-border-strong);
}

.terminal-cmd {
  flex: 0 0 auto;
  min-height: 0;
  width: 100%;
  overflow: hidden;
}
</style>
