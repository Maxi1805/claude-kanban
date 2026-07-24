# Investigación — Proyecto anfitrión `claude-kanban` (fase de research, solo lectura)

Fecha: 2026-07-24
Rol: analista de solo-lectura. No se modificó ningún archivo del repo ni la BD real.

## 1. Repo anfitrión: estructura y convenciones

Raíz: `<dir de sesiones>`
(este working copy es un **git worktree** de la tarea; el checkout "real" que corre en producción vive en `<home>/claude-kanban`, ver sección 5).

### package.json
- `"type": "module"` → todo el código es **ESM puro** (import/export, sin `require`).
- Stack: Node 20 + TypeScript + Express + `ws` + `better-sqlite3` (backend); Vue 3 + Vite + Pinia + vue-router (frontend en `web/`).
- Scripts npm:
  - `dev`: `concurrently` de `tsx watch src/server/index.ts` + `vite -c web/vite.config.ts`
  - `server`: `tsx src/server/index.ts`
  - `build`: `vite build -c web/vite.config.ts && tsc --noEmit`
  - `test`: `vitest run`
  - `typecheck`: `tsc --noEmit -p tsconfig.json`
- Sin ninguna librería de visualización/gráficos instalada actualmente (`chart|d3|plot|viz|graph` → 0 matches en package.json).
- Ejecutor de TypeScript: **`tsx`** (no `ts-node`, no compilación previa a `dist/` para desarrollo). `node_modules/.bin/tsx` existe en la instalación real.

### Estructura de código
```
src/
  server/
    index.ts            # entrypoint HTTP+WS
    config.ts            # config centralizada, env-overridable (ver abajo)
    db/
      index.ts            # apertura/creación de la BD (better-sqlite3) + migraciones idempotentes
      schema.sql           # DDL con CREATE TABLE/INDEX IF NOT EXISTS
      repositories.ts       # capa de acceso a datos (repos por entidad)
      repositories.test.ts
    api/                  # rutas Express (projects, tasks, commands, fs, agent-events)
    services/             # lógica de negocio (git, pty, cleanup, activity monitor, slug)
    lifecycle/            # orquestación de ciclo de vida de tasks
    ws/                   # bridge de WebSocket (terminal + eventos de board)
  shared/
    types.ts             # entidades/DTOs compartidas back+front
    interfaces.ts         # contratos de servicios
web/                     # SPA Vue 3 (Vite), consumida vía @shared alias
scripts/
  start.sh                       # launcher de producción (systemd-friendly)
  mcp-copyfiles-integration.sh   # test de integración E2E (bash, no framework)
```

### Convenciones observadas en `scripts/`
- Solo 2 scripts, **ambos bash**, no TS/JS.
- Shebang: `#!/usr/bin/env bash` + `set -uo pipefail`.
- Encabezado en comentario largo explicando qué hace el script, cómo se invoca y por quién (systemd, integración, etc.).
- Path-independiente: usan `cd "$(dirname "$(readlink -f "$0")")/.."` para resolver la raíz del repo relative al propio script, no rutas hardcodeadas — el script es "relocatable".
- Naming: kebab-case, descriptivo (`mcp-copyfiles-integration.sh`, no `test1.sh`).
- No hay convención de un subdirectorio `scripts/<tool>/` todavía — es una carpeta plana con 2 archivos. Pero el propio `src/server/` sí anida por dominio (`db/`, `api/`, `services/`, `ws/`), lo que sugiere que herramientas más grandes se organizarían en su propia carpeta.

### Base de datos: cómo se abre y dónde vive
- `src/server/db/index.ts`: usa `better-sqlite3` (binding nativo compilado). Abre con `new Database(dbPath)`, activa `PRAGMA journal_mode = WAL` y `PRAGMA foreign_keys = ON`, luego ejecuta `schema.sql` (idempotente, `IF NOT EXISTS`) y corre `migrate()` (ALTER TABLE ADD COLUMN guardado con `PRAGMA table_info`).
- Ruta default de la BD: `config.dbPath` = `<dataDir>/claude-kanban.db`, con `dataDir` default `<repoRoot>/data` — **override vía env `CK_DB_PATH`** y `CK_DATA_DIR` (ver `src/server/config.ts`).
- El motor persiste en modo **WAL**: además del `.db` pueden existir `.db-wal` y `.db-shm` (confirmado en producción, ver sección 5). Cualquier herramienta de solo-lectura debe copiar los 3 archivos juntos (o abrir en modo readonly que sqlite maneja bien igual, pero para no arriesgar bloqueos es más seguro trabajar sobre copia).
- `.gitignore` ignora `data/`, `*.db`, `*.db-shm`, `*.db-wal`, `*.log` → la BD nunca se versiona; cada entorno la genera en su propio `data/`.

