/* Actual UNCC desktop/mobile public-viewer acceptance. GET-only app traffic.
 * PLAYWRIGHT_MODULE=/path/to/playwright node platform/tools/uncc_acceptance.cjs
 * Uses installed Chrome; EVIDENCE_DIR selects the screenshot/report destination.
 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'https://wayfinding.navme.space';
const output = process.env.EVIDENCE_DIR || 'platform/var/production-migration/browser/uncc-live';
fs.mkdirSync(output, {recursive: true});
const safeUrl = value => { const u = new URL(value); return u.origin + u.pathname; };
(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist']});
  const report = {recordedAt: new Date().toISOString(), base, checks: []};
  try {
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      if (process.env.VIEWPORT_NAME && name !== process.env.VIEWPORT_NAME) continue;
      const context = await browser.newContext({viewport: {width, height}, isMobile: width < 768, hasTouch: width < 768});
      const page = await context.newPage();
      const failures = [], errors = [], mutations = [];
      await context.route('**/*', route => {
        const request = route.request(), u = new URL(request.url());
        if ((u.origin === new URL(base).origin || u.hostname.endsWith('.supabase.co')) &&
            !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          mutations.push(safeUrl(request.url())); return route.abort();
        }
        return route.continue();
      });
      page.on('response', r => {if (r.status() >= 400 && new URL(r.url()).origin === new URL(base).origin) failures.push({path: new URL(r.url()).pathname, status: r.status()});});
      page.on('pageerror', e => errors.push(e.name));
      async function check(label, fn) {
        try { const detail = await fn(); report.checks.push({viewport: name, label, status: 'PASS', detail}); }
        catch (e) { report.checks.push({viewport: name, label, status: 'FAIL', error: e.message.slice(0, 250)}); }
        fs.writeFileSync(output + '/report.json', JSON.stringify(report, null, 2));
      }
      await page.goto(base + '/?b=uncc-main-campus&mp=1', {waitUntil: 'domcontentloaded', timeout: 45000});
      await check('UNCC publication and curated places', async () => {
        await page.waitForFunction(() => window.wf?.ready, null, {timeout: 60000});
        const data = await page.evaluate(() => ({slug: WF.building.slug, version: WF.building.version,
          model: WF.cfg.matterport_model_id, pois: wf.pois.length, categories: wf.categories.length,
          displayFloors: WF.cfg.display_floors.length, title: document.title}));
        assert.equal(data.slug, 'uncc-main-campus'); assert.equal(data.version, 2);
        assert.equal(data.model, 'kQBN52JqFE9'); assert.equal(data.pois, 20);
        assert.equal(data.categories, 6); assert.equal(data.displayFloors, 2); return data;
      });
      await check('real Matterport scene completes startup', async () => {
        await page.waitForFunction(() => window.__mpBackgroundReady && window.__mpSdk &&
          document.body.classList.contains('mp-startup-complete') && document.getElementById('mpBgLoading')?.hidden,
          null, {timeout: 120000});
        const state = await page.evaluate(() => ({model: new URL(document.getElementById('mpFrame').src).searchParams.get('m'),
          sdkPresent: !!window.__mpSdk, error: document.getElementById('mpBgLoading').classList.contains('err')}));
        assert.equal(state.model, 'kQBN52JqFE9'); assert.equal(state.error, false); return state;
      });
      await page.screenshot({path: output + '/' + name + '.png', fullPage: true});
      await check('Student Union category and POI camera focus', async () => {
        const chip = page.locator('#chips .chip[data-cat="student union"]');
        await chip.click();
        const row = page.locator('#sheetBody .list li').first();
        await row.waitFor();
        const count = await page.locator('#sheetBody .list li').count();
        await page.evaluate(() => {window.__unccFocus = null; const original = MpPreview.focusAt;
          MpPreview.focusAt = function(...args) {const result = original.apply(this, args);
            Promise.resolve(result).then(value => {window.__unccFocus = value;}); return result;};});
        await row.click();
        await page.waitForFunction(() => window.__unccFocus === true, null, {timeout: 30000});
        return {categoryPlaces: count, cameraFocus: true};
      });
      await check('durable navmesh loads and computes a campus route', async () => {
        const result = await page.evaluate(async () => {
          await WFNav.initNavmesh(WF.building.slug, {floors: WF.cfg.floors, modelToLL: wf.modelToLL});
          for (let i = 0; i < wf.pois.length; i++) for (let j = i + 1; j < wf.pois.length; j++) {
            const a = wf.pois[i], b = wf.pois[j];
            const route = WFNav.routeNavmesh(a.sdk, b.sdk);
            if (route && !route.error && !route.partial && route.total_m > 5)
              return {ready: WFNav.navmeshReady(), from: a.name, to: b.name, meters: Math.round(route.total_m), points: route.path.length};
          }
          throw new Error('No complete route between curated POIs');
        });
        assert.equal(result.ready, true); assert.ok(result.points > 1); return result;
      });
      await check('no unhandled page errors or application writes', async () => {
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []); return {errors: 0, mutations: 0, httpFailures: failures};
      });
      await context.close();
    }
  } finally { await browser.close(); }
  report.summary = {passed: report.checks.filter(c => c.status === 'PASS').length, failed: report.checks.filter(c => c.status === 'FAIL').length};
  fs.writeFileSync(output + '/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.summary.failed ? 1 : 0;
})().catch(e => {console.error(e.name + ': ' + e.message.slice(0, 250)); process.exitCode = 1;});
