import * as THREE from 'three';
import {
  fetchAllPois,
  insertPoiRow,
  updatePoiRow,
  deletePoiRow,
  fetchPoiCategoryLinks,
  replacePoiCategoryLinks,
} from '../services/supabase.js';
import { logUserActivity, rememberEntitiesXyz } from '../services/user-logs.js';
import {
  buildPoiDescriptionTranslationFields,
  buildPoiTranslationFields,
  consumeTranslationFailures,
  langMapFromRow,
  langMapFromTranslationFields,
  missingTranslationLangs,
} from '../services/poi-translate.js';
import { hasSuperadminSession } from '../config/superadmin.js';
import { getAuthSession } from '../config/auth-session.js';
import { localizedText } from '../config/i18n.js';

/** In-memory POIs synced with `navme_pois`. */
export const poisData = [];

/** Super admin sees navigation + expected pins; end admins see expected (click) only. */
export function isSuperAdminMapRole() {
  return Boolean(hasSuperadminSession() || getAuthSession()?.role === 'superadmin');
}

/**
 * Navigation / moved point (`pos_*`) — snapped walkable XYZ used for routing.
 * @param {Record<string, unknown> | null | undefined} poi
 */
export function getPoiNavigationPosition(poi) {
  return {
    x: Number(poi?.pos_x) || 0,
    y: Number(poi?.pos_y) || 0,
    z: Number(poi?.pos_z) || 0,
  };
}

/** @deprecated Use getPoiNavigationPosition */
export function getPoiPlacedPosition(poi) {
  return getPoiNavigationPosition(poi);
}

/**
 * Expected point (`expected_pos_*`) — exact map click XYZ.
 * @param {Record<string, unknown> | null | undefined} poi
 */
export function getPoiExpectedPosition(poi) {
  return {
    x: Number(poi?.expected_pos_x ?? poi?.pos_x) || 0,
    y: Number(poi?.expected_pos_y ?? poi?.pos_y) || 0,
    z: Number(poi?.expected_pos_z ?? poi?.pos_z) || 0,
  };
}

/**
 * Surface normal at the expected click — drives Matterport pin stem tilt.
 * Falls back to outward hint from nav→expected, then straight up.
 * @param {Record<string, unknown> | null | undefined} poi
 */
export function getPoiExpectedNormal(poi) {
  const nx = Number(poi?.expected_normal_x);
  const ny = Number(poi?.expected_normal_y);
  const nz = Number(poi?.expected_normal_z);
  const storedLen = Math.hypot(nx, ny, nz);
  if (Number.isFinite(storedLen) && storedLen > 0.2) {
    return { x: nx / storedLen, y: ny / storedLen, z: nz / storedLen };
  }

  // Infer outward tilt when only XYZ exist (older rows / migration not applied yet).
  const expected = getPoiExpectedPosition(poi);
  const nav = getPoiNavigationPosition(poi);
  const ox = nav.x - expected.x;
  const oy = nav.y - expected.y;
  const oz = nav.z - expected.z;
  const horiz = Math.hypot(ox, oz);
  if (horiz > 0.25) {
    // Point stem out of the wall into the room (toward nav on the floor).
    const len = Math.hypot(ox, Math.max(oy, 0) * 0.15, oz) || 1;
    return { x: ox / len, y: (Math.max(oy, 0) * 0.15) / len, z: oz / len };
  }
  return { x: 0, y: 1, z: 0 };
}

/**
 * Normalize a place-hit normal for storage.
 * @param {{ x?: number, y?: number, z?: number } | null | undefined} normal
 */
