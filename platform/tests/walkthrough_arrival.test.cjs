const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync('platform/viewer/ui.js', 'utf8');
const preview = fs.readFileSync('platform/viewer/mp_preview.js', 'utf8');
function extract(src, start, end) { return src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start))); }
test('arrival instruction and zero distance do not announce until final landing', () => {
  let arrivals = 0;
  const elements = {};
  const context = {S:{mode:'nav', route:{total_m:20}, navI:0, navSteps:[{type:'arrive',dist:0}]},
    $: id => elements[id] ||= {}, fmtMin: String, fmtDist:String, t: String,
    window:{MpPreview:{totalSweepStops:()=>5}}, announceArrivalOnce:()=>arrivals++,
    navLegBaselineI:-1, navLegBaselineRemM:null};
  vm.createContext(context);
  vm.runInContext(extract(ui,'  function updateMpRemaining(', '  /** Icon/text/thumb'), context);
  context.updateMpRemaining({index:2,remainingM:12,landed:true});
  context.updateMpRemaining({index:4,remainingM:0,landed:false});
  assert.equal(arrivals,0);
  context.updateMpRemaining({index:4,remainingM:0,landed:true});
  assert.equal(arrivals,1);
});
test('walk reports landing only after move resolves and never after failed movement', async () => {
  let resolveMove, tick;
  const events=[];
  const context = {mpSdk:{Sweep:{moveTo:()=>new Promise(r=>resolveMove=r)}}, sweepIds:['a','b'],stepI:0,walkGen:0,
    segDistM:[12],flyTransitionMs:()=>1,headingToward:()=>null,remainingDistM:i=>i?0:12,
    nextLegDistM:()=>0,setInterval:fn=>(tick=fn,1),clearInterval:()=>{},
    faceAlongRoute:async()=>{},updateStep:()=>{},updateDirArrow:async()=>{},updateDistHud:()=>{},
    updateTourInstruction:()=>{},sweepNodes:[{},{}],console};
  vm.createContext(context);
  vm.runInContext(extract(preview,'  async function walkToIndex(', '  /** Cancel any in-flight'),context);
  const flight=context.walkToIndex(1,info=>events.push(info));
  tick(); assert.equal(events[0].landed,false);
  assert.equal(events.some(e=>e.landed),false);
  resolveMove(); assert.equal(await flight,true);
  assert.equal(events.at(-1).landed,true);
  context.stepI=0; events.length=0;
  context.mpSdk.Sweep.moveTo=async()=>{throw Error('blocked')};
  context.console={warn:()=>{}};
  assert.equal(await context.walkToIndex(1,info=>events.push(info)),false);
  assert.equal(events.some(e=>e.landed),false);
});
