/**
 * NavMe 2D navigation embed for Mattercraft — **single file**, view-only.
 *
 * Shows **only saved floor data** from `navme_floor_edits` (no GLB / no auto-generated mesh).
 *
 * - NavMe logo button → fullscreen 2D floor map
 * - **Project** from {@link BACKEND_CATEGORY_NAME} in `navmeProjectCategory.ts` (no user picker)
 * - **Origin / Destination** (POIs + zones + floors from saved edit)
 * - Floor sidebar (switch level) + zone list
 * - Route on **saved painted walk grid** (A*) + **Recast nav mesh** multifloor hybrid (NERDS-GEEKS/2d)
 * - **3D Walls** toggle — extruded floor from saved grid (Three.js, in this file)
 *
 * **Experience navigation:** When `navigationRoute` is wired in Scene.zcomp, floor data and
 * stair-mouth routing load on startup. Waypoints sync to the 3D NavigationRoute path tube
 * via {@link Mini3dGtaEmbed.setRouteOrigin} / {@link Mini3dGtaEmbed.setRouteDestination}.
 * Wire **navigationRoute** (+ optional origin/destination markers) in component props.
 * You can still call {@link mountMini3dGta} from plain TS with your own `HTMLElement`.
 */
import { Component, ContextManager } from '@zcomponent/core';
import { Group } from '@zcomponent/three/lib/components/Group';
import { Point } from '@zcomponent/three/lib/components/Point';
import { NavigationRoute } from '@zcomponent/three-navigation/lib/components/NavigationRoute';
import { NavigationContext } from '@zcomponent/three-navigation/lib/NavigationContext';
import { NavMeshQuery } from 'recast-navigation';
import type { NavMesh } from 'recast-navigation';

import { supabase } from '../data/supabaseClient';
import { NAVME_TABLES } from '../data/navmeTables';
import {
  BACKEND_CATEGORY_NAME,
  isMini3dGtaEmbedEnabled,
  whenNavmeFeaturesReady,
} from '../data/navmeProjectCategory';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Scene from '../../Scene.zcomp';
import '../data/navmeProjectCategory';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const NAVME_FLOOR_EDITS_TABLE = 'navme_floor_edits';
const FLOOR_EDIT_VERSION = 5;
const ZONE_ROUTE_PREFIX = 'zone:';
const FLOOR_ROUTE_PREFIX = 'floor:';

const NAV_MESH_QUERY_HALF_EXTENTS = { x: 4, y: 3, z: 4 };
const NAV_MESH_FLOOR_QUERY_HALF_EXTENTS_Y = 2.5;
/** editor2d config.ts — non-camera POI snap uses y + this offset (0 = floor level). */
const ROUTE_POI_NAV_SNAP_OFFSET_Y = 0;
const ROUTE_CORNER_SOFTEN_DIST = 0.55;
/** NavigationRoute POI snap offset (editor2d / NavMeNavigation). */
const ROUTE_CAMERA_POSITION_OFFSET: [number, number, number] = [0, 0, 0];

/** Drives scene NavigationRoute (optional 3D tube sync from computed path). */
export type Mini3dGtaNavRouteSync = {
  contextManager: ContextManager;
  navigationRoute: NavigationRoute;
  originMarker: Group;
  destinationMarker: Group;
  routeWaypointPoints: Point[];
};

function zcomponentNodeId(node: Group): string {
  const rec = node as Group & { id?: string };
  return typeof rec.id === 'string' ? rec.id : '';
}

function setNavRouteEndpoints(route: NavigationRoute, originId: string, destId: string): void {
  if (originId) route.originNode.value = originId;
  if (destId) route.destinationNode.value = destId;
  route.onRouteChange.emit();
}

function clearNavRouteWaypointPoints(bridge: Mini3dGtaNavRouteSync): void {
  for (const pt of bridge.routeWaypointPoints) {
    try {
      pt.remove();
    } catch {
      /* disposed */
    }
  }
  bridge.routeWaypointPoints = [];
}

function applyWaypointsToNavigationRoute(bridge: Mini3dGtaNavRouteSync, waypoints: Vec3[]): void {
  const route = bridge.navigationRoute;
  const origin = bridge.originMarker;
  const dest = bridge.destinationMarker;

  clearNavRouteWaypointPoints(bridge);
  if (waypoints.length < 2) return;

  origin.position.value = [waypoints[0].x, waypoints[0].y, waypoints[0].z];
  dest.position.value = [
    waypoints[waypoints.length - 1].x,
    waypoints[waypoints.length - 1].y,
    waypoints[waypoints.length - 1].z,
  ];
  setNavRouteEndpoints(route, zcomponentNodeId(origin), zcomponentNodeId(dest));

  for (let i = 1; i < waypoints.length - 1; i++) {
    const wp = waypoints[i];
    const pt = new Point(bridge.contextManager, {});
    pt.position.value = [wp.x, wp.y, wp.z];
    route.appendChild(pt);
    bridge.routeWaypointPoints.push(pt);
  }

  route.cameraPositionOffset.value = ROUTE_CAMERA_POSITION_OFFSET;
  route.onRouteChange.emit();
}

function resolveMini3dGtaNavBridge(
  contextManager: ContextManager,
  props: {
    navigationRoute?: NavigationRoute;
    originMarker?: Group;
    destinationMarker?: Group;
  },
  sceneNodes: Record<string, unknown>,
): Mini3dGtaNavRouteSync | null {
  const navigationRoute =
    props.navigationRoute ??
    (sceneNodes.NavigationRoute as NavigationRoute | undefined) ??
    null;
  if (!navigationRoute) return null;

  const markerParent =
    (sceneNodes.navigation_group as Group | undefined) ??
    (sceneNodes.POI as Group | undefined) ??
    null;
  let originMarker =
    props.originMarker ?? (sceneNodes.NavOrigin as Group | undefined) ?? null;
  let destinationMarker =
    props.destinationMarker ?? (sceneNodes.NavDestination as Group | undefined) ?? null;

  if (!originMarker) {
    originMarker = new Group(contextManager, {});
    markerParent?.appendChild(originMarker);
  }
  if (!destinationMarker) {
    destinationMarker = new Group(contextManager, {});
    markerParent?.appendChild(destinationMarker);
  }

  navigationRoute.cameraPositionOffset.value = ROUTE_CAMERA_POSITION_OFFSET;

  return {
    contextManager,
    navigationRoute,
    originMarker,
    destinationMarker,
    routeWaypointPoints: [],
  };
}

