#!/usr/bin/env python3
"""Export the reviewed znfw public tables read-only, with private local output.

This reads source rows through PostgREST using the existing source anon key.
An export is usable only when its exact REST count, local count, and reviewed
administrator inventory agree. RLS-filtered exports and live drift are reported
as incomplete; this script never changes a database or accepts incomplete data.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time

from dotenv import dotenv_values
import requests


SOURCE_PROJECT = "znfwcohrpkiccibqcfpn"
DESTINATION_PROJECT = "kzpvhzyefdtrtidrbuxb"
SOURCE_URL = f"https://{SOURCE_PROJECT}.supabase.co"
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "platform/var/data/production_migration/2026-11-16-znfw-sync/config.json"
IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
CONTENT_RANGE = re.compile(r"^(?:(\d+)-(\d+)|\*)/(\d+|\*)$")
RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}
PAGE_SIZE = 1000


class ExportError(Exception):
    """A safe diagnostic code that contains no response bodies or row data."""


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def private_open(path: Path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8")


def write_private_json(path: Path, value):
    with private_open(path) as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def read_config(path: Path):
    config = json.loads(path.read_text())
    if config.get("source_project") != SOURCE_PROJECT or config.get("destination_project") != DESTINATION_PROJECT:
        raise ExportError("unexpected_project_in_config")
    tables = config.get("tables")
    if not isinstance(tables, list) or len(tables) != 50:
        raise ExportError("expected_exactly_50_reviewed_tables")
    names = set()
    for table in tables:
        name = table.get("name", "")
        if not IDENTIFIER.fullmatch(name) or name in names:
            raise ExportError("invalid_or_duplicate_table_name")
        names.add(name)
        columns = {column["column_name"] for column in table["columns"]}
        keys = table.get("primary_keys", [])
        if not keys:
            if name != "navme_navnode_backup_2026_09_25" or "id" not in columns:
                raise ExportError("unreviewed_table_without_primary_key")
            keys = ["id"]
        if any(not IDENTIFIER.fullmatch(key) or key not in columns for key in keys):
            raise ExportError("invalid_order_key")
        inventory = table.get("source_inventory", {})
        expected = inventory.get("row_count")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ExportError("invalid_source_inventory_count")
        if table.get("primary_keys") and inventory.get("distinct_keys") != expected:
            raise ExportError("source_inventory_keys_not_unique")
    return config


def source_credentials(secret_file: Path):
    env = dotenv_values(secret_file, interpolate=False)
    # Exact URL comparison also excludes alternate hosts, paths and redirects.
    if env.get("VITE_SUPABASE_URL", "").rstrip("/") != SOURCE_URL:
        raise ExportError("source_url_guard_failed")
    key = env.get("VITE_SUPABASE_ANON_KEY")
    if not isinstance(key, str) or not key.strip():
        raise ExportError("source_anon_key_missing")
    return key


def request(session, name, params, *, method="GET", count=False):
    headers = {"Accept-Profile": "public"}
    if count:
        headers["Prefer"] = "count=exact"
    for attempt in range(4):
        try:
            response = session.request(method, f"{SOURCE_URL}/rest/v1/{name}", params=params,
                                       headers=headers, timeout=(15, 60), allow_redirects=False)
        except (requests.Timeout, requests.ConnectionError):
            if attempt == 3:
                raise ExportError("network_retries_exhausted") from None
            time.sleep(2 ** attempt)
            continue
        except requests.RequestException:
            raise ExportError("request_failed") from None
        if response.status_code in RETRY_STATUSES and attempt < 3:
            retry_after = response.headers.get("Retry-After", "")
            delay = min(10, int(retry_after)) if retry_after.isdigit() else 2 ** attempt
            response.close()
            time.sleep(delay)
            continue
        if response.status_code not in {200, 206}:
            status = response.status_code
            response.close()
            raise ExportError(f"http_{status}")
        return response
    raise ExportError("request_retries_exhausted")


def range_metadata(response):
    match = CONTENT_RANGE.fullmatch(response.headers.get("Content-Range", ""))
    if not match:
        raise ExportError("missing_or_invalid_content_range")
    start, end, total = match.groups()
    return (int(start) if start is not None else None,
            int(end) if end is not None else None,
            int(total) if total != "*" else None)


def raw_rows(body):
    """Yield validated objects and their original JSON to retain numeric precision."""
    decoder = json.JSONDecoder()
    position = 0
    length = len(body)

    def skip_space(index):
        while index < length and body[index].isspace():
            index += 1
        return index

    position = skip_space(position)
    if position >= length or body[position] != "[":
        raise ExportError("response_is_not_an_array")
    position = skip_space(position + 1)
    if position < length and body[position] == "]":
        if skip_space(position + 1) != length:
            raise ExportError("trailing_response_content")
        return
    while position < length:
        start = position
        try:
            row, position = decoder.raw_decode(body, position)
        except (ValueError, RecursionError):
            raise ExportError("invalid_row_json") from None
        if not isinstance(row, dict):
            raise ExportError("response_row_is_not_an_object")
        # Literal line breaks are only legal as whitespace outside JSON strings.
        raw = body[start:position].replace("\r", " ").replace("\n", " ")
        yield row, raw
        position = skip_space(position)
        if position >= length:
            break
        if body[position] == "]":
            if skip_space(position + 1) != length:
                raise ExportError("trailing_response_content")
            return
        if body[position] != ",":
            raise ExportError("invalid_row_separator")
        position = skip_space(position + 1)
    raise ExportError("unterminated_response_array")


def export_table(table, output: Path, key: str):
    name = table["name"]
    expected = table["source_inventory"]["row_count"]
    keys = table.get("primary_keys") or ["id"]
    columns = {column["column_name"] for column in table["columns"]}
    partial = output / f"{name}.ndjson.partial"
    result = {"table": name, "status": "incomplete", "expected_inventory_count": expected,
              "rest_count": None, "exported_count": 0, "order_columns": keys,
              "order_key_is_declared_primary_key": bool(table.get("primary_keys")),
              "started_at": timestamp()}
    seen = set()
    digest = hashlib.sha256()
    session = requests.Session()
    session.headers.update({"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with private_open(partial) as stream:
            offset = 0
            total = None
            while True:
                response = request(session, name, {"select": "*", "order": ",".join(f"{col}.asc" for col in keys),
                                                  "offset": offset, "limit": PAGE_SIZE}, count=offset == 0)
                try:
                    start, end, page_total = range_metadata(response)
                    if offset == 0:
                        if page_total is None:
                            raise ExportError("exact_rest_count_missing")
                        total = page_total
                        result["rest_count"] = total
                    elif page_total is not None and page_total != total:
                        raise ExportError("live_count_drift_during_export")
                    rows = list(raw_rows(response.text))
                finally:
                    response.close()
                if rows:
                    if start != offset or end != offset + len(rows) - 1:
                        raise ExportError("page_range_does_not_match_rows")
                elif offset < total:
                    raise ExportError("empty_page_before_total")
                for row, raw in rows:
                    if set(row) != columns:
                        raise ExportError("row_columns_differ_from_inventory")
                    identity = tuple(row.get(col) for col in keys)
                    if any(value is None for value in identity):
                        raise ExportError("null_order_key")
                    try:
                        duplicate = identity in seen
                        seen.add(identity)
                    except TypeError:
                        raise ExportError("invalid_order_key_value") from None
                    if duplicate:
                        raise ExportError("duplicate_order_key_or_pagination_drift")
                    line = raw + "\n"
                    stream.write(line)
                    digest.update(line.encode("utf-8"))
                    result["exported_count"] += 1
                offset += len(rows)
                if offset >= total:
                    if offset != total:
                        raise ExportError("export_exceeds_exact_rest_count")
                    break
            stream.flush()
            os.fsync(stream.fileno())
        response = request(session, name, {"select": keys[0]}, method="HEAD", count=True)
        try:
            _, _, final_total = range_metadata(response)
        finally:
            response.close()
        result["final_rest_count"] = final_total
        if final_total != total:
            raise ExportError("live_count_drift_after_export")
        if total != expected:
            result["status"] = "inaccessible_or_inventory_drift"
            result["reason"] = "rest_count_does_not_match_administrator_inventory"
        else:
            target = output / f"{name}.ndjson"
            if target.exists():
                raise ExportError("output_file_already_exists")
            partial.rename(target)
            result.update(status="complete", file=target.name, sha256=digest.hexdigest(),
                          verified_unique_keys=len(seen))
    except ExportError as error:
        result["reason"] = str(error)
    except Exception as error:
        # Exception messages may include URLs or row values; retain only type.
        result["reason"] = f"unexpected_{type(error).__name__}"
    finally:
        session.close()
    result["completed_at"] = timestamp()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--secret-file", type=Path, default=ROOT / "dashboard/.env.production")
    args = parser.parse_args()
    try:
        config = read_config(args.config)
        key = source_credentials(args.secret_file)
        output = args.config.resolve().parent / "source"
        # Refuse reuse so a failed run cannot silently replace earlier evidence.
        output.mkdir(mode=0o700)
        output.chmod(0o700)
    except ExportError as error:
        print(json.dumps({"status": "failed", "reason": str(error)}), flush=True)
        return 2
    except Exception as error:
        print(json.dumps({"status": "failed", "reason": type(error).__name__}), flush=True)
        return 2
    manifest = {"source_project": SOURCE_PROJECT, "destination_project": DESTINATION_PROJECT,
                "source_url": SOURCE_URL, "source_access": "existing_anon_key_via_read_only_rest",
                "database_writes": False, "transactionally_consistent_snapshot": False,
                "started_at": timestamp(), "tables": []}
    results = {}
    with ThreadPoolExecutor(max_workers=4) as workers:
        tasks = {workers.submit(export_table, table, output, key): table["name"] for table in config["tables"]}
        for task in as_completed(tasks):
            result = task.result()
            results[result["table"]] = result
            print(json.dumps({field: result.get(field) for field in
                              ("table", "status", "expected_inventory_count", "rest_count", "exported_count", "reason")}), flush=True)
    manifest["tables"] = [results[table["name"]] for table in config["tables"]]
    complete = sum(table["status"] == "complete" for table in manifest["tables"])
    manifest.update(completed_at=timestamp(), complete_tables=complete, incomplete_tables=50 - complete,
                    status="complete" if complete == 50 else "incomplete")
    write_private_json(output / "manifest.json", manifest)
    print(json.dumps({"status": manifest["status"], "complete_tables": complete,
                      "incomplete_tables": 50 - complete}), flush=True)
    return 0 if complete == 50 else 1


if __name__ == "__main__":
    raise SystemExit(main())
