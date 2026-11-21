const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_preview.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fixture({subscriptionType = 'cancel', ios = false, fadeAvailable = true} = {}) {
  const nodes = new Map(), timers = new Map(), listeners = new Set(), moves = [], transitions = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {id, hidden: true, onclick: null, style: {},
      setAttribute() {}, querySelector: () => null,
      classList: {add() {}, remove() {}, contains: name => name === 'mp-bg-mode'}});
    return nodes.get(id);
  };
  let nextTimer = 0, transition = async () => {}, pointerFailure = false, intervalFailure = false;
  const sdk = {
    Mode: {Mode: {DOLLHOUSE: 'mode.dollhouse'},
      Transition: {FLY: 'fly', INSTANT: 'instant', ...(fadeAvailable ? {FADEOUT: 'fadeout'} : {})},
      moveTo(mode, options) { transitions.push({mode, transition: options.transition}); return transition(); }},
    Pointer: {intersection: {subscribe(callback) {
      if (pointerFailure) throw Error('pointer unavailable');
      listeners.add(callback);
      const stop = () => listeners.delete(callback);
      return subscriptionType === 'function' ? stop : {[subscriptionType]: stop};
    }}},
  };
  const context = {window: null, sdk, document: {body: node('body'), getElementById: node},
    navigator: {userAgent: ios ? 'iPhone' : 'Android', platform: ios ? 'iPhone' : 'Linux', maxTouchPoints: 1},
    console: {warn() {}}, setInterval(callback) {
      if (intervalFailure) throw Error('timer unavailable');
      const id = ++nextTimer; timers.set(id, callback); return id;
    }, clearInterval: id => timers.delete(id),
    WF: {cfg: {matterport_model_id: 'model-a'}, building: {slug: 'gcu'}}, __pickMoves: moves};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source.replace('  window.MpPreview = {', `
    mpSdk = window.sdk;
    ensurePickOverlay = () => document.getElementById('mpPickBar');
    focusAt = async point => { window.__pickMoves.push(point); };
    initializeBackground = async () => true;
    openUsingLiveConnection = async () => {};
    window.__pickTest = {replaceSdk() { mpSdk = window.sdk; }};
    window.MpPreview = {`), context);
  // Keep the contextified window, where the controller installs its API.
  return {api: context.MpPreview, hook: context.__pickTest, context, sdk, node, moves, transitions,
    transition: callback => { transition = callback; }, pointerFailure: () => { pointerFailure = true; },
    intervalFailure: () => { intervalFailure = true; },
    hit(value = {object: 'intersectedobject.model', position: {x: 1, y: 2, z: 3}, floorIndex: 4}) {
      for (const callback of listeners) callback(value);
      for (const callback of timers.values()) callback();
    }, counts: () => ({subscriptions: listeners.size, timers: timers.size})};
}

for (const subscriptionType of ['cancel', 'unsubscribe', 'function']) {
  test(`confirmed map pick releases its ${subscriptionType} subscription, timer and handlers`, async () => {
    const f = fixture({subscriptionType});
    const result = f.api.pickOnMap(); await flush();
    assert.deepEqual(f.counts(), {subscriptions: 1, timers: 1});
    assert.equal(f.node('mpPickGo').disabled, true);
    f.hit(); assert.equal(f.node('mpPickGo').disabled, false);
    f.node('mpPickGo').onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(await result)), {x: 1, y: -3, z: 2, floorIndex: 4});
    assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
    assert.equal(f.node('mpPickBar').hidden, true);
    assert.equal(f.node('mpPickGo').onclick, null);
    assert.equal(f.node('mpPickCancel').onclick, null);
    assert.equal(f.moves.length, 1);
  });
}

for (const [ios, fadeAvailable, expected] of [[true, true, 'fadeout'], [true, false, 'instant'], [false, true, 'fly']]) {
  test(`picker retains ${expected} transitions on ${ios ? 'iOS' : 'other devices'}`, async () => {
    const f = fixture({ios, fadeAvailable});
    const result = f.api.pickOnMap(); await flush();
    assert.deepEqual(f.transitions, [{mode: 'mode.dollhouse', transition: expected}]);
    f.node('mpPickCancel').onclick(); assert.equal(await result, null);
    assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
  });
}

