"""Public chat assistant: OpenAI-compatible tool-calling over published buildings/POIs/routes.

Prefer open-source patterns: plain httpx + JSON tool schemas (no LangChain). Same client
works against hosted APIs or local Ollama (`…/v1/chat/completions`).
"""
from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
import time
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from .. import models
from .publish import current_version
from . import navgraph

SYSTEM_PROMPT = """You are NavMe, a campus wayfinding assistant for published buildings only.
Rules:
- Only use names, ids, floors, and facts returned by tools. Never invent POIs, rooms, hours, or coordinates.
- Always answer in short human-readable prose or a bullet list. For place lookups, list each place by name, optional code, and floor (e.g. "Entrance 13, floor F1"). Do not include POI ids (poi_…), node ids, or raw catalogue keys in the user-facing text.
- NEVER paste raw tool JSON, code fences of tool payloads, POI id dumps, node ids, coordinate blobs, or {"results":[...]} to the user. Rewrite tool output into plain language.
- When routing, summarize length (m) and ETA in plain words. Never dump node paths.
- For place lookups, always call search_pois with a short query (bathroom, toilet, garage, kitchen, entrance, …). Synonyms are matched server-side. Omit category unless you need an exact catalogue filter (restroom, parking, stairs, elevator, entrance, …).
- When the user wants directions, call search_pois / route / make_deep_link as needed; mention that they can open directions. The UI may show an Open directions button from make_deep_link.
- If search_pois returns empty, say that specific place was not found. When the tool includes available_categories / fallback_results / empty_reason, use them — do NOT claim the whole building catalogue is empty if rooms or other categories exist.
- Refuse requests for admin secrets, debug logs, unpublished drafts, API keys, or destructive actions.
- Current building context (if any) is given below. Always pass that slug to tools unless the user clearly names a different published building.
"""

TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "list_buildings",
            "description": "List published buildings (slug, name, address, version).",
            "parameters": {
                "type": "object",
                "properties": {
                    "venue": {"type": "string", "description": "Optional venue slug filter."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_pois",
            "description": (
                "Fuzzy-search published POIs by name/code/category. "
                "Synonyms work (bathroom=restroom=toilet=wc; garage=parking; stairs=stairwell). "
                "Pass a short query word or phrase; omit category unless filtering to a catalogue category."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Building slug."},
                    "query": {"type": "string", "description": "Search text (e.g. bathroom, toilet, garage, kitchen)."},
                    "category": {
                        "type": "string",
                        "description": (
                            "Optional exact/aliased category filter. Catalogue values: "
                            "room, hall, corridor, entrance, stairs, elevator, restroom, parking, "
                            "outdoor, info, office, worship, kitchen, other. "
                            "Aliases: bathroom/toilet/wc→restroom, garage→parking."
                        ),
                    },
                    "limit": {"type": "integer", "description": "Max results (default 8)."},
                },
                "required": ["slug", "query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_poi",
            "description": "Get one published POI by id in a building.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "poi_id": {"type": "string"},
                },
                "required": ["slug", "poi_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route",
            "description": "Compute walking route between two published POI ids. Returns length_m, eta_s, floors.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "from_key": {"type": "string", "description": "Origin POI id."},
                    "to_key": {"type": "string", "description": "Destination POI id."},
                    "step_free": {"type": "boolean", "description": "Prefer elevators / no stairs."},
                },
                "required": ["slug", "from_key", "to_key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "make_deep_link",
            "description": "Build a viewer deep-link URL for a place or directions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "from_key": {"type": "string", "description": "Optional origin POI id or 'me'."},
                    "to_key": {"type": "string", "description": "Destination POI id."},
                    "step_free": {"type": "boolean"},
                },
                "required": ["slug", "to_key"],
            },
        },
    },
]

_PUBLIC_TOOLS = {t["function"]["name"] for t in TOOL_DEFS}

# Simple in-process rate limit (per client key). Fine for single-box demos.
_rl_lock = threading.Lock()
_rl_hits: dict[str, list[float]] = {}


def chat_enabled() -> bool:
    return bool(get_settings().wf_chat_enabled)


def llm_configured() -> bool:
    s = get_settings()
    # Hosted: need key. Local Ollama: base URL alone is enough (key optional).
    return bool((s.wf_chat_llm_base_url or "").strip() or (s.wf_chat_llm_api_key or "").strip())


def check_rate_limit(client_key: str) -> None:
    s = get_settings()
    limit = max(1, int(s.wf_chat_rate_limit_per_min or 20))
    now = time.time()
    with _rl_lock:
        hits = [t for t in _rl_hits.get(client_key, []) if now - t < 60.0]
        if len(hits) >= limit:
            raise HTTPException(429, "Chat rate limit exceeded — try again in a minute.")
        hits.append(now)
        _rl_hits[client_key] = hits


def _published_path(db: Session, slug: str) -> Path:
    b = db.query(models.Building).filter_by(slug=slug).first()
    if not b:
        raise HTTPException(404, f"unknown building: {slug}")
    mv = current_version(db, b)
    if not mv:
        raise HTTPException(404, f"building not published: {slug}")
    return Path(mv.path)


