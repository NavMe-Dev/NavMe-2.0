"""Step indoor: vector indoor maps per floor (IMDF-like GeoJSON in WGS84) from Matterport rooms/walls/
openings + walk grid + stairs + POIs; OSM building footprints (3D context) and the site shell."""
import json, math, base64, collections
import numpy as np, cv2
from shapely.geometry import Polygon, LineString, Point, MultiPolygon, box, mapping
from shapely.ops import unary_union, substring


def run(ctx):
    rw = ctx.read_json(ctx.o("mp_rooms_walls.json")); pois = ctx.read_json(ctx.o("pois.json"))["pois"]
    nav = ctx.read_json(ctx.o("nav_graph.json")); wg = ctx.read_json(ctx.o("walkgrid.json"))
    G_ = ctx.georef(); floors = ctx.floors(); name = ctx.cfg.get("name") or "Building"
    ll = lambda x, y: tuple(G_.ll(x, y))
    geo = lambda g: mapping(G_.geom_ll(g))
    nx_, ny_, res, x0, y0 = wg["nx"], wg["ny"], wg["res"], wg["x0"], wg["y0"]

    def grid(F):
        w = np.frombuffer(base64.b64decode(wg["floors"][F]["walk"]), np.uint8).reshape(ny_, nx_)
        z = np.frombuffer(base64.b64decode(wg["floors"][F]["z_cm"]), "<i2").reshape(ny_, nx_).astype(float); z[z == -32768] = np.nan
        return w, z / 100
    grids = {f["id"]: grid(f["id"]) for f in floors}

    def zin(poly, F):
        _, z = grids[F]; b = poly.bounds
        i0, i1 = int((b[0] - x0) / res), int((b[2] - x0) / res) + 1; j0, j1 = int((b[1] - y0) / res), int((b[3] - y0) / res) + 1
        vals = [z[j, i] for j in range(max(j0, 0), min(j1, ny_)) for i in range(max(i0, 0), min(i1, nx_))
                if np.isfinite(z[j, i]) and poly.contains(Point(x0 + (i + .5) * res, y0 + (j + .5) * res))]
        return float(np.median(vals)) if vals else None
    poi_by_room = {p["room_id"]: p for p in pois if p.get("room_id")}
    door_nodes = {n.get("mp_opening"): n for n in nav["nodes"] if n["kind"] == "door"}
    STAIRS = nav.get("stairs") or []
    # ---------- OSM buildings ----------
    ob = ctx.read_json(ctx.w("osm_buildings.json")) if ctx.w("osm_buildings.json").exists() else {"elements": []}
    V = np.load(ctx.w("mesh.npz"))["V"]; cx, cy = ((V.min(0) + V.max(0)) / 2)[:2]
    site_ll = Point(*ll(cx, cy)); bfeats = []; site = None; site_best = 1e9
    for e in ob.get("elements", []):
        if e["type"] == "way" and e.get("geometry") and len(e["geometry"]) >= 4:
            geoms = [Polygon([(p["lon"], p["lat"]) for p in e["geometry"]])]
        else:
            geoms = [Polygon([(p["lon"], p["lat"]) for p in mb["geometry"]]) for mb in e.get("members", []) if mb.get("role") == "outer" and mb.get("geometry") and len(mb["geometry"]) >= 4]
        t = e.get("tags", {})
        try: h = float(t.get("height", "").split()[0])
        except Exception:
            try: h = float(t["building:levels"]) * 3.2
            except Exception: h = 4.5 if t.get("building") in ("house", "residential", "detached", "garage", "shed", "yes") else 7.0
        if t.get("building") in ("garage", "shed", "carport"): h = 3.0
        for gm in geoms:
            if not gm.is_valid: gm = gm.buffer(0)
            d = gm.distance(site_ll)
            f = {"type": "Feature", "geometry": mapping(gm), "properties": {"osm_id": f"{e['type']}/{e['id']}", "building": t.get("building"), "name": t.get("name"), "height_m": round(h, 1), "is_site": 0}}
            bfeats.append(f)
            if d < site_best and d < 0.0003: site_best = d; site = (f, gm)
    church = None
    if site:
        site[0]["properties"]["is_site"] = 1
        church = Polygon([tuple(G_.model(*c)) for c in site[1].exterior.coords]) if site[1].geom_type == "Polygon" else None
    ctx.write_json(ctx.o("buildings_osm.geojson"), {"type": "FeatureCollection", "name": "osm_buildings", "attribution": "© OpenStreetMap contributors (ODbL), via Overpass API", "features": bfeats}, compact=True)
    summary = {}; outlines = {}
    for f in floors:
        F = f["id"]; feats = []
        base = dict(level_id=F, ordinal=f["ordinal"], level_name=f["label"])
        rooms = [r for r in rw["rooms"] if r["floor"] == F and "indoor" in r["keywords"] and r["area_m2"] >= 1.0]
        RP = [(r, Polygon(r["polygon_model"]).buffer(0)) for r in rooms]
        walls = [w for w in rw["walls"] if w["floor"] == F]
        WL = unary_union([LineString([w["a"], w["b"]]) for w in walls]) if walls else None
        parts = [p for _, p in RP] + ([WL.buffer(0.2)] if WL is not None else [])
        if not parts:
            ctx.warn(f"{F}: no rooms/walls"); continue
        U = unary_union(parts).buffer(1.5, join_style=2).buffer(-1.5, join_style=2)
        polys = [Polygon(p.exterior) for p in (U.geoms if isinstance(U, MultiPolygon) else [U]) if p.area > 4]
        outline = unary_union(polys).simplify(0.1); outlines[F] = outline
        zs = [zin(p, F) for _, p in RP]; zs = [z for z in zs if z is not None]
        zlev = float(np.median(zs)) if zs else f["elevation"]
        feats.append({"type": "Feature", "geometry": geo(outline), "properties": {**base, "feature_type": "level", "category": "building", "style": "building", "name": f"{name} – {f['label']}", "floor_z": round(zlev, 2)}})
        w, z = grids[F]; mask = (w == 1).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)); mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        wp = [Polygon([(x0 + (c[0][0] + .5) * res, y0 + (c[0][1] + .5) * res) for c in cc]).buffer(0) for cc in cs if len(cc) >= 4]
        walkable = unary_union([p for p in wp if p.area > 1]).intersection(outline).difference(unary_union([p for _, p in RP]))
        for p in (walkable.geoms if hasattr(walkable, "geoms") else [walkable]):
            if p.geom_type != "Polygon" or p.area < 2: continue
            p = p.simplify(0.15)
            feats.append({"type": "Feature", "geometry": geo(p), "properties": {**base, "feature_type": "unit", "category": "walkway", "style": "walkway", "name": None, "area_m2": round(p.area, 1), "floor_z": round(zin(p, F) or zlev, 2), "source": "walkgrid"}})
        for r, p in RP:
            poi = poi_by_room.get(r["id"]); cat = (poi or {}).get("category", "room")
            if r["area_m2"] < 2: cat = "utility"
            imdf = {"room": "room", "hall": "room", "corridor": "walkway", "utility": "unspecified", "restroom": "restroom"}.get(cat, "room")
            c = p.representative_point()
            feats.append({"type": "Feature", "geometry": geo(p), "properties": {**base, "feature_type": "unit", "category": imdf, "display_category": cat, "style": cat,
                          "name": (poi or {}).get("name"), "code": (poi or {}).get("code"), "poi_id": (poi or {}).get("id"), "mp_room_id": r["id"], "area_m2": r["area_m2"],
                          "floor_z": round(zin(p, F) or zlev, 2), "label_point": ll(c.x, c.y)}})
        for s in STAIRS:
            if s.get("floors") and F not in s["floors"]: continue
            poly = box(*s["bbox_model"]); pp = poly.intersection(outline.buffer(0.25))
            if pp.is_empty or pp.area < 0.5: pp = poly
            feats.append({"type": "Feature", "geometry": geo(pp), "properties": {**base, "feature_type": "unit", "category": "stairs", "style": "stairs", "name": s["name"], "stair_id": s["id"], "floor_z": round(zin(pp, F) or zlev, 2), "step_free": False}})
        for wl in walls:
            L = LineString([wl["a"], wl["b"]]); cuts = sorted([(o["t0"], o["t1"]) for o in wl["openings"] if o["type"] == "doorway"])
            t = 0.0; segs = []
            for a, b in cuts: segs.append((t, a)); t = b
            segs.append((t, 1.0))
            wz = zin(L.buffer(0.7), F); wz = round(wz if wz is not None else zlev, 2)
            for a, b in segs:
                if (b - a) * L.length < 0.05: continue
                feats.append({"type": "Feature", "geometry": geo(substring(L, a, b, normalized=True)), "properties": {**base, "feature_type": "wall", "category": "wall", "style": "wall", "floor_z": wz, "mp_wall_id": wl["id"]}})
            for o in wl["openings"]:
                seg = substring(L, max(0, o["t0"]), min(1, o["t1"]), normalized=True)
                if o["type"] == "doorway":
                    dn = door_nodes.get(o["id"], {})
                    feats.append({"type": "Feature", "geometry": geo(seg), "properties": {**base, "feature_type": "opening", "category": "pedestrian.principal" if dn.get("exterior") else "pedestrian",
                                  "style": "entrance" if dn.get("exterior") else "door", "floor_z": wz, "door_type": o["label"], "width_m": round(o["width"], 2), "exterior": bool(dn.get("exterior")),
                                  "leads_to_unscanned": bool(dn.get("leads_to_unscanned")), "mp_opening_id": o["id"], "nav_node": dn.get("id")}})
                else:
                    feats.append({"type": "Feature", "geometry": geo(seg), "properties": {**base, "feature_type": "fixture", "category": "window", "style": "window", "floor_z": wz, "mp_opening_id": o["id"]}})
        for p in pois:
            if p["floor"] != F: continue
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": p["lonlat"]}, "properties": {**base, "feature_type": "anchor", "category": p["category"], "style": "anchor", "name": p["name"], "poi_id": p["id"], "floor_z": p["model"]["z"]}})
        fc = {"type": "FeatureCollection", "name": f"indoor_{F}", "level": base, "crs_note": "WGS84 lon/lat; floor_z = Matterport model metres",
              "source": f"Matterport GraphQL rooms/walls/openings (model {ctx.cfg.get('matterport_model_id')}) + mesh walk grid", "features": feats}
        ctx.write_json(ctx.o(f"indoor_{F}.geojson"), fc, compact=True)
        summary[F] = dict(collections.Counter(ft["properties"]["feature_type"] for ft in feats))
    shell = unary_union(list(outlines.values()) + ([church] if church is not None else []))
    roof = max(f["elevation"] + f["height"] for f in floors) + 1.0
    ctx.write_json(ctx.o("site_shell.geojson"), {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": geo(shell.simplify(0.2)), "properties": {"name": name, "source": "MP outlines ∪ OSM footprint", "roof_z": round(roof, 1)}}]})
    return {"features": summary, "osm_buildings": len(bfeats), "osm_site_found": bool(site)}
