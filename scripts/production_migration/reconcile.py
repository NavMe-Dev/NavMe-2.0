#!/usr/bin/env python3
"""Offline, fail-closed identity comparison. Never executes SQL or changes records.

Input: {"tables": {"public.buildings": {"rows": [...]}}}. A separate reviewed
policy names business-key and primary-key columns for each table. The result
contains digests, never raw user records. Insertion candidates remain blocked
until foreign keys, sequence allocation, security, and provenance are reviewed.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def key_for(row: dict, columns: list[str]) -> tuple | None:
    values = tuple(row.get(column) for column in columns)
    if not columns or any(value is None for value in values):
        return None
    return values


def compare(source: dict, destination: dict, policies: dict) -> dict:
    report = {"executable": False, "production_approved": False, "proposed_updates": 0,
              "proposed_deletions": 0, "tables": {}}
    for table in sorted(source.get("tables", {}).keys() | destination.get("tables", {}).keys()):
        src = source.get("tables", {}).get(table, {}).get("rows", [])
        dst = destination.get("tables", {}).get(table, {}).get("rows", [])
        table_report = {"source_count": len(src), "destination_count": len(dst),
                        "records": [], "counts": {}}
        report["tables"][table] = table_report
        policy = policies.get(table)
        if table not in source.get("tables", {}):
            table_report["category"] = "destination-only"
            table_report["counts"] = {"preserve_destination": len(dst)}
            continue
        if not policy or policy.get("protected", False):
            table_report["category"] = "unsafe to merge automatically"
            table_report["counts"] = {"unreviewed_identity_or_protected": len(src),
                                      "preserve_destination": len(dst)}
            continue
        identity = policy.get("identity", [])
        primary_key = policy.get("primary_key", [])
        dst_keys = Counter(key_for(row, identity) for row in dst)
        src_keys = Counter(key_for(row, identity) for row in src)
        dst_by_key = {key_for(row, identity): row for row in dst}
        dst_pks = {key_for(row, primary_key) for row in dst}
        matched_keys = set()
        for row in src:
            key = key_for(row, identity)
            pk = key_for(row, primary_key)
            outcome = "insertion_candidate_requires_relationship_review"
            if key is None:
                outcome = "missing_business_identity"
            elif src_keys[key] > 1 or dst_keys[key] > 1:
                outcome = "duplicate_business_identity"
            elif key in dst_by_key:
                matched_keys.add(key)
                # Compare every non-PK field. No last-write-wins policy exists.
                src_content = {k: v for k, v in row.items() if k not in primary_key}
                dst_content = {k: v for k, v in dst_by_key[key].items() if k not in primary_key}
                outcome = "matching_preserve_destination" if src_content == dst_content else "conflict_preserve_destination"
            elif not primary_key or pk is None:
                outcome = "missing_primary_key_policy"
            elif pk in dst_pks:
                outcome = "primary_key_collision_requires_remapping"
            table_report["records"].append({"source_digest": fingerprint(row),
                                               "identity_digest": fingerprint(key),
                                               "outcome": outcome})
        counts = Counter(record["outcome"] for record in table_report["records"])
        counts["preserve_destination"] = len(dst)
        counts["destination_only"] = sum(key_for(row, identity) not in matched_keys for row in dst)
        table_report["counts"] = dict(counts)
        table_report["category"] = "requires manual conflict resolution" if any(
            "conflict" in record["outcome"] or "collision" in record["outcome"] or "duplicate" in record["outcome"]
            for record in table_report["records"]
        ) else "identity comparison only; relationship review required"
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "destination", "policy", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text())
    result = compare(read(args.source), read(args.destination), read(args.policy))
    # Exclusive creation prevents accidentally replacing prior review evidence.
    import os
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
