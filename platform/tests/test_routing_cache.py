"""Publication cache correctness, bounded construction and cross-request isolation."""
from concurrent.futures import ThreadPoolExecutor
import json
from threading import Event
import time
from types import MappingProxyType
from unittest.mock import patch

import networkx as nx
import pytest

from wayfinding_api.services import bundle_storage, navgraph, routing_cache


@pytest.fixture
def publication(monkeypatch):
    geo = {"model_to_epsg3857_affine": [[1, 0, 0], [0, 1, 0]]}
    transform = navgraph.GeoT(geo)
    nodes = [{"id": name, "x": x, "y": 0, "z": z, "floor": floor,
              "kind": "sweep", "label": name, "lonlat": list(transform.ll(x, 0))}
             for name, x, z, floor in [("a", 0, 0, "F1"), ("b", 4, 0, "F1"), ("c", 8, 0, "F1"),
                                       ("d", 8, 3, "F2"), ("e", 0, 3, "F2"), ("island", 20, 0, "F1")]]
    edges = [{"u": u, "v": v, "length": length, "step_free": step_free, **extra}
             for u, v, length, step_free, extra in [
                 ("a", "b", 4, True, {}), ("b", "c", 4, True, {}),
                 ("c", "d", 3, False, {"stairs": "stair", "dz": 3}),
                 ("a", "e", 28, True, {"source": "elevator", "elevator": "lift", "floor_delta": 1, "dz": 3}),
                 ("e", "d", 8, True, {})]]
    nav = {"nodes": nodes, "edges": edges, "cost_model": {"stair_penalty_m": 15, "walk_speed_mps": 1.2,
                                                                 "elevator_wait_s": 20, "elevator_per_floor_s": 4}}
    mesh = {"floors": {"F1": {"verts": [[0, -1], [8, -1], [8, 1], [0, 1]],
                                "tris": [[0, 1, 2], [0, 2, 3]]}}}
    files = {"nav_graph.json": nav, "pois.json": {"pois": [{"id": n["id"], "nearest_node": n["id"]} for n in nodes]},
             "navmesh.json": mesh}
    reads = []

    def read(root, slug, version, name):
        reads.append((str(root), slug, version, name))
        if name not in files:
            raise FileNotFoundError(name)
        return json.dumps(files[name]).encode()

    monkeypatch.setattr(bundle_storage, "read_bundle_file", read)
    return nav, mesh, geo, files, reads


@pytest.mark.parametrize("a,b,step_free", [("a", "d", False), ("a", "d", True), ("d", "a", False),
                                          ("a", "c", False), ("a", "c", True), ("b", "b", True),
                                          ("a", "island", False), ("missing", "a", True)])
def test_prepared_route_exactly_matches_uncached(publication, tmp_path, a, b, step_free):
    nav, mesh, geo, _, _ = publication
    expected = navgraph.route(nav, a, b, step_free, georef=geo, navmesh=mesh)
    cached = routing_cache.PublishedRoutingCache().get_for_publication(tmp_path, "fixture", 1)
    assert cached.route(a, b, step_free, georef=geo) == expected
    if a == "a" and b == "d":
        result = cached.route(a, b, step_free, georef=geo)
        assert result["nodes"] == (["a", "e", "d"] if step_free else ["a", "b", "c", "d"])
        assert result["length_m"] == (36 if step_free else 11)
        assert result["eta_s"] == (31 if step_free else 15)


def test_warm_publication_reads_parses_and_builds_only_once(publication, tmp_path):
    cache = routing_cache.PublishedRoutingCache()
    with patch.object(navgraph, "build", wraps=navgraph.build) as builds, \
         patch.object(routing_cache.json, "loads", wraps=json.loads) as parses:
        entries = [cache.get_for_publication(tmp_path, "fixture", 1) for _ in range(6)]
        for entry in entries:
            entry.route("a", "d")
            entry.route("a", "d", True)
    assert all(entry is entries[0] for entry in entries)
    assert builds.call_count == 2
    assert parses.call_count == 3
    assert len(publication[-1]) == 3
    assert cache.cache_info()["hits"] == 5


