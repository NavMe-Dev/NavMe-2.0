/**
 * Go-to walk: snap clicks to the walkable navmesh and fly freely between points.
 * Keeps destinations off map edges and aims the camera inward (never looking outside).
 */
import * as THREE from 'three';
import { NavMeshQuery } from 'recast-navigation';
import { ensureRecastLoaded, generateNavMesh, getNavMesh, hasNavMesh, clearNavMesh, ensureNavMeshAvailable } from './navigation-mesh.js';
import { getMapContentBounds, getCamera, getMultisetAnchor } from './scene.js';

const DEFAULT_SAMPLE_COUNT = 500;
export const GOTO_EYE_HEIGHT = 1.55;
/** Keep Go-to feet this far inside the map AABB (meters). */
const EDGE_INSET = 2.5;
/** If within this of an edge, force look toward map center. */
const EDGE_LOOK_BAND = 4.0;
const LOOK_AHEAD = 4.0;

/** @type {THREE.Vector3[]} */
let walkablePoints = [];
/** @type {THREE.Group | null} */
let hiddenPointsRoot = null;
/** @type {Promise<{ ok: boolean, error?: string, count: number }> | null} */
let preparing = null;

export function getWalkableGotoPoints() {
  return walkablePoints;
}

export function clearWalkableGotoPoints() {
  walkablePoints = [];
  if (hiddenPointsRoot?.parent) hiddenPointsRoot.parent.remove(hiddenPointsRoot);
  hiddenPointsRoot = null;
}

const sharedHiddenGeo = new THREE.SphereGeometry(0.05, 4, 4);
const sharedHiddenMat = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Ensure navmesh exists (without showing the green overlay) and sample hidden walkable points.
 * @param {{ count?: number, onProgress?: (msg: string) => void }} [opts]
 */
export async function prepareGotoWalkable(opts = {}) {
  if (preparing) return preparing;
  preparing = (async () => {
    const count = Math.max(50, Number(opts.count) || DEFAULT_SAMPLE_COUNT);
    opts.onProgress?.('Preparing walkable Go-to mesh…');
    await ensureRecastLoaded();

    if (!hasNavMesh()) {
      const result = await ensureNavMeshAvailable({ visualize: false });
      if (!result?.success) {
        return {
          ok: false,
          error: result?.error || 'Could not build walkable navmesh for Go-to',
          count: 0,
        };
      }
    }

    const navMesh = getNavMesh();
    if (!navMesh) return { ok: false, error: 'Navmesh unavailable', count: 0 };

    opts.onProgress?.(`Sampling ${count} walkable points…`);
    const points = sampleWalkablePoints(navMesh, count);
    rebuildHiddenPointMarkers(points);

    return { ok: true, count: points.length };
  })().finally(() => {
    preparing = null;
  });
  return preparing;
}

/** @returns {THREE.Box3 | null} */
function mapBox() {
  const box = getMapContentBounds();
  return box && !box.isEmpty() ? box : null;
}

/** @returns {THREE.Vector3} */
function mapCenter() {
  const box = mapBox();
  return box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
}

/**
 * Pull a point inward from map edges so Go-to never stands on the rim.
 * @param {THREE.Vector3} point
 * @param {number} [inset=EDGE_INSET]
 * @returns {THREE.Vector3}
 */
export function pullGotoInward(point, inset = EDGE_INSET) {
  const box = mapBox();
  const out = point.clone();
  if (!box) return out;

  const size = box.getSize(new THREE.Vector3());
  const mx = Math.min(inset, Math.max(0.15, size.x * 0.2));
  const mz = Math.min(inset, Math.max(0.15, size.z * 0.2));

  out.x = THREE.MathUtils.clamp(out.x, box.min.x + mx, box.max.x - mx);
  out.z = THREE.MathUtils.clamp(out.z, box.min.z + mz, box.max.z - mz);
  return out;
}

/**
 * How close a point is to the map rim (0 = deep inside, 1 = on edge).
 * @param {THREE.Vector3} point
 * @returns {number}
 */
