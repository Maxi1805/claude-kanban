# Investigación: Extracción de datos multi-formato hacia JSON universal

Fecha: 2026-07-24
Alcance: fase de investigación para un visualizador de bases de datos reutilizable (init una vez, correr siempre, cualquier proyecto/lenguaje). Este documento **no implementa** el tool; documenta señales de detección, comandos de extracción probados y decisiones de diseño para la fase de implementación.

## Entorno de prueba usado en esta investigación

- `sqlite3` CLI 3.45.1 (soporta `-readonly`, URI `mode=ro`/`immutable=1`, `.mode json`) — disponible.
- `node` v20.20.2 — **`node:sqlite` NO disponible** (requiere Node ≥ 22.5, ver sección 2.3). Hay que asumir que el proyecto anfitrión puede correr en Node 18/20/22 y decidir el fallback en consecuencia.
- `python3` 3.12.3 con `sqlite3` stdlib (versión motor 3.45.1) — disponible siempre que haya Python en el sistema.
- `duckdb` CLI: **no instalado** en este entorno, ni el módulo `duckdb` de Python. Se documenta como opción "si está disponible", con instrucciones de instalación, pero no se puede asumir presencia.
- `psql` / `pg_dump`: disponibles. `mysql` / `mysqldump`: no encontrados en este entorno (se documenta igual, es software estándar en cualquier imagen con esos motores).
- Pruebas reales ejecutadas contra copias de:
  - `claude-kanban.db` (proyecto anfitrión, better-sqlite3/Node): tablas `projects, project_repos, tasks, task_repos`.
  - `contents.sqlite` (proyecto <proyecto privado>, Node distinto stack de CMS): tablas `_development_cache, _content_info, _content_news`.
  - Los mismos comandos genéricos (sqlite3 CLI y Python stdlib) funcionaron sin cambios contra ambos esquemas completamente distintos, lo cual valida el enfoque "cualquier lenguaje, mismo extractor SQLite".

---

## 1. Detección de archivos de base de datos en un repo

### 1.1 Señales de detección (orden de confiabilidad)

| Señal | Cómo comprobarla | Confiabilidad |
|---|---|---|
| Magic bytes | primeros 16 bytes == `SQLite format 3\0` (hex `53514c69746520666f726d61742033 00`) | Muy alta — es la prueba definitiva de "esto es SQLite", independiente de la extensión |
| Extensión de archivo | `.db`, `.sqlite`, `.sqlite3`, `.duckdb` | Media — falsos positivos (ver 1.3) y falsos negativos (archivos sin extensión, ej. `content.db.something`) |
| Directorios típicos | `data/`, `.data/`, `db/`, `prisma/`, `var/`, `storage/`, `instance/` (Flask), `priv/repo` (Elixir/Ecto) | Media — sirve para **priorizar** el recorrido, no para decidir por sí sola |
| Archivos WAL/SHM asociados | `<nombre>.db-wal`, `<nombre>.db-shm` junto al `.db` | Alta — confirma que es una BD SQLite activa en modo WAL, y obliga a tratarlos como parte del mismo artefacto (ver 2.2) |
| Config de conexión | `DATABASE_URL` en `.env`, `settings.py` (Django), `database.yml` (Rails), `application.properties` (Spring), `schema.prisma`/`drizzle.config.ts` (Node ORMs) | Alta para decidir el **tipo de motor**, pero no da acceso directo a los datos si es server-based |

### 1.2 Comando de detección por magic bytes (recomendado como filtro definitivo)

```bash
# Barrido rápido: encontrar candidatos por extensión, evitando directorios pesados/irrelevantes
find . \
  -path '*/node_modules' -prune -o \
  -path '*/.git' -prune -o \
  -path '*/venv' -prune -o \
  -path '*/.venv' -prune -o \
  -type f \( -iname '*.db' -o -iname '*.sqlite' -o -iname '*.sqlite3' -o -iname '*.duckdb' \) -print

# Confirmación por magic bytes (evita falsos positivos/negativos de extensión)
for f in $(find . -type f -size +0c 2>/dev/null); do
  head -c 16 "$f" 2>/dev/null | grep -q "SQLite format 3" && echo "SQLITE: $f"
done
```

Alternativa con `file(1)` (disponible en casi todos los sistemas Linux/Mac):

```bash
file --mime-type -b archivo_cualquiera
# -> application/vnd.sqlite3 ; "SQLite 3.x database" en salida no-mime
```

Probado en este entorno:
```
$ file claude-kanban.db
claude-kanban.db: SQLite 3.x database, last written using SQLite version 3049002, ...
```