def _load_pois(db: Session, slug: str) -> list[dict]:
    root = _published_path(db, slug)
    data = json.loads((root / "pois.json").read_text())
    return list(data.get("pois") or [])


def _poi_brief(p: dict, *, include_node: bool = False) -> dict:
    out = {
        "id": p.get("id") or p.get("key"),
        "name": p.get("name"),
        "code": p.get("code"),
        "category": p.get("category"),
        "floor": p.get("floor"),
    }
    if include_node:
        out["nearest_node"] = p.get("nearest_node")
    return out


def tool_list_buildings(db: Session, venue: str | None = None) -> dict:
    out = []
    for b in db.query(models.Building).order_by(models.Building.name):
        mv = current_version(db, b)
        if not mv:
            continue
        vslug = b.venue.slug if b.venue else None
        if venue and vslug != venue and venue != "all":
            continue
        out.append({
            "slug": b.slug,
            "name": b.name,
            "address": b.address,
            "version": mv.version,
            "venue": vslug,
        })
    return {"buildings": out, "count": len(out)}


# Catalogue categories (mirrors admin CATEGORIES) plus colloquial → canonical aliases.
_CATALOGUE_CATEGORIES = {
    "room", "hall", "corridor", "entrance", "stairs", "elevator", "restroom",
    "parking", "outdoor", "info", "office", "worship", "kitchen", "other",
}

# Synonym groups: any term in a group matches POIs whose name/category/hay hits any member.
_SYNONYM_GROUPS: tuple[frozenset[str], ...] = (
    frozenset({"bathroom", "bathrooms", "restroom", "restrooms", "toilet", "toilets",
               "wc", "w.c", "lavatory", "lavatories", "washroom", "washrooms",
               "powder room", "ladies room", "mens room"}),
    frozenset({"garage", "garages", "parking", "car park", "carpark", "lot"}),
    frozenset({"stairs", "stair", "stairway", "stairwell", "staircase", "steps"}),
    frozenset({"elevator", "elevators", "lift", "lifts"}),
    frozenset({"hallway", "hallways", "corridor", "corridors", "hall", "halls"}),
    frozenset({"entrance", "entrances", "entry", "lobby", "front door", "main door"}),
    frozenset({"kitchen", "kitchens", "break room", "breakroom", "pantry"}),
    frozenset({"office", "offices", "workspace"}),
    frozenset({"bedroom", "bedrooms", "bed room"}),
    frozenset({"living room", "living", "lounge", "family room"}),
    frozenset({"laundry", "washer", "utility"}),
    frozenset({"closet", "closets", "cupboard", "storage"}),
)

_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "where", "where's", "wheres", "what", "what's", "whats", "which", "who",
    "how", "can", "could", "would", "should", "do", "does", "did", "find",
    "show", "me", "my", "our", "your", "please", "to", "from", "for", "of",
    "in", "on", "at", "near", "nearby", "closest", "nearest", "any", "some",
    "there", "here", "i", "im", "i'm", "need", "want", "looking", "look",
    "go", "get", "take", "directions", "route", "way", "to", "and", "or",
})

_CATEGORY_ALIASES = {
    "bathroom": "restroom", "bathrooms": "restroom", "toilet": "restroom",
    "toilets": "restroom", "wc": "restroom", "washroom": "restroom",
    "lavatory": "restroom", "loo": "restroom",
    "garage": "parking", "garages": "parking", "carpark": "parking", "lot": "parking",
    "stair": "stairs", "stairway": "stairs", "stairwell": "stairs", "staircase": "stairs", "steps": "stairs",
    "lift": "elevator", "lifts": "elevator", "elevators": "elevator",
    "hallway": "corridor", "hallways": "corridor", "corridors": "corridor",
    "entry": "entrance", "entrances": "entrance", "lobby": "entrance",
    "offices": "office", "kitchens": "kitchen",
}


def _normalize_token(tok: str) -> str:
    t = (tok or "").strip().lower()
    if not t:
        return ""
    # light plural fold (bathrooms→bathroom, restrooms→restroom; keep "stairs")
    if len(t) > 4 and t.endswith("ies"):
        t = t[:-3] + "y"
    elif len(t) > 3 and t.endswith("s") and not t.endswith(("ss", "us", "is", "stairs")):
        t = t[:-1]
    return t


def _synonym_members(term: str) -> set[str]:
    """Return the synonym group containing term (incl. term), else {normalized term}."""
    raw = (term or "").strip().lower()
    norm = _normalize_token(raw)
    out: set[str] = set()
    if raw:
        out.add(raw)
    if norm:
        out.add(norm)
    for group in _SYNONYM_GROUPS:
        if raw in group or norm in group or any(_normalize_token(g) == norm for g in group):
            out |= set(group)
            out |= {_normalize_token(g) for g in group if _normalize_token(g)}
            break
    out.discard("")
    return out


