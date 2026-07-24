# Investigación: librerías para un visualizador de bases de datos local y autocontenido

Fecha de investigación: 2026-07-24.
Alcance: comparar librerías de visualización (grids, motores SQL en navegador, diagramas ER, charts) y herramientas existentes, para decidir el stack de un entregable **local, autocontenido, offline** (HTML de doble click o servidor mínimo) que sirva para visualizar bases de datos de cualquier proyecto/stack.

---

## 1. Grids de datos (tablas interactivas)

| Librería | Versión actual (npm, jul-2026) | Licencia | Tamaño aprox. (min+gzip) | Orden/Filtro/Búsqueda | Paginación | Virtual scroll | Vendorizable (copiar JS/CSS al proyecto, sin CDN) | Notas |
|---|---|---|---|---|---|---|---|---|
| **Tabulator** | 6.5.2 | MIT | ~150-200 KB (build completo, JS+CSS); hay builds modulares más chicos | Sí, muy completo (orden multi-columna, filtros por columna, header filter, búsqueda) | Sí, incl. paginación remota | Sí (virtual DOM renderer nativo) | Sí — un solo `tabulator.min.js` + `tabulator.min.css`, cero dependencias, funciona con `<script>` clásico | El más completo de los "gratis sin letra chica": agrupación, árbol, edición inline, export CSV/JSON/XLSX/PDF. No requiere framework. Ideal para un HTML standalone. |
| **AG Grid Community** | 36.0.2 | MIT (Community); Enterprise es de pago/licencia comercial aparte | Más pesado (~250-500 KB según módulos); a partir de v31+ es modular (tree-shaking obligatorio, ya no hay un solo bundle UMD "todo incluido" recomendado) | Sí, excelente rendimiento en datasets grandes | Sí | Sí, el mejor rendimiento de la categoría (virtualización real de filas y columnas) | Parcialmente — el enfoque moderno de AG Grid empuja hacia bundlers (import de módulos); usar un único `<script>` UMD es posible pero ya no es el camino "oficial" y crece el peso si se quiere todo | Motor pensado para apps con build step (React/Vue/Angular). Para un HTML suelto sin bundler, Tabulator es más simple de vendorizar. |
| **DataTables** (datatables.net) | 3.0.0 | MIT | ~50-100 KB core + CSS del tema (DataTables 2.x/3.x ya no requiere jQuery obligatoriamente, aunque el ecosistema de plugins históricamente sí) | Sí, sorting/filtro/búsqueda global clásicos, muy maduro | Sí | No nativo (hay extensión "Scroller" para virtualización, separada) | Sí, fácil de vendorizar como archivos sueltos | Es el más "veterano" y probado (15+ años), enorme cantidad de ejemplos y plugins (export, responsive, fixed columns), pero su virtual scroll es una extensión aparte y su UI por defecto es más básica visualmente. |
| **Grid.js** | 6.2.0 | MIT | El más liviano, pocos KB (motor Preact embebido, ~cientos de líneas) | Sí, sort/búsqueda/paginación básicos | Sí | No (no tiene virtual scroll; para datasets muy grandes hay que paginar) | Sí, trivial de vendorizar (un solo archivo UMD) | Ideal cuando se quiere algo mínimo y bonito por defecto sin configurar mucho, pero se queda corto para tablas de miles de filas sin paginar. |

**Conclusión de la sub-categoría:** para un visualizador que debe abrir tablas de tamaño variable (desde decenas hasta cientos de miles de filas) sin backend, **Tabulator** es el mejor equilibrio: se vendoriza como 2 archivos, no depende de jQuery ni de un bundler, tiene virtual scroll real y cubre orden/filtro/búsqueda/paginación de forma nativa. AG Grid Community es superior en rendimiento puro pero su modelo de distribución moderno (basado en módulos ES) complica el objetivo de "un solo HTML autocontenido sin build step".

---

## 2. Motores SQL/analíticos en el navegador (WASM)