def test_shared_publication_and_responses_are_isolated(publication, tmp_path):
    cached = routing_cache.PublishedRoutingCache().get_for_publication(tmp_path, "fixture", 1)
    graph = cached.graphs.regular
    with pytest.raises(nx.NetworkXError):
        graph.add_node("visitor")
    with pytest.raises(TypeError):
        graph.nodes["a"]["x"] = 5
    with pytest.raises(TypeError):
        graph.nodes["a"]["lonlat"][0] = 5
    with pytest.raises(TypeError):
        graph.edges["a", "b"]["weight"] = 0
    with pytest.raises(TypeError):
        cached.navmesh["floors"]["F1"]["verts"].append([30, 30])
    with pytest.raises(TypeError):
        cached.poi_nodes["a"] = "other"
    with pytest.raises(TypeError):
        cached.graphs.cost_model["stair_penalty_m"] = 0
    expected = cached.route("a", "d")
    changed = cached.route("a", "d")
    changed["nodes"].append("visitor")
    changed["geometry"]["coordinates"][0][0] = 100
    changed["legs"][0]["lonlat"][0] = 200
    assert cached.route("a", "d") == expected


def test_frozen_json_array_keeps_list_equality_for_navmesh_funnel():
    value = navgraph.immutable([1, 2])
    assert value == [1, 2]
    assert value != (1, 2)
    assert (1, 2) != value
    assert json.loads(json.dumps(value)) == [1, 2]


def test_simultaneous_routes_keep_all_search_state_local(publication, tmp_path):
    cached = routing_cache.PublishedRoutingCache().get_for_publication(tmp_path, "fixture", 1)
    cases = [("a", "d", False), ("a", "d", True), ("d", "a", False), ("a", "island", False)] * 4
    expected = [cached.route(*case, georef=publication[2]) for case in cases]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda case: cached.route(*case, georef=publication[2]), cases))
    assert results == expected


def test_missing_optional_navmesh_keeps_sweep_route(publication, tmp_path):
    publication[3].pop("navmesh.json")
    cached = routing_cache.PublishedRoutingCache().get_for_publication(tmp_path, "fixture", 1)
    assert cached.navmesh is None
    assert cached.route("a", "c") == navgraph.route(publication[0], "a", "c")


def _entry(bytes_=10):
    return routing_cache.PublishedRouting(MappingProxyType({}), None, None, bytes_)


def _wait_for(predicate):
    deadline = time.monotonic() + 2
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("Concurrent cache test did not reach its expected state")
        time.sleep(0.002)


def test_same_cold_key_coalesces_concurrent_construction(tmp_path):
    started, release = Event(), Event()
    calls = []

    def load(*args):
        calls.append(args)
        started.set()
        assert release.wait(2)
        return _entry()

    cache = routing_cache.PublishedRoutingCache(loader=load)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(cache.get_for_publication, tmp_path, "fixture", 1) for _ in range(8)]
        assert started.wait(2)
        _wait_for(lambda: cache.cache_info()["waits"] == 7)
        release.set()
        entries = [future.result(timeout=2) for future in futures]
    assert len(calls) == 1
    assert all(entry is entries[0] for entry in entries)
    assert cache.cache_info()["pending"] == 0


def test_different_buildings_do_not_wait_on_a_global_load_lock(tmp_path):
    started, release = Event(), Event()

    def load(root, slug, version):
        if slug == "slow":
            started.set()
            assert release.wait(2)
        return _entry()

    cache = routing_cache.PublishedRoutingCache(loader=load)
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(cache.get_for_publication, tmp_path / "slow", "slow", 1)
        assert started.wait(2)
        try:
            assert pool.submit(cache.get_for_publication, tmp_path / "fast", "fast", 1).result(timeout=1)
        finally:
            release.set()
        slow.result(timeout=2)


def test_waiter_timeout_does_not_cancel_or_duplicate_leader(tmp_path):
    started, release = Event(), Event()

    def load(*args):
        started.set()
        assert release.wait(2)
        return _entry()

    cache = routing_cache.PublishedRoutingCache(loader=load, wait_timeout=0.02)
    with ThreadPoolExecutor(max_workers=1) as pool:
        leader = pool.submit(cache.get_for_publication, tmp_path, "fixture", 1)
        assert started.wait(2)
        try:
            with pytest.raises(routing_cache.RoutingCacheTimeout):
                cache.get_for_publication(tmp_path, "fixture", 1)
            assert cache.cache_info()["builds"] == 1
            assert cache.cache_info()["pending"] == 1
        finally:
            release.set()
        entry = leader.result(timeout=2)
    assert cache.get_for_publication(tmp_path, "fixture", 1) is entry