### Esquema real (`schema.sql`)
4 tablas, FKs con `ON DELETE CASCADE`:
- `projects(id, name, created_at, claude_config_path, claude_md_path, claude_dir_path, mcp_config_path, copy_files)`
- `project_repos(id, project_id→projects, name, repo_path, base_branch, setup_script, run_script, teardown_script)`
- `tasks(id, project_id→projects, title, description, status, slug, session_root, pty_pid, claude_session_id, port, agent_state, agent_state_at, created_at, updated_at)`
- `task_repos(id, task_id→tasks, project_repo_id→project_repos, repo_name, branch_name, worktree_path, remote_pushed)`
- Índices en las FKs (`idx_project_repos_project`, `idx_tasks_project`, `idx_task_repos_task`).

## 2. Inspección de la BD real de claude-kanban (sobre copia)

Copiada a `.../scratchpad/dbviz/samples/claude-kanban.db` (+ `-wal`, `-shm`, ya que el original estaba en modo WAL con WAL activo — sqlite3 CLI la abrió sin problema incluyendo los cambios no checkpointeados).

Herramienta usada: `sqlite3` CLI (disponible en `/usr/bin/sqlite3`).

Tablas y row counts:
| tabla | filas |
|---|---|
| projects | 4 |
| project_repos | 5 |
| tasks | 9 |
| task_repos | 15 |

Muestras:
- `projects`: ej. `id="<id>", name="<proyecto privado>", created_at="<fecha>"`.
- `tasks`: ej. `title="Categorizar MEDDIC contactos GHL", status="todo", slug="vxvc-categorizar-meddic-contactos-ghl", agent_state=NULL`.
- `project_repos`: ej. `name="Backend", repo_path="<repo privado>", base_branch="development"`.
- `task_repos`: ej. `repo_name="Backend", branch_name="<rama>", worktree_path="<dir de sesiones>"`.

Es un esquema **relacional clásico con FKs jerárquicas**: `projects 1─N project_repos`, `projects 1─N tasks`, `tasks 1─N task_repos (N task_repos por task, uno por repo del proyecto)`. Ideal para visualizar como: (a) diagrama ER de las 4 tablas, (b) grafo project→repos→tasks→task_repos, o (c) tablero simple tipo kanban por `status`.

## 3. Inspección de una segunda BD real: `contents.sqlite` (proyecto Nuxt/Frontend distinto)

Copiada a `.../scratchpad/dbviz/samples/contents.sqlite`.

Es la BD generada por el módulo **`@nuxt/content`** (v3, detectable por el prefijo `_content_*` y el campo `structureVersion`/`__hash__`). Nada que ver con el esquema de claude-kanban — confirma que el visualizador debe ser **schema-agnostic** (introspectar en runtime, no asumir tablas conocidas).

Tablas y row counts:
| tabla | filas |
|---|---|
| _content_info | 1 |
| _content_news | 44 |
| _development_cache | 45 |

Esquema:
- `_content_info(id, ready BOOLEAN, structureVersion, version, __hash__ UNIQUE)` — metadata de versión de la colección de contenido.
- `_content_news(id, title, author, body TEXT, category, date, description, extension, image, keywords TEXT, locale, meta TEXT, navigation BOOLEAN DEFAULT true, path, pressLogo, seo TEXT DEFAULT '{}', sitemap, slug, stem, tags TEXT, __hash__ UNIQUE)` — una fila por artículo de noticias (markdown parseado), varios campos `TEXT` contienen **JSON serializado como string** (`meta`, `seo`, `tags`, `keywords`) — el visualizador debe poder detectar y pretty-printear JSON embebido en columnas TEXT.
- `_development_cache(id, checksum, value, __hash__ UNIQUE)` — cache genérica id→value (también JSON en `value`), típica de tooling interno, no de dominio de negocio.

Notas clave para el diseñador del extractor:
- No hay FKs declaradas entre estas tablas (a diferencia de claude-kanban).
- Columnas con default no estándar: `navigation BOOLEAN DEFAULT true` (SQLite no tiene tipo BOOLEAN real, se guarda como texto/integer según el driver ORM).
- Nombres de columna con mayúsculas/camelCase entre comillas dobres (`"checksum"`, `"structureVersion"`) — el DDL usa identificadores citados, típico de generadores ORM (Drizzle/Nitro/unstorage en este caso).
- Confirma que distintos stacks (Node/Nuxt vs Node/Express) producen esquemas totalmente distintos — el extractor genérico debe basarse en `sqlite_master`/`PRAGMA table_info` + heurísticas de tipo de columna, no en nombres de tabla esperados.

## 4. Entorno disponible para el tooling

