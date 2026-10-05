"""Coordinate helpers. Frames:
  model  – Matterport/MatterPak OBJ frame, metres, right-handed, Z up
  3857   – Web Mercator metres (what map tiles use)
  wgs84  – lon/lat degrees
  cp px  – colour-plan image pixels (MatterPak colorplan_*.jpg)
  sat px – pixels of the downloaded Esri World Imagery mosaic
Model -> 3857 is a 2x3 affine A (similarity: rotation + unit ground scale * 1/cos(lat) + translation).
"""
import math
import numpy as np

R = 6378137.0
C = 2 * math.pi * R


def merc(lon, lat):
    return math.radians(lon) * R, R * math.asinh(math.tan(math.radians(lat)))


def unmerc(X, Y):
    return math.degrees(X / R), math.degrees(math.atan(math.sinh(Y / R)))


class Georef:
    """Wraps model->3857 affine."""

    def __init__(self, A):
        self.A = np.asarray(A, float).reshape(2, 3)
        self.Ai = np.linalg.inv(self.A[:, :2])

    @classmethod
    def from_json(cls, g):
        return cls(g["model_to_epsg3857_affine"])

    def to_merc(self, x, y):
        return self.A[:, :2] @ np.array([x, y], float) + self.A[:, 2]

    def ll(self, x, y, nd=8):
        X, Y = self.to_merc(x, y)
        lon, lat = unmerc(X, Y)
        return [round(lon, nd), round(lat, nd)]

    def model(self, lon, lat):
        X, Y = merc(lon, lat)
        return self.Ai @ (np.array([X, Y]) - self.A[:, 2])

    @property
    def rotation_deg(self):
        return math.degrees(math.atan2(self.A[1, 0], self.A[0, 0]))

    def geom_ll(self, geom):
        from shapely.ops import transform
        def f(x, y, z=None):
            xs, ys = np.atleast_1d(x), np.atleast_1d(y)
            P = (self.A[:, :2] @ np.vstack([xs, ys])).T + self.A[:, 2]
            lon = np.degrees(P[:, 0] / R); lat = np.degrees(np.arctan(np.sinh(P[:, 1] / R)))
            return tuple(np.round(lon, 8)), tuple(np.round(lat, 8))
        return transform(f, geom)


def fit_similarity(src, dst, fixed_scale=None):
    """Least-squares 2D similarity dst ≈ a*src + b using complex numbers.
    fixed_scale: if given, |a| is fixed (rotation-only Procrustes). Returns (a, b)."""
    src = np.asarray(src, float); dst = np.asarray(dst, float)
    sc = src[:, 0] + 1j * src[:, 1]; dc = dst[:, 0] + 1j * dst[:, 1]
    if fixed_scale is None:
        M = np.stack([sc, np.ones_like(sc)], 1)
        a, b = np.linalg.lstsq(M, dc, rcond=None)[0]
        return a, b
    ms, md = sc.mean(), dc.mean()
    h = np.sum(np.conj(sc - ms) * (dc - md))
    a = fixed_scale * h / abs(h)
    return a, md - a * ms


def affine_from_complex(a, b):
    return [[a.real, -a.imag, b.real], [a.imag, a.real, b.imag]]


def georef_from_control_points(cps, unit_scale=True):
    """cps: list of {model_xy:[x,y], wgs84:[lat,lon]} -> (A, residuals_m, info)."""
    src = np.array([c["model_xy"] for c in cps], float)
    dst = np.array([merc(c["wgs84"][1], c["wgs84"][0]) for c in cps], float)
    lat0 = float(np.mean([c["wgs84"][0] for c in cps]))
    k = 1 / math.cos(math.radians(lat0))
    a, b = fit_similarity(src, dst, k if unit_scale else None)
    pred = a * (src[:, 0] + 1j * src[:, 1]) + b
    e = np.abs(pred - (dst[:, 0] + 1j * dst[:, 1])) / k
    return affine_from_complex(a, b), e, {"scale": abs(a) / k, "rotation_deg": math.degrees(np.angle(a)),
                                         "rms_m": float(np.sqrt(np.mean(e ** 2))) if len(e) else None,
                                         "max_err_m": float(e.max()) if len(e) else None}


def affine_from_params(origin_lat, origin_lon, rotation_deg, scale=1.0):
    """Build model->3857 affine: model (0,0) at origin, model +X rotated rotation_deg CCW from east."""
    k = 1 / math.cos(math.radians(origin_lat))
    th = math.radians(rotation_deg)
    X, Y = merc(origin_lon, origin_lat)
    s = scale * k
    return [[s * math.cos(th), -s * math.sin(th), X], [s * math.sin(th), s * math.cos(th), Y]]


def tile_xy(lat, lon, z):
    n = 2 ** z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
