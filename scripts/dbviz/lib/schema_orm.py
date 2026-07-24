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


def detect_orm_and_urls(project_root: str, roots: list[str], exclude: list[str]) -> list[dict]:
    candidates: list[dict] = []

    # --- Prisma ---
    prisma_path = os.path.join(project_root, "prisma", "schema.prisma")
    if os.path.isfile(prisma_path):
        rel = os.path.relpath(prisma_path, project_root)
        candidates.append({
            "kind": "orm-schema",
            "path": rel,
            "abspath": prisma_path,
            "detectedBy": "orm-file",
            "confidence": "high",
            "label": "Prisma schema (sin datos)",
            "ormType": "prisma",
        })

    # --- Rails ---
    rails_path = os.path.join(project_root, "db", "schema.rb")
    if os.path.isfile(rails_path):
        rel = os.path.relpath(rails_path, project_root)
        candidates.append({
            "kind": "orm-schema",
            "path": rel,
            "abspath": rails_path,
            "detectedBy": "orm-file",
            "confidence": "medium",
            "label": "Rails db/schema.rb (sin datos)",
            "ormType": "rails",
        })

    # --- Django (heurística estática: grep de class X(models.Model)) ---
    django_model_re = re.compile(r"class\s+\w+\(\s*models\.Model\s*\)")
    for root in roots:
        base = os.path.normpath(os.path.join(project_root, root))
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            relroot = os.path.relpath(dirpath, project_root)
            if util.matches_any(relroot, exclude):
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if not util.matches_any(
                os.path.join(relroot, d), exclude)]
            for fn in filenames:
                if fn == "models.py":
                    full = os.path.join(dirpath, fn)
                    try:
                        with open(full, "r", encoding="utf-8", errors="ignore") as f:
                            content = f.read(200_000)
                    except OSError:
                        continue
                    if django_model_re.search(content):
                        rel = os.path.relpath(full, project_root)
                        candidates.append({
                            "kind": "orm-schema",
                            "path": rel,
                            "abspath": full,
                            "detectedBy": "orm-file",
                            "confidence": "medium",
                            "label": f"Django models ({rel}, sin datos)",
                            "ormType": "django",
                        })

    # --- DATABASE_URL / postgres:// / mysql:// en archivos de config típicos ---
    candidate_files = [
        ".env", ".env.local", ".env.production", ".env.development",
        "settings.py", "config/database.yml", "docker-compose.yml",
        "docker-compose.yaml",
    ]
    seen_urls = set()
    for cf in candidate_files:
        full = os.path.join(project_root, cf)
        if not os.path.isfile(full):
            continue
        urls = _scan_text_file_for_dburl(full)
        for u in urls:
            if u in seen_urls:
                continue
            seen_urls.add(u)
            engine_name = "postgres" if u.lower().startswith("postgres") else "mysql"
            rel = os.path.relpath(full, project_root)
            candidates.append({
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

    return candidates
