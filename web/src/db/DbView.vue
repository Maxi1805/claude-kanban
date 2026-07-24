<script setup lang="ts">
/**
 * Live database viewer (/db).
 *
 * Read-only window onto the app's own sqlite database that stays LIVE: the
 * server watches the db file (PRAGMA data_version on a separate read-only
 * connection) and broadcasts `db:changed` on /ws/events; this view refetches on
 * every ping, so rows appear/update in real time while you use the board (or
 * while anything external writes the file). Rows that changed between two
 * refreshes flash briefly so mutations are easy to spot.
 *
 * Nothing here assumes a schema — tables, columns, PKs and FKs all come from
 * the generic /api/db introspection, so this view survives schema changes.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api, eventsWsUrl } from "@/api/client";
import type {
  DbOverviewResponse,
  DbTableInfo,
  DbTableRowsResponse,
} from "@/types";

const PAGE_SIZE = 200;
/** How long a changed row stays highlighted (ms). */
const FLASH_MS = 1800;
/** Collapse a burst of db:changed pings into one refresh (ms). */
const REFRESH_DEBOUNCE_MS = 200;

const overview = ref<DbOverviewResponse | null>(null);
const selected = ref<string | null>(null);
const page = ref<DbTableRowsResponse | null>(null);
const filter = ref("");
const showSchema = ref(false);
const error = ref<string | null>(null);
const wsConnected = ref(false);
/** Row keys (PK-derived) that changed in the latest refresh — flashed. */
const changedKeys = ref<Set<string>>(new Set());
/** ISO time of the last observed change, for the header. */
const lastChangeAt = ref<string | null>(null);

let socket: WebSocket | null = null;
let refreshTimer: number | null = null;
let flashTimer: number | null = null;
let disposed = false;

/** Previous page snapshot (key → serialized row) used to diff refreshes. */
let prevRowsByKey: Map<string, string> | null = null;
let prevSnapshotTable: string | null = null;

const selectedInfo = computed<DbTableInfo | null>(
  () => overview.value?.tables.find((t) => t.name === selected.value) ?? null,
);

/** FK lookup for the selected table: column name → "table.column". */
const fkByColumn = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const fk of selectedInfo.value?.foreignKeys ?? []) {
    map[fk.from] = `${fk.toTable}.${fk.toColumn ?? "id"}`;
  }
  return map;
});

/** Indices (into page.columns) of the selected table's PK columns. */
const pkIndices = computed<number[]>(() => {
  const cols = page.value?.columns ?? [];
  const pkNames = new Set(
    (selectedInfo.value?.columns ?? [])
      .filter((c) => c.primaryKey)
      .map((c) => c.name),
  );
  const idx = cols.flatMap((name, i) => (pkNames.has(name) ? [i] : []));
  return idx;
});

/** Current-page rows filtered client-side by the quick-filter text. */
const visibleRows = computed(() => {
  const rows = page.value?.rows ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.some((cell) => cell !== null && String(cell).toLowerCase().includes(q)),
  );
});

/** Stable identity of one row, for diff highlighting across refreshes. */
function rowKey(row: (string | number | null)[]): string {
  const idx = pkIndices.value;
  const parts = idx.length > 0 ? idx.map((i) => row[i]) : row;
  return JSON.stringify(parts);
}

async function fetchOverview(): Promise<void> {
  overview.value = await api.dbOverview();
  if (
    selected.value === null ||
    !overview.value.tables.some((t) => t.name === selected.value)
  ) {
    selected.value = overview.value.tables[0]?.name ?? null;
  }
}

async function fetchRows(offset = 0): Promise<void> {
  if (!selected.value) {
    page.value = null;
    return;
  }
  page.value = await api.dbTableRows(selected.value, {
    limit: PAGE_SIZE,
    offset,
  });
}

