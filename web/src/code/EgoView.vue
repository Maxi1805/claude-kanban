<script setup lang="ts">
/**
 * The 1-2 hop neighbourhood of a single file — CONTRATO-F7.md §2.3. A
 * SEPARATE view, own radial layout, never a mutation of the packed map:
 * centre = the clicked file, ring 1 = its neighbours, ring 2 (only at
 * `hops: 2`) = theirs, attenuated.
 *
 * §2.0's gap is real and this component says so out loud (`degraded`): there
 * is no HTTP route for the real reference graph yet, so every edge reaching
 * this view today is a Nivel-1 co-problem edge (`graph-edges.ts`), not an
 * import/call. `degraded` is expected to be `true` until that route exists.
 *
 * MEASURED ON GUAVA (a real 1.977-file repo, not a toy fixture): the busiest
 * hub file's 1-hop ego is 88 neighbours; its 2-hop ego is 182 nodes and 402
 * edges. Drawn without a second cut, THAT is unreadable — a wheel of 88
 * labels overlapping at any font size — so this view applies the same
 * "rank, cut, say the real number" discipline §2.2 applies to the map, at
 * the NODE level, which the frozen `ego()`/`budget()` pair alone don't cover
 * (they cut edges, not how many neighbours get a ring position).
 */
import { computed } from "vue";

import type { CodeAnalysis } from "@/types";
import { budget, edgeInk, ego, type CoEdge } from "./graph-edges";
import { edgeScopeFor, edgeScopeLabel } from "./graph-layout";
import { findingsByFile, tierFor, type HealthTier } from "./hotspot-map";

const props = defineProps<{
  analysis: CodeAnalysis;
  file: string;
  hops: 1 | 2;
  edges: readonly CoEdge[];
  /** `true` ⇒ show the §2.0 notice: no real reference graph, co-problem edges only. */
  degraded?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", file: string): void;
  (e: "close"): void;
  (e: "hops", n: 1 | 2): void;
}>();

const SIZE = 640;
const CENTER = SIZE / 2;
const RING1_R = SIZE * 0.3;
const RING2_R = SIZE * 0.46;
const RING1_MAX = 24;
const RING2_MAX = 36;
const EDGE_MAX = 140;

/**
 * The hop-limited neighbourhood — `graph-edges.ts`'s OWN tested `ego()`,
 * never a second BFS reimplemented here. Everything below only assigns ring
 * numbers and screen positions to what this already returned.
 */
const rawEgo = computed(() => ego(props.edges, props.file, props.hops));

/** Undirected adjacency + the strongest edge for each pair, scoped to `rawEgo`'s already hop-limited edge set. */
function adjacency(edges: readonly CoEdge[]): Map<string, Map<string, CoEdge>> {
  const map = new Map<string, Map<string, CoEdge>>();
  const link = (x: string, y: string, e: CoEdge): void => {
    if (!map.has(x)) map.set(x, new Map());
    const forX = map.get(x)!;
    const existing = forX.get(y);
    if (!existing || existing.weight < e.weight) forX.set(y, e);
  };
  for (const e of edges) {
    link(e.a, e.b, e);
    link(e.b, e.a, e);
  }
  return map;
}

const adj = computed(() => adjacency(rawEgo.value.edges));

const tierByFile = computed<Map<string, HealthTier>>(() => {
  const perFile = findingsByFile(props.analysis);
  const out = new Map<string, HealthTier>();
  for (const [file, findings] of perFile) {
    out.set(file, tierFor(findings.reduce((max, f) => Math.max(max, f.severity), 0)));
  }
  return out;
});

interface RingNode {
  path: string;
  ring: 1 | 2;
  weight: number;
  parent?: string;
}

interface EgoResult {
  ring1: RingNode[];
  ring1Hidden: number;
  ring2: RingNode[];
  ring2Hidden: number;
}

const egoResult = computed<EgoResult>(() => {
  const graph = adj.value;
  const direct = [...(graph.get(props.file) ?? new Map())].map(
    ([path, e]): RingNode => ({ path, ring: 1, weight: e.weight }),
  );
  direct.sort((a, b) => b.weight - a.weight);
  const ring1 = direct.slice(0, RING1_MAX);
  const ring1Hidden = Math.max(0, direct.length - ring1.length);

  if (props.hops === 1) return { ring1, ring1Hidden, ring2: [], ring2Hidden: 0 };

  const ring1Paths = new Set(ring1.map((n) => n.path));
  const seen = new Set<string>([props.file, ...direct.map((n) => n.path)]);
  const candidates = new Map<string, RingNode>();
  for (const parent of ring1) {
    for (const [path, e] of graph.get(parent.path) ?? []) {
      if (seen.has(path)) continue; // already centre or any 1-hop neighbour
      const existing = candidates.get(path);
      if (!existing || existing.weight < e.weight) {
        candidates.set(path, { path, ring: 2, weight: e.weight, parent: parent.path });
      }
    }
  }
  // A 2-hop node whose only bridge was a ring-1 node that DIDN'T make the
  // cut has no parent left to hang off — real, but not renderable; it is
  // counted as hidden, not silently promoted onto a random ring-1 slot.
  const reachable = [...candidates.values()].filter((n) => ring1Paths.has(n.parent!));
  reachable.sort((a, b) => b.weight - a.weight);
  const ring2 = reachable.slice(0, RING2_MAX);
  // Every 2-hop node this repo actually has, whether or not its parent
  // survived — that is the honest denominator for "how many are hidden".
  const totalTwoHop = new Set<string>();
  for (const parent of direct) {
    for (const path of (graph.get(parent.path) ?? new Map()).keys()) {
      if (!seen.has(path)) totalTwoHop.add(path);
    }
  }
  const ring2Hidden = Math.max(0, totalTwoHop.size - ring2.length);

  return { ring1, ring1Hidden, ring2, ring2Hidden };
});

