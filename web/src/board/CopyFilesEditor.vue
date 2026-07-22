<script setup lang="ts">
/**
 * CopyFilesEditor — a tiny list editor for a project's "copy files" patterns.
 *
 * Each entry is a RELATIVE path (literal, or a simple basename glob like
 * `.env*`) that the backend copies from every original repo working dir into
 * the matching task worktree (a real copy, not a symlink) — handy for
 * gitignored files such as `.env` that a worktree would otherwise lack.
 *
 * UI: a text input + "Agregar" (or Enter) appends a trimmed path; each entry
 * renders as a removable chip/row. Duplicates and blanks are ignored. The
 * value is bound via v-model (a `string[]`), so the host owns the array.
 */
import { computed, ref } from "vue";

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ (e: "update:modelValue", value: string[]): void }>();

const draft = ref("");

const entries = computed<string[]>(() => props.modelValue ?? []);

function add(): void {
  const path = draft.value.trim();
  if (!path) return;
  if (entries.value.includes(path)) {
    draft.value = "";
    return;
  }
  emit("update:modelValue", [...entries.value, path]);
  draft.value = "";
}

function remove(path: string): void {
  emit(
    "update:modelValue",
    entries.value.filter((p) => p !== path),
  );
}
</script>

<template>
  <div class="cfe">
    <ul v-if="entries.length" class="cfe__list">
      <li v-for="path in entries" :key="path" class="cfe__row">
        <code class="cfe__path">{{ path }}</code>
        <button
          class="cfe__remove"
          type="button"
          aria-label="Quitar archivo"
          @click="remove(path)"
        >
          ✕
        </button>
      </li>
    </ul>

    <div class="cfe__add">
      <input
        v-model="draft"
        class="cfe__input"
        type="text"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder="ruta relativa, p.ej. .env"
        aria-label="Ruta relativa a copiar"
        @keydown.enter.prevent="add"
      />
      <button class="cfe__btn" type="button" :disabled="!draft.trim()" @click="add">
        Agregar
      </button>
    </div>
  </div>
</template>

<style scoped>
.cfe {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cfe__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cfe__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface-2);
}
.cfe__path {
  min-width: 0;
  word-break: break-all;
  color: var(--ck-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}
.cfe__remove {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ck-text-muted);
  font-size: 12px;
  line-height: 1;
}
.cfe__remove:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-danger);
}

.cfe__add {
  display: flex;
  gap: 8px;
}
.cfe__input {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  color: var(--ck-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.cfe__input::placeholder {
  color: var(--ck-text-faint);
}
.cfe__input:focus {
  outline: none;
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}
.cfe__btn {
  flex: none;
  padding: 8px 14px;
  border-radius: var(--ck-radius);
  font-weight: 600;
  border: 1px solid var(--ck-border);
  background: var(--ck-surface);
  color: var(--ck-text);
  font-size: 12.5px;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.cfe__btn:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}
.cfe__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