### sql.js
- Versión: **1.14.1**, licencia **MIT**.
- Compila SQLite (C) a WebAssembly vía Emscripten. Permite ejecutar SQL arbitrario sobre un archivo `.sqlite`/`.db` cargado como `Uint8Array` en memoria, 100% en el cliente.
- **Restricción clave**: no puede leer un archivo `.sqlite` directamente desde disco vía `file://` sin interacción del usuario. El patrón de uso real es:
  1. El usuario selecciona el archivo con un `<input type="file">` (esto sí funciona en `file://`, es una API del navegador, no un fetch), y se lee con `FileReader`/`ArrayBuffer`; o
  2. El archivo se **embebe pre-convertido** (p. ej. Base64 o ya como JSON extraído) dentro del propio HTML en tiempo de generación del reporte.
- `fetch()` de un archivo local vía `file://` está bloqueado por la política de seguridad del navegador (no hay servidor, no hay CORS headers) — por eso NO se puede simplemente hacer `fetch('./mi.db')` en un HTML abierto con doble click. Sí funciona si se sirve con un servidor HTTP mínimo (`http-server`, `python -m http.server`, o un pequeño Express embebido).
- La build "WASM con SharedArrayBuffer" (mejor rendimiento, escritura concurrente) exige headers COOP/COEP que solo un servidor puede enviar; la build simple (single-threaded, sin SharedArrayBuffer) funciona sin esos headers y es la apropiada para un HTML standalone.

### DuckDB-WASM
- Versión: **1.33.1-dev** (canal de desarrollo activo), licencia **MIT**.
- Motor analítico (OLAP) completo compilado a WASM. Lee de forma nativa **Parquet, CSV y JSON** (incluso vía HTTP range-requests, sin descargar el archivo entero). Para **SQLite** requiere cargar la extensión `sqlite_scanner` (soporte de compatibilidad, no es su formato nativo).
- Mucho más pesado que sql.js (varios MB de WASM, arquitectura con Web Workers) — justificado si se necesita hacer analítica pesada (agregaciones, joins entre múltiples formatos) pero sobredimensionado solo para "mostrar tablas de una BD".
- Misma restricción de fondo que sql.js respecto a `file://`: requiere que el usuario aporte el archivo (input file / drag&drop) o que haya un servidor sirviendo los bytes.

**Decisión práctica para el objetivo del proyecto:** dado que el flujo real es "el script del proyecto anfitrión ya tiene acceso al filesystem (Node.js) y puede leer la BD directamente con drivers nativos (`better-sqlite3`, `sqlite3` de Python, `pg`, etc.)", **no hace falta motor WASM en el navegador en absoluto**: es más simple, más liviano y más portable **extraer los datos a JSON/formato intermedio en el servidor/script (Node)** y que el HTML final solo consuma ese JSON ya embebido o cargado por HTTP. sql.js/DuckDB-WASM solo aportarían valor si quisiéramos permitir "arrastrar un .db al navegador sin backend"; no es el caso aquí porque el propio comando/script YA corre con acceso a disco.

---

## 3. Diagramas de esquema / ER

| Opción | Versión | Licencia | Vendorizable | Notas |
|---|---|---|---|---|
| **Mermaid** (`erDiagram`) | 11.16.0 | MIT | Sí — un solo `mermaid.min.js` (~800 KB-1 MB sin comprimir, ~250-300 KB gzip), se renderiza a SVG en el cliente sin backend | Sintaxis declarativa de texto → diagrama; soporta `erDiagram` nativo con relaciones (`||--o{`, etc.), atributos y tipos de columna. Es la opción estándar de facto para "generar un diagrama ER a partir de datos" porque el diagrama se arma como texto (fácil de generar programáticamente desde el schema de la BD). |
| drawDB / ChartDB | — (apps web, no librerías embebibles simples) | Open source (variable) | No pensadas para vendorizar como librería; son aplicaciones completas (editor visual) | Buenas como *herramienta externa* para modelar/editar visualmente, pero no encajan como "librería que genero e incrusto en mi reporte HTML". |
| draw.io / diagrams.net | — | Apache-2.0 | Complejo de embeber, pensado como app | Excelente para exportar/editar manualmente, no para generación automática ligera. |

**Conclusión:** **Mermaid `erDiagram`** es la opción correcta: se genera texto simple a partir del `PRAGMA table_info`/`foreign_key_list` (o el equivalente de cada motor de BD) y Mermaid lo renderiza sin backend, con licencia permisiva y tamaño razonable para vendorizar.

