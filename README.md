# claude-kanban

A local web tool: a kanban board where each card is a feature/task that may span
**one or more git repositories**. Creating a card creates, for each repo, a git
worktree on a new branch `<slug>`, assembled under a single session-root directory.
One interactive **Claude Code** process runs in a `node-pty` at the session root,
and the user watches it live in an `xterm.js` terminal. Deleting a card runs a full
teardown (kill pty, remove worktrees, delete branches, prune).

## Session layout on disk

```
<base>/<projectName>/<slug>/<RepoName>/    # one git worktree per repo, siblings under the slug session root
<base>/<projectName>/<slug>/CLAUDE.md       # symlink from the configured template repo (optional)
<base>/<projectName>/<slug>/.claude         # symlink from the configured template repo (optional)
```

## Architecture

- **Backend** (`src/server/`): Node 20 + TypeScript, Express (HTTP API), `ws`
  (WebSocket for the pty bridge + board events), `better-sqlite3` (persistence),
  `node-pty` (interactive Claude Code process), `nanoid` (ids). Listens on `:8787`.
- **Frontend** (`web/`): Vue 3 + Vite + TypeScript, `vue-router`, `pinia`,
  `@xterm/xterm` (+ `addon-fit`, `addon-attach`), `vuedraggable`. Dev server on
  `:5173`, proxying `/api` and `/ws` to the backend.
- **Shared contracts** (`src/shared/`): the single source of truth for the system.
  - `types.ts` — domain entities, DTOs, and WS message types.
  - `interfaces.ts` — service interfaces (`GitService`, `PtyService`,
    `CleanupService`, `TaskLifecycle`, `Repositories`) each module implements.
  Both are re-exported into the frontend via the `@shared` alias.

## Scripts

```bash
npm install        # installs all deps (native: better-sqlite3, node-pty)
npm run dev        # concurrently: tsx watch server + vite dev
npm run server     # backend only (tsx src/server/index.ts)
npm run build      # vite build + tsc typecheck
npm run test       # vitest run
npm run typecheck  # tsc --noEmit
```

## Caveman mode (per task)

Each card carries a checkbox and a level selector that decide whether **that
task's** Claude session loads the [caveman](https://github.com/JuliusBrussee/caveman)
plugin — a third-party skill that compresses the agent's prose while leaving
code, commands and errors byte-for-byte intact.

The plugin is **not bundled**; install it once and the board does the rest:

```bash
claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman
```

How the two knobs reach the session:

- **checkbox** → `enabledPlugins` in the task's own `--settings` file, written on
  every spawn. Off means the plugin is never loaded, so it costs nothing — not
  even the input tokens of its skill description. Explicit `false` also overrides
  a global enable in the user's own `settings.json`.
- **level** (`lite` / `full` / `ultra` / `wenyan`) → the plugin's `/caveman <level>`
  command, typed into the live pty once the terminal settles, so switching level
  never needs a restart. The plugin's own default (`full`) is not typed at spawn —
  it is already what an enabled plugin does, and the round trip would cost a turn.
- **unchecking a running task** types `normal mode`, the phrase the plugin
  documents for going back to normal prose (it has no `/caveman off`).

`CK_CAVEMAN_PLUGIN_ID` overrides the `plugin@marketplace` id; by default it is
detected from `~/.claude/skills/caveman` (the universal installer) or from an
installed marketplace. An id matching nothing installed is inert.

## Environment overrides

See `src/server/config.ts`. Notable vars:

- `CK_PORT` — server port (default `8787`)
- `CK_WORKTREE_BASE` — base dir for session roots (default `~/claude-kanban-sessions`)
- `CK_DB_PATH` — sqlite file (default `data/claude-kanban.db`)
- `CK_AGENT_COMMAND` — agent command to spawn in the pty (default `claude`)
- `CK_TEMPLATE_REPO` — repo whose `CLAUDE.md` / `.claude` get symlinked into the session root
- `CK_CAVEMAN_PLUGIN_ID` — `plugin@marketplace` id for the caveman switch (auto-detected)

## Status

Working implementation. All cross-module contracts (types, service interfaces, DB
schema, API routes, WS protocol) are defined, and every module — git worktrees,
pty lifecycle, cleanup/teardown, agent-activity monitoring, and the board UI — is
implemented against them and covered by `vitest` unit tests plus an end-to-end
integration proof (`scripts/mcp-copyfiles-integration.sh`).
