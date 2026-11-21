const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_preview.js'), 'utf8');
function fixture() {
  const scripts = [], timers = new Map();
  let nextTimer = 0;
  const context = {window: null, document: {
    createElement: () => ({remove() { this.removed = true; }}),
    head: {appendChild: script => scripts.push(script)},
  }, setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
  clearTimeout: id => timers.delete(id)};
  context.window = context;
  vm.runInNewContext(source.replace('  window.MpPreview = {',
    '  window.__loadSdkForTest = loadSdkScript;\n  window.MpPreview = {'), context);
  return {context, scripts, timers, load: () => context.__loadSdkForTest(),
    expire() {
      assert.equal(timers.size, 1);
      const pending = [...timers.values()]; timers.clear();
      pending.forEach(timer => { assert.equal(timer.delay, 30000); timer.callback(); });
    }};
}

test('SDK bootstrap shares one pending load and clears its timer when the API is ready', async () => {
  const f = fixture(), first = f.load(), second = f.load();
  assert.equal(first, second);
  assert.equal(f.scripts.length, 1);
  f.context.MP_SDK = {connect() {}};
  f.scripts[0].onload(); await first;
  assert.equal(f.timers.size, 0);
  await f.load(); assert.equal(f.scripts.length, 1);
});

test('a stalled SDK script rejects and an explicit next attempt can load a fresh script', async () => {
  const f = fixture(), first = f.load();
  const failure = assert.rejects(first, /bootstrap timed out/);
  f.expire(); await failure;
  assert.equal(f.scripts[0].removed, true);
  assert.equal(f.scripts[0].onload, null);
  assert.equal(f.scripts[0].onerror, null);
  const retry = f.load(); assert.equal(f.scripts.length, 2);
  f.context.MP_SDK = {connect() {}};
  f.scripts[1].onload(); await retry;
  assert.equal(f.timers.size, 0);
});

for (const kind of ['network-error', 'missing-api']) {
  test(`SDK bootstrap ${kind} fails cleanly without retaining a script or deadline`, async () => {
    const f = fixture(), attempt = f.load();
    const failure = assert.rejects(attempt, /SDK bootstrap/);
    if (kind === 'network-error') f.scripts[0].onerror();
    else f.scripts[0].onload();
    await failure;
    assert.equal(f.timers.size, 0);
    assert.equal(f.scripts[0].removed, true);
    const retry = f.load();
    assert.equal(f.scripts.length, 2);
    f.context.MP_SDK = {connect() {}}; f.scripts[1].onload(); await retry;
  });
}
