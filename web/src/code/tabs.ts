/**
 * Lógica pura compartida por las tres pestañas nuevas de F7 (Contrato 3):
 * Arquitectura, Descartados, Ya resuelto. Cada pestaña necesita una lectura
 * distinta del MISMO payload (`CodeAnalysis`), y ninguna inventa un campo que
 * no exista ahí — donde falta un dato se declara la brecha en vez de
 * simularlo (ver `RESOLVED_GAP_*` y `resolutionSummary`/`architectureFolders`
 * más abajo).
 *
 * Todo lo de acá es puro/testeable sin montar Vue.
 */
import type { CodeAnalysis, CodeFinding } from "@/types";
import type {
  CodeFileSummary,
  CodeFindingDiscard,
  CodeFindingHypothesis,
  CodeFindingHypothesisLayer,
  CodeFindingHypothesisState,
  CodeGraphSummary,
  PatternOpportunityPlace,
} from "@shared/types";
import { stateMeta } from "./hypotheses";

/* ────────────────────────────────────────────────────────────────────────
 * 1. Hipótesis "ya medidas" — Arquitectura (ya-aplicado + aplicado-eludido)
 *    y Ya resuelto (sólo ya-aplicado) comparten esta misma forma.
 * ──────────────────────────────────────────────────────────────────────── */

/** Una hipótesis junto con el hallazgo del que cuelga — nunca viaja suelta (ver `CodeFinding.hypotheses`). */
export interface AppliedHypothesis {
  finding: CodeFinding;
  hypothesis: CodeFindingHypothesis;
}

/** Los dos estados "la abstracción ya existe" — los que compiten como oportunidad (`ausente`/`parcial`) no entran acá. */
export const APPLIED_STATES: readonly CodeFindingHypothesisState[] = ["aplicado-eludido", "ya-aplicado"];

/**
 * Todas las hipótesis de `analysis.findings[].hypotheses` cuyo `state` esté
 * en `states`, con el hallazgo ancla pegado. Orden: `aplicado-eludido`
 * primero (es la alarma), después por `pattern` alfabético, después por
 * `anchorFindingId` — desempate estable, nunca el orden de llegada del array.
 */
export function collectAppliedHypotheses(
  analysis: CodeAnalysis,
  states: readonly CodeFindingHypothesisState[] = APPLIED_STATES,
): AppliedHypothesis[] {
  const wanted = new Set(states);
  const out: AppliedHypothesis[] = [];
  for (const finding of analysis.findings) {
    for (const hypothesis of finding.hypotheses ?? []) {
      if (wanted.has(hypothesis.state)) out.push({ finding, hypothesis });
    }
  }
  const rank = (s: CodeFindingHypothesisState): number => (s === "aplicado-eludido" ? 0 : 1);
  return out.sort(
    (a, b) =>
      rank(a.hypothesis.state) - rank(b.hypothesis.state) ||
      a.hypothesis.pattern.localeCompare(b.hypothesis.pattern) ||
      a.hypothesis.anchorFindingId.localeCompare(b.hypothesis.anchorFindingId),
  );
}

/** Un grupo por nombre de patrón, para la lectura "Abstracciones que ya existen". */
export interface PatternGroup {
  pattern: string;
  items: AppliedHypothesis[];
  /** `true` si CUALQUIER item del grupo es `aplicado-eludido` — decide si el grupo va arriba. */
  hasBridged: boolean;
}

/**
 * Agrupa por `pattern`. Los grupos con al menos una `aplicado-eludido` van
 * primero (son la alarma real: "existe y se puentea"); el resto, alfabético.
 * Dentro de cada grupo, `collectAppliedHypotheses` ya dejó los
 * `aplicado-eludido` arriba.
 */
