const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../viewer/ui.js'), 'utf8');
const start = source.indexOf('    $("btnMe").onclick = () => {');
const end = source.indexOf('    $("floorList").onclick', start);
assert.ok(start >= 0 && end > start);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function fixture() {
  const classes = new Set(), attrs = new Map(), messages = [];
  const icon = {textContent: 'my_location'};
  const btn = {disabled: false, classList: {toggle(name, on) { on ? classes.add(name) : classes.delete(name); }},
    querySelector: () => icon, setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name)};
  let calls = 0, resolve, reject;
  const context = {window: null, $: id => id === 'btnMe' ? btn : {}, isMpMode: () => true,
    document: {body: {classList: {remove() {}}}}, t: key => key, toast: value => messages.push(value),
    MpPreview: {toggleHomeView() { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); }}};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return {btn, icon, attrs, classes, messages, calls: () => calls,
    resolve: value => resolve(value), reject: () => reject(new Error('camera failed'))};
}

test('the home button prevents duplicate clicks and clears busy state after success', async () => {
  const f = fixture();
  f.btn.onclick(); f.btn.onclick();
  assert.equal(f.calls(), 1);
  assert.equal(f.btn.disabled, true);
  assert.equal(f.attrs.get('aria-busy'), 'true');
  f.resolve({active: true, ok: true}); await flush();
  assert.equal(f.btn.disabled, false);
  assert.equal(f.attrs.has('aria-busy'), false);
  assert.equal(f.icon.textContent, 'arrow_back');
  assert.equal(f.classes.has('on'), true);
  assert.deepEqual(f.messages, []);
});

test('a stale home result cannot change the button icon', async () => {
  const f = fixture(); f.btn.onclick();
  f.resolve({active: true, ok: false, stale: true}); await flush();
  assert.equal(f.icon.textContent, 'my_location');
  assert.equal(f.btn.disabled, false);
  assert.deepEqual(f.messages, []);
});

for (const rejected of [false, true]) {
  test(`a ${rejected ? 'rejected' : 'failed'} camera transition leaves the button retryable`, async () => {
    const f = fixture(); f.btn.onclick();
    if (rejected) f.reject(); else f.resolve({active: true, ok: false});
    await flush();
    assert.equal(f.btn.disabled, false);
    assert.equal(f.attrs.has('aria-busy'), false);
    assert.deepEqual(f.messages, ['viewer.mpViewFailed']);
    if (!rejected) assert.equal(f.icon.textContent, 'arrow_back');
    f.btn.onclick(); assert.equal(f.calls(), 2);
  });
}
