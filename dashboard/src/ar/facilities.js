import * as THREE from 'three';
import {
  fetchAllFacilities,
  insertFacilityRow,
  updateFacilityRow,
  deleteFacilityRow,
} from '../services/supabase.js';
import { logUserActivity, rememberEntitiesXyz } from '../services/user-logs.js';
import { buildFacilityTranslationFields } from '../services/poi-translate.js';
import { getPoiType } from '../config/poi-session.js';

/** Default Lucide key when a facility has no icon_key. */
export const DEFAULT_FACILITY_ICON_KEY = 'map-pin';

/** In-memory facilities synced with `navme_facilities`. */
export const facilitiesData = [];

export function normalizeFacilityRow(row) {
  return {
    id: row.id,
    facility_name: row.facility_name ?? row.name ?? 'Amenity',
    facility_category: row.facility_category ?? '',
    facility_group: row.facility_group ?? '',
    floor_name: row.floor_name ?? '',
    icon_key: String(row.icon_key ?? DEFAULT_FACILITY_ICON_KEY).trim() || DEFAULT_FACILITY_ICON_KEY,
    poi_type: row.poi_type ?? '',
    pos_x: Number(row.pos_x) || 0,
    pos_y: Number(row.pos_y) || 0,
    pos_z: Number(row.pos_z) || 0,
    is_active: row.is_active !== false,
  };
}

export function sortFacilitiesDataInPlace() {
  facilitiesData.sort((a, b) => {
    const cat = String(a.facility_category || '').localeCompare(String(b.facility_category || ''));
    if (cat !== 0) return cat;
    return String(a.facility_name).localeCompare(String(b.facility_name));
  });
}

export async function hydrateFacilitiesFromSupabase() {
  facilitiesData.length = 0;
  try {
    const rows = await fetchAllFacilities();
    rows.forEach((row) => facilitiesData.push(normalizeFacilityRow(row)));
    sortFacilitiesDataInPlace();
    rememberEntitiesXyz('facility', facilitiesData);
    console.info(
      `[facilities] Loaded ${facilitiesData.length} for poi_type=${getPoiType() || '(none)'}`,
    );
  } catch (err) {
    console.error('[facilities] Failed to load from Supabase:', err);
    throw err;
  }
}

export function refreshFacilityGroup(container) {
  if (!container) return;
  addFacilitiesToScene(container);
}

const facilityObjects = [];
let facilityGroupRef = null;
let facilityGroupVisible = true;

function createTextSprite(message) {
  const fontface = 'Arial';
  const fontsize = 20;
  const padding = 5;
  const borderRadius = 6;

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');

  context.font = `Bold ${fontsize}px ${fontface}`;
  const metrics = context.measureText(message);
  const textWidth = metrics.width;

  canvas.width = textWidth + padding * 2;
  canvas.height = fontsize * 1.4 + padding * 2;

  context.font = `Bold ${fontsize}px ${fontface}`;
  context.textBaseline = 'middle';
  context.textAlign = 'center';

  context.fillStyle = 'rgba(10, 10, 20, 0.8)';
  context.beginPath();
  context.roundRect(0, 0, canvas.width, canvas.height, borderRadius);
  context.fill();

  context.lineWidth = 1.5;
  context.strokeStyle = 'rgba(56, 189, 248, 0.65)';
  context.stroke();

  context.fillStyle = 'rgba(186, 230, 253, 1.0)';
  context.fillText(message, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMaterial);

  const scaleObj = 0.62;
  sprite.scale.set(scaleObj * (canvas.width / canvas.height), scaleObj, 1);

  return sprite;
}

export function addFacilitiesToScene(container) {
  const existing = container.getObjectByName('FacilityGroup');
  if (existing) container.remove(existing);

  facilityObjects.length = 0;

  const group = new THREE.Group();
  group.name = 'FacilityGroup';
  facilityGroupRef = group;

  const dotMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });

  facilitiesData.forEach((facility, index) => {
    const dotGeo = new THREE.SphereGeometry(0.18, 12, 12);
    const obj = createFacilityObject(facility, index, dotGeo, dotMat);
    if (facility.is_active === false) {
      obj.mesh.visible = false;
      obj.label.visible = false;
    }
    group.add(obj.mesh);
    group.add(obj.label);
    facilityObjects.push(obj);
  });

  group.visible = facilityGroupVisible;
  container.add(group);
}

export function setFacilityGroupVisible(visible) {
  facilityGroupVisible = Boolean(visible);
  if (facilityGroupRef) facilityGroupRef.visible = facilityGroupVisible;
}

export function getFacilityObjects() {
  return facilityObjects;
}

