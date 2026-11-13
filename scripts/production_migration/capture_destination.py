#!/usr/bin/env python3
"""Capture the exact occupied destination without any production data writes.

Retains ownership/ACL/policies in the custom archive and separately captures
roles without passwords. Uses one exported read-only snapshot for the dump and
table digests. Does not restore, provision roles, apply migrations or deploy.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess

from dotenv import dotenv_values
import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

PROJECT = "kzpvhzyefdtrtidrbuxb"


@contextmanager
def isolated_libpq_environment():
    """Exclude inherited routing/services from the snapshot connection too."""
    original = {key: value for key, value in os.environ.items() if key.startswith("PG")}
    try:
        for key in original:
            os.environ.pop(key, None)
        yield
    finally:
        for key in list(os.environ):
            if key.startswith("PG"):
                os.environ.pop(key, None)
        os.environ.update(original)


def private_file(path: Path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")


def write_json(path: Path, value):
    with private_file(path) as stream:
        stream.write((json.dumps(value, indent=2, default=str) + "\n").encode())


def checksum(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_target(value):
    target = make_url(value)
    direct = target.host == f"db.{PROJECT}.supabase.co" and target.username == "postgres"
    pooled = (target.host == "aws-0-ap-southeast-1.pooler.supabase.com"
              and target.username == f"postgres.{PROJECT}")
    routing = {"host", "hostaddr", "dbname", "database", "service", "servicefile", "port", "user", "password"}
    if (target.drivername not in {"postgres", "postgresql", "postgresql+psycopg"}
            or not (direct or pooled) or target.database != "postgres"
            or (target.port or 5432) != 5432 or not target.password
            or routing.intersection(target.query)):
        raise ValueError("Only the reviewed exact-project direct/session endpoint is permitted")
    if target.query.get("sslmode", "require") not in {"require", "verify-ca", "verify-full"}:
        raise ValueError("Encrypted TLS is required")
    return target


def child_environment(target):
    # Never let an inherited libpq route/service redirect the reviewed target.
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env.update(PGHOST=target.host, PGPORT=str(target.port or 5432),
               PGDATABASE=target.database, PGUSER=target.username,
               PGPASSWORD=target.password, PGCONNECT_TIMEOUT="15",
               PGSSLMODE=target.query.get("sslmode", "require"),
               PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120000",
               PGAPPNAME="navme-destination-backup-readonly")
    for key, option in (("PGSSLROOTCERT", "sslrootcert"), ("PGSSLCERT", "sslcert"), ("PGSSLKEY", "sslkey")):
        if target.query.get(option):
            env[key] = target.query[option]
    return env


def run_private(argv, env, out, label, *, stdout_path=None):
    # Child messages can contain private identifiers; never print them.
    log_path = out / (label + ".stderr")
    with private_file(log_path) as errors:
        if stdout_path is None:
            result = subprocess.run(argv, env=env, stdout=subprocess.DEVNULL, stderr=errors, timeout=600)
        else:
            with private_file(stdout_path) as stream:
                result = subprocess.run(argv, env=env, stdout=stream, stderr=errors, timeout=600)
    if result.returncode:
        raise RuntimeError(f"{label} failed; inspect restricted local diagnostic")


def capture(secret_file: Path, output: Path, pg_bin: Path):
    target = validate_target(dotenv_values(secret_file, interpolate=False).get("SUPABASE_DATABASE_URL", ""))
    if output.exists():
        raise ValueError("Use a new capture directory; previous evidence is never overwritten")
    output.mkdir(parents=True, mode=0o700)
    output.chmod(0o700)
    env = child_environment(target)
    metadata = {"project_id": PROJECT, "started_at": datetime.now(timezone.utc).isoformat(),
                "host": target.host, "port": target.port or 5432,
                "archive_retains_owners_and_acls": True,
                "role_passwords_included": False, "production_writes": False,
                "isolated_restore_verified": False, "storage_object_bytes_included": False}
    connect = dict(host=target.host, port=target.port or 5432, user=target.username,
                   password=target.password, dbname=target.database, sslmode=env["PGSSLMODE"],
                   connect_timeout=15, application_name="navme-backup-snapshot", prepare_threshold=None,
                   autocommit=True)
    for option in ("sslrootcert", "sslcert", "sslkey"):
        if target.query.get(option):
            connect[option] = target.query[option]
    with isolated_libpq_environment(), psycopg.connect(**connect) as connection:
        if not connection.pgconn.ssl_in_use:
            raise RuntimeError("Client TLS was not established")
        with connection.cursor() as cursor:
            cursor.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            cursor.execute("SET LOCAL statement_timeout='120s'")
            cursor.execute("SELECT version(), current_database(), current_setting('transaction_read_only'), pg_export_snapshot()")
            metadata["server_version"], metadata["database"], metadata["read_only"], snapshot = cursor.fetchone()
            cursor.execute("SHOW transaction_isolation")
            metadata["isolation"] = cursor.fetchone()[0]
            if metadata["read_only"] != "on" or metadata["isolation"] != "repeatable read":
                raise RuntimeError("A read-only repeatable-read snapshot is mandatory")
            metadata["client_tls_verified"] = True
            cursor.execute("SELECT extname, extversion FROM pg_extension ORDER BY extname")
            metadata["extensions"] = [{"name": name, "version": version} for name, version in cursor.fetchall()]
            cursor.execute("SELECT rolname FROM pg_roles ORDER BY rolname")
            roles_required = [row[0] for row in cursor.fetchall()]
            cursor.execute("SELECT pubname FROM pg_publication ORDER BY pubname")
            publications_required = [row[0] for row in cursor.fetchall()]
            write_json(output / "source-requirements.json", {
                "server_version": metadata["server_version"], "extensions": metadata["extensions"],
                "roles": roles_required, "publications": publications_required,
                "vault_recovery_material_captured": False})
            cursor.execute("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                           "WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' "
                           "AND n.nspname<>'information_schema' ORDER BY 1,2")
            tables = cursor.fetchall()
            archive = output / "destination.dump"
            with private_file(archive):
                pass
            run_private([str(pg_bin / "pg_dump"), "--no-password", "--format=custom",
                         "--lock-wait-timeout=10s", "--snapshot=" + snapshot,
                         "--file=" + str(archive)], env, output, "pg_dump")
            inventory = {"captured_at": datetime.now(timezone.utc).isoformat(), "same_exported_snapshot_as_archive": True,
                         "timezone": "UTC", "row_digest_method": "md5(sorted concatenation of md5(to_jsonb(row)::text))", "tables": {}}
            for schema, table in tables:
                query = sql.SQL("SELECT count(*),md5(coalesce(string_agg(row_hash,'' ORDER BY row_hash COLLATE \"C\"),'')) "
                                "FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM {}.{} AS t) AS rows").format(
                                    sql.Identifier(schema), sql.Identifier(table))
                cursor.execute(query)
                count, digest = cursor.fetchone()
                inventory["tables"][schema + "." + table] = {"row_count": count, "content_digest": digest}
            cursor.execute("SELECT version_num FROM public.alembic_version")
            inventory["alembic_version"] = [row[0] for row in cursor.fetchall()]
            cursor.execute("SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version")
            inventory["supabase_migrations"] = [{"version": version, "name": name} for version, name in cursor.fetchall()]
            write_json(output / "snapshot-inventory.json", inventory)
        connection.rollback()
    roles = output / "roles-without-passwords.sql"
    run_private([str(pg_bin / "pg_dumpall"), "--no-password", "--roles-only", "--no-role-passwords"],
                env, output, "roles", stdout_path=roles)
    offline_env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    run_private([str(pg_bin / "pg_restore"), "--list", str(archive)], offline_env, output,
                "archive-list", stdout_path=output / "archive.list")
    # Parses/decompresses the archive without any database connection or SQL execution.
    run_private([str(pg_bin / "pg_restore"), "--file=/dev/null", str(archive)], offline_env, output, "archive-read")
    schema = output / "schema.sql"
    run_private([str(pg_bin / "pg_restore"), "--schema-only", "--file=-", str(archive)], offline_env, output,
                "schema", stdout_path=schema)
    metadata.update(completed_at=datetime.now(timezone.utc).isoformat(), table_count=len(inventory["tables"]),
                    archive_directory_readable=True, archive_fully_decoded=True,
                    roles_captured_separately_from_data_snapshot=True,
                    files={path.name: {"bytes": path.stat().st_size, "sha256": checksum(path)}
                           for path in (archive, roles, schema, output / "snapshot-inventory.json", output / "source-requirements.json")})
    write_json(output / "capture-manifest.json", metadata)
    print(json.dumps({"project_id": PROJECT, "backup_captured": True,
                      "archive_fully_decoded": True, "table_count": metadata["table_count"],
                      "archive_bytes": metadata["files"]["destination.dump"]["bytes"],
                      "archive_sha256": metadata["files"]["destination.dump"]["sha256"],
                      "isolated_restore_verified": False, "private_output": str(output)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pg-bin", type=Path, required=True)
    args = parser.parse_args()
    try:
        capture(args.secret_file, args.output, args.pg_bin)
    except Exception as exc:
        print(json.dumps({"backup_captured": False, "error_type": type(exc).__name__,
                          "private_output": str(args.output), "note": "Inspect restricted diagnostics locally; never share connection secrets."}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
