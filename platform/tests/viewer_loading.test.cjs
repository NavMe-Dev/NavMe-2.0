const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_app.js'), 'utf8');

function runtime({rejectCore = false} = {}) {
  let releaseMetadata;
  const metadata = new Promise(resolve => { releaseMetadata = resolve; });
  const events = [], failures = [], errors = [];
  const core = {building_slug: 'campus', pois: [{id: 'p1', name: 'Office', category: 'office', x: 1, y: 0, z: 2}],
    categories: [{id: 'c1', name: 'Office'}], stair_chains: [],
    georef: {model_to_epsg3857_affine: [[1,0,0],[0,1,0]]}};
  const context = {console: {error: e => errors.push(e), warn() {}}, Event, dispatchEvent: e => events.push(e.type),
    document: {getElementById: () => null}, innerWidth: 1000, innerHeight: 800,
    window: null, WF: {ready: Promise.resolve(), building: {slug: 'campus'},
      cfg: {floors: [{id: 'F1', label: 'Ground', elevation: 0}], files: {georef: 'georef.json'}},
      D: f => '/data/' + f},
    WFStartup: {fail: () => failures.push(true)},
    fetch: async url => {
      if (url.endsWith('viewer-data')) {
        if (rejectCore) throw new Error('backend unavailable');
        return {ok: true, json: async () => core};
      }
      if (url.endsWith('georef.json')) return {ok: true, json: async () => ({model_to_epsg3857_affine: [[1,0,0],[0,1,0]]})};
      await metadata;
      const data = url.endsWith('shops') ? [{poi_id: 'p1', description: 'Shop detail'}]
        : url.endsWith('ar-experience-ref') ? {experience_ref: 'experience'}
        : {poi_names: {p1: {es: 'Oficina'}}, category_names: {c1: {es: 'Oficinas'}}};
      return {ok: true, json: async () => data};
    }};
  context.window = context;
  vm.runInNewContext(source, context);
  return {context, events, failures, errors, releaseMetadata};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('POI runtime starts while optional metadata is stalled, then hydrates it', async () => {
  const r = runtime();
  await tick();
  assert.equal(r.context.wf.ready, true);
  assert.equal(r.context.wf.pois[0].name, 'Office');
  assert.equal(r.context.wf.pois[0].names, null);
  assert.ok(r.events.includes('wf-pois-updated'));
  assert.equal(r.events.includes('wf-metadata-updated'), false);
  r.releaseMetadata();
  await r.context.WF.metadataReady;
  assert.equal(r.context.wf.pois[0].names.es, 'Oficina');
  assert.equal(r.context.wf.categories[0].names.es, 'Oficinas');
  assert.equal(r.context.WF.shopsByPoiId.p1.description, 'Shop detail');
  assert.equal(r.context.WF.arExperienceRef, 'experience');
  assert.ok(r.events.includes('wf-metadata-updated'));
  assert.equal(r.failures.length, 0);
});

test('required POI failure fails startup instead of presenting an empty campus', async () => {
  const r = runtime({rejectCore: true});
  await tick();
  assert.equal(r.context.wf, undefined);
  assert.equal(r.failures.length, 1);
  r.releaseMetadata();
});
