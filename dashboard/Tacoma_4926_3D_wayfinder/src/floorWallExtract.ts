/** Wall segment in world XZ — shared by main thread and wall worker. */
export type WallSeg = { x1: number; z1: number; x2: number; z2: number };

const WALL_EPS = 1e-4;

export function mergeOrthogonalSegments(segs: WallSeg[]): WallSeg[] {
  const horiz: { z: number; x0: number; x1: number }[] = [];
  const vert: { x: number; z0: number; z1: number }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (Math.abs(s.z1 - s.z2) < WALL_EPS) {
      horiz.push({ z: s.z1, x0: Math.min(s.x1, s.x2), x1: Math.max(s.x1, s.x2) });
    } else if (Math.abs(s.x1 - s.x2) < WALL_EPS) {
      vert.push({ x: s.x1, z0: Math.min(s.z1, s.z2), z1: Math.max(s.z1, s.z2) });
    }
  }
  horiz.sort((a, b) => a.z - b.z || a.x0 - b.x0);
  vert.sort((a, b) => a.x - b.x || a.z0 - b.z0);

  const mergedH: { z: number; x0: number; x1: number }[] = [];
  for (let i = 0; i < horiz.length; i++) {
    const h = horiz[i];
    const last = mergedH[mergedH.length - 1];
    if (last && Math.abs(last.z - h.z) < WALL_EPS && h.x0 <= last.x1 + WALL_EPS) {
      last.x1 = Math.max(last.x1, h.x1);
    } else mergedH.push({ z: h.z, x0: h.x0, x1: h.x1 });
  }
  const mergedV: { x: number; z0: number; z1: number }[] = [];
  for (let i = 0; i < vert.length; i++) {
    const v = vert[i];
    const last = mergedV[mergedV.length - 1];
    if (last && Math.abs(last.x - v.x) < WALL_EPS && v.z0 <= last.z1 + WALL_EPS) {
      last.z1 = Math.max(last.z1, v.z1);
    } else mergedV.push({ x: v.x, z0: v.z0, z1: v.z1 });
  }

  const out: WallSeg[] = [];
  for (let i = 0; i < mergedH.length; i++) {
    const h = mergedH[i];
    out.push({ x1: h.x0, z1: h.z, x2: h.x1, z2: h.z });
  }
  for (let i = 0; i < mergedV.length; i++) {
    const v = mergedV[i];
    out.push({ x1: v.x, z1: v.z0, x2: v.x, z2: v.z1 });
  }
  return out;
}

/** Extract merged wall segments from a walk bitmap (runs on main thread or in a worker). */
export function extractWallsFromWalk(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): WallSeg[] {
  const raw: WallSeg[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const left = c > 0 ? walk[r * cols + c - 1] : 0;
      const right = c < cols ? walk[r * cols + c] : 0;
      if (!left && !right) continue;
      if (left !== right) {
        const x = minX + c * cell;
        raw.push({ x1: x, z1: minZ + r * cell, x2: x, z2: minZ + (r + 1) * cell });
      }
    }
  }
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      const up = r > 0 ? walk[(r - 1) * cols + c] : 0;
      const down = r < rows ? walk[r * cols + c] : 0;
      if (!up && !down) continue;
      if (up !== down) {
        const z = minZ + r * cell;
        raw.push({ x1: minX + c * cell, z1: z, x2: minX + (c + 1) * cell, z2: z });
      }
    }
  }
  return mergeOrthogonalSegments(raw);
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 32 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function extractWallsChunked(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): Promise<WallSeg[]> {
  const raw: WallSeg[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const left = c > 0 ? walk[r * cols + c - 1] : 0;
      const right = c < cols ? walk[r * cols + c] : 0;
      if (!left && !right) continue;
      if (left !== right) {
        const x = minX + c * cell;
        raw.push({ x1: x, z1: minZ + r * cell, x2: x, z2: minZ + (r + 1) * cell });
      }
    }
    if (r > 0 && r % 48 === 0) await yieldToMain();
  }
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      const up = r > 0 ? walk[(r - 1) * cols + c] : 0;
      const down = r < rows ? walk[r * cols + c] : 0;
      if (!up && !down) continue;
      if (up !== down) {
        const z = minZ + r * cell;
        raw.push({ x1: minX + c * cell, z1: z, x2: minX + (c + 1) * cell, z2: z });
      }
    }
    if (r > 0 && r % 48 === 0) await yieldToMain();
  }
  return mergeOrthogonalSegments(raw);
}

