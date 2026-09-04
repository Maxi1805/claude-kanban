/**
 * Filtros de navegación de volumen — F5, punto 2 de la tarea: granularidad
 * (intra-función / intra-archivo / entre archivos), lenguaje y confianza.
 * `CodePanel.vue` ya tenía un filtro por `kind`; estos tres son ortogonales a
 * ese y se combinan con él.
 *
 * Granularidad y lenguaje se resuelven con datos que YA viajan en el payload
 * hoy (`coverage`, `files`) — no son huecos. La confianza sí lo es: ver la
 * sección al final del archivo.
 */
import type {
  CodeDetectorScope,
  CodeFileSummary,
  CodeFinding,
  CodeFindingHypothesisLayer,
  CodeFindingKind,
} from "@shared/types";
import { isOpenProposal } from "./hypotheses";

export const GRANULARITY_ORDER: CodeDetectorScope[] = ["intra-function", "intra-file", "inter-file"];

export const GRANULARITY_LABELS: Record<CodeDetectorScope, string> = {
  "intra-function": "Dentro de una función",
  "intra-file": "Dentro de un archivo",
  "inter-file": "Entre archivos",
};

/** Granularidad de un hallazgo, vía el mapa `kind -> scope` (`coverage.ts#scopeByKind`). `null` si el kind no está en la cobertura de este análisis (p. ej. un análisis cacheado sin `coverage`). */
export function granularityOf(
  finding: CodeFinding,
  scopeByKind: ReadonlyMap<CodeFindingKind, CodeDetectorScope>,
): CodeDetectorScope | null {
  return scopeByKind.get(finding.kind) ?? null;
}

/** `scope === null` (el filtro "todas") pasa todo; si no, sólo lo que resuelve a esa granularidad. Un hallazgo sin granularidad conocida NUNCA pasa un filtro activo — no puede afirmarse que coincide con algo que no sabe. */
export function filterByGranularity(
  findings: readonly CodeFinding[],
  scope: CodeDetectorScope | null,
  scopeByKind: ReadonlyMap<CodeFindingKind, CodeDetectorScope>,
): CodeFinding[] {
  if (scope === null) return [...findings];
  return findings.filter((f) => granularityOf(f, scopeByKind) === scope);
}

/** `path -> language`, derivado de `CodeAnalysis.files` (ya real, F3). */
export function languageMap(files: readonly CodeFileSummary[]): ReadonlyMap<string, string> {
  return new Map(files.map((f) => [f.path, f.language]));
}

/** Lenguaje del archivo primario de un hallazgo. `null` si el archivo no está en `files` (no debería pasar salvo análisis muy viejo). */
export function languageOf(finding: CodeFinding, languages: ReadonlyMap<string, string>): string | null {
  const file = finding.locations[0]?.file;
  return file ? (languages.get(file) ?? null) : null;
}

export function filterByLanguage(
  findings: readonly CodeFinding[],
  language: string | null,
  languages: ReadonlyMap<string, string>,
): CodeFinding[] {
  if (language === null) return [...findings];
  return findings.filter((f) => languageOf(f, languages) === language);
}

