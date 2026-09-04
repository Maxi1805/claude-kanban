<script setup lang="ts">
/**
 * Per-task code hotspots.
 *
 * Ranked list (no graph, by design) of the refactoring problems tree-sitter
 * found in the task's worktrees, each mapped to the pattern that addresses it
 * — same pipeline shape as the schema view (extract → derive → render), but
 * the extractor here is deterministic (tree-sitter) rather than an
 * agent-written script, so there is nothing to generate: a repo just has an
 * analysis, or is still getting its first one.
 *
 * The server runs (and re-runs) the analysis on request; `repo.analyzing`
 * says whether one is currently in flight for that repo. Polling adapts to
 * that: fast while something is analyzing so the view catches the result
 * promptly, spaced out once everything is settled so an open tab costs
 * nothing. As with the schema panel, a poll that returns byte-identical JSON
 * never touches `response`, so the list does not blink on every tick.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "@/api/client";
import type { CodeFindingKind, TaskCodeRepo, TaskCodeResponse } from "@/types";
import {
  filterFindings,
  findingKey,
  formatLocation,
  kindLabel,
  kindsByVolume,
  orderedKinds,
  severityTier,
} from "./findings";
import HotspotMap from "./HotspotMap.vue";
import FindingCard from "./FindingCard.vue";
import ArchitectureTab from "./ArchitectureTab.vue";
import DiscardedTab from "./DiscardedTab.vue";
import PatternsTab from "./PatternsTab.vue";
import ResolvedTab from "./ResolvedTab.vue";
import { buildTree, type MapNode } from "./hotspot-map";
import { graphHeaderLine, graphOf, languageCoverageNote, languageCoverageRows } from "./graph-status";
import {
  blindSpotLine,
  blindSpotSummary,
  BUCKET_LABELS,
  bucketOf,
  type DetectorCoverageGroup,
  groupCoverageByDetector,
  missingCapabilitiesText,
  SCOPE_LABELS,
  scopeByKind,
} from "./coverage";
import {
  CONFIDENCE_TIER_LABELS,
  CONFIDENCE_TIER_ORDER,
  type ConfidenceTier,
  type FamilyCount,
  familiesIn,
  filterByConfidence,
  filterByFamily,
  filterByGranularity,
  filterByLanguage,
  GRANULARITY_LABELS,
  GRANULARITY_ORDER,
  hasConfidenceData,
  languageMap,
  languagesIn,
} from "./filters";
import {
  honestyLine,
  kindTotals,
  type RankedItem,
  rankGrouped,
  totalMembers,
  uniqueItemKeys,
  volumeOf,
} from "./grouping";
import type { CodeDetectorScope } from "@shared/types";

const props = defineProps<{ taskId: string; active: boolean }>();

/**
 * OLA BA, FRENTE BA2 — la capa que dibuja la LISTA principal. Las propuestas
 * de patrón de diseño se leen en su pestaña (`PatternsTab.vue`); acá quedan
 * las familias de refactorización. Una sola constante para que el filtro por
 * familia, sus cuentas y la tarjeta no puedan discrepar sobre cuál capa es.
 */
const LIST_LAYER = "refactorizacion" as const;

/** Poll cadence: tight while a repo is still being analyzed, spaced once settled. */
const POLL_ANALYZING_MS = 5000;
const POLL_IDLE_MS = 20000;

/**
 * Map or list. The list answers "what is worst"; the map answers "where is
 * it", which a ranked list of 200 rows cannot. Both share the same FINDINGS
 * (hotspots — measured problems); pattern hypotheses hang OFF a finding
 * (`finding.hypotheses`, `HypothesisBlock.vue`) rather than living in a
 * separate view — F-RETIRO-VÍA-VIEJA retired the standalone "Oportunidades"
 * view that used to show the legacy `analysis.opportunities` ranking (vía
 * vieja de detección por vocabulario/forma, retirada entera: `analyzeRepo`
 * ya no produce ese campo).
 *
 * "cobertura" — F5, punto 3: "Qué no estamos viendo". Un cuarto modo, no una
 * pestaña aparte del resto: usa el mismo selector de repo/toolbar, y su dato
 * (`analysis.coverage`) ya viaja en el mismo payload que todo lo demás.
 *
 * F7 (P1) — "architecture"/"discarded"/"resolved": las tres pestañas nuevas
 * de CONTRATO-F7.md §3 (Frente D), ya construidas y probadas (16/16 en
 * `tabs.test.ts`) pero antes INALCANZABLES desde acá — ver el comentario
 * junto a los botones de "Modo de vista" más abajo.
 *
 * OLA BA, FRENTE BA2 — "patterns": las propuestas de los PATRONES DE DISEÑO,
 * que hasta hoy se leían mezcladas dentro de las tarjetas de la lista. Salen
 * de ahí y se leen en su propia pestaña; Mapa y Lista quedan con las
 * familias de REFACTORIZACIÓN. Es un movimiento SÓLO VISUAL: ningún
 * contador, estado, descarte ni estadística cambia — sólo dónde se muestra
 * cada cosa. El criterio es `hypothesis.layer` (`hypotheses.ts`, bloque
 * CAPA), nunca el nombre del patrón.
 */
const view = ref<"map" | "list" | "patterns" | "coverage" | "architecture" | "discarded" | "resolved">("map");
/** File picked on the map; its findings replace the full list beside it. */
const selectedFile = ref<MapNode | null>(null);

const response = ref<TaskCodeResponse | null>(null);
const selectedRepo = ref<string | null>(null);
const kindFilter = ref<CodeFindingKind | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const lastUpdated = ref<string | null>(null);

/* ── F5: navegación del volumen ──────────────────────────────────────────
 * Tres filtros ortogonales al `kindFilter` que ya existía, todos "todos" por
 * defecto (`null`). Granularidad y lenguaje se resuelven con datos reales de
 * hoy (`coverage`, `files` — ver `filters.ts`); confianza se oculta entera
 * mientras ningún hallazgo traiga `conf` (hueco de cableado, ver filters.ts). */
const granularityFilter = ref<CodeDetectorScope | null>(null);
const languageFilter = ref<string | null>(null);
const findingConfidenceFilter = ref<ConfidenceTier | null>(null);
/* ── OLA BB, FRENTE BB2: la familia PROPUESTA ────────────────────────────
 * *"tener una lista infinita es medio complicado para ver un patrón
 * específico"*. Éste es el eje que faltaba: `kind` filtra por el PROBLEMA
 * medido, esto filtra por la SOLUCIÓN propuesta (`hypothesis.pattern`). Ver
 * el bloque FAMILIA PROPUESTA de `filters.ts`. `null` = todas: la lista
 * sigue entera por defecto — esto NO es paginar. */
const familyFilter = ref<string | null>(null);
/** Grupos (por `file+kind`) que el usuario expandió para ver todos sus miembros. */
const expandedGroups = ref<Set<string>>(new Set());

/* ── F2: descartes ─────────────────────────────────────────────────────
 * Persisten por repositorio (no por tarea): al confirmar/restaurar se
 * fuerza un `load()` para traer el estado real desde el servidor en vez de
 * suponer cómo quedó localmente. */
const showDiscarded = ref(false);
const discardingId = ref<string | null>(null);
const discardReason = ref("");
const discardBusy = ref(false);
const discardError = ref<string | null>(null);

let pollTimer: number | null = null;
/** Serialized last payload, to skip redundant renders/reflows. */
let lastPayload = "";

const allRepos = computed(() => response.value?.repos ?? []);

const repo = computed<TaskCodeRepo | null>(() => {
  const repos = allRepos.value;
  return repos.find((r) => r.repoName === selectedRepo.value) ?? repos[0] ?? null;
});

const analysis = computed(() => repo.value?.analysis ?? null);

/** Any repo still being (re)analyzed — drives the poll cadence, not just the selected one. */
const isAnalyzing = computed(() => allRepos.value.some((r) => r.analyzing === true));

/**
 * `CodeFindingKind` es una unión ABIERTA: el kind lo aporta el detector que lo
 * emite, así que este panel no puede tener una lista fija de kinds ni un
 * diccionario de etiquetas completo. El catálogo viaja en el payload
 * (`analysis.kinds`, derivado del registro de detectores) y, cuando falta —
 * análisis cacheado de antes del campo —, `orderedKinds`/`kindLabel` caen a
 * los kinds legados y, por último, al slug humanizado. Nada acá explota con un
 * kind desconocido.
 */
