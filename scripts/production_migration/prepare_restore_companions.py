#!/usr/bin/env python3
"""Prepare private, staging-only companions for complete Supabase restoration.

No database connection is made. Original capture files are verified and never
modified. Inputs are captured metadata, never production connection credentials.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

from audit import secure_json
from verify_vm_restore import identifier, literal, normalized

GUARD = "DO $guard$ BEGIN IF current_database()<>'navme_destination_restore_test' THEN RAISE EXCEPTION 'Wrong isolated target'; END IF; END $guard$;"


def private_text(path: Path, value: str):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(value)


def owners_settings(source: dict, target: dict) -> str:
    lines = ["-- ISOLATED STAGING ONLY: captured managed ownership/database settings.", "BEGIN;", GUARD]
    existing = {(r["schema"], r["name"], r["arguments"]): r for r in target["function_acls"]}
    for row in source["function_acls"]:
        current = existing[(row["schema"], row["name"], row["arguments"])]
        if row["owner"] != current["owner"]:
            lines.append("ALTER FUNCTION " + identifier(row["schema"]) + "." + identifier(row["name"]) +
                         "(" + row["arguments"] + ") OWNER TO " + identifier(row["owner"]) + ";")
    existing = {(r["schema"], r["relation"]): r for r in target["relation_acls"]}
    for row in source["relation_acls"]:
        current = existing[(row["schema"], row["relation"])]
        if row["owner"] != current["owner"]:
            if row["kind"] != "v":
                raise ValueError("Unexpected relation ownership change requires explicit review")
            lines.append("ALTER VIEW " + identifier(row["schema"]) + "." + identifier(row["relation"]) +
                         " OWNER TO " + identifier(row["owner"]) + ";")
    for row in source["database_role_settings"]:
        if row["database"] == source["database"][0]["datname"]:
            if row["role"] is not None:
                raise ValueError("Role-and-database-specific configuration requires explicit review")
            for setting in row["settings"]:
                name, separator, value = setting.partition("=")
                if not separator or not re.fullmatch(r"[A-Za-z][A-Za-z_0-9.]*", name):
                    raise ValueError("Malformed captured configuration")
                # FROM CURRENT preserves list-valued GUCs without reparsing them
                # as a single quoted identifier. Output may be sensitive: 0600.
                lines.append("SELECT set_config(" + literal(name) + "," + literal(value) + ",true);")
                lines.append("ALTER DATABASE navme_destination_restore_test SET " + identifier(name) + " FROM CURRENT;")
    return "\n".join(lines + ["COMMIT;", ""])


def database_acls(source: dict) -> str:
    row = source["database"][0]
    if row["owner_name"] != "postgres" or not isinstance(row["datacl"], list):
        raise ValueError("Reviewed database owner/explicit ACL inventory is required")
    if not all(value.rsplit("/", 1)[1] == "postgres" for value in row["datacl"]):
        raise ValueError("Non-owner database grantors need separate review")
    desired = "ARRAY[" + ",".join(literal(value) for value in row["datacl"]) + "]::aclitem[]"
    return """-- ISOLATED STAGING ONLY: captured database ACLs.
