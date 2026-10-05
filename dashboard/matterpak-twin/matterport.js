/**
 * Matterport Showcase helpers for the standalone twin lab.
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

export function getMatterportSdkKey() {
  return String(import.meta.env.VITE_MATTERPORT_SDK_KEY || '').trim();
}

/**
 * Showcase embed URL.
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
  u.searchParams.set('brand', '0');
  u.searchParams.set('title', '0');
  u.searchParams.set('mls', '2');
  u.searchParams.set('hr', '0');
  u.searchParams.set('help', '0');
  u.searchParams.set('nt', '0');

  if (opts.useSdkKey) {
    const key = getMatterportSdkKey();
    if (key) u.searchParams.set('applicationKey', key);
  }
  return u.toString();
}
