import type { Floor2DMap, FloorBlock, FloorLevel } from '../floor2d';
import type { MultiFloorRoutePlan } from '../floor2dMultiRoute';

export type SerializedNavMesh = {
  positions: number[];
  indices: number[];
};

export type RouteComputeRequest = {
  map: Floor2DMap;
  floors: FloorLevel[];
  origin: { x: number; y: number; z: number };
  destination: { x: number; y: number; z: number };
  activeFloorId: string | null;
  activeWalk: number[] | null;
  activeObjects: FloorBlock[];
  navMesh: SerializedNavMesh | null;
};

export type RouteComputeResponse =
  | { ok: true; plan: MultiFloorRoutePlan }
  | { ok: false; error: string };