export function normalizeExpectedNormal(normal) {
  const nx = Number(normal?.x);
  const ny = Number(normal?.y);
  const nz = Number(normal?.z);
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len < 0.2) return { x: 0, y: 1, z: 0 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Map pin the current role sees as primary:
 * - end admin → expected (exact click, never moved by edit/move tools)
 * - super admin → navigation (pos_* / moved)
 * @param {Record<string, unknown> | null | undefined} poi
 */
export function getPoiMapPosition(poi) {
  return isSuperAdminMapRole() ? getPoiNavigationPosition(poi) : getPoiExpectedPosition(poi);
}

/**
 * @param {Record<string, unknown> | null | undefined} poi
 * @param {number} [eps]
 */
export function poiExpectedDiffersFromPlaced(poi, eps = 0.08) {
  const nav = getPoiNavigationPosition(poi);
  const expected = getPoiExpectedPosition(poi);
  return Math.hypot(nav.x - expected.x, nav.y - expected.y, nav.z - expected.z) > eps;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} [categoryIds]
 */
export function normalizePoiRow(row, categoryIds) {
  const fromLinks = Array.isArray(categoryIds)
    ? categoryIds.map((id) => String(id)).filter(Boolean)
    : null;
  const legacy = row.category_type ? [String(row.category_type)] : [];
  const ids = fromLinks ?? legacy;
  return {
    id: row.id,
    poi_name: row.poi_name ?? row.title ?? row.name ?? 'POI',
    description: row.description ?? '',
    /** Primary category — kept for Mattercraft / AR clients. */
    category_type: ids[0] ?? row.category_type ?? null,
    /** All assigned category ids (primary first). */
    category_ids: ids,
    pos_x: Number(row.pos_x),
    pos_y: Number(row.pos_y),
    pos_z: Number(row.pos_z),
    expected_pos_x: row.expected_pos_x == null ? Number(row.pos_x) : Number(row.expected_pos_x),
    expected_pos_y: row.expected_pos_y == null ? Number(row.pos_y) : Number(row.expected_pos_y),
    expected_pos_z: row.expected_pos_z == null ? Number(row.pos_z) : Number(row.expected_pos_z),
    expected_normal_x:
      row.expected_normal_x == null ? 0 : Number(row.expected_normal_x),
    expected_normal_y:
      row.expected_normal_y == null ? 1 : Number(row.expected_normal_y),
    expected_normal_z:
      row.expected_normal_z == null ? 0 : Number(row.expected_normal_z),
    created_by: row.created_by != null ? String(row.created_by) : null,
    assigned_to: row.assigned_to != null ? String(row.assigned_to) : null,
    floor_id: row.floor_id != null ? String(row.floor_id) : null,
    matterport_tag_id: row.matterport_tag_id != null ? String(row.matterport_tag_id) : null,
    approval_status: String(row.approval_status || 'accepted'),
    name_langs: langMapFromRow(row, 'poi_name', 'poi_names'),
    description_langs: langMapFromRow(row, 'description', 'descriptions'),
  };
}

/** POI name in the dashboard's active language (falls back to English). */
export function poiDisplayName(poi) {
  return localizedText(poi?.name_langs, poi?.poi_name) || 'POI';
}

/** POI description in the dashboard's active language (falls back to English). */
export function poiDisplayDescription(poi) {
  return localizedText(poi?.description_langs, poi?.description);
}

export function sortPoisDataInPlace() {
  poisData.sort((a, b) => poiDisplayName(a).localeCompare(poiDisplayName(b)));
}

/** @param {string[]} categoryIds */
function primaryCategoryId(categoryIds) {
  const ids = (Array.isArray(categoryIds) ? categoryIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  return ids[0] ?? null;
}

export async function hydratePoisFromSupabase() {
  poisData.length = 0;
  try {
    const rows = await fetchAllPois();
    const normalized = (Array.isArray(rows) ? rows : []).map((row) => normalizePoiRow(row));
    const links = await fetchPoiCategoryLinks(normalized.map((p) => p.id));
    /** @type {Map<string, string[]>} */
    const byPoi = new Map();
    (Array.isArray(links) ? links : []).forEach((link) => {
      const poiId = String(link.poi_id ?? '');
      const catId = String(link.category_id ?? '');
      if (!poiId || !catId) return;
      if (!byPoi.has(poiId)) byPoi.set(poiId, []);
      byPoi.get(poiId).push(catId);
    });

    normalized.forEach((poi) => {
      const linked = byPoi.get(String(poi.id));
      if (linked?.length) {
        poi.category_ids = linked;
        poi.category_type = linked[0];
      } else if (poi.category_type) {
        poi.category_ids = [String(poi.category_type)];
      } else {
        poi.category_ids = [];
      }
      poisData.push(poi);
    });
    sortPoisDataInPlace();
    rememberEntitiesXyz('poi', poisData);
  } catch (err) {
    console.error('[pois] Failed to load from Supabase:', err);
    throw err;
  }
}

export function refreshPOIGroup(container) {
  if (!container) return;
  addPOIsToScene(container);
}

const poiObjects = [];
let poiGroupRef = null;
let poiGroupVisible = true;

function createTextSprite(message) {
  const fontface = 'Arial';
  const fontsize = 28;
  const padding = 10;
  const borderRadius = 8;

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');

  context.font = `Bold ${fontsize}px ${fontface}`;
  const metrics = context.measureText(message);
  const textWidth = metrics.width;

  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = Math.ceil(fontsize * 1.5 + padding * 2);

  context.font = `Bold ${fontsize}px ${fontface}`;
  context.textBaseline = 'middle';
  context.textAlign = 'center';

  context.fillStyle = 'rgba(10, 10, 20, 0.88)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, canvas.height, borderRadius);
  context.fill();

  context.lineWidth = 1.5;
  context.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  context.stroke();

  context.fillStyle = 'rgba(255, 255, 255, 1.0)';
  context.fillText(message, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const spriteMaterial = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    // Keep label readable at any camera distance (was vanishing when far).
    sizeAttenuation: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.renderOrder = 999;

  // Screen-ish size in NDC when sizeAttenuation is false (~0.12–0.28).
  const aspect = canvas.width / Math.max(1, canvas.height);
  const h = 0.085;
  sprite.scale.set(h * aspect, h, 1);
  sprite.visible = false;
  sprite.userData.isPoiLabel = true;

  return sprite;
}

/**
 * Build the scene objects for a single POI. Each POI owns its own materials so
 * that deletePOI's per-object `.material.dispose()` can never tear down a
 * material still in use by a sibling (materials used to be shared across the
 * whole group, which only stayed safe because every add rebuilt everything).
 * @param {Record<string, unknown>} poi
 * @param {number} index
 * @param {boolean} showBoth
 */
function buildPoiEntry(poi, index, showBoth) {
  const expected = getPoiExpectedPosition(poi);
  const nav = getPoiNavigationPosition(poi);
  // End admin: only the exact-click expected pin. Super admin: nav primary + expected ghost.
  const primaryPos = showBoth ? nav : expected;
  // Red = navigation (pos_*). Amber = expected (exact click).
  const primaryMat = showBoth
    ? new THREE.MeshBasicMaterial({ color: 0xff3366 })
    : new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.85 });
  const dotGeo = new THREE.SphereGeometry(0.18, 12, 12);
  const obj = createPOIObject(poi, index, primaryPos, dotGeo, primaryMat);

  if (showBoth && poiExpectedDiffersFromPlaced(poi, 0.02)) {
    const expectedGeo = new THREE.SphereGeometry(0.14, 12, 12);
    const expectedMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.85 });
    const expectedMesh = new THREE.Mesh(expectedGeo, expectedMat);
    expectedMesh.position.set(expected.x, expected.y, expected.z);
    expectedMesh.userData.poiIndex = index;
    expectedMesh.userData.isExpectedPoiMarker = true;
    obj.expectedMesh = expectedMesh;
  }
  return obj;
}