def _query_needles(query: str) -> list[str]:
    """Content tokens / phrases from a user or LLM query, expanded with synonyms."""
    q = (query or "").strip().lower()
    if not q:
        return []
    # Prefer whole-phrase synonym hits first (e.g. "powder room", "living room")
    needles: set[str] = set()
    for group in _SYNONYM_GROUPS:
        for phrase in group:
            if " " in phrase and phrase in q:
                needles |= _synonym_members(phrase)
    tokens = [t for t in re.split(r"\W+", q) if t and t not in _STOPWORDS]
    tokens = [_normalize_token(t) for t in tokens]
    tokens = [t for t in tokens if t and t not in _STOPWORDS]
    if not tokens and not needles:
        # fall back to raw non-stop tokens without aggressive fold
        tokens = [t for t in re.split(r"\W+", q) if t and t not in _STOPWORDS]
    for t in tokens:
        needles |= _synonym_members(t)
    # Keep original full query (normalized) as a needle for exact substring
    if q:
        needles.add(q)
        needles.add(_normalize_token(q) or q)
    # Prefer longer needles first for scoring
    return sorted({n for n in needles if n}, key=lambda s: (-len(s), s))


def _normalize_category(category: str | None) -> str | None:
    if not category:
        return None
    c = category.strip().lower()
    if not c:
        return None
    c = _CATEGORY_ALIASES.get(c, c)
    c = _CATEGORY_ALIASES.get(_normalize_token(c), c)
    return c


def _poi_hay(p: dict) -> str:
    cat = (p.get("category") or "").lower()
    bits = [str(p.get(k) or "") for k in ("name", "code", "category", "id", "key", "floor", "note", "description")]
    # Index synonym labels for the POI category so toilet matches restroom POIs
    if cat:
        bits.extend(sorted(_synonym_members(cat)))
    name = (p.get("name") or "").lower()
    if name:
        bits.extend(sorted(_synonym_members(name)))
    return " ".join(bits).lower()



def _contains_term(term: str, text: str) -> bool:
    """Substring for multi-word phrases; word-boundary for single tokens (avoids loo⊂floor)."""
    if not term or not text:
        return False
    if " " in term or "." in term:
        return term in text
    return re.search(rf"(?<![\w]){re.escape(term)}(?![\w])", text) is not None


def _score_poi(p: dict, needles: list[str], raw_q: str) -> int | None:
    """Return relevance score or None if no match."""
    name = (p.get("name") or "").lower()
    code = (p.get("code") or "").lower()
    cat = (p.get("category") or "").lower()
    hay = _poi_hay(p)
    if not needles:
        return 1

    best = 0
    for n in needles:
        if not n:
            continue
        if name == n or code == n:
            best = max(best, 100)
        elif (len(n) >= 3 and name.startswith(n)) or code == n:
            best = max(best, 95)
        elif _contains_term(n, name) or _contains_term(n, code):
            best = max(best, 85)
        elif n == cat or n in _synonym_members(cat):
            best = max(best, 75)
        elif _contains_term(n, hay):
            best = max(best, 55)

    if best:
        return best

    # Token AND: every content token (pre-synonym) must hit hay somehow
    content = [t for t in re.split(r"\W+", raw_q.lower()) if t and t not in _STOPWORDS]
    content = [_normalize_token(t) or t for t in content]
    content = [t for t in content if t and t not in _STOPWORDS]
    if content and all(any(_contains_term(x, hay) for x in _synonym_members(t)) for t in content):
        return 40

    # Light fuzzy fallback (stdlib difflib) on name/code — open-source, no extra dep
    for n in needles:
        if len(n) < 3:
            continue
        for target in (name, code, cat):
            if not target:
                continue
            if SequenceMatcher(None, n, target).ratio() >= 0.78:
                return 35
    return None


