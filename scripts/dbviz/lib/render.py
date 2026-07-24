"""
lib/render.py — genera el visor autocontenido `.dbviz/index.html` a partir
del template + libs vendorizadas + payload de datos (SPEC §6.4 / D5).

Todo el JSON de datos se serializa con `allow_nan=False` (ya viene saneado
por encode_cell) y se escapa "</" -> "<\\/" para no romper el
`<script type="application/json">` (Riesgo R4).
"""
from __future__ import annotations

import json
import os
import re

from . import util

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "..", "assets")


def _read_asset(name: str) -> str:
    with open(os.path.join(ASSETS_DIR, name), "r", encoding="utf-8") as f:
        return f.read()


def render(manifest: dict, sources: list[dict], viewer_cfg: dict) -> str:
    tpl = _read_asset("viewer.template.html")

    css = _read_asset("tabulator.min.css") + "\n" + _read_asset("viewer.css")
    libs = (
        _read_asset("tabulator.min.js") + "\n"
        + _read_asset("mermaid.min.js") + "\n"
        + _read_asset("chart.umd.min.js")
    )
    app = _read_asset("viewer.js")

    payload = {"manifest": manifest, "sources": sources}
    data_json = util.dumps_for_embed(payload)
    cfg_json = util.dumps_for_embed(viewer_cfg)

    # IMPORTANTE: los valores insertados (data_json, css, app, etc.) pueden
    # contener, dentro de datos de usuario reales, subcadenas literales que
    # coinciden con OTROS placeholders (ej. una celda de la BD con el texto
    # "hello {{APP}} world"). Encadenar `html.replace(...)` uno tras otro
    # sobre la MISMA variable acumulada permite que un reemplazo posterior
    # vuelva a matchear texto insertado por un reemplazo anterior, corrompiendo
    # el HTML (y en particular el JSON embebido en {{DATA}}). Para evitarlo,
    # se hace una única pasada con re.sub sobre el TEMPLATE ORIGINAL: todos los
    # placeholders se localizan de una vez en `tpl` y sus reemplazos se insertan
    # sin volver a escanear el texto ya sustituido (re.sub no re-escanea su
    # propia salida), así que ninguna subcadena "{{...}}" proveniente de datos
    # de usuario puede ser reinterpretada como placeholder.
    placeholders = {
        "{{TITLE}}": _html_escape(viewer_cfg.get("title") or "dbviz"),
        "{{CSS}}": f"<style>\n{css}\n</style>",
        "{{LIBS}}": f"<script>\n{libs}\n</script>",
        "{{DATA}}": f'<script id="dbviz-data" type="application/json">{data_json}</script>',
        "{{CFG}}": f'<script id="dbviz-cfg" type="application/json">{cfg_json}</script>',
        "{{APP}}": f"<script>\n{app}\n</script>",
    }
    pattern = re.compile("|".join(re.escape(k) for k in placeholders))
    html = pattern.sub(lambda m: placeholders[m.group(0)], tpl)
    return html


def _html_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )
