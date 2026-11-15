#!/usr/bin/env python3
"""Reconcile reviewed UNC Studio edits, preserving destination calibrations.

Source inputs are private read-only MCP snapshots, never source credentials.
The default rehearses all updates and rolls back. --apply explicitly commits.
All backups/reports are private; stdout contains only counts and local paths.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid

from dotenv import dotenv_values
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from capture_destination import isolated_libpq_environment, validate_target


ROOT = Path(__file__).resolve().parents[2]
COPY = ROOT / "platform/var/data/production_migration/2026-11-16-znfw-sync"
WORK = COPY / "studio-reconcile"
SOURCE_PROJECT = "znfwcohrpkiccibqcfpn"
DESTINATION_PROJECT = "kzpvhzyefdtrtidrbuxb"
POI_TYPE = "Uncc_Navme"
BUILDING_ID = 3
BUILDING_SLUG = "uncc-main-campus"
EXPECTED_POIS = 47
ROUNDING_TOLERANCE = Decimal("0.001")
TRIGGER_DIGEST = "13e7e75058b5876867c74ae950e5c65e"
FEATURE_FIELDS = ("walkthrough_mode", "matterport_navigation", "whitelabeled_url")
POSITION = ("pos_x", "pos_y", "pos_z")
EXPECTED_POSITION = ("expected_pos_x", "expected_pos_y", "expected_pos_z")
NORMAL = ("expected_normal_x", "expected_normal_y", "expected_normal_z")
VECTOR_GROUPS = (POSITION, EXPECTED_POSITION, NORMAL)
NUMERIC_FIELDS = frozenset(POSITION + EXPECTED_POSITION + NORMAL)
PUBLIC_FIELDS = frozenset({
    "poi_name", "poi_names", "icon_url", "show_in_ar", "is_active",
    "amenities_desc", "highlight_desc", "technology_desc", "description",
    "descriptions", "category_type", "category_types", "floor_id",
    "matterport_tag_id", "approval_status", "translate_name",
}) | NUMERIC_FIELDS
JSON_FIELDS = frozenset({"poi_names", "descriptions", "extra", "category_types"})
TABLES = ("navme_pois", "pois", "navme_project_features")


class ReconcileError(Exception):
    """A safe diagnostic code, without raw records or connection details."""


def now():
    return datetime.now(timezone.utc).isoformat()


def loads(value):
    return json.loads(value, parse_float=Decimal)


def dumps(value):
    """Serialize Decimal as an exact JSON number, including nested JSONB values."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ReconcileError("nonfinite_json_number")
        return str(value)
    if value is None or isinstance(value, (str, bool, int, float)):
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    if isinstance(value, (datetime, uuid.UUID, Path)):
        return json.dumps(str(value), ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(dumps(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + dumps(value[key])
                               for key in sorted(value)) + "}"
    raise ReconcileError("unsupported_json_type")


def write_private(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(dumps(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def digest(rows):
    return hashlib.sha256(dumps(rows).encode()).hexdigest()


def normalise(row):
    result = deepcopy(row)
    for field in NUMERIC_FIELDS:
        if field in result and result[field] is not None:
            if isinstance(result[field], bool):
                raise ReconcileError("boolean_position")
            try:
                result[field] = Decimal(str(result[field]))
            except InvalidOperation:
                raise ReconcileError("invalid_position_number") from None
            if not result[field].is_finite():
                raise ReconcileError("nonfinite_position_number")
    return result


def is_public(field):
    return field in PUBLIC_FIELDS or field.startswith("poi_name_") or field.startswith("description_")


def vector(row, fields):
    return tuple(row.get(field) for field in fields)


def rounding_only(left, right):
    if any(a is None or b is None for a, b in zip(left, right)):
        return left == right
    return all(abs(a - b) <= ROUNDING_TOLERANCE for a, b in zip(left, right))


def index_scope(rows, expected=EXPECTED_POIS):
    if len(rows) != expected or any(row.get("poi_type") != POI_TYPE for row in rows):
        raise ReconcileError("unexpected_scope_or_count")
    result = {}
    for raw in rows:
        identity = str(raw.get("id") or "")
        try:
            uuid.UUID(identity)
        except ValueError:
            raise ReconcileError("invalid_source_identity") from None
        if identity in result:
            raise ReconcileError("duplicate_source_identity")
        result[identity] = normalise(raw)
    return result


def three_way(baseline, source, destination, fields):
    """Plan only source changes; never overwrite an independent destination edit."""
    patches, conflicts, ignored_rounding, already_applied = {}, [], [], []
    grouped = set()
    for group in VECTOR_GROUPS:
        if not set(group).issubset(fields):
            continue
        grouped.update(group)
        before, incoming, existing = vector(baseline, group), vector(source, group), vector(destination, group)
        if incoming == before:
            continue
        if rounding_only(before, incoming):
            ignored_rounding.append(list(group))
        elif existing == incoming:
            already_applied.append(list(group))
        elif existing == before:
            patches.update({field: source[field] for field in group if source[field] != destination[field]})
        else:
            conflicts.append(list(group))
    for field in sorted(set(fields) - grouped):
        if field not in baseline or field not in source or field not in destination:
            raise ReconcileError("incomplete_three_way_field")
        if source[field] == baseline[field]:
            continue
        if destination[field] == source[field]:
            already_applied.append([field])
        elif destination[field] == baseline[field]:
            patches[field] = deepcopy(source[field])
        else:
            conflicts.append([field])
    return {"patch": patches, "conflicts": conflicts, "ignored_rounding": ignored_rounding,
            "already_applied": already_applied}


def plan_pois(baseline_rows, source_rows, destination_rows, expected=EXPECTED_POIS):
    baseline = index_scope(baseline_rows, expected)
    source = index_scope(source_rows, expected)
    destination = index_scope(destination_rows, expected)
    if not baseline.keys() == source.keys() == destination.keys():
        raise ReconcileError("source_identity_sets_differ")
    patches, conflicts, rounding, guards, resulting = {}, [], [], {}, {}
    for identity in sorted(source):
        fields = {field for field in source[identity] if is_public(field)}
        row_plan = three_way(baseline[identity], source[identity], destination[identity], fields)
        if row_plan["patch"]:
            patches[identity] = row_plan["patch"]
        conflicts.extend({"id": identity, "fields": group} for group in row_plan["conflicts"])
        rounding.extend({"id": identity, "fields": group} for group in row_plan["ignored_rounding"])
        result = {**deepcopy(destination[identity]), **row_plan["patch"]}
        resulting[identity] = result
        calibration = {}
        for group, label in ((POSITION, "source_position"), (EXPECTED_POSITION, "source_expected_position")):
            old_vector, preserved_vector = vector(baseline[identity], group), vector(result, group)
            if all(value is not None for value in old_vector) and not rounding_only(old_vector, preserved_vector):
                calibration[label] = list(old_vector)
        if calibration:
            guards[identity] = calibration
    return {"patches": patches, "conflicts": conflicts, "ignored_rounding": rounding,
            "calibration_guards": guards, "resulting": resulting}


def plan_features(baseline, source, destination):
    if any(row.get("poi_type") != POI_TYPE for row in (baseline, source, destination)):
        raise ReconcileError("feature_scope_mismatch")
    if not baseline.get("id") == source.get("id") == destination.get("id"):
        raise ReconcileError("feature_identity_mismatch")
    return three_way(baseline, source, destination, FEATURE_FIELDS)


def plan_mirrors(resulting, mirror_rows, categories, floors, guards):
    mirrors = {}
    for row in mirror_rows:
        identity = (row.get("extra") or {}).get("gmap_src_id")
        if (not identity or identity in mirrors or row.get("building_id") != BUILDING_ID
                or row.get("source") != "supabase" or row.get("published") is not True):
            raise ReconcileError("invalid_or_duplicate_published_mirror")
        mirrors[identity] = row
    if mirrors.keys() != resulting.keys():
        raise ReconcileError("published_mirror_identity_set_mismatch")

    def lookup(rows):
        found = {}
        for row in rows:
            if row.get("poi_type") != POI_TYPE or row["id"] in found:
                raise ReconcileError("ambiguous_reference_row")
            found[row["id"]] = row
        return found

    cats, levels = lookup(categories), lookup(floors)
    patches = {}
    for identity, canonical in resulting.items():
        mirror = mirrors[identity]
        category_id, floor_id = canonical.get("category_type"), canonical.get("floor_id")
        if category_id is not None and category_id not in cats:
            raise ReconcileError("orphaned_category")
        if floor_id is not None and floor_id not in levels:
            raise ReconcileError("orphaned_floor")
        name = str(canonical.get("poi_name") or "").strip()
        if not name:
            raise ReconcileError("blank_canonical_name")
        projection = {
            "name": name,
            "category": str((cats.get(category_id) or {}).get("name") or "General").strip().lower(),
            "floor": str((levels.get(floor_id) or {}).get("name") or "F1"),
            "description": canonical.get("description"),
        }
        patch = {field: value for field, value in projection.items() if value != mirror.get(field)}
        if identity in guards:
            extra = deepcopy(mirror.get("extra") or {})
            previous = extra.get("studio_calibration") or {}
            if not isinstance(previous, dict):
                raise ReconcileError("malformed_existing_calibration")
            extra["studio_calibration"] = {**previous, **guards[identity]}
            if extra != mirror.get("extra"):
                patch["extra"] = extra
        if patch:
            patches[str(mirror["id"])] = patch
    return patches


def load_export(path):
    return [row for row in (loads(line) for line in path.read_text().splitlines() if line.strip())
            if row.get("poi_type") == POI_TYPE]


def load_snapshot(path, expected):
    document = loads(path.read_text())
    if document.get("source_project") != SOURCE_PROJECT or document.get("poi_type") != POI_TYPE:
        raise ReconcileError("snapshot_source_guard_failed")
    rows = document.get("rows")
    if not isinstance(rows, list) or len(rows) != expected:
        raise ReconcileError("snapshot_count_guard_failed")
    return rows, {"path": str(path), "captured_at": document.get("captured_at"),
                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def read_rows(connection, table, where="true", params=()):
    query = sql.SQL("SELECT to_jsonb(t)::text FROM public.{} t WHERE ").format(sql.Identifier(table)) + sql.SQL(where)
    return [loads(row[0]) for row in connection.execute(query, params)]


def table_digests(connection, tables):
    result = {}
    for table in tables:
        query = sql.SQL("SELECT count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM public.{} t").format(sql.Identifier(table))
        count, content = connection.execute(query).fetchone()
        result[table] = {"rows": count, "md5": content}
    return result


def apply_patch(connection, table, identity, patch, scoped=False):
    if not patch:
        return
    assignments = sql.SQL(", ").join(sql.SQL("{} = patch.{}").format(sql.Identifier(field), sql.Identifier(field))
                                    for field in sorted(patch))
    query = sql.SQL("WITH patch AS (SELECT * FROM jsonb_populate_record(NULL::public.{}, %s::jsonb)) UPDATE public.{} target SET {} FROM patch WHERE target.id = %s").format(
        sql.Identifier(table), sql.Identifier(table), assignments)
    values = [Jsonb(patch, dumps=dumps), identity]
    if scoped:
        query += sql.SQL(" AND target.poi_type = %s")
        values.append(POI_TYPE)
    if table == "pois":
        query += sql.SQL(" AND target.building_id = 3 AND target.source = 'supabase' AND target.published")
    count = connection.execute(query, values).rowcount
    if count != 1:
        raise ReconcileError("target_patch_rowcount_mismatch")


def verify_exact_changes(before, after, patches, identity="id"):
    wanted = {str(row[identity]): deepcopy(row) for row in before}
    for key, patch in patches.items():
        wanted[key].update(patch)
    actual = {str(row[identity]): row for row in after}
    if len(after) != len(wanted) or actual != wanted:
        raise ReconcileError("unexpected_target_row_change")


UNRELATED_QUERY = """
SELECT 'navme_pois'::text AS relation_name,to_jsonb(p) AS row_data
 FROM public.navme_pois p WHERE poi_type IS DISTINCT FROM 'Uncc_Navme'
UNION ALL
SELECT 'pois',to_jsonb(p) FROM public.pois p
 WHERE NOT (building_id=3 AND source='supabase' AND published)
UNION ALL
SELECT 'navme_project_features',to_jsonb(p) FROM public.navme_project_features p
 WHERE poi_type IS DISTINCT FROM 'Uncc_Navme'
"""


def reconcile(args):
    baseline = load_export(args.baseline)
    feature_baseline_rows = load_export(args.feature_baseline)
    if len(feature_baseline_rows) != 1:
        raise ReconcileError("feature_baseline_count_mismatch")
    source, source_input = load_snapshot(args.source, EXPECTED_POIS)
    source_features, feature_input = load_snapshot(args.source_features, 1)
    target = validate_target(dotenv_values(args.secret_file, interpolate=False).get("SUPABASE_DATABASE_URL", ""))
    output = args.output or WORK / "runs" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ("-apply" if args.apply else "-dry-run"))
    output.mkdir(parents=True, mode=0o700)
    output.chmod(0o700)
    report = {"status": "preparing", "source_project": SOURCE_PROJECT, "destination_project": DESTINATION_PROJECT,
              "building_slug": BUILDING_SLUG, "poi_type": POI_TYPE, "started_at": now(),
              "source_inputs": [source_input, feature_input], "apply_requested": args.apply,
              "source_database_writes": False}
    write_private(output / "inputs.json", report)
    connect = dict(host=target.host, port=target.port or 5432, user=target.username,
                   password=target.password, dbname=target.database,
                   sslmode=target.query.get("sslmode", "require"), connect_timeout=15,
                   application_name="navme-uncc-studio-reconcile", autocommit=True, prepare_threshold=None)
    for option in ("sslrootcert", "sslcert", "sslkey"):
        if target.query.get(option):
            connect[option] = target.query[option]
    try:
        with isolated_libpq_environment(), psycopg.connect(**connect) as connection:
            if not connection.pgconn.ssl_in_use:
                raise ReconcileError("client_tls_not_established")
            connection.execute("BEGIN")
            try:
                connection.execute("SET LOCAL lock_timeout='15s'")
                connection.execute("SET LOCAL statement_timeout='120s'")
                connection.execute("SET LOCAL TIME ZONE 'UTC'")
                connection.execute("SET LOCAL extra_float_digits=3")
                connection.execute("LOCK TABLE public.navme_pois,public.pois,public.navme_project_features IN SHARE ROW EXCLUSIVE MODE")
                connection.execute("LOCK TABLE public.buildings,public.map_versions,public.navme_categories,public.navme_floors,public.navme_gmap_pois,public.navme_gmap_buildings IN SHARE MODE")
                building = read_rows(connection, "buildings", "id=3")
                if (len(building) != 1 or building[0].get("slug") != BUILDING_SLUG
                        or building[0].get("matterport_model_id") != "kQBN52JqFE9"
                        or (building[0].get("pipeline_config") or {}).get("navme_poi_type") != POI_TYPE):
                    raise ReconcileError("building_identity_guard_failed")
                versions = read_rows(connection, "map_versions", "building_id=3 AND is_current")
                if len(versions) != 1 or versions[0].get("version") != 2:
                    raise ReconcileError("publication_guard_failed")
                canonical = read_rows(connection, "navme_pois", "poi_type=%s", (POI_TYPE,))
                mirrors = read_rows(connection, "pois", "building_id=3 AND source='supabase' AND published")
                feature_rows = read_rows(connection, "navme_project_features", "poi_type=%s", (POI_TYPE,))
                if len(feature_rows) != 1:
                    raise ReconcileError("feature_target_count_mismatch")
                feature = feature_rows[0]
                if feature.get("navme_gmap_enabled") is not False:
                    raise ReconcileError("gmap_sync_noop_guard_failed")
                triggers = connection.execute("""SELECT c.relname,t.tgname,t.tgenabled,md5(pg_get_functiondef(t.tgfoid))
                    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname IN ('navme_pois','pois','navme_project_features')
                    AND NOT t.tgisinternal ORDER BY c.relname,t.tgname""").fetchall()
                if triggers != [("navme_pois", "trg_navme_pois_gmap_sync", "O", TRIGGER_DIGEST)]:
                    raise ReconcileError("unexpected_user_trigger_or_function_definition")
                before_global = table_digests(connection, TABLES)
                protected_before = table_digests(connection, ("buildings", "map_versions", "navme_gmap_pois", "navme_gmap_buildings"))
                write_private(output / "destination-backup.json", {
                    "captured_at": now(), "project": DESTINATION_PROJECT,
                    "navme_pois": canonical, "pois": mirrors, "navme_project_features": feature_rows,
                    "content_digests": before_global, "protected_digests": protected_before,
                    "affected_rows_sha256": {"navme_pois": digest(canonical), "pois": digest(mirrors),
                                             "navme_project_features": digest(feature_rows)}})
                connection.execute("CREATE TEMP TABLE uncc_studio_unrelated_before ON COMMIT DROP AS " + UNRELATED_QUERY)
                plan = plan_pois(baseline, source, canonical)
                feature_plan = plan_features(feature_baseline_rows[0], source_features[0], feature)
                categories = read_rows(connection, "navme_categories", "poi_type=%s", (POI_TYPE,))
                floors = read_rows(connection, "navme_floors", "poi_type=%s", (POI_TYPE,))
                mirror_patches = plan_mirrors(plan["resulting"], mirrors, categories, floors, plan["calibration_guards"])
                conflicts = plan["conflicts"] + [{"id": feature["id"], "table": "navme_project_features", "fields": fields}
                                                for fields in feature_plan["conflicts"]]
                field_counts = Counter(field for patch in plan["patches"].values() for field in patch)
                report.update(status="planned", canonical_rows_changed=len(plan["patches"]),
                              canonical_field_counts=dict(field_counts), mirror_rows_changed=len(mirror_patches),
                              mirror_field_counts=dict(Counter(field for patch in mirror_patches.values() for field in patch)),
                              feature_fields_changed=sorted(feature_plan["patch"]),
                              calibration_rows=len(plan["calibration_guards"]),
                              calibration_field_counts=dict(Counter(field for guard in plan["calibration_guards"].values() for field in guard)),
                              ignored_rounding=plan["ignored_rounding"], conflicts=conflicts,
                              trigger_state_unchanged=True, gmap_sync_verified_noop=True)
                write_private(output / "plan.json", {"report": report, "canonical_patches": plan["patches"],
                                                      "mirror_patches": mirror_patches, "feature_patch": feature_plan["patch"]})
                if conflicts:
                    raise ReconcileError("three_way_conflicts_require_review")
                for identity, patch in plan["patches"].items():
                    apply_patch(connection, "navme_pois", identity, patch, scoped=True)
                for identity, patch in mirror_patches.items():
                    apply_patch(connection, "pois", int(identity), patch)
                apply_patch(connection, "navme_project_features", feature["id"], feature_plan["patch"], scoped=True)
                after_canonical = read_rows(connection, "navme_pois", "poi_type=%s", (POI_TYPE,))
                after_mirrors = read_rows(connection, "pois", "building_id=3 AND source='supabase' AND published")
                after_feature = read_rows(connection, "navme_project_features", "poi_type=%s", (POI_TYPE,))
                verify_exact_changes(canonical, after_canonical, plan["patches"])
                verify_exact_changes(mirrors, after_mirrors, mirror_patches)
                verify_exact_changes(feature_rows, after_feature, {feature["id"]: feature_plan["patch"]})
                unrelated_changed = connection.execute("WITH current_rows AS (" + UNRELATED_QUERY + ") SELECT EXISTS ((SELECT * FROM uncc_studio_unrelated_before EXCEPT ALL SELECT * FROM current_rows) UNION ALL (SELECT * FROM current_rows EXCEPT ALL SELECT * FROM uncc_studio_unrelated_before))").fetchone()[0]
                if unrelated_changed:
                    raise ReconcileError("unrelated_destination_rows_changed")
                if table_digests(connection, tuple(protected_before)) != protected_before:
                    raise ReconcileError("protected_building_publication_or_gmap_rows_changed")
                after_global = table_digests(connection, TABLES)
                report.update(verification_passed=True, unrelated_rows_preserved=True,
                              protected_digests_unchanged=True, before_digests=before_global, after_digests=after_global)
                write_private(output / "verified-before-decision.json", report)
                connection.execute("COMMIT" if args.apply else "ROLLBACK")
                report["status"] = "applied" if args.apply else "dry_run_rolled_back"
                if not args.apply and table_digests(connection, TABLES) != before_global:
                    raise ReconcileError("rollback_preservation_check_failed")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
    except Exception as error:
        report.update(status="failed", reason=str(error) if isinstance(error, ReconcileError) else type(error).__name__)
    report["completed_at"] = now()
    write_private(output / "report.json", report)
    return report, output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=COPY / "source/navme_pois.ndjson")
    parser.add_argument("--feature-baseline", type=Path, default=COPY / "source/navme_project_features.ndjson")
    parser.add_argument("--source", type=Path, default=WORK / "current-navme-pois.json")
    parser.add_argument("--source-features", type=Path, default=WORK / "current-project-features.json")
    parser.add_argument("--secret-file", type=Path, default=ROOT / "dashboard/.env.production-migration")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--apply", action="store_true", help="Commit the verified transaction; default rolls back")
    args = parser.parse_args()
    try:
        report, output = reconcile(args)
        print(json.dumps({"status": report["status"], "canonical_rows_changed": report.get("canonical_rows_changed"),
                          "mirror_rows_changed": report.get("mirror_rows_changed"),
                          "feature_fields_changed": report.get("feature_fields_changed"),
                          "calibration_rows": report.get("calibration_rows"),
                          "conflict_count": len(report.get("conflicts", [])),
                          "reason": report.get("reason"), "private_report": str(output / "report.json")}))
        return 0 if report["status"] in {"applied", "dry_run_rolled_back"} else 1
    except Exception as error:
        print(json.dumps({"status": "failed", "reason": str(error) if isinstance(error, ReconcileError) else type(error).__name__}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
