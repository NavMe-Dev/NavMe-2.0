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


# Supabase Storage's standard upload endpoint rejects anything over ~50MB regardless of
# the bucket's own file_size_limit setting (confirmed: a 73MB vps_index.npz got a 413
# "Payload too large" even though the bucket allows up to 200MB) — split anything bigger
# than this into chunks and reassemble on read, rather than compromise what gets indexed
# to fit under an upload-protocol limit. A plain ".chunks" sibling object (just the chunk
# count as text) lets fetch_bytes() know whether/how to reassemble without guessing.
_CHUNK_THRESHOLD = 40 * 1024 * 1024
_CHUNK_SIZE = 35 * 1024 * 1024


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
        obj = f"{base}/{_object_path(slug, version, rel)}"
        data = f.read_bytes()
        try:
            with httpx.Client(timeout=120) as client:
                if len(data) <= _CHUNK_THRESHOLD:
                    r = client.put(obj, content=data, headers={**_headers(), "Content-Type": ct, "x-upsert": "true"})
                    return r.status_code < 300
                n_chunks = (len(data) + _CHUNK_SIZE - 1) // _CHUNK_SIZE
                ok = True
                for i in range(n_chunks):
                    chunk = data[i * _CHUNK_SIZE:(i + 1) * _CHUNK_SIZE]
                    r = client.put(f"{obj}.part{i}", content=chunk,
                                   headers={**_headers(), "Content-Type": "application/octet-stream", "x-upsert": "true"})
                    ok = ok and r.status_code < 300
                r = client.put(f"{obj}.chunks", content=str(n_chunks).encode(),
                               headers={**_headers(), "Content-Type": "text/plain", "x-upsert": "true"})
                return ok and r.status_code < 300
        except httpx.HTTPError:
            return False

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(put_one, files))
    return sum(results)


def fetch_bytes(slug: str, version: int, relpath: str) -> bytes | None:
    """Fetch one bundle file from storage. The bucket is public-read, so no auth
    is needed (and none is sent) for these GETs. Reassembles chunked uploads
    (see upload_dir) transparently if a direct fetch 404s and a ".chunks"
    manifest exists alongside it."""
    if not is_enabled():
        return None
    s = get_settings()
    base = f"{s.supabase_url}/storage/v1/object/public/{s.supabase_storage_bucket}/{_object_path(slug, version, relpath)}"
    try:
        r = httpx.get(base, timeout=60)
        if r.status_code < 300:
            return r.content
        rc = httpx.get(f"{base}.chunks", timeout=30)
        if rc.status_code >= 300:
            return None
        n_chunks = int(rc.text.strip())
        parts = []
        for i in range(n_chunks):
            rp = httpx.get(f"{base}.part{i}", timeout=120)
            if rp.status_code >= 300:
                return None
            parts.append(rp.content)
        return b"".join(parts)
    except (httpx.HTTPError, ValueError):
        pass
    return None


def upload_navmesh(slug: str, local_path: Path) -> bool:
    """Mirror the standalone Recast .navmesh file (served as a static file straight out
    of viewer_dir, outside the versioned publish bundle entirely — see
    dashboard_navmesh_url()) the same way published bundles are mirrored."""
    if not is_enabled() or not local_path.is_file():
        return False
    s = get_settings()
    try:
        with httpx.Client(timeout=60) as client:
            r = client.put(
                f"{s.supabase_url}/storage/v1/object/{s.supabase_storage_bucket}/navmesh/{slug}.navmesh",
                content=local_path.read_bytes(),
                headers={**_headers(), "Content-Type": "application/octet-stream", "x-upsert": "true"},
            )
        return r.status_code < 300
    except httpx.HTTPError:
        return False


def fetch_navmesh_bytes(slug: str) -> bytes | None:
    if not is_enabled():
        return None
    s = get_settings()
    url = f"{s.supabase_url}/storage/v1/object/public/{s.supabase_storage_bucket}/navmesh/{slug}.navmesh"
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