/** US indoor mapping palette (Mappedin / Esri Indoors–style circulation + space colors). */
const US_INDOOR_MAP = {
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

function usZoneColorFromLabel(label: string | undefined, index: number): string {
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

const FLOOR2D_STYLE = {
  background: '#F5F5F0',
  corridor: '#EBEBEB',
  store: '#F7F5F2',
  storeFills: ['#F7F5F2'],
  object: '#F0EEEA',
  objectBorder: '#C8C8C8',
  wall: '#4A4A4A',
  wallLight: '#A0A0A0',
  borderWall: '#4A4A4A',
  interiorWall: '#A0A0A0',
  route: '#3B6FD9',
  routeOutline: '#ffffff',
  zoneLabel: '#4A3F55',
  accent: '#8E7D9A',
  zoneStrokeColors: ['#8E7D9A', '#9A8AA8', '#A89BB5', '#7A6B88', '#6E5F7C', '#5C4F68'],
  zoneStrokeOpacity: 0.65,
  zoneFillOpacity: 0.45,
  zoneLabelOpacity: 0.9,
  poiMarker: '#7B2D8E',
  poiMarkerBorder: '#ffffff',
  poiLabel: '#4A3F55',
  poiLabelOpacity: 0.92,
  origin: '#4CAF50',
  destination: '#7B2D8E',
  floorCanvas: '#F5F5F0',
  interiorFill: '#F7F5F2',
} as const;

function canvasRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
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

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

type FloorShape = 'rectangle' | 'circle' | 'polygon';
type FloorPoint = { x: number; z: number };
type FloorBlock = {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  fill: string;
  label: string;
  shape?: FloorShape;
  points?: FloorPoint[];
  stroke?: string;
  floorY?: number;
};
type WallSeg = { x1: number; z1: number; x2: number; z2: number };
type StairMouth = {
  id: string;
  x: number;
  z: number;
  linkedFloorId?: string;
  linkedMouthId?: string;
};
type FloorLevel = {
  id: string;
  label: string;
  floorY: number;
  walkGrid?: number[];
  objects?: FloorBlock[];
  zones?: FloorBlock[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
  stairMouths?: StairMouth[];
};
type Floor2DMap = {
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  corridors: FloorBlock[];
  stores: FloorBlock[];
  objects: FloorBlock[];
  zones: FloorBlock[];
  floors: FloorLevel[];
  blocks: FloorBlock[];
  walls: WallSeg[];
};
type NavMapPoi = { id: string; name: string; x: number; y: number; z: number };
type NavmeFloorEditPayload = {
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
  walkGrid: number[];
  objects: FloorBlock[];
  zones: FloorBlock[];
  floors: FloorLevel[];
};
type NavmeLoginRow = {
  poi_type: string;
  map_code: string | null;
};

export type Mini3dGtaRouteState = {
  path: { x: number; y: number; z: number }[];
} | null;

export interface RouteAndBreadcrumbsHandle {
  readonly state: Mini3dGtaRouteState;
  rebuild(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════════════════════════

async function fetchLoginByType(poiType: string): Promise<NavmeLoginRow | null> {
  const want = poiType.trim().toLowerCase();
  const { data } = await supabase.from(NAVME_TABLES.logins).select('poi_type, map_code');
  const rows = data || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as NavmeLoginRow;
    if (String(row.poi_type ?? '').trim().toLowerCase() === want) return row;
  }
  return null;
}

async function fetchPois(poiType: string): Promise<NavMapPoi[]> {
  const want = poiType.trim().toLowerCase();
  const { data, error } = await supabase.from(NAVME_TABLES.pois).select('*');
  if (error) return [];
  const out: NavMapPoi[] = [];
  for (let i = 0; i < (data || []).length; i++) {
    const r = (data || [])[i] as {
      id?: string | number;
      poi_name?: string;
      poi_type?: string;
      pos_x?: number;
      pos_y?: number;
      pos_z?: number;
    };
    const cat = (r.poi_type || '').trim().toLowerCase();
    if (cat !== want) continue;
    out.push({
      id: 'room-' + String(r.id ?? ''),
      name: r.poi_name || 'POI',
      x: Number(r.pos_x ?? 0),
      y: Number(r.pos_y ?? 0),
      z: Number(r.pos_z ?? 0),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

type PoiFloorLevelRef = { floorY: number };

/** Named floor level for a POI Y — midpoint bands between adjacent slice heights. */
function floorLevelForPoiY<T extends PoiFloorLevelRef>(poiY: number, floorLevels: T[]): T | null {
  if (floorLevels.length === 0) return null;
  if (floorLevels.length === 1) return floorLevels[0];
  const sorted = [...floorLevels].sort((a, b) => a.floorY - b.floorY);
  if (poiY < (sorted[0].floorY + sorted[1].floorY) * 0.5) return sorted[0];
  if (poiY >= (sorted[sorted.length - 2].floorY + sorted[sorted.length - 1].floorY) * 0.5) {
    return sorted[sorted.length - 1];
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const mid = (sorted[i].floorY + sorted[i + 1].floorY) * 0.5;
    if (poiY < mid) return sorted[i];
  }
  return sorted[sorted.length - 1];
}

/** Floor level whose Y is closest to a POI's height. */
function nearestFloorYForPoi(poiY: number, floorLevels: PoiFloorLevelRef[]): number {
  if (floorLevels.length === 0) return poiY;
  let bestY = floorLevels[0].floorY;
  let bestDist = Math.abs(floorLevels[0].floorY - poiY);
  for (let i = 1; i < floorLevels.length; i++) {
    const d = Math.abs(floorLevels[i].floorY - poiY);
    if (d < bestDist) {
      bestDist = d;
      bestY = floorLevels[i].floorY;
    }
  }
  return bestY;
}

function yBandAroundSlice(targetY: number, floorLevels: PoiFloorLevelRef[]): number {
  const ys: number[] = [];
  for (let i = 0; i < floorLevels.length; i++) {
    const y = floorLevels[i].floorY;
    let seen = false;
    for (let j = 0; j < ys.length; j++) {
      if (Math.abs(ys[j] - y) < 1e-4) {
        seen = true;
        break;
      }
    }
    if (!seen) ys.push(y);
  }
  ys.sort((a, b) => a - b);
  let below = -Infinity;
  let above = Infinity;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    if (y < targetY - 1e-4) below = y;
    if (y > targetY + 1e-4) {
      above = y;
      break;
    }
  }
  const halfBelow = below === -Infinity ? Infinity : (targetY - below) / 2;
  const halfAbove = above === Infinity ? Infinity : (above - targetY) / 2;
  return Math.min(halfBelow, halfAbove, 3);
}

function floorDisplayLabel(floor: { label?: string }, index: number): string {
  const label = floor.label?.trim();
  return label || `Floor ${index + 1}`;
}

/**
 * POIs for one floor slice: each POI belongs to the nearest named floor Y.
 * Example: floor 1 at Y=-0.3 and floor 2 at Y=3.5 — a POI at y=-0.25 shows on floor 1 only.
 */
function floorLabelForPoi(poi: NavMapPoi, floorLevels: FloorLevel[]): string {
  if (floorLevels.length === 0) return 'Floor';
  const y = nearestFloorYForPoi(poi.y, floorLevels);
  const floor = floorLevelForPoiY(y, floorLevels);
  if (!floor) return 'Floor';
  const idx = floorLevels.indexOf(floor);
  return floorDisplayLabel(floor, idx >= 0 ? idx : 0);
}

function filterPoisByFloorY(
  pois: NavMapPoi[],
  targetFloorY: number,
  floorLevels: PoiFloorLevelRef[],
): NavMapPoi[] {
  if (pois.length === 0) return pois;

  if (floorLevels.length === 0) {
    const band = 2.5;
    const out: NavMapPoi[] = [];
    for (let i = 0; i < pois.length; i++) {
      if (Math.abs(pois[i].y - targetFloorY) <= band) out.push(pois[i]);
    }
    return out;
  }

  let hasNamedFloor = false;
  for (let i = 0; i < floorLevels.length; i++) {
    if (Math.abs(floorLevels[i].floorY - targetFloorY) < 1e-4) {
      hasNamedFloor = true;
      break;
    }
  }

  const out: NavMapPoi[] = [];
  if (hasNamedFloor) {
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      if (Math.abs(nearestFloorYForPoi(p.y, floorLevels) - targetFloorY) < 1e-4) out.push(p);
    }
    return out;
  }

  const band = yBandAroundSlice(targetFloorY, floorLevels);
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    if (Math.abs(p.y - targetFloorY) <= band) out.push(p);
  }
  return out;
}

function isPoiRouteId(id: string): boolean {
  return (
    id.length > 0 && id.indexOf(ZONE_ROUTE_PREFIX) !== 0 && id.indexOf(FLOOR_ROUTE_PREFIX) !== 0
  );
}

function poiOnFloor(poiId: string, floorPois: NavMapPoi[]): boolean {
  for (let i = 0; i < floorPois.length; i++) {
    if (floorPois[i].id === poiId) return true;
  }
  return false;
}

async function fetchFloorEdit(
  poiType: string,
  mapCode: string,
): Promise<{ sliceY: number; payload: NavmeFloorEditPayload } | null> {
  const { data } = await supabase
    .from(NAVME_FLOOR_EDITS_TABLE)
    .select('floor_slice_y, floor_data')
    .eq('poi_type', poiType.trim())
    .eq('map_code', mapCode.trim().toUpperCase());
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  const raw = (row as { floor_slice_y?: number; floor_data?: unknown }).floor_data;
  const sliceY = Number((row as { floor_slice_y?: number }).floor_slice_y ?? 0);
  const payload = parseFloorPayload(raw);
  if (!payload) return null;
  return { sliceY, payload };
}

function cloneFloorBlock(block: FloorBlock): FloorBlock {
  return {
    ...block,
    points: block.points ? block.points.map((pt) => ({ x: pt.x, z: pt.z })) : undefined,
  };
}

function cloneFloorBlocks(blocks: FloorBlock[]): FloorBlock[] {
  const out: FloorBlock[] = [];
  for (let i = 0; i < blocks.length; i++) out.push(cloneFloorBlock(blocks[i]));
  return out;
}

function isPolygonZone(block: FloorBlock): boolean {
  if (!block.points || block.points.length < 3) return false;
  return block.shape === 'polygon' || block.shape === undefined;
}

function pointInPolygon(x: number, z: number, points: FloorPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const zi = points[i].z;
    const xj = points[j].x;
    const zj = points[j].z;
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function parseFloorPayload(raw: unknown): NavmeFloorEditPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as NavmeFloorEditPayload;
  if (!Array.isArray(p.walkGrid)) return null;
  const floors = Array.isArray(p.floors)
    ? p.floors.map((f) => ({
        ...f,
        objects: cloneFloorBlocks(f.objects || []),
        zones: cloneFloorBlocks(f.zones || []),
        stairMouths: f.stairMouths?.map((m) => ({ ...m })),
      }))
    : [];
  return {
    ...p,
    version: p.version ?? FLOOR_EDIT_VERSION,
    objects: cloneFloorBlocks(Array.isArray(p.objects) ? p.objects : []),
    zones: cloneFloorBlocks(Array.isArray(p.zones) ? p.zones : []),
    floors,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SAVED FLOOR MAP ONLY (from navme_floor_edits)
// ═══════════════════════════════════════════════════════════════════════════

const WALL_EPS = 1e-4;

function mergeRects(
  mask: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
  fill: string,
  idPrefix: string,
): FloorBlock[] {
  const used = new Uint8Array(mask.length);
  const blocks: FloorBlock[] = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!mask[i] || used[i]) continue;
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
        id: idPrefix + id++,
        x: minX + c * cell,
        z: minZ + r * cell,
        w: w * cell,
        d: h * cell,
        fill,
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

function mergeOrthogonalSegments(segs: WallSeg[]): WallSeg[] {
  const horiz: { z: number; x0: number; x1: number }[] = [];
  const vert: { x: number; z0: number; z1: number }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (Math.abs(s.z1 - s.z2) < WALL_EPS) {
      horiz.push({ z: s.z1, x0: Math.min(s.x1, s.x2), x1: Math.max(s.x1, s.x2) });
    } else if (Math.abs(s.x1 - s.x2) < WALL_EPS) {
      vert.push({ x: s.x1, z0: Math.min(s.z1, s.z2), z1: Math.max(s.z1, s.z2) });
    }
  }
  horiz.sort((a, b) => a.z - b.z || a.x0 - b.x0);
  vert.sort((a, b) => a.x - b.x || a.z0 - b.z0);

  const mergedH: { z: number; x0: number; x1: number }[] = [];
  for (let i = 0; i < horiz.length; i++) {
    const h = horiz[i];
    const last = mergedH[mergedH.length - 1];
    if (last && Math.abs(last.z - h.z) < WALL_EPS && h.x0 <= last.x1 + WALL_EPS) {
      last.x1 = Math.max(last.x1, h.x1);
    } else mergedH.push({ z: h.z, x0: h.x0, x1: h.x1 });
  }
  const mergedV: { x: number; z0: number; z1: number }[] = [];
  for (let i = 0; i < vert.length; i++) {
    const v = vert[i];
    const last = mergedV[mergedV.length - 1];
    if (last && Math.abs(last.x - v.x) < WALL_EPS && v.z0 <= last.z1 + WALL_EPS) {
      last.z1 = Math.max(last.z1, v.z1);
    } else mergedV.push({ x: v.x, z0: v.z0, z1: v.z1 });
  }

  const out: WallSeg[] = [];
  for (let i = 0; i < mergedH.length; i++) {
    const h = mergedH[i];
    out.push({ x1: h.x0, z1: h.z, x2: h.x1, z2: h.z });
  }
  for (let i = 0; i < mergedV.length; i++) {
    const v = mergedV[i];
    out.push({ x1: v.x, z1: v.z0, x2: v.x, z2: v.z1 });
  }
  return out;
}

function extractWalls(
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

function applyWalkGridEdits(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  floors: FloorLevel[],
): Floor2DMap {
  const corridors = mergeRects(
    walk,
    map.cols,
    map.rows,
    map.minX,
    map.minZ,
    map.cellSize,
    FLOOR2D_STYLE.corridor,
    'block-',
  );
  const storeMask = extractStoreMask(walk, map.cols, map.rows);
  const stores = mergeRects(
    storeMask,
    map.cols,
    map.rows,
    map.minX,
    map.minZ,
    map.cellSize,
    FLOOR2D_STYLE.store,
    'store-',
  );
  return {
    ...map,
    corridors,
    blocks: corridors,
    stores,
    objects: cloneFloorBlocks(objects),
    zones: cloneFloorBlocks(zones),
    floors: floors.map((f) => ({
      ...f,
      objects: cloneFloorBlocks(f.objects || []),
      zones: cloneFloorBlocks(f.zones || []),
    })),
    walls: extractWalls(walk, map.cols, map.rows, map.minX, map.minZ, map.cellSize),
  };
}

function zoneDisplayLabel(block: FloorBlock, pois: NavMapPoi[]): string {
  if (block.label.trim()) return block.label.trim();
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    if (pointInsideBlock(p.x, p.z, block)) return p.name;
  }
  return '';
}

type SavedFloorBuild =
  | {
      map: Floor2DMap;
      walk: Uint8Array;
      objects: FloorBlock[];
      zones: FloorBlock[];
      floors: FloorLevel[];
      activeFloorId: string | null;
    }
  | { error: string };

const floorBuildCache = new Map<string, Exclude<SavedFloorBuild, { error: string }>>();

function clearFloorBuildCache(): void {
  floorBuildCache.clear();
}

function buildMapFromSavedPayloadCached(
  payload: NavmeFloorEditPayload,
  floorId?: string | null,
): SavedFloorBuild {
  const key = floorId ?? '__default__';
  const cached = floorBuildCache.get(key);
  if (cached) return cached;
  const built = buildMapFromSavedPayload(payload, floorId);
  if (!('error' in built)) floorBuildCache.set(key, built);
  return built;
}

function buildMapFromSavedPayload(
  payload: NavmeFloorEditPayload,
  floorId?: string | null,
): SavedFloorBuild {
  if (!payload.cols || !payload.rows || !Array.isArray(payload.walkGrid)) {
    return { error: 'Invalid saved floor data (missing grid)' };
  }
  const gridLen = payload.cols * payload.rows;
  if (payload.walkGrid.length !== gridLen) {
    return { error: 'Saved walk grid length does not match cols × rows' };
  }

  const floors = (payload.floors || []).map((f) => {
    const hydrated = {
      ...f,
      objects: cloneFloorBlocks(f.objects || []),
      zones: cloneFloorBlocks(f.zones || []),
      stairMouths: f.stairMouths?.map((m) => ({ ...m })),
    };
    if (
      !hydrated.walkGrid ||
      hydrated.walkGrid.length !== gridLen ||
      (hydrated.gridCols !== undefined && hydrated.gridCols !== payload.cols) ||
      (hydrated.gridRows !== undefined && hydrated.gridRows !== payload.rows)
    ) {
      hydrated.walkGrid = [...payload.walkGrid];
      hydrated.gridCols = payload.cols;
      hydrated.gridRows = payload.rows;
      hydrated.gridCellSize = payload.cellSize;
      hydrated.gridMinX = payload.minX;
      hydrated.gridMinZ = payload.minZ;
    }
    return hydrated;
  });

  const active =
    (floorId ? floors.find((f) => f.id === floorId) : null) ??
    floors.find((f) => Math.abs(f.floorY - payload.sliceY) < 1e-4) ??
    floors[0];

  const sliceY = active?.floorY ?? payload.sliceY;
  const onDefaultSlice = !active || Math.abs(sliceY - payload.sliceY) < 1e-4;

  let walk: Uint8Array | null = null;
  if (
    active?.walkGrid &&
    active.walkGrid.length === gridLen &&
    (active.gridCols === undefined || active.gridCols === payload.cols) &&
    (active.gridRows === undefined || active.gridRows === payload.rows)
  ) {
    walk = new Uint8Array(active.walkGrid.map((v) => (v ? 1 : 0)));
  } else if (onDefaultSlice) {
    walk = new Uint8Array(payload.walkGrid.map((v) => (v ? 1 : 0)));
  } else if (active?.walkGrid && active.walkGrid.length === gridLen) {
    walk = new Uint8Array(active.walkGrid.map((v) => (v ? 1 : 0)));
  }

  if (!walk) {
    const label = active?.label ?? 'selected floor';
    return { error: `No saved walk grid for "${label}" — save this floor in the editor first` };
  }

  const objects = active?.objects?.length ? active.objects : onDefaultSlice ? payload.objects || [] : [];
  const zones = active?.zones?.length ? active.zones : onDefaultSlice ? payload.zones || [] : [];

  const baseMap: Floor2DMap = {
    sliceY,
    cellSize: payload.cellSize,
    minX: payload.minX,
    maxX: payload.maxX,
    minZ: payload.minZ,
    maxZ: payload.maxZ,
    cols: payload.cols,
    rows: payload.rows,
    corridors: [],
    stores: [],
    objects,
    zones,
    floors,
    blocks: [],
    walls: [],
  };
  const map = applyWalkGridEdits(baseMap, walk, objects, zones, floors);

  return {
    map,
    walk,
    objects,
    zones,
    floors,
    activeFloorId: active?.id ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2D ROUTING (A*)
// ═══════════════════════════════════════════════════════════════════════════

function pointInsideBlock(x: number, z: number, block: FloorBlock): boolean {
  if (isPolygonZone(block) && block.points) return pointInPolygon(x, z, block.points);
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
  return x >= block.x && x <= block.x + block.w && z >= block.z && z <= block.z + block.d;
}

function zoneCentroid(z: FloorBlock): { x: number; z: number } {
  if (isPolygonZone(z) && z.points) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < z.points.length; i++) {
      sx += z.points[i].x;
      sz += z.points[i].z;
    }
    return { x: sx / z.points.length, z: sz / z.points.length };
  }
  return { x: z.x + z.w * 0.5, z: z.z + z.d * 0.5 };
}

function truncateLabel(label: string, maxLen: number): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + '…';
}

function hypot2(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

function blockContainsObject(objects: FloorBlock[], x: number, z: number): boolean {
  for (let i = 0; i < objects.length; i++) {
    if (pointInsideBlock(x, z, objects[i])) return true;
  }
  return false;
}

function findPathOnFloor(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  sx: number,
  sz: number,
  ex: number,
  ez: number,
  floorY: number,
): { path: { x: number; y: number; z: number }[] } | { error: string } {
  const nav = new Uint8Array(map.cols * map.rows);
  for (let i = 0; i < walk.length; i++) {
    if (!walk[i]) continue;
    const c = i % map.cols;
    const r = (i / map.cols) | 0;
    const x = map.minX + (c + 0.5) * map.cellSize;
    const z = map.minZ + (r + 0.5) * map.cellSize;
    if (!blockContainsObject(objects, x, z)) nav[i] = 1;
  }
  const toCell = (x: number, z: number) => ({
    c: Math.floor((x - map.minX) / map.cellSize),
    r: Math.floor((z - map.minZ) / map.cellSize),
  });
  const near = (x: number, z: number) => {
    const cell = toCell(x, z);
    let c = cell.c;
    let r = cell.r;
    if (c >= 0 && r >= 0 && c < map.cols && r < map.rows && nav[r * map.cols + c]) return { c, r };
    for (let rad = 1; rad < 40; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
          if (nav[nr * map.cols + nc]) return { c: nc, r: nr };
        }
      }
    }
    return null;
  };
  const start = near(sx, sz);
  const end = near(ex, ez);
  if (!start || !end) return { error: 'Origin or destination not on walkable floor' };
  const N = map.cols * map.rows;
  const g = new Float32Array(N);
  const f = new Float32Array(N);
  const from = new Int32Array(N);
  const closed = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    g[i] = Infinity;
    f[i] = Infinity;
    from[i] = -1;
  }
  const si = start.r * map.cols + start.c;
  const ei = end.r * map.cols + end.c;
  g[si] = 0;
  f[si] = hypot2(end.c - start.c, end.r - start.r);
  const open: number[] = [si];
  const neigh = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, 1.414],
    [1, -1, 1.414],
    [-1, 1, 1.414],
    [-1, -1, 1.414],
  ];
  while (open.length) {
    open.sort((a, b) => f[a] - f[b]);
    const cur = open.shift()!;
    if (cur === ei) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cr = (cur / map.cols) | 0;
    const cc = cur % map.cols;
    for (let n = 0; n < neigh.length; n++) {
      const dc = neigh[n][0];
      const dr = neigh[n][1];
      const cost = neigh[n][2];
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
      const ni = nr * map.cols + nc;
      if (!nav[ni] || closed[ni]) continue;
      const tg = g[cur] + cost;
      if (tg >= g[ni]) continue;
      from[ni] = cur;
      g[ni] = tg;
      f[ni] = tg + hypot2(end.c - nc, end.r - nr);
      if (open.indexOf(ni) === -1) open.push(ni);
    }
  }
  if (from[ei] < 0 && si !== ei) return { error: 'No path on floor' };
  const cells: { c: number; r: number }[] = [];
  let c = ei;
  while (c >= 0) {
    cells.push({ c: c % map.cols, r: (c / map.cols) | 0 });
    c = from[c];
  }
  cells.reverse();
  return {
    path: cells.map(({ c: col, r: row }) => ({
      x: map.minX + (col + 0.5) * map.cellSize,
      y: floorY,
      z: map.minZ + (row + 0.5) * map.cellSize,
    })),
  };
}


// FLOOR GRID ROUTING + NAV-MESH SNAP (from editor2d floor2dRoute + navmeshSnap)

type FloorPathPoint = { x: number; y: number; z: number };

type FloorRouteCell = { c: number; r: number };

type Vec3 = { x: number; y: number; z: number };

const NEIGHBORS_8: { dc: number; dr: number; cost: number }[] = [
  { dc: 1, dr: 0, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
];

function cellIndex(map: Floor2DMap, c: number, r: number): number {
  return r * map.cols + c;
}

function worldToCell(map: Floor2DMap, x: number, z: number): FloorRouteCell | null {
  const c = Math.floor((x - map.minX) / map.cellSize);
  const r = Math.floor((z - map.minZ) / map.cellSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return null;
  return { c, r };
}

function cellCenter(map: Floor2DMap, c: number, r: number): { x: number; z: number } {
  return {
    x: map.minX + (c + 0.5) * map.cellSize,
    z: map.minZ + (r + 0.5) * map.cellSize,
  };
}

function cellBlockedByObject(x: number, z: number, objects: FloorBlock[]): boolean {
  for (let i = 0; i < objects.length; i++) {
    if (pointInsideBlock(x, z, objects[i])) return true;
  }
  return false;
}

function buildFloorNavGrid(map: Floor2DMap, walk: Uint8Array, objects: FloorBlock[]): Uint8Array {
  const nav = new Uint8Array(map.cols * map.rows);
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const i = cellIndex(map, c, r);
      if (!walk[i]) continue;
      const center = cellCenter(map, c, r);
      if (cellBlockedByObject(center.x, center.z, objects)) continue;
      nav[i] = 1;
    }
  }
  return nav;
}

function isWalkable(nav: Uint8Array, map: Floor2DMap, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
  return nav[cellIndex(map, c, r)] === 1;
}

function nearestWalkableCell(
  map: Floor2DMap,
  nav: Uint8Array,
  x: number,
  z: number,
  maxCells = 128,
): FloorRouteCell | null {
  const start = worldToCell(map, x, z);
  if (!start) return null;
  if (isWalkable(nav, map, start.c, start.r)) return start;

  const visited = new Uint8Array(map.cols * map.rows);
  const queue: FloorRouteCell[] = [start];
  visited[cellIndex(map, start.c, start.r)] = 1;
  let qi = 0;
  let steps = 0;

  while (qi < queue.length && steps < maxCells * maxCells) {
    const { c, r } = queue[qi++];
    steps++;
    for (let n = 0; n < NEIGHBORS_8.length; n++) {
      const nc = c + NEIGHBORS_8[n].dc;
      const nr = r + NEIGHBORS_8[n].dr;
      if (isWalkable(nav, map, nc, nr)) return { c: nc, r: nr };
    }
    for (let n = 0; n < NEIGHBORS_8.length; n++) {
      const nc = c + NEIGHBORS_8[n].dc;
      const nr = r + NEIGHBORS_8[n].dr;
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
      const ni = cellIndex(map, nc, nr);
      if (visited[ni]) continue;
      visited[ni] = 1;
      queue.push({ c: nc, r: nr });
    }
  }
  return null;
}

function snapWorldToWalkCell(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  x: number,
  z: number,
): { x: number; z: number } | null {
  const nav = buildFloorNavGrid(map, walk, objects);
  const cell = nearestWalkableCell(map, nav, x, z);
  if (!cell) return null;
  return cellCenter(map, cell.c, cell.r);
}

function heuristic(a: FloorRouteCell, b: FloorRouteCell): number {
  const dc = Math.abs(a.c - b.c);
  const dr = Math.abs(a.r - b.r);
  return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
}

function reconstructPath(cameFrom: Int32Array, endIdx: number, map: Floor2DMap): FloorRouteCell[] {
  const cells: FloorRouteCell[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    const row = Math.floor(cur / map.cols);
    const col = cur % map.cols;
    cells.push({ c: col, r: row });
    cur = cameFrom[cur];
  }
  cells.reverse();
  return cells;
}

function simplifyCollinear(cells: FloorRouteCell[]): FloorRouteCell[] {
  if (cells.length <= 2) return cells;
  const out: FloorRouteCell[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = out[out.length - 1];
    const b = cells[i];
    const c = cells[i + 1];
    const cross = (b.c - a.c) * (c.r - a.r) - (b.r - a.r) * (c.c - a.c);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

function cellsToWorldPath(cells: FloorRouteCell[], map: Floor2DMap, floorY: number): FloorPathPoint[] {
  return cells.map(({ c, r }) => {
    const center = cellCenter(map, c, r);
    return { x: center.x, y: floorY, z: center.z };
  });
}

function findPathOnFloorGrid(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  floorY: number,
): { path: FloorPathPoint[] } | { error: string } {
  const nav = buildFloorNavGrid(map, walk, objects);
  let walkableCount = 0;
  for (let i = 0; i < nav.length; i++) if (nav[i]) walkableCount++;
  if (walkableCount < 2) {
    return { error: 'No walkable floor — paint floor with Paint Floor first' };
  }

  const startCell = nearestWalkableCell(map, nav, startX, startZ);
  const endCell = nearestWalkableCell(map, nav, endX, endZ);
  if (!startCell) return { error: 'Origin is not on walkable floor' };
  if (!endCell) return { error: 'Destination is not on walkable floor' };

  const startIdx = cellIndex(map, startCell.c, startCell.r);
  const endIdx = cellIndex(map, endCell.c, endCell.r);
  if (startIdx === endIdx) {
    return { path: cellsToWorldPath([startCell], map, floorY) };
  }

  const total = map.cols * map.rows;
  const gScore = new Float32Array(total);
  gScore.fill(Infinity);
  const fScore = new Float32Array(total);
  fScore.fill(Infinity);
  const cameFrom = new Int32Array(total);
  cameFrom.fill(-1);
  const closed = new Uint8Array(total);

  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(startCell, endCell);

  const open: number[] = [startIdx];

  while (open.length > 0) {
    open.sort((a, b) => fScore[a] - fScore[b]);
    const current = open.shift()!;
    if (current === endIdx) {
      const cells = simplifyCollinear(reconstructPath(cameFrom, endIdx, map));
      return { path: cellsToWorldPath(cells, map, floorY) };
    }
    if (closed[current]) continue;
    closed[current] = 1;

    const cr = Math.floor(current / map.cols);
    const cc = current % map.cols;

    for (let n = 0; n < NEIGHBORS_8.length; n++) {
      const { dc, dr, cost } = NEIGHBORS_8[n];
      const nc = cc + dc;
      const nr = cr + dr;
      if (!isWalkable(nav, map, nc, nr)) continue;

      if (dc !== 0 && dr !== 0) {
        if (!isWalkable(nav, map, cc + dc, cr) || !isWalkable(nav, map, cc, cr + dr)) continue;
      }

      const neighbor = cellIndex(map, nc, nr);
      if (closed[neighbor]) continue;

      const tentative = gScore[current] + cost;
      if (tentative >= gScore[neighbor]) continue;

      cameFrom[neighbor] = current;
      gScore[neighbor] = tentative;
      fScore[neighbor] = tentative + heuristic({ c: nc, r: nr }, endCell);
      if (open.indexOf(neighbor) === -1) open.push(neighbor);
    }
  }

  return { error: 'No path on floor — cut a corridor or move obstacles' };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE API (NERDS-GEEKS/2d — POST /api/route/compute, no duplicated routing)
// ═══════════════════════════════════════════════════════════════════════════

type FloorRouteSegment = {
  floorId: string;
  floorY: number;
  label: string;
  path: FloorPathPoint[];
};

type FloorRouteConnector = {
  fromFloorId: string;
  toFloorId: string;
  from: { x: number; z: number };
  to: { x: number; z: number };
  via: { x: number; y: number; z: number }[];
  manualMouth?: boolean;
};

const STAIR_MOUTH_MARKER_COLOR = '#dc2626';
const STAIR_MOUTH_LINK_COLOR = '#ea580c';

type RouteBreakPoint = {
  floorId: string;
  floorY: number;
  x: number;
  z: number;
  label: string;
};

type MultiFloorRoutePlan = {
  multiFloor: boolean;
  segments: FloorRouteSegment[];
  connectors: FloorRouteConnector[];
  error?: string;
  debugForward?: FloorRouteSegment[];
  debugReverse?: FloorRouteSegment[];
  breakPoints?: RouteBreakPoint[];
};

function floorForY(y: number, floors: FloorLevel[]): FloorLevel | null {
  return floorLevelForPoiY(y, floors);
}

function getFloorWalkGrid(map: Floor2DMap, floor: FloorLevel): Uint8Array | null {
  if (
    !floor.walkGrid ||
    floor.gridCols !== map.cols ||
    floor.gridRows !== map.rows ||
    floor.walkGrid.length !== map.cols * map.rows
  ) {
    return null;
  }
  return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
}

function previewMapForFloor(
  map: Floor2DMap,
  floor: FloorLevel,
  allFloors: FloorLevel[],
): Floor2DMap {
  const floorMap = routingMapForFloor(map, floor);
  const walk = resolveFloorWalkGridEmbed(floorMap, floor, null, null);
  if (!walk) return floorMap;
  return applyWalkGridEdits(floorMap, walk, floor.objects ?? [], floor.zones ?? [], allFloors);
}

function distXZ(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pathXZ(path: FloorPathPoint[]): { x: number; z: number }[] {
  return path.map((p) => ({ x: p.x, z: p.z }));
}

function dedupePathPoints(path: { x: number; z: number }[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const prev = out[out.length - 1];
    if (prev && distXZ(prev, p) < 0.02) continue;
    out.push(p);
  }
  return out;
}

function setPathEndpoint(
  path: { x: number; z: number }[],
  point: { x: number; z: number },
  end: 'start' | 'end',
): { x: number; z: number }[] {
  if (path.length === 0) return [{ x: point.x, z: point.z }];
  const out = path.map((p) => ({ ...p }));
  const i = end === 'start' ? 0 : out.length - 1;
  out[i] = { x: point.x, z: point.z };
  return out;
}

function pathForFloor3dPlate(
  floorId: string,
  segment: FloorRouteSegment | undefined,
  connectors: FloorRouteConnector[],
): { x: number; z: number }[] {
  if (!segment || segment.path.length < 2) return [];
  let path = pathXZ(segment.path);
  for (const link of connectors) {
    if (link.toFloorId === floorId) {
      path = setPathEndpoint(path, { x: link.to.x, z: link.to.z }, 'start');
    }
    if (link.fromFloorId === floorId) {
      path = setPathEndpoint(path, { x: link.from.x, z: link.from.z }, 'end');
    }
  }
  return dedupePathPoints(path);
}

function nearestIndexTowardStart(path: { x: number; z: number }[], x: number, z: number): number {
  const limit = Math.min(path.length, Math.max(3, Math.ceil(path.length * 0.45)));
  let best = 0;
  let bestD = distXZ(path[0], { x, z });
  for (let i = 1; i < limit; i++) {
    const d = distXZ(path[i], { x, z });
    if (d < bestD - 0.02) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function nearestIndexTowardEnd(path: { x: number; z: number }[], x: number, z: number): number {
  const start = Math.max(0, path.length - Math.max(3, Math.ceil(path.length * 0.45)));
  let best = path.length - 1;
  let bestD = distXZ(path[best], { x, z });
  for (let i = start; i < path.length - 1; i++) {
    const d = distXZ(path[i], { x, z });
    if (d < bestD - 0.02 || (d <= bestD + 0.05 && i > best)) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function trimPathForFloorPlate(
  floorId: string,
  path: FloorPathPoint[],
  connectors: FloorRouteConnector[],
): FloorPathPoint[] {
  if (path.length < 2) return path;
  let out = [...path];
  for (const link of connectors) {
    if (link.toFloorId !== floorId) continue;
    const idx = nearestIndexTowardStart(out, link.to.x, link.to.z);
    out = out.slice(idx);
  }
  for (const link of connectors) {
    if (link.fromFloorId !== floorId) continue;
    const idx = nearestIndexTowardEnd(out, link.from.x, link.from.z);
    out = out.slice(0, idx + 1);
  }
  return out.length >= 2 ? out : path;
}

function buildFloorChain(
  floors: FloorLevel[],
  originFloor: FloorLevel,
  destFloor: FloorLevel,
  connectors: FloorRouteConnector[],
): FloorLevel[] {
  const byId = new Map(floors.map((f) => [f.id, f]));
  const chain: FloorLevel[] = [originFloor];
  let currentId = originFloor.id;
  for (let guard = 0; guard < connectors.length + 2 && currentId !== destFloor.id; guard++) {
    const link = connectors.find((c) => c.fromFloorId === currentId);
    if (!link) break;
    const next = byId.get(link.toFloorId);
    if (!next) break;
    if (chain[chain.length - 1]?.id !== next.id) chain.push(next);
    currentId = next.id;
  }
  if (chain[chain.length - 1]?.id !== destFloor.id) chain.push(destFloor);
  return chain;
}

function flattenSegmentPaths(segments: FloorRouteSegment[]): FloorPathPoint[] {
  const out: FloorPathPoint[] = [];
  for (let i = 0; i < segments.length; i++) {
    const path = segments[i].path;
    for (let j = 0; j < path.length; j++) out.push(path[j]);
  }
  return out;
}

function planToWaypoints(
  segments: FloorRouteSegment[],
  connectors: FloorRouteConnector[],
  floors: FloorLevel[],
  originFloorId: string,
  destFloorId: string,
): { x: number; y: number; z: number }[] {
  const originFloor = floors.find((f) => f.id === originFloorId);
  const destFloor = floors.find((f) => f.id === destFloorId);
  if (!originFloor || !destFloor || segments.length === 0) {
    return flattenSegmentPaths(segments);
  }
  const chain = buildFloorChain(floors, originFloor, destFloor, connectors);
  const out: FloorPathPoint[] = [];
  for (let i = 0; i < chain.length; i++) {
    const floor = chain[i];
    const seg = segments.find((s) => s.floorId === floor.id);
    if (!seg || seg.path.length === 0) continue;
    const snapped = pathForFloor3dPlate(floor.id, seg, connectors);
    const startIdx = out.length > 0 ? 1 : 0;
    for (let pi = startIdx; pi < snapped.length; pi++) {
      out.push({ x: snapped[pi].x, y: seg.floorY, z: snapped[pi].z });
    }
    const outbound = connectors.find((c) => c.fromFloorId === floor.id);
    if (outbound) {
      for (let vi = 0; vi < outbound.via.length; vi++) {
        const v = outbound.via[vi];
        out.push({ x: v.x, y: v.y, z: v.z });
      }
    }
  }
  return out.length >= 2 ? out : flattenSegmentPaths(segments);
}

// ─── STAIR-MOUTH ROUTING (standalone — no nav mesh) ───────────────────────────

function floorsHaveStairMouths(floors: FloorLevel[]): boolean {
  return floors.some((f) => (f.stairMouths?.length ?? 0) > 0);
}

function floorsHaveLinkedStairMouths(floors: FloorLevel[]): boolean {
  for (let fi = 0; fi < floors.length; fi++) {
    const mouths = floors[fi].stairMouths;
    if (!mouths) continue;
    for (let mi = 0; mi < mouths.length; mi++) {
      if (mouths[mi].linkedFloorId && mouths[mi].linkedMouthId) return true;
    }
  }
  return false;
}

function routingMapForFloor(map: Floor2DMap, floor: FloorLevel): Floor2DMap {
  const cols = floor.gridCols;
  const rows = floor.gridRows;
  const cell = floor.gridCellSize ?? map.cellSize;
  const minX = floor.gridMinX ?? map.minX;
  const minZ = floor.gridMinZ ?? map.minZ;
  if (cols && rows && floor.walkGrid?.length === cols * rows) {
    return {
      ...map,
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
  return { ...map, sliceY: floor.floorY };
}

function resolveFloorWalkGridEmbed(
  map: Floor2DMap,
  floor: FloorLevel,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): Uint8Array | null {
  const floorMap = routingMapForFloor(map, floor);
  const need = floorMap.cols * floorMap.rows;
  if (floor.walkGrid?.length === need) {
    return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
  }
  if (activeFloorId === floor.id && activeWalk?.length === need) return activeWalk;
  if (activeWalk && floorMap.cols === map.cols && floorMap.rows === map.rows && activeWalk.length === need) {
    return activeWalk;
  }
  return null;
}

function isWorldInFloorMapEmbed(map: Floor2DMap, x: number, z: number): boolean {
  const c = Math.floor((x - map.minX) / map.cellSize);
  const r = Math.floor((z - map.minZ) / map.cellSize);
  return c >= 0 && r >= 0 && c < map.cols && r < map.rows;
}

function resolveMouthLandingXZEmbed(
  map: Floor2DMap,
  floor: FloorLevel,
  x: number,
  z: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
  partner?: { x: number; z: number } | null,
): { x: number; z: number } {
  const floorMap = routingMapForFloor(map, floor);
  const walk = resolveFloorWalkGridEmbed(floorMap, floor, activeWalk, activeFloorId);
  const objects = floor.objects ?? [];
  if (!walk) return { x, z };

  const trySnap = (wx: number, wz: number): { x: number; z: number } | null => {
    if (!isWorldInFloorMapEmbed(floorMap, wx, wz)) return null;
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

function resampleMouthLine(a: Vec3, b: Vec3, steps: number): Vec3[] {
  const out: Vec3[] = [];
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

function findMouthFloorPathEmbed(originId: string, destId: string, floors: FloorLevel[]): string[] | null {
  if (originId === destId) return [originId];
  const adj = new Map<string, Set<string>>();
  for (let fi = 0; fi < floors.length; fi++) {
    const mouths = floors[fi].stairMouths;
    if (!mouths) continue;
    for (let mi = 0; mi < mouths.length; mi++) {
      const m = mouths[mi];
      if (!m.linkedFloorId) continue;
      if (!adj.has(floors[fi].id)) adj.set(floors[fi].id, new Set());
      adj.get(floors[fi].id)!.add(m.linkedFloorId);
      if (!adj.has(m.linkedFloorId)) adj.set(m.linkedFloorId, new Set());
      adj.get(m.linkedFloorId)!.add(floors[fi].id);
    }
  }
  const queue = [originId];
  const prev = new Map<string, string | null>([[originId, null]]);
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    if (id === destId) {
      const path: string[] = [];
      let cur: string | null = destId;
      while (cur) {
        path.unshift(cur);
        cur = prev.get(cur) ?? null;
      }
      return path;
    }
    for (const next of adj.get(id) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, id);
      queue.push(next);
    }
  }
  return null;
}

function pickLinkedMouthEmbed(
  fromFloor: FloorLevel,
  toFloor: FloorLevel,
  nearX: number,
  nearZ: number,
  map: Floor2DMap,
): { mouth: StairMouth; partner: StairMouth } | null {
  const mouths = fromFloor.stairMouths;
  if (!mouths) return null;
  let best: { mouth: StairMouth; partner: StairMouth; score: number } | null = null;
  for (let mi = 0; mi < mouths.length; mi++) {
    const mouth = mouths[mi];
    if (mouth.linkedFloorId !== toFloor.id || !mouth.linkedMouthId) continue;
    const partner = toFloor.stairMouths?.find((m) => m.id === mouth.linkedMouthId);
    if (!partner) continue;
    let score = distXZ(mouth, { x: nearX, z: nearZ });
    const fromMap = routingMapForFloor(map, fromFloor);
    const toMap = routingMapForFloor(map, toFloor);
    if (!isWorldInFloorMapEmbed(fromMap, mouth.x, mouth.z)) score += 1e6;
    if (!isWorldInFloorMapEmbed(toMap, partner.x, partner.z)) score += 1e6;
    if (!best || score < best.score) best = { mouth, partner, score };
  }
  return best ? { mouth: best.mouth, partner: best.partner } : null;
}

function buildFloorLegsEmbed(
  chain: FloorLevel[],
  connectors: FloorRouteConnector[],
  origin: Vec3,
  destination: Vec3,
): { floor: FloorLevel; startX: number; startZ: number; endX: number; endZ: number }[] {
  const legs: { floor: FloorLevel; startX: number; startZ: number; endX: number; endZ: number }[] = [];
  for (let i = 0; i < chain.length; i++) {
    const floor = chain[i];
    const prev = i > 0 ? chain[i - 1] : null;
    const next = i < chain.length - 1 ? chain[i + 1] : null;
    let startX = origin.x;
    let startZ = origin.z;
    let endX = destination.x;
    let endZ = destination.z;
    if (prev) {
      const inbound = connectors.find((c) => c.fromFloorId === prev.id && c.toFloorId === floor.id);
      if (!inbound) return legs;
      startX = inbound.to.x;
      startZ = inbound.to.z;
    }
    if (next) {
      const outbound = connectors.find((c) => c.fromFloorId === floor.id && c.toFloorId === next.id);
      if (!outbound) return legs;
      endX = outbound.from.x;
      endZ = outbound.from.z;
    }
    legs.push({ floor, startX, startZ, endX, endZ });
  }
  return legs;
}

function routeOnFloorGridEmbed(
  map: Floor2DMap,
  floor: FloorLevel,
  floors: FloorLevel[],
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): { path: FloorPathPoint[] } | { error: string } {
  const floorMap = routingMapForFloor(map, floor);
  const walk = resolveFloorWalkGridEmbed(floorMap, floor, activeWalk, activeFloorId);
  if (!walk) return { error: `Paint walkable floor on ${floor.label} first` };
  const preview = applyWalkGridEdits(floorMap, walk, floor.objects ?? [], floor.zones ?? [], floors);
  return findPathOnFloorGrid(
    preview,
    walk,
    floor.objects ?? [],
    startX,
    startZ,
    endX,
    endZ,
    floor.floorY,
  );
}

function snapMouthLanding(
  map: Floor2DMap,
  floor: FloorLevel,
  x: number,
  z: number,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
  partner?: { x: number; z: number } | null,
): { x: number; z: number } {
  return resolveMouthLandingXZEmbed(map, floor, x, z, activeWalk, activeFloorId, partner);
}

function mouthStraightLegPathEmbed(
  floor: FloorLevel,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
): FloorPathPoint[] {
  return [
    { x: startX, y: floor.floorY, z: startZ },
    { x: endX, y: floor.floorY, z: endZ },
  ];
}

export function computeStairMouthRouteEmbed(
  map: Floor2DMap,
  floors: FloorLevel[],
  origin: Vec3,
  destination: Vec3,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): MultiFloorRoutePlan {
  const originFloor = floorForY(origin.y, floors);
  const destFloor = floorForY(destination.y, floors);
  if (!originFloor || !destFloor) {
    return { multiFloor: true, segments: [], connectors: [], error: 'Could not determine floor levels from POI Y' };
  }

  if (originFloor.id === destFloor.id) {
    const out = routeOnFloorGridEmbed(
      map,
      originFloor,
      floors,
      origin.x,
      origin.z,
      destination.x,
      destination.z,
      activeWalk,
      activeFloorId,
    );
    if ('error' in out) return { multiFloor: false, segments: [], connectors: [], error: out.error };
    return {
      multiFloor: false,
      segments: out.path.length >= 2
        ? [{ floorId: originFloor.id, floorY: originFloor.floorY, label: originFloor.label, path: out.path }]
        : [],
      connectors: [],
      error: out.path.length < 2 ? 'No path on floor' : undefined,
    };
  }

  if (!floorsHaveLinkedStairMouths(floors)) {
    return {
      multiFloor: true,
      segments: [],
      connectors: [],
      error: 'Link stair mouths between floors in the floor editor',
    };
  }

  const floorPath = findMouthFloorPathEmbed(originFloor.id, destFloor.id, floors);
  if (!floorPath || floorPath.length < 2) {
    return {
      multiFloor: true,
      segments: [],
      connectors: [],
      error: 'No linked stair mouths connect origin and destination floors',
    };
  }

  const byId = new Map(floors.map((f) => [f.id, f]));
  const connectors: FloorRouteConnector[] = [];
  let nearX = origin.x;
  let nearZ = origin.z;

  for (let i = 0; i < floorPath.length - 1; i++) {
    const fromFloor = byId.get(floorPath[i]);
    const toFloor = byId.get(floorPath[i + 1]);
    if (!fromFloor || !toFloor) {
      return { multiFloor: true, segments: [], connectors: [], error: 'Stair mouth floor link is broken' };
    }
    const picked = pickLinkedMouthEmbed(fromFloor, toFloor, nearX, nearZ, map);
    if (!picked) {
      return {
        multiFloor: true,
        segments: [],
        connectors: [],
        error: `No stair mouth link from ${fromFloor.label} to ${toFloor.label}`,
      };
    }
    const snappedFrom = snapMouthLanding(map, fromFloor, picked.mouth.x, picked.mouth.z, activeWalk, activeFloorId);
    const snappedTo = snapMouthLanding(
      map,
      toFloor,
      picked.partner.x,
      picked.partner.z,
      activeWalk,
      activeFloorId,
      picked.mouth,
    );
    const from3: Vec3 = { x: snappedFrom.x, y: fromFloor.floorY, z: snappedFrom.z };
    const to3: Vec3 = { x: snappedTo.x, y: toFloor.floorY, z: snappedTo.z };
    const span = Math.hypot(to3.x - from3.x, to3.y - from3.y, to3.z - from3.z);
    const steps = Math.max(4, Math.ceil(span / 0.5));
    connectors.push({
      fromFloorId: fromFloor.id,
      toFloorId: toFloor.id,
      from: snappedFrom,
      to: snappedTo,
      via: resampleMouthLine(from3, to3, steps),
      manualMouth: true,
    });
    nearX = snappedTo.x;
    nearZ = snappedTo.z;
  }

  const chain = buildFloorChain(floors, originFloor, destFloor, connectors);
  const legs = buildFloorLegsEmbed(chain, connectors, origin, destination);
  const segments: FloorRouteSegment[] = [];

  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    const gridOut = routeOnFloorGridEmbed(
      map,
      leg.floor,
      floors,
      leg.startX,
      leg.startZ,
      leg.endX,
      leg.endZ,
      activeWalk,
      activeFloorId,
    );
    let path: FloorPathPoint[];
    if ('error' in gridOut || gridOut.path.length < 2) {
      path = mouthStraightLegPathEmbed(leg.floor, leg.startX, leg.startZ, leg.endX, leg.endZ);
    } else {
      path = gridOut.path;
    }
    if (path.length < 2) continue;
    segments.push({
      floorId: leg.floor.id,
      floorY: leg.floor.floorY,
      label: leg.floor.label,
      path,
    });
  }

  if (!segments.some((s) => s.path.length >= 2)) {
    return {
      multiFloor: true,
      segments: [],
      connectors,
      error: 'No walkable path on floor — paint corridors on each level',
    };
  }

  return { multiFloor: connectors.length > 0, segments, connectors };
}

function routeUsesManualStairMouthsEmbed(connectors: FloorRouteConnector[]): boolean {
  return connectors.some((c) => c.manualMouth);
}

function routeApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = (window as Window & { __NAVME_2D_ROUTE_API__?: string }).__NAVME_2D_ROUTE_API__;
    if (custom) return custom.replace(/\/$/, '');
    return `${window.location.origin}/api/route`;
  }
  return '/api/route';
}

function serializeNavMeshForRouteApi(navMesh: NavMesh): { positions: number[]; indices: number[] } {
  const mesh = navMesh as NavMesh & {
    getDebugNavMesh(): [ArrayLike<number>, ArrayLike<number>];
  };
  const [positions, indices] = mesh.getDebugNavMesh();
  return { positions: Array.from(positions), indices: Array.from(indices) };
}

async function fetchMultiFloorRouteFrom2dApi(input: {
  map: Floor2DMap;
  floors: FloorLevel[];
  navMesh: NavMesh | null;
  origin: { x: number; y: number; z: number };
  destination: { x: number; y: number; z: number };
  activeWalk: Uint8Array | null;
  activeFloorId: string | null;
  activeObjects: FloorBlock[];
}): Promise<MultiFloorRoutePlan> {
  const apiBase = routeApiBaseUrl();
  const body = {
    map: input.map,
    floors: input.floors,
    origin: input.origin,
    destination: input.destination,
    activeFloorId: input.activeFloorId,
    activeWalk: input.activeWalk ? Array.from(input.activeWalk) : null,
    activeObjects: input.activeObjects,
    navMesh: input.navMesh ? serializeNavMeshForRouteApi(input.navMesh) : null,
  };

  const res = await fetch(`${apiBase}/compute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  type ApiResponse = { ok: true; plan: MultiFloorRoutePlan } | { ok: false; error: string };
  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    return {
      multiFloor: false,
      segments: [],
      connectors: [],
      error: `2D route API invalid response (${res.status})`,
    };
  }

  if (!res.ok || !payload.ok) {
    const msg = !payload.ok ? payload.error : `2D route API error (${res.status})`;
    return { multiFloor: false, segments: [], connectors: [], error: msg };
  }

  return payload.plan;
}
// 3D FLOOR SCENE (from saved walk grid)
// ═══════════════════════════════════════════════════════════════════════════

/** 3D — Mappedin-style palette (shared with 2D). */
const SCENE3D_STYLE = {
  sceneBg: '#F5F5F0',
  floor: '#EBEBEB',
  corridor: '#EBEBEB',
  room: '#F7F5F2',
  floorCorridors: ['#EBEBEB'],
  interiorBlock: '#F7F5F2',
  interiorBlockTop: '#F7F5F2',
  interiorBlockSide: '#A0A0A0',
  interiorWall: '#A0A0A0',
  interiorWallTop: '#B0B0B0',
  borderWall: '#4A4A4A',
  borderWallTop: '#5C5C5C',
  zoneLabel: '#4A3F55',
  route: '#3B6FD9',
  poi: '#7B2D8E',
  poiLabel: '#4A3F55',
  origin: '#4CAF50',
  destination: '#7B2D8E',
  zoneTints: US_INDOOR_MAP.zoneTints,
  roomFills: US_INDOOR_MAP.roomFills,
} as const;

const BORDER_WALL_HEIGHT = 2.15;
const INTERIOR_WALL_HEIGHT = 0.92;
const INTERIOR_BLOCK_HEIGHT = 0.88;
const BORDER_WALL_THICKNESS = 0.11;
const INTERIOR_WALL_THICKNESS = 0.07;
const MIN_INTERIOR_VOID_CELLS = 2;
const FLOOR_THICKNESS = 0.06;
const ROUTE_LIFT = 0.12;
const ROUTE_RADIUS = 0.15;
const PLATE_THICKNESS = 0.14;
const STACK_PLATE_STEP = 2.85;
const STACK_BORDER_WALL_HEIGHT = 0.92;
const STACK_INTERIOR_WALL_HEIGHT = 0.36;
const STACK_INTERIOR_BLOCK_HEIGHT = 0.3;
const PLAN_LINE_LIFT = 0.038;

function hex(color: string): THREE.Color {
  return new THREE.Color(color as THREE.ColorRepresentation);
}

function floorCorridorColor(_floorIndex: number): string {
  return SCENE3D_STYLE.corridor;
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
      child.geometry?.dispose();
      const m = child.material;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) m[i].dispose();
      } else m?.dispose();
      if (child instanceof THREE.Sprite) {
        const map = (child.material as THREE.SpriteMaterial).map;
        map?.dispose();
      }
    } else if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry?.dispose();
      const m = child.material;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) (m[i] as THREE.Material).dispose();
      } else (m as THREE.Material)?.dispose();
    }
  });
}

function walkAt(map: Floor2DMap, walk: Uint8Array, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
  return walk[r * map.cols + c] === 1;
}

function cellAt(map: Floor2DMap, x: number, z: number): { c: number; r: number } | null {
  const c = Math.floor((x - map.minX) / map.cellSize);
  const r = Math.floor((z - map.minZ) / map.cellSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return null;
  return { c, r };
}

function isBorderWallSegment(seg: WallSeg, map: Floor2DMap, walk: Uint8Array): boolean {
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

function shadedWallMat(color: string, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(color),
    roughness,
    metalness: 0.02,
  });
}

type WallHeights = { border: number; interior: number };

function addWallSegment(
  group: THREE.Group,
  seg: WallSeg,
  floorY: number,
  border: boolean,
  heights?: WallHeights,
): void {
  const dx = seg.x2 - seg.x1;
  const dz = seg.z2 - seg.z1;
  const len = hypot2(dx, dz);
  if (len < WALL_EPS) return;

  const height = border
    ? (heights?.border ?? BORDER_WALL_HEIGHT)
    : (heights?.interior ?? INTERIOR_WALL_HEIGHT);
  const thickness = border ? BORDER_WALL_THICKNESS : INTERIOR_WALL_THICKNESS;
  const rotY = Math.atan2(dz, dx);
  const cx = (seg.x1 + seg.x2) / 2;
  const cz = (seg.z1 + seg.z2) / 2;

  if (border) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(len, height, thickness),
      shadedWallMat(SCENE3D_STYLE.borderWall, 0.93),
    );
    body.position.set(cx, floorY + height / 2, cz);
    body.rotation.y = rotY;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(len + 0.015, 0.035, thickness + 0.015),
      shadedWallMat(SCENE3D_STYLE.borderWallTop, 0.9),
    );
    top.position.set(cx, floorY + height + 0.018, cz);
    top.rotation.y = rotY;
    top.castShadow = true;
    group.add(top);
    return;
  }

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(len, height, thickness),
    shadedWallMat(SCENE3D_STYLE.interiorWall, 0.88),
  );
  body.position.set(cx, floorY + height / 2, cz);
  body.rotation.y = rotY;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(len + 0.01, 0.03, thickness + 0.01),
    shadedWallMat(SCENE3D_STYLE.interiorWallTop, 0.85),
  );
  top.position.set(cx, floorY + height + 0.015, cz);
  top.rotation.y = rotY;
  top.castShadow = true;
  group.add(top);
}

function markEnclosedVoidCells(map: Floor2DMap, walk: Uint8Array): Uint8Array {
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

function addEnclosedInteriorVolumes(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
  blockHeight = INTERIOR_BLOCK_HEIGHT,
  wallHeight = INTERIOR_WALL_HEIGHT,
  zones: FloorBlock[] = [],
): void {
  const enclosed = markEnclosedVoidCells(map, walk);
  const used = new Uint8Array(map.cols * map.rows);
  const cell = map.cellSize;

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const start = r * map.cols + c;
      if (!enclosed[start] || used[start]) continue;

      let w = 1;
      while (c + w < map.cols) {
        const i = r * map.cols + c + w;
        if (!enclosed[i] || used[i]) break;
        w++;
      }

      let h = 1;
      outer: while (r + h < map.rows) {
        for (let dc = 0; dc < w; dc++) {
          const i = (r + h) * map.cols + c + dc;
          if (!enclosed[i] || used[i]) break outer;
        }
        h++;
      }

      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) used[(r + dr) * map.cols + c + dc] = 1;
      }

      const boxW = w * cell;
      const boxD = h * cell;
      const cx = map.minX + (c + w / 2) * cell;
      const cz = map.minZ + (r + h / 2) * cell;
      const inset = 0.04;
      const bodyMat = shadedWallMat(SCENE3D_STYLE.room, 0.9);
      const sideMat = shadedWallMat(SCENE3D_STYLE.interiorWall, 0.87);
      const topMat = shadedWallMat(SCENE3D_STYLE.room, 0.86);

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(boxW - inset, blockHeight, boxD - inset),
        bodyMat,
      );
      body.position.set(cx, floorY + blockHeight / 2, cz);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const rimH = wallHeight - blockHeight;
      if (rimH > 0.02) {
        const rim = new THREE.Mesh(
          new THREE.BoxGeometry(boxW - inset * 0.5, rimH, boxD - inset * 0.5),
          sideMat,
        );
        rim.position.set(cx, floorY + blockHeight + rimH / 2, cz);
        rim.castShadow = true;
        group.add(rim);
      }

      const top = new THREE.Mesh(
        new THREE.BoxGeometry(boxW - inset * 0.3, 0.028, boxD - inset * 0.3),
        topMat,
      );
      top.position.set(cx, floorY + wallHeight + 0.014, cz);
      group.add(top);
    }
  }
}

function addWallMeshes(
  group: THREE.Group,
  walls: WallSeg[],
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
  stacked = false,
): void {
  const heights: WallHeights | undefined = stacked
    ? { border: STACK_BORDER_WALL_HEIGHT, interior: STACK_INTERIOR_WALL_HEIGHT }
    : undefined;
  for (let i = 0; i < walls.length; i++) {
    addWallSegment(group, walls[i], floorY, isBorderWallSegment(walls[i], map, walk), heights);
  }
}

function addWallPlanLines(group: THREE.Group, walls: WallSeg[], floorY: number): void {
  if (walls.length === 0) return;
  const y = floorY + PLAN_LINE_LIFT;
  const positions: number[] = [];
  for (let i = 0; i < walls.length; i++) {
    const seg = walls[i];
    positions.push(seg.x1, y, seg.z1, seg.x2, y, seg.z2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: hex('#3a3a3a') }),
  );
  lines.renderOrder = 6;
  group.add(lines);
}

function addStorePlanRects(group: THREE.Group, stores: FloorBlock[], floorY: number): void {
  if (stores.length === 0) return;
  const y = floorY + PLAN_LINE_LIFT - 0.004;
  const fillMat = new THREE.MeshBasicMaterial({
    color: roomFillColor(),
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: hex('#8a8a8a') });
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.d), fillMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(s.x + s.w / 2, y, s.z + s.d / 2);
    mesh.renderOrder = 4;
    group.add(mesh);
    const pts = [
      new THREE.Vector3(s.x, y, s.z),
      new THREE.Vector3(s.x + s.w, y, s.z),
      new THREE.Vector3(s.x + s.w, y, s.z + s.d),
      new THREE.Vector3(s.x, y, s.z + s.d),
    ];
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), edgeMat);
    loop.renderOrder = 5;
    group.add(loop);
  }
}

function zoneOutlinePoints(zone: FloorBlock, y: number): THREE.Vector3[] {
  if (isPolygonZone(zone) && zone.points && zone.points.length >= 3) {
    return zone.points.map((p) => new THREE.Vector3(p.x, y, p.z));
  }
  return [
    new THREE.Vector3(zone.x, y, zone.z),
    new THREE.Vector3(zone.x + zone.w, y, zone.z),
    new THREE.Vector3(zone.x + zone.w, y, zone.z + zone.d),
    new THREE.Vector3(zone.x, y, zone.z + zone.d),
  ];
}

function addZonePlanOutlines(group: THREE.Group, zones: FloorBlock[], floorY: number): void {
  const y = floorY + PLAN_LINE_LIFT + 0.006;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const stroke = zone.stroke || SCENE3D_STYLE.zoneTints[0];
    const pts = zoneOutlinePoints(zone, y);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({
      color: hex(stroke),
      dashSize: 0.28,
      gapSize: 0.18,
    });
    const loop = new THREE.LineLoop(geo, mat);
    loop.computeLineDistances();
    loop.renderOrder = 7;
    group.add(loop);
  }
}

function addObjectPlanRects(group: THREE.Group, objects: FloorBlock[], floorY: number): void {
  if (objects.length === 0) return;
  const y = floorY + PLAN_LINE_LIFT;
  const mat = new THREE.LineBasicMaterial({ color: hex('#b8b4ac') });
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const pts = [
      new THREE.Vector3(o.x, y, o.z),
      new THREE.Vector3(o.x + o.w, y, o.z),
      new THREE.Vector3(o.x + o.w, y, o.z + o.d),
      new THREE.Vector3(o.x, y, o.z + o.d),
    ];
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat);
    loop.renderOrder = 5;
    group.add(loop);
  }
}

function addFloorPlanDrawings(
  group: THREE.Group,
  map: Floor2DMap,
  zones: FloorBlock[],
  objects: FloorBlock[],
  floorY: number,
): void {
  addWallPlanLines(group, map.walls, floorY);
  addStorePlanRects(group, map.stores, floorY);
  addZonePlanOutlines(group, zones, floorY);
  addObjectPlanRects(group, objects, floorY);
}

function roomFillColor(): THREE.Color {
  return hex(SCENE3D_STYLE.room);
}

/** Room fills from auto-detected stores — single interior tone. */
function addStoreFloorFills(
  group: THREE.Group,
  stores: FloorBlock[],
  floorY: number,
  _floorIndex = 0,
): void {
  const tint = roomFillColor();
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    const mat = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.96,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.05, s.w - 0.04), 0.022, Math.max(0.05, s.d - 0.04)),
      mat,
    );
    mesh.position.set(s.x + s.w / 2, floorY + 0.032, s.z + s.d / 2);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function addFloorPlate(
  group: THREE.Group,
  map: Floor2DMap,
  floorY: number,
  multi = false,
  floorIndex = 0,
): void {
  const w = map.maxX - map.minX;
  const d = map.maxZ - map.minZ;
  const cx = (map.minX + map.maxX) / 2;
  const cz = (map.minZ + map.maxZ) / 2;

  const planeGeo = new THREE.PlaneGeometry(w, d);
  planeGeo.rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(
    planeGeo,
    new THREE.MeshStandardMaterial({
      color: hex(multi ? floorCorridorColor(floorIndex) : SCENE3D_STYLE.floor),
      roughness: 0.98,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
  top.position.set(cx, floorY + 0.002, cz);
  group.add(top);
}

/** Soft drop shadow under a floating floor slab (no shadow maps). */
function addFloorSlabShadow(group: THREE.Group, map: Floor2DMap, floorY: number): void {
  const w = map.maxX - map.minX;
  const d = map.maxZ - map.minZ;
  const cx = (map.minX + map.maxX) / 2;
  const cz = (map.minZ + map.maxZ) / 2;
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.03, d * 1.03),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(cx + 0.18, floorY - 0.05, cz + 0.14);
  group.add(shadow);
}

function addBaseFloor(group: THREE.Group, map: Floor2DMap, floorY: number): void {
  addFloorPlate(group, map, floorY, false);
}

function makeFloorLabelSprite(label: string): THREE.Sprite {
  const text = (label.trim() || 'Floor').slice(0, 24);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 20;
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText(text).width;
  const w = Math.ceil(textW + 24);
  const h = 36;
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(4, 4, w - 8, h - 8);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.strokeRect(4.5, 4.5, w - 9, h - 9);
  ctx.fillStyle = '#1e293b';
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w * 0.0065, h * 0.0065, 1);
  return sprite;
}

function zoneTint(zone: FloorBlock, index: number): THREE.Color {
  if (zone.fill && zone.fill !== 'transparent') return hex(zone.fill);
  if (zone.stroke) return hex(usZoneColorFromLabel(zone.label, index));
  return hex(usZoneColorFromLabel(zone.label, index));
}

function addZoneFill(group: THREE.Group, zone: FloorBlock, floorY: number, tint: THREE.Color): void {
  const y = floorY + 0.035;
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.98,
    metalness: 0,
    transparent: true,
    opacity: 0.88,
    depthWrite: true,
  });
  if (isPolygonZone(zone) && zone.points && zone.points.length >= 3) {
    const shape = new THREE.Shape();
    shape.moveTo(zone.points[0].x, zone.points[0].z);
    for (let i = 1; i < zone.points.length; i++) shape.lineTo(zone.points[i].x, zone.points[i].z);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    group.add(mesh);
    return;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(zone.w, 0.01, zone.d), mat);
  mesh.position.set(zone.x + zone.w / 2, y, zone.z + zone.d / 2);
  group.add(mesh);
}

function makeZoneLabelSprite(label: string, tint: THREE.Color): THREE.Sprite {
  const text = label.trim() || 'Zone';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const padX = 18;
  const fontSize = 22;
  ctx.font = '600 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
  const textW = ctx.measureText(text).width;
  const iconR = 16;
  const w = Math.ceil(Math.max(textW + padX * 2, 120));
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = 22;
  ctx.fillStyle = '#' + tint.getHexString();
  ctx.beginPath();
  ctx.arc(cx, cy, iconR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = SCENE3D_STYLE.zoneLabel;
  ctx.font = '600 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(text, cx, 44);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.55;
  sprite.scale.set(w * scale * 0.01, h * scale * 0.01, 1);
  return sprite;
}

function makePoiLabelSprite(name: string, color: string, highlight: boolean): THREE.Sprite {
  const text = (name.trim() || 'POI').slice(0, 28);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = highlight ? 20 : 18;
  ctx.font = '600 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
  const textW = ctx.measureText(text).width;
  const iconR = highlight ? 14 : 11;
  const w = Math.ceil(Math.max(textW + 28, 96));
  const h = 64;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, 18, iconR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = SCENE3D_STYLE.poiLabel;
  ctx.font = '600 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(text, cx, 36);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = highlight ? 0.52 : 0.46;
  sprite.scale.set(w * scale * 0.01, h * scale * 0.01, 1);
  return sprite;
}

function addZoneLabelsAndFills(group: THREE.Group, zones: FloorBlock[], floorY: number): void {
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (!zone.label?.trim()) continue;
    const c = zoneCentroid(zone);
    const sprite = makeZoneLabelSprite(zone.label, hex(SCENE3D_STYLE.zoneLabel));
    sprite.position.set(c.x, floorY + 0.82 + (i % 2) * 0.1, c.z);
    group.add(sprite);
  }
}

function addWalkCorridorTint(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
  floorIndex = 0,
): void {
  const enclosed = markEnclosedVoidCells(map, walk);
  const cell = map.cellSize;
  const geo = new THREE.BoxGeometry(cell * 0.99, 0.012, cell * 0.99);
  let corridorCount = 0;
  let roomCount = 0;
  for (let i = 0; i < walk.length; i++) {
    if (walk[i]) corridorCount++;
    else if (enclosed[i]) roomCount++;
  }
  const addTiles = (count: number, color: string) => {
    if (!count) return;
    const mat = new THREE.MeshStandardMaterial({
      color: hex(color),
      roughness: 0.98,
      metalness: 0,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    let idx = 0;
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const i = r * map.cols + c;
        const isCorridor = !!walk[i];
        const isRoom = !walk[i] && !!enclosed[i];
        if ((color === SCENE3D_STYLE.corridor && !isCorridor) || (color === SCENE3D_STYLE.room && !isRoom)) {
          continue;
        }
        m.makeTranslation(map.minX + (c + 0.5) * cell, floorY + 0.018, map.minZ + (r + 0.5) * cell);
        inst.setMatrixAt(idx++, m);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  };
  addTiles(corridorCount, floorCorridorColor(floorIndex));
  addTiles(roomCount, SCENE3D_STYLE.room);
}

function addObjectBlocks(group: THREE.Group, objects: FloorBlock[], floorY: number): void {
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const h = 0.75;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(o.w, h, o.d),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }),
    );
    mesh.position.set(o.x + o.w / 2, floorY + h / 2, o.z + o.d / 2);
    mesh.castShadow = true;
    group.add(mesh);
  }
}

type Floor2DScene3dFloorLayer = {
  floorId: string;
  label: string;
  floorY: number;
  map: Floor2DMap;
  walk: Uint8Array;
  objects: FloorBlock[];
  zones: FloorBlock[];
  path: { x: number; z: number }[];
  debugPaths?: { color: string; path: { x: number; z: number }[] }[];
  breakPoints?: { x: number; z: number; label: string }[];
  pois?: NavMapPoi[];
};

type Floor2DScene3dSync = {
  map: Floor2DMap;
  multiFloor?: boolean;
  floors?: Floor2DScene3dFloorLayer[];
  connectors?: FloorRouteConnector[];
  floorLevels?: { floorY: number }[];
  walk: Uint8Array;
  objects: FloorBlock[];
  zones: FloorBlock[];
  path: { x: number; z: number }[];
  pois: NavMapPoi[];
  originId: string;
  destId: string;
  verticalPlateStack?: boolean;
  showWalls?: boolean;
  showInteriorVolumes?: boolean;
  showObjects?: boolean;
  /** Active floor index for single-floor 3D corridor tint. */
  floorIndex?: number;
};

type FloorDisplayLayer = Floor2DScene3dFloorLayer & {
  displayY: number;
};

class Floor2DScene3d {
  readonly domElement: HTMLCanvasElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly content: THREE.Group;
  private raf = 0;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.domElement = document.createElement('canvas');
    this.domElement.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none;z-index:2;';
    parent.appendChild(this.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = hex(SCENE3D_STYLE.sceneBg);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.domElement, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = false;

    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 600;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.12;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(20, 40, 24);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xd8e4ff, 0.28);
    fill.position.set(-16, 22, -20);
    this.scene.add(fill);

    this.content = new THREE.Group();
    this.scene.add(this.content);

    this.tick();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.domElement.style.display = on ? 'block' : 'none';
    if (on) this.controls.update();
  }

  isVisible(): boolean {
    return this.visible;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  sync(data: Floor2DScene3dSync, refitCamera = false): void {
    disposeObject3D(this.content);
    this.content.clear();

    if (data.multiFloor && data.floors && data.floors.length > 0) {
      this.syncMultiFloor(data, refitCamera);
      return;
    }

    const map = data.map;
    const walk = data.walk;
    const floorY = map.sliceY;
    const floorIndex = data.floorIndex ?? 0;
    addWalkCorridorTint(this.content, map, walk, floorY, floorIndex);
    const stores = map.stores ?? [];
    if (stores.length > 0) {
      addStoreFloorFills(this.content, stores, floorY, floorIndex);
    }
    addEnclosedInteriorVolumes(this.content, map, walk, floorY, INTERIOR_BLOCK_HEIGHT, INTERIOR_WALL_HEIGHT, data.zones);
    addZoneLabelsAndFills(this.content, data.zones, floorY);
    this.addRoutePath(data.path, floorY);
    addObjectBlocks(this.content, data.objects, floorY);
    addWallMeshes(this.content, map.walls, map, walk, floorY);
    this.addPois(data.pois, data.originId, data.destId, floorY);
    if (refitCamera) this.fitCamera(map);
  }

  private syncMultiFloor(data: Floor2DScene3dSync, refitCamera: boolean): void {
    const floorLevels = data.floorLevels ?? data.floors!.map((f) => ({ floorY: f.floorY }));
    const sorted = [...data.floors!].sort((a, b) => a.floorY - b.floorY);
    const verticalStack = data.verticalPlateStack ?? false;
    const showWalls = data.showWalls ?? !verticalStack;
    const showInterior = data.showInteriorVolumes ?? showWalls;
    const showObjects = data.showObjects ?? showWalls;
    const map = data.map;

    const displayLayers: FloorDisplayLayer[] = sorted.map((layer, i) => ({
      ...layer,
      displayY: verticalStack ? i * STACK_PLATE_STEP : layer.floorY,
    }));

    for (let li = 0; li < displayLayers.length; li++) {
      const layer = displayLayers[li];
      const plate = new THREE.Group();
      const walk = layer.walk;
      const floorMap = layer.map;
      const y = layer.displayY;
      const walkForMesh =
        walk.length === floorMap.cols * floorMap.rows
          ? walk
          : new Uint8Array(floorMap.cols * floorMap.rows);

      if (walk.length > 0) {
        addWalkCorridorTint(plate, floorMap, walk, y, li);
      }
      const stores = floorMap.stores ?? [];
      if (stores.length > 0) {
        addStoreFloorFills(plate, stores, y, li);
      }
      if (showInterior && walk.length > 0) {
        addEnclosedInteriorVolumes(
          plate,
          floorMap,
          walk,
          y,
          verticalStack ? STACK_INTERIOR_BLOCK_HEIGHT : INTERIOR_BLOCK_HEIGHT,
          verticalStack ? STACK_INTERIOR_WALL_HEIGHT : INTERIOR_WALL_HEIGHT,
          layer.zones,
        );
      }
      addZoneLabelsAndFills(plate, layer.zones, y);
      const debugPaths = layer.debugPaths ?? [];
      for (let di = 0; di < debugPaths.length; di++) {
        const probe = debugPaths[di];
        if (probe.path.length >= 2) {
          this.addRoutePath(probe.path, y, probe.color, ROUTE_RADIUS * 0.55, 0.65, plate);
        }
      }
      this.addRoutePath(layer.path, y, SCENE3D_STYLE.route, ROUTE_RADIUS, 1, plate);
      if (showObjects) addObjectBlocks(plate, layer.objects, y);
      if (showWalls) {
        addWallMeshes(plate, floorMap.walls, floorMap, walkForMesh, y, verticalStack);
      } else if (verticalStack) {
        addFloorPlanDrawings(plate, floorMap, layer.zones, layer.objects, y);
      }
      this.addBreakPoints(layer.breakPoints ?? [], y, plate);

      const floorPois =
        layer.pois ??
        data.pois.filter(
          (p) => Math.abs(nearestFloorYForPoi(p.y, floorLevels) - layer.floorY) < 0.25,
        );
      this.addPois(floorPois, data.originId, data.destId, y, plate);

      const label = makeFloorLabelSprite(layer.label);
      label.position.set(map.minX + 1.2, y + 1.1, map.minZ + 1.2);
      plate.add(label);

      this.content.add(plate);
    }

    const connectors = data.connectors ?? [];
    for (let ci = 0; ci < connectors.length; ci++) {
      this.addGapRoute(connectors[ci], displayLayers);
    }

    if (verticalStack) {
      this.controls.minPolarAngle = 0.1;
      this.controls.maxPolarAngle = Math.PI - 0.1;
    } else {
      this.controls.minPolarAngle = 0.35;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.12;
    }

    if (refitCamera) this.fitCameraMulti(data.map, displayLayers, verticalStack);
  }

  private addRouteSegments(
    points: THREE.Vector3[],
    radius = ROUTE_RADIUS,
    parent: THREE.Object3D = this.content,
    color: string = SCENE3D_STYLE.route,
    opacity = 1,
  ): void {
    if (points.length < 2) return;
    const up = new THREE.Vector3(0, 1, 0);
    const routeMat = new THREE.MeshBasicMaterial({
      color: hex(color),
      transparent: opacity < 1,
      opacity,
      depthTest: true,
      depthWrite: true,
    });

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const delta = b.clone().sub(a);
      const len = delta.length();
      if (len < 1e-5) continue;

      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = delta.normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

      const seg = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 12), routeMat);
      seg.position.copy(mid);
      seg.quaternion.copy(quat);
      seg.renderOrder = 3;
      parent.add(seg);
    }
  }

  private addRoutePath(
    path: { x: number; z: number }[],
    floorY: number,
    color: string = SCENE3D_STYLE.route,
    radius = ROUTE_RADIUS,
    opacity = 1,
    parent: THREE.Object3D = this.content,
  ): void {
    if (path.length < 2) return;
    const y = floorY + ROUTE_LIFT;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < path.length; i++) {
      points.push(new THREE.Vector3(path[i].x, y, path[i].z));
    }
    this.addRouteSegments(points, radius, parent, color, opacity);
  }

  private addBreakPoints(
    points: { x: number; z: number; label: string }[],
    floorY: number,
    parent: THREE.Object3D,
  ): void {
    if (points.length === 0) return;
    const y = floorY + ROUTE_LIFT + 0.08;
    const mat = new THREE.MeshBasicMaterial({ color: 0xdc2626 });
    for (let i = 0; i < points.length; i++) {
      const bp = points[i];
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), mat);
      mesh.position.set(bp.x, y, bp.z);
      mesh.renderOrder = 14;
      parent.add(mesh);
    }
  }

  private addGapRoute(link: FloorRouteConnector, floors: FloorDisplayLayer[]): void {
    const leave = floors.find((f) => f.floorId === link.fromFloorId);
    const enter = floors.find((f) => f.floorId === link.toFloorId);
    if (!leave || !enter) return;
    const leaveY = leave.displayY;
    const enterY = enter.displayY;
    const worldSpan = enter.floorY - leave.floorY;

    const points: THREE.Vector3[] = [
      new THREE.Vector3(link.from.x, leaveY + ROUTE_LIFT, link.from.z),
    ];

    if (link.via.length >= 1) {
      for (let i = 0; i < link.via.length; i++) {
        const v = link.via[i];
        const t =
          Math.abs(worldSpan) > 1e-4
            ? Math.max(0, Math.min(1, (v.y - leave.floorY) / worldSpan))
            : 0.5;
        const y = leaveY + t * (enterY - leaveY) + ROUTE_LIFT;
        points.push(new THREE.Vector3(v.x, y, v.z));
      }
    }

    points.push(new THREE.Vector3(link.to.x, enterY + ROUTE_LIFT, link.to.z));

    const deduped: THREE.Vector3[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].distanceToSquared(deduped[deduped.length - 1]) > 1e-6) deduped.push(points[i]);
    }

    this.addRouteSegments(deduped, ROUTE_RADIUS);
  }

  private fitCameraMulti(
    map: Floor2DMap,
    floors: FloorDisplayLayer[],
    verticalStack: boolean,
  ): void {
    const cx = (map.minX + map.maxX) / 2;
    const cz = (map.minZ + map.maxZ) / 2;
    const ys = floors.map((f) => f.displayY);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const midY = (minY + maxY) / 2 + (verticalStack ? 0 : BORDER_WALL_HEIGHT * 0.2);
    const span = Math.max(map.maxX - map.minX, map.maxZ - map.minZ, 8);
    const ySpan = Math.max(
      maxY - minY + (verticalStack ? STACK_PLATE_STEP * 0.6 : BORDER_WALL_HEIGHT * 2.5),
      5,
    );
    this.controls.target.set(cx, midY, cz);
    const dist = Math.max(span * 1.05, ySpan * 1.35);
    this.camera.position.set(cx + dist * 0.82, midY + dist * 0.62, cz + dist * 0.82);
    this.controls.minDistance = 4;
    this.controls.maxDistance = Math.max(800, dist * 4);
    this.controls.update();
  }

  private addPois(
    pois: NavMapPoi[],
    originId: string,
    destId: string,
    floorY: number,
    parent: THREE.Object3D = this.content,
  ): void {
    const group = new THREE.Group();
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      const isO = p.id === originId;
      const isD = p.id === destId;
      const color = isO ? SCENE3D_STYLE.origin : isD ? SCENE3D_STYLE.destination : SCENE3D_STYLE.poi;
      const headR = isO || isD ? 0.2 : 0.15;
      const pinH = isO || isD ? 0.1 : 0.07;

      const pin = new THREE.Mesh(
        new THREE.CylinderGeometry(headR * 0.72, headR * 0.9, pinH, 16),
        new THREE.MeshStandardMaterial({ color: hex(color), roughness: 0.45 }),
      );
      pin.position.set(p.x, floorY + pinH / 2 + 0.02, p.z);
      group.add(pin);

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(headR, 16, 16),
        new THREE.MeshStandardMaterial({ color: hex(color), roughness: 0.4 }),
      );
      head.position.set(p.x, floorY + pinH + headR + 0.02, p.z);
      group.add(head);

      const label = makePoiLabelSprite(p.name, color, isO || isD);
      label.position.set(p.x, floorY + pinH + headR * 2 + 0.28, p.z);
      group.add(label);
    }
    parent.add(group);
  }

  private fitCamera(map: Floor2DMap): void {
    const cx = (map.minX + map.maxX) / 2;
    const cz = (map.minZ + map.maxZ) / 2;
    const span = Math.max(map.maxX - map.minX, map.maxZ - map.minZ, 8);
    const cy = map.sliceY + BORDER_WALL_HEIGHT * 0.25;
    this.controls.target.set(cx, cy, cz);
    const dist = span * 1.05;
    this.camera.position.set(cx + dist * 0.78, map.sliceY + dist * 0.68, cz + dist * 0.78);
    this.controls.update();
  }

  /** Frame the orbit camera on a navigation path so the full route fits the viewport. */
  fitCameraToPath(points: { x: number; y: number; z: number }[], stacked = false): void {
    if (points.length < 2) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2 + BORDER_WALL_HEIGHT * 0.12;
    const cz = (minZ + maxZ) / 2;
    const spanX = Math.max(maxX - minX, 3);
    const spanZ = Math.max(maxZ - minZ, 3);
    const spanY = Math.max(maxY - minY, stacked ? STACK_PLATE_STEP * 0.35 : 1.2);
    const span = Math.max(spanX, spanZ, 4);
    this.controls.target.set(cx, cy, cz);
    const dist = Math.max(span * 1.12, spanY * (stacked ? 1.45 : 1.65));
    this.camera.position.set(cx + dist * 0.78, cy + dist * 0.62, cz + dist * 0.78);
    this.controls.minDistance = 3;
    this.controls.maxDistance = Math.max(800, dist * 5);
    this.controls.update();
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.visible) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    disposeObject3D(this.content);
    this.renderer.dispose();
    this.domElement.remove();
  }
}
// ═══════════════════════════════════════════════════════════════════════════
// VIEW-ONLY 2D CANVAS
// ═══════════════════════════════════════════════════════════════════════════

class ViewOnly2DMap {
  readonly canvas: HTMLCanvasElement;
  private readonly mapWrap: HTMLElement;
  private map: Floor2DMap | null = null;
  private walk: Uint8Array | null = null;
  private objects: FloorBlock[] = [];
  private zones: FloorBlock[] = [];
  private floors: FloorLevel[] = [];
  private activeFloorId: string | null = null;
  private path: { x: number; z: number }[] = [];
  private pois: NavMapPoi[] = [];
  private originId = '';
  private destId = '';
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private drag = false;
  private lx = 0;
  private ly = 0;
  private onFloorSelect?: (floorId: string) => void;
  private onFloorsChange?: () => void;
  private onIso3dChange?: (on: boolean) => void;
  private scene3d: Floor2DScene3d | null = null;
  private iso3d = false;
  private multiFloor3dAuto = false;
  private viewStack = false;
  private routeSegments: FloorRouteSegment[] = [];
  private routeConnectors: FloorRouteConnector[] = [];
  private routeBreakPoints: RouteBreakPoint[] = [];
  private routeError: string | null = null;
  private routeDebugForward: FloorRouteSegment[] = [];
  private routeDebugReverse: FloorRouteSegment[] = [];
  private floorListEl: HTMLElement | null = null;
  private floorSidebar: HTMLElement | null = null;

  constructor(mapParent: HTMLElement) {
    if (typeof getComputedStyle !== 'undefined' && getComputedStyle(mapParent).position === 'static') {
      mapParent.style.position = 'relative';
    }

    this.mapWrap = mapParent;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'floor2d-canvas';
    this.mapWrap.appendChild(this.canvas);

    this.scene3d = new Floor2DScene3d(mapParent);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = true;
      this.lx = e.clientX;
      this.ly = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.classList.add('is-dragging');
    });
    const end = () => {
      this.drag = false;
      this.canvas.classList.remove('is-dragging');
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
      this.ox += (e.clientX - this.lx) * dpr;
      this.oy += (e.clientY - this.ly) * dpr;
      this.lx = e.clientX;
      this.ly = e.clientY;
      this.draw();
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.scale = Math.max(0.2, Math.min(80, this.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
        this.draw();
      },
      { passive: false },
    );

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.mapWrap);
    }
  }

  setOnFloorSelect(fn: (floorId: string) => void): void {
    this.onFloorSelect = fn;
  }

  setOnFloorsChange(fn: () => void): void {
    this.onFloorsChange = fn;
  }

  setOnIso3dChange(fn: (on: boolean) => void): void {
    this.onIso3dChange = fn;
  }

  isIso3d(): boolean {
    return this.iso3d;
  }

  getActiveFloorId(): string | null {
    return this.activeFloorId;
  }

  isViewStack(): boolean {
    return this.viewStack;
  }

  usesStackedLayout(): boolean {
    return this.floors.length >= 2;
  }

  sortedFloors(): FloorLevel[] {
    return [...this.floors].sort((a, b) => a.floorY - b.floorY);
  }

  private scene3dWanted(): boolean {
    return this.iso3d || this.viewStack;
  }

  private usesStackedPlate3d(): boolean {
    return this.viewStack && this.usesStackedLayout();
  }

  private updateScene3dVisibility(): void {
    const show = this.scene3dWanted();
    this.scene3d?.setVisible(show);
    this.canvas.style.display = show ? 'none' : 'block';
  }

  private enableMultiFloor3dView(): void {
    if (!this.scene3d || !this.map) return;
    this.multiFloor3dAuto = true;
    this.updateScene3dVisibility();
  }

  private disableMultiFloor3dView(): void {
    if (!this.multiFloor3dAuto) return;
    this.multiFloor3dAuto = false;
    this.updateScene3dVisibility();
  }

  toggleViewStack(): boolean {
    if (!this.usesStackedLayout()) {
      this.viewStack = false;
      return false;
    }
    this.viewStack = !this.viewStack;
    if (this.viewStack) {
      this.enableMultiFloor3dView();
      this.syncScene3d(true);
    } else {
      this.disableMultiFloor3dView();
      this.fit();
      if (this.iso3d) this.syncScene3d(true);
      else this.draw();
    }
    this.refreshFloorSidebar();
    return this.viewStack;
  }

  activateViewAllFloors(): void {
    if (!this.usesStackedLayout()) return;
    if (!this.viewStack) this.toggleViewStack();
    else {
      this.syncScene3d(false);
      this.refreshFloorSidebar();
    }
  }

  poisForDisplay(source?: NavMapPoi[]): NavMapPoi[] {
    const list = source ?? this.pois;
    if (this.viewStack) return list;
    return filterPoisByFloorY(list, this.getActiveFloorY(), this.floors);
  }

  leaveViewStack(): void {
    if (!this.viewStack) return;
    this.viewStack = false;
    this.disableMultiFloor3dView();
    this.updateScene3dVisibility();
  }

  private isMultiFloorRoute(): boolean {
    if (this.routeConnectors.length > 0) return true;
    if (this.routeBreakPoints.length > 0) return true;
    return this.routeSegments.length > 1 && this.routeSegments.some((s) => s.path.length >= 2);
  }

  /** Multi-floor routes need view-all so every level + stair connectors are visible. */
  private ensureMultiFloorRouteView(): boolean {
    if (!this.usesStackedLayout() || this.viewStack) return false;
    if (!this.isMultiFloorRoute()) {
      if (!this.originId || !this.destId) return false;
      const o = this.pois.find((p) => p.id === this.originId);
      const d = this.pois.find((p) => p.id === this.destId);
      if (!o || !d) return false;
      const oFloor = floorForY(o.y, this.floors);
      const dFloor = floorForY(d.y, this.floors);
      if (!oFloor || !dFloor || oFloor.id === dFloor.id) return false;
    }
    this.viewStack = true;
    if (this.iso3d) this.enableMultiFloor3dView();
    this.updateScene3dVisibility();
    this.onFloorsChange?.();
    return true;
  }

  private pathForScene3d(floorId: string, seg: FloorRouteSegment | undefined): { x: number; z: number }[] {
    if (!seg || seg.path.length < 2) return [];
    return this.trimPathForFloor(floorId, seg.path).map((p) => ({ x: p.x, z: p.z }));
  }

  private activeFloorRoutePath(): { x: number; z: number }[] {
    if (!this.activeFloorId) return this.path;
    const seg = this.routeSegments.find((s) => s.floorId === this.activeFloorId);
    return this.pathForScene3d(this.activeFloorId, seg);
  }

  /** Toggle extruded 3D walls with orbit / tilt (drag to rotate view). */
  toggleIso3d(): boolean {
    this.iso3d = !this.iso3d;
    this.updateScene3dVisibility();
    if (this.iso3d) this.ensureMultiFloorRouteView();
    if (this.scene3dWanted()) {
      this.syncScene3d(true);
      if (this.getRoutePathPoints().length >= 2) this.fitToRoute();
    } else {
      this.draw();
    }
    this.onIso3dChange?.(this.iso3d);
    return this.iso3d;
  }

  private syncScene3d(refitCamera = false): void {
    if (!this.scene3dWanted() || !this.scene3d || !this.map) return;

    if (this.usesStackedPlate3d()) {
      const floors = this.sortedFloors();
      const layers = floors.map((floor, i) => {
        const preview = previewMapForFloor(this.map!, floor, this.floors);
        const walk = this.walkForFloorLevel(floor);
        const isActive = floor.id === this.activeFloorId;
        const seg = this.routeSegments.find((s) => s.floorId === floor.id);
        const path = this.pathForScene3d(floor.id, seg);
        const fwd = this.routeDebugForward.find((s) => s.floorId === floor.id);
        const rev = this.routeDebugReverse.find((s) => s.floorId === floor.id);
        const platePois = filterPoisByFloorY(this.pois, floor.floorY, this.floors);
        const floorBreaks = this.routeBreakPoints
          .filter((b) => b.floorId === floor.id)
          .map((b) => ({ x: b.x, z: b.z, label: b.label }));
        return {
          floorId: floor.id,
          label: floorDisplayLabel(floor, i),
          floorY: floor.floorY,
          map: preview,
          walk: walk ?? new Uint8Array(0),
          objects: floor.objects ?? (isActive ? this.objects : []),
          zones: floor.zones ?? (isActive ? this.zones : []),
          path,
          debugPaths: routeUsesManualStairMouthsEmbed(this.routeConnectors)
            ? []
            : [
                ...(fwd
                  ? [{
                      color: '#16a34a',
                      path: this.pathForScene3d(floor.id, fwd),
                    }]
                  : []),
                ...(rev
                  ? [{
                      color: '#ea580c',
                      path: this.pathForScene3d(floor.id, rev),
                    }]
                  : []),
              ],
          breakPoints: floorBreaks,
          pois: platePois,
        };
      });
      this.scene3d.sync(
        {
          multiFloor: true,
          map: this.map,
          floors: layers,
          connectors: this.routeConnectors,
          floorLevels: this.floors,
          walk: this.walk ?? new Uint8Array(0),
          objects: this.objects,
          zones: this.zones,
          path: this.path,
          pois: this.pois,
          originId: this.originId,
          destId: this.destId,
          verticalPlateStack: true,
          showWalls: true,
          showInteriorVolumes: true,
          showObjects: true,
        },
        refitCamera,
      );
      return;
    }

    if (!this.walk) return;
    const preview = this.previewMap();
    if (!preview) return;
    this.scene3d.sync(
      {
        map: preview,
        walk: this.walk,
        objects: this.objects,
        zones: this.zones,
        path: this.activeFloorRoutePath(),
        pois: this.poisForDisplay(),
        originId: this.originId,
        destId: this.destId,
        floorIndex: this.activeFloorIndex(),
      },
      refitCamera,
    );
  }

  dispose(): void {
    this.scene3d?.dispose();
    this.scene3d = null;
    this.floorSidebar?.remove();
    this.floorSidebar = null;
    this.floorListEl = null;
    this.canvas.remove();
  }

  setState(
    map: Floor2DMap,
    walk: Uint8Array,
    objects: FloorBlock[],
    zones: FloorBlock[],
    floors: FloorLevel[],
    activeFloorId: string | null,
  ): void {
    this.map = map;
    this.walk = walk;
    this.objects = objects;
    this.zones = zones;
    this.floors = floors;
    this.activeFloorId = activeFloorId;
    this.fit();
    this.refreshFloorSidebar();
    this.onFloorsChange?.();
    this.draw();
    if (this.scene3dWanted()) this.syncScene3d();
  }

  setRoutePlan(
    segments: FloorRouteSegment[],
    connectors: FloorRouteConnector[],
    error?: string,
    debug?: {
      forward?: FloorRouteSegment[];
      reverse?: FloorRouteSegment[];
      breakPoints?: RouteBreakPoint[];
    },
  ): void {
    const refit3d =
      this.routeSegments.length === 0 &&
      (segments.length > 0 || (debug?.breakPoints?.length ?? 0) > 0);
    const hasRoute = segments.some((s) => s.path.length >= 2);
    this.routeSegments = segments;
    this.routeConnectors = connectors;
    this.routeBreakPoints = debug?.breakPoints ?? [];
    this.routeDebugForward = debug?.forward ?? [];
    this.routeDebugReverse = debug?.reverse ?? [];
    this.routeError = hasRoute ? (error ?? null) : (error ?? null);
    if (segments.length === 1) {
      this.path = segments[0].path.map((p) => ({ x: p.x, z: p.z }));
    } else {
      this.path = [];
    }
    this.ensureMultiFloorRouteView();
    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      this.syncScene3d(refit3d);
      return;
    }
    if (this.scene3dWanted()) {
      this.syncScene3d(refit3d);
    }
    this.draw();
  }

  getFloorMap(): Floor2DMap | null {
    return this.map;
  }

  computeAndSetRoute(
    navMesh: NavMesh | null,
    origin: { x: number; y: number; z: number },
    destination: { x: number; y: number; z: number },
  ): { valid: boolean; error?: string } {
    if (!this.map) {
      this.setRoutePlan([], [], 'Floor map not ready');
      return { valid: false, error: 'Floor map not ready' };
    }
    let plan: MultiFloorRoutePlan;
    if (floorsHaveStairMouths(this.floors)) {
      plan = computeStairMouthRouteEmbed(
        this.map,
        this.floors,
        origin,
        destination,
        this.walk,
        this.activeFloorId,
      );
    } else {
      const floor = floorForY(origin.y, this.floors) ?? floorForY(destination.y, this.floors) ?? this.floors[0];
      if (!floor) {
        plan = { multiFloor: false, segments: [], connectors: [], error: 'No floor levels' };
      } else {
        const out = routeOnFloorGridEmbed(
          this.map,
          floor,
          this.floors,
          origin.x,
          origin.z,
          destination.x,
          destination.z,
          this.walk,
          this.activeFloorId,
        );
        if ('error' in out) {
          plan = { multiFloor: false, segments: [], connectors: [], error: out.error };
        } else {
          plan = {
            multiFloor: false,
            segments: out.path.length >= 2
              ? [{ floorId: floor.id, floorY: floor.floorY, label: floor.label, path: out.path }]
              : [],
            connectors: [],
            error: out.path.length < 2 ? 'No path on floor' : undefined,
          };
        }
      }
    }
    const mouthOnly = routeUsesManualStairMouthsEmbed(plan.connectors);
    this.setRoutePlan(plan.segments, plan.connectors, plan.error, mouthOnly
      ? undefined
      : {
          forward: plan.debugForward,
          reverse: plan.debugReverse,
          breakPoints: plan.breakPoints,
        });
    return {
      valid: plan.segments.some((s) => s.path.length >= 2),
      error: plan.error,
    };
  }

  getRoutePathPoints(): { x: number; y: number; z: number }[] {
    if (this.routeSegments.length > 0) {
      if (
        this.routeConnectors.length > 0 &&
        this.floors.length >= 2 &&
        this.originId &&
        this.destId
      ) {
        const sliceY = this.getActiveFloorY();
        const o = this.resolveEndpoint(this.originId, sliceY);
        const d = this.resolveEndpoint(this.destId, sliceY);
        if (o && d) {
          const oFloor = floorForY(o.y, this.floors);
          const dFloor = floorForY(d.y, this.floors);
          if (oFloor && dFloor) {
            const wp = planToWaypoints(
              this.routeSegments,
              this.routeConnectors,
              this.floors,
              oFloor.id,
              dFloor.id,
            );
            if (wp.length >= 2) return wp;
          }
        }
      }
      const out: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < this.routeSegments.length; i++) {
        const seg = this.routeSegments[i];
        for (let j = 0; j < seg.path.length; j++) out.push(seg.path[j]);
      }
      return out;
    }
    const floorY = this.getActiveFloorY();
    return this.path.map((p) => ({ x: p.x, y: floorY, z: p.z }));
  }

  setPath(pts: { x: number; y: number; z: number }[]): void {
    this.routeSegments = [];
    this.routeConnectors = [];
    this.routeError = null;
    this.routeDebugForward = [];
    this.routeDebugReverse = [];
    this.routeBreakPoints = [];
    this.path = pts.map((p) => ({ x: p.x, z: p.z }));
    this.draw();
    if (this.scene3dWanted()) this.syncScene3d();
  }

  setPois(pois: NavMapPoi[], originId: string, destId: string): void {
    this.pois = pois;
    this.originId = originId;
    this.destId = destId;
    this.draw();
    if (this.scene3dWanted()) this.syncScene3d();
  }

  private poisForActiveFloor(): NavMapPoi[] {
    return filterPoisByFloorY(this.pois, this.getActiveFloorY(), this.floors);
  }

  getActiveFloorY(): number {
    for (let i = 0; i < this.floors.length; i++) {
      if (this.floors[i].id === this.activeFloorId) return this.floors[i].floorY;
    }
    return this.map?.sliceY ?? 0;
  }

  private activeFloorIndex(): number {
    for (let i = 0; i < this.floors.length; i++) {
      if (this.floors[i].id === this.activeFloorId) return i;
    }
    return 0;
  }

  computeRoute(
    sx: number,
    sz: number,
    ex: number,
    ez: number,
  ): { path: { x: number; y: number; z: number }[] } | { error: string } {
    if (!this.map || !this.walk) return { error: 'Map not ready' };
    return findPathOnFloor(this.map, this.walk, this.objects, sx, sz, ex, ez, this.getActiveFloorY());
  }

  resolveEndpoint(
    id: string,
    sliceY: number,
  ): { x: number; y: number; z: number; name: string } | null {
    if (id.indexOf(FLOOR_ROUTE_PREFIX) === 0) {
      const fid = id.slice(FLOOR_ROUTE_PREFIX.length);
      let f: FloorLevel | null = null;
      for (let i = 0; i < this.floors.length; i++) {
        if (this.floors[i].id === fid) {
          f = this.floors[i];
          break;
        }
      }
      if (!f || !this.map) return null;
      return {
        x: (this.map.minX + this.map.maxX) * 0.5,
        y: f.floorY,
        z: (this.map.minZ + this.map.maxZ) * 0.5,
        name: f.label,
      };
    }
    if (id.indexOf(ZONE_ROUTE_PREFIX) === 0) {
      const zid = id.slice(ZONE_ROUTE_PREFIX.length);
      for (let i = 0; i < this.zones.length; i++) {
        const z = this.zones[i];
        if (z.id === zid) {
          const c = zoneCentroid(z);
          return { x: c.x, y: sliceY, z: c.z, name: z.label || 'Zone' };
        }
      }
      return null;
    }
    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      if (p.id === id) return { x: p.x, y: p.y, z: p.z, name: p.name };
    }
    return null;
  }

  private wx(x: number): number {
    return x * this.scale + this.ox;
  }
  private wz(z: number): number {
    return z * this.scale + this.oy;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.mapWrap.clientWidth);
    const h = Math.max(1, this.mapWrap.clientHeight);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.scene3d?.resize(w, h);
    this.draw();
  }

  fit(): void {
    if (!this.map) return;
    if (this.usesStackedPlate3d()) return;
    if (this.usesStackedLayout() && this.viewStack) {
      this.fitStackedView();
      return;
    }
    const p = this.mapWrap;
    if (!p) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, p.clientWidth) * dpr;
    const h = Math.max(1, p.clientHeight) * dpr;
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    this.scale = Math.min((w * 0.9) / mapW, (h * 0.9) / mapH);
    this.ox = (w - mapW * this.scale) / 2 - this.map.minX * this.scale;
    this.oy = (h - mapH * this.scale) / 2 - this.map.minZ * this.scale;
  }

  /** Zoom/pan the 2D canvas or 3D camera so the active route fills the viewport. */
  fitToRoute(): void {
    const pts = this.getRoutePathPoints();
    if (pts.length < 2) return;

    if (this.iso3d && this.scene3d) {
      const stacked = this.usesStackedPlate3d();
      const fitPts = stacked ? this.routePointsForStacked3d(pts) : pts;
      this.scene3d.fitCameraToPath(fitPts, stacked);
      return;
    }

    if (this.usesStackedLayout() && this.viewStack) {
      this.fitStackedView();
      this.draw();
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const bboxW = Math.max(maxX - minX, 2);
    const bboxH = Math.max(maxZ - minZ, 2);
    const pad = 0.18;
    const paddedW = bboxW * (1 + pad * 2);
    const paddedH = bboxH * (1 + pad * 2);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.mapWrap.clientWidth) * dpr;
    const h = Math.max(1, this.mapWrap.clientHeight) * dpr;
    this.scale = Math.min((w * 0.88) / paddedW, (h * 0.88) / paddedH);
    this.ox = w / 2 - cx * this.scale;
    this.oy = h / 2 - cz * this.scale;
    this.draw();
  }

  private routePointsForStacked3d(pts: { x: number; y: number; z: number }[]): {
    x: number;
    y: number;
    z: number;
  }[] {
    const floors = this.sortedFloors();
    const out: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let fi = 0; fi < floors.length; fi++) {
        const d = Math.abs(floors[fi].floorY - p.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = fi;
        }
      }
      out.push({ x: p.x, y: bestIdx * STACK_PLATE_STEP, z: p.z });
    }
    return out;
  }

  private fitStackedView(): void {
    if (!this.map) return;
    const p = this.mapWrap;
    if (!p) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, p.clientWidth);
    const h = Math.max(1, p.clientHeight);
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    const layerCount = this.floors.length;
    const gapPx = this.stackGapPx(dpr);
    const pad = this.platePadPx(dpr);
    const thickness = this.plateThicknessPx(dpr);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    const scaleW = ((w * 0.86) / mapW) * dpr;
    const plateHAtScaleW = mapH * scaleW + pad * 2 + thickness;
    const totalHAtScaleW = plateHAtScaleW * layerCount + gapPx * Math.max(0, layerCount - 1);
    const scaleH = ((h * 0.86) / totalHAtScaleW) * dpr;
    this.scale = Math.min(scaleW, scaleH);
    const plateH = mapH * this.scale + pad * 2 + thickness;
    const contentH = plateH * layerCount + gapPx * Math.max(0, layerCount - 1);
    this.ox = (this.canvas.width - mapW * this.scale) / 2 - this.map.minX * this.scale;
    this.oy = (this.canvas.height - contentH) / 2 - this.map.minZ * this.scale;
  }

  private stackGapPx(dpr: number): number {
    return 48 * dpr;
  }

  private plateThicknessPx(dpr: number): number {
    return 2 * dpr;
  }

  private platePadPx(dpr: number): number {
    return 8 * dpr;
  }

  private stackLayerDy(layerIndex: number, mapH: number, gapPx: number, dpr: number): number {
    const pad = this.platePadPx(dpr);
    const plateThickness = this.plateThicknessPx(dpr);
    const plateH = mapH * this.scale + pad * 2 + plateThickness;
    return -layerIndex * (plateH + gapPx);
  }

  private plateBounds(
    layerIndex: number,
    mapH: number,
    gapPx: number,
    dpr: number,
  ): { x0: number; y0: number; x1: number; y1: number; dy: number; thickness: number } {
    const pad = this.platePadPx(dpr);
    const thickness = this.plateThicknessPx(dpr);
    const dy = this.stackLayerDy(layerIndex, mapH, gapPx, dpr);
    const x0 = this.wx(this.map!.minX) - pad;
    const y0 = this.wz(this.map!.minZ) - pad;
    const cardW = (this.map!.maxX - this.map!.minX) * this.scale + pad * 2;
    const cardH = mapH * this.scale + pad * 2;
    return { x0, y0, x1: x0 + cardW, y1: y0 + cardH, dy, thickness };
  }

  private walkForFloorLevel(floor: FloorLevel): Uint8Array | null {
    if (!this.map) return null;
    if (floor.id === this.activeFloorId && this.walk) return this.walk;
    const floorMap = routingMapForFloor(this.map, floor);
    const fromGrid = resolveFloorWalkGridEmbed(floorMap, floor, this.walk, this.activeFloorId);
    if (fromGrid) return fromGrid;
    const saved = getFloorWalkGrid(this.map, floor);
    if (saved) return saved;
    if (floor.walkGrid?.length === floorMap.cols * floorMap.rows) {
      return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
    }
    return null;
  }

  private trimPathForFloor(floorId: string, path: FloorPathPoint[]): FloorPathPoint[] {
    return trimPathForFloorPlate(floorId, path, this.routeConnectors);
  }

  private buildFloorSidebar(mapParent: HTMLElement): void {
    const layout = mapParent.parentElement;
    if (!layout) return;
    layout.classList.add('floor2d-layout');

    const sidebar = document.createElement('aside');
    sidebar.className = 'floor2d-zone-sidebar';

    const floorHeader = document.createElement('div');
    floorHeader.className = 'floor2d-zone-sidebar__header';
    floorHeader.textContent = 'Floors';

    const floorHint = document.createElement('div');
    floorHint.className = 'floor2d-zone-sidebar__hint';
    floorHint.textContent = 'Click a floor for its plan — View all floors for the 3D stack';

    const floorList = document.createElement('div');
    floorList.className = 'floor2d-zone-list floor2d-floor-list';

    sidebar.append(floorHeader, floorHint, floorList);
    layout.insertBefore(sidebar, mapParent);

    this.floorSidebar = sidebar;
    this.floorListEl = floorList;
  }

  private refreshFloorSidebar(): void {
    return;
  }

  private drawShape(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    shape: FloorShape,
    fill: string,
    stroke: string,
    lineW: number,
    dashed: boolean,
    points?: FloorPoint[],
  ): void {
    ctx.save();
    ctx.lineWidth = lineW;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([6, 4]);
    if (shape === 'polygon' && points && points.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(this.wx(points[0].x), this.wz(points[0].z));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(this.wx(points[i].x), this.wz(points[i].z));
      }
      ctx.closePath();
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
    } else if (shape === 'circle') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, rx), 0, Math.PI * 2);
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
    } else {
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
      }
      const inset = lineW * 0.5;
      ctx.strokeRect(x + inset, y + inset, Math.max(1, w - lineW), Math.max(1, h - lineW));
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawZoneFill(ctx: CanvasRenderingContext2D, zone: FloorBlock, fill: string): void {
    ctx.save();
    ctx.fillStyle = fill;
    if (isPolygonZone(zone) && zone.points) {
      ctx.beginPath();
      for (let i = 0; i < zone.points.length; i++) {
        const p = zone.points[i];
        const sx = this.wx(p.x);
        const sy = this.wz(p.z);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.fill();
    } else if (zone.shape === 'circle') {
      const x = this.wx(zone.x);
      const y = this.wz(zone.z);
      const w = zone.w * this.scale;
      const h = zone.d * this.scale;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, Math.max(1, w / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(this.wx(zone.x), this.wz(zone.z), zone.w * this.scale, zone.d * this.scale);
    }
    ctx.restore();
  }

  private drawZoneOutline(
    ctx: CanvasRenderingContext2D,
    zone: FloorBlock,
    stroke: string,
    lineW: number,
    dpr: number,
  ): void {
    ctx.save();
    ctx.lineWidth = lineW;
    ctx.strokeStyle = stroke;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    if (isPolygonZone(zone) && zone.points) {
      ctx.beginPath();
      for (let i = 0; i < zone.points.length; i++) {
        const p = zone.points[i];
        const sx = this.wx(p.x);
        const sy = this.wz(p.z);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      const x = this.wx(zone.x);
      const y = this.wz(zone.z);
      const w = zone.w * this.scale;
      const h = zone.d * this.scale;
      this.drawShape(
        ctx,
        x,
        y,
        w,
        h,
        zone.shape || 'rectangle',
        'transparent',
        stroke,
        lineW,
        true,
        zone.points,
      );
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawZoneLabel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    dpr: number,
    color: string = FLOOR2D_STYLE.zoneLabel,
  ): void {
    if (!label) return;
    const fontSize = Math.max(9, 11 * dpr);
    ctx.font = '700 ' + fontSize + 'px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3 * dpr, y + 3 * dpr, Math.max(1, w - 6 * dpr), Math.max(1, h - 6 * dpr));
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillText(truncateLabel(label, 28), cx, cy);
    ctx.restore();
  }

  private previewMap(): Floor2DMap | null {
    if (!this.map || !this.walk) return null;
    return applyWalkGridEdits(this.map, this.walk, this.objects, this.zones, this.floors);
  }

  private drawEnclosedRooms(ctx: CanvasRenderingContext2D, m: Floor2DMap, walk: Uint8Array): void {
    const enclosed = markEnclosedVoidCells(m, walk);
    const cellPx = m.cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.interiorFill;
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        const i = r * m.cols + c;
        if (!enclosed[i] || walk[i]) continue;
        const x = m.minX + c * m.cellSize;
        const z = m.minZ + r * m.cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx + 0.5, cellPx + 0.5);
      }
    }
  }

  private drawWalkGrid(ctx: CanvasRenderingContext2D): void {
    if (!this.map || !this.walk) return;
    const m = this.map;
    const cellPx = m.cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        if (!this.walk[r * m.cols + c]) continue;
        const x = m.minX + c * m.cellSize;
        const z = m.minZ + r * m.cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx + 0.5, cellPx + 0.5);
      }
    }
  }

  private drawStores(ctx: CanvasRenderingContext2D, m: Floor2DMap, dpr: number): void {
    const lineW = Math.max(0.75, 0.85 * dpr);
    ctx.lineWidth = lineW;
    ctx.strokeStyle = FLOOR2D_STYLE.interiorWall;
    ctx.globalAlpha = 1;
    for (let i = 0; i < m.stores.length; i++) {
      const b = m.stores[i];
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      ctx.fillStyle = FLOOR2D_STYLE.interiorFill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + lineW * 0.5, y + lineW * 0.5, Math.max(1, w - lineW), Math.max(1, h - lineW));
      const roomLabel = zoneDisplayLabel(b, this.poisForActiveFloor());
      if (roomLabel) {
        ctx.save();
        ctx.globalAlpha = FLOOR2D_STYLE.poiLabelOpacity;
        this.drawZoneLabel(ctx, x, y, w, h, roomLabel, dpr, FLOOR2D_STYLE.poiLabel);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawWalls(ctx: CanvasRenderingContext2D, m: Floor2DMap, dpr: number, walk?: Uint8Array | null): void {
    const grid = walk ?? this.walk;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    for (let i = 0; i < m.walls.length; i++) {
      const seg = m.walls[i];
      const border = grid ? isBorderWallSegment(seg, m, grid) : true;
      ctx.strokeStyle = border ? FLOOR2D_STYLE.borderWall : FLOOR2D_STYLE.interiorWall;
      ctx.lineWidth = border ? Math.max(2.2, 2.5 * dpr) : Math.max(0.9, 1 * dpr);
      ctx.beginPath();
      ctx.moveTo(this.wx(seg.x1), this.wz(seg.z1));
      ctx.lineTo(this.wx(seg.x2), this.wz(seg.z2));
      ctx.stroke();
    }
  }

  private drawRouteOnPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: FloorPathPoint[] | { x: number; z: number }[],
    color: string = FLOOR2D_STYLE.route,
    dashed = false,
    lineWidth?: number,
  ): void {
    if (path.length < 2) return;
    const lw = lineWidth ?? Math.max(7, 8 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.wx(path[0].x), this.wz(path[0].z));
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(this.wx(path[i].x), this.wz(path[i].z));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    if (dashed) ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  private drawRouteScreenPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    points: { x: number; y: number }[],
    stroke: string = FLOOR2D_STYLE.route,
  ): void {
    if (points.length < 2) return;
    const lw = Math.max(7, 8 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  private drawStepTicksInGap(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: { x: number; y: number }[],
    gapTop: number,
    gapBottom: number,
  ): void {
    const inGap = path.filter((p) => p.y >= gapTop - 1 && p.y <= gapBottom + 1);
    if (inGap.length < 2) return;
    const minY = Math.min(...inGap.map((p) => p.y));
    const maxY = Math.max(...inGap.map((p) => p.y));
    const cx = inGap.reduce((sum, p) => sum + p.x, 0) / inGap.length;
    const steps = 5;
    ctx.strokeStyle = 'rgba(37,99,235,0.4)';
    ctx.lineWidth = Math.max(1.25, 1.5 * dpr);
    for (let s = 1; s < steps; s++) {
      const y = minY + (s / steps) * (maxY - minY);
      ctx.beginPath();
      ctx.moveTo(cx - 14 * dpr, y);
      ctx.lineTo(cx + 14 * dpr, y);
      ctx.stroke();
    }
  }

  private drawGapStairRoutes(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
  ): void {
    if (this.routeConnectors.length === 0) return;
    for (let li = 0; li < this.routeConnectors.length; li++) {
      const link = this.routeConnectors[li];
      const leaveIdx = floors.findIndex((f) => f.id === link.fromFloorId);
      const enterIdx = floors.findIndex((f) => f.id === link.toFloorId);
      if (leaveIdx < 0 || enterIdx < 0) continue;

      const leaveBounds = this.plateBounds(leaveIdx, mapH, gapPx, dpr);
      const enterBounds = this.plateBounds(enterIdx, mapH, gapPx, dpr);
      const goingUp = leaveIdx < enterIdx;
      const lowerBounds = goingUp ? leaveBounds : enterBounds;
      const upperBounds = goingUp ? enterBounds : leaveBounds;
      const lowerFloor = floors[goingUp ? leaveIdx : enterIdx];
      const upperFloor = floors[goingUp ? enterIdx : leaveIdx];

      const gapTop = upperBounds.y1 + upperBounds.dy;
      const gapBottom = lowerBounds.y0 + lowerBounds.dy;

      const exitSx = this.wx(link.from.x);
      const exitSy = this.wz(link.from.z) + leaveBounds.dy;
      const enterSx = this.wx(link.to.x);
      const enterSy = this.wz(link.to.z) + enterBounds.dy;

      const screenPts: { x: number; y: number }[] = [{ x: exitSx, y: exitSy }];

      if (goingUp) {
        screenPts.push({ x: exitSx, y: lowerBounds.y0 + lowerBounds.dy });
        const ySpan = upperFloor.floorY - lowerFloor.floorY;
        if (link.via.length >= 1 && Math.abs(ySpan) > 1e-4) {
          for (let vi = 0; vi < link.via.length; vi++) {
            const v = link.via[vi];
            const t = Math.max(0, Math.min(1, (v.y - lowerFloor.floorY) / ySpan));
            screenPts.push({ x: this.wx(v.x), y: gapBottom + t * (gapTop - gapBottom) });
          }
        }
        screenPts.push({ x: enterSx, y: upperBounds.y1 + upperBounds.dy });
      } else {
        screenPts.push({ x: exitSx, y: upperBounds.y1 + upperBounds.dy });
        const ySpan = lowerFloor.floorY - upperFloor.floorY;
        if (link.via.length >= 1 && Math.abs(ySpan) > 1e-4) {
          for (let vi = 0; vi < link.via.length; vi++) {
            const v = link.via[vi];
            const t = Math.max(0, Math.min(1, (v.y - upperFloor.floorY) / ySpan));
            screenPts.push({ x: this.wx(v.x), y: gapTop + t * (gapBottom - gapTop) });
          }
        }
        screenPts.push({ x: enterSx, y: lowerBounds.y0 + lowerBounds.dy });
      }

      screenPts.push({ x: enterSx, y: enterSy });
      const lineColor = link.manualMouth ? STAIR_MOUTH_LINK_COLOR : FLOOR2D_STYLE.route;
      this.drawRouteScreenPath(ctx, dpr, screenPts, lineColor);
      if (!link.manualMouth) {
        this.drawStepTicksInGap(ctx, dpr, screenPts, gapTop, gapBottom);
      }
    }
  }

  private drawStairMouthMarker(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    mouth: StairMouth,
  ): void {
    const px = this.wx(mouth.x);
    const py = this.wz(mouth.z);
    const r = Math.max(5, 6 * dpr);
    ctx.save();
    ctx.fillStyle = STAIR_MOUTH_MARKER_COLOR;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawStairMouthsOnFloor(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    floor: FloorLevel,
  ): void {
    const mouths = floor.stairMouths;
    if (!mouths?.length) return;
    for (let mi = 0; mi < mouths.length; mi++) {
      this.drawStairMouthMarker(ctx, dpr, mouths[mi]);
    }
  }

  private drawStairMouthGapLinks(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
  ): void {
    const drawn = new Set<string>();
    for (let fi = 0; fi < floors.length; fi++) {
      const floor = floors[fi];
      const mouths = floor.stairMouths;
      if (!mouths?.length) continue;
      for (let mi = 0; mi < mouths.length; mi++) {
        const mouth = mouths[mi];
        if (!mouth.linkedFloorId || !mouth.linkedMouthId) continue;
        const key = [floor.id, mouth.id, mouth.linkedFloorId, mouth.linkedMouthId].sort().join('|');
        if (drawn.has(key)) continue;
        drawn.add(key);

        const partnerFloor = floors.find((f) => f.id === mouth.linkedFloorId);
        const partner = partnerFloor?.stairMouths?.find((m) => m.id === mouth.linkedMouthId);
        if (!partner) continue;

        const fromIdx = floors.findIndex((f) => f.id === floor.id);
        const toIdx = floors.findIndex((f) => f.id === partnerFloor!.id);
        if (fromIdx < 0 || toIdx < 0) continue;

        const fromBounds = this.plateBounds(fromIdx, mapH, gapPx, dpr);
        const toBounds = this.plateBounds(toIdx, mapH, gapPx, dpr);
        const x1 = this.wx(mouth.x);
        const y1 = this.wz(mouth.z) + fromBounds.dy;
        const x2 = this.wx(partner.x);
        const y2 = this.wz(partner.z) + toBounds.dy;

        ctx.save();
        ctx.strokeStyle = STAIR_MOUTH_LINK_COLOR;
        ctx.lineWidth = Math.max(1.5, 2 * dpr);
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawPlateSlab(
    ctx: CanvasRenderingContext2D,
    bounds: { x0: number; y0: number; x1: number; y1: number; thickness: number },
    dpr: number,
    isActive: boolean,
    title: string,
  ): void {
    const { x0, y0, x1, y1, thickness } = bounds;
    const cardW = x1 - x0;
    const cardH = y1 - y0;

    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(x0 + 4 * dpr, y1 + thickness + 3 * dpr, cardW, 6 * dpr);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, cardW, cardH);

    ctx.strokeStyle = isActive ? FLOOR2D_STYLE.accent : '#d4d4d4';
    ctx.lineWidth = isActive ? 2 * dpr : 1 * dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cardW - 1, cardH - 1);

    const fontSize = Math.max(10, 11 * dpr);
    ctx.font = `600 ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#333333';
    ctx.fillText(title, x0 + 10 * dpr, y0 + 8 * dpr);
  }

  private drawWalkGridForFloor(ctx: CanvasRenderingContext2D, walk: Uint8Array): void {
    if (!this.map) return;
    const m = this.map;
    const cellPx = m.cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        if (!walk[r * m.cols + c]) continue;
        const x = m.minX + c * m.cellSize;
        const z = m.minZ + r * m.cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx + 0.5, cellPx + 0.5);
      }
    }
  }

  private drawStackedFloorsView(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.map) return;
    const floors = this.sortedFloors();
    const mapH = this.map.maxZ - this.map.minZ;
    const gapPx = this.stackGapPx(dpr);
    const pad = this.platePadPx(dpr);

    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const dy = this.stackLayerDy(i, mapH, gapPx, dpr);
      const bounds = this.plateBounds(i, mapH, gapPx, dpr);
      const isActive = floor.id === this.activeFloorId;
      const preview = previewMapForFloor(this.map, floor, this.floors);
      const walk = this.walkForFloorLevel(floor);
      const objects = floor.objects ?? (isActive ? this.objects : []);
      const zones = floor.zones ?? (isActive ? this.zones : []);
      const title = floorDisplayLabel(floor, i);

      ctx.save();
      ctx.translate(0, dy);
      this.drawPlateSlab(ctx, bounds, dpr, isActive, title);

      ctx.save();
      ctx.beginPath();
      ctx.rect(
        bounds.x0 + pad * 0.25,
        bounds.y0 + pad * 0.25,
        bounds.x1 - bounds.x0 - pad * 0.5,
        bounds.y1 - bounds.y0 - pad * 0.5,
      );
      ctx.clip();

      if (walk) {
        this.drawWalkGridForFloor(ctx, walk);
        this.drawEnclosedRooms(ctx, preview, walk);
      }
      this.drawStores(ctx, preview, dpr);
      const seg = this.routeSegments.find((s) => s.floorId === floor.id);
      if (seg) {
        const trimmed = this.trimPathForFloor(floor.id, seg.path);
        this.drawRouteOnPath(ctx, dpr, trimmed);
      } else if (floor.id === this.activeFloorId) {
        this.drawRoute(ctx, dpr, 'paths');
      }
      this.drawWalls(ctx, preview, dpr, walk);

      const segDbg = this.routeSegments.find((s) => s.floorId === floor.id);
      this.drawRouteDebugForFloor(ctx, dpr, floor.id);
      if (!segDbg && floor.id === this.activeFloorId) {
        this.drawRoute(ctx, dpr, 'overlays');
      }
      this.drawRouteBreakPoints(ctx, dpr, floor.id);

      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        const stroke = z.stroke || FLOOR2D_STYLE.accent;
        ctx.save();
        ctx.globalAlpha = FLOOR2D_STYLE.zoneStrokeOpacity;
        this.drawZoneOutline(ctx, z, stroke, Math.max(2, 2.5 * dpr), dpr);
        ctx.restore();
      }

      this.drawStairMouthsOnFloor(ctx, dpr, floor);

      ctx.restore();
      ctx.restore();
    }

    this.drawGapStairRoutes(ctx, dpr, floors, mapH, gapPx);
    this.drawStairMouthGapLinks(ctx, dpr, floors, mapH, gapPx);
    this.drawRouteDebugLegend(ctx, dpr);

    if (this.routeError) {
      ctx.font = `600 ${Math.max(10, 12 * dpr)}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(this.routeError, this.canvas.width * 0.5, this.canvas.height - 18 * dpr);
    }
  }

  private drawRouteDebugForFloor(ctx: CanvasRenderingContext2D, dpr: number, floorId: string): void {
    const fwd = this.routeDebugForward.find((s) => s.floorId === floorId);
    const rev = this.routeDebugReverse.find((s) => s.floorId === floorId);
    if (fwd) {
      this.drawRouteOnPath(ctx, dpr, fwd.path, '#16a34a', true, Math.max(4, 5 * dpr));
    }
    if (rev) {
      this.drawRouteOnPath(ctx, dpr, rev.path, '#ea580c', true, Math.max(4, 5 * dpr));
    }
  }

  private drawRouteDebugLegend(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (this.routeDebugForward.length === 0 && this.routeDebugReverse.length === 0) return;
    const fontSize = Math.max(9, 10 * dpr);
    const pad = 10 * dpr;
    const lineH = fontSize + 6 * dpr;
    const rows = [
      { color: FLOOR2D_STYLE.route, label: 'Merged route', dashed: false },
      { color: '#16a34a', label: 'O→D probe', dashed: true },
      { color: '#ea580c', label: 'D→O probe', dashed: true },
      { color: '#dc2626', label: 'Break / bridge', dashed: false },
    ];
    const boxW = 132 * dpr;
    const boxH = pad * 2 + rows.length * lineH;
    const x0 = pad;
    const y0 = pad;

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(15,23,42,0.12)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    canvasRoundRect(ctx, x0, y0, boxW, boxH, 8 * dpr);
    ctx.fill();
    ctx.stroke();

    ctx.font = `600 ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const y = y0 + pad + i * lineH + lineH * 0.5;
      const lx = x0 + pad;
      ctx.strokeStyle = row.color;
      ctx.lineWidth = row.dashed ? 2 * dpr : 4 * dpr;
      if (row.dashed) ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(lx + 22 * dpr, y);
      ctx.stroke();
      if (row.dashed) ctx.setLineDash([]);
      ctx.fillStyle = '#0f172a';
      ctx.fillText(row.label, lx + 28 * dpr, y);
    }
  }

  private drawRouteBreakPoints(ctx: CanvasRenderingContext2D, dpr: number, floorId?: string): void {
    const pts = floorId
      ? this.routeBreakPoints.filter((b) => b.floorId === floorId)
      : this.routeBreakPoints;
    if (pts.length === 0) return;

    const fontSize = Math.max(9, 10 * dpr);
    ctx.font = `600 ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (let i = 0; i < pts.length; i++) {
      const bp = pts[i];
      const px = this.wx(bp.x);
      const py = this.wz(bp.z);
      const r = 9 * dpr;
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#991b1b';
      const label = bp.label.length > 36 ? `${bp.label.slice(0, 34)}…` : bp.label;
      ctx.fillText(label, px, py - r - 4 * dpr);
    }
  }

  private drawRoute(ctx: CanvasRenderingContext2D, dpr: number, phase: 'paths' | 'overlays' | 'all' = 'all'): void {
    const floorId = this.activeFloorId;
    const drawPaths = phase === 'paths' || phase === 'all';
    const drawOverlays = phase === 'overlays' || phase === 'all';

    if (this.routeSegments.length > 1) {
      if (!floorId) return;
      const seg = this.routeSegments.find((s) => s.floorId === floorId);
      if (drawOverlays) this.drawRouteDebugForFloor(ctx, dpr, floorId);
      if (drawPaths && seg) {
        this.drawRouteOnPath(ctx, dpr, this.trimPathForFloor(floorId, seg.path));
      }
      if (drawOverlays) this.drawRouteBreakPoints(ctx, dpr, floorId);
      return;
    }
    if (drawOverlays && floorId) this.drawRouteDebugForFloor(ctx, dpr, floorId);
    if (!drawPaths) {
      if (drawOverlays) {
        this.drawRouteBreakPoints(ctx, dpr, floorId ?? undefined);
        this.drawRouteDebugLegend(ctx, dpr);
      }
      return;
    }
    if (this.path.length < 2) {
      if (drawOverlays) {
        this.drawRouteBreakPoints(ctx, dpr, floorId ?? undefined);
        this.drawRouteDebugLegend(ctx, dpr);
      }
      return;
    }
    const lw = Math.max(4, 5 * dpr);
    const outline = lw + 2.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.wx(this.path[0].x), this.wz(this.path[0].z));
    for (let i = 1; i < this.path.length; i++) {
      ctx.lineTo(this.wx(this.path[i].x), this.wz(this.path[i].z));
    }
    ctx.strokeStyle = FLOOR2D_STYLE.routeOutline;
    ctx.lineWidth = outline;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(this.wx(this.path[0].x), this.wz(this.path[0].z));
    for (let i = 1; i < this.path.length; i++) {
      ctx.lineTo(this.wx(this.path[i].x), this.wz(this.path[i].z));
    }
    ctx.strokeStyle = FLOOR2D_STYLE.route;
    ctx.lineWidth = lw;
    ctx.stroke();
    if (drawOverlays) {
      this.drawRouteBreakPoints(ctx, dpr, floorId ?? undefined);
      this.drawRouteDebugLegend(ctx, dpr);
    }
  }

  private drawZones(ctx: CanvasRenderingContext2D, dpr: number): void {
    const lineW = Math.max(2, 2.5 * dpr);
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const stroke = z.stroke || FLOOR2D_STYLE.accent;
      const x = this.wx(z.x);
      const y = this.wz(z.z);
      const w = z.w * this.scale;
      const h = z.d * this.scale;

      ctx.save();
      ctx.globalAlpha = FLOOR2D_STYLE.zoneStrokeOpacity;
      this.drawZoneOutline(ctx, z, stroke, lineW, dpr);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = FLOOR2D_STYLE.zoneLabelOpacity;
      this.drawZoneLabel(ctx, x, y, w, h, z.label, dpr, FLOOR2D_STYLE.zoneLabel);
      ctx.restore();
    }
  }

  private drawPoiMarker(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    fill: string,
    dpr: number,
    radius: number,
  ): void {
    const r = radius * dpr;
    ctx.fillStyle = fill;
    ctx.strokeStyle = FLOOR2D_STYLE.poiMarkerBorder;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawPois(ctx: CanvasRenderingContext2D, dpr: number): void {
    const fontSize = Math.max(9, 11 * dpr);
    ctx.font = '600 ' + fontSize + 'px system-ui,sans-serif';
    ctx.textBaseline = 'middle';
    const sliceY = this.getActiveFloorY();
    const visible = new Set(this.poisForDisplay().map((p) => p.id));

    const drawEndpoint = (id: string, color: string) => {
      const ep = this.resolveEndpoint(id, sliceY);
      if (!ep) return;
      if (isPoiRouteId(id) && !visible.has(id)) return;
      const px = this.wx(ep.x);
      const py = this.wz(ep.z);
      this.drawPoiMarker(ctx, px, py, color, dpr, 7);
      ctx.save();
      ctx.globalAlpha = FLOOR2D_STYLE.poiLabelOpacity;
      ctx.textAlign = 'left';
      ctx.fillStyle = FLOOR2D_STYLE.poiLabel;
      ctx.fillText(truncateLabel(ep.name, 22), px + 13 * dpr, py);
      ctx.restore();
    };

    if (this.originId) drawEndpoint(this.originId, FLOOR2D_STYLE.origin);
    if (this.destId && this.destId !== this.originId) {
      drawEndpoint(this.destId, FLOOR2D_STYLE.destination);
    }

    for (let i = 0; i < this.pois.length; i++) {
      const poi = this.pois[i];
      if (poi.id === this.originId || poi.id === this.destId) continue;
      if (!visible.has(poi.id)) continue;
      const px = this.wx(poi.x);
      const py = this.wz(poi.z);
      this.drawPoiMarker(ctx, px, py, FLOOR2D_STYLE.poiMarker, dpr, 5);
      ctx.save();
      ctx.globalAlpha = FLOOR2D_STYLE.poiLabelOpacity;
      ctx.textAlign = 'left';
      ctx.fillStyle = FLOOR2D_STYLE.poiLabel;
      ctx.fillText(truncateLabel(poi.name, 22), px + 13 * dpr, py);
      ctx.restore();
    }
  }

  draw(): void {
    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      this.syncScene3d(false);
      return;
    }
    if (this.iso3d) {
      this.syncScene3d();
      return;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.map || !this.walk) return;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = FLOOR2D_STYLE.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.usesStackedLayout() && this.viewStack) {
      this.fitStackedView();
      this.drawStackedFloorsView(ctx, dpr);
      return;
    }

    const preview = this.previewMap();
    if (!preview) return;

    this.drawWalkGrid(ctx);
    if (this.walk) this.drawEnclosedRooms(ctx, preview, this.walk);
    this.drawStores(ctx, preview, dpr);
    this.drawRoute(ctx, dpr, 'paths');
    this.drawWalls(ctx, preview, dpr, this.walk);

    const objLineW = Math.max(1.25, 1.5 * dpr);
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      const x = this.wx(o.x);
      const y = this.wz(o.z);
      const w = o.w * this.scale;
      const h = o.d * this.scale;
      this.drawShape(
        ctx,
        x,
        y,
        w,
        h,
        o.shape || 'rectangle',
        o.fill || FLOOR2D_STYLE.object,
        FLOOR2D_STYLE.objectBorder,
        objLineW,
        false,
        o.points,
      );
    }

    this.drawZones(ctx, dpr);
    this.drawRoute(ctx, dpr, 'overlays');
    this.drawPois(ctx, dpr);

    if (this.routeError) {
      ctx.font = `600 ${Math.max(10, 12 * dpr)}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(this.routeError, this.canvas.width * 0.5, this.canvas.height - 18 * dpr);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UI + STYLES
// ═══════════════════════════════════════════════════════════════════════════

function injectMini3dGtaUiStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('mini3dgta-ui-styles')) return;
  const s = document.createElement('style');
  s.id = 'mini3dgta-ui-styles';
  s.textContent = `
.mini3dgta-map-toggle{position:fixed;top:max(12px,env(safe-area-inset-top,0px));left:max(12px,env(safe-area-inset-left,0px));z-index:2147483001;width:48px;height:48px;padding:0;border:none;border-radius:50%;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center;overflow:hidden;transition:transform .15s ease,box-shadow .15s ease,opacity .15s ease,color .15s ease,background .15s ease}
.mini3dgta-map-toggle img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;border-radius:50%}
.mini3dgta-map-toggle:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.4)}
.mini3dgta-map-toggle--open{font-size:22px;font-weight:600;line-height:1;color:#424242;background:rgba(255,255,255,.96)}
.mini3dgta-map-toggle--open:hover{background:#fff}
.mini3dgta-fs-overlay{position:fixed;inset:0;z-index:2147483000;display:none;background:#f5f5f5;pointer-events:auto;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.mini3dgta-fs-body{position:absolute;inset:0}
.floor2d-layout{display:flex;flex:1;min-height:0;min-width:0;width:100%;position:absolute;inset:0}
.floor2d-zone-sidebar{display:none!important}
.floor2d-zone-sidebar__header{
  padding:12px 14px 6px;font-size:12px;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;color:#616161}
.floor2d-floor-list{margin-bottom:4px}
.floor2d-zone-item--floor-active{background:#e3f2fd;border-color:#90caf9}
.floor2d-zone-sidebar__hint{
  padding:0 14px 10px;font-size:11px;line-height:1.35;color:#9e9e9e}
.floor2d-zone-list{flex:1;overflow-y:auto;padding:6px 8px 12px}
.floor2d-zone-list__empty{padding:10px 8px;font-size:12px;color:#9e9e9e;line-height:1.4}
.floor2d-zone-item{
  display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin-bottom:4px;
  border:1px solid transparent;border-radius:8px;background:#f8f8f8;cursor:pointer;text-align:left}
.floor2d-zone-item:hover{background:#f0f0f0;border-color:#e0e0e0}
.floor2d-zone-item__dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.floor2d-zone-item__name{
  font-size:12px;font-weight:600;color:#424242;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini3dgta-fs-map{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}
.mini3dgta-fs-select{box-sizing:border-box;min-width:0;padding:8px 30px 8px 10px;border-radius:10px;border:1px solid #ccc;background-color:#fff;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23757575' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;color:#424242;font-size:13px;font-weight:500;cursor:pointer;appearance:none;-webkit-appearance:none}
.mini3dgta-fs-select:focus{outline:none}
.mini3dgta-fs-select--origin:focus{border-color:#4caf50;box-shadow:0 0 0 2px rgba(76,175,80,.25)}
.mini3dgta-fs-select--dest:focus{border-color:#9c27b0;box-shadow:0 0 0 2px rgba(156,39,176,.22)}
.mini3dgta-fs-select--floor{min-width:108px}
.mini3dgta-fs-float-dock{display:flex;position:absolute;left:50%;transform:translateX(-50%);bottom:max(14px,env(safe-area-inset-bottom,0px));z-index:8;align-items:flex-end;gap:10px;padding:12px 14px;background:rgba(255,255,255,.94);border-radius:16px;box-shadow:0 4px 28px rgba(0,0,0,.2);backdrop-filter:blur(10px);pointer-events:auto;max-width:calc(100% - 20px)}
.mini3dgta-fs-dock-field--floor{display:none}
.mini3dgta-fs-overlay--iso3d .mini3dgta-fs-dock-field--floor{display:flex}
.mini3dgta-fs-dock-field{display:flex;flex-direction:column;gap:4px;flex:1 1 0;min-width:88px;max-width:200px}
.mini3dgta-fs-dock-field--floor{flex:0 1 auto;max-width:140px}
.mini3dgta-fs-dock-field__label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#757575}
.mini3dgta-fs-dock-field__label--from{color:#4caf50}
.mini3dgta-fs-dock-field__label--to{color:#9c27b0}
.mini3dgta-fs-dock-field__label--floor{color:#616161}
.mini3dgta-fs-dock-arrow{align-self:flex-end;padding:0 2px 10px;font-size:20px;line-height:1;color:#bdbdbd;flex-shrink:0}
.floor2d-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;background:#F5F5F0;position:relative;z-index:1}
.floor2d-canvas:active,.floor2d-canvas.is-dragging{cursor:grabbing}
.mini3dgta-map-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4}
.mini3dgta-poi-label{position:absolute;transform:translate(4px,-50%);max-width:120px;text-align:left;font:600 11px/1.15 system-ui,sans-serif;color:#6e6e6e;opacity:.92;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.mini3dgta-route-pin{position:absolute;transform:translate(-50%,-100%);pointer-events:none;filter:drop-shadow(0 2px 5px rgba(0,0,0,.5))}
.mini3dgta-route-pin svg{width:34px;height:34px;display:block}
.mini3dgta-status{position:absolute;top:8px;left:8px;right:8px;z-index:6;max-width:calc(100% - 16px);padding:10px 12px;border-radius:10px;font:12px/1.4 system-ui,sans-serif;color:#424242;background:rgba(255,255,255,.92);border:1px solid #e0e0e0;backdrop-filter:blur(8px);pointer-events:none}
.mini3dgta-status__phase{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9c27b0;margin-bottom:4px}
.mini3dgta-status__phase--error{color:#e57373}
.mini3dgta-status__phase--done{color:#4caf50}
.mini3dgta-status__message{margin:0;font-size:12px;line-height:1.45;color:#424242}
.mini3dgta-fs-view3d{position:absolute;top:max(12px,env(safe-area-inset-top,0px));right:14px;z-index:7;padding:10px 16px;border:none;border-radius:12px;cursor:pointer;font-size:12px;font-weight:600;line-height:1;color:#616161;background:rgba(255,255,255,.94);box-shadow:0 2px 12px rgba(0,0,0,.18);backdrop-filter:blur(8px);pointer-events:auto}
.mini3dgta-fs-view3d:hover{background:#fff}
.mini3dgta-fs-view3d--active{background:#9c27b0;color:#fff}
.mini3dgta-fs-view3d--active:hover{background:#7b1fa2}
@media (max-width:520px){.mini3dgta-fs-float-dock{flex-wrap:wrap;justify-content:center;width:calc(100% - 16px)}.mini3dgta-fs-dock-field{max-width:none;flex:1 1 40%}.mini3dgta-fs-dock-arrow{display:none}}
`;
  document.head.appendChild(s);
}

function mkDockField(
  labelText: string,
  labelClass: string,
  selectClass: string,
  fieldClass = '',
): { wrap: HTMLDivElement; sel: HTMLSelectElement } {
  const wrap = document.createElement('div');
  wrap.className = 'mini3dgta-fs-dock-field' + (fieldClass ? ' ' + fieldClass : '');
  const lbl = document.createElement('span');
  lbl.className = 'mini3dgta-fs-dock-field__label ' + labelClass;
  lbl.textContent = labelText;
  const sel = document.createElement('select');
  sel.className = 'mini3dgta-fs-select ' + selectClass;
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return { wrap, sel };
}

const NAVME_LOGO_SRCS = ['/assets/NavMe_wb.png', './NavMe_wb.png', '/assets/navmelogo.png'];

export function setMini3dGtaMapToggleOpen(btn: HTMLButtonElement, open: boolean): void {
  btn.classList.toggle('mini3dgta-map-toggle--open', open);
  if (open) {
    btn.textContent = '✕';
    btn.setAttribute('aria-label', 'Close map and return to experience');
  } else {
    applyNavMeLogoToToggleButton(btn);
  }
}

function applyNavMeLogoToToggleButton(btn: HTMLButtonElement): void {
  btn.classList.remove('mini3dgta-map-toggle--open');
  btn.textContent = '';
  btn.setAttribute('aria-label', 'Open NavMe 2D map');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  let srcIdx = 0;
  img.onerror = () => {
    srcIdx += 1;
    if (srcIdx < NAVME_LOGO_SRCS.length) {
      img.src = NAVME_LOGO_SRCS[srcIdx];
      return;
    }
    img.remove();
    btn.innerHTML =
      '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#2E6DAD"/><path fill="#fff" d="M10 22V10h3.2l4.8 7.4L22.8 10H26v12h-2.8v-7.1L17.6 22h-2.1l-5.6-7.1V22H10z"/></svg>';
  };
  img.src = NAVME_LOGO_SRCS[0];
  btn.appendChild(img);
}

export interface Mini3dGtaMapButtonHandlers {
  onOpen: () => void;
  onClose: () => void;
}

/** NavMe logo button — becomes ✕ while the map is open (see {@link Mini3dGtaEmbed}). */
export function createMini3dGtaMapButton(handlers: Mini3dGtaMapButtonHandlers): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (!isMini3dGtaEmbedEnabled()) {
    btn.style.display = 'none';
    btn.setAttribute('aria-hidden', 'true');
    return btn;
  }

  injectMini3dGtaUiStyles();
  btn.className = 'mini3dgta-map-toggle';
  applyNavMeLogoToToggleButton(btn);
  btn.addEventListener('click', () => {
    if (btn.classList.contains('mini3dgta-map-toggle--open')) handlers.onClose();
    else handlers.onOpen();
  });
  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(btn);
  }
  return btn;
}

// ——— App bootstrap ———
export interface GtaConfig {
  defaultMapCode: string;
  baseTitle: string;
  /** @deprecated No longer used — map loads from navme_floor_edits only. */
  defaultClientId?: string;
  /** @deprecated No longer used — map loads from navme_floor_edits only. */
  defaultClientSecret?: string;
  /** @deprecated No longer used — map loads from navme_floor_edits only. */
  multiSetApiBaseUrl?: string;
  /** @deprecated No longer used — map loads from navme_floor_edits only. */
  glbCorsProxyPostUrl?: string;
}

const DEFAULT_GTA: GtaConfig = {
  defaultMapCode: 'MAP_D43LZMMLU6BJ',
  baseTitle: 'NavMe 2D',
};

export interface Mini3dGtaMountOptions extends Partial<GtaConfig> {
  updateDocumentTitle?: boolean;
  floatingCircle?: boolean;
  circleDiameterPx?: number;
  fullscreenWithToggle?: boolean;
  deferLoadUntilMapOpen?: boolean;
  suppressMapToggle?: boolean;
  /** Sync external logo / ✕ button when fullscreen opens or closes. */
  onFullscreenChange?: (open: boolean) => void;
  /** When set, this button is kept visible as ✕ while the map is open. */
  externalMapToggle?: HTMLButtonElement;
  /** Nav mesh for multi-floor stair routing. */
  getNavMesh?: () => NavMesh | null;
  /** Scene NavigationRoute + markers — 3D path tube in Mattercraft. */
  navigationBridge?: Mini3dGtaNavRouteSync | null;
}

export interface Mini3dGtaHandle {
  readonly rootElement: HTMLElement;
  readonly ready: Promise<void>;
  openFullscreen(): void;
  closeFullscreen(): void;
  setOrigin(x: number, y: number, z: number): void;
  setDestination(x: number, y: number, z: number): void;
  /** Set origin/destination by POI id (e.g. room-uuid from navme_pois). */
  setRouteEndpoints(originId: string, destId: string): void;
  rebuildRoute(): void;
  getRouteState(): RouteAndBreadcrumbsHandle['state'] | null;
  dispose(): void;
}

function createDisabledMini3dGtaHandle(root: HTMLElement): Mini3dGtaHandle {
  return {
    rootElement: root,
    ready: Promise.resolve(),
    openFullscreen() {},
    closeFullscreen() {},
    setOrigin() {},
    setDestination() {},
    setRouteEndpoints() {},
    rebuildRoute() {},
    getRouteState: () => null,
    dispose() {},
  };
}

function findPoiIdByPosition(pois: NavMapPoi[], x: number, y: number, z: number): string {
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    if (Math.abs(p.x - x) < 0.05 && Math.abs(p.y - y) < 0.05 && Math.abs(p.z - z) < 0.05) {
      return p.id;
    }
  }
  return '';
}

