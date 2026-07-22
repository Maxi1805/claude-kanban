<script setup lang="ts">
/**
 * CommandPanel — the bottom half of the task terminal view (SHELL MODEL).
 *
 * For the given task it renders:
 *   • a REPO SELECTOR (tabs) over the task's repos,
 *   • for the selected repo, ONE real INTERACTIVE SHELL terminal
 *     (useCommandTerminal for that repo) that fills the panel — the user can
 *     TYPE directly into it (it is `bash -il` at the repo worktree),
 *   • a row of BUTTONS — "Setup", "Run", "Teardown" — shown ONLY when that repo
 *     defines the corresponding script. A button does NOT spawn its own pty: it
 *     calls api.runCommand(taskId, repoId, kind) which INJECTS the configured
 *     script into that same shell, so its output appears inline in the terminal
 *     the user is typing in. There is no ▶■ running toggle: to stop a `run`
 *     dev-server the user presses Ctrl+C in the shell. After a successful Run
 *     we briefly show the returned :PORT as a chip.
 *
 * Scripts live on the project's repos (ProjectRepo.{setup,run,teardown}Script);
 * the task's repos (TaskRepo) tell us which repos this task spans. We join the
 * two by projectRepoId to know which buttons to render for each repo. After any
 * button click we re-focus the terminal so typing continues.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useBoardStore } from "@/store";
import { api as apiClient } from "@/api/client";
import type { CommandKind, ProjectRepo, TaskRepo } from "@/types";
import { useCommandTerminal } from "./useCommandTerminal";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ taskId: string }>();

const store = useBoardStore();
const { tasks, projects } = storeToRefs(store);

/**
 * `api.runCommand(taskId, repoId, kind)` is added to the concrete API client by
 * the backend slice (web/src/api/client.ts). We reference it through a
 * structural view so this panel type-checks standalone and stays correct once
 * the method lands. It injects the kind's script into the repo shell and
 * returns the freshly-allocated port for a `run` (else null).
 */
type ApiWithRunCommand = typeof apiClient & {
  runCommand(
    taskId: string,
    repoId: string,
    kind: CommandKind,
  ): Promise<{ port?: number | null }>;
};
const api = apiClient as ApiWithRunCommand;

/** The task (with its hydrated repos) from the store. */
const task = computed(() => tasks.value.find((t) => t.id === props.taskId) ?? null);

/** The project this task belongs to (for its repos' scripts). */
const project = computed(() =>
  task.value ? projects.value.find((p) => p.id === task.value!.projectId) ?? null : null,
);

/** ProjectRepo lookup by id, for resolving scripts. */
const projectRepoById = computed<Record<string, ProjectRepo>>(() => {
  const map: Record<string, ProjectRepo> = {};
  for (const r of project.value?.repos ?? []) map[r.id] = r;
  return map;
});

/** The repos this task spans (TaskRepo[]), in stable order. */
const taskRepos = computed<TaskRepo[]>(() => task.value?.repos ?? []);

const KINDS: CommandKind[] = ["setup", "run", "teardown"];
const KIND_LABEL: Record<CommandKind, string> = {
  setup: "Setup",
  run: "Run",
  teardown: "Teardown",
};

function hasScript(pr: ProjectRepo, kind: CommandKind): boolean {
  const script =
    kind === "setup"
      ? pr.setupScript
      : kind === "run"
        ? pr.runScript
        : pr.teardownScript;
  return typeof script === "string" && script.trim().length > 0;
}

/** Which kinds the SELECTED repo has a (non-empty) script for. */
const selectedRepoKinds = computed<CommandKind[]>(() => {
  const repo = taskRepos.value.find((r) => r.projectRepoId === selectedRepoId.value);
  if (!repo) return [];
  const pr = projectRepoById.value[repo.projectRepoId];
  if (!pr) return [];
  return KINDS.filter((k) => hasScript(pr, k));
});

/* ── Selection state (which repo's shell is shown). ────────────────────────── */

/** Selected repoId = the PROJECT repo id (TaskRepo.projectRepoId). */
const selectedRepoId = ref<string | null>(null);

/** The single interactive shell terminal, re-targeted to the selected repo. */
const terminalEl = ref<HTMLElement | null>(null);
const { status, focus, reconnect } = useCommandTerminal(
  props.taskId,
  selectedRepoId,
  terminalEl,
);

/* ── Per-kind inject (button) state. ───────────────────────────────────────── */

/** Per-button busy flag while a runCommand request is in flight. */
const pending = ref<Record<string, boolean>>({});
function isPending(kind: CommandKind): boolean {
  return pending.value[kind] ?? false;
}

/** Last allocated port from a successful Run, shown briefly as a chip. */
const lastPort = ref<number | null>(null);
let portTimer: ReturnType<typeof setTimeout> | null = null;

const actionError = ref<string | null>(null);

/**
 * Click a command button: inject its script into the selected repo's shell via
 * api.runCommand. The output appears in the same terminal. For `run` we surface
 * the returned port as a transient chip. In all cases we keep focus on the
 * terminal so the user can keep typing (e.g. Ctrl+C to stop a dev server).
 */