export function addPOIsToScene(container) {
  const existing = container.getObjectByName('POIGroup');
  if (existing) container.remove(existing);

  poiObjects.length = 0;

  const poiGroup = new THREE.Group();
  poiGroup.name = 'POIGroup';
  poiGroupRef = poiGroup;

  const showBoth = isSuperAdminMapRole();

  poisData.forEach((poi, index) => {
    const obj = buildPoiEntry(poi, index, showBoth);
    poiGroup.add(obj.mesh);
    poiGroup.add(obj.label);
    if (obj.expectedMesh) poiGroup.add(obj.expectedMesh);
    poiObjects.push(obj);
  });

  poiGroup.visible = poiGroupVisible;
  container.add(poiGroup);
}

/**
 * Append ONE poi to the already-mounted group without rebuilding — and thus
 * without re-rasterizing a label canvas texture for every existing POI, which
 * was the dominant cost of clicking "+". Mirrors deletePOI's incremental splice
 * + reindex. Falls back to a full build if the group isn't mounted yet.
 * @param {number} index  position of the new poi in the (already sorted) poisData
 * @param {THREE.Object3D | null | undefined} [container]
 * @returns {boolean} whether the item is now in the scene
 */
export function addSinglePoiToScene(index, container = poiGroupRef?.parent) {
  if (!container || index < 0 || index >= poisData.length) return false;
  if (!poiGroupRef || poiGroupRef.parent !== container) {
    addPOIsToScene(container);
    return true;
  }

  const obj = buildPoiEntry(poisData[index], index, isSuperAdminMapRole());
  poiGroupRef.add(obj.mesh);
  poiGroupRef.add(obj.label);
  if (obj.expectedMesh) poiGroupRef.add(obj.expectedMesh);

  poiObjects.splice(index, 0, obj);
  // Reindex from the insertion point down — cheap integer writes, no texture
  // work — so pin hit-testing by userData.poiIndex stays aligned with poisData.
  for (let i = index; i < poiObjects.length; i++) {
    const entry = poiObjects[i];
    if (entry?.mesh) entry.mesh.userData.poiIndex = i;
    if (entry?.expectedMesh) entry.expectedMesh.userData.poiIndex = i;
  }

  poiGroupRef.visible = poiGroupVisible;
  return true;
}

