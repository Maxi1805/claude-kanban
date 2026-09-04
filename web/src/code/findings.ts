/**
 * Pure ranking/formatting helpers for code hotspots.
 *
 * Kept separate from CodePanel so the ranking rule (what counts as "worse")
 * and the location/count formatting are testable without mounting Vue —
 * mirrors ../schema/grouping.ts, which does the same for the diagram.
 */
import type {
  CodeFinding,
  CodeFindingKind,
  CodeFindingKindInfo,
  CodeLocation,
  KnownCodeFindingKind,
} from "@/types";

/**
 * `CodeFindingKind` ES UNA UNIÓN ABIERTA (ver su comentario en
 * `shared/types.ts`): el kind lo aporta el detector que lo emite, así que este
 * módulo NO puede asumir que conoce todos los valores posibles. Nada de acá
 * hace un `switch` exhaustivo ni indexa un `Record` completo; todo mapeo de
 * kind → etiqueta/orden pasa por `kindLabel`/`orderedKinds`, que tienen un
 * camino por defecto para el kind que nunca vieron.
 */

/**
 * Orden de exhibición de los kinds LEGADOS — los que el analizador de hoy
 * emite. Es una preferencia de presentación congelada, no el catálogo: los
 * kinds que no estén acá se muestran igual, después de éstos (ver
 * `orderedKinds`). Un detector nuevo NO agrega su kind acá.
 */
export const KIND_ORDER: KnownCodeFindingKind[] = [
  "duplication",
  "conditional-chain",
  "complexity",
  "long-function",
  "long-parameter-list",
  "empty-catch",
  "large-class",
  "repeated-switch",
];

/**
 * Etiquetas en español de los kinds LEGADOS. `Record<KnownCodeFindingKind, …>`
 * y no `Record<CodeFindingKind, …>` justamente para que el compilador no
 * mienta: este diccionario está completo sobre los 8 conocidos y sobre nada
 * más. La etiqueta de cualquier otro kind llega en el payload
 * (`CodeAnalysis.kinds`) o se humaniza — ver `kindLabel`.
 */
export const KIND_LABELS: Record<KnownCodeFindingKind, string> = {
  duplication: "Duplicación",
  "conditional-chain": "Cadena de condicionales",
  complexity: "Complejidad",
  "long-function": "Función larga",
  "long-parameter-list": "Muchos parámetros",
  "empty-catch": "Excepción tragada",
  "large-class": "Clase grande",
  "repeated-switch": "Switch repetido",
};

/**
 * `"shotgun-surgery"` → `"Shotgun surgery"`. Último recurso: un kind del que
 * no hay etiqueta ni legada ni en el catálogo del payload. Se muestra
 * legible en vez de romper la fila de totales o pintar un hueco vacío — el
 * slug ya es kebab-case por contrato (`registry.test.ts` lo verifica).
 */
