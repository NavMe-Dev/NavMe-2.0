"""Public chat Option 3 phase 1: tools + graceful no-LLM + feature flag."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from wayfinding_api.config import get_settings
from wayfinding_api.main import app
from wayfinding_api.services import chat as chat_svc


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_config_includes_chat_flags(client, monkeypatch):
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "")
    get_settings.cache_clear()
    cfg = client.get("/api/v1/public/config").json()
    assert "chat_enabled" in cfg
    assert cfg["chat_url"] == "/api/v1/public/chat"
    assert cfg["chat_enabled"] is True
    assert cfg["chat_configured"] is False


def test_chat_disabled_404(client, monkeypatch):
    monkeypatch.setenv("WF_CHAT_ENABLED", "false")
    get_settings.cache_clear()
    r = client.post("/api/v1/public/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 404


def test_chat_graceful_without_llm(client, monkeypatch):
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "")
    get_settings.cache_clear()
    r = client.post(
        "/api/v1/public/chat",
        json={"messages": [{"role": "user", "content": "Where is the bathroom?"}], "building": "4926-tacoma"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is False
    assert "LLM" in body["message"] or "Ollama" in body["message"]
    assert body["actions"] == []


def test_make_deep_link_tool():
    out = chat_svc.tool_make_deep_link("4926-tacoma", "poi_bath", from_key="poi_garage", step_free=True)
    assert out["url"].startswith("/?")
    assert "b=4926-tacoma" in out["url"]
    assert "to=poi_bath" in out["url"]
    assert "from=poi_garage" in out["url"]
    assert "mode=stepfree" in out["url"]
    assert out["action"]["type"] == "deep_link"


def test_search_route_tools_with_temp_publish(tmp_path):
    """Tool wrappers against a minimal published bundle (no live DB dependency)."""
    nav = {
        "nodes": [
            {"id": "n1", "x": 0, "y": 0, "z": 0, "floor": "F1", "kind": "sweep", "lonlat": [-80.8, 35.2]},
            {"id": "n2", "x": 10, "y": 0, "z": 0, "floor": "F1", "kind": "sweep", "lonlat": [-80.799, 35.2]},
        ],
        "edges": [{"u": "n1", "v": "n2", "length": 10, "step_free": True}],
        "cost_model": {"walk_speed_mps": 1.2, "stair_penalty_m": 15},
    }
    pois = {"pois": [
        {"id": "poi_a", "name": "Garage", "category": "parking", "floor": "F1", "nearest_node": "n1"},
        {"id": "poi_b", "name": "Bathroom", "category": "restroom", "floor": "F1", "nearest_node": "n2", "code": "R1"},
    ]}
    root = tmp_path / "pub" / "demo" / "v1"
    root.mkdir(parents=True)
    (root / "nav_graph.json").write_text(json.dumps(nav))
    (root / "pois.json").write_text(json.dumps(pois))

    class DummyDB:
        pass

    db = DummyDB()
    with patch("wayfinding_api.services.chat._published_path", return_value=root), \
         patch("wayfinding_api.services.chat._load_pois", return_value=pois["pois"]):
        hits = chat_svc.tool_search_pois(db, "demo", "bath")
        assert hits["count"] >= 1
        assert hits["results"][0]["name"] == "Bathroom"
        got = chat_svc.tool_get_poi(db, "demo", "poi_b")
        assert got["poi"]["id"] == "poi_b"
    with patch("wayfinding_api.services.chat._published_path", return_value=root):
        route = chat_svc.tool_route(db, "demo", "poi_a", "poi_b", step_free=False)
        assert route.get("ok") is True
        assert route["length_m"] == 10.0
    link = chat_svc.tool_make_deep_link("demo", "poi_b", "poi_a", True)
    assert "b=demo" in link["url"] and "mode=stepfree" in link["url"]


def test_run_tool_allowlist_rejects_unknown():
    from wayfinding_api.db import SessionLocal
    with SessionLocal() as db:
        out = chat_svc.run_tool(db, "debug_logs", {})
        assert "not allowed" in out.get("error", "")


def test_search_pois_bathroom_synonyms_and_plurals():
    """Toilet/WC/plurals/category aliases must hit Bathroom/restroom POIs (CHAT-005)."""
    pois = [
        {"id": "poi_bath", "name": "Bathroom", "category": "restroom", "floor": "F1", "code": "R1", "nearest_node": "n1"},
        {"id": "poi_bed", "name": "Bedroom", "category": "room", "floor": "F1", "code": "B1", "nearest_node": "n2"},
        {"id": "poi_gar", "name": "Garage", "category": "parking", "floor": "F1", "nearest_node": "n3"},
    ]
    class DummyDB:
        pass
    db = DummyDB()
    with patch("wayfinding_api.services.chat._load_pois", return_value=pois):
        for q in ("bathroom", "bathrooms", "restroom", "restrooms", "toilet", "wc", "lavatory",
                  "Where is the bathroom?", "Where is the toilet?", "find a WC"):
            hits = chat_svc.tool_search_pois(db, "demo", q)
            assert hits["count"] >= 1, q
            assert hits["results"][0]["name"] == "Bathroom", (q, hits)
            assert all(r["name"] != "Bedroom" for r in hits["results"]), q
        # Colloquial category filter must alias to restroom
        hits = chat_svc.tool_search_pois(db, "demo", "bathroom", category="bathroom")
        assert hits["count"] == 1 and hits["results"][0]["id"] == "poi_bath"
        hits = chat_svc.tool_search_pois(db, "demo", "", category="restroom")
        assert hits["count"] == 1
        # Unrelated query stays empty / non-restroom
        hits = chat_svc.tool_search_pois(db, "demo", "helipad")
        assert hits["count"] == 0
        hits = chat_svc.tool_search_pois(db, "demo", "garage")
        assert hits["count"] >= 1 and hits["results"][0]["name"] == "Garage"


def test_query_needles_expand_toilet():
    needles = set(chat_svc._query_needles("toilet"))
    assert "bathroom" in needles or "restroom" in needles
    assert "toilet" in needles
    phrase = set(chat_svc._query_needles("Where is the bathroom?"))
    assert "bathroom" in phrase

def test_maybe_force_search_place_hint():
    assert chat_svc._PLACE_HINT.search("Where is the toilet?")
    assert chat_svc._maybe_force_search(None, None, "toilet") is None
    pois = [{"id": "poi_bath", "name": "Bathroom", "category": "restroom", "floor": "F1", "code": "R1"}]
    with patch("wayfinding_api.services.chat._load_pois", return_value=pois):
        out = chat_svc._maybe_force_search(object(), "demo", "Where is the toilet?")
        assert out and out["count"] == 1


def test_ensure_human_reply_strips_tool_json():
    """LLM echo of search_pois JSON must become name/floor prose + deep links."""
    echo = (
        '{"results":[{"id":"poi_door_inf_kqtks5tmpsyhph9pxsw15","name":"Entrance 13",'
        '"code":null,"category":"entrance","floor":"F1"}],"count":1,"slug":"gcu-omr-libra"}'
    )
    tool_trace = [{
        "name": "search_pois",
        "args": {"slug": "gcu-omr-libra", "query": "entrance"},
        "result": {
            "slug": "gcu-omr-libra",
            "query": "entrance",
            "count": 1,
            "results": [
                {"id": "poi_door_inf_kqtks5tmpsyhph9pxsw15", "name": "Entrance 13",
                 "code": None, "category": "entrance", "floor": "F1"},
            ],
        },
    }]
    msg, acts = chat_svc._ensure_human_reply(echo, tool_trace, "gcu-omr-libra")
    assert "Entrance 13" in msg
    assert "floor F1" in msg
    assert '"results"' not in msg
    assert "poi_door" not in msg  # no raw id dump in prose lines beyond optional deep link
    assert not chat_svc._looks_like_tool_echo(msg)
    assert acts and acts[0]["type"] == "deep_link"
    assert "to=poi_door_inf_kqtks5tmpsyhph9pxsw15" in acts[0]["url"]
    # Good prose passes through unchanged
    plain = "Entrance 13 is on floor F1."
    assert chat_svc._ensure_human_reply(plain, [], None)[0] == plain


def test_ensure_human_reply_from_empty_with_search_trace():
    hits = [
        {"id": "poi_bath", "name": "Bathroom", "code": "R1", "category": "restroom", "floor": "F1"},
        {"id": "poi_bath2", "name": "Bathroom", "code": None, "category": "restroom", "floor": "F2"},
    ]
    trace = [{"name": "search_pois", "args": {"slug": "demo", "query": "bathroom"},
              "result": {"slug": "demo", "results": hits, "count": 2}}]
    msg, acts = chat_svc._ensure_human_reply("", trace, "demo")
    assert "Bathroom" in msg and "floor F1" in msg and "floor F2" in msg
    assert "(R1)" in msg
    assert len(acts) >= 1


def test_search_pois_entrance_and_bathroom_live_shape():
    """Entrance + bathroom queries return catalogue hits with name/floor (no crash)."""
    entrances = [
        {"id": "poi_e13", "name": "Entrance 13", "category": "entrance", "floor": "F1"},
        {"id": "poi_e1", "name": "Entrance 1", "category": "entrance", "floor": "F1"},
        {"id": "poi_bath", "name": "Bathroom", "category": "restroom", "floor": "F1", "code": "R1"},
    ]
    class DummyDB:
        pass
    with patch("wayfinding_api.services.chat._load_pois", return_value=entrances):
        hits = chat_svc.tool_search_pois(DummyDB(), "demo", "entrance")
        assert hits["count"] >= 2
        assert all(r["category"] == "entrance" for r in hits["results"])
        assert any(r["name"] == "Entrance 13" for r in hits["results"])
        human = chat_svc._format_poi_hits(hits["results"])
        assert "Entrance 13, floor F1" in human
        assert "{" not in human
        baths = chat_svc.tool_search_pois(DummyDB(), "demo", "bathroom")
        assert baths["count"] >= 1 and baths["results"][0]["name"] == "Bathroom"


def test_run_chat_postprocesses_json_echo(monkeypatch):
    """Even if the LLM returns raw tool JSON as content, run_chat must humanize it."""
    monkeypatch.setenv("WF_CHAT_ENABLED", "true")
    monkeypatch.setenv("WF_CHAT_LLM_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("WF_CHAT_LLM_API_KEY", "test-key")
    get_settings.cache_clear()

    search_payload = {
        "slug": "gcu-omr-libra",
        "query": "entrance",
        "count": 1,
        "results": [
            {"id": "poi_e13", "name": "Entrance 13", "category": "entrance", "floor": "F1"},
        ],
    }
    echo = json.dumps(search_payload)

    def fake_openai(messages, tools=None):
        # First call: emit a tool call; second (after tool): echo raw JSON
        has_tool = any(m.get("role") == "tool" for m in messages)
        if not has_tool:
            return {
                "choices": [{
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "search_pois",
                                "arguments": json.dumps({"slug": "gcu-omr-libra", "query": "entrance"}),
                            },
                        }],
                    }
                }]
            }
        return {"choices": [{"message": {"content": echo}}]}

    with patch.object(chat_svc, "_openai_chat", side_effect=fake_openai), \
         patch.object(chat_svc, "run_tool", return_value=search_payload):
        from wayfinding_api.db import SessionLocal
        with SessionLocal() as db:
            out = chat_svc.run_chat(
                db,
                [{"role": "user", "content": "entrance"}],
                building="gcu-omr-libra",
            )
    assert out["configured"] is True
    assert "Entrance 13" in out["message"]
    assert "floor F1" in out["message"]
    assert '"results"' not in out["message"]
    assert not chat_svc._looks_like_tool_echo(out["message"])
    assert out["actions"] and out["actions"][0]["type"] == "deep_link"


def test_ensure_human_reply_strips_poi_id_leaks():
    leaky = (
        "Here are entrances:\n"
        "- Entrance 13, floor F1 (id: poi_door_inf_kqtks5tmpsyhph9pxsw15)\n"
    )
    trace = [{
        "name": "search_pois",
        "args": {"slug": "gcu-omr-libra", "query": "entrance"},
        "result": {
            "slug": "gcu-omr-libra",
            "count": 1,
            "results": [
                {"id": "poi_door_inf_kqtks5tmpsyhph9pxsw15", "name": "Entrance 13",
                 "category": "entrance", "floor": "F1"},
            ],
        },
    }]
    msg, acts = chat_svc._ensure_human_reply(leaky, trace, "gcu-omr-libra")
    assert "Entrance 13" in msg and "floor F1" in msg
    assert "poi_" not in msg
    assert acts and "to=poi_door_inf_kqtks5tmpsyhph9pxsw15" in acts[0]["url"]

def test_actions_include_place_labels():
    """search_pois humanize must attach labeled select chips (poi_id + label)."""
    hits = [
        {"id": "poi_e13", "name": "Entrance 13", "category": "entrance", "floor": "F1"},
        {"id": "poi_bath", "name": "Bathroom", "code": "R1", "category": "restroom", "floor": "F1"},
    ]
    trace = [{"name": "search_pois", "args": {"slug": "demo", "query": "entrance"},
              "result": {"slug": "demo", "results": hits, "count": 2}}]
    msg, acts = chat_svc._ensure_human_reply("", trace, "demo")
    assert "Entrance 13" in msg
    assert acts and all(a.get("type") == "deep_link" for a in acts)
    assert acts[0].get("poi_id") == "poi_e13"
    assert "Entrance 13" in (acts[0].get("label") or "")
    assert acts[0].get("intent") == "select"
    # merge must preserve labels
    merged = chat_svc._merge_actions([{"type": "deep_link", "url": acts[0]["url"]}], acts)
    assert merged[0].get("label")

def test_format_poi_line_skips_duplicate_code():
    assert chat_svc._format_poi_line({"name": "Room F1-01", "code": "Room F1-01", "floor": "F1"}) == "Room F1-01, floor F1"
    assert "(R1)" in chat_svc._format_poi_line({"name": "Bathroom", "code": "R1", "floor": "F1"})


def test_restroom_empty_falls_back_to_rooms():
    """When catalogue has rooms but no restrooms (GCU-style), bathroom search offers room chips."""
    pois = [
        {"id": "poi_r1", "name": "Room F1-01", "code": "Room F1-01", "category": "room", "floor": "F1"},
        {"id": "poi_r2", "name": "Room F1-02", "code": "Room F1-02", "category": "room", "floor": "F1"},
        {"id": "poi_e1", "name": "Entrance 1", "category": "entrance", "floor": "F1"},
    ]
    with patch("wayfinding_api.services.chat._load_pois", return_value=pois):
        hits = chat_svc.tool_search_pois(object(), "gcu-omr-libra", "bathroom")
    assert hits["count"] == 0
    assert hits.get("empty_reason") == "no_restrooms_tagged"
    assert hits.get("fallback_results") and hits["fallback_results"][0]["name"].startswith("Room")
    msg, acts = chat_svc._ensure_human_reply(
        "I could not find a bathroom in the published catalogue.",
        [{"name": "search_pois", "args": {"slug": "gcu-omr-libra", "query": "bathroom"}, "result": hits}],
        "gcu-omr-libra",
    )
    assert "no restrooms tagged" in msg.lower() or "rooms you can open" in msg.lower()
    assert "Bathroom" not in [a.get("label") for a in acts]  # must not invent bathroom labels
    assert acts and acts[0].get("intent") == "select"
    assert "Room F1-01" in (acts[0].get("label") or "")
    assert "(Room F1-01)" not in (acts[0].get("label") or "")  # no duplicate code



def test_resolve_building_slug_prefers_context():
    """Viewer building context wins over invalid LLM slug (GCU empty-catalogue bug)."""
    class B:
        def __init__(self, slug, name):
            self.slug = slug
            self.name = name
    class Q:
        def __init__(self, rows):
            self._rows = rows
        def filter_by(self, **kw):
            slug = kw.get("slug")
            self._rows = [b for b in self._rows if b.slug == slug]
            return self
        def first(self):
            return self._rows[0] if self._rows else None
        def all(self):
            return list(self._rows)
    class DummyDB:
        def __init__(self, rows):
            self._rows = rows
        def query(self, _model):
            return Q(list(self._rows))
    rows = [B("gcu-omr-libra", "GCU OMR with Library"), B("4926-tacoma", "4926 Tacoma Dr")]
    db = DummyDB(rows)
    with patch("wayfinding_api.services.chat.current_version", return_value=object()):
        assert chat_svc._resolve_building_slug(db, "gcu", preferred="gcu-omr-libra") == "gcu-omr-libra"
        assert chat_svc._resolve_building_slug(db, "", preferred="gcu-omr-libra") == "gcu-omr-libra"
        assert chat_svc._resolve_building_slug(db, "not-a-building", preferred="gcu-omr-libra") == "gcu-omr-libra"
        assert chat_svc._resolve_building_slug(db, "4926-tacoma", preferred=None) == "4926-tacoma"


def test_gcu_style_rooms_and_bathroom_catalogue_note():
    """GCU-shaped catalogue: rooms searchable; bathroom empty with fallback + catalogue_size."""
    pois = [
        {"id": "poi_r1", "name": "Room F1-01", "code": "Room F1-01", "category": "room", "floor": "F1"},
        {"id": "poi_r2", "name": "Room F2-01", "code": "Room F2-01", "category": "room", "floor": "F2"},
        {"id": "poi_e1", "name": "Entrance 1", "category": "entrance", "floor": "F1"},
        {"id": "poi_s1", "name": "Stairs A – Floor 1", "category": "stairs", "floor": "F1"},
    ]
    with patch("wayfinding_api.services.chat._load_pois", return_value=pois):
        hits = chat_svc.tool_search_pois(object(), "gcu-omr-libra", "rooms")
        assert hits["count"] >= 1
        assert all(r.get("category") == "room" for r in hits["results"])
        bath = chat_svc.tool_search_pois(object(), "gcu-omr-libra", "bathroom")
        assert bath["count"] == 0
        assert bath.get("catalogue_size") == 4
        assert bath.get("empty_reason") == "no_restrooms_tagged"
        assert bath.get("fallback_results")
        assert "room" in bath.get("available_categories", {})
