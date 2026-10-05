import * as THREE from 'three';
import {
  buildFloor2DFromMap,
  resolveFloorCellSize,
  type Floor2DMap,
} from './floor2d';
import { finalizeFloor2DFromWalkLite, walkGridHasCells } from './floor2dFinalize';
import { collectWorldFloorTrianglesAsync, computeBoxFromObjectAsync } from './meshUtils';
import { rasterizeFloorTriangles } from './floor2dRaster';
import { yieldToMain } from './schedYield';
import type {
  FloorFinalizeRequest,
  FloorFinalizeResponse,
  FloorRasterizeRequest,
  FloorRasterizeResponse,
  FloorWorkerResponse,
} from './floor2dBuild.worker';

const MIN_TRIS_PER_WORKER = 2500;

function floorWorkerCount(): number {
  if (typeof navigator === 'undefined') return 2;
  return Math.min(4, Math.max(2, navigator.hardwareConcurrency || 2));
}

class FloorWorkerPool {
  private workers: Worker[] = [];
  private nextId = 0;

  private ensure(): Worker[] {
    if (this.workers.length) return this.workers;
    if (typeof Worker === 'undefined') return [];
    const n = floorWorkerCount();
    for (let i = 0; i < n; i++) {
      try {
        this.workers.push(new Worker(new URL('./floor2dBuild.worker.ts', import.meta.url), { type: 'module' }));
      } catch {
        break;
      }
    }
    return this.workers;
  }

