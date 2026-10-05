import { resolveFloorCellSize, type Floor2DMap } from './floor2d';
import { finalizeFloor2DFromWalkLite } from './floor2dFinalize';

export type TraceFloorPlanResult = {
  map: Floor2DMap;
  walk: Uint8Array;
  walkCells: number;
};

function countOnes(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load floor plan image'));
    img.src = dataUrl;
  });
}

function dilateMask(src: Uint8Array, w: number, h: number, passes: number): Uint8Array {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) {
          next[i] = 1;
          continue;
        }
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (cur[ny * w + nx]) {
              next[i] = 1;
              break outer;
            }
          }
        }
      }
    }
    cur = next;
  }
  return cur;
}

function erodeMask(src: Uint8Array, w: number, h: number, passes: number): Uint8Array {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
              ok = false;
              break;
            }
            if (!cur[ny * w + nx]) {
              ok = false;
              break;
            }
          }
        }
        if (ok) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** Flood from border through pixels that are NOT blocked → exterior paper. */
function floodExterior(blocked: Uint8Array, w: number, h: number): Uint8Array {
  const exterior = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (exterior[i] || blocked[i]) return;
    exterior[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < w; x++) {
    tryPush(x, 0);
    tryPush(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y);
    tryPush(w - 1, y);
  }

  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    tryPush(x - 1, y);
    tryPush(x + 1, y);
    tryPush(x, y - 1);
    tryPush(x, y + 1);
  }
  return exterior;
}

/** Paint small enclosed voids inside the building (fixtures / noise). */
function fillEnclosedFloorHoles(
  walk: Uint8Array,
  cols: number,
  rows: number,
  maxHoleCells: number,
): Uint8Array {
  const out = new Uint8Array(walk);
  const seen = new Uint8Array(walk.length);
  const stack: number[] = [];

  for (let start = 0; start < walk.length; start++) {
    if (out[start] || seen[start]) continue;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const comp: number[] = [start];
    let touchesBorder = false;

    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols;
      const r = (i / cols) | 0;
      if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) touchesBorder = true;
      const neighbors = [i - 1, i + 1, i - cols, i + cols];
      for (const n of neighbors) {
        if (n < 0 || n >= walk.length) continue;
        const nc = n % cols;
        const nr = (n / cols) | 0;
        if (Math.abs(nc - c) + Math.abs(nr - r) !== 1) continue;
        if (out[n] || seen[n]) continue;
        seen[n] = 1;
        stack.push(n);
        comp.push(n);
      }
    }

    if (!touchesBorder && comp.length > 0 && comp.length <= maxHoleCells) {
      for (const i of comp) out[i] = 1;
    }
  }
  return out;
}

/**
 * Floor-plan → paint + walls (previous better approach, strengthened):
 * 1. Cut only OUTSIDE the building
 * 2. Paint ALL room interiors solid
 * 3. Cut thick wall ink as structure (rooms stay filled — not hollow wireframes)
 */