function clearSelectOptions(sel: HTMLSelectElement): void {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
}

/**
 * Mount the NavMe 2D floor map from **saved** `navme_floor_edits` only.
 */
export function mountMini3dGta(
  container: HTMLElement,
  options: Mini3dGtaMountOptions = {},
): Mini3dGtaHandle {
  if (!isMini3dGtaEmbedEnabled()) {
    console.log('[Mini3dGtaEmbed] mini3d_gta_embed disabled (navme_project_features)');
    return createDisabledMini3dGtaHandle(container);
  }

  const cfg = { ...DEFAULT_GTA, ...options };
  const suppressMapToggle = options.suppressMapToggle === true;
  const getNavMesh = options.getNavMesh ?? (() => null);
  const navigationBridge = options.navigationBridge ?? null;
  /** Experience (NavigationRoute bridge): load floor map + mouths immediately, not only when map opens. */
  const deferLoad = options.deferLoadUntilMapOpen === true || !navigationBridge;

  injectMini3dGtaUiStyles();

  let mapView: ViewOnly2DMap | null = null;
  let pois: NavMapPoi[] = [];
  let floorSliceY = -1.6;
  let savedPayload: NavmeFloorEditPayload | null = null;
  let currentPath: { x: number; y: number; z: number }[] = [];
  let currentZones: FloorBlock[] = [];
  let currentFloors: FloorLevel[] = [];
  let projectLoaded = false;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const toggle = document.createElement('button');
  toggle.className = 'mini3dgta-map-toggle';
  toggle.type = 'button';
  if (!suppressMapToggle) {
    applyNavMeLogoToToggleButton(toggle);
  }

  const overlay = document.createElement('div');
  overlay.className = 'mini3dgta-fs-overlay';

  const originField = mkDockField('From', 'mini3dgta-fs-dock-field__label--from', 'mini3dgta-fs-select--origin');
  const destField = mkDockField('To', 'mini3dgta-fs-dock-field__label--to', 'mini3dgta-fs-select--dest');
  const floorField = mkDockField(
    'Floor',
    'mini3dgta-fs-dock-field__label--floor',
    'mini3dgta-fs-select--floor',
    'mini3dgta-fs-dock-field--floor',
  );

  const floatDock = document.createElement('div');
  floatDock.className = 'mini3dgta-fs-float-dock';
  const dockArrow = document.createElement('span');
  dockArrow.className = 'mini3dgta-fs-dock-arrow';
  dockArrow.textContent = '→';
  dockArrow.setAttribute('aria-hidden', 'true');
  floatDock.appendChild(originField.wrap);
  floatDock.appendChild(dockArrow);
  floatDock.appendChild(destField.wrap);
  floatDock.appendChild(floorField.wrap);

  const view3dBtn = document.createElement('button');
  view3dBtn.type = 'button';
  view3dBtn.className = 'mini3dgta-fs-view3d';
  view3dBtn.textContent = '3D';
  view3dBtn.title = 'Extruded 3D walls — drag to orbit, scroll to zoom';

  const fsBody = document.createElement('div');
  fsBody.className = 'mini3dgta-fs-body';
  const floor2dLayout = document.createElement('div');
  floor2dLayout.className = 'floor2d-layout';
  const mountRoot = document.createElement('div');
  mountRoot.className = 'mini3dgta-fs-map';
  floor2dLayout.appendChild(mountRoot);
  fsBody.appendChild(floor2dLayout);

  const status = document.createElement('div');
  status.className = 'mini3dgta-status';
  status.setAttribute('role', 'status');
  const statusPhase = document.createElement('div');
  statusPhase.className = 'mini3dgta-status__phase';
  statusPhase.textContent = 'NavMe';
  const statusMessage = document.createElement('p');
  statusMessage.className = 'mini3dgta-status__message';
  statusMessage.textContent = 'Opening map…';
  status.appendChild(statusPhase);
  status.appendChild(statusMessage);
  mountRoot.appendChild(status);
  mountRoot.appendChild(floatDock);
  mountRoot.appendChild(view3dBtn);

  overlay.appendChild(fsBody);

  if (!suppressMapToggle) {
    document.body.appendChild(toggle);
    document.body.appendChild(overlay);
  } else if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(overlay);
  }

  const setStatus = (msg: string, level: 'loading' | 'done' | 'error' = 'loading') => {
    statusMessage.textContent = msg;
    status.style.display = msg ? 'block' : 'none';
    statusPhase.className = 'mini3dgta-status__phase';
    if (level === 'error') statusPhase.className += ' mini3dgta-status__phase--error';
    else if (level === 'done') statusPhase.className += ' mini3dgta-status__phase--done';
    statusPhase.textContent = level === 'error' ? 'Error' : level === 'done' ? 'Ready' : 'NavMe';
  };

  function refreshFloorSelect(): void {
    const prev = floorField.sel.value;
    clearSelectOptions(floorField.sel);
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = currentFloors.length ? 'Choose floor…' : 'No floors';
    floorField.sel.appendChild(o0);
    if (currentFloors.length >= 2) {
      const viewAll = document.createElement('option');
      viewAll.value = '__view_all__';
      viewAll.textContent = 'View all floors';
      floorField.sel.appendChild(viewAll);
    }
    for (let i = 0; i < currentFloors.length; i++) {
      const f = currentFloors[i];
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = floorDisplayLabel(f, i);
      floorField.sel.appendChild(o);
    }
    if (mapView?.isViewStack()) {
      floorField.sel.value = '__view_all__';
    } else {
      const activeId = mapView?.getActiveFloorId() ?? null;
      if (activeId && floorField.sel.querySelector('option[value="' + activeId + '"]')) {
        floorField.sel.value = activeId;
      } else if (prev && floorField.sel.querySelector('option[value="' + prev + '"]')) {
        floorField.sel.value = prev;
      }
    }
  }

  function poisForRouteUi(): NavMapPoi[] {
    if (!mapView) return pois;
    if (currentFloors.length >= 2) return pois;
    return mapView.poisForDisplay(pois);
  }

  let loadProjectPromise: Promise<void> | null = null;
  function ensureProjectLoaded(): Promise<void> {
    if (projectLoaded) return Promise.resolve();
    if (!loadProjectPromise) loadProjectPromise = loadProject();
    return loadProjectPromise;
  }

  function fillEndpointSelects(): void {
    const routePois = poisForRouteUi();
    const showFloorLabels = currentFloors.length >= 2;
    const zones = currentZones.map((z) => ({ id: ZONE_ROUTE_PREFIX + z.id, name: z.label || 'Zone' }));
    const floors = currentFloors.map((f, i) => ({
      id: FLOOR_ROUTE_PREFIX + f.id,
      name: floorDisplayLabel(f, i),
    }));

    const clearOffFloorPoi = (sel: HTMLSelectElement) => {
      if (isPoiRouteId(sel.value) && !poiOnFloor(sel.value, routePois)) sel.value = '';
    };
    clearOffFloorPoi(originField.sel);
    clearOffFloorPoi(destField.sel);

    const fill = (sel: HTMLSelectElement, ph: string, exclude?: string) => {
      const prev = sel.value;
      clearSelectOptions(sel);
      const o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = ph;
      sel.appendChild(o0);
      const addGroup = (label: string, items: { id: string; name: string }[]) => {
        if (!items.length) return;
        const g = document.createElement('optgroup');
        g.label = label;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (exclude && it.id === exclude) continue;
          const o = document.createElement('option');
          o.value = it.id;
          o.textContent = it.name;
          g.appendChild(o);
        }
        sel.appendChild(g);
      };
      const poiItems = routePois.map((p) => ({
        id: p.id,
        name: showFloorLabels ? `${p.name} (${floorLabelForPoi(p, currentFloors)})` : p.name,
      }));
      addGroup('POIs', poiItems);
      addGroup('Zones', zones);
      addGroup('Floors', floors);
      let canRestore = prev === '';
      if (prev) {
        for (let i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === prev) {
            canRestore = true;
            break;
          }
        }
      }
      sel.value = canRestore ? prev : '';
    };
    fill(originField.sel, 'Choose origin…', destField.sel.value);
    fill(destField.sel, 'Choose destination…', originField.sel.value);
    if (mapView) mapView.setPois(pois, originField.sel.value, destField.sel.value);
  }

  function rebuildRoute(): void {
    void ensureProjectLoaded().then(() => {
      if (!mapView) return;
      const o = originField.sel.value ? mapView.resolveEndpoint(originField.sel.value, floorSliceY) : null;
      const d = destField.sel.value ? mapView.resolveEndpoint(destField.sel.value, floorSliceY) : null;
      if (!o || !d) {
        mapView.setPath([]);
        currentPath = [];
        if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
        return;
      }

      const navMesh = getNavMesh();
      const result = mapView.computeAndSetRoute(navMesh, o, d);
      currentPath = mapView.getRoutePathPoints();

      if (navigationBridge) {
        if (currentPath.length >= 2) {
          applyWaypointsToNavigationRoute(navigationBridge, currentPath);
        } else {
          clearNavRouteWaypointPoints(navigationBridge);
        }
      }

      if (currentPath.length >= 2) {
        mapView.fitToRoute();
      }

      if (result.error) {
        setStatus(result.error, 'error');
      } else {
        setStatus('', 'done');
      }
      mapView.setPois(pois, originField.sel.value, destField.sel.value);
    });
  }

  function applySavedFloor(floorId: string | null): boolean {
    if (!savedPayload) return false;
    const built = buildMapFromSavedPayloadCached(savedPayload, floorId);
    if ('error' in built) {
      setStatus('', 'done');
      mapView?.setPath([]);
      currentPath = [];
      return false;
    }
    floorSliceY = built.map.sliceY;
    currentZones = built.zones;
    currentFloors = built.floors;
    if (!mapView) return true;
    mapView.setState(built.map, built.walk, built.objects, built.zones, built.floors, built.activeFloorId);
    refreshFloorSelect();
    fillEndpointSelects();
    rebuildRoute();
    return true;
  }

  async function loadProject(): Promise<void> {
    const poiType = BACKEND_CATEGORY_NAME;
    setStatus('Loading saved floor map…', 'loading');
    const login = await fetchLoginByType(poiType);
    const mapCode = login?.map_code?.trim() || cfg.defaultMapCode?.trim() || '';
    if (!mapCode) {
      setStatus('', 'done');
      return;
    }

    pois = await fetchPois(poiType);
    const floorEdit = await fetchFloorEdit(poiType, mapCode);
    if (!floorEdit?.payload) {
      setStatus('', 'done');
      savedPayload = null;
      mapView?.setPath([]);
      currentPath = [];
      return;
    }

    savedPayload = floorEdit.payload;
    floorSliceY = floorEdit.sliceY;
    clearFloorBuildCache();

    if (!mapView) {
      mapView = new ViewOnly2DMap(mountRoot);
      mapView.setOnFloorSelect((floorId) => {
        applySavedFloor(floorId);
      });
      mapView.setOnFloorsChange(() => {
        refreshFloorSelect();
      });
      mapView.setOnIso3dChange((on) => {
        overlay.classList.toggle('mini3dgta-fs-overlay--iso3d', on);
        view3dBtn.classList.toggle('mini3dgta-fs-view3d--active', on);
        view3dBtn.textContent = on ? '2D' : '3D';
        if (on) refreshFloorSelect();
      });
    }

    if (!applySavedFloor(null)) return;

    if (!originField.sel.value || !destField.sel.value) {
      const sortedFloors = [...currentFloors].sort((a, b) => a.floorY - b.floorY);
      if (sortedFloors.length >= 2) {
        const lowFloor = sortedFloors[0];
        const highFloor = sortedFloors[sortedFloors.length - 1];
        const lowPois = pois.filter(
          (p) => floorForY(p.y, currentFloors)?.id === lowFloor.id,
        );
        const highPois = pois.filter(
          (p) => floorForY(p.y, currentFloors)?.id === highFloor.id,
        );
        if (!originField.sel.value && lowPois[0]) originField.sel.value = lowPois[0].id;
        if (!destField.sel.value && highPois[0]) destField.sel.value = highPois[0].id;
      } else {
        const floorPois = filterPoisByFloorY(pois, floorSliceY, currentFloors);
        if (!originField.sel.value && floorPois[0]) originField.sel.value = floorPois[0].id;
        if (!destField.sel.value && floorPois[1]) destField.sel.value = floorPois[1].id;
      }
    }
    fillEndpointSelects();
    rebuildRoute();
    projectLoaded = true;
    resolveReady?.();
    resolveReady = null;
    setStatus('', 'done');
  }

  const syncMapToggle = (open: boolean) => {
    if (options.externalMapToggle) setMini3dGtaMapToggleOpen(options.externalMapToggle, open);
    if (!suppressMapToggle) setMini3dGtaMapToggleOpen(toggle, open);
    options.onFullscreenChange?.(open);
  };

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? 'block' : 'none';
    syncMapToggle(open);
    if (!open && mapView?.isIso3d()) {
      mapView.toggleIso3d();
      overlay.classList.remove('mini3dgta-fs-overlay--iso3d');
      view3dBtn.classList.remove('mini3dgta-fs-view3d--active');
      view3dBtn.textContent = '3D';
    }
    if (open) {
      void (async () => {
        if (!projectLoaded) await loadProject();
        mapView?.resize();
      })();
    }
  };

  if (!suppressMapToggle) {
    toggle.onclick = () => {
      if (toggle.classList.contains('mini3dgta-map-toggle--open')) setOpen(false);
      else setOpen(true);
    };
  }

  view3dBtn.onclick = () => {
    mapView?.toggleIso3d();
  };

  floorField.sel.addEventListener('change', () => {
    const floorId = floorField.sel.value;
    if (floorId === '__view_all__') {
      mapView?.activateViewAllFloors();
      fillEndpointSelects();
      return;
    }
    if (floorId) {
      mapView?.leaveViewStack();
      applySavedFloor(floorId);
    }
  });

  originField.sel.addEventListener('change', () => {
    if (destField.sel.value === originField.sel.value) destField.sel.value = '';
    fillEndpointSelects();
    rebuildRoute();
  });
  destField.sel.addEventListener('change', () => {
    if (originField.sel.value === destField.sel.value) originField.sel.value = '';
    fillEndpointSelects();
    rebuildRoute();
  });

  if (!deferLoad) {
    void loadProject();
  }

  const dispose = () => {
    if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
    mapView?.dispose();
    toggle.remove();
    overlay.remove();
    mapView = null;
    savedPayload = null;
  };

  return {
    rootElement: container,
    ready,
    openFullscreen() {
      setOpen(true);
    },
    closeFullscreen() {
      setOpen(false);
    },
    setOrigin(x: number, y: number, z: number) {
      void ensureProjectLoaded().then(() => {
        const id = findPoiIdByPosition(pois, x, y, z);
        if (id) originField.sel.value = id;
        fillEndpointSelects();
        rebuildRoute();
      });
    },
    setDestination(x: number, y: number, z: number) {
      void ensureProjectLoaded().then(() => {
        const id = findPoiIdByPosition(pois, x, y, z);
        if (id) destField.sel.value = id;
        fillEndpointSelects();
        rebuildRoute();
      });
    },
    rebuildRoute() {
      rebuildRoute();
    },
    setRouteEndpoints(originId: string, destId: string) {
      void ensureProjectLoaded().then(() => {
        if (originId) originField.sel.value = originId;
        if (destId) destField.sel.value = destId;
        fillEndpointSelects();
        rebuildRoute();
      });
    },
    getRouteState() {
      return currentPath.length ? { path: currentPath } : null;
    },
    dispose,
  };
}

