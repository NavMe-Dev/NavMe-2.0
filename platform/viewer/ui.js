/* Google-Maps-like UI shell on top of app.js (window.wf API). Plain script, no build.
   Fuse.js (Apache-2.0) fuzzy search · Material Symbols (Apache-2.0) icons. */
function wfDbg(level, source, message, meta) {
  try { if (window.WFDebug && WFDebug.isEnabled()) WFDebug.log(level, source, message, meta); } catch (_) {}
}

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const t = (key, vars) => (window.WFi18n && WFi18n.t) ? WFi18n.t(key, vars) : key;
  // Resolves a navme_pois.poi_names / navme_categories.category_names jsonb blob (one key
  // per language, e.g. {en:"...", hi:"...", kn:"..."}) to the current UI language, falling
  // back to English, then to whatever plain-string name was passed in (the POI/category's
  // original un-translated name) if there's no data for this id at all.
  const localized = (names, fallback) => {
    if (!names) return fallback;
    const loc = (window.WFi18n && WFi18n.getLocale) ? WFi18n.getLocale() : "en";
    return names[loc] || names.en || fallback;
  };
  const CAT_BASE = {
    room: { icon: "meeting_room", color: [26, 115, 232], labelKey: "viewer.catRoom" },
    hall: { icon: "groups", color: [161, 66, 244], labelKey: "viewer.catHall" },
    corridor: { icon: "signpost", color: [95, 99, 104], labelKey: "viewer.catCorridor" },
    entrance: { icon: "door_open", color: [24, 128, 56], labelKey: "viewer.catEntrance" },
    stairs: { icon: "stairs", color: [227, 116, 0], labelKey: "viewer.catStairs" },
    elevator: { icon: "elevator", color: [66, 133, 244], labelKey: "viewer.catElevator" },
    parking: { icon: "local_parking", color: [25, 103, 210], labelKey: "viewer.catParking" },
    outdoor: { icon: "park", color: [52, 168, 83], labelKey: "viewer.catOutdoor" },
    restroom: { icon: "wc", color: [0, 137, 123], labelKey: "viewer.catRestroom" }
  };
  const CAT = new Proxy(CAT_BASE, { get(tg, prop) {
    if (typeof prop !== "string") return undefined;
    const b = tg[prop];
    if (!b) {
      const fb = tg.room;
      return fb ? { icon: fb.icon, color: fb.color, label: fb.names ? localized(fb.names, t(fb.labelKey)) : t(fb.labelKey) } : undefined;
    }
    return { icon: b.icon, color: b.color, label: b.names ? localized(b.names, t(b.labelKey)) : t(b.labelKey) };
  }});
  const CHIP_KEYS = [["room", "viewer.rooms"], ["hall", "viewer.halls"], ["entrance", "viewer.entrances"], ["stairs", "viewer.stairs"], ["elevator", "viewer.elevators"], ["restroom", "viewer.restrooms"], ["parking", "viewer.parking"]];
  let catNamesByKey = {};
  const CHIPS = () => CHIP_KEYS.map(([c, k]) => [c, catNamesByKey[c] ? localized(catNamesByKey[c], k) : t(k)]);
  // Category chips come from the NavMe Dashboard's own navme_categories (name + Lucide
  // icon_key) when the building has any, instead of the viewer's fixed built-in set —
  // see wf.categories (app.js) / navme-gmap/sync (admin.py). Applies in every mode, not
  // just ?mp=1 — a building's categories shouldn't change depending on the URL.
  // t(labelKey) already falls back to returning the key string unchanged when it's not a
  // real i18n key, so a plain category name works as a "labelKey" with zero other changes.
  const LUCIDE_TO_MS = {
    "map-pin": "place", "door-open": "door_open", users: "groups", "building2": "apartment",
    toilet: "wc", bath: "bathtub", "shower-head": "shower", "move-vertical": "elevator",
    "arrow-up-down": "elevator", footprints: "stairs", "circle-parking": "local_parking",
    "square-parking": "local_parking", car: "directions_car", utensils: "restaurant",
    "utensils-crossed": "restaurant", coffee: "local_cafe", sofa: "weekend", store: "storefront",
    info: "info", key: "key", "key-round": "key", search: "search", image: "image",
    video: "videocam", accessibility: "accessible", refrigerator: "kitchen", school2: "school",
    "graduation-cap": "school", landmark: "museum", sparkles: "auto_awesome",
    "book-open": "menu_book", computer: "computer", home: "home", warehouse: "warehouse", volleyball: "sports_volleyball"
  };
  const CHIP_PALETTE = [[26, 115, 232], [161, 66, 244], [24, 128, 56], [227, 116, 0], [66, 133, 244], [0, 137, 123], [25, 103, 210], [194, 24, 91]];
  function applyDynamicCategories() {
    let categories = wf.categories || [];
    // Older published buildings can have synced POIs but no saved category list.
    // Recover their actual categories instead of displaying unrelated defaults.
    if (!categories.length) {
      const defaults = new Set(CHIP_KEYS.map(([key]) => key));
      const names = [...new Set(POIS.map(p => String(p.category || "").trim().toLowerCase()).filter(Boolean))];
      if (!names.some(name => name !== "general" && !defaults.has(name))) return;
      categories = names.filter(name => name !== "general").map(name => ({
        name: name.replace(/\b\w/g, letter => letter.toUpperCase()).replace(/\b(Bhm|Pg|Ug)\b/g, word => word.toUpperCase()),
        icon_key: /block/.test(name) ? "building2" : /basketball/.test(name) ? "volleyball" : /library/.test(name) ? "book-open" : /cafeteria/.test(name) ? "coffee" : "map-pin"
      }));
    }
    const sorted = categories.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)));
    Object.keys(CAT_BASE).forEach(k => delete CAT_BASE[k]);
    CHIP_KEYS.length = 0;
    catNamesByKey = {};
    sorted.forEach((c, i) => {
      const key = String(c.name || "").trim().toLowerCase();
      if (!key) return;
      CAT_BASE[key] = { icon: LUCIDE_TO_MS[c.icon_key] || "place", color: CHIP_PALETTE[i % CHIP_PALETTE.length], labelKey: c.name, names: c.names || null };
      catNamesByKey[key] = c.names || null;
      CHIP_KEYS.push([key, c.name]);
    });
    // CAT's Proxy fallback (unmatched POI category) always reads CAT_BASE.room — keep a
    // generic entry there so a POI whose category string doesn't match any dashboard
    // category name still renders instead of breaking on an undefined icon/color/label.
    if (!CAT_BASE.room) CAT_BASE.room = { icon: "place", color: [95, 99, 104], labelKey: "viewer.catRoom" };
  }
  const rgb = (c) => `rgb(${c.join(",")})`;
  const cat = (p) => CAT[p.category] || CAT.room;
  const isDesk = () => window.matchMedia("(min-width:768px)").matches;
  let wf, POIS = [], byId = {}, fuse, thumbs = new Set();
  function buildSearchIndex() {
    fuse = new Fuse(POIS, { keys: [{ name: "name", weight: 0.6 }, { name: "code", weight: 0.2 }, { name: "category", weight: 0.1 }, { name: "tagsText", weight: 0.1 }], threshold: 0.4, ignoreLocation: true, includeMatches: false });
  }
  const S = { mode: "home",
    uxMode: "buildings", dirFocus: "to", place: null, from: null, to: null, stepFree: false, route: null, navSteps: [], navI: 0, filter: null, categoryFloor: "__all__", categoryPoiIds: null, previewing: false, locMeta: null };

  // Matterport public viewer (?mp=1, see mp_background.js): same search/directions/
  // turn-by-turn UI, but POI selection and turn-by-turn clicks drive the live
  // Matterport Showcase camera (MpPreview.focusAt) instead of only the ArcGIS one.
  const pageQuery = () => window.WFQuery ? WFQuery() : new URLSearchParams(location.search);
  function isMpMode() { return pageQuery().get("mp") === "1"; }
  function mpFocusSelection(which) {
    if (!isMpMode() || !window.MpPreview) return;
    const p = S[which];
    if (!p || p === "me" || p.x == null) return;
    if (which === "to") {
      const face = (p.expected_x != null) ? { x: p.expected_x, y: p.expected_y, z: p.expected_z } : { x: p.x, y: p.y, z: p.z };
      window.MpPreview.focusAt({ x: p.x, y: p.y, z: p.z }, face);
    } else {
      window.MpPreview.focusAt({ x: p.x, y: p.y, z: p.z }, null);
    }
  }

  // ---------------- boot ----------------
  const boot = setInterval(() => { if (window.wf && window.wf.ready && window.wf.pois && window.wf.setStyle && window.wf.indoorReady) { clearInterval(boot); try { init(); } catch (e) { if (window.WFStartup) window.WFStartup.fail(); else throw e; } } }, 100);

  function init() {
    wf = window.wf;
    POIS = wf.pois.slice(); POIS.forEach(p => byId[p.id] = p);
    wf.onPoiPick = (poiId) => {
      const p = byId[poiId];
      if (!p) return;
      if (S.mode === "dir" || S.mode === "nav") {
        if (S.mode === "nav") return; // don't change route mid-nav
        applyPoiToDir(p);
      } else {
        selectPlace(p, { fly: true });
      }
    };
    wf.catColor = (c) => (CAT[c] || CAT.room).color;
    buildSearchIndex();
    POIS.forEach(p => p.tagsText = [cat(p).label, wf.floorLabel(p.floor), p.note || ""].join(" "));
    loadCampus();
    if (window.WFi18n) WFi18n.onChange(() => refreshI18nChrome());
    fetch(WF.D(WF.cfg.files.thumbs)).then(r => r.json()).then(a => {
      thumbs = new Set(a);
      // Add associated scan images without resetting the selected tab or sheet height.
      if (S.mode === "home" && $("venueTabPanel")) renderVenueTab();
      if (S.mode === "place" && S.place) selectPlace(S.place, { fly: false, sheet: $("sheet").dataset.state || "half" });
      if (S.route && (S.mode === "dir" || S.mode === "nav")) renderDirections(S.route);
      hydrateMatterportPoiPhotos();
    }).catch(() => { });
    // map chrome: hide ArcGIS default widgets except attribution
    wf.view2d.ui.components = ["attribution"];
    wf.on3DCreated = (v) => { v.ui.components = ["attribution"]; };
    const uiLayer = new wf.esri.GraphicsLayer({ title: "UI markers" }); wf.map2d.add(uiLayer); S.uiLayer = uiLayer;
    applyDynamicCategories();
    buildChips(); bindSearch(); bindDirections(); bindControls(); bindSheet(); bindDrawer(); bindNav();
    wf.onRoute = onRoute;
    wf.onLocalized = onLocalized;
    wf.onFloorUI = updateFloorPicker;
    wf.view2d.watch("zoom", updateFloorPicker);
    wf.view2d.watch("extent", placeMe);
    ["resize", "orientationchange"].forEach(e => window.addEventListener(e, () => { applyPadding(); placeMe(); }));
    window.addEventListener("wf-weather-updated", () => { applyPadding(); placeMe(); });
    window.addEventListener("wf-venue-info", () => {
      const info = window.WFVenueInfo && WFVenueInfo.get();
      if (info && info.building_slug && info.name) buildingVenueNames.set(info.building_slug, info.name);
      if (S.mode === "home" && $("venueTabPanel")) renderVenueTab();
    });
    window.addEventListener("wf-pois-updated", () => {
      POIS = wf.pois.slice(); byId = {}; POIS.forEach(p => byId[p.id] = p); buildSearchIndex();
      if (S.mode === "home" && $("venueTabPanel")) { ensureExplore(); renderVenueTab(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("q").focus(); }
      if (e.key === "Escape") { closeAc(); closePop(); closeDrawer(); closeShareSheet(); }
    });
    // prefs
    if (localStorage.getItem("wf_large") === "1") { $("togLarge").checked = true; document.body.classList.add("large"); }
    // Light/dark theme (decoupled from the 2D map's own style swatches): explicit user
    // choice always wins; absent one, light is the default everywhere (see
    // mp_background.js for the mp=1 default).
    const savedTheme = localStorage.getItem("wf_theme");
    if (savedTheme) {
      const light = savedTheme === "light";
      $("togHC").checked = light;
      document.body.classList.toggle("dark", !light);
    } else {
      $("togHC").checked = !document.body.classList.contains("dark");
    }
    syncSidebarPreferences();
    if (window.WFVenueInfo) window.WFVenueInfo.render();
    window.dispatchEvent(new Event("wf-category-style"));
    const ready = (window.WF && WF.i18nReady) ? WF.i18nReady : Promise.resolve();
    const clearBoot = () => {
      document.body.classList.remove("booting");
      try { updateFloorPicker(); } catch (_) {}
    };
    // Keep the ordinary map's existing failsafe. MP startup has a failure
    // deadline owned by its loader, rather than a timer that reveals blank UI.
    if (!isMpMode()) setTimeout(clearBoot, 8000);
    let startupGeneration = window.WFStartup && window.WFStartup.generation;
    Promise.resolve(ready).then(async () => {
      if (isMpMode()) {
        const ok = await window.__mpBackgroundPromise;
        startupGeneration = window.WFStartup && window.WFStartup.generation;
        if (!ok) throw new Error("Background not ready");
      }
      try { if (window.WFi18n) WFi18n.applyDom(); } catch (_) {}
      // Apply links after the SDK is available, preserving destination/floor context.
      try { await applyDeepLink(); }
      catch (e) { console.warn("applyDeepLink", e); showHome(); }
      if (window.WFStartup) window.WFStartup.uiReady(startupGeneration);
      else clearBoot();
      try { updateFloorPicker(); } catch (_) {}
    }).catch(() => { if (window.WFStartup) window.WFStartup.fail(startupGeneration); else clearBoot(); });
  }


  function refreshI18nChrome() {
    if (window.WFi18n) WFi18n.applyDom();
    // POIs whose Supabase row has translated names (p.names, from navme_pois.poi_names)
    // get their display name swapped to the current language; POIs with none (p.names is
    // null — not synced through the dashboard's gmap flow) keep whatever name they had.
    POIS.forEach(p => { if (p.names) p.name = localized(p.names, p.name); });
    buildSearchIndex();
    if (wf && wf.redrawPOIs) try { wf.redrawPOIs(); } catch (_) {}
    POIS.forEach(p => p.tagsText = [cat(p).label, wf.floorLabel(p.floor), p.note || ""].join(" "));
    buildChips();
    window.dispatchEvent(new Event("wf-category-style"));
    // Floor picker: real-floor buttons show a language-agnostic digit (wf.floorLabel's
    // translation lives in each button's aria-label instead), only the "All" button's
    // visible text and every button's aria-label need updating here.
    const flList = $("floorList");
    if (flList) {
      flList.querySelectorAll("button[data-floor]").forEach(b => {
        const lab = wf.floorLabel(b.dataset.floor === "all" ? "all" : b.dataset.floor);
        if (b.dataset.floor === "all") b.textContent = t("viewer.floorAllShort");
        b.setAttribute("aria-label", lab);
      });
      updateFloorPicker();
    }
    const devFl = $("devFloors");
    if (devFl) devFl.querySelectorAll("button[data-floor]").forEach(b => {
      b.textContent = wf.floorLabel(b.dataset.floor);
    });
    const on3d = wf && wf.is3D && wf.is3D();
    if ($("btn3D")) { $("btn3D").textContent = on3d ? "2D" : "3D"; $("btn3D").setAttribute("aria-label", on3d ? t("viewer.switch2d") : t("viewer.switch3d")); }
    if (S.mode === "home") showHome();
    else if (S.mode === "place" && S.place) selectPlace(S.place, { fly: false, sheet: $("sheet").dataset.state });
    else if (S.mode === "dir" && S.route) renderDirections(S.route);
    else if (S.mode === "list" && S.filter) {
      const title = S.filter === ALL_CAT ? (t("viewer.allCategories") || "All") : (CHIPS().find(x => x[0] === S.filter) || [, S.filter])[1];
      showCategoryList(categorySourceItems(), title, $("sheet").dataset.state || "half");
    } else if (S.mode === "about") about();
    else if (S.mode === "language") showLanguageSheet({ preservePosition: true });
    else if (S.mode === "recent") showRecentSearches();
    else if (S.mode === "help") showHelp();
    if (S.mode === "dir" || S.mode === "nav") syncDirFields();
  }


  // ---------------- deep links ----------------
  async function applyDeepLink() {
    const q = pageQuery();
    const style = q.get("style") || (document.body.classList.contains("hc") ? "dark" : "map");
    await setStyle(style);
    if (q.get("floor")) wf.setFloor(q.get("floor"));
    if (q.get("me")) { const [lon, lat, F] = q.get("me").split(","); if (F) wf.setFloor(F); wf.localizeAt(+lon, +lat); onLocalized(wf.lastLoc, true); }
    if (q.get("mode") === "stepfree") S.stepFree = true;
    const to = byId[q.get("to")], fromK = q.get("from");
    if (to && fromK) { S.to = to; S.from = fromK === "me" ? "me" : byId[fromK] || null; openDirections(); }
    else if (to) selectPlace(to, { fly: true });
    else {
      // A normal venue URL opens directly onto the current venue. The building
      // chooser remains available from the NavMe logo, but should not cover the
      // model automatically on every fresh visit.
      if (!q.get("floor")) wf.setFloor(WF.cfg.default_floor);
      S.mode = "home";
      setUxMode("places");
      closeSheet();
      if (!q.get("floor")) zoomBuilding(true);
    }
    if (q.get("view") === "3d") setTimeout(() => toggle3D(true), 300);
  }
  function resolveShareRef(v) {
    if (v == null || v === "") return null;
    if (v === "me") return "me";
    if (typeof v === "object") return v;
    return byId[v] || null;
  }
  function shareUrl(opts) {
    opts = opts || {};
    const kind = opts.kind || ((S.mode === "dir" || S.mode === "nav") && S.to && S.from ? "dir" : (S.place ? "place" : "view"));
    const from = opts.from !== undefined ? resolveShareRef(opts.from) : S.from;
    const to = opts.to !== undefined ? resolveShareRef(opts.to) : (S.to || S.place);
    const place = opts.place !== undefined ? resolveShareRef(opts.place) : S.place;
    const stepFree = opts.stepFree !== undefined ? !!opts.stepFree : !!S.stepFree;
    const u = new URL(location.href.split("?")[0]);
    const cur = pageQuery();
    const P = u.searchParams;
    if (cur.get("venue")) P.set("venue", cur.get("venue"));
    const cleanAlias = window.WF_ROUTE_ALIASES && window.WF_ROUTE_ALIASES[location.pathname.replace(/\/$/, "") || "/"];
    if (!cleanAlias && cur.get("b")) P.set("b", cur.get("b"));
    if (!cleanAlias && cur.get("mp")) P.set("mp", cur.get("mp"));
    if (kind === "dir") {
      if (to && to !== "me") P.set("to", to.id);
      if (from) P.set("from", from === "me" ? "me" : from.id);
      if (stepFree) P.set("mode", "stepfree");
    } else if (kind === "place" && place && place !== "me") {
      P.set("to", place.id);
    }
    if (wf.lastLoc && ((kind === "dir" && from === "me") || opts.includeMe)) {
      P.set("me", [wf.lastLoc.lon.toFixed(7), wf.lastLoc.lat.toFixed(7), wf.lastLoc.floor].join(","));
    }
    P.set("floor", wf.currentFloor()); P.set("style", wf.style || "map");
    if (wf.is3D()) P.set("view", "3d");
    return u.toString();
  }
  function copyText(url) {
    const done = () => toast(t("viewer.linkCopied"));
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url));
    else fallbackCopy(url);
    function fallbackCopy(txt) {
      const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { prompt("Copy this link", txt); }
      ta.remove();
    }
  }
  function shareOptsFromSheet() {
    const kindEl = document.querySelector('input[name="shareKind"]:checked');
    const kind = kindEl ? kindEl.value : "view";
    const fromV = ($("shFrom") && $("shFrom").value) || "";
    const toV = ($("shTo") && $("shTo").value) || "";
    return {
      kind,
      from: kind === "dir" ? (fromV || null) : undefined,
      to: kind === "dir" ? (toV || null) : undefined,
      place: kind === "place" ? (S.place || S.to) : undefined,
      stepFree: !!( $("shStepFree") && $("shStepFree").checked )
    };
  }
  function refreshSharePreview() {
    const opts = shareOptsFromSheet();
    const prev = $("shPreview");
    if (!prev) return;
    if (opts.kind === "dir" && (!opts.from || !opts.to)) {
      prev.textContent = t("viewer.shareNeedDir");
      return;
    }
    prev.textContent = shareUrl(opts);
  }
  function fillShareSelects() {
    const fromSel = $("shFrom"), toSel = $("shTo");
    if (!fromSel || !toSel) return;
    const pois = POIS.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const meLabel = t("viewer.yourLocation");
    const mkOpts = (includeMe, selected) => {
      let html = includeMe ? `<option value="me">${esc(meLabel)}</option>` : `<option value="">—</option>`;
      pois.forEach(p => {
        const sel = selected && selected !== "me" && selected.id === p.id ? " selected" : "";
        html += `<option value="${esc(p.id)}"${sel}>${esc(p.name)} · ${esc(wf.floorLabel(p.floor))}</option>`;
      });
      return html;
    };
    let from0 = S.from;
    let to0 = S.to || S.place || null;
    if (!from0 && to0) from0 = wf.lastLoc ? "me" : defaultFrom(to0);
    if (!to0 && S.place) to0 = S.place;
    fromSel.innerHTML = mkOpts(true, from0);
    if (from0 === "me") fromSel.value = "me";
    else if (from0 && from0.id) fromSel.value = from0.id;
    toSel.innerHTML = mkOpts(false, to0);
    if (to0 && to0.id) toSel.value = to0.id;
    if ($("shStepFree")) $("shStepFree").checked = !!S.stepFree;
  }
  function setShareKind(kind) {
    const map = { view: "shKindView", place: "shKindPlace", dir: "shKindDir" };
    const el = $(map[kind] || "shKindView");
    if (el) el.checked = true;
    document.querySelectorAll(".share-kind").forEach(lab => {
      const inp = lab.querySelector('input[name="shareKind"]');
      lab.classList.toggle("on", !!(inp && inp.checked));
    });
    const dirFields = $("shareDirFields");
    if (dirFields) dirFields.hidden = kind !== "dir";
    refreshSharePreview();
  }
  function openShareSheet() {
    const m = $("shareSheet");
    if (!m) { // fallback if markup missing
      const url = shareUrl();
      copyText(url);
      if (navigator.share && !isDesk()) navigator.share({ title: document.title, url }).catch(() => { });
      return url;
    }
    bindShareSheet();
    const hasPlace = !!(S.place || (S.to && S.mode !== "dir" && S.mode !== "nav"));
    const placeLab = $("shKindPlaceLab");
    if (placeLab) {
      placeLab.hidden = !(S.place || S.to);
      const nm = $("shPlaceName");
      if (nm) nm.textContent = (S.place || S.to) ? (S.place || S.to).name : "";
    }
    fillShareSelects();
    let kind = "view";
    if ((S.mode === "dir" || S.mode === "nav") && S.from && S.to) kind = "dir";
    else if (S.place || S.to) kind = "place";
    setShareKind(kind);
    const nat = $("shNative");
    if (nat) nat.hidden = !navigator.share;
    m.hidden = false;
    if (window.WFi18n && WFi18n.applyDom) WFi18n.applyDom(m);
    ($("shCopy") || $("shClose")).focus();
    return shareUrl(shareOptsFromSheet());
  }
  function closeShareSheet() { const m = $("shareSheet"); if (m) m.hidden = true; }
  function bindShareSheet() {
    const m = $("shareSheet"); if (!m || m.dataset.bound) return;
    m.dataset.bound = "1";
    const close = () => closeShareSheet();
    if ($("shClose")) $("shClose").onclick = close;
    if ($("shCancel")) $("shCancel").onclick = close;
    m.addEventListener("click", (ev) => { if (ev.target === m) close(); });
    ["shKindView", "shKindPlace", "shKindDir"].forEach(id => {
      const el = $(id); if (!el) return;
      el.onchange = () => setShareKind(el.value);
    });
    if ($("shFrom")) $("shFrom").onchange = refreshSharePreview;
    if ($("shTo")) $("shTo").onchange = refreshSharePreview;
    if ($("shStepFree")) $("shStepFree").onchange = refreshSharePreview;
    if ($("shCopy")) $("shCopy").onclick = () => {
      const opts = shareOptsFromSheet();
      if (opts.kind === "dir" && (!opts.from || !opts.to)) { toast(t("viewer.shareNeedDir")); return; }
      const url = shareUrl(opts);
      copyText(url);
      closeShareSheet();
    };
    if ($("shNative")) $("shNative").onclick = () => {
      const opts = shareOptsFromSheet();
      if (opts.kind === "dir" && (!opts.from || !opts.to)) { toast(t("viewer.shareNeedDir")); return; }
      const url = shareUrl(opts);
      if (navigator.share) navigator.share({ title: document.title, url }).then(() => closeShareSheet()).catch(() => { });
      else { copyText(url); closeShareSheet(); }
    };
  }
  function share() { return openShareSheet(); }
  wfShare = share;
  // ---------------- search + autocomplete ----------------
  let acTarget = null, acItems = [], acSel = -1;
  const recent = () => {
    try {
      const stored = JSON.parse(localStorage.getItem("wf_recent") || "[]");
      return (Array.isArray(stored) ? stored : []).filter(id => byId[id]).slice(0, 3);
    } catch (e) { return []; }
  };
  const pushRecent = (id) => { const r = [id].concat(recent().filter(x => x !== id)).slice(0, 3); localStorage.setItem("wf_recent", JSON.stringify(r)); };
  // ---- campus: other buildings of the venue (search across buildings, markers on the map) ----
  let REMOTE = [], rfuse = null;
  function loadCampus() {
    const others = WF.others || []; if (!others.length) return;
    const lyr = new wf.esri.GraphicsLayer({ title: "Other buildings" }); wf.map2d.add(lyr);
    wf._campusLayer = lyr;
    wf._campusBuildings = others.slice();
    function drawCampus() {
      lyr.removeAll();
      const showNames = !!wf.showLabels;
      (wf._campusBuildings || []).forEach(b => {
        if (!b.center) return;
        const pt = new wf.esri.Point({ longitude: b.center.lon, latitude: b.center.lat });
        lyr.add(new wf.esri.Graphic({ geometry: pt, attributes: { bslug: b.slug }, symbol: { type: "simple-marker", size: 16, color: [26, 115, 232], outline: { color: "white", width: 2 } } }));
        if (showNames) {
          lyr.add(new wf.esri.Graphic({ geometry: pt, attributes: { bslug: b.slug }, symbol: { type: "text", text: b.name, yoffset: 14, color: [32, 33, 36], haloColor: "white", haloSize: 1.5, font: { size: 11, weight: "bold" } } }));
        }
      });
    }
    wf.refreshCampusLabels = drawCampus;
    wf.onShowLabels = (on) => { drawCampus(); };
    others.forEach(b => {
      fetch(b.dataUrl + "pois.json").then(r => r.json()).then(d => {
        d.pois.forEach(p => { p._remote = { slug: b.slug, name: b.name }; p.tagsText = b.name; REMOTE.push(p); });
        rfuse = new Fuse(REMOTE, { keys: [{ name: "name", weight: 0.7 }, { name: "tagsText", weight: 0.3 }], threshold: 0.4, ignoreLocation: true });
      }).catch(() => { });
    });
    drawCampus();
    wf.view2d.on("click", (e) => wf.view2d.hitTest(e, { include: [lyr] }).then(h => { const g = h.results[0]; if (g && g.graphic.attributes) goBuilding(g.graphic.attributes.bslug); }));
  }
  function goBuilding(slug, poiId) {
    const u = new URL("/", location.href);
    const q0 = typeof WFQuery === "function" ? WFQuery() : new URLSearchParams(location.search);
    if (q0.get("venue")) u.searchParams.set("venue", q0.get("venue"));
    u.searchParams.set("b", slug);
    // A building switch is still part of the same viewer session. Keep the live
    // Matterport background enabled instead of silently falling back to the 2D map.
    if (q0.get("mp") === "1" || slug === "uncc-main-campus") u.searchParams.set("mp", "1");
    if (poiId) u.searchParams.set("to", poiId);
    location.href = u.toString();
  }
  function search(txt, local) {
    txt = (txt || "").trim();
    if (!txt) return null;
    const res = fuse.search(txt, { limit: 30 }).map(r => r.item);
    if (!local && rfuse) res.push(...rfuse.search(txt, { limit: 10 }).map(r => r.item));
    return res;
  }
  function renderAc(input, extra) {
    acTarget = input;
    if (input === $("q") && S.uxMode === "buildings") {
      const txt = input.value; const list = $("acList"); acItems = [];
      let buildings = allBuildings();
      const qtxt = (txt || "").trim().toLowerCase();
      if (qtxt) buildings = buildings.filter(b => (buildingDisplayName(b) + " " + (b.address || "") + " " + (b.slug || "")).toLowerCase().includes(qtxt));
      let html = `<li class="hdr" role="presentation">${esc(t("viewer.chooseBuilding"))}</li>`;
      buildings.forEach(b => {
        acItems.push({ building: b });
        const floors = (b.floors && b.floors.length) ? t("viewer.floorsShort", { n: b.floors.length }) : "";
        html += `<li role="option" id="ac${acItems.length - 1}"><span class="ic" style="background:rgba(26,115,232,.12)"><span class="ms fill" style="color:var(--blue)">apartment</span></span><span class="t"><b>${esc(buildingDisplayName(b))}</b><div class="s">${esc([floors, b.address].filter(Boolean).join(" · "))}</div></span></li>`;
      });
      if (!buildings.length) html += `<li class="hdr ac-message" role="presentation">${esc(t("viewer.noMatches", { q: txt }))}</li>`;
      list.innerHTML = html; list.hidden = false; document.body.classList.add("ac-open"); acSel = -1; input.setAttribute("aria-expanded", "true");
      list.querySelectorAll("li[role=option]").forEach((li) => { li.onmousedown = (e) => { e.preventDefault(); pickAc(+li.id.slice(2)); }; });
      const top = $("top").getBoundingClientRect().top, fb = $("searchBox").getBoundingClientRect().bottom;
      $("top").style.setProperty("--acTop", Math.round(fb - top + 6) + "px");
      // keep sheet gallery in sync while typing
      if (S.mode === "home") showBuildingPicker(txt);
      return;
    }
    const txt = input.value;
    // After a building is selected (places mode), main search is this building only.
    const localOnly = input !== $("q") || S.uxMode === "places";
    const res = search(txt, localOnly);
    const list = $("acList"); let html = ""; acItems = [];
    if (extra) extra.forEach(x => { acItems.push(x); html += `<li role="option" id="ac${acItems.length - 1}"><span class="ic" style="background:${x.color}"><span class="ms fill">${x.icon}</span></span><span class="t"><b>${esc(x.label)}</b><div class="s">${esc(x.sub || "")}</div></span></li>`; });
    if (!res) {
      const rc = recent();
      if (rc.length) { html += `<li class="hdr" role="presentation">${esc(t("viewer.recent"))}</li>`; rc.forEach(id => { acItems.push({ poi: byId[id] }); html += itemHtml(byId[id], true, acItems.length - 1); }); }
      // Cross-building places only on the building-picker screen; places mode stays in-building.
      if (input === $("q") && S.uxMode === "buildings") (WF.others || []).forEach(b => {
        const items = REMOTE.filter(p => p._remote.slug === b.slug).sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }));
        if (!items.length) return;
        html += `<li class="hdr" role="presentation">${esc(b.name)} (${items.length})</li>`;
        items.forEach(p => { acItems.push({ poi: p }); html += itemHtml(p, false, acItems.length - 1); });
      });
    } else if (!res.length) html += `<li class="hdr ac-message" role="presentation">${esc(t("viewer.noMatches", { q: txt }))}</li>`;
    else res.forEach(p => { acItems.push({ poi: p }); html += itemHtml(p, false, acItems.length - 1); });
    list.innerHTML = html; list.hidden = false; document.body.classList.add("ac-open"); acSel = -1; input.setAttribute("aria-expanded", "true");
    list.querySelectorAll("li[role=option]").forEach((li, i) => { li.onmousedown = (e) => { e.preventDefault(); pickAc(+li.id.slice(2)); }; });
    // position under the active input (directions fields sit lower)
    const top = $("top").getBoundingClientRect().top, fb = (input === $("q") ? $("searchBox") : input.closest(".dfield")).getBoundingClientRect().bottom;
    $("top").style.setProperty("--acTop", Math.round(fb - top + 6) + "px");
  }
  function itemHtml(p, hist, i) {
    const c = cat(p);
    return `<li role="option" id="ac${i}" aria-label="${esc(p.name)}, ${esc(wf.floorLabel(p.floor))}"><span class="ic ${hist ? "hist" : ""}" style="${hist ? "" : "background:" + rgb(c.color)}"><span class="ms ${hist ? "" : "fill"}">${hist ? "history" : c.icon}</span></span>
      <span class="t"><b>${esc(p.name)}</b><div class="s">${esc(c.label)}${p.code && p.code !== p.name ? " · " + esc(p.code) : ""}</div></span><span class="badge floor">${p._remote ? esc(p._remote.name) + " · " + esc(p.floor) : esc(wf.floorLabel(p.floor))}</span></li>`;
  }
  function moveAc(d) {
    const lis = $("acList").querySelectorAll("li[role=option]"); if (!lis.length) return;
    acSel = (acSel + d + lis.length) % lis.length;
    lis.forEach((li, i) => li.setAttribute("aria-selected", i === acSel ? "true" : "false"));
    acTarget.setAttribute("aria-activedescendant", lis[acSel].id); lis[acSel].scrollIntoView({ block: "nearest" });
  }
  function pickAc(i) {
    const it = acItems[i]; if (!it) return;
    const target = acTarget; closeAc();
    if (it.building) { enterBuilding(it.building.slug); return; }
    if (it.poi && it.poi._remote) { goBuilding(it.poi._remote.slug, it.poi.id); return; }
    if (target === $("q")) { if (it.poi) { pushRecent(it.poi.id); target.value = it.poi.name; target.blur(); setUxMode("places"); selectPlace(it.poi, { fly: true }); } }
    else {
      const which = target === $("fromQ") ? "from" : "to";
      if (it.me) { S[which] = "me"; if (which === "from" && !wf.lastLoc) startLocalize(true); }
      else if (it.poi) { S[which] = it.poi; pushRecent(it.poi.id); if (which === "from") S.locMeta = null; }
      target.blur(); syncDirFields();
      if (!S.from || !S.to) openDirections();
      else computeRoute();
      mpFocusSelection(which);
    }
  }
  function closeAc() { $("acList").hidden = true; document.body.classList.remove("ac-open"); [$("q"), $("fromQ"), $("toQ")].forEach(i => i.setAttribute("aria-expanded", "false")); }
  function acKeys(input, extraFn) {
    const prepareSearchSurface = () => {
      // The campus/Explore sheet and the autocomplete are alternative surfaces.
      // Keeping both open makes the search results overlap the campus cards on mobile.
      if (input === $("q") && !$("sheet").hidden && $("sheet").classList.contains("venue-info")) closeSheet();
      // The start/destination autocomplete likewise replaces the directions prompt
      // while the visitor is choosing a POI. computeRoute/openDirections restores the
      // appropriate next panel after a selection is made.
      if ((input === $("fromQ") || input === $("toQ")) && S.mode === "dir" && !$("sheet").hidden) closeSheet();
    };
    input.addEventListener("pointerdown", prepareSearchSurface);
    input.addEventListener("click", () => {
      prepareSearchSurface();
      if ($("acList").hidden) renderAc(input, extraFn && extraFn());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if ($("acList").hidden) { prepareSearchSurface(); renderAc(input, extraFn && extraFn()); } moveAc(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveAc(-1); }
      else if (e.key === "Enter") { e.preventDefault(); if (acSel < 0) acSel = acItems.findIndex(x => x.poi || x.me); pickAc(acSel); }
      else if (e.key === "Escape") { closeAc(); input.blur(); }
    });
    input.addEventListener("input", () => { prepareSearchSurface(); renderAc(input, extraFn && extraFn()); });
    input.addEventListener("focus", () => { input.select(); prepareSearchSurface(); renderAc(input, extraFn && extraFn()); closePop(); });
    input.addEventListener("blur", () => setTimeout(() => {
      const active = document.activeElement;
      // Moving between the main search and either directions field is one continuous
      // autocomplete flow. Do not let the previous input's delayed blur close the new
      // field's results.
      if (active !== $("q") && active !== $("fromQ") && active !== $("toQ")) closeAc();
    }, 150));
  }
  function bindSearch() {
    const q = $("q");
    acKeys(q);
    q.addEventListener("input", () => { $("btnClearQ").hidden = !q.value; });
    $("btnClearQ").onclick = () => {
      q.value = ""; $("btnClearQ").hidden = true; clearSelection();
      if (S.uxMode === "places") { showBuildingHome(); }
      else showBuildingPicker();
      q.focus();
    };
    $("btnDirQuick").onclick = () => { setUxMode("places"); S.to = S.place || null; S.from = wf.lastLoc ? "me" : null; openDirections(); };
    if ($("bldgChip")) $("bldgChip").onclick = () => { showBuildingPicker(); try { $("q").focus(); } catch (e) {} };
    if ($("btnBrand")) $("btnBrand").onclick = () => { showBuildingPicker(); };
    // Start inside the current venue. The NavMe logo is the explicit entry point
    // for building information and the multi-building chooser.
    setUxMode("places");
  }

  // ---------------- chips ----------------
  // Horizontal scrolling row of chip buttons (as before), an "All" chip pinned first,
  // plus one trailing icon-only "more" pill that opens a dropdown with the complete
  // category list laid out in full (no internal scroll) for buildings with more
  // categories than comfortably fit in the row.
  const ALL_CAT = "__all__";
  function chipBtnHtml(c, l, icon, color) {
    return `<button class="chip" data-cat="${c}" aria-pressed="false"><span class="ms" style="color:${color}">${icon}</span>${l}</button>`;
  }
  function allChipHtml() {
    return chipBtnHtml(ALL_CAT, esc(t("viewer.allCategories") || "All"), "apps", "var(--txt2)");
  }
  function buildChips() {
    const chips = CHIPS();
    const chipsHtml = chips.map(([c, l]) => chipBtnHtml(c, l, CAT[c].icon, rgb(CAT[c].color))).join("");
    // #chipsMore is a static pinned button (index.html), NOT part of this scrolling row —
    // it stays put in the right corner while only these pills scroll past/behind it.
    $("chips").innerHTML = allChipHtml() + chipsHtml;
    bindCategoryButtons($("chips"));
    $("chipsDropdown").innerHTML = allChipHtml() + chipsHtml;
    bindCategoryButtons($("chipsDropdown"));
    $("chipsMore").onclick = () => setChipsOpen($("chipsDropdown").hidden);
  }
  function bindCategoryButtons(root) {
    root.querySelectorAll(".chip[data-cat]").forEach(button => {
      let touchHandledAt = 0;
      const choose = event => {
        event.preventDefault();
        event.stopPropagation();
        setChipsOpen(false);
        toggleChip(button.dataset.cat);
      };
      // Mobile Safari/Chrome can suppress the later click when this fixed dropdown is
      // over a touch-driven Matterport canvas. Handle the completed touch pointer
      // directly, while retaining click for mouse, keyboard and older browsers.
      button.addEventListener("pointerup", event => {
        if (event.pointerType !== "touch") return;
        touchHandledAt = Date.now();
        choose(event);
      });
      button.onclick = event => {
        if (Date.now() - touchHandledAt < 700) { event.preventDefault(); event.stopPropagation(); return; }
        choose(event);
      };
    });
  }
  function setChipsOpen(open) {
    if (open) {
      // position:fixed + computed here (rather than CSS anchored to .chips-wrap) because
      // the dropdown now lives outside .top in the DOM (see index.html) so its stacking
      // is independent of .top/.sheet's z-index — it always draws above both.
      const r = $("chipsMore").getBoundingClientRect();
      const dd = $("chipsDropdown");
      dd.style.top = (r.bottom + 2) + "px";
      const w = Math.max(220, Math.min(280, window.innerWidth - 20));
      dd.style.left = Math.max(8, r.right - w) + "px";
    }
    $("chipsDropdown").hidden = !open;
    $("chipsMore").setAttribute("aria-expanded", String(!!open));
  }
  function selectCategoryMarker(id, poiIds, name) {
    if (!wf || S.mode === "dir" || S.mode === "nav") return;
    const category = (wf.categories || []).find(c => String(c.id) === String(id));
    const key = String((category && category.name) || name || "").trim().toLowerCase();
    if (!key) return;
    // A marker always opens the category list; it never toggles it off or picks a destination.
    S.filter = null;
    toggleChip(key, new Set(poiIds.map(String)));
  }
  function categoryMarkerContext() {
    const current = window.wf;
    return { venue: (window.WF && WF.building && WF.building.slug) || (window.WF && WF.cfg && WF.cfg.slug),
      pois: current && current.pois, uiMode: S.mode, filter: S.filter, uiReady: !!wf };
  }
  function categoryMarkerStyle(category) {
    const key = String(category.name || "").trim().toLowerCase();
    const style = CAT_BASE[key] || CAT_BASE.room || {};
    return { label: localized(category.category_names || category.names, category.name),
      icon: LUCIDE_TO_MS[category.icon_key] || style.icon || "place", color: style.color };
  }
  function toggleChip(c, memberIds) {
    // Category choices are navigation, not on/off toggles: tapping the active category
    // must reliably reopen its POI list instead of unexpectedly returning home.
    S.filter = c;
    document.querySelectorAll("#chips .chip[data-cat], #chipsDropdown .chip[data-cat]").forEach(b => { const on = b.dataset.cat === S.filter; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    $("chipsMore").classList.toggle("active", !!(S.filter && S.filter !== ALL_CAT));
    setChipsOpen(false);
    window.dispatchEvent(new Event("wf-category-style"));
    const showingAll = S.filter === ALL_CAT;
    wf.poiFilter = (S.filter && !showingAll) ? new Set([S.filter]) : null; wf.redrawPOIs();
    if (!S.filter) { S.categoryPoiIds = null; S.categoryFloor = "__all__"; showHome(); return; }
    const items = showingAll ? POIS.slice() : POIS.filter(p => memberIds ? memberIds.has(String(p.id)) : p.category === S.filter);
    const title = showingAll ? (t("viewer.allCategories") || "All") : (CHIPS().find(x => x[0] === c) || [, c])[1];
    S.categoryPoiIds = memberIds ? items.map(p => String(p.id)) : null;
    S.categoryFloor = "__all__";
    S.mode = "list"; showCategoryList(items, title, "half");
    if (items.length) {
      const fl = items.map(p => p.floor); const F = fl.includes(wf.currentFloor()) ? wf.currentFloor() : fl[0]; wf.setFloor(F);
      fitLonLat(items.map(p => p.lonlat), 1.8);
    }
  }
  function categorySourceItems() {
    if (Array.isArray(S.categoryPoiIds)) {
      const ids = new Set(S.categoryPoiIds);
      return POIS.filter(p => ids.has(String(p.id)));
    }
    return S.filter === ALL_CAT ? POIS.slice() : POIS.filter(p => p.category === S.filter);
  }
  function categoryFloorToolbar(items) {
    const ordinal = id => ((((WF.cfg.floors || []).find(f => String(f.id) === String(id))) || {}).ordinal ?? 0);
    // Numbered labels are the visible order, even when imported ordinals differ.
    const floorNumber = id => {
      const match = /^(?:floor|level)\s+(-?\d+(?:\.\d+)?)$/i.exec(String(wf.floorLabel(id)).trim());
      return match ? Number(match[1]) : null;
    };
    const floors = [...new Set(items.map(p => p.floor).filter(Boolean))].sort((a, b) =>
      (floorNumber(a) !== null && floorNumber(b) !== null ? floorNumber(a) - floorNumber(b) : ordinal(a) - ordinal(b)) ||
      String(wf.floorLabel(a)).localeCompare(String(wf.floorLabel(b)), undefined, { numeric: true })
    );
    if (S.categoryFloor !== "__all__" && !floors.includes(S.categoryFloor)) S.categoryFloor = "__all__";
    if (floors.length < 2) return "";
    const button = (id, label) => `<button type="button" class="ac-floor${S.categoryFloor === id ? " on" : ""}" data-category-floor="${esc(id)}" aria-pressed="${S.categoryFloor === id}">${esc(label)}</button>`;
    return `<div class="category-floor-filter"><div class="ac-floor-scroll" role="group" aria-label="${esc(t("viewer.floor"))}">${button("__all__", t("viewer.allFloors"))}${floors.map(id => button(id, wf.floorLabel(id))).join("")}</div></div>`;
  }
  function showCategoryList(items, title, state) {
    const toolbar = categoryFloorToolbar(items);
    const visible = S.categoryFloor === "__all__" ? items : items.filter(p => p.floor === S.categoryFloor);
    setSheet(listHtml(visible, title, toolbar), state || "half");
    bindList(visible);
    $("sheetBody").querySelectorAll("[data-category-floor]").forEach(button => { button.onclick = () => {
      S.categoryFloor = button.dataset.categoryFloor;
      showCategoryList(items, title, $("sheet").dataset.state || "half");
      const shown = S.categoryFloor === "__all__" ? items : items.filter(p => p.floor === S.categoryFloor);
      if (S.categoryFloor !== "__all__") wf.setFloor(S.categoryFloor);
      if (shown.length) fitLonLat(shown.map(p => p.lonlat), 1.8);
    }; });
  }
  function listHtml(items, title, toolbar) {
    if (!items.length) return `<h1 class="pname">${esc(title)}</h1>${toolbar || ""}<div class="warn"><span class="ms">info</span><div>${esc(t("viewer.noMappedYet", { title: title.toLowerCase() }))}</div></div>`;
    return `<h1 class="pname">${esc(title)} <span class="muted">(${items.length})</span></h1>${toolbar || ""}<ul class="list">` + items.map(p => { const c = cat(p);
      return `<li data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(p.name)}"><span class="ic" style="background:${rgb(c.color)}"><span class="ms fill">${c.icon}</span></span><div style="flex:1;min-width:0"><div>${esc(p.name)}</div><div class="muted">${esc(c.label)} · ${esc(wf.floorLabel(p.floor))}</div></div>${sfBadge(p, true)}</li>`; }).join("") + "</ul>";
  }
  function bindList(items) {
    $("sheetBody").querySelectorAll(".list li").forEach(li => { const go = () => selectPlace(byId[li.dataset.id], { fly: true }); li.onclick = go; li.onkeydown = (e) => { if (e.key === "Enter") go(); }; });
  }

  // ---------------- place card ----------------
  function sfBadge(p, short) {
    return p.step_free_from_parking ? `<span class="badge sf" title="${esc(t("viewer.stepFreeTitle"))}"><span class="ms">accessible</span>${short ? t("viewer.stepFreeShort") : t("viewer.stepFreeAccess")}</span>`
      : `<span class="badge st" title="${esc(t("viewer.stepsTitle"))}"><span class="ms">stairs</span>${short ? t("viewer.stepsShort") : t("viewer.stepsOnRoute")}</span>`;
  }
  function thumbFor(nodeId) { return thumbs.has(nodeId) ? WF.D(`thumbs/${nodeId}.jpg`) : null; }
  let poiPhotoHydrateTimer = 0;
  let poiPhotoNodes = [];
  function hydrateMatterportPoiPhotos(attempt) {
    attempt = attempt || 0;
    if (!isMpMode() || !thumbs.size || !window.MpPreview || !MpPreview.thumbnailSweepNodes) return;
    MpPreview.thumbnailSweepNodes().then(nodes => {
      const photographed = (nodes || []).filter(n => n && n.id && thumbs.has(n.id) && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z));
      if (!photographed.length) {
        if (attempt < 5) poiPhotoHydrateTimer = setTimeout(() => hydrateMatterportPoiPhotos(attempt + 1), 2000);
        return;
      }
      poiPhotoNodes = photographed;
      POIS.forEach(p => {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
        const sameFloor = photographed.filter(n => !p.floor || !n.floor || n.floor === p.floor);
        const candidates = sameFloor.length ? sameFloor : photographed;
        let best = null, bestD = Infinity;
        candidates.forEach(n => {
          const dx = n.x - p.x, dy = n.y - p.y, dz = n.z - p.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = n; }
        });
        if (best) p.nearest_node = best.id;
      });
      if (S.mode === "home" && $("venueTabPanel")) renderVenueTab();
      if (S.mode === "place" && S.place) selectPlace(S.place, { fly: false, sheet: $("sheet").dataset.state || "half" });
    }).catch(() => {
      if (attempt < 5) poiPhotoHydrateTimer = setTimeout(() => hydrateMatterportPoiPhotos(attempt + 1), 2000);
    });
  }
  /** Scan photos near this POI. Matterport mode has no eager nav graph, so use
   *  its hydrated sweep positions to find additional same-floor views within 12 m. */
  function nearbyThumbs(p, limit) {
    limit = limit || 6;
    const out = [], seen = new Set();
    const tryAdd = (nodeId) => {
      if (!nodeId || seen.has(nodeId)) return;
      seen.add(nodeId);
      const url = thumbFor(nodeId);
      if (url) out.push(url);
    };
    tryAdd(p.nearest_node);
    if (isMpMode() && [p.x, p.y, p.z].every(Number.isFinite)) {
      poiPhotoNodes
        .filter(n => p.floor && n.floor === p.floor)
        .map(n => ({ node: n, distance: (n.x - p.x) ** 2 + (n.y - p.y) ** 2 + (n.z - p.z) ** 2 }))
        .filter(item => item.distance <= 12 ** 2)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .forEach(item => tryAdd(item.node.id));
    }
    if (wf.nav && Array.isArray(wf.nav.edges) && p.nearest_node) {
      const adj = {};
      wf.nav.edges.forEach(e => {
        if (!e) return;
        (adj[e.u] = adj[e.u] || []).push(e.v);
        (adj[e.v] = adj[e.v] || []).push(e.u);
      });
      let frontier = [p.nearest_node];
      const visited = new Set(frontier);
      let depth = 0;
      while (out.length < limit && frontier.length && depth < 5) {
        const next = [];
        frontier.forEach(id => (adj[id] || []).forEach(n => {
          if (visited.has(n)) return;
          visited.add(n); tryAdd(n); next.push(n);
        }));
        frontier = next; depth++;
      }
    }
    return out.slice(0, limit);
  }
  function poiGalleryUrls(p, shop, limit) {
    const urls = [], seen = new Set();
    const add = value => {
      if (value && typeof value === "object") value = value.url || value.image_url || value.src;
      if (typeof value !== "string") return;
      value = value.trim();
      if (!/^(https?:\/\/|\/(?!\/)|\.\.?\/)/i.test(value) || seen.has(value)) return;
      seen.add(value); urls.push(value);
    };
    add(p && p.photo_url);
    if (p && Array.isArray(p.photo_urls)) p.photo_urls.forEach(add);
    if (p && Array.isArray(p.gallery_images)) p.gallery_images.forEach(add);
    const exploreState = exploreController && exploreController.get();
    if (p && exploreState && exploreState.status === "ready" && exploreState.venue === venueSlug()) {
      const meta = (exploreState.data.pois || []).find(item => String(item.id) === String(p.id));
      add(meta && meta.image_url);
    }
    add(shop && shop.cover_image_url);
    if (shop && Array.isArray(shop.gallery_images)) shop.gallery_images.forEach(add);
    nearbyThumbs(p, limit || 8).forEach(add);
    return urls.slice(0, limit || 8);
  }
  /** 09:00 -> "9:00 AM". Falsy input (e.g. a closed day's null open/close) -> "". */
  function fmtHm(hm) {
    if (!hm) return "";
    const [h, m] = hm.split(":").map(Number);
    const ap = h >= 12 ? "PM" : "AM"; let hh = h % 12; if (hh === 0) hh = 12;
    return hh + (m ? ":" + String(m).padStart(2, "0") : "") + " " + ap;
  }
  const SHOP_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  /** Open/closed right now from a shop's weekly `hours` array, honoring a manual
   *  is_open_override if the admin set one. Null if there is no hours data at all. */
  function shopOpenStatus(shop) {
    if (!shop) return null;
    if (shop.is_open_override === true) return { open: true, label: t("viewer.openNow") || "Open" };
    if (shop.is_open_override === false) return { open: false, label: t("viewer.closedNow") || "Closed" };
    if (!Array.isArray(shop.hours) || !shop.hours.length) return null;
    const byDay = {}; shop.hours.forEach(h => { if (h && h.day) byDay[h.day] = h; });
    const toMin = (s) => { if (!s) return null; const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
    const now = new Date(), todayIdx = now.getDay(), nowMin = now.getHours() * 60 + now.getMinutes();
    const today = byDay[SHOP_DOW[todayIdx]];
    if (today && !today.closed) {
      const o = toMin(today.open), c = toMin(today.close);
      if (o != null && c != null && nowMin >= o && nowMin < c) {
        return { open: true, label: (t("viewer.closesAt") || "Closes") + " " + fmtHm(today.close) };
      }
      if (o != null && nowMin < o) {
        return { open: false, label: (t("viewer.opensAt") || "Opens") + " " + fmtHm(today.open) };
      }
    }
    for (let i = 1; i <= 7; i++) {
      const d = byDay[SHOP_DOW[(todayIdx + i) % 7]];
      if (d && !d.closed && d.open) {
        const when = i === 1 ? (t("viewer.tomorrow") || "tomorrow") : SHOP_DOW[(todayIdx + i) % 7];
        return { open: false, label: (t("viewer.opens") || "Opens") + " " + when + " " + fmtHm(d.open) };
      }
    }
    return { open: false, label: t("viewer.closedNow") || "Closed" };
  }
  /** Menu items grouped into Google-Maps-style sections by their own `category`. */
  function shopMenuHtml(menu) {
    if (!Array.isArray(menu) || !menu.length) return `<p class="muted shop-empty">${esc(t("viewer.menuUnavailable") || "Menu not available yet.")}</p>`;
    const groups = [], byName = {};
    menu.forEach(m => {
      if (!m) return;
      const cat = m.category || (t("viewer.shopMenu") || "Menu");
      if (!byName[cat]) { byName[cat] = []; groups.push(cat); }
      byName[cat].push(m);
    });
    return groups.map(cat => `
      <div class="menu-group">
        <div class="menu-group-title">${esc(cat)}</div>
        ${byName[cat].map(m => `
          <div class="menu-item">
            ${m.image_url ? `<img class="menu-item-img" src="${esc(m.image_url)}" alt="${esc(m.name || "")}" loading="lazy">` : ""}
            <div class="menu-item-body">
              <div class="menu-item-name">${m.veg === true ? '<span class="veg-dot veg" title="Veg"></span>' : m.veg === false ? '<span class="veg-dot nonveg" title="Non-veg"></span>' : ""}${esc(m.name || "")}</div>
              ${m.description ? `<div class="menu-item-desc muted">${esc(m.description)}</div>` : ""}
            </div>
            ${m.price != null ? `<div class="menu-item-price">₹${esc(String(m.price))}</div>` : ""}
          </div>`).join("")}
      </div>`).join("");
  }
  /** Weekly hours table for the Overview tab, today's row highlighted. */
  function shopHoursHtml(hours) {
    if (!Array.isArray(hours) || !hours.length) return "";
    const todayAbbr = SHOP_DOW[new Date().getDay()];
    return `<div class="shop-hours">${hours.map(h => `
      <div class="shop-hours-row${h.day === todayAbbr ? " today" : ""}">
        <span>${esc(h.day)}</span>
        <span>${h.closed ? esc(t("viewer.closed") || "Closed") : esc(fmtHm(h.open)) + " – " + esc(fmtHm(h.close))}</span>
      </div>`).join("")}</div>`;
  }
  /** Google-Maps-style shop block: rating/price/open-status row, tags, Overview/Menu
   *  tabs — rendered below the photo section for any POI the dashboard added to
   *  navme_shop (see app.js's window.WF.shopsByPoiId, populated from
   *  GET /api/v1/public/buildings/{slug}/shops). */
  function shopSectionHtml(shop) {
    const status = shopOpenStatus(shop);
    const tags = Array.isArray(shop.tags) ? shop.tags : [];
    return `
      <div class="shop">
        <div class="shop-meta">
          ${shop.rating != null ? `<span class="shop-rating">★ ${esc(String(shop.rating))}${shop.rating_count ? ` <span class="muted">(${esc(String(shop.rating_count))})</span>` : ""}</span>` : ""}
          ${shop.price_range ? `<span class="shop-dot">·</span><span>${esc(shop.price_range)}</span>` : ""}
          ${status ? `<span class="shop-dot">·</span><span class="shop-status ${status.open ? "open" : "closed"}">${status.open ? (t("viewer.openNow") || "Open") : (t("viewer.closedNow") || "Closed")} · ${esc(status.label)}</span>` : ""}
        </div>
        ${shop.tagline ? `<div class="shop-tagline">${esc(shop.tagline)}</div>` : ""}
        ${tags.length ? `<div class="shop-tags">${tags.map(tg => `<span class="chip-tag">${esc(tg)}</span>`).join("")}</div>` : ""}
        <div class="shop-tabs" role="tablist">
          <button type="button" class="shop-tab active" data-tab="overview" role="tab" aria-selected="true">${esc(t("viewer.overview") || "Overview")}</button>
          <button type="button" class="shop-tab" data-tab="menu" role="tab" aria-selected="false">${esc(t("viewer.shopMenu") || "Menu")}</button>
        </div>
        <div class="shop-tabpanel" data-panel="overview">
          ${shop.description ? `<p class="shop-desc">${esc(shop.description)}</p>` : ""}
          ${shopHoursHtml(shop.hours)}
          ${shop.phone ? `<div class="shop-phone"><span class="ms">call</span>${esc(shop.phone)}</div>` : ""}
        </div>
        <div class="shop-tabpanel" data-panel="menu" hidden>${shopMenuHtml(shop.menu)}</div>
      </div>`;
  }
  function bindShopTabs(root) {
    const tabs = root.querySelectorAll(".shop-tab");
    tabs.forEach(btn => {
      btn.onclick = () => {
        tabs.forEach(b => { b.classList.toggle("active", b === btn); b.setAttribute("aria-selected", b === btn ? "true" : "false"); });
        root.querySelectorAll(".shop-tabpanel").forEach(p => { p.hidden = p.dataset.panel !== btn.dataset.tab; });
      };
    });
  }
  // AR share deep-links into the Mattercraft/Zappar AR experience (share.navme.space),
  // mirroring the AR project's own navmePois.ts slugifyPoiShareName/buildPoiShareUrl
  // exactly (slug?p=<poiId>&x=<experienceRef>) so a link generated here opens the same
  // POI there. The experience ref itself is fetched live from the NavMe Dashboard's
  // navme_project_features.experience_ref (see app.js's window.WF.arExperienceRef,
  // populated from GET /api/v1/public/buildings/{slug}/ar-experience-ref) — null for
  // buildings with no published AR experience yet.
  function slugifyPoiShareName(name) {
    return (String(name || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(0, 64)) || "place";
  }
  function arShareUrlFor(poi) {
    if (!poi || poi.id == null) return null;
    const ref = window.WF && WF.arExperienceRef;
    if (!ref) return null;
    return `https://share.navme.space/${slugifyPoiShareName(poi.name)}?p=${encodeURIComponent(poi.id)}&x=${encodeURIComponent(ref)}`;
  }
  function selectPlace(p, o = {}) {
    S.place = p; S.mode = "place"; document.body.classList.remove("dir");
    $("q").value = p.name; $("btnClearQ").hidden = false;
    if (p.floor !== wf.currentFloor()) wf.setFloor(p.floor);
    markPlace(p);
    const shop = (window.WF.shopsByPoiId || {})[String(p.id)] || null;
    const c = cat(p), galleryUrls = poiGalleryUrls(p, shop, 8);
    setSheet(`
      <h1 class="pname">${esc(shop ? shop.name : p.name)}</h1>
      <div class="prow"><span>${esc(shop && shop.category ? shop.category : c.label)}</span><span class="badge floor"><span class="ms">layers</span>${esc(wf.floorLabel(p.floor))}</span>${sfBadge(p)}</div>
      <div class="actions actions-row1">
        <button class="pill primary pill-sm" id="pDir"><span class="ms fill">directions</span>${esc(t("viewer.directions"))}</button>
        <button class="pill pill-sm" id="p3d"><span class="ms">view_in_ar</span>${esc(isMpMode() ? (t("viewer.viewInAr") || "View in AR") : t("viewer.viewIn3d"))}</button>
        <button class="pill pill-sm pill-icon" id="pShare" aria-label="${esc(t("viewer.share"))}" title="${esc(t("viewer.share"))}"><span class="ms">share</span></button>
      </div>
      ${galleryUrls.length > 1 ? `<div class="photo-gallery" aria-label="${esc(t("viewer.photoOf", { name: p.name }))}">${galleryUrls.map((u, i) => `<img class="photo gallery-img" src="${esc(u)}" alt="${esc(i === 0 ? t("viewer.photoOf", { name: p.name }) : t("viewer.photoNear", { name: p.name }))}" loading="lazy" decoding="async">`).join("")}</div>`
        : galleryUrls.length === 1 ? `<img class="photo" src="${esc(galleryUrls[0])}" alt="${esc(t("viewer.photoOf", { name: p.name }))}" loading="lazy" decoding="async">` : ""}
      ${shop ? shopSectionHtml(shop) : ""}
      <ul class="facts">
        <li><span class="ms">location_on</span><div>${esc(wf.floorLabel(p.floor))}${p.code && p.code !== p.name ? " · " + esc(p.code) : ""}<div class="muted">${esc(WF.cfg.name || "")}${WF.cfg.address ? ", " + esc(WF.cfg.address) : ""}</div></div></li>
        <li><span class="ms">accessible</span><div>${p.step_free_from_parking ? esc(t("viewer.reachableStepFree")) : esc(t("viewer.routesIncludeSteps"))}<div class="muted">${esc(t("viewer.basedOnScan"))}</div></div></li>
        ${p.area_m2 ? `<li><span class="ms">square_foot</span><div>${Math.round(p.area_m2)} m² <span class="muted">(${Math.round(p.area_m2 * 10.764)} ft²)</span></div></li>` : ""}
        ${!shop && p.hours ? `<li><span class="ms">schedule</span><div>${esc(p.hours)}</div></li>` : ""}
        ${!shop && (p.description || p.note) ? `<li><span class="ms">info</span><div>${esc(p.description || p.note)}</div></li>` : ""}
      </ul>`, o.sheet || (isMpMode() ? "placeMp" : "half"));
    $("pDir").onclick = () => { S.to = p; S.from = wf.lastLoc ? "me" : defaultFrom(p); openDirections(); };
    $("pShare").onclick = share;
    if (shop) bindShopTabs($("sheetBody"));
    // ArcGIS's 3D fly-to needs the map view, which MP mode hides entirely (mp_background.js)
    // — the button used to silently no-op there. In MP mode, open the real Zappar/
    // Mattercraft AR experience for this POI instead (see arShareUrlFor) — falls back
    // to the old "locked" toast only for buildings with no published AR experience yet.
    $("p3d").onclick = isMpMode()
      ? () => {
          const url = arShareUrlFor(p);
          if (url) window.open(url, "_blank", "noopener");
          else toast(t("viewer.arLocked") || "AR navigation can't be started right now. Please try again shortly or continue using the map.");
        }
      : async () => { await toggle3D(true); flyTo3D(p); };
    // mp mode hides the ArcGIS view entirely (see mp_background.js) and POIs here carry
    // flat x/y/z, not the .model the ArcGIS 3D fly needs — flyTo3D would throw and abort
    // the rest of this function (including the Matterport focus below) before it runs.
    if (o.fly !== false && !isMpMode()) flyTo(p);
    if (isMpMode() && window.MpPreview && p.x != null) {
      // Fly the live, draggable Matterport background to this POI, facing its curated
      // "look here" direction — this IS the 360° view, no separate static photo needed.
      const face = (p.expected_x != null) ? { x: p.expected_x, y: p.expected_y, z: p.expected_z } : { x: p.x, y: p.y, z: p.z };
      window.MpPreview.focusAt({ x: p.x, y: p.y, z: p.z }, face);
    }
  }
  function markPlace(p) {
    S.uiLayer.removeAll();
    if (!p) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48"><path d="M18 1C8.6 1 1 8.4 1 17.6 1 30 18 47 18 47s17-17 17-29.4C35 8.4 27.4 1 18 1z" fill="#ea4335" stroke="#b31412" stroke-width="1.5"/><circle cx="18" cy="17.5" r="6.5" fill="#b31412"/></svg>`;
    S.uiLayer.add(new wf.esri.Graphic({ geometry: new wf.esri.Point({ longitude: p.lonlat[0], latitude: p.lonlat[1] }),
      symbol: { type: "picture-marker", url: "data:image/svg+xml;base64," + btoa(svg), width: 27, height: 36, yoffset: 18 } }));
  }
  function clearSelection() { S.place = null; markPlace(null); }
  function flyTo(p) {
    const v = wf.view();
    if (wf.is3D()) { flyTo3D(p); return; }
    v.goTo({ center: [p.lonlat[0], p.lonlat[1]], zoom: Math.max(v.zoom, 20.3) }, { duration: 900, easing: "ease-in-out" }).catch(() => { });
  }
  function flyTo3D(p) {
    const v = wf.getView3d(); if (!v) return;
    const z = wf.modelZtoAbs((p.model && p.model.z != null) ? p.model.z : 0);
    v.goTo({ target: new wf.esri.Point({ longitude: p.lonlat[0], latitude: p.lonlat[1], z }), tilt: 60, zoom: 20.5 }, { duration: 1200 }).catch(() => { });
  }

  // ---------------- home / building card ----------------
  function arrivalPoi() { return byId[WF.cfg.arrival_poi] || POIS.find(p => p.category === "parking") || mainEntrance(); }
  function mainEntrance() { return byId.poi_main_entrance || POIS.find(p => p.category === "entrance"); }
  function defaultFrom(p) { const a = arrivalPoi(); return a && a.id !== p.id ? a : (mainEntrance() !== p ? mainEntrance() : null); }
  function allBuildings() {
    if (WF.manifest && Array.isArray(WF.manifest.buildings) && WF.manifest.buildings.length)
      return WF.manifest.buildings;
    const cur = WF.building ? [WF.building] : [];
    return cur.concat(WF.others || []);
  }
  const buildingVenueNames = new Map();
  let buildingVenueNamesPromise = null;
  function buildingDisplayName(building) {
    return buildingVenueNames.get(building.slug) || building.name || building.slug;
  }
  function loadBuildingVenueNames() {
    if (buildingVenueNamesPromise) return buildingVenueNamesPromise;
    const base = ((window.WF_CONFIG && WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
    buildingVenueNamesPromise = Promise.all(allBuildings().map(async building => {
      try {
        const response = await fetch(base + "buildings/" + encodeURIComponent(building.slug) + "/venue-info");
        if (!response.ok) return;
        const info = await response.json();
        if (info && info.building_slug === building.slug && typeof info.name === "string" && info.name.trim()) {
          buildingVenueNames.set(building.slug, info.name.trim());
        }
      } catch (_) { /* The manifest name remains the safe fallback. */ }
    })).then(() => {
      if (S.mode === "home" && S.uxMode === "buildings" && !$("sheet").hidden) {
        showBuildingPicker($("q").value);
      }
    });
    return buildingVenueNamesPromise;
  }

  function isMobileUx() { return window.innerWidth < 700; }
  function currentBuildingMeta() {
    const slug = (WF.building && WF.building.slug) || pageQuery().get("b") || "";
    const b = allBuildings().find(x => x.slug === slug) || WF.building || { name: WF.cfg && WF.cfg.name, address: WF.cfg && WF.cfg.address, slug, floors: (WF.cfg && WF.cfg.floors) || [] };
    return b;
  }
  function setUxMode(mode, opts) {
    opts = opts || {};
    S.uxMode = mode === "places" ? "places" : "buildings";
    const box = $("searchBox"); if (box) box.dataset.ux = S.uxMode;
    const q = $("q");
    const chip = $("bldgChip");
    const dirBtn = $("btnDirQuick");
    const meta = currentBuildingMeta();
    if ($("bldgChipName")) $("bldgChipName").textContent = meta ? buildingDisplayName(meta) : "Building";
    if ($("bldgChipSub")) {
      const floors = meta && meta.floors ? (Array.isArray(meta.floors) ? meta.floors.length : meta.floors) : (WF.cfg && WF.cfg.floors && WF.cfg.floors.length);
      $("bldgChipSub").textContent = floors ? t("viewer.floorsShort", { n: floors }) : "";
    }
    if (chip) {
      chip.hidden = S.uxMode !== "places";
      chip.setAttribute("aria-expanded", S.uxMode === "buildings" ? "true" : "false");
    }
    if (dirBtn) dirBtn.hidden = S.uxMode !== "places";
    if (q) {
      if (S.uxMode === "buildings") {
        q.placeholder = t("viewer.searchPlacesOrVenues") || "Search places or venues";
        q.setAttribute("aria-label", t("viewer.searchPlacesOrVenues") || "Search places or venues");
        if (!opts.keepQuery) q.value = "";
      } else {
        q.placeholder = (isMobileUx() ? (t("viewer.searchDestPlaceholder") || t("viewer.searchPlaceholder") || "Where to?") : (t("viewer.searchPlaceholder") || "Search rooms, halls, entrances…"));
        q.setAttribute("aria-label", t("viewer.searchAria") || "Search places in this building");
        // Clear only when leaving the building picker, so picking a place keeps its name in the bar.
        if (!opts.keepQuery && document.body.classList.contains("ux-buildings")) q.value = "";
      }
      $("btnClearQ").hidden = !q.value;
    }
    document.body.classList.toggle("ux-buildings", S.uxMode === "buildings");
    document.body.classList.toggle("ux-places", S.uxMode === "places");
  }
  function enterBuilding(slug) {
    const cur = (WF.building && WF.building.slug) || pageQuery().get("b");
    if (slug && slug !== cur) { goBuilding(slug); return; }
    setUxMode("places");
    if ($("q")) { $("q").value = ""; $("btnClearQ").hidden = true; }
    showBuildingHome();
    zoomBuilding();
    try { $("q").focus(); } catch (e) {}
  }
  function buildingCardsHtml(filterTxt) {
    const q = (filterTxt || "").trim().toLowerCase();
    let buildings = allBuildings();
    if (q) buildings = buildings.filter(b => (buildingDisplayName(b) + " " + (b.address || "") + " " + (b.slug || "")).toLowerCase().includes(q));
    const curSlug = (WF.building && WF.building.slug) || pageQuery().get("b") || "";
    if (!buildings.length) return `<div class="muted" style="padding:12px 4px">${esc(t("viewer.noMatches", { q: filterTxt || "" }))}</div>`;
    return `<div class="bgal">` + buildings.map(b => {
      const isCur = b.slug === curSlug;
      const floors = (b.floors && b.floors.length) ? t("viewer.floorsShort", { n: b.floors.length }) : "";
      return `<article class="bcard${isCur ? " current" : ""}" data-bslug="${esc(b.slug)}" tabindex="0" role="button" aria-current="${isCur ? "page" : "false"}">
        <div class="thumb"><span class="ms fill">apartment</span></div>
        <div class="meta"><div class="name">${esc(buildingDisplayName(b))}</div>
          ${b.address ? `<div class="addr">${esc(b.address)}</div>` : ""}
          <div class="tags">${floors ? `<span class="tag">${esc(floors)}</span>` : ""}${isCur ? `<span class="tag on">${esc(t("viewer.currentBuilding"))}</span>` : `<span class="tag">${esc(t("viewer.openBuilding") || "Open")}</span>`}</div></div>
        <span class="ms go">chevron_right</span></article>`;
    }).join("") + `</div>`;
  }
  function bindBuildingCards() {
    document.querySelectorAll(".bcard[data-bslug]").forEach(card => {
      const go = () => enterBuilding(card.getAttribute("data-bslug"));
      card.onclick = go;
      card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
  }
  function showBuildingPicker(filterTxt) {
    S.mode = "home"; document.body.classList.remove("dir");
    setUxMode("buildings", { keepQuery: !!filterTxt });
    setSheet(`
      <div class="navme-hero"><img src="img/navme-logo.png" alt="NavMe" width="64" height="64">
        <div><div class="prod">NavMe</div><div class="tag">${esc(t("viewer.chooseBuildingHint") || "All buildings available in NavMe")}</div></div></div>
      <div class="pophead sm">${esc(t("viewer.chooseBuilding"))}</div>
      ${buildingCardsHtml(filterTxt)}`, isMobileUx() ? "half" : "half");
    bindBuildingCards();
    void loadBuildingVenueNames();
  }
  function currentVenueInfo() {
    const info = window.WFVenueInfo && window.WFVenueInfo.get();
    const slug = (WF.building && WF.building.slug) || WF.cfg.slug;
    return info && info.building_slug === slug ? info : { name: WF.cfg.name || (WF.building && WF.building.name) || "Venue information", address: WF.cfg.address || "", description: WF.cfg.description || "" };
  }
  let exploreController = null, exploreVenue = null;
  function venueSlug() { return (WF.building && WF.building.slug) || WF.cfg.slug; }
  function exploreText(key, fallback) { const value = t(key); return value && value !== key ? value : fallback; }
  function ensureExplore() {
    if (!exploreController && window.WFExplore) exploreController = WFExplore.create({
      fetchData: async slug => {
        const base = ((window.WF_CONFIG && WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
        const response = await fetch(base + "buildings/" + encodeURIComponent(slug) + "/explore", {cache: "no-cache"});
        if (!response.ok) throw new Error("Explore unavailable");
        return response.json();
      },
      apply: () => {
        if (S.mode === "home" && $("venueTabPanel")) renderVenueTab();
        if (S.mode === "place" && S.place) selectPlace(S.place, { fly: false, sheet: $("sheet").dataset.state || "half" });
      }
    });
    if (exploreController) void exploreController.load(venueSlug());
  }
  function venueMessage(title, body, retry) {
    return `<div class="venue-message" role="status"><h2>${esc(title)}</h2><p class="muted">${esc(body)}</p>${retry ? `<button type="button" class="pill" id="exploreRetry">${esc(exploreText("common.tryAgain", "Try Again"))}</button>` : ""}</div>`;
  }
  function renderVenueTab() {
    const panel = $("venueTabPanel"); if (!panel || S.mode !== "home") return;
    const slug = venueSlug(), tab = S.venueTab || "explore", info = currentVenueInfo();
    $("sheetBody").querySelectorAll("[data-venue-tab]").forEach(button => {
      const active = button.dataset.venueTab === tab;
      button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", "venueTab-" + tab);
    const scroll = $("sheetBody").scrollTop;
    if (tab === "about") {
      panel.innerHTML = `<div class="venue-about"><p data-venue-description ${info.description ? "" : "hidden"}>${esc(info.description)}</p>
        ${info.address ? `<div class="venue-fact"><span class="ms" aria-hidden="true">location_on</span><span data-venue-address>${esc(info.address)}</span></div>` : ""}
        <div class="actions">${mainEntrance() ? `<button class="pill primary" id="hEnt"><span class="ms fill">directions</span>${esc(t("viewer.goMainEntrance"))}</button>` : ""}
        <button type="button" class="pill" id="venueLicenses"><span class="ms" aria-hidden="true">info</span>${esc(t("viewer.aboutTitle"))}</button></div></div>`;
      if ($("hEnt")) $("hEnt").onclick = () => { S.to = mainEntrance(); S.from = wf.lastLoc ? "me" : arrivalPoi(); openDirections(); };
      $("venueLicenses").onclick = about;
    } else {
      const state = exploreController && exploreController.get();
      if (!state || state.venue !== slug || state.status === "loading") {
        panel.innerHTML = `<div class="venue-message" role="status">${esc(exploreText("viewer.loadingPlaces", "Loading places…"))}</div>`;
      } else if (state.status === "error") {
        panel.innerHTML = venueMessage(exploreText("viewer.exploreErrorTitle", "Couldn't load places"), exploreText("viewer.exploreErrorBody", "We're having trouble showing places right now. Please try again."), true);
      } else if (tab === "facilities") {
        const facilities = state.data.facilities || [];
        panel.innerHTML = facilities.length ? `<ul class="venue-facilities">${facilities.map(f => `<li><span class="ms" aria-hidden="true">${esc(LUCIDE_TO_MS[f.icon_key] || "info")}</span><div><strong>${esc(f.facility_name)}</strong>${f.facility_category ? `<div class="muted">${esc(f.facility_category)}</div>` : ""}${f.floor_name ? `<span class="explore-floor">${esc(f.floor_name)}</span>` : ""}</div></li>`).join("")}</ul>`
          : venueMessage(exploreText("viewer.noFacilitiesTitle", "No facilities listed"), exploreText("viewer.noFacilitiesBody", "There are no facilities listed here yet."));
      } else {
        const cards = WFExplore.cards(POIS, state.data, {venue: slug, venueName: info.name,
          thumbnail: thumbFor, shops: WF.shopsByPoiId || {}, localize: localized});
        const categoryOrder = (wf.categories || []).map(category => ({
          key: String(category.name || "").trim().toLowerCase(),
          label: localized(category.names, category.name)
        }));
        const featured = WFExplore.featured(cards, categoryOrder);
        panel.innerHTML = featured.length ? WFExplore.gridHtml(featured, {floorUnavailable: exploreText("viewer.floorUnavailable", "Floor not listed")})
          : venueMessage(exploreText("viewer.noPlacesTitle", "No places available"), exploreText("viewer.noPlacesBody", "There are no places to explore here yet."));
        panel.querySelectorAll("[data-explore-poi]").forEach(button => { button.onclick = () => {
          const poi = byId[button.dataset.explorePoi]; if (poi) selectPlace(poi, {fly: true});
        }; });
        panel.querySelectorAll(".explore-photo img").forEach(image => {
          image.addEventListener("error", () => { image.hidden = true; }, {once: true});
          if (image.complete && !image.naturalWidth) image.hidden = true;
        });
      }
      if ($("exploreRetry")) $("exploreRetry").onclick = () => { void exploreController.load(slug, true); };
    }
    $("sheetBody").scrollTop = scroll;
  }
  function showBuildingHome() {
    S.mode = "home"; document.body.classList.remove("dir");
    setUxMode("places");
    const slug = venueSlug(), info = currentVenueInfo();
    if (exploreVenue !== slug) { exploreVenue = slug; S.venueTab = "explore"; }
    setSheet(`<section class="venue-panel">
      <div class="venue-header"><span class="ms fill blue venue-icon" aria-hidden="true">${esc((WF.cfg.branding && WF.cfg.branding.icon) || "apartment")}</span>
        <div><h1 class="pname" data-venue-title>${esc(info.name)}</h1><div class="muted" data-venue-address ${info.address ? "" : "hidden"}>${esc(info.address)}</div></div></div>
      <div class="venue-tabs" role="tablist" aria-label="${esc(exploreText("viewer.venueInformation", "Venue information"))}">
        ${[["explore", t("viewer.explore")], ["about", exploreText("viewer.aboutTab", "About")], ["facilities", exploreText("viewer.facilitiesTab", "Facilities")]].map(([id, label]) => `<button type="button" id="venueTab-${id}" data-venue-tab="${id}" role="tab" aria-controls="venueTabPanel">${esc(label)}</button>`).join("")}
      </div><div id="venueTabPanel" class="venue-tabpanel" role="tabpanel"></div></section>`, "half");
    const tabs = [...$("sheetBody").querySelectorAll("[data-venue-tab]")];
    tabs.forEach((button, index) => {
      button.onclick = () => { S.venueTab = button.dataset.venueTab; renderVenueTab(); $("sheetBody").scrollTop = 0; };
      button.onkeydown = event => {
        let next = null;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next !== null) { event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
      };
    });
    renderVenueTab(); ensureExplore();
  }
  function showHome() {
    // Mobile open: building gallery. Deep links / desk: places for current building.
    const q = pageQuery();
    const deep = !!(q.get("to") || q.get("from") || q.get("me") || q.get("mode") === "dir");
    if (isMobileUx() && !deep && S.uxMode !== "places") showBuildingPicker();
    else showBuildingHome();
  }
  function buildingSwitcherHtml(opts) {
    opts = opts || {};
    return buildingCardsHtml();
  }
  function navmeHomeHeader() {
    return `<div class="navme-hero"><img src="img/navme-logo.png" alt="NavMe" width="64" height="64">
      <div><div class="prod">${esc(t("viewer.productName") || "NavMe")}</div>
      <div class="tag">${esc(t("viewer.chooseBuildingHint") || "")}</div></div></div>`;
  }
  function bindBuildingSwitcher() { bindBuildingCards(); }

  function zoomBuilding(instant) {
    const cs = POIS.filter(p => p.room_id).map(p => p.lonlat);
    fitLonLat(cs, isDesk() ? 1.35 : 1.0, instant);
  }
  function fitLonLat(pts, expand, instant) {
    if (!pts.length) return;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys); const pad = 0.00012;
    const ext = { xmin: Math.min(...xs) - pad, xmax: Math.max(...xs) + pad, ymin: Math.min(...ys) - pad, ymax: Math.max(...ys) + pad, spatialReference: { wkid: 4326 } };
    const v = wf.view();
    const E = new wf.esri.Extent(ext).expand(expand || 1.3);
    if (wf.is3D()) v.goTo({ target: E, tilt: 50 }, { duration: instant ? 0 : 900 }).catch(() => { });
    else v.goTo(E, { animate: !instant, duration: 900 }).catch(() => { });
  }

  // ---------------- directions ----------------
  function bindDirections() {
    // Starting points are map-picked for now. Do not advertise GPS/photo location
    // in autocomplete while those acquisition methods are intentionally disabled.
    const noLocationOption = () => [];
    acKeys($("fromQ"), noLocationOption); acKeys($("toQ"), noLocationOption);
    $("btnDirBack").onclick = closeDirections;
    if ($("btnDirX")) $("btnDirX").onclick = closeDirections;
    $("btnSwap").onclick = () => { const tmp = S.from; S.from = S.to; S.to = tmp; if (S.from !== "me") S.locMeta = null; syncDirFields(); computeRoute(); };
    document.querySelectorAll(".mode").forEach(b => b.onclick = () => { S.stepFree = b.dataset.mode === "stepfree"; syncDirFields(); computeRoute(); });
    if ($("btnLocateMe")) $("btnLocateMe").onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      isMpMode() ? pickOnMapMp() : startLocalize(true);
    };
    if ($("fromNotRight")) $("fromNotRight").onclick = () => { S.locMeta = null; syncDirFields(); startLocalize(S.mode === "dir"); };
    bindLocateChooser();
    bindLocateModal();
  }
  function nameOf(x) {
    if (x === "me") return (S.locMeta && S.locMeta.label) || t("viewer.currentLocation");
    return x ? x.name : "";
  }
  function directionFieldLabel(x) {
    const name = nameOf(x);
    if (!x || x === "me") return name;
    const building = cat(x) && cat(x).label;
    return building && String(building).trim().toLowerCase() !== String(name).trim().toLowerCase()
      ? `${name} · ${building}` : name;
  }
  function syncDirFields() {
    $("fromQ").value = directionFieldLabel(S.from); $("toQ").value = directionFieldLabel(S.to);
    document.querySelectorAll(".mode").forEach(b => { const on = (b.dataset.mode === "stepfree") === S.stepFree; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
    renderFromMeta();
  }
  function renderFromMeta() {
    const meta = $("fromMeta"), chip = $("fromAcc");
    if (!meta || !chip) return;
    if (S.from !== "me" || !S.locMeta) { meta.hidden = true; return; }
    meta.hidden = false;
    const m = S.locMeta;
    chip.className = "acc-chip" + (m.source === "vps" ? " vps" : (m.accuracy != null && m.accuracy > 40 ? " poor" : ""));
    if (m.source === "vps") chip.textContent = m.confidence != null ? t("viewer.accVps", { conf: Math.round(m.confidence * 100) }) : t("viewer.accVpsSimple");
    else if (m.accuracy != null) chip.textContent = t("viewer.accGps", { m: Math.round(m.accuracy) });
    else chip.textContent = t("viewer.accMap");
  }
  function bindDirFieldFocus() {
    const mark = (which) => {
      S.dirFocus = which;
      const fw = document.getElementById("fromField") || $("fromQ") && $("fromQ").closest(".field");
      const tw = document.getElementById("toField") || $("toQ") && $("toQ").closest(".field");
      document.querySelectorAll(".dir-focus").forEach(el => el.classList.remove("dir-focus"));
      const el = which === "from" ? ($("fromQ") && $("fromQ").closest(".field,label,.row")) : ($("toQ") && $("toQ").closest(".field,label,.row"));
      if (el) el.classList.add("dir-focus");
      if ($("fromQ")) $("fromQ").classList.toggle("dir-focus-input", which === "from");
      if ($("toQ")) $("toQ").classList.toggle("dir-focus-input", which === "to");
    };
    if ($("fromQ")) {
      $("fromQ").addEventListener("focus", () => mark("from"));
      $("fromQ").addEventListener("click", () => mark("from"));
    }
    if ($("toQ")) {
      $("toQ").addEventListener("focus", () => mark("to"));
      $("toQ").addEventListener("click", () => mark("to"));
    }
  }
  bindDirFieldFocus();

  function applyPoiToDir(p) {
    if (!p) return;
    const which = S.dirFocus === "from" ? "from" : "to";
    if (which === "from") {
      S.from = p;
      S.locMeta = null;
      syncDirFields();
      computeRoute();
      mpFocusSelection("from");
      toast("From · " + p.name);
      if (!S.to) {
        S.dirFocus = "to";
        try { $("toQ").focus(); } catch (e) { }
      }
    } else {
      S.to = p;
      syncDirFields();
      computeRoute();
      mpFocusSelection("to");
      toast("To · " + p.name);
    }
  }

    function openDirections(startNav) {
    setUxMode("places");
    S.mode = "dir"; document.body.classList.add("dir");
    $("searchBox").hidden = true; $("dirBox").hidden = false; closeAc();
    syncDirFields(); applyPadding();
    if (!S.to) { setSheet(`<div class="muted" style="padding:8px 0">${esc(t("viewer.chooseDestination"))}</div>`, "peek"); S.dirFocus = "to"; try { $("toQ").classList.add("dir-focus-input"); $("fromQ").classList.remove("dir-focus-input"); } catch (e) {} $("toQ").focus(); closeSheet(); if ($("acList").hidden) $("toQ").click(); return; }
    if (!S.from) {
      // MP mode: no 2D map to tap, but "Pick on map" still exists there as a dollhouse
      // pick-and-walk (see pickOnMapMp()) — and GPS has real meaning (on-site visitor).
      setSheet(`<div class="muted" style="padding:8px 0">${esc(t("viewer.pickOnMap"))}</div>
        <div class="actions">
          <button class="pill primary" id="dSetMe"><span class="ms">touch_app</span>${esc(t("viewer.pickOnMap"))}</button>
        </div>`, "peek");
      if ($("dSetMe")) $("dSetMe").onclick = () => isMpMode() ? pickOnMapMp() : startLocalize(true);
      S.dirFocus = "from";
      try { $("fromQ").classList.add("dir-focus-input"); $("toQ").classList.remove("dir-focus-input"); } catch (e) {}
      $("fromQ").focus(); closeSheet(); if ($("acList").hidden) $("fromQ").click(); return;
    }
    computeRoute(startNav);
  }
  function closeDirections() {
    S.route = null; wf.clearRoute(); document.body.classList.remove("dir");
    $("searchBox").hidden = false; $("dirBox").hidden = true; closeAc();
    if (S.place) selectPlace(S.place, { fly: false }); else showHome();
    applyPadding();
  }
  let pendingNav = false;
  function computeRoute(startNav) {
    if (!S.from || !S.to) return;
    pendingNav = !!startNav;
    if (S.from === "me" && !wf.lastLoc) {
      setSheet(`<div class="warn"><span class="ms">my_location</span><div><strong>${esc(t("viewer.locNotSetTitle"))}</strong><br>${esc(t("viewer.locNotSet"))}</div></div>
        <div class="actions">
          <button class="pill primary" id="dSetMe"><span class="ms">touch_app</span>${esc(t("viewer.pickOnMap"))}</button>
          ${isMpMode() ? "" : `<button class="pill" id="dUseEnt"><span class="ms">door_open</span>${esc(t("viewer.startAtEntrance"))}</button>`}
        </div>`, "peek");
      if ($("dSetMe")) $("dSetMe").onclick = () => isMpMode() ? pickOnMapMp() : startLocalize(true);
      if ($("dUseEnt")) $("dUseEnt").onclick = () => { S.from = mainEntrance() || byId.poi_main_entrance; S.locMeta = null; syncDirFields(); computeRoute(startNav); };
      return;
    }
    const fromKey = S.from === "me" ? "__loc" : S.from.id;
    const to = S.to === "me" ? null : S.to;
    if (!to) { toast(t("viewer.pickDestination")); return; }
    wf.route(fromKey, to.id, { stepFree: S.stepFree, noZoom: false });
  }
  function onRoute(r, msg) {
    if (S.mode !== "dir" && S.mode !== "nav") return;   // routes triggered from the dev panel
    if (!r) {
      S.route = null;
      setSheet(`<div class="warn"><span class="ms">${S.stepFree ? "accessible" : "wrong_location"}</span><div><strong>${esc(t(S.stepFree ? "viewer.noRouteStepFreeTitle" : "viewer.noRouteTitle"))}</strong><br>${esc(S.stepFree ? t("viewer.noRouteStepFree") : (msg || t("viewer.noRoute")))}${S.stepFree ? "<br><br>Walking may include stairs." : ""}</div></div>
        ${S.stepFree ? `<div class="actions"><button class="pill primary" id="dWalk"><span class="ms">directions_walk</span>${esc(t("viewer.showWalking"))}</button></div>` : ""}`, "peek");
      if ($("dWalk")) $("dWalk").onclick = () => { S.stepFree = false; syncDirFields(); computeRoute(); };
      return;
    }
    S.route = r; S.navSteps = condense(r);
    markPlace(null);
    renderDirections(r);
    // mp=1 deliberately skips nav_graph.json at startup. Fetch only the compact
    // sweep coordinates already resident in Matterport, then repaint this same
    // route so nearest-sweep thumbnails appear without restoring the heavy graph.
    if (isMpMode() && window.MpPreview && MpPreview.thumbnailSweepNodes
        && (!wf.nav.nodes || !wf.nav.nodes.some(n => n.kind === "sweep"))) {
      const activeRoute = r;
      MpPreview.thumbnailSweepNodes().then(nodes => {
        if (!nodes || !nodes.length || S.route !== activeRoute) return;
        wf.nav.nodes = nodes;
        renderDirections(activeRoute);
      }).catch(() => {});
    }
    if (pendingNav) { pendingNav = false; startNav(); }
  }
  /** S.route plus the extra fields MpPreview's tour/walk engine wants: destination name,
   *  the turn-by-turn instruction list (for matching instruction text), and the curated
   *  "look here" destination anchor (expected_x/y/z, falling back to the POI's own xyz). */
  function mpRoutePayload() {
    return Object.assign({}, S.route, {
      _destName: S.to && S.to.name ? S.to.name : null,
      _fromName: S.from === "me" ? "Your Location" : (S.from && S.from.name ? S.from.name : null),
      _navSteps: S.navSteps,
      _destXYZ: (S.to && S.to !== "me" && S.to.expected_x != null) ? { x: S.to.expected_x, y: S.to.expected_y, z: S.to.expected_z }
        : (S.to && S.to !== "me" && S.to.x != null) ? { x: S.to.x, y: S.to.y, z: S.to.z != null ? S.to.z : 0 } : null
    });
  }
  function condense(r) {
    // merge "Walk N m" into the following action -> [{type, text, icon, dist, pt, toFloor}]
    const out = []; let acc = 0;
    r.instructions.forEach(i => {
      if (i.type === "walk") { acc += i.dist || 0; return; }
      if (i.type === "start") { out.push({ ...i, icon: "trip_origin", dist: 0 }); return; }
      out.push({ ...i, icon: iconFor(i), dist: acc }); acc = 0;
    });
    return out;
  }
  function iconFor(i) {
    if (i.type === "turn") return { left: "turn_left", right: "turn_right", "slight-left": "turn_slight_left", "slight-right": "turn_slight_right", uturn: "u_turn_left" }[i.dir] || "straight";
    if (i.type === "stairs") return /\bup\b/.test(i.text) ? "stairs_2" : "stairs";
    if (i.type === "elevator") return "elevator";
    if (i.type === "level") return /\bup\b/.test(i.text) ? "trending_up" : "trending_down";
    if (i.type === "door") return /Enter|Exit/.test(i.text) ? "door_open" : "door_front";
    if (i.type === "arrive") return "location_on";
    return "straight";
  }
  const fmtDist = (m) => m < 1 ? "" : m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
  const fmtMin = (s) => s < 30 ? "<1 min" : Math.max(1, Math.round(s / 60)) + " min";
  function floorSegments(r) {
    const segs = [];
    r.legs.forEach(l => {
      let d = 0; for (let k = 1; k < l.points.length; k++) d += Math.hypot(l.points[k].x - l.points[k - 1].x, l.points[k].y - l.points[k - 1].y, l.points[k].z - l.points[k - 1].z);
      const key = l.transition ? "T" : (l.outdoor ? "OUT" : l.floor);
      const last = segs[segs.length - 1];
      if (last && last.key === key) last.d += d; else segs.push({ key, d, floor: l.floor, toFloor: l.toFloor });
    });
    return segs.filter(s => s.d > 0.5);
  }
  function nearestSweep(pt) {
    // The route result's own nodes are the routing graph's door/room waypoints — a path
    // rarely passes through a node literally tagged kind:"sweep". The real sweep positions
    // (990 of them here) live on the full nav graph, so search that instead.
    let best = null, bd = 1e9;
    ((wf.nav && wf.nav.nodes) || S.route.nodes || []).forEach(n => { if (n.kind !== "sweep") return; const d = Math.hypot(n.x - pt.x, n.y - pt.y) + (n.floor === pt.floor ? 0 : 3); if (d < bd) { bd = d; best = n; } });
    return best;
  }
  
  /** Mobile / WebXR "Start AR" – opens /ar_webxr with building slug + destination. */
  function wireStartArButton(btn) {
    if (!btn) return;
    if (!window.WFAR) { btn.hidden = true; return; }
    WFAR.capability().then(cap => { btn.hidden = !WFAR.shouldShowButton(cap); }).catch(() => { btn.hidden = true; });
    btn.onclick = () => {
      if (!S.to) return;
      const slug = (window.WF && WF.building && WF.building.slug)
        || pageQuery().get("b") || "";
      const me = (wf && wf.lastLoc)
        ? [wf.lastLoc.lon, wf.lastLoc.lat, wf.lastLoc.floor]
        : undefined;
      WFAR.start({
        to: S.to.id,
        mode: S.stepFree ? "stepfree" : "walk",
        me,
        b: slug || undefined,
        returnUrl: location.href
      });
    };
  }


  function accessFlags() {
    const cfg = (window.WF && WF.cfg) || {};
    if (window.WFAccess && WFAccess.viewerFlags) return WFAccess.viewerFlags(cfg);
    const a = cfg.access || {};
    const twin = a.twin || "public";
    const tourPublic = a.tour_public !== false;
    return {
      twin,
      twin_disabled: twin === "disabled",
      twin_pin_required: twin === "pin",
      tour_public: tourPublic,
      embed_tour_allowed: twin !== "disabled" && (twin === "pin" || tourPublic)
    };
  }

  function tourModeFlags() {
    const cfg = (window.WF && WF.cfg) || {};
    let flags;
    if (window.WFTourModes && WFTourModes.viewerFlags) flags = WFTourModes.viewerFlags(cfg);
    else {
      const tm = cfg.tour_modes || {};
      const hasGlb = cfg.has_glb === true || !!(cfg.files && (cfg.files.model_glb || cfg.files.glb));
      flags = {
        embed_showcase: tm.embed_showcase !== false,
        mesh_tour: !!tm.mesh_tour && hasGlb,
        mesh_tour_enabled: !!tm.mesh_tour,
        has_glb: hasGlb,
        bundle_scene: !!tm.bundle_scene,
        bundle_available: !!tm.bundle_scene && !!(tm.bundle_url || tm.bundle_configured),
        bundle_configured: !!(tm.bundle_url || tm.bundle_configured)
      };
    }
    const acc = accessFlags();
    // Access twin gate: hide Embed Tour when disabled or tour_public=false (pin still shows button → prompt)
    if (!acc.embed_tour_allowed && !acc.twin_pin_required) {
      flags = Object.assign({}, flags, { embed_showcase: false });
    }
    if (acc.twin_disabled) {
      flags = Object.assign({}, flags, { embed_showcase: false });
    }
    flags.access = acc;
    return flags;
  }

  function openMeshTourFromDirections() {
    if (!S.route || !S.to) return;
    if (!window.WFAR) {
      toast(t("viewer.meshTourUnavailable"));
      return;
    }
    const slug = (window.WF && WF.building && WF.building.slug)
      || (window.WF && WF.cfg && WF.cfg.slug)
      || pageQuery().get("b") || "";
    const fromId = (S.from && S.from !== "me" && S.from.id) ? S.from.id : "";
    let fromModel;
    const start = (S.route.smoothed && S.route.smoothed[0])
      || (S.route.nodes && S.route.nodes[0])
      || null;
    if (start && (start.x != null)) {
      fromModel = [start.x, start.y, start.z != null ? start.z : 0, start.floor || ""];
    }
    WFAR.start({
      meshTour: true,
      to: S.to.id,
      from: fromId || undefined,
      fromModel: fromId ? undefined : fromModel,
      mode: S.stepFree ? "stepfree" : "walk",
      b: slug || undefined,
      returnUrl: location.href
    });
  }

  function renderDirections(r) {
    const floors = [...new Set(r.nodes.filter(n => n.kind !== "osm").map(n => n.floor))];
    const segs = floorSegments(r);
    const segHtml = segs.map(s => {
      if (s.key === "T") return `<span class="seg"><span class="ms">elevator</span>${esc(t("viewer.floorChange", { floor: wf.floorLabel(s.toFloor) }))}</span>`;
      const ic = s.key === "OUT" ? "park" : "layers", name = s.key === "OUT" ? t("viewer.outdoors") : wf.floorLabel(s.key);
      return `<span class="seg" title="${Math.round(s.d)} m"><span class="ms">${ic}</span>${esc(name)} · ${fmtMin(s.d / 1.2)}</span>`;
    }).join('<span class="ms" style="font-size:16px;color:var(--txt2)" aria-hidden="true">chevron_right</span>');
    const steps = S.navSteps.map((s, i) => {
      let extra = "";
      if (s.type === "stairs" || s.type === "level" || s.type === "elevator") {
        const sw = s.pt ? nearestSweep(s.pt) : null, th = sw && thumbFor(sw.id);
        const ic = s.type === "elevator" ? "elevator" : "stairs";
        const alt = s.type === "elevator" ? t("viewer.viewAtElevator") : t("viewer.viewAtStairs");
        const title = s.type === "elevator"
          ? (s.toFloor ? t("viewer.toFloor", { floor: wf.floorLabel(s.toFloor) }).replace(/^\s*/, "") || wf.floorLabel(s.toFloor) : t("viewer.catElevator"))
          : `${/\bup\b/.test(s.text) ? t("viewer.up") : t("viewer.down")}${s.toFloor && s.toFloor !== (s.pt && s.pt.floor) ? t("viewer.toFloor", { floor: wf.floorLabel(s.toFloor) }) : ""}`;
        extra = `<div class="fcard">${th ? `<img src="${th}" alt="${esc(alt)}">` : `<span class="ms">${ic}</span>`}<div><b>${s.type === "elevator" ? esc(t("viewer.catElevator")) + (s.toFloor ? esc(t("viewer.toFloor", { floor: wf.floorLabel(s.toFloor) })) : "") : esc(title)}</b><div class="muted">${esc(s.text.replace(/^Take (the )?/, ""))}</div></div></div>`;
      } else {
        // Plain turn/straight/arrive steps: same nearestSweep + thumbFor lookup as
        // above, just without the stairs/elevator title card — a photo only when one
        // actually exists for that scan point (most mid-corridor turns won't have one;
        // thumbnails are only generated at POI and stair sweeps, see steps/thumbs.py).
        // Routing/navigation logic is untouched — this only adds a display, same as
        // the stairs/elevator case already did.
        const sw = s.pt ? nearestSweep(s.pt) : null, th = sw && thumbFor(sw.id);
        if (th) {
          extra = `<div class="fcard plain"><img src="${th}" alt="${esc(t("viewer.viewAtTurn") || "View at this turn")}" loading="lazy"></div>`;
        }
      }
      return `<li class="${s.type}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(t("viewer.stepN", { n: i + 1, text: s.text }))}${s.dist > 0.5 ? esc(t("viewer.afterMetres", { m: Math.round(s.dist) })) : ""}"><span class="si"><span class="ms ${s.type === "arrive" ? "fill" : ""}">${s.icon}</span></span>
        <div class="step-body"><div class="step-copy"><div class="st1">${esc(s.text)}</div>${s.dist > 0.5 ? `<div class="st2">${fmtDist(s.dist)}</div>` : ""}</div>${extra}</div></li>`;
    }).join("");
    const tm = tourModeFlags();
    const bundleBtn = tm.bundle_scene
      ? (tm.bundle_available
        ? `<button class="pill" id="dBundle"><span class="ms">apartment</span>${esc(t("viewer.bundleScene") || "Bundle scene")}</button>`
        : `<button class="pill" id="dBundle" disabled title="${esc(t("viewer.bundleUnavailable") || "Bundle not configured")}"><span class="ms">apartment</span>${esc(t("viewer.bundleScene") || "Bundle scene")}</button>`)
      : "";
    setSheet(`
      <div class="route-head">
        <div class="sum"><span class="big ${r.stairs_rise_m > 0 ? "st" : ""}">${fmtMin(r.time_s)}</span><span class="muted">(${fmtDist(r.total_m)})</span>
          ${r.stairs_rise_m > 0 ? `<span class="badge st"><span class="ms">stairs</span>${esc(t("viewer.stairsRise", { m: r.stairs_rise_m.toFixed(1) }))}</span>` : `<span class="badge sf"><span class="ms">accessible</span>${esc(t("viewer.stepFreeBadge"))}</span>`}
          ${floors.length > 1 ? `<span class="badge floor"><span class="ms">layers</span>${esc(t("viewer.floorsCount", { n: floors.length }))}</span>` : ""}</div>
        <button class="route-share" id="dShare" aria-label="${esc(t("viewer.share"))}" title="${esc(t("viewer.share"))}"><span class="ms">share</span></button>
      </div>
      <div class="muted">${esc(nameOf(S.from))} → ${esc(nameOf(S.to))}${r.warn ? " · " + esc(r.warn) : ""}</div>
      <div class="segs" aria-label="${esc(t("viewer.timePerFloor"))}">${segHtml}</div>
      <div class="actions actions-row1 route-actions-primary">
        ${tm.embed_showcase ? `<button class="pill primary pill-sm" id="dTourMp"><span class="ms">play_circle</span>${esc(t("viewer.tourInterior") || "Preview")}</button>` : ""}
        <button class="pill ${tm.embed_showcase ? "" : "primary"} pill-sm" id="dStart"><span class="ms fill">navigation</span>${esc(isMpMode() ? (t("viewer.startPreview") || "Walkthrough") : t("viewer.start"))}</button>
        ${isMpMode() ? "" : `<button class="pill pill-sm" id="dPrev3d"><span class="ms">3d_rotation</span>${esc(t("viewer.preview3d"))}</button>`}
        ${isMpMode() ? `<button class="pill pill-sm route-action-wide" id="dViewAr"><span class="ms">view_in_ar</span>${esc(t("viewer.viewInAr") || "View in AR")}</button>` : ""}
      </div>
      <div class="actions route-actions-secondary">
        ${tm.embed_showcase ? `<button class="pill route-action-wide" id="dWalkNav"><span class="ms">directions_walk</span>${esc(t("viewer.walkthroughWayfinding") || "Wayfinding")}</button>` : ""}
        ${tm.mesh_tour ? `<button class="pill" id="dMeshTour"><span class="ms">3d_rotation</span>${esc(t("viewer.meshTour") || "Mesh tour")}</button>` : ""}
        ${bundleBtn}
        <button class="pill" id="dStartAr" hidden><span class="ms">view_in_ar</span>${esc(t("viewer.startAr"))}</button>
        ${isMpMode() ? "" : `<button class="pill" id="dJson" title="Ordered Matterport sweep ids + XYZ"><span class="ms">data_object</span>${esc(t("viewer.export"))}</button>`}
      </div>
      <ol class="steps" aria-label="${esc(t("viewer.steps"))}">${steps}</ol>`, "half");
    $("dStart").onclick = () => startNav();
    if ($("dPrev3d")) $("dPrev3d").onclick = () => preview3D();
    // Directions' "View in AR" shares the DESTINATION only (not the route/start point) —
    // the AR experience opens straight at where you're headed, same as tapping a POI
    // directly and hitting View in AR.
    if ($("dViewAr")) $("dViewAr").onclick = () => {
      const url = (S.to && S.to !== "me") ? arShareUrlFor(S.to) : null;
      if (url) window.open(url, "_blank", "noopener");
      else toast(t("viewer.arLocked") || "AR navigation can't be started right now. Please try again shortly or continue using the map.");
    };
    if ($("dTourMp")) $("dTourMp").onclick = () => {
      if (!S.route) return;
      const acc = accessFlags();
      if (acc.twin_disabled) {
        toast(t("viewer.tourDisabled") || "The 3D tour isn't available for this building. You can still explore using the regular map.");
        return;
      }
      if (!acc.embed_tour_allowed && !acc.twin_pin_required) {
        toast(t("viewer.tourUnavailable") || "The indoor tour isn't available right now. Please try again later.");
        return;
      }
      if (window.MpPreview) window.MpPreview.open(mpRoutePayload());
      else toast(t("viewer.tourUnavailable"));
    };
    if ($("dWalkNav")) $("dWalkNav").onclick = () => {
      if (!S.route) return;
      const acc = accessFlags();
      if (acc.twin_disabled) { toast(t("viewer.tourDisabled") || "The 3D tour isn't available for this building. You can still explore using the regular map."); return; }
      if (window.ThreeDNav) window.ThreeDNav.open(S.route);
      else toast(t("viewer.tourUnavailable") || "The indoor tour isn't available right now. Please try again later.");
    };
    if ($("dMeshTour")) $("dMeshTour").onclick = () => openMeshTourFromDirections();
    if ($("dBundle")) $("dBundle").onclick = () => {
      if (!S.route) return;
      if (window.BundlePreview) BundlePreview.open(S.route);
      else toast(t("viewer.bundleUnavailable") || "We couldn't open the 3D view right now. You can continue using the regular map.");
    };
    wireStartArButton($("dStartAr"));
    $("dShare").onclick = share;
    if ($("dJson")) $("dJson").onclick = () => $("btnExport").click();
    $("sheetBody").querySelectorAll(".steps li").forEach(li => { const go = () => focusStep(+li.dataset.i); li.onclick = go; li.onkeydown = (e) => { if (e.key === "Enter") go(); }; });
  }
  function focusStep(i) {
    const s = S.navSteps[i]; if (!s || !s.pt) return;
    $("sheetBody").querySelectorAll(".steps li").forEach(li => li.classList.toggle("cur", +li.dataset.i === i));
    const F = (s.type === "stairs" || s.type === "elevator") && s.toFloor ? s.pt.floor : s.pt.floor;
    if (F && F !== wf.currentFloor()) wf.setFloor(F);
    const ll = wf.modelToLL(s.pt.x, s.pt.y);
    // Same chase-cam as the turn-by-turn nav banner and the full route preview —
    // tapping a step in the list should land on exactly the view those give you.
    const nxt = S.navSteps[i + 1];
    if (isMpMode() && window.MpPreview) {
      window.MpPreview.focusAt(s.pt, nxt && nxt.pt ? nxt.pt : null);
      return ll;
    }
    const hd = nxt && nxt.pt ? turf.bearing(turf.point(ll), turf.point(wf.modelToLL(nxt.pt.x, nxt.pt.y))) : undefined;
    if (wf.is3D()) wf.getView3d().goTo(tourCameraFor(ll, wf.modelZtoAbs(s.pt.z), hd), { duration: 700 }).catch(() => { });
    else wf.view2d.goTo({ center: ll, zoom: Math.max(wf.view2d.zoom, TOUR_ZOOM) }, { duration: 700 }).catch(() => { });
    return ll;
  }

  // ---------------- navigation mode (simulated) ----------------
  // Shared 3D "tour" camera framing — every walkthrough camera (step-through in
  // navGo, continuous fly-through in preview3D) uses this same distance/tilt, so
  // the route reads the same way and sits at the same zoomed-in angle regardless
  // of which one is driving the view.
  const TOUR_ZOOM = 22.5;         // 2D fallback zoom (MapView has no 3D camera)
  // 0=straight down, 90=horizon. Pitching DOWN (lower number, toward 0) was the wrong
  // direction — that's more overhead/top-down, less of the vertical space in frame.
  // Pitched UP instead, close to horizon, so the ceiling/upper space is visible, not
  // just the floor ahead.
  const TOUR_TILT = 78;
  const TOUR_BACK_M = 12;         // camera sits this far BEHIND the route point...
  const TOUR_UP_M = TOUR_BACK_M * Math.tan((90 - TOUR_TILT) * Math.PI / 180); // ...and this far above it, so the point stays centred at TOUR_TILT
  /**
   * Explicit chase-cam Camera (position+heading+tilt) for a 3D tour step.
   *
   * `view.goTo({target, heading, tilt, zoom})` looks like the natural way to do this,
   * but Esri silently drops the `zoom` the moment `target` carries an explicit z (which
   * it must, here, to sit at the right floor rather than bare terrain) — the camera was
   * landing many times farther back than asked, which is why "zoom in more" never
   * actually zoomed in no matter how high the number went. Building the camera's eye
   * position ourselves — a fixed distance behind the point, opposite the direction of
   * travel, at a matching height for TOUR_TILT — sidesteps that entirely: the distance
   * is exactly what we set it to, every single time, and the route ahead points straight
   * up the screen because the camera is looking along the same heading it's travelling.
   */
  function tourCameraFor(lonlat, floorAbsZ, headingDeg) {
    const hd = ((headingDeg || 0) % 360 + 360) % 360;
    const eye = turf.destination(turf.point(lonlat), TOUR_BACK_M / 1000, (hd + 180) % 360, { units: "kilometers" }).geometry.coordinates;
    return { position: { longitude: eye[0], latitude: eye[1], z: floorAbsZ + TOUR_UP_M }, heading: hd, tilt: TOUR_TILT };
  }
  /** Nearest S.navSteps[] instruction (by its .pt) to a model Z-up point — lets mp mode's
   *  per-scan-point camera stepping still drive the right turn-by-turn text/icon/distance. */
  function nearestNavStepIndex(pt) {
    let best = 0, bd = Infinity;
    (S.navSteps || []).forEach((s, i) => {
      if (!s || !s.pt || s.pt.x == null) return;
      const d = Math.hypot(s.pt.x - pt.x, s.pt.y - pt.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  /** mp mode's Next/Prev: step the camera exactly one real scan point at a time — the
   *  same sweep-by-sweep granularity and FLY/camera-angle Tour interior's play() loop
   *  uses — instead of jumping straight to whichever scan point sits nearest the next
   *  turn-by-turn instruction (that nearest-point search had no ordering guarantee,
   *  which is why Next sometimes flew backward, and had no adjacency guarantee, which
   *  is why a single click could skip over many real scan points at once). */
  function mpNavStep(delta) {
    if (!window.MpPreview || !window.MpPreview.totalSweepStops) return;
    const total = window.MpPreview.totalSweepStops();
    if (!total) { navGo(S.navI + delta); return; }
    const cur = window.MpPreview.currentSweepIndex();
    const target = Math.max(0, Math.min(total - 1, cur + delta));
    if (target === cur) return;
    const pt = window.MpPreview.sweepPointAt ? window.MpPreview.sweepPointAt(target) : null;
    if (pt) updateNavBannerChrome(nearestNavStepIndex(pt));
    $("navPrev").disabled = target <= 0;
    $("navNext").disabled = target >= total - 1;
    window.MpPreview.walkToIndex(target, updateMpRemaining);
  }
  function bindNav() {
    // mp mode: step the Matterport camera one real scan point per click (mpNavStep —
    // same engine Tour interior's play() uses). Non-mp (2D/3D map) mode: advance by
    // turn-by-turn instruction as before (navGo).
    $("navNext").onclick = () => { if (isMpMode()) mpNavStep(1); else navGo(S.navI + 1); };
    $("navPrev").onclick = () => { if (isMpMode()) mpNavStep(-1); else navGo(S.navI - 1); };
    $("navExit").onclick = exitNav;
    // Arrow-key shortcut for step navigation — skipped in mp mode, where the whole screen
    // is the Matterport embed and arrow keys are far more likely to be an incidental key
    // press (or an attempt to look around) than an intentional "next step", which read as
    // the route advancing on its own without clicking Next/Prev.
    document.addEventListener("keydown", (e) => { if (S.mode !== "nav" || isMpMode()) return; if (e.key === "ArrowRight") navGo(S.navI + 1); if (e.key === "ArrowLeft") navGo(S.navI - 1); });
  }
  async function startNav() {
    if (!S.route) return;
    S.mode = "nav"; document.body.classList.add("nav");
    $("navBanner").hidden = false; $("navBar").hidden = false; closePop();
    applyPadding();
    arrivedAnnounced = false;
    // Prepare the same sweep-by-sweep walk engine Tour interior uses (FLY transitions,
    // rotate-toward-next-waypoint, faceAlongRoute correction) before stepping through it,
    // one real scan point per Next/Prev click (mpNavStep) — same granularity and camera
    // handling Tour interior's own play() loop uses, just touch-driven instead of auto-play.
    if (isMpMode() && window.MpPreview && window.MpPreview.prepareWalk) {
      let total = 0;
      try { total = await window.MpPreview.prepareWalk(mpRoutePayload()); } catch (_) { /* ignore */ }
      if (total) {
        const pt0 = window.MpPreview.sweepPointAt ? window.MpPreview.sweepPointAt(0) : null;
        updateNavBannerChrome(pt0 ? nearestNavStepIndex(pt0) : 0);
        $("navPrev").disabled = true;
        $("navNext").disabled = total <= 1;
        // Force the camera into the route's actual start sweep (mirrors Tour interior's
        // play() loop, which always flies to sweepIds[0] first) — the mp=1 background's
        // live camera is wherever it last was, not necessarily this route's start point.
        if (window.MpPreview.moveTo) window.MpPreview.moveTo(0);
        return;
      }
    }
    navGo(S.navSteps.length > 1 ? 1 : 0);
  }
  /** Fires the shared "Destination reached" card (with thumbs up/down route feedback)
   *  exactly once per nav session — mp-mode (Start Preview) only; see call sites. Same
   *  card Walkthrough Wayfinding and Tour interior show, for a consistent arrival
   *  moment everywhere. */
  let arrivedAnnounced = false;
  function announceArrivalOnce() {
    if (arrivedAnnounced) return;
    arrivedAnnounced = true;
    if (window.wfShowArrivalCard) {
      window.wfShowArrivalCard({
        name: nameOf(S.to), context: "start_preview",
        fromName: nameOf(S.from), toName: nameOf(S.to),
        onDone: () => exitNav(),
      });
    } else {
      toast(t("viewer.destinationReached") || "Destination reached");
    }
  }
  /** mp mode only: recompute the "time/distance remaining" readout from the REAL route,
   *  anchored at the scan point the camera just landed on — called after every real scan
   *  point Next/Prev's flight passes through on its way to the next/previous turn, so the
   *  banner's distance ticks down live during that flight instead of jumping once at the
   *  end of it. */
  // Baseline route-remaining-metres sampled the first time the current instruction's
  // navBanner distance is shown — lets navDist count DOWN per sweep hop ("8 m" → "5 m" →
  // "2 m" → "Now") instead of staying fixed at the instruction's starting distance for
  // its whole leg, which read as broken/non-live.
  let navLegBaselineI = -1;
  let navLegBaselineRemM = null;
  function updateMpRemaining(info) {
    if (!info || info.remainingM == null || S.mode !== "nav") return;
    const remT = info.remainingM / 1.2 + (S.route.stairs_rise_m || 0) * 2 * (info.remainingM / Math.max(1, S.route.total_m));
    const eta = new Date(Date.now() + remT * 1000);
    $("navEta").textContent = fmtMin(remT);
    $("navRem").textContent = `${fmtDist(info.remainingM) || "0 m"} · ${t("viewer.arriveAt", { time: eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })}`;

    const s = S.navSteps[S.navI];
    if (!s) return;
    if (navLegBaselineI !== S.navI) { navLegBaselineI = S.navI; navLegBaselineRemM = info.remainingM; }
    const travelled = Math.max(0, (navLegBaselineRemM ?? info.remainingM) - info.remainingM);
    const left = Math.max(0, (s.dist || 0) - travelled);
    $("navDist").textContent = left > 0.5 ? fmtDist(left) : (s.type === "arrive" ? t("viewer.arrived") : t("viewer.now"));
    // Advancing to the next instruction is the explicit Next click's job (navGo) — this
    // only announces the one-time "Destination reached" once the final leg's flight lands.
    const landedAtDestination = info.landed === true && window.MpPreview &&
      info.index === window.MpPreview.totalSweepStops() - 1;
    if (landedAtDestination) {
      $("navDist").textContent = t("viewer.arrived");
      announceArrivalOnce();
    }
  }
  /** Icon/text/thumb/ETA chrome only — no camera move, no S.sim, no walkToIndex. */
  function updateNavBannerChrome(i) {
    const n = S.navSteps.length; i = Math.max(0, Math.min(n - 1, i)); S.navI = i;
    const s = S.navSteps[i];
    $("navIcon").textContent = s.icon;
    $("navDist").textContent = s.dist > 0.5 ? fmtDist(s.dist) : (s.type === "arrive" ? t("viewer.arrived") : t("viewer.now"));
    $("navText").textContent = s.text;
    $("navBanner").classList.toggle("stairs", s.type === "stairs" || s.type === "level");
    $("navBanner").classList.toggle("elevator", s.type === "elevator");
    const sw = (s.type === "stairs" || s.type === "level" || s.type === "elevator" || s.type === "arrive") && s.pt ? nearestSweep(s.pt) : null, th = sw && thumbFor(sw.id);
    $("navThumb").hidden = !th; if (th) { $("navThumb").src = th; $("navThumb").alt = t("viewer.viewFromScan"); }
    // remaining distance/time after the user reaches the previous action point
    let rem = 0; for (let k = i; k < n; k++) rem += S.navSteps[k].dist || 0;
    const remT = rem / 1.2 + (S.route.stairs_rise_m || 0) * 2 * (rem / Math.max(1, S.route.total_m));
    const eta = new Date(Date.now() + remT * 1000);
    $("navEta").textContent = fmtMin(remT);
    $("navRem").textContent = `${fmtDist(rem) || "0 m"} · ${t("viewer.arriveAt", { time: eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })}`;
    $("navPrev").disabled = i <= 0; $("navNext").disabled = i >= n - 1;
    // Selecting an arrival instruction updates chrome only. The camera's confirmed
    // final landing triggers the arrival card in updateMpRemaining().
  }
  function navGo(i) {
    updateNavBannerChrome(i);
    const n = S.navSteps.length; i = S.navI;
    const s = S.navSteps[i], prev = S.navSteps[Math.max(0, i - 1)];
    // simulated position = previous action point; heading toward the next action
    const at = prev && prev.pt ? prev.pt : s.pt;
    if (at) {
      const a = wf.modelToLL(at.x, at.y), b = s.pt ? wf.modelToLL(s.pt.x, s.pt.y) : a;
      const hd = (a[0] !== b[0] || a[1] !== b[1]) ? turf.bearing(turf.point(a), turf.point(b)) : null;
      // Carry the last real heading forward instead of snapping to north (0°) when a
      // step has nowhere new to point at (e.g. the arrival step) — the route should
      // never visibly spin to face away from the direction of travel.
      const hdFinal = hd != null ? hd : ((S.sim && S.sim.heading != null) ? S.sim.heading : 0);
      S.sim = { lonlat: a, floor: at.floor, heading: hdFinal };
      if (at.floor && at.floor !== wf.currentFloor()) wf.setFloor(at.floor);
      if (isMpMode() && window.MpPreview && window.MpPreview.nearestIndexForPoint) {
        const target = s.pt || at;
        const idx = window.MpPreview.nearestIndexForPoint(target);
        if (idx >= 0 && window.MpPreview.walkToIndex) window.MpPreview.walkToIndex(idx, updateMpRemaining);
        else window.MpPreview.focusAt(at, target); // no prepared route (e.g. nothing to walk) — single hop
      }
      const v = wf.view();
      // Same chase-cam framing as the full route preview — every 3D "tour" camera
      // (step-through here, continuous fly-through in preview3D) now sits at the
      // same distance/angle instead of each using its own values.
      if (wf.is3D()) v.goTo(tourCameraFor(a, wf.modelZtoAbs(at.z), hdFinal), { duration: 800 }).catch(() => { });
      else v.goTo({ center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], zoom: TOUR_ZOOM, rotation: 0 }, { duration: 800 }).catch(() => { });
      placeMe();
    }
    if (s.type === "arrive" && !isMpMode()) toast(t("viewer.youArrived", { name: nameOf(S.to) }));
  }
  function exitNav() {
    if (isMpMode() && window.MpPreview && window.MpPreview.cancelWalkTo) window.MpPreview.cancelWalkTo();
    S.mode = "dir"; S.sim = null; document.body.classList.remove("nav");
    $("navBanner").hidden = true; $("navBar").hidden = true; placeMe(); applyPadding();
    if (S.route) renderDirections(S.route);
  }
  async function preview3D() {
    if (!S.route || S.previewing) return;
    S.previewing = true; toast(t("viewer.previewingRoute"), t("viewer.stop"), () => { S.previewing = false; });
    await toggle3D(true);
    // Keep the "All" floor button active for the whole preview — switching to each
    // point's own floor (as this used to) hid every other floor in turn, which read
    // as floors popping in and out while the camera flew through them.
    if (wf.currentFloor() !== "all") wf.setFloor("all");
    const v = wf.getView3d(); const pts = S.route.navPath || S.route.smoothed;
    // Carried across steps so the camera always keeps facing the way the route is
    // travelling — the route segment ahead stays pointing straight up the screen
    // instead of the heading resetting (and the view visibly swinging) on the last
    // point of a leg, where there is no further point to aim at.
    let lastHeading;
    for (let i = 0; i < pts.length && S.previewing; i++) {
      const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)];
      const a = wf.modelToLL(p.x, p.y), b = wf.modelToLL(q.x, q.y);
      const hd = i < pts.length - 1 && (a[0] !== b[0] || a[1] !== b[1]) ? turf.bearing(turf.point(a), turf.point(b)) : lastHeading;
      if (hd != null) lastHeading = hd;
      try { await v.goTo(tourCameraFor(a, wf.modelZtoAbs(p.z) + 1, hd), { duration: 1300, easing: "linear" }); } catch (e) { break; }
    }
    S.previewing = false; hideToast();
  }


  // ---------------- Locate me (GPS → snap / Image) ----------------
  const GPS_ACC_OK = 45, GPS_INDOOR_ACC = 22, ENTRANCE_SNAP_M = 40;
  function modelBBox() { return (window.WF && WF.cfg && WF.cfg.model_bbox) || [-40, -30, 20, 25]; }
  function insideModel(x, y) { const b = modelBBox(); return x > b[0] && x < b[2] && y > b[1] && y < b[3]; }
  function nearestEntranceXY(x, y) {
    let best = null, bd = 1e9;
    POIS.filter(p => p.category === "entrance").forEach(p => {
      const d = Math.hypot((p.model && p.model.x) - x, (p.model && p.model.y) - y);
      if (d < bd) { bd = d; best = p; }
    });
    return best ? { poi: best, dist: bd } : null;
  }
  function vpsLocalizeUrl() {
    const C = window.WF_CONFIG || {};
    if (C.vpsUrl) {
      const u = C.vpsUrl.replace(/\/$/, "");
      return /\/localize$/.test(u) ? u : u + "/localize";
    }
    // Prefer platform public proxy (works over the :8780 tunnel). Stale published
    // config may still say vps_enabled=false — ignore that when apiBase is set.
    const api = (C.apiBase || "/api/v1/public/").replace(/\/?$/, "/");
    if (api.indexOf("/api/") >= 0) return api + "vps/localize";
    if (window.WF && WF.cfg && WF.cfg.vps_enabled) return "/api/v1/public/vps/localize";
    return "/localize";
  }
  function localizePageUrl() {
    // Church prototype tunnel: /localize.html; platform may not ship it — fall back to absolute app path when known
    const candidates = ["localize.html", "/localize.html", "../localize.html"];
    return candidates[0];
  }
  function floorFromVps(r) {
    const floors = (window.WF && WF.cfg && WF.cfg.floors) || [];
    const ids = floors.map(f => f.id);
    if (r.floor_id && (!ids.length || ids.includes(r.floor_id))) return r.floor_id;
    const s = String(r.floor || "");
    if (/2/.test(s) && (ids.includes("F2") || !ids.length)) return "F2";
    if (/1/.test(s) && (ids.includes("F1") || !ids.length)) return "F1";
    const cur = wf.currentFloor();
    return cur && cur !== "none" ? cur : ((window.WF && WF.cfg && WF.cfg.default_floor) || "F1");
  }
  function setLocateBusy(on) {
    const b = $("btnLocateMe"); if (b) b.classList.toggle("busy", !!on);
  }
  function applyLocated(lon, lat, meta) {
    if (meta && meta.floor) wf.setFloor(meta.floor);
    wf.localizeAt(lon, lat);
    // wf.localizeAt only updates 2D/web-mercator state (wf.lastLoc, the dot on the
    // map) — it has no isMpMode() awareness, so without this the Matterport camera
    // never moves on a GPS fix. applyVpsResult and pickOnMapMp() do their own version
    // of this with the raw model x/y they already have; this covers every other
    // caller (GPS, entrance) — skip it for those two so the camera doesn't fly twice.
    if (isMpMode() && window.MpPreview && (!meta || (meta.source !== "vps" && meta.source !== "map"))) {
      try {
        const [mx, my] = wf.llToModel(lon, lat);
        window.MpPreview.focusAt({ x: mx, y: my, z: 0 }, null);
      } catch (e) { }
    }
    if (wf.lastLoc) {
      if (meta && meta.accuracy != null) wf.lastLoc.accuracy = meta.accuracy;
      if (meta && meta.source) wf.lastLoc.source = meta.source;
      if (meta && meta.heading != null) wf.lastLoc.heading = meta.heading;
      if (meta && meta.confidence != null) wf.lastLoc.confidence = meta.confidence;
    }
    S.locMeta = {
      source: (meta && meta.source) || "gps",
      label: (meta && meta.label) || t("viewer.currentLocation"),
      accuracy: meta && meta.accuracy != null ? meta.accuracy : null,
      confidence: meta && meta.confidence != null ? meta.confidence : null
    };
    S.from = "me";
    $("btnMe").classList.remove("on");
    hideToast();
    placeMe();
    if (S.mode !== "dir") openDirections(); else { syncDirFields(); computeRoute(); }
    toast(t("viewer.locationSet", { floor: wf.floorLabel(wf.lastLoc.floor) }));
  }
  function snapGpsToGraph(lon, lat, accuracy) {
    const [x, y] = wf.llToModel(lon, lat);
    const indoors = insideModel(x, y);
    const poor = accuracy == null || accuracy > GPS_ACC_OK || (indoors && accuracy > GPS_INDOOR_ACC);
    if (poor) return { kind: "indoor_poor", x, y, indoors };
    const ent = nearestEntranceXY(x, y);
    // Outdoors / near building: prefer entrance if close
    if ((!indoors || (ent && ent.dist < ENTRANCE_SNAP_M)) && ent && ent.dist < ENTRANCE_SNAP_M) {
      return { kind: "entrance", x, y, indoors, poi: ent.poi, dist: ent.dist };
    }
    const floor = (!indoors ? ((window.WF && WF.cfg && WF.cfg.default_floor) || "F1") : (wf.currentFloor() === "none" ? ((window.WF && WF.cfg && WF.cfg.default_floor) || "F1") : wf.currentFloor()));
    let snap = null;
    try { if (window.WFRouting && WFRouting.snap) snap = WFRouting.snap(x, y, floor); } catch (e) { }
    if (snap && snap.node) return { kind: "node", x, y, indoors, node: snap.node, dist: snap.dist, floor };
    return { kind: "raw", x, y, indoors, floor };
  }
  async function locateMe() {
    if (!navigator.geolocation) {
      showLocateFallback(t("viewer.geoUnsupported"));
      return;
    }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const permission = await navigator.permissions.query({ name: "geolocation" });
        if (permission.state === "denied") { showLocateFallback(t("viewer.geoDeniedRetry")); return; }
      }
    } catch (_) { /* Permission queries are unsupported on some browsers. */ }
    setLocateBusy(true);
    toast(t("viewer.locating"));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      setLocateBusy(false);
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      // Do not log raw coordinates in production consoles beyond status toasts
      const snap = snapGpsToGraph(lon, lat, accuracy);
      if (snap.kind === "indoor_poor") {
        showLocateFallback(t("viewer.gpsPoorIndoor", { m: accuracy != null ? Math.round(accuracy) : "?" }), { accuracy });
        return;
      }
      if (snap.kind === "entrance") {
        const ll = snap.poi.lonlat;
        applyLocated(ll[0], ll[1], {
          source: "gps", accuracy, floor: snap.poi.floor,
          label: t("viewer.nearPlace", { name: snap.poi.name })
        });
        return;
      }
      if (snap.kind === "node") {
        const ll = wf.modelToLL(snap.node.x, snap.node.y);
        const label = snap.node.label ? t("viewer.nearPlace", { name: snap.node.label }) : t("viewer.currentLocation");
        applyLocated(ll[0], ll[1], { source: "gps", accuracy, floor: snap.node.floor || snap.floor, label });
        return;
      }
      applyLocated(lon, lat, { source: "gps", accuracy, floor: snap.floor, label: t("viewer.currentLocation") });
    }, (err) => {
      setLocateBusy(false);
      const code = err && err.code;
      const msg = code === 1 ? t("viewer.geoDeniedRetry") : code === 3 ? t("viewer.geoTimeout") : t("viewer.geoFailed");
      showLocateFallback(msg);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
  }
  function showLocateFallback(msg, extra) {
    const titleKey = [
      ["geoDeniedRetry", "geoDeniedTitle"], ["geoTimeout", "geoTimeoutTitle"],
      ["geoUnsupported", "geoUnsupportedTitle"], ["gpsPoorIndoor", "gpsPoorTitle"]
    ].find(([key]) => msg === t("viewer." + key));
    const heading = t("viewer." + (titleKey ? titleKey[1] : "geoFailedTitle"));
    setSheet(`<div class="warn"><span class="ms">my_location</span><div><strong>${esc(heading)}</strong><br>${esc(msg)}</div></div>
      <div class="actions">
        <button class="pill primary" id="dSetMe"><span class="ms">touch_app</span>${esc(t("viewer.pickOnMap"))}</button>
        <button class="pill" id="dSearchFrom"><span class="ms">search</span>${esc(t("viewer.searchStart"))}</button>
      </div>`, "half");
    if ($("dSetMe")) $("dSetMe").onclick = () => isMpMode() ? pickOnMapMp() : startLocalize(true);
    if ($("dSearchFrom")) $("dSearchFrom").onclick = () => { $("fromQ").focus(); };
  }
  function bindLocateChooser() {
    const modal = $("locateChooser"); if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";
    const close = () => closeLocateChooser();
    if ($("lcClose")) $("lcClose").onclick = close;
    if ($("lcCancel")) $("lcCancel").onclick = close;
    modal.addEventListener("click", (ev) => { if (ev.target === modal) close(); });
    if ($("lcGps")) $("lcGps").onclick = () => { closeLocateChooser(); locateMe(); };
    if ($("lcCam")) $("lcCam").onclick = () => { closeLocateChooser(); openLocateModal(); };
    if ($("lcPickMap")) $("lcPickMap").onclick = () => { closeLocateChooser(); isMpMode() ? pickOnMapMp() : startLocalize(true); };
  }
  function openLocateChooser() {
    // Keep one entry point for callers, but map-pick is the only enabled location
    // method at present, so avoid an unnecessary one-option chooser.
    isMpMode() ? pickOnMapMp() : startLocalize(true);
  }
  function closeLocateChooser() { const m = $("locateChooser"); if (m) m.hidden = true; }

  function bindLocateModal() {
    const f = $("locFile"); if (!f || f.dataset.bound) return;
    f.dataset.bound = "1";
    f.onchange = () => { const file = f.files && f.files[0]; if (file) runVpsLocalize(file); };
  }
  // "Use image" used to open a chooser modal (take photo / full localize page / pick on
  // map) — now it's a single action: go straight to the camera. The full localize page
  // moved to admin (building-detail debug tools); "pick on map" moved to the Locate-me
  // chooser as its own option (see dollhouse pick-and-walk below).
  function openLocateModal() {
    closeLocateChooser();
    const f = $("locFile"); if (!f) { location.href = localizePageUrl(); return; }
    toast(t("viewer.camPermissionHint"));
    f.value = "";
    f.click();
  }
  async function shrinkImage(file, maxSide) {
    maxSide = maxSide || 1600;
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    return blob;
  }
  async function runVpsLocalize(file) {
    toast(t("viewer.vpsWorking"));
    try {
      const blob = await shrinkImage(file);
      const fd = new FormData();
      fd.append("image", blob, "photo.jpg");
      const modelId = (window.WF && WF.cfg && (WF.cfg.matterport_model_id || WF.cfg.model_id)) || "";
      const bslug = (window.WF && WF.building && WF.building.slug) || "";
      if (modelId) fd.append("model_id", modelId);
      if (bslug) fd.append("building", bslug);
      const url = vpsLocalizeUrl();
      const resp = await fetch(url, { method: "POST", body: fd });
      if (!resp.ok) {
        wfDbg("warn", "viewer.photo", "Photo positioning request failed", { status: resp.status });
        let detail = "";
        try { detail = (await resp.json()).detail || ""; } catch (e) { try { detail = await resp.text(); } catch (e2) {} }
        if (resp.status === 501) { toast(t("viewer.vpsNotConfigured")); return; }
        if (resp.status === 404) throw new Error("Locate endpoint missing (" + url + "). Hard-refresh and retry.");
        throw new Error("HTTP " + resp.status + (detail ? (": " + detail) : ""));
      }
      const r = await resp.json();
      if (!r.success) {
        toast(t("viewer.vpsFailed"));
        return;
      }
      if (r.confidence != null && r.confidence < 0.3) {
        toast(t("viewer.vpsLowConf"));
        return; // An uncertain fix must not replace the user's location.
      }
      applyVpsResult(r);
    } catch (e) {
      wfDbg("warn", "viewer.photo", "Photo positioning request failed");
      toast(t("viewer.vpsError"));
    }
  }
  function applyVpsResult(r) {
    if (!r || !r.success) return;
    const floor = floorFromVps(r);
    let lon = r.lon, lat = r.lat;
    if ((lon == null || lat == null) && r.x != null && r.y != null) {
      const ll = wf.modelToLL(r.x, r.y); lon = ll[0]; lat = ll[1];
    }
    if (lon == null || lat == null) { toast(t("viewer.vpsFailed")); return; }
    // Snap Image pose onto nav graph for routing stability
    let label = t("viewer.currentLocation");
    try {
      const snap = window.WFRouting && WFRouting.snap && WFRouting.snap(r.x, r.y, floor);
      if (snap && snap.node && snap.dist < 8) {
        const ll = wf.modelToLL(snap.node.x, snap.node.y);
        lon = ll[0]; lat = ll[1];
        if (snap.node.label) label = t("viewer.nearPlace", { name: snap.node.label });
      }
    } catch (e) { }
    applyLocated(lon, lat, {
      source: "vps", floor, heading: r.heading, confidence: r.confidence,
      label, accuracy: null
    });
    // applyLocated only updates 2D/web-mercator state (wf.lastLoc, the dot on the map) —
    // it has no isMpMode() awareness, so without this the Matterport camera in the MP
    // viewer would never actually move to the matched location.
    if (isMpMode() && window.MpPreview && r.x != null && r.y != null) {
      window.MpPreview.focusAt({ x: r.x, y: r.y, z: r.z || 0 }, null);
    }
  }
  // MP mode's "Pick on map": switches to the Matterport dollhouse view, lets the user
  // aim at their spot (native Showcase orbit/pan — untouched) and confirm, then walks
  // the camera there (mp_preview.js's pickOnMap() does the Dollhouse-mode switch +
  // Pointer.intersection tracking + the walk-there fly) and sets that point as "from",
  // same as a GPS fix or an image match would.
  async function pickOnMapMp() {
    if (!window.MpPreview || !window.MpPreview.pickOnMap) { toast(t("viewer.vpsNotConfigured") || "Not available"); return; }
    toast(t("viewer.pickOnMapHint"));
    const pt = await window.MpPreview.pickOnMap();
    if (!pt) return; // user cancelled
    const ll = wf.modelToLL(pt.x, pt.y);
    let floor = null;
    try {
      const floors = ((window.WF && WF.cfg && WF.cfg.floors) || []).slice().sort((a, b) => a.ordinal - b.ordinal);
      if (pt.floorIndex != null && floors[pt.floorIndex]) floor = floors[pt.floorIndex].id;
    } catch (e) { }
    let lon = ll[0], lat = ll[1], label = t("viewer.currentLocation");
    try {
      const snap = window.WFRouting && WFRouting.snap && WFRouting.snap(pt.x, pt.y, floor);
      if (snap && snap.node && snap.dist < 8) {
        const sl = wf.modelToLL(snap.node.x, snap.node.y);
        lon = sl[0]; lat = sl[1];
        if (snap.node.label) label = t("viewer.nearPlace", { name: snap.node.label });
      }
    } catch (e) { }
    applyLocated(lon, lat, { source: "map", floor, label, accuracy: null });
  }

  // ---------------- you are here ----------------
  function startLocalize(thenRoute) {
    if (wf.is3D()) toggle3D(false);
    wf.startLocalize(true); $("btnMe").classList.add("on");
    S.locThenRoute = !!thenRoute;
    toast(t("viewer.tapWhereYouAre", { floor: wf.floorLabel(wf.currentFloor() === "none" ? WF.cfg.default_floor : wf.currentFloor()) }), t("common.cancel"), () => { wf.startLocalize(false); $("btnMe").classList.remove("on"); });
  }
  function onLocalized(loc, silent) {
    $("btnMe").classList.remove("on"); hideToast();
    placeMe();
    if (!S.locMeta || S.locMeta.source === "map") {
      S.locMeta = { source: (S.locMeta && S.locMeta.source) || "map", label: t("viewer.currentLocation"), accuracy: null };
    }
    if (S.mode === "dir" || S.locThenRoute) { S.from = "me"; syncDirFields(); }
    if (!silent) toast(t("viewer.locationSet", { floor: wf.floorLabel(loc.floor) }));
    if (S.locThenRoute || (S.mode === "dir" && S.from === "me")) { S.locThenRoute = false; if (S.mode !== "dir") { S.from = "me"; openDirections(); } else computeRoute(); }
  }
  function placeMe() {
    const el = $("me");
    const sim = S.sim, loc = wf && wf.lastLoc;
    const src = sim ? { lon: sim.lonlat[0], lat: sim.lonlat[1], floor: sim.floor, heading: sim.heading } : loc ? { lon: loc.lon, lat: loc.lat, floor: loc.floor, heading: headingFromRoute() } : null;
    if (!src || !wf || wf.is3D()) { el.hidden = true; if (wf && wf.dotLayer) wf.dotLayer.visible = true; return; }
    const pt = wf.view2d.toScreen(new wf.esri.Point({ longitude: src.lon, latitude: src.lat }));
    if (!pt) { el.hidden = true; return; }
    wf.dotLayer.visible = false;
    el.hidden = false; el.style.left = pt.x + "px"; el.style.top = pt.y + "px";
    el.style.opacity = (src.floor === wf.currentFloor()) ? 1 : 0.45;
    el.classList.toggle("hd", src.heading != null);
    if (src.heading != null) el.style.setProperty("--hd", (src.heading - 30 + 30 - (wf.view2d.rotation || 0)) + "deg");
  }
  function headingFromRoute() {
    const r = S.route; if (!r || S.from !== "me" || r.smoothed.length < 2) return null;
    const a = wf.modelToLL(r.smoothed[0].x, r.smoothed[0].y), b = wf.modelToLL(r.smoothed[1].x, r.smoothed[1].y);
    return turf.bearing(turf.point(a), turf.point(b));
  }

  // ---------------- right controls, floors, layers ----------------
  function bindControls() {
    $("btnZoomIn").onclick = () => {
      if (isMpMode() && window.MpPreview) {
        window.MpPreview.zoomBy(1).then(ok => { if (!ok) toast(t("viewer.mpZoomDollhouseHint") || "Pinch or scroll on the view to zoom in the dollhouse"); });
        return;
      }
      const v = wf.view(); v.goTo({ zoom: v.zoom + 1 }, { duration: 250 }).catch(() => { });
    };
    $("btnZoomOut").onclick = () => {
      if (isMpMode() && window.MpPreview) {
        window.MpPreview.zoomBy(-1).then(ok => { if (!ok) toast(t("viewer.mpZoomDollhouseHint") || "Pinch or scroll on the view to zoom in the dollhouse"); });
        return;
      }
      const v = wf.view(); v.goTo({ zoom: v.zoom - 1 }, { duration: 250 }).catch(() => { });
    };
    $("btn3D").onclick = () => toggle3D(!wf.is3D());

    if ($("btnLabels")) {
      const syncLab = () => {
        const on = !!wf.showLabels;
        $("btnLabels").classList.toggle("on", on);
        $("btnLabels").setAttribute("aria-pressed", on ? "true" : "false");
        $("btnLabels").title = on ? (t("viewer.labelsOn") || "Labels on") : (t("viewer.labelsOff") || "Labels off");
      };
      $("btnLabels").onclick = () => {
        const on = !wf.showLabels;
        if (wf.setShowLabels) wf.setShowLabels(on); else { wf.showLabels = on; if (wf.redrawPOIs) wf.redrawPOIs(); }
        syncLab();
        toast(on ? (t("viewer.labelsOn") || "Labels on") : (t("viewer.labelsOff") || "Labels off"));
      };
      syncLab();
    }
    $("btnMe").onclick = () => {
      // No GPS/map concept applies to the Matterport-only background view — repurposed
      // as a home button, flying out to the Dollhouse overview. A second press flies
      // straight back to the sweep the camera was at before the first press, so the
      // user is never stranded in the overview; the icon swaps to show which state
      // the button is in.
      if (isMpMode() && window.MpPreview) {
        window.MpPreview.toggleHomeView().then(res => {
          const btn = $("btnMe");
          if (!btn) return;
          btn.classList.toggle("on", !!(res && res.active));
          btn.querySelector(".ms").textContent = (res && res.active) ? "arrow_back" : "my_location";
        });
        return;
      }
      if (wf.lastLoc && !wf.isLocalizing()) {
        if (wf.lastLoc.floor !== wf.currentFloor()) wf.setFloor(wf.lastLoc.floor);
        wf.view().goTo({ center: [wf.lastLoc.lon, wf.lastLoc.lat], zoom: Math.max(wf.view().zoom, 20.5) }, { duration: 600 }).catch(() => { });
        toast(t("viewer.showingLocation"), t("viewer.setNew"), () => startLocalize());
      } else startLocalize();
    };
    $("floorList").querySelectorAll("button").forEach(b => b.onclick = () => {
      wf.setFloor(b.dataset.floor);
      // f=0 (see mp_preview.js showcaseUrl) hides Showcase's own floor explorer — these
      // buttons are the only way to change floor in mp mode, so drive it directly.
      if (isMpMode() && window.MpPreview && window.MpPreview.setFloor) window.MpPreview.setFloor(b.dataset.floor);
      setFloorStack(false);   // picking a floor collapses the stack back
    });
    $("floorToggle").onclick = () => setFloorStack($("floorPicker").classList.contains("expanded") ? false : true);
    document.addEventListener("pointerdown", (e) => {
      const fp = $("floorPicker");
      if (fp.classList.contains("expanded") && !fp.contains(e.target)) setFloorStack(false);
    });
    document.addEventListener("pointerdown", (e) => {
      if (!$("chipsDropdown").hidden && !$("chipsWrap").contains(e.target) && !$("chipsDropdown").contains(e.target)) setChipsOpen(false);
    });
    $("btnLayers").onclick = () => { const p = $("layersPop"); p.hidden = !p.hidden; if (!p.hidden) { syncLayers(); p.querySelector(".sty").focus(); } };
    $("btnLayersClose").onclick = closePop;
    document.querySelectorAll(".sty").forEach(b => b.onclick = () => setStyle(b.dataset.style));
    $("togPhoto").onchange = () => { $("photoPlan").checked = $("togPhoto").checked; $("photoPlan").dispatchEvent(new Event("change")); };
    $("togGraph").onchange = () => wf.showGraph($("togGraph").checked);
    $("togHideShell").onchange = () => wf.setHideShell($("togHideShell").checked);
    $("togHideOsmBlocks").onchange = () => wf.setHideOsmBlocks($("togHideOsmBlocks").checked);
    $("togHideMesh").onchange = () => wf.setHideMesh($("togHideMesh").checked);
    $("togRealMesh").onchange = () => wf.setRealMesh($("togRealMesh").checked);
    $("togSolidBuildings").onchange = () => wf.setSolidBuildings($("togSolidBuildings").checked);
    $("meshEdgeSwatches").querySelectorAll(".swatch").forEach(sw => sw.onclick = () => {
      // "Live" has no colour yet until the scan has loaded and been averaged.
      if (sw.id === "meshEdgeLive" && !wf.meshLiveColor) return;
      $("meshEdgeSwatches").querySelectorAll(".swatch").forEach(o => { o.classList.remove("on"); o.setAttribute("aria-pressed", "false"); });
      sw.classList.add("on"); sw.setAttribute("aria-pressed", "true");
      wf.setMeshEdgeColor(sw.dataset.rgb.split(",").map(Number));
    });
    // Fill in "Live" as soon as the scan's own average colour is known (may be
    // before or after this panel is opened — loadMesh() can finish either way).
    wf.onMeshLiveColor = (rgb) => {
      const sw = $("meshEdgeLive"); if (!sw) return;
      sw.dataset.rgb = rgb.join(",");
      sw.style.background = `rgb(${rgb.join(",")})`;
      sw.disabled = false; sw.title = t("viewer.meshBorderLive");
    };
    if (wf.meshLiveColor) wf.onMeshLiveColor(wf.meshLiveColor);
    $("meshEdgeCustom").oninput = () => {
      $("meshEdgeSwatches").querySelectorAll(".swatch").forEach(o => { o.classList.remove("on"); o.setAttribute("aria-pressed", "false"); });
      const hex = $("meshEdgeCustom").value;
      const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      wf.setMeshEdgeColor(rgb);
    };
    // Coalesced to one update per animation frame — dragging fired setMeshEdgeIntensity
    // (which replaces the whole mesh symbol) on every native input event, often several
    // per frame, which is what was actually causing the lag while dragging.
    let meshIntensityRaf = 0;
    $("meshEdgeIntensity").oninput = () => {
      const v = +$("meshEdgeIntensity").value;
      $("meshEdgeIntensityVal").textContent = v + "%";
      if (meshIntensityRaf) return;
      meshIntensityRaf = requestAnimationFrame(() => {
        meshIntensityRaf = 0;
        wf.setMeshEdgeIntensity(+$("meshEdgeIntensity").value / 100);
      });
    };
    document.addEventListener("pointerdown", (e) => { const p = $("layersPop"); if (!p.hidden && !p.contains(e.target) && !$("btnLayers").contains(e.target)) closePop(); });
  }
  function closePop() { $("layersPop").hidden = true; }
  function syncLayers() { document.querySelectorAll(".sty").forEach(b => { const on = b.dataset.style === wf.style; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); }); $("togPhoto").checked = $("photoPlan").checked; $("togGraph").checked = $("showGraph").checked; }
  async function setStyle(s) {
    await wf.setStyle(s);
    // mp=1 forces dark permanently (see mp_background.js) — never let the map-style
    // switcher (irrelevant once the map itself is hidden) strip it back off.
    if (!isMpMode()) document.body.classList.toggle("dark", s === "dark");
    syncLayers(); placeMe();
  }
  async function toggle3D(on) {
    if (on === wf.is3D()) return;
    $("btnDim").click();
    const t0 = Date.now();
    while (wf.is3D() !== on && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 100));
    if (on) { const v = wf.getView3d(); if (v) { v.ui.components = ["attribution"]; try { await v.when(); } catch (e) { } } }
    $("btn3D").textContent = on ? "2D" : "3D"; $("btn3D").setAttribute("aria-label", on ? t("viewer.switch2d") : t("viewer.switch3d"));
    applyPadding(); placeMe(); updateFloorPicker();
  }
  function updateFloorPicker() {
    const fp = $("floorPicker"); if (!wf) return;
    // Floor selection stays internal; never show a floor button in the viewer.
    const show = false;
    fp.hidden = !show;
    if (!show) setFloorStack(false);
    $("floorList").querySelectorAll("button").forEach(b => { const on = b.dataset.floor === wf.currentFloor(); b.setAttribute("aria-checked", on); });
    const cur = $("floorList").querySelector(`button[data-floor="${wf.currentFloor()}"]`);
    $("floorToggleLabel").textContent = cur ? cur.textContent : "";
    placeMe();
  }
  // Floor stack: collapsed by default, showing only the current-floor FAB — tapping it
  // expands the full floor list; picking a floor (or tapping outside) collapses it again.
  function setFloorStack(expanded) {
    $("floorPicker").classList.toggle("expanded", !!expanded);
    $("floorToggle").setAttribute("aria-expanded", String(!!expanded));
  }

  // ---------------- sheet (mobile bottom sheet / desktop panel) ----------------
  const SHEET = { peek: 168, half: 0.5, full: 0.88, placeMp: 0.4 };
  function sheetPx(state) { const v = SHEET[state]; return v > 1 ? v : Math.round(window.innerHeight * v); }
  function setSheet(html, state) {
    $("sheetBody").innerHTML = html; $("sheetBody").scrollTop = 0;
    $("sheet").classList.toggle("venue-info", !!$("sheetBody").querySelector(".venue-panel"));
    $("sheet").hidden = false;
    setSheetState(state || $("sheet").dataset.state || "peek");
  }
  function setSheetState(state) {
    const sh = $("sheet"); sh.dataset.state = state;
    if (!isDesk()) { sh.style.height = sheetPx(state) + "px"; document.documentElement.style.setProperty("--sheetH", sheetPx(state) + "px"); }
    else { sh.style.height = ""; document.documentElement.style.removeProperty("--sheetH"); }
    applyPadding();
  }
  function bindSheet() {
    const h = $("sheetHandle"), sh = $("sheet"); let y0 = null, h0 = 0;
    const order = ["peek", "half", "full"];
    h.addEventListener("pointerdown", (e) => { if (isDesk()) return; y0 = e.clientY; h0 = sh.getBoundingClientRect().height; sh.classList.add("dragging"); h.setPointerCapture(e.pointerId); });
    h.addEventListener("pointermove", (e) => { if (y0 === null) return; const nh = Math.max(90, Math.min(window.innerHeight * 0.92, h0 + (y0 - e.clientY))); sh.style.height = nh + "px"; document.documentElement.style.setProperty("--sheetH", nh + "px"); });
    h.addEventListener("pointerup", (e) => {
      if (y0 === null) return; sh.classList.remove("dragging");
      const dy = y0 - e.clientY; y0 = null;
      const cur = order.indexOf(sh.dataset.state);
      if (Math.abs(dy) < 8) setSheetState(order[(cur + 1) % 3]);
      else { const nh = sh.getBoundingClientRect().height; let best = "peek", bd = 1e9; order.forEach(s => { const d = Math.abs(sheetPx(s) - nh); if (d < bd) { bd = d; best = s; } }); setSheetState(best); }
    });
    h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const cur = order.indexOf(sh.dataset.state); setSheetState(order[(cur + 1) % 3]); } });
    $("sheetClose").onclick = closeSheet;
    window.addEventListener("resize", () => { if (!sh.hidden) setSheetState(sh.dataset.state || "peek"); });
  }
  function closeSheet() {
    const sh = $("sheet");
    sh.hidden = true;
    sh.style.height = "";
    document.documentElement.style.setProperty("--sheetH", "0px");
    applyPadding();
  }
  function applyPadding() {
    if (!wf) return;
    const desk = isDesk(); const nav = S.mode === "nav";
    const pad = desk ? { left: nav ? 470 : (12 + 408 + 12), top: 0, right: 60, bottom: 0 }
      : { left: 0, right: 56, top: nav ? 120 : (S.mode === "dir" ? 150 : 110), bottom: nav ? 90 : ($("sheet").hidden ? 0 : sheetPx($("sheet").dataset.state || "peek")) };
    wf.view2d.padding = pad; const v3 = wf.getView3d(); if (v3) v3.padding = pad;
  }

  // ---------------- drawer / menu ----------------
  let drawerReturnFocus = null;
  function syncSidebarPreferences() {
    $("togLarge").checked = document.body.classList.contains("large");
    const light = !document.body.classList.contains("dark");
    $("togHC").checked = light;
    $("appearanceSelect").value = light ? "light" : "dark";
  }
  function focusVenueSearch() {
    closeDirectionsIfOpen(); setUxMode("places");
    $("q").focus(); $("q").select(); renderAc($("q"));
  }
  function showRecentSearches() {
    S.mode = "recent";
    const items = recent().map(id => byId[id]);
    setSheet(items.length ? listHtml(items, t("viewer.recentSearches"))
      : `<h1 class="pname">${esc(t("viewer.recentSearches"))}</h1><p class="muted">${esc(t("viewer.noRecentSearches"))}</p>`, "half");
    bindList(items);
  }
  function showHelp() {
    S.mode = "help";
    setSheet(`<h1 class="pname">${esc(t("viewer.helpSupport"))}</h1>
      <ul class="facts"><li><span class="ms">search</span><div>${esc(t("viewer.helpSearch"))}</div></li>
      <li><span class="ms">directions</span><div>${esc(t("viewer.helpDirections"))}</div></li>
      <li><span class="ms">my_location</span><div>${esc(t("viewer.helpLocation"))}</div></li>
      <li><span class="ms">keyboard</span><div>${esc(t("viewer.helpKeyboard"))}</div></li></ul>
      <div class="actions"><button class="pill" id="helpSearch">${esc(t("viewer.findPlace"))}</button><button class="pill" id="helpDirections">${esc(t("viewer.getDirections"))}</button></div>`, "half");
    $("helpSearch").onclick = focusVenueSearch;
    $("helpDirections").onclick = () => openDirections();
  }
  function bindDrawer() {
    $("btnMenu").onclick = openDrawer; $("scrim").onclick = closeDrawer;
    $("drawerClose").onclick = closeDrawer;
    $("btnMenu").setAttribute("aria-controls", "drawer");
    $("btnMenu").setAttribute("aria-expanded", "false");
    const dh = document.querySelector(".drawhead");
    if (dh) dh.onclick = () => { closeDrawer(); showBuildingPicker(); try { $("q").focus(); } catch (_) {} };
    $("togLarge").onchange = () => { document.body.classList.toggle("large", $("togLarge").checked); localStorage.setItem("wf_large", $("togLarge").checked ? "1" : "0"); };
    $("togHC").onchange = () => {
      const light = $("togHC").checked;
      document.body.classList.toggle("dark", !light);
      localStorage.setItem("wf_theme", light ? "light" : "dark"); syncSidebarPreferences();
    };
    $("appearanceSelect").onchange = () => { $("togHC").checked = $("appearanceSelect").value === "light"; $("togHC").onchange(); };
    $("drawer").querySelectorAll("button.ditem").forEach(b => b.onclick = () => {
      const a = b.dataset.act; closeDrawer();
      if (a === "building") { closeDirectionsIfOpen(); showBuildingHome(); setSheetState("half"); }
      if (a === "search") focusVenueSearch();
      if (a === "directions") { closeDirectionsIfOpen(); openDirections(); }
      if (a === "recent") { closeDirectionsIfOpen(); showRecentSearches(); }
      if (a === "share") share();
      if (a === "language") showLanguageSheet();
      if (a === "help") { closeDirectionsIfOpen(); showHelp(); }
      if (a === "dev") { const d = $("devWrap"); d.hidden = !d.hidden; toast(d.hidden ? t("viewer.devHidden") : t("viewer.devShown")); }
      if (a === "about") { closeDirectionsIfOpen(); about(); }
    });
    $("drawer").addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDrawer(); }
      if (event.key !== "Tab") return;
      const nodes = [...$("drawer").querySelectorAll('button:not([disabled]), input:not([hidden]), select')].filter(el => !el.hidden && el.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }
  function closeDirectionsIfOpen() { if (S.mode === "nav") exitNav(); if (S.mode === "dir") closeDirections(); }
  function openDrawer() {
    drawerReturnFocus = document.activeElement;
    syncSidebarPreferences();
    if (window.WFVenueInfo) window.WFVenueInfo.render();
    $("drawer").hidden = false; $("scrim").hidden = false;
    $("btnMenu").setAttribute("aria-expanded", "true"); $("drawerClose").focus();
  }
  function closeDrawer() {
    const wasOpen = !$("drawer").hidden;
    $("drawer").hidden = true; $("scrim").hidden = true; $("btnMenu").setAttribute("aria-expanded", "false");
    if (wasOpen && drawerReturnFocus && drawerReturnFocus.isConnected) drawerReturnFocus.focus();
  }
  function about() {
    S.mode = "about";
    setSheet(`<h1 class="pname">${esc(t("viewer.aboutTitle"))}</h1><p>${esc(t("viewer.aboutBody", { model: WF.cfg.matterport_model_id || "" }))}</p>
      <ul class="facts"><li><span class="ms">device_thermostat</span><div>Weather: <a href="https://api.met.no/" target="_blank" rel="noopener noreferrer">MET Norway</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></div></li><li><span class="ms">map</span><div>Basemaps: OpenFreeMap (© OpenMapTiles, © OpenStreetMap contributors, ODbL) · Esri World Imagery</div></li>
      <li><span class="ms">route</span><div>Routing: ngraph.path (MIT), turf.js (MIT), networkx + shapely (BSD) · OSM footways (ODbL)</div></li>
      <li><span class="ms">search</span><div>Search: Fuse.js (Apache-2.0) · Icons: Material Symbols (Apache-2.0) · Font: Roboto (Apache-2.0)</div></li>
      <li><span class="ms">keyboard</span><div>Keyboard: <b>/</b> search · <b>↑↓ Enter</b> pick · <b>Esc</b> close · <b>← →</b> steps while navigating</div></li></ul>`, "half");
  }
  function showLanguageSheet({ preservePosition = false } = {}) {
    if (!window.WFi18n) return;
    const body = $("sheetBody");
    const scrollTop = preservePosition ? body.scrollTop : 0;
    const focusedLanguage = preservePosition && body.contains(document.activeElement)
      ? document.activeElement.dataset.lang : null;
    S.mode = "language";
    const cur = WFi18n.getLocale();
    const rows = WFi18n.enabledCatalog().map(c => `
      <li><button class="ditem lang-pick" data-lang="${esc(c.code)}" aria-pressed="${c.code === cur}">
        <span>${esc(c.native)}</span>${c.code === cur ? '<span class="ms">check</span>' : ""}
      </button></li>`).join("");
    setSheet(`<h1 class="pname">${esc(t("common.language"))}</h1><ul class="facts lang-list">${rows}</ul>`, "half");
    $("sheetBody").querySelectorAll(".lang-pick").forEach(b => b.onclick = () => WFi18n.setLocale(b.dataset.lang));
    if (focusedLanguage) {
      const button = Array.from(body.querySelectorAll(".lang-pick")).find(b => b.dataset.lang === focusedLanguage);
      if (button) button.focus({ preventScroll: true });
    }
    body.scrollTop = scrollTop;
  }

  // ---------------- toast ----------------
  let toastT = null;
  function toast(msg, action, fn) {
    const t = $("toast"); t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button id="toastBtn">${esc(action)}</button>` : ""); t.hidden = false;
    if (action) $("toastBtn").onclick = () => { hideToast(); fn && fn(); };
    clearTimeout(toastT); if (!action) toastT = setTimeout(hideToast, Math.max(5000, String(msg).length * 65));
  }
  function hideToast() { $("toast").hidden = true; }

  // ---------------- "Destination reached" card (thumbs feedback) ----------------
  // Shared across Walkthrough Wayfinding, Tour interior, and Start Preview so the
  // arrival moment and route feedback look and behave identically everywhere,
  // regardless of which feature's own overlay happens to be on screen — this renders
  // in its own fixed, top-level overlay above all of them.
  let arrivalFeedbackGiven = false;
  function submitRouteFeedback(rating, meta) {
    try {
      const slug = (window.WF && WF.building && WF.building.slug)
        || pageQuery().get("b") || (window.WF && WF.cfg && WF.cfg.slug) || "";
      if (!slug) return;
      fetch(`/api/v1/public/buildings/${encodeURIComponent(slug)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating, context: (meta && meta.context) || "",
          route_from: (meta && meta.fromName) || null, route_to: (meta && meta.toName) || null,
        }),
      }).catch(() => { /* best-effort — never surface a failure to the user */ });
    } catch (_) { /* ignore */ }
  }
  function hideArrivalCard() {
    const el = $("wfArrivedCard");
    if (el) el.remove();
  }
  /** opts: { name, context, fromName, toName, onDone } */
  function showArrivalCard(opts) {
    opts = opts || {};
    hideArrivalCard();
    arrivalFeedbackGiven = false;
    const isRoutePreview = opts.context === "tour_interior";
    const arrivalTitle = isRoutePreview
      ? (t("viewer.routePreviewEnded") || "Route Preview Ended")
      : (t("viewer.destinationReached") || "Destination reached");
    const el = document.createElement("div");
    el.id = "wfArrivedCard";
    el.className = "wf-arrived";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-modal", "false");
    el.innerHTML = `
      <div class="wf-arrived-card">
        <div class="wf-arrived-ic" aria-hidden="true">&#x2713;</div>
        <strong class="wf-arrived-title">${esc(arrivalTitle)}</strong>
        <span class="wf-arrived-name">${opts.name ? esc(t("viewer.youArrived", { name: opts.name }) || ("You have arrived at " + opts.name + ".")) : ""}</span>
        <div class="wf-arrived-feedback">
          <span class="wf-arrived-feedback-lbl">${esc(t("viewer.howWasRoute") || "How was this route?")}</span>
          <div class="wf-arrived-thumbs">
            <button type="button" class="wf-thumb" data-rating="up" aria-label="${esc(t("viewer.thumbsUp") || "Good route")}"><span class="ms">thumb_up</span></button>
            <button type="button" class="wf-thumb" data-rating="down" aria-label="${esc(t("viewer.thumbsDown") || "Bad route")}"><span class="ms">thumb_down</span></button>
          </div>
        </div>
        <button class="wf-arrived-done" type="button">${esc(t("viewer.done") || "Done")}</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelectorAll(".wf-thumb").forEach(btn => {
      btn.onclick = () => {
        if (arrivalFeedbackGiven) return;
        arrivalFeedbackGiven = true;
        el.querySelectorAll(".wf-thumb").forEach(b => { b.disabled = true; });
        btn.classList.add("picked");
        submitRouteFeedback(btn.dataset.rating, opts);
        const lbl = el.querySelector(".wf-arrived-feedback-lbl");
        if (lbl) lbl.textContent = t("viewer.thanksForFeedback") || "Thanks for the feedback!";
      };
    });
    const doneBtn = el.querySelector(".wf-arrived-done");
    if (doneBtn) doneBtn.onclick = () => {
      hideArrivalCard();
      if (typeof opts.onDone === "function") opts.onDone();
    };
  }
  window.wfShowArrivalCard = showArrivalCard;
  window.wfHideArrivalCard = hideArrivalCard;

  window.wfUI = { S, categoryMarkerContext, categoryMarkerStyle, selectCategoryMarker, selectPlace: (id) => { const p = byId[id]; if (!p) { toast(t("viewer.placeMissing")); return; } selectPlace(p, { fly: true }); }, openDirections: (from, to, stepFree) => { const dest = byId[to]; if (!dest) { toast(t("viewer.placeMissing")); return; } S.from = from === "me" ? "me" : (from ? byId[from] : null); S.to = dest; S.stepFree = !!stepFree; openDirections(); },
    startNav: () => startNav(), navGo: (i) => navGo(i), exitNav: () => exitNav(), toggle3D, setStyle, share: (opts) => shareUrl(opts), toggleChip, renderAc: () => { $("q").focus(); }, preview3D, showHome, focusStep, setSheetState, toast };
})();
var wfShare;
