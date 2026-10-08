"""Runs the "Onboard for image localization" admin job: builds the proper SuperPoint +
LightGlue + MegaLoc reference database (see platform/vps_prototype/, ported from a working
prototype) for a building's Matterport model, replacing the earlier from-scratch ORB
matcher (services/vps_match.py) which proved unreliable in testing.

Local-machine-only for now: this shells out to a SEPARATE venv (vps_prototype/.venv) with
heavy ML dependencies (torch, LightGlue, pycolmap) that don't belong in the lean main API
image — there is no in-process code path here, only subprocess orchestration + streaming
the output into the job log, the same way the user already watches pipeline jobs.
"""
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

from ..config import get_settings
from ..db import SessionLocal
from .. import models
from . import bundle_storage
from .workspace import ws_dir


def vps_available() -> tuple[bool, str]:
    """(ok, reason) — whether the local vps_prototype venv is set up at all. The admin
    endpoint uses this to report the feature as unavailable rather than letting a job
    fail cryptically on a machine that never installed the heavy deps."""
    d = get_settings().vps_prototype_dir
    venv_py = d / ".venv" / "bin" / "python"
    if not venv_py.is_file():
        return False, f"no vps_prototype/.venv found at {d} on this server — this only works on a machine where it was set up"
    if not (d / "build_db_parallel.py").is_file():
        return False, f"vps_prototype directory at {d} is missing build_db_parallel.py"
    return True, ""


def run_vps_build_job(job_id: int, workers: int = 5):
    db = SessionLocal()
    j = db.get(models.Job, job_id)
    b = db.get(models.Building, j.building_id)
    buf = []
    last = [time.time()]

    def flush(force=False):
        if buf and (force or time.time() - last[0] > 1.0):
            db.execute(text("UPDATE jobs SET log = log || :t WHERE id = :i"), {"t": "".join(buf), "i": job_id})
            db.commit(); buf.clear(); last[0] = time.time()

    def cb(line):
        buf.append(line.rstrip("\n") + "\n"); flush()

    def run_streamed(cmd, env, step_name):
        cb(f"=== {step_name}: {' '.join(cmd)}")
        proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        db.execute(text("UPDATE jobs SET step = :s WHERE id = :i"), {"s": step_name, "i": job_id}); db.commit()
        for line in proc.stdout:
            cb(line)
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"{step_name} exited with code {proc.returncode}")

    try:
        ok, reason = vps_available()
        if not ok:
            raise RuntimeError(reason)
        model_id = b.matterport_model_id
        if not model_id:
            raise RuntimeError("building has no Matterport model id set")
        mesh_path = ws_dir(b) / "work" / "mesh.npz"
        georef_path = ws_dir(b) / "out" / "georef.json"
        if not mesh_path.is_file():
            raise RuntimeError(f"no mesh.npz at {mesh_path} — run the 'mesh' pipeline step first")
        if not georef_path.is_file():
            raise RuntimeError(f"no georef.json at {georef_path} — run the 'georef' pipeline step first")

        vps_dir = get_settings().vps_prototype_dir.resolve()
        venv_py = str(vps_dir / ".venv" / "bin" / "python")
        model_dir = vps_dir / "data" / "models" / model_id
        env = {**os.environ, "KMP_DUPLICATE_LIB_OK": "TRUE"}

        cb(f"building VPS reference database for {b.slug} (Matterport model {model_id})")
        run_streamed(
            [venv_py, str(vps_dir / "prepare_model.py"), model_id,
             "--mesh", str(mesh_path), "--georef", str(georef_path), "--skip-build"],
            env, "fetch sky images + stage mesh/georef",
        )

        env2 = {**env, "VPS_MODEL_ID": model_id, "VPS_DATA": str(model_dir), "VPS_VIEWS_FAST": "1"}
        run_streamed(
            [venv_py, str(vps_dir / "build_db_parallel.py"), "--workers", str(workers)],
            env2, "build reference database (SuperPoint + MegaLoc, fast mode)",
        )

        meta_path = model_dir / "db" / "meta.json"
        if not meta_path.is_file():
            raise RuntimeError("build finished but db/meta.json is missing — see log above")
        meta = json.loads(meta_path.read_text())
        n_crops = len(meta.get("crops") or [])

        cb("uploading reference database to Supabase Storage …")
        uploaded = bundle_storage.upload_vps_dir(model_id, model_dir / "db")
        total_files = sum(1 for _ in (model_dir / "db").rglob("*") if _.is_file() and "crops" not in _.parts)
        cb(f"uploaded {uploaded}/{total_files} files (Supabase not configured -> 0 is expected on local dev)")

        b.pipeline_config = {**(b.pipeline_config or {}), "vps_ready": {
            "model_id": model_id, "crops": n_crops, "sweeps": len(meta.get("crops") or []) and len({c["sweep"] for c in meta["crops"]}),
            "built_at": datetime.now(timezone.utc).isoformat(), "uploaded_to_storage": uploaded == total_files and total_files > 0,
        }}
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(b, "pipeline_config")
        j = db.get(models.Job, job_id)
        j.status = "succeeded"
        flush(True)
    except Exception as e:
        import traceback
        buf.append(traceback.format_exc()); flush(True)
        db.rollback()
        j = db.get(models.Job, job_id)
        j.status = "failed"; j.error = str(e)[:2000]
    j.finished_at = datetime.now(timezone.utc); j.step = None; db.commit(); db.close()
