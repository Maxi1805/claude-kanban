<script setup lang="ts">
/**
 * FolderBrowser — the single, reusable filesystem browser used both for
 * REGISTERING git repos and for picking a project's `.claude` / CLAUDE.md
 * config folder. It replaces the two cramped, ad-hoc inline browsers that
 * lived in CreateProjectModal / RepoPicker.
 *
 * Modes (prop `mode`):
 *   • "repos"  — surfaces git folders with a clear GIT badge and a primary
 *                "Elegir" action (emits `pick-repo`); a parent folder holding
 *                several repos offers a one-click "Agregar los N" (emits
 *                `pick-repos`).
 *   • "config" — any folder is selectable as the Claude config folder via
 *                "Usar esta carpeta" (emits `pick-folder`). It can now confirm
 *                a `.claude` dir AND a bare `CLAUDE.md` file is present, because
 *                listing includes files.
 *   • "file"   — FILES become first-class, SELECTABLE rows: clicking a file row
 *                emits `pick-file` with its absolute path (used to pick a
 *                specific `CLAUDE.md`). Folders still navigate in as usual.
 *
 * What makes it MUCH easier than before:
 *   • EDITABLE PATH BAR — type/paste an absolute path + Enter to jump there.
 *     Invalid/out-of-scope paths surface inline feedback, the listing is kept.
 *   • Clickable BREADCRUMB + an Up button.
 *   • FILTER box — live-filters the current folder's entries by name.
 *   • QUICK ACCESS chips — Home (from fsRoots) + RECENT folders/repos persisted
 *     in localStorage.
 *   • ROWS — folders are one clickable row that navigates IN; git rows show a
 *     GIT badge + an unambiguous primary "Elegir" / ✓ action to SELECT. FILES
 *     are shown greyed and non-navigable (orientation + spotting a CLAUDE.md).
 *
 * It only ever READS the filesystem (fsRoots / fsList / fsInspect) and emits
 * ready-to-use payloads; the host modal decides what to do with them.
 */
import { computed, onMounted, ref, watch } from "vue";
import { api } from "@/api/client";
import type { AddRepoDTO, FsEntry, FsRoot } from "@/types";

/* ──────────────────────────────────────────────────────────────────────────
 * Local view of an entry: the shared FsEntry gains a file discriminator from
 * the backend (per the shared contract). We read whichever shape lands —
 * `isFile`/`isDir` booleans or `kind: "file" | "dir"` — without depending on
 * the exact field, and never treat `.git`-flagged dirs as files.
 * ──────────────────────────────────────────────────────────────────────── */
type FsEntryExt = FsEntry & {
  isFile?: boolean;
  isDir?: boolean;
  kind?: "file" | "dir";
};

const props = withDefaults(
  defineProps<{
    /**
     * "repos"  → select git folders;
     * "config" → select any folder;
     * "file"   → select an individual file (emits `pick-file`).
     */
    mode: "repos" | "config" | "file";
    /** Seed the listing here on open; falls back to the first fs root. */
    initialPath?: string | null;
    /** Show a "Cerrar explorador" affordance (for hosts that toggle it open). */
    closable?: boolean;
  }>(),
  { initialPath: null, closable: false },
);

const emit = defineEmits<{
  /** repos mode: a single git repo was chosen (name/branch resolved). */
  (e: "pick-repo", repo: AddRepoDTO): void;
  /** repos mode: every git child of the current folder was chosen at once. */
  (e: "pick-repos", repos: AddRepoDTO[]): void;
  /** config mode: an absolute folder was chosen as the Claude config folder. */
  (e: "pick-folder", path: string): void;
  /** file mode: an absolute FILE was chosen (e.g. a specific CLAUDE.md). */
  (e: "pick-file", path: string): void;
  /** Host asked to close the (toggleable) browser. */
  (e: "close"): void;
}>();

const RECENTS_KEY = "ck.fsbrowser.recent";
const MAX_RECENTS = 6;

/* ── Browser state ──────────────────────────────────────────────────────── */
const currentPath = ref<string>("");
const parentPath = ref<string | null>(null);
const currentIsGitRepo = ref(false);
const entries = ref<FsEntryExt[]>([]);
const truncated = ref(false);

