#!/usr/bin/env python3
"""Read-only PostgreSQL inventory and verified custom-format logical backup.

Credentials come from an existing environment variable. Raw dumps and inventories
must be placed outside Git; this tool never restores or changes a database.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone
import ipaddress

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
# Register PostGIS reflection types instead of silently inventorying geometry as NULL.
import geoalchemy2  # noqa: F401


def postgres_url(value: str):
    """Use installed psycopg3 and require encrypted remote connections."""
    parsed = make_url(value)
    if parsed.drivername in {"postgres", "postgresql"}:
        parsed = parsed.set(drivername="postgresql+psycopg")
    if not parsed.drivername.startswith("postgresql"):
        raise ValueError("A PostgreSQL URL is required")
    local = parsed.host in {None, "localhost"}
    if parsed.host:
        try:
            local = ipaddress.ip_address(parsed.host).is_loopback
        except ValueError:
            pass
    if not local:
        mode = parsed.query.get("sslmode", "require")
        if mode not in {"require", "verify-ca", "verify-full"}:
            raise ValueError("Remote backups/inventories require an encrypted TLS mode")
        parsed = parsed.update_query_dict({"sslmode": mode})
    return parsed


def secure_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2, default=str)
        stream.write("\n")


def inventory(url: str, schemas: list[str]) -> dict:
    engine = create_engine(postgres_url(url), hide_parameters=True,
                           connect_args={"connect_timeout": 15})
    result = {"captured_at": datetime.now(timezone.utc).isoformat(), "tables": {}}
    try:
        with engine.connect().execution_options(isolation_level="REPEATABLE READ") as conn:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            conn.execute(text("SET LOCAL statement_timeout = '120s'"))
            conn.execute(text("SET LOCAL TIME ZONE 'UTC'"))
            result["server_version"] = conn.execute(text("SHOW server_version")).scalar()
            result["extensions"] = [dict(r) for r in conn.execute(text(
                "SELECT extname, extversion FROM pg_extension ORDER BY extname"
            )).mappings()]
            inspector = inspect(conn)
            quote = engine.dialect.identifier_preparer.quote
            for schema in schemas:
                for name in inspector.get_table_names(schema=schema):
                    qualified = f"{quote(schema)}.{quote(name)}"
                    columns = [
                        {k: str(v) if k == "type" else v for k, v in col.items()}
                        for col in inspector.get_columns(name, schema=schema)
                    ]
                    count = conn.execute(text(f"SELECT count(*) FROM {qualified}")).scalar()
                    result["tables"][f"{schema}.{name}"] = {
                        "row_count": count,
                        "columns": columns,
                        "primary_key": inspector.get_pk_constraint(name, schema=schema),
                        "foreign_keys": inspector.get_foreign_keys(name, schema=schema),
                        "unique_constraints": inspector.get_unique_constraints(name, schema=schema),
                        "indexes": inspector.get_indexes(name, schema=schema),
                    }
            result["rls"] = [dict(r) for r in conn.execute(text(
                "SELECT n.nspname AS schema, c.relname AS table, "
                "c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced "
                "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE c.relkind IN ('r','p') AND n.nspname = ANY(:schemas) ORDER BY 1,2"
            ), {"schemas": schemas}).mappings()]
            result["policies"] = [dict(r) for r in conn.execute(text(
                "SELECT * FROM pg_policies WHERE schemaname = ANY(:schemas) ORDER BY 1,2,3"
            ), {"schemas": schemas}).mappings()]
        return result
    finally:
        engine.dispose()


def backup(url: str, output: Path, pg_bin: Path, expected_host: str) -> dict:
    parsed = postgres_url(url)
    if parsed.host != expected_host:
        raise ValueError("Connection host does not match --expected-host")
    # Restrict permission before pg_dump opens the file, and never pass secrets
    # in argv or emit child stderr (libpq errors can echo connection strings).
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("PG"):
            del env[key]
    env.update({"PGHOST": parsed.host or "", "PGPORT": str(parsed.port or 5432),
                "PGUSER": parsed.username or "", "PGPASSWORD": parsed.password or "",
                "PGDATABASE": parsed.database or "", "PGCONNECT_TIMEOUT": "15"})
    for option, variable in (("sslmode", "PGSSLMODE"), ("sslrootcert", "PGSSLROOTCERT")):
        if option in parsed.query:
            env[variable] = str(parsed.query[option])
    dumped = subprocess.run([str(pg_bin / "pg_dump"), "--format=custom", "--no-owner",
                             "--no-acl", "--file", str(output)], env=env,
                            capture_output=True)
    if dumped.returncode:
        raise RuntimeError("pg_dump failed; partial file retained privately; inspect securely")
    listed = subprocess.run([str(pg_bin / "pg_restore"), "--list", str(output)],
                            capture_output=True)
    if listed.returncode:
        raise RuntimeError("Backup archive directory could not be read")
    digest = hashlib.sha256()
    with output.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"created_at": datetime.now(timezone.utc).isoformat(),
            "path": str(output.resolve()), "bytes": output.stat().st_size,
            "sha256": digest.hexdigest(), "archive_directory_readable": True,
            "isolated_restore_verified": False,
            "note": "Readability is not restoration verification. Restore only into a new isolated database."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["inventory", "backup"])
    parser.add_argument("--url-env", default="DATABASE_URL")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--schemas", nargs="+", default=["public"])
    parser.add_argument("--pg-bin", type=Path, default=Path("/usr/bin"))
    parser.add_argument("--expected-host")
    args = parser.parse_args()
    url = os.environ.get(args.url_env)
    if not url:
        parser.error("The named connection environment variable is empty")
    try:
        if args.operation == "inventory":
            secure_json(args.output, inventory(url, args.schemas))
        else:
            if not args.expected_host:
                parser.error("backup requires --expected-host")
            report = backup(url, args.output, args.pg_bin, args.expected_host)
            secure_json(args.output.with_suffix(args.output.suffix + ".json"), report)
        print("Completed; private output written to the requested path.")
        return 0
    except Exception as exc:
        print(f"Failed ({type(exc).__name__}); inspect locally without sharing credentials.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
