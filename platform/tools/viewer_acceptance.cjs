/* Read-only public viewer acceptance against authentic published GCU v5 data.
 * Example: PLAYWRIGHT_BROWSERS_PATH=/private/tmp/navme-playwright-browsers \
 * PLAYWRIGHT_MODULE=/path/to/playwright BASE_URL=http://127.0.0.1:8782 \
 * node platform/tools/viewer_acceptance.cjs
 * Outgoing mutations are blocked; no login, editing, or publishing is performed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BASE_URL || 'http://127.0.0.1:8782').replace(/\/$/, '');
const expectedVersion = Number(process.env.EXPECTED_GCU_VERSION || 5);
const out = path.resolve(process.env.EVIDENCE_DIR || 'platform/var/production-migration/browser/shadow-gcu-v5');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const safeUrl = value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return String(value); } };
const redact = value => String(value).replace(/postgres(?:ql)?(?:\+\w+)?:\/\/[^\s)]+/gi, '[database URL redacted]')
  .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1?[redacted]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token redacted]');
const allDevices = [
  ['desktop', 1440, 900, false], ['tablet', 768, 1024, true],
  ['mobile', 390, 844, true], ['small-mobile', 360, 800, true],
];
const devices = process.env.DEVICES ? allDevices.filter(d => process.env.DEVICES.split(',').includes(d[0])) : allDevices;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

async function capture(browser, [name, width, height, touch]) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 768, hasTouch: touch });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const report = { name, viewport: { width, height }, checks: [], console: [], pageErrors: [], failedRequests: [], badResponses: [], blockedMutations: [], screenshots: [] };
  await context.route('**/*', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      report.blockedMutations.push({ method: route.request().method(), url: safeUrl(route.request().url()) });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page.on('console', m => { if (['warning', 'error'].includes(m.type())) report.console.push({ type: m.type(), message: redact(m.text()) }); });
  page.on('pageerror', e => report.pageErrors.push(redact(e.message)));
  page.on('requestfailed', r => report.failedRequests.push({ url: safeUrl(r.url()), error: r.failure()?.errorText }));
  page.on('response', r => { if (r.status() >= 400) report.badResponses.push({ url: safeUrl(r.url()), status: r.status() }); });
  const click = locator => touch ? locator.tap() : locator.click();
  const check = async (title, fn) => {
    const start = performance.now();
    try {
      const detail = await fn();
      report.checks.push({ name: title, status: 'PASS', elapsedMs: performance.now() - start, detail });
      console.log(JSON.stringify({ device: name, check: title, status: 'PASS' }));
      fs.writeFileSync(path.join(out, `${name}-progress.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      report.checks.push({ name: title, status: 'FAIL', elapsedMs: performance.now() - start, error: redact(e.message) });
      console.log(JSON.stringify({ device: name, check: title, status: 'FAIL', error: redact(e.message) }));
      fs.writeFileSync(path.join(out, `${name}-progress.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
      return false;
    }
  };
  const shot = async label => {
    const file = `${name}-${label}.png`;
    await page.waitForFunction(() => !window.wf?.view?.()?.animation, null, { timeout: 10000 }).catch(() => {});
    await page.screenshot({ path: path.join(out, file), fullPage: true, animations: 'disabled', timeout: 45000 });
    report.screenshots.push(file);
  };
  try {
    const started = performance.now();
    // Match the production root URL. Explicit ?b=gcu intentionally follows its
    // configured walkthrough URL and can leave a local shadow for production.
    const response = await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    report.htmlStatus = response.status();
    const ready = await check('authentic GCU v5 map initializes', async () => {
      ensure(response.status() === 200, `HTML HTTP ${response.status()}`);
      await page.waitForFunction(origin => location.origin !== origin || (window.wf?.ready && window.wf?.indoorReady && window.wfUI?.S && !document.body.classList.contains('booting')), new URL(base).origin, { timeout: 150000 });
      ensure(new URL(page.url()).origin === new URL(base).origin, `Viewer navigated outside tested origin: ${safeUrl(page.url())}`);
      await page.waitForFunction(() => wf.view()?.ready, null, { timeout: 45000 });
      await page.waitForFunction(() => !wf.view().updating, null, { timeout: 20000 }).catch(() => {});
      const state = await page.evaluate(() => ({
        slug: WF.building?.slug, version: WF.building?.version, model: WF.cfg?.matterport_model_id,
        viewReady: wf.view().ready, viewWidth: wf.view().width, viewHeight: wf.view().height,
        activeMode: wf.is3D() ? '3D' : '2D', updating: wf.view().updating,
        canvases: document.querySelectorAll('#viewDiv canvas').length,
        layers: wf.map2d.layers.length, pois: wf.pois.length,
        floors: WF.cfg.floors.length, currentFloor: wf.currentFloor(),
        poiGraphics: wf.view().map.layers.find(l => l.title === (wf.is3D() ? 'POIs 3D' : 'POIs'))?.graphics.length,
      }));
      ensure(state.slug === 'gcu' && state.version === expectedVersion && state.model === 'jdjvM17BPEh', `Unexpected published identity ${JSON.stringify(state)}`);
      ensure(state.viewReady && state.canvases > 0 && state.viewWidth > 0 && state.viewHeight > 0 && state.layers > 0, 'ArcGIS map is not ready');
      ensure(state.pois > 0 && state.floors > 0, 'Authentic places or floors missing');
      report.mapReadyMs = performance.now() - started;
      return state;
    });
    if (!ready) { await shot('startup-failed'); return report; }
    await page.waitForTimeout(1800);
    await shot('map');
    await check('no horizontal overflow on initial map', async () => {
      const size = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
      ensure(size.document <= size.viewport, JSON.stringify(size)); return size;
    });
    await check('POI markers are present in the rendered map', async () => {
      const state = await page.evaluate(() => ({ count: wf.pois.length, graphics: wf.view().map.layers.find(l => l.title === (wf.is3D() ? 'POIs 3D' : 'POIs'))?.graphics.length || 0 }));
      ensure(state.count > 0 && state.graphics > 0, JSON.stringify(state)); return state;
    });
    await check('visible map mode control switches to 2D', async () => {
      const before = await page.evaluate(() => wf.is3D());
      const label = await page.locator('#btn3D').getAttribute('aria-label');
      ensure(before ? /\b2D\b/.test(label || '') : /\b3D\b/.test(label || ''), `Mode label does not match actual view: ${label}`);
      if (before) await click(page.locator('#btn3D'));
      await page.waitForFunction(() => !wf.is3D() && wf.view().ready, null, { timeout: 45000 });
      const state = await page.evaluate(() => ({ is3D: wf.is3D(), ready: wf.view().ready, canvasCount: document.querySelectorAll('#viewDiv canvas').length }));
      ensure(!state.is3D && state.ready && state.canvasCount > 0, JSON.stringify(state));
      await page.waitForTimeout(1000);
      await shot('2d-map');
      return { previousMode: before ? '3D' : '2D', ...state };
    });
    await check('category filtering through visible controls', async () => {
      const category = await page.evaluate(() => [...document.querySelectorAll('#chips .chip[data-cat]')].find(button => wf.pois.some(p => p.category === button.dataset.cat))?.dataset.cat);
      ensure(category, 'No real POI category control available');
      const index = await page.evaluate(value => [...document.querySelectorAll('#chips .chip[data-cat]')].findIndex(b => b.dataset.cat === value), category);
      await click(page.locator('#chips .chip[data-cat]').nth(index));
      const state = await page.evaluate(() => ({ filter: wfUI.S.filter, mode: wfUI.S.mode, items: document.querySelectorAll('#sheetBody .list li').length, expected: wf.pois.filter(p => p.category === wfUI.S.filter).length }));
      ensure(state.filter === category && state.mode === 'list' && state.items > 0 && state.items === state.expected, JSON.stringify(state));
      return state;
    });
    await check('floor selection through visible category floor controls', async () => {
      await click(page.locator('#chips .chip[data-cat]').first());
      const floor = await page.locator('#sheetBody [data-category-floor]').evaluateAll(buttons => buttons.map(b => b.dataset.categoryFloor).find(f => f !== '__all__' && f !== window.wf.currentFloor()));
      ensure(floor, 'No second-floor public selector available');
      await click(page.locator(`#sheetBody [data-category-floor="${floor}"]`));
      const state = await page.evaluate(() => ({ floor: wf.currentFloor(), selected: wfUI.S.categoryFloor, visibleCount: document.querySelectorAll('#sheetBody .list li').length }));
      ensure(state.floor === floor && state.selected === floor && state.visibleCount > 0, JSON.stringify(state));
      await shot('floor-selection');
      return state;
    });
    const selected = await page.evaluate(() => wf.pois.find(p => p.name && p.nearest_node) || wf.pois[0]);
    await check('search and POI selection through autocomplete', async () => {
      await page.locator('#q').fill(selected.name);
      await page.waitForFunction(id => [...document.querySelectorAll('#acList [role="option"]')].some(e => e.textContent.includes(window.wf.pois.find(p => p.id === id)?.name || '\u0000')), selected.id);
      const options = page.locator('#acList [role="option"]');
      let index = await options.evaluateAll((elements, expected) => elements.findIndex(e => e.getAttribute('aria-label')?.startsWith(expected + ',')), selected.name);
      if (index < 0) index = 0;
      await click(options.nth(index));
      await page.waitForFunction(() => wfUI.S.mode === 'place');
      const state = await page.evaluate(() => ({ id: wfUI.S.place?.id, mode: wfUI.S.mode, directionControl: !!document.getElementById('pDir') }));
      ensure(state.id === selected.id && state.mode === 'place' && state.directionControl, JSON.stringify(state));
      await shot('poi');
      return { selectedPoiId: state.id, directionControl: state.directionControl };
    });
    await check('same-floor directions and route geometry', async () => {
      const pair = await page.evaluate(() => {
        const p = wf.pois.filter(p => p.nearest_node && p.name);
        const to = wfUI.S.place || p[0], from = p.find(x => x.floor === to.floor && x.nearest_node !== to.nearest_node && x.name !== to.name);
        return from ? { from: { id: from.id, name: from.name, floor: from.floor }, to: { id: to.id, name: to.name, floor: to.floor } } : null;
      });
      ensure(pair, 'No distinct real same-floor POI pair');
      await click(page.locator('#pDir'));
      await page.locator('#fromQ').fill(pair.from.name);
      const options = page.locator('#acList [role="option"]');
      await options.first().waitFor();
      const index = await options.evaluateAll((elements, expected) => elements.findIndex(e => e.getAttribute('aria-label')?.startsWith(expected + ',')), pair.from.name);
      ensure(index >= 0, 'Starting POI absent from directions autocomplete');
      await click(options.nth(index));
      await page.waitForFunction(({ from, to }) => wfUI.S.from?.id === from.id && wfUI.S.to?.id === to.id && wfUI.S.route?.nodes?.length > 1 && document.getElementById('dStart'), pair, { timeout: 60000 });
      const state = await page.evaluate(() => ({ from: wfUI.S.from.id, to: wfUI.S.to.id, nodes: wfUI.S.route.nodes.length, routeGraphics: wf.view().map.layers.find(l => l.title === (wf.is3D() ? 'Route 3D' : 'Route'))?.graphics.length || 0, instructionCount: wfUI.S.navSteps.length, totalM: wfUI.S.route.total_m, source: wfUI.S.route.source }));
      ensure(state.from === pair.from.id && state.to === pair.to.id && state.nodes > 1 && state.routeGraphics > 0 && state.instructionCount > 0, JSON.stringify(state));
      await shot('route');
      return { ...state, pair };
    });
    await check('navigation starts, advances, and exits', async () => {
      await click(page.locator('#dStart'));
      await page.waitForFunction(() => wfUI.S.mode === 'nav' && !document.getElementById('navBanner').hidden);
      const before = await page.evaluate(() => wfUI.S.navI);
      const next = page.locator('#navNext');
      const canAdvance = await next.isEnabled();
      if (canAdvance) await click(next);
      const advanced = await page.evaluate(() => wfUI.S.navI);
      await click(page.locator('#navExit'));
      const mode = await page.evaluate(() => wfUI.S.mode);
      ensure((canAdvance ? advanced > before : advanced === before) && mode === 'dir', `before=${before}, after=${advanced}, mode=${mode}`);
      return { before, advanced, canAdvance, mode };
    });
    await check('multi-floor route on authentic published data', async () => {
      const pair = await page.evaluate(() => {
        const p = wf.pois.filter(p => p.nearest_node && p.name), from = p[0], to = p.find(x => x.floor !== from.floor && x.nearest_node !== from.nearest_node);
        return to ? { from: { id: from.id, floor: from.floor }, to: { id: to.id, floor: to.floor } } : null;
      });
      ensure(pair, 'No genuine different-floor pair');
      await page.evaluate(({ from, to }) => { window.__qaPreviousRoute = wfUI.S.route; wfUI.openDirections(from.id, to.id, false); }, pair);
      await page.waitForFunction(({ from, to }) => wfUI.S.from?.id === from.id && wfUI.S.to?.id === to.id && wfUI.S.route !== window.__qaPreviousRoute && wfUI.S.route?.nodes?.length > 1, pair, { timeout: 60000 });
      const state = await page.evaluate(() => ({ floors: [...new Set(wfUI.S.route.nodes.map(n => n.floor).filter(Boolean))], routeGraphics: wf.view().map.layers.find(l => l.title === (wf.is3D() ? 'Route 3D' : 'Route'))?.graphics.length || 0, source: wfUI.S.route.source, instructionCount: wfUI.S.navSteps.length }));
      ensure(state.floors.length > 1 && state.instructionCount > 0 && state.routeGraphics > 0, JSON.stringify(state));
      await shot('multi-floor-route');
      return { ...state, pair };
    });
    await check('language interface switches and returns to English', async () => {
      await page.evaluate(() => WFi18n.setLocale('fr'));
      const state = await page.evaluate(() => ({ lang: document.documentElement.lang, aria: document.getElementById('btnMenu').getAttribute('aria-label') }));
      ensure(state.lang === 'fr' && state.aria !== 'Open menu', JSON.stringify(state));
      await page.evaluate(() => WFi18n.setLocale('en'));
      return state;
    });
    await check('no horizontal overflow after navigation', async () => {
      const state = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
      ensure(state.document <= state.viewport, JSON.stringify(state)); return state;
    });
    await check('refresh retains a working published map', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => window.wf?.ready && window.wf?.indoorReady && !document.body.classList.contains('booting'), null, { timeout: 120000 });
      await page.waitForFunction(() => wf.view()?.ready, null, { timeout: 45000 });
      ensure(await page.evaluate(version => WF.building?.version === version && wf.view().ready, expectedVersion), 'Published view failed after refresh');
      return { version: expectedVersion };
    });
    report.timings = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { domContentLoadedMs: n.domContentLoadedEventEnd, loadEventMs: n.loadEventEnd } : null;
    });
  } catch (e) {
    report.checks.push({ name: 'browser execution', status: 'FAIL', error: redact(e.message) });
    await shot('execution-failed').catch(() => {});
  } finally { await context.close(); }
  return report;
}

(async () => {
  const backend = process.env.WEBGL_BACKEND || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
  const launch = { headless: true, args: ['--use-gl=angle', `--use-angle=${backend}`, '--ignore-gpu-blocklist', ...(backend === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : [])] };
  if (process.env.BROWSER_EXECUTABLE_PATH) launch.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  const browser = await chromium.launch(launch);
  const report = { recordedAt: new Date().toISOString(), base, scope: 'Read-only authentic GCU v5 viewer acceptance; no production mutations', browserVersion: browser.version(), graphicsBackend: backend, devices: [] };
  for (const device of devices) report.devices.push(await capture(browser, device));
  await browser.close();
  const checks = report.devices.flatMap(d => d.checks);
  report.summary = { executed: checks.length, passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length };
  fs.writeFileSync(path.join(out, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.exitCode = report.summary.failed ? 1 : 0;
  console.log(JSON.stringify({ evidence: out, browser: report.browserVersion, summary: report.summary, devices: report.devices.map(d => ({ name: d.name, checks: d.checks, pageErrors: d.pageErrors, badResponses: d.badResponses })) }, null, 2));
})().catch(e => { console.error(redact(e.stack)); process.exitCode = 1; });
