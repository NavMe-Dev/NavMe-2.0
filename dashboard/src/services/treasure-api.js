/**
 * Treasure Hunt REST helpers — `treasure_*` tables scoped by session `poi_type`.
 * Isolated from navme_* CRUD.
 */

import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from './supabase.js';
import { getPoiType } from '../config/poi-session.js';
import { parseJsonResponse } from '../utils/parse-json-response.js';
import { logUserActivity } from './user-logs.js';

function ensureConfig() {
  if (!isSupabaseConfigured()) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.');
  }
}

function headers() {
  const key = getSupabaseAnonKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function query(path) {
  ensureConfig();
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Database ${res.status}: ${t || res.statusText}`);
  }
  const data = await parseJsonResponse(res, 'Database');
  return data == null ? [] : data;
}

async function mutate(method, path, body = null) {
  ensureConfig();
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, {
    method,
    headers: { ...headers(), Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Database ${method} ${res.status}: ${text || res.statusText}`);
  }
  if (method === 'DELETE') return null;
  return parseJsonResponse(res, 'Database');
}

function requirePoiType() {
  const poiType = String(getPoiType() ?? '').trim();
  if (!poiType) throw new Error('Sign in to a project before managing treasures.');
  return poiType;
}

function poiFilter() {
  return `poi_type=eq.${encodeURIComponent(requirePoiType())}`;
}

function one(row) {
  return Array.isArray(row) ? row[0] : row;
}

function treasurePatchAction(data) {
  if (!data || typeof data !== 'object') return 'updated';
  const keys = Object.keys(data).filter((k) => k !== 'updated_at');
  if (!keys.length) return 'updated';
  const posKeys = keys.filter(
    (k) =>
      k.startsWith('pos_') ||
      k.startsWith('dest_') ||
      k === 'hint_x' ||
      k === 'hint_y' ||
      k === 'hint_z',
  );
  const scaleKeys = keys.filter((k) => k.startsWith('scale') || k === 'width' || k === 'height');
  if (scaleKeys.length && scaleKeys.length === keys.length) return 'scaled';
  if (posKeys.length && posKeys.length === keys.length) return 'moved';
  if (
    scaleKeys.length &&
    posKeys.length &&
    scaleKeys.length + posKeys.length === keys.length
  ) {
    return 'moved';
  }
  return 'updated';
}

function logTreasure(action, kind, row, fallbackLabel, entityId) {
  const label =
    String(row?.name || row?.title || row?.destination_name || fallbackLabel || kind).trim() || kind;
  logUserActivity({
    action,
    entityType: 'treasure',
    entityId: entityId ?? row?.id ?? null,
    entityLabel: `${kind}: ${label}`,
    xyz: row,
    scale: row,
  });
}

// ——— Levels ———

export function fetchTreasureLevels() {
  return query(`treasure_levels?select=*&${poiFilter()}&order=level_number.asc`);
}

export function insertTreasureLevel(body) {
  const poi_type = requirePoiType();
  return mutate('POST', 'treasure_levels', {
    poi_type,
    level_number: Number(body.level_number) || 1,
    title: String(body.title ?? '').trim() || `Level ${body.level_number || 1}`,
    treasures_required: Number(body.treasures_required) || 1,
    sort_order: Number(body.sort_order ?? body.level_number) || 1,
    is_active: body.is_active !== false,
  }).then((row) => {
    const inserted = one(row);
    logTreasure('created', 'Level', inserted, body.title);
    return inserted;
  });
}

export function updateTreasureLevel(id, data) {
  return mutate('PATCH', `treasure_levels?id=eq.${id}&${poiFilter()}`, {
    ...data,
    updated_at: new Date().toISOString(),
  }).then((row) => {
    const updated = one(row);
    logTreasure(treasurePatchAction(data), 'Level', updated || { id, ...data }, data.title, id);
    return updated;
  });
}

export function deleteTreasureLevel(id) {
  return mutate('DELETE', `treasure_levels?id=eq.${id}&${poiFilter()}`).then((row) => {
    logTreasure('deleted', 'Level', { id }, 'Level', id);
    return row;
  });
}

// ——— Items (treasures) ———

export function fetchTreasureItems() {
  return query(`treasure_items?select=*&${poiFilter()}&order=sort_order.asc`);
}