const kindCatalog = computed(() => analysis.value?.kinds ?? undefined);

/**
 * F5, punto 1 — la barra por kind con el número honesto: usa
 * `analysis.totalByKind` (pre-cap, pre-agrupación) cuando el análisis lo
 * trae; si no, cuenta lo mostrado y lo marca `isPartial` (ver `grouping.ts`).
 */
const kindTotalsInfo = computed(() =>
  analysis.value ? kindTotals(analysis.value.findings, volumeOf(analysis.value), kindCatalog.value) : null,
);

/**
 * Kinds a ofrecer en el filtro y en la fila de totales.
 *
 * OLA BB, FRENTE BB2 — ORDENADOS POR CANTIDAD, de mayor a menor (pedido
 * textual del usuario). `orderedKinds` sigue siendo quien decide QUÉ kinds
 * existen —incluidos los que hoy tienen cero hallazgos, que se siguen
 * mostrando: que un detector corriera y no encontrara nada es un dato— y
 * `kindsByVolume` sólo reordena esa lista con las cuentas que la barra ya
 * muestra. El desempate es por posición de catálogo, así que la barra no
 * tiembla entre polls.
 */
const kindCatalogOrder = computed(() => orderedKinds(analysis.value?.findings ?? [], kindCatalog.value));
const shownKinds = computed(() =>
  kindsByVolume(kindCatalogOrder.value, kindTotalsInfo.value?.counts ?? {}),
);

/** Etiqueta de un kind, ya resuelta contra el catálogo de este análisis. */
function labelFor(kind: CodeFindingKind): string {
  return kindLabel(kind, kindCatalog.value);
}

/* ── F5: mapas de apoyo para los filtros de navegación ──────────────────── */

/** `kind -> scope`, derivado de `analysis.coverage` — real hoy, ver `coverage.ts`. */
const scopeMap = computed(() => scopeByKind(analysis.value?.coverage ?? []));
/** `path -> language`, derivado de `analysis.files` — real hoy, ver `filters.ts`. */
const langMap = computed(() => languageMap(analysis.value?.files ?? []));
/** Lenguajes con al menos un hallazgo, para poblar el `<select>`. */
const languagesAvailable = computed(() => languagesIn(analysis.value?.findings ?? [], langMap.value));
/** El filtro de confianza se muestra sólo si ALGÚN hallazgo trae `conf` — hoy, nunca (hueco declarado, `filters.ts`). */
const confidenceAvailable = computed(() => hasConfidenceData(analysis.value?.findings ?? []));

/**
 * Los hallazgos que pasan LOS CUATRO filtros (kind, granularidad, lenguaje,
 * confianza) antes de rankear/agrupar. Cada filtro con valor `null` no
 * recorta nada — es el estado "todos" de cada uno.
 */
const filteredFindings = computed(() => {
  if (!analysis.value) return [];
  let list = filterFindings(analysis.value.findings, kindFilter.value);
  list = filterByGranularity(list, granularityFilter.value, scopeMap.value);
  list = filterByLanguage(list, languageFilter.value, langMap.value);
  list = filterByConfidence(list, findingConfidenceFilter.value);
  // OLA BB, FRENTE BB2 — el quinto filtro, ortogonal a los otros cuatro.
  list = filterByFamily(list, familyFilter.value, LIST_LAYER);
  return list;
});

/**
 * OLA BB, FRENTE BB2 — las familias que ofrece el `<select>`, con su cuenta
 * de TARJETAS. Se calculan sobre los hallazgos VISIBLES bajo los OTROS cuatro
 * filtros (no bajo sí mismo: si no, elegir una familia dejaría una sola
 * opción en la lista y no habría cómo volver a otra), y ya vienen ordenadas
 * de mayor a menor.
 */
const familiesAvailable = computed<FamilyCount[]>(() => {
  if (!analysis.value) return [];
  let list = filterFindings(analysis.value.findings, kindFilter.value);
  list = filterByGranularity(list, granularityFilter.value, scopeMap.value);
  list = filterByLanguage(list, languageFilter.value, langMap.value);
  list = filterByConfidence(list, findingConfidenceFilter.value);
  return familiesIn(visible(list), LIST_LAYER);
});

/*
 * Una familia elegida que deja de existir (porque cambió otro filtro, el repo
 * o el análisis) tiene que soltarse sola, o la lista queda vacía sin que se
 * vea por qué. Se compara contra `familiesAvailable`, que ya excluye este
 * filtro de su propio cálculo.
 */
watch(familiesAvailable, (families) => {
  if (familyFilter.value !== null && !families.some((f) => f.pattern === familyFilter.value)) {
    familyFilter.value = null;
  }
});

/*
 * F3 — la línea de honestidad del grafo. `CodeAnalysis.graph` todavía no
 * existe en el contrato (`@shared/types`) — lo agrega, en paralelo, quien
 * sea dueño de la persistencia — así que hoy `graphOf` siempre da `null` y
 * nada de esta sección se muestra (mismo patrón que cualquier campo opcional
 * ausente: se calla, no se simula). Ver `./graph-status.ts` para la forma
 * exacta contra la que está escrito y el hueco de cobertura por lenguaje,
 * declarado ahí.
 */
const graphSummary = computed(() => graphOf(analysis.value));
const graphLine = computed(() => (graphSummary.value ? graphHeaderLine(graphSummary.value) : null));
const graphLanguageRows = computed(() =>
  graphSummary.value ? languageCoverageRows(graphSummary.value) : null,
);
const graphLanguageNote = computed(() =>
  graphSummary.value ? languageCoverageNote(graphSummary.value, analysis.value?.languages ?? []) : null,
);

/**
 * What the cards show: the selected file's findings when the map has one
 * picked, otherwise everything (still honouring every filter). Grouped —
 * F5, punto 4: un archivo con 261 hallazgos de un solo kind es UNA tarjeta,
 * no 261 (ver `grouping.ts`).
 */
const cardItems = computed<RankedItem[]>(() => {
  if (view.value === "map" && selectedFile.value) {
    const scoped = filterByFamily(
      filterByConfidence(
        filterByLanguage(
          filterByGranularity(
            filterFindings(selectedFile.value.findings, kindFilter.value),
            granularityFilter.value,
            scopeMap.value,
          ),
          languageFilter.value,
          langMap.value,
        ),
        findingConfidenceFilter.value,
      ),
      familyFilter.value,
      LIST_LAYER,
    );
    return rankGrouped(visible(scoped));
  }
  return rankedItems.value;
});

function onMapSelect(node: MapNode | null): void {
  selectedFile.value = node;
}

/** Discarded items are hidden unless `showDiscarded` — F2. */
function visible<T extends { discarded?: unknown }>(items: T[]): T[] {
  return showDiscarded.value ? items : items.filter((i) => !i.discarded);
}

const ranked = computed(() => visible(filteredFindings.value));

/** Agrupado (Nivel 2, `file+kind`) y ranqueado — lo que de verdad ve la vista "Lista". */
const rankedItems = computed<RankedItem[]>(() => rankGrouped(ranked.value));

function toggleGroupExpanded(key: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}

