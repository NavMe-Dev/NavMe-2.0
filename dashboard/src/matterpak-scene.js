/**
 * MatterPak scene — Matterport geometry pulled live from the Model API and
 * pinned to WGS84, with no download-and-re-upload step.
 *
 * Coordinate spaces in play (three of them, which is the whole reason this file
 * is fiddly):
 *
 *   OBJ / MatterPak   Z-up, right-handed. Measured on jdjvM17BPEh: X/Y span the
 *                     194 x 152 m footprint, Z spans 28.6 m of building height.
 *   Showcase SDK      Y-up. This is the space your POI pos_x/y/z live in.
 *   three.js          Y-up, so the loaded OBJ gets rotation.x = -90 deg.
 *
 * Z-up -> Y-up is (x, y, z) -> (x, z, -y), which is exactly what that rotation
 * does. Readouts report OBJ and Showcase separately so numbers can be matched
 * against either system without mental arithmetic.
 *
 * Georeferencing: Matterport's `geocoordinates` field carries a true-north
 * rotation quaternion, but it is disabled by org policy on this account, so all
 * we get is `geolocation` — a single lat/long anchor with no bearing and a null
 * altitude. Heading is therefore a manual control, and altitude is relative to
 * a ground elevation the user supplies. Both are clearly labelled as estimates.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  loadAlignment,
  objToWgs84 as objToWgs84Shared,
  wgs84ToObj,
} from './matterpak-align-store.js';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const barEl = el('bar');

const setStatus = (msg, kind = '') => {
  statusEl.textContent = msg;
  statusEl.className = kind;
};
const fmtBytes = (n) =>
  !Number.isFinite(n) || n <= 0
    ? '—'
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MB`
      : `${(n / 1024).toFixed(0)} KB`;

/** Model state for the active selection. */
let geo = { lat: null, lon: null, altitude: null };
let heading = 0;
let baseAlt = 0;
let currentMesh = null;

// ── WGS84 ────────────────────────────────────────────────────────────────────
// The transform lives in matterpak-align-store.js so the map alignment tool and
// this sampler can never drift apart.

/** Current model id, used to look up a saved alignment. */
let activeModelId = null;

/**
 * @param {number} x OBJ X
 * @param {number} y OBJ Y
 * @param {number} z OBJ Z (height)
 */
function objToWgs84(x, y, z) {
  if (geo.lat == null || geo.lon == null) return null;
  return objToWgs84Shared(
    { x, y, z },
    { lat: geo.lat, lon: geo.lon, heading, altitude: baseAlt, scale: 1 },
  );
}

// ── scene ────────────────────────────────────────────────────────────────────
const host = el('view');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
host.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a2030, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(30, 60, 20);
scene.add(key);

const grid = new THREE.GridHelper(400, 80, 0x3b4a63, 0x1e293b);
scene.add(grid);

/**
 * The model is parented to this so the OBJ keeps its own untouched coordinates:
 * every readout reads straight off the raw geometry rather than off a
 * transformed copy.
 */
const modelRoot = new THREE.Group();
modelRoot.rotation.x = -Math.PI / 2; // Z-up (Matterport) -> Y-up (three.js)
scene.add(modelRoot);

// ── origin marker ────────────────────────────────────────────────────────────
// Sits at OBJ (0,0,0) — the model origin Matterport exports around, and the
// point the lat/long anchor is tied to.
const originGroup = new THREE.Group();
scene.add(originGroup);

function makeAxisLabel(text, colour) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 44px IBM Plex Mono, monospace';
  g.fillStyle = colour;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 32);
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }),
  );
  s.scale.set(3, 3, 1);
  return s;
}

function buildOrigin(size) {
  originGroup.clear();
  // Axes drawn in three.js space but labelled with OBJ axis names, so the
  // colours match what the readout panel calls X / Y / Z.
  const defs = [
    { dir: new THREE.Vector3(1, 0, 0), col: 0xf87171, name: 'X' },
    { dir: new THREE.Vector3(0, 0, -1), col: 0x4ade80, name: 'Y' },
    { dir: new THREE.Vector3(0, 1, 0), col: 0x60a5fa, name: 'Z' },
  ];
  for (const d of defs) {
    originGroup.add(new THREE.ArrowHelper(d.dir, new THREE.Vector3(), size, d.col, size * 0.12, size * 0.06));
    const lbl = makeAxisLabel(d.name, `#${d.col.toString(16).padStart(6, '0')}`);
    lbl.position.copy(d.dir).multiplyScalar(size * 1.1);
    lbl.scale.setScalar(size * 0.12);
    originGroup.add(lbl);
  }
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.035, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24 }),
  );
  originGroup.add(ball);
}

