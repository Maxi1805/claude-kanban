/**
 * Co-problem edges over the hotspot map — CONTRATO-F7.md Contrato 2.
 *
 * The real reference graph (imports/calls/extends — `CodeGraph` in
 * `graph/types.ts`) is a persisted sqlite blob that no HTTP route exposes
 * today (verified against `src/server/api/code.ts`: only `GET .../code`,
 * `discard`, `restore`). Rather than block the whole feature on a backend
 * change, this module derives a DIFFERENT, honest kind of edge from what
 * already travels in `CodeAnalysis`: "these files share a problem" —
 *
 *   - `duplicacion` — a `CodeFinding` whose `locations[]` span ≥ 2 files
 *     (duplication, or any grouped finding F5 collapsed across files).
 *   - `hipotesis`   — a `CodeFindingHypothesis` whose `places[]` span ≥ 2
 *     files (the bridging places of an `aplicado-eludido` hypothesis are
 *     usually exactly this).
 *
 * F-RETIRO-VÍA-VIEJA: había un tercer kind, `oportunidad` (una legacy
 * `CodePatternOpportunity`) — retirado junto con `analysis.opportunities`,
 * que `analyzeRepo` ya no produce (decisión del usuario). `CoEdgeKind` volvió
 * a dos miembros reales más `referencia` (reservado, ver abajo).
 *
 * `referencia` is reserved in {@link CoEdge} for the day a real graph edge
 * reaches the frontend (Nivel 2, `GET .../graph/ego`) — this module never
 * emits it, and `EgoView.vue` shows the degraded notice from §2.0 while it
 * doesn't.
 *
 * ANCHOR, NOT CLIQUE — a finding/hypothesis touching k files gets k-1 edges
 * (anchor → every other file), never the C(k,2) complete graph. A 35-file
 * duplication group (real, measured on guava) would otherwise dump 595
 * edges for ONE problem; the anchor is the same file `buildTree` already
 * attributes the finding to (its first location / first place), so the map
 * and the edges agree on what "this problem's home" means.
 *
 * SCOPE, NOT A GLOBAL COUNT — `analysis` is whatever page the shell fetched
 * (`CodeAnalysis.page`, 200 groups by default), so `deriveEdgesWithScope`
 * returns an {@link EdgeScope} alongside the edges: how many
 * findings/hypotheses it actually examined, and whether that was the
 * complete ranked list, a page of it, or unknown. `deriveEdges` (kept for
 * existing callers) drops the scope — new callers should prefer
 * `deriveEdgesWithScope` and surface `scope.completeness` next to any count
 * derived from its edges.
 */
import type {
  CodeAnalysis,
  CodeFinding,
  CodeFindingHypothesis,
  PatternConfidence,
  PatternOpportunityPlace,
} from "@/types";

export type CoEdgeKind = "duplicacion" | "hipotesis" | "referencia";

/**
 * CONGELADO — P4 (`HotspotMap.vue`/`GraphOverlay.vue`/`EgoView.vue`) reads
 * this so the map's legend names/colors every `CoEdgeKind` from ONE place
 * instead of reinventing the strings. `color` is the same bare RGB triplet
 * (no `rgba()` wrapper) `edgeInk` uses internally — callers pick the alpha.
 */
export const EDGE_KIND_LEGEND: Record<CoEdgeKind, { label: string; color: string }> = {
  duplicacion: { label: "Duplicación", color: "235, 87, 87" },
  hipotesis: { label: "Hipótesis de patrón", color: "178, 120, 255" },
  referencia: { label: "Referencia real (Nivel 2)", color: "160, 160, 160" },
};

