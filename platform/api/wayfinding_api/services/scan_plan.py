"""Matterport scan planning: rasterize a floor drawing, place tripod points on a walkable grid, order a walk path, estimate duration."""
from __future__ import annotations
import csv, io, json, math, re, shutil, subprocess, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from shapely.geometry import Polygon
from shapely.ops import unary_union

# Defaults (Pro3-ish assumptions; editable in UI / generate body)
DEFAULTS = {
    "spacing_m": 2.0,
    "clearance_m": 0.5,
    "los_filter": True,
    "capture_s": 90.0,       # setup + capture per scan
    "walk_mps": 0.7,         # walking with tripod
    "overhead_s": 300.0,     # per floor overhead
    "resol_m": 0.10,         # occupancy raster resolution (m/px)
    "floor": "1",
}

MAX_RASTER_SIDE = 4000  # memory guard


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def plans_root(data_dir: Path) -> Path:
    d = Path(data_dir) / "scan_plans"
    d.mkdir(parents=True, exist_ok=True)
    return d


def plan_dir(data_dir: Path, plan_id: str) -> Path:
    return plans_root(data_dir) / plan_id


def load_meta(d: Path) -> dict:
    p = d / "meta.json"
    if not p.is_file():
        raise FileNotFoundError(d.name)
    return json.loads(p.read_text())


def save_meta(d: Path, meta: dict) -> None:
    meta["updated_at"] = _now()
    (d / "meta.json").write_text(json.dumps(meta, indent=2))


def plan_id_from_dir(d: Path) -> str:
    return d.name


def list_plans(data_dir: Path) -> list[dict]:
    out = []
    root = plans_root(data_dir)
    for p in sorted(root.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_dir() or not (p / "meta.json").is_file():
            continue
        m = load_meta(p)
        out.append(_summary(m))
    return out


def _summary(m: dict) -> dict:
    t = m.get("timing") or {}
    return {
        "id": m["id"],
        "name": m.get("name") or m["id"],
        "status": m.get("status", "new"),
        "source_kind": m.get("source_kind"),
        "n_points": len(m.get("points") or []),
        "total_s": t.get("total_s"),
        "created_at": m.get("created_at"),
        "updated_at": m.get("updated_at"),
    }


def create_plan(data_dir: Path, name: str) -> dict:
    pid = uuid.uuid4().hex[:12]
    d = plan_dir(data_dir, pid)
    d.mkdir(parents=True, exist_ok=False)
    meta = {
        "id": pid,
        "name": name.strip() or f"Scan plan {pid}",
        "status": "new",
        "created_at": _now(),
        "updated_at": _now(),
        "source_kind": None,
        "source_file": None,
        "preview": None,
        "image_w": None,
        "image_h": None,
        "scale": None,  # {mode, px_per_m, ...}
        "walkable": None,  # {mode, polygon_px?}
        "settings": dict(DEFAULTS),
        "points": [],
        "path_order": [],
        "timing": None,
        "notes": "",
    }
    save_meta(d, meta)
    return meta


def delete_plan(data_dir: Path, plan_id: str) -> None:
    d = plan_dir(data_dir, plan_id)
    if d.exists():
        shutil.rmtree(d)


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120] or "upload"


def ingest_upload(data_dir: Path, plan_id: str, filename: str, raw: bytes) -> dict:
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    ext = Path(filename).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".pdf", ".dxf"):
        raise ValueError("unsupported file type; use PNG/JPG/PDF/DXF")
    # wipe previous artefacts
    for old in d.iterdir():
        if old.name != "meta.json":
            if old.is_file():
                old.unlink()
            elif old.is_dir():
                shutil.rmtree(old)
    src_name = "source" + ext
    (d / src_name).write_bytes(raw)
    kind = {".png": "raster", ".jpg": "raster", ".jpeg": "raster", ".webp": "raster",
            ".pdf": "pdf", ".dxf": "dxf"}[ext]
    preview = d / "preview.png"
    if kind == "raster":
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        im = _downscale_if_huge(im)
        im.save(preview, "PNG")
    elif kind == "pdf":
        _pdf_to_png(d / src_name, preview)
    else:
        _dxf_to_png(d / src_name, preview)
    with Image.open(preview) as im:
        w, h = im.size
    meta.update({
        "status": "uploaded",
        "source_kind": kind,
        "source_file": src_name,
        "source_original_name": _safe_name(filename),
        "preview": "preview.png",
        "image_w": w,
        "image_h": h,
        "scale": None,
        "walkable": None,
        "points": [],
        "path_order": [],
        "timing": None,
    })
    save_meta(d, meta)
    return meta


def _downscale_if_huge(im: Image.Image) -> Image.Image:
    w, h = im.size
    m = max(w, h)
    if m <= MAX_RASTER_SIDE:
        return im
    s = MAX_RASTER_SIDE / m
    return im.resize((int(w * s), int(h * s)), Image.Resampling.LANCZOS)


def _pdf_to_png(pdf: Path, out: Path, dpi: int = 150) -> None:
    # Prefer poppler pdftoppm (available on this box).
    dest = out.with_suffix("")  # pdftoppm appends .png
    try:
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(dpi), "-f", "1", "-l", "1", "-singlefile", str(pdf), str(dest)],
            check=True, capture_output=True, timeout=120,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        raise RuntimeError(f"PDF rasterize failed (need poppler pdftoppm): {e}") from e
    if not out.is_file():
        raise RuntimeError("pdftoppm produced no preview.png")
    with Image.open(out) as im:
        im = _downscale_if_huge(im.convert("RGB"))
        im.save(out, "PNG")


