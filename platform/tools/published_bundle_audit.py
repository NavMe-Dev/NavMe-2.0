"""Read-only integrity audit of cached authentic published bundles.

Raw JSON stays in ignored platform/var. Optional bounded HEAD requests check
referenced objects in the exact destination's public bundle bucket. No writes,
credentials, inserts, or reconstructed records are sent to Supabase.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://kzpvhzyefdtrtidrbuxb.supabase.co/storage/v1/object/public/wayfinding-bundles/published/"
TARGETS = [("gcu", 5), ("uncc-main-campus", 2)]


def safe_ref(value):
    return isinstance(value, str) and value and not value.startswith("/") and not any(
        part in value for part in (":", "?", "#", "\\")
    ) and ".." not in PurePosixPath(value).parts


def refs(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from refs(item)


def coordinates_valid(value):
    return isinstance(value, (list, tuple)) and len(value) >= 2 and all(
        isinstance(x, (int, float)) and math.isfinite(x) for x in value[:2]
    ) and -180 <= value[0] <= 180 and -90 <= value[1] <= 90


def audit(cache, slug, version, remote=False):
    files = {}
    checksums = {}
    for name in ("config.json", "pois.json", "nav_graph.json", "georef.json", "floors.json"):
        file = cache / f"{slug}-v{version}-{name}"
        if file.is_file():
            raw = file.read_bytes()
            files[name] = json.loads(raw)
            checksums[name] = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    cfg = files["config.json"]
    graph = files["nav_graph.json"]
    pois = files["pois.json"]["pois"]
    nodes = graph["nodes"]
    edges = graph["edges"]
    node_ids = {n["id"] for n in nodes}
    node_by_id = {n["id"]: n for n in nodes}
    floor_ids = {f["id"] for f in cfg["floors"]}
    floor_rows = cfg["floors"]
    components = []
    adjacency = {node: set() for node in node_ids}
    for edge in edges:
        if not edge.get("pruned") and edge["u"] in node_ids and edge["v"] in node_ids:
            adjacency[edge["u"]].add(edge["v"])
            adjacency[edge["v"]].add(edge["u"])
    unseen = set(node_ids)
    while unseen:
        queue = [unseen.pop()]
        size = 0
        while queue:
            node = queue.pop()
            size += 1
            for neighbor in adjacency[node] & unseen:
                unseen.remove(neighbor)
                queue.append(neighbor)
        components.append(size)
    report = {
        "slug": slug, "version": version, "schema": cfg.get("schema"),
        "matterport_model_id": cfg.get("matterport_model_id"),
        "counts": {"floors": len(floor_ids), "pois": len(pois), "nodes": len(nodes), "edges": len(edges)},
        "config_stats_match": all(cfg.get("stats", {}).get(key) == actual for key, actual in
                                  (("pois", len(pois)), ("nav_nodes", len(nodes)), ("nav_edges", len(edges)))),
        "duplicate_node_ids": len(nodes) - len(node_ids),
        "duplicate_poi_ids": len(pois) - len({p["id"] for p in pois}),
        "edges_missing_nodes": sum(e["u"] not in node_ids or e["v"] not in node_ids for e in edges),
        "pois_missing_nearest_node": sum(p.get("nearest_node") not in node_ids for p in pois),
        "pois_null_nearest_node": sum(p.get("nearest_node") is None for p in pois),
        "pois_invalid_nonnull_nearest_node": sum(p.get("nearest_node") is not None and p["nearest_node"] not in node_ids for p in pois),
        "pois_nearest_node_on_other_floor": sum(p.get("nearest_node") in node_ids and node_by_id[p["nearest_node"]].get("floor") != p.get("floor") for p in pois),
        "pois_missing_floor": sum(p.get("floor") not in floor_ids for p in pois),
        "nodes_missing_floor": sum(n.get("floor") not in floor_ids for n in nodes),
        "invalid_poi_lonlat": sum(not coordinates_valid(p.get("lonlat")) for p in pois),
        "invalid_node_lonlat": sum(not coordinates_valid(n.get("lonlat")) for n in nodes),
        "nonpositive_floor_heights": [{"id": f["id"], "height": f.get("height")} for f in floor_rows if f.get("height", 0) <= 0],
        "decreasing_floor_elevations": [{"from": a["id"], "to": b["id"]} for a, b in zip(floor_rows, floor_rows[1:]) if b["elevation"] < a["elevation"]],
        "unpruned_graph_components": len(components), "largest_component_nodes": max(components, default=0),
        "georef_model_matches": files.get("georef.json", {}).get("matterport_model_id") == cfg.get("matterport_model_id"),
        "floors_content_inspected": "floors.json" in files,
        "checksums": checksums,
    }
    floor_file = files.get("floors.json")
    if floor_file:
        report["floor_asset_ids_match_config"] = {f["id"] for f in floor_file["floors"]} == floor_ids
        report["floor_corner_coordinates_valid"] = all(coordinates_valid(corner) for f in floor_file["floors"] for corner in f["corners_lonlat"])
    if remote:
        references = set(refs(cfg["files"]))
        for floor in floor_rows:
            references.update(floor.get(k) for k in ("overlay", "glb") if floor.get(k))
        # Keep this diagnostic bounded even if a future config adds many assets.
        if len(references) > 40:
            raise ValueError("Reference count exceeds bounded audit limit")
        def head(reference):
            if not safe_ref(reference):
                return {"file": str(reference), "error": "unsafe relative reference"}
            request = urllib.request.Request(BASE + f"{slug}/v{version}/" + urllib.parse.quote(reference, safe="/"), method="HEAD")
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    return {"file": reference, "status": response.status, "bytes": response.headers.get("Content-Length"), "content_type": response.headers.get("Content-Type")}
            except urllib.error.HTTPError as error:
                return {"file": reference, "status": error.code}
            except OSError as error:
                return {"file": reference, "error": str(error)}
        report["referenced_assets"] = list(ThreadPoolExecutor(max_workers=4).map(head, sorted(references)))
        report["referenced_asset_count"] = len(references)
        report["unavailable_assets"] = [r for r in report["referenced_assets"] if r.get("status") != 200]
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("platform/var/production-migration/storage"))
    parser.add_argument("--check-remote-assets", action="store_true")
    args = parser.parse_args()
    output = {"recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "scope": "Read-only published storage integrity; not a database backup or merge approval", "bundles": []}
    for slug, version in TARGETS:
        output["bundles"].append(audit(args.cache, slug, version, args.check_remote_assets))
    report = args.cache / ("bundle-integrity.json" if args.check_remote_assets else "bundle-integrity-core.json")
    report.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