/** Full refresh (overview + current page), diffing rows for the flash. */
async function refresh(): Promise<void> {
  try {
    await fetchOverview();
    const keepOffset =
      page.value && page.value.table === selected.value
        ? page.value.offset
        : 0;
    await fetchRows(keepOffset);
    error.value = null;
    diffAndFlash();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Mark rows that are new/changed since the previous snapshot of this table. */
function diffAndFlash(): void {
  const current = new Map<string, string>();
  for (const row of page.value?.rows ?? []) {
    current.set(rowKey(row), JSON.stringify(row));
  }

  // Only diff consecutive snapshots of the SAME table (not a table switch).
  if (prevRowsByKey && prevSnapshotTable === selected.value) {
    const changed = new Set<string>();
    for (const [key, serialized] of current) {
      if (prevRowsByKey.get(key) !== serialized) changed.add(key);
    }
    if (changed.size > 0) {
      changedKeys.value = changed;
      lastChangeAt.value = new Date().toLocaleTimeString();
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        changedKeys.value = new Set();
        flashTimer = null;
      }, FLASH_MS);
    }
  }

  prevRowsByKey = current;
  prevSnapshotTable = selected.value;
}

async function selectTable(name: string): Promise<void> {
  if (selected.value === name) return;
  selected.value = name;
  filter.value = "";
  prevRowsByKey = null;
  prevSnapshotTable = null;
  changedKeys.value = new Set();
  try {
    await fetchRows(0);
    error.value = null;
    diffAndFlash();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function goToOffset(offset: number): Promise<void> {
  try {
    await fetchRows(offset);
    error.value = null;
    diffAndFlash();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Debounced refresh: a burst of commits triggers one refetch. */
function scheduleRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

/* ── Live socket (own subscription to /ws/events) ─────────────────────── */

function connect(): void {
  if (disposed) return;
  const ws = new WebSocket(eventsWsUrl());
  socket = ws;

  ws.onopen = () => {
    wsConnected.value = true;
    // Catch up on anything missed while disconnected.
    scheduleRefresh();
  };

  ws.onmessage = (ev: MessageEvent<string>) => {
    try {
      const msg: unknown = JSON.parse(ev.data);
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: unknown }).type === "db:changed"
      ) {
        scheduleRefresh();
      }
    } catch {
      /* non-JSON frame — ignore */
    }
  };

  ws.onclose = () => {
    wsConnected.value = false;
    if (socket === ws) {
      socket = null;
      if (!disposed) window.setTimeout(connect, 2000);
    }
  };

  ws.onerror = () => ws.close();
}

onMounted(() => {
  void refresh();
  connect();
});

onBeforeUnmount(() => {
  disposed = true;
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  if (flashTimer !== null) window.clearTimeout(flashTimer);
  socket?.close();
});

/* ── Cell presentation ────────────────────────────────────────────────── */

const CELL_MAX = 160;

function cellText(cell: string | number | null): string {
  if (cell === null) return "";
  const s = String(cell);
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s;
}

function cellTitle(cell: string | number | null): string | undefined {
  if (cell === null) return undefined;
  const s = String(cell);
  return s.length > CELL_MAX ? s : undefined;
}

const pagerText = computed(() => {
  const p = page.value;
  if (!p) return "";
  if (p.total === 0) return "0 filas";
  const from = p.offset + 1;
  const to = Math.min(p.offset + p.rows.length, p.total);
  return `${from}–${to} de ${p.total}`;
});
</script>

<template>
  <main class="dbv">
    <header class="dbv__bar">
      <RouterLink class="dbv__back" to="/">← Tablero</RouterLink>
      <h1 class="dbv__title">Base de datos</h1>
      <span
        class="dbv__live"
        :class="{ 'dbv__live--on': wsConnected }"
        :title="wsConnected ? 'Actualización en vivo activa' : 'Reconectando…'"
      >
        ● {{ wsConnected ? "en vivo" : "reconectando" }}
      </span>
      <span v-if="lastChangeAt" class="dbv__changed-at">
        último cambio {{ lastChangeAt }}
      </span>
      <span class="dbv__path" :title="overview?.path">{{ overview?.path }}</span>
      <button class="dbv__refresh" type="button" title="Refrescar" @click="refresh">
        ⟳
      </button>
    </header>

    <p v-if="error" class="dbv__error">{{ error }}</p>

    <div class="dbv__body">
      <aside class="dbv__tables">
        <button
          v-for="t in overview?.tables ?? []"
          :key="t.name"
          type="button"
          class="dbv__table-btn"
          :class="{ 'dbv__table-btn--active': t.name === selected }"
          @click="selectTable(t.name)"
        >
          <span class="dbv__table-name">{{ t.name }}</span>
          <span class="dbv__table-count">{{ t.rowCount }}</span>
        </button>
        <p v-if="overview && overview.tables.length === 0" class="dbv__empty">
          La base no tiene tablas.
        </p>
      </aside>

      <section class="dbv__main">
        <template v-if="selectedInfo && page">
          <div class="dbv__meta">
            <h2 class="dbv__table-title">{{ selectedInfo.name }}</h2>
            <input
              v-model="filter"
              class="dbv__filter"
              type="search"
              placeholder="Filtrar en esta página…"
            />
            <button
              class="dbv__schema-toggle"
              type="button"
              @click="showSchema = !showSchema"
            >
              {{ showSchema ? "Ocultar esquema" : "Esquema" }}
            </button>
          </div>

          <div v-if="showSchema" class="dbv__schema">
            <table class="dbv__schema-table">
              <thead>
                <tr>
                  <th>Columna</th>
                  <th>Tipo</th>
                  <th>Restricciones</th>
                  <th>Default</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in selectedInfo.columns" :key="c.name">
                  <td>{{ c.name }}</td>
                  <td class="dbv__type">{{ c.type || "—" }}</td>
                  <td>
                    <span v-if="c.primaryKey" class="dbv__badge dbv__badge--pk">PK</span>
                    <span v-if="c.notNull" class="dbv__badge">NOT NULL</span>
                    <span v-if="fkByColumn[c.name]" class="dbv__badge dbv__badge--fk">
                      FK → {{ fkByColumn[c.name] }}
                    </span>
                  </td>
                  <td class="dbv__type">{{ c.defaultValue ?? "—" }}</td>
                </tr>
              </tbody>
            </table>
            <pre v-if="selectedInfo.ddl" class="dbv__ddl">{{ selectedInfo.ddl }}</pre>
          </div>

          <div class="dbv__gridwrap">
            <table class="dbv__grid">
              <thead>
                <tr>
                  <th v-for="col in page.columns" :key="col">
                    {{ col }}
                    <span
                      v-if="pkIndices.includes(page.columns.indexOf(col))"
                      class="dbv__badge dbv__badge--pk"
                      >PK</span
                    >
                    <span
                      v-else-if="fkByColumn[col]"
                      class="dbv__badge dbv__badge--fk"
                      :title="'FK → ' + fkByColumn[col]"
                      >FK</span
                    >
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in visibleRows"
                  :key="rowKey(row)"
                  :class="{ 'dbv__row--changed': changedKeys.has(rowKey(row)) }"
                >
                  <td v-for="(cell, i) in row" :key="i">
                    <span v-if="cell === null" class="dbv__null">NULL</span>
                    <span v-else :title="cellTitle(cell)">{{ cellText(cell) }}</span>
                  </td>
                </tr>
                <tr v-if="visibleRows.length === 0">
                  <td class="dbv__empty" :colspan="page.columns.length">
                    {{ filter ? "Sin coincidencias en esta página." : "Tabla vacía." }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <footer class="dbv__pager">
            <button
              type="button"
              class="dbv__pager-btn"
              :disabled="page.offset === 0"
              @click="goToOffset(Math.max(0, page.offset - page.limit))"
            >
              ‹
            </button>
            <span>{{ pagerText }}</span>
            <button
              type="button"
              class="dbv__pager-btn"
              :disabled="page.offset + page.limit >= page.total"
              @click="goToOffset(page.offset + page.limit)"
            >
              ›
            </button>
          </footer>
        </template>

        <p v-else-if="!error" class="dbv__empty">Cargando…</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.dbv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--ck-bg);
}

