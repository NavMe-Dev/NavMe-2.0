/* Wayfinding admin – Vue 3 (global build, no bundler) + MapLibre GL JS. Talks to /api/v1/admin/*. */
const { createApp, reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick, toRaw } = Vue;
const API = (window.WF_ADMIN_API || "") + "/api/v1";
const store = reactive({ token: localStorage.getItem("wf_admin_token") || "", me: null, route: location.hash.slice(1) || "/", toast: "" });
window.WFAdminStore = store;
const CAT_COLORS = { room: "#1a73e8", hall: "#9334e6", corridor: "#5f6368", entrance: "#188038", stairs: "#e37400", elevator: "#e37400", restroom: "#0097a7",
  parking: "#1967d2", outdoor: "#34a853", info: "#f9ab00", office: "#1a73e8", worship: "#9334e6", kitchen: "#c5221f", other: "#80868b" };
const R = 6378137;

async function api(path, opts = {}) {
  const h = Object.assign({}, opts.headers || {});
  if (store.token) h.Authorization = "Bearer " + store.token;
  if (opts.json !== undefined) { h["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const r = await fetch(API + path, { ...opts, headers: h });
  if (r.status === 401) { store.token = ""; localStorage.removeItem("wf_admin_token"); go("/login"); throw new Error((window.WFi18n && WFi18n.t) ? WFi18n.t("admin.pleaseSignIn") : "Please sign in"); }
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.detail) ? (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)) : r.statusText);
  return body;
}
function go(p) { location.hash = p; }
window.addEventListener("hashchange", () => store.route = location.hash.slice(1) || "/");
function toast(msg) { store.toast = msg; clearTimeout(toast._t); toast._t = setTimeout(() => store.toast = "", 3500); }

// ---- i18n (shared /locales) ----
const I18N_CATALOG = (window.WFi18n && WFi18n.catalog) || [
  { code: "en", native: "English" }, { code: "es", native: "Español" }, { code: "fr", native: "Français" },
  { code: "de", native: "Deutsch" }, { code: "hi", native: "हिन्दी" }, { code: "kn", native: "ಕನ್ನಡ" }, { code: "ar", native: "العربية" }
];
const i18nTick = ref(0);
function t(key, vars) { i18nTick.value; return (window.WFi18n && WFi18n.t) ? WFi18n.t(key, vars) : key; }
function enabledFromBranding(br) {
  const raw = (br && (br.enabled_languages || br.enabledLanguages)) || null;
  let list = Array.isArray(raw) ? raw.slice() : ["en"];
  if (!list.includes("en")) list.unshift("en");
  const allow = new Set(I18N_CATALOG.map(c => c.code));
  list = list.filter(c => allow.has(c));
  return list.length ? list : ["en"];
}
function persistEnabledLocal(list) {
  try { localStorage.setItem("wf_enabled_languages", JSON.stringify(list)); } catch (e) {}
}
function loadEnabledLocal() {
  try {
    const j = JSON.parse(localStorage.getItem("wf_enabled_languages") || "null");
    if (Array.isArray(j) && j.length) return enabledFromBranding({ enabled_languages: j });
  } catch (e) {}
  return ["en"];
}
async function bootI18n(enabled) {
  if (!window.WFi18n) return;
  // Admin chrome offers the full first-cut catalog so operators can work in any language.
  // Public viewer still filters by branding.enabled_languages (persisted below for reference).
  const saved = enabledFromBranding({ enabled_languages: enabled || loadEnabledLocal() });
  persistEnabledLocal(saved);
  const all = I18N_CATALOG.map(c => c.code);
  await WFi18n.init({ enabled: all });
  WFi18n.onChange(() => { i18nTick.value++; });
}


function scanPreviewUrl(id, overlay = 1) {
  return `${API}/admin/scan-plans/${id}/preview.png?overlay=${overlay}&t=${Date.now()}&token=${encodeURIComponent(store.token)}`;
}
async function downloadAuth(path, filename) {
  const r = await fetch(API + path, { headers: { Authorization: "Bearer " + store.token } });
  if (!r.ok) throw new Error(await r.text() || r.statusText);
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function fileUrl(slug, p) { return `${API}/admin/buildings/${slug}/files/${p}?t=${Date.now()}&token=${encodeURIComponent(store.token)}`; }

// ---- geo helpers (model <-> WGS84 via 2x3 affine to EPSG:3857) ----
const Geo = {
  ll(A, x, y) { const X = A[0][0] * x + A[0][1] * y + A[0][2], Y = A[1][0] * x + A[1][1] * y + A[1][2]; return [X / R * 180 / Math.PI, Math.atan(Math.sinh(Y / R)) * 180 / Math.PI]; },
  model(A, lon, lat) { const X = lon * Math.PI / 180 * R, Y = R * Math.asinh(Math.tan(lat * Math.PI / 180)); const dx = X - A[0][2], dy = Y - A[1][2];
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0]; return [(A[1][1] * dx - A[0][1] * dy) / det, (-A[1][0] * dx + A[0][0] * dy) / det]; },
  // same math as POST /georef/finetune
  tune(A, c, lat, de, dn, drot) {
    const th = drot * Math.PI / 180, k = 1 / Math.cos(lat * Math.PI / 180), cs = Math.cos(th), sn = Math.sin(th);
    const L = [[cs * A[0][0] - sn * A[1][0], cs * A[0][1] - sn * A[1][1]], [sn * A[0][0] + cs * A[1][0], sn * A[0][1] + cs * A[1][1]]];
    const P = [A[0][0] * c[0] + A[0][1] * c[1] + A[0][2], A[1][0] * c[0] + A[1][1] * c[1] + A[1][2]];
    return [[L[0][0], L[0][1], P[0] - (L[0][0] * c[0] + L[0][1] * c[1]) + de * k], [L[1][0], L[1][1], P[1] - (L[1][0] * c[0] + L[1][1] * c[1]) + dn * k]];
  }
};

/* Basemaps: free Esri public MapServer rasters (no API key).
   Satellite = World Imagery. Map / Light / Dark = Street / Light Gray / Dark Gray.
   (Public viewer uses OpenFreeMap vectors; admin MapLibre keeps one raster "base" under indoor overlays.
   CARTO basemaps.cartocdn.com now requires an API key, so it is not used here.) */
const BASEMAP_KINDS = ["satellite", "map", "light", "dark"];
function normalizeBasemap(kind) {
  if (kind === "imagery") return "satellite";
  if (kind === "osm") return "map";
  return BASEMAP_KINDS.includes(kind) ? kind : "map";
}
function esriTiles(service) {
  return [`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`];
}
function baseStyle(kind) {
  kind = normalizeBasemap(kind);
  const ESRI_ATTR = 'Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community';
  const defs = {
    satellite: { tiles: esriTiles("World_Imagery"), tileSize: 256, maxzoom: 20, attribution: "Esri, Maxar, Earthstar Geographics" },
    map: { tiles: esriTiles("World_Street_Map"), tileSize: 256, maxzoom: 20, attribution: ESRI_ATTR },
    light: { tiles: esriTiles("Canvas/World_Light_Gray_Base"), tileSize: 256, maxzoom: 16, attribution: ESRI_ATTR },
    dark: { tiles: esriTiles("Canvas/World_Dark_Gray_Base"), tileSize: 256, maxzoom: 16, attribution: ESRI_ATTR }
  };
  const src = Object.assign({ type: "raster" }, defs[kind]);
  return { version: 8, sources: { base: src }, layers: [{ id: "base", type: "raster", source: "base" }] };
}
function applyBasemap(map, kind, beforeLayerId) {
  if (!map) return;
  kind = normalizeBasemap(kind);
  const s = baseStyle(kind).sources.base;
  let before = beforeLayerId;
  if (before && !map.getLayer(before)) before = undefined;
  if (!before) {
    try {
      const layers = (map.getStyle() && map.getStyle().layers) || [];
      const other = layers.find(l => l.id !== "base");
      if (other) before = other.id;
    } catch (e) { /* style not ready */ }
  }
  if (map.getLayer("base")) map.removeLayer("base");
  if (map.getSource("base")) map.removeSource("base");
  map.addSource("base", s);
  map.addLayer({ id: "base", type: "raster", source: "base" }, before);
}
function makeMap(el, b, kind = "satellite") {
  const c = (b.model_info && b.model_info.center) || { lon: b.lon || 0, lat: b.lat || 0 };
  const m = new maplibregl.Map({ container: el, style: baseStyle(kind), center: [c.lon, c.lat], zoom: 18.6, maxZoom: 22.5, attributionControl: { compact: true } });
  m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  try { m.dragRotate.disable(); } catch (e) { /* ok */ }
  return m;
}
function whenLoaded(m) { return new Promise(r => m.loaded() ? r() : m.once("load", r)); }
function setGeo(m, id, data) { const s = m.getSource(id); if (s) s.setData(data); }

/* Shared view modes (like public viewer): 2D | 3D | Satellite | Digital twin.
   Map modes use MapLibre; twin swaps the same block to Matterport Showcase. */
const VIEW_MODES = ["2d", "3d", "satellite", "twin", "matterpak"];
const MAP_STYLE_KINDS = ["map", "light", "dark"];
function isMapViewMode(mode) { return mode === "2d" || mode === "3d" || mode === "satellite"; }
function normalizeViewMode(mode) { return VIEW_MODES.includes(mode) ? mode : "2d"; }
function normalizeMapStyle(kind) {
  const k = normalizeBasemap(kind);
  return MAP_STYLE_KINDS.includes(k) ? k : "map";
}
function basemapKindForMode(mode, mapStyle) {
  if (mode === "satellite") return "satellite";
  return normalizeMapStyle(mapStyle);
}
/** Apply basemap + pitch for 2d / 3d / satellite. No-op for twin. */
function applyMapViewMode(map, mode, opts) {
  if (!map || !isMapViewMode(mode)) return;
  const before = opts && opts.beforeLayerId;
  applyBasemap(map, basemapKindForMode(mode, opts && opts.mapStyle), before);
  try {
    if (mode === "3d") {
      map.dragRotate.enable();
      if (map.touchPitch && map.touchPitch.enable) map.touchPitch.enable();
      const bearing = (opts && opts.bearing != null) ? opts.bearing : (map.getBearing() || -20);
      map.easeTo({ pitch: 55, bearing: bearing, duration: (opts && opts.duration) || 450 });
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration: (opts && opts.duration) || 350 });
      map.dragRotate.disable();
    }
  } catch (e) { /* style not ready */ }
  try { map.resize(); } catch (e) { /* ignore */ }
}
async function fetchShowcaseUrl(slug, params) {
  let q = "";
  if (params && typeof params === "object") {
    const sp = new URLSearchParams();
    Object.keys(params).forEach(k => { if (params[k] != null && params[k] !== "") sp.set(k, params[k]); });
    const s = sp.toString();
    if (s) q = "?" + s;
  }
  return (await api(`/admin/buildings/${slug}/showcase${q}`)).url;
}
const ViewModeBar = {
  props: { modelValue: { type: String, default: "2d" }, showTwin: { type: Boolean, default: true }, showMatterpak: { type: Boolean, default: false } },
  emits: ["update:modelValue"],
  template: `<div class="bstyle-bar view-mode-bar" role="group" aria-label="View mode">
    <button type="button" class="sm" :class="{on: modelValue==='2d'}" @click="$emit('update:modelValue','2d')">2D</button>
    <button type="button" class="sm" :class="{on: modelValue==='3d'}" @click="$emit('update:modelValue','3d')">3D</button>
    <button type="button" class="sm" :class="{on: modelValue==='satellite'}" @click="$emit('update:modelValue','satellite')">Satellite</button>
    <button type="button" class="sm" v-if="showTwin" :class="{on: modelValue==='twin'}" @click="$emit('update:modelValue','twin')">Digital twin</button>
    <button type="button" class="sm" v-if="showMatterpak" :class="{on: modelValue==='matterpak'}" @click="$emit('update:modelValue','matterpak')">MatterPak</button>
  </div>`
};
const MapStyleBar = {
  props: { modelValue: { type: String, default: "map" } },
  emits: ["update:modelValue"],
  template: `<div class="bstyle-bar" role="group" aria-label="Basemap style">
    <button type="button" class="sm" :class="{on: modelValue==='map'}" @click="$emit('update:modelValue','map')">Map</button>
    <button type="button" class="sm" :class="{on: modelValue==='light'}" @click="$emit('update:modelValue','light')">Light</button>
    <button type="button" class="sm" :class="{on: modelValue==='dark'}" @click="$emit('update:modelValue','dark')">Dark</button>
  </div>`
};
/** Option 2: Showcase-oriented tabs default to Digital twin when a model id exists. */
function preferredShowcaseViewMode(b, fallback) {
  if (b && b.matterport_model_id) return "twin";
  return fallback || "2d";
}
// ===================== components =====================
const Login = {
  template: `<div class="login card"><div class="login-brand"><img class="navme-logo" src="img/navme-logo.png" alt="NavMe" width="72" height="72"><h1>{{t("admin.brand")}}</h1><p class="muted small">Admin for NavMe</p></div>
    <form @submit.prevent="login"><label>{{t("admin.email")}}</label><input v-model="email" autocomplete="username" required>
    <label>{{t("admin.password")}}</label><input v-model="pw" type="password" autocomplete="current-password" required>
    <div class="row" style="margin-top:14px"><button class="primary" :disabled="busy">{{t("admin.signIn")}}</button></div>
    <div class="err" v-if="err">{{err}}</div></form>
    <p class="muted small">{{t("admin.adminsCli")}}</p>
    <div id="loginLang" style="margin-top:14px"></div></div>`,
  setup() {
    const email = ref(""), pw = ref(""), err = ref(""), busy = ref(false);
    onMounted(() => {
      const el = document.getElementById("loginLang");
      if (el && window.WFi18n) WFi18n.mountSwitcher(el, { className: "wf-lang-switch", alwaysShow: true });
    });
    async function login() {
      busy.value = true; err.value = "";
      try {
        const r = await fetch(API + "/auth/login", { method: "POST", body: new URLSearchParams({ username: email.value, password: pw.value }) });
        const j = await r.json(); if (!r.ok) throw new Error(j.detail || "login failed");
        store.token = j.access_token; localStorage.setItem("wf_admin_token", j.access_token); go("/");
      } catch (e) { err.value = e.message; } busy.value = false;
    }
    return { email, pw, err, busy, login, t, i18nTick };
  }
};

const Buildings = {
  template: `<div><div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">{{t("admin.buildings")}}</h1><button class="primary" @click="go('/new')">{{t("admin.addBuilding")}}</button></div>
    <div class="grid"><div class="card" v-for="b in list" :key="b.slug">
      <div class="row"><b class="grow" style="font-size:16px"><a :href="'#/b/'+b.slug">{{b.name}}</a></b><span class="badge" :class="stCls(b.status)">{{b.status}}</span></div>
      <div class="muted small">{{b.address || '—'}}</div>
      <div class="kv small" style="margin-top:10px"><div>Matterport model</div><div class="mono">{{b.matterport_model_id || '—'}}</div>
        <div>Venue</div><div>{{b.venue || '—'}}</div><div>Floors / POIs</div><div>{{b.floors.length}} / {{b.poi_count}}</div>
        <div>Published</div><div>{{b.published_version ? 'v'+b.published_version : 'not yet'}}</div>
        <div>Georef</div><div>{{b.georef ? (b.georef.mode + (b.georef.rms_m!=null ? ' · RMS '+b.georef.rms_m.toFixed(2)+' m' : '')) : '—'}}</div></div>
      <div class="row" style="margin-top:12px"><button @click="go('/b/'+b.slug)">{{t("admin.open")}}</button><a class="btn" :href="viewerUrl(b)" target="_blank" v-if="b.published_version">{{t("admin.viewer")}}</a><button class="danger" style="margin-left:auto" @click="del(b)">Delete</button></div>
    </div></div>
    <div class="card muted" v-if="!list.length && loaded">{{t("admin.noBuildings")}}</div></div>`,
  setup() {
    const list = ref([]), loaded = ref(false);
    onMounted(async () => { list.value = await api("/admin/buildings"); loaded.value = true; });
    async function del(b) {
      const typed = prompt(`Type the slug "${b.slug}" to permanently delete this building and its workspace files. This cannot be undone.`);
      if (typed === null) return;
      if (typed !== b.slug) { toast("Slug didn't match — not deleted."); return; }
      try {
        await api(`/admin/buildings/${b.slug}?delete_files=true`, { method: "DELETE" });
        list.value = list.value.filter(x => x.slug !== b.slug);
        toast(`Deleted ${b.slug}`);
      } catch (e) { toast(e.message); }
    }
    return { list, loaded, go, stCls, viewerUrl, del, t, i18nTick };
  }
};
function stCls(s) { return { published: "ok", ready: "blue", failed: "bad", processing: "run", queued: "run" }[s] || ""; }
function viewerUrl(b) { return (window.WF_VIEWER_URL || "/") + "?b=" + b.slug; }

const Wizard = {
  template: `<div><h1>{{t("admin.addBuildingTitle")}}</h1>
    <div class="steps"><span v-for="(s,i) in wizardSteps" :class="{on: step===i}">{{i+1}}. {{s}}</span></div>
    <div class="card" v-if="step===0">
      <h3 style="margin-top:0">Matterport model <span class="muted small">(optional)</span></h3>
      <label>Matterport model ID or Showcase URL</label>
      <div class="row"><input class="grow" v-model="f.matterport_model_id" @change="onModelChange" @paste="onPaste" placeholder="Hn36TwktGgz or https://my.matterport.com/show/?m=…" style="width:auto;flex:1" :disabled="busy"><button class="primary" @click="lookup" :disabled="!f.matterport_model_id||busy"><span v-if="busy" class="spinner"></span>{{busy ? 'Fetching…' : 'Fetch from Matterport'}}</button></div>
      <div class="progress-bar" v-if="busy"><div class="bar"></div></div>
      <p class="muted small" style="margin:8px 0 0">Fetches name, floors, sweeps, address, and coordinates from Matterport. Street-named models are geocoded when Matterport withholds geo.</p>
      <div v-if="mp" class="kv" style="margin-top:12px">
        <div>Name</div><div>{{mp.name}}</div>
        <div>Address</div><div>{{mp.address || '—'}}</div>
        <div>Floors</div><div>{{(mp.floors||[]).map(x=>x.label).join(', ') || mp.floor_count}}</div>
        <div>Sweeps</div><div>{{mp.sweeps}}</div>
        <div>Rooms</div><div>{{mp.rooms ?? '—'}}</div>
        <div>Coordinates</div><div>{{mp.lat != null ? (mp.lat+', '+mp.lon) : '—'}} <span class="muted" v-if="mp.geo_source">({{mp.geo_source}})</span></div>
        <div>Showcase</div><div><a :href="mp.showcase_url" target="_blank" rel="noopener">Open in Matterport ↗</a></div>
      </div>
      <div class="ok small" v-if="mp && filledFromMp" style="margin-top:8px">Details pre-filled below. Edit anything before creating.</div>

      <hr style="margin:18px 0;border:none;border-top:1px solid #e0e0e0">
      <h3 style="margin-top:0">Building details</h3>
      <label>Building name</label><input v-model="f.name" @input="autoslug" :disabled="created">
      <label>Slug (URL id)</label><input v-model="f.slug" pattern="[a-z0-9\-]+" :disabled="created">
      <label>Venue / campus (optional slug – buildings sharing a venue appear on one map)</label><input v-model="f.venue_slug" placeholder="e.g. main-campus" :disabled="created">
      <label>Address</label><div class="row"><input class="grow" v-model="f.address" style="width:auto;flex:1" :disabled="created"><button @click="geocode" :disabled="!f.address||busy||created">Geocode</button></div>
      <div class="row"><div class="grow"><label>Latitude</label><input v-model.number="f.lat" type="number" step="any" :disabled="created"></div><div class="grow"><label>Longitude</label><input v-model.number="f.lon" type="number" step="any" :disabled="created"></div></div>
      <div class="muted small" v-if="geo">{{geo}}</div>
      <label>SDK key reference (environment variable NAME holding the Matterport SDK key)</label><input v-model="f.sdk_key_ref" :disabled="created">
      <div class="err" v-if="err">{{err}}</div>
      <div class="row" style="margin-top:14px" v-if="!created"><button class="primary" @click="create" :disabled="!f.name||!f.slug||busy"><span v-if="busy" class="spinner"></span>{{busy ? 'Creating…' : 'Create building'}}</button></div>

      <template v-if="created">
        <hr style="margin:18px 0;border:none;border-top:1px solid #e0e0e0">
        <h3 style="margin-top:0">MatterPak source</h3>
        <template v-if="f.matterport_model_id">
          <p><b>Fetch straight from Matterport</b> (no file to upload): uses the Model API with the server's <code>MATTERPORT_TOKEN_ID</code>/<code>MATTERPORT_TOKEN_SECRET</code> for model <span class="mono">{{f.matterport_model_id}}</span>. Only works if the MatterPak add-on is unlocked (purchased) for this model &mdash; Matterport gates mesh export behind that regardless of credentials. Note: this pulls a bare, untextured mesh (no colour-plan images) &mdash; auto-georeference and texture overlays won't be available, so georeference via control points afterward. For the full textured MatterPak, export manually from the Matterport dashboard instead.</p>
          <div class="row"><button @click="checkMpApi" :disabled="busy"><span v-if="mpApiBusy" class="spinner"></span>{{ mpApiBusy ? 'Checking...' : 'Check availability' }}</button>
            <button class="primary" @click="fetchFromMatterport" :disabled="busy||mpApiChecked!=='available'"><span v-if="mpApiBusy" class="spinner"></span>{{ mpApiBusy ? 'Fetching...' : 'Fetch MatterPak from Matterport' }}</button></div>
          <div class="progress-bar" v-if="mpApiBusy"><div class="bar"></div></div>
          <div class="muted small" v-if="mpApiChecked==='available'" style="margin-top:6px">Available: OBJ mesh at {{mpApiResolutions.join(', ')}} resolution(s).</div>
          <div class="err" v-if="mpApiChecked==='locked'" style="margin-top:6px">MatterPak add-on is locked for this model - no mesh exposed via API. Export it manually from the Matterport dashboard and use the options below instead.</div>
          <div class="err" v-if="mpApiErr" style="margin-top:6px">{{mpApiErr}}</div>
          <hr style="margin:16px 0;border:none;border-top:1px solid #e0e0e0">
        </template>
        <p v-else class="muted small">Enter a Matterport model ID above to enable fetching the mesh via API — or use a manual source below.</p>
        <p><b>Recommended for files &gt;2&nbsp;GB:</b> copy the MatterPak zip / <code>.e57</code> onto the server, then paste the path below. Browser upload often hits 100 % then stalls on multi‑GB files.</p>
        <label>Server path (zip, .e57, or folder)</label>
        <div class="row"><input class="grow" v-model="serverPath" placeholder="/workspace/wayfinding/matterpak/&lt;slug&gt;/cloud_0.e57" style="width:auto;flex:1" list="matterpak-suggest"><button class="primary" @click="usePath" :disabled="!serverPath||busy"><span v-if="busy" class="spinner"></span>{{busy ? 'Checking…' : 'Use path'}}</button></div>
        <datalist id="matterpak-suggest"><option v-for="s in pathSuggestions" :value="s.path">{{s.label}}</option></datalist>
        <div class="muted small" style="margin-top:6px" v-if="pathSuggestions.length">Known on server: <button v-for="s in pathSuggestions.slice(0,6)" :key="s.path" type="button" class="linkish" style="margin-right:8px" @click="serverPath=s.path">{{s.label}}</button></div>
        <p class="muted small" style="margin-top:8px">Copy tip: place files under <code>/workspace/wayfinding/matterpak/&lt;slug&gt;/</code> (e.g. <code>mp_e57_*.zip</code> or extracted <code>cloud_0.e57</code>), then click a suggestion or paste the full path.</p>
        <hr style="margin:16px 0;border:none;border-top:1px solid #e0e0e0">
        <p class="muted">Smaller files only (&lt;2&nbsp;GB): browser upload of MatterPak zip, bare <code>.e57</code>, or Matterport E57 export zip.</p>
        <input type="file" accept=".zip,.e57,application/octet-stream" @change="onFile">
        <div class="row" style="margin-top:10px"><button @click="upload" :disabled="!file||busy||fileTooBig"><span v-if="busy" class="spinner"></span>{{busy ? 'Uploading…' : 'Upload'}}</button><span v-if="progress" class="muted">{{progress}}</span></div>
        <div class="err" v-if="fileTooBig" style="margin-top:8px">Selected file is {{(file.size/1e9).toFixed(2)}} GB. Browser upload will stall after 100 %. Use the server path above instead.</div>

        <div class="row" style="margin-top:14px"><button class="primary" @click="step=1">Continue to Process</button></div>
      </template>
    </div>
    <div class="card" v-if="step===1">
      <p>Matterport model: <span class="mono">{{f.matterport_model_id || '—'}}</span><br>MatterPak: <span class="mono">{{f.matterpak_path || '—'}}</span></p>
      <div class="err small" v-if="!f.matterport_model_id || !f.matterpak_path" style="margin-bottom:10px">Onboarding needs both a Matterport model id and a MatterPak source — go back and fill in whichever is missing.</div>
      <div class="row"><button @click="step=0">Back</button><button class="primary" @click="run" :disabled="busy||jobId||!f.matterport_model_id||!f.matterpak_path">Run onboarding pipeline</button>
        <a class="btn" :href="'#/b/'+f.slug" v-if="jobId">Open building →</a></div>
      <job-log v-if="jobId" :job-id="jobId" @done="d=>done=d"></job-log>
      <div v-if="done==='succeeded'" class="ok" style="margin-top:10px">Done. Review the georeference, edit POIs, then publish.</div>
      <div class="err" v-if="err">{{err}}</div></div></div>`,
  setup() {
    // Read pre-fill params from URL hash: #/new?slug=gcu&sid=Hn36TwktGgz&anon_key=eyJ...
    const _hq = new URLSearchParams(window.location.hash.replace(/^[^?]*\??/, ''));
    // A Matterport model id is bare alphanumeric. Reject anything else (e.g. a
    // NavMe map_code like MAP_145IOR54WU6P) so we don't prefill a bogus id.
    const _rawSid = (_hq.get('sid') || '').trim();
    const _preSid = /^[A-Za-z0-9]{6,64}$/.test(_rawSid) ? _rawSid : '';
    const _preSlug = _hq.get('slug') || '';
    const _anonKey = _hq.get('anon_key') || ''; // Supabase anon key for auto POI sync
    const step = ref(0), f = reactive({ matterport_model_id: _preSid, name: _preSlug, slug: _preSlug, venue_slug: "", address: "", lat: null, lon: null, sdk_key_ref: "MATTERPORT_SDK_KEY", matterpak_path: "" });
    const mp = ref(null), err = ref(""), busy = ref(false), geo = ref(""), file = ref(null), progress = ref(""), serverPath = ref(""), jobId = ref(null), done = ref(""), filledFromMp = ref(false), pathSuggestions = ref([]), fileTooBig = ref(false);
    const mpApiBusy = ref(false), mpApiChecked = ref(""), mpApiResolutions = ref([]), mpApiErr = ref("");
    const created = ref(false);
    const wrap = async (fn) => { busy.value = true; err.value = ""; try { await fn(); } catch (e) { err.value = e.message; } busy.value = false; };
    const normalizeModelId = (raw) => {
      const s = (raw || "").trim();
      const m = s.match(/[?&]m=([A-Za-z0-9]+)/); if (m) return m[1];
      const bare = s.replace(/[^A-Za-z0-9]/g, ""); return bare || s;
    };
    const applyMp = (info, { overwrite = true } = {}) => {
      mp.value = info;
      if (info.model_id) f.matterport_model_id = info.model_id;
      if (info.name && (overwrite || !f.name)) { f.name = info.name; autoslug(); }
      if (info.address && (overwrite || !f.address)) f.address = info.address;
      if (info.lat != null && (overwrite || f.lat == null)) { f.lat = info.lat; f.lon = info.lon; }
      if (info.geocode_label) geo.value = "From Matterport: " + info.geocode_label + (info.geo_source ? " (" + info.geo_source + ")" : "");
      else if (info.lat != null) geo.value = "Coordinates from " + (info.geo_source || "Matterport");
      filledFromMp.value = true;
    };
    const lookup = () => wrap(async () => {
      f.matterport_model_id = normalizeModelId(f.matterport_model_id);
      const info = await api("/admin/matterport/" + encodeURIComponent(f.matterport_model_id) + "?geocode=true");
      applyMp(info, { overwrite: !created.value });
      if (created.value) {
        await api(`/admin/buildings/${f.slug}`, { method: "PATCH", json: { matterport_model_id: f.matterport_model_id } });
        mpApiChecked.value = ""; mpApiResolutions.value = []; mpApiErr.value = "";
      }
    });
    const onModelChange = () => { f.matterport_model_id = normalizeModelId(f.matterport_model_id); if (f.matterport_model_id.length >= 8) lookup(); };
    const onPaste = () => setTimeout(onModelChange, 0);
    const autoslug = () => { if (created.value) return; f.slug = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60); };
    const geocode = () => wrap(async () => { const g = await api("/admin/geocode?q=" + encodeURIComponent(f.address)); f.lat = g.lat; f.lon = g.lon; geo.value = "Found: " + g.label; });
    const loadPathSuggestions = async () => {
      try { pathSuggestions.value = (await api("/admin/matterpak/suggestions")).paths || []; }
      catch (e) { pathSuggestions.value = []; }
    };
    const create = () => wrap(async () => {
      try {
        await api("/admin/buildings", { method: "POST", json: { ...f, venue_slug: f.venue_slug || null, matterpak_path: null } });
      } catch (e) {
        if (/slug exists/i.test(e.message)) throw new Error(`Slug "${f.slug}" is already used by another building — change the Slug field above and try again.`);
        throw e;
      }
      await loadPathSuggestions();
      created.value = true;
      // Auto-sync POIs from Supabase if opened from NavMe dashboard
      if (_anonKey && f.slug) {
        try {
          const origin = window.location.origin;
          await fetch(`${origin}/api/v1/public/dashboard/buildings/${f.slug}/sync-pois`, {
            method: "POST",
            headers: { "x-supabase-anon-key": _anonKey },
          });
        } catch { /* non-fatal */ }
      }
    });
    const onFile = (e) => {
      file.value = e.target.files[0] || null;
      fileTooBig.value = !!(file.value && file.value.size > 2 * 1024 * 1024 * 1024);
      if (fileTooBig.value) err.value = "File is over 2 GB — use server path (recommended).";
      else if (err.value && err.value.includes("2 GB")) err.value = "";
    };
    const upload = () => wrap(() => new Promise((res, rej) => {
      if (!file.value) return rej(new Error("choose a file"));
      if (file.value.size > 2 * 1024 * 1024 * 1024) {
        return rej(new Error("File is over 2 GB. Copy it onto the server and use the path field above."));
      }
      const fd = new FormData(); fd.append("file", file.value);
      const x = new XMLHttpRequest();
      x.open("POST", `${API}/admin/buildings/${f.slug}/matterpak`);
      x.setRequestHeader("Authorization", "Bearer " + store.token);
      x.timeout = 30 * 60 * 1000; // 30 min
      x.upload.onprogress = e => {
        if (!e.lengthComputable) { progress.value = "Uploading…"; return; }
        const pct = Math.round(e.loaded / e.total * 100);
        progress.value = pct >= 100 ? "Upload received — server verifying (zip/E57)…" : `Uploading ${pct} %`;
      };
      x.onload = () => {
        let j = {};
        try { j = JSON.parse(x.responseText || "{}"); } catch (parseErr) {
          return rej(new Error("Server returned an empty/invalid response after upload. For large files use the server path instead."));
        }
        const detail = typeof j.detail === "string" ? j.detail : (Array.isArray(j.detail) ? j.detail.map(d => d.msg || d).join("; ") : null);
        if (x.status >= 300) return rej(new Error(detail || x.statusText || ("HTTP " + x.status)));
        f.matterpak_path = j.path;
        if (j.format === "e57") {
          const extra = j.e57_files ? ` · ${j.e57_files.join(", ")}` : "";
          progress.value = `${(j.bytes / 1e6).toFixed(1)} MB · E57${extra} (mesh + colour plans built at ingest)`;
        } else progress.value = `${(j.bytes / 1e6).toFixed(1)} MB, ${j.files} files, ${j.colorplans} colour plans`;
        step.value = 1; res();
      };
      x.onerror = () => rej(new Error("Upload failed (network). For files ≳ 2 GB use the server path."));
      x.ontimeout = () => rej(new Error("Upload timed out. Copy the file onto the server and use the path field."));
      x.onabort = () => rej(new Error("Upload aborted"));
      x.send(fd);
    }));
    const usePath = () => wrap(async () => {
      const path = (serverPath.value || "").trim();
      if (!path) throw new Error("paste a server path");
      progress.value = "Checking path…";
      const j = await api(`/admin/buildings/${f.slug}/matterpak/path`, { method: "POST", json: { path } });
      f.matterpak_path = j.path;
      if (j.format === "e57" || (j.format || "").startsWith("e57")) {
        const extra = j.e57_files ? ` · ${j.e57_files.join(", ")}` : "";
        const sz = j.bytes != null ? `${(j.bytes / 1e9).toFixed(2)} GB · ` : "";
        progress.value = `${sz}E57${extra} (mesh + colour plans built at ingest)`;
      } else if (j.bytes != null) {
        progress.value = `${(j.bytes / 1e6).toFixed(1)} MB · ${j.format}`;
      } else progress.value = j.format || "path set";
      step.value = 1;
    });
    const checkMpApi = () => wrap(async () => {
      mpApiBusy.value = true; mpApiErr.value = ""; mpApiChecked.value = ""; mpApiResolutions.value = [];
      try {
        const j = await api(`/admin/buildings/${f.slug}/matterpak/matterport-availability`);
        mpApiChecked.value = j.available ? "available" : "locked";
        mpApiResolutions.value = j.resolutions || [];
      } catch (e) { mpApiErr.value = e.message; }
      mpApiBusy.value = false;
    });
    const fetchFromMatterport = () => wrap(async () => {
      mpApiBusy.value = true; mpApiErr.value = "";
      try {
        const j = await api(`/admin/buildings/${f.slug}/matterpak/fetch-from-matterport`, { method: "POST", json: {} });
        f.matterpak_path = j.path;
        progress.value = `${(j.bytes / 1e6).toFixed(1)} MB via Matterport API, ${j.resolution} resolution, ${j.colorplans || 0} colour plans`;
        step.value = 1;
      } catch (e) { mpApiErr.value = e.message; }
      mpApiBusy.value = false;
    });
    const run = () => wrap(async () => { const j = await api(`/admin/buildings/${f.slug}/jobs`, { method: "POST", json: {} }); jobId.value = j.id; });
    const wizardSteps = computed(() => { i18nTick.value; return [t("admin.wizardDetails"), t("admin.wizardProcess")]; });
    // Auto-fetch Matterport info when wizard opens with a pre-filled SID
    onMounted(() => { if (_preSid) lookup(); });
    return { step, f, mp, err, busy, geo, file, progress, serverPath, jobId, done, filledFromMp, pathSuggestions, fileTooBig, mpApiBusy, mpApiChecked, mpApiResolutions, mpApiErr, created, lookup, onModelChange, onPaste, autoslug, geocode, create, onFile, upload, usePath, checkMpApi, fetchFromMatterport, run, t, i18nTick, wizardSteps };
  }
};

