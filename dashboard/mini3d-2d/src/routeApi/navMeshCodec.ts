import { init as recastInit } from 'recast-navigation';
import { generateSoloNavMesh } from '@recast-navigation/generators';
import type { NavMesh } from 'recast-navigation';
import {
  NAV_MESH_AGENT_RADIUS,
  NAV_MESH_CELL_HEIGHT,
  NAV_MESH_CELL_SIZE,
  NAV_MESH_WALKABLE_CLIMB,
  NAV_MESH_WALKABLE_HEIGHT,
} from '../config';
import type { SerializedNavMesh } from './types';

let initPromise: Promise<void> | null = null;

async function ensureRecast(): Promise<void> {
  if (!initPromise) initPromise = recastInit();
  await initPromise;
}

export function serializeNavMesh(navMesh: NavMesh): SerializedNavMesh {
  const [positions, indices] = navMesh.getDebugNavMesh();
  return {
    positions: Array.from(positions),
    indices: Array.from(indices),
  };
}

export async function deserializeNavMesh(data: SerializedNavMesh): Promise<NavMesh | null> {
  if (!data.positions.length || !data.indices.length) return null;
  await ensureRecast();
  const cs = NAV_MESH_CELL_SIZE;
  const ch = NAV_MESH_CELL_HEIGHT;
  const config = {
    cs,
    ch,
    walkableSlopeAngle: 60,
    walkableHeight: NAV_MESH_WALKABLE_HEIGHT / ch,
    walkableClimb: NAV_MESH_WALKABLE_CLIMB / ch,
    walkableRadius: NAV_MESH_AGENT_RADIUS / cs,
    borderSize: 0,
    minRegionArea: 2,
    mergeRegionArea: 8,
  };
  const result = generateSoloNavMesh(
    new Float32Array(data.positions),
    new Uint32Array(data.indices),
    config as Parameters<typeof generateSoloNavMesh>[2],
    true,
  );
  if (!result.success || !result.navMesh) return null;
  return result.navMesh;
}