BEGIN;
""" + GUARD + """
REVOKE ALL PRIVILEGES ON DATABASE navme_destination_restore_test FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE navme_destination_restore_test FROM postgres;
SET LOCAL ROLE postgres;
DO $acl$ DECLARE item record; target_role text; BEGIN
 FOR item IN SELECT * FROM aclexplode(""" + desired + """) LOOP
  IF item.privilege_type NOT IN ('CREATE','CONNECT','TEMPORARY') THEN RAISE EXCEPTION 'Unexpected database privilege'; END IF;
  target_role := CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END;
  EXECUTE format('GRANT %s ON DATABASE navme_destination_restore_test TO %s%s',item.privilege_type,target_role,
   CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
 END LOOP;
END $acl$;
COMMIT;
"""


def object_acls(source: dict, target: dict) -> str:
    lines = ["-- ISOLATED STAGING ONLY: exact captured managed schema/relation ACLs.", "BEGIN;", GUARD]
    for category, keys in (("schemas", ["schema"]), ("relation_acls", ["schema", "relation"])):
        existing = {tuple(row[key] for key in keys): row for row in target[category]}
        for row in source[category]:
            current = existing[tuple(row[key] for key in keys)]
            if normalized(row["acl"]) == normalized(current["acl"]):
                continue
            if row["acl"] is None:
                raise ValueError("Default ACL replay requires explicit review")
            if category == "relation_acls" and row["kind"] not in {"r", "p", "v", "m", "f"}:
                raise ValueError("Unreviewed relation ACL kind requires separate handling")
            obj = "SCHEMA " + identifier(row["schema"]) if category == "schemas" else "TABLE " + identifier(row["schema"]) + "." + identifier(row["relation"])
            kind = "n" if category == "schemas" else "r"
            desired = "ARRAY[" + ",".join(literal(value) for value in row["acl"]) + "]::aclitem[]"
            previous = "ARRAY[" + ",".join(literal(value) for value in current["acl"]) + "]::aclitem[]" if current["acl"] is not None else "acldefault(" + literal(kind) + "," + literal(current["owner"]) + "::regrole::oid)"
            lines.append("""DO $acl$ DECLARE item record; target_role text; BEGIN
 FOR item IN SELECT DISTINCT grantee FROM aclexplode(""" + previous + """)
             UNION SELECT grantee FROM aclexplode(""" + desired + """) LOOP
  target_role := CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END;
  EXECUTE """ + literal("REVOKE ALL PRIVILEGES ON " + obj + " FROM ") + """ || target_role;
 END LOOP;
 FOR item IN SELECT * FROM aclexplode(""" + desired + """)
             ORDER BY (grantor=""" + literal(row["owner"]) + """::regrole::oid) DESC,is_grantable DESC,grantor,grantee LOOP
  IF item.privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN','USAGE','CREATE') THEN RAISE EXCEPTION 'Unexpected captured privilege'; END IF;
  EXECUTE format('SET LOCAL ROLE %I',pg_get_userbyid(item.grantor));
  target_role := CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END;
  EXECUTE 'GRANT ' || item.privilege_type || """ + literal(" ON " + obj + " TO ") + """ || target_role || CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  EXECUTE 'RESET ROLE';
 END LOOP;
END $acl$;""")
    return "\n".join(lines + ["COMMIT;", ""])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["bootstrap", "owners-settings", "acls"])
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-metadata", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Use new private companion output")
    manifest = json.loads((args.backup / "capture-manifest.json").read_text())
    for name, entry in manifest["files"].items():
        if hashlib.sha256((args.backup / name).read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("Original capture checksum mismatch")
    source_path = args.backup / "source-current-metadata-sidecar.json"
    source = json.loads(source_path.read_text())
    args.output.mkdir(mode=0o700)
    if args.phase == "bootstrap":
        original = (args.backup / "roles-without-passwords.sql").read_text()
        if original.count("CREATE ROLE supabase_admin;") != 1:
            raise ValueError("Expected matching source bootstrap identity was not found")
        private_text(args.output / "roles-staging-bootstrap.sql", original.replace("CREATE ROLE supabase_admin;", "-- Matching bootstrap supabase_admin already created by isolated initdb."))
        original_list = (args.backup / "archive.list").read_text().splitlines(True)
        for name, event_only in (("archive-without-event-triggers.list", False), ("archive-event-triggers.list", True)):
            private_text(args.output / name, "".join("; deferred staging checkpoint: " + line if line.strip() and not line.startswith(";") and ("EVENT TRIGGER" in line) != event_only else line for line in original_list))
        private_text(args.output / "database-acls-staging.sql", database_acls(source))
    else:
        if not args.target_metadata:
            raise ValueError("Target metadata from the preceding restoration checkpoint is required")
        target = json.loads(args.target_metadata.read_text())
        function = owners_settings if args.phase == "owners-settings" else object_acls
        private_text(args.output / (args.phase + "-staging.sql"), function(source, target))
    secure_json(args.output / "companion-manifest.json", {
        "phase": args.phase, "production_apply_allowed": False,
        "original_capture_checksums_verified": True,
        "source_current_metadata_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "files": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in args.output.iterdir() if path.is_file()},
    })
    print("Private staging companions prepared; no database connection or changes performed")


if __name__ == "__main__":
    main()
