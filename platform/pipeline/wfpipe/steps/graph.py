"""Step graph: hybrid navigation graph.

Matterport sweep neighbour graph -> prune edges that cross walls/windows, have floor gaps, steps too high,
obstacles at 1 m or are too steep (checked against the mesh voxel grid) -> reconnect components with the
cheapest pruned edge -> split edges through doorways into door nodes, add door hubs -> join outdoor
sweeps to OSM footways -> 0.2 m walk grid for line-of-sight smoothing.
Stairs: config.stairs (manual zones) or auto-detected from steep sweep edges (>=0.3 m rise per metre).
Elevators: config.elevators only (no mesh auto-detect); doors XY and/or bbox_model per shaft."""
import json, math, base64
import numpy as np, networkx as nx
from shapely.geometry import LineString, Point, box
from shapely.ops import polygonize, unary_union

# Elevator routing costs (metres-equivalent on edges). Wait + climb; not physical cab travel.
# Viewer time model uses separate seconds: ~20 s wait + ~4 s per floor (see routing.js / navgraph.py).
ELEVATOR_WAIT_M = 15.0
ELEVATOR_PER_FLOOR_M = 8.0
ELEVATOR_DOOR_SNAP_M = 3.0  # max distance to reuse an existing sweep/door near door XY or bbox


def add_elevators(G, elevators_cfg, log=None):
    """Add config-driven elevator hubs and cross-floor edges. Mutates G.

    Each elevator: {id, name?, floors: [floorId...], doors?: {floor: {x,y}}, bbox_model?: [xmin,ymin,xmax,ymax]}.
    Prefer doors XY when present; else nearest sweep on that floor inside/near bbox (like stairs).
    Prefer linking to an existing Matterport sweep within ELEVATOR_DOOR_SNAP_M rather than inventing nodes.
    Edges: stairs=None, step_free=True, source="elevator", elevator=<id>, cross_floor=True,
    length = ELEVATOR_WAIT_M + ELEVATOR_PER_FLOOR_M * floor_delta (index distance in floors list).
    Connects all floor pairs (not only consecutive) so multi-stop shafts route directly.
    Returns (elevators_export_list, elevator_edge_count). Empty config -> ([], 0); graph unchanged.
    """
    _log = log or (lambda *_a, **_k: None)
    out, n_edges = [], 0
    for elev in elevators_cfg or []:
        eid = elev.get("id")
        if not eid:
            _log("elevator entry missing id; skip")
            continue
        ename = elev.get("name") or eid
        flist = list(elev.get("floors") or [])
        doors = elev.get("doors") or None
        bbox = elev.get("bbox_model") or None
        if len(flist) < 2:
            _log(f"elevator {eid}: need >=2 floors; skip")
            continue
        if not doors and not bbox:
            _log(f"elevator {eid}: need doors or bbox_model; skip")
            continue
        hubs = {}
        for F in flist:
            tx = ty = None
            if doors and F in doors and doors[F] is not None:
                dxy = doors[F]
                tx, ty = float(dxy["x"]), float(dxy["y"])
            elif bbox and len(bbox) >= 4:
                x0, y0, x1, y1 = bbox[:4]
                tx, ty = (x0 + x1) / 2.0, (y0 + y1) / 2.0
            else:
                _log(f"elevator {eid}: floor {F} has no door XY / bbox; skip floor")
                continue
            sweeps = [(n, d) for n, d in G.nodes(data=True)
                      if d.get("kind") == "sweep" and d.get("floor") == F]
            if not sweeps:
                _log(f"elevator {eid}: no sweeps on floor {F}; skip floor")
                continue
            if bbox and len(bbox) >= 4:
                poly = box(*bbox[:4])
                near = [(n, d) for n, d in sweeps
                        if poly.distance(Point(d["x"], d["y"])) <= ELEVATOR_DOOR_SNAP_M]
                pool = near or sweeps
            else:
                pool = sweeps
            nid, nd = min(pool, key=lambda nd_: math.hypot(nd_[1]["x"] - tx, nd_[1]["y"] - ty))
            dist = math.hypot(nd["x"] - tx, nd["y"] - ty)
            if dist <= ELEVATOR_DOOR_SNAP_M:
                hubs[F] = nid
            else:
                # Door/bbox far from scans: create a dedicated hub and short link to nearest sweep.
                hid = f"elev_{eid}_{F}"
                if hid not in G:
                    G.add_node(hid, kind="elevator", label=f"{ename} ({F})", floor=F,
                               x=round(tx, 3), y=round(ty, 3), z=float(nd["z"]),
                               indoor=True, elevator=eid)
                if not G.has_edge(hid, nid):
                    G.add_edge(hid, nid, length=round(dist, 3), dz=0.0, stairs=None,
                               step_free=True, cross_floor=False, source="elevator_link",
                               elevator=eid, pruned=None)
                hubs[F] = hid
        # All floor pairs with index-based floor_delta (skip-stop friendly).
        for i, Fa in enumerate(flist):
            for j in range(i + 1, len(flist)):
                Fb = flist[j]
                if Fa not in hubs or Fb not in hubs:
                    continue
                na, nb = hubs[Fa], hubs[Fb]
                if na == nb:
                    continue
                floor_delta = j - i
                length = ELEVATOR_WAIT_M + ELEVATOR_PER_FLOOR_M * floor_delta
                za, zb = G.nodes[na]["z"], G.nodes[nb]["z"]
                dz = abs(float(za) - float(zb))
                # Do not clobber an existing stair edge between the same sweeps; use dedicated hubs.
                if G.has_edge(na, nb):
                    existing = G.edges[na, nb]
                    if existing.get("source") == "elevator":
                        continue
                    if existing.get("stairs"):
                        def _hub(F, n_src):
                            hid = f"elev_{eid}_{F}"
                            if hid not in G:
                                src = G.nodes[n_src]
                                G.add_node(hid, kind="elevator", label=f"{ename} ({F})", floor=F,
                                           x=src["x"], y=src["y"], z=src["z"], indoor=True, elevator=eid)
                                G.add_edge(hid, n_src, length=0.01, dz=0.0, stairs=None, step_free=True,
                                           cross_floor=False, source="elevator_link", elevator=eid, pruned=None)
                            return hid
                        na, nb = _hub(Fa, na), _hub(Fb, nb)
                        za, zb = G.nodes[na]["z"], G.nodes[nb]["z"]
                        dz = abs(float(za) - float(zb))
                    else:
                        # Replace a non-stair cross link with the elevator connector.
                        G.remove_edge(na, nb)
                if not G.has_edge(na, nb):
                    G.add_edge(na, nb, length=round(length, 3), dz=round(dz, 3), stairs=None,
                               step_free=True, source="elevator", elevator=eid,
                               cross_floor=True, floor_delta=floor_delta, pruned=None)
                    n_edges += 1
        rec = {"id": eid, "name": ename, "floors": flist, "source": "config",
               "door_nodes": {F: hubs[F] for F in hubs}}
        if doors:
            rec["doors"] = {F: {"x": float(doors[F]["x"]), "y": float(doors[F]["y"])}
                            for F in doors if doors[F] is not None and F in flist}
        if bbox:
            rec["bbox_model"] = [round(float(c), 3) for c in bbox[:4]]
        out.append(rec)
        _log(f"elevator {eid}: hubs on {list(hubs)} , edges so far {n_edges}")
    return out, n_edges




