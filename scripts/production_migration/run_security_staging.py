"""Run review-only authorization tests in a newly initialized private cluster.

No existing cluster, recovered source, or hosted Supabase database is used.
The stopped staging directory remains under /tmp for inspection.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import psycopg


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, required=True, help="Local directory containing initdb and pg_ctl; PostGIS must be installed")
    parser.add_argument("--test-pattern", choices=["test_security_candidate.py", "test_reader_role_candidate.py"], default="test_security_candidate.py")
    args = parser.parse_args()
    for program in ("initdb", "pg_ctl"):
        if not (args.pg_bin / program).is_file():
            parser.error(f"Missing local PostgreSQL executable: {program}")
    # Explicit local DSNs must never inherit a service file or hostaddr route.
    for key in list(os.environ):
        if key.startswith("PG"):
            os.environ.pop(key)
    root = Path(__file__).resolve().parents[2]
    staging = Path(tempfile.mkdtemp(prefix="navme-security-", dir="/tmp"))
    socket = staging / "socket"
    socket.mkdir(mode=0o700)
    data = staging / "pgdata"
    print(f"Disposable staging: {staging}", flush=True)
    subprocess.run([str(args.pg_bin / "initdb"), "-D", str(data), "--auth-local=trust",
                    "--auth-host=reject", "--no-locale", "--encoding=UTF8", "--username=navme_security_owner"],
                   check=True, stdout=subprocess.DEVNULL)
    started = False
    try:
        subprocess.run([str(args.pg_bin / "pg_ctl"), "-D", str(data), "-l", str(staging / "postgres.log"),
                        "-o", f"-k {socket} -p 65433 -c listen_addresses=''", "-w", "start"], check=True)
        started = True
        dsn = f"host={socket} port=65433 user=navme_security_owner dbname=postgres"
        with psycopg.connect(dsn, autocommit=True) as connection:
            connection.execute("CREATE DATABASE navme_security_test")
            version = connection.execute("SHOW server_version").fetchone()[0]
        env = {**os.environ, "NAVME_SECURITY_TEST_DSN": dsn.replace("dbname=postgres", "dbname=navme_security_test")}
        evidence_name = "reader-role-staging-tests.txt" if args.test_pattern == "test_reader_role_candidate.py" else "security-staging-tests.txt"
        evidence = root / "docs/production-migration/evidence" / evidence_name
        evidence.parent.mkdir(parents=True, exist_ok=True)
        with evidence.open("w") as log:
            log.write(f"Isolated local PostgreSQL {version}; synthetic fixtures only; no destination production write.\n")
            log.flush()
            result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s",
                                     "scripts/production_migration", "-p", args.test_pattern, "-v"],
                                    cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        print(evidence.read_text(), flush=True)
        return result.returncode
    finally:
        if started:
            subprocess.run([str(args.pg_bin / "pg_ctl"), "-D", str(data), "-m", "fast", "-w", "stop"], check=True)


if __name__ == "__main__":
    raise SystemExit(main())
