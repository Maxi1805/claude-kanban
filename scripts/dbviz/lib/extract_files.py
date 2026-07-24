"""
lib/extract_files.py — extracción de JSON / NDJSON / CSV / TSV hacia el
contrato universal de tablas (SPEC §6.3, research-extract §6).

Estas fuentes no tienen PRAGMA/DDL: `ddl=None`, sin foreignKeys/indexes
(salvo detección best-effort trivial que no se intenta en v1).
"""
from __future__ import annotations

import csv
import json
import os
import re

from . import contract, util

RECORD_LIMIT_FOR_COLUMNS = 1000

# ---------------------------------------------------------------------------
# Coerción numérica de celdas CSV/TSV crudas (research-extract/SPEC §6.3:
# "CSV/TSV ... inferencia de tipo por muestra"). csv.reader siempre entrega
# str, así que sin esto infer_column_type() jamás ve un int/float real y toda
# columna numérica queda clasificada "string" con stats.min/max vacíos.
# ---------------------------------------------------------------------------

_CSV_INT_RE = re.compile(r"^[+-]?\d+$")
_CSV_FLOAT_RE = re.compile(r"^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$")


def _coerce_csv_cell(raw: str):
    """Convierte un string crudo de CSV/TSV a int/float cuando es inequívoco.

    Celda vacía -> None (ausencia de dato, igual que NULL en el resto de
    fuentes). Enteros con cero(s) a la izquierda (ej. "007", códigos postales)
    se dejan como string a propósito: convertirlos perdería el formato
    original y probablemente no son una cantidad sino un identificador.
    Cualquier otro caso se deja intacto (string) -- nunca lanza.
    """
    if raw == "":
        return None
    if _CSV_INT_RE.match(raw):
        digits = raw.lstrip("+-")
        if len(digits) > 1 and digits[0] == "0":
            return raw
        try:
            return int(raw)
        except ValueError:
            return raw
    if _CSV_FLOAT_RE.match(raw) and ("." in raw or "e" in raw or "E" in raw):
        try:
            return float(raw)
        except ValueError:
            return raw
    return raw


def _union_of_keys(records: list[dict]) -> list[str]:
    seen = []
    seen_set = set()
    for rec in records[:RECORD_LIMIT_FOR_COLUMNS]:
        if not isinstance(rec, dict):
            continue
        for k in rec.keys():
            if k not in seen_set:
                seen_set.add(k)
                seen.append(k)
    return seen


def _table_from_records(name: str, records: list, cfg: dict) -> dict:
    limit = int(cfg["extraction"]["maxRowsPerTable"])
    max_blob = int(cfg["extraction"]["maxBlobInlineBytes"])
    max_chars = int(cfg["extraction"]["maxCellChars"])

    cols = _union_of_keys(records)
    total = len(records)
    sampled = total > limit
    strategy = "head" if sampled else "full"
    subset = records[:limit] if sampled else records

    rows_raw = [[(rec.get(c) if isinstance(rec, dict) else None) for c in cols] for rec in subset]
    columns = []
    for i, c in enumerate(cols):
        raw_values = [r[i] for r in rows_raw]
        inferred, json_like = util.infer_column_type(raw_values)
        stats = util.sample_stats(raw_values, inferred, json_like)
        columns.append(contract.new_column(
            name=c, declared_type="", inferred_type=inferred, nullable=True,
            primary_key=False, default_value=None, stats=stats,
        ))

    rows_encoded = [[util.encode_cell(v, max_blob, max_chars) for v in row] for row in rows_raw]

    return contract.new_table(
        name=name, ttype="table", ddl=None, columns=columns, primary_key=[],
        foreign_keys=[], indexes=[], row_count_total=total,
        row_count_sample=len(rows_encoded), sampled=sampled,
        sample_strategy=strategy, rows=rows_encoded, notes=[],
    )


def extract_json(path: str, cfg: dict) -> list[dict]:
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        data = json.load(f)
    if isinstance(data, list):
        return [_table_from_records("data", data, cfg)]
    if isinstance(data, dict) and all(isinstance(v, list) for v in data.values() if v is not None):
        tables = []
        for k, v in data.items():
            if isinstance(v, list):
                tables.append(_table_from_records(k, v, cfg))
        return tables
    raise ValueError("JSON no tabular")


def extract_ndjson(path: str, cfg: dict) -> tuple[list[dict], list[dict]]:
    warnings = []
    records = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except ValueError as e:
                warnings.append(util.W("W-NDJSON-LINE", f"línea {lineno} inválida: {e}"))
    name = os.path.splitext(os.path.basename(path))[0] or "data"
    return [_table_from_records(name, records, cfg)], warnings


def extract_csv(path: str, cfg: dict, delimiter: str | None = None) -> tuple[list[dict], list[dict]]:
    warnings = []
    with open(path, "r", encoding="utf-8", errors="ignore", newline="") as f:
        sample = f.read(8192)
        f.seek(0)
        if delimiter is None:
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
                delimiter = dialect.delimiter
            except csv.Error:
                delimiter = ","
                warnings.append(util.W("W-CSV-SNIFF", "sniff de separador falló, se usa ','"))
        reader = csv.reader(f, delimiter=delimiter)
        rows = list(reader)
    if not rows:
        name = os.path.splitext(os.path.basename(path))[0] or "data"
        return [contract.new_table(name, "table", None, [], [], [], [], 0, 0, False, "full", [], [])], warnings

    header = rows[0]
    body = rows[1:]
    records = [dict(zip(header, (_coerce_csv_cell(v) for v in row))) for row in body]
    name = os.path.splitext(os.path.basename(path))[0] or "data"
    return [_table_from_records(name, records, cfg)], warnings
