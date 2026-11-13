#!/usr/bin/env python3
"""Provision only the reviewed server reader login after verified restoration.

The credential-free reader group/policies must already have been migrated.
Passwords are read from ignored files and hashed locally by libpq; plaintext
passwords never appear in SQL, command arguments, reports or standard output.
No application table is inserted, updated, deleted, or truncated.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from dotenv import dotenv_values
import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

from capture_destination import isolated_libpq_environment, validate_target, write_json

LOGIN = "navme_wayfinding_live_v1"
GROUP = "navme_wayfinding_public_reader_v1"
PROJECT = "kzpvhzyefdtrtidrbuxb"
TABLES = ("users", "venues", "buildings", "floors", "pois", "control_points",
          "nav_graphs", "map_versions", "jobs", "alembic_version")


def require_recovery_proof(directory):
    baseline = json.loads((directory / "restore-verification-pg17-complete/verification-report.json").read_text())
    after = json.loads((directory / "restore-post-reader-verification/additional-verification-report.json").read_text())
    if not (baseline.get("snapshot_verification_pass")
            and baseline.get("all_metadata_categories_match")
            and baseline.get("original_capture_checksums_unchanged")
            and baseline.get("table_count") == 130
            and after.get("post_candidate_all_frozen_rows_unchanged")
            and after.get("full_precision_current_source_tables_match")
            and after.get("exact_archive_sequence_states_match")
            and after.get("original_capture_checksums_unchanged")):
        raise ValueError("Complete isolated recovery and reader preservation evidence is required")


def connect_kwargs(url):
    return dict(host=url.host, port=url.port or 5432, dbname=url.database,
                user=url.username, password=url.password,
                sslmode=url.query.get("sslmode", "require"), connect_timeout=15,
                prepare_threshold=None, autocommit=True)


def provision(owner_file, reader_file, proof_directory, output):
    require_recovery_proof(proof_directory)
    if output.exists():
        raise ValueError("Existing audit evidence must not be overwritten")
    owner = validate_target(dotenv_values(owner_file, interpolate=False)["SUPABASE_DATABASE_URL"])
    reader = make_url(dotenv_values(reader_file, interpolate=False)["SUPABASE_READONLY_DATABASE_URL"])
    if (reader.drivername != "postgresql" or reader.host != owner.host
            or reader.port != 5432 or reader.database != "postgres"
            or reader.username != LOGIN + "." + PROJECT
            or not reader.password or len(reader.password) < 64
            or reader.query != {"sslmode": "require"}):
        raise ValueError("Only the reviewed independent exact-project reader login is allowed")
    result = {"project_id": PROJECT, "started_at": datetime.now(timezone.utc).isoformat(),
              "login": LOGIN, "group": GROUP, "application_data_dml": False,
              "plaintext_password_in_sql": False}
    with isolated_libpq_environment(), psycopg.connect(**connect_kwargs(owner)) as connection:
        if not connection.pgconn.ssl_in_use:
            raise RuntimeError("Owner connection requires client TLS")
        with connection.cursor() as cursor:
            cursor.execute("BEGIN READ WRITE")
            cursor.execute("SET LOCAL statement_timeout='30s'")
            cursor.execute("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls "
                           "FROM pg_roles WHERE rolname=%s", (GROUP,))
            group = cursor.fetchone()
            if group is None or any(group):
                raise ValueError("The reviewed nonprivileged NOLOGIN group must already exist")
            cursor.execute("SELECT count(*) FROM pg_policies WHERE schemaname='public' "
                           "AND policyname='wayfinding_public_reader_select' "
                           "AND cmd='SELECT' AND roles=ARRAY[%s]::name[]", (GROUP,))
            if cursor.fetchone()[0] != len(TABLES):
                raise ValueError("All ten reviewed reader policies must already exist")
            cursor.execute("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=%s)", (LOGIN,))
            if cursor.fetchone()[0]:
                raise ValueError("The login already exists; no credential overwrite is permitted")
            cursor.execute("SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid "
                           "JOIN pg_roles m ON m.oid=a.member WHERE r.rolname=%s "
                           "AND m.rolname NOT IN ('postgres','supabase_admin')", (GROUP,))
            if cursor.fetchone()[0]:
                raise ValueError("Unexpected existing membership must be reviewed")
            verifier = connection.pgconn.encrypt_password(reader.password.encode(), LOGIN.encode(), b"scram-sha-256").decode()
            if not verifier.startswith("SCRAM-SHA-256$"):
                raise RuntimeError("A locally hashed SCRAM verifier is required")
            cursor.execute(sql.SQL("CREATE ROLE {} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE "
                                   "NOREPLICATION NOBYPASSRLS PASSWORD {}").format(
                                       sql.Identifier(LOGIN), sql.Literal(verifier)))
            cursor.execute(sql.SQL("GRANT {} TO {} WITH INHERIT TRUE").format(sql.Identifier(GROUP), sql.Identifier(LOGIN)))
            cursor.execute(sql.SQL("GRANT CONNECT ON DATABASE postgres TO {}").format(sql.Identifier(LOGIN)))
            for setting, value in (("default_transaction_read_only", "on"), ("statement_timeout", "30s"), ("lock_timeout", "5s")):
                cursor.execute(sql.SQL("ALTER ROLE {} SET {} TO {}").format(
                    sql.Identifier(LOGIN), sql.Identifier(setting), sql.Literal(value)))
            cursor.execute(sql.SQL("COMMENT ON ROLE {} IS 'NavMe server-only SELECT recovery login; no application DML'").format(sql.Identifier(LOGIN)))
        connection.commit()
    result["login_created"] = True
    write_json(output.with_suffix(".checkpoint.json"), {
        "project_id": PROJECT, "login": LOGIN, "group": GROUP,
        "login_created": True, "actual_password_authentication_verified": False,
        "application_data_dml": False,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "note": "Committed credential provisioning only; inspect this checkpoint before any retry."})
    # Actual password authentication is verified before any Render activation.
    with isolated_libpq_environment(), psycopg.connect(**connect_kwargs(reader)) as connection:
        if not connection.pgconn.ssl_in_use:
            raise RuntimeError("Reader connection requires client TLS")
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            cursor.execute("BEGIN READ ONLY")
            cursor.execute("SELECT current_user,current_setting('transaction_read_only'),postgis_version()")
            role, readonly, postgis = cursor.fetchone()
            if role != LOGIN or readonly != "on" or not postgis:
                raise RuntimeError("The actual reader session did not verify")
            cursor.execute("SELECT r.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid "
                           "JOIN pg_roles m ON m.oid=a.member WHERE m.rolname=current_user ORDER BY 1")
            if [r[0] for r in cursor.fetchall()] != [GROUP]:
                raise RuntimeError("The login must inherit only the reviewed reader group")
            result["counts"] = {}
            for table in TABLES:
                cursor.execute(sql.SQL("SELECT count(*) FROM public.{}").format(sql.Identifier(table)))
                result["counts"][table] = cursor.fetchone()[0]
                cursor.execute("SELECT has_table_privilege(current_user,%s,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')",
                               ("public." + table,))
                if cursor.fetchone()[0]:
                    raise RuntimeError("The login unexpectedly has table mutation privilege")
            result.update(client_tls_verified=True, actual_password_authentication_verified=True,
                          read_only=readonly, effective_backend_dml_privileges=False,
                          exactly_one_reader_membership=True)
        connection.rollback()
    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    write_json(output, result)
    print(json.dumps({key: result[key] for key in ("project_id", "login_created", "client_tls_verified",
        "actual_password_authentication_verified", "read_only", "effective_backend_dml_privileges", "application_data_dml")}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-file", type=Path, required=True)
    parser.add_argument("--reader-file", type=Path, required=True)
    parser.add_argument("--proof-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--confirm-exact-project", required=True, choices=[PROJECT])
    args = parser.parse_args()
    try:
        provision(args.owner_file, args.reader_file, args.proof_directory, args.output)
    except Exception as exc:
        # A post-commit authentication error is not permission to recreate/reset
        # a role. Inspect role state and private configuration before retrying.
        print(json.dumps({"provisioning_verified": False, "error_type": type(exc).__name__,
                          "note": "No credential or SQL error contents displayed; inspect role state before retrying."}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
