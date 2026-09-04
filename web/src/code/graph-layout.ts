/**
 * Relaxes the CONTROL POINTS of the curved edges drawn over the hotspot map —
 * CONTRATO-F7.md §2.1. Split out of `GraphOverlay.vue` into a plain function
 * so the one non-negotiable rule has an actual test, not just a comment:
 *
 *   `pack()` is the ONLY authority over a circle's `x`/`y`/`r`. d3-force
 *   NEVER touches them — it only relaxes an auxiliary point per edge (where
 *   the curve bends), with every circle treated as a FIXED body (`fx`/`fy`,
 *   never mutable `x`/`y`) so straight edges between crowded circles don't
 *   all draw on top of each other.
 *
 * This function never reads or writes `x`/`y` on the `PackedCircle`s it is
 * given — it only COPIES their coordinates into separate, throwaway
 * simulation-node objects. See `graph-layout.test.ts` for the contract test
 * that asserts the input circles are byte-identical before and after.
 */
import { forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

import type { CodeAnalysis } from "@/types";
import { EDGE_KIND_LEGEND, type CoEdge, type CoEdgeKind } from "./graph-edges";
import type { PackedCircle } from "./hotspot-map";

export interface ControlPoint {
  x: number;
  y: number;
}

export interface RelaxOptions {
  /** Hard cap, synchronous, off the render loop — CONTRATO-F7.md §2.1. */
  ticks?: number;
  /** Repulsion between control points ONLY (never against a fixed circle). */
  charge?: number;
  linkStrength?: number;
}

const DEFAULT_TICKS = 120;
const DEFAULT_CHARGE = -30;
const DEFAULT_LINK_STRENGTH = 0.5;

interface EndpointNode extends SimulationNodeDatum {
  id: string;
  kind: "endpoint";
}

interface ControlNode extends SimulationNodeDatum {
  id: string;
  kind: "control";
}

type Node = EndpointNode | ControlNode;

interface Link extends SimulationLinkDatum<Node> {
  control: string;
}

/** The throwaway bodies d3-force runs on: never the caller's `PackedCircle`s. */
interface SimulationBodies {
  nodes: Node[];
  links: Link[];
  /** Control-node ids in edge order — the order the caller must read results back in. */
  controlIds: string[];
}

/** The mutable accumulators `buildSimulationBodies` fills as it walks edges. */
interface BodyAccumulator {
  nodes: Node[];
  /** Endpoint paths already turned into a node — dedupes across edges. */
  seen: Set<string>;
}

/**
 * Register both of an edge's endpoints as FIXED nodes, once each. Every
 * endpoint `forceLink` names must exist as a node, even one this module never
 * resolved to a real circle — parked at the canvas centre, fixed, so it can't
 * drag its control point anywhere odd.
 */
function addEndpointNodes(
  edge: CoEdge,
  byPath: ReadonlyMap<string, PackedCircle>,
  size: number,
  acc: BodyAccumulator,
): void {
  for (const path of [edge.a, edge.b]) {
    if (acc.seen.has(path)) continue;
    acc.seen.add(path);
    const circle = byPath.get(path);
    acc.nodes.push({ id: path, kind: "endpoint", fx: circle?.x ?? size / 2, fy: circle?.y ?? size / 2 });
  }
}

/**
 * Where a control node starts: AT the edge's midpoint (a straight line,
 * degenerate Q) with a small deterministic perpendicular offset keyed off the
 * edge index, so parallel edges between the same crowded pair don't start (and
 * often stay) fused. An edge with an unresolved endpoint seeds at the canvas
 * centre with no offset.
 */
function seededControlPosition(
  a: PackedCircle | undefined,
  b: PackedCircle | undefined,
  edgeIndex: number,
  size: number,
): ControlPoint {
  if (!a || !b) return { x: size / 2, y: size / 2 };
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const jitter = ((edgeIndex % 7) - 3) * 4; // -12..12px, deterministic
  return { x: midX + (-dy / len) * jitter, y: midY + (dx / len) * jitter };
}

/**
 * Turns circles + edges into the simulation's bodies: one FIXED endpoint node
 * per distinct path (copied coordinates, `fx`/`fy` — never the circle itself)
 * and one free control node per edge, seeded at the edge's midpoint with a
 * deterministic perpendicular jitter so parallel edges between the same
 * crowded pair don't start (and often stay) fused.
 */
function buildSimulationBodies(
  circles: readonly PackedCircle[],
  edges: readonly CoEdge[],
  size: number,
): SimulationBodies {
  const byPath = new Map<string, PackedCircle>();
  for (const c of circles) byPath.set(c.node.path, c);

  const acc: BodyAccumulator = { nodes: [], seen: new Set<string>() };
  const controlIds: string[] = [];
  const links: Link[] = [];

  edges.forEach((edge, i) => {
    const controlId = `__control_${i}`;
    controlIds.push(controlId);

    addEndpointNodes(edge, byPath, size, acc);

    const { x, y } = seededControlPosition(byPath.get(edge.a), byPath.get(edge.b), i, size);
    acc.nodes.push({ id: controlId, kind: "control", x, y });
    links.push({ source: controlId, target: edge.a, control: controlId });
    links.push({ source: controlId, target: edge.b, control: controlId });
  });

  return { nodes: acc.nodes, links, controlIds };
}

/**
 * One control point per edge, relaxed with `forceLink` (control↔its two
 * endpoints) and a weak `forceManyBody` between controls only — endpoints
 * are `fx`/`fy`-fixed, so many-body has nothing to push on them with anyway,
 * but the strength function below makes the "only between controls" rule
 * explicit rather than incidental.
 *
 * An edge naming a path absent from `circles` (should not happen — the
 * caller filters to resolvable endpoints first, see `GraphOverlay.vue`) gets
 * the geometric midpoint of `size/2, size/2` rather than crashing: a mislaid
 * curve is a rendering bug to notice, not a reason to blank the whole map.
 */
export function relaxControlPoints(
  circles: readonly PackedCircle[],
  edges: readonly CoEdge[],
  size: number,
  options: RelaxOptions = {},
): ControlPoint[] {
  const ticks = options.ticks ?? DEFAULT_TICKS;
  const charge = options.charge ?? DEFAULT_CHARGE;
  const linkStrength = options.linkStrength ?? DEFAULT_LINK_STRENGTH;

  if (edges.length === 0) return [];

  const { nodes, links, controlIds } = buildSimulationBodies(circles, edges, size);

  // Both generics given explicitly: the single-generic `forceSimulation<Node>`
  // overload yields `Simulation<Node, undefined>`, whose `.force()` would then
  // reject a `ForceLink<Node, Link>` (`Link` ≠ `undefined`).
  const simulation = forceSimulation<Node, Link>(nodes)
    .force(
      "link",
      forceLink<Node, Link>(links)
        .id((n) => n.id)
        .distance(60)
        .strength(linkStrength),
    )
    .force(
      "charge",
      forceManyBody<Node>().strength((n) => (n.kind === "control" ? charge : 0)),
    )
    .alphaMin(0.05)
    .stop();

  simulation.tick(ticks);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return controlIds.map((id) => {
    const n = byId.get(id)!;
    return { x: n.x ?? size / 2, y: n.y ?? size / 2 };
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Hub decluttering — task brief P4, Problema 1 ("bola de pelo").
 *
 * Cutting by weight alone does not fix an illegible map: guava's highest-
 * weight edges nearly all share the same 2-3 hub files (`Maps.java`,
 * `ImmutableSet.java`…), so `budget()`'s top-N cut CONCENTRATES onto those
 * hubs instead of spreading out — measured live, root of guava: 120 edges
 * drawn, top two files at degree 39 and 37 (63% of all drawn ink on two
 * circles). Below is the fix: cap how many of any ONE file's edges get
 * drawn as individual curves, BEFORE the weight budget runs, so that budget
 * then has to pick from a de-hubbed, more diverse pool.
 * ──────────────────────────────────────────────────────────────────────── */

/** A file whose incident-edge count exceeded {@link collapseHubs}'s threshold. */
export interface HubSummary {
  path: string;
  /** Incident edges in the input set, before folding. */
  total: number;
  /** How many of `total` got folded away (not drawn as their own curve). */
  collapsed: number;
}

export interface HubCollapseResult {
  /** Same edges, minus whatever a hub's excess folded away. Order preserved. */
  edges: CoEdge[];
  /** Only hubs that actually lost at least one edge, worst first. */
  hubs: HubSummary[];
}

/**
 * What `GraphOverlay.vue` reports up after a render pass — every real number
 * behind the "N de M relaciones" line (§2.2's "never truncate in silence",
 * now covering the hub fold too, not just the weight budget).
 */
export interface EdgeOverlayStats {
  /** Candidate edges on screen this pass (both ends resolve to a visible circle). */
  totalCandidates: number;
  /** Drawn as individual curves. */
  shown: number;
  /** Cut by the weight budget (0 when "ver todas" is on). */
  hiddenByBudget: number;
  /** Folded into a hub indicator instead of drawn as their own curve. */
  foldedCount: number;
  /** Which files got capped, and by how much — for the hub badges. */
  hubs: HubSummary[];
}

/** Above this many incident edges, a file is a "hub" and gets capped. */
export const HUB_DEGREE_THRESHOLD = 7;
/** How many of a hub's OWN edges still get drawn as individual curves. */
export const HUB_KEEP_PER_HUB = 4;

/**
 * Caps every file's incident edge count to `keep` (its strongest by weight),
 * for any file whose degree exceeds `threshold`. An edge between two files
 * survives if EITHER endpoint still counts it among its own top-`keep` —
 * only edges that are "excess" at BOTH their hub ends are folded away, so a
 * strong edge is never dropped just because the far end is also busy.
 *
 * This is a decluttering step, not a second budget: it runs on the FULL
 * candidate pool (before `budget()`, always — including "ver todas", per
 * the task brief's note that the repo-entero case, ~1.312 candidates, must
 * hold up too, not just the paginated default).
 */
export function collapseHubs(
  edges: readonly CoEdge[],
  threshold = HUB_DEGREE_THRESHOLD,
  keep = HUB_KEEP_PER_HUB,
): HubCollapseResult {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  const hubPaths = [...degree.entries()].filter(([, d]) => d > threshold).map(([path]) => path);
  if (hubPaths.length === 0) return { edges: [...edges], hubs: [] };
  const hubSet = new Set(hubPaths);

  const protectedAt = strongestEdgesPerHub(edges, hubPaths, keep);

  const survives = (edge: CoEdge, i: number): boolean => {
    const aHub = hubSet.has(edge.a);
    const bHub = hubSet.has(edge.b);
    if (!aHub && !bHub) return true; // neither end is saturated: untouched
    if (aHub && protectedAt.get(edge.a)!.has(i)) return true;
    if (bHub && protectedAt.get(edge.b)!.has(i)) return true;
    return false;
  };

  const kept: CoEdge[] = [];
  const survived: boolean[] = edges.map((e, i) => {
    const ok = survives(e, i);
    if (ok) kept.push(e);
    return ok;
  });

  return { edges: kept, hubs: summariseHubs(edges, hubPaths, degree, survived) };
}

/**
 * Per hub: the indices (into `edges`) of ITS own top-`keep` incident edges —
 * each hub keeps its strongest few, so a hub is thinned, never erased.
 */
function strongestEdgesPerHub(
  edges: readonly CoEdge[],
  hubPaths: readonly string[],
  keep: number,
): Map<string, Set<number>> {
  const protectedAt = new Map<string, Set<number>>();
  for (const hub of hubPaths) {
    const incident = edges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.a === hub || e.b === hub)
      .sort((x, y) => y.e.weight - x.e.weight)
      .slice(0, keep)
      .map(({ i }) => i);
    protectedAt.set(hub, new Set(incident));
  }
  return protectedAt;
}

/**
 * What the legend has to say out loud: how many of each hub's edges were
 * dropped. A hub that lost nothing is not reported — it was never collapsed.
 */
function summariseHubs(
  edges: readonly CoEdge[],
  hubPaths: readonly string[],
  degree: ReadonlyMap<string, number>,
  survived: readonly boolean[],
): HubSummary[] {
  return hubPaths
    .map((path): HubSummary => {
      const total = degree.get(path)!;
      let stillDrawn = 0;
      edges.forEach((e, i) => {
        if ((e.a === path || e.b === path) && survived[i]) stillDrawn++;
      });
      return { path, total, collapsed: total - stillDrawn };
    })
    .filter((h) => h.collapsed > 0)
    .sort((a, b) => b.collapsed - a.collapsed);
}

/* ────────────────────────────────────────────────────────────────────────
 * Edge scope declaration — task brief P4, Problema 2.
 *
 * The relation count must never change in silence across pagination: the
 * map/ego count line has to name WHICH population of groups it drew from.
 * `CodeAnalysis.page`/`groupsTotal` (F5, already shipped) carry exactly
 * that; this is a small local shape around them so both `HotspotMap.vue`
 * and `EgoView.vue` phrase it identically.
 *
 * This is deliberately the fallback the brief asks for: P3's own
 * `EDGE_KIND_LEGEND`-adjacent "scope" export (`graph-edges.ts`) had not
 * landed as of this change (grepped — no such export exists yet). Same
 * shape in spirit; swap the import the day it does, don't block on it.
 * ──────────────────────────────────────────────────────────────────────── */

export interface EdgeScope {
  /** 1-based inclusive label of the loaded window, e.g. "1–200" — absent when `page` never shipped for this analysis (old cache) or pagination is moot ("unlimited"). */
  rangeLabel?: string;
  /** Real total groups in the repo, independent of pagination — absent for an analysis cached before F5's `groupsTotal`. */
  totalGroups?: number;
  /** Groups actually loaded right now (`findings.length` — what `deriveEdges` actually saw). */
  loadedGroups: number;
}

/** See {@link EdgeScope}. Never throws: every field it reads is optional on `CodeAnalysis`. */
export function edgeScopeFor(analysis: Pick<CodeAnalysis, "findings" | "page" | "groupsTotal">): EdgeScope {
  const loadedGroups = analysis.findings.length;
  const page = analysis.page;
  return {
    rangeLabel: page ? `${page.offset + 1}–${page.offset + loadedGroups}` : undefined,
    totalGroups: analysis.groupsTotal,
    loadedGroups,
  };
}

/**
 * Renders {@link EdgeScope} as the clause the brief demands: "de los grupos
 * N–M cargados" (never silence about which slice of the repo this is). A
 * cached analysis from before F5 (no `page`/`groupsTotal`) still gets an
 * honest sentence — it just can't name a range.
 */
export function edgeScopeLabel(scope: EdgeScope): string {
  if (scope.rangeLabel && scope.totalGroups != null) {
    return `de los grupos ${scope.rangeLabel} de ${scope.totalGroups} cargados`;
  }
  if (scope.rangeLabel) return `de los grupos ${scope.rangeLabel} cargados`;
  return `de los ${scope.loadedGroups} grupos cargados (sin datos de paginación)`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Edge-kind legend — task brief P4, Problema 3.
 *
 * `.map__legend` only ever documented circle severity; the user had to
 * hover a curve to learn red = duplicación / morado = hipótesis. Colours
 * come from `edgeInk()` (`graph-edges.ts`, P3's own, unmodified here) so
 * this can never drift from what the curves actually render — only the
 * Spanish label per kind is new. `referencia` is left out: `deriveEdges`
 * never emits it yet (Nivel 2 doesn't exist), and a legend key for a kind
 * that can't appear would be its own kind of lie.
 *
 * P3's own `EDGE_KIND_LEGEND` export (`graph-edges.ts`) has since landed —
 * this now reads its `color` directly instead of round-tripping through a
 * hand-built `CoEdge` stub (which broke `vue-tsc` once `label` became
 * required on `CoEdge`, integration-time finding). Kept as its own export
 * (rather than re-exporting P3's verbatim) because the shape differs on
 * purpose: an ARRAY excluding `referencia` (nothing this module ever
 * renders emits it — see the module docblock above), where P3's own is a
 * `Record` over every kind for O(1) lookup by callers that already have a
 * `kind` in hand (`edgeInk`).
 *
 * F-RETIRO-VÍA-VIEJA: había un tercer kind acá, `oportunidad` ("vía
 * legada") — retirado junto con `analysis.opportunities`/`CoEdgeKind`'s
 * propio miembro `oportunidad` (`graph-edges.ts`), que `analyzeRepo` ya no
 * produce.
 * ──────────────────────────────────────────────────────────────────────── */

export interface EdgeKindLegendEntry {
  kind: CoEdgeKind;
  label: string;
  rgb: string;
}

const EDGE_KIND_LABEL: Record<Exclude<CoEdgeKind, "referencia">, string> = {
  duplicacion: "duplicación",
  hipotesis: "hipótesis de patrón",
};

export const EDGE_KIND_LEGEND_FALLBACK: EdgeKindLegendEntry[] = (
  Object.keys(EDGE_KIND_LABEL) as (keyof typeof EDGE_KIND_LABEL)[]
).map((kind) => ({
  kind,
  label: EDGE_KIND_LABEL[kind],
  rgb: EDGE_KIND_LEGEND[kind].color,
}));