export function setPOIGroupVisible(visible) {
  poiGroupVisible = Boolean(visible);
  if (poiGroupRef) poiGroupRef.visible = poiGroupVisible;
}

export function getPOIObjects() {
  return poiObjects;
}

/** @type {number} */
let hoveredPoiIndex = -1;
/** @type {number} */
let selectedPoiLabelIndex = -1;

function syncPoiLabelVisibility() {
  poiObjects.forEach((obj, i) => {
    if (!obj?.label) return;
    obj.label.visible = i === hoveredPoiIndex || i === selectedPoiLabelIndex;
  });
}

/**
 * Show the POI name label while hovering the pin (geometric mesh).
 * @param {number} index
 */
export function setHoveredPoiLabel(index) {
  const next = typeof index === 'number' && index >= 0 ? index : -1;
  if (next === hoveredPoiIndex) return;
  hoveredPoiIndex = next;
  syncPoiLabelVisibility();
}

/**
 * Keep the selected POI name visible.
 * @param {number} index
 */
export function setSelectedPoiLabel(index) {
  const next = typeof index === 'number' && index >= 0 ? index : -1;
  if (next === selectedPoiLabelIndex) return;
  selectedPoiLabelIndex = next;
  syncPoiLabelVisibility();
}

/**
 * Move / edit XYZ — always updates navigation (`pos_*`) only.
 * Expected (`expected_pos_*`) stays at the original click and is never overwritten here.
 */
export function updatePOIPosition(index, x, y, z) {
  const obj = poiObjects[index];
  const poi = poisData[index];
  if (!poi) return;

  poisData[index].pos_x = x;
  poisData[index].pos_y = y;
  poisData[index].pos_z = z;

  if (!obj) return;

  // Primary mesh follows the role's map pin (expected for end admin, nav for super admin).
  const mapPos = getPoiMapPosition(poisData[index]);
  obj.mesh.position.set(mapPos.x, mapPos.y, mapPos.z);
  obj.label.position.set(mapPos.x, mapPos.y + 0.85, mapPos.z);

  if (obj.expectedMesh) {
    const expected = getPoiExpectedPosition(poisData[index]);
    obj.expectedMesh.position.set(expected.x, expected.y, expected.z);
    obj.expectedMesh.visible = isSuperAdminMapRole() && poiExpectedDiffersFromPlaced(poisData[index]);
  }
}

/**
 * Super-admin only: move / edit expected click XYZ (`expected_pos_*`).
 * Does not change navigation `pos_*`.
 */
export function updatePOIExpectedPosition(index, x, y, z) {
  const poi = poisData[index];
  if (!poi) return;

  poisData[index].expected_pos_x = x;
  poisData[index].expected_pos_y = y;
  poisData[index].expected_pos_z = z;

  const obj = poiObjects[index];
  if (!obj) return;

  // End admin primary pin is expected — keep it in sync.
  if (!isSuperAdminMapRole()) {
    obj.mesh.position.set(x, y, z);
    obj.label.position.set(x, y + 0.85, z);
    return;
  }

  const expectedMesh = ensureExpectedMesh(index);
  if (expectedMesh) {
    expectedMesh.position.set(x, y, z);
    expectedMesh.visible = true;
  }
}

/**
 * Ensure super-admin amber expected marker exists (needed when nav === expected).
 * @param {number} index
 * @returns {THREE.Mesh | null}
 */
