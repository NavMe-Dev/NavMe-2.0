/* One real desktop/mobile visitor; no raw HAR, headers, query strings or keys.
 * HEADLESS=false or --headed selects a normal visible Chrome browser. There are
 * no stealth flags, challenge solvers or automatic challenge retries.
 */
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {values: opts} = parseArgs({options: {
  execute:{type:'boolean',default:false}, headed:{type:'boolean',default:false},
  'base-url':{type:'string',default:'https://wayfinding.navme.space'},
  output:{type:'string',default:'docs/evidence/uncc-production/browser'},
  viewport:{type:'string',default:'both'}, 'observe-seconds':{type:'string',default:'75'},
  'max-mib':{type:'string',default:'256'},
}});
const base = opts['base-url'].replace(/\/$/,'');
if (base !== 'https://wayfinding.navme.space' && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))
  throw Error('Only the authorized origin or loopback is permitted');
const observeSeconds=Number(opts['observe-seconds']), maxBytes=Number(opts['max-mib'])*1024**2;
if (!(observeSeconds>=15&&observeSeconds<=90&&maxBytes>0&&maxBytes<=512*1024**2))throw Error('Invalid finite observation/body budget');
if (!['both','desktop','mobile'].includes(opts.viewport))throw Error('Choose both, desktop or mobile');
const out=path.resolve(opts.output);
const headless=!opts.headed&&process.env.HEADLESS!=='false';
if (!opts.execute) {
  console.log(JSON.stringify({dry_run:true,network_requests_made:0,base,headless,viewport:opts.viewport,
    model_load_timeout_seconds:120,loaded_observation_seconds:observeSeconds,max_bytes:maxBytes},null,2));
  process.exit(0);
}
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/private/tmp/navme-fallback-tools/node_modules/playwright');
fs.mkdirSync(out,{recursive:true});
const report={schema:'navme.browser-network/v1',started_utc:new Date().toISOString(),origin:base,headless,
  scope:'One real cold-cache visitor per viewport, not60simultaneous renderers or physical phones',viewports:[],
  privacy:'No raw HAR, cookies, headers, credentials, request/response bodies or URL queries saved',
  cache_note:'Fresh browser context; Playwright mutation interception disables the HTTP cache. This is conservative cold-cache traffic, not a warm-cache data-plan estimate.',
  byte_accounting:{
    primary:'Playwright request.sizes() encoded responseBodySize plus separately reported responseHeadersSize',
    cdp:'Network.loadingFinished encodedDataLength is an independent browser-reported diagnostic; do not add to primary totals',
    decoded:'ResourceTiming decodedBodySize when exposed; cross-origin timing restrictions can make this unknown',
    excluded:'TLS overhead, retransmissions and failed-request partial bodies are not fully accounted; not an exact billing meter',
  }};
function save(){fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2)+'\n');}
function safeUrl(raw){
  try{const u=new URL(raw);let p=u.pathname;
    if(u.origin!==base)p=p.replace(/\/[^/]{48,}/g,'/:opaque-id');
    p=p.replace(/(\/camera-viewpoints\/)[^/]+/,'$1:location_id');
    return {host:u.hostname,path:p.slice(0,240),first_party:u.origin===base};
  }catch{return{host:'unknown',path:'unavailable',first_party:false};}
}
function aggregate(rows,key){const groups={};for(const row of rows){const label=row[key];const g=groups[label]||= {
    requests:0,encoded_response_body_bytes:0,response_header_bytes:0,request_body_bytes:0,request_header_bytes:0,
    unknown_size_requests:0,status_counts:{},resource_types:{}};
  g.requests++;g.status_counts[row.status]=(g.status_counts[row.status]||0)+1;
  g.resource_types[row.resource_type]=(g.resource_types[row.resource_type]||0)+1;
  if(!row.sizes){g.unknown_size_requests++;continue;}
  for(const [a,b] of [['encoded_response_body_bytes','responseBodySize'],['response_header_bytes','responseHeadersSize'],
      ['request_body_bytes','requestBodySize'],['request_header_bytes','requestHeadersSize']])g[a]+=row.sizes[b]||0;
 }return groups;}
