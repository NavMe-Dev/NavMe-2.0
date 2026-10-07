/* Wayfinding prototype P1+P2 – ArcGIS Maps SDK for JS 4.34 (AMD CDN), no API key.
   Basemap = public Esri World Imagery MapServer tiles via TileLayer (no key needed). */
require([
  "esri/Map", "esri/Basemap", "esri/layers/TileLayer", "esri/views/MapView", "esri/views/SceneView",
  "esri/layers/MediaLayer", "esri/layers/support/ImageElement", "esri/layers/support/CornersGeoreference",
  "esri/layers/GraphicsLayer", "esri/Graphic", "esri/geometry/Point", "esri/geometry/Extent",
  "esri/geometry/Mesh", "esri/layers/ElevationLayer", "esri/geometry/Polyline", "esri/geometry/Polygon",
  "esri/layers/VectorTileLayer", "esri/layers/WebTileLayer", "esri/layers/GeoJSONLayer", "esri/layers/support/TileInfo"
], function (Map, Basemap, TileLayer, MapView, SceneView, MediaLayer, ImageElement, CornersGeoreference,
  GraphicsLayer, Graphic, Point, Extent, Mesh, ElevationLayer, Polyline, Polygon, VectorTileLayer, WebTileLayer, GeoJSONLayer, TileInfo) {

  const $ = (id) => document.getElementById(id);
  const status = (t) => { $("status").textContent = t; };
  const R = 6378137.0;

  const J = (u) => fetch(u).then(r => r.json());
  let CFG = null; const D = (f) => window.WF.D(f);
  // WF.building is an object; the slug can also come from cfg or the ?b= query param.
  const wfSlug = () => (window.WF.building && window.WF.building.slug)
    || (window.WF.cfg && window.WF.cfg.slug)
    || new URLSearchParams(location.search).get("b") || "";
  window.WF.ready.then(() => { CFG = window.WF.cfg; const F = CFG.files;
    return Promise.all([J(D(F.georef)), J(D(F.floors)), J(D(F.nav_graph)), J(D(F.walkgrid)), J(D(F.pois)), J(D(F.mp_graph_raw)),
      F.navmesh ? J(D(F.navmesh)).catch(() => null) : Promise.resolve(null),
      // Live NavMe POIs (Supabase). These are the real places; the published pois.json
      // holds pipeline-detected entrances. Null on failure so the viewer still loads.
      J("/api/v1/public/dashboard/buildings/" + encodeURIComponent(wfSlug()) + "/navme-pois").catch(() => null),
      // NavMe Dashboard's curated category chips (name/icon_key/sort_order) — used by
      // ui.js only in Matterport mode (?mp=1) to replace the viewer's fixed chip set.
      J("/api/v1/public/dashboard/buildings/" + encodeURIComponent(wfSlug()) + "/navme-categories").catch(() => [])]); })
    .then(([georef, floorsData, nav, walkgrid, pois, rawGraph, navmesh, navmePois, navmeCategories]) => {
      pois._navme = navmePois;
      // platform config -> fields the prototype engine expects
      georef.floors = CFG.floors.map(f => ({ id: f.id, name: f.label, ordinal: f.ordinal, model_z: f.elevation }));
      floorsData.floors.forEach(f => { if (!/^(https?:|\/|data:)/.test(f.image)) f.image = D(f.image); });
      init(georef, floorsData, { nav, walkgrid, pois, rawGraph, navmesh, navmeCategories }); })
    .catch(e => { status("Failed to load data: " + e); console.error(e); });

  function init(georef, floorsData, R2) {
    // ---------- coordinate chain: model (m) <-> EPSG:3857 <-> WGS84 ----------
    const A = georef.model_to_epsg3857_affine;            // [[a,b,tx],[c,d,ty]]
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const modelToMerc = (x, y) => [A[0][0] * x + A[0][1] * y + A[0][2], A[1][0] * x + A[1][1] * y + A[1][2]];
    const mercToModel = (X, Y) => {
      const dx = X - A[0][2], dy = Y - A[1][2];
      return [(A[1][1] * dx - A[0][1] * dy) / det, (-A[1][0] * dx + A[0][0] * dy) / det];
    };
    const mercToLL = (X, Y) => [X / R * 180 / Math.PI, Math.atan(Math.sinh(Y / R)) * 180 / Math.PI]; // [lon,lat]
    const llToMerc = (lon, lat) => [lon * Math.PI / 180 * R, R * Math.asinh(Math.tan(lat * Math.PI / 180))];
    const modelToLL = (x, y) => mercToLL(...modelToMerc(x, y));
    const llToModel = (lon, lat) => mercToModel(...llToMerc(lon, lat));
    window.wf = { modelToLL, llToModel, georef };           // handy for console / tests

    const floorsMeta = {};
    georef.floors.forEach(f => floorsMeta[f.id] = f);
    const hg = floorsData.height_grid;
    function floorZ(fid, x, y) {                           // sample floor surface z from mesh-derived grid
      const g = hg.grids[fid]; const nominal = floorsMeta[fid].model_z;
      const c = Math.floor((x - hg.x0) / hg.res), r = Math.floor((y - hg.y0) / hg.res);
      let best = null, bestD = 1e9;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {   // nearest valid within 1 m
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= hg.ny || cc < 0 || cc >= hg.nx) continue;
        const v = g[rr][cc]; if (v === null) continue;
        const d = dr * dr + dc * dc; if (d < bestD) { bestD = d; best = v; }
      }
      return best === null ? { z: nominal, src: "nominal floor elevation" } : { z: best, src: "mesh floor surface" };
    }

    // ---------- layers ----------
    const imagery = new TileLayer({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" });
    const basemap = new Basemap({ baseLayers: [imagery], title: "World Imagery", id: "wi" });

    const floorLayers = {};
    floorsData.floors.forEach(f => {
      const pt = (ll) => new Point({ longitude: ll[0], latitude: ll[1] });
      const c = f.corners_lonlat; // TL TR BR BL
      const el = new ImageElement({
        image: f.image,
        georeference: new CornersGeoreference({ topLeft: pt(c[0]), topRight: pt(c[1]), bottomRight: pt(c[2]), bottomLeft: pt(c[3]) })
      });
      floorLayers[f.id] = new MediaLayer({ source: [el], opacity: 0.9, title: floorsMeta[f.id].name, visible: false });
    });
    const dotLayer = new GraphicsLayer({ title: "I'm here" });
    const dotLayer3D = new GraphicsLayer({ title: "I'm here 3D", elevationInfo: { mode: "absolute-height" } });
    const meshLayer = new GraphicsLayer({ title: "Matterport mesh", elevationInfo: { mode: "absolute-height" } });

    const siteLayer = new GraphicsLayer({ title: "Site", minScale: 0, maxScale: 3000 });
    const FIDS = CFG.floors.slice().sort((a, b) => a.ordinal - b.ordinal).map(f => f.id);
    const glassLayer = new GraphicsLayer({ title: "Building glass overlay" });
    (function () {
      const gf = floorsData.floors.find(f => f.id === FIDS[0]) || floorsData.floors[0];
      if (!gf || !gf.corners_lonlat || gf.corners_lonlat.length < 4) return;
      const c = gf.corners_lonlat; // TL TR BR BL
      glassLayer.add(new Graphic({
        geometry: new Polygon({
          rings: [[[c[0][0],c[0][1]], [c[1][0],c[1][1]], [c[2][0],c[2][1]], [c[3][0],c[3][1]], [c[0][0],c[0][1]]]],
          spatialReference: { wkid: 4326 }
        }),
        symbol: { type: "simple-fill", color: [0, 0, 0, 0.09], outline: { color: [0, 0, 0, 0.28], width: 1.5 } }
      }));
    })();
    const map2d = new Map({ basemap, layers: [siteLayer, glassLayer, ...FIDS.map(f => floorLayers[f]).filter(Boolean), dotLayer] });
    const map3d = new Map({ basemap: new Basemap({ baseLayers: [new TileLayer({ url: imagery.url })] }), ground: "world-elevation",
                            layers: [meshLayer, dotLayer3D] });

    const oLL = [georef.model_origin_wgs84.lon, georef.model_origin_wgs84.lat];
    const BB = CFG.model_bbox || [-40, -30, 20, 25], BC = [(BB[0] + BB[2]) / 2, (BB[1] + BB[3]) / 2];
    const bldgLL = modelToLL(BC[0], BC[1]);
    const camLL = modelToLL(BC[0], BB[1] - 45);   // 3D camera spot, ~55 m south of the buildings   // centre of scanned area (building + lot)
    const sitePt = new Point({ longitude: bldgLL[0], latitude: bldgLL[1] });
    siteLayer.addMany([
      new Graphic({ geometry: sitePt, symbol: { type: "simple-marker", style: "circle", size: 14, color: [230, 60, 40], outline: { color: "white", width: 2 } } }),
      new Graphic({ geometry: sitePt, symbol: { type: "text", text: CFG.name || "", color: "white", haloColor: [0, 0, 0, 0.8], haloSize: 1.5, yoffset: 14, font: { size: 13, weight: "bold" } } })]);
    // 2D stays straight top-down: no tilt, no rotation. Anything pitched belongs in 3D.
    const view2d = new MapView({ container: "viewDiv", map: map2d, center: [CFG.center.lon, CFG.center.lat], zoom: 17,
      constraints: { lods: TileInfo.create({ numLODs: 24 }).lods, maxZoom: 23, snapToZoom: false, rotationEnabled: false },
      rotation: 0, popupEnabled: false,
      padding: { left: window.innerWidth > 900 ? 300 : 0 } });
    view2d.watch("rotation", (r) => { if (r) view2d.rotation = 0; });
    if (window.WFMeshOverlay) {
      WFMeshOverlay.init({ georef: georef, glbUrl: D("model_full.glb"), view2d: view2d });
    }
    let view3d = null, activeView = view2d, currentFloor = CFG.default_floor || FIDS[0], localizing = false, lastLoc = null;
    status("2D · Esri World Imagery (no API key)");

    function buildingExtent() {
      const cs = floorsData.floors.flatMap(f => f.corners_lonlat);
      const xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
      return new Extent({ xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys), spatialReference: { wkid: 4326 } });
    }

    function fit3DCamera(opts) {
      opts = opts || {};
      if (!view3d) return Promise.resolve();
      const mobile = window.innerWidth < 700;
      const padTop = mobile ? 110 : 48;
      const padBot = mobile ? Math.min(340, Math.round(window.innerHeight * 0.34)) : 56;
      const padRight = mobile ? 56 : 72;
      view3d.padding = { top: padTop, bottom: padBot, left: 8, right: padRight };
      // Prefer framing the real floorplan extent so any building fills the usable screen
      let target = null;
      try { target = buildingExtent().expand(mobile ? 1.08 : 1.2); } catch (e) {}
      if (target) {
        return view3d.goTo({ target, tilt: mobile ? 48 : 55, heading: -5 }, {
          animate: !!opts.animate, duration: opts.duration || (opts.animate ? 900 : 0)
        });
      }
      const w = Math.max(8, BB[2] - BB[0]), h = Math.max(8, BB[3] - BB[1]);
      const size = Math.max(w, h);
      const south = size * (mobile ? 0.95 : 1.2);
      const elev = size * (mobile ? 0.7 : 0.85) + 8;
      const cam = modelToLL(BC[0], BB[1] - south);
      return view3d.goTo({
        position: { longitude: cam[0], latitude: cam[1], z: ground0 + elev },
        tilt: mobile ? 48 : 55, heading: -5
      }, { animate: !!opts.animate, duration: opts.duration || (opts.animate ? 900 : 0) });
    }

    $("btnZoom").onclick = () => {
      if (activeView === view2d) view2d.goTo({ target: buildingExtent().expand(1.05) }, { duration: 1200 });
      else fit3DCamera({ animate: true, duration: 1200 });
    };

    // ---------- floor switcher ----------
    function setFloor(fid) {
      currentFloor = fid;
      document.querySelectorAll("button.floor").forEach(b => b.classList.toggle("active", b.dataset.floor === fid));
      Object.entries(floorLayers).forEach(([k, l]) => {
        if (fid === "all") l.visible = true;
        else if (fid === "none") l.visible = false;
        else l.visible = (k === fid);
      });
      if (view3d) loadMesh();
      if (lastLoc) localizeAt(lastLoc.lon, lastLoc.lat);   // re-evaluate Z on floor change
      if (window.wf && window.wf.onFloor) window.wf.onFloor(fid);
      if (window.wf && window.wf.onStyleFloor) window.wf.onStyleFloor(fid);
      if (window.wf && window.wf.onFloorUI) window.wf.onFloorUI(fid);
    }
    document.querySelectorAll("button.floor").forEach(b => b.onclick = () => setFloor(b.dataset.floor));
    setFloor(CFG.default_floor || FIDS[0]);

    // ---------- 3D ----------
    let ground0 = 0, meshKey = null;
    const GRADE_Z = CFG.grade_z != null ? CFG.grade_z : 0.5;  // model z of courtyard grade at model origin; terrain height there = ground0
    async function ensure3D() {
      if (view3d) return;
      view3d = new SceneView({ container: null, map: map3d, qualityProfile: "high",
        environment: { lighting: { type: "virtual" } }, popupEnabled: false,
        camera: { position: { longitude: bldgLL[0], latitude: bldgLL[1] - 0.00075, z: 300 }, tilt: 55, heading: 0 } });
      view3d.on("click", onClick);
      if (window.WFMeshOverlay) WFMeshOverlay.setView3D(view3d);
      if (window.wf.on3DCreated) window.wf.on3DCreated(view3d);
      try {
        const el = new ElevationLayer({ url: "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer" });
        const r = await el.queryElevation(new Point({ longitude: oLL[0], latitude: oLL[1] }));
        ground0 = r.geometry.z;
      } catch (e) { console.warn("elevation query failed", e); }
      window.wf.ground0 = ground0;
      if (window.wf.on3DReady) window.wf.on3DReady();
    }
    function modelZtoAbs(z) { return ground0 + (z - GRADE_Z); }
    // Mesh glass-border colour + intensity — user-adjustable (Map layers panel).
    // Fill stays flat/translucent; only the edge wireframe colour and opacity change.
    let meshEdgeColor = [110, 110, 120], meshEdgeIntensity = 0.8;
    function meshSymbol() {
      return {
        type: "mesh-3d",
        symbolLayers: [{
          type: "fill",
          material: { color: [255, 255, 255, 0.12], colorMixMode: "replace" },
          edges: { type: "solid", color: [...meshEdgeColor, meshEdgeIntensity], size: 0.8 }
        }]
      };
    }
    function applyMeshSymbol() {
      const g = meshLayer.graphics.getItemAt(0);
      if (g) g.symbol = meshSymbol();
    }
    window.wf.setMeshEdgeColor = (rgb) => { meshEdgeColor = rgb; applyMeshSymbol(); };
    window.wf.setMeshEdgeIntensity = (v) => { meshEdgeIntensity = Math.max(0, Math.min(1, v)); applyMeshSymbol(); };
    // "Live" border colour — averaged from the GLB's own baked vertex colours (the
    // actual photographed scan, same COLOR_0 data glb.py wrote from the colour plans),
    // not a server round-trip: the mesh is already downloaded and decoded locally by
    // the time this runs, so sampling it here is instant and needs no separate API call.
    function averageMeshColor(mesh) {
      try {
        const col = mesh && mesh.vertexAttributes && mesh.vertexAttributes.color;
        if (!col || !col.length) return null;
        let r = 0, g = 0, b = 0, n = 0, mx = 0;
        const step = Math.max(4, Math.floor(col.length / 4 / 20000) * 4); // sample, not every vertex, on huge meshes
        for (let i = 0; i < col.length; i += step) {
          r += col[i]; g += col[i + 1]; b += col[i + 2]; n++;
          if (col[i] > mx) mx = col[i];
        }
        if (!n) return null;
        const scale = mx <= 1.0001 ? 255 : 1; // vertexAttributes.color can be 0-1 floats or 0-255 bytes
        return [Math.round(r / n * scale), Math.round(g / n * scale), Math.round(b / n * scale)];
      } catch (e) { return null; }
    }
    function loadMesh() {
      // All floors (or unknown): prefer full multi-floor GLB so stacked levels show together
      let glbName = "model_full.glb";
      if (currentFloor && currentFloor !== "all" && currentFloor !== "none") {
        const fm = CFG.floors.find(f => f.id === currentFloor);
        if (fm && fm.glb) glbName = fm.glb;
      } else {
        const full = CFG.floors.find(f => (f.glb || "").includes("full")) || CFG.floors[CFG.floors.length - 1];
        if (full && full.glb) glbName = full.glb;
      }
      const key = glbName.replace(/\.glb$/, "");
      if (key === meshKey) return; meshKey = key;
      meshLayer.removeAll();
      status("3D · loading " + key + ".glb …");
      const origin = new Point({ longitude: oLL[0], latitude: oLL[1], z: modelZtoAbs(0) });
      Mesh.createFromGLTF(origin, D(key + ".glb"), { vertexSpace: "local" }).then(mesh => {
        // The pipeline's glb.py step already rotates every vertex into true ENU
        // (+X=east, +Y=up, -Z=north) using this exact georef rotation angle, so the
        // GLB needs NO further rotation here — vertexSpace:"local" assumes ENU axes,
        // which the export already provides. Rotating again on top of that (as this
        // code used to) double-applies the angle and is why the mesh used to land
        // visibly off from the 2D floor plans / footprint, which only ever pass
        // through the georef affine once.
        // Glass look, matching shell3d's building-shell style exactly: colorMixMode
        // "replace" drops the mesh's own baked vertex-colour texture (walls/floor
        // photos) in favour of a flat translucent fill, with edges drawn as a solid
        // wireframe — same material + edge color/width as the OSM/indoor "glass"
        // extrusions elsewhere in this view, just applied to the real scanned shape
        // instead of a simple box.
        meshLayer.add(new Graphic({ geometry: mesh, symbol: meshSymbol() }));
        const live = averageMeshColor(mesh);
        if (live) { window.wf.meshLiveColor = live; if (window.wf.onMeshLiveColor) window.wf.onMeshLiveColor(live); }
        status("3D · " + (window.wf.style && window.wf.style !== "satellite" ? (window.wf.styleLabel + " · indoor blocks + OSM buildings") : "Matterport mesh (" + key + ", glass)") + " · ground " + ground0.toFixed(1) + " m");
        window.wf.meshReady = true;
        if (activeView === view3d) fit3DCamera({ animate: true, duration: 700 });
      }).catch(e => { status("mesh load failed: " + e.message); console.error(e); });
    }
    $("btnDim").onclick = async () => {
      if (activeView === view2d) {
        await ensure3D();
        const cam2dCenter = view2d.center.clone();
        view2d.container = null; view3d.container = "viewDiv"; activeView = view3d;
        if (window.WFMeshOverlay) WFMeshOverlay.setMode("3d");
        loadMesh(); if (window.wf.onStyleFloor) window.wf.onStyleFloor(currentFloor);
        await view3d.when();
        fit3DCamera({ animate: false });
        $("btnDim").textContent = "Switch to 2D";
        if (window.wf.onFloor) window.wf.onFloor(currentFloor);   // re-draw route/graph now that terrain height (ground0) is known
        if (lastLoc) localizeAt(lastLoc.lon, lastLoc.lat);
      } else {
        view3d.container = null; view2d.container = "viewDiv"; activeView = view2d;
        if (window.WFMeshOverlay) WFMeshOverlay.setMode("2d");
        $("btnDim").textContent = "Switch to 3D"; status("2D · " + (window.wf.styleLabel || "Esri World Imagery (no API key)"));
      }
    };

    // ---------- Localize (manual tap v0) ----------
    $("btnLocalize").onclick = () => {
      localizing = !localizing;
      $("btnLocalize").classList.toggle("on", localizing);
      $("hint").textContent = localizing ? "Tap the map where you are" : "";
    };
    view2d.on("click", onClick);
    async function onClick(evt) {
      // Prefer POI label / marker hit (2D or 3D screen-space) for From/To or place card
      try {
        const hits = await activeView.hitTest(evt);
        const gra = (hits.results || []).map(r => r.graphic).find(g => g && g.attributes && g.attributes.poi);
        if (gra) {
          if (window.wf.onPoiPick) window.wf.onPoiPick(gra.attributes.poi, evt);
          return;
        }
      } catch (e) { console.warn("hitTest", e); }
      if (!localizing || !evt.mapPoint) return;
      localizing = false; $("btnLocalize").classList.remove("on"); $("hint").textContent = "";
      localizeAt(evt.mapPoint.longitude, evt.mapPoint.latitude);
      if (window.wf.onLocalized) window.wf.onLocalized(lastLoc);
    }
    function localizeAt(lon, lat) {
      const fid = currentFloor === "none" ? FIDS[0] : currentFloor;
      const [x, y] = llToModel(lon, lat);
      const zInfo = floorZ(fid, x, y);
      const [lon2, lat2] = modelToLL(x, y);                // round trip model -> WGS84
      const errMM = Math.hypot((lon2 - lon) * 111320 * Math.cos(lat * Math.PI / 180), (lat2 - lat) * 110574) * 1000;
      const inside = x > BB[0] && x < BB[2] && y > BB[1] && y < BB[3];
      lastLoc = { lon, lat, x, y, z: zInfo.z, floor: fid };
      window.wf.lastLoc = lastLoc;
      const sym2 = { type: "simple-marker", style: "circle", size: 16, color: [0, 122, 255, 1], outline: { color: [255, 255, 255], width: 3 } };
      const halo = { type: "simple-marker", style: "circle", size: 42, color: [0, 122, 255, 0.18], outline: { color: [0, 122, 255, 0.5], width: 1 } };
      dotLayer.removeAll();
      dotLayer.addMany([new Graphic({ geometry: new Point({ longitude: lon, latitude: lat }), symbol: halo }),
                        new Graphic({ geometry: new Point({ longitude: lon, latitude: lat }), symbol: sym2,
                          attributes: { floor: fid } })]);
      dotLayer3D.removeAll();
      const absZ = modelZtoAbs(zInfo.z) + 0.3;
      dotLayer3D.add(new Graphic({ geometry: new Point({ longitude: lon, latitude: lat, z: absZ }),
        symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "sphere" }, width: 0.9, material: { color: [0, 122, 255] } }],
          verticalOffset: { screenLength: 0 } } }));
      $("out").textContent =
        `I'm here · ${floorsMeta[fid].name}\n` +
        `WGS84   lat ${lat.toFixed(7)}, lon ${lon.toFixed(7)}\n` +
        `Model   x ${x.toFixed(2)} m, y ${y.toFixed(2)} m, z ${zInfo.z.toFixed(2)} m\n` +
        `        (z from ${zInfo.src})${inside ? "" : "\n        ⚠ outside the scanned model bounds"}\n` +
        `Back    model→WGS84 lat ${lat2.toFixed(7)}, lon ${lon2.toFixed(7)}\n` +
        `        round-trip error ${errMM.toFixed(3)} mm\n` +
        `Georef  rot ${georef.rotation_deg.toFixed(2)}°, scale ${georef.scale.toFixed(3)}, RMS ${georef.rms_m.toFixed(2)} m`;
    }
    window.wf.localizeAt = localizeAt;

    // =====================================================================
    // P3+P4: hybrid routing UI (graph = Matterport sweeps + doors + stairs + OSM)
    // =====================================================================
    function initRouting() {
      const { nav, walkgrid, pois, rawGraph, navmesh } = R2;
      WFRouting.modelToLL = modelToLL;
      WFRouting.init(nav, walkgrid, navmesh);
      const N = WFRouting.nodes();
      // Replace the published POI set with the live NavMe one. Coordinates arrive in
      // Matterport SDK space (Y-up); model space is Z-up with model = (x, -z, y) — the
      // same mapping the route drawing uses. Floor comes from the nearest floor
      // elevation, because every NavMe POI is tagged F1 regardless of where it is.
      if (Array.isArray(pois._navme) && pois._navme.length) {
        // Floor assignment from the POIs' own heights, not config elevations: this
        // building's config has F2 at 3.43 and F3 at 3.04 (overlapping and out of order),
        // so nearest-elevation matching mislabels. Cluster the observed heights into
        // bands and map them bottom-up onto the floor list instead.
        const ordered = (CFG.floors || []).slice().sort((a, b) =>
          (a.ordinal != null && b.ordinal != null) ? a.ordinal - b.ordinal
            : ((a.elevation || 0) - (b.elevation || 0)));
        const ys = pois._navme.map(q => q.y).filter(v => v != null);
        const bands = (window.WFNavmeshRoute && WFNavmeshRoute.deriveLevels)
          ? WFNavmeshRoute.deriveLevels(ys, ordered.length) : null;
        const fl = ordered.filter(f => f.elevation != null);
        const floorFor = (mz) => {
          if (bands && bands.length) {
            let bi = 0, bd = Infinity;
            for (let i = 0; i < bands.length; i++) {
              const d = (mz >= bands[i].lo && mz <= bands[i].hi) ? 0
                      : Math.min(Math.abs(mz - bands[i].lo), Math.abs(mz - bands[i].hi));
              if (d < bd) { bd = d; bi = i; }
            }
            const f = ordered[Math.min(bi, ordered.length - 1)];
            if (f) return f.id;
          }
          if (!fl.length) return (ordered[0] || {}).id || "F1";
          let best = fl[0], bd2 = Infinity;
          for (const f of fl) { const d = Math.abs(mz - f.elevation); if (d < bd2) { bd2 = d; best = f; } }
          return best.id;
        };
        const conv = pois._navme.map((p) => {
          const x = p.x, y = -p.z, z = p.y;                 // SDK -> model
          const o = { id: String(p.id), name: p.name, category: p.category || "room",
                      x: x, y: y, z: z, floor: floorFor(z), sdk: { x: p.x, y: p.y, z: p.z } };
          // expected_pos_* is a separate curated "look here" anchor, same SDK -> model
          // conversion as the main position. Not every POI has one.
          if (p.expected_pos_x != null && p.expected_pos_y != null && p.expected_pos_z != null) {
            o.expected_x = p.expected_pos_x;
            o.expected_y = -p.expected_pos_z;
            o.expected_z = p.expected_pos_y;
            o.sdk.expected = { x: p.expected_pos_x, y: p.expected_pos_y, z: p.expected_pos_z };
          }
          try { const s2 = WFRouting.snap(x, y, o.floor); if (s2 && s2.node) o.nearest_node = s2.node.id; } catch (e) {}
          try { o.lonlat = modelToLL(x, y); } catch (e) {}
          return o;
        });
        // Keep every POI. nearest_node is only needed by the legacy graph fallback;
        // filtering on it made POIs disappear whenever the floor guess was off, which
        // is exactly the "stuck on floors" behaviour. The navmesh route never uses it.
        if (conv.length) pois.pois = conv;
        // Hand the derived bands to the navmesh bridge too, so route legs and the
        // turn-by-turn text use the same floors the POI list does rather than the
        // overlapping config elevations.
        if (bands && bands.length) {
          pois._derivedFloors = bands.map((bd, i) => {
            const f = ordered[Math.min(i, ordered.length - 1)] || {};
            return { id: f.id || ("L" + (i + 1)), label: f.label || f.id || ("Level " + (i + 1)),
                     elevation: bd.mid };
          });
        }
      }
      // Load the Recast navmesh in the background; doRoute uses it as soon as it is ready
      // and falls back to the sweep graph until then.
      if (window.WFNav) {
        WFNav.initNavmesh(wfSlug(), {
          floors: pois._derivedFloors
            || (CFG.floors || []).map(f => ({ id: f.id, label: f.label || f.id, elevation: f.elevation })),
          levelYs: (pois._navme || []).map(p => p.y).filter(v => v != null),
          // Real Matterport capture positions, so each step can surface the view there.
          sweeps: (nav.nodes || []).filter(n => n.kind === "sweep")
                                   .map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z })),
          modelToLL: modelToLL
        }).catch(e => console.warn("[navmesh] not available:", e.message || e));
      }
      const poiById = {}; pois.pois.forEach(p => poiById[p.id] = p);
      const floorLabel = F => F === "all" ? "All floors" : F === "none" ? "Off" : ((nav.floors[F] || {}).label || F);

      const graphLayer = new GraphicsLayer({ title: "Sweep graph (debug)", visible: false });
      const navmeshLayer = new GraphicsLayer({ title: "Navmesh (debug)", visible: false });
      const poiLayer = new GraphicsLayer({ title: "POIs", minScale: 2500 });
      const routeLayer = new GraphicsLayer({ title: "Route" });
      map2d.addMany([navmeshLayer, graphLayer, poiLayer, routeLayer], map2d.layers.indexOf(dotLayer));
      // Keep the route on top of plan overlays / building fills so it is never hidden.
      try { map2d.reorder(routeLayer, map2d.layers.length - 1); } catch (e) {}
      map2d.layers.on("after-add", () => { try { map2d.reorder(routeLayer, map2d.layers.length - 1); } catch (e) {} });
      // offset lifts the tube off the walking surface so the floor slab does not z-fight
      // with it or swallow it; the route still follows the mesh heights exactly.
      const route3D = new GraphicsLayer({ title: "Route 3D", elevationInfo: { mode: "absolute-height", offset: 0.6 } });
      const poiLayer3D = new GraphicsLayer({ title: "POIs 3D", elevationInfo: { mode: "absolute-height" } });
      map3d.addMany([poiLayer3D, route3D]);
      try { map3d.reorder(route3D, map3d.layers.length - 1); } catch (e) {}

      // ----- controls -----
      const fromSel = $("fromSel"), toInput = $("toInput"), dl = $("poiList");
      const disp = p => `${p.name} · ${floorLabel(p.floor)}`;
      const sorted = pois.pois.slice().sort((a, b) => a.name.localeCompare(b.name));
      fromSel.innerHTML = `<option value="__loc">📍 My location (Localize dot)</option>` + sorted.map(p => `<option value="${p.id}">${disp(p)}</option>`).join("");
      dl.innerHTML = sorted.map(p => `<option value="${disp(p)}">${p.category}${p.code && p.code !== p.name ? ' · ' + p.code : ''}</option>`).join("");
      const poiFromText = t => sorted.find(p => disp(p) === t) || sorted.find(p => p.name.toLowerCase() === t.toLowerCase()) || sorted.find(p => (p.name + ' ' + (p.code || '')).toLowerCase().includes(t.toLowerCase()));

      let lastRoute = null, startInfo = null;
      const ll = (x, y) => modelToLL(x, y);
      // Deep midnight navy (#182858 — NavMe's own brand navy, same tone used for the
      // destination pin / trail elsewhere) rather than the bright green.
      const COL = { route: [24, 40, 88], other: [24, 40, 88, 0.5], trans: [249, 171, 0] };
      // 3D route: back to one continuous tube (not the bead-trail), but noticeably
      // thinner than the original — a wide, low-opacity "glow" layer behind a slim
      // opaque core, so it still reads clearly through the translucent glass/mesh
      // without looking like a thick solid bar.
      function routeTubeSymbol(color) {
        const glow = Array.isArray(color) && color.length === 4 ? color.slice(0, 3) : color;
        const glowAlpha = Array.isArray(color) && color.length === 4 ? color[3] * 0.6 : 0.5;
        return {
          type: "line-3d", symbolLayers: [
            { type: "path", profile: "circle", width: 0.4, height: 0.4, material: { color: [...glow, glowAlpha] }, cap: "round", join: "round" },
            { type: "path", profile: "circle", width: 0.16, height: 0.16, material: { color }, cap: "round", join: "round" }
          ]
        };
      }

      function drawPOIs() {
        poiLayer.removeAll();
        poiLayer3D.removeAll();
        const floorOk = (p) => currentFloor === "all" || currentFloor === "none" || p.floor === currentFloor || ["parking", "outdoor"].includes(p.category);
        pois.pois.forEach(p => {
          if (!floorOk(p)) return;
          const flt = window.wf.poiFilter;
          const hit = flt && flt.has(p.category);
          if (flt && !hit && window.wf.poiFilterStrict) return;
          // 2D: hide room dots when vector indoor labels are on (satellite keeps markers)
          const hide2dRoom = !hit && !window.wf.showLabels && window.wf.style && window.wf.style !== "satellite" && p.room_id;
          const g2 = new Point({ longitude: p.lonlat[0], latitude: p.lonlat[1] });
          const cc = (window.wf.catColor && window.wf.catColor(p.category)) || [95, 99, 104];
          if (!hide2dRoom) {
            poiLayer.add(new Graphic({ geometry: g2, attributes: { poi: p.id }, symbol: { type: "simple-marker", size: hit ? 16 : 9, color: cc, outline: { color: [255, 255, 255], width: hit ? 2.5 : 1.5 } } }));
            if (window.wf.showLabels || hit) poiLayer.add(new Graphic({ geometry: g2, attributes: { poi: p.id }, symbol: { type: "text", text: p.name, color: hit ? cc.map(c => Math.round(c * 0.7)) : [60, 64, 67], haloColor: [255, 255, 255, 0.95], haloSize: 1.5, yoffset: hit ? -16 : -12, font: { size: hit ? 11 : 9.5, weight: hit ? "bold" : "normal", family: "Arial" } } }));
          }
          // 3D screen-space labels (icon + text stay readable; callout line to floor)
          const mz = (p.model && p.model.z != null) ? p.model.z : 0;
          const g3 = new Point({ longitude: p.lonlat[0], latitude: p.lonlat[1], z: modelZtoAbs(mz) + 0.3 });
          const layers3 = [
            { type: "icon", resource: { primitive: "circle" }, size: hit ? 14 : 11, material: { color: cc }, outline: { color: "white", size: 1.5 } }
          ];
          if (window.wf.showLabels || hit) {
            layers3.push({ type: "text", text: p.name, material: { color: "white" }, halo: { color: [0, 0, 0, 0.85], size: 1.2 }, size: hit ? 12 : 10, verticalAlignment: "bottom" });
          }
          poiLayer3D.add(new Graphic({
            geometry: g3,
            attributes: { poi: p.id },
            symbol: {
              type: "point-3d",
              symbolLayers: layers3,
              verticalOffset: (window.wf.showLabels || hit) ? { screenLength: 36, maxWorldLength: 80, minWorldLength: 1.5 } : { screenLength: 8, maxWorldLength: 20, minWorldLength: 0.5 },
              callout: (window.wf.showLabels || hit) ? { type: "line", size: 1.2, color: [255, 255, 255, 0.95], border: { color: [cc[0], cc[1], cc[2], 0.9] } } : null
            }
          }));
        });
      }

      // Navmesh debug overlay: colour every navigation polygon by floor height.
      // Blue = lowest elevation, red = highest. Use this to see where the navmesh
      // covers and identify gaps between floors (e.g. stairwells not connected).
      function drawNavmesh() {
        navmeshLayer.removeAll();
        if (!$("showNavmesh").checked) return;
        const polys = window.WFNavmeshRoute && window.WFNavmeshRoute.getNavMeshPolygons();
        if (!polys) { status("Navmesh not loaded yet — route to a destination first"); return; }
        if (!polys.length) { status("Navmesh has no polygons"); return; }
        // Find elevation range across all polygons.
        let minY = Infinity, maxY = -Infinity;
        polys.forEach(p => { if (p.avgY < minY) minY = p.avgY; if (p.avgY > maxY) maxY = p.avgY; });
        const yRange = maxY - minY || 1;
        // Colour ramp: blue (low/ground) → cyan → green → yellow → red (high/top floor).
        function heightColor(avgY) {
          const t = (avgY - minY) / yRange; // 0..1
          const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255);
          const g = Math.round(t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255);
          const b = Math.round(t < 0.25 ? 255 : t < 0.5 ? (0.5 - t) * 4 * 255 : 0);
          return [r, g, b];
        }
        polys.forEach(p => {
          // Navmesh verts are Matterport Y-up SDK space: x=east, y=elevation, z=south.
          // modelToLL expects model space (x=east, y=north=-z).
          const ring = p.ring.map(v => ll(v.x, -v.z));
          ring.push(ring[0]); // close the polygon ring
          const col = heightColor(p.avgY);
          navmeshLayer.add(new Graphic({
            geometry: new Polygon({ rings: [ring], spatialReference: { wkid: 4326 } }),
            symbol: { type: "simple-fill", color: [...col, 80], outline: { color: [...col, 180], width: 0.8 } }
          }));
        });
        const floors = [...new Set(polys.map(p => Math.round(p.avgY * 2) / 2))].sort((a, b) => a - b);
        status(`Navmesh: ${polys.length} polygons · elevation range ${minY.toFixed(1)} m – ${maxY.toFixed(1)} m · colour: blue=low, red=high`);
      }

      function drawGraph() {
        graphLayer.removeAll();
        if (!graphLayer.visible) return;
        const onF = n => currentFloor === "none" || n.floor === currentFloor;
        const line = (a, b, color, width, style) => new Graphic({ geometry: new Polyline({ paths: [[ll(a.x, a.y), ll(b.x, b.y)]], spatialReference: { wkid: 4326 } }), symbol: { type: "simple-line", color, width, style: style || "solid" } });
        // pruned raw Matterport neighbour edges (red dashed)
        const RN = {}; rawGraph.nodes.forEach(n => RN[n.id] = n);
        rawGraph.edges.forEach(e => { if (!e.pruned) return; const a = RN[e.u], b = RN[e.v]; if (onF(a) || onF(b)) graphLayer.add(line(a, b, [230, 40, 40, 0.55], 1, "short-dash")); });
        nav.edges.forEach(e => {
          const a = N[e.u], b = N[e.v]; if (!(onF(a) || onF(b))) return;
          const col = e.stairs ? [255, 140, 0] : (e.source === 'osm' || e.source === 'osm_link') ? [200, 200, 200] : e.source === 'door_hub' ? [80, 220, 120] : (e.step_free ? [0, 230, 255] : [255, 220, 0]);
          graphLayer.add(line(a, b, col, e.stairs ? 3 : 1.6));
        });
        Object.values(N).forEach(n => {
          if (!onF(n) && n.kind !== 'osm') return;
          const g = new Point({ longitude: n.lonlat[0], latitude: n.lonlat[1] });
          const sym = n.kind === 'door' ? { type: "simple-marker", style: "square", size: 8, color: n.exterior ? [0, 200, 0] : [120, 255, 120], outline: { color: "black", width: 1 } }
            : n.kind === 'osm' ? { type: "simple-marker", size: 4, color: [220, 220, 220] }
              : { type: "simple-marker", size: 9, color: n.floor === 'F1' ? [255, 120, 0] : [180, 80, 255], outline: { color: n.indoor ? "white" : "black", width: 1.5 } };
          graphLayer.add(new Graphic({ geometry: g, symbol: sym }));
          if (n.kind === 'sweep') graphLayer.add(new Graphic({ geometry: g, symbol: { type: "text", text: n.label, color: "white", haloColor: "black", haloSize: 1, yoffset: 8, font: { size: 8 } } }));
        });
        const st = nav.stats;
        status(`Graph: ${st.raw} raw MP edges → ${st.kept_initial} kept (+${st.door_hub_edges} door links, ${st.door_nodes} doors, ${st.stair_edges} stair edges, ${st.osm ? st.osm.edges : 0} OSM) · legend: cyan step-free, yellow step, orange stairs, green door links, grey OSM, red dashed pruned`);
      }

      function drawRoute() {
        routeLayer.removeAll(); route3D.removeAll();
        if (!lastRoute) return;
        const r = lastRoute;
        const cur = currentFloor === "none" ? null : currentFloor;
        r.legs.forEach(leg => {
          const path = leg.points.map(p => ll(p.x, p.y));
          const active = leg.outdoor || !cur || leg.floor === cur;
          if (leg.transition) {
            routeLayer.add(new Graphic({ geometry: new Polyline({ paths: [path], spatialReference: { wkid: 4326 } }), symbol: { type: "simple-line", color: COL.trans, width: 4, style: "short-dot" } }));
          } else if (active) {
            // Back to a solid line (not dotted) — thinner than the original 9px white
            // halo + 6px core, single 4px stroke in the high-intensity green.
            routeLayer.add(new Graphic({ geometry: new Polyline({ paths: [path], spatialReference: { wkid: 4326 } }), symbol: { type: "simple-line", color: COL.route, width: 4, cap: "round", join: "round" } }));
          } else {
            routeLayer.add(new Graphic({ geometry: new Polyline({ paths: [path], spatialReference: { wkid: 4326 } }), symbol: { type: "simple-line", color: COL.other, width: 3, style: "dash" } }));
          }
          // 3D tube floats above floor height — reduced back down to +0.20 m (was
          // +0.85 m) per request, just enough to clear the floor surface.
          const p3 = leg.points.map(p => { const q = ll(p.x, p.y); return [q[0], q[1], modelZtoAbs(p.z) + 0.20]; });
          route3D.add(new Graphic({ geometry: new Polyline({ paths: [p3], hasZ: true, spatialReference: { wkid: 4326 } }),
            symbol: routeTubeSymbol(leg.transition ? COL.trans : (active ? COL.route : [110, 120, 160])) }));
        });
        // floor-change markers
        r.legs.filter(l => l.transition).forEach(l => {
          const p = l.points[0], q = ll(p.x, p.y), g = new Point({ longitude: q[0], latitude: q[1] });
          const up = l.points[l.points.length - 1].z > p.z;
          const txt = `${l.points.length && r.links.some(k => k.stairs) ? 'Take stairs' : 'Go'} ${up ? 'up' : 'down'} to ${floorLabel(l.toFloor)}`;
          routeLayer.add(new Graphic({ geometry: g, symbol: { type: "simple-marker", style: "circle", size: 16, color: COL.trans, outline: { color: "white", width: 2 } } }));
          routeLayer.add(new Graphic({ geometry: g, symbol: { type: "text", text: (up ? "▲ " : "▼ ") + txt, color: "white", haloColor: [120, 60, 0], haloSize: 2, yoffset: 16, font: { size: 11, weight: "bold" } } }));
        });
        // stairs on same MP floor (e.g. porch steps) also marked
        r.links.forEach((k, i) => {
          if (!k.stairs) return; const a = r.nodes[i], b = r.nodes[i + 1]; if (a.floor !== b.floor) return;
          const q = ll((a.x + b.x) / 2, (a.y + b.y) / 2);
          routeLayer.add(new Graphic({ geometry: new Point({ longitude: q[0], latitude: q[1] }), symbol: { type: "text", text: (b.z > a.z ? "▲ steps up" : "▼ steps down"), color: "white", haloColor: [120, 60, 0], haloSize: 2, font: { size: 10, weight: "bold" } } }));
        });
        const s0 = r.smoothed[0], s1 = r.smoothed[r.smoothed.length - 1];
        const mk = (p, color, label) => { const q = ll(p.x, p.y), g = new Point({ longitude: q[0], latitude: q[1] });
          routeLayer.add(new Graphic({ geometry: g, symbol: { type: "simple-marker", size: 14, color, outline: { color: "white", width: 2.5 } } }));
          if (label) routeLayer.add(new Graphic({ geometry: g, symbol: { type: "text", text: label, color: "white", haloColor: [0, 0, 0, 0.85], haloSize: 2, yoffset: -18, font: { size: 11, weight: "bold" } } }));
          route3D.add(new Graphic({ geometry: new Point({ longitude: q[0], latitude: q[1], z: modelZtoAbs(p.z) + 0.4 }), symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "sphere" }, width: 1.0, material: { color } }] } }));
        };
        if (startInfo && startInfo.fromDot) {
          const a = ll(startInfo.x, startInfo.y), b = ll(s0.x, s0.y);
          routeLayer.add(new Graphic({ geometry: new Polyline({ paths: [[a, b]], spatialReference: { wkid: 4326 } }), symbol: { type: "simple-line", color: COL.route, width: 3, style: "dot" } }));
        } else mk(s0, [30, 180, 60], null);
        mk(s1, [220, 40, 40], r.toName);
      }

      function renderSteps(r) {
        const min = Math.max(1, Math.round(r.time_s / 60));
        $("routeSummary").innerHTML = `${Math.round(r.total_m)} m · ~${min} min walk` + (r.stairs_rise_m > 0 ? ` · stairs ${r.stairs_rise_m.toFixed(1)} m` : ' · step-free') +
          (r.warn ? `<br><span class="warn">${r.warn}</span>` : '');
        $("steps").innerHTML = r.instructions.map(i =>
          `<li class="${i.type || ""}"><span class="si">${i.arrow || "\u2191"}</span><span>${i.text}</span></li>`).join("");
      }

      function doRoute(fromKey, toPoiId, opts = {}) {
        const to = poiById[toPoiId]; if (!to) { $("routeSummary").textContent = "Pick a destination"; return null; }
        let fromNode, fromName, warn = null; startInfo = null;
        if (fromKey === "__loc") {
          if (!lastLoc) { $("routeSummary").innerHTML = '<span class="warn">Set your location first (Localize), or pick a “From” place.</span>'; if (window.wf.onRoute) window.wf.onRoute(null, "Set your location first (tap the location button, then tap the map), or choose a starting place."); return null; }
          const s = WFRouting.snap(lastLoc.x, lastLoc.y, lastLoc.floor);
          fromNode = s.node.id; fromName = "My location"; startInfo = { fromDot: true, x: lastLoc.x, y: lastLoc.y };
          if (s.dist > 20) warn = `Your dot is ${Math.round(s.dist)} m from the nearest mapped point.`;
        } else { const p = poiById[fromKey]; fromNode = p.nearest_node || null; fromName = p.name; }
        // Prefer the pure navmesh route (same engine as the admin route tester and AR):
        // Recast findClosestPoint + computePath, no sweep graph / door logic involved.
        let r = null;
        const fromPoi = (fromKey === "__loc") ? null : poiById[fromKey];
        if (window.WFNav && WFNav.navmeshReady() && fromPoi && fromPoi.sdk && to.sdk) {
          const nr = WFNav.routeNavmesh(fromPoi.sdk, to.sdk);
          if (nr && !nr.error) r = nr;
        }
        // Graph fallback only when both ends actually have graph nodes.
        if (!r && fromNode && to.nearest_node) r = WFRouting.route(fromNode, to.nearest_node, { stepFree: !!opts.stepFree });
        if (!r) {
          lastRoute = null; drawRoute();
          $("routeSummary").innerHTML = `<span class="warn">No ${opts.stepFree ? 'step-free ' : ''}route found from ${fromName} to ${to.name}.</span>`; $("steps").innerHTML = "";
          if (window.wf.onRoute) window.wf.onRoute(null, `No ${opts.stepFree ? 'step-free ' : ''}route found from ${fromName} to ${to.name}.`); return null;
        }
        r.fromName = fromName; r.toName = to.name; r.toPoi = to.id; r.warn = warn;
        if (!r.instructions) r.instructions = (r.steps || []).map(s2 => ({
          text: s2.text, floor: s2.floor, dist_m: s2.dist_m,
          // keep the direction data so the list can draw the right arrow
          type: s2.type, arrow: s2.arrow, dir: s2.dir, turn_deg: s2.turn_deg, sweep: s2.sweep,
          // Aliases the step-by-step navigator (navGo) expects: it reads pt/icon/dist.
          // pt must be MODEL space because navGo calls modelToLL(pt.x, pt.y); our step
          // points are SDK, and model = (x, -z, y). Without pt there is nothing to pan to.
          pt: s2.point ? { x: s2.point.x, y: -s2.point.z, z: s2.point.y, floor: s2.floor } : null,
          icon: s2.arrow, dist: s2.dist_m || 0 }));
        if (r.instructions.length) {
          r.instructions[0].text = `Start at ${fromName}`;
          r.instructions[r.instructions.length - 1].text = `Arrive at ${to.name} (${floorLabel(to.floor)})`;
        }
        lastRoute = r; window.wf.lastRoute = r;
        drawRoute(); renderSteps(r);
        if (window.wf.onRoute) window.wf.onRoute(r);
        if (activeView === view2d && !opts.noZoom) {
          const pts = r.smoothed.map(p => ll(p.x, p.y));
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          view2d.goTo({ target: new Extent({ xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys), spatialReference: { wkid: 4326 } }).expand(1.6) }, { duration: 800 });
        }
        return r;
      }

      $("btnRoute").onclick = () => { const p = poiFromText(toInput.value || ""); if (p) doRoute(fromSel.value, p.id, { stepFree: $("stepFree").checked }); else $("routeSummary").textContent = "Pick a destination from the list"; };
      $("btnClear").onclick = () => { lastRoute = null; drawRoute(); $("routeSummary").textContent = ""; $("steps").innerHTML = ""; };
      $("showGraph").onchange = () => { graphLayer.visible = $("showGraph").checked; drawGraph(); };
      $("showNavmesh").onchange = () => { navmeshLayer.visible = $("showNavmesh").checked; drawNavmesh(); };
      $("btnExport").onclick = () => {
        if (!lastRoute) return;
        const out = { schema: "wayfinding.route/v1", from: lastRoute.fromName, to: lastRoute.toName, step_free: lastRoute.stepFree, distance_m: +lastRoute.total_m.toFixed(1), time_s: Math.round(lastRoute.time_s),
          matterport: { model_id: CFG.matterport_model_id, sweep_ids: lastRoute.sweep_ids, note: "Replay in Showcase: for each id await mpSdk.Sweep.moveTo(id,{transition: mpSdk.Sweep.Transition.FLY}); draw path through xyz with SDK scene objects" },
          nodes: lastRoute.nodes, smoothed: lastRoute.smoothed, instructions: lastRoute.instructions.map(i => i.text) };
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" })); a.download = "route.json"; a.click();
      };
      window.wf.onFloor = () => { drawRoute(); drawGraph(); drawPOIs(); };
      window.wf.route = (fromKey, toPoiId, opts) => doRoute(fromKey, toPoiId, opts || {});
      window.wf.showGraph = (on) => { $("showGraph").checked = on; graphLayer.visible = on; drawGraph(); };
      window.wf.pois = pois.pois;
      window.wf.categories = (R2 && R2.navmeCategories) || [];
      window.wf.redrawPOIs = drawPOIs;
      if (window.wf.showLabels == null) {
        try { window.wf.showLabels = localStorage.getItem("wf_showLabels") === "1"; }
        catch (e) { window.wf.showLabels = false; }
      }
      window.wf.setShowLabels = (on) => {
        window.wf.showLabels = !!on;
        try { localStorage.setItem("wf_showLabels", on ? "1" : "0"); } catch (e) {}
        drawPOIs();
        try {
          (window.wf._indoorPolys || []).forEach(lyr => { if (lyr && "labelsVisible" in lyr) lyr.labelsVisible = !!on && !window.wf.is3D(); });
        } catch (e) {}
        if (typeof window.wf.onShowLabels === "function") try { window.wf.onShowLabels(!!on); } catch (e) {}
      };
      window.wf.clearRoute = () => { lastRoute = null; window.wf.lastRoute = null; drawRoute(); };
      window.wf.nav = nav; window.wf.floorLabel = floorLabel;
      drawPOIs();
    }
    initRouting();

    // =====================================================================
    // Basemap styles (Satellite | Map | Light | Dark) + vector indoor "blocks" per floor
    // Free, no key: OpenFreeMap vector styles (OpenMapTiles schema, OSM data) -> ArcGIS VectorTileLayer;
    // fallback CARTO raster. Indoor plans: data/indoor_F*.geojson (IMDF-like) via GeoJSONLayer.
    // =====================================================================
    function initStyles() {
      const OFM = { map: "liberty", light: "positron", dark: "dark" };
      const CARTO = { map: "rastertiles/voyager", light: "light_all", dark: "dark_all" };
      const OFM_COPY = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
      let tilejson = null; const styleCache = {};
      async function vtStyle(name) {
        if (styleCache[name]) return styleCache[name];
        if (!tilejson) tilejson = await fetch("https://tiles.openfreemap.org/planet").then(r => r.json());
        const st = await fetch("https://tiles.openfreemap.org/styles/" + name).then(r => r.json());
        for (const k of Object.keys(st.sources)) {
          if (st.sources[k].type !== "vector") delete st.sources[k];
          else st.sources[k] = { type: "vector", tiles: tilejson.tiles, minzoom: 0, maxzoom: tilejson.maxzoom || 14, attribution: "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" };
        }
        // ArcGIS VectorTileLayer: drop raster / 3D layers, fix one expression form it rejects
        st.layers = st.layers.filter(l => (l.type === "background" || st.sources[l.source]) && l.type !== "fill-extrusion");
        const fix = (o) => Array.isArray(o) ? (o[0] === "linear" && o.length > 1 ? ["linear"] : o.map(fix)) : (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fix(v)])) : o);
        st.layers = st.layers.map(fix);
        return (styleCache[name] = st);
      }
      const satellite2d = map2d.basemap, satellite3d = map3d.basemap;
      async function makeBasemap(kind) {
        try {
          const st = await vtStyle(OFM[kind]);
          const lyr = new VectorTileLayer({ style: JSON.parse(JSON.stringify(st)), copyright: OFM_COPY });
          await lyr.load();
          return { bm: new Basemap({ baseLayers: [lyr], title: "OpenFreeMap " + OFM[kind] }), label: `OpenFreeMap “${OFM[kind]}” vector tiles (OSM data, no key)` };
        } catch (e) {
          console.warn("OpenFreeMap failed, CARTO raster fallback", e);
          const lyr = new WebTileLayer({ urlTemplate: `https://{subDomain}.basemaps.cartocdn.com/${CARTO[kind]}/{level}/{col}/{row}.png`, subDomains: ["a", "b", "c", "d"],
            copyright: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>' });
          return { bm: new Basemap({ baseLayers: [lyr], title: "CARTO " + kind }), label: `CARTO ${kind} raster (fallback)` };
        }
      }
      // ---------- indoor symbology ----------
      const PAL = {
        light: { building: [236, 236, 236], buildingLine: [170, 170, 170], walkway: [255, 255, 255], hall: [255, 243, 210], room: [226, 238, 255], corridor: [255, 255, 255],
                 utility: [235, 235, 235], stairs: [228, 216, 246], wall: [95, 99, 104], window: [120, 180, 240], door: [255, 255, 255], entrance: [30, 150, 70], text: [60, 64, 67], halo: [255, 255, 255] },
        dark: { building: [48, 52, 56], buildingLine: [110, 110, 110], walkway: [70, 74, 80], hall: [92, 84, 60], room: [58, 72, 96], corridor: [70, 74, 80],
                utility: [60, 60, 60], stairs: [84, 70, 110], wall: [215, 215, 215], window: [90, 150, 220], door: [70, 74, 80], entrance: [60, 200, 110], text: [230, 230, 230], halo: [30, 30, 30] }
      };
      const EXTR = { building: 0.12, walkway: 0.18, corridor: 0.18, hall: 0.3, room: 0.3, utility: 0.3, stairs: 0.9 };
      // "Solid buildings" mode: extrude to real wall height instead of the paper-thin
      // floor tint above, so the building actually reads as a volume from a city-scale
      // camera — matching the opaque look of a Mappedin-style floor plan.
      const EXTR_SOLID = { building: 2.6, walkway: 2.4, corridor: 2.4, hall: 2.4, room: 2.4, utility: 2.4, stairs: 2.7 };
      const ORDER = ["building", "walkway", "corridor", "utility", "hall", "room", "stairs"];
      function polyRenderer(pal, is3D, solid) {
        const extr = solid ? EXTR_SOLID : EXTR;
        return { type: "unique-value", field: "style", orderByClassesEnabled: true,
          uniqueValueInfos: (is3D ? ORDER : ORDER.slice().reverse()).map(k => ({ value: k, symbol: is3D
            ? { type: "polygon-3d", symbolLayers: [{ type: "extrude", size: extr[k], material: { color: pal[k].concat(solid ? [1] : (k === "building" ? [0.9] : [1])) }, edges: { type: "solid", color: [120, 120, 120, 0.6], size: 0.5 } }] }
            : { type: "simple-fill", color: pal[k], outline: k === "building" ? { color: pal.buildingLine, width: 1.2 } : { color: pal[k].map(c => Math.max(0, c - 25)), width: 0.5 } } })) };
      }
      function lineRenderer(pal, is3D) {
        const H = { wall: 2.4, window: 2.4, door: 0.05, entrance: 0.05 }, W = { wall: 2.2, window: 2.6, door: 3, entrance: 4 };
        return { type: "unique-value", field: "style",
          uniqueValueInfos: ["wall", "window", "door", "entrance"].map(k => ({ value: k, symbol: is3D
            ? { type: "line-3d", symbolLayers: [{ type: "path", profile: "quad", anchor: "bottom", width: k === "wall" ? 0.14 : 0.1, height: H[k], material: { color: k === "window" ? pal.window.concat([0.45]) : (k === "wall" ? [200, 200, 205] : pal[k]) } }] }
            : { type: "simple-line", color: pal[k], width: W[k], cap: "butt" } })) };
      }
      function labelInfo(pal) {
        return [{ labelExpressionInfo: { expression: "$feature.name" }, where: "name IS NOT NULL AND style <> 'building'", minScale: 2500,
          symbol: { type: "text", color: pal.text, haloColor: pal.halo, haloSize: 1.5, font: { size: 10, weight: "bold", family: "Arial" } } }];
      }
      const indoorData = {};
      const blobUrl = (fc, pred) => URL.createObjectURL(new Blob([JSON.stringify({ type: "FeatureCollection", features: fc.features.filter(pred) })], { type: "application/json" }));
      const indoor2d = {}, indoor3d = {};
      async function loadIndoor() {
        for (const F of FIDS) indoorData[F] = await fetch(D(CFG.files.indoor[F])).then(r => r.json());
      }
      function buildIndoor(F, is3D, pal) {
        const fc = indoorData[F];
        const elev = is3D ? { mode: "absolute-height", featureExpressionInfo: { expression: "$feature.floor_z" }, offset: ground0 - GRADE_Z, unit: "meters" } : undefined;
        // Glass structure: units render translucent and walls are kept faint, so the
        // route stays readable through the building instead of being hidden behind it.
        // Only opacity changes — geometry, renderer and labels are untouched.
        // "Solid buildings" mode (3D only) trades that see-through route for a fully
        // opaque floor plan — same geometry/palette, easier to read the building shape.
        const GLASS_UNITS = !is3D ? 0.45 : (solidBuildings ? 1 : 0.28), GLASS_WALLS = !is3D ? 0.6 : (solidBuildings ? 1 : 0.35);
        const polys = new GeoJSONLayer({ url: blobUrl(fc, f => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"), title: `Indoor ${F} units`, renderer: polyRenderer(pal, is3D, is3D && solidBuildings),
          labelingInfo: is3D ? [] : labelInfo(pal), labelsVisible: !is3D && !!window.wf.showLabels, visible: false, elevationInfo: elev, outFields: ["*"], opacity: GLASS_UNITS });
        const lines = new GeoJSONLayer({ url: blobUrl(fc, f => f.geometry.type === "LineString"), title: `Indoor ${F} walls/doors`, renderer: lineRenderer(pal, is3D), visible: false, elevationInfo: elev, outFields: ["*"], opacity: GLASS_WALLS });
        return { polys, lines, pal };
      }
      let style = "satellite", photo = false, pal = PAL.light;
      // Manual 3D layer visibility overrides — independent of style/floor/photo so a
      // user's choice (e.g. "hide mesh") survives switching styles or floors.
      let hideShell = false, hideOsmBlocks = false, hideMpMesh = false, solidBuildings = false;
      const bmCache2d = {}, bmCache3d = {};
      let osm3d = null, shell3d = null;
      const SHELL_Z0 = Math.min(...CFG.floors.map(f => f.elevation)) - 0.15;
      const SHELL_H = Math.max(...CFG.floors.map(f => f.elevation + f.height)) + 0.8 - SHELL_Z0;
      function build3DContext() {
        if (osm3d) return;
        osm3d = new GeoJSONLayer({ url: D(CFG.files.buildings_osm), title: "OSM buildings (extruded)", definitionExpression: "is_site = 0", visible: false,
          copyright: "© OpenStreetMap contributors",
          renderer: { type: "simple", symbol: { type: "polygon-3d", symbolLayers: [{ type: "extrude", material: { color: [232, 232, 236] }, edges: { type: "solid", color: [150, 150, 160, 0.7], size: 0.6 } }] },
            visualVariables: [{ type: "size", field: "height_m", valueUnit: "meters" }] } });
        shell3d = new GeoJSONLayer({ url: D(CFG.files.site_shell), title: "Building shell", visible: false,
          elevationInfo: { mode: "absolute-height", offset: modelZtoAbs(SHELL_Z0) },
          renderer: { type: "simple", symbol: { type: "polygon-3d", symbolLayers: [{ type: "extrude", size: SHELL_H, material: { color: [255, 255, 255, 0.12] }, edges: { type: "solid", color: [110, 110, 120, 0.8], size: 0.8 } }] } } });
        map3d.addMany([osm3d, shell3d]);
      }
      function palFor(s) { return s === "dark" ? PAL.dark : PAL.light; }
      function ensureIndoor(is3D) {
        const store = is3D ? indoor3d : indoor2d, map = is3D ? map3d : map2d;
        for (const F of FIDS) {
          if (store[F] && store[F].pal === pal) continue;
          if (store[F]) { map.removeMany([store[F].polys, store[F].lines]); }
          store[F] = buildIndoor(F, is3D, pal);
          if (is3D) map.addMany([store[F].polys, store[F].lines]);
          else map.addMany([store[F].polys, store[F].lines], map.layers.indexOf(floorLayers[FIDS[FIDS.length - 1]]) + 1);
        }
      }
      function applyVisibility() {
        const fid = currentFloor, blocks = style !== "satellite";
        Object.entries(floorLayers).forEach(([k, l]) => {
          const show = fid === "all" ? true : (fid !== "none" && k === fid);
          l.visible = show && (!blocks || photo);
        });
        meshLayer.visible = !hideMpMesh;
        for (const F of FIDS) {
          const on = blocks && (fid === "all" || fid === F);
          if (indoor2d[F]) { indoor2d[F].polys.visible = on && !photo; indoor2d[F].lines.visible = on; }
          if (indoor3d[F]) { indoor3d[F].polys.visible = on && !photo; indoor3d[F].lines.visible = on && !photo; }
        }
        if (osm3d) { osm3d.visible = blocks && !hideOsmBlocks; shell3d.visible = blocks && !photo && !hideShell; }
        document.querySelectorAll("button.bstyle").forEach(b => b.classList.toggle("active", b.dataset.style === style));
        $("photoRow").style.display = blocks ? "" : "none";
      }
      async function setStyle(s) {
        style = s; pal = palFor(s); await indoorP;
        let label = "Esri World Imagery (no API key)";
        if (s === "satellite") { map2d.basemap = satellite2d; map3d.basemap = satellite3d; }
        else {
          if (!bmCache2d[s]) bmCache2d[s] = await makeBasemap(s);
          map2d.basemap = bmCache2d[s].bm; label = bmCache2d[s].label;
          if (!bmCache3d[s]) bmCache3d[s] = await makeBasemap(s);
          map3d.basemap = bmCache3d[s].bm;
          ensureIndoor(false); if (view3d) { build3DContext(); ensureIndoor(true); }
        }
        document.body.classList.toggle("dark", s === "dark");
        window.wf.styleLabel = label; window.wf.style = s;
        applyVisibility(); if (window.wf.onFloor) window.wf.onFloor(currentFloor);
        status((activeView === view2d ? "2D · " : "3D · ") + label + (s !== "satellite" ? " · indoor: Matterport rooms/walls (vector)" : ""));
      }
      window.wf.onStyleFloor = () => applyVisibility();
      window.wf.on3DReady = () => { if (style !== "satellite") { build3DContext(); ensureIndoor(true); applyVisibility(); } };
      window.wf.setStyle = setStyle;
      // 3D layer visibility toggles (wired to the Map layers popover's checkboxes).
      window.wf.setHideShell = (on) => { hideShell = !!on; applyVisibility(); };
      window.wf.setHideOsmBlocks = (on) => { hideOsmBlocks = !!on; applyVisibility(); };
      window.wf.setHideMesh = (on) => { hideMpMesh = !!on; applyVisibility(); };
      window.wf.setSolidBuildings = (on) => {
        solidBuildings = !!on;
        const units = solidBuildings ? 1 : 0.28, walls = solidBuildings ? 1 : 0.35;
        for (const F of FIDS) {
          if (!indoor3d[F]) continue;
          indoor3d[F].polys.opacity = units; indoor3d[F].lines.opacity = walls;
          indoor3d[F].polys.renderer = polyRenderer(indoor3d[F].pal, true, solidBuildings);
        }
      };
      document.querySelectorAll("button.bstyle").forEach(b => b.onclick = () => setStyle(b.dataset.style));
      $("photoPlan").onchange = () => { photo = $("photoPlan").checked; applyVisibility(); };
      const indoorP = loadIndoor().then(() => { window.wf.indoorReady = true; });
    }
    initStyles();
    window.wf.setFloor = setFloor;
    window.wf.view = () => activeView;
    window.wf.cam = (o) => activeView.goTo(o, { animate: false });
    window.wf.fit3D = (o) => fit3DCamera(o || { animate: true });
    window.wf.esri = { Graphic, Point, Polyline, GraphicsLayer, Extent };
    window.wf.map2d = map2d; window.wf.map3d = map3d; window.wf.view2d = view2d;
    window.wf.getView3d = () => view3d;
    window.wf.modelZtoAbs = (z) => modelZtoAbs(z);
    window.wf.currentFloor = () => currentFloor;
    window.wf.is3D = () => activeView !== view2d;
    window.wf.floorsMeta = floorsMeta;
    window.wf.startLocalize = (on) => { localizing = on === undefined ? !localizing : on; $("btnLocalize").classList.toggle("on", localizing); return localizing; };
    window.wf.isLocalizing = () => localizing;
    window.wf.dotLayer = dotLayer;
    window.wf.ready = true;
    if (window.wf.onReady) window.wf.onReady();
    // Default to 3D view
    setTimeout(() => { if ($("btnDim")) $("btnDim").click(); }, 800);
    window.wf.modelToScreen = (x, y) => { const ll = modelToLL(x, y); const p = activeView.toScreen(new Point({ longitude: ll[0], latitude: ll[1] })); return [p.x, p.y]; };
  }
});
