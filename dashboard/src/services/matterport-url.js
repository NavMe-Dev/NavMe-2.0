/**
 * Showcase URL helpers for the NavMe dashboard (3D space map).
 */
export function parseMatterportModelId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z0-9]+$/.test(raw) && raw.length >= 6 && raw.length <= 64) {
    return raw;
  }
  try {
    const u = new URL(raw);
    const m = u.searchParams.get('m') || u.searchParams.get('m1');
    if (m) return m.trim();
  } catch {
    /* */
  }
  const match = raw.match(/[?&]m=([A-Za-z0-9]+)/i);
  return match ? match[1] : '';
}

/**
 * Detect 3D-space map rows in navme_media.
 * Prefer media_type=matterport; also accept model + mime marker for DBs
 * that have not applied the matterport check-constraint migration yet.
 */
export function isMatterportMediaRow(item) {
  if (!item) return false;
  if (item.media_type === 'matterport') return true;
  if (String(item.mime_type || '') === 'application/vnd.matterport.space') return true;
  return false;
}

/** MIME used when storing space links without the `matterport` media_type. */
export const MATTERPORT_MIME = 'application/vnd.matterport.space';

export function getMatterportSdkKey() {
  return String(import.meta.env.VITE_MATTERPORT_SDK_KEY || '').trim();
}

/**
 * Lean Showcase embed URL — strip branding / about / help chrome.
 * @param {string} modelIdOrUrl
 * @param {{ play?: boolean, useSdkKey?: boolean }} [opts]
 */
export function matterportShowcaseUrl(modelIdOrUrl, opts = {}) {
  const id = parseMatterportModelId(modelIdOrUrl);
  if (!id) return '';
  const u = new URL('https://my.matterport.com/show/');
  u.searchParams.set('m', id);
  if (opts.play !== false) u.searchParams.set('play', '1');
  u.searchParams.set('qs', '1');
  // Soften top branding only — keep side/bottom Showcase controls (floors,
  // dollhouse, tour, VR, etc.). Top `.header-container-*` is cropped in CSS.
  u.searchParams.set('brand', '0');
  u.searchParams.set('title', '0');
  u.searchParams.set('mls', '2');
  u.searchParams.set('newtop', '0');
  u.searchParams.set('logo', '0');
  // Hide loading-page branding when supported (powered-by splash).
  u.searchParams.set('lp', '0');
  u.searchParams.set('lang', 'en');
  // Wayfinding: strip the Showcase chrome so only the walkthrough remains.
  // These are Showcase URL params — the bottom control bar lives inside the
  // iframe and cannot be reached with CSS from the parent page.
  if (opts.minimalChrome) {
    u.searchParams.set('dh', '0'); // dollhouse button
    u.searchParams.set('f', '0'); // floor selector
    u.searchParams.set('hr', '0'); // highlight reel
    u.searchParams.set('gt', '0'); // guided tour
    u.searchParams.set('tourcta', '0'); // tour call-to-action
    u.searchParams.set('vr', '0'); // VR entry
    u.searchParams.set('mt', '0'); // measurement tool
    u.searchParams.set('pin', '0'); // tag pins
    u.searchParams.set('portal', '0');
    u.searchParams.set('help', '0');
    u.searchParams.set('nozoom', '0');
    u.searchParams.set('search', '0');
    u.searchParams.set('qs', '1');
    // Start inside the space rather than on the dollhouse intro spin.
    u.searchParams.set('ss', '0');
    u.searchParams.set('sr', '0');
  }
  if (opts.useSdkKey !== false) {
    const key = getMatterportSdkKey();
    if (key) u.searchParams.set('applicationKey', key);
  }
  return u.toString();
}
