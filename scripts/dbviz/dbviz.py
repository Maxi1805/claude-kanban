#!/usr/bin/env python3
"""
dbviz.py — CLI Python (stdlib-only) del visualizador de bases de datos
reutilizable `dbviz`. Ver scripts/dbviz/README.md para documentación de uso.

Comandos: init | build | detect | serve | open | clean | version | help
Ver SPEC §5 para la interfaz CLI exacta y §8 para códigos de salida.
"""
from __future__ import annotations

import argparse
import copy
import http.server
import json
import os
import platform
import shutil
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import time

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOL_DIR)

from lib import contract, detect as detect_mod, extract_files, extract_sqlite, render, util  # noqa: E402

VERSION_FILE = os.path.join(TOOL_DIR, "VERSION")


def read_version() -> str:
    try:
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "0.0.0"


TOOL_VERSION = read_version()

# ---------------------------------------------------------------------------
# Excepciones de control de flujo -> códigos de salida (SPEC §8/§5.3)
# ---------------------------------------------------------------------------


class UsageError(Exception):
    exit_code = 1


class EngineError(Exception):
    exit_code = 2


class ConfigError(Exception):
    exit_code = 3


class NoExtractableError(Exception):
    exit_code = 4


class IOWriteError(Exception):
    exit_code = 5


# ---------------------------------------------------------------------------
# Config: defaults, merge, validación (SPEC §3)
# ---------------------------------------------------------------------------

DEFAULT_EXCLUDE = [
    "node_modules", ".git", "venv", ".venv", "__pycache__",
    ".cache", "dist", "build", ".next", ".nuxt", ".dbviz",
    "**/Cache/**", "**/nssdb/**",
]


def default_config(project_root: str) -> dict:
    project_name = os.path.basename(os.path.normpath(project_root)) or "project"
    return {
        "configVersion": 1,
        "projectName": project_name,
        "generatedBy": f"dbviz init {TOOL_VERSION}",
        "scan": {
            "roots": ["."],
            "exclude": list(DEFAULT_EXCLUDE),
            "include": [],
            "followSymlinks": False,
            "maxDepth": 8,
            "maxFileSizeMB": 2048,
        },
        "sources": [],
        "extraction": {
            "engine": "auto",
            "maxRowsPerTable": 5000,
            "sampleStrategy": "systematic",
            "maxBlobInlineBytes": 4096,
            "maxCellChars": 20000,
            "mergeWal": True,
            "copyBeforeRead": True,
        },
        "remote": {"enabled": False, "detectOnly": True},
        "output": {
            "dir": ".dbviz",
            "singleFile": True,
            "inlineAssets": True,
            "writeRawJson": True,
        },
        "viewer": {
            "title": f"dbviz — {project_name}",
            "theme": "auto",
            "erDiagram": True,
            "charts": True,
            "defaultTab": "tables",
        },
    }


def _merge_dict_defaults(loaded: dict, defaults: dict, path: str, warnings: list[dict]) -> dict:
    out = dict(defaults)
    for k, v in loaded.items():
        if k not in defaults:
            warnings.append(util.W("W-UNKNOWN-CONFIG-KEY", f"clave desconocida '{path}{k}' en config, se ignora"))
            continue
        if isinstance(v, dict) and isinstance(defaults[k], dict):
            out[k] = _merge_dict_defaults(v, defaults[k], f"{path}{k}.", warnings)
        else:
            out[k] = v
    return out


def load_config(config_path: str, project_root: str) -> tuple[dict, list[dict]]:
    warnings: list[dict] = []
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except json.JSONDecodeError as e:
        raise ConfigError(f"dbviz.config.json inválido (JSON malformado): {e}. Sugerencia: 'init --force'.")
    except OSError as e:
        raise ConfigError(f"no se pudo leer el config: {e}")

    if not isinstance(raw, dict) or raw.get("configVersion") != 1:
        raise ConfigError(
            "dbviz.config.json inválido: falta configVersion=1 o formato incorrecto. "
            "Sugerencia: correr 'init --force'."
        )

    defaults = default_config(project_root)
    merged = _merge_dict_defaults(raw, defaults, "", warnings)
    # sources[] no se mergea campo a campo (es una lista editable por el usuario)
    merged["sources"] = raw.get("sources", [])
    return merged, warnings


