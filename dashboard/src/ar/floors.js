/**
 * In-memory floors for the active project (`navme_floors`).
 * Super admin manages via Floors panel; all roles read for POI dropdown / labels.
 */
import {
  fetchAllFloors,
  insertFloorRow,
  updateFloorRow,
  deleteFloorRow,
} from '../services/supabase.js';
import { buildFloorTranslationFields } from '../services/poi-translate.js';

/** @type {Array<{ id: string, name: string, slice_y: number, sort_order: number }>} */
export const floorsData = [];

/**
 * @param {Record<string, unknown>} row
 */
export function normalizeFloorRow(row) {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Floor').trim() || 'Floor',
    slice_y: Number(row.slice_y) || 0,
    sort_order: Number(row.sort_order ?? 0) || 0,
  };
}

export function sortFloorsInPlace() {
  floorsData.sort((a, b) => {
    const order = a.sort_order - b.sort_order;
    if (order !== 0) return order;
    if (a.slice_y !== b.slice_y) return a.slice_y - b.slice_y;
    return String(a.name).localeCompare(String(b.name));
  });
}

export async function hydrateFloorsFromSupabase() {
  floorsData.length = 0;
  try {
    const rows = await fetchAllFloors();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const n = normalizeFloorRow(row);
      if (n.id) floorsData.push(n);
    });
    sortFloorsInPlace();
  } catch (err) {
    console.error('[floors] Failed to load from Supabase:', err);
    throw err;
  }
}

/** @param {string | null | undefined} floorId */
export function getFloorById(floorId) {
  const id = String(floorId ?? '').trim();
  if (!id) return null;
  return floorsData.find((f) => String(f.id) === id) ?? null;
}

/** @param {string | null | undefined} floorId */
export function getFloorNameById(floorId) {
  return getFloorById(floorId)?.name ?? '';
}

/**
 * @param {{ name: string, slice_y: number, sort_order?: number }} input
 */
export async function addFloorWithDb(input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Floor name is required.');
  const slice_y = Number(input.slice_y);
  if (!Number.isFinite(slice_y)) throw new Error('Floor slice Y must be a number.');

  const translationFields = await buildFloorTranslationFields(name);
  const inserted = await insertFloorRow({
    name,
    slice_y,
    sort_order: Number(input.sort_order) || floorsData.length,
    ...translationFields,
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const normalized = normalizeFloorRow(row);
  floorsData.push(normalized);
  sortFloorsInPlace();
  return floorsData.findIndex((f) => f.id === normalized.id);
}

/**
 * @param {number} index
 * @param {{ name?: string, slice_y?: number, sort_order?: number, translate?: boolean }} patch
 */
export async function saveFloorToDb(index, patch = {}) {
  const floor = floorsData[index];
  if (!floor?.id) return;
  const translate = patch.translate !== false;
  const name = patch.name != null ? String(patch.name).trim() || floor.name : floor.name;
  const payload = {
    name,
    slice_y:
      patch.slice_y != null && Number.isFinite(Number(patch.slice_y))
        ? Number(patch.slice_y)
        : floor.slice_y,
    sort_order:
      patch.sort_order != null && Number.isFinite(Number(patch.sort_order))
        ? Number(patch.sort_order)
        : floor.sort_order,
  };
  if (translate) {
    Object.assign(payload, await buildFloorTranslationFields(name));
  }
  await updateFloorRow(floor.id, payload);
  floor.name = payload.name;
  floor.slice_y = payload.slice_y;
  floor.sort_order = payload.sort_order;
  sortFloorsInPlace();
}

/** @param {number} index */
export async function removeFloorFromDb(index) {
  const floor = floorsData[index];
  if (!floor?.id) return;
  await deleteFloorRow(floor.id);
  floorsData.splice(index, 1);
}
