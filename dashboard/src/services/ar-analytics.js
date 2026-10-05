/**
 * AR experience analytics — reads the telemetry the NavMe WebXR bundle writes.
 *
 *   navme_ar_sessions : one row per visit (device, localization timing, FPS rollups)
 *   navme_ar_events   : append-only stream (session_start, localized, poi_selected, …)
 *
 * Read-only. Both tables are written exclusively by the `navme_ar_log()` RPC from
 * the experience, so nothing here ever mutates them.
 */

import { getSupabaseUrl, getSupabaseAnonKey, isSupabaseConfigured } from './supabase.js';

/** Client-side aggregation cap — keeps a wide date range from pulling everything. */
export const SESSION_FETCH_CAP = 2000;
export const EVENT_FETCH_CAP = 5000;

function headers() {
  return {
    apikey: getSupabaseAnonKey(),
    Authorization: `Bearer ${getSupabaseAnonKey()}`,
    'Content-Type': 'application/json',
  };
}

async function query(path) {
  if (!isSupabaseConfigured()) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.');
  }
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Analytics query failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** ISO timestamp for "N days ago", start of that day in local time. */
export function sinceIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - (Number(days) || 0));
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * @param {{ poiType?: string|null, since?: string|null, limit?: number }} [opts]
 */
export async function fetchArSessions({ poiType = null, since = null, limit = SESSION_FETCH_CAP } = {}) {
  const cap = Math.min(Math.max(Number(limit) || SESSION_FETCH_CAP, 1), SESSION_FETCH_CAP);
  let path = `navme_ar_sessions?select=*&order=opened_at.desc&limit=${cap}`;
  const pt = String(poiType ?? '').trim();
  if (pt) path += `&poi_type=eq.${encodeURIComponent(pt)}`;
  if (since) path += `&opened_at=gte.${encodeURIComponent(since)}`;
  return query(path);
}

/** Full ordered timeline for one session (drawer view). */
export async function fetchSessionEvents(sessionKey, limit = 1000) {
  const key = String(sessionKey ?? '').trim();
  if (!key) return [];
  const cap = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  return query(
    `navme_ar_events?select=*&session_key=eq.${encodeURIComponent(key)}&order=t_ms.asc&limit=${cap}`
  );
}

/**
 * Destination-related events across the range, for the POI popularity table.
 * fps_sample rows are deliberately excluded — they are the bulk of the stream
 * and the session rollups already carry their summary.
 */
export async function fetchPoiEvents({ poiType = null, since = null, limit = EVENT_FETCH_CAP } = {}) {
  const cap = Math.min(Math.max(Number(limit) || EVENT_FETCH_CAP, 1), EVENT_FETCH_CAP);
  const types = 'poi_selected,route_generated,route_failed,arrived';
  let path =
    `navme_ar_events?select=session_key,event_type,event_at,poi_id,poi_name,value,detail` +
    `&event_type=in.(${types})&order=event_at.desc&limit=${cap}`;
  const pt = String(poiType ?? '').trim();
  if (pt) path += `&poi_type=eq.${encodeURIComponent(pt)}`;
  if (since) path += `&event_at=gte.${encodeURIComponent(since)}`;
  return query(path);
}

/** Distinct poi_type values, so a superadmin can switch projects. */
export async function fetchAnalyticsProjects() {
  const rows = await query('navme_ar_sessions?select=poi_type&order=poi_type.asc&limit=2000');
  const seen = new Set();
  for (const r of rows) {
    const v = String(r?.poi_type ?? '').trim();
    if (v) seen.add(v);
  }
  return Array.from(seen).sort();
}

// ─────────────────────────── aggregation ───────────────────────────

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Null-safe numeric coercion. `Number(null)` is 0 and `Number('')` is 0, so a
 * plain Number() turns every missing metric into a real zero — which silently
 * drags FPS and localization averages down and prints "0 GB" for unknown RAM.
 */
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Headline numbers for the KPI row.
 * @param {Array<Record<string, unknown>>} sessions
 */
export function summarizeSessions(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];

  const localizeMs = [];
  const fpsAvgs = [];
  const durations = [];
  const devices = new Set();
  let localizedCount = 0;
  let failedLocalize = 0;
  let routesOk = 0;
  let routesFail = 0;
  let poisSelected = 0;
  let arrivals = 0;
  let jankSessions = 0;

  for (const r of rows) {
    const lm = numOrNull(r.localization_ms);
    if (lm != null) {
      localizeMs.push(lm);
      localizedCount++;
    }
    if (r.localization_failed) failedLocalize++;

    const fa = numOrNull(r.fps_avg);
    if (fa != null) fpsAvgs.push(fa);

    const dur = numOrNull(r.duration_ms);
    if (dur != null && dur > 0) durations.push(dur);

    const model = String(r.device_model ?? '').trim();
    const os = String(r.os_name ?? '').trim();
    if (model || os) devices.add(`${model}|${os}`);

    routesOk += numOrNull(r.routes_generated) ?? 0;
    routesFail += numOrNull(r.routes_failed) ?? 0;
    poisSelected += numOrNull(r.pois_selected) ?? 0;
    arrivals += numOrNull(r.arrivals) ?? 0;

    const jank = numOrNull(r.jank_ratio) ?? 0;
    if (jank > 0.05) jankSessions++;
  }

  const routeTotal = routesOk + routesFail;

  return {
    sessions: rows.length,
    deviceTypes: devices.size,
    localizedCount,
    localizeRate: rows.length ? localizedCount / rows.length : null,
    medianLocalizeMs: median(localizeMs),
    failedLocalize,
    avgFps: fpsAvgs.length ? fpsAvgs.reduce((a, b) => a + b, 0) / fpsAvgs.length : null,
    minFps: fpsAvgs.length ? Math.min(...fpsAvgs) : null,
    jankSessions,
    medianDurationMs: median(durations),
    poisSelected,
    routesOk,
    routesFail,
    routeSuccessRate: routeTotal ? routesOk / routeTotal : null,
    arrivals,
  };
}

