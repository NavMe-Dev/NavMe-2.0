import * as THREE from 'three';
import { forEachWorldTriangle } from './meshUtils';
import { rasterizeTriXZ } from './floor2dRaster';
import { finalizeFloor2DFromWalkLite } from './floor2dFinalize';
import { cloneStairMouths, type StairMouth } from './stairMouth';

export type { StairMouth } from './stairMouth';

export type FloorShape = 'rectangle' | 'circle' | 'polygon';

export type FloorPoint = { x: number; z: number };

export type FloorBlock = {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  fill: string;
  label: string;
  shape?: FloorShape;
  /** Polygon vertices (world X/Z) when shape is polygon. */
  points?: FloorPoint[];
  /** Border color for labeled zones (dotted outline). */
  stroke?: string;
  /** Slice Y for named floor regions. */
  floorY?: number;
  /** Catalog material identifier for placed objects (e.g. "chair", "door"). */
  kind?: string;
  /** Parametric repeat count (e.g. chairs in a row). */
  count?: number;
  /** Rotation in degrees (clockwise on the floor plan). */
  rotation?: number;
};

export type WallSeg = { x1: number; z1: number; x2: number; z2: number };

/** A named floor level at a fixed Y slice (not a drawn map region). */
export type FloorLevel = {
  id: string;
  label: string;
  floorY: number;
  /**
   * When set, this level is a subfloor of another floor (stair intersection plate).
   * Subfloors are stored with floors but hidden from “View all floors”.
   */
  parentFloorId?: string;
  /** Painted walk grid for this level (when grid size matches the map). */
  walkGrid?: number[];
  objects?: FloorBlock[];
  zones?: FloorBlock[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
  /** User-placed stair mouths linking to other floor levels. */
  stairMouths?: StairMouth[];
  /** Uploaded floor-plan diagram shown under the 2D edit layer. */
  planUnderlay?: {
    dataUrl: string;
    fileName: string;
    opacity?: number;
  };
};

export function isTopLevelFloor(floor: FloorLevel): boolean {
  return !floor.parentFloorId;
}

export function topLevelFloors(levels: FloorLevel[]): FloorLevel[] {
  return levels.filter(isTopLevelFloor);
}

export function subfloorsOf(levels: FloorLevel[], parentId: string): FloorLevel[] {
  return levels.filter((f) => f.parentFloorId === parentId);
}

/** Parent floor for a level (itself if already top-level). */
export function parentFloorOf(levels: FloorLevel[], floor: FloorLevel): FloorLevel | null {
  if (!floor.parentFloorId) return floor;
  return levels.find((f) => f.id === floor.parentFloorId) ?? null;
}

export function defaultSubfloorLabel(parent: FloorLevel, index: number): string {
  const base = parent.label.trim() || 'Floor';
  return `${base} Sub ${index}`;
}

export function cloneFloorLevels(levels: FloorLevel[]): FloorLevel[] {
  return levels.map((f) => ({
    ...f,
    parentFloorId: f.parentFloorId,
    walkGrid: f.walkGrid ? [...f.walkGrid] : undefined,
    objects: f.objects?.map((o) => ({
      ...o,
      points: o.points?.map((p) => ({ x: p.x, z: p.z })),
    })),
    zones: f.zones?.map((z) => ({
      ...z,
      points: z.points?.map((p) => ({ x: p.x, z: p.z })),
    })),
    stairMouths: cloneStairMouths(f.stairMouths),
    planUnderlay: f.planUnderlay
      ? {
          dataUrl: f.planUnderlay.dataUrl,
          fileName: f.planUnderlay.fileName,
          opacity: f.planUnderlay.opacity,
        }
      : undefined,
  }));
}

export function floorLevelSliceMatches(map: Floor2DMap, floor: FloorLevel): boolean {
  return Math.abs(floor.floorY - map.sliceY) < 1e-4;
}

export function floorLevelGridMatches(map: Floor2DMap, floor: FloorLevel): boolean {
  if (!floorLevelSliceMatches(map, floor)) return false;
  if (!Array.isArray(floor.walkGrid) || floor.walkGrid.length !== map.cols * map.rows) return false;
  if (floor.gridCols !== map.cols || floor.gridRows !== map.rows) return false;
  if (floor.gridCellSize !== undefined && Math.abs(floor.gridCellSize - map.cellSize) > 1e-6) return false;
  if (floor.gridMinX !== undefined && Math.abs(floor.gridMinX - map.minX) > 1e-3) return false;
  if (floor.gridMinZ !== undefined && Math.abs(floor.gridMinZ - map.minZ) > 1e-3) return false;
  return true;
}

export function defaultFloorLabel(index: number): string {
  return `Floor ${index}`;
}

export type Floor2DMap = {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  /** Walkable corridor polygons (mall concourse). */
  corridors: FloorBlock[];
  /** Room / store units along corridors. */
  stores: FloorBlock[];
  /** Solid obstacle blocks (rectangle / circle). */
  objects: FloorBlock[];
  /** Labeled regions — dotted colorful outline, not walkable edits. */
  zones: FloorBlock[];
  /** Named building levels — each level is a slice Y (e.g. Ground Floor, Floor 2). */
  floors: FloorLevel[];
  /** @deprecated use corridors */
  blocks: FloorBlock[];
  walls: WallSeg[];
};

/** US indoor mapping palette (Esri Indoors / Mappedin-style zone coding). */
export const US_INDOOR_MAP = {
  /** 3D only — very light, dim saffron (not used on 2D canvas). */
  corridor: '#ffffff',
  floorBase: '#ffffff',
  floorCorridors: ['#ffffff'],
  roomFills: [
    '#93C5FD', '#C4B5FD', '#6EE7B7', '#FDE047', '#FDA4AF',
    '#67E8F9', '#A5B4FC', '#FDBA74', '#86EFAC', '#F9A8D4',
    '#7DD3FC', '#D9F99D', '#FCA5A5', '#5EEAD4', '#E9D5FF', '#FB923C',
  ],
  categories: {
    corridor: '#ffffff',
    office: '#DBEAFE',
    workspace: '#DBEAFE',
    conference: '#E9D5FF',
    meeting: '#E9D5FF',
    restroom: '#BAE6FD',
    bathroom: '#BAE6FD',
    bath: '#BAE6FD',
    kitchen: '#FED7AA',
    dining: '#FFEDD5',
    dinning: '#FFEDD5',
    bedroom: '#DDD6FE',
    bed: '#DDD6FE',
    closet: '#E2E8F0',
    storage: '#E2E8F0',
    garage: '#CBD5E1',
    stair: '#FEF08A',
    lobby: '#F0FDF4',
    entry: '#F0FDF4',
    living: '#BBF7D0',
    family: '#BBF7D0',
    great: '#D1FAE5',
    sun: '#D1FAE5',
    bonus: '#E9D5FF',
    primary: '#E9D5FF',
    suite: '#E9D5FF',
    guest: '#C7D2FE',
    breakfast: '#FFEDD5',
    utility: '#FECACA',
    mechanical: '#FECACA',
  } as Record<string, string>,
  zoneTints: [
    '#93C5FD', '#C4B5FD', '#6EE7B7', '#FDE047', '#FDA4AF',
    '#67E8F9', '#A5B4FC', '#FDBA74', '#86EFAC', '#F9A8D4',
    '#7DD3FC', '#D9F99D', '#FCA5A5', '#5EEAD4', '#E9D5FF', '#FB923C',
  ],
} as const;

export function usZoneColorFromLabel(label: string | undefined, index: number): string {
  const palette = US_INDOOR_MAP.roomFills;
  let family = 0;
  if (label?.trim()) {
    const norm = label.trim().toLowerCase();
    for (const key of Object.keys(US_INDOOR_MAP.categories)) {
      if (norm.includes(key)) {
        const cat = US_INDOOR_MAP.categories[key];
        const hit = palette.indexOf(cat as (typeof palette)[number]);
        family = hit >= 0 ? hit : key.length % palette.length;
        break;
      }
    }
  }
  return palette[(index + family) % palette.length];
}

export function hexToRgba(hex: string, alpha: number): string {
  if (hex.indexOf('#') === 0 && hex.length >= 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  }
  return 'rgba(142,125,154,' + alpha + ')';
}

/** Mappedin-style indoor map palette (2D + 3D). */
export const MAPPEDIN_MAP_STYLE = {
  background: '#F5F5F0',
  corridor: '#EBEBEB',
  room: '#F7F5F2',
  borderWall: '#4A4A4A',
  interiorWall: '#A0A0A0',
  water: '#B8D4E8',
  greenery: '#C5D4B8',
  zoneLabel: '#4A3F55',
  route: '#3B6FD9',
  poi: '#7B2D8E',
  origin: '#4CAF50',
  destination: '#7B2D8E',
} as const;

/** 3D scene colors derived from {@link MAPPEDIN_MAP_STYLE}. */
export const SCENE3D_MAP_STYLE = {
  sceneBg: MAPPEDIN_MAP_STYLE.background,
  floor: MAPPEDIN_MAP_STYLE.corridor,
  corridor: MAPPEDIN_MAP_STYLE.corridor,
  room: MAPPEDIN_MAP_STYLE.room,
  floorCorridors: [MAPPEDIN_MAP_STYLE.corridor],
  interiorBlock: MAPPEDIN_MAP_STYLE.room,
  interiorBlockTop: MAPPEDIN_MAP_STYLE.room,
  interiorBlockSide: MAPPEDIN_MAP_STYLE.interiorWall,
  interiorWall: MAPPEDIN_MAP_STYLE.interiorWall,
  interiorWallTop: '#B0B0B0',
  borderWall: MAPPEDIN_MAP_STYLE.borderWall,
  borderWallTop: '#5C5C5C',
  zoneLabel: MAPPEDIN_MAP_STYLE.zoneLabel,
  route: MAPPEDIN_MAP_STYLE.route,
  poi: MAPPEDIN_MAP_STYLE.poi,
  poiLabel: MAPPEDIN_MAP_STYLE.zoneLabel,
  origin: MAPPEDIN_MAP_STYLE.origin,
  destination: MAPPEDIN_MAP_STYLE.destination,
} as const;

export const MIN_INTERIOR_VOID_CELLS = 2;
const WALL_EPS = 1e-4;

export function walkAt(map: Floor2DMap, walk: Uint8Array, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
  return walk[r * map.cols + c] === 1;
}

export function cellAt(map: Floor2DMap, x: number, z: number): { c: number; r: number } | null {
  const c = Math.floor((x - map.minX) / map.cellSize);
  const r = Math.floor((z - map.minZ) / map.cellSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return null;
  return { c, r };
}

export function isBorderWallSegment(seg: WallSeg, map: Floor2DMap, walk: Uint8Array): boolean {
  const mx = (seg.x1 + seg.x2) / 2;
  const mz = (seg.z1 + seg.z2) / 2;
  const isVert = Math.abs(seg.x1 - seg.x2) < WALL_EPS;
  const step = map.cellSize * 0.28;
  const probes = isVert
    ? [
        { wx: mx - step, wz: mz },
        { wx: mx + step, wz: mz },
      ]
    : [
        { wx: mx, wz: mz - step },
        { wx: mx, wz: mz + step },
      ];

  let voidCell: { c: number; r: number } | null = null;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const cell = cellAt(map, p.wx, p.wz);
    if (!cell) return true;
    if (!walkAt(map, walk, cell.c, cell.r)) {
      voidCell = cell;
      break;
    }
  }
  if (!voidCell) return false;

  const visited = new Uint8Array(map.cols * map.rows);
  const queue: number[] = [voidCell.r * map.cols + voidCell.c];
  visited[queue[0]] = 1;
  while (queue.length) {
    const idx = queue.shift()!;
    const c = idx % map.cols;
    const r = (idx / map.cols) | 0;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let d = 0; d < dirs.length; d++) {
      const nc = c + dirs[d][0];
      const nr = r + dirs[d][1];
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) return true;
      const ni = nr * map.cols + nc;
      if (visited[ni] || walkAt(map, walk, nc, nr)) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }
  return false;
}

