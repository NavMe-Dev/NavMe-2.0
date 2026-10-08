"""Step registry + idempotent runner."""
import time, traceback
from .context import StepError
from .steps import (ingest, fetch_mp, mesh, colorplan, imagery, georef, floors, overlays, glb, voxel,
                    osm, graph, navmesh, pois, indoor, thumbs, vps_index, export)

# name: (module, deps, config keys that affect the result, outputs that must exist)
STEPS = {
    "ingest":    (ingest,    [],                                ["matterpak"],             ["work/matterpak/model.obj"]),
    "fetch_mp":  (fetch_mp,  [],                                ["matterport_model_id"],   ["work/mp_model.json"]),
    "mesh":      (mesh,      ["ingest"],                        [],                        ["work/mesh.npz"]),
    "colorplan": (colorplan, ["mesh"],                          [],                        ["work/colorplan_map.json"]),
    "imagery":   (imagery,   ["fetch_mp"],                      ["lat", "lon", "georef"],  ["work/sat.png"]),
    "georef":    (georef,    ["colorplan", "imagery"],          ["georef"],                ["out/georef.json"]),
    "floors":    (floors,    ["fetch_mp", "mesh"],              ["floors"],                ["work/floors_resolved.json"]),
    "overlays":  (overlays,  ["georef", "floors", "colorplan"], [],                        ["out/floors.json"]),
    "glb":       (glb,       ["georef", "floors", "colorplan"], ["glb"],                   ["out/model_glb.json"]),
    "voxel":     (voxel,     ["mesh"],                          [],                        ["work/vox.npz"]),
    "osm":       (osm,       ["georef"],                        ["osm"],                   ["work/osm_footways.json"]),
    "graph":     (graph,     ["fetch_mp", "voxel", "georef", "floors", "osm"], ["stairs", "graph"], ["out/nav_graph.json"]),
    "navmesh":   (navmesh,   ["graph"],                         [],                        ["out/navmesh.json"]),
    "pois":      (pois,      ["graph"],                         ["pois_seed", "arrival_poi"], ["out/pois.json"]),
    "indoor":    (indoor,    ["graph", "pois", "osm"],          ["name"],                  ["out/site_shell.geojson"]),
    "thumbs":    (thumbs,    ["pois"],                          ["thumbs"],                ["out/thumbs/index.json"]),
    "vps_index": (vps_index, ["graph"],                         ["vps_index"],             ["out/vps_index.npz"]),
    "export":    (export,    ["indoor", "overlays", "glb", "thumbs", "navmesh", "vps_index"], ["name", "address", "slug", "matterport_model_id", "branding"], ["out/config.json"]),
}
ORDER = list(STEPS)


def resolve(steps=None, from_step=None):
    if from_step:
        i = ORDER.index(from_step); return ORDER[i:]
    if not steps:
        return ORDER
    return [s for s in ORDER if s in steps]


def run(ctx, steps=None, force=False, from_step=None, force_steps=()):
    todo = resolve(steps, from_step)
    summary = []
    for name in todo:
        mod, deps, keys, outs = STEPS[name]
        fp = ctx.fingerprint(keys, deps)
        st = ctx.state.get(name, {})
        exist = all((ctx.root / o).exists() for o in outs)
        if not force and name not in force_steps and st.get("fp") == fp and st.get("status") == "ok" and exist:
            ctx.log(f"skip {name} (up to date)"); summary.append((name, "skipped", 0)); continue
        ctx.current_step = name; t = time.time()
        ctx.log(f"start {name}")
        ctx.state[name] = {"status": "running", "started": time.time()}; ctx.save_state()
        try:
            info = mod.run(ctx) or {}
        except Exception as e:
            ctx.state[name] = {"status": "failed", "error": str(e), "fp": None}; ctx.save_state()
            ctx.log(traceback.format_exc(), "error"); ctx.current_step = None
            raise StepError(f"step {name} failed: {e}") from e
        dt = round(time.time() - t, 1)
        ctx.state[name] = {"status": "ok", "fp": fp, "seconds": dt, "finished": time.time(), "info": info}
        ctx.save_state(); ctx.log(f"done {name} in {dt}s {info if info else ''}"); ctx.current_step = None
        summary.append((name, "ok", dt))
    return summary
