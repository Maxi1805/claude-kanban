<script setup lang="ts">
/**
 * Curved co-problem edges drawn OVER the hotspot map's already-packed
 * circles — CONTRATO-F7.md §2.1/§2.2. Mounted as a slot INSIDE HotspotMap's
 * `<svg>` so it shares the same viewBox/coordinate space.
 *
 * Rules this component exists to enforce, all non-negotiable:
 *
 *   1. `pack()` owns `x`/`y`/`r`. This component only READS `circles` (a
 *      prop) — it never mutates a circle, and the one place physics runs
 *      (`relaxControlPoints`, `graph-layout.ts`) treats every circle as a
 *      FIXED body. See that module's own contract test.
 *   2. Hundreds of edges drawn naively are illegible. `budget()` cuts to
 *      `maxVisible` (default 120) BEFORE anything is drawn, ranked by
 *      weight, and the cut is always stated in real numbers — never a
 *      silent truncation. Measured on guava (5.000 findings): 1.312
 *      candidate edges: a small repo won't hit the cap, a real one always
 *      will.
 *   3. Weight alone is not enough — task brief P4, Problema 1: guava's
 *      highest-weight edges nearly all share 2-3 hub files, so `budget()`'s
 *      cut CONCENTRATES onto those hubs (measured: two files at degree 39
 *      and 37 out of 120 drawn edges — a solid knot, not a readable map).
 *      `collapseHubs` (`graph-layout.ts`) runs FIRST, unconditionally
 *      (including "ver todas" — the repo-entero case jumps to ~1.312
 *      candidates and must hold up too), capping any one file's individual
 *      curves so the weight budget then draws from a de-hubbed, more
 *      diverse pool. What a hub folded away is never silent: `hubMarkers`
 *      below draws a small dashed ring + "+N" badge per saturated file.
 */
import { computed, watch } from "vue";

import { budget, edgeInk, type CoEdge, type CoEdgeKind } from "./graph-edges";
import { collapseHubs, relaxControlPoints, type EdgeOverlayStats } from "./graph-layout";
import type { PackedCircle } from "./hotspot-map";

const props = withDefaults(
  defineProps<{
    circles: readonly PackedCircle[];
    edges: readonly CoEdge[];
    size: number;
    maxVisible?: number;
    highlight?: string | null;
  }>(),
  { maxVisible: 120, highlight: null },
);

const emit = defineEmits<{
  (e: "stats", stats: EdgeOverlayStats): void;
  (e: "select-edge", edge: CoEdge): void;
}>();

/** Only edges whose BOTH ends are circles actually on screen right now. */
const drawable = computed<CoEdge[]>(() => {
  const known = new Set(props.circles.map((c) => c.node.path));
  return props.edges.filter((e) => known.has(e.a) && known.has(e.b));
});

/** Problema 1 — fold any saturated file's excess edges away BEFORE the weight cut. */
const collapsed = computed(() => collapseHubs(drawable.value));

const budgeted = computed(() => budget(collapsed.value.edges, props.maxVisible));

watch(
  [drawable, collapsed, budgeted],
  ([draw, coll, budg]) => {
    emit("stats", {
      totalCandidates: draw.length,
      shown: budg.visible.length,
      hiddenByBudget: budg.hidden,
      foldedCount: draw.length - coll.edges.length,
      hubs: coll.hubs,
    });
  },
  { immediate: true },
);

/** One relaxed control point per visible edge, same order. */
const controlPoints = computed(() => relaxControlPoints(props.circles, budgeted.value.visible, props.size));

const byPath = computed(() => new Map(props.circles.map((c) => [c.node.path, c])));

/** Unordered-pair key, so both orderings of the same two files match. */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Task brief P4, Problema 3 — P3's `deriveEdges` merges same-KIND edges
 * between a pair, but two DIFFERENT kinds (say a `duplicacion` and a
 * `hipotesis`) between the same two files stay separate `CoEdge`s, so this
 * pair can be drawn as two nearby curves of different colour. Rather than
 * let that read as a mystery, every edge in such a pair gets a note in its
 * own tooltip naming the other kind(s) sharing the pair.
 */