interface Positioned {
  path: string;
  ring: 0 | 1 | 2;
  x: number;
  y: number;
  r: number;
  tier: HealthTier;
}

const positioned = computed<Positioned[]>(() => {
  const out: Positioned[] = [
    { path: props.file, ring: 0, x: CENTER, y: CENTER, r: 30, tier: tierByFile.value.get(props.file) ?? "clean" },
  ];

  const n1 = egoResult.value.ring1.length || 1;
  const angleFor1 = new Map<string, number>();
  egoResult.value.ring1.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n1 - Math.PI / 2;
    angleFor1.set(node.path, angle);
    out.push({
      path: node.path,
      ring: 1,
      x: CENTER + RING1_R * Math.cos(angle),
      y: CENTER + RING1_R * Math.sin(angle),
      r: 17,
      tier: tierByFile.value.get(node.path) ?? "clean",
    });
  });

  out.push(...placeRing2(egoResult.value.ring2, angleFor1));
  return out;
});

/**
 * Ring-2 nodes cluster around their PARENT's angle so lines toward the centre
 * don't cross the whole diagram: siblings of one parent share its base angle
 * and fan out symmetrically around it, by a spread that grows with how many
 * they are (capped, or a crowded parent would wrap past its neighbours).
 */
function placeRing2(ring2: RingNode[], angleFor1: Map<string, number>): Positioned[] {
  const byParent = new Map<string, RingNode[]>();
  for (const node of ring2) {
    const list = byParent.get(node.parent!);
    if (list) list.push(node);
    else byParent.set(node.parent!, [node]);
  }

  const out: Positioned[] = [];
  for (const [parent, siblings] of byParent) {
    const baseAngle = angleFor1.get(parent) ?? 0;
    const spread = Math.min(0.9, 0.14 * siblings.length);
    siblings.forEach((node, i) => {
      const t = siblings.length === 1 ? 0 : i / (siblings.length - 1) - 0.5;
      const angle = baseAngle + t * spread;
      out.push({
        path: node.path,
        ring: 2,
        x: CENTER + RING2_R * Math.cos(angle),
        y: CENTER + RING2_R * Math.sin(angle),
        r: 10,
        tier: tierByFile.value.get(node.path) ?? "clean",
      });
    });
  }
  return out;
}

const renderedEdges = computed(() => {
  const shown = new Set(positioned.value.map((n) => n.path));
  const candidateEdges = rawEgo.value.edges.filter((e) => shown.has(e.a) && shown.has(e.b));
  return budget(candidateEdges, EDGE_MAX);
});

const byPath = computed(() => new Map(positioned.value.map((n) => [n.path, n])));

interface DrawnEdge {
  edge: CoEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ink: { rgb: string; opacity: number; dashed: boolean };
}

const drawnEdges = computed<DrawnEdge[]>(() =>
  renderedEdges.value.visible.flatMap((edge) => {
    const a = byPath.value.get(edge.a);
    const b = byPath.value.get(edge.b);
    if (!a || !b) return [];
    return [{ edge, x1: a.x, y1: a.y, x2: b.x, y2: b.y, ink: edgeInk(edge) }];
  }),
);

const basename = (path: string): string => path.split("/").pop() ?? path;

const totalOneHop = computed(() => egoResult.value.ring1.length + egoResult.value.ring1Hidden);

/**
 * Problema 2 (P4) — "Mostrando X de Y vecinos" never said what Y meant: 88
 * neighbours with the repo entero loaded vs. 73 with only the paginated
 * default (measured live, guava's `Maps.java`) is the SAME file, just a
 * different slice of groups — the sentence has to name that slice.
 */
const egoScope = computed(() => edgeScopeFor(props.analysis));
const egoScopeText = computed(() => edgeScopeLabel(egoScope.value));
</script>

