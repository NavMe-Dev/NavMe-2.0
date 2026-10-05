"""Management CLI:  wayfinding <command>

  migrate                         alembic upgrade head
  create-admin EMAIL [--password] create/update an admin user (prompts if no password)
  create-venue SLUG NAME
  add-building SLUG --name --model-id --matterpak PATH [--address|--lat --lon] [--venue] [--config extra.json]
  onboard SLUG [--steps a,b|--from STEP] [--force] [--wait]   queue a pipeline job (or --inline to run here)
  import-pois SLUG FILE.json      import a pois.json (e.g. the prototype's) – upsert by id, marks as curated
  publish SLUG [--notes]
  export-static OUTDIR [--venue SLUG]   write published bundles + manifest for static hosting
  worker [--once]                 run the job worker
  status"""
import argparse, getpass, json, shutil, sys, time
from pathlib import Path


def main(argv=None):
    ap = argparse.ArgumentParser(prog="wayfinding")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("migrate")
    a = sp.add_parser("create-admin"); a.add_argument("email"); a.add_argument("--password")
    v = sp.add_parser("create-venue"); v.add_argument("slug"); v.add_argument("name")
    b = sp.add_parser("add-building"); b.add_argument("slug"); b.add_argument("--name", required=True); b.add_argument("--model-id", required=True)
    b.add_argument("--matterpak", required=True); b.add_argument("--address"); b.add_argument("--lat", type=float); b.add_argument("--lon", type=float)
    b.add_argument("--venue"); b.add_argument("--config", help="JSON with extra pipeline options")
    o = sp.add_parser("onboard"); o.add_argument("slug"); o.add_argument("--steps"); o.add_argument("--from", dest="from_step"); o.add_argument("--force", action="store_true")
    o.add_argument("--inline", action="store_true", help="run in this process instead of queueing for the worker")
    ip = sp.add_parser("import-pois"); ip.add_argument("slug"); ip.add_argument("file"); ip.add_argument("--lock", action="store_true", default=True)
    p = sp.add_parser("publish"); p.add_argument("slug"); p.add_argument("--notes")
    e = sp.add_parser("export-static"); e.add_argument("outdir"); e.add_argument("--venue", default="all"); e.add_argument("--viewer", help="copy viewer files too")
    w = sp.add_parser("worker"); w.add_argument("--once", action="store_true")
    sp.add_parser("status")
    args = ap.parse_args(argv)

    if args.cmd == "migrate":
        from alembic.config import Config
        from alembic import command
        ini = Path(__file__).resolve().parent.parent / "alembic.ini"
        cfg = Config(str(ini)); cfg.set_main_option("script_location", str(ini.parent / "alembic"))
        command.upgrade(cfg, "head"); print("database migrated"); return 0
    if args.cmd == "worker":
        from .services.jobs import worker_loop
        print("worker started"); worker_loop(once=args.once); return 0

    from .db import SessionLocal
    from . import models
    from .auth import hash_password
    db = SessionLocal()
    if args.cmd == "create-admin":
        pw = args.password or getpass.getpass("password: ")
        if len(pw) < 8: print("password must be >= 8 chars"); return 1
        u = db.query(models.User).filter_by(email=args.email.lower()).first() or models.User(email=args.email.lower())
        u.password_hash = hash_password(pw); u.is_admin = True; db.add(u); db.commit(); print("admin ready:", u.email); return 0
    if args.cmd == "create-venue":
        if not db.query(models.Venue).filter_by(slug=args.slug).first():
            db.add(models.Venue(slug=args.slug, name=args.name)); db.commit()
        print("venue", args.slug); return 0
    if args.cmd == "add-building":
        from geoalchemy2.elements import WKTElement
        bd = db.query(models.Building).filter_by(slug=args.slug).first() or models.Building(slug=args.slug)
        bd.name = args.name; bd.matterport_model_id = args.model_id; bd.matterpak_path = str(Path(args.matterpak).resolve()); bd.address = args.address
        if args.lat is None and args.address:
            from wfpipe.cli import geocode
            r = geocode(args.address)
            if r: args.lat, args.lon = r[0], r[1]; print("geocoded", r)
        bd.lat, bd.lon = args.lat, args.lon
        if bd.lat is not None: bd.location = WKTElement(f"POINT({bd.lon} {bd.lat})", srid=4326)
        if args.config: bd.pipeline_config = json.load(open(args.config))
        if args.venue:
            vv = db.query(models.Venue).filter_by(slug=args.venue).first() or models.Venue(slug=args.venue, name=args.venue.title())
            bd.venue = vv
        db.add(bd); db.commit(); print("building", bd.slug, "id", bd.id); return 0
    if args.cmd == "onboard":
        bd = db.query(models.Building).filter_by(slug=args.slug).one()
        params = {"steps": args.steps.split(",") if args.steps else None, "from_step": args.from_step, "force": args.force}
        j = models.Job(building_id=bd.id, kind="onboard", params=params, created_by="cli"); db.add(j); db.commit(); print("job", j.id, "queued")
        if args.inline:
            from .services.jobs import claim, run_job
            jid = claim(db)
            run_job(jid); db.expire_all(); j = db.get(models.Job, j.id); print("job", j.id, j.status, j.error or ""); return 0 if j.status == "succeeded" else 1
        return 0
    if args.cmd == "import-pois":
        from geoalchemy2.elements import WKTElement
        from .services.workspace import recompute_step_free
        bd = db.query(models.Building).filter_by(slug=args.slug).one(); d = json.load(open(args.file)); n = 0
        for p in d["pois"]:
            row = db.query(models.POI).filter_by(building_id=bd.id, key=p["id"]).first() or models.POI(building_id=bd.id, key=p["id"])
            row.name = p["name"]; row.code = p.get("code"); row.category = p["category"]; row.floor = p["floor"]
            row.geom = WKTElement(f"POINT({p['lonlat'][0]} {p['lonlat'][1]})", srid=4326)
            m = p.get("model") or {}; row.model_x, row.model_y, row.model_z = m.get("x"), m.get("y"), m.get("z")
            row.nearest_node = p.get("nearest_node"); row.nearest_sweep_label = p.get("nearest_sweep_label"); row.room_id = p.get("room_id")
            row.description = p.get("note") or row.description; row.source = "seed"; row.locked = args.lock; row.published = True
            db.add(row); n += 1
        db.commit(); recompute_step_free(db, bd); print("imported", n, "POIs"); return 0
    if args.cmd == "publish":
        from .services.publish import publish
        bd = db.query(models.Building).filter_by(slug=args.slug).one(); mv = publish(db, bd, "cli", args.notes); print("published", bd.slug, "v%d" % mv.version); return 0
    if args.cmd == "export-static":
        from .routers.public import venue_manifest
        from .services.publish import current_version
        out = Path(args.outdir); api = out / "api" / "v1" / "public"
        man = venue_manifest(db, args.venue)
        (api / "venues" / man["slug"]).mkdir(parents=True, exist_ok=True)
        (api / "venues" / man["slug"] / "manifest.json").write_text(json.dumps(man, indent=1))
        for it in man["buildings"]:
            bd = db.query(models.Building).filter_by(slug=it["slug"]).one(); mv = current_version(db, bd)
            dst = api / "buildings" / bd.slug / "data"
            if dst.exists(): shutil.rmtree(dst)
            shutil.copytree(mv.path, dst)
        if args.viewer:
            for f in Path(args.viewer).iterdir():
                t = out / f.name
                if f.is_dir(): shutil.copytree(f, t, dirs_exist_ok=True)
                else: shutil.copy2(f, t)
            (out / "wf-config.js").write_text("window.WF_CONFIG = " + json.dumps({"apiBase": "api/v1/public/", "venue": man["slug"], "static": True}) + ";\n")
        print("static export ->", out.resolve(), [b["slug"] for b in man["buildings"]]); return 0
    if args.cmd == "status":
        for bd in db.query(models.Building):
            print(bd.slug, bd.status, bd.name)
        return 0


if __name__ == "__main__":
    sys.exit(main())
