/**
 * Pure helpers for `CodeFindingHypothesis` — F7, CONTRATO-F7.md Contrato 1.
 *
 * The engine (`server/services/hypotheses/*`) already computes everything a
 * card needs — state, confidence, ceiling, the two check lists, the places
 * with their roles. This module does no computation of its own beyond what
 * the contract asks for: which sello/icon/order a `state` gets, how to split
 * `checks` from `discriminators` (they already arrive split — this is just a
 * named seam so the component doesn't reach into the raw shape by hand), and
 * which `places` are the "leaks" that make `aplicado-eludido` different from
 * `ausente`.
 *
 * Kept separate from `FindingCard.vue`/`HypothesisBlock.vue` (mirrors
 * `findings.ts`/`grouping.ts` for the rest of the panel) so the state→sello
 * mapping and the sort order are testable without mounting Vue.
 */
import type {
  CodeFindingHypothesis,
  CodeFindingHypothesisCheck,
  CodeFindingHypothesisLayer,
  CodeFindingHypothesisState,
  PatternConfidence,
  PatternOpportunityPlace,
} from "@shared/types";

/* ────────────────────────────────────────────────────────────────────────
 * CAPA — OLA BA, FRENTE BA2.
 *
 * `CodeFindingHypothesis.layer` es OBLIGATORIO y lo estampa el servidor en un
 * solo lugar (`hypotheses/run.ts#conCapa`, ver el informe BA1). Es el ÚNICO
 * criterio para separar las dos poblaciones en el panel: los 12 patrones de
 * diseño de las 17 familias de refactorización.
 *
 * NUNCA derivar la capa del nombre del patrón. Hay un caso medido detrás: el
 * catálogo publica `"Proxy (inicialización perezosa)"` y `"Extract Class
 * (campos temporales)"`, así que un `pattern === "Proxy"` escrito a mano ya
 * nace roto — un censo anterior perdió 137 propuestas exactamente así, y no
 * avisó. Por eso este módulo no tiene ninguna lista de nombres: sólo lee el
 * campo.
 * ──────────────────────────────────────────────────────────────────────── */

/** Etiqueta de pantalla de cada capa — la única forma humana del campo. */
export const LAYER_LABELS: Record<CodeFindingHypothesisLayer, string> = {
  patron: "Patrón de diseño",
  refactorizacion: "Refactorización",
};

/**
 * Las hipótesis de UNA capa. Sin `??` ni default: `layer` es obligatorio en
 * el tipo y en los hechos (BA1 subió `FACTS_SCHEMA_VERSION` justamente para
 * que ningún análisis cacheado traiga una sin capa), así que un fallback acá
 * taparía un bug del servidor en vez de cubrir un caso real.
 */
export function ofLayer(
  hypotheses: readonly CodeFindingHypothesis[],
  layer: CodeFindingHypothesisLayer,
): CodeFindingHypothesis[] {
  return hypotheses.filter((h) => h.layer === layer);
}

/* ────────────────────────────────────────────────────────────────────────
 * LO QUE TODAVÍA ES UNA RECOMENDACIÓN — OLA BB, FRENTE BB2.
 *
 * La lista principal muestra sólo las hipótesis ABIERTAS: las que todavía
 * proponen algo (`ausente`, `parcial`). Las dos que dicen "la abstracción ya
 * existe" (`ya-aplicado`, `aplicado-eludido`) se leen en Arquitectura, donde
 * ya vivían — pedido textual del usuario: *"Sácalos de la lista, que queden
 * solo en Arquitectura. Lo de los ya aplicados ensucia un poco la lectura"*.
 *
 * ES UN RECORTE DE PANTALLA, IGUAL QUE `ofLayer`. No toca
 * `finding.hypotheses`, ni un contador, ni un estado, ni un descarte: sólo
 * decide qué se DIBUJA dentro de la tarjeta. En particular
 * `aplicado-eludido` NO pasa a contar como resuelto en ningún lado — sigue
 * siendo la alarma que es (`tabs.test.ts`: "todavía se puentea"), y su lugar
 * sigue siendo Arquitectura y la pestaña de Patrones.
 *
 * ESCRITO EN NEGATIVO A PROPÓSITO. Es el complemento exacto de
 * `tabs.ts#APPLIED_STATES`, pero preguntando "¿NO es de los dos aplicados?"
 * en vez de "¿es de los dos abiertos?": si mañana aparece un quinto estado,
 * cae del lado VISIBLE (aparece en la lista) en vez de desaparecer de las dos
 * vistas sin que nadie se entere — que es exactamente el modo de falla que la
 * verificación de la Ola BA encontró con `layer`.
 * ──────────────────────────────────────────────────────────────────────── */

