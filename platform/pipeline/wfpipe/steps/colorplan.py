"""Step colorplan: find the affine mapping model (x,y) -> colour-plan pixels.
Renders an orthographic top-down depth image of the mesh (5 cm/px), builds the union mask of all
colorplan_*.jpg (non-background pixels) and aligns the two with OpenCV ECC (affine)."""
import numpy as np, cv2
from . import mesh as mesh_step

RES = 0.05


def load_plans(ctx):
    man = ctx.read_json(ctx.w("matterpak_manifest.json"))
    ims = [cv2.imread(str(ctx.w("matterpak/" + n))) for n in man["colorplans"]]
    return man["colorplans"], ims


def plan_mask(im, bg=None, legend=(0.07, 0.12)):
    """Foreground mask of a colour plan (pixels differing from the background colour).
    The legend/scale-bar corner (bottom-left, fraction h,w) is ignored."""
    bg = im[20, 20].astype(int) if bg is None else bg
    m = np.abs(im.astype(int) - bg).sum(2) > 25
    h, w = m.shape
    m[int(h * (1 - legend[0])):, :int(w * legend[1])] = False
    return m


def composite(ims):
    """Upper floors drawn over lower ones -> (BGR composite, union mask)."""
    bg = ims[0][20, 20].astype(int)
    comp = ims[0].copy(); msk = plan_mask(ims[0], bg)
    for im in ims[1:]:
        m = plan_mask(im, bg); comp[m] = im[m]; msk |= m
    return comp, msk


def render_topdown(V, F, res=RES, pad=1.0):
    lo = V.min(0) - pad; hi = V.max(0) + pad
    x0, y1 = lo[0], hi[1]
    W = int((hi[0] - x0) / res); H = int((y1 - lo[1]) / res)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    zc = (a[:, 2] + b[:, 2] + c[:, 2]) / 3
    order = np.argsort(zc)
    P = np.stack([a, b, c], 1)[order]
    px = np.round((P[:, :, 0] - x0) / res * 16).astype(np.int32)
    py = np.round((y1 - P[:, :, 1]) / res * 16).astype(np.int32)
    z = np.full((H, W), -99, np.float32)
    for i in range(len(order)):
        cv2.fillConvexPoly(z, np.stack([px[i], py[i]], 1), float(zc[order[i]]), shift=4)
    return z, (float(x0), float(y1), res)


def run(ctx):
    V, F = mesh_step.load(ctx)
    names, ims = load_plans(ctx)
    if not ims:
        raise ValueError("no colour plans – cannot map colour plan to model")
    z, (x0, y1, res) = render_topdown(V, F)
    np.save(ctx.w("topdown_z.npy"), z)
    mm = (z > -50).astype(np.float32)
    H, W = mm.shape
    _, cpm = composite(ims)
    Hc, Wc = cpm.shape
    f0 = W / Wc
    cps = cv2.resize(cpm.astype(np.float32), (W, int(round(Hc * f0))), interpolation=cv2.INTER_AREA)
    cp2 = np.zeros_like(mm); h = min(H, cps.shape[0]); cp2[:h] = cps[:h]
    # init: bbox -> bbox (uniform scale)
    def bbox(m):
        ys, xs = np.where(m > 0.5); return xs.min(), ys.min(), xs.max(), ys.max()
    ra, ca = bbox(mm), bbox(cp2)
    s = ((ca[2] - ca[0]) / (ra[2] - ra[0]) + (ca[3] - ca[1]) / (ra[3] - ra[1])) / 2
    warp = np.array([[s, 0, (ca[0] + ca[2]) / 2 - s * (ra[0] + ra[2]) / 2],
                     [0, s, (ca[1] + ca[3]) / 2 - s * (ra[1] + ra[3]) / 2]], np.float32)
    a = cv2.GaussianBlur(mm, (0, 0), 3); b = cv2.GaussianBlur(cp2, (0, 0), 3)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 500, 1e-7)
    cc = None
    for ms, init in ((cv2.MOTION_AFFINE, warp), (cv2.MOTION_AFFINE, np.eye(2, 3, dtype=np.float32))):
        try:
            cc, warp2 = cv2.findTransformECC(a, b, init.copy(), ms, crit, None, 5)
            if cc > 0.8:
                warp = warp2; break
        except cv2.error as e:
            ctx.warn(f"ECC failed: {e}")
    if cc is None:
        raise RuntimeError("colour plan / mesh alignment failed")
    # model -> render px -> small cp px -> full cp px
    S = np.array([[1 / res, 0, -x0 / res], [0, -1 / res, y1 / res], [0, 0, 1]])
    M = np.vstack([warp.astype(float), [0, 0, 1]])
    Mf = (np.diag([1 / f0, 1 / f0, 1]) @ M @ S)[:2]
    sx = np.hypot(Mf[0, 0], Mf[1, 0]); sy = np.hypot(Mf[0, 1], Mf[1, 1])
    Mi = np.linalg.inv(np.vstack([Mf, [0, 0, 1]]))[:2]
    ov = np.dstack([a * 255, cv2.warpAffine(b, warp, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP) * 255, np.zeros_like(a)])
    cv2.imwrite(str(ctx.w("colorplan_match.png")), ov.astype(np.uint8))
    ctx.write_json(ctx.w("colorplan_map.json"), {
        "model_to_cp_px": Mf.tolist(), "cp_px_to_model": Mi.tolist(), "px_per_m": [sx, sy], "ecc_corr": float(cc),
        "size": [int(Wc), int(Hc)], "plans": names, "note": "cp px = A[:, :2] @ [x, y] + A[:, 2] (all plans share this frame)"})
    if cc < 0.95:
        ctx.warn(f"colour-plan alignment correlation only {cc:.3f} – check work/colorplan_match.png")
    return {"ecc_corr": round(float(cc), 4), "px_per_m": round(float((sx + sy) / 2), 3)}


def cp_map(ctx):
    d = ctx.read_json(ctx.w("colorplan_map.json"))
    return np.array(d["model_to_cp_px"]), np.array(d["cp_px_to_model"]), d
