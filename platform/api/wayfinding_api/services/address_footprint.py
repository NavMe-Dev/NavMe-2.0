"""Geocode a street address and fetch nearby OSM building footprints for scan-plan scale hints.

Uses Nominatim first (OSS), falls back to Esri World Geocoding. Building polygons come from
the Overpass API (several public mirrors). Dimensions are metres in a local equirectangular
projection via Shapely's minimum rotated rectangle.
"""
from __future__ import annotations

import json
import math
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from shapely.geometry import Polygon
from shapely.validation import make_valid

USER_AGENT = "MetaDigiLabs wayfinding scan-plan/0.1 (self-hosted; contact: wayfinding-dev)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
ESRI_URL = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates"
OVERPASS_MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
GEOCODE_TIMEOUT_S = 15
OVERPASS_TIMEOUT_S = 25
DEFAULT_RADIUS_M = 150
MAX_CANDIDATES = 8


class AddressLookupError(Exception):
    """User-facing failure (geocode miss, Overpass down, no buildings)."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _http_json(url: str, *, data: bytes | None = None, timeout: float) -> Any:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def geocode_address(address: str, provider: str = "nominatim") -> dict:
    """Return {lat, lon, display_name, provider}. Tries preferred provider then the other."""
    address = (address or "").strip()
    if not address:
        raise AddressLookupError("address is required")
    order = ["nominatim", "esri"] if provider == "nominatim" else ["esri", "nominatim"]
    # Always try the requested first; fall back to the other on empty/error
    errors: list[str] = []
    for p in order:
        try:
            if p == "nominatim":
                r = _geocode_nominatim(address)
            else:
                r = _geocode_esri(address)
            if r:
                return r
            errors.append(f"{p}: no results")
        except Exception as e:
            errors.append(f"{p}: {e.__class__.__name__}")
    raise AddressLookupError(
        "geocode failed — " + "; ".join(errors) or "address not found",
        status_code=404,
    )


def _geocode_nominatim(address: str) -> dict | None:
    qs = urllib.parse.urlencode({"q": address, "format": "json", "limit": 1})
    d = _http_json(f"{NOMINATIM_URL}?{qs}", timeout=GEOCODE_TIMEOUT_S)
    if not d:
        return None
    hit = d[0]
    return {
        "lat": float(hit["lat"]),
        "lon": float(hit["lon"]),
        "display_name": hit.get("display_name") or address,
        "provider": "nominatim",
    }


def _geocode_esri(address: str) -> dict | None:
    qs = urllib.parse.urlencode({"SingleLine": address, "f": "json", "maxLocations": 1})
    d = _http_json(f"{ESRI_URL}?{qs}", timeout=GEOCODE_TIMEOUT_S)
    cands = d.get("candidates") or []
    if not cands:
        return None
    c = cands[0]
    return {
        "lat": float(c["location"]["y"]),
        "lon": float(c["location"]["x"]),
        "display_name": c.get("address") or address,
        "provider": "esri",
    }


def fetch_building_elements(lat: float, lon: float, radius_m: float = DEFAULT_RADIUS_M) -> list[dict]:
    """Query Overpass for building ways/relations near the point. Raises on total failure."""
    import time
    radius_m = max(30.0, min(500.0, float(radius_m)))
    # Lean query: around: only (bbox duplicates inflate result + latency). Ways first is enough
    # for Microsoft BuildingFootprints-style OSM data; relations included for multipolygons.
    q = (
        f"[out:json][timeout:20];"
        f"("
        f'way["building"](around:{int(radius_m)},{lat:.6f},{lon:.6f});'
        f'relation["building"](around:{int(radius_m)},{lat:.6f},{lon:.6f});'
        f");"
        f"out tags geom;"
    )
    body = urllib.parse.urlencode({"data": q}).encode()
    last: Exception | None = None
    # Two passes: first attempt each mirror quickly, then one slower retry on the first three
    attempts = list(OVERPASS_MIRRORS) + list(OVERPASS_MIRRORS[:3])
    for i, mirror in enumerate(attempts):
        timeout = OVERPASS_TIMEOUT_S if i < len(OVERPASS_MIRRORS) else OVERPASS_TIMEOUT_S + 15
        try:
            d = _http_json(mirror, data=body, timeout=timeout)
            return d.get("elements") or []
        except Exception as e:
            last = e
            time.sleep(0.4)
            continue
    raise AddressLookupError(
        f"Overpass unavailable (tried {len(OVERPASS_MIRRORS)} mirrors): "
        f"{last.__class__.__name__ if last else 'unknown'}. Set scale manually or retry later.",
        status_code=502,
    )


def _ring_from_element(el: dict) -> list[tuple[float, float]] | None:
    """Return closed (lon, lat) ring, or None if unusable."""
    geom = el.get("geometry")
    if geom and len(geom) >= 3:
        ring = [(float(p["lon"]), float(p["lat"])) for p in geom]
    else:
        # relation: stitch outer member ways if present
        members = el.get("members") or []
        ring = []
        for m in members:
            if m.get("role") not in ("outer", "", None):
                continue
            g = m.get("geometry") or []
            if len(g) < 2:
                continue
            pts = [(float(p["lon"]), float(p["lat"])) for p in g]
            if not ring:
                ring = pts
            else:
                # append if contiguous
                if ring[-1] == pts[0]:
                    ring.extend(pts[1:])
                elif ring[-1] == pts[-1]:
                    ring.extend(reversed(pts[:-1]))
                else:
                    ring.extend(pts)
        if len(ring) < 3:
            return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def _local_xy(lon: float, lat: float, lon0: float, lat0: float) -> tuple[float, float]:
    m_lat = 111320.0
    m_lon = 111320.0 * math.cos(math.radians(lat0))
    return ((lon - lon0) * m_lon, (lat - lat0) * m_lat)


def footprint_metrics(ring_lonlat: list[tuple[float, float]]) -> dict | None:
    """Oriented bounding box length/width (m) and area (m²) for a lon/lat ring."""
    lon0 = sum(p[0] for p in ring_lonlat) / len(ring_lonlat)
    lat0 = sum(p[1] for p in ring_lonlat) / len(ring_lonlat)
    xy = [_local_xy(lon, lat, lon0, lat0) for lon, lat in ring_lonlat]
    try:
        poly = Polygon(xy)
        if not poly.is_valid:
            poly = make_valid(poly)
        if poly.is_empty:
            return None
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
        if poly.area < 1.0:  # < 1 m² — noise
            return None
        mrr = poly.minimum_rotated_rectangle
        coords = list(mrr.exterior.coords)
        edges = [
            math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1])
            for i in range(4)
        ]
        length_m = max(edges[0], edges[1])  # adjacent edges of rectangle
        width_m = min(edges[0], edges[1])
        return {
            "length_m": round(length_m, 2),
            "width_m": round(width_m, 2),
            "area_m2": round(float(poly.area), 1),
            "centroid": {"lat": round(lat0, 7), "lon": round(lon0, 7)},
        }
    except Exception:
        return None


def elements_to_candidates(
    elements: list[dict], *, lat: float, lon: float, radius_m: float = DEFAULT_RADIUS_M
) -> list[dict]:
    """Build ranked candidate list with metrics + GeoJSON geometry.

    Drops footprints whose centroid is farther than ~1.25× radius (Overpass can
    return large polygons that only nick the search circle).
    """
    seen: set[str] = set()
    cands: list[dict] = []
    for el in elements:
        osm_type = el.get("type") or "way"
        osm_id = el.get("id")
        if osm_id is None:
            continue
        key = f"{osm_type}/{osm_id}"
        if key in seen:
            continue
        seen.add(key)
        ring = _ring_from_element(el)
        if not ring:
            continue
        metrics = footprint_metrics(ring)
        if not metrics:
            continue
        tags = el.get("tags") or {}
        # distance from query point to footprint centroid
        c = metrics["centroid"]
        dist_m = math.hypot(
            (c["lat"] - lat) * 111320.0,
            (c["lon"] - lon) * 111320.0 * math.cos(math.radians(lat)),
        )
        cands.append({
            "osm_id": osm_id,
            "osm_type": osm_type,
            "osm_key": key,
            "name": tags.get("name") or tags.get("addr:housenumber") or None,
            "building": tags.get("building"),
            "tags": {k: tags[k] for k in ("name", "building", "addr:housenumber", "addr:street", "addr:city") if k in tags},
            "length_m": metrics["length_m"],
            "width_m": metrics["width_m"],
            "area_m2": metrics["area_m2"],
            "centroid": metrics["centroid"],
            "distance_m": round(dist_m, 1),
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[lon, lat_] for lon, lat_ in ring]],
            },
        })
    # Keep footprints centred inside the search neighbourhood
    max_dist = float(radius_m) * 1.25
    nearby = [c for c in cands if c["distance_m"] <= max_dist]
    if nearby:
        cands = nearby
    # Prefer larger footprints; break ties by proximity (church before far warehouse)
    cands.sort(key=lambda c: (-c["area_m2"], c["distance_m"]))
    return cands[:MAX_CANDIDATES]


def lookup_near_address(
    address: str,
    *,
    provider: str = "nominatim",
    radius_m: float = DEFAULT_RADIUS_M,
    osm_id: int | None = None,
    osm_type: str | None = None,
) -> dict:
    """Geocode → Overpass → candidates. Returns payload to store on plan meta + candidates list."""
    geo = geocode_address(address, provider=provider)
    elements = fetch_building_elements(geo["lat"], geo["lon"], radius_m=radius_m)
    candidates = elements_to_candidates(
        elements, lat=geo["lat"], lon=geo["lon"], radius_m=radius_m
    )
    if not candidates:
        raise AddressLookupError(
            f"No OSM building footprints within ~{int(radius_m)} m of geocoded point "
            f"({geo['lat']:.5f}, {geo['lon']:.5f}). Try a more specific address or set scale manually.",
            status_code=404,
        )
    chosen = candidates[0]
    if osm_id is not None:
        match = next(
            (c for c in candidates
             if c["osm_id"] == osm_id and (osm_type is None or c["osm_type"] == osm_type)),
            None,
        )
        if not match:
            raise AddressLookupError(f"osm_id {osm_id} not in nearby footprints", status_code=404)
        chosen = match
    footprints_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": c["osm_key"],
                "properties": {
                    "osm_id": c["osm_id"],
                    "osm_type": c["osm_type"],
                    "name": c["name"],
                    "building": c["building"],
                    "length_m": c["length_m"],
                    "width_m": c["width_m"],
                    "area_m2": c["area_m2"],
                    "distance_m": c["distance_m"],
                    "selected": c["osm_key"] == chosen["osm_key"],
                },
                "geometry": c["geometry"],
            }
            for c in candidates
        ],
    }
    hint = {
        "length_m": chosen["length_m"],
        "width_m": chosen["width_m"],
        "area_m2": chosen["area_m2"],
        "osm_id": chosen["osm_id"],
        "osm_type": chosen["osm_type"],
        "osm_key": chosen["osm_key"],
        "name": chosen["name"],
        "building": chosen["building"],
        "distance_m": chosen["distance_m"],
        "centroid": chosen["centroid"],
    }
    return {
        "address": address.strip(),
        "geocode": geo,
        "footprints": footprints_fc,
        "footprint_hint": hint,
        "candidates": [
            {
                "osm_id": c["osm_id"],
                "osm_type": c["osm_type"],
                "osm_key": c["osm_key"],
                "name": c["name"],
                "building": c["building"],
                "length_m": c["length_m"],
                "width_m": c["width_m"],
                "area_m2": c["area_m2"],
                "distance_m": c["distance_m"],
            }
            for c in candidates
        ],
    }