export function updateFacilityPosition(index, x, y, z) {
  const obj = facilityObjects[index];
  if (!obj) return;
  obj.mesh.position.set(x, y, z);
  obj.label.position.set(x, y + 0.85, z);
  facilitiesData[index].pos_x = x;
  facilitiesData[index].pos_y = y;
  facilitiesData[index].pos_z = z;
}

export function updateFacilityName(index, name) {
  const obj = facilityObjects[index];
  const facility = facilitiesData[index];
  if (!obj || !facility) return;
  facility.facility_name = name;

  const oldMaterial = obj.label.material;
  const oldMap = oldMaterial.map;
  const newLabel = createTextSprite(name);
  newLabel.position.copy(obj.label.position);
  newLabel.visible = obj.label.visible;

  if (facilityGroupRef) facilityGroupRef.remove(obj.label);
  obj.label = newLabel;
  if (facilityGroupRef) facilityGroupRef.add(newLabel);

  if (oldMap) oldMap.dispose();
  oldMaterial.dispose();
}

export async function addFacilityWithDb(facility) {
  const translationFields = await buildFacilityTranslationFields(facility);
  const inserted = await insertFacilityRow({
    facility_name: facility.facility_name,
    facility_category: facility.facility_category || 'general',
    facility_group: facility.facility_group || '',
    floor_name: facility.floor_name || '',
    icon_key: facility.icon_key || DEFAULT_FACILITY_ICON_KEY,
    pos_x: facility.pos_x,
    pos_y: facility.pos_y,
    pos_z: facility.pos_z,
    is_active: facility.is_active ?? true,
    ...translationFields,
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const normalized = normalizeFacilityRow(row);
  facilitiesData.push(normalized);
  sortFacilitiesDataInPlace();

  const idx = facilitiesData.findIndex((f) => f.id === normalized.id);
  if (facilityGroupRef?.parent) {
    addFacilitiesToScene(facilityGroupRef.parent);
  }
  logUserActivity({
    action: 'created',
    entityType: 'facility',
    entityId: normalized.id,
    entityLabel: normalized.facility_name,
    xyz: normalized,
  });
  return idx >= 0 ? idx : facilitiesData.length - 1;
}

/**
 * @param {number} index
 * @param {{ translate?: boolean, logAction?: string }} [opts]
 */
export async function saveFacilityToDb(index, { translate = true, logAction } = {}) {
  const facility = facilitiesData[index];
  if (!facility?.id) return;

  const payload = {
    facility_name: facility.facility_name,
    facility_category: facility.facility_category,
    facility_group: facility.facility_group,
    floor_name: facility.floor_name,
    icon_key: facility.icon_key || DEFAULT_FACILITY_ICON_KEY,
    pos_x: facility.pos_x,
    pos_y: facility.pos_y,
    pos_z: facility.pos_z,
    is_active: facility.is_active,
  };

  if (translate) {
    Object.assign(payload, await buildFacilityTranslationFields(facility));
  }

  await updateFacilityRow(facility.id, payload);
  const action = logAction || (translate ? 'updated' : 'moved');
  logUserActivity({
    action,
    entityType: 'facility',
    entityId: facility.id,
    entityLabel: facility.facility_name,
    xyz: facility,
  });
}

export async function removeFacilityFromDb(index) {
  const facility = facilitiesData[index];
  if (facility?.id) {
    await deleteFacilityRow(facility.id);
    logUserActivity({
      action: 'deleted',
      entityType: 'facility',
      entityId: facility.id,
      entityLabel: facility.facility_name,
    });
  }
}

export function deleteFacility(index) {
  if (index < 0 || index >= facilitiesData.length) return;

  const obj = facilityObjects[index];
  if (obj && facilityGroupRef) {
    facilityGroupRef.remove(obj.mesh);
    facilityGroupRef.remove(obj.label);
    if (obj.mesh.geometry) obj.mesh.geometry.dispose();
    if (obj.mesh.material) obj.mesh.material.dispose();
    if (obj.label.material?.map) obj.label.material.map.dispose();
    if (obj.label.material) obj.label.material.dispose();
  }

  facilityObjects.splice(index, 1);
  facilitiesData.splice(index, 1);

  facilityObjects.forEach((entry, i) => {
    entry.mesh.userData.facilityIndex = i;
  });
}

function createFacilityObject(facility, index, dotGeo, dotMat) {
  const mesh = new THREE.Mesh(dotGeo, dotMat);
  mesh.position.set(facility.pos_x, facility.pos_y, facility.pos_z);
  mesh.userData.facilityIndex = index;

  const label = createTextSprite(facility.facility_name);
  label.position.set(facility.pos_x, facility.pos_y + 0.85, facility.pos_z);
  return { mesh, label };
}