// ——— Mattercraft @zcomponent (root scene node) ———

/** Constructor props for {@link Mini3dGtaEmbed} (distinct name avoids merging with zcomp `ConstructionProps`). */
export interface Mini3dGtaEmbedConstructionProps {
  defaultMapCode?: string;
  baseTitle?: string;
  updateDocumentTitle?: boolean;
  floatingCircle?: boolean;
  circleDiameterPx?: number;
  fullscreenWithToggle?: boolean;
  /**
   * NavigationRoute in your scene (walkable nav mesh path tube + breadcrumbs).
   * @zprop
   * @zgroup NavMe
   * @zvalues nodeids three/Curve3/NavigationRoute/**
   */
  navigationRoute?: NavigationRoute;
  /**
   * Origin marker Group (created under POI group if omitted).
   * @zprop
   * @zgroup NavMe
   * @zvalues nodeids three/Object3D/**
   */
  originMarker?: Group;
  /**
   * Destination marker Group (created under POI group if omitted).
   * @zprop
   * @zgroup NavMe
   * @zvalues nodeids three/Object3D/**
   */
  destinationMarker?: Group;
  /** @deprecated No longer used. */
  defaultClientId?: string;
  /** @deprecated No longer used. */
  defaultClientSecret?: string;
  /** @deprecated No longer used. */
  multiSetApiBaseUrl?: string;
  /** @deprecated No longer used. */
  glbCorsProxyPostUrl?: string;
}

