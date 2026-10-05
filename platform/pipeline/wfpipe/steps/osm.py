"""Step osm: OpenStreetMap footways (for outdoor routing) and building footprints (3D context)
via the Overpass API (several public mirrors tried). Failures are non-fatal (empty result + warning)."""
import json, math, time, urllib.request, urllib.parse
import numpy as np

MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter"]


def overpass(q, ctx, timeout=75):
    last = None
    for u in MIRRORS:
        try:
            r = urllib.request.Request(u, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": "wayfinding-platform/0.1"})
            return json.load(urllib.request.urlopen(r, timeout=timeout))
        except Exception as e:
            last = e; ctx.warn(f"overpass {u} failed: {e}")
    raise RuntimeError(f"all Overpass mirrors failed: {last}")


def site_center_ll(ctx):
    G = ctx.georef(); V = np.load(ctx.w("mesh.npz"))["V"]; c = (V.min(0) + V.max(0)) / 2
    lon, lat = G.ll(c[0], c[1]); return lat, lon


def run(ctx):
    o = ctx.cfg["osm"]
    empty = {"elements": [], "note": "OSM disabled or unavailable"}
    if not o.get("enabled", True):
        ctx.write_json(ctx.w("osm_footways.json"), empty); ctx.write_json(ctx.w("osm_buildings.json"), empty); return {"enabled": False}
    lat, lon = site_center_ll(ctx)
    r = float(o.get("footway_radius_m", 220)); dlat = r / 111320; dlon = r / (111320 * math.cos(math.radians(lat)))
    bb = f"{lat-dlat:.6f},{lon-dlon:.6f},{lat+dlat:.6f},{lon+dlon:.6f}"
    qf = (f'[out:json][timeout:90];(way["highway"~"footway|path|pedestrian|steps|service|residential|tertiary|secondary|primary|unclassified|living_street"]({bb});'
          f'way["footway"]({bb}););out geom;')
    qb = f'[out:json][timeout:120];(way["building"](around:{int(o.get("building_radius_m",450))},{lat:.6f},{lon:.6f});relation["building"](around:{int(o.get("building_radius_m",450))},{lat:.6f},{lon:.6f}););out tags geom;'
    res = {}
    for name, q, key in (("osm_footways.json", qf, "footways_file"), ("osm_buildings.json", qb, "buildings_file")):
        try:
            d = json.load(open(o[key])) if o.get(key) else overpass(q, ctx)   # optional pre-downloaded Overpass JSON
        except Exception as e:
            ctx.warn(str(e)); d = empty
        ctx.write_json(ctx.w(name), d); res[name] = len(d.get("elements", []))
        time.sleep(1)
    return res
