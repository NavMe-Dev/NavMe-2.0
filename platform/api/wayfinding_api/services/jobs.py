"""Onboarding job runner. Jobs are rows in `jobs`; a worker process (`wayfinding worker`) claims queued
jobs with SELECT … FOR UPDATE SKIP LOCKED, runs the wfpipe steps in the building workspace, streams the
log into the row and imports the outputs into the DB."""
import threading, time, traceback
from datetime import datetime, timezone
from sqlalchemy import text
from ..db import SessionLocal
from .. import models
from .workspace import ws_dir, pipeline_config, import_outputs


def claim(db):
    row = db.execute(text("SELECT id FROM jobs WHERE status='queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1")).first()
    if not row: return None
    j = db.get(models.Job, row[0]); j.status = "running"; j.started_at = datetime.now(timezone.utc); db.commit(); return j.id


def run_job(job_id: int):
    from wfpipe.context import Context
    from wfpipe import runner
    db = SessionLocal()
    j = db.get(models.Job, job_id); b = db.get(models.Building, j.building_id)
    buf = []; last = [time.time()]

    def flush(force=False):
        if buf and (force or time.time() - last[0] > 1.0):
            db.execute(text("UPDATE jobs SET log = log || :t, step = :s WHERE id = :i"), {"t": "".join(buf), "s": ctxh[0].current_step if ctxh else None, "i": job_id})
            db.commit(); buf.clear(); last[0] = time.time()
    ctxh = []

    def cb(line, level):
        buf.append(line + "\n"); flush()
    try:
        b.status = "processing"; db.commit()
        cfg = pipeline_config(db, b)
        ctx = Context(ws_dir(b), cfg, log_cb=cb); ctxh.append(ctx)
        p = j.params or {}
        summ = runner.run(ctx, steps=p.get("steps"), force=p.get("force", False), from_step=p.get("from_step"), force_steps=p.get("force_steps", []))
        flush(True)
        cb("importing outputs into database …", "info")
        info = import_outputs(db, b)
        cb(f"import done: {info}", "info"); flush(True)
        j = db.get(models.Job, job_id)
        j.status = "succeeded"; j.steps = {n: s for n, s, _ in summ}
    except Exception as e:
        buf.append(traceback.format_exc()); flush(True)
        db.rollback(); j = db.get(models.Job, job_id); b = db.get(models.Building, j.building_id)
        j.status = "failed"; j.error = str(e)[:2000]; b.status = "failed"
    j.finished_at = datetime.now(timezone.utc); j.step = None; db.commit(); db.close()


def worker_loop(poll=2.0, once=False):
    while True:
        db = SessionLocal()
        try:
            jid = claim(db)
        finally:
            db.close()
        if jid:
            # A crash inside one job must not kill the worker thread — otherwise every
            # later job sits queued forever until the server is restarted.
            try:
                run_job(jid)
            except Exception:
                import traceback; traceback.print_exc()
                db = SessionLocal()
                try:
                    j = db.get(models.Job, jid)
                    if j and j.status == "running":
                        j.status = "failed"
                        j.log = (j.log or "") + "\n[worker] job crashed; see server log\n"
                        db.commit()
                finally:
                    db.close()
        elif once:
            return
        else:
            time.sleep(poll)


def requeue_orphans():
    """Rows left 'running' by a server restart have no worker behind them — the inline
    worker dies with the process. Put them back in the queue so a restart mid-pipeline
    doesn't wedge a job forever."""
    db = SessionLocal()
    try:
        n = db.query(models.Job).filter_by(status="running").update({"status": "queued"})
        if n:
            db.commit()
            print(f"[worker] requeued {n} orphaned running job(s) from a previous process")
    except Exception:
        db.rollback()
    finally:
        db.close()


def start_inline_worker():
    requeue_orphans()
    t = threading.Thread(target=worker_loop, daemon=True, name="inline-worker"); t.start(); return t
