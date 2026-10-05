/**
 * MultiSet Map Download
 * 1. MAP_*  → GET /v1/vps/map/{mapCode}
 * 2. MSET_* → GET /v1/vps/map-set/{mapSetCode} → all MAP_* from mapSetData + relativePose
 * 3. GET /v1/file?key={key} → pre-signed URL → GLB bytes
 *
 * Mesh keys: prefers TexturedMesh / textured GLB over wireframe or navmesh assets.
 */
import { multisetApiUrl, multisetFetch } from './multiset-origin.js';
import { parseJsonResponse } from '../utils/parse-json-response.js';

// Default to textured meshes so maps render with their authored colors.
// Set VITE_PREFER_TEXTURED_MESH=false only when debugging heavy assets.
function resolvePreferTextured(override) {
  if (typeof override === 'boolean') return override;
  const rawPreferTextured = String(import.meta.env.VITE_PREFER_TEXTURED_MESH || '').toLowerCase().trim();
  return rawPreferTextured === '' ? true : rawPreferTextured === 'true';
}

/**
 * MultiSet API map-set poses are left-handed; Three.js uses a right-handed system.
 * Same conversion as @zcomponent/three-multiset MultiSetModel.
 * @param {MapSetRow['relativePose']} relativePose
 */
export function convertMapSetPoseToThree(relativePose) {
  if (!relativePose) {
    return {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
  }
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

/**
 * @typedef {Object} MapSetMeshEntry
 * @property {string} mapCode
 * @property {string} [mapName]
 * @property {number} order
 * @property {{ position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number } } | null} relativePose
 * @property {ArrayBuffer|null} glbBuffer
 * @property {string|null} [error]
 */

/**
 * Download every map in a MAP_* code or MSET_* map set.
 * @param {string} token  JWT bearer token
 * @param {string} mapOrSetCode  MAP_* or MSET_* code
 * @param {{ preferTextured?: boolean }} [options]
 * @returns {Promise<MapSetMeshEntry[]>}
 */
export async function downloadMapSetMeshes(token, mapOrSetCode, options = {}) {
  const code = mapOrSetCode.trim();
  const preferTextured = resolvePreferTextured(options.preferTextured);

  if (!code.toUpperCase().startsWith('MSET_')) {
    const glbBuffer = await downloadSingleMapMesh(token, code, preferTextured);
    return [{
      mapCode: code,
      order: 0,
      relativePose: null,
      glbBuffer,
      error: glbBuffer ? null : 'Mesh unavailable',
    }];
  }

  const rows = await fetchMapSetRows(token, code);
  console.log(`[multiset] loading ${rows.length} map(s) from ${code}`);

  /** @type {MapSetMeshEntry[]} */
  const entries = [];
  for (const row of rows) {
    const label = row.mapName || row.mapCode;
    try {
      let glbBuffer = await downloadSingleMapMesh(token, row.mapCode, preferTextured, row.meshLinks);
      if (!glbBuffer && preferTextured) {
        console.log(`[multiset] ${label}: retrying with raw Mesh.glb`);
        glbBuffer = await downloadSingleMapMesh(token, row.mapCode, false, row.meshLinks);
      }
      const threePose = convertMapSetPoseToThree(row.relativePose);
      if (!glbBuffer) {
        console.warn(`[multiset] ${label} (${row.mapCode}, order ${row.order}): mesh unavailable`);
        entries.push({
          mapCode: row.mapCode,
          mapName: row.mapName,
          order: row.order,
          relativePose: threePose,
          glbBuffer: null,
          error: 'Mesh unavailable',
        });
        continue;
      }
      console.log(
        `[multiset] ${label} (${row.mapCode}, order ${row.order}) loaded @ (${threePose.position.x.toFixed(2)}, ${threePose.position.y.toFixed(2)}, ${threePose.position.z.toFixed(2)})`,
      );
      entries.push({
        mapCode: row.mapCode,
        mapName: row.mapName,
        order: row.order,
        relativePose: threePose,
        glbBuffer,
        error: null,
      });
    } catch (err) {
      const message = err?.message || String(err);
      console.warn(`[multiset] ${label} (${row.mapCode}, order ${row.order}) failed:`, message);
      entries.push({
        mapCode: row.mapCode,
        mapName: row.mapName,
        order: row.order,
        relativePose: convertMapSetPoseToThree(row.relativePose),
        glbBuffer: null,
        error: message,
      });
    }
  }

  const loaded = entries.filter((entry) => entry.glbBuffer).length;
  console.log(`[multiset] ${code}: ${loaded}/${entries.length} map mesh(es) loaded`);
  return entries;
}

/**
 * Download the map's 3D file (GLB), preferring textured/color mesh when several keys exist.
 * For MSET_* codes this returns only the primary map (order 0) — prefer downloadMapSetMeshes.
 * @param {string} token  JWT bearer token
 * @param {string} mapOrSetCode  MAP_* or MSET_* code
 * @param {{ preferTextured?: boolean }} [options]  Pass preferTextured:false for the lighter raw Mesh.glb
 * @returns {Promise<ArrayBuffer|null>}  GLB data or null if unavailable
 */
export async function downloadMapMesh(token, mapOrSetCode, options = {}) {
  const entries = await downloadMapSetMeshes(token, mapOrSetCode, options);
  const first = entries.find((entry) => entry.glbBuffer);
  return first?.glbBuffer ?? null;
}

/**
 * @param {string} token
 * @param {string} mapCode
 * @param {boolean} preferTextured
 * @param {{ textured?: string | null, raw?: string | null } | null} [meshLinks]
 * @returns {Promise<ArrayBuffer|null>}
 */
async function downloadSingleMapMesh(token, mapCode, preferTextured, meshLinks = null) {
  const tried = new Set();
  const preferredKeys = [];
  if (preferTextured && meshLinks?.textured) preferredKeys.push(meshLinks.textured);
  if (!preferTextured && meshLinks?.raw) preferredKeys.push(meshLinks.raw);
  if (preferTextured && meshLinks?.raw) preferredKeys.push(meshLinks.raw);
  if (!preferTextured && meshLinks?.textured) preferredKeys.push(meshLinks.textured);

  for (const key of preferredKeys) {
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const result = await tryDownload(token, key);
    if (result) {
      console.log(`[multiset] ${mapCode} downloaded from map-set meshLink:`, key);
      return result;
    }
  }

  const mapInfoRes = await multisetFetch(
    multisetApiUrl(`/v1/vps/map/${encodeURIComponent(mapCode)}`),
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!mapInfoRes.ok) {
    const errText = await mapInfoRes.text().catch(() => '');
    console.warn(`Could not fetch map info for ${mapCode} (${mapInfoRes.status}):`, errText);
    return null;
  }

  const rawInfo = await parseJsonResponse(mapInfoRes, 'Map info');
  if (rawInfo == null) {
    console.warn(`Map info response was empty for ${mapCode}`);
    return null;
  }

  const mapInfo = unwrapMapInfo(rawInfo);
  if (import.meta.env.DEV) {
    console.log(`[multiset] ${mapCode} info keys:`, Object.keys(mapInfo));
  }

  const candidateKeys = rankMeshCandidates(mapInfo, preferTextured);
  for (const meshKey of candidateKeys) {
    const orderedKeys = orderMeshKeysForDownload(meshKey, preferTextured);
    for (const key of orderedKeys) {
      if (!key || tried.has(key)) continue;
      tried.add(key);
      const result = await tryDownload(token, key);
      if (result) {
        console.log(`[multiset] ${mapCode} downloaded:`, key);
        return result;
      }
    }
  }

  const fallbackKey = buildFallbackKey(mapInfo, preferTextured);
  if (fallbackKey && !tried.has(fallbackKey)) {
    console.log(`[multiset] ${mapCode} trying fallback key:`, fallbackKey);
    const result = await tryDownload(token, fallbackKey);
    if (result) return result;
    tried.add(fallbackKey);
    const altFallback = buildFallbackKey(mapInfo, !preferTextured);
    if (altFallback && !tried.has(altFallback)) {
      const altResult = await tryDownload(token, altFallback);
      if (altResult) return altResult;
    }
  }

  console.warn(`[multiset] ${mapCode} no downloadable mesh (${tried.size} key(s) tried)`);
  return null;
}

function orderMeshKeysForDownload(meshKey, preferTextured) {
  const key = String(meshKey || '');
  if (!key) return [];
  const textured = key.replace(/\/mesh\/mesh\.glb$/i, '/Mesh/TexturedMesh.glb');
  const plain = key.replace(/\/mesh\/texturedmesh\.glb$/i, '/Mesh/Mesh.glb');

  const looksTextured = /\/mesh\/texturedmesh\.glb$/i.test(key);
  const looksPlain = /\/mesh\/mesh\.glb$/i.test(key);
  if (!looksTextured && !looksPlain) return [key];

  if (preferTextured) {
    return looksTextured ? [textured, plain] : [textured, plain];
  }
  return looksPlain ? [plain, textured] : [plain, textured];
}

/**
 * @typedef {Object} MapSetRow
 * @property {string} mapCode
 * @property {string} mapName
 * @property {number} order
 * @property {{ position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number } } | null} relativePose
 * @property {{ textured: string | null, raw: string | null }} meshLinks
 */

function unwrapMapInfo(info) {
  if (!info || typeof info !== 'object') return info;
  const nested = info.map ?? info.data?.map;
  if (nested && typeof nested === 'object') {
    return { ...info, ...nested, map: nested };
  }
  return info;
}

/**
 * GET /v1/vps/map-set/{mapSetCode} → sorted map rows with relative poses.
 * @param {string} token
 * @param {string} mapSetCode
 * @returns {Promise<MapSetRow[]>}
 */
async function fetchMapSetRows(token, mapSetCode) {
  const res = await multisetFetch(
    multisetApiUrl(`/v1/vps/map-set/${encodeURIComponent(mapSetCode)}`),
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`MapSet lookup failed (${res.status}):`, body);
    throw new Error(
      res.status === 404
        ? 'MapSet not found. Check the MSET_* code, or use a MAP_* code from Get MapSet details in the portal.'
        : `Failed to resolve MapSet (${res.status})`
    );
  }

  const data = await parseJsonResponse(res, 'Map set');
  if (data == null) {
    throw new Error('MapSet response was empty');
  }
  const mapSet = data.mapSet ?? data.data?.mapSet ?? data;
  const rows = mapSet?.mapSetData ?? mapSet?.maps ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('MapSet has no maps — cannot download mesh.');
  }

  /** @type {MapSetRow[]} */
  const parsed = [];
  for (const row of rows) {
    const mapCode = row?.map?.mapCode ?? row?.mapCode;
    if (!mapCode || !String(mapCode).startsWith('MAP_')) {
      console.warn('[multiset] skipping map-set row without MAP_* code:', row);
      continue;
    }
    const mapMesh = row?.map?.mapMesh ?? row?.mapMesh;
    parsed.push({
      mapCode: String(mapCode),
      mapName: String(row?.map?.name ?? row?.mapName ?? row?.name ?? mapCode),
      order: Number.isFinite(row.order) ? row.order : parsed.length,
      relativePose: parseRelativePose(row),
      meshLinks: {
        textured: mapMesh?.texturedMesh?.meshLink ?? null,
        raw: mapMesh?.rawMesh?.meshLink ?? null,
      },
    });
  }

  if (parsed.length === 0) {
    throw new Error('Could not read any MAP_* codes from MapSet response.');
  }

  parsed.sort((a, b) => a.order - b.order);
  return parsed;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {MapSetRow['relativePose']}
 */
function parseRelativePose(row) {
  const pose = row.relativePose ?? row.relative_pose ?? row.pose ?? row.transform;
  if (!pose || typeof pose !== 'object') return null;

  if (Array.isArray(pose) && pose.length >= 16) {
    return matrixToPose(pose);
  }
  if (Array.isArray(pose.matrix) && pose.matrix.length >= 16) {
    return matrixToPose(pose.matrix);
  }
  if (Array.isArray(pose.transform) && pose.transform.length >= 16) {
    return matrixToPose(pose.transform);
  }

  const pos = /** @type {Record<string, number>} */ (pose.position ?? pose.translation ?? {});
  const rot = /** @type {Record<string, number>} */ (pose.rotation ?? pose.quaternion ?? pose.orientation ?? {});
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

/**
 * Column-major 4x4 matrix → position + quaternion.
 * @param {number[]} m
 */
function matrixToPose(m) {
  const tx = m[12] ?? 0;
  const ty = m[13] ?? 0;
  const tz = m[14] ?? 0;

  const m00 = m[0]; const m01 = m[4]; const m02 = m[8];
  const m10 = m[1]; const m11 = m[5]; const m12 = m[9];
  const m20 = m[2]; const m21 = m[6]; const m22 = m[10];

  const trace = m00 + m11 + m22;
  let x; let y; let z; let w;
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

/**
 * Fetch map metadata without downloading mesh bytes.
 * @param {string} token
 * @param {string} mapCode
 */
export async function fetchMapInfo(token, mapCode) {
  const mapInfoRes = await multisetFetch(
    multisetApiUrl(`/v1/vps/map/${encodeURIComponent(mapCode)}`),
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!mapInfoRes.ok) {
    const errText = await mapInfoRes.text().catch(() => '');
    console.warn(`Could not fetch map info (${mapInfoRes.status}):`, errText);
    throw new Error(`Failed to fetch map info (${mapInfoRes.status})`);
  }

  const rawInfo = await parseJsonResponse(mapInfoRes, 'Map info');
  if (rawInfo == null) {
    throw new Error('Map info response was empty');
  }
  return unwrapMapInfo(rawInfo);
}

/**
 * Resolve plain + textured mesh keys for staged lazy loading (Astra-style).
 * @param {object} mapInfo
 * @param {string} [mapCode]
 * @param {{ textured?: string | null, raw?: string | null } | null} [meshLinks]
 */
export function extractMeshKeys(mapInfo, mapCode = '', meshLinks = null) {
  const candidates = [];
  collectExplicitMeshCandidates(mapInfo, candidates);
  deepCollectGlb(mapInfo, candidates);
  const unique = [...new Set(candidates.filter(Boolean))];

  const plain =
    meshLinks?.raw
    || mapInfo.mapMesh?.rawMesh?.meshLink
    || mapInfo.mapMesh?.rawMesh?.key
    || unique.find((u) => isPlainMeshGlbKey(u))
    || null;
  const textured =
    meshLinks?.textured
    || mapInfo.mapMesh?.texturedMesh?.meshLink
    || mapInfo.mapMesh?.texturedMesh?.key
    || unique.find((u) => /TexturedMesh\.glb$/i.test(String(u)))
    || null;

  const fallbackKey =
    buildFallbackKey(mapInfo, false)
    || chooseBestMeshCandidate(unique, false)
    || null;

  return {
    plainKey: plain,
    texturedKey: textured,
    fallbackKey,
  };
}

/** True for `.../Mesh/Mesh.glb` (not `TexturedMesh.glb`). */
function isPlainMeshGlbKey(path) {
  return /\/Mesh\.glb$/i.test(String(path)) && !/TexturedMesh\.glb$/i.test(String(path));
}

/**
 * Download a mesh file by storage key (optional byte progress).
 * @param {string} token
 * @param {string} key
 * @param {(loaded: number, total: number|null) => void} [onProgress]
 */
export async function downloadMeshByKey(token, key, onProgress) {
  return tryDownload(token, key, onProgress);
}

/**
 * Resolve download plan for MAP_* or MSET_* without fetching GLB bytes.
 * @param {string} token
 * @param {string} mapOrSetCode
 * @returns {Promise<Array<{
 *   mapCode: string,
 *   mapName?: string,
 *   order: number,
 *   relativePose: ReturnType<typeof convertMapSetPoseToThree> | null,
 *   plainKey: string|null,
 *   texturedKey: string|null,
 *   fallbackKey: string|null,
 * }>>}
 */
export async function resolveMapMeshPlan(token, mapOrSetCode) {
  const code = mapOrSetCode.trim();

  if (!code.toUpperCase().startsWith('MSET_')) {
    const mapInfo = await fetchMapInfo(token, code);
    const keys = extractMeshKeys(mapInfo, code);
    return [{
      mapCode: code,
      order: 0,
      relativePose: null,
      ...keys,
    }];
  }

  const rows = await fetchMapSetRows(token, code);
  /** @type {Awaited<ReturnType<typeof resolveMapMeshPlan>>} */
  const plan = [];
  for (const row of rows) {
    let keys = {
      plainKey: row.meshLinks?.raw || null,
      texturedKey: row.meshLinks?.textured || null,
      fallbackKey: null,
    };
    if (!keys.plainKey || !keys.texturedKey) {
      try {
        const mapInfo = await fetchMapInfo(token, row.mapCode);
        keys = extractMeshKeys(mapInfo, row.mapCode, row.meshLinks);
      } catch (err) {
        console.warn(`[multiset] ${row.mapCode}: metadata fetch failed:`, err?.message || err);
      }
    }
    plan.push({
      mapCode: row.mapCode,
      mapName: row.mapName,
      order: row.order,
      relativePose: convertMapSetPoseToThree(row.relativePose),
      ...keys,
    });
  }
  return plan;
}

async function tryDownload(token, key, onProgress) {
  const fileRes = await multisetFetch(multisetApiUrl('/v1/file', { key }), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!fileRes.ok) {
    console.warn(`File URL request failed (${fileRes.status}) for key: ${key}`);
    return null;
  }

  const fileData = await parseJsonResponse(fileRes, 'Map file URL');
  if (fileData == null) {
    console.warn('File URL response was empty for key:', key);
    return null;
  }
  if (import.meta.env.DEV) {
    console.log('[multiset] file response keys:', Object.keys(fileData));
  }

  let downloadUrl =
    fileData.url || fileData.downloadUrl || fileData.signedUrl || fileData.presignedUrl;
  if (!downloadUrl) {
    console.warn('No download URL in file response:', fileData);
    return null;
  }

  if (
    downloadUrl.startsWith('https://prod-multiset.s3-accelerate.amazonaws.com') ||
    downloadUrl.startsWith('https://prod-multiset.s3.amazonaws.com')
  ) {
    if (import.meta.env.DEV) {
      downloadUrl = downloadUrl.replace(
        'https://prod-multiset.s3-accelerate.amazonaws.com',
        '/s3-proxy',
      ).replace(
        'https://prod-multiset.s3.amazonaws.com',
        '/s3-proxy',
      );
    }
  }

  const glbRes = await fetch(downloadUrl);
  if (!glbRes.ok) {
    console.warn(`GLB download failed (${glbRes.status})`);
    return null;
  }

  const total = Number(glbRes.headers.get('content-length')) || null;
  if (!onProgress || !glbRes.body || typeof ReadableStream === 'undefined') {
    const buf = await glbRes.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }

  const reader = glbRes.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Paths the portal / API usually intend as the main viewer mesh — never merge with
 * “everything that looks like .glb” from deep JSON (one map can list huge alternates).
 */
function collectExplicitMeshCandidates(info, out) {
  pushIfFile(out, info.mapMesh?.texturedMesh?.meshLink);
  pushIfFile(out, info.mapMesh?.rawMesh?.meshLink);
  pushIfFile(out, info.texturedMesh?.meshLink);
  pushIfFile(out, info.rawMesh?.meshLink);
  pushIfFile(out, info.meshKey);
  pushIfFile(out, info.meshFileKey);
  pushIfFile(out, info.mesh?.key);
  pushIfFile(out, info.mesh?.fileKey);
  pushIfFile(out, info.glbKey);
  pushIfFile(out, info.fileKey);
  pushIfFile(out, info.data?.meshKey);
  pushIfFile(out, info.map?.meshKey);
  pushIfFile(out, info.offlineBundle?.meshKey);
  pushIfFile(out, info.offlineBundle?.glbKey);
  pushIfFile(out, info.offlineBundle?.key);

  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      if (!f || typeof f !== 'object') continue;
      const path = f.key || f.path || f.name || f.url;
      const role = `${f.type || ''} ${f.role || ''} ${f.category || ''}`.toLowerCase();
      if (path && typeof path === 'string') {
        const lower = path.toLowerCase();
        const looksMesh =
          lower.endsWith('.glb') ||
          lower.endsWith('.gltf') ||
          lower.includes('/mesh/');
        if (!looksMesh) continue;
        if (role && (role.includes('nav') || role.includes('collision') || role.includes('occlusion'))) {
          continue;
        }
      }
      pushIfFile(out, path);
    }
  }
}

function rankMeshCandidates(info, preferTextured) {
  const explicit = [];
  collectExplicitMeshCandidates(info, explicit);
  const deep = [];
  deepCollectGlb(info, deep);
  const unique = [...new Set([...explicit, ...deep].filter(Boolean))];
  if (unique.length === 0) return [];

  unique.sort((a, b) => {
    const d = scoreMeshCandidate(b, preferTextured) - scoreMeshCandidate(a, preferTextured);
    if (d !== 0) return d;
    return String(a).length - String(b).length;
  });

  if (import.meta.env.DEV) {
    console.log(`[multiset] mesh candidates (${unique.length}):`, unique.slice(0, 6).join(' | '));
  }
  return unique;
}

function findMeshKey(info, preferTextured) {
  return rankMeshCandidates(info, preferTextured)[0] ?? null;
}

function buildFallbackKey(info, preferTextured) {
  const accountId = info.accountId || info.account_id || info.userId || info.user_id;
  const mapId = info._id || info.id || info.mapId || info.map_id;

  if (accountId && mapId) {
    const file = preferTextured ? 'TexturedMesh.glb' : 'Mesh.glb';
    return `${accountId}/${mapId}/Mesh/${file}`;
  }
  return null;
}

const DEEP_SKIP_KEYS = new Set([
  'history',
  'versions',
  'changelog',
  'logs',
  'debug',
  'telemetry',
  'events',
  'audit',
  'rawcaptures',
  'pointclouds',
]);

function deepCollectGlb(obj, out, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return;
  for (const [key, val] of Object.entries(obj)) {
    if (DEEP_SKIP_KEYS.has(String(key).toLowerCase())) continue;
    if (typeof val === 'string') {
      pushIfFile(out, val);
    } else if (val && typeof val === 'object') {
      deepCollectGlb(val, out, depth + 1);
    }
  }
}

function pushIfFile(out, value) {
  if (!value || typeof value !== 'string') return;
  const lower = value.toLowerCase();
  if (lower.endsWith('.glb') || lower.endsWith('.gltf') || lower.includes('/mesh/')) {
    out.push(value);
  }
}

function chooseBestMeshCandidate(candidates, preferTextured) {
  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return null;
  unique.sort((a, b) => scoreMeshCandidate(b, preferTextured) - scoreMeshCandidate(a, preferTextured));
  return unique[0] ?? null;
}

function scoreMeshCandidate(path, preferTextured) {
  const p = String(path).toLowerCase();
    let s = 0;
    if (p.endsWith('.glb')) s += 6;
    if (p.endsWith('.gltf')) s += 4;
    if (preferTextured) {
      if (p.includes('texturedmesh')) s += 180;
      else if (p.includes('textured')) s += 120;
      if (p.includes('texture')) s += 100;
    } else {
      if (p.includes('texturedmesh')) s -= 55;
      else if (p.includes('textured')) s -= 20;
      if (p.includes('texture')) s -= 15;
    }
    if (p.includes('albedo') || p.includes('diffuse') || p.includes('color')) s += 60;
    if (p.includes('/mesh/')) s += 15;
    if (p.includes('pointcloud') || p.includes('pcd') || p.includes('.ply') || p.includes('.las')) {
      s -= 120;
    }
    if (p.includes('navmesh') || p.includes('collision') || p.includes('occlusion')) s -= 90;
    if (p.includes('wire') || p.includes('wireframe')) s -= 40;
    if (p.includes('lod0') || p.includes('lod_0') || p.includes('/lod0/')) s -= 35;
    if (p.includes('highpoly') || p.includes('high_poly') || p.includes('fullres') || p.includes('densemesh')) {
      s -= 45;
    }
  if (p.includes('simplified') || p.includes('decimated') || p.includes('preview')) s += 25;
  if (p.includes('bundle') && p.includes('offline')) s -= 30;
  return s;
}