export function ensureExpectedMesh(index) {
  if (!isSuperAdminMapRole()) return null;
  const obj = poiObjects[index];
  const poi = poisData[index];
  if (!obj || !poi || !poiGroupRef) return null;

  const expected = getPoiExpectedPosition(poi);
  if (obj.expectedMesh) {
    obj.expectedMesh.position.set(expected.x, expected.y, expected.z);
    return obj.expectedMesh;
  }

  const expectedMat = new THREE.MeshBasicMaterial({
    color: 0xf59e0b,
    transparent: true,
    opacity: 0.85,
  });
  const expectedGeo = new THREE.SphereGeometry(0.14, 12, 12);
  const expectedMesh = new THREE.Mesh(expectedGeo, expectedMat);
  expectedMesh.position.set(expected.x, expected.y, expected.z);
  expectedMesh.userData.poiIndex = index;
  expectedMesh.userData.isExpectedPoiMarker = true;
  poiGroupRef.add(expectedMesh);
  obj.expectedMesh = expectedMesh;
  return expectedMesh;
}

export function updatePOIDescription(index, description) {
  const poi = poisData[index];
  if (!poi) return;
  poi.description = description;
}

export function updatePOIName(index, name) {
  const obj = poiObjects[index];
  const poi = poisData[index];
  if (!obj || !poi) return;
  poi.poi_name = name;

  const oldMaterial = obj.label.material;
  const oldMap = oldMaterial.map;
  const newLabel = createTextSprite(name);
  newLabel.position.copy(obj.label.position);

  if (poiGroupRef) poiGroupRef.remove(obj.label);
  obj.label = newLabel;
  if (poiGroupRef) poiGroupRef.add(newLabel);
  syncPoiLabelVisibility();

  if (oldMap) oldMap.dispose();
  oldMaterial.dispose();
}

export async function addPOIWithDb(poi) {
  const categoryIds = Array.isArray(poi.category_ids)
    ? poi.category_ids.map((id) => String(id)).filter(Boolean)
    : poi.category_type
      ? [String(poi.category_type)]
      : [];
  const primary = primaryCategoryId(categoryIds);

  // Insert first so Google/MyMemory rate-limits never block Add POI.
  const expectedX = poi.expected_pos_x == null ? poi.pos_x : Number(poi.expected_pos_x);
  const expectedY = poi.expected_pos_y == null ? poi.pos_y : Number(poi.expected_pos_y);
  const expectedZ = poi.expected_pos_z == null ? poi.pos_z : Number(poi.expected_pos_z);
  const expectedNormal = normalizeExpectedNormal({
    x: poi.expected_normal_x,
    y: poi.expected_normal_y,
    z: poi.expected_normal_z,
  });
  const insertBody = {
    poi_name: poi.poi_name,
    description: poi.description ?? null,
    category_type: primary,
    floor_id: poi.floor_id ? String(poi.floor_id) : null,
    pos_x: poi.pos_x,
    pos_y: poi.pos_y,
    pos_z: poi.pos_z,
    expected_pos_x: expectedX,
    expected_pos_y: expectedY,
    expected_pos_z: expectedZ,
    expected_normal_x: expectedNormal.x,
    expected_normal_y: expectedNormal.y,
    expected_normal_z: expectedNormal.z,
  };
  let inserted;
  try {
    inserted = await insertPoiRow(insertBody);
  } catch (err) {
    // Migration not applied yet — still place the POI; tilt kept in memory only.
    const msg = String(err?.message || err || '');
    if (/expected_normal/i.test(msg) || /column/i.test(msg)) {
      const { expected_normal_x, expected_normal_y, expected_normal_z, ...rest } = insertBody;
      void expected_normal_x;
      void expected_normal_y;
      void expected_normal_z;
      inserted = await insertPoiRow(rest);
    } else {
      throw err;
    }
  }
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const normalized = normalizePoiRow(row, categoryIds);
  // Keep tilt even if DB did not echo the normal columns yet.
  normalized.expected_normal_x = expectedNormal.x;
  normalized.expected_normal_y = expectedNormal.y;
  normalized.expected_normal_z = expectedNormal.z;
  if (normalized.id && categoryIds.length) {
    await replacePoiCategoryLinks(normalized.id, categoryIds);
  }
  poisData.push(normalized);
  sortPoisDataInPlace();

  const idx = poisData.findIndex((p) => p.id === normalized.id);
  // Instead of rebuilding the entire POI scene, which rasterizes a label canvas
  // texture for every existing POI, append this single POI incrementally — saves
  // the dominant cost in the add-click lag.
  if (idx >= 0) {
    addSinglePoiToScene(idx, poiGroupRef?.parent);
  }
  logUserActivity({
    action: 'created',
    entityType: 'poi',
    entityId: normalized.id,
    entityLabel: normalized.poi_name,
    xyz: normalized,
  });

  if (normalized.id) {
    const poiId = normalized.id;
    void buildPoiTranslationFields(poi.poi_name, 'en', { existing: normalized.name_langs })
      .then(async (nameFields) => {
        const descriptionFields = await buildPoiDescriptionTranslationFields(poi.description ?? '', 'en', {
          existing: normalized.description_langs,
        });
        await updatePoiRow(poiId, { ...nameFields, ...descriptionFields });
        const live = poisData.find((p) => String(p.id) === String(poiId));
        if (live) {
          live.name_langs = langMapFromTranslationFields(nameFields, 'poi_name', 'poi_names');
          live.description_langs = langMapFromTranslationFields(
            descriptionFields,
            'description',
            'descriptions',
          );
        }
      })
      .catch((err) => {
        console.warn('[poi] translations skipped after insert:', err);
      });
  }

  return idx >= 0 ? idx : poisData.length - 1;
}