/** Lenguajes distintos presentes en los hallazgos dados, orden alfabético — para poblar el `<select>`. */
export function languagesIn(findings: readonly CodeFinding[], languages: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  for (const f of findings) {
    const lang = languageOf(f, languages);
    if (lang) seen.add(lang);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/* ─────────────────────────────────────────────────────────────────────────
 * FAMILIA PROPUESTA — OLA BB, FRENTE BB2.
 *
 * El problema que el usuario nombró con todas las letras: *"tener una lista
 * infinita es medio complicado para ver un patrón específico"*. En Ghost la
 * lista tiene 3.910 tarjetas y 1.850 propuestas repartidas en 15 familias —
 * 1.505 de ellas "Extract Method". Hasta hoy no había NINGUNA forma de pedir
 * "mostrame las 141 de Split Phase": el filtro por `kind` filtra por el
 * PROBLEMA que el detector midió, no por la SOLUCIÓN que la hipótesis
 * propone, y son dos ejes distintos (un mismo "Extract Method" cuelga de
 * `long-function`, de `complexity` y de `duplication`).
 *
 * NO ES PAGINAR — el usuario lo prohibió explícitamente. La lista sigue
 * entera con el filtro en "todas"; esto es una forma de ENCONTRAR, no un
 * recorte por defecto.
 *
 * Y las cuentas de las opciones son las de lo que la lista DE VERDAD dibuja
 * (misma capa, mismos estados abiertos): una opción que prometa 108 tarjetas
 * y muestre 0 sería peor que no tener el filtro.
 * ──────────────────────────────────────────────────────────────────────── */

export interface FamilyCount {
  /** El nombre de la familia — `CodeFindingHypothesis.pattern`. */
  readonly pattern: string;
  /** Cuántos HALLAZGOS (tarjetas), no cuántas hipótesis: es lo que el filtro va a mostrar. */
  readonly findings: number;
}

/** Las familias que ESTE hallazgo propone hoy en la lista: capa `layer`, y sólo las abiertas. */
function familiesOf(finding: CodeFinding, layer: CodeFindingHypothesisLayer): Set<string> {
  const out = new Set<string>();
  for (const h of finding.hypotheses ?? []) {
    if (h.layer === layer && isOpenProposal(h)) out.add(h.pattern);
  }
  return out;
}

/**
 * Las familias presentes, de más tarjetas a menos — mismo criterio que la
 * barra de kinds (`findings.ts#kindsByVolume`), con desempate alfabético
 * explícito para que la lista de opciones no tiemble entre polls.
 */
export function familiesIn(
  findings: readonly CodeFinding[],
  layer: CodeFindingHypothesisLayer,
): FamilyCount[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    for (const pattern of familiesOf(f, layer)) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pattern, n]) => ({ pattern, findings: n }))
    .sort((a, b) => b.findings - a.findings || a.pattern.localeCompare(b.pattern));
}

/** `null` (el "todas") pasa todo; si no, sólo los hallazgos que proponen esa familia en esa capa. */
export function filterByFamily(
  findings: readonly CodeFinding[],
  family: string | null,
  layer: CodeFindingHypothesisLayer,
): CodeFinding[] {
  if (family === null) return [...findings];
  return findings.filter((f) => familiesOf(f, layer).has(family));
}

/* ─────────────────────────────────────────────────────────────────────────
 * Confianza — HUECO DE CABLEADO, DECLARADO.
 *
 * CONTRATO-F5.md §1.6 fija `conf ∈ {1.0, 0.7, 0.5}` como el multiplicador de
 * confianza del ranking final (evidencia resolved/inferred/grupo-degenerado),
 * un campo nuevo en `CodeFinding` que agrega el agente de agrupación (dueño
 * de `shared/types.ts`) — no tocado acá. Este módulo lee el campo con un
 * cast permisivo, mismo patrón que `graphOf` en `graph-status.ts`: el día
 * que aterrice, el único cambio es reemplazar esta lectura por el tipo real,
 * nada en `CodePanel.vue` se mueve.
 *
 * Mientras el campo no exista en NINGÚN hallazgo del análisis, el filtro se
 * CALLA por completo (`hasConfidenceData` da `false`) en vez de fabricar
 * confianza a partir de la severidad — que sería inventar un número que
 * nadie midió, exactamente lo que esta ola prohíbe.
 */
export type ConfidenceTier = "alta" | "media" | "baja";

export const CONFIDENCE_TIER_ORDER: ConfidenceTier[] = ["alta", "media", "baja"];

export const CONFIDENCE_TIER_LABELS: Record<ConfidenceTier, string> = {
  alta: "Alta",
  media: "Media",
  baja: "Baja",
};

function confOf(finding: CodeFinding): number | undefined {
  return (finding as { conf?: number }).conf;
}

/** `null` cuando este hallazgo no trae `conf` todavía (hoy, siempre). */
export function confidenceTier(finding: CodeFinding): ConfidenceTier | null {
  const conf = confOf(finding);
  if (conf === undefined) return null;
  if (conf >= 0.85) return "alta";
  if (conf >= 0.6) return "media";
  return "baja";
}

/** Si ALGÚN hallazgo trae `conf`, el filtro se muestra; si ninguno lo trae, se oculta entero. */
export function hasConfidenceData(findings: readonly CodeFinding[]): boolean {
  return findings.some((f) => confOf(f) !== undefined);
}

export function filterByConfidence(findings: readonly CodeFinding[], tier: ConfidenceTier | null): CodeFinding[] {
  if (tier === null) return [...findings];
  return findings.filter((f) => confidenceTier(f) === tier);
}
