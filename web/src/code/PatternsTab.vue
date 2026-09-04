<script setup lang="ts">
/**
 * "Patrones" — OLA BA, FRENTE BA2.
 *
 * Las propuestas de los PATRONES DE DISEÑO, sacadas de la lista principal y
 * leídas acá. La lista principal (Mapa/Lista) queda con las familias de
 * REFACTORIZACIÓN. Son dos poblaciones con varas muy distintas —el informe
 * BA1 las mide en 28,3 % y 68,0 % de precisión— y mezclarlas en una sola
 * lista hace que el número bueno cargue con el malo.
 *
 * ES UN MOVIMIENTO PURAMENTE VISUAL. No hay acá ni un contador, ni un
 * estado, ni un descarte, ni una estadística: un patrón descartado sigue
 * contando exactamente donde contaba, y lo único que cambia es dónde se ve.
 * Por eso esta pestaña no tiene botón de descarte propio — descartar es una
 * acción sobre el HALLAZGO, y su lugar sigue siendo la tarjeta de la lista.
 *
 * El criterio es `hypothesis.layer`, jamás el nombre del patrón: ver el
 * bloque CAPA de `hypotheses.ts` para el caso medido que eso evita.
 */
import { computed } from "vue";

import type { CodeAnalysis } from "@/types";
import { formatLocation } from "./findings";
import { LAYER_LABELS, stateMeta } from "./hypotheses";
import HypothesisBlock from "./HypothesisBlock.vue";
import {
  collectHypothesesOfLayer,
  groupByPattern,
  hypothesisAnchorFile,
  type AppliedHypothesis,
} from "./tabs";

const props = defineProps<{
  analysis: CodeAnalysis;
  /**
   * El MISMO filtro que la barra ya aplica en Mapa/Lista, no uno nuevo: sin
   * esto, un hallazgo descartado seguiría apareciendo acá aunque el usuario
   * lo tenga oculto en todo el resto del panel.
   */
  showDiscarded: boolean;
}>();

const emit = defineEmits<{
  (e: "open-file", file: string): void;
  (e: "focus-finding", findingId: string): void;
  (e: "focus-place", payload: { file: string; line: number }): void;
}>();

const findings = computed(() =>
  props.showDiscarded ? props.analysis.findings : props.analysis.findings.filter((f) => !f.discarded),
);

const items = computed(() => collectHypothesesOfLayer(findings.value, "patron"));
const groups = computed(() => groupByPattern(items.value));

/** Cuántos hallazgos distintos anclan al menos una propuesta de patrón. */
const anchorCount = computed(() => new Set(items.value.map((i) => i.hypothesis.anchorFindingId)).size);

function locationOf(item: AppliedHypothesis): string | null {
  const loc = item.finding.locations[0];
  if (loc) return formatLocation(loc);
  return hypothesisAnchorFile(item);
}

function openItem(item: AppliedHypothesis): void {
  const file = hypothesisAnchorFile(item);
  if (file) emit("open-file", file);
  if (item.finding.id) emit("focus-finding", item.finding.id);
}

function onFocusPlace(payload: { file: string; line: number }): void {
  emit("focus-place", payload);
}
</script>

<template>
  <section class="pt">
    <header class="pt__head">
      <h2 class="pt__title">{{ LAYER_LABELS.patron }}</h2>
      <p class="pt__subtitle">
        Las propuestas de patrón viven acá, separadas de la lista principal —
        que queda con las familias de refactorización. Son dos poblaciones
        distintas y se leen con varas distintas; mezclarlas es lo que hacía
        ilegible a las dos.
      </p>
      <p v-if="items.length" class="pt__counts">
        {{ items.length }} propuestas de {{ groups.length }} patrones, sobre
        {{ anchorCount }} hallazgos.
      </p>
    </header>

    <p v-if="items.length === 0" class="pt__empty">
      Ninguna hipótesis de patrón de diseño en este análisis
      <template v-if="!showDiscarded">(entre los hallazgos no descartados)</template>. Las
      propuestas de refactorización, si las hay, siguen en Mapa y Lista.
    </p>

    <div v-else class="pt__groups">
      <article
        v-for="g in groups"
        :key="g.pattern"
        class="pt__group"
        :class="{ 'pt__group--bridged': g.hasBridged }"
      >
        <h3 class="pt__pattern">
          {{ g.pattern }}
          <span class="pt__pattern-count">{{ g.items.length }}</span>
        </h3>

        <ul class="pt__rows">
          <li v-for="item in g.items" :key="item.hypothesis.anchorFindingId" class="pt__row">
            <header class="pt__row-head">
              <span class="pt__state" :class="`pt__state--${stateMeta(item.hypothesis.state).className}`">
                {{ stateMeta(item.hypothesis.state).icon }} {{ stateMeta(item.hypothesis.state).label }}
              </span>
              <span class="pt__finding-title">{{ item.finding.title }}</span>
              <button
                v-if="locationOf(item)"
                type="button"
                class="pt__loc"
                title="Abrir este archivo en el mapa"
                @click="openItem(item)"
              >
                {{ locationOf(item) }}
              </button>
            </header>

            <HypothesisBlock :hypothesis="item.hypothesis" @focus-place="onFocusPlace" />
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped>
.pt {
  padding: 4px 2px 24px;
}

.pt__head {
  margin-bottom: 14px;
}

.pt__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ck-text);
}

.pt__subtitle,
.pt__counts,
.pt__empty {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ck-text-muted);
}

.pt__counts {
  color: var(--ck-text-faint);
  font-size: 11.5px;
}

.pt__groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pt__group {
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius, 8px);
  background: var(--ck-surface);
  padding: 10px 12px;
}

.pt__group--bridged {
  border-color: var(--ck-status-review);
}

.pt__pattern {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ck-text);
}

.pt__pattern-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--ck-text-faint);
}

.pt__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pt__row {
  border-top: 1px dashed var(--ck-border);
  padding-top: 8px;
  /* OLA BA, FRENTE BA2 — el mismo salto de layout que la lista principal:
     el navegador no maqueta ni pinta lo que está fuera de pantalla, pero la
     fila SIGUE en el DOM, así que el filtro, la búsqueda del navegador y el
     scroll a un lugar concreto siguen funcionando. */
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}

.pt__row:first-child {
  border-top: none;
  padding-top: 0;
}

.pt__row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.pt__state {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-faint);
}

.pt__state--bridged {
  color: var(--ck-status-review);
}

.pt__state--applied {
  color: var(--ck-status-done);
}

.pt__finding-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ck-text);
  overflow-wrap: break-word;
}

.pt__loc {
  flex: 0 0 auto;
  border: none;
  background: none;
  padding: 0;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--ck-text-faint);
  cursor: pointer;
  text-decoration: underline dotted;
}

.pt__loc:hover {
  color: var(--ck-text);
}
</style>
