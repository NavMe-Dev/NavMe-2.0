"""Read public Studio edits for the UUIDs already admitted by a publication.

This adapter never writes either database. Source configuration is opt-in per
building; a failed read keeps the published snapshot and never widens its IDs.
"""
from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import copy, deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import logging
import math
import threading
import time
from urllib.parse import urlsplit
from uuid import UUID

from . import navme, navme_sync, poi_viewpoints, camera_viewpoints


logger = logging.getLogger(__name__)
TTL_SECONDS = 5
SOURCE_TIMEOUT_SECONDS = 4
CALIBRATION_TOLERANCE_METERS = 0.001
MAX_CACHE_KEYS = 64

# These are actual columns in the Studio project. In particular, the description
# map is `descriptions`; Studio has no `hours` or `photo_url` POI columns.
POI_COLUMNS = (
    "id,poi_type,poi_name,poi_names,description,descriptions,amenities_desc,"
    "highlight_desc,technology_desc,icon_url,pos_x,pos_y,pos_z,expected_pos_x,"
    "expected_pos_y,expected_pos_z,expected_normal_x,expected_normal_y,"
    "expected_normal_z,category_type,category_types,floor_id,is_active,translate_name"
)
CATEGORY_COLUMNS = "id,poi_type,name,category_names,icon_key,sort_order"
FLOOR_COLUMNS = "id,poi_type,name"
TEXT_FIELDS = (
    "name", "description", "amenities_desc", "highlight_desc", "technology_desc",
    "category", "category_id", "floor", "floor_id", "hours", "code",
)
LANGUAGES = {"en", "enus", "es", "fr", "de", "it", "pt", "ar", "hi", "kn", "ta", "ml", "te", "bn", "zh", "ja"}


@dataclass
class _Slot:
    lock: threading.Lock = field(default_factory=threading.Lock)
    expires: float = 0
    result: dict | None = None


_slots: OrderedDict = OrderedDict()
_guard = threading.Lock()


def enabled(cfg, building) -> bool:
    allowed = {slug.strip() for slug in str(getattr(cfg, "studio_live_buildings", "") or "").split(",") if slug.strip()}
    return bool(getattr(building, "slug", "") in allowed
                and str(getattr(cfg, "studio_supabase_url", "") or "").strip()
                and str(getattr(cfg, "studio_supabase_anon_key", "") or "").strip())


def metadata_settings(cfg, building):
    """Use the Studio read key only for an explicitly configured building."""
    if not enabled(cfg, building):
        return cfg
    updates = {"supabase_url": str(cfg.studio_supabase_url).strip().rstrip("/"),
               "supabase_anon_key": str(cfg.studio_supabase_anon_key).strip()}
    if hasattr(cfg, "model_copy"):
        return cfg.model_copy(update=updates)
    result = copy(cfg)
    for name, value in updates.items():
        setattr(result, name, value)
    return result


