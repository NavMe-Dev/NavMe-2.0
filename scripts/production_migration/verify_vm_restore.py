#!/usr/bin/env python3
"""Read-only verification of the dedicated, network-disabled recovery container.

Runs no production connection or restore. Compares every frozen snapshot table
and migration record, then captures private role/policy/ownership metadata.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from audit import secure_json


def identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def snapshot_query(inventory: dict, serialization: dict | None = None) -> str:
    parts = []
    for name in sorted(inventory["tables"]):
        schema, table = name.split(".", 1)
        relation = identifier(schema) + "." + identifier(table)
        parts.append(
            f"SELECT {literal(name)} AS name,count(*) AS row_count,"
            "md5(coalesce(string_agg(row_hash,'' ORDER BY row_hash COLLATE \"C\"),'')) AS content_digest "
            f"FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM {relation} AS t) AS rows"
        )
    if not parts:
        raise ValueError("The frozen source table inventory is empty")
    settings_sql = ""
    if serialization is not None:
        expected = {"extra_float_digits", "timezone", "bytea_output", "lc_numeric", "datestyle", "intervalstyle"}
        if set(serialization) != expected:
            raise ValueError("Complete source serialization settings are required")
        digits = int(serialization["extra_float_digits"])
        if not -15 <= digits <= 3:
            raise ValueError("Unsupported source floating-point serialization setting")
        settings_sql = "\n".join(f"SET LOCAL {identifier(name)}={literal(str(value))};"
                                  for name, value in serialization.items())
    return """BEGIN READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path=public,extensions;
