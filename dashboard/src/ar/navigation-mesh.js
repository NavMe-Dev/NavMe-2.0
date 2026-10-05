/**
 * Navigation mesh generator — uses @recast-navigation/generators directly
 * for full control over the Recast pipeline + proper auto-scaling.
 *
 * The "Failed to create Detour navmesh data" error from threeToSoloNavMesh
 * happens when either:
 *  - The grid produces >65535 polygons (Detour 16-bit limit for solo mesh)
 *  - All walkable area gets eroded away (0 polygons)
 *  - Cell size is too fine for the map size
 *
 * Fix: extract positions/indices ourselves, compute bounds, auto-scale cs/ch
 * so the polygon count stays within Detour limits, and use generateSoloNavMesh
 * with keepIntermediates=true for diagnostics.
 */
import * as THREE from 'three';
import { init, exportNavMesh, importNavMesh } from 'recast-navigation';
import { generateSoloNavMesh } from '@recast-navigation/generators';
import { NavMeshHelper } from '@recast-navigation/three';
import { getScene, getMultisetAnchor, getMatterportAlignRoot } from './scene.js';
import { getActiveNavMeshMap, resolveMediaDisplayUrl } from './media.js';

let initPromise = null;
let currentNavMesh = null;
let currentHelper = null;

/** Stay below typical browser ArrayBuffer limits (~2GB; often less in practice). */
const MAX_NAV_VERTS = 2_500_000;
const MAX_NAV_INDICES = 7_500_000;
/** Soft targets — leave headroom for remapping / winding flips. */
const TARGET_NAV_INDICES = 4_500_000;
const TARGET_NAV_VERTS = 1_500_000;

function navMeshFailure(message, durationMs = 0) {
  return { success: false, error: message, durationMs };
}

export async function ensureRecastLoaded() {
  if (!initPromise) initPromise = init();
  await initPromise;
}

function meshTriangleCount(mesh) {
  const posAttr = mesh?.geometry?.attributes?.position;
  if (!posAttr || posAttr.count < 3) return 0;
  const idx = mesh.geometry.index;
  if (idx && idx.count >= 3) return Math.floor(idx.count / 3);
  return Math.floor(posAttr.count / 3);
}

/**
 * Score a world-space triangle for walkability (prefer near-horizontal faces).
 * Higher = better to keep when decimating.
 */
function walkableTriangleScore(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  // Prefer faces whose normal points up (or down) — floors/ceilings; still usable after Recast.
  return Math.abs(ny) / len;
}

function collectMeshes() {
  const anchor = getMultisetAnchor();
  if (!anchor) return [];

  const meshes = [];
  const mapRoot = anchor.getObjectByName('MapMesh');
  if (mapRoot) {
    const splatMap = mapRoot.userData?.mapKind === 'splat';
    mapRoot.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      // Splat maps: only the floor collider is triangulated/walkable (GPU splat mesh is not).
      if (splatMap) {
        if (child.name === 'SplatMapCollider') meshes.push(child);
        return;
      }
      if (child.name === 'SplatMapCollider') return;
      if (child.name === 'GotoWalkablePoints') return;
      if (child.parent?.name === 'GotoWalkablePoints') return;
      if (child.material?.colorWrite === false) return;
      meshes.push(child);
    });
  }

  if (!meshes.length) {
    const scene = getScene();
    if (scene) {
      scene.traverse((child) => {
        if (
          child.isMesh &&
          child.geometry &&
          child.name !== 'NavMeshHelperMesh' &&
          child.name !== 'SplatMapCollider' &&
          child.parent?.name !== 'GotoWalkablePoints'
        ) {
          meshes.push(child);
        }
      });
    }
  }

  return meshes.filter((m) => {
    if (!m || !m.geometry || !m.isMesh) return false;
    const pos = m.geometry.attributes?.position;
    return pos && pos.count >= 3;
  });
}

/**
 * Extract world-space positions/indices for Recast.
 * When the map is too dense, keep ~1/N triangles (preferring walkable faces)
 * so generation still succeeds instead of aborting.
 */
