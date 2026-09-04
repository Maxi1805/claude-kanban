"""
lib/schema_orm.py — detección (report-only, D7/§7) de:
  - schemas de ORM sin archivo de BD (Prisma/Django/Rails) -> kind="orm-schema"
  - configuración de BD remota (DATABASE_URL postgres/mysql) -> kind="remote-config"

v1 NUNCA extrae datos de estas fuentes (hasData=False siempre). Solo se
reportan para que el usuario sepa que existen (SPEC §6.1 detect_orm_and_urls,
research-extract §4, §5).

Regla dura: nunca se loguea ni persiste una password (redactada a `***`).
"""
from __future__ import annotations

import os
import re

from . import util

_DBURL_RE = re.compile(r"(postgres(?:ql)?|mysql)://[^\s\"'<>]+", re.IGNORECASE)
_DJANGO_MODEL_RE = re.compile(r"class\s+\w+\(\s*models\.Model\s*\)")

# Schemas de ORM que viven SIEMPRE en una ruta fija (no hay que buscarlos):
# basta con chequear si el archivo existe. Prisma y Rails comparten forma; la
# tabla evita repetir el mismo bloque candidato dos veces.
_FIXED_ORM_SCHEMAS = [
    {"parts": ("prisma", "schema.prisma"), "ormType": "prisma",
     "confidence": "high", "label": "Prisma schema (sin datos)"},
    {"parts": ("db", "schema.rb"), "ormType": "rails",
     "confidence": "medium", "label": "Rails db/schema.rb (sin datos)"},
]

# Archivos de config donde suele aparecer un DATABASE_URL / postgres:// / mysql://
_CONFIG_CANDIDATE_FILES = [
    ".env", ".env.local", ".env.production", ".env.development",
    "settings.py", "config/database.yml", "docker-compose.yml",
    "docker-compose.yaml",
]


def _scan_text_file_for_dburl(path: str) -> list[str]:
    found = []
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read(200_000)
    except OSError:
        return found
    for m in _DBURL_RE.finditer(content):
        found.append(util.redact(m.group(0)))
    return found


def _orm_candidate(path: str, abspath: str, confidence: str, label: str,
                   orm_type: str) -> dict:
    """Candidato uniforme kind="orm-schema" (Prisma/Rails/Django)."""
    return {
        "kind": "orm-schema",
        "path": path,
        "abspath": abspath,
        "detectedBy": "orm-file",
        "confidence": confidence,
        "label": label,
        "ormType": orm_type,
    }


def _detect_fixed_orm_files(project_root: str) -> list[dict]:
    """Prisma (prisma/schema.prisma) y Rails (db/schema.rb): ruta fija."""
    out: list[dict] = []
    for spec in _FIXED_ORM_SCHEMAS:
        abspath = os.path.join(project_root, *spec["parts"])
        if not os.path.isfile(abspath):
            continue
        out.append(_orm_candidate(
            path=os.path.relpath(abspath, project_root),
            abspath=abspath,
            confidence=spec["confidence"],
            label=spec["label"],
            orm_type=spec["ormType"],
        ))
    return out


def _walk_prune_excluded(base: str, project_root: str, exclude: list[str]):
    """os.walk que poda in-place los subdirectorios excluidos y saltea las
    raíces excluidas. Rinde (dirpath, filenames) de cada directorio visitado."""
    for dirpath, dirnames, filenames in os.walk(base):
        relroot = os.path.relpath(dirpath, project_root)
        if util.matches_any(relroot, exclude):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not util.matches_any(
            os.path.join(relroot, d), exclude)]
        yield dirpath, filenames


def _django_candidate_for_dir(dirpath: str, filenames: list[str],
                              project_root: str) -> dict | None:
    """Candidato Django si el dir tiene un models.py con `class X(models.Model)`."""
    if "models.py" not in filenames:
        return None
    full = os.path.join(dirpath, "models.py")
    try:
        with open(full, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read(200_000)
    except OSError:
        return None
    if not _DJANGO_MODEL_RE.search(content):
        return None
    rel = os.path.relpath(full, project_root)
    return _orm_candidate(
        path=rel, abspath=full, confidence="medium",
        label=f"Django models ({rel}, sin datos)", orm_type="django")


def _detect_django_models(project_root: str, roots: list[str],
                          exclude: list[str]) -> list[dict]:
    """Heurística estática: grep de `class X(models.Model)` en models.py."""
    out: list[dict] = []
    for root in roots:
        base = os.path.normpath(os.path.join(project_root, root))
        if not os.path.isdir(base):
            continue
        for dirpath, filenames in _walk_prune_excluded(base, project_root, exclude):
            cand = _django_candidate_for_dir(dirpath, filenames, project_root)
            if cand is not None:
                out.append(cand)
    return out


def _detect_remote_urls(project_root: str) -> list[dict]:
    """DATABASE_URL / postgres:// / mysql:// en archivos de config típicos."""
    out: list[dict] = []
    seen_urls = set()
    for cf in _CONFIG_CANDIDATE_FILES:
        full = os.path.join(project_root, cf)
        if not os.path.isfile(full):
            continue
        for u in _scan_text_file_for_dburl(full):
            if u in seen_urls:
                continue
            seen_urls.add(u)
            engine_name = "postgres" if u.lower().startswith("postgres") else "mysql"
            rel = os.path.relpath(full, project_root)
            out.append({
                "kind": "remote-config",
                "path": None,
                "abspath": None,
                "detectedBy": "config-file",
                "confidence": "high",
                "label": f"{engine_name} detectado en {rel} (no soportado en v1)",
                "ormType": None,
                "remoteEngine": engine_name,
                "remoteUrlRedacted": u,
                "foundIn": rel,
            })
    return out


def detect_orm_and_urls(project_root: str, roots: list[str], exclude: list[str]) -> list[dict]:
    candidates: list[dict] = []
    candidates.extend(_detect_fixed_orm_files(project_root))
    candidates.extend(_detect_django_models(project_root, roots, exclude))
    candidates.extend(_detect_remote_urls(project_root))
    return candidates
