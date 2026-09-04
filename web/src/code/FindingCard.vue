<script setup lang="ts">
/**
 * Una tarjeta de hallazgo — CONTRATO-F7.md Contrato 1. Jerarquía fija:
 * severidad → refactor mecánico (`advice.primary`, siempre, grande) →
 * hipótesis de patrón (subordinada, indentada, ver `HypothesisBlock.vue`).
 * `advice.primary` se dibuja aunque no haya hipótesis; sin `hypotheses` no
 * hay bloque y no hay hueco.
 *
 * Componente autocontenido (no conoce `taskId`/`repoName`): `discard` sólo
 * avisa CUÁL hallazgo el usuario quiere descartar — CodePanel.vue (el único
 * con contexto de repo/tarea) es quien de verdad llama a la API y muestra el
 * prompt de motivo, exactamente como ya lo hacía antes de esta tarjeta
 * existir.
 */
import { computed } from "vue";
import type { CodeFinding, CodeFindingHypothesisLayer, CodeLocation } from "@/types";
import { formatLocation, kindLabel, severityTier } from "./findings";
import { ofLayer, openProposals, sortHypotheses } from "./hypotheses";
import HypothesisBlock from "./HypothesisBlock.vue";

const props = defineProps<{
  finding: CodeFinding;
  /** `true` en la vista ego / mapa: la tarjeta se compacta (sin ubicaciones largas). */
  compact?: boolean;
  /** Fuerza abierto TODAS las hipótesis; sin esto, sólo `aplicado-eludido` arranca abierta. */
  expandedHypotheses?: boolean;
  /**
   * OLA BA, FRENTE BA2 — qué CAPA de hipótesis dibuja la tarjeta. La lista
   * principal pasa `"refactorizacion"`: las propuestas de patrón se leen en
   * su propia pestaña (ver `PatternsTab.vue`), no acá.
   *
   * Ausente ⇒ TODAS, que es el comportamiento histórico — así ningún otro
   * montaje de esta tarjeta (vista ego, mapa) pierde nada por omisión.
   * Filtrar acá es un recorte de PANTALLA: no toca `finding.hypotheses`, ni
   * un contador, ni un estado.
   */
  layer?: CodeFindingHypothesisLayer;
  /**
   * OLA BB, FRENTE BB2 — `true` esconde las hipótesis de los dos estados
   * "la abstracción ya existe" (`ya-aplicado`, `aplicado-eludido`). La lista
   * principal lo pasa: esas dos se leen en Arquitectura, donde ya vivían.
   *
   * Ausente ⇒ TODAS, igual que `layer` — así ningún otro montaje de esta
   * tarjeta (vista ego, mapa) pierde nada por omisión. Y, como `layer`, es un
   * recorte de PANTALLA: no toca `finding.hypotheses`, ni un contador, ni un
   * estado, ni el descarte.
   */
  hideApplied?: boolean;
}>();

const emit = defineEmits<{
  (e: "discard", findingId: string): void;
  (e: "open-file", payload: { file: string; line: number }): void;
  (e: "focus-place", payload: { file: string; line: number }): void;
}>();

const tier = computed(() => severityTier(props.finding.severity));

/**
 * DECLARADO: `kindLabel` acá corre SIN el catálogo por análisis
 * (`analysis.kinds`) — la interfaz congelada de esta tarjeta (CONTRATO-F7.md
 * §1.6) no recibe el análisis completo, sólo `finding`. Para los 8 kinds
 * legados y para cualquier slug humanizable esto no cambia nada; el único
 * costo es un kind nuevo, sin entrada legada, que llegara con una etiqueta
 * MÁS linda desde el catálogo — acá cae al slug humanizado en su lugar.
 */
const kindText = computed(() => kindLabel(props.finding.kind));

/** Ordenadas: aplicado-eludido primero, no-aplicable al final — `hypotheses.ts#sortHypotheses`. */
const hypotheses = computed(() => {
  const all = props.finding.hypotheses ?? [];
  const ofThisLayer = props.layer ? ofLayer(all, props.layer) : all;
  return sortHypotheses(props.hideApplied ? openProposals(ofThisLayer) : ofThisLayer);
});

function openLocation(loc: CodeLocation): void {
  emit("open-file", { file: loc.file, line: loc.startLine });
}

function onFocusPlace(payload: { file: string; line: number }): void {
  emit("focus-place", payload);
}
</script>

