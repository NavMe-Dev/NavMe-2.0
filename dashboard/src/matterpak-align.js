/**
 * Drag a MatterPak mesh onto a real map and save where it belongs.
 *
 * The mesh renders as a true 3D overlay inside MapLibre's own WebGL context via
 * a custom layer, so it stays locked to the ground as the map is panned, zoomed,
 * rotated and pitched — it is not a flat image pasted on top.
 *
 * Basemaps are all key-free: Esri World Imagery for satellite (the one that
 * actually matters for lining a building up), OSM and Carto for reference.
 *
 * Coordinate note: MapLibre's Mercator space is X-east, Y-south, Z-up, and the
 * MatterPak OBJ is already Z-up — so unlike the three.js sampler there is no
 * -90 deg X rotation here. The only axis fix needed is negating Y to turn
 * north-positive model coordinates into south-positive Mercator ones.
 */
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  loadAlignment,
  saveAlignment,
  mPerDegLat,
  mPerDegLon,
} from './matterpak-align-store.js';

const el = (id) => document.getElementById(id);
const setStatus = (m, k = '') => {
  el('status').textContent = m;
  el('status').className = k;
};

const ATTRIB_ESRI =
  'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';

const BASEMAPS = {
  sat: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: ATTRIB_ESRI,
    maxzoom: 21,
  },
  street: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxzoom: 19,
  },
  light: {
    tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
    attribution: '&copy; OpenStreetMap, &copy; <a href="https://carto.com/">CARTO</a>',
    maxzoom: 20,
  },
};

const styleFor = (k) => ({
  version: 8,
  sources: { base: { type: 'raster', tileSize: 256, ...BASEMAPS[k] } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});

/** Live transform being edited. */
const T = { lat: 0, lon: 0, heading: 0, altitude: 0, scale: 1 };
let modelId = null;
let meshRoot = null;
let meshMat = null;
let basemap = 'sat';

// ── map ──────────────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: styleFor(basemap),
  center: [77.7068372, 13.0251714],
  zoom: 17.5,
  pitch: 50,
  bearing: 0,
  antialias: true,
  maxPitch: 80,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
// Shows the device fix and its accuracy circle, which doubles as a sanity check
// that the mesh has been dropped in the right place.
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showAccuracyCircle: true,
  }),
  'bottom-right',
);

/** Draggable anchor = the model's OBJ origin on the ground. */
const pinEl = document.createElement('div');
pinEl.className = 'anchor-pin';
pinEl.title = 'Model origin — drag to reposition';
const anchor = new maplibregl.Marker({ element: pinEl, draggable: true, anchor: 'center' });

anchor.on('drag', () => {
  const p = anchor.getLngLat();
  T.lat = p.lat;
  T.lon = p.lng;
  map.triggerRepaint();
  paintTransform();
});
anchor.on('dragend', () => setStatus('Moved — press Save alignment to keep it.'));

// ── three.js custom layer ────────────────────────────────────────────────────
const overlay = {
  id: 'matterpak',
  type: 'custom',
  renderingMode: '3d',

  onAdd(m, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.4, -0.6, 1).normalize();
    this.scene.add(key);
    this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  },

  render(gl, args) {
    if (!meshRoot) return;
    // MapLibre 4 passes the matrix directly; 5 passes an options object.
    const raw = Array.isArray(args) || ArrayBuffer.isView(args)
      ? args
      : args?.defaultProjectionData?.mainMatrix;
    if (!raw) return;

    const a = maplibregl.MercatorCoordinate.fromLngLat([T.lon, T.lat], T.altitude);
    const u = a.meterInMercatorCoordinateUnits() * T.scale;

    // Rz(-heading) turns model +Y to the requested bearing; the negative Y
    // scale converts north-positive model space to south-positive Mercator.
    const local = new THREE.Matrix4()
      .makeTranslation(a.x, a.y, a.z)
      .scale(new THREE.Vector3(u, -u, u))
      .multiply(new THREE.Matrix4().makeRotationZ((-T.heading * Math.PI) / 180));

    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(Array.from(raw)).multiply(local);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    map.triggerRepaint();
  },
};

