<script setup lang="ts">
/**
 * "Descartados" — CONTRATO-F7.md §3.2 (Frente D).
 *
 * `discarded` viaja EN el ítem (`code-inspector.ts#decorate`, F2): el
 * payload nunca filtra un hallazgo descartado, así que esta pestaña no pide
 * nada nuevo — sólo lee `findings` con `discarded != null`, algo que
 * Mapa/Lista ya excluyen. Acá es el único lugar donde vuelven a verse, con
 * su motivo y su fecha, y con Restaurar disponible.
 */
import { computed } from "vue";

import type { CodeAnalysis } from "@/types";
import { discardedItems } from "./tabs";

const props = defineProps<{ analysis: CodeAnalysis }>();
const emit = defineEmits<{
  (e: "restore", id: string): void;
  (e: "open-file", file: string): void;
}>();

const items = computed(() => discardedItems(props.analysis));

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" });
}
</script>

<template>
  <section class="disc">
    <header class="disc__head">
      <h2 class="disc__title">Descartados <span class="disc__count">({{ items.length }})</span></h2>
      <p class="disc__note">
        Hallazgos descartados con un motivo, por este repositorio. Mapa y Lista ya los excluyen
        — acá quedan visibles, tachados, con su motivo y fecha.
      </p>
    </header>

    <p v-if="items.length === 0" class="disc__empty">Nada descartado todavía en este repositorio.</p>

    <ul v-else class="disc__list">
      <li v-for="(item, i) in items" :key="`${item.itemKind}-${item.id}-${i}`" class="disc__item">
        <span class="disc__tag" :class="`disc__tag--${item.itemKind}`">
          {{ item.tag }}
        </span>
        <span class="disc__item-title">{{ item.title }}</span>
        <span class="disc__reason">{{ item.discarded.reason }}</span>
        <span class="disc__date">{{ formatDate(item.discarded.decidedAt) }}</span>
        <button
          v-if="item.file"
          type="button"
          class="disc__open"
          :title="item.file"
          @click="emit('open-file', item.file)"
        >
          {{ item.file }}
        </button>
        <button type="button" class="disc__restore" @click="emit('restore', item.id)">Restaurar</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.disc {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 24px;
}

.disc__title {
  margin: 0 0 4px;
  font-size: 16px;
}

.disc__count {
  color: var(--ck-text-muted);
  font-weight: 400;
}

.disc__note {
  margin: 0;
  color: var(--ck-text-muted);
  font-size: 12.5px;
}

.disc__empty {
  color: var(--ck-text-muted);
  font-size: 13px;
}

.disc__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.disc__item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 4px 10px;
  align-items: baseline;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius, 8px);
  padding: 10px 12px;
  background: var(--ck-surface);
}

.disc__tag {
  grid-column: 1;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-faint);
  border: 1px solid var(--ck-border-strong);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
  height: fit-content;
}

.disc__item-title {
  grid-column: 2;
  font-weight: 600;
  text-decoration: line-through;
  color: var(--ck-text-muted);
}

.disc__date {
  grid-column: 3;
  color: var(--ck-text-faint);
  font-size: 11.5px;
  white-space: nowrap;
}

.disc__reason {
  grid-column: 2 / span 2;
  font-size: 12.5px;
  color: var(--ck-text);
}

.disc__open {
  grid-column: 2 / span 2;
  justify-self: start;
  background: none;
  border: none;
  color: var(--ck-primary);
  cursor: pointer;
  padding: 0;
  font: inherit;
  font-size: 11.5px;
}

.disc__open:hover {
  color: var(--ck-primary-hover);
}

.disc__restore {
  grid-column: 3;
  justify-self: end;
  background: var(--ck-surface-hover);
  border: 1px solid var(--ck-border-strong);
  border-radius: 6px;
  color: var(--ck-text);
  cursor: pointer;
  font-size: 11.5px;
  padding: 3px 10px;
}

.disc__restore:hover {
  background: var(--ck-primary);
  color: #fff;
  border-color: var(--ck-primary);
}
</style>
