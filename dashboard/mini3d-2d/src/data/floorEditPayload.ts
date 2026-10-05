import {
  applyWalkGridEdits,
  cloneFloorLevels,
  type Floor2DMap,
  type FloorBlock,
  type FloorLevel,
  type FloorShape,
} from '../floor2d';
import { finalizeFloor2DFromWalkLite } from '../floor2dFinalize';
import { finalizeFloorMapFromWalkGrid } from '../floor2dBuild';
import { packWalkGrid, unpackWalkGrid } from './walkGridCodec';

export const FLOOR_EDIT_VERSION = 7;

export type NavmeFloorPoint = { x: number; z: number };

export type NavmeStairMouth = {
  id: string;
  x: number;
  z: number;
  linkedFloorId?: string;
  linkedMouthId?: string;
};

export type NavmeFloorItem = {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  label: string;
  fill?: string;
  shape?: FloorShape;
  points?: NavmeFloorPoint[];
  stroke?: string;
  floorY?: number;
  kind?: string;
  count?: number;
  /** Rotation in degrees (clockwise on the floor plan). */
  rotation?: number;
};

/** Named Y-level (Floor 1, Ground Floor, …) with optional per-level editor state. */
export type NavmeFloorLevel = {
  id: string;
  label: string;
  floorY: number;
  /** Present when this level is a subfloor of another floor. */
  parentFloorId?: string;
  walkGrid?: number[];
  objects?: NavmeFloorItem[];
  zones?: NavmeFloorItem[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
  stairMouths?: NavmeStairMouth[];
  walkGridPacked?: string;
};

/** Serializable floor editor state stored in `navme_floor_edits.floor_data`. */
export type NavmeFloorEditPayload = {
  version: number;
  sliceY: number;
  mapCode: string;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  walkGrid?: number[];
  walkGridPacked?: string;
  objects: NavmeFloorItem[];
  zones: NavmeFloorItem[];
  /** Named floor levels (Y slices). */
  floors: NavmeFloorLevel[];
  /** Independent subfloor levels, persisted separately from normal floors. */
  subfloors: NavmeFloorLevel[];
};

export type NavmeFloorEditRow = {
  poi_type: string;
  map_code: string;
  floor_slice_y: number;
  floor_data: NavmeFloorEditPayload;
  updated_at?: string;
};

function walkFromStored(
  packed: string | undefined,
  grid: number[] | undefined,
  cols: number,
  rows: number,
): Uint8Array | null {
  const n = cols * rows;
  if (n <= 0) return null;
  if (packed) {
    try {
      return unpackWalkGrid(packed, n);
    } catch {
      return null;
    }
  }
  if (grid?.length === n) {
    return new Uint8Array(grid.map((v) => (v ? 1 : 0)));
  }
  return null;
}

function packLevelWalk(level: NavmeFloorLevel): NavmeFloorLevel {
  if (!level.walkGrid?.length || !level.gridCols || !level.gridRows) {
    const { walkGrid: _w, ...rest } = level;
    return rest;
  }
  const walk = new Uint8Array(level.walkGrid.map((v) => (v ? 1 : 0)));
  return {
    ...level,
    walkGridPacked: packWalkGrid(walk),
    walkGrid: undefined,
  };
}

function itemsToBlocks(items: NavmeFloorItem[]): FloorBlock[] {
  return items.map((z) => ({
    id: z.id,
    x: z.x,
    z: z.z,
    w: z.w,
    d: z.d,
    label: z.label ?? '',
    fill: z.fill ?? '',
    shape: z.shape,
    points: z.points?.map((p) => ({ x: p.x, z: p.z })),
    stroke: z.stroke,
    floorY: z.floorY,
    kind: z.kind,
    count: z.count,
    rotation: z.rotation,
  }));
}

function blocksToItems(blocks: FloorBlock[]): NavmeFloorItem[] {
  return blocks.map((b) => ({
    id: b.id,
    x: b.x,
    z: b.z,
    w: b.w,
    d: b.d,
    label: b.label ?? '',
    fill: b.fill,
    shape: b.shape,
    points: b.points?.map((p) => ({ x: p.x, z: p.z })),
    stroke: b.stroke,
    floorY: b.floorY,
    kind: b.kind,
    count: b.count,
    rotation: b.rotation,
  }));
}

function levelToNav(level: FloorLevel): NavmeFloorLevel {
  return {
    id: level.id,
    label: level.label,
    floorY: level.floorY,
    parentFloorId: level.parentFloorId,
    walkGrid: level.walkGrid ? [...level.walkGrid] : undefined,
    objects: level.objects?.length ? blocksToItems(level.objects) : undefined,
    zones: level.zones?.length ? blocksToItems(level.zones) : undefined,
    gridCols: level.gridCols,
    gridRows: level.gridRows,
    gridCellSize: level.gridCellSize,
    gridMinX: level.gridMinX,
    gridMinZ: level.gridMinZ,
    stairMouths: level.stairMouths?.map((m) => ({ ...m })),
  };
}

function navToLevel(raw: NavmeFloorLevel | NavmeFloorItem): FloorLevel {
  const item = raw as NavmeFloorLevel & NavmeFloorItem;
  const isLegacyRegion =
    typeof item.w === 'number' &&
    typeof item.d === 'number' &&
    item.walkGrid === undefined &&
    item.walkGridPacked === undefined &&
    item.gridCols === undefined;
  if (isLegacyRegion) {
    return {
      id: item.id,
      label: item.label?.trim() || 'Floor',
      floorY: item.floorY ?? 0,
      parentFloorId: item.parentFloorId,
    };
  }
  const levelWalk =
    item.gridCols && item.gridRows
      ? walkFromStored(item.walkGridPacked, item.walkGrid, item.gridCols, item.gridRows)
      : null;
  return {
    id: item.id,
    label: item.label ?? 'Floor',
    floorY: item.floorY,
    parentFloorId: item.parentFloorId,
    walkGrid: levelWalk ? Array.from(levelWalk) : item.walkGrid ? [...item.walkGrid] : undefined,
    objects: item.objects?.length ? itemsToBlocks(item.objects) : undefined,
    zones: item.zones?.length ? itemsToBlocks(item.zones) : undefined,
    gridCols: item.gridCols,
    gridRows: item.gridRows,
    gridCellSize: item.gridCellSize,
    gridMinX: item.gridMinX,
    gridMinZ: item.gridMinZ,
    stairMouths: item.stairMouths?.map((m) => ({ ...m })),
  };
}

function levelsToNav(levels: FloorLevel[]): NavmeFloorLevel[] {
  return levels.map(levelToNav);
}

function payloadLevels(parsed: NavmeFloorEditPayload): NavmeFloorLevel[] {
  return [...(parsed.floors ?? []), ...(parsed.subfloors ?? [])];
}

export function buildFloorEditPayload(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  floors: FloorLevel[],
  sliceY: number,
  mapCode: string,
): NavmeFloorEditPayload {
  return {
    version: FLOOR_EDIT_VERSION,
    sliceY,
    mapCode,
    cellSize: map.cellSize,
    minX: map.minX,
    maxX: map.maxX,
    minZ: map.minZ,
    maxZ: map.maxZ,
    cols: map.cols,
    rows: map.rows,
    walkGridPacked: packWalkGrid(walk),
    objects: blocksToItems(objects),
    zones: blocksToItems(zones),
    floors: levelsToNav(floors.filter((f) => !f.parentFloorId)).map(packLevelWalk),
    subfloors: levelsToNav(floors.filter((f) => !!f.parentFloorId)).map(packLevelWalk),
  };
}

function payloadWalk(parsed: NavmeFloorEditPayload): Uint8Array | null {
  return walkFromStored(parsed.walkGridPacked, parsed.walkGrid, parsed.cols, parsed.rows);
}

function hasWalkData(raw: NavmeFloorEditPayload): boolean {
  return Boolean(
    (typeof raw.walkGridPacked === 'string' && raw.walkGridPacked.length > 0) ||
      (Array.isArray(raw.walkGrid) && raw.walkGrid.length > 0),
  );
}

function floorLevelHasWalk(level: NavmeFloorLevel): boolean {
  return Boolean(
    (typeof level.walkGridPacked === 'string' && level.walkGridPacked.length > 0) ||
      (Array.isArray(level.walkGrid) && level.walkGrid.length > 0),
  );
}

/** True when root or any named floor level has paint data (v6 uses walkGridPacked). */
export function savedPayloadHasWalk(raw: NavmeFloorEditPayload | null | undefined): boolean {
  if (!raw) return false;
  if (hasWalkData(raw)) return true;
  return payloadLevels(raw).some(floorLevelHasWalk);
}

function resolveNavFloorWalk(
  parsed: NavmeFloorEditPayload,
  active: FloorLevel | undefined,
  cols: number,
  rows: number,
): Uint8Array | null {
  const n = cols * rows;
  if (n <= 0) return null;

  if (
    active?.walkGrid &&
    active.gridCols === cols &&
    active.gridRows === rows &&
    active.walkGrid.length === n
  ) {
    return new Uint8Array(active.walkGrid.map((v) => (v ? 1 : 0)));
  }

  const levels = payloadLevels(parsed);
  const navFloor =
    (active ? levels.find((f) => f.id === active.id) : undefined) ??
    levels.find((f) => Math.abs(f.floorY - parsed.sliceY) < 1e-4) ??
    levels[0];

  if (navFloor?.gridCols === cols && navFloor?.gridRows === rows) {
    const fromLevel = walkFromStored(navFloor.walkGridPacked, navFloor.walkGrid, cols, rows);
    if (fromLevel?.length === n) return fromLevel;
  }

  const root = payloadWalk(parsed);
  return root?.length === n ? root : null;
}

/** Merge a saved JSON snapshot onto a freshly built base map. */
export function applySavedFloorEditToMap(
  base: Floor2DMap,
  payload: NavmeFloorEditPayload | null | undefined,
): Floor2DMap {
  if (!payload) return base;

  const parsed = normalizePayload(payload);
  if (!parsed) return base;

  const floors = payloadLevels(parsed).map(navToLevel);
  const active =
    floors.find((f) => Math.abs(f.floorY - parsed.sliceY) < 1e-4) ??
    floors[0];

  const objects = active?.objects?.length ? active.objects : itemsToBlocks(parsed.objects);
  const zones = active?.zones?.length ? active.zones : itemsToBlocks(parsed.zones);

  const gridOk =
    base.cols === parsed.cols &&
    base.rows === parsed.rows &&
    Math.abs(base.cellSize - parsed.cellSize) < 1e-6 &&
    Math.abs(base.minX - parsed.minX) < 1e-3 &&
    Math.abs(base.minZ - parsed.minZ) < 1e-3;

  const walk = gridOk ? resolveNavFloorWalk(parsed, active, base.cols, base.rows) : null;

  if (!gridOk || !walk) {
    console.warn('[floorEdit] Grid mismatch — restoring objects/zones/floors only');
    return { ...base, objects, zones, floors, sliceY: parsed.sliceY };
  }
  if (walk.length !== base.cols * base.rows) {
    console.warn('[floorEdit] walkGrid length mismatch — objects/zones/floors only');
    return { ...base, objects, zones, floors, sliceY: parsed.sliceY };
  }

  return applyWalkGridEdits({ ...base, sliceY: parsed.sliceY }, walk, objects, zones, floors);
}

/** Build a displayable 2D map purely from saved `navme_floor_edits` JSON (no 3D mesh scan). */
function attachSavedMetaToBaseMap(
  base: Floor2DMap,
  parsed: NavmeFloorEditPayload,
): Floor2DMap {
  const floors = payloadLevels(parsed).map(navToLevel);
  const active =
    floors.find((f) => Math.abs(f.floorY - parsed.sliceY) < 1e-4) ?? floors[0];
  const objects = active?.objects?.length ? active.objects : itemsToBlocks(parsed.objects);
  const zones = active?.zones?.length ? active.zones : itemsToBlocks(parsed.zones);

  const walk = resolveNavFloorWalk(parsed, active, parsed.cols, parsed.rows);
  if (walk) {
    return applyWalkGridEdits(
      { ...base, sliceY: active?.floorY ?? parsed.sliceY },
      walk,
      objects,
      zones,
      floors,
    );
  }

  return {
    ...base,
    sliceY: parsed.sliceY,
    objects: objects.map((o) => ({ ...o })),
    zones: zones.map((z) => ({ ...z })),
    floors: cloneFloorLevels(floors),
  };
}

export async function floorMapFromSavedEditAsync(
  payload: NavmeFloorEditPayload,
): Promise<Floor2DMap | null> {
  const parsed = normalizePayload(payload);
  if (!parsed || parsed.cols <= 0 || parsed.rows <= 0) return null;

  const floors = payloadLevels(parsed).map(navToLevel);
  const active =
    floors.find((f) => Math.abs(f.floorY - parsed.sliceY) < 1e-4) ?? floors[0];
  const walk = resolveNavFloorWalk(parsed, active, parsed.cols, parsed.rows);
  if (!walk || walk.length !== parsed.cols * parsed.rows) return null;

  const base = await finalizeFloorMapFromWalkGrid({
    sliceY: parsed.sliceY,
    cellSize: parsed.cellSize,
    minX: parsed.minX,
    maxX: parsed.maxX,
    minZ: parsed.minZ,
    maxZ: parsed.maxZ,
    cols: parsed.cols,
    rows: parsed.rows,
    walk,
  });

  return attachSavedMetaToBaseMap(base, parsed);
}

export function floorMapFromSavedEdit(payload: NavmeFloorEditPayload): Floor2DMap | null {
  const parsed = normalizePayload(payload);
  if (!parsed || parsed.cols <= 0 || parsed.rows <= 0) return null;

  const floors = payloadLevels(parsed).map(navToLevel);
  const active =
    floors.find((f) => Math.abs(f.floorY - parsed.sliceY) < 1e-4) ?? floors[0];
  const walk = resolveNavFloorWalk(parsed, active, parsed.cols, parsed.rows);
  if (!walk || walk.length !== parsed.cols * parsed.rows) return null;

  const base = finalizeFloor2DFromWalkLite({
    sliceY: parsed.sliceY,
    cellSize: parsed.cellSize,
    minX: parsed.minX,
    maxX: parsed.maxX,
    minZ: parsed.minZ,
    maxZ: parsed.maxZ,
    cols: parsed.cols,
    rows: parsed.rows,
    walk,
  }) as Floor2DMap;

  return attachSavedMetaToBaseMap(base, parsed);
}

function normalizePayload(raw: NavmeFloorEditPayload): NavmeFloorEditPayload | null {
  if (
    raw.version === FLOOR_EDIT_VERSION ||
    raw.version === 6 ||
    raw.version === 5 ||
    raw.version === 4
  ) {
    if (!savedPayloadHasWalk(raw)) return null;
    const oldFloors = Array.isArray(raw.floors) ? raw.floors : [];
    const explicitSubs = Array.isArray(raw.subfloors) ? raw.subfloors : [];
    return {
      ...raw,
      version: FLOOR_EDIT_VERSION,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      floors: oldFloors.filter((f) => !f.parentFloorId),
      // v6 stored subfloors inside floors; migrate them into the separate category.
      subfloors: [
        ...explicitSubs,
        ...oldFloors.filter(
          (f) => !!f.parentFloorId && !explicitSubs.some((s) => s.id === f.id),
        ),
      ],
    };
  }
  if (raw.version === 3 && Array.isArray(raw.walkGrid)) {
    return {
      version: FLOOR_EDIT_VERSION,
      sliceY: raw.sliceY,
      mapCode: raw.mapCode,
      cellSize: raw.cellSize,
      minX: raw.minX,
      maxX: raw.maxX,
      minZ: raw.minZ,
      maxZ: raw.maxZ,
      cols: raw.cols,
      rows: raw.rows,
      walkGrid: raw.walkGrid,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      floors: Array.isArray(raw.floors) ? raw.floors : [],
      subfloors: [],
    };
  }
  if (raw.version === 2 && Array.isArray(raw.walkGrid)) {
    return {
      version: FLOOR_EDIT_VERSION,
      sliceY: raw.sliceY,
      mapCode: raw.mapCode,
      cellSize: raw.cellSize,
      minX: raw.minX,
      maxX: raw.maxX,
      minZ: raw.minZ,
      maxZ: raw.maxZ,
      cols: raw.cols,
      rows: raw.rows,
      walkGrid: raw.walkGrid,
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      zones: Array.isArray(raw.zones) ? raw.zones : [],
      floors: [],
      subfloors: [],
    };
  }
  const legacy = raw as NavmeFloorEditPayload & { zones?: NavmeFloorItem[] };
  if (legacy.version === 1 && Array.isArray(legacy.zones) && Array.isArray(legacy.walkGrid)) {
    return {
      version: FLOOR_EDIT_VERSION,
      sliceY: legacy.sliceY,
      mapCode: legacy.mapCode,
      cellSize: legacy.cellSize,
      minX: legacy.minX,
      maxX: legacy.maxX,
      minZ: legacy.minZ,
      maxZ: legacy.maxZ,
      cols: legacy.cols,
      rows: legacy.rows,
      walkGrid: legacy.walkGrid,
      objects: legacy.zones,
      zones: [],
      floors: [],
      subfloors: [],
    };
  }
  return null;
}

export function parseFloorEditPayload(raw: unknown): NavmeFloorEditPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  return normalizePayload(raw as NavmeFloorEditPayload);
}