map.on('load', () => {
  map.addLayer(overlay);
  init();
});

/** Re-add the overlay after a style swap, which drops custom layers. */
function setBasemap(k) {
  basemap = k;
  map.setStyle(styleFor(k));
  map.once('styledata', () => {
    if (!map.getLayer('matterpak')) map.addLayer(overlay);
  });
  document.querySelectorAll('#base button').forEach((b) =>
    b.classList.toggle('active', b.dataset.b === k),
  );
}

// ── geometry ─────────────────────────────────────────────────────────────────
async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    setStatus(
      `Streaming ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}…`,
    );
  }
  return new Blob(chunks).text();
}

function disposeMesh() {
  if (!meshRoot) return;
  overlay.scene?.remove(meshRoot);
  meshRoot.traverse((c) => c.geometry?.dispose?.());
  meshMat?.dispose();
  meshRoot = null;
  meshMat = null;
}

async function loadMesh(m) {
  if (!m.downloadUrl) {
    setStatus(`${m.resolution} is ${m.status}.`, 'err');
    return;
  }
  document.querySelectorAll('#pick button').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === m.id),
  );
  setStatus('Requesting geometry…');
  try {
    const text = await fetchWithProgress(m.downloadUrl);
    setStatus('Parsing OBJ…');
    const obj = new OBJLoader().parse(text);
    meshMat = new THREE.MeshStandardMaterial({
      color: 0x8ab4ff,
      roughness: 0.75,
      metalness: 0.05,
      transparent: true,
      opacity: Number(el('opacity').value),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    obj.traverse((c) => {
      if (c.isMesh) {
        c.material = meshMat;
        c.geometry.computeVertexNormals();
      }
    });
    disposeMesh();
    meshRoot = obj;
    overlay.scene?.add(obj);
    map.triggerRepaint();
    setStatus(`${m.filename} overlaid — drag the amber pin to place it.`, 'ok');
  } catch (err) {
    setStatus(`Load failed: ${err.message}`, 'err');
  }
}

// ── transform plumbing ───────────────────────────────────────────────────────
function paintTransform() {
  el('a-lat').textContent = T.lat.toFixed(7);
  el('a-lon').textContent = T.lon.toFixed(7);
  el('a-head').textContent = `${T.heading.toFixed(1)}°`;
  el('a-alt').textContent = `${T.altitude.toFixed(2)} m`;
  el('a-scale').textContent = T.scale.toFixed(4);
  el('json').value = JSON.stringify({ modelId, ...T }, null, 2);
}

function applyControls() {
  T.heading = Number(el('heading').value);
  T.altitude = Number(el('alt').value) || 0;
  T.scale = Number(el('scale').value) || 1;
  el('h-val').textContent = `${T.heading.toFixed(1)}°`;
  map.triggerRepaint();
  paintTransform();
}

/** Shift model position by metres, for keyboard nudging. */
function nudge(deast, dnorth) {
  T.lat += dnorth / mPerDegLat(T.lat);
  T.lon += deast / mPerDegLon(T.lat);
  anchor.setLngLat([T.lon, T.lat]);
  map.triggerRepaint();
  paintTransform();
}

async function selectModel(id, models) {
  modelId = id;
  disposeMesh();
  el('pick').innerHTML = '';
  setStatus('Fetching signed links…');

  let data;
  try {
    const res = await fetch(`/api/matterport/meshes?modelId=${encodeURIComponent(id)}`);
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    setStatus(`Matterport API: ${err.message}`, 'err');
    return;
  }

  const meta = models.find((m) => m.id === id);
  el('addr').textContent = data.address || meta?.address || ' ';

  // Saved alignment wins; otherwise start from Matterport's own anchor.
  const saved = loadAlignment(id);
  if (saved) {
    Object.assign(T, {
      lat: saved.lat,
      lon: saved.lon,
      heading: saved.heading,
      altitude: saved.altitude,
      scale: saved.scale,
    });
    el('warn').textContent = `Loaded a saved alignment from ${new Date(saved.savedAt).toLocaleString()}.`;
  } else if (data.lat != null) {
    Object.assign(T, { lat: data.lat, lon: data.lon, heading: 0, altitude: 0, scale: 1 });
    el('warn').textContent =
      'No saved alignment yet — starting from Matterport’s geolocation anchor, which has no bearing. Rotate until the mesh matches the imagery, then Save.';
  } else {
    Object.assign(T, { lat: map.getCenter().lat, lon: map.getCenter().lng });
    el('warn').textContent = 'This model has no geolocation — drop the pin manually.';
  }

  el('heading').value = T.heading;
  el('alt').value = T.altitude;
  el('scale').value = T.scale;
  el('h-val').textContent = `${T.heading.toFixed(1)}°`;

  anchor.setLngLat([T.lon, T.lat]).addTo(map);
  map.flyTo({ center: [T.lon, T.lat], zoom: 17.8, duration: 900 });
  paintTransform();

  const usable = data.meshes.filter((m) => m.downloadUrl);
  for (const m of data.meshes) {
    const b = document.createElement('button');
    b.dataset.id = m.id;
    b.textContent = m.filename ? m.filename.replace(/\.obj$/, '') : m.resolution;
    b.disabled = !m.downloadUrl;
    b.addEventListener('click', () => loadMesh(m));
    el('pick').appendChild(b);
  }
  if (!usable.length) {
    setStatus('No unlocked geometry on this model.', 'err');
    return;
  }
  await loadMesh(usable[0]);
}

async function init() {
  let models = [];
  try {
    const res = await fetch('/api/matterport/matterpak-models');
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    models = d.models;
  } catch (err) {
    setStatus(`Could not list models: ${err.message}`, 'err');
    return;
  }

  const sel = el('model');
  sel.innerHTML = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.name} — ${m.id}`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => selectModel(sel.value, models));

  const gcu = models.find((m) => m.id === 'jdjvM17BPEh');
  sel.value = gcu ? gcu.id : models[0]?.id;
  if (sel.value) await selectModel(sel.value, models);
}

// ── controls ─────────────────────────────────────────────────────────────────
el('heading').addEventListener('input', applyControls);
el('alt').addEventListener('input', applyControls);
el('scale').addEventListener('input', applyControls);
el('opacity').addEventListener('input', (e) => {
  el('o-val').textContent = Number(e.target.value).toFixed(2);
  if (meshMat) meshMat.opacity = Number(e.target.value);
  map.triggerRepaint();
});
document.querySelectorAll('#base button').forEach((b) =>
  b.addEventListener('click', () => setBasemap(b.dataset.b)),
);

el('save').addEventListener('click', () => {
  if (!modelId) return;
  const a = saveAlignment(modelId, T);
  el('warn').textContent = `Saved ${new Date(a.savedAt).toLocaleString()}. The sampler will now use this.`;
  paintTransform();
  setStatus('Alignment saved.', 'ok');
});

el('reset').addEventListener('click', () => {
  el('heading').value = 0;
  el('alt').value = 0;
  el('scale').value = 1;
  applyControls();
  setStatus('Rotation, altitude and scale reset — position unchanged.');
});

el('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(el('json').value).then(
    () => setStatus('Transform JSON copied.', 'ok'),
    () => setStatus('Clipboard blocked by the browser.', 'err'),
  );
});

el('open').addEventListener('click', () => {
  window.open(`/matterpak.html?m=${encodeURIComponent(modelId || '')}`, '_blank');
});

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const step = e.shiftKey ? 10 : 1;
  const moves = {
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
  };
  const m = moves[e.key];
  if (!m) return;
  e.preventDefault();
  nudge(m[0], m[1]);
  setStatus(`Nudged ${step} m — press Save alignment to keep it.`);
});
