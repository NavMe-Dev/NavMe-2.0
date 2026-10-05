/**
 * Navnode density heat map — red blobs from navme_navnode positions.
 * Ported from SpaceCheck XR dashboard (nav-heatmap.js).
 */
import * as THREE from 'three';
import { getScene, getMultisetAnchor, getMapMeshBounds, setUserHeatmapWireframe, getMatterportAlignRoot } from './scene.js';

const GRID = 256;
const HEAT_OPACITY = 0.92;
/** Cluster navnodes onto separate floors when Y differs by this much. */
const FLOOR_CLUSTER_M = 2.0;
/**
 * Lift heat planes / points above the geometric mesh floor so the overlay
 * is clearly visible (MultiSet mesh map only — not Matterport).
 */
export const MESH_HEATMAP_Y_OFFSET = 1;

/** @type {THREE.Group | null} */
let globalHeatmapGroup = null;

function heatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  return {
    r: 255,
    g: Math.round(4 + x * 42),
    b: 0,
  };
}

/**
 * @param {Array<{ pos_x: number, pos_y: number, pos_z: number }>} points
 */
function normalizePoints(points) {
  return points
    .map((p) => ({
      x: Number(p.pos_x),
      y: Number(p.pos_y),
      z: Number(p.pos_z),
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
}

function filterPointsToMap(pts, options = {}) {
  const mapBox = getMapMeshBounds();
  if (!mapBox || options.ignoreMapBounds) return filterOutliersPercentile(pts);

  const box = mapBox.clone();
  box.expandByScalar(2.5);
  return pts.filter((p) => {
    if (p.x < box.min.x || p.x > box.max.x || p.z < box.min.z || p.z > box.max.z) {
      return false;
    }
    // URL / Showcase space: do not use geometric-mesh Y — floors live in Matterport coords.
    if (options.ignoreMapY) return true;
    return p.y >= box.min.y - 1.5 && p.y <= box.max.y + 2.5;
  });
}

function filterOutliersPercentile(pts, low = 0.03, high = 0.97) {
  if (pts.length < 8) return pts;
  const xs = pts.map((p) => p.x).sort((a, b) => a - b);
  const zs = pts.map((p) => p.z).sort((a, b) => a - b);
  const q = (arr, t) => arr[Math.floor(t * (arr.length - 1))];
  const minX = q(xs, low);
  const maxX = q(xs, high);
  const minZ = q(zs, low);
  const maxZ = q(zs, high);
  return pts.filter((p) => p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ);
}

function boundsForPoints(pts) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
    minY = Math.min(minY, p.y);
  }
  const padX = Math.max((maxX - minX) * 0.08, 1.5);
  const padZ = Math.max((maxZ - minZ) * 0.08, 1.5);
  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minZ: minZ - padZ,
    maxZ: maxZ + padZ,
    floorY: Number.isFinite(minY) ? minY : 0,
  };
}

/** Use the average recorded pos_y — do not pull the plane down toward the floor. */
function planeYFromPoints(pts) {
  if (!pts.length) return 0;
  const ys = pts.map((p) => p.y).filter(Number.isFinite);
  if (!ys.length) return 0;
  return ys.reduce((sum, y) => sum + y, 0) / ys.length;
}

function medianY(pts) {
  const ys = pts.map((p) => p.y).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ys.length) return 0;
  return ys[Math.floor(ys.length / 2)];
}

/**
 * Sit the heat plane on the walkable floor of the URL space (not mesh-mid / eye height).
 * @param {Array<{ y: number }>} pts
 * @param {number | null} cameraY
 */
function matterportFloorY(pts, _cameraY) {
  // Keep recorded navnode height — do not pull the plane down by eye-height.
  return medianY(pts);
}

function clusterPointsByFloor(pts, band = FLOOR_CLUSTER_M) {
  const sorted = [...pts].sort((a, b) => a.y - b.y);
  /** @type {{ pts: typeof pts, centerY: number }[]} */
  const clusters = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p.y - last.centerY) <= band) {
      last.pts.push(p);
      last.centerY = planeYFromPoints(last.pts);
    } else {
      clusters.push({ pts: [p], centerY: p.y });
    }
  }
  return clusters.filter((c) => c.pts.length > 0);
}