export function markEnclosedVoidCells(map: Floor2DMap, walk: Uint8Array): Uint8Array {
  const enclosed = new Uint8Array(map.cols * map.rows);
  const visited = new Uint8Array(map.cols * map.rows);

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const start = r * map.cols + c;
      if (walk[start] || visited[start]) continue;

      const component: number[] = [];
      let touchesEdge = false;
      const queue = [start];
      visited[start] = 1;

      while (queue.length) {
        const i = queue.shift()!;
        component.push(i);
        const cc = i % map.cols;
        const rr = (i / map.cols) | 0;
        if (cc === 0 || rr === 0 || cc === map.cols - 1 || rr === map.rows - 1) touchesEdge = true;

        const dirs = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ];
        for (let d = 0; d < dirs.length; d++) {
          const nc = cc + dirs[d][0];
          const nr = rr + dirs[d][1];
          if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) {
            touchesEdge = true;
            continue;
          }
          const ni = nr * map.cols + nc;
          if (visited[ni] || walk[ni]) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }

      if (touchesEdge || component.length < MIN_INTERIOR_VOID_CELLS) continue;
      for (let i = 0; i < component.length; i++) enclosed[component[i]] = 1;
    }
  }
  return enclosed;
}

/** 2D canvas — Mappedin-style neutral grays and warm room tones. */
export const FLOOR2D_STYLE = {
  background: MAPPEDIN_MAP_STYLE.background,
  corridor: MAPPEDIN_MAP_STYLE.corridor,
  store: MAPPEDIN_MAP_STYLE.room,
  storeFills: [MAPPEDIN_MAP_STYLE.room],
  object: '#F0EEEA',
  objectBorder: '#C8C8C8',
  objectLabel: MAPPEDIN_MAP_STYLE.zoneLabel,
  wall: MAPPEDIN_MAP_STYLE.borderWall,
  wallLight: MAPPEDIN_MAP_STYLE.interiorWall,
  borderWall: MAPPEDIN_MAP_STYLE.borderWall,
  interiorWall: MAPPEDIN_MAP_STYLE.interiorWall,
  route: MAPPEDIN_MAP_STYLE.route,
  routeOutline: '#ffffff',
  routeDot: '#2F5FBF',
  zoneLabel: MAPPEDIN_MAP_STYLE.zoneLabel,
  navMesh: 'rgba(100,116,139,0.06)',
  navMeshStroke: 'rgba(100,116,139,0.22)',
  poiLabel: MAPPEDIN_MAP_STYLE.zoneLabel,
  poiMarker: MAPPEDIN_MAP_STYLE.poi,
  poiMarkerBorder: '#ffffff',
  accent: '#8E7D9A',
  origin: MAPPEDIN_MAP_STYLE.origin,
  destination: MAPPEDIN_MAP_STYLE.destination,
  /** Distinct zone outline colors — cycles for each new zone (24 vivid hues). */
  zoneStrokeColors: [
    '#E53935', // red
    '#1E88E5', // blue
    '#43A047', // green
    '#FB8C00', // orange
    '#8E24AA', // purple
    '#00ACC1', // cyan
    '#F4511E', // deep orange
    '#3949AB', // indigo
    '#C0CA33', // lime
    '#D81B60', // pink
    '#00897B', // teal
    '#6D4C41', // brown
    '#FDD835', // yellow
    '#5E35B1', // deep purple
    '#039BE5', // light blue
    '#7CB342', // light green
    '#FFB300', // amber
    '#C2185B', // magenta
    '#546E7A', // blue grey
    '#FF7043', // coral
    '#7E57C2', // violet
    '#26A69A', // mint
    '#EC407A', // rose
    '#283593', // navy
    '#827717', // olive
    '#29B6F6', // sky
    '#FF8F00', // gold
    '#8E4585', // plum
    '#00BFA5', // turquoise
    '#C62828', // crimson
  ],
  zoneFillOpacity: 0.28,
  zoneStrokeOpacity: 0.9,
  zoneLabelOpacity: 0.9,
  floorRegion: 'rgba(142,125,154,0.18)',
  floorRegionBorder: '#8E7D9A',
  floorLabel: MAPPEDIN_MAP_STYLE.zoneLabel,
  floorStrokeColors: ['#8E7D9A', '#9A8AA8', '#A89BB5', '#7A6B88', '#6E5F7C', '#5C4F68'],
  floorCanvas: MAPPEDIN_MAP_STYLE.background,
  interiorFill: MAPPEDIN_MAP_STYLE.room,
  water: MAPPEDIN_MAP_STYLE.water,
  greenery: MAPPEDIN_MAP_STYLE.greenery,
} as const;