/* ── OLA BA, FRENTE BA2 — MONTAJE DIFERIDO DE LA LISTA ───────────────────
 *
 * Con la paginación afuera, entrar a "Lista" en `corpus-app/Ghost` monta
 * 3.910 tarjetas de una. `content-visibility` (ver el CSS de `.cp__list > li`)
 * ya se lleva el layout y el pintado de lo que no se ve; lo que queda es
 * CREAR los componentes, y eso no lo salva ningún truco de CSS: medido en el
 * banco, 3.910 tarjetas cuestan ~450 ms de trabajo que bloquea el hilo.
 *
 * Así que la primera tanda entra sola y el resto entra en tandas, una por
 * cuadro, hasta completar la lista. TERMINA SIEMPRE, y rápido: no es una
 * ventana, es un arranque escalonado. A los pocos cuadros la lista está
 * ENTERA en el DOM, así que el buscador del navegador, el scroll y cualquier
 * cosa que necesite ver todo siguen viendo todo — que es exactamente lo que
 * una lista virtual (o la paginación que acabamos de sacar) no puede
 * prometer.
 *
 * LAS TANDAS DUPLICAN, no suman. Medido: con tandas de tamaño fijo (300) la
 * lista de Ghost tardaba 881 ms en estar completa contra los 485 ms de
 * montarla de un saque — cada tanda hace que Vue vuelva a recorrer todo lo
 * que ya estaba, así que trece tandas cuestan trece recorridos. Duplicando
 * son cinco tandas en vez de trece, y el recorrido de más se paga una vez
 * por duplicación en vez de una por cada 300 tarjetas.
 *
 * NUNCA ENCOGE, PERO SIEMPRE CRECE — las dos mitades importan.
 *
 * Encoger sólo pasa cuando la lista APARECE (entrar a "Lista", o elegir un
 * archivo en el mapa): ahí se escalona de nuevo. Con la lista ya en pantalla
 * el contador no baja, porque bajarlo mientras el usuario lee le arrancaría
 * de abajo las tarjetas que está mirando.
 *
 * Crecer no es opcional: el escalonado se DETIENE cuando cubrió la lista, así
 * que si la lista se agranda después (quitar un filtro, prender
 * "Descartados", un poll que trae más) hay que volver a arrancarlo o las
 * tarjetas nuevas no aparecen nunca. Eso se encontró midiendo, no razonando:
 * prender "Descartados" mostraba 891 tarjetas donde la versión sin escalonado
 * mostraba 893, y las dos que faltaban eran justamente las descartadas. Por
 * eso el watcher mira TAMBIÉN `cardItems`, no sólo si la lista está en
 * pantalla.
 */
const RENDER_CHUNK = 300;
const renderedCount = ref(RENDER_CHUNK);
let renderRaf: number | null = null;

/** La lista de tarjetas está en pantalla (vista "Lista", o un archivo elegido en el mapa). */
const listShown = computed(() => view.value === "list" || selectedFile.value !== null);

/** Lo que de verdad se dibuja. Igual a `cardItems` apenas termina el escalonado. */
const shownCardItems = computed<RankedItem[]>(() => cardItems.value.slice(0, renderedCount.value));

/**
 * OLA BB, FRENTE BB2 — la clave del `v-for`, garantizada única. `itemKey` se
 * repite (3 claves para 6 ítems en Ghost) y con claves repetidas la lista
 * ACUMULA tarjetas fantasma al filtrar: 3.910 al entrar, 3.920 ocho cambios
 * de filtro después. Ver `grouping.ts#uniqueItemKeys` para el porqué y para
 * la propiedad que hace que el montaje escalonado no la vea cambiar.
 */
const shownCardKeys = computed<string[]>(() => uniqueItemKeys(shownCardItems.value));

function stopPump(): void {
  if (renderRaf !== null) {
    window.cancelAnimationFrame(renderRaf);
    renderRaf = null;
  }
}

function pumpRender(): void {
  if (renderRaf !== null) return;
  renderRaf = window.requestAnimationFrame(() => {
    renderRaf = null;
    const total = cardItems.value.length;
    if (!listShown.value || renderedCount.value >= total) return;
    renderedCount.value = Math.min(total, renderedCount.value * 2);
    pumpRender();
  });
}

watch(
  [listShown, cardItems] as const,
  ([shown], [wasShown]) => {
    stopPump();
    if (!shown) return;
    // Sólo al APARECER la lista se vuelve a escalonar; si ya estaba en
    // pantalla, se sigue creciendo desde donde estaba (nunca hacia abajo).
    if (!wasShown) renderedCount.value = RENDER_CHUNK;
    pumpRender();
  },
  { immediate: true },
);

/**
 * F5, punto 1 — "mostrando X de N". Con los campos reales (`totalByKind` &
 * co.) cuando el análisis los trae; si no, dice exactamente lo que sabe en
 * vez de fingir que lo mostrado es el total del repo (ver `grouping.ts`).
 */
const volumeLine = computed(() => {
  if (!analysis.value) return null;
  return honestyLine(rankedItems.value.length, totalMembers(rankedItems.value), volumeOf(analysis.value));
});

/* ── OLA BA, FRENTE BA2 — SE CARGA TODO, SIEMPRE ──────────────────────────
 *
 * LO QUE SE FUE, Y POR QUÉ. El panel pedía una PÁGINA (200 grupos) y ofrecía
 * un botón opt-in "Cargar el repo entero" que se RESETEABA al cambiar de
 * repo: por defecto el usuario nunca veía el total, que es exactamente el
 * síntoma reportado ("no todos los datos se cargan al mismo tiempo, lo que
 * genera que no pueda ver todas las recomendaciones"). Con el corte de
 * servido ya retirado del servidor (BA1: el default de `limit` pasó a
 * `"unlimited"`), la página, sus botones, el opt-in y las líneas de alcance
 * que decían "NO del repositorio entero" quedaron sin trabajo — y una línea
 * de alcance que ya no es cierta miente más que no estar.
 *
 * `load()` pide sin `offset` ni `limit`: el servidor devuelve TODO lo
 * guardado. El costo se movió entero al render, que es donde se ataca (ver
 * `content-visibility` en la lista, más abajo).
 *
 * LO QUE NO SE FUE, PORQUE SIGUE SIENDO CIERTO: `analysis.truncated`. Ése es
 * un recorte del ANÁLISIS (cuántos hallazgos se guardaron), no del servido:
 * en `corpus-app/Ghost` el motor encuentra 5.246 y guarda 3.915. Traerlo todo
 * no lo cambia, así que se sigue diciendo — abajo, y en `volumeLine`.
 */

/**
 * El único recorte que sobrevive: el del ALMACENAMIENTO del análisis. `null`
 * cuando no hay recorte — nunca un cartel que se muestre "por las dudas".
 */
const storageNote = computed(() => {
  const a = analysis.value;
  if (!a || a.truncated !== true) return null;
  const total = a.findingsTotal;
  const cuantos = total !== undefined ? `${a.findings.length} de los ${total} hallazgos que encontró` : "menos hallazgos de los que encontró";
  return `Abajo está TODO lo que este análisis guardó, sin páginas. El recorte que queda es del análisis, no de la pantalla: guardó ${cuantos}.`;
});

/* ── F5, punto 3: "Qué no estamos viendo" ──────────────────────────────────
 * `analysis.coverage` ya es un campo real (F4) — nada que cablear acá, sólo
 * agrupar por detector y contar baldes (`coverage.ts`). */
const coverageGroups = computed<DetectorCoverageGroup[]>(() =>
  groupCoverageByDetector(analysis.value?.coverage ?? []),
);
const coverageBlindSpots = computed(() => blindSpotSummary(analysis.value?.coverage ?? []));
const coverageBlindSpotLine = computed(() => blindSpotLine(coverageBlindSpots.value));

/*
 * F7 — Contrato 1: FindingCard no conoce taskId/repoName, así que sólo AVISA
 * qué hallazgo quiere descartar el usuario; el prompt de motivo y la llamada
 * a la API siguen viviendo acá, sin cambiar (ver `startDiscard`/`confirmDiscard`).
 */
function onCardDiscard(findingId: string): void {
  startDiscard(findingId);
}

/*
 * "open-file"/"focus-place" — CONTRATO-F7.md §2.3 reserva "focus-place" para
 * la vista ego (Frente C, no wireada todavía en esta pasada). Sin un visor
 * de archivos ni el ego view montados, el mejor destino HONESTO hoy es el
 * que ya existe: seleccionar ese archivo en el Mapa, igual que un clic en su
 * círculo — nunca un no-op silencioso. Ambos emits degradan a lo mismo hasta
 * que exista algo mejor a donde apuntar.
 */
/** Mismo recorrido que el `findNode` interno de `HotspotMap.vue` — no exportado ahí, así que se repite acá en 6 líneas en vez de tocar un archivo de otro frente. A diferencia de `rankedFiles`, no exige que el archivo tenga un hallazgo PROPIO: una fuga de Facade suele apuntar a un colaborador sin hipótesis anclada en él. */
function findMapNode(node: MapNode, path: string): MapNode | null {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findMapNode(child, path);
    if (hit) return hit;
  }
  return null;
}

