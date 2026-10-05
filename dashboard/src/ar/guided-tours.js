/**
 * In-memory guided tours for the active project (`navme_guided_tours` + stops).
 */
import { fetchAllGuidedTours, fetchGuidedTourStops } from '../services/supabase.js';
import { poisData, poiDisplayName } from './pois.js';

/** @type {Array<Record<string, unknown>>} */
export const guidedToursData = [];

const PACE = {
  relaxed: { speed: 40, dwell: 4 },
  standard: { speed: 55, dwell: 3 },
  express: { speed: 70, dwell: 2 },
};

/**
 * @param {Array<{ pos_x?: number, pos_y?: number, pos_z?: number }>} stops
 * @param {'relaxed' | 'standard' | 'express'} [pace]
 */
export function computeTourStats(stops, pace = 'standard') {
  const cfg = PACE[pace] || PACE.standard;
  let dist = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const dx = Number(b.pos_x) - Number(a.pos_x);
    const dy = Number(b.pos_y) - Number(a.pos_y);
    const dz = Number(b.pos_z) - Number(a.pos_z);
    dist += Math.hypot(dx, dy, dz);
  }
  const walk_min = dist / cfg.speed;
  const expected_duration_min = Math.max(1, Math.round(walk_min + cfg.dwell * stops.length));
  const battery_pct = Math.min(100, Math.max(1, Math.round(expected_duration_min / 3)));
  return { approx_distance_m: dist, expected_duration_min, walk_min, battery_pct };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Array<Record<string, unknown>>} [stops]
 */
export function normalizeTourRow(row, stops = []) {
  const paceRaw = String(row.pace ?? 'standard');
  const pace = paceRaw === 'relaxed' || paceRaw === 'express' ? paceRaw : 'standard';
  return {
    id: String(row.id ?? ''),
    organization_id: row.organization_id ?? null,
    poi_type: String(row.poi_type ?? ''),
    name: String(row.name ?? 'Tour').trim() || 'Tour',
    pace,
    icon_key: String(row.icon_key ?? 'route').trim() || 'route',
    is_active: row.is_active !== false,
    sort_order: Number(row.sort_order ?? 0) || 0,
    approx_distance_m:
      row.approx_distance_m == null ? null : Number(row.approx_distance_m),
    expected_duration_min:
      row.expected_duration_min == null ? null : Number(row.expected_duration_min),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    stops: Array.isArray(stops) ? stops : [],
  };
}

/**
 * @param {Record<string, unknown>} stopRow
 */
function joinStopWithPoi(stopRow) {
  const poiId = String(stopRow.poi_id ?? '');
  const stop = {
    poi_id: poiId,
    sort_order: Number(stopRow.sort_order ?? 0) || 0,
  };
  const poi = poisData.find((p) => String(p.id) === poiId);
  if (poi) {
    stop.poi_name = poiDisplayName(poi) || 'POI';
    stop.pos_x = Number(poi.pos_x) || 0;
    stop.pos_y = Number(poi.pos_y) || 0;
    stop.pos_z = Number(poi.pos_z) || 0;
  }
  return stop;
}

export function sortGuidedToursInPlace() {
  guidedToursData.sort((a, b) => {
    const order = a.sort_order - b.sort_order;
    if (order !== 0) return order;
    return String(a.name).localeCompare(String(b.name));
  });
}

export async function hydrateGuidedToursFromSupabase() {
  guidedToursData.length = 0;
  try {
    const tourRows = await fetchAllGuidedTours();
    const tours = Array.isArray(tourRows) ? tourRows : [];
    if (!tours.length) return;

    const tourIds = tours.map((row) => String(row.id ?? '')).filter(Boolean);
    const stopRows = await fetchGuidedTourStops(tourIds);
    const stopsByTour = new Map();

    for (const row of Array.isArray(stopRows) ? stopRows : []) {
      const tourId = String(row.tour_id ?? '');
      if (!tourId) continue;
      if (!stopsByTour.has(tourId)) stopsByTour.set(tourId, []);
      stopsByTour.get(tourId).push(joinStopWithPoi(row));
    }

    for (const stops of stopsByTour.values()) {
      stops.sort((a, b) => a.sort_order - b.sort_order);
    }

    for (const row of tours) {
      const id = String(row.id ?? '');
      const stops = stopsByTour.get(id) ?? [];
      const normalized = normalizeTourRow(row, stops);
      if (normalized.id) guidedToursData.push(normalized);
    }
    sortGuidedToursInPlace();
  } catch (err) {
    console.error('[guided-tours] Failed to load from Supabase:', err);
    throw err;
  }
}
