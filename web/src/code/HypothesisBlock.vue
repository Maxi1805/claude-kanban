<script setup lang="ts">
/**
 * Un patrón hipotetizado sobre UN hallazgo — CONTRATO-F7.md Contrato 1.
 * Usado sólo por FindingCard.vue, nunca montado suelto (§1.1: el bloque vive
 * DENTRO de la tarjeta, nunca al mismo nivel que el arreglo mecánico).
 */
import { computed, ref, watch } from "vue";
import type { CodeFindingHypothesis, PatternOpportunityPlace } from "@shared/types";
import {
  anyDiscriminatorConfirmed,
  atConfidenceCeiling,
  bridgePlaces,
  CONFIDENCE_LABELS,
  formatPlace,
  isNotApplicable,
  LAYER_LABELS,
  splitChecks,
  stateMeta,
} from "./hypotheses";

const props = defineProps<{
  hypothesis: CodeFindingHypothesis;
  open?: boolean;
}>();

const emit = defineEmits<{ (e: "focus-place", payload: { file: string; line: number }): void }>();

const notApplicable = computed(() => isNotApplicable(props.hypothesis));
const meta = computed(() => stateMeta(props.hypothesis.state));

/*
 * OLA BB, FRENTE BB2 — EL RÓTULO QUE MENTÍA.
 *
 * Acá decía `"Hipótesis de patrón · {{ pattern }}"` para TODA hipótesis. En
 * el panel de Ghost eso anunciaba 1.958 propuestas de REFACTORIZACIÓN como
 * "Hipótesis de patrón · Extract Method" (1.505 veces sólo ésa). La Ola BA
 * existe para dejar de llamar patrón a una refactorización, y este rótulo lo
 * seguía haciendo en cada tarjeta; `LAYER_LABELS` ya estaba escrito y sólo se
 * usaba en el título de la pestaña.
 *
 * SIN `??`, como el resto de la ola: si por lo que sea llegara una hipótesis
 * sin capa, el rótulo OMITE la capa en vez de inventarle una. Omitir es
 * honesto; escribir "Patrón de diseño" sobre una capa que nadie declaró es la
 * mentira que estamos sacando.
 */
const layerLabel = computed<string | undefined>(
  () => LAYER_LABELS[props.hypothesis.layer] as string | undefined,
);

/** `open` fuerza; si no, sólo `aplicado-eludido` arranca abierto (§1.2). */
const defaultOpen = computed(() => props.open ?? (!notApplicable.value && meta.value.defaultOpen));
const manualOpen = ref<boolean | null>(null);
const isOpen = computed(() => manualOpen.value ?? defaultOpen.value);

// Un remount lógico (otra hipótesis, u otro `open` del padre) olvida el toggle manual.
watch(
  () => [props.hypothesis, props.open],
  () => {
    manualOpen.value = null;
  },
);

function toggleOpen(): void {
  manualOpen.value = !isOpen.value;
}

const split = computed(() => splitChecks(props.hypothesis));
const bridges = computed(() => bridgePlaces(props.hypothesis));
const discriminatorsConfirmed = computed(() => anyDiscriminatorConfirmed(props.hypothesis));
const atCeiling = computed(() => atConfidenceCeiling(props.hypothesis));

/*
 * `confidence` es `PatternConfidence | null` por contrato (§1.3) — resuelto
 * acá, no en el template, para no depender de que el narrowing de un `v-if`
 * sobreviva hasta un `{{ }}` interpolado más abajo.
 */
const confidenceLabel = computed(() =>
  props.hypothesis.confidence ? CONFIDENCE_LABELS[props.hypothesis.confidence] : null,
);
const ceilingLabel = computed(() => CONFIDENCE_LABELS[props.hypothesis.ceiling]);

function focusPlace(place: PatternOpportunityPlace): void {
  emit("focus-place", { file: place.file, line: place.startLine });
}
</script>

