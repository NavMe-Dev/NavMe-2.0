"""Step voxel: occupancy + up-facing-surface voxel grid of the mesh (area-weighted surface sampling).
Used for clearance / step-height checks on nav edges and for the walk grid.

Default resolution is 10 cm. For large MatterPaks the grid/sample count is auto-scaled
so peak RAM stays manageable (target <= ~200M cells, <= ~12M surface samples).
Override with config.voxel.resolution / config.voxel.sample_density / config.voxel.max_samples.
"""
import numpy as np
from . import mesh as mesh_step


def run(ctx):
    V, F = mesh_step.load(ctx)
    cfg = ctx.cfg.get("voxel") or {}
    extent = V.max(0) - V.min(0)
    # cells at 0.1 m including 0.4 m padding on each axis
    cells_at_01 = float(np.prod(np.ceil((extent + 0.4) / 0.1)))
    target_cells = float(cfg.get("max_cells", 200_000_000))
    VR = float(cfg.get("resolution", 0.1))
    if "resolution" not in cfg and cells_at_01 > target_cells:
        # isotropic scale to hit target cell count
        VR = max(0.1, min(0.5, float(np.ceil(((cells_at_01 / target_cells) ** (1 / 3)) * 10) / 10 * 0.1)))
        # ensure we actually land under target
        while np.prod(np.ceil((extent + 0.4) / VR)) > target_cells and VR < 0.5:
            VR = round(VR + 0.05, 2)
    # density scales with 1/VR^2 so samples-per-cell stay roughly constant
    density = float(cfg.get("sample_density", 600.0 * (0.1 / VR) ** 2))
    max_samples = int(cfg.get("max_samples", 12_000_000))

    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a); ar = np.linalg.norm(n, axis=1) / 2; nz = n[:, 2] / (2 * ar + 1e-12)
    rng = np.random.default_rng(0)
    cnt = rng.poisson(ar * density) + 1
    total = int(cnt.sum())
    if total > max_samples:
        scale = max_samples / total
        cnt = np.maximum(1, np.round(cnt * scale).astype(np.int32))
        total = int(cnt.sum())
        ctx.warn(f"voxel sample cap: scaled density to ~{total} samples (VR={VR:.2f}m)")
    idx = np.repeat(np.arange(len(F)), cnt)
    r1 = rng.random(len(idx)); r2 = rng.random(len(idx)); s = np.sqrt(r1)
    P = (1 - s)[:, None] * a[idx] + (s * (1 - r2))[:, None] * b[idx] + (s * r2)[:, None] * c[idx]
    up = nz[idx] > 0.8
    del idx, r1, r2, s, a, b, c, n, ar, nz, cnt  # free before allocating grids
    lo, hi = V.min(0) - 0.2, V.max(0) + 0.2
    X0, Y0, Z0 = [float(np.floor(v / VR) * VR) for v in lo]
    NX, NY, NZ = [int(np.ceil((h - l) / VR)) for h, l in zip(hi, (X0, Y0, Z0))]
    ctx.log(f"voxel grid {[NX, NY, NZ]} VR={VR:.2f}m samples={len(P)} cells={NX*NY*NZ}")
    ix = ((P[:, 0] - X0) / VR).astype(np.int32); iy = ((P[:, 1] - Y0) / VR).astype(np.int32); iz = ((P[:, 2] - Z0) / VR).astype(np.int32)
    ok = (ix >= 0) & (ix < NX) & (iy >= 0) & (iy < NY) & (iz >= 0) & (iz < NZ)
    occ = np.zeros((NY, NX, NZ), np.uint8); flo = np.zeros((NY, NX, NZ), np.uint8)
    occ[iy[ok], ix[ok], iz[ok]] = 1
    o2 = ok & up; flo[iy[o2], ix[o2], iz[o2]] = 1
    del P, ix, iy, iz, ok, o2, up
    # graph.py historically treated these as bool; uint8 0/1 works the same for indexing/.any()
    np.savez_compressed(ctx.w("vox.npz"), occ=occ.astype(bool), flo=flo.astype(bool), meta=np.array([X0, Y0, Z0, VR]))
    return {"grid": [NX, NY, NZ], "samples": total, "vr": VR, "density": round(density, 1)}
