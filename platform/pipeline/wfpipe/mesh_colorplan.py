"""Synthesize greyscale top-down colour-plan JPG(s) directly from mesh geometry, for
MatterPak sources with no real floor-plan photos (e.g. the Matterport Model API's
bare-mesh export — no .mtl/textures/colorplan_*.jpg, just OBJ geometry).

Mirrors wfpipe.e57_convert.render_colorplans (which does the same from a raw point
cloud) but bins mesh face centroids into floor bands and rasterizes triangle
footprints instead. Downstream steps (colorplan.py's ECC alignment, georef, floors)
only need *some* colour-plan image whose footprint matches the mesh's own top-down
render; since this one is derived from that exact mesh, alignment is close to
identity and should match cleanly. This does not recover true photographic colour
or enable Matterport-geocoordinate-based auto-georeference — just lets the pipeline
run through a MatterPak with no photos at all.
"""
from pathlib import Path

import numpy as np
import cv2

from .e57_convert import cluster_floors_z


def synthesize_colorplans(V, F, out_dir, res_m: float = 0.05, max_px: int = 4096, log=None) -> list[str]:
    log = log or (lambda m: None)
    out_dir = Path(out_dir)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    cz = (a[:, 2] + b[:, 2] + c[:, 2]) / 3.0
    bands = cluster_floors_z(cz)
    log(f"colorplan: no real colour plans – synthesizing {len(bands)} floor band(s) from mesh geometry")

    x0, y0 = float(V[:, 0].min()), float(V[:, 1].min())
    x1, y1 = float(V[:, 0].max()), float(V[:, 1].max())
    pad = max(0.5, 0.02 * max(x1 - x0, y1 - y0))
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    w_m, h_m = x1 - x0, y1 - y0
    res = max(res_m, w_m / max_px, h_m / max_px)
    nx = max(8, int(np.ceil(w_m / res)))
    ny = max(8, int(np.ceil(h_m / res)))

    names = []
    for fi, (z_lo, z_hi) in enumerate(bands):
        sel = (cz >= z_lo) & (cz <= z_hi)
        if sel.sum() < 1:
            continue
        img = np.full((ny, nx), 235, np.uint8)  # light background, matches MatterPak colorplan convention
        tri = np.stack([a[sel], b[sel], c[sel]], axis=1)
        px = np.round((tri[:, :, 0] - x0) / res).astype(np.int32)
        py = np.round((y1 - tri[:, :, 1]) / res).astype(np.int32)  # flip Y: row 0 = max Y
        shade = int(np.clip(170 - 15 * fi, 90, 200))
        for i in range(len(tri)):
            cv2.fillConvexPoly(img, np.stack([px[i], py[i]], 1), shade)
        name = f"colorplan_{fi:03d}.jpg"
        cv2.imwrite(str(out_dir / name), img)
        names.append(name)
        log(f"colorplan: wrote {name} ({nx}x{ny} @ {res:.3f} m/px, z={z_lo:.2f}..{z_hi:.2f})")
    return names
