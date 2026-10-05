/**
 * Staircases for the active project, loaded from `navme_stair_chains`.
 *
 * Each chain is an ordered run of Matterport scan-point numbers (Sweep.data
 * indices), **lowest step first**, listing every scan point on the flight
 * including its landings.
 *
 * Why declared rather than inferred: the neighbour graph links the bottom of a
 * flight straight to points part-way up and to the landing above, so a
 * shortest-path search takes a route that skips steps. Geometry alone cannot
 * always settle it either — two points at the top of a flight can differ in
 * height by a centimetre, which is not enough to order them. A super admin
 * declares the steps and the router walks exactly those.
 *
 * Floors here are NavMe floors (`navme_floors`), the same ones the destination
 * search shows — never Matterport's own floor grouping.
 */
import {
  fetchAllStairChains,
  insertStairChainRow,
  updateStairChainRow,
  deleteStairChainRow,
} from '../services/supabase.js';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   from_floor_id: string | null,
 *   to_floor_id: string | null,
 *   sweep_numbers: number[],
 *   sort_order: number,
 * }} StairChain
 */

/** @type {StairChain[]} */
export const stairChainsData = [];

function normalizeRow(row) {
  const nums = Array.isArray(row?.sweep_numbers) ? row.sweep_numbers : [];
  return {
    id: String(row?.id ?? ''),
    name: String(row?.name ?? 'Stairs').trim() || 'Stairs',
    from_floor_id: row?.from_floor_id ? String(row.from_floor_id) : null,
    to_floor_id: row?.to_floor_id ? String(row.to_floor_id) : null,
    sweep_numbers: nums.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0),
    sort_order: Number(row?.sort_order ?? 0) || 0,
  };
}

export async function hydrateStairChainsFromSupabase() {
  stairChainsData.length = 0;
  try {
    const rows = await fetchAllStairChains();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const n = normalizeRow(row);
      if (n.id && n.sweep_numbers.length >= 2) stairChainsData.push(n);
    });
    stairChainsData.sort((a, b) => a.sort_order - b.sort_order);
  } catch (err) {
    // A project without the table or without chains simply has none.
    console.warn('[stair-chains] load failed', err);
  }
  return stairChainsData;
}

/** @returns {number[][]} just the ordered scan numbers, for the router. */
export function getStairChains() {
  return stairChainsData
    .filter((c) => c.sweep_numbers.length >= 2)
    .map((c) => c.sweep_numbers.slice());
}

/** @param {{name:string, from_floor_id?:string|null, to_floor_id?:string|null, sweep_numbers:number[]}} input */
export async function addStairChain(input) {
  const row = await insertStairChainRow({
    name: String(input.name ?? 'Stairs').trim() || 'Stairs',
    from_floor_id: input.from_floor_id ?? null,
    to_floor_id: input.to_floor_id ?? null,
    sweep_numbers: input.sweep_numbers ?? [],
    sort_order: stairChainsData.length,
  });
  const created = Array.isArray(row) ? row[0] : row;
  const n = normalizeRow(created);
  if (n.id) stairChainsData.push(n);
  return n;
}

export async function saveStairChain(id, patch) {
  await updateStairChainRow(id, patch);
  const i = stairChainsData.findIndex((c) => c.id === id);
  if (i >= 0) stairChainsData[i] = { ...stairChainsData[i], ...normalizeRow({ ...stairChainsData[i], ...patch, id }) };
}

export async function removeStairChain(id) {
  await deleteStairChainRow(id);
  const i = stairChainsData.findIndex((c) => c.id === id);
  if (i >= 0) stairChainsData.splice(i, 1);
}