test('reopening an active picker settles the old request and keeps only the newest resources', async () => {
  const f = fixture();
  const first = f.api.pickOnMap(); await flush();
  const second = f.api.pickOnMap(); await flush();
  assert.equal(await first, null);
  assert.deepEqual(f.counts(), {subscriptions: 1, timers: 1});
  assert.equal(f.node('mpPickBar').hidden, false);
  f.node('mpPickCancel').onclick(); assert.equal(await second, null);
  assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
  assert.equal(f.moves.length, 0);
});

test('cancelled slow transitions cannot install resources or hide a newer picker', async () => {
  const f = fixture(), slow = deferred();
  f.transition(() => slow.promise);
  const first = f.api.pickOnMap(); await flush();
  f.transition(async () => {});
  const second = f.api.pickOnMap(); await flush();
  assert.equal(await first, null);
  const cancelNewest = f.node('mpPickCancel').onclick;
  slow.resolve(); await flush();
  assert.deepEqual(f.counts(), {subscriptions: 1, timers: 1});
  assert.equal(f.node('mpPickBar').hidden, false);
  assert.equal(f.node('mpPickCancel').onclick, cancelNewest);
  cancelNewest(); assert.equal(await second, null);
  assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
});

for (const pendingTransition of [false, true]) {
  test(`closing the preview settles and cleans a ${pendingTransition ? 'starting' : 'visible'} picker`, async () => {
    const f = fixture(), slow = deferred();
    if (pendingTransition) f.transition(() => slow.promise);
    const result = f.api.pickOnMap(); await flush();
    f.api.close(); assert.equal(await result, null);
    assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
    slow.resolve(); await flush();
    assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
    assert.equal(f.node('mpPickBar').hidden, true);
  });
}

test('a model change cancels its picker before the old SDK is replaced', async () => {
  const f = fixture();
  await f.api.showBackground(); f.hook.replaceSdk();
  const result = f.api.pickOnMap(); await flush();
  f.context.WF.cfg.matterport_model_id = 'model-b';
  await f.api.showBackground();
  assert.equal(await result, null);
  assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
  assert.equal(f.node('mpPickBar').hidden, true);
});

test('reusing the same background preserves an active picker', async () => {
  const f = fixture();
  await f.api.showBackground(); f.hook.replaceSdk();
  const result = f.api.pickOnMap(); await flush();
  await f.api.showBackground();
  assert.deepEqual(f.counts(), {subscriptions: 1, timers: 1});
  assert.equal(f.node('mpPickBar').hidden, false);
  f.node('mpPickCancel').onclick(); assert.equal(await result, null);
  assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
});

test('opening a route releases the picker on the reused SDK', async () => {
  const f = fixture();
  const result = f.api.pickOnMap(); await flush();
  await f.api.open({}); assert.equal(await result, null);
  assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
  assert.equal(f.node('mpPickBar').hidden, true);
});

test('Start Preview preparation releases the picker without opening the tour overlay', async () => {
  const f = fixture();
  const result = f.api.pickOnMap(); await flush();
  await f.api.prepareWalk({}); assert.equal(await result, null);
  assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
  assert.equal(f.node('mpPickBar').hidden, true);
  assert.equal(f.node('mpPickGo').onclick, null);
  assert.equal(f.node('mpPickCancel').onclick, null);
});

for (const failure of ['transition', 'pointer', 'interval']) {
  test(`${failure} failure settles the picker and releases partial setup`, async () => {
    const f = fixture();
    if (failure === 'transition') f.transition(async () => { throw Error('transition failed'); });
    if (failure === 'pointer') f.pointerFailure();
    if (failure === 'interval') f.intervalFailure();
    assert.equal(await f.api.pickOnMap(), null);
    assert.deepEqual(f.counts(), {subscriptions: 0, timers: 0});
    assert.equal(f.node('mpPickBar').hidden, true);
    assert.equal(f.node('mpPickGo').onclick, null);
    assert.equal(f.node('mpPickCancel').onclick, null);
  });
}