| herramienta | resultado |
|---|---|
| `node --version` | v20.20.2 |
| `python3 --version` | Python 3.12.3 |
| `which sqlite3` | `/usr/bin/sqlite3` (CLI disponible) |
| `which duckdb` | no instalado |
| `node:sqlite` (built-in Node) | **no disponible** — requiere Node ≥ 22; este entorno corre Node 20.20.2, así que el script **no puede depender de `node:sqlite`**. Debe usar `better-sqlite3` (ya es dependencia del propio proyecto) o invocar `sqlite3`/`python3` como fallback. |
| `node_modules/` en el **worktree de esta tarea** | ausente (worktree recién creado, no se corrió `npm install` aquí) |
| `node_modules/` en el **checkout real** (`<home>/claude-kanban`) | presente; `better-sqlite3` está compilado (binding nativo en `node_modules/better-sqlite3/build/Release`), y `node_modules/.bin/tsx` existe. |

Conclusión práctica: el script de visualización, si se implementa en TS/Node y se apoya en `better-sqlite3`, funcionará dentro del propio repo anfitrión (que ya trae la dependencia nativa compilada) pero **no es trivial reutilizarlo tal cual contra un proyecto de OTRO stack** (ej. el repo Nuxt/Frontend) salvo que:
  (a) se instale como paquete standalone con su propio `node_modules` (con su propio `better-sqlite3` compilado para esa máquina), o
  (b) se use el `sqlite3` CLI del sistema (ya presente) como capa de extracción portátil sin dependencias nativas, o
  (c) se use `python3` + su módulo estándar `sqlite3` (built-in, cero instalación) como extractor universal — es la opción más portable entre proyectos con distinto stack/lenguaje, ya que no depende de que el proyecto objetivo tenga Node ni sus propias deps instaladas.

## 5. Instancia real en ejecución (para contraste, no se tocó)

`<home>/claude-kanban` (checkout fuera de los worktrees de tareas) tiene:
- `node_modules/` completo, con `better-sqlite3` compilado y `tsx` en `.bin`.
- `data/claude-kanban.db` + `.db-wal` (4.1MB, WAL activo con cambios no checkpointeados) + `.db-shm`, además de `data/pty-logs/` y `data/claude-kanban-hooks.json`.
- Confirma que el patrón real de despliegue es: repo fuente sin BD versionada, BD y logs viven en `data/` generado en runtime, en modo WAL.

## 6. Recomendación de ubicación del tool dentro del repo

Dado que:
- `scripts/` ya existe, es plano, y solo contiene bash scripts de infraestructura/integración (no TS de aplicación).
- El código de aplicación (TS) vive todo bajo `src/`, organizado por dominio en subcarpetas (`db/`, `api/`, `services/`, `ws/`).
- El pedido es un tool **reutilizable entre proyectos** (no exclusivo de claude-kanban), invocado con un comando tipo "init" que deja un script persistente.

Recomendación:
- Crear una carpeta dedicada **`scripts/dbviz/`** dentro del repo anfitrión, conteniendo:
  - Un script bash de entrada tipo `scripts/dbviz/dbviz.sh` (siguiendo la convención observada: shebang `#!/usr/bin/env bash`, `set -uo pipefail`, comentario de cabecera, resolución de ruta relativa a sí mismo con `readlink -f`), que es lo que el comando "init" copiaría/dejaría instalado en el proyecto objetivo.
  - La lógica de extracción/generación como módulo(s) separados (ej. `scripts/dbviz/extract.py` o `.mjs`) para poder ejecutarse standalone (sin depender del `node_modules` del proyecto anfitrión) cuando se instale en un proyecto de otro stack.
- Esto es coherente con que `scripts/` ya es el lugar de "herramientas operativas/infra" (vs. `src/` que es el código de la aplicación web en sí), y evita mezclar el tool de visualización con el dominio de negocio de claude-kanban (proyectos/tasks/repos).
- Si el equipo quisiera exponerlo como comando npm, se podría agregar un script en `package.json` (ej. `"dbviz": "bash scripts/dbviz/dbviz.sh"`), consistente con cómo hoy `scripts/start.sh` se invoca directo o documentado en README, sin necesidad de integrarlo al build/typecheck del proyecto principal.
- Dado el hallazgo de la sección 4 (portabilidad entre stacks), el extractor de datos en sí (la parte que debe correr dentro de *cualquier* proyecto objetivo, potencialmente sin Node) es candidato fuerte a implementarse en **Python 3 stdlib** (sqlite3 built-in, cero deps) o como binario/script que solo dependa del `sqlite3` CLI — dejando la parte TS/Vite del repo anfitrión únicamente para la UI de visualización que consume el JSON ya extraído.