SET LOCAL statement_timeout='120s';
""" + settings_sql + """
SELECT jsonb_build_object(
 'tables',(SELECT jsonb_object_agg(name,jsonb_build_object('row_count',row_count,'content_digest',content_digest)) FROM (
""" + " UNION ALL ".join(parts) + """
 ) AS all_tables),
 'alembic_version',(SELECT jsonb_agg(version_num ORDER BY version_num) FROM public.alembic_version),
 'supabase_migrations',(SELECT jsonb_agg(jsonb_build_object('version',version,'name',name) ORDER BY version) FROM supabase_migrations.schema_migrations),
 'extensions',(SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
 'server_version',version());
ROLLBACK;
"""


def metadata_query() -> str:
    return """BEGIN READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path=public,extensions;
SELECT jsonb_build_object(
 'database',(SELECT jsonb_agg(to_jsonb(x)) FROM (
  SELECT datname,datdba::regrole::text AS datdba,pg_get_userbyid(datdba) AS owner_name,
   encoding,datcollate,datctype,datlocprovider,datlocale,daticurules,datcollversion,
   datallowconn,datconnlimit,datistemplate,dathasloginevt,datacl
  FROM pg_database WHERE datname=current_database())x),
 'roles',(SELECT jsonb_agg(to_jsonb(x) ORDER BY rolname) FROM (
  SELECT oid,rolname,rolsuper,rolconfig,rolinherit,rolcanlogin,rolcreatedb,
   rolbypassrls,rolconnlimit,rolcreaterole,rolvaliduntil,rolreplication FROM pg_roles)x),
 'memberships',(SELECT jsonb_agg(to_jsonb(x) ORDER BY role,member,grantor) FROM (
  SELECT r.rolname AS role,m.rolname AS member,g.rolname AS grantor,
   a.set_option,a.admin_option,a.inherit_option
  FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid
   JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor)x),
 'schemas',(SELECT jsonb_agg(to_jsonb(x) ORDER BY schema) FROM (
  SELECT nspname AS schema,pg_get_userbyid(nspowner) AS owner,nspacl AS acl
  FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema')x),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname)
  FROM pg_policies p WHERE schemaname NOT LIKE 'pg_%'),
 'event_triggers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY name) FROM (
  SELECT evtname AS name,evttags AS tags,evtevent AS event,pg_get_userbyid(evtowner) AS owner,
   evtenabled AS enabled,evtfoid::regprocedure::text AS function FROM pg_event_trigger)x),
 'database_role_settings',(SELECT jsonb_agg(to_jsonb(x) ORDER BY role,database) FROM (
  SELECT r.rolname AS role,d.datname AS database,s.setconfig AS settings
  FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole
   LEFT JOIN pg_database d ON d.oid=s.setdatabase)x),
 'relation_acls',(SELECT jsonb_agg(to_jsonb(x) ORDER BY schema,relation) FROM (
  SELECT n.nspname AS schema,c.relname AS relation,c.relkind AS kind,
   pg_get_userbyid(c.relowner) AS owner,c.relacl AS acl,c.relrowsecurity AS rls,
   c.relforcerowsecurity AS force_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema')x),
 'function_acls',(SELECT jsonb_agg(to_jsonb(x) ORDER BY schema,name,arguments) FROM (
  SELECT n.nspname AS schema,p.proname AS name,pg_get_userbyid(p.proowner) AS owner,
   p.proconfig AS config,p.proacl AS acl,p.prosecdef AS security_definer,
   pg_get_function_identity_arguments(p.oid) AS arguments
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema')x));
ROLLBACK;
"""


def compare_snapshot(source: dict, target: dict, required: dict) -> dict:
    mismatches = []
    for name in sorted(source["tables"].keys() | target["tables"].keys()):
        if source["tables"].get(name) != target["tables"].get(name):
            mismatches.append(name)
    migrations_match = all(source.get(key) == target.get(key)
                           for key in ("alembic_version", "supabase_migrations"))
    expected_extensions = {(e["name"], e["version"]) for e in required["extensions"]}
    actual_extensions = {(e["name"], e["version"]) for e in target["extensions"]}
    extensions_match = expected_extensions == actual_extensions
    source_major = re.match(r"(?:PostgreSQL\s+)?(\d+)", required["server_version"])
    target_major = re.match(r"(?:PostgreSQL\s+)?(\d+)", target["server_version"])
    majors_match = bool(source_major and target_major and source_major[1] == target_major[1])
    return {"all_frozen_table_counts_and_digests_match": not mismatches,
            "table_count": len(source["tables"]), "mismatched_tables": mismatches,
            "migration_records_match": migrations_match,
            "exact_installed_extensions_match": extensions_match,
            "server_major_matches": majors_match,
            "snapshot_verification_pass": not mismatches and migrations_match and extensions_match and majors_match,
            "server_version": target["server_version"]}


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items() if key != "oid"}
    if isinstance(value, list):
        return sorted((normalized(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))
    return value


def compare_metadata(source: dict, target: dict) -> dict:
    categories = ("roles", "memberships", "schemas", "policies", "event_triggers",
                  "database_role_settings", "relation_acls", "function_acls")
    required = set(categories) | {"database"}
    if required - source.keys() or required - target.keys():
        raise ValueError("Incomplete source/target metadata cannot establish recovery integrity")
    if len(source["database"]) != 1 or len(target["database"]) != 1:
        raise ValueError("One source and one staging database property record is required")
    result = {key: normalized(source.get(key)) == normalized(target.get(key)) for key in categories}
    def database_settings(data):
        current_name = data["database"][0]["datname"]
        return [{**row, "database": "<current_database>" if row.get("database") == current_name else row.get("database")}
                for row in data.get("database_role_settings", [])]
    result["database_role_settings"] = normalized(database_settings(source)) == normalized(database_settings(target))
    # Database owner identity is owner_name, never a cluster-specific role OID.
    source_database = [{k: v for k, v in row.items() if k not in {"datname", "datdba"}} for row in source["database"]]
    target_database = [{k: v for k, v in row.items() if k not in {"datname", "datdba"}} for row in target["database"]]
    result["database_properties_except_staging_name"] = normalized(source_database) == normalized(target_database)
    return {"categories_match": result, "all_metadata_categories_match": all(result.values()),
            "comparison_scope": "Separate current read-only source metadata sidecar; not claimed as original data snapshot"}


def verify(lima_bin: Path, lima_home: Path, instance: str, container: str, backup: Path, output: Path):
    if instance != "navme-recovery" or not re.fullmatch(r"navme-recovery-db-v\d+", container):
        raise ValueError("Only the named isolated recovery runtime is allowed")
    if output.exists():
        raise ValueError("Verification output must be new")
    output.mkdir(mode=0o700)
    manifest = json.loads((backup / "capture-manifest.json").read_text())
    for name, entry in manifest["files"].items():
        if hashlib.sha256((backup / name).read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("Original capture checksum mismatch")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env["LIMA_HOME"] = str(lima_home)
    prefix = [str(lima_bin), "shell", instance, "sudo", "nerdctl"]
    inspect_result = subprocess.run(prefix + ["inspect", container], env=env, capture_output=True, check=True)
    container_data = json.loads(inspect_result.stdout)[0]
    if container_data.get("HostConfig", {}).get("NetworkMode") != "none":
        raise ValueError("Recovery container must have networking disabled")
    def query(sql: str, name: str):
        command = prefix + ["exec", "--user=root", "-i", container, "psql", "-h", "/var/run/postgresql",
                            "-U", "supabase_admin", "-d", "navme_destination_restore_test",
                            "-At", "--set=ON_ERROR_STOP=1", "--quiet"]
        result = subprocess.run(command, input=sql.encode(), env=env, capture_output=True, timeout=180)
        fd = os.open(output / (name + ".stderr"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as errors:
            errors.write(result.stderr)
        if result.returncode:
            raise RuntimeError("Private read-only verification query failed")
        data = json.loads(result.stdout)
        secure_json(output / (name + ".json"), data)
        return data
    source_snapshot = json.loads((backup / "snapshot-inventory.json").read_text())
    required = json.loads((backup / "source-requirements.json").read_text())
    serialization = json.loads((backup / "source-serialization-settings.json").read_text())
    target_snapshot = query(snapshot_query(source_snapshot, serialization), "restored-snapshot")
    target_metadata = query(metadata_query(), "restored-metadata")
    source_metadata = json.loads((backup / "source-current-metadata-sidecar.json").read_text())
    report = {**compare_snapshot(source_snapshot, target_snapshot, required),
              **compare_metadata(source_metadata, target_metadata),
              "production_writes": False, "container_network_disabled": True,
              "original_capture_checksums_unchanged": True,
              "archive_sha256": manifest["files"]["destination.dump"]["sha256"]}
    secure_json(output / "verification-report.json", report)
    print(json.dumps(report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("lima-bin", "lima-home", "backup", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--instance", default="navme-recovery")
    parser.add_argument("--container", default="navme-recovery-db-v4")
    args = parser.parse_args()
    verify(args.lima_bin, args.lima_home, args.instance, args.container, args.backup, args.output)


if __name__ == "__main__":
    main()
