"""
lib/contract.py — modelos (dicts planos) y serialización del CONTRATO de
datos descrito en SPEC §4 (manifest.json + data/<sourceId>.json).

Se usan dicts simples (no dataclasses) para que la serialización a JSON sea
directa y no dependa de nada fuera de stdlib.
"""
from __future__ import annotations

from . import util

CONTRACT_VERSION = 1
TOOL_NAME = "dbviz"


def new_source(id_, kind, path, label, detected_by, confidence) -> dict:
    """Objeto Source vacío (§4.2), antes de extraer."""
    return {
        "id": id_,
        "kind": kind,
        "label": label,
        "path": path,
        "detectedBy": detected_by,
        "confidence": confidence,
        "hasData": False,
        "engineUsed": None,
        "walMerged": False,
        "sizeBytes": None,
        "extractedAt": None,
        "error": None,
        "warnings": [],
        "tables": [],
    }


def new_table(name, ttype, ddl, columns, primary_key, foreign_keys, indexes,
              row_count_total, row_count_sample, sampled, sample_strategy,
              rows, notes=None) -> dict:
    return {
        "name": name,
        "type": ttype,
        "ddl": ddl,
        "columns": columns,
        "primaryKey": primary_key,
        "foreignKeys": foreign_keys,
        "indexes": indexes,
        "rowCountTotal": row_count_total,
        "rowCountSample": row_count_sample,
        "sampled": sampled,
        "sampleStrategy": sample_strategy,
        "rows": rows,
        "notes": notes or [],
    }


def new_column(name, declared_type, inferred_type, nullable, primary_key,
               default_value, stats) -> dict:
    return {
        "name": name,
        "declaredType": declared_type or "",
        "inferredType": inferred_type,
        "nullable": nullable,
        "primaryKey": primary_key,
        "defaultValue": default_value,
        "stats": stats,
    }


def new_foreign_key(column, references_table, references_column, on_delete, on_update) -> dict:
    return {
        "column": column,
        "referencesTable": references_table,
        "referencesColumn": references_column,
        "onDelete": on_delete or "NO ACTION",
        "onUpdate": on_update or "NO ACTION",
    }


def new_index(name, unique, columns, origin) -> dict:
    return {"name": name, "unique": bool(unique), "columns": columns, "origin": origin}


def source_meta(source: dict) -> dict:
    """SourceMeta (§4.1): objeto Source SIN tables[].rows (solo metadata)."""
    meta = dict(source)
    meta["tables"] = [
        {k: v for k, v in t.items() if k != "rows"} for t in source.get("tables", [])
    ]
    return meta


def build_manifest(project_name: str, project_root: str, engine_info: dict,
                    config_echo: dict, sources: list[dict], global_warnings: list[dict],
                    tool_version: str) -> dict:
    table_count = 0
    row_count_total = 0
    row_count_sample = 0
    source_extracted = 0
    all_warnings = list(global_warnings)

    for s in sources:
        if s.get("hasData"):
            source_extracted += 1
        for w in s.get("warnings", []):
            w2 = dict(w)
            w2.setdefault("sourceId", s["id"])
            all_warnings.append(w2)
        for t in s.get("tables", []):
            table_count += 1
            row_count_total += t.get("rowCountTotal") or 0
            row_count_sample += t.get("rowCountSample") or 0

    manifest = {
        "dbviz": {"tool": TOOL_NAME, "version": tool_version, "contractVersion": CONTRACT_VERSION},
        "generatedAt": util.iso_now(),
        "project": {"name": project_name, "root": project_root},
        "engine": engine_info,
        "config": config_echo,
        "sources": [source_meta(s) for s in sources],
        "stats": {
            "sourceCount": len(sources),
            "sourceExtracted": source_extracted,
            "tableCount": table_count,
            "rowCountTotal": row_count_total,
            "rowCountSample": row_count_sample,
        },
        "warnings": all_warnings,
    }
    return manifest
