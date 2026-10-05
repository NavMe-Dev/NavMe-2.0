/**
 * Standalone Recast navmesh for Matterpak twin (hidden; Go-to snaps here).
 * Does not touch the NavMe dashboard scene modules.
 */
import * as THREE from 'three';
import { init, NavMeshQuery } from 'recast-navigation';
import { generateSoloNavMesh } from '@recast-navigation/generators';

let initPromise = null;

/** @type {import('recast-navigation').NavMesh | null} */
let currentNavMesh = null;
/** @type {THREE.Box3 | null} */
let currentBounds = null;
/** @type {THREE.Vector3[]} */
let walkableSamples = [];

export async function ensureRecastLoaded() {
  if (!initPromise) initPromise = init();
  await initPromise;
}

export function getTwinNavMesh() {
  return currentNavMesh;
}

export function getTwinNavBounds() {
  return currentBounds?.clone() ?? null;
}

export function getWalkableSamples() {
  return walkableSamples;
}

export function clearTwinNavMesh() {
  currentNavMesh = null;
  currentBounds = null;
  walkableSamples = [];
}

function collectMeshes(root) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  if (!root) return meshes;
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    if (child.geometry.attributes.position.count < 3) return;
    meshes.push(child);
  });
  return meshes;
}

function meshTriCount(mesh) {
  const pos = mesh.geometry.attributes.position;
  const idx = mesh.geometry.index;
  if (idx && idx.count >= 3) return Math.floor(idx.count / 3);
  return Math.floor(pos.count / 3);
}

function extractGeometry(meshes) {
  let totalTris = 0;
  let totalVerts = 0;
  for (const mesh of meshes) {
    totalVerts += mesh.geometry.attributes.position.count;
    totalTris += meshTriCount(mesh);
  }
  if (!totalTris) return { positions: new Float32Array(0), indices: new Uint32Array(0) };

  // Soft decimate if huge (Matterpak can be dense).
  const maxTris = 400_000;
  const stride = totalTris > maxTris ? Math.ceil(totalTris / maxTris) : 1;

  const positions = [];
  const indices = [];
  const v = new THREE.Vector3();
  let vOffset = 0;
  let triKeep = 0;

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const m = mesh.matrixWorld;
    const flip = m.determinant() < 0;
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const base = vOffset;

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
    }

    const idxAttr = geo.index;
    const pushTri = (a, b, c) => {
      if (stride > 1 && triKeep++ % stride !== 0) return;
      if (!flip) indices.push(base + a, base + b, base + c);
      else indices.push(base + a, base + c, base + b);
    };

    if (idxAttr && idxAttr.count >= 3) {
      const n = Math.floor(idxAttr.count / 3);
      for (let t = 0; t < n; t++) {
        pushTri(idxAttr.getX(t * 3), idxAttr.getX(t * 3 + 1), idxAttr.getX(t * 3 + 2));
      }
    } else {
      const n = Math.floor(posAttr.count / 3);
      for (let t = 0; t < n; t++) pushTri(t * 3, t * 3 + 1, t * 3 + 2);
    }

    vOffset += posAttr.count;
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

function computeBounds(positions) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    sizeX: Math.max(0.1, maxX - minX),
    sizeY: Math.max(0.1, maxY - minY),
    sizeZ: Math.max(0.1, maxZ - minZ),
  };
}

function buildConfigs(bounds, triCount) {
  const maxHoriz = Math.max(bounds.sizeX, bounds.sizeZ, 0.1);
  const out = [];
  for (const cs of [0.15, 0.25, 0.4, 0.6, 1.0]) {
    const ch = Math.max(0.05, cs * 0.5);
    const gridW = Math.ceil(maxHoriz / cs);
    const gridCells = gridW * gridW;
    if (gridCells > 8_000_000) continue;
    if (Math.min(triCount, gridCells * 0.3) > 60_000) continue;
    out.push({
      cs,
      ch,
      walkableSlopeAngle: 60,
      walkableHeight: Math.max(3, Math.ceil(2.0 / ch)),
      walkableClimb: Math.max(1, Math.ceil(0.35 / ch)),
      walkableRadius: 0.05,
      borderSize: 0,
      minRegionArea: 2,
      mergeRegionArea: 6,
    });
  }
  out.push({
    cs: Math.max(0.3, maxHoriz / 80),
    ch: 0.2,
    walkableSlopeAngle: 89,
    walkableHeight: 1,
    walkableClimb: 8,
    walkableRadius: 0.02,
    borderSize: 0,
    minRegionArea: 0,
    mergeRegionArea: 0,
  });
  return out;
}