def _category_counts(pois: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for p in pois:
        c = (p.get("category") or "other").lower() or "other"
        counts[c] = counts.get(c, 0) + 1
    return counts


def _query_wants_restroom(query: str, cat_filter: str | None = None) -> bool:
    if cat_filter == "restroom":
        return True
    needles = set(_query_needles(query or ""))
    return bool(needles & _synonym_members("bathroom"))



def _resolve_building_slug(db: Session, slug: str | None, preferred: str | None = None) -> str | None:
    """Prefer viewer building context; accept exact published slug; light name/slug fuzzy match."""
    pref = (preferred or "").strip() or None
    raw = (slug or "").strip() or None

    def published(s: str | None) -> str | None:
        if not s:
            return None
        b = db.query(models.Building).filter_by(slug=s).first()
        if b and current_version(db, b):
            return b.slug
        return None

    # Viewer page context is authoritative when valid
    hit = published(pref)
    if hit:
        return hit

    hit = published(raw)
    if hit:
        return hit

    needle = (raw or pref or "").strip().lower()
    if not needle:
        return None
    best = None
    best_score = 0.0
    for b in db.query(models.Building).all():
        if not current_version(db, b):
            continue
        for c in (b.slug or "", b.name or ""):
            cl = c.lower()
            if not cl:
                continue
            if needle == cl or needle in cl or cl in needle:
                score = 0.95 if needle == cl else 0.85
            else:
                score = SequenceMatcher(None, needle, cl).ratio()
            if score > best_score:
                best_score = score
                best = b.slug
    if best and best_score >= 0.72:
        return best
    return pref or raw


def tool_search_pois(db: Session, slug: str, query: str, category: str | None = None, limit: int = 8) -> dict:
    limit = max(1, min(int(limit or 8), 20))
    raw_q = (query or "").strip()
    needles = _query_needles(raw_q)
    cat_filter = _normalize_category(category)
    pois = _load_pois(db, slug)
    scored: list[tuple[int, dict]] = []
    for p in pois:
        pcat = (p.get("category") or "").lower()
        if cat_filter:
            # Accept exact catalogue match or alias-normalized equality
            if pcat != cat_filter and _normalize_category(pcat) != cat_filter:
                # Also allow synonym-group membership (bathroom filter vs restroom POI)
                if cat_filter not in _synonym_members(pcat) and pcat not in _synonym_members(cat_filter):
                    continue
        score = _score_poi(p, needles, raw_q)
        if score is None:
            continue
        scored.append((score, _poi_brief(p)))
    scored.sort(key=lambda x: (-x[0], (x[1].get("name") or "").lower()))
    hits = [p for _, p in scored[:limit]]
    out: dict[str, Any] = {"slug": slug, "query": query, "results": hits, "count": len(hits)}
    if hits:
        return out
    # Empty: attach catalogue summary so the UI/LLM can steer the user.
    cats = _category_counts(pois)
    out["catalogue_size"] = len(pois)
    out["available_categories"] = cats
    # Soft fallback: bathroom/restroom asked but none tagged (e.g. GCU unlabeled rooms).
    if _query_wants_restroom(raw_q, cat_filter) and cats.get("restroom", 0) == 0:
        room_hits = [
            _poi_brief(p) for p in pois
            if (p.get("category") or "").lower() == "room"
        ]
        room_hits.sort(key=lambda h: (str(h.get("floor") or ""), str(h.get("name") or "").lower()))
        room_hits = room_hits[:limit]
        if room_hits:
            out["fallback_results"] = room_hits
            out["empty_reason"] = "no_restrooms_tagged"
    return out


def tool_get_poi(db: Session, slug: str, poi_id: str) -> dict:
    pois = _load_pois(db, slug)
    for p in pois:
        if p.get("id") == poi_id or p.get("key") == poi_id:
            return {"slug": slug, "poi": _poi_brief(p)}
    return {"slug": slug, "poi": None, "error": "poi not found"}


def tool_route(db: Session, slug: str, from_key: str, to_key: str, step_free: bool = False) -> dict:
    root = _published_path(db, slug)
    nav = json.loads((root / "nav_graph.json").read_text())
    pois = {p["id"]: p for p in json.loads((root / "pois.json").read_text())["pois"]}
    # also index by key if present
    for p in list(pois.values()):
        if p.get("key"):
            pois.setdefault(p["key"], p)
    if from_key not in pois or to_key not in pois:
        return {"ok": False, "error": "unknown POI id", "from_key": from_key, "to_key": to_key}
    a, z = pois[from_key], pois[to_key]
    if not a.get("nearest_node") or not z.get("nearest_node"):
        return {"ok": False, "error": "POI missing nearest_node"}
    res = navgraph.route(nav, a["nearest_node"], z["nearest_node"], bool(step_free))
    if not res:
        return {
            "ok": False,
            "error": "no route" + (" without steps" if step_free else ""),
            "from_key": from_key,
            "to_key": to_key,
            "step_free": bool(step_free),
        }
    return {
        "ok": True,
        "slug": slug,
        "from_key": from_key,
        "to_key": to_key,
        "from_name": a.get("name"),
        "to_name": z.get("name"),
        "step_free": bool(step_free),
        "length_m": res.get("length_m"),
        "eta_s": res.get("eta_s"),
        "floors": res.get("floors"),
        "stair_edges": res.get("stair_edges"),
        "elevator_edges": res.get("elevator_edges"),
        # intentionally omit full node path / geometry from model context
    }


def tool_make_deep_link(
    slug: str,
    to_key: str,
    from_key: str | None = None,
    step_free: bool = False,
    label: str | None = None,
) -> dict:
    params: dict[str, str] = {"b": slug, "to": to_key}
    if from_key:
        params["from"] = from_key
    if step_free:
        params["mode"] = "stepfree"
    url = "/?" + urlencode(params)
    intent = "directions" if from_key else "select"
    action: dict[str, Any] = {
        "type": "deep_link",
        "url": url,
        "poi_id": to_key,
        "intent": intent,
    }
    if label:
        action["label"] = label
    return {
        "url": url,
        "slug": slug,
        "from_key": from_key,
        "to_key": to_key,
        "step_free": bool(step_free),
        "label": label,
        "action": action,
    }


def _action_for_hit(
    slug: str,
    hit: dict,
    from_key: str | None = None,
    step_free: bool = False,
) -> dict | None:
    """Build a labeled deep_link action for a POI hit (select on map by default)."""
    if not slug or not isinstance(hit, dict):
        return None
    pid = hit.get("id") or hit.get("key")
    if not pid:
        return None
    label = _format_poi_line(hit)
    return tool_make_deep_link(
        str(slug), str(pid), from_key, step_free, label=label
    ).get("action")


def run_tool(db: Session, name: str, args: dict) -> Any:
    if name not in _PUBLIC_TOOLS:
        return {"error": f"tool not allowed: {name}"}
    args = args or {}
    try:
        if name == "list_buildings":
            return tool_list_buildings(db, args.get("venue"))
        if name == "search_pois":
            return tool_search_pois(
                db,
                args.get("slug") or "",
                args.get("query") or "",
                args.get("category"),
                args.get("limit", 8),
            )
        if name == "get_poi":
            return tool_get_poi(db, args.get("slug") or "", args.get("poi_id") or "")
        if name == "route":
            return tool_route(
                db,
                args.get("slug") or "",
                args.get("from_key") or "",
                args.get("to_key") or "",
                bool(args.get("step_free")),
            )
        if name == "make_deep_link":
            return tool_make_deep_link(
                args.get("slug") or "",
                args.get("to_key") or "",
                args.get("from_key"),
                bool(args.get("step_free")),
            )
    except HTTPException as e:
        return {"error": e.detail, "status": e.status_code}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    return {"error": "unknown tool"}



def _format_poi_line(h: dict) -> str:
    """One human-readable POI line: name (code), floor X."""
    name = (h.get("name") or h.get("id") or "Place").strip()
    code = (h.get("code") or "").strip()
    floor = h.get("floor")
    # Skip code when it duplicates the display name (common for auto Room F1-01)
    label = f"{name} ({code})" if code and code.casefold() != name.casefold() else name
    if floor not in (None, ""):
        return f"{label}, floor {floor}"
    return label


def _format_poi_hits(hits: list[dict], *, empty_msg: str | None = None) -> str:
    if not hits:
        return empty_msg or "I could not find that place in the published catalogue."
    lines = [f"- {_format_poi_line(h)}" for h in hits[:8]]
    if len(hits) == 1:
        return f"I found this place in the published catalogue:\n{lines[0]}"
    return "I found these places in the published catalogue:\n" + "\n".join(lines)


def _format_route_human(res: dict) -> str:
    if not res.get("ok"):
        err = res.get("error") or "no route"
        return f"I could not compute a walking route ({err})."
    frm = res.get("from_name") or res.get("from_key") or "start"
    to = res.get("to_name") or res.get("to_key") or "destination"
    length = res.get("length_m")
    eta = res.get("eta_s")
    bits = [f"Walking route from {frm} to {to}"]
    if length is not None:
        bits.append(f"about {length:g} m")
    if eta is not None:
        bits.append(f"~{int(round(float(eta) / 60.0)) or 1} min" if float(eta) >= 60 else f"~{int(round(float(eta)))} s")
    floors = res.get("floors")
    if floors:
        bits.append("floors " + ", ".join(str(f) for f in floors))
    return " — ".join(bits) + "."


def _format_buildings_human(res: dict) -> str:
    buildings = res.get("buildings") or []
    if not buildings:
        return "No published buildings are available right now."
    lines = []
    for b in buildings[:12]:
        name = b.get("name") or b.get("slug") or "Building"
        slug = b.get("slug")
        addr = b.get("address")
        line = f"- {name}" + (f" ({slug})" if slug and slug != name else "")
        if addr:
            line += f" — {addr}"
        lines.append(line)
    return "Published buildings:\n" + "\n".join(lines)


def _try_parse_json_blob(text: str) -> Any | None:
    """Parse a full-message or embedded JSON object/array; return None if not JSON-like."""
    t = (text or "").strip()
    if not t:
        return None
    # Strip common markdown fences
    fence = re.match(r"^```(?:json)?\s*([\s\S]*?)\s*```\s*$", t, re.I)
    if fence:
        t = fence.group(1).strip()
    if not (t.startswith("{") or t.startswith("[")):
        # Embedded object starting with tool-shaped keys
        m = re.search(r'(\{\s*"(?:results|poi|buildings|ok|url|slug|count)\b[\s\S]*)$', text or "")
        if not m:
            return None
        t = m.group(1)
        # Trim trailing prose after balanced braces
        depth = 0
        end = None
        for i, ch in enumerate(t):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        if end:
            t = t[:end]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return None


def _looks_like_tool_echo(text: str) -> bool:
    """True when assistant text is (or embeds) raw tool JSON the user should never see."""
    t = (text or "").strip()
    if not t:
        return False
    if re.search(r'\{\s*"results"\s*:', t):
        return True
    if re.search(r'"id"\s*:\s*"poi_', t) and ("{" in t):
        return True
    if re.search(r'\{\s*"poi"\s*:', t):
        return True
    if re.search(r'\{\s*"buildings"\s*:', t):
        return True
    payload = _try_parse_json_blob(t)
    if isinstance(payload, dict):
        if isinstance(payload.get("results"), list):
            return True
        if "poi" in payload and isinstance(payload.get("poi"), (dict, type(None))):
            return True
        if isinstance(payload.get("buildings"), list):
            return True
        if payload.get("ok") is True and "length_m" in payload:
            return True
        if payload.get("url") and (payload.get("to_key") or payload.get("action")):
            return True
        if payload.get("error") and ("status" in payload or "slug" in payload):
            return True
    return False


def _humanize_tool_payload(payload: dict, slug: str | None = None) -> tuple[str, list[dict]]:
    """Turn a tool-shaped dict into (message, deep_link actions)."""
    actions: list[dict] = []
    if isinstance(payload.get("results"), list):
        hits = payload["results"]
        bslug = slug or payload.get("slug")
        if hits:
            msg = _format_poi_hits(hits)
            for h in hits[:8]:
                act = _action_for_hit(str(bslug), h) if bslug else None
                if isinstance(act, dict):
                    actions.append(act)
            return msg, actions
        # Empty primary results — soft restroom→rooms fallback (GCU etc.)
        fb = payload.get("fallback_results") if isinstance(payload.get("fallback_results"), list) else []
        if fb and payload.get("empty_reason") == "no_restrooms_tagged":
            lines = [f"- {_format_poi_line(h)}" for h in fb[:8]]
            msg = (
                "This building's published catalogue has no restrooms tagged yet "
                "(room labels were not set in the scan). "
                "Here are rooms you can open on the map — tap one to fly there:\n"
                + "\n".join(lines)
            )
            for h in fb[:8]:
                act = _action_for_hit(str(bslug), h) if bslug else None
                if isinstance(act, dict):
                    actions.append(act)
            return msg, actions
        cats = payload.get("available_categories") if isinstance(payload.get("available_categories"), dict) else {}
        if cats:
            bits = [f"{n} {c}" for c, n in sorted(cats.items(), key=lambda kv: (-kv[1], kv[0])) if n]
            avail = ", ".join(bits[:6]) if bits else "none"
            return (
                f"I could not find that place in the published catalogue. "
                f"Available place types here: {avail}. Try a room name, entrance, or elevator."
            ), []
        return _format_poi_hits(hits), []
    if "poi" in payload:
        poi = payload.get("poi")
        if not poi:
            return "I could not find that place in the published catalogue.", []
        msg = f"I found this place in the published catalogue:\n- {_format_poi_line(poi)}"
        bslug = slug or payload.get("slug")
        act = _action_for_hit(str(bslug), poi) if bslug else None
        if isinstance(act, dict):
            actions.append(act)
        return msg, actions
    if isinstance(payload.get("buildings"), list):
        return _format_buildings_human(payload), []
    if "length_m" in payload or payload.get("ok") is False and ("from_key" in payload or "to_key" in payload):
        return _format_route_human(payload), []
    if payload.get("url") and (payload.get("to_key") or payload.get("action")):
        url = payload.get("url")
        act = payload.get("action") if isinstance(payload.get("action"), dict) else {"type": "deep_link", "url": url}
        act = _normalize_action(act) or act
        to_key = payload.get("to_key") or act.get("poi_id") or ""
        label = payload.get("label") or act.get("label")
        if label and not act.get("label"):
            act = dict(act)
            act["label"] = label
        # Prefer place name in prose; avoid dumping raw catalogue ids
        place_bit = f" ({label})" if label else ""
        intent = act.get("intent") or ("directions" if payload.get("from_key") else "select")
        if intent == "directions":
            hint = "Tap the chip below to open directions."
        else:
            hint = "Tap the chip below to show it on the map."
        return f"Here is a map link for that place{place_bit}. {hint}", [act]
    if payload.get("error"):
        return f"I hit a lookup problem: {payload.get('error')}", []
    return "", []


def _humanize_from_tool_trace(tool_trace: list[dict], building: str | None = None) -> tuple[str, list[dict]]:
    """Best grounded human reply + deep links from the last useful tool results."""
    actions: list[dict] = []
    message = ""
    for tr in reversed(tool_trace or []):
        name = tr.get("name")
        res = tr.get("result")
        if not isinstance(res, dict):
            continue
        slug = (tr.get("args") or {}).get("slug") or res.get("slug") or building
        if name == "search_pois":
            message, actions = _humanize_tool_payload(res, slug)
            break
        if name == "get_poi":
            message, actions = _humanize_tool_payload(res, slug)
            break
        if name == "route":
            message, _ = _humanize_tool_payload(res, slug)
            break
        if name == "list_buildings":
            message, _ = _humanize_tool_payload(res, slug)
            break
        if name == "make_deep_link":
            message, actions = _humanize_tool_payload(res, slug)
            break
    return message, actions


_POI_ID_PAREN = re.compile(r"\s*\(\s*id\s*:\s*poi_[\w.-]+\s*\)", re.I)
_POI_ID_BARE = re.compile(r"\bpoi_[a-z0-9_.-]+\b", re.I)


def _strip_poi_ids_from_prose(text: str) -> str:
    """Remove leaked catalogue ids from otherwise human replies."""
    t = _POI_ID_PAREN.sub("", text or "")
    t = _POI_ID_BARE.sub("", t)
    t = re.sub(r"\(\s*\)", "", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r" *\n", "\n", t)
    return t.strip()


def _prose_leaks_poi_ids(text: str) -> bool:
    return bool(_POI_ID_PAREN.search(text or "") or _POI_ID_BARE.search(text or ""))



def _search_trace_has_restroom_fallback(tool_trace: list[dict]) -> bool:
    for tr in reversed(tool_trace or []):
        if tr.get("name") != "search_pois":
            continue
        res = tr.get("result")
        if not isinstance(res, dict):
            continue
        if res.get("empty_reason") == "no_restrooms_tagged" and res.get("fallback_results"):
            return True
    return False


def _deep_links_from_search_trace(tool_trace: list[dict], building: str | None = None) -> list[dict]:
    """Labeled place-chip actions from the latest search_pois / get_poi hits."""
    actions: list[dict] = []
    for tr in reversed(tool_trace or []):
        name = tr.get("name")
        res = tr.get("result")
        if not isinstance(res, dict):
            continue
        slug = (tr.get("args") or {}).get("slug") or res.get("slug") or building
        if not slug:
            continue
        if name == "search_pois":
            primary = res.get("results") or []
            pool = primary if primary else (res.get("fallback_results") or [])
            for h in pool[:8]:
                act = _action_for_hit(str(slug), h or {})
                if isinstance(act, dict):
                    actions.append(act)
            if actions:
                return actions
        if name == "get_poi":
            poi = res.get("poi") or {}
            act = _action_for_hit(str(slug), poi)
            if isinstance(act, dict):
                return [act]
    return actions


def _ensure_human_reply(
    final_text: str,
    tool_trace: list[dict],
    building: str | None = None,
) -> tuple[str, list[dict]]:
    """If the model echoed tool JSON (or left us empty), replace with a human summary.

    Returns (message, extra_deep_link_actions). Always attaches optional deep links
    from search hits when the model skipped make_deep_link.
    """
    extra: list[dict] = []
    text = (final_text or "").strip()
    if text and not _looks_like_tool_echo(text):
        links = _deep_links_from_search_trace(tool_trace, building)
        # Prefer grounded fallback chips when restroom search was empty but rooms exist
        if _search_trace_has_restroom_fallback(tool_trace):
            human, extra = _humanize_from_tool_trace(tool_trace, building)
            if human:
                return human, extra or links
        if _prose_leaks_poi_ids(text):
            human, extra = _humanize_from_tool_trace(tool_trace, building)
            if human:
                return human, extra or links
            text = _strip_poi_ids_from_prose(text)
        return text, links

    # Prefer grounded tool_trace over parsing the echo
    human, extra = _humanize_from_tool_trace(tool_trace, building)
    if human:
        return human, extra or _deep_links_from_search_trace(tool_trace, building)

    payload = _try_parse_json_blob(text) if text else None
    if isinstance(payload, dict):
        human, extra = _humanize_tool_payload(payload, building)
        if human:
            return human, extra or _deep_links_from_search_trace(tool_trace, building)

    if text and _looks_like_tool_echo(text):
        # Last resort: refuse to show JSON
        return (
            "I found matching places on the map, but could not format the reply. "
            "Please try asking again (for example: bathroom, entrance)."
        ), _deep_links_from_search_trace(tool_trace, building)
    return text, _deep_links_from_search_trace(tool_trace, building)


def _normalize_action(act: dict) -> dict | None:
    """Keep deep_link url plus optional place-chip metadata (label / poi_id / intent)."""
    if not isinstance(act, dict) or act.get("type") != "deep_link":
        return None
    url = act.get("url")
    if not url:
        return None
    out: dict[str, Any] = {"type": "deep_link", "url": url}
    for k in ("poi_id", "label", "intent", "name", "floor"):
        v = act.get(k)
        if v not in (None, ""):
            out[k] = v
    return out


def _merge_actions(*groups: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for group in groups:
        for act in group or []:
            norm = _normalize_action(act)
            if not norm:
                continue
            u = norm["url"]
            if u in seen:
                # Prefer the copy that already has a human label
                if norm.get("label"):
                    for i, prev in enumerate(out):
                        if prev.get("url") == u and not prev.get("label"):
                            out[i] = norm
                            break
                continue
            seen.add(u)
            out.append(norm)
    return out


def _collect_actions(tool_results: list[dict]) -> list[dict]:
    actions = []
    seen = set()
    for tr in tool_results:
        payload = tr.get("result")
        if not isinstance(payload, dict):
            continue
        act = _normalize_action(payload.get("action") or {})
        if not act:
            continue
        u = act["url"]
        if u not in seen:
            seen.add(u)
            actions.append(act)
    return actions



_PLACE_HINT = re.compile(
    r"\b(where|find|locate|show|bathroom|bathrooms|restroom|restrooms|toilet|wc|garage|kitchen|"
    r"elevator|stairs|office|room|entrance|parking|laundry|bedroom|closet|lobby)\b",
    re.I,
)


def _last_user_text(messages: list[dict]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user" and m.get("content"):
            return str(m["content"])
    return ""


def _maybe_force_search(db: Session, building: str | None, user_text: str) -> dict | None:
    """If small LLMs skip tools on an obvious place query, run search_pois once."""
    if not building or not user_text or not _PLACE_HINT.search(user_text):
        return None
    # Use the raw user text — synonym/stopword logic will extract needles.
    return tool_search_pois(db, building, user_text, limit=8)


class LLMUnavailable(Exception):
    """LLM transport/provider failure — chat endpoints should return 200 + message, not 502."""

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


def llm_error_response(detail: str, *, admin: bool = False) -> dict:
    who = "NavMe Spatial Assistant" if admin else "Wayfinding chat"
    return {
        "message": (
            f"{who} could not reach the language model right now ({detail}). "
            "Check that Ollama is running (or WF_CHAT_LLM_BASE_URL) and try again."
        ),
        "actions": [],
        "configured": True,
        "tools_used": [],
        "error": "llm_unavailable",
    }


def _openai_chat(messages: list[dict], tools: list | None = None) -> dict:
    s = get_settings()
    base = (s.wf_chat_llm_base_url or "https://api.openai.com/v1").rstrip("/")
    model = (s.wf_chat_llm_model or "gpt-4o-mini").strip()
    key = (s.wf_chat_llm_api_key or "").strip()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    url = base + "/chat/completions"
    try:
        with httpx.Client(timeout=60.0) as client:
            r = client.post(url, headers=headers, json=body)
            if r.status_code >= 400:
                detail = r.text[:400]
                raise LLMUnavailable(f"LLM provider error ({r.status_code}): {detail}")
            return r.json()
    except LLMUnavailable:
        raise
    except httpx.TimeoutException:
        raise LLMUnavailable("LLM request timed out")
    except httpx.HTTPError as e:
        raise LLMUnavailable(f"LLM unreachable ({type(e).__name__})")
    except Exception as e:
        raise LLMUnavailable(f"{type(e).__name__}: {e}")


def run_chat(
    db: Session,
    messages: list[dict],
    building: str | None = None,
    locale: str | None = None,
    max_rounds: int = 4,
) -> dict:
    """Run a public-scoped chat turn with tool calling. Returns message + actions."""
    if not chat_enabled():
        raise HTTPException(404, "chat disabled")
    if not llm_configured():
        return {
            "message": (
                "Wayfinding chat is enabled, but no LLM is configured. "
                "Set WF_CHAT_LLM_BASE_URL (and WF_CHAT_LLM_API_KEY if required) "
                "to an OpenAI-compatible endpoint, or point BASE_URL at local Ollama "
                "(e.g. http://127.0.0.1:11434/v1) with WF_CHAT_LLM_MODEL."
            ),
            "actions": [],
            "configured": False,
        }

    ctx_bits = []
    if building:
        ctx_bits.append(f"Current building slug: {building}")
    if locale:
        ctx_bits.append(f"User locale hint: {locale}")
    sys = SYSTEM_PROMPT
    if ctx_bits:
        sys += "\nContext:\n- " + "\n- ".join(ctx_bits)

    # Keep only role/content(/tool_calls) from client; strip anything else.
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
        return _run_chat_turn(db, hist, messages, building, max_rounds)
    except LLMUnavailable as e:
        return llm_error_response(e.detail, admin=False)


def _run_chat_turn(
    db: Session,
    hist: list[dict],
    messages: list[dict],
    building: str | None,
    max_rounds: int,
) -> dict:
    tool_trace: list[dict] = []
    final_text = ""
    for _ in range(max_rounds):
        data = _openai_chat(hist, TOOL_DEFS)
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
                fn = (tc.get("function") or {})
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                except json.JSONDecodeError:
                    args = {}
                # Bind slug to viewer building context; repair invalid / omitted LLM slugs
                if name in ("search_pois", "get_poi", "route", "make_deep_link"):
                    resolved = _resolve_building_slug(db, args.get("slug"), preferred=building)
                    if resolved:
                        args["slug"] = resolved
                    elif building:
                        args["slug"] = building
                result = run_tool(db, name, args)
                tool_trace.append({"name": name, "args": args, "result": result})
                hist.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id") or name,
                    "content": json.dumps(result, ensure_ascii=False)[:8000],
                })
            continue
        final_text = (msg.get("content") or "").strip()
        break

    user_text = _last_user_text(messages)

    def _search_had_hits(trace: list[dict]) -> bool:
        for tr in trace or []:
            if tr.get("name") != "search_pois":
                continue
            res = tr.get("result") or {}
            if not isinstance(res, dict) or res.get("error"):
                continue
            if int(res.get("count") or 0) > 0:
                return True
            # Restroom soft-fallback counts as a grounded hit for chip/UI purposes
            if res.get("empty_reason") == "no_restrooms_tagged" and res.get("fallback_results"):
                return True
        return False

    if building and _PLACE_HINT.search(user_text or "") and not _search_had_hits(tool_trace):
        forced = _maybe_force_search(db, building, user_text)
        if forced is not None:
            tool_trace.append({"name": "search_pois", "args": {"slug": building, "query": user_text}, "result": forced})
            hist.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_autofill_search",
                    "type": "function",
                    "function": {"name": "search_pois", "arguments": json.dumps({"slug": building, "query": user_text})},
                }],
            })
            hist.append({
                "role": "tool",
                "tool_call_id": "call_autofill_search",
                "content": json.dumps(forced, ensure_ascii=False)[:8000],
            })
            data = _openai_chat(hist, None)  # no further tools; answer from results
            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            final_text = (msg.get("content") or "").strip() or final_text

    # Post-process: never ship raw tool JSON to the client (small LLMs often echo it).
    final_text, extra_actions = _ensure_human_reply(final_text, tool_trace, building)
    if not final_text:
        final_text = "I looked that up with the map tools, but have nothing further to add."

    return {
        "message": final_text,
        "actions": _merge_actions(_collect_actions(tool_trace), extra_actions),
        "configured": True,
        "tools_used": [t["name"] for t in tool_trace],
    }
