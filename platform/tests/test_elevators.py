"""Unit tests for config-driven elevators (Option A). No Matterport onboard required."""
import networkx as nx
import pytest

from wfpipe.steps.graph import (
    add_elevators,
    ELEVATOR_WAIT_M,
    ELEVATOR_PER_FLOOR_M,
)


def _tiny_building():
    """Two floors, a few sweeps near an elevator shaft at (0,0)."""
    G = nx.Graph()
    G.add_node("s1a", kind="sweep", label="S1", floor="F1", x=0.2, y=0.1, z=0.0, indoor=True)
    G.add_node("s1b", kind="sweep", label="S2", floor="F1", x=5.0, y=5.0, z=0.0, indoor=True)
    G.add_node("s2a", kind="sweep", label="S3", floor="F2", x=0.3, y=-0.1, z=3.0, indoor=True)
    G.add_node("s2b", kind="sweep", label="S4", floor="F2", x=5.0, y=5.0, z=3.0, indoor=True)
    G.add_edge("s1a", "s1b", length=7.0, stairs=None, step_free=True, dz=0.0, cross_floor=False)
    G.add_edge("s2a", "s2b", length=7.0, stairs=None, step_free=True, dz=0.0, cross_floor=False)
    return G


def test_empty_elevators_unchanged():
    G = _tiny_building()
    n0, e0 = G.number_of_nodes(), G.number_of_edges()
    out, n = add_elevators(G, None)
    assert out == [] and n == 0
    assert G.number_of_nodes() == n0 and G.number_of_edges() == e0
    out, n = add_elevators(G, [])
    assert out == [] and n == 0
    assert G.number_of_nodes() == n0 and G.number_of_edges() == e0


def test_doors_config_adds_step_free_elevator_edge():
    G = _tiny_building()
    cfg = [{
        "id": "elev_main",
        "name": "Main elevator",
        "floors": ["F1", "F2"],
        "doors": {"F1": {"x": 0.0, "y": 0.0}, "F2": {"x": 0.0, "y": 0.0}},
    }]
    out, n = add_elevators(G, cfg)
    assert n == 1
    assert len(out) == 1
    assert out[0]["id"] == "elev_main"
    assert out[0]["source"] == "config"
    assert set(out[0]["door_nodes"]) == {"F1", "F2"}
    # Linked to nearest existing sweeps, not invented hubs (doors within 3 m).
    assert out[0]["door_nodes"]["F1"] == "s1a"
    assert out[0]["door_nodes"]["F2"] == "s2a"
    ed = G.edges["s1a", "s2a"]
    assert ed["source"] == "elevator"
    assert ed["elevator"] == "elev_main"
    assert ed["stairs"] is None
    assert ed["step_free"] is True
    assert ed["cross_floor"] is True
    assert ed["floor_delta"] == 1
    assert ed["length"] == pytest.approx(ELEVATOR_WAIT_M + ELEVATOR_PER_FLOOR_M * 1)
    assert ed["dz"] == pytest.approx(3.0)


def test_bbox_config_like_stairs():
    G = _tiny_building()
    cfg = [{
        "id": "elev_bbox",
        "name": "Service lift",
        "floors": ["F1", "F2"],
        "bbox_model": [-1.0, -1.0, 1.0, 1.0],
    }]
    out, n = add_elevators(G, cfg)
    assert n == 1
    ed = next(d for *_, d in G.edges(data=True) if d.get("source") == "elevator")
    assert ed["step_free"] and ed["elevator"] == "elev_bbox"


def test_server_route_no_stair_penalty_on_elevator():
    from wayfinding_api.services import navgraph as ng
    nav = {
        "cost_model": {"stair_penalty_m": 15, "walk_speed_mps": 1.2, "elevator_wait_s": 20, "elevator_per_floor_s": 4},
        "nodes": [
            {"id": "a", "x": 0, "y": 0, "z": 0, "floor": "F1", "kind": "sweep", "label": "A", "lonlat": [0, 0]},
            {"id": "b", "x": 0, "y": 0, "z": 3, "floor": "F2", "kind": "sweep", "label": "B", "lonlat": [0, 0]},
        ],
        "edges": [{
            "u": "a", "v": "b", "length": ELEVATOR_WAIT_M + ELEVATOR_PER_FLOOR_M,
            "dz": 3.0, "stairs": None, "step_free": True, "source": "elevator",
            "elevator": "elev_main", "floor_delta": 1,
        }],
    }
    G = ng.build(nav, step_free=True)
    assert G.has_edge("a", "b")
    # Weight equals length (no +15 stair penalty).
    assert G.edges["a", "b"]["weight"] == pytest.approx(ELEVATOR_WAIT_M + ELEVATOR_PER_FLOOR_M)
    r = ng.route(nav, "a", "b", step_free=True)
    assert r is not None
    assert r["elevator_edges"] == 1
    assert r["stair_edges"] == 0
    assert r["eta_s"] == 20 + 4  # wait + one floor