function samplePoints(navMesh, bounds, count = 400) {
  const query = new NavMeshQuery(navMesh);
  /** @type {THREE.Vector3[]} */
  const out = [];
  const seen = new Set();

  const push = (p) => {
    if (!p || !Number.isFinite(p.x)) return;
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(new THREE.Vector3(p.x, p.y, p.z));
  };

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const radius = Math.max(bounds.sizeX, bounds.sizeZ) * 0.55;

  for (let i = 0; i < count * 3 && out.length < count; i++) {
    try {
      const r = query.findRandomPointAroundCircle({ x: cx, y: cy, z: cz }, radius);
      if (r?.success && r.randomPoint) push(r.randomPoint);
    } catch {
      break;
    }
  }

  const n = Math.max(10, Math.ceil(Math.sqrt(count)));
  for (let ix = 0; ix < n && out.length < count; ix++) {
    for (let iz = 0; iz < n && out.length < count; iz++) {
      const x = bounds.minX + ((ix + 0.5) / n) * bounds.sizeX;
      const z = bounds.minZ + ((iz + 0.5) / n) * bounds.sizeZ;
      try {
        const closest = query.findClosestPoint(
          { x, y: cy, z },
          { halfExtents: { x: 4, y: 20, z: 4 } },
        );
        if (closest?.success && closest.point) push(closest.point);
      } catch {
        /* skip */
      }
    }
  }

  return out;
}

/**
 * Build a hidden navmesh from the loaded Matterpak root.
 * @param {THREE.Object3D} root
 * @param {{ onProgress?: (msg: string, pct?: number) => void }} [opts]
 */
export async function buildTwinNavMesh(root, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  clearTwinNavMesh();

  await ensureRecastLoaded();
  const meshes = collectMeshes(root);
  if (!meshes.length) {
    return { ok: false, error: 'No mesh geometry for navmesh', count: 0 };
  }

  onProgress('Extracting walkable geometry…', 82);
  const { positions, indices } = extractGeometry(meshes);
  const triCount = Math.floor(indices.length / 3);
  if (!triCount) {
    return { ok: false, error: 'Mesh has no triangles for navmesh', count: 0 };
  }

  const bounds = computeBounds(positions);
  const configs = buildConfigs(bounds, triCount);

  onProgress(`Building navmesh (${triCount.toLocaleString()} tris)…`, 88);
  let navMesh = null;
  for (const config of configs) {
    try {
      const result = generateSoloNavMesh(positions, indices, config, false);
      if (result?.success && result.navMesh) {
        navMesh = result.navMesh;
        break;
      }
    } catch (err) {
      console.warn('[matterpak-navmesh] attempt failed:', err);
    }
  }

  if (!navMesh) {
    return { ok: false, error: 'Could not build navmesh from Matterpak mesh', count: 0 };
  }

  currentNavMesh = navMesh;
  currentBounds = new THREE.Box3(
    new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
    new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ),
  );

  onProgress('Sampling walkable points…', 94);
  walkableSamples = samplePoints(navMesh, bounds, 450);

  return {
    ok: true,
    count: walkableSamples.length,
    bounds: currentBounds.clone(),
  };
}

/**
 * Snap a world click to the nearest walkable navmesh point.
 * @param {{ x: number, y: number, z: number } | THREE.Vector3} point
 * @returns {THREE.Vector3 | null}
 */
export function snapToNearestNavPoint(point) {
  if (!point || !currentNavMesh) return null;

  const sample = {
    x: Number(point.x) || 0,
    y: Number(point.y) || 0,
    z: Number(point.z) || 0,
  };

  try {
    const query = new NavMeshQuery(currentNavMesh);
    const halfExtentsAttempts = [
      { x: 2, y: 4, z: 2 },
      { x: 6, y: 12, z: 6 },
      { x: 12, y: 25, z: 12 },
    ];
    for (const halfExtents of halfExtentsAttempts) {
      const closest = query.findClosestPoint(sample, { halfExtents });
      if (closest?.success && closest.point) {
        return new THREE.Vector3(closest.point.x, closest.point.y, closest.point.z);
      }
    }
  } catch {
    /* fall through to samples */
  }

  // Fallback: nearest pre-sampled walkable point (XZ + Y).
  if (!walkableSamples.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const p of walkableSamples) {
    const dx = p.x - sample.x;
    const dy = p.y - sample.y;
    const dz = p.z - sample.z;
    const d = dx * dx + dy * dy * 0.25 + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? best.clone() : null;
}

/** Close eye-level framing on a walkable nav point (not a zoomed-out dollhouse). */
export function getNavmeshDefaultView() {
  const samples = walkableSamples;
  const box = currentBounds?.clone() ?? null;

  const eyeLift = 1.55;
  const camDist = 2.6;

  if (samples.length) {
    const feet = new THREE.Vector3();
    for (const p of samples) feet.add(p);
    feet.multiplyScalar(1 / samples.length);

    // Prefer a sample near the centroid so we land on real walkable ground.
    let start = samples[0];
    let bestD = Infinity;
    for (const p of samples) {
      const d = p.distanceToSquared(feet);
      if (d < bestD) {
        bestD = d;
        start = p;
      }
    }

    const target = start.clone();
    target.y += eyeLift * 0.2;
    const position = new THREE.Vector3(
      start.x + camDist * 0.65,
      start.y + eyeLift,
      start.z + camDist * 0.75,
    );
    return { target, position, size: 12, feet: start.clone() };
  }

  if (box && !box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    const feet = new THREE.Vector3(center.x, box.min.y + 0.05, center.z);
    const target = feet.clone();
    target.y += eyeLift * 0.2;
    const position = new THREE.Vector3(
      feet.x + camDist * 0.65,
      feet.y + eyeLift,
      feet.z + camDist * 0.75,
    );
    return { target, position, size: 12, feet };
  }

  return null;
}
