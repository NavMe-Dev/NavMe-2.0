/* Exercise the actual public viewer; external Matterport rendering is excluded. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const evidence = process.env.EVIDENCE_DIR || 'outputs/unc-charlotte/student-union/audit';
fs.mkdirSync(evidence, {recursive: true});
(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const report = {base: process.env.BASE_URL || 'http://localhost:8782', checks: [],
    scope: 'Official diagram labels/divisions. No claim of Matterport alignment or external rendering.'};
  try {
    for (const [viewport, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      const page = await browser.newPage({viewport: {width, height}, isMobile: viewport === 'mobile', hasTouch: viewport === 'mobile'});
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('https://my.matterport.com/**', route => route.abort());
      await page.goto(report.base + '/unc-charlotte?plan=student-union', {waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => window.WFPlanViewer?.activeFloor === 'L1' && window.wf?.ready);
      assert.equal(await page.locator('#unionFloorplanViewer').isVisible(), true);
      assert.equal(await page.locator('#fpFloor option').count(), 5);
      const counts = {};
      for (const [id, count] of [['LL', 13], ['L1', 33], ['M', 6], ['L2', 33], ['L3', 19]]) {
        await page.locator('#fpFloor').selectOption(id);
        await page.waitForFunction(id => WFPlanViewer.activeFloor === id, id);
        assert.equal(await page.locator('#fpStage [data-label-id]').count(), count);
        assert.equal(await page.locator('#fpPoi option').count(), count + 1);
        assert.equal(await page.locator('#fpStage image,#fpStage foreignObject,#fpStage script').count(), 0);
        assert.ok(await page.locator('#fpStage .division').count() > 0);
        counts[id] = count;
        await page.locator('#fpPoi').selectOption({index: 1});
        assert.equal(await page.locator('#fpStage .plan-label.fp-selected').count(), 1);
        await page.locator('#fpFit').click();
        await page.screenshot({path: evidence + '/labels-' + viewport + '-' + id + '.png'});
      }
      // Room 340's nine lettered partitions must survive vector import.
      for (const letter of 'ABCDEFGHI') {
        assert.equal(await page.locator('#fpStage [data-label-id="L3-section-' + letter + '"]').textContent(), letter);
      }
      assert.equal(await page.locator('#fpStage .partition[stroke-dasharray]').count(), 4);
      await page.locator('#fpFloor').selectOption('L2');
      await page.waitForFunction(() => WFPlanViewer.activeFloor === 'L2');
      await page.locator('#fpPoi').selectOption('L2-meeting-260');
      assert.equal(await page.locator('#fpStage #L2-5').getAttribute('class'), 'division fp-region-selected');
      await page.locator('#fpStage [data-label-id="L2-meeting-261"]').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
      assert.equal(await page.locator('#fpPoi').inputValue(), 'L2-meeting-261');
      // A route in model metres must not be projected into unregistered pixels.
      await page.evaluate(() => WFPlanViewer.drawRoute({path: [{x: 180, y: 0, z: 30}, {x: 190, y: 0, z: 40}]}));
      assert.equal(await page.locator('#fpStage #fpRoute').count(), 0);
      await page.locator('#fpFit').click();
      const before = await page.locator('#fpStage svg').getAttribute('viewBox');
      await page.locator('#fpZoomIn').click();
      assert.notEqual(await page.locator('#fpStage svg').getAttribute('viewBox'), before);
      await page.locator('#fpFit').click();
      assert.equal(await page.locator('#fpStage svg').getAttribute('viewBox'), before);
      await page.mouse.move(width / 2, height * .4);
      await page.mouse.down(); await page.mouse.move(width / 2 + 45, height * .4 + 20); await page.mouse.up();
      assert.notEqual(await page.locator('#fpStage svg').getAttribute('viewBox'), before);
      assert.equal(await page.locator('.fp-reference').getAttribute('href'), 'https://studentunion.charlotte.edu/about/floor-plans');
      await page.locator('#fpClose').click();
      assert.equal(await page.locator('#unionFloorplanViewer').isVisible(), false);
      assert.deepEqual(errors, []);
      report.checks.push({viewport, status: 'PASS', labelsPerFloor: counts, allLabels: 104,
        keyboardSelection: true, zoomPanFit: true, unregisteredRouteHidden: true, noPageErrors: true});
      await page.close();
    }
    const page = await browser.newPage();
    await page.route('https://my.matterport.com/**', route => route.abort());
    await page.goto(report.base + '/gcu-omr', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.wf?.ready);
    assert.equal(await page.locator('#btnFloorplans').count(), 0);
    report.checks.push({status: 'PASS', check: 'Other campuses do not gain Student Union controls'});
  } finally { await browser.close(); }
  fs.writeFileSync(process.env.REPORT_PATH || 'outputs/unc-charlotte/student-union/integration-validation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
