/**
 * MultiSet VPS Localization Query
 * POST /v1/vps/map/query-form  (multipart/form-data)
 */

import { multisetApiUrl, multisetFetch } from './multiset-origin.js';
import { parseJsonResponse } from '../utils/parse-json-response.js';

const VPS_QUERY_URL = () => multisetApiUrl('/v1/vps/map/query-form');

/**
 * Send a camera frame to MultiSet VPS for localization.
 *
 * @param {string} token  JWT bearer token
 * @param {string} mapCode  MAP_* or MSET_* code
 * @param {Blob}   imageBlob  JPEG image blob from the camera
 * @param {{fx: number, fy: number, px: number, py: number, width: number, height: number}} intrinsics
 * @returns {Promise<{success: boolean, position?: {x:number,y:number,z:number}, quaternion?: {x:number,y:number,z:number,w:number}, confidence?: number, raw?: any}>}
 */
export async function queryVPS(token, mapCode, imageBlob, intrinsics) {
  const fd = new FormData();

  // Auto-detect whether we have a map code or a map-set code
  if (mapCode.startsWith('MSET_')) {
    fd.append('mapSetCode', mapCode);
  } else {
    fd.append('mapCode', mapCode);
  }

  fd.append('queryImage', imageBlob, 'frame.jpg');
  fd.append('fx', String(intrinsics.fx));
  fd.append('fy', String(intrinsics.fy));
  fd.append('px', String(intrinsics.px));
  fd.append('py', String(intrinsics.py));
  fd.append('width', String(intrinsics.width));
  fd.append('height', String(intrinsics.height));
  fd.append('isRightHanded', 'true');

  const res = await multisetFetch(VPS_QUERY_URL(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: fd,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`VPS query failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await parseJsonResponse(res, 'Map VPS');
  if (data == null) {
    throw new Error('VPS query returned an empty body');
  }

  // Parse the pose from the response
  // Common shapes seen: { position: {x,y,z}, rotation: {x,y,z,w}, confidence }
  // or: { pose: { position: [...], orientation: [...] }, confidence }
  const parsed = parsePose(data);
  return { ...parsed, raw: data };
}

/**
 * Normalise the various pose formats MultiSet may return.
 */
function parsePose(data) {
  // Direct position/rotation format
  if (data.position && (data.rotation || data.quaternion || data.orientation)) {
    const pos = data.position;
    const rot = data.rotation || data.quaternion || data.orientation;
    return {
      success: true,
      position: { x: pos.x ?? pos[0], y: pos.y ?? pos[1], z: pos.z ?? pos[2] },
      quaternion: { x: rot.x ?? rot[0], y: rot.y ?? rot[1], z: rot.z ?? rot[2], w: rot.w ?? rot[3] },
      confidence: data.confidence ?? data.score ?? 1,
    };
  }

  // Nested pose object
  if (data.pose) {
    return parsePose(data.pose);
  }

  // Matrix (4x4 column-major or row-major)
  if (data.matrix || data.transform) {
    const m = data.matrix || data.transform;
    // Extract translation from last column (column-major)
    return {
      success: true,
      position: { x: m[12] ?? 0, y: m[13] ?? 0, z: m[14] ?? 0 },
      quaternion: matrixToQuaternion(m),
      confidence: data.confidence ?? data.score ?? 1,
    };
  }

  // Could not parse
  return { success: false, confidence: 0 };
}

/**
 * Extract quaternion from a 4x4 column-major matrix.
 */
function matrixToQuaternion(m) {
  // Simplified extraction from upper-left 3x3 of column-major 4x4
  const trace = m[0] + m[5] + m[10];
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m[6] - m[9]) * s;
    y = (m[8] - m[2]) * s;
    z = (m[1] - m[4]) * s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = 2.0 * Math.sqrt(1.0 + m[0] - m[5] - m[10]);
    w = (m[6] - m[9]) / s;
    x = 0.25 * s;
    y = (m[4] + m[1]) / s;
    z = (m[8] + m[2]) / s;
  } else if (m[5] > m[10]) {
    const s = 2.0 * Math.sqrt(1.0 + m[5] - m[0] - m[10]);
    w = (m[8] - m[2]) / s;
    x = (m[4] + m[1]) / s;
    y = 0.25 * s;
    z = (m[9] + m[6]) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m[10] - m[0] - m[5]);
    w = (m[1] - m[4]) / s;
    x = (m[8] + m[2]) / s;
    y = (m[9] + m[6]) / s;
    z = 0.25 * s;
  }
  return { x, y, z, w };
}
