// Exercise the real automated-preview controller and clock with a deterministic SDK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../viewer', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function environment({ holdFlights = false, holdRotations = false } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), elements = new Map(), frameWrites = [];
  function element(id) {
    const classes = new Set();
    const el = { id, hidden: true, textContent: '', style: {}, attributes: {},
      classList: { add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
        toggle(name, force) { const visible = force === undefined ? !classes.has(name) : force; if (visible) classes.add(name); else classes.delete(name); return visible; } },
      addEventListener() {}, remove() {}, querySelector: () => null,
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }
    };
    if (id === 'mpFrame') {
      let src = 'https://my.matterport.com/show/?m=test-model';
      Object.defineProperty(el, 'src', { get: () => src, set: value => { frameWrites.push(value); src = value; } });
    }
    return el;
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const schedule = (callback, ms, interval) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + Math.max(0, ms || 0), interval });
    return id;
  };
  const c = { window: null, document: { getElementById: $, body: element('body'), querySelector: () => null },
    performance: { now: () => now },
    setTimeout: (callback, ms) => schedule(callback, ms, 0), clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => schedule(callback, ms, ms), clearInterval: id => timers.delete(id),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    console: { info() {}, warn() {}, error() {} }, navigator: { userAgent: 'test' },
    location: { href: 'https://viewer.test/unc-charlotte', search: '' }, URLSearchParams,
    matchMedia: () => ({ matches: false }),
    WF: { cfg: { slug: 'uncc-main-campus', matterport_model_id: 'test-model' } }
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(read('preview_timing.js'), c);
  const source = read('mp_preview.js').replace('  window.MpPreview = {', `
    window.__playback = {
      bind: function(sdk) {
        mpSdk=sdk; usingLiveConnection=true;
        ensureDistHudMount=function(){return $("mpDistHud");};
        updateStep=function(){}; updateDirArrow=async function(){};
        updateTourInstruction=function(){};
      },
      prepare:prepareRoute, begin:beginPlayback, play:play, pause:pause, start:startRoutePlayback,
      schedule:remainingPlaybackSchedule, moveMs:scheduledMoveMs, dwellMs:scheduledDwellMs,
      phase:playbackPhase, delay:playbackDelay,
      updateDistance:updateDistHud,
      state:function(){return {playing:playing,stopped:stopped,finished:previewFinished,
        remaining:playbackClock && playbackClock.remainingMs(),sdk:mpSdk,
        cancellers:playbackCancellers.size,waiters:playbackWaiters.size};}
    };
    window.MpPreview = {`);
  vm.runInContext(source, c);

  const moves = [], rotations = [], pending = [], pendingRotations = [], poseListeners = new Set();
  let disconnects = 0, poseSubscriptions = 0, moveVersion = 0;
  let pose = { position: { x: -1, y: 1.6, z: -20 }, rotation: { x: 0, y: holdRotations ? 0 : -90 }, sweepId: 'a' };
  const emitPose = patch => { pose = { ...pose, ...patch }; for (const listener of poseListeners) listener(pose); };
  const sweepData = Object.fromEntries(['a', 'b', 'c'].map((id, i) => [id, { position: { x: i * 3, y: 1.6, z: -20 } }]));
  const sdk = {
    App: { state: { getLatest: () => ({ phase: 'appphase.playing' }) } },
    Model: { getData: async () => ({ sweeps: Object.entries(sweepData).map(([id, data]) => ({ id, ...data })) }) },
    Sweep: { Transition: { FLY: 'fly', INSTANT: 'instant' }, data: sweepData,
      moveTo(id, options) {
        moves.push({ id, options: plain(options) });
        const version = ++moveVersion;
        const land = () => { if (version === moveVersion) emitPose({ position: sweepData[id].position,
          rotation: holdRotations ? pose.rotation : options.rotation || pose.rotation, sweepId: id }); };
        if (!options.transitionTime) { land(); return Promise.resolve(); }
        return new Promise(resolve => {
          let progress = null;
          const finish = () => { c.clearInterval(progress); land(); resolve(); };
          if (holdFlights) pending.push(finish);
          else {
            const started = now, from = { ...pose.position }, to = sweepData[id].position;
            progress = c.setInterval(() => {
              if (version !== moveVersion) { c.clearInterval(progress); return; }
              const fraction = Math.min(1, (now - started) / options.transitionTime);
              emitPose({ position: { x: from.x + (to.x-from.x)*fraction, y: from.y + (to.y-from.y)*fraction, z: from.z + (to.z-from.z)*fraction } });
            }, 100);
            c.setTimeout(finish, options.transitionTime);
          }
        });
      }
    },
    Camera: { getPose: async () => pose,
      setRotation: rotation => {
        rotations.push(plain(rotation));
        if (holdRotations) return new Promise((resolve, reject) => pendingRotations.push(fail => {
          if (fail) reject(Error('Deferred SDK rotation failed')); else { emitPose({ rotation }); resolve(); }
        }));
        emitPose({ rotation }); return Promise.resolve();
      },
      pose: { subscribe(callback) { poseListeners.add(callback); poseSubscriptions++; callback(pose); return { cancel: () => {
        if (poseListeners.delete(callback)) poseSubscriptions--;
      } }; } }
    },
    disconnect() { disconnects++; }
  };
  c.__playback.bind(sdk);
  const route = { total_m: 424 * 0.3048, sweep_ids: ['a', 'b', 'c'],
    nodes: ['a', 'b', 'c'].map((id, i) => ({ id, kind: 'sweep', x: i * 3, y: 20, z: 1.6 })) };
  c.__playback.prepare(route);
  async function advance(milliseconds) {
    const end = now + milliseconds;
    await flush();
    for (let guard = 0; guard < 10000; guard++) {
      const entry = Array.from(timers).filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) { now = end; await flush(); return; }
      const [id, timer] = entry;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.callback();
      await flush();
    }
    throw Error('Playback created too many timers');
  }
  return { c, $, sdk, route, moves, rotations, pending, pendingRotations, timers, frameWrites, advance, emitPose,
    counts: () => ({ disconnects, poseSubscriptions }), state: () => c.__playback.state() };
}

