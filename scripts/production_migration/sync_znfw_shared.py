#!/usr/bin/env python3
"""Add missing exported znfw rows to the exact occupied kzp project.

Default is a rollback-only plan. Existing destination rows always win, including
passwords and configuration. Raw exports and reports remain in ignored private
directories. The tool never changes persistent schema or disables triggers.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re

from dotenv import dotenv_values
import psycopg
from psycopg import sql

try:
    from .capture_destination import validate_target, isolated_libpq_environment
except ImportError:
    from capture_destination import validate_target, isolated_libpq_environment

SOURCE = "znfwcohrpkiccibqcfpn"
DESTINATION = "kzpvhzyefdtrtidrbuxb"


class CommittedReportError(RuntimeError):
    """The database committed successfully but its local report could not be saved."""


def freeze(value):
    """Hashable JSON equality without treating object key order as content."""
    if isinstance(value, dict):
        return tuple(sorted((key, freeze(item)) for key, item in value.items()))
    if isinstance(value, list):
        return tuple(freeze(item) for item in value)
    return value


def row_key(row, columns):
    values = tuple(freeze(row.get(column)) for column in columns)
    return None if not columns or any(value is None for value in values) else values


def unique_keys(config, name):
    result = []
    for metadata in (config["source_metadata"], config["destination_metadata"]):
        for constraint in metadata["constraints"]:
            columns = tuple(constraint.get("columns") or ())
            if constraint["table"] == name and constraint["type"] == "u" and columns not in result:
                result.append(columns)
    return result


def plan_table(table, source, destination, natural_keys):
    """Return source ordinals to insert and private conflict metadata."""
    columns = [column["column_name"] for column in table["columns"]]
    primary = table["primary_keys"]
    projected = lambda row: {column: row.get(column) for column in columns}
    report = {"source_rows": len(source), "destination_rows": len(destination),
              "matching_primary_keys": 0, "identical_rows": 0,
              "conflicts": [], "candidates": [], "blockers": []}
    by_pk = defaultdict(list)
    for row in destination:
        if primary:
            by_pk[row_key(row, primary)].append(row)
    natural_maps = [{row_key(row, key): row for row in destination if row_key(row, key) is not None}
                    for key in natural_keys]
    seen_primary = set()
    source_natural = [set() for _ in natural_keys]
    existing_full = Counter(freeze(projected(row)) for row in destination)
    for ordinal, row in source:
        key = row_key(row, primary)
        if primary and (key is None or key in seen_primary):
            report["blockers"].append({"reason": "source_invalid_or_duplicate_primary_key", "key": key})
            continue
        seen_primary.add(key)
        duplicate_natural = False
        for index, natural in enumerate(natural_keys):
            value = row_key(row, natural)
            if value is not None:
                if value in source_natural[index]:
                    report["blockers"].append({"reason": "source_duplicate_natural_key", "columns": natural, "key": value})
                    duplicate_natural = True
                source_natural[index].add(value)
        if duplicate_natural:
            continue
        if primary and key in by_pk:
            report["matching_primary_keys"] += 1
            matches = by_pk[key]
            if any(projected(match) == projected(row) for match in matches):
                report["identical_rows"] += 1
            else:
                changed = [column for column in columns if matches[0].get(column) != row.get(column)]
                report["conflicts"].append({"reason": "existing_primary_key", "key": key, "different_columns": changed})
            continue
        if not primary:
            value = freeze(projected(row))
            if existing_full[value]:
                existing_full[value] -= 1
                report["identical_rows"] += 1
                continue
        collision = next(((natural, natural_maps[index][row_key(row, natural)])
                          for index, natural in enumerate(natural_keys)
                          if row_key(row, natural) is not None and row_key(row, natural) in natural_maps[index]), None)
        if collision:
            natural, match = collision
            report["conflicts"].append({"reason": "existing_natural_key", "key": key,
                                        "columns": natural, "destination_key": row_key(match, primary)})
            continue
        report["candidates"].append(ordinal)
        # Reserve each accepted natural identity against subsequent candidates.
        for index, natural in enumerate(natural_keys):
            value = row_key(row, natural)
            if value is not None:
                natural_maps[index][value] = row
    return report


def foreign_keys(config):
    keys = []
    for constraint in config["source_metadata"]["constraints"]:
        if constraint["type"] != "f":
            continue
        match = re.search(r"REFERENCES\s+(?:\w+\.)?\"?(\w+)\"?\s*\(([^)]+)\)", constraint["definition"])
        if not match:
            raise ValueError("Unsupported foreign-key definition")
        keys.append({"table": constraint["table"], "columns": constraint["columns"],
                     "parent": match[1], "parent_columns": [part.strip().strip('"') for part in match[2].split(',')]})
    # Legacy application relationship absent from the source's FK catalog.
    names = {table["name"] for table in config["tables"]}
    if {"navme_nav_matrix_items", "navme_nav_matrices"} <= names:
        keys.append({"table": "navme_nav_matrix_items", "columns": ["matrix_id"],
                     "parent": "navme_nav_matrices", "parent_columns": ["id"]})
    return keys


def filter_foreign_keys(config, source, destination, plans):
    """Withhold children whose source parent cannot safely exist in the merge."""
    tables = {table["name"]: table for table in config["tables"]}
    by_ordinal = {name: dict(rows) for name, rows in source.items()}
    changed = True
    while changed:
        changed = False
        for foreign in foreign_keys(config):
            name, parent = foreign["table"], foreign["parent"]
            if name not in plans or parent not in plans:
                raise ValueError("A referenced source table is outside the reviewed scope")
            parent_columns = foreign["parent_columns"]
            parent_dest = defaultdict(list)
            for row in destination[parent]:
                parent_dest[row_key(row, parent_columns)].append(row)
            parent_source = {row_key(row, parent_columns): row for _, row in source[parent]}
            parent_candidates = {row_key(by_ordinal[parent][ordinal], parent_columns)
                                 for ordinal in plans[parent]["candidates"]}
            identities = unique_keys(config, parent)
            if "poi_type" in {column["column_name"] for column in tables[parent]["columns"]}:
                identities.append(("poi_type",))
            keep = []
            for ordinal in plans[name]["candidates"]:
                row = by_ordinal[name][ordinal]
                key = row_key(row, foreign["columns"])
                if key is None or key in parent_candidates:
                    keep.append(ordinal)
                    continue
                matches = parent_dest.get(key, [])
                reason = None
                if not matches:
                    reason = "missing_parent_after_preserving_destination"
                elif key in parent_source:
                    original = parent_source[key]
                    if not any(all(row_key(match, identity) == row_key(original, identity)
                                       for identity in identities) for match in matches):
                        reason = "parent_identity_conflict"
                if reason:
                    plans[name]["conflicts"].append({"reason": reason, "ordinal": ordinal,
                        "key": row_key(row, tables[name]["primary_keys"]), "parent": parent, "parent_key": key})
                    changed = True
                else:
                    keep.append(ordinal)
            plans[name]["candidates"] = keep


def insertion_order(config):
    remaining = {table["name"] for table in config["tables"]}
    dependencies = defaultdict(set)
    for foreign in foreign_keys(config):
        if foreign["parent"] != foreign["table"]:
            dependencies[foreign["table"]].add(foreign["parent"])
    order = []
    while remaining:
        ready = sorted(name for name in remaining if not (dependencies[name] & remaining))
        if not ready:
            raise ValueError("Foreign-key insertion order contains a cycle")
        order.extend(ready)
        remaining.difference_update(ready)
    return order


def private_json(stream, value):
    # Serialize before replacing an earlier diagnostic. The descriptor was
    # exclusively reserved before any database operation and remains open.
    encoded = json.dumps(value, indent=2, default=str) + "\n"
    stream.seek(0)
    stream.write(encoded)
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())


def public_tables(cursor):
    cursor.execute("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                   "WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname")
    return [row[0] for row in cursor.fetchall()]


def stage_source(cursor, config, directory):
    staged = {}
    fingerprints = {}
    manifest_path = directory / "source" / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    entries = {entry["table"]: entry for entry in manifest.get("tables", [])}
    for index, table in enumerate(config["tables"]):
        name = table["name"]
        path = directory / "source" / (name + ".ndjson")
        if not path.is_file():
            raise ValueError(f"Missing source export for {name}")
        expected_hash = entries.get(name, {}).get("sha256")
        if expected_hash and hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Source export checksum differs from manifest for {name}")
        temp = "znfw_source_" + str(index)
        cursor.execute("CREATE TEMP TABLE znfw_raw (ordinal bigint, line text)")
        count = 0
        with cursor.copy("COPY znfw_raw (ordinal,line) FROM STDIN") as copy:
            with path.open() as stream:
                for count, line in enumerate(stream, 1):
                    json.loads(line)  # Reject incomplete/invalid exports before any public writes.
                    copy.write_row((count, line.strip()))
        cursor.execute(sql.SQL("CREATE TEMP TABLE {} AS SELECT raw.ordinal AS _sync_ordinal, record.* "
                              "FROM znfw_raw raw CROSS JOIN LATERAL jsonb_populate_record(NULL::public.{}, raw.line::jsonb) record")
                       .format(sql.Identifier(temp), sql.Identifier(name)))
        cursor.execute(sql.SQL("CREATE UNIQUE INDEX ON {} (_sync_ordinal)").format(sql.Identifier(temp)))
        cursor.execute("DROP TABLE znfw_raw")
        columns = sql.SQL(',').join(sql.Identifier(column["column_name"]) for column in table["columns"])
        cursor.execute(sql.SQL("SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' "
                               "ORDER BY md5(to_jsonb(t)::text) COLLATE \"C\"),'')) FROM (SELECT {} FROM {}) t")
                       .format(columns, sql.Identifier(temp)))
        row_count, digest = cursor.fetchone()
        fingerprints[name] = {"row_count": row_count, "digest": digest}
        expected = table["source_inventory"]
        if row_count != expected["row_count"] or digest != expected["digest"]:
            # Private diagnostic is intentionally free of row values.
            raise ValueError(f"Source export verification failed for {name}: rows={row_count}, digest={digest}")
        staged[name] = temp
        print(json.dumps({"staged": name, "rows": count}), flush=True)
    return staged, fingerprints


def read_rows(cursor, config, staged):
    source, destination = {}, {}
    for table in config["tables"]:
        name = table["name"]
        cursor.execute(sql.SQL("SELECT _sync_ordinal,(to_jsonb(t)-'_sync_ordinal')::text FROM {} t ORDER BY _sync_ordinal")
                       .format(sql.Identifier(staged[name])))
        source[name] = [(ordinal, json.loads(value, parse_float=Decimal)) for ordinal, value in cursor.fetchall()]
        cursor.execute(sql.SQL("SELECT to_jsonb(t)::text FROM public.{} t").format(sql.Identifier(name)))
        destination[name] = [json.loads(row[0], parse_float=Decimal) for row in cursor.fetchall()]
    return source, destination


def baseline(cursor, names):
    for index, name in enumerate(names):
        cursor.execute(sql.SQL("CREATE TEMP TABLE {} AS SELECT to_jsonb(t) j FROM public.{} t")
                       .format(sql.Identifier("znfw_before_" + str(index)), sql.Identifier(name)))


def verify_baseline(cursor, names):
    for index, name in enumerate(names):
        cursor.execute(sql.SQL("SELECT count(*) FROM (SELECT j FROM {} EXCEPT ALL SELECT to_jsonb(t) FROM public.{} t) missing")
                       .format(sql.Identifier("znfw_before_" + str(index)), sql.Identifier(name)))
        if cursor.fetchone()[0]:
            raise ValueError(f"Existing destination content changed in {name}; transaction must roll back")


def gmap_collisions(cursor, source, destination, plans):
    """The POI trigger must never update an existing derived GMap record."""
    if "navme_pois" not in plans:
        return []
    cursor.execute("SELECT id::text,poi_type FROM public.navme_gmap_buildings")
    buildings = defaultdict(list)
    for building_id, poi_type in cursor.fetchall():
        buildings[poi_type].append(building_id)
    cursor.execute("SELECT building_id::text,src_id FROM public.navme_gmap_pois WHERE src_id IS NOT NULL")
    existing = set(cursor.fetchall())
    features = list(destination["navme_project_features"])
    source_features = dict(source["navme_project_features"])
    features.extend(source_features[ordinal] for ordinal in plans["navme_project_features"]["candidates"])
    enabled = {row["poi_type"] for row in features if row.get("navme_gmap_enabled")}
    pois = dict(source["navme_pois"])
    return [{"table": "navme_pois", "reason": "gmap_trigger_would_modify_existing_record", "key": pois[ordinal]["id"]}
            for ordinal in plans["navme_pois"]["candidates"]
            if pois[ordinal].get("poi_type") in enabled
            and any((building, pois[ordinal]["id"]) in existing for building in buildings[pois[ordinal]["poi_type"]])]


def advance_sequences(cursor, config, plans):
    for table in config["tables"]:
        name = table["name"]
        if not plans[name]["candidates"]:
            continue
        for column in table["columns"]:
            cursor.execute("SELECT pg_get_serial_sequence(%s,%s)", ("public." + name, column["column_name"]))
            sequence = cursor.fetchone()[0]
            if not sequence:
                continue
            cursor.execute(sql.SQL("SELECT last_value,is_called FROM {}")
                           .format(sql.Identifier(*sequence.split('.'))))
            last, called = cursor.fetchone()
            cursor.execute(sql.SQL("SELECT max({}) FROM public.{}")
                           .format(sql.Identifier(column["column_name"]), sql.Identifier(name)))
            maximum = cursor.fetchone()[0]
            if maximum is not None and (maximum > last or (maximum == last and not called)):
                cursor.execute("SELECT setval(%s::regclass,%s,true)", (sequence, maximum))


def sync(args, report_stream):
    config = json.loads(args.config.read_text())
    if config["source_project"] != SOURCE or config["destination_project"] != DESTINATION:
        raise ValueError("Unexpected source or destination project")
    directory = args.config.parent
    if args.apply:
        if not args.backup_manifest:
            raise ValueError("Apply requires a fresh completed destination backup manifest")
        backup = json.loads(args.backup_manifest.read_text())
        completed = datetime.fromisoformat(backup["completed_at"])
        age = (datetime.now(timezone.utc) - completed).total_seconds()
        if (backup.get("project_id") != DESTINATION or not backup.get("archive_fully_decoded")
                or not 0 <= age <= 86400):
            raise ValueError("Backup must be completed, verified readable, and less than 24 hours old")
        archive = args.backup_manifest.parent / "destination.dump"
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != backup["files"]["destination.dump"]["sha256"]:
            raise ValueError("Backup archive checksum differs from its manifest")
    secret = dotenv_values(args.secret_file, interpolate=False).get("SUPABASE_DATABASE_URL", "")
    target = validate_target(secret)
    report = {"source_project": SOURCE, "destination_project": DESTINATION,
              "started_at": datetime.now(timezone.utc).isoformat(), "apply": args.apply, "committed": False}
    with isolated_libpq_environment(), psycopg.connect(host=target.host, port=target.port or 5432,
            user=target.username, password=target.password, dbname=target.database, sslmode="require",
            connect_timeout=15, prepare_threshold=None, autocommit=True,
            application_name="navme-additive-znfw-sync") as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET statement_timeout='180s'")
            cursor.execute("SET TIME ZONE 'UTC'")
            with connection.transaction():
                staged, fingerprints = stage_source(cursor, config, directory)
                report["verified_source"] = fingerprints
            cursor.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
            try:
                if args.apply:
                    lock_names = sorted({table["name"] for table in config["tables"]} | {"navme_gmap_pois", "navme_gmap_buildings"})
                    cursor.execute("SET LOCAL lock_timeout='15s'")
                    cursor.execute(sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE")
                                   .format(sql.SQL(',').join(sql.Identifier('public', name) for name in lock_names)))
                names = public_tables(cursor)
                baseline(cursor, names)
                source, destination = read_rows(cursor, config, staged)
                plans = {table["name"]: plan_table(table, source[table["name"]], destination[table["name"]],
                                                   unique_keys(config, table["name"])) for table in config["tables"]}
                filter_foreign_keys(config, source, destination, plans)
                blockers = [dict(table=name, **blocker) for name, plan in plans.items() for blocker in plan["blockers"]]
                blockers.extend(gmap_collisions(cursor, source, destination, plans))
                report.update(tables=plans, blockers=blockers, candidate_rows=sum(len(plan["candidates"]) for plan in plans.values()),
                              conflict_rows=sum(len(plan["conflicts"]) for plan in plans.values()))
                if args.apply and blockers:
                    raise ValueError("Plan has unresolved blockers; no public writes were attempted")
                if args.apply:
                    tables = {table["name"]: table for table in config["tables"]}
                    for name in insertion_order(config):
                        ordinals = plans[name]["candidates"]
                        if not ordinals:
                            plans[name]["inserted_rows"] = 0
                            continue
                        columns = [column["column_name"] for column in tables[name]["columns"] if not column["generated"]]
                        column_sql = sql.SQL(',').join(map(sql.Identifier, columns))
                        cursor.execute(sql.SQL("INSERT INTO public.{} ({}) OVERRIDING SYSTEM VALUE SELECT {} FROM {} "
                                               "WHERE _sync_ordinal=ANY(%s::bigint[])")
                                       .format(sql.Identifier(name), column_sql, column_sql, sql.Identifier(staged[name])), (ordinals,))
                        if cursor.rowcount != len(ordinals):
                            raise ValueError("Inserted row count differs from the locked plan")
                        plans[name]["inserted_rows"] = cursor.rowcount
                        print(json.dumps({"inserted": name, "rows": cursor.rowcount}), flush=True)
                    verify_baseline(cursor, names)
                    advance_sequences(cursor, config, plans)
                    cursor.execute("COMMIT")
                    report["committed"] = True
                    report["baseline_preserved"] = True
                else:
                    cursor.execute("ROLLBACK")
            except Exception as exc:
                cursor.execute("ROLLBACK")
                report["error_type"] = type(exc).__name__
                report["error"] = str(exc) if isinstance(exc, ValueError) else "Database operation failed; private data omitted"
                report["completed_at"] = datetime.now(timezone.utc).isoformat()
                private_json(report_stream, report)
                raise
    report["completed_at"] = datetime.now(timezone.utc).isoformat()
    try:
        private_json(report_stream, report)
    except Exception as exc:
        if report["committed"]:
            raise CommittedReportError("Database committed; saving the local report failed") from exc
        raise
    print(json.dumps({key: report.get(key) for key in ("apply", "committed", "candidate_rows", "conflict_rows", "baseline_preserved")}
                     | {"blocker_count": len(report["blockers"]), "private_report": str(args.report)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--secret-file", type=Path, default=Path("dashboard/.env.production-migration"))
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--backup-manifest", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        # Reserve and verify the exact output path before opening a database
        # connection. A reused path can never produce a successful unreported
        # migration. Keep the open descriptor, so final saving cannot fail due
        # to a second exclusive-create attempt after COMMIT.
        descriptor = os.open(args.report, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w+") as report_stream:
            private_json(report_stream, {"apply": args.apply, "committed": False, "status": "started"})
            sync(args, report_stream)
    except CommittedReportError:
        print(json.dumps({"committed": True, "report_saved": False,
                          "message": "Database sync committed successfully; the local report could not be saved"}))
        return 2
    except Exception as exc:
        print(json.dumps({"committed": False, "error_type": type(exc).__name__,
                          "message": str(exc) if isinstance(exc, ValueError) else "Inspect private report; credentials and data omitted"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