function edgeProximity(point) {
  const box = mapBox();
  if (!box) return 0;
  const dx = Math.min(point.x - box.min.x, box.max.x - point.x);
  const dz = Math.min(point.z - box.min.z, box.max.z - point.z);
  const band = EDGE_LOOK_BAND;
  const px = 1 - THREE.MathUtils.clamp(dx / band, 0, 1);
  const pz = 1 - THREE.MathUtils.clamp(dz / band, 0, 1);
  return Math.max(px, pz);
}

/**
 * True if looking along `dir` (XZ) from `from` would aim outside the map.
 * @param {THREE.Vector3} from
 * @param {THREE.Vector3} dirHoriz normalized XZ
 */
function looksOutsideMap(from, dirHoriz) {
  const box = mapBox();
  if (!box || dirHoriz.lengthSq() < 1e-8) return true;
  const probe = from.clone().addScaledVector(dirHoriz, LOOK_AHEAD * 1.5);
  // Outside AABB on XZ → looking out
  if (
    probe.x < box.min.x ||
    probe.x > box.max.x ||
    probe.z < box.min.z ||
    probe.z > box.max.z
  ) {
    return true;
  }
  return false;
}

/**
 * Horizontal look direction that always faces into the map.
 * @param {THREE.Vector3} feet
 * @param {THREE.Vector3} [preferred] optional preferred forward
 * @returns {THREE.Vector3} normalized XZ direction
 */
function inwardLookDirection(feet, preferred) {
  const center = mapCenter();
  const toCenter = new THREE.Vector3(center.x - feet.x, 0, center.z - feet.z);
  if (toCenter.lengthSq() < 1e-6) {
    toCenter.set(0, 0, -1);
  } else {
    toCenter.normalize();
  }

  const pref = preferred?.clone() ?? new THREE.Vector3(0, 0, -1);
  pref.y = 0;
  if (pref.lengthSq() < 1e-6) pref.copy(toCenter);
  else pref.normalize();

  const nearEdge = edgeProximity(feet) > 0.35;
  if (nearEdge || looksOutsideMap(feet, pref)) {
    return toCenter;
  }
  // Blend slightly toward center when somewhat near edge so we don't glance out.
  const t = edgeProximity(feet) * 0.85;
  return pref.lerp(toCenter, t).normalize();
}

/**
 * @param {import('recast-navigation').NavMesh} navMesh
 * @param {number} count
 * @returns {THREE.Vector3[]}
 */
