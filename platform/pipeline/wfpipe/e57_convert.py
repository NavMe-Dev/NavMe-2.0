"""Convert an ASTM E57 point cloud into MatterPak-like assets: model.obj + colorplan_*.jpg.

Uses pye57 for reading and (preferably) Open3D for voxel downsample + meshing.
Falls back to a pure-numpy 2.5D heightfield mesh if Open3D meshing fails.

Memory strategy: read scans one at a time, voxel-downsample early, never keep the
full raw cloud after downsample.
"""
from __future__ import annotations

import json
import math
import os
import shutil
from pathlib import Path

import numpy as np

# Optional heavy deps – raise a clear error at call sites if missing.
_HAS_PYE57 = False
_HAS_O3D = False
_PYE57_ERR = _O3D_ERR = None
try:
    import pye57 as _pye57
    _HAS_PYE57 = True
except Exception as e:  # pragma: no cover
    _PYE57_ERR = e
try:
    # Headless / no-GPU boxes often need CPU rendering stubs.
    os.environ.setdefault("OPEN3D_CPU_RENDERING", "true")
    import open3d as _o3d
    _HAS_O3D = True
except Exception as e:  # pragma: no cover
    _O3D_ERR = e


def require_libs():
    missing = []
    if not _HAS_PYE57:
        missing.append(f"pye57 (import error: {_PYE57_ERR})")
    if not _HAS_O3D:
        missing.append(f"open3d (import error: {_O3D_ERR})")
    if missing:
        raise RuntimeError(
            "E57 conversion requires: " + "; ".join(missing) +
            ". Install into the platform venv:  .venv/bin/pip install pye57 open3d"
            "  (and system libegl1 if open3d fails to import)."
        )


def find_e57(src: Path) -> Path:
    """Return the .e57 file to use: src itself, or the largest *.e57 in a directory."""
    src = Path(src)
    if src.is_file() and src.suffix.lower() == ".e57":
        return src
    if src.is_dir():
        cands = sorted(src.rglob("*.e57"), key=lambda p: p.stat().st_size, reverse=True)
        # Prefer exactly-one at top level; otherwise largest anywhere.
        top = [p for p in src.glob("*.e57")]
        if len(top) == 1:
            return top[0]
        if len(top) > 1:
            return max(top, key=lambda p: p.stat().st_size)
        if len(cands) == 1:
            return cands[0]
        if len(cands) > 1:
            return cands[0]
        raise ValueError(f"no .e57 file found in {src}")
    raise FileNotFoundError(f"E57 source not found: {src}")


def read_e57_points(path: Path, max_points: int = 8_000_000, log=None):
    """Read XYZ (+ optional RGB) from all scans. Returns (xyz float64 Nx3, rgb uint8 Nx3|None, meta)."""
    require_libs()
    path = Path(path)
    log = log or (lambda m: None)
    e57 = _pye57.E57(str(path))
    n_scans = e57.scan_count
    log(f"e57: {n_scans} scan(s) in {path.name}")
    chunks_xyz, chunks_rgb = [], []
    total = 0
    for i in range(n_scans):
        header = e57.get_header(i)
        # Prefer transformed cartesian (sensor → file frame).
        try:
            data = e57.read_scan(i, intensity=False, colors=True, ignore_missing_fields=True)
        except TypeError:
            # Older pye57 signatures.
            try:
                data = e57.read_scan(i, intensity=False, colors=True)
            except Exception:
                data = e57.read_scan_raw(i)
        # Keys vary: cartesianX/Y/Z or after transform.
        if "cartesianX" in data:
            xyz = np.column_stack([data["cartesianX"], data["cartesianY"], data["cartesianZ"]]).astype(np.float64)
        else:
            raise ValueError(f"scan {i}: no cartesianX/Y/Z fields")
        # Drop invalid / NaN.
        ok = np.isfinite(xyz).all(axis=1)
        xyz = xyz[ok]
        rgb = None
        if all(k in data for k in ("colorRed", "colorGreen", "colorBlue")):
            rgb = np.column_stack([data["colorRed"], data["colorGreen"], data["colorBlue"]])[ok]
            # Some files store 0–1 float.
            if rgb.dtype.kind == "f":
                rgb = np.clip(rgb * (255.0 if rgb.max() <= 1.5 else 1.0), 0, 255).astype(np.uint8)
            else:
                rgb = np.clip(rgb, 0, 255).astype(np.uint8)
        # Apply rigid transform from header if points are in sensor frame.
        try:
            R = np.asarray(header.rotation_matrix, dtype=np.float64).reshape(3, 3)
            t = np.asarray(header.translation, dtype=np.float64).reshape(3)
            if np.isfinite(R).all() and np.isfinite(t).all():
                # Identity check – skip if already world.
                if not (np.allclose(R, np.eye(3), atol=1e-6) and np.allclose(t, 0, atol=1e-6)):
                    xyz = (xyz @ R.T) + t
        except Exception:
            pass
        chunks_xyz.append(xyz)
        if rgb is not None:
            chunks_rgb.append(rgb)
        total += len(xyz)
        log(f"e57: scan {i}: {len(xyz):,} pts (running {total:,})")
        # Early downsample across scans if we're blowing the budget.
        if total > max_points * 2:
            break
    e57.close()
    if not chunks_xyz:
        raise ValueError("E57 contained no points")
    xyz = np.vstack(chunks_xyz)
    rgb = np.vstack(chunks_rgb) if chunks_rgb and len(chunks_rgb) == len(chunks_xyz) else None
    if len(xyz) > max_points:
        rng = np.random.default_rng(0)
        idx = rng.choice(len(xyz), size=max_points, replace=False)
        xyz = xyz[idx]
        if rgb is not None:
            rgb = rgb[idx]
        log(f"e57: randomly subsampled to {max_points:,} pts before voxel downsample")
    meta = {"scans": n_scans, "raw_points": int(total), "loaded_points": int(len(xyz)), "has_rgb": rgb is not None}
    return xyz, rgb, meta