const loading = ref(false);
/** Error for the listing area (failed navigation). */
const error = ref<string | null>(null);
/** Inline feedback specifically for the editable path bar. */
const pathError = ref<string | null>(null);
const showHidden = ref(false);

/** The editable path bar's working value (decoupled from currentPath). */
const pathInput = ref<string>("");
/** Live name filter for the current folder. */
const filter = ref<string>("");

/** Quick-access roots (Home, etc.) + persisted recents. */
const roots = ref<FsRoot[]>([]);
const recents = ref<string[]>(loadRecents());

/* ── Repo-confirm panel (repos mode) ───────────────────────────────────── */
const confirm = ref<{ path: string; branches: string[] } | null>(null);
const confirmName = ref("");
const confirmBranch = ref("");
const inspecting = ref(false);
const addingMany = ref(false);

/* ──────────────────────────────────────────────────────────────────────────
 * Derived
 * ──────────────────────────────────────────────────────────────────────── */

function isFileEntry(e: FsEntryExt): boolean {
  if (e.isGitRepo) return false;
  if (typeof e.isFile === "boolean") return e.isFile;
  if (typeof e.isDir === "boolean") return !e.isDir;
  if (e.kind) return e.kind === "file";
  return false; // legacy backend (dirs only) → treat as folder
}