/**
 * `CodeGraphEdge.provenance` (`server/services/graph/types.ts`) verbatim:
 * `declared` = the syntax says so, `resolved` = the resolution cascade
 * worked it out, `inferred` = a heuristic guess. Only a future Nivel-2
 * `referencia` edge (real graph, `GET .../graph/ego`) ever carries this —
 * `deriveEdges` below never sets it, because a co-problem edge doesn't have
 * a declared/resolved/inferred axis, only its `kind` does. Declared here,
 * additive to the frozen `CoEdge` shape, so the day Nivel 2 lands an
 * "inferred" reference already renders with less ink than a "declared" one
 * (`edgeInk` below) instead of that being a second wave of work.
 *
 * *** INALCANZABLE HOY. *** Nivel 2 doesn't exist yet (see module docblock)
 * so NOTHING ever sets this — 0 of every Nivel-1 edge this module has ever
 * produced carries a `provenance`. The three `edgeInk` branches that key off
 * it are dead code until a real `GET .../graph/ego` lands; don't read them
 * as evidence of current behaviour, and don't delete them — they're staged,
 * not vestigial.
 */
export type EdgeProvenance = "declared" | "resolved" | "inferred";

/**
 * One `kind`'s contribution to a merged {@link CoEdge} — see `components`
 * there. `weight`/`label` are scoped to just this kind (max weight and
 * "+N más" count among THIS kind's raw edges for the pair), never mixed
 * with a sibling kind's numbers.
 */
export interface EdgeComponent {
  kind: CoEdgeKind;
  weight: number;
  label: string;
}

/** One co-problem (or, eventually, real-reference) relation between two files. */
export interface CoEdge {
  a: string;
  b: string;
  /** The dominant (highest-weight) kind — drives `edgeInk`'s hue and the budget ranking. */
  kind: CoEdgeKind;
  /** Max weight across every kind linking this pair. Higher = kept first when the budget cuts. */
  weight: number;
  /** What produced the edge, already humanised — goes in the tooltip/legend. */
  label: string;
  /**
   * Every kind that links this pair, one entry each, sorted by weight desc —
   * so a pair with BOTH a duplication finding and a bridging hypothesis
   * renders as ONE curve that can still say "duplicación + hipótesis"
   * instead of two near-overlapping ones. `kind`/`weight`/`label` above
   * always mirror `components[0]`. Optional only because callers that build
   * a `CoEdge` by hand (tests, `graph-layout.ts` fixtures) don't need it —
   * every edge `deriveEdges` emits always has it.
   */
  components?: EdgeComponent[];
  /** See {@link EdgeProvenance}. Absent for every Nivel-1 edge this module produces. */
  provenance?: EdgeProvenance;
}

/**
 * CONGELADO — what universe {@link deriveEdgesWithScope} actually examined.
 * `CodeAnalysis` arrives PAGINATED (200 groups by default, `analysis.page`);
 * without this, an edge count reads as repo-wide when it might be one page
 * of many (reproduced: same repo, page 1 → 517 candidate edges, page 2 →
 * 191, unpaginated → 1312 — three different "totals" from one `deriveEdges`
 * call with no way to tell them apart before this type existed).
 *
 * `completeness`:
 *   - `'completo'`    — `page.offset === 0 && !page.hasMore`: this WAS the
 *                        whole ranked list, not a slice of it.
 *   - `'parcial'`     — `page` is present and says there's more (either
 *                        `hasMore`, or `offset > 0` so earlier groups were
 *                        never even in this payload).
 *   - `'desconocido'` — `analysis.page` is absent entirely (a cached
 *                        analysis from before F5 shipped `page`, or any
 *                        payload built without it). NEVER defaulted to
 *                        `'completo'` — an unlabelled payload might be a
 *                        full analysis or an old page, and guessing wrong
 *                        is worse than admitting "no sé".
 */
export interface EdgeScope {
  /** `analysis.findings.length` — how many findings were looked at for `duplicacion`/`hipotesis` edges. */
  findingsExamined: number;
  /** Sum of `finding.hypotheses.length` over every examined finding. */
  hypothesesExamined: number;
  completeness: "completo" | "parcial" | "desconocido";
  /** Verbatim `analysis.page`, when the payload declares one — for the caller's own "N de M" line. */
  page?: { offset: number; limit: number; hasMore: boolean };
  /** Verbatim `analysis.groupsTotal`, the denominator behind "examined N of groupsTotal". */
  groupsTotal?: number;
}