const kindsByPair = computed(() => {
  const map = new Map<string, Set<CoEdgeKind>>();
  for (const edge of budgeted.value.visible) {
    const key = pairKey(edge.a, edge.b);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(edge.kind);
  }
  return map;
});

interface DrawnEdge {
  edge: CoEdge;
  path: string;
  ink: { rgb: string; opacity: number; dashed: boolean };
  touchesHighlight: boolean;
  title: string;
}

const drawnEdges = computed<DrawnEdge[]>(() => {
  const byPathMap = byPath.value;
  return budgeted.value.visible.map((edge, i) => {
    const a = byPathMap.get(edge.a);
    const b = byPathMap.get(edge.b);
    const cp = controlPoints.value[i];
    const ax = a?.x ?? props.size / 2;
    const ay = a?.y ?? props.size / 2;
    const bx = b?.x ?? props.size / 2;
    const by = b?.y ?? props.size / 2;
    const cx = cp?.x ?? (ax + bx) / 2;
    const cy = cp?.y ?? (ay + by) / 2;

    const otherKinds = [...(kindsByPair.value.get(pairKey(edge.a, edge.b)) ?? [])].filter((k) => k !== edge.kind);
    const mixedNote = otherKinds.length > 0 ? ` · este mismo par también tiene una relación de ${otherKinds.join(", ")}` : "";

    return {
      edge,
      path: `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`,
      ink: edgeInk(edge),
      touchesHighlight:
        props.highlight != null && (edge.a === props.highlight || edge.b === props.highlight),
      title: `${edge.label} (${edge.a} ↔ ${edge.b})${mixedNote}`,
    };
  });
});

/** Hub badges: one dashed ring + "+N" per file `collapseHubs` had to cap. */
const hubMarkers = computed(() => {
  const byPathMap = byPath.value;
  return collapsed.value.hubs.flatMap((hub) => {
    const c = byPathMap.get(hub.path);
    if (!c) return [];
    return [{ ...hub, x: c.x, y: c.y, r: c.r }];
  });
});
</script>

<template>
  <g class="graph-overlay" aria-hidden="true">
    <path
      v-for="(d, i) in drawnEdges"
      :key="`${d.edge.kind}-${d.edge.a}-${d.edge.b}-${i}`"
      :d="d.path"
      class="graph-overlay__edge"
      :class="{ 'graph-overlay__edge--dim': highlight != null && !d.touchesHighlight }"
      :stroke="`rgb(${d.ink.rgb})`"
      :stroke-opacity="d.ink.opacity"
      :stroke-dasharray="d.ink.dashed ? '4 3' : undefined"
      :stroke-width="1 + d.edge.weight * 2.5"
      fill="none"
      @click="emit('select-edge', d.edge)"
    >
      <title>{{ d.title }}</title>
    </path>

    <g v-for="hub in hubMarkers" :key="`hub-${hub.path}`" class="graph-overlay__hub">
      <circle :cx="hub.x" :cy="hub.y" :r="hub.r + 6" class="graph-overlay__hub-ring">
        <title>
          {{ hub.path }} · saturado: {{ hub.collapsed }} de {{ hub.total }} relaciones agrupadas en
          este indicador, se muestran las {{ hub.total - hub.collapsed }} más fuertes como curvas.
        </title>
      </circle>
      <text :x="hub.x + hub.r + 9" :y="hub.y - hub.r - 3" class="graph-overlay__hub-badge">+{{ hub.collapsed }}</text>
    </g>
  </g>
</template>

<style scoped>
.graph-overlay__edge {
  cursor: pointer;
  pointer-events: stroke;
  transition: stroke-opacity 0.12s ease;
}

.graph-overlay__edge--dim {
  stroke-opacity: 0.06 !important;
}

.graph-overlay__edge:hover {
  stroke-opacity: 0.95 !important;
}

.graph-overlay__hub-ring {
  fill: none;
  stroke: var(--ck-text-faint, #6b6b6b);
  stroke-width: 1.5;
  stroke-dasharray: 3 3;
  pointer-events: stroke;
  cursor: default;
}

.graph-overlay__hub-badge {
  fill: var(--ck-text-faint, #6b6b6b);
  font-size: 10px;
  pointer-events: none;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 3px;
}
</style>