function sampleWalkablePoints(navMesh, count) {
  const query = new NavMeshQuery(navMesh);
  query.defaultQueryHalfExtents = { x: 80, y: 40, z: 80 };

  const box = mapBox();
  const center = mapCenter();
  const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(40, 10, 40);
  // Sample inside inset bounds so edge points are rare.
  const radius = Math.max(size.x, size.z, 10) * 0.55;

  /** @type {THREE.Vector3[]} */
  const out = [];
  const seen = new Set();

  const pushUnique = (p) => {
    if (!p || !Number.isFinite(p.x)) return;
    const inward = pullGotoInward(new THREE.Vector3(p.x, p.y, p.z));
    // Re-snap inward point onto navmesh when possible
    let final = inward;
    try {
      const closest = query.findClosestPoint(
        { x: inward.x, y: inward.y, z: inward.z },
        { halfExtents: { x: 6, y: 20, z: 6 } },
      );
      if (closest?.success && closest.point) {
        final = pullGotoInward(
          new THREE.Vector3(closest.point.x, closest.point.y, closest.point.z),
        );
      }
    } catch {
      /* keep inward */
    }
    const key = `${final.x.toFixed(2)},${final.y.toFixed(2)},${final.z.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(final);
  };

  for (let i = 0; i < count * 4 && out.length < count; i++) {
    try {
      const r = query.findRandomPointAroundCircle(
        { x: center.x, y: center.y, z: center.z },
        radius,
      );
      if (r?.success && r.randomPoint) pushUnique(r.randomPoint);
    } catch {
      break;
    }
  }

  const nx = Math.max(8, Math.ceil(Math.sqrt(count)));
  const nz = nx;
  const insetBox = box
    ? new THREE.Box3(
        new THREE.Vector3(box.min.x + EDGE_INSET, box.min.y, box.min.z + EDGE_INSET),
        new THREE.Vector3(box.max.x - EDGE_INSET, box.max.y, box.max.z - EDGE_INSET),
      )
    : null;
  const sampleBox = insetBox && !insetBox.isEmpty() ? insetBox : box;
  const sampleSize = sampleBox
    ? sampleBox.getSize(new THREE.Vector3())
    : new THREE.Vector3(40, 10, 40);

  for (let ix = 0; ix < nx && out.length < count; ix++) {
    for (let iz = 0; iz < nz && out.length < count; iz++) {
      const x = sampleBox
        ? sampleBox.min.x + ((ix + 0.5) / nx) * sampleSize.x
        : center.x + (ix / nx - 0.5) * 40;
      const z = sampleBox
        ? sampleBox.min.z + ((iz + 0.5) / nz) * sampleSize.z
        : center.z + (iz / nz - 0.5) * 40;
      const y = center.y;
      try {
        const closest = query.findClosestPoint(
          { x, y, z },
          { halfExtents: { x: 8, y: 30, z: 8 } },
        );
        if (closest?.success && closest.point) pushUnique(closest.point);
      } catch {
        /* skip */
      }
    }
  }

  return out;
}

/** @param {THREE.Vector3[]} points */
function rebuildHiddenPointMarkers(points) {
  if (hiddenPointsRoot?.parent) hiddenPointsRoot.parent.remove(hiddenPointsRoot);
  hiddenPointsRoot = new THREE.Group();
  hiddenPointsRoot.name = 'GotoWalkablePoints';
  hiddenPointsRoot.visible = false;

  walkablePoints = points;
  for (const p of points) {
    const m = new THREE.Mesh(sharedHiddenGeo, sharedHiddenMat);
    m.position.copy(p);
    m.userData.walkable = true;
    hiddenPointsRoot.add(m);
  }

  const parent = getMultisetAnchor();
  if (parent) parent.add(hiddenPointsRoot);
}

/**
 * Snap a world click to the nearest walkable navmesh location (inset from edges).
 * @param {{ x: number, y: number, z: number } | THREE.Vector3} click
 * @returns {THREE.Vector3 | null}
 */
export function snapGotoToWalkable(click) {
  const navMesh = getNavMesh();
  if (!click) return null;

  const sample = {
    x: Number(click.x) || 0,
    y: Number(click.y) || 0,
    z: Number(click.z) || 0,
  };
  // Prefer searching from an already-inset click so edges resolve inward.
  const insetClick = pullGotoInward(new THREE.Vector3(sample.x, sample.y, sample.z));
  const clickV = insetClick.clone();

  /** @type {THREE.Vector3 | null} */
  let best = null;

  if (navMesh) {
    try {
      const query = new NavMeshQuery(navMesh);
      const closest = query.findClosestPoint(
        { x: insetClick.x, y: insetClick.y, z: insetClick.z },
        { halfExtents: { x: 25, y: 40, z: 25 } },
      );
      if (closest?.success && closest.point) {
        best = pullGotoInward(
          new THREE.Vector3(closest.point.x, closest.point.y, closest.point.z),
        );
      }
    } catch {
      /* fall through */
    }
  }

  if (walkablePoints.length) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const p of walkablePoints) {
      const d = p.distanceToSquared(clickV);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p;
      }
    }
    if (nearest) {
      if (!best || nearestDist <= best.distanceToSquared(clickV) * 1.15) {
        best = pullGotoInward(nearest.clone());
      }
    }
  }

  return best;
}

/**
 * Snap a POI / placement click onto the walkable navmesh.
 * Uses a large search radius so off-mesh clicks still land on walkable floor.
 * Does not force edge inset (POIs near walls are allowed).
 * @param {{ x: number, y: number, z: number } | THREE.Vector3} click
 * @returns {THREE.Vector3 | null}
 */
export function snapPlacementToNavMesh(click) {
  if (!click) return null;
  const sample = {
    x: Number(click.x) || 0,
    y: Number(click.y) || 0,
    z: Number(click.z) || 0,
  };
  const clickV = new THREE.Vector3(sample.x, sample.y, sample.z);
  /** @type {THREE.Vector3 | null} */
  let best = null;

  const navMesh = getNavMesh();
  if (navMesh) {
    try {
      const query = new NavMeshQuery(navMesh);
      const closest = query.findClosestPoint(sample, {
        halfExtents: { x: 80, y: 50, z: 80 },
      });
      if (closest?.success && closest.point) {
        best = new THREE.Vector3(
          Number(closest.point.x),
          Number(closest.point.y),
          Number(closest.point.z),
        );
      }
    } catch {
      /* fall through */
    }
  }

  if (walkablePoints.length) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const p of walkablePoints) {
      const d = p.distanceToSquared(clickV);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p;
      }
    }
    if (nearest && (!best || nearestDist < best.distanceToSquared(clickV))) {
      best = nearest.clone();
    }
  }

  return best;
}

/**
 * Ensure the geometric navmesh exists (hidden) for placement snapping.
 * Does NOT sample Go-to walkable points — that is expensive and only needed for walk mode.
 * @param {{ count?: number, force?: boolean, sampleWalkable?: boolean, onProgress?: (msg: string) => void }} [opts]
 */
export async function ensureNavMeshForPlacement(opts = {}) {
  if (hasNavMesh() && !opts.force) {
    if (opts.sampleWalkable && !walkablePoints.length) {
      return prepareGotoWalkable({
        count: Math.max(80, Number(opts.count) || 200),
        onProgress: opts.onProgress,
      });
    }
    return { ok: true, count: walkablePoints.length, reused: true };
  }
  if (opts.force && hasNavMesh()) {
    clearWalkableGotoPoints();
    // Force a fresh bake (e.g. after Matterport mesh align).
    clearNavMesh();
  }
  // Prefer uploaded .navmesh when present; otherwise generate.
  if (!hasNavMesh()) {
    opts.onProgress?.('Loading navigation mesh…');
    const loaded = await ensureNavMeshAvailable({ visualize: false, force: false });
    if (!loaded?.success) {
      return { ok: false, error: loaded?.error || 'Navmesh unavailable', count: 0 };
    }
  }
  if (opts.sampleWalkable) {
    return prepareGotoWalkable({
      count: Math.max(80, Number(opts.count) || 200),
      onProgress: opts.onProgress,
    });
  }
  return { ok: true, count: 0, reused: false };
}

/**
 * Free-flow camera pose on a walkable point — looks into the map near edges.
 * @param {THREE.Vector3} walkable
 * @returns {{ endPos: THREE.Vector3, endTarget: THREE.Vector3 }}
 */
export function walkPoseFromPoint(walkable) {
  const feet = pullGotoInward(walkable.clone());
  const endPos = feet.clone();
  endPos.y += GOTO_EYE_HEIGHT;

  const camera = getCamera();
  const preferred = new THREE.Vector3(0, 0, -1);
  if (camera) {
    camera.getWorldDirection(preferred);
  }

  const lookDir = inwardLookDirection(feet, preferred);
  const endTarget = endPos.clone().addScaledVector(lookDir, LOOK_AHEAD);
  endTarget.y = feet.y + 0.35;

  // Keep look-at target inside map too (never aim past the rim).
  const clampedTarget = pullGotoInward(endTarget, EDGE_INSET * 0.6);
  clampedTarget.y = endTarget.y;

  return { endPos, endTarget: clampedTarget };
}
