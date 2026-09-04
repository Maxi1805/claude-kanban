<script setup lang="ts">
/**
 * The hotspot map: every file in the repo as a packed circle, sized by lines
 * (or, now, impact/density — CONTRATO-F7.md §2.5) and coloured by its worst
 * finding.
 *
 * Rendered as plain SVG rather than through a charting library: the layout is
 * already computed (d3-hierarchy), and drawing it directly keeps hover, focus
 * and click as ordinary DOM events that Vue can own.
 *
 * Clicking a directory zooms into it, so a 500-file repo stays navigable; the
 * breadcrumb walks back out. Clicking a file selects it (unchanged — the
 * parent still shows that file's findings beside the map) AND now also opens
 * its ego neighbourhood (§2.3) in place of the packed circles; "Volver"/Esc
 * comes back to the map, same `focusPath`/zoom as before.
 *
 * `pack()` stays the ONLY authority over circle `x`/`y`/`r` — the edges drawn
 * over it (`GraphOverlay.vue`) only relax a control point per edge, off this
 * component's own render loop; see `graph-layout.ts`'s contract test.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import type { CodeAnalysis } from "@/types";
import EgoView from "./EgoView.vue";
import { collapseToFocus, deriveEdges, type CoEdge } from "./graph-edges";
import {
  edgeScopeFor,
  edgeScopeLabel,
  EDGE_KIND_LEGEND_FALLBACK,
  type EdgeOverlayStats,
} from "./graph-layout";
import GraphOverlay from "./GraphOverlay.vue";
import { buildTree, layout, type MapNode, type PackedCircle, type SizeAxis } from "./hotspot-map";

const props = defineProps<{
  analysis: CodeAnalysis;
  /** Path of the currently selected file, if any. */
  selected: string | null;
}>();

const emit = defineEmits<{ (event: "select", node: MapNode | null): void }>();

/** Side of the square the circles are packed into, in SVG units. */
const SIZE = 900;

/** §2.5 — what a circle's AREA means. Colour never changes: always severity. */
const AXES: { value: SizeAxis; label: string }[] = [
  { value: "lineas", label: "líneas" },
  { value: "impacto", label: "impacto" },
  { value: "densidad", label: "densidad" },
];
const axis = ref<SizeAxis>("lineas");

const root = computed(() => buildTree(props.analysis, axis.value));

/** Directory currently zoomed into; the root until the user drills down. */
const focusPath = ref<string>("");

// Switching repo (or a re-analysis that drops the folder) must not leave the
// map staring at a directory that no longer exists.
watch(root, (next) => {
  if (focusPath.value && !findNode(next, focusPath.value)) focusPath.value = "";
});

const focus = computed(() => findNode(root.value, focusPath.value) ?? root.value);

const circles = computed<PackedCircle[]>(() => layout(focus.value, SIZE));

/**
 * §2.2 — Nivel-1 co-problem edges, derived once per analysis (independent of
 * zoom/axis: `GraphOverlay` collapses/budgets them per-focus itself). Off by
 * default ("edges: off") so the map the user already likes is still the
 * first thing rendered.
 */
const allEdges = computed<CoEdge[]>(() => deriveEdges(props.analysis));

/**
 * §2.2 step 1 — restricted to what the CURRENT zoom can actually show: an
 * edge crossing out of `focusPath` collapses onto the focus ring instead of
 * pointing at a file with no circle on screen. This, not `allEdges`, is the
 * pool `GraphOverlay`'s own rank+cut (steps 2-3) draws from, and the
 * denominator for the "N de M" line below.
 */
const focusEdges = computed<CoEdge[]>(() =>
  collapseToFocus(
    allEdges.value,
    focusPath.value,
    props.analysis.files.map((f) => f.path),
  ),
);

const edgesOn = ref(false);
const showAllEdges = ref(false);
const EDGE_BUDGET = 120;

/** §2.2 + Problema 1/2 (P4) — every real number `GraphOverlay` drew from. */
const edgeStats = ref<EdgeOverlayStats>({ totalCandidates: 0, shown: 0, hiddenByBudget: 0, foldedCount: 0, hubs: [] });

/**
 * Problema 2 (P4) — the relation count must declare WHICH slice of the repo
 * it came from, or "517 relaciones" on page 1 vs "191" on page 2 (same repo,
 * same focus) reads as the map silently changing its mind. Falls back
 * gracefully (`edgeScopeFor`) when `page`/`groupsTotal` predate F5.
 */
