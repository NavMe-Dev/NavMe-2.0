"""Admin media panel editor writes pipeline_config.media_panels (Option 4).

Runs the same helper Spatial Studio loads (admin/media_panels_config.js).
Covers image/video/text + optional CTA redirect buttons.
"""
import subprocess
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "admin" / "media_panels_config.js"

NODE = r"""
const fs = require("fs");
const vm = require("vm");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), sandbox);
const W = sandbox.WFMediaPanels;
const rows = W.parsePanels([
  {id:"screen_lobby", name:"Lobby", kind:"image", src:"https://example.com/a.jpg",
   model:{x:1.2344,y:2,z:1.5}, normal:{x:0,y:1,z:0}, floor:"F1", style:"glass_v1", published:true,
   buttons:[{label:"Campus map", url:"https://example.com/map"}]},
  {id:"screen_vid", name:"Clip", kind:"video", src:"media/clip.mp4", poster:"media/poster.jpg",
   model:{x:0,y:-1.2,z:1.4}, floor:"F2"},
  {id:"panel_welcome", name:"Welcome", kind:"text", body:"Hello **world**\n\nSee [docs](https://example.com).",
   model:{x:2,y:3,z:1.4}, floor:"F1",
   buttons:[{label:"Open portal", url:"https://example.com/portal"}, {label:"", url:"https://x.com"}]}
]);
const out = W.serializePanels(rows);
if (out.length !== 3) { console.error("len", out); process.exit(1); }
if (out[0].model.x !== 1.234 || out[0].kind !== "image") { console.error(out[0]); process.exit(2); }
if (!out[0].buttons || out[0].buttons.length !== 1 || out[0].buttons[0].label !== "Campus map") {
  console.error("buttons", out[0]); process.exit(21);
}
if (out[1].kind !== "video" || out[1].poster !== "media/poster.jpg") { console.error(out[1]); process.exit(3); }
if (out[2].kind !== "text" || !out[2].body || out[2].body.indexOf("Hello") < 0) { console.error(out[2]); process.exit(31); }
if (!out[2].buttons || out[2].buttons.length !== 1) { console.error("text buttons", out[2]); process.exit(32); }
if (out[2].src) { console.error("text should omit empty src", out[2]); process.exit(33); }
const merged = W.mergePipeline({elevators:[{id:"e1"}], stairs:[]}, out);
if (!merged.elevators || merged.elevators.length !== 1 || merged.media_panels.length !== 3) process.exit(4);
if (W.serializePanels([]).length !== 0) process.exit(5);
let threw = false;
try { W.serializePanels([{id:"bad", name:"B", kind:"image", src:"", model:{x:0,y:0}}], {strict:true}); }
catch (e) { threw = /URL|upload|src/i.test(e.message); }
if (!threw) process.exit(6);
threw = false;
try { W.serializePanels([{id:"badtxt", name:"T", kind:"text", body:"", model:{x:0,y:0}}], {strict:true}); }
catch (e) { threw = /body/i.test(e.message); }
if (!threw) process.exit(61);
const draft = W.serializePanels([{id:"draft1", name:"D", kind:"image", src:"", model:{x:"",y:""}}], {strict:false});
if (!draft[0].draft) { console.error(draft); process.exit(7); }
const draftTxt = W.serializePanels([{id:"draft2", name:"T", kind:"text", body:"", model:{x:1,y:2}}], {strict:false});
if (!draftTxt[0].draft) { console.error(draftTxt); process.exit(71); }
const row = W.blankRow({id:"screen_x", name:"X"});
W.applyPlacement(row, {x:3, y:4, z:1.2, normal:{x:0,y:1,z:0}, sid:"abc"}, "pointer");
if (row.model.x !== 3 || row.normal.y !== 1 || row.sweep_sid !== "abc") { console.error(row); process.exit(8); }
const round = W.parsePanels(W.serializePanels([row], {strict:false}));
if (!round[0] || round[0].id !== "screen_x") process.exit(9);
if (!W.KINDS.text || !W.KINDS.image || !W.KINDS.video) process.exit(10);
const blankBtn = W.blankButton();
if (!blankBtn || blankBtn.label !== "" || blankBtn.url !== "") process.exit(11);
console.log("ok");
"""


def test_admin_media_panels_serializer():
    r = subprocess.run(["node", "-e", NODE, str(JS)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr or r.stdout
    assert r.stdout.strip() == "ok"
