/**
 * Honesty line for the code graph — PLAN.md fase F3, "Qué ve el usuario":
 * *"grafo: N símbolos, M aristas, K referencias sin resolver (X%)"*.
 * Pure formatting, kept out of CodePanel.vue for the same reason
 * findings.ts/grouping.ts are: testable without mounting Vue.
 *
 * ── WIRING GAP, CERRADO (integración) ────────────────────────────────────
 * Este módulo se escribió contra una forma ESPECULATIVA de `GraphSummary`
 * (nodos como arreglo `{kind}[]`, aristas como arreglo) antes de que
 * `CodeAnalysis.graph` existiera en el contrato. Ya existe (`@shared/types`,
 * `CodeGraphSummary`) y llegó con una forma distinta — CONTEOS, no arreglos
 * (`symbols: number`, `edges: number`, nunca un nodo/arista individual viaja
 * al cliente, a propósito: ver el docstring de `CodeGraphSummary`). `graphOf`
 * ahora tipa contra ESE contrato real; `GraphSummary` de abajo es
 * `CodeGraphSummary` extendido con el `byLanguage` opcional que sigue sin
 * existir en el contrato (ver más abajo) — nada más en este módulo ni en
 * `CodePanel.vue` tuvo que moverse: `symbolCount`/`edgeCount` leen los
 * conteos directo en vez de medir un arreglo.
 *

 * ── PER-LANGUAGE COVERAGE — GAP, DECLARED ───────────────────────────────
 * The task asks that a high unresolved rate in one language of a
 * multi-language repo be visible: a Ruby repo's graph genuinely sees less
 * than a Go repo's (measured in the F3 cascade write-up against real repos:
 * jekyll ended with droppedAmbiguous/candidates ≈ 8.1%, cobra ≈ 0.0%). But
 * `ResolutionStats` (`graph/stages.ts`, already implemented, not this
 * task's file to edit) has NO per-language dimension — only `byStage`. There
 * is no honest way to compute a per-language unresolved rate from
 * `CodeGraph` as it stands: the graph only holds what the cascade ACCEPTED
 * (nodes/edges), so nothing in it counts a language's REJECTED candidates.
 *
 * This module therefore accepts an OPTIONAL `byLanguage` breakdown (shape
 * below, not part of any contract today — a suggestion for whoever wires
 * this next) and, applying the same "no aplicable, nunca cero" rule the task
 * names for the top-level line, renders it only when present. When a repo
 * has more than one language and the breakdown is absent, `languageNote`
 * says so explicitly ("no disponible por lenguaje") instead of staying
 * silent — silence would read as "coverage is uniform across languages",
 * exactly the misrepresentation this task exists to avoid. When present, a
 * language with zero candidates renders "no aplicable", never "0%" (a
 * fabricated 0% would read as "inspected and fully resolved", not as
 * "nothing was attempted here").
 */

import type { CodeGraphSummary } from "@shared/types";

export interface GraphResolutionStats {
  readonly candidates: number;
  readonly resolved: number;
  /** VA A PANTALLA — CONTRATO-F3.md §3.4. */
  readonly droppedAmbiguous: number;
  readonly unresolved: number;
}

/** Not part of any contract yet — see the module docstring. */
export interface GraphLanguageCoverage {
  readonly language: string;
  readonly candidates: number;
  readonly droppedAmbiguous: number;
  readonly unresolved: number;
}

/**
 * El contrato real (`CodeGraphSummary`) más el único agregado especulativo
 * que sigue sin existir ahí (`byLanguage`, opcional): cualquier
 * `CodeGraphSummary` genuino es un `GraphSummary` válido tal cual, sin
 * traducción — quien conecte el desglose por lenguaje algún día sólo agrega
 * el campo, no cambia esta forma.
 */
export interface GraphSummary extends CodeGraphSummary {
  readonly byLanguage?: readonly GraphLanguageCoverage[];
}

/** Picks the graph off an analysis that may or may not carry one yet — see the module docstring. */
export function graphOf(analysis: { graph?: GraphSummary } | null | undefined): GraphSummary | null {
  return analysis?.graph ?? null;
}

export function symbolCount(graph: GraphSummary): number {
  return graph.symbols;
}

export function edgeCount(graph: GraphSummary): number {
  return graph.edges;
}

/** Candidates that survived the cascade without a single accepted destination. */
export function unresolvedTotal(resolution: GraphResolutionStats): number {
  return resolution.droppedAmbiguous + resolution.unresolved;
}

/**
 * `unresolvedTotal / candidates`, as a percentage. `candidates === 0` reads
 * as "no aplicable" (0, by convention — the caller must check `candidates`
 * before trusting this as a real rate) rather than dividing by zero into
 * `NaN`, which would render as the literal text "NaN%".
 */
export function unresolvedPct(resolution: GraphResolutionStats): number {
  if (resolution.candidates === 0) return 0;
  return (unresolvedTotal(resolution) / resolution.candidates) * 100;
}

export function formatPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/**
 * The header line itself: *"grafo: N símbolos, M aristas, K referencias sin
 * resolver (X%)"*, with `droppedAmbiguous` broken out per the task's
 * explicit ask ("con el número de descartes por ambigüedad visible") — never
 * folded silently into the unresolved total without a breakdown, since
 * `unresolved` (zero surviving targets) and `droppedAmbiguous` (more than
 * one surviving target) are different failure shapes worth telling apart.
 */
export function graphHeaderLine(graph: GraphSummary): string {
  const symbols = symbolCount(graph);
  const edges = edgeCount(graph);
  const { resolution } = graph;
  const unresolved = unresolvedTotal(resolution);
  const pct = resolution.candidates === 0 ? "no aplicable" : formatPct(unresolvedPct(resolution));
  const base = `grafo: ${symbols} símbolos, ${edges} aristas, ${unresolved} referencias sin resolver (${pct})`;
  return resolution.droppedAmbiguous > 0 ? `${base} · ${resolution.droppedAmbiguous} por ambigüedad` : base;
}

export type LanguageCoverageRow =
  | { readonly kind: "rate"; readonly language: string; readonly pct: string }
  | { readonly kind: "not-applicable"; readonly language: string };

/**
 * Per-language rows for the coverage breakdown — "no aplicable" (never a
 * fabricated "0%") for a language the cascade never got a candidate from.
 * `null` when no breakdown was supplied at all (see `languageNote`).
 */
export function languageCoverageRows(graph: GraphSummary): LanguageCoverageRow[] | null {
  if (!graph.byLanguage) return null;
  return graph.byLanguage.map((row) => {
    if (row.candidates === 0) return { kind: "not-applicable", language: row.language };
    const pct = ((row.droppedAmbiguous + row.unresolved) / row.candidates) * 100;
    return { kind: "rate", language: row.language, pct: formatPct(pct) };
  });
}

/**
 * Explains a MISSING per-language breakdown honestly instead of hiding the
 * gap: `null` when there is nothing to explain (single-language repo, or the
 * breakdown is actually present — `languageCoverageRows` covers that case).
 */
export function languageCoverageNote(graph: GraphSummary, languages: readonly string[]): string | null {
  if (graph.byLanguage) return null;
  if (languages.length <= 1) return null;
  return "cobertura por lenguaje: no disponible en este análisis";
}