const CORRIDOR_FILL = FLOOR2D_STYLE.corridor;
const STORE_FILL = FLOOR2D_STYLE.store;
const EPS = 1e-4;

/** Cap walk grid size so large malls do not freeze the browser. */
export const MAX_FLOOR_GRID_DIM = 2048;
export const MAX_FLOOR_GRID_CELLS = 1_200_000;

export function resolveFloorCellSize(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  requested = 0.12,
): number {
  const spanX = Math.max(maxX - minX, 0.1);
  const spanZ = Math.max(maxZ - minZ, 0.1);
  let cell = requested;
  for (let i = 0; i < 24; i++) {
    const cols = Math.ceil(spanX / cell);
    const rows = Math.ceil(spanZ / cell);
    if (
      cols <= MAX_FLOOR_GRID_DIM &&
      rows <= MAX_FLOOR_GRID_DIM &&
      cols * rows <= MAX_FLOOR_GRID_CELLS
    ) {
      return +cell.toFixed(4);
    }
    cell *= 1.2;
  }
  const span = Math.max(spanX, spanZ);
  return +(span / MAX_FLOOR_GRID_DIM).toFixed(4);
}

function mergeRects(mask: Uint8Array, cols: number, rows: number, minX: number, minZ: number, cell: number): FloorBlock[] {
  const used = new Uint8Array(mask.length);
  const blocks: FloorBlock[] = [];
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
        id: `block-${id++}`,
        x: minX + c * cell,
        z: minZ + r * cell,
        w: w * cell,
        d: h * cell,
        fill: CORRIDOR_FILL,
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

function mergeStoreRects(mask: Uint8Array, cols: number, rows: number, minX: number, minZ: number, cell: number): FloorBlock[] {
  const used = new Uint8Array(mask.length);
  const blocks: FloorBlock[] = [];
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
        id: `store-${id++}`,
        x: minX + c * cell,
        z: minZ + r * cell,
        w: w * cell,
        d: h * cell,
        fill: STORE_FILL,
        label: '',
      });
    }
  }
  return blocks;
}

