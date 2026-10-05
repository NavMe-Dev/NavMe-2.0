import json, numpy as np, pytest
from wfpipe.context import Context
from wfpipe import runner
from wfpipe.steps import floors as floors_step, mesh as mesh_step, colorplan


def fake_mp(tmp):
    sq = lambda x0, y0, x1, y1: {"edges": [{"vertices": [{"position": {"x": a, "y": b}}, {"position": {"x": c, "y": d}}]} for (a, b), (c, d) in
                                           zip([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], [(x1, y0), (x1, y1), (x0, y1), (x0, y0)])]}
    m = {"name": "t", "floors": [{"id": "fB", "label": "Upper", "sequence": 1}, {"id": "fA", "label": "Ground", "sequence": 0}],
         "rooms": [{"id": "r1", "floor": {"id": "fA"}, "keywords": ["indoor"], "boundary": sq(0, 0, 10, 10)},
                   {"id": "r2", "floor": {"id": "fB"}, "keywords": ["indoor"], "boundary": sq(0, 0, 10, 10)}],
         "locations": [{"id": f"s{i}", "floor": {"id": "fA" if i < 3 else "fB"}, "position": {"x": 5, "y": 1 + i, "z": 0.1 if i < 3 else 3.1}} for i in range(6)]}
    return {"data": {"model": m}}


def test_floors_resolved(tmp_path):
    ctx = Context(tmp_path, {"name": "t"})
    ctx.write_json(ctx.w("mp_model.json"), fake_mp(tmp_path))
    info = floors_step.run(ctx)
    fl = ctx.floors()
    assert [f["id"] for f in fl] == ["F1", "F2"] and fl[0]["label"] == "Ground"
    assert fl[0]["elevation"] == 0.1 and fl[1]["elevation"] == 3.1
    assert fl[0]["z_band"][1] == pytest.approx(1.6) and fl[1]["z_band"][0] == pytest.approx(1.6)
    assert floors_step.floor_of_z(fl, 2.9) == "F2"


def test_floor_overrides(tmp_path):
    ctx = Context(tmp_path, {"name": "t", "floors": [{"id": "F2", "label": "Main", "elevation": 3.0, "height": 4}]})
    ctx.write_json(ctx.w("mp_model.json"), fake_mp(tmp_path)); floors_step.run(ctx)
    f2 = ctx.floors()[1]
    assert f2["label"] == "Main" and f2["elevation"] == 3.0 and f2["wall_band"][1] == pytest.approx(6.65)


def test_obj_loader(tmp_path):
    p = tmp_path / "m.obj"
    p.write_text("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nf 1/1 2/1 3/1 4/1\n")
    V, F = mesh_step.load_obj(p)
    assert V.shape == (4, 3) and F.tolist() == [[0, 1, 2], [0, 2, 3]]


def test_plan_mask_ignores_legend():
    im = np.full((100, 200, 3), 50, np.uint8); im[10:40, 50:150] = 200; im[95:, :5] = 255
    m = colorplan.plan_mask(im)
    assert m[20, 100] and not m[97, 2] and not m[60, 100]


def test_runner_skips_up_to_date(tmp_path, monkeypatch):
    calls = []
    class Fake:
        __doc__ = "fake"
        @staticmethod
        def run(ctx):
            calls.append(1); ctx.write_json(ctx.w("fake.json"), {}); return {}
    monkeypatch.setitem(runner.STEPS, "fake", (Fake, [], ["name"], ["work/fake.json"]))
    monkeypatch.setattr(runner, "ORDER", ["fake"])
    ctx = Context(tmp_path, {"name": "a"})
    runner.run(ctx); runner.run(ctx); assert len(calls) == 1
    ctx2 = Context(tmp_path, {"name": "b"}); runner.run(ctx2); assert len(calls) == 2      # config change -> re-run
    runner.run(ctx2, force=True); assert len(calls) == 3


def test_step_registry_is_consistent():
    for n, (mod, deps, keys, outs) in runner.STEPS.items():
        assert hasattr(mod, "run") and all(d in runner.STEPS and runner.ORDER.index(d) < runner.ORDER.index(n) for d in deps)


def test_e57_ingest_produces_obj_and_colorplan(tmp_path):
    from wfpipe.steps import ingest as ingest_step
    from pathlib import Path
    src = Path(__file__).resolve().parents[1] / "fixtures" / "e57_synth" / "synth_two_floor.e57"
    if not src.exists():
        pytest.skip("synthetic e57 fixture missing")
    ctx = Context(tmp_path, {"name": "e57", "matterpak": str(src)})
    info = ingest_step.run(ctx)
    assert info["format"] == "e57"
    assert (tmp_path / "work/matterpak/model.obj").stat().st_size > 100
    cps = list((tmp_path / "work/matterpak").glob("colorplan_*.jpg"))
    assert cps, "expected ≥1 synthetic colour plan"
    man = __import__("json").loads((tmp_path / "work/matterpak_manifest.json").read_text())
    assert man["source_format"] == "e57" and man["conversion"]["mesh_method"]


def test_e57_export_zip_ingest(tmp_path):
    """Matterport mp_e57_*.zip style: zip with cloud_0.e57 and no .obj."""
    from wfpipe.steps import ingest as ingest_step
    from pathlib import Path
    src = Path(__file__).resolve().parents[1] / "fixtures" / "e57_synth" / "mp_e57_synth.zip"
    if not src.exists():
        pytest.skip("synthetic e57 zip fixture missing")
    ctx = Context(tmp_path, {"name": "e57zip", "matterpak": str(src)})
    info = ingest_step.run(ctx)
    assert info["format"] == "e57"
    assert (tmp_path / "work/matterpak/model.obj").stat().st_size > 100
    assert list((tmp_path / "work/matterpak").glob("colorplan_*.jpg"))