DuckDB tiene su propio magic bytes distinto (`DUCK` en el header, formato propio no relacionado a SQLite), y los archivos `.duckdb` solo se detectan de forma confiable por header + extensión, ya que no hay un comando estándar universal equivalente a `file` para DuckDB en todas las distros.

### 1.3 Distinguir BDs reales de "ruido" (falsos positivos)

Cosas que **parecen** BDs SQLite pero no son útiles para visualizar como "datos de la app":

- `**/.pki/nssdb/*.db` — bases de datos NSS (certificados de Firefox/Chrome/Java), formato Berkeley DB, no SQLite (aunque a veces también literalmente `cert9.db` es SQLite en NSS moderno).
- `**/node_modules/**/*.sqlite` — bases de test/fixtures de dependencias.
- `**/.cache/**`, `**/Cache/**`, `**/*Cache.db` — cachés de navegador/Electron (`Cookies`, `History`, `QuotaManager`, `Favicons`, LevelDB de Chromium).
- `**/*.db-journal`, `*.db-wal`, `*.db-shm` — no son la BD en sí, son artefactos del motor (deben asociarse al `.db` principal, no listarse como BD independiente).
- Archivos de `pytest`/`tox`/`.terraform` con extensión `.db` que en realidad son locks o metadata interna.

Heurística práctica de exclusión: ignorar rutas bajo `node_modules/`, `.git/`, `venv/`/`.venv/`, `__pycache__/`, `.cache/`, `dist/`, `build/`, y archivos cuyo nombre coincida con patrones conocidos de navegador/OS (`Cookies`, `History`, `nssdb`, `Favicons`, `QuotaManager`, `LOCK`, `LOG`). Y siempre exigir el magic bytes de SQLite antes de aceptar un candidato como "BD de la aplicación".

---

## 2. SQLite — el caso principal

### 2.1 Garantizar solo-lectura

