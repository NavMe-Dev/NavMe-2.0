import type { NavMesh } from 'recast-navigation';
import * as THREE from 'three';
import { defaultFloorLabel, resolveFloorCellSize, type Floor2DMap, type FloorLevel } from './floor2d';
import { finalizeFloor2DFromWalkLite } from './floor2dFinalize';
import { rasterizeTriXZ } from './floor2dRaster';
import { forEachWorldTriangle } from './meshUtils';
import { extractNavMeshTris3D, type NavMeshTri3D } from './navmesh2d';
import { linkStairMouths, newStairMouthId, type StairMouth } from './stairMouth';

export type NavMeshFloorPlanResult = {
  map: Floor2DMap;
  walk: Uint8Array;
  triCount: number;
  walkCells: number;
};

export type NavMeshFloorLayer = {
  floorY: number;
  walk: Uint8Array;
  map: Floor2DMap;
  triCount: number;
  walkCells: number;
};

/** Full-building convert: shared XZ grid + one walk/walls layer per detected floor Y. */
export type NavMeshMultiFloorPlanResult = {
  map: Floor2DMap;
  floors: NavMeshFloorLayer[];
  floorLevels: FloorLevel[];
  triCount: number;
  walkCells: number;
  stairLinks: number;
};

function countWalk(walk: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < walk.length; i++) if (walk[i]) n++;
  return n;
}

function dilate4(src: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (src[i]) {
        out[i] = 1;
        continue;
      }
      if (
        (c > 0 && src[i - 1]) ||
        (c + 1 < cols && src[i + 1]) ||
        (r > 0 && src[i - cols]) ||
        (r + 1 < rows && src[i + cols])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

function erode4(src: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!src[i]) continue;
      if (
        (c === 0 || src[i - 1]) &&
        (c + 1 >= cols || src[i + 1]) &&
        (r === 0 || src[i - cols]) &&
        (r + 1 >= rows || src[i + cols])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

function morphClose(src: Uint8Array, cols: number, rows: number, passes = 1): Uint8Array {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    cur = dilate4(cur, cols, rows);
    cur = erode4(cur, cols, rows);
  }
  return cur;
}

function morphOpen(src: Uint8Array, cols: number, rows: number, passes = 1): Uint8Array {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    cur = erode4(cur, cols, rows);
    cur = dilate4(cur, cols, rows);
  }
  return cur;
}

type CellRect = { c: number; r: number; w: number; h: number };

/** Maximal rectangles covering walk cells (greedy row-span expand). */
function extractMaxCellRects(walk: Uint8Array, cols: number, rows: number): CellRect[] {
  const used = new Uint8Array(walk.length);
  const rects: CellRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!walk[i] || used[i]) continue;
      let w = 1;
      while (c + w < cols && walk[r * cols + c + w] && !used[r * cols + c + w]) w++;
      let h = 1;
      outer: while (r + h < rows) {
        for (let dc = 0; dc < w; dc++) {
          const ii = (r + h) * cols + c + dc;
          if (!walk[ii] || used[ii]) break outer;
        }
        h++;
      }
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) used[(r + dr) * cols + c + dc] = 1;
      }
      rects.push({ c, r, w, h });
    }
  }
  return rects;
}

function paintCellRects(rects: CellRect[], cols: number, rows: number): Uint8Array {
  const walk = new Uint8Array(cols * rows);
  for (const rect of rects) {
    const c1 = Math.min(cols, rect.c + rect.w);
    const r1 = Math.min(rows, rect.r + rect.h);
    for (let r = Math.max(0, rect.r); r < r1; r++) {
      for (let c = Math.max(0, rect.c); c < c1; c++) {
        walk[r * cols + c] = 1;
      }
    }
  }
  return walk;
}

function snapCoord(v: number, step: number, mode: 'floor' | 'ceil'): number {
  if (step <= 1) return v;
  if (mode === 'floor') return Math.floor(v / step) * step;
  return Math.ceil(v / step) * step;
}