function extractOrthogonalWalls(
  walk: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
): WallSeg[] {
  const raw: WallSeg[] = [];
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

function mergeOrthogonalSegments(segs: WallSeg[]): WallSeg[] {
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

  const out: WallSeg[] = [];
  for (const h of mergedH) out.push({ x1: h.x0, z1: h.z, x2: h.x1, z2: h.z });
  for (const v of mergedV) out.push({ x1: v.x, z1: v.z0, x2: v.x, z2: v.z1 });
  return out;
}

export function finalizeFloor2DFromWalk(params: {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  walk: Uint8Array;
}): Floor2DMap {
  return finalizeFloor2DFromWalkLite(params) as Floor2DMap;
}

export function buildFloor2DFromMap(
  mapRoot: THREE.Object3D,
  sliceY: number,
  options: { cellSize?: number; band?: number } = {},
): Floor2DMap {
  const band = options.band ?? 0.45;

  const box = new THREE.Box3().setFromObject(mapRoot);
  if (box.isEmpty()) {
    const cellSize = options.cellSize ?? 0.12;
    return {
      sliceY,
      cellSize,
      minX: -10,
      maxX: 10,
      minZ: -10,
      maxZ: 10,
      cols: 1,
      rows: 1,
      corridors: [],
      stores: [],
      objects: [],
      zones: [],
      floors: [],
      blocks: [],
      walls: [],
    };
  }

  const pad = 0.5;
  const minX = box.min.x - pad;
  const maxX = box.max.x + pad;
  const minZ = box.min.z - pad;
  const maxZ = box.max.z + pad;
  const cellSize = resolveFloorCellSize(minX, maxX, minZ, maxZ, options.cellSize ?? 0.12);
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const walk = new Uint8Array(cols * rows);

  forEachWorldTriangle(mapRoot, (a, b, c, n) => {
    const yMin = Math.min(a.y, b.y, c.y);
    const yMax = Math.max(a.y, b.y, c.y);
    if (yMax < sliceY - band || yMin > sliceY + band) return;
    if (n.y > 0.35) {
      rasterizeTriXZ(walk, cols, rows, minX, minZ, cellSize, a.x, a.z, b.x, b.z, c.x, c.z, 1);
    }
  });

  let walkable = walk;
  if (walkable.every((v) => v === 0)) {
    walkable = new Uint8Array(cols * rows);
    forEachWorldTriangle(mapRoot, (a, b, c) => {
      const yMin = Math.min(a.y, b.y, c.y);
      const yMax = Math.max(a.y, b.y, c.y);
      if (yMax < sliceY - band || yMin > sliceY + band) return;
      rasterizeTriXZ(walkable, cols, rows, minX, minZ, cellSize, a.x, a.z, b.x, b.z, c.x, c.z, 1);
    });
  }

  return finalizeFloor2DFromWalk({
    sliceY,
    cellSize,
    minX,
    maxX,
    minZ,
    maxZ,
    cols,
    rows,
    walk: walkable,
  });
}

function blocksToWalkGrid(map: Floor2DMap, blocks: FloorBlock[]): Uint8Array {
  const walk = new Uint8Array(map.cols * map.rows);
  const cell = map.cellSize;
  for (const b of blocks) {
    paintRectOnWalk(map, walk, b, 1);
  }
  return walk;
}

/** Build a walk grid from corridor blocks (clone for editing). */
export function walkGridFromBlocks(map: Floor2DMap, blocks: FloorBlock[]): Uint8Array {
  return blocksToWalkGrid(map, blocks);
}

/** Paint a world-space rectangle onto the walk grid (1 = floor, 0 = empty). */
export function paintRectOnWalk(map: Floor2DMap, walk: Uint8Array, rect: FloorBlock, value: 0 | 1): void {
  const cell = map.cellSize;
  const c0 = Math.max(0, Math.floor((rect.x - map.minX) / cell));
  const c1 = Math.min(map.cols - 1, Math.ceil((rect.x + rect.w - map.minX) / cell) - 1);
  const r0 = Math.max(0, Math.floor((rect.z - map.minZ) / cell));
  const r1 = Math.min(map.rows - 1, Math.ceil((rect.z + rect.d - map.minZ) / cell) - 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      walk[r * map.cols + c] = value;
    }
  }
}

