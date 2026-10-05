import type { Floor2DMap, FloorBlock } from './floor2d';
import { snapWorldToWalkCell, worldToCell } from './floor2dRoute';

/** Painted stair mouth on a floor plate — links to a mouth on another level. */
export type StairMouth = {
  id: string;
  x: number;
  z: number;
  linkedFloorId?: string;
  linkedMouthId?: string;
};

export const STAIR_MOUTH_MARKER_COLOR = '#dc2626';
export const STAIR_MOUTH_LINK_COLOR = '#ea580c';
/** Max horizontal gap for auto-pairing unlinked mouths on adjacent floors. */
export const STAIR_MOUTH_AUTO_LINK_XZ = 24;

export function cloneStairMouths(mouths: StairMouth[] | undefined): StairMouth[] | undefined {
  if (!mouths?.length) return undefined;
  return mouths.map((m) => ({ ...m }));
}

export function newStairMouthId(): string {
  return `mouth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function distXZ(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function resampleStairPoints(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  steps: number,
): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
  }
  return out;
}

export function floorsHaveStairMouths(
  floors: { stairMouths?: StairMouth[] }[],
): boolean {
  return floors.some((f) => (f.stairMouths?.length ?? 0) > 0);
}

export function getMouthById(floor: { stairMouths?: StairMouth[] }, id: string): StairMouth | null {
  return floor.stairMouths?.find((m) => m.id === id) ?? null;
}

/** Bidirectional link between two mouths. */
export function linkStairMouths(
  floors: { id: string; stairMouths?: StairMouth[] }[],
  floorAId: string,
  mouthAId: string,
  floorBId: string,
  mouthBId: string,
): boolean {
  const floorA = floors.find((f) => f.id === floorAId);
  const floorB = floors.find((f) => f.id === floorBId);
  const mouthA = floorA ? getMouthById(floorA, mouthAId) : null;
  const mouthB = floorB ? getMouthById(floorB, mouthBId) : null;
  if (!mouthA || !mouthB) return false;
  mouthA.linkedFloorId = floorBId;
  mouthA.linkedMouthId = mouthBId;
  mouthB.linkedFloorId = floorAId;
  mouthB.linkedMouthId = mouthAId;
  return true;
}

export function unlinkStairMouth(floor: { stairMouths?: StairMouth[] }, mouthId: string): void {
  const mouth = getMouthById(floor, mouthId);
  if (!mouth) return;
  mouth.linkedFloorId = undefined;
  mouth.linkedMouthId = undefined;
}

type StairFloorRef = {
  id: string;
  floorY: number;
  parentFloorId?: string;
  stairMouths?: StairMouth[];
};

/** Auto-pair a new mouth with an unlinked mouth on another level. */
export function tryAutoLinkStairMouth(
  floors: StairFloorRef[],
  floor: StairFloorRef,
  mouth: StairMouth,
): boolean {
  // Prefer linking across different parents (or parent↔subfloor), not same-bucket siblings first.
  const bucketId = (f: StairFloorRef) => f.parentFloorId ?? f.id;
  const others = floors
    .filter((f) => f.id !== floor.id)
    .sort((a, b) => {
      const aSame = bucketId(a) === bucketId(floor) ? 1 : 0;
      const bSame = bucketId(b) === bucketId(floor) ? 1 : 0;
      if (aSame !== bSame) return aSame - bSame;
      return Math.abs(a.floorY - floor.floorY) - Math.abs(b.floorY - floor.floorY);
    });

  // One unlinked mouth on the nearest other level → always pair (typical two-floor stair).
  for (const other of others) {
    const unlinked = (other.stairMouths ?? []).filter((m) => !m.linkedMouthId);
    if (unlinked.length === 1) {
      return linkStairMouths(floors, floor.id, mouth.id, other.id, unlinked[0].id);
    }
  }

  let best: { otherId: string; mouthId: string; dist: number } | null = null;
  for (const other of others) {
    for (const candidate of other.stairMouths ?? []) {
      if (candidate.linkedMouthId) continue;
      const d = distXZ(mouth, candidate);
      if (d <= STAIR_MOUTH_AUTO_LINK_XZ && (!best || d < best.dist)) {
        best = { otherId: other.id, mouthId: candidate.id, dist: d };
      }
    }
  }
  if (best) {
    return linkStairMouths(floors, floor.id, mouth.id, best.otherId, best.mouthId);
  }
  return false;
}

export const STAIR_MOUTH_HIT_RADIUS = 1.2;

export function hitTestStairMouth(
  mouths: StairMouth[] | undefined,
  x: number,
  z: number,
): StairMouth | null {
  if (!mouths?.length) return null;
  let best: StairMouth | null = null;
  let bestD = STAIR_MOUTH_HIT_RADIUS;
  for (const m of mouths) {
    const d = distXZ(m, { x, z });
    if (d <= bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

/** Floor map sized to this level's saved walk grid (multi-floor routing). */
export function routingMapForFloor(baseMap: {
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  sliceY: number;
  corridors: unknown[];
  stores: unknown[];
  objects: unknown[];
  zones: unknown[];
  floors: unknown[];
  blocks: unknown[];
  walls: unknown[];
}, floor: {
  floorY: number;
  walkGrid?: number[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
}): typeof baseMap {
  const cols = floor.gridCols;
  const rows = floor.gridRows;
  const cell = floor.gridCellSize ?? baseMap.cellSize;
  const minX = floor.gridMinX ?? baseMap.minX;
  const minZ = floor.gridMinZ ?? baseMap.minZ;
  if (cols && rows && floor.walkGrid?.length === cols * rows) {
    return {
      ...baseMap,
      sliceY: floor.floorY,
      cols,
      rows,
      cellSize: cell,
      minX,
      minZ,
      maxX: minX + cols * cell,
      maxZ: minZ + rows * cell,
    };
  }
  return { ...baseMap, sliceY: floor.floorY };
}

/** Walk grid for a floor level, using saved grid dimensions when they differ from the active map. */
export function resolveFloorWalkGrid(
  map: { cols: number; rows: number },
  floor: {
    id: string;
    walkGrid?: number[];
    gridCols?: number;
    gridRows?: number;
  },
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): Uint8Array | null {
  const floorMap = routingMapForFloor(
    map as Parameters<typeof routingMapForFloor>[0],
    floor as unknown as Parameters<typeof routingMapForFloor>[1],
  );
  const need = floorMap.cols * floorMap.rows;
  if (floor.walkGrid?.length === need) {
    return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
  }
  if (activeFloorId === floor.id && activeWalk?.length === need) return activeWalk;
  return null;
}

export function floorsHaveLinkedStairMouths(
  floors: { stairMouths?: StairMouth[] }[],
): boolean {
  for (const floor of floors) {
    for (const mouth of floor.stairMouths ?? []) {
      if (mouth.linkedFloorId && mouth.linkedMouthId) return true;
    }
  }
  return false;
}

export function isWorldInFloorMap(map: Floor2DMap, x: number, z: number): boolean {
  return worldToCell(map, x, z) !== null;
}

/** Snap a stair mouth onto walkable floor; align to linked partner XZ when mouth is off-map. */
export function resolveMouthLandingXZ(
  map: Floor2DMap,
  floor: {
    id: string;
    floorY: number;
    walkGrid?: number[];
    gridCols?: number;
    gridRows?: number;
    gridCellSize?: number;
    gridMinX?: number;
    gridMinZ?: number;
    objects?: FloorBlock[];
  },
  x: number,
  z: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
  partner?: Pick<StairMouth, 'x' | 'z'> | null,
): { x: number; z: number } {
  const floorMap = routingMapForFloor(map, floor);
  const walk = resolveFloorWalkGrid(map, floor, activeWalk, activeFloorId);
  const objects = floor.objects ?? [];
  if (!walk) return { x, z };

  const trySnap = (wx: number, wz: number): { x: number; z: number } | null => {
    if (!isWorldInFloorMap(floorMap, wx, wz)) return null;
    return snapWorldToWalkCell(floorMap, walk, objects, wx, wz);
  };

  const direct = trySnap(x, z);
  if (direct) return direct;

  if (partner) {
    const aligned = trySnap(partner.x, partner.z);
    if (aligned) return aligned;
  }

  const cx = (floorMap.minX + floorMap.maxX) * 0.5;
  const cz = (floorMap.minZ + floorMap.maxZ) * 0.5;
  return trySnap(cx, cz) ?? { x, z };
}

/** Lower score = better linked mouth pair for routing. */
export function scoreLinkedMouthPair(
  map: Floor2DMap,
  fromFloor: {
    floorY: number;
    walkGrid?: number[];
    gridCols?: number;
    gridRows?: number;
    objects?: FloorBlock[];
  },
  toFloor: {
    floorY: number;
    walkGrid?: number[];
    gridCols?: number;
    gridRows?: number;
    objects?: FloorBlock[];
  },
  mouth: StairMouth,
  partner: StairMouth,
  nearX: number,
  nearZ: number,
): number {
  const fromMap = routingMapForFloor(map, fromFloor);
  const toMap = routingMapForFloor(map, toFloor);
  let score = distXZ(mouth, { x: nearX, z: nearZ });
  if (!isWorldInFloorMap(fromMap, mouth.x, mouth.z)) score += 1e6;
  if (!isWorldInFloorMap(toMap, partner.x, partner.z)) score += 1e6;
  return score;
}
