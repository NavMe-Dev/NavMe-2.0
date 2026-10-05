"""Step imagery: download an Esri World Imagery mosaic (default z20) around the site for auto-georeferencing
and the admin georef review. Site centre = config lat/lon (geocoded address) or Matterport geocoordinates."""
import math, urllib.request, concurrent.futures as cf
import numpy as np, cv2
from ..geo import tile_xy

URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"


def site_center(ctx):
    if ctx.cfg.get("lat") is not None and ctx.cfg.get("lon") is not None:
        return float(ctx.cfg["lat"]), float(ctx.cfg["lon"]), "config"
    m = ctx.read_json(ctx.w("mp_model.json"))["data"]["model"]
    gc = m.get("geocoordinates")
    if gc and gc.get("latitude"):
        return gc["latitude"], gc["longitude"], "matterport"
    raise ValueError("site location unknown: set lat/lon (or an address to geocode) in the building config")


def run(ctx):
    lat0, lon0, src = site_center(ctx)
    g = ctx.cfg["georef"]; z = int(g.get("imagery_zoom", 20)); rad = float(g.get("search_radius_m", 130))
    dlat = rad / 111320; dlon = rad / (111320 * math.cos(math.radians(lat0)))
    xa, ya = tile_xy(lat0 + dlat, lon0 - dlon, z); xb, yb = tile_xy(lat0 - dlat, lon0 + dlon, z)
    tx = range(int(xa), int(xb) + 1); ty = range(int(ya), int(yb) + 1)

    def get(t):
        x, y = t
        req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": "wayfinding-platform/0.1"})
        for _ in range(3):
            try:
                d = urllib.request.urlopen(req, timeout=30).read()
                return t, cv2.imdecode(np.frombuffer(d, np.uint8), 1)
            except Exception:
                pass
        return t, None
    img = np.zeros((256 * len(ty), 256 * len(tx), 3), np.uint8); miss = 0
    with cf.ThreadPoolExecutor(8) as ex:
        for (x, y), im in ex.map(get, [(x, y) for x in tx for y in ty]):
            if im is None:
                miss += 1; continue
            if im.shape[:2] != (256, 256):
                im = cv2.resize(im, (256, 256))
            img[(y - ty[0]) * 256:(y - ty[0] + 1) * 256, (x - tx[0]) * 256:(x - tx[0] + 1) * 256] = im
    if miss > 0.5 * len(tx) * len(ty):
        raise RuntimeError(f"imagery download failed ({miss} tiles missing)")
    cv2.imwrite(str(ctx.w("sat.png")), img)
    ctx.write_json(ctx.w("sat.json"), {"z": z, "tx0": tx[0], "ty0": ty[0], "w": img.shape[1], "h": img.shape[0],
                                       "center": [lat0, lon0], "center_source": src,
                                       "attribution": "Esri, Maxar, Earthstar Geographics, and the GIS User Community"})
    return {"tiles": len(tx) * len(ty), "missing": miss, "center_source": src, "zoom": z}


def satpx2merc(j, px, py):
    C = 2 * math.pi * 6378137.0; res = C / (256 * 2 ** j["z"])
    return (j["tx0"] * 256 + px) * res - C / 2, C / 2 - (j["ty0"] * 256 + py) * res