/**
 * @zcomponent
 * NavMe 2D navigation — saved floor map only (navme_floor_edits).
 */
export class Mini3dGtaEmbed extends Component<Mini3dGtaEmbedConstructionProps> {
  private _handle: Mini3dGtaHandle | null = null;
  private _anchor: HTMLDivElement | null = null;
  private _mapBtn: HTMLButtonElement | null = null;
  private readonly _navContext: NavigationContext;
  private _navBridge: Mini3dGtaNavRouteSync | null = null;
  protected zcomponent = this.getZComponentInstance(Scene);

  constructor(contextManager: ContextManager, constructorProps: Mini3dGtaEmbedConstructionProps) {
    super(contextManager, constructorProps);
    this._navContext = contextManager.get(NavigationContext);

    this._navBridge = resolveMini3dGtaNavBridge(
      contextManager,
      constructorProps,
      this.zcomponent.nodes as Record<string, unknown>,
    );
    if (this._navBridge) {
      this.register(this._navBridge.navigationRoute.onRouteInvalid, (reason: string) => {
        console.warn('[Mini3dGtaEmbed] 3D NavigationRoute:', reason);
      });
    }

    void whenNavmeFeaturesReady().then(() => {
      if (!isMini3dGtaEmbedEnabled()) {
        console.log('[Mini3dGtaEmbed] mini3d_gta_embed disabled (navme_project_features)');
        return;
      }

      this._anchor = document.createElement('div');
      this._anchor.setAttribute('data-navme-mini-3dgta-anchor', '');
      this._anchor.style.cssText =
        'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;';

      const mountOpts: Mini3dGtaMountOptions = {
        ...constructorProps,
        suppressMapToggle: true,
        deferLoadUntilMapOpen: !this._navBridge,
        navigationBridge: this._navBridge,
        getNavMesh: () => {
          const navMeshComponent = this._navContext.defaultNavigationMesh.value;
          return navMeshComponent?.navMesh.value ?? null;
        },
      };

      const tryMount = (): boolean => {
        if (this._handle) return true;
        const body = typeof document !== 'undefined' ? document.body : null;
        if (!body || !this._anchor) return false;
        if (!this._anchor.isConnected) {
          body.appendChild(this._anchor);
        }
        mountOpts.externalMapToggle = this._mapBtn ?? undefined;
        this._handle = mountMini3dGta(this._anchor, mountOpts);
        return true;
      };

      const rebuildWhenReady = () => {
        void this._handle?.ready.then(() => {
          this._handle?.rebuildRoute();
        });
      };

      this.register(this._navContext.defaultNavigationMesh, (comp) => {
        if (comp?.navMesh) {
          this.register(comp.navMesh, rebuildWhenReady);
        }
        rebuildWhenReady();
      });

      const initialMesh = this._navContext.defaultNavigationMesh.value;
      if (initialMesh?.navMesh) {
        this.register(initialMesh.navMesh, rebuildWhenReady);
      }

      const openMap = () => {
        if (!tryMount()) {
          console.warn('[Mini3dGtaEmbed] document.body not ready — cannot open map.');
          return;
        }
        this._handle?.openFullscreen();
      };

      const closeMap = () => {
        this._handle?.closeFullscreen();
      };

      const ensureLogoButton = (): boolean => {
        if (this._mapBtn) return true;
        const body = typeof document !== 'undefined' ? document.body : null;
        if (!body) return false;
        this._mapBtn = createMini3dGtaMapButton({ onOpen: openMap, onClose: closeMap });
        return true;
      };

      const bootstrap = () => {
        ensureLogoButton();
        if (tryMount()) rebuildWhenReady();
      };

      if (typeof queueMicrotask === 'function') {
        queueMicrotask(bootstrap);
      } else {
        setTimeout(bootstrap, 0);
      }

      if (!ensureLogoButton()) {
        const startButtonPoll = () => {
          const deferTimer = setInterval(() => {
            if (ensureLogoButton()) {
              clearInterval(deferTimer);
              bootstrap();
            }
          }, 50);
          setTimeout(() => clearInterval(deferTimer), 15000);
        };
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(startButtonPoll);
        } else {
          setTimeout(startButtonPoll, 0);
        }
      }
    });
  }

  /** Set 3D route origin from world position (POI snap). Syncs NavigationRoute in the experience. */
  setRouteOrigin(x: number, y: number, z: number): void {
    this._handle?.setOrigin(x, y, z);
  }

  /** Set 3D route destination from world position. Syncs NavigationRoute in the experience. */
  setRouteDestination(x: number, y: number, z: number): void {
    this._handle?.setDestination(x, y, z);
  }

  /** Set route by POI ids from navme_pois (e.g. `room-<uuid>`). */
  setRouteEndpoints(originId: string, destId: string): void {
    this._handle?.setRouteEndpoints(originId, destId);
  }

  /** Recompute stair-mouth / floor-grid route and push waypoints to NavigationRoute. */
  rebuildNavigationRoute(): void {
    this._handle?.rebuildRoute();
  }

  get embedHandle(): Mini3dGtaHandle | null {
    return this._handle;
  }

  dispose(): never {
    this._handle?.dispose();
    this._handle = null;
    if (this._mapBtn) {
      setMini3dGtaMapToggleOpen(this._mapBtn, false);
      this._mapBtn.remove();
    }
    this._mapBtn = null;
    this._anchor?.remove();
    this._anchor = null;
    return super.dispose();
  }
}
