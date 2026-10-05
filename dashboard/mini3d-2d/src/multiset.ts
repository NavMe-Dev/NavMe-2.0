import type { GtaConfig } from './config';
import {
  GLB_CACHE_NAME,
  MAP_DOWNLOAD_CONCURRENCY,
  MAP_FETCH_TIMEOUT_MS,
  MAP_LAZY_BACKGROUND_CONCURRENCY,
  MAP_LAZY_EAGER_COUNT,
  MULTISET_PUBLIC_API,
  NAVME_MULTISET_PROXY_BASE,
  USE_LOAD_CACHE,
} from './config';
import { runPool, yieldToMain } from './schedYield';

if (typeof Response !== 'undefined' && !(Response.prototype as { _gtaJsonPatched?: boolean })._gtaJsonPatched) {
  Response.prototype.json = function patchedJson(this: Response) {
    return this.text().then((raw) => {
      const t = (raw ?? '').trim();
      if (!t) {
        return Promise.reject(
          new SyntaxError(
            'Empty response body (not valid JSON). Use Vite dev with /api/multiset proxy or a real API base URL.',
          ),
        );
      }
      try {
        return JSON.parse(t) as unknown;
      } catch (e) {
        const preview = t.length > 160 ? `${t.slice(0, 160)}…` : t;
        const err = new SyntaxError(`Invalid JSON in response: ${preview}`);
        (err as Error & { cause?: unknown }).cause = e;
        return Promise.reject(err);
      }
    });
  };
  (Response.prototype as { _gtaJsonPatched?: boolean })._gtaJsonPatched = true;
}

export type MultiSetEndpoints = {
  tokenUrl: string;
  mapInfoBaseUrl: string;
  mapSetBaseUrl: string;
  fileUrl: string;
  proxyBase?: string;
};

function getBundlerEnv(): { DEV?: boolean; VITE_MULTISET_API_URL?: string } {
  if (import.meta.env.DEV) return { DEV: true, VITE_MULTISET_API_URL: import.meta.env.VITE_MULTISET_API_URL };
  return {
    VITE_MULTISET_API_URL:
      typeof import.meta.env.VITE_MULTISET_API_URL === 'string'
        ? import.meta.env.VITE_MULTISET_API_URL
        : undefined,
  };
}

function tokenCacheKey(clientId: string): string {
  return 'navme_ms_tok_' + clientId;
}

