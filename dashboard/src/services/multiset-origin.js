/**
 * MultiSet REST API base URL.
 * - Development: `/api/multiset` is proxied by Vite to `https://api.multiset.ai`.
 * - Production: prefer Supabase `multiset-proxy` so the browser never calls api.multiset.ai directly.
 */
const DEFAULT_ORIGIN = 'https://api.multiset.ai';

function trimEnv(value) {
  return typeof value === 'string' ? value.trim().replace(/\/$/, '') : '';
}

function isSupabaseProxyBase(base) {
  return base.includes('/functions/v1/multiset-proxy');
}

function resolveMultisetOrigin() {
  if (import.meta.env.DEV) return '';

  const explicit = trimEnv(import.meta.env.VITE_MULTISET_API_ORIGIN);
  if (explicit) return explicit;

  const proxy = trimEnv(import.meta.env.VITE_MULTISET_PROXY_URL);
  if (proxy) return proxy;

  const supabase = trimEnv(import.meta.env.VITE_SUPABASE_URL);
  if (supabase) return `${supabase}/functions/v1/multiset-proxy`;

  return DEFAULT_ORIGIN;
}

/**
 * @param {string} path API path starting with `/v1/...`
 * @param {Record<string, string>} [query] Extra query params (e.g. `{ key: '...' }` for /v1/file)
 * @returns {string} Full URL for fetch()
 */
export function multisetApiUrl(path, query) {
  const suffix = path.startsWith('/') ? path : `/${path}`;

  if (import.meta.env.DEV) {
    let url = `/api/multiset${suffix}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }
    return url;
  }

  const base = resolveMultisetOrigin();
  if (isSupabaseProxyBase(base)) {
    const u = new URL(base.split('?')[0]);
    u.searchParams.set('_path', suffix);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        u.searchParams.set(key, value);
      }
    }
    return u.toString();
  }

  const u = new URL(`${base}${suffix}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      u.searchParams.set(key, value);
    }
  }
  return u.toString();
}

/**
 * When using Supabase multiset-proxy, swap MultiSet auth for gateway anon key headers.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {RequestInit}
 */
export function prepareMultisetFetch(url, init = {}) {
  const base = url.split('?')[0];
  if (!isSupabaseProxyBase(base)) return init;

  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof anon !== 'string' || !anon.trim()) return init;

  const headers = new Headers(init.headers);
  const multisetAuth = headers.get('Authorization');
  if (multisetAuth?.startsWith('Basic ') || multisetAuth?.startsWith('Bearer ')) {
    headers.set('X-Multiset-Authorization', multisetAuth);
    headers.delete('Authorization');
  }
  headers.set('apikey', anon.trim());
  headers.set('Authorization', `Bearer ${anon.trim()}`);
  return { ...init, headers };
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function multisetFetch(url, init = {}) {
  return fetch(url, prepareMultisetFetch(url, init));
}
