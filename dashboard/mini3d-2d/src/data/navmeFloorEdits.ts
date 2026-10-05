import { getSupabase } from './supabaseClient';
import { NAVME_TABLES } from './navmeTables';
import {
  buildFloorEditPayload,
  parseFloorEditPayload,
  type NavmeFloorEditPayload,
  type NavmeFloorEditRow,
} from './floorEditPayload';
import type { Floor2DMap, FloorBlock, FloorLevel } from '../floor2d';

function normMapCode(code: string): string {
  return code.trim().toUpperCase();
}

function normPoiType(poiType: string): string {
  return poiType.trim();
}

function saveErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('statement timeout')) {
    return 'Save timed out on the database — hard-refresh the page and try again (walk grids are now compressed).';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
    return 'Network error while saving — check your connection and try again.';
  }
  return msg;
}

export async function fetchNavmeFloorEdit(
  poiType: string,
  mapCode: string,
): Promise<NavmeFloorEditRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const wantMap = normMapCode(mapCode);
  const { data, error } = await sb
    .from(NAVME_TABLES.floorEdits)
    .select('poi_type, map_code, floor_slice_y, floor_data, updated_at')
    .eq('poi_type', normPoiType(poiType))
    .eq('map_code', wantMap)
    .maybeSingle();
  if (error) {
    console.warn('[navmeFloorEdits] fetch:', error.message);
    return null;
  }
  const row = data as NavmeFloorEditRow | null;
  if (!row) return null;
  const payload = parseFloorEditPayload(row.floor_data);
  if (!payload) {
    console.warn('[navmeFloorEdits] Invalid floor_data JSON for', normPoiType(poiType), wantMap);
    return null;
  }
  return { ...row, floor_data: payload };
}

async function upsertFloorEditRow(row: {
  poi_type: string;
  map_code: string;
  floor_slice_y: number;
  floor_data: NavmeFloorEditPayload;
  updated_at: string;
}): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: 'Supabase not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)' };
  }

  const { error: rpcError } = await sb.rpc('save_navme_floor_edit', {
    p_poi_type: row.poi_type,
    p_map_code: row.map_code,
    p_floor_slice_y: row.floor_slice_y,
    p_floor_data: row.floor_data,
  });

  if (!rpcError) return { ok: true };

  const rpcMissing =
    rpcError.code === '42883' ||
    rpcError.message.includes('save_navme_floor_edit') ||
    rpcError.message.includes('Could not find the function');

  if (!rpcMissing) {
    return { ok: false, error: rpcError.message };
  }

  console.warn('[navmeFloorEdits] RPC unavailable, falling back to direct upsert');
  const { error } = await sb.from(NAVME_TABLES.floorEdits).upsert(row, {
    onConflict: 'poi_type,map_code',
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function saveNavmeFloorEdit(
  poiType: string,
  mapCode: string,
  sliceY: number,
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  floors: FloorLevel[],
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: 'Supabase not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)' };
  }

  const payload = buildFloorEditPayload(map, walk, objects, zones, floors, sliceY, normMapCode(mapCode));
  const row = {
    poi_type: normPoiType(poiType),
    map_code: normMapCode(mapCode),
    floor_slice_y: sliceY,
    floor_data: payload,
    updated_at: new Date().toISOString(),
  };
  const payloadKb = (JSON.stringify(row).length / 1024).toFixed(1);
  console.log(`[navmeFloorEdits] Save ~${payloadKb} KB for ${row.poi_type} / ${row.map_code}`);

  try {
    const result = await upsertFloorEditRow(row);
    if (!result.ok) {
      console.error('[navmeFloorEdits] save:', result.error);
      return { ok: false, error: saveErrorMessage(result.error) };
    }
  } catch (err) {
    const message = saveErrorMessage(err);
    console.error('[navmeFloorEdits] save:', message, err);
    return { ok: false, error: message };
  }

  console.log(
    `[navmeFloorEdits] Saved ${payload.objects.length} object(s), ${payload.zones.length} zone(s), ${payload.floors.length} floor(s) for ${row.poi_type} / ${row.map_code}`,
  );
  return { ok: true };
}

export type { NavmeFloorEditPayload, NavmeFloorEditRow };
