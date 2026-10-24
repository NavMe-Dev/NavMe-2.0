const {test} = require('node:test');
const assert = require('node:assert/strict');
const E = require('../viewer/explore.js');
const data = (slug, pois = [{id: 'one', name: 'Library', floor_name: 'Ground floor'}]) => ({building_slug:slug,pois,facilities:[]});
const options = {venue:'gcu',venueName:'Actual current venue'};
test('cards join only current venue POIs by ID and use actual names and floor metadata',()=>{
 const cards=E.cards([{id:'one',name:'old'},{id:'other',name:'foreign'},{id:'one',name:'duplicate'}],data('gcu'),options);
 assert.deepEqual(cards,[{id:'one',name:'Library',building:'Actual current venue',floor:'Ground floor',image:null}]);
 assert.deepEqual(E.cards([{id:'one'}],data('uncc'),options),[]);
 assert.deepEqual(E.cards([{id:'one',building_slug:'uncc'}],data('gcu'),options),[]);
});
test('missing floors and images remain unknown rather than borrowing arbitrary values',()=>{
 const cards=E.cards([{id:'one',floor:'F1',nearest_node:'scan'}],data('gcu',[{id:'one',name:'A'}]),options);
 assert.equal(cards[0].floor,null);assert.equal(cards[0].image,null);
});
test('image preference is linked photo, linked cover, then the exact scan thumbnail',()=>{
 const p=[{id:'one',nearest_node:'scan'}];
 assert.equal(E.cards(p,data('gcu',[{id:'one',image_url:'https://images.test/own.jpg'}]),{...options,shops:{one:{cover_image_url:'https://images.test/shop.jpg'}}})[0].image,'https://images.test/own.jpg');
 assert.equal(E.cards(p,data('gcu'),{...options,shops:{one:{cover_image_url:'https://images.test/shop.jpg'}}})[0].image,'https://images.test/shop.jpg');
 assert.equal(E.cards(p,data('gcu'),{...options,thumbnail:id=>id==='scan'?'/actual-scan.jpg':null})[0].image,'/actual-scan.jpg');
});
test('card markup escapes authored names, rejects unsafe image schemes, and supports lazy loading',()=>{
 assert.equal(E.imageUrl('javascript:alert(1)'),null);
 assert.equal(E.imageUrl('//untrusted.test/image'),null);
 const html=E.gridHtml([{id:'"><script>',name:'<script>name</script>',building:'A & B',floor:null,image:'https://images.test/photo.jpg'}],{floorUnavailable:'Floor not listed'});
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(html.includes('loading="lazy"'));assert.ok(html.includes('type="button"'));assert.ok(html.includes('Floor not listed'));
});
test('shared metadata requests are cached across tab switches',async()=>{
 let calls=0;const applied=[];
 const c=E.create({fetchData:async slug=>{calls++;return data(slug);},apply:s=>applied.push(s)});
 await Promise.all([c.load('gcu'),c.load('gcu')]);await c.load('gcu');
 assert.equal(calls,1);assert.equal(c.get().status,'ready');assert.equal(applied.length,2);
});
test('switching venues rejects a late response from the previous venue',async()=>{
 const pending={};const c=E.create({fetchData:slug=>new Promise(resolve=>pending[slug]=resolve),apply:()=>{}});
 const a=c.load('gcu');await Promise.resolve();const b=c.load('uncc');await Promise.resolve();
 pending.uncc(data('uncc'));await b;pending.gcu(data('gcu'));await a;
 assert.equal(c.get().venue,'uncc');assert.equal(c.get().data.building_slug,'uncc');
});
test('metadata errors can be retried without retaining a failed cache entry',async()=>{
 let calls=0;const c=E.create({fetchData:async slug=>{if(++calls===1)throw Error('offline');return data(slug);},apply:()=>{}});
 await c.load('gcu');assert.equal(c.get().status,'error');await c.load('gcu',true);assert.equal(c.get().status,'ready');assert.equal(calls,2);
});
test('metadata expires and malformed or foreign venue responses fail safely',async()=>{
 let now=0,calls=0;const c=E.create({fetchData:async slug=>{calls++;return data(slug);},apply:()=>{},now:()=>now});
 await c.load('gcu');now=300001;await c.load('gcu');assert.equal(calls,2);
 const bad=E.create({fetchData:async()=>data('uncc'),apply:()=>{}});await bad.load('gcu');assert.equal(bad.get().status,'error');
});
