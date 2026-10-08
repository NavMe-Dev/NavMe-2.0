"""Core geometry utilities for the Matterport VPS prototype.
World frame = MatterPak model frame (meters, right-handed, Z up).
Camera frame = OpenCV (x right, y down, z forward). R_wc maps camera->world.
"""
import json, os, numpy as np, cv2
from scipy.spatial.transform import Rotation as Rot
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')

def quat_R(q):  # dict {x,y,z,w} -> 3x3
    return Rot.from_quat([q['x'], q['y'], q['z'], q['w']]).as_matrix()

# ---------------- cube-face convention (pano-local frame, Z up) ----------------
# CONV is set after empirical verification (see verify_convention.py)
CONV = dict(f1=(1, 0, 0), cw=True)

def face_axes(conv=None):
    """Return for each face k (0..5) the (forward, right, down) unit vectors in pano-local frame."""
    c = conv or CONV
    f1 = np.array(c['f1'], float); z = np.array([0, 0, 1.])
    ax = {}
    # right-successive: next forward = current right
    sides = []
    f = f1.copy()
    for k in range(4):
        r = np.cross(f, z)
        if not c['cw']: r = -r   # mirrored hypothesis
        sides.append((f.copy(), r.copy(), -z)); f = r.copy()
    r1 = sides[0][1]; f1 = sides[0][0]
    ax[0] = (z, r1, f1)        # up face: bottom edge adjoins front face
    for k in range(4): ax[k + 1] = sides[k]
    ax[5] = (-z, r1, -f1)      # down face: top edge adjoins front face
    return ax

def dirs_to_face_uv(d, conv=None):
    """d: (N,3) pano-local directions -> face idx (N,), u,v in [0,1] (x right, y down)."""
    ax = face_axes(conv)
    F = np.stack([ax[k][0] for k in range(6)]); Rr = np.stack([ax[k][1] for k in range(6)]); D = np.stack([ax[k][2] for k in range(6)])
    dots = d @ F.T
    k = np.argmax(dots, 1)
    den = dots[np.arange(len(d)), k]
    u = (np.einsum('ij,ij->i', d, Rr[k]) / den + 1) / 2
    v = (np.einsum('ij,ij->i', d, D[k]) / den + 1) / 2
    return k, u, v

class Sky:
    def __init__(self, sweep_id, conv=None, faces=None, data_root=None):
        root = data_root or DATA
        self.faces = faces or [cv2.imread(os.path.join(root, 'sky', f'{sweep_id}_{i}.jpg')) for i in range(6)]
        self.S = self.faces[0].shape[0]
        self.atlas = np.concatenate(self.faces, 0)
        self.conv = conv
    def sample(self, d_local, shape):
        k, u, v = dirs_to_face_uv(d_local.reshape(-1, 3), self.conv)
        S = self.S
        mx = (u * S - 0.5).clip(0, S - 1).astype(np.float32)
        my = (v * S - 0.5).clip(0, S - 1).astype(np.float32) + k * S
        return cv2.remap(self.atlas, mx.reshape(shape), my.reshape(shape).astype(np.float32), cv2.INTER_LINEAR)

def K_from_fov(w, h, hfov_deg):
    f = (w / 2) / np.tan(np.radians(hfov_deg) / 2)
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1.]])

def pixel_rays(K, w, h):
    xs, ys = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    p = np.stack([xs, ys, np.ones_like(xs)], -1).reshape(-1, 3)
    r = p @ np.linalg.inv(K).T
    return r / np.linalg.norm(r, axis=1, keepdims=True)

def look_R(yaw_deg, pitch_deg):
    """Camera->world rotation for a camera at yaw (CCW from +X, Z up) and pitch (up positive). OpenCV cam axes."""
    y, p = np.radians(yaw_deg), np.radians(pitch_deg)
    fwd = np.array([np.cos(p) * np.cos(y), np.cos(p) * np.sin(y), np.sin(p)])
    right = np.array([np.sin(y), -np.cos(y), 0.])
    down = np.cross(fwd, right)
    return np.stack([right, down, fwd], 1)

def render_persp(sky, R_pano, R_wc, K, w, h):
    """Render perspective view: R_pano = pano-local->world, R_wc = camera->world."""
    rays_c = pixel_rays(K, w, h)
    d_local = rays_c @ (R_pano.T @ R_wc).T
    return sky.sample(d_local, (h, w))

# ---------------- mesh raycasting ----------------
_mesh = None
_mesh_path = None
def mesh(data_root=None):
    global _mesh, _mesh_path
    path = os.path.join(data_root or DATA, 'mesh.npz')
    if _mesh is None or _mesh_path != path:
        import trimesh
        m = np.load(path)
        _mesh = trimesh.Trimesh(m['V'], m['F'], process=False)
        _mesh_path = path
    return _mesh

def raycast_depth(C, R_wc, K, w, h, step=1):
    """Return z-depth map (h,w) (NaN where no hit), computed at every `step` px."""
    rays_c = pixel_rays(K, w, h)
    D = rays_c @ R_wc.T
    O = np.repeat(C[None], len(D), 0)
    loc, idx_ray, _ = mesh().ray.intersects_location(O, D, multiple_hits=False)
    dist = np.full(len(D), np.nan)
    dist[idx_ray] = np.linalg.norm(loc - C, axis=1)
    z = dist * rays_c[:, 2]
    return z.reshape(h, w)

def load_sweeps(data_root=None):
    S = json.load(open(os.path.join(data_root or DATA, 'sweeps.json')))
    return S