/** `CodeFindingHypothesis.confidence`/legacy `PatternConfidence` → a comparable weight. */
function confidenceWeight(confidence: PatternConfidence): number {
  if (confidence === "alta") return 0.9;
  if (confidence === "media") return 0.6;
  return 0.3;
}

/**
 * A hypothesis with `confidence: null` is NOT "cero señal" — it means the
 * state itself no longer competes on confidence (§1.3). `aplicado-eludido`
 * still deserves a HIGH edge weight: it is the one state whose bridging
 * places are the whole point of drawing the edge in the first place.
 */
function hypothesisWeight(h: CodeFindingHypothesis): number {
  if (h.confidence) return confidenceWeight(h.confidence);
  return h.state === "aplicado-eludido" ? 0.8 : 0.4;
}

interface RawEdge {
  a: string;
  b: string;
  kind: CoEdgeKind;
  weight: number;
  detail: string;
}

function starEdges(files: readonly string[], kind: CoEdgeKind, weight: number, detail: string): RawEdge[] {
  const distinct = [...new Set(files)];
  if (distinct.length < 2) return [];
  const [anchor, ...rest] = distinct;
  return rest.map((b) => ({ a: anchor!, b, kind, weight, detail }));
}

/**
 * Every co-problem edge in the analysis, Nivel 1, undeduplicated by pair —
 * see {@link deriveEdges} for the merge that follows. Exported separately so
 * tests can check the raw star-shaped fan-out before it collapses.
 */
function rawEdges(analysis: CodeAnalysis): RawEdge[] {
  const out: RawEdge[] = [];

  for (const finding of analysis.findings) {
    const files = finding.locations.map((l) => l.file);
    const weight = finding.score ?? finding.severity / 100;
    out.push(...starEdges(files, "duplicacion", weight, finding.title));

    for (const h of finding.hypotheses ?? []) {
      out.push(
        ...starEdges(
          h.places.map((p: PatternOpportunityPlace) => p.file),
          "hipotesis",
          hypothesisWeight(h),
          `Hipótesis · ${h.pattern}`,
        ),
      );
    }
  }

  return out;
}

/** Unordered pair key, order-independent so `a—b` and `b—a` merge. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

interface MergedPair {
  a: string;
  b: string;
  /** Per-kind accumulator — the fix for problem 2: merge across KINDS too, not just within one. */
  byKind: Map<CoEdgeKind, { weight: number; details: string[] }>;
}

function componentLabel(details: string[]): string {
  return details.length === 1 ? details[0]! : `${details[0]} (+${details.length - 1} más)`;
}

/**
 * Derive Nivel-1 co-problem edges from an analysis. ALL raw edges between
 * the same pair of files merge into ONE `CoEdge`, regardless of kind —
 * several duplication findings between the same two files are one
 * relationship, not a stack of identical lines, and a pair linked by BOTH a
 * duplication finding AND a bridging hypothesis is still one relationship
 * (before this, same-kind-only merging left near-overlapping parallel
 * curves for exactly the hub pairs already busiest on screen). `kind`/
 * `weight`/`label` mirror the strongest component; `components` carries
 * every kind so nothing is lost — a tooltip can still enumerate
 * "duplicación (0.9) + hipótesis (0.8)".
 *
 * Drops the {@link EdgeScope} for backward compatibility with callers that
 * predate it (`HotspotMap.vue`) — new callers should prefer
 * {@link deriveEdgesWithScope} and surface `scope.completeness` next to any
 * count derived from these edges.
 */
export function deriveEdges(analysis: CodeAnalysis): CoEdge[] {
  return deriveEdgesWithScope(analysis).edges;
}

