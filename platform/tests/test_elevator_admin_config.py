"""Admin elevator editor writes the Option A pipeline_config.elevators shape.

Runs the same helper the Spatial Studio page loads (admin/elevators_config.js).
"""
import json
import subprocess
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "admin" / "elevators_config.js"

NODE = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const W = sandbox.WFElevators;
const floors = [{fid:"F2", ordinal:2},{fid:"F1", ordinal:1}];
const rows = W.parseElevators([
  {id:"elev_main", name:"Main elevator", floors:["F2","F1"], doors:{F1:{x:1.2344,y:2}, F2:{x:0,y:-1.2}}},
  {id:"elev_service", name:"Service lift", floors:["F1","F2"], bbox_model:[-1,10,1,12]}
]);
const out = W.serializeElevators(rows, floors);
const merged = W.mergePipeline({stairs:[{id:"s1"}], georef:{mode:"fixed"}}, out);
if (JSON.stringify(out) !== JSON.stringify([
  {id:"elev_main", name:"Main elevator", floors:["F1","F2"], doors:{F1:{x:1.234,y:2}, F2:{x:0,y:-1.2}}},
  {id:"elev_service", name:"Service lift", floors:["F1","F2"], bbox_model:[-1,10,1,12]}
])) {
  console.error(JSON.stringify(out));
  process.exit(1);
}
if (!merged.stairs || merged.georef.mode !== "fixed" || merged.elevators.length !== 2) process.exit(2);
if (W.serializeElevators([], floors).length !== 0) process.exit(3);
let missing = false;
try { W.serializeElevators([{id:"elev_a", name:"A", floors:["F1","F2"], doors:{F1:{x:0,y:0}}, useBbox:false}], floors); }
catch (e) { missing = /missing/.test(e.message); }
if (!missing) process.exit(4);
const draft = W.serializeElevators([{id:"elev_a", name:"A", floors:["F1"], doors:{F1:{x:0,y:0}}, useBbox:false}], floors, {strict:false});
if (!draft[0] || !draft[0].draft || !draft[0].doors.F1) { console.error(JSON.stringify(draft)); process.exit(5); }
// Multi-floor doors must survive floors list reorder / extra unchecked floor + mergeDoor.
const row = W.blankRow({id:"elev_multi", name:"Multi", floors:["F2","F1"], doors:{}});
W.mergeDoor(row, "F1", {x:1.5, y:2.5});
W.mergeDoor(row, "F2", {x:3, y:4});
row.floors = ["F2", "F1"]; // order change
const mid = W.serializeElevators([row], floors, {strict:false});
if (!mid[0] || !mid[0].doors || !mid[0].doors.F1 || !mid[0].doors.F2) {
  console.error("lost doors on reorder", JSON.stringify(mid)); process.exit(6);
}
if (mid[0].doors.F1.x !== 1.5 || mid[0].doors.F2.y !== 4) {
  console.error("door values wrong", JSON.stringify(mid)); process.exit(7);
}
// Floors list shrinks (unchecked F2) but draft mode must keep F2 door coords.
row.floors = ["F1"];
const kept = W.serializeElevators([row], floors, {strict:false});
if (!kept[0].doors.F1 || !kept[0].doors.F2) {
  console.error("draft dropped unchecked-floor door", JSON.stringify(kept)); process.exit(8);
}
const round = W.parseElevators(kept);
W.mergeDoor(round[0], "F1", {x:9, y:9});
if (!round[0].doors.F2 || round[0].doors.F2.x !== 3) {
  console.error("mergeDoor replaced doors map", JSON.stringify(round[0].doors)); process.exit(9);
}
if (Object.keys(W.cloneDoors(row.doors)).length !== 2) { console.error("cloneDoors"); process.exit(10); }
console.log("ok");
"""


def test_admin_elevator_serializer_matches_schema():
    r = subprocess.run(["node", "-e", NODE, str(JS)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
