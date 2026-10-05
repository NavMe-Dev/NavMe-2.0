/**
 * White-labeled partner POI API host (proxied to Supabase Edge Function).
 * Override with VITE_PARTNER_API_BASE if needed.
 */

const DEFAULT_PARTNER_API_BASE = 'https://api.navme.space';

export function getPartnerApiBase() {
  const fromEnv = String(import.meta.env.VITE_PARTNER_API_BASE || '').trim().replace(/\/$/, '');
  return fromEnv || DEFAULT_PARTNER_API_BASE;
}

/**
 * @param {string | null | undefined} publicId
 */
export function partnerPoisApiUrl(publicId) {
  const base = getPartnerApiBase();
  const id = String(publicId || '').trim();
  if (!base) return '';
  const path = `${base}/partner-pois`;
  return id ? `${path}?id=${encodeURIComponent(id)}` : path;
}
