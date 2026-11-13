"""Bounded GET-only critical-public-API check; never saves response bodies.

This small four-client, two-round check is not a load test or capacity claim.
Run after browser acceptance, without concurrent heavyweight browser sessions.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.error
import urllib.request


PATHS = (
    '/api/v1/public/venues/all/manifest.json',
    '/api/v1/public/buildings/gcu/data/config.json',
    '/api/v1/public/buildings/gcu/data/pois.json',
    # Published floor geometry exceeds this tool's 2 MB inspection bound; the
    # full viewer checks exercise it. Use bounded live floor metadata here.
    '/api/v1/public/buildings/gcu/navme-floors',
    '/api/v1/public/buildings/gcu/data/nav_graph.json',
    '/api/v1/public/dashboard/buildings/gcu/navme-pois',
    '/api/v1/public/dashboard/buildings/gcu/navme-categories',
    '/api/v1/public/buildings/gcu/translations',
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inspect(job):
    base, round_number, path = job
    started = time.perf_counter()
    result = {'round': round_number, 'method': 'GET', 'path': path}
    try:
        request = urllib.request.Request(base + path, method='GET')
        opener = urllib.request.build_opener(NoRedirect())
        try:
            response = opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result['status'] = response.status
            raw = response.read(2_000_001)
            result['bytes'] = len(raw)
            if len(raw) > 2_000_000:
                result['error'] = 'Response exceeded bounded inspection size'
            elif response.status == 200:
                try:
                    json.loads(raw)
                    result['valid_json'] = True
                except (ValueError, UnicodeDecodeError):
                    result['error'] = 'Response is not valid JSON'
    except Exception as error:
        # Only record exception type; exception strings may include URL details.
        result['error'] = type(error).__name__
    result['elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
    result['result'] = 'PASS' if result.get('status') == 200 and result.get('valid_json') else 'FAIL'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:8782')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    base = args.base.rstrip('/')
    jobs = [(base, round_number, path) for round_number in (1, 2) for path in PATHS]
    with ThreadPoolExecutor(max_workers=4) as workers:
        checks = list(workers.map(inspect, jobs))
    report = {
        'recordedAt': datetime.now(timezone.utc).isoformat(), 'base': base,
        'scope': 'Bounded critical public GETs after browser checks; not a load test',
        'concurrency': 4, 'rounds': 2, 'response_bodies_saved': False, 'checks': checks,
        'summary': {'executed': len(checks), 'passed': sum(c['result'] == 'PASS' for c in checks),
                    'failed': sum(c['result'] == 'FAIL' for c in checks),
                    'http_503': sum(c.get('status') == 503 for c in checks)},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 1 if report['summary']['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
