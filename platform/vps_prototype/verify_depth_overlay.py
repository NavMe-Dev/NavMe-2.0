"""Overlay mesh-depth discontinuities (raycast MatterPak) on skybox renders -> /tmp/depth_overlay.jpg. Edges must align with image edges."""
import numpy as np, cv2, sys
from vpslib import *
S = load_sweeps()['sweeps']; rows = []
for idx in [int(a) for a in sys.argv[1:]] or [56, 4]:
    s = [x for x in S if x['index'] == idx][0]; C = np.array([s['cam'][k] for k in 'xyz'])
    w = h = 320; K = K_from_fov(w, h, 100); row = []
    for yaw, p in [(0, 0), (90, 0), (0, 75), (120, 75), (0, -75), (200, -75)]:
        R = look_R(yaw, p); img = render_persp(Sky(s['id']), quat_R(s['rot']), R, K, w, h)
        d = raycast_depth(C, R, K, w, h); img[cv2.Canny((np.nan_to_num(d) * 60).clip(0, 255).astype(np.uint8), 20, 60) > 0] = (0, 0, 255); row.append(img)
    rows.append(np.hstack(row))
cv2.imwrite('/tmp/depth_overlay.jpg', np.vstack(rows)); print('/tmp/depth_overlay.jpg')