<template>
  <div class="hb" :class="[`hb--${meta.className}`, { 'hb--na': notApplicable, 'hb--open': isOpen }]">
    <button type="button" class="hb__toggle" :aria-expanded="isOpen" @click="toggleOpen">
      <span class="hb__caret">{{ isOpen ? "▾" : "▸" }}</span>
      <!-- Un solo `<span>` extra por bloque, no dos: con 1.850 bloques en la
           lista de Ghost cada nodo de más se paga 1.850 veces. -->
      <span class="hb__title"><span v-if="layerLabel" class="hb__layer">{{ layerLabel }} · </span>{{ hypothesis.pattern }}</span>

      <span v-if="notApplicable" class="hb__seal hb__seal--na">No aplicable en este lenguaje</span>
      <template v-else>
        <span class="hb__seal" :class="`hb__seal--${meta.className}`">{{ meta.icon }} {{ meta.label }}</span>
        <span v-if="confidenceLabel" class="hb__confidence">
          {{ confidenceLabel }}<template v-if="atCeiling"> — tope: {{ ceilingLabel }}</template>
        </span>
        <span
          v-if="confidenceLabel"
          class="hb__provisional"
          :class="{ 'hb__provisional--calibrated': !hypothesis.provisional }"
          :title="hypothesis.provisional ? 'Umbral aún no recalibrado contra el corpus externo.' : undefined"
        >
          {{ hypothesis.provisional ? "provisional" : "calibrado" }}
        </span>
      </template>
    </button>

    <div v-if="isOpen" class="hb__body">
      <template v-if="notApplicable">
        <p class="hb__na-note">No aplicable en este lenguaje — faltan estas capacidades:</p>
        <ul class="hb__na-list">
          <li v-for="cap in hypothesis.missingCapabilities" :key="cap">{{ cap }}</li>
        </ul>
      </template>

      <template v-else>
        <p v-if="hypothesis.state === 'aplicado-eludido'" class="hb__eludido-note">
          <strong>La abstracción ya existe. Lo que falta no es escribirla: hay código que la puentea.</strong>
        </p>

        <div v-if="hypothesis.state === 'aplicado-eludido'" class="hb__section">
          <h4 class="hb__section-title">Dónde se puentea ({{ bridges.length }})</h4>
          <ul class="hb__bridges">
            <li v-for="(place, pi) in bridges" :key="pi">
              <button type="button" class="hb__place-link" @click="focusPlace(place)">{{ formatPlace(place) }}</button>
            </li>
          </ul>
        </div>

        <div class="hb__section">
          <h4 class="hb__section-title">Requisitos</h4>
          <ul class="hb__checks">
            <li
              v-for="(check, ci) in split.requirements"
              :key="ci"
              class="hb__check"
              :class="check.passed ? 'hb__check--pass' : 'hb__check--fail'"
            >
              <span class="hb__check-mark">{{ check.passed ? "✓" : "✗" }}</span>
              <span class="hb__check-body">
                <strong>{{ check.label }}</strong>
                <span class="hb__check-why">{{ check.why }}</span>
              </span>
            </li>
          </ul>
        </div>

        <div class="hb__section">
          <h4 class="hb__section-title">
            {{ discriminatorsConfirmed ? "Lo que subiría la confianza" : "Nada subió la confianza por encima del piso" }}
          </h4>
          <ul v-if="split.discriminators.length" class="hb__checks">
            <li
              v-for="(check, di) in split.discriminators"
              :key="di"
              class="hb__check"
              :class="check.passed ? 'hb__check--pass' : 'hb__check--fail'"
            >
              <span class="hb__check-mark">{{ check.passed ? "✓" : "✗" }}</span>
              <span class="hb__check-body">
                <strong>{{ check.label }}</strong>
                <span class="hb__check-why">{{ check.why }}</span>
              </span>
            </li>
          </ul>
        </div>

        <p class="hb__cost"><strong>Cuesta:</strong> {{ hypothesis.cost }}</p>

        <div v-if="hypothesis.toConfirm.length" class="hb__section">
          <span class="hb__confirm-label">Antes de aplicarlo, confirmá a mano:</span>
          <ul class="hb__confirm-list">
            <li v-for="(item, ti) in hypothesis.toConfirm" :key="ti">{{ item }}</li>
          </ul>
        </div>

        <p class="hb__source">
          Fuente del umbral:
          <a :href="hypothesis.source" target="_blank" rel="noopener noreferrer">{{ hypothesis.source }}</a>
          · {{ hypothesis.provisional ? "provisional" : "calibrado" }}
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.hb {
  margin-top: 10px;
  margin-left: 24px;
  border-radius: var(--ck-radius, 8px);
  background: var(--ck-surface-2, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--ck-border);
  overflow: hidden;
}

