<script setup lang="ts">
/**
 * "Arquitectura" — CONTRATO-F7.md §3.1 (Frente D).
 *
 * Tres bloques, en este orden:
 *   1. Abstracciones que ya existen — una fila por hipótesis `ya-aplicado`/
 *      `aplicado-eludido`, agrupada por patrón. Es la única lectura
 *      "arquitectura real medida" que el sistema tiene hoy — todo lo demás
 *      en el panel son problemas, esto es lo que ya funciona.
 *   2. Forma del repo — conteos de `analysis.graph` + el top de carpetas por
 *      líneas y por impacto (derivado de `files`/`findings`, no del grafo:
 *      el grafo no trae ni líneas ni severidad).
 *   3. Cuánto de esto es confiable — `graph.resolution` en frase, para que
 *      el bloque 2 se lea con su margen de error real en vez de cifras que
 *      parecen absolutas.
 *
 * Sin `graph` los bloques 2 y 3 NO se dibujan (se dice por qué) — nunca un
 * 0% o un conteo fabricado.
 */
import { computed } from "vue";

import type { CodeAnalysis } from "@/types";
import type { CodeFindingHypothesisState } from "@shared/types";
import {
  bridgeLeaks,
  collectAppliedHypotheses,
  folderLabel,
  groupByPattern,
  resolutionSummary,
  topFoldersByImpact,
  topFoldersByLines,
  type AppliedHypothesis,
} from "./tabs";

const props = defineProps<{ analysis: CodeAnalysis }>();
const emit = defineEmits<{
  (e: "open-file", file: string): void;
  (e: "focus-finding", findingId: string): void;
}>();

const groups = computed(() => groupByPattern(collectAppliedHypotheses(props.analysis)));
const graph = computed(() => props.analysis.graph ?? null);
const foldersByLines = computed(() => topFoldersByLines(props.analysis.files));
const foldersByImpact = computed(() => topFoldersByImpact(props.analysis.files, props.analysis.findings));
const resolution = computed(() => resolutionSummary(props.analysis.graph));

const STATE_LABEL: Partial<Record<CodeFindingHypothesisState, string>> = {
  "aplicado-eludido": "⚡ Patrón puenteado",
  "ya-aplicado": "✓ Ya aplicado",
};

/** Dónde apunta la fila: el primer lugar de la hipótesis, o si no hay, la primera ubicación del hallazgo ancla. */
function primaryFileOf(item: AppliedHypothesis): string {
  return item.hypothesis.places[0]?.file ?? item.finding.locations[0]?.file ?? "";
}

function openItem(item: AppliedHypothesis): void {
  const file = primaryFileOf(item);
  if (file) emit("open-file", file);
  if (item.finding.id) emit("focus-finding", item.finding.id);
}
</script>

