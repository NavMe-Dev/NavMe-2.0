"""Platform runtime config overlay (Config Option 2: LLM + safe runtime).

Non-secrets: platform/var/runtime_settings.json (live overlay; get_settings cache cleared on save).
Secrets: platform/var/runtime_secrets.env (mode 0600) — write-only set/clear; never returned.
Base values still come from process env / .env via pydantic Settings.

Do NOT put secrets in Postgres. Changing CORS_ORIGINS / JWT / DATABASE_URL typically
needs `scripts/dev_server.sh restart` because middleware / engine bind at import time.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

_lock = threading.RLock()

# Relative to platform/ cwd (same as DATA_DIR default ./var/data).
_VAR_DIR = Path("./var")
SETTINGS_PATH = _VAR_DIR / "runtime_settings.json"
SECRETS_PATH = _VAR_DIR / "runtime_secrets.env"

NON_SECRET_KEYS = (
    "wf_chat_enabled",
    "wf_chat_llm_base_url",
    "wf_chat_llm_model",
    "wf_chat_rate_limit_per_min",
    "geocoder",
    "max_upload_mb",
    "public_base_url",
    "cors_origins",
    "vps_url",
)

# API / UI use UPPER_SNAKE; Settings attrs are lower_snake.
ENV_TO_ATTR = {
    "WF_CHAT_ENABLED": "wf_chat_enabled",
    "WF_CHAT_LLM_BASE_URL": "wf_chat_llm_base_url",
    "WF_CHAT_LLM_MODEL": "wf_chat_llm_model",
    "WF_CHAT_RATE_LIMIT_PER_MIN": "wf_chat_rate_limit_per_min",
    "GEOCODER": "geocoder",
    "MAX_UPLOAD_MB": "max_upload_mb",
    "PUBLIC_BASE_URL": "public_base_url",
    "CORS_ORIGINS": "cors_origins",
    "VPS_URL": "vps_url",
}
ATTR_TO_ENV = {v: k for k, v in ENV_TO_ATTR.items()}

SECRET_ENV_KEYS = (
    "WF_CHAT_LLM_API_KEY",
    "MATTERPORT_SDK_KEY",
    "JWT_SECRET",
    "DATABASE_URL",
    "WF_AR_VARIANT_LAUNCH_KEY",
)
SECRET_ATTR = {
    "WF_CHAT_LLM_API_KEY": "wf_chat_llm_api_key",
    "MATTERPORT_SDK_KEY": "matterport_sdk_key",
    "JWT_SECRET": "jwt_secret",
    "DATABASE_URL": "database_url",
    "WF_AR_VARIANT_LAUNCH_KEY": "wf_ar_variant_launch_key",
}

# Keys that usually need process restart after change (middleware / engine).
RESTART_HINT_KEYS = frozenset({"cors_origins", "public_base_url", "jwt_secret", "database_url"})

_BOOL_TRUE = {"1", "true", "yes", "on"}
_BOOL_FALSE = {"0", "false", "no", "off"}


def _var_dir() -> Path:
    p = SETTINGS_PATH.parent
    p.mkdir(parents=True, exist_ok=True)
    return p


def read_non_secret_overlay() -> dict[str, Any]:
    with _lock:
        if not SETTINGS_PATH.is_file():
            return {}
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(raw, dict):
            return {}
        out: dict[str, Any] = {}
        for k in NON_SECRET_KEYS:
            if k in raw:
                out[k] = raw[k]
        return out


def write_non_secret_overlay(updates: dict[str, Any], *, clear_keys: list[str] | None = None) -> dict[str, Any]:
    """Merge updates into runtime_settings.json. clear_keys remove overlay entries (fall back to env)."""
    with _lock:
        cur = read_non_secret_overlay()
        for k in clear_keys or []:
            cur.pop(k, None)
        for k, v in (updates or {}).items():
            if k not in NON_SECRET_KEYS:
                continue
            if v is None:
                cur.pop(k, None)
            else:
                cur[k] = v
        _var_dir()
        SETTINGS_PATH.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(SETTINGS_PATH, 0o640)
        except Exception:
            pass
        return dict(cur)


def _parse_secrets_file(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            continue
        k, _, v = s.partition("=")
        k = k.strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        if k in SECRET_ENV_KEYS:
            out[k] = v
    return out


def read_secret_overlay() -> dict[str, str]:
    with _lock:
        if not SECRETS_PATH.is_file():
            return {}
        try:
            return _parse_secrets_file(SECRETS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}


def write_secret_overlay(set_map: dict[str, str] | None = None, clear_keys: list[str] | None = None) -> None:
    """Write-only: merge/clear secrets file. Never returns values."""
    with _lock:
        cur = read_secret_overlay()
        for k in clear_keys or []:
            if k in SECRET_ENV_KEYS:
                cur.pop(k, None)
        for k, v in (set_map or {}).items():
            if k not in SECRET_ENV_KEYS:
                continue
            if v is None or v == "":
                cur.pop(k, None)
            else:
                cur[k] = str(v)
        _var_dir()
        lines = ["# Runtime secret overlay — mode 0600. Do not commit. Never echo values.\n"]
        for k in SECRET_ENV_KEYS:
            if k in cur:
                # Escape newlines; keep simple KEY=value
                val = cur[k].replace("\n", "").replace("\r", "")
                lines.append(f"{k}={val}\n")
        SECRETS_PATH.write_text("".join(lines), encoding="utf-8")
        try:
            os.chmod(SECRETS_PATH, 0o600)
        except Exception:
            pass


def secret_configured_flags(settings_obj: Any) -> dict[str, bool]:
    """Bool presence only — never include values. Overlay OR base Settings / env."""
    overlay = read_secret_overlay()
    flags = {}
    for env_k, attr in SECRET_ATTR.items():
        ov = overlay.get(env_k)
        if ov is not None and str(ov).strip():
            flags[env_k] = True
            continue
        base = getattr(settings_obj, attr, "") if settings_obj is not None else ""
        # Treat default JWT "change-me" as not really configured for status clarity
        if env_k == "JWT_SECRET":
            flags[env_k] = bool(str(base or "").strip()) and str(base).strip() != "change-me"
        elif env_k == "DATABASE_URL":
            flags[env_k] = bool(str(base or "").strip())
        else:
            flags[env_k] = bool(str(base or "").strip())
    return flags


def apply_overlays_to_settings(s: Any) -> Any:
    """Mutate a Settings instance with non-secret + secret overlays."""
    for k, v in read_non_secret_overlay().items():
        if not hasattr(s, k):
            continue
        if k == "wf_chat_enabled":
            setattr(s, k, _as_bool(v, getattr(s, k)))
        elif k == "wf_chat_rate_limit_per_min":
            try:
                setattr(s, k, max(1, int(v)))
            except Exception:
                pass
        elif k == "max_upload_mb":
            try:
                setattr(s, k, max(1, int(v)))
            except Exception:
                pass
        elif k == "geocoder":
            g = str(v or "").strip().lower()
            if g in ("esri", "nominatim"):
                setattr(s, k, g)
        else:
            setattr(s, k, v if not isinstance(v, str) else v)
    for env_k, val in read_secret_overlay().items():
        attr = SECRET_ATTR.get(env_k)
        if attr and hasattr(s, attr):
            setattr(s, attr, val)
    return s


def _as_bool(v: Any, dflt: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return dflt
    s = str(v).strip().lower()
    if s in _BOOL_TRUE:
        return True
    if s in _BOOL_FALSE:
        return False
    return dflt


# ---------------- validation (SSRF-aware) ----------------

_PRIVATE_NETS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _host_is_private(host: str) -> bool:
    h = (host or "").strip().lower().rstrip(".")
    if not h:
        return True
    if h in ("localhost", "localhost.localdomain"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return any(ip in n for n in _PRIVATE_NETS)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(h, None)
        for info in infos:
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
                if any(ip in n for n in _PRIVATE_NETS):
                    return True
            except ValueError:
                continue
    except Exception:
        # Unresolvable — treat as warning, not hard fail
        return False
    return False


def validate_http_url(raw: str, *, field: str, allow_empty: bool = True, allow_private: bool = True) -> tuple[str, list[str]]:
    """Return (normalized_or_empty, warnings). Raises ValueError on hard errors."""
    warnings: list[str] = []
    s = (raw or "").strip()
    if not s:
        if allow_empty:
            return "", warnings
        raise ValueError(f"{field} is required")
    parsed = urlparse(s)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"{field} must be http(s); got scheme={parsed.scheme!r}")
    if not parsed.hostname:
        raise ValueError(f"{field} must include a hostname")
    if parsed.username or parsed.password:
        raise ValueError(f"{field} must not include credentials in the URL")
    private = _host_is_private(parsed.hostname)
    if private:
        msg = (
            f"{field} points at a private/loopback host ({parsed.hostname}). "
            "Allowed for local Ollama / ProjectX on the same box; do not point this at internal "
            "cloud metadata (169.254.169.254) or arbitrary RFC1918 hosts from untrusted input."
        )
        if parsed.hostname in ("169.254.169.254", "metadata.google.internal"):
            raise ValueError(f"{field}: cloud metadata endpoints are blocked (SSRF)")
        if not allow_private:
            raise ValueError(msg)
        warnings.append(msg)
    # Normalize: strip trailing slash for base URLs (except bare origin)
    out = s.rstrip("/")
    return out, warnings


def validate_cors_origins(raw: str) -> tuple[str, list[str]]:
    warnings: list[str] = []
    s = (raw or "").strip()
    if not s:
        raise ValueError("CORS_ORIGINS cannot be empty (use * for permissive)")
    if s == "*":
        warnings.append("CORS_ORIGINS=* is permissive — narrow before production cutover.")
        return "*", warnings
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if not parts:
        raise ValueError("CORS_ORIGINS has no valid entries")
    for p in parts:
        if p == "*":
            continue
        u = urlparse(p)
        if u.scheme not in ("http", "https") or not u.netloc:
            raise ValueError(f"CORS origin must be absolute http(s) URL: {p!r}")
        if u.path not in ("", "/"):
            warnings.append(f"CORS origin normally has no path; got {p!r}")
    return ",".join(parts), warnings


def validate_public_base_url(raw: str) -> tuple[str, list[str]]:
    s = (raw or "").strip().rstrip("/")
    if not s:
        raise ValueError("PUBLIC_BASE_URL cannot be empty")
    return validate_http_url(s, field="PUBLIC_BASE_URL", allow_empty=False, allow_private=True)


def validate_geocoder(raw: str) -> str:
    g = str(raw or "").strip().lower()
    if g not in ("esri", "nominatim"):
        raise ValueError("GEOCODER must be 'esri' or 'nominatim'")
    return g


def validate_non_secrets(body: dict[str, Any]) -> tuple[dict[str, Any], list[str], list[str]]:
    """Validate PATCH body for non-secrets. Returns (clean, warnings, restart_hints)."""
    clean: dict[str, Any] = {}
    warnings: list[str] = []
    restart: list[str] = []
    if "wf_chat_enabled" in body:
        clean["wf_chat_enabled"] = _as_bool(body.get("wf_chat_enabled"), False)
    if "wf_chat_llm_base_url" in body:
        u, w = validate_http_url(str(body.get("wf_chat_llm_base_url") or ""), field="WF_CHAT_LLM_BASE_URL", allow_empty=True)
        clean["wf_chat_llm_base_url"] = u
        warnings.extend(w)
    if "wf_chat_llm_model" in body:
        m = str(body.get("wf_chat_llm_model") or "").strip()
        if m and not re.match(r"^[\w./:+-]{1,128}$", m):
            raise ValueError("WF_CHAT_LLM_MODEL has invalid characters")
        clean["wf_chat_llm_model"] = m or "gpt-4o-mini"
    if "wf_chat_rate_limit_per_min" in body:
        try:
            n = int(body.get("wf_chat_rate_limit_per_min"))
        except Exception as e:
            raise ValueError("WF_CHAT_RATE_LIMIT_PER_MIN must be an integer") from e
        if n < 1 or n > 1000:
            raise ValueError("WF_CHAT_RATE_LIMIT_PER_MIN must be 1..1000")
        clean["wf_chat_rate_limit_per_min"] = n
    if "geocoder" in body:
        clean["geocoder"] = validate_geocoder(body.get("geocoder"))
    if "max_upload_mb" in body:
        try:
            n = int(body.get("max_upload_mb"))
        except Exception as e:
            raise ValueError("MAX_UPLOAD_MB must be an integer") from e
        if n < 1 or n > 102400:
            raise ValueError("MAX_UPLOAD_MB must be 1..102400")
        clean["max_upload_mb"] = n
    if "public_base_url" in body:
        u, w = validate_public_base_url(str(body.get("public_base_url") or ""))
        clean["public_base_url"] = u
        warnings.extend(w)
        restart.append("PUBLIC_BASE_URL")
    if "cors_origins" in body:
        u, w = validate_cors_origins(str(body.get("cors_origins") or ""))
        clean["cors_origins"] = u
        warnings.extend(w)
        restart.append("CORS_ORIGINS")
    if "vps_url" in body:
        u, w = validate_http_url(str(body.get("vps_url") or ""), field="VPS_URL", allow_empty=True, allow_private=True)
        clean["vps_url"] = u
        warnings.extend(w)
        if u:
            warnings.append(
                "VPS_URL is used server-side as an HTTP proxy target for Image localize. "
                "Only point it at your ProjectX / visual positioning service."
            )
    return clean, warnings, restart


def probe_llm(base_url: str, api_key: str = "", timeout: float = 3.0) -> dict[str, Any]:
    """Safe LLM reachability probe: GET {base}/models (OpenAI-compatible). No completions."""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "reachable": False, "error": "WF_CHAT_LLM_BASE_URL not set", "status": None}
    try:
        validate_http_url(base, field="WF_CHAT_LLM_BASE_URL", allow_empty=False, allow_private=True)
    except ValueError as e:
        return {"ok": False, "reachable": False, "error": str(e), "status": None}
    url = base + "/models"
    headers = {"Accept": "application/json", "User-Agent": "navme-runtime-config-probe/1"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
            # Drain a small amount only
            try:
                resp.read(4096)
            except Exception:
                pass
            return {"ok": 200 <= int(code) < 300, "reachable": True, "status": int(code), "error": None, "url": url}
    except urllib.error.HTTPError as e:
        # 401/403 still means host is reachable
        return {
            "ok": False,
            "reachable": True,
            "status": int(e.code),
            "error": f"HTTP {e.code}",
            "url": url,
        }
    except Exception as e:
        return {"ok": False, "reachable": False, "status": None, "error": type(e).__name__ + ": " + str(e)[:200], "url": url}


def build_status(settings_obj: Any) -> dict[str, Any]:
    from . import chat as chat_svc  # late import

    s = settings_obj
    secrets = secret_configured_flags(s)
    base = (s.wf_chat_llm_base_url or "").strip()
    key = (s.wf_chat_llm_api_key or "").strip()
    probe = probe_llm(base, key) if base else {"ok": False, "reachable": False, "error": "no base URL", "status": None}
    return {
        "chat_enabled": bool(getattr(s, "wf_chat_enabled", False)),
        "chat_configured": bool(chat_svc.llm_configured()),
        "llm_probe": probe,
        "vps_configured": bool((getattr(s, "vps_url", "") or "").strip()),
        "matterport_key_present": bool(secrets.get("MATTERPORT_SDK_KEY")),
        "public_base_url": getattr(s, "public_base_url", "") or "",
        "geocoder": getattr(s, "geocoder", "esri"),
        "max_upload_mb": int(getattr(s, "max_upload_mb", 8192) or 8192),
    }


def public_safe_view(settings_obj: Any) -> dict[str, Any]:
    """Admin GET payload — non-secret values + secret bools + status. Never secret values."""
    s = settings_obj
    overlay = read_non_secret_overlay()
    values = {
        "wf_chat_enabled": bool(s.wf_chat_enabled),
        "wf_chat_llm_base_url": s.wf_chat_llm_base_url or "",
        "wf_chat_llm_model": s.wf_chat_llm_model or "",
        "wf_chat_rate_limit_per_min": int(s.wf_chat_rate_limit_per_min or 20),
        "geocoder": s.geocoder or "esri",
        "max_upload_mb": int(s.max_upload_mb or 8192),
        "public_base_url": s.public_base_url or "",
        "cors_origins": s.cors_origins or "*",
        "vps_url": s.vps_url or "",
    }
    return {
        "values": values,
        "overlay_keys": sorted(overlay.keys()),
        "secrets": secret_configured_flags(s),
        "status": build_status(s),
        "paths": {
            "runtime_settings": str(SETTINGS_PATH),
            "runtime_secrets": str(SECRETS_PATH),
        },
        "notes": [
            "Non-secrets save to var/runtime_settings.json and apply after cache clear (most chat settings live).",
            "Secrets are write-only to var/runtime_secrets.env (0600); values are never returned.",
            "CORS_ORIGINS / JWT_SECRET / DATABASE_URL changes usually need: scripts/dev_server.sh restart",
            "Do not put secrets in Postgres. Do not display .env secret values in the UI.",
        ],
    }
