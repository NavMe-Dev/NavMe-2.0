"""Durable backing store for published building bundles (mesh GLBs, floor plans,
navmesh, POIs — the frozen output of publish()/import-bundle, served by public.py).

Render's free web service plan has no persistent disk: every file written to
local disk is wiped on container restart, which happens on every deploy *and*
automatically after ~15 minutes of idle traffic, even with no deploy at all. The
Postgres DB survives (a separate managed service), so a building can look
"published" in the DB while every one of its files is gone from disk — exactly
the "building has no pipeline output" / 404 errors this module exists to fix.

Local disk is still the fast path and is always tried first — this only exists
to recover when local disk has been wiped, and to make freshly published/
imported bundles durable going forward. Entirely inert (is_enabled() is False)
unless SUPABASE_SERVICE_ROLE_KEY is configured, so local dev is unaffected.
"""
import mimetypes
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from ..config import get_settings


def is_enabled() -> bool:
    s = get_settings()
    return bool(s.supabase_url and s.supabase_service_role_key and s.supabase_storage_bucket)


def _object_path(slug: str, version: int, relpath: str) -> str:
    return f"published/{slug}/v{version}/{relpath}"


def _headers() -> dict:
    s = get_settings()
    key = s.supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


def upload_dir(slug: str, version: int, local_dir: Path, max_workers: int = 16) -> int:
    """Upload every file under local_dir to the bucket. Best-effort per file —
    returns the count actually uploaded; callers should log, not fail, on a
    partial count (local serving still works for this container's lifetime).

    A published bundle is typically hundreds of small files (GCU: 579) — doing
    this one HTTP round trip at a time serialized the whole publish/import
    request past any reasonable timeout. Fire them concurrently instead."""
    if not is_enabled():
        return 0
    s = get_settings()
    base = f"{s.supabase_url}/storage/v1/object/{s.supabase_storage_bucket}"
    files = [f for f in local_dir.rglob("*") if f.is_file()]
    if not files:
        return 0

    def put_one(f: Path) -> bool:
        rel = f.relative_to(local_dir).as_posix()
        ct = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        try:
            with httpx.Client(timeout=60) as client:
                r = client.put(
                    f"{base}/{_object_path(slug, version, rel)}",
                    content=f.read_bytes(),
                    headers={**_headers(), "Content-Type": ct, "x-upsert": "true"},
                )
            return r.status_code < 300
        except httpx.HTTPError:
            return False

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(put_one, files))
    return sum(results)


def fetch_bytes(slug: str, version: int, relpath: str) -> bytes | None:
    """Fetch one bundle file from storage. The bucket is public-read, so no auth
    is needed (and none is sent) for this GET."""
    if not is_enabled():
        return None
    s = get_settings()
    url = f"{s.supabase_url}/storage/v1/object/public/{s.supabase_storage_bucket}/{_object_path(slug, version, relpath)}"
    try:
        r = httpx.get(url, timeout=30)
        if r.status_code < 300:
            return r.content
    except httpx.HTTPError:
        pass
    return None


def read_bundle_file(local_version_dir: Path, slug: str, version: int, relpath: str) -> bytes:
    """Read one bundle file, local disk first, Supabase Storage as fallback —
    the fallback path that recovers from a wiped container disk. Best-effort
    re-caches to local disk on fallback so subsequent reads in this container's
    lifetime hit the fast path. Raises FileNotFoundError if neither has it."""
    p = local_version_dir / relpath
    if p.is_file():
        return p.read_bytes()
    data = fetch_bytes(slug, version, relpath)
    if data is None:
        raise FileNotFoundError(f"{relpath} not found locally or in storage for {slug} v{version}")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    except OSError:
        pass
    return data