function extractWorldPositionsAndIndices(meshes) {
  let totalTris = 0;
  let totalVerts = 0;

  for (const mesh of meshes) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) continue;
    totalVerts += mesh.geometry.attributes.position.count;
    totalTris += meshTriangleCount(mesh);
  }

  if (totalTris === 0) {
    return [new Float32Array(0), new Uint32Array(0)];
  }

  const targetTris = Math.floor(TARGET_NAV_INDICES / 3);
  let stride = 1;
  if (totalTris > targetTris || totalVerts > TARGET_NAV_VERTS) {
    stride = Math.max(1, Math.ceil(totalTris / targetTris));
    const vertStride = Math.max(1, Math.ceil((totalTris * 3) / TARGET_NAV_VERTS));
    stride = Math.max(stride, vertStride);
  }

  const hardMaxTris = Math.floor(Math.min(MAX_NAV_INDICES, MAX_NAV_VERTS) / 3);
  if (Math.ceil(totalTris / stride) > hardMaxTris) {
    stride = Math.max(stride, Math.ceil(totalTris / hardMaxTris));
  }

  if (stride <= 1 && totalVerts <= MAX_NAV_VERTS && totalTris * 3 <= MAX_NAV_INDICES) {
    return extractFullGeometry(meshes, totalVerts, totalTris * 3);
  }

  console.warn(
    `[NavMesh] Map too dense (${totalVerts.toLocaleString()} verts, ${totalTris.toLocaleString()} tris) — keeping ~1/${stride} triangles for navigation`,
  );
  return extractDecimatedGeometry(meshes, stride);
}

/** Full-fidelity extract when geometry already fits memory budgets. */
function extractFullGeometry(meshes, totalVerts, totalIndices) {
  let positions;
  let indices;
  try {
    positions = new Float32Array(totalVerts * 3);
    indices = new Uint32Array(totalIndices);
  } catch (err) {
    throw new RangeError(
      err instanceof RangeError
        ? `Map geometry exceeds available memory (${totalVerts.toLocaleString()} verts)`
        : err instanceof Error
          ? err.message
          : 'Map geometry exceeds available memory',
    );
  }

  let vOffset = 0;
  let iOffset = 0;
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();

  for (const mesh of meshes) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) continue;
    mesh.updateWorldMatrix(true, false);

    m.copy(mesh.matrixWorld);
    const flipWindingForThisMesh = m.determinant() < 0;
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
      const p = (vOffset + i) * 3;
      positions[p] = v.x;
      positions[p + 1] = v.y;
      positions[p + 2] = v.z;
    }

    const idxAttr = geo.index;
    if (idxAttr && idxAttr.count >= 3) {
      const triCount = Math.floor(idxAttr.count / 3);
      for (let t = 0; t < triCount; t++) {
        const a = idxAttr.getX(t * 3 + 0);
        const b = idxAttr.getX(t * 3 + 1);
        const c = idxAttr.getX(t * 3 + 2);
        if (!flipWindingForThisMesh) {
          indices[iOffset++] = vOffset + a;
          indices[iOffset++] = vOffset + b;
          indices[iOffset++] = vOffset + c;
        } else {
          indices[iOffset++] = vOffset + a;
          indices[iOffset++] = vOffset + c;
          indices[iOffset++] = vOffset + b;
        }
      }
    } else {
      const triCount = Math.floor(posAttr.count / 3);
      for (let t = 0; t < triCount; t++) {
        const a = t * 3 + 0;
        const b = t * 3 + 1;
        const c = t * 3 + 2;
        if (!flipWindingForThisMesh) {
          indices[iOffset++] = vOffset + a;
          indices[iOffset++] = vOffset + b;
          indices[iOffset++] = vOffset + c;
        } else {
          indices[iOffset++] = vOffset + a;
          indices[iOffset++] = vOffset + c;
          indices[iOffset++] = vOffset + b;
        }
      }
    }

    vOffset += posAttr.count;
  }

  return [positions.subarray(0, vOffset * 3), indices.subarray(0, iOffset)];
}

/**
 * Keep 1 triangle per stride window — prefer the most walkable (horizontal) face.
 * Stores world coords so mesh boundaries stay correct.
 */
