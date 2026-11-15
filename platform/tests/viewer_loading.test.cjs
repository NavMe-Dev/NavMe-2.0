const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_app.js'), 'utf8');

function runtime({rejectCore = false, holdFloors = false, rejectConfig = false, deriveBands = false,
  poiDetails = {}, categoryDetails = {}, translations} = {}) {
  let releaseMetadata, releaseFloors;
  const metadata = new Promise(resolve => { releaseMetadata = resolve; });
  const floors = new Promise(resolve => { releaseFloors = resolve; });
  const events = [], failures = [], errors = [];
  let navmeshReady = false, navmeshOptions;
  const core = {building_slug: 'campus', pois: [{id: 'p1', name: 'Office', category: 'office', x: 1, y: 0, z: 2, ...poiDetails}],
    categories: [{id: 'c1', name: 'Office', ...categoryDetails}], stair_chains: [],
    georef: {model_to_epsg3857_affine: [[1,0,0],[0,1,0]]}};
  const context = {console: {error: e => errors.push(e), warn() {}}, Event, dispatchEvent: e => events.push(e.type),
    document: {getElementById: () => null}, innerWidth: 1000, innerHeight: 800,
    window: null, WF: {ready: holdFloors ? floors : Promise.resolve(),
      configReady: rejectConfig ? Promise.reject(new Error('published config unavailable')) : Promise.resolve(),
      building: {slug: 'campus'},
      cfg: {floors: [{id: 'F1', label: 'Ground', elevation: 0}], files: {georef: 'georef.json'}},
      D: f => '/data/' + f},
    WFStartup: {fail: () => failures.push(true)},
    WFNavmeshRoute: deriveBands ? {deriveLevels: () => [{lo: -1, hi: 1, mid: 0}]} : undefined,
    WFNav: {
      navmeshReady: () => navmeshReady,
      initNavmesh: async (_slug, options) => { navmeshOptions = options; navmeshReady = true; },
      routeNavmesh: () => ({error: 'no route'}),
    },
    fetch: async url => {
      if (url.endsWith('viewer-data')) {
        if (rejectCore) throw new Error('backend unavailable');
        return {ok: true, json: async () => core};
      }
      if (url.endsWith('georef.json')) return {ok: true, json: async () => ({model_to_epsg3857_affine: [[1,0,0],[0,1,0]]})};
      await metadata;
      const data = url.endsWith('shops') ? [{poi_id: 'p1', description: 'Shop detail'}]
        : url.endsWith('ar-experience-ref') ? {experience_ref: 'experience'}
        : translations === undefined ? {poi_names: {p1: {es: 'Oficina'}}, category_names: {c1: {es: 'Oficinas'}}} : translations;
      return {ok: true, json: async () => data};
    }};
  context.window = context;
  vm.runInNewContext(source, context);
  return {context, events, failures, errors, releaseMetadata, releaseFloors,
    get navmeshOptions() { return navmeshOptions; }};
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

test('POIs and routing initialize before optional floors, then hydrate authored floor names', async () => {
  const r = runtime({holdFloors: true, deriveBands: true});
  await tick();
  assert.equal(r.context.wf.ready, true);
  assert.equal(r.context.wf.pois[0].name, 'Office');
  assert.equal(r.context.wf.pois[0].floor, 'F1');
  assert.equal(r.context.wf.floorLabel('F1'), 'Ground');
  assert.equal(r.events.includes('wf-floors-updated'), false);
  assert.equal(r.events.includes('wf-metadata-updated'), false);
  r.context.wf.route('p1', 'p1');
  await tick();
  assert.equal(r.navmeshOptions.floors[0].label, 'Ground');
  const wf = r.context.wf, poi = wf.pois[0];
  r.context.WF.cfg.floors[0].label = 'First Floor';
  r.releaseFloors();
  await tick();
  assert.equal(r.context.wf, wf, 'floor metadata must not recreate the runtime');
  assert.equal(r.context.wf.pois[0], poi, 'floor metadata must not replace POIs or their floor IDs');
  assert.equal(r.context.wf.pois[0].floor, 'F1');
  assert.equal(r.context.wf.floorLabel('F1'), 'First Floor');
  assert.equal(r.navmeshOptions.floors[0].label, 'First Floor');
  assert.equal(r.events.filter(event => event === 'wf-floors-updated').length, 1);
  assert.equal(r.failures.length, 0);
  assert.equal(r.errors.length, 0);
  r.releaseMetadata();
  await r.context.WF.metadataReady;
});

test('invalid required configuration fails before exposing POIs even if optional floors remain pending', async () => {
  const r = runtime({holdFloors: true, rejectConfig: true});
  await tick();
  assert.equal(r.context.wf, undefined);
  assert.equal(r.failures.length, 1);
  assert.equal(r.events.includes('wf-pois-updated'), false);
  r.releaseFloors();
  r.releaseMetadata();
});

for (const translations of [{}, {
  poi_names: {p1: {en: 'Old office', es: 'Oficina antigua', fr: 'Bureau'}},
  category_names: {c1: {en: 'Old category', es: 'Categoría antigua', fr: 'Bureaux'}},
}]) {
  test(`current Studio details survive ${Object.keys(translations).length ? 'older' : 'empty'} optional translations`, async () => {
    const r = runtime({translations, poiDetails: {
      name: '110 Office', names: {en: '110 Office', es: 'Oficina 110'},
      description: 'Current Studio description', descriptions: {es: 'Descripción actual'},
      amenities_desc: 'Seating', highlight_desc: 'Campus office', technology_desc: 'Wi-Fi',
      icon_url: 'https://example.test/icon.png', code: '110', hours: '9–5',
      photo_url: 'https://example.test/photo.png', photo_urls: ['https://example.test/photo.png'],
    }, categoryDetails: {names: {en: 'Current category', es: 'Categoría actual'}}});
    await tick();
    const p = r.context.wf.pois[0];
    assert.equal(p.description, 'Current Studio description');
    assert.equal(p.descriptions.es, 'Descripción actual');
    assert.equal(p.names.en, '110 Office');
    assert.equal(p.amenities_desc, 'Seating');
    assert.equal(p.highlight_desc, 'Campus office');
    assert.equal(p.technology_desc, 'Wi-Fi');
    assert.equal(p.icon_url, 'https://example.test/icon.png');
    assert.equal(p.hours, '9–5');
    assert.equal(p.photo_url, 'https://example.test/photo.png');
    assert.equal(p.photo_urls[0], 'https://example.test/photo.png');
    r.releaseMetadata();
    await r.context.WF.metadataReady;
    assert.equal(p.names.en, '110 Office');
    assert.equal(p.names.es, 'Oficina 110');
    assert.equal(p.description, 'Current Studio description');
    assert.equal(p.descriptions.es, 'Descripción actual');
    assert.equal(r.context.wf.categories[0].names.es, 'Categoría actual');
    if (translations.poi_names) assert.equal(p.names.fr, 'Bureau');
    assert.equal(r.failures.length, 0);
  });
}

test('description localization returns to source text when a locale has no translation', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../viewer/ui.js'), 'utf8');
  const start = ui.indexOf('  function localizePoiDetails(');
  const end = ui.indexOf('  const CAT_BASE', start);
  let locale = 'es';
  const localize = vm.runInNewContext('(' + ui.slice(start, end).trim() + ')', {
    localized: (values, fallback) => values[locale] || values.en || fallback,
  });
  const p = {name: '110 Office', description: 'Source description',
    names: {es: 'Oficina 110'}, descriptions: {es: 'Descripción actual'}};
  localize(p);
  assert.equal(p.description, 'Descripción actual');
  locale = 'fr'; localize(p);
  assert.equal(p.name, '110 Office');
  assert.equal(p.description, 'Source description');
  locale = 'es'; localize(p);
  assert.equal(p.description, 'Descripción actual');
  assert.equal(p.base_description, 'Source description');
});