function boundsForHeatmap(pts, options = {}) {
  const planeY = options.floorYOverride ?? planeYFromPoints(pts);
  const mapBox = options.ignoreMapBounds ? null : getMapMeshBounds();
  if (mapBox && !options.matterportFloors) {
    const pad = 0.75;
    return {
      minX: mapBox.min.x - pad,
      maxX: mapBox.max.x + pad,
      minZ: mapBox.min.z - pad,
      maxZ: mapBox.max.z + pad,
      floorY: planeY,
    };
  }
  const b = boundsForPoints(pts);
  return { ...b, floorY: planeY };
}

function buildDensityGrid(pts, bounds, weightMultiplier = 1) {
  const grid = new Float32Array(GRID * GRID);
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanZ = bounds.maxZ - bounds.minZ || 1;
  const stampWeight = 1.2 * weightMultiplier;

  const stamp = (x, z, weight = 1) => {
    const gx = ((x - bounds.minX) / spanX) * (GRID - 1);
    const gz = ((z - bounds.minZ) / spanZ) * (GRID - 1);
    if (gx < 0 || gz < 0 || gx > GRID - 1 || gz > GRID - 1) return;
    const radius = 5;
    const ix = Math.round(gx);
    const iz = Math.round(gz);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = ix + dx;
        const cz = iz + dz;
        if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) continue;
        const dist = Math.hypot(dx, dz);
        if (dist > radius) continue;
        const w = weight * Math.exp(-(dist * dist) / (radius * 0.38) ** 2);
        grid[cz * GRID + cx] += w;
      }
    }
  };

  for (const p of pts) stamp(p.x, p.z, stampWeight);

  return { grid, spanX, spanZ };
}

function gridMaxForNormalize(grid, { percentile = 0.9, minMax = 1 } = {}) {
  const values = [];
  let absoluteMax = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v <= 0) continue;
    values.push(v);
    if (v > absoluteMax) absoluteMax = v;
  }
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  const idx = Math.min(values.length - 1, Math.floor(percentile * (values.length - 1)));
  const percentileMax = values[idx];
  return Math.max(minMax, Math.min(absoluteMax, percentileMax * 1.15));
}