def write_config(config_path: str, cfg: dict) -> None:
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except OSError as e:
        raise IOWriteError(f"no se pudo escribir {config_path}: {e}")


def candidates_to_config_sources(candidates: list[dict]) -> list[dict]:
    sources = []
    for c in candidates:
        sources.append({
            "id": c["id"],
            "path": c.get("path"),
            "kind": c["kind"],
            "enabled": c["kind"] not in ("orm-schema", "remote-config"),
            "label": c.get("label") or c.get("id"),
            "detectedBy": c.get("detectedBy", "unknown"),
            "confidence": c.get("confidence", "medium"),
        })
    return sources


# ---------------------------------------------------------------------------
# Motor de extracción y fallbacks (SPEC §1.4)
# ---------------------------------------------------------------------------

def resolve_engine(requested: str) -> dict:
    """Devuelve engine_info dict {name, python, sqliteLib, host} o lanza EngineError."""
    host = sys.platform
    py_version = platform.python_version()

    def _python_ok() -> str | None:
        try:
            return sqlite3.sqlite_version
        except Exception:  # noqa: BLE001
            return None

    def _cli_ok() -> str | None:
        path = shutil.which("sqlite3")
        if not path:
            return None
        try:
            out = subprocess.run(["sqlite3", "-version"], capture_output=True, text=True, timeout=10)
            return out.stdout.strip().split()[0] if out.stdout else "unknown"
        except Exception:  # noqa: BLE001
            return "unknown"

    if requested in ("node", "duckdb"):
        util.log(f"engine '{requested}' no implementado para extracción en v1 (solo documentado); usando 'auto'.")
        requested = "auto"

    if requested == "python":
        v = _python_ok()
        if v is None:
            raise EngineError("E-NOENGINE: python3 no tiene el módulo sqlite3 compilado; probá --engine sqlite3.")
        return {"name": "python-stdlib", "python": py_version, "sqliteLib": v, "host": host}

    if requested == "sqlite3":
        v = _cli_ok()
        if v is None:
            raise EngineError("E-NOENGINE: binario 'sqlite3' no encontrado en PATH.")
        return {"name": "sqlite3-cli", "python": py_version, "sqliteLib": v, "host": host}

    # auto: python-stdlib preferido, sqlite3 CLI como fallback
    v = _python_ok()
    if v is not None:
        return {"name": "python-stdlib", "python": py_version, "sqliteLib": v, "host": host}
    v = _cli_ok()
    if v is not None:
        return {"name": "sqlite3-cli", "python": py_version, "sqliteLib": v, "host": host}
    raise EngineError(
        "E-NOENGINE: ni el módulo Python 'sqlite3' ni el binario 'sqlite3' están disponibles. "
        "Instalá Python 3.8+ (con sqlite3 compilado) o el paquete 'sqlite3' de tu sistema "
        "(ej. 'apt install sqlite3' / 'brew install sqlite3')."
    )


ENGINE_SHORT = {"python-stdlib": "python", "sqlite3-cli": "sqlite3"}


# ---------------------------------------------------------------------------
# Extracción de una fuente (dispatcher por kind)
# ---------------------------------------------------------------------------