export async function traceFloorPlanImage(
  dataUrl: string,
  options: {
    sliceY?: number;
    metersWide?: number;
    fitToMap?: Pick<Floor2DMap, 'minX' | 'maxX' | 'minZ' | 'maxZ' | 'cellSize'> | null;
    ignoreFitToMap?: boolean;
    cellSize?: number;
    wallThreshold?: number;
  } = {},
): Promise<TraceFloorPlanResult> {
  const img = await loadImage(dataUrl);
  const iw = Math.max(1, img.naturalWidth || img.width);
  const ih = Math.max(1, img.naturalHeight || img.height);

  const sampleCanvas = document.createElement('canvas');
  const maxSample = 1800;
  const scale = Math.min(1, maxSample / Math.max(iw, ih));
  const sw = Math.max(1, Math.round(iw * scale));
  const sh = Math.max(1, Math.round(ih * scale));
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('Canvas unavailable');
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, sw, sh);
  sctx.drawImage(img, 0, 0, sw, sh);
  const pixels = sctx.getImageData(0, 0, sw, sh).data;
  const nPx = sw * sh;

  // --- 1) Dark wall ink ---
  const thresholds = [options.wallThreshold ?? 0.36, 0.45, 0.55];
  let wallCore = new Uint8Array(nPx);
  let bestDark = 0;
  for (const thresh of thresholds) {
    const cand = new Uint8Array(nPx);
    let dark = 0;
    for (let i = 0, p = 0; i < nPx; i++, p += 4) {
      if (pixels[p + 3] < 20) continue;
      const lum = (pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114) / 255;
      if (lum <= thresh) {
        cand[i] = 1;
        dark++;
      }
    }
    if (dark > bestDark) {
      bestDark = dark;
      wallCore = cand;
      if (dark > nPx * 0.005) break;
    }
  }
  if (bestDark === 0) throw new Error('Could not detect walls in the floor plan image');

  // Connect wall strokes slightly — do NOT erode (erosion opens doors / breaks walls)
  let walls = dilateMask(wallCore, sw, sh, 1);
  if (countOnes(walls) < nPx * 0.002) {
    walls = dilateMask(wallCore, sw, sh, 2);
  }

  // --- 2) Exterior flood with door seal — pick seal that maximizes room paint ---
  // Too weak → flood enters rooms → only wall band left (wireframe / null interiors).
  // Too strong → still OK: rooms remain !exterior and get painted; we cut with thin walls.
  const sealCandidates = [
    Math.max(8, Math.round(Math.min(sw, sh) * 0.012)),
    Math.max(6, Math.round(Math.min(sw, sh) * 0.008)),
    5,
    4,
    3,
  ];

  let bestExterior = floodExterior(dilateMask(walls, sw, sh, sealCandidates[0]), sw, sh);
  let bestFloorScore = -1;

  for (const seal of sealCandidates) {
    const sealed = dilateMask(walls, sw, sh, seal);
    const exterior = floodExterior(sealed, sw, sh);
    const extN = countOnes(exterior);
    // Need real outside paper + real inside rooms
    if (extN < nPx * 0.04 || extN > nPx * 0.92) continue;

    let floorScore = 0;
    for (let i = 0; i < nPx; i++) {
      if (!exterior[i] && !walls[i]) floorScore++;
    }
    // Prefer more painted room area
    if (floorScore > bestFloorScore) {
      bestFloorScore = floorScore;
      bestExterior = exterior;
    }
  }

  // If every seal failed the ratio check, use strongest seal anyway
  if (bestFloorScore < 0) {
    bestExterior = floodExterior(dilateMask(walls, sw, sh, sealCandidates[0]), sw, sh);
    bestFloorScore = 0;
    for (let i = 0; i < nPx; i++) {
      if (!bestExterior[i] && !walls[i]) bestFloorScore++;
    }
  }

  // --- 3) Paint ALL interior (rooms), then keep walls as cuts ---
  // building = everything not exterior (includes wall pixels)
  // floorPx = building minus walls → solid room paint
  const floorPx = new Uint8Array(nPx);
  for (let i = 0; i < nPx; i++) {
    if (!bestExterior[i] && !walls[i]) floorPx[i] = 1;
  }

  // Close speckles inside rooms without painting over walls / exterior
  let floorClosed = dilateMask(floorPx, sw, sh, 2);
  floorClosed = erodeMask(floorClosed, sw, sh, 2);
  for (let i = 0; i < nPx; i++) {
    if (floorClosed[i] && !walls[i] && !bestExterior[i]) floorPx[i] = 1;
  }

  // Fallback: wall bounding box paint if rooms still empty
  if (countOnes(floorPx) < nPx * 0.015) {
    let minWX = sw;
    let maxWX = 0;
    let minWY = sh;
    let maxWY = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (!walls[y * sw + x]) continue;
        if (x < minWX) minWX = x;
        if (x > maxWX) maxWX = x;
        if (y < minWY) minWY = y;
        if (y > maxWY) maxWY = y;
      }
    }
    const pad = Math.round(Math.min(sw, sh) * 0.02);
    minWX = Math.max(0, minWX - pad);
    maxWX = Math.min(sw - 1, maxWX + pad);
    minWY = Math.max(0, minWY - pad);
    maxWY = Math.min(sh - 1, maxWY + pad);

    // Paint whole bbox, then clear true exterior using sealed flood (keep doors closed)
    const sealed = dilateMask(walls, sw, sh, sealCandidates[0]);
    const exterior = floodExterior(sealed, sw, sh);
    for (let y = minWY; y <= maxWY; y++) {
      for (let x = minWX; x <= maxWX; x++) {
        const i = y * sw + x;
        if (!walls[i] && !exterior[i]) floorPx[i] = 1;
      }
    }
    bestExterior = exterior;
  }

  if (countOnes(floorPx) === 0) {
    throw new Error('Could not detect rooms — try a clearer black-and-white floor plan');
  }

  // --- 4) World frame ---
  const useFit = options.fitToMap && options.ignoreFitToMap !== true;
  let minX: number;
  let maxX: number;
  let minZ: number;
  let maxZ: number;
  let cellSize: number;

  if (useFit && options.fitToMap) {
    minX = options.fitToMap.minX;
    maxX = options.fitToMap.maxX;
    minZ = options.fitToMap.minZ;
    maxZ = options.fitToMap.maxZ;
    cellSize = options.cellSize ?? Math.min(options.fitToMap.cellSize ?? 0.12, 0.14);
  } else {
    const metersWide = options.metersWide ?? 28;
    const metersDeep = metersWide * (ih / iw);
    minX = -metersWide / 2;
    maxX = metersWide / 2;
    minZ = -metersDeep / 2;
    maxZ = metersDeep / 2;
    cellSize = resolveFloorCellSize(minX, maxX, minZ, maxZ, options.cellSize ?? 0.11);
  }

  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  let walk = new Uint8Array(cols * rows);

  // --- 5) Rasterize: prefer painting rooms; cut only clear wall cells ---
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, Math.floor((c / cols) * sw));
      const x1 = Math.min(sw, Math.ceil(((c + 1) / cols) * sw));
      const y0 = Math.max(0, Math.floor((r / rows) * sh));
      const y1 = Math.min(sh, Math.ceil(((r + 1) / rows) * sh));
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      let floorHits = 0;
      let wallHits = 0;
      let exteriorHits = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * sw + x;
          if (bestExterior[i]) exteriorHits++;
          if (walls[i]) wallHits++;
          if (floorPx[i]) floorHits++;
        }
      }
      const ef = exteriorHits / area;
      const wf = wallHits / area;
      const ff = floorHits / area;

      // Outside building → cut
      if (ef >= 0.55) {
        walk[r * cols + c] = 0;
        continue;
      }
      // Clear wall core → structure cut
      if (wf >= 0.45 && wf > ff) {
        walk[r * cols + c] = 0;
        continue;
      }
      // Any real floor → paint (rooms must not stay null)
      if (ff >= 0.06 || (ef < 0.35 && wf < 0.35)) {
        walk[r * cols + c] = 1;
        continue;
      }
      if (wf >= 0.3) walk[r * cols + c] = 0;
      else walk[r * cols + c] = 0;
    }
  }

  // Fill enclosed empty pockets inside building (large enough for rooms that were missed)
  const maxHole = Math.max(80, Math.floor(cols * rows * 0.08));
  walk = new Uint8Array(fillEnclosedFloorHoles(walk, cols, rows, maxHole));

  // Light close to merge paint speckles; don't paint over strong walls
  let closed = dilateMask(walk, cols, rows, 1);
  closed = erodeMask(closed, cols, rows, 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!closed[i] || walk[i]) continue;
      const x0 = Math.max(0, Math.floor((c / cols) * sw));
      const x1 = Math.min(sw, Math.ceil(((c + 1) / cols) * sw));
      const y0 = Math.max(0, Math.floor((r / rows) * sh));
      const y1 = Math.min(sh, Math.ceil(((r + 1) / rows) * sh));
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      let wallHits = 0;
      let exteriorHits = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const pi = y * sw + x;
          if (walls[pi]) wallHits++;
          if (bestExterior[pi]) exteriorHits++;
        }
      }
      if (exteriorHits / area >= 0.5) continue;
      if (wallHits / area < 0.4) walk[i] = 1;
    }
  }

  const cells = countOnes(walk);
  if (cells === 0) {
    throw new Error('Could not detect rooms — try a clearer black-and-white floor plan');
  }

  const sliceY = options.sliceY ?? 0;
  const map = finalizeFloor2DFromWalkLite({
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

  return { map, walk, walkCells: cells };
}
