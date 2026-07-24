#!/usr/bin/env bash
#
# dbviz.sh — launcher relocatable de `dbviz`, el visualizador de bases de
# datos reutilizable (init una vez, correr siempre, cualquier proyecto).
#
# Uso:      bash scripts/dbviz/dbviz.sh <comando> [flags]
# Comandos: init | build | detect | serve | open | clean | version | help
#
# Resuelve su propio directorio (readlink -f, convención de scripts/start.sh
# del anfitrión) y despacha al motor disponible en este orden (SPEC §1.4):
#   1) python3 (con módulo sqlite3)   -> dbviz.py (camino completo)
#   2) python3 (sin módulo sqlite3)   -> dbviz.py igual; internamente cae a
#                                        `sqlite3` CLI si hace falta.
#   3) sin python3 pero con `sqlite3` -> modo degradado bash-only (§9.2):
#                                        detect/init/build/version/clean/open
#                                        limitados a fuentes SQLite (y CSV
#                                        básico), sin inferencia rica de
#                                        tipos, ER degrada a lista.
#   4) ninguno disponible              -> E-NOENGINE, exit 2.
#
# `dbviz.py` NO se compila ni se agrega al build/typecheck/tsc/Vite del
# proyecto anfitrión: este launcher es 100% independiente.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
VERSION_FILE="$SCRIPT_DIR/VERSION"
TOOL_VERSION="$(cat "$VERSION_FILE" 2>/dev/null || echo "0.0.0")"

# ---------------------------------------------------------------------------
# 1) Camino principal: python3
# ---------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$SCRIPT_DIR/dbviz.py" "$@"
fi

