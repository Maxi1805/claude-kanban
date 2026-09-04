/**
 * "Qué no estamos viendo" — F5, punto 3 de la tarea.
 *
 * `CodeAnalysis.coverage` (`CodeDetectorCoverage[]`) ya existe en el contrato
 * (F4, `shared/types.ts`): una fila por `(detectorId, language)` con su
 * `status`. Lo que faltaba era la pantalla. La regla que este módulo hace
 * cumplir es la que pide la tarea explícitamente: un detector "no aplicable"
 * en un lenguaje (le falta una capacidad del lenguaje — un `needs` que ese
 * lenguaje nunca puede cumplir) tiene que VERSE distinto de un detector que
 * corrió y no encontró nada (buena noticia, no un hueco). Son dos historias
 * distintas y las mezcla el mismo `findings === 0` si no se separan por
 * `status` primero.
 *
 * `sin-aristas`/`sin-metricas` (DIAGNÓSTICO-5B §5, Problema 3): mismo
 * principio, para detectores `inter-file` que dependen de una arista tipada
 * o de una métrica de grafo que esta corrida no tiene — hasta ahora
 * indistinguibles de "corrió y no encontró nada". Se agrupan en el balde
 * `bloqueado` junto a `sin-grafo`/`presupuesto-agotado` (ver `bucketOf`):
 * para quien lee la pantalla las cuatro dicen lo mismo ("el análisis no
 * llegó a intentarlo"), aunque la razón técnica difiera.
 */
import type { CodeCoverageStatus, CodeDetectorCoverage, CodeDetectorScope, CodeFindingKind } from "@shared/types";

/** Etiqueta humana del status crudo — para chips y para el detalle expandido. */
export const STATUS_LABELS: Record<CodeCoverageStatus, string> = {
  corrio: "Corrió",
  "no-aplicable": "No aplica en este lenguaje",
  "sin-grafo": "Sin grafo de código",
  "sin-aristas": "Sin aristas de grafo para este detector",
  "sin-metricas": "Sin métricas de grafo para este detector",
  "presupuesto-agotado": "Presupuesto de análisis agotado",
  error: "Falló al analizar",
};

export const SCOPE_LABELS: Record<CodeDetectorScope, string> = {
  "intra-function": "Dentro de una función",
  "intra-file": "Dentro de un archivo",
  "inter-file": "Entre archivos",
};

/**
 * Cinco baldes, no siete `status`: `corrio` se parte en dos historias que un
 * usuario lee de forma opuesta. `sin-grafo`/`sin-aristas`/`sin-metricas`/
 * `presupuesto-agotado` se agrupan en `bloqueado` porque para el usuario las
 * cuatro dicen lo mismo ("el análisis no llegó a intentarlo"), aunque la
 * razón técnica difiera.
 */
export type CoverageBucket = "con-hallazgos" | "sin-hallazgos" | "no-aplicable" | "bloqueado" | "error";

export const BUCKET_LABELS: Record<CoverageBucket, string> = {
  "con-hallazgos": "Con hallazgos",
  "sin-hallazgos": "Corrió, sin hallazgos",
  "no-aplicable": "No aplica en este lenguaje",
  bloqueado: "Bloqueado (sin grafo, sin aristas, sin métricas o presupuesto agotado)",
  error: "Falló al analizar",
};

export function bucketOf(row: Pick<CodeDetectorCoverage, "status" | "findings">): CoverageBucket {
  if (row.status === "corrio") return row.findings > 0 ? "con-hallazgos" : "sin-hallazgos";
  if (row.status === "no-aplicable") return "no-aplicable";
  if (row.status === "error") return "error";
  return "bloqueado"; // sin-grafo | sin-aristas | sin-metricas | presupuesto-agotado
}

/** Un detector, con sus filas de cobertura agrupadas (una por lenguaje para intra-*, una sola para inter-file). */
export interface DetectorCoverageGroup {
  readonly detectorId: string;
  readonly title: string;
  readonly kind: CodeFindingKind;
  readonly scope: CodeDetectorScope;
  readonly totalFindings: number;
  readonly rows: readonly CodeDetectorCoverage[];
}

/** Agrupa por `detectorId`, orden alfabético por título — estable entre recargas. */
/** Misma forma que `DetectorCoverageGroup`, sin `readonly`: la construcción de abajo necesita escribir `totalFindings`/`rows` mientras agrupa; el tipo exportado (de sólo lectura) es el que ve quien lo consume. */
interface MutableDetectorCoverageGroup {
  detectorId: string;
  title: string;
  kind: CodeFindingKind;
  scope: CodeDetectorScope;
  totalFindings: number;
  rows: CodeDetectorCoverage[];
}

export function groupCoverageByDetector(
  coverage: readonly CodeDetectorCoverage[],
): DetectorCoverageGroup[] {
  const byId = new Map<string, MutableDetectorCoverageGroup>();
  for (const row of coverage) {
    let group = byId.get(row.detectorId);
    if (!group) {
      group = {
        detectorId: row.detectorId,
        title: row.title,
        kind: row.kind,
        scope: row.scope,
        totalFindings: 0,
        rows: [],
      };
      byId.set(row.detectorId, group);
    }
    group.rows.push(row);
    group.totalFindings += row.findings;
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title, "es"));
}