Dos mecanismos independientes y complementarios de la URI de SQLite (RFC del propio motor, ver https://sqlite.org/uri.html):

- `mode=ro`: la conexión no puede escribir nada; si el archivo no existe, falla (no lo crea). Es la protección "a nivel de conexión".
- `immutable=1`: le dice al motor que el archivo *en disco* no cambiará durante la sesión, por lo que **se saltea el locking de archivos y la detección de cambios**. Útil cuando el archivo está en un filesystem realmente read-only, o cuando queremos evitar cualquier intento de bloqueo sobre un archivo que puede estar en uso por otro proceso (la app original).

Recomendación para el tool: usar **ambos combinados** `file:<ruta>?mode=ro&immutable=1` sobre una **copia** del archivo (no el original en vivo), exactamente como se hizo en esta investigación. Esto evita:
1. Cualquier riesgo de escritura accidental.
2. Contención de locks con el proceso que sigue usando la BD real.
3. Problemas de "immutable" mintiendo si el archivo cambia mientras se lee (por eso se copia antes).

Comandos probados en este entorno:

```bash
# CLI sqlite3 con URI + flags combinados
sqlite3 "file:/ruta/copia.db?mode=ro&immutable=1" ".tables"

# Equivalente más simple (siempre que el archivo NO se vaya a modificar durante la sesión)
sqlite3 -readonly /ruta/copia.db "SELECT name FROM sqlite_master WHERE type='table';"

# Python stdlib (funciona igual, uri=True obligatorio para que interprete la query string)
python3 -c "
import sqlite3
con = sqlite3.connect('file:/ruta/copia.db?mode=ro&immutable=1', uri=True)
"
```

Verificación empírica de que el modo solo-lectura bloquea escrituras (hecha en esta investigación):
```
$ python3 -c "con=sqlite3.connect('file:contents.sqlite?mode=ro', uri=True); con.execute('CREATE TABLE test_write (a int)')"
sqlite3.OperationalError: attempt to write a readonly database
```

### 2.2 Manejo de `-wal` / `-shm`

Cuando SQLite corre en `journal_mode=WAL` (común en apps con better-sqlite3, Prisma, etc.), los cambios recientes viven en el archivo `<nombre>.db-wal` y NO están todavía en el `.db` principal. Si se copia solo el `.db` sin el `-wal`, **se pierden filas/cambios recientes** (aunque la copia sigue siendo un SQLite válido, no corrupto).

Reglas para el tool:
1. Al detectar `foo.db`, buscar siempre `foo.db-wal` y `foo.db-shm` junto a él y copiarlos los tres juntos (mismo directorio destino) antes de abrir nada.
2. Abrir la copia normalmente (sin forzar `immutable=1` en este primer paso si se quiere que SQLite haga el *checkpoint* automático del WAL al abrir); una alternativa más segura y explícita es forzar un checkpoint controlado:
   ```bash
   sqlite3 copia.db "PRAGMA wal_checkpoint(TRUNCATE);"
   ```
   Esto vuelca el contenido del `-wal` dentro del `.db` y dejarlo en estado consistente antes de pasar a modo `immutable=1` para las lecturas siguientes.
3. Si no hay permisos de escritura sobre la copia (raro, ya que es nuestra propia copia) o se prefiere no tocarla, abrir directamente con `mode=ro` sin `immutable=1` — SQLite igual sabe leer el WAL en modo solo-lectura, simplemente no podrá hacer checkpoint.

Confirmado en esta investigación: `claude-kanban.db` traía un `-wal` de ~4 MB (vs 57 KB el `.db`), es decir la mayoría del contenido reciente vivía en el WAL — omitirlo habría producido una visualización con datos desactualizados o incompletos.

### 2.3 Opciones de lectura sin dependencias externas (comparativa)

| Opción | Requisito | Pros | Contras | Disponible en este entorno |
|---|---|---|---|---|
| CLI `sqlite3` | binario del sistema | Universal, cero instalación, soporta `.mode json` nativo | Formato de salida de `.mode json` no es 100% JSON válido en streaming multi-tabla sin post-proceso; hay que invocar por tabla | Sí (3.45.1) |
| `node:sqlite` (`node:sqlite`) | Node.js **≥ 22.5** (experimental; estable desde Node 24) | Nativo, sin instalar paquetes, misma API que better-sqlite3-like (`DatabaseSync`), soporta `readOnly: true` | No existe en Node 18/20; el proyecto anfitrión hoy corre Node 20 → **no se puede asumir disponible** | No (Node 20.20.2 aquí) |
| `better-sqlite3` (npm) | `npm install better-sqlite3` (requiere compilar binding nativo o binario prebuilt) | Rápido, síncrono, ya es dependencia del proyecto anfitrión (claude-kanban lo usa) | Dependencia extra si se quiere que el script sea "cero-instalación" en proyectos ajenos | Instalable vía npm |
| Python stdlib `sqlite3` | Python 3.x (viene preinstalado en casi todo Linux/Mac) | Cero instalación, soporta URI mode, tipos vía `row_factory` | Requiere que el sistema tenga `python3` (asumible en casi todo entorno dev) | Sí (3.12.3) |

Recomendación práctica: usar el **CLI `sqlite3`** como primera opción (cero dependencias, disponible en el 95%+ de entornos dev/CI), con **Python stdlib** como fallback si el CLI no está, y `better-sqlite3`/`node:sqlite` como opción "nativa" si el script se ejecuta embebido en el propio proceso Node del proyecto anfitrión (más rápido para datasets grandes, sin spawnear procesos).

### 2.4 Extracción del schema

```bash
# Lista de tablas (excluyendo tablas internas de sqlite)
sqlite3 -readonly copia.db "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%';"

# DDL completo de una tabla (para reconstruir el CREATE TABLE, útil para mostrar "esquema declarado")
sqlite3 -readonly copia.db "SELECT sql FROM sqlite_master WHERE name='projects';"

# Columnas + tipos + nullable + PK (formato tabular: cid|name|type|notnull|dflt_value|pk)
sqlite3 -readonly copia.db "PRAGMA table_info(projects);"

# Foreign keys declaradas (tabla origen -> tabla referenciada, columnas)
sqlite3 -readonly copia.db "PRAGMA foreign_key_list(projects);"

# Índices de una tabla
sqlite3 -readonly copia.db "PRAGMA index_list(projects);"

# Row count por tabla (para decidir si hace falta sampling)
sqlite3 -readonly copia.db "SELECT COUNT(*) FROM projects;"
```

Resultados reales obtenidos contra `claude-kanban.db` en esta investigación:
```
tabla ejemplo: projects
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
, claude_config_path TEXT, claude_md_path TEXT, claude_dir_path TEXT, mcp_config_path TEXT, copy_files TEXT)

columnas (PRAGMA table_info):
0|id|TEXT|0||1
1|name|TEXT|1||0
2|created_at|TEXT|1||0
...
foreign keys: (ninguna declarada en esta tabla)
row count: 4
```

Nota importante para el ER: en SQLite las FKs se descubren tabla por tabla (`PRAGMA foreign_key_list(<tabla>)` para cada una), no hay un catálogo global único como en Postgres (`information_schema`). El extractor debe iterar todas las tablas y agregar los resultados para construir el grafo de relaciones completo.

### 2.5 Extracción de filas con LIMIT/sampling para tablas enormes

```bash
# Export directo a JSON (array de objetos) usando el modo nativo del CLI
sqlite3 "file:copia.db?mode=ro" <<'EOF'
.mode json
.output salida.json
SELECT * FROM projects LIMIT 500;
.output stdout
EOF
```

Probado en esta investigación — produce JSON válido, un objeto por fila, tipos ya inferidos (strings, null, etc.):
```json
[{"id":"<id>","name":"<proyecto privado>","created_at":"<fecha>","claude_config_path":null, ...}]
```

Estrategia de sampling recomendada para tablas grandes (definir un umbral, ej. 50k filas):
- Si `COUNT(*)` ≤ umbral: extraer todo con `SELECT * FROM tabla`.
- Si `COUNT(*)` > umbral: extraer una muestra representativa, por ejemplo:
  ```sql
  SELECT * FROM tabla ORDER BY RANDOM() LIMIT 1000;              -- muestra aleatoria simple
  -- o, más barato en tablas grandes (evita ORDER BY RANDOM full scan):
  SELECT * FROM tabla WHERE rowid % (total/1000) = 0 LIMIT 1000; -- muestreo sistemático
  ```
  y dejar claro en la visualización que es una muestra, mostrando el `COUNT(*)` real junto al tamaño de la muestra.

### 2.6 Serialización de BLOBs y tipos raros a JSON

SQLite es de tipado dinámico (columna declarada `TEXT` puede contener un INTEGER real, etc. — "type affinity", no tipado estricto). Casos a resolver en el extractor:

- **BLOB**: no es representable en JSON directamente. Estrategias:
  - Convertir a Base64: `SELECT hex(columna)` da hex, o mejor usar el binding del lenguaje (Python `bytes` → `base64.b64encode`; Node `Buffer` → `.toString('base64')`) y marcar el campo como `{"__type__":"blob","encoding":"base64","data":"...","size_bytes":N}` para que el visualizador lo muestre como "Binary (N bytes)" en vez de intentar renderizar basura.
  - Para BLOBs muy grandes, truncar y solo mostrar tamaño + primeros bytes en hex como preview.
  - **Trampa real encontrada con el binario `sqlite3` CLI (motor `sqlite3-cli`, ver §1.4):** `sqlite3 -json` **no** serializa BLOB como base64/hex — emite los bytes crudos "escapados" de forma ad-hoc dentro de un string JSON, de forma **no reversible** (un BLOB con bytes `\x00\x01\xff\xfe hello` sale como el string basura `u0000u0001uffffffffufffffffe hello`, perdiendo la información binaria original en forma silenciosa). Como ese valor llega ya como `str` de Python vía `json.loads()` del stdout del CLI, nunca activa la rama `isinstance(value, bytes)` de `encode_cell()`, y la celda queda mal clasificada como texto en vez de `blob`. **Mitigación implementada** (`lib/extract_sqlite.py`, `_blob_probe_select_clause`/`_rows_json_to_raw`): en vez de `SELECT * FROM tabla`, se pide explícitamente `typeof(col)` y `hex(col)` de cada columna (SQLite tiene tipado dinámico por valor, no por columna, así que no basta con mirar el tipo declarado); cuando `typeof(col) = 'blob'`, se reconstruye el valor real con `bytes.fromhex(...)` en vez de confiar en el valor de texto que el CLI ya corrompió. El modo 100% bash de `dbviz.sh` (sin Python, §9.2) usa una estrategia distinta pero igual de correcta: arma el `json_object('__type__','blob',...,'preview_hex',hex(...))` **dentro de la propia consulta SQL** (via `CASE WHEN typeof(col)='blob' THEN ... END`), evitando por completo el paso por el serializador `-json` para esas columnas.
- **REAL/FLOAT con NaN/Infinity**: `JSON.stringify` en JS y `json.dumps` en Python fallan o producen JSON inválido (`NaN` no es JSON estándar) — hay que sanitizar a `null` o string `"NaN"` antes de serializar. **Importante:** SQLite preserva `+Infinity`/`-Infinity` en columnas REAL a través de un ciclo escritura/lectura (a diferencia de `NaN`, que SQLite normaliza a `NULL` al releerlo), y lo mismo pasa con fuentes JSON/NDJSON (`json.loads` acepta los tokens `Infinity`/`-Infinity`/`NaN` aunque no sean JSON estándar). Esta sanitización no aplica solo a `encode_cell()` (valores de fila) — cualquier cálculo agregado sobre la muestra cruda (ej. `min`/`max` de columna) debe excluir o sanear estos valores **antes** de que lleguen a `json.dumps(..., allow_nan=False)`, o el build entero aborta con un `ValueError` no capturado a mitad de escritura del manifest (bug real encontrado y corregido en `sample_stats()`, `lib/util.py`: el min/max se computaba sobre los floats crudos sin pasar por el mismo filtro `math.isfinite()` que ya protegía a `encode_cell()`).
- **Fechas**: SQLite no tiene tipo DATE nativo; suelen guardarse como TEXT ISO8601 (como se vio en `created_at` arriba) o como INTEGER unix timestamp — el extractor no puede asumir, debe pasar el valor crudo y dejar que el visualizador intente parsear/mostrar como texto si no es reconocible.
- **JSON embebido en TEXT** (columnas que guardan JSON serializado, como `copy_files":"[\".env\"]"` visto en la prueba): mantenerlo como string tal cual (no des-serializar automáticamente, ya que puede no ser JSON válido en todas las filas) — opcionalmente ofrecer un "intento de parseo" best-effort en la capa de visualización, no en la de extracción.

### 2.7 Enteros de 64 bits (INTEGER de SQLite) vs. `Number` de JavaScript

SQLite `INTEGER` es de 64 bits con signo (rango completo hasta
`±9223372036854775807`), pero **`JSON.parse()` en el navegador** (lo que usa
`viewer.js` para leer el payload embebido en `#dbviz-data`) convierte todo
número a `Number` de JavaScript, un IEEE-754 double con precisión entera
exacta solo hasta `Number.MAX_SAFE_INTEGER` = `2^53 - 1` =
`9007199254740991`. Un entero SQLite fuera de ese rango (IDs generados por
hash, PIDs de 64 bits, timestamps en nanosegundos, contadores grandes) se
corrompe **silenciosamente** al llegar al cliente — `json.dumps()` en Python
preserva el valor exacto en el *texto* JSON, pero el *parseo* en JS ya no
puede reconstruirlo (`9223372036854775807` se convierte en
`9223372036854776000` tras un ciclo `JSON.stringify`/`JSON.parse` en Node/V8,
el mismo motor que usa cualquier navegador basado en Chromium).

**Mitigación implementada** (`lib/util.py`, `encode_cell()`/`sample_stats()`):
cualquier entero cuyo valor absoluto exceda `Number.MAX_SAFE_INTEGER` se
codifica como `{"__type__":"bigint","value":"<string exacto>"}` en vez de
como número JSON nativo — viaja como texto (sin límite de precisión) y el
visor lo muestra tal cual. Esto es el mismo patrón que ya usa el contrato
para `NaN`/`Infinity` (§2.6): envolver en un objeto tipado en vez de confiar
en la representación numérica nativa cuando esta no puede transportar el
valor sin pérdida.

---

## 3. DuckDB CLI como conversor universal

**No estaba instalado en este entorno** (`duckdb` CLI ausente, módulo Python `duckdb` ausente), por lo que esta sección es documentación de referencia (no pudo probarse en vivo), útil como **capacidad opcional** si el usuario la instala.

### 3.1 Instalación

```bash
# Linux/Mac, script oficial (instala el binario standalone, sin dependencias del sistema)
curl https://install.duckdb.org | sh
# o vía paquete de gestor si existe (brew install duckdb, etc.)
```

### 3.2 Uso como conversor SQLite -> JSON

```bash
duckdb -c "
INSTALL sqlite; LOAD sqlite;
ATTACH 'copia.db' AS src (TYPE sqlite, READ_ONLY);
COPY (SELECT * FROM src.projects) TO 'salida.json' (FORMAT JSON, ARRAY true);
"
```

- `COPY tbl TO 'x.json'` sin opciones exporta NDJSON (una línea JSON por fila); con `(FORMAT JSON, ARRAY true)` exporta un array JSON estándar, más cómodo para consumir en el front del visualizador.
- DuckDB también puede leer directamente CSV/Parquet/JSON con `read_csv_auto()`, `read_parquet()`, `read_json_auto()` y volcarlos al mismo formato intermedio, lo que lo hace útil como **conversor único** para casos no-SQLite si está disponible.
- Ventaja sobre el CLI `sqlite3` puro: tipado más robusto en la exportación JSON (fechas, tipos numéricos) y capacidad de hacer joins entre SQLite y Postgres/CSV en la misma consulta (`ATTACH` múltiple).
- Desventaja: es una dependencia binaria adicional (~30-100MB) que no se puede asumir preinstalada; debe tratarse como "mejora opcional si está disponible" (`which duckdb`), nunca como requisito del flujo principal.

---

## 4. BDs cliente-servidor (Postgres/MySQL) detectadas por config

### 4.1 Señales de detección

| Señal | Ubicación típica |
|---|---|
| `DATABASE_URL=postgres://...` o `mysql://...` | `.env`, `.env.local`, variables de entorno del proceso |
| `dj_database_url.config(...)` / `DATABASES = {...}` | `settings.py` (Django) |
| `config/database.yml` | Raíz de proyecto Rails (`adapter: postgresql`, `host:`, `database:`) |
| `spring.datasource.url` | `application.properties` / `application.yml` (Spring Boot) |
| `DATABASE_URL` en `docker-compose.yml` | servicios `db`/`postgres`/`mysql` |

Parseo del formato `scheme://user:pass@host:port/dbname` es estándar (regex o librería `url`/`urlparse`); **nunca loguear ni persistir la contraseña extraída**, solo usarla en memoria para la conexión puntual y solo si el usuario opta-in explícitamente (ver 4.3).

### 4.2 Extracción de schema + data sin prompts interactivos

Postgres (`psql`/`pg_dump` disponibles en este entorno):
```bash
# Schema-only (para dibujar ER sin credenciales de escritura, requiere solo lectura)
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > schema.sql

# Data en JSON, tabla por tabla, sin interacción (PGPASSWORD via env, no flag -W)
PGPASSWORD="$PASS" psql "$DATABASE_URL" -c "\copy (SELECT row_to_json(t) FROM (SELECT * FROM tabla LIMIT 500) t) TO 'salida.json'"
# o más simple, psql soporta --csv / -A -t para volcar y luego post-procesar
psql "$DATABASE_URL" -X -q -A -t -c "SELECT json_agg(t) FROM (SELECT * FROM tabla LIMIT 500) t;" -o salida.json
```

MySQL (no instalado en este entorno, documentado como referencia):
```bash
mysqldump --no-data --skip-comments "$DB" > schema.sql   # solo estructura
mysql -N -B -e "SELECT * FROM tabla LIMIT 500" "$DB" > salida.tsv   # luego convertir TSV->JSON
```

### 4.3 Decisión de diseño para la fase de implementación

Este modo requiere credenciales reales de conexión (no es "copiar un archivo y listo" como SQLite). Recomendación:
- Tratarlo como **modo opcional y explícito** ("¿querés que intente conectar a la BD de Postgres detectada en tu `.env`? [y/N]"), nunca automático/silencioso.
- Nunca usar prompts interactivos de contraseña bloqueantes en un script pensado para correr desapercibido — o pedir la credencial una vez vía variable de entorno ya presente (`DATABASE_URL` ya trae user:pass) o fallar con un mensaje claro indicando qué falta.
- Si no hay red/credenciales disponibles, degradar automáticamente a "solo mostrar el schema declarado" (ver sección 5) en vez de fallar todo el comando.

---

## 5. Detección de schema declarado por ORM (sin archivo de BD)

Útil para dibujar el ER cuando el proyecto usa una BD remota (no hay archivo local) o cuando el archivo de BD todavía no existe (proyecto recién clonado, antes del primer `migrate`).

| ORM/Framework | Archivo a buscar | Cómo extraer a JSON |
|---|---|---|
| Prisma (Node) | `prisma/schema.prisma` | `@prisma/internals` expone `getDMMF({datamodelPath})` → devuelve DMMF (Data Model Meta Format), un JSON ya estructurado con `datamodel.models[].fields[]`, incluye relaciones y tipos. Es la fuente más limpia de todas porque Prisma ya parsea a JSON internamente. |
| Drizzle (Node) | `drizzle.config.ts` + archivos de esquema TS (`schema.ts`) | No hay un "DMMF" equivalente estable; la vía más confiable es introspección en runtime (`drizzle-kit introspect`) que genera SQL/TS desde una BD real, o parsear el AST de TS con `typescript` compiler API si se quiere hacerlo estáticamente sin conexión — más costoso de implementar. |
| Django | `*/models.py` (o `app.apps.get_models()` en runtime) | Runtime es más confiable: `python manage.py inspectdb` (desde BD real) o iterar `django.apps.apps.get_models()` y leer `model._meta.fields` — requiere que el entorno Python del proyecto esté instalable/activable, no siempre viable desde un script externo genérico. Alternativa estática: grep de `class X(models.Model)` + campos `= models.XField(...)`, más frágil pero sin requerir el entorno del proyecto. |
| Rails | `db/schema.rb` (generado, formato Ruby DSL `create_table "x" do |t| ... end`) | Es texto Ruby pero con estructura muy regular y parseable por regex/línea sin necesidad de un intérprete Ruby completo: `create_table "nombre"` abre tabla, `t.tipo "columna"` son columnas, `add_foreign_key` da FKs. Alternativa más robusta: `rails runner` si Ruby/Rails están instalados en el entorno. |
| SQL crudo | `migrations/*.sql`, `db/migrate/*.rb` (contenido `CREATE TABLE`) | Parsear los `CREATE TABLE ... (...)` con un parser SQL ligero (ej. librería `sql-parser`/`node-sql-parser`) para sacar columnas/tipos/PK/FK sin ejecutar nada. |

Regla general para esta fuente: el resultado es **solo estructura (ER)**, nunca hay filas de datos reales — el visualizador debe distinguir claramente "schema declarado, sin datos" de "datos extraídos de una BD real", para no confundir al usuario.

---

## 6. Otros almacenes basados en archivos

| Formato | Detección | Normalización al JSON intermedio |
|---|---|---|
| JSON simple | archivo `.json` cuyo contenido raíz es un array de objetos u objeto de arrays | Si ya es un array de objetos homogéneos, tratarlo directamente como "una tabla" — inferir columnas de las claves presentes en el primer N de objetos (unión de keys si hay variación). |
| NDJSON | `.ndjson`/`.jsonl`, o `.json` donde cada línea es un objeto JSON independiente | Leer línea por línea (`readline`), parsear cada línea como un registro; mismo tratamiento que JSON array luego de normalizar. |
| CSV/TSV | `.csv`/`.tsv`, detectar separador por sniffing (`,`/`;`/`\t`) | Primera fila como header → nombres de columna; el resto son filas; tipos se infieren (int/float/bool/date/string) analizando una muestra de N filas por columna, igual que se necesita hacer para columnas SQLite de tipado dinámico. |
| lowdb (Node) | `db.json` con estructura `{ "coleccion": [ {...}, {...} ] }` | Es JSON plano — cada clave de nivel raíz cuyo valor es un array de objetos se trata como una "tabla" independiente; útil detectarlo por convención de nombre (`db.json`, `lowdb.json`) + shape del contenido. |

Regla de normalización común a todos: el formato intermedio universal (ver siguiente sección) no distingue "de dónde vino" más allá de metadata — todos terminan como `{ tables: [ { name, columns[], rows[], rowCountTotal, sampled } ] }`.

**Nota — valores anidados (array/objeto) dentro de un registro JSON/NDJSON.** A diferencia de SQLite (§2.6), donde un valor JSON siempre llega como TEXT (string) porque SQLite no tiene tipo array/objeto nativo, en JSON/NDJSON un campo puede ser directamente un `list`/`dict` de Python tras `json.loads()` (ej. `{"id":1,"tags":["new","sale"]}` → `tags` es una `list`, no un string). `encode_cell()` (§2.6, `util.py`) debe serializar ese valor con `json.dumps()` **antes** de aplicar la misma regla de "texto" (truncado si excede `maxCellChars`) — nunca con `str()` de Python, que produce repr con comillas simples (`"['new', 'sale']"`) y no es JSON válido, rompiendo tanto la heurística `jsonLike` como el botón "ver JSON" del visor (que hace `JSON.parse()` sobre el contenido de la celda). La inferencia de tipo de columna (`infer_column_type`) trata estos valores nativos como una categoría propia (`json_native`): una columna 100% array/objeto se clasifica siempre como `inferredType:"json"` con `jsonLike:true`, sin necesitar la heurística de "parsea como JSON" que sí aplica a strings.

---

## 7. Matriz de detección → formato → comando de extracción (resumen ejecutivo)

| Señal detectada | Formato inferido | Confiabilidad | Comando exacto de extracción (probado o documentado) |
|---|---|---|---|
| Primeros 16 bytes = `SQLite format 3\0` | SQLite | Muy alta (probado) | `sqlite3 -readonly copia.db ".tables"` → luego `PRAGMA table_info`, `PRAGMA foreign_key_list`, `.mode json` + `SELECT * LIMIT n` |
| `.db`/`.sqlite`/`.sqlite3` + magic bytes confirmado, con `-wal`/`-shm` presentes | SQLite en modo WAL | Alta (probado) | Copiar los 3 archivos juntos → `sqlite3 copia.db "PRAGMA wal_checkpoint(TRUNCATE);"` → luego extracción normal en modo `mode=ro&immutable=1` |
| `.duckdb` + header propio DuckDB | DuckDB nativo | Media (no probado, sin binario en este entorno) | `duckdb copia.duckdb -c "SELECT * FROM tabla LIMIT 500;" -json` (requiere CLI instalado) |
| `DATABASE_URL=postgres://...` en `.env` o `settings.py`/`docker-compose.yml` | Postgres remoto | Alta para detectar motor, media para poder extraer (depende de red/credenciales) | `pg_dump --schema-only "$DATABASE_URL"` + `psql "$DATABASE_URL" -c "SELECT json_agg(t) FROM (SELECT * FROM tabla LIMIT 500) t;"` (probado el binario existe; no probado contra servidor real por ausencia de uno en este entorno) |
| `DATABASE_URL=mysql://...` o `database.yml` con `adapter: mysql2` | MySQL remoto | Alta detección / media extracción | `mysqldump --no-data "$DB"` + `mysql -N -B -e "SELECT * FROM tabla LIMIT 500" "$DB"` (documentado, mysql no instalado en este entorno) |
| `config/database.yml` con `adapter: sqlite3` | SQLite vía Rails | Alta | Igual que fila 1 sobre el archivo apuntado en `database:` del YAML |
| `prisma/schema.prisma` presente, sin archivo de BD SQLite local accesible | Schema Prisma declarado | Alta | `getDMMF({datamodelPath: 'prisma/schema.prisma'})` de `@prisma/internals` → JSON con modelos/campos/relaciones ya estructurado |
| `db/schema.rb` presente (Rails) | Schema Rails declarado | Media | Parseo por regex de bloques `create_table "x" do |t| ... end` |
| `*/models.py` con `class X(models.Model)` | Schema Django declarado | Media (estático) / Alta (runtime con `inspectdb`) | Estático: grep+regex de clases y campos. Runtime: `python manage.py inspectdb` contra la BD real si hay acceso |
| Archivo `.json` raíz = array de objetos | JSON tabular | Alta | Lectura directa + inferencia de columnas por unión de keys |
| Archivo `.ndjson`/`.jsonl` | NDJSON | Alta | Lectura línea por línea, un `JSON.parse`/`json.loads` por línea |
| Archivo `.csv`/`.tsv` | CSV/TSV | Alta | Sniffing de separador + primera fila como header |
| Archivo `db.json` con shape `{coleccion: [...]}` | lowdb | Media | Igual que JSON tabular, una "tabla" por clave raíz |

---

## 8. Decisiones recomendadas para la fase de implementación (no vinculante, solo insumo)

1. **Prioridad de fuentes de verdad**: archivo SQLite real detectado > servidor Postgres/MySQL con credenciales disponibles > schema de ORM sin datos > JSON/CSV sueltos.
2. **Zero-dependency first**: usar `sqlite3` CLI como camino principal (ya viene en casi todo entorno Linux/Mac de desarrollo) y degradar a Python stdlib si no está; tratar DuckDB, `better-sqlite3` y `node:sqlite` como **aceleradores opcionales**, nunca requisitos duros, dado que ninguno de los tres estaba garantizado presente en este mismo entorno de prueba.
3. **Siempre copiar antes de leer**: nunca abrir el archivo original de la app en producción, incluso en modo read-only — copiar (incluyendo `-wal`/`-shm`) a un directorio de trabajo propio antes de cualquier lectura, exactamente como se hizo en esta investigación.
4. **Marcar claramente en el JSON intermedio** si los datos son: completos vs. muestreados (`sampled: true/false`, `rowCountTotal` vs `rowCountSample`), y si provienen de datos reales vs. solo schema declarado sin filas.
5. **BLOBs y tipos no serializables**: nunca dejar que rompan la extracción completa de una tabla — envolver por fila/columna en try/catch y marcar el valor como `{"__unserializable__": true, "reason": "..."}` en vez de abortar todo el JSON.

---

## Fuentes consultadas

- https://nodejs.org/docs/v22.11.0/api/sqlite.html — `node:sqlite`, `DatabaseSync`, opción `readOnly`.
- https://sqlite.org/uri.html — semántica exacta de `mode=ro` vs `immutable=1` en URIs de SQLite.
- https://github.com/WiseLibs/better-sqlite3/issues/640 — discusión sobre soporte de `immutable` en better-sqlite3.
- https://hoelz.ro/blog/using-sqlites-immutable-and-mode-flags-to-get-around-database-is-locked-error — caso de uso práctico de `immutable=1` para evitar locks.
- https://duckdb.org/docs/lts/guides/file_formats/json_export — `COPY ... TO ... (FORMAT JSON)`.
- https://duckdb.org/docs/current/core_extensions/sqlite — extensión `sqlite` de DuckDB, `ATTACH ... (TYPE sqlite)`.
- https://duckdb.org/docs/lts/sql/statements/attach — sintaxis general de `ATTACH`/`DETACH`.
- https://kennethreitz.org/software/dj-database-url — convención `DATABASE_URL` en Django vía `dj-database-url`.
- https://github.com/prisma/prisma/blob/main/packages/internals/src/engine-commands/getDmmf.ts — `getDMMF` de `@prisma/internals`, fuente del DMMF (JSON estructurado del schema Prisma).
- https://github.com/prisma/prisma/discussions/11006 — cómo parsear/generar programáticamente `schema.prisma`.
