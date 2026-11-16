"""Bounded per-process routing state for immutable published building versions.

Only publication data is shared. A* queues, request parameters and response
containers remain local to each route. Authentication/publication lookup belongs
to the caller and must finish before this module is entered.
"""
from collections import OrderedDict
from collections.abc import Mapping
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass
import json
import logging
from pathlib import Path
import sys
from threading import Lock
import time

from . import bundle_storage, navgraph

logger = logging.getLogger(__name__)


class RoutingCacheTimeout(TimeoutError):
    """Another request is preparing routing data; retry without holding a DB connection."""


@dataclass(frozen=True)
class PublishedRouting:
    poi_nodes: Mapping
    graphs: navgraph.PreparedGraphs
    navmesh: object
    retained_bytes: int = 0

    def route(self, a, b, step_free=False, georef=None):
        return navgraph.route({}, a, b, step_free, georef=georef, navmesh=self.navmesh, prepared=self.graphs)


def _retained_size(*objects):
    """Conservative container accounting, with shared graph attributes counted once.

    Mapping proxies conceal their backing dictionaries from getsizeof. Include
    a conservative allowance for those tables rather than undercounting them.
    This is a cache-retention budget, not an assertion about whole-process RSS.
    """
    seen = set()

    def size(value):
        identity = id(value)
        if identity in seen:
            return 0
        seen.add(identity)
        result = sys.getsizeof(value)
        if isinstance(value, Mapping):
            result += 64 + 72 * len(value)
            result += sum(size(key) + size(item) for key, item in value.items())
        elif isinstance(value, (list, tuple)):
            result += sum(size(item) for item in value)
        return result

    return sum(size(value) for value in objects)


def _load_publication(root, slug, version):
    nav = json.loads(bundle_storage.read_bundle_file(root, slug, version, "nav_graph.json"))
    pois = json.loads(bundle_storage.read_bundle_file(root, slug, version, "pois.json"))["pois"]
    try:
        navmesh = navgraph.immutable(json.loads(bundle_storage.read_bundle_file(root, slug, version, "navmesh.json")))
    except FileNotFoundError:
        navmesh = None
    graphs = navgraph.prepare(nav)
    poi_nodes = navgraph.immutable({poi["id"]: poi["nearest_node"] for poi in pois})
    retained_bytes = _retained_size(poi_nodes, graphs.regular._node, graphs.regular._adj,
                                    graphs.step_free._node, graphs.step_free._adj, graphs.cost_model, navmesh)
    return PublishedRouting(poi_nodes, graphs, navmesh, retained_bytes)


class PublishedRoutingCache:
    def __init__(self, *, max_entries=2, max_bytes=96 * 1024 * 1024, max_pending=2, wait_timeout=15.0, loader=None):
        if max_entries < 1 or max_bytes < 1 or max_pending < 1 or wait_timeout <= 0:
            raise ValueError("Routing cache limits must be positive")
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.max_pending = max_pending
        self.wait_timeout = wait_timeout
        self._loader = loader
        self._lock = Lock()
        self._ready = OrderedDict()
        self._pending = {}
        self._bytes = 0
        self._stats = dict(hits=0, misses=0, waits=0, builds=0, failures=0, evictions=0, oversize=0, timeouts=0)

    def get_for_publication(self, root, slug, version):
        root = Path(root).resolve()
        key = (root, slug, version)
        with self._lock:
            if key in self._ready:
                self._stats["hits"] += 1
                self._ready.move_to_end(key)
                return self._ready[key]
            pending = self._pending.get(key)
            if pending is None:
                if len(self._pending) >= self.max_pending:
                    self._stats["timeouts"] += 1
                    raise RoutingCacheTimeout("Routing preparation capacity is busy")
                # A new current version cannot reuse the previous publication's
                # graph. Drop obsolete retained entries for this storage namespace.
                for old in list(self._ready):
                    if old[0].parent == root.parent and old[1] == slug and old[2] != version:
                        self._evict(old)
                pending = Future()
                self._pending[key] = pending
                self._stats["misses"] += 1
                self._stats["builds"] += 1
                leader = True
            else:
                self._stats["waits"] += 1
                leader = False

        if not leader:
            try:
                return pending.result(timeout=self.wait_timeout)
            except FutureTimeout:
                # Future.result also re-raises a loader's own TimeoutError.
                # Preserve that error consistently for leader and waiters.
                if pending.done():
                    return pending.result()
                with self._lock:
                    self._stats["timeouts"] += 1
                # A waiter timing out never cancels or restarts its leader.
                raise RoutingCacheTimeout("Routing preparation is still in progress") from None

        started = time.monotonic()
        try:
            result = (self._loader or _load_publication)(root, slug, version)
            with self._lock:
                if result.retained_bytes <= self.max_bytes:
                    while self._ready and (len(self._ready) >= self.max_entries
                                           or self._bytes + result.retained_bytes > self.max_bytes):
                        self._evict(next(iter(self._ready)))
                    self._ready[key] = result
                    self._bytes += result.retained_bytes
                else:
                    # A valid large publication still routes, but cannot consume
                    # an unbounded retained cache. Concurrent waiters share it.
                    self._stats["oversize"] += 1
                    logger.warning("Routing publication exceeds retained cache budget building=%s version=%s bytes=%s",
                                   slug, version, result.retained_bytes)
                del self._pending[key]
                pending.set_result(result)
            logger.info("Routing publication prepared building=%s version=%s seconds=%.3f retained_bytes=%s",
                        slug, version, time.monotonic() - started, result.retained_bytes)
            return result
        except BaseException as error:
            with self._lock:
                self._stats["failures"] += 1
                self._pending.pop(key, None)
                pending.set_exception(error)
            raise

    def _evict(self, key):
        self._bytes -= self._ready.pop(key).retained_bytes
        self._stats["evictions"] += 1

    def cache_info(self):
        with self._lock:
            return {**self._stats, "entries": len(self._ready), "pending": len(self._pending),
                    "retained_bytes": self._bytes, "max_bytes": self.max_bytes}

    def clear(self):
        """Evict ready entries. In-flight loads finish normally; no user state is stored."""
        with self._lock:
            self._ready.clear()
            self._bytes = 0


_cache = PublishedRoutingCache()


def get_for_publication(root, slug, version):
    return _cache.get_for_publication(root, slug, version)


def cache_info():
    return _cache.cache_info()
