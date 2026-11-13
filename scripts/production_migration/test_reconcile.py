"""Identity collisions must never disappear behind SQL conflict handling."""
from reconcile import compare


def plan(source, destination, policy=None):
    return compare({"tables": {"public.buildings": {"rows": source}}},
                   {"tables": {"public.buildings": {"rows": destination}}},
                   {"public.buildings": policy or {"identity": ["slug"], "primary_key": ["id"]}})


def outcomes(result):
    return [row["outcome"] for row in result["tables"]["public.buildings"]["records"]]


def test_same_integer_id_does_not_imply_same_building():
    result = plan([{"id": 1, "slug": "new"}], [{"id": 1, "slug": "existing"}])
    assert outcomes(result) == ["primary_key_collision_requires_remapping"]
    assert result["proposed_updates"] == result["proposed_deletions"] == 0
    assert not result["executable"]


def test_same_business_identity_with_different_content_preserves_destination():
    result = plan([{"id": 1, "slug": "same", "name": "Old"}],
                  [{"id": 2, "slug": "same", "name": "Edited"}])
    assert outcomes(result) == ["conflict_preserve_destination"]


def test_identical_business_record_with_different_primary_key_is_match():
    result = plan([{"id": 1, "slug": "same"}], [{"id": 2, "slug": "same"}])
    assert outcomes(result) == ["matching_preserve_destination"]


def test_duplicates_and_missing_identity_are_explicitly_rejected():
    result = plan([{"id": 1, "slug": "same"}, {"id": 2, "slug": "same"}, {"id": 3}], [])
    assert outcomes(result) == ["duplicate_business_identity", "duplicate_business_identity", "missing_business_identity"]


def test_new_record_does_not_bypass_foreign_key_review():
    result = plan([{"id": 1, "slug": "new", "venue_id": 999}], [])
    assert outcomes(result) == ["insertion_candidate_requires_relationship_review"]
    assert not result["production_approved"]


def test_unknown_and_shared_tables_are_never_automatically_merged():
    result = compare({"tables": {"public.spatial_spaces": {"rows": [{"id": 1}]}}},
                     {"tables": {"public.spatial_spaces": {"rows": [{"id": 2}]}}}, {})
    assert result["tables"]["public.spatial_spaces"]["category"] == "unsafe to merge automatically"
    assert "records" in result["tables"]["public.spatial_spaces"]


def test_reports_contain_digests_not_private_record_values():
    result = plan([{"id": 1, "slug": "secret-slug", "password_hash": "sensitive"}], [])
    import json
    encoded = json.dumps(result)
    assert "secret-slug" not in encoded and "sensitive" not in encoded
