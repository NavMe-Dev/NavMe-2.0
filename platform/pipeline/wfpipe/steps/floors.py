"""Step floors: resolve floors (id, label, order, elevation, height, z bands) from Matterport floors +
sweep heights, with per-floor overrides from config.floors (edited in the admin floors editor).

  id         F1..Fn by Matterport floor sequence (stable ids used everywhere)
  elevation  model z of the finished floor (median sweep floor-anchor z of indoor sweeps)
  z_band     z range assigned to this floor for surfaces/walk grid  [lo, hi)
  wall_band  z range in which this floor's Matterport walls block movement"""
import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import polygonize, unary_union


def indoor_polys(m, flmap):
    out = {}
    for r in m["rooms"]:
        if not r.get("boundary") or not r["boundary"].get("edges") or "indoor" not in (r.get("keywords") or []):
            continue
        segs = [LineString([(v["position"]["x"], v["position"]["y"]) for v in e["vertices"]]) for e in r["boundary"]["edges"]]
        ps = list(polygonize(unary_union(segs)))
        if ps:
            out.setdefault(flmap[r["floor"]["id"]], []).append(unary_union(ps))
    return {k: unary_union(v) for k, v in out.items()}


def run(ctx):
    m = ctx.read_json(ctx.w("mp_model.json"))["data"]["model"]
    fl = sorted(m["floors"], key=lambda f: f["sequence"])
    flmap = {f["id"]: f"F{i+1}" for i, f in enumerate(fl)}
    ip = indoor_polys(m, flmap)
    elev = {}
    for f in fl:
        fid = flmap[f["id"]]
        locs = [l for l in m["locations"] if l["floor"] and l["floor"]["id"] == f["id"]]
        zs_in = [l["position"]["z"] for l in locs if fid in ip and ip[fid].contains(Point(l["position"]["x"], l["position"]["y"]))]
        zs = zs_in or [l["position"]["z"] for l in locs]
        elev[fid] = round(float(np.median(zs)), 2) if zs else 0.0
    ov = {o["id"]: o for o in ctx.cfg.get("floors") or [] if o.get("id")}
    out = []
    ids = [flmap[f["id"]] for f in fl]
    for i, f in enumerate(fl):
        fid = ids[i]; o = ov.get(fid, {})
        e = float(o.get("elevation", elev[fid]))
        out.append({"id": fid, "mp_floor_id": f["id"], "label": o.get("label") or f.get("label") or f"Floor {i+1}",
                    "short": o.get("short") or str(i + 1), "ordinal": int(o.get("ordinal", i)), "elevation": e,
                    "elevation_auto": elev[fid], "_o": o})
    for i, f in enumerate(out):
        e = f["elevation"]; o = f.pop("_o")
        nxt = out[i + 1]["elevation"] if i + 1 < len(out) else None
        prv = out[i - 1]["elevation"] if i > 0 else None
        f["height"] = float(o.get("height", round(nxt - e, 2) if nxt is not None else 3.1))
        f["z_band"] = o.get("z_band") or [round((prv + e) / 2, 2) if prv is not None else round(e - 1.3, 2),
                                          round((e + nxt) / 2, 2) if nxt is not None else round(e + 0.85, 2)]
        f["wall_band"] = o.get("wall_band") or [round(e - 1.2, 2) if i == 0 else round(e - 0.55, 2), round(e + f["height"] - 0.35, 2)]
    ctx.write_json(ctx.w("floors_resolved.json"), {"floors": out, "mp_floor_map": flmap})
    return {"floors": [(f["id"], f["label"], f["elevation"]) for f in out]}


def floor_of_z(floors, z):
    for f in floors:
        if f["z_band"][0] <= z < f["z_band"][1]:
            return f["id"]
    return min(floors, key=lambda f: abs(f["elevation"] - z))["id"]