/**
 * Per-device rollup — the view that answers "does it hold up on low-spec Android?".
 */
export function summarizeDevices(sessions) {
  /** @type {Map<string, any>} */
  const byDevice = new Map();

  for (const r of Array.isArray(sessions) ? sessions : []) {
    const model = String(r.device_model ?? '').trim() || 'Unknown device';
    const os = String(r.os_name ?? '').trim() || '—';
    const key = `${model}|${os}`;

    let d = byDevice.get(key);
    if (!d) {
      d = {
        key,
        model,
        brand: String(r.device_brand ?? '').trim(),
        os,
        osVersions: new Set(),
        sessions: 0,
        fps: [],
        localizeMs: [],
        jankSessions: 0,
        failedLocalize: 0,
        memory: numOrNull(r.device_memory_gb),
        cores: numOrNull(r.cpu_cores),
      };
      byDevice.set(key, d);
    }

    d.sessions++;
    const ov = String(r.os_version ?? '').trim();
    if (ov) d.osVersions.add(ov);

    const fa = numOrNull(r.fps_avg);
    if (fa != null) d.fps.push(fa);
    const lm = numOrNull(r.localization_ms);
    if (lm != null) d.localizeMs.push(lm);
    if ((numOrNull(r.jank_ratio) ?? 0) > 0.05) d.jankSessions++;
    if (r.localization_failed) d.failedLocalize++;
    if (d.memory == null) d.memory = numOrNull(r.device_memory_gb);
    if (d.cores == null) d.cores = numOrNull(r.cpu_cores);
  }

  return Array.from(byDevice.values())
    .map((d) => ({
      key: d.key,
      model: d.model,
      brand: d.brand,
      os: d.os,
      osVersions: Array.from(d.osVersions).sort().join(', '),
      sessions: d.sessions,
      avgFps: d.fps.length ? d.fps.reduce((a, b) => a + b, 0) / d.fps.length : null,
      minFps: d.fps.length ? Math.min(...d.fps) : null,
      medianLocalizeMs: median(d.localizeMs),
      jankSessions: d.jankSessions,
      failedLocalize: d.failedLocalize,
      memory: d.memory,
      cores: d.cores,
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Destination popularity plus whether a route actually generated for it.
 * @param {Array<Record<string, unknown>>} events
 */
export function summarizePois(events) {
  /** @type {Map<string, any>} */
  const byPoi = new Map();

  const keyFor = (e) => {
    const name = String(e.poi_name ?? '').trim();
    const id = String(e.poi_id ?? '').trim();
    return name || id || 'Unknown destination';
  };

  for (const e of Array.isArray(events) ? events : []) {
    const type = String(e.event_type ?? '');
    // route_generated / arrived carry no POI id when resolved from the scene graph.
    if (type === 'poi_selected' || type === 'route_generated' || type === 'route_failed') {
      const key = keyFor(e);
      let p = byPoi.get(key);
      if (!p) {
        p = { name: key, poiId: String(e.poi_id ?? '').trim(), selected: 0, routed: 0, failed: 0, lengths: [] };
        byPoi.set(key, p);
      }
      if (type === 'poi_selected') p.selected++;
      else if (type === 'route_generated') {
        p.routed++;
        const len = numOrNull(e.value);
        if (len != null && len > 0) p.lengths.push(len);
      } else p.failed++;
    }
  }

  return Array.from(byPoi.values())
    .map((p) => ({
      name: p.name,
      poiId: p.poiId,
      selected: p.selected,
      routed: p.routed,
      failed: p.failed,
      successRate: p.routed + p.failed ? p.routed / (p.routed + p.failed) : null,
      avgRouteM: p.lengths.length ? p.lengths.reduce((a, b) => a + b, 0) / p.lengths.length : null,
    }))
    .sort((a, b) => b.selected - a.selected || b.routed - a.routed);
}

/** FPS histogram buckets for the performance card. */
export function fpsBuckets(sessions) {
  const buckets = [
    { label: '< 15 fps', min: 0, max: 15, count: 0, tone: 'bad' },
    { label: '15–24', min: 15, max: 25, count: 0, tone: 'bad' },
    { label: '25–39', min: 25, max: 40, count: 0, tone: 'warn' },
    { label: '40–54', min: 40, max: 55, count: 0, tone: 'ok' },
    { label: '55+ fps', min: 55, max: Infinity, count: 0, tone: 'good' },
  ];
  for (const r of Array.isArray(sessions) ? sessions : []) {
    const fa = numOrNull(r.fps_avg);
    if (fa == null) continue;
    const b = buckets.find((x) => fa >= x.min && fa < x.max);
    if (b) b.count++;
  }
  return buckets;
}

/** Sessions per local day, for the trend strip. */
export function sessionsByDay(sessions, days = 14) {
  const out = [];
  const counts = new Map();
  for (const r of Array.isArray(sessions) ? sessions : []) {
    const iso = r.opened_at;
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ key, label: `${d.getDate()}/${d.getMonth() + 1}`, count: counts.get(key) ?? 0 });
  }
  return out;
}