function focusFileOnMap(file: string): void {
  if (!analysis.value) return;
  const node = findMapNode(buildTree(analysis.value), file);
  if (!node) return;
  // Only arm the escape hatch when `view` is actually about to change value
  // — otherwise the watcher below never fires (no change to react to) and
  // the flag would wrongly survive to swallow the NEXT unrelated reset.
  if (view.value !== "map") suppressNextSelectionReset = true;
  view.value = "map";
  selectedFile.value = node;
}

function onCardOpenFile(payload: { file: string; line: number }): void {
  focusFileOnMap(payload.file);
}

function onCardFocusPlace(payload: { file: string; line: number }): void {
  focusFileOnMap(payload.file);
}

/**
 * ArchitectureTab.vue#openItem emite `open-file` (ya cableado directo a
 * `focusFileOnMap`) Y `focus-finding` juntos desde el mismo click. Sin vista
 * ego montada (Frente C, ver el comentario de `onCardFocusPlace`), no hay un
 * destino más preciso que el archivo — mismo degrade honesto, resuelto acá
 * (no en el componente) buscando la ubicación real del hallazgo por id.
 */
function onArchFocusFinding(findingId: string): void {
  const finding = analysis.value?.findings.find((f) => f.id === findingId);
  const file = finding?.locations[0]?.file;
  if (file) focusFileOnMap(file);
}

/* ── Data ─────────────────────────────────────────────────────────────── */