const JobLog = {
  props: ["jobId"], emits: ["done"],
  template: `<div style="margin-top:12px"><div class="row"><b>Job #{{jobId}}</b><span class="badge" :class="stCls(st.status==='succeeded'?'published':st.status==='failed'?'failed':'processing')">{{st.status}}</span>
    <span class="muted" v-if="st.step">step: {{st.step}}</span></div><pre class="log" ref="pre">{{log}}</pre><div class="err" v-if="st.error">{{st.error}}</div></div>`,
  setup(props, { emit }) {
    const log = ref(""), st = reactive({ status: "queued", step: null, error: null }), pre = ref(null); let off = 0, t = null;
    async function poll() {
      try {
        const j = await api(`/admin/jobs/${props.jobId}?offset=${off}`);
        log.value += j.log; off = j.log_len; Object.assign(st, { status: j.status, step: j.step, error: j.error });
        await nextTick(); if (pre.value) pre.value.scrollTop = pre.value.scrollHeight;
        if (["succeeded", "failed", "cancelled"].includes(j.status)) { emit("done", j.status); return; }
      } catch (e) { }
      t = setTimeout(poll, 1500);
    }
    onMounted(poll); onBeforeUnmount(() => clearTimeout(t));
    watch(() => props.jobId, () => { log.value = ""; off = 0; clearTimeout(t); poll(); });
    return { log, st, pre, stCls };
  }
};

// ---------------- building page ----------------
const Building = {
  props: ["slug", "tab"],
  template: `<div v-if="b"><div class="row"><h1 class="grow" style="margin:0">{{b.name}}</h1><span class="badge" :class="stCls(b.status)">{{b.status}}</span>
      <a class="btn" :href="viewerUrl(b)" target="_blank" v-if="b.published_version">{{t("admin.openViewer")}}</a></div>
    <div class="muted" style="margin:4px 0 12px">{{b.address}}</div>
    <nav class="tabs"><a v-for="t in tabs" :href="'#/b/'+slug+'/'+t[0]" :class="{on: (tab||'overview')===t[0]}">{{t[1]}}</a></nav>
    <overview v-if="(tab||'overview')==='overview'" :b="b" @reload="load"></overview>
    <georef v-if="tab==='georef'" :b="b" @reload="load"></georef>
    <floors v-if="tab==='floors'" :b="b" @reload="load"></floors>
    <elevators v-if="sawElevators" v-show="tab==='elevators'" :b="b" @reload="load"></elevators>
    <media-panels v-if="sawMedia" v-show="tab==='media'" :b="b" @reload="load"></media-panels>
    <tour-modes v-if="sawTour" v-show="tab==='tour'" :b="b" @reload="load"></tour-modes>
    <access-settings v-if="sawAccess" v-show="tab==='access'" :b="b" @reload="load"></access-settings>
    <pois v-if="tab==='pois'" :b="b"></pois>
    <routes v-if="tab==='routes'" :b="b"></routes>
    <publish v-if="tab==='publish'" :b="b" @reload="load"></publish>
    <jobs v-if="tab==='jobs'" :b="b"></jobs></div>`,
  setup(props) {
    const b = ref(null);
    const sawElevators = ref((props.tab || "") === "elevators");
    const sawMedia = ref((props.tab || "") === "media");
    const sawTour = ref((props.tab || "") === "tour");
    const sawAccess = ref((props.tab || "") === "access");
    const tabs = computed(() => { i18nTick.value; return [
      ["overview", t("admin.overview")], ["georef", t("admin.georeference")], ["floors", t("admin.floors")],
      ["elevators", t("admin.elevators")],
      ["media", t("admin.media") || "Media"],
      ["tour", t("admin.tour") || "Tour"],
      ["access", t("admin.access") || "Access"],
      ["pois", t("admin.pois")], ["routes", t("admin.routeTester")], ["publish", t("admin.publish")], ["jobs", t("admin.jobs")]
    ]; });
    async function load() {
      b.value = await api("/admin/buildings/" + props.slug);
      persistEnabledLocal(enabledFromBranding(b.value && b.value.branding));
    }
    onMounted(load); watch(() => props.slug, load);
    watch(() => props.tab, (tab) => {
      if (tab === "elevators") sawElevators.value = true;
      if (tab === "media") sawMedia.value = true;
      if (tab === "tour") sawTour.value = true;
      if (tab === "access") sawAccess.value = true;
    });
    return { b, tabs, load, sawElevators, sawMedia, sawTour, sawAccess, stCls, viewerUrl, t, i18nTick };
  }
};

const Overview = {
  props: ["b"], emits: ["reload"],
  template: `<div class="split"><div>
    <div class="card"><h2 style="margin-top:0">{{t("admin.modelDetails")}}</h2><div class="kv">
      <div>Matterport model ID</div><div class="mono">{{b.matterport_model_id}} <a :href="'https://my.matterport.com/show/?m='+b.matterport_model_id" target="_blank">Showcase ↗</a></div>
      <div>Matterport name</div><div>{{mi.mp_name||'—'}}</div>
      <div>Dimensions</div><div>{{mi.dimensions ? (mi.dimensions.width||0).toFixed(1)+' × '+(mi.dimensions.depth||0).toFixed(1)+' × '+(mi.dimensions.height||0).toFixed(1)+' m, floor area '+Math.round(mi.dimensions.areaFloor||0)+' m²' : '—'}}</div>
      <div>Floors / sweeps / rooms</div><div>{{mi.floors||'—'}} / {{mi.sweeps||'—'}} / {{mi.rooms||'—'}}</div>
      <div>Nav graph</div><div>{{st.nav_nodes||'—'}} nodes, {{st.nav_edges||'—'}} edges, {{st.entrances||0}} entrances<span v-if="st.nav_nodes">, step-free entrance: <b :class="st.step_free_entrance?'ok':'err'">{{st.step_free_entrance?'yes':'no'}}</b></span></div>
      <div>MatterPak</div><div class="mono small">{{b.matterpak_path||'—'}}<span v-if="mi.manifest"> · {{mi.manifest.colorplans.length}} colour plans, {{mi.manifest.textures}} textures</span></div>
      <div>SDK key</div><div>env <code>{{b.sdk_key_ref}}</code>: <span :class="b.sdk_key_configured?'ok':'muted'">{{b.sdk_key_configured?'configured':'not set (Showcase preview works without; SDK features need it)'}}</span></div>
      <div>Georeference</div><div>{{b.georef ? b.georef.mode+' · rotation '+b.georef.rotation_deg.toFixed(2)+'°'+(b.georef.rms_m!=null?' · RMS '+b.georef.rms_m.toFixed(2)+' m':'')+(b.georef.auto&&b.georef.auto.ncc?' · NCC '+b.georef.auto.ncc:'') : '—'}}</div>
      <div>Centre</div><div class="mono">{{mi.center ? mi.center.lat.toFixed(6)+', '+mi.center.lon.toFixed(6) : '—'}}</div></div></div>
    <div class="card"><h2 style="margin-top:0">{{t("admin.buildingSettings")}}</h2>
      <div class="row"><div class="grow"><label>{{t("admin.name")}}</label><input v-model="e.name"></div><div class="grow"><label>{{t("admin.venue")}}</label><input v-model="e.venue_slug"></div></div>
      <label>{{t("admin.address")}}</label><input v-model="e.address">
      <div class="row"><div class="grow"><label>{{t("admin.brandColour")}}</label><input v-model="e.primary_color" placeholder="#1a73e8"></div><div class="grow"><label>{{t("admin.icon")}}</label><input v-model="e.icon" placeholder="apartment"></div></div>
      <label>{{t("admin.enabledLanguages")}}</label>
      <div class="lang-checks">
        <label v-for="loc in localeCatalog" :key="loc.code">
          <input type="checkbox" :value="loc.code" v-model="e.enabled_languages" :disabled="loc.code==='en'">
          <span>{{loc.native}} <span class="muted small">({{loc.code}})</span></span>
        </label>
      </div>
      <p class="muted small">{{t("admin.enabledLanguagesHelp")}}</p>
      <label>{{t("admin.pipelineOptions")}}</label><textarea class="mono" v-model="e.pipeline" rows="5"></textarea>
      <p class="muted small">Elevators: <a :href="'#/b/'+b.slug+'/elevators'">Elevators</a>. Media: <a :href="'#/b/'+b.slug+'/media'">Media</a>. Tour: <a :href="'#/b/'+b.slug+'/tour'">Tour</a>. Access (twin gate + restricted paths): <a :href="'#/b/'+b.slug+'/access'">Access</a>. Same <code>pipeline_config</code> (elevators + media_panels + tour_modes + access).</p>
      <label style="margin-top:12px">Debug mode (this building)</label>
      <select v-model="e.debug_override" style="max-width:280px">
        <option value="inherit">Inherit global (Dashboard)</option>
        <option value="on">Force ON</option>
        <option value="off">Force OFF</option>
      </select>
      <p class="muted small">Global toggle: <a href="#/dashboard">Dashboard</a>. Override is saved with building settings; <b>Publish</b> writes <code>config.debug</code>. Live clients also poll <code>/api/v1/public/debug/status</code>.</p>
      <div class="row" style="margin-top:10px"><button class="primary" @click="save">{{t("common.save")}}</button><span class="ok" v-if="saved">{{t("common.saved")}}</span><span class="err" v-if="err">{{err}}</span></div></div>
    <div class="card"><h2 style="margin-top:0">MatterPak / E57 path</h2>
      <p class="muted small" style="margin-top:0">For files &gt;2&nbsp;GB, copy onto the box then set the path here (browser upload stalls after 100 %).</p>
      <div class="row"><input class="grow" v-model="mpPath" placeholder="/workspace/wayfinding/matterpak/&lt;slug&gt;/cloud_0.e57" style="width:auto;flex:1"><button class="primary" @click="setMpPath" :disabled="!mpPath||mpBusy">Use path</button></div>
      <div class="muted small" style="margin-top:6px" v-if="mpSuggestions.length">
        <button v-for="s in mpSuggestions.slice(0,8)" :key="s.path" type="button" class="linkish" style="margin-right:8px" @click="mpPath=s.path">{{s.label}}</button>
      </div>
      <div class="ok" v-if="mpOk" style="margin-top:6px">{{mpOk}}</div>
      <div class="ok" v-if="mpOk" style="margin-top:6px">{{mpOk}}</div>
      <div class="err" v-if="mpErr" style="margin-top:6px">{{mpErr}}</div>
      <hr style="margin:16px 0;border:none;border-top:1px solid #e0e0e0">
      <p class="muted small" style="margin-top:0">Smaller files only (&lt;2 GB): upload a MatterPak zip, bare .e57, or Matterport E57 export zip from this device.</p>
      <input type="file" accept=".zip,.e57,application/octet-stream" @change="onMpFile">
      <div class="row" style="margin-top:10px"><button @click="uploadMp" :disabled="!mpFile||mpUpBusy||mpFileTooBig"><span v-if="mpUpBusy" class="spinner"></span>{{mpUpBusy ? 'Uploading...' : 'Upload'}}</button><span v-if="mpUpProgress" class="muted">{{mpUpProgress}}</span></div>
      <div class="err" v-if="mpFileTooBig" style="margin-top:8px">Selected file is {{(mpFile.size/1e9).toFixed(2)}} GB. Browser upload will stall after 100%. Use the server path above instead.</div>
    <div class="card"><h2 style="margin-top:0">{{t("admin.pipeline")}}</h2>
      <div class="row"><button class="primary" @click="run({})">{{t("admin.runUpdate")}}</button>
        <select v-model="from" style="width:auto"><option value="">{{t("admin.rebuildFrom")}}</option><option v-for="s in steps" :value="s">{{s}}</option></select>
        <button @click="run({from_step: from, force: true})" :disabled="!from">{{t("admin.rebuild")}}</button></div>
      <job-log v-if="jobId" :job-id="jobId" @done="$emit('reload')"></job-log></div>
    <div class="card" style="border-color:#d93025">
      <h2 style="margin-top:0;color:#d93025">Danger zone</h2>
      <p class="muted small" style="margin-top:0">Permanently delete this building: database rows (floors, POIs, jobs, map versions, nav graph) and, if checked, its workspace files on disk (MatterPak, uploads, published bundles). This cannot be undone.</p>
      <label><input type="checkbox" v-model="delFiles"> Also delete files on disk</label>
      <div class="row" style="margin-top:10px"><button class="danger" @click="deleteBuilding" :disabled="delBusy">{{delBusy ? 'Deleting…' : 'Delete building'}}</button></div>
      <div class="err" v-if="delErr" style="margin-top:8px">{{delErr}}</div>
    </div></div>
    <div>
      <div class="mapwrap overview-mapwrap">
        <div class="map" ref="mapEl" v-show="viewMode!=='twin'"></div>
        <iframe class="showcase map-twin-frame" v-show="viewMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
        <div class="toolbar">
          <view-mode-bar v-model="viewMode"></view-mode-bar>
          <template v-if="viewMode!=='twin'">
            <map-style-bar v-if="viewMode==='2d'||viewMode==='3d'" v-model="mapStyle"></map-style-bar>
            <span class="small muted">Building centre · switch modes like the public viewer</span>
          </template>
          <template v-else>
            <button class="sm primary" @click="reloadTwin" :disabled="scBusy">{{scBusy ? 'Loading…' : (sc ? 'Reload' : 'Open Showcase')}}</button>
            <button class="sm" @click="closeTwin" v-if="sc">Close</button>
          </template>
        </div>
        <div class="twin-status map-twin-status" v-if="viewMode==='twin' && scBusy">Loading Showcase…</div>
        <div class="twin-status map-twin-status err" v-else-if="viewMode==='twin' && scErr">{{scErr}}</div>
        <p class="map-help" v-if="viewMode==='twin'">Matterport Showcase for this building. No SDK key needed for preview. Whitelist this host on the Matterport SDK key for SDK place / Tour.</p>
        <p class="map-help" v-else-if="viewMode==='3d'">3D pitched MapLibre view (admin best-effort; full ArcGIS mesh is on the public viewer).</p>
        <p class="map-help" v-else-if="viewMode==='satellite'">Satellite imagery at the building centre. Use Georeference to align the 3D model.</p>
        <p class="map-help" v-else>2D map at the building centre. Switch to Digital twin for Matterport Showcase.</p>
      </div>
      <div class="card" v-if="b.georef" style="margin-top:12px"><h2 style="margin-top:0">{{t("admin.georefPreview")}}</h2>
        <img :src="fileUrl(b.slug,'work/georef_preview.jpg')" style="width:100%;border-radius:8px" alt="colour plan over imagery">
        <p class="muted small" v-if="(b.georef.auto&&b.georef.auto.ncc!=null&&b.georef.auto.ncc<0.35)">Auto match looks weak (NCC {{Number(b.georef.auto.ncc).toFixed(2)}}). Align the floor plan to satellite manually.</p>
        <div class="row" style="margin-top:10px"><a class="btn primary" :href="'#/b/'+b.slug+'/georef'">Align 3D model to satellite</a></div>
      </div>
      <div class="card" v-else style="margin-top:12px">
        <h2 style="margin-top:0">Align to satellite</h2>
        <p class="muted small">No georeference yet. Run the pipeline through georef, then open the align tool.</p>
        <div class="row"><a class="btn" :href="'#/b/'+b.slug+'/georef'">Open Georeference</a></div>
      </div></div></div>`,
  setup(props, { emit }) {
    const mi = computed(() => props.b.model_info || {}), st = computed(() => (props.b.model_info || {}).stats || {});
    function debugOvFromPc(pc) {
      const o = (window.WFDebugConfig && WFDebugConfig.parseOverride((pc || {}).debug));
      return o === true ? "on" : o === false ? "off" : "inherit";
    }
    const e = reactive({ name: props.b.name, address: props.b.address, venue_slug: props.b.venue || "", primary_color: (props.b.branding || {}).primary_color || "", icon: (props.b.branding || {}).icon || "",
      enabled_languages: enabledFromBranding(props.b.branding),
      pipeline: JSON.stringify(props.b.pipeline_config || {}, null, 1),
      debug_override: debugOvFromPc(props.b.pipeline_config) });
    const localeCatalog = I18N_CATALOG;
    const saved = ref(false), err = ref(""), jobId = ref(null), from = ref(""), sc = ref(""), scBusy = ref(false), scErr = ref(""), viewMode = ref(preferredShowcaseViewMode(props.b, "satellite")), mapStyle = ref("map");
    const mapEl = ref(null); let overviewMap = null;
    const mpPath = ref(props.b.matterpak_path || ""), mpSuggestions = ref([]), mpBusy = ref(false), mpOk = ref(""), mpErr = ref("");
    const mpFile = ref(null), mpFileTooBig = ref(false), mpUpBusy = ref(false), mpUpProgress = ref("");
    async function reloadTwin() {
      scBusy.value = true; scErr.value = "";
      try { sc.value = await fetchShowcaseUrl(props.b.slug); }
      catch (x) { sc.value = ""; scErr.value = x.message || "Could not load Showcase"; }
      scBusy.value = false;
    }
    function closeTwin() { sc.value = ""; scErr.value = ""; }
    function syncOverviewMap() {
      if (!overviewMap || !isMapViewMode(viewMode.value)) return;
      applyMapViewMode(overviewMap, viewMode.value, { mapStyle: mapStyle.value });
    }
    onMounted(async () => {
      try { mpSuggestions.value = (await api("/admin/matterpak/suggestions")).paths || []; } catch (e) {}
      await nextTick();
      if (mapEl.value) {
        overviewMap = makeMap(mapEl.value, props.b, basemapKindForMode(viewMode.value, mapStyle.value));
        await whenLoaded(overviewMap);
        syncOverviewMap();
      }
      if (viewMode.value === "twin" && !sc.value && !scBusy.value) reloadTwin();
    });
    onBeforeUnmount(() => { if (overviewMap) overviewMap.remove(); overviewMap = null; });
    watch(viewMode, async (m) => {
      if (m === "twin") {
        await nextTick();
        if (!sc.value && !scBusy.value) reloadTwin();
      } else {
        await nextTick();
        syncOverviewMap();
      }
    });
    watch(mapStyle, () => { if (viewMode.value === "2d" || viewMode.value === "3d") syncOverviewMap(); });
    async function setMpPath() {
      mpBusy.value = true; mpOk.value = ""; mpErr.value = "";
      try {
        const j = await api(`/admin/buildings/${props.b.slug}/matterpak/path`, { method: "POST", json: { path: mpPath.value.trim() } });
        mpOk.value = `Path set: ${j.path}` + (j.bytes != null ? ` (${(j.bytes/1e9).toFixed(2)} GB, ${j.format})` : ` (${j.format})`);
        mpPath.value = j.path;
        emit("reload");
      } catch (e) { mpErr.value = e.message; }
      mpBusy.value = false;
    }
    function onMpFile(ev) {
      mpFile.value = ev.target.files[0] || null;
      mpFileTooBig.value = !!(mpFile.value && mpFile.value.size > 2 * 1024 * 1024 * 1024);
      mpErr.value = mpFileTooBig.value ? "File is over 2 GB — use server path above instead." : "";
    }
    function uploadMp() {
      return new Promise((res, rej) => {
        if (!mpFile.value) return rej(new Error("choose a file"));
        if (mpFile.value.size > 2 * 1024 * 1024 * 1024) return rej(new Error("File is over 2 GB. Copy it onto the server and use the path field above."));
        mpUpBusy.value = true; mpErr.value = ""; mpOk.value = "";
        const fd = new FormData(); fd.append("file", mpFile.value);
        const x = new XMLHttpRequest();
        x.open("POST", `${API}/admin/buildings/${props.b.slug}/matterpak`);
        x.setRequestHeader("Authorization", "Bearer " + store.token);
        x.timeout = 30 * 60 * 1000;
        x.upload.onprogress = e => {
          if (!e.lengthComputable) { mpUpProgress.value = "Uploading…"; return; }
          const pct = Math.round(e.loaded / e.total * 100);
          mpUpProgress.value = pct >= 100 ? "Upload received — server verifying (zip/E57)…" : `Uploading ${pct} %`;
        };
        x.onload = () => {
          mpUpBusy.value = false;
          let j = {};
          try { j = JSON.parse(x.responseText || "{}"); } catch (e) { return rej(new Error("Server returned an empty/invalid response after upload. For large files use the server path instead.")); }
          const detail = typeof j.detail === "string" ? j.detail : (Array.isArray(j.detail) ? j.detail.map(d => d.msg || d).join("; ") : null);
          if (x.status >= 300) return rej(new Error(detail || x.statusText || ("HTTP " + x.status)));
          mpPath.value = j.path;
          mpOk.value = j.format === "e57"
            ? `${(j.bytes / 1e6).toFixed(1)} MB · E57${j.e57_files ? " · " + j.e57_files.join(", ") : ""} (mesh + colour plans built at ingest)`
            : `${(j.bytes / 1e6).toFixed(1)} MB, ${j.files} files, ${j.colorplans} colour plans`;
          mpFile.value = null; mpUpProgress.value = "";
          emit("reload");
          res();
        };
        x.onerror = () => { mpUpBusy.value = false; rej(new Error("Upload failed (network). For files ≳ 2 GB use the server path.")); };
        x.ontimeout = () => { mpUpBusy.value = false; rej(new Error("Upload timed out. Copy the file onto the server and use the path field.")); };
        x.onabort = () => { mpUpBusy.value = false; rej(new Error("Upload aborted")); };
        x.send(fd);
      }).catch(e => { mpErr.value = e.message; mpUpBusy.value = false; });
    }

    const steps = ["ingest", "fetch_mp", "mesh", "colorplan", "imagery", "georef", "floors", "overlays", "glb", "voxel", "osm", "graph", "navmesh", "pois", "indoor", "thumbs", "export"];
    watch(() => props.b, (nb) => {
      if (!nb) return;
      e.name = nb.name; e.address = nb.address; e.venue_slug = nb.venue || "";
      e.primary_color = (nb.branding || {}).primary_color || ""; e.icon = (nb.branding || {}).icon || "";
      e.enabled_languages = enabledFromBranding(nb.branding);
      e.pipeline = JSON.stringify(nb.pipeline_config || {}, null, 1);
      e.debug_override = debugOvFromPc(nb.pipeline_config);
    });
    async function save() {
      err.value = ""; saved.value = false;
      try {
        let pc = JSON.parse(e.pipeline || "{}");
        const ov = e.debug_override === "on" ? true : e.debug_override === "off" ? false : null;
        if (window.WFDebugConfig) pc = WFDebugConfig.mergePipeline(pc, ov);
        else if (ov === null) delete pc.debug; else pc.debug = { enabled: ov };
        // keep textarea in sync
        e.pipeline = JSON.stringify(pc, null, 1);
        let langs = enabledFromBranding({ enabled_languages: e.enabled_languages });
        e.enabled_languages = langs;
        await api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { name: e.name, address: e.address, venue_slug: e.venue_slug || null, pipeline_config: pc,
          branding: { ...(props.b.branding || {}), primary_color: e.primary_color || undefined, icon: e.icon || undefined, enabled_languages: langs } } });
        persistEnabledLocal(langs);
        saved.value = true; emit("reload");
      } catch (x) { err.value = x.message; }
    }
    async function run(p) { try { const j = await api(`/admin/buildings/${props.b.slug}/jobs`, { method: "POST", json: p }); jobId.value = j.id; } catch (x) { toast(x.message); } }
    const delFiles = ref(true), delBusy = ref(false), delErr = ref("");
    async function deleteBuilding() {
      const typed = prompt(`Type the slug "${props.b.slug}" to permanently delete this building. This cannot be undone.`);
      if (typed === null) return;
      if (typed !== props.b.slug) { delErr.value = "Slug didn't match — not deleted."; return; }
      delBusy.value = true; delErr.value = "";
      try {
        await api(`/admin/buildings/${props.b.slug}?delete_files=${delFiles.value}`, { method: "DELETE" });
        go("/");
      } catch (x) { delErr.value = x.message; }
      delBusy.value = false;
    }
    return { mi, st, e, saved, err, save, run, jobId, from, steps, sc, scBusy, scErr, viewMode, mapStyle, mapEl, reloadTwin, closeTwin, fileUrl, t, i18nTick, localeCatalog, mpPath, mpSuggestions, mpBusy, mpOk, mpErr, setMpPath, mpFile, mpFileTooBig, mpUpBusy, mpUpProgress, onMpFile, uploadMp, delFiles, delBusy, delErr, deleteBuilding };
  }
};

