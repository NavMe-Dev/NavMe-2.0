"""Step export: write out/config.json – the per-building manifest the viewer and API read
(identity, model, floors, files, map centre/bounds, branding)."""
import numpy as np


def run(ctx):
    floors = ctx.floors(); gj = ctx.read_json(ctx.o("georef.json")); G = ctx.georef()
    glb = ctx.read_json(ctx.o("model_glb.json")); fj = ctx.read_json(ctx.o("floors.json"))
    V = np.load(ctx.w("mesh.npz"))["V"]; lo, hi = V.min(0), V.max(0)
    corners = [G.ll(lo[0], lo[1]), G.ll(hi[0], lo[1]), G.ll(hi[0], hi[1]), G.ll(lo[0], hi[1])]
    lons = [c[0] for c in corners]; lats = [c[1] for c in corners]
    c = G.ll((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    pois = ctx.read_json(ctx.o("pois.json"))
    nav = ctx.read_json(ctx.o("nav_graph.json"))
    outdoor = [n for n in nav["nodes"] if n["kind"] == "sweep" and not n.get("indoor")]
    grade = min(outdoor, key=lambda n: n["x"] ** 2 + n["y"] ** 2)["z"] if outdoor else floors[0]["elevation"]
    cfg = {"schema": "wayfinding.building/v1", "slug": ctx.cfg.get("slug"), "name": ctx.cfg.get("name"), "address": ctx.cfg.get("address"),
           "matterport_model_id": ctx.cfg.get("matterport_model_id"), "center": {"lon": c[0], "lat": c[1]},
           "bounds": [min(lons), min(lats), max(lons), max(lats)],
           "floors": [{"id": f["id"], "label": f["label"], "short": f["short"], "ordinal": f["ordinal"], "elevation": f["elevation"], "height": f["height"],
                       "overlay": next((o["image"] for o in fj["floors"] if o["id"] == f["id"]), None), "glb": glb["files"].get(f["id"], glb["default"])} for f in floors],
           "default_floor": floors[0]["id"],
           "model_bbox": [round(float(lo[0]), 2), round(float(lo[1]), 2), round(float(hi[0]), 2), round(float(hi[1]), 2)],
           "grade_z": round(float(grade), 2), "grade_note": "model z of outdoor grade near model origin (3D terrain anchoring)", "rotation_deg": gj["rotation_deg"],
           "files": {"georef": "georef.json", "floors": "floors.json", "nav_graph": "nav_graph.json", "walkgrid": "walkgrid.json", "navmesh": "navmesh.json", "pois": "pois.json",
                     "mp_graph_raw": "mp_graph_raw.json", "indoor": {f["id"]: f"indoor_{f['id']}.geojson" for f in floors},
                     "buildings_osm": "buildings_osm.geojson", "site_shell": "site_shell.geojson", "model_glb": "model_glb.json", "thumbs": "thumbs/index.json"},
           "stats": {"pois": len(pois["pois"]), "nav_nodes": len(nav["nodes"]), "nav_edges": len(nav["edges"]),
                     "entrances": sum(1 for n in nav["nodes"] if n.get("exterior")), "step_free_entrance": any(p.get("step_free_from_parking") and p["category"] == "entrance" for p in pois["pois"])},
           "branding": ctx.cfg.get("branding") or {}, "arrival_poi": pois.get("arrival_poi")}
    ctx.write_json(ctx.o("config.json"), cfg)
    return {"floors": len(floors), "center": [round(c[1], 6), round(c[0], 6)]}
