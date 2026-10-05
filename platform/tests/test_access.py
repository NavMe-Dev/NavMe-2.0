"""Access controls: PIN hash, matterport gate, publish access freeze + nav edge filter."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from wayfinding_api.services import access as access_svc
from wayfinding_api.services.publish import build_bundle


def test_hash_and_verify_pin():
    h = access_svc.hash_pin("1234")
    assert len(h) == 64
    assert access_svc.verify_pin("1234", h)
    assert not access_svc.verify_pin("9999", h)
    assert not access_svc.verify_pin(None, h)
    assert h != access_svc.hash_pin("12345")


def test_sanitize_access_hashes_pin_preserves_others():
    prev = {"twin": "public", "tour_public": True}
    out = access_svc.sanitize_access(
        {"twin": "pin", "twin_pin": "ab12", "tour_public": False,
         "routing": {"mode": "exclude_edges", "excluded_edge_ids": ["a|b", "a|b", "c→d"]}},
        prev,
    )
    assert out["twin"] == "pin"
    assert out["tour_public"] is False
    assert "twin_pin" not in out
    assert out["twin_pin_hash"] == access_svc.hash_pin("ab12")
    assert out["routing"]["excluded_edge_ids"] == ["a|b", "c|d"]

    # Keep hash when no new pin
    out2 = access_svc.sanitize_access({"twin": "pin", "tour_public": True}, out)
    assert out2["twin_pin_hash"] == out["twin_pin_hash"]


def test_sanitize_rejects_bad_pin():
    with pytest.raises(ValueError):
        access_svc.sanitize_access({"twin": "pin", "twin_pin": "12"})


def test_public_access_view_no_secrets():
    raw = {"twin": "pin", "twin_pin_hash": "deadbeef", "tour_public": True,
           "routing": {"mode": "all_public", "excluded_edge_ids": []}}
    pub = access_svc.public_access_view(raw)
    assert pub["twin"] == "pin"
    assert pub["pin_required"] is True
    assert "twin_pin_hash" not in pub
    assert "twin_pin" not in pub


def test_matterport_allowed_modes():
    ok, st, _ = access_svc.matterport_allowed({"twin": "disabled"}, None, None)
    assert not ok and st == 403
    ok, st, _ = access_svc.matterport_allowed({"twin": "public", "tour_public": False}, None, None)
    assert not ok and st == 403
    h = access_svc.hash_pin("9999")
    ok, st, _ = access_svc.matterport_allowed({"twin": "pin"}, "bad", h)
    assert not ok and st == 403
    ok, st, _ = access_svc.matterport_allowed({"twin": "pin"}, "9999", h)
    assert ok and st == 200
    ok, st, _ = access_svc.matterport_allowed({"twin": "public", "tour_public": True}, None, None)
    assert ok


def test_filter_nav_graph_removes_edges():
    nav = {
        "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
        "edges": [
            {"u": "a", "v": "b", "length": 1.0},
            {"u": "b", "v": "c", "length": 2.0},
            {"u": "a", "v": "c", "length": 3.0},
        ],
        "stats": {"nav_edges": 3},
    }
    filtered = access_svc.filter_nav_graph(nav, ["a|b", "c|a"])  # reverse of a|c
    ids = [access_svc.edge_id_from_edge(e) for e in filtered["edges"]]
    assert ids == ["b|c"]
    assert filtered["stats"]["nav_edges"] == 1
    assert filtered["stats"]["excluded_edges"] == 2
    # original untouched
    assert len(nav["edges"]) == 3


def test_build_bundle_access_and_edge_filter(tmp_path: Path):
    ws = tmp_path / "ws"
    out = ws / "out"
    out.mkdir(parents=True)
    (out / "config.json").write_text(json.dumps({
        "schema": "wayfinding.config/v1",
        "floors": [{"id": "F1", "label": "1", "short": "1", "ordinal": 0}],
        "files": {},
        "stats": {"pois": 0, "nav_nodes": 3, "nav_edges": 2, "entrances": 0},
    }))
    nav = {
        "nodes": [
            {"id": "n1", "kind": "sweep", "floor": "F1", "x": 0, "y": 0, "z": 0, "lonlat": [0, 0]},
            {"id": "n2", "kind": "sweep", "floor": "F1", "x": 1, "y": 0, "z": 0, "lonlat": [0.001, 0]},
            {"id": "n3", "kind": "sweep", "floor": "F1", "x": 2, "y": 0, "z": 0, "lonlat": [0.002, 0]},
        ],
        "edges": [
            {"u": "n1", "v": "n2", "length": 1.0, "step_free": True},
            {"u": "n2", "v": "n3", "length": 1.0, "step_free": True},
        ],
        "stats": {"nav_edges": 2},
    }
    (out / "nav_graph.json").write_text(json.dumps(nav))
    (out / "pois.json").write_text('{"pois":[]}')
    dest = tmp_path / "pub"

    pin_hash = access_svc.hash_pin("4242")
    b = SimpleNamespace(
        id=1, slug="demo", name="Demo", address="", branding={},
        matterport_model_id="abc", venue=None, floors=[],
        pipeline_config={
            "access": {
                "twin": "pin",
                "twin_pin_hash": pin_hash,
                "tour_public": True,
                "routing": {"mode": "exclude_edges", "excluded_edge_ids": ["n1|n2"]},
            },
            "tour_modes": {"embed_showcase": True},
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

    assert cfg["access"]["twin"] == "pin"
    assert cfg["access"]["pin_required"] is True
    assert "twin_pin_hash" not in cfg["access"]
    assert "twin_pin" not in cfg["access"]
    pub_nav = json.loads((dest / "nav_graph.json").read_text())
    assert len(pub_nav["edges"]) == 1
    assert pub_nav["edges"][0]["u"] == "n2"
    # draft workspace untouched
    draft = json.loads((out / "nav_graph.json").read_text())
    assert len(draft["edges"]) == 2


def test_route_impact_message():
    assert "cannot reach" in access_svc.route_impact_message(True, False).lower()
    assert "full draft" in access_svc.route_impact_message(False, False).lower()
    assert "available" in access_svc.route_impact_message(True, True).lower()


def test_preview_route_impact_blocks_when_bridge_excluded():
    nav = {
        "nodes": [
            {"id": "a", "x": 0, "y": 0, "z": 0, "floor": "F1", "lonlat": [0, 0]},
            {"id": "b", "x": 1, "y": 0, "z": 0, "floor": "F1", "lonlat": [0.001, 0]},
            {"id": "c", "x": 2, "y": 0, "z": 0, "floor": "F1", "lonlat": [0.002, 0]},
        ],
        "edges": [
            {"u": "a", "v": "b", "length": 1.0, "step_free": True},
            {"u": "b", "v": "c", "length": 1.0, "step_free": True},
        ],
        "cost_model": {"walk_speed_mps": 1.2, "stair_penalty_m": 15},
    }
    out = access_svc.preview_route_impact(nav, "a", "c", ["a|b"], step_free=False)
    assert out["full"] is not None
    assert out["restricted"] is None
    assert out["public_blocked"] is True
    assert "cannot reach" in out["message"].lower()
    # no exclusions → same as full
    out2 = access_svc.preview_route_impact(nav, "a", "c", [], step_free=False)
    assert out2["restricted"] is not None and out2["full"] is not None
    assert out2["public_blocked"] is False
