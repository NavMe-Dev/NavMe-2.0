import type { FloorBlock } from '../floor2d';
import { clearStairPortalCache, computeMultiFloorRoute } from '../floor2dMultiRoute';
import { deserializeNavMesh } from './navMeshCodec';
import type { RouteComputeRequest, RouteComputeResponse } from './types';

export async function handleRouteCompute(body: RouteComputeRequest): Promise<RouteComputeResponse> {
  try {
    if (!body.map || !body.floors?.length) {
      return { ok: false, error: 'Missing map or floors' };
    }
    if (!body.origin || !body.destination) {
      return { ok: false, error: 'Missing origin or destination' };
    }

    clearStairPortalCache();

    const navMesh = body.navMesh ? await deserializeNavMesh(body.navMesh) : null;
    const activeWalk =
      body.activeWalk && body.activeWalk.length === body.map.cols * body.map.rows
        ? new Uint8Array(body.activeWalk.map((v) => (v ? 1 : 0)))
        : null;

    const plan = computeMultiFloorRoute(
      body.map,
      body.floors,
      navMesh,
      body.origin,
      body.destination,
      activeWalk,
      body.activeFloorId,
      (body.activeObjects ?? []) as FloorBlock[],
    );

    return { ok: true, plan };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
