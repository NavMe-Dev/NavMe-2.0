"""Floor-plan visualization of ground-truth vs estimated camera positions + heading arrows."""
import os, sys, json, math, numpy as np, cv2
from vpslib import *
MP = os.path.join(HERE, '..', 'matterpak')
def px(x, y): return 67.7955 * x + 3294.54, -67.7955 * y + 1916.70
SW = load_sweeps(); FL = {f['label']: i for i, f in enumerate(sorted(SW['floors'], key=lambda f: f['label']))}
def draw(configs, out, scale=0.5):
    runs = [(c, json.load(open(f'results/{c}.json'))) for c in configs]
    cols = [(0, 0, 230), (230, 120, 0), (200, 0, 200), (0, 160, 230)]
    panels = []
    for fl, fn in [('Floor 1', 'colorplan_000.jpg'), ('Floor 2', 'colorplan_001.jpg')]:
        im = cv2.imread(os.path.join(MP, fn)); im = cv2.resize(im, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        im = (im * 0.75 + 255 * 0.25).astype(np.uint8)
        def P(x, y): a, b = px(x, y); return int(a * scale), int(b * scale)
        for s in SW['sweeps']:
            if [f for f in SW['floors'] if f['id'] == s['floor']][0]['label'] == fl:
                cv2.circle(im, P(s['cam']['x'], s['cam']['y']), 4, (150, 150, 150), -1)
        gts = [r for r in runs[0][1] if r['gt_floor'] == fl]
        for r in gts:
            g = P(*r['gt'][:2]); cv2.circle(im, g, 9, (0, 170, 0), 2)
            if 'yaw_gt' in r:
                a = math.radians(r['yaw_gt']); e = (int(g[0] + 40 * math.cos(a)), int(g[1] - 40 * math.sin(a)))
                cv2.arrowedLine(im, g, e, (0, 170, 0), 2, tipLength=0.3)
        for ci, (c, rows) in enumerate(runs):
            for r in rows:
                if r['gt_floor'] != fl or not r['success']: continue
                g = P(*r['gt'][:2]); e0 = P(*r['est'][:2])
                col = cols[ci % len(cols)]
                cv2.line(im, g, e0, col, 1)
                cv2.drawMarker(im, e0, col, cv2.MARKER_TILTED_CROSS, 14, 2)
                a = math.radians(r['yaw_est']); e = (int(e0[0] + 30 * math.cos(a)), int(e0[1] - 30 * math.sin(a)))
                cv2.arrowedLine(im, e0, e, col, 2, tipLength=0.3)
        # crop to sweep extent
        xs = [P(s['cam']['x'], s['cam']['y']) for s in SW['sweeps']]
        x0 = max(0, min(p[0] for p in xs) - 120); x1 = min(im.shape[1], max(p[0] for p in xs) + 120)
        y0 = max(0, min(p[1] for p in xs) - 120); y1 = min(im.shape[0], max(p[1] for p in xs) + 120)
        im = im[y0:y1, x0:x1].copy()
        cv2.putText(im, fl, (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 3)
        panels.append(im)
    h = max(p.shape[0] for p in panels)
    panels = [cv2.copyMakeBorder(p, 0, h - p.shape[0], 0, 10, cv2.BORDER_CONSTANT, value=(255, 255, 255)) for p in panels]
    img = np.hstack(panels)
    leg = np.full((70 + 30 * len(runs), img.shape[1], 3), 255, np.uint8)
    cv2.circle(leg, (25, 25), 9, (0, 170, 0), 2); cv2.putText(leg, 'ground truth (photo camera = sweep centre) + heading', (45, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    for ci, (c, rows) in enumerate(runs):
        ok = [r for r in rows if r['success']]; e = np.array([r['pos_err'] for r in ok]) if ok else np.array([np.nan])
        cv2.drawMarker(leg, (25, 60 + 30 * ci), cols[ci % len(cols)], cv2.MARKER_TILTED_CROSS, 14, 2)
        cv2.putText(leg, f'estimate: {c}  (median pos err {np.median(e):.2f} m, {len(ok)}/{len(rows)} localized)', (45, 67 + 30 * ci), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(leg, 'grey dots = scan sweeps', (img.shape[1] - 330, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (90, 90, 90), 2)
    cv2.imwrite(out, np.vstack([img, leg]), [cv2.IMWRITE_JPEG_QUALITY, 88])
    print('wrote', out)
if __name__ == '__main__':
    out = sys.argv[1]; draw(sys.argv[2:], out)