/** Folders first (git repos first within them), then files; alpha inside. */
const sortedEntries = computed<FsEntryExt[]>(() => {
  const base = showHidden.value
    ? entries.value
    : entries.value.filter((e) => !e.hidden);
  const q = filter.value.trim().toLowerCase();
  const filtered = q
    ? base.filter((e) => e.name.toLowerCase().includes(q))
    : base;
  return [...filtered].sort((a, b) => {
    const af = isFileEntry(a);
    const bf = isFileEntry(b);
    if (af !== bf) return af ? 1 : -1; // folders before files
    if (!af && a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
});

const hiddenCount = computed(() => entries.value.filter((e) => e.hidden).length);

/** Git children of the current folder, for the "Agregar los N" shortcut. */
const childGitRepos = computed<FsEntryExt[]>(() =>
  entries.value.filter((e) => e.isGitRepo),
);

/** A `.claude` dir present in the current folder (config-mode positive note). */
const hasDotClaude = computed(() =>
  entries.value.some((e) => e.name === ".claude" && !isFileEntry(e)),
);
/** A bare `CLAUDE.md` file present (now visible thanks to includeFiles). */
const hasClaudeMd = computed(() =>
  entries.value.some((e) => e.name === "CLAUDE.md" && isFileEntry(e)),
);

const crumbs = computed(() => {
  const path = currentPath.value;
  if (!path) return [] as Array<{ name: string; path: string }>;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  const out: Array<{ name: string; path: string }> = [];
  let acc = "";
  for (const part of parts) {
    acc = acc + sep + part;
    out.push({ name: part, path: acc });
  }
  return out;
});

const rootChips = computed(() =>
  roots.value.map((r) => ({ label: r.label, path: r.path })),
);

/* ──────────────────────────────────────────────────────────────────────────
 * Navigation
 * ──────────────────────────────────────────────────────────────────────── */

async function list(path?: string, opts?: { fromPathBar?: boolean }): Promise<void> {
  loading.value = true;
  error.value = null;
  pathError.value = null;
  confirm.value = null;
  try {
    const res = await api.fsList(path, { includeFiles: true });
    currentPath.value = res.path;
    parentPath.value = res.parent;
    currentIsGitRepo.value = res.isGitRepo;
    entries.value = res.entries as FsEntryExt[];
    truncated.value = res.truncated;
    pathInput.value = res.path;
    filter.value = "";
  } catch (err) {
    if (opts?.fromPathBar) {
      // Keep the current listing; surface inline feedback on the path bar.
      pathError.value = "ruta no válida o fuera del alcance";
    } else {
      error.value = (err as Error).message;
    }
  } finally {
    loading.value = false;
  }
}

function goUp(): void {
  if (parentPath.value) void list(parentPath.value);
}

/** Jump to whatever was typed/pasted in the path bar. */
function goToTypedPath(): void {
  const target = pathInput.value.trim();
  if (!target) return;
  void list(target, { fromPathBar: true });
}

/**
 * A folder row click navigates IN. A file row is inert EXCEPT in "file" mode,
 * where clicking a file selects it (emits `pick-file` with its absolute path).
 */
function onRowClick(entry: FsEntryExt): void {
  if (isFileEntry(entry)) {
    if (props.mode === "file") pickFile(entry.path);
    return;
  }
  void list(entry.path);
}

/** file mode: adopt an absolute file path and remember its folder as recent. */
function pickFile(path: string): void {
  emit("pick-file", path);
  const sep = path.includes("\\") ? "\\" : "/";
  const dir = path.slice(0, path.lastIndexOf(sep));
  if (dir) rememberRecent(dir);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Repos mode — select a git repo (name + branch), or add all children
 * ──────────────────────────────────────────────────────────────────────── */

async function selectRepo(path: string): Promise<void> {
  inspecting.value = true;
  error.value = null;
  try {
    const res = await api.fsInspect(path);
    if (!res.isGitRepo) {
      error.value = "Esta carpeta no es un repo git.";
      return;
    }
    confirm.value = { path: res.path, branches: res.branches };
    confirmName.value = res.name;
    confirmBranch.value = res.baseBranch ?? res.branches[0] ?? "main";
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    inspecting.value = false;
  }
}

function confirmAddRepo(): void {
  if (!confirm.value) return;
  const name = confirmName.value.trim();
  const branch = confirmBranch.value.trim();
  if (!name) {
    error.value = "El nombre del repo es obligatorio.";
    return;
  }
  if (!branch) {
    error.value = "La rama base es obligatoria.";
    return;
  }
  const repoPath = confirm.value.path;
  emit("pick-repo", { name, repoPath, baseBranch: branch });
  rememberRecent(repoPath);
  confirm.value = null;
}

function cancelConfirm(): void {
  confirm.value = null;
  error.value = null;
}

async function addAllChildren(children: FsEntryExt[]): Promise<void> {
  addingMany.value = true;
  error.value = null;
  try {
    const repos: AddRepoDTO[] = [];
    for (const child of children) {
      let baseBranch = "main";
      try {
        const info = await api.fsInspect(child.path);
        baseBranch = info.baseBranch ?? info.branches[0] ?? "main";
      } catch {
        /* best-effort: keep the fallback branch */
      }
      repos.push({ name: child.name, repoPath: child.path, baseBranch });
    }
    if (repos.length > 0) {
      emit("pick-repos", repos);
      rememberRecent(currentPath.value);
    }
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    addingMany.value = false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Config mode — use the current folder as the Claude config folder
 * ──────────────────────────────────────────────────────────────────────── */

function useThisFolder(): void {
  if (!currentPath.value) return;
  emit("pick-folder", currentPath.value);
  rememberRecent(currentPath.value);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Quick access + recents (localStorage)
 * ──────────────────────────────────────────────────────────────────────── */

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

function rememberRecent(path: string): void {
  if (!path) return;
  const next = [path, ...recents.value.filter((p) => p !== path)].slice(0, MAX_RECENTS);
  recents.value = next;
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable → recents are best-effort only */
  }
}

/** Short, readable label for a recent path (last 1–2 segments). */
function recentLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join("/");
}

/* ──────────────────────────────────────────────────────────────────────── */

async function loadRoots(): Promise<void> {
  try {
    const res = await api.fsRoots();
    roots.value = res.roots;
  } catch {
    roots.value = [];
  }
}

watch(
  () => props.initialPath,
  (p) => {
    if (p) void list(p);
  },
);

onMounted(() => {
  void loadRoots();
  void list(props.initialPath ?? undefined);
});
</script>

<template>
  <div class="fb">
    <!-- Path bar: Up + editable absolute path (type/paste + Enter) -->
    <div class="fb__pathbar">
      <button
        class="fb__up"
        type="button"
        :disabled="!parentPath || loading"
        title="Subir un nivel"
        aria-label="Subir"
        @click="goUp"
      >
        ↑
      </button>
      <div class="fb__pathinput-wrap" :class="{ 'fb__pathinput-wrap--err': pathError }">
        <input
          v-model="pathInput"
          class="fb__pathinput"
          type="text"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          placeholder="Escribe o pega una ruta absoluta y pulsa Enter…"
          aria-label="Ruta"
          @keydown.enter.prevent="goToTypedPath"
        />
        <button
          class="fb__pathgo"
          type="button"
          :disabled="loading"
          title="Ir a la ruta"
          @click="goToTypedPath"
        >
          Ir
        </button>
      </div>
    </div>
    <p v-if="pathError" class="fb__patherror">{{ pathError }}</p>

    <!-- Breadcrumb -->
    <nav class="fb__crumbs" aria-label="Ruta navegable">
      <button
        v-for="(c, i) in crumbs"
        :key="c.path"
        class="fb__crumb"
        type="button"
        :disabled="loading"
        @click="list(c.path)"
      >
        <span v-if="i > 0" class="fb__crumb-sep">/</span>{{ c.name }}
      </button>
    </nav>

    <!-- Quick access: Home/roots + recents -->
    <div v-if="rootChips.length || recents.length" class="fb__quick">
      <button
        v-for="r in rootChips"
        :key="'root-' + r.path"
        class="fb__chip fb__chip--root"
        type="button"
        :title="r.path"
        @click="list(r.path)"
      >
        <span class="fb__chip-ic">⌂</span>{{ r.label }}
      </button>
      <button
        v-for="p in recents"
        :key="'recent-' + p"
        class="fb__chip"
        type="button"
        :title="p"
        @click="list(p)"
      >
        <span class="fb__chip-ic">↺</span>{{ recentLabel(p) }}
      </button>
    </div>

    <!-- Filter -->
    <div class="fb__filter">
      <span class="fb__filter-ic" aria-hidden="true">⌕</span>
      <input
        v-model="filter"
        class="fb__filter-input"
        type="text"
        placeholder="Filtrar esta carpeta…"
        aria-label="Filtrar"
      />
      <button
        v-if="filter"
        class="fb__filter-clear"
        type="button"
        aria-label="Limpiar filtro"
        @click="filter = ''"
      >
        ×
      </button>
    </div>

    <p v-if="error" class="fb__error">{{ error }}</p>

    <!-- CONFIG MODE: "Usar esta carpeta" affordance for the current folder -->
    <div v-if="mode === 'config' && currentPath && !confirm" class="fb__use">
      <div class="fb__use-info">
        <span class="fb__use-label">Carpeta actual</span>
        <span class="fb__use-flags">
          <span v-if="hasDotClaude" class="fb__flag fb__flag--ok">✓ .claude</span>
          <span v-if="hasClaudeMd" class="fb__flag fb__flag--ok">✓ CLAUDE.md</span>
          <span v-if="!hasDotClaude && !hasClaudeMd" class="fb__flag fb__flag--warn">
            sin .claude / CLAUDE.md aquí
          </span>
        </span>
      </div>
      <button class="fb__btn fb__btn--primary fb__btn--sm" type="button" @click="useThisFolder">
        Usar esta carpeta
      </button>
    </div>

    <!-- REPOS MODE: current folder is itself a repo -->
    <div
      v-if="mode === 'repos' && currentIsGitRepo && !confirm"
      class="fb__banner"
    >
      <span><span class="fb__gitbadge">git</span> Esta carpeta es un repo.</span>
      <button
        class="fb__btn fb__btn--primary fb__btn--sm"
        type="button"
        :disabled="inspecting"
        @click="selectRepo(currentPath)"
      >
        Elegir esta carpeta
      </button>
    </div>

    <!-- REPOS MODE: parent of several repos → add all -->
    <div
      v-if="mode === 'repos' && childGitRepos.length > 1 && !confirm"
      class="fb__banner fb__banner--accent"
    >
      <span>Se encontraron {{ childGitRepos.length }} repos aquí.</span>
      <button
        class="fb__btn fb__btn--primary fb__btn--sm"
        type="button"
        :disabled="addingMany"
        @click="addAllChildren(childGitRepos)"
      >
        {{ addingMany ? "Agregando…" : `Agregar los ${childGitRepos.length}` }}
      </button>
    </div>

    <!-- REPOS MODE: confirm a single selected repo (name + branch) -->
    <div v-if="mode === 'repos' && confirm" class="fb__confirm">
      <p class="fb__confirm-path">{{ confirm.path }}</p>
      <label class="fb__field">
        <span class="fb__field-label">Nombre del repo</span>
        <input v-model="confirmName" class="fb__field-control" type="text" />
      </label>
      <label class="fb__field">
        <span class="fb__field-label">Rama base</span>
        <select
          v-if="confirm.branches.length"
          v-model="confirmBranch"
          class="fb__field-control"
        >
          <option v-for="b in confirm.branches" :key="b" :value="b">{{ b }}</option>
        </select>
        <input v-else v-model="confirmBranch" class="fb__field-control" type="text" />
      </label>
      <div class="fb__confirm-actions">
        <button class="fb__btn fb__btn--ghost fb__btn--sm" type="button" @click="cancelConfirm">
          Cancelar
        </button>
        <button class="fb__btn fb__btn--primary fb__btn--sm" type="button" @click="confirmAddRepo">
          Agregar repo
        </button>
      </div>
    </div>

    <!-- Directory listing -->
    <ul v-if="!confirm" class="fb__entries">
      <li v-if="loading" class="fb__state">Cargando…</li>
      <li v-else-if="sortedEntries.length === 0" class="fb__state">
        {{ filter ? "Sin coincidencias en este filtro." : "(Carpeta vacía)" }}
      </li>
      <template v-else>
        <li
          v-for="entry in sortedEntries"
          :key="entry.path"
          class="fb__row"
          :class="{
            'fb__row--repo': entry.isGitRepo,
            'fb__row--file': isFileEntry(entry),
            'fb__row--file-pick': isFileEntry(entry) && mode === 'file',
            'fb__row--hidden': entry.hidden,
          }"
        >
          <!--
            Folder: whole row navigates in.
            File: inert/greyed by default; SELECTABLE in "file" mode (click to pick).
          -->
          <button
            class="fb__row-main"
            type="button"
            :disabled="isFileEntry(entry) && mode !== 'file'"
            :title="
              isFileEntry(entry)
                ? mode === 'file'
                  ? `Elegir ${entry.name}`
                  : entry.path
                : `Entrar a ${entry.name}`
            "
            @click="onRowClick(entry)"
          >
            <span class="fb__row-ic">
              {{ isFileEntry(entry) ? "📄" : entry.isGitRepo ? "◧" : "📁" }}
            </span>
            <span class="fb__row-name">{{ entry.name }}</span>
            <span v-if="entry.isGitRepo" class="fb__gitbadge">git</span>
            <span
              v-else-if="!isFileEntry(entry) && entry.name === '.claude'"
              class="fb__tag"
            >.claude</span>
            <span
              v-else-if="isFileEntry(entry) && entry.name === 'CLAUDE.md'"
              class="fb__tag fb__tag--file"
            >config</span>
            <span
              v-if="!isFileEntry(entry)"
              class="fb__row-enter"
              aria-hidden="true"
            >›</span>
            <span
              v-else-if="mode === 'file'"
              class="fb__row-enter fb__row-enter--pick"
              aria-hidden="true"
            >＋</span>
          </button>

          <!-- Repos mode: unambiguous SELECT action on git rows. -->
          <button
            v-if="mode === 'repos' && entry.isGitRepo"
            class="fb__btn fb__btn--secondary fb__btn--sm fb__row-pick"
            type="button"
            :disabled="inspecting"
            @click="selectRepo(entry.path)"
          >
            Elegir
          </button>

          <!-- File mode: explicit SELECT action on file rows. -->
          <button
            v-if="mode === 'file' && isFileEntry(entry)"
            class="fb__btn fb__btn--secondary fb__btn--sm fb__row-pick"
            type="button"
            @click="pickFile(entry.path)"
          >
            Elegir
          </button>
        </li>
      </template>
    </ul>

    <!-- Footer: hidden toggle + truncation note -->
    <div v-if="!confirm" class="fb__foot">
      <button
        v-if="hiddenCount > 0"
        class="fb__link"
        type="button"
        @click="showHidden = !showHidden"
      >
        {{ showHidden ? "Ocultar ocultas" : `Mostrar ocultas (${hiddenCount})` }}
      </button>
      <span v-if="truncated" class="fb__hint">Lista recortada (muchas entradas).</span>
      <button
        v-if="closable"
        class="fb__link fb__link--muted"
        type="button"
        @click="emit('close')"
      >
        Cerrar explorador
      </button>
    </div>
  </div>
</template>

<style scoped>
.fb {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  padding: 12px;
  background: var(--ck-surface-2);
}

/* ── Path bar ─────────────────────────────────────────────────────────── */
.fb__pathbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fb__up {
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  color: var(--ck-text);
  font-size: 15px;
}
.fb__up:not(:disabled):hover {
  background: var(--ck-surface-hover);
}
.fb__up:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.fb__pathinput-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.fb__pathinput-wrap:focus-within {
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}
.fb__pathinput-wrap--err {
  border-color: var(--ck-danger);
}
.fb__pathinput {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 8px 10px;
  color: var(--ck-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.fb__pathinput::placeholder {
  color: var(--ck-text-faint);
}
.fb__pathinput:focus {
  outline: none;
}
.fb__pathgo {
  flex: none;
  border: none;
  border-left: 1px solid var(--ck-border);
  background: transparent;
  color: var(--ck-primary);
  font-weight: 700;
  font-size: 12.5px;
  padding: 0 12px;
  align-self: stretch;
}
.fb__pathgo:not(:disabled):hover {
  background: var(--ck-surface-hover);
}
.fb__patherror {
  margin: -4px 0 0;
  color: var(--ck-danger);
  font-size: 12px;
}

/* ── Breadcrumb ───────────────────────────────────────────────────────── */
.fb__crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
  font-size: 12px;
}
.fb__crumb {
  background: none;
  border: none;
  padding: 2px 3px;
  color: var(--ck-primary);
  font-weight: 600;
  white-space: nowrap;
}
.fb__crumb:hover {
  text-decoration: underline;
}
.fb__crumb:last-child {
  color: var(--ck-text);
}
.fb__crumb-sep {
  color: var(--ck-text-muted);
  margin: 0 2px;
  font-weight: 400;
}

/* ── Quick access chips ───────────────────────────────────────────────── */
.fb__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fb__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 4px 10px;
  border: 1px solid var(--ck-border);
  border-radius: 999px;
  background: var(--ck-surface);
  color: var(--ck-text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fb__chip:hover {
  border-color: var(--ck-primary);
  color: var(--ck-primary);
}
.fb__chip--root {
  background: var(--ck-bg);
}
.fb__chip-ic {
  flex: none;
  font-size: 12px;
  color: var(--ck-text-muted);
}
.fb__chip:hover .fb__chip-ic {
  color: var(--ck-primary);
}

/* ── Filter ───────────────────────────────────────────────────────────── */
.fb__filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.fb__filter:focus-within {
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}
.fb__filter-ic {
  flex: none;
  color: var(--ck-text-muted);
  font-size: 14px;
}
.fb__filter-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 7px 0;
  color: var(--ck-text);
  font-size: 12.5px;
}
.fb__filter-input::placeholder {
  color: var(--ck-text-faint);
}
.fb__filter-input:focus {
  outline: none;
}
.fb__filter-clear {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ck-text-muted);
  font-size: 15px;
}
.fb__filter-clear:hover {
  background: var(--ck-surface-hover);
  color: var(--ck-danger);
}

.fb__error {
  margin: 0;
  color: var(--ck-danger);
  font-size: 12.5px;
}

/* ── Banners (use folder / repo here / add all) ───────────────────────── */
.fb__use,
.fb__banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  padding: 9px 12px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
}
.fb__banner--accent {
  border-style: dashed;
  border-color: var(--ck-primary);
}
.fb__use-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.fb__use-label {
  font-weight: 600;
  color: var(--ck-text);
}
.fb__use-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fb__flag {
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  padding: 1px 8px;
}
.fb__flag--ok {
  color: var(--ck-status-done);
  background: rgba(77, 171, 154, 0.16);
}
.fb__flag--warn {
  color: var(--ck-status-review);
  background: rgba(255, 163, 68, 0.16);
}

/* ── Entries ──────────────────────────────────────────────────────────── */
.fb__entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 340px;
  overflow-y: auto;
}
.fb__state {
  padding: 14px;
  text-align: center;
  color: var(--ck-text-muted);
  font-size: 12.5px;
}
.fb__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.fb__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 11px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  color: var(--ck-text);
  text-align: left;
}
.fb__row-main:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}
.fb__row--repo .fb__row-main {
  border-color: rgba(35, 131, 226, 0.45);
}
.fb__row--file .fb__row-main {
  background: var(--ck-bg);
  color: var(--ck-text-faint);
  cursor: default;
  border-style: dashed;
}
/* In "file" mode, file rows are active/selectable — undo the greyed-out look. */
.fb__row--file-pick .fb__row-main {
  color: var(--ck-text);
  cursor: pointer;
  border-style: solid;
}
.fb__row--file-pick .fb__row-main:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}
.fb__row-enter--pick {
  color: var(--ck-primary);
}
.fb__row--hidden .fb__row-main {
  opacity: 0.72;
}
.fb__row-ic {
  flex: none;
  font-size: 14px;
}
.fb__row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.fb__row-enter {
  flex: none;
  color: var(--ck-text-muted);
  font-size: 16px;
  font-weight: 700;
}
.fb__row-main:hover .fb__row-enter {
  color: var(--ck-primary);
}
.fb__row-pick {
  flex: none;
}

