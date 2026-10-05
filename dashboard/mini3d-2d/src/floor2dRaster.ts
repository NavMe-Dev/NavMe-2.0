/** Pure XZ rasterization — safe to run in a Web Worker (no THREE dependency). */

function pointInTri2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): boolean {
  const v0x = cx - ax;
  const v0z = cz - az;
  const v1x = bx - ax;
  const v1z = bz - az;
  const v2x = px - ax;
  const v2z = pz - az;
  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;
  const inv = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(inv) < 1e-12) return false;
  const u = (dot11 * dot02 - dot01 * dot12) / inv;
  const v = (dot00 * dot12 - dot01 * dot02) / inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

export function rasterizeTriXZ(
  grid: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  value: number,
): void {
  const tminX = Math.min(ax, bx, cx);
  const tmaxX = Math.max(ax, bx, cx);
  const tminZ = Math.min(az, bz, cz);
  const tmaxZ = Math.max(az, bz, cz);
  const c0 = Math.max(0, Math.floor((tminX - minX) / cell));
  const c1 = Math.min(cols - 1, Math.floor((tmaxX - minX) / cell));
  const r0 = Math.max(0, Math.floor((tminZ - minZ) / cell));
  const r1 = Math.min(rows - 1, Math.floor((tmaxZ - minZ) / cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const px = minX + (c + 0.5) * cell;
      const pz = minZ + (r + 0.5) * cell;
      if (pointInTri2D(px, pz, ax, az, bx, bz, cx, cz)) {
        grid[r * cols + c] = Math.max(grid[r * cols + c], value);
      }
    }
  }
}

/** 9 floats per triangle: ax, az, ay, bx, bz, by, cx, cz, cy */
export function rasterizeFloorTriangles(
  positions: Float32Array,
  triCount: number,
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cellSize: number,
  value = 1,
): void {
  const stride = 9;
  for (let t = 0; t < triCount; t++) {
    const o = t * stride;
    rasterizeTriXZ(
      walk,
      cols,
      rows,
      minX,
      minZ,
      cellSize,
      positions[o],
      positions[o + 1],
      positions[o + 3],
      positions[o + 4],
      positions[o + 6],
      positions[o + 7],
      value,
    );
  }
}