const edgeScope = computed(() => edgeScopeFor(props.analysis));

// Changing repo/focus/axis with "ver todas" stuck on would otherwise keep
// rendering thousands of edges after the context that justified it is gone.
watch([() => props.analysis, focusPath], () => {
  showAllEdges.value = false;
});

/** §2.3 — the file whose ego neighbourhood replaces the map, if any. */
const egoFile = ref<string | null>(null);
const egoHops = ref<1 | 2>(1);

function closeEgo(): void {
  egoFile.value = null;
}

function onEscape(e: KeyboardEvent): void {
  if (e.key === "Escape" && egoFile.value) closeEgo();
}
onMounted(() => window.addEventListener("keydown", onEscape));
onUnmounted(() => window.removeEventListener("keydown", onEscape));

/** Path from the root down to the focused directory, for the breadcrumb. */
const trail = computed<MapNode[]>(() => {
  const out: MapNode[] = [];
  const walk = (node: MapNode): boolean => {
    out.push(node);
    if (node.path === focus.value.path) return true;
    for (const child of node.children ?? []) {
      if (walk(child)) return true;
    }
    out.pop();
    return false;
  };
  walk(root.value);
  return out;
});

function findNode(node: MapNode, path: string): MapNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

function onCircleClick(circle: PackedCircle): void {
  if (circle.isFile) {
    const deselecting = circle.node.path === props.selected;
    emit("select", deselecting ? null : circle.node);
    // §2.3 — click opens the ego view; clicking the SAME file again (the
    // existing deselect gesture) also backs out of it, same as "Volver".
    egoFile.value = deselecting ? null : circle.node.path;
    if (!deselecting) egoHops.value = 1;
    return;
  }
  // Clicking the ring you are already inside does nothing; the breadcrumb goes back.
  if (circle.node.path !== focus.value.path) {
    focusPath.value = circle.node.path;
    emit("select", null);
  }
}

function zoomTo(node: MapNode): void {
  focusPath.value = node.path;
  emit("select", null);
}

/** Labels only fit on reasonably large circles; below that they are noise. */
const MIN_LABEL_RADIUS = 26;

const hovered = ref<string | null>(null);

/** Tooltip text: what the circle is and why it is that colour. */
function describe(node: MapNode): string {
  const what = node.children
    ? `${node.path || node.name} · carpeta`
    : `${node.path} · ${node.lines} líneas`;
  if (node.findings.length === 0 && !node.children) return `${what}\nsin hallazgos`;
  if (node.children) return what;
  const worst = node.findings[0];
  return `${what}\n${node.findings.length} hallazgo${node.findings.length === 1 ? "" : "s"}` +
    (worst ? ` · peor: ${worst.title}` : "");
}
</script>

