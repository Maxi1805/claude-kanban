# dbviz — visualizador de bases de datos reutilizable

`dbviz` es una herramienta que se instala **una sola vez** en un proyecto (o
se copia a cualquier otro) y deja un script persistente que, cada vez que se
corre, detecta los archivos de base de datos del proyecto (de **cualquier
lenguaje/stack**: Node, Python, Ruby, PHP, etc.), extrae su contenido a un
formato intermedio y genera un **visor HTML autocontenido** con tablas,
diagrama de esquema (ER) y estadísticas — sin instalar dependencias npm,
sin tocar el `node_modules` del proyecto anfitrión, y sin conexión a
internet para verlo.

- Motor de extracción: **Python 3 stdlib** (`sqlite3`, `json`, `csv`) — cero
  instalación en el 95%+ de los entornos de desarrollo. Fallback a la CLI
  `sqlite3` del sistema si no hay Python (modo degradado, ver §"Motores").
- Visor: **Tabulator 6.5.2** (grid) + **Mermaid 11.16.0** (diagrama ER) +
  **Chart.js 4.5.1** (stats), vendorizados bajo `assets/`, licencias MIT
  (ver `assets/LICENSES.md`).
- Contrato de datos versionado (`contractVersion: 1`) y config editable
  (`dbviz.config.json`).

---

## Instalación (una vez, en cualquier proyecto)

1. Copiá la carpeta completa a la raíz del proyecto (o a `tools/`, cualquier
   ubicación — el script se auto-resuelve):

   ```bash
   cp -r scripts/dbviz /ruta/a/otro-proyecto/scripts/dbviz
   ```

2. Desde la raíz de ese proyecto:

   ```bash
   bash scripts/dbviz/dbviz.sh init
   ```

   Esto detecta las bases de datos del proyecto y escribe
   `dbviz.config.json` (editable) en la raíz.

3. Cuando quieras generar/actualizar el visor:

   ```bash
   bash scripts/dbviz/dbviz.sh build
   bash scripts/dbviz/dbviz.sh open      # lo abre con el opener del SO
   ```

En este repo (`claude-kanban`) también podés usar:

```bash
npm run dbviz -- init
npm run dbviz -- build
```

`dbviz.py` **no** se agrega al build/typecheck/tsc/Vite del proyecto: es
100% independiente del resto del código.

---

## Uso — comandos

| Comando | Qué hace |
|---|---|
| `init [--build] [--force]` | Detecta fuentes y escribe `dbviz.config.json`. Falla si ya existe, salvo `--force`. `--build` corre `build` después. |
| `build` | Lee el config (o auto-inicializa en memoria si no existe) y genera `.dbviz/manifest.json`, `.dbviz/data/*.json` y `.dbviz/index.html`. |
| `detect [--json]` | Dry-run: solo detección, no escribe nada. |
| `serve` | Sirve `.dbviz/` con `python3 -m http.server` (útil si preferís no abrir por `file://`, o para datasets muy grandes). |
| `open` | Abre `.dbviz/index.html` con el opener del SO (`xdg-open`/`open`/`start`). |
| `clean` | Borra `.dbviz/` (no toca `dbviz.config.json`). |
| `version` | Versión del tool y motores disponibles. |
| `help` | Ayuda de uso. |

### Ejemplos reales

```bash
# Primera vez en el proyecto
bash scripts/dbviz/dbviz.sh init
# id       kind    confidence  detectedBy    path
# src-0    sqlite  high        magic-bytes   data/claude-kanban.db

bash scripts/dbviz/dbviz.sh build
# [dbviz] engine=python-stdlib sqlite=3.45.1
# [dbviz] src-0 data/claude-kanban.db: extrayendo (sqlite) ...
# [dbviz] src-0 4 tablas, 33 filas (0 muestreadas)
# [dbviz] render index.html (embebido 612 KB) listo
# /ruta/al/proyecto/.dbviz/index.html          <- stdout

# Tablas gigantes: limitar a 1000 filas por tabla, estrategia "head"
bash scripts/dbviz/dbviz.sh build --max-rows 1000 --sample head

# Restringir el build a una sola fuente
bash scripts/dbviz/dbviz.sh build --source data/claude-kanban.db

# Dry-run de detección en JSON (para scripting)
bash scripts/dbviz/dbviz.sh detect --json
```