/**
 * Turn noisy scan walk into clean axis-aligned boxes:
 * morph smooth → drop tiny blobs → snap rect edges → paint boxes back.
 * Walls extracted from this look like painted 3D Plan walls.
 */
export function rectifyWalkToCleanBoxes(
  walk: Uint8Array,
  cols: number,
  rows: number,
  options: {
    closePasses?: number;
    openPasses?: number;
    minRectCells?: number;
    snapCells?: number;
  } = {},
): Uint8Array {
  const closePasses = options.closePasses ?? 2;
  const openPasses = options.openPasses ?? 1;
  const minRectCells = options.minRectCells ?? 8;
  const snapCells = Math.max(1, options.snapCells ?? 2);

  let cur = walk;
  if (closePasses > 0) cur = morphClose(cur, cols, rows, closePasses);
  if (openPasses > 0) cur = morphOpen(cur, cols, rows, openPasses);
  if (closePasses > 0) cur = morphClose(cur, cols, rows, 1);

  const rects = extractMaxCellRects(cur, cols, rows);
  const kept: CellRect[] = [];
  for (const rect of rects) {
    if (rect.w * rect.h < minRectCells) continue;
    // Snap to a coarser orthogonal grid so walls align into long boxes.
    let c0 = snapCoord(rect.c, snapCells, 'floor');
    let r0 = snapCoord(rect.r, snapCells, 'floor');
    let c1 = snapCoord(rect.c + rect.w, snapCells, 'ceil');
    let r1 = snapCoord(rect.r + rect.h, snapCells, 'ceil');
    c0 = Math.max(0, Math.min(cols - 1, c0));
    r0 = Math.max(0, Math.min(rows - 1, r0));
    c1 = Math.max(c0 + 1, Math.min(cols, c1));
    r1 = Math.max(r0 + 1, Math.min(rows, r1));
    const w = c1 - c0;
    const h = r1 - r0;
    if (w * h < minRectCells) continue;
    kept.push({ c: c0, r: r0, w, h });
  }

  if (kept.length === 0) {
    // Fallback: keep morph-smoothed walk rather than empty.
    return cur;
  }

  // Merge overlapping painted result once more via max-rects for fewer jogs.
  const painted = paintCellRects(kept, cols, rows);
  const merged = extractMaxCellRects(painted, cols, rows).filter(
    (r) => r.w * r.h >= Math.max(4, Math.floor(minRectCells * 0.5)),
  );
  return paintCellRects(merged.length ? merged : kept, cols, rows);
}

function triCentroidY(t: NavMeshTri3D): number {
  return (t.ay + t.by + t.cy) / 3;
}

/** Horizontal floor-plate centroids from the VPS GLB (ignores walls/stairs). */
export function collectGlbHorizontalYs(
  mapRoot: THREE.Object3D,
  normalMinY = 0.62,
): number[] {
  const ys: number[] = [];
  forEachWorldTriangle(mapRoot, (a, b, c, n) => {
    if (n.y < normalMinY) return;
    ys.push((a.y + b.y + c.y) / 3);
  });
  return ys;
}

/**
 * Peak-based floor detection on a Y histogram.
 * Stairs fill Y gaps in navmesh, so gap-clustering fails — peaks do not.
 */