def voxel_downsample(xyz, rgb=None, voxel=0.08, log=None):
    """Voxel grid downsample. Prefer Open3D; fallback to numpy hash."""
    log = log or (lambda m: None)
    if _HAS_O3D:
        pcd = _o3d.geometry.PointCloud()
        pcd.points = _o3d.utility.Vector3dVector(xyz)
        if rgb is not None:
            pcd.colors = _o3d.utility.Vector3dVector(rgb.astype(np.float64) / 255.0)
        pcd = pcd.voxel_down_sample(voxel_size=float(voxel))
        xyz_d = np.asarray(pcd.points)
        rgb_d = (np.asarray(pcd.colors) * 255).astype(np.uint8) if pcd.has_colors() else None
        log(f"e57: voxel {voxel} m → {len(xyz_d):,} pts (open3d)")
        return xyz_d, rgb_d
    # numpy fallback
    keys = np.floor(xyz / voxel).astype(np.int64)
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    n = int(inv.max()) + 1
    counts = np.bincount(inv)
    out = np.zeros((n, 3), dtype=np.float64)
    for c in range(3):
        out[:, c] = np.bincount(inv, weights=xyz[:, c]) / counts
    rgb_d = None
    if rgb is not None:
        rgb_d = np.zeros((n, 3), dtype=np.float64)
        for c in range(3):
            rgb_d[:, c] = np.bincount(inv, weights=rgb[:, c].astype(np.float64)) / counts
        rgb_d = np.clip(rgb_d, 0, 255).astype(np.uint8)
    log(f"e57: voxel {voxel} m → {len(out):,} pts (numpy)")
    return out, rgb_d


def cluster_floors_z(z, gap_m=0.6, min_frac=0.05):
    """Simple 1-D gap clustering on Z to split floors. Returns list of (z_lo, z_hi) bands."""
    z = np.asarray(z, dtype=np.float64)
    if len(z) < 50:
        return [(float(z.min()) - 0.1, float(z.max()) + 0.1)]
    zs = np.sort(z)
    # histogram
    bins = max(40, int((zs[-1] - zs[0]) / 0.05))
    hist, edges = np.histogram(zs, bins=bins)
    # smooth
    ker = np.ones(3) / 3
    sm = np.convolve(hist.astype(float), ker, mode="same")
    thr = sm.max() * 0.08
    active = sm >= thr
    bands = []
    i = 0
    while i < len(active):
        if not active[i]:
            i += 1
            continue
        j = i
        while j < len(active) and active[j]:
            j += 1
        # expand a little
        z_lo = edges[i]
        z_hi = edges[min(j, len(edges) - 1)]
        bands.append((float(z_lo), float(z_hi)))
        i = j
    # merge bands separated by < gap_m
    if not bands:
        return [(float(zs[0]) - 0.1, float(zs[-1]) + 0.1)]
    merged = [bands[0]]
    for b in bands[1:]:
        if b[0] - merged[-1][1] < gap_m:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(b)
    # drop tiny bands
    kept = []
    for lo, hi in merged:
        frac = ((z >= lo) & (z <= hi)).mean()
        if frac >= min_frac:
            kept.append((lo, hi))
    return kept or [(float(zs[0]) - 0.1, float(zs[-1]) + 0.1)]