/** Same as {@link deriveEdges}, plus the {@link EdgeScope} needed to present counts honestly. */
export function deriveEdgesWithScope(analysis: CodeAnalysis): { edges: CoEdge[]; scope: EdgeScope } {
  const merged = new Map<string, MergedPair>();

  for (const raw of rawEdges(analysis)) {
    const key = pairKey(raw.a, raw.b);
    let pair = merged.get(key);
    if (!pair) {
      pair = { a: raw.a, b: raw.b, byKind: new Map() };
      merged.set(key, pair);
    }
    const existing = pair.byKind.get(raw.kind);
    if (existing) {
      existing.weight = Math.max(existing.weight, raw.weight);
      if (!existing.details.includes(raw.detail)) existing.details.push(raw.detail);
    } else {
      pair.byKind.set(raw.kind, { weight: raw.weight, details: [raw.detail] });
    }
  }

  const edges = [...merged.values()].map(({ a, b, byKind }) => {
    const components: EdgeComponent[] = [...byKind.entries()]
      .map(([kind, { weight, details }]) => ({ kind, weight, label: componentLabel(details) }))
      .sort((x, y) => y.weight - x.weight);
    const dominant = components[0]!;
    const label =
      components.length === 1
        ? dominant.label
        : `${dominant.label} (+${components.length - 1} tipo${components.length - 1 === 1 ? "" : "s"} de arista más)`;
    return { a, b, kind: dominant.kind, weight: dominant.weight, label, components };
  });

  return { edges, scope: scopeOf(analysis) };
}

/** See {@link EdgeScope} — never assumes 'completo' when `analysis.page` is missing. */
function scopeOf(analysis: CodeAnalysis): EdgeScope {
  const findingsExamined = analysis.findings.length;
  const hypothesesExamined = analysis.findings.reduce((sum, f) => sum + (f.hypotheses?.length ?? 0), 0);
  const page = analysis.page;
  const completeness: EdgeScope["completeness"] = !page
    ? "desconocido"
    : page.offset === 0 && !page.hasMore
      ? "completo"
      : "parcial";

  return {
    findingsExamined,
    hypothesesExamined,
    completeness,
    page,
    groupsTotal: analysis.groupsTotal,
  };
}

/**
 * §2.2 step 1 — restrict edges to the current zoom. `files` is every file
 * path the map currently draws a circle for (the descendants of the
 * `focusPath` directory the caller is showing).
 *
 * At the root (`focusPath === ""`) every file in the repo has a circle
 * (`layout` packs the WHOLE subtree, every depth), so nothing collapses.
 * Once zoomed into a subdirectory, a file outside it has no circle to point
 * at — its end of the edge collapses onto `focusPath` itself, the outermost
 * ring still on screen (drawn at depth 0 by `HotspotMap.vue`), which is the
 * nearest ancestor of that file that is actually visible. An edge with BOTH
 * ends outside the current zoom carries no information about what's on
 * screen and is dropped, not collapsed.
 */
export function collapseToFocus(
  edges: readonly CoEdge[],
  focusPath: string,
  files: readonly string[],
): CoEdge[] {
  const known = new Set(files);
  const inFocus = (file: string): boolean =>
    focusPath === "" || file === focusPath || file.startsWith(`${focusPath}/`);

  const out: CoEdge[] = [];
  for (const edge of edges) {
    if (!known.has(edge.a) || !known.has(edge.b)) continue;
    const aIn = inFocus(edge.a);
    const bIn = inFocus(edge.b);
    if (!aIn && !bIn) continue;
    if (aIn && bIn) {
      out.push(edge);
      continue;
    }
    // Collapse the outside end onto the focus ring. Skip a self-loop this
    // would create if the inside end already IS the focus directory node.
    const inside = aIn ? edge.a : edge.b;
    if (inside === focusPath) continue;
    out.push({ ...edge, a: inside, b: focusPath });
  }
  return out;
}