def _dxf_to_png(dxf_path: Path, out: Path, pad: float = 0.05) -> None:
    import ezdxf
    from ezdxf import recover
    try:
        doc, _ = recover.readfile(str(dxf_path))
    except Exception:
        doc = ezdxf.readfile(str(dxf_path))
    msp = doc.modelspace()
    # Collect line segments + closed polygons for a simple wireframe render
    segs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    polys: list[list[tuple[float, float]]] = []

    def _add_lwpolyline(pts, closed):
        if len(pts) < 2:
            return
        for a, b in zip(pts, pts[1:]):
            segs.append((a, b))
        if closed and len(pts) >= 3:
            segs.append((pts[-1], pts[0]))
            polys.append(pts)

    for e in msp:
        t = e.dxftype()
        try:
            if t == "LINE":
                segs.append(((float(e.dxf.start.x), float(e.dxf.start.y)),
                             (float(e.dxf.end.x), float(e.dxf.end.y))))
            elif t == "LWPOLYLINE":
                pts = [(float(p[0]), float(p[1])) for p in e.get_points("xy")]
                _add_lwpolyline(pts, bool(e.closed))
            elif t == "POLYLINE":
                pts = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in e.vertices]
                _add_lwpolyline(pts, bool(e.is_closed))
            elif t == "CIRCLE":
                c, r = e.dxf.center, float(e.dxf.radius)
                n = 64
                pts = [(c.x + r * math.cos(2 * math.pi * i / n), c.y + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
                _add_lwpolyline(pts, True)
            elif t == "ARC":
                c = e.dxf.center
                r = float(e.dxf.radius)
                a0, a1 = math.radians(float(e.dxf.start_angle)), math.radians(float(e.dxf.end_angle))
                if a1 < a0:
                    a1 += 2 * math.pi
                n = max(8, int(32 * (a1 - a0) / (2 * math.pi)))
                pts = [(c.x + r * math.cos(a0 + (a1 - a0) * i / n),
                        c.y + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
                _add_lwpolyline(pts, False)
            elif t == "HATCH":
                for path in e.paths:
                    try:
                        verts = [(float(v[0]), float(v[1])) for v in path.vertices]
                        if len(verts) >= 3:
                            polys.append(verts)
                            _add_lwpolyline(verts, True)
                    except Exception:
                        pass
        except Exception:
            continue

    if not segs and not polys:
        # empty drawing → blank canvas
        Image.new("RGB", (800, 600), "white").save(out, "PNG")
        return

    xs = [p[0] for s in segs for p in s] + [p[0] for poly in polys for p in poly]
    ys = [p[1] for s in segs for p in s] + [p[1] for poly in polys for p in poly]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    dx, dy = max(maxx - minx, 1e-6), max(maxy - miny, 1e-6)
    # Store DXF bounds for scale mapping (drawing units → pixels)
    side = max(dx, dy)
    px = min(MAX_RASTER_SIDE, max(800, int(2000)))
    scale = px / side
    W = int(dx * scale * (1 + 2 * pad)) + 2
    H = int(dy * scale * (1 + 2 * pad)) + 2
    ox = minx - dx * pad
    oy = miny - dy * pad

    def to_px(x, y):
        return (int((x - ox) * scale), int(H - 1 - (y - oy) * scale))

    im = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(im)
    for poly in polys:
        if len(poly) >= 3:
            draw.polygon([to_px(*p) for p in poly], fill="#f0f4f8", outline="#333")
    for a, b in segs:
        draw.line([to_px(*a), to_px(*b)], fill="#222", width=2)
    im.save(out, "PNG")
    # Sidecar with DXF→pixel mapping so scale can use drawing units
    (out.parent / "dxf_bounds.json").write_text(json.dumps({
        "minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
        "ox": ox, "oy": oy, "scale_px_per_unit": scale, "W": W, "H": H, "pad": pad,
    }))


def set_scale(data_dir: Path, plan_id: str, body: dict) -> dict:
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not meta.get("preview"):
        raise ValueError("upload a drawing first")
    mode = body.get("mode") or "px_per_m"
    scale: dict[str, Any] = {"mode": mode}
    if mode == "px_per_m":
        ppm = float(body["px_per_m"])
        if ppm <= 0:
            raise ValueError("px_per_m must be > 0")
        scale["px_per_m"] = ppm
    elif mode == "line":
        # line in image pixels + known length in metres
        x1, y1, x2, y2 = map(float, (body["x1"], body["y1"], body["x2"], body["y2"]))
        meters = float(body["meters"])
        if meters <= 0:
            raise ValueError("meters must be > 0")
        dist_px = math.hypot(x2 - x1, y2 - y1)
        if dist_px < 1:
            raise ValueError("scale line too short")
        scale.update({"px_per_m": dist_px / meters, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "meters": meters})
    elif mode == "drawing_units":
        # DXF: 1 drawing unit = N metres (often 1 unit = 1 mm or 1 m)
        units_per_m = float(body.get("units_per_m") or body.get("drawing_units_per_m") or 1.0)
        if units_per_m <= 0:
            raise ValueError("units_per_m must be > 0")
        bounds = d / "dxf_bounds.json"
        if not bounds.is_file():
            raise ValueError("drawing_units scale requires a DXF source")
        b = json.loads(bounds.read_text())
        # px_per_unit * units_per_m = px_per_m
        scale["px_per_m"] = float(b["scale_px_per_unit"]) * units_per_m
        scale["units_per_m"] = units_per_m
    else:
        raise ValueError("mode must be px_per_m | line | drawing_units")
    meta["scale"] = scale
    meta["status"] = "scaled"
    save_meta(d, meta)
    return meta


def set_walkable(data_dir: Path, plan_id: str, body: dict) -> dict:
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not meta.get("preview"):
        raise ValueError("upload a drawing first")
    mode = body.get("mode") or "auto"
    walk: dict[str, Any] = {"mode": mode}
    if mode == "polygon":
        poly = body.get("polygon_px") or body.get("polygon")
        if not poly or len(poly) < 3:
            raise ValueError("polygon_px needs ≥3 [x,y] vertices in image pixels")
        walk["polygon_px"] = [[float(p[0]), float(p[1])] for p in poly]
    elif mode != "auto":
        raise ValueError("mode must be auto | polygon")
    meta["walkable"] = walk
    meta["status"] = "walkable"
    # Persist occupancy mask for generate / UI overlay
    mask = _build_occupancy(d, meta)
    Image.fromarray((mask * 255).astype(np.uint8), "L").save(d / "walkable.png")
    save_meta(d, meta)
    return meta


def _build_occupancy(d: Path, meta: dict) -> np.ndarray:
    """Boolean walkable mask at preview resolution (True = walkable)."""
    preview = Image.open(d / meta["preview"]).convert("L")
    w, h = preview.size
    arr = np.asarray(preview, dtype=np.float32)
    walk = meta.get("walkable") or {"mode": "auto"}
    mode = walk.get("mode", "auto")

    if mode == "polygon":
        mask = Image.new("L", (w, h), 0)
        pts = [(int(p[0]), int(p[1])) for p in walk["polygon_px"]]
        ImageDraw.Draw(mask).polygon(pts, fill=255)
        return np.asarray(mask) > 127

    # Auto: light floors / dark walls. Invert if the drawing is mostly dark.
    # Threshold via Otsu-ish (histogram valley) then morphological open.
    hist, _ = np.histogram(arr.ravel(), bins=256, range=(0, 256))
    total = arr.size
    sum_total = np.dot(np.arange(256), hist)
    sum_b, w_b, max_var, thresh = 0.0, 0.0, 0.0, 128
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_total - sum_b) / w_f
        var = w_b * w_f * (m_b - m_f) ** 2
        if var > max_var:
            max_var, thresh = var, t
    # Walkable = lighter side of threshold (typical CAD on white bg)
    binary = arr >= thresh
    # If majority is "wall", invert (dark-bg drawings)
    if binary.mean() < 0.35:
        binary = ~binary
    # Morphological open: erode then dilate via PIL Min/Max filters
    im = Image.fromarray((binary.astype(np.uint8) * 255), "L")
    im = im.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    im = im.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))  # close small gaps lightly
    binary = np.asarray(im) > 127

    # Prefer DXF closed polygons / hatches when available
    if meta.get("source_kind") == "dxf" and (d / "dxf_bounds.json").is_file():
        dxf_mask = _dxf_floor_mask(d, w, h)
        if dxf_mask is not None and dxf_mask.any():
            binary = dxf_mask
            return binary

    # Flood-fill exterior from image border so outdoor/page background is not walkable
    binary = _subtract_border_component(binary)
    return binary


def _subtract_border_component(walk: np.ndarray) -> np.ndarray:
    """Remove the walkable component(s) that touch the image border (page background)."""
    h, w = walk.shape
    if not walk.any():
        return walk
    from collections import deque
    seen = np.zeros_like(walk, dtype=bool)
    q: deque = deque()
    for x in range(w):
        for y in (0, h - 1):
            if walk[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if walk[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and walk[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((nx, ny))
    interior = walk & ~seen
    # If walls didn't seal (everything touched border), fall back to original
    if interior.mean() < 0.02:
        return walk
    return interior


def _dxf_floor_mask(d: Path, w: int, h: int) -> np.ndarray | None:
    """Largest closed loops / hatches from the DXF, painted into preview coords."""
    import ezdxf
    from ezdxf import recover
    src = next(d.glob("source.dxf"), None)
    if not src:
        return None
    try:
        doc, _ = recover.readfile(str(src))
    except Exception:
        try:
            doc = ezdxf.readfile(str(src))
        except Exception:
            return None
    bounds = json.loads((d / "dxf_bounds.json").read_text())
    ox, oy, sc = bounds["ox"], bounds["oy"], bounds["scale_px_per_unit"]
    H = bounds["H"]

    def to_px(x, y):
        return ((x - ox) * sc, H - 1 - (y - oy) * sc)

    polys = []
    for e in doc.modelspace():
        t = e.dxftype()
        try:
            if t == "LWPOLYLINE" and e.closed:
                pts = [to_px(float(p[0]), float(p[1])) for p in e.get_points("xy")]
                if len(pts) >= 3:
                    polys.append(Polygon(pts))
            elif t == "POLYLINE" and e.is_closed:
                pts = [to_px(float(v.dxf.location.x), float(v.dxf.location.y)) for v in e.vertices]
                if len(pts) >= 3:
                    polys.append(Polygon(pts))
            elif t == "HATCH":
                for path in e.paths:
                    try:
                        verts = [to_px(float(v[0]), float(v[1])) for v in path.vertices]
                        if len(verts) >= 3:
                            polys.append(Polygon(verts))
                    except Exception:
                        pass
        except Exception:
            continue
    polys = [p for p in polys if p.is_valid and p.area > 100]
    if not polys:
        return None
    # Use the largest polygon (and any nested islands that are large)
    polys.sort(key=lambda p: p.area, reverse=True)
    floor = polys[0]
    # Include other polys that are mostly inside floor? For first cut: just largest + similarly huge ones
    big = [floor] + [p for p in polys[1:] if p.area > floor.area * 0.25 and not floor.contains(p)]
    union = unary_union(big)
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    geoms = [union] if union.geom_type == "Polygon" else list(getattr(union, "geoms", []))
    for g in geoms:
        if g.is_empty or g.area < 50:
            continue
        coords = list(g.exterior.coords)
        draw.polygon([(int(x), int(y)) for x, y in coords], fill=255)
        for hole in g.interiors:
            draw.polygon([(int(x), int(y)) for x, y in hole.coords], fill=0)
    return np.asarray(mask) > 127


def generate(data_dir: Path, plan_id: str, body: dict | None = None) -> dict:
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not meta.get("scale") or not meta["scale"].get("px_per_m"):
        raise ValueError("set scale first")
    body = body or {}
    settings = dict(meta.get("settings") or DEFAULTS)
    for k in ("spacing_m", "clearance_m", "los_filter", "capture_s", "walk_mps", "overhead_s", "resol_m", "floor"):
        if k in body:
            settings[k] = body[k]
    spacing = float(settings["spacing_m"])
    clearance = float(settings["clearance_m"])
    if not (1.5 <= spacing <= 3.0):
        raise ValueError("spacing_m must be between 1.5 and 3.0")
    if clearance < 0:
        raise ValueError("clearance_m must be ≥ 0")

    if not meta.get("walkable"):
        meta["walkable"] = {"mode": "auto"}
    mask = _build_occupancy(d, meta)
    Image.fromarray((mask.astype(np.uint8) * 255), "L").save(d / "walkable.png")

    ppm = float(meta["scale"]["px_per_m"])  # preview pixels per metre
    # Work occupancy at ~resol_m; downsample preview mask
    resol = float(settings.get("resol_m") or 0.10)
    resol = max(0.05, min(0.25, resol))
    # preview m/px = 1/ppm; want grid where each cell ≈ resol metres
    step_px = max(1, int(round(resol * ppm)))
    occ = mask[::step_px, ::step_px]  # True = walkable
    # Wall distance: dilate inverted mask (walls) — approximate clearance
    clear_cells = max(1, int(round(clearance / resol)))
    walk = occ.copy()
    if clear_cells > 0 and walk.any():
        # erode walkable by clear_cells using max-filter on inverted
        inv = (~walk).astype(np.uint8) * 255
        im = Image.fromarray(inv, "L")
        # MaxFilter size must be odd
        k = clear_cells * 2 + 1
        # Cap kernel to avoid huge ops
        k = min(k, 51)
        if k >= 3:
            im = im.filter(ImageFilter.MaxFilter(k))
        near_wall = np.asarray(im) > 0
        walk = walk & ~near_wall

    # Grid candidates
    spacing_cells = max(1, int(round(spacing / resol)))
    h, w = walk.shape
    cands: list[tuple[float, float]] = []  # in metres (x right, y down from top-left of preview? use image coords: x right, y down)
    # Origin at top-left of preview; metres: x_m = px / ppm, y_m = px / ppm (y down)
    for r in range(spacing_cells // 2, h, spacing_cells):
        for c in range(spacing_cells // 2, w, spacing_cells):
            if walk[r, c]:
                px = (c + 0.5) * step_px
                py = (r + 0.5) * step_px
                cands.append((px / ppm, py / ppm, px, py))

    # Optional LOS filter: drop points with no clear ray to any neighbor within ~1.5*spacing
    if settings.get("los_filter", True) and len(cands) > 1:
        cands = _filter_los(cands, mask, ppm, spacing)

    # Order: nearest-neighbor TSP approx (networkx optional greedy)
    order_idx = _order_points([(p[0], p[1]) for p in cands])
    ordered = [cands[i] for i in order_idx]
    floor = str(settings.get("floor") or "1")
    points = []
    for i, (xm, ym, px, py) in enumerate(ordered):
        points.append({
            "id": f"S{i + 1}",
            "x_m": round(xm, 3),
            "y_m": round(ym, 3),
            "x_px": round(px, 1),
            "y_px": round(py, 1),
            "order": i + 1,
            "floor": floor,
        })

    path_len = 0.0
    for a, b in zip(points, points[1:]):
        path_len += math.hypot(b["x_m"] - a["x_m"], b["y_m"] - a["y_m"])

    capture_s = float(settings["capture_s"]) * len(points)
    walk_mps = float(settings["walk_mps"]) or 0.7
    travel_s = path_len / walk_mps if walk_mps > 0 else 0.0
    overhead_s = float(settings["overhead_s"])
    total_s = capture_s + travel_s + overhead_s
    timing = {
        "n_scans": len(points),
        "path_length_m": round(path_len, 2),
        "capture_s": round(capture_s, 1),
        "travel_s": round(travel_s, 1),
        "overhead_s": round(overhead_s, 1),
        "total_s": round(total_s, 1),
        "total_min": round(total_s / 60.0, 1),
        "assumptions": {
            "capture_s_per_scan": float(settings["capture_s"]),
            "walk_mps": walk_mps,
            "overhead_s": overhead_s,
            "spacing_m": spacing,
            "clearance_m": clearance,
            "note": "Pro3-ish defaults: ~90 s setup+capture per scan; 0.7 m/s walking with tripod; 5 min overhead per floor.",
        },
    }
    meta["settings"] = settings
    meta["points"] = points
    meta["path_order"] = [p["id"] for p in points]
    meta["timing"] = timing
    meta["status"] = "generated"
    save_meta(d, meta)
    _write_overlay(d, meta)
    return meta


def _filter_los(cands, mask: np.ndarray, ppm: float, spacing: float) -> list:
    """Keep points that have LOS to at least one other candidate within 1.75*spacing."""
    max_d = spacing * 1.75
    kept = []
    n = len(cands)
    for i, a in enumerate(cands):
        ok = False
        for j, b in enumerate(cands):
            if i == j:
                continue
            d = math.hypot(a[0] - b[0], a[1] - b[1])
            if d > max_d or d < 1e-6:
                continue
            if _ray_clear(mask, a[2], a[3], b[2], b[3]):
                ok = True
                break
        if ok:
            kept.append(a)
    # If filter wiped everything, fall back
    return kept if len(kept) >= max(1, n // 4) else cands


def _ray_clear(mask: np.ndarray, x0, y0, x1, y1) -> bool:
    """Bresenham-ish sample along segment; True if mostly walkable."""
    h, w = mask.shape
    n = max(2, int(math.hypot(x1 - x0, y1 - y0)))
    bad = 0
    for i in range(1, n):
        t = i / n
        x = int(x0 + (x1 - x0) * t)
        y = int(y0 + (y1 - y0) * t)
        if x < 0 or y < 0 or x >= w or y >= h or not mask[y, x]:
            bad += 1
            if bad > n * 0.15:
                return False
    return True


def _order_points(pts: list[tuple[float, float]]) -> list[int]:
    """Nearest-neighbor tour; 2-opt polish for small N."""
    n = len(pts)
    if n <= 1:
        return list(range(n))
    # Start at leftmost
    start = min(range(n), key=lambda i: (pts[i][0], pts[i][1]))
    remaining = set(range(n))
    remaining.remove(start)
    order = [start]
    cur = start
    while remaining:
        nxt = min(remaining, key=lambda j: (pts[cur][0] - pts[j][0]) ** 2 + (pts[cur][1] - pts[j][1]) ** 2)
        remaining.remove(nxt)
        order.append(nxt)
        cur = nxt
    if n <= 80:
        order = _two_opt(pts, order)
    return order


def _two_opt(pts, order):
    def length(ord_):
        return sum(math.hypot(pts[ord_[i]][0] - pts[ord_[i + 1]][0], pts[ord_[i]][1] - pts[ord_[i + 1]][1])
                   for i in range(len(ord_) - 1))

    improved = True
    best = order[:]
    best_len = length(best)
    guard = 0
    while improved and guard < 200:
        improved = False
        guard += 1
        for i in range(1, len(best) - 2):
            for j in range(i + 1, len(best)):
                if j - i == 1:
                    continue
                new = best[:i] + best[i:j][::-1] + best[j:]
                nl = length(new)
                if nl + 1e-9 < best_len:
                    best, best_len = new, nl
                    improved = True
                    break
            if improved:
                break
    return best


def update_points(data_dir: Path, plan_id: str, body: dict) -> dict:
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not meta.get("scale") or not meta["scale"].get("px_per_m"):
        raise ValueError("set scale first")
    ppm = float(meta["scale"]["px_per_m"])
    if "name" in body and body["name"]:
        meta["name"] = str(body["name"]).strip()
    pts_in = body.get("points") or []
    floor = str((meta.get("settings") or {}).get("floor") or "1")
    points = []
    for i, p in enumerate(pts_in):
        if "x_px" in p and "y_px" in p:
            x_px, y_px = float(p["x_px"]), float(p["y_px"])
            x_m, y_m = x_px / ppm, y_px / ppm
        else:
            x_m, y_m = float(p["x_m"]), float(p["y_m"])
            x_px, y_px = x_m * ppm, y_m * ppm
        points.append({
            "id": p.get("id") or f"S{i + 1}",
            "x_m": round(x_m, 3),
            "y_m": round(y_m, 3),
            "x_px": round(x_px, 1),
            "y_px": round(y_px, 1),
            "order": int(p.get("order") or i + 1),
            "floor": str(p.get("floor") or floor),
        })
    points.sort(key=lambda p: p["order"])
    for i, p in enumerate(points):
        p["order"] = i + 1
        if not p["id"]:
            p["id"] = f"S{i + 1}"

    # Recompute path / timing with current settings
    settings = dict(meta.get("settings") or DEFAULTS)
    if "capture_s" in body: settings["capture_s"] = body["capture_s"]
    if "walk_mps" in body: settings["walk_mps"] = body["walk_mps"]
    if "overhead_s" in body: settings["overhead_s"] = body["overhead_s"]
    path_len = 0.0
    for a, b in zip(points, points[1:]):
        path_len += math.hypot(b["x_m"] - a["x_m"], b["y_m"] - a["y_m"])
    capture_s = float(settings["capture_s"]) * len(points)
    walk_mps = float(settings["walk_mps"]) or 0.7
    travel_s = path_len / walk_mps if walk_mps > 0 else 0.0
    overhead_s = float(settings["overhead_s"])
    total_s = capture_s + travel_s + overhead_s
    meta["settings"] = settings
    meta["points"] = points
    meta["path_order"] = [p["id"] for p in points]
    meta["timing"] = {
        "n_scans": len(points),
        "path_length_m": round(path_len, 2),
        "capture_s": round(capture_s, 1),
        "travel_s": round(travel_s, 1),
        "overhead_s": round(overhead_s, 1),
        "total_s": round(total_s, 1),
        "total_min": round(total_s / 60.0, 1),
        "assumptions": {
            "capture_s_per_scan": float(settings["capture_s"]),
            "walk_mps": walk_mps,
            "overhead_s": overhead_s,
            "spacing_m": settings.get("spacing_m"),
            "clearance_m": settings.get("clearance_m"),
            "note": "Pro3-ish defaults: ~90 s setup+capture per scan; 0.7 m/s walking with tripod; 5 min overhead per floor.",
        },
    }
    meta["status"] = "edited" if points else meta.get("status", "scaled")
    save_meta(d, meta)
    _write_overlay(d, meta)
    return meta


def _write_overlay(d: Path, meta: dict) -> None:
    """Preview with numbered points + path for UI / PDF."""
    if not meta.get("preview"):
        return
    base = Image.open(d / meta["preview"]).convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    # walkable tint
    wp = d / "walkable.png"
    if wp.is_file():
        wimg = Image.open(wp).convert("L").resize(base.size, Image.Resampling.NEAREST)
        tint = Image.new("RGBA", base.size, (26, 115, 232, 0))
        alpha = wimg.point(lambda p: 50 if p > 127 else 0)
        tint.putalpha(alpha)
        overlay = Image.alpha_composite(overlay, tint)
        draw = ImageDraw.Draw(overlay)
    pts = meta.get("points") or []
    if len(pts) >= 2:
        xy = [(p["x_px"], p["y_px"]) for p in pts]
        draw.line(xy, fill=(234, 67, 53, 200), width=3)
    for p in pts:
        x, y = p["x_px"], p["y_px"]
        r = 8
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(26, 115, 232, 230), outline=(255, 255, 255, 255))
        label = p["id"]
        draw.text((x + 10, y - 8), label, fill=(32, 33, 36, 255))
    out = Image.alpha_composite(base, overlay).convert("RGB")
    out.save(d / "overlay.png", "PNG")


def export_csv(data_dir: Path, plan_id: str) -> tuple[str, bytes]:
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "x_m", "y_m", "order", "floor"])
    for p in meta.get("points") or []:
        w.writerow([p["id"], p["x_m"], p["y_m"], p["order"], p.get("floor", "1")])
    name = re.sub(r"[^A-Za-z0-9._-]", "_", meta.get("name") or plan_id)
    return f"{name}_scan_points.csv", buf.getvalue().encode()


def export_pdf(data_dir: Path, plan_id: str) -> tuple[str, bytes]:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader

    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not (d / "overlay.png").is_file():
        _write_overlay(d, meta)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    W, H = letter
    c.setFont("Helvetica-Bold", 16)
    c.drawString(0.75 * inch, H - 0.7 * inch, f"Matterport scan plan — {meta.get('name') or plan_id}")
    c.setFont("Helvetica", 9)
    c.drawString(0.75 * inch, H - 0.95 * inch, f"Plan id: {plan_id}  ·  Generated: {meta.get('updated_at', '')[:19]}")
    t = meta.get("timing") or {}
    assume = (t.get("assumptions") or {})
    y = H - 1.25 * inch
    lines = [
        f"Scans: {t.get('n_scans', 0)}   Path: {t.get('path_length_m', 0)} m   "
        f"Capture: {_fmt_s(t.get('capture_s'))}   Travel: {_fmt_s(t.get('travel_s'))}   "
        f"Overhead: {_fmt_s(t.get('overhead_s'))}   Total: {_fmt_s(t.get('total_s'))} ({t.get('total_min', 0)} min)",
        f"Assumptions: {assume.get('capture_s_per_scan', 90)} s/scan (setup+capture), "
        f"{assume.get('walk_mps', 0.7)} m/s walking with tripod, "
        f"{assume.get('overhead_s', 300)} s floor overhead; spacing {assume.get('spacing_m', 2.0)} m, "
        f"wall clearance {assume.get('clearance_m', 0.5)} m.",
        "First-cut tool — verify on site. Does not model furniture, multi-floor CAD stacks, or outdoor areas.",
    ]
    c.setFont("Helvetica", 8)
    for line in lines:
        c.drawString(0.75 * inch, y, line[:110])
        y -= 12
    img_path = d / "overlay.png"
    if img_path.is_file():
        img = ImageReader(str(img_path))
        # fit into remaining page
        max_w, max_h = W - 1.5 * inch, y - 0.75 * inch
        with Image.open(img_path) as im:
            iw, ih = im.size
        scale = min(max_w / iw, max_h / ih, 1.0)
        dw, dh = iw * scale, ih * scale
        c.drawImage(img, 0.75 * inch, y - dh, width=dw, height=dh, preserveAspectRatio=True, mask="auto")
    c.showPage()
    c.save()
    name = re.sub(r"[^A-Za-z0-9._-]", "_", meta.get("name") or plan_id)
    return f"{name}_scan_plan.pdf", buf.getvalue()


def _fmt_s(s) -> str:
    if s is None:
        return "—"
    s = float(s)
    if s < 60:
        return f"{s:.0f} s"
    return f"{int(s // 60)}m {int(s % 60)}s"


def get_plan(data_dir: Path, plan_id: str) -> dict:
    return load_meta(plan_dir(data_dir, plan_id))


# ── Address → OSM footprint → scale hint ─────────────────────────────────────

def apply_address_lookup(data_dir: Path, plan_id: str, body: dict, *, geocoder: str = "nominatim") -> dict:
    """Geocode address, fetch OSM footprints, save on meta. Returns {meta, candidates}."""
    from .address_footprint import AddressLookupError, lookup_near_address

    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    address = (body or {}).get("address") or meta.get("address")
    if not address:
        raise ValueError("address is required")
    provider = (body or {}).get("provider") or geocoder or "nominatim"
    radius_m = float((body or {}).get("radius_m") or 150)
    osm_id = (body or {}).get("osm_id")
    osm_type = (body or {}).get("osm_type")
    if osm_id is not None:
        osm_id = int(osm_id)

    # Re-select among already-fetched footprints without re-hitting Overpass
    if osm_id is not None and meta.get("footprints") and not (body or {}).get("refresh"):
        selected = _select_hint_from_saved(meta, osm_id, osm_type)
        if selected:
            meta["footprint_hint"] = selected
            # mark selected in feature collection
            fc = meta.get("footprints") or {}
            for f in fc.get("features") or []:
                props = f.setdefault("properties", {})
                props["selected"] = props.get("osm_id") == osm_id and (
                    osm_type is None or props.get("osm_type") == osm_type
                )
            save_meta(d, meta)
            return {"meta": meta, "candidates": _candidates_from_meta(meta)}

    try:
        result = lookup_near_address(
            address,
            provider=provider,
            radius_m=radius_m,
            osm_id=osm_id,
            osm_type=osm_type,
        )
    except AddressLookupError:
        raise
    meta["address"] = result["address"]
    meta["geocode"] = result["geocode"]
    meta["footprints"] = result["footprints"]
    meta["footprint_hint"] = result["footprint_hint"]
    save_meta(d, meta)
    return {"meta": meta, "candidates": result["candidates"]}


def _candidates_from_meta(meta: dict) -> list[dict]:
    out = []
    for f in (meta.get("footprints") or {}).get("features") or []:
        p = f.get("properties") or {}
        out.append({
            "osm_id": p.get("osm_id"),
            "osm_type": p.get("osm_type"),
            "osm_key": f.get("id") or f"{p.get('osm_type')}/{p.get('osm_id')}",
            "name": p.get("name"),
            "building": p.get("building"),
            "length_m": p.get("length_m"),
            "width_m": p.get("width_m"),
            "area_m2": p.get("area_m2"),
            "distance_m": p.get("distance_m"),
        })
    return out


def _select_hint_from_saved(meta: dict, osm_id: int, osm_type: str | None) -> dict | None:
    for f in (meta.get("footprints") or {}).get("features") or []:
        p = f.get("properties") or {}
        if p.get("osm_id") != osm_id:
            continue
        if osm_type is not None and p.get("osm_type") != osm_type:
            continue
        return {
            "length_m": p.get("length_m"),
            "width_m": p.get("width_m"),
            "area_m2": p.get("area_m2"),
            "osm_id": p.get("osm_id"),
            "osm_type": p.get("osm_type"),
            "osm_key": f.get("id"),
            "name": p.get("name"),
            "building": p.get("building"),
            "distance_m": p.get("distance_m"),
            "centroid": None,
        }
    return None



def _walkable_pixel_count(d: Path, meta: dict) -> tuple[int, np.ndarray]:
    """Return (walkable_px, mask) from walkable.png or by rebuilding occupancy."""
    wp = d / "walkable.png"
    if wp.is_file():
        mask = np.asarray(Image.open(wp).convert("L")) > 127
    else:
        mask = _build_occupancy(d, meta)
        Image.fromarray((mask.astype(np.uint8) * 255), "L").save(wp)
    return int(mask.sum()), mask


def _parse_area_from_notes(notes: str | None) -> float | None:
    """Best-effort parse of floor area from free-text notes (e.g. '4588 SQ. M.')."""
    if not notes:
        return None
    m = re.search(
        r"(\d+(?:[.,]\d+)?)\s*(?:sq\.?\s*m|m\s*2|m²|sqm|square\s*met)",
        notes,
        re.I,
    )
    if not m:
        return None
    return float(m.group(1).replace(",", ""))


def _scale_from_area(walkable_px: int, area_m2: float, *, source: str, **extra) -> dict:
    if area_m2 <= 0:
        raise ValueError("area_m2 must be > 0")
    if walkable_px < 100:
        raise ValueError("walkable mask too small to estimate scale from area")
    ppm = math.sqrt(walkable_px / area_m2)
    scale = {
        "mode": "auto_area",
        "px_per_m": ppm,
        "area_m2": float(area_m2),
        "walkable_px": int(walkable_px),
        "source": source,
        "approx": True,
        "note": "Area-based scale is approximate (±10–20%) vs a measured scale line.",
    }
    scale.update(extra)
    return scale


def _scale_from_footprint(mask: np.ndarray, hint: dict) -> dict | None:
    """Fit longer sides of walkable bbox to footprint length_m/width_m."""
    length_m = hint.get("length_m")
    width_m = hint.get("width_m")
    if not length_m or not width_m:
        return None
    length_m, width_m = float(length_m), float(width_m)
    if length_m <= 0 or width_m <= 0:
        return None
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    bbox_w = float(xs.max() - xs.min() + 1)
    bbox_h = float(ys.max() - ys.min() + 1)
    longer_px = max(bbox_w, bbox_h)
    shorter_px = min(bbox_w, bbox_h)
    longer_m = max(length_m, width_m)
    shorter_m = min(length_m, width_m)
    ppm = longer_px / longer_m
    return {
        "mode": "auto_footprint",
        "px_per_m": ppm,
        "bbox_px": [bbox_w, bbox_h],
        "footprint_m": [length_m, width_m],
        "longer_px": longer_px,
        "longer_m": longer_m,
        "shorter_px": shorter_px,
        "shorter_m": shorter_m,
        "osm_id": hint.get("osm_id"),
        "osm_type": hint.get("osm_type"),
        "source": "footprint_hint",
        "approx": True,
        "note": "Footprint-fit scale is approximate (±10–20%) vs a measured scale line.",
    }


def auto_generate(data_dir: Path, plan_id: str, body: dict | None = None) -> dict:
    """Estimate scale when unknown, then generate Pro3 scan points.

    Scale resolution order:
      a) body.px_per_m
      b) body.area_m2 (or area parsed from meta.notes) + walkable pixel count
      c) footprint_hint length/width + walkable bbox (fit longer sides)
      d) existing scale (keep)
      e) body.assume_area_m2 or meta.area_m2
      f) refuse — ask for address lookup or area_m2

    If scale is already set and points exist, body.confirm must be true to overwrite.
    """
    body = body or {}
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not meta.get("preview") or not (d / meta["preview"]).is_file():
        raise ValueError("upload a drawing first")

    has_scale = bool(meta.get("scale") and meta["scale"].get("px_per_m"))
    has_points = bool(meta.get("points"))
    if has_scale and has_points and not body.get("confirm"):
        raise ValueError(
            "plan already has scale and scan points — pass confirm=true to overwrite"
        )

    # Ensure walkable mask
    if not meta.get("walkable") or not (d / "walkable.png").is_file():
        meta = set_walkable(data_dir, plan_id, {"mode": "auto"})
    walkable_px, mask = _walkable_pixel_count(d, meta)

    scale: dict | None = None
    method = None

    # a) explicit px_per_m
    if body.get("px_per_m") is not None:
        ppm = float(body["px_per_m"])
        if ppm <= 0:
            raise ValueError("px_per_m must be > 0")
        scale = {
            "mode": "px_per_m",
            "px_per_m": ppm,
            "source": "body.px_per_m",
            "approx": False,
        }
        method = "px_per_m"

    # b) body.area_m2 or notes
    if scale is None:
        area = body.get("area_m2")
        src = "body.area_m2"
        if area is None:
            area = _parse_area_from_notes(meta.get("notes"))
            src = "notes"
        if area is not None:
            scale = _scale_from_area(walkable_px, float(area), source=src)
            method = "auto_area"
            meta["area_m2"] = float(area)

    # c) footprint hint + walkable bbox
    if scale is None:
        hint = meta.get("footprint_hint") or {}
        cand = _scale_from_footprint(mask, hint)
        if cand is not None:
            scale = cand
            method = "auto_footprint"
            if hint.get("area_m2") and not meta.get("area_m2"):
                meta["area_m2"] = float(hint["area_m2"])

    # d) keep existing scale
    if scale is None and has_scale:
        scale = dict(meta["scale"])
        method = scale.get("mode") or "existing"
        # still regenerate points below

    # e) assume_area_m2 or meta.area_m2
    if scale is None:
        area = body.get("assume_area_m2")
        src = "body.assume_area_m2"
        if area is None and meta.get("area_m2") is not None:
            area = meta.get("area_m2")
            src = "meta.area_m2"
        if area is not None:
            scale = _scale_from_area(walkable_px, float(area), source=src)
            method = "auto_area"
            meta["area_m2"] = float(area)

    # f) refuse
    if scale is None:
        raise ValueError(
            "cannot estimate scale: provide area_m2 (floor area annotation), "
            "look up an address for an OSM footprint hint, or set a measured scale line / px_per_m"
        )

    meta["scale"] = scale
    meta["status"] = "scaled"
    # Persist area on meta when we know it
    if scale.get("area_m2") is not None:
        meta["area_m2"] = float(scale["area_m2"])
    save_meta(d, meta)

    # Generate with Pro3 defaults; allow spacing/clearance overrides
    gen_body = {}
    for k in ("spacing_m", "clearance_m", "los_filter", "capture_s", "walk_mps",
              "overhead_s", "resol_m", "floor"):
        if k in body:
            gen_body[k] = body[k]
    meta = generate(data_dir, plan_id, gen_body)
    meta["auto_generate"] = {
        "method": method,
        "px_per_m": meta["scale"].get("px_per_m"),
        "scale_mode": meta["scale"].get("mode"),
        "source": meta["scale"].get("source"),
    }
    save_meta(d, meta)
    return meta


def apply_scale_hint(data_dir: Path, plan_id: str, body: dict) -> dict:
    """Apply footprint long/short/custom metres to an existing scale line (or refuse if none).

    body: {
      edge: "long" | "short" | "custom",
      meters?: float,          # required when edge=custom
      x1,y1,x2,y2?: float,     # scale line in image px; else use body line or fail
      confirm?: bool,          # required True if plan already has a scale
    }
    """
    d = plan_dir(data_dir, plan_id)
    meta = load_meta(d)
    if not meta.get("preview"):
        raise ValueError("upload a drawing first")
    hint = meta.get("footprint_hint")
    edge = (body or {}).get("edge") or "long"
    if edge == "long":
        if not hint or not hint.get("length_m"):
            raise ValueError("no footprint hint — look up an address first")
        meters = float(hint["length_m"])
    elif edge == "short":
        if not hint or not hint.get("width_m"):
            raise ValueError("no footprint hint — look up an address first")
        meters = float(hint["width_m"])
    elif edge == "custom":
        meters = float((body or {}).get("meters") or 0)
        if meters <= 0:
            raise ValueError("meters must be > 0 for custom edge")
    else:
        raise ValueError("edge must be long | short | custom")

    if meta.get("scale") and not (body or {}).get("confirm"):
        raise ValueError(
            "plan already has a scale — pass confirm=true to overwrite, or clear scale first"
        )

    coords = body or {}
    if all(k in coords for k in ("x1", "y1", "x2", "y2")):
        line = {k: float(coords[k]) for k in ("x1", "y1", "x2", "y2")}
    else:
        raise ValueError(
            "draw a scale line first (provide x1,y1,x2,y2 matching the footprint edge on the plan)"
        )

    meta = set_scale(data_dir, plan_id, {
        "mode": "line",
        "meters": meters,
        **line,
    })
    # Stamp provenance on the saved scale (set_scale only keeps known fields)
    if meta.get("scale") is not None:
        meta["scale"]["from_footprint_hint"] = {
            "edge": edge,
            "osm_id": (hint or {}).get("osm_id"),
            "meters": meters,
        }
        save_meta(d, meta)
    return meta