export function detectFloorYsFromHistogram(
  ys: number[],
  options: {
    binSize?: number;
    minSeparation?: number;
    minPeakRatio?: number;
    minPeakCount?: number;
    typicalStoryHeight?: number;
  } = {},
): number[] {
  if (ys.length < 3) return ys.length ? [ys[Math.floor(ys.length / 2)]] : [];

  const binSize = options.binSize ?? 0.28;
  const minSep = options.minSeparation ?? 1.8;
  const minPeakRatio = options.minPeakRatio ?? 0.12;
  const minPeakCount = options.minPeakCount ?? 20;
  const storyH = options.typicalStoryHeight ?? 3.0;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const y of ys) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxY - minY, binSize);
  const nBins = Math.max(1, Math.ceil(span / binSize) + 1);
  const counts = new Float64Array(nBins);
  for (const y of ys) {
    const b = Math.min(nBins - 1, Math.max(0, Math.floor((y - minY) / binSize)));
    counts[b]++;
  }

  // 3-bin smooth
  const smooth = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    const a = counts[Math.max(0, i - 1)];
    const b = counts[i];
    const c = counts[Math.min(nBins - 1, i + 1)];
    smooth[i] = (a + b * 2 + c) / 4;
  }

  let peakMax = 0;
  for (let i = 0; i < nBins; i++) if (smooth[i] > peakMax) peakMax = smooth[i];
  const thresh = Math.max(minPeakCount, peakMax * minPeakRatio);

  type Peak = { bin: number; count: number; y: number };
  const rawPeaks: Peak[] = [];
  for (let i = 1; i < nBins - 1; i++) {
    if (smooth[i] < thresh) continue;
    if (smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1]) {
      rawPeaks.push({ bin: i, count: smooth[i], y: minY + (i + 0.5) * binSize });
    }
  }
  // ends
  if (smooth[0] >= thresh && smooth[0] >= smooth[Math.min(1, nBins - 1)]) {
    rawPeaks.unshift({ bin: 0, count: smooth[0], y: minY + 0.5 * binSize });
  }
  if (
    nBins > 1 &&
    smooth[nBins - 1] >= thresh &&
    smooth[nBins - 1] >= smooth[nBins - 2]
  ) {
    rawPeaks.push({
      bin: nBins - 1,
      count: smooth[nBins - 1],
      y: minY + (nBins - 0.5) * binSize,
    });
  }

  rawPeaks.sort((a, b) => b.count - a.count);
  const chosen: Peak[] = [];
  for (const p of rawPeaks) {
    if (chosen.some((c) => Math.abs(c.y - p.y) < minSep)) continue;
    chosen.push(p);
  }
  chosen.sort((a, b) => a.y - b.y);

  // If span suggests multiple stories but we only found one peak, force splits.
  if (chosen.length <= 1 && span >= minSep * 1.5) {
    const expected = Math.max(2, Math.round(span / storyH) + 1);
    const forced: number[] = [];
    for (let i = 0; i < expected; i++) {
      const target = minY + (span * i) / Math.max(1, expected - 1);
      // snap to densest nearby bin
      let bestBin = 0;
      let best = -1;
      const lo = Math.max(0, Math.floor((target - storyH * 0.4 - minY) / binSize));
      const hi = Math.min(nBins - 1, Math.ceil((target + storyH * 0.4 - minY) / binSize));
      for (let b = lo; b <= hi; b++) {
        if (smooth[b] > best) {
          best = smooth[b];
          bestBin = b;
        }
      }
      const y = minY + (bestBin + 0.5) * binSize;
      if (!forced.some((f) => Math.abs(f - y) < minSep * 0.85)) forced.push(y);
    }
    if (forced.length >= 2) return forced.sort((a, b) => a - b);
  }

  if (chosen.length === 0) {
    return [(minY + maxY) / 2];
  }
  return chosen.map((p) => p.y);
}

function bandForFloor(floorY: number, allYs: number[], fallback: number): number {
  if (allYs.length <= 1) return fallback;
  const sorted = [...allYs].sort((a, b) => a - b);
  const idx = sorted.reduce(
    (best, y, i) => (Math.abs(y - floorY) < Math.abs(sorted[best] - floorY) ? i : best),
    0,
  );
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx + 1 < sorted.length ? sorted[idx + 1] : null;
  let half = fallback;
  if (prev != null) half = Math.min(half, (floorY - prev) * 0.4);
  if (next != null) half = Math.min(half, (next - floorY) * 0.4);
  return Math.max(0.4, Math.min(1.2, half));
}