---

## 4. Charts básicos para estadísticas de tablas (conteos, distribución de tipos, tamaños, nulls, etc.)

| Librería | Versión | Licencia | Tamaño aprox. (min+gzip) | Fortalezas | Vendorizable |
|---|---|---|---|---|---|
| **Chart.js** | 4.5.1 | MIT | ~60-70 KB | El más simple de usar, API declarativa, suficiente para barras/pie/línea/tiempo — exactamente lo que se necesita para "cantidad de filas por tabla", "distribución de tipos de columna", "tamaño por tabla" | Sí, un solo archivo UMD, cero dependencias runtime |
| **Apache ECharts** | 6.1.0 | Apache-2.0 | ~180-250 KB (build modular) hasta más si se usa el bundle completo | Mucho más potente (miles de puntos, mapas, gráficos 3D, mejor manejo de datasets grandes), pero es "más librería de la que se necesita" para stats simples de un catálogo de tablas | Sí, build UMD disponible |
| **Plotly.js** | 3.7.0 | MIT | El más pesado (varios cientos de KB a >1 MB según build) | Muy potente para exploración científica interactiva (zoom, hover ricos, 3D), pero excesivo para "gráficas de resumen" de un visualizador de esquema | Sí, pero no conviene por peso |

**Conclusión:** para el caso de uso (unas pocas gráficas resumen: filas por tabla, distribución de tipos, top-N valores) **Chart.js** es la opción correcta por tamaño/simplicidad/licencia. ECharts queda como alternativa si en el futuro se quisiera graficar series temporales grandes extraídas de las tablas mismas (no solo metadata).

---

## 5. Herramientas existentes (para no reinventar la rueda) — y por qué igual conviene un tool propio

| Herramienta | Qué hace | Cuándo conviene usarla en vez de construir algo propio | Por qué no cubre el requerimiento tal cual se pidió |
|---|---|---|---|
| **Datasette** | Convierte una BD SQLite en una aplicación web navegable e inspeccionable (tablas, facetas, API JSON, plugins de export) | Cuando el usuario ya tiene Python instalado, la BD ya es SQLite, y está bien correr un proceso servidor persistente (no un HTML de doble click) | Requiere Python + instalar el paquete; está pensado para SQLite (con plugins para otros motores, pero no es "cualquier BD de cualquier stack" out-of-the-box); no genera un artefacto HTML autocontenido para compartir/archivar. |
| **sqlite-web** | UI web tipo phpMyAdmin pero para SQLite (basado en Flask/peewee) | Cuando se quiere editar datos (CRUD) desde el navegador, no solo visualizar | Requiere Python+Flask corriendo; solo SQLite; no es portable a "cualquier lenguaje/BD". |
| **sqlite-utils** | CLI + librería Python para inspeccionar/transformar/cargar datos en SQLite (incluye comandos para volcar a JSON/CSV) | Excelente como *pieza interna* de extracción si el pipeline ya es Python; muy útil para el paso de "extraer a JSON" | No es una interfaz visual en sí misma, y de nuevo, solo SQLite. |
| **DBeaver** | Cliente de escritorio universal (80+ motores de BD), pesado, con IDE completo (edición SQL, ER, export) | Cuando el usuario ya quiere una herramienta de escritorio instalada permanentemente para trabajo profundo de DBA/desarrollo | No es "un script que se corre una vez y genera un artefacto liviano para compartir"; es una instalación de aplicación de escritorio de cientos de MB, sin foco en "reporte HTML portable". |
| **DbGate** | Similar a DBeaver pero más liviano, multi-motor, con modo web y modo escritorio (Electron) | Cuando se quiere algo intermedio entre Beekeeper Studio y DBeaver, con capacidad de correr como servidor web | Sigue siendo una aplicación externa a instalar/mantener, no un artefacto generado por el propio proyecto para ese proyecto en particular. |

