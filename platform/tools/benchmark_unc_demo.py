#!/usr/bin/env python3
"""Paced, loopback-only UNC API regression benchmark. Never loads production.

Run with the project's Python environment. --source selects the exact application
tree (for example the frozen live-base snapshot); the harness lives outside it.
Only an isolated local database ending in _test and copied publication files are
written. Credentials are read privately from --local-env and never serialized.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
from contextlib import asynccontextmanager
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import platform
import random
import resource
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import unquote


SLUG = "unc-demo-benchmark"
DATABASE = "navme_demo_benchmark_test"
TIERS = [1, 10, 25, 40, 60, 100]


def private_local_url(env_file):
    from sqlalchemy.engine import make_url
    raw = next((line.split("=", 1)[1].strip().strip('"').strip("'")
                for line in Path(env_file).read_text().splitlines()
                if line.startswith("DATABASE_URL=")), "")
    url = make_url(raw)
    if url.host not in {"localhost", "127.0.0.1", "::1"} or url.query:
        raise RuntimeError("Benchmark requires an explicit loopback database without routing overrides")
    return url.set(database=DATABASE, drivername="postgresql+psycopg").render_as_string(hide_password=False)


def percentile(values, p):
    if not values:
        return None
    xs = sorted(values)
    at = (len(xs) - 1) * p
    lo = math.floor(at)
    return round(xs[lo] + (xs[min(lo+1, len(xs)-1)]-xs[lo])*(at-lo), 2)


def summary(values):
    return {"count": len(values), "p50_ms": percentile(values, .50),
            "p95_ms": percentile(values, .95), "p99_ms": percentile(values, .99),
            "max_ms": round(max(values), 2) if values else None}


def serve(args):
    """Real production application and handlers; extra diagnostics are local only."""
    sys.path[:0] = [str(Path(args.source)/"platform/api"), str(Path(args.source)/"platform/pipeline")]
    run = Path(args.run_dir)
    fixture = Path(args.fixture)
    pub = run/"published"/SLUG/"v2"
    pub.mkdir(parents=True, exist_ok=True)
    for name in ["config.json", "nav_graph.json", "pois.json", "georef.json", "navmesh.json"]:
        shutil.copyfile(fixture/name, pub/name)
    counts = collections.Counter()
    lock = threading.Lock()
    origin_state = {"active": 0, "peak": 0}

    class Origin(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            name = unquote(self.path).rsplit("/", 1)[-1]
            if name != "floor_F2.webp":
                self.send_error(404)
                return
            with lock:
                counts["origin_downloads"] += 1
                origin_state["active"] += 1
                origin_state["peak"] = max(origin_state["peak"], origin_state["active"])
            try:
                # Controlled 150ms local origin latency, identical before/after.
                time.sleep(.15)
                data = (fixture/name).read_bytes()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                with lock:
                    origin_state["active"] -= 1
        def log_message(self, *args):
            pass

    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    os.environ.update({"DATABASE_URL": private_local_url(args.local_env), "DATA_DIR": str(run),
                       "DB_POOL_SIZE": str(args.pool_size), "DB_MAX_OVERFLOW": str(args.max_overflow), "DB_POOL_TIMEOUT_SECONDS": str(args.pool_timeout),
                       "DB_SSLMODE": "disable", "WORKER_INLINE": "false", "WF_READ_ONLY": "true",
                       "DB_READ_ONLY": "true", "DB_STARTUP_CHECK": "true", "RUN_MIGRATIONS": "false",
                       "JWT_SECRET": "local-benchmark-secret-0123456789abcdef", "VIEWER_DIR": "",
                       "ADMIN_DIR": "", "SUPABASE_URL": "http://127.0.0.1:"+str(origin.server_port),
                       "SUPABASE_ANON_KEY": "", "SUPABASE_SERVICE_ROLE_KEY": "",
                       "STUDIO_SUPABASE_URL": "", "STUDIO_LIVE_BUILDINGS": "",
                       "POI_VIEWPOINT_DATABASE_URL": "", "CAMERA_VIEWPOINT_DATABASE_URL": ""})
    # Pydantic optional Path fields accept omission rather than an empty string.
    os.environ.pop("VIEWER_DIR"); os.environ.pop("ADMIN_DIR")
    for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
        os.environ.pop(name, None)
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import Session
    from wayfinding_api import models
    from wayfinding_api.db import Base
    setup_engine = create_engine(os.environ["DATABASE_URL"], hide_parameters=True)
    Base.metadata.create_all(setup_engine)
    georef = json.loads((fixture/"georef.json").read_bytes())
    with Session(setup_engine) as db:
        b = db.query(models.Building).filter_by(slug=SLUG).first()
        if b is None:
            b = models.Building(slug=SLUG, name="Isolated UNC benchmark", georef=georef,
                                matterport_model_id="local-fixture-model", pipeline_config={})
            db.add(b); db.flush()
            db.add(models.MapVersion(building_id=b.id, version=2, path=str(pub), is_current=True))
        else:
            b.georef = georef
            for mv in db.query(models.MapVersion).filter_by(building_id=b.id):
                mv.path = str(pub); mv.is_current = True
        db.commit()
    setup_engine.dispose()
    from wayfinding_api.services import navgraph, bundle_storage
    build = navgraph.build
    def observed_build(*a, **kw):
        with lock:
            counts["graph_builds"] += 1
        return build(*a, **kw)
    navgraph.build = observed_build
    read = bundle_storage.read_bundle_file
    def observed_read(*a, **kw):
        with lock:
            counts["read_"+str(a[3])] += 1
        return read(*a, **kw)
    bundle_storage.read_bundle_file = observed_read
    from wayfinding_api.main import create_app
    from wayfinding_api import db as application_db
    app = create_app()
    if args.thread_tokens:
        original_lifespan=app.router.lifespan_context
        @asynccontextmanager
        async def benchmark_thread_bound(application):
            import anyio
            limiter=anyio.to_thread.current_default_thread_limiter()
            previous=limiter.total_tokens
            limiter.total_tokens=args.thread_tokens
            try:
                async with original_lifespan(application):
                    yield
            finally:
                limiter.total_tokens=previous
        app.router.lifespan_context=benchmark_thread_bound
    pool = application_db.engine()
    if args.db_roundtrip_delay_ms:
        @event.listens_for(pool, "before_cursor_execute")
        def simulate_select_latency(connection, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                with lock:
                    counts["synthetic_select_delays"] += 1
                # Local diagnostic only; no SQL mutation or remote traffic.
                # This approximates a connection held across a SELECT roundtrip,
                # not actual hosted network/protocol behavior.
                time.sleep(args.db_roundtrip_delay_ms / 1000)
    pool_state = {"checked_out": 0, "peak": 0, "physical_connects": 0}
    checkout_waits=[]
    connection_holds=[]
    original_do_get=pool.pool._do_get
    def observed_do_get():
        start=time.perf_counter()
        try:
            return original_do_get()
        finally:
            checkout_waits.append((time.perf_counter()-start)*1000)
    pool.pool._do_get=observed_do_get
    @event.listens_for(pool, "checkout")
    def checkout(*_):
        _[1].info["benchmark_checkout_start"]=time.perf_counter()
        with lock:
            pool_state["checked_out"] += 1
            pool_state["peak"] = max(pool_state["peak"], pool_state["checked_out"])
    @event.listens_for(pool, "checkin")
    def checkin(*_):
        started=_[1].info.pop("benchmark_checkout_start",None)
        if started is not None:
            connection_holds.append((time.perf_counter()-started)*1000)
        with lock:
            pool_state["checked_out"] -= 1
    @event.listens_for(pool, "connect")
    def connect(*_):
        with lock:
            pool_state["physical_connects"] += 1

    @app.get("/__benchmark/metrics")
    async def metrics(detail: bool=False):
        import anyio
        usage = resource.getrusage(resource.RUSAGE_SELF)
        limiter = anyio.to_thread.current_default_thread_limiter()
        result = {"counts": dict(counts), "pool": dict(pool_state), "origin": dict(origin_state),
                  "rss_peak_bytes": usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss*1024,
                  "cpu_seconds": usage.ru_utime+usage.ru_stime,
                  "worker_tokens_used": limiter.borrowed_tokens, "worker_tokens_total": limiter.total_tokens,
                  "threads": threading.active_count(),
                  "uvicorn":{"open_connections":len(uvicorn_server.server_state.connections),
                             "active_tasks":len(uvicorn_server.server_state.tasks),
                             "peak_connections":counts.get("uvicorn_peak_connections",0)},
                  "db_durations":{"checkout_wait":summary(checkout_waits),"connection_hold":summary(connection_holds)},
                  "db_duration_note":"Checkout timing includes queue wait and any physical connect. Hold timing runs checkout to checkin; diagnostics are benchmark-only."}
        if detail:
            result["db_duration_samples"]={"checkout_wait_ms":list(checkout_waits),"connection_hold_ms":list(connection_holds)}
        try:
            from wayfinding_api.services import routing_cache
            result["routing_cache"] = routing_cache.cache_info()
        except (ImportError, AttributeError):
            pass
        return result

    @app.get("/__benchmark/cold-floor")
    async def cold_floor():
        (pub/"floor_F2.webp").unlink(missing_ok=True)
        return {"ok": True}

    @app.get("/__benchmark/hold")
    async def controlled_overlap():
        # A small test-only overlap window proves Uvicorn admission behavior
        # without expensive routes, a request flood or a production endpoint.
        await asyncio.sleep(.3)
        return {"ok": True}

    @app.get("/__benchmark/cold-routing")
    async def cold_routing():
        from wayfinding_api.services import routing_cache
        routing_cache._cache.clear()
        return {"ok": True}

    import uvicorn
    from uvicorn.protocols.http.auto import AutoHTTPProtocol
    class ObservedHTTPProtocol(AutoHTTPProtocol):
        def connection_made(self, transport):
            super().connection_made(transport)
            counts["uvicorn_peak_connections"]=max(counts["uvicorn_peak_connections"],len(self.connections))
    uvicorn_server=uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port,
                                  log_level="error",access_log=False,http=ObservedHTTPProtocol,
                                  limit_concurrency=args.admission_limit or None,backlog=128))
    uvicorn_server.run()


async def exercise_overload(args, proc):
    """Only sixteen local cheap requests; require controlled rejection + recovery."""
    import httpx
    base=f"http://127.0.0.1:{args.port}"
    async with httpx.AsyncClient(base_url=base,timeout=5,trust_env=False) as client:
        for _ in range(200):
            if proc.poll() is not None:
                raise RuntimeError("Local admission worker exited before readiness")
            try:
                if (await client.get("/api/health")).status_code==200:
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(.1)
        else:
            raise RuntimeError("Local admission worker did not become ready")
    samples=[]
    async with httpx.AsyncClient(base_url=base,timeout=5,trust_env=False,
                                limits=httpx.Limits(max_connections=16,max_keepalive_connections=0)) as client:
        async def one():
            start=time.perf_counter()
            try:
                response=await client.get("/__benchmark/hold")
                samples.append({"status":response.status_code,"ms":round((time.perf_counter()-start)*1000,2)})
            except httpx.HTTPError as exc:
                samples.append({"status":0,"error_class":type(exc).__name__,"ms":round((time.perf_counter()-start)*1000,2)})
        await asyncio.gather(*(one() for _ in range(16)))
    recovered=[]
    async with httpx.AsyncClient(base_url=base,timeout=5,trust_env=False) as client:
        for _ in range(3):
            start=time.perf_counter();response=await client.get("/api/health")
            recovered.append({"status":response.status_code,"ms":round((time.perf_counter()-start)*1000,2)})
            await asyncio.sleep(.1)
        metrics=(await client.get("/__benchmark/metrics")).json()
    statuses=dict(collections.Counter(str(x["status"]) for x in samples))
    passed=(statuses.get("503",0)>0 and all(x["status"] in {200,503} for x in samples)
            and all(x["status"]==200 for x in recovered) and proc.poll() is None)
    result={"schema":"navme.local-admission-test/v1","local_only":True,
            "created_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
            "source":str(Path(args.source).resolve()),"admission_limit":args.admission_limit,
            "backlog":128,"cheap_overlapping_requests":16,"overlap_seconds":.3,
            "status_counts":statuses,"requests":samples,"recovery_readiness":recovered,
            "process_still_running":proc.poll() is None,"metrics_after":metrics,"passed":passed,
            "interpretation":"This verifies bounded Uvicorn rejection and recovery only. Connection/task limit is not a simultaneous-user capacity guarantee.",
            "official_references":["https://uvicorn.dev/settings/","https://uvicorn.dev/server-behavior/"]}
    if not passed:
        raise RuntimeError("Controlled admission/recovery test failed: "+json.dumps(statuses))
    return result


async def exercise(args, proc):
    import httpx
    base = f"http://127.0.0.1:{args.port}"
    limits = httpx.Limits(max_connections=130, max_keepalive_connections=130)
    async with httpx.AsyncClient(base_url=base, timeout=30, limits=limits, trust_env=False) as client:
        for _ in range(200):
            if proc.poll() is not None:
                raise RuntimeError("Local benchmark worker exited before readiness; inspect its private log")
            try:
                r = await client.get("/api/health")
                if r.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(.1)
        else:
            raise RuntimeError("Local benchmark did not become ready")
        startup_metrics = (await client.get("/__benchmark/metrics")).json()
        fixture = Path(args.fixture)
        nav = json.loads((fixture/"nav_graph.json").read_bytes())
        pois = json.loads((fixture/"pois.json").read_bytes())["pois"]
        import networkx as nx
        graph = nx.Graph(); graph.add_edges_from((e["u"],e["v"]) for e in nav["edges"])
        component = max(nx.connected_components(graph), key=len)
        candidates = [p for p in pois if p.get("nearest_node") in component]
        # Fixed actual publication POIs, distinct scans; repeat exact pairs across both runs.
        pairs = []
        for a in candidates:
            b = next((b for b in reversed(candidates) if b["nearest_node"] != a["nearest_node"]), None)
            if b:
                pairs.append({"from_key": a["id"], "to_key": b["id"], "step_free": False})
            if len(pairs) == 4:
                break
        reference = []
        for pair in pairs:
            r = await client.post(f"/api/v1/public/buildings/{SLUG}/route", json=pair)
            if r.status_code != 200:
                raise RuntimeError("Fixture reference route is unavailable: status "+str(r.status_code))
            reference.append(hashlib.sha256(json.dumps(r.json(), sort_keys=True).encode()).hexdigest())
        reference_metrics = (await client.get("/__benchmark/metrics")).json()
        rows = []
        for users in args.tiers:
            reset = await client.get("/__benchmark/cold-floor")
            if reset.status_code != 200:
                raise RuntimeError("Could not prepare the local cold-floor fixture")
            before = (await client.get("/__benchmark/metrics")).json()
            samples, errors, route_hashes, probes, process_samples = [], [], [], [], []
            active = True
            async def sample():
                while active:
                    t = time.perf_counter()
                    try:
                        r = await client.get("/api/live", timeout=5)
                        probes.append({"status": r.status_code, "ms": (time.perf_counter()-t)*1000})
                        if r.status_code == 200:
                            process_samples.append((await client.get("/__benchmark/metrics", timeout=5)).json())
                    except httpx.HTTPError as e:
                        probes.append({"status": 0, "error_class": type(e).__name__, "ms": (time.perf_counter()-t)*1000})
                    await asyncio.sleep(.25)
            async def request(kind, method, path, **kwargs):
                t = time.perf_counter()
                try:
                    r = await client.request(method, path, **kwargs)
                    samples.append({"kind": kind, "ms": (time.perf_counter()-t)*1000, "status": r.status_code, "bytes": len(r.content)})
                    if r.status_code != 200:
                        layer="other"
                        if r.status_code==503 and r.text.strip()=="Service Unavailable":
                            layer="uvicorn_admission"
                        elif r.status_code==503:
                            try:
                                detail=r.json().get("detail")
                                if detail=="database unavailable":layer="database"
                                elif detail=="routing preparation unavailable":layer="routing_preparation"
                            except (ValueError,AttributeError):
                                pass
                        errors.append({"kind":kind,"status":r.status_code,"layer":layer})
                    if kind == "route" and r.status_code == 200:
                        route_hashes.append(hashlib.sha256(json.dumps(r.json(),sort_keys=True).encode()).hexdigest())
                    return r.status_code == 200
                except httpx.HTTPError as e:
                    samples.append({"kind":kind,"ms":(time.perf_counter()-t)*1000,"status":0,"bytes":0})
                    errors.append({"kind":kind,"status":0,"error_class":type(e).__name__})
                    return False
            async def journey(i):
                rnd = random.Random(i)
                await asyncio.sleep(rnd.uniform(0,.05))
                await request("floor", "GET", f"/api/v1/public/buildings/{SLUG}/data/floor_F2.webp")
                await asyncio.sleep(.15+rnd.uniform(0,.1))
                await request("config", "GET", f"/api/v1/public/buildings/{SLUG}/data/config.json")
                await request("pois", "GET", f"/api/v1/public/buildings/{SLUG}/data/pois.json")
                for j in range(2):
                    await asyncio.sleep(.25+rnd.uniform(0,.15))
                    await request("route", "POST", f"/api/v1/public/buildings/{SLUG}/route", json=pairs[(i+j)%len(pairs)])
            sampler = asyncio.create_task(sample())
            start = time.perf_counter()
            await asyncio.gather(*(journey(i) for i in range(users)))
            elapsed = time.perf_counter()-start
            active = False
            await sampler
            after = (await client.get("/__benchmark/metrics?detail=true")).json()
            recovered = []
            for _ in range(3):
                t=time.perf_counter(); r=await client.get("/api/health")
                recovered.append({"status":r.status_code,"ms":round((time.perf_counter()-t)*1000,2)})
                await asyncio.sleep(.1)
            counts = {k:after["counts"].get(k,0)-before["counts"].get(k,0) for k in set(before["counts"])|set(after["counts"])}
            route_mismatches=sum(h not in reference for h in route_hashes)
            row={"concurrent_users":users,"wall_seconds":round(elapsed,3),"requests":len(samples),
                 "failures":len(errors),"failure_percent":round(100*len(errors)/max(1,len(samples)),3),
                 "errors":errors[:10],"all_http":summary([x["ms"] for x in samples]),
                 "route":summary([x["ms"] for x in samples if x["kind"]=="route"]),
                 "floor":summary([x["ms"] for x in samples if x["kind"]=="floor"]),
                 "counts":counts,"route_geometry_mismatches":route_mismatches,
                 "rss_peak_mib":round(after["rss_peak_bytes"]/1024**2,2),
                 "cpu_seconds":round(after["cpu_seconds"]-before["cpu_seconds"],3),
                 "cpu_percent_of_one_core":round(100*(after["cpu_seconds"]-before["cpu_seconds"])/elapsed,1),
                 "db_pool_peak":after["pool"]["peak"],"db_pool_checked_out_after":after["pool"]["checked_out"],
                 "physical_db_connections":after["pool"]["physical_connects"],
                 "db_checkout_wait":summary(after["db_duration_samples"]["checkout_wait_ms"][before["db_durations"]["checkout_wait"]["count"]:]),
                 "db_connection_hold":summary(after["db_duration_samples"]["connection_hold_ms"][before["db_durations"]["connection_hold"]["count"]:]),
                 "peak_worker_tokens":max([x["worker_tokens_used"] for x in process_samples]+[0]),
                 "worker_tokens_total":after["worker_tokens_total"],
                 "uvicorn_after":after["uvicorn"],
                 "liveness":summary([x["ms"] for x in probes]),"liveness_failures":sum(x["status"]!=200 for x in probes),
                 "recovery_readiness":recovered,"routing_cache":after.get("routing_cache")}
            rows.append(row)
            print(json.dumps({"label":args.label,"tier":users,"failures":len(errors),"route_p95_ms":row["route"]["p95_ms"],"floor_p95_ms":row["floor"]["p95_ms"],"rss_mib":row["rss_peak_mib"],"graph_builds":counts.get("graph_builds",0),"origin_downloads":counts.get("origin_downloads",0)}),flush=True)
            # Conservative stop: HTTP or semantic instability, unhealthy worker,
            # >8-second p95 route, or the 512MiB production memory ceiling.
            if errors or route_mismatches or row["liveness_failures"] or any(x["status"]!=200 for x in recovered) or row["route"]["p95_ms"]>8000 or row["rss_peak_mib"]>512:
                row["stop_reason"]="instability_or_latency_or_memory_gate"
                break
            await asyncio.sleep(.5)
        cold_result = None
        if args.cold_cohort and not any(row.get("stop_reason") for row in rows):
            reset=await client.get("/__benchmark/cold-routing")
            if reset.status_code!=200:
                raise RuntimeError("Could not prepare cold in-memory routing fixture")
            before=(await client.get("/__benchmark/metrics")).json()
            cold_samples=[]
            async def cold_one(i):
                await asyncio.sleep(random.Random(i).uniform(0,.05))
                start=time.perf_counter()
                try:
                    response=await client.post(f"/api/v1/public/buildings/{SLUG}/route",json=pairs[i%len(pairs)])
                    fingerprint=hashlib.sha256(json.dumps(response.json(),sort_keys=True).encode()).hexdigest() if response.status_code==200 else None
                    cold_samples.append({"status":response.status_code,"ms":(time.perf_counter()-start)*1000,"geometry_matches":fingerprint==reference[i%len(pairs)]})
                except httpx.HTTPError as exc:
                    cold_samples.append({"status":0,"error_class":type(exc).__name__,"ms":(time.perf_counter()-start)*1000,"geometry_matches":False})
            start=time.perf_counter()
            await asyncio.gather(*(cold_one(i) for i in range(args.cold_cohort)))
            after=(await client.get("/__benchmark/metrics")).json()
            count_delta={k:after["counts"].get(k,0)-before["counts"].get(k,0) for k in set(before["counts"])|set(after["counts"])}
            old_cache=before.get("routing_cache",{});new_cache=after.get("routing_cache",{})
            cache_delta={k:new_cache.get(k,0)-old_cache.get(k,0) for k in ["hits","misses","waits","builds","failures","timeouts"]}
            health=await client.get("/api/health")
            cold_result={"concurrent_requests":args.cold_cohort,"cold_scope":"In-memory published routing cache evicted; unchanged real local bundle files retained. Not a new-process cold start.",
                         "wall_seconds":round(time.perf_counter()-start,3),"http":summary([x["ms"] for x in cold_samples]),
                         "status_counts":dict(collections.Counter(str(x["status"]) for x in cold_samples)),
                         "failures":sum(x["status"]!=200 for x in cold_samples),"geometry_mismatches":sum(not x["geometry_matches"] for x in cold_samples),
                         "counts":count_delta,"cache_delta":cache_delta,"rss_peak_before_mib":round(before["rss_peak_bytes"]/1024**2,2),
                         "rss_peak_after_mib":round(after["rss_peak_bytes"]/1024**2,2),"rss_note":"Whole-process high-water RSS includes this cold cohort and all preceding warm tiers; not instantaneous resident allocation.",
                         "db_pool_peak":after["pool"]["peak"],"db_pool_checked_out_after":after["pool"]["checked_out"],
                         "recovery_health_status":health.status_code}
            cold_result["passed"]=(cold_result["failures"]==0 and cold_result["geometry_mismatches"]==0
                                  and count_delta.get("graph_builds")==2 and cache_delta.get("builds")==1
                                  and count_delta.get("read_nav_graph.json")==1 and health.status_code==200)
            print(json.dumps({"cold_routing":cold_result}),flush=True)
        return {"schema":"navme.local-demo-benchmark/v1","label":args.label,"created_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
                "application_source":str(Path(args.source).resolve()),"baseline_commit":"74f37ed55f62d921ced485020389a1150f47facc",
                "local_only":True,"database":"loopback isolated *_test","api_workers":1,"pool_size":args.pool_size,"max_overflow":args.max_overflow,"pool_timeout_seconds":args.pool_timeout,"synthetic_select_delay_ms":args.db_roundtrip_delay_ms,"admission_limit":args.admission_limit or None,"backlog":128,
                "machine":platform.machine(),"platform":platform.platform(),"logical_cpus":os.cpu_count(),
                "reference_preflight":{"requests":len(pairs),"startup_metrics":startup_metrics,"after_metrics":reference_metrics,"note":"Reference routes intentionally precede timed tiers. On the stabilized API they warm one publication; tier hit/build deltas are measured after this preflight."},
                "fixture":{"source":"existing local real UNC publication v2; copied, never altered", "graph_bytes":(fixture/"nav_graph.json").stat().st_size,"nodes":len(nav["nodes"]),"edges":len(nav["edges"]),"graph_sha256":hashlib.sha256((fixture/"nav_graph.json").read_bytes()).hexdigest(),"floor2_bytes":(fixture/"floor_F2.webp").stat().st_size,"reference_route_hashes":reference},
                "schedule":{"tiers_requested":args.tiers,"journey":"cold shared Floor2 GET; paced config and POI GETs; two paced actual published routes", "origin":"loopback HTTP, actual floor image, controlled 150ms delay", "pace_seconds":[.15,.45],"stop_on":"any HTTP/geometry/liveness failure, route p95>8s, RSS>512MiB"},
                "limitations":["Local Apple host is not Render 0.5CPU/512MiB; results do not certify 100-user production capacity", "No remote Supabase, browser, Matterport, real-device GPU or mobile radio exercised", "Synthetic local storage latency does not reproduce real CDN/storage latency", "One finite paced journey per user per tier; not a long soak", "Uses existing local published pipeline POIs, not live Studio metadata queries"],"tiers":rows,"cold_routing_cohort":cold_result}


def run(args):
    run_dir = tempfile.mkdtemp(prefix="navme-unc-benchmark-")
    args.run_dir = run_dir
    source_root=Path(args.source).resolve()
    snapshot=Path(run_dir)/"application-snapshot"
    for relative in ["platform/api","platform/pipeline"]:
        shutil.copytree(source_root/relative,snapshot/relative,ignore=shutil.ignore_patterns("__pycache__","*.pyc","*.egg-info"))
    source_files=[]
    for relative in ["platform/api","platform/pipeline"]:
        for path in sorted((snapshot/relative).rglob("*.py")):
            source_files.append({"path":str(path.relative_to(snapshot)),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    entrypoint=source_root/"platform/deploy/start-api.sh"
    if entrypoint.exists():
        source_files.append({"path":"platform/deploy/start-api.sh","sha256":hashlib.sha256(entrypoint.read_bytes()).hexdigest()})
    source_fingerprint=hashlib.sha256(json.dumps(source_files,sort_keys=True).encode()).hexdigest()
    command = [sys.executable,str(Path(__file__).resolve()),"serve","--source",str(snapshot),
               "--fixture",args.fixture,"--local-env",args.local_env,"--run-dir",run_dir,"--port",str(args.port),
               "--admission-limit",str(args.admission_limit),"--thread-tokens",str(args.thread_tokens),
               "--pool-timeout",str(args.pool_timeout),"--pool-size",str(args.pool_size),
               "--max-overflow",str(args.max_overflow),"--db-roundtrip-delay-ms",str(args.db_roundtrip_delay_ms)]
    # Run from an empty directory: never consume repository .env/runtime overlays.
    with (Path(run_dir)/"server.log").open("w") as log:
        proc = subprocess.Popen(command,cwd=run_dir,stdout=log,stderr=log,env={k:v for k,v in os.environ.items() if not k.startswith(("PG","WF_","DB_","SUPABASE","STUDIO_","DATABASE","DATA_DIR","JWT_","MATTERPORT","WORKER_","VIEWER_DIR","ADMIN_DIR","POI_VIEWPOINT","CAMERA_VIEWPOINT"))})
        try:
            result=asyncio.run((exercise_overload if args.overload_only else exercise)(args,proc))
            result["source_fingerprint"]={"sha256":source_fingerprint,"files":source_files,"snapshot":str(snapshot),
                                          "note":"Python source copied before worker startup, so concurrent checkout edits cannot alter the running measurement. Entrypoint is fingerprinted; configured admission/backlog flags are passed explicitly to the harness and recorded separately."}
            result["benchmark_harness_sha256"]=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            result["benchmark_thread_token_override"]=args.thread_tokens or None
            output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
            output.write_text(json.dumps(result,indent=2)+"\n")
            print(json.dumps({"evidence":str(output),"tiers_completed":[x["concurrent_users"] for x in result.get("tiers",[])],"admission_test_passed":result.get("passed"),"private_local_log":str(Path(run_dir)/"server.log")}),flush=True)
        finally:
            proc.terminate()
            try:proc.wait(timeout=15)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=["run","serve"])
    parser.add_argument("--source",required=True)
    parser.add_argument("--fixture",required=True)
    parser.add_argument("--local-env",required=True)
    parser.add_argument("--port",type=int,default=18871)
    parser.add_argument("--run-dir",default="")
    parser.add_argument("--label",default="baseline")
    parser.add_argument("--output",default="docs/evidence/unc-demo-baseline.json")
    parser.add_argument("--tiers",type=int,nargs="+",default=TIERS)
    parser.add_argument("--admission-limit",type=int,default=0,
                        help="Uvicorn open-connection/task bound; 0 preserves the live-base unlimited setting")
    parser.add_argument("--overload-only",action="store_true")
    parser.add_argument("--cold-cohort",type=int,default=0)
    parser.add_argument("--thread-tokens",type=int,default=0,help="Benchmark-only lifespan override;0 preserves application default")
    parser.add_argument("--pool-timeout",type=int,choices=[5,15],default=5)
    parser.add_argument("--pool-size",type=int,default=3,help="Local-only bounded application pool; default unchanged")
    parser.add_argument("--max-overflow",type=int,default=2)
    parser.add_argument("--db-roundtrip-delay-ms",type=int,default=0,
                        help="Local diagnostic sleep per SQLAlchemy SELECT; not a hosted network simulation")
    arguments=parser.parse_args()
    if arguments.port<1024 or any(x not in TIERS for x in arguments.tiers):
        parser.error("Use a nonprivileged loopback port and supported paced tiers")
    if arguments.admission_limit<0 or (arguments.overload_only and not 2<=arguments.admission_limit<=8):
        parser.error("Controlled overload test requires a small admission limit from 2 through 8")
    if arguments.cold_cohort not in {0,24}:
        parser.error("Cold routing verification is restricted to the small24request cohort")
    if arguments.thread_tokens not in {0,16}:
        parser.error("Only the existing default or the authorized16token comparison is supported")
    if not (1<=arguments.pool_size<=16 and 0<=arguments.max_overflow<=15
            and arguments.pool_size+arguments.max_overflow<=16):
        parser.error("Local pool size plus overflow must remain between1and16")
    if not 0<=arguments.db_roundtrip_delay_ms<=500:
        parser.error("Synthetic SELECT delay is restricted to0through500ms")
    (serve if arguments.mode=="serve" else run)(arguments)
