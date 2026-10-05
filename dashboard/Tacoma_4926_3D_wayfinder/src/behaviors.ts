/** NavMe Supabase + tenant config for standalone Vite build. */

/**
 * Fallbacks keep Render (and other hosts) working when Dashboard
 * `VITE_*` env vars were not set at build time. Vite only inlines
 * env present during `npm run build` — an empty URL becomes a relative
 * `/rest/v1/...` call against the static host → 404 blank map.
 *
 * Override anytime by setting Build-time env on Render (then Clear cache & deploy).
 */
const FALLBACK_SUPABASE_URL = 'https://znfwcohrpkiccibqcfpn.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuZndjb2hycGtpY2NpYnFjZnBuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMDUzNDMsImV4cCI6MjA4Njg4MTM0M30.owUVIY-uz7Cr4p83ZQ88QbsgrUfuZqKRiC7HZFIfoec';

function envOr(name: keyof ImportMetaEnv, fallback: string): string {
  const raw = (import.meta.env[name] ?? '').toString().trim();
  return raw || fallback;
}

function poiTypeFromUrl(): string {
  if (typeof window === 'undefined') return '';
  const fromQuery = new URLSearchParams(window.location.search).get('poi_type');
  return String(fromQuery ?? '').trim();
}

// ─────────────────────────────────────────────────────────────────────────
//  👇 CHANGE THE POI TYPE HERE ONLY  👇
//  main.ts, Mini3dGtaEmbed, and the rest all read NAVME_CONFIG.tenant.
//  Optional override: VITE_NAVME_POI_TYPE in .env (build-time).
// ─────────────────────────────────────────────────────────────────────────
export const DEFAULT_POI_TYPE = 'room';

export const NAVME_CONFIG = {
  supabaseUrl: envOr('VITE_SUPABASE_URL', FALLBACK_SUPABASE_URL),
  supabaseAnonKey: envOr('VITE_SUPABASE_ANON_KEY', FALLBACK_SUPABASE_ANON_KEY),
  /** Active POI / tenant — always derived from DEFAULT_POI_TYPE (or VITE_NAVME_POI_TYPE). */
  tenant: poiTypeFromUrl() || envOr('VITE_NAVME_POI_TYPE', DEFAULT_POI_TYPE),
  /**
   * "View in AR" button target.
   * Change here, or override at build time with VITE_VIEW_IN_AR_URL.
   */
  viewInArUrl: envOr('VITE_VIEW_IN_AR_URL', 'https://webxr.run/a8VDG8eLb0wEO'),
} as const;
