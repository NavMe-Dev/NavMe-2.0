"""NavMe Dashboard (Supabase) identifiers.

The wayfinding slug and the dashboard's POI type are two different strings and
must not be conflated:

* ``Building.slug`` is a URL id — it lives in paths (``/api/v1/.../buildings/{slug}``),
  in filenames (``<slug>_navmesh.navmesh``) and in the viewer query (``?b=<slug>``),
  so it is forced to ``[a-z0-9-]`` by the onboarding wizard and by
  ``schemas.BuildingIn``.
* ``navme_pois.poi_type`` in the NavMe Dashboard is free text typed by whoever set
  the client up — "Sparkhouse", "POI Navme", "Tacoma Mall - L1". Spaces, capitals
  and punctuation are all normal there, and Supabase matches it byte-for-byte.

Slugifying the dashboard value (``"POI Navme"`` -> ``"poi-navme"``) makes every
Supabase lookup silently return zero rows, which is what onboarding a new client
trips over. So onboarding stores the dashboard string verbatim in
``pipeline_config["navme_poi_type"]`` and everything that talks to Supabase reads
it through :func:`poi_type` below instead of using the slug.
"""
from __future__ import annotations

import re


def poi_type(b) -> str:
    """The exact ``navme_pois.poi_type`` string for this building.

    Falls back to the slug for buildings onboarded before the field existed (where
    the two happened to be identical, which is why it worked at all)."""
    v = (getattr(b, "pipeline_config", None) or {}).get("navme_poi_type")
    v = v.strip() if isinstance(v, str) else ""
    return v or b.slug


def set_poi_type(pc: dict | None, value: str | None) -> dict:
    """Merge a verbatim poi_type into a pipeline_config dict (empty clears it)."""
    pc = dict(pc or {})
    v = (value or "").strip()
    if v:
        pc["navme_poi_type"] = v
    else:
        pc.pop("navme_poi_type", None)
    return pc


# PostgREST treats , ( ) . and " as syntax inside a filter value; a double-quoted
# value turns all of them back into literal characters. Spaces need no quoting
# (urlencode percent-encodes them) but quoting them too costs nothing and keeps
# "POI Navme" readable in the request log.
_NEEDS_QUOTE = re.compile(r'[,.:()"\s]')


def pg_value(v: str) -> str:
    """Quote a value for a PostgREST filter (``eq.<v>`` / ``ilike.<v>``)."""
    if _NEEDS_QUOTE.search(v or ""):
        return '"' + (v or "").replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v or ""


def media_candidates(b) -> list[str]:
    """poi_type values to try when looking a building's navme_media row up, best first.

    The exact dashboard string wins. The slug-derived guesses that were here before
    this field existed stay on as a fallback so already-onboarded buildings that
    never set navme_poi_type keep resolving exactly as they used to."""
    pt = poi_type(b)
    out: list[str] = []
    for c in (pt, pt.upper(), b.slug, b.slug.upper(), b.slug.split("-")[0], b.slug.split("-")[0].upper()):
        if c and c not in out:
            out.append(c)
    return out
