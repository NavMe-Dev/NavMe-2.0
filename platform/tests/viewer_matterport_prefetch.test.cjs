const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function resolveConfig(context) {
  const source = fs.readFileSync(path.join(__dirname, '../viewer/mp_preview.js'), 'utf8');
  const start = source.indexOf('async function resolveConfig(');
  assert.ok(start >= 0);
  for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
    let script;
    try { script = new vm.Script('(' + source.slice(start, end + 1) + ')'); } catch (_) { continue; }
    return script.runInNewContext(context);
  }
  throw new Error('Cannot parse resolveConfig');
}

function response(status, data, onRead = () => {}) {
  return {ok: status >= 200 && status < 300, status, json: async () => { onRead(); return data; }};
}

function scenario({policy = {}, token = '', prefetch, pins = [], responses = []} = {}) {
  const calls = [], cleared = [];
  const cfg = {slug: 'campus', matterport_model_id: 'published-model'};
  const context = {
    URL, DEFAULT_MODEL: 'unrelated-default', modelId: '', applicationKey: '', accessToken: token,
    WF_CONFIG: {apiBase: '/api/v1/public/'}, window: null,
    WF: {ready: Promise.resolve(), configReady: Promise.resolve(), cfg,
      building: {slug: 'campus'}, matterportRequest: prefetch},
    readAccessPolicy: () => ({twin_disabled: false, embed_tour_allowed: true, twin_pin_required: false, ...policy}),
    promptAccessPin: () => pins.shift() || null,
    localStorage: {getItem: () => null},
    sessionStorage: {getItem: () => null, removeItem: key => cleared.push(key)},
    fetch: async (url, options) => {
      calls.push({url, options});
      assert.ok(responses.length, 'unexpected additional request');
      return responses.shift();
    },
  };
  context.window = context;
  return {context, calls, cleared, resolve: resolveConfig(context)};
}

function pending(data = {model_id: 'authorized-model', application_key: 'public-embed-key'}, overrides = {}) {
  return {slug: 'campus', apiBase: '/api/v1/public/', response: Promise.resolve(response(200, data)), ...overrides};
}

test('initial public model consumes its anonymous prefetch once and later opens refresh authorization', async () => {
  const c = scenario({prefetch: pending(), responses: [response(200, {model_id: 'current-model', application_key: 'current-key'})]});
  const first = await c.resolve();
  assert.equal(first.modelId, 'authorized-model');
  assert.equal(first.applicationKey, 'public-embed-key');
  assert.equal(c.calls.length, 0);
  assert.equal(c.context.WF.matterportRequest, null);
  const second = await c.resolve();
  assert.equal(second.modelId, 'current-model');
  assert.equal(second.applicationKey, 'current-key');
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].options.cache, 'no-store');
});

test('a prefetch from another campus or API cannot supply this model or key', async () => {
  for (const mismatch of [{slug: 'other-campus'}, {apiBase: 'https://other.invalid/api/'}]) {
    let reads = 0;
    const prefetch = pending(undefined, {...mismatch, response: Promise.resolve(response(200,
      {model_id: 'wrong-model', application_key: 'wrong-key'}, () => reads++))});
    const c = scenario({prefetch, responses: [response(200, {model_id: 'correct-model', application_key: 'correct-key'})]});
    const resolved = await c.resolve();
    assert.equal(resolved.modelId, 'correct-model');
    assert.equal(resolved.applicationKey, 'correct-key');
    assert.equal(c.calls.length, 1);
    assert.equal(reads, 0);
  }
});

test('PIN mode ignores anonymous prefetch and retains the failed-PIN retry', async () => {
  let anonymousReads = 0;
  const c = scenario({
    prefetch: pending(undefined, {response: Promise.resolve(response(403, {detail: 'PIN required'}, () => anonymousReads++))}),
    policy: {twin_pin_required: true}, pins: ['wrong-pin', 'correct-pin'],
    responses: [response(403, {detail: 'Access denied'}), response(200, {model_id: 'private-model', application_key: 'authorized-key'})],
  });
  const resolved = await c.resolve();
  assert.equal(resolved.modelId, 'private-model');
  assert.equal(resolved.applicationKey, 'authorized-key');
  assert.equal(anonymousReads, 0);
  assert.equal(c.context.WF.matterportRequest, null);
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[0].options.headers['X-WF-Access'], 'wrong-pin');
  assert.equal(new URL(c.calls[0].url, 'https://viewer.invalid').searchParams.get('access'), 'wrong-pin');
  assert.equal(c.calls[1].options.headers['X-WF-Access'], 'correct-pin');
  assert.deepEqual(c.cleared, ['wf_access_pin']);
});

test('an existing access token also bypasses anonymous prefetch', async () => {
  let reads = 0;
  const c = scenario({token: 'session-token',
    prefetch: pending(undefined, {response: Promise.resolve(response(200, {application_key: 'anonymous-key'}, () => reads++))}),
    responses: [response(200, {model_id: 'authorized-model', application_key: 'token-key'})]});
  const resolved = await c.resolve();
  assert.equal(resolved.applicationKey, 'token-key');
  assert.equal(reads, 0);
  assert.equal(c.calls[0].options.headers['X-WF-Access'], 'session-token');
});

test('policy denial prevents prefetched credentials from being consumed', async () => {
  for (const policy of [{twin_disabled: true}, {embed_tour_allowed: false}]) {
    let reads = 0;
    const c = scenario({policy, prefetch: pending(undefined, {response: Promise.resolve(response(200,
      {model_id: 'denied-model', application_key: 'denied-key'}, () => reads++))})});
    await assert.rejects(c.resolve(), error => ['twin_disabled', 'tour_not_public'].includes(error.code));
    assert.equal(reads, 0);
    assert.equal(c.calls.length, 0);
    assert.equal(c.context.applicationKey, '');
  }
});

test('a prefetched server denial fails instead of falling back to the published model', async () => {
  const c = scenario({prefetch: pending(undefined, {response: Promise.resolve(response(403, {detail: 'Access denied'}))})});
  await assert.rejects(c.resolve(), error => error.code === 'access_denied');
  assert.equal(c.calls.length, 0);
  assert.equal(c.context.applicationKey, '');
});