// ── click marker ─────────────────────────────────────────────────────────────
const marker = new THREE.Group();
marker.visible = false;
scene.add(marker);
const dot = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 20),
  new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false }),
);
marker.add(dot);
const stem = new THREE.Mesh(
  new THREE.CylinderGeometry(0.12, 0.12, 1, 8),
  new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.6, depthTest: false }),
);
marker.add(stem);

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let lastReadout = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!currentMesh) return;
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(currentMesh, true)[0];
  if (!hit) return;

  // Back into the model's own (Z-up) frame — never read numbers off world space.
  const local = modelRoot.worldToLocal(hit.point.clone());
  showPoint(local, hit.point);
});

/**
 * @param {THREE.Vector3} obj OBJ-space (Z-up) hit point
 * @param {THREE.Vector3} world three.js world position for the marker
 */
function showPoint(obj, world) {
  const size = Math.max(sceneScale * 0.012, 0.15);
  dot.scale.setScalar(size);
  stem.scale.set(size, sceneScale * 0.1, size);
  stem.position.y = sceneScale * 0.05;
  marker.position.copy(world);
  marker.visible = true;

  const f = (n) => n.toFixed(3);
  el('o-x').textContent = f(obj.x);
  el('o-y').textContent = f(obj.y);
  el('o-z').textContent = f(obj.z);

  // Showcase SDK is Y-up: (x, y, z)_obj -> (x, z, -y)
  el('s-x').textContent = f(obj.x);
  el('s-y').textContent = f(obj.z);
  el('s-z').textContent = f(-obj.y);

  const g = objToWgs84(obj.x, obj.y, obj.z);
  if (g) {
    el('p-lat').textContent = g.lat.toFixed(7);
    el('p-lon').textContent = g.lon.toFixed(7);
    el('p-alt').textContent = `${g.alt.toFixed(2)} m`;
    el('p-en').textContent = `${g.east.toFixed(1)} / ${g.north.toFixed(1)} m`;
    el('gmap').href = `https://www.google.com/maps/search/?api=1&query=${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
  } else {
    for (const id of ['p-lat', 'p-lon', 'p-alt', 'p-en']) el(id).textContent = 'no geo anchor';
  }
  el('right').classList.remove('idle');
  lastReadout = { obj: obj.clone(), geo: g };
}

// ── "Find me" ────────────────────────────────────────────────────────────────
// Inverse of the click sampler: device GPS -> WGS84 -> model OBJ coordinates,
// drawn in the scene. The accuracy disc is not decoration — a phone indoors is
// routinely tens of metres out, which on a 194 x 152 m building can span most of
// the footprint, so the uncertainty has to be as visible as the position.

const meGroup = new THREE.Group();
meGroup.visible = false;
scene.add(meGroup);

const meDot = new THREE.Mesh(
  new THREE.SphereGeometry(1, 22, 22),
  new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false }),
);
meGroup.add(meDot);

const meBeam = new THREE.Mesh(
  new THREE.CylinderGeometry(0.1, 0.1, 1, 10),
  new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.55, depthTest: false }),
);
meGroup.add(meBeam);

/** Horizontal disc showing the GPS accuracy radius. */
const meAccuracy = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48),
  new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
meAccuracy.rotation.x = -Math.PI / 2;
meGroup.add(meAccuracy);

/**
 * Place the "you are here" marker from an OBJ-space position.
 * @param {{ x: number, y: number, z: number }} p OBJ (Z-up)
 * @param {number} accuracyM horizontal accuracy radius in metres
 */
function placeMe(p, accuracyM) {
  // OBJ (Z-up) -> three.js world (Y-up), matching modelRoot's -90 deg X rotation.
  const world = new THREE.Vector3(p.x, p.z, -p.y);
  meGroup.position.copy(world);

  const r = Math.max(sceneScale * 0.02, 0.4);
  meDot.scale.setScalar(r);
  meBeam.scale.set(r * 0.5, sceneScale * 0.22, r * 0.5);
  meBeam.position.y = sceneScale * 0.11;
  meAccuracy.scale.setScalar(Math.max(accuracyM, 0.5));
  meAccuracy.position.y = -p.z + 0.05; // sit the disc on the model's ground plane
  meGroup.visible = true;
}

function findMe() {
  const warn = el('me-warn');
  const out = el('me-out');
  if (!navigator.geolocation) {
    out.classList.remove('hidden');
    warn.textContent = 'This browser exposes no Geolocation API.';
    return;
  }
  if (geo.lat == null || geo.lon == null) {
    out.classList.remove('hidden');
    warn.textContent = 'This model has no geo anchor, so GPS cannot be mapped into it.';
    return;
  }

  const btn = el('findme');
  btn.disabled = true;
  btn.textContent = 'Locating…';
  warn.textContent = '';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      btn.textContent = 'Find me';
      out.classList.remove('hidden');

      const { latitude, longitude, accuracy, altitude } = pos.coords;
      el('me-lat').textContent = latitude.toFixed(7);
      el('me-lon').textContent = longitude.toFixed(7);
      el('me-acc').textContent = `±${Math.round(accuracy)} m`;

      const align = {
        lat: geo.lat,
        lon: geo.lon,
        heading,
        altitude: baseAlt,
        scale: 1,
      };
      const p = wgs84ToObj(
        { lat: latitude, lon: longitude, alt: altitude ?? baseAlt },
        align,
      );
      el('me-x').textContent = p.x.toFixed(3);
      el('me-y').textContent = p.y.toFixed(3);
      el('me-z').textContent = p.z.toFixed(3);
      placeMe(p, accuracy);

      // Is the fix even inside the model? Tell the truth either way.
      const notes = [];
      if (!loadAlignment(activeModelId)) {
        notes.push('No saved alignment — position is only as good as the guessed heading.');
      }
      if (currentMesh) {
        const box = new THREE.Box3().setFromObject(currentMesh);
        const inside =
          p.x >= box.min.x && p.x <= box.max.x && p.y >= -box.max.z && p.y <= -box.min.z;
        if (!inside) {
          const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
          const dy = Math.max(-box.max.z - p.y, 0, p.y + box.min.z);
          notes.push(`You are outside this model’s footprint, about ${Math.round(Math.hypot(dx, dy))} m beyond its edge.`);
        }
      }
      if (accuracy > 25) {
        notes.push(`GPS is only accurate to ±${Math.round(accuracy)} m here — indoors that is normal, and the shaded disc shows the real uncertainty.`);
      }
      if (altitude == null) notes.push('Device reported no altitude; model Z was taken from the ground plane.');
      warn.textContent = notes.join(' ');

      setStatus('Located.', 'ok');
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = 'Find me';
      out.classList.remove('hidden');
      const msgs = {
        1: 'Permission denied — allow location access for this site and try again.',
        2: 'Position unavailable — no GPS or network fix right now.',
        3: 'Timed out waiting for a fix.',
      };
      warn.textContent = msgs[err.code] || err.message;
      setStatus('Location failed.', 'err');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
}

// ── routing ──────────────────────────────────────────────────────────────────
// POI coordinates are Showcase-space metres, which equals this scene's world
// space (modelRoot already applies the Z-up -> Y-up rotation), so POIs and the
// navmesh drop in without conversion. See matterpak-route.js for the numbers
// that establish that.

const routeGroup = new THREE.Group();
scene.add(routeGroup);

const poiGroup = new THREE.Group();
scene.add(poiGroup);

/** @type {Array<{id:string,name:string,x:number,y:number,z:number}>} */
let pois = [];

function clearRoute() {
  routeGroup.clear();
  el('nv-out').classList.add('hidden');
}

/**
 * Green navmesh overlay. Built here rather than via navigation-mesh.js's own
 * helper, because that one parents itself to the main app's MultiSet anchor,
 * which this standalone page does not have.
 * @type {THREE.Object3D | null}
 */
let navHelper = null;

async function toggleNavmeshView() {
  const btn = el('nv-mesh-toggle');
  if (navHelper) {
    scene.remove(navHelper);
    navHelper.traverse?.((c) => {
      c.geometry?.dispose?.();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose?.());
    });
    navHelper = null;
    btn.textContent = 'View navmesh';
    return;
  }

  const { getNavMesh } = await import('./ar/navigation-mesh.js');
  const navMesh = getNavMesh();
  if (!navMesh) {
    el('nv-warn').textContent = 'No navmesh loaded for this project.';
    return;
  }
  const { NavMeshHelper } = await import('@recast-navigation/three');
  navHelper = new NavMeshHelper(navMesh, {
    navMeshMaterial: new THREE.MeshBasicMaterial({
      color: 0x22ff66,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  });
  navHelper.update?.();
  // Navmesh is authored in Showcase space, which is this scene's world space.
  scene.add(navHelper);
  btn.textContent = 'Hide navmesh';
}

function plotPois() {
  poiGroup.clear();
  if (!pois.length) return;
  const geom = new THREE.SphereGeometry(0.45, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0.75 });
  const inst = new THREE.InstancedMesh(geom, mat, pois.length);
  const d = new THREE.Object3D();
  pois.forEach((p, i) => {
    d.position.set(p.x, p.y, p.z);
    d.updateMatrix();
    inst.setMatrixAt(i, d.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  poiGroup.add(inst);
}

function drawRoute(path) {
  routeGroup.clear();
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(path),
    new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false }),
  );
  routeGroup.add(line);

  // Endpoints readable at a glance: green start, red finish.
  for (const [pt, col] of [[path[0], 0x22c55e], [path[path.length - 1], 0xef4444]]) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 16, 16),
      new THREE.MeshBasicMaterial({ color: col, depthTest: false }),
    );
    m.position.copy(pt);
    routeGroup.add(m);
  }
}

/** Resolve the From/To selects into world-space points. */
function endpointFor(value) {
  if (value === '__me__') {
    if (!meGroup.visible) return { err: 'Press "Find me" first.' };
    return { p: meGroup.position.clone() };
  }
  const poi = pois.find((x) => x.id === value);
  if (!poi) return { err: 'Pick a point.' };
  return { p: new THREE.Vector3(poi.x, poi.y, poi.z) };
}

async function findRoute() {
  const warn = el('nv-warn');
  warn.textContent = '';
  const a = endpointFor(el('nv-from').value);
  const b = endpointFor(el('nv-to').value);
  if (a.err || b.err) {
    warn.textContent = a.err || b.err;
    return;
  }
  if (a.p.distanceTo(b.p) < 0.01) {
    warn.textContent = 'Start and destination are the same point.';
    return;
  }

  const { computeRoute, snapDistance } = await import('./matterpak-route.js');
  const r = computeRoute(a.p, b.p);
  if (!r.ok) {
    clearRoute();
    const sa = snapDistance(a.p);
    const sb = snapDistance(b.p);
    warn.textContent =
      `${r.error}.` +
      (sa != null && sa > 2 ? ` Start is ${sa.toFixed(1)} m off the mesh.` : '') +
      (sb != null && sb > 2 ? ` Destination is ${sb.toFixed(1)} m off the mesh.` : '');
    return;
  }

  drawRoute(r.path);
  el('nv-out').classList.remove('hidden');
  el('nv-dist').textContent = `${r.lengthM.toFixed(1)} m`;
  el('nv-pts').textContent = String(r.path.length);
  el('nv-direct').textContent = `${a.p.distanceTo(b.p).toFixed(1)} m`;
  warn.textContent = r.partial
    ? 'Partial route — the navmesh does not connect these two points, so this stops short.'
    : '';
}

async function loadRouting(modelId) {
  pois = [];
  poiGroup.clear();
  clearRoute();
  el('nv-warn').textContent = '';
  for (const id of ['nv-type', 'nv-count', 'nv-mesh']) el(id).textContent = '—';

  const { poiTypeForModel, fetchPois, fetchNavmeshUrl, loadNavmesh } = await import(
    './matterpak-route.js'
  );
  const poiType = poiTypeForModel(modelId);
  el('nv-type').textContent = poiType || 'not mapped';
  if (!poiType) {
    el('nv-warn').textContent = 'No NavMe project is mapped to this Matterport model.';
    return;
  }

  try {
    pois = await fetchPois(poiType);
    el('nv-count').textContent = String(pois.length);
    plotPois();

    const fromSel = el('nv-from');
    const toSel = el('nv-to');
    fromSel.innerHTML = '<option value="">—</option><option value="__me__">My location (GPS)</option>';
    toSel.innerHTML = '<option value="">—</option>';
    for (const p of pois) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      fromSel.appendChild(o);
      toSel.appendChild(o.cloneNode(true));
    }

    const url = await fetchNavmeshUrl(poiType);
    if (!url) {
      el('nv-mesh').textContent = 'none';
      el('nv-warn').textContent = 'No active navmesh for this project — routing unavailable.';
      return;
    }
    el('nv-mesh').textContent = 'loading…';
    await loadNavmesh(url);
    el('nv-mesh').textContent = 'ready';
  } catch (err) {
    el('nv-warn').textContent = `Routing setup failed: ${err.message}`;
  }
}

/** Recompute the lat/long readout in place when heading or altitude changes. */
function refreshReadout() {
  if (lastReadout) showPoint(lastReadout.obj, marker.position.clone());
}

/**
 * Blank the readout. Dimming the panel is not enough on a model switch — the
 * old numbers stay legible and read as if they belong to the new model.
 */
function clearReadout() {
  for (const id of ['o-x', 'o-y', 'o-z', 's-x', 's-y', 's-z', 'p-lat', 'p-lon', 'p-alt', 'p-en']) {
    el(id).textContent = '—';
  }
  el('gmap').href = '#';
  el('right').classList.add('idle');
  marker.visible = false;
  lastReadout = null;
  // A fix resolved against the previous model's alignment means nothing here.
  meGroup.visible = false;
  el('me-out').classList.add('hidden');
}

// ── loading ──────────────────────────────────────────────────────────────────
let sceneScale = 50;

function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  sceneScale = radius;
  const centre = box.getCenter(new THREE.Vector3());
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360);

  camera.position.set(centre.x + dist * 0.7, centre.y + dist * 0.6, centre.z + dist * 0.7);
  camera.near = Math.max(dist / 2000, 0.05);
  camera.far = dist * 16;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();

  grid.scale.setScalar(Math.max(radius / 100, 0.5));
  buildOrigin(radius * 0.22);
}

function countTriangles(root) {
  let t = 0;
  root.traverse((c) => {
    const g = c.geometry;
    if (g) t += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(t);
}

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
    barEl.style.width = total ? `${(got / total) * 100}%` : '45%';
    setStatus(`Streaming from Matterport CDN… ${fmtBytes(got)}`);
  }
  barEl.style.width = '100%';
  el('m-size').textContent = fmtBytes(got);
  return new Blob(chunks).text();
}

function disposeCurrent() {
  if (!currentMesh) return;
  modelRoot.remove(currentMesh);
  currentMesh.traverse((c) => {
    c.geometry?.dispose?.();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose?.());
  });
  currentMesh = null;
}

async function loadMesh(mesh) {
  if (!mesh.downloadUrl) {
    setStatus(`${mesh.resolution} is ${mesh.status} — not unlocked.`, 'err');
    return;
  }
  document.querySelectorAll('#pick button').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === mesh.id),
  );
  barEl.style.width = '0';
  clearReadout();
  setStatus('Requesting geometry…');

  try {
    const text = await fetchWithProgress(mesh.downloadUrl);
    setStatus('Parsing OBJ…');
    const obj = new OBJLoader().parse(text);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9fb3d9,
      roughness: 0.85,
      metalness: 0.05,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    obj.traverse((c) => {
      if (c.isMesh) {
        c.material = mat;
        c.geometry.computeVertexNormals();
      }
    });

    disposeCurrent();
    modelRoot.add(obj);
    currentMesh = obj;
    frameObject(modelRoot);
    el('m-tris').textContent = countTriangles(obj).toLocaleString();
    setStatus(`${mesh.filename} — live from Matterport, nothing stored.`, 'ok');
  } catch (err) {
    setStatus(`Load failed: ${err.message}`, 'err');
  }
}

async function selectModel(modelId) {
  disposeCurrent();
  el('pick').innerHTML = '';
  el('m-tris').textContent = el('m-size').textContent = '—';
  setStatus('Fetching signed links…');

  let data;
  try {
    const res = await fetch(`/api/matterport/meshes?modelId=${encodeURIComponent(modelId)}`);
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    setStatus(`Matterport API: ${err.message}`, 'err');
    return;
  }

  activeModelId = modelId;
  geo = { lat: data.lat, lon: data.lon, altitude: data.altitude };

  // An alignment saved in the map tool beats Matterport's bare anchor: it
  // carries the heading and altitude the API refuses to hand over.
  const saved = loadAlignment(modelId);
  if (saved) {
    geo = { lat: saved.lat, lon: saved.lon, altitude: saved.altitude };
    heading = saved.heading;
    baseAlt = saved.altitude;
    el('heading').value = heading;
    el('basealt').value = baseAlt;
    el('h-val').textContent = `${heading}\u00b0`;
  }

  el('g-lat').textContent = geo.lat != null ? geo.lat.toFixed(7) : 'none';
  el('g-lon').textContent = geo.lon != null ? geo.lon.toFixed(7) : 'none';
  el('m-addr').textContent = data.address || ' ';
  const expiry = data.meshes.find((m) => m.validUntil)?.validUntil;
  el('m-expiry').textContent = expiry ? new Date(expiry).toLocaleString() : '\u2014';

  el('geowarn').textContent = saved
    ? `Using the alignment saved in the map tool on ${new Date(saved.savedAt).toLocaleString()}.`
    : data.lat == null
      ? 'No geolocation on this model \u2014 lat/long readout unavailable.'
      : 'No saved alignment yet \u2014 heading is a guess. Align it on the map for real bearings.';


  const usable = data.meshes.filter((m) => m.downloadUrl);
  for (const m of data.meshes) {
    const b = document.createElement('button');
    b.dataset.id = m.id;
    b.textContent = m.filename ? m.filename.replace(/\.obj$/, '') : m.resolution;
    b.disabled = !m.downloadUrl;
    b.title = m.downloadUrl ? m.filename : `${m.resolution}: ${m.status}`;
    b.addEventListener('click', () => loadMesh(m));
    el('pick').appendChild(b);
  }

  if (!usable.length) {
    setStatus('No unlocked geometry on this model.', 'err');
    return;
  }
  await loadMesh(usable[0]);
  void loadRouting(modelId);
}

async function init() {
  const sel = el('model');
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

  sel.innerHTML = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.name} — ${m.id}`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => selectModel(sel.value));

  // Default to GCU when present, since that is the model in active use.
  const gcu = models.find((m) => m.id === 'jdjvM17BPEh');
  sel.value = gcu ? gcu.id : models[0]?.id;
  if (sel.value) await selectModel(sel.value);
}

