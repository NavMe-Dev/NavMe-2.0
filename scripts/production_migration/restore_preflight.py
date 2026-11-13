#!/usr/bin/env python3
"""Read-only prerequisites for a complete isolated PostgreSQL recovery rehearsal.

This tool never creates, restores, alters, or drops a database. It refuses a
non-loopback inspection URL and does not turn archive readability into proof of
restoration. Source input contains server_version, extensions, and optional
roles/publications metadata, without passwords.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re

from sqlalchemy import create_engine, text

from audit import postgres_url, secure_json
from capture_destination import isolated_libpq_environment


def major_version(value: str) -> int:
    match = re.match(r"(?:PostgreSQL\s+)?(\d+)", str(value))
    if not match:
        raise ValueError("A recognized PostgreSQL server version is required")
    return int(match.group(1))


def local_inspection_url(value: str):
    parsed = postgres_url(value)
    routing = {"host", "hostaddr", "port", "dbname", "database", "service", "servicefile", "user", "password"}
    if routing.intersection(key.casefold() for key in parsed.query):
        raise ValueError("Local inspection connection cannot contain routing overrides")
    if not parsed.database or "://" in parsed.database or "=" in parsed.database:
        raise ValueError("An explicit local database name is required")
    if parsed.host == "localhost":
        # Explicit numeric loopback avoids inherited PGHOST or DNS overrides.
        return parsed.set(host="127.0.0.1")
    try:
        if parsed.host and ipaddress.ip_address(parsed.host).is_loopback:
            return parsed
    except ValueError:
        pass
    raise ValueError("Restore preflight target must use an explicit loopback host")


def inspect_target(value: str) -> dict:
    target = local_inspection_url(value)
    # Explicit host alone does not neutralize inherited PGHOSTADDR/PGSERVICE.
    # Reuse the backup capture's context; clear libpq state before importing
    # connection defaults and restore the calling environment even on failure.
    with isolated_libpq_environment():
        engine = create_engine(target, hide_parameters=True,
                               connect_args={"connect_timeout": 15})
        try:
            with engine.connect() as conn:
                conn.execute(text("SET TRANSACTION READ ONLY"))
                conn.execute(text("SET LOCAL statement_timeout = '30s'"))
                return {
                    "server_version": conn.execute(text("SHOW server_version")).scalar(),
                    "database": conn.execute(text("SELECT current_database()")).scalar(),
                    "extensions": [dict(r) for r in conn.execute(text(
                        "SELECT name,version,installed FROM pg_available_extension_versions ORDER BY 1,2"
                    )).mappings()],
                    "roles": conn.execute(text("SELECT rolname FROM pg_roles ORDER BY rolname")).scalars().all(),
                    "is_superuser": conn.execute(text(
                        "SELECT rolsuper FROM pg_roles WHERE rolname=current_user"
                    )).scalar(),
                    "wal_level": conn.execute(text("SHOW wal_level")).scalar(),
                    "shared_preload_libraries": conn.execute(text("SHOW shared_preload_libraries")).scalar(),
                }
        finally:
            engine.dispose()


def assess(source: dict, target: dict) -> dict:
    if not source.get("extensions"):
        raise ValueError("Source extension requirements are incomplete")
    source_major = major_version(source["server_version"])
    target_major = major_version(target["server_version"])
    blockers = []
    if source_major != target_major:
        blockers.append("Target PostgreSQL major differs; a target-major-specific full rehearsal is required")
    available = {(r["name"], r["version"]) for r in target["extensions"]}
    required_extensions = []
    for extension in source["extensions"]:
        name = extension.get("extname", extension.get("name"))
        version = extension.get("extversion", extension.get("version"))
        if not name or not version:
            raise ValueError("Each required extension must include its exact name and version")
        present = (name, version) in available
        required_extensions.append({"name": name, "version": version,
                                    "exact_version_available": present})
        if not present:
            blockers.append(f"Required extension/version unavailable: {name} {version}")
    if not target.get("is_superuser"):
        blockers.append("Local rehearsal administrator cannot preserve arbitrary role/owner definitions")
    required_roles = {
        row if isinstance(row, str) else row.get("rolname", row.get("name"))
        for row in source.get("roles", [])
    }
    if None in required_roles:
        raise ValueError("Source role metadata is malformed")
    if not source.get("roles"):
        blockers.append("Source global role/membership metadata is not supplied")
    missing_roles = sorted(required_roles - set(target.get("roles", [])))
    if missing_roles:
        blockers.append("Required global roles are absent; replay reviewed globals only into a fresh isolated cluster")
    extension_names = {e["name"] for e in required_extensions}
    if "pg_stat_statements" in extension_names and "pg_stat_statements" not in target.get("shared_preload_libraries", ""):
        blockers.append("pg_stat_statements is not preloaded in the inspection server")
    if source.get("publications") and target.get("wal_level") != "logical":
        blockers.append("Logical publication recovery requires an isolated server configured for logical WAL")
    external = []
    vault_status = None
    if "supabase_vault" in extension_names:
        count = source.get("vault_secret_count")
        if count is not None and (type(count) is not int or count < 0):
            raise ValueError("Vault secret count must be a verified nonnegative integer or absent")
        count_verified = source.get("vault_secret_count_snapshot_verified") is True
        empty_snapshot = count == 0 and count_verified
        vault_status = {"snapshot_secret_count": count, "snapshot_count_verified": count_verified,
                        "encrypted_secret_recovery_required": not empty_snapshot,
                        "extension_still_required": True}
        if not empty_snapshot:
            external.append("Vault encryption/server configuration must be recoverable and verified; a logical dump alone does not establish usable decrypted Vault secrets")
            if not source.get("vault_recovery_verified", False):
                blockers.append("Provider-supported Vault encryption/configuration recovery has not been verified")
    return {
        "preflight_pass": not blockers,
        "restore_executed": False,
        "full_restore_verified": False,
        "production_apply_allowed": False,
        "source_server_version": source["server_version"],
        "inspection_server_version": target["server_version"],
        "inspection_database": target.get("database"),
        "inspection_database_must_not_be_restore_target": True,
        "required_extensions": required_extensions,
        "missing_global_roles": missing_roles,
        "blockers": blockers,
        "external_recovery_requirements": external,
        "vault": vault_status,
        "next_step": "Prepare a fresh isolated matching-version cluster and reviewed recovery inputs; this tool has no restore operation",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--target-url-env", default="LOCAL_RESTORE_DATABASE_URL")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    value = os.environ.get(args.target_url_env)
    if not value:
        parser.error("The named local inspection environment variable is empty")
    try:
        report = assess(json.loads(args.source_manifest.read_text()), inspect_target(value))
        secure_json(args.output, report)
        print("Restore prerequisites PASS" if report["preflight_pass"] else "Restore prerequisites HOLD; private report written")
        return 0 if report["preflight_pass"] else 2
    except Exception as exc:
        print(f"Preflight failed ({type(exc).__name__}); no database changes performed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