function extractDecimatedGeometry(meshes, stride) {
  const keptTrisBudget = Math.ceil(
    meshes.reduce((n, mesh) => n + meshTriangleCount(mesh), 0) / stride,
  );
  const maxVerts = Math.min(MAX_NAV_VERTS, keptTrisBudget * 3);
  const maxIndices = Math.min(MAX_NAV_INDICES, keptTrisBudget * 3);

  let positions;
  let indices;
  try {
    positions = new Float32Array(maxVerts * 3);
    indices = new Uint32Array(maxIndices);
  } catch (err) {
    throw new RangeError(
      err instanceof RangeError
        ? 'Map geometry exceeds available memory while decimating for navigation'
        : err instanceof Error
          ? err.message
          : 'Map geometry exceeds available memory',
    );
  }

  let vOut = 0;
  let iOut = 0;
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let meshWorld = null;

  let windowBest = null;
  let windowBestScore = -1;
  let windowCount = 0;

  function emitWorldTriangle(tri, flip) {
    if (iOut + 3 > indices.length || vOut + 3 > maxVerts) return false;
    const base = vOut;
    for (let k = 0; k < 3; k++) {
      const po = vOut * 3;
      positions[po] = tri[k * 3];
      positions[po + 1] = tri[k * 3 + 1];
      positions[po + 2] = tri[k * 3 + 2];
      vOut += 1;
    }
    if (!flip) {
      indices[iOut++] = base;
      indices[iOut++] = base + 1;
      indices[iOut++] = base + 2;
    } else {
      indices[iOut++] = base;
      indices[iOut++] = base + 2;
      indices[iOut++] = base + 1;
    }
    return true;
  }

  function flushWindow() {
    if (!windowBest) return true;
    const ok = emitWorldTriangle(windowBest.coords, windowBest.flip);
    windowBest = null;
    windowBestScore = -1;
    windowCount = 0;
    return ok;
  }

  function considerTriangle(a, b, c, flip) {
    const coords = new Float32Array(9);
    coords[0] = meshWorld[a * 3];
    coords[1] = meshWorld[a * 3 + 1];
    coords[2] = meshWorld[a * 3 + 2];
    coords[3] = meshWorld[b * 3];
    coords[4] = meshWorld[b * 3 + 1];
    coords[5] = meshWorld[b * 3 + 2];
    coords[6] = meshWorld[c * 3];
    coords[7] = meshWorld[c * 3 + 1];
    coords[8] = meshWorld[c * 3 + 2];

    const score = walkableTriangleScore(
      coords[0],
      coords[1],
      coords[2],
      coords[3],
      coords[4],
      coords[5],
      coords[6],
      coords[7],
      coords[8],
    );

    if (windowCount === 0 || score > windowBestScore) {
      windowBest = { coords, flip };
      windowBestScore = score;
    }
    windowCount += 1;

    if (windowCount >= stride) return flushWindow();
    return true;
  }

  for (const mesh of meshes) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) continue;
    mesh.updateWorldMatrix(true, false);

    m.copy(mesh.matrixWorld);
    const flipWindingForThisMesh = m.determinant() < 0;
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;

    if (!meshWorld || meshWorld.length < posAttr.count * 3) {
      meshWorld = new Float32Array(posAttr.count * 3);
    }

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
      const p = i * 3;
      meshWorld[p] = v.x;
      meshWorld[p + 1] = v.y;
      meshWorld[p + 2] = v.z;
    }

    const idxAttr = geo.index;
    if (idxAttr && idxAttr.count >= 3) {
      const triCount = Math.floor(idxAttr.count / 3);
      for (let t = 0; t < triCount; t++) {
        const a = idxAttr.getX(t * 3 + 0);
        const b = idxAttr.getX(t * 3 + 1);
        const c = idxAttr.getX(t * 3 + 2);
        if (!considerTriangle(a, b, c, flipWindingForThisMesh)) break;
      }
    } else {
      const triCount = Math.floor(posAttr.count / 3);
      for (let t = 0; t < triCount; t++) {
        if (!considerTriangle(t * 3, t * 3 + 1, t * 3 + 2, flipWindingForThisMesh)) break;
      }
    }

    // Don't carry a half-window across mesh boundaries (indices are mesh-local).
    if (!flushWindow()) break;
  }

  return [positions.subarray(0, vOut * 3), indices.subarray(0, iOut)];
}