async function onButton(kind: CommandKind): Promise<void> {
  const repoId = selectedRepoId.value;
  if (!repoId) return;
  actionError.value = null;
  pending.value = { ...pending.value, [kind]: true };
  try {
    const res = await api.runCommand(props.taskId, repoId, kind);
    if (kind === "run" && res && typeof res.port === "number") {
      lastPort.value = res.port;
      if (portTimer !== null) clearTimeout(portTimer);
      portTimer = setTimeout(() => {
        lastPort.value = null;
        portTimer = null;
      }, 6000);
    }
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    const next = { ...pending.value };
    delete next[kind];
    pending.value = next;
    // Keep typing in the shell after a button click.
    void nextTick(() => focus());
  }
}

/** Switch the active repo tab → re-target the shell terminal to that repo. */
function selectRepo(repoId: string): void {
  if (selectedRepoId.value === repoId) {
    focus();
    return;
  }
  selectedRepoId.value = repoId;
  lastPort.value = null;
  // Re-bind the terminal to the newly selected repo's shell (replays buffer).
  reconnect();
  void nextTick(() => focus());
}

/** Default the selection to the first repo once the task's repos are known. */
function ensureSelection(): void {
  const repos = taskRepos.value;
  if (repos.length === 0) return;
  const current = repos.find((r) => r.projectRepoId === selectedRepoId.value);
  if (current) return;
  selectedRepoId.value = repos[0].projectRepoId;
  // The composable's initial connect may have run before repos hydrated.
  reconnect();
}

function repoLabel(repo: TaskRepo): string {
  return repo.repoName || projectRepoById.value[repo.projectRepoId]?.name || repo.projectRepoId;
}

onMounted(() => {
  ensureSelection();
});

// Re-evaluate the default selection once repos/project hydrate (async load).
watch(
  () => [taskRepos.value.length, project.value?.repos?.length] as const,
  () => ensureSelection(),
);
</script>

<template>
  <div class="cmd-panel">
    <div class="cmd-panel__bar">
      <!-- Repo selector (tabs over the task's repos). -->
      <div class="cmd-panel__repos" role="tablist" aria-label="Repos">
        <button
          v-for="repo in taskRepos"
          :key="repo.id"
          type="button"
          role="tab"
          class="cmd-repo-tab"
          :class="{ 'cmd-repo-tab--active': repo.projectRepoId === selectedRepoId }"
          :aria-selected="repo.projectRepoId === selectedRepoId"
          @click="selectRepo(repo.projectRepoId)"
        >
          {{ repoLabel(repo) }}
        </button>
        <span v-if="taskRepos.length === 0" class="cmd-panel__empty">sin repos</span>
      </div>

      <!-- Command buttons for the selected repo (only kinds with a script). -->
      <div v-if="selectedRepoId" class="cmd-panel__actions">
        <button
          v-for="kind in selectedRepoKinds"
          :key="kind"
          type="button"
          class="cmd-btn"
          :class="{ 'cmd-btn--run': kind === 'run' }"
          :disabled="isPending(kind)"
          @click="onButton(kind)"
        >
          {{ KIND_LABEL[kind] }}
        </button>
        <span
          v-if="lastPort !== null"
          class="cmd-port-chip"
          title="Puerto asignado al último Run ($PORT)"
        >:{{ lastPort }}</span>
      </div>

      <span class="cmd-panel__conn" :data-status="status">
        {{ status === "open" ? "" : status === "connecting" ? "conectando…" : "reconectando…" }}
      </span>
    </div>

    <p v-if="actionError" class="cmd-panel__error">{{ actionError }}</p>

    <div ref="terminalEl" class="cmd-panel__term" @mousedown="focus()" />
  </div>
</template>

<style scoped>
.cmd-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  width: 100%;
  background: var(--ck-bg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.cmd-panel__bar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: var(--ck-surface);
  border-top: 1px solid var(--ck-border);
  border-bottom: 1px solid var(--ck-border);
}

.cmd-panel__repos {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.cmd-repo-tab {
  padding: 4px 10px;
  border-radius: var(--ck-radius);
  border: 1px solid transparent;
  background: transparent;
  color: var(--ck-text-muted);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.cmd-repo-tab:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.cmd-repo-tab--active {
  background: var(--ck-surface-2);
  border-color: var(--ck-border-strong);
  color: var(--ck-text);
}

.cmd-panel__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.cmd-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: var(--ck-radius);
  border: 1px solid var(--ck-border);
  background: var(--ck-surface-2);
  color: var(--ck-text);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}

.cmd-btn:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}

.cmd-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.cmd-btn--run {
  border-color: var(--ck-primary);
}

.cmd-port-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: var(--ck-radius);
  border: 1px solid var(--ck-status-done);
  color: var(--ck-status-done);
  font-size: 11.5px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  white-space: nowrap;
}

.cmd-panel__empty {
  font-size: 12px;
  color: var(--ck-text-faint);
}

.cmd-panel__conn {
  margin-left: auto;
  font-size: 11px;
  color: var(--ck-text-muted);
  white-space: nowrap;
}

.cmd-panel__conn[data-status="closed"] {
  color: var(--ck-status-review);
}

.cmd-panel__error {
  margin: 0;
  padding: 6px 12px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--ck-danger);
  background: var(--ck-surface);
  border-bottom: 1px solid var(--ck-border);
}

.cmd-panel__term {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  padding: 4px;
  box-sizing: border-box;
  overflow: hidden;
  background: #161616;
}

.cmd-panel__term :deep(.xterm),
.cmd-panel__term :deep(.xterm-viewport),
.cmd-panel__term :deep(.xterm-screen) {
  height: 100%;
  width: 100%;
}
</style>
