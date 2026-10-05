"""Server-side nav-graph helpers: A* routing (same cost model as the viewer's routing.js),
nearest-node snapping, step-free reachability, georef transforms."""
import math
import networkx as nx
import numpy as np
from wfpipe.navmesh_route import route_on_mesh

R = 6378137.0


class GeoT:
    def __init__(self, georef):
        self.A = np.array(georef["model_to_epsg3857_affine"], float); self.Ai = np.linalg.inv(self.A[:, :2])

    def ll(self, x, y):
        X, Y = self.A[:, :2] @ np.array([x, y]) + self.A[:, 2]
        return math.degrees(X / R), math.degrees(math.atan(math.sinh(Y / R)))

    def model(self, lon, lat):
        X = math.radians(lon) * R; Y = R * math.asinh(math.tan(math.radians(lat)))
        x, y = self.Ai @ (np.array([X, Y]) - self.A[:, 2]); return float(x), float(y)


def build(nav, step_free=False):
    cm = nav.get("cost_model", {}); pen = cm.get("stair_penalty_m", 15)
    G = nx.Graph()
    for n in nav["nodes"]:
        G.add_node(n["id"], **{k: n.get(k) for k in ("x", "y", "z", "floor", "kind", "label", "lonlat")})
    for e in nav["edges"]:
        if step_free and not e.get("step_free"):
            continue
        # Elevator edges already embed wait+climb in length; do not add stair_penalty_m.
        w = e["length"] + (pen if e.get("stairs") else 0)
        G.add_edge(e["u"], e["v"], weight=w, length=e["length"], stairs=e.get("stairs"), dz=e.get("dz", 0),
                   source=e.get("source"), elevator=e.get("elevator"), floor_delta=e.get("floor_delta"),
                   step_free=e.get("step_free"))
    return G


def _is_elevator_edge(ed):
    return ed.get("source") == "elevator" or bool(ed.get("elevator"))


def _same_floor_runs(path, G):
    """Maximal consecutive index ranges of `path` that sit on the same floor."""
    runs = []
    i = 0
    while i < len(path):
        j = i
        floor = G.nodes[path[i]]["floor"]
        while j + 1 < len(path) and G.nodes[path[j + 1]]["floor"] == floor:
            j += 1
        runs.append((i, j, floor))
        i = j + 1
    return runs


def _hybrid_points(path, G, navmesh, geot):
    """Per-point {id, floor, lonlat} list for the path: each same-floor run is re-routed
    across that floor's navmesh (a continuous walkable surface, so the line flows through
    open space instead of snapping sweep-point to sweep-point) when the navmesh exists and
    actually connects the run's endpoints. Falls back to the original sweep-graph node
    sequence for that run otherwise — a real gap in scan coverage, or no navmesh for that
    floor — so routing never fails just because the mesh has a hole somewhere."""
    out = []
    for i, j, floor in _same_floor_runs(path, G):
        pts = [{"id": path[k], "x": G.nodes[path[k]]["x"], "y": G.nodes[path[k]]["y"],
                "lonlat": G.nodes[path[k]]["lonlat"]} for k in range(i, j + 1)]
        mesh = (navmesh or {}).get(floor)
        if mesh and j > i and geot is not None:
            start, end = (pts[0]["x"], pts[0]["y"]), (pts[-1]["x"], pts[-1]["y"])
            mesh_pts = route_on_mesh(mesh, start, end)
            if mesh_pts and len(mesh_pts) >= 2:
                mid = [{"id": None, "x": x, "y": y, "lonlat": list(geot.ll(x, y))} for x, y in mesh_pts[1:-1]]
                pts = [pts[0]] + mid + [pts[-1]]
        out.extend({**p, "floor": floor} for p in pts)
    return out


def route(nav, a, b, step_free=False, georef=None, navmesh=None):
    G = build(nav, step_free)
    if a not in G or b not in G:
        return None
    def h(u, v):
        p, q = G.nodes[u], G.nodes[v]; return math.dist((p["x"], p["y"], p["z"]), (q["x"], q["y"], q["z"]))
    try:
        path = nx.astar_path(G, a, b, heuristic=h, weight="weight")
    except nx.NetworkXNoPath:
        return None
    cm = nav.get("cost_model", {})
    wait_s = cm.get("elevator_wait_s", 20)
    per_floor_s = cm.get("elevator_per_floor_s", 4)
    length = walk_m = elev_secs = rise = 0.0
    stairs = elev_edges = 0
    for u, v in zip(path, path[1:]):
        ed = G.edges[u, v]
        length += ed["length"]
        if ed.get("stairs"):
            stairs += 1
            rise += ed["dz"] or 0
            walk_m += ed["length"]
        elif _is_elevator_edge(ed):
            elev_edges += 1
            fd = ed.get("floor_delta") or max(1, int(round(abs((ed.get("dz") or 0) / 3.0))) or 1)
            elev_secs += wait_s + per_floor_s * fd
        else:
            walk_m += ed["length"]
    secs = walk_m / cm.get("walk_speed_mps", 1.2) + rise * cm.get("stair_extra_s_per_m_rise", 2.0) + elev_secs
    geot = GeoT(georef) if georef else None
    hybrid = _hybrid_points(path, G, (navmesh or {}).get("floors"), geot)
    return {"nodes": path, "length_m": round(length, 1), "eta_s": round(secs), "stair_edges": stairs,
            "elevator_edges": elev_edges,
            "floors": list(dict.fromkeys(G.nodes[n]["floor"] for n in path)),
            "geometry": {"type": "LineString", "coordinates": [p["lonlat"] for p in hybrid]},
            "legs": [{"floor": p["floor"], "lonlat": p["lonlat"], "id": p["id"]} for p in hybrid]}


def nearest_node(nav, x, y, floor, kinds=("sweep",)):
    c = [n for n in nav["nodes"] if n["kind"] in kinds and n["floor"] == floor] or [n for n in nav["nodes"] if n["kind"] in kinds]
    n = min(c, key=lambda n: math.hypot(n["x"] - x, n["y"] - y))
    return n, math.hypot(n["x"] - x, n["y"] - y)


def step_free_reachable(nav, src):
    if not src:
        return set()
    G = build(nav, step_free=True)
    return nx.node_connected_component(G, src) if src in G else set()
