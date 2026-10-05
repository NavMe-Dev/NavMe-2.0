/**
 * NavMe block zones — semi-transparent boxes from navme_blocks.
 */
import * as THREE from 'three';
import { getMultisetAnchor } from './scene.js';
import { fetchAllBlocks, deleteBlockRow, updateBlockRow, insertBlockRow } from '../services/supabase.js';
import { logUserActivity, rememberEntitiesXyz, xyzOf } from '../services/user-logs.js';
import { parseDbBool } from '../utils/parse-db-bool.js';

/** @type {Array<Record<string, unknown>>} */
export const blocksData = [];

export const BOX_HEIGHT = 0.2;
const COLOR_NORMAL = 0x2563eb;
const COLOR_BLOCKED = 0xdc2626;
const COLOR_SELECTED = 0xf59e0b;
const COLOR_STAIRS = 0x7c3aed;
const EDGE_NORMAL = 0x1d4ed8;
const EDGE_BLOCKED = 0xb91c1c;
const EDGE_STAIRS = 0x6d28d9;

export function isStairsZone(block) {
  return String(block?.zone_type ?? '').trim().toLowerCase() === 'stairs';
}

/** @type {THREE.Group | null} */
let blockGroupRef = null;
let blocksVisible = true;
/** @type {'all' | 'zones' | 'stairs'} */
let blockLayerFilter = 'all';
/** @type {string | number | null} */
let selectedBlockId = null;

function normalMaterial() {
  return new THREE.MeshBasicMaterial({
    color: COLOR_NORMAL,
    transparent: true,
    opacity: 0.55,
    depthWrite: true,
  });
}

function blockedMaterial() {
  return new THREE.MeshBasicMaterial({
    color: COLOR_BLOCKED,
    transparent: true,
    opacity: 0.55,
    depthWrite: true,
  });
}

function selectedMaterial(blocked) {
  return new THREE.MeshBasicMaterial({
    color: blocked ? COLOR_BLOCKED : COLOR_SELECTED,
    transparent: true,
    opacity: 0.72,
    depthWrite: true,
  });
}

function stairsMaterial(isSelected) {
  return new THREE.MeshBasicMaterial({
    color: isSelected ? 0xa78bfa : COLOR_STAIRS,
    transparent: true,
    opacity: isSelected ? 0.72 : 0.55,
    depthWrite: true,
  });
}

function materialForRow(row, isSelected) {
  if (isStairsZone(row)) return stairsMaterial(isSelected);
  const blocked = parseDbBool(row.is_blocked, false);
  if (isSelected) return selectedMaterial(blocked);
  return blocked ? blockedMaterial() : normalMaterial();
}

function edgeColorForRow(row, isSelected) {
  if (isStairsZone(row)) return isSelected ? 0xc4b5fd : EDGE_STAIRS;
  if (isSelected) return 0xd97706;
  return parseDbBool(row.is_blocked, false) ? EDGE_BLOCKED : EDGE_NORMAL;
}

function attachBlockEdges(mesh, row, isSelected) {
  const old = mesh.getObjectByName('BlockEdges');
  if (old) {
    old.geometry?.dispose();
    old.material?.dispose();
    mesh.remove(old);
  }
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: edgeColorForRow(row, isSelected), depthTest: true }),
  );
  edges.name = 'BlockEdges';
  mesh.add(edges);
}

function applyBlockHighlights() {
  for (const mesh of getBlockMeshes()) {
    const row = blocksData.find((b) => b.id === mesh.userData.blockId);
    if (!row) continue;
    const isSelected = mesh.userData.blockId === selectedBlockId;
    mesh.material = materialForRow(row, isSelected);
  }
}

export function setSelectedBlockId(id) {
  selectedBlockId = id ?? null;
  applyBlockHighlights();
}

export function getSelectedBlockId() {
  return selectedBlockId;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => m.dispose());
    }
  });
}

