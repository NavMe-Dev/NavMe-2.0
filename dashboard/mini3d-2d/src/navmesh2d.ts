import type { NavMesh } from 'recast-navigation';

export type NavMeshSliceTri = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  cx: number;
  cz: number;
};

/** Full XYZ triangle from Recast debug navmesh (for 3D diagram / overlay). */
export type NavMeshTri3D = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
};

/** Project navmesh debug triangles onto the XZ plane near sliceY. */
export function extractNavMeshSlice2D(
  navMesh: NavMesh,
  sliceY: number,
  band = 0.45,
): NavMeshSliceTri[] {
  const [positions, indices] = navMesh.getDebugNavMesh();
  const tris: NavMeshSliceTri[] = [];

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const ay = positions[ia + 1];
    const by = positions[ib + 1];
    const cy = positions[ic + 1];
    const yMin = Math.min(ay, by, cy);
    const yMax = Math.max(ay, by, cy);
    if (yMax < sliceY - band || yMin > sliceY + band) continue;

    tris.push({
      ax: positions[ia],
      az: positions[ia + 2],
      bx: positions[ib],
      bz: positions[ib + 2],
      cx: positions[ic],
      cz: positions[ic + 2],
    });
  }

  return tris;
}

/**
 * Extract navmesh triangles with Y preserved.
 * When `sliceY` is set, only tris near that floor band are included; otherwise all.
 */
export function extractNavMeshTris3D(
  navMesh: NavMesh,
  sliceY: number | null = null,
  band = 0.85,
): NavMeshTri3D[] {
  const [positions, indices] = navMesh.getDebugNavMesh();
  const tris: NavMeshTri3D[] = [];

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const ay = positions[ia + 1];
    const by = positions[ib + 1];
    const cy = positions[ic + 1];
    if (sliceY != null) {
      const yMin = Math.min(ay, by, cy);
      const yMax = Math.max(ay, by, cy);
      if (yMax < sliceY - band || yMin > sliceY + band) continue;
    }

    tris.push({
      ax: positions[ia],
      ay,
      az: positions[ia + 2],
      bx: positions[ib],
      by,
      bz: positions[ib + 2],
      cx: positions[ic],
      cy,
      cz: positions[ic + 2],
    });
  }

  return tris;
}

/** Build a flat position + index buffer from debug navmesh (optionally floor-filtered). */
export function navMeshDebugToBuffers(
  navMesh: NavMesh,
  sliceY: number | null = null,
  band = 0.85,
): { positions: Float32Array; indices: Uint32Array } | null {
  const tris = extractNavMeshTris3D(navMesh, sliceY, band);
  if (tris.length === 0) return null;
  const positions = new Float32Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const o = i * 9;
    positions[o] = t.ax;
    positions[o + 1] = t.ay;
    positions[o + 2] = t.az;
    positions[o + 3] = t.bx;
    positions[o + 4] = t.by;
    positions[o + 5] = t.bz;
    positions[o + 6] = t.cx;
    positions[o + 7] = t.cy;
    positions[o + 8] = t.cz;
    const vi = i * 3;
    indices[vi] = vi;
    indices[vi + 1] = vi + 1;
    indices[vi + 2] = vi + 2;
  }
  return { positions, indices };
}
