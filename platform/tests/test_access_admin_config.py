"""Admin Access settings serializer (pipeline_config.access)."""
import subprocess
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "admin" / "access_config.js"

NODE = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const W = sandbox.WFAccess;
const blank = W.blank();
if (blank.twin !== "public" || blank.tour_public !== true || blank.routing_mode !== "all_public") {
  console.error("defaults", blank); process.exit(1);
}
const parsed = W.parseAccess({
  twin: "pin", twin_pin_hash: "abc", tour_public: false,
  routing: { mode: "exclude_edges", excluded_edge_ids: ["u|v", "u|v", "a→b"] }
});
if (!parsed.has_pin_hash || parsed.twin !== "pin" || parsed.tour_public !== false) process.exit(2);
if (parsed.excluded_edge_ids.join(",") !== "u|v,a|b") { console.error(parsed.excluded_edge_ids); process.exit(3); }
parsed.twin_pin = "zz99";
const out = W.serializeAccess(parsed);
if (out.twin !== "pin" || out.twin_pin !== "zz99" || out.tour_public !== false) { console.error(out); process.exit(4); }
if (out.routing.mode !== "exclude_edges" || out.routing.excluded_edge_ids.length !== 2) process.exit(5);
const merged = W.mergePipeline({ elevators: [{ id: "e1" }], tour_modes: { mesh_tour: true }, media_panels: [] }, parsed);
if (!merged.elevators || !merged.tour_modes.mesh_tour || !merged.access) process.exit(6);
const flags = W.viewerFlags({ access: { twin: "disabled", tour_public: true } });
if (!flags.twin_disabled || flags.embed_tour_allowed) process.exit(7);
const pinFlags = W.viewerFlags({ access: { twin: "pin", tour_public: true } });
if (!pinFlags.twin_pin_required || !pinFlags.embed_tour_allowed) process.exit(8);
const paste = W.parseEdgeIdPaste("a|b\nc→d, e__f");
if (paste.join(",") !== "a|b,c|d,e|f") { console.error(paste); process.exit(9); }
if (!W.isEdgeExcluded(["a|b"], "b|a")) process.exit(10);
if (W.isEdgeExcluded(["a|b"], "c|d")) process.exit(11);
const toggled = W.toggleEdgeExcluded(["x|y"], "a|b");
if (toggled.indexOf("a|b") < 0) process.exit(12);
const off = W.toggleEdgeExcluded(toggled, "b|a");
if (off.indexOf("a|b") >= 0) process.exit(13);
const feats = W.annotateNavFeatures([
  { type: "Feature", properties: { edge_id: "a|b" }, geometry: { type: "LineString", coordinates: [[0,0],[1,1]] } },
  { type: "Feature", properties: { edge_id: "c|d" }, geometry: { type: "LineString", coordinates: [[0,0],[1,1]] } }
], ["b|a"]);
if (!feats[0].properties.excluded || feats[1].properties.excluded) process.exit(14);
const msg = W.previewImpactMessage(true, false);
if (msg.indexOf("cannot reach") < 0) process.exit(15);
console.log("ok");
"""


def test_admin_access_serializer():
    r = subprocess.run(["node", "-e", NODE, str(JS)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
