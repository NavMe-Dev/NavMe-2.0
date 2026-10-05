import type { Floor2DMap, FloorBlock, FloorLevel } from '../floor2d';
import type { MultiFloorRoutePlan } from '../floor2dMultiRoute';
import type { NavMesh } from 'recast-navigation';
import { serializeNavMesh } from './navMeshCodec';
import type { RouteComputeRequest, RouteComputeResponse } from './types';

export type FetchMultiFloorRouteOptions = {
  apiBase?: string;
  map: Floor2DMap;
  floors: FloorLevel[];
  navMesh: NavMesh | null;
  origin: { x: number; y: number; z: number };
  destination: { x: number; y: number; z: number };
  activeWalk: Uint8Array | null;
  activeFloorId: string | null;
  activeObjects: FloorBlock[];
};

function defaultApiBase(): string {
  if (typeof window !== 'undefined') {
    const custom = (window as Window & { __NAVME_2D_ROUTE_API__?: string }).__NAVME_2D_ROUTE_API__;
    if (custom) return custom.replace(/\/$/, '');
    return `${window.location.origin}/api/route`;
  }
  return '/api/route';
}

export async function fetchMultiFloorRoute(
  options: FetchMultiFloorRouteOptions,
): Promise<MultiFloorRoutePlan> {
  const apiBase = (options.apiBase ?? defaultApiBase()).replace(/\/$/, '');
  const body: RouteComputeRequest = {
    map: options.map,
    floors: options.floors,
    origin: options.origin,
    destination: options.destination,
    activeFloorId: options.activeFloorId,
    activeWalk: options.activeWalk ? Array.from(options.activeWalk) : null,
    activeObjects: options.activeObjects,
    navMesh: options.navMesh ? serializeNavMesh(options.navMesh) : null,
  };

  const res = await fetch(`${apiBase}/compute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let payload: RouteComputeResponse;
  try {
    payload = (await res.json()) as RouteComputeResponse;
  } catch {
    return {
      multiFloor: false,
      segments: [],
      connectors: [],
      error: `Route API returned invalid JSON (${res.status})`,
    };
  }

  if (!res.ok || !payload.ok) {
    const msg = !payload.ok ? payload.error : `Route API error (${res.status})`;
    return { multiFloor: false, segments: [], connectors: [], error: msg };
  }

  return payload.plan;
}
