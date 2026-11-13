/* Read-only production baseline. Never logs in, publishes, or changes application data.
 * Usage: PLAYWRIGHT_MODULE=/path/to/playwright node platform/tools/production_smoke.cjs
 * Optional BASE_URL and EVIDENCE_DIR; artifacts are private by default (platform/var/).
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BASE_URL || 'https://wayfinding.navme.space').replace(/\/$/, '');
const out = path.resolve(process.env.EVIDENCE_DIR || 'platform/var/production-migration/browser');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const safeUrl = input => { try { const u = new URL(input); return u.origin + u.pathname; } catch { return String(input); } };
const redact = value => String(value)
  .replace(/postgres(?:ql)?(?:\+\w+)?:\/\/[^\s)]+/gi, '[redacted database URL]')
  .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1?[redacted]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]');
const viewports = [
  ['desktop', 1440, 900], ['tablet', 768, 1024],
  ['mobile', 390, 844], ['small-mobile', 360, 800],
];
const check = (name, passed, detail) => ({ name, status: passed ? 'PASS' : 'FAIL', detail });

async function capture(browser, [name, width, height]) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 768, hasTouch: width < 1024 });
  const page = await context.newPage();
  const consoleMessages = [], failedRequests = [], errors = [], responses = [];
  page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) consoleMessages.push({ type: msg.type(), text: redact(msg.text()) }); });
  page.on('pageerror', e => errors.push(redact(e.message)));
  page.on('requestfailed', req => failedRequests.push({ url: safeUrl(req.url()), error: req.failure()?.errorText }));
  page.on('response', response => {
    if (response.status() >= 400 || /manifest\.json|js\.arcgis\.com\/4\.34\/$/.test(response.url()))
      responses.push({ url: safeUrl(response.url()), status: response.status() });
  });
  const start = performance.now();
  const response = await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.wf?.ready || document.body.innerText.includes('Map unavailable'), null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => {
    const rect = element => { const b = element.getBoundingClientRect(); return { width: b.width, height: b.height, x: b.x, y: b.y }; };
    const buttons = [...document.querySelectorAll('button')].filter(e => /Try Again|Retry/i.test(e.textContent) && e.getBoundingClientRect().height > 0);
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource').filter(e => /manifest\.json|js\.arcgis\.com\/4\.34\/$/.test(e.name));
    return {
      title: document.title, bodyText: document.body.innerText.slice(0, 1600),
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      sdkLoaderAvailable: typeof window.require === 'function', mapReady: !!window.wf?.ready,
      mapCanvasCount: document.querySelectorAll('#viewDiv canvas').length,
      floorButtons: document.querySelectorAll('#floorList button').length,
      searchReady: !!window.wfUI, errorVisible: document.body.innerText.includes('Map unavailable'),
      untranslatedError: document.body.innerText.includes('viewer.loadError'),
      retryButtons: buttons.map(rect),
      performance: nav ? { domContentLoadedMs: nav.domContentLoadedEventEnd, loadEventMs: nav.loadEventEnd, responseEndMs: nav.responseEnd } : null,
      resources: resources.map(e => ({ path: new URL(e.name).origin + new URL(e.name).pathname, durationMs: e.duration, transferSize: e.transferSize })),
    };
  });
  const checks = [
    check('public HTML', response.status() === 200, `HTTP ${response.status()}`),
    check('no horizontal overflow', state.documentWidth <= width, `${state.documentWidth}px document / ${width}px viewport`),
    check('ArcGIS loader available', state.sdkLoaderAvailable, 'Loader availability alone does not establish map rendering'),
    check('map and application initialized', state.mapReady && state.mapCanvasCount > 0 && state.searchReady, `ready=${state.mapReady}, canvas=${state.mapCanvasCount}, UI=${state.searchReady}`),
    check('human-readable startup error', !state.untranslatedError, state.errorVisible ? 'Startup failure shown' : 'No failure message'),
    check('retry control present', state.retryButtons.length > 0 || state.mapReady, `${state.retryButtons.length} visible retry button(s)`),
  ];
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  const retry = page.getByRole('button', { name: /Try Again|Retry/i }).first();
  let retryResult = 'not applicable';
  if (state.retryButtons.length) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), retry.click()]);
    await page.waitForTimeout(3000);
    retryResult = await page.evaluate(() => document.body.innerText.includes('Map unavailable') ? 'failure persists after reload' : (window.wf?.ready ? 'map initialized' : 'still loading'));
    checks.push(check('retry recovers map', retryResult === 'map initialized', retryResult));
  }
  await context.close();
  return { name, viewport: { width, height }, elapsedMs: performance.now() - start, state, retryResult, checks, consoleMessages, pageErrors: errors, failedRequests, responses };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { recordedAt: new Date().toISOString(), base, browserVersion: browser.version(), scope: 'Read-only live baseline; no production mutations', api: [], viewports: [] };
  const request = await browser.newContext();
  for (const [name, endpoint, expected] of [
    ['backend health', '/api/health', 200],
    ['published venue manifest', '/api/v1/public/venues/all/manifest.json', 200],
    ['missing venue', '/api/v1/public/venues/navme-qa-nonexistent/manifest.json', 404],
    ['admin HTML', '/admin/', 200],
  ]) {
    const start = performance.now();
    try {
      const response = await request.request.get(base + endpoint, { timeout: 45000 });
      const text = await response.text();
      let validJson = true; try { JSON.parse(text); } catch { validJson = false; }
      report.api.push({ name, path: endpoint, status: response.status(), expected, elapsedMs: performance.now() - start, validJson, check: check(name, response.status() === expected, `HTTP ${response.status()}`) });
    } catch (e) { report.api.push({ name, path: endpoint, error: redact(e.message), check: check(name, false, 'request failed') }); }
  }
  await request.close();
  // Sequential pages keep client load modest and preserve independent device contexts.
  for (const viewport of viewports) report.viewports.push(await capture(browser, viewport));
  await browser.close();
  const checks = [...report.api.map(r => r.check), ...report.viewports.flatMap(r => r.checks)];
  report.summary = { executed: checks.length, passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length, blocked: ['venue/building/floor/POI interaction', 'search and routing', 'admin authentication and authorization', 'real data rendering timings'] };
  fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
  console.log(JSON.stringify({ evidence: out, summary: report.summary, api: report.api, devices: report.viewports.map(r => ({ name: r.name, checks: r.checks, state: r.state })) }, null, 2));
})().catch(e => { console.error(redact(e.stack)); process.exitCode = 1; });
