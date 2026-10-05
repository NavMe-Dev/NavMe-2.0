"""Step overlays: per-floor colour-plan overlays (transparent WebP + georeferenced corners) and
per-floor height grids (used to put a tapped map point at the right model Z)."""
import numpy as np, cv2
from .colorplan import load_plans, plan_mask, cp_map
from . import mesh as mesh_step


def run(ctx):
    G = ctx.georef(); floors = ctx.floors()
    Mf, Mi, cpd = cp_map(ctx)
    names, ims = load_plans(ctx)
    bg = ims[0][20, 20].astype(int)
    cp2m = lambda px, py: tuple((Mi[:, :2] @ np.array([px, py], float) + Mi[:, 2]).tolist())
    out = []
    for i, f in enumerate(floors):
        if i >= len(ims):
            ctx.warn(f"no colour plan for {f['id']}"); continue
        im = ims[i]
        m = plan_mask(im, bg).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3)))
        ys, xs = np.where(m)
        if not len(xs):
            continue
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        alpha = cv2.GaussianBlur(m.astype(np.float32) * 255, (0, 0), 1.5)
        rgba = np.dstack([im, alpha.astype(np.uint8)])[y0:y1, x0:x1]
        rgba = cv2.resize(rgba, (max(1, (x1 - x0) // 2), max(1, (y1 - y0) // 2)), interpolation=cv2.INTER_AREA)
        fn = f"floor_{f['id']}.webp"
        cv2.imwrite(str(ctx.o(fn)), rgba, [cv2.IMWRITE_WEBP_QUALITY, 88])
        corners = [cp2m(x0, y0), cp2m(x1, y0), cp2m(x1, y1), cp2m(x0, y1)]   # TL TR BR BL
        out.append({"id": f["id"], "image": fn, "colorplan": names[i],
                    "corners_model": [[round(a, 3), round(b, 3)] for a, b in corners],
                    "corners_lonlat": [G.ll(a, b) for a, b in corners]})
    # height grids
    V, F = mesh_step.load(ctx)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a); ar = np.linalg.norm(n, axis=1) / 2; nz = n[:, 2] / (2 * ar + 1e-12); cen = (a + b + c) / 3
    lo, hi = V.min(0), V.max(0)
    gr = 0.5; gx0, gy0 = float(np.floor(lo[0])), float(np.floor(lo[1]))
    NX = int(np.ceil((hi[0] - gx0) / gr)) + 1; NY = int(np.ceil((hi[1] - gy0) / gr)) + 1
    grids = {}
    for f in floors:
        zlo, zhi = f["z_band"]
        sel = (nz > 0.9) & (cen[:, 2] > zlo) & (cen[:, 2] < zhi)
        ix = ((cen[sel, 0] - gx0) / gr).astype(int); iy = ((cen[sel, 1] - gy0) / gr).astype(int)
        ok = (ix >= 0) & (ix < NX) & (iy >= 0) & (iy < NY)
        Gd = np.full((NY, NX), np.nan); zz = cen[sel, 2][ok]; ww = ar[sel][ok]; cell = iy[ok] * NX + ix[ok]
        o = np.lexsort((zz, cell)); cell, zz, ww = cell[o], zz[o], ww[o]
        if len(cell):
            bnd = np.flatnonzero(np.diff(cell)) + 1; st = np.r_[0, bnd]; en = np.r_[bnd, len(cell)]
            for s_, e_ in zip(st, en):
                w = ww[s_:e_]
                if w.sum() < 0.02: continue
                cw = np.cumsum(w) / w.sum(); Gd[cell[s_] // NX, cell[s_] % NX] = zz[s_:e_][np.searchsorted(cw, 0.25)]
        grids[f["id"]] = [[None if np.isnan(v) else round(float(v), 2) for v in row] for row in Gd]
    ctx.write_json(ctx.o("floors.json"), {"floors": out, "height_grid": {
        "x0": gx0, "y0": gy0, "res": gr, "nx": NX, "ny": NY,
        "note": "row=(y-y0)/res, col=(x-x0)/res; area-weighted 25th-percentile z of up-facing faces in the floor band",
        "grids": grids}}, compact=True)
    return {"overlays": len(out)}
