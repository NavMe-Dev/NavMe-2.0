const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_app.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = (status, data, retryAfter) => ({ok: status >= 200 && status < 300, status,
  headers: {get: () => retryAfter ?? null}, json: async () => data});

async function fixture(respond) {
  const requests = [], scheduled = [], waits = [], events = [], failures = [], sdk = {};
  const core = {building_slug: 'gcu', pois: [{id: '9', name: 'Library', x: 1, y: 0, z: 2}],
    categories: [], stair_chains: [], georef: {model_to_epsg3857_affine: [[1, 0, 0], [0, 1, 0]]}};
  const values = {shops: [{poi_id: '9', description: 'Shop details'}], 'ar-experience-ref': {experience_ref: 'configured-ar'},
    translations: {poi_names: {'9': {fr: 'Bibliothèque'}}, category_names: {}}};
  const context = {window: null, document: {getElementById: () => null},
    console: {warn() {}, error: (...args) => failures.push(args)}, Event: class {}, dispatchEvent: event => events.push(event),
    Date: class extends Date { static now() { return Date.parse('2026-11-21T12:00:00Z'); } },
    setTimeout(callback, delay) { waits.push(delay); scheduled.push(callback); },
    WF: {configReady: Promise.resolve(), ready: Promise.resolve(), cfg: {floors: [{id: 'F1', elevation: 0}]}, building: {slug: 'gcu'}},
    __mpSdk: sdk, MP_SDK: {connect() { throw new Error('optional metadata must not initialize the SDK'); }},
    fetch: async url => {
      const endpoint = url.split('/').at(-1); requests.push(endpoint);
      if (endpoint === 'viewer-data') return response(200, core);
      const attempt = requests.filter(value => value === endpoint).length;
      return await respond?.(endpoint, attempt, values[endpoint]) || response(200, values[endpoint]);
    }};
  context.window = context; vm.runInNewContext(source, context); await flush();
  assert.deepEqual(failures, []); assert.ok(context.wf?.ready);
  return {context, requests, waits, scheduled, sdk, events,
    async advance() { const callback = scheduled.shift(); assert.ok(callback, 'a retry is scheduled'); callback(); await flush(); },
    count: endpoint => requests.filter(value => value === endpoint).length};
}

test('transient metadata failures hydrate configured AR, shops and translations without blocking core or reconnecting the twin', async () => {
  const f = await fixture((_endpoint, attempt) => attempt === 1 ? response(503) : undefined);
  const runtime = f.context.wf;
  assert.equal(runtime.pois[0].name, 'Library'); assert.equal(f.context.WF.arExperienceRef, null);
  assert.equal(f.scheduled.length, 3); assert.equal(f.count('viewer-data'), 1);
  let hydrated = false; f.context.WF.metadataReady.then(() => { hydrated = true; }); await flush();
  assert.equal(hydrated, false);
  while (f.scheduled.length) await f.advance();
  await f.context.WF.metadataReady;
  assert.equal(f.context.WF.arExperienceRef, 'configured-ar');
  assert.equal(f.context.WF.shopsByPoiId['9'].description, 'Shop details');
  assert.equal(runtime.pois[0].names.fr, 'Bibliothèque');
  assert.equal(f.context.wf, runtime); assert.equal(f.context.__mpSdk, f.sdk);
  assert.equal(f.count('viewer-data'), 1); assert.equal(f.count('ar-experience-ref'), 2);
});

for (const status of [429, 502, 503, 504, 'network']) {
  test(`${status} failures stop after three optional requests with bounded default backoff`, async () => {
    const f = await fixture(endpoint => {
      if (endpoint !== 'ar-experience-ref') return;
      if (status === 'network') throw new TypeError('Failed to fetch');
      return response(status);
    });
    assert.equal(f.count('ar-experience-ref'), 1);
    await f.advance(); await f.advance(); await f.context.WF.metadataReady;
    assert.equal(f.count('ar-experience-ref'), 3);
    assert.deepEqual(f.waits, [500, 1000]); assert.equal(f.scheduled.length, 0);
    assert.equal(f.context.WF.arExperienceRef, null); assert.equal(f.context.wf.ready, true);
  });
}

for (const [header, delay] of [['2', 2000], ['999', 10000], ['0', 0],
  ['Sat, 21 Nov 2026 12:00:05 GMT', 5000], ['Sat, 21 Nov 2026 11:59:00 GMT', 0], ['invalid', 500]]) {
  test(`Retry-After ${JSON.stringify(header)} yields a bounded ${delay}ms retry`, async () => {
    const f = await fixture((endpoint, attempt) => endpoint === 'ar-experience-ref' && attempt === 1 ? response(503, null, header) : undefined);
    assert.deepEqual(f.waits, [delay]); await f.advance(); await f.context.WF.metadataReady;
    assert.equal(f.context.WF.arExperienceRef, 'configured-ar'); assert.equal(f.count('ar-experience-ref'), 2);
  });
}

for (const status of [400, 401, 403, 404, 500]) {
  test(`permanent HTTP ${status} keeps its fallback without retries`, async () => {
    const f = await fixture(endpoint => endpoint === 'ar-experience-ref' ? response(status) : undefined);
    await f.context.WF.metadataReady;
    assert.equal(f.count('ar-experience-ref'), 1); assert.equal(f.waits.length, 0);
    assert.equal(f.context.WF.arExperienceRef, null);
  });
}

test('an unpublished successful AR response is not retried', async () => {
  const f = await fixture(endpoint => endpoint === 'ar-experience-ref' ? response(200, {experience_ref: null}) : undefined);
  await f.context.WF.metadataReady;
  assert.equal(f.count('ar-experience-ref'), 1); assert.equal(f.waits.length, 0);
  assert.equal(f.context.WF.arExperienceRef, null);
});

test('invalid metadata JSON falls back without treating a content error as a network failure', async () => {
  const f = await fixture(endpoint => endpoint === 'ar-experience-ref'
    ? {...response(200), json: async () => { throw new SyntaxError('Invalid JSON'); }} : undefined);
  await f.context.WF.metadataReady;
  assert.equal(f.count('ar-experience-ref'), 1); assert.equal(f.waits.length, 0);
  assert.equal(f.context.WF.arExperienceRef, null);
});
