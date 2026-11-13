"""Launch a local public-viewer shadow against the reviewed destination, read-only.

No production migrations, bootstrap, workers, or mutation routes are enabled.
Only a private temporary cache is written. Credentials stay out of argv/logs.
"""
import argparse
from pathlib import Path
import os
import secrets
import subprocess
import sys
import tempfile

from dotenv import dotenv_values
from sqlalchemy.engine import make_url

from capture_destination import PROJECT, validate_target

REVIEWED_READER_LOGIN = "navme_wayfinding_live_v1"


def validate_shadow_target(value, database_role="postgres"):
    if database_role == "postgres":
        return validate_target(value)
    if database_role != REVIEWED_READER_LOGIN:
        raise ValueError("Only the explicitly reviewed reader login is permitted")
    target = make_url(value)
    direct = target.host == f"db.{PROJECT}.supabase.co" and target.username == database_role
    pooled = target.host == "aws-0-ap-southeast-1.pooler.supabase.com" and target.username == f"{database_role}.{PROJECT}"
    routing = {"host","hostaddr","dbname","database","service","servicefile","port","user","password"}
    if (target.drivername not in {"postgres","postgresql","postgresql+psycopg"}
            or not (direct or pooled) or target.database != "postgres" or not target.password
            or (target.port or 5432) != 5432 or routing.intersection(key.casefold() for key in target.query)
            or target.query.get("sslmode","require") not in {"require","verify-ca","verify-full"}):
        raise ValueError("Reader shadow requires the exact reviewed project/session route and TLS")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-file", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8782)
    parser.add_argument("--database-role", choices=["postgres", REVIEWED_READER_LOGIN], default="postgres")
    parser.add_argument("--url-key", choices=["SUPABASE_DATABASE_URL", "SUPABASE_READONLY_DATABASE_URL"], default="SUPABASE_DATABASE_URL")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    values = dotenv_values(args.secret_file, interpolate=False)
    target = validate_shadow_target(values.get(args.url_key, ""), args.database_role)
    target = target.set(drivername="postgresql+psycopg")
    public_url = f"https://{PROJECT}.supabase.co"
    existing = dotenv_values(root / ".env", interpolate=False)
    source_url = str(existing.get("SUPABASE_URL") or existing.get("VITE_SUPABASE_URL") or "").rstrip("/")
    anon = (existing.get("SUPABASE_ANON_KEY") or existing.get("VITE_SUPABASE_ANON_KEY") or "") if source_url == public_url else ""
    staging = Path(tempfile.mkdtemp(prefix="navme-readonly-shadow-", dir="/tmp"))
    permitted_env = {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "DYLD_LIBRARY_PATH",
                     "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"}
    env = {key: value for key, value in os.environ.items() if key in permitted_env}
    env.update(DATABASE_URL=target.render_as_string(hide_password=False), DB_SSLMODE=target.query.get("sslmode", "require"),
               DB_READ_ONLY="true", WF_READ_ONLY="true", WORKER_INLINE="false", RUN_MIGRATIONS="false",
               DATA_DIR=str(staging / "data"), VIEWER_DIR=str(root / "platform/viewer"),
               ADMIN_DIR=str(root / "platform/admin"), PUBLIC_BASE_URL=f"http://127.0.0.1:{args.port}",
               JWT_SECRET=secrets.token_hex(32), BOOTSTRAP_SECRET="", WF_CHAT_ENABLED="false",
               SUPABASE_URL=public_url, SUPABASE_ANON_KEY=anon, SUPABASE_SERVICE_ROLE_KEY="",
               MATTERPORT_SDK_KEY=existing.get("MATTERPORT_SDK_KEY") or "",
               SUPABASE_STORAGE_BUCKET="wayfinding-bundles")
    print(f"Read-only destination shadow on http://127.0.0.1:{args.port}; private cache {staging}", flush=True)
    print(f"Worker disabled; database/app mutations disabled; same-project public metadata key available: {bool(anon)}", flush=True)
    ready = subprocess.call([sys.executable, "-m", "wayfinding_api.readiness", "--timeout", "60"], cwd=staging, env=env)
    if ready:
        return ready
    return subprocess.call([sys.executable, "-m", "uvicorn", "wayfinding_api.main:app", "--app-dir",
                            str(root / "platform/api"), "--host", "127.0.0.1", "--port", str(args.port)],
                           cwd=staging, env=env)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Shadow launch failed ({type(exc).__name__}); connection details withheld", flush=True)
        raise SystemExit(1) from None
