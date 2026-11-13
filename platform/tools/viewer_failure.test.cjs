/* Browser regression for failures before/after translation dictionaries initialize.
 * Uses the actual bootloader/i18n files and intercepted HTTP failures, never live data.
 * PLAYWRIGHT_MODULE=/path/to/playwright node --test platform/tools/viewer_failure.test.cjs
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  for (const initialized of [false, true]) {
    for (const failure of ['HTTP 503', 'network interruption']) {
    test(`${label}: ${failure} ${initialized ? 'after' : 'before'} translations initialize`, async () => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      let attempts = 0;
      await page.route('http://navme.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
          const boot = initialized
            ? 'WFi18n.init({locale:"fr",enabled:["en","fr"]}).then(()=>{const s=document.createElement("script");s.src="/wf-boot.js";document.body.append(s)})'
            : 'const s=document.createElement("script");s.src="/wf-boot.js";document.body.append(s)';
          return route.fulfill({ contentType: 'text/html', body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script src="/locales/i18n.js"></script><script>window.WF_CONFIG={apiBase:"/api/v1/public/"};${boot}</script></body></html>` });
        }
        if (pathname.endsWith('/manifest.json')) {
          attempts++;
          if (failure === 'network interruption') return route.abort('internetdisconnected');
          return route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Database temporarily unavailable"}' });
        }
        const file = pathname === '/wf-boot.js' ? path.join(root, 'viewer/wf-boot.js') : path.join(root, pathname);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: pathname.endsWith('.json') ? 'application/json' : 'text/javascript', body: fs.readFileSync(file, 'utf8') });
      });
      try {
        await page.goto('http://navme.test/');
        const alert = page.getByRole('alert');
        await alert.waitFor();
        const text = await alert.innerText();
        const expected = initialized ? JSON.parse(fs.readFileSync(path.join(root, 'locales/fr.json'), 'utf8')).viewer.loadError : "We couldn't load the map right now. Please try again.";
        assert.ok(text.includes(expected), `Expected readable message, got ${text}`);
        assert.ok(!text.includes('viewer.loadError'));
        assert.ok(!await page.evaluate(() => window.WF.cfg), 'A failed manifest must not synthesize venue config');
        const retry = page.getByRole('button', { name: 'Try Again' });
        const box = await retry.boundingBox();
        assert.ok(box.height >= 44 && box.width >= 44, 'Retry is a touch-sized target');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Error state must fit viewport');
        if (process.env.EVIDENCE_DIR && !initialized && failure === 'HTTP 503') {
          fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true, mode: 0o700 });
          await page.screenshot({ path: path.join(process.env.EVIDENCE_DIR, `${label}-isolated-error-after.png`) });
        }
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), retry.click()]);
        await page.getByRole('alert').waitFor();
        assert.ok(attempts >= 2, 'Retry must issue a new manifest request');
        assert.ok((await page.getByRole('alert').innerText()).includes(expected));
      } finally { await context.close(); }
    });
    }
  }
}