### Flags principales

| Flag | Aplica a | Default | Efecto |
|---|---|---|---|
| `--project <dir>` | todos | cwd | Raíz del proyecto objetivo |
| `--config <path>` | init/build | `<project>/dbviz.config.json` | Ruta del config |
| `--out <dir>` | build | `.dbviz` | Directorio de salida |
| `--engine <auto\|python\|sqlite3\|node\|duckdb>` | build/detect | `auto` | Fuerza el motor de extracción |
| `--max-rows <N>` | build | 5000 | Override de `maxRowsPerTable` |
| `--sample <full\|head\|random\|systematic>` | build | `systematic` | Estrategia de muestreo |
| `--include <glob>` (repetible) | init/detect | — | Fuerza inclusión |
| `--exclude <glob>` (repetible) | init/detect | — | Agrega exclusión |
| `--source <path>` (repetible) | build | — | Restringe el build a estas fuentes |
| `--force` | init | false | Sobrescribe config existente |
| `--keep-temp` | build | false | No borra las copias RO temporales |
| `--strict` | build | false | Exit 4 si ninguna fuente se pudo extraer |
| `--quiet` / `-q` | todos | false | Solo errores |
| `--verbose` / `-v` | todos | false | Log detallado a stderr |
| `--json` | detect/version | false | Salida JSON en stdout |

Salida: **stdout** es siempre el "resultado de datos" (la tabla humana en
`init`, el JSON en `detect --json`, la ruta del `index.html` en `build`). El
progreso/log va siempre a **stderr**.

**Códigos de salida**: `0` OK · `1` error de uso · `2` `E-NOENGINE` (sin
motor disponible) · `3` config inválido · `4` ninguna fuente extraíble (solo
con `--strict`) · `5` error de I/O al escribir la salida. Un error en una
fuente/tabla/celda individual **nunca** aborta el resto del build — queda
registrado en `warnings`/`error` de esa fuente.

---

## El archivo de config — `dbviz.config.json`

Se escribe completo (auto-documentado) en `init`, y es editable a mano.
Ejemplo real (recortado):

```jsonc
{
  "configVersion": 1,
  "projectName": "claude-kanban",
  "scan": {
    "roots": ["."],
    "exclude": ["node_modules", ".git", "venv", ".venv", "__pycache__",
                ".cache", "dist", "build", ".next", ".nuxt", ".dbviz",
                "**/Cache/**", "**/nssdb/**"],
    "include": [],
    "followSymlinks": false,
    "maxDepth": 8,
    "maxFileSizeMB": 2048
  },
  "sources": [
    { "id": "src-0", "path": "data/claude-kanban.db", "kind": "sqlite",
      "enabled": true, "label": "App DB (claude-kanban)",
      "detectedBy": "magic-bytes", "confidence": "high" }
  ],
  "extraction": {
    "engine": "auto",
    "maxRowsPerTable": 5000,
    "sampleStrategy": "systematic",
    "maxBlobInlineBytes": 4096,
    "maxCellChars": 20000,
    "mergeWal": true,
    "copyBeforeRead": true
  },
  "remote": { "enabled": false, "detectOnly": true },
  "output": { "dir": ".dbviz", "singleFile": true, "inlineAssets": true, "writeRawJson": true },
  "viewer": { "title": "dbviz — claude-kanban", "theme": "auto",
              "erDiagram": true, "charts": true, "defaultTab": "tables" }
}
```

Podés des-habilitar una fuente detectada poniendo `"enabled": false`, agregar
fuentes manualmente, o ajustar `scan.exclude`/`scan.include` con globs. Ver
`dbviz.config.schema.json` (JSON Schema draft-07, informativo) para la forma
completa. Reglas de merge: los flags de CLI sobreescriben el config **solo
para esa corrida** (no reescriben el archivo, salvo `init --force`); un campo
desconocido en el config genera un warning no fatal y se ignora.

---

## Formato de salida (contrato de datos)

`build` genera, dentro de `<project>/.dbviz/`:

- **`manifest.json`**: índice + metadata de todas las fuentes (sin las
  filas pesadas) + `stats` agregadas + `warnings`.