def render_colorplans(xyz, rgb, out_dir: Path, res_m=0.05, max_px=4096, log=None):
    """Orthographic top-down rasters, one per floor band. Returns list of filenames."""
    log = log or (lambda m: None)
    out_dir = Path(out_dir)
    bands = cluster_floors_z(xyz[:, 2])
    log(f"e57: {len(bands)} floor band(s) for colour plans")
    x0, y0 = xyz[:, 0].min(), xyz[:, 1].min()
    x1, y1 = xyz[:, 0].max(), xyz[:, 1].max()
    # pad
    pad = max(0.5, 0.02 * max(x1 - x0, y1 - y0))
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    w_m, h_m = x1 - x0, y1 - y0
    # auto-res so neither dim exceeds max_px
    res = max(res_m, w_m / max_px, h_m / max_px)
    nx = max(8, int(math.ceil(w_m / res)))
    ny = max(8, int(math.ceil(h_m / res)))
    names = []
    # Use pillow via numpy → JPEG
    from PIL import Image
    for fi, (z_lo, z_hi) in enumerate(bands):
        # slight expand so floor slab is included
        mid = 0.5 * (z_lo + z_hi)
        # Prefer points near the floor of the band (lower 40%) for colourplan look.
        z_cut_hi = z_lo + 0.45 * (z_hi - z_lo) + 0.4
        mask = (xyz[:, 2] >= z_lo - 0.15) & (xyz[:, 2] <= max(z_cut_hi, mid))
        if mask.sum() < 20:
            mask = (xyz[:, 2] >= z_lo - 0.2) & (xyz[:, 2] <= z_hi + 0.2)
        pts = xyz[mask]
        cols = rgb[mask] if rgb is not None else None
        # Accumulate median-ish via running mean in bins (cheap).
        img = np.zeros((ny, nx, 3), dtype=np.float64)
        cnt = np.zeros((ny, nx), dtype=np.float64)
        ix = np.clip(((pts[:, 0] - x0) / res).astype(np.int32), 0, nx - 1)
        iy = np.clip(((pts[:, 1] - y0) / res).astype(np.int32), 0, ny - 1)
        # Flip Y so north-ish / MatterPak convention (image row 0 = max Y).
        iy_img = (ny - 1) - iy
        if cols is None:
            # intensity from height within band
            inten = np.clip((pts[:, 2] - z_lo) / max(1e-3, (z_hi - z_lo)) * 180 + 60, 0, 255)
            cols = np.stack([inten, inten, inten], axis=1)
        for c in range(3):
            img[:, :, c] += np.bincount(iy_img * nx + ix, weights=cols[:, c].astype(np.float64), minlength=nx * ny).reshape(ny, nx)
        cnt += np.bincount(iy_img * nx + ix, minlength=nx * ny).reshape(ny, nx)
        has = cnt > 0
        for c in range(3):
            img[:, :, c][has] /= cnt[has]
        # background light grey (MatterPak colourplans are light)
        out = np.full((ny, nx, 3), 235, dtype=np.uint8)
        out[has] = np.clip(img[has], 0, 255).astype(np.uint8)
        name = f"colorplan_{fi:03d}.jpg"
        Image.fromarray(out, "RGB").save(out_dir / name, quality=90)
        names.append(name)
        log(f"e57: wrote {name} ({nx}×{ny} @ {res:.3f} m, band z={z_lo:.2f}…{z_hi:.2f})")
    # sidecar with georef-ish extents in model metres (useful later)
    (out_dir / "colorplan_extents.json").write_text(json.dumps({
        "x0": x0, "y0": y0, "x1": x1, "y1": y1, "res_m": res, "bands": bands
    }, indent=1))
    return names, bands


