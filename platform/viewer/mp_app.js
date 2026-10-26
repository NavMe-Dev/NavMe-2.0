/* Lightweight public runtime for ?mp=1.
 * Matterport owns all rendering, so this deliberately does not load ArcGIS.
 * It provides the small wf interface ui.js needs plus search/POIs/routing. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const J = u => fetch(u).then(r => { if (!r.ok) throw new Error("Data request failed (" + r.status + ")"); return r.json(); });
  const R = 6378137;
  let CFG, currentFloor, lastLoc = null, lastRoute = null;

  // ui.js needs only these three Turf operations in Matterport mode. Keeping the
  // tiny spherical formulas here avoids downloading/parsing the 536 KB Turf bundle.
  if (!window.turf) window.turf = {
    point: coordinates => ({ geometry: { coordinates } }),
    bearing(a, b) {
      const p=a.geometry.coordinates, q=b.geometry.coordinates, d2r=Math.PI/180;
      const p1=p[1]*d2r, p2=q[1]*d2r, dl=(q[0]-p[0])*d2r;
      return Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI;
    },
    destination(origin, distance, bearing, opts) {
      const p=origin.geometry.coordinates, radius=(opts&&opts.units)==="kilometers"?6371.0088:6371008.8;
      const angular=distance/radius, br=bearing*Math.PI/180, lat1=p[1]*Math.PI/180, lon1=p[0]*Math.PI/180;
      const lat2=Math.asin(Math.sin(lat1)*Math.cos(angular)+Math.cos(lat1)*Math.sin(angular)*Math.cos(br));
      const lon2=lon1+Math.atan2(Math.sin(br)*Math.sin(angular)*Math.cos(lat1),Math.cos(angular)-Math.sin(lat1)*Math.sin(lat2));
      return { geometry: { coordinates: [lon2*180/Math.PI,lat2*180/Math.PI] } };
    }
  };

  class Layer {
    constructor(opts) { Object.assign(this, opts || {}); this.items = []; }
    add(x) { this.items.push(x); return x; }
    addMany(xs) { this.items.push(...(xs || [])); }
    removeAll() { this.items.length = 0; }
  }
  class Value { constructor(opts) { Object.assign(this, opts || {}); } }
  const noopView = {
    ui: { components: [] }, zoom: 20, extent: null, container: null,
    goTo: () => Promise.resolve(), hitTest: () => Promise.resolve({ results: [] }),
    on: () => ({ remove() {} }), watch: () => ({ remove() {} }),
    toScreen: () => ({ x: innerWidth / 2, y: innerHeight / 2 })
  };
  const layers = [];
  const noopMap = {
    layers: { indexOf: x => layers.indexOf(x), get length() { return layers.length; }, on: () => ({ remove() {} }) },
    add(x) { layers.push(x); }, addMany(xs) { layers.push(...(xs || [])); }, reorder() {}
  };

  function slug() {
    return (WF.building && WF.building.slug) || (WF.cfg && WF.cfg.slug)
      || (window.WFQuery ? WFQuery() : new URLSearchParams(location.search)).get("b") || "";
  }
  function floorLabel(nav, id) {
    if (id === "all") return (window.WFi18n && WFi18n.t("viewer.allFloors")) || "All floors";
    const label = (nav.floors[id] || {}).label || id;
    const m = /^floor\s+(\d+)$/i.exec(label);
    return (m && window.WFi18n && WFi18n.t("viewer.floorN", { n: m[1] })) || label;
  }

  window.WF.ready.then(async () => {
    CFG = WF.cfg;
    const D = f => WF.D(f), F = CFG.files;
    const [georef, navmePois, categories, stairs, shops, arRef, translations] = await Promise.all([
      J(D(F.georef)),
      J("/api/v1/public/dashboard/buildings/" + encodeURIComponent(slug()) + "/navme-pois").catch(() => null),
      J("/api/v1/public/dashboard/buildings/" + encodeURIComponent(slug()) + "/navme-categories").catch(() => []),
      J("/api/v1/public/dashboard/buildings/" + encodeURIComponent(slug()) + "/navme-stair-chains").catch(() => []),
      J("/api/v1/public/buildings/" + encodeURIComponent(slug()) + "/shops").catch(() => []),
      J("/api/v1/public/buildings/" + encodeURIComponent(slug()) + "/ar-experience-ref").catch(() => ({})),
      J("/api/v1/public/buildings/" + encodeURIComponent(slug()) + "/translations").catch(() => ({ poi_names: {}, category_names: {} }))
    ]);

    const A = georef.model_to_epsg3857_affine;
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const modelToLL = (x, y) => {
      const X = A[0][0] * x + A[0][1] * y + A[0][2], Y = A[1][0] * x + A[1][1] * y + A[1][2];
      return [X / R * 180 / Math.PI, Math.atan(Math.sinh(Y / R)) * 180 / Math.PI];
    };
    const llToModel = (lon, lat) => {
      const X = lon * Math.PI / 180 * R, Y = R * Math.asinh(Math.tan(lat * Math.PI / 180));
      const dx = X - A[0][2], dy = Y - A[1][2];
      return [(A[1][1] * dx - A[0][1] * dy) / det, (-A[1][0] * dx + A[0][0] * dy) / det];
    };
    const ordered = (CFG.floors || []).slice().sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
    const nav = { floors: {} };
    ordered.forEach(f => { nav.floors[f.id] = { label: f.label || f.id }; });
    const heights = (navmePois || []).map(p => p.y).filter(Number.isFinite);
    const bands = window.WFNavmeshRoute ? WFNavmeshRoute.deriveLevels(heights, ordered.length) : null;
    const floorFor = z => {
      if (bands && bands.length) {
        let best = 0, dist = Infinity;
        bands.forEach((b, i) => { const d = z < b.lo ? b.lo-z : z > b.hi ? z-b.hi : 0; if (d < dist) { dist=d; best=i; } });
        return (ordered[Math.min(best, ordered.length-1)] || {}).id || "F1";
      }
      return (ordered.reduce((a, f) => Math.abs((f.elevation || 0)-z) < Math.abs((a.elevation || 0)-z) ? f : a, ordered[0] || {id:"F1"})).id;
    };
    const names = translations.poi_names || {};
    const pois = (navmePois || []).map(p => {
      if (p.x == null || p.z == null) return p;
      const o = { id:String(p.id), name:p.name, names:names[String(p.id)] || null, category:p.category || "room",
        x:p.x, y:-p.z, z:p.y, floor:floorFor(p.y), sdk:{x:p.x,y:p.y,z:p.z} };
      o.lonlat = modelToLL(o.x, o.y);
      if (p.expected_pos_x != null && p.expected_pos_y != null && p.expected_pos_z != null)
        o.sdk.expected = {x:p.expected_pos_x,y:p.expected_pos_y,z:p.expected_pos_z};
      return o;
    });
    const byId = {}; pois.forEach(p => byId[p.id] = p);
    const derivedFloors = bands && bands.map((b,i) => ({id:(ordered[i]||{}).id || "F"+(i+1),label:(ordered[i]||{}).label || "Level "+(i+1),elevation:b.mid}));

    let navPromise = null, warmTimer = null, requestId = 0;
    function ensureNavmesh() {
      if (!window.WFNav) return null;
      if (WFNav.navmeshReady()) return Promise.resolve();
      if (navPromise) return navPromise;
      if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
      navPromise = WFNav.initNavmesh(slug(), {
        floors: derivedFloors || ordered.map(f => ({id:f.id,label:f.label||f.id,elevation:f.elevation})),
        levelYs: heights,
        // Matterport's live Sweep collection supplies navigation stops later; no
        // 4.7 MB NavMe graph is needed merely to open the Dollhouse.
        sweeps: [], modelToLL
      }).catch(e => console.warn("[navmesh] not available:", e.message || e));
      return navPromise;
    }
    function route(fromKey, toKey, opts) {
      opts = opts || {};
      const ticket = opts._ticket || ++requestId;
      const to = byId[toKey];
      let from = byId[fromKey];
      if (fromKey === "__loc" && lastLoc) {
        const fm = ordered.find(f => f.id === lastLoc.floor) || ordered[0] || { elevation: 0 };
        from = { name: "My location", sdk: { x: lastLoc.x, y: fm.elevation || 0, z: -lastLoc.y } };
      }
      if (!from || !to) return null;
      if (!WFNav.navmeshReady() && !opts._waited) {
        const p = ensureNavmesh();
        if (p) {
          const el=$("routeSummary"); if(el) el.textContent="Preparing the navigation route…";
          p.then(() => { if(ticket===requestId) route(fromKey,toKey,{...opts,_ticket:ticket,_waited:true}); });
          return null;
        }
      }
      let r = null;
      if (WFNav.navmeshReady() && from.sdk && to.sdk) {
        const nr=WFNav.routeNavmesh(from.sdk,to.sdk); if(nr && !nr.error && !nr.partial) r=nr;
      }
      if (!r) {
        const message = window.WFi18n
          ? WFi18n.t("viewer.noRoute")
          : "We couldn't find a route to your destination. Try choosing another starting point or destination.";
        if(window.wf.onRoute) window.wf.onRoute(null, message);
        return null;
      }
      r.fromName=from.name; r.toName=to.name; r.toPoi=to.id;
      if (!r.instructions) r.instructions=(r.steps||[]).map(s=>({text:s.text,type:s.type,arrow:s.arrow,dir:s.dir,turn_deg:s.turn_deg,
        pt:s.point?{x:s.point.x,y:-s.point.z,z:s.point.y,floor:s.floor}:null,icon:s.arrow,dist:s.dist_m||0,sweep:s.sweep}));
      lastRoute=r; window.wf.lastRoute=r; if(window.wf.onRoute) window.wf.onRoute(r); return r;
    }

    window.WF.shopsByPoiId={}; (shops||[]).forEach(s=>{if(s&&s.poi_id)WF.shopsByPoiId[String(s.poi_id)]=s;});
    window.WF.arExperienceRef=arRef.experience_ref||null;
    if(window.ThreeDNav&&ThreeDNav.setStairChainRows)ThreeDNav.setStairChainRows(stairs);
    currentFloor=CFG.default_floor || (ordered[0]&&ordered[0].id) || "F1";
    window.wf={ready:true,indoorReady:true,pois,categories:(categories||[]).map(c=>({...c,names:(translations.category_names||{})[String(c.id)]||null})),nav,
      georef,modelToLL,llToModel,lastLoc:null,lastRoute:null,style:"satellite",showLabels:false,map2d:noopMap,map3d:noopMap,view2d:noopView,
      esri:{GraphicsLayer:Layer,Graphic:Value,Point:Value,Polyline:Value,Extent:Value},dotLayer:new Layer(),
      view:()=>noopView,is3D:()=>false,getView3d:()=>null,currentFloor:()=>currentFloor,
      floorLabel:id=>floorLabel(nav,id),setFloor:id=>{currentFloor=id;if(window.wf.onFloorUI)window.wf.onFloorUI(id);},
      setStyle:s=>{window.wf.style=s;return Promise.resolve();},route,
      clearRoute:()=>{requestId++;lastRoute=null;window.wf.lastRoute=null;},redrawPOIs:()=>{},showGraph:()=>{},
      setShowLabels:on=>{window.wf.showLabels=!!on;},startLocalize:()=>false,isLocalizing:()=>false,
      localizeAt:(lon,lat)=>{const xy=llToModel(lon,lat);lastLoc={lon,lat,x:xy[0],y:xy[1],floor:currentFloor};window.wf.lastLoc=lastLoc;if(window.wf.onLocalized)window.wf.onLocalized(lastLoc);},
      modelZtoAbs:z=>z,cam:()=>Promise.resolve(),fit3D:()=>Promise.resolve(),enterHeavyOverlay:()=>{},exitHeavyOverlay:()=>{},
      setRealMesh:()=>{},setMeshEdgeColor:()=>{},setMeshEdgeIntensity:()=>{},setHideShell:()=>{},setHideOsmBlocks:()=>{},setHideMesh:()=>{},setSolidBuildings:()=>{}
    };
    dispatchEvent(new Event("wf-pois-updated"));
  }).catch(e => { console.error("[wf-mp] startup failed",e); if(window.WFStartup)WFStartup.fail(); });
})();
