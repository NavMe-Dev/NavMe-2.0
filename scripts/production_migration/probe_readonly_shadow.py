"""Probe actual read-only local shadow APIs; never call production mutations.

The origin is constrained to loopback. POST probes are route computations or
an invalid feedback body that cannot pass validation even without the mode gate.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.parse import urlparse

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8782")
    parser.add_argument("--output", type=Path, default=Path("docs/production-migration/evidence/read-only-shadow-api.json"))
    args = parser.parse_args()
    target = urlparse(args.origin)
    if target.scheme != "http" or target.hostname not in {"127.0.0.1", "localhost", "::1"} or target.username or target.password:
        raise ValueError("Only an explicit loopback shadow origin is permitted")
    observations = []
    with httpx.Client(base_url=args.origin, timeout=120, follow_redirects=False) as client:
        mode = client.get("/api/v1/public/config")
        if mode.status_code != 200 or mode.json().get("read_only") is not True:
            raise RuntimeError("Shadow must explicitly report read-only mode before probing")

        def request(path, *, payload=None, expected=200, label=None):
            began = time.perf_counter()
            response = client.get(path) if payload is None else client.post(path, json=payload)
            row = {"label": label or path, "method": "GET" if payload is None else "POST", "path": path,
                   "status": response.status_code, "expected_status": expected,
                   "elapsed_ms": round((time.perf_counter()-began)*1000, 3), "bytes": len(response.content),
                   "pass": response.status_code == expected}
            observations.append(row)
            return response, row

        request("/api/live")
        request("/api/health")
        manifest, manifest_row = request("/api/v1/public/venues/all/manifest.json")
        data = manifest.json()
        manifest_row["schema"] = data.get("schema")
        manifest_row["published_buildings"] = [{"slug": b["slug"], "version": b["version"], "floors": len(b["floors"])} for b in data["buildings"]]
        if manifest_row["published_buildings"] != [{"slug": "gcu", "version": 5, "floors": 5}]:
            raise RuntimeError("Shadow publication differs from the reviewed unchanged GCU v5 scope")
        for name in ["config.json", "pois.json", "nav_graph.json", "georef.json", "indoor_F1.geojson"]:
            response, row = request(f"/api/v1/public/buildings/gcu/data/{name}")
            body = response.json()
            if name == "pois.json":
                row["poi_count"] = len(body.get("pois", []))
            if name == "nav_graph.json":
                row.update(node_count=len(body.get("nodes", [])), edge_count=len(body.get("edges", [])))
        for path in ["/api/v1/public/dashboard/buildings/gcu/navme-pois",
                     "/api/v1/public/dashboard/buildings/gcu/navme-categories",
                     "/api/v1/public/buildings/gcu/navme-floors",
                     "/api/v1/public/buildings/gcu/translations",
                     "/api/v1/public/buildings/gcu/venue-info",
                     "/api/v1/public/buildings/gcu/explore"]:
            response, row = request(path)
            if response.status_code == 200:
                body = response.json()
                if isinstance(body, list):
                    row["items"] = len(body)
                elif isinstance(body, dict):
                    row["array_lengths"] = {key: len(value) for key,value in body.items() if isinstance(value,(list,dict))}
        probes = json.loads(Path("docs/production-migration/evidence/storage/authentic-route-probes.json").read_text())
        for probe in probes:
            if probe["slug"] != "gcu":
                continue
            expected = 200 if probe["result"] == "ROUTE" else 404
            response, row = request("/api/v1/public/buildings/gcu/route", expected=expected,
                label=f"{probe['kind']}, step_free={probe['step_free']}",
                payload={"from_key": probe["from_poi_id"], "to_key": probe["to_poi_id"], "step_free": probe["step_free"]})
            if response.status_code == 200:
                body = response.json()
                row.update(length_m=body.get("length_m"), floors=body.get("floors"), geometry_points=len(body.get("geometry", {}).get("coordinates", [])))
        request("/api/v1/public/buildings/gcu/route", payload={"from_key":"__invalid_probe__","to_key":"__invalid_probe__"}, expected=404, label="invalid POI")
        request("/api/v1/public/venues/__invalid_probe__/manifest.json", expected=404, label="missing venue")
        request("/api/v1/admin/buildings", expected=401, label="anonymous admin denial")
        request("/api/v1/public/buildings/gcu/feedback", payload={}, expected=503, label="read-only mutation gate (invalid body)")
    report = {"captured_at":datetime.now(timezone.utc).isoformat(), "origin":args.origin,
              "scope":"existing destination GCU v5; local shadow; warm cache; no production writes",
              "checks":len(observations), "passed":sum(row["pass"] for row in observations),
              "all_expected_statuses":all(row["pass"] for row in observations), "observations":observations}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({key:value for key,value in report.items() if key != "observations"}))
    return 0 if report["all_expected_statuses"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