def extract_one_source(candidate_cfg: dict, cfg: dict, tmpdir: str, engine_name: str) -> dict:
    id_ = candidate_cfg["id"]
    kind = candidate_cfg["kind"]
    rel_path = candidate_cfg.get("path")
    label = candidate_cfg.get("label") or id_
    detected_by = candidate_cfg.get("detectedBy", "unknown")
    confidence = candidate_cfg.get("confidence", "medium")
    project_root = candidate_cfg["__project_root__"]

    abspath = os.path.abspath(os.path.join(project_root, rel_path)) if rel_path else None
    source = contract.new_source(id_, kind, abspath, label, detected_by, confidence)

    if kind == "sqlite":
        if not abspath or not os.path.isfile(abspath):
            source["error"] = "archivo no encontrado"
            source["extractedAt"] = util.iso_now()
            return source
        forced = ENGINE_SHORT.get(engine_name, "auto") if cfg["extraction"]["engine"] == "auto" else cfg["extraction"]["engine"]
        return extract_sqlite.extract_sqlite(source, cfg, tmpdir, forced_engine=forced)

    if kind in ("json", "ndjson", "csv", "tsv"):
        if not abspath or not os.path.isfile(abspath):
            source["error"] = "archivo no encontrado"
            source["extractedAt"] = util.iso_now()
            return source
        try:
            source["sizeBytes"] = os.path.getsize(abspath)
        except OSError:
            source["sizeBytes"] = None
        try:
            if kind == "json":
                tables = extract_files.extract_json(abspath, cfg)
                warns = []
            elif kind == "ndjson":
                tables, warns = extract_files.extract_ndjson(abspath, cfg)
            else:
                delim = "\t" if kind == "tsv" else None
                tables, warns = extract_files.extract_csv(abspath, cfg, delimiter=delim)
            source["tables"] = tables
            source["warnings"].extend(warns)
            source["hasData"] = True
            source["engineUsed"] = "python-stdlib"
        except ValueError as e:
            source["warnings"].append(util.W("W-JSON-NONTABULAR", str(e)))
            source["hasData"] = False
        except OSError as e:
            source["error"] = f"error de I/O: {e}"
            source["hasData"] = False
        source["extractedAt"] = util.iso_now()
        return source

    if kind == "duckdb":
        source["error"] = "DuckDB detectado pero no soportado en v1 (extensión futura, ver docs/research-extract.md §3)"
        source["hasData"] = False
        source["extractedAt"] = util.iso_now()
        return source

    if kind == "orm-schema":
        source["error"] = None
        source["hasData"] = False
        source["warnings"].append(util.W("W-ORM-NO-DATA", "schema de ORM detectado: solo estructura, sin filas (v1 no lo parsea a tablas)"))
        source["extractedAt"] = util.iso_now()
        return source

    if kind == "remote-config":
        source["error"] = None
        source["hasData"] = False
        source["path"] = None
        source["warnings"].append(util.W("W-REMOTE-NOT-SUPPORTED", "BD remota (Postgres/MySQL) detectada: extracción remota no soportada en v1"))
        source["extractedAt"] = util.iso_now()
        return source

    source["error"] = f"kind desconocido: {kind}"
    source["hasData"] = False
    source["extractedAt"] = util.iso_now()
    return source


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------

def cmd_init(args) -> int:
    project_root = os.path.abspath(args.project or os.getcwd())
    config_path = args.config or os.path.join(project_root, "dbviz.config.json")

    if os.path.exists(config_path) and not args.force:
        raise UsageError(f"{config_path} ya existe. Usá --force para sobrescribir.")

    cfg = default_config(project_root)
    if args.include:
        cfg["scan"]["include"] = list(args.include)
    if args.exclude:
        cfg["scan"]["exclude"] = cfg["scan"]["exclude"] + list(args.exclude)

    util.log(f"detectando fuentes en {project_root} ...")
    candidates = detect_mod.detect(project_root, cfg)
    cfg["sources"] = candidates_to_config_sources(candidates)

    write_config(config_path, cfg)
    util.log(f"config escrito en {config_path}")

    _print_sources_table(candidates)

    if args.build:
        build_args = copy.copy(args)
        build_args.config = config_path
        return cmd_build(build_args)

    print(config_path)
    return 0


