/**
 * From → To routing over the project's Recast navmesh, using real NavMe POIs.
 *
 * Coordinate note, because this is the thing that trips people up:
 * `navme_pois.pos_x/pos_y/pos_z` are **metres in Matterport Showcase space**,
 * not latitude/altitude/longitude. Measured over the 307 active GCU POIs:
 *
 *     pos_x  -84.59 .. 157.13   (241.7 m across)
 *     pos_y   -4.27 ..  21.47   ( 25.7 m — this one IS height)
 *     pos_z -110.98 ..  60.11   (171.1 m across)
 *
 * A latitude column would read 13.02xxxx on every row and a longitude column
 * 77.70xxxx; these are building-scale metres. Only the Y-is-height half of the
 * lat/alt/long reading holds.
 *
 * Showcase space is Y-up and matches this page's three.js world space exactly,
 * because the model root already carries the -90 deg X rotation that turns the
 * Z-up OBJ into Y-up. So POIs drop straight into the scene at their stored
 * values with no conversion, and the navmesh — generated in the same space —
 * lines up with them.
 */
import * as THREE from 'three';
import { NavMeshQuery } from 'recast-navigation';
import { ensureRecastLoaded, loadNavMeshFromUrl, getNavMesh } from './ar/navigation-mesh.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Matterport model -> NavMe poi_type. */
const MODEL_TO_POI_TYPE = { jdjvM17BPEh: 'GCU' };

/** Recast needs a search box around a query point; 2 m vertical covers floors. */
const HALF_EXTENTS = { x: 2, y: 2, z: 2 };

/**
 * @param {string} path
 * @param {Record<string,string>} params
 */
async function rest(path, params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

/** @param {string} modelId */
export function poiTypeForModel(modelId) {
  return MODEL_TO_POI_TYPE[modelId] ?? null;
}

/**
 * Active POIs for a project, in Showcase space.
 * @param {string} poiType
 */
export async function fetchPois(poiType) {
  const rows = await rest('navme_pois', {
    select: 'id,poi_name,pos_x,pos_y,pos_z',
    poi_type: `eq.${poiType}`,
    is_active: 'is.true',
    order: 'poi_name.asc',
  });
  return rows
    .map((r) => ({
      id: String(r.id),
      name: String(r.poi_name ?? '').trim() || '(unnamed)',
      x: Number(r.pos_x),
      y: Number(r.pos_y),
      z: Number(r.pos_z),
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
}

/**
 * URL of the project's active uploaded navmesh, if it has one.
 * @param {string} poiType
 */
export async function fetchNavmeshUrl(poiType) {
  const rows = await rest('navme_media', {
    select: 'label,media_url,updated_at',
    poi_type: `eq.${poiType}`,
    media_type: 'eq.navmesh',
    is_active: 'is.true',
    order: 'updated_at.desc',
    limit: '1',
  });
  return rows[0]?.media_url ?? null;
}

/** @param {string} url */
export async function loadNavmesh(url) {
  await ensureRecastLoaded();
  await loadNavMeshFromUrl(url);
  return getNavMesh();
}

/**
 * Straight port of the Zappar NavigationRoute inner loop: snap both ends onto
 * the mesh, then computePath. Recast occasionally returns a partial path, so a
 * result that stops short of the destination is reported rather than drawn as
 * if it were complete.
 *
 * @param {{x:number,y:number,z:number}} from Showcase space
 * @param {{x:number,y:number,z:number}} to   Showcase space
 * @returns {{ ok: boolean, path?: THREE.Vector3[], lengthM?: number, partial?: boolean, error?: string }}
 */
export function computeRoute(from, to) {
  const navMesh = getNavMesh();
  if (!navMesh) return { ok: false, error: 'No navmesh loaded' };

  let q;
  try {
    q = new NavMeshQuery(navMesh);
    q.defaultQueryHalfExtents = { ...HALF_EXTENTS };
  } catch (e) {
    return { ok: false, error: `NavMeshQuery failed: ${e.message}` };
  }

  const a = q.findClosestPoint(from);
  const b = q.findClosestPoint(to);
  if (!a?.point) return { ok: false, error: 'Start point is not on the navmesh' };
  if (!b?.point) return { ok: false, error: 'Destination is not on the navmesh' };

  let res;
  try {
    res = q.computePath(a.point, b.point);
  } catch (e) {
    return { ok: false, error: `computePath failed: ${e.message}` };
  }

  const raw = Array.isArray(res) ? res : res?.path;
  if (!raw?.length) return { ok: false, error: 'No path between those points' };

  const path = raw.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  let lengthM = 0;
  for (let i = 1; i < path.length; i += 1) lengthM += path[i].distanceTo(path[i - 1]);

  // If the walk ends far from where we asked to go, the mesh is disconnected.
  const endGap = path[path.length - 1].distanceTo(new THREE.Vector3(b.point.x, b.point.y, b.point.z));
  return { ok: true, path, lengthM, partial: endGap > 2 };
}

/** How far the snapped point sat from the requested one — a mesh-coverage check. */
export function snapDistance(p) {
  const navMesh = getNavMesh();
  if (!navMesh) return null;
  try {
    const q = new NavMeshQuery(navMesh);
    q.defaultQueryHalfExtents = { ...HALF_EXTENTS };
    const r = q.findClosestPoint(p);
    if (!r?.point) return null;
    return Math.hypot(r.point.x - p.x, r.point.y - p.y, r.point.z - p.z);
  } catch {
    return null;
  }
}
