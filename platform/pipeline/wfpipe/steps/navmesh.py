"""Step navmesh: per-floor triangulated walkable-area mesh, for natural (non-sweep-snapped)
routing — a real continuous surface instead of the sparse Matterport sweep-point graph.

Built directly from the walk grid (work/walkgrid.json, written by the graph step): the same
0.2 m raster already used for line-of-sight path smoothing, with walls/doorways burned in.
Contoured into polygon(s), lightly simplified, then triangulated with GEOS's constrained
Delaunay triangulation (respects the polygon boundary/holes, unlike plain Delaunay).

Consumed at request time by wayfinding_api.services.navgraph (server-side routing) and by
the viewer's routing.js (client-side routing) — both run an A* search over triangle
adjacency, then the Simple Stupid Funnel Algorithm to pull a taut path through the portal
edges. This step only builds the mesh; the search lives in wfpipe/navmesh_route.py so the
pipeline and the API share one implementation.
"""
import base64

import cv2
import numpy as np
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon
from shapely.ops import unary_union

SIMPLIFY_TOL_M = 0.12
MIN_POLY_AREA_M2 = 1.0


def _floor_polygons(mask: np.ndarray, x0: float, y0: float, res: float) -> list:
    mask = (mask == 1).astype(np.uint8)
    # OPEN only (removes speckle noise) — no CLOSE: at this 0.2 m resolution a 5x5 CLOSE
    # bridges gaps up to ~1 m, which silently erases walls thinner than that and lets the
    # navmesh/funnel path cut straight through them. Correctness here matters more than
    # filling the odd single-cell gap (indoor.py's cosmetic walkway rendering can still
    # afford the more aggressive CLOSE; routing cannot).
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    for c in contours:
        if len(c) < 4:
            continue
        p = Polygon([(x0 + (pt[0][0] + 0.5) * res, y0 + (pt[0][1] + 0.5) * res) for pt in c]).buffer(0)
        if p.area > MIN_POLY_AREA_M2:
            polys.append(p)
    if not polys:
        return []
    merged = unary_union(polys).simplify(SIMPLIFY_TOL_M)
    return [p for p in (merged.geoms if hasattr(merged, "geoms") else [merged])
            if p.geom_type == "Polygon" and p.area > MIN_POLY_AREA_M2]


def _triangulate(polys: list) -> tuple:
    """-> (verts [[x,y],...], tris [[i,j,k],...]) with shared vertices deduped."""
    vert_index = {}
    verts = []

    def vid(x, y):
        key = (round(x, 3), round(y, 3))
        i = vert_index.get(key)
        if i is None:
            i = len(verts)
            vert_index[key] = i
            verts.append([key[0], key[1]])
        return i

    tris = []
    for poly in polys:
        try:
            tg = constrained_delaunay_triangles(poly)
        except Exception:
            continue
        for tri in (tg.geoms if hasattr(tg, "geoms") else [tg]):
            if tri.geom_type != "Polygon" or tri.is_empty:
                continue
            # constrained_delaunay_triangles covers the polygon's convex hull region too —
            # keep only triangles whose centroid actually falls inside the walkable polygon.
            if not poly.contains(tri.representative_point()):
                continue
            coords = list(tri.exterior.coords)[:3]
            if len(coords) != 3:
                continue
            tris.append([vid(x, y) for x, y in coords])
    return verts, tris


def run(ctx):
    wg = ctx.read_json(ctx.o("walkgrid.json"))
    x0, y0, res, nx_, ny_ = wg["x0"], wg["y0"], wg["res"], wg["nx"], wg["ny"]
    floors_out = {}
    tri_count = 0
    for fid, fd in wg["floors"].items():
        mask = np.frombuffer(base64.b64decode(fd["walk"]), np.uint8).reshape(ny_, nx_)
        polys = _floor_polygons(mask, x0, y0, res)
        if not polys:
            ctx.warn(f"navmesh: no walkable polygon for {fid} — that floor keeps sweep-graph routing")
            continue
        verts, tris = _triangulate(polys)
        if not tris:
            ctx.warn(f"navmesh: triangulation produced nothing for {fid}")
            continue
        floors_out[fid] = {"verts": verts, "tris": tris}
        tri_count += len(tris)
    ctx.write_json(ctx.o("navmesh.json"), {"floors": floors_out}, compact=True)
    return {"floors_with_navmesh": len(floors_out), "triangles": tri_count}
