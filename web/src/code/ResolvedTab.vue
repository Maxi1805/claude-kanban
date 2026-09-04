<script setup lang="ts">
/**
 * "Ya resuelto" — CONTRATO-F7.md §3.3 (Frente D). BRECHA DECLARADA.
 *
 * No hay historia: no existe una tabla de análisis anteriores (`code_graphs`
 * cachea por firma de árbol, `code-decisions` guarda descartes — ninguno de
 * los dos es un snapshot de corrida), así que "esto desapareció desde la
 * corrida anterior" es hoy inexpresable. Esta pestaña muestra lo único
 * medible sin esa historia: las hipótesis `ya-aplicado` (el motor confirmó
 * HOY que la abstracción existe y no se puentea), con un cartel permanente
 * que dice la brecha en la cara en vez de fingir una lista de "resueltos".
 */
import { computed } from "vue";

import type { CodeAnalysis } from "@/types";
import {
  collectResolvedHypotheses,
  RESOLVED_GAP_NOTE,
  RESOLVED_NO_HISTORY_NOTICE,
  type AppliedHypothesis,
} from "./tabs";

const props = defineProps<{ analysis: CodeAnalysis }>();
const emit = defineEmits<{ (e: "open-file", file: string): void }>();

const resolved = computed(() => collectResolvedHypotheses(props.analysis));

function primaryFileOf(item: AppliedHypothesis): string {
  return item.hypothesis.places[0]?.file ?? item.finding.locations[0]?.file ?? "";
}
</script>

<template>
  <section class="resv">
    <p class="resv__notice">{{ RESOLVED_NO_HISTORY_NOTICE }}</p>

    <section class="resv__block">
      <h3 class="resv__block-title">Patrones ya aplicados (verificado hoy)</h3>
      <p v-if="resolved.length === 0" class="resv__empty">
        Ninguna hipótesis llegó a "ya aplicado" en este análisis. Si alguna quedó
        "aplicado-eludido" (la abstracción existe pero código la puentea), vive en la pestaña
        Arquitectura, no acá: mientras se puentea, no está resuelto.
      </p>
      <ul v-else class="resv__list">
        <li v-for="item in resolved" :key="item.hypothesis.anchorFindingId" class="resv__row">
          <span class="resv__badge">✓ Ya aplicado</span>
          <strong class="resv__pattern">{{ item.hypothesis.pattern }}</strong>
          <button type="button" class="resv__file" @click="emit('open-file', primaryFileOf(item))">
            {{ primaryFileOf(item) }}
          </button>
        </li>
      </ul>
    </section>

    <section class="resv__gap">
      <h3 class="resv__block-title">Lo que esta pestaña NO puede mostrar</h3>
      <p class="resv__gap-note">{{ RESOLVED_GAP_NOTE }}</p>
    </section>
  </section>
</template>

<style scoped>
.resv {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 24px;
}

.resv__notice {
  margin: 0;
  background: rgba(255, 163, 68, 0.12);
  border: 1px solid rgba(255, 163, 68, 0.4);
  border-radius: var(--ck-radius, 8px);
  padding: 10px 14px;
  font-size: 12.5px;
  color: var(--ck-text);
}

.resv__block {
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius, 8px);
  padding: 14px 16px;
  background: var(--ck-surface);
}

.resv__block-title {
  margin: 0 0 10px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-muted);
}

.resv__empty {
  margin: 0;
  color: var(--ck-text-muted);
  font-size: 13px;
}

.resv__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.resv__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
}

.resv__badge {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(77, 171, 154, 0.16);
  color: #4dab9a;
  border: 1px solid rgba(77, 171, 154, 0.5);
  white-space: nowrap;
}

.resv__file {
  background: none;
  border: none;
  color: var(--ck-primary);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline dotted;
}

.resv__file:hover {
  color: var(--ck-primary-hover);
}

.resv__gap {
  border: 1px dashed var(--ck-border-strong);
  border-radius: var(--ck-radius, 8px);
  padding: 12px 16px;
}

.resv__gap-note {
  margin: 0;
  font-size: 12.5px;
  color: var(--ck-text-muted);
}
</style>