function computeBounds(positions, indices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    const z = positions[idx * 3 + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return {
    min,
    max,
    sizeX: max[0] - min[0],
    sizeY: max[1] - min[1],
    sizeZ: max[2] - min[2],
  };
}

/**
 * Zappar / ZComponent NavigationMesh defaults (world meters), with border
 * radius set to 0.02 m as requested. Recast voxel params are derived exactly
 * like ZComponent: value / cellSize (or cellHeight).
 *
 * @see NavigationMesh.generate — threeToSoloNavMesh({
 *   ch, cs,
 *   walkableClimb: climb / ch,
 *   walkableRadius: radius / cs,
 *   walkableHeight: height / ch,
 *   borderSize: border / cs,
 * })
 */
const ZAPPAR_CELL_SIZE = 0.1;
const ZAPPAR_CELL_HEIGHT = 0.05;
const ZAPPAR_WALKABLE_CLIMB_M = 0.3;
const ZAPPAR_WALKABLE_HEIGHT_M = 2;
/** Border / agent radius in meters (ZComponent default is 0.2; product wants 0.02). */
const ZAPPAR_WALKABLE_RADIUS_M = 0.02;
const ZAPPAR_BORDER_SIZE_M = 0;
const ZAPPAR_WALKABLE_SLOPE_DEG = 60;

/**
 * Single Recast config matching ZComponent NavigationMesh (radius = 0.02 m).
 * @param {{ sizeX: number, sizeZ: number }} bounds
 */
function buildZapparNavMeshConfig(bounds) {
  const cs = ZAPPAR_CELL_SIZE;
  const ch = ZAPPAR_CELL_HEIGHT;
  const maxHoriz = Math.max(bounds.sizeX, bounds.sizeZ, 0.1);
  const gridW = Math.ceil(maxHoriz / cs);
  const gridH = Math.ceil(maxHoriz / cs);
  return {
    cs,
    ch,
    walkableSlopeAngle: ZAPPAR_WALKABLE_SLOPE_DEG,
    // Same world→voxel conversion as ZComponent (no Math.ceil).
    walkableClimb: ZAPPAR_WALKABLE_CLIMB_M / ch,
    walkableRadius: ZAPPAR_WALKABLE_RADIUS_M / cs,
    walkableHeight: ZAPPAR_WALKABLE_HEIGHT_M / ch,
    borderSize: ZAPPAR_BORDER_SIZE_M / cs,
    gridW,
    gridH,
    gridCells: gridW * gridH,
    estPolys: 0,
  };
}

/**
 * Coarser fallbacks only if the Zappar-sized grid is too large for Detour.
 * Still keeps radius = 0.02 m via radius / cs.
 * @param {{ sizeX: number, sizeZ: number }} bounds
 */
function buildFallbackConfigs(bounds) {
  const maxHoriz = Math.max(bounds.sizeX, bounds.sizeZ, 0.1);
  const configs = [];
  for (const cs of [0.15, 0.2, 0.3, 0.5]) {
    const ch = Math.max(0.05, cs * 0.5);
    const gridW = Math.ceil(maxHoriz / cs);
    const gridH = Math.ceil(maxHoriz / cs);
    const gridCells = gridW * gridH;
    if (gridCells > 8_000_000) continue;
    configs.push({
      cs,
      ch,
      walkableSlopeAngle: ZAPPAR_WALKABLE_SLOPE_DEG,
      walkableClimb: ZAPPAR_WALKABLE_CLIMB_M / ch,
      walkableRadius: ZAPPAR_WALKABLE_RADIUS_M / cs,
      walkableHeight: ZAPPAR_WALKABLE_HEIGHT_M / ch,
      borderSize: ZAPPAR_BORDER_SIZE_M / cs,
      gridW,
      gridH,
      gridCells,
      estPolys: 0,
    });
  }
  return configs;
}

function remapPositions(positions, mode) {
  if (mode === 'identity') return positions;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (mode === 'swapYZ') {
      out[i] = x;
      out[i + 1] = z;
      out[i + 2] = y;
    } else if (mode === 'swapXY') {
      out[i] = y;
      out[i + 1] = x;
      out[i + 2] = z;
    } else if (mode === 'mirrorX') {
      out[i] = -x;
      out[i + 1] = y;
      out[i + 2] = z;
    } else if (mode === 'mirrorZ') {
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = -z;
    } else {
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = z;
    }
  }
  return out;
}

