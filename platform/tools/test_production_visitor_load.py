"""Network-accounting and stop-gate tests; MockTransport makes no real requests."""
import asyncio
import gzip
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import httpx
from production_visitor_load import Run, allowed_base, public_path, route_evidence


def args(directory):
    return SimpleNamespace(base_url="http://127.0.0.1:18874", max_rps=30, max_mib=1,
        output=Path(directory)/"result.json", stop_file=None, soak_seconds=0, ramp_seconds=0,
        stages=[1], download_navmesh=False, include_server_route=False)


class Stream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        yield self.data


class HarnessTests(unittest.TestCase):
    def test_only_authorized_origin_or_explicit_loopback(self):
        self.assertEqual(allowed_base("https://wayfinding.navme.space/"), "https://wayfinding.navme.space")
        for value in ["https://example.com", "https://user:password@wayfinding.navme.space",
                      "https://wayfinding.navme.space?token=private", "http://127.0.0.1:18874"]:
            with self.assertRaises(ValueError):
                allowed_base(value)
        self.assertEqual(allowed_base("http://127.0.0.1:18874", True), "http://127.0.0.1:18874")

    def test_public_identifiers_are_not_needed_in_aggregate_paths(self):
        self.assertEqual(public_path("/api/building/camera-viewpoints/public-location-id"),
                         "/api/building/camera-viewpoints/:location_id")

    def test_server_diagnostic_rejects_trivial_or_invalid_routes(self):
        for route in [{"length_m": 0, "nodes": ["a"]}, {"length_m": 6, "nodes": ["a"]},
                      {"length_m": 5, "nodes": ["a", "b"]},
                      {"length_m": float("nan"), "nodes": ["a", "b"]}]:
            self.assertIsNone(route_evidence(route))
        evidence = route_evidence({"length_m": 8, "nodes": ["a", "b"]})
        self.assertEqual(evidence["length_m"], 8)
        self.assertEqual(evidence["nodes"], 2)
        self.assertEqual(len(evidence["response_sha256"]), 64)

    def test_gzip_encoded_body_is_counted_separately_from_decoded_payload(self):
        async def verify():
            body = b"a" * 10000
            encoded = gzip.compress(body)
            async def serve(request):
                return httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=Stream(encoded))
            with TemporaryDirectory() as directory:
                run = Run(args(directory))
                async with httpx.AsyncClient(base_url=run.args.base_url, transport=httpx.MockTransport(serve)) as client:
                    run.client = client
                    response = await run.request("fixture", "/fixture", phase="unit")
                    self.assertEqual(response.content, body)
                    self.assertEqual(run.samples[0]["encoded_response_body_bytes"], len(encoded))
                    self.assertEqual(run.samples[0]["decoded_response_body_bytes"], len(body))
        asyncio.run(verify())

    def test_one_failure_in_twenty_requests_stops_new_work(self):
        async def verify():
            counter = 0
            async def serve(request):
                nonlocal counter
                counter += 1
                return httpx.Response(503 if counter == 20 else 200,
                                      json={"detail": "database unavailable"} if counter == 20 else {"ok": True})
            with TemporaryDirectory() as directory:
                run = Run(args(directory))
                async with httpx.AsyncClient(base_url=run.args.base_url, transport=httpx.MockTransport(serve)) as client:
                    run.client = client
                    for _ in range(20):
                        await run.request("fixture", "/fixture", phase="unit")
                    self.assertTrue(run.stop.is_set())
                    self.assertEqual(run.samples[-1]["layer"], "database")
                    self.assertIsNone(await run.request("fixture", "/fixture", phase="unit"))
                    self.assertEqual(counter, 20)
        asyncio.run(verify())

    def test_recovery_health_failure_prevents_stage_pass(self):
        async def verify():
            async def serve(request):
                return httpx.Response(503 if request.url.path == "/api/health" else 200, json={"ok": True})
            with TemporaryDirectory() as directory:
                run = Run(args(directory)); run.bootstrap=[]; run.poi_ids=["public-fixture"]
                async with httpx.AsyncClient(base_url=run.args.base_url, transport=httpx.MockTransport(serve)) as client:
                    run.client = client
                    stage = await run.stage(1)
                    self.assertFalse(stage["completed_without_stop"])
                    self.assertEqual(run.reason, "recovery_readiness_failed")
        asyncio.run(verify())

    def test_a_small_failed_stage_cannot_escalate_before_twenty_samples(self):
        async def verify():
            async def serve(request):
                return httpx.Response(500 if request.url.path == "/fixture" else 200, json={"ok": True})
            with TemporaryDirectory() as directory:
                run = Run(args(directory)); run.bootstrap=[("fixture", "/fixture", (200,))]; run.poi_ids=["public-fixture"]
                async with httpx.AsyncClient(base_url=run.args.base_url, transport=httpx.MockTransport(serve)) as client:
                    run.client = client
                    stage = await run.stage(1)
                    self.assertFalse(stage["completed_without_stop"])
                    self.assertEqual(run.reason, "stage_failure_rate_gate")
        asyncio.run(verify())


if __name__ == "__main__":
    unittest.main()
