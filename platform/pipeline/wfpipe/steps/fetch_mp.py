"""Step fetch_mp: Matterport model metadata via the public showcase GraphQL endpoint
(floors, sweeps/locations with neighbours, rooms, walls/openings, labels, mattertags).
Works for public/unlisted models without credentials. Cached in work/mp_model.json."""
import json, time, urllib.request

ENDPOINT = "https://my.matterport.com/api/mp/models/graph"
QUERY = '''query($id:ID!){model(id:$id){ name geocoordinates{latitude longitude altitude source}
 dimensions(units:metric){width depth height areaFloor}
 floors{id label sequence meshId dimensions(units:metric){areaFloor}
   vertices{id position{x y}} edges{id type thickness centerLineBias vertices{id} openings{id type label width relativeCenter lowerElevation height}}}
 rooms{id index label tags keywords meshId classifications{id label} floor{id}
   dimensions(units:metric){width depth height areaFloor}
   boundary{edges{id vertices{id position{x y}}}} holes{edges{id}}}
 labels{id label position{x y z} floor{id} room{id}}
 mattertags{id label description position{x y z} floor{id}}
 locations{id index label tags floor{id} room{id} neighbors position{x y z}
   pano{id placement source position{x y z} rotation{x y z w}}}
}}'''


def gql(query, variables=None, timeout=90):
    req = urllib.request.Request(ENDPOINT, data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "wayfinding-platform/0.1"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def run(ctx):
    mid = ctx.cfg.get("matterport_model_id")
    if not mid:
        raise ValueError("config.matterport_model_id is required")
    cache = ctx.cfg.get("mp_model_cache")   # optional pre-fetched JSON (offline / private models)
    if cache:
        d = json.load(open(cache))
    else:
        last = None
        for attempt in range(3):
            try:
                d = gql(QUERY, {"id": mid}); break
            except Exception as e:
                last = e; ctx.warn(f"GraphQL attempt {attempt+1} failed: {e}"); time.sleep(3)
        else:
            raise RuntimeError(f"Matterport GraphQL unreachable: {last}")
    if d.get("errors") and not (d.get("data") or {}).get("model"):
        raise RuntimeError(f"GraphQL errors: {json.dumps(d['errors'])[:500]}")
    m = d["data"]["model"]
    ctx.write_json(ctx.w("mp_model.json"), d, compact=True)
    return {"name": m["name"], "floors": len(m["floors"]), "sweeps": len(m["locations"]), "rooms": len(m["rooms"]),
            "geocoordinates": m.get("geocoordinates")}
