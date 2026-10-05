"""wfpipe command line.

  wfpipe init   <workspace> --name .. --model-id .. --matterpak PATH [--address ..|--lat .. --lon ..] [--slug ..]
  wfpipe run    <workspace> [--steps a,b] [--from STEP] [--force] [--force-steps a,b]
  wfpipe status <workspace>
  wfpipe steps
  wfpipe geocode "address"
"""
import argparse, json, sys, logging
from pathlib import Path
from .context import Context
from . import runner


def geocode(address, provider="nominatim"):
    import urllib.request, urllib.parse
    if provider == "esri":
        u = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?" + urllib.parse.urlencode({"SingleLine": address, "f": "json", "maxLocations": 1})
        d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "wayfinding-platform/0.1"}), timeout=30))
        c = d.get("candidates") or []
        return (c[0]["location"]["y"], c[0]["location"]["x"], c[0]["address"]) if c else None
    u = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": address, "format": "json", "limit": 1})
    d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "wayfinding-platform/0.1 (self-hosted)"}), timeout=30))
    return (float(d[0]["lat"]), float(d[0]["lon"]), d[0]["display_name"]) if d else None


def main(argv=None):
    ap = argparse.ArgumentParser(prog="wfpipe", description="MatterPak -> indoor wayfinding data pipeline")
    sp = ap.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("init"); a.add_argument("workspace"); a.add_argument("--name", required=True); a.add_argument("--slug")
    a.add_argument("--model-id", required=True); a.add_argument("--matterpak", required=True); a.add_argument("--address")
    a.add_argument("--lat", type=float); a.add_argument("--lon", type=float); a.add_argument("--geocoder", default="esri", choices=["esri", "nominatim"])
    a.add_argument("--extra", help="JSON file merged into the config (stairs, georef, pois_seed, floors …)")
    r = sp.add_parser("run"); r.add_argument("workspace"); r.add_argument("--steps"); r.add_argument("--from", dest="from_step")
    r.add_argument("--force", action="store_true"); r.add_argument("--force-steps", default="")
    s = sp.add_parser("status"); s.add_argument("workspace")
    sp.add_parser("steps")
    g = sp.add_parser("geocode"); g.add_argument("address"); g.add_argument("--geocoder", default="esri", choices=["esri", "nominatim"])
    args = ap.parse_args(argv)
    if args.cmd == "steps":
        for n, (mod, deps, keys, outs) in runner.STEPS.items():
            print(f"{n:10s} deps={','.join(deps) or '-':38s} {(mod.__doc__ or '').strip().splitlines()[0]}")
        return 0
    if args.cmd == "geocode":
        print(json.dumps(geocode(args.address, args.geocoder))); return 0
    if args.cmd == "init":
        cfg = {"name": args.name, "slug": args.slug or Path(args.workspace).name, "matterport_model_id": args.model_id,
               "matterpak": str(Path(args.matterpak).resolve()), "address": args.address}
        if args.lat is not None:
            cfg.update(lat=args.lat, lon=args.lon)
        elif args.address:
            gc = geocode(args.address, args.geocoder)
            if gc: cfg.update(lat=gc[0], lon=gc[1]); print("geocoded:", gc)
        if args.extra:
            cfg.update(json.load(open(args.extra)))
        Context(args.workspace, cfg); print("workspace ready:", Path(args.workspace).resolve()); return 0
    ctx = Context(args.workspace)
    if args.cmd == "status":
        for n in runner.ORDER:
            st = ctx.state.get(n, {}); print(f"{n:10s} {st.get('status','-'):8s} {st.get('seconds','')}")
        return 0
    try:
        summ = runner.run(ctx, steps=args.steps.split(",") if args.steps else None, force=args.force, from_step=args.from_step,
                          force_steps=[x for x in args.force_steps.split(",") if x])
    except Exception as e:
        print("FAILED:", e, file=sys.stderr); return 1
    print(json.dumps(summ)); return 0


if __name__ == "__main__":
    sys.exit(main())
