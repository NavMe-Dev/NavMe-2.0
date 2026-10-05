"""Step georef: model frame -> Web Mercator (EPSG:3857) similarity transform.

Modes (config.georef.mode):
  auto            – rotation/scale/translation NCC search of the colour-plan composite against the
                    Esri imagery mosaic (coarse 2° at half-res, then fine 0.25° at full res), scale fixed to 1.
  control_points  – least-squares similarity (unit scale) from >=2 model<->WGS84 control points
                    (edited in the admin georef page).
  fixed           – use config.georef.affine (2x3) or config.georef.params {origin_lat, origin_lon, rotation_deg}.
Control points are always evaluated and residuals reported."""
import math, json
import numpy as np, cv2
from ..geo import merc, unmerc, fit_similarity, affine_from_complex, georef_from_control_points, affine_from_params, Georef
from .colorplan import load_plans, composite, cp_map
from .imagery import satpx2merc


def chans(im):
    im = im.astype(np.float32); b, g, r = im[..., 0], im[..., 1], im[..., 2]
    return [cv2.cvtColor(im.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32), 2 * g - r - b]


def rot_template(img, msk, ang, sc):
    Hs, Ws = img.shape[:2]
    R = cv2.getRotationMatrix2D((Ws / 2, Hs / 2), ang, sc)
    cos, sin = abs(R[0, 0]), abs(R[0, 1]); nW = int(Hs * sin + Ws * cos); nH = int(Hs * cos + Ws * sin)
    R[0, 2] += nW / 2 - Ws / 2; R[1, 2] += nH / 2 - Hs / 2
    return cv2.warpAffine(img, R, (nW, nH)), cv2.warpAffine(msk, R, (nW, nH), flags=cv2.INTER_NEAREST), R


def score(satC, t, tm):
    s = 0
    for sc_, tc in zip(satC, chans(t)):
        r = cv2.matchTemplate(sc_, tc, cv2.TM_CCOEFF_NORMED, mask=tm); r[~np.isfinite(r)] = -1; s = s + r
    s /= 2; _, mx, _, loc = cv2.minMaxLoc(s); return mx, loc


def auto_search(ctx):
    sat = cv2.imread(str(ctx.w("sat.png"))); j = ctx.read_json(ctx.w("sat.json"))
    Mf, _, cpd = cp_map(ctx)
    _, ims = load_plans(ctx); comp, msk = composite(ims)
    lat = j["center"][0]
    mpp = 2 * math.pi * 6378137.0 / (256 * 2 ** j["z"]) * math.cos(math.radians(lat))
    k = 1 / mpp                           # sat px per metre
    s_cp = float(np.mean(cpd["px_per_m"]))
    f = k / s_cp                          # cp px -> sat px
    Hs, Ws = int(comp.shape[0] * f), int(comp.shape[1] * f)
    compS = cv2.resize(comp, (Ws, Hs), interpolation=cv2.INTER_AREA)
    mskS = (cv2.resize(msk.astype(np.uint8) * 255, (Ws, Hs), interpolation=cv2.INTER_AREA) > 200).astype(np.uint8)
    mskS = cv2.erode(mskS, np.ones((5, 5)))
    # crop template to mask bbox (smaller = faster)
    ys, xs = np.where(mskS); cx0, cy0 = xs.min(), ys.min()
    compS = compS[cy0:ys.max() + 1, cx0:xs.max() + 1]; mskS = mskS[cy0:ys.max() + 1, cx0:xs.max() + 1]
    # coarse
    cs = 0.5
    satc = cv2.resize(sat, None, fx=cs, fy=cs, interpolation=cv2.INTER_AREA); satcC = chans(satc)
    tS = cv2.resize(compS, None, fx=cs, fy=cs, interpolation=cv2.INTER_AREA)
    mS = cv2.resize(mskS, (tS.shape[1], tS.shape[0]), interpolation=cv2.INTER_NEAREST)
    res = []
    for ang in np.arange(-180, 180, 2.0):
        t, tm, _ = rot_template(tS, mS, ang, 1.0)
        if t.shape[0] >= satc.shape[0] or t.shape[1] >= satc.shape[1]:
            raise RuntimeError("imagery window too small for the building – increase georef.search_radius_m")
        mx, loc = score(satcC, t, tm); res.append((mx, ang, loc))
    res.sort(reverse=True)
    ctx.log("coarse NCC top: " + ", ".join(f"{a:.0f}°:{m:.3f}" for m, a, _ in res[:4]))
    best = None
    for mx0, ang0, loc0 in res[:2]:
        t0, _, _ = rot_template(compS, mskS, ang0, 1.0)
        pad = 50; x0 = max(0, int(loc0[0] / cs) - pad); y0 = max(0, int(loc0[1] / cs) - pad)
        win = sat[y0:y0 + t0.shape[0] + 2 * pad + 40, x0:x0 + t0.shape[1] + 2 * pad + 40]; winC = chans(win)
        for sc_ in (0.97, 0.985, 1.0, 1.015, 1.03):
            for ang in np.arange(ang0 - 2.5, ang0 + 2.51, 0.25):
                t, tm, R = rot_template(compS, mskS, ang, sc_)
                if t.shape[0] >= win.shape[0] or t.shape[1] >= win.shape[1]:
                    continue
                mx, loc = score(winC, t, tm)
                if best is None or mx > best[0]:
                    best = (mx, ang, sc_, (loc[0] + x0, loc[1] + y0), R.copy())
    mx, ang, sc_, loc, R = best
    ctx.log(f"fine NCC {mx:.3f} at rot {ang:.2f}° scale {sc_:.3f}")
    A = np.vstack([Mf, [0, 0, 1]])
    Crop = np.array([[1, 0, -cx0], [0, 1, -cy0], [0, 0, 1]])
    M = np.array([[1, 0, loc[0]], [0, 1, loc[1]], [0, 0, 1]]) @ np.vstack([R, [0, 0, 1]]) @ Crop @ np.diag([f, f, 1.0]) @ A
    # model -> sat px -> 3857 on a grid of model points; fit similarity with unit ground scale
    V = np.load(ctx.w("mesh.npz"))["V"]; lo, hi = V.min(0), V.max(0)
    gx, gy = np.meshgrid(np.linspace(lo[0], hi[0], 8), np.linspace(lo[1], hi[1], 8))
    src = np.c_[gx.ravel(), gy.ravel()]
    sp = (M[:2, :2] @ src.T).T + M[:2, 2]
    dst = np.array([satpx2merc(j, *p) for p in sp])
    kf = 1 / math.cos(math.radians(lat))
    a_free, _ = fit_similarity(src, dst)
    a, b = fit_similarity(src, dst, kf)
    return affine_from_complex(a, b), {"ncc": round(float(mx), 4), "match_rotation_deg": float(ang), "match_scale": float(sc_),
                                       "free_scale": float(abs(a_free) / kf)}