function buildBlockMesh(row) {
  const w = Math.max(Number(row.width ?? 1), 0.1);
  const d = Math.max(Number(row.depth ?? 1), 0.1);
  const isSelected = row.id === selectedBlockId;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, BOX_HEIGHT, d),
    materialForRow(row, isSelected),
  );
  mesh.position.set(
    Number(row.pos_x ?? 0),
    Number(row.pos_y ?? 0) + BOX_HEIGHT / 2,
    Number(row.pos_z ?? 0),
  );
  mesh.userData.blockId = row.id;
  mesh.userData.zoneName = row.zone_name ?? row.label ?? 'Block';
  mesh.userData.baseWidth = w;
  mesh.userData.baseDepth = d;
  attachBlockEdges(mesh, row, isSelected);
  return mesh;
}

/** @returns {THREE.Mesh[]} */
export function getBlockMeshes() {
  if (!blockGroupRef) return [];
  return blockGroupRef.children.filter((c) => c.isMesh);
}

export function getBlockMeshById(id) {
  return getBlockMeshes().find((m) => m.userData.blockId === id) ?? null;
}

export function syncBlockMeshFromRow(mesh, row) {
  if (!mesh) return;
  const w = Math.max(Number(row.width ?? 1), 0.1);
  const d = Math.max(Number(row.depth ?? 1), 0.1);
  mesh.geometry.dispose();
  mesh.geometry = new THREE.BoxGeometry(w, BOX_HEIGHT, d);
  mesh.position.set(
    Number(row.pos_x ?? 0),
    Number(row.pos_y ?? 0) + BOX_HEIGHT / 2,
    Number(row.pos_z ?? 0),
  );
  mesh.scale.set(1, 1, 1);
  mesh.userData.baseWidth = w;
  mesh.userData.baseDepth = d;
  const isSelected = row.id === selectedBlockId;
  mesh.material = materialForRow(row, isSelected);
  attachBlockEdges(mesh, row, isSelected);
}

/** Update one block mesh in place (keeps gizmo attached). */
export function updateBlockInScene(id, fields) {
  const idx = blocksData.findIndex((b) => b.id === id);
  if (idx >= 0) {
    blocksData[idx] = { ...blocksData[idx], ...fields };
  }
  const mesh = getBlockMeshById(id);
  const row = blocksData[idx];
  if (mesh && row) {
    syncBlockMeshFromRow(mesh, row);
    applyBlockHighlights();
    return mesh;
  }
  refreshBlockGroup(getMultisetAnchor());
  return getBlockMeshById(id);
}

/** Read transform back into navme_blocks shape fields. */
export function blockFieldsFromMesh(mesh) {
  if (!mesh) return null;
  const baseW = mesh.userData.baseWidth ?? 1;
  const baseD = mesh.userData.baseDepth ?? 1;
  return {
    pos_x: mesh.position.x,
    pos_y: mesh.position.y - BOX_HEIGHT / 2,
    pos_z: mesh.position.z,
    width: Math.max(baseW * mesh.scale.x, 0.1),
    depth: Math.max(baseD * mesh.scale.z, 0.1),
  };
}

/**
 * @param {THREE.Group | null} anchor
 */
export function refreshBlockGroup(anchor) {
  const parent = anchor ?? getMultisetAnchor();
  if (!parent) return;

  if (blockGroupRef) {
    parent.remove(blockGroupRef);
    disposeGroup(blockGroupRef);
    blockGroupRef = null;
  }

  const group = new THREE.Group();
  group.name = 'NavmeBlocks';

  for (const row of blocksData) {
    group.add(buildBlockMesh(row));
  }

  group.visible = blocksVisible;
  parent.add(group);
  blockGroupRef = group;
  applyBlockHighlights();
  applyBlockVisibilityFilter();
}

function applyBlockVisibilityFilter() {
  if (!blockGroupRef) return;
  for (const mesh of getBlockMeshes()) {
    const row = blocksData.find((b) => b.id === mesh.userData.blockId);
    if (!row) continue;
    const isStairs = isStairsZone(row);
    let show = blocksVisible;
    if (show && blockLayerFilter === 'zones') show = !isStairs;
    if (show && blockLayerFilter === 'stairs') show = isStairs;
    mesh.visible = show;
  }
}

/**
 * @param {'all' | 'zones' | 'stairs'} filter
 */
