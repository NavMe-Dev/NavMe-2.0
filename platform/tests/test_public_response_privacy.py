"""Privacy preflight must find privileged values without recording their contents."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

MODULE = Path(__file__).resolve().parents[1] / 'tools/public_privacy_preflight.py'
spec = importlib.util.spec_from_file_location('public_privacy_preflight', MODULE)
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


def token(role):
    payload = base64.urlsafe_b64encode(json.dumps({'role': role}).encode()).decode().rstrip('=')
    return 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.c2lnbmF0dXJl'


def test_nested_privileged_values_are_reported_without_echoing_them():
    privileged = token('service_role')
    secret = 'sb_secret_private-test-value'
    uri = 'postgresql+psycopg://private-user:private-password@db.example/private'
    result = privacy.findings({'nested': [{'value': privileged}, {'value': secret}, {'value': uri}],
                               privileged: {'password_hash': 'private-hash'}})
    assert len(result) >= 4
    encoded = json.dumps(result)
    for private in (privileged, secret, uri, 'private-hash', 'private-password'):
        assert private not in encoded


def test_public_client_metadata_is_allowed_but_draft_content_is_rejected():
    assert privacy.findings({'sdk_key_configured': True, 'anonymous_key': token('anon'),
                             'access': {'pin_required': False}}) == []
    assert privacy.findings({'pois': [{'published': False}]})
    assert privacy.findings({'panels': [{'draft': True}]})


def test_mutation_guard_probe_refuses_production_origin_before_network_access():
    result = subprocess.run([sys.executable, str(MODULE), '--base', 'https://wayfinding.navme.space',
                             '--probe-read-only-guard'], capture_output=True, text=True)
    assert result.returncode == 2
    assert 'only against confirmed loopback staging' in result.stderr