**Por qué construir un tool propio sigue siendo la mejor respuesta al requerimiento literal:**
1. El pedido explícito es "un script que se instala UNA vez en un proyecto anfitrión y genera SIEMPRE un artefacto (HTML/servidor mínimo) para CUALQUIER otro proyecto/BD/stack" — ninguna de las herramientas de la tabla anterior está diseñada para "detectar automáticamente archivos de BD de cualquier lenguaje y auto-generar una visualización portable"; todas asumen que el usuario ya sabe qué BD tiene y corre la herramienta manualmente apuntándole.
2. El entregable pedido es **portable y archivable** (un HTML se puede adjuntar a un ticket, mandar por Slack, guardar como snapshot histórico de "cómo se veía la BD en tal fecha"). Datasette/sqlite-web/DBeaver/DbGate generan una *sesión interactiva viva*, no un snapshot autocontenido.
3. El tool propio puede vendorizar exactamente las 3-4 librerías ya evaluadas (Tabulator + Mermaid + Chart.js, sin sql.js/DuckDB-WASM porque la extracción ocurre en el script Node, no en el navegador) y quedar en unos pocos cientos de KB totales, sin depender de Python/Electron/instalaciones adicionales — cumpliendo el requisito de "cualquier stack" porque el *lector* de la BD corre en Node (o llamando a binarios del sistema) mientras que el *visualizador* es HTML/JS puro, agnóstico al lenguaje de origen.
4. Herramientas como sqlite-utils siguen siendo útiles como **referencia de patrones de extracción** (no como dependencia), documentando cómo leer PRAGMA/schema/foreign keys de forma robusta.

---

## Recomendación (stack concreto)

Para el entregable HTML autocontenido / servidor mínimo:

- **Extracción de datos**: 100% en el script/CLI del proyecto anfitrión (Node.js/TypeScript, ya que ese es el runtime de `claude-kanban`), usando el driver nativo de cada motor de BD detectado (p. ej. `better-sqlite3` para `.sqlite/.db`, parseo de `PRAGMA table_info`/`foreign_key_list`/`index_list` para el esquema). El resultado se serializa a un JSON intermedio embebido en el HTML (o cargado por un servidor mínimo Express para datasets grandes) — así se evita por completo la complejidad y las restricciones de `file://`/CORS de sql.js y DuckDB-WASM, que solo tendrían sentido si quisiéramos permitir subir un `.db` arbitrario directamente en el navegador sin backend.
- **Grid de datos**: **Tabulator 6.5.x** (MIT) — vendorizado como `tabulator.min.js` + `tabulator.min.css`, sin dependencias, con orden/filtro/búsqueda/paginación/virtual scroll nativos, suficiente para tablas de cientos de miles de filas.
- **Diagrama de esquema**: **Mermaid 11.x** (`erDiagram`, MIT) — vendorizado como `mermaid.min.js`; el script de extracción genera el texto del diagrama automáticamente a partir de las foreign keys detectadas.
- **Gráficas de estadísticas**: **Chart.js 4.x** (MIT) — vendorizado como archivo único, usado para conteo de filas por tabla, distribución de tipos de columna, tamaños relativos, etc.
- **Motores WASM en navegador (sql.js / DuckDB-WASM)**: **no se incluyen** en la v1 del tool. Se documentan aquí como opción futura *solo* si se quisiera soportar el caso "no tengo el script instalado en el proyecto origen, solo tengo el archivo .db suelto y quiero arrastrarlo a un HTML genérico sin backend" — en ese escenario sql.js (MIT, liviano, ~lo justo para SQLite) sería preferible a DuckDB-WASM (mucho más pesado, pensado para analítica multi-formato) salvo que también se necesite leer Parquet/CSV/JSON grandes con SQL, caso en el que DuckDB-WASM sí justificaría su peso.
- **No usar** Datasette/sqlite-web/DBeaver/DbGate como base del tool: son excelentes herramientas para *usar en paralelo* o recomendar al usuario para trabajo interactivo profundo, pero no cumplen el requisito central de "artefacto portable generado automáticamente para cualquier stack".

Este stack mantiene el entregable en el orden de unos ~400-600 KB totales de librerías vendorizadas (Tabulator + Mermaid + Chart.js, minificadas), sin build step obligatorio para el HTML final, 100% bajo licencias MIT/Apache-2.0 permisivas y compatibles con uso comercial/interno sin restricciones.
