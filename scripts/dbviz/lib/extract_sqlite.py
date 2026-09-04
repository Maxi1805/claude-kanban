"""
lib/extract_sqlite.py — extracción de fuentes SQLite: copia read-only
(incluyendo -wal/-shm), checkpoint de WAL sobre la copia, lectura con
mode=ro&immutable=1 (con fallback a mode=ro), schema + PRAGMA + sampling +
serialización de celdas. SPEC §6.2 / §D3 / §D10.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess

from . import contract, util

E_CORRUPT = "E-CORRUPT"
E_NOPERM = "E-NOPERM"
E_LOCKED = "E-LOCKED"


def _copy_source_files(src_path: str, tmpdir: str) -> tuple[str, bool]:
    """Copia el .db (+ -wal/-shm si existen) al tmpdir. Devuelve (copy_path, had_wal)."""
    copy_path = os.path.join(tmpdir, os.path.basename(src_path))
    shutil.copy2(src_path, copy_path)
    had_wal = False
    for suf in ("-wal", "-shm"):
        sib = src_path + suf
        if os.path.exists(sib):
            shutil.copy2(sib, copy_path + suf)
            if suf == "-wal":
                had_wal = os.path.getsize(sib) > 0
    return copy_path, had_wal


def _checkpoint_wal(copy_path: str) -> tuple[bool, str | None]:
    """Checkpoint TRUNCATE sobre la COPIA (conexión rw solo aquí). Devuelve
    (wal_merged, warning_message_o_None)."""
    if not os.path.exists(copy_path + "-wal"):
        return False, None
    try:
        con = sqlite3.connect(copy_path)
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            con.commit()
        finally:
            con.close()
        return True, None
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def _classify_db_error(e: Exception) -> str:
    msg = str(e).lower()
    if "not a database" in msg or "malformed" in msg or "corrupt" in msg:
        return E_CORRUPT
    if "permission" in msg or "denied" in msg:
        return E_NOPERM
    if "locked" in msg or "busy" in msg:
        return E_LOCKED
    return E_CORRUPT


def _mark_corrupt(source: dict, e: Exception) -> dict:
    """Marca `source` como BD corrupta/ilegible (E-CORRUPT) y lo devuelve.
    Único lugar donde vive este bloque de salida (research §8.5 / SPEC §8)."""
    source["error"] = "BD corrupta o ilegible"
    source["warnings"].append(util.W(E_CORRUPT, str(e)))
    source["hasData"] = False
    source["tables"] = []
    source["extractedAt"] = util.iso_now()
    return source


def _open_readonly(copy_path: str):
    """Abre la copia con mode=ro&immutable=1; si falla, reintenta solo con
    mode=ro (§8 E-LOCKED / research §2.1, riesgo R3)."""
    uri = f"file:{copy_path}?mode=ro&immutable=1"
    try:
        con = sqlite3.connect(uri, uri=True)
        con.execute("SELECT 1;")
        return con, True
    except sqlite3.Error:
        uri2 = f"file:{copy_path}?mode=ro"
        con = sqlite3.connect(uri2, uri=True)
        con.execute("SELECT 1;")
        return con, False


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _fetch_rows(con, name: str, total: int, cfg: dict):
    limit = int(cfg["extraction"]["maxRowsPerTable"])
    qname = _quote_ident(name)
    if total <= limit:
        rows = con.execute(f"SELECT * FROM {qname}").fetchall()
        return rows, False, "full"
    strategy = cfg["extraction"]["sampleStrategy"]
    if strategy == "head":
        sql = f"SELECT * FROM {qname} LIMIT {limit}"
    elif strategy == "random":
        sql = f"SELECT * FROM {qname} ORDER BY RANDOM() LIMIT {limit}"
    elif strategy == "full":
        # full pedido explícitamente pero tabla excede el límite: se degrada a
        # head con warning a nivel de tabla (evita cargar todo en memoria/HTML)
        sql = f"SELECT * FROM {qname} LIMIT {limit}"
        strategy = "head"
    else:  # systematic (default)
        step = max(1, total // limit)
        sql = f"SELECT * FROM {qname} WHERE rowid % {step} = 0 LIMIT {limit}"
    try:
        rows = con.execute(sql).fetchall()
    except sqlite3.OperationalError:
        # tablas sin rowid (WITHOUT ROWID) no soportan `rowid % n` -> head fallback
        rows = con.execute(f"SELECT * FROM {qname} LIMIT {limit}").fetchall()
        strategy = "head"
    return rows, True, strategy


def _build_columns(cols_pragma, rows, cfg, col_index_by_name):
    max_blob = int(cfg["extraction"]["maxBlobInlineBytes"])
    max_chars = int(cfg["extraction"]["maxCellChars"])
    columns = []
    for cid, cname, ctype, notnull, dflt, pk in cols_pragma:
        idx = col_index_by_name[cname]
        raw_values = [r[idx] for r in rows]
        inferred, json_like = util.infer_column_type(raw_values)
        stats = util.sample_stats(raw_values, inferred, json_like)
        columns.append(contract.new_column(
            name=cname, declared_type=ctype, inferred_type=inferred,
            nullable=(notnull == 0), primary_key=bool(pk),
            default_value=dflt, stats=stats,
        ))
    return columns


def _copy_and_checkpoint(source: dict, src_path: str, tmpdir: str, cfg: dict):
    """Fase abrir: copia read-only la fuente al tmpdir y hace checkpoint del WAL
    sobre la copia. Devuelve (copy_path, wal_merged), o None si el copiado falló
    (dejando `source` marcado con el error correspondiente)."""
    try:
        copy_path, _had_wal = _copy_source_files(src_path, tmpdir)
    except PermissionError:
        source["error"] = "sin permiso de lectura"
        source["warnings"].append(util.W(E_NOPERM, f"sin permiso de lectura sobre {src_path}"))
        source["hasData"] = False
        source["extractedAt"] = util.iso_now()
        return None
    except OSError as e:
        source["error"] = f"error de I/O al copiar: {e}"
        source["hasData"] = False
        source["extractedAt"] = util.iso_now()
        return None

    wal_merged = False
    if cfg["extraction"].get("mergeWal", True):
        wal_merged, warn_msg = _checkpoint_wal(copy_path)
        if warn_msg:
            source["warnings"].append(util.W("W-WAL-CHECKPOINT", warn_msg))
    return copy_path, wal_merged


def _open_and_verify(source: dict, copy_path: str):
    """Fase abrir (parte 2): abre la copia read-only. Devuelve la conexión, o
    None si no se pudo abrir (dejando `source` marcado con el error)."""
    try:
        con, _used_immutable = _open_readonly(copy_path)
        return con
    except sqlite3.DatabaseError as e:
        _mark_corrupt(source, e)
        return None
    except sqlite3.OperationalError as e:
        code = _classify_db_error(e)
        source["error"] = "sin permiso de lectura" if code == E_NOPERM else str(e)
        source["warnings"].append(util.W(code, str(e)))
        source["hasData"] = False
        source["extractedAt"] = util.iso_now()
        return None


def _read_schema_python(source: dict, con):
    """Fase leer esquema: lista de (name, type, sql) de tablas/vistas. Devuelve
    None si la lectura revela corrupción no vista por _open_readonly (research
    §8.5 / SPEC §8), dejando `source` marcado E-CORRUPT."""
    try:
        return con.execute(
            "SELECT name, type, sql FROM sqlite_master "
            "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name;"
        ).fetchall()
    except sqlite3.DatabaseError as e:
        _mark_corrupt(source, e)
        return None


def _build_indexes_python(con, idx_pragma) -> list:
    indexes = []
    for idx in idx_pragma:
        # index_list: seq, name, unique, origin, partial
        idx_name, unique, origin = idx[1], idx[2], idx[3]
        idx_cols_pragma = con.execute(
            f"PRAGMA index_info({_quote_ident(idx_name)});").fetchall()
        idx_cols = [c[2] for c in idx_cols_pragma]
        indexes.append(contract.new_index(idx_name, unique, idx_cols, origin))
    return indexes


def _build_table_python(con, name, ttype, ddl, cfg: dict) -> dict:
    """Fase muestrear + serializar UNA tabla (motor python-stdlib)."""
    cols_pragma = con.execute(f"PRAGMA table_info({_quote_ident(name)});").fetchall()
    fks_pragma = con.execute(f"PRAGMA foreign_key_list({_quote_ident(name)});").fetchall()
    idx_pragma = con.execute(f"PRAGMA index_list({_quote_ident(name)});").fetchall()
    total = con.execute(f"SELECT COUNT(*) FROM {_quote_ident(name)}").fetchone()[0]
    rows_raw, sampled, strategy = _fetch_rows(con, name, total, cfg)

    col_names = [c[1] for c in cols_pragma]
    col_index_by_name = {c: i for i, c in enumerate(col_names)}
    columns = _build_columns(cols_pragma, rows_raw, cfg, col_index_by_name)
    primary_key = [c[1] for c in sorted(
        (c for c in cols_pragma if c[5]), key=lambda c: c[5])]

    foreign_keys = []
    for fk in fks_pragma:
        # foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
        foreign_keys.append(contract.new_foreign_key(
            column=fk[3], references_table=fk[2], references_column=fk[4],
            on_delete=fk[6], on_update=fk[5],
        ))

    indexes = _build_indexes_python(con, idx_pragma)

    max_blob = int(cfg["extraction"]["maxBlobInlineBytes"])
    max_chars = int(cfg["extraction"]["maxCellChars"])
    rows_encoded = [
        [util.encode_cell(v, max_blob, max_chars) for v in row]
        for row in rows_raw
    ]

    notes = []
    if sampled and strategy == "head" and cfg["extraction"]["sampleStrategy"] != "head":
        notes.append("Tabla sin rowid o full forzado: se usó estrategia 'head' como fallback")

    return contract.new_table(
        name=name, ttype=ttype, ddl=ddl, columns=columns,
        primary_key=primary_key, foreign_keys=foreign_keys, indexes=indexes,
        row_count_total=total, row_count_sample=len(rows_encoded),
        sampled=sampled, sample_strategy=strategy, rows=rows_encoded, notes=notes,
    )


def extract_sqlite(source: dict, cfg: dict, tmpdir: str, forced_engine: str = "auto") -> dict:
    """Muta y devuelve `source` (objeto Source, SPEC §4.2) con tables/warnings/error.
    Orquesta las fases: abrir -> leer esquema -> muestrear/serializar -> cerrar."""
    src_path = source["path"]
    try:
        source["sizeBytes"] = os.path.getsize(src_path)
    except OSError:
        source["sizeBytes"] = None

    prepared = _copy_and_checkpoint(source, src_path, tmpdir, cfg)
    if prepared is None:
        return source
    copy_path, wal_merged = prepared

    if forced_engine == "sqlite3":
        return _extract_sqlite_via_cli(source, copy_path, cfg, wal_merged)

    con = _open_and_verify(source, copy_path)
    if con is None:
        return source

    try:
        tables_meta = _read_schema_python(source, con)
        if tables_meta is None:
            return source

        for name, ttype, ddl in tables_meta:
            try:
                source["tables"].append(_build_table_python(con, name, ttype, ddl, cfg))
            except Exception as e:  # noqa: BLE001 - una tabla no debe abortar el resto
                source["warnings"].append(util.W("W-TABLE-ERROR", f"tabla '{name}': {e}"))
                continue

        source["hasData"] = True
        source["walMerged"] = wal_merged
        source["engineUsed"] = "python-stdlib"
    finally:
        con.close()

    source["extractedAt"] = util.iso_now()
    return source


# ---------------------------------------------------------------------------
# Motor sqlite3-cli (SPEC §1.4 opción 2 / §6.2 "Camino sqlite3-cli")
#
# En vez de parsear la salida tabular de PRAGMA (`-noheader -separator '|'`)
# como sugiere el pseudocódigo del SPEC, se aprovechan las funciones JSON1
# embebidas en el propio binario `sqlite3` (json_object/json_group_array,
# disponibles en sqlite3 >= 3.38) para que el CLI devuelva JSON ya válido
# directamente por stdout. Es funcionalmente equivalente al contrato
# (mismos campos, mismos tipos) y más robusto que parsear texto tabular.
# Documentado como desviación menor de implementación en el entregable.
# ---------------------------------------------------------------------------

def _sqlite3_cli_query_json(copy_path: str, sql: str):
    uri = f"file:{copy_path}?mode=ro"
    proc = subprocess.run(
        ["sqlite3", "-json", "-readonly", uri, sql],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "sqlite3 CLI error")
    out = proc.stdout.strip()
    if not out:
        return []
    return json.loads(out)


def _sql_str_literal(name: str) -> str:
    """Escapa un nombre para usarlo dentro de '...' de una expresión SQL."""
    return name.replace("'", "''")


def _blob_probe_select_clause(col_names: list[str]) -> str:
    """Construye la lista de columnas de un SELECT que, para cada columna
    lógica `c{i}`, agrega también su `typeof()` y su `hex()`.

    Motivo: `sqlite3 -json` no serializa BLOB como base64/hex (los corrompe
    en un string de texto no reversible, ver docs/research-extract.md). El
    tipo por valor de SQLite es dinámico (columnas sin afinidad estricta
    pueden guardar un BLOB en cualquier fila), así que la única forma
    confiable de recuperar el valor binario real es pedirle a la propia BD
    que nos diga el `typeof()` de cada valor y, cuando sea 'blob', su
    representación en `hex()` (que sí es reversible byte a byte), en vez de
    apoyarse en el valor ya serializado (y potencialmente corrupto) que
    `sqlite3 -json` puso en la columna cruda.
    """
    parts = []
    for i, c in enumerate(col_names):
        qc = _quote_ident(c)
        parts.append(f"{qc} AS c{i}")
        parts.append(f"typeof({qc}) AS c{i}__t")
        parts.append(f"hex({qc}) AS c{i}__h")
    return ", ".join(parts)


def _rows_json_to_raw(rows_json: list[dict], col_names: list[str]) -> list[list]:
    """Reconstruye filas de valores Python nativos a partir del resultado JSON
    del SELECT generado por `_blob_probe_select_clause`, decodificando BLOBs
    desde su columna `hex()` en vez de usar el valor de texto corrupto."""
    rows_raw = []
    for r in rows_json:
        row = []
        for i in range(len(col_names)):
            typ = r.get(f"c{i}__t")
            if typ == "blob":
                hexval = r.get(f"c{i}__h")
                row.append(bytes.fromhex(hexval) if hexval else b"")
            else:
                row.append(r.get(f"c{i}"))
        rows_raw.append(row)
    return rows_raw


def _read_schema_cli(source: dict, copy_path: str):
    """Fase leer esquema (motor CLI). Devuelve la lista de tablas/vistas, o None
    si la consulta falla (dejando `source` marcado E-CORRUPT)."""
    try:
        return _sqlite3_cli_query_json(
            copy_path,
            "SELECT name, type, sql FROM sqlite_master "
            "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;",
        )
    except Exception as e:  # noqa: BLE001
        _mark_corrupt(source, e)
        return None


def _cli_sample_rows(copy_path: str, qname: str, cols_clause: str, total, cfg: dict):
    """Fase muestrear (motor CLI): decide la estrategia y trae las filas JSON.
    Espejo de `_fetch_rows` para el camino sqlite3-cli. Devuelve
    (rows_json, sampled, strategy)."""
    limit = int(cfg["extraction"]["maxRowsPerTable"])
    strategy_cfg = cfg["extraction"]["sampleStrategy"]
    if total <= limit:
        rows_json = _sqlite3_cli_query_json(copy_path, f"SELECT {cols_clause} FROM {qname};")
        return rows_json, False, "full"
    if strategy_cfg == "head":
        sql = f"SELECT {cols_clause} FROM {qname} LIMIT {limit};"
    elif strategy_cfg == "random":
        sql = f"SELECT {cols_clause} FROM {qname} ORDER BY RANDOM() LIMIT {limit};"
    else:
        step = max(1, total // limit)
        sql = f"SELECT {cols_clause} FROM {qname} WHERE rowid % {step} = 0 LIMIT {limit};"
    try:
        rows_json = _sqlite3_cli_query_json(copy_path, sql)
        strategy = strategy_cfg if strategy_cfg in ("head", "random") else "systematic"
    except Exception:
        rows_json = _sqlite3_cli_query_json(
            copy_path, f"SELECT {cols_clause} FROM {qname} LIMIT {limit};")
        strategy = "head"
    return rows_json, True, strategy


def _build_columns_cli(cols_pragma_raw, col_names, rows_raw) -> list:
    columns = []
    for c in cols_pragma_raw:
        idx = col_names.index(c["name"])
        raw_values = [r[idx] for r in rows_raw]
        inferred, json_like = util.infer_column_type(raw_values)
        stats = util.sample_stats(raw_values, inferred, json_like)
        columns.append(contract.new_column(
            name=c["name"], declared_type=c.get("type"), inferred_type=inferred,
            nullable=(c.get("notnull") == 0), primary_key=bool(c.get("pk")),
            default_value=c.get("dflt_value"), stats=stats,
        ))
    return columns


def _build_indexes_cli(copy_path: str, idx_raw) -> list:
    indexes = []
    for idx in idx_raw:
        idx_name_lit = _sql_str_literal(idx["name"])
        idx_cols_raw = _sqlite3_cli_query_json(
            copy_path, f"SELECT * FROM pragma_index_info('{idx_name_lit}');")
        idx_cols = [c["name"] for c in idx_cols_raw]
        indexes.append(contract.new_index(idx["name"], idx.get("unique"), idx_cols, idx.get("origin")))
    return indexes


def _read_table_meta_cli(copy_path: str, name: str):
    """Fase leer esquema de UNA tabla (motor CLI): pragmas de columnas, FKs,
    índices y conteo total. Devuelve (cols_pragma_raw, fks_raw, idx_raw, total)."""
    name_lit = _sql_str_literal(name)
    cols_pragma_raw = _sqlite3_cli_query_json(
        copy_path, f"SELECT * FROM pragma_table_info('{name_lit}');")
    fks_raw = _sqlite3_cli_query_json(
        copy_path, f"SELECT * FROM pragma_foreign_key_list('{name_lit}');")
    idx_raw = _sqlite3_cli_query_json(
        copy_path, f"SELECT * FROM pragma_index_list('{name_lit}');")
    total = _sqlite3_cli_query_json(
        copy_path, f"SELECT COUNT(*) AS n FROM {_quote_ident(name)};")[0]["n"]
    return cols_pragma_raw, fks_raw, idx_raw, total


def _build_table_cli(copy_path: str, tmeta: dict, cfg: dict) -> dict:
    """Fase muestrear + serializar UNA tabla (motor sqlite3-cli)."""
    max_blob = int(cfg["extraction"]["maxBlobInlineBytes"])
    max_chars = int(cfg["extraction"]["maxCellChars"])
    name = tmeta["name"]
    ttype = tmeta["type"]
    ddl = tmeta.get("sql")

    cols_pragma_raw, fks_raw, idx_raw, total = _read_table_meta_cli(copy_path, name)

    qname = _quote_ident(name)
    col_names = [c["name"] for c in cols_pragma_raw]
    cols_clause = _blob_probe_select_clause(col_names)
    rows_json, sampled, strategy = _cli_sample_rows(copy_path, qname, cols_clause, total, cfg)
    rows_raw = _rows_json_to_raw(rows_json, col_names)

    columns = _build_columns_cli(cols_pragma_raw, col_names, rows_raw)
    primary_key = [c["name"] for c in sorted(
        (c for c in cols_pragma_raw if c.get("pk")), key=lambda c: c["pk"])]
    foreign_keys = [
        contract.new_foreign_key(
            column=fk["from"], references_table=fk["table"], references_column=fk["to"],
            on_delete=fk.get("on_delete"), on_update=fk.get("on_update"),
        ) for fk in fks_raw
    ]
    indexes = _build_indexes_cli(copy_path, idx_raw)

    rows_encoded = [
        [util.encode_cell(v, max_blob, max_chars) for v in row]
        for row in rows_raw
    ]

    return contract.new_table(
        name=name, ttype=ttype, ddl=ddl, columns=columns,
        primary_key=primary_key, foreign_keys=foreign_keys, indexes=indexes,
        row_count_total=total, row_count_sample=len(rows_encoded),
        sampled=sampled, sample_strategy=strategy, rows=rows_encoded, notes=[],
    )


def _extract_sqlite_via_cli(source: dict, copy_path: str, cfg: dict, wal_merged: bool) -> dict:
    tables_meta = _read_schema_cli(source, copy_path)
    if tables_meta is None:
        return source

    for tmeta in tables_meta:
        name = tmeta["name"]
        try:
            source["tables"].append(_build_table_cli(copy_path, tmeta, cfg))
        except Exception as e:  # noqa: BLE001
            source["warnings"].append(util.W("W-TABLE-ERROR", f"tabla '{name}': {e}"))
            continue

    source["hasData"] = True
    source["walMerged"] = wal_merged
    source["engineUsed"] = "sqlite3-cli"
    source["extractedAt"] = util.iso_now()
    return source