def test_distinct_pending_builds_are_bounded(tmp_path):
    started, release = Event(), Event()

    def load(*args):
        started.set()
        assert release.wait(2)
        return _entry()

    cache = routing_cache.PublishedRoutingCache(loader=load, max_pending=1)
    with ThreadPoolExecutor(max_workers=1) as pool:
        leader = pool.submit(cache.get_for_publication, tmp_path, "first", 1)
        assert started.wait(2)
        try:
            with pytest.raises(routing_cache.RoutingCacheTimeout):
                cache.get_for_publication(tmp_path, "second", 1)
        finally:
            release.set()
        leader.result(timeout=2)


@pytest.mark.parametrize("failure", [FileNotFoundError("missing fixture publication"), TimeoutError("source read timed out")])
def test_failed_load_releases_all_waiters_and_next_request_can_retry(tmp_path, failure):
    started, release = Event(), Event()
    calls = []

    def load(*args):
        calls.append(args)
        if len(calls) == 1:
            started.set()
            assert release.wait(2)
            raise failure
        return _entry()

    cache = routing_cache.PublishedRoutingCache(loader=load)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(cache.get_for_publication, tmp_path, "fixture", 1) for _ in range(3)]
        assert started.wait(2)
        _wait_for(lambda: cache.cache_info()["waits"] == 2)
        release.set()
        for future in futures:
            with pytest.raises(type(failure)) as error:
                future.result(timeout=2)
            assert type(error.value) is type(failure)
    assert cache.cache_info()["pending"] == 0
    assert cache.cache_info()["entries"] == 0
    assert cache.get_for_publication(tmp_path, "fixture", 1)
    assert len(calls) == 2


@pytest.mark.parametrize("failure", [json.JSONDecodeError("invalid", "x", 0), ValueError("invalid graph")])
def test_parse_and_build_errors_do_not_poison_key(tmp_path, failure):
    calls = []

    def load(*args):
        calls.append(args)
        if len(calls) == 1:
            raise failure
        return _entry()

    cache = routing_cache.PublishedRoutingCache(loader=load)
    with pytest.raises(type(failure)):
        cache.get_for_publication(tmp_path, "fixture", 1)
    assert cache.get_for_publication(tmp_path, "fixture", 1)
    assert cache.cache_info()["failures"] == 1


def test_lru_and_byte_budget_are_bounded(tmp_path):
    cache = routing_cache.PublishedRoutingCache(max_entries=2, max_bytes=20, loader=lambda *args: _entry())
    first = cache.get_for_publication(tmp_path / "one", "one", 1)
    cache.get_for_publication(tmp_path / "two", "two", 1)
    assert cache.get_for_publication(tmp_path / "one", "one", 1) is first
    cache.get_for_publication(tmp_path / "three", "three", 1)
    assert cache.cache_info()["entries"] == 2
    assert cache.cache_info()["retained_bytes"] == 20
    assert cache.cache_info()["evictions"] == 1
    cache.get_for_publication(tmp_path / "two", "two", 1)
    assert cache.cache_info()["builds"] == 4


def test_oversized_entry_is_shared_but_not_retained(tmp_path):
    cache = routing_cache.PublishedRoutingCache(max_bytes=5, loader=lambda *args: _entry(10))
    assert cache.get_for_publication(tmp_path, "fixture", 1)
    assert cache.cache_info()["entries"] == 0
    assert cache.cache_info()["retained_bytes"] == 0
    assert cache.cache_info()["oversize"] == 1


def test_publication_version_and_storage_root_are_part_of_key(tmp_path):
    cache = routing_cache.PublishedRoutingCache(max_entries=4, loader=lambda *args: _entry())
    old = cache.get_for_publication(tmp_path / "published" / "v1", "fixture", 1)
    other = cache.get_for_publication(tmp_path / "other" / "v1", "fixture", 1)
    current = cache.get_for_publication(tmp_path / "published" / "v2", "fixture", 2)
    assert current is not old
    assert cache.get_for_publication(tmp_path / "other" / "v1", "fixture", 1) is other
    assert cache.cache_info()["entries"] == 2
    assert cache.cache_info()["evictions"] == 1
    assert cache.get_for_publication(tmp_path / "published" / "v1", "fixture", 1) is not old