type WallWorkerReply = { jobId: number; walls: WallSeg[] };
type WallWorkerRequest = {
  jobId: number;
  walk: Uint8Array;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  cell: number;
};

let wallWorkers: Worker[] = [];
let wallWorkerJobId = 0;
const WALL_WORKER_POOL = 2;

function pickWallWorker(): Worker {
  if (wallWorkers.length < WALL_WORKER_POOL) {
    const worker = new Worker(new URL('./floorWallWorker.ts', import.meta.url), { type: 'module' });
    wallWorkers.push(worker);
    return worker;
  }
  return wallWorkers[wallWorkerJobId % WALL_WORKER_POOL];
}

function extractWallsInWorker(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): Promise<WallSeg[]> {
  return new Promise((resolve, reject) => {
    try {
      const jobId = ++wallWorkerJobId;
      const wallWorker = pickWallWorker();
      const walkCopy = new Uint8Array(walk);
      const onMessage = (e: MessageEvent<WallWorkerReply>) => {
        if (e.data.jobId !== jobId) return;
        wallWorker.removeEventListener('message', onMessage);
        wallWorker.removeEventListener('error', onError);
        resolve(e.data.walls);
      };
      const onError = (err: ErrorEvent) => {
        wallWorker.removeEventListener('message', onMessage);
        wallWorker.removeEventListener('error', onError);
        reject(err.error ?? err.message);
      };
      wallWorker.addEventListener('message', onMessage);
      wallWorker.addEventListener('error', onError);
      const payload: WallWorkerRequest = {
        jobId,
        walk: walkCopy,
        cols,
        rows,
        minX,
        minZ,
        cell,
      };
      wallWorker.postMessage(payload, [walkCopy.buffer]);
    } catch {
      reject(new Error('wall worker unavailable'));
    }
  });
}

const WALL_WORKER_MIN_CELLS = 800;

/** Prefer a Web Worker; fall back to chunked main-thread extraction. */
export async function extractWallsFromWalkAsync(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): Promise<WallSeg[]> {
  const cells = cols * rows;
  if (cells >= WALL_WORKER_MIN_CELLS && typeof Worker !== 'undefined') {
    try {
      return await extractWallsInWorker(walk, cols, rows, minX, minZ, cell);
    } catch {
      /* fall through */
    }
  }
  if (cells >= 800) {
    return extractWallsChunked(walk, cols, rows, minX, minZ, cell);
  }
  return extractWallsFromWalk(walk, cols, rows, minX, minZ, cell);
}

const floorWallsCache = new Map<string, WallSeg[]>();

function walkFingerprint(walk: Uint8Array): string {
  let h = walk.length;
  const step = Math.max(1, Math.floor(walk.length / 48));
  for (let i = 0; i < walk.length; i += step) h = (h * 33) ^ walk[i];
  return String(h);
}

export function getCachedFloorWalls(
  floorId: string,
  walk: Uint8Array,
  cols: number,
  rows: number,
): WallSeg[] | null {
  const key = `${floorId}|${cols}x${rows}|${walkFingerprint(walk)}`;
  return floorWallsCache.get(key) ?? null;
}

export function cacheFloorWalls(
  floorId: string,
  walk: Uint8Array,
  cols: number,
  rows: number,
  walls: WallSeg[],
): void {
  const key = `${floorId}|${cols}x${rows}|${walkFingerprint(walk)}`;
  floorWallsCache.set(key, walls);
}

export function clearFloorWallsCache(): void {
  floorWallsCache.clear();
  for (let i = 0; i < wallWorkers.length; i++) wallWorkers[i].terminate();
  wallWorkers = [];
}
