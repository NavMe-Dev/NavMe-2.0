/**
 * Shared georeference transform for MatterPak meshes.
 *
 * One alignment per Matterport model: where the model's OBJ origin sits on
 * Earth, how far its +Y axis is rotated from true north, and what ground
 * altitude its Z=0 plane corresponds to. The alignment tool writes it, the
 * coordinate sampler reads it.
 *
 * This exists because Matterport will not give us the transform. Its
 * `geocoordinates` field carries a real true-north rotation quaternion, but it
 * returns `organization.policy.disabled` on this account, leaving only a single
 * `geolocation` lat/long with a null altitude and no bearing. Heading and
 * altitude are therefore operator-supplied, which is exactly what the map
 * alignment tool is for.
 */

const KEY_PREFIX = 'navme.matterpak.align.';

/**
 * @typedef {object} Alignment
 * @property {string} modelId
 * @property {number} lat     Latitude of the model's OBJ origin.
 * @property {number} lon     Longitude of the model's OBJ origin.
 * @property {number} heading Compass bearing, in degrees, of the model's +Y axis.
 * @property {number} altitude Metres above sea level of the model's Z=0 plane.
 * @property {number} scale   Multiplier on model units; 1 means true metres.
 * @property {string} [savedAt]
 */

/**
 * @param {string} modelId
 * @returns {Alignment | null}
 */
export function loadAlignment(modelId) {
  if (!modelId) return null;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + modelId);
    if (!raw) return null;
    const a = JSON.parse(raw);
    if (!Number.isFinite(a?.lat) || !Number.isFinite(a?.lon)) return null;
    return {
      modelId,
      lat: Number(a.lat),
      lon: Number(a.lon),
      heading: Number(a.heading) || 0,
      altitude: Number(a.altitude) || 0,
      scale: Number(a.scale) || 1,
      savedAt: a.savedAt,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} modelId
 * @param {Omit<Alignment, 'modelId' | 'savedAt'>} t
 * @returns {Alignment}
 */
export function saveAlignment(modelId, t) {
  const a = {
    modelId,
    lat: Number(t.lat),
    lon: Number(t.lon),
    heading: Number(t.heading) || 0,
    altitude: Number(t.altitude) || 0,
    scale: Number(t.scale) || 1,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY_PREFIX + modelId, JSON.stringify(a));
  return a;
}

/** @param {string} modelId */
export function clearAlignment(modelId) {
  localStorage.removeItem(KEY_PREFIX + modelId);
}

// ── local tangent plane ──────────────────────────────────────────────────────
// A full geodetic solution is unnecessary at building scale: across a few
// hundred metres this series is accurate to centimetres, far below the error
// introduced by eyeballing the heading against satellite imagery.

/** Metres per degree of latitude. @param {number} phi */
export function mPerDegLat(phi) {
  const r = (phi * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r) - 0.0023 * Math.cos(6 * r);
}

/** Metres per degree of longitude. @param {number} phi */
export function mPerDegLon(phi) {
  const r = (phi * Math.PI) / 180;
  return 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r) + 0.118 * Math.cos(5 * r);
}

/**
 * Model ground coordinates to East/North metres.
 *
 * At heading 0 the model is ENU-aligned (+Y north, +X east); increasing the
 * heading turns the model clockwise seen from above.
 *
 * @param {number} x OBJ X
 * @param {number} y OBJ Y
 * @param {number} heading degrees
 * @param {number} [scale]
 */
export function objToEastNorth(x, y, heading, scale = 1) {
  const h = (heading * Math.PI) / 180;
  return {
    east: (x * Math.cos(h) + y * Math.sin(h)) * scale,
    north: (-x * Math.sin(h) + y * Math.cos(h)) * scale,
  };
}

/**
 * OBJ point (Z-up, metres) to WGS84 under a given alignment.
 *
 * @param {{ x: number, y: number, z: number }} p
 * @param {Alignment} a
 */
export function objToWgs84(p, a) {
  const { east, north } = objToEastNorth(p.x, p.y, a.heading, a.scale);
  return {
    lat: a.lat + north / mPerDegLat(a.lat),
    lon: a.lon + east / mPerDegLon(a.lat),
    alt: a.altitude + p.z * a.scale,
    east,
    north,
  };
}

/**
 * Inverse: WGS84 back to model OBJ coordinates. Used when placing something
 * from a map click into the model's own space.
 *
 * @param {{ lat: number, lon: number, alt?: number }} g
 * @param {Alignment} a
 */
export function wgs84ToObj(g, a) {
  const north = (g.lat - a.lat) * mPerDegLat(a.lat);
  const east = (g.lon - a.lon) * mPerDegLon(a.lat);
  const h = (a.heading * Math.PI) / 180;
  const s = a.scale || 1;
  // Inverse rotation of objToEastNorth.
  return {
    x: (east * Math.cos(h) - north * Math.sin(h)) / s,
    y: (east * Math.sin(h) + north * Math.cos(h)) / s,
    z: ((g.alt ?? a.altitude) - a.altitude) / s,
  };
}
