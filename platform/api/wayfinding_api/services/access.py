"""Building Access controls (twin/Tour gate + restricted routing paths).

Stored in pipeline_config.access (JSONB, no migration). Publish freezes a public
view into config.json (never the PIN). Matterport gate verifies PIN against the
draft hash in the DB. Restricted edges are removed from the published nav_graph.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from typing import Any

TWIN_MODES = ("public", "pin", "disabled")
ROUTING_MODES = ("all_public", "exclude_edges")
PIN_RE = re.compile(r"^[A-Za-z0-9]{4,8}$")
EDGE_ID_SPLIT = re.compile(r"[|\u2192→_]+")  # u|v, u→v, u__v


def hash_pin(pin: str) -> str:
    """SHA-256 of a salted PIN. Never store or publish the raw PIN."""
    raw = (pin or "").strip()
    payload = ("wf-navme-access-v1|" + raw).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def verify_pin(pin: str | None, pin_hash: str | None) -> bool:
    if not pin or not pin_hash:
        return False
    try:
        return hmac.compare_digest(hash_pin(str(pin)), str(pin_hash))
    except Exception:
        return False


def edge_id(u: str, v: str) -> str:
    """Canonical edge id as stored: u|v (order preserved from nav_graph)."""
    return f"{u}|{v}"


def edge_id_from_edge(e: dict) -> str | None:
    if not isinstance(e, dict):
        return None
    if e.get("id"):
        return str(e["id"])
    u, v = e.get("u"), e.get("v")
    if u is None or v is None:
        return None
    return edge_id(str(u), str(v))


def normalize_edge_id(raw: str) -> str | None:
    """Accept u|v, u→v, u__v, or a bare stored id. Returns canonical u|v when pair-like."""
    s = (raw or "").strip()
    if not s:
        return None
    # Already canonical-ish
    if "|" in s and "→" not in s and "__" not in s:
        parts = s.split("|", 1)
        if len(parts) == 2 and parts[0] and parts[1]:
            return f"{parts[0].strip()}|{parts[1].strip()}"
    parts = [p for p in EDGE_ID_SPLIT.split(s) if p]
    if len(parts) == 2:
        return f"{parts[0].strip()}|{parts[1].strip()}"
    return s


def normalize_edge_id_set(ids: list | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in ids or []:
        nid = normalize_edge_id(str(raw))
        if not nid or nid in seen:
            continue
        seen.add(nid)
        out.append(nid)
    return out


def _as_bool(v: Any, dflt: bool) -> bool:
    if v is True or v is False:
        return v
    if v in (1, "1", "true", "True", "yes"):
        return True
    if v in (0, "0", "false", "False", "no"):
        return False
    return dflt


def blank_access() -> dict:
    return {
        "twin": "public",
        "tour_public": True,
        "routing": {"mode": "all_public", "excluded_edge_ids": []},
    }


def parse_access(raw: dict | None) -> dict:
    """Normalize access dict for admin/publish (may include twin_pin_hash)."""
    base = blank_access()
    if not isinstance(raw, dict):
        return base
    twin = str(raw.get("twin") or "public").strip().lower()
    if twin not in TWIN_MODES:
        twin = "public"
    routing_in = raw.get("routing") if isinstance(raw.get("routing"), dict) else {}
    mode = str(routing_in.get("mode") or "all_public").strip().lower()
    if mode not in ROUTING_MODES:
        mode = "all_public"
    excl = normalize_edge_id_set(list(routing_in.get("excluded_edge_ids") or []))
    out = {
        "twin": twin,
        "tour_public": _as_bool(raw.get("tour_public"), True),
        "routing": {"mode": mode, "excluded_edge_ids": excl if mode == "exclude_edges" else []},
    }
    if raw.get("twin_pin_hash"):
        out["twin_pin_hash"] = str(raw["twin_pin_hash"])
    return out


def sanitize_access(incoming: dict | None, previous: dict | None = None) -> dict:
    """Merge/sanitize access for pipeline_config. Hashes twin_pin; never keeps plaintext."""
    prev = parse_access(previous if isinstance(previous, dict) else None)
    raw = incoming if isinstance(incoming, dict) else {}
    out = parse_access(raw)

    # PIN handling
    if out["twin"] == "pin":
        pin = raw.get("twin_pin")
        clear = raw.get("clear_twin_pin") is True or raw.get("twin_pin") == ""
        if isinstance(pin, str) and pin.strip():
            p = pin.strip()
            if not PIN_RE.match(p):
                raise ValueError("twin_pin must be 4–8 letters or digits")
            out["twin_pin_hash"] = hash_pin(p)
        elif clear:
            out.pop("twin_pin_hash", None)
        elif prev.get("twin_pin_hash"):
            out["twin_pin_hash"] = prev["twin_pin_hash"]
        # else: pin mode without hash yet — admin must set one before publish is useful
    else:
        out.pop("twin_pin_hash", None)

    out.pop("twin_pin", None)
    out.pop("clear_twin_pin", None)
    return out


def public_access_view(pipeline_or_access: dict | None) -> dict:
    """Published / viewer-facing access (no secrets)."""
    if isinstance(pipeline_or_access, dict) and "twin" in pipeline_or_access:
        a = parse_access(pipeline_or_access)
    else:
        a = parse_access((pipeline_or_access or {}).get("access") if isinstance(pipeline_or_access, dict) else None)
    return {
        "twin": a["twin"],
        "tour_public": bool(a["tour_public"]),
        "routing": {
            "mode": a["routing"]["mode"],
            "excluded_edge_ids": list(a["routing"]["excluded_edge_ids"]) if a["routing"]["mode"] == "exclude_edges" else [],
        },
        "pin_required": a["twin"] == "pin",
    }


def resolve_access_policy(building_pipeline: dict | None, published_cfg: dict | None = None) -> dict:
    """Prefer published config.access when present; else draft pipeline_config.access."""
    if isinstance(published_cfg, dict) and isinstance(published_cfg.get("access"), dict):
        return public_access_view(published_cfg["access"])
    return public_access_view(building_pipeline)


def matterport_allowed(policy: dict, pin: str | None, pin_hash: str | None) -> tuple[bool, int, str]:
    """Return (ok, http_status, detail)."""
    twin = (policy or {}).get("twin") or "public"
    tour_public = (policy or {}).get("tour_public", True)
    if twin == "disabled":
        return False, 403, "Digital twin is disabled for this building"
    if not tour_public and twin == "public":
        # Twin itself public, but Tour/Embed hidden for anonymous
        return False, 403, "Tour / Embed is not public for this building"
    if twin == "pin":
        if not pin_hash:
            return False, 403, "Digital twin PIN is not configured"
        if not verify_pin(pin, pin_hash):
            return False, 403, "Invalid or missing access PIN (send X-WF-Access header or ?access=)"
        return True, 200, "ok"
    # public twin + tour_public
    return True, 200, "ok"


def filter_nav_graph(nav: dict, excluded_edge_ids: list[str] | None) -> dict:
    """Return a shallow-copied nav_graph with excluded edges removed. Draft graph unchanged."""
    if not isinstance(nav, dict):
        return nav
    excl = set(normalize_edge_id_set(list(excluded_edge_ids or [])))
    if not excl:
        return nav
    # Also index reverses for undirected match
    excl_rev = set()
    for eid in list(excl):
        if "|" in eid:
            u, v = eid.split("|", 1)
            excl_rev.add(f"{v}|{u}")
    ban = excl | excl_rev

    edges_in = list(nav.get("edges") or [])
    edges_out = []
    removed = 0
    for e in edges_in:
        eid = edge_id_from_edge(e)
        if eid and eid in ban:
            removed += 1
            continue
        edges_out.append(e)
    out = dict(nav)
    out["edges"] = edges_out
    stats = dict(out.get("stats") or {})
    if stats:
        stats["nav_edges"] = len(edges_out)
        stats["excluded_edges"] = removed
        out["stats"] = stats
    # Annotate for honesty in published bundle
    out["access_routing"] = {
        "mode": "exclude_edges",
        "excluded_count": removed,
        "note": "Indoor mesh/geometry may still show corridors visually; public routing omits these edges.",
    }
    return out


def apply_routing_filter(nav: dict, access: dict | None) -> dict:
    a = parse_access(access)
    if a["routing"]["mode"] != "exclude_edges":
        return nav
    return filter_nav_graph(nav, a["routing"]["excluded_edge_ids"])


def route_impact_message(full_ok: bool, restricted_ok: bool) -> str:
    """Honest copy for Access tab route preview (full draft vs excluded-edges graph)."""
    if full_ok and not restricted_ok:
        return "Public users cannot reach this with current exclusions."
    if not full_ok:
        return "No route on the full draft graph (check POI nearest nodes / connectivity)."
    if full_ok and restricted_ok:
        return "Public route available under current exclusions (path may differ from the full graph)."
    return ""


def preview_route_impact(nav: dict, from_node: str, to_node: str, excluded_edge_ids: list[str] | None,
                         step_free: bool = False, route_fn=None) -> dict:
    """Compute full vs filtered routes without publishing. route_fn(nav, a, b, step_free) -> dict|None."""
    if route_fn is None:
        from . import navgraph
        route_fn = navgraph.route
    excl = normalize_edge_id_set(list(excluded_edge_ids or []))
    full = route_fn(nav, from_node, to_node, step_free)
    filtered_nav = filter_nav_graph(nav, excl) if excl else nav
    restricted = route_fn(filtered_nav, from_node, to_node, step_free) if excl else full
    full_ok = full is not None
    restricted_ok = restricted is not None
    return {
        "full": full,
        "restricted": restricted,
        "public_blocked": bool(full_ok and not restricted_ok),
        "message": route_impact_message(full_ok, restricted_ok),
        "excluded_count": len(excl),
        "excluded_edge_ids": excl,
    }
