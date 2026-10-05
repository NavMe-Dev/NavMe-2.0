"""Step glb: decimated, vertex-coloured glTF models for the 3D view.
Colours come from the colour plans (floors) and a neutral shade (walls). The model is rotated to ENU
(glTF +X east, +Y up, -Z north) with origin at model (0,0,0); the viewer places it at georef origin.
Outputs model_full.glb (all floors) and model_<Fi>.glb for each lower floor (upper storeys cut away)."""
import math
import numpy as np, cv2, trimesh
from . import mesh as mesh_step
from .colorplan import load_plans, plan_mask, cp_map


def run(ctx):
    import fast_simplification
    V, F = mesh_step.load(ctx)
    gj = ctx.read_json(ctx.o("georef.json")); th = math.radians(gj["rotation_deg"])
    floors = ctx.floors()
    red = float(ctx.cfg["glb"].get("target_reduction", 0.72))
    Vd, Fd = fast_simplification.simplify(V.astype(np.float32), F.astype(np.int32), target_reduction=red)
    m = trimesh.Trimesh(Vd, Fd, process=True); Vd = m.vertices; Fd = m.faces; vn = m.vertex_normals
    Mf, _, _ = cp_map(ctx); names, ims = load_plans(ctx)
    bg = ims[0][20, 20].astype(int)
    H, W = ims[0].shape[:2]
    def to_px(P):
        q = (Mf[:, :2] @ P[:, :2].T).T + Mf[:, 2]
        return np.clip(q[:, 0].astype(int), 0, W - 1), np.clip(q[:, 1].astype(int), 0, H - 1)
    px, py = to_px(Vd)
    col = np.full((len(Vd), 3), 200)
    masks = [plan_mask(im, bg) for im in ims]
    covered = np.zeros(len(Vd), bool)
    for i, im in enumerate(ims):
        k = im[py, px].astype(int); ok = masks[i][py, px]
        zlo = floors[i]["z_band"][0] - 0.15 if i < len(floors) else -1e9
        use = ok & ((Vd[:, 2] > zlo) | ~covered) if i else ok
        col[use] = k[use][:, ::-1]; covered |= ok
    wall = np.abs(vn[:, 2]) < 0.6
    shade = (0.75 + 0.25 * np.abs(vn[:, 0]))[:, None]
    col[wall] = (np.array([225, 220, 210]) * shade[wall]).astype(int)
    col = (255 * ((np.clip(col, 0, 255) / 255.0) ** 2.2)).astype(np.uint8)   # glTF COLOR_0 is linear
    c, s = math.cos(th), math.sin(th)
    E = c * Vd[:, 0] - s * Vd[:, 1]; N = s * Vd[:, 0] + c * Vd[:, 1]; U = Vd[:, 2]

    def export(fmask, name):
        fm = Fd[fmask]; used = np.unique(fm); remap = -np.ones(len(Vd), int); remap[used] = np.arange(len(used))
        P = np.stack([E, U, -N], 1)[used]
        tm = trimesh.Trimesh(P, remap[fm], vertex_colors=np.hstack([col[used], np.full((len(used), 1), 255, np.uint8)]), process=False)
        tm.export(str(ctx.o(name))); return int(len(fm))
    files = {}; counts = {}
    counts["full"] = export(np.ones(len(Fd), bool), "model_full.glb")
    zc = Vd[Fd][:, :, 2].mean(1); cxy = Vd[Fd].mean(1); qx, qy = to_px(cxy)
    for i, f in enumerate(floors):
        if i == len(floors) - 1 or i >= len(masks):
            files[f["id"]] = "model_full.glb"; continue
        cut = floors[i + 1]["elevation"] - 0.45
        mk = cv2.dilate(cv2.morphologyEx(masks[i].astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9))), np.ones((61, 61)))
        name = f"model_{f['id']}.glb"
        counts[f["id"]] = export((zc < cut) | (mk[qy, qx] == 0), name); files[f["id"]] = name
    ctx.write_json(ctx.o("model_glb.json"), {"files": files, "default": "model_full.glb",
                                             "enu_axes": "glTF +X=east, +Y=up, -Z=north; origin=model (0,0,0)",
                                             "rotation_deg_baked": gj["rotation_deg"]})
    return {"faces": counts}