function currentState(){
  const frame=document.getElementById('mpFrame'),loader=document.getElementById('mpBgLoading');
  return {ready:!!(window.wf?.ready&&window.__mpBackgroundReady&&window.__mpSdk&&
      document.body.classList.contains('mp-startup-complete')&&loader?.hidden),
    model_id:window.WF?.cfg?.matterport_model_id,poi_count:window.wf?.pois?.length,
    same_frame:window.__networkOriginalFrame?frame===window.__networkOriginalFrame:null,
    loader_hidden:loader?.hidden,loader_error:loader?.classList.contains('err'),
    counts:window.WFViewerLifecycle?.snapshot().counts||{},
    layout:{width:innerWidth,scroll_width:document.documentElement.scrollWidth}};
}
async function challenge(page){
  for(const frame of page.frames()){
    if(!/matterport\.com|challenges\.cloudflare\.com/.test(frame.url()))continue;
    const text=await frame.locator('body').innerText({timeout:1000}).catch(()=> '');
    if(/performing security verification|verify you are human|checking your browser|verify that you are human/i.test(text))return true;
  }return false;
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless,
   args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist']});
 let encodedSoFar=0;
 try{
  for(const [name,width,height]of[['desktop',1440,900],['mobile',390,844]]){
   if(opts.viewport!=='both'&&opts.viewport!==name)continue;
   const record={name,width,height,started_utc:new Date().toISOString(),checks:[],network:[],
     cdp_encoded_transfer_bytes:0,cdp_finished_requests:0,cdp_cache_requests:0,failed_requests:[],page_error_classes:[]};
   report.viewports.push(record);save();
   const context=await browser.newContext({viewport:{width,height},isMobile:width<768,hasTouch:width<768});
   const page=await context.newPage(),pending=new Set();
   const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
   cdp.on('Network.loadingFinished',event=>{record.cdp_encoded_transfer_bytes+=event.encodedDataLength||0;
     record.cdp_finished_requests++;encodedSoFar+=event.encodedDataLength||0;});
   cdp.on('Network.requestServedFromCache',()=>record.cdp_cache_requests++);
   record.cdp_websocket_received_payload_bytes=0;record.cdp_websocket_sent_payload_bytes=0;
   const frameBytes=frame=>frame.opcode===2?Buffer.from(frame.payloadData||'','base64').length:Buffer.byteLength(frame.payloadData||'','utf8');
   cdp.on('Network.webSocketFrameReceived',event=>record.cdp_websocket_received_payload_bytes+=frameBytes(event.response));
   cdp.on('Network.webSocketFrameSent',event=>record.cdp_websocket_sent_payload_bytes+=frameBytes(event.response));
   page.on('pageerror',error=>record.page_error_classes.push(error.name));
   page.on('requestfailed',request=>record.failed_requests.push({...safeUrl(request.url()),
     resource_type:request.resourceType(),failure_class:'browser_request_failed'}));
   page.on('requestfinished',request=>{
    const work=(async()=>{let response=null;try{response=await request.response();}catch{}let sizes=null;
      try{sizes=await request.sizes();}catch{}
      record.network.push({...safeUrl(request.url()),status:response?.status()||0,
        resource_type:request.resourceType(),sizes,from_service_worker:response?.fromServiceWorker()||false,
        mime_type:response?.headers()['content-type']?.split(';')[0]||null});
    })();pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));
   });
   await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());
     if((url.origin===base||url.hostname.endsWith('.supabase.co'))&&!['GET','HEAD','OPTIONS'].includes(request.method())){
       record.checks.push({name:'blocked_application_mutation',status:'FAIL'});return route.abort();}
     return route.continue();
   });
   const check=async(label,fn)=>{try{const detail=await fn();record.checks.push({name:label,status:'PASS',detail});return true;}
     catch(error){record.checks.push({name:label,status:'FAIL',error_class:error.name});return false;}finally{save();}};
   try{
    await page.goto(base+'/unc-charlotte',{waitUntil:'domcontentloaded',timeout:45000});
    const loadStart=Date.now();let ready=false,blocked=false;
    while(Date.now()-loadStart<120000){
     if(encodedSoFar>maxBytes){record.stop_reason='network_budget';break;}
     const state=await page.evaluate(currentState).catch(()=>null);
     if(state?.ready){ready=true;break;}
     if(await challenge(page)){blocked=true;record.stop_reason='external_security_verification';break;}
     await page.waitForTimeout(1000);
    }
    record.initial_state=await page.evaluate(currentState).catch(()=>null);
    record.model_playing_verified=ready;
    if(blocked)record.result='BLOCKED_EXTERNAL_VERIFICATION';
    else if(!ready)record.result=record.stop_reason==='network_budget'?'INCOMPLETE_NETWORK_BUDGET':'MODEL_READINESS_NOT_VERIFIED';
    if(ready){
     const observationStart=Date.now();await page.evaluate(()=>{window.__networkOriginalFrame=document.getElementById('mpFrame');});
     const before=await page.evaluate(currentState);
     const pois=await page.evaluate(()=>wf.pois.slice(0,2).map(p=>({id:p.id,name:p.name})));
     await check('search_and_two_POI_selections',async()=>{
      for(const poi of pois){
       if(await page.locator('#sheetClose').isVisible())await page.locator('#sheetClose').click();
       await page.locator('#q').fill(poi.name);
       const option=page.locator('#acList li[role=option]').filter({hasText:poi.name}).first();
       await option.waitFor({timeout:10000});await option.click();
       await page.waitForFunction(id=>String(wfUI.S.place?.id)===String(id),poi.id,{timeout:10000});
       await page.waitForTimeout(2000);
      }return{selections:pois.length};});
     await check('SDK_rotation_and_zoom',async()=>{
      const sdk=await page.evaluate(async()=>{const sdk=window.__mpSdk;
       if(!sdk?.Camera?.setRotation||!sdk?.Camera?.getPose)return{supported:false};
       const pose=await sdk.Camera.getPose();
       await sdk.Camera.setRotation({x:pose.rotation.x,y:pose.rotation.y+12},{speed:20});
       const zoom=await MpPreview.zoomBy(.05);
       return{supported:true,zoom_acknowledged:zoom===true};});
      if(!sdk.supported)throw Error('Camera methods not available');return sdk;});
     await check('route_preview_and_exit_preserve_model',async()=>{
      const pair=await page.evaluate(async()=>{
       await WFNav.initNavmesh(WF.building.slug,{floors:WF.cfg.floors,modelToLL:wf.modelToLL});
       for(let i=0;i<Math.min(wf.pois.length,12);i++)for(let j=i+1;j<Math.min(wf.pois.length,12);j++){
        const a=wf.pois[i],b=wf.pois[j];if(!a.sdk||!b.sdk)continue;
        const route=WFNav.routeNavmesh(a.sdk,b.sdk);
        if(route&&!route.error&&!route.partial&&route.total_m>5)return[a.id,b.id];
       }return null;});
      if(!pair)throw Error('No complete route pair');
      await page.evaluate(([a,b])=>wfUI.openDirections(a,b,false),pair);
      await page.locator('#dStart').waitFor({timeout:15000});await page.locator('#dStart').click();
      await page.waitForTimeout(4000);
      if(await page.locator('#mpExit').isVisible())await page.locator('#mpExit').click();
      else if(await page.locator('#navExit').isVisible())await page.locator('#navExit').click();
      else throw Error('No existing Exit control visible');
      await page.waitForTimeout(1500);return{preview_started:true,exit_clicked:true};});
     while(Date.now()-observationStart<observeSeconds*1000){
      if(encodedSoFar>maxBytes){record.stop_reason='network_budget';break;}
      record.last_observation_state=await page.evaluate(currentState);
      if(!record.last_observation_state.ready){record.stop_reason='model_lost_readiness_after_load';break;}
      await page.waitForTimeout(1000);
     }
     record.observation_seconds=Number(((Date.now()-observationStart)/1000).toFixed(2));
     const after=await page.evaluate(currentState);record.final_state=after;
     const stable=after.ready&&after.same_frame&&['iframe.create','iframe.source','sdk.init.start'].every(k=>(before.counts[k]||0)===(after.counts[k]||0));
     record.checks.push({name:'loaded_viewer_lifecycle_stable',status:stable&&!record.stop_reason?'PASS':'FAIL',
       detail:{same_frame:after.same_frame,before_counts:before.counts,after_counts:after.counts}});
     record.checks.push({name:'no_unhandled_page_errors',status:record.page_error_classes.length?'FAIL':'PASS'});
     record.result=record.checks.every(c=>c.status==='PASS')&&!record.stop_reason?'PASS':'CHECKS_FAILED';
    }
    await page.screenshot({path:out+'/'+name+'.png',fullPage:true,timeout:15000}).catch(()=>{});
    const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>({
      name:r.name,decoded_body_bytes:r.decodedBodySize||null,encoded_body_bytes:r.encodedBodySize||null,
      transfer_bytes:r.transferSize||null}))).catch(()=>[]);
    record.resource_timing=resources.map(r=>({...safeUrl(r.name),decoded_body_bytes:r.decoded_body_bytes,
      encoded_body_bytes:r.encoded_body_bytes,transfer_bytes:r.transfer_bytes}));
   }catch(error){record.result='BROWSER_CHECK_ERROR';record.fatal_error_class=error.name;}
   await Promise.allSettled([...pending]);
   record.network_by_host=aggregate(record.network,'host');record.network_by_path=aggregate(record.network,'path');
   record.primary_encoded_body_bytes=record.network.reduce((n,r)=>n+(r.sizes?.responseBodySize||0),0);
   record.primary_response_header_bytes=record.network.reduce((n,r)=>n+(r.sizes?.responseHeadersSize||0),0);
   record.finished_utc=new Date().toISOString();save();
   await context.close();
   if(record.stop_reason==='network_budget')break;
  }
 }finally{await browser.close();}
 report.finished_utc=new Date().toISOString();save();
 console.log(JSON.stringify({output:out,viewports:report.viewports.map(v=>({name:v.name,result:v.result,
   model_playing_verified:v.model_playing_verified,encoded_body_bytes:v.primary_encoded_body_bytes,
   response_header_bytes:v.primary_response_header_bytes,cdp_encoded_transfer_bytes:v.cdp_encoded_transfer_bytes}))},null,2));
 process.exitCode=report.viewports.every(v=>v.result==='PASS')?0:1;
})().catch(error=>{console.error(error.name);process.exitCode=1;});
