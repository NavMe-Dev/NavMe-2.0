/* Floor-level spatial matching. Pure geometry + SDK adapter; owns no iframe. */
(function(root){
  'use strict';
  const unavailable='3D view is not available for this location.';
  const finite=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function apply(m,p){return {x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]};}
  function inverse(m){
    if(!Array.isArray(m)||m.length!==6||!m.every(Number.isFinite))throw Error('Invalid floor alignment');
    const [a,b,c,d,e,f]=m,det=a*d-b*c;
    if(Math.abs(det)<1e-10)throw Error('Invalid floor alignment');
    return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
  }
  const toSdk=p=>({x:p.x,y:p.z,z:-p.y});
  const toModel=p=>({x:p.x,y:-p.z,z:p.y});
  function onSegment(p,a,b,epsilon=1e-7){const dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;if(!len)return Math.hypot(p.x-a[0],p.y-a[1])<=epsilon;const t=Math.max(0,Math.min(1,((p.x-a[0])*dx+(p.y-a[1])*dy)/len));return Math.hypot(p.x-a[0]-t*dx,p.y-a[1]-t*dy)<=epsilon;}
  function ringContains(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[j],b=ring[i];if(onSegment(p,a,b))return true;if((a[1]>p.y)!==(b[1]>p.y)&&p.x<(b[0]-a[0])*(p.y-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
  function polygonContains(p,polygon){return !!polygon?.length&&ringContains(p,polygon[0])&&!polygon.slice(1).some(r=>ringContains(p,r));}
  const covered=(p,polygons)=>(polygons||[]).some(poly=>polygonContains(p,poly));
  function lineCovered(a,b,polygons){const steps=Math.max(1,Math.ceil(distance(a,b)/.15));for(let i=0;i<=steps;i++){const t=i/steps;if(!covered({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},polygons))return false;}return true;}
  function wallCrossed(a,b,walls){
    const cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    return (walls||[]).some(line=>line.slice(1).some((v,i)=>{const u=line[i],c={x:u[0],y:u[1]},d={x:v[0],y:v[1]};const ab1=cross(a,b,c),ab2=cross(a,b,d),cd1=cross(c,d,a),cd2=cross(c,d,b);return (ab1*ab2<0&&cd1*cd2<0)||onSegment(a,u,v,.06)||onSegment(b,u,v,.06)||onSegment(c,[a.x,a.y],[b.x,b.y])||onSegment(d,[a.x,a.y],[b.x,b.y]);}));
  }
  class KDTree{
    constructor(points){const build=(p,depth)=>{if(!p.length)return null;const key=depth%2?'y':'x';p.sort((a,b)=>a[key]-b[key]);const i=p.length>>1;return {point:p[i],key,left:build(p.slice(0,i),depth+1),right:build(p.slice(i+1),depth+1)};};this.tree=build(points.slice(),0);}
    near(p,r){const out=[];const visit=n=>{if(!n)return;const delta=p[n.key]-n.point[n.key];if(distance(p,n.point)<=r)out.push(n.point);if(delta<=r)visit(n.left);if(delta>=-r)visit(n.right);};visit(this.tree);return out.sort((a,b)=>distance(p,a)-distance(p,b));}
  }
  function calibrationValid(cal,ctx,floorId){
    if(!cal||!Array.isArray(cal.anchors)||cal.anchors.length<6||!['validated_draft','approved'].includes(cal.status)||cal.floor_id!==floorId||cal.model_id!==ctx.model_id||cal.source_version!==ctx.source_version||!cal.validation?.passed||!cal.sdk_floor_id||!Array.isArray(cal.valid_region)||cal.valid_region.length<3)return false;
    try{inverse(cal.diagram_to_model);}catch(_){return false;}
    return Number.isFinite(cal.elevation_model_m)&&cal.validation.max_error_m<=.5&&cal.validation.holdout_count>=2;
  }
  function normalizeSweeps(raw,context,calibrations){
    const source=new Map(context.sweeps.map(s=>[s.id,s])),out=[],live=new Map(),validFloors=new Set();
    for(const item of raw||[])for(const id of [item.id,item.sid,item.uuid,...(item._sourceAliases||[])].filter(Boolean))live.set(id,item);
    for(const [floorId,cal] of Object.entries(calibrations)){
      if(!calibrationValid(cal,context,floorId))continue;
      const anchorsAgree=cal.anchors.every(anchor=>{const item=live.get(anchor.sweep_id),ref=source.get(anchor.sweep_id);if(!item||!ref||item.enabled!==true||item.floorInfo?.id!==cal.sdk_floor_id||!item.puckPosition)return false;const p=toModel(item.puckPosition);return Math.hypot(p.x-ref.position.x,p.y-ref.position.y,p.z-ref.position.z)<=.3;});
      if(anchorsAgree)validFloors.add(floorId);
    }
    for(const item of raw||[]){
      if(!item||item.enabled!==true||item.alignmentType!=='aligned'||!['auto','manual'].includes(item.placementType)||!finite(item.position)||!Number.isFinite(item.position.z))continue;
      const ids=[item.id,item.sid,item.uuid,...(item._sourceAliases||[])].filter(Boolean),ref=ids.map(id=>source.get(id)).find(Boolean);
      if(!ref)continue;
      const cal=calibrations[ref.floor_id],floor=context.floors[ref.floor_id];
      if(!floor||!validFloors.has(ref.floor_id)||!calibrationValid(cal,context,ref.floor_id)||item.floorInfo?.id!==cal.sdk_floor_id)continue;
      const model=toModel(item.position),puck=item.puckPosition?toModel(item.puckPosition):ref.position;
      // Source pucks, runtime camera positions, and the reviewer-validated floor
      // elevation must all agree; numeric floor indices are never guessed.
      if(distance(model,ref.position)>.25||Math.abs(puck.z-ref.position.z)>.3||Math.abs(ref.position.z-cal.elevation_model_m)>.65)continue;
      out.push({id:item.id||item.sid,aliases:ids,sourceId:ref.id,modelId:context.model_id,floorId:ref.floor_id,
        x:model.x,y:model.y,z:ref.position.z,position:item.position,neighbors:item.neighbors||[],sourceNeighbors:ref.neighbors||[]});
    }
    return out;
  }
  class Matcher{
    constructor(context,calibrations={}){this.context=context;this.calibrations=calibrations;this.byFloor=new Map();this.byId=new Map();this.version=0;}
    update(runtime){const start=performance.now();this.runtime=runtime;const points=normalizeSweeps(runtime,this.context,this.calibrations);this.byId=new Map();for(const p of points)for(const id of p.aliases)this.byId.set(id,p);this.byFloor.clear();for(const floor of Object.keys(this.context.floors)){const pts=points.filter(p=>p.floorId===floor);this.byFloor.set(floor,new KDTree(pts));}this.version++;this.indexMs=performance.now()-start;return points.length;}
    setCalibration(cal){this.calibrations[cal.floor_id]=cal;return this.update(this.runtime||[]);}
    findBestMatterportSweep(target2D,floorId,modelId){
      const started=performance.now(),ctx=this.context,cal=this.calibrations[floorId],floor=ctx.floors[floorId];
      const fail=reason=>({ok:false,reason,message:unavailable,lookupMs:performance.now()-started});
      if(!finite(target2D)||modelId!==ctx.model_id||!floor)return fail('invalid_context');
      if(!calibrationValid(cal,ctx,floorId))return fail('alignment_required');
      if(!ringContains(target2D,cal.valid_region))return fail('outside_calibrated_region');
      let target=apply(cal.diagram_to_model,target2D);target.z=cal.elevation_model_m;
      const originalTarget=target;
      const room=(floor.rooms||[]).find(r=>r.verified&&polygonContains(target,r.polygon));
      let entrance=null;
      if(!covered(target,floor.coverage)){
        entrance=room&&(floor.verified_entrances||[]).find(e=>e.verified&&e.room_id===room.id&&finite(e.point)&&distance(target,e.point)<=Math.min(4,e.max_target_distance_m||2)&&covered(e.point,floor.coverage)&&!wallCrossed(target,e.point,floor.walls));
        if(!entrance)return fail('unscanned_location');
        target={...entrance.point,z:cal.elevation_model_m};
        if(!ringContains(apply(inverse(cal.diagram_to_model),target),cal.valid_region))return fail('outside_calibrated_region');
      }
      const radius=Math.min(3,Math.max(1,(floor.scan_spacing_m||1)*1.5));
      const candidates=this.byFloor.get(floorId)?.near(target,radius)||[];
      const inverseTransform=inverse(cal.diagram_to_model);
      for(const sweep of candidates){
        if(!sweep.neighbors.some(id=>{const n=this.byId.get(id);return n&&n.floorId===floorId&&sweep.sourceNeighbors.includes(n.sourceId);}))continue;
        if(room&&!entrance&&!polygonContains(sweep,room.polygon))continue;
        if(entrance&&!polygonContains(sweep,entrance.approach_polygon||[]))continue;
        if(!entrance&&target2D.region&&!polygonContains(apply(inverseTransform,sweep),target2D.region))continue;
        if(wallCrossed(target,sweep,floor.walls)||!lineCovered(target,sweep,floor.coverage))continue;
        const d=distance(target,sweep),confidence=1-d/(4*radius)-cal.validation.max_error_m/2;
        if(confidence<.75)continue;
        return {ok:true,sweep,target,originalTarget,fallback:entrance?'verified_entrance':null,floorId,modelId,confidence,distanceM:d,indexVersion:this.version,lookupMs:performance.now()-started};
      }
      return fail(candidates.length?'geometry_or_confidence_rejected':'no_suitable_sweep');
    }
    reverse(sdkPosition,sweepId){const sweep=this.byId.get(sweepId);if(!sweep||!finite(sdkPosition))return null;const model=toModel(sdkPosition),cal=this.calibrations[sweep.floorId],floor=this.context.floors[sweep.floorId];if(distance(model,sweep)>2||!covered(model,floor.coverage))return null;const point=apply(inverse(cal.diagram_to_model),model);if(!ringContains(point,cal.valid_region))return null;return {floorId:sweep.floorId,point,sweepId:sweep.id};}
  }
  const deadline=(promise,ms,message)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(message)),ms);Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
  function observe(observable,callback){if(!observable?.subscribe)return ()=>{};let sub;try{sub=observable.subscribe(callback);}catch(_){return ()=>{};}return ()=>{if(typeof sub==='function')sub();else sub?.cancel?.();};}
  function sdkAdapter(sdk,context,onUpdate,onPosition){
    const subscriptions=[],entries=new Map(),floors=new Map(),aliases=new Map();let disposed=false,pose=null,current=null,lastPose=0,scheduled=false,modelChecked=false,dirty=true;
    const snapshot=()=>[...entries.values()].map(item=>({...item,_sourceAliases:[item.id,item.sid,item.uuid].flatMap(id=>aliases.get(id)||[])}));
    const flush=()=>{if(disposed||!modelChecked||!dirty)return;dirty=false;onUpdate(snapshot());};
    const changed=()=>{dirty=true;if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;flush();});};
    // Observable collection is authoritative for enabled/placed status. Legacy
    // Model.getData helps establish model identity, never invents enabled flags.
    subscriptions.push(observe(sdk.Sweep?.data,{onAdded:(key,v)=>{entries.set(key,v);changed();},onUpdated:(key,v)=>{entries.set(key,v);changed();},onRemoved:key=>{entries.delete(key);changed();},onCollectionUpdated:collection=>{entries.clear();for(const [k,v] of Object.entries(collection||{}))if(v&&typeof v==='object')entries.set(k,v);changed();}}));
    if(sdk.Floor?.data)subscriptions.push(observe(sdk.Floor.data,{onCollectionUpdated:collection=>{floors.clear();for(const [k,v] of Object.entries(collection||{}))floors.set(k,v);}}));
    subscriptions.push(observe(sdk.Sweep?.current,value=>{current=value;}));
    subscriptions.push(observe(sdk.Camera?.pose,value=>{pose=value;const now=performance.now();if(now-lastPose<200||value?.mode!=='mode.inside'||!current?.id)return;lastPose=now;onPosition?.(value.position,current.id);}));
    const ready=deadline(Promise.resolve().then(async()=>{const data=await sdk.Model.getData();if(data.sid!==context.model_id)throw Error('Matterport model mismatch');if(sdk.Sweep?.Conversion?.createIdMap){try{const mapping=await sdk.Sweep.Conversion.createIdMap();for(const [a,b] of Object.entries(mapping||{})){aliases.set(a,[b]);aliases.set(b,[a]);}}catch(_){/* unknown IDs remain ineligible */}}if(sdk.App?.state?.waitUntil)await sdk.App.state.waitUntil(state=>state.phase===(sdk.App.Phase?.PLAYING||'appphase.playing'));modelChecked=true;flush();return true;}),15000,'Matterport is not ready');
    return {ready,entries,floors,snapshot,flush,get pose(){return pose;},get current(){return current;},dispose(){disposed=true;subscriptions.splice(0).forEach(fn=>fn());}};
  }
  function createNavigator({getConnection,context,calibrations,onPosition,onMetrics,beforeMove}){
    let sdk=null,adapter=null,generation=0,tail=Promise.resolve(),disposed=false;
    const matcher=new Matcher(context,calibrations||{});
    async function ready(){
      const start=performance.now();let live;
      while(!disposed&&performance.now()-start<15000){live=getConnection();if(live?.sdk)break;await new Promise(r=>setTimeout(r,100));}
      if(disposed||!live?.sdk)throw Error('Matterport is not ready');
      if(sdk!==live.sdk){adapter?.dispose();sdk=live.sdk;adapter=sdkAdapter(sdk,context,raw=>matcher.update(raw),(position,id)=>{const reverse=matcher.reverse(position,id);if(reverse)onPosition?.(reverse);});}
      const connectionAdapter=adapter;try{await connectionAdapter.ready;}catch(error){connectionAdapter.dispose();if(adapter===connectionAdapter){adapter=null;sdk=null;}throw error;}
      if(sdk!==live.sdk||adapter!==connectionAdapter)throw Error('Matterport connection changed');
      onMetrics?.({viewerReadyMs:performance.now()-start,indexMs:matcher.indexMs||0,sweepCount:matcher.byId.size});
      return {sdk,adapter};
    }
    async function navigate(target,floorId,modelId){
      const ticket=++generation,start=performance.now();
      const work=async()=>{
        if(ticket!==generation||disposed)return {ok:false,reason:'cancelled'};
        const connection=await ready();if(ticket!==generation||disposed)return {ok:false,reason:'cancelled'};
        // Apply pending observable changes; an unchanged collection reuses its
        // cached index rather than rebuilding every source sweep on each click.
        connection.adapter.flush();
        const fresh=matcher.findBestMatterportSweep(target,floorId,modelId);if(!fresh.ok)return fresh;
        if(ticket!==generation||disposed)return {ok:false,reason:'cancelled'};
        beforeMove?.();
        const transition=connection.sdk.Camera?.TransitionType?.FLY||connection.sdk.Sweep.Transition?.FLY;
        await connection.sdk.Sweep.moveTo(fresh.sweep.id,{transition,transitionTime:900});
        if(ticket!==generation||disposed)return {ok:false,reason:'cancelled'};
        if(connection.adapter.pose?.mode!=='mode.inside'){
          const mode=connection.sdk.Mode;
          if(!mode?.moveTo)throw Error('Inside View is unavailable');
          await mode.moveTo(mode.Mode?.INSIDE||'mode.inside');
        }
        const landed=()=>{const current=connection.adapter.current;return current&&fresh.sweep.aliases.includes(current.id||current.sid)&&connection.adapter.pose?.mode==='mode.inside';};
        const began=performance.now();while(!landed()&&performance.now()-began<5000){if(ticket!==generation||disposed)return {ok:false,reason:'cancelled'};await new Promise(r=>setTimeout(r,50));}
        if(!landed())return {ok:false,reason:'landing_not_confirmed',message:unavailable};
        if(fresh.indexVersion!==matcher.version){const latest=matcher.findBestMatterportSweep(target,floorId,modelId);if(!latest.ok||latest.sweep.id!==fresh.sweep.id)return {ok:false,reason:'sweep_data_changed',message:unavailable};}
        onMetrics?.({clickToNavigationMs:performance.now()-start,lookupMs:fresh.lookupMs,indexMs:matcher.indexMs});
        return {...fresh,landed:true};
      };
      const task=tail.then(work);tail=task.catch(()=>{});
      try{return await deadline(task,30000,'3D view is not available for this location.');}
      catch(error){if(ticket===generation)generation++;return {ok:false,reason:'viewer_error',message:unavailable,error:error.message};}
    }
    return {ready,navigate,matcher,setCalibration:cal=>matcher.setCalibration(cal),cancel(){generation++;},dispose(){disposed=true;generation++;adapter?.dispose();},get adapter(){return adapter;}};
  }
  const api={apply,inverse,toSdk,toModel,ringContains,polygonContains,covered,lineCovered,wallCrossed,KDTree,Matcher,calibrationValid,normalizeSweeps,sdkAdapter,createNavigator,unavailable};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WFPlanNavigation=api;
})(typeof window!=='undefined'?window:globalThis);
