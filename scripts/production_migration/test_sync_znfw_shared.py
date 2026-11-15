"""Verify preservation and relationship safeguards for the one-way sync."""
from sync_znfw_shared import filter_foreign_keys, plan_table
import sync_znfw_shared as sync_module


def table(name="example", primary=("id",), columns=("id", "email", "password")):
    return {"name": name, "primary_keys": list(primary),
            "columns": [{"column_name": column} for column in columns]}


def test_changed_password_and_extra_destination_columns_are_preserved():
    result = plan_table(table(), [(1, {"id": "same", "email": "a", "password": "source"}),
                                  (2, {"id": "new", "email": "b", "password": "new"})],
                        [{"id": "same", "email": "a", "password": "destination", "extra": "keep"}], [("email",)])
    assert result["candidates"] == [2]
    assert result["conflicts"][0]["different_columns"] == ["password"]
    assert result["matching_primary_keys"] == 1


def test_new_primary_id_cannot_duplicate_existing_business_identity():
    result = plan_table(table(), [(1, {"id": "source", "email": "same"})],
                        [{"id": "destination", "email": "same"}], [("email",)])
    assert result["candidates"] == []
    assert result["conflicts"][0]["reason"] == "existing_natural_key"


def test_nullable_unique_keys_allow_multiple_nulls():
    result = plan_table(table(), [(1, {"id": "one", "email": None}), (2, {"id": "two", "email": None})], [], [("email",)])
    assert result["candidates"] == [1, 2]
    assert not result["blockers"]


def test_primary_key_collision_on_independent_integer_events_never_overwrites():
    result = plan_table(table(columns=("id", "session_key")), [(1, {"id": 1, "session_key": "source"})],
                        [{"id": 1, "session_key": "destination"}], [])
    assert result["candidates"] == []
    assert result["conflicts"][0]["different_columns"] == ["session_key"]


def test_no_primary_key_uses_multiset_equality_and_is_idempotent():
    example = table(primary=(), columns=("id",))
    rows = [(1, {"id": "same"}), (2, {"id": "same"}), (3, {"id": "new"})]
    result = plan_table(example, rows, [{"id": "same"}], [])
    assert result["candidates"] == [2, 3]
    assert plan_table(example, rows, [{"id": "same"}, {"id": "same"}, {"id": "new"}], [])["candidates"] == []


def test_duplicate_source_keys_block_apply():
    result = plan_table(table(), [(1, {"id": 1}), (2, {"id": 1})], [], [])
    assert result["blockers"][0]["reason"] == "source_invalid_or_duplicate_primary_key"


def test_missing_skipped_parent_withholds_child_and_grandchild():
    tables = [table("parent", columns=("id", "email")), table("child", columns=("id", "parent_id")),
              table("grandchild", columns=("id", "child_id"))]
    constraints = [{"type": "u", "table": "parent", "columns": ["email"]},
                   {"type": "f", "table": "child", "columns": ["parent_id"], "definition": "FOREIGN KEY (parent_id) REFERENCES parent(id)"},
                   {"type": "f", "table": "grandchild", "columns": ["child_id"], "definition": "FOREIGN KEY (child_id) REFERENCES child(id)"}]
    config = {"tables": tables, "source_metadata": {"constraints": constraints}, "destination_metadata": {"constraints": []}}
    source = {"parent": [(1, {"id": "source", "email": "same"})],
              "child": [(1, {"id": "child", "parent_id": "source"})],
              "grandchild": [(1, {"id": "grandchild", "child_id": "child"})]}
    destination = {"parent": [{"id": "destination", "email": "same"}], "child": [], "grandchild": []}
    plans = {entry["name"]: plan_table(entry, source[entry["name"]], destination[entry["name"]],
                                      [("email",)] if entry["name"] == "parent" else []) for entry in tables}
    filter_foreign_keys(config, source, destination, plans)
    assert all(not plan["candidates"] for plan in plans.values())
    assert plans["grandchild"]["conflicts"][0]["reason"] == "missing_parent_after_preserving_destination"


def test_same_id_parent_in_different_tenant_withholds_child():
    tables = [table("parent", columns=("id", "poi_type")), table("child", columns=("id", "parent_id"))]
    config = {"tables": tables, "source_metadata": {"constraints": [
        {"type": "f", "table": "child", "columns": ["parent_id"], "definition": "FOREIGN KEY (parent_id) REFERENCES parent(id)"}]},
        "destination_metadata": {"constraints": []}}
    source = {"parent": [(1, {"id": "same", "poi_type": "source"})], "child": [(1, {"id": "child", "parent_id": "same"})]}
    destination = {"parent": [{"id": "same", "poi_type": "destination"}], "child": []}
    plans = {entry["name"]: plan_table(entry, source[entry["name"]], destination[entry["name"]], []) for entry in tables}
    filter_foreign_keys(config, source, destination, plans)
    assert not plans["child"]["candidates"]
    assert plans["child"]["conflicts"][0]["reason"] == "parent_identity_conflict"


def test_existing_report_is_rejected_before_any_database_work(tmp_path, monkeypatch):
    report = tmp_path / "existing.json"
    report.write_text("keep")
    monkeypatch.setattr("sys.argv", ["sync", "--config", "unused", "--report", str(report), "--apply"])
    monkeypatch.setattr(sync_module, "sync", lambda *args: (_ for _ in ()).throw(AssertionError("must not connect")))
    assert sync_module.main() == 1
    assert report.read_text() == "keep"


def test_postcommit_report_error_is_never_reported_as_uncommitted(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["sync", "--config", "unused", "--report", str(tmp_path / "report.json")])
    def fail_after_commit(*args):
        raise sync_module.CommittedReportError("committed")
    monkeypatch.setattr(sync_module, "sync", fail_after_commit)
    assert sync_module.main() == 2
    import json
    assert json.loads(capsys.readouterr().out)["committed"] is True


def test_credential_only_sync_does_not_check_unselected_poi_triggers():
    assert sync_module.gmap_collisions(None, {}, {}, {"navme_project_api_credentials": {"candidates": [1, 2]}}) == []
