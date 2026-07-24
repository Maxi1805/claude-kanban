"""
lib/detect.py — detección multi-formato de fuentes de datos (SPEC §6.1).

Prueba definitiva para SQLite: magic bytes (primeros 16 bytes ==
"SQLite format 3\x00"). Extensión de archivo es señal secundaria, nunca
suficiente por sí sola (research-extract §1.1/§1.3).
"""
from __future__ import annotations

import csv
import io
import json
import os

from . import schema_orm, util

SQLITE_MAGIC = b"SQLite format 3\x00"
DUCKDB_MAGIC_OFFSET8 = b"DUCK"

NOISE_NAMES = {"Cookies", "History", "Favicons", "QuotaManager", "LOCK", "LOG"}
DB_EXTS = {".db", ".sqlite", ".sqlite3", ".duckdb"}
FILE_EXTS = {".json", ".ndjson", ".jsonl", ".csv", ".tsv"}


def _read_first_bytes(path: str, n: int) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read(n)
    except OSError:
        return b""


def _read_bytes_at(path: str, offset: int, n: int) -> bytes:
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read(n)
    except OSError:
        return b""


def classify_textfile(path: str, ext: str):
    """(kind, confidence) o (None, None). research-extract §6."""
    if ext in (".csv", ".tsv"):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                sample = f.read(8192)
        except OSError:
            return None, None
        if not sample.strip():
            return None, None
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
            delim = dialect.delimiter
        except csv.Error:
            delim = "\t" if ext == ".tsv" else ","
        kind = "tsv" if delim == "\t" else "csv"
        return kind, "high"

    if ext in (".json",):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                data = json.load(f)
        except (OSError, ValueError):
            # puede ser NDJSON con extensión .json
            if _looks_like_ndjson(path):
                return "ndjson", "medium"
            return None, None
        if isinstance(data, list):
            return "json", "high"
        if isinstance(data, dict) and data and all(
                isinstance(v, list) for v in data.values() if v is not None):
            return "json", "medium"
        return None, None

    if ext in (".ndjson", ".jsonl"):
        if _looks_like_ndjson(path):
            return "ndjson", "high"
        return None, None

    return None, None


_NDJSON_SAMPLE_LINES = 20
_NDJSON_MIN_VALID_RATIO = 0.5


def _looks_like_ndjson(path: str) -> bool:
    """True si una MAYORÍA de las líneas no vacías muestreadas parsean como JSON.

    Antes se descartaba el archivo ENTERO (sin warning, invisible para
    detect/init/build) si CUALQUIERA de las primeras 5 líneas fallaba --
    inconsistente con la extracción real (extract_ndjson) que sí tolera
    líneas inválidas individuales y emite W-NDJSON-LINE por cada una. Un
    archivo NDJSON real con una sola línea truncada (log tras un corte/crash)
    debe seguir detectándose como tal.
    """
    total = 0
    valid = 0
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for _ in range(_NDJSON_SAMPLE_LINES):
                line = f.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                total += 1
                try:
                    json.loads(line)
                    valid += 1
                except ValueError:
                    pass
    except OSError:
        return False
    if total == 0:
        return False
    return (valid / total) >= _NDJSON_MIN_VALID_RATIO


def _walk(project_root: str, roots: list[str], max_depth: int, follow_symlinks: bool):
    for root in roots:
        base = os.path.normpath(os.path.join(project_root, root))
        if not os.path.isdir(base):
            continue
        base_depth = base.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, filenames in os.walk(base, followlinks=follow_symlinks):
            depth = dirpath.rstrip(os.sep).count(os.sep) - base_depth
            if depth >= max_depth:
                dirnames[:] = []
            for fn in filenames:
                yield os.path.join(dirpath, fn)


def detect(project_root: str, cfg: dict, extra_include: list[str] | None = None,
           extra_exclude: list[str] | None = None) -> list[dict]:
    scan = cfg.get("scan", {})
    roots = scan.get("roots", ["."])
    exclude = list(scan.get("exclude", [])) + list(extra_exclude or [])
    include = list(scan.get("include", [])) + list(extra_include or [])
    follow_symlinks = bool(scan.get("followSymlinks", False))
    max_depth = int(scan.get("maxDepth", 8))
    max_file_size = int(scan.get("maxFileSizeMB", 2048)) * util.MB

    candidates: list[dict] = []
    seen_paths: set[str] = set()

    for path in _walk(project_root, roots, max_depth, follow_symlinks):
        rel = os.path.relpath(path, project_root)
        norm_rel = rel.replace(os.sep, "/")

        if util.matches_any(norm_rel, exclude) and not util.matches_any(norm_rel, include):
            continue
        base_name = os.path.basename(path)
        if base_name in NOISE_NAMES or "nssdb" in norm_rel:
            continue

        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        if size > max_file_size:
            continue

        ext = os.path.splitext(path)[1].lower()

        # Los -wal/-shm nunca son fuentes propias (van asociados a su .db)
        if norm_rel.endswith("-wal") or norm_rel.endswith("-shm") or norm_rel.endswith("-journal"):
            continue

        head16 = _read_first_bytes(path, 16)
        if head16 == SQLITE_MAGIC:
            abspath = os.path.abspath(path)
            if abspath in seen_paths:
                continue
            seen_paths.add(abspath)
            candidates.append({
                "kind": "sqlite", "path": rel, "abspath": abspath,
                "detectedBy": "magic-bytes", "confidence": "high",
                "label": os.path.basename(path), "sizeBytes": size,
            })
            continue

        if ext == ".duckdb" and _read_bytes_at(path, 8, 4) == DUCKDB_MAGIC_OFFSET8:
            abspath = os.path.abspath(path)
            candidates.append({
                "kind": "duckdb", "path": rel, "abspath": abspath,
                "detectedBy": "magic-bytes", "confidence": "high",
                "label": os.path.basename(path), "sizeBytes": size,
            })
            continue

        if ext in FILE_EXTS:
            k, conf = classify_textfile(path, ext)
            if k:
                abspath = os.path.abspath(path)
                candidates.append({
                    "kind": k, "path": rel, "abspath": abspath,
                    "detectedBy": "extension", "confidence": conf,
                    "label": os.path.basename(path), "sizeBytes": size,
                })
            continue

        if ext in DB_EXTS:
            util.log_verbose(f"descartado {rel}: extensión de BD pero sin magic SQLite")

    # ORM / DATABASE_URL: report-only
    orm_candidates = schema_orm.detect_orm_and_urls(project_root, roots, exclude)
    candidates.extend(orm_candidates)

    _dedupe_and_id(candidates)
    return candidates


def _dedupe_and_id(candidates: list[dict]) -> None:
    # dedupe por (kind, path) preservando el primero
    seen = set()
    unique = []
    for c in candidates:
        key = (c["kind"], c.get("path"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(c)
    unique.sort(key=lambda c: (c["kind"], c.get("path") or ""))
    for i, c in enumerate(unique):
        c["id"] = f"src-{i}"
    candidates[:] = unique