/* ── Header bar ── */
.dbv__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--ck-border);
  background: var(--ck-surface);
}

.dbv__back {
  color: var(--ck-text-muted);
  text-decoration: none;
  white-space: nowrap;
}

.dbv__back:hover {
  color: var(--ck-text);
}

.dbv__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
}

.dbv__live {
  font-size: 12px;
  color: var(--ck-text-faint);
  white-space: nowrap;
}

.dbv__live--on {
  color: var(--ck-status-done);
}

.dbv__changed-at {
  font-size: 12px;
  color: var(--ck-text-muted);
  white-space: nowrap;
}

.dbv__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* keep the filename end visible when it truncates */
  text-align: left;
  font-size: 12px;
  color: var(--ck-text-faint);
}

.dbv__refresh {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 14px;
}

.dbv__refresh:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.dbv__error {
  margin: 8px 16px 0;
  color: var(--ck-danger);
}

/* ── Two-pane body ── */
.dbv__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.dbv__tables {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--ck-border);
  background: var(--ck-surface);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dbv__table-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ck-text-muted);
  text-align: left;
  font-size: 13px;
}

.dbv__table-btn:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.dbv__table-btn--active {
  background: var(--ck-surface-2);
  color: var(--ck-text);
}

.dbv__table-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dbv__table-count {
  font-size: 11px;
  color: var(--ck-text-faint);
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-radius: 10px;
  padding: 0 7px;
}