/** Conteo agregado por balde, para el titular de la pantalla. */
export interface BlindSpotSummary {
  readonly conHallazgos: number;
  readonly sinHallazgos: number;
  readonly noAplicable: number;
  readonly bloqueado: number;
  readonly error: number;
  readonly total: number;
}

export function blindSpotSummary(coverage: readonly CodeDetectorCoverage[]): BlindSpotSummary {
  const summary = { conHallazgos: 0, sinHallazgos: 0, noAplicable: 0, bloqueado: 0, error: 0 };
  for (const row of coverage) {
    const bucket = bucketOf(row);
    if (bucket === "con-hallazgos") summary.conHallazgos += 1;
    else if (bucket === "sin-hallazgos") summary.sinHallazgos += 1;
    else if (bucket === "no-aplicable") summary.noAplicable += 1;
    else if (bucket === "bloqueado") summary.bloqueado += 1;
    else summary.error += 1;
  }
  return { ...summary, total: coverage.length };
}

/**
 * La frase de titular: *"22 detectores × lenguaje: 14 con hallazgos, 5
 * corrieron sin encontrar nada, 2 no aplican en su lenguaje, 1 bloqueado"* —
 * el "no aplican" nunca se calla ni se confunde con un cero.
 */
export function blindSpotLine(summary: BlindSpotSummary): string {
  if (summary.total === 0) return "Sin datos de cobertura en este análisis.";
  const parts = [`${summary.conHallazgos} con hallazgos`, `${summary.sinHallazgos} corrieron sin encontrar nada`];
  if (summary.noAplicable > 0) parts.push(`${summary.noAplicable} no aplican en su lenguaje`);
  if (summary.bloqueado > 0) parts.push(`${summary.bloqueado} bloqueados (sin grafo, sin aristas, sin métricas o presupuesto agotado)`);
  if (summary.error > 0) parts.push(`${summary.error} fallaron`);
  return `${summary.total} combinaciones detector × lenguaje: ${parts.join(", ")}.`;
}

/** Texto de por qué no corrió, cuando el status es `no-aplicable` — nunca vacío en ese caso, por contrato. */
export function missingCapabilitiesText(row: CodeDetectorCoverage): string | null {
  if (!row.missingCapabilities || row.missingCapabilities.length === 0) return null;
  return `falta: ${row.missingCapabilities.join(", ")}`;
}

/**
 * CONTRATO-F6.md Contrato 2 §2.5 — cuántos archivos de cada lenguaje vio el
 * corpus EXTERNO que valida los detectores (medido en esta tarea sobre
 * `revision2/corpus`, 8 repos, `find` excluyendo `node_modules`/`.git`). NO
 * es el tamaño del repo que el usuario está analizando ahora — es la
 * confianza que el PRODUCTO tiene en ese lenguaje en general. Java tiene acá
 * 170 veces más archivos que tsx: "funciona genéricamente" hoy se apoya casi
 * enteramente en java (ver el informe de `language-coverage.test.ts` para el
 * número exacto de dependencia).
 */
export const CORPUS_SAMPLE_FILES: Readonly<Record<string, number>> = {
  java: 3229,
  csharp: 945,
  typescript: 698,
  vue: 213,
  ruby: 161,
  javascript: 159,
  python: 78,
  go: 36,
  tsx: 19,
};

/**
 * `[provisional]` — mismo piso que `detect/language-coverage.ts
 * #MEASUREMENT_FLOOR_FILES` (server-only, no importable desde el frontend):
 * duplicado a propósito, no un archivo compartido nuevo. Ver CONTRATO-F6.md
 * §2.5: no re-derivado por remuestreo en esta tarea.
 */
export const MEASUREMENT_FLOOR_FILES = 150;

/**
 * `null` cuando el lenguaje no es uno de los 9 medidos, o cuando su muestra
 * ya supera el piso — la lectura honesta pedida por la tarea: un lenguaje
 * bajo el piso no se pinta verde ni rojo, se marca "no lo sabemos todavía".
 */
export function sampleConfidenceNote(language: string): string | null {
  const sampleSize = CORPUS_SAMPLE_FILES[language];
  if (sampleSize === undefined || sampleSize >= MEASUREMENT_FLOOR_FILES) return null;
  return (
    `Muestra insuficiente en el corpus de validación: sólo ${sampleSize} archivo` +
    `${sampleSize === 1 ? "" : "s"} de ${language}. Sobre este lenguaje el sistema no puede ` +
    "afirmar cobertura todavía — ni verde ni rojo, desconocido."
  );
}

/**
 * Mapa `kind -> scope`, derivado de la cobertura — es la única fuente real de
 * granularidad por hallazgo hoy: `CodeFinding` no lleva su propio `scope`,
 * pero cada `kind` lo emite siempre el mismo detector, y el detector sí trae
 * `scope` en su fila de cobertura. Se usa para el filtro de granularidad
 * (`filters.ts`) sin inventar nada nuevo.
 */
export function scopeByKind(coverage: readonly CodeDetectorCoverage[]): Map<CodeFindingKind, CodeDetectorScope> {
  const map = new Map<CodeFindingKind, CodeDetectorScope>();
  for (const row of coverage) if (!map.has(row.kind)) map.set(row.kind, row.scope);
  return map;
}