- **`data/<sourceId>.json`**: una fuente completa, con sus tablas y **todas**
  las filas incluidas en la muestra (`rows`, array-de-arrays alineado a
  `columns[].name` — no array-de-objetos, para compacidad y para no repetir
  claves en tablas grandes).
- **`index.html`**: el visor, con `manifest` + todos los `data/*.json`
  embebidos inline (mismo contenido, ya no hace falta leer los `.json` para
  ver el visor — quedan además como archivos sueltos por si preferís
  consultarlos con `serve` o procesarlos con otra herramienta).

Cada celda es uno de: `null` · número · `{"__type__":"number","value":"NaN"}`
(reales no finitos) · `{"__type__":"bigint","value":"9223372036854775807"}`
(enteros de 64 bits fuera de `Number.MAX_SAFE_INTEGER` — un INTEGER de SQLite
soporta hasta ~9.22e18, muy por encima de los ~9.007e15 que `JSON.parse()`
puede reconstruir sin pérdida de precisión en el navegador; se codifican
como string exacto en vez de dejar que el número se corrompa silenciosamente
al parsear el JSON embebido, y el visor los muestra tal cual, como texto) ·
string (o `{"__type__":"text","truncated":true,...}` si excede
`maxCellChars`) · `{"__type__":"blob","encoding":"base64",...}` (BLOBs, con
`data:null` + `preview_hex` si excede `maxBlobInlineBytes`) ·
`{"__type__":"error","reason":...}` si un valor no pudo serializarse (nunca
aborta la tabla). El visor detecta estos objetos y los renderiza como chips
("Binary (N bytes)", "NaN", "TEXTO truncado…", "ver JSON" para columnas
`jsonLike`). En fuentes JSON/NDJSON, un campo que es a su vez un array/objeto
(ej. `"tags":["new","sale"]`) se serializa con `json.dumps` a JSON válido (no
con `str()` de Python) para que quede parseable por el botón "ver JSON"; la
columna se infiere como `inferredType:"json"` automáticamente.

Los valores de texto que contienen saltos de línea o tabs se muestran en el
grid con marcadores visibles (`⏎`/`→`) en reemplazo de los caracteres reales
(el grid es de una sola línea por fila) — el valor íntegro, con los
caracteres de whitespace originales, siempre está disponible al pasar el
mouse (tooltip nativo vía `title`). Los chips "ver JSON" también guardan el
valor completo (sin el recorte de 300 caracteres que se usa solo para la
vista previa) en `title`, así que un JSON largo se puede inspeccionar entero
desde el botón "ver JSON" aunque el chip visible esté truncado.

Cada tabla trae, además de `rows`: `ddl` (CREATE original), `columns[]` (con
`inferredType`, `nullable`, `primaryKey`, `stats` de la muestra), `primaryKey`,
`foreignKeys[]`, `indexes[]`, `rowCountTotal` (COUNT real) vs.
`rowCountSample` (filas incluidas), y `sampled`/`sampleStrategy`. Si
`sampled == true`, el visor muestra un banner visible con el conteo real vs.
la muestra.

---

## Motores de extracción y fallbacks

Orden de resolución (`--engine auto`, default):

1. **`python-stdlib`** (default): `import sqlite3` de Python 3. Hace todo en
   un solo proceso: detección, PRAGMA, sampling, serialización y render.
2. **`sqlite3-cli`**: si `--engine sqlite3`, o si Python no está, o si el
   módulo `sqlite3` de Python falló al importar. Usa el binario `sqlite3`
   del sistema (mismas queries, post-proceso arma el mismo contrato).
3. **`node`** *(opcional, no default)*: acelerador si el proyecto anfitrión
   ya tiene `better-sqlite3`/`node:sqlite` — documentado, no requerido
   nunca. Si se pide explícitamente y no aplica, se degrada a `auto` con
   warning.
4. **`duckdb`** *(opcional)*: solo detección de archivos `.duckdb` por
   header; la extracción vía `duckdb` CLI queda documentada como extensión
   futura (ver más abajo), no implementada en v1.

Si **ni** `python3` **ni** `sqlite3` están disponibles: `E-NOENGINE`, exit 2,
con instrucciones de instalación.

### Modo degradado (sin Python)

