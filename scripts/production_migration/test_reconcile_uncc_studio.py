"""Regression cases for Studio edits crossing an independently calibrated copy."""
from copy import deepcopy
from decimal import Decimal
import json

import pytest

from reconcile_uncc_studio import (
    EXPECTED_POSITION, POSITION, ReconcileError, dumps, loads, normalise,
    plan_features, plan_mirrors, plan_pois, three_way, verify_exact_changes,
)


SID = "10000000-0000-0000-0000-000000000001"
FLOOR = "20000000-0000-0000-0000-000000000001"


def row():
    return {"id": SID, "poi_type": "Uncc_Navme", "poi_name": "Old name",
            "poi_names": {"en": "Old name"}, "floor_id": FLOOR, "category_type": None,
            "description": None, "is_active": True,
            "pos_x": Decimal("187.65601893210035"), "pos_y": Decimal("0.5958944756160487"),
            "pos_z": Decimal("19.661969498128755"),
            "expected_pos_x": Decimal("187.6264543339333"), "expected_pos_y": Decimal("1.989"),
            "expected_pos_z": Decimal("19.251352141682215")}


def test_new_label_is_applied_without_reverting_independent_calibration():
    baseline = row()
    source = {**deepcopy(baseline), "poi_name": "110 Starbucks", "poi_names": {"en": "110 Starbucks"}}
    dest = {**deepcopy(baseline), "floor_id": None, "expected_pos_y": Decimal("0.36105082432699476")}
    plan = plan_pois([baseline], [source], [dest], expected=1)
    assert plan["patches"][SID] == {"poi_name": "110 Starbucks", "poi_names": {"en": "110 Starbucks"}}
    assert plan["resulting"][SID]["floor_id"] is None
    assert plan["resulting"][SID]["expected_pos_y"] == dest["expected_pos_y"]
    assert plan["calibration_guards"][SID] == {"source_expected_position": [baseline[k] for k in EXPECTED_POSITION]}
    assert plan["conflicts"] == []


def test_vector_rounding_never_restores_the_old_student_union_location():
    baseline = row()
    source = {**deepcopy(baseline), "pos_x": "187.656", "pos_y": "0.5959", "pos_z": "19.662"}
    dest = {**deepcopy(baseline), "pos_x": Decimal("185.7182"), "pos_y": Decimal("0.4923"), "pos_z": Decimal("-58.3732")}
    plan = plan_pois([baseline], [source], [dest], expected=1)
    assert plan["patches"] == {}
    assert plan["conflicts"] == []
    assert plan["ignored_rounding"] == [{"id": SID, "fields": list(POSITION)}]
    assert [plan["resulting"][SID][key] for key in POSITION] == [dest[key] for key in POSITION]
    assert plan["calibration_guards"][SID]["source_position"] == [baseline[key] for key in POSITION]


def test_material_position_change_is_atomic_and_cannot_overwrite_a_second_edit():
    baseline = row()
    source = {**deepcopy(baseline), "pos_x": Decimal("150")}
    dest = {**deepcopy(baseline), "pos_z": Decimal("-58")}
    plan = plan_pois([baseline], [source], [dest], expected=1)
    assert plan["patches"] == {}
    assert plan["conflicts"] == [{"id": SID, "fields": list(POSITION)}]
    assert plan["resulting"][SID]["pos_x"] == baseline["pos_x"]


def test_a_new_floor_clear_is_applied_but_previous_floor_calibration_survives():
    baseline = row()
    source = {**deepcopy(baseline), "floor_id": None}
    untouched = plan_pois([baseline], [source], [baseline], expected=1)
    assert untouched["patches"][SID] == {"floor_id": None}
    already_corrected = plan_pois([baseline], [source], [source], expected=1)
    assert already_corrected["patches"] == {}
    source_unchanged = plan_pois([baseline], [baseline], [source], expected=1)
    assert source_unchanged["patches"] == {}
    assert source_unchanged["resulting"][SID]["floor_id"] is None


def test_name_conflict_is_reported_instead_of_overwriting_destination():
    baseline = row()
    source = {**deepcopy(baseline), "poi_name": "Studio rename"}
    dest = {**deepcopy(baseline), "poi_name": "Independent rename"}
    result = plan_pois([baseline], [source], [dest], expected=1)
    assert result["conflicts"] == [{"id": SID, "fields": ["poi_name"]}]
    assert not result["patches"]