function boundsFromTris(tris: NavMeshTri3D[], pad: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const t of tris) {
    minX = Math.min(minX, t.ax, t.bx, t.cx);
    maxX = Math.max(maxX, t.ax, t.bx, t.cx);
    minZ = Math.min(minZ, t.az, t.bz, t.cz);
    maxZ = Math.max(maxZ, t.az, t.bz, t.cz);
  }
  return {
    minX: minX - pad,
    maxX: maxX + pad,
    minZ: minZ - pad,
    maxZ: maxZ + pad,
  };
}

function rasterizeFloorWalk(
  tris: NavMeshTri3D[],
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cellSize: number,
  morphPasses: number,
  rectify = true,
): Uint8Array {
  let walk = new Uint8Array(cols * rows);
  for (const t of tris) {
    rasterizeTriXZ(walk, cols, rows, minX, minZ, cellSize, t.ax, t.az, t.bx, t.bz, t.cx, t.cz, 1);
  }
  if (morphPasses > 0) walk = morphClose(walk, cols, rows, morphPasses);
  if (rectify) {
    // Coarser snap on finer grids; keep modest snap on large cells.
    const snapCells = cellSize < 0.2 ? 3 : cellSize < 0.35 ? 2 : 1;
    const minRectCells = Math.max(6, Math.round(1.2 / (cellSize * cellSize)));
    walk = rectifyWalkToCleanBoxes(walk, cols, rows, {
      closePasses: Math.max(2, morphPasses),
      openPasses: 1,
      minRectCells,
      snapCells,
    });
  }
  return walk;
}

function finalizeLayer(
  sliceY: number,
  cellSize: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  cols: number,
  rows: number,
  walk: Uint8Array,
): Floor2DMap {
  return finalizeFloor2DFromWalkLite({
    sliceY,
    cellSize,
    minX,
    maxX,
    minZ,
    maxZ,
    cols,
    rows,
    walk,
  }) as Floor2DMap;
}

function snapToWalk(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cellSize: number,
  x: number,
  z: number,
): { x: number; z: number } | null {
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor((x - minX) / cellSize)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor((z - minZ) / cellSize)));
  const maxR = Math.max(cols, rows);
  for (let rad = 0; rad < maxR; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (rad > 0 && Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        if (!walk[r * cols + c]) continue;
        return {
          x: minX + (c + 0.5) * cellSize,
          z: minZ + (r + 0.5) * cellSize,
        };
      }
    }
  }
  return null;
}

/**
 * Place linked stair mouths between adjacent floors using navmesh tris
 * that span the vertical gap (stairs / ramps).
 */