/* aplicado-eludido: el único frío-con-alarma — ámbar, borde 2px, siempre visible incluso colapsado. */
.hb--bridged {
  border: 2px solid #ffa344;
  background: rgba(255, 163, 68, 0.07);
}

.hb--partial {
  border-left: 3px solid #9d7cd8;
}

.hb--absent {
  border-left: 3px solid #7c8ba1;
}

.hb--applied {
  border-left: 3px solid rgba(77, 171, 154, 0.5);
  opacity: 0.85;
}

.hb--na {
  border-left: 3px solid var(--ck-border);
  opacity: 0.75;
}

.hb__toggle {
  width: 100%;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--ck-text);
}

.hb__caret {
  color: var(--ck-text-faint);
  flex: 0 0 auto;
}

.hb__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ck-text);
}

/* La capa se lee como etiqueta, no como parte del nombre del patrón: es lo
   que distingue una refactorización de un patrón de diseño y no debe
   confundirse con el nombre que le sigue. */
.hb__layer {
  font-weight: 500;
  color: var(--ck-text-faint);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
}


.hb__seal {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--ck-border);
}

.hb__seal--bridged {
  color: #ffa344;
  border-color: #ffa344;
  background: rgba(255, 163, 68, 0.14);
}

/*
 * Relleno tenue en los tres estados fríos/tibios — antes sólo el borde de
 * 1px los distinguía colapsados, y a simple vista se leían casi iguales.
 * `aplicado-eludido` sigue siendo el único con alarma fuerte (borde 2px +
 * relleno .14 en `.hb--bridged`/`.hb__seal--bridged`, sin tocar) — éstos
 * usan una opacidad menor (.12) para no competir con esa jerarquía.
 */
.hb__seal--partial {
  color: #9d7cd8;
  border-color: #9d7cd8;
  background: rgba(157, 124, 216, 0.12);
}

.hb__seal--absent {
  color: #7c8ba1;
  border-color: #7c8ba1;
  background: rgba(124, 139, 161, 0.12);
}

.hb__seal--applied {
  color: #4dab9a;
  border-color: #4dab9a;
  background: rgba(77, 171, 154, 0.12);
  opacity: 0.85;
}

.hb__seal--na {
  color: var(--ck-text-faint);
  border-color: var(--ck-border);
  font-style: italic;
  font-weight: 500;
}

.hb__confidence {
  font-size: 11px;
  color: var(--ck-text-muted);
}

.hb__provisional {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--ck-status-review);
  cursor: help;
}

.hb__provisional--calibrated {
  color: var(--ck-status-done);
}

.hb__body {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hb__eludido-note {
  margin: 0;
  font-size: 12.5px;
  color: #ffa344;
  line-height: 1.5;
}

.hb__na-note {
  margin: 0;
  font-size: 12px;
  color: var(--ck-text-muted);
}

.hb__na-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--ck-text-faint);
}

.hb__section-title {
  margin: 0 0 4px;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-faint);
}

.hb__bridges {
  margin: 0;
  padding-left: 0;
  list-style: none;
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hb__place-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--ck-primary);
  cursor: pointer;
  text-decoration: underline dotted;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

.hb__place-link:hover {
  color: var(--ck-primary-hover);
}

.hb__checks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Las filas passed:false NO se colapsan ni se atenúan detrás de un "ver más" — CONTRATO-F7.md §1.4: son la razón de ser del bloque. */
.hb__check {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.45;
}

.hb__check-mark {
  flex: 0 0 auto;
  font-weight: 700;
}

.hb__check--pass .hb__check-mark {
  color: var(--ck-status-done);
}

.hb__check--fail .hb__check-mark {
  color: var(--ck-text-muted);
}

.hb__check-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.hb__check-why {
  color: var(--ck-text-muted);
  font-size: 11px;
}

.hb__cost {
  margin: 0;
  font-size: 12.5px;
  color: var(--ck-text);
}

.hb__confirm-label {
  display: block;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--ck-text-faint);
  margin-bottom: 3px;
}

.hb__confirm-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--ck-text-muted);
  line-height: 1.5;
}

.hb__source {
  margin: 0;
  font-size: 11px;
  color: var(--ck-text-faint);
}

.hb__source a {
  color: var(--ck-primary);
}
</style>