export function insertTreasureItem(body) {
  const poi_type = requirePoiType();
  return mutate('POST', 'treasure_items', {
    poi_type,
    level_id: body.level_id,
    name: String(body.name ?? '').trim() || 'Treasure',
    media_type: body.media_type === 'model' ? 'model' : 'image',
    media_url: body.media_url,
    pos_x: Number(body.pos_x) || 0,
    pos_y: Number(body.pos_y) || 0,
    pos_z: Number(body.pos_z) || 0,
    rot_x: Number(body.rot_x) || 0,
    rot_y: Number(body.rot_y) || 0,
    rot_z: Number(body.rot_z) || 0,
    scale: Number(body.scale) || 0.35,
    collect_radius_m: body.collect_radius_m == null ? 0.2 : Number(body.collect_radius_m),
    points: Number(body.points) || 1,
    is_hidden_until_clue: Boolean(body.is_hidden_until_clue),
    sort_order: Number(body.sort_order) || 1,
    is_active: body.is_active !== false,
    hint_title: body.hint_title != null ? String(body.hint_title).trim() : null,
    hint: body.hint != null ? String(body.hint).trim() : null,
    hint_image: body.hint_image || null,
    hint_x: Number(body.hint_x) || 0,
    hint_y: Number(body.hint_y) || 0,
    hint_z: Number(body.hint_z) || 0,
    hint_rot_x: Number(body.hint_rot_x) || 0,
    hint_rot_y: Number(body.hint_rot_y) || 0,
    hint_rot_z: Number(body.hint_rot_z) || 0,
    hint_scale_x: Number(body.hint_scale_x) || 1,
    hint_scale_y: Number(body.hint_scale_y) || 1,
    hint_scale_z: Number(body.hint_scale_z) || 1,
  }).then((row) => {
    const inserted = one(row);
    logTreasure('created', 'Item', inserted, body.name);
    return inserted;
  });
}

export function updateTreasureItem(id, data) {
  return mutate('PATCH', `treasure_items?id=eq.${id}&${poiFilter()}`, {
    ...data,
    updated_at: new Date().toISOString(),
  }).then((row) => {
    const updated = one(row);
    logTreasure(treasurePatchAction(data), 'Item', updated || { id, ...data }, data.name, id);
    return updated;
  });
}

export function deleteTreasureItem(id) {
  return mutate('DELETE', `treasure_items?id=eq.${id}&${poiFilter()}`).then((row) => {
    logTreasure('deleted', 'Item', { id }, 'Treasure', id);
    return row;
  });
}

// ——— Tasks ———

export function fetchTreasureTasks() {
  return query(`treasure_tasks?select=*&${poiFilter()}&order=sort_order.asc`);
}

export function insertTreasureTask(body) {
  const poi_type = requirePoiType();
  return mutate('POST', 'treasure_tasks', {
    poi_type,
    level_id: body.level_id,
    title: String(body.title ?? '').trim() || 'Task',
    prompt_text: String(body.prompt_text ?? '').trim() || '',
    task_type: body.task_type || 'navigate_collect',
    destination_name: String(body.destination_name ?? '').trim() || 'Destination',
    dest_x: Number(body.dest_x) || 0,
    dest_y: Number(body.dest_y) || 0,
    dest_z: Number(body.dest_z) || 0,
    tokens_required: Number(body.tokens_required) || 1,
    arrive_radius_m: Number(body.arrive_radius_m) || 1.5,
    unlocks_cheat_id: body.unlocks_cheat_id || null,
    sort_order: Number(body.sort_order) || 1,
    is_active: body.is_active !== false,
  }).then((row) => {
    const inserted = one(row);
    logTreasure('created', 'Task', inserted, body.title);
    return inserted;
  });
}

export function updateTreasureTask(id, data) {
  return mutate('PATCH', `treasure_tasks?id=eq.${id}&${poiFilter()}`, {
    ...data,
    updated_at: new Date().toISOString(),
  }).then((row) => {
    const updated = one(row);
    logTreasure(treasurePatchAction(data), 'Task', updated || { id, ...data }, data.title, id);
    return updated;
  });
}

export function deleteTreasureTask(id) {
  return mutate('DELETE', `treasure_tasks?id=eq.${id}&${poiFilter()}`).then((row) => {
    logTreasure('deleted', 'Task', { id }, 'Task', id);
    return row;
  });
}