/** `true` si la hipótesis todavía propone algo — o sea: no es ninguno de los dos estados "la abstracción ya existe". */
export function isOpenProposal(hypothesis: CodeFindingHypothesis): boolean {
  return hypothesis.state !== "ya-aplicado" && hypothesis.state !== "aplicado-eludido";
}

/** Las hipótesis que todavía son una recomendación. Recorte de pantalla: ver el bloque de arriba. */
export function openProposals(
  hypotheses: readonly CodeFindingHypothesis[],
): CodeFindingHypothesis[] {
  return hypotheses.filter(isOpenProposal);
}

/**
 * Spanish labels for `PatternConfidence` — the confidence values themselves
 * are already Spanish words used as code, this is just the display form.
 * F-RETIRO-VÍA-VIEJA: vivía en `opportunities.ts` (retirado junto con la vía
 * vieja); movido acá porque `PatternConfidence` sigue siendo del sistema de
 * hipótesis nuevo (`CodeFindingHypothesis.confidence`/`.ceiling`), no algo
 * exclusivo de la vía vieja.
 */
export const CONFIDENCE_LABELS: Record<PatternConfidence, string> = {
  alta: "Alta",
  media: "Media",
  baja: "Baja",
};

/**
 * `file:line (role)` for one `PatternOpportunityPlace` — same shape as
 * `findings.ts`'s `formatLocation`, with the role appended instead of an
 * enclosing symbol, since a place's role IS what a reader needs next to its
 * location. F-RETIRO-VÍA-VIEJA: movido de `opportunities.ts` — `places` con
 * rol siguen siendo la forma real de `CodeFindingHypothesis.places`.
 */
export function formatPlace(place: PatternOpportunityPlace): string {
  const range = place.endLine > place.startLine ? `${place.startLine}-${place.endLine}` : `${place.startLine}`;
  return `${place.file}:${range} — ${place.role}`;
}

/** Everything a sello needs to render, keyed by `state` — CONTRATO-F7.md §1.2. */
export interface HypothesisStateMeta {
  readonly state: CodeFindingHypothesisState;
  /** Texto exacto del sello. */
  readonly label: string;
  readonly icon: string;
  /** Clase de color, consumida por `HypothesisBlock.vue` (`hb--${className}`). */
  readonly className: "bridged" | "partial" | "absent" | "applied";
  /** Orden de aparición cuando un hallazgo tiene más de una hipótesis: 1 = primero. */
  readonly order: number;
  /** Colapsado por defecto salvo `aplicado-eludido`. */
  readonly defaultOpen: boolean;
}

const STATE_META: Record<CodeFindingHypothesisState, HypothesisStateMeta> = {
  "aplicado-eludido": {
    state: "aplicado-eludido",
    label: "PATRÓN PUENTEADO",
    icon: "⚡",
    className: "bridged",
    order: 1,
    defaultOpen: true,
  },
  parcial: {
    state: "parcial",
    label: "Parcial",
    icon: "◐",
    className: "partial",
    order: 2,
    defaultOpen: false,
  },
  ausente: {
    state: "ausente",
    label: "Falta el patrón",
    icon: "○",
    className: "absent",
    order: 3,
    defaultOpen: false,
  },
  "ya-aplicado": {
    state: "ya-aplicado",
    label: "Ya aplicado",
    icon: "✓",
    className: "applied",
    order: 4,
    defaultOpen: false,
  },
};