<template>
  <div class="map">
    <EgoView
      v-if="egoFile"
      :analysis="analysis"
      :file="egoFile"
      :hops="egoHops"
      :edges="allEdges"
      :degraded="true"
      @close="closeEgo"
      @hops="egoHops = $event"
      @select="egoFile = $event"
    />

    <template v-else>
      <div class="map__toolbar">
        <nav class="map__trail" aria-label="Ubicación en el árbol">
          <template v-for="(node, i) in trail" :key="node.path || 'root'">
            <button
              type="button"
              class="map__crumb"
              :class="{ 'map__crumb--current': i === trail.length - 1 }"
              :disabled="i === trail.length - 1"
              @click="zoomTo(node)"
            >
              {{ node.name }}
            </button>
            <span v-if="i < trail.length - 1" class="map__sep">/</span>
          </template>
        </nav>

        <div class="map__axis" role="group" aria-label="Tamaño de los círculos">
          <span class="map__axis-label">Tamaño:</span>
          <button
            v-for="a in AXES"
            :key="a.value"
            type="button"
            class="map__axis-btn"
            :class="{ 'map__axis-btn--active': axis === a.value }"
            @click="axis = a.value"
          >
            {{ a.label }}
          </button>
          <button type="button" class="map__axis-btn map__axis-btn--disabled" disabled
            title="Sin datos de historial: falta churn por archivo (CodeFileSummary.churn, no existe en el payload hoy).">
            actividad
          </button>
        </div>

        <button
          type="button"
          class="map__edges-toggle"
          :class="{ 'map__edges-toggle--on': edgesOn }"
          @click="edgesOn = !edgesOn"
        >
          {{ edgesOn ? "Relaciones: ON" : "Relaciones: off" }}
        </button>
      </div>

      <svg
        class="map__svg"
        :viewBox="`0 0 ${SIZE} ${SIZE}`"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Mapa de hotspots del repositorio"
      >
        <g
          v-for="circle in circles"
          :key="circle.node.path || 'root'"
          class="map__g"
        >
          <circle
            :cx="circle.x"
            :cy="circle.y"
            :r="circle.r"
            class="map__circle"
            :class="[
              circle.isFile ? `map__circle--${circle.node.tier}` : 'map__circle--dir',
              {
                'map__circle--selected': circle.isFile && circle.node.path === selected,
                'map__circle--hover': circle.node.path === hovered,
              },
            ]"
            :style="{ cursor: circle.isFile || circle.depth > 0 ? 'pointer' : 'default' }"
            @click="onCircleClick(circle)"
            @mouseenter="hovered = circle.node.path"
            @mouseleave="hovered = null"
          >
            <title>{{ describe(circle.node) }}</title>
          </circle>

          <!-- Directory names ride on the ring; file names sit in the middle. -->
          <text
            v-if="!circle.isFile && circle.depth > 0 && circle.r > MIN_LABEL_RADIUS"
            class="map__label map__label--dir"
            :x="circle.x"
            :y="circle.y - circle.r + 14"
            text-anchor="middle"
          >
            {{ circle.node.name }}
          </text>
          <text
            v-else-if="circle.isFile && circle.r > MIN_LABEL_RADIUS"
            class="map__label"
            :x="circle.x"
            :y="circle.y + 4"
            text-anchor="middle"
          >
            {{ circle.node.name }}
          </text>
        </g>

        <!-- §2.1/§2.2 — drawn LAST so edges ride on top; `pointer-events: stroke`
             (GraphOverlay's own style) keeps circle clicks working underneath. -->
        <GraphOverlay
          v-if="edgesOn"
          :circles="circles"
          :edges="focusEdges"
          :size="SIZE"
          :max-visible="showAllEdges ? focusEdges.length : EDGE_BUDGET"
          :highlight="selected ?? hovered"
          @stats="edgeStats = $event"
        />
      </svg>

      <!-- §2.2 + Problemas 1/2 (P4) — always the real numbers: which slice of
           the repo this is (scope), how many got folded into a hub badge
           instead of drawn (never a silent hairball), how many are cut by
           weight, never silence about any of the three. -->
      <p v-if="edgesOn" class="map__edges-line">
        <template v-if="edgeStats.totalCandidates === 0">
          No hay relaciones de co-problema derivadas en este foco ({{ edgeScopeLabel(edgeScope) }}).
        </template>
        <template v-else>
          Mostrando {{ edgeStats.shown }} de {{ edgeStats.totalCandidates }} relaciones
          ({{ edgeScopeLabel(edgeScope) }}).
          <template v-if="edgeStats.hubs.length > 0">
            {{ edgeStats.foldedCount }} agrupadas en {{ edgeStats.hubs.length }}
            archivo{{ edgeStats.hubs.length === 1 ? "" : "s" }} saturado{{ edgeStats.hubs.length === 1 ? "" : "s" }}
            (anillo punteado — pasá el mouse para ver cuántas).
          </template>
          <template v-if="showAllEdges">
            Sin recorte por peso.
            <button type="button" class="map__edges-link" @click="showAllEdges = false">recortar de nuevo</button>
          </template>
          <template v-else-if="edgeStats.hiddenByBudget > 0">
            {{ edgeStats.hiddenByBudget }} ocultas.
            <button type="button" class="map__edges-link" @click="showAllEdges = true">ver todas</button>
          </template>
          <template v-else>Ninguna oculta.</template>
        </template>
      </p>

      <footer class="map__legend">
        <span class="map__key map__key--clean">sin hallazgos</span>
        <span class="map__key map__key--low">leve</span>
        <span class="map__key map__key--medium">medio</span>
        <span class="map__key map__key--high">alto</span>
        <span class="map__key map__key--critical">crítico</span>
        <span class="map__hint">
          El tamaño es {{ axis === "lineas" ? "la cantidad de código" : axis === "impacto" ? "el impacto medido" : "la densidad de hallazgos" }}.
          Clic en una carpeta para entrar, en un archivo para ver sus hallazgos y su vecindario.
        </span>
      </footer>

      <!-- Problema 3 (P4) — antes esto sólo existía como tooltip por curva;
           colores vía `edgeInk()` (P3, sin tocar `graph-edges.ts`) para que
           nunca se desincronice del render. -->
      <footer v-if="edgesOn" class="map__legend map__legend--edges">
        <span class="map__edges-legend-label">Relaciones:</span>
        <span
          v-for="entry in EDGE_KIND_LEGEND_FALLBACK"
          :key="entry.kind"
          class="map__key map__key--edge"
          :style="{ '--edge-key-color': `rgb(${entry.rgb})` }"
        >
          {{ entry.label }}
        </span>
        <span class="map__hint">
          Una curva mixta (dos archivos con más de un tipo de relación) lo dice en su tooltip.
          Un anillo punteado sobre un círculo marca un archivo saturado (ver la línea de arriba).
        </span>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.map {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
}

/* ── Toolbar: breadcrumb + axis selector + edges toggle ── */
.map__toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.map__trail {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 12px;
}

.map__axis {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.map__axis-label {
  color: var(--ck-text-faint);
  margin-right: 2px;
}

.map__axis-btn {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 11px;
  cursor: pointer;
}

.map__axis-btn--active {
  border-color: var(--ck-primary);
  color: var(--ck-primary);
}

.map__axis-btn--disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.map__edges-toggle {
  margin-left: auto;
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

.map__edges-toggle--on {
  border-color: var(--ck-primary);
  color: var(--ck-primary);
}

.map__edges-line {
  font-size: 11px;
  color: var(--ck-text-faint);
  margin: 0;
}

.map__edges-link {
  border: none;
  background: transparent;
  color: var(--ck-primary);
  padding: 0 0 0 4px;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
}

.map__crumb {
  border: none;
  background: transparent;
  color: var(--ck-primary);
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 12px;
}

.map__crumb:hover:not(:disabled) {
  background: var(--ck-surface-hover);
}

.map__crumb--current {
  color: var(--ck-text-muted);
  cursor: default;
}

.map__sep {
  color: var(--ck-text-faint);
}

/* ── Canvas ── */
.map__svg {
  width: 100%;
  max-height: 68vh;
  min-height: 0;
}

.map__circle {
  transition: stroke 0.12s ease, fill-opacity 0.12s ease;
}

/* Directories are containers, not content: outline only. */
.map__circle--dir {
  fill: rgba(255, 255, 255, 0.02);
  stroke: var(--ck-border);
  stroke-width: 1;
}

/* Files: colour carries severity. Clean files stay quiet so the bad ones pop. */
.map__circle--clean {
  fill: rgba(255, 255, 255, 0.07);
  stroke: rgba(255, 255, 255, 0.12);
}

.map__circle--low {
  fill: rgba(77, 171, 154, 0.35);
  stroke: rgba(77, 171, 154, 0.6);
}

.map__circle--medium {
  fill: rgba(255, 163, 68, 0.32);
  stroke: rgba(255, 163, 68, 0.65);
}

.map__circle--high {
  fill: rgba(235, 87, 87, 0.38);
  stroke: rgba(235, 87, 87, 0.7);
}

.map__circle--critical {
  fill: rgba(235, 87, 87, 0.72);
  stroke: #ff8080;
  stroke-width: 1.5;
}

.map__circle--hover {
  stroke: var(--ck-text);
  stroke-width: 1.5;
}

.map__circle--selected {
  stroke: var(--ck-primary);
  stroke-width: 2.5;
}

/* ── Labels ── */
.map__label {
  fill: var(--ck-text);
  font-size: 11px;
  pointer-events: none;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 3px;
}

.map__label--dir {
  fill: var(--ck-text-muted);
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

/* ── Legend ── */
.map__legend {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--ck-text-faint);
}

.map__key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.map__key::before {
  content: "";
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}

.map__key--clean::before {
  background: rgba(255, 255, 255, 0.14);
}
.map__key--low::before {
  background: rgba(77, 171, 154, 0.6);
}
.map__key--medium::before {
  background: rgba(255, 163, 68, 0.6);
}
.map__key--high::before {
  background: rgba(235, 87, 87, 0.6);
}
.map__key--critical::before {
  background: rgba(235, 87, 87, 0.95);
}

.map__hint {
  margin-left: auto;
}

/* ── Edge-kind legend (Problema 3) ── */
.map__legend--edges {
  border-top: 1px dashed var(--ck-border);
  padding-top: 6px;
}

.map__edges-legend-label {
  color: var(--ck-text-faint);
}

.map__key--edge::before {
  background: var(--edge-key-color);
  border-radius: 2px;
  width: 12px;
  height: 3px;
}
</style>