async function load(): Promise<void> {
  try {
    // Sin `page`: el servidor devuelve TODO lo guardado (BA1). Ver el bloque
    // "SE CARGA TODO, SIEMPRE" más arriba.
    const next = await api.taskCode(props.taskId);
    error.value = null;
    const serialized = JSON.stringify(next);
    if (serialized === lastPayload) return; // nothing moved — keep the list as-is
    lastPayload = serialized;
    response.value = next;
    lastUpdated.value = new Date().toLocaleTimeString();
    if (selectedRepo.value === null || !next.repos.some((r) => r.repoName === selectedRepo.value)) {
      selectedRepo.value = next.repos[0]?.repoName ?? null;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function refreshNow(): Promise<void> {
  loading.value = true;
  lastPayload = ""; // force a re-render even if the payload is unchanged
  await load();
  loading.value = false;
}

/* ── F2: descartar / restaurar ────────────────────────────────────────── */

function startDiscard(id: string): void {
  discardingId.value = id;
  discardReason.value = "";
  discardError.value = null;
}

function cancelDiscard(): void {
  discardingId.value = null;
  discardError.value = null;
}

async function confirmDiscard(): Promise<void> {
  const id = discardingId.value;
  const repoName = repo.value?.repoName;
  if (!id || !repoName) return;
  const reason = discardReason.value.trim();
  if (!reason) {
    discardError.value = "El motivo no puede estar vacío.";
    return;
  }
  discardBusy.value = true;
  try {
    await api.discardCodeFinding(props.taskId, repoName, id, reason);
    discardingId.value = null;
    lastPayload = ""; // el descarte cambió el resultado sin tocar el análisis: forzar traerlo de nuevo
    await load();
  } catch (err) {
    discardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    discardBusy.value = false;
  }
}

async function restoreFinding(id: string): Promise<void> {
  const repoName = repo.value?.repoName;
  if (!repoName) return;
  try {
    await api.restoreCodeFinding(props.taskId, repoName, id);
    lastPayload = "";
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/* ── Polling: a self-rescheduling timeout (not setInterval) because the delay
 * itself depends on `isAnalyzing`, which can flip between two ticks. ── */

function scheduleNext(): void {
  pollTimer = window.setTimeout(async () => {
    if (props.active && document.visibilityState === "visible") await load();
    scheduleNext();
  }, isAnalyzing.value ? POLL_ANALYZING_MS : POLL_IDLE_MS);
}

function startPolling(): void {
  if (pollTimer !== null) return;
  scheduleNext();
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * Clears a stale map pick when the repo or the view changes — EXCEPT the one
 * change `focusFileOnMap` itself causes (switching a non-map view TO map
 * while setting `selectedFile` in that same tick). Without the escape hatch,
 * this watcher — which fires on the microtask AFTER both assignments — wiped
 * the freshly-picked file right back to null, so "abrí en el mapa" from
 * List/the F7 tabs silently landed on an empty map (found live while wiring
 * F7's tabs; pre-existing, not specific to them).
 */
let suppressNextSelectionReset = false;
watch([selectedRepo, view], () => {
  if (suppressNextSelectionReset) {
    suppressNextSelectionReset = false;
    return;
  }
  selectedFile.value = null;
  expandedGroups.value = new Set();
});

// A repo switch invalidates the OTHER repo's filters too.
//
// OLA BA, FRENTE BA2: acá vivía el reseteo de la página y del opt-in
// "cargar todo" — la causa exacta del síntoma reportado, porque cambiar de
// repo devolvía al usuario a los primeros 200 grupos sin avisarle. Ya no hay
// página ni opt-in que resetear: cada repo llega entero, siempre. Tampoco
// hace falta un `refreshNow()` acá — el payload ya trae TODOS los repos de
// la tarea, así que cambiar de selección no necesita otra consulta.
watch(selectedRepo, () => {
  granularityFilter.value = null;
  languageFilter.value = null;
  findingConfidenceFilter.value = null;
  // OLA BB, FRENTE BB2: las familias de un repo no son las del otro.
  familyFilter.value = null;
});

function toggleKindFilter(kind: CodeFindingKind): void {
  kindFilter.value = kindFilter.value === kind ? null : kind;
}

/* ── OLA BB, FRENTE BB2 — EL CARRUSEL MANUAL DE LA BARRA DE KINDS ─────────
 *
 * MANUAL, y esa palabra es el requisito: el usuario pidió "un carrusel manual
 * que me permita ir viendo la lista". No hay temporizador, no hay
 * desplazamiento automático, no hay `scrollIntoView` disparado por un filtro:
 * la tira se mueve cuando alguien la mueve.
 *
 * Y no oculta nada. La tira es un `overflow-x: auto` de verdad, así que los
 * 50 kinds siguen en el DOM y siguen siendo alcanzables con la rueda, con el
 * arrastre táctil y con el Tab (el navegador desplaza solo al enfocar un
 * botón que quedó fuera). Las flechas son una comodidad encima de eso, no la
 * única puerta — por eso también se ESCONDEN cuando no hay desbordamiento, en
 * vez de quedar grises ocupando lugar.
 *
 * `ResizeObserver` porque el desbordamiento depende del ancho del panel, que
 * cambia sin que cambie ni el análisis ni el filtro (redimensionar la
 * ventana, abrir el terminal al lado).
 */
const kindStrip = ref<HTMLElement | null>(null);
const kindsOverflow = ref(false);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);

function syncKindNav(): void {
  const el = kindStrip.value;
  if (!el) {
    kindsOverflow.value = false;
    return;
  }
  // 1px de tolerancia: con zoom o escalas fraccionarias el `scrollLeft` máximo
  // no llega nunca al entero exacto y la flecha derecha quedaría viva para siempre.
  const max = el.scrollWidth - el.clientWidth;
  kindsOverflow.value = max > 1;
  canScrollLeft.value = el.scrollLeft > 1;
  canScrollRight.value = el.scrollLeft < max - 1;
}

/** Una "página" es el 80% del ancho visible: siempre queda un botón compartido entre pantalla y pantalla, para no perder el hilo. */
function scrollKinds(direction: 1 | -1): void {
  const el = kindStrip.value;
  if (!el) return;
  el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
}

let kindResizeObserver: ResizeObserver | null = null;

watch(
  [kindStrip, shownKinds],
  async () => {
    kindResizeObserver?.disconnect();
    kindResizeObserver = null;
    await nextTick();
    syncKindNav();
    const el = kindStrip.value;
    if (el && typeof ResizeObserver !== "undefined") {
      kindResizeObserver = new ResizeObserver(() => syncKindNav());
      kindResizeObserver.observe(el);
    }
  },
  { immediate: true },
);

/* ── Lifecycle ────────────────────────────────────────────────────────── */

onMounted(() => {
  void refreshNow();
  startPolling();
});

onBeforeUnmount(() => {
  stopPolling();
  stopPump();
  kindResizeObserver?.disconnect();
  kindResizeObserver = null;
});

// Opening the tab re-reads so it never shows stale content.
watch(
  () => props.active,
  (active) => {
    if (active) void load();
  },
);
</script>

<template>
  <section class="cp">
    <header class="cp__bar">
      <select
        v-if="allRepos.length > 1"
        v-model="selectedRepo"
        class="cp__select"
        aria-label="Repositorio"
      >
        <option v-for="r in allRepos" :key="r.repoName" :value="r.repoName">
          {{ r.repoName }}{{ r.analyzing ? " · analizando" : "" }}
        </option>
      </select>
      <span v-else-if="repo" class="cp__repo">{{ repo.repoName }}</span>

      <div class="cp__views" role="group" aria-label="Modo de vista">
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'map' }"
          @click="view = 'map'"
        >
          Mapa
        </button>
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'list' }"
          @click="view = 'list'"
        >
          Lista
        </button>
        <!-- OLA BA, FRENTE BA2: las propuestas de PATRÓN DE DISEÑO viven acá,
             fuera de las tarjetas de la lista; Mapa y Lista quedan con las de
             REFACTORIZACIÓN. Movimiento sólo visual — ni un contador, ni un
             estado, ni un descarte cambia de lugar. -->
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'patterns' }"
          title="Las propuestas de patrón de diseño, separadas de las de refactorización — se miden con varas distintas"
          @click="view = 'patterns'"
        >
          Patrones
        </button>
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'coverage' }"
          title="Qué corrió, qué no aplica, y qué quedó bloqueado — F5"
          @click="view = 'coverage'"
        >
          Qué no vemos
        </button>
        <!-- F7 (P1): las tres pestañas de CONTRATO-F7.md §3 (Frente D), antes
             construidas y probadas pero inalcanzables desde acá. "Descartes"
             (no "Descartados") a propósito: el botón "Descartados" de más
             abajo es el FILTRO legado (oculta/muestra en Mapa/Lista); esto es
             la pestaña dedicada con motivo y fecha — conviven, no se pisan. -->
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'architecture' }"
          title="Abstracciones ya aplicadas, forma del repo, y cuánto de eso se puede confiar — CONTRATO-F7.md §3.1"
          @click="view = 'architecture'"
        >
          Arquitectura
        </button>
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'discarded' }"
          title="Pestaña dedicada a TODO lo descartado, con motivo y fecha — distinta del filtro «Descartados» de la barra, que sólo oculta/muestra en Mapa y Lista"
          @click="view = 'discarded'"
        >
          Descartes
        </button>
        <button
          type="button"
          class="cp__view"
          :class="{ 'cp__view--active': view === 'resolved' }"
          title="Hipótesis «ya aplicado» verificadas hoy — sin historial de corridas anteriores, brecha declarada en la pestaña — CONTRATO-F7.md §3.3"
          @click="view = 'resolved'"
        >
          Ya resuelto
        </button>
      </div>

      <template v-if="view === 'list' || view === 'map'">
        <!-- OLA BB, FRENTE BB2: las opciones salen en el mismo orden que la
             barra de abajo (por cantidad, de mayor a menor) y llevan el número
             a la vista — sin él, "por cantidad" es un orden que el lector no
             puede verificar. -->
        <select v-model="kindFilter" class="cp__select" aria-label="Tipo de problema">
          <option :value="null">Todos los tipos</option>
          <option v-for="k in shownKinds" :key="k" :value="k">
            {{ labelFor(k) }} ({{ kindTotalsInfo?.counts[k] ?? 0 }})
          </option>
        </select>
        <!-- OLA BB, FRENTE BB2 — el eje que faltaba para "ver un patrón
             específico": la SOLUCIÓN propuesta, no el problema medido. Se
             calla si no hay al menos dos familias entre las que elegir, misma
             convención que el selector de lenguaje. -->
        <select
          v-if="familiesAvailable.length > 1"
          v-model="familyFilter"
          class="cp__select"
          aria-label="Refactorización propuesta"
          title="Filtra por la refactorización que la hipótesis propone — distinto del tipo de problema que el detector midió"
        >
          <option :value="null">Toda refactorización propuesta</option>
          <option v-for="f in familiesAvailable" :key="f.pattern" :value="f.pattern">
            {{ f.pattern }} ({{ f.findings }})
          </option>
        </select>
        <select v-model="granularityFilter" class="cp__select" aria-label="Granularidad">
          <option :value="null">Toda granularidad</option>
          <option v-for="g in GRANULARITY_ORDER" :key="g" :value="g">{{ GRANULARITY_LABELS[g] }}</option>
        </select>
        <select v-if="languagesAvailable.length > 1" v-model="languageFilter" class="cp__select" aria-label="Lenguaje">
          <option :value="null">Todo lenguaje</option>
          <option v-for="l in languagesAvailable" :key="l" :value="l">{{ l }}</option>
        </select>
        <select
          v-if="confidenceAvailable"
          v-model="findingConfidenceFilter"
          class="cp__select"
          aria-label="Confianza del hallazgo"
        >
          <option :value="null">Toda confianza</option>
          <option v-for="c in CONFIDENCE_TIER_ORDER" :key="c" :value="c">{{ CONFIDENCE_TIER_LABELS[c] }}</option>
        </select>
      </template>

      <span v-if="analysis" class="cp__stats">
        {{ analysis.analysedFiles }}/{{ analysis.scannedFiles }} archivos ·
        {{ analysis.totalLines }} líneas
        <template v-if="analysis.languages.length">
          · {{ analysis.languages.join(", ") }}
        </template>
      </span>

      <button
        type="button"
        class="cp__view"
        :class="{ 'cp__view--active': showDiscarded }"
        title="Los descartes persisten por repositorio — F2"
        @click="showDiscarded = !showDiscarded"
      >
        Descartados
      </button>

      <span class="cp__spacer" />
      <span v-if="repo?.analyzing && repo.analysis" class="cp__reanalyzing">
        Reanalizando…
      </span>
      <span v-if="lastUpdated" class="cp__updated">actualizado {{ lastUpdated }}</span>
      <button class="cp__refresh" type="button" :disabled="loading" @click="refreshNow">
        ⟳
      </button>
    </header>

    <p v-if="error" class="cp__error">{{ error }}</p>
    <p v-else-if="repo?.error" class="cp__error">
      No se pudo analizar «{{ repo.repoName }}»: {{ repo.error }}
    </p>

    <!-- OLA BB, FRENTE BB2 — LA BARRA DE KINDS, EN UNA SOLA LÍNEA.
         Medido sobre Ghost en 1440×900: 50 kinds, 10 filas, 399 px de alto,
         contra los 420 px que le quedaban al mapa. La barra se comía media
         pantalla antes de mostrar un solo hallazgo. Ahora es una tira de una
         línea con dos flechas MANUALES (el usuario pidió ir viendo, no que se
         mueva solo). No se esconde ni un kind: los 50 siguen ahí, en el mismo
         orden por cantidad, alcanzables con las flechas, con la rueda o con
         el Tab. -->
    <div
      v-if="(view === 'list' || view === 'map') && kindTotalsInfo && analysis && analysis.findings.length > 0"
      class="cp__totals"
    >
      <button
        v-if="kindsOverflow"
        type="button"
        class="cp__totals-nav"
        :disabled="!canScrollLeft"
        aria-label="Ver los tipos anteriores"
        @click="scrollKinds(-1)"
      >
        ‹
      </button>
      <div ref="kindStrip" class="cp__totals-strip" @scroll="syncKindNav">
        <button
          v-for="k in shownKinds"
          :key="k"
          type="button"
          class="cp__total"
          :class="{ 'cp__total--active': kindFilter === k }"
          @click="toggleKindFilter(k)"
        >
          <span class="cp__total-count">{{ kindTotalsInfo.counts[k] ?? 0 }}</span>
          <span class="cp__total-label">{{ labelFor(k) }}</span>
        </button>
      </div>
      <button
        v-if="kindsOverflow"
        type="button"
        class="cp__totals-nav"
        :disabled="!canScrollRight"
        aria-label="Ver los tipos siguientes"
        @click="scrollKinds(1)"
      >
        ›
      </button>
      <span v-if="kindTotalsInfo.isPartial" class="cp__totals-partial">
        parcial — cuenta sólo lo mostrado, no el total real del repositorio
      </span>
    </div>

    <!-- OLA BA, FRENTE BA2: acá vivían los botones de página y el cartel de
         alcance. Se fueron con la paginación: el panel carga TODO, siempre.
         Lo único que queda es el recorte que sigue siendo cierto — el del
         ALMACENAMIENTO del análisis, que traer más no cambia. -->
    <p v-if="storageNote" class="cp__storage-note">{{ storageNote }}</p>

    <!-- F3: honestidad medible antes que hallazgos — PLAN.md fase F3. Se
         calla por completo mientras `CodeAnalysis.graph` no exista (ver el
         comentario de `graphSummary` arriba); nunca un "0%" fabricado. -->
    <div v-if="graphLine" class="cp__graph">
      <span class="cp__graph-line">{{ graphLine }}</span>
      <span v-if="graphLanguageNote" class="cp__graph-note">{{ graphLanguageNote }}</span>
      <ul v-if="graphLanguageRows && graphLanguageRows.length" class="cp__graph-langs">
        <li v-for="row in graphLanguageRows" :key="row.language" class="cp__graph-lang">
          <span class="cp__graph-lang-name">{{ row.language }}</span>
          <span class="cp__graph-lang-value">
            {{ row.kind === "rate" ? `${row.pct} sin resolver` : "no aplicable" }}
          </span>
        </li>
      </ul>
    </div>

    <div class="cp__canvas">
      <!-- No data of any kind read yet: first paint of the session. -->
      <div v-if="!response" class="cp__loading">
        <p>Analizando el código de la tarea…</p>
        <p class="cp__loading-note">
          Puede tardar unos segundos; corre en segundo plano, así que podés seguir
          usando el terminal mientras tanto.
        </p>
      </div>

      <p v-else-if="!repo" class="cp__empty">La tarea no tiene repos para analizar.</p>

      <template v-else-if="!repo.error">
        <!-- Repo picked up, but no analysis landed yet (first run in flight). -->
        <div v-if="!repo.analysis" class="cp__loading">
          <p>Analizando «{{ repo.repoName }}»…</p>
          <p class="cp__loading-note">
            Puede tardar unos segundos; corre en segundo plano, así que podés seguir
            usando el terminal mientras tanto.
          </p>
        </div>

        <p v-else-if="repo.analysis.scannedFiles === 0" class="cp__empty">
          «{{ repo.repoName }}» no tiene archivos en un lenguaje soportado.
        </p>

        <!-- "QUÉ NO ESTAMOS VIENDO" — F5, punto 3. Vive fuera del chequeo de
             `findings.length` de abajo a propósito: es justamente la pantalla
             que hay que poder abrir CUANDO no hay hallazgos, para distinguir
             "no aplica en este lenguaje" de "corrió y no encontró nada". -->
        <template v-else-if="view === 'coverage'">
          <p v-if="!analysis?.coverage || analysis.coverage.length === 0" class="cp__empty">
            Este análisis no trae datos de cobertura (análisis de antes de que
            existiera el campo, o el repo todavía no se volvió a analizar).
            Reanalizá «{{ repo.repoName }}» para verlos.
          </p>
          <template v-else>
            <p class="cp__coverage-summary">{{ coverageBlindSpotLine }}</p>
            <ul class="cp__coverage-list">
              <li v-for="g in coverageGroups" :key="g.detectorId" class="cp__coverage-card">
                <header class="cp__coverage-head">
                  <span class="cp__card-kind">{{ SCOPE_LABELS[g.scope] }}</span>
                  <h3 class="cp__card-title">{{ g.title }}</h3>
                  <span class="cp__coverage-total" title="Hallazgos totales de este detector en este repo">
                    {{ g.totalFindings }}
                  </span>
                </header>
                <ul class="cp__coverage-rows">
                  <li
                    v-for="(row, ri) in g.rows"
                    :key="ri"
                    class="cp__coverage-row"
                    :class="`cp__coverage-row--${bucketOf(row)}`"
                  >
                    <span v-if="row.language" class="cp__coverage-lang">{{ row.language }}</span>
                    <span class="cp__coverage-bucket">{{ BUCKET_LABELS[bucketOf(row)] }}</span>
                    <span v-if="row.status === 'corrio'" class="cp__coverage-detail">
                      {{ row.findings }} hallazgos · {{ row.unitsConsidered }} unidades analizadas
                    </span>
                    <span v-else-if="missingCapabilitiesText(row)" class="cp__coverage-detail">
                      {{ missingCapabilitiesText(row) }}
                    </span>
                    <span v-else-if="row.error" class="cp__coverage-detail">{{ row.error }}</span>
                  </li>
                </ul>
              </li>
            </ul>
          </template>
        </template>

        <!-- F7 (P1): las tres pestañas nuevas viven ACÁ, fuera del chequeo de
             `findings.length` de abajo — igual que "coverage" arriba, tienen
             que poder abrirse aunque el análisis no traiga hallazgos.
             OLA BA, FRENTE BA2: cada una tenía encima una línea de alcance y
             un botón opt-in "Cargar el repo entero". Los dos se fueron: el
             repo llega entero siempre, así que la línea ya no sería un aviso
             sino una mentira, y el botón no tendría nada que traer. -->
        <template v-else-if="view === 'architecture'">
          <ArchitectureTab
            :analysis="repo.analysis"
            @open-file="focusFileOnMap"
            @focus-finding="onArchFocusFinding"
          />
        </template>

        <!-- OLA BA, FRENTE BA2 — la pestaña de PATRONES. Lee de
             `repo.analysis` como las demás y respeta el mismo filtro de
             descartados de la barra; no toca ningún contador. -->
        <template v-else-if="view === 'patterns'">
          <PatternsTab
            :analysis="repo.analysis"
            :show-discarded="showDiscarded"
            @open-file="focusFileOnMap"
            @focus-finding="onArchFocusFinding"
            @focus-place="onCardFocusPlace"
          />
        </template>

        <template v-else-if="view === 'discarded'">
          <DiscardedTab
            :analysis="repo.analysis"
            @restore="restoreFinding"
            @open-file="focusFileOnMap"
          />
        </template>

        <template v-else-if="view === 'resolved'">
          <ResolvedTab :analysis="repo.analysis" @open-file="focusFileOnMap" />
        </template>

        <p v-else-if="repo.analysis.findings.length === 0" class="cp__empty">
          No se encontraron hotspots de refactorización en «{{ repo.repoName }}». El
          código analizado no muestra duplicación, cadenas de condicionales,
          complejidad ni funciones largas por encima del umbral.
        </p>

        <p v-else-if="ranked.length === 0" class="cp__empty">
          Ningún hallazgo pasa los filtros activos en «{{ repo.repoName }}».
        </p>

        <template v-else>
          <HotspotMap
            v-if="view === 'map'"
            :analysis="repo.analysis"
            :selected="selectedFile?.path ?? null"
            @select="onMapSelect"
          />

          <p v-if="view === 'map' && !selectedFile" class="cp__pick">
            Elegí un archivo del mapa para ver sus hallazgos, o pasá a la lista para
            recorrerlos todos por severidad.
          </p>
          <h3 v-else-if="view === 'map'" class="cp__picked">
            {{ selectedFile!.path }}
            <button type="button" class="cp__clear" @click="selectedFile = null">
              limpiar
            </button>
          </h3>

          <!-- F5, punto 1: la línea "mostrando X de N" — antes de la lista, siempre visible mientras haya algo que listar. -->
          <p v-if="volumeLine && (view === 'list' || selectedFile)" class="cp__volume-line">{{ volumeLine }}</p>

          <ul v-if="view === 'list' || selectedFile" class="cp__list">
          <template v-for="(item, ci) in shownCardItems" :key="shownCardKeys[ci]">
          <!-- HALLAZGO SUELTO — por debajo de GROUP_MIN en su (archivo, kind), o único.
               F7: la tarjeta y su hipótesis subordinada viven en FindingCard.vue —
               ver CONTRATO-F7.md Contrato 1. El prompt de motivo/restaurar se queda
               ACÁ, porque FindingCard no conoce taskId/repoName (§1.6). -->
          <li v-if="item.type === 'single'" class="cp__card-wrap">
            <FindingCard
              :finding="item.finding"
              :layer="LIST_LAYER"
              hide-applied
              @discard="onCardDiscard"
              @open-file="onCardOpenFile"
              @focus-place="onCardFocusPlace"
            />
            <div
              v-if="item.finding.id && (item.finding.discarded || discardingId === item.finding.id)"
              class="cp__discard"
            >
              <template v-if="item.finding.discarded">
                <span class="cp__discard-badge">Descartado: {{ item.finding.discarded.reason }}</span>
                <button type="button" class="cp__discard-btn" @click="restoreFinding(item.finding.id!)">
                  Restaurar
                </button>
              </template>
              <template v-else>
                <input
                  v-model="discardReason"
                  class="cp__discard-input"
                  placeholder="Motivo del descarte…"
                  @keyup.enter="confirmDiscard()"
                  @keyup.escape="cancelDiscard()"
                />
                <button type="button" class="cp__discard-btn" :disabled="discardBusy" @click="confirmDiscard()">
                  Confirmar
                </button>
                <button type="button" class="cp__discard-btn cp__discard-btn--ghost" @click="cancelDiscard()">
                  Cancelar
                </button>
                <span v-if="discardError" class="cp__discard-error">{{ discardError }}</span>
              </template>
            </div>
          </li>

          <!-- GRUPO DE CAUSA RAÍZ — F5, punto 4: un archivo con 261/416 hallazgos
               del mismo kind es ESTA tarjeta, colapsada, nunca 261 filas. -->
          <li v-else class="cp__card cp__group" :class="`cp__card--${severityTier(item.group.score)}`">
            <div class="cp__card-bar" />
            <div class="cp__card-body">
              <header
                class="cp__card-head cp__group-head"
                @click="toggleGroupExpanded(item.group.key)"
              >
                <span class="cp__card-kind">{{ labelFor(item.group.kind) }}</span>
                <h3 class="cp__card-title">
                  {{ item.group.memberCount }} × {{ labelFor(item.group.kind).toLowerCase() }} en «{{ item.group.file }}»
                </h3>
                <span class="cp__card-severity" :title="`Peor severidad del grupo: ${item.group.score}/100`">
                  {{ item.group.score }}
                </span>
              </header>

              <p class="cp__card-detail">
                {{ item.group.memberCount }} instancias de «{{ labelFor(item.group.kind) }}» en el mismo archivo —
                agrupadas por localidad (mismo archivo, mismo tipo de problema) para no repetir {{ item.group.memberCount }}
                tarjetas casi idénticas. El puntaje mostrado es el de la peor de todas, nunca la suma.
              </p>

              <ul class="cp__group-exemplars">
                <li v-for="ex in item.group.exemplars" :key="findingKey(ex)">
                  <span class="cp__group-ex-title">{{ ex.title }}</span>
                  <span class="cp__group-ex-loc">{{ formatLocation(ex.locations[0]) }}</span>
                  <span class="cp__group-ex-sev">{{ ex.severity }}</span>
                </li>
              </ul>

              <button type="button" class="cp__group-toggle" @click="toggleGroupExpanded(item.group.key)">
                {{
                  expandedGroups.has(item.group.key)
                    ? "Colapsar"
                    : `Ver las ${item.group.memberCount - item.group.exemplars.length} restantes`
                }}
              </button>

              <ul v-if="expandedGroups.has(item.group.key)" class="cp__group-members">
                <li v-for="m in item.group.members" :key="findingKey(m)">
                  <span class="cp__group-ex-loc">{{ formatLocation(m.locations[0]) }}</span>
                  <span class="cp__group-ex-title">{{ m.title }}</span>
                  <span class="cp__group-ex-sev">{{ m.severity }}</span>
                </li>
              </ul>
            </div>
          </li>
          </template>
          </ul>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* The caveat and the cost are as much a part of a pattern suggestion as its
   name: a suggestion that only advertises the upside is misleading. */
