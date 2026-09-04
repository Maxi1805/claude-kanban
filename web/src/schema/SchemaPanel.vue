<script setup lang="ts">
/**
 * Per-task schema diagram.
 *
 * Renders the structure the task's worktrees DECLARE IN THEIR FILES as an ER
 * diagram, with everything this task added or changed highlighted against the
 * repo's base branch. No database is involved: a table an agent wrote a minute
 * ago appears here whether or not a migration ever ran.
 *
 * Nothing here knows about any particular stack. Each repo's schema comes from
 * an extractor script that a Claude Code agent wrote for that repo after
 * reading its code — so a repo starts empty, with a button to generate one.
 *
 * It re-reads on an interval while visible, so the diagram keeps up with the
 * agent as it works; the SVG is only re-rendered when the payload actually
 * changed, so a quiet poll costs nothing visually.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "@/api/client";
import type { SchemaEntity, TaskSchemaRepo, TaskSchemaResponse } from "@/types";
import {
  applyHighlights,
  buildDiagram,
  relationKey,
  type DiagramDefinition,
} from "./mermaid-er";
import { groupSchema } from "./grouping";

const props = defineProps<{ taskId: string; active: boolean }>();

/**
 * How often the declared schema is re-read while the tab is open. Each poll
 * runs the repo's extractor, so this is deliberately not instant.
 */
const POLL_MS = 8000;

const response = ref<TaskSchemaResponse | null>(null);
const selectedRepo = ref<string | null>(null);
const onlyChanged = ref(false);
/** Draw tables inside a box per theme (switches Mermaid grammar). */
const grouped = ref(false);
/** Show a single theme, or all of them. */
const activeGroupId = ref<string | null>(null);
/**
 * Columns are remembered PER VIEW, because the two answer different questions:
 * the ER view is for reading a table in detail, the grouped view is a map of
 * the themes. Showing every column there makes the diagram ~2.6x taller for no
 * gain, so it starts off — and whatever the user picks in each view sticks.
 */
const showFieldsEr = ref(true);
const showFieldsGrouped = ref(false);
const showFields = computed({
  get: () => (grouped.value ? showFieldsGrouped.value : showFieldsEr.value),
  set: (value: boolean) => {
    if (grouped.value) showFieldsGrouped.value = value;
    else showFieldsEr.value = value;
  },
});
const zoom = ref(1);
const error = ref<string | null>(null);
const loading = ref(false);
const selectedEntity = ref<SchemaEntity | null>(null);
const lastUpdated = ref<string | null>(null);

const diagramEl = ref<HTMLElement | null>(null);
let pollTimer: number | null = null;
/** Serialized last payload, to skip redundant re-renders. */
let lastPayload = "";
let renderSeq = 0;

const repo = computed<TaskSchemaRepo | null>(() => {
  const repos = response.value?.repos ?? [];
  return repos.find((r) => r.repoName === selectedRepo.value) ?? repos[0] ?? null;
});

const graph = computed(() => repo.value?.graph ?? null);
const diff = computed(() => repo.value?.diff);

/** Every repo of the task is selectable — one may still need its extractor. */
const allRepos = computed(() => response.value?.repos ?? []);

/* ── Extractor generation ─────────────────────────────────────────────── */

/**
 * Whether an agent is writing this repo's extractor. The server runs that as a
 * background job — it can take many minutes — so the truth comes from polling
 * `script.generating`, not from awaiting the POST.
 */
const generating = computed(() => repo.value?.script.generating === true);
const generateError = ref<string | null>(null);

/**
 * How long the running generation has been going. Driven by `nowTick` because
 * the polled payload does not change while it runs, so nothing else would make
 * this recompute.
 */
