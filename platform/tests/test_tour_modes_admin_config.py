"""Admin Tour settings write pipeline_config.tour_modes (Path A/B flags)."""
import subprocess
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "admin" / "tour_modes_config.js"

NODE = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const W = sandbox.WFTourModes;
const blank = W.blank();
if (blank.embed_showcase !== true || blank.mesh_tour !== false || blank.bundle_scene !== false) {
  console.error("defaults", blank); process.exit(1);
}
const parsed = W.parseTourModes({
  embed_showcase: true, mesh_tour: true, bundle_scene: true,
  bundle_url: "https://example.com/bundle/showcase.html", bundle_note: "spike"
});
const out = W.serializeTourModes(parsed);
if (!out.mesh_tour || !out.bundle_scene || out.bundle_url.indexOf("showcase") < 0) {
  console.error(out); process.exit(2);
}
if (out.bundle_camera !== "dollhouse" || !out.bundle_configured) process.exit(3);
const merged = W.mergePipeline({ elevators: [{ id: "e1" }], media_panels: [] }, parsed);
if (!merged.elevators || !merged.tour_modes.mesh_tour) process.exit(4);
const flags = W.viewerFlags({
  has_glb: true,
  files: { model_glb: "model_glb.json" },
  tour_modes: out
});
if (!flags.mesh_tour || !flags.bundle_available || !flags.embed_showcase) {
  console.error(flags); process.exit(5);
}
const noGlb = W.viewerFlags({ has_glb: false, tour_modes: { mesh_tour: true, embed_showcase: true } });
if (noGlb.mesh_tour) { console.error("mesh should need glb", noGlb); process.exit(6); }
const noUrl = W.viewerFlags({ tour_modes: { bundle_scene: true } });
if (noUrl.bundle_available) { console.error("bundle needs url", noUrl); process.exit(7); }
console.log("ok");
"""


def test_admin_tour_modes_serializer():
    r = subprocess.run(["node", "-e", NODE, str(JS)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