el('findme').addEventListener('click', findMe);
el('nv-go').addEventListener('click', () => void findRoute());
el('nv-clear').addEventListener('click', () => {
  clearRoute();
  el('nv-warn').textContent = '';
});
el('nv-mesh-toggle').addEventListener('click', () => void toggleNavmeshView());
el('nv-poi-toggle').addEventListener('click', (e) => {
  poiGroup.visible = !poiGroup.visible;
  e.target.textContent = poiGroup.visible ? 'Hide POIs' : 'Show POIs';
});

el('heading').addEventListener('input', (e) => {
  heading = Number(e.target.value);
  el('h-val').textContent = `${heading}°`;
  originGroup.rotation.y = -(heading * Math.PI) / 180;
  refreshReadout();
});
el('basealt').addEventListener('input', (e) => {
  baseAlt = Number(e.target.value) || 0;
  refreshReadout();
});
el('copy').addEventListener('click', () => {
  if (!lastReadout) return;
  const { obj, geo: g } = lastReadout;
  const txt = [
    `OBJ (Z-up)      X ${obj.x.toFixed(3)}  Y ${obj.y.toFixed(3)}  Z ${obj.z.toFixed(3)}`,
    `Showcase (Y-up) X ${obj.x.toFixed(3)}  Y ${obj.z.toFixed(3)}  Z ${(-obj.y).toFixed(3)}`,
    g ? `WGS84           ${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}  alt ${g.alt.toFixed(2)} m` : 'WGS84           n/a',
    g ? `Heading used    ${heading}°` : '',
  ]
    .filter(Boolean)
    .join('\n');
  navigator.clipboard.writeText(txt).then(
    () => setStatus('Coordinates copied.', 'ok'),
    () => setStatus('Clipboard blocked by the browser.', 'err'),
  );
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

init();