function estimateWalkableBySlope(positions, indices, slopeDeg) {
  const maxAngle = THREE.MathUtils.degToRad(slopeDeg);
  const cosMin = Math.cos(maxAngle);

  let tested = 0;
  let walkable = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  const maxTests = Math.min(indices.length / 3, 50_000);
  for (let t = 0; t < maxTests; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    a.set(positions[ia], positions[ia + 1], positions[ia + 2]);
    b.set(positions[ib], positions[ib + 1], positions[ib + 2]);
    c.set(positions[ic], positions[ic + 1], positions[ic + 2]);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const len = n.length();
    if (len < 1e-12) continue;
    n.multiplyScalar(1 / len);

    tested++;
    if (n.y >= cosMin) walkable++;
  }

  return { tested, walkable };
}

function remapIndices(indices, mode) {
  if (mode === 'normal') return indices;
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    // Flip triangle winding so normals invert.
    out[i] = a;
    out[i + 1] = c;
    out[i + 2] = b;
  }
  return out;
}

function tryGenerate(positions, indices, config) {
  const { gridW, gridH, gridCells, estPolys, ...recastConfig } = config;

  const radiusM =
    Number(recastConfig.walkableRadius) * Number(recastConfig.cs);
  console.log(
    `[NavMesh] Border radius ≈ ${radiusM.toFixed(3)} m ` +
      `(${recastConfig.walkableRadius} vx × cs ${recastConfig.cs})`,
  );
  console.log('[NavMesh] Config:', JSON.stringify(recastConfig, null, 2));
  if (gridW) {
    console.log(
      `[NavMesh] Grid: ${gridW}x${gridH} = ${gridCells} cells, est polys: ${Math.round(estPolys)}`,
    );
  }

  const t0 = performance.now();
  const result = generateSoloNavMesh(positions, indices, recastConfig, true);
  const t1 = performance.now();

  if (!result.success) {
    const inter = result.intermediates;
    const polyCount = inter?.polyMesh ? inter.polyMesh.npolys() : '?';
    const vertCount = inter?.polyMesh ? inter.polyMesh.nverts() : '?';
    console.warn(
      `[NavMesh] Failed — polyMesh: ${vertCount} verts, ${polyCount} polys — error: ${result.error}`,
    );
  }

  return { result, durationMs: t1 - t0 };
}

/**
 * Prefer a superadmin-uploaded `.navmesh` file; otherwise bake from the geometric mesh.
 * @param {{ visualize?: boolean, force?: boolean, allowGenerate?: boolean }} [options]
 */
export async function ensureNavMeshAvailable(options = {}) {
  await ensureRecastLoaded();
  if (hasNavMesh() && !options.force) {
    return { success: true, source: 'memory' };
  }

  const uploaded = getActiveNavMeshMap();
  if (uploaded) {
    const url = resolveMediaDisplayUrl(uploaded) || uploaded.media_url;
    if (url) {
      const loaded = await loadNavMeshFromUrl(url, {
        visualize: options.visualize === true,
      });
      if (loaded.success) {
        console.log('[NavMesh] Loaded uploaded .navmesh from storage');
        return { success: true, source: 'upload', navMesh: loaded.navMesh };
      }
      console.warn('[NavMesh] Uploaded file failed —', loaded.error);
      if (options.allowGenerate === false) {
        return { success: false, error: loaded.error || 'Uploaded navmesh failed' };
      }
    }
  }

  if (options.allowGenerate === false) {
    return { success: false, error: 'No uploaded navmesh for this project' };
  }

  const generated = await generateNavMesh({
    visualize: options.visualize === true,
  });
  if (generated?.success) {
    return { success: true, source: 'generate', durationMs: generated.durationMs };
  }
  return {
    success: false,
    error: generated?.error || 'Failed to create navigation mesh',
    durationMs: generated?.durationMs,
  };
}

/**
 * Bake a navigation mesh from the loaded geometric map.
 * @param {{ visualize?: boolean }} [options]
 */