/**
 * §2.2 steps 2-3 — hard cap. Ranks by `weight` (the strongest signal behind
 * each edge) and keeps the top `max`; the caller is responsible for the
 * always-visible "N de M, N ocultas" line (§2.2) — this just supplies both
 * numbers honestly, never truncating in silence.
 */
export function budget(edges: readonly CoEdge[], max: number): { visible: CoEdge[]; hidden: number } {
  const sorted = [...edges].sort((x, y) => y.weight - x.weight);
  return { visible: sorted.slice(0, max), hidden: Math.max(0, sorted.length - max) };
}

/**
 * The ego network around `file`: every node reachable within `hops` steps
 * (undirected, `edges` treated as a plain graph) plus every edge — not just
 * the ones used to discover a node — whose BOTH ends land inside that
 * neighbourhood, so two siblings that both reach `file` in one hop but are
 * ALSO linked to each other still show that link.
 */
export function ego(
  edges: readonly CoEdge[],
  file: string,
  hops: 1 | 2,
): { nodes: string[]; edges: CoEdge[] } {
  const nodes = withinHops(undirectedAdjacency(edges), file, hops);
  // Every edge with BOTH ends inside — not just the ones the walk used.
  const egoEdges = edges.filter((e) => nodes.has(e.a) && nodes.has(e.b));
  return { nodes: [...nodes], edges: egoEdges };
}

/** The edge list read as a plain undirected graph: each end listed under the other. */
function undirectedAdjacency(edges: readonly CoEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const link = (x: string, y: string): void => {
    if (!adjacency.has(x)) adjacency.set(x, new Set());
    adjacency.get(x)!.add(y);
  };
  for (const e of edges) {
    link(e.a, e.b);
    link(e.b, e.a);
  }
  return adjacency;
}

/** Breadth-first: `start` plus everything reachable in at most `hops` steps. */
function withinHops(
  adjacency: ReadonlyMap<string, Set<string>>,
  start: string,
  hops: number,
): Set<string> {
  const nodes = new Set<string>([start]);
  let frontier = new Set<string>([start]);
  for (let step = 0; step < hops; step++) {
    const next = new Set<string>();
    for (const n of frontier) {
      for (const neighbour of adjacency.get(n) ?? []) {
        if (!nodes.has(neighbour)) next.add(neighbour);
      }
    }
    for (const n of next) nodes.add(n);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return nodes;
}

/**
 * How much ink an edge earns — `GraphOverlay.vue`/`EgoView.vue` both call
 * this so the map and the ego view agree on what a "declared" vs. an
 * "inferred" relationship looks like (task brief: "una arista inferida no
 * merece la misma tinta que una declarada").
 *
 * *** THE FIRST THREE BRANCHES ARE DEAD CODE TODAY. *** No Nivel-1 edge has
 * a `provenance` — see {@link EdgeProvenance}: it's INALCANZABLE until a
 * real `GET .../graph/ego` exists (Nivel 2). Every edge this module has
 * ever produced falls to the last branch — weight alone drives the
 * opacity, `kind` drives the hue via {@link EDGE_KIND_LEGEND}. Don't read
 * the `declared`/`resolved`/`inferred` branches as evidence of current
 * rendering; they're staged for Nivel 2, not exercised by anything today.
 */
export function edgeInk(edge: CoEdge): { rgb: string; opacity: number; dashed: boolean } {
  const rgb = EDGE_KIND_LEGEND[edge.kind].color;
  if (edge.provenance === "declared") return { rgb, opacity: 0.8, dashed: false };
  if (edge.provenance === "resolved") return { rgb, opacity: 0.55, dashed: false };
  if (edge.provenance === "inferred") return { rgb, opacity: 0.22, dashed: true };
  return { rgb, opacity: Math.min(0.85, 0.25 + edge.weight * 0.6), dashed: false };
}
