"""Step pois: automatic POIs from the scan + optional curated seeds.

Auto: every indoor Matterport room >= 2 m² (name = MP room label / classification, else code 'Room F1-01'),
every exterior entrance door node, one POI per stair zone per floor, one POI per elevator per floor, Matterport labels and Mattertags.
Seeds (config.pois_seed): [{id, name, category, sweep_label|node|model_xy+floor, note}] override auto POIs
with the same id. Each POI is snapped to the nearest nav node on its floor (inside its room if possible).
The admin database is the source of truth after onboarding; stable ids let edits survive re-runs."""
import math
import networkx as nx
from shapely.geometry import Polygon, Point

CLASS_CAT = {"bathroom": "restroom", "restroom": "restroom", "toilet": "restroom", "hallway": "corridor", "hall": "hall",
             "stairs": "stairs", "staircase": "stairs", "kitchen": "room", "office": "room", "entrance": "entrance", "garage": "parking",
             "lobby": "hall", "foyer": "hall", "classroom": "room", "auditorium": "hall", "elevator": "elevator"}


def run(ctx):
    nav = ctx.read_json(ctx.o("nav_graph.json")); rw = ctx.read_json(ctx.o("mp_rooms_walls.json"))
    G_ = ctx.georef(); ll = lambda x, y: G_.ll(x, y)
    N = {n["id"]: n for n in nav["nodes"]}; byl = {n["label"]: n["id"] for n in nav["nodes"] if n["kind"] == "sweep"}
    G = nx.Graph(); [G.add_node(n["id"]) for n in nav["nodes"]]; [G.add_edge(e["u"], e["v"]) for e in nav["edges"]]
    Gsf = nx.Graph(); Gsf.add_nodes_from(G.nodes); Gsf.add_edges_from([(e["u"], e["v"]) for e in nav["edges"] if e.get("step_free")])
    sweeps = [n for n in nav["nodes"] if n["kind"] == "sweep"]

    def snap(x, y, F, poly=None):
        c = [n for n in sweeps if n["floor"] == F] or sweeps
        if poly is not None:
            ins = [n for n in c if poly.contains(Point(n["x"], n["y"]))]
            if ins: c = ins
        n = min(c, key=lambda n: math.hypot(n["x"] - x, n["y"] - y)); return n["id"], round(math.hypot(n["x"] - x, n["y"] - y), 2)

    pois = {}; cnt = {}
    rooms = [r for r in rw["rooms"] if "indoor" in r["keywords"] and r["area_m2"] >= 2.0]
    rooms.sort(key=lambda r: (r["floor"], -Polygon(r["polygon_model"]).centroid.y, Polygon(r["polygon_model"]).centroid.x))
    for r in rooms:
        Pp = Polygon(r["polygon_model"]); c = Pp.centroid if Pp.contains(Pp.centroid) else Pp.representative_point()
        cnt[r["floor"]] = cnt.get(r["floor"], 0) + 1; code = "Room %s-%02d" % (r["floor"], cnt[r["floor"]])
        nid, dist = snap(c.x, c.y, r["floor"], Pp)
        cls = [x.lower() for x in r.get("classifications") or []]
        cat = next((CLASS_CAT[x] for x in cls if x in CLASS_CAT), "room")
        name = r.get("label") or (r["classifications"][0].title() if cls and cls[0] not in ("room", "unknown", "other") else code)
        pid = "poi_" + r["id"][:10]
        pois[pid] = dict(id=pid, name=name, code=code, category=cat, floor=r["floor"], model={"x": round(c.x, 2), "y": round(c.y, 2), "z": round(N[nid]["z"], 2)},
                         lonlat=ll(c.x, c.y), nearest_node=nid, nearest_sweep_label=N[nid]["label"], node_distance_m=dist, room_id=r["id"], area_m2=r["area_m2"],
                         source="matterport_room", status="auto")

    def node_poi(pid, name, cat, nid, note="", source="auto"):
        n = N[nid]
        pois[pid] = dict(id=pid, name=name, code=None, category=cat, floor=n["floor"], model={"x": round(n["x"], 2), "y": round(n["y"], 2), "z": round(n["z"], 2)},
                         lonlat=ll(n["x"], n["y"]), nearest_node=nid, nearest_sweep_label=n.get("label"), node_distance_m=0.0, room_id=None, area_m2=None,
                         source=source, status="auto", note=note)
    for i, n in enumerate([n for n in nav["nodes"] if n["kind"] == "door" and n.get("exterior")]):
        node_poi("poi_" + n["id"][:30], f"Entrance {i+1}", "entrance", n["id"], n.get("label", ""))
    for s in nav.get("stairs") or []:
        x0, y0, x1, y1 = s["bbox_model"]
        for F in s.get("floors") or sorted({n["floor"] for n in sweeps}):
            cand = [n for n in sweeps if n["floor"] == F and x0 - 1 <= n["x"] <= x1 + 1 and y0 - 1 <= n["y"] <= y1 + 1]
            if cand:
                n = min(cand, key=lambda n: math.hypot(n["x"] - (x0 + x1) / 2, n["y"] - (y0 + y1) / 2))
                node_poi(f"poi_{s['id']}_{F}", f"{s['name']} – {nav['floors'].get(F, {}).get('label', F)}", "stairs", n["id"])
    for el in nav.get("elevators") or []:
        doors = el.get("doors") or {}
        door_nodes = el.get("door_nodes") or {}
        bbox = el.get("bbox_model")
        for F in el.get("floors") or []:
            flab = nav["floors"].get(F, {}).get("label", F)
            pname = f"{el.get('name', el['id'])} – {flab}"
            pid = f"poi_{el['id']}_{F}"
            nid = door_nodes.get(F)
            if nid and nid in N:
                node_poi(pid, pname, "elevator", nid, source="elevator")
                continue
            if F in doors and doors[F] is not None:
                x, y = float(doors[F]["x"]), float(doors[F]["y"])
                nid, _ = snap(x, y, F)
                node_poi(pid, pname, "elevator", nid, source="elevator")
                continue
            if bbox and len(bbox) >= 4:
                x0, y0, x1, y1 = bbox[:4]
                cand = [n for n in sweeps if n["floor"] == F and x0 - 1 <= n["x"] <= x1 + 1 and y0 - 1 <= n["y"] <= y1 + 1]
                if cand:
                    n = min(cand, key=lambda n: math.hypot(n["x"] - (x0 + x1) / 2, n["y"] - (y0 + y1) / 2))
                    node_poi(pid, pname, "elevator", n["id"], source="elevator")
    m = ctx.read_json(ctx.w("mp_model.json"))["data"]["model"]
    flmap = ctx.read_json(ctx.w("floors_resolved.json"))["mp_floor_map"]
    for kind, items in (("label", m.get("labels") or []), ("tag", m.get("mattertags") or [])):
        for t in items:
            if not t.get("floor") or not t.get("position"): continue
            F = flmap.get(t["floor"]["id"]); x, y = t["position"]["x"], t["position"]["y"]; nid, dist = snap(x, y, F)
            pid = f"poi_{kind}_{t['id'][:10]}"
            pois[pid] = dict(id=pid, name=t["label"], code=None, category="room" if kind == "label" else "info", floor=F,
                             model={"x": round(x, 2), "y": round(y, 2), "z": round(t["position"]["z"], 2)}, lonlat=ll(x, y), nearest_node=nid,
                             nearest_sweep_label=N[nid]["label"], node_distance_m=dist, room_id=None, area_m2=None, source=f"matterport_{kind}",
                             status="auto", note=t.get("description") or "")
    for s in ctx.cfg.get("pois_seed") or []:
        base = dict(pois.get(s["id"], {}))
        nid = s.get("node") or (byl.get(s["sweep_label"]) if s.get("sweep_label") else None)
        if nid and nid in N:
            node_poi(s["id"], s.get("name", base.get("name", s["id"])), s.get("category", base.get("category", "room")), nid, s.get("note", ""), source="seed")
            if base.get("room_id"):
                pois[s["id"]].update(room_id=base["room_id"], code=base.get("code"), area_m2=base.get("area_m2"), model=base["model"], lonlat=base["lonlat"])
        elif s.get("model_xy"):
            x, y = s["model_xy"]; F = s.get("floor", "F1"); nid, dist = snap(x, y, F)
            node_poi(s["id"], s["name"], s.get("category", "room"), nid, s.get("note", ""), source="seed")
            pois[s["id"]].update(model={"x": x, "y": y, "z": N[nid]["z"]}, lonlat=ll(x, y), node_distance_m=dist)
        elif base:
            base.update({k: v for k, v in s.items() if k in ("name", "category", "note")}); base["source"] = "seed"; pois[s["id"]] = base
    arr = ctx.cfg.get("arrival_poi") or next((p["id"] for p in pois.values() if p["category"] == "parking"), None)
    src = pois[arr]["nearest_node"] if arr in pois else None
    for p in pois.values():
        p["reachable"] = bool(src is None or nx.has_path(G, src, p["nearest_node"]))
        p["step_free_from_parking"] = bool(src is not None and nx.has_path(Gsf, src, p["nearest_node"]))
    out = {"schema": "wayfinding.pois/v1", "building": ctx.cfg.get("name"), "arrival_poi": arr, "frame": "Matterport model metres; lonlat WGS84",
           "pois": list(pois.values())}
    ctx.write_json(ctx.o("pois.json"), out)
    cats = {}
    for p in pois.values(): cats[p["category"]] = cats.get(p["category"], 0) + 1
    return {"pois": len(pois), "by_category": cats, "arrival": arr}
