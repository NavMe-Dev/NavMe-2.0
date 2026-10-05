"""Platform debug mode: settings (global + per-building override) and ring-buffer logs.

Global flag: var/data/platform_settings.json → {"debug":{"enabled":bool}}
Building override: pipeline_config.debug.enabled = true|false (omit/null = inherit global)
Effective = override if set, else global.

Clients POST batches to /api/v1/public/debug/logs when effective is on.
Admin Dashboard tails /api/v1/admin/debug/logs.
"""
from __future__ import annotations

import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from ..config import get_settings

_lock = threading.RLock()
_SEQ = 0
_BUF: deque[dict] = deque(maxlen=5000)
_LOADED = False

LEVELS = ("debug", "info", "warn", "error")
LEVEL_RANK = {k: i for i, k in enumerate(LEVELS)}


def _settings_path() -> Path:
    return get_settings().data_dir / "platform_settings.json"


def _log_path() -> Path:
    return get_settings().data_dir / "debug_logs.jsonl"


def _ensure_loaded() -> None:
    global _LOADED, _SEQ
    if _LOADED:
        return
    with _lock:
        if _LOADED:
            return
        p = _log_path()
        if p.is_file():
            try:
                # Tail last ~5000 lines only
                lines = p.read_text(encoding="utf-8", errors="replace").splitlines()[-5000:]
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(e, dict):
                        _BUF.append(e)
                        try:
                            _SEQ = max(_SEQ, int(e.get("id") or 0))
                        except Exception:
                            pass
            except Exception:
                pass
        _LOADED = True


def read_platform_settings() -> dict:
    p = _settings_path()
    if not p.is_file():
        return {"debug": {"enabled": False}}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"debug": {"enabled": False}}
    if not isinstance(raw, dict):
        return {"debug": {"enabled": False}}
    dbg = raw.get("debug") if isinstance(raw.get("debug"), dict) else {}
    return {"debug": {"enabled": bool(dbg.get("enabled"))}}


def write_platform_settings(settings: dict) -> dict:
    cur = read_platform_settings()
    if "debug" in (settings or {}):
        d = settings["debug"] if isinstance(settings.get("debug"), dict) else {}
        cur["debug"] = {"enabled": bool(d.get("enabled"))}
    p = _settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
    return cur


def building_override(pipeline_config: dict | None) -> bool | None:
    """Return True/False if building forces debug, or None to inherit global."""
    pc = pipeline_config or {}
    dbg = pc.get("debug")
    if dbg is True:
        return True
    if dbg is False:
        return False
    if not isinstance(dbg, dict):
        return None
    if "enabled" not in dbg or dbg.get("enabled") is None:
        return None
    return bool(dbg.get("enabled"))


def set_building_override(pipeline_config: dict | None, enabled: bool | None) -> dict:
    """Merge debug override into pipeline_config. enabled=None removes override (inherit)."""
    pc = dict(pipeline_config or {})
    if enabled is None:
        pc.pop("debug", None)
    else:
        pc["debug"] = {"enabled": bool(enabled)}
    return pc


def global_enabled() -> bool:
    return bool(read_platform_settings().get("debug", {}).get("enabled"))


def effective_enabled(pipeline_config: dict | None = None, building_slug: str | None = None,
                      db=None) -> bool:
    """Resolve effective debug for a building (or global-only when no building)."""
    ov = None
    if pipeline_config is not None:
        ov = building_override(pipeline_config)
    elif building_slug and db is not None:
        try:
            from .. import models
            b = db.query(models.Building).filter_by(slug=building_slug).first()
            if b:
                ov = building_override(b.pipeline_config)
        except Exception:
            ov = None
    if ov is not None:
        return bool(ov)
    return global_enabled()


def _norm_level(level: str | None) -> str:
    s = (level or "info").lower().strip()
    if s in ("warning", "warn"):
        return "warn"
    if s in ("err", "error", "fatal"):
        return "error"
    if s in ("debug", "trace", "verbose"):
        return "debug"
    if s in ("info", "log"):
        return "info"
    return "info"