<template>
  <section class="arch">
    <header class="arch__head">
      <h2 class="arch__title">Arquitectura</h2>
      <p class="arch__subtitle">
        Lo que el motor de hipótesis mide como abstracción ya existente, la forma del repo
        sobre el grafo de código, y cuánto de eso se puede confiar.
      </p>
    </header>

    <section class="arch__block">
      <h3 class="arch__block-title">Abstracciones que ya existen</h3>
      <p v-if="groups.length === 0" class="arch__empty">
        Ninguna hipótesis de patrón llegó a "ya aplicado" ni "aplicado-eludido" en este
        análisis todavía — todas las que corrieron están en "ausente" o "parcial" (visibles
        dentro de cada tarjeta de hallazgo, en Mapa/Lista) o no aplican en estos lenguajes.
      </p>
      <div v-else class="arch__groups">
        <article
          v-for="g in groups"
          :key="g.pattern"
          class="arch__group"
          :class="{ 'arch__group--bridged': g.hasBridged }"
        >
          <h4 class="arch__pattern">{{ g.pattern }}</h4>
          <ul class="arch__rows">
            <li v-for="item in g.items" :key="item.hypothesis.anchorFindingId" class="arch__row">
              <span
                class="arch__badge"
                :class="`arch__badge--${item.hypothesis.state}`"
              >{{ STATE_LABEL[item.hypothesis.state] ?? item.hypothesis.state }}</span>
              <button type="button" class="arch__file" @click="openItem(item)">
                {{ primaryFileOf(item) }}
              </button>
              <span v-if="item.hypothesis.state === 'aplicado-eludido'" class="arch__leaks">
                {{ bridgeLeaks(item.hypothesis).length }} de {{ item.hypothesis.places.length }}
                lugares puentean la abstracción
              </span>
            </li>
          </ul>
        </article>
      </div>
    </section>

    <template v-if="graph">
      <section class="arch__block">
        <h3 class="arch__block-title">Forma del repo</h3>
        <p class="arch__graph-counts">
          {{ graph.folders }} carpetas · {{ graph.files }} archivos · {{ graph.symbols }} símbolos ·
          {{ graph.edges }} aristas ({{ graph.containsEdges }} de contención,
          {{ graph.referencesEdges }} de referencia)
        </p>
        <div class="arch__folders">
          <div class="arch__folder-col">
            <h4 class="arch__folder-heading">Top carpetas por líneas</h4>
            <ol class="arch__folder-list">
              <li v-for="f in foldersByLines" :key="f.folder" class="arch__folder-row">
                <button type="button" class="arch__folder-btn" @click="emit('open-file', f.folder)">
                  {{ folderLabel(f.folder) }}
                </button>
                <span class="arch__folder-value">{{ f.value }} líneas · {{ f.files }} archivos</span>
              </li>
            </ol>
          </div>
          <div class="arch__folder-col">
            <h4 class="arch__folder-heading">Top carpetas por impacto</h4>
            <ol class="arch__folder-list">
              <li v-for="f in foldersByImpact" :key="f.folder" class="arch__folder-row">
                <button type="button" class="arch__folder-btn" @click="emit('open-file', f.folder)">
                  {{ folderLabel(f.folder) }}
                </button>
                <span class="arch__folder-value">impacto {{ f.value.toFixed(1) }} · {{ f.files }} archivos</span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section v-if="resolution" class="arch__block">
        <h3 class="arch__block-title">Cuánto de esto es confiable</h3>
        <p class="arch__resolution">{{ resolution.sentence }}</p>
      </section>
    </template>
    <p v-else class="arch__no-graph">
      Este análisis no trae grafo de código (<code>analysis.graph</code> ausente — un análisis
      de antes de que ese campo existiera, o corrido fuera de <code>code-inspector.ts</code>).
      "Forma del repo" y "Cuánto de esto es confiable" dependen de ese campo; reanalizá el
      repositorio para verlos.
    </p>
  </section>
</template>

<style scoped>
.arch {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 2px 24px;
}

.arch__title {
  margin: 0 0 4px;
  font-size: 16px;
}

.arch__subtitle {
  margin: 0;
  color: var(--ck-text-muted);
  font-size: 12.5px;
}

.arch__block {
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius, 8px);
  padding: 14px 16px;
  background: var(--ck-surface);
}

.arch__block-title {
  margin: 0 0 10px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-muted);
}

.arch__empty,
.arch__no-graph {
  color: var(--ck-text-muted);
  font-size: 13px;
}

.arch__groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.arch__group {
  border-left: 3px solid var(--ck-border-strong);
  padding-left: 10px;
}

.arch__group--bridged {
  border-left-color: #ffa344;
}

.arch__pattern {
  margin: 0 0 6px;
  font-size: 14px;
}

.arch__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.arch__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}

.arch__badge {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.arch__badge--aplicado-eludido {
  background: rgba(255, 163, 68, 0.18);
  color: #ffa344;
  border: 1px solid rgba(255, 163, 68, 0.55);
}

.arch__badge--ya-aplicado {
  background: rgba(77, 171, 154, 0.16);
  color: #4dab9a;
  border: 1px solid rgba(77, 171, 154, 0.5);
}

.arch__file {
  background: none;
  border: none;
  color: var(--ck-primary);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-align: left;
  text-decoration: underline dotted;
}

.arch__file:hover {
  color: var(--ck-primary-hover);
}

.arch__leaks {
  color: #ffa344;
}

.arch__graph-counts {
  margin: 0 0 12px;
  color: var(--ck-text-muted);
  font-size: 12.5px;
}

.arch__folders {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.arch__folder-heading {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ck-text-muted);
}

.arch__folder-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
}

.arch__folder-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.arch__folder-btn {
  background: none;
  border: none;
  color: var(--ck-primary);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-align: left;
}

.arch__folder-btn:hover {
  color: var(--ck-primary-hover);
}

.arch__folder-value {
  color: var(--ck-text-faint);
  white-space: nowrap;
}

.arch__resolution {
  margin: 0;
  font-size: 13px;
}
</style>
