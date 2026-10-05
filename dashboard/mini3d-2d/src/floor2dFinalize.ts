/** Pure floor-grid post-processing — safe in Web Workers (no THREE). */

export type FloorBlockLite = {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  fill: string;
  label: string;
};

export type WallSegLite = { x1: number; z1: number; x2: number; z2: number };

export type Floor2DMapLite = {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  corridors: FloorBlockLite[];
  stores: FloorBlockLite[];
  objects: FloorBlockLite[];
  zones: FloorBlockLite[];
  floors: unknown[];
  blocks: FloorBlockLite[];
  walls: WallSegLite[];
};

const CORRIDOR_FILL = '#EBEBEB';
const STORE_FILL = '#F7F5F2';
const EPS = 1e-4;

function mergeRects(
  mask: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
  fill: string,
  idPrefix: string,
): FloorBlockLite[] {
  const used = new Uint8Array(mask.length);
  const blocks: FloorBlockLite[] = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (mask[i] === 0 || used[i]) continue;
      let w = 1;
      while (c + w < cols && mask[r * cols + c + w] && !used[r * cols + c + w]) w++;
      let h = 1;
      outer: while (r + h < rows) {
        for (let cc = 0; cc < w; cc++) {
          const ii = (r + h) * cols + c + cc;
          if (!mask[ii] || used[ii]) break outer;
        }
        h++;
      }
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) used[(r + dr) * cols + c + dc] = 1;
      }
      blocks.push({
        id: `${idPrefix}-${id++}`,
        x: minX + c * cell,
        z: minZ + r * cell,
        w: w * cell,
        d: h * cell,
        fill,
        label: '',
      });
    }
  }
  return blocks;
}

function extractStoreMask(walk: Uint8Array, cols: number, rows: number): Uint8Array {
  const stores = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (walk[i]) continue;
      let touchesWalk = false;
      if (r > 0 && walk[(r - 1) * cols + c]) touchesWalk = true;
      else if (r + 1 < rows && walk[(r + 1) * cols + c]) touchesWalk = true;
      else if (c > 0 && walk[r * cols + c - 1]) touchesWalk = true;
      else if (c + 1 < cols && walk[r * cols + c + 1]) touchesWalk = true;
      if (touchesWalk) stores[i] = 1;
    }
  }
  return stores;
}

function extractOrthogonalWalls(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): WallSegLite[] {
  const raw: WallSegLite[] = [];
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

function mergeOrthogonalSegments(segs: WallSegLite[]): WallSegLite[] {
  const horiz: { z: number; x0: number; x1: number }[] = [];
  const vert: { x: number; z0: number; z1: number }[] = [];
  for (const s of segs) {
    if (Math.abs(s.z1 - s.z2) < EPS) {
      horiz.push({ z: s.z1, x0: Math.min(s.x1, s.x2), x1: Math.max(s.x1, s.x2) });
    } else if (Math.abs(s.x1 - s.x2) < EPS) {
      vert.push({ x: s.x1, z0: Math.min(s.z1, s.z2), z1: Math.max(s.z1, s.z2) });
    }
  }
  horiz.sort((a, b) => a.z - b.z || a.x0 - b.x0);
  vert.sort((a, b) => a.x - b.x || a.z0 - b.z0);

  const mergedH: typeof horiz = [];
  for (const h of horiz) {
    const last = mergedH[mergedH.length - 1];
    if (last && Math.abs(last.z - h.z) < EPS && h.x0 <= last.x1 + EPS) {
      last.x1 = Math.max(last.x1, h.x1);
    } else mergedH.push({ ...h });
  }
  const mergedV: typeof vert = [];
  for (const v of vert) {
    const last = mergedV[mergedV.length - 1];
    if (last && Math.abs(last.x - v.x) < EPS && v.z0 <= last.z1 + EPS) {
      last.z1 = Math.max(last.z1, v.z1);
    } else mergedV.push({ ...v });
  }

  const out: WallSegLite[] = [];
  for (const h of mergedH) out.push({ x1: h.x0, z1: h.z, x2: h.x1, z2: h.z });
  for (const v of mergedV) out.push({ x1: v.x, z1: v.z0, x2: v.x, z2: v.z1 });
  return out;
}

export function walkGridHasCells(walk: Uint8Array): boolean {
  for (let i = 0; i < walk.length; i++) {
    if (walk[i]) return true;
  }
  return false;
}

export function finalizeFloor2DFromWalkLite(params: {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  walk: Uint8Array;
}): Floor2DMapLite {
  const { sliceY, cellSize, minX, maxX, minZ, maxZ, cols, rows, walk } = params;
  const corridors = mergeRects(walk, cols, rows, minX, minZ, cellSize, CORRIDOR_FILL, 'block');
  const storeMask = extractStoreMask(walk, cols, rows);
  const stores = mergeRects(storeMask, cols, rows, minX, minZ, cellSize, STORE_FILL, 'store');
  const walls = extractOrthogonalWalls(walk, cols, rows, minX, minZ, cellSize);
  return {
    sliceY,
    cellSize,
    minX,
    maxX,
    minZ,
    maxZ,
    cols,
    rows,
    corridors,
    stores,
    objects: [],
    zones: [],
    floors: [],
    blocks: corridors,
    walls,
  };
}
