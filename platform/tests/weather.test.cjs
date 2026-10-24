const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../viewer/weather.js');
const weather=(slug,temp=28)=>({building_slug:slug,available:true,temperature_c:temp,condition:'Clear',cache_seconds:900});
function context(fetchWeather){
 let now=0,active=true,id=0;const timers=new Map(),applied=[];
 const controller=create({fetchWeather,apply:data=>applied.push(data),now:()=>now,setTimer:(fn,delay)=>{const key=++id;timers.set(key,{fn,delay});return key;},clearTimer:key=>timers.delete(key),isActive:()=>active});
 return {controller,timers,applied,setNow:value=>now=value,setActive:value=>active=value};
}
test('badge and sidebar share one request and cache for fifteen minutes',async()=>{
 let calls=0;const c=context(async slug=>{calls++;return weather(slug);});
 await c.controller.setVenue('gcu');await c.controller.setVenue('gcu');await c.controller.resume();
 assert.equal(calls,1);assert.equal(c.applied.filter(Boolean).length,1);assert.equal(c.timers.size,1);
 c.controller.dispose();assert.equal(c.timers.size,0);
});
test('concurrent requests are shared rather than duplicated',async()=>{
 let resolve,calls=0;const c=context(slug=>{calls++;return new Promise(r=>resolve=()=>r(weather(slug)));});
 const a=c.controller.setVenue('gcu'),b=c.controller.setVenue('gcu');await Promise.resolve();resolve();await Promise.all([a,b]);
 assert.equal(calls,1);assert.equal(c.applied.filter(Boolean).length,1);c.controller.dispose();
});
test('venue switching resets the badge immediately and rejects stale responses',async()=>{
 const pending={};const c=context(slug=>new Promise(resolve=>{pending[slug]=resolve;}));
 const a=c.controller.setVenue('gcu');await Promise.resolve();
 const b=c.controller.setVenue('other');await Promise.resolve();
 assert.equal(c.controller.get(),null);
 pending.other(weather('other',20));await b;pending.gcu(weather('gcu',30));await a;
 assert.equal(c.controller.get().temperature_c,20);assert.equal(c.controller.get().building_slug,'other');c.controller.dispose();
});
test('API failure and invalid temperatures produce unavailable state, never a hardcoded value',async()=>{
 for(const data of [null,{...weather('gcu'),temperature_c:null},{...weather('gcu'),temperature_c:NaN}]){
  const c=context(async()=>{if(!data)throw new Error('unavailable');return data;});
  await c.controller.setVenue('gcu');assert.equal(c.controller.get().available,false);assert.equal(c.controller.get().temperature_c,undefined);c.controller.dispose();
 }
});
test('background or immersive views pause requests and refresh only after cache expires',async()=>{
 let calls=0;const c=context(async slug=>{calls++;return weather(slug);});
 await c.controller.setVenue('gcu');c.setActive(false);c.controller.pause();c.setNow(1000000);await c.controller.resume();assert.equal(calls,1);
 c.setActive(true);await c.controller.resume();assert.equal(calls,2);c.controller.dispose();
});
test('valid zero temperatures are displayed and cache reused when returning to a venue',async()=>{
 let calls=0;const c=context(async slug=>{calls++;return weather(slug,0);});
 await c.controller.setVenue('gcu');await c.controller.setVenue('other');await c.controller.setVenue('gcu');
 assert.equal(c.controller.get().temperature_c,0);assert.equal(calls,2);c.controller.dispose();
});
