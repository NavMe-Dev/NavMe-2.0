/* Render the reviewed vectors and the five-page PDF; no external image assets. */
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = path.resolve(process.argv[2] || 'outputs/unc-charlotte/student-union');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'floor-inventory.json')));
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const sheets = [];
  try {
    for (const id of ['L1', 'L2', 'L3', 'LL', 'M']) {
      const dir = path.join(root, 'floors', id);
      const svg = fs.readFileSync(path.join(dir, 'label-plan.svg'), 'utf8');
      sheets.push(`<section>${svg}</section>`);
      const page = await browser.newPage({viewport: {width: 1824, height: 1368}});
      await page.setContent(`<style>body{margin:0}svg{display:block;width:1824px;height:1368px}</style>${svg}`);
      await page.screenshot({path: path.join(dir, 'label-plan.png')});
      await page.close();
    }
    const page = await browser.newPage();
    await page.setContent(`<style>@page{size:1824px 1368px;margin:0}body{margin:0}section{width:1824px;height:1368px;break-after:page}section:last-child{break-after:auto}svg{display:block;width:100%;height:100%}</style>${sheets.join('')}`);
    await page.pdf({path: path.join(root, 'student-union-floorplans.pdf'), width: '1824px', height: '1368px', printBackground: true, preferCSSPageSize: true});
    console.log(`Rendered ${catalog.floors.length} label/division PNG previews and five-page vector PDF`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
