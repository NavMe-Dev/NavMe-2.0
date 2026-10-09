"""The NavMe Dashboard poi_type is free text and must survive verbatim.

Regression guard for client onboarding: the wayfinding slug is forced to
[a-z0-9-], but navme_pois.poi_type in the dashboard is whatever was typed there
("POI Navme", "Sparkhouse"). Slugifying it makes every Supabase lookup return zero
rows silently, which is the bug this module exists to prevent.
"""
from types import SimpleNamespace

from wayfinding_api.services import navme


def B(slug, pc=None):
    return SimpleNamespace(slug=slug, pipeline_config=pc)


def test_poi_type_is_verbatim_not_slugified():
    b = B("poi-navme", {"navme_poi_type": "POI Navme"})
    assert navme.poi_type(b) == "POI Navme"


def test_poi_type_falls_back_to_slug_when_unset():
    assert navme.poi_type(B("sparkhouse")) == "sparkhouse"
    assert navme.poi_type(B("sparkhouse", {})) == "sparkhouse"
    assert navme.poi_type(B("sparkhouse", {"navme_poi_type": "   "})) == "sparkhouse"
    assert navme.poi_type(B("sparkhouse", {"navme_poi_type": None})) == "sparkhouse"


def test_poi_type_keeps_inner_spacing_and_case():
    b = B("tacoma-mall-l1", {"navme_poi_type": "  Tacoma Mall - L1  "})
    assert navme.poi_type(b) == "Tacoma Mall - L1"


def test_set_poi_type_round_trip_and_clear():
    pc = navme.set_poi_type({"keep": 1}, "POI Navme")
    assert pc == {"keep": 1, "navme_poi_type": "POI Navme"}
    assert navme.set_poi_type(pc, "") == {"keep": 1}
    assert navme.set_poi_type(pc, None) == {"keep": 1}
    assert navme.set_poi_type(None, "X") == {"navme_poi_type": "X"}
    # must not mutate the caller's dict
    original = {"a": 1}
    navme.set_poi_type(original, "Y")
    assert original == {"a": 1}


def test_pg_value_quotes_only_when_postgrest_needs_it():
    assert navme.pg_value("sparkhouse") == "sparkhouse"
    assert navme.pg_value("POI Navme") == '"POI Navme"'
    assert navme.pg_value("a,b") == '"a,b"'
    assert navme.pg_value('say "hi"') == '"say \\"hi\\""'
    assert navme.pg_value("") == ""


def test_media_candidates_tries_exact_value_first():
    b = B("poi-navme", {"navme_poi_type": "POI Navme"})
    c = navme.media_candidates(b)
    assert c[0] == "POI Navme"
    assert c[1] == "POI NAVME"
    # old slug-derived guesses stay on as a fallback, after the exact value
    assert "poi-navme" in c and c.index("poi-navme") > 1


def test_media_candidates_unchanged_for_buildings_without_a_poi_type():
    """Buildings onboarded before this field existed must resolve exactly as before."""
    assert navme.media_candidates(B("gcu-main")) == ["gcu-main", "GCU-MAIN", "gcu", "GCU"]