const nowTick = ref(Date.now());
const generatingFor = computed(() => {
  const since = repo.value?.script.generatingSince;
  if (!since) return "";
  const seconds = Math.max(0, Math.round((nowTick.value - Date.parse(since)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)} min`;
});

async function generate(): Promise<void> {
  const target = repo.value;
  if (!target || generating.value) return;
  generateError.value = null;
  try {
    await api.generateSchemaScript(props.taskId, target.repoName);
    // Reflect the "generating" state at once; the poll takes it from here and
    // will pick up the finished extractor by itself.
    lastPayload = "";
    await load();
  } catch (err) {
    generateError.value = err instanceof Error ? err.message : String(err);
  }
}

async function regenerate(): Promise<void> {
  if (
    !window.confirm(
      "Se va a reescribir el script de extracción de este repo. ¿Continuar?",
    )
  ) {
    return;
  }
  await generate();
}

/**
 * Themes, derived from the foreign-key graph itself. Deliberately computed
 * here and not read from the extractor: the script only reports raw structure,
 * so a table added tomorrow is grouped without regenerating anything.
 */
const grouping = computed(() => (graph.value ? groupSchema(graph.value) : null));

const definition = computed<DiagramDefinition | null>(() =>
  graph.value
    ? buildDiagram(graph.value, diff.value, {
        showFields: showFields.value,
        onlyChanged: onlyChanged.value,
        grouped: grouped.value,
        groupByTable: grouping.value?.byTable,
        onlyGroupId: activeGroupId.value,
      })
    : null,
);

/** The theme a table belongs to, for the detail panel. */
function groupOf(table: string): string | null {
  return grouping.value?.byTable.get(table)?.name ?? null;
}

/** Counts for the summary line. */
const summary = computed(() => {
  const d = diff.value;
  const values = <T,>(rec: Record<string, T> | undefined): T[] =>
    Object.values(rec ?? {});
  return {
    entities: graph.value?.entities.length ?? 0,
    relations: graph.value?.relations.length ?? 0,
    added: values(d?.entities).filter((v) => v === "added").length,
    changed: values(d?.entities).filter((v) => v === "changed").length,
    removed: values(d?.entities).filter((v) => v === "removed").length,
    newRelations: values(d?.relations).filter((v) => v === "added").length,
    pending: graph.value?.entities.filter((e) => e.pending).length ?? 0,
  };
});

/** Entities/relations dropped in this task — shown as text, not drawn. */
const removedItems = computed(() => {
  const d = diff.value;
  if (!d) return [] as string[];
  const out: string[] = [];
  for (const [name, change] of Object.entries(d.entities)) {
    if (change === "removed") out.push(`tabla ${name}`);
  }
  for (const [key, change] of Object.entries(d.relations)) {
    if (change === "removed") out.push(`relación ${key}`);
  }
  for (const [key, change] of Object.entries(d.fields)) {
    // Columns of a dropped table are already covered by the table entry.
    const table = key.slice(0, key.lastIndexOf("."));
    if (change === "removed" && d.entities[table] !== "removed") {
      out.push(`columna ${key}`);
    }
  }
  return out;
});

/* ── Data ─────────────────────────────────────────────────────────────── */

async function load(): Promise<void> {
  try {
    const next = await api.taskSchema(props.taskId);
    error.value = null;
    const serialized = JSON.stringify(next);
    if (serialized === lastPayload) return; // nothing moved — keep the SVG
    lastPayload = serialized;
    response.value = next;
    lastUpdated.value = new Date().toLocaleTimeString();
    if (
      selectedRepo.value === null ||
      !next.repos.some((r) => r.repoName === selectedRepo.value)
    ) {
      selectedRepo.value =
        next.repos.find((r) => r.graph !== null)?.repoName ??
        next.repos[0]?.repoName ??
        null;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function refreshNow(): Promise<void> {
  loading.value = true;
  lastPayload = ""; // force a re-render even if unchanged
  await load();
  loading.value = false;
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    nowTick.value = Date.now();
    if (props.active && document.visibilityState === "visible") void load();
  }, POLL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ── Rendering ────────────────────────────────────────────────────────── */

async function renderDiagram(): Promise<void> {
  const el = diagramEl.value;
  const def = definition.value;
  if (!el) return;
  // Mermaid measures rendered text, so it needs a laid-out container — and it
  // is a large module we would rather not load for a tab nobody opened. Both
  // are handled by deferring until the tab is actually visible; the `active`
  // watcher below renders on open.
  if (!props.active) return;
  if (!def || def.empty) {
    el.innerHTML = "";
    return;
  }

  const seq = ++renderSeq;
  const graphId = `ck-er-${seq}`;
  try {
    // Loaded on demand: Mermaid is large and only this tab needs it.
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      // Render at natural size in BOTH grammars and let the pane scroll. With
      // Mermaid's default the SVG is scaled to fit the container, and a large
      // schema lands around 0.17x — enough to round hairline relations away to
      // nothing, so short intra-cluster edges vanish while long ones survive.
      // Zooming is the toolbar's job, not the renderer's.
      er: { useMaxWidth: false },
      class: { useMaxWidth: false },
    });
    const { svg } = await mermaid.render(graphId, def.code);
    if (seq !== renderSeq || !diagramEl.value) return; // superseded
    diagramEl.value.innerHTML = svg;
    const svgEl = diagramEl.value.querySelector("svg");
    if (svgEl) {
      applyHighlights(svgEl as SVGElement, def, graphId);
      bindEntityClicks(svgEl as SVGElement, def, graphId);
    }
  } catch (err) {
    error.value = `No se pudo dibujar el diagrama: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Clicking a table opens its column detail. */
function bindEntityClicks(
  svg: SVGElement,
  def: DiagramDefinition,
  graphId: string,
): void {
  for (const node of Array.from(svg.querySelectorAll<SVGGElement>("g.node"))) {
    const prefix = `${graphId}-entity-`;
    if (!node.id.startsWith(prefix)) continue;
    const rendered = node.id.slice(prefix.length).replace(/-\d+$/, "");
    const original = def.originalNames.get(rendered) ?? rendered;
    node.style.cursor = "pointer";
    node.addEventListener("click", () => {
      selectedEntity.value =
        graph.value?.entities.find((e) => e.name === original) ?? null;
    });
  }
}

/** Change of the field/table an entity's row shows in the detail panel. */
function fieldChange(entityName: string, fieldName: string): string | null {
  return diff.value?.fields[`${entityName}.${fieldName}`] ?? null;
}

function outgoingRelations(entityName: string) {
  return (graph.value?.relations ?? []).filter((r) => r.from === entityName);
}

function incomingRelations(entityName: string) {
  return (graph.value?.relations ?? []).filter((r) => r.to === entityName);
}

function relationChange(r: Parameters<typeof relationKey>[0]): string | null {
  return diff.value?.relations[relationKey(r)] ?? null;
}

/* ── Lifecycle ────────────────────────────────────────────────────────── */

onMounted(() => {
  void refreshNow();
  startPolling();
});

onBeforeUnmount(stopPolling);

watch(definition, () => void renderDiagram());

// Opening the tab re-reads (so it never shows stale content) and draws — the
// first draw of the session happens here, not on mount.
watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    await load();
    await renderDiagram();
  },
);
</script>

<template>
  <section class="sch">
    <header class="sch__bar">
      <select
        v-if="allRepos.length > 1"
        v-model="selectedRepo"
        class="sch__select"
        aria-label="Repositorio"
      >
        <option v-for="r in allRepos" :key="r.repoName" :value="r.repoName">
          {{ r.repoName }}{{ r.script.exists ? "" : " · sin script" }}
        </option>
      </select>
      <span v-else-if="repo" class="sch__repo">{{ repo.repoName }}</span>

      <label class="sch__toggle">
        <input v-model="onlyChanged" type="checkbox" />
        Solo cambios
      </label>
      <label class="sch__toggle">
        <input v-model="showFields" type="checkbox" />
        Columnas
      </label>
      <label class="sch__toggle" title="Agrupar las tablas en cajas por tema">
        <input v-model="grouped" type="checkbox" />
        Agrupado
      </label>

      <select
        v-if="grouping && grouping.groups.length > 1"
        v-model="activeGroupId"
        class="sch__select"
        aria-label="Tema"
      >
        <option :value="null">Todos los temas</option>
        <option v-for="g in grouping.groups" :key="g.id" :value="g.id">
          {{ g.name }} ({{ g.tables.length }})
        </option>
      </select>

      <div class="sch__zoom">
        <button type="button" title="Alejar" @click="zoom = Math.max(0.3, zoom - 0.15)">
          −
        </button>
        <button type="button" title="Tamaño original" @click="zoom = 1">
          {{ Math.round(zoom * 100) }}%
        </button>
        <button type="button" title="Acercar" @click="zoom = Math.min(3, zoom + 0.15)">
          +
        </button>
      </div>

      <span class="sch__spacer" />
      <button
        v-if="repo?.script.exists"
        class="sch__regen"
        type="button"
        :disabled="generating"
        :title="
          'Script: ' +
          repo.script.path +
          (repo.script.generatedAt ? ' · generado ' + repo.script.generatedAt : '')
        "
        @click="regenerate"
      >
        {{ generating ? `Generando… ${generatingFor}` : "Regenerar script" }}
      </button>
      <span v-if="lastUpdated" class="sch__updated">actualizado {{ lastUpdated }}</span>
      <button class="sch__refresh" type="button" :disabled="loading" @click="refreshNow">
        ⟳
      </button>
    </header>

    <p v-if="error" class="sch__error">{{ error }}</p>
    <p v-if="generateError" class="sch__error">{{ generateError }}</p>
    <p v-else-if="repo?.script.lastError" class="sch__error">
      La última generación falló: {{ repo.script.lastError }}
    </p>
    <p v-else-if="repo?.error" class="sch__error">
      El script de extracción falló: {{ repo.error }}
    </p>
    <ul v-if="repo?.warnings?.length" class="sch__warnings">
      <li v-for="w in repo.warnings.slice(0, 5)" :key="w">{{ w }}</li>
    </ul>

    <div v-if="graph" class="sch__summary">
      <span>{{ summary.entities }} tablas · {{ summary.relations }} relaciones</span>
      <span v-if="summary.added" class="sch__chip sch__chip--added">
        +{{ summary.added }} tabla{{ summary.added === 1 ? "" : "s" }}
      </span>
      <span v-if="summary.newRelations" class="sch__chip sch__chip--added">
        +{{ summary.newRelations }} relaci{{ summary.newRelations === 1 ? "ón" : "ones" }}
      </span>
      <span v-if="summary.changed" class="sch__chip sch__chip--changed">
        {{ summary.changed }} modificada{{ summary.changed === 1 ? "" : "s" }}
      </span>
      <span v-if="summary.pending" class="sch__chip sch__chip--pending">
        {{ summary.pending }} sin migrar
      </span>
      <span v-if="diff?.baseBranch" class="sch__base">vs {{ diff.baseBranch }}</span>
      <span v-else-if="diff?.unavailableReason" class="sch__base" :title="diff.unavailableReason">
        sin comparación
      </span>
      <span v-if="graph.dialect" class="sch__base">{{ graph.dialect }}</span>
      <span
        v-if="graph.sourceFiles.length"
        class="sch__sources"
        :title="graph.sourceFiles.join('\n')"
      >
        {{ graph.sourceFiles[0] }}
        <template v-if="graph.sourceFiles.length > 1">
          +{{ graph.sourceFiles.length - 1 }}
        </template>
      </span>
    </div>

    <div class="sch__body">
      <div class="sch__canvas">
        <div
          v-show="definition && !definition.empty"
          ref="diagramEl"
          class="sch__diagram"
          :style="{ transform: `scale(${zoom})` }"
        />

        <p v-if="!response" class="sch__empty">Leyendo el esquema…</p>

        <!-- No extractor yet: this is where a repo starts. -->
        <div v-else-if="repo && !repo.script.exists" class="sch__onboard">
          <h3>Todavía no hay script de extracción para «{{ repo.repoName }}»</h3>
          <p>
            Un agente de Claude Code va a leer el código de este repo y escribir un
            script que extraiga el esquema que declaran sus archivos: modelos,
            migraciones, <code>schema.prisma</code>, SQL, lo que use el proyecto.
            Así el diagrama no depende de ninguna arquitectura en particular.
          </p>
          <p class="sch__onboard-note">
            El script queda guardado en los datos del board (no toca tu repo) y lo
            reusan todas las tareas de este repo. Se ejecuta localmente cada vez que
            se refresca el diagrama, y solo lee archivos.
          </p>
          <button
            class="sch__generate"
            type="button"
            :disabled="generating"
            @click="generate"
          >
            {{ generating ? `Generando… (${generatingFor})` : "Generar script" }}
          </button>
          <p v-if="generating" class="sch__onboard-note">
            El agente está explorando el repositorio y probando el script. Corre en
            segundo plano: podés cerrar esta pestaña o seguir usando el terminal, y
            el diagrama aparece solo cuando termine.
          </p>
        </div>

        <p v-else-if="!graph && !repo?.error" class="sch__empty">
          El script no devolvió ningún esquema.
        </p>
        <p v-else-if="definition?.empty" class="sch__empty">
          {{
            onlyChanged
              ? "Esta tarea todavía no cambió el esquema."
              : "El esquema no declara ninguna tabla."
          }}
        </p>
        <p v-else-if="definition && definition.hiddenEntities > 0" class="sch__hidden">
          {{ definition.hiddenEntities }} tabla{{
            definition.hiddenEntities === 1 ? "" : "s"
          }}
          sin cambios oculta{{ definition.hiddenEntities === 1 ? "" : "s" }}.
        </p>

        <ul v-if="removedItems.length" class="sch__removed">
          <li v-for="item in removedItems" :key="item">Eliminado: {{ item }}</li>
        </ul>
      </div>

      <aside v-if="selectedEntity" class="sch__detail">
        <header class="sch__detail-head">
          <h3>{{ selectedEntity.name }}</h3>
          <button type="button" @click="selectedEntity = null">✕</button>
        </header>
        <p class="sch__detail-src">
          {{ selectedEntity.sourceFile }}:{{ selectedEntity.sourceLine }}
        </p>
        <p v-if="groupOf(selectedEntity.name)" class="sch__detail-group">
          Tema: {{ groupOf(selectedEntity.name) }}
          <span v-if="grouping?.hubs.has(selectedEntity.name)" title="Conectada con casi todo el esquema">
            · tabla central
          </span>
        </p>
        <table class="sch__fields">
          <tbody>
            <tr
              v-for="f in selectedEntity.fields"
              :key="f.name"
              :class="`sch__f--${fieldChange(selectedEntity.name, f.name) ?? ''}`"
            >
              <td>
                {{ f.name }}
                <span v-if="f.primaryKey" class="sch__key">PK</span>
              </td>
              <td class="sch__type">{{ f.type }}{{ f.nullable ? "" : " !" }}</td>
              <td class="sch__flag">
                <template v-if="fieldChange(selectedEntity.name, f.name) === 'added'">
                  nuevo
                </template>
                <template v-else-if="fieldChange(selectedEntity.name, f.name) === 'changed'">
                  modificado
                </template>
                <template v-else-if="f.pending">sin migrar</template>
              </td>
            </tr>
          </tbody>
        </table>

        <h4 class="sch__detail-sub">Apunta a (padres)</h4>
        <ul class="sch__rel">
          <li
            v-for="r in outgoingRelations(selectedEntity.name)"
            :key="relationKey(r)"
            :class="`sch__f--${relationChange(r) ?? ''}`"
          >
            {{ r.fromField }} → {{ r.to }}
            <span v-if="r.onDelete" class="sch__ondelete">on delete {{ r.onDelete }}</span>
          </li>
          <li v-if="outgoingRelations(selectedEntity.name).length === 0" class="sch__none">
            ninguno
          </li>
        </ul>

        <h4 class="sch__detail-sub">Referenciada por (hijos)</h4>
        <ul class="sch__rel">
          <li
            v-for="r in incomingRelations(selectedEntity.name)"
            :key="relationKey(r)"
            :class="`sch__f--${relationChange(r) ?? ''}`"
          >
            {{ r.from }}.{{ r.fromField }}
          </li>
          <li v-if="incomingRelations(selectedEntity.name).length === 0" class="sch__none">
            ninguno
          </li>
        </ul>
      </aside>
    </div>

    <footer class="sch__legend">
      <span class="sch__chip sch__chip--added">nuevo</span>
      <span class="sch__chip sch__chip--changed">modificado</span>
      <span class="sch__chip sch__chip--pending">sin migrar</span>
      <span class="sch__legend-note">
        La flecha va del hijo (tiene la foreign key) al padre. Clic en una tabla para ver
        sus columnas.
        <template v-if="grouped">
          Los temas se calculan solos a partir de las relaciones; la vista agrupada no
          dibuja la cardinalidad.
        </template>
      </span>
    </footer>
  </section>
</template>

<style scoped>
.sch {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--ck-bg);
}

