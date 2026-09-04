<script setup lang="ts">
/**
 * CavemanToggle — the per-task token-saving control.
 *
 * Two knobs, deliberately independent:
 *   • the CHECKBOX loads (or keeps out) the caveman plugin for this task;
 *   • the SELECTOR picks the compression level.
 *
 * The selector stays usable while the checkbox is off, so a level can be chosen
 * before switching the mode on; the server only speaks to the session when the
 * change is one a running agent can act on.
 *
 * Rendered on the board card AND in the terminal header — same component, same
 * store action, so the two never disagree. On a card it lives inside a
 * click-to-open article, hence `@click.stop` on the wrapper.
 */
import { computed, ref } from "vue";
import { useBoardStore } from "@/store";
import { CAVEMAN_DEFAULT_LEVEL, CAVEMAN_LEVELS, cavemanPending } from "@/types";
import type { CavemanLevel, Task } from "@/types";

const props = defineProps<{
  task: Task;
  /** Card-sized rendering: tighter, no explanatory title text. */
  compact?: boolean;
}>();

const board = useBoardStore();
const saving = ref(false);

/** Human labels; the values themselves are the plugin's own level names. */
const LEVEL_LABEL: Record<CavemanLevel, string> = {
  lite: "Lite · sin relleno",
  full: "Full · frases cortas",
  ultra: "Ultra · máxima compresión",
  "wenyan-lite": "Wenyan lite · chino clásico",
  "wenyan-full": "Wenyan full · chino clásico",
  "wenyan-ultra": "Wenyan ultra · chino clásico",
};

const enabled = computed<boolean>(() => props.task.cavemanEnabled === true);
/** The level shown: the stored one, or the default a fresh tick would use. */
const level = computed<CavemanLevel>(
  () => props.task.cavemanLevel ?? CAVEMAN_DEFAULT_LEVEL,
);

/**
 * The task wants caveman but its session cannot give it yet.
 *
 * Normally invisible: the backend restarts an idle agent by itself, so the box
 * simply works. This survives for the one case where restarting behind the
 * user's back would cost something — an agent in the MIDDLE of a turn — and
 * there it becomes the button that does it when the user says so.
 */
const pending = computed<boolean>(() => cavemanPending(props.task));

/** Whether there is a live agent whose session could be restarted. */
const hasAgent = computed<boolean>(() => props.task.ptyPid !== null);

const title = computed(() => {
  if (pending.value) {
    return "El agente está trabajando: caveman se aplica al reiniciar su sesión";
  }
  return enabled.value
    ? `Caveman ${level.value}: respuestas comprimidas en esta tarea`
    : "Caveman apagado: respuestas normales en esta tarea";
});

async function save(patch: {
  cavemanEnabled?: boolean;
  cavemanLevel?: CavemanLevel;
}): Promise<void> {
  saving.value = true;
  try {
    await board.setCaveman(props.task.id, patch);
  } catch {
    /* The store already rolled the optimistic change back and set `error`. */
  } finally {
    saving.value = false;
  }
}

function onToggle(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  // Ticking a task that never had a level also PERSISTS the default, so what the
  // selector shows and what the session runs are the same thing.
  void save(
    checked && props.task.cavemanLevel === null
      ? { cavemanEnabled: true, cavemanLevel: CAVEMAN_DEFAULT_LEVEL }
      : { cavemanEnabled: checked },
  );
}

function onLevel(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as CavemanLevel;
  if (value === props.task.cavemanLevel) return;
  void save({ cavemanLevel: value });
}

/**
 * Restart the agent so the pending change lands. The session resumes with
 * `claude --continue`, so the conversation survives — but an in-flight turn is
 * cut, hence the confirmation.
 */
async function onRestart(): Promise<void> {
  const ok = window.confirm(
    "Reiniciar la sesión de esta tarea para aplicar caveman.\n\n" +
      "La conversación se retoma con --continue, pero si el agente está " +
      "trabajando ahora, ese turno se corta.",
  );
  if (!ok) return;
  saving.value = true;
  try {
    await board.restartAgent(props.task.id);
  } catch {
    /* The store surfaced the error; the pending badge stays as it was. */
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    class="caveman"
    :class="{ 'caveman--compact': compact, 'is-on': enabled, 'is-saving': saving }"
    :title="title"
    @click.stop
    @keydown.enter.stop
  >
    <label class="caveman__check">
      <input
        type="checkbox"
        :checked="enabled"
        :disabled="saving"
        @change="onToggle"
      />
      <span class="caveman__name">Caveman</span>
    </label>

    <select
      class="caveman__level"
      :value="level"
      :disabled="saving"
      aria-label="Nivel de compresión de caveman"
      @change="onLevel"
    >
      <option v-for="value in CAVEMAN_LEVELS" :key="value" :value="value">
        {{ compact ? value : LEVEL_LABEL[value] }}
      </option>
    </select>

    <!-- The plugin loads only at session start, so a toggle on a live agent is
         pending until it respawns. Say so, and offer the restart. -->
    <button
      v-if="pending && hasAgent"
      class="caveman__pending"
      type="button"
      :disabled="saving"
      title="El agente está en medio de un turno. Reiniciar su sesión aplica caveman ahora (retoma con --continue y corta ese turno)."
      @click="onRestart"
    >
      aplicar ahora
    </button>
    <span
      v-else-if="pending"
      class="caveman__pending caveman__pending--idle"
      title="Se aplicará cuando la tarea abra su sesión"
    >
      al abrir
    </span>
  </div>
</template>

<style scoped>
.caveman {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ck-text-muted);
  cursor: default;
}
.caveman.is-saving {
  opacity: 0.6;
}

.caveman__check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.caveman__check input {
  margin: 0;
  cursor: pointer;
  accent-color: var(--ck-primary);
}
.caveman.is-on .caveman__name {
  color: var(--ck-text);
  font-weight: 600;
}

.caveman__level {
  max-width: 100%;
  padding: 1px 4px;
  font: inherit;
  font-size: 11px;
  color: var(--ck-text-muted);
  background: var(--ck-surface);
  border: 1px solid var(--ck-border);
  border-radius: 6px;
  cursor: pointer;
}
.caveman__level:disabled {
  cursor: default;
}
/* Off: the selector is still usable (pick the level first, switch on after),
   just visibly secondary. */
.caveman:not(.is-on) .caveman__level {
  opacity: 0.65;
}
.caveman.is-on .caveman__level {
  color: var(--ck-text);
  border-color: var(--ck-border-strong);
}

/* Pending: amber, the app's "needs you" colour. A button when it can be applied
   right now, plain text when there is no session to restart. */
.caveman__pending {
  flex: none;
  padding: 1px 6px;
  font: inherit;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--ck-agent-waiting);
  background: var(--ck-agent-waiting-tint);
  border: 1px solid var(--ck-agent-waiting);
  border-radius: 999px;
  white-space: nowrap;
  cursor: pointer;
}
.caveman__pending:hover:not(:disabled) {
  color: #fff;
  background: var(--ck-agent-waiting);
}
.caveman__pending--idle {
  cursor: default;
  opacity: 0.8;
}

.caveman--compact {
  font-size: 11px;
  gap: 4px;
}
.caveman--compact .caveman__level {
  font-size: 10.5px;
  padding: 0 3px;
}
</style>