export async function generateNavMesh(options = {}) {
  const visualize = options.visualize !== false;
  try {
    await ensureRecastLoaded();
    clearNavMeshVisualization();

    const meshes = collectMeshes();
    if (!meshes.length) {
      return navMeshFailure('No map mesh loaded \u2014 load a map first.');
    }

    console.log(`[NavMesh] Collecting geometry from ${meshes.length} meshes\u2026`);
    const [positions, indices] = extractWorldPositionsAndIndices(meshes);
    const triCount = indices.length / 3;
    console.log(
      `[NavMesh] Geometry: ${(positions.length / 3).toLocaleString()} vertices, ${triCount.toLocaleString()} triangles`,
    );

    if (triCount === 0) {
      return navMeshFailure('Map mesh has no triangles.');
    }

    let result = null;
    let durationMs = 0;
    // Prefer identity + normal winding (ZComponent / threeToSoloNavMesh style).
    // Only try remaps if the mesh orientation is wrong for Recast.
    const orientationModes = ['identity', 'swapYZ', 'swapXY', 'mirrorX', 'mirrorZ'];
    const windingModes = ['normal', 'flipped'];
    for (const orient of orientationModes) {
      const orientedPositions = remapPositions(positions, orient);
      for (const winding of windingModes) {
        const orientedIndices = remapIndices(indices, winding);
        const bounds = computeBounds(orientedPositions, orientedIndices);
        console.log(
          `[NavMesh] Orientation=${orient}, winding=${winding}, bounds: ${bounds.sizeX.toFixed(1)} x ${bounds.sizeY.toFixed(1)} x ${bounds.sizeZ.toFixed(1)}`,
        );

        const slopeCheck = estimateWalkableBySlope(
          orientedPositions,
          orientedIndices,
          ZAPPAR_WALKABLE_SLOPE_DEG,
        );
        if (slopeCheck.tested > 0) {
          const pct = (slopeCheck.walkable / slopeCheck.tested) * 100;
          console.log(
            `[NavMesh] Slope sanity: ${slopeCheck.walkable}/${slopeCheck.tested} (~${pct.toFixed(1)}%) triangles face +Y within ${ZAPPAR_WALKABLE_SLOPE_DEG}\u00b0`,
          );
        }

        const primary = buildZapparNavMeshConfig(bounds);
        const configs =
          primary.gridCells > 8_000_000
            ? buildFallbackConfigs(bounds)
            : [primary, ...buildFallbackConfigs(bounds)];

        console.log(
          `[NavMesh] Zappar-style bake — cs=${ZAPPAR_CELL_SIZE}, ch=${ZAPPAR_CELL_HEIGHT}, radius=${ZAPPAR_WALKABLE_RADIUS_M} m`,
        );

        for (let i = 0; i < configs.length; i++) {
          console.log(
            `[NavMesh] Attempt ${i + 1}/${configs.length} (${orient}, ${winding}) - cs=${configs[i].cs}, ch=${configs[i].ch}`,
          );
          const out = tryGenerate(orientedPositions, orientedIndices, configs[i]);
          durationMs += out.durationMs;
          result = out.result;
          if (result.success) {
            console.log(`[NavMesh] Success on orientation=${orient}, winding=${winding}, attempt=${i + 1}`);
            break;
          }
          console.warn(`[NavMesh] Attempt ${i + 1} failed: ${result.error}`);
        }

        if (result?.success) break;
      }
      if (result?.success) break;
    }

    if (!result || !result.success) {
      console.error('[NavMesh] All attempts failed:', result?.error);
      return navMeshFailure(result?.error || 'Failed to create Detour navmesh data', durationMs);
    }

    currentNavMesh = result.navMesh;

    if (visualize) {
      attachNavMeshHelper(result.navMesh);
    }

    console.log(`[NavMesh] Done \u2014 total ${durationMs.toFixed(0)} ms`);
    return { success: true, durationMs };
  } catch (err) {
    console.error('[NavMesh] Generation aborted:', err);
    const message =
      err instanceof RangeError
        ? 'Map is too large for navigation mesh on this device — POI editing still works.'
        : err instanceof Error
          ? err.message
          : 'Navigation mesh generation failed';
    return navMeshFailure(message);
  }
}

function disposeHelper() {
  if (!currentHelper) return;
  currentHelper.removeFromParent();
  if (currentHelper.navMeshGeometry) currentHelper.navMeshGeometry.dispose();
  if (currentHelper.navMeshMaterial) currentHelper.navMeshMaterial.dispose();
  currentHelper = null;
}

