const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../viewer/venue_info.js');
const context = (slug = 'a', modelId = 'space-a') => ({ slug, modelId, name: 'NavMe fallback ' + slug, address: 'Address' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('uses verified current Matterport name and preserves the venue identifier', async () => {
  const applied = [];
  const c = create({ fetchInfo: async () => ({ building_slug: 'a', model_id: 'space-a', name: 'Actual Matterport Name', source: 'matterport' }), apply: info => applied.push(info) });
  await c.load(context());
  assert.equal(c.get().name, 'Actual Matterport Name'); assert.equal(c.get().building_slug, 'a');
  assert.equal(applied[0].name, 'NavMe fallback a');
});
test('name lookup never blocks fallback rendering', async () => {
  const pending = deferred(), applied = [];
  const c = create({ fetchInfo: () => pending.promise, apply: info => applied.push(info) });
  const task = c.load(context());
  assert.equal(applied[0].name, 'NavMe fallback a');
  pending.resolve({ building_slug: 'a', model_id: 'space-a', name: 'Loaded', source: 'matterport' }); await task;
});
test('late metadata cannot put the previous venue name back after switching', async () => {
  const a = deferred(), b = deferred();
  const c = create({ fetchInfo: slug => slug === 'a' ? a.promise : b.promise, apply() {} });
  const old = c.load(context()); const current = c.load(context('b', 'space-b'));
  assert.equal(c.get().name, 'NavMe fallback b');
  b.resolve({ building_slug: 'b', model_id: 'space-b', name: 'Space B', source: 'matterport' }); await current;
  a.resolve({ building_slug: 'a', model_id: 'space-a', name: 'Space A', source: 'matterport' }); await old;
  assert.equal(c.get().name, 'Space B');
});
test('rejects metadata from an unrelated model', async () => {
  const c = create({ fetchInfo: async () => ({ building_slug: 'a', model_id: 'wrong', name: 'Wrong', source: 'matterport' }), apply() {} });
  await c.load(context()); assert.equal(c.get().name, 'NavMe fallback a');
  assert.equal(c.acceptSdk({ sid: 'wrong', name: 'Wrong' }, context()), false);
});
test('metadata failure retains the current NavMe name and a useful diagnostic', async () => {
  const diagnostics = [];
  const c = create({ fetchInfo: async () => { throw new Error('private detail'); }, apply() {}, diagnostic: text => diagnostics.push(text) });
  await c.load(context()); assert.equal(c.get().name, 'NavMe fallback a');
  assert.equal(diagnostics.length, 1); assert.ok(!diagnostics[0].includes('private detail'));
});
test('a verified connected SDK name cannot be overwritten by a later branding fallback', async () => {
  const pending = deferred();
  const c = create({ fetchInfo: () => pending.promise, apply() {} });
  const task = c.load(context());
  assert.equal(c.acceptSdk({ sid: 'space-a', name: 'SDK Name', description: 'Description', formattedAddress: 'SDK Address' }, context()), true);
  pending.resolve({ building_slug: 'a', model_id: 'space-a', name: 'Hardcoded branding', source: 'navme' }); await task;
  assert.equal(c.get().name, 'SDK Name'); assert.equal(c.get().description, 'Description'); assert.equal(c.get().address, 'SDK Address');
});
test('uses a neutral fallback when no valid name exists, and only fetches once per page/context', async () => {
  let fetched = 0;
  const c = create({ fetchInfo: async () => { fetched++; return {}; }, apply() {} });
  await c.load({ slug: 'a', modelId: 'space-a', name: ' ' });
  await c.load({ slug: 'a', modelId: 'space-a', name: ' ' });
  assert.equal(c.get().name, 'Venue information'); assert.equal(fetched, 1);
});
test('changing the Matterport model on the same venue resets the name and rejects the old response', async () => {
  const old = deferred(), next = deferred(); let calls = 0;
  const c = create({ fetchInfo: () => ++calls === 1 ? old.promise : next.promise, apply() {} });
  const first = c.load(context('a', 'old-model'));
  const second = c.load(context('a', 'new-model'));
  next.resolve({ building_slug: 'a', model_id: 'new-model', name: 'New space', source: 'matterport' }); await second;
  old.resolve({ building_slug: 'a', model_id: 'old-model', name: 'Old space', source: 'matterport' }); await first;
  assert.equal(c.get().name, 'New space'); assert.equal(c.get().model_id, 'new-model');
});
