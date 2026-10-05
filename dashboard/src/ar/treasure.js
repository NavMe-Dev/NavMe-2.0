/**
 * Treasure Hunt 3D layer — treasures + per-item hint billboards from `treasure_items`.
 * Isolated from media.js.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fetchTreasureItems } from '../services/treasure-api.js';
import { rememberEntitiesXyz } from '../services/user-logs.js';

/** @type {Array<Record<string, unknown>>} */
export const treasureData = [];

/** @type {Array<{ root: THREE.Object3D | null, hintRoot: THREE.Object3D | null, item: Record<string, unknown> }>} */
const treasureObjects = [];
let treasureGroupRef = null;
let treasureGroupVisible = true;
let sharedGltfLoader = null;

export function setTreasureGltfLoader(loader) {
  sharedGltfLoader = loader;
}

export function getTreasureCount() {
  return treasureData.length;
}

export function normalizeTreasureItem(row) {
  const posX = Number(row.pos_x) || 0;
  const posY = Number(row.pos_y) || 0;
  const posZ = Number(row.pos_z) || 0;
  const hx = Number(row.hint_x) || 0;
  const hy = Number(row.hint_y) || 0;
  const hz = Number(row.hint_z) || 0;
  const hintUnset = hx === 0 && hy === 0 && hz === 0 && !row.hint_image;
  return {
    id: row.id,
    poi_type: row.poi_type,
    level_id: row.level_id,
    name: row.name ?? 'Treasure',
    media_type: row.media_type === 'model' ? 'model' : 'image',
    media_url: row.media_url,
    pos_x: posX,
    pos_y: posY,
    pos_z: posZ,
    rot_x: Number(row.rot_x) || 0,
    rot_y: Number(row.rot_y) || 0,
    rot_z: Number(row.rot_z) || 0,
    scale: Number(row.scale) || 0.35,
    collect_radius_m: row.collect_radius_m == null ? 0.2 : Number(row.collect_radius_m),
    points: Number(row.points) || 1,
    is_hidden_until_clue: Boolean(row.is_hidden_until_clue),
    sort_order: Number(row.sort_order) || 1,
    is_active: row.is_active !== false,
    hint_title: row.hint_title != null ? String(row.hint_title) : '',
    hint: row.hint != null ? String(row.hint) : '',
    hint_image: row.hint_image || null,
    hint_x: hintUnset ? posX : hx,
    hint_y: hintUnset ? posY + 0.6 : hy,
    hint_z: hintUnset ? posZ : hz,
    hint_rot_x: Number(row.hint_rot_x) || 0,
    hint_rot_y: Number(row.hint_rot_y) || 0,
    hint_rot_z: Number(row.hint_rot_z) || 0,
    hint_scale_x: Number(row.hint_scale_x) || 1,
    hint_scale_y: Number(row.hint_scale_y) || 1,
    hint_scale_z: Number(row.hint_scale_z) || 1,
  };
}

export async function hydrateTreasuresFromSupabase() {
  treasureData.length = 0;
  const rows = await fetchTreasureItems();
  rows.forEach((row) => treasureData.push(normalizeTreasureItem(row)));
  rememberEntitiesXyz('treasure', treasureData);
}

export function upsertTreasureLocal(row) {
  const normalized = normalizeTreasureItem(row);
  const idx = treasureData.findIndex((t) => String(t.id) === String(normalized.id));
  if (idx >= 0) {
    treasureData[idx] = normalized;
    if (treasureObjects[idx]) treasureObjects[idx].item = normalized;
    return idx;
  }
  treasureData.push(normalized);
  treasureObjects.push({ root: null, hintRoot: null, item: normalized });
  return treasureData.length - 1;
}

function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m) return;
        m.map?.dispose();
        m.dispose();
      });
    }
  });
}

function applyTreasureTransform(root, item) {
  root.position.set(item.pos_x, item.pos_y, item.pos_z);
  root.rotation.set(
    Number(item.rot_x) || 0,
    Number(item.rot_y) || 0,
    Number(item.rot_z) || 0,
  );
  const s = Number(item.scale) || 0.35;
  root.scale.set(s, s, s);
}

function applyHintTransform(root, item) {
  root.position.set(item.hint_x, item.hint_y, item.hint_z);
  root.rotation.set(
    Number(item.hint_rot_x) || 0,
    Number(item.hint_rot_y) || 0,
    Number(item.hint_rot_z) || 0,
  );
  root.scale.set(
    Number(item.hint_scale_x) || 1,
    Number(item.hint_scale_y) || 1,
    Number(item.hint_scale_z) || 1,
  );
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

async function createImagePlane(url) {
  const tex = await loadTexture(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  const img = tex.image;
  const aspect =
    img && img.width && img.height ? Math.max(0.05, img.width / img.height) : 1;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true });
  return new THREE.Mesh(new THREE.PlaneGeometry(aspect, 1), mat);
}

