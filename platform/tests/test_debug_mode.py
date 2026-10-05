"""Debug mode: settings resolve, log ring, publish hint."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from wayfinding_api.services import debug_log as dbg
from wayfinding_api.services.publish import build_bundle


def test_building_override_inherit_and_force(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))  # may not bind; patch get_settings path
    with patch.object(dbg, "_settings_path", return_value=tmp_path / "platform_settings.json"), \
         patch.object(dbg, "_log_path", return_value=tmp_path / "debug_logs.jsonl"):
        # reset module state
        dbg._BUF.clear()
        dbg._LOADED = True
        dbg.write_platform_settings({"debug": {"enabled": False}})
        assert dbg.global_enabled() is False
        assert dbg.effective_enabled(pipeline_config={}) is False
        assert dbg.effective_enabled(pipeline_config={"debug": {"enabled": True}}) is True
        dbg.write_platform_settings({"debug": {"enabled": True}})
        assert dbg.effective_enabled(pipeline_config={}) is True
        assert dbg.effective_enabled(pipeline_config={"debug": {"enabled": False}}) is False
        pc = dbg.set_building_override({"tour_modes": {"mesh_tour": True}}, True)
        assert pc["tour_modes"]["mesh_tour"] is True
        assert pc["debug"]["enabled"] is True
        pc2 = dbg.set_building_override(pc, None)
        assert "debug" not in pc2
        assert pc2["tour_modes"]["mesh_tour"] is True


def test_append_and_query(tmp_path):
    with patch.object(dbg, "_settings_path", return_value=tmp_path / "platform_settings.json"), \
         patch.object(dbg, "_log_path", return_value=tmp_path / "debug_logs.jsonl"):
        dbg._BUF.clear()
        dbg._LOADED = True
        dbg._SEQ = 0
        dbg.write_platform_settings({"debug": {"enabled": True}})
        n = dbg.append_entries([
            {"level": "info", "source": "tour", "message": "hop 1", "building": "4926-tacoma"},
            {"level": "error", "source": "api", "message": "boom", "building": "4926-tacoma"},
            {"level": "debug", "source": "routing", "message": "edge", "building": "greenland"},
        ], force=True)
        assert n == 3
        q = dbg.query_logs(limit=10, building="4926-tacoma")
        assert len(q["logs"]) == 2
        q2 = dbg.query_logs(limit=10, level="error")
        assert len(q2["logs"]) == 1
        assert q2["logs"][0]["message"] == "boom"
        dbg.clear_logs()
        assert dbg.query_logs(limit=10)["logs"] == []


def test_build_bundle_includes_debug(tmp_path):
    ws = tmp_path / "ws"
    out = ws / "out"
    out.mkdir(parents=True)
    (out / "config.json").write_text(json.dumps({
        "schema": "wayfinding.config/v1",
        "floors": [{"id": "F1", "label": "1", "short": "1", "ordinal": 0}],
        "files": {},
        "stats": {"pois": 0, "nav_nodes": 0, "nav_edges": 0, "entrances": 0},
    }))
    (out / "pois.json").write_text('{"pois":[]}')
    dest = tmp_path / "pub"
    b = SimpleNamespace(
        id=1, slug="demo", name="Demo", address="", branding={},
        matterport_model_id="abc", venue=None, floors=[],
        pipeline_config={"debug": {"enabled": True}, "tour_modes": {}, "media_panels": []},
    )

    class Q:
        def filter_by(self, **k): return self
        def order_by(self, *a): return self
        def __iter__(self): return iter([])

    class DB:
        def query(self, *a, **k): return Q()

    with patch("wayfinding_api.services.publish.ws_dir", return_value=ws), \
         patch("wayfinding_api.services.publish.get_settings") as gs, \
         patch("wayfinding_api.services.debug_log.global_enabled", return_value=False):
        gs.return_value.matterport_sdk_key = "x"
        gs.return_value.vps_url = ""
        cfg = build_bundle(DB(), b, dest, published_only=True)
    assert cfg["debug"] is True
    saved = json.loads((dest / "config.json").read_text())
    assert saved["debug"] is True