/* ── Toolbar ── */
.sch__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ck-border);
  background: var(--ck-surface);
  flex-wrap: wrap;
}

.sch__select {
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-radius: 6px;
  color: var(--ck-text);
  padding: 4px 8px;
}

.sch__repo {
  font-weight: 600;
  font-size: 13px;
}

.sch__toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ck-text-muted);
  cursor: pointer;
}

.sch__zoom {
  display: inline-flex;
  gap: 2px;
}

.sch__zoom button,
.sch__refresh {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 12px;
}

.sch__zoom button:hover,
.sch__refresh:hover:not(:disabled) {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.sch__spacer {
  flex: 1;
}

.sch__updated {
  font-size: 11px;
  color: var(--ck-text-faint);
}

.sch__error {
  margin: 8px 12px 0;
  color: var(--ck-danger);
  font-size: 12.5px;
}

.sch__warnings {
  margin: 6px 12px 0;
  padding-left: 20px;
  color: var(--ck-status-review);
  font-size: 11.5px;
}

.sch__regen {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
}

.sch__regen:hover:not(:disabled) {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.sch__regen:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ── First-run panel (no extractor yet) ── */
.sch__onboard {
  max-width: 560px;
  margin: 28px auto;
  padding: 20px 22px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
}

.sch__onboard h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.sch__onboard p {
  margin: 0 0 10px;
  color: var(--ck-text-muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.sch__onboard-note {
  color: var(--ck-text-faint) !important;
  font-size: 11.5px !important;
}

.sch__onboard code {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 11.5px;
  color: var(--ck-text);
}

.sch__generate {
  margin-top: 4px;
  border: 1px solid transparent;
  background: var(--ck-primary);
  color: #fff;
  border-radius: var(--ck-radius);
  padding: 8px 16px;
  font-weight: 600;
  font-size: 13px;
}

.sch__generate:hover:not(:disabled) {
  background: var(--ck-primary-hover);
}

.sch__generate:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ── Summary ── */
.sch__summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--ck-text-muted);
  border-bottom: 1px solid var(--ck-border);
}

.sch__chip {
  padding: 1px 8px;
  border-radius: 10px;
  border: 1px solid var(--ck-border);
  font-size: 11px;
}

.sch__chip--added {
  color: var(--ck-status-done);
  border-color: rgba(77, 171, 154, 0.45);
  background: rgba(77, 171, 154, 0.12);
}

.sch__chip--changed {
  color: var(--ck-status-review);
  border-color: rgba(255, 163, 68, 0.45);
  background: rgba(255, 163, 68, 0.12);
}

.sch__chip--pending {
  color: var(--ck-primary);
  border-color: rgba(35, 131, 226, 0.45);
  background: rgba(35, 131, 226, 0.12);
}

.sch__base,
.sch__sources {
  font-size: 11px;
  color: var(--ck-text-faint);
}

.sch__sources {
  margin-left: auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Body ── */
.sch__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.sch__canvas {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 14px;
}

.sch__diagram {
  transform-origin: top left;
  transition: transform 0.1s ease-out;
}

.sch__empty,
.sch__hidden {
  color: var(--ck-text-faint);
  font-size: 12.5px;
}

.sch__hidden {
  margin-top: 12px;
}

.sch__removed {
  margin: 14px 0 0;
  padding-left: 18px;
  color: var(--ck-danger);
  font-size: 12px;
}

/* ── Detail panel ── */
.sch__detail {
  width: 290px;
  flex-shrink: 0;
  border-left: 1px solid var(--ck-border);
  background: var(--ck-surface);
  padding: 10px 12px;
  overflow-y: auto;
  font-size: 12px;
}

.sch__detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sch__detail-head h3 {
  margin: 0;
  font-size: 13px;
}

.sch__detail-head button {
  border: none;
  background: transparent;
  color: var(--ck-text-faint);
  font-size: 13px;
}

.sch__detail-src {
  margin: 2px 0 10px;
  font-size: 11px;
  color: var(--ck-text-faint);
  word-break: break-all;
}

.sch__detail-group {
  margin: -6px 0 10px;
  font-size: 11px;
  color: var(--ck-primary);
}

.sch__detail-sub {
  margin: 14px 0 5px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ck-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.sch__fields {
  width: 100%;
  border-collapse: collapse;
}

.sch__fields td {
  padding: 3px 6px 3px 0;
  border-bottom: 1px solid var(--ck-border);
  color: var(--ck-text-muted);
}

.sch__type {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--ck-text-faint);
}

.sch__flag {
  font-size: 10px;
  color: var(--ck-text-faint);
  text-align: right;
}

.sch__key {
  font-size: 9px;
  color: var(--ck-status-review);
  margin-left: 4px;
}

.sch__rel {
  margin: 0;
  padding-left: 16px;
  color: var(--ck-text-muted);
}

.sch__rel li {
  padding: 2px 0;
}

.sch__ondelete {
  color: var(--ck-text-faint);
  font-size: 10px;
}

.sch__none {
  list-style: none;
  margin-left: -16px;
  color: var(--ck-text-faint);
}

/* Change tinting shared by the field rows and relation lists. */
.sch__f--added {
  color: var(--ck-status-done);
}

.sch__f--changed {
  color: var(--ck-status-review);
}

.sch__f--removed {
  color: var(--ck-danger);
  text-decoration: line-through;
}

/* ── Legend ── */
.sch__legend {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--ck-border);
  background: var(--ck-surface);
  flex-wrap: wrap;
}

.sch__legend-note {
  font-size: 11px;
  color: var(--ck-text-faint);
}
</style>

<style>
/* Highlight classes are added to Mermaid's own SVG, so they cannot be scoped. */

/* The theme boxes should group WITHOUT competing with the tables: no fill and a
   barely-there outline, so everything still reads as one plane and the name
   carries the signal. */
.sch__diagram .cluster rect {
  /* Deliberately faint: the theme should be a hint, so everything still reads
     as one plane instead of every table gaining a second frame. */
  fill: transparent !important;
  stroke: rgba(255, 255, 255, 0.08) !important;
  stroke-width: 1px !important;
  stroke-dasharray: none !important;
  rx: 10px;
  ry: 10px;
}

.sch__diagram .cluster-label,
.sch__diagram .cluster-label p,
.sch__diagram .cluster text {
  fill: var(--ck-text-faint) !important;
  color: var(--ck-text-faint) !important;
  font-weight: 600 !important;
  font-size: 11px !important;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Relations are the point of the diagram; keep them legible when zoomed out. */
.sch__diagram path.relation,
.sch__diagram path.relationshipLine {
  stroke-width: 1.6px !important;
}

.sch__diagram .ck-er--added rect,
.sch__diagram .ck-er--added .outer-path {
  stroke: #4dab9a !important;
  stroke-width: 2.5px !important;
}

.sch__diagram .ck-er--changed rect,
.sch__diagram .ck-er--changed .outer-path {
  stroke: #ffa344 !important;
  stroke-width: 2.5px !important;
}

.sch__diagram .ck-er--pending rect,
.sch__diagram .ck-er--pending .outer-path {
  stroke: #2383e2 !important;
  stroke-width: 2.5px !important;
  stroke-dasharray: 5 3 !important;
}

.sch__diagram path.relationshipLine.ck-er--added {
  stroke: #4dab9a !important;
  stroke-width: 2.5px !important;
}

.sch__diagram path.relationshipLine.ck-er--changed {
  stroke: #ffa344 !important;
  stroke-width: 2.5px !important;
}

.sch__diagram path.relationshipLine.ck-er--pending {
  stroke: #2383e2 !important;
  stroke-width: 2.5px !important;
  stroke-dasharray: 5 3 !important;
}
</style>
