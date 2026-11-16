#!/usr/bin/env python3
"""Install only the UNC viewpoint capability; default rehearses and rolls back."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import sys

import psycopg
from psycopg import sql
from dotenv import dotenv_values

from capture_destination import isolated_libpq_environment, validate_target

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "platform/api"))
from wayfinding_api.services.poi_viewpoints import FUNCTION_SQL, ROLE, SCHEMA, connection_arguments

OUT = ROOT / "platform/var/data/production_migration/2026-11-16-poi-viewpoints"


def private_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def digests(c):
    result = {}
    for name in ("pois", "buildings", "map_versions", "navme_pois"):
        row = c.execute(sql.SQL("SELECT count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM public.{} t").format(sql.Identifier(name))).fetchone()
        result[name] = {"rows": row[0], "digest": row[1]}
    return result


def install(c, password):
    if c.execute("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=%s)", (ROLE,)).fetchone()[0]:
        raise RuntimeError("viewpoint_role_already_exists")
    if c.execute("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=%s)", (SCHEMA,)).fetchone()[0]:
        raise RuntimeError("viewpoint_schema_already_exists")
    verifier = c.pgconn.encrypt_password(password.encode(), ROLE.encode(), b"scram-sha-256").decode()
    c.execute(sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD {}").format(sql.Identifier(ROLE), sql.Literal(verifier)))
    c.execute(sql.SQL("CREATE SCHEMA {} AUTHORIZATION CURRENT_USER").format(sql.Identifier(SCHEMA)))
    c.execute(sql.SQL("REVOKE ALL ON SCHEMA {} FROM PUBLIC").format(sql.Identifier(SCHEMA)))
    c.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(SCHEMA), sql.Identifier(ROLE)))
    c.execute(FUNCTION_SQL)
    direct = c.execute("""SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','auth','storage') AND c.relkind IN ('r','p','v','m')
        AND (has_table_privilege(%s,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
             OR has_any_column_privilege(%s,c.oid,'INSERT,UPDATE'))""", (ROLE, ROLE)).fetchone()[0]
    if direct:
        raise RuntimeError("writer_has_unexpected_direct_write_privileges")
    memberships = c.execute("SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=%s)", (ROLE,)).fetchone()[0]
    if memberships:
        raise RuntimeError("writer_has_unexpected_memberships")
    permissions = c.execute("""SELECT p.prosecdef,p.proconfig,
        NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
        has_function_privilege(%s,p.oid,'EXECUTE') FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=%s""", (ROLE, SCHEMA)).fetchall()
    if len(permissions) != 1 or not all((permissions[0][0], permissions[0][2], permissions[0][3])):
        raise RuntimeError("function_privileges_invalid")
    if "search_path=pg_catalog" not in permissions[0][1]:
        raise RuntimeError("unsafe_function_search_path")
    # Managed Postgres does not grant SET ROLE to its login creator. Verify ACLs
    # here; authenticate the dedicated login after commit before activating it.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    OUT.chmod(0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    report = {"apply_requested": args.apply, "application_rows_changed": False}
    try:
        target = validate_target(dotenv_values(ROOT / "dashboard/.env.production-migration", interpolate=False)["SUPABASE_DATABASE_URL"])
        password = secrets.token_urlsafe(36)
        secret_path = OUT / "writer-config.json"
        if args.apply and secret_path.exists():
            raise RuntimeError("private_writer_config_already_exists")
        with isolated_libpq_environment(), psycopg.connect(
            host=target.host, port=5432, dbname=target.database, user=target.username,
            password=target.password, sslmode="require", connect_timeout=15,
            application_name="navme-install-viewpoint-writer", autocommit=True) as c:
            if not c.pgconn.ssl_in_use:
                raise RuntimeError("tls_required")
            c.execute("BEGIN")
            try:
                c.execute("SET LOCAL lock_timeout='10s'")
                c.execute("SET LOCAL statement_timeout='30s'")
                c.execute("LOCK TABLE public.pois,public.buildings,public.map_versions,public.navme_pois IN SHARE MODE")
                scope = c.execute("""SELECT count(*) FROM public.pois p JOIN public.buildings b ON b.id=p.building_id
                    WHERE b.id=3 AND b.slug='uncc-main-campus' AND b.matterport_model_id='kQBN52JqFE9'
                    AND p.source='supabase' AND p.published""").fetchone()[0]
                if scope != 47:
                    raise RuntimeError("unexpected_unc_publication")
                before = digests(c)
                install(c, password)
                if digests(c) != before:
                    raise RuntimeError("application_data_changed")
                report.update(status="verified", data_digests=before, direct_table_writes=False,
                              public_function_execute=False, private_function_execute=True)
                if args.apply:
                    login = ROLE if target.host.startswith("db.") else ROLE + ".kzpvhzyefdtrtidrbuxb"
                    writer_url = target.set(drivername="postgresql", username=login, password=password,
                                            query={"sslmode": "require"}).render_as_string(hide_password=False)
                    private_json(secret_path, {"POI_VIEWPOINT_DATABASE_URL": writer_url,
                                               "POI_VIEWPOINT_BUILDINGS": "uncc-main-campus"})
                c.execute("COMMIT" if args.apply else "ROLLBACK")
                report["status"] = "applied" if args.apply else "dry_run_rolled_back"
            except BaseException:
                c.execute("ROLLBACK")
                raise
        if args.apply:
            with isolated_libpq_environment(), psycopg.connect(**connection_arguments(writer_url)) as writer:
                if not writer.pgconn.ssl_in_use or writer.execute("SELECT current_user").fetchone()[0] != ROLE:
                    raise RuntimeError("actual_writer_authentication_failed")
                try:
                    with writer.transaction():
                        writer.execute("SELECT navme_viewpoint_private.set_viewpoint('uncc-main-campus',-1,NULL,'default')")
                        raise RuntimeError("actual_writer_scope_probe_failed")
                except psycopg.errors.NoDataFound:
                    report["actual_login_and_scoped_execute_verified"] = True
    except Exception as error:
        report.update(status="failed", reason=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        if isinstance(error, psycopg.Error):
            report["database_reason"] = error.diag.message_primary
    private_json(OUT / (stamp + "-report.json"), report)
    print(json.dumps({k: v for k, v in report.items() if k not in {"data_digests", "database_reason"}}))
    return 0 if report["status"] in {"applied", "dry_run_rolled_back"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
