"""Admin debug_config.js serializer."""
import subprocess
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "admin" / "debug_config.js"

NODE = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const W = sandbox.WFDebugConfig;
if (W.parseOverride(undefined) !== null) process.exit(1);
if (W.parseOverride({enabled:true}) !== true) process.exit(2);
if (W.parseOverride({enabled:false}) !== false) process.exit(3);
const m = W.mergePipeline({tour_modes:{mesh_tour:true}, elevators:[]}, true);
if (!m.debug.enabled || !m.tour_modes.mesh_tour) process.exit(4);
const m2 = W.mergePipeline(m, null);
if ("debug" in m2 || !m2.tour_modes.mesh_tour) process.exit(5);
console.log("ok");
"""


def test_debug_config_js():
    r = subprocess.run(["node", "-e", NODE, str(JS)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