def test_repeated_reconciliation_is_idempotent_and_retains_guard_precision():
    baseline = row()
    source = {**deepcopy(baseline), "poi_name": "New label"}
    dest = {**deepcopy(baseline), "expected_pos_y": Decimal("0.33103212002851734")}
    first = plan_pois([baseline], [source], [dest], expected=1)
    second = plan_pois([baseline], [source], list(first["resulting"].values()), expected=1)
    assert second["patches"] == {}
    assert first["calibration_guards"] == second["calibration_guards"]
    assert loads(dumps(second["calibration_guards"])) == second["calibration_guards"]
    assert '187.6264543339333' in dumps(second["calibration_guards"])


def test_public_mirror_patch_keeps_geometry_and_expected_anchor_fields_untouched():
    canonical = {**row(), "poi_name": "New name", "floor_id": None}
    mirror = {"id": 7, "building_id": 3, "published": True, "source": "supabase",
              "name": "Old name", "category": "general", "floor": "Floor One", "description": None,
              "geom": "frozen-geometry", "model_x": 100, "model_y": 2, "model_z": 3,
              "extra": {"gmap_src_id": SID, "expected_pos_y": Decimal("0.33103212002851734"), "keep": True}}
    guard = {SID: {"source_position": [canonical[key] for key in POSITION]}}
    patches = plan_mirrors({SID: canonical}, [mirror], [], [], guard)
    patch = patches["7"]
    assert set(patch) == {"name", "floor", "extra"}
    assert patch["name"] == "New name" and patch["floor"] == "F1"
    assert patch["extra"]["expected_pos_y"] == mirror["extra"]["expected_pos_y"]
    assert patch["extra"]["keep"] is True
    assert "model_x" not in patch and "geom" not in patch
    after = [{**deepcopy(mirror), **patch}]
    verify_exact_changes([mirror], after, patches)
    assert plan_mirrors({SID: canonical}, after, [], [], guard) == {}


def test_missing_or_ambiguous_identity_and_orphan_floor_fail_closed():
    with pytest.raises(ReconcileError, match="duplicate_source_identity"):
        plan_pois([row(), row()], [row(), row()], [row(), row()], expected=2)
    canonical = row()
    mirror = {"id": 7, "building_id": 3, "published": True, "source": "supabase", "extra": {"gmap_src_id": SID}}
    with pytest.raises(ReconcileError, match="orphaned_floor"):
        plan_mirrors({SID: canonical}, [mirror], [], [], {})


def test_feature_planning_does_not_copy_unreviewed_login_or_access_fields():
    base = {"id": SID, "poi_type": "Uncc_Navme", "walkthrough_mode": "walkthrough_first",
            "matterport_navigation": False, "whitelabeled_url": None, "login_id": "keep-destination"}
    source = {**base, "walkthrough_mode": "ar_first", "matterport_navigation": True,
              "whitelabeled_url": "http://uncc.navme.space/", "login_id": "different-source"}
    plan = plan_features(base, source, base)
    assert set(plan["patch"]) == {"walkthrough_mode", "matterport_navigation", "whitelabeled_url"}
    assert "login_id" not in plan["patch"]


def test_decimals_compare_numerically_without_discarding_digits():
    original = loads('{"pos_x":187.65601893210035,"poi_type":"Uncc_Navme"}')
    incoming = normalise({"pos_x": "187.656018932100350", "poi_type": "Uncc_Navme"})
    assert original["pos_x"] == incoming["pos_x"]
    assert json.loads(dumps({"value": original["pos_x"]}), parse_float=Decimal)["value"] == original["pos_x"]


def test_verification_rejects_an_unplanned_coordinate_change():
    before = [{"id": 7, "name": "Old", "model_z": Decimal("-58.3732")}]
    after = [{"id": 7, "name": "New", "model_z": Decimal("19.662")}]
    with pytest.raises(ReconcileError, match="unexpected_target_row_change"):
        verify_exact_changes(before, after, {"7": {"name": "New"}})