def mesh_from_points(xyz, rgb=None, log=None):
    """Return (V, F, method). Prefer Open3D Poisson / Ball Pivoting; else 2.5D heightfield."""
    log = log or (lambda m: None)
    if _HAS_O3D and len(xyz) >= 200:
        pcd = _o3d.geometry.PointCloud()
        pcd.points = _o3d.utility.Vector3dVector(xyz)
        if rgb is not None:
            pcd.colors = _o3d.utility.Vector3dVector(rgb.astype(np.float64) / 255.0)
        pcd.estimate_normals(search_param=_o3d.geometry.KDTreeSearchParamHybrid(radius=0.4, max_nn=40))
        pcd.orient_normals_consistent_tangent_plane(30)
        # Poisson
        try:
            mesh, dens = _o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=8, linear_fit=True)
            dens = np.asarray(dens)
            if len(dens):
                thr = np.quantile(dens, 0.05)
                mesh.remove_vertices_by_mask(dens < thr)
            mesh.remove_degenerate_triangles()
            mesh.remove_duplicated_triangles()
            mesh.remove_duplicated_vertices()
            mesh.remove_non_manifold_edges()
            V = np.asarray(mesh.vertices)
            F = np.asarray(mesh.triangles)
            if len(F) >= 50:
                log(f"e57: Poisson mesh {len(V):,} V / {len(F):,} F")
                return V, F, "open3d_poisson"
        except Exception as e:
            log(f"e57: Poisson failed ({e}); trying Ball Pivoting")
        try:
            dists = pcd.compute_nearest_neighbor_distance()
            r = float(np.median(dists) or 0.1)
            radii = _o3d.utility.DoubleVector([r, r * 2, r * 4])
            mesh = _o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(pcd, radii)
            V = np.asarray(mesh.vertices)
            F = np.asarray(mesh.triangles)
            if len(F) >= 50:
                log(f"e57: Ball Pivoting mesh {len(V):,} V / {len(F):,} F")
                return V, F, "open3d_ball_pivoting"
        except Exception as e:
            log(f"e57: Ball Pivoting failed ({e}); using 2.5D heightfield")
    return heightfield_mesh(xyz, log=log)


def heightfield_mesh(xyz, cell=0.15, log=None):
    """2.5D mesh: grid of floor-height voxels + side walls at occupancy boundary. Always valid OBJ."""
    log = log or (lambda m: None)
    x0, y0 = xyz[:, 0].min(), xyz[:, 1].min()
    x1, y1 = xyz[:, 0].max(), xyz[:, 1].max()
    nx = max(4, int(math.ceil((x1 - x0) / cell)))
    ny = max(4, int(math.ceil((y1 - y0) / cell)))
    ix = np.clip(((xyz[:, 0] - x0) / cell).astype(np.int32), 0, nx - 1)
    iy = np.clip(((xyz[:, 1] - y0) / cell).astype(np.int32), 0, ny - 1)
    # lowest Z per cell ≈ floor
    floor_z = np.full((ny, nx), np.nan)
    ceil_z = np.full((ny, nx), np.nan)
    flat = iy * nx + ix
    order = np.argsort(xyz[:, 2])
    # fill floor with lowest, ceil with highest
    for i in order:
        r, c = iy[i], ix[i]
        if np.isnan(floor_z[r, c]):
            floor_z[r, c] = xyz[i, 2]
        ceil_z[r, c] = xyz[i, 2]
    occ = ~np.isnan(floor_z)
    # fill small holes with neighbour mean
    if occ.any():
        # default ceiling = floor + 2.8 if missing spread
        span = np.nanmedian(ceil_z[occ] - floor_z[occ])
        if not np.isfinite(span) or span < 0.5:
            span = 2.8
        ceil_z[occ & np.isnan(ceil_z)] = floor_z[occ & np.isnan(ceil_z)] + span
    verts = []
    faces = []
    vindex = {}

    def get_v(x, y, z):
        key = (round(x, 4), round(y, 4), round(z, 4))
        if key not in vindex:
            vindex[key] = len(verts)
            verts.append((x, y, z))
        return vindex[key]

    for r in range(ny):
        for c in range(nx):
            if not occ[r, c]:
                continue
            zf = float(floor_z[r, c])
            zc = float(ceil_z[r, c]) if np.isfinite(ceil_z[r, c]) else zf + 2.8
            xa, ya = x0 + c * cell, y0 + r * cell
            xb, yb = xa + cell, ya + cell
            # floor quad (CCW from above → normal +Z? Matterport Z-up; for floors we want upward)
            a = get_v(xa, ya, zf); b = get_v(xb, ya, zf); cc = get_v(xb, yb, zf); d = get_v(xa, yb, zf)
            faces.append((a, b, cc)); faces.append((a, cc, d))
            # ceiling
            a = get_v(xa, ya, zc); b = get_v(xb, ya, zc); cc = get_v(xb, yb, zc); d = get_v(xa, yb, zc)
            faces.append((a, cc, b)); faces.append((a, d, cc))
            # four sides
            neigh = [((r - 1, c), [(xa, ya, zf), (xb, ya, zf), (xb, ya, zc), (xa, ya, zc)]),
                     ((r + 1, c), [(xb, yb, zf), (xa, yb, zf), (xa, yb, zc), (xb, yb, zc)]),
                     ((r, c - 1), [(xa, yb, zf), (xa, ya, zf), (xa, ya, zc), (xa, yb, zc)]),
                     ((r, c + 1), [(xb, ya, zf), (xb, yb, zf), (xb, yb, zc), (xb, ya, zc)])]
            for (nr, nc), quad in neigh:
                outside = nr < 0 or nc < 0 or nr >= ny or nc >= nx or not occ[nr, nc]
                if outside:
                    i0 = get_v(*quad[0]); i1 = get_v(*quad[1]); i2 = get_v(*quad[2]); i3 = get_v(*quad[3])
                    faces.append((i0, i1, i2)); faces.append((i0, i2, i3))
    V = np.asarray(verts, dtype=np.float64)
    F = np.asarray(faces, dtype=np.int64)
    log(f"e57: heightfield mesh {len(V):,} V / {len(F):,} F (cell={cell} m)")
    return V, F, "heightfield_2p5d"


