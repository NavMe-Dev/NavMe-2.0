"""Step mesh: parse the MatterPak OBJ into numpy arrays (work/mesh.npz: V float64 Nx3, F int64 Mx3)."""
import numpy as np


def load_obj(path):
    vs, fs = [], []
    with open(path, "rb") as f:
        for line in f:
            if line.startswith(b"v "):
                vs.append(line[2:])
            elif line.startswith(b"f "):
                p = line.split()[1:]
                idx = [int(q.split(b"/")[0]) for q in p]
                for k in range(1, len(idx) - 1):          # fan-triangulate polygons
                    fs.append((idx[0], idx[k], idx[k + 1]))
    ncol = len(vs[0].split()) if vs else 3
    if all(len(v.split()) == ncol for v in vs[:1000]):
        V = np.array(b" ".join(vs).split(), float).reshape(-1, ncol)[:, :3]
    else:
        V = np.array([[float(t) for t in v.split()[:3]] for v in vs])
    F = np.array(fs, np.int64)
    F = np.where(F < 0, F + len(V) + 1, F) - 1
    return V, F


def run(ctx):
    V, F = load_obj(ctx.w("matterpak/model.obj"))
    np.savez(ctx.w("mesh.npz"), V=V, F=F)
    lo, hi = V.min(0), V.max(0)
    ctx.write_json(ctx.w("mesh_info.json"), {"vertices": len(V), "faces": len(F), "min": lo.tolist(), "max": hi.tolist()})
    return {"vertices": int(len(V)), "faces": int(len(F)), "bbox_m": [round(float(x), 2) for x in (hi - lo)]}


def load(ctx):
    d = np.load(ctx.w("mesh.npz")); return d["V"], d["F"]