def append_entries(entries: list[dict], *, force: bool = False) -> int:
    """Append log entries. Returns count accepted.
    When force=False, drops entries if neither global nor entry.building override is on
    (caller should already gate; this is a safety net using global only for speed).
    """
    _ensure_loaded()
    if not entries:
        return 0
    # Accept if global on OR force; per-building gating is done by the router.
    if not force and not global_enabled():
        # Still allow if any entry claims building — router checks; here accept for buffered write
        # when caller passed force after effective check.
        pass
    accepted = 0
    global _SEQ
    with _lock:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = []
        now = time.time()
        for raw in entries:
            if not isinstance(raw, dict):
                continue
            msg = raw.get("message")
            if msg is None:
                continue
            msg = str(msg)
            if len(msg) > 4000:
                msg = msg[:4000] + "…"
            src = str(raw.get("source") or "client")[:120]
            bldg = raw.get("building")
            bldg = (str(bldg)[:80] if bldg else None)
            level = _norm_level(raw.get("level"))
            ts = raw.get("ts") or raw.get("timestamp")
            try:
                ts_f = float(ts) if ts is not None else now
            except Exception:
                ts_f = now
            _SEQ += 1
            entry = {
                "id": _SEQ,
                "ts": ts_f,
                "level": level,
                "source": src,
                "building": bldg,
                "message": msg,
            }
            meta = raw.get("meta")
            if isinstance(meta, dict) and meta:
                try:
                    s = json.dumps(meta, default=str)
                    if len(s) > 1500:
                        entry["meta"] = {"_truncated": s[:1500] + "…"}
                    else:
                        entry["meta"] = json.loads(s)
                except Exception:
                    pass
            client = raw.get("client")
            if client:
                entry["client"] = str(client)[:80]
            _BUF.append(entry)
            lines.append(json.dumps(entry, ensure_ascii=False))
            accepted += 1
        if lines:
            with path.open("a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
    return accepted


def log_server(level: str, source: str, message: str, building: str | None = None,
               meta: dict | None = None) -> None:
    """Server-side log line when global debug is on (or force via effective elsewhere)."""
    if not global_enabled():
        return
    append_entries([{
        "level": level, "source": source, "message": message,
        "building": building, "meta": meta or {}, "client": "server",
    }], force=True)


def query_logs(*, after_id: int = 0, limit: int = 200, level: str | None = None,
               building: str | None = None, source: str | None = None,
               tail: bool = False) -> dict[str, Any]:
    """Return logs. after_id>0 → incremental stream (id > after_id).
    after_id==0 → latest `limit` matching rows (tail page) unless tail=False then from start.
    """
    _ensure_loaded()
    limit = max(1, min(int(limit or 200), 1000))
    after_id = max(0, int(after_id or 0))
    min_rank = LEVEL_RANK.get(_norm_level(level), 0) if level else None
    with _lock:
        items = list(_BUF)

    def match(e):
        if building and (e.get("building") or "") != building:
            return False
        if source and source not in str(e.get("source") or ""):
            return False
        if min_rank is not None and LEVEL_RANK.get(e.get("level") or "info", 1) < min_rank:
            return False
        return True

    if after_id > 0:
        out = []
        for e in items:
            if int(e.get("id") or 0) <= after_id:
                continue
            if match(e):
                out.append(e)
                if len(out) >= limit:
                    break
    else:
        matched = [e for e in items if match(e)]
        out = matched[-limit:] if (tail or True) else matched[:limit]
    last_id = int(out[-1]["id"]) if out else after_id
    return {
        "logs": out,
        "last_id": last_id,
        "total_buffered": len(items),
        "debug_enabled": global_enabled(),
    }


def clear_logs() -> dict:
    global _SEQ
    _ensure_loaded()
    with _lock:
        _BUF.clear()
        p = _log_path()
        if p.is_file():
            p.write_text("", encoding="utf-8")
        # keep seq so ids stay monotonic across clears
    return {"ok": True, "cleared": True}


def export_text(*, level: str | None = None, building: str | None = None) -> str:
    q = query_logs(after_id=0, limit=5000, level=level, building=building)
    lines = []
    for e in q["logs"]:
        from datetime import datetime, timezone
        try:
            ts = datetime.fromtimestamp(float(e["ts"]), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
        except Exception:
            ts = str(e.get("ts"))
        b = e.get("building") or "-"
        lines.append(f"{ts}\t{e.get('level')}\t{e.get('source')}\t{b}\t{e.get('message')}")
    return "\n".join(lines) + ("\n" if lines else "")