Si el proyecto objetivo no tiene `python3` pero sí `sqlite3` CLI, `dbviz.sh`
usa un camino 100% bash embebido en el propio launcher: detección por
`find` + `head -c 15` (magic bytes), extracción vía `sqlite3` CLI
aprovechando sus propias funciones JSON1 (`json_object`/`json_group_array`,
sqlite3 ≥ 3.38) para construir el contrato directamente en SQL — sin
depender de ningún parser externo. Este modo soporta **solo SQLite**, no
tiene la inferencia rica de tipos del motor Python (columnas quedan como
`integer`/`real`/`string` por afinidad declarada, sin `datetime`/`json`
real, sin truncado de texto ni NaN/Infinity), y los BLOBs se representan
solo como `preview_hex` (nunca `data` completo, incluso si son chicos). El
diagrama ER sigue intentando Mermaid igual (mismo `viewer.js`); si falla,
degrada a la lista HTML como en el modo completo.

---

## Formatos soportados

| Formato | v1 | Notas |
|---|---|---|
| SQLite (`.db`/`.sqlite`/`.sqlite3`) | ✅ datos completos | 1ª clase: WAL/SHM incluidos, PRAGMA, FKs, índices, sampling |
| JSON (array de objetos, o `{col: [...]}` estilo lowdb) | ✅ datos | Cada clave de nivel raíz con un array de objetos = una tabla |
| NDJSON (`.ndjson`/`.jsonl`) | ✅ datos | Línea por línea; líneas inválidas se saltan con warning. La detección tolera minoría de líneas corruptas en la muestra (≥50% válidas) — no descarta el archivo por una sola línea rota |
| CSV / TSV | ✅ datos | Sniffing de separador; primera fila = header; inferencia numérica por celda (enteros/decimales sin cero a la izquierda → `integer`/`real`; celda vacía → `null`) |
| Prisma / Django / Rails (schema de ORM) | 🟡 solo detección | `hasData:false`; se reporta como `orm-schema` — **sin filas** |
| Postgres / MySQL (`DATABASE_URL`) | 🟡 solo detección | `hasData:false`; se reporta como `remote-config` — password siempre redactada (`***`), nunca se conecta |
| DuckDB (`.duckdb`) | 🟡 solo detección | Header + extensión; extracción vía `duckdb` CLI documentada, no implementada |

**Por qué el recorte**: mantener v1 zero-friction, zero-secretos,
cross-stack. Postgres/MySQL requieren credenciales/red (riesgo de filtrar
secretos si se automatiza sin opt-in); ORM schema da solo estructura, nunca
filas reales; DuckDB no está garantizado instalado en el 100% de entornos.
El contrato de datos ya contempla estos `kind` con `hasData:false`, así que
extenderlos en el futuro no requiere re-arquitectura — ver
`docs/research-extract.md` §4/§5/§8.1 para el diseño detallado de esa
extensión (comandos `pg_dump`/`psql`, `getDMMF` de Prisma, parser de
`schema.rb`, `duckdb ATTACH ... (TYPE sqlite)`).

---

## Seguridad

- **Solo lectura, siempre sobre copia**: nunca se abre el archivo original
  del proyecto en modo escritura. `dbviz` copia el `.db` (+ `-wal`/`-shm` si
  existen) a un directorio temporal (`tempfile.mkdtemp`, respeta `TMPDIR`),
  hace un `PRAGMA wal_checkpoint(TRUNCATE)` **sobre la copia** (la única
  conexión de escritura de todo el tool), y luego abre esa copia con
  `file:...?mode=ro&immutable=1` (con fallback a `mode=ro` si `immutable`
  falla). El path original nunca se toca. Verificable: `md5sum`/mtime del
  `.db`/`.db-wal`/`.db-shm` original es idéntico antes y después de un
  `build`.
- **XSS**: todo valor proveniente de la base de datos se escapa antes de
  insertarse como HTML en el visor (`viewer.js`) — una celda con
  `<script>...</script>` se muestra como texto, nunca se ejecuta. Esto cubre
  tanto los VALORES de celda como los NOMBRES DE COLUMNA (usados como
  `title` de columna del grid Tabulator, que internamente hace `innerHTML`
  con ese `title` — un nombre de columna como
  `<img src=x onerror=...>` se escapa igual que cualquier otro dato antes de
  pasarlo a Tabulator). El propio payload JSON embebido escapa `</` → `<\/`
  para no cerrar prematuramente el `<script type="application/json">`; el
  render del template (`lib/render.py`) hace la sustitución de todos los
  placeholders (`{{APP}}`, `{{DATA}}`, etc.) en una única pasada sobre el
  template original, para que una celda cuyo contenido incluya literalmente
  una subcadena como `{{APP}}` no pueda ser reinterpretada como placeholder
  y corromper el HTML generado.