const Georef = {
  props: ["b"], emits: ["reload"],
  template: `<div>
    <div class="card" style="margin-bottom:12px">
      <h2 style="margin-top:0">Align 3D model to satellite</h2>
      <p class="muted small" style="margin-top:0">The coloured floor plan is the top-down of your Matterport / MatterPak mesh. Slide and rotate it until walls and roof edges match the satellite imagery under it. Then <b>Save fine-tune</b> and <b>Apply &amp; rebuild</b> so routes and the public map use the new transform.</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="sm" :class="{primary: tool==='nudge'}" @click="tool='nudge'">Drag to move</button>
        <button class="sm" :class="{primary: tool==='rotate'}" @click="tool='rotate'">Drag to rotate</button>
        <button class="sm" :class="{primary: tool==='pick'||picking}" @click="startPick">{{picking ? pickMsg : 'Control points'}}</button>
        <button class="sm" @click="rerunAuto" :disabled="!!jobId">Re-run auto align</button>
        <span class="muted small" v-if="nccHint">{{nccHint}}</span>
      </div>
    </div>
    <div class="split"><div class="mapwrap">
      <div class="map" ref="el" v-show="viewMode!=='twin'" :class="{dragging: dragOn}"></div>
      <iframe class="showcase map-twin-frame" v-show="viewMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
      <div class="toolbar">
        <view-mode-bar v-model="viewMode" :show-matterpak="true"></view-mode-bar>
        <template v-if="viewMode==='matterpak'"></template>
        <template v-else-if="viewMode!=='twin'">
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="o in overlays" :value="o.id">{{o.id}}</option></select>
          <span class="small">Opacity</span><input type="range" min="0" max="1" step="0.05" v-model.number="opacity" style="width:110px" aria-label="Plan opacity">
          <map-style-bar v-if="viewMode==='2d'||viewMode==='3d'" v-model="mapStyle"></map-style-bar>
          <button type="button" class="sm" v-if="viewMode==='satellite'" :class="{primary: hybridLabels}" @click="toggleHybrid" title="Overlay place/road labels on the satellite imagery">{{hybridLabels ? 'Hybrid ✓' : 'Hybrid labels'}}</button>
          <span class="small muted">{{toolHint}}</span>
        </template>
        <template v-else>
          <button class="sm primary" @click="openTwin" :disabled="scBusy">{{scBusy ? 'Loading…' : (sc ? 'Reload Showcase' : 'Open Showcase')}}</button>
          <button class="sm" @click="closeTwin" v-if="sc">Close</button>
          <span class="small muted">Alignment tools stay on 2D / 3D / Satellite</span>
        </template>
      </div>
      <div class="twin-status map-twin-status err" v-if="viewMode==='twin' && scErr">{{scErr}}</div>
      <p class="map-help">{{helpText}}</p>
    </div>
    <div class="side"><div class="card"><h2 style="margin-top:0">Transform</h2>
      <div class="kv small"><div>Mode</div><div>{{g.mode}}</div><div>Rotation</div><div>{{rot.toFixed(3)}}°</div><div>Origin</div><div class="mono">{{g.model_origin_wgs84 ? g.model_origin_wgs84.lat.toFixed(7)+', '+g.model_origin_wgs84.lon.toFixed(7) : ''}}</div>
        <div>CP RMS</div><div>{{g.rms_m!=null ? g.rms_m.toFixed(3)+' m' : '—'}}</div><div v-if="g.auto">Auto NCC</div><div v-if="g.auto">{{g.auto.ncc}}</div></div>
      <h2>Fine-tune</h2><div class="row"><div class="nudge">
        <span></span><button @click="nudge(0,step)" title="north">↑</button><span></span>
        <button @click="nudge(-step,0)" title="west">←</button><button @click="reset" title="reset">•</button><button @click="nudge(step,0)" title="east">→</button>
        <span></span><button @click="nudge(0,-step)" title="south">↓</button><span></span></div>
        <div><div class="row"><button class="sm" @click="nudge(0,0,rstep)">⟲ {{rstep}}°</button><button class="sm" @click="nudge(0,0,-rstep)">⟳ {{rstep}}°</button></div>
          <div class="row small" style="margin-top:6px">step <select v-model.number="step" style="width:auto"><option :value="0.05">5 cm</option><option :value="0.1">10 cm</option><option :value="0.5">50 cm</option><option :value="2">2 m</option><option :value="5">5 m</option><option :value="10">10 m</option></select>
            <select v-model.number="rstep" style="width:auto"><option :value="0.05">0.05°</option><option :value="0.1">0.1°</option><option :value="0.5">0.5°</option><option :value="2">2°</option><option :value="5">5°</option><option :value="15">15°</option></select></div></div></div>
      <div class="small muted">Pending: {{d.e.toFixed(2)}} m E, {{d.n.toFixed(2)}} m N, {{d.r.toFixed(2)}}°</div>
      <div class="row" style="margin-top:8px"><button class="primary" @click="saveTune" :disabled="!dirty">Save fine-tune</button><button @click="rebuild">Apply & rebuild downstream</button></div>
      <h2>Mode</h2><div class="row"><select v-model="mode" style="width:auto"><option value="auto">auto (imagery match)</option><option value="control_points">control points</option><option value="fixed">fixed (fine-tuned)</option></select><button @click="setMode">Set</button></div></div>
    <div class="card"><h2 style="margin-top:0">Control points</h2><p class="small muted">Use the <b>Control points</b> tool above: click a feature on the floor-plan overlay, then the same feature on the satellite.</p>
      <table><tr><th>#</th><th>model x,y</th><th>lat, lon</th><th>resid.</th><th></th></tr>
        <tr v-for="c in cps" :key="c.id"><td>{{c.id}}</td><td class="mono">{{c.model_x.toFixed(2)}}, {{c.model_y.toFixed(2)}}</td><td class="mono">{{c.lat.toFixed(6)}}, {{c.lon.toFixed(6)}}</td>
          <td>{{c.residual_m!=null ? c.residual_m.toFixed(2)+' m' : ''}}</td><td><button class="sm danger" @click="delCp(c)">✕</button></td></tr></table>
      <div class="row" style="margin-top:8px"><button @click="fit(false)" :disabled="cps.length<2">Fit (preview residuals)</button><button class="primary" @click="fit(true)" :disabled="cps.length<2">Fit & apply</button></div>
      <div class="small" v-if="fitRes">RMS {{fitRes.rms_m.toFixed(3)}} m, max {{fitRes.max_err_m.toFixed(3)}} m, rotation {{fitRes.rotation_deg.toFixed(3)}}°</div></div>
    <job-log v-if="jobId" :job-id="jobId" @done="onJobDone"></job-log></div></div></div>`,
  setup(props, { emit }) {
    const el = ref(null), data = reactive({ georef: null, overlays: [], control_points: [] });
    const floor = ref(null), opacity = ref(0.65), step = ref(0.5), rstep = ref(0.5), d = reactive({ e: 0, n: 0, r: 0 });
    const picking = ref(false), pickMsg = ref(""), fitRes = ref(null), jobId = ref(null), mode = ref("auto");
    const tool = ref("nudge"), dragOn = ref(false), viewMode = ref(preferredShowcaseViewMode(props.b, "satellite")), mapStyle = ref("map"), sc = ref(""), scBusy = ref(false), scErr = ref("");
    const hybridLabels = ref(false);
    let pick1 = null, map = null, cpMarkers = [], dragStart = null, scrollRaf = null, lastDragXY = null;
    const g = computed(() => data.georef || {}), overlays = computed(() => data.overlays || []), cps = computed(() => data.control_points || []);
    const dirty = computed(() => d.e || d.n || d.r);
    const nccHint = computed(() => {
      const n = g.value.auto && g.value.auto.ncc;
      if (n == null) return "";
      if (n < 0.35) return "Auto match is weak (NCC " + Number(n).toFixed(2) + "). Drag the plan on the satellite until edges line up.";
      return "";
    });
    const toolHint = computed(() => {
      if (picking.value) return pickMsg.value;
      if (tool.value === "rotate") return "Drag left/right on the map to rotate the model";
      if (tool.value === "nudge") return "Drag on the map to slide the model over the basemap";
      return "";
    });
    const helpText = computed(() => {
      if (viewMode.value === "twin") return "Digital twin preview. Switch to Satellite (best) or 2D / 3D to align the coloured plan.";
      if (viewMode.value === "3d") return "3D pitched view — drag still nudges/rotates the plan overlay. Satellite mode is usually easier for roof edges.";
      if (viewMode.value === "2d") return "2D map under the coloured plan. Use Map / Light / Dark styles; Satellite mode is best for roof edges.";
      return "Align the coloured plan to satellite imagery. Drag to move / rotate, then Save fine-tune.";
    });
    function syncMapPresentation() {
      if (!map || !isMapViewMode(viewMode.value)) return;
      applyMapViewMode(map, viewMode.value, { beforeLayerId: "plan", mapStyle: mapStyle.value });
      syncHybridLayer();
    }
    function syncHybridLayer() {
      if (!map) return;
      const want = viewMode.value === "satellite" && hybridLabels.value;
      try {
        if (map.getLayer("hybrid-labels")) map.removeLayer("hybrid-labels");
        if (map.getSource("hybrid-labels")) map.removeSource("hybrid-labels");
        if (want) {
          map.addSource("hybrid-labels", { type: "raster", tiles: esriTiles("Reference/World_Boundaries_and_Places"), tileSize: 256, maxzoom: 20 });
          const before = map.getLayer("plan") ? "plan" : undefined;
          map.addLayer({ id: "hybrid-labels", type: "raster", source: "hybrid-labels" }, before);
        }
      } catch (e) { /* style not ready */ }
    }
    function toggleHybrid() { hybridLabels.value = !hybridLabels.value; syncHybridLayer(); }
    async function openTwin() {
      scBusy.value = true; scErr.value = "";
      try { sc.value = await fetchShowcaseUrl(props.b.slug); }
      catch (x) { sc.value = ""; scErr.value = x.message || "Could not load Showcase"; }
      scBusy.value = false;
    }
    function closeTwin() { sc.value = ""; scErr.value = ""; }
    const center = () => { const c = props.b.model_info.center; return [Geo.model(g.value.model_to_epsg3857_affine, c.lon, c.lat), c.lat]; };
    const curA = () => { const [c, lat] = center(); return Geo.tune(g.value.model_to_epsg3857_affine, c, lat, d.e, d.n, d.r); };
    const rot = computed(() => { if (!g.value.model_to_epsg3857_affine) return 0; d.e; d.n; d.r; const A = curA(); return Math.atan2(A[1][0], A[0][0]) * 180 / Math.PI; });
    async function load() { Object.assign(data, await api(`/admin/buildings/${props.b.slug}/georef`)); mode.value = g.value.mode || "auto"; if (!floor.value && data.overlays && data.overlays.length) floor.value = data.overlays[data.overlays.length - 1].id; }
    function draw() {
      if (!map || !data.overlays) return;
      const o = data.overlays.find(x => x.id === floor.value); if (!o) return;
      if (!g.value.model_to_epsg3857_affine) return;
      const A = curA(); const coords = o.corners_model.map(c => Geo.ll(A, c[0], c[1]));
      const src = map.getSource("plan");
      if (src) { src.setCoordinates(coords); if (src._fid !== o.id) { src.updateImage({ url: fileUrl(props.b.slug, "out/" + o.image), coordinates: coords }); src._fid = o.id; } }
      else { map.addSource("plan", { type: "image", url: fileUrl(props.b.slug, "out/" + o.image), coordinates: coords }); map.getSource("plan")._fid = o.id;
        map.addLayer({ id: "plan", type: "raster", source: "plan", paint: { "raster-opacity": opacity.value, "raster-fade-duration": 0 } }); }
      map.setPaintProperty("plan", "raster-opacity", opacity.value);
      cpMarkers.forEach(m => m.remove()); cpMarkers = [];
      cps.value.forEach(c => { const e1 = document.createElement("div"); e1.className = "cp-marker"; cpMarkers.push(new maplibregl.Marker({ element: e1 }).setLngLat([c.lon, c.lat]).addTo(map));
        const e2 = document.createElement("div"); e2.className = "cp-marker model"; cpMarkers.push(new maplibregl.Marker({ element: e2 }).setLngLat(Geo.ll(A, c.model_x, c.model_y)).addTo(map)); });
    }
    function metersDelta(a, b) {
      const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;
      const de = (b.lng - a.lng) * Math.PI / 180 * R * Math.cos(lat);
      const dn = (b.lat - a.lat) * Math.PI / 180 * R;
      return { de, dn };
    }
    onMounted(async () => {
      await load();
      map = makeMap(el.value, props.b, basemapKindForMode(viewMode.value, mapStyle.value));
      await whenLoaded(map);
      syncMapPresentation();
      draw();
      map.on("click", async (ev) => {
        if (viewMode.value === "twin" || !picking.value) return;
        if (!pick1) { pick1 = Geo.model(curA(), ev.lngLat.lng, ev.lngLat.lat); pickMsg.value = "2/2: click the true location on the satellite"; return; }
        await api(`/admin/buildings/${props.b.slug}/control_points`, { method: "POST", json: { model_x: pick1[0], model_y: pick1[1], lat: ev.lngLat.lat, lon: ev.lngLat.lng, label: "admin pick" } });
        picking.value = false; pick1 = null; await load(); draw(); toast("Control point added");
      });
      map.on("mousedown", (ev) => {
        if (viewMode.value === "twin" || picking.value || !(tool.value === "nudge" || tool.value === "rotate")) return;
        if (ev.originalEvent && ev.originalEvent.button !== 0) return;
        dragOn.value = true;
        dragStart = { lngLat: ev.lngLat, e: d.e, n: d.n, r: d.r };
        map.dragPan.disable();
        ev.preventDefault();
      });
      map.on("mousemove", (ev) => {
        if (!dragOn.value || !dragStart) return;
        if (tool.value === "nudge") {
          const { de, dn } = metersDelta(dragStart.lngLat, ev.lngLat);
          d.e = dragStart.e + de; d.n = dragStart.n + dn;
        } else if (tool.value === "rotate") {
          // horizontal drag: ~0.15° per pixel
          const dx = (ev.point.x - map.project(dragStart.lngLat).x);
          d.r = dragStart.r + dx * 0.15;
        }
        draw();
        // Edge auto-pan: if the cursor nears the map container's edge while dragging,
        // keep scrolling the base map underneath so you're not stuck in one screenful
        // (the overlay nudge above is computed from real geo coords, so it keeps
        // tracking correctly regardless of how much the camera pans).
        if (ev.originalEvent) {
          lastDragXY = { x: ev.originalEvent.clientX, y: ev.originalEvent.clientY };
          if (!scrollRaf) scrollRaf = requestAnimationFrame(edgeScrollTick);
        }
      });
      function edgeScrollTick() {
        if (!dragOn.value || !lastDragXY || !el.value) { scrollRaf = null; return; }
        const rect = el.value.getBoundingClientRect();
        const margin = 50, maxSpeed = 12;
        const { x, y } = lastDragXY;
        let vx = 0, vy = 0;
        if (x - rect.left < margin) vx = -maxSpeed * (1 - Math.max(0, x - rect.left) / margin);
        else if (rect.right - x < margin) vx = maxSpeed * (1 - Math.max(0, rect.right - x) / margin);
        if (y - rect.top < margin) vy = -maxSpeed * (1 - Math.max(0, y - rect.top) / margin);
        else if (rect.bottom - y < margin) vy = maxSpeed * (1 - Math.max(0, rect.bottom - y) / margin);
        if (vx || vy) map.panBy([vx, vy], { animate: false });
        scrollRaf = requestAnimationFrame(edgeScrollTick);
      }
      const endDrag = () => {
        if (!dragOn.value) return;
        dragOn.value = false; dragStart = null; map.dragPan.enable();
        if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
        lastDragXY = null;
      };
      map.on("mouseup", endDrag); map.on("mouseleave", endDrag);
      window.addEventListener("keydown", onKey);
      if (viewMode.value === "twin" && !sc.value && !scBusy.value) openTwin();
    });
    function onKey(ev) {
      if (!el.value || !document.body.contains(el.value)) return;
      const tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (ev.key === "ArrowUp") { nudge(0, step.value); ev.preventDefault(); }
      else if (ev.key === "ArrowDown") { nudge(0, -step.value); ev.preventDefault(); }
      else if (ev.key === "ArrowLeft") { nudge(-step.value, 0); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { nudge(step.value, 0); ev.preventDefault(); }
      else if (ev.key === "[" || ev.key === ",") { nudge(0, 0, rstep.value); ev.preventDefault(); }
      else if (ev.key === "]" || ev.key === ".") { nudge(0, 0, -rstep.value); ev.preventDefault(); }
    }
    onBeforeUnmount(() => { window.removeEventListener("keydown", onKey); if (scrollRaf) cancelAnimationFrame(scrollRaf); map && map.remove(); });
    watch([floor, opacity], draw);
    watch(tool, (v) => { if (v !== "pick") { picking.value = false; pick1 = null; } });
    watch(viewMode, async (m) => {
      if (m === "twin") {
        picking.value = false; dragOn.value = false;
        await nextTick();
        if (!sc.value && !scBusy.value) openTwin();
      } else {
        await nextTick();
        syncMapPresentation();
        draw();
      }
    });
    watch(mapStyle, () => { if (viewMode.value === "2d" || viewMode.value === "3d") { syncMapPresentation(); draw(); } });
    function startPick() {
      tool.value = "pick";
      picking.value = !picking.value;
      pick1 = null;
      pickMsg.value = "1/2: click a feature on the floor plan";
    }
    function nudge(e, n, r = 0) { d.e += e; d.n += n; d.r += r; draw(); }
    function reset() { d.e = d.n = d.r = 0; draw(); }
    async function saveTune() {
      const res = await api(`/admin/buildings/${props.b.slug}/georef/finetune`, { method: "POST", json: { d_east_m: d.e, d_north_m: d.n, d_rot_deg: d.r, auto_rebuild: true } });
      reset(); await load(); draw();
      if (res.job_id) { jobId.value = res.job_id; toast("Transform saved. Rebuilding routes in the background…"); }
      else toast("Transform saved (mode = fixed). Rebuild to update maps and routes.");
      emit("reload");
    }
    async function delCp(c) { await api(`/admin/buildings/${props.b.slug}/control_points/${c.id}`, { method: "DELETE" }); await load(); draw(); }
    async function fit(apply) { try { fitRes.value = await api(`/admin/buildings/${props.b.slug}/georef/fit?apply=${apply}`, { method: "POST" }); await load(); draw(); if (apply) toast("Applied – rebuild downstream to regenerate maps"); } catch (e) { toast(e.message); } }
    async function setMode() { await api(`/admin/buildings/${props.b.slug}/georef/mode`, { method: "POST", json: { mode: mode.value } }); toast("Mode set to " + mode.value); }
    async function rebuild() { if (dirty.value) await saveTune(); try { const j = await api(`/admin/buildings/${props.b.slug}/jobs`, { method: "POST", json: { from_step: "georef", force: true } }); jobId.value = j.id; } catch (e) { toast(e.message); } }
    async function rerunAuto() {
      try {
        await api(`/admin/buildings/${props.b.slug}/georef/mode`, { method: "POST", json: { mode: "auto" } });
        mode.value = "auto";
        const j = await api(`/admin/buildings/${props.b.slug}/jobs`, { method: "POST", json: { from_step: "georef", force: true } });
        jobId.value = j.id;
        toast("Re-running automatic satellite alignment…");
      } catch (e) { toast(e.message); }
    }
    async function onJobDone() { await load(); draw(); emit("reload"); }
    return { el, floor, opacity, step, rstep, d, g, overlays, cps, rot, dirty, picking, pickMsg, fitRes, jobId, mode, tool, dragOn, viewMode, mapStyle, hybridLabels, toggleHybrid, sc, scBusy, scErr, toolHint, helpText, nccHint, startPick, nudge, reset, saveTune, delCp, fit, setMode, rebuild, rerunAuto, onJobDone, openTwin, closeTwin };
  }
};

const Floors = {
  props: ["b"], emits: ["reload"],
  template: `<div class="split floors-split">
    <div class="mapwrap floors-visual-wrap">
      <div class="floors-plan" v-show="visMode==='plan'">
        <img v-if="planUrl" :src="planUrl" :alt="'Colour plan '+selFid" @error="onPlanErr">
        <div class="map-empty" v-else><p>{{planHint}}</p></div>
      </div>
      <div class="map" ref="mapEl" v-show="visMode==='map'"></div>
      <iframe class="showcase map-twin-frame" v-show="visMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
      <div class="toolbar">
        <label class="tb-label">Floor</label>
        <select v-model="selFid" style="width:auto" aria-label="Floor"><option v-for="f in floorChoices" :value="f.fid">{{f.label || f.fid}}</option></select>
        <div class="bstyle-bar" role="group" aria-label="Floor visual">
          <button type="button" class="sm" :class="{on: visMode==='plan'}" @click="visMode='plan'">Floor plan</button>
          <button type="button" class="sm" :class="{on: visMode==='map'}" @click="visMode='map'">Indoor map</button>
          <button type="button" class="sm" v-if="hasModel" :class="{on: visMode==='twin'}" @click="visMode='twin'">Digital twin</button>
        </div>
        <template v-if="visMode==='twin'">
          <button class="sm primary" @click="reloadTwin" :disabled="scBusy">{{scBusy ? 'Loading…' : (sc ? 'Reload' : 'Open Showcase')}}</button>
          <button class="sm" @click="closeTwin" v-if="sc">Close</button>
        </template>
        <map-style-bar v-if="visMode==='map'" v-model="mapStyle"></map-style-bar>
      </div>
      <div class="twin-status map-twin-status" v-if="visMode==='twin' && scBusy">Loading Showcase…</div>
      <div class="twin-status map-twin-status err" v-else-if="visMode==='twin' && scErr">{{scErr}}</div>
      <p class="map-help" v-if="visMode==='plan'">MatterPak colour plan for the selected floor (by ordinal). Switch to Indoor map for draft/published GeoJSON, or Digital twin for Showcase.</p>
      <p class="map-help" v-else-if="visMode==='map'">Indoor map for this floor when <code>out/indoor_*.geojson</code> or a published bundle exists. Otherwise basemap only.</p>
      <p class="map-help" v-else>Matterport Showcase context for floor labels / twin navigation. Edit labels in the table; twin is preview-only here.</p>
    </div>
    <div class="side">
      <div class="card"><h2 style="margin-top:0">Floors</h2>
        <p class="muted small" v-if="!rows.length">No draft floors in the DB (visual still uses published / MatterPak colour plans). Re-run pipeline import or rebuild from floors when workspace has <code>floors_resolved.json</code>.</p>
        <table v-if="rows.length"><tr><th>ID</th><th>Label</th><th>Short</th><th>Order</th><th>Elevation (model m)</th><th>Height (m)</th><th>Matterport floor</th></tr>
          <tr v-for="f in rows" :key="f.fid" :class="{on: f.fid===selFid}" @click="selFid=f.fid"><td class="mono">{{f.fid}}</td><td><input v-model="f.label"></td><td><input v-model="f.short_label" style="width:60px"></td>
            <td><input type="number" v-model.number="f.ordinal" style="width:70px"></td><td><input type="number" step="0.01" v-model.number="f.elevation_m" style="width:110px"></td>
            <td><input type="number" step="0.05" v-model.number="f.height_m" style="width:90px"></td><td class="mono small">{{f.mp_floor_id}}</td></tr></table>
        <p class="small muted">Labels/order apply at the next publish. Elevation/height change floor bands (walls, walk grid): rebuild from <b>floors</b> afterwards.</p>
        <div class="row"><button class="primary" @click="save">Save</button><button @click="rebuild">Save & rebuild from floors</button><span class="ok" v-if="ok">Saved</span></div>
        <job-log v-if="jobId" :job-id="jobId" @done="$emit('reload')"></job-log>
      </div>
    </div>
  </div>`,
  setup(props) {
    const rows = ref(JSON.parse(JSON.stringify(props.b.floors || [])));
    const ok = ref(false), jobId = ref(null);
    const visFloors = ref([]); // visual picker only (DB rows and/or published floors.json)
    const selFid = ref(rows.value.length ? rows.value[0].fid : "F1");
    const visMode = ref("plan");
    const mapStyle = ref("map");
    const mapEl = ref(null);
    const planUrl = ref("");
    const planHint = ref("No colour plan found for this floor yet.");
    const sc = ref(""), scBusy = ref(false), scErr = ref("");
    const hasModel = computed(() => !!(props.b && props.b.matterport_model_id));
    const floorChoices = computed(() => (rows.value.length ? rows.value : visFloors.value));
    let map = null;
    let pubFloorMeta = {};
    function planIndexForFid(fid) {
      const list = floorChoices.value;
      const sorted = list.slice().sort((a, b) => (a.ordinal != null ? a.ordinal : 0) - (b.ordinal != null ? b.ordinal : 0));
      const i = sorted.findIndex(f => f.fid === fid);
      return i >= 0 ? i : 0;
    }
    async function resolvePlanUrl() {
      planUrl.value = "";
      const meta = pubFloorMeta[selFid.value] || {};
      // Prefer published raster named in floors.json
      if (meta.image) {
        const pub = `/api/v1/public/buildings/${props.b.slug}/data/${meta.image}`;
        try {
          const r = await fetch(pub, { method: "HEAD" });
          if (r.ok) { planUrl.value = pub; planHint.value = ""; return; }
        } catch (e) {}
      }
      const idx = planIndexForFid(selFid.value);
      const pad = String(idx).padStart(3, "0");
      const fromMeta = meta.colorplan ? [String(meta.colorplan).split("/").pop()] : [];
      const names = fromMeta.concat([`colorplan_${pad}_small.jpg`, `colorplan_${pad}.jpg`, `colorplan_${pad}.png`]);
      for (const name of names) {
        const rel = name.startsWith("work/") ? name : `work/matterpak/${name}`;
        const url = fileUrl(props.b.slug, rel);
        try {
          const r = await fetch(url, { method: "HEAD" });
          if (r.ok) { planUrl.value = url; planHint.value = ""; return; }
        } catch (e) { /* try next */ }
      }
      if (props.b.published_version) {
        const pub = `/api/v1/public/buildings/${props.b.slug}/data/floor_${selFid.value}.webp`;
        try {
          const r = await fetch(pub, { method: "HEAD" });
          if (r.ok) { planUrl.value = pub; planHint.value = ""; return; }
        } catch (e) {}
      }
      for (const rel of ["work/colorplan_match.png", "work/georef_preview.jpg"]) {
        const url = fileUrl(props.b.slug, rel);
        try {
          const r = await fetch(url, { method: "HEAD" });
          if (r.ok) {
            planUrl.value = url;
            planHint.value = "Showing shared colour-plan match / georef preview (per-floor MatterPak plan missing).";
            return;
          }
        } catch (e) {}
      }
      planHint.value = "No colour plan image for this floor. Run pipeline colourplan / overlays, or open Indoor map / Digital twin.";
    }
    function onPlanErr() {
      planUrl.value = "";
      planHint.value = "Colour plan failed to load.";
    }
    async function loadIndoorAny() {
      if (!map) return;
      try {
        const fc = await fetch(fileUrl(props.b.slug, `out/indoor_${selFid.value}.geojson`), { headers: { Authorization: "Bearer " + store.token } }).then(r => { if (!r.ok) throw new Error("no draft"); return r.json(); });
        setGeo(map, "indoor", fc);
        return;
      } catch (e) {}
      try {
        const fc = await fetch(`/api/v1/public/buildings/${props.b.slug}/data/indoor_${selFid.value}.geojson`).then(r => { if (!r.ok) throw new Error("no pub"); return r.json(); });
        setGeo(map, "indoor", fc);
      } catch (e) {
        setGeo(map, "indoor", { type: "FeatureCollection", features: [] });
      }
    }
    async function ensureMap() {
      await nextTick();
      if (!mapEl.value) return;
      if (!map) {
        map = makeMap(mapEl.value, props.b, basemapKindForMode("2d", mapStyle.value));
        await whenLoaded(map);
        indoorLayers(map);
      }
      applyMapViewMode(map, "2d", { beforeLayerId: "units", mapStyle: mapStyle.value });
      await loadIndoorAny();
      try { map.resize(); } catch (e) {}
    }
    async function reloadTwin() {
      if (!hasModel.value) { scErr.value = "No Matterport model id"; return; }
      scBusy.value = true; scErr.value = "";
      try { sc.value = await fetchShowcaseUrl(props.b.slug); }
      catch (x) { sc.value = ""; scErr.value = x.message || "Could not load Showcase"; }
      scBusy.value = false;
    }
    function closeTwin() { sc.value = ""; scErr.value = ""; }
    async function save() {
      if (!rows.value.length) { toast("No draft floors in DB to save — re-import pipeline floors first"); return; }
      await api(`/admin/buildings/${props.b.slug}/floors`, { method: "PUT", json: rows.value.map(({ mp_floor_id, ...r }) => r) });
      ok.value = true;
    }
    async function rebuild() { await save(); try { jobId.value = (await api(`/admin/buildings/${props.b.slug}/jobs`, { method: "POST", json: { from_step: "floors", force: true } })).id; } catch (e) { toast(e.message); } }
    async function loadVisFloors() {
      pubFloorMeta = {};
      visFloors.value = [];
      try {
        const pub = await fetch(`/api/v1/public/buildings/${props.b.slug}/data/floors.json`).then(r => r.ok ? r.json() : null);
        if (pub && Array.isArray(pub.floors) && pub.floors.length) {
          visFloors.value = pub.floors.map((f, i) => {
            const fid = f.id || f.fid || ("F" + (i + 1));
            pubFloorMeta[fid] = { image: f.image || "", colorplan: f.colorplan || "" };
            return { fid, label: f.label || fid, short_label: f.short || "", ordinal: f.ordinal != null ? f.ordinal : i, elevation_m: 0, height_m: 3, mp_floor_id: "" };
          });
          if (!rows.value.length) selFid.value = visFloors.value[0].fid;
        }
      } catch (e) {}
      if (!floorChoices.value.length) {
        visFloors.value = [{ fid: "F1", label: "Floor 1", short_label: "1", ordinal: 0 }];
        selFid.value = "F1";
      } else if (!floorChoices.value.find(f => f.fid === selFid.value)) {
        selFid.value = floorChoices.value[0].fid;
      }
    }
    onMounted(async () => { await loadVisFloors(); await resolvePlanUrl(); });
    onBeforeUnmount(() => { if (map) map.remove(); map = null; });
    watch(selFid, async () => {
      if (visMode.value === "plan") await resolvePlanUrl();
      if (visMode.value === "map") await loadIndoorAny();
    });
    watch(visMode, async (m) => {
      if (m === "plan") await resolvePlanUrl();
      else if (m === "map") await ensureMap();
      else if (m === "twin") {
        await nextTick();
        if (!sc.value && !scBusy.value) reloadTwin();
      }
    });
    watch(mapStyle, () => { if (visMode.value === "map" && map) applyMapViewMode(map, "2d", { beforeLayerId: "units", mapStyle: mapStyle.value }); });
    watch(() => props.b && props.b.floors, (fl) => {
      rows.value = JSON.parse(JSON.stringify(fl || []));
      if (rows.value.length && !rows.value.find(f => f.fid === selFid.value)) selFid.value = rows.value[0].fid;
    }, { deep: true });
    return { rows, ok, save, rebuild, jobId, selFid, visMode, mapStyle, mapEl, planUrl, planHint, onPlanErr, sc, scBusy, scErr, hasModel, reloadTwin, closeTwin, floorChoices };
  }
};

// shared: indoor + POI map
function indoorLayers(map) {
  map.addSource("indoor", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "units", type: "fill", source: "indoor", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": ["match", ["get", "style"], "building", "#eceff1", "walkway", "#ffffff", "stairs", "#e1d5f5", "hall", "#fff1d6", "#e8f0fe"], "fill-opacity": 0.85, "fill-outline-color": "#9aa0a6" } });
  map.addLayer({ id: "walls", type: "line", source: "indoor", filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "style"], "wall"]], paint: { "line-color": "#5f6368", "line-width": 2 } });
  map.addLayer({ id: "doors", type: "line", source: "indoor", filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "style"], ["literal", ["door", "entrance"]]]], paint: { "line-color": ["match", ["get", "style"], "entrance", "#188038", "#34a853"], "line-width": 3 } });
  map.addLayer({ id: "labels", type: "symbol", source: "indoor", filter: ["all", ["==", ["geometry-type"], "Polygon"], ["has", "name"]], layout: { "text-field": ["get", "name"], "text-size": 11 }, paint: { "text-color": "#3c4043", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
}
async function loadIndoor(map, slug, floor) {
  try { const fc = await fetch(fileUrl(slug, `out/indoor_${floor}.geojson`), { headers: { Authorization: "Bearer " + store.token } }).then(r => r.json()); setGeo(map, "indoor", fc); } catch (e) { }
}

const Pois = {
  props: ["b"],
  template: `<div class="split"><div class="mapwrap">
      <div class="map" ref="el" v-show="viewMode!=='twin'"></div>
      <iframe class="showcase map-twin-frame" v-show="viewMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
      <div class="toolbar">
        <view-mode-bar v-model="viewMode"></view-mode-bar>
        <template v-if="viewMode!=='twin'">
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="f in b.floors" :value="f.fid">{{f.label}}</option></select>
          <button class="sm" :class="{primary: adding}" @click="adding=!adding" :disabled="!isMapMode">{{adding ? 'Click map to place…' : '+ Add POI'}}</button>
          <map-style-bar v-if="viewMode==='2d'||viewMode==='3d'" v-model="mapStyle"></map-style-bar>
          <input v-model="q" placeholder="Filter…" style="width:140px" aria-label="Filter POIs">
        </template>
        <template v-else>
          <button class="sm primary" @click="preview" :disabled="scBusy || !sel">{{scBusy ? 'Loading…' : (sc ? 'Reload at POI sweep' : 'Open at POI sweep')}}</button>
          <button class="sm" @click="closePreview" v-if="sc">Close</button>
          <span class="small muted" v-if="!sel">Select a POI to open Showcase at its nearest sweep</span>
          <span class="small muted" v-else>{{sel.name}} · {{sel.nearest_sweep_label || sel.nearest_node || 'no sweep'}}</span>
        </template>
      </div>
      <div class="twin-status map-twin-status err" v-if="viewMode==='twin' && scErr">{{scErr}}</div>
      <div class="twin-status map-twin-status" v-else-if="viewMode==='twin' && scBusy">Loading Showcase…</div>
      <div class="map-empty" v-if="viewMode==='twin' && !sel"><p>Select a POI to open the digital twin at its nearest sweep.</p></div>
      <p class="map-help">{{helpText}}</p>
    </div>
    <div class="side">
      <div class="card" v-if="sel"><div class="row"><b class="grow">{{sel.key}}</b><span class="badge">{{sel.source}}</span><button class="sm" @click="sel=null">✕</button></div>
        <label>Name</label><input v-model="sel.name">
        <div class="row"><div class="grow"><label>Category</label><select v-model="sel.category"><option v-for="c in cats" :value="c">{{c}}</option></select></div>
          <div class="grow"><label>Floor</label><select v-model="sel.floor"><option v-for="f in b.floors" :value="f.fid">{{f.fid}} – {{f.label}}</option></select></div></div>
        <label>Step-free access</label><select v-model="sf"><option value="auto">auto from nav graph ({{sel.step_free_auto ? 'step-free' : 'steps'}})</option><option value="yes">yes (verified)</option><option value="no">no</option></select>
        <label>Opening hours</label><input v-model="sel.hours" placeholder="e.g. Sun 9:00–13:00">
        <label>Description</label><textarea v-model="sel.description"></textarea>
        <label>Photo URL</label><input v-model="sel.photo_url" placeholder="https://…">
        <label class="row" style="gap:6px"><input type="checkbox" v-model="sel.published" style="width:auto"> Published</label>
        <div class="small muted" style="margin-top:6px">Routing anchor: <span class="mono">{{sel.nearest_sweep_label || sel.nearest_node}}</span> · {{sel.lat && sel.lat.toFixed(6)}}, {{sel.lon && sel.lon.toFixed(6)}}</div>
        <div class="row" style="margin-top:10px"><button class="primary" @click="save">Save</button><button @click="snap" title="Move onto the nearest Matterport sweep">Snap to sweep</button><button class="danger" @click="del">Delete</button>
          <button class="sm" @click="viewMode='twin'" title="Open Digital twin mode at this POI">Digital twin</button></div>
      </div>
      <div class="card poilist"><div class="row"><b class="grow">{{shown.length}} POIs on {{floor}}</b><a class="btn sm" :href="csvHref" @click.prevent="exportCsv">Export CSV</a>
          <label class="btn sm" style="margin:0;color:var(--txt)">Import CSV<input type="file" accept=".csv" @change="importCsv" hidden></label></div>
        <ul><li v-for="p in shown" :key="p.id" :class="{on: sel && sel.id===p.id}" @click="select(p)"><span class="dot" :style="{background: color(p.category)}"></span>
          <span class="grow">{{p.name}}<br><span class="muted small">{{p.category}}{{p.published ? '' : ' · hidden'}}{{p.locked ? ' · edited' : ''}}</span></span></li></ul></div></div></div>`,
  setup(props) {
    const el = ref(null), list = ref([]), floor = ref(props.b.floors.length ? props.b.floors[0].fid : "F1"), sel = ref(null), adding = ref(false), q = ref(""), sc = ref(""), scBusy = ref(false), scErr = ref("");
    const viewMode = ref("2d"), mapStyle = ref("map");
    const cats = ref(Object.keys(CAT_COLORS)); let map = null, markers = {};
    const shown = computed(() => list.value.filter(p => p.floor === floor.value && (!q.value || (p.name + " " + p.category).toLowerCase().includes(q.value.toLowerCase()))));
    const sf = computed({ get: () => sel.value.step_free === null || sel.value.step_free === undefined ? "auto" : sel.value.step_free ? "yes" : "no",
      set: (v) => { sel.value.step_free = v === "auto" ? null : v === "yes"; sel.value._clearSF = v === "auto"; } });
    const isMapMode = computed(() => isMapViewMode(viewMode.value));
    const helpText = computed(() => {
      if (viewMode.value === "twin") return "Digital twin: Showcase at the selected POI’s nearest sweep. Select a POI first, then Open.";
      if (viewMode.value === "3d") return "3D pitched plan. Drag markers to move; + Add POI then click the map.";
      if (viewMode.value === "satellite") return "Satellite imagery. Drag markers to move; + Add POI then click the map.";
      return "2D floor plan. Drag markers to move; + Add POI then click the map. Switch modes like the public viewer.";
    });
    const color = (c) => CAT_COLORS[c] || "#80868b";
    async function load() { list.value = await api(`/admin/buildings/${props.b.slug}/pois`); drawMarkers(); }
    function drawMarkers() {
      if (!map) return; Object.values(markers).forEach(m => m.remove()); markers = {};
      shown.value.forEach(p => {
        const d = document.createElement("div"); d.className = "poi-marker" + (sel.value && sel.value.id === p.id ? " sel" : ""); d.style.background = color(p.category); d.title = p.name;
        const m = new maplibregl.Marker({ element: d, draggable: true }).setLngLat([p.lon, p.lat]).addTo(map);
        d.addEventListener("click", (e) => { e.stopPropagation(); select(p); });
        m.on("dragend", async () => { const ll = m.getLngLat(); const r = await api(`/admin/buildings/${props.b.slug}/pois/${p.id}`, { method: "PATCH", json: { lon: ll.lng, lat: ll.lat } }); Object.assign(p, r); if (sel.value && sel.value.id === p.id) sel.value = { ...r }; toast(`Moved “${p.name}” (anchor ${r.nearest_sweep_label || r.nearest_node})`); });
        markers[p.id] = m;
      });
    }
    function select(p) { sel.value = JSON.parse(JSON.stringify(p)); scErr.value = ""; drawMarkers(); }
    function closePreview() { sc.value = ""; scErr.value = ""; }
    function syncMapPresentation() {
      if (!map || !isMapViewMode(viewMode.value)) return;
      applyMapViewMode(map, viewMode.value, { beforeLayerId: "units", mapStyle: mapStyle.value });
    }
    onMounted(async () => {
      map = makeMap(el.value, props.b, basemapKindForMode(viewMode.value, mapStyle.value)); await whenLoaded(map); indoorLayers(map); await loadIndoor(map, props.b.slug, floor.value); syncMapPresentation(); await load();
      map.on("click", async (ev) => {
        if (viewMode.value === "twin" || !adding.value) return; adding.value = false;
        const name = prompt("Name of the new place?"); if (!name) return;
        const r = await api(`/admin/buildings/${props.b.slug}/pois`, { method: "POST", json: { name, category: "room", floor: floor.value, lon: ev.lngLat.lng, lat: ev.lngLat.lat } });
        await load(); select(list.value.find(p => p.id === r.id)); toast("POI created");
      });
    });
    onBeforeUnmount(() => map && map.remove());
    watch(floor, async () => { await loadIndoor(map, props.b.slug, floor.value); drawMarkers(); });
    watch(q, drawMarkers);
    watch(viewMode, async (m) => {
      if (m === "twin") {
        adding.value = false;
        await nextTick();
        if (sel.value && !sc.value && !scBusy.value) preview();
      } else {
        await nextTick();
        syncMapPresentation();
        drawMarkers();
      }
    });
    watch(mapStyle, () => { if (viewMode.value === "2d" || viewMode.value === "3d") syncMapPresentation(); });
    async function save() {
      const s = sel.value; const body = { name: s.name, category: s.category, floor: s.floor, hours: s.hours || null, description: s.description || null, photo_url: s.photo_url || null, published: s.published };
      if (s._clearSF) body.clear_step_free = true; else if (s.step_free !== null && s.step_free !== undefined) body.step_free = s.step_free;
      const r = await api(`/admin/buildings/${props.b.slug}/pois/${s.id}`, { method: "PATCH", json: body }); sel.value = { ...r }; await load(); toast("Saved");
    }
    async function snap() { const r = await api(`/admin/buildings/${props.b.slug}/pois/${sel.value.id}/snap`, { method: "POST" }); sel.value = { ...r }; await load(); toast("Snapped to " + r.nearest_sweep_label); }
    async function del() { if (!confirm("Delete " + sel.value.name + "?")) return; await api(`/admin/buildings/${props.b.slug}/pois/${sel.value.id}`, { method: "DELETE" }); sel.value = null; await load(); }
    async function preview() {
      if (!sel.value) { toast("Select a POI first"); return; }
      scBusy.value = true; scErr.value = "";
      try {
        sc.value = await fetchShowcaseUrl(props.b.slug, { sweep: sel.value.nearest_node || "" });
      } catch (x) { sc.value = ""; scErr.value = x.message || "Could not load Showcase"; }
      scBusy.value = false;
    }
    const csvHref = computed(() => `${API}/admin/buildings/${props.b.slug}/pois.csv`);
    async function exportCsv() { const t = await api(`/admin/buildings/${props.b.slug}/pois.csv`); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([t], { type: "text/csv" })); a.download = props.b.slug + "_pois.csv"; a.click(); }
    async function importCsv(e) { const fd = new FormData(); fd.append("file", e.target.files[0]); try { const r = await api(`/admin/buildings/${props.b.slug}/pois/import`, { method: "POST", body: fd }); toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.errors.length} errors`); await load(); } catch (x) { toast(x.message); } e.target.value = ""; }
    return { el, list, floor, sel, adding, q, sc, scBusy, scErr, viewMode, mapStyle, isMapMode, helpText, cats, shown, sf, color, select, save, snap, del, preview, closePreview, csvHref, exportCsv, importCsv };
  }
};

const Routes = {
  props: ["b"],
  template: `<div class="split"><div class="mapwrap">
      <iframe class="map" ref="el" v-show="viewMode!=='twin'&&viewMode!=='matterpak'" :src="previewUrl" @load="onPreviewLoad" style="width:100%;border:0;display:block"></iframe>
      <iframe class="map" ref="mpEl" v-if="mpSrc" v-show="viewMode==='matterpak'" :src="mpSrc" style="width:100%;border:0;display:block"></iframe>
      <iframe class="showcase map-twin-frame" v-show="viewMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
      <div class="toolbar">
        <view-mode-bar v-model="viewMode"></view-mode-bar>
        <template v-if="viewMode!=='twin'">
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor">
            <option v-if="viewMode==='3d'||viewMode==='satellite'" value="all">All floors</option>
            <option v-for="f in b.floors" :value="f.fid">{{f.label}}</option>
          </select>
        </template>
        <template v-else>
          <button class="sm primary" @click="openTwin" :disabled="scBusy">{{scBusy ? 'Loading…' : (sc ? 'Reload Showcase' : 'Open Showcase')}}</button>
          <button class="sm" @click="closeTwin" v-if="sc">Close</button>
        </template>
      </div>
      <div class="twin-status map-twin-status err" v-if="viewMode==='twin' && scErr">{{scErr}}</div>
      <p class="map-help">{{helpText}}</p>
    </div>
    <div class="side"><div class="card"><h2 style="margin-top:0">Route tester</h2>
      <label>From <span class="muted small">({{pois.length}} NavMe POIs)</span></label><select v-model="from"><option v-for="p in pois" :value="p.sel">{{p.name}} ({{p.floor}})</option></select>
      <label>To</label><select v-model="to"><option v-for="p in pois" :value="p.sel">{{p.name}} ({{p.floor}})</option></select>
      <div class="row" style="margin-top:10px"><button class="primary" @click="run" :disabled="!from||!to||viewMode==='twin'||(viewMode==='matterpak'?!mpNav:!navReady)">Show Nav Route</button></div>
      <template v-if="viewMode==='matterpak'">
        <div class="row" style="margin-top:8px"><button class="sm" @click="mpGenerate">Generate navigation mesh</button></div>
        <p class="small muted" style="margin:6px 0 0">{{mpMsg || 'Loading MatterPak mesh…'}}</p>
      </template>
      <p v-else class="small muted" style="margin:6px 0 0">{{navStatus}}</p>
      <div v-if="res" style="margin-top:10px" class="kv small"><div>Length</div><div>{{res.length_m}} m</div>
        <div>Points</div><div>{{res.path.length}}</div><div>Snap gap</div><div>{{res.start_gap_m}} m / {{res.end_gap_m}} m</div></div>
      <div v-if="steps.length" style="margin-top:12px"><b class="small">Turn-by-turn</b>
        <ol class="small" style="margin:6px 0 0;padding-left:18px;line-height:1.7">
          <li v-for="(s,i) in steps" :key="i">{{s.text}}<span class="muted" v-if="s.dist_m"> &middot; {{s.dist_m}} m</span></li>
        </ol></div>
      <div class="err" v-if="err">{{err}}</div></div></div></div>`,
  setup(props) {
    // Same ArcGIS Maps SDK engine (2D MapView + 3D SceneView, real Matterpak mesh) as the
    // published viewer — embedded here pointed at this building's DRAFT workspace files
    // (never the published bundle). See admin/route_preview.html.
    const el = ref(null), pois = ref([]), from = ref(""), to = ref(""), sfree = ref(false), res = ref(null), err = ref(""), floor = ref(props.b.floors.length ? props.b.floors[0].fid : "F1");
    // Routing is done entirely on the building's Recast navmesh, client-side — the same
    // mesh and the same computePath the AR app uses. No sweep graph / door logic involved.
    const steps = ref([]), navReady = ref(false), navStatus = ref("Loading navmesh…");
    // MatterPak view: the mesh is loaded there and its navmesh is generated on demand,
    // so routing in that view runs on a mesh built right then — never an uploaded one.
    const navSweeps = ref([]);   // Matterport capture points, for per-turn previews
    const mpEl = ref(null), mpReady = ref(false), mpNav = ref(false), mpMsg = ref("");
    const mpSrc = ref("");
    const viewMode = ref("2d"), sc = ref(""), scBusy = ref(false), scErr = ref("");
    let previewReady = false;
    const previewUrl = `route_preview.html?slug=${encodeURIComponent(props.b.slug)}&token=${encodeURIComponent(store.token)}`;
    function post(msg) { if (el.value && el.value.contentWindow) el.value.contentWindow.postMessage(JSON.parse(JSON.stringify(msg)), "*"); }
    mpSrc.value = `matterpak_view.html?slug=${encodeURIComponent(props.b.slug)}&token=${encodeURIComponent(store.token)}`;
    function onMpMessage(ev) {
      const m = ev.data || {};
      if (!m.type || String(m.type).slice(0, 3) !== "mp-") return;
      if (m.type === "mp-ready") mpReady.value = true;
      else if (m.type === "mp-mesh-loaded") mpMsg.value = `Mesh loaded (${m.meshes} meshes). Generate the navigation mesh.`;
      else if (m.type === "mp-navmesh-ready") { mpNav.value = true; mpMsg.value = `Navigation mesh generated in ${m.ms} ms.`; }
      else if (m.type === "mp-navmesh-failed") { mpNav.value = false; mpMsg.value = "Generation failed: " + m.error; }
      else if (m.type === "mp-route") {
        mpMsg.value = `Route on generated navmesh: ${m.length_m} m`;
        res.value = { length_m: m.length_m, path: m.path, start_gap_m: 0, end_gap_m: 0 };
        steps.value = WFNavmeshRoute.guidance(m.path, {
          floors: (props.b.floors || []).map(f => ({ id: f.fid, label: f.label || f.fid, elevation: f.elevation })),
          levelYs: pois.value.map(p => p.y).filter(y => y != null)
        });
      }
    }
    window.addEventListener("message", onMpMessage);
    onBeforeUnmount(() => window.removeEventListener("message", onMpMessage));
    function mpPost(msg) {
      const f = mpEl.value; if (f && f.contentWindow) f.contentWindow.postMessage(JSON.parse(JSON.stringify(msg)), "*");
    }
    function mpGenerate() { mpPost({ type: "mp-generate" }); }

    function onPreviewMessage(ev) {
      if (ev.source !== (el.value && el.value.contentWindow)) return;
      if (ev.data && ev.data.type === "preview-ready") {
        previewReady = true;
        post({ type: "view", mode: viewMode.value });
        post({ type: "floor", floor: floor.value });
        if (res.value && res.value.path) post({ type: "navmesh-route", path: res.value.path, steps: toRaw(steps.value) });
      }
    }
    window.addEventListener("message", onPreviewMessage);
    onBeforeUnmount(() => window.removeEventListener("message", onPreviewMessage));
    function onPreviewLoad() { previewReady = false; }
    const helpText = computed(() => {
      if (viewMode.value === "twin") return "Digital twin preview for this building. Switch back to 2D / 3D / Satellite to draw routes on the map.";
      if (viewMode.value === "3d") return "3D — real Matterpak mesh, same engine as the published viewer. Pick from/to POIs and Route.";
      if (viewMode.value === "satellite") return "Satellite imagery. Pick from/to POIs and Route.";
      return "2D floor plan. Pick from/to POIs and Route.";
    });
    onMounted(async () => {
      // Prefer live NavMe POIs (no sync step); fall back to the building's own POIs.
      // Both shapes are normalised to { sel, name, floor, x, z, navme } so the numeric
      // id of a DB POI can never end up in from_key/to_key.
      try {
        const rows = await api(`/public/dashboard/buildings/${props.b.slug}/navme-pois`);
        // Every NavMe POI is tagged F1 in Supabase regardless of where it is, and this
        // building's config elevations overlap (F2 3.43 / F3 3.04). Derive the floor from
        // the POIs' own heights and map the bands bottom-up onto the floor list.
        const ordered = (props.b.floors || []).slice().sort((a, b) =>
          (a.ordinal != null && b.ordinal != null) ? a.ordinal - b.ordinal
            : ((a.elevation || 0) - (b.elevation || 0)));
        const bands = WFNavmeshRoute.deriveLevels(rows.map(r => r.y).filter(v => v != null), ordered.length);
        const floorFor = (y) => {
          if (!bands || !bands.length || !ordered.length) return null;
          let bi = 0, bd = Infinity;
          for (let i = 0; i < bands.length; i++) {
            const d = (y >= bands[i].lo && y <= bands[i].hi) ? 0
                    : Math.min(Math.abs(y - bands[i].lo), Math.abs(y - bands[i].hi));
            if (d < bd) { bd = d; bi = i; }
          }
          const f = ordered[Math.min(bi, ordered.length - 1)];
          return f ? (f.label || f.fid) : null;
        };
        pois.value = rows.map(p => ({ sel: String(p.id), name: p.name,
          floor: floorFor(p.y) || p.floor, x: p.x, y: p.y, z: p.z, navme: true }));
      } catch (e) {
        try {
          pois.value = (await api(`/admin/buildings/${props.b.slug}/pois`))
            .map(p => ({ sel: String(p.key), name: p.name, floor: p.floor, navme: false }))
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch (_) { pois.value = []; }
      }
      try {
        const ng = await api(`/admin/buildings/${props.b.slug}/files/out/nav_graph.json`);
        navSweeps.value = (ng.nodes || []).filter(n => n.kind === "sweep")
                                          .map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z }));
      } catch (e) { navSweeps.value = []; }
      try {
        const nm = await api(`/public/dashboard/buildings/${props.b.slug}/navmesh-url`);
        await WFNavmeshRoute.load(nm.url, props.b.slug);
        navReady.value = true;
        navStatus.value = `Navmesh "${nm.label}" loaded — routes are computed on the mesh.`;
      } catch (e) {
        navReady.value = false;
        navStatus.value = "No navmesh available: " + (e.message || e) + " — upload one for this building.";
      }
    });
    async function run() {
      if (viewMode.value === "twin") viewMode.value = "2d";
      err.value = ""; res.value = null; steps.value = [];
      const fp = pois.value.find(p => p.sel === from.value);
      const tp = pois.value.find(p => p.sel === to.value);
      if (!fp || !tp) { err.value = "Pick both From and To"; return; }
      if (viewMode.value === "matterpak") {
        if (!mpNav.value) { err.value = "Generate the navigation mesh first (button in the MatterPak view)"; return; }
        mpPost({ type: "mp-route", from: { x: fp.x, y: fp.y, z: fp.z }, to: { x: tp.x, y: tp.y, z: tp.z } });
        return;
      }
      if (!navReady.value) { err.value = "Navmesh not loaded"; return; }
      if (fp.x == null || tp.x == null) { err.value = "These POIs have no xyz position"; return; }
      const r = WFNavmeshRoute.route(fp, tp);
      if (!r.ok) { err.value = r.error; if (previewReady) post({ type: "clear" }); return; }
      res.value = r;
      // Guidance is read off the finished path only — it never alters the route.
      steps.value = WFNavmeshRoute.guidance(r.path, {
        floors: (props.b.floors || []).map(f => ({ id: f.fid, label: f.label || f.fid, elevation: f.elevation })),
        levelYs: pois.value.map(p => p.y).filter(y => y != null),
        sweeps: navSweeps.value,
        startFloor: fp.floor, endFloor: tp.floor
      });
      // steps ride along so the preview can mark every turning point
      if (previewReady) post({ type: "navmesh-route", path: r.path, steps: toRaw(steps.value) });
    }
    watch(floor, (m) => { if (previewReady) post({ type: "floor", floor: m }); });
    watch(viewMode, async (m, prevM) => {
      if (m === "twin") {
        await nextTick();
        if (!sc.value && !scBusy.value) openTwin();
      } else {
        if ((m === "3d" || m === "satellite") && (prevM === "2d" || prevM === "twin")) floor.value = "all";
        else if (m === "2d" && floor.value === "all") floor.value = props.b.floors.length ? props.b.floors[0].fid : "F1";
        if (previewReady) post({ type: "view", mode: m });
      }
    });
    async function openTwin() {
      scBusy.value = true; scErr.value = "";
      try { sc.value = await fetchShowcaseUrl(props.b.slug); }
      catch (x) { sc.value = ""; scErr.value = x.message || "Could not load Showcase"; }
      scBusy.value = false;
    }
    function closeTwin() { sc.value = ""; scErr.value = ""; }
    return { el, pois, from, to, sfree, res, err, run, floor, viewMode, steps, navReady, navStatus,
      mpEl, mpSrc, mpReady, mpNav, mpMsg, mpGenerate, sc, scBusy, scErr, helpText, openTwin, closeTwin, previewUrl, onPreviewLoad };
  }
};


const Publish = {
  props: ["b"], emits: ["reload"],
  template: `<div><div class="card"><h2 style="margin-top:0">Publish a new map version</h2>
      <p class="muted">Freezes the current pipeline output + POI/floor edits into an immutable version that the public viewer serves. Previous versions stay available for rollback.</p>
      <label>Release notes</label><input v-model="notes" placeholder="e.g. Renamed halls, added restroom">
      <div class="row" style="margin-top:10px"><button class="primary" @click="pub" :disabled="busy">Publish</button><span class="ok" v-if="msg">{{msg}}</span><span class="err" v-if="err">{{err}}</span>
        <a class="btn" :href="viewerUrl(b)" target="_blank" v-if="versions.length">Open viewer ↗</a></div></div>
    <div class="card"><h2 style="margin-top:0">Versions</h2><table><tr><th>Version</th><th>Created</th><th>By</th><th>Notes</th><th>POIs</th><th></th></tr>
      <tr v-for="v in versions" :key="v.version"><td><b>v{{v.version}}</b> <span class="badge ok" v-if="v.is_current">live</span></td><td>{{new Date(v.created_at).toLocaleString()}}</td><td>{{v.created_by}}</td><td>{{v.notes}}</td><td>{{v.summary.pois}}</td>
        <td><button class="sm" v-if="!v.is_current" @click="activate(v)">Make live</button></td></tr></table></div></div>`,
  setup(props, { emit }) {
    const notes = ref(""), busy = ref(false), msg = ref(""), err = ref(""), versions = ref([]);
    const load = async () => versions.value = await api(`/admin/buildings/${props.b.slug}/versions`);
    onMounted(load);
    async function pub() { busy.value = true; err.value = ""; msg.value = ""; try { const r = await api(`/admin/buildings/${props.b.slug}/publish`, { method: "POST", json: { notes: notes.value } }); msg.value = `Published v${r.version}`; notes.value = ""; await load(); emit("reload"); } catch (e) { err.value = e.message; } busy.value = false; }
    async function activate(v) { await api(`/admin/buildings/${props.b.slug}/versions/${v.version}/activate`, { method: "POST" }); await load(); toast(`v${v.version} is live`); }
    return { notes, busy, msg, err, versions, pub, activate, viewerUrl };
  }
};

const Jobs = {
  props: ["b"],
  template: `<div class="split"><div class="card"><h2 style="margin-top:0">Jobs</h2><table><tr><th>#</th><th>Kind</th><th>Status</th><th>Params</th><th>Created</th><th>Duration</th></tr>
      <tr v-for="j in jobs" :key="j.id" @click="sel=j.id" style="cursor:pointer" :style="{background: sel===j.id ? '#e8f0fe' : ''}"><td>{{j.id}}</td><td>{{j.kind}}</td><td><span class="badge" :class="stCls(j.status==='succeeded'?'published':j.status==='failed'?'failed':'processing')">{{j.status}}</span></td>
        <td class="mono small">{{j.params.from_step ? 'from '+j.params.from_step : (j.params.steps||[]).join(',') || 'all'}}{{j.params.force?' (force)':''}}</td><td>{{new Date(j.created_at).toLocaleString()}}</td>
        <td>{{j.finished_at && j.started_at ? Math.round((new Date(j.finished_at)-new Date(j.started_at))/1000)+' s' : ''}}</td></tr></table></div>
    <div><job-log v-if="sel" :job-id="sel"></job-log></div></div>`,
  setup(props) { const jobs = ref([]), sel = ref(null); onMounted(async () => { jobs.value = await api(`/admin/jobs?building=${props.b.slug}`); if (jobs.value.length) sel.value = jobs.value[0].id; }); return { jobs, sel, stCls }; }
};


// ---------------- Scan planning ----------------
const ScanPlans = {
  template: `<div>
    <div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">Scan planning</h1>
      <button class="primary" @click="create">+ New plan</button></div>
    <p class="muted" style="margin-top:0">Upload a floor drawing (PNG/JPG/PDF/DXF), set scale, auto-place Matterport tripod scan points, estimate duration, export CSV + PDF.</p>
    <div class="grid"><div class="card" v-for="p in list" :key="p.id">
      <div class="row"><b class="grow" style="font-size:16px"><a :href="'#/scan-plan/'+p.id">{{p.name}}</a></b>
        <span class="badge" :class="p.status==='generated'||p.status==='edited'?'ok':(p.status==='new'?'':'blue')">{{p.status}}</span></div>
      <div class="muted small" style="margin-top:6px">{{p.n_points||0}} scans · {{p.source_kind||'no file'}} · {{p.total_s!=null ? (Math.round(p.total_s/60)+' min est.') : '—'}}</div>
      <div class="muted small">{{p.updated_at ? new Date(p.updated_at).toLocaleString() : ''}}</div>
      <div class="row" style="margin-top:10px"><a class="btn sm" :href="'#/scan-plan/'+p.id">Open</a>
        <button class="sm danger" @click="del(p)">Delete</button></div>
    </div></div>
    <div v-if="!list.length" class="card muted">No scan plans yet. Create one to upload a CAD or floor-plan image.</div>
    <div class="err" v-if="err">{{err}}</div></div>`,
  setup() {
    const list = ref([]), err = ref("");
    async function load() { try { list.value = await api("/admin/scan-plans"); } catch (e) { err.value = e.message; } }
    async function create() {
      const name = prompt("Plan name", "Floor plan scan");
      if (!name) return;
      const p = await api("/admin/scan-plans", { method: "POST", json: { name } });
      go("/scan-plan/" + p.id);
    }
    async function del(p) {
      if (!confirm("Delete plan “" + p.name + "”?")) return;
      await api("/admin/scan-plans/" + p.id, { method: "DELETE" }); toast("Deleted"); load();
    }
    onMounted(load);
    return { list, err, create, del };
  }
};

const ScanPlan = {
  props: ["id"],
  template: `<div>
    <div class="row" style="margin-bottom:8px"><a href="#/scan-plan">← Scan plans</a><span class="sp"></span>
      <span class="badge" :class="meta.status==='generated'||meta.status==='edited'?'ok':'blue'">{{meta.status||'…'}}</span></div>
    <div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">{{meta.name||'Scan plan'}}</h1>
      <button class="sm" @click="rename" v-if="meta.id">Rename</button></div>
    <div class="scan-steps">
      <span :class="stepCls(0)">1. Upload</span><span :class="stepCls(1)">2. Scale</span>
      <span :class="stepCls(2)">3. Walkable</span><span :class="stepCls(3)">4. Generate</span>
      <span :class="stepCls(4)">5. Review / export</span></div>
    <div class="err" v-if="err">{{err}}</div>

    <div class="split">
      <div>
        <div class="card" style="padding:0;overflow:hidden">
          <div class="toolbar" style="position:relative;box-shadow:none;border-radius:0;border-bottom:1px solid var(--line)">
            <label class="row small" style="margin:0;gap:4px">Tool
              <select v-model="tool" style="width:auto"><option value="pan">Pan / view</option>
                <option value="scale">Draw scale line</option><option value="poly">Draw walkable polygon</option>
                <option value="add">Add scan point</option><option value="move">Move point</option></select></label>
            <button class="sm" @click="fit">Fit</button>
            <button class="sm" @click="undoPoly" v-if="tool==='poly' && polyPts.length">Undo vertex</button>
            <button class="sm" @click="closePoly" v-if="tool==='poly' && polyPts.length>=3">Close polygon</button>
          </div>
          <div class="scan-canvas-wrap" ref="wrap"><canvas ref="cv" @mousedown="onDown" @mousemove="onMove" @mouseup="onUp" @mouseleave="onUp" @dblclick="onDbl"></canvas></div>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <h2 style="margin-top:0">1. Upload</h2>
          <input type="file" accept=".png,.jpg,.jpeg,.webp,.pdf,.dxf,image/*,application/pdf" @change="onFile">
          <p class="muted small">PNG/JPG, PDF (first page), or DXF. Stored under <code>var/data/scan_plans/</code>.</p>
        </div>

        <div class="card">
          <h2 style="margin-top:0">Address → footprint scale hint</h2>
          <p class="muted small">Geocode a street address, pull the OSM building footprint, and use its long/short side as the known length for the scale line. Manual scale below still works.</p>
          <label>Street address</label>
          <div class="row"><input class="grow" v-model="addressInput" placeholder="e.g. 2400 Greenland Ave, Charlotte NC" style="width:auto;flex:1">
            <button class="primary" :disabled="busy || !addressInput.trim()" @click="lookupAddress">Lookup</button></div>
          <div class="err" v-if="addrErr" style="margin-top:8px">{{addrErr}}</div>
          <template v-if="meta.geocode">
            <p class="small" style="margin:10px 0 4px"><b>{{meta.geocode.display_name}}</b></p>
            <p class="muted small">{{meta.geocode.lat?.toFixed?.(6)}}, {{meta.geocode.lon?.toFixed?.(6)}}
              <span v-if="meta.geocode.provider"> · {{meta.geocode.provider}}</span></p>
          </template>
          <template v-if="addrCandidates.length > 1">
            <label style="margin-top:8px">Building candidate</label>
            <select v-model="selectedOsmKey" @change="selectCandidate">
              <option v-for="c in addrCandidates" :key="c.osm_key" :value="c.osm_key">
                {{c.name || c.building || c.osm_key}} — {{c.length_m}}×{{c.width_m}} m ({{c.area_m2}} m², {{c.distance_m}} m away)
              </option>
            </select>
          </template>
          <template v-if="meta.footprint_hint">
            <div class="timing-grid" style="margin-top:10px">
              <div class="t"><span class="muted small">Long side</span><b>{{meta.footprint_hint.length_m}} m</b></div>
              <div class="t"><span class="muted small">Short side</span><b>{{meta.footprint_hint.width_m}} m</b></div>
              <div class="t"><span class="muted small">Area</span><b>{{meta.footprint_hint.area_m2}} m²</b></div>
              <div class="t"><span class="muted small">OSM</span><b>{{meta.footprint_hint.osm_key || meta.footprint_hint.osm_id}}</b></div>
            </div>
            <p class="muted small" style="margin-top:8px">Draw a scale line on the plan along that wall, then apply. Prefills metres and switches to line mode; does not overwrite an existing scale without confirmation.</p>
            <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:6px">
              <button class="sm primary" :disabled="busy" @click="useFootprintEdge('long')">Use long side as scale length</button>
              <button class="sm" :disabled="busy" @click="useFootprintEdge('short')">Use short side</button>
            </div>
          </template>
        </div>

        <div class="card">
          <h2 style="margin-top:0">2. Scale</h2>
          <label>Mode</label>
          <select v-model="scaleMode"><option value="line">Draw a known length on the plan</option>
            <option value="px_per_m">Enter pixels per metre</option>
            <option value="drawing_units" :disabled="meta.source_kind!=='dxf'">DXF drawing units per metre</option></select>
          <template v-if="scaleMode==='line'">
            <p class="muted small">Select tool “Draw scale line”, click two endpoints, then enter the real length.</p>
            <label>Length (metres)</label><input type="number" step="0.01" min="0.01" v-model.number="scaleMeters">
            <div class="muted small" v-if="scaleLine">Line {{scaleLine.lenPx.toFixed(1)}} px</div>
          </template>
          <template v-else-if="scaleMode==='px_per_m'">
            <label>Pixels per metre</label><input type="number" step="0.1" min="0.1" v-model.number="pxPerM">
          </template>
          <template v-else>
            <label>Drawing units per metre</label><input type="number" step="0.001" min="0.001" v-model.number="unitsPerM">
            <p class="muted small">e.g. 1000 if the DXF is in millimetres, 1 if already metres.</p>
          </template>
          <div class="row" style="margin-top:10px"><button class="primary" :disabled="busy" @click="applyScale">Apply scale</button></div>
          <div class="muted small" v-if="meta.scale">Current: {{meta.scale.px_per_m?.toFixed?.(2) || meta.scale.px_per_m}} px/m</div>
        </div>

        <div class="card">
          <h2 style="margin-top:0">3. Walkable area</h2>
          <label>Mode</label>
          <select v-model="walkMode"><option value="auto">Auto (threshold / DXF loops)</option>
            <option value="polygon">Manual polygon</option></select>
          <p class="muted small" v-if="walkMode==='polygon'">Tool “Draw walkable polygon”: click vertices, double-click or “Close polygon”.</p>
          <div class="row" style="margin-top:10px"><button class="primary" :disabled="busy" @click="applyWalkable">Detect / save walkable</button></div>
        </div>

        <div class="card">
          <h2 style="margin-top:0">4. Generate points</h2>
          <label>Spacing (m) — 1.5–3.0</label><input type="number" step="0.1" min="1.5" max="3" v-model.number="spacing">
          <label>Wall clearance (m)</label><input type="number" step="0.1" min="0" max="2" v-model.number="clearance">
          <label class="row" style="margin-top:8px;gap:6px"><input type="checkbox" v-model="los" style="width:auto"> Drop points with no LOS to neighbours</label>
          <label>Floor label</label><input v-model="floor">
          <h2>Timing assumptions</h2>
          <label>Setup + capture per scan (s)</label><input type="number" step="1" min="1" v-model.number="captureS">
          <label>Walk speed with tripod (m/s)</label><input type="number" step="0.05" min="0.1" v-model.number="walkMps">
          <label>Overhead per floor (s)</label><input type="number" step="30" min="0" v-model.number="overheadS">
          <p class="muted small">Defaults assume Matterport Pro3-ish ~90 s setup+capture, 0.7 m/s walking with tripod, 5 min floor overhead.</p>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
            <h2 style="margin-top:0">Auto generate (estimate scale)</h2>
            <p class="muted small">When you do not know scale: uses floor-area annotation (<code>area_m2</code>) or OSM footprint if present, then places a Pro3 2 m grid. Approximate (±10–20%) vs a measured scale line.</p>
            <label>Area m² (optional)</label>
            <input type="number" step="1" min="1" v-model.number="autoAreaM2" placeholder="e.g. 4588 from drawing annotation">
            <div class="row" style="margin-top:10px">
              <button class="primary" style="font-size:15px;padding:10px 16px" :disabled="busy" @click="doAutoGenerate">Auto generate (estimate scale)</button>
            </div>
          </div>
          <div class="row" style="margin-top:10px"><button :disabled="busy||!meta.scale" @click="doGenerate">Generate scan points (manual scale)</button></div>
        </div>

        <div class="card" v-if="meta.timing">
          <h2 style="margin-top:0">5. Timing estimate</h2>
          <div class="timing-grid">
            <div class="t"><span class="muted small">Scans</span><b>{{meta.timing.n_scans}}</b></div>
            <div class="t"><span class="muted small">Path</span><b>{{meta.timing.path_length_m}} m</b></div>
            <div class="t"><span class="muted small">Capture</span><b>{{fmtS(meta.timing.capture_s)}}</b></div>
            <div class="t"><span class="muted small">Travel</span><b>{{fmtS(meta.timing.travel_s)}}</b></div>
            <div class="t"><span class="muted small">Overhead</span><b>{{fmtS(meta.timing.overhead_s)}}</b></div>
            <div class="t"><span class="muted small">Total</span><b>{{meta.timing.total_min}} min</b></div>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="primary" :disabled="busy" @click="savePoints">Save point edits</button>
            <button :disabled="busy" @click="expCsv">Export CSV</button>
            <button :disabled="busy" @click="expPdf">Export PDF</button>
          </div>
          <p class="muted small" style="margin-top:8px">Drag points (Move tool) or Add points. Order follows nearest-neighbour walk. Re-save after edits to refresh timing.</p>
        </div>
      </div>
    </div>
  </div>`,
  setup(props) {
    const meta = ref({}), err = ref(""), busy = ref(false);
    const tool = ref("pan"), scaleMode = ref("line"), walkMode = ref("auto");
    const scaleMeters = ref(10), pxPerM = ref(50), unitsPerM = ref(1);
    const scaleLine = ref(null), polyPts = ref([]);
    const addressInput = ref(""), addrErr = ref(""), addrCandidates = ref([]), selectedOsmKey = ref("");
    const spacing = ref(2.0), clearance = ref(0.5), los = ref(true), floor = ref("1");
    const captureS = ref(90), walkMps = ref(0.7), overheadS = ref(300);
    const autoAreaM2 = ref(null);
    const cv = ref(null), wrap = ref(null);
    let img = null, drag = null, scaleDraft = null, hover = null;

    function fmtS(s) { if (s == null) return "—"; s = +s; return s < 60 ? Math.round(s) + " s" : Math.floor(s / 60) + "m " + Math.round(s % 60) + "s"; }
    function stepCls(i) {
      const st = meta.value.status || "new";
      const order = ["new", "uploaded", "scaled", "walkable", "generated", "edited"];
      const idx = Math.max(0, order.indexOf(st));
      // map status to step
      const reached = { new: 0, uploaded: 1, scaled: 2, walkable: 3, generated: 4, edited: 4 }[st] ?? 0;
      return { on: reached === i, done: reached > i };
    }
    async function load() {
      err.value = "";
      try {
        meta.value = await api("/admin/scan-plans/" + props.id);
        const s = meta.value.settings || {};
        spacing.value = s.spacing_m ?? 2; clearance.value = s.clearance_m ?? 0.5;
        los.value = s.los_filter !== false; floor.value = s.floor || "1";
        captureS.value = s.capture_s ?? 90; walkMps.value = s.walk_mps ?? 0.7; overheadS.value = s.overhead_s ?? 300;
        if (meta.value.scale?.mode && ["line","px_per_m","drawing_units"].includes(meta.value.scale.mode)) scaleMode.value = meta.value.scale.mode;
        if (meta.value.walkable?.mode) walkMode.value = meta.value.walkable.mode;
        autoAreaM2.value = meta.value.area_m2 != null ? meta.value.area_m2
          : (meta.value.footprint_hint && meta.value.footprint_hint.area_m2) || null;
        addressInput.value = meta.value.address || "";
        addrErr.value = "";
        const feats = (meta.value.footprints && meta.value.footprints.features) || [];
        addrCandidates.value = feats.map(f => {
          const p = f.properties || {};
          return { osm_id: p.osm_id, osm_type: p.osm_type, osm_key: f.id || (p.osm_type + "/" + p.osm_id),
            name: p.name, building: p.building, length_m: p.length_m, width_m: p.width_m,
            area_m2: p.area_m2, distance_m: p.distance_m };
        });
        selectedOsmKey.value = (meta.value.footprint_hint && (meta.value.footprint_hint.osm_key
          || (meta.value.footprint_hint.osm_type + "/" + meta.value.footprint_hint.osm_id))) || "";
        await loadImage();
      } catch (e) { err.value = e.message; }
    }
    function loadImage() {
      return new Promise((resolve) => {
        if (!meta.value.preview) { img = null; draw(); resolve(); return; }
        const im = new Image();
        im.onload = () => { img = im; draw(); resolve(); };
        im.onerror = () => { err.value = "Failed to load preview"; resolve(); };
        // Always load raw preview; points/path drawn client-side for live edits
        im.src = scanPreviewUrl(props.id, 0);
      });
    }
    function draw() {
      const c = cv.value; if (!c) return;
      const ctx = c.getContext("2d");
      if (!img) { c.width = 640; c.height = 360; ctx.fillStyle = "#f6f8fb"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#5f6368"; ctx.font = "14px system-ui"; ctx.fillText("Upload a drawing to begin", 24, 40); return; }
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      // live overlays for in-progress tools (points already in overlay.png when saved)
      if (scaleDraft || (scaleLine.value && tool.value === "scale")) {
        const L = scaleDraft || scaleLine.value;
        ctx.strokeStyle = "#d93025"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(L.x1, L.y1); ctx.lineTo(L.x2, L.y2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#d93025"; [[L.x1, L.y1], [L.x2, L.y2]].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 4, 0, 6.3); ctx.fill(); });
      }
      if (polyPts.value.length) {
        ctx.strokeStyle = "#188038"; ctx.fillStyle = "rgba(24,128,56,.15)"; ctx.lineWidth = 2;
        ctx.beginPath(); polyPts.value.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        if (polyPts.value.length >= 3) { ctx.closePath(); ctx.fill(); }
        ctx.stroke();
        polyPts.value.forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, 6.3); ctx.fillStyle = "#188038"; ctx.fill(); });
      }
      // Always draw editable points on top so move/add is visible even before overlay refresh
      const pts = meta.value.points || [];
      if (pts.length) {
        ctx.strokeStyle = "rgba(234,67,53,.85)"; ctx.lineWidth = 2;
        ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x_px, p.y_px) : ctx.moveTo(p.x_px, p.y_px)); ctx.stroke();
        pts.forEach(p => {
          ctx.beginPath(); ctx.arc(p.x_px, p.y_px, 7, 0, 6.3);
          ctx.fillStyle = "#1a73e8"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = "#202124"; ctx.font = "12px system-ui"; ctx.fillText(p.id, p.x_px + 10, p.y_px - 8);
        });
      }
    }
    function canvasPos(ev) {
      const c = cv.value, r = c.getBoundingClientRect();
      const sx = c.width / r.width, sy = c.height / r.height;
      return [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sy];
    }
    function nearestPoint(x, y, max = 14) {
      let best = null, bd = max;
      (meta.value.points || []).forEach((p, i) => {
        const d = Math.hypot(p.x_px - x, p.y_px - y);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    }
    function onDown(ev) {
      const [x, y] = canvasPos(ev);
      if (tool.value === "scale") {
        scaleDraft = { x1: x, y1: y, x2: x, y2: y, lenPx: 0 }; drag = "scale"; draw(); return;
      }
      if (tool.value === "poly") { polyPts.value = polyPts.value.concat([[x, y]]); draw(); return; }
      if (tool.value === "add") {
        const pts = (meta.value.points || []).slice();
        pts.push({ id: "S" + (pts.length + 1), x_px: x, y_px: y, order: pts.length + 1, floor: floor.value });
        meta.value = { ...meta.value, points: pts }; draw(); return;
      }
      if (tool.value === "move") {
        const i = nearestPoint(x, y); if (i == null) return;
        drag = { kind: "move", i }; return;
      }
    }
    function onMove(ev) {
      const [x, y] = canvasPos(ev);
      if (drag === "scale" && scaleDraft) {
        scaleDraft.x2 = x; scaleDraft.y2 = y;
        scaleDraft.lenPx = Math.hypot(scaleDraft.x2 - scaleDraft.x1, scaleDraft.y2 - scaleDraft.y1);
        draw(); return;
      }
      if (drag && drag.kind === "move") {
        const pts = meta.value.points.slice();
        pts[drag.i] = { ...pts[drag.i], x_px: x, y_px: y };
        meta.value = { ...meta.value, points: pts }; draw();
      }
    }
    function onUp() {
      if (drag === "scale" && scaleDraft) {
        scaleLine.value = { ...scaleDraft };
        scaleDraft = null; tool.value = "pan";
      }
      drag = null;
    }
    function onDbl(ev) {
      if (tool.value === "poly" && polyPts.value.length >= 3) closePoly();
    }
    function undoPoly() { polyPts.value = polyPts.value.slice(0, -1); draw(); }
    function closePoly() { if (polyPts.value.length >= 3) { walkMode.value = "polygon"; toast("Polygon ready — click Detect / save walkable"); draw(); } }
    function fit() { if (wrap.value && cv.value) wrap.value.scrollLeft = 0; }

    async function onFile(ev) {
      const f = ev.target.files && ev.target.files[0]; if (!f) return;
      busy.value = true; err.value = "";
      try {
        const fd = new FormData(); fd.append("file", f);
        const r = await fetch(API + "/admin/scan-plans/" + props.id + "/upload", {
          method: "POST", headers: { Authorization: "Bearer " + store.token }, body: fd
        });
        const j = await r.json(); if (!r.ok) throw new Error(j.detail || r.statusText);
        meta.value = j; toast("Uploaded"); await loadImage();
      } catch (e) { err.value = e.message; }
      busy.value = false; ev.target.value = "";
    }
    async function lookupAddress() {
      busy.value = true; err.value = ""; addrErr.value = "";
      try {
        const r = await api("/admin/scan-plans/" + props.id + "/address", {
          method: "POST", json: { address: addressInput.value.trim() }
        });
        meta.value = r.meta;
        addrCandidates.value = r.candidates || [];
        selectedOsmKey.value = (r.meta.footprint_hint && r.meta.footprint_hint.osm_key) || "";
        const h = r.meta.footprint_hint;
        toast(h ? `Footprint ${h.length_m}×${h.width_m} m` : "Address saved");
      } catch (e) { addrErr.value = e.message; }
      busy.value = false;
    }
    async function selectCandidate() {
      const c = addrCandidates.value.find(x => x.osm_key === selectedOsmKey.value);
      if (!c) return;
      busy.value = true; addrErr.value = "";
      try {
        const r = await api("/admin/scan-plans/" + props.id + "/address", {
          method: "POST", json: { address: addressInput.value.trim() || meta.value.address, osm_id: c.osm_id, osm_type: c.osm_type }
        });
        meta.value = r.meta;
        addrCandidates.value = r.candidates || addrCandidates.value;
        toast("Candidate selected");
      } catch (e) { addrErr.value = e.message; }
      busy.value = false;
    }
    async function useFootprintEdge(edge) {
      const h = meta.value.footprint_hint;
      if (!h) { addrErr.value = "Look up an address first"; return; }
      const meters = edge === "short" ? h.width_m : h.length_m;
      scaleMode.value = "line";
      scaleMeters.value = meters;
      tool.value = "scale";
      addrErr.value = "";
      if (!scaleLine.value) {
        toast(`Prefill ${meters} m (${edge}) — draw the matching wall on the plan, then Apply scale`);
        return;
      }
      if (meta.value.scale) {
        if (!confirm("This plan already has a scale (" + (meta.value.scale.px_per_m?.toFixed?.(1) || meta.value.scale.px_per_m) + " px/m). Overwrite with footprint " + edge + " side (" + meters + " m)?")) {
          return;
        }
      }
      busy.value = true; err.value = "";
      try {
        meta.value = await api("/admin/scan-plans/" + props.id + "/scale-hint", {
          method: "POST", json: {
            edge, confirm: true,
            x1: scaleLine.value.x1, y1: scaleLine.value.y1,
            x2: scaleLine.value.x2, y2: scaleLine.value.y2
          }
        });
        toast("Scale set from footprint " + edge + " side (" + meters + " m)");
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function applyScale() {
      busy.value = true; err.value = "";
      try {
        let body;
        if (scaleMode.value === "line") {
          if (!scaleLine.value) throw new Error("Draw a scale line on the plan first");
          body = { mode: "line", x1: scaleLine.value.x1, y1: scaleLine.value.y1, x2: scaleLine.value.x2, y2: scaleLine.value.y2, meters: scaleMeters.value };
        } else if (scaleMode.value === "px_per_m") body = { mode: "px_per_m", px_per_m: pxPerM.value };
        else body = { mode: "drawing_units", units_per_m: unitsPerM.value };
        meta.value = await api("/admin/scan-plans/" + props.id + "/scale", { method: "POST", json: body });
        toast("Scale set");
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function applyWalkable() {
      busy.value = true; err.value = "";
      try {
        const body = { mode: walkMode.value };
        if (walkMode.value === "polygon") {
          if (polyPts.value.length < 3) throw new Error("Draw a polygon with at least 3 vertices");
          body.polygon_px = polyPts.value;
        }
        meta.value = await api("/admin/scan-plans/" + props.id + "/walkable", { method: "POST", json: body });
        toast("Walkable area saved"); await loadImage(); draw();
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function doGenerate() {
      busy.value = true; err.value = "";
      try {
        meta.value = await api("/admin/scan-plans/" + props.id + "/generate", { method: "POST", json: {
          spacing_m: spacing.value, clearance_m: clearance.value, los_filter: los.value, floor: floor.value,
          capture_s: captureS.value, walk_mps: walkMps.value, overhead_s: overheadS.value
        }});
        toast(`Placed ${meta.value.points.length} scan points`); await loadImage();
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function doAutoGenerate() {
      if (meta.value.scale && (meta.value.points || []).length) {
        if (!confirm("This plan already has scale and scan points. Overwrite with auto-estimated scale and a new grid?")) return;
      }
      busy.value = true; err.value = "";
      try {
        const body = {
          spacing_m: spacing.value, clearance_m: clearance.value, los_filter: los.value, floor: floor.value,
          capture_s: captureS.value, walk_mps: walkMps.value, overhead_s: overheadS.value,
          confirm: true
        };
        if (autoAreaM2.value != null && autoAreaM2.value > 0) body.area_m2 = autoAreaM2.value;
        meta.value = await api("/admin/scan-plans/" + props.id + "/auto-generate", { method: "POST", json: body });
        const t = meta.value.timing || {};
        const ppm = meta.value.scale && meta.value.scale.px_per_m;
        toast(`Auto: ${t.n_scans || 0} scans · ${t.total_min || "—"} min · ${(ppm != null ? (+ppm).toFixed(2) : "—")} px/m`);
        await loadImage(); draw();
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function savePoints() {
      busy.value = true; err.value = "";
      try {
        meta.value = await api("/admin/scan-plans/" + props.id + "/points", { method: "PATCH", json: {
          points: meta.value.points, capture_s: captureS.value, walk_mps: walkMps.value, overhead_s: overheadS.value
        }});
        toast("Points saved"); await loadImage();
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function expCsv() { try { await downloadAuth(`/admin/scan-plans/${props.id}/export.csv`, (meta.value.name || props.id) + "_scan_points.csv"); } catch (e) { err.value = e.message; } }
    async function expPdf() { try { await downloadAuth(`/admin/scan-plans/${props.id}/export.pdf`, (meta.value.name || props.id) + "_scan_plan.pdf"); } catch (e) { err.value = e.message; } }
    async function rename() {
      const n = prompt("Plan name", meta.value.name); if (!n) return;
      try {
        meta.value = await api("/admin/scan-plans/" + props.id + "/points", { method: "PATCH", json: { points: meta.value.points || [], name: n } });
        toast("Renamed");
      } catch (e) { err.value = e.message; }
    }

    onMounted(load);
    watch(() => props.id, load);
    return { meta, err, busy, tool, scaleMode, walkMode, scaleMeters, pxPerM, unitsPerM, scaleLine, polyPts,
      addressInput, addrErr, addrCandidates, selectedOsmKey,
      spacing, clearance, los, floor, captureS, walkMps, overheadS, cv, wrap,
      autoAreaM2,
      fmtS, stepCls, onFile, lookupAddress, selectCandidate, useFootprintEdge, applyScale, applyWalkable, doGenerate, doAutoGenerate, savePoints, expCsv, expPdf, rename,
      onDown, onMove, onUp, onDbl, undoPoly, closePoly, fit };
  }
};




const MediaPanels = {
  props: ["b"], emits: ["reload"],
  template: `<div class="split"><div class="mapwrap">
      <div class="map" ref="el" v-show="viewMode!=='twin'"></div>
      <iframe class="showcase map-twin-frame" ref="twinFrame" v-show="viewMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
      <div class="toolbar">
        <view-mode-bar v-model="viewMode"></view-mode-bar>
        <template v-if="viewMode!=='twin'">
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="f in b.floors" :value="f.fid">{{f.label}} ({{f.fid}})</option></select>
          <button class="sm" :class="{primary: placing}" @click="placing=!placing" :disabled="!sel">{{placing ? 'Click map to place…' : 'Place on map'}}</button>
          <map-style-bar v-if="viewMode==='2d'||viewMode==='3d'" v-model="mapStyle"></map-style-bar>
          <span class="small muted">{{mapHint}}</span>
        </template>
        <template v-else>
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="f in b.floors" :value="f.fid">{{f.label}} ({{f.fid}})</option></select>
          <button class="sm primary" @click="openTwin" :disabled="twinBusy">{{twinBusy ? 'Connecting…' : (sc ? 'Reconnect + SDK' : 'Open / Reconnect')}}</button>
          <button class="sm" @click="usePointerHit" :disabled="!twinOk || !sel">Use pointer</button>
          <button class="sm" @click="useCurrentSweep" :disabled="!twinOk || !sel">Use sweep</button>
          <button class="sm" @click="closeTwin" v-if="sc">Close</button>
          <span class="badge" :class="twinOk ? 'ok' : (twinErr ? 'bad' : '')">{{twinOk ? 'SDK ready' : (sc ? 'Showcase open' : 'Closed')}}</span>
        </template>
      </div>
      <div class="twin-status map-twin-status" :class="{err: twinErr, ok: twinOk && !twinErr}" v-if="viewMode==='twin' && (twinStatus || twinBusy || twinHint)">{{twinBusy && !twinStatus ? 'Connecting…' : (twinStatus || twinHint)}}</div>
      <div class="map-empty" v-if="!sel"><p>Select or add a media panel to place it on the map or in the digital twin.</p></div>
      <p class="map-help">{{helpText}}</p>
    </div>
    <div class="side">
      <div class="card" style="margin-bottom:12px">
        <h2 style="margin-top:0">Media</h2>
        <p class="muted small" style="margin-top:0">Image, video, or text panels in the twin (optional CTA redirect buttons). Place with Digital twin (Use pointer / Use sweep), map click, or typed model XYZ. Save writes <code>pipeline_config.media_panels</code>. Publish copies files into the public bundle. Tour injects Matterport Tags; tap opens glass_v1 HUD (text + buttons). Embed only — no Bundle mesh.</p>
        <div class="poilist"><ul>
          <li v-for="e in rows" :key="e._k" :class="{on: sel && sel._k===e._k}" @click="select(e)">
            <span class="dot" :style="{background: e.kind==='video' ? '#7c4dff' : (e.kind==='text' ? '#0d9f6e' : '#1a73e8')}"></span>
            <span class="grow">{{e.name || e.id || 'Untitled'}}<br><span class="muted small">{{e.kind}} · {{e.id || 'no id'}} · {{placedLabel(e)}}{{(e.buttons&&e.buttons.length) ? (' · '+e.buttons.length+' CTA') : ''}}</span></span>
          </li>
        </ul></div>
        <div class="row" style="margin-top:8px"><button class="primary" @click="add">+ Add panel</button></div>
      </div>
      <div class="card" v-if="sel">
        <div class="row"><b class="grow">Edit</b><button class="sm" @click="sel=null">Close</button></div>
        <label>Id</label><input v-model="sel.id" placeholder="screen_lobby" spellcheck="false" @input="markDirty">
        <label>Title</label><input v-model="sel.name" placeholder="Lobby welcome" @input="markDirty">
        <label>Type</label>
        <select v-model="sel.kind" @change="markDirty"><option value="image">Image</option><option value="video">Video</option><option value="text">Text</option></select>
        <label>Floor</label>
        <select v-model="sel.floor" @change="markDirty"><option value="">—</option><option v-for="f in b.floors" :value="f.fid">{{f.label}} ({{f.fid}})</option></select>
        <template v-if="sel.kind==='text'">
          <label>Body (markdown or plain)</label>
          <textarea v-model="sel.body" rows="6" placeholder="Welcome to the lobby.\n\n**Hours:** 8am–6pm" spellcheck="true" @input="markDirty" style="width:100%;font:13px/1.4 system-ui,sans-serif;resize:vertical"></textarea>
          <label>Optional image URL (shows above body)</label>
          <input v-model="sel.src" placeholder="https://… (optional)" spellcheck="false" @input="markDirty">
        </template>
        <template v-else>
          <label>Media URL</label>
          <input v-model="sel.src" placeholder="https://… or upload below" spellcheck="false" @input="markDirty">
          <label>Upload {{sel.kind==='video' ? 'video' : 'image'}}</label>
          <input type="file" :accept="sel.kind==='video' ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp,image/gif'" @change="onUpload">
          <p class="muted small" v-if="uploading">Uploading…</p>
          <label v-if="sel.kind==='video'">Poster URL (optional)</label>
          <input v-if="sel.kind==='video'" v-model="sel.poster" placeholder="https://… or upload image" spellcheck="false" @input="markDirty">
        </template>
        <label style="margin-top:10px">Redirect buttons (CTA)</label>
        <p class="muted small" style="margin:0 0 6px">Optional on any type. Opens URL in a new tab from the glass HUD.</p>
        <div v-for="(btn, bi) in sel.buttons" :key="'btn-'+bi" class="row" style="gap:6px;align-items:flex-end;margin-bottom:6px">
          <div class="grow"><label class="muted small">Label</label><input v-model="btn.label" placeholder="Learn more" @input="markDirty"></div>
          <div class="grow"><label class="muted small">URL</label><input v-model="btn.url" placeholder="https://…" spellcheck="false" @input="markDirty"></div>
          <button type="button" class="sm danger" @click="removeButton(bi)" title="Remove">×</button>
        </div>
        <div class="row"><button type="button" class="sm" @click="addButton">+ Add button</button></div>
        <label>Model XYZ (metres, Z-up)</label>
        <div class="row">
          <div class="grow"><input type="number" step="0.01" v-model="sel.model.x" placeholder="x" @input="markDirty"></div>
          <div class="grow"><input type="number" step="0.01" v-model="sel.model.y" placeholder="y" @input="markDirty"></div>
          <div class="grow"><input type="number" step="0.01" v-model="sel.model.z" placeholder="z" @input="markDirty"></div>
        </div>
        <label>Normal (optional, from twin pointer)</label>
        <div class="row">
          <div class="grow"><input type="number" step="0.01" v-model="sel.normal.x" placeholder="nx" @input="markDirty"></div>
          <div class="grow"><input type="number" step="0.01" v-model="sel.normal.y" placeholder="ny" @input="markDirty"></div>
          <div class="grow"><input type="number" step="0.01" v-model="sel.normal.z" placeholder="nz" @input="markDirty"></div>
        </div>
        <label>Sweep sid (optional)</label><input v-model="sel.sweep_sid" spellcheck="false" @input="markDirty">
        <label>POI key (optional link)</label><input v-model="sel.poi_key" placeholder="poi_…" spellcheck="false" @input="markDirty">
        <label class="row" style="gap:6px;margin-top:8px"><input type="checkbox" v-model="sel.published" style="width:auto" @change="markDirty"> Published (include on next Publish)</label>
        <div class="row" style="margin-top:10px"><button class="danger" @click="remove">Delete</button></div>
      </div>
      <div class="card">
        <div class="row">
          <button class="primary" @click="save">Save</button>
          <span class="ok" v-if="ok">Saved</span>
        </div>
        <p class="muted small">Save does not rebuild the nav graph. Publish a new version for the public Tour / showcase to load panels. Draft media URLs need admin auth until published.</p>
        <div class="err" v-if="err">{{err}}</div>
      </div>
    </div></div>`,
  setup(props, { emit }) {
    const el = ref(null);
    const twinFrame = ref(null);
    const rows = ref(WFMediaPanels.parsePanels((props.b.pipeline_config || {}).media_panels));
    const dirty = ref(false);
    const sel = ref(null);
    const floor = ref(props.b.floors.length ? props.b.floors[0].fid : "F1");
    const placing = ref(false);
    const viewMode = ref("twin");
    const mapStyle = ref("map");
    const err = ref("");
    const ok = ref(false);
    const uploading = ref(false);
    const sc = ref("");
    const twinBusy = ref(false);
    const twinOk = ref(false);
    const twinErr = ref(false);
    const twinStatus = ref("");
    const twinHint = ref("");
    let map = null, markers = [];
    let twinSession = null;
    const hasGeo = computed(() => !!(props.b.georef && props.b.georef.model_to_epsg3857_affine));
    const mapHint = computed(() => {
      if (!hasGeo.value) return "No georeference: prefer Digital twin or typed XYZ";
      if (!sel.value) return "Select or add a panel";
      if (placing.value) return "Click the plan to place " + (sel.value.name || sel.value.id || "panel");
      return "Map click sets model XY (z kept)";
    });
    const helpText = computed(() => {
      if (viewMode.value === "twin") return "Digital twin: Open/Reconnect SDK, aim at the screen/wall, Use pointer (stores position + normal) or Use sweep. Then Save.";
      if (viewMode.value === "3d") return "3D map: Place on map uses georeference XY.";
      if (viewMode.value === "satellite") return "Satellite: Place on map uses georeference XY.";
      return "2D: Place on map or switch to Digital twin for wall normals.";
    });
    function affine() { return props.b.georef && props.b.georef.model_to_epsg3857_affine; }
    function markDirty() { ok.value = false; dirty.value = true; drawMarkers(); }
    function placedLabel(e) {
      if (WFMediaPanels.modelComplete(e.model)) return "x " + e.model.x + ", y " + e.model.y;
      return "not placed";
    }
    function select(e) {
      if (e && !Array.isArray(e.buttons)) e.buttons = [];
      sel.value = e; drawMarkers();
    }
    function addButton() {
      if (!sel.value) return;
      if (!Array.isArray(sel.value.buttons)) sel.value.buttons = [];
      sel.value.buttons.push(WFMediaPanels.blankButton ? WFMediaPanels.blankButton() : { label: "", url: "" });
      markDirty();
    }
    function removeButton(i) {
      if (!sel.value || !Array.isArray(sel.value.buttons)) return;
      sel.value.buttons.splice(i, 1);
      markDirty();
    }
    function add() {
      let n = rows.value.length + 1;
      const have = new Set(rows.value.map(r => r.id));
      let id = "screen_" + n;
      while (have.has(id)) { n += 1; id = "screen_" + n; }
      const e = WFMediaPanels.blankRow({ id: id, name: "Screen " + n, kind: "image", floor: floor.value, published: true });
      rows.value.push(e);
      select(e);
      placing.value = !!hasGeo.value && viewMode.value !== "twin";
      markDirty();
    }
    function remove() {
      const s = sel.value; if (!s) return;
      if (!confirm("Remove " + (s.name || s.id || "this panel") + " from the list? Save to persist.")) return;
      rows.value = rows.value.filter(r => r._k !== s._k);
      sel.value = null; markDirty();
    }
    function applyPlace(xy, how) {
      const s = sel.value; if (!s) return;
      WFMediaPanels.applyPlacement(s, xy, how);
      if (!s.floor) s.floor = floor.value;
      markDirty();
      toast("Placed (" + how + "): " + s.model.x + ", " + s.model.y + (s.model.z !== "" && s.model.z != null ? ", z " + s.model.z : ""));
    }
    async function onUpload(ev) {
      const file = ev.target && ev.target.files && ev.target.files[0];
      if (!file || !sel.value) return;
      uploading.value = true; err.value = "";
      try {
        const fd = new FormData();
        fd.append("file", file, file.name);
        const tok = localStorage.getItem("wf_admin_token") || "";
        const r = await fetch("/api/v1/admin/buildings/" + props.b.slug + "/media", {
          method: "POST",
          headers: tok ? { Authorization: "Bearer " + tok } : {},
          body: fd
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.detail || d.message || ("upload " + r.status));
        sel.value.src = d.url;
        if (/\.(mp4|webm|mov)$/i.test(d.filename || "")) sel.value.kind = "video";
        else if (/\.(jpe?g|png|webp|gif)$/i.test(d.filename || "")) sel.value.kind = "image";
        markDirty();
        toast("Uploaded " + d.filename);
      } catch (e) { err.value = e.message; toast(e.message); }
      finally { uploading.value = false; if (ev.target) ev.target.value = ""; }
    }
    function drawMarkers() {
      if (!map || !affine()) return;
      markers.forEach(m => m.remove()); markers = [];
      const A = affine();
      rows.value.forEach(e => {
        if (!WFMediaPanels.modelComplete(e.model)) return;
        const ll = Geo.ll(A, +e.model.x, +e.model.y);
        const node = document.createElement("div");
        node.className = "media-marker" + (sel.value && sel.value._k === e._k ? " sel" : "") + (e.kind === "video" ? " vid" : (e.kind === "text" ? " txt" : ""));
        node.title = (e.name || e.id);
        const m = new maplibregl.Marker({ element: node, draggable: true }).setLngLat(ll).addTo(map);
        node.addEventListener("click", (ev) => { ev.stopPropagation(); select(e); });
        m.on("dragend", () => {
          const p = m.getLngLat();
          const xy = Geo.model(A, p.lng, p.lat);
          WFMediaPanels.applyPlacement(e, { x: xy[0], y: xy[1], z: e.model.z }, "map-drag");
          markDirty();
          if (sel.value && sel.value._k === e._k) sel.value = e;
        });
        markers.push(m);
      });
    }
    function rehydrateFromProps(pc) {
      const src = pc || (props.b.pipeline_config || {});
      const next = WFMediaPanels.parsePanels(src.media_panels);
      const keep = sel.value && sel.value.id;
      rows.value = next;
      sel.value = keep ? (next.find(r => r.id === keep) || null) : null;
      dirty.value = false;
      drawMarkers();
    }
    async function pull() {
      if (dirty.value) return;
      try {
        const nb = await api("/admin/buildings/" + props.b.slug);
        if (dirty.value) return;
        rehydrateFromProps(nb.pipeline_config || {});
      } catch (e) { /* keep local */ }
    }
    watch(() => (props.b && props.b.pipeline_config && props.b.pipeline_config.media_panels), () => {
      if (dirty.value) return;
      rehydrateFromProps();
    }, { deep: true });
    async function save() {
      err.value = ""; ok.value = false;
      try {
        const panels = WFMediaPanels.serializePanels(rows.value, { strict: false });
        const pc = WFMediaPanels.mergePipeline(props.b.pipeline_config, panels);
        await api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } });
        dirty.value = false;
        ok.value = true;
        const drafts = panels.filter(e => e.draft).length;
        if (!panels.length) toast("Saved (no media panels)");
        else if (drafts) toast("Saved " + panels.length + " panel(s) (draft — add src + place before publish)");
        else toast("Saved " + panels.length + " media panel(s)");
        emit("reload");
      } catch (e) { err.value = e.message; toast(e.message); }
    }
    function setTwinStatus(msg, isErr) {
      twinStatus.value = msg || "";
      twinErr.value = !!isErr;
    }
    function teardownTwinSession() {
      try { if (twinSession && twinSession.disconnect) twinSession.disconnect(); } catch (_) { /* ignore */ }
      twinSession = null;
      twinOk.value = false;
    }
    function closeTwin() {
      teardownTwinSession();
      sc.value = "";
      twinStatus.value = "";
      twinHint.value = "";
      twinErr.value = false;
      const fr = twinFrame.value;
      if (fr) fr.src = "about:blank";
    }
    async function openTwin() {
      if (!window.MpPlace) { toast("mp_place.js not loaded"); return; }
      twinBusy.value = true;
      twinHint.value = "";
      twinOk.value = false;
      teardownTwinSession();
      setTwinStatus("Fetching Showcase URL (sdk=1)…", false);
      try {
        const info = await api(`/admin/buildings/${props.b.slug}/showcase?sdk=1`);
        const url = info.url;
        const key = info.application_key || MpPlace.keyFromShowcaseUrl(url) || "";
        if (!info.sdk_key_configured || !key) {
          sc.value = (await api(`/admin/buildings/${props.b.slug}/showcase`)).url;
          setTwinStatus("SDK key not configured on the server. Twin is view-only; use map or typed XYZ.", true);
          twinHint.value = MpPlace.domainHint();
          return;
        }
        sc.value = url;
        await nextTick();
        const fr = twinFrame.value;
        if (!fr) { setTwinStatus("Twin iframe missing", true); return; }
        fr.src = "about:blank";
        await new Promise(r => setTimeout(r, 40));
        const loadP = MpPlace.waitIframeLoad(fr, 12000);
        fr.src = url;
        await loadP;
        const session = await MpPlace.connect({
          iframe: fr,
          applicationKey: key,
          onStatus: (m) => setTwinStatus(m, false)
        });
        if (!session.ok) {
          setTwinStatus("Could not connect Matterport SDK: " + (session.error || "unknown"), true);
          twinHint.value = session.hint || MpPlace.domainHint();
          twinOk.value = false;
          return;
        }
        twinSession = session;
        twinOk.value = true;
        twinHint.value = "";
        setTwinStatus("SDK connected. Aim at the wall/screen, then Use pointer (best) or Use sweep.", false);
      } catch (e) {
        setTwinStatus(e.message || String(e), true);
        twinHint.value = window.MpPlace ? MpPlace.domainHint() : "";
      } finally {
        twinBusy.value = false;
      }
    }
    function usePointerHit() {
      if (!sel.value) { toast("Select or add a panel first"); return; }
      if (!twinSession || !twinSession.ok) { toast("Connect the twin SDK first"); return; }
      const xy = twinSession.pointerModelXY();
      if (!xy) { toast("No pointer hit yet — move the cursor over the surface in the twin"); return; }
      applyPlace(xy, "twin pointer");
    }
    function useCurrentSweep() {
      if (!sel.value) { toast("Select or add a panel first"); return; }
      if (!twinSession || !twinSession.ok) { toast("Connect the twin SDK first"); return; }
      const xy = twinSession.sweepModelXY();
      if (!xy) { toast("Not at a sweep — enter Inside mode and stand near the panel"); return; }
      applyPlace(xy, "twin sweep");
    }
    function syncMapPresentation() {
      if (!map || !isMapViewMode(viewMode.value)) return;
      applyMapViewMode(map, viewMode.value, { beforeLayerId: "units", mapStyle: mapStyle.value });
    }
    onMounted(async () => {
      await pull();
      map = makeMap(el.value, props.b, basemapKindForMode(viewMode.value, mapStyle.value));
      await whenLoaded(map);
      indoorLayers(map);
      await loadIndoor(map, props.b.slug, floor.value);
      syncMapPresentation();
      drawMarkers();
      map.on("click", (ev) => {
        if (viewMode.value === "twin" || !placing.value || !sel.value) return;
        const A = affine();
        if (!A) { toast("No georeference. Use twin or typed XYZ."); return; }
        const xy = Geo.model(A, ev.lngLat.lng, ev.lngLat.lat);
        const z = sel.value.model && sel.value.model.z !== "" && sel.value.model.z != null ? +sel.value.model.z : 1.4;
        applyPlace({ x: xy[0], y: xy[1], z: z }, "map");
        placing.value = false;
      });
      if (viewMode.value === "twin" && !sc.value && !twinBusy.value) openTwin();
    });
    onBeforeUnmount(() => {
      if (dirty.value) {
        try {
          const panels = WFMediaPanels.serializePanels(rows.value, { strict: false });
          const pc = WFMediaPanels.mergePipeline(props.b.pipeline_config, panels);
          api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } }).catch(() => {});
        } catch (e) { /* ignore */ }
      }
      teardownTwinSession();
      if (map) map.remove();
    });
    watch(floor, async () => { if (map) { await loadIndoor(map, props.b.slug, floor.value); drawMarkers(); } });
    watch(viewMode, async (m) => {
      if (m === "twin") {
        placing.value = false;
        await nextTick();
        if (!sc.value && !twinBusy.value) openTwin();
      } else {
        await nextTick();
        syncMapPresentation();
        drawMarkers();
      }
    });
    watch(mapStyle, () => { if (viewMode.value === "2d" || viewMode.value === "3d") syncMapPresentation(); });
    return { el, twinFrame, rows, sel, floor, placing, viewMode, mapStyle, err, ok, uploading, sc, twinBusy, twinOk, twinErr, twinStatus, twinHint, mapHint, helpText, select, add, remove, save, openTwin, closeTwin, usePointerHit, useCurrentSweep, onUpload, markDirty, placedLabel, addButton, removeButton };
  }
};


const TourModes = {
  props: ["b"], emits: ["reload"],
  template: `<div class="split tour-modes-split">
    <div class="mapwrap tour-preview-wrap">
      <iframe class="showcase map-twin-frame" ref="twinFrame" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write; gyroscope; accelerometer" allowfullscreen></iframe>
      <div class="toolbar">
        <span class="tb-label">Tour preview</span>
        <button class="sm primary" @click="reloadTwin" :disabled="scBusy || !hasModel">{{scBusy ? 'Loading…' : (sc ? 'Reload Showcase' : 'Open Showcase')}}</button>
        <button class="sm" @click="closeTwin" v-if="sc">Close</button>
        <a class="btn sm" v-if="publicTourHref" :href="publicTourHref" target="_blank" rel="noopener">Public Tour ↗</a>
        <span class="badge" :class="hasModel ? 'ok' : 'bad'">{{hasModel ? (e.embed_showcase ? 'Embed on' : 'Embed off') : 'No model id'}}</span>
      </div>
      <div class="twin-status map-twin-status" v-if="scBusy">Loading Showcase…</div>
      <div class="twin-status map-twin-status err" v-else-if="scErr">{{scErr}}</div>
      <div class="map-empty" v-if="!hasModel"><p>Set a Matterport model ID on Overview to preview the digital twin Tour.</p></div>
      <div class="map-empty" v-else-if="!e.embed_showcase && !scBusy && !sc"><p>Embed Showcase Tour is off. Enable it (or still Open Showcase) to preview the twin used by public Tour.</p></div>
      <p class="map-help">Live Matterport Embed preview (same Showcase as public Tour). Enter / look around in the iframe. Route play/pause HUD is on the public viewer after Directions → Tour. Mesh tour (when enabled) uses published GLB in AR Preview — see side note.</p>
    </div>
    <div class="side">
      <div class="card">
        <h2 style="margin-top:0">{{t("admin.tour") || "Tour"}} settings</h2>
        <p class="muted small" style="margin-top:0">Which interior tour modes appear on Directions after publish. Viewer only shows a mode when enabled here <em>and</em> assets/config exist.</p>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:10px">
          <label class="tog"><input type="checkbox" v-model="e.embed_showcase"> <span><b>Embed Showcase Tour</b> (current Tour interior — Matterport sweep hops via Embed SDK)</span></label>
          <label class="tog"><input type="checkbox" v-model="e.mesh_tour"> <span><b>Mesh tour</b> (Path B — continuous eye-height walk on published <code>model_full.glb</code> via AR Preview). Hidden if no GLB after publish.</span></label>
          <label class="tog"><input type="checkbox" v-model="e.bundle_scene"> <span><b>Bundle Scene</b> (Path A scaffold — self-hosted Showcase Bundle). Free camera is <b>Dollhouse-only</b> per Matterport docs; INSIDE continuous walk is <b>not</b> claimed.</span></label>
          <div>
            <label>Bundle showcase URL</label>
            <input v-model="e.bundle_url" placeholder="https://…/showcase.html or /bundle/showcase.html" :disabled="!e.bundle_scene">
            <p class="muted small" style="margin:4px 0 0">Required to show an enabled Bundle button. Leave empty → viewer shows disabled / unavailable. Same SDK key domain whitelist as Embed; Bundle entitlement + $ are account-specific (not invented here).</p>
          </div>
          <div>
            <label>Bundle note (optional, shown in viewer)</label>
            <input v-model="e.bundle_note" placeholder="e.g. Dollhouse path spike only" :disabled="!e.bundle_scene">
          </div>
          <p class="muted small"><code>bundle_camera</code> fixed to <b>dollhouse</b> (documented free-cam mode).</p>
        </div>
        <div class="twin-card" v-if="e.mesh_tour" style="margin-top:12px">
          <b>Mesh tour note</b>
          <p class="muted small" style="margin:6px 0">{{glbNote}}</p>
          <a v-if="meshPreviewHref" class="btn sm" :href="meshPreviewHref" target="_blank" rel="noopener">Open Mesh tour (AR Preview) ↗</a>
          <p class="muted small" style="margin:6px 0 0">Admin keeps this tab Embed-first (no in-tab GLB walker). Public play/pause HUD: <code>platform/viewer/mp_preview.js</code>.</p>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="primary" @click="save" :disabled="busy">{{t("common.save") || "Save"}}</button>
          <span class="ok" v-if="saved">{{t("common.saved") || "Saved"}}</span>
          <span class="err" v-if="err">{{err}}</span>
        </div>
        <p class="muted small" style="margin-top:12px;margin-bottom:0">Save writes <code>pipeline_config.tour_modes</code>. <b>Re-publish</b> so the public viewer picks up flags. Mesh tour also needs a published GLB (<code>glb</code> pipeline step).</p>
      </div>
    </div>
  </div>`,
  setup(props, { emit }) {
    const e = reactive(WFTourModes.parseTourModes((props.b.pipeline_config || {}).tour_modes));
    const saved = ref(false), err = ref(""), busy = ref(false), dirty = ref(false);
    const sc = ref(""), scBusy = ref(false), scErr = ref("");
    const twinFrame = ref(null);
    const hasGlb = ref(false);
    const hasModel = computed(() => !!(props.b && props.b.matterport_model_id));
    const publicTourHref = computed(() => {
      if (!props.b.published_version) return "";
      return (window.WF_VIEWER_URL || "/") + "tour.html?b=" + encodeURIComponent(props.b.slug);
    });
    const glbNote = computed(() => {
      if (hasGlb.value) return "Published model_full.glb is present — Mesh tour can appear on Directions after publish with this toggle on.";
      if (props.b.published_version) return "No published model_full.glb found yet. Run the glb pipeline step and re-publish, or Mesh stays hidden in the viewer.";
      return "Building not published yet. Mesh tour needs a published GLB after the glb pipeline step.";
    });
    const meshPreviewHref = computed(() => {
      if (!e.mesh_tour || !hasGlb.value) return "";
      return "/ar_webxr/?b=" + encodeURIComponent(props.b.slug) + "&mesh_tour=1";
    });
    function rehydrate(pc) {
      const n = WFTourModes.parseTourModes((pc || {}).tour_modes);
      Object.assign(e, n);
      dirty.value = false;
    }
    async function checkGlb() {
      hasGlb.value = false;
      if (!props.b.published_version) return;
      try {
        const r = await fetch(`/api/v1/public/buildings/${props.b.slug}/data/model_full.glb`, { method: "HEAD" });
        hasGlb.value = r.ok;
      } catch (ex) { hasGlb.value = false; }
    }
    async function reloadTwin() {
      if (!hasModel.value) { scErr.value = "No Matterport model id"; return; }
      scBusy.value = true; scErr.value = "";
      try { sc.value = await fetchShowcaseUrl(props.b.slug); }
      catch (x) { sc.value = ""; scErr.value = x.message || "Could not load Showcase"; }
      scBusy.value = false;
    }
    function closeTwin() {
      sc.value = "";
      scErr.value = "";
      const fr = twinFrame.value;
      if (fr) fr.src = "about:blank";
    }
    watch(() => props.b && props.b.pipeline_config && props.b.pipeline_config.tour_modes, () => {
      if (!dirty.value) rehydrate(props.b.pipeline_config || {});
    }, { deep: true });
    ["embed_showcase", "mesh_tour", "bundle_scene", "bundle_url", "bundle_note"].forEach((k) => {
      watch(() => e[k], () => { dirty.value = true; });
    });
    async function save() {
      busy.value = true; err.value = ""; saved.value = false;
      try {
        const pc = WFTourModes.mergePipeline(props.b.pipeline_config, e);
        await api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } });
        dirty.value = false; saved.value = true;
        emit("reload");
        setTimeout(() => { saved.value = false; }, 2000);
      } catch (ex) { err.value = (ex && ex.message) || String(ex); }
      finally { busy.value = false; }
    }
    onMounted(async () => {
      await checkGlb();
      if (hasModel.value) reloadTwin();
    });
    onBeforeUnmount(() => {
      if (!dirty.value) return;
      try {
        const pc = WFTourModes.mergePipeline(props.b.pipeline_config, e);
        api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } }).catch(() => {});
      } catch (_) {}
    });
    return { e, save, saved, err, busy, t, sc, scBusy, scErr, twinFrame, hasModel, hasGlb, glbNote, publicTourHref, meshPreviewHref, reloadTwin, closeTwin };
  }
};


const AccessSettings = {
  props: ["b"], emits: ["reload"],
  template: `<div>
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin-top:0">{{t("admin.access") || "Access"}}</h2>
      <p class="muted small" style="margin-top:0">Digital twin / Tour gate and public routing path restrictions. Saves <code>pipeline_config.access</code> (PIN is hashed; never published). Re-publish so the public viewer and filtered nav graph pick this up. Indoor mesh may still show corridors visually; routing will not use excluded edges.</p>
      <p class="wf-admin-chat-hint">Ask NavMe Spatial Assistant about Access <button type="button" @click="openAccessChat">Open NavMe Spatial Assistant</button></p>
      <h3 style="margin:14px 0 8px">Digital twin / Tour</h3>
      <div class="row" style="flex-direction:column;align-items:stretch;gap:10px;max-width:640px">
        <label>Twin access</label>
        <select v-model="e.twin" style="max-width:280px">
          <option value="public">Public (current behaviour)</option>
          <option value="pin">PIN required</option>
          <option value="disabled">Disabled (hide Tour / 403 matterport)</option>
        </select>
        <template v-if="e.twin==='pin'">
          <label>PIN (4–8 letters/digits)</label>
          <input v-model="e.twin_pin" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing PIN" maxlength="8" style="max-width:280px">
          <p class="muted small" style="margin:0" v-if="e.has_pin_hash && !e.twin_pin">A PIN hash is already stored. Enter a new PIN to replace it.</p>
          <label class="tog"><input type="checkbox" v-model="e.clear_twin_pin"> Clear stored PIN</label>
        </template>
        <label class="tog"><input type="checkbox" v-model="e.tour_public" :disabled="e.twin==='disabled'"> <span><b>Tour / Embed public</b> — if off, hide Tour for anonymous even when twin is public (no application key via public matterport).</span></label>
      </div>
    </div>

    <div class="split access-split">
      <div class="mapwrap">
        <div class="map" ref="el"></div>
        <div class="toolbar">
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="f in b.floors" :value="f.fid">{{f.label}} ({{f.fid}})</option></select>
          <map-style-bar v-model="mapStyle"></map-style-bar>
          <span class="small muted" v-if="e.routing_mode==='exclude_edges'">Click an edge to toggle exclude · red dashed = restricted</span>
          <span class="small muted" v-else>All edges public (switch routing mode to exclude)</span>
        </div>
        <p class="map-help">{{mapHelp}}</p>
        <div class="access-legend" aria-hidden="true">
          <span><i class="lg-ok"></i> Allowed</span>
          <span><i class="lg-ex"></i> Excluded</span>
          <span><i class="lg-pub"></i> Public route</span>
          <span><i class="lg-full"></i> Full / restricted-only</span>
        </div>
      </div>
      <div class="side">
        <div class="card">
          <h2 style="margin-top:0">Restricted paths</h2>
          <label>Routing mode</label>
          <select v-model="e.routing_mode">
            <option value="all_public">All public (no edge filter)</option>
            <option value="exclude_edges">Exclude selected edges from published graph</option>
          </select>
          <template v-if="e.routing_mode==='exclude_edges'">
            <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
              <button class="sm" type="button" @click="loadEdges" :disabled="edgesBusy">{{edgesBusy ? 'Loading…' : 'Reload draft edges'}}</button>
              <input class="grow" v-model="edgeFilter" placeholder="Filter by id / label / floor" style="min-width:120px">
            </div>
            <p class="muted small" style="margin:6px 0">{{excludedCount}} excluded · {{filteredEdges.length}} shown / {{edgeRows.length}} loaded</p>
            <p class="err small" v-if="edgesErr">{{edgesErr}}</p>
            <div v-if="filteredEdges.length" style="max-height:180px;overflow:auto;border:1px solid var(--border,#ddd);border-radius:8px;padding:8px">
              <label class="tog" v-for="ed in filteredEdges" :key="ed.id" style="display:flex;gap:8px;align-items:flex-start;margin:4px 0">
                <input type="checkbox" :value="ed.id" v-model="e.excluded_edge_ids" @change="syncMapEdges">
                <span class="small"><code class="mono">{{ed.id}}</code> · {{ed.len}} m · floor {{ed.floor}} <span class="muted" v-if="ed.label">· {{ed.label}}</span></span>
              </label>
            </div>
            <label style="margin-top:8px">Paste edge ids (optional)</label>
            <textarea v-model="e.edge_paste" rows="2" class="mono" placeholder="u|v per line or comma-separated"></textarea>
            <button class="sm" type="button" @click="applyPaste">Add pasted ids</button>
          </template>
          <p class="muted small" v-else style="margin-top:8px">Published nav graph keeps all edges. Switch to exclude mode to restrict corridors on the map.</p>
        </div>

        <div class="card">
          <h2 style="margin-top:0">Route impact preview</h2>
          <p class="muted small" style="margin-top:0">Compares path on <b>full</b> draft graph vs <b>filtered</b> (current exclusions) — no publish required. Uses draft POIs.</p>
          <label>From</label>
          <select v-model="fromKey"><option value="">—</option><option v-for="p in pois" :value="p.key">{{p.name}} ({{p.floor}})</option></select>
          <label>To</label>
          <select v-model="toKey"><option value="">—</option><option v-for="p in pois" :value="p.key">{{p.name}} ({{p.floor}})</option></select>
          <label class="row" style="gap:6px;margin-top:6px"><input type="checkbox" v-model="sfree" style="width:auto"> Step-free only</label>
          <div class="row" style="margin-top:10px">
            <button class="primary sm" type="button" @click="previewRoute" :disabled="!fromKey||!toKey||previewBusy">{{previewBusy ? 'Computing…' : 'Preview route'}}</button>
            <button class="sm" type="button" @click="clearPreview" v-if="preview">Clear</button>
          </div>
          <p class="err small" v-if="previewErr">{{previewErr}}</p>
          <div v-if="preview" class="kv small" style="margin-top:10px">
            <div>Full draft</div><div>{{preview.full ? (preview.full.length_m + ' m · ' + preview.full.eta_s + ' s') : 'no route'}}</div>
            <div>Public / filtered</div><div>{{preview.restricted ? (preview.restricted.length_m + ' m · ' + preview.restricted.eta_s + ' s') : 'no route'}}</div>
          </div>
          <p class="small" style="margin-top:8px" :class="preview && preview.public_blocked ? 'err' : 'muted'" v-if="preview && preview.message">{{preview.message}}</p>
          <p class="muted small" v-if="preview">Green = public/allowed path · orange = full path (or segments only available with restricted edges).</p>
        </div>

        <div class="card">
          <div class="row">
            <button class="primary" @click="save" :disabled="busy">{{t("common.save") || "Save"}}</button>
            <span class="ok" v-if="saved">{{t("common.saved") || "Saved"}}</span>
            <span class="err" v-if="err">{{err}}</span>
          </div>
          <p class="muted small" style="margin-top:12px;margin-bottom:0">Save merges <code>access</code> into <code>pipeline_config</code> without wiping elevators / media_panels / tour_modes / debug. <b>Re-publish</b> to freeze twin policy and write the filtered public <code>nav_graph.json</code>.</p>
        </div>
      </div>
    </div>
  </div>`,
  setup(props, { emit }) {
    const e = reactive(WFAccess.parseAccess((props.b.pipeline_config || {}).access));
    const saved = ref(false), err = ref(""), busy = ref(false), dirty = ref(false);
    const edgeRows = ref([]), edgesBusy = ref(false), edgesErr = ref(""), edgeFilter = ref("");
    const el = ref(null), floor = ref(props.b.floors.length ? props.b.floors[0].fid : "F1"), mapStyle = ref("map");
    const pois = ref([]), fromKey = ref(""), toKey = ref(""), sfree = ref(false);
    const preview = ref(null), previewBusy = ref(false), previewErr = ref("");
    let map = null, navFc = null, clickBound = false;
    const filteredEdges = computed(() => {
      const q = (edgeFilter.value || "").trim().toLowerCase();
      if (!q) return edgeRows.value.slice(0, 400);
      return edgeRows.value.filter((ed) =>
        (ed.id && ed.id.toLowerCase().includes(q)) ||
        (ed.label && ed.label.toLowerCase().includes(q)) ||
        (ed.floor && String(ed.floor).toLowerCase().includes(q))
      ).slice(0, 400);
    });
    const excludedCount = computed(() => (e.excluded_edge_ids || []).length);
    const mapHelp = computed(() => {
      if (e.routing_mode !== "exclude_edges") return "Map shows draft nav edges (all public). Switch routing mode to exclude edges, then click corridors to restrict.";
      return "Red dashed = excluded from published public routing. Click edge to toggle. Preview route shows full vs filtered impact.";
    });
    function rehydrate(pc) {
      const n = WFAccess.parseAccess((pc || {}).access);
      Object.assign(e, n);
      dirty.value = false;
    }
    watch(() => props.b && props.b.pipeline_config && props.b.pipeline_config.access, () => {
      if (!dirty.value) rehydrate(props.b.pipeline_config || {});
    }, { deep: true });
    ["twin", "twin_pin", "clear_twin_pin", "tour_public", "routing_mode", "edge_paste"].forEach((k) => {
      watch(() => e[k], () => { dirty.value = true; });
    });
    watch(() => e.excluded_edge_ids && e.excluded_edge_ids.slice(), () => { dirty.value = true; syncMapEdges(); }, { deep: true });
    watch(() => e.routing_mode, (m) => {
      if (m === "exclude_edges" && !edgeRows.value.length) loadEdges();
      syncMapEdges();
    });

    function rowsFromNav(fc) {
      const rows = [];
      for (const f of (fc.features || [])) {
        const pr = f.properties || {};
        if (!pr.edge_id) continue;
        rows.push({
          id: pr.edge_id,
          floor: pr.floor || "?",
          len: pr.length != null ? Number(pr.length).toFixed(1) : "?",
          label: [pr.u_label, pr.v_label].filter(Boolean).join(" → ")
        });
      }
      return rows;
    }
    async function ensureNav() {
      if (navFc) return navFc;
      navFc = await api(`/admin/buildings/${props.b.slug}/nav`);
      edgeRows.value = rowsFromNav(navFc);
      return navFc;
    }
    async function loadEdges() {
      edgesBusy.value = true; edgesErr.value = "";
      try {
        navFc = null;
        await ensureNav();
        syncMapEdges();
        if (!edgeRows.value.length) edgesErr.value = "No edges in draft nav graph yet (run pipeline graph step).";
      } catch (ex) {
        edgesErr.value = (ex && ex.message) || String(ex);
      } finally { edgesBusy.value = false; }
    }
    function syncMapEdges() {
      if (!map || !navFc) return;
      const excl = e.routing_mode === "exclude_edges" ? (e.excluded_edge_ids || []) : [];
      const lines = (navFc.features || []).filter(f => f.geometry && f.geometry.type === "LineString" && f.properties && f.properties.floor === floor.value);
      const annotated = WFAccess.annotateNavFeatures(lines, excl);
      setGeo(map, "acc-nav", { type: "FeatureCollection", features: annotated });
    }
    function onEdgeClick(ev) {
      if (e.routing_mode !== "exclude_edges") return;
      const f = ev.features && ev.features[0];
      if (!f || !f.properties || !f.properties.edge_id) return;
      e.excluded_edge_ids = WFAccess.toggleEdgeExcluded(e.excluded_edge_ids, f.properties.edge_id);
      dirty.value = true;
      syncMapEdges();
    }
    function syncMapPresentation() {
      if (!map) return;
      applyMapViewMode(map, "2d", { beforeLayerId: "units", mapStyle: mapStyle.value });
    }
    function drawPreviewRoutes() {
      if (!map) return;
      const feats = [];
      const p = preview.value;
      function legsToFeats(route, kind) {
        if (!route || !route.legs) return;
        const legs = route.legs;
        for (let i = 1; i < legs.length; i++) {
          feats.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [legs[i - 1].lonlat, legs[i].lonlat] },
            properties: { kind, floor: legs[i].floor }
          });
        }
      }
      if (p) {
        // Full path underlay (orange) when it exists; public/restricted on top (green)
        legsToFeats(p.full, "full");
        legsToFeats(p.restricted, "public");
      }
      setGeo(map, "acc-route", { type: "FeatureCollection", features: feats });
      if (feats.length) {
        const cs = feats.flatMap(f => f.geometry.coordinates);
        const bb = cs.reduce((b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])], [180, 90, -180, -90]);
        try { map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 20.5 }); } catch (_) {}
      }
    }
    async function previewRoute() {
      previewBusy.value = true; previewErr.value = ""; preview.value = null;
      try {
        const body = {
          from_key: fromKey.value,
          to_key: toKey.value,
          step_free: !!sfree.value,
          excluded_edge_ids: e.routing_mode === "exclude_edges" ? (e.excluded_edge_ids || []) : []
        };
        const r = await api(`/admin/buildings/${props.b.slug}/route-access-preview`, { method: "POST", json: body });
        preview.value = r;
        await nextTick();
        drawPreviewRoutes();
      } catch (ex) {
        previewErr.value = (ex && ex.message) || String(ex);
        if (map) setGeo(map, "acc-route", { type: "FeatureCollection", features: [] });
      } finally { previewBusy.value = false; }
    }
    function clearPreview() {
      preview.value = null; previewErr.value = "";
      if (map) setGeo(map, "acc-route", { type: "FeatureCollection", features: [] });
    }
    function applyPaste() {
      const ids = WFAccess.parseEdgeIdPaste(e.edge_paste);
      const set = new Set(e.excluded_edge_ids || []);
      ids.forEach((id) => set.add(id));
      e.excluded_edge_ids = Array.from(set);
      e.edge_paste = "";
      dirty.value = true;
      if (e.routing_mode !== "exclude_edges") e.routing_mode = "exclude_edges";
      syncMapEdges();
    }
    async function save() {
      busy.value = true; err.value = ""; saved.value = false;
      try {
        if (e.twin === "pin" && e.twin_pin && !/^[A-Za-z0-9]{4,8}$/.test(String(e.twin_pin).trim())) {
          throw new Error("PIN must be 4–8 letters or digits");
        }
        const pc = WFAccess.mergePipeline(props.b.pipeline_config, e);
        await api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } });
        dirty.value = false; saved.value = true;
        e.twin_pin = "";
        e.clear_twin_pin = false;
        emit("reload");
        setTimeout(() => { saved.value = false; }, 2000);
      } catch (ex) { err.value = (ex && ex.message) || String(ex); }
      finally { busy.value = false; }
    }

    onMounted(async () => {
      try {
        pois.value = (await api(`/admin/buildings/${props.b.slug}/pois`)).sort((a, b) => a.name.localeCompare(b.name));
      } catch (_) { pois.value = []; }
      map = makeMap(el.value, props.b, basemapKindForMode("2d", mapStyle.value));
      await whenLoaded(map);
      indoorLayers(map);
      await loadIndoor(map, props.b.slug, floor.value);
      syncMapPresentation();
      map.addSource("acc-nav", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "acc-nav-ok", type: "line", source: "acc-nav",
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["!=", ["get", "excluded"], true]],
        paint: { "line-color": "#5f6368", "line-width": 2.2, "line-opacity": 0.85 },
        layout: { "line-cap": "round", "line-join": "round" } });
      map.addLayer({ id: "acc-nav-ex", type: "line", source: "acc-nav",
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "excluded"], true]],
        paint: { "line-color": "#c5221f", "line-width": 3.5, "line-opacity": 0.95, "line-dasharray": [1.2, 1.2] },
        layout: { "line-cap": "butt", "line-join": "round" } });
      map.addLayer({ id: "acc-nav-hit", type: "line", source: "acc-nav",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#000", "line-width": 14, "line-opacity": 0.01 } });
      map.addSource("acc-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "acc-route-full", type: "line", source: "acc-route",
        filter: ["==", ["get", "kind"], "full"],
        paint: { "line-color": "#e37400", "line-width": 6, "line-opacity": 0.75 },
        layout: { "line-cap": "round", "line-join": "round" } });
      map.addLayer({ id: "acc-route-pub", type: "line", source: "acc-route",
        filter: ["==", ["get", "kind"], "public"],
        paint: { "line-color": "#188038", "line-width": 5, "line-opacity": 0.95 },
        layout: { "line-cap": "round", "line-join": "round" } });
      map.on("click", "acc-nav-hit", onEdgeClick);
      map.on("mouseenter", "acc-nav-hit", () => { map.getCanvas().style.cursor = e.routing_mode === "exclude_edges" ? "pointer" : ""; });
      map.on("mouseleave", "acc-nav-hit", () => { map.getCanvas().style.cursor = ""; });
      clickBound = true;
      try {
        await ensureNav();
        syncMapEdges();
      } catch (ex) {
        edgesErr.value = (ex && ex.message) || String(ex);
      }
    });
    onBeforeUnmount(() => {
      if (map && clickBound) {
        try { map.off("click", "acc-nav-hit", onEdgeClick); } catch (_) {}
      }
      if (map) map.remove();
      map = null;
      if (!dirty.value) return;
      try {
        const pc = WFAccess.mergePipeline(props.b.pipeline_config, e);
        api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } }).catch(() => {});
      } catch (_) {}
    });
    watch(floor, async () => {
      if (!map) return;
      await loadIndoor(map, props.b.slug, floor.value);
      syncMapEdges();
      drawPreviewRoutes();
    });
    watch(mapStyle, () => syncMapPresentation());

    function openAccessChat() {
      try {
        if (window.WFAdminChat && WFAdminChat.openAssistant) {
          WFAdminChat.openAssistant("What does twin=pin mean?");
        }
      } catch (e) {}
    }

    return {
      e, save, saved, err, busy, t, loadEdges, applyPaste, edgeRows, edgesBusy, edgesErr, edgeFilter, filteredEdges, excludedCount,
      el, floor, mapStyle, mapHelp, syncMapEdges,
      pois, fromKey, toKey, sfree, preview, previewBusy, previewErr, previewRoute, clearPreview,
      openAccessChat
    };
  }
};


const Elevators = {
  props: ["b"], emits: ["reload"],
  template: `<div class="split"><div class="mapwrap">
      <div class="map" ref="el" v-show="viewMode!=='twin'"></div>
      <iframe class="showcase map-twin-frame" ref="twinFrame" v-show="viewMode==='twin'" :src="sc || 'about:blank'" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen></iframe>
      <div class="toolbar">
        <view-mode-bar v-model="viewMode"></view-mode-bar>
        <template v-if="viewMode!=='twin'">
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="f in b.floors" :value="f.fid">{{f.label}} ({{f.fid}})</option></select>
          <button class="sm" :class="{primary: placing}" @click="placing=!placing" :disabled="!sel">{{placing ? 'Click map to set door…' : 'Place door on map'}}</button>
          <map-style-bar v-if="viewMode==='2d'||viewMode==='3d'" v-model="mapStyle"></map-style-bar>
          <span class="small muted">{{mapHint}}</span>
        </template>
        <template v-else>
          <label class="tb-label">Floor</label>
          <select v-model="floor" style="width:auto" aria-label="Floor"><option v-for="f in b.floors" :value="f.fid">{{f.label}} ({{f.fid}})</option></select>
          <button class="sm primary" @click="openTwin" :disabled="twinBusy">{{twinBusy ? 'Connecting…' : (sc ? 'Reconnect + SDK' : 'Open / Reconnect')}}</button>
          <button class="sm" @click="usePointerHit" :disabled="!twinOk || !sel">Use pointer</button>
          <button class="sm" @click="useCurrentSweep" :disabled="!twinOk || !sel">Use sweep</button>
          <button class="sm" @click="closeTwin" v-if="sc">Close</button>
          <span class="badge" :class="twinOk ? 'ok' : (twinErr ? 'bad' : '')">{{twinOk ? 'SDK ready' : (sc ? 'Showcase open' : 'Closed')}}</span>
        </template>
      </div>
      <div class="twin-status map-twin-status" :class="{err: twinErr, ok: twinOk && !twinErr}" v-if="viewMode==='twin' && (twinStatus || twinBusy || twinHint)">{{twinBusy && !twinStatus ? 'Connecting…' : (twinStatus || twinHint)}}</div>
      <div class="map-empty" v-if="!sel"><p>Select or add an elevator to place doors on the map or in the digital twin.</p></div>
      <p class="map-help">{{helpText}}</p>
    </div>
    <div class="side">
      <div class="card" style="margin-bottom:12px">
        <h2 style="margin-top:0">Elevators</h2>
        <p class="muted small" style="margin-top:0">Each lift needs an id and a name. Save keeps drafts even if floors/doors are incomplete. Rebuild needs at least two floors and a door (or bbox) on each. Place on the map (2D / 3D / Satellite), in Digital twin mode, or type x,y. An empty list adds no shafts.</p>
        <div class="poilist"><ul>
          <li v-for="e in rows" :key="e._k" :class="{on: sel && sel._k===e._k}" @click="select(e)">
            <span class="dot" style="background:#e37400"></span>
            <span class="grow">{{e.name || e.id || 'Untitled'}}<br><span class="muted small">{{e.id || 'no id'}} · {{e.floors.length ? e.floors.join(', ') : 'no floors'}}</span></span>
          </li>
        </ul></div>
        <div class="row" style="margin-top:8px"><button class="primary" @click="add">+ Add elevator</button></div>
      </div>
      <div class="card" v-if="sel">
        <div class="row"><b class="grow">Edit</b><button class="sm" @click="sel=null">Close</button></div>
        <label>Id</label><input v-model="sel.id" placeholder="elev_main" spellcheck="false">
        <label>Name</label><input v-model="sel.name" placeholder="Main elevator">
        <label>Floors this lift serves</label>
        <div class="lang-checks">
          <label v-for="f in b.floors" :key="f.fid">
            <input type="checkbox" :checked="sel.floors.includes(f.fid)" @change="toggleFloor(f.fid, $event.target.checked)">
            <span>{{f.short_label || f.fid}} <span class="muted small">{{f.fid}}</span></span>
          </label>
        </div>
        <p class="muted small" v-if="!b.floors.length">No floors on this building yet.</p>
        <label>Door on {{floor}} (model metres)</label>
        <div class="row" :key="'door-xy-' + floor">
          <div class="grow"><input type="number" step="0.01" :value="doorField('x')" @input="setDoor('x', $event.target.value)" placeholder="x"></div>
          <div class="grow"><input type="number" step="0.01" :value="doorField('y')" @input="setDoor('y', $event.target.value)" placeholder="y"></div>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="sm" @click="placeOnFloor" :disabled="!hasGeo">Place on this floor</button>
          <button class="sm" @click="copyDoors">Copy this XY to other checked floors</button>
        </div>
        <label class="row" style="gap:6px;margin-top:12px"><input type="checkbox" v-model="sel.useBbox" style="width:auto"> Bounding box (optional, model XY)</label>
        <div class="row" v-if="sel.useBbox">
          <input type="number" step="0.01" v-model="sel.bbox[0]" placeholder="xmin" title="xmin">
          <input type="number" step="0.01" v-model="sel.bbox[1]" placeholder="ymin" title="ymin">
          <input type="number" step="0.01" v-model="sel.bbox[2]" placeholder="xmax" title="xmax">
          <input type="number" step="0.01" v-model="sel.bbox[3]" placeholder="ymax" title="ymax">
        </div>
        <p class="muted small" v-if="sel.useBbox">Same shape as stairs zones: [xmin, ymin, xmax, ymax]. If both bbox and doors are set, the pipeline prefers door XY.</p>
        <div class="row" style="margin-top:10px"><button class="danger" @click="remove">Delete</button></div>
      </div>
      <div class="card">
        <div class="row">
          <button class="primary" @click="save">Save</button>
          <button @click="rebuild">Save &amp; rebuild graph</button>
          <span class="ok" v-if="ok">Saved</span>
        </div>
        <p class="muted small">Rebuild re-runs the nav graph from current elevators. A worker must be running or the job stays queued. Publish separately if the public map should change.</p>
        <div class="err" v-if="err">{{err}}</div>
        <job-log v-if="jobId" :job-id="jobId" @done="onJob"></job-log>
      </div>
    </div></div>`,
  setup(props, { emit }) {
    const el = ref(null);
    const twinFrame = ref(null);
    const rows = ref(WFElevators.parseElevators((props.b.pipeline_config || {}).elevators));
    const dirty = ref(false);
    const sel = ref(null);
    const floor = ref(props.b.floors.length ? props.b.floors[0].fid : "F1");
    const placing = ref(false);
    const viewMode = ref(preferredShowcaseViewMode(props.b, "2d"));
    const mapStyle = ref("map");
    const err = ref("");
    const ok = ref(false);
    const jobId = ref(null);
    const sc = ref("");
    const twinBusy = ref(false);
    const twinOk = ref(false);
    const twinErr = ref(false);
    const twinStatus = ref("");
    const twinHint = ref("");
    let map = null, markers = [];
    let twinSession = null;
    const hasGeo = computed(() => !!(props.b.georef && props.b.georef.model_to_epsg3857_affine));
    const mapHint = computed(() => {
      if (!hasGeo.value) return "No georeference yet: type model XY, use twin, or align the model first";
      if (!sel.value) return "Select or add an elevator";
      if (placing.value) return "Click the plan to set the door for " + (sel.value.name || sel.value.id || "this lift") + " on " + floor.value;
      return "Model XY via the saved georeference";
    });
    const helpText = computed(() => {
      if (viewMode.value === "twin") return "Digital twin: Open/Reconnect SDK, aim at the landing, Use pointer or Use sweep. Floor dropdown chooses which door slot is written.";
      if (viewMode.value === "3d") return "3D: pitched MapLibre view of the floor plan. Place door on map still uses map click + georeference.";
      if (viewMode.value === "satellite") return "Satellite: Esri imagery under the floor plan. Select a lift, then Place door on map.";
      return "2D: map/light floor plan. Select a lift, pick a floor, then Place door on map — or switch to Digital twin.";
    });
    function affine() { return props.b.georef && props.b.georef.model_to_epsg3857_affine; }
    function select(e) { sel.value = e; drawMarkers(); }
    function add() {
      let n = rows.value.length + 1;
      const have = new Set(rows.value.map(r => r.id));
      let id = "elev_" + n;
      while (have.has(id)) { n += 1; id = "elev_" + n; }
      const e = WFElevators.blankRow({ id: id, name: "Elevator " + n, floors: [], doors: {}, bbox: ["", "", "", ""], useBbox: false });
      rows.value.push(e);
      select(e);
      placing.value = !!hasGeo.value && viewMode.value !== "twin";
      ok.value = false; dirty.value = true;
    }
    function toggleFloor(fid, on) {
      const s = sel.value; if (!s) return;
      if (on) { if (!s.floors.includes(fid)) s.floors.push(fid); }
      else s.floors = s.floors.filter(f => f !== fid);
      ok.value = false; dirty.value = true;
      drawMarkers();
    }
    function doorField(axis) {
      const s = sel.value; if (!s) return "";
      const d = (s.doors || {})[floor.value];
      return d && d[axis] != null && d[axis] !== "" ? d[axis] : "";
    }
    function setDoor(axis, raw) {
      const s = sel.value; if (!s) return;
      if (!s.doors || typeof s.doors !== "object") s.doors = {};
      const patch = {};
      patch[axis] = raw === "" ? "" : Number(raw);
      WFElevators.mergeDoor(s, floor.value, patch);
      if (raw !== "" && !s.floors.includes(floor.value)) s.floors.push(floor.value);
      ok.value = false; dirty.value = true;
      drawMarkers();
    }
    function applyDoorXY(x, y, how) {
      const s = sel.value; if (!s) return;
      if (!s.doors || typeof s.doors !== "object") s.doors = {};
      const d = WFElevators.mergeDoor(s, floor.value, { x: WFElevators.round3(x), y: WFElevators.round3(y) });
      if (!s.floors.includes(floor.value)) s.floors.push(floor.value);
      ok.value = false; dirty.value = true;
      drawMarkers();
      toast("Door on " + floor.value + " (" + how + "): " + d.x + ", " + d.y);
    }
    function copyDoors() {
      const s = sel.value; if (!s) return;
      if (!s.doors || typeof s.doors !== "object") s.doors = {};
      const d = s.doors[floor.value];
      if (!d || d.x === "" || d.y === "" || d.x == null || d.y == null) { toast("Set a door on " + floor.value + " first"); return; }
      if (s.floors.length < 2) { toast("Check at least one other floor"); return; }
      s.floors.forEach(f => { WFElevators.mergeDoor(s, f, { x: d.x, y: d.y }); });
      ok.value = false; dirty.value = true;
      drawMarkers();
      toast("Copied door XY to checked floors");
    }
    function remove() {
      const s = sel.value; if (!s) return;
      if (!confirm("Remove " + (s.name || s.id || "this elevator") + " from the list? Save to persist.")) return;
      rows.value = rows.value.filter(r => r._k !== s._k);
      sel.value = null; ok.value = false; dirty.value = true; drawMarkers();
    }
    function placeOnFloor() {
      if (viewMode.value === "twin") viewMode.value = "2d";
      placing.value = true;
    }
    function drawMarkers() {
      if (!map || !affine()) return;
      markers.forEach(m => m.remove()); markers = [];
      const A = affine();
      rows.value.forEach(e => {
        const d = e.doors[floor.value];
        if (!d || d.x === "" || d.y === "" || d.x == null || d.y == null || Number.isNaN(+d.x) || Number.isNaN(+d.y)) return;
        const ll = Geo.ll(A, +d.x, +d.y);
        const node = document.createElement("div");
        node.className = "elev-marker" + (sel.value && sel.value._k === e._k ? " sel" : "");
        node.title = (e.name || e.id) + " " + floor.value;
        const m = new maplibregl.Marker({ element: node, draggable: true }).setLngLat(ll).addTo(map);
        node.addEventListener("click", (ev) => { ev.stopPropagation(); select(e); });
        m.on("dragend", () => {
          const p = m.getLngLat();
          const xy = Geo.model(A, p.lng, p.lat);
          if (!e.doors || typeof e.doors !== "object") e.doors = {};
          WFElevators.mergeDoor(e, floor.value, { x: WFElevators.round3(xy[0]), y: WFElevators.round3(xy[1]) });
          if (!e.floors.includes(floor.value)) e.floors.push(floor.value);
          ok.value = false; dirty.value = true;
          if (sel.value && sel.value._k === e._k) sel.value = e;
          toast("Door moved on " + floor.value);
        });
        markers.push(m);
      });
    }
    function rehydrateFromProps(pc) {
      const src = pc || (props.b.pipeline_config || {});
      const next = WFElevators.parseElevators(src.elevators);
      const keep = sel.value && sel.value.id;
      rows.value = next;
      sel.value = keep ? (next.find(r => r.id === keep) || null) : null;
      dirty.value = false;
      drawMarkers();
    }
    async function pullElevators() {
      if (dirty.value) return;
      try {
        const nb = await api("/admin/buildings/" + props.b.slug);
        if (dirty.value) return;
        rehydrateFromProps(nb.pipeline_config || {});
      } catch (e) { /* keep local */ }
    }
    watch(() => (props.b && props.b.pipeline_config && props.b.pipeline_config.elevators), () => {
      if (dirty.value) return;
      rehydrateFromProps();
    }, { deep: true });
    async function save(opts) {
      const forRebuild = !!(opts && opts.forRebuild);
      err.value = ""; ok.value = false;
      try {
        const elev = WFElevators.serializeElevators(rows.value, props.b.floors, { strict: forRebuild });
        const pc = WFElevators.mergePipeline(props.b.pipeline_config, elev);
        await api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } });
        dirty.value = false;
        ok.value = true;
        const drafts = elev.filter(e => e.draft).length;
        if (!elev.length) toast("Saved (no elevators)");
        else if (drafts) toast("Saved " + elev.length + " elevator" + (elev.length === 1 ? "" : "s") + " (draft — finish floors/doors before rebuild)");
        else toast("Saved " + elev.length + " elevator" + (elev.length === 1 ? "" : "s"));
        emit("reload");
      } catch (e) { err.value = e.message; toast(e.message); }
    }
    async function rebuild() {
      if (!confirm("Save elevators and rebuild the nav graph from the graph step? An empty list does not add shafts. Incomplete drafts must be finished first.")) return;
      await save({ forRebuild: true });
      if (err.value) return;
      try {
        jobId.value = (await api(`/admin/buildings/${props.b.slug}/jobs`, { method: "POST", json: { from_step: "graph", force: true } })).id;
      } catch (e) { err.value = e.message; toast(e.message); }
    }
    function setTwinStatus(msg, isErr) {
      twinStatus.value = msg || "";
      twinErr.value = !!isErr;
    }
    function teardownTwinSession() {
      try { if (twinSession && twinSession.disconnect) twinSession.disconnect(); } catch (_) { /* ignore */ }
      twinSession = null;
      twinOk.value = false;
    }
    function closeTwin() {
      teardownTwinSession();
      sc.value = "";
      twinStatus.value = "";
      twinHint.value = "";
      twinErr.value = false;
      const fr = twinFrame.value;
      if (fr) fr.src = "about:blank";
    }
    async function openTwin() {
      if (!window.MpPlace) { toast("mp_place.js not loaded"); return; }
      twinBusy.value = true;
      twinHint.value = "";
      twinOk.value = false;
      teardownTwinSession();
      setTwinStatus("Fetching Showcase URL (sdk=1)…", false);
      try {
        const info = await api(`/admin/buildings/${props.b.slug}/showcase?sdk=1`);
        const url = info.url;
        const key = info.application_key || MpPlace.keyFromShowcaseUrl(url) || "";
        if (!info.sdk_key_configured || !key) {
          sc.value = (await api(`/admin/buildings/${props.b.slug}/showcase`)).url;
          setTwinStatus("SDK key not configured on the server. Twin is view-only; use map or typed XY.", true);
          twinHint.value = MpPlace.domainHint();
          return;
        }
        sc.value = url;
        await nextTick();
        const fr = twinFrame.value;
        if (!fr) { setTwinStatus("Twin iframe missing", true); return; }
        fr.src = "about:blank";
        await new Promise(r => setTimeout(r, 40));
        const loadP = MpPlace.waitIframeLoad(fr, 12000);
        fr.src = url;
        await loadP;
        const session = await MpPlace.connect({
          iframe: fr,
          applicationKey: key,
          onStatus: (m) => setTwinStatus(m, false)
        });
        if (!session.ok) {
          setTwinStatus("Could not connect Matterport SDK: " + (session.error || "unknown"), true);
          twinHint.value = session.hint || MpPlace.domainHint();
          twinOk.value = false;
          return;
        }
        twinSession = session;
        twinOk.value = true;
        twinHint.value = "";
        setTwinStatus("SDK connected. Aim at the elevator door, then Use pointer — or navigate to a nearby sweep and Use sweep. Applies to floor " + floor.value + ".", false);
      } catch (e) {
        setTwinStatus(e.message || String(e), true);
        twinHint.value = window.MpPlace ? MpPlace.domainHint() : "";
      } finally {
        twinBusy.value = false;
      }
    }
    function usePointerHit() {
      if (!sel.value) { toast("Select or add an elevator first"); return; }
      if (!twinSession || !twinSession.ok) { toast("Connect the twin SDK first"); return; }
      const xy = twinSession.pointerModelXY();
      if (!xy) { toast("No pointer hit yet — move the cursor over the door in the twin"); return; }
      applyDoorXY(xy.x, xy.y, "twin pointer");
    }
    function useCurrentSweep() {
      if (!sel.value) { toast("Select or add an elevator first"); return; }
      if (!twinSession || !twinSession.ok) { toast("Connect the twin SDK first"); return; }
      const xy = twinSession.sweepModelXY();
      if (!xy) { toast("Not at a sweep — enter Inside mode and stand near the door"); return; }
      applyDoorXY(xy.x, xy.y, "twin sweep");
    }
    function onJob() { toast("Graph job finished. Publish if the public map should update."); emit("reload"); }
    function syncMapPresentation() {
      if (!map || !isMapViewMode(viewMode.value)) return;
      applyMapViewMode(map, viewMode.value, { beforeLayerId: "units", mapStyle: mapStyle.value });
    }
    onMounted(async () => {
      await pullElevators();
      map = makeMap(el.value, props.b, basemapKindForMode(viewMode.value, mapStyle.value));
      await whenLoaded(map);
      indoorLayers(map);
      await loadIndoor(map, props.b.slug, floor.value);
      syncMapPresentation();
      drawMarkers();
      map.on("click", (ev) => {
        if (viewMode.value === "twin" || !placing.value || !sel.value) return;
        const A = affine();
        if (!A) { toast("No georeference. Type model x,y, use twin, or align the model first."); return; }
        const xy = Geo.model(A, ev.lngLat.lng, ev.lngLat.lat);
        applyDoorXY(xy[0], xy[1], "map");
        placing.value = false;
      });
      if (viewMode.value === "twin" && !sc.value && !twinBusy.value) openTwin();
    });
    onBeforeUnmount(() => {
      if (dirty.value) {
        try {
          const elev = WFElevators.serializeElevators(rows.value, props.b.floors, { strict: false });
          const pc = WFElevators.mergePipeline(props.b.pipeline_config, elev);
          api(`/admin/buildings/${props.b.slug}`, { method: "PATCH", json: { pipeline_config: pc } }).catch(() => {});
        } catch (e) { /* ignore */ }
      }
      teardownTwinSession();
      if (map) map.remove();
    });
    // Floor switch only remaps the plan/markers. Per-floor doors stay in sel.doors[fid].
    watch(floor, async () => { if (map) { await loadIndoor(map, props.b.slug, floor.value); drawMarkers(); } });
    watch(viewMode, async (m, prev) => {
      if (m === "twin") {
        placing.value = false;
        await nextTick();
        if (!sc.value && !twinBusy.value) openTwin();
      } else {
        await nextTick();
        syncMapPresentation();
        drawMarkers();
      }
    });
    watch(mapStyle, () => { if (viewMode.value === "2d" || viewMode.value === "3d") syncMapPresentation(); });
    watch(sel, (v) => {
      if (!v) {
        teardownTwinSession();
        twinStatus.value = "";
        twinHint.value = "";
        twinErr.value = false;
      }
    });
    return { el, twinFrame, rows, sel, floor, placing, viewMode, mapStyle, err, ok, jobId, sc, twinBusy, twinOk, twinErr, twinStatus, twinHint, hasGeo, mapHint, helpText, select, add, toggleFloor, doorField, setDoor, copyDoors, remove, placeOnFloor, save, rebuild, openTwin, closeTwin, usePointerHit, useCurrentSweep, onJob };
  }
};



// ---------------- Debug Dashboard (global toggle + log tail) ----------------
const Dashboard = {
  template: `<div>
    <div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">{{t("admin.dashboard") || "Dashboard"}}</h1>
      <span class="badge" :class="settings.debug && settings.debug.enabled ? 'ok' : ''">{{settings.debug && settings.debug.enabled ? "Debug ON" : "Debug OFF"}}</span></div>
    <div class="card">
      <h2 style="margin-top:0">Debug mode</h2>
      <p class="muted small" style="margin-top:0">Platform-wide verbose logging for platform viewer, mobile, Tour/mesh, localize, AR, and API. Clients poll live status (no re-publish required for the global toggle). Per-building override is on each building Overview; publish writes <code>config.debug</code> as a hint for static hosts.</p>
      <label class="tog"><input type="checkbox" :checked="!!(settings.debug && settings.debug.enabled)" @change="toggleGlobal($event.target.checked)"> <span><b>Enable debug mode (global)</b></span></label>
      <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <span class="ok" v-if="saved">{{saved}}</span>
        <span class="err" v-if="err">{{err}}</span>
      </div>
      <div v-if="settings.buildings && settings.buildings.length" style="margin-top:14px">
        <h3 style="margin:0 0 6px;font-size:14px">Per-building effective</h3>
        <table><tr><th>Building</th><th>Override</th><th>Effective</th></tr>
          <tr v-for="b in settings.buildings" :key="b.slug">
            <td><a :href="'#/b/'+b.slug+'/overview'">{{b.name}}</a> <span class="mono small">{{b.slug}}</span></td>
            <td>{{ovLabel(b.override)}}</td>
            <td><span class="badge" :class="b.effective?'ok':''">{{b.effective?'on':'off'}}</span></td>
          </tr>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <h2 class="grow" style="margin:0">Logs</h2>
        <label class="small" style="margin:0">Level
          <select v-model="filt.level" @change="reload(true)" style="width:auto">
            <option value="">all</option><option>debug</option><option>info</option><option>warn</option><option>error</option>
          </select></label>
        <label class="small" style="margin:0">Building
          <select v-model="filt.building" @change="reload(true)" style="width:auto">
            <option value="">all</option>
            <option v-for="b in (settings.buildings||[])" :key="b.slug" :value="b.slug">{{b.slug}}</option>
          </select></label>
        <label class="small row" style="margin:0;gap:4px"><input type="checkbox" v-model="auto"> Auto-refresh</label>
        <button class="sm" @click="reload(true)">Refresh</button>
        <button class="sm" @click="doExport">Export</button>
        <button class="sm danger" @click="doClear">Clear</button>
      </div>
      <p class="muted small">{{logs.length}} shown · buffer {{total}} · last id {{lastId}}</p>
      <div class="dbg-log" ref="box">
        <div v-for="e in logs" :key="e.id" class="dbg-line" :class="'lv-'+e.level">
          <span class="dbg-ts">{{fmt(e.ts)}}</span>
          <span class="dbg-lv">{{e.level}}</span>
          <span class="dbg-src">{{e.source}}</span>
          <span class="dbg-b">{{e.building||'—'}}</span>
          <span class="dbg-msg">{{e.message}}</span>
        </div>
        <div v-if="!logs.length" class="muted small" style="padding:12px">No logs yet. Enable debug, open the viewer / Tour / localize, then refresh.</div>
      </div>
    </div>
  </div>`,
  setup() {
    const settings = reactive({ debug: { enabled: false }, buildings: [] });
    const logs = ref([]);
    const lastId = ref(0);
    const total = ref(0);
    const filt = reactive({ level: "", building: "" });
    const auto = ref(true);
    const saved = ref(""), err = ref("");
    const box = ref(null);
    let poll = null;

    function ovLabel(ov) {
      if (window.WFDebugConfig) return WFDebugConfig.overrideLabel(ov);
      if (ov === true) return "On";
      if (ov === false) return "Off";
      return "Inherit";
    }
    function fmt(ts) {
      try { return new Date(Number(ts) * 1000).toLocaleString(); } catch (e) { return String(ts); }
    }
    async function loadSettings() {
      try {
        const j = await api("/admin/debug/settings");
        Object.assign(settings, j);
      } catch (e) { err.value = e.message; }
    }
    async function reload(reset) {
      try {
        const q = new URLSearchParams();
        if (!reset && lastId.value) q.set("after_id", String(lastId.value));
        q.set("limit", reset ? "300" : "100");
        if (filt.level) q.set("level", filt.level);
        if (filt.building) q.set("building", filt.building);
        const j = await api("/admin/debug/logs?" + q.toString());
        total.value = j.total_buffered || 0;
        if (reset) {
          logs.value = j.logs || [];
        } else if (j.logs && j.logs.length) {
          logs.value = logs.value.concat(j.logs).slice(-500);
        }
        if (j.last_id) lastId.value = j.last_id;
        await nextTick();
        if (box.value) box.value.scrollTop = box.value.scrollHeight;
      } catch (e) { /* ignore transient */ }
    }
    async function toggleGlobal(on) {
      err.value = ""; saved.value = "";
      try {
        const j = await api("/admin/debug/settings", { method: "PATCH", json: { enabled: !!on } });
        if (j.debug) settings.debug = j.debug;
        saved.value = on ? "Debug enabled — clients will start shipping logs within ~12s" : "Debug disabled";
        await loadSettings();
        setTimeout(() => { saved.value = ""; }, 3000);
      } catch (e) { err.value = e.message; }
    }
    async function doClear() {
      if (!confirm("Clear all debug logs?")) return;
      await api("/admin/debug/logs", { method: "DELETE" });
      logs.value = []; lastId.value = 0; await reload(true); toast("Logs cleared");
    }
    function doExport() {
      const q = new URLSearchParams();
      if (filt.level) q.set("level", filt.level);
      if (filt.building) q.set("building", filt.building);
      const a = document.createElement("a");
      a.href = API + "/admin/debug/logs/export?" + q.toString();
      a.download = "wayfinding-debug-logs.txt";
      // need auth header — fetch blob instead
      api("/admin/debug/logs/export?" + q.toString()).then(() => {}).catch(() => {});
      fetch(API + "/admin/debug/logs/export?" + q.toString(), {
        headers: { Authorization: "Bearer " + store.token }
      }).then(r => r.text()).then(text => {
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        a.href = url; a.click(); URL.revokeObjectURL(url);
      });
    }
    onMounted(async () => {
      await loadSettings();
      await reload(true);
      poll = setInterval(() => { if (auto.value) reload(false); }, 2000);
    });
    onBeforeUnmount(() => { if (poll) clearInterval(poll); });
    return { settings, logs, lastId, total, filt, auto, saved, err, box, ovLabel, fmt, reload, toggleGlobal, doClear, doExport, t };
  }
};


// ---------------- Platform Config (Option 2: LLM + safe runtime) ----------------
const ConfigPage = {
  template: `<div>
    <div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">{{t("admin.config") || "Config"}}</h1>
      <button class="sm" @click="load" :disabled="busy">Refresh</button>
      <button class="primary sm" @click="save" :disabled="busy">Save</button></div>
    <p class="muted small" style="margin-top:0">JWT admin only. Non-secrets save to <code>var/runtime_settings.json</code> (live overlay). Secrets are write-only to <code>var/runtime_secrets.env</code> (0600) — values are never shown. Prefer <code>.env</code> for long-lived secrets in production. CORS / JWT / DB usually need <code>scripts/dev_server.sh restart</code>.</p>
    <div class="card">
      <h2 style="margin-top:0">Status</h2>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="badge" :class="st.chat_enabled ? 'ok' : ''">{{badges.chat}}</span>
        <span class="badge" :class="st.llm_probe && st.llm_probe.reachable ? (st.llm_probe.ok ? 'ok' : 'run') : 'bad'">{{badges.llm}}</span>
        <span class="badge" :class="st.vps_configured ? 'ok' : ''">{{badges.vps}}</span>
        <span class="badge" :class="st.matterport_key_present ? 'ok' : 'bad'">{{badges.mp}}</span>
      </div>
      <div class="kv"><div>Public URL</div><div class="mono">{{badges.pub}}</div>
        <div>Geocoder</div><div>{{st.geocoder || values.geocoder}}</div>
        <div>Max upload</div><div>{{st.max_upload_mb || values.max_upload_mb}} MB</div>
        <div>Overlay keys</div><div class="mono small">{{(overlayKeys||[]).join(', ') || '— (env only)'}}</div></div>
      <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <button class="sm" @click="probe" :disabled="busy">Probe LLM</button>
        <span class="muted small" v-if="probeMsg">{{probeMsg}}</span>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Chat / LLM (non-secrets)</h2>
      <label class="tog"><input type="checkbox" v-model="values.wf_chat_enabled"> <span><b>WF_CHAT_ENABLED</b> — public + admin chat</span></label>
      <label>WF_CHAT_LLM_BASE_URL <span class="muted small">(OpenAI-compatible; Ollama e.g. http://127.0.0.1:11434/v1)</span>
        <input v-model="values.wf_chat_llm_base_url" placeholder="http://127.0.0.1:11434/v1" autocomplete="off"></label>
      <div class="row" style="gap:12px;flex-wrap:wrap">
        <label class="grow">WF_CHAT_LLM_MODEL<input v-model="values.wf_chat_llm_model" placeholder="qwen2.5:3b" autocomplete="off"></label>
        <label style="max-width:160px">Rate / min<input type="number" min="1" max="1000" v-model.number="values.wf_chat_rate_limit_per_min"></label>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Platform (non-secrets)</h2>
      <div class="row" style="gap:12px;flex-wrap:wrap">
        <label style="max-width:180px">GEOCODER
          <select v-model="values.geocoder"><option value="esri">esri</option><option value="nominatim">nominatim</option></select></label>
        <label style="max-width:180px">MAX_UPLOAD_MB<input type="number" min="1" max="102400" v-model.number="values.max_upload_mb"></label>
      </div>
      <label>PUBLIC_BASE_URL<input v-model="values.public_base_url" placeholder="https://app.navme.space" autocomplete="off"></label>
      <label>CORS_ORIGINS <span class="muted small">(comma-separated origins, or *)</span>
        <input v-model="values.cors_origins" placeholder="https://app.navme.space,https://studio.navme.space" autocomplete="off"></label>
      <label>VPS_URL <span class="muted small">(ProjectX base; SSRF-aware — private hosts warn; metadata blocked)</span>
        <input v-model="values.vps_url" placeholder="http://127.0.0.1:8770" autocomplete="off"></label>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Secrets (configured yes/no only)</h2>
      <p class="muted small" style="margin-top:0">Values are never loaded from the server. Optional set/clear writes <code>var/runtime_secrets.env</code> only — prefer production secrets in host env / Render dashboard.</p>
      <table><tr><th>Secret</th><th>Configured</th><th>Set (write-only)</th><th></th></tr>
        <tr v-for="k in secretKeys" :key="k">
          <td><b>{{secretLabels[k] || k}}</b><div class="mono small">{{k}}</div></td>
          <td><span class="badge" :class="secrets[k] ? 'ok' : 'bad'">{{secrets[k] ? 'yes' : 'no'}}</span></td>
          <td><input type="password" v-model="secretDrafts[k].value" :placeholder="secrets[k] ? '•••• (leave blank to keep)' : 'paste to set'" autocomplete="new-password" style="min-width:220px"></td>
          <td><label class="tog" style="margin:0"><input type="checkbox" v-model="secretDrafts[k].clear"> <span class="small">Clear</span></label></td>
        </tr>
      </table>
    </div>
    <div class="card" v-if="notes.length || warnings.length || restartNote">
      <h2 style="margin-top:0">Notes</h2>
      <ul class="small" style="margin:0;padding-left:18px">
        <li v-for="(n,i) in notes" :key="'n'+i">{{n}}</li>
        <li v-for="(w,i) in warnings" :key="'w'+i" class="err">{{w}}</li>
      </ul>
      <p class="err" v-if="restartNote" style="margin-bottom:0">{{restartNote}}</p>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <span class="ok" v-if="saved">{{saved}}</span>
      <span class="err" v-if="err">{{err}}</span>
    </div>
  </div>`,
  setup() {
    const values = reactive((window.WFRuntimeConfig && WFRuntimeConfig.blankValues()) || {});
    const secrets = reactive({});
    const secretKeys = (window.WFRuntimeConfig && WFRuntimeConfig.SECRET_KEYS) || [];
    const secretLabels = (window.WFRuntimeConfig && WFRuntimeConfig.SECRET_LABELS) || {};
    const secretDrafts = reactive({});
    secretKeys.forEach(k => { secretDrafts[k] = { value: "", clear: false }; secrets[k] = false; });
    const st = reactive({});
    const overlayKeys = ref([]);
    const notes = ref([]);
    const warnings = ref([]);
    const restartNote = ref("");
    const busy = ref(false), saved = ref(""), err = ref(""), probeMsg = ref("");
    const badges = computed(() => (window.WFRuntimeConfig ? WFRuntimeConfig.statusBadge(st) : {}));

    function applyPayload(j) {
      const p = window.WFRuntimeConfig ? WFRuntimeConfig.parsePayload(j) : j;
      Object.assign(values, p.values || {});
      Object.keys(secrets).forEach(k => { secrets[k] = !!(p.secrets && p.secrets[k]); });
      Object.assign(st, p.status || {});
      overlayKeys.value = p.overlay_keys || [];
      notes.value = p.notes || [];
      warnings.value = p.warnings || [];
      restartNote.value = p.restart_note || "";
      secretKeys.forEach(k => { secretDrafts[k].value = ""; secretDrafts[k].clear = false; });
    }
    async function load() {
      busy.value = true; err.value = ""; saved.value = "";
      try {
        const j = await api("/admin/platform/config");
        applyPayload(j);
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function save() {
      busy.value = true; err.value = ""; saved.value = ""; warnings.value = [];
      try {
        const body = window.WFRuntimeConfig
          ? WFRuntimeConfig.buildPatch({ values }, secretDrafts)
          : { values: { ...values } };
        const j = await api("/admin/platform/config", { method: "PATCH", json: body });
        applyPayload(j);
        saved.value = (j.restart_hints && j.restart_hints.length)
          ? "Saved — restart recommended: scripts/dev_server.sh restart"
          : "Saved (overlay applied; chat settings live)";
        toast(saved.value);
        setTimeout(() => { saved.value = ""; }, 5000);
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    async function probe() {
      busy.value = true; probeMsg.value = ""; err.value = "";
      try {
        const j = await api("/admin/platform/config/probe-llm", {
          method: "POST",
          json: { wf_chat_llm_base_url: values.wf_chat_llm_base_url }
        });
        const p = j.probe || {};
        Object.assign(st, { llm_probe: p });
        probeMsg.value = p.reachable
          ? (p.ok ? "Reachable (HTTP " + p.status + ")" : "Host reachable but HTTP " + p.status)
          : ("Unreachable: " + (p.error || "error"));
      } catch (e) { err.value = e.message; }
      busy.value = false;
    }
    onMounted(load);
    return {
      values, secrets, secretKeys, secretLabels, secretDrafts, st, overlayKeys, notes, warnings,
      restartNote, busy, saved, err, probeMsg, badges, load, save, probe, t, i18nTick
    };
  }
};


// ---------------- root ----------------
const App = {
  template: `<div><header class="top" v-if="store.token"><span class="brand"><img class="navme-logo sm" src="img/navme-logo.png" alt=""><span>{{t("admin.brand")}}</span></span><a href="#/">{{t("admin.buildings")}}</a><a href="#/dashboard">{{t("admin.dashboard") || "Dashboard"}}</a><a href="#/new">{{t("admin.addBuildingTitle")}}</a><a href="#/scan-plan">{{t("admin.scanPlanning")}}</a><a href="#/config">{{t("admin.config") || "Config"}}</a><a href="/api/docs" target="_blank">{{t("admin.apiDocs")}}</a>
      <span class="sp"></span>
      <select class="wf-lang-switch" v-if="langOptions.length" :value="currentLang" @change="onLang($event.target.value)" :aria-label="t('admin.language')">
        <option v-for="o in langOptions" :key="o.code" :value="o.code">{{o.native}}</option>
      </select>
      <span class="muted small">{{store.me && store.me.email}}</span><button class="sm" @click="logout">{{t("admin.signOut")}}</button></header>
    <main><component :is="view.c" v-bind="view.p" :key="viewKey"></component></main>
    <div v-if="store.toast" style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:10px 16px;border-radius:8px;z-index:50">{{store.toast}}</div></div>`,
  setup() {
    const currentLang = ref((window.WFi18n && WFi18n.getLocale && WFi18n.getLocale()) || "en");
    // Admin always offers the full first-cut catalog (not filtered by building enabled_languages).
    const langOptions = computed(() => { i18nTick.value; return I18N_CATALOG; });
    async function onLang(code) { if (window.WFi18n) { await WFi18n.setLocale(code); currentLang.value = code; i18nTick.value++; } }
    const view = computed(() => {
      const r = store.route;
      if (!store.token || r === "/login") return { c: "login", p: {} };
      let m;
      if (r === "/new" || r.startsWith("/new?")) return { c: "wizard", p: {} };
      if (r === "/dashboard" || r === "/debug") return { c: "dashboard", p: {} };
      if (r === "/config" || r === "/settings") return { c: "config-page", p: {} };
      if (r === "/scan-plan" || r === "/scan-plans") return { c: "scan-plans", p: {} };
      if ((m = r.match(/^\/scan-plan\/([^/]+)/))) return { c: "scan-plan", p: { id: m[1] } };
      if ((m = r.match(/^\/b\/([^/]+)(?:\/([a-z]+))?/))) return { c: "building", p: { slug: m[1], tab: m[2] || "overview" } };
      return { c: "buildings", p: {} };
    });
    onMounted(async () => {
      await bootI18n(loadEnabledLocal());
      i18nTick.value++;
      currentLang.value = (window.WFi18n && WFi18n.getLocale()) || "en";
      if (window.WFi18n) WFi18n.onChange((c) => { currentLang.value = c; i18nTick.value++; });
      if (store.token) try { store.me = await api("/auth/me"); } catch (e) { }
    });
    watch(() => store.token, async (tok) => { if (tok) try { store.me = await api("/auth/me"); } catch (e) { } });
    function logout() { store.token = ""; localStorage.removeItem("wf_admin_token"); go("/login"); }
    const viewKey = computed(() => {
      const v = view.value;
      // Keep Building mounted across Overview/Elevators/… tabs so reload state and drafts survive.
      if (v.c === "building") return "building:" + v.p.slug + ":" + i18nTick.value;
      return store.route + ":" + i18nTick.value;
    });
    return { store, view, viewKey, logout, t, i18nTick, currentLang, langOptions, onLang };
  }
};
const app = createApp(App);
Object.entries({ login: Login, buildings: Buildings, dashboard: Dashboard, "config-page": ConfigPage, wizard: Wizard, building: Building, overview: Overview, georef: Georef, floors: Floors, elevators: Elevators, "media-panels": MediaPanels, "tour-modes": TourModes, "access-settings": AccessSettings, pois: Pois, routes: Routes, publish: Publish, jobs: Jobs, "job-log": JobLog, "scan-plans": ScanPlans, "scan-plan": ScanPlan, "view-mode-bar": ViewModeBar, "map-style-bar": MapStyleBar })
  .forEach(([k, v]) => app.component(k, v));
app.mount("#app");
if (window.WFAdminChat && typeof WFAdminChat.syncVisibility === "function") {
  try { WFAdminChat.syncVisibility(); } catch (e) {}
  watch(() => store.token, () => { try { WFAdminChat.syncVisibility(); } catch (e) {} });
}
