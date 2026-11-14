/* Integration fixture ONLY. It cannot validate real Student Union alignment. */
const crypto=require('node:crypto');
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://localhost:8783',dir=process.env.EVIDENCE_DIR||'outputs/unc-charlotte/student-union/navigation-evidence';
fs.mkdirSync(dir,{recursive:true});
const model='kQBN52JqFE9',version='f'.repeat(64),positions=[[-2,-2],[2,-2],[-2,2],[2,2],[0,0],[1,0]];
const sweeps=positions.map(([x,y],i)=>({id:'fixture'+i,floor_id:'L1',source_floor_id:'fixture-floor',position:{x,y,z:0},neighbors:positions.map((_,j)=>'fixture'+j).filter(id=>id!=='fixture'+i)}));
const cal={status:'approved',floor_id:'L1',model_id:model,source_version:version,sdk_floor_id:'fixture-floor',diagram_to_model:[.02,0,0,-.02,-19.48,7.6],elevation_model_m:0,valid_region:[[874,280],[1074,280],[1074,480],[874,480],[874,280]],anchors:sweeps.map(s=>({sweep_id:s.id})),validation:{passed:true,max_error_m:0,holdout_count:2}};
const plan_versions={'floors/L1/label-plan.svg':crypto.createHash('sha256').update(fs.readFileSync('platform/floorplans/student-union/floors/L1/label-plan.svg')).digest('hex')};
const context={plan_versions,model_id:model,building_id:'student-union',source_version:version,approved_calibrations:{L1:cal},floors:{L1:{coverage:[[[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]]]],walls:[],rooms:[],scan_spacing_m:2}},sweeps};
async function installSdk(page){
  await page.evaluate(({sweeps,model})=>{
   function observable(value){const listeners=[];return {subscribe(fn){listeners.push(fn);typeof fn==='function'?fn(value):fn.onCollectionUpdated?.(value);return {cancel(){const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}};},emit(next){value=next;for(const fn of listeners)typeof fn==='function'?fn(value):fn.onCollectionUpdated?.(value);}};}
   const items=sweeps.map(s=>({...s,id:s.id,sid:s.id,enabled:true,alignmentType:'aligned',placementType:'auto',floorInfo:{id:'fixture-floor'},position:{x:s.position.x,y:1.6,z:-s.position.y},puckPosition:{x:s.position.x,y:0,z:-s.position.y}}));
   const data=observable(Object.fromEntries(items.map(s=>[s.id,s]))),current=observable(items[0]),pose=observable({mode:'mode.inside',position:items[0].position});
   const sdk={Model:{getData:async()=>({sid:model})},Sweep:{data,current,Transition:{FLY:'fly'},moveTo:async id=>{if(window.__failMove)throw Error('Fixture movement failure');window.__moves.push(id);const s=items.find(s=>s.id===id);current.emit(s);pose.emit({mode:'mode.inside',position:s.position});return id;}},Camera:{pose}};
   window.__moves=[];window.__fixture={sdk,items};MpPreview.getLiveConnection=()=>({sdk});
  },{sweeps,model});
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});const report={scope:'MOCK SDK + synthetic alignment only. No real navigation verified.',viewports:[]};
 try{for(const [width,height] of [[1440,1000],[375,812],[390,844],[430,932]]){
  const page=await browser.newPage({viewport:{width,height},hasTouch:width<500,isMobile:width<500});
  await page.route('https://my.matterport.com/**',r=>r.abort());
  await page.route('**/floorplans/navigation/context',r=>r.fulfill({json:context}));
  await page.route('**/floorplans/navigation/version',r=>r.fulfill({json:{source_version:version}}));
  await page.goto(base+'/unc-charlotte?plan=student-union',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.WFPlanViewer?.activeFloor==='L1'&&window.MpPreview);
  await installSdk(page);
  const square=page.locator('[data-label-id="L1-square"]');width<500?await square.tap():await square.click();
  const before=await page.locator('#fpStage svg').getAttribute('viewBox');
  if(width<500)await page.locator('#fpEnter3D').click();else await square.dblclick();
  await page.waitForFunction(()=>!document.body.classList.contains('floorplan-open'));
  assert.deepEqual(await page.evaluate(()=>window.__moves),['fixture4']);
  assert.equal(await page.locator('#mpFrame').count(),1);
  // A later stable camera observation exercises the throttled reverse bridge.
  await page.waitForTimeout(220);
  await page.evaluate(()=>{__fixture.sdk.Sweep.current.emit(__fixture.items[4]);__fixture.sdk.Camera.pose.emit({mode:'mode.inside',position:__fixture.items[4].position});});
  await page.locator('#fpBackToMap').click();await page.waitForFunction(()=>document.body.classList.contains('floorplan-open'));
  assert.equal(await page.locator('#fpStage svg').getAttribute('viewBox'),before);
  assert.equal(await page.locator('#fpUserPosition').count(),1);
  await page.screenshot({path:dir+'/fixture-return-'+width+'.png'});
  width<500?await square.tap():await square.click();await page.evaluate(()=>window.__failMove=true);
  await page.locator('#fpEnter3D').click();await page.waitForFunction(()=>document.querySelector('#fpNavStatus').textContent==='3D view is not available for this location.');
  assert.equal(await page.locator('#unionFloorplanViewer').isVisible(),true);
  const moveCount=await page.evaluate(()=>window.__moves.length);
  await page.route('**/floorplans/navigation/version',r=>r.fulfill({json:{source_version:'changed'}}));
  await page.evaluate(()=>window.__failMove=false);
  const staleResult=await page.evaluate(()=>WFPlanViewer.navigation.enter());
  assert.equal(staleResult.ok,false);assert.equal(await page.evaluate(()=>window.__moves.length),moveCount);
  report.viewports.push({width,height,status:'PASS',staleSourceVersionRejected:true,mockMoveConfirmed:true,singleViewer:true,backToSameView:true,reversePosition:true,failedMovePreservesMap:true,metrics:await page.evaluate(()=>WFPlanViewer.navigation.metrics)});
  await page.close();
 }
 const adminPage=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await adminPage.addInitScript(()=>localStorage.setItem('wf_admin_token','integration-fixture-only'));
 await adminPage.route('https://my.matterport.com/**',r=>r.abort());
 await adminPage.route('**/floorplans/navigation/context',r=>r.fulfill({json:context}));
 await adminPage.route('**/api/v1/auth/me',r=>r.fulfill({json:{is_admin:true,email:'fixture@example.test'}}));
 await adminPage.goto(base+'/unc-charlotte?plan=student-union&planCalibration=1',{waitUntil:'domcontentloaded'});
 await adminPage.waitForFunction(()=>window.WFPlanViewer?.activeFloor==='L1');
 await adminPage.waitForSelector('#fpCalStart',{state:'attached'});
 await installSdk(adminPage);
 await adminPage.locator('#fpCalibration summary').click();
 await adminPage.locator('#fpCalStart').click();
 await adminPage.locator('[data-label-id="L1-square"]').tap();
 await adminPage.locator('#fpCalEvidence').fill('Synthetic integration fixture only');
 await adminPage.locator('#fpCalVerified').check();
 await adminPage.locator('#fpCalCapture').click();
 await adminPage.waitForFunction(()=>document.querySelectorAll('#fpCalAnchors li').length===1);
 assert.equal(await adminPage.locator('#fpCalPreview').isDisabled(),true);
 await adminPage.screenshot({path:dir+'/fixture-calibration-mobile.png'});
 report.calibrationMockCapture='PASS; unpublished, preview remains disabled';
 }finally{await browser.close();}
 fs.writeFileSync(dir+'/mock-sdk-integration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exit(1)});