function gridToCanvas(grid, options = {}) {
  const gamma = options.gamma ?? 0.5;
  const alphaFloor = options.alphaFloor ?? 0.08;
  const max = gridMaxForNormalize(grid, {
    percentile: options.percentile ?? 0.9,
    minMax: options.minMax ?? 1,
  });

  const canvas = document.createElement('canvas');
  canvas.width = GRID;
  canvas.height = GRID;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(GRID, GRID);
  for (let i = 0; i < grid.length; i++) {
    const t = Math.pow(grid[i] / max, gamma);
    const { r, g, b } = heatColor(Math.min(1, t * 1.1));
    const a = t > alphaFloor ? Math.round(75 + t * 180) : 0;
    const o = i * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function disposeGroup(group) {
  if (!group) return;
  const alignRoot = getMatterportAlignRoot();
  const anchor = getMultisetAnchor();
  const sceneRef = getScene();
  if (group.parent) group.parent.remove(group);
  else if (alignRoot) alignRoot.remove(group);
  else if (anchor) anchor.remove(group);
  else if (sceneRef) sceneRef.remove(group);
  group.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
}

function specFromPoints(pts, options = {}) {
  if (!pts.length) return null;
  const bounds = boundsForHeatmap(pts, options);
  const weightMultiplier = options.weightMultiplier ?? 1;
  const { grid, spanX, spanZ } = buildDensityGrid(pts, bounds, weightMultiplier);
  const canvas = gridToCanvas(grid, options.canvas ?? {});
  return {
    canvas,
    spanX,
    spanZ,
    x: bounds.minX + spanX / 2,
    y: bounds.floorY,
    z: bounds.minZ + spanZ / 2,
  };
}

/**
 * One or more heat planes. On the URL / Showcase space, Y is per floor.
 * @returns {Array<{ canvas: HTMLCanvasElement, spanX: number, spanZ: number, x: number, y: number, z: number }>}
 */
export function buildHeatmapPlaneSpecs(rawPoints, options = {}) {
  const filterOpts = {
    ignoreMapY: Boolean(options.matterportFloors),
    ignoreMapBounds: Boolean(options.matterportFloors),
  };
  const pts = filterPointsToMap(normalizePoints(rawPoints), filterOpts);
  if (!pts.length) return [];

  // Always cluster by floor (works for both Matterport and geometric mesh).
  // For geometric mesh, raise each floor's Y by the offset so layers don't overlap.
  return clusterPointsByFloor(pts)
    .map((cluster) => {
      if (options.matterportFloors) {
        return specFromPoints(cluster.pts, {
          ...options,
          matterportFloors: true,
          ignoreMapBounds: true,
          floorYOverride: matterportFloorY(cluster.pts, options.cameraY),
        });
      }

      // Geometric mesh: raise each floor's Y so layers stack vertically without overlap.
      const yOffset =
        options.yOffset != null ? Number(options.yOffset) : MESH_HEATMAP_Y_OFFSET;
      const raised =
        Number.isFinite(yOffset) && yOffset !== 0
          ? cluster.pts.map((p) => ({ ...p, y: p.y + yOffset * (cluster.centerY / 2) }))
          : cluster.pts;

      return specFromPoints(raised, {
        ...options,
        floorYOverride: planeYFromPoints(raised),
      });
    })
    .filter(Boolean);
}

/**
 * Canvas + placement for a heat plane. Used by both the mesh map and Matterport Scene overlay.
 * @returns {{ canvas: HTMLCanvasElement, spanX: number, spanZ: number, x: number, y: number, z: number } | null}
 */
export function buildHeatmapPlaneSpec(rawPoints, options = {}) {
  return buildHeatmapPlaneSpecs(rawPoints, options)[0] || null;
}

function addHeatPlane(group, spec) {
  const texture = new THREE.CanvasTexture(spec.canvas);
  texture.needsUpdate = true;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(spec.spanX, spec.spanZ),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: HEAT_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(spec.x, spec.y, spec.z);
  group.add(plane);
}

function buildHeatmapGroup(rawPoints, options = {}) {
  const group = new THREE.Group();
  for (const spec of buildHeatmapPlaneSpecs(rawPoints, options)) {
    addHeatPlane(group, spec);
  }
  return group;
}

function mountGroup(group) {
  // Prefer Matterport align root so MultiSet heat follows mesh registration;
  // POIs stay on MultisetAnchor and are hidden while Showcase tags are active.
  const alignRoot = getMatterportAlignRoot();
  const anchor = getMultisetAnchor();
  const sceneRef = getScene();
  if (alignRoot?.userData?._mpAligned) alignRoot.add(group);
  else if (anchor) anchor.add(group);
  else if (sceneRef) sceneRef.add(group);
}

export function clearGlobalHeatmap() {
  disposeGroup(globalHeatmapGroup);
  globalHeatmapGroup = null;
}

export function clearAllHeatmaps() {
  clearGlobalHeatmap();
  clearUserHeatmap();
}

/** Combined navnode density for the active project (navme_navnode). */
export function showGlobalHeatmap(points, options = {}) {
  clearGlobalHeatmap();
  globalHeatmapGroup = buildHeatmapGroup(points, {
    weightMultiplier: 1.35,
    canvas: {
      percentile: 0.82,
      gamma: 0.42,
      alphaFloor: 0.035,
    },
    ...options,
  });
  globalHeatmapGroup.name = 'GlobalNavHeatmap';
  mountGroup(globalHeatmapGroup);
}

/** @type {THREE.Group | null} */
let userHeatmapGroup = null;

export function clearUserHeatmap() {
  disposeGroup(userHeatmapGroup);
  userHeatmapGroup = null;
  setUserHeatmapWireframe(false);
}

/** Per-user navnode trail heat map. */
export function showUserHeatmap(points, options = {}) {
  clearUserHeatmap();
  userHeatmapGroup = buildHeatmapGroup(points, options);
  userHeatmapGroup.name = 'UserNavHeatmap';
  mountGroup(userHeatmapGroup);
  setUserHeatmapWireframe(true);
}

export function setUserHeatmapVisible(visible) {
  if (userHeatmapGroup) userHeatmapGroup.visible = visible;
}

export function setGlobalHeatmapVisible(visible) {
  if (globalHeatmapGroup) globalHeatmapGroup.visible = visible;
}
