"""Build the VPS reference database from Matterport 2k skyboxes.
For each sweep: render perspective crops (known pose), extract SuperPoint keypoints, lift them to 3D by
raycasting the MatterPak mesh, and compute a MegaLoc global descriptor per crop."""
import os, json, time, numpy as np, cv2, torch
from vpslib import *
from lightglue import SuperPoint
torch.set_grad_enabled(False)
# Multi-model: VPS_DATA points at data/models/{id}
if os.environ.get("VPS_DATA"):
    DATA = os.environ["VPS_DATA"]  # override vpslib.DATA for this process
    import vpslib as _v; _v.DATA = DATA
OUT = os.path.join(DATA, 'db'); os.makedirs(OUT, exist_ok=True); os.makedirs(os.path.join(OUT, 'crops'), exist_ok=True)
W, H, HFOV = 640, 480, 75
if os.environ.get("VPS_VIEWS_FAST"):
    VIEWS = [(y, 0) for y in range(0, 360, 45)] + [(0, -25), (180, -25), (0, 25), (180, 25)]
else:
    VIEWS = [(y, 0) for y in range(0, 360, 30)] + [(y, -30) for y in range(0, 360, 60)] + [(y + 30, 25) for y in range(0, 360, 90)]
MAXKP = 1024
def to_t(img): return torch.from_numpy(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float()[None] / 255
def megaloc():
    return torch.hub.load("gmberton/MegaLoc", "get_trained_model", trust_repo=True).eval()
def gdesc(model, img, h=322):
    w = int(round(img.shape[1] * h / img.shape[0] / 14)) * 14
    x = to_t(cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA))
    x = (x - torch.tensor([0.485, 0.456, 0.406])[:, None, None]) / torch.tensor([0.229, 0.224, 0.225])[:, None, None]
    return model(x)[0].numpy()
if __name__ == '__main__':
    S = load_sweeps()['sweeps']
    sp = SuperPoint(max_num_keypoints=MAXKP, detection_threshold=0.003).eval()
    ml = megaloc()
    K = K_from_fov(W, H, HFOV)
    meta = []; G = []
    t0 = time.time()
    for si, s in enumerate(S):
        sky = Sky(s['id']); Rp = quat_R(s['rot']); C = np.array([s['cam'][k] for k in 'xyz'])
        kps, descs, xyz, scores = [], [], [], []
        for vi, (yaw, pitch) in enumerate(VIEWS):
            R = look_R(yaw, pitch)
            img = render_persp(sky, Rp, R, K, W, H)
            cv2.imwrite(os.path.join(OUT, 'crops', f"{s['id']}_{vi:02d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
            f = sp.extract(to_t(img))
            kp = f['keypoints'][0].numpy(); d = f['descriptors'][0].numpy(); sc = f['keypoint_scores'][0].numpy()
            ray = np.c_[kp, np.ones(len(kp))] @ np.linalg.inv(K).T
            D = (ray / np.linalg.norm(ray, axis=1, keepdims=True)) @ R.T
            loc, ir, _ = mesh().ray.intersects_location(np.repeat(C[None], len(D), 0), D, multiple_hits=False)
            X = np.full((len(kp), 3), np.nan, np.float32); X[ir] = loc
            kps.append(kp.astype(np.float32)); descs.append(d.astype(np.float16)); xyz.append(X); scores.append(sc.astype(np.float16))
            G.append(gdesc(ml, img))
            meta.append(dict(sweep=s['id'], sweep_index=s['index'], floor=s['floor'], view=vi, yaw=yaw, pitch=pitch,
                             C=C.tolist(), R_wc=R.tolist()))
        n = np.array([len(k) for k in kps])
        np.savez(os.path.join(OUT, f"{s['id']}.npz"), kp=np.concatenate(kps), desc=np.concatenate(descs), xyz=np.concatenate(xyz),
                 score=np.concatenate(scores), n=n)
        print(f"{si+1}/{len(S)} sweep {s['index']} kp/view {n.mean():.0f} valid3d {np.isfinite(np.concatenate(xyz)[:,0]).mean():.2f} t={time.time()-t0:.0f}s", flush=True)
    np.save(os.path.join(OUT, 'global.npy'), np.array(G, np.float32))
    json.dump(dict(W=W, H=H, hfov=HFOV, K=K.tolist(), views=VIEWS, crops=meta), open(os.path.join(OUT, 'meta.json'), 'w'))
    print('done', time.time() - t0)