def _uuid(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        return None


def _text(value):
    return value if isinstance(value, str) else None


def _translations(value, english=None):
    if not isinstance(value, dict):
        result = {}
    else:
        result = {key: text for key, text in value.items()
                  if isinstance(key, str) and key.lower().replace("_", "-").split("-", 1)[0] in LANGUAGES
                  and isinstance(text, str)}
    if english is not None:
        # Older Studio builds may update the main text before regenerating maps.
        result["en"] = english
    return result or None


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _vector(values):
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        return None
    values = [_number(value) for value in values]
    return values if all(value is not None for value in values) else None


def _row_vector(row, prefix):
    return _vector([row.get(prefix + axis) for axis in ("x", "y", "z")])


def _image_url(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme in {"https", "http"} and parsed.hostname and not (parsed.username or parsed.password):
            return value
    except ValueError:
        pass
    return None


def _public_poi(row):
    """An explicit projection also protects upstream-failure responses."""
    result = {"id": str(row["id"])} if row.get("id") is not None else {}
    for name in TEXT_FIELDS:
        if name in row:
            result[name] = _text(row[name])
    for name in ("names", "descriptions"):
        if name in row:
            result[name] = _translations(row[name])
    for name in ("icon_url", "photo_url"):
        if name in row:
            result[name] = _image_url(row[name])
    if isinstance(row.get("photo_urls"), list):
        result["photo_urls"] = [url for value in row["photo_urls"] if (url := _image_url(value))]
    if isinstance(row.get("category_ids"), list):
        result["category_ids"] = [value for value in row["category_ids"] if isinstance(value, str)]
    if isinstance(row.get("translate_name"), bool):
        result["translate_name"] = row["translate_name"]
    for prefix in ("", "expected_pos_", "expected_normal_"):
        values = _row_vector(row, prefix)
        if values is not None:
            result.update({prefix + axis: value for axis, value in zip(("x", "y", "z"), values)})
    _apply_viewpoint(result, row)
    view = row.get("camera_viewpoint")
    camera = camera_viewpoints.sanitize_viewpoint(view, view.get("model_id") if isinstance(view, dict) else None)
    if camera:
        result["camera_viewpoint"] = camera
    return result


def _apply_viewpoint(result, original):
    target = poi_viewpoints.get_target({"directions_viewpoint": original.get("_directions_viewpoint")})
    if target:
        result.update({"expected_pos_" + axis: target[axis] for axis in ("x", "y", "z")})


def _category(row):
    result = {key: value for key in ("id", "name", "icon_key")
              if isinstance((value := row.get(key)), str)}
    result["sort_order"] = _number(row.get("sort_order")) or 0
    names = _translations(row.get("category_names", row.get("names")), result.get("name"))
    if names:
        result.update(names=names, category_names=deepcopy(names))
    return result


def _saved_stairs(rows):
    result = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        public = {key: row[key] for key in ("id", "name", "from_floor_id", "to_floor_id") if isinstance(row.get(key), str)}
        for key in ("from_y", "to_y", "sort_order"):
            if (value := _number(row.get(key))) is not None:
                public[key] = value
        if isinstance(row.get("is_active"), bool):
            public["is_active"] = row["is_active"]
        if isinstance(row.get("sweep_numbers"), list):
            public["sweep_numbers"] = [value for value in row["sweep_numbers"] if isinstance(value, (str, int, float)) and not isinstance(value, bool)]
        result.append(public)
    return result


def _fallback(building, published):
    config = getattr(building, "pipeline_config", None) or {}
    categories = config.get("navme_categories", [])
    return {"pois": [_public_poi(row) for row in published],
            "categories": [_category(row) for row in categories if isinstance(row, dict)] if isinstance(categories, list) else [],
            "stair_chains": _saved_stairs(config.get("navme_stair_chains", []))}


def _slot(key):
    with _guard:
        slot = _slots.setdefault(key, _Slot())
        _slots.move_to_end(key)
        for old_key in list(_slots):
            if len(_slots) <= MAX_CACHE_KEYS:
                break
            if old_key != key and not _slots[old_key].lock.locked():
                del _slots[old_key]
        return slot


def _fetch(cfg, building, identifiers):
    ptype = navme.poi_type(building)
    filters = {"poi_type": "eq." + navme.pg_value(ptype)}
    jobs = {
        "pois": ("navme_pois", {**filters, "select": POI_COLUMNS, "is_active": "is.true",
                                 "id": "in.(" + ",".join(sorted(identifiers)) + ")"}),
        "categories": ("navme_categories", {**filters, "select": CATEGORY_COLUMNS}),
        "floors": ("navme_floors", {**filters, "select": FLOOR_COLUMNS}),
    }
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {name: pool.submit(navme_sync.fetch_rows, cfg, table, query, timeout=SOURCE_TIMEOUT_SECONDS)
                   for name, (table, query) in jobs.items()}
        rows = {name: future.result() for name, future in futures.items()}
    for values in rows.values():
        if not isinstance(values, list) or any(not isinstance(row, dict) for row in values):
            raise ValueError("Invalid Studio rows")
        if any(row.get("poi_type", ptype) != ptype for row in values):
            raise ValueError("Unexpected Studio tenant")
    return rows


def _calibrated(source, published, calibration, name):
    baseline = _vector(calibration.get(name)) if isinstance(calibration, dict) else None
    if source is not None and baseline is not None and published is not None:
        if math.dist(source, baseline) <= CALIBRATION_TOLERANCE_METERS:
            return published
    return source


def _overlay(building, published, rows, fallback):
    categories = [_category(row) for row in rows["categories"]]
    category_by_id = {str(row.get("id")): row for row in categories}
    floor_by_id = {str(row.get("id")): _text(row.get("name")) for row in rows["floors"]}
    by_id = {}
    for row in rows["pois"]:
        identifier = _uuid(row.get("id"))
        if identifier in by_id:
            raise ValueError("Duplicate Studio POI")
        if identifier:
            by_id[identifier] = row
    pois = []
    for original in published:
        identifier = _uuid(original.get("id"))
        if identifier is None or original.get("_studio_source") is False:
            # Registered local rooms remain independent of Studio, even when a
            # local key happens to be UUID-shaped. Legacy keys are independent too.
            pois.append(_public_poi(original))
            continue
        source = by_id.get(identifier)
        if not source or source.get("is_active") is not True:
            continue
        name = _text(source.get("poi_name"))
        position = _row_vector(source, "pos_")
        if not name or not name.strip() or position is None:
            continue
        result = _public_poi(original)
        result.update(name=name.strip(), names=_translations(source.get("poi_names"), name.strip()))
        for key in ("description", "amenities_desc", "highlight_desc", "technology_desc"):
            result[key] = _text(source.get(key))
        result["descriptions"] = _translations(source.get("descriptions"), result.get("description") or "")
        result["icon_url"] = _image_url(source.get("icon_url"))
        if isinstance(source.get("translate_name"), bool):
            result["translate_name"] = source["translate_name"]
        category_id = str(source["category_type"]) if source.get("category_type") else None
        category = category_by_id.get(category_id, {})
        result.update(category=str(category.get("name") or "General").strip().lower(), category_id=category_id)
        category_ids = source.get("category_types")
        category_ids = category_ids if isinstance(category_ids, list) else []
        result["category_ids"] = list(dict.fromkeys(value for value in [category_id, *category_ids]
                                                   if isinstance(value, str) and value in category_by_id))
        floor_id = str(source["floor_id"]) if source.get("floor_id") else None
        result.update(floor=floor_by_id.get(floor_id) or "F1", floor_id=floor_id)
        calibration = original.get("_studio_calibration")
        position = _calibrated(position, _row_vector(original, ""), calibration, "source_position")
        result.update(dict(zip(("x", "y", "z"), position)))
        expected = _calibrated(_row_vector(source, "expected_pos_"), _row_vector(original, "expected_pos_"),
                               calibration, "source_expected_position")
        for prefix, values in (("expected_pos_", expected), ("expected_normal_", _row_vector(source, "expected_normal_"))):
            for axis in ("x", "y", "z"):
                result.pop(prefix + axis, None)
            if values is not None:
                result.update({prefix + axis: value for axis, value in zip(("x", "y", "z"), values)})
        _apply_viewpoint(result, original)
        pois.append(result)
    pois.sort(key=lambda poi: poi.get("name", "").casefold())
    categories.sort(key=lambda category: (category["sort_order"], category.get("name", "")))
    return {"pois": pois, "categories": categories, "stair_chains": fallback["stair_chains"]}


def load(cfg, building, published_pois) -> dict:
    """Return a public snapshot; source rows can never add publication members."""
    published = [row for row in published_pois if isinstance(row, dict)]
    fallback = _fallback(building, published)
    identifiers = {_uuid(row.get("id")) for row in published
                   if row.get("_studio_source") is not False} - {None}
    if not enabled(cfg, building) or not identifiers:
        return fallback
    source = metadata_settings(cfg, building)
    identity = json.dumps({"published": published, "fallback": fallback}, sort_keys=True, default=str, separators=(",", ":"))
    key = (source.supabase_url, hashlib.sha256(source.supabase_anon_key.encode()).hexdigest(),
           building.slug, navme.poi_type(building), hashlib.sha256(identity.encode()).hexdigest())
    slot = _slot(key)
    with slot.lock:
        if slot.result is not None and slot.expires > time.monotonic():
            return deepcopy(slot.result)
        try:
            result = _overlay(building, published, _fetch(source, building, identifiers), fallback)
        except Exception as exc:
            logger.warning("Studio public read unavailable: %s", type(exc).__name__)
            result = fallback
        slot.result = result
        slot.expires = time.monotonic() + TTL_SECONDS
        return deepcopy(result)