function pointInConvexPolygon(px: number, pz: number, corners: FloorPoint[]): boolean {
  if (corners.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const cross = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Paint cells whose center lies inside a world-space convex polygon. */
export function paintConvexPolygonOnWalk(
  map: Floor2DMap,
  walk: Uint8Array,
  corners: FloorPoint[],
  value: 0 | 1,
): void {
  if (corners.length < 3) return;
  const xs = corners.map((p) => p.x);
  const zs = corners.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cell = map.cellSize;
  const c0 = Math.max(0, Math.floor((minX - map.minX) / cell));
  const c1 = Math.min(map.cols - 1, Math.ceil((maxX - map.minX) / cell) - 1);
  const r0 = Math.max(0, Math.floor((minZ - map.minZ) / cell));
  const r1 = Math.min(map.rows - 1, Math.ceil((maxZ - map.minZ) / cell) - 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cx = map.minX + (c + 0.5) * cell;
      const cz = map.minZ + (r + 0.5) * cell;
      if (pointInConvexPolygon(cx, cz, corners)) {
        walk[r * map.cols + c] = value;
      }
    }
  }
}

/** @deprecated Use paintConvexPolygonOnWalk */
export const paintQuadOnWalk = paintConvexPolygonOnWalk;

export function boundsFromPoints(points: FloorPoint[]): Pick<FloorBlock, 'x' | 'z' | 'w' | 'd'> {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { x: minX, z: minZ, w: Math.max(0, maxX - minX), d: Math.max(0, maxZ - minZ) };
}

/** Rebuild walls/stores from an edited walk grid, objects, and labeled zones. */
export function applyWalkGridEdits(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[] = [],
  zones: FloorBlock[] = [],
  floors: FloorLevel[] = [],
): Floor2DMap {
  const merged = mergeRects(walk, map.cols, map.rows, map.minX, map.minZ, map.cellSize);
  const storeMask = extractStoreMask(walk, map.cols, map.rows);
  const stores = mergeStoreRects(storeMask, map.cols, map.rows, map.minX, map.minZ, map.cellSize);
  const walls = extractOrthogonalWalls(walk, map.cols, map.rows, map.minX, map.minZ, map.cellSize);
  return {
    ...map,
    corridors: merged,
    blocks: merged,
    stores,
    objects: objects.map((o) => ({ ...o })),
    zones: zones.map((z) => ({ ...z })),
    floors: cloneFloorLevels(floors),
    walls,
  };
}

/** Rebuild walls/stores from edited corridor blocks and return updated map. */
export function applyCorridorEdits(map: Floor2DMap, corridors: FloorBlock[]): Floor2DMap {
  return applyWalkGridEdits(map, blocksToWalkGrid(map, corridors));
}

/** True when a world X/Z point lies inside a floor block (rectangle, circle, or rotated). */
export function pointInsideBlock(x: number, z: number, block: FloorBlock): boolean {
  if (block.shape === 'circle') {
    const cx = block.x + block.w * 0.5;
    const cz = block.z + block.d * 0.5;
    const rx = block.w * 0.5;
    const rz = block.d * 0.5;
    if (rx < 1e-6 || rz < 1e-6) return false;
    const dx = (x - cx) / rx;
    const dz = (z - cz) / rz;
    return dx * dx + dz * dz <= 1;
  }
  const rot = ((block.rotation ?? 0) * Math.PI) / 180;
  if (Math.abs(rot) > 1e-6) {
    const cx = block.x + block.w * 0.5;
    const cz = block.z + block.d * 0.5;
    const dx = x - cx;
    const dz = z - cz;
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return Math.abs(lx) <= block.w * 0.5 && Math.abs(lz) <= block.d * 0.5;
  }
  return x >= block.x && x <= block.x + block.w && z >= block.z && z <= block.z + block.d;
}

/** Normalize object rotation to [0, 360). */
export function normalizeObjectRotation(deg: number): number {
  let r = deg % 360;
  if (r < 0) r += 360;
  return r;
}

export function nextZoneStrokeColor(index: number): string {
  const colors = FLOOR2D_STYLE.zoneStrokeColors;
  return colors[index % colors.length];
}

/** Light fill tint matching a zone stroke color. */
export function zoneFillFromStroke(stroke: string, fill?: string): string {
  if (fill && fill !== 'transparent' && fill !== '') return fill;
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(stroke.trim());
  const opacity = FLOOR2D_STYLE.zoneFillOpacity;
  if (!m) return `rgba(142,125,154,${opacity})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${opacity})`;
}

export function nextZoneColors(index: number): { stroke: string; fill: string } {
  const stroke = nextZoneStrokeColor(index);
  return { stroke, fill: zoneFillFromStroke(stroke) };
}

/** All preset zone colors for the edit picker. */
export const ZONE_COLOR_OPTIONS: readonly string[] = FLOOR2D_STYLE.zoneStrokeColors;

export function nextFloorStrokeColor(index: number): string {
  const colors = FLOOR2D_STYLE.floorStrokeColors;
  return colors[index % colors.length];
}

/** POI display name for a store/object zone (explicit label, else matching POI name). */
export function zoneDisplayLabel(
  block: FloorBlock,
  pois: { name: string; x: number; z: number }[],
): string {
  if (block.label.trim()) return block.label.trim();
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    if (pointInsideBlock(p.x, p.z, block)) return p.name;
  }
  return '';
}
