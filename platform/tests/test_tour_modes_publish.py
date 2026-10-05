"""Publish freezes pipeline_config.tour_modes + has_glb into config.json."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from wayfinding_api.services.publish import build_bundle


def test_build_bundle_tour_modes(tmp_path: Path):
    ws = tmp_path / "ws"
    out = ws / "out"
    out.mkdir(parents=True)
    (out / "config.json").write_text(json.dumps({
        "schema": "wayfinding.config/v1",
        "floors": [{"id": "F1", "label": "1", "short": "1", "ordinal": 0}],
        "files": {},
        "stats": {"pois": 0, "nav_nodes": 0, "nav_edges": 0, "entrances": 0},
    }))
    (out / "model_full.glb").write_bytes(b"glb")
    (out / "pois.json").write_text('{"pois":[]}')
    dest = tmp_path / "pub"

    b = SimpleNamespace(
        id=1, slug="demo", name="Demo", address="", branding={},
        matterport_model_id="abc", venue=None, floors=[],
        pipeline_config={
            "tour_modes": {
                "embed_showcase": True,
                "mesh_tour": True,
                "bundle_scene": True,
                "bundle_url": "https://example.com/showcase.html",
                "bundle_note": "dollhouse spike",
            },
            "media_panels": [],
        },
    )

    class Q:
        def filter_by(self, **k): return self
        def order_by(self, *a): return self
        def __iter__(self): return iter([])

    class DB:
        def query(self, *a, **k): return Q()

    with patch("wayfinding_api.services.publish.ws_dir", return_value=ws), \
         patch("wayfinding_api.services.publish.get_settings") as gs:
        gs.return_value.matterport_sdk_key = "x"
        gs.return_value.vps_url = ""
        cfg = build_bundle(DB(), b, dest, published_only=True)

    assert cfg["has_glb"] is True
    tm = cfg["tour_modes"]
    assert tm["mesh_tour"] is True
    assert tm["bundle_scene"] is True
    assert tm["bundle_configured"] is True
    assert tm["bundle_url"].startswith("https://")
    assert tm["bundle_camera"] == "dollhouse"
    assert tm["has_glb"] is True
    saved = json.loads((dest / "config.json").read_text())
    assert saved["tour_modes"]["mesh_tour"] is True