function humanizeKind(kind: string): string {
  const words = kind.replace(/-/g, " ").trim();
  return words.length === 0 ? kind : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Nombre en pantalla de un kind. Tres escalones, de más específico a más
 * genérico, y ninguno puede fallar:
 *
 *   1. el catálogo que vino EN EL PAYLOAD (`CodeAnalysis.kinds`), derivado del
 *      registro de detectores — así es como la etiqueta de un kind nuevo llega
 *      sin que nadie edite este archivo;
 *   2. las etiquetas legadas de arriba — cubren los análisis cacheados de
 *      antes de que el campo `kinds` existiera;
 *   3. el slug humanizado.
 */
export function kindLabel(
  kind: CodeFindingKind,
  catalog?: readonly CodeFindingKindInfo[],
): string {
  const fromCatalog = catalog?.find((entry) => entry.kind === kind);
  if (fromCatalog) return fromCatalog.label;
  const legacy = (KIND_LABELS as Record<string, string | undefined>)[kind];
  return legacy ?? humanizeKind(kind);
}

/**
 * Los kinds a mostrar en el filtro y en la fila de totales, en orden estable:
 * primero los legados en su orden fijo, después los del catálogo del payload,
 * y por último cualquier kind que aparezca en los hallazgos y no esté en
 * ninguna de las dos listas (alfabético) — la red que garantiza que un
 * hallazgo nunca quede sin su casillero, aunque su detector sea más nuevo que
 * este frontend.
 */
export function orderedKinds(
  findings: readonly CodeFinding[],
  catalog?: readonly CodeFindingKindInfo[],
): CodeFindingKind[] {
  const seen = new Set<string>(KIND_ORDER);
  const ordered: CodeFindingKind[] = [...KIND_ORDER];
  for (const entry of catalog ?? []) {
    if (seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    ordered.push(entry.kind);
  }
  const extra = [...new Set(findings.map((f) => f.kind))].filter((k) => !seen.has(k)).sort();
  return [...ordered, ...extra];
}

/**
 * OLA BB, FRENTE BB2 — LOS KINDS, ORDENADOS POR CANTIDAD.
 *
 * Pedido textual: *"Ordenaría los kinds por cantidad"*. `orderedKinds` da el
 * orden de CATÁLOGO (los 8 legados congelados, después los del payload,
 * después los rescatados) — estable, pero sin ninguna relación con lo que hay
 * de verdad en este repo: en Ghost dejaba "Cadena de condicionales" (75) en
 * el segundo casillero y "Función larga" (1.684) en el cuarto, con 13 kinds
 * en cero mezclados en el medio.
 *
 * Esto NO reemplaza a `orderedKinds`: lo consume. El catálogo sigue siendo
 * quien decide QUÉ kinds existen (incluidos los que tienen cero hallazgos, que
 * se siguen mostrando — que un detector corriera y no encontrara nada es un
 * dato, no ruido a esconder); esta función sólo decide en qué ORDEN se leen.
 * Los ceros quedan al final solos, por ser los más chicos.
 *
 * Desempate EXPLÍCITO por la posición de entrada, nunca por que `Array.sort`
 * sea estable: mismo criterio que `rankFindings`/`rankItems`. Así dos kinds
 * con la misma cuenta conservan entre ellos el orden del catálogo y la barra
 * no tiembla entre polls.
 */
export function kindsByVolume(
  kinds: readonly CodeFindingKind[],
  counts: Readonly<Record<string, number>>,
): CodeFindingKind[] {
  return kinds
    .map((kind, index) => ({ kind, index, count: counts[kind] ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ kind }) => kind);
}

/**
 * Severity buckets driving each card's color. Deliberately reuses the board's
 * own status palette (danger/review/done) so "this is bad" reads the same
 * color here as it does everywhere else in the app.
 */
export type SeverityTier = "high" | "medium" | "low";

export function severityTier(severity: number): SeverityTier {
  if (severity >= 70) return "high";
  if (severity >= 40) return "medium";
  return "low";
}

/**
 * Findings ranked by impact, highest first. A plain `.sort` on `severity`
 * alone is not enough: Array.sort is stable in modern engines but relying on
 * that implicitly is how ranking order quietly starts jittering on a re-poll
 * that returns the same findings in a different object order, so ties are
 * broken explicitly by original index.
 */
export function rankFindings(findings: CodeFinding[]): CodeFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => b.finding.severity - a.finding.severity || a.index - b.index)
    .map(({ finding }) => finding);
}

/** Findings of one kind, or all of them when `kind` is null (the "todos" filter). */
export function filterFindings(
  findings: CodeFinding[],
  kind: CodeFindingKind | null,
): CodeFinding[] {
  return kind === null ? findings : findings.filter((f) => f.kind === kind);
}

/**
 * Count per kind, always with EVERY shown key present (zero when a kind has no
 * findings) — so the totals row never reshuffles as a count drops to zero
 * across a poll, it just shows 0.
 *
 * Las claves son las de `orderedKinds`, así que un hallazgo de un kind que
 * este frontend no conocía SÍ tiene su casillero: antes se derivaban de
 * `KIND_ORDER` a secas y un kind fuera de esa lista incrementaba una clave
 * `undefined` (`NaN` en pantalla). El tipo de retorno es `Record<string, …>`
 * y no `Record<CodeFindingKind, …>` porque con la unión abierta ese segundo
 * tipo prometería una completitud que ningún objeto puede tener.
 */
export function countsByKind(
  findings: CodeFinding[],
  catalog?: readonly CodeFindingKindInfo[],
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    orderedKinds(findings, catalog).map((kind) => [kind, 0]),
  );
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

/**
 * `file:line` (or `file:start-end` for a finding spanning several lines),
 * with the enclosing symbol appended when the analyzer reported one — the
 * exact shape asked for the location column.
 */
export function formatLocation(loc: CodeLocation): string {
  const range =
    loc.endLine > loc.startLine ? `${loc.startLine}-${loc.endLine}` : `${loc.startLine}`;
  const base = `${loc.file}:${range}`;
  return loc.symbol ? `${base} (${loc.symbol})` : base;
}

/**
 * Stable list key. The analyzer has no id for a finding and re-analysis can
 * reorder the array, so `v-for` needs something steadier than the array
 * index — the kind plus its first location pins it well enough in practice.
 */
export function findingKey(finding: CodeFinding): string {
  const first = finding.locations[0];
  const loc = first ? `${first.file}:${first.startLine}` : "?";
  return `${finding.kind}:${loc}:${finding.title}`;
}