export function groupByPattern(items: readonly AppliedHypothesis[]): PatternGroup[] {
  const byPattern = new Map<string, AppliedHypothesis[]>();
  for (const item of items) {
    const list = byPattern.get(item.hypothesis.pattern);
    if (list) list.push(item);
    else byPattern.set(item.hypothesis.pattern, [item]);
  }
  const groups: PatternGroup[] = [...byPattern.entries()].map(([pattern, groupItems]) => ({
    pattern,
    items: groupItems,
    hasBridged: groupItems.some((i) => i.hypothesis.state === "aplicado-eludido"),
  }));
  return groups.sort(
    (a, b) => Number(b.hasBridged) - Number(a.hasBridged) || a.pattern.localeCompare(b.pattern),
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * 1-bis. La pestaña "Patrones" — OLA BA, FRENTE BA2.
 *
 * MOVIMIENTO PURAMENTE VISUAL. Las propuestas de los 12 patrones de diseño
 * salen de la lista principal (que queda con las 17 familias de
 * refactorización) y se leen acá. NADA MÁS SE MUEVE: ningún contador, ningún
 * estado, ningún descarte y ninguna estadística cambian — un patrón
 * descartado sigue contando exactamente donde contaba. Lo único distinto es
 * DÓNDE SE MUESTRA.
 *
 * POR QUÉ ES UNA LISTA PROPIA Y NO LA MISMA LISTA FILTRADA: el Nivel 2 de
 * `grouping.ts` colapsa `(archivo, kind)` en una tarjeta de grupo, y una
 * tarjeta de grupo NO dibuja hipótesis. Reusar esa lista escondería toda
 * propuesta de patrón anclada en un hallazgo agrupado — justo lo contrario
 * de lo que pide esta pestaña.
 *
 * Y el criterio es `hypothesis.layer`, NUNCA el nombre: ver el bloque CAPA
 * de `hypotheses.ts`.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Todas las hipótesis de una capa, con su hallazgo ancla pegado, en TODOS sus
 * estados (a diferencia de `collectAppliedHypotheses`, que sólo mira los dos
 * estados "ya existe"). Orden: el mismo de `hypotheses.ts#stateMeta`
 * (`aplicado-eludido` primero — es la alarma), después `pattern` alfabético,
 * después `anchorFindingId`; desempate estable, nunca el orden de llegada.
 */
export function collectHypothesesOfLayer(
  findings: readonly CodeFinding[],
  layer: CodeFindingHypothesisLayer,
): AppliedHypothesis[] {
  const out: AppliedHypothesis[] = [];
  for (const finding of findings) {
    for (const hypothesis of finding.hypotheses ?? []) {
      if (hypothesis.layer === layer) out.push({ finding, hypothesis });
    }
  }
  return out.sort(
    (a, b) =>
      stateMeta(a.hypothesis.state).order - stateMeta(b.hypothesis.state).order ||
      a.hypothesis.pattern.localeCompare(b.hypothesis.pattern) ||
      a.hypothesis.anchorFindingId.localeCompare(b.hypothesis.anchorFindingId),
  );
}

/**
 * Dónde apunta una fila de la pestaña: el primer `place` de la hipótesis y,
 * si no hay ninguno, la primera ubicación del hallazgo ancla. `null` cuando
 * no hay ni una cosa ni la otra — se dice, no se inventa un archivo.
 */
export function hypothesisAnchorFile(item: AppliedHypothesis): string | null {
  return item.hypothesis.places[0]?.file ?? item.finding.locations[0]?.file ?? null;
}

/**
 * Las fugas de una `aplicado-eludido`: los `places` cuyo `role` es uno de los
 * dos roles reales que emite `facade.ts` para "quien puentea" —
 * `"cliente que puentea la fachada"` / `"colaborador interno alcanzado
 * directamente, sin pasar por la fachada"`. Ningún otro criterio: un
 * detector de patrón distinto que no declare esos roles simplemente no
 * cuenta fugas acá (0 es honesto, no un bug) — ver CONTRATO-F7.md §1.2.
 */
export function bridgeLeaks(hypothesis: CodeFindingHypothesis): PatternOpportunityPlace[] {
  return hypothesis.places.filter((p) => p.role.includes("puentea") || p.role.includes("directamente"));
}

/* ────────────────────────────────────────────────────────────────────────
 * 2. "Forma del repo" — Arquitectura, bloque 2.
 * ──────────────────────────────────────────────────────────────────────── */

/** Carpeta contenedora de un path repo-relativo; `""` para un archivo en la raíz. */
export function folderOf(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? "" : filePath.slice(0, i);
}

/** Etiqueta de pantalla para `folderOf` — `""` se lee "(raíz)", nunca una fila vacía. */
export function folderLabel(folder: string): string {
  return folder === "" ? "(raíz)" : folder;
}

export interface FolderStat {
  folder: string;
  value: number;
  files: number;
}

/** Top `limit` carpetas por líneas de código, mayor primero. */
export function topFoldersByLines(files: readonly CodeFileSummary[], limit = 5): FolderStat[] {
  const byFolder = new Map<string, { lines: number; files: number }>();
  for (const f of files) {
    const folder = folderOf(f.path);
    const entry = byFolder.get(folder) ?? { lines: 0, files: 0 };
    entry.lines += f.lines;
    entry.files += 1;
    byFolder.set(folder, entry);
  }
  return [...byFolder.entries()]
    .map(([folder, e]) => ({ folder, value: e.lines, files: e.files }))
    .sort((a, b) => b.value - a.value || a.folder.localeCompare(b.folder))
    .slice(0, limit);
}

/**
 * El "impacto" de un hallazgo — MISMA fórmula que el eje `impacto` del mapa
 * (CONTRATO-F7.md §2.5): `(score ?? severity/100) · (memberCount ?? 1)`.
 * Repetida acá (en vez de importada de `hotspot-map.ts`, de Frente C) porque
 * es una expresión de tres campos, no vale una dependencia entre frentes
 * disjuntos por archivo — y este módulo tiene su propio test que la fija.
 */
function findingImpact(f: CodeFinding): number {
  return (f.score ?? f.severity / 100) * (f.memberCount ?? 1);
}

/**
 * Top `limit` carpetas por impacto. Un hallazgo suma su impacto en CADA
 * carpeta que alguna de sus `locations` toca (no sólo la primera): una
 * duplicación entre `a/` y `b/` es un problema de las dos carpetas, no sólo
 * de la que aparece primero en el array. Esto puede sumar el mismo hallazgo
 * en más de una carpeta a propósito — es una lectura de "dónde se siente
 * este problema", no una partición que deba sumar 100%.
 */
export function topFoldersByImpact(files: readonly CodeFileSummary[], findings: readonly CodeFinding[], limit = 5): FolderStat[] {
  const fileToFolder = new Map(files.map((f) => [f.path, folderOf(f.path)]));
  const byFolder = new Map<string, { impact: number; files: Set<string> }>();
  for (const finding of findings) {
    const impact = findingImpact(finding);
    const foldersTouched = new Set(finding.locations.map((l) => fileToFolder.get(l.file) ?? folderOf(l.file)));
    for (const folder of foldersTouched) {
      const entry = byFolder.get(folder) ?? { impact: 0, files: new Set<string>() };
      entry.impact += impact;
      for (const l of finding.locations) if ((fileToFolder.get(l.file) ?? folderOf(l.file)) === folder) entry.files.add(l.file);
      byFolder.set(folder, entry);
    }
  }
  return [...byFolder.entries()]
    .map(([folder, e]) => ({ folder, value: e.impact, files: e.files.size }))
    .sort((a, b) => b.value - a.value || a.folder.localeCompare(b.folder))
    .slice(0, limit);
}

/* ────────────────────────────────────────────────────────────────────────
 * 3. "Cuánto de esto es confiable" — Arquitectura, bloque 3 (`graph.resolution`).
 * ──────────────────────────────────────────────────────────────────────── */

export interface ResolutionSummary {
  candidates: number;
  resolved: number;
  droppedAmbiguous: number;
  unresolved: number;
  pctResolved: number;
  pctAmbiguous: number;
  pctUnresolved: number;
  /** La frase exacta pedida por CONTRATO-F7.md §3.1, con los números reales de esta corrida. */
  sentence: string;
}

const fmtInt = (n: number): string => n.toLocaleString("es-AR");

/** `null` cuando no hay grafo o no hay candidatos que resolver — nunca un 0% fabricado. */
export function resolutionSummary(graph: CodeGraphSummary | undefined): ResolutionSummary | null {
  if (!graph || graph.resolution.candidates <= 0) return null;
  const { candidates, resolved, droppedAmbiguous, unresolved } = graph.resolution;
  const pct = (n: number): number => Math.round((n / candidates) * 100);
  const pctResolved = pct(resolved);
  const pctAmbiguous = pct(droppedAmbiguous);
  const pctUnresolved = pct(unresolved);
  const sentence =
    `De ${fmtInt(candidates)} referencias candidatas se resolvieron ${fmtInt(resolved)} (${pctResolved}%); ` +
    `${fmtInt(droppedAmbiguous)} quedaron ambiguas y ${fmtInt(unresolved)} sin destino. ` +
    `Todo lo de arriba se lee con ese margen.`;
  return { candidates, resolved, droppedAmbiguous, unresolved, pctResolved, pctAmbiguous, pctUnresolved, sentence };
}

/* ────────────────────────────────────────────────────────────────────────
 * 4. Descartados.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * F-RETIRO-VÍA-VIEJA: era `"finding" | "opportunity"` — `analyzeRepo` ya no
 * produce `CodeAnalysis.opportunities` (vía vieja retirada entera, decisión
 * del usuario), así que nunca vuelve a existir un item descartado de tipo
 * `"opportunity"`. Queda como unión de UN solo miembro (no un alias plano) a
 * propósito: `DiscardedItem.itemKind` sigue siendo un campo discriminante
 * explícito, no un string suelto — el día que otra clase de item descartable
 * aparezca, se agrega acá sin tocar la forma de los consumidores existentes.
 */
export type DiscardedKind = "finding";

export interface DiscardedItem {
  itemKind: DiscardedKind;
  id: string;
  /** Título en pantalla: `finding.title`. */
  title: string;
  /** `finding.kind` (etiqueta cruda), para el chip. */
  tag: string;
  discarded: CodeFindingDiscard;
  file: string | null;
}

/** `findings` descartados (`discarded != null`), lo más reciente primero. El resto de las vistas ya los excluye — acá es donde se ven. */
export function discardedItems(analysis: CodeAnalysis): DiscardedItem[] {
  const out: DiscardedItem[] = [];
  for (const f of analysis.findings) {
    if (f.discarded && f.id) {
      out.push({
        itemKind: "finding",
        id: f.id,
        title: f.title,
        tag: f.kind,
        discarded: f.discarded,
        file: f.locations[0]?.file ?? null,
      });
    }
  }
  return out.sort((a, b) => b.discarded.decidedAt.localeCompare(a.discarded.decidedAt));
}

/* ────────────────────────────────────────────────────────────────────────
 * 5. Ya resuelto — brecha declarada (CONTRATO-F7.md §3.3).
 * ──────────────────────────────────────────────────────────────────────── */

/** Cartel permanente, sin eufemismo: no hay historia entre corridas. */
export const RESOLVED_NO_HISTORY_NOTICE =
  "Esta pestaña no puede mostrar qué se arregló entre dos corridas: el sistema no guarda análisis anteriores. Muestra sólo lo que el motor verifica como ya resuelto HOY.";

/** La forma EXACTA de lo que haría falta persistir por repo, por corrida, para poder diferenciar contra la anterior. */
export const RESOLVED_GAP_SHAPE = "{ analysedAt: string; findingIds: string[] }";

export const RESOLVED_GAP_NOTE =
  `Brecha declarada: no existe una tabla de análisis anteriores — ` +
  `\`code_graphs\` cachea por firma de árbol y \`code-decisions\` guarda descartes, no snapshots. ` +
  `Cerrarla pide persistir por repo un ${RESOLVED_GAP_SHAPE} por corrida y diferenciar contra la ` +
  `anterior (\`CodeFinding.id\` ya es estable y no depende de números de línea — la pieza difícil ya existe).`;

/** Únicamente `ya-aplicado`: "ya resuelto" MEDIDO, no recordado — `aplicado-eludido` no cuenta (todavía se puentea). */
export function collectResolvedHypotheses(analysis: CodeAnalysis): AppliedHypothesis[] {
  return collectAppliedHypotheses(analysis, ["ya-aplicado"]);
}