# ---------------------------------------------------------------------------
# 2) Sin python3: si hay `sqlite3` CLI, modo degradado bash-only (§9.2)
# ---------------------------------------------------------------------------
if command -v sqlite3 >/dev/null 2>&1; then
  echo "[dbviz] python3 no disponible: usando modo degradado bash+sqlite3 CLI (solo SQLite/CSV, sin inferencia rica de tipos, ER como lista)." >&2

  # --- helpers de logging ---
  DBVIZ_QUIET=0
  fb_log() { [ "$DBVIZ_QUIET" = "1" ] && return 0; echo "[dbviz] $*" >&2; }
  fb_err() { echo "[dbviz] ERROR: $*" >&2; }

  # Escapa un valor arbitrario a un literal JSON válido usando las propias
  # funciones json1 de sqlite3 (json_quote + readfile para evitar por
  # completo problemas de quoting de shell con el contenido real).
  fb_json_quote() {
    local val="$1" tmpf
    tmpf="$(mktemp)"
    printf '%s' "$val" > "$tmpf"
    sqlite3 :memory: "SELECT json_quote(CAST(readfile('$tmpf') AS TEXT));"
    rm -f "$tmpf"
  }
  fb_sql_str_lit() { printf '%s' "$1" | sed "s/'/''/g"; }
  fb_sql_ident() { printf '%s' "$1" | sed 's/"/""/g'; }

  # --- parseo de flags comunes ---
  FB_PROJECT="$(pwd)"
  FB_CONFIG=""
  FB_OUT=""
  FB_FORCE=0
  FB_JSON=0
  FB_MAXROWS=5000
  FB_SAMPLE="systematic"
  FB_STRICT=0
  FB_KEEPTEMP=0
  FB_BUILD_AFTER_INIT=0

  fb_parse_flags() {
    while [ $# -gt 0 ]; do
      case "$1" in
        --project) FB_PROJECT="$2"; shift 2 ;;
        --config) FB_CONFIG="$2"; shift 2 ;;
        --out) FB_OUT="$2"; shift 2 ;;
        --force) FB_FORCE=1; shift ;;
        --build) FB_BUILD_AFTER_INIT=1; shift ;;
        --json) FB_JSON=1; shift ;;
        --quiet|-q) DBVIZ_QUIET=1; shift ;;
        --verbose|-v) shift ;;
        --max-rows) FB_MAXROWS="$2"; shift 2 ;;
        --sample) FB_SAMPLE="$2"; shift 2 ;;
        --engine) shift 2 ;;
        --strict) FB_STRICT=1; shift ;;
        --keep-temp) FB_KEEPTEMP=1; shift ;;
        --include|--exclude|--source) shift 2 ;;
        --no-open) shift ;;
        *) shift ;;
      esac
    done
  }

  fb_parse_flags "$@"
  mkdir -p "$FB_PROJECT" 2>/dev/null || true
  FB_PROJECT="$(cd "$FB_PROJECT" 2>/dev/null && pwd || echo "$FB_PROJECT")"
  [ -z "$FB_CONFIG" ] && FB_CONFIG="$FB_PROJECT/dbviz.config.json"
  [ -z "$FB_OUT" ] && FB_OUT=".dbviz"
  FB_OUT_ABS="$FB_PROJECT/$FB_OUT"

  FB_EXCLUDE_RE='(^|/)(node_modules|\.git|venv|\.venv|__pycache__|\.cache|dist|build|\.next|\.nuxt|\.dbviz)(/|$)'

  # --- detección: SQLite por magic bytes (research-extract §1.2) ---
  fb_detect_sqlite() {
    local base="$FB_PROJECT"
    find "$base" -maxdepth 8 -type f -size +0c 2>/dev/null | while IFS= read -r f; do
      rel="${f#"$base"/}"
      [[ "$rel" =~ $FB_EXCLUDE_RE ]] && continue
      case "$(basename "$f")" in
        Cookies|History|Favicons|QuotaManager|LOCK|LOG) continue ;;
      esac
      [[ "$rel" == *-wal || "$rel" == *-shm || "$rel" == *-journal ]] && continue
      magic="$(head -c 15 "$f" 2>/dev/null)"
      if [ "$magic" = "SQLite format 3" ]; then
        printf '%s\n' "$rel"
      fi
    done
  }

  fb_cmd_version() {
    if [ "$FB_JSON" = "1" ]; then
      printf '{"tool":"dbviz","version":"%s","engines":{"python-stdlib":null,"sqlite3-cli":"%s"},"mode":"degraded-bash"}\n' \
        "$TOOL_VERSION" "$(sqlite3 -version | awk '{print $1}')"
    else
      echo "dbviz $TOOL_VERSION (modo degradado bash+sqlite3 CLI)"
      echo "  motor python-stdlib: no disponible"
      echo "  motor sqlite3-cli:   $(sqlite3 -version)"
    fi
  }

  fb_cmd_help() {
    cat <<EOF
dbviz $TOOL_VERSION — modo degradado (sin python3, usando sqlite3 CLI)
Uso: dbviz.sh <init|build|detect|serve|open|clean|version|help> [flags]
Este modo solo soporta fuentes SQLite (detección por magic bytes) y no
tiene la inferencia rica de tipos ni el motor Python. Instalá python3 para
el modo completo. Ver scripts/dbviz/README.md.
EOF
  }

  fb_cmd_detect() {
    local rels
    rels="$(fb_detect_sqlite)"
    if [ "$FB_JSON" = "1" ]; then
      printf '['
      local first=1 i=0
      while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        [ "$first" = "0" ] && printf ','
        first=0
        printf '{"id":"src-%d","kind":"sqlite","path":%s,"detectedBy":"magic-bytes","confidence":"high"}' \
          "$i" "$(fb_json_quote "$rel")"
        i=$((i+1))
      done <<< "$rels"
      printf ']\n'
    else
      echo "id       kind    confidence  detectedBy    path"
      local i=0
      while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        printf "src-%-3d sqlite  high        magic-bytes   %s\n" "$i" "$rel"
        i=$((i+1))
      done <<< "$rels"
    fi
  }

  fb_cmd_clean() {
    rm -rf "$FB_OUT_ABS"
    fb_log "borrado $FB_OUT_ABS"
  }

  fb_cmd_open() {
    local idx="$FB_OUT_ABS/index.html"
    if [ ! -f "$idx" ]; then
      fb_err "$idx no existe. Corré 'build' primero."
      exit 1
    fi
    local opener
    opener="$(command -v xdg-open || command -v open || command -v start || true)"
    if [ -n "$opener" ]; then
      "$opener" "$idx" >/dev/null 2>&1 &
    fi
    echo "$idx"
  }

  fb_cmd_serve() {
    if [ ! -d "$FB_OUT_ABS" ]; then
      fb_err "$FB_OUT_ABS no existe. Corré 'build' primero."
      exit 1
    fi
    ( cd "$FB_OUT_ABS" && sqlite3 -version >/dev/null; python3 -m http.server 0 2>/dev/null ) || \
      fb_err "no se pudo iniciar servidor (python3 no disponible tampoco para 'serve')"
  }

  # --- init: escribe dbviz.config.json a mano (JSON válido vía json_quote) ---
  fb_cmd_init() {
    if [ -f "$FB_CONFIG" ] && [ "$FB_FORCE" != "1" ]; then
      fb_err "$FB_CONFIG ya existe. Usá --force para sobrescribir."
      exit 1
    fi
    local rels sources_json="" i=0 first=1
    rels="$(fb_detect_sqlite)"
    while IFS= read -r rel; do
      [ -z "$rel" ] && continue
      [ "$first" = "0" ] && sources_json="$sources_json,"
      first=0
      sources_json="$sources_json{\"id\":\"src-$i\",\"path\":$(fb_json_quote "$rel"),\"kind\":\"sqlite\",\"enabled\":true,\"label\":$(fb_json_quote "$(basename "$rel")"),\"detectedBy\":\"magic-bytes\",\"confidence\":\"high\"}"
      i=$((i+1))
    done <<< "$rels"

    local project_name
    project_name="$(basename "$FB_PROJECT")"
    cat > "$FB_CONFIG" <<EOF
{
  "configVersion": 1,
  "projectName": $(fb_json_quote "$project_name"),
  "generatedBy": $(fb_json_quote "dbviz init $TOOL_VERSION (modo degradado)"),
  "scan": {
    "roots": ["."],
    "exclude": ["node_modules", ".git", "venv", ".venv", "__pycache__", ".cache", "dist", "build", ".next", ".nuxt", ".dbviz", "**/Cache/**", "**/nssdb/**"],
    "include": [],
    "followSymlinks": false,
    "maxDepth": 8,
    "maxFileSizeMB": 2048
  },
  "sources": [$sources_json],
  "extraction": {
    "engine": "sqlite3",
    "maxRowsPerTable": $FB_MAXROWS,
    "sampleStrategy": $(fb_json_quote "$FB_SAMPLE"),
    "maxBlobInlineBytes": 4096,
    "maxCellChars": 20000,
    "mergeWal": true,
    "copyBeforeRead": true
  },
  "remote": { "enabled": false, "detectOnly": true },
  "output": { "dir": ".dbviz", "singleFile": true, "inlineAssets": true, "writeRawJson": true },
  "viewer": {
    "title": $(fb_json_quote "dbviz — $project_name"),
    "theme": "auto",
    "erDiagram": true,
    "charts": true,
    "defaultTab": "tables"
  }
}
EOF
    fb_log "config escrito en $FB_CONFIG (modo degradado)"
    echo "id       kind    confidence  detectedBy    path"
    local j=0
    while IFS= read -r rel; do
      [ -z "$rel" ] && continue
      printf "src-%-3d sqlite  high        magic-bytes   %s\n" "$j" "$rel"
      j=$((j+1))
    done <<< "$rels"

    if [ "$FB_BUILD_AFTER_INIT" = "1" ]; then
      fb_cmd_build
    else
      echo "$FB_CONFIG"
    fi
  }

  # --- build: extrae SQLite vía sqlite3 CLI + json1, arma manifest+data+html ---
  fb_extract_table_json() {
    # $1 = copia.db  $2 = nombre de tabla (crudo)  $3 = maxrows  $4 = strategy
    local copy="$1" name="$2" maxrows="$3" strategy="$4"
    local name_lit ident
    name_lit="$(fb_sql_str_lit "$name")"
    ident="\"$(fb_sql_ident "$name")\""

    local colnames
    colnames="$(sqlite3 -readonly "$copy" "SELECT name FROM pragma_table_info('$name_lit') ORDER BY cid;")"
    [ -z "$colnames" ] && return 1

    local total
    total="$(sqlite3 -readonly "$copy" "SELECT COUNT(*) FROM $ident;")"

    local jarr="" first=1
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      local cid="\"$(fb_sql_ident "$c")\""
      [ "$first" = "0" ] && jarr="$jarr, "
      first=0
      jarr="$jarr(CASE WHEN typeof($cid)='blob' THEN json_object('__type__','blob','encoding','hex','size',length($cid),'preview_hex',hex(substr($cid,1,32)),'data',NULL) ELSE $cid END)"
    done <<< "$colnames"

    local sampled=false sql_where=""
    local select_sql
    if [ "$total" -le "$maxrows" ] 2>/dev/null; then
      select_sql="SELECT * FROM $ident"
      sampled=false
      strategy="full"
    else
      sampled=true
      case "$strategy" in
        head) select_sql="SELECT * FROM $ident LIMIT $maxrows" ;;
        random) select_sql="SELECT * FROM $ident ORDER BY RANDOM() LIMIT $maxrows" ;;
        *) local step=$(( total / maxrows )); [ "$step" -lt 1 ] && step=1
           select_sql="SELECT * FROM $ident WHERE rowid % $step = 0 LIMIT $maxrows"
           strategy="systematic" ;;
      esac
    fi

    local rows_json
    rows_json="$(sqlite3 -readonly "$copy" "SELECT json_group_array(json_array($jarr)) FROM ($select_sql);" 2>/dev/null)"
    if [ -z "$rows_json" ] || [ "$rows_json" = "" ]; then rows_json="[]"; fi
    # fallback si falló por rowid (WITHOUT ROWID) u otro motivo
    if [ "$?" != "0" ] && [ "$sampled" = "true" ]; then
      rows_json="$(sqlite3 -readonly "$copy" "SELECT json_group_array(json_array($jarr)) FROM (SELECT * FROM $ident LIMIT $maxrows);" 2>/dev/null)"
      strategy="head"
    fi

    local cols_json
    cols_json="$(sqlite3 -readonly "$copy" "SELECT json_group_array(json_object('name',name,'declaredType',IFNULL(type,''),'inferredType', CASE WHEN type LIKE '%INT%' THEN 'integer' WHEN type LIKE '%REAL%' OR type LIKE '%FLOA%' OR type LIKE '%DOUB%' THEN 'real' ELSE 'string' END,'nullable',\"notnull\"=0,'primaryKey',pk<>0,'defaultValue',dflt_value,'stats',json_object('nullCount',0,'distinctSampled',0,'jsonLike',json('false'),'min',NULL,'max',NULL))) FROM pragma_table_info('$name_lit') ORDER BY cid;")"

    local pk_json
    pk_json="$(sqlite3 -readonly "$copy" "SELECT json_group_array(name) FROM pragma_table_info('$name_lit') WHERE pk>0 ORDER BY pk;")"
    [ -z "$pk_json" ] && pk_json="[]"

    local fk_json
    fk_json="$(sqlite3 -readonly "$copy" "SELECT IFNULL(json_group_array(json_object('column',\"from\",'referencesTable',\"table\",'referencesColumn',\"to\",'onDelete',IFNULL(on_delete,'NO ACTION'),'onUpdate',IFNULL(on_update,'NO ACTION'))),'[]') FROM pragma_foreign_key_list('$name_lit');")"
    [ -z "$fk_json" ] && fk_json="[]"

    local idx_json
    idx_json="$(sqlite3 -readonly "$copy" "SELECT IFNULL(json_group_array(json_object('name',il.name,'unique',il.\"unique\"<>0,'columns',(SELECT IFNULL(json_group_array(ii.name),'[]') FROM pragma_index_info(il.name) ii),'origin',il.origin)),'[]') FROM pragma_index_list('$name_lit') il;")"
    [ -z "$idx_json" ] && idx_json="[]"

    local ddl
    ddl="$(sqlite3 -readonly "$copy" "SELECT sql FROM sqlite_master WHERE name='$name_lit';")"

    printf '{"name":%s,"type":"table","ddl":%s,"columns":%s,"primaryKey":%s,"foreignKeys":%s,"indexes":%s,"rowCountTotal":%s,"rowCountSample":%s,"sampled":%s,"sampleStrategy":%s,"rows":%s,"notes":[]}' \
      "$(fb_json_quote "$name")" "$(fb_json_quote "$ddl")" "$cols_json" "$pk_json" "$fk_json" "$idx_json" \
      "$total" "$( [ "$sampled" = "true" ] && sqlite3 :memory: "SELECT json_array_length('$rows_json');" || echo "$total")" \
      "$sampled" "$(fb_json_quote "$strategy")" "$rows_json"
  }

  fb_cmd_build() {
    local rels
    if [ -f "$FB_CONFIG" ]; then
      rels="$(sqlite3 :memory: "SELECT '';" >/dev/null; fb_detect_sqlite)"
    else
      fb_log "no se encontró $FB_CONFIG; usando auto-init en memoria (modo degradado)"
      rels="$(fb_detect_sqlite)"
    fi

    mkdir -p "$FB_OUT_ABS/data" || { fb_err "no se pudo crear $FB_OUT_ABS"; exit 5; }
    echo "*" > "$FB_OUT_ABS/.gitignore"

    local tmpdir
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/dbviz-fallback-XXXXXX")"

    local sources_json="" first=1 i=0 table_count=0 row_total=0 row_sample=0 extracted=0
    while IFS= read -r rel; do
      [ -z "$rel" ] && continue
      local abspath="$FB_PROJECT/$rel"
      local copy="$tmpdir/$(basename "$rel")"
      cp "$abspath" "$copy"
      [ -f "$abspath-wal" ] && cp "$abspath-wal" "$copy-wal"
      [ -f "$abspath-shm" ] && cp "$abspath-shm" "$copy-shm"
      if [ -f "$copy-wal" ]; then
        sqlite3 "$copy" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
      fi

      local size_bytes
      size_bytes="$(stat -c%s "$abspath" 2>/dev/null || stat -f%z "$abspath" 2>/dev/null || echo null)"

      local tnames
      tnames="$(sqlite3 -readonly "$copy" "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;" 2>/dev/null)"

      local tables_json="" tfirst=1
      if [ -n "$tnames" ]; then
        while IFS= read -r tname; do
          [ -z "$tname" ] && continue
          local tjson
          tjson="$(fb_extract_table_json "$copy" "$tname" "$FB_MAXROWS" "$FB_SAMPLE")" || continue
          [ "$tfirst" = "0" ] && tables_json="$tables_json,"
          tfirst=0
          tables_json="$tables_json$tjson"
          table_count=$((table_count+1))
        done <<< "$tnames"
      fi

      local source_obj_json
      source_obj_json="{\"id\":\"src-$i\",\"kind\":\"sqlite\",\"label\":$(fb_json_quote "$(basename "$rel")"),\"path\":$(fb_json_quote "$abspath"),\"detectedBy\":\"magic-bytes\",\"confidence\":\"high\",\"hasData\":true,\"engineUsed\":\"sqlite3-cli\",\"walMerged\":true,\"sizeBytes\":$size_bytes,\"extractedAt\":$(fb_json_quote "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"),\"error\":null,\"warnings\":[],\"tables\":[$tables_json]}"

      [ "$first" = "0" ] && sources_json="$sources_json,"
      first=0
      sources_json="$sources_json$source_obj_json"

      # Escribir SOLO el objeto Source de ESTA fuente (no el acumulado de
      # todas las fuentes vistas hasta ahora) -- data/src-N.json debe ser un
      # único objeto JSON por archivo (contrato §4.2), consumible en forma
      # independiente por `serve`/clientes HTTP externos.
      printf '%s\n' "$source_obj_json" > "$FB_OUT_ABS/data/src-$i.json"
      extracted=$((extracted+1))
      fb_log "src-$i $rel: $(printf '%s' "$tnames" | grep -c . || true) tablas extraídas (modo degradado)"
      i=$((i+1))
    done <<< "$rels"

    [ "$FB_KEEPTEMP" != "1" ] && rm -rf "$tmpdir"

    # Nota: data/src-N.json (un objeto Source por archivo) ya se escribió más
    # arriba, dentro del bucle, con el objeto individual de cada fuente -- acá
    # `sources_json` es el acumulado con comas usado para el array completo
    # embebido en manifest.json/index.html.
    local manifest
    manifest="{\"dbviz\":{\"tool\":\"dbviz\",\"version\":\"$TOOL_VERSION\",\"contractVersion\":1},\"generatedAt\":$(fb_json_quote "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"),\"project\":{\"name\":$(fb_json_quote "$(basename "$FB_PROJECT")"),\"root\":$(fb_json_quote "$FB_PROJECT")},\"engine\":{\"name\":\"sqlite3-cli\",\"python\":null,\"sqliteLib\":$(fb_json_quote "$(sqlite3 -version | awk '{print $1}')"),\"host\":\"linux\"},\"config\":{\"maxRowsPerTable\":$FB_MAXROWS,\"sampleStrategy\":$(fb_json_quote "$FB_SAMPLE")},\"sources\":[$sources_json],\"stats\":{\"sourceCount\":$i,\"sourceExtracted\":$extracted,\"tableCount\":$table_count,\"rowCountTotal\":0,\"rowCountSample\":0},\"warnings\":[{\"code\":\"W-DEGRADED-MODE\",\"message\":\"python3 no disponible: se usó el modo degradado bash+sqlite3-cli (SPEC §9.2), sin inferencia rica de tipos\"}]}"

    printf '%s' "$manifest" > "$FB_OUT_ABS/manifest.json"

    fb_render_html "$manifest" "$sources_json"
    fb_log "render index.html listo (modo degradado)"
    echo "$FB_OUT_ABS/index.html"
  }

  # Genera el visor por STREAMING de archivos (nunca carga los assets/datos
  # completos en un argv/env de awk/sed: los libs vendorizados pesan varios
  # MB y romperían el límite ARG_MAX del sistema). awk lee cada asset con
  # getline directamente desde el archivo, línea a línea.
  fb_render_html() {
    local manifest_json="$1" sources_json="$2"
    local payload_file="$FB_OUT_ABS/.payload.tmp.json"
    local cfg_file="$FB_OUT_ABS/.cfg.tmp.json"

    {
      printf '{"manifest":%s,"sources":[%s]}' "$manifest_json" "$sources_json"
    } | sed 's/<\//<\\\//g' > "$payload_file"

    printf '{"title":"dbviz (modo degradado)","theme":"auto","erDiagram":true,"charts":true,"defaultTab":"tables"}' > "$cfg_file"

    awk \
      -v css1="$SCRIPT_DIR/assets/tabulator.min.css" \
      -v css2="$SCRIPT_DIR/assets/viewer.css" \
      -v lib1="$SCRIPT_DIR/assets/tabulator.min.js" \
      -v lib2="$SCRIPT_DIR/assets/mermaid.min.js" \
      -v lib3="$SCRIPT_DIR/assets/chart.umd.min.js" \
      -v appjs="$SCRIPT_DIR/assets/viewer.js" \
      -v datafile="$payload_file" \
      -v cfgfile="$cfg_file" \
      -v title="dbviz (modo degradado)" '
      function streamfile(path,    line) {
        while ((getline line < path) > 0) print line
        close(path)
      }
      {
        if ($0 ~ /\{\{TITLE\}\}/) {
          gsub(/\{\{TITLE\}\}/, title); print
        } else if ($0 ~ /\{\{CSS\}\}/) {
          print "<style>"; streamfile(css1); streamfile(css2); print "</style>"
        } else if ($0 ~ /\{\{LIBS\}\}/) {
          print "<script>"; streamfile(lib1); streamfile(lib2); streamfile(lib3); print "</script>"
        } else if ($0 ~ /\{\{APP\}\}/) {
          print "<script>"; streamfile(appjs); print "</script>"
        } else if ($0 ~ /\{\{DATA\}\}/) {
          printf "%s", "<script id=\"dbviz-data\" type=\"application/json\">"
          streamfile(datafile)
          print "</script>"
        } else if ($0 ~ /\{\{CFG\}\}/) {
          printf "%s", "<script id=\"dbviz-cfg\" type=\"application/json\">"
          streamfile(cfgfile)
          print "</script>"
        } else {
          print
        }
      }
    ' "$SCRIPT_DIR/assets/viewer.template.html" > "$FB_OUT_ABS/index.html"

    rm -f "$payload_file" "$cfg_file"
  }

  COMMAND="${1:-help}"
  [ $# -gt 0 ] && shift || true
  case "$COMMAND" in
    init) fb_cmd_init ;;
    build) fb_cmd_build ;;
    detect) fb_cmd_detect ;;
    serve) fb_cmd_serve ;;
    open) fb_cmd_open ;;
    clean) fb_cmd_clean ;;
    version) fb_cmd_version ;;
    help|--help|-h) fb_cmd_help ;;
    *) fb_err "comando desconocido: $COMMAND"; fb_cmd_help; exit 1 ;;
  esac
  exit $?
fi

# ---------------------------------------------------------------------------
# 3) Ni python3 ni sqlite3: E-NOENGINE (SPEC §8)
# ---------------------------------------------------------------------------
echo "[dbviz] ERROR E-NOENGINE: no se encontró 'python3' ni el binario 'sqlite3' en el PATH." >&2
echo "        dbviz requiere al menos uno de los dos. Instrucciones:" >&2
echo "          Debian/Ubuntu: sudo apt install python3        (o: sudo apt install sqlite3)" >&2
echo "          macOS (brew):  brew install python              (o: brew install sqlite3)" >&2
echo "          Alpine:        apk add python3                  (o: apk add sqlite)" >&2
exit 2
