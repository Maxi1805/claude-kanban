<script setup lang="ts">
/**
 * RepoScriptsEditor — a compact, reusable editor for ONE repo's three lifecycle
 * scripts (Setup / Run / Teardown).
 *
 * Renders three labelled multiline inputs bound to an object
 * `{ setupScript, runScript, teardownScript }` (each `string | null`). A blank
 * (whitespace-only) field is emitted as `null` so the create DTO / update patch
 * carry "unset" rather than an empty string. The host owns the object via
 * v-model; this component never mutates props in place — every change re-emits a
 * fresh object.
 *
 * Phase 1 scope: this configures the scripts only. Execution (setup on
 * worktree-create, run auto-launch, teardown on delete) is untouched and becomes
 * button-driven in Phase 2.
 */
import { computed } from "vue";

/** The three-script value this editor binds to (each script is string|null). */
export interface RepoScripts {
  setupScript: string | null;
  runScript: string | null;
  teardownScript: string | null;
}

const props = defineProps<{ modelValue: RepoScripts }>();
const emit = defineEmits<{
  (e: "update:modelValue", value: RepoScripts): void;
}>();

/** Stable, never-undefined view of the current value for the textareas. */
const value = computed<RepoScripts>(() => ({
  setupScript: props.modelValue?.setupScript ?? null,
  runScript: props.modelValue?.runScript ?? null,
  teardownScript: props.modelValue?.teardownScript ?? null,
}));

/** Normalize a raw textarea string to `string | null` (blank → null). */
function normalize(raw: string): string | null {
  return raw.trim().length > 0 ? raw : null;
}

/** Re-emit a fresh object with one field replaced (others preserved). */
function update(field: keyof RepoScripts, raw: string): void {
  emit("update:modelValue", { ...value.value, [field]: normalize(raw) });
}
</script>

<template>
  <div class="rse">
    <label class="rse__field">
      <span class="rse__label">Setup</span>
      <textarea
        class="rse__control"
        rows="2"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder="npm install"
        aria-label="Script de setup"
        :value="value.setupScript ?? ''"
        @input="update('setupScript', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>

    <label class="rse__field">
      <span class="rse__label">Run</span>
      <textarea
        class="rse__control"
        rows="2"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder="npm run dev"
        aria-label="Script de run"
        :value="value.runScript ?? ''"
        @input="update('runScript', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>

    <label class="rse__field">
      <span class="rse__label">Teardown</span>
      <textarea
        class="rse__control"
        rows="2"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder="…"
        aria-label="Script de teardown"
        :value="value.teardownScript ?? ''"
        @input="update('teardownScript', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>
  </div>
</template>

<style scoped>
.rse {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rse__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rse__label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ck-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.rse__control {
  width: 100%;
  min-height: 0;
  padding: 7px 9px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  color: var(--ck-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  resize: vertical;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.rse__control::placeholder {
  color: var(--ck-text-faint);
}
.rse__control:focus {
  outline: none;
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}
</style>
