"""Read canonical dashboard POIs, not the duplicate-prone Google-map mirror."""
from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request

from fastapi import HTTPException
from geoalchemy2.elements import WKTElement

from .. import models
from . import navgraph, navme


def fetch_rows(cfg, table: str, filters: dict, *, page_size: int = 250, order: str = "id.asc") -> list[dict]:
    """Page in a stable order, including when PostgREST caps pages below our limit."""
    rows, offset = [], 0
    while True:
        query = urllib.parse.urlencode({**filters, "order": order, "limit": page_size, "offset": offset})
        req = urllib.request.Request(f"{cfg.supabase_url}/rest/v1/{table}?{query}", headers={
            "apikey": cfg.supabase_anon_key,
            "Authorization": f"Bearer {cfg.supabase_anon_key}",
            "Prefer": "count=exact",
        })
        with urllib.request.urlopen(req, timeout=30) as response:
            page = json.loads(response.read())
            content_range = response.headers.get("Content-Range", "")
        if not isinstance(page, list):
            raise ValueError("Unexpected dashboard response")
        total = content_range.rsplit("/", 1)[-1]
        total = int(total) if total.isdigit() else None
        if not page:
            if total is not None and offset < total:
                raise ValueError("Incomplete dashboard response")
            break
        rows.extend(page)
        offset += len(page)
        if total is not None and offset >= total:
            break
        # Without an exact count, request until empty: a short page can be a
        # server-side row cap, so it must not be mistaken for end-of-results.
    return rows


def sync_pois(db, b, cfg) -> dict:
    """Upsert one viewer-visible record per active dashboard source ID.

    All source requests finish before any local writes. Repeat syncs update the
    same stable keys; zero coordinates and optional expected positions survive.
    The caller owns commit/rollback and any navmesh/publish operations.
    """
    ptype = navme.poi_type(b)
    filters = {"poi_type": "eq." + navme.pg_value(ptype)}
    try:
        rows = fetch_rows(cfg, "navme_pois", {**filters, "is_active": "is.true", "select":
            "id,poi_name,pos_x,pos_y,pos_z,floor_id,category_type,expected_pos_x,expected_pos_y,expected_pos_z"})
        categories = fetch_rows(cfg, "navme_categories", {**filters, "select": "id,name,icon_key,sort_order"})
        floors = fetch_rows(cfg, "navme_floors", {**filters, "select": "id,name"})
    except Exception as exc:
        raise HTTPException(502, "Could not read the complete dashboard POI list. Please try syncing again.") from exc
    floor_names = {str(r["id"]): r.get("name") for r in floors}
    cat_names = {str(r["id"]): r.get("name") for r in categories}
    categories.sort(key=lambda r: (r.get("sort_order") or 0, r.get("name") or ""))
    existing = db.query(models.POI).filter_by(building_id=b.id).all()
    by_key = {p.key: p for p in existing}
    by_source = {str((p.extra or {}).get("gmap_src_id")): p for p in existing if (p.extra or {}).get("gmap_src_id")}
    transform = navgraph.GeoT(b.georef) if b.georef else None
    created = updated = 0
    errors, seen = [], set()
    for row in rows:
        sid = str(row.get("id") or "")
        name = str(row.get("poi_name") or "").strip()
        if sid in seen:
            continue
        seen.add(sid)
        try:
            xyz = tuple(float(row[k]) for k in ("pos_x", "pos_y", "pos_z"))
            if not sid or not name or not all(math.isfinite(v) for v in xyz):
                raise ValueError()
        except (TypeError, ValueError, KeyError):
            errors.append({"src_id": sid, "reason": "Missing name or valid position"})
            continue
        key = "gmap_" + re.sub(r"[^a-z0-9]+", "_", sid.lower())[:70]
        poi = by_key.get(key) or by_source.get(sid) or by_key.get("sb_" + sid)
        if poi is None:
            poi = models.POI(building_id=b.id, key=key, locked=False)
            db.add(poi)
            by_key[key] = poi
            created += 1
        else:
            updated += 1
        poi.name = name
        poi.source = "supabase"  # The public dashboard POI endpoint reads this source.
        poi.category = str(cat_names.get(str(row.get("category_type"))) or "General").strip().lower()
        poi.floor = str(floor_names.get(str(row.get("floor_id"))) or "F1")
        # Preserve the existing mirror contract: these fields hold SDK (Y-up)
        # coordinates, converted by the viewer when building its routing POIs.
        poi.model_x, poi.model_y, poi.model_z = xyz
        if transform:
            lon, lat = transform.ll(xyz[0], xyz[1])
            poi.geom = WKTElement(f"POINT({lon} {lat})", srid=4326)
        poi.extra = {**(poi.extra or {}), "gmap_poi_type": ptype, "gmap_src_id": sid,
                     "gmap_metadata": {"src_id": sid},
                     **{key: row.get(key) for key in ("expected_pos_x", "expected_pos_y", "expected_pos_z")}}
    b.pipeline_config = {**(b.pipeline_config or {}), "navme_categories": categories}
    return {"created": created, "updated": updated, "synced": created + updated,
            "source_total": len(seen), "skipped": len(errors), "errors": errors,
            "categories": categories, "poi_type": ptype}
