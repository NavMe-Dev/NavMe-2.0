"""Pluggable Project X localize slot (legacy env key VPS_URL).

Primary: POST /api/v1/public/vps/localize  (viewer Image button)
Aliases:  POST /localize  and  GET /health  (field-test page same-origin)

If VPS_URL is set, forwards multipart/JSON to {VPS_URL}/localize and returns its JSON + status.
Each forward also appends a thin JSONL entry under /workspace/wayfinding/vps/field_logs/
(no full JPEG by default). Field kit can POST richer client entries to /field_log.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Request, HTTPException, Response
from fastapi.responses import JSONResponse
from ..config import get_settings

router = APIRouter(tags=["vps"])

# Path-only Project X engine logs (filesystem convention).
FIELD_LOG_DIR = Path("/workspace/wayfinding/vps/field_logs")
SERVER_JSONL = FIELD_LOG_DIR / "server_localize.jsonl"
CLIENT_JSONL = FIELD_LOG_DIR / "client_field.jsonl"
# Soft cap: skip saving images larger than this (bytes).
_IMAGE_SAVE_MAX = 400_000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_jsonl(path: Path, entry: dict) -> None:
    FIELD_LOG_DIR.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False, default=str)
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _peek_multipart_meta(body: bytes) -> dict:
    """Best-effort extract of model_id / note / image size from multipart body (no full decode)."""
    meta: dict = {"body_bytes": len(body)}
    m = re.search(rb'name="model_id"\r?\n\r?\n([^\r\n]*)', body)
    if m:
        meta["model_id"] = m.group(1).decode("utf-8", "replace").strip()
    n = re.search(rb'name="note"\r?\n\r?\n([^\r\n]*)', body)
    if n:
        meta["note"] = n.group(1).decode("utf-8", "replace").strip()
    h = re.search(rb'name="hfov"\r?\n\r?\n([^\r\n]*)', body)
    if h:
        try:
            meta["hfov"] = float(h.group(1).decode("utf-8", "replace").strip())
        except ValueError:
            pass
    # Rough JPEG payload size: largest binary-ish part after filename=
    img = re.search(
        rb'name="image"[^\r\n]*\r?\n(?:Content-Type:[^\r\n]*\r?\n)?\r?\n',
        body,
        re.IGNORECASE,
    )
    if img:
        start = img.end()
        # multipart parts end at next boundary starting with \r\n--
        end = body.find(b"\r\n--", start)
        if end < 0:
            end = len(body)
        meta["image_bytes"] = max(0, end - start)
    return meta


def _log_proxy_attempt(
    *,
    meta: dict,
    status: int,
    data: dict | None,
    error: str | None,
    elapsed_s: float,
    path: str,
) -> None:
    entry = {
        "source": "platform_proxy",
        "time": _now_iso(),
        "path": path,
        "model_id": meta.get("model_id"),
        "note": meta.get("note") or None,
        "hfov": meta.get("hfov"),
        "image_bytes": meta.get("image_bytes") or meta.get("body_bytes"),
        "http_status": status,
        "roundtrip_s": round(elapsed_s, 3),
        "result": data,
        "error": error,
    }
    try:
        _append_jsonl(SERVER_JSONL, entry)
    except Exception as e:
        # Never fail the localize response because of logging.
        print(f"field_log write failed: {e}", flush=True)


async def _forward_localize(request: Request) -> Response:
    url = get_settings().vps_url
    if not url:
        raise HTTPException(501, "no visual positioning service configured (set VPS_URL)")
    body = await request.body()
    headers = {k: v for k, v in request.headers.items() if k.lower() in ("content-type",)}
    meta = _peek_multipart_meta(body) if "multipart" in headers.get("content-type", "") else {
        "body_bytes": len(body)
    }
    t0 = time.perf_counter()
    data = None
    error = None
    status = 502
    async with httpx.AsyncClient(timeout=120) as c:
        try:
            r = await c.post(
                url.rstrip("/") + "/localize",
                content=body,
                headers=headers,
                params=dict(request.query_params),
            )
            status = r.status_code
        except httpx.HTTPError as e:
            error = f"VPS unreachable: {e.__class__.__name__}"
            _log_proxy_attempt(
                meta=meta,
                status=502,
                data=None,
                error=error,
                elapsed_s=time.perf_counter() - t0,
                path=str(request.url.path),
            )
            raise HTTPException(502, error)
    try:
        data = r.json()
    except Exception:
        error = "VPS returned non-JSON"
        _log_proxy_attempt(
            meta=meta,
            status=502,
            data=None,
            error=error,
            elapsed_s=time.perf_counter() - t0,
            path=str(request.url.path),
        )
        raise HTTPException(502, error)
    if isinstance(data, dict) and not meta.get("model_id") and data.get("model_id"):
        meta["model_id"] = data.get("model_id")
    _log_proxy_attempt(
        meta=meta,
        status=status,
        data=data if isinstance(data, dict) else {"raw": data},
        error=None,
        elapsed_s=time.perf_counter() - t0,
        path=str(request.url.path),
    )
    return JSONResponse(content=data, status_code=status)


async def _forward_health() -> Response:
    url = get_settings().vps_url
    if not url:
        raise HTTPException(501, "no visual positioning service configured (set VPS_URL)")
    async with httpx.AsyncClient(timeout=30) as c:
        try:
            r = await c.get(url.rstrip("/") + "/health")
        except httpx.HTTPError as e:
            raise HTTPException(502, f"VPS unreachable: {e.__class__.__name__}")
    try:
        data = r.json()
    except Exception:
        raise HTTPException(502, "VPS returned non-JSON")
    return JSONResponse(content=data, status_code=r.status_code)


@router.post("/api/v1/public/vps/localize")
async def localize_api(request: Request):
    return await _forward_localize(request)


@router.post("/localize")
async def localize_alias(request: Request):
    """Same-origin alias for localize.html field test (posts to {origin}/localize)."""
    return await _forward_localize(request)


@router.get("/health")
async def health_alias():
    """Same-origin Project X health for the field-test building picker."""
    return await _forward_health()


async def _ingest_client_field_log(request: Request) -> Response:
    """Accept one (or a list of) client field-kit attempt objects; append JSONL."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "expected JSON body")
    entries = payload if isinstance(payload, list) else [payload]
    if not entries or not all(isinstance(e, dict) for e in entries):
        raise HTTPException(400, "expected object or array of objects")
    written = 0
    for e in entries:
        row = dict(e)
        row.setdefault("source", "field_kit")
        row.setdefault("received_at", _now_iso())
        # Never persist huge embedded blobs from the client.
        for k in ("image_b64", "imageData", "jpeg", "photo"):
            if k in row and isinstance(row[k], str) and len(row[k]) > 256:
                row[k] = f"<omitted {len(row[k])} chars>"
        try:
            _append_jsonl(CLIENT_JSONL, row)
            written += 1
        except Exception as ex:
            raise HTTPException(500, f"log write failed: {ex}")
    return JSONResponse({"ok": True, "written": written, "path": str(CLIENT_JSONL)})


@router.post("/api/v1/public/vps/field_log")
async def field_log_api(request: Request):
    return await _ingest_client_field_log(request)


@router.post("/field_log")
async def field_log_alias(request: Request):
    """Same-origin alias used by localize.html after each attempt."""
    return await _ingest_client_field_log(request)