// ——— Task tokens ———

export function fetchTreasureTaskTokens(taskId = null) {
  let path = `treasure_task_tokens?select=*&${poiFilter()}&order=sort_order.asc`;
  if (taskId) path += `&task_id=eq.${taskId}`;
  return query(path);
}

export function insertTreasureTaskToken(body) {
  const poi_type = requirePoiType();
  return mutate('POST', 'treasure_task_tokens', {
    poi_type,
    task_id: body.task_id,
    name: String(body.name ?? '').trim() || 'Token',
    media_type: body.media_type === 'model' ? 'model' : 'image',
    media_url: body.media_url,
    pos_x: Number(body.pos_x) || 0,
    pos_y: Number(body.pos_y) || 0,
    pos_z: Number(body.pos_z) || 0,
    rot_x: Number(body.rot_x) || 0,
    rot_y: Number(body.rot_y) || 0,
    rot_z: Number(body.rot_z) || 0,
    scale: Number(body.scale) || 0.35,
    collect_radius_m: body.collect_radius_m == null ? 0.2 : Number(body.collect_radius_m),
    sort_order: Number(body.sort_order) || 1,
    is_active: body.is_active !== false,
  }).then((row) => {
    const inserted = one(row);
    logTreasure('created', 'Token', inserted, body.name);
    return inserted;
  });
}

export function updateTreasureTaskToken(id, data) {
  return mutate('PATCH', `treasure_task_tokens?id=eq.${id}&${poiFilter()}`, {
    ...data,
    updated_at: new Date().toISOString(),
  }).then((row) => {
    const updated = one(row);
    logTreasure(treasurePatchAction(data), 'Token', updated || { id, ...data }, data.name, id);
    return updated;
  });
}

export function deleteTreasureTaskToken(id) {
  return mutate('DELETE', `treasure_task_tokens?id=eq.${id}&${poiFilter()}`).then((row) => {
    logTreasure('deleted', 'Token', { id }, 'Token', id);
    return row;
  });
}

// ——— Cheats ———

export function fetchTreasureCheats() {
  return query(`treasure_cheats?select=*&${poiFilter()}&order=created_at.asc`);
}

export function insertTreasureCheat(body) {
  const poi_type = requirePoiType();
  return mutate('POST', 'treasure_cheats', {
    poi_type,
    level_id: body.level_id,
    title: String(body.title ?? '').trim() || 'Clue',
    clue_text: String(body.clue_text ?? '').trim() || '',
    clue_media_url: body.clue_media_url || null,
    target_treasure_id: body.target_treasure_id || null,
    reveals_treasure: body.reveals_treasure !== false,
  }).then((row) => {
    const inserted = one(row);
    logTreasure('created', 'Clue', inserted, body.title);
    return inserted;
  });
}

export function updateTreasureCheat(id, data) {
  return mutate('PATCH', `treasure_cheats?id=eq.${id}&${poiFilter()}`, {
    ...data,
    updated_at: new Date().toISOString(),
  }).then((row) => {
    const updated = one(row);
    logTreasure(treasurePatchAction(data), 'Clue', updated || { id, ...data }, data.title, id);
    return updated;
  });
}

export function deleteTreasureCheat(id) {
  return mutate('DELETE', `treasure_cheats?id=eq.${id}&${poiFilter()}`).then((row) => {
    logTreasure('deleted', 'Clue', { id }, 'Clue', id);
    return row;
  });
}

// ——— Players / progress (read-only) ———

export function fetchTreasurePlayers() {
  return query(`treasure_players?select=*&${poiFilter()}&order=created_at.desc`);
}

export function fetchTreasurePlayerProgress() {
  return query(`treasure_player_progress?select=*&${poiFilter()}&order=started_at.desc`);
}

export function fetchTreasureCollections() {
  return query(`treasure_collections?select=*&${poiFilter()}&order=collected_at.desc&limit=200`);
}

export async function fetchTreasureProgressSummary() {
  const [players, progress, collections, levels] = await Promise.all([
    fetchTreasurePlayers(),
    fetchTreasurePlayerProgress(),
    fetchTreasureCollections(),
    fetchTreasureLevels(),
  ]);
  return { players, progress, collections, levels };
}