.fb__gitbadge {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #fff;
  background: var(--ck-primary);
  border-radius: 999px;
  padding: 1px 8px;
}
.fb__tag {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--ck-primary);
  background: rgba(35, 131, 226, 0.16);
  border-radius: 999px;
  padding: 1px 8px;
}
.fb__tag--file {
  color: var(--ck-text-muted);
  background: var(--ck-border);
}

/* ── Confirm repo ─────────────────────────────────────────────────────── */
.fb__confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px dashed var(--ck-primary);
  border-radius: var(--ck-radius);
  padding: 12px;
  background: var(--ck-surface);
}
.fb__confirm-path {
  margin: 0;
  font-size: 11.5px;
  color: var(--ck-text-muted);
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.fb__confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.fb__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb__field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ck-text);
}
.fb__field-control {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--ck-border);
  border-radius: var(--ck-radius);
  background: var(--ck-surface);
  color: var(--ck-text);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.fb__field-control:focus {
  outline: none;
  border-color: var(--ck-primary);
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.35);
}

/* ── Footer ───────────────────────────────────────────────────────────── */
.fb__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-height: 4px;
}
.fb__hint {
  font-size: 11.5px;
  color: var(--ck-text-muted);
}
.fb__link {
  background: none;
  border: none;
  color: var(--ck-primary);
  font-size: 12px;
  font-weight: 600;
  padding: 0;
}
.fb__link:hover {
  text-decoration: underline;
}
.fb__link--muted {
  margin-left: auto;
  color: var(--ck-text-muted);
}

/* ── Buttons (scoped to this component) ───────────────────────────────── */
.fb__btn {
  padding: 9px 16px;
  border-radius: var(--ck-radius);
  font-weight: 600;
  border: 1px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.fb__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.fb__btn--sm {
  padding: 6px 12px;
  font-size: 12.5px;
}
.fb__btn--primary {
  background: var(--ck-primary);
  color: #fff;
}
.fb__btn--primary:not(:disabled):hover {
  background: var(--ck-primary-hover);
}
.fb__btn--secondary {
  background: var(--ck-surface);
  border-color: var(--ck-border);
  color: var(--ck-text);
}
.fb__btn--secondary:not(:disabled):hover {
  background: var(--ck-surface-hover);
  border-color: var(--ck-border-strong);
}
.fb__btn--ghost {
  background: transparent;
  border-color: var(--ck-border);
  color: var(--ck-text);
}
.fb__btn--ghost:hover {
  background: var(--ck-surface-hover);
}
</style>