<template>
  <div class="fc" :class="`fc--${tier}`">
    <div class="fc__bar" />
    <div class="fc__body">
      <header class="fc__head">
        <span class="fc__kind">{{ kindText }}</span>
        <h3 class="fc__title">{{ finding.title }}</h3>
        <span class="fc__severity" :title="`Severidad ${finding.severity}/100`">{{ finding.severity }}</span>
      </header>

      <p class="fc__metric">{{ finding.metric.label }}: {{ finding.metric.value }}</p>
      <p v-if="!compact" class="fc__detail">{{ finding.detail }}</p>

      <ul v-if="!compact" class="fc__locations">
        <li v-for="(loc, li) in finding.locations" :key="li">
          <button type="button" class="fc__loc-link" @click="openLocation(loc)">{{ formatLocation(loc) }}</button>
        </li>
      </ul>

      <!-- ►► ARREGLO — mecánico, siempre, primero. Nunca condicionado a que haya hipótesis. -->
      <div v-if="finding.advice" class="fc__advice">
        <div class="fc__fix">
          <span class="fc__fix-label">Arreglo</span>
          <a class="fc__fix-link" :href="finding.advice.primary.source" target="_blank" rel="noopener noreferrer">
            {{ finding.advice.primary.name }}
          </a>
          <span class="fc__fix-why">{{ finding.advice.primary.why }}</span>
        </div>

        <div v-if="finding.advice.pattern" class="fc__fix fc__fix--pattern">
          <span class="fc__fix-label">Puede converger en</span>
          <a class="fc__fix-link" :href="finding.advice.pattern.source" target="_blank" rel="noopener noreferrer">
            {{ finding.advice.pattern.name }}
          </a>
          <span class="fc__fix-why">{{ finding.advice.pattern.why }}</span>
          <span v-if="finding.advice.pattern.caveat" class="fc__caveat">{{ finding.advice.pattern.caveat }}</span>
          <span v-if="finding.advice.pattern.cost" class="fc__cost">Cuesta: {{ finding.advice.pattern.cost }}</span>
        </div>

        <div v-for="alt in finding.advice.alternatives ?? []" :key="alt.name" class="fc__fix fc__fix--alt">
          <span class="fc__fix-label">o bien</span>
          <a class="fc__fix-link" :href="alt.source" target="_blank" rel="noopener noreferrer">{{ alt.name }}</a>
          <span class="fc__fix-why">{{ alt.why }}</span>
        </div>
      </div>

      <!-- Hipótesis de patrón — SUBORDINADA: indentada, fondo hundido, dentro de la tarjeta. -->
      <div v-if="hypotheses.length" class="fc__hypotheses">
        <HypothesisBlock
          v-for="(h, hi) in hypotheses"
          :key="hi"
          :hypothesis="h"
          :open="expandedHypotheses ? true : undefined"
          @focus-place="onFocusPlace"
        />
      </div>

      <div v-if="finding.id && !finding.discarded" class="fc__discard">
        <button type="button" class="fc__discard-btn" @click="emit('discard', finding.id)">
          Descartar con motivo
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fc {
  display: flex;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius, 8px);
  background: var(--ck-surface);
  overflow: hidden;
}

.fc__bar {
  flex: 0 0 auto;
  width: 4px;
}

.fc--high .fc__bar {
  background: var(--ck-danger);
}

.fc--medium .fc__bar {
  background: var(--ck-status-review);
}

.fc--low .fc__bar {
  background: var(--ck-status-done);
}

.fc__body {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
}

.fc__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.fc__kind {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-faint);
}

.fc__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ck-text);
  overflow-wrap: break-word;
}

.fc__severity {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--ck-text-faint);
}

.fc--high .fc__severity {
  color: var(--ck-danger);
}

.fc--medium .fc__severity {
  color: var(--ck-status-review);
}

.fc__metric {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--ck-text-muted);
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

.fc__detail {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--ck-text-muted);
  line-height: 1.5;
}

.fc__locations {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--ck-text-faint);
  font-size: 11.5px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

.fc__loc-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-decoration: underline dotted;
}

.fc__loc-link:hover {
  color: var(--ck-text);
}

/* ── Arreglo — grande, primero, siempre ── */
.fc__advice {
  margin-top: 10px;
}

.fc__fix {
  margin-top: 6px;
  font-size: 12.5px;
}

.fc__fix-label {
  display: block;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--ck-text-faint);
  margin-bottom: 2px;
}

.fc__fix-link {
  color: var(--ck-primary);
  text-decoration: none;
  font-weight: 600;
}

.fc__fix-link:hover {
  color: var(--ck-primary-hover);
  text-decoration: underline;
}

.fc__fix-why {
  display: block;
  margin-top: 2px;
  color: var(--ck-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.fc__fix--pattern,
.fc__fix--alt {
  color: var(--ck-text-faint);
}

.fc__caveat,
.fc__cost {
  display: block;
  font-size: 11px;
  color: var(--ck-text-faint);
  margin-top: 2px;
}

.fc__cost {
  color: var(--ck-status-review);
}

/* ── Hipótesis: SUBORDINADA — nunca al mismo nivel visual que el arreglo. ── */
.fc__hypotheses {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Descarte ── */
.fc__discard {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--ck-border);
}

.fc__discard-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 11.5px;
  cursor: pointer;
}

.fc__discard-btn:hover {
  color: var(--ck-text);
  background: var(--ck-surface-hover);
}
</style>