test('automated preview uses actual transition, settling, and dwell schedule and displays routed feet', async () => {
  const f = environment();
  const { c, $ } = f;
  assert.deepEqual([0, 1, 2].map(i => c.__playback.moveMs(i)), [1500, 2550, 3825]);
  assert.deepEqual([0, 1, 2].map(i => c.__playback.dwellMs(i)), [600, 600, 330]);
  const total = 1500 + 2550 + 3825 + 180 * 3 + 600 + 600 + 330;
  assert.equal(c.__playback.schedule(0), total);
  const run = c.__playback.begin(0);
  c.__playback.updateDistance(0);
  assert.equal($('mpDockDist').textContent, '424 ft');
  assert.equal($('mpDockTimeValue').textContent, '00:10');
  const task = c.__playback.play(run);
  await f.advance(1000);
  assert.equal(f.state().remaining, total - 1000);
  assert.equal($('mpDockTimeValue').textContent, '00:09');
  await f.advance(total - 1000);
  await task;
  assert.equal($('mpDockTimeValue').textContent, '00:00');
  assert.equal(f.state().remaining, 0);
  assert.equal(f.state().finished, true);
  assert.deepEqual(f.moves.filter(move => move.options.transitionTime).map(move => move.options.transitionTime), [1500, 2550, 3825]);
  assert.deepEqual(f.frameWrites, []);
  assert.equal(f.counts().disconnects, 0);
  assert.equal(f.timers.size, 0);
});

test('pause holds preview time and resume continues the same remaining sequence', async () => {
  const f = environment();
  const run = f.c.__playback.begin(0);
  const task = f.c.__playback.play(run);
  await f.advance(1000);
  f.c.__playback.pause();
  const paused = f.state().remaining;
  await f.advance(60000);
  assert.equal(f.state().remaining, paused);
  f.c.__playback.play();
  await f.advance(1000);
  assert.ok(f.state().remaining < paused);
  await f.advance(60000);
  await task;
  assert.equal(f.state().remaining, 0);
  assert.equal(f.$('mpDockTimeValue').textContent, '00:00');
});