.cp__caveat,
.cp__cost {
  display: block;
  font-size: 11px;
  color: var(--ck-text-faint);
  margin-top: 2px;
}

.cp__cost {
  color: var(--ck-status-review);
}

.cp__pop {
  font-size: 11px;
  color: var(--ck-status-review);
  margin-left: 6px;
}

/* ── Toggle de vista ── */
.cp__views {
  display: inline-flex;
  gap: 2px;
  border: 1px solid var(--ck-border);
  border-radius: 6px;
  padding: 2px;
}

.cp__view {
  border: none;
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 4px;
  padding: 3px 12px;
  font-size: 12px;
}

.cp__view:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.cp__view--active {
  background: var(--ck-surface-2);
  color: var(--ck-text);
}

/* ── Puente entre el mapa y las tarjetas ── */
.cp__pick {
  margin: 14px 0 0;
  color: var(--ck-text-faint);
  font-size: 12.5px;
}

.cp__picked {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0 8px;
  font-size: 13px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  color: var(--ck-text);
}

.cp__clear {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-faint);
  border-radius: 5px;
  padding: 1px 8px;
  font-size: 11px;
  font-family: inherit;
}

.cp__clear:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}
.cp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--ck-bg);
}

/* ── Toolbar ── */
.cp__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ck-border);
  background: var(--ck-surface);
  flex-wrap: wrap;
}