export function stateMeta(state: CodeFindingHypothesisState): HypothesisStateMeta {
  return STATE_META[state];
}

/**
 * `missingCapabilities` no vacío ⇒ "no aplicable en este lenguaje" — NUNCA
 * uno de los cuatro estados, y `confidence` no se muestra (es `null` por
 * contrato). Ver CONTRATO-F7.md §1.2.
 */
export function isNotApplicable(hypothesis: CodeFindingHypothesis): boolean {
  return hypothesis.missingCapabilities.length > 0;
}

/**
 * Dos listas separadas — CONTRATO-F7.md §1.4. `checks` ya trae sólo los
 * roles `required`/`applied` (el excluder fusionado que decide `state`);
 * `discriminators` es su propio campo. Named seam, no transformación: el
 * servidor ya entrega la forma exacta que la UI necesita.
 */
export function splitChecks(hypothesis: CodeFindingHypothesis): {
  requirements: readonly CodeFindingHypothesisCheck[];
  discriminators: readonly CodeFindingHypothesisCheck[];
} {
  return { requirements: hypothesis.checks, discriminators: hypothesis.discriminators };
}

/** `true` si al menos un discriminador confirmado subió un peldaño — si no, el bloque muestra "Nada subió la confianza por encima del piso". */
export function anyDiscriminatorConfirmed(hypothesis: CodeFindingHypothesis): boolean {
  return hypothesis.discriminators.some((d) => d.passed);
}

/** `confidence === ceiling` ⇒ el chip explica el techo ("— tope: {ceiling}"). */
export function atConfidenceCeiling(hypothesis: CodeFindingHypothesis): boolean {
  return hypothesis.confidence !== null && hypothesis.confidence === hypothesis.ceiling;
}

/**
 * Los roles reales que emite `facade.ts` para una fuga: "cliente que puentea
 * la fachada" y "colaborador interno alcanzado directamente, sin pasar por
 * la fachada" — la única fuente para "dónde se puentea" (CONTRATO-F7.md
 * §1.2). Ninguna otra hipótesis emite estos roles hoy; el filtro por texto
 * es a propósito genérico (`"puentea"` / `"directamente"`) para no atarse al
 * string exacto de un solo detector si otra hipótesis futura reusa la idea.
 */
const BRIDGE_ROLE_HINTS = ["puentea", "directamente"];

export function bridgePlaces(hypothesis: CodeFindingHypothesis): CodeFindingHypothesis["places"] {
  return hypothesis.places.filter((place) => BRIDGE_ROLE_HINTS.some((hint) => place.role.includes(hint)));
}

/**
 * Orden de una tarjeta con más de una hipótesis: `aplicado-eludido` primero
 * siempre (es la que exige acción inmediata — hay código puenteando una
 * abstracción que ya existe), después el orden de §1.2, y las "no
 * aplicable" al final (son la que menos aportan: ni estado ni evidencia).
 * Desempate explícito por índice original, mismo criterio que
 * `rankFindings`/`rankGrouped` — nunca depender de que `Array.sort` sea
 * estable.
 */
export function sortHypotheses(
  hypotheses: readonly CodeFindingHypothesis[],
): CodeFindingHypothesis[] {
  return hypotheses
    .map((hypothesis, index) => ({ hypothesis, index }))
    .sort((a, b) => {
      const naA = isNotApplicable(a.hypothesis);
      const naB = isNotApplicable(b.hypothesis);
      if (naA !== naB) return naA ? 1 : -1;
      if (naA && naB) return a.index - b.index;
      return stateMeta(a.hypothesis.state).order - stateMeta(b.hypothesis.state).order || a.index - b.index;
    })
    .map(({ hypothesis }) => hypothesis);
}
