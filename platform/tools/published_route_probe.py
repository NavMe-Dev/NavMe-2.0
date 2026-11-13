"""Exercise the real route engine against cached authentic published POI pairs.

Run with the platform virtualenv and API/pipeline on PYTHONPATH. This is a
read-only offline diagnostic, not a claim of live API or viewer acceptance.
"""
import argparse
import json
from pathlib import Path
import time

from wayfinding_api.services.navgraph import route


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("platform/var/production-migration/storage"))
    args = parser.parse_args()
    results = []
    for slug, version in [("gcu", 5), ("uncc-main-campus", 2)]:
        def read(name):
            return json.loads((args.cache / f"{slug}-v{version}-{name}.json").read_text())
        pois, graph, georef = read("pois")["pois"], read("nav_graph"), read("georef")
        node_ids = {node["id"] for node in graph["nodes"]}
        usable = [poi for poi in pois if poi.get("nearest_node") in node_ids]
        start = usable[0]
        for kind in ("same_floor", "different_floor"):
            candidates = [poi for poi in usable if poi["nearest_node"] != start["nearest_node"]
                          and ((poi["floor"] == start["floor"]) == (kind == "same_floor"))]
            if not candidates:
                results.append({"slug": slug, "kind": kind, "result": "NO CANDIDATE"})
                continue
            end = candidates[0]
            for step_free in (False, True):
                began = time.perf_counter()
                result = route(graph, start["nearest_node"], end["nearest_node"], step_free=step_free, georef=georef)
                row = {"slug": slug, "version": version, "kind": kind, "step_free": step_free,
                       "elapsed_ms": round((time.perf_counter() - began) * 1000, 3),
                       "from_poi_id": start["id"], "to_poi_id": end["id"],
                       "from_floor": start["floor"], "to_floor": end["floor"],
                       "result": "ROUTE" if result else "NO ROUTE"}
                if result:
                    row.update({key: result[key] for key in ("length_m", "eta_s", "stair_edges", "elevator_edges", "floors")})
                    row["endpoints_match"] = result["nodes"][0] == start["nearest_node"] and result["nodes"][-1] == end["nearest_node"]
                    row["geometry_points"] = len(result["geometry"]["coordinates"])
                results.append(row)
    output = args.cache / "authentic-route-probes.json"
    output.write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