  private runOnWorker<T extends FloorWorkerResponse>(
    worker: Worker,
    msg: FloorRasterizeRequest | FloorFinalizeRequest,
  ): Promise<T> {
    const id = ++this.nextId;
    const payload = { ...msg, id };
    return new Promise((resolve, reject) => {
      const onMessage = (ev: MessageEvent<FloorWorkerResponse>) => {
        if (ev.data.id !== id) return;
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        resolve(ev.data as T);
      };
      const onError = (err: ErrorEvent) => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        reject(err.error ?? new Error('floor worker failed'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(payload);
    });
  }

  async rasterize(
    positions: Float32Array,
    triCount: number,
    cols: number,
    rows: number,
    minX: number,
    minZ: number,
    cellSize: number,
  ): Promise<Uint8Array> {
    const pool = this.ensure();
    if (!pool.length) throw new Error('no workers');

    if (triCount < MIN_TRIS_PER_WORKER * 2) {
      const res = await this.runOnWorker<FloorRasterizeResponse>(pool[0], {
        type: 'rasterize',
        id: 0,
        positions,
        triCount,
        cols,
        rows,
        minX,
        minZ,
        cellSize,
      });
      return res.walk;
    }

    const chunk = Math.ceil(triCount / pool.length);
    const tasks: Promise<FloorRasterizeResponse>[] = [];
    for (let i = 0; i < pool.length; i++) {
      const start = i * chunk;
      const end = Math.min(triCount, start + chunk);
      if (start >= end) break;
      tasks.push(
        this.runOnWorker<FloorRasterizeResponse>(pool[i % pool.length], {
          type: 'rasterize',
          id: 0,
          positions: positions.subarray(start * 9, end * 9),
          triCount: end - start,
          cols,
          rows,
          minX,
          minZ,
          cellSize,
        }),
      );
    }

    const parts = await Promise.all(tasks);
    const walk = new Uint8Array(cols * rows);
    for (const part of parts) {
      const grid = part.walk;
      for (let i = 0; i < walk.length; i++) {
        if (grid[i]) walk[i] = 1;
      }
    }
    return walk;
  }

  async finalize(params: {
    sliceY: number;
    cellSize: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    cols: number;
    rows: number;
    walk: Uint8Array;
  }): Promise<Floor2DMap> {
    const pool = this.ensure();
    if (!pool.length) return finalizeFloor2DFromWalkLite(params) as Floor2DMap;
    const res = await this.runOnWorker<FloorFinalizeResponse>(pool[0], {
      type: 'finalize',
      id: 0,
      ...params,
    });
    return res.map as Floor2DMap;
  }
}

const floorWorkers = new FloorWorkerPool();

export type FloorGridCache = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cellSize: number;
  cols: number;
  rows: number;
};

async function rasterizeOnMainChunked(
  positions: Float32Array,
  triCount: number,
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cellSize: number,
  onProgress?: (pct: number, label: string) => void,
): Promise<void> {
  const chunk = 400;
  for (let t = 0; t < triCount; t += chunk) {
    const end = Math.min(triCount, t + chunk);
    const slice = positions.subarray(t * 9, end * 9);
    rasterizeFloorTriangles(slice, end - t, walk, cols, rows, minX, minZ, cellSize, 1);
    onProgress?.(20 + Math.round((end / triCount) * 55), `Rasterizing floor ${Math.round((end / triCount) * 100)}%…`);
    if (t + chunk < triCount) await yieldToMain();
  }
}

export async function buildFloor2DFromMapAsync(
  mapRoot: THREE.Object3D,
  sliceY: number,
  options: { cellSize?: number; band?: number; gridCache?: FloorGridCache | null } = {},
  onProgress?: (pct: number, label: string) => void,
): Promise<Floor2DMap> {
  const band = options.band ?? 0.45;
  let minX: number;
  let maxX: number;
  let minZ: number;
  let maxZ: number;
  let cellSize: number;
  let cols: number;
  let rows: number;

  const cached = options.gridCache;
  if (cached) {
    ({ minX, maxX, minZ, maxZ, cellSize, cols, rows } = cached);
    onProgress?.(5, 'Re-slicing floor at new height…');
  } else {
    onProgress?.(2, 'Measuring map bounds…');
    const box = await computeBoxFromObjectAsync(mapRoot);
    if (box.isEmpty()) return buildFloor2DFromMap(mapRoot, sliceY, options);
    const pad = 0.5;
    minX = box.min.x - pad;
    maxX = box.max.x + pad;
    minZ = box.min.z - pad;
    maxZ = box.max.z + pad;
    cellSize = resolveFloorCellSize(minX, maxX, minZ, maxZ, options.cellSize ?? 0.12);
    cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  }

  onProgress?.(5, `Scanning mesh (${floorWorkerCount()} workers)…`);
  const { positions, triCount } = await collectWorldFloorTrianglesAsync(mapRoot, sliceY, band, {
    yieldEvery: cached ? 1500 : 4000,
    onProgress: (done, total) => {
      if (total > 0) {
        onProgress?.(5 + Math.round((done / total) * 12), `Scanning mesh ${Math.round((done / total) * 100)}%…`);
      }
    },
  });

  onProgress?.(18, `Rasterizing floor (${floorWorkerCount()} threads)…`);
  let walk: Uint8Array;

  if (triCount > 0) {
    try {
      walk = await floorWorkers.rasterize(positions, triCount, cols, rows, minX, minZ, cellSize);
    } catch {
      walk = new Uint8Array(cols * rows);
      await rasterizeOnMainChunked(
        positions,
        triCount,
        walk,
        cols,
        rows,
        minX,
        minZ,
        cellSize,
        onProgress,
      );
    }
  } else {
    walk = new Uint8Array(cols * rows);
  }

  if (!walkGridHasCells(walk)) {
    onProgress?.(78, 'Retrying floor slice (all orientations)…');
    const fallback = await collectWorldFloorTrianglesAsync(mapRoot, sliceY, band, {
      yieldEvery: 4000,
      includeAllOrientations: true,
    });
    walk = new Uint8Array(cols * rows);
    if (fallback.triCount > 0) {
      try {
        walk = await floorWorkers.rasterize(
          fallback.positions,
          fallback.triCount,
          cols,
          rows,
          minX,
          minZ,
          cellSize,
        );
      } catch {
        await rasterizeOnMainChunked(
          fallback.positions,
          fallback.triCount,
          walk,
          cols,
          rows,
          minX,
          minZ,
          cellSize,
          onProgress,
        );
      }
    }
  }

  onProgress?.(85, 'Merging floor regions (background thread)…');
  await yieldToMain();
  const map = await floorWorkers.finalize({
    sliceY,
    cellSize,
    minX,
    maxX,
    minZ,
    maxZ,
    cols,
    rows,
    walk,
  });
  onProgress?.(100, 'Floor plan ready');
  return map;
}

/** Run corridor/wall merge on a walk grid off the main thread. */
export async function finalizeFloorMapFromWalkGrid(params: {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  walk: Uint8Array;
}): Promise<Floor2DMap> {
  await yieldToMain();
  return floorWorkers.finalize(params);
}