.cp__select {
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-radius: 6px;
  color: var(--ck-text);
  padding: 4px 8px;
  font-size: 12.5px;
}

.cp__repo {
  font-weight: 600;
  font-size: 13px;
}

.cp__stats {
  font-size: 11.5px;
  color: var(--ck-text-faint);
}

.cp__spacer {
  flex: 1;
}

.cp__reanalyzing {
  font-size: 11px;
  color: var(--ck-status-review);
}

.cp__updated {
  font-size: 11px;
  color: var(--ck-text-faint);
}

.cp__refresh {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 12px;
}

.cp__refresh:hover:not(:disabled) {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.cp__error {
  margin: 8px 12px 0;
  color: var(--ck-danger);
  font-size: 12.5px;
}

/* ── Totals row — OLA BB, FRENTE BB2: UNA SOLA LÍNEA, CON CARRUSEL MANUAL.
   Antes: `flex-wrap: wrap` con 50 kinds = 10 filas y 399 px de alto sobre un
   canvas de 420. Ahora: una tira que no envuelve, con su propio scroll
   horizontal y dos flechas. Ningún kind se esconde. ── */
.cp__totals {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ck-border);
  flex-wrap: nowrap;
  min-width: 0;
}

.cp__totals-strip {
  display: flex;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-behavior: smooth;
  /* Una barra fina en vez de ninguna: que se vea que hay más a los costados
     es la mitad del trabajo del carrusel. */
  scrollbar-width: thin;
  padding-bottom: 2px;
}

.cp__totals-strip::-webkit-scrollbar {
  height: 6px;
}

.cp__totals-strip::-webkit-scrollbar-thumb {
  background: var(--ck-border);
  border-radius: 3px;
}

.cp__totals-nav {
  flex: 0 0 auto;
  border: 1px solid var(--ck-border);
  background: var(--ck-surface);
  color: var(--ck-text-muted);
  border-radius: var(--ck-radius);
  width: 22px;
  align-self: stretch;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.cp__totals-nav:hover:not(:disabled) {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.cp__totals-nav:disabled {
  opacity: 0.3;
  cursor: default;
}

.cp__total {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 0 0 auto;
  white-space: nowrap;
  border: 1px solid var(--ck-border);
  background: var(--ck-surface);
  border-radius: var(--ck-radius);
  padding: 6px 12px;
  color: var(--ck-text-muted);
}

.cp__total:hover {
  background: var(--ck-surface-hover);
}

.cp__total--active {
  border-color: var(--ck-primary);
  color: var(--ck-text);
}

.cp__total-count {
  font-size: 15px;
  font-weight: 700;
  color: var(--ck-text);
}

.cp__total-label {
  font-size: 11.5px;
}

.cp__totals-partial {
  flex: 0 1 auto;
  align-self: center;
  font-size: 11px;
  font-style: italic;
  color: var(--ck-text-faint);
}

/* OLA BA, FRENTE BA2: acá estaba el estilo de la barra de páginas. El único
   cartel que sobrevive es el del recorte de ALMACENAMIENTO del análisis. */
.cp__storage-note {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--ck-border);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ck-text-faint);
}