function readCachedToken(clientId: string): string | null {
  if (!USE_LOAD_CACHE || typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(tokenCacheKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; exp?: number };
    if (parsed.token && typeof parsed.exp === 'number' && Date.now() < parsed.exp) return parsed.token;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCachedToken(clientId: string, token: string, expiresOn?: string): void {
  if (!USE_LOAD_CACHE || typeof sessionStorage === 'undefined') return;
  try {
    let exp = Date.now() + 25 * 60 * 1000;
    if (expiresOn) {
      const t = new Date(expiresOn).getTime() - 60 * 1000;
      if (t > Date.now()) exp = t;
    }
    sessionStorage.setItem(tokenCacheKey(clientId), JSON.stringify({ token, exp }));
  } catch {
    /* ignore */
  }
}

async function readCachedGlb(mapCode: string): Promise<ArrayBuffer | null> {
  if (!USE_LOAD_CACHE || typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(GLB_CACHE_NAME);
    const res = await cache.match('glb:' + mapCode);
    if (res) return res.arrayBuffer();
  } catch {
    /* ignore */
  }
  return null;
}

async function writeCachedGlb(mapCode: string, buf: ArrayBuffer): Promise<void> {
  if (!USE_LOAD_CACHE || typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(GLB_CACHE_NAME);
    await cache.put('glb:' + mapCode, new Response(buf.slice(0)));
  } catch {
    /* ignore */
  }
}

function isSupabaseMultisetProxyBase(base: string): boolean {
  return base.includes('/functions/v1/multiset-proxy');
}

function multisetProxyUrl(base: string, path: string, query?: Record<string, string>): string {
  const u = new URL(base.split('?')[0]);
  u.searchParams.set('_path', path.startsWith('/') ? path : `/${path}`);
  if (query) {
    Object.keys(query).forEach((k) => u.searchParams.set(k, query[k]));
  }
  return u.toString();
}

function supabaseMultisetProxyFromEnv(): string | null {
  const proxy = import.meta.env.VITE_MULTISET_PROXY_URL;
  if (typeof proxy === 'string' && proxy.trim()) {
    return proxy.trim().replace(/\/$/, '');
  }
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (typeof url === 'string' && url.trim()) {
    return `${url.trim().replace(/\/$/, '')}/functions/v1/multiset-proxy`;
  }
  return NAVME_MULTISET_PROXY_BASE;
}

export function resolveMultiSetApiBase(cfg: Partial<GtaConfig>): string {
  const env = getBundlerEnv();
  // Dev: route through Vite /api/multiset — browser cannot POST to edge functions directly (CORS).
  if (env.DEV && !env.VITE_MULTISET_API_URL?.trim()) return '';

  const fromEnv = env.VITE_MULTISET_API_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  const explicit = cfg.multiSetApiBaseUrl?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  return supabaseMultisetProxyFromEnv() ?? NAVME_MULTISET_PROXY_BASE;
}

export function buildMultiSetEndpoints(cfg: Partial<GtaConfig>): MultiSetEndpoints {
  const base = resolveMultiSetApiBase(cfg);
  const p = (sub: string) => {
    const path = sub.startsWith('/') ? sub : `/${sub}`;
    return base === '' ? `/api/multiset${path}` : `${base}${path}`;
  };
  return isSupabaseMultisetProxyBase(base)
    ? {
        proxyBase: base.split('?')[0],
        tokenUrl: multisetProxyUrl(base, '/v1/m2m/token'),
        mapInfoBaseUrl: p('/v1/vps/map'),
        mapSetBaseUrl: p('/v1/vps/map-set'),
        fileUrl: multisetProxyUrl(base, '/v1/file'),
      }
    : {
        tokenUrl: p('/v1/m2m/token'),
        mapInfoBaseUrl: p('/v1/vps/map'),
        mapSetBaseUrl: p('/v1/vps/map-set'),
        fileUrl: p('/v1/file'),
      };
}

export function resolveGlbCorsProxyPostUrl(cfg: Partial<GtaConfig>, apiBase: string): string | undefined {
  if (typeof cfg.glbCorsProxyPostUrl === 'string' && cfg.glbCorsProxyPostUrl.trim() !== '') {
    return cfg.glbCorsProxyPostUrl.trim();
  }
  if (import.meta.env.DEV) {
    return '/api/proxy-external-fetch';
  }
  if (
    apiBase !== '' &&
    apiBase !== MULTISET_PUBLIC_API &&
    !apiBase.startsWith('/') &&
    apiBase.startsWith('https://')
  ) {
    if (isSupabaseMultisetProxyBase(apiBase)) {
      return multisetProxyUrl(apiBase, '/proxy-external-fetch');
    }
    return `${apiBase}/proxy-external-fetch`;
  }
  return undefined;
}

async function readJsonResponse(res: Response, options: { allowEmpty?: boolean } = {}): Promise<unknown> {
  const text = await res.text();
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    if (options.allowEmpty) return null;
    throw new Error(`Empty response body (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`Expected JSON (${res.status}): ${trimmed.slice(0, 160)}`);
  }
}

function prepareProxyRequest(url: string, init: RequestInit = {}): RequestInit {
  if (!isSupabaseMultisetProxyBase(url.split('?')[0])) return init;
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

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = MAP_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const prepared = prepareProxyRequest(url, options);
  try {
    return await fetch(url, { ...prepared, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (err instanceof TypeError && /fetch/i.test(String(err.message))) {
      const hint = import.meta.env.DEV
        ? ' Run via npm run dev so MultiSet uses the /api/multiset proxy.'
        : ' MultiSet proxy CORS/network failed. Redeploy functions/v1/multiset-proxy on VITE_SUPABASE_URL.';
      throw new Error(`Failed to fetch ${url}.${hint}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getM2MToken(clientId: string, clientSecret: string, tokenUrl: string): Promise<{ token: string }> {
  const basicCredentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let hint = '';
    if (/cloudfront|cacheable request|403/i.test(body)) {
      hint = ' CloudFront blocks browser POST to api.multiset.ai — use the Supabase proxy or Vite /api/multiset.';
    }
    throw new Error(`Auth failed (${res.status}): ${(body || res.statusText).slice(0, 400)}${hint}`);
  }
  const data = (await readJsonResponse(res)) as { token?: string; access_token?: string; expiresOn?: string };
  const token = data.token || data.access_token;
  if (!token) throw new Error('Auth response did not contain a token');
  writeCachedToken(clientId, token, data.expiresOn);
  return { token };
}

export async function getM2MTokenCached(
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
): Promise<{ token: string }> {
  const cached = readCachedToken(clientId);
  if (cached) return { token: cached };
  return getM2MToken(clientId, clientSecret, tokenUrl);
}

function pushIfFile(out: string[], value: unknown): void {
  if (!value || typeof value !== 'string') return;
  const lower = value.toLowerCase();
  if (lower.endsWith('.glb') || lower.endsWith('.gltf') || lower.includes('/mesh/')) {
    out.push(value);
  }
}

function unwrapMapInfo(info: Record<string, unknown>): Record<string, unknown> {
  const nested = (info.map ?? (info.data as Record<string, unknown> | undefined)?.map) as
    | Record<string, unknown>
    | undefined;
  if (nested && typeof nested === 'object') {
    return { ...info, ...nested, map: nested };
  }
  return info;
}

function findMeshKey(info: Record<string, unknown>, preferTextured = true): string | null {
  const explicit: string[] = [];
  const mapMesh = info.mapMesh as Record<string, unknown> | undefined;
  const texturedMesh = mapMesh?.texturedMesh as { meshLink?: string } | undefined;
  const rawMesh = mapMesh?.rawMesh as { meshLink?: string } | undefined;
  pushIfFile(explicit, texturedMesh?.meshLink);
  pushIfFile(explicit, rawMesh?.meshLink);
  pushIfFile(explicit, (info.texturedMesh as { meshLink?: string } | undefined)?.meshLink);
  pushIfFile(explicit, (info.rawMesh as { meshLink?: string } | undefined)?.meshLink);

  const g = (k: string) => info[k] as unknown;
  if (g('meshKey')) pushIfFile(explicit, g('meshKey'));
  if (g('meshFileKey')) pushIfFile(explicit, g('meshFileKey'));
  const mesh = g('mesh') as Record<string, unknown> | undefined;
  if (mesh?.key) pushIfFile(explicit, mesh.key);
  if (mesh?.fileKey) pushIfFile(explicit, mesh.fileKey);
  if (g('glbKey')) pushIfFile(explicit, g('glbKey'));
  if (g('fileKey')) pushIfFile(explicit, g('fileKey'));
  const data = g('data') as Record<string, unknown> | undefined;
  if (data?.meshKey) pushIfFile(explicit, data.meshKey);
  const map = g('map') as Record<string, unknown> | undefined;
  if (map?.meshKey) pushIfFile(explicit, map.meshKey);
  const ob = g('offlineBundle') as Record<string, unknown> | undefined;
  if (ob?.meshKey) pushIfFile(explicit, ob.meshKey);
  if (ob?.key) pushIfFile(explicit, ob.key);
  if (ob?.glbKey) pushIfFile(explicit, ob.glbKey);
  const filesObj = g('files');
  if (Array.isArray(filesObj)) {
    for (const f of filesObj) {
      if (!f || typeof f !== 'object') continue;
      const entry = f as { key?: string; path?: string; name?: string; type?: string; url?: string };
      const path = entry.key || entry.path || entry.name || entry.url;
      pushIfFile(explicit, path);
    }
  }
  const deep = deepFindGlb(info);
  if (deep) pushIfFile(explicit, deep);
  const unique = [...new Set(explicit.filter(Boolean))];
  if (!unique.length) return null;
  unique.sort((a, b) => scoreMeshCandidate(b, preferTextured) - scoreMeshCandidate(a, preferTextured));
  return unique[0] ?? null;
}

function buildFallbackKey(info: Record<string, unknown>, preferTextured = true): string | null {
  const accountId =
    (info.accountId as string) ||
    (info.account_id as string) ||
    (info.userId as string) ||
    (info.user_id as string);
  const mapId =
    (info._id as string) || (info.id as string) || (info.mapId as string) || (info.map_id as string);
  if (accountId && mapId) {
    const file = preferTextured ? 'TexturedMesh.glb' : 'Mesh.glb';
    return `${accountId}/${mapId}/Mesh/${file}`;
  }
  return null;
}

function scoreMeshCandidate(path: string, preferTextured: boolean): number {
  const p = path.toLowerCase();
  let s = 0;
  if (p.endsWith('.glb')) s += 6;
  if (preferTextured) {
    if (p.includes('texturedmesh')) s += 180;
    else if (p.includes('textured')) s += 120;
  } else if (p.includes('texturedmesh')) {
    s -= 55;
  }
  if (p.includes('/mesh/')) s += 15;
  if (p.includes('navmesh') || p.includes('collision')) s -= 90;
  return s;
}

function deepFindGlb(obj: unknown, depth = 0): string | null {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const val = rec[key];
    if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower.endsWith('.glb') || lower.endsWith('.gltf')) return val;
      if (lower.includes('/mesh/') && (lower.includes('.glb') || lower.includes('.gltf'))) return val;
    } else if (typeof val === 'object' && val !== null) {
      const found = deepFindGlb(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchGlbViaProxy(downloadUrl: string, postUrl: string): Promise<ArrayBuffer> {
  const proxyRes = await fetchWithTimeout(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: downloadUrl }),
  });
  if (!proxyRes.ok) {
    const hint = await proxyRes.text().catch(() => '');
    if (proxyRes.status === 546 || /WORKER_RESOURCE_LIMIT/i.test(hint)) {
      throw new Error(
        'GLB is too large for the cloud edge proxy (546). Restart with npm run dev so Vite streams the file locally, or use a smaller mesh.',
      );
    }
    throw new Error(`GLB proxy download failed (${proxyRes.status}): ${hint.slice(0, 200)}`);
  }
  return proxyRes.arrayBuffer();
}

async function fetchGlbArrayBuffer(downloadUrl: string, glbCorsProxyPostUrl?: string): Promise<ArrayBuffer> {
  const postUrl =
    typeof glbCorsProxyPostUrl === 'string' && glbCorsProxyPostUrl.trim() !== ''
      ? glbCorsProxyPostUrl.trim()
      : import.meta.env.DEV
        ? '/api/proxy-external-fetch'
        : undefined;

  if (postUrl) {
    try {
      return await fetchGlbViaProxy(downloadUrl, postUrl);
    } catch (proxyErr) {
      if (!import.meta.env.DEV) throw proxyErr;
      console.warn('[multiset] GLB proxy failed, trying direct fetch:', proxyErr);
    }
  }

  try {
    const direct = await fetchWithTimeout(downloadUrl, { redirect: 'follow' });
    if (direct.ok) return direct.arrayBuffer();
    throw new Error(`GLB direct download failed (${direct.status})`);
  } catch (err) {
    if (postUrl) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GLB download blocked by CORS (${msg}). Run ./start.sh or npm run dev (local GLB proxy) or set glbCorsProxyPostUrl.`,
    );
  }
}

async function tryDownload(
  token: string,
  key: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl?: string,
): Promise<ArrayBuffer | null> {
  const fileFetchUrl = endpoints.proxyBase
    ? multisetProxyUrl(endpoints.proxyBase, '/v1/file', { key })
    : `${endpoints.fileUrl}?key=${encodeURIComponent(key)}`;
  const fileRes = await fetchWithTimeout(fileFetchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) return null;
  const fileData = (await readJsonResponse(fileRes)) as Record<string, string | undefined>;
  const downloadUrl =
    fileData.url || fileData.downloadUrl || fileData.signedUrl || fileData.presignedUrl;
  if (!downloadUrl) return null;
  return fetchGlbArrayBuffer(downloadUrl, glbCorsProxyPostUrl);
}

function orderMeshKeysForDownload(meshKey: string, preferSmaller = false): string[] {
  const key = String(meshKey || '');
  if (!key) return [];
  const textured = key.replace(/\/mesh\/mesh\.glb$/i, '/Mesh/TexturedMesh.glb');
  const plain = key.replace(/\/mesh\/texturedmesh\.glb$/i, '/Mesh/Mesh.glb');
  const isKnownMeshPath =
    /\/mesh\/texturedmesh\.glb$/i.test(key) || /\/mesh\/mesh\.glb$/i.test(key);
  if (!isKnownMeshPath) return [key];
  const out: string[] = [];
  const add = (k: string) => {
    if (k && out.indexOf(k) < 0) out.push(k);
  };
  if (preferSmaller) {
    add(plain);
    add(textured);
  } else {
    add(textured);
    add(plain);
  }
  add(key);
  return out;
}

export type MapSetPose = {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
};

export type MapSetMeshEntry = {
  mapCode: string;
  mapName?: string;
  order: number;
  relativePose: MapSetPose | null;
  glbBuffer: ArrayBuffer | null;
  error?: string | null;
};

/** MultiSet map-set poses are left-handed; Three.js uses right-handed coordinates. */
export function convertMapSetPoseToThree(relativePose: MapSetPose | null): MapSetPose | null {
  if (!relativePose) return null;
  const { position, quaternion } = relativePose;
  return {
    position: {
      x: -Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
    },
    quaternion: {
      x: Number(quaternion.x),
      y: -Number(quaternion.y),
      z: -Number(quaternion.z),
      w: Number(quaternion.w),
    },
  };
}

type MapSetRow = {
  mapCode: string;
  mapName: string;
  order: number;
  relativePose: MapSetPose | null;
  meshLinks: { textured: string | null; raw: string | null };
};

function matrixToPose(m: number[]): MapSetPose {
  const tx = m[12] ?? 0;
  const ty = m[13] ?? 0;
  const tz = m[14] ?? 0;
  const m00 = m[0];
  const m01 = m[4];
  const m02 = m[8];
  const m10 = m[1];
  const m11 = m[5];
  const m12 = m[9];
  const m20 = m[2];
  const m21 = m[6];
  const m22 = m[10];
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return {
    position: { x: tx, y: ty, z: tz },
    quaternion: { x, y, z, w },
  };
}

function parseRelativePose(row: Record<string, unknown>): MapSetPose | null {
  const pose =
    row.relativePose ?? row.relative_pose ?? row.pose ?? row.transform;
  if (!pose || typeof pose !== 'object') return null;
  if (Array.isArray(pose) && pose.length >= 16) {
    return matrixToPose(pose as number[]);
  }
  const poseObj = pose as Record<string, unknown>;
  if (Array.isArray(poseObj.matrix) && (poseObj.matrix as number[]).length >= 16) {
    return matrixToPose(poseObj.matrix as number[]);
  }
  if (Array.isArray(poseObj.transform) && (poseObj.transform as number[]).length >= 16) {
    return matrixToPose(poseObj.transform as number[]);
  }
  const pos = (poseObj.position ?? poseObj.translation ?? {}) as Record<string, number | undefined>;
  const rot = (poseObj.rotation ?? poseObj.quaternion ?? poseObj.orientation ?? {}) as Record<
    string,
    number | undefined
  >;
  return {
    position: {
      x: Number(pos.x ?? pos[0] ?? 0),
      y: Number(pos.y ?? pos[1] ?? 0),
      z: Number(pos.z ?? pos[2] ?? 0),
    },
    quaternion: {
      x: Number(rot.qx ?? rot.x ?? rot[0] ?? 0),
      y: Number(rot.qy ?? rot.y ?? rot[1] ?? 0),
      z: Number(rot.qz ?? rot.z ?? rot[2] ?? 0),
      w: Number(rot.qw ?? rot.w ?? rot[3] ?? 1),
    },
  };
}

async function fetchMapSetRows(
  token: string,
  mapSetCode: string,
  endpoints: MultiSetEndpoints,
): Promise<MapSetRow[]> {
  const mapSetUrl = endpoints.proxyBase
    ? multisetProxyUrl(endpoints.proxyBase, `/v1/vps/map-set/${encodeURIComponent(mapSetCode)}`)
    : `${endpoints.mapSetBaseUrl}/${encodeURIComponent(mapSetCode)}`;
  const res = await fetchWithTimeout(mapSetUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      res.status === 404
        ? 'MapSet not found. Use an MSET_* code or a MAP_* code from the MultiSet portal.'
        : `Failed to resolve MapSet (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const data = (await readJsonResponse(res)) as Record<string, unknown>;
  const mapSet =
    (data.mapSet as Record<string, unknown> | undefined) ??
    ((data.data as Record<string, unknown> | undefined)?.mapSet as Record<string, unknown> | undefined) ??
    data;
  const rows = (mapSet?.mapSetData ?? mapSet?.maps ?? []) as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('MapSet has no maps — cannot download mesh.');
  }
  const parsed: MapSetRow[] = [];
  for (const row of rows) {
    const mapCode = (row?.map as { mapCode?: string } | undefined)?.mapCode ?? row?.mapCode;
    if (!mapCode || !String(mapCode).startsWith('MAP_')) continue;
    const mapMesh =
      (row?.map as { mapMesh?: Record<string, unknown> } | undefined)?.mapMesh ??
      (row?.mapMesh as Record<string, unknown> | undefined);
    const textured = mapMesh?.texturedMesh as { meshLink?: string } | undefined;
    const raw = mapMesh?.rawMesh as { meshLink?: string } | undefined;
    parsed.push({
      mapCode: String(mapCode),
      mapName: String(
        (row?.map as { name?: string } | undefined)?.name ?? row?.mapName ?? row?.name ?? mapCode,
      ),
      order: Number.isFinite(row.order as number) ? (row.order as number) : parsed.length,
      relativePose: parseRelativePose(row),
      meshLinks: {
        textured: textured?.meshLink ?? null,
        raw: raw?.meshLink ?? null,
      },
    });
  }
  if (!parsed.length) {
    throw new Error('Could not read any MAP_* codes from MapSet response.');
  }
  parsed.sort((a, b) => a.order - b.order);
  return parsed;
}

async function downloadSingleMapMesh(
  token: string,
  mapCode: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl: string | undefined,
  preferTextured: boolean,
  meshLinks: { textured: string | null; raw: string | null } | null = null,
): Promise<ArrayBuffer | null> {
  const cachedGlb = await readCachedGlb(mapCode);
  if (cachedGlb) return cachedGlb;

  const tried = new Set<string>();
  const preferredKeys: string[] = [];
  if (preferTextured && meshLinks?.textured) preferredKeys.push(meshLinks.textured);
  if (!preferTextured && meshLinks?.raw) preferredKeys.push(meshLinks.raw);
  if (preferTextured && meshLinks?.raw) preferredKeys.push(meshLinks.raw);
  if (!preferTextured && meshLinks?.textured) preferredKeys.push(meshLinks.textured);

  for (const key of preferredKeys) {
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const result = await tryDownload(token, key, endpoints, glbCorsProxyPostUrl);
    if (result) {
      void writeCachedGlb(mapCode, result);
      return result;
    }
  }

  const mapUrl = endpoints.proxyBase
    ? multisetProxyUrl(endpoints.proxyBase, `/v1/vps/map/${encodeURIComponent(mapCode)}`)
    : `${endpoints.mapInfoBaseUrl}/${encodeURIComponent(mapCode)}`;
  const mapInfoRes = await fetchWithTimeout(mapUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!mapInfoRes.ok) return null;

  const rawInfo = (await readJsonResponse(mapInfoRes)) as Record<string, unknown>;
  const mapInfo = unwrapMapInfo(rawInfo);
  const meshKey = findMeshKey(mapInfo, preferTextured);
  if (meshKey) {
    for (const key of orderMeshKeysForDownload(meshKey, !preferTextured)) {
      if (!key || tried.has(key)) continue;
      tried.add(key);
      const result = await tryDownload(token, key, endpoints, glbCorsProxyPostUrl);
      if (result) {
        void writeCachedGlb(mapCode, result);
        return result;
      }
    }
  }

  const fallbackKey = buildFallbackKey(mapInfo, preferTextured);
  if (fallbackKey && !tried.has(fallbackKey)) {
    const result = await tryDownload(token, fallbackKey, endpoints, glbCorsProxyPostUrl);
    if (result) {
      void writeCachedGlb(mapCode, result);
      return result;
    }
  }
  return null;
}

async function downloadMapSetRow(
  token: string,
  row: MapSetRow,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl: string | undefined,
  preferTextured: boolean,
): Promise<MapSetMeshEntry> {
  const label = row.mapName || row.mapCode;
  try {
    let glbBuffer = await downloadSingleMapMesh(
      token,
      row.mapCode,
      endpoints,
      glbCorsProxyPostUrl,
      preferTextured,
      row.meshLinks,
    );
    if (!glbBuffer && preferTextured) {
      glbBuffer = await downloadSingleMapMesh(
        token,
        row.mapCode,
        endpoints,
        glbCorsProxyPostUrl,
        false,
        row.meshLinks,
      );
    }
    const entry: MapSetMeshEntry = {
      mapCode: row.mapCode,
      mapName: row.mapName,
      order: row.order,
      relativePose: convertMapSetPoseToThree(row.relativePose),
      glbBuffer,
      error: glbBuffer ? null : 'Mesh unavailable',
    };
    if (glbBuffer) {
      console.log(`[multiset] ${label} (${row.mapCode}, order ${row.order}) loaded`);
    } else {
      console.warn(`[multiset] ${label} (${row.mapCode}, order ${row.order}): mesh unavailable`);
    }
    return entry;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[multiset] ${label} (${row.mapCode}, order ${row.order}) failed:`, message);
    return {
      mapCode: row.mapCode,
      mapName: row.mapName,
      order: row.order,
      relativePose: convertMapSetPoseToThree(row.relativePose),
      glbBuffer: null,
      error: message,
    };
  }
}

export type LazyMapMeshLoadOptions = {
  preferSmallerMesh?: boolean;
  preferTextured?: boolean;
  /** Download this many meshes before background phase (default 1). */
  eagerCount?: number;
  backgroundConcurrency?: number;
  onProgress?: (done: number, total: number, label: string, phase: 'eager' | 'background') => void;
  onEntry?: (entry: MapSetMeshEntry, index: number, total: number) => void | Promise<void>;
  /** Wait before parsing/attaching each mesh (e.g. while floor slice rebuild runs). */
  waitBeforeAttach?: () => void | Promise<void>;
};

/**
 * Lazy map load: fetch metadata, download the first mesh(es) immediately, then
 * stream the rest in the background. UI can render after the first onEntry callback.
 */
export async function lazyLoadMapMeshes(
  token: string,
  mapOrSetCode: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl?: string,
  options: LazyMapMeshLoadOptions = {},
): Promise<MapSetMeshEntry[]> {
  const code = mapOrSetCode.trim();
  const preferTextured =
    typeof options.preferTextured === 'boolean' ? options.preferTextured : !options.preferSmallerMesh;
  const eagerCount = Math.max(1, options.eagerCount ?? MAP_LAZY_EAGER_COUNT);
  const bgConcurrency = options.backgroundConcurrency ?? MAP_LAZY_BACKGROUND_CONCURRENCY;

  if (!code.toUpperCase().startsWith('MSET_')) {
    let glbBuffer = await downloadSingleMapMesh(token, code, endpoints, glbCorsProxyPostUrl, preferTextured);
    if (!glbBuffer && preferTextured) {
      glbBuffer = await downloadSingleMapMesh(token, code, endpoints, glbCorsProxyPostUrl, false);
    }
    const entry: MapSetMeshEntry = {
      mapCode: code,
      order: 0,
      relativePose: null,
      glbBuffer,
      error: glbBuffer ? null : 'Mesh unavailable',
    };
    options.onProgress?.(1, 1, code, 'eager');
    await options.onEntry?.(entry, 0, 1);
    return [entry];
  }

  const rows = await fetchMapSetRows(token, code, endpoints);
  const total = rows.length;
  console.log(`[multiset] lazy load ${total} map(s) from ${code} (eager ${eagerCount}, then ${bgConcurrency} parallel)`);

  const entries: MapSetMeshEntry[] = new Array(total);
  let completed = 0;
  let attachChain: Promise<void> = Promise.resolve();

  const queueMeshAttach = (fn: () => void | Promise<void>): Promise<void> => {
    const run = attachChain.then(async () => {
      await options.waitBeforeAttach?.();
      await fn();
      await yieldToMain();
    });
    attachChain = run.catch(() => {});
    return run;
  };

  const deliver = async (entry: MapSetMeshEntry, index: number, phase: 'eager' | 'background') => {
    entries[index] = entry;
    completed++;
    options.onProgress?.(completed, total, entry.mapName || entry.mapCode, phase);
    await queueMeshAttach(async () => {
      await options.onEntry?.(entry, index, total);
    });
  };

  const eagerRows = rows.slice(0, Math.min(eagerCount, total));
  for (let i = 0; i < eagerRows.length; i++) {
    const entry = await downloadMapSetRow(token, eagerRows[i], endpoints, glbCorsProxyPostUrl, preferTextured);
    await deliver(entry, i, 'eager');
  }

  const rest = rows.slice(eagerRows.length);
  if (rest.length) {
    await runPool(
      rest.map((row, offset) => ({ row, index: offset + eagerRows.length })),
      bgConcurrency,
      async ({ row, index }) => {
        const entry = await downloadMapSetRow(token, row, endpoints, glbCorsProxyPostUrl, preferTextured);
        await deliver(entry, index, 'background');
      },
    );
  }

  const loaded = entries.filter((entry) => entry?.glbBuffer).length;
  console.log(`[multiset] ${code}: ${loaded}/${total} map mesh(es) loaded (lazy)`);
  return entries.filter(Boolean);
}

/** Download every map in a MAP_* code or MSET_* map set (Navme_Dashboard-compatible). */
export async function downloadMapSetMeshes(
  token: string,
  mapOrSetCode: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl?: string,
  options: {
    preferSmallerMesh?: boolean;
    preferTextured?: boolean;
    concurrency?: number;
    onProgress?: (done: number, total: number, label: string) => void;
  } = {},
): Promise<MapSetMeshEntry[]> {
  const code = mapOrSetCode.trim();
  const preferTextured =
    typeof options.preferTextured === 'boolean' ? options.preferTextured : !options.preferSmallerMesh;

  if (!code.toUpperCase().startsWith('MSET_')) {
    let glbBuffer = await downloadSingleMapMesh(
      token,
      code,
      endpoints,
      glbCorsProxyPostUrl,
      preferTextured,
    );
    if (!glbBuffer && preferTextured) {
      glbBuffer = await downloadSingleMapMesh(token, code, endpoints, glbCorsProxyPostUrl, false);
    }
    return [
      {
        mapCode: code,
        order: 0,
        relativePose: null,
        glbBuffer,
        error: glbBuffer ? null : 'Mesh unavailable',
      },
    ];
  }

  const rows = await fetchMapSetRows(token, code, endpoints);
  const concurrency = options.concurrency ?? MAP_DOWNLOAD_CONCURRENCY;
  console.log(`[multiset] loading ${rows.length} map(s) from ${code} (${concurrency} parallel)`);

  let completed = 0;
  const entries = await runPool(rows, concurrency, async (row) => {
    const label = row.mapName || row.mapCode;
    try {
      let glbBuffer = await downloadSingleMapMesh(
        token,
        row.mapCode,
        endpoints,
        glbCorsProxyPostUrl,
        preferTextured,
        row.meshLinks,
      );
      if (!glbBuffer && preferTextured) {
        glbBuffer = await downloadSingleMapMesh(
          token,
          row.mapCode,
          endpoints,
          glbCorsProxyPostUrl,
          false,
          row.meshLinks,
        );
      }
      const threePose = convertMapSetPoseToThree(row.relativePose);
      const entry: MapSetMeshEntry = {
        mapCode: row.mapCode,
        mapName: row.mapName,
        order: row.order,
        relativePose: threePose,
        glbBuffer,
        error: glbBuffer ? null : 'Mesh unavailable',
      };
      if (glbBuffer) {
        console.log(`[multiset] ${label} (${row.mapCode}, order ${row.order}) loaded`);
      } else {
        console.warn(`[multiset] ${label} (${row.mapCode}, order ${row.order}): mesh unavailable`);
      }
      completed++;
      options.onProgress?.(completed, rows.length, label);
      return entry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[multiset] ${label} (${row.mapCode}, order ${row.order}) failed:`, message);
      return {
        mapCode: row.mapCode,
        mapName: row.mapName,
        order: row.order,
        relativePose: convertMapSetPoseToThree(row.relativePose),
        glbBuffer: null,
        error: message,
      } satisfies MapSetMeshEntry;
    }
  });

  entries.sort((a, b) => a.order - b.order);

  const loaded = entries.filter((entry) => entry.glbBuffer).length;
  console.log(`[multiset] ${code}: ${loaded}/${entries.length} map mesh(es) loaded`);
  return entries;
}

export async function downloadMapMesh(
  token: string,
  mapCode: string,
  endpoints: MultiSetEndpoints,
  glbCorsProxyPostUrl?: string,
  options: { preferSmallerMesh?: boolean } = {},
): Promise<ArrayBuffer | null> {
  const entries = await downloadMapSetMeshes(token, mapCode, endpoints, glbCorsProxyPostUrl, options);
  const first = entries.find((entry) => entry.glbBuffer);
  return first?.glbBuffer ?? null;
}
