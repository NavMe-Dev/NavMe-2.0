/**
 * Live sync for `navme_media` via Supabase Realtime (websocket).
 * Updates only the changed item — no full scene rebuild.
 */

import { getSupabaseRealtimeClient } from './supabase-realtime-client.js';
import { getPoiType } from '../config/poi-session.js';
import {
  mediaData,
  upsertMediaFromSaved,
  deleteMediaFromSceneById,
  remountMediaItem,
  updateMediaTransform,
  getMediaObjects,
} from '../ar/media.js';
import { getMultisetAnchor } from '../ar/scene.js';

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let channel = null;

/** Skip echo for rows we just wrote locally. */
const recentlyTouched = new Map();

/**
 * @param {string | number} id
 * @param {number} [ttlMs]
 */
export function markMediaLocalWrite(id, ttlMs = 2500) {
  if (id == null) return;
  const key = String(id);
  recentlyTouched.set(key, Date.now() + ttlMs);
  setTimeout(() => {
    const until = recentlyTouched.get(key);
    if (until && until <= Date.now()) recentlyTouched.delete(key);
  }, ttlMs + 50);
}

function wasLocalWrite(id) {
  const until = recentlyTouched.get(String(id));
  if (!until) return false;
  if (until > Date.now()) return true;
  recentlyTouched.delete(String(id));
  return false;
}

function samePoiType(row) {
  const session = String(getPoiType() ?? '').trim().toLowerCase();
  if (!session) return true;
  return String(row?.poi_type ?? '').trim().toLowerCase() === session;
}

/**
 * @param {object} [hooks]
 * @param {(payload: { event: string, row?: object, id?: string | number }) => void} [hooks.onChange]
 */
export function startMediaRealtime(hooks = {}) {
  stopMediaRealtime();
  const client = getSupabaseRealtimeClient();
  if (!client) {
    console.warn('[realtime] Supabase not configured — media live sync off');
    return null;
  }

  const poiType = String(getPoiType() ?? '').trim();
  const filter = poiType ? `poi_type=eq.${poiType}` : undefined;

  channel = client
    .channel(`navme-media:${poiType || 'all'}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'navme_media',
        ...(filter ? { filter } : {}),
      },
      async (payload) => {
        try {
          await handleMediaChange(payload, hooks);
        } catch (err) {
          console.warn('[realtime] media sync failed:', err);
        }
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] navme_media subscribed');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[realtime] navme_media channel:', status);
      }
    });

  return channel;
}

export function stopMediaRealtime() {
  const client = getSupabaseRealtimeClient();
  if (channel && client) {
    client.removeChannel(channel);
  }
  channel = null;
}

/**
 * @param {import('@supabase/supabase-js').RealtimePostgresChangesPayload<Record<string, unknown>>} payload
 * @param {{ onChange?: Function }} hooks
 */
async function handleMediaChange(payload, hooks) {
  const event = payload.eventType;
  const row = payload.new && Object.keys(payload.new).length ? payload.new : null;
  const oldRow = payload.old && Object.keys(payload.old).length ? payload.old : null;
  const id = row?.id ?? oldRow?.id;
  if (id == null) return;
  if (wasLocalWrite(id)) return;

  if (event === 'DELETE') {
    deleteMediaFromSceneById(id);
    hooks.onChange?.({ event: 'DELETE', id });
    return;
  }

  if (!row) return;

  if (!samePoiType(row)) {
    if (oldRow && samePoiType(oldRow)) {
      deleteMediaFromSceneById(id);
      hooks.onChange?.({ event: 'DELETE', id });
    }
    return;
  }

  const prevIdx = mediaData.findIndex((m) => String(m.id) === String(row.id));
  const prev = prevIdx >= 0 ? { ...mediaData[prevIdx] } : null;
  const index = upsertMediaFromSaved(row);
  const anchor = getMultisetAnchor();

  const urlChanged = prev && prev.media_url !== row.media_url;
  const typeChanged = prev && prev.media_type !== row.media_type;
  const activeChanged = prev && Boolean(prev.is_active) !== Boolean(row.is_active !== false);
  const needsRemount = !prev || urlChanged || typeChanged || activeChanged || !getMediaObjects()[index]?.root;

  if (needsRemount && anchor) {
    await remountMediaItem(index, anchor);
  } else if (getMediaObjects()[index]?.root) {
    updateMediaTransform(index, {
      pos_x: Number(row.pos_x),
      pos_y: Number(row.pos_y),
      pos_z: Number(row.pos_z),
      rot_x: Number(row.rot_x),
      rot_y: Number(row.rot_y),
      rot_z: Number(row.rot_z),
      scale_x: Number(row.scale_x ?? 1),
      scale_y: Number(row.scale_y ?? 1),
      scale_z: Number(row.scale_z ?? 1),
      width: Number(row.width ?? 1),
      height: Number(row.height ?? 1),
      label: row.label ?? prev?.label,
      redirect_link: row.redirect_link ?? null,
      is_active: row.is_active !== false,
    });
  }

  hooks.onChange?.({ event, row, id: row.id });
}
