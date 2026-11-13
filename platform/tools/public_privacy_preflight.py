"""Read-only public-response privacy checks; optional localhost-only guard probes.

Never logs response bodies or secret values. Mutation-method probes require an
explicit flag and loopback host; production URLs receive GET requests only.
"""
import argparse
import base64
import datetime
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

PRIVATE_KEYS = {
    'password', 'passwordhash', 'encryptedpassword', 'jwtsecret', 'bootstrapsecret',
    'servicerolekey', 'supabaseservicerolekey', 'databaseurl', 'postgresurl',
    'pgpassword', 'twinpin', 'twinpinhash', 'refreshtoken', 'users', 'navmeusers',
    'accounts', 'navmeaccounts', 'logins', 'navmelogins',
}
TOKEN = re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+')
DATABASE_URI = re.compile(r'postgres(?:ql)?(?:\+[^:]+)?://', re.I)
PASSWORD_HASH = re.compile(r'\$2[aby]\$\d\d\$[./A-Za-z0-9]{40,}')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect())


def findings(value, location='$'):
    out = []
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = re.sub('[^a-z0-9]', '', str(key).lower())
            shown_key = str(key)
            if len(shown_key) > 80 or TOKEN.search(shown_key) or 'sb_secret_' in shown_key.lower() or DATABASE_URI.search(shown_key):
                shown_key = '[redacted key]'
            child = location + '.' + shown_key
            if normalized in PRIVATE_KEYS:
                out.append({'path': child, 'issue': 'private field name'})
            if key == 'published' and item is False or key == 'draft' and item is True:
                out.append({'path': child, 'issue': 'explicit unpublished content'})
            out.extend(findings(item, child))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            out.extend(findings(item, f'{location}[{index}]'))
    elif isinstance(value, str):
        if DATABASE_URI.search(value) or PASSWORD_HASH.search(value) or 'sb_secret_' in value.lower():
            out.append({'path': location, 'issue': 'credential-shaped value'})
        for token in TOKEN.findall(value):
            try:
                segment = token.split('.')[1]
                payload = json.loads(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4)))
                if payload.get('role') == 'service_role':
                    out.append({'path': location, 'issue': 'privileged service-role token'})
            except (ValueError, UnicodeDecodeError):
                pass
    return out


def request(base, endpoint, method='GET', headers=None):
    body = b'{}' if method not in ('GET', 'HEAD') else None
    req = urllib.request.Request(base + endpoint, data=body, method=method,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        response = OPENER.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('Response exceeds bounded inspection size')
        try:
            value = json.loads(raw)
        except ValueError:
            value = raw.decode('utf-8', 'replace')
        return response.status, value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:8782')
    parser.add_argument('--output', type=Path, default=Path('platform/var/production-migration/browser/shadow-gcu-v5-metal/privacy-preflight.json'))
    parser.add_argument('--probe-read-only-guard', action='store_true')
    args = parser.parse_args()
    base = args.base.rstrip('/')
    if args.probe_read_only_guard and urllib.parse.urlparse(base).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('Mutation-method guard probes are allowed only against confirmed loopback staging')
    checks = []
    guard_confirmed = False
    endpoints = [
        ('/api/v1/public/venues/all/manifest.json', 200),
        ('/api/v1/public/buildings/gcu/data/config.json', 200),
        ('/api/v1/public/buildings/gcu/data/pois.json', 200),
        ('/api/v1/public/dashboard/buildings/gcu/navme-pois', 200),
        ('/api/v1/public/dashboard/buildings/gcu/navme-categories', 200),
        ('/api/v1/public/buildings/gcu/navme-floors', 200),
        ('/api/v1/public/buildings/gcu/translations', 200),
        ('/api/v1/public/buildings/gcu/ar-experience-ref', 200),
        ('/api/v1/public/buildings/gcu/matterport', 200),
        ('/api/v1/public/buildings/gcu/shops', 200),
        ('/api/v1/public/config', 200),
        ('/api/v1/admin/buildings', 401),
        ('/api/v1/auth/me', 401),
        ('/api/v1/admin/buildings/gcu/pois', 401),
        ('/api/v1/public/venues/navme-qa-nonexistent/manifest.json', 404),
        ('/api/v1/public/buildings/gcu/data/%2e%2e/%2e%2e/%2e%2e/.env', 404),
    ]
    for endpoint, expected in endpoints:
        status, value = request(base, endpoint)
        problems = findings(value)
        if endpoint == '/api/v1/public/config':
            guard_confirmed = status == 200 and isinstance(value, dict) and value.get('read_only') is True
            if args.probe_read_only_guard and not guard_confirmed:
                problems.append({'issue': 'read-only mode must be explicitly confirmed before mutation-method probes'})
        if endpoint.endswith('/navme-pois') and isinstance(value, list):
            allowed = {'id', 'name', 'floor', 'category', 'x', 'y', 'z', 'expected_pos_x', 'expected_pos_y', 'expected_pos_z'}
            if any(set(row) - allowed for row in value):
                problems.append({'issue': 'unexpected mirrored POI response field'})
        checks.append({'method': 'GET', 'path': endpoint, 'status': status, 'expected': expected,
                       'rows': len(value) if isinstance(value, list) else None, 'privacy_findings': problems,
                       'result': 'PASS' if status == expected and not problems else 'FAIL'})
    for endpoint in ['/api/v1/admin/buildings', '/api/v1/auth/me']:
        status, value = request(base, endpoint, headers={'Authorization': 'Bearer invalid-qa-token'})
        checks.append({'method': 'GET', 'path': endpoint, 'identity': 'invalid bearer token', 'status': status,
                       'expected': 401, 'result': 'PASS' if status == 401 and not findings(value) else 'FAIL'})
    if args.probe_read_only_guard and guard_confirmed:
        for method, endpoint in [
            ('PATCH', '/api/v1/admin/buildings/gcu'),
            ('DELETE', '/api/v1/admin/buildings/gcu'),
            ('POST', '/api/v1/admin/buildings/gcu/pois'),
            ('POST', '/api/v1/auth/bootstrap-admin'),
            ('POST', '/api/v1/public/buildings/gcu/feedback'),
            ('POST', '/api/v1/public/dashboard/buildings/gcu/sync-pois'),
        ]:
            status, value = request(base, endpoint, method)
            ok = status == 503 and isinstance(value, dict) and value.get('detail') == 'application is read-only'
            checks.append({'method': method, 'path': endpoint, 'status': status, 'expected': 503,
                           'result': 'PASS' if ok else 'FAIL'})
    result = {'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'base': base, 'scope': 'Public payload privacy, authorization, and optional loopback read-only guard',
              'response_bodies_saved': False, 'read_only_guard_confirmed': guard_confirmed, 'checks': checks,
              'summary': {'executed': len(checks), 'passed': sum(c['result'] == 'PASS' for c in checks),
                          'failed': sum(c['result'] != 'PASS' for c in checks)}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return 1 if result['summary']['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