<template>
  <div class="ego">
    <header class="ego__head">
      <button type="button" class="ego__close" @click="emit('close')">← Volver al mapa</button>
      <h3 class="ego__title">{{ file }}</h3>
      <div class="ego__hops" role="group" aria-label="Saltos">
        <button
          type="button"
          class="ego__hop-btn"
          :class="{ 'ego__hop-btn--active': hops === 1 }"
          @click="emit('hops', 1)"
        >
          1 salto
        </button>
        <button
          type="button"
          class="ego__hop-btn"
          :class="{ 'ego__hop-btn--active': hops === 2 }"
          @click="emit('hops', 2)"
        >
          2 saltos
        </button>
      </div>
    </header>

    <p v-if="degraded" class="ego__degraded">
      Sin el grafo de referencias: se muestran sólo los archivos que comparten un
      problema con este (misma duplicación, misma hipótesis de patrón), no imports
      ni llamadas reales.
    </p>

    <p class="ego__count">
      Mostrando {{ egoResult.ring1.length }} de {{ totalOneHop }} vecinos a 1 salto
      (los de mayor score, {{ egoScopeText }}).
      <template v-if="egoResult.ring1Hidden > 0">{{ egoResult.ring1Hidden }} ocultos.</template>
      <template v-else>Ninguno oculto.</template>
      <template v-if="hops === 2">
        {{ egoResult.ring2.length }} de {{ egoResult.ring2.length + egoResult.ring2Hidden }} a 2
        saltos<template v-if="egoResult.ring2Hidden > 0">, {{ egoResult.ring2Hidden }} ocultos</template>.
      </template>
      <template v-if="renderedEdges.hidden > 0">
        {{ renderedEdges.hidden }} relaciones entre los mostrados quedan ocultas.
      </template>
    </p>

    <svg class="ego__svg" :viewBox="`0 0 ${SIZE} ${SIZE}`" role="img" aria-label="Vecindario del archivo">
      <line
        v-for="(d, i) in drawnEdges"
        :key="`${d.edge.a}-${d.edge.b}-${i}`"
        :x1="d.x1"
        :y1="d.y1"
        :x2="d.x2"
        :y2="d.y2"
        :stroke="`rgb(${d.ink.rgb})`"
        :stroke-opacity="d.ink.opacity"
        :stroke-dasharray="d.ink.dashed ? '4 3' : undefined"
        :stroke-width="1 + d.edge.weight * 2"
      >
        <title>{{ d.edge.label }}</title>
      </line>

      <g v-for="node in positioned" :key="node.path" class="ego__node" @click="node.ring !== 0 && emit('select', node.path)">
        <circle
          :cx="node.x"
          :cy="node.y"
          :r="node.r"
          class="ego__circle"
          :class="[`ego__circle--${node.tier}`, `ego__circle--ring${node.ring}`]"
        >
          <title>{{ node.path }}</title>
        </circle>
        <text
          v-if="node.ring !== 2"
          :x="node.x"
          :y="node.y + node.r + 12"
          text-anchor="middle"
          class="ego__label"
        >
          {{ basename(node.path) }}
        </text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.ego {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ego__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.ego__close {
  border: none;
  background: transparent;
  color: var(--ck-primary);
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.ego__close:hover {
  background: var(--ck-surface-hover);
}

.ego__title {
  font-size: 13px;
  font-family: monospace;
  color: var(--ck-text);
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ego__hops {
  display: flex;
  gap: 4px;
}

.ego__hop-btn {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

.ego__hop-btn--active {
  border-color: var(--ck-primary);
  color: var(--ck-primary);
}

.ego__degraded {
  font-size: 11px;
  color: var(--ck-text-faint);
  background: var(--ck-surface-hover);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 0;
}

.ego__count {
  font-size: 11px;
  color: var(--ck-text-faint);
  margin: 0;
}

.ego__svg {
  width: 100%;
  max-height: 60vh;
}

.ego__node {
  cursor: pointer;
}

.ego__circle {
  transition: stroke 0.12s ease;
}

.ego__circle--ring0 {
  stroke-width: 2.5;
  stroke: var(--ck-primary);
}

.ego__circle--ring2 {
  opacity: 0.55;
}

.ego__circle--clean {
  fill: rgba(255, 255, 255, 0.1);
  stroke: rgba(255, 255, 255, 0.18);
}
.ego__circle--low {
  fill: rgba(77, 171, 154, 0.4);
  stroke: rgba(77, 171, 154, 0.65);
}
.ego__circle--medium {
  fill: rgba(255, 163, 68, 0.38);
  stroke: rgba(255, 163, 68, 0.68);
}
.ego__circle--high {
  fill: rgba(235, 87, 87, 0.42);
  stroke: rgba(235, 87, 87, 0.72);
}
.ego__circle--critical {
  fill: rgba(235, 87, 87, 0.78);
  stroke: #ff8080;
}

.ego__label {
  fill: var(--ck-text-muted);
  font-size: 9px;
  pointer-events: none;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 3px;
}
</style>
