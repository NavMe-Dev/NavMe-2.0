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
    document: {createElement: () => ({style: {}, append() {}}), body: {appendChild() {}}},
    console: {error() {}},
  };
  vm.runInNewContext(source, context);
  await context.window.WF.ready.catch(() => {});
  assert.equal(new URL(replaced).searchParams.get('mp'), '1');
});