function attachNavMeshHelper(navMesh) {
  disposeHelper();
  if (!navMesh) return null;

  const material = new THREE.MeshBasicMaterial({
    color: 0x22ff66,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  currentHelper = new NavMeshHelper(navMesh, {
    navMeshMaterial: material,
  });
  currentHelper.update();

  const alignRoot = getMatterportAlignRoot();
  if (alignRoot?.userData?._mpAligned) alignRoot.add(currentHelper);
  else {
    const parent = getMultisetAnchor();
    if (parent) parent.add(currentHelper);
    else getScene()?.add(currentHelper);
  }

  return currentHelper;
}

/** Hide the green overlay only — keeps the generated navmesh for routing. */
export function hideNavMeshVisualization() {
  disposeHelper();
}

export function isNavMeshVisualizationVisible() {
  return Boolean(currentHelper?.parent);
}

/**
 * Show the navmesh overlay. Generates once if needed; otherwise reuses existing mesh.
 * @returns {Promise<{ ok: boolean, visible: boolean, error?: string }>}
 */
export async function showNavMeshVisualization() {
  try {
    if (currentNavMesh) {
      if (!currentHelper) attachNavMeshHelper(currentNavMesh);
      else if (!currentHelper.parent) {
        const parent = getMultisetAnchor();
        if (parent) parent.add(currentHelper);
        else getScene()?.add(currentHelper);
      }
      return { ok: true, visible: true };
    }

    const result = await ensureNavMeshAvailable({ visualize: true, force: false });
    if (!result?.success) {
      return { ok: false, visible: false, error: result?.error || 'Failed to generate navigation mesh' };
    }
    if (currentNavMesh && !currentHelper) attachNavMeshHelper(currentNavMesh);
    return { ok: true, visible: true };
  } catch (err) {
    return {
      ok: false,
      visible: false,
      error: err instanceof Error ? err.message : 'Failed to show navigation mesh',
    };
  }
}

export function clearNavMesh() {
  clearNavMeshVisualization();
}

export function clearNavMeshVisualization() {
  disposeHelper();
  if (currentNavMesh) {
    try {
      currentNavMesh.destroy();
    } catch {
      /* */
    }
    currentNavMesh = null;
  }
}

/** @returns {Uint8Array|null} Serialized nav mesh, or null if none. */
export function getNavMeshExportBytes() {
  if (!currentNavMesh) return null;
  return exportNavMesh(currentNavMesh);
}

export function downloadNavMeshFile(filename = 'generated.navmesh') {
  const data = getNavMeshExportBytes();
  if (!data) return false;
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Load a ZComponent / Recast `generated.navmesh` (TESM) file into memory.
 * @param {ArrayBuffer | Uint8Array} bytes
 * @param {{ visualize?: boolean }} [options]
 */
export function loadNavMeshFromBytes(bytes, options = {}) {
  const visualize = options.visualize === true;
  const data =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes instanceof ArrayBuffer ? bytes : []);
  if (!data.byteLength) {
    return { success: false, error: 'Empty navmesh file' };
  }
  // TESM magic from Recast exportNavMesh
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== 'TESM' && magic !== 'NAVM') {
    console.warn(`[NavMesh] Unexpected file header "${magic}" — attempting import anyway`);
  }

  clearNavMeshVisualization();
  try {
    const result = importNavMesh(data);
    const mesh = result?.navMesh;
    if (!mesh) {
      return { success: false, error: 'Could not import navmesh file' };
    }
    currentNavMesh = mesh;
    if (visualize) attachNavMeshHelper(mesh);
    return { success: true, navMesh: mesh };
  } catch (err) {
    console.error('[NavMesh] import failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Navmesh import failed',
    };
  }
}

/**
 * Fetch and import a remote `.navmesh` (public storage URL).
 * @param {string} url
 * @param {{ visualize?: boolean }} [options]
 */
export async function loadNavMeshFromUrl(url, options = {}) {
  await ensureRecastLoaded();
  if (!url) return { success: false, error: 'Missing navmesh URL' };
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { success: false, error: `Failed to download navmesh (${res.status})` };
    }
    const buf = await res.arrayBuffer();
    return loadNavMeshFromBytes(buf, options);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Navmesh download failed',
    };
  }
}

export function hasNavMesh() {
  return currentNavMesh !== null;
}

export function getNavMesh() {
  return currentNavMesh;
}