def _print_sources_table(candidates: list[dict]) -> None:
    if not candidates:
        print("(no se detectaron fuentes)")
        return
    rows = [("id", "kind", "confidence", "detectedBy", "path")]
    for c in candidates:
        rows.append((c["id"], c["kind"], c["confidence"], c["detectedBy"], c.get("path") or "-"))
    widths = [max(len(r[i]) for r in rows) for i in range(5)]
    for r in rows:
        print("  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(r)))


# ---------------------------------------------------------------------------
# detect (dry-run)
# ---------------------------------------------------------------------------

def cmd_detect(args) -> int:
    project_root = os.path.abspath(args.project or os.getcwd())
    cfg = default_config(project_root)
    config_path = args.config or os.path.join(project_root, "dbviz.config.json")
    if os.path.exists(config_path):
        cfg, _ = load_config(config_path, project_root)
    if args.include:
        cfg["scan"]["include"] = cfg["scan"].get("include", []) + list(args.include)
    if args.exclude:
        cfg["scan"]["exclude"] = cfg["scan"].get("exclude", []) + list(args.exclude)

    candidates = detect_mod.detect(project_root, cfg)
    if args.json_out:
        print(json.dumps(candidates, ensure_ascii=False, indent=2, default=str))
    else:
        _print_sources_table(candidates)
    return 0


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def cmd_build(args) -> int:
    project_root = os.path.abspath(args.project or os.getcwd())
    config_path = args.config or os.path.join(project_root, "dbviz.config.json")

    global_warnings: list[dict] = []
    if os.path.exists(config_path):
        cfg, warns = load_config(config_path, project_root)
        global_warnings.extend(warns)
    else:
        cfg = default_config(project_root)
        util.log("no se encontró dbviz.config.json; usando auto-init en memoria con defaults")
        global_warnings.append(util.W("W-AUTO-INIT", "no se encontró dbviz.config.json; se usó auto-init en memoria con defaults"))
        candidates = detect_mod.detect(project_root, cfg)
        cfg["sources"] = candidates_to_config_sources(candidates)

    # Overrides de CLI (SPEC §3 "Reglas de merge": no reescriben el archivo)
    if args.engine:
        cfg["extraction"]["engine"] = args.engine
    if args.max_rows is not None:
        cfg["extraction"]["maxRowsPerTable"] = args.max_rows
    if args.sample:
        cfg["extraction"]["sampleStrategy"] = args.sample
    if args.out:
        cfg["output"]["dir"] = args.out

    engine_info = resolve_engine(cfg["extraction"]["engine"])
    util.log(f"engine={engine_info['name']} sqlite={engine_info['sqliteLib']}")

    output_dir = os.path.abspath(os.path.join(project_root, cfg["output"]["dir"]))

    sources_cfg = cfg["sources"]
    if args.source:
        wanted = set(args.source)
        sources_cfg = [s for s in sources_cfg if s.get("path") in wanted]

    tmpdir = tempfile.mkdtemp(prefix="dbviz-")
    extracted_sources: list[dict] = []
    try:
        for s in sources_cfg:
            if not s.get("enabled", True):
                continue
            s = dict(s)
            s["__project_root__"] = project_root
            util.log(f"{s['id']} {s.get('path') or '(sin archivo)'}: extrayendo ({s['kind']}) ...")
            result = extract_one_source(s, cfg, tmpdir, engine_info["name"])
            extracted_sources.append(result)
            if result.get("error"):
                util.log(f"{s['id']}: error -> {result['error']}")
            else:
                n_tables = len(result.get("tables", []))
                n_rows = sum(t.get("rowCountSample") or 0 for t in result.get("tables", []))
                n_sampled = sum(1 for t in result.get("tables", []) if t.get("sampled"))
                util.log(f"{s['id']} {n_tables} tablas, {n_rows} filas ({n_sampled} muestreadas)")
    finally:
        if not args.keep_temp:
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            util.log(f"copias temporales conservadas en {tmpdir} (--keep-temp)")

    config_echo = {
        "maxRowsPerTable": cfg["extraction"]["maxRowsPerTable"],
        "sampleStrategy": cfg["extraction"]["sampleStrategy"],
    }
    manifest = contract.build_manifest(
        project_name=cfg.get("projectName", os.path.basename(project_root)),
        project_root=project_root,
        engine_info=engine_info,
        config_echo=config_echo,
        sources=extracted_sources,
        global_warnings=global_warnings,
        tool_version=TOOL_VERSION,
    )

    any_data = any(s.get("hasData") for s in extracted_sources)
    if not any_data and args.strict:
        _write_outputs(output_dir, manifest, extracted_sources, cfg)
        raise NoExtractableError("ninguna fuente pudo extraerse (--strict)")

    index_path = _write_outputs(output_dir, manifest, extracted_sources, cfg)
    print(index_path)
    return 0


def _write_outputs(output_dir: str, manifest: dict, sources: list[dict], cfg: dict) -> str:
    try:
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(os.path.join(output_dir, "data"), exist_ok=True)
    except OSError as e:
        raise IOWriteError(f"no se pudo crear {output_dir}: {e}")

    # Serializar TODO a texto en memoria antes de abrir ningún archivo en modo
    # "w" (que trunca inmediatamente). Así, si json.dumps() fallara por algún
    # valor no serializable que se nos escapó (regla transversal: nunca debería
    # pasar, ver util.encode_cell/sample_stats), la falla ocurre ANTES de tocar
    # disco -- nunca deja un manifest.json/data/*.json truncado a medio
    # escribir (§8, "un error ... jamás aborta el resto / deja el visor
    # anterior intacto").
    try:
        manifest_text = json.dumps(manifest, ensure_ascii=False, allow_nan=False)
        sources_text = None
        if cfg["output"].get("writeRawJson", True):
            sources_text = [
                (s["id"], json.dumps(s, ensure_ascii=False, allow_nan=False)) for s in sources
            ]
    except (TypeError, ValueError) as e:
        raise IOWriteError(f"no se pudo serializar la salida a JSON: {e}")

    try:
        with open(os.path.join(output_dir, ".gitignore"), "w", encoding="utf-8") as f:
            f.write("*\n")

        with open(os.path.join(output_dir, "manifest.json"), "w", encoding="utf-8") as f:
            f.write(manifest_text)

        if sources_text is not None:
            for source_id, text in sources_text:
                with open(os.path.join(output_dir, "data", f"{source_id}.json"), "w", encoding="utf-8") as f:
                    f.write(text)
    except OSError as e:
        raise IOWriteError(f"error de I/O al escribir salida: {e}")

    util.log("render index.html ...")
    html = render.render(manifest, sources, cfg["viewer"])
    index_path = os.path.join(output_dir, "index.html")
    try:
        with open(index_path, "w", encoding="utf-8") as f:
            f.write(html)
    except OSError as e:
        raise IOWriteError(f"error de I/O al escribir {index_path}: {e}")

    size_kb = len(html) // 1024
    util.log(f"render index.html (embebido {size_kb} KB) listo")
    return index_path


# ---------------------------------------------------------------------------
# serve / open / clean / version / help
# ---------------------------------------------------------------------------

def cmd_serve(args) -> int:
    project_root = os.path.abspath(args.project or os.getcwd())
    cfg_dir = ".dbviz"
    config_path = args.config or os.path.join(project_root, "dbviz.config.json")
    if os.path.exists(config_path):
        cfg, _ = load_config(config_path, project_root)
        cfg_dir = cfg["output"]["dir"]
    serve_dir = os.path.abspath(os.path.join(project_root, args.out or cfg_dir))
    if not os.path.isdir(serve_dir):
        raise UsageError(f"{serve_dir} no existe. Corré 'build' primero.")

    os.chdir(serve_dir)
    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        url = f"http://127.0.0.1:{port}/index.html"
        print(url)
        util.log(f"sirviendo {serve_dir} en {url} (Ctrl+C para detener)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


def cmd_open(args) -> int:
    project_root = os.path.abspath(args.project or os.getcwd())
    cfg_dir = ".dbviz"
    config_path = args.config or os.path.join(project_root, "dbviz.config.json")
    if os.path.exists(config_path):
        cfg, _ = load_config(config_path, project_root)
        cfg_dir = cfg["output"]["dir"]
    index_path = os.path.abspath(os.path.join(project_root, args.out or cfg_dir, "index.html"))
    if not os.path.isfile(index_path):
        raise UsageError(f"{index_path} no existe. Corré 'build' primero.")

    opener = shutil.which("xdg-open") or shutil.which("open") or shutil.which("start")
    try:
        if opener:
            subprocess.Popen([opener, index_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            import webbrowser
            webbrowser.open(f"file://{index_path}")
    except Exception as e:  # noqa: BLE001
        util.log_err(f"no se pudo abrir el visor automáticamente: {e}")
    print(index_path)
    return 0


def cmd_clean(args) -> int:
    project_root = os.path.abspath(args.project or os.getcwd())
    cfg_dir = ".dbviz"
    config_path = args.config or os.path.join(project_root, "dbviz.config.json")
    if os.path.exists(config_path):
        try:
            cfg, _ = load_config(config_path, project_root)
            cfg_dir = cfg["output"]["dir"]
        except ConfigError:
            pass
    out_dir = os.path.abspath(os.path.join(project_root, args.out or cfg_dir))
    shutil.rmtree(out_dir, ignore_errors=True)
    util.log(f"borrado {out_dir}")
    return 0


def cmd_version(args) -> int:
    py_v = _describe_python_engine()
    cli_v = _describe_cli_engine()
    if args.json_out:
        print(json.dumps({
            "tool": "dbviz", "version": TOOL_VERSION,
            "engines": {"python-stdlib": py_v, "sqlite3-cli": cli_v},
        }, ensure_ascii=False, indent=2))
    else:
        print(f"dbviz {TOOL_VERSION}")
        print(f"  motor python-stdlib: {py_v or 'no disponible'}")
        print(f"  motor sqlite3-cli:   {cli_v or 'no disponible'}")
        print(f"  duckdb (opcional):   {'disponible' if shutil.which('duckdb') else 'no disponible'}")
    return 0


def _describe_python_engine() -> str | None:
    try:
        return f"python {platform.python_version()} / sqlite {sqlite3.sqlite_version}"
    except Exception:  # noqa: BLE001
        return None


def _describe_cli_engine() -> str | None:
    path = shutil.which("sqlite3")
    if not path:
        return None
    try:
        out = subprocess.run(["sqlite3", "-version"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip()
    except Exception:  # noqa: BLE001
        return "sqlite3 (versión desconocida)"


HELP_TEXT = """\
dbviz — visualizador de bases de datos reutilizable

Uso: dbviz.sh <comando> [flags]

Comandos:
  init [--build]        Detecta fuentes y escribe dbviz.config.json
  build                  Extrae datos y genera .dbviz/index.html
  detect                 Dry-run de detección (no escribe nada)
  serve                  Sirve .dbviz/ con un servidor HTTP mínimo
  open                   Abre .dbviz/index.html con el opener del SO
  clean                  Borra el directorio .dbviz/
  version                Muestra versión y motores disponibles
  help                   Esta ayuda

Flags comunes:
  --project <dir>        Raíz del proyecto objetivo (default: cwd)
  --config <path>        Ruta del config (default: <project>/dbviz.config.json)
  --out <dir>             Directorio de salida (default: .dbviz)
  --engine <auto|python|sqlite3|node|duckdb>
  --max-rows <N>          Override de extraction.maxRowsPerTable
  --sample <full|head|random|systematic>
  --include <glob>        Repetible; fuerza inclusión (init/detect)
  --exclude <glob>        Repetible; agrega exclusión (init/detect)
  --source <path>         Repetible; restringe build a estas fuentes
  --force                 init: sobrescribe config existente
  --keep-temp             build: no borra copias RO temporales
  --strict                build: exit 4 si ninguna fuente se extrajo
  --quiet / -q            Solo errores
  --verbose / -v          Log detallado a stderr
  --json                  Salida JSON (detect/version)
  --help / -h             Esta ayuda

Ver scripts/dbviz/README.md para documentación completa.
"""


def cmd_help(_args) -> int:
    print(HELP_TEXT)
    return 0


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class _Parser(argparse.ArgumentParser):
    def error(self, message):  # noqa: D102 - override exit code a 1 (SPEC §5.3)
        self.print_usage(sys.stderr)
        print(f"{self.prog}: error: {message}", file=sys.stderr)
        raise UsageError(message)


def build_parser() -> _Parser:
    p = _Parser(prog="dbviz", description="Visualizador de bases de datos reutilizable", add_help=True)
    sub = p.add_subparsers(dest="command")

    def common(sp):
        sp.add_argument("--project", default=None)
        sp.add_argument("--config", default=None)
        sp.add_argument("--quiet", "-q", action="store_true")
        sp.add_argument("--verbose", "-v", action="store_true")

    sp = sub.add_parser("init")
    common(sp)
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--build", action="store_true")
    sp.add_argument("--include", action="append", default=[])
    sp.add_argument("--exclude", action="append", default=[])
    sp.add_argument("--engine", default=None)
    sp.add_argument("--max-rows", type=int, default=None, dest="max_rows")
    sp.add_argument("--sample", default=None, choices=["full", "head", "random", "systematic"])
    sp.add_argument("--out", default=None)
    sp.add_argument("--source", action="append", default=[])
    sp.add_argument("--keep-temp", action="store_true", dest="keep_temp")
    sp.add_argument("--strict", action="store_true")
    sp.add_argument("--no-open", action="store_true", dest="no_open")
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("build")
    common(sp)
    sp.add_argument("--out", default=None)
    sp.add_argument("--engine", default=None, choices=["auto", "python", "sqlite3", "node", "duckdb"])
    sp.add_argument("--max-rows", type=int, default=None, dest="max_rows")
    sp.add_argument("--sample", default=None, choices=["full", "head", "random", "systematic"])
    sp.add_argument("--source", action="append", default=[])
    sp.add_argument("--keep-temp", action="store_true", dest="keep_temp")
    sp.add_argument("--strict", action="store_true")
    sp.add_argument("--no-open", action="store_true", dest="no_open")
    sp.set_defaults(func=cmd_build)

    sp = sub.add_parser("detect")
    common(sp)
    sp.add_argument("--include", action="append", default=[])
    sp.add_argument("--exclude", action="append", default=[])
    sp.add_argument("--engine", default=None)
    sp.add_argument("--json", action="store_true", dest="json_out")
    sp.set_defaults(func=cmd_detect)

    sp = sub.add_parser("serve")
    common(sp)
    sp.add_argument("--out", default=None)
    sp.set_defaults(func=cmd_serve)

    sp = sub.add_parser("open")
    common(sp)
    sp.add_argument("--out", default=None)
    sp.set_defaults(func=cmd_open)

    sp = sub.add_parser("clean")
    common(sp)
    sp.add_argument("--out", default=None)
    sp.set_defaults(func=cmd_clean)

    sp = sub.add_parser("version")
    common(sp)
    sp.add_argument("--json", action="store_true", dest="json_out")
    sp.set_defaults(func=cmd_version)

    sp = sub.add_parser("help")
    sp.set_defaults(func=cmd_help)

    return p


def main(argv: list[str]) -> int:
    parser = build_parser()
    if not argv:
        cmd_help(None)
        return 0
    try:
        args = parser.parse_args(argv)
    except UsageError as e:
        return e.exit_code

    if args.command is None:
        cmd_help(args)
        return 0

    util.set_log_level(getattr(args, "quiet", False), getattr(args, "verbose", False))

    try:
        return args.func(args)
    except UsageError as e:
        util.log_err(str(e))
        return e.exit_code
    except EngineError as e:
        util.log_err(str(e))
        return e.exit_code
    except ConfigError as e:
        util.log_err(str(e))
        return e.exit_code
    except NoExtractableError as e:
        util.log_err(str(e))
        return e.exit_code
    except IOWriteError as e:
        util.log_err(str(e))
        return e.exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
