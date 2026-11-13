import pytest
from verify_vm_additional import parse_sequence_sets


def test_sequence_initial_state_and_called_state_are_both_preserved():
    result = parse_sequence_sets("SELECT pg_catalog.setval('public.used_seq', 23, true);\n"
                                 "SELECT pg_catalog.setval('public.empty_seq', 1, false);", 2)
    assert result["public.used_seq"] == {"last_value": 23, "is_called": True}
    assert result["public.empty_seq"] == {"last_value": 1, "is_called": False}


def test_missing_or_unparsed_sequence_cannot_silently_pass():
    with pytest.raises(ValueError):
        parse_sequence_sets("SELECT pg_catalog.setval('public.used_seq', 23, true);", 2)
