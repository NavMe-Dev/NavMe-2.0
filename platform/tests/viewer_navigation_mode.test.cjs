const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const viewer = path.resolve(__dirname, '../viewer');

function loadFunction(file, name, context) {
  const source = fs.readFileSync(path.join(viewer, file), 'utf8');
  const start = source.search(new RegExp('function ' + name + '\\('));
  assert.ok(start >= 0, name);
  for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
    try {
      return new vm.Script('(' + source.slice(start, end + 1) + ')').runInNewContext(context);
    } catch (_) {}
  }
  throw new Error('Cannot parse ' + name);
}

test('building switches preserve Matterport mode', () => {
  const location = {href: 'https://wayfinding.navme.space/?b=gcu&mp=1', search: '?b=gcu&mp=1'};
  const goBuilding = loadFunction('ui.js', 'goBuilding', {URL, URLSearchParams, location});
  goBuilding('uncc-main-campus');
  const next = new URL(location.href);
  assert.equal(next.searchParams.get('b'), 'uncc-main-campus');
  assert.equal(next.searchParams.get('mp'), '1');
});

test('selecting UNCC enables Matterport mode from a 2D session', () => {
  const location = {href: 'https://wayfinding.navme.space/?b=gcu', search: '?b=gcu'};
  const goBuilding = loadFunction('ui.js', 'goBuilding', {URL, URLSearchParams, location});
  goBuilding('uncc-main-campus');
  assert.equal(new URL(location.href).searchParams.get('mp'), '1');
});

test('chat deep links preserve active Matterport mode', () => {
  const location = {origin: 'https://wayfinding.navme.space', search: '?b=gcu&mp=1'};
  const preserve = loadFunction('wf_chat.js', 'preserveViewerMode', {URL, URLSearchParams, location});
  const next = preserve('/?b=uncc-main-campus&to=library');
  assert.equal(next.searchParams.get('mp'), '1');
  assert.equal(next.searchParams.get('to'), 'library');
});

test('chat links enable Matterport mode when their destination is UNCC', () => {
  const location = {origin: 'https://wayfinding.navme.space', search: '?b=gcu'};
  const preserve = loadFunction('wf_chat.js', 'preserveViewerMode', {URL, URLSearchParams, location});
  assert.equal(preserve('/?b=uncc-main-campus').searchParams.get('mp'), '1');
});

test('a bare UNCC URL is canonicalized to Matterport mode before boot', async () => {
  const source = fs.readFileSync(path.join(viewer, 'wf-boot.js'), 'utf8');
  let replaced = null;
  const location = {href: 'https://wayfinding.navme.space/?b=uncc-main-campus', search: '?b=uncc-main-campus'};
  const context = {
    URL, URLSearchParams, location,
    history: {replaceState(_state, _title, url) { replaced = url; location.href = url; location.search = new URL(url).search; }},
    window: {WF_CONFIG: {}}, navigator: {userAgent: '', platform: '', maxTouchPoints: 0},
    fetch: async () => { throw new Error('stop after canonicalization'); },
    document: {createElement: () => ({style: {}, setAttribute() {}, append() {}}), body: {appendChild() {}}},
    console: {error() {}},
  };
  vm.runInNewContext(source, context);
  await context.window.WF.ready.catch(() => {});
  assert.equal(new URL(replaced).searchParams.get('mp'), '1');
});

async function bootBuilding(search, buildings, configuredBuilding) {
  const source = fs.readFileSync(path.join(viewer, 'wf-boot.js'), 'utf8');
  const requests = [];
  const context = {
    URL, URLSearchParams,
    location: {href: 'https://wayfinding.navme.space/' + search, search},
    history: {replaceState() {}}, navigator: {userAgent: '', platform: '', maxTouchPoints: 0},
    window: {WF_CONFIG: {apiBase: '/api/v1/public/', building: configuredBuilding}},
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('manifest.json')) return {ok: true, json: async () => ({buildings})};
      if (url.endsWith('config.json')) return {ok: true, json: async () => ({name: 'UNCC', floors: [], files: {}})};
      return {ok: false, status: 404};
    },
    document: {
      documentElement: {style: {setProperty() {}}}, querySelectorAll: () => [], getElementById: () => null,
      createElement: () => ({style: {}, setAttribute() {}, append() {}}), body: {appendChild() {}},
    },
    console: {error() {}},
  };
  vm.runInNewContext(source, context);
  return {ready: context.window.WF.ready, requests, context};
}
const gcuPublication = {slug: 'gcu', data: 'buildings/gcu/data/'};
const unccPublication = {slug: 'uncc-main-campus', data: 'buildings/uncc-main-campus/data/'};

test('missing explicit campus rejects boot without fetching another campus config', async () => {
  const c = await bootBuilding('?b=uncc-main-campus&mp=1', [gcuPublication]);
  await assert.rejects(c.ready, /Requested building is not published: uncc-main-campus/);
  assert.equal(c.requests.some(url => url.endsWith('config.json')), false);
});

test('UNCC deep link selects UNCC even when GCU is first in the manifest', async () => {
  const c = await bootBuilding('?b=uncc-main-campus&mp=1', [gcuPublication, unccPublication]);
  await c.ready;
  assert.equal(c.context.window.WF.building.slug, 'uncc-main-campus');
  assert.ok(c.requests.includes('/api/v1/public/buildings/uncc-main-campus/data/config.json'));
  assert.equal(c.requests.includes('/api/v1/public/buildings/gcu/data/config.json'), false);
});

test('root links still choose the first published building', async () => {
  const c = await bootBuilding('?mp=1', [gcuPublication, unccPublication]);
  await c.ready;
  assert.equal(c.context.window.WF.building.slug, 'gcu');
});

test('configured missing building also rejects instead of silently substituting', async () => {
  const c = await bootBuilding('?mp=1', [gcuPublication], 'uncc-main-campus');
  await assert.rejects(c.ready, /Requested building is not published/);
});

test('UNCC short paths select the campus and Matterport without expanding the URL', () => {
  const html = fs.readFileSync(path.join(viewer, 'index.html'), 'utf8');
  const script = html.match(/<script>\s*(window.WF_ROUTE_ALIASES=[\s\S]*?)<\/script>/)[1];
  for (const pathname of ['/uncc-charlotte', '/uncc-charlotte/']) {
    const context = {window: {}, URLSearchParams, location: {pathname, search: ''}};
    vm.runInNewContext(script, context);
    const q = context.window.WFQuery();
    assert.equal(q.get('b'), 'uncc-main-campus');
    assert.equal(q.get('mp'), '1');
    assert.equal(context.location.pathname, pathname);
    assert.equal(context.location.search, '');
  }
});