/* ── F5: "mostrando X de N" ── */
.cp__volume-line {
  margin: 0 0 10px;
  font-size: 11.5px;
  color: var(--ck-text-faint);
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

/* ── F5: tarjeta de grupo (causa raíz por localidad) ── */
.cp__group .cp__card-title {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 12.5px;
}

.cp__group-head {
  cursor: pointer;
}

.cp__group-exemplars,
.cp__group-members {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  color: var(--ck-text-muted);
}

.cp__group-exemplars li,
.cp__group-members li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-top: 1px dashed var(--ck-border);
}

.cp__group-exemplars li:first-child,
.cp__group-members li:first-child {
  border-top: none;
}

.cp__group-ex-title {
  flex: 1;
  min-width: 0;
  overflow-wrap: break-word;
  color: var(--ck-text);
}

.cp__group-ex-loc {
  flex: 0 0 auto;
  color: var(--ck-text-faint);
}

.cp__group-ex-sev {
  flex: 0 0 auto;
  font-weight: 700;
}

.cp__group-members {
  max-height: 260px;
  overflow-y: auto;
}

.cp__group-toggle {
  margin-top: 8px;
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-primary);
  border-radius: 5px;
  padding: 3px 10px;
  font-size: 11.5px;
}

.cp__group-toggle:hover {
  background: var(--ck-surface-hover);
}

/* ── F5: "Qué no estamos viendo" ── */
.cp__coverage-summary {
  margin: 0 0 12px;
  color: var(--ck-text-muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.cp__coverage-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cp__coverage-card {
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  padding: 10px 14px;
}

.cp__coverage-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cp__coverage-total {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--ck-text-faint);
}

.cp__coverage-rows {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cp__coverage-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11.5px;
  padding: 2px 0;
}

.cp__coverage-lang {
  flex: 0 0 auto;
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10.5px;
  color: var(--ck-text-muted);
  min-width: 42px;
}

.cp__coverage-bucket {
  flex: 0 0 auto;
  font-weight: 600;
}

.cp__coverage-detail {
  color: var(--ck-text-faint);
}

/* Los cinco baldes de coverage.ts, cada uno con su color — "no aplica"
   nunca se ve como "corrió sin encontrar nada": son historias distintas. */
.cp__coverage-row--con-hallazgos .cp__coverage-bucket {
  color: var(--ck-status-done);
}

.cp__coverage-row--sin-hallazgos .cp__coverage-bucket {
  color: var(--ck-text-muted);
}

.cp__coverage-row--no-aplicable .cp__coverage-bucket {
  color: var(--ck-text-faint);
  font-style: italic;
}

.cp__coverage-row--bloqueado .cp__coverage-bucket {
  color: var(--ck-status-review);
}

.cp__coverage-row--error .cp__coverage-bucket {
  color: var(--ck-danger);
}

/* ── F3: honestidad del grafo ── */
.cp__graph {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--ck-border);
  font-size: 11.5px;
  color: var(--ck-text-faint);
}

.cp__graph-line {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  color: var(--ck-text-muted);
}

.cp__graph-note {
  color: var(--ck-status-review);
  font-style: italic;
}

.cp__graph-langs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.cp__graph-lang {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  border: 1px solid var(--ck-border);
  border-radius: 999px;
  padding: 1px 8px;
}

.cp__graph-lang-name {
  font-weight: 600;
  color: var(--ck-text-muted);
}

.cp__graph-lang-value {
  color: var(--ck-text-faint);
}

/* ── Body ── */
.cp__canvas {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}

.cp__loading {
  max-width: 480px;
  margin: 24px auto;
  text-align: center;
}

.cp__loading p {
  margin: 0 0 8px;
  color: var(--ck-text-muted);
  font-size: 13px;
}

.cp__loading-note {
  color: var(--ck-text-faint) !important;
  font-size: 11.5px !important;
}

.cp__empty {
  color: var(--ck-text-faint);
  font-size: 12.5px;
  margin: 24px 0;
}

/* ── Cards ── */
.cp__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/*
 * OLA BA, FRENTE BA2 — EL RENDER, QUE ES DONDE QUEDÓ EL COSTO.
 *
 * Sacada la paginación, la lista de `corpus-app/Ghost` pasa de 200 grupos a
 * todo lo guardado. Montarlo entero de una hacía inusable el panel: medido
 * en el banco (`scratchpad-ba2/`), el cambio de vista a "Lista" tardaba
 * segundos, y el costo estaba casi todo en MAQUETAR Y PINTAR tarjetas que
 * nadie está mirando.
 *
 * `content-visibility: auto` le dice al navegador que se salte layout y
 * paint de las filas fuera de pantalla, y las haga cuando se acercan. Se
 * eligió esto por encima de una lista virtual o de un montaje por ventanas
 * POR LO QUE NO ROMPE: la fila SIGUE en el DOM. El filtro por kind, el de
 * descartados, el agrupado, el ranking, el buscador del navegador y el
 * scroll a un hallazgo concreto (`focusFileOnMap`) siguen viendo la lista
 * entera — una ventana que desmonta lo que no se ve rompe justamente eso, y
 * eso sería peor que la paginación que acabamos de sacar.
 *
 * `contain-intrinsic-size: auto 220px` es la altura que el navegador asume
 * mientras una fila está saltada; `auto` hace que recuerde la real después
 * de haberla medido una vez, así que la barra de scroll se corrige sola a
 * medida que se recorre en vez de quedar mintiendo.
 */
.cp__list > li {
  content-visibility: auto;
  contain-intrinsic-size: auto 220px;
}

/* F7: envuelve FindingCard.vue + el prompt de descarte/restaurar, que se
   quedan acá porque el componente no conoce taskId/repoName. */
.cp__card-wrap {
  display: flex;
  flex-direction: column;
}

.cp__card {
  display: flex;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  overflow: hidden;
}

.cp__card-bar {
  flex: 0 0 auto;
  width: 4px;
}

.cp__card--high .cp__card-bar {
  background: var(--ck-danger);
}

.cp__card--medium .cp__card-bar {
  background: var(--ck-status-review);
}

.cp__card--low .cp__card-bar {
  background: var(--ck-status-done);
}

.cp__card-body {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
}

.cp__card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cp__card-kind {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ck-text-faint);
}

.cp__card-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ck-text);
  overflow-wrap: break-word;
}

.cp__card-severity {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--ck-text-faint);
}

.cp__card--high .cp__card-severity {
  color: var(--ck-danger);
}

.cp__card--medium .cp__card-severity {
  color: var(--ck-status-review);
}

.cp__card-metric {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--ck-text-muted);
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

.cp__card-detail {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--ck-text-muted);
  line-height: 1.5;
}

.cp__card-locations {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--ck-text-faint);
  font-size: 11.5px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

.cp__card-locations li {
  padding: 1px 0;
  word-break: break-all;
}

.cp__card-pattern {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ck-border);
  font-size: 12px;
}

.cp__card-pattern--alt {
  color: var(--ck-text-faint);
}

.cp__card-alt-label {
  color: var(--ck-text-faint);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-right: 4px;
}

.cp__card-pattern-link {
  color: var(--ck-primary);
  text-decoration: none;
  font-weight: 600;
}

.cp__card-pattern-link:hover {
  color: var(--ck-primary-hover);
  text-decoration: underline;
}

.cp__card-why {
  display: block;
  margin-top: 2px;
  color: var(--ck-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

/* ── F2: descartes ── */
.cp__discard {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--ck-border);
}

.cp__discard-badge {
  font-size: 11.5px;
  color: var(--ck-text-muted);
  font-style: italic;
}

.cp__discard-btn {
  border: 1px solid var(--ck-border);
  background: var(--ck-surface);
  color: var(--ck-text-muted);
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 11.5px;
  cursor: pointer;
}

.cp__discard-btn:hover:not(:disabled) {
  color: var(--ck-text);
  background: var(--ck-surface-hover);
}

.cp__discard-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.cp__discard-btn--ghost {
  border-color: transparent;
  background: transparent;
}

.cp__discard-input {
  flex: 1 1 160px;
  min-width: 120px;
  border: 1px solid var(--ck-border);
  border-radius: 5px;
  background: var(--ck-bg);
  color: var(--ck-text);
  padding: 3px 7px;
  font-size: 11.5px;
}

.cp__discard-error {
  color: var(--ck-danger);
  font-size: 11px;
  flex-basis: 100%;
}

</style>