async function createVisual(item) {
  if (item.media_type === 'model' && item.media_url) {
    const loader = sharedGltfLoader ?? new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(item.media_url, resolve, undefined, reject);
    });
    return gltf.scene;
  }

  if (item.media_url && /^https?:\/\//i.test(item.media_url)) {
    try {
      return await createImagePlane(item.media_url);
    } catch (err) {
      console.warn('[treasure] texture failed, using marker:', err);
    }
  }

  const geo = new THREE.OctahedronGeometry(0.45, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: false });
  return new THREE.Mesh(geo, mat);
}

async function createHintVisual(item) {
  if (!item.hint_image || !/^https?:\/\//i.test(String(item.hint_image))) return null;
  try {
    return await createImagePlane(String(item.hint_image));
  } catch (err) {
    console.warn('[treasure] hint texture failed:', err);
    return null;
  }
}

async function mountTreasureEntry(index, group) {
  const item = treasureData[index];
  if (!item.is_active) {
    return { root: null, hintRoot: null, item };
  }

  const root = new THREE.Group();
  root.name = `Treasure_${item.id}`;
  root.userData.treasureIndex = index;
  root.userData.kind = 'treasure';

  let hintRoot = null;
  try {
    const visual = await createVisual(item);
    root.add(visual);
    applyTreasureTransform(root, item);
    group.add(root);

    hintRoot = new THREE.Group();
    hintRoot.name = `TreasureHint_${item.id}`;
    hintRoot.userData.treasureIndex = index;
    hintRoot.userData.kind = 'hint';
    const hintVisual = await createHintVisual(item);
    if (hintVisual) {
      hintRoot.add(hintVisual);
    } else {
      // Placeholder so hint can be placed with the gizmo before a billboard exists
      const marker = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.35),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
        }),
      );
      hintRoot.add(marker);
    }
    applyHintTransform(hintRoot, item);
    group.add(hintRoot);
  } catch (err) {
    console.warn('[treasure] Failed to load', item.name, err);
    return { root: null, hintRoot: null, item };
  }

  return { root, hintRoot, item };
}

export async function addTreasuresToScene(container) {
  const existing = container.getObjectByName('TreasureGroup');
  if (existing) {
    disposeObject3D(existing);
    container.remove(existing);
  }

  treasureObjects.length = 0;
  const group = new THREE.Group();
  group.name = 'TreasureGroup';
  treasureGroupRef = group;

  for (let index = 0; index < treasureData.length; index++) {
    const entry = await mountTreasureEntry(index, group);
    treasureObjects.push(entry);
  }

  group.visible = treasureGroupVisible;
  container.add(group);
}

export function refreshTreasureGroup(container) {
  if (!container) return Promise.resolve();
  return addTreasuresToScene(container);
}

export async function remountTreasureItem(index, container = treasureGroupRef?.parent) {
  if (!container || index < 0 || index >= treasureData.length) return false;
  while (treasureObjects.length < treasureData.length) {
    treasureObjects.push({
      root: null,
      hintRoot: null,
      item: treasureData[treasureObjects.length],
    });
  }
  if (!treasureGroupRef || treasureGroupRef.parent !== container) {
    await addTreasuresToScene(container);
    return Boolean(treasureObjects[index]?.root);
  }

  const existing = treasureObjects[index];
  if (existing?.root) {
    disposeObject3D(existing.root);
    treasureGroupRef.remove(existing.root);
  }
  if (existing?.hintRoot) {
    disposeObject3D(existing.hintRoot);
    treasureGroupRef.remove(existing.hintRoot);
  }

  const entry = await mountTreasureEntry(index, treasureGroupRef);
  treasureObjects[index] = entry;
  return Boolean(entry.root);
}

export function setTreasureGroupVisible(visible) {
  treasureGroupVisible = Boolean(visible);
  if (treasureGroupRef) treasureGroupRef.visible = treasureGroupVisible;
}

export function getTreasureObjects() {
  return treasureObjects;
}

export function updateTreasureTransform(index, patch) {
  const item = treasureData[index];
  const obj = treasureObjects[index];
  if (!item || !obj) return;
  Object.assign(item, patch);
  if (obj.root) applyTreasureTransform(obj.root, item);
}

export function updateHintTransform(index, patch) {
  const item = treasureData[index];
  const obj = treasureObjects[index];
  if (!item || !obj) return;
  Object.assign(item, patch);
  if (obj.hintRoot) applyHintTransform(obj.hintRoot, item);
}

export function deleteTreasureFromScene(index) {
  if (index < 0 || index >= treasureData.length) return;
  const obj = treasureObjects[index];
  if (obj?.root && treasureGroupRef) {
    disposeObject3D(obj.root);
    treasureGroupRef.remove(obj.root);
  }
  if (obj?.hintRoot && treasureGroupRef) {
    disposeObject3D(obj.hintRoot);
    treasureGroupRef.remove(obj.hintRoot);
  }
  treasureObjects.splice(index, 1);
  treasureData.splice(index, 1);
  treasureObjects.forEach((entry, i) => {
    if (entry.root) entry.root.userData.treasureIndex = i;
    if (entry.hintRoot) entry.hintRoot.userData.treasureIndex = i;
  });
}

export function deleteTreasureFromSceneById(id) {
  const index = treasureData.findIndex((t) => String(t.id) === String(id));
  if (index >= 0) deleteTreasureFromScene(index);
}