- **Secretos**: si se detecta un `DATABASE_URL` (Postgres/MySQL) en `.env`,
  `settings.py`, `docker-compose.yml`, etc., la contraseña se redacta a
  `***` en todo log/JSON — nunca se persiste ni se usa para conectar (v1 no
  soporta BDs remotas, ver arriba).
- **Nunca se aborta por un error puntual**: BD corrupta, BLOB gigante, celda
  no serializable, tabla sin permisos — todo queda registrado como
  `error`/`warning` de esa fuente/tabla/celda puntual; el resto del build
  sigue y siempre se genera un `index.html` (aunque sea parcial o vacío).

---

## Cómo llevarlo a otro proyecto

`scripts/dbviz/` es una carpeta **autocontenida y relocatable** (no depende
del `node_modules` del proyecto anfitrión, ni de que el proyecto destino sea
Node/TypeScript):

```bash
cp -r scripts/dbviz /ruta/a/otro-proyecto/scripts/dbviz
cd /ruta/a/otro-proyecto
bash scripts/dbviz/dbviz.sh init
bash scripts/dbviz/dbviz.sh build && bash scripts/dbviz/dbviz.sh open
```

Funciona igual sobre un proyecto Django, Rails, Nuxt, etc. — el extractor
introspecciona el schema en runtime (`sqlite_master`/`PRAGMA table_info`),
nunca asume nombres de tabla conocidos. Verificado contra dos esquemas
SQLite completamente distintos durante el desarrollo (`claude-kanban.db` y
`contents.sqlite`, un CMS Nuxt/`@nuxt/content` sin relación alguna con el
dominio de claude-kanban).

---

## Librerías vendorizadas

| Librería | Versión | Licencia | Uso |
|---|---|---|---|
| [Tabulator](https://tabulator.info/) | 6.5.2 | MIT | Grid de datos (tab "Tablas") |
| [Mermaid](https://mermaid.js.org/) | 11.16.0 | MIT | Diagrama ER (tab "Esquema") |
| [Chart.js](https://www.chartjs.org/) | 4.5.1 | MIT | Gráficas de resumen (tab "Stats") |

Los 3 archivos se descargaron una única vez desde el registro público de npm
y se comitean bajo `assets/` — el visor generado no hace ninguna petición de
red (`grep -Eo 'src="https?://|href="https?://' index.html` no debe devolver
coincidencias). Ver `assets/LICENSES.md` para el texto completo de cada
licencia.

---

## Documentación de investigación

`docs/` contiene copia literal de los 3 reportes de investigación que
sustentan las decisiones de este tool:

- `docs/research-extract.md` — detección y extracción multi-formato
  (SQLite/WAL, DuckDB, Postgres/MySQL, ORMs, JSON/CSV).
- `docs/research-viz.md` — comparación de librerías de visualización
  (grids, motores WASM en navegador, diagramas ER, charts).
- `docs/research-project.md` — análisis del proyecto anfitrión
  (`claude-kanban`) y recomendación de ubicación/arquitectura del tool.

---

## Limitaciones conocidas (v1)

- Postgres/MySQL/ORM/DuckDB: solo detección, sin extracción de datos (ver
  tabla de formatos arriba).
- El modo degradado (sin Python) solo soporta SQLite, sin la inferencia rica
  de tipos del motor principal.
- Tablas `WITHOUT ROWID` no soportan el muestreo `systematic`/`random`
  basados en `rowid % n`; se degradan automáticamente a `head` con una nota
  en la tabla.
- El HTML generado embebe **todas** las filas de la muestra inline: para
  datasets muy grandes, usar `--max-rows` más bajo y `serve` +
  `.dbviz/data/*.json` (quedan completos, `writeRawJson: true` por default)
  para explorar el resto por HTTP.
