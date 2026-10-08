"""Parallel wrapper around build_db.py's per-sweep logic — same algorithm, same outputs
(one {sweep_id}.npz per sweep + global.npy + meta.json), just split across worker
processes instead of one sequential loop. The reference machine here has 8 cores but the
original script only used ~1.3 of them (each sweep's SuperPoint/MegaLoc/raycasting work is
independent of every other sweep, so there's no reason it has to be sequential).

Usage: python3 build_db_parallel.py [--workers N]
Reads the same VPS_DATA/VPS_VIEWS_FAST env vars build_db.py does.
"""
import json
import multiprocessing as mp
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if os.environ.get("VPS_DATA"):
    DATA = os.environ["VPS_DATA"]
else:
    DATA = os.path.join(HERE, "data")
OUT = os.path.join(DATA, "db")


def _worker(args):
    shard_index, n_shards, views_fast = args
    os.environ["VPS_VIEWS_FAST"] = "1" if views_fast else ""
    sys.path.insert(0, HERE)
    import cv2
    import torch
    from lightglue import SuperPoint
    import vpslib as _v
    if os.environ.get("VPS_DATA"):
        _v.DATA = os.environ["VPS_DATA"]
    from vpslib import load_sweeps, Sky, quat_R, K_from_fov, look_R, render_persp, mesh
    torch.set_grad_enabled(False)

    W, H, HFOV = 640, 480, 75
    if views_fast:
        VIEWS = [(y, 0) for y in range(0, 360, 45)] + [(0, -25), (180, -25), (0, 25), (180, 25)]
    else:
        VIEWS = [(y, 0) for y in range(0, 360, 30)] + [(y, -30) for y in range(0, 360, 60)] + [(y + 30, 25) for y in range(0, 360, 90)]
    MAXKP = 1024

    def to_t(img):
        return torch.from_numpy(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float()[None] / 255

    def megaloc():
        return torch.hub.load("gmberton/MegaLoc", "get_trained_model", trust_repo=True).eval()

    def gdesc(model, img, h=322):
        w = int(round(img.shape[1] * h / img.shape[0] / 14)) * 14
        x = to_t(cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA))
        x = (x - torch.tensor([0.485, 0.456, 0.406])[:, None, None]) / torch.tensor([0.229, 0.224, 0.225])[:, None, None]
        return model(x)[0].numpy()

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, "crops"), exist_ok=True)
    S = load_sweeps(DATA)["sweeps"]
    my_sweeps = [s for i, s in enumerate(S) if i % n_shards == shard_index]
    sp = SuperPoint(max_num_keypoints=MAXKP, detection_threshold=0.003).eval()
    ml = megaloc()
    K = K_from_fov(W, H, HFOV)
    meta = []
    G = []
    t0 = time.time()
    done = skipped = 0
    for si, s in enumerate(my_sweeps):
        npz_path = os.path.join(OUT, f"{s['id']}.npz")
        if os.path.isfile(npz_path):
            skipped += 1
            continue
        sky = Sky(s["id"], data_root=DATA)
        Rp = quat_R(s["rot"])
        C = np.array([s["cam"][k] for k in "xyz"])
        kps, descs, xyz, scores = [], [], [], []
        for vi, (yaw, pitch) in enumerate(VIEWS):
            R = look_R(yaw, pitch)
            img = render_persp(sky, Rp, R, K, W, H)
            cv2.imwrite(os.path.join(OUT, "crops", f"{s['id']}_{vi:02d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
            f = sp.extract(to_t(img))
            kp = f["keypoints"][0].numpy(); d = f["descriptors"][0].numpy(); sc = f["keypoint_scores"][0].numpy()
            ray = np.c_[kp, np.ones(len(kp))] @ np.linalg.inv(K).T
            D = (ray / np.linalg.norm(ray, axis=1, keepdims=True)) @ R.T
            loc, ir, _ = mesh(DATA).ray.intersects_location(np.repeat(C[None], len(D), 0), D, multiple_hits=False)
            X = np.full((len(kp), 3), np.nan, np.float32); X[ir] = loc
            kps.append(kp.astype(np.float32)); descs.append(d.astype(np.float16)); xyz.append(X); scores.append(sc.astype(np.float16))
            G.append(gdesc(ml, img))
            meta.append(dict(sweep=s["id"], sweep_index=s["index"], floor=s["floor"], view=vi, yaw=yaw, pitch=pitch,
                             C=C.tolist(), R_wc=R.tolist()))
        n = np.array([len(k) for k in kps])
        np.savez(npz_path, kp=np.concatenate(kps), desc=np.concatenate(descs), xyz=np.concatenate(xyz),
                 score=np.concatenate(scores), n=n)
        done += 1
        print(f"[shard {shard_index}] {done}/{len(my_sweeps)-skipped} (skipped {skipped}) sweep {s['index']} "
              f"kp/view {n.mean():.0f} valid3d {np.isfinite(np.concatenate(xyz)[:,0]).mean():.2f} t={time.time()-t0:.0f}s", flush=True)

    shard_path = os.path.join(OUT, f"_shard{shard_index}.json")
    json.dump({"meta": meta}, open(shard_path, "w"))
    np.save(os.path.join(OUT, f"_shard{shard_index}_global.npy"), np.array(G, np.float32) if G else np.zeros((0, 1), np.float32))
    return shard_index, done, skipped


def merge(n_shards, W=640, H=480, HFOV=75):
    all_meta = []
    all_G = []
    for i in range(n_shards):
        shard_path = os.path.join(OUT, f"_shard{i}.json")
        if not os.path.isfile(shard_path):
            raise RuntimeError(f"shard {i} never completed — rerun")
        all_meta.extend(json.load(open(shard_path))["meta"])
        g = np.load(os.path.join(OUT, f"_shard{i}_global.npy"))
        if g.size:
            all_G.append(g)
    # Sweeps processed in a PRIOR run (already-existing npz, skipped this time) have no
    # meta/global entries from this run's shards — reconstruct their crop metadata and
    # global descriptors are NOT recoverable without re-running them, so a merge only
    # works cleanly when every sweep was freshly processed in this same parallel pass.
    G = np.concatenate(all_G, axis=0) if all_G else np.zeros((0, 1), np.float32)
    from vpslib import K_from_fov
    K = K_from_fov(W, H, HFOV)
    if os.environ.get("VPS_VIEWS_FAST"):
        VIEWS = [(y, 0) for y in range(0, 360, 45)] + [(0, -25), (180, -25), (0, 25), (180, 25)]
    else:
        VIEWS = [(y, 0) for y in range(0, 360, 30)] + [(y, -30) for y in range(0, 360, 60)] + [(y + 30, 25) for y in range(0, 360, 90)]
    np.save(os.path.join(OUT, "global.npy"), G)
    json.dump(dict(W=W, H=H, hfov=HFOV, K=K.tolist(), views=VIEWS, crops=all_meta), open(os.path.join(OUT, "meta.json"), "w"))
    for i in range(n_shards):
        os.remove(os.path.join(OUT, f"_shard{i}.json"))
        os.remove(os.path.join(OUT, f"_shard{i}_global.npy"))
    print(f"merged {len(all_meta)} crops into global.npy + meta.json")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=5)
    a = ap.parse_args()
    views_fast = bool(os.environ.get("VPS_VIEWS_FAST"))
    n = a.workers
    t0 = time.time()
    with mp.Pool(n) as pool:
        results = pool.map(_worker, [(i, n, views_fast) for i in range(n)])
    for shard_index, done, skipped in sorted(results):
        print(f"shard {shard_index}: {done} built, {skipped} already existed")
    merge(n)
    print(f"total time: {time.time()-t0:.0f}s")
