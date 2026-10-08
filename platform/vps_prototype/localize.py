"""VPS localizer: MegaLoc retrieval -> SuperPoint+LightGlue matching -> 2D-3D -> PnP-RANSAC (pycolmap).
Multi-building: each Matterport model_id lives under data/models/{model_id}/ with db/, sky/, mesh.npz, sweeps.json, georef.json.
"""
import os, json, time, math, numpy as np, cv2, torch, pycolmap
from vpslib import *
from build_db import to_t, gdesc, megaloc
from lightglue import SuperPoint, LightGlue
torch.set_grad_enabled(False)

MODELS_ROOT = os.path.join(DATA, "models")

def model_dir(model_id: str) -> str:
    return os.path.join(MODELS_ROOT, model_id)

def list_models():
    if not os.path.isdir(MODELS_ROOT):
        return []
    return sorted(d for d in os.listdir(MODELS_ROOT) if os.path.isdir(os.path.join(MODELS_ROOT, d)))

def model_ready(model_id: str) -> bool:
    root = model_dir(model_id)
    return os.path.isfile(os.path.join(root, "db", "meta.json")) and os.path.isfile(os.path.join(root, "db", "global.npy"))

def _georef(root):
    path = os.path.join(root, "georef.json")
    if not os.path.isfile(path):
        # legacy fallback
        path = os.path.join(HERE, "..", "app", "data", "georef.json")
    g = json.load(open(path))
    return np.array(g["model_to_epsg3857_affine"]), g

def model_to_lonlat(x, y, A):
    X, Y = A[:, :2] @ np.array([x, y]) + A[:, 2]
    lon = X / 6378137.0 * 180 / math.pi
    lat = math.degrees(2 * math.atan(math.exp(Y / 6378137.0)) - math.pi / 2)
    return lat, lon

