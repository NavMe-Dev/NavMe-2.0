/**
 * Live AR telemetry over Supabase Realtime (websocket) — no polling, no refresh.
 *
 * Two streams feed the User Analytics page:
 *   navme_ar_sessions  INSERT/UPDATE — a session opens, heartbeats every ~15s with
 *                      fresh FPS/localization rollups, then closes.
 *   navme_ar_events    INSERT        — the destination events the POI table needs.
 *
 * Volume control matters here: the experience writes an `fps_sample` row every 10s
 * for every live session, so an unfiltered event subscription would saturate the
 * socket once a handful of people are in the building. The events channel is
 * filtered server-side to the four destination event types, which is the only
 * slice this page reads live.
 */

import { getSupabaseRealtimeClient } from './supabase-realtime-client.js';

/** Event types the Destinations table is built from. */
const LIVE_EVENT_TYPES = ['poi_selected', 'route_generated', 'route_failed', 'arrived'];

/** @type {Array<import('@supabase/supabase-js').RealtimeChannel>} */
let channels = [];

/**
 * @param {object} opts
 * @param {string|null} [opts.poiType]   Project scope; null subscribes to every project.
 * @param {(row: object, eventType: string) => void} [opts.onSession]
 * @param {(row: object) => void} [opts.onEvent]
 * @param {(status: 'connecting'|'live'|'error') => void} [opts.onStatus]
 */
export function startArAnalyticsRealtime({ poiType = null, onSession, onEvent, onStatus } = {}) {
  stopArAnalyticsRealtime();

  const client = getSupabaseRealtimeClient();
  if (!client) {
    onStatus?.('error');
    console.warn('[realtime] Supabase not configured — analytics live updates off');
    return null;
  }

  const scope = String(poiType ?? '').trim();
  const scopeKey = scope || 'all';
  onStatus?.('connecting');

  // Two channels rather than one: each postgres_changes binding takes a single
  // server-side filter, and these two need different ones.
  const sessionChannel = client
    .channel(`navme-ar-sessions:${scopeKey}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'navme_ar_sessions',
        ...(scope ? { filter: `poi_type=eq.${scope}` } : {}),
      },
      (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            // navme_ar_sessions is REPLICA IDENTITY FULL, so `old` carries session_key.
            const gone = payload.old && Object.keys(payload.old).length ? payload.old : null;
            if (gone?.session_key) onSession?.(gone, 'DELETE');
            return;
          }
          const row = payload.new && Object.keys(payload.new).length ? payload.new : null;
          if (!row) return;
          onSession?.(row, payload.eventType);
        } catch (err) {
          console.warn('[realtime] analytics session update failed:', err);
        }
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onStatus?.('live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onStatus?.(status === 'CLOSED' ? 'connecting' : 'error');
      }
    });

  const eventChannel = client
    .channel(`navme-ar-events:${scopeKey}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'navme_ar_events',
        // Server-side type filter keeps fps_sample off the wire entirely.
        filter: `event_type=in.(${LIVE_EVENT_TYPES.join(',')})`,
      },
      (payload) => {
        try {
          const row = payload.new;
          if (!row || !Object.keys(row).length) return;
          // poi_type is filtered here because the one server filter slot is
          // already spent on event_type.
          if (scope && String(row.poi_type ?? '').trim() !== scope) return;
          onEvent?.(row);
        } catch (err) {
          console.warn('[realtime] analytics event insert failed:', err);
        }
      },
    )
    .subscribe();

  channels = [sessionChannel, eventChannel];
  return channels;
}

export function stopArAnalyticsRealtime() {
  const client = getSupabaseRealtimeClient();
  if (client) {
    for (const ch of channels) {
      try {
        client.removeChannel(ch);
      } catch {
        /* already torn down */
      }
    }
  }
  channels = [];
}

export function isArAnalyticsRealtimeActive() {
  return channels.length > 0;
}