for (const [mode, entry, lead, tail] of [['live', 3000, 0, 0], ['standalone', 4500, 1500, 700]]) {
  test(`${mode} introduction timing includes its entry flight and configured pauses`, async () => {
    const f = environment();
    const total = lead + entry + tail + 180 + f.c.__playback.schedule(1);
    const task = f.c.__playback.start(entry, lead, tail);
    assert.equal(f.state().remaining, total);
    await f.advance(1000);
    assert.equal(f.state().remaining, total - 1000);
    await f.advance(total - 1000);
    await task;
    assert.equal(f.$('mpDockTimeValue').textContent, '00:00');
    assert.equal(f.state().remaining, 0);
    assert.deepEqual(f.moves.filter(move => move.options.transitionTime).map(move => move.options.transitionTime), [entry, 2550, 3825]);
    assert.deepEqual(f.frameWrites, []);
    assert.equal(f.counts().disconnects, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('stalled SDK flight preserves all later transition and pause budgets', async () => {
  const f = environment({ holdFlights: true });
  const total = f.c.__playback.schedule(0), firstMove = f.c.__playback.moveMs(0);
  const run = f.c.__playback.begin(0);
  const task = f.c.__playback.play(run);
  await f.advance(1000);
  assert.equal(f.moves.length, 1);
  const stalled = f.state().remaining;
  assert.ok(stalled > total - firstMove, 'no-motion watchdog freezes before exhausting the current flight budget');
  assert.ok(stalled < total, 'the clock initially advances while waiting for camera movement');
  await f.advance(30000);
  assert.equal(f.state().remaining, stalled);
  f.emitPose({ position: { x: -0.5, y: 1.6, z: -20 } });
  await f.advance(200);
  assert.equal(f.state().remaining, stalled - 200, 'camera movement resumes the active phase clock');
  f.c.MpPreview.close();
  await task;
});

test('Exit during a deferred facing correction prevents late fallback camera writes', async () => {
  const f = environment({ holdRotations: true });
  const run = f.c.__playback.begin(0);
  const task = f.c.__playback.play(run);
  await f.advance(1700);
  assert.equal(f.pendingRotations.length, 1, 'correction begins after the flight and configured 180ms settling pause');
  f.c.MpPreview.close();
  await task;
  const moveCount = f.moves.length, rotationCount = f.rotations.length;
  for (const finish of f.pendingRotations) finish(true);
  await f.advance(30000);
  assert.equal(f.moves.length, moveCount);
  assert.equal(f.rotations.length, rotationCount);
  assert.equal(f.counts().poseSubscriptions, 0);
  assert.equal(f.counts().disconnects, 0);
  assert.deepEqual(f.frameWrites, []);
  assert.equal(f.timers.size, 0);
});

test('Exit interrupts a flight, cleans callbacks, ignores late work, and retains the iframe and SDK', async () => {
  const f = environment({ holdFlights: true });
  const frame = f.$('mpFrame'), initialSrc = frame.src;
  const run = f.c.__playback.begin(0);
  const task = f.c.__playback.play(run);
  await f.advance(500);
  f.c.MpPreview.close();
  await task;
  assert.equal(f.state().playing, false);
  assert.equal(f.state().stopped, true);
  assert.equal(f.state().sdk, f.sdk);
  assert.equal(f.counts().disconnects, 0);
  assert.equal(f.counts().poseSubscriptions, 0);
  assert.equal(frame.src, initialSrc);
  assert.deepEqual(f.frameWrites, []);
  assert.equal(f.$('mpDock').hidden, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.state().cancellers, 0);
  assert.equal(f.state().waiters, 0);
  assert.equal(f.moves.at(-1).options.transition, 'instant');
  const moveCount = f.moves.length, rotationCount = f.rotations.length;
  for (const finish of f.pending) finish();
  await f.advance(60000);
  assert.equal(f.moves.length, moveCount);
  assert.equal(f.rotations.length, rotationCount);
  assert.equal(f.timers.size, 0);
});

test('Exit before the first SDK microtask prevents the initial camera command', async () => {
  const f = environment();
  const run = f.c.__playback.begin(0);
  const task = f.c.__playback.play(run);
  f.c.MpPreview.close();
  await task;
  await f.advance(30000);
  assert.equal(f.moves.length, 0);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.counts().poseSubscriptions, 0);
  assert.equal(f.state().sdk, f.sdk);
  assert.deepEqual(f.frameWrites, []);
});

test('repeated Play shares one playback loop and Exit cancels a configured dwell', async () => {
  const f = environment();
  const run = f.c.__playback.begin(0);
  const task = f.c.__playback.play(run);
  assert.equal(f.c.__playback.play(), task);
  await f.advance(1780); // 1500ms flight, 180ms settling, then 100ms into the dwell.
  assert.equal(f.moves.length, 1);
  assert.equal(f.c.__playback.play(), task);
  f.c.MpPreview.close();
  await task;
  assert.equal(f.timers.size, 0);
  await f.advance(30000);
  assert.equal(f.moves.length, 1);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.state().waiters, 0);
  assert.equal(f.state().cancellers, 0);
  assert.equal(f.counts().poseSubscriptions, 0);
  assert.deepEqual(f.frameWrites, []);
});