export async function savePoiToDb(index, { translate = true, logAction } = {}) {
  const poi = poisData[index];
  if (!poi?.id) return;

  const categoryIds = Array.isArray(poi.category_ids)
    ? poi.category_ids.map((id) => String(id)).filter(Boolean)
    : poi.category_type
      ? [String(poi.category_type)]
      : [];
  poi.category_ids = categoryIds;
  poi.category_type = primaryCategoryId(categoryIds);

  const expectedNormal = normalizeExpectedNormal({
    x: poi.expected_normal_x,
    y: poi.expected_normal_y,
    z: poi.expected_normal_z,
  });
  const payload = {
    poi_name: poi.poi_name,
    description: poi.description ?? null,
    category_type: poi.category_type,
    floor_id: poi.floor_id ? String(poi.floor_id) : null,
    pos_x: poi.pos_x,
    pos_y: poi.pos_y,
    pos_z: poi.pos_z,
    // Never fall back to nav for expected once a click XYZ exists.
    expected_pos_x: poi.expected_pos_x != null ? Number(poi.expected_pos_x) : Number(poi.pos_x),
    expected_pos_y: poi.expected_pos_y != null ? Number(poi.expected_pos_y) : Number(poi.pos_y),
    expected_pos_z: poi.expected_pos_z != null ? Number(poi.expected_pos_z) : Number(poi.pos_z),
    expected_normal_x: expectedNormal.x,
    expected_normal_y: expectedNormal.y,
    expected_normal_z: expectedNormal.z,
  };

  if (translate) {
    try {
      const nameUnchanged =
        String(poi.name_langs?.en ?? '').trim() === String(poi.poi_name ?? '').trim();
      const descUnchanged =
        String(poi.description_langs?.en ?? '').trim() === String(poi.description ?? '').trim();
      const nameFields = await buildPoiTranslationFields(poi.poi_name, 'en', {
        existing: nameUnchanged ? poi.name_langs : null,
      });
      const descriptionFields = await buildPoiDescriptionTranslationFields(poi.description ?? '', 'en', {
        existing: descUnchanged ? poi.description_langs : null,
      });
      Object.assign(payload, nameFields, descriptionFields);
      poi.name_langs = langMapFromTranslationFields(nameFields, 'poi_name', 'poi_names');
      poi.description_langs = langMapFromTranslationFields(
        descriptionFields,
        'description',
        'descriptions',
      );
    } catch (err) {
      console.warn('[poi] translations skipped on save:', err);
    }
  }

  await updatePoiRow(poi.id, payload).catch(async (err) => {
    const msg = String(err?.message || err || '');
    if (/expected_normal/i.test(msg) || /column/i.test(msg)) {
      const {
        expected_normal_x: _nx,
        expected_normal_y: _ny,
        expected_normal_z: _nz,
        ...rest
      } = payload;
      void _nx;
      void _ny;
      void _nz;
      await updatePoiRow(poi.id, rest);
      return;
    }
    throw err;
  });
  poi.expected_normal_x = expectedNormal.x;
  poi.expected_normal_y = expectedNormal.y;
  poi.expected_normal_z = expectedNormal.z;
  await replacePoiCategoryLinks(poi.id, categoryIds);
  const action = logAction || (translate ? 'updated' : 'moved');
  logUserActivity({
    action,
    entityType: 'poi',
    entityId: poi.id,
    entityLabel: poi.poi_name,
    xyz: poi,
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} poi
 */
export function poiHasMissingNameTranslations(poi) {
  const source = String(poi?.poi_name ?? '').trim();
  if (!source || !poi?.id) return false;
  return missingTranslationLangs(poi.name_langs, source).length > 0;
}

/**
 * Translate only POI name languages that are empty or still English.
 * @param {(info: { current: number, total: number, label: string }) => void} [onProgress]
 */
export async function translateMissingPoiNames(onProgress) {
  const targets = poisData.filter((poi) => poiHasMissingNameTranslations(poi));
  let translated = 0;
  let stillMissing = 0;
  let filledLangs = 0;

  for (let i = 0; i < targets.length; i++) {
    const poi = targets[i];
    onProgress?.({ current: i + 1, total: targets.length, label: String(poi.poi_name || 'POI') });
    consumeTranslationFailures();
    try {
      const beforeMissing = missingTranslationLangs(poi.name_langs, poi.poi_name).length;
      const nameFields = await buildPoiTranslationFields(poi.poi_name, 'en', {
        existing: poi.name_langs,
      });
      const failed = consumeTranslationFailures();
      await updatePoiRow(poi.id, nameFields);
      poi.name_langs = langMapFromTranslationFields(nameFields, 'poi_name', 'poi_names');
      const afterMissing = missingTranslationLangs(poi.name_langs, poi.poi_name).length;
      filledLangs += Math.max(0, beforeMissing - afterMissing);
      if (afterMissing === 0) translated += 1;
      else stillMissing += 1;
      if (failed.length) {
        console.warn(`[poi] ${poi.poi_name}: still missing ${failed.join(', ')}`);
      }
    } catch (err) {
      console.warn('[poi] missing-name translate failed:', poi.poi_name, err);
      stillMissing += 1;
    }
    if (i + 1 < targets.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    attempted: targets.length,
    translated,
    stillMissing,
    filledLangs,
    skipped: Math.max(0, poisData.length - targets.length),
  };
}

export async function removePoiFromDb(index) {
  const poi = poisData[index];
  if (poi?.id) {
    await deletePoiRow(poi.id);
    logUserActivity({
      action: 'deleted',
      entityType: 'poi',
      entityId: poi.id,
      entityLabel: poi.poi_name,
    });
  }
}

export function deletePOI(index) {
  if (index < 0 || index >= poisData.length) return;

  const obj = poiObjects[index];
  if (obj && poiGroupRef) {
    poiGroupRef.remove(obj.mesh);
    poiGroupRef.remove(obj.label);
    if (obj.expectedMesh) poiGroupRef.remove(obj.expectedMesh);
    if (obj.mesh.geometry) obj.mesh.geometry.dispose();
    if (obj.mesh.material) obj.mesh.material.dispose();
    if (obj.expectedMesh?.geometry) obj.expectedMesh.geometry.dispose();
    if (obj.expectedMesh?.material) obj.expectedMesh.material.dispose();
    if (obj.label.material?.map) obj.label.material.map.dispose();
    if (obj.label.material) obj.label.material.dispose();
  }

  poiObjects.splice(index, 1);
  poisData.splice(index, 1);

  poiObjects.forEach((entry, i) => {
    entry.mesh.userData.poiIndex = i;
    if (entry.expectedMesh) entry.expectedMesh.userData.poiIndex = i;
  });
}

function createPOIObject(poi, index, mapPos, dotGeo, dotMat) {
  const mesh = new THREE.Mesh(dotGeo, dotMat);
  mesh.position.set(mapPos.x, mapPos.y, mapPos.z);
  mesh.userData.poiIndex = index;

  const label = createTextSprite(poi.poi_name);
  label.position.set(mapPos.x, mapPos.y + 0.85, mapPos.z);
  label.visible = index === hoveredPoiIndex || index === selectedPoiLabelIndex;
  return { mesh, label, expectedMesh: null };
}
