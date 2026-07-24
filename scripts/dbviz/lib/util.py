"""
lib/util.py — utilidades compartidas: glob matching, redacción de secretos,
timestamps, inferencia de tipo e inferencia de valores para el contrato de
datos (§4.7 / §4.4 del SPEC).

Todo en stdlib de Python 3. No hay dependencias externas en todo el tool.
"""
from __future__ import annotations

import base64
import binascii
import datetime as _dt
import json
import math
import re
import sys

MB = 1024 * 1024

# ---------------------------------------------------------------------------
# Logging (siempre a stderr; stdout se reserva para "resultado de datos")
# ---------------------------------------------------------------------------

_QUIET = False
_VERBOSE = False


def set_log_level(quiet: bool, verbose: bool) -> None:
    global _QUIET, _VERBOSE
    _QUIET = quiet
    _VERBOSE = verbose


def log(msg: str) -> None:
    if not _QUIET:
        print(f"[dbviz] {msg}", file=sys.stderr)


def log_verbose(msg: str) -> None:
    if _VERBOSE and not _QUIET:
        print(f"[dbviz:v] {msg}", file=sys.stderr)


def log_err(msg: str) -> None:
    print(f"[dbviz] ERROR: {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------

def iso_now() -> str:
    """ISO-8601 UTC con milisegundos y sufijo Z, ej. 2026-07-24T15:04:05.123Z"""
    now = _dt.datetime.now(_dt.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


# ---------------------------------------------------------------------------
# Glob matching (para scan.exclude / scan.include, research-extract §1.3)
# ---------------------------------------------------------------------------

def _pattern_to_regex(pattern: str) -> str:
    pattern = pattern.replace("\\", "/")
    out = []
    i = 0
    n = len(pattern)
    while i < n:
        if pattern[i:i + 3] == "**/":
            out.append("(?:.*/)?")
            i += 3
        elif pattern[i:i + 2] == "**":
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return "^" + "".join(out) + "$"


def matches_any(relpath: str, patterns: list[str]) -> bool:
    """True si relpath matchea alguno de los globs en `patterns`.

    Soporta patrones simples ("node_modules" matchea el componente en
    cualquier profundidad), y patrones con '*'/'**' vía traducción a regex.
    """
    if not patterns:
        return False
    norm = relpath.replace("\\", "/")
    parts = norm.split("/")
    for p in patterns:
        if not p:
            continue
        if "/" not in p and "*" not in p and "?" not in p:
            if p in parts:
                return True
            continue
        rx = _pattern_to_regex(p)
        if re.match(rx, norm):
            return True
        # también probar contra cada sufijo relativo (para "**/Cache/**" etc.)
        for i in range(len(parts)):
            suffix = "/".join(parts[i:])
            if re.match(rx, suffix):
                return True
    return False


# ---------------------------------------------------------------------------
# Redacción de secretos (research-extract §4.3, SPEC §6.1 / §8 R6)
# ---------------------------------------------------------------------------

_URL_CREDS_RE = re.compile(r"(?P<scheme>[a-zA-Z][\w+.-]*://)(?P<user>[^:@/]+)(?::(?P<pass>[^@/]*))?@")


def redact(text: str) -> str:
    if not text:
        return text

    def _sub(m: re.Match) -> str:
        user = m.group("user")
        return f"{m.group('scheme')}{user}:***@"

    return _URL_CREDS_RE.sub(_sub, text)


# ---------------------------------------------------------------------------
# Warnings (formato uniforme {code,message,sourceId?})
# ---------------------------------------------------------------------------

def W(code: str, message: str, source_id: str | None = None) -> dict:
    w = {"code": code, "message": message}
    if source_id is not None:
        w["sourceId"] = source_id
    return w


# ---------------------------------------------------------------------------
# Codificación de celdas — Contrato §4.7
# ---------------------------------------------------------------------------

# Number.MAX_SAFE_INTEGER de JavaScript (2^53 - 1): el mayor entero que
# JSON.parse (IEEE-754 double) puede reconstruir sin pérdida de precisión.
# SQLite INTEGER soporta 64 bits (hasta ~9.22e18), muy por encima de esto
# (IDs por hash, PIDs de 64 bits, timestamps en nanosegundos, etc.).
MAX_SAFE_INT = (1 << 53) - 1


def _int_needs_bigint_encoding(value: int) -> bool:
    return abs(value) > MAX_SAFE_INT


def encode_cell(value, max_blob_inline_bytes: int, max_cell_chars: int):
    """Codifica un valor crudo (python) al union-type JSON del contrato §4.7.

    Nunca debe lanzar: cualquier excepción se captura y produce
    {"__type__":"error","reason":...} (research-extract §8.5).
    """
    try:
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            if _int_needs_bigint_encoding(value):
                # json.dumps preservaría el valor EXACTO en el TEXTO JSON, pero
                # JSON.parse() en el navegador (viewer.js) convierte todo número
                # a IEEE-754 double, con precisión exacta solo hasta
                # Number.MAX_SAFE_INTEGER: un int64 fuera de ese rango se
                # corrompería silenciosamente al llegar al cliente. Se codifica
                # como string (contrato §4.7, union-type "bigint") para viajar
                # sin pérdida; el visor lo muestra tal cual, como texto exacto.
                return {"__type__": "bigint", "value": str(value)}
            return value
        if isinstance(value, float):
            if math.isnan(value):
                return {"__type__": "number", "value": "NaN"}
            if math.isinf(value):
                return {"__type__": "number", "value": "Infinity" if value > 0 else "-Infinity"}
            return value
        if isinstance(value, (bytes, bytearray, memoryview)):
            b = bytes(value)
            size = len(b)
            if size <= max_blob_inline_bytes:
                return {
                    "__type__": "blob",
                    "encoding": "base64",
                    "size": size,
                    "data": base64.b64encode(b).decode("ascii"),
                }
            return {
                "__type__": "blob",
                "encoding": "base64",
                "size": size,
                "preview_hex": binascii.hexlify(b[:32]).decode("ascii"),
                "data": None,
            }
        if isinstance(value, (list, dict)):
            # Valores anidados provenientes de fuentes JSON/NDJSON (una celda
            # cuyo valor es a su vez un array/objeto, ej. tags:["new","sale"]).
            # Deben serializarse como JSON válido (no str() de Python, que usa
            # comillas simples y no es parseable) para que jsonLike y el botón
            # "ver JSON" del visor funcionen igual que con TEXT-JSON de SQLite.
            try:
                value = json.dumps(value, ensure_ascii=False, allow_nan=False)
            except (TypeError, ValueError) as e:
                return {"__type__": "error", "reason": repr(e)[:200]}
        if isinstance(value, str):
            if len(value) > max_cell_chars:
                return {
                    "__type__": "text",
                    "truncated": True,
                    "size": len(value),
                    "value": value[:max_cell_chars],
                }
            return value
        # tipo no contemplado (ej. Decimal exótico) -> mejor esfuerzo: string
        return str(value)
    except Exception as e:  # noqa: BLE001 - regla transversal: nunca abortar
        return {"__type__": "error", "reason": repr(e)[:200]}


# ---------------------------------------------------------------------------
# Inferencia de tipo — Contrato §4.4
# ---------------------------------------------------------------------------

_ISO_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$"
)


def looks_like_datetime(v) -> bool:
    if isinstance(v, str):
        if _ISO_DATETIME_RE.match(v.strip()):
            return True
        return False
    if isinstance(v, int):
        # unix ts plausible: entre 1970 y ~2200, en segundos o milisegundos
        return 0 < abs(v) < 10_000_000_000_000
    return False


def looks_like_json(v) -> bool:
    if not isinstance(v, str):
        return False
    s = v.strip()
    if not s or s[0] not in "{[":
        return False
    try:
        parsed = json.loads(s)
    except (ValueError, TypeError):
        return False
    return isinstance(parsed, (dict, list))


_BOOL_STRINGS = {"true", "false"}


def infer_column_type(raw_values: list) -> tuple[str, bool]:
    """Devuelve (inferredType, jsonLike) analizando hasta 500 valores no-null.

    Categorías: null | integer | real | boolean | string | datetime | json |
    blob | mixed  (SPEC §4.4).
    """
    non_null = [v for v in raw_values if v is not None][:500]
    if not non_null:
        return "null", False

    kinds = set()
    for v in non_null:
        if isinstance(v, bool):
            kinds.add("bool")
        elif isinstance(v, (bytes, bytearray, memoryview)):
            kinds.add("blob")
        elif isinstance(v, int):
            kinds.add("int")
        elif isinstance(v, float):
            kinds.add("float")
        elif isinstance(v, str):
            kinds.add("str")
        elif isinstance(v, (list, dict)):
            # Valor nativo anidado (fuentes JSON/NDJSON, ej. tags:["a","b"]):
            # ya es un array/objeto Python, no un string a parsear.
            kinds.add("json_native")
        else:
            kinds.add("other")

    json_like = False
    if kinds and kinds <= {"str", "json_native"}:
        def _is_jsonish(v):
            return isinstance(v, (list, dict)) or looks_like_json(v)
        n_json = sum(1 for v in non_null if _is_jsonish(v))
        json_like = n_json > 0 and (n_json / len(non_null)) > 0.5

    # blob puro
    if kinds == {"blob"}:
        return "blob", False

    # columna cuyos valores son 100% arrays/objetos nativos (JSON/NDJSON):
    # siempre es "json" (no hace falta heurística de umbral, son objetos reales)
    if kinds == {"json_native"}:
        return "json", json_like

    # boolean: todo el universo de valores está en {0,1,True,False,"true","false"}
    def _is_boolish(v):
        if isinstance(v, bool):
            return True
        if isinstance(v, int):
            return v in (0, 1)
        if isinstance(v, str):
            return v.strip().lower() in _BOOL_STRINGS
        return False

    if kinds <= {"bool", "int", "str"} and all(_is_boolish(v) for v in non_null):
        # sólo si además hay al menos un valor "booleano puro" real o string true/false
        # (para no marcar como boolean una columna entera con solo 0/1 numéricos
        #  cuyo tipo declarado claramente es integer se sigue permitiendo per SPEC:
        #  "boolean si todos in {0,1,true,false}")
        return "boolean", json_like

    if kinds == {"int"}:
        return "integer", json_like
    if kinds == {"float"} or kinds == {"int", "float"}:
        return "real", json_like

    if kinds == {"str"}:
        if json_like:
            return "json", json_like
        n_dt = sum(1 for v in non_null if looks_like_datetime(v))
        if n_dt / len(non_null) > 0.8:
            return "datetime", json_like
        return "string", json_like

    if len(kinds) > 1:
        return "mixed", json_like

    return "string", json_like


def sample_stats(raw_values: list, inferred_type: str, json_like: bool) -> dict:
    non_null = [v for v in raw_values if v is not None]
    null_count = len(raw_values) - len(non_null)
    try:
        distinct = len({_hashable(v) for v in raw_values})
    except Exception:
        distinct = len({str(v) for v in raw_values})

    vmin = vmax = None
    if inferred_type in ("integer", "real"):
        # NaN/±Infinity son valores reales válidos en SQLite (columnas REAL) y en
        # JSON (json.loads acepta los tokens NaN/Infinity/-Infinity), pero no son
        # JSON-serializables vía json.dumps(allow_nan=False) (§4.7/§8, mismo
        # saneo que ya aplica encode_cell() a los valores de fila). Se excluyen
        # del cálculo de min/max -- igual que un valor no numérico -- en vez de
        # dejarlos filtrar crudos y romper la escritura de manifest.json/data.
        nums = [
            v for v in non_null
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        ]
        if nums:
            raw_min, raw_max = min(nums), max(nums)
            # Mismo riesgo de precisión que en encode_cell (int64 fuera del
            # rango seguro de Number en JS): se envían como string para no
            # corromperse en el JSON.parse del visor.
            vmin = (
                str(raw_min)
                if isinstance(raw_min, int) and _int_needs_bigint_encoding(raw_min)
                else raw_min
            )
            vmax = (
                str(raw_max)
                if isinstance(raw_max, int) and _int_needs_bigint_encoding(raw_max)
                else raw_max
            )
    elif inferred_type == "datetime":
        strs = [v for v in non_null if isinstance(v, str)]
        if strs:
            vmin, vmax = min(strs), max(strs)

    return {
        "nullCount": null_count,
        "distinctSampled": distinct,
        "jsonLike": bool(json_like),
        "min": vmin,
        "max": vmax,
    }


def _hashable(v):
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v)
    if isinstance(v, (list, dict)):
        try:
            return json.dumps(v, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(v)
    return v


# ---------------------------------------------------------------------------
# Serialización final del payload embebido en el visor (§6.4, riesgo R4)
# ---------------------------------------------------------------------------

def dumps_for_embed(obj) -> str:
    data_json = json.dumps(obj, ensure_ascii=False, allow_nan=False)
    # Riesgo R4: evitar que un valor con "</script" cierre el <script> prematuramente
    return data_json.replace("</", "<\\/")
