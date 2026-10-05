"""Admin Spatial Studio chat (Option 4 phase 1): ops + Access tools over the public chat LLM stack.

Read-only in v1  -  no Save/Publish/delete. Never returns PIN plaintext or twin_pin_hash.
"""
from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import models
from . import access as access_svc
from . import chat as chat_svc
from . import debug_log as dbg
from . import navgraph
from . import publish as pub
from . import workspace

ADMIN_SYSTEM_PROMPT = """You are the NavMe Spatial Assistant for building operators (admins).
Rules:
- Ground every factual claim in tool results. Never invent buildings, POIs, jobs, Access settings, PINs, API keys, or hashes.
- NEVER invent tools or claim you called a tool that is not in the tool list. There is no set_access, lock_entrance, update_access, or any write/mutation tool. Chat is read-only.
- Answer in short human-readable prose or bullets. Do not paste raw tool JSON, code fences of payloads, or secret fields.
- You may explain how Access works using explain_access and report current draft Access via get_building_access.
- Never reveal PIN values, twin_pin_hash, JWT secrets, LLM keys, or Matterport SDK keys. If twin=pin, say pin_required / PIN is set or not  -  nothing more.
- Refuse destructive actions (Save, Publish, delete POI, cancel job, clear logs, change Access, lock doors). Tell the operator to use Spatial Studio UI tabs (Access tab for twin gate / exclude_edges). Never claim you locked, unlocked, or restricted anything.
- Prefer the current building slug from context when calling building-scoped tools unless the user names another building. When the user says they are already in a building (e.g. "we already in GCU"), the Context building slug is authoritative — do not switch buildings or list other buildings.
- When the user says open / go to / switch to a building (e.g. "open gcu"), call open_building with their query. That returns Spatial Studio hash links (#/b/<slug>) and the public viewer URL — do not invent Google Cloud or unrelated products.
- For entrances / places inside the current building, ALWAYS call search_pois with that building slug and query/category for entrance (or the place). Return only POI names from that building. NEVER treat list_buildings / list_admin_buildings results (addresses or other building names) as entrances.
- For place / route questions on published data, use the public-safe tools (search_pois, route, make_deep_link). Use list_buildings only when the user asks for buildings, not for entrances or rooms.
- When summarizing Access, remind that Save writes draft pipeline_config.access and Publish is required for the public viewer / filtered nav graph.
"""

# Curated from docs/ACCESS_OPTIONS.md  -  no runtime markdown read.
ACCESS_FAQ = """
# NavMe Access (operator FAQ)

## Two layers
1. Twin / Tour gate  -  who may open Embed Showcase Tour and fetch the public matterport application key.
2. Restricted paths  -  which nav-graph edges are omitted from the published public routing graph.

Indoor mesh / floor plan may still draw a corridor in v1; routing simply will not use excluded edges.

## Schema (pipeline_config.access)
- twin: public | pin | disabled
- twin_pin_hash: draft only, never published, never shown to chat users
- tour_public: bool  -  if false, hide Tour/Embed for anonymous even when twin is public
- routing.mode: all_public | exclude_edges
- routing.excluded_edge_ids: list of u|v edge ids (undirected match; also accepts u→v / u__v when pasting)

## Twin modes
- twin=public: default; public matterport may return application_key (subject to tour_public).
- twin=pin: public matterport requires header X-WF-Access or query ?access= matching the PIN. Compared to twin_pin_hash in draft DB. PIN is 4–8 letters/digits; API hashes and drops plaintext.
- twin=disabled: public matterport → 403; viewer hides Tour.

## Save vs Publish
- Save (Access tab) → PATCH building with merged pipeline_config.access (does not wipe elevators / media / tour_modes / debug).
- Re-Publish freezes twin policy into published config.json and writes filtered public nav_graph.json.
- Draft workspace nav graph stays full. Access tab route impact preview compares full vs filtered without publishing.

## Route preview
POST admin …/route-access-preview with from_key, to_key, optional excluded_edge_ids (defaults to current draft). Summarizes full vs filtered reachability. If full works and filtered fails: Public users cannot reach this with current exclusions.

## Honesty / gaps
- Mesh still visible for restricted corridors; only routing edges filtered.
- PIN is a shared building secret (not per-user). Admin Showcase JWT path is unchanged.
- Chat must never return PIN or hash values.
"""