def run(ctx):
    P = ctx.cfg["graph"]
    m = ctx.read_json(ctx.w("mp_model.json"))["data"]["model"]
    fr = ctx.read_json(ctx.w("floors_resolved.json")); floors = fr["floors"]; FL = fr["mp_floor_map"]
    FID = [f["id"] for f in floors]
    FLOOR_Z = {f["id"]: tuple(f["wall_band"]) for f in floors}
    G_ = ctx.georef(); ll = lambda x, y: G_.ll(x, y)
    v = np.load(ctx.w("vox.npz")); occ, flo = v["occ"], v["flo"]; X0, Y0, Z0, VR = v["meta"]
    NY, NX, NZ = occ.shape
    # ---------- walls / openings ----------
    walls = []
    for f in m["floors"]:
        vp = {vv["id"]: (vv["position"]["x"], vv["position"]["y"]) for vv in f["vertices"] or []}
        for e in f["edges"] or []:
            a, b = [vp[x["id"]] for x in e["vertices"]]; L = math.dist(a, b)
            if L < 1e-6: continue
            ops = []
            for op in e["openings"] or []:
                c = op["relativeCenter"] * L
                ops.append(dict(t0=(c - op["width"] / 2) / L, t1=(c + op["width"] / 2) / L, type=op["type"], zlo=op["lowerElevation"],
                                zhi=op["lowerElevation"] + op["height"], id=op["id"], label=op["label"], width=op["width"],
                                center=(a[0] + (b[0] - a[0]) * op["relativeCenter"], a[1] + (b[1] - a[1]) * op["relativeCenter"])))
            walls.append(dict(floor=FL[f["id"]], line=LineString([a, b]), a=a, b=b, ops=ops, id=e["id"]))
    # ---------- rooms ----------
    rooms = []
    for r in m["rooms"]:
        if not r.get("boundary") or not r["boundary"].get("edges"): continue
        segs = [LineString([(vv["position"]["x"], vv["position"]["y"]) for vv in e["vertices"]]) for e in r["boundary"]["edges"]]
        polys = list(polygonize(unary_union(segs)))
        if not polys: continue
        Pp = unary_union(polys)
        rooms.append(dict(id=r["id"], floor=FL[r["floor"]["id"]], poly=Pp, cls=[c["label"] for c in r["classifications"] or []],
                          kw=r.get("keywords") or [], label=r.get("label"), area=Pp.area, indoor="indoor" in (r.get("keywords") or [])))
    indoor_polys = {F: unary_union([r["poly"] for r in rooms if r["floor"] == F and r["indoor"]]) for F in FID}
    # ---------- nodes ----------
    Lc = {l["id"]: l for l in m["locations"]}
    G0 = nx.Graph()
    for l in m["locations"]:
        if not l.get("floor"): continue
        p = l["position"]; F = FL[l["floor"]["id"]]
        ind = (not indoor_polys[F].is_empty) and indoor_polys[F].buffer(0.15).contains(Point(p["x"], p["y"]))
        G0.add_node(l["id"], kind="sweep", label="S" + str(l["label"]), floor=F, x=p["x"], y=p["y"], z=p["z"], indoor=bool(ind),
                    cam_z=(l.get("pano") or {}).get("position", {}).get("z", p["z"] + 1.5), mp_floor=l["floor"]["id"], mp_index=l.get("index"))
    for l in m["locations"]:
        for nb in l.get("neighbors") or []:
            if nb in Lc and l["id"] in G0 and nb in G0: G0.add_edge(l["id"], nb)
    ctx.log(f"raw sweeps {G0.number_of_nodes()} neighbour edges {G0.number_of_edges()}")

    def colfloors(ix, iy, nb=1):
        c = flo[max(0, iy - nb):iy + nb + 1, max(0, ix - nb):ix + nb + 1].any((0, 1)); return Z0 + (np.flatnonzero(c) + 0.5) * VR

    def walk(a, b, stair):
        p0 = np.array([a["x"], a["y"]]); p1 = np.array([b["x"], b["y"]]); d = np.linalg.norm(p1 - p0); n = max(2, int(d / 0.1))
        zprev = a["z"]; gap = 0; maxgap = 0; maxstep = 0; obst = 0; prof = [a["z"]]
        for i in range(1, n):
            t = i / n; q = p0 + (p1 - p0) * t; ix = int((q[0] - X0) / VR); iy = int((q[1] - Y0) / VR)
            if not (0 <= ix < NX and 0 <= iy < NY): gap += 1; maxgap = max(maxgap, gap); prof.append(np.nan); continue
            zs = colfloors(ix, iy)
            ref = (a["z"] + (b["z"] - a["z"]) * t) if stair else zprev
            tol = 0.6 if stair else 0.35
            cand = zs[np.abs(zs - ref) < tol] if len(zs) else zs
            if len(cand) == 0: gap += 1; maxgap = max(maxgap, gap); prof.append(np.nan); continue
            z = cand[np.argmin(np.abs(cand - ref))]; gap = 0
            st = abs(z - zprev); maxstep = max(maxstep, st); zprev = z; prof.append(z)
            if not stair:
                k0 = int((z + 0.9 - Z0) / VR); k1 = int((z + 1.6 - Z0) / VR)
                if occ[iy, ix, max(k0, 0):max(k1, 0)].any(): obst += 1
        reach = abs(zprev - b["z"]) < (0.6 if stair else 0.35)
        pr = np.array(prof + [b["z"]], float); k = 10
        g1 = np.nanmax(np.abs(pr[k:] - pr[:-k])) if len(pr) > k and np.isfinite(pr).sum() > k else abs(b["z"] - a["z"])
        return dict(grade1m=round(float(g1) if np.isfinite(g1) else 0.0, 3), maxgap=maxgap * 0.1, maxstep=round(float(maxstep), 3), obst=obst, reach=bool(reach))

    # ---------- stairs ----------
    if ctx.cfg.get("stairs"):
        STAIRS = [dict(id=s["id"], name=s.get("name", s["id"]), poly=box(*s["bbox_model"]), floors=s.get("floors"), source="config") for s in ctx.cfg["stairs"]]
    else:
        segs = []
        for u, w in G0.edges():
            a, b = G0.nodes[u], G0.nodes[w]; dz = abs(a["z"] - b["z"]); dh = math.dist((a["x"], a["y"]), (b["x"], b["y"]))
            if dz < 0.4 or dh > 8 or dh < 0.3: continue
            wk = walk(a, b, True)
            if wk["reach"] and wk["maxgap"] <= 0.8 and wk["grade1m"] >= 0.3:
                segs.append((LineString([(a["x"], a["y"]), (b["x"], b["y"])]), {a["floor"], b["floor"]}, dz))
        zones = []
        U = unary_union([s[0].buffer(1.0) for s in segs]) if segs else None
        for i, g in enumerate((U.geoms if hasattr(U, "geoms") else [U]) if U is not None else []):
            fl_ = set().union(*[s[1] for s in segs if s[0].intersects(g)])
            zones.append(dict(id=f"stairs_{i+1}", name=("Stairs " + chr(65 + i)), poly=box(*g.bounds), floors=sorted(fl_), source="auto"))
        STAIRS = zones
        ctx.log(f"auto-detected {len(STAIRS)} stair zones")

    def wall_check(a, b, stair=None, skip_wall=None):
        seg = LineString([(a["x"], a["y"]), (b["x"], b["y"])]); zlo, zhi = min(a["z"], b["z"]), max(a["z"], b["z"])
        doors = []; block = None; blocks = []
        if seg.length < 1e-6: return None, [], []
        for w in walls:
            if w["id"] == skip_wall: continue
            if stair and stair["poly"].buffer(0.5).contains(w["line"]): continue
            fz = FLOOR_Z[w["floor"]]
            if zhi < fz[0] or zlo > fz[1]: continue
            if not seg.intersects(w["line"]): continue
            ip = seg.intersection(w["line"])
            if ip.geom_type != "Point": block = ("wall_parallel", w["id"]); continue
            t = w["line"].project(ip) / w["line"].length
            zc = a["z"] + (b["z"] - a["z"]) * seg.project(ip) / max(seg.length, 1e-6)
            if not (fz[0] <= zc <= fz[1]): continue
            hit = None
            for op in w["ops"]:
                marg = 0.15 / w["line"].length
                if op["t0"] - marg <= t <= op["t1"] + marg: hit = op
            if hit and hit["type"] == "doorway" and hit["zlo"] - 0.5 <= zc <= hit["zhi"]:
                doors.append(dict(op=hit, wall=w, pt=(ip.x, ip.y), z=float(zc)))
            else:
                block = ("window" if hit else "wall", w["id"]); blocks.append(dict(type=block[0], wall=w, pt=(ip.x, ip.y), z=float(zc)))
        if blocks and any(b_["type"] == "window" for b_ in blocks): block = ("window", None)
        return block, doors, blocks

    # ---------- evaluate edges ----------
    G = nx.Graph(); G.add_nodes_from(G0.nodes(data=True))
    stats = {"raw": G0.number_of_edges()}; reasons = {}; edge_info = {}
    for u, w in G0.edges():
        a, b = G0.nodes[u], G0.nodes[w]
        seg = LineString([(a["x"], a["y"]), (b["x"], b["y"])]); d3 = math.dist((a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"]))
        dz = abs(a["z"] - b["z"])
        stair = next((s for s in STAIRS if dz > 0.4 and seg.intersects(s["poly"]) and s["poly"].distance(Point(a["x"], a["y"])) < 3
                      and s["poly"].distance(Point(b["x"], b["y"])) < 3 and seg.length <= 8), None)
        info = dict(length=round(d3, 3), dz=round(dz, 3), stairs=stair["id"] if stair else None, cross_floor=a["floor"] != b["floor"])
        reason = None
        if d3 > P.get("max_edge_m", 15): reason = "too_long"
        if not reason and info["cross_floor"] and not stair and not (not a["indoor"] and not b["indoor"]): reason = "cross_floor_not_stairs"
        blk, doors, blocks = wall_check(a, b, stair)
        wk = walk(a, b, bool(stair)); info.update(wk)
        if blk and blk[0] == "wall" and len(blocks) == 1 and wk["obst"] == 0 and d3 < 8 and not wk["maxgap"] > 0.3:
            bb = blocks[0]
            doors.append(dict(op=dict(id="inf_" + bb["wall"]["id"] + "_%d" % int(bb["wall"]["line"].project(Point(bb["pt"]))), type="doorway",
                                      label="opening-inferred", width=0.9, zlo=bb["z"], zhi=bb["z"] + 2, center=bb["pt"]), wall=bb["wall"], pt=bb["pt"], z=bb["z"]))
            blk = None; info["inferred_opening"] = True
        if not reason and blk: reason = "crosses_" + blk[0]
        if not reason:
            if wk["maxgap"] > 0.8: reason = "floor_gap"
            elif not wk["reach"] or (not stair and wk["maxstep"] > 0.35): reason = "step_too_high"
            elif not stair and wk["obst"] >= 2: reason = "obstacle_at_1m"
        if not reason and dz > 0.4 and not stair and d3 > 0 and dz / d3 > 0.25: reason = "too_steep"
        if not reason and not stair and wk["grade1m"] >= 0.3 and dz >= 0.25:
            zs_ = next((z_ for z_ in STAIRS if seg.intersects(z_["poly"].buffer(1.0))), None)
            info["stairs"] = zs_["id"] if zs_ else "steps"
        info["doors"] = [dd["op"]["id"] for dd in doors]; info["_doors"] = doors
        info["step_free"] = bool(not info["stairs"] and wk["maxstep"] <= P.get("step_free_max_step_m", 0.16))
        info["pruned"] = reason
        edge_info[(u, w)] = info
        if reason: reasons[reason] = reasons.get(reason, 0) + 1
        else: G.add_edge(u, w, **{k: v for k, v in info.items() if k != "_doors"})
    stats["kept_initial"] = G.number_of_edges(); stats["pruned_by_reason"] = reasons
    # ---------- reconnect ----------
    restored = []
    while nx.number_connected_components(G) > 1:
        comp = {n: i for i, c in enumerate(nx.connected_components(G)) for n in c}
        cands = [(k, v) for k, v in edge_info.items() if v["pruned"] and comp[k[0]] != comp[k[1]] and v["pruned"] not in ("crosses_wall", "crosses_window", "too_long")]
        if not cands: cands = [(k, v) for k, v in edge_info.items() if v["pruned"] and comp[k[0]] != comp[k[1]]]
        if not cands: break
        (u, w), v = min(cands, key=lambda kv: kv[1]["length"] + (50 if "crosses" in kv[1]["pruned"] else 0))
        v = dict(v); v["restored_from"] = v["pruned"]; v["pruned"] = None
        if v["restored_from"] in ("step_too_high", "floor_gap", "too_steep"): v["step_free"] = False
        G.add_edge(u, w, **{k: x for k, x in v.items() if k != "_doors"}); restored.append((G.nodes[u]["label"], G.nodes[w]["label"], v["restored_from"]))
    stats["restored_for_connectivity"] = restored

    def is_exterior(center, wall, F):
        ax, ay = wall["a"]; bx, by = wall["b"]; L = math.hypot(bx - ax, by - ay); nx_, ny_ = -(by - ay) / L, (bx - ax) / L
        Pp = indoor_polys[F]
        if Pp.is_empty: return False
        return bool(Pp.contains(Point(center[0] + nx_ * 0.6, center[1] + ny_ * 0.6)) != Pp.contains(Point(center[0] - nx_ * 0.6, center[1] - ny_ * 0.6)))
    # ---------- door nodes ----------
    door_nodes = {}
    for u, w, d in list(G.edges(data=True)):
        doors = edge_info.get((u, w), edge_info.get((w, u)))["_doors"]
        if not doors: continue
        a, b = G.nodes[u], G.nodes[w]
        doors = sorted(doors, key=lambda dd: math.dist(dd["pt"], (a["x"], a["y"])))
        chain = [u]
        for dd in doors:
            op = dd["op"]; nid = "door_" + op["id"]
            if nid not in door_nodes:
                ext = is_exterior(op["center"], dd["wall"], dd["wall"]["floor"])
                oplab = (op.get("label") or "").strip()
                door_nodes[nid] = dict(kind="door", label=(("Entrance" if ext else "Door") + (f" {oplab}" if oplab else "")), floor=dd["wall"]["floor"], x=op["center"][0], y=op["center"][1],
                                       z=round(max(op["zlo"], dd["z"] - 0.2) if abs(op["zlo"] - dd["z"]) < 0.5 else dd["z"], 3),
                                       indoor=False, exterior=ext, width=round(op["width"], 2), mp_opening=op["id"], door_type=op.get("label"))
                G.add_node(nid, **door_nodes[nid])
            chain.append(nid)
        chain.append(w); G.remove_edge(u, w)
        for p_, q_ in zip(chain, chain[1:]):
            if p_ == q_ or G.has_edge(p_, q_): continue
            A_, B_ = G.nodes[p_], G.nodes[q_]; l3 = math.dist((A_["x"], A_["y"], A_["z"]), (B_["x"], B_["y"], B_["z"]))
            dzp = abs(A_["z"] - B_["z"]); dd_ = {**d, "length": round(l3, 3), "dz": round(dzp, 3), "split_from": [G0.nodes[u]["label"], G0.nodes[w]["label"]]}
            if d.get("stairs") and dzp < 0.2: dd_["stairs"] = None
            G.add_edge(p_, q_, **dd_)
    # ---------- door hubs ----------
    hub_edges = 0
    for w in walls:
        for op in w["ops"]:
            if op["type"] != "doorway": continue
            nid = "door_" + op["id"]; dn = dict(x=op["center"][0], y=op["center"][1], z=op["zlo"])
            links = []
            for n, d in G0.nodes(data=True):
                if abs(d["z"] - op["zlo"]) > 0.5 or math.dist((d["x"], d["y"]), op["center"]) > 7: continue
                blk, _, _ = wall_check(dn, d, skip_wall=w["id"])
                if blk: continue
                wk = walk(dn, d, False)
                if wk["maxgap"] > 0.8 or wk["maxstep"] > 0.35 or wk["obst"] >= 2 or not wk["reach"]: continue
                links.append((n, d, wk))
            if nid not in G and len(links) < 2: continue
            if nid not in G:
                ext = is_exterior(op["center"], w, w["floor"])
                oplab = (op.get("label") or "").strip()
                door_nodes[nid] = dict(kind="door", label=(("Entrance" if ext else "Door") + (f" {oplab}" if oplab else "")), floor=w["floor"], x=op["center"][0], y=op["center"][1],
                                       z=round(op["zlo"], 3), indoor=False, exterior=ext, width=round(op["width"], 2), mp_opening=op["id"], door_type=op.get("label"))
                G.add_node(nid, **door_nodes[nid])
            for n, d, wk in links:
                if G.has_edge(nid, n): continue
                l3 = math.dist((dn["x"], dn["y"], dn["z"]), (d["x"], d["y"], d["z"]))
                G.add_edge(nid, n, length=round(l3, 3), dz=round(abs(d["z"] - dn["z"]), 3), stairs=None, cross_floor=False, step_free=wk["maxstep"] <= 0.16,
                           pruned=None, source="door_hub", maxstep=wk["maxstep"], obst=wk["obst"])
                hub_edges += 1
    stats["door_hub_edges"] = hub_edges
    wall_by_id = {w["id"]: w for w in walls}; op_wall = {op["id"]: w for w in walls for op in w["ops"]}
    for nid, dn in door_nodes.items():
        w = op_wall.get(dn["mp_opening"]) or wall_by_id.get(dn["mp_opening"][4:].rsplit("_", 1)[0])
        ax, ay = w["a"]; bx, by = w["b"]; side = {}
        for n in G[nid]:
            d = G.nodes[n]
            if d["kind"] != "sweep": continue
            sg = 1 if (bx - ax) * (d["y"] - ay) - (by - ay) * (d["x"] - ax) > 0 else -1
            side.setdefault(sg, []).append(d["indoor"])
        ext = len(side) == 2 and any(all(not i for i in v) for v in side.values()) and any(any(v) for v in side.values())
        dead = len(side) < 2
        G.nodes[nid]["exterior"] = bool(ext); G.nodes[nid]["leads_to_unscanned"] = bool(dead)
        base = (dn.get("door_type") or "door").replace("door-", "").replace("opening-inferred", "inferred opening") or "door"
        G.nodes[nid]["label"] = ("Entrance" if ext else "Door") + " (" + base + ")" + (" – to unscanned area" if dead else "")
    stats["door_nodes"] = len(door_nodes); stats["entrance_nodes"] = sum(1 for n in door_nodes if G.nodes[n].get("exterior"))
    # ---------- OSM footways ----------
    osmd = ctx.read_json(ctx.w("osm_footways.json")) if ctx.w("osm_footways.json").exists() else {"elements": []}
    outdoor = [d for n, d in G.nodes(data=True) if d.get("kind") == "sweep" and not d["indoor"]]
    osm_stats = {"ways": 0, "nodes": 0, "edges": 0, "links": 0}
    if osmd.get("elements") and outdoor:
        zf = float(np.median([d["z"] for d in outdoor]))
        of = max(set(d["floor"] for d in outdoor), key=lambda F: sum(1 for d in outdoor if d["floor"] == F))
        V = np.load(ctx.w("mesh.npz"))["V"]; cx, cy = ((V.min(0) + V.max(0)) / 2)[:2]
        rad = float(ctx.cfg["osm"].get("footway_radius_m", 220)) * 0.75
        for e in osmd["elements"]:
            if e.get("type") != "way" or e.get("tags", {}).get("highway") not in ("footway", "path", "pedestrian", "steps"): continue
            pts = [(nd, G_.model(g_["lon"], g_["lat"])) for nd, g_ in zip(e["nodes"], e["geometry"])]
            pts = [(nd, p) for nd, p in pts if math.hypot(p[0] - cx, p[1] - cy) < rad]
            if len(pts) < 2: continue
            osm_stats["ways"] += 1
            for nd, p in pts:
                nid = "osm_%d" % nd
                if nid not in G:
                    G.add_node(nid, kind="osm", label="OSM " + (e["tags"].get("footway") or e["tags"]["highway"]), floor=of, x=float(p[0]), y=float(p[1]), z=zf, indoor=False, osm_id=nd)
                    osm_stats["nodes"] += 1
            for (n1, p1), (n2, p2) in zip(pts, pts[1:]):
                a_, b_ = "osm_%d" % n1, "osm_%d" % n2
                if a_ == b_ or G.has_edge(a_, b_): continue
                G.add_edge(a_, b_, length=round(float(math.dist(p1, p2)), 3), dz=0.0, stairs="steps" if e["tags"]["highway"] == "steps" else None, cross_floor=False,
                           step_free=e["tags"]["highway"] != "steps", pruned=None, source="osm", osm_way=e["id"],
                           osm_tags={k: v for k, v in e["tags"].items() if k in ("highway", "footway", "crossing", "kerb", "surface")})
                osm_stats["edges"] += 1
        osm_edges = [(u, w) for u, w, d in G.edges(data=True) if d.get("source") == "osm"]
        for n, d in list(G.nodes(data=True)):
            if d.get("kind") != "sweep" or d["indoor"]: continue
            p = Point(d["x"], d["y"]); best = None
            for u, w in osm_edges:
                if not G.has_edge(u, w): continue
                ls = LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[w]["x"], G.nodes[w]["y"])]); dd = ls.distance(p)
                if best is None or dd < best[0]: best = (dd, u, w, ls)
            if best and best[0] <= P.get("osm_link_max_m", 12):
                dd, u, w, ls = best; q = ls.interpolate(ls.project(p)); jid = "osmj_" + n[:8]
                G.add_node(jid, kind="osm", label="OSM junction", floor=of, x=q.x, y=q.y, z=float(d["z"]), indoor=False)
                ed = G.edges[u, w]; G.remove_edge(u, w); osm_edges += [(u, jid), (jid, w)]
                for a_ in (u, w):
                    G.add_edge(a_, jid, **{**ed, "length": round(math.dist((G.nodes[a_]["x"], G.nodes[a_]["y"]), (q.x, q.y)), 3)})
                G.add_edge(n, jid, length=round(dd, 3), dz=0.0, stairs=None, cross_floor=False, step_free=True, pruned=None, source="osm_link")
                osm_stats["links"] += 1
        comp = max(nx.connected_components(G), key=lambda c: len([x for x in c if G.nodes[x].get("kind") == "sweep"]))
        drop = [n for n in G if n not in comp and G.nodes[n].get("kind") == "osm"]; G.remove_nodes_from(drop); osm_stats["dropped_unconnected"] = len(drop)
    stats["osm"] = osm_stats
    # ---------- elevators (config only; no mesh auto-detect) ----------
    ELEVATORS, elev_edge_n = add_elevators(G, ctx.cfg.get("elevators"), log=ctx.log)
    stats["elevator_edges"] = elev_edge_n
    stats["final_nodes"] = G.number_of_nodes(); stats["final_edges"] = G.number_of_edges(); stats["components"] = nx.number_connected_components(G)
    stats["stair_edges"] = sum(1 for *_, d in G.edges(data=True) if d.get("stairs"))
    stats["step_free_edges"] = sum(1 for *_, d in G.edges(data=True) if d.get("step_free"))
    # ---------- walk grid (0.2 m) ----------
    GR = 0.2; gx0, gy0 = float(X0 + 0.1), float(Y0 + 0.2); gnx, gny = int((NX * VR - 0.4) / GR), int((NY * VR - 0.6) / GR)
    wg = {}
    for f in floors:
        F = f["id"]; zlo, zhi = f["z_band"]
        Z = np.full((gny, gnx), -32768, np.int16); W = np.zeros((gny, gnx), np.uint8)
        for j in range(gny):
            iy0 = int((gy0 + j * GR - Y0) / VR)
            for i in range(gnx):
                ix0 = int((gx0 + i * GR - X0) / VR)
                col = flo[iy0:iy0 + 2, ix0:ix0 + 2].any((0, 1)); k = np.flatnonzero(col)
                if not len(k): continue
                zs = Z0 + (k + 0.5) * VR; zs = zs[(zs > zlo) & (zs < zhi)]
                if not len(zs): continue
                zf = zs.min(); k0 = int((zf + 0.5 - Z0) / VR); k1 = int((zf + 1.8 - Z0) / VR)
                Z[j, i] = int(round(zf * 100)); W[j, i] = 0 if occ[iy0:iy0 + 2, ix0:ix0 + 2, k0:k1].any() else 1
        for w in walls:
            if w["floor"] != F: continue
            n = int(w["line"].length / 0.05) + 1
            for s in np.linspace(0, 1, n):
                if any(op["type"] == "doorway" and op["t0"] <= s <= op["t1"] for op in w["ops"]): continue
                x = w["a"][0] + (w["b"][0] - w["a"][0]) * s; y = w["a"][1] + (w["b"][1] - w["a"][1]) * s
                i = int((x - gx0) / GR); j = int((y - gy0) / GR)
                if 0 <= i < gnx and 0 <= j < gny: W[j, i] = 0
        for w in walls:
            if w["floor"] != F: continue
            for op in w["ops"]:
                if op["type"] != "doorway": continue
                for s in np.linspace(op["t0"], op["t1"], 12):
                    x = w["a"][0] + (w["b"][0] - w["a"][0]) * s; y = w["a"][1] + (w["b"][1] - w["a"][1]) * s
                    i = int((x - gx0) / GR); j = int((y - gy0) / GR)
                    if 0 <= i < gnx and 0 <= j < gny and Z[j, i] > -32768: W[j, i] = 1
        wg[F] = dict(walk=base64.b64encode(W.tobytes()).decode(), z_cm=base64.b64encode(Z.astype("<i2").tobytes()).decode(), walkable_cells=int(W.sum()))
    ctx.write_json(ctx.o("walkgrid.json"), dict(x0=gx0, y0=gy0, res=GR, nx=gnx, ny=gny, row_major="index=j*nx+i, i=(x-x0)/res, j=(y-y0)/res",
                   note="walk=1 if floor surface in band and no mesh within 0.5-1.8 m above it; MP walls burned in (doorways open). z_cm int16 LE, -32768=no floor", floors=wg), compact=True)
    # ---------- export ----------
    def node_out(n, d):
        o = {"id": n, **{k: v for k, v in d.items() if k not in ("rot",)}}; o["lonlat"] = ll(d["x"], d["y"])
        for k in ("x", "y", "z", "cam_z"):
            if k in o and o[k] is not None: o[k] = round(float(o[k]), 3)
        return o
    mid = ctx.cfg.get("matterport_model_id")
    ctx.write_json(ctx.o("mp_graph_raw.json"), {"source": f'Matterport GraphQL model(id:"{mid}").locations', "nodes": [node_out(n, d) for n, d in G0.nodes(data=True)],
                   "edges": [{"u": u, "v": w, **{k: v for k, v in edge_info[(u, w)].items() if k != "_doors"}} for u, w in G0.edges()]}, compact=True)
    nav = {"frame": "Matterport model frame = MatterPak OBJ frame (metres, Z up); node z = floor level under sweep, cam_z = camera",
           "floors": {f["id"]: {"mp_floor_id": f["mp_floor_id"], "label": f["label"]} for f in floors},
           "stairs": [{"id": s["id"], "name": s["name"], "bbox_model": [round(c, 3) for c in s["poly"].bounds], "floors": s.get("floors"), "source": s.get("source")} for s in STAIRS],
           "elevators": ELEVATORS,
           "cost_model": {"weight": "3D length (m)", "stair_penalty_m": 15, "walk_speed_mps": 1.2, "stair_extra_s_per_m_rise": 2.0,
                          "elevator_wait_m": ELEVATOR_WAIT_M, "elevator_per_floor_m": ELEVATOR_PER_FLOOR_M,
                          "elevator_wait_s": 20, "elevator_per_floor_s": 4},
           "stats": stats, "attribution": "Outdoor footways: (c) OpenStreetMap contributors, ODbL (via Overpass API)",
           "nodes": [node_out(n, d) for n, d in G.nodes(data=True)], "edges": [{"u": u, "v": w, **d} for u, w, d in G.edges(data=True)]}
    ctx.write_json(ctx.o("nav_graph.json"), nav, compact=True)
    ctx.write_json(ctx.o("mp_rooms_walls.json"), {
        "rooms": [{"id": r["id"], "floor": r["floor"], "label": r["label"], "classifications": r["cls"], "keywords": r["kw"], "area_m2": round(r["area"], 1),
                   "polygon_model": [[round(x, 3), round(y, 3)] for x, y in (r["poly"].exterior.coords if r["poly"].geom_type == "Polygon" else max(r["poly"].geoms, key=lambda p: p.area).exterior.coords)]} for r in rooms],
        "walls": [{"id": w["id"], "floor": w["floor"], "a": [round(c, 3) for c in w["a"]], "b": [round(c, 3) for c in w["b"]],
                   "openings": [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in op.items() if k != "center"} | {"center": [round(op["center"][0], 3), round(op["center"][1], 3)]} for op in w["ops"]]} for w in walls]}, compact=True)
    return {k: stats[k] for k in ("final_nodes", "final_edges", "components", "door_nodes", "entrance_nodes", "stair_edges", "elevator_edges")} | {"stairs": len(STAIRS), "elevators": len(ELEVATORS)}
