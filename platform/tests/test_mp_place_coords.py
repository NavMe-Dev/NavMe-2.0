"""Admin MpPlace SDK↔model coordinate helpers (admin/mp_place.js)."""
import subprocess
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "admin" / "mp_place.js"

NODE = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const M = sandbox.MpPlace;
const a = M.sdkToModel({x:1.5,y:2.0,z:-3.25});
if (Math.abs(a.x-1.5)>1e-9 || Math.abs(a.y-3.25)>1e-9 || Math.abs(a.z-2)>1e-9) process.exit(1);
const b = M.modelToSdk({x:1.5,y:3.25,z:2});
if (Math.abs(b.x-1.5)>1e-9 || Math.abs(b.y-2)>1e-9 || Math.abs(b.z+3.25)>1e-9) process.exit(2);
if (M.round3(1.2344) !== 1.234) process.exit(3);
if (M.keyFromShowcaseUrl("https://my.matterport.com/show/?m=abc&applicationKey=KEY123") !== "KEY123") process.exit(4);
console.log("ok");
"""


def test_mp_place_sdk_model_roundtrip():
    r = subprocess.run(["node", "-e", NODE, str(JS)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
