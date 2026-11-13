#!/usr/bin/env python3
"""Verify post-candidate data, full-precision floats and exact archive sequences.

Only the named network-disabled local recovery container is queried. No nextval,
setval, DML, restore, network credential or production connection is used.
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
from verify_vm_restore import identifier, literal, snapshot_query


def parse_sequence_sets(data: str, expected_count: int) -> dict:
    pattern = r"SELECT pg_catalog\.setval\('([A-Za-z_0-9]+\.[A-Za-z_0-9]+)',\s*(-?\d+),\s*(true|false)\);"
    values = {name: {"last_value": int(number), "is_called": called == "true"}
              for name, number, called in re.findall(pattern, data)}
    if not expected_count or len(values) != expected_count:
        raise ValueError("Every archive sequence state must be parsed unambiguously")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("lima-bin", "lima-home", "backup", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Use new verification output")
    args.output.mkdir(mode=0o700)
    source = json.loads((args.backup / "snapshot-inventory.json").read_text())
    settings = json.loads((args.backup / "source-serialization-settings.json").read_text())
    precision = json.loads((args.backup / "source-full-precision-check.json").read_text())
    manifest = json.loads((args.backup / "capture-manifest.json").read_text())
    for name, entry in manifest["files"].items():
        if hashlib.sha256((args.backup / name).read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("Original capture checksum mismatch")
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["LIMA_HOME"] = str(args.lima_home)
    prefix = [str(args.lima_bin), "shell", "navme-recovery", "sudo", "nerdctl"]
    container = "navme-recovery-db-v4"
    inspected = subprocess.run(prefix + ["inspect", container], env=env, capture_output=True, check=True)
    if json.loads(inspected.stdout)[0].get("HostConfig", {}).get("NetworkMode") != "none":
        raise ValueError("Recovery container must have no network")
    def run(command, data, label):
        result = subprocess.run(prefix + ["exec", "--user=root", "-i", container] + command,
                                input=data.encode(), env=env, capture_output=True, timeout=180)
        fd = os.open(args.output / (label + ".stderr"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as errors:
            errors.write(result.stderr)
        if result.returncode:
            raise RuntimeError("Private isolated verification command failed")
        return result.stdout.decode()
    def query(data, label):
        result = json.loads(run(["psql", "-h", "/var/run/postgresql", "-U", "supabase_admin",
                                 "-d", "navme_destination_restore_test", "-At", "--quiet",
                                 "--set=ON_ERROR_STOP=1"], data, label))
        secure_json(args.output / (label + ".json"), result)
        return result
    restored = query(snapshot_query(source, settings), "post-candidate-snapshot")
    changed = [name for name in source["tables"] if source["tables"][name] != restored["tables"].get(name)]
    precise_settings = {**settings, "extra_float_digits": str(precision["extra_float_digits"])}
    precise = query(snapshot_query({"tables": precision["tables"]}, precise_settings), "full-precision-snapshot")
    precise_changed = [name for name in precision["tables"] if precision["tables"][name] != precise["tables"].get(name)]
    original_list = (args.backup / "archive.list").read_text().splitlines(True)
    sequence_entries = [line for line in original_list if not line.startswith(";") and " SEQUENCE SET " in line]
    sequence_list = "".join(line if line.startswith(";") or " SEQUENCE SET " in line else "; " + line for line in original_list)
    sequence_sql = run(["pg_restore", "--data-only", "--use-list=/dev/stdin", "--file=-", "/backup/destination.dump"],
                       sequence_list, "archive-sequence-extract")
    expected_sequences = parse_sequence_sets(sequence_sql, len(sequence_entries))
    statements = []
    for name in expected_sequences:
        schema, sequence = name.split(".")
        statements.append("SELECT " + literal(name) + " AS name,last_value,is_called FROM " + identifier(schema) + "." + identifier(sequence))
    sequence_data = query("BEGIN READ ONLY; SELECT jsonb_object_agg(name,jsonb_build_object('last_value',last_value,'is_called',is_called)) FROM ("
                          + " UNION ALL ".join(statements) + ") AS states; ROLLBACK;", "restored-sequences")
    different_sequences = [name for name in expected_sequences if expected_sequences[name] != sequence_data.get(name)]
    secure_json(args.output / "expected-archive-sequences.json", expected_sequences)
    owned = query("""BEGIN READ ONLY;
SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]'::jsonb) FROM (
 SELECT n.nspname||'.'||s.relname AS name,q.seqincrement AS increment,q.seqcycle AS cycle,
  tn.nspname AS table_schema,t.relname AS table_name,a.attname AS column_name
 FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace
 JOIN pg_sequence q ON q.seqrelid=s.oid
 JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass
  AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') AND d.refobjsubid>0
 JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
 JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
 WHERE s.relkind='S' AND n.nspname NOT LIKE 'pg_%')x;
ROLLBACK;""", "sequence-owned-columns")
    allocation_queries = []
    for row in owned:
        if row["name"] not in expected_sequences:
            raise ValueError("Unexpected sequence appeared in the recovery clone")
        function = "max" if row["increment"] > 0 else "min"
        relation = identifier(row["table_schema"]) + "." + identifier(row["table_name"])
        allocation_queries.append("SELECT " + literal(row["name"]) + " AS name," + function + "(" +
                                  identifier(row["column_name"]) + ")::numeric AS allocated_extreme FROM " + relation)
    allocation = query("BEGIN READ ONLY; SELECT jsonb_object_agg(name,allocated_extreme) FROM (" +
                       " UNION ALL ".join(allocation_queries) + ")x; ROLLBACK;", "sequence-allocation-baseline")
    unsafe = []
    for row in owned:
        state = sequence_data[row["name"]]
        next_value = state["last_value"] + row["increment"] if state["is_called"] else state["last_value"]
        extreme = allocation[row["name"]]
        if row["cycle"] or (extreme is not None and ((row["increment"] > 0 and next_value <= extreme) or
                                                     (row["increment"] < 0 and next_value >= extreme))):
            unsafe.append(row["name"])
    unowned = sorted(set(expected_sequences) - {row["name"] for row in owned})
    report = {"post_candidate_all_frozen_rows_unchanged": not changed, "table_count": len(source["tables"]),
              "changed_tables": changed, "full_precision_current_source_tables_match": not precise_changed,
              "full_precision_table_count": len(precision["tables"]), "precision_mismatches": precise_changed,
              "precision_comparison_scope": "Fresh read-only current source sidecar, not initial archive snapshot",
              "exact_archive_sequence_states_match": not different_sequences,
              "sequence_count": len(expected_sequences), "different_sequences": different_sequences,
              "owned_sequence_allocation_checks_pass": not unsafe,
              "owned_sequence_allocation_count": len(owned), "unsafe_next_allocations": unsafe,
              "unowned_sequences_requiring_separate_allocation_policy": unowned,
              "original_capture_checksums_unchanged": True, "production_writes": False}
    secure_json(args.output / "additional-verification-report.json", report)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