def preview(ctx, A):
    """Colour-plan composite warped onto the imagery (work/georef_preview.jpg)."""
    try:
        sat = cv2.imread(str(ctx.w("sat.png"))); j = ctx.read_json(ctx.w("sat.json"))
    except Exception:
        return
    Mf, Mi, _ = cp_map(ctx); _, ims = load_plans(ctx); comp, msk = composite(ims)
    C = 2 * math.pi * 6378137.0; res = C / (256 * 2 ** j["z"])
    # 3857 -> sat px
    Ms = np.array([[1 / res, 0, (C / 2) / res - j["tx0"] * 256], [0, -1 / res, (C / 2) / res - j["ty0"] * 256], [0, 0, 1]])
    cp2sat = Ms @ np.vstack([A, [0, 0, 1]]) @ np.vstack([Mi, [0, 0, 1]])
    H, W = sat.shape[:2]
    wc = cv2.warpAffine(comp, cp2sat[:2], (W, H), flags=cv2.INTER_AREA)
    wm = cv2.warpAffine(msk.astype(np.uint8) * 255, cp2sat[:2], (W, H)) > 128
    o = sat.copy(); o[wm] = (0.45 * sat[wm] + 0.55 * wc[wm]).astype(np.uint8)
    cv2.imwrite(str(ctx.w("georef_preview.jpg")), o, [cv2.IMWRITE_JPEG_QUALITY, 85])


def run(ctx):
    g = ctx.cfg["georef"]; mode = g.get("mode", "auto")
    cps = [c for c in g.get("control_points") or [] if c.get("enabled", True)]
    info = {}
    if mode == "fixed":
        if g.get("affine"):
            A = g["affine"]
        else:
            p = g["params"]; A = affine_from_params(p["origin_lat"], p["origin_lon"], p["rotation_deg"], p.get("scale", 1.0))
        method = "fixed transform from configuration / admin fine-tune"
    elif mode == "control_points":
        if len(cps) < 2:
            raise ValueError("control_points mode needs >= 2 enabled control points")
        A, e, info = georef_from_control_points(cps, unit_scale=g.get("unit_scale", True))
        method = f"least-squares similarity from {len(cps)} control points (scale fixed to 1: Matterport is metric)"
    else:
        A, info = auto_search(ctx)
        method = ("auto: colour-plan composite matched to Esri World Imagery (NCC rotation/scale/translation search), "
                  "similarity with unit ground scale")
    G = Georef(A)
    out_cps = []
    errs = []
    for c in g.get("control_points") or []:
        X, Y = merc(c["wgs84"][1], c["wgs84"][0]); P = G.to_merc(*c["model_xy"])
        e = math.hypot(P[0] - X, P[1] - Y) * math.cos(math.radians(c["wgs84"][0]))
        out_cps.append({**c, "residual_m": round(e, 3)})
        if c.get("enabled", True): errs.append(e)
    olon, olat = unmerc(*G.A[:, 2])
    lat = olat; kf = 1 / math.cos(math.radians(lat))
    scale = math.hypot(G.A[0, 0], G.A[1, 0]) / kf
    th = G.rotation_deg
    gj = {"building": ctx.cfg.get("address") or ctx.cfg.get("name"), "matterport_model_id": ctx.cfg.get("matterport_model_id"),
          "mode": mode, "method": method, "model_units": "meters, right-handed, Z up",
          "model_to_epsg3857_affine": [list(map(float, r)) for r in G.A],
          "note_affine": "[X,Y]_3857 = A[:, :2] @ [x,y]_model + A[:, 2]. Includes the Mercator factor 1/cos(lat).",
          "rotation_deg": th, "scale": scale, "model_origin_wgs84": {"lat": olat, "lon": olon},
          "rms_m": float(np.sqrt(np.mean(np.square(errs)))) if errs else None, "max_err_m": float(max(errs)) if errs else None,
          "residual_note": "Residuals relative to control points (imagery-derived unless surveyed).",
          "auto": info if mode == "auto" else None, "fit": info if mode == "control_points" else None,
          "control_points": out_cps}
    ctx.write_json(ctx.o("georef.json"), gj)
    preview(ctx, G.A)
    r = {"mode": mode, "rotation_deg": round(th, 3), "origin": [round(olat, 7), round(olon, 7)]}
    if errs: r["cp_rms_m"] = round(gj["rms_m"], 3)
    if info.get("ncc"): r["ncc"] = info["ncc"]
    return r
