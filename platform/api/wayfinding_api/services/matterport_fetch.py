"""Matterport Model API (authenticated GraphQL) — mesh asset lookup + download.

Separate from wfpipe.steps.fetch_mp, which hits the *public*, unauthenticated
my.matterport.com GraphQL endpoint for metadata only (floors/sweeps/rooms).
This module hits api.matterport.com with Basic auth (MATTERPORT_TOKEN_ID /
MATTERPORT_TOKEN_SECRET) to read `assets.meshes`, which Matterport only
populates once the MatterPak add-on is *unlocked* (purchased) for that model.
Never calls the paid `unlockModelBundle` mutation.
"""
import base64
import httpx

from ..config import get_settings

MODEL_API = "https://api.matterport.com/api/models/graph"


def _auth_header() -> str:
    s = get_settings()
    if not s.matterport_token_id or not s.matterport_token_secret:
        raise RuntimeError("MATTERPORT_TOKEN_ID / MATTERPORT_TOKEN_SECRET not configured on the server")
    raw = f"{s.matterport_token_id}:{s.matterport_token_secret}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def _graphql(query: str, variables: dict | None = None, timeout: float = 45) -> dict:
    body = {"query": query, "variables": variables} if variables is not None else {"query": query}
    r = httpx.post(MODEL_API, json=body, headers={"Authorization": _auth_header()}, timeout=timeout)
    payload = {}
    try:
        payload = r.json()
    except Exception:
        pass
    if r.status_code >= 300:
        raise RuntimeError(f"Matterport HTTP {r.status_code}")
    if payload.get("errors"):
        raise RuntimeError(str(payload["errors"][0].get("message") or "Matterport API error"))
    return payload.get("data") or {}


def fetch_model_mesh_assets(model_id: str) -> dict:
    """Signed download links for a model's mesh geometry, straight from Matterport.

    `downloadUrl` is a short-lived pre-signed CDN link — mint per request, never persist.
    `status` is 'available' once the MatterPak add-on is unlocked, else 'locked'.
    """
    mid = (model_id or "").strip()
    if not mid:
        raise ValueError("model_id is required")
    data = _graphql(
        """query($id:ID!){model(id:$id){
          id name
          assets{meshes{id format resolution status filename downloadUrl validUntil}}
        }}""",
        {"id": mid},
    )
    model = data.get("model")
    if not model or not model.get("id"):
        raise RuntimeError("Matterport model not found or inaccessible for this API token")
    meshes = ((model.get("assets") or {}).get("meshes")) or []
    return {"id": model["id"], "name": model.get("name"), "meshes": meshes}


def download_to(url: str, dest_path, max_bytes: int) -> int:
    """Stream a signed Matterport CDN download URL to a local file. Returns bytes written."""
    size = 0
    with httpx.stream("GET", url, timeout=120, follow_redirects=True) as r:
        if r.status_code >= 300:
            raise RuntimeError(f"download HTTP {r.status_code}")
        with open(dest_path, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                size += len(chunk)
                if size > max_bytes:
                    raise RuntimeError("downloaded file exceeds MAX_UPLOAD_MB")
                f.write(chunk)
    return size