function autoLinkStairsBetweenFloors(
  floors: FloorLevel[],
  layers: NavMeshFloorLayer[],
  allTris: NavMeshTri3D[],
  cellSize: number,
  minX: number,
  minZ: number,
  cols: number,
  rows: number,
): number {
  if (floors.length < 2) return 0;
  let links = 0;
  const sorted = [...floors].sort((a, b) => a.floorY - b.floorY);

  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    const loLayer = layers.find((l) => Math.abs(l.floorY - lo.floorY) < 1e-3);
    const hiLayer = layers.find((l) => Math.abs(l.floorY - hi.floorY) < 1e-3);
    if (!loLayer || !hiLayer) continue;

    const mid = (lo.floorY + hi.floorY) / 2;
    const halfGap = Math.abs(hi.floorY - lo.floorY) * 0.5;
    const stairTris = allTris.filter((t) => {
      const yMin = Math.min(t.ay, t.by, t.cy);
      const yMax = Math.max(t.ay, t.by, t.cy);
      // spans across mid or sits in the inter-floor band
      return yMin < mid && yMax > mid && yMax - yMin > Math.min(0.6, halfGap * 0.35);
    });
    if (stairTris.length === 0) continue;

    // Cluster stair centroids in XZ (simple grid buckets)
    const bucket = cellSize * 4;
    const buckets = new Map<string, { x: number; z: number; n: number }>();
    for (const t of stairTris) {
      const cx = (t.ax + t.bx + t.cx) / 3;
      const cz = (t.az + t.bz + t.cz) / 3;
      const key = `${Math.round(cx / bucket)}_${Math.round(cz / bucket)}`;
      const cur = buckets.get(key);
      if (cur) {
        cur.x += cx;
        cur.z += cz;
        cur.n++;
      } else {
        buckets.set(key, { x: cx, z: cz, n: 1 });
      }
    }

    const clusters = [...buckets.values()]
      .map((b) => ({ x: b.x / b.n, z: b.z / b.n, n: b.n }))
      .filter((b) => b.n >= 3)
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);

    for (const cluster of clusters) {
      const loPt = snapToWalk(
        loLayer.walk,
        cols,
        rows,
        minX,
        minZ,
        cellSize,
        cluster.x,
        cluster.z,
      );
      const hiPt = snapToWalk(
        hiLayer.walk,
        cols,
        rows,
        minX,
        minZ,
        cellSize,
        cluster.x,
        cluster.z,
      );
      if (!loPt || !hiPt) continue;

      const mouthLo: StairMouth = {
        id: newStairMouthId(),
        x: loPt.x,
        z: loPt.z,
      };
      const mouthHi: StairMouth = {
        id: newStairMouthId(),
        x: hiPt.x,
        z: hiPt.z,
      };
      lo.stairMouths = [...(lo.stairMouths ?? []), mouthLo];
      hi.stairMouths = [...(hi.stairMouths ?? []), mouthHi];
      if (linkStairMouths(floors, lo.id, mouthLo.id, hi.id, mouthHi.id)) links++;
    }
  }
  return links;
}

function floorLabelForIndex(i: number, total: number): string {
  if (total === 1) return 'Floor 1';
  if (i === 0) return 'Ground Floor';
  return defaultFloorLabel(i + 1);
}

export function buildFloorPlanFromNavMesh(
  navMesh: NavMesh,
  sliceY: number,
  options: {
    band?: number;
    cellSize?: number;
    pad?: number;
    morphClosePasses?: number;
  } = {},
): NavMeshFloorPlanResult | null {
  const band = options.band ?? 0.85;
  const pad = options.pad ?? 0.5;
  const morphPasses = options.morphClosePasses ?? 2;

  const tris = extractNavMeshTris3D(navMesh, sliceY, band);
  if (tris.length === 0) return null;

  const { minX, maxX, minZ, maxZ } = boundsFromTris(tris, pad);
  const cellSize = resolveFloorCellSize(minX, maxX, minZ, maxZ, options.cellSize ?? 0.28);
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const walk = rasterizeFloorWalk(tris, cols, rows, minX, minZ, cellSize, morphPasses, true);
  if (countWalk(walk) === 0) return null;

  const map = finalizeLayer(sliceY, cellSize, minX, maxX, minZ, maxZ, cols, rows, walk);
  return {
    map,
    walk,
    triCount: tris.length,
    walkCells: countWalk(walk),
  };
}

/**
 * Convert the entire VPS GLB (+ baked navmesh) into multi-floor plans.
 * Floor Ys come from GLB horizontal surfaces first (stairs don't pollute),
 * then navmesh histogram as fallback. Stair mouths are auto-linked.
 */