ADMIN_TOOL_DEFS = [
    *chat_svc.TOOL_DEFS,
    {
        "type": "function",
        "function": {
            "name": "list_admin_buildings",
            "description": "List all admin buildings including unpublished (slug, name, status, published version).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_building_access",
            "description": (
                "Read draft pipeline_config.access for a building slug: twin, tour_public, "
                "routing.mode, excluded_edge_ids (capped), pin_set bool. Never returns PIN or hash. "
                "Notes that Publish is needed for public to pick up changes."
            ),
            "parameters": {
                "type": "object",
                "properties": {"slug": {"type": "string"}},
                "required": ["slug"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "explain_access",
            "description": (
                "Return structured Access FAQ snippets (twin modes, exclude_edges, Save vs Publish, "
                "mesh still visible, PIN headers, route preview). Use for how-Access-works questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Optional focus: twin, pin, routing, publish, preview, mesh, or all.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route_access_preview",
            "description": (
                "Compare full draft route vs filtered (excluded edges) without publish. "
                "Defaults excluded_edge_ids to current draft access. Summarizes reachability."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "from_key": {"type": "string", "description": "Origin draft POI key."},
                    "to_key": {"type": "string", "description": "Destination draft POI key."},
                    "step_free": {"type": "boolean"},
                    "excluded_edge_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional override; omit to use draft access exclusions.",
                    },
                },
                "required": ["slug", "from_key", "to_key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_jobs",
            "description": "List recent onboard/rebuild jobs (id, building, kind, status, step, error snippet).",
            "parameters": {
                "type": "object",
                "properties": {
                    "building": {"type": "string", "description": "Optional building slug filter."},
                    "limit": {"type": "integer", "description": "Max jobs (default 15, max 50)."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_job",
            "description": "Get one job by id: status, step, error, recent log tail (truncated).",
            "parameters": {
                "type": "object",
                "properties": {"job_id": {"type": "integer"}},
                "required": ["job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "debug_logs",
            "description": "Read-only recent platform debug logs (level/building/source filters). Small limit.",
            "parameters": {
                "type": "object",
                "properties": {
                    "building": {"type": "string"},
                    "level": {"type": "string", "description": "Minimum level: debug|info|warn|error"},
                    "source": {"type": "string"},
                    "limit": {"type": "integer", "description": "Max rows (default 20, max 40)."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_building",
            "description": (
                "Resolve a building by short name/slug (e.g. gcu, tacoma) and return Spatial Studio "
                "admin hash (#/b/<slug>), Access tab hash, and public viewer URL. Use for open/go to/switch building."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Building name or slug fragment (e.g. gcu, tacoma, greenland)."},
                },
                "required": ["query"],
            },
        },
    },
]

_ADMIN_ONLY = {
    "list_admin_buildings",
    "get_building_access",
    "explain_access",
    "route_access_preview",
    "list_jobs",
    "get_job",
    "debug_logs",
    "open_building",
}
_ADMIN_TOOLS = chat_svc._PUBLIC_TOOLS | _ADMIN_ONLY
_EDGE_LIST_CAP = 50

_OPEN_BUILDING_RE = re.compile(
    r"^\s*(?:please\s+)?(?:"
    r"open|go\s*to|goto|switch\s+to|show|navigate\s+to|load|take\s+me\s+to"
    r")\s+(?:the\s+)?(.+?)(?:\s+building)?\s*[.!?]*\s*$",
    re.I,
)
# Avoid treating place/route phrases as building opens
_OPEN_SKIP_RE = re.compile(
    r"\b(bathroom|restroom|toilet|garage|parking|kitchen|elevator|stairs|"
    r"directions?|route|poi|room|entrance|door|access|twin|pin|job|log)\b",
    re.I,
)


def _score_building_needle(needle: str, slug: str, name: str) -> float:
    n = (needle or "").strip().lower()
    if not n:
        return 0.0
    best = 0.0
    for c in (slug or "", name or ""):
        cl = c.lower()
        if not cl:
            continue
        if n == cl:
            best = max(best, 1.0)
        elif n in cl or cl in n:
            # Prefer slug substring (gcu in gcu-omr-libra) over tiny accidental matches
            best = max(best, 0.9 if n in (slug or "").lower() else 0.82)
        else:
            from difflib import SequenceMatcher
            best = max(best, SequenceMatcher(None, n, cl).ratio())
    return best


def _resolve_admin_building(db: Session, query: str):
    needle = (query or "").strip()
    if not needle:
        return None
    best_b = None
    best_score = 0.0
    for b in db.query(models.Building).all():
        score = _score_building_needle(needle, b.slug or "", b.name or "")
        if score > best_score:
            best_score = score
            best_b = b
    if best_b and best_score >= 0.72:
        return best_b
    return None


def tool_open_building(db: Session, query: str) -> dict:
    b = _resolve_admin_building(db, query)
    if not b:
        return {
            "error": f"no building matching: {query}",
            "status": 404,
            "hint": "Try list_admin_buildings, or a slug like gcu-omr-libra / 4926-tacoma.",
        }
    admin_hash = f"#/b/{b.slug}"
    access_hash = f"#/b/{b.slug}/access"
    overview_hash = f"#/b/{b.slug}/overview"
    viewer_url = f"/?b={b.slug}"
    label = b.name or b.slug
    actions = [
        {
            "type": "deep_link",
            "url": admin_hash,
            "label": f"Open {label} in Studio",
            "intent": "admin_nav",
        },
        {
            "type": "deep_link",
            "url": access_hash,
            "label": "Access tab",
            "intent": "admin_nav",
        },
        {
            "type": "deep_link",
            "url": viewer_url,
            "label": "Public viewer",
            "intent": "viewer",
        },
    ]
    return {
        "slug": b.slug,
        "name": b.name,
        "status": b.status,
        "admin_url": admin_hash,
        "overview_url": overview_hash,
        "access_url": access_hash,
        "viewer_url": viewer_url,
        "actions": actions,
        "action": actions[0],
        "note": "Studio links are hash routes in Spatial Studio; Public viewer opens the published map.",
    }


def _maybe_force_open_building(db: Session, user_text: str | None) -> dict | None:
    """Deterministic open/go-to building for small models that skip tools or invent GCU=Google."""
    text = (user_text or "").strip()
    if not text:
        return None
    m = _OPEN_BUILDING_RE.match(text)
    if not m:
        return None
    needle = (m.group(1) or "").strip().strip('\'"')
    if not needle or _OPEN_SKIP_RE.search(needle):
        return None
    # Too long = probably not a building name
    if len(needle) > 64:
        return None
    result = tool_open_building(db, needle)
    if result.get("error"):
        return None
    return result



_LIST_ENTRANCES_RE = re.compile(
    r"(?:"
    r"\b(?:list|show|give|get|find|what(?:'s|s| are| is)?|which|all)\b.{0,40}\bentrances?\b"
    r"|\bentrances?\b.{0,40}\b(?:list|in|for|of|here|this)\b"
    r"|\b(?:the|all)\s+entrances?\b"
    r")",
    re.I | re.S,
)

_LOCK_RESTRICT_RE = re.compile(
    r"(?:"
    r"\b(?:lock|unlock|restrict|block|close|seal|disable)\b.{0,48}\b(?:entrance|door|path|access|edge|twin|gate|route)s?\b"
    r"|\b(?:entrance|door|path|access|edge)s?\b.{0,48}\b(?:lock|unlock|restrict|block|close|seal)\b"
    r"|\block\s+all\b"
    r"|\bset_access\b"
    r"|\brestrict\s+(?:all\s+)?(?:paths?|routes?|edges?)\b"
    r")",
    re.I | re.S,
)

_SLUG_IN_MSG_RE = re.compile(
    r"\b(?:in|for|at|of)\s+(?:the\s+)?([a-z0-9][a-z0-9._-]{1,48})\b",
    re.I,
)

_TAB_LABELS = {
    "overview": "Overview",
    "georef": "Georeference",
    "floors": "Floors",
    "elevators": "Elevators",
    "media": "Media",
    "tour": "Tour",
    "access": "Access",
    "pois": "POIs",
    "routes": "Route tester",
    "publish": "Publish",
    "jobs": "Jobs",
    "dashboard": "Dashboard",
    "buildings": "Buildings list",
    "wizard": "Add building",
    "scan-plans": "Scan planning",
    "scan-plan": "Scan plan",
    "login": "Login",
    "debug": "Dashboard",
}


def parse_admin_route(route: str | None = None, path: str | None = None) -> dict:
    """Parse Spatial Studio hash path into building/tab/page context."""
    raw = (path or route or "").strip()
    if raw.startswith("#"):
        raw = raw[1:]
    raw = raw.strip() or "/"
    if not raw.startswith("/"):
        raw = "/" + raw
    out = {
        "path": raw,
        "building": None,
        "tab": None,
        "page": "buildings",
    }
    if raw in ("/", ""):
        out["page"] = "buildings"
        return out
    if raw in ("/dashboard", "/debug"):
        out["page"] = "dashboard"
        out["tab"] = "dashboard"
        return out
    if raw == "/new":
        out["page"] = "wizard"
        out["tab"] = "wizard"
        return out
    if raw in ("/scan-plan", "/scan-plans"):
        out["page"] = "scan-plans"
        out["tab"] = "scan-plans"
        return out
    m = re.match(r"^/scan-plan/([^/]+)", raw)
    if m:
        out["page"] = "scan-plan"
        out["tab"] = "scan-plan"
        return out
    m = re.match(r"^/b/([^/]+)(?:/([a-z][\w-]*))?", raw)
    if m:
        out["building"] = m.group(1)
        out["tab"] = (m.group(2) or "overview").lower()
        out["page"] = "building"
        return out
    if raw == "/login":
        out["page"] = "login"
        out["tab"] = "login"
        return out
    out["page"] = "buildings"
    return out


def _context_blurb(building: str | None, tab: str | None, path: str | None, page: str | None = None) -> list[str]:
    bits: list[str] = []
    parsed = parse_admin_route(path=path) if path else {
        "building": building, "tab": tab, "page": page or ("building" if building else "buildings"), "path": path,
    }
    slug = building or parsed.get("building")
    tab_id = (tab or parsed.get("tab") or "").strip().lower() or None
    page_id = page or parsed.get("page")
    path_s = path or parsed.get("path")
    if slug:
        bits.append(f"Current building slug: {slug}")
    if tab_id:
        label = _TAB_LABELS.get(tab_id, tab_id)
        if slug:
            bits.append(f"Operator is currently on {label} for building {slug}.")
        else:
            bits.append(f"Operator is currently on {label}.")
    elif page_id and page_id != "building":
        label = _TAB_LABELS.get(page_id, page_id)
        bits.append(f"Operator is currently on {label}.")
    if path_s:
        bits.append(f"Admin route path: {path_s}")
    if slug and tab_id == "access":
        bits.append(
            "Prefer Access tools for this turn: get_building_access, explain_access, "
            "route_access_preview, and search_pois for entrance POIs on this slug. "
            "Do not ask the operator to open the building again."
        )
    elif slug:
        bits.append(
            "Building context slug is authoritative when the operator refers to 'this building', "
            "'here', or 'we already in …'. Do not list other buildings as places inside it."
        )
    return bits


def _resolve_slug_for_force(db: Session, building: str | None, user_text: str | None) -> str | None:
    """Prefer chat Context building slug; else resolve a named building from the message."""
    pref = (building or "").strip() or None
    if pref:
        b = db.query(models.Building).filter_by(slug=pref).first()
        if b:
            return b.slug
    text = (user_text or "").strip()
    if not text:
        return pref
    for tok in re.findall(r"\b([a-z0-9]+(?:-[a-z0-9]+){1,6})\b", text.lower()):
        hit = db.query(models.Building).filter_by(slug=tok).first()
        if hit:
            return hit.slug
    m = _SLUG_IN_MSG_RE.search(text)
    if m:
        needle = (m.group(1) or "").strip()
        if needle and needle.lower() not in {
            "entrances", "entrance", "building", "studio", "access", "list", "here", "this",
        }:
            resolved = _resolve_admin_building(db, needle)
            if resolved:
                return resolved.slug
    for tok in re.findall(r"\b([a-z][a-z0-9]{1,24})\b", text.lower()):
        if tok in {"list", "show", "give", "entrances", "entrance", "lock", "all", "the", "of", "in", "for"}:
            continue
        resolved = _resolve_admin_building(db, tok)
        if resolved and _score_building_needle(tok, resolved.slug or "", resolved.name or "") >= 0.85:
            return resolved.slug
    return pref


def tool_list_draft_pois_by_category(
    db: Session,
    slug: str,
    category: str = "entrance",
    limit: int = 20,
) -> dict:
    """Draft-workspace POI list by category (admin fallback when unpublished)."""
    limit = max(1, min(int(limit or 20), 40))
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        return {"error": f"unknown building: {slug}", "status": 404, "results": [], "count": 0}
    cat = chat_svc._normalize_category(category) or (category or "").strip().lower() or "entrance"
    rows = (
        db.query(models.POI)
        .filter_by(building_id=b.id)
        .order_by(models.POI.floor, models.POI.name)
        .all()
    )
    hits = []
    for p in rows:
        pcat = (p.category or "").lower()
        if pcat != cat and chat_svc._normalize_category(pcat) != cat:
            if cat not in chat_svc._synonym_members(pcat) and pcat not in chat_svc._synonym_members(cat):
                continue
        hits.append({
            "id": p.key,
            "name": p.name,
            "code": p.code,
            "category": p.category,
            "floor": p.floor,
        })
        if len(hits) >= limit:
            break
    out: dict[str, Any] = {
        "slug": b.slug,
        "query": cat,
        "category": cat,
        "source": "draft",
        "results": hits,
        "count": len(hits),
    }
    if not hits:
        cats: dict[str, int] = {}
        for p in rows:
            c = (p.category or "other").lower() or "other"
            cats[c] = cats.get(c, 0) + 1
        out["catalogue_size"] = len(rows)
        out["available_categories"] = cats
        out["empty_reason"] = f"no_{cat}_tagged"
    return out


def _search_entrances_for_slug(db: Session, slug: str) -> dict:
    """Published search_pois(category=entrance); fall back to draft POIs if needed."""
    try:
        published = chat_svc.tool_search_pois(db, slug, "entrance", category="entrance", limit=20)
    except HTTPException as e:
        published = {"error": e.detail, "status": e.status_code, "results": [], "count": 0, "slug": slug}
    except Exception as e:
        published = {"error": f"{type(e).__name__}: {e}", "results": [], "count": 0, "slug": slug}
    hits = published.get("results") if isinstance(published, dict) else None
    if isinstance(hits, list) and hits:
        published["source"] = "published"
        published["category"] = "entrance"
        return published
    draft = tool_list_draft_pois_by_category(db, slug, "entrance", limit=20)
    if draft.get("results"):
        return draft
    if isinstance(published, dict) and not published.get("error"):
        published["source"] = "published"
        published["category"] = "entrance"
        published["empty_reason"] = published.get("empty_reason") or "no_entrance_tagged"
        return published
    if isinstance(draft, dict):
        return draft
    return published if isinstance(published, dict) else {"slug": slug, "results": [], "count": 0}


def _format_entrance_list_reply(res: dict, slug: str) -> str:
    hits = res.get("results") if isinstance(res, dict) else None
    if hits:
        lines = [f"- {chat_svc._format_poi_line(h)}" for h in hits[:20]]
        src = res.get("source") or "published"
        head = f"Entrances in {slug}" + (" (draft POIs)" if src == "draft" else "") + ":"
        more = ""
        total = res.get("count") or len(hits)
        if total > len(lines):
            more = f"\n(+{total - len(lines)} more)"
        return head + "\n" + "\n".join(lines) + more
    cats = res.get("available_categories") if isinstance(res, dict) else None
    avail = ""
    if isinstance(cats, dict) and cats:
        bits = [f"{n} {c}" for c, n in sorted(cats.items(), key=lambda kv: (-kv[1], kv[0])) if n]
        avail = " Available place types: " + ", ".join(bits[:6]) + "."
    err = (res or {}).get("error") if isinstance(res, dict) else None
    if err:
        return (
            f"Could not load entrance POIs for {slug} ({err}). "
            "Entrances are POIs with category entrance inside this building — "
            "not other buildings on the campus list."
        )
    return (
        f"No entrance-tagged POIs in {slug}.{avail} "
        "I will not list other buildings as entrances. "
        "Tag entrances on the POIs tab, then ask again."
    )


def _maybe_force_list_entrances(
    db: Session,
    building: str | None,
    user_text: str | None,
) -> dict | None:
    """Deterministic entrance listing — never list_buildings addresses as entrances."""
    text = (user_text or "").strip()
    if not text or not _LIST_ENTRANCES_RE.search(text):
        return None
    if _LOCK_RESTRICT_RE.search(text):
        return None
    low = text.lower()
    if re.search(r"\b(exclude_edges|twin|pin_required|routing\.mode)\b", low):
        return None
    slug = _resolve_slug_for_force(db, building, text)
    if not slug:
        return {
            "message": (
                "To list entrances I need a building. Open one in Spatial Studio "
                "(#/b/<slug>/…) or name it (e.g. \"list entrances in gcu\")."
            ),
            "actions": [],
            "tools_used": [],
            "configured": True,
        }
    res = _search_entrances_for_slug(db, slug)
    msg = _format_entrance_list_reply(res, slug)
    actions: list[dict] = []
    for h in (res.get("results") or [])[:8]:
        act = chat_svc._action_for_hit(slug, h or {})
        if isinstance(act, dict):
            actions.append(act)
    return {
        "message": msg,
        "actions": actions,
        "tools_used": ["search_pois"],
        "configured": True,
    }


def _lock_restrict_reply(db: Session, slug: str | None) -> dict:
    """Read-only guidance for lock/restrict asks — never claims Access changed."""
    tools_used = ["explain_access"]
    access_bits = ""
    actions: list[dict] = []
    # Touch explain so tools_used is honest / testable
    tool_explain_access("routing")
    if slug:
        acc = tool_get_building_access(db, slug)
        tools_used.append("get_building_access")
        if not acc.get("error"):
            a = acc.get("access") or {}
            routing = a.get("routing") or {}
            access_bits = (
                f" Current draft for {slug}: twin={a.get('twin')}, "
                f"routing.mode={routing.get('mode')}, "
                f"excluded_edges={routing.get('excluded_edge_ids_count', 0)}."
            )
        access_url = f"#/b/{slug}/access"
        actions = [{
            "type": "deep_link",
            "url": access_url,
            "label": "Open Access tab",
            "intent": "admin_nav",
        }]
    else:
        access_url = "#/b/<slug>/access"
    msg = (
        "I cannot lock, unlock, or restrict entrances or paths from chat — "
        "NavMe Spatial Assistant is read-only and has no set_access tool. "
        "Use the Access tab in Spatial Studio: set routing.mode to exclude_edges "
        "and select edges to omit (or configure the twin gate: public / pin / disabled). "
        f"Open {access_url}, use the Access chips / edge map, then Save and Publish."
        f"{access_bits} "
        "I have not changed any Access settings."
    )
    return {
        "message": msg.strip(),
        "actions": actions,
        "tools_used": tools_used,
        "configured": True,
    }


def _maybe_force_lock_restrict(
    db: Session,
    building: str | None,
    user_text: str | None,
) -> dict | None:
    """Deterministic refusal + Access UI guidance for lock/restrict asks."""
    text = (user_text or "").strip()
    if not text or not _LOCK_RESTRICT_RE.search(text):
        return None
    slug = _resolve_slug_for_force(db, building, text)
    return _lock_restrict_reply(db, slug)



def tool_list_admin_buildings(db: Session) -> dict:
    out = []
    for b in db.query(models.Building).order_by(models.Building.name):
        mv = pub.current_version(db, b)
        out.append({
            "slug": b.slug,
            "name": b.name,
            "status": b.status,
            "published_version": mv.version if mv else None,
            "address": b.address,
            "venue": b.venue.slug if b.venue else None,
        })
    return {"buildings": out, "count": len(out)}


def tool_get_building_access(db: Session, slug: str) -> dict:
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        return {"error": f"unknown building: {slug}", "status": 404}
    raw = (b.pipeline_config or {}).get("access") if isinstance(b.pipeline_config, dict) else None
    a = access_svc.parse_access(raw if isinstance(raw, dict) else None)
    excl = list(a["routing"]["excluded_edge_ids"] or [])
    capped = excl[:_EDGE_LIST_CAP]
    pin_set = bool(a.get("twin_pin_hash"))
    # Explicitly strip any secret fields  -  never return hash or PIN.
    return {
        "slug": b.slug,
        "name": b.name,
        "access": {
            "twin": a["twin"],
            "tour_public": bool(a["tour_public"]),
            "routing": {
                "mode": a["routing"]["mode"],
                "excluded_edge_ids_count": len(excl),
                "excluded_edge_ids": capped,
                "excluded_edge_ids_truncated": len(excl) > _EDGE_LIST_CAP,
            },
            "pin_set": pin_set,
            "pin_required": a["twin"] == "pin",
        },
        "note": (
            "This is draft pipeline_config.access. Save writes the draft; "
            "Publish is required for the public viewer and filtered public nav_graph to pick up changes. "
            "PIN and hash values are never included in this tool result."
        ),
    }


def tool_explain_access(topic: str | None = None) -> dict:
    t = (topic or "all").strip().lower() or "all"
    sections = {
        "twin": (
            "Twin modes: public (default, matterport key may be returned subject to tour_public); "
            "pin (requires X-WF-Access or ?access=; hash compare against draft twin_pin_hash); "
            "disabled (public matterport 403, Tour hidden)."
        ),
        "pin": (
            "PIN is 4–8 letters/digits. Admin sends twin_pin once; API stores sha256 hash only. "
            "Published config.access never includes pin or hash (only twin, tour_public, routing, pin_required). "
            "Chat reports pin_set / pin_required only  -  never the PIN or hash."
        ),
        "routing": (
            "routing.mode=all_public keeps all edges. exclude_edges removes listed u|v edges from the "
            "published nav_graph on Publish (undirected). Draft workspace graph stays full."
        ),
        "publish": (
            "Access Save → PATCH pipeline_config.access (merged; does not wipe elevators/media/tour_modes/debug). "
            "Re-Publish freezes twin policy into published config.json and writes filtered public nav_graph.json."
        ),
        "preview": (
            "Access tab route impact preview (and route_access_preview tool) compares full draft route vs "
            "filtered exclusions without publishing. If full succeeds and filtered fails: "
            "Public users cannot reach this with current exclusions."
        ),
        "mesh": (
            "Indoor mesh / floor plan geometry may still draw a corridor visually in v1; "
            "only routing omits excluded edges. That honesty is intentional."
        ),
    }
    if t in sections:
        picked = {t: sections[t]}
    elif t == "all":
        picked = dict(sections)
    else:
        # Fuzzy: include related keys mentioned in topic string
        picked = {k: v for k, v in sections.items() if k in t}
        if not picked:
            picked = dict(sections)
    return {
        "topic": t,
        "snippets": picked,
        "faq_excerpt": ACCESS_FAQ.strip()[:3500],
        "ui_route": "#/b/<slug>/access",
    }


def _summarize_route_leg(leg: dict | None) -> dict | None:
    if not isinstance(leg, dict):
        return None
    return {
        "ok": True,
        "length_m": leg.get("length_m"),
        "eta_s": leg.get("eta_s"),
        "floors": leg.get("floors"),
        "stair_edges": leg.get("stair_edges"),
        "elevator_edges": leg.get("elevator_edges"),
    }


def tool_route_access_preview(
    db: Session,
    slug: str,
    from_key: str,
    to_key: str,
    step_free: bool = False,
    excluded_edge_ids: list[str] | None = None,
) -> dict:
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        return {"error": f"unknown building: {slug}", "status": 404}
    nav = workspace.latest_nav(db, b)
    if not nav:
        return {"ok": False, "error": "no nav graph", "slug": slug}
    get = lambda k: db.query(models.POI).filter_by(building_id=b.id, key=k).first()
    a, z = get(from_key), get(to_key)
    if not a or not z:
        return {"ok": False, "error": "unknown POI key", "from_key": from_key, "to_key": to_key}
    if not a.nearest_node or not z.nearest_node:
        return {"ok": False, "error": "POI missing nearest_node (snap POIs first)"}
    if excluded_edge_ids is not None:
        excl = list(excluded_edge_ids)
    else:
        acc = access_svc.parse_access((b.pipeline_config or {}).get("access"))
        excl = list(acc["routing"]["excluded_edge_ids"]) if acc["routing"]["mode"] == "exclude_edges" else []
    out = access_svc.preview_route_impact(
        nav, a.nearest_node, z.nearest_node, excl, step_free=bool(step_free), route_fn=navgraph.route
    )
    full_ok = out.get("full") is not None
    restricted_ok = out.get("restricted") is not None
    return {
        "ok": True,
        "slug": slug,
        "from_key": from_key,
        "to_key": to_key,
        "from_name": a.name,
        "to_name": z.name,
        "step_free": bool(step_free),
        "excluded_count": out.get("excluded_count"),
        "excluded_edge_ids": (out.get("excluded_edge_ids") or [])[:_EDGE_LIST_CAP],
        "full": _summarize_route_leg(out.get("full")),
        "restricted": _summarize_route_leg(out.get("restricted")),
        "full_reachable": full_ok,
        "filtered_reachable": restricted_ok,
        "public_blocked": bool(out.get("public_blocked")),
        "message": out.get("message") or "",
        "note": "Preview uses draft graph; does not require Save or Publish.",
    }


def tool_list_jobs(db: Session, building: str | None = None, limit: int = 15) -> dict:
    limit = max(1, min(int(limit or 15), 50))
    q = db.query(models.Job)
    if building:
        b = db.query(models.Building).filter_by(slug=building).first()
        if not b:
            return {"error": f"unknown building: {building}", "status": 404}
        q = q.filter_by(building_id=b.id)
    rows = q.order_by(models.Job.id.desc()).limit(limit).all()
    bid_to_slug = {}
    out = []
    for j in rows:
        if j.building_id not in bid_to_slug:
            bb = db.get(models.Building, j.building_id)
            bid_to_slug[j.building_id] = bb.slug if bb else None
        err = (j.error or "")[:200] or None
        out.append({
            "id": j.id,
            "building": bid_to_slug[j.building_id],
            "kind": j.kind,
            "status": j.status,
            "step": j.step,
            "error": err,
            "created_at": str(j.created_at) if j.created_at else None,
            "finished_at": str(j.finished_at) if j.finished_at else None,
        })
    return {"jobs": out, "count": len(out)}


def tool_get_job(db: Session, job_id: int) -> dict:
    j = db.get(models.Job, int(job_id))
    if not j:
        return {"error": f"unknown job: {job_id}", "status": 404}
    b = db.get(models.Building, j.building_id)
    log = j.log or ""
    tail = log[-2500:] if len(log) > 2500 else log
    return {
        "id": j.id,
        "building": b.slug if b else None,
        "kind": j.kind,
        "status": j.status,
        "step": j.step,
        "error": (j.error or None),
        "log_tail": tail,
        "log_len": len(log),
        "created_at": str(j.created_at) if j.created_at else None,
        "started_at": str(j.started_at) if j.started_at else None,
        "finished_at": str(j.finished_at) if j.finished_at else None,
    }


def tool_debug_logs(
    building: str | None = None,
    level: str | None = None,
    source: str | None = None,
    limit: int = 20,
) -> dict:
    limit = max(1, min(int(limit or 20), 40))
    data = dbg.query_logs(after_id=0, limit=limit, level=level, building=building, source=source)
    slim = []
    for e in data.get("logs") or []:
        slim.append({
            "id": e.get("id"),
            "ts": e.get("ts") or e.get("time"),
            "level": e.get("level"),
            "source": e.get("source"),
            "building": e.get("building"),
            "message": (e.get("message") or "")[:400],
        })
    return {
        "logs": slim,
        "count": len(slim),
        "last_id": data.get("last_id"),
        "debug_enabled": data.get("debug_enabled"),
        "note": "Read-only. Clear/export logs from the Dashboard UI, not chat.",
    }


def run_admin_tool(db: Session, name: str, args: dict) -> Any:
    if name not in _ADMIN_TOOLS:
        return {"error": f"tool not allowed: {name}"}
    args = args or {}
    try:
        if name in chat_svc._PUBLIC_TOOLS:
            return chat_svc.run_tool(db, name, args)
        if name == "list_admin_buildings":
            return tool_list_admin_buildings(db)
        if name == "get_building_access":
            return tool_get_building_access(db, args.get("slug") or "")
        if name == "explain_access":
            return tool_explain_access(args.get("topic"))
        if name == "route_access_preview":
            return tool_route_access_preview(
                db,
                args.get("slug") or "",
                args.get("from_key") or "",
                args.get("to_key") or "",
                bool(args.get("step_free")),
                args.get("excluded_edge_ids"),
            )
        if name == "list_jobs":
            return tool_list_jobs(db, args.get("building"), args.get("limit", 15))
        if name == "get_job":
            jid = args.get("job_id")
            if jid is None:
                return {"error": "job_id required"}
            return tool_get_job(db, int(jid))
        if name == "debug_logs":
            return tool_debug_logs(
                args.get("building"),
                args.get("level"),
                args.get("source"),
                args.get("limit", 20),
            )
        if name == "open_building":
            return tool_open_building(db, args.get("query") or args.get("slug") or "")
    except HTTPException as e:
        return {"error": e.detail, "status": e.status_code}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    return {"error": "unknown tool"}


def _humanize_admin_trace(tool_trace: list[dict], building: str | None = None) -> tuple[str, list[dict]]:
    """Prefer Access / ops summaries when those tools ran; else public humanize."""
    for tr in reversed(tool_trace or []):
        name = tr.get("name")
        res = tr.get("result")
        if not isinstance(res, dict):
            continue
        if res.get("error") and name in _ADMIN_ONLY:
            return f"I hit a lookup problem: {res.get('error')}", []
        if name == "explain_access":
            snips = res.get("snippets") or {}
            lines = [f"- {k}: {v}" for k, v in snips.items()]
            if lines:
                return "Access overview:\n" + "\n".join(lines), []
        if name == "get_building_access":
            acc = res.get("access") or {}
            routing = acc.get("routing") or {}
            lines = [
                f"Building {res.get('slug') or building}: twin={acc.get('twin')}, "
                f"tour_public={acc.get('tour_public')}, pin_set={acc.get('pin_set')}, "
                f"routing.mode={routing.get('mode')}, "
                f"excluded_edges={routing.get('excluded_edge_ids_count', 0)}.",
            ]
            note = res.get("note")
            if note:
                lines.append(note)
            return " ".join(lines), []
        if name == "route_access_preview":
            msg = res.get("message") or ""
            bits = [
                f"Route preview {res.get('from_name') or res.get('from_key')} → "
                f"{res.get('to_name') or res.get('to_key')}: "
                f"full_reachable={res.get('full_reachable')}, "
                f"filtered_reachable={res.get('filtered_reachable')}."
            ]
            if msg:
                bits.append(msg)
            return " ".join(bits), []
        if name == "list_admin_buildings":
            buildings = res.get("buildings") or []
            if not buildings:
                return "No buildings in Spatial Studio yet.", []
            lines = []
            for b in buildings[:12]:
                pubv = b.get("published_version")
                lines.append(
                    f"- {b.get('name') or b.get('slug')} ({b.get('slug')}) "
                    f"status={b.get('status')} published={pubv if pubv is not None else 'none'}"
                )
            return "Admin buildings:\n" + "\n".join(lines), []
        if name == "list_jobs":
            jobs = res.get("jobs") or []
            if not jobs:
                return "No recent jobs.", []
            lines = [
                f"- #{j.get('id')} {j.get('building')} {j.get('kind')} {j.get('status')}"
                + (f" step={j.get('step')}" if j.get("step") else "")
                for j in jobs[:12]
            ]
            return "Recent jobs:\n" + "\n".join(lines), []
        if name == "get_job":
            return (
                f"Job #{res.get('id')} ({res.get('building')}): status={res.get('status')}, "
                f"step={res.get('step')}, error={res.get('error') or 'none'}."
            ), []
        if name == "debug_logs":
            logs = res.get("logs") or []
            if not logs:
                return "No matching debug log rows in the buffer.", []
            lines = [
                f"- [{e.get('level')}] {e.get('source') or '?'} "
                f"{e.get('building') or ''} {e.get('message')}"
                for e in logs[:12]
            ]
            return "Recent debug logs:\n" + "\n".join(lines), []
    return chat_svc._humanize_from_tool_trace(tool_trace, building)


def _ensure_admin_human_reply(
    final_text: str,
    tool_trace: list[dict],
    building: str | None = None,
) -> tuple[str, list[dict]]:
    text = (final_text or "").strip()
    admin_names = {tr.get("name") for tr in (tool_trace or [])}
    used_admin = bool(admin_names & _ADMIN_ONLY)
    if text and not chat_svc._looks_like_tool_echo(text) and not used_admin:
        return chat_svc._ensure_human_reply(final_text, tool_trace, building)
    if text and not chat_svc._looks_like_tool_echo(text) and used_admin:
        # Strip accidental secret-looking tokens from prose
        if "twin_pin_hash" in text or "twin_pin_hash" in text.lower():
            human, acts = _humanize_admin_trace(tool_trace, building)
            if human:
                return human, acts
        return text, chat_svc._deep_links_from_search_trace(tool_trace, building)
    human, acts = _humanize_admin_trace(tool_trace, building)
    if human:
        return human, acts
    return chat_svc._ensure_human_reply(final_text, tool_trace, building)


def run_admin_chat(
    db: Session,
    messages: list[dict],
    building: str | None = None,
    locale: str | None = None,
    max_rounds: int = 4,
    tab: str | None = None,
    path: str | None = None,
    page: str | None = None,
    route: str | None = None,
) -> dict:
    """Admin-scoped chat turn. Same LLM config as public chat; larger tool allowlist."""
    if not chat_svc.chat_enabled():
        raise HTTPException(404, "chat disabled")
    if not chat_svc.llm_configured():
        return {
            "message": (
                "NavMe Spatial Assistant is enabled, but no LLM is configured. "
                "Set WF_CHAT_LLM_BASE_URL (and WF_CHAT_LLM_API_KEY if required) "
                "to an OpenAI-compatible endpoint, or point BASE_URL at local Ollama "
                "(e.g. http://127.0.0.1:11434/v1) with WF_CHAT_LLM_MODEL."
            ),
            "actions": [],
            "configured": False,
        }

    # Merge explicit fields with parsed admin hash route (path/route).
    parsed = parse_admin_route(route=route, path=path)
    building = (building or parsed.get("building") or None)
    tab = (tab or parsed.get("tab") or None)
    page = (page or parsed.get("page") or None)
    path = path or parsed.get("path") or None

    ctx_bits = _context_blurb(building, tab, path, page)
    if locale:
        ctx_bits.append(f"User locale hint: {locale}")
    sys = ADMIN_SYSTEM_PROMPT
    if ctx_bits:
        sys += "\nContext:\n- " + "\n- ".join(ctx_bits)

    user_text_early = chat_svc._last_user_text(messages)

    # Lock/restrict before open — "lock all entrances" must not invent set_access.
    forced_lock = _maybe_force_lock_restrict(db, building, user_text_early)
    if forced_lock:
        return {
            "message": forced_lock["message"],
            "actions": list(forced_lock.get("actions") or []),
            "configured": True,
            "tools_used": list(forced_lock.get("tools_used") or []),
        }

    forced_entrances = _maybe_force_list_entrances(db, building, user_text_early)
    if forced_entrances:
        return {
            "message": forced_entrances["message"],
            "actions": list(forced_entrances.get("actions") or []),
            "configured": True,
            "tools_used": list(forced_entrances.get("tools_used") or []),
        }

    # Deterministic "open gcu" / go-to building before LLM (qwen often skips tools / invents GCU).
    forced_open = _maybe_force_open_building(db, user_text_early)
    if forced_open:
        label = forced_open.get("name") or forced_open.get("slug")
        msg = (
            f"Opening {label} ({forced_open.get('slug')}) in Spatial Studio. "
            f"Studio: {forced_open.get('admin_url')}. "
            f"Access: {forced_open.get('access_url')}. "
            f"Public viewer: {forced_open.get('viewer_url')}."
        )
        return {
            "message": msg,
            "actions": list(forced_open.get("actions") or []),
            "configured": True,
            "tools_used": ["open_building"],
        }

    hist: list[dict] = [{"role": "system", "content": sys}]
    for m in messages[-12:]:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if content is None:
            continue
        hist.append({"role": role, "content": str(content)[:4000]})

    try:
        return _run_admin_chat_turn(db, hist, messages, building, max_rounds, tab=tab)
    except chat_svc.LLMUnavailable as e:
        return chat_svc.llm_error_response(e.detail, admin=True)


def _run_admin_chat_turn(
    db: Session,
    hist: list[dict],
    messages: list[dict],
    building: str | None,
    max_rounds: int,
    tab: str | None = None,
) -> dict:
    tool_trace: list[dict] = []
    final_text = ""
    for _ in range(max_rounds):
        data = chat_svc._openai_chat(hist, ADMIN_TOOL_DEFS)
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        tool_calls = msg.get("tool_calls") or []
        if tool_calls:
            hist.append({
                "role": "assistant",
                "content": msg.get("content") or "",
                "tool_calls": tool_calls,
            })
            for tc in tool_calls:
                fn = tc.get("function") or {}
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                except json.JSONDecodeError:
                    args = {}
                if name in ("search_pois", "get_poi", "route", "make_deep_link",
                            "get_building_access", "route_access_preview"):
                    resolved = chat_svc._resolve_building_slug(db, args.get("slug"), preferred=building)
                    # Admin get_building_access / route preview also work on unpublished  - 
                    # prefer context slug when resolve only finds published.
                    if resolved:
                        args["slug"] = resolved
                    elif building:
                        args["slug"] = building
                    elif not args.get("slug") and building:
                        args["slug"] = building
                    # For admin-only building tools, allow unpublished exact slug
                    if name in ("get_building_access", "route_access_preview") and building and not args.get("slug"):
                        args["slug"] = building
                result = run_admin_tool(db, name, args)
                # Hard strip secrets from tool payloads before they enter LLM history
                if isinstance(result, dict):
                    result.pop("twin_pin_hash", None)
                    result.pop("twin_pin", None)
                    if isinstance(result.get("access"), dict):
                        result["access"].pop("twin_pin_hash", None)
                        result["access"].pop("twin_pin", None)
                tool_trace.append({"name": name, "args": args, "result": result})
                hist.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id") or name,
                    "content": json.dumps(result, ensure_ascii=False)[:8000],
                })
            continue
        final_text = (msg.get("content") or "").strip()
        break

    # Access how-to force path when small models skip tools (always prefer on Access tab)
    user_text = chat_svc._last_user_text(messages)
    access_hint = (tab or "").lower() == "access"
    if user_text:
        low = user_text.lower()
        access_hint = access_hint or any(
            k in low for k in (
                "twin=pin", "twin = pin", "access", "exclude_edges", "excluded edge",
                "tour gate", "pin_required", "what does twin", "routing.mode",
            )
        )
    # Entrance / lock already short-circuited in run_admin_chat; still guard tool echo
    admin_ran = any(t.get("name") in _ADMIN_ONLY for t in tool_trace)
    if access_hint and not admin_ran:
        # Prefer explain_access; if a building is in context also attach get_building_access
        expl = tool_explain_access("all" if "twin" in (user_text or "").lower() or "pin" in (user_text or "").lower() else "all")
        if "twin" in (user_text or "").lower() or "pin" in (user_text or "").lower():
            expl = tool_explain_access("pin" if "pin" in (user_text or "").lower() else "twin")
        tool_trace.append({"name": "explain_access", "args": {"topic": "auto"}, "result": expl})
        if building:
            acc = tool_get_building_access(db, building)
            tool_trace.append({"name": "get_building_access", "args": {"slug": building}, "result": acc})
        # One more LLM turn with tool results injected
        hist.append({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_autofill_access",
                "type": "function",
                "function": {"name": "explain_access", "arguments": json.dumps({"topic": "all"})},
            }],
        })
        hist.append({
            "role": "tool",
            "tool_call_id": "call_autofill_access",
            "content": json.dumps(expl, ensure_ascii=False)[:8000],
        })
        if building:
            hist.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_autofill_access_cfg",
                    "type": "function",
                    "function": {"name": "get_building_access", "arguments": json.dumps({"slug": building})},
                }],
            })
            hist.append({
                "role": "tool",
                "tool_call_id": "call_autofill_access_cfg",
                "content": json.dumps(tool_trace[-1]["result"], ensure_ascii=False)[:8000],
            })
        try:
            data = chat_svc._openai_chat(hist, None)
            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            final_text = (msg.get("content") or "").strip() or final_text
        except Exception:
            pass

    final_text, extra_actions = _ensure_admin_human_reply(final_text, tool_trace, building)
    if not final_text:
        final_text = "I looked that up with NavMe Spatial Assistant tools, but have nothing further to add."

    # Final safety: never emit hash-looking secrets
    for bad in ("twin_pin_hash", "twin_pin"):
        if bad in final_text:
            human, extra_actions = _humanize_admin_trace(tool_trace, building)
            if human:
                final_text = human
            break

    open_acts: list[dict] = []
    for tr in tool_trace or []:
        if tr.get("name") != "open_building":
            continue
        res = tr.get("result") if isinstance(tr.get("result"), dict) else {}
        for a in (res.get("actions") or []):
            if isinstance(a, dict) and a.get("url"):
                open_acts.append(a)
        act = res.get("action")
        if isinstance(act, dict) and act.get("url"):
            open_acts.append(act)

    return {
        "message": final_text,
        "actions": chat_svc._merge_actions(
            chat_svc._merge_actions(chat_svc._collect_actions(tool_trace), extra_actions),
            open_acts,
        ),
        "configured": True,
        "tools_used": [t["name"] for t in tool_trace],
    }