/* ── Main pane ── */
.dbv__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  gap: 10px;
}

.dbv__meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dbv__table-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.dbv__filter {
  flex: 1;
  max-width: 320px;
  background: var(--ck-surface-2);
  border: 1px solid var(--ck-border);
  border-radius: 6px;
  color: var(--ck-text);
  padding: 5px 10px;
  outline: none;
}

.dbv__filter:focus {
  border-color: var(--ck-border-strong);
}

.dbv__schema-toggle {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
}

.dbv__schema-toggle:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

/* ── Schema panel ── */
.dbv__schema {
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  padding: 10px 12px;
  max-height: 40%;
  overflow: auto;
}

.dbv__schema-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.dbv__schema-table th,
.dbv__schema-table td {
  text-align: left;
  padding: 4px 10px 4px 0;
  border-bottom: 1px solid var(--ck-border);
  color: var(--ck-text-muted);
}

.dbv__schema-table th {
  color: var(--ck-text-faint);
  font-weight: 500;
}

.dbv__type {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 11px;
}

.dbv__ddl {
  margin: 10px 0 0;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--ck-text-faint);
  white-space: pre-wrap;
}

/* ── Data grid ── */
.dbv__gridwrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
}

.dbv__grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.dbv__grid th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ck-surface-2);
  color: var(--ck-text-muted);
  font-weight: 500;
  text-align: left;
  padding: 7px 12px;
  border-bottom: 1px solid var(--ck-border-strong);
  white-space: nowrap;
}

.dbv__grid td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--ck-border);
  color: var(--ck-text);
  white-space: nowrap;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dbv__grid tbody tr:hover {
  background: var(--ck-surface-hover);
}

/* Flash for rows that changed in the latest live refresh. */
.dbv__row--changed {
  animation: dbv-flash 1.8s ease-out;
}

@keyframes dbv-flash {
  0% {
    background: rgba(35, 131, 226, 0.35);
  }
  100% {
    background: transparent;
  }
}

.dbv__null {
  color: var(--ck-text-faint);
  font-style: italic;
}

.dbv__badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--ck-border);
  font-size: 10px;
  color: var(--ck-text-faint);
  vertical-align: 1px;
}

.dbv__badge--pk {
  color: var(--ck-status-review);
  border-color: rgba(255, 163, 68, 0.4);
}

.dbv__badge--fk {
  color: var(--ck-primary);
  border-color: rgba(35, 131, 226, 0.4);
}

/* ── Pager ── */
.dbv__pager {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: flex-end;
  color: var(--ck-text-muted);
  font-size: 12px;
}

.dbv__pager-btn {
  border: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-text-muted);
  border-radius: 6px;
  padding: 2px 12px;
}

.dbv__pager-btn:hover:not(:disabled) {
  background: var(--ck-surface-hover);
  color: var(--ck-text);
}

.dbv__pager-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.dbv__empty {
  color: var(--ck-text-faint);
  padding: 10px;
}
</style>