export function setBlockLayerFilter(filter) {
  blockLayerFilter = filter === 'zones' || filter === 'stairs' ? filter : 'all';
  applyBlockVisibilityFilter();
}

export function normalizeBlockRow(row) {
  const legacyInactive = !parseDbBool(row.is_active, true);
  const blocked = legacyInactive ? false : parseDbBool(row.is_blocked, false);
  const stairs = isStairsZone(row);
  return {
    ...row,
    zone_type: stairs ? 'stairs' : row.zone_type ?? 'zone',
    is_active: true,
    is_blocked: stairs ? false : blocked,
  };
}

export async function hydrateBlocksFromSupabase() {
  const rows = await fetchAllBlocks();
  blocksData.length = 0;
  blocksData.push(...(Array.isArray(rows) ? rows : []).map(normalizeBlockRow));
  rememberEntitiesXyz('block', blocksData.filter((b) => !isStairsZone(b)));
  rememberEntitiesXyz('stairs', blocksData.filter((b) => isStairsZone(b)));
  return blocksData.length;
}

export function setBlocksVisible(visible) {
  blocksVisible = Boolean(visible);
  if (blockGroupRef) {
    blockGroupRef.visible = blocksVisible;
    if (blocksVisible) applyBlockVisibilityFilter();
  }
}

export function getBlocksVisible() {
  return blocksVisible;
}

export function getBlockGroup() {
  return blockGroupRef;
}

function blockEntityLabel(row, stairs) {
  const name = String(row?.zone_name || row?.label || '').trim();
  if (name) return name;
  return stairs ? 'Stairs' : 'Zone';
}

function blockLogAction(data) {
  if (!data || typeof data !== 'object') return 'updated';
  const keys = Object.keys(data);
  const posLike = new Set(['pos_x', 'pos_y', 'pos_z', 'width', 'depth', 'height', 'rot_y']);
  if (keys.length && keys.every((k) => posLike.has(k))) return 'moved';
  return 'updated';
}

export async function removeBlockFromDb(id) {
  const existing = blocksData.find((b) => String(b.id) === String(id));
  const stairs = isStairsZone(existing);
  await deleteBlockRow(id);
  const idx = blocksData.findIndex((b) => b.id === id);
  if (idx >= 0) blocksData.splice(idx, 1);
  refreshBlockGroup(getMultisetAnchor());
  logUserActivity({
    action: 'deleted',
    entityType: stairs ? 'stairs' : 'block',
    entityId: id,
    entityLabel: blockEntityLabel(existing, stairs),
  });
}

export async function saveBlockToDb(id, data) {
  const idx = blocksData.findIndex((b) => b.id === id);
  const existing = idx >= 0 ? blocksData[idx] : null;
  const payload =
    isStairsZone(existing) || isStairsZone(data)
      ? { ...data, zone_type: 'stairs', is_blocked: false, is_active: true }
      : data;
  const row = await updateBlockRow(id, payload);
  const updated = Array.isArray(row) ? row[0] : row;
  if (idx >= 0 && updated) blocksData[idx] = normalizeBlockRow({ ...blocksData[idx], ...updated });
  updateBlockInScene(id, updated || payload);
  const merged = updated || { ...existing, ...payload };
  const stairs = isStairsZone(merged);
  logUserActivity({
    action: blockLogAction(data),
    entityType: stairs ? 'stairs' : 'block',
    entityId: id,
    entityLabel: blockEntityLabel(merged, stairs),
    xyz: merged,
    details: existing ? { from: xyzOf(existing) } : null,
  });
  return updated;
}

export async function addBlockWithDb(body) {
  const row = await insertBlockRow(body);
  const inserted = Array.isArray(row) ? row[0] : row;
  if (inserted) blocksData.push(normalizeBlockRow(inserted));
  refreshBlockGroup(getMultisetAnchor());
  if (inserted) {
    const stairs = isStairsZone(inserted) || isStairsZone(body);
    logUserActivity({
      action: 'created',
      entityType: stairs ? 'stairs' : 'block',
      entityId: inserted.id,
      entityLabel: blockEntityLabel({ ...body, ...inserted }, stairs),
      xyz: inserted,
    });
  }
  return inserted;
}