export function buildMultiFloorPlanFromNavMesh(
  navMesh: NavMesh,
  options: {
    mapRoot?: THREE.Object3D | null;
    cellSize?: number;
    pad?: number;
    morphClosePasses?: number;
    defaultBand?: number;
  } = {},
): NavMeshMultiFloorPlanResult | null {
  const pad = options.pad ?? 0.5;
  const morphPasses = options.morphClosePasses ?? 2;
  const defaultBand = options.defaultBand ?? 0.9;

  const allTris = extractNavMeshTris3D(navMesh, null);
  if (allTris.length === 0) return null;

  let floorYs: number[] = [];
  if (options.mapRoot) {
    const glbYs = collectGlbHorizontalYs(options.mapRoot);
    if (glbYs.length >= 10) {
      floorYs = detectFloorYsFromHistogram(glbYs, {
        binSize: 0.3,
        minSeparation: 1.8,
        minPeakRatio: 0.1,
        minPeakCount: 25,
      });
    }
  }
  if (floorYs.length <= 1) {
    const navYs = allTris.map(triCentroidY);
    const fromNav = detectFloorYsFromHistogram(navYs, {
      binSize: 0.25,
      minSeparation: 1.8,
      minPeakRatio: 0.08,
      minPeakCount: 12,
    });
    if (fromNav.length > floorYs.length) floorYs = fromNav;
  }
  if (floorYs.length === 0) {
    floorYs = [allTris.reduce((s, t) => s + triCentroidY(t), 0) / allTris.length];
  }

  const { minX, maxX, minZ, maxZ } = boundsFromTris(allTris, pad);
  // Prefer larger cells so walls come out as clean boxes (scan noise averages out).
  const cellSize = resolveFloorCellSize(minX, maxX, minZ, maxZ, options.cellSize ?? 0.28);
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));

  const layers: NavMeshFloorLayer[] = [];
  let totalWalk = 0;
  let totalTris = 0;

  for (const floorY of floorYs) {
    const band = bandForFloor(floorY, floorYs, defaultBand);
    const floorTris = allTris.filter((t) => {
      const yMin = Math.min(t.ay, t.by, t.cy);
      const yMax = Math.max(t.ay, t.by, t.cy);
      const cy = (yMin + yMax) * 0.5;
      // Prefer tris whose centroid sits on this plate (exclude long stair spans).
      return Math.abs(cy - floorY) <= band && yMax - yMin < band * 2.5;
    });
    // Fallback: any overlap with band if centroid filter too strict
    const useTris =
      floorTris.length > 0
        ? floorTris
        : allTris.filter((t) => {
            const yMin = Math.min(t.ay, t.by, t.cy);
            const yMax = Math.max(t.ay, t.by, t.cy);
            return !(yMax < floorY - band || yMin > floorY + band);
          });
    if (useTris.length === 0) continue;

    const walk = rasterizeFloorWalk(useTris, cols, rows, minX, minZ, cellSize, morphPasses, true);
    const walkCells = countWalk(walk);
    if (walkCells === 0) continue;

    const map = finalizeLayer(floorY, cellSize, minX, maxX, minZ, maxZ, cols, rows, walk);
    layers.push({ floorY, walk, map, triCount: useTris.length, walkCells });
    totalWalk += walkCells;
    totalTris += useTris.length;
  }

  if (layers.length === 0) return null;

  const base = layers[0];
  const floorLevels: FloorLevel[] = layers.map((layer, i) => ({
    id: `floor-${i + 1}`,
    label: floorLabelForIndex(i, layers.length),
    floorY: layer.floorY,
    walkGrid: Array.from(layer.walk),
    objects: [],
    zones: [],
    stairMouths: [],
    gridCols: cols,
    gridRows: rows,
    gridCellSize: cellSize,
    gridMinX: minX,
    gridMinZ: minZ,
  }));

  const stairLinks = autoLinkStairsBetweenFloors(
    floorLevels,
    layers,
    allTris,
    cellSize,
    minX,
    minZ,
    cols,
    rows,
  );

  return {
    map: {
      ...base.map,
      floors: floorLevels,
      objects: [],
      zones: [],
    },
    floors: layers,
    floorLevels,
    triCount: totalTris,
    walkCells: totalWalk,
    stairLinks,
  };
}