class Localizer:
    def __init__(self, model_id=None, max_query_kp=2048, topk=10, device="cpu"):
        self.model_id = model_id or os.environ.get("VPS_DEFAULT_MODEL", "Hn36TwktGgz")
        self.root = model_dir(self.model_id)
        if not model_ready(self.model_id):
            raise FileNotFoundError(f"VPS DB missing for {self.model_id} under {self.root}/db")
        DB = os.path.join(self.root, "db")
        sweeps_path = os.path.join(self.root, "sweeps.json")
        sweeps_doc = json.load(open(sweeps_path))
        self.meta = json.load(open(os.path.join(DB, "meta.json")))
        self.crops = self.meta["crops"]
        self.G = np.load(os.path.join(DB, "global.npy"))
        self.G /= np.linalg.norm(self.G, axis=1, keepdims=True)
        self.Kref = np.array(self.meta["K"])
        self.sweeps = {s["id"]: s for s in sweeps_doc["sweeps"]}
        self.floor_label = {f["id"]: f["label"] for f in sweeps_doc.get("floors", [])}
        self.feat = {}
        for sid in self.sweeps:
            z = dict(np.load(os.path.join(DB, f"{sid}.npz")))
            off = np.r_[0, np.cumsum(z["n"])]
            for v in range(len(z["n"])):
                a, b = off[v], off[v + 1]
                self.feat[(sid, v)] = (z["kp"][a:b], z["desc"][a:b], z["xyz"][a:b])
        self.sp = SuperPoint(max_num_keypoints=max_query_kp, detection_threshold=0.003).eval()
        self.lg = LightGlue(features="superpoint").eval()
        self.ml = megaloc()
        self.topk = topk
        self.A, g = _georef(self.root)
        self.rot_deg = g.get("rotation_deg", 0)

    def retrieve(self, img, exclude=(), k=None):
        g = gdesc(self.ml, img); g /= np.linalg.norm(g)
        sim = self.G @ g
        for i, c in enumerate(self.crops):
            if c['sweep'] in exclude: sim[i] = -9
        order = np.argsort(-sim)[:k or self.topk]
        return order, sim[order]

    def localize(self, img, hfov=None, exclude=(), max_side=1024, return_debug=False):
        """img: BGR uint8. hfov: horizontal FOV in degrees if known (else estimated). exclude: sweep ids to drop."""
        t0 = time.time(); tm = {}
        s = max_side / max(img.shape[:2])
        if s < 1: img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
        order, sims = self.retrieve(img, exclude); tm['retrieval'] = time.time() - t0
        t1 = time.time()
        fq = self.sp.extract(to_t(img))
        q = {'keypoints': fq['keypoints'], 'descriptors': fq['descriptors'], 'image_size': torch.tensor([[w, h]])}
        kq = fq['keypoints'][0].numpy()
        tm['extract'] = time.time() - t1; t1 = time.time()
        P2, P3, src = [], [], []
        for ci in order:
            c = self.crops[ci]
            kp, de, X = self.feat[(c['sweep'], c['view'])]
            r = {'keypoints': torch.from_numpy(kp)[None], 'descriptors': torch.from_numpy(de.astype(np.float32))[None],
                 'image_size': torch.tensor([[self.meta['W'], self.meta['H']]])}
            m = self.lg({'image0': q, 'image1': r})['matches'][0].numpy()
            if len(m) == 0: continue
            ok = np.isfinite(X[m[:, 1], 0])
            m = m[ok]
            P2.append(kq[m[:, 0]]); P3.append(X[m[:, 1]]); src += [ci] * len(m)
        tm['match'] = time.time() - t1; t1 = time.time()
        res = dict(success=False, retrieved=[self.crops[i]['sweep'] for i in order[:3]], n_matches=int(sum(len(p) for p in P2)))
        if res['n_matches'] < 12:
            res['time'] = time.time() - t0; res['timing'] = tm; return res
        P2 = np.concatenate(P2).astype(np.float64); P3 = np.concatenate(P3).astype(np.float64); src = np.array(src)
        thr = max(4.0, 8.0 * max(w, h) / 1024)
        def run(f, est_f=False):
            cam = pycolmap.Camera(model='SIMPLE_PINHOLE', width=w, height=h, params=[f, w / 2, h / 2])
            eo = pycolmap.AbsolutePoseEstimationOptions(); eo.ransac.max_error = thr; eo.estimate_focal_length = est_f
            eo.ransac.max_num_trials = 10000; eo.ransac.min_inlier_ratio = 0.01
            ro = pycolmap.AbsolutePoseRefinementOptions(); ro.refine_focal_length = est_f
            return pycolmap.estimate_and_refine_absolute_pose(P2, P3, cam, eo, ro), cam
        if hfov is not None:
            out, cam = run((w / 2) / math.tan(math.radians(hfov) / 2))
        else:  # unknown focal: grid search over FOV, keep best inlier count, then refine focal
            best = None
            for fov in [50, 60, 70, 80, 90, 100, 110, 120]:
                o, c = run((w / 2) / math.tan(math.radians(fov) / 2))
                if o is not None and (best is None or o['num_inliers'] > best[0]['num_inliers']): best = (o, c, fov)
            out, cam = (None, None) if best is None else run(best[1].params[0], est_f=True)
            if out is None and best is not None: out, cam = best[0], best[1]
        tm['pnp'] = time.time() - t1
        if out is None:
            res['time'] = time.time() - t0; res['timing'] = tm; return res
        cfw = out['cam_from_world']
        Rcw = cfw.rotation.matrix(); tcw = np.array(cfw.translation)
        R_wc = Rcw.T; C = -R_wc @ tcw
        inl = np.array(out['inlier_mask']); ninl = int(inl.sum())
        fwd = R_wc[:, 2]; yaw = math.degrees(math.atan2(fwd[1], fwd[0])); pitch = math.degrees(math.asin(np.clip(fwd[2], -1, 1)))
        heading = (90 - yaw - self.rot_deg) % 360  # compass bearing (deg from true north, clockwise)
        # floor: floor of the nearest sweep in 3D
        near = min(self.sweeps.values(), key=lambda s: np.linalg.norm(np.array([s['cam'][k] for k in 'xyz']) - C))
        lat, lon = model_to_lonlat(C[0], C[1], self.A)
        f_used = cam.params[0] if hasattr(cam, 'params') else None
        conf = float(1 - math.exp(-ninl / 40.0)) * float(min(1.0, inl.mean() / 0.25))
        best_src = np.bincount(src[inl]).argmax() if ninl else order[0]
        res.update(success=True, x=float(C[0]), y=float(C[1]), z=float(C[2]), floor=self.floor_label[near['floor']],
                   floor_id=near['floor'], nearest_sweep=near['index'], heading=float(heading), yaw_model=float(yaw),
                   pitch=float(pitch), lat=lat, lon=lon, inliers=ninl, inlier_ratio=float(inl.mean()), confidence=round(conf, 3),
                   hfov=float(2 * math.degrees(math.atan(w / 2 / out.get('camera', cam).params[0]))) if 'camera' in out else
                        float(2 * math.degrees(math.atan(w / 2 / cam.params[0]))),
                   R_wc=R_wc.tolist(), best_ref_sweep=self.crops[int(best_src)]['sweep_index'])
        res['time'] = time.time() - t0; res['timing'] = tm
        return res
