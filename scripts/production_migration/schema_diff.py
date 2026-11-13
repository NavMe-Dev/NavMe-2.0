#!/usr/bin/env python3
"""Compare read-only catalog exports without connecting to either database.

Consumes the audit.py source inventory plus PostgreSQL catalog queries and the
equivalent Supabase MCP destination exports. Outputs metadata, never row data.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path


def compare(source_inventory: dict, source_catalog: dict, destination_tables: list,
            destination_columns: list, destination_catalog: dict,
            destination_counts: list | None = None) -> dict:
    destination_by_name = {t["name"]: t for t in destination_tables}
    exact_counts = {t["table_name"]: t["rows"] for t in destination_counts or []}
    source_tables = source_inventory["tables"]
    tables = {}
    source_rls = {f"{r['schema']}.{r['table']}": r for r in source_inventory["rls"]}
    for qualified in sorted(source_tables.keys() | destination_by_name.keys()):
        if qualified not in source_tables:
            tables[qualified] = {"category": "destination-only", "action": "preserve unchanged",
                                 "destination_row_count": exact_counts.get(qualified)}
            continue
        if qualified not in destination_by_name:
            tables[qualified] = {"category": "missing from destination", "action": "review; no automatic schema creation"}
            continue
        schema, table = qualified.split(".", 1)
        def entries(rows):
            return [r for r in rows if r.get("schema") == schema and r.get("table") == table]
        source_columns = {r["column"]: r for r in entries(source_catalog["columns"])}
        target_columns = {r["column"]: r for r in entries(destination_columns)}
        if not source_columns or not target_columns:
            raise ValueError(f"Incomplete column metadata for {qualified}; compatibility cannot be established")
        changed = []
        for column in sorted(source_columns.keys() & target_columns.keys()):
            fields = {key: {"source": source_columns[column].get(key),
                            "destination": target_columns[column].get(key)}
                      for key in ("type", "not_null", "default_expr")
                      if source_columns[column].get(key) != target_columns[column].get(key)}
            if fields:
                changed.append({"column": column, "differences": fields})
        # PostgreSQL 18 adds NOT NULL catalog constraints (contype='n'). The
        # semantic constraint is already compared through attnotnull above;
        # PostgreSQL 17 omits these pg_constraint entries entirely.
        source_constraints = {(r["type"], r["definition"]) for r in entries(source_catalog["constraints"])
                              if r["type"] != "n"}
        target_constraints = {(r["type"], r["definition"]) for r in entries(destination_catalog["constraints"])
                              if r["type"] != "n"}
        def index_definitions(catalog):
            return {r["indexdef"] for r in catalog["indexes"]
                    if r["schemaname"] == schema and r["tablename"] == table}
        source_indexes = index_definitions(source_catalog)
        target_indexes = index_definitions(destination_catalog)
        differences = {
            "source_only_columns": sorted(source_columns.keys() - target_columns.keys()),
            "destination_only_columns": sorted(target_columns.keys() - source_columns.keys()),
            "changed_columns": changed,
            "source_only_constraints": sorted(source_constraints - target_constraints),
            "destination_only_constraints": sorted(target_constraints - source_constraints),
            "source_only_indexes": sorted(source_indexes - target_indexes),
            "destination_only_indexes": sorted(target_indexes - source_indexes),
        }
        structural_changes = any(differences.values())
        source_security = source_rls.get(qualified, {}).get("enabled")
        target_security = destination_by_name[qualified].get("rls_enabled")
        tables[qualified] = {
            "category": "existing with schema differences" if structural_changes else "existing and structurally compatible",
            "source_row_count": source_tables[qualified]["row_count"],
            "destination_estimated_rows": destination_by_name[qualified].get("rows"),
            "destination_row_count": exact_counts.get(qualified),
            "differences": differences,
            "rls": {"source": source_security, "destination": target_security,
                    "action": "preserve destination; security changes require separate approval"},
            "action": "extension-managed; do not merge records" if table == "spatial_ref_sys" else "identity and relationship reconciliation required",
        }
    return {"production_apply_approved": False, "tables": tables,
            "source_extensions": source_inventory.get("extensions", []),
            "limitations": [
                "Source is local PostgreSQL 18.6, not an authenticated Render production export.",
                "Destination row estimates are not exact baselines; use the independently captured count report.",
                "Structural compatibility does not approve data transfer, RLS changes, or application cutover.",
                "PostgreSQL 18 NOT NULL catalog rows are normalized through the exact column attnotnull comparison.",
                "Extension function/version, role grant, trigger and policy differences require separate review.",
            ]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("source-inventory", "source-catalog", "destination-tables",
                "destination-columns", "destination-catalog", "output"):
        parser.add_argument("--" + arg, required=True, type=Path)
    parser.add_argument("--destination-counts", type=Path)
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text())
    result = compare(read(args.source_inventory), read(args.source_catalog),
                     read(args.destination_tables), read(args.destination_columns),
                     read(args.destination_catalog),
                     read(args.destination_counts) if args.destination_counts else None)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
