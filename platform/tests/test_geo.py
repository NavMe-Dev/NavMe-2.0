import math, numpy as np
from wfpipe.geo import Georef, fit_similarity, georef_from_control_points, affine_from_params, merc, unmerc


def test_merc_roundtrip():
    X, Y = merc(-80.8793, 35.2262); lon, lat = unmerc(X, Y)
    assert abs(lon + 80.8793) < 1e-9 and abs(lat - 35.2262) < 1e-9


def test_affine_params_and_inverse():
    A = affine_from_params(35.2262, -80.8793, -4.95)
    G = Georef(A)
    lon, lat = G.ll(10, 20); x, y = G.model(lon, lat)
    assert abs(x - 10) < 2e-3 and abs(y - 20) < 2e-3   # ll() rounds to 1e-8 deg (~1 mm)
    assert abs(G.rotation_deg + 4.95) < 1e-9
    # ground distance of 10 m in model == ~10 m on the ground
    a, b = G.ll(0, 0), G.ll(10, 0)
    d = math.hypot((b[0] - a[0]) * 111320 * math.cos(math.radians(35.2262)), (b[1] - a[1]) * 110574)
    assert abs(d - 10) < 0.05


def test_similarity_fit_recovers_transform():
    rng = np.random.default_rng(1); src = rng.uniform(-30, 30, (12, 2))
    a = 1.2 * np.exp(1j * 0.3); b = 5 + 7j
    d = a * (src[:, 0] + 1j * src[:, 1]) + b
    af, bf = fit_similarity(src, np.c_[d.real, d.imag])
    assert abs(af - a) < 1e-9 and abs(bf - b) < 1e-9


def test_control_points_unit_scale():
    A = affine_from_params(35.2262, -80.8793, 12.0); G = Georef(A)
    cps = [{"model_xy": [x, y], "wgs84": G.ll(x, y)[::-1]} for x, y in [(0, 0), (20, 5), (-10, 30), (15, -25)]]
    A2, e, info = georef_from_control_points(cps)
    assert info["rms_m"] < 0.01 and abs(info["rotation_deg"] - 12.0) < 0.01 and abs(info["scale"] - 1) < 1e-3
