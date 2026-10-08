"""Evaluate the localizer on the 29 perspective Matterport photos (ground truth: camera centre = source
sweep centre, orientation = refined photo pose from fit_photo_gt.py)."""
import os, sys, json, math, time, numpy as np, cv2
from vpslib import *
from localize import Localizer
G = json.load(open(os.path.join(DATA, 'photo_gt.json')))
SW = {s['id']: s for s in load_sweeps()['sweeps']}
FL = {f['id']: f['label'] for f in load_sweeps()['floors']}

def augment(img, rng):
    """Approximate a phone photo: narrower FOV crop (60-80 deg), small principal-point offset, blur,
    exposure/colour change, sensor noise, low resolution + JPEG. Returns image and its true hfov."""
    h, w = img.shape[:2]; f = (w / 2) / math.tan(math.radians(110) / 2)
    fov = rng.uniform(60, 80); cw = 2 * f * math.tan(math.radians(fov) / 2); ch = cw * 3 / 4
    if ch > h: ch = h; cw = ch * 4 / 3; fov = 2 * math.degrees(math.atan(cw / 2 / f))
    ox, oy = rng.uniform(-0.04, 0.04) * cw, rng.uniform(-0.04, 0.04) * ch
    x0 = int(round(w / 2 - cw / 2 + ox)); y0 = int(round(h / 2 - ch / 2 + oy))
    x0 = int(np.clip(x0, 0, w - cw)); y0 = int(np.clip(y0, 0, h - ch))
    c = img[y0:y0 + int(cw * 3 / 4), x0:x0 + int(cw)]
    lo = cv2.resize(c, (320, 240), interpolation=cv2.INTER_AREA)            # low-res capture
    out = cv2.resize(lo, (640, 480), interpolation=cv2.INTER_LINEAR)
    out = cv2.GaussianBlur(out, (0, 0), rng.uniform(0.6, 1.5))
    k = int(rng.integers(3, 8)); ker = np.zeros((k, k)); ker[k // 2] = 1; ker = cv2.warpAffine(ker, cv2.getRotationMatrix2D((k / 2 - .5, k / 2 - .5), rng.uniform(0, 180), 1), (k, k)); ker /= ker.sum()
    out = cv2.filter2D(out, -1, ker)                                         # motion blur
    o = out.astype(np.float32) / 255
    o = o ** rng.uniform(0.7, 1.4) * rng.uniform(0.6, 1.3) * rng.uniform(0.9, 1.1, 3)   # gamma / exposure / white balance
    o = o + rng.normal(0, 0.015, o.shape)
    out = (o.clip(0, 1) * 255).astype(np.uint8)
    out = cv2.imdecode(cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, 55])[1], 1)
    return out, fov

def rot_err(Ra, Rb): return math.degrees(math.acos(np.clip((np.trace(Ra.T @ Rb) - 1) / 2, -1, 1)))
def ang(a): return (a + 180) % 360 - 180

CONFIGS = {
    'std_knownf':      dict(aug=False, loso=False, hfov='gt'),
    'std_unknownf':    dict(aug=False, loso=False, hfov=None),
    'loso_knownf':     dict(aug=False, loso=True, hfov='gt'),
    'aug_knownf':      dict(aug=True, loso=False, hfov='gt'),
    'aug_loso_knownf': dict(aug=True, loso=True, hfov='gt'),
    'aug_loso_unknownf': dict(aug=True, loso=True, hfov=None),
}
if __name__ == '__main__':
    names = sys.argv[1:] or list(CONFIGS)
    L = Localizer()
    os.makedirs('results', exist_ok=True)
    for name in names:
        cfg = CONFIGS[name]; rows = []; rng = np.random.default_rng(42)
        for sid, g in G.items():
            img = cv2.imread(os.path.join(DATA, 'photos', f'{sid}.jpg'))
            hf = 110.0
            if cfg['aug']:
                img, hf = augment(img, rng)
                if name.startswith('aug') and not os.path.exists(f'results/aug_{sid}.jpg'): cv2.imwrite(f'results/aug_{sid}.jpg', img)
            s = SW[g['sweep']]; Cgt = np.array([s['cam'][k] for k in 'xyz']); Rgt = np.array(g['R_wc'])
            r = L.localize(img, hfov=hf if cfg['hfov'] == 'gt' else None, exclude={g['sweep']} if cfg['loso'] else ())
            row = dict(photo=sid, sweep=s['index'], gt=Cgt.tolist(), gt_floor=FL[s['floor']], success=r['success'],
                       time=r['time'], n_matches=r['n_matches'], timing=r['timing'], hfov_true=hf)
            if r['success']:
                C = np.array([r['x'], r['y'], r['z']]); R = np.array(r['R_wc'])
                fg = Rgt[:, 2]; yaw_gt = math.degrees(math.atan2(fg[1], fg[0]))
                row.update(est=C.tolist(), pos_err=float(np.linalg.norm(C - Cgt)), pos_err_2d=float(np.linalg.norm((C - Cgt)[:2])),
                           rot_err=rot_err(R, Rgt), yaw_err=abs(ang(r['yaw_model'] - yaw_gt)), floor_ok=r['floor'] == FL[s['floor']],
                           inliers=r['inliers'], inlier_ratio=r['inlier_ratio'], confidence=r['confidence'], hfov_est=r['hfov'],
                           yaw_gt=yaw_gt, yaw_est=r['yaw_model'], best_ref_sweep=r['best_ref_sweep'])
            rows.append(row)
            print(name, sid, s['index'], 'ok' if r['success'] else 'FAIL', {k: round(row[k], 2) for k in ['pos_err', 'rot_err', 'inliers', 'time'] if k in row}, flush=True)
        json.dump(rows, open(f'results/{name}.json', 'w'), indent=1)
