/* Real floor-plan UI + local source evidence. This is NOT live SDK landing proof. */
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://localhost:8783';
const output=process.env.EVIDENCE_DIR||'outputs/unc-charlotte/student-union/navigation-evidence';
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const report={base,scope:'Real local plans/context; external SDK blocked to exercise safe fallback. No live alignment or landing claims.',viewports:[]};
 try{
  for(const [width,height] of [[1440,1000],[375,812],[390,844],[430,932]]){
   const page=await browser.newPage({viewport:{width,height},hasTouch:width<500,isMobile:width<500});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.route('https://my.matterport.com/**',route=>route.abort());
   await page.goto(base+'/unc-charlotte?plan=student-union',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.WFPlanViewer?.activeFloor==='L1'&&!!window.WFPlanViewer.navigation);
   const initialFrameCount=await page.locator('#mpFrame').count();
   const checks=[];
   for(const [floor,label] of [['L1','square'],['L2','meeting-260'],['L3','multipurpose'],['LL','bookstore'],['M','arena']]){
    await page.locator('#fpFloor').selectOption(floor);
    await page.waitForFunction(floor=>WFPlanViewer.activeFloor===floor,floor);
    const target=page.locator('#fpStage [data-label-id="'+floor+'-'+label+'"]');
    if(width<500)await target.tap();else await target.click();
    assert.equal(await page.locator('#fpLocation').isVisible(),true);
    if(width<500)await page.locator('#fpEnter3D').click();else await target.dblclick();
    await page.waitForFunction(()=>document.querySelector('#fpNavStatus').textContent.includes('needs verified alignment'));
    assert.equal(await page.locator('#unionFloorplanViewer').isVisible(),true);
    assert.equal(await page.locator('#mpFrame').count(),initialFrameCount);
    checks.push({floor,selection:true,safeFallback:true});
   }
   // Map coordinates are recovered through the live SVG CTM after zoom/rotation.
   await page.locator('#fpFloor').selectOption('L1');await page.waitForFunction(()=>WFPlanViewer.activeFloor==='L1');
   await page.locator('#fpZoomIn').click();
   const click=await page.evaluate(()=>{const svg=document.querySelector('#fpStage svg');svg.style.transform='rotate(7deg)';const p=new DOMPoint(974,380).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};});
   await page.mouse.click(click.x,click.y);
   const local=await page.evaluate(()=>WFPlanViewer.navigation.selected.point);
   // Native pointer events quantize CSS pixels before the SVG inverse.
   assert.ok(Math.hypot(local.x-974,local.y-380)<4,JSON.stringify(local));
   await page.evaluate(()=>document.querySelector('#fpStage svg').style.transform='');
   await page.locator('#fpFit').click();
   let pinch=false;
   if(width<500){
    const client=await page.context().newCDPSession(page),before=await page.locator('#fpStage svg').getAttribute('viewBox');
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:130,y:300,id:1},{x:230,y:300,id:2}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:100,y:300,id:1},{x:260,y:300,id:2}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.notEqual(await page.locator('#fpStage svg').getAttribute('viewBox'),before);pinch=true;
   }
   await page.screenshot({path:output+'/navigation-'+width+'x'+height+'.png'});
   assert.deepEqual(errors,[]);
   report.viewports.push({width,height,status:'PASS',checks,screenToMapAfterZoomAndRotation:true,pinch,noPageErrors:true});
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.route('https://my.matterport.com/**',r=>r.abort());
  await page.goto(base+'/unc-charlotte?plan=student-union&planCalibration=1',{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#fpCalibration');
  assert.ok((await page.locator('#fpCalibration').textContent()).includes('Sign in'));
  assert.equal(await page.locator('#fpCalSave').count(),0);
  report.calibrationUnauthenticated='PASS';
 }finally{await browser.close();}
 fs.writeFileSync(output+'/interaction-tests.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exit(1)});