def write_obj(path: Path, V, F, mtl_name: str | None = None):
    path = Path(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write("# Generated by wfpipe e57_convert\n")
        if mtl_name:
            f.write(f"mtllib {mtl_name}\n")
        for v in V:
            f.write(f"v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}\n")
        if mtl_name:
            f.write("usemtl default\n")
        for tri in F:
            # OBJ is 1-indexed
            f.write(f"f {tri[0]+1} {tri[1]+1} {tri[2]+1}\n")


def convert_e57_to_matterpak(e57_path: Path, dst: Path, voxel: float = 0.08,
                             colorplan_res: float = 0.05, max_points: int = 8_000_000,
                             log=None, keep_source_link: bool = True) -> dict:
    """Full conversion: e57 → dst/model.obj + dst/colorplan_*.jpg + manifest fields.

    Copies/links the source to dst/source.e57. Returns dict for matterpak_manifest.
    """
    log = log or (lambda m: None)
    require_libs()
    e57_path = find_e57(e57_path)
    dst = Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    # Link or copy source
    target = dst / "source.e57"
    if target.exists() or target.is_symlink():
        target.unlink()
    if keep_source_link:
        try:
            os.link(e57_path, target)
        except OSError:
            try:
                target.symlink_to(e57_path.resolve())
            except OSError:
                shutil.copy2(e57_path, target)
    else:
        shutil.copy2(e57_path, target)

    xyz, rgb, meta = read_e57_points(e57_path, max_points=max_points, log=log)
    xyz, rgb = voxel_downsample(xyz, rgb, voxel=voxel, log=log)
    if len(xyz) < 50:
        raise ValueError("E57 produced too few points after downsample")

    names, bands = render_colorplans(xyz, rgb, dst, res_m=colorplan_res, log=log)
    V, F, method = mesh_from_points(xyz, rgb, log=log)
    if len(F) < 1:
        raise ValueError("E57 meshing produced no faces")
    write_obj(dst / "model.obj", V, F)
    obj_bytes = (dst / "model.obj").stat().st_size

    params = {
        "voxel_m": voxel,
        "colorplan_res_m": colorplan_res,
        "max_points": max_points,
        "mesh_method": method,
        "floor_bands": bands,
        "downsampled_points": int(len(xyz)),
        **meta,
    }
    manifest = {
        "source_format": "e57",
        "source_e57": "source.e57",
        "source_e57_bytes": e57_path.stat().st_size,
        "obj": "model.obj",
        "obj_bytes": obj_bytes,
        "colorplans": names,
        "textures": 0,
        "mtl": [],
        "cloud_xyz": False,
        "conversion": params,
    }
    return manifest


def libs_status() -> dict:
    return {
        "pye57": _HAS_PYE57,
        "open3d": _HAS_O3D,
        "pye57_error": str(_PYE57_ERR) if _PYE57_ERR else None,
        "open3d_error": str(_O3D_ERR) if _O3D_ERR else None,
    }
