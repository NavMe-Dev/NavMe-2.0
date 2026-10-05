/**
 * NavMe 2D navigation embed for Mattercraft — **single file**, view-only.
 *
 * Shows **only saved floor data** from `navme_floor_edits` (no GLB / no auto-generated mesh).
 *
 * - 2D/3D map toggle button → fullscreen floor map (NavMe logo watermark in map)
 * - **Project** from {@link BACKEND_CATEGORY_NAME} in `navmeProjectCategory.ts` (no user picker)
 * - **Origin / Destination** (POIs + zones + floors from saved edit)
 * - Floor sidebar (switch level) + zone list
 * - Route on **saved painted walk grid** (A*) + **stair-mouth** multi-floor routing
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

import { NAVME_CONFIG } from './behaviors';
import { onNavmeLanguageChange, t, type NavmeStringKey, ensureNavmeBottomChrome } from './navmeI18n';
import { chairGridDims, CHAIR_ROW_GAP, CHAIR_ROW_UNIT, CHAIR_ROW_MAX, getCatalogItem } from './objectCatalog';
import { drawFloorPlanSymbol } from './objectSymbols';
import {
  cacheFloorWalls,
  clearFloorWallsCache,
  extractWallsFromWalk,
  extractWallsFromWalkAsync,
  getCachedFloorWalls,
  type WallSeg,
} from './floorWallExtract';
import {
	applyPoiDisplayNames,
	getPoiDisplayName,
	parsePoiNamesFromRow,
	poiMatchesQuery,
	type NavmePoiLocalized,
} from './navmePois';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Scene from './Scene.zcomp';

// ═══════════════════════════════════════════════════════════════════════════
// INLINE DEPENDENCIES — everything this map needs lives in this single file.
// (Supabase REST shim, project-feature gate, AR-pause signal, toggle dock.)
// ═══════════════════════════════════════════════════════════════════════════

/** Supabase table names used by this map. */
const NAVME_TABLES = {
  logins: 'navme_logins',
  pois: 'navme_pois',
  features: 'navme_project_features',
  floorEdits: 'navme_floor_edits',
} as const;

interface PostgrestResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Tiny PostgREST query builder — `from(t).select(cols).eq(col, val)` over fetch. */
class PostgrestQuery<T> implements PromiseLike<PostgrestResult<T>> {
  private selectCols = '*';
  private readonly filters: string[] = [];

  constructor(private readonly table: string) {}

  select(columns?: string): this {
    if (columns && columns.trim()) this.selectCols = columns.replace(/\s+/g, '');
    return this;
  }

  eq(column: string, value: string | number | boolean): this {
    this.filters.push(`${encodeURIComponent(column)}=eq.${encodeURIComponent(String(value))}`);
    return this;
  }

  /** Case-insensitive match (PostgREST ilike; no wildcards = exact, ignoring case). */
  ilike(column: string, value: string | number | boolean): this {
    this.filters.push(`${encodeURIComponent(column)}=ilike.${encodeURIComponent(String(value))}`);
    return this;
  }

  private buildUrl(): string {
    const base = (NAVME_CONFIG.supabaseUrl || '').replace(/\/+$/, '');
    if (!base || !/^https?:\/\//i.test(base)) {
      throw new Error(
        'VITE_SUPABASE_URL is missing or invalid — set it in Render build env and redeploy.',
      );
    }
    const parts = [`select=${this.selectCols}`, ...this.filters];
    return `${base}/rest/v1/${encodeURIComponent(this.table)}?${parts.join('&')}`;
  }

  private async run(): Promise<PostgrestResult<T>> {
    try {
      const res = await fetch(this.buildUrl(), {
        headers: {
          apikey: NAVME_CONFIG.supabaseAnonKey,
          Authorization: `Bearer ${NAVME_CONFIG.supabaseAnonKey}`,
        },
      });
      if (!res.ok) return { data: null, error: { message: `HTTP ${res.status}` } };
      const data = (await res.json()) as T[];
      return { data: Array.isArray(data) ? data : [], error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  }

  then<R1 = PostgrestResult<T>, R2 = never>(
    onfulfilled?: ((value: PostgrestResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/** Minimal Supabase REST client (no SDK) — one fetch per query. */
const supabase = {
  from<T = Record<string, unknown>>(table: string): PostgrestQuery<T> {
    return new PostgrestQuery<T>(table);
  },
};

/** Project category — single source of truth is behaviors.ts (NAVME_CONFIG.tenant). */
const BACKEND_CATEGORY_NAME = NAVME_CONFIG.tenant;

interface ProjectFeatureRow {
  poi_type?: string;
  mini3d_gta_embed?: boolean | null;
  [key: string]: unknown;
}

let _featuresReadyPromise: Promise<void> | null = null;
let _projectFeatures: ProjectFeatureRow | null = null;

/** Standalone Vite build — skip navme_project_features gate (always show map). */
const NAVME_STANDALONE = import.meta.env.VITE_NAVME_STANDALONE !== 'false';

/** Loads navme_project_features once (cached) so the map can be gated by its flag. */
function whenNavmeFeaturesReady(): Promise<void> {
  if (_featuresReadyPromise) return _featuresReadyPromise;
  _featuresReadyPromise = (async () => {
    if (NAVME_STANDALONE) {
      _projectFeatures = { mini3d_gta_embed: true, poi_type: BACKEND_CATEGORY_NAME };
      return;
    }
    try {
      const { data } = await supabase
        .from<ProjectFeatureRow>(NAVME_TABLES.features)
        .select('*')
        .eq('poi_type', BACKEND_CATEGORY_NAME);
      _projectFeatures = Array.isArray(data) && data.length > 0 ? data[0] : null;
    } catch {
      _projectFeatures = null;
    }
  })();
  return _featuresReadyPromise;
}

/** Dashboard 3D view always shows the map; do not gate on project features. */
function isMini3dGtaEmbedEnabled(): boolean {
  return true;
}

/**
 * Signals the AR experience to idle non-tracking work while the fullscreen map
 * is shown. Never stops the Zappar camera / SLAM tracker, so closing the map
 * does not force a costly re-localization.
 */
function setArExperiencePaused(paused: boolean): void {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('navme-ar-paused', paused);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('navme-ar-pause', { detail: { paused } }));
  }
}

const MAP_TOGGLE_DOCK_ID = 'navme-map-toggle-dock';

/** Docks the map toggle in the bottom chrome (left); rises above the nav bar when localized. */
function mountToNavMapToggleFloat(btn: HTMLButtonElement): void {
  if (typeof document === 'undefined') return;
  const styleId = 'navme-map-toggle-dock-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent =
      `#${MAP_TOGGLE_DOCK_ID}{display:flex;align-items:flex-end;pointer-events:none}` +
      `#${MAP_TOGGLE_DOCK_ID} .mini3dgta-map-toggle{pointer-events:auto}`;
    document.head.appendChild(style);
  }
  const chrome = ensureNavmeBottomChrome();
  let dock = document.getElementById(MAP_TOGGLE_DOCK_ID);
  if (!dock) {
    dock = document.createElement('div');
    dock.id = MAP_TOGGLE_DOCK_ID;
  }
  if (dock.parentElement !== chrome) {
    chrome.insertBefore(dock, chrome.firstChild);
  }
  btn.style.pointerEvents = 'auto';
  dock.appendChild(btn);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const NAVME_FLOOR_EDITS_TABLE = 'navme_floor_edits';
const FLOOR_EDIT_VERSION = 5;
const ZONE_ROUTE_PREFIX = 'zone:';
const FLOOR_ROUTE_PREFIX = 'floor:';

/** NavigationRoute POI snap offset (editor2d / NavMeNavigation). */
const ROUTE_CAMERA_POSITION_OFFSET: [number, number, number] = [0, 0, 0];
/** Cap canvas / WebGL DPR — up to 3× for retina phones. */
const MAX_RENDER_DPR = 3;

function deviceRenderDpr(): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
}

/** Supersample canvas text baked into 3D floor labels (retina-crisp on phones). */
function labelTextureDpr(): number {
  if (typeof window === 'undefined') return 2;
  return Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
}
/** Above this cell count, use a single textured floor slab instead of per-cell instances. */
const LARGE_MAP_CELL_COUNT = 6000;
const INSTANCED_FLOOR_TILE_MAX = 1200;
const POI_SPATIAL_CELL = 14;

function debounceFn<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer = 0;
  return ((...args: never[]) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

function rafCoalesce<T extends (...args: never[]) => void>(fn: T): T {
  let scheduled = false;
  let pending: never[] = [];
  return ((...args: never[]) => {
    pending = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...pending);
    });
  }) as T;
}

/** Min-heap A* open set — avoids sorting the full open list every step. */
class AStarOpenHeap {
  private readonly heap: number[] = [];
  constructor(private readonly score: Float32Array) {}

  push(index: number): void {
    const h = this.heap;
    h.push(index);
    let c = h.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.score[h[p]] <= this.score[h[c]]) break;
      const swap = h[p];
      h[p] = h[c];
      h[c] = swap;
      c = p;
    }
  }

  pop(): number | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        let smallest = i;
        const left = 2 * i + 1;
        const right = left + 1;
        if (left < h.length && this.score[h[left]] < this.score[h[smallest]]) smallest = left;
        if (right < h.length && this.score[h[right]] < this.score[h[smallest]]) smallest = right;
        if (smallest === i) break;
        const swap = h[i];
        h[i] = h[smallest];
        h[smallest] = swap;
        i = smallest;
      }
    }
    return top;
  }

  get length(): number {
    return this.heap.length;
  }
}

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

function setNavRouteEndpoints(route: NavigationRoute, originId: string, destId: string, emit = true): void {
  if (originId) route.originNode.value = originId;
  if (destId) route.destinationNode.value = destId;
  if (emit) route.onRouteChange.emit();
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
  setNavRouteEndpoints(route, zcomponentNodeId(origin), zcomponentNodeId(dest), false);

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

function isZoneRouteId(id: string): boolean {
  return id.indexOf(ZONE_ROUTE_PREFIX) === 0;
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

/** Pencil-sketch blueprint palette — monochromatic architectural blue on white paper. */
const SKETCH_PAPER = '#FFFFFF';
const SKETCH_INK = '#3D6AA8';
const SKETCH_INK_DARK = '#2A4F82';
const SKETCH_INK_LIGHT = '#7AA0D0';
const SKETCH_INK_PALE = '#B5CCE8';
const SKETCH_INK_WASH = '#EAF1FA';
const SKETCH_ROUTE = '#3B6EB5';
const SKETCH_ROUTE_PALE = '#9BB8DE';
const SKETCH_ROUTE_GLOW = '#5B8AC8';

/** Glossy dark-bright red — navigation route + start/end pins only (map stays blue sketch). */
const NAV_GLOSS_NAVY = '#B8001C';
const NAV_GLOSS_NAVY_BRIGHT = '#E60026';
const NAV_GLOSS_NAVY_HIGHLIGHT = '#FF3B4A';
const NAV_GLOSS_NAVY_PALE = '#FF8A92';
const NAV_GLOSS_NAVY_DEEP = '#6B0010';

/** Shared floor-map palette — blue pencil sketch on white paper. */
const MAP_PALETTE = {
  background: SKETCH_PAPER,
  floor: '#FFFFFF',
  corridor: '#FFFFFF',
  interiorFill: SKETCH_INK_WASH,
  interiorBlock: '#E2EBF6',
  interiorBlockTop: SKETCH_INK_PALE,
  interiorBlockSide: SKETCH_INK,
  wall: SKETCH_INK,
  wallLight: SKETCH_INK_LIGHT,
  borderWall: SKETCH_INK_DARK,
  borderWallTop: '#6A8FB8',
  interiorWall: '#5A7AAD',
  interiorWallTop: SKETCH_INK_LIGHT,
  greenery: '#D4E2F4',
  water: '#C8DAF0',
  object: '#7A9BC4',
  objectBorder: '#5E82B0',
  zoneLabel: SKETCH_INK_DARK,
  accent: SKETCH_INK,
  highlight: SKETCH_INK_PALE,
  tan: '#E8EEF8',
  poiLabel: SKETCH_INK_DARK,
  route: SKETCH_ROUTE,
  routeOutline: '#FFFFFF',
} as const;

/** Navigation route + markers — red only (map stays blue pencil sketch). */
const NAV_ROUTE_VIVID = NAV_GLOSS_NAVY_BRIGHT;
const NAV_ROUTE_BLUE = NAV_GLOSS_NAVY_BRIGHT;
const NAV_ROUTE_BLUE_EMISSIVE = NAV_GLOSS_NAVY;
const NAV_ROUTE_BLUE_LIGHT = NAV_GLOSS_NAVY_HIGHLIGHT;
const NAV_ROUTE_BLUE_PALE = NAV_GLOSS_NAVY_PALE;
const NAV_ROUTE_GREEN = NAV_GLOSS_NAVY_BRIGHT;
const NAV_ROUTE_GREEN_EMISSIVE = NAV_GLOSS_NAVY;
const NAV_ROUTE_RED = NAV_GLOSS_NAVY;
const NAV_ROUTE_RED_EMISSIVE = NAV_GLOSS_NAVY_DEEP;
/** Sketch accent tones for zone blink / highlights. */
const NAVIA_NEON = SKETCH_INK_DARK;
const NAVIA_NEON_BRIGHT = SKETCH_INK;
const NAVIA_NEON_DIM = 'rgba(61,106,168,0.28)';
const NAVIA_NEON_PALE = 'rgba(61,106,168,0.42)';
/** Red start ring + destination pin. */
const NAV_MARKER_NAVY = NAV_GLOSS_NAVY;
const NAV_MARKER_NAVY_BRIGHT = NAV_GLOSS_NAVY_BRIGHT;
const NAV_MARKER_NAVY_DIM = 'rgba(184,0,28,0.32)';
/** NavMe logo blues — dark theme UI chrome (from NavMe_wb.png). */
const NAVME_DARK_BG = '#0A1628';
const NAVME_DARK_SURFACE = '#111C30';
const NAVME_UI_BLUE = '#3B82F6';
const NAVME_UI_BLUE_BRIGHT = '#5BA3FF';
const NAVME_UI_BLUE_SOFT = 'rgba(59,130,246,0.20)';
const NAVME_BRAND_NAME = 'NavMe Spatial Studio';
const NAVIA_BG = NAVME_DARK_BG;
/** Route animation — deep red base + bright red active segment. */
const NAV_ROUTE_BLACK_GREEN_DEEP = NAV_GLOSS_NAVY_DEEP;
const NAV_ROUTE_BLACK_GREEN = NAV_GLOSS_NAVY_PALE;
const NAV_ROUTE_BLACK_GREEN_BRIGHT = NAV_GLOSS_NAVY_BRIGHT;
const NAV_ROUTE_GLOSS_HIGHLIGHT = NAV_GLOSS_NAVY_HIGHLIGHT;
const EXPOFP_ROUTE_ACTIVE = NAV_GLOSS_NAVY_BRIGHT;
const EXPOFP_ROUTE_PALE = NAV_GLOSS_NAVY_PALE;
const EXPOFP_START_BLUE = NAV_MARKER_NAVY;
const EXPOFP_DEST_ORANGE = NAV_MARKER_NAVY_BRIGHT;
const ROUTE_ANIM_MS = 2800;

/** US indoor mapping palette (Mappedin / Esri Indoors–style circulation + space colors). */
const US_INDOOR_MAP = {
  corridor: MAP_PALETTE.corridor,
  floorBase: MAP_PALETTE.floor,
  floorCorridors: [MAP_PALETTE.corridor],
  roomFills: [
    MAP_PALETTE.interiorFill,
    '#D4E6D8',
    '#D0E4D4',
    MAP_PALETTE.tan,
    MAP_PALETTE.highlight,
    MAP_PALETTE.greenery,
    '#C8E0CC',
  ],
  categories: {
    corridor: MAP_PALETTE.corridor,
    office: MAP_PALETTE.interiorFill,
    workspace: MAP_PALETTE.interiorFill,
    conference: MAP_PALETTE.interiorFill,
    meeting: MAP_PALETTE.interiorFill,
    restroom: MAP_PALETTE.interiorFill,
    bathroom: MAP_PALETTE.interiorFill,
    bath: MAP_PALETTE.interiorFill,
    kitchen: MAP_PALETTE.interiorFill,
    dining: MAP_PALETTE.interiorFill,
    dinning: MAP_PALETTE.interiorFill,
    bedroom: MAP_PALETTE.interiorFill,
    bed: MAP_PALETTE.interiorFill,
    closet: MAP_PALETTE.interiorFill,
    storage: MAP_PALETTE.interiorFill,
    garage: MAP_PALETTE.interiorFill,
    stair: MAP_PALETTE.interiorFill,
    lobby: MAP_PALETTE.interiorFill,
    entry: MAP_PALETTE.interiorFill,
    living: MAP_PALETTE.interiorFill,
    family: MAP_PALETTE.interiorFill,
    great: MAP_PALETTE.interiorFill,
    sun: MAP_PALETTE.interiorFill,
    bonus: MAP_PALETTE.interiorFill,
    primary: MAP_PALETTE.interiorFill,
    suite: MAP_PALETTE.interiorFill,
    guest: MAP_PALETTE.interiorFill,
    breakfast: MAP_PALETTE.interiorFill,
    utility: MAP_PALETTE.interiorFill,
    mechanical: MAP_PALETTE.interiorFill,
    garden: MAP_PALETTE.greenery,
    green: MAP_PALETTE.greenery,
    grass: MAP_PALETTE.greenery,
    lawn: MAP_PALETTE.greenery,
    landscape: MAP_PALETTE.greenery,
    park: MAP_PALETTE.greenery,
    pool: MAP_PALETTE.water,
    water: MAP_PALETTE.water,
    pond: MAP_PALETTE.water,
  } as Record<string, string>,
  zoneTints: [
    MAP_PALETTE.interiorFill,
    MAP_PALETTE.tan,
    MAP_PALETTE.highlight,
    MAP_PALETTE.greenery,
    MAP_PALETTE.water,
  ],
} as const;

function zoneInteriorColorFromLabel(label: string | undefined, index: number): string {
  if (label?.trim()) {
    const norm = label.trim().toLowerCase();
    for (const key of Object.keys(US_INDOOR_MAP.categories)) {
      if (norm.includes(key)) {
        return US_INDOOR_MAP.categories[key];
      }
    }
  }
  return MAP_PALETTE.interiorFill;
}

function usZoneColorFromLabel(label: string | undefined, index: number): string {
  return zoneInteriorColorFromLabel(label, index);
}

function zoneVisualStyle(zone: FloorBlock, index: number): { fill: string; stroke: string } {
  const stroke =
    zone.stroke && zone.stroke !== 'transparent' ? zone.stroke : FLOOR2D_STYLE.accent;
  const fill =
    zone.fill && zone.fill !== 'transparent'
      ? zone.fill
      : zone.stroke && zone.stroke !== 'transparent'
        ? zone.stroke
        : zoneInteriorColorFromLabel(zone.label, index);
  return { fill, stroke };
}

function findZoneAtPoint(x: number, z: number, zones: FloorBlock[]): FloorBlock | null {
  for (let i = zones.length - 1; i >= 0; i--) {
    if (pointInsideBlock(x, z, zones[i])) return zones[i];
  }
  return null;
}

function zonesForFloorLevel(
  floor: FloorLevel,
  activeFloorId: string | null,
  activeZones: FloorBlock[],
): FloorBlock[] {
  if (floor.zones && floor.zones.length > 0) return floor.zones;
  if (floor.id === activeFloorId && activeZones.length > 0) return activeZones;
  return [];
}

function findZoneInFloors(
  zoneId: string,
  floors: FloorLevel[],
  activeFloorId: string | null,
  activeZones: FloorBlock[],
): { floor: FloorLevel; zone: FloorBlock } | null {
  for (let fi = 0; fi < floors.length; fi++) {
    const floor = floors[fi];
    const zones = zonesForFloorLevel(floor, activeFloorId, activeZones);
    for (let zi = 0; zi < zones.length; zi++) {
      if (zones[zi].id === zoneId) return { floor, zone: zones[zi] };
    }
  }
  return null;
}

function zoneEndpointLabel(
  zone: FloorBlock,
  floor: FloorLevel,
  floorIndex: number,
  multiFloor: boolean,
): string {
  const name = stripTrailingZoneWord(zone.label?.trim() || 'Zone');
  if (!multiFloor) return name;
  return `${name} (${floorDisplayLabel(floor, floorIndex)})`;
}

function stripTrailingZoneWord(label: string): string {
  const trimmed = label.trim();
  const without = trimmed.replace(/\s+zone\s*$/i, '').trim();
  return without || trimmed;
}

const FLOOR2D_STYLE = {
  background: MAP_PALETTE.background,
  corridor: MAP_PALETTE.corridor,
  store: MAP_PALETTE.interiorFill,
  storeFills: US_INDOOR_MAP.roomFills,
  object: MAP_PALETTE.object,
  objectBorder: MAP_PALETTE.objectBorder,
  /** Blue edge ink — matches 3D wall edges. */
  wall: MAP_PALETTE.wall,
  wallLight: MAP_PALETTE.wallLight,
  /** Whitish light-blue glass fill — matches 3D wall faces. */
  wallGlass: '#D0E4F6',
  wallGlassLight: '#DEEAF8',
  route: EXPOFP_ROUTE_ACTIVE,
  routeOutline: '#ffffff',
  routeGlow: 'rgba(230,0,38,0.35)',
  zoneLabel: MAP_PALETTE.zoneLabel,
  accent: MAP_PALETTE.accent,
  zoneStrokeColors: [MAP_PALETTE.wall, MAP_PALETTE.accent, MAP_PALETTE.greenery, MAP_PALETTE.water],
  zoneStrokeOpacity: 0.65,
  zoneFillOpacity: 0.92,
  zoneLabelOpacity: 0.9,
  poiMarker: '#6E6A64',
  poiMarkerDim: '#A09C96',
  poiMarkerBorder: MAP_PALETTE.wall,
  poiLabel: MAP_PALETTE.poiLabel,
  poiLabelOpacity: 0.92,
  origin: NAV_MARKER_NAVY,
  destination: NAV_MARKER_NAVY_BRIGHT,
  floorCanvas: MAP_PALETTE.background,
  interiorFill: MAP_PALETTE.interiorFill,
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
  /** Catalog material id from the 2D editor (e.g. "chair", "chair-row", "door"). */
  kind?: string;
  /** Parametric count for grid materials (e.g. chairs in a row). */
  count?: number;
  /** Object yaw in degrees from the 2D editor (0–360). */
  rotation?: number;
};
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
  /** Set when this level is a subfloor of another floor. */
  parentFloorId?: string;
  walkGrid?: number[];
  walkGridPacked?: string;
  objects?: FloorBlock[];
  zones?: FloorBlock[];
  gridCols?: number;
  gridRows?: number;
  gridCellSize?: number;
  gridMinX?: number;
  gridMinZ?: number;
  stairMouths?: StairMouth[];
};

function isTopLevelFloor(floor: FloorLevel): boolean {
  return !floor.parentFloorId;
}

function topLevelFloors(levels: FloorLevel[]): FloorLevel[] {
  return levels.filter(isTopLevelFloor);
}

function subfloorsOf(levels: FloorLevel[], parentId: string): FloorLevel[] {
  return levels.filter((f) => f.parentFloorId === parentId);
}

/** Parent floor plus its subfloors (or just the floor when it has none). */
function floorFamily(levels: FloorLevel[], floorId: string | null | undefined): FloorLevel[] {
  if (!floorId) return topLevelFloors(levels);
  const active = levels.find((f) => f.id === floorId);
  if (!active) return topLevelFloors(levels);
  const parentId = active.parentFloorId || active.id;
  const parent = levels.find((f) => f.id === parentId) ?? active;
  const subs = subfloorsOf(levels, parent.id).sort((a, b) => a.floorY - b.floorY);
  if (subs.length === 0) return [active];
  return [parent, ...subs];
}
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
type NavMapPoi = NavmePoiLocalized & { id: string; x: number; y: number; z: number };

/** Map markers: only show selected route endpoints (not every POI). */
function endpointPoisOnly(pois: NavMapPoi[], originId: string, destId: string): NavMapPoi[] {
  const out: NavMapPoi[] = [];
  if (originId) {
    const o = pois.find((p) => p.id === originId);
    if (o) out.push(o);
  }
  if (destId && destId !== originId) {
    const d = pois.find((p) => p.id === destId);
    if (d) out.push(d);
  }
  return out;
}

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
  walkGrid?: number[];
  walkGridPacked?: string;
  objects: FloorBlock[];
  zones: FloorBlock[];
  floors: FloorLevel[];
  /** Independent subfloor levels (stair plates), persisted separately from `floors`. */
  subfloors?: FloorLevel[];
};
type NavmeLoginRow = {
  poi_type: string;
  map_code: string | null;
};

export type Mini3dGtaRouteState = {
  path: { x: number; y: number; z: number }[];
} | null;

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════════════════════════

async function fetchNavmeLoginTypes(): Promise<string[]> {
  const { data, error } = await supabase.from(NAVME_TABLES.logins).select('poi_type');
  if (error || !data) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const label = String((data[i] as NavmeLoginRow).poi_type ?? '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

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
    const r = (data || [])[i] as Record<string, unknown>;
    if (String(r.poi_type ?? '').trim().toLowerCase() !== want) continue;
    const { defaultName, names } = parsePoiNamesFromRow(r);
    const poi: NavMapPoi = {
      id: 'room-' + String(r.id ?? ''),
      defaultName: defaultName || 'POI',
      names,
      name: '',
      x: Number(r.pos_x ?? 0),
      y: Number(r.pos_y ?? 0),
      z: Number(r.pos_z ?? 0),
    };
    poi.name = getPoiDisplayName(poi);
    out.push(poi);
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

function floorDisplayLabel(
  floor: { label?: string; parentFloorId?: string },
  index: number,
  parentLabel?: string,
): string {
  const label = floor.label?.trim();
  if (label) return label;
  if (floor.parentFloorId) {
    return parentLabel ? `${parentLabel} Sub ${index + 1}` : `Subfloor ${index + 1}`;
  }
  return `Floor ${index + 1}`;
}

/**
 * POIs for one floor slice: each POI belongs to the nearest named floor Y.
 * Example: floor 1 at Y=-0.3 and floor 2 at Y=3.5 — a POI at y=-0.25 shows on floor 1 only.
 */
function filterPoisByFloorY(
  pois: NavMapPoi[],
  targetFloorY: number,
  floorLevels: FloorLevel[],
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

  let targetFloor: FloorLevel | null = null;
  for (let i = 0; i < floorLevels.length; i++) {
    if (Math.abs(floorLevels[i].floorY - targetFloorY) < 1e-4) {
      targetFloor = floorLevels[i];
      break;
    }
  }

  if (targetFloor) {
    const out: NavMapPoi[] = [];
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      const assigned = floorLevelForPoiY(p.y, floorLevels);
      if (assigned?.id === targetFloor.id) out.push(p);
    }
    return out;
  }

  const band = yBandAroundSlice(targetFloorY, floorLevels);
  const out: NavMapPoi[] = [];
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
    // Case-insensitive so "Unisys"/"UNISYS" both resolve the saved floor edit.
    .ilike('poi_type', poiType.trim())
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

/**
 * Clamp a zone/room block to the map's rectangular bounds so authored zones can
 * never paint colour outside the floor plate. Returns null if the block collapses
 * to zero area (i.e. it was entirely outside the map).
 */
function clampBlockToBounds(
  block: FloorBlock,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): FloorBlock | null {
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  if (block.points && block.points.length >= 3) {
    const pts = block.points.map((p) => ({ x: clamp(p.x, minX, maxX), z: clamp(p.z, minZ, maxZ) }));
    let minPx = Infinity;
    let maxPx = -Infinity;
    let minPz = Infinity;
    let maxPz = -Infinity;
    for (const p of pts) {
      if (p.x < minPx) minPx = p.x;
      if (p.x > maxPx) maxPx = p.x;
      if (p.z < minPz) minPz = p.z;
      if (p.z > maxPz) maxPz = p.z;
    }
    if (maxPx - minPx < 1e-3 || maxPz - minPz < 1e-3) return null;
    return { ...block, points: pts };
  }
  const x1 = clamp(block.x, minX, maxX);
  const z1 = clamp(block.z, minZ, maxZ);
  const x2 = clamp(block.x + block.w, minX, maxX);
  const z2 = clamp(block.z + block.d, minZ, maxZ);
  if (x2 - x1 < 1e-3 || z2 - z1 < 1e-3) return null;
  return { ...block, x: x1, z: z1, w: x2 - x1, d: z2 - z1 };
}

function clampZonesToBounds(
  zones: FloorBlock[],
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): FloorBlock[] {
  const out: FloorBlock[] = [];
  for (const z of zones) {
    const c = clampBlockToBounds(z, minX, maxX, minZ, maxZ);
    if (c) out.push(c);
  }
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

/** Above this cell count, skip mergeRects / wall extraction and draw from raw walk grid. */
const HUGE_GRID_CELLS = 12_000;
const DECODE_YIELD_EVERY_BITS = 65_536;
const WALK_CONVERT_YIELD_EVERY = 65_536;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 48 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function hasWalkGridSource(
  walkGrid: number[] | undefined,
  walkGridPacked: string | undefined,
  cols: number,
  rows: number,
): boolean {
  const need = cols * rows;
  if (need <= 0) return false;
  if (Array.isArray(walkGrid) && walkGrid.length === need) return true;
  return typeof walkGridPacked === 'string' && walkGridPacked.length > 0;
}

/** Decode editor v6 `walkGridPacked` (base64, LSB-first bitmap) → walk bitmap bytes. */
function decodeWalkGridPackedToUint8(packed: string, cols: number, rows: number): Uint8Array | null {
  const need = cols * rows;
  if (!packed || need <= 0) return null;
  try {
    const binary = atob(packed);
    const out = new Uint8Array(need);
    let bitIndex = 0;
    for (let i = 0; i < binary.length && bitIndex < need; i++) {
      const byte = binary.charCodeAt(i);
      for (let b = 0; b < 8 && bitIndex < need; b++) {
        out[bitIndex++] = (byte >> b) & 1;
      }
    }
    while (bitIndex < need) out[bitIndex++] = 0;
    return out;
  } catch {
    return null;
  }
}

async function decodeWalkGridPackedAsync(
  packed: string,
  cols: number,
  rows: number,
): Promise<Uint8Array | null> {
  const need = cols * rows;
  if (!packed || need <= 0) return null;
  try {
    const binary = atob(packed);
    const out = new Uint8Array(need);
    let bitIndex = 0;
    for (let i = 0; i < binary.length && bitIndex < need; i++) {
      const byte = binary.charCodeAt(i);
      for (let b = 0; b < 8 && bitIndex < need; b++) {
        out[bitIndex++] = (byte >> b) & 1;
        if (bitIndex % DECODE_YIELD_EVERY_BITS === 0) await yieldToMain();
      }
    }
    while (bitIndex < need) out[bitIndex++] = 0;
    return out;
  } catch {
    return null;
  }
}

async function convertWalkGridToUint8Async(grid: number[]): Promise<Uint8Array> {
  const out = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    out[i] = grid[i] ? 1 : 0;
    if (i > 0 && i % WALK_CONVERT_YIELD_EVERY === 0) await yieldToMain();
  }
  return out;
}

const walkGridCache = new Map<string, Uint8Array>();
const walkGridBitmapCache = new Map<string, HTMLCanvasElement>();

function walkGridCacheKey(floorKey: string): string {
  return floorKey;
}

function clearWalkGridCache(): void {
  walkGridCache.clear();
  walkGridBitmapCache.clear();
  clearFloorNavGridCache();
}

function getCachedWalkGrid(floorKey: string, need: number): Uint8Array | null {
  const cached = walkGridCache.get(walkGridCacheKey(floorKey));
  if (cached && cached.length === need) return cached;
  return null;
}

async function resolveWalkGridUint8Async(
  payload: NavmeFloorEditPayload,
  floor: FloorLevel | null,
  onProgress?: (msg: string) => void,
): Promise<Uint8Array | null> {
  const useRoot = !floor;
  const cols = useRoot ? payload.cols : (floor!.gridCols ?? payload.cols);
  const rows = useRoot ? payload.rows : (floor!.gridRows ?? payload.rows);
  const need = cols * rows;
  if (need <= 0) return null;

  const floorKey = useRoot ? '__root__' : floor!.id;
  const cached = getCachedWalkGrid(floorKey, need);
  if (cached) return cached;

  const walkGrid = useRoot ? payload.walkGrid : floor!.walkGrid;
  const walkGridPacked = useRoot ? payload.walkGridPacked : floor!.walkGridPacked;

  if (Array.isArray(walkGrid) && walkGrid.length === need) {
    const out = await convertWalkGridToUint8Async(walkGrid);
    walkGridCache.set(walkGridCacheKey(floorKey), out);
    return out;
  }
  if (typeof walkGridPacked === 'string' && walkGridPacked.length > 0) {
    onProgress?.('Decoding floor map…');
    const out = await decodeWalkGridPackedAsync(walkGridPacked, cols, rows);
    if (out) walkGridCache.set(walkGridCacheKey(floorKey), out);
    return out;
  }

  if (!useRoot) return resolveWalkGridUint8Async(payload, null, onProgress);
  return null;
}

function collectPayloadFloorLevels(p: NavmeFloorEditPayload): FloorLevel[] {
  const mains = Array.isArray(p.floors) ? p.floors : [];
  const explicitSubs = Array.isArray(p.subfloors) ? p.subfloors : [];
  const seen = new Set<string>();
  const out: FloorLevel[] = [];
  const add = (f: FloorLevel | undefined) => {
    if (!f?.id || seen.has(f.id)) return;
    seen.add(f.id);
    out.push(f);
  };
  for (let i = 0; i < mains.length; i++) add(mains[i]);
  for (let i = 0; i < explicitSubs.length; i++) add(explicitSubs[i]);
  return out;
}

function clonePayloadFloorLevel(f: FloorLevel, payload: NavmeFloorEditPayload): FloorLevel {
  const fc = Number(f.gridCols ?? payload.cols);
  const fr = Number(f.gridRows ?? payload.rows);
  return {
    ...f,
    parentFloorId: f.parentFloorId,
    walkGrid: Array.isArray(f.walkGrid) ? f.walkGrid : undefined,
    walkGridPacked: typeof f.walkGridPacked === 'string' ? f.walkGridPacked : undefined,
    gridCols: fc,
    gridRows: fr,
    gridCellSize: f.gridCellSize ?? payload.cellSize,
    gridMinX: f.gridMinX ?? payload.minX,
    gridMinZ: f.gridMinZ ?? payload.minZ,
    objects: cloneFloorBlocks(f.objects || []),
    zones: cloneFloorBlocks(f.zones || []),
    stairMouths: f.stairMouths?.map((m) => ({ ...m })),
  };
}

function payloadFloorLevels(payload: NavmeFloorEditPayload): FloorLevel[] {
  return collectPayloadFloorLevels(payload).map((f) => clonePayloadFloorLevel(f, payload));
}

function payloadHasWalkGrid(p: NavmeFloorEditPayload, cols: number, rows: number): boolean {
  if (hasWalkGridSource(p.walkGrid, p.walkGridPacked, cols, rows)) return true;
  const floors = collectPayloadFloorLevels(p);
  for (let i = 0; i < floors.length; i++) {
    const f = floors[i];
    const fc = Number(f.gridCols ?? cols);
    const fr = Number(f.gridRows ?? rows);
    if (hasWalkGridSource(f.walkGrid, f.walkGridPacked, fc, fr)) return true;
  }
  return false;
}

/** Validate saved floor JSON without eagerly decoding large walk grids. */
function parseFloorPayload(raw: unknown): NavmeFloorEditPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as NavmeFloorEditPayload;
  const cols = Number(p.cols);
  const rows = Number(p.rows);
  if (!cols || !rows) return null;
  if (!payloadHasWalkGrid(p, cols, rows)) return null;

  const floors = payloadFloorLevels(p);
  return {
    ...p,
    walkGrid: Array.isArray(p.walkGrid) ? p.walkGrid : undefined,
    walkGridPacked: typeof p.walkGridPacked === 'string' ? p.walkGridPacked : undefined,
    version: p.version ?? FLOOR_EDIT_VERSION,
    objects: cloneFloorBlocks(Array.isArray(p.objects) ? p.objects : []),
    zones: cloneFloorBlocks(Array.isArray(p.zones) ? p.zones : []),
    floors,
  };
}

function hexColorToRgbBytes(color: string): { r: number; g: number; b: number } {
  if (color.indexOf('#') === 0 && color.length >= 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return { r, g, b };
  }
  return { r: 245, g: 245, b: 245 };
}

function buildWalkGridOffscreenCanvas(
  walk: Uint8Array,
  cols: number,
  rows: number,
  color: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.createImageData(cols, rows);
  const rgb = hexColorToRgbBytes(color);
  const d = img.data;
  for (let i = 0; i < walk.length; i++) {
    if (!walk[i]) continue;
    const o = i * 4;
    d[o] = rgb.r;
    d[o + 1] = rgb.g;
    d[o + 2] = rgb.b;
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function getWalkGridBitmap(walk: Uint8Array, cols: number, rows: number, cacheKey: string): HTMLCanvasElement {
  const hit = walkGridBitmapCache.get(cacheKey);
  if (hit) return hit;
  const canvas = buildWalkGridOffscreenCanvas(walk, cols, rows, FLOOR2D_STYLE.corridor);
  walkGridBitmapCache.set(cacheKey, canvas);
  return canvas;
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

async function extractStoreMaskAsync(walk: Uint8Array, cols: number, rows: number): Promise<Uint8Array> {
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
    if (r > 0 && r % 48 === 0) await yieldToMain();
  }
  return stores;
}

async function mergeRectsAsync(
  mask: Uint8Array,
  cols: number,
  rows: number,
  minX: number,
  minZ: number,
  cell: number,
  fill: string,
  idPrefix: string,
): Promise<FloorBlock[]> {
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
    if (r > 0 && r % 32 === 0) await yieldToMain();
  }
  return blocks;
}

async function resolveFloorWalls(
  floorId: string,
  walk: Uint8Array,
  map: Floor2DMap,
): Promise<WallSeg[]> {
  const cached = getCachedFloorWalls(floorId, walk, map.cols, map.rows);
  if (cached) return cached;
  const walls = await extractWallsFromWalkAsync(
    walk,
    map.cols,
    map.rows,
    map.minX,
    map.minZ,
    map.cellSize,
  );
  cacheFloorWalls(floorId, walk, map.cols, map.rows, walls);
  return walls;
}

function resolveFloorWallsSync(
  floorId: string,
  walk: Uint8Array,
  map: Floor2DMap,
): WallSeg[] {
  const cached = getCachedFloorWalls(floorId, walk, map.cols, map.rows);
  if (cached) return cached;
  const walls = extractWallsFromWalk(
    walk,
    map.cols,
    map.rows,
    map.minX,
    map.minZ,
    map.cellSize,
  );
  cacheFloorWalls(floorId, walk, map.cols, map.rows, walls);
  return walls;
}

function applyWalkGridEdits(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  floors: FloorLevel[],
  floorId?: string | null,
): Floor2DMap {
  const cellCount = map.cols * map.rows;
  const skipCorridorMerge = cellCount > HUGE_GRID_CELLS;
  const corridors = skipCorridorMerge
    ? []
    : mergeRects(
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
  const wallKey = floorId ?? '__sync__';
  const cachedWalls = getCachedFloorWalls(wallKey, walk, map.cols, map.rows);
  let walls: WallSeg[];
  if (cachedWalls) {
    walls = cachedWalls;
  } else if (cellCount >= ASYNC_WALL_MIN_CELLS) {
    walls = [];
  } else {
    walls = resolveFloorWallsSync(wallKey, walk, map);
  }
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
    walls,
  };
}

const ASYNC_WALL_MIN_CELLS = 1800;

async function applyWalkGridEditsAsync(
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
  zones: FloorBlock[],
  floors: FloorLevel[],
  onProgress?: (msg: string) => void,
  floorId?: string | null,
): Promise<Floor2DMap> {
  const cellCount = map.cols * map.rows;
  const skipCorridorMerge = cellCount > HUGE_GRID_CELLS;
  if (cellCount >= ASYNC_WALL_MIN_CELLS) {
    onProgress?.('Building walls…');
    const walls = await resolveFloorWalls(floorId ?? '__async__', walk, map);
    await yieldToMain();
    if (skipCorridorMerge) {
      onProgress?.('Analyzing rooms…');
      const storeMask = await extractStoreMaskAsync(walk, map.cols, map.rows);
      await yieldToMain();
      const stores = await mergeRectsAsync(
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
        corridors: [],
        blocks: [],
        stores,
        objects: cloneFloorBlocks(objects),
        zones: cloneFloorBlocks(zones),
        floors: floors.map((f) => ({
          ...f,
          objects: cloneFloorBlocks(f.objects || []),
          zones: cloneFloorBlocks(f.zones || []),
        })),
        walls,
      };
    }
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
      walls,
    };
  }
  return applyWalkGridEdits(map, walk, objects, zones, floors, floorId);
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
  clearFloorWallsCache();
}

function pickActiveFloorLevel(
  payload: NavmeFloorEditPayload,
  floors: FloorLevel[],
  floorId?: string | null,
): FloorLevel | undefined {
  return (
    (floorId ? floors.find((f) => f.id === floorId) : null) ??
    floors.find((f) => !f.parentFloorId && Math.abs(f.floorY - payload.sliceY) < 1e-4) ??
    floors.find((f) => Math.abs(f.floorY - payload.sliceY) < 1e-4) ??
    topLevelFloors(floors)[0] ??
    floors[0]
  );
}

async function buildMapFromSavedPayloadWithWalk(
  payload: NavmeFloorEditPayload,
  walk: Uint8Array,
  floorId?: string | null,
  onProgress?: (msg: string) => void,
): Promise<SavedFloorBuild> {
  const floors = payloadFloorLevels(payload).map((f) => {
    const fCols = f.gridCols ?? payload.cols;
    const fRows = f.gridRows ?? payload.rows;
    const fCell = f.gridCellSize ?? payload.cellSize;
    const fMinX = f.gridMinX ?? payload.minX;
    const fMinZ = f.gridMinZ ?? payload.minZ;
    return {
      ...f,
      objects: cloneFloorBlocks(f.objects || []),
      // Clamp each floor's zones to its own plate so colour never spills outside.
      zones: clampZonesToBounds(
        cloneFloorBlocks(f.zones || []),
        fMinX,
        fMinX + fCols * fCell,
        fMinZ,
        fMinZ + fRows * fCell,
      ),
      stairMouths: f.stairMouths?.map((m) => ({ ...m })),
      gridCols: fCols,
      gridRows: fRows,
      gridCellSize: fCell,
      gridMinX: fMinX,
      gridMinZ: fMinZ,
    };
  });

  ensureStairMouthConnectivity(floors);

  const active = pickActiveFloorLevel(payload, floors, floorId);
  const sliceY = active?.floorY ?? payload.sliceY;
  const onDefaultSlice = !active || Math.abs(sliceY - payload.sliceY) < 1e-4;
  const objects = active?.objects?.length ? active.objects : onDefaultSlice ? payload.objects || [] : [];
  const rawZones = active?.zones?.length ? active.zones : onDefaultSlice ? payload.zones || [] : [];

  const mapCols = active?.gridCols ?? payload.cols;
  const mapRows = active?.gridRows ?? payload.rows;
  const mapCellSize = active?.gridCellSize ?? payload.cellSize;
  const mapMinX = active?.gridMinX ?? payload.minX;
  const mapMinZ = active?.gridMinZ ?? payload.minZ;
  // Keep zone colour inside the floor plate — clamp to the grid rectangle.
  const zones = clampZonesToBounds(
    rawZones,
    mapMinX,
    mapMinX + mapCols * mapCellSize,
    mapMinZ,
    mapMinZ + mapRows * mapCellSize,
  );
  const gridLen = mapCols * mapRows;
  if (walk.length !== gridLen) {
    return { error: 'Saved walk grid length does not match cols × rows' };
  }

  const baseMap: Floor2DMap = {
    sliceY,
    cellSize: mapCellSize,
    minX: mapMinX,
    maxX: mapMinX + mapCols * mapCellSize,
    minZ: mapMinZ,
    maxZ: mapMinZ + mapRows * mapCellSize,
    cols: mapCols,
    rows: mapRows,
    corridors: [],
    stores: [],
    objects,
    zones,
    floors,
    blocks: [],
    walls: [],
  };
  const map = await applyWalkGridEditsAsync(
    baseMap,
    walk,
    objects,
    zones,
    floors,
    onProgress,
    active?.id ?? floorId ?? null,
  );

  return {
    map,
    walk,
    objects,
    zones,
    floors,
    activeFloorId: active?.id ?? null,
  };
}

async function buildMapFromSavedPayloadAsync(
  payload: NavmeFloorEditPayload,
  floorId?: string | null,
  onProgress?: (msg: string) => void,
): Promise<SavedFloorBuild> {
  if (!payload.cols || !payload.rows) {
    return { error: 'Invalid saved floor data (missing grid)' };
  }
  if (!payloadHasWalkGrid(payload, payload.cols, payload.rows)) {
    return { error: 'Invalid saved floor data (missing grid)' };
  }

  const floors = payloadFloorLevels(payload);

  const active = pickActiveFloorLevel(payload, floors, floorId);
  const sliceY = active?.floorY ?? payload.sliceY;
  const onDefaultSlice = !active || Math.abs(sliceY - payload.sliceY) < 1e-4;

  const activeHasOwnGrid =
    !!active &&
    hasWalkGridSource(
      active.walkGrid,
      active.walkGridPacked,
      active.gridCols ?? payload.cols,
      active.gridRows ?? payload.rows,
    );

  let walk: Uint8Array | null = null;
  if (activeHasOwnGrid) {
    walk = await resolveWalkGridUint8Async(payload, active!, onProgress);
  } else if (onDefaultSlice) {
    walk = await resolveWalkGridUint8Async(payload, null, onProgress);
  } else if (active) {
    walk = await resolveWalkGridUint8Async(payload, active, onProgress);
  }

  if (!walk) {
    const label = active?.label ?? 'selected floor';
    return { error: `No saved walk grid for "${label}" — save this floor in the editor first` };
  }

  await yieldToMain();
  onProgress?.('Building map…');
  return buildMapFromSavedPayloadWithWalk(payload, walk, floorId, onProgress);
}

async function buildMapFromSavedPayloadCachedAsync(
  payload: NavmeFloorEditPayload,
  floorId?: string | null,
  onProgress?: (msg: string) => void,
): Promise<SavedFloorBuild> {
  const key = floorId ?? '__default__';
  const cached = floorBuildCache.get(key);
  if (cached) return cached;
  const built = await buildMapFromSavedPayloadAsync(payload, floorId, onProgress);
  if (!('error' in built)) floorBuildCache.set(key, built);
  return built;
}

async function preloadOtherFloorWalkGrids(
  payload: NavmeFloorEditPayload,
  activeFloorId: string | null,
): Promise<void> {
  const floors = payloadFloorLevels(payload);
  for (let i = 0; i < floors.length; i++) {
    const floor = floors[i];
    if (floor.id === activeFloorId) continue;
    const cols = floor.gridCols ?? payload.cols;
    const rows = floor.gridRows ?? payload.rows;
    if (!hasWalkGridSource(floor.walkGrid, floor.walkGridPacked, cols, rows)) continue;
    await resolveWalkGridUint8Async(payload, floor);
    await yieldToMain();
  }
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

/** Object yaw from the 2D editor, in radians. */
function objectRotationRad(o: FloorBlock): number {
  return ((o.rotation ?? 0) * Math.PI) / 180;
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

function zoneBounds(z: FloorBlock): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (isPolygonZone(z) && z.points && z.points.length >= 3) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < z.points.length; i++) {
      const p = z.points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, maxX, minZ, maxZ };
  }
  return { minX: z.x, maxX: z.x + z.w, minZ: z.z, maxZ: z.z + z.d };
}

function endpointMatchesQuery(label: string, q: string): boolean {
  if (!q) return true;
  const hay = label.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  for (let i = 0; i < terms.length; i++) {
    if (!hay.includes(terms[i])) return false;
  }
  return true;
}

function truncateLabel(label: string, maxLen: number): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + '…';
}

/** Truncate text so it measures ≤ maxWidth with the current ctx.font. */
function fitTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text || maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  if (ctx.measureText(ellipsis).width > maxWidth) return '';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? ellipsis : text.slice(0, lo) + ellipsis;
}

function hypot2(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

// FLOOR GRID ROUTING (A* on saved walk grid)

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

const floorNavGridCache = new Map<string, Uint8Array>();

function floorNavGridCacheKey(
  floorKey: string,
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
): string {
  let rotKey = '';
  for (let i = 0; i < objects.length; i++) {
    const r = objects[i].rotation;
    if (r) rotKey += `${objects[i].id}:${r};`;
  }
  return `${floorKey}|${map.cols}x${map.rows}|${walk.length}|${objects.length}|${rotKey}`;
}

function getFloorNavGridCached(
  floorKey: string,
  map: Floor2DMap,
  walk: Uint8Array,
  objects: FloorBlock[],
): Uint8Array {
  const key = floorNavGridCacheKey(floorKey, map, walk, objects);
  const hit = floorNavGridCache.get(key);
  if (hit && hit.length === map.cols * map.rows) return hit;
  const nav = buildFloorNavGrid(map, walk, objects);
  floorNavGridCache.set(key, nav);
  return nav;
}

function clearFloorNavGridCache(): void {
  floorNavGridCache.clear();
}

function countWalkCells(walk: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < walk.length; i++) if (walk[i]) n++;
  return n;
}

function isLargeFloorMap(map: Floor2DMap, walk: Uint8Array): boolean {
  return map.cols * map.rows >= LARGE_MAP_CELL_COUNT || countWalkCells(walk) >= INSTANCED_FLOOR_TILE_MAX;
}

/** Spatial hash for fast nearby POI lookup (167+ POIs). */
class PoiSpatialGrid {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, NavMapPoi[]>();

  constructor(pois: NavMapPoi[], cellSize = POI_SPATIAL_CELL) {
    this.cellSize = Math.max(4, cellSize);
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      const key = this.keyFor(p.x, p.z);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(p);
      else this.buckets.set(key, [p]);
    }
  }

  private keyFor(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }

  query(x: number, z: number, maxDist: number, limit: number): { poi: NavMapPoi; dist: number }[] {
    const radiusCells = Math.max(1, Math.ceil(maxDist / this.cellSize));
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const out: { poi: NavMapPoi; dist: number }[] = [];
    const maxDistSq = maxDist * maxDist;
    for (let dz = -radiusCells; dz <= radiusCells; dz++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const bucket = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];
          const distSq = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (distSq <= maxDistSq) out.push({ poi: p, dist: Math.sqrt(distSq) });
        }
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, limit);
  }
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
  floorKey?: string,
): { x: number; z: number } | null {
  const nav = floorKey
    ? getFloorNavGridCached(floorKey, map, walk, objects)
    : buildFloorNavGrid(map, walk, objects);
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

function walkLineClear(
  map: Floor2DMap,
  nav: Uint8Array,
  from: FloorRouteCell,
  to: FloorRouteCell,
): boolean {
  let c0 = from.c;
  let r0 = from.r;
  const c1 = to.c;
  const r1 = to.r;
  const dc = Math.abs(c1 - c0);
  const dr = Math.abs(r1 - r0);
  const sc = c0 < c1 ? 1 : -1;
  const sr = r0 < r1 ? 1 : -1;
  let err = dc - dr;

  while (true) {
    if (!isWalkable(nav, map, c0, r0)) return false;
    if (c0 === c1 && r0 === r1) return true;

    const e2 = 2 * err;
    let nc = c0;
    let nr = r0;
    if (e2 > -dr) {
      err -= dr;
      nc += sc;
    }
    if (e2 < dc) {
      err += dc;
      nr += sr;
    }

    if (nc !== c0 && nr !== r0) {
      if (!isWalkable(nav, map, nc, r0) || !isWalkable(nav, map, c0, nr)) return false;
    }

    c0 = nc;
    r0 = nr;
  }
}

function stringPullPathCells(
  cells: FloorRouteCell[],
  map: Floor2DMap,
  nav: Uint8Array,
): FloorRouteCell[] {
  if (cells.length <= 2) return cells;

  const out: FloorRouteCell[] = [cells[0]];
  let anchor = 0;

  for (let i = 1; i < cells.length; i++) {
    if (walkLineClear(map, nav, cells[anchor], cells[i])) continue;

    const shortcut = cells[i - 1];
    const last = out[out.length - 1];
    if (last.c !== shortcut.c || last.r !== shortcut.r) {
      out.push(shortcut);
    }
    anchor = i - 1;

    if (!walkLineClear(map, nav, cells[anchor], cells[i])) {
      out.push(cells[i]);
      anchor = i;
    }
  }

  const end = cells[cells.length - 1];
  const last = out[out.length - 1];
  if (last.c !== end.c || last.r !== end.r) out.push(end);
  return out;
}

function simplifyWorldPathXZ(path: FloorPathPoint[], eps = 0.15): FloorPathPoint[] {
  if (path.length <= 2) return path;

  const out: FloorPathPoint[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1];
    const b = path[i];
    const c = path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const acx = c.x - a.x;
    const acz = c.z - a.z;
    const abLenSq = abx * abx + abz * abz;
    if (abLenSq < 1e-8) continue;

    const t = (acx * abx + acz * abz) / abLenSq;
    const px = a.x + abx * t;
    const pz = a.z + abz * t;
    const dx = c.x - px;
    const dz = c.z - pz;
    if (dx * dx + dz * dz > eps * eps) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

function buildClearanceGrid(nav: Uint8Array, map: Floor2DMap): Float32Array {
  const total = map.cols * map.rows;
  const clearance = new Float32Array(total);
  const queue: number[] = [];

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const i = cellIndex(map, c, r);
      if (nav[i]) {
        clearance[i] = Infinity;
      } else {
        clearance[i] = 0;
        queue.push(i);
      }
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const cr = Math.floor(idx / map.cols);
    const cc = idx % map.cols;
    const base = clearance[idx];
    for (let n = 0; n < NEIGHBORS_8.length; n++) {
      const { dc, dr, cost } = NEIGHBORS_8[n];
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
      const ni = cellIndex(map, nc, nr);
      if (!nav[ni]) continue;
      const next = base + cost;
      if (next < clearance[ni]) {
        clearance[ni] = next;
        queue.push(ni);
      }
    }
  }
  return clearance;
}

/** Nudge interior waypoints toward the widest part of each corridor. */
function centerPathInCorridors(
  path: FloorPathPoint[],
  map: Floor2DMap,
  nav: Uint8Array,
  clearance: Float32Array,
): FloorPathPoint[] {
  if (path.length < 3) return path;

  const out: FloorPathPoint[] = path.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  const search = 5;

  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1];
    const next = out[i + 1];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;

    const tx = dx / len;
    const tz = dz / len;
    const px = -tz;
    const pz = tx;
    const cell = worldToCell(map, out[i].x, out[i].z);
    if (!cell) continue;

    let bestC = cell.c;
    let bestR = cell.r;
    let bestCl = clearance[cellIndex(map, cell.c, cell.r)];
    const maxOff = map.cellSize * search;

    for (let dr = -search; dr <= search; dr++) {
      for (let dc = -search; dc <= search; dc++) {
        const nc = cell.c + dc;
        const nr = cell.r + dr;
        if (!isWalkable(nav, map, nc, nr)) continue;
        const center = cellCenter(map, nc, nr);
        const along = (center.x - out[i].x) * tx + (center.z - out[i].z) * tz;
        if (Math.abs(along) > map.cellSize * 2.2) continue;
        const perp = (center.x - out[i].x) * px + (center.z - out[i].z) * pz;
        if (Math.abs(perp) > maxOff) continue;
        const cl = clearance[cellIndex(map, nc, nr)];
        if (cl > bestCl) {
          bestCl = cl;
          bestC = nc;
          bestR = nr;
        }
      }
    }

    const best = cellCenter(map, bestC, bestR);
    out[i].x = best.x;
    out[i].z = best.z;
  }
  return out;
}

function cornerRadiusForClearance(clearance: number, cellSize: number): number {
  return Math.min(cellSize * 0.55, Math.max(cellSize * 0.22, clearance * cellSize * 0.42));
}

/** Replace sharp corners with evenly-sampled circular arcs (smooth turns, no kinks). */
function filletPathCornersArc(
  path: FloorPathPoint[],
  map: Floor2DMap,
  clearance: Float32Array,
  arcSteps = 7,
): FloorPathPoint[] {
  if (path.length < 3) return path;

  const out: FloorPathPoint[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];
    const v1x = curr.x - prev.x;
    const v1z = curr.z - prev.z;
    const v2x = next.x - curr.x;
    const v2z = next.z - curr.z;
    const len1 = Math.hypot(v1x, v1z);
    const len2 = Math.hypot(v2x, v2z);
    if (len1 < 1e-4 || len2 < 1e-4) {
      out.push(curr);
      continue;
    }

    const n1x = v1x / len1;
    const n1z = v1z / len1;
    const n2x = v2x / len2;
    const n2z = v2z / len2;
    const dot = n1x * n2x + n1z * n2z;
    if (dot > 0.94) {
      out.push(curr);
      continue;
    }

    const cell = worldToCell(map, curr.x, curr.z);
    const localClearance = cell ? clearance[cellIndex(map, cell.c, cell.r)] : map.cellSize;
    const radius = Math.min(
      cornerRadiusForClearance(localClearance, map.cellSize),
      len1 * 0.4,
      len2 * 0.4,
    );
    if (radius < map.cellSize * 0.08) {
      out.push(curr);
      continue;
    }

    const t1x = curr.x - n1x * radius;
    const t1z = curr.z - n1z * radius;
    const t2x = curr.x + n2x * radius;
    const t2z = curr.z + n2z * radius;
    const cross = n1x * n2z - n1z * n2x;
    const turn = cross >= 0 ? 1 : -1;
    const perpX = -n1z * turn;
    const perpZ = n1x * turn;
    const cx = t1x + perpX * radius;
    const cz = t1z + perpZ * radius;

    const a0 = Math.atan2(t1z - cz, t1x - cx);
    let a1 = Math.atan2(t2z - cz, t2x - cx);
    if (turn > 0) {
      while (a1 <= a0) a1 += Math.PI * 2;
    } else {
      while (a1 >= a0) a1 -= Math.PI * 2;
    }

    out.push({ x: t1x, y: curr.y, z: t1z });
    for (let s = 1; s < arcSteps; s++) {
      const t = s / arcSteps;
      const ang = a0 + (a1 - a0) * t;
      out.push({
        x: cx + Math.cos(ang) * radius,
        y: curr.y,
        z: cz + Math.sin(ang) * radius,
      });
    }
    out.push({ x: t2x, y: curr.y, z: t2z });
  }
  out.push(path[path.length - 1]);
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
  cachedNav?: Uint8Array,
): { path: FloorPathPoint[] } | { error: string } {
  const nav = cachedNav ?? buildFloorNavGrid(map, walk, objects);
  const clearance = buildClearanceGrid(nav, map);
  const clearanceBias = 0.28;
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

  const openHeap = new AStarOpenHeap(fScore);
  const openSet = new Uint8Array(total);
  openHeap.push(startIdx);
  openSet[startIdx] = 1;

  while (openHeap.length > 0) {
    const current = openHeap.pop()!;
    if (current === endIdx) {
      const raw = reconstructPath(cameFrom, endIdx, map);
      const cells = stringPullPathCells(simplifyCollinear(raw), map, nav);
      let worldPath = cellsToWorldPath(cells, map, floorY);
      worldPath = centerPathInCorridors(worldPath, map, nav, clearance);
      worldPath = filletPathCornersArc(
        simplifyWorldPathXZ(worldPath),
        map,
        clearance,
      );
      return { path: worldPath };
    }
    if (closed[current]) continue;
    closed[current] = 1;
    openSet[current] = 0;

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

      const cl = clearance[neighbor];
      const wallPenalty = cl < 0.6 ? 2.4 : clearanceBias / (cl + 0.35);
      const tentative = gScore[current] + cost + wallPenalty;
      if (tentative >= gScore[neighbor]) continue;

      cameFrom[neighbor] = current;
      gScore[neighbor] = tentative;
      fScore[neighbor] = tentative + heuristic({ c: nc, r: nr }, endCell);
      if (!openSet[neighbor]) {
        openSet[neighbor] = 1;
        openHeap.push(neighbor);
      }
    }
  }

  return { error: 'No path on floor — cut a corridor or move obstacles' };
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-FLOOR ROUTING (stair mouths + per-floor walk grid)
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
/** Max horizontal gap for auto-pairing unlinked mouths on adjacent floors. */
const STAIR_MOUTH_AUTO_LINK_XZ = 24;

function getStairMouthById(floor: FloorLevel, id: string): StairMouth | null {
  return floor.stairMouths?.find((m) => m.id === id) ?? null;
}

/** Bidirectional link between two mouths on different floors. */
function linkStairMouths(
  floors: FloorLevel[],
  floorAId: string,
  mouthAId: string,
  floorBId: string,
  mouthBId: string,
): boolean {
  const floorA = floors.find((f) => f.id === floorAId);
  const floorB = floors.find((f) => f.id === floorBId);
  const mouthA = floorA ? getStairMouthById(floorA, mouthAId) : null;
  const mouthB = floorB ? getStairMouthById(floorB, mouthBId) : null;
  if (!mouthA || !mouthB) return false;
  mouthA.linkedFloorId = floorBId;
  mouthA.linkedMouthId = mouthBId;
  mouthB.linkedFloorId = floorAId;
  mouthB.linkedMouthId = mouthAId;
  return true;
}

/** Auto-pair an unlinked mouth with the nearest unlinked mouth on another floor. */
function tryAutoLinkStairMouth(
  floors: FloorLevel[],
  floor: FloorLevel,
  mouth: StairMouth,
): boolean {
  const others = floors
    .filter((f) => f.id !== floor.id)
    .sort((a, b) => Math.abs(a.floorY - floor.floorY) - Math.abs(b.floorY - floor.floorY));

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

/**
 * Repair broken one-way links and auto-connect unlinked stair mouths
 * (same rules as the 2D floor editor).
 */
function ensureStairMouthConnectivity(floors: FloorLevel[]): void {
  if (!floorsHaveStairMouths(floors)) return;

  for (const floor of floors) {
    for (const mouth of floor.stairMouths ?? []) {
      if (!mouth.linkedFloorId || !mouth.linkedMouthId) continue;
      const partnerFloor = floors.find((f) => f.id === mouth.linkedFloorId);
      const partner = partnerFloor ? getStairMouthById(partnerFloor, mouth.linkedMouthId) : null;
      if (partner) {
        if (partner.linkedFloorId !== floor.id || partner.linkedMouthId !== mouth.id) {
          partner.linkedFloorId = floor.id;
          partner.linkedMouthId = mouth.id;
        }
      } else {
        mouth.linkedFloorId = undefined;
        mouth.linkedMouthId = undefined;
      }
    }
  }

  let linked = true;
  while (linked) {
    linked = false;
    for (const floor of floors) {
      for (const mouth of floor.stairMouths ?? []) {
        if (mouth.linkedMouthId) continue;
        if (tryAutoLinkStairMouth(floors, floor, mouth)) linked = true;
      }
    }
  }
}

function addStairMouthMarkers3d(
  group: THREE.Group,
  mouths: StairMouth[] | undefined,
  floorY: number,
): void {
  if (!mouths?.length) return;
  for (let i = 0; i < mouths.length; i++) {
    const mouth = mouths[i];
    const linked = !!(mouth.linkedFloorId && mouth.linkedMouthId);
    const color = linked ? STAIR_MOUTH_LINK_COLOR : STAIR_MOUTH_MARKER_COLOR;
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.045, 20),
      new THREE.MeshStandardMaterial({
        color: hex(color),
        emissive: hex(color),
        emissiveIntensity: linked ? 0.45 : 0.25,
        roughness: 0.35,
      }),
    );
    disc.position.set(mouth.x, floorY + 0.055, mouth.z);
    group.add(disc);
    if (linked) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.38, 0.52, 24),
        new THREE.MeshBasicMaterial({
          color: hex(STAIR_MOUTH_LINK_COLOR),
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(mouth.x, floorY + 0.078, mouth.z);
      group.add(ring);
    }
  }
}

function addStairMouthLinkLines3d(group: THREE.Group, floors: FloorDisplayLayer[]): void {
  const drawn = new Set<string>();
  for (let fi = 0; fi < floors.length; fi++) {
    const layer = floors[fi];
    const mouths = layer.stairMouths;
    if (!mouths?.length) continue;
    for (let mi = 0; mi < mouths.length; mi++) {
      const mouth = mouths[mi];
      if (!mouth.linkedFloorId || !mouth.linkedMouthId) continue;
      const key = [layer.floorId, mouth.id, mouth.linkedFloorId, mouth.linkedMouthId].sort().join('|');
      if (drawn.has(key)) continue;
      drawn.add(key);
      const partnerLayer = floors.find((f) => f.floorId === mouth.linkedFloorId);
      const partner = partnerLayer?.stairMouths?.find((m) => m.id === mouth.linkedMouthId);
      if (!partner || !partnerLayer) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(mouth.x, layer.displayY + 0.12, mouth.z),
        new THREE.Vector3(partner.x, partnerLayer.displayY + 0.12, partner.z),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: hex(STAIR_MOUTH_LINK_COLOR) }),
      );
      line.renderOrder = 6;
      group.add(line);
    }
  }
}

type MultiFloorRoutePlan = {
  multiFloor: boolean;
  segments: FloorRouteSegment[];
  connectors: FloorRouteConnector[];
  error?: string;
};

function floorForY(y: number, floors: FloorLevel[]): FloorLevel | null {
  return floorLevelForPoiY(y, floors);
}

function getFloorWalkGrid(map: Floor2DMap, floor: FloorLevel): Uint8Array | null {
  const need = map.cols * map.rows;
  const cached = getCachedWalkGrid(floor.id, need);
  if (cached) return cached;
  const rootCached = getCachedWalkGrid('__root__', need);
  if (rootCached) return rootCached;
  if (
    !floor.walkGrid ||
    floor.gridCols !== map.cols ||
    floor.gridRows !== map.rows ||
    floor.walkGrid.length !== need
  ) {
    if (typeof floor.walkGridPacked === 'string' && floor.walkGridPacked.length > 0) {
      const decoded = decodeWalkGridPackedToUint8(
        floor.walkGridPacked,
        floor.gridCols ?? map.cols,
        floor.gridRows ?? map.rows,
      );
      if (decoded && decoded.length === need) return decoded;
    }
    return null;
  }
  return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
}

function previewMapForFloor(
  map: Floor2DMap,
  floor: FloorLevel,
  allFloors: FloorLevel[],
  activeWalk?: Uint8Array | null,
  activeFloorId?: string | null,
): Floor2DMap {
  const floorMap = routingMapForFloor(map, floor);
  const walk = resolveFloorWalkGridEmbed(floorMap, floor, activeWalk ?? null, activeFloorId ?? null);
  if (!walk) return floorMap;
  return applyWalkGridEdits(floorMap, walk, floor.objects ?? [], floor.zones ?? [], allFloors);
}

async function previewMapForFloorAsync(
  map: Floor2DMap,
  floor: FloorLevel,
  allFloors: FloorLevel[],
  walk: Uint8Array,
  onProgress?: (msg: string) => void,
): Promise<Floor2DMap> {
  const floorMap = routingMapForFloor(map, floor);
  return applyWalkGridEditsAsync(
    floorMap,
    walk,
    floor.objects ?? [],
    floor.zones ?? [],
    allFloors,
    onProgress,
    floor.id,
  );
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
  const need = (cols ?? map.cols) * (rows ?? map.rows);
  const hasGrid =
    (floor.walkGrid?.length === need) ||
    (typeof floor.walkGridPacked === 'string' && floor.walkGridPacked.length > 0) ||
    !!getCachedWalkGrid(floor.id, need) ||
    !!getCachedWalkGrid('__root__', need);
  if (cols && rows && hasGrid) {
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
  const cached = getCachedWalkGrid(floor.id, need);
  if (cached) return cached;
  const rootCached = getCachedWalkGrid('__root__', need);
  if (rootCached && floorMap.cols === map.cols && floorMap.rows === map.rows) return rootCached;
  if (floor.walkGrid?.length === need) {
    return new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
  }
  if (typeof floor.walkGridPacked === 'string' && floor.walkGridPacked.length > 0) {
    const decoded = decodeWalkGridPackedToUint8(
      floor.walkGridPacked,
      floorMap.cols,
      floorMap.rows,
    );
    if (decoded && decoded.length === need) {
      walkGridCache.set(walkGridCacheKey(floor.id), decoded);
      return decoded;
    }
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
    return snapWorldToWalkCell(floorMap, walk, objects, wx, wz, floor.id);
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
  const cachedNav = getFloorNavGridCached(floor.id, floorMap, walk, floor.objects ?? []);
  return findPathOnFloorGrid(
    floorMap,
    walk,
    floor.objects ?? [],
    startX,
    startZ,
    endX,
    endZ,
    floor.floorY,
    cachedNav,
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

/** Force each floor leg to start/end at origin, stair mouth, or destination. */
function stampSegmentLegEndpoints(
  path: FloorPathPoint[],
  floorY: number,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
): FloorPathPoint[] {
  if (path.length < 2) {
    return [
      { x: startX, y: floorY, z: startZ },
      { x: endX, y: floorY, z: endZ },
    ];
  }
  const out = path.map((p) => ({ ...p }));
  out[0] = { x: startX, y: floorY, z: startZ };
  out[out.length - 1] = { x: endX, y: floorY, z: endZ };
  return out;
}

export function computeStairMouthRouteEmbed(
  map: Floor2DMap,
  floors: FloorLevel[],
  origin: Vec3,
  destination: Vec3,
  activeWalk: Uint8Array | null,
  activeFloorId: string | null,
): MultiFloorRoutePlan {
  ensureStairMouthConnectivity(floors);

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
    path = stampSegmentLegEndpoints(
      path,
      leg.floor.floorY,
      leg.startX,
      leg.startZ,
      leg.endX,
      leg.endZ,
    );
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

// 3D FLOOR SCENE (from saved walk grid)
// ═══════════════════════════════════════════════════════════════════════════

type Scene3dPalette = {
  sceneBg: string;
  floor: string;
  corridor: string;
  floorCorridors: string[];
  borderWall: string;
  borderWallTop: string;
  interiorBlock: string;
  interiorBlockTop: string;
  interiorBlockSide: string;
  interiorWall: string;
  interiorWallTop: string;
  interiorWallLine: string;
  zoneLabel: string;
  route: string;
  routeGreen: string;
  routeYellow: string;
  routeHalo: string;
  routeGlow: string;
  sceneAccent: string;
  poi: string;
  poiLabel: string;
  origin: string;
  destination: string;
  highlight: string;
  zoneTints: string[];
  roomFills: string[];
};

/** Walkable floor mesh colour (corridor grid / room tops) — not the scene background. */
const WALK_FLOOR_3D = MAP_PALETTE.floor;

/** 3D scene palette — LIGHT: white paper + white glass walls. */
const SCENE3D_LIGHT: Scene3dPalette = {
  sceneBg: '#FFFFFF',
  floor: WALK_FLOOR_3D,
  corridor: WALK_FLOOR_3D,
  floorCorridors: ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
  borderWall: MAP_PALETTE.borderWall,
  borderWallTop: MAP_PALETTE.borderWallTop,
  interiorBlock: MAP_PALETTE.interiorBlock,
  interiorBlockTop: MAP_PALETTE.interiorBlockTop,
  interiorBlockSide: MAP_PALETTE.interiorBlockSide,
  interiorWall: MAP_PALETTE.interiorWall,
  interiorWallTop: MAP_PALETTE.interiorWallTop,
  interiorWallLine: '#3D6AA8',
  zoneLabel: MAP_PALETTE.zoneLabel,
  route: NAV_ROUTE_VIVID,
  routeGreen: NAV_ROUTE_VIVID,
  routeYellow: NAV_ROUTE_VIVID,
  routeHalo: NAV_ROUTE_BLUE_LIGHT,
  routeGlow: NAV_ROUTE_BLUE_LIGHT,
  sceneAccent: NAV_ROUTE_VIVID,
  poi: '#5b6675',
  poiLabel: MAP_PALETTE.poiLabel,
  origin: NAV_MARKER_NAVY,
  destination: NAV_MARKER_NAVY_BRIGHT,
  highlight: '#BCE4CA',
  zoneTints: ['#DDECE0', '#D4E6D8', '#D0E4D4', '#C8E0CC', '#C4DCC8', '#D0E4D4'],
  roomFills: ['#D0E4D4', '#CCE0D0', '#C8DCCC', '#C4D8C8', '#D4E8D8', '#C8E0CC'],
};

/** 3D scene palette — DARK: NavMe navy void + blue pencil walls on white floors. */
const SCENE3D_DARK: Scene3dPalette = {
  sceneBg: NAVME_DARK_BG,
  floor: '#FFFFFF',
  corridor: '#FFFFFF',
  floorCorridors: ['#FFFFFF', '#F7FAFE', '#FFFFFF'],
  borderWall: SKETCH_INK_DARK,
  borderWallTop: '#6A8FB8',
  interiorBlock: '#E2EBF6',
  interiorBlockTop: SKETCH_INK_PALE,
  interiorBlockSide: SKETCH_INK,
  interiorWall: '#5A7AAD',
  interiorWallTop: SKETCH_INK_LIGHT,
  interiorWallLine: SKETCH_INK,
  zoneLabel: '#D6E4F8',
  route: NAV_ROUTE_BLACK_GREEN_BRIGHT,
  routeGreen: NAV_ROUTE_BLACK_GREEN,
  routeYellow: NAV_ROUTE_GLOSS_HIGHLIGHT,
  routeHalo: NAV_ROUTE_GLOSS_HIGHLIGHT,
  routeGlow: NAV_ROUTE_GLOSS_HIGHLIGHT,
  sceneAccent: NAVME_UI_BLUE_BRIGHT,
  poi: '#A8C4E8',
  poiLabel: '#E8EEF8',
  origin: NAV_MARKER_NAVY,
  destination: NAV_MARKER_NAVY_BRIGHT,
  highlight: SKETCH_INK_WASH,
  zoneTints: ['#1A2838', '#1E2C40', '#182436', '#1C2A3C', '#162232', '#202E44'],
  roomFills: ['#EAF1FA', '#E2EBF6', '#DCE6F4', '#E8F0FA', '#E0EAF6', '#EAF1FA'],
};

/**
 * Active 3D scene palette. Mutated in place on theme change so every existing
 * `SCENE3D_STYLE.*` reference automatically reads the current theme's colours.
 */
const SCENE3D_STYLE: Scene3dPalette = { ...SCENE3D_LIGHT };

function applyScene3dPalette(theme: WayfinderTheme): void {
  Object.assign(SCENE3D_STYLE, theme === 'dark' ? SCENE3D_DARK : SCENE3D_LIGHT);
}

// ─────────────────────────────────────────────────────────────────────────
// Wayfinder theming (dark default + light) — drives UI chrome CSS variables
// and the 3D scene background so the whole app can flip themes at runtime.
// ─────────────────────────────────────────────────────────────────────────
type WayfinderTheme = 'dark' | 'light';
/** White / light theme by default. */
let wayfinderTheme: WayfinderTheme = 'light';
const wayfinderThemeListeners = new Set<(t: WayfinderTheme) => void>();

function onWayfinderTheme(fn: (t: WayfinderTheme) => void): () => void {
  wayfinderThemeListeners.add(fn);
  return () => {
    wayfinderThemeListeners.delete(fn);
  };
}

function getWalkFloor3dColor(): string {
  return SCENE3D_STYLE.floor;
}

function sanitizeFloorSurfaceColor(color: string): string {
  if (!color || color === 'transparent') return getWalkFloor3dColor();
  if (isNearWhiteColor(color) || isGenericObjectFill(color)) return getWalkFloor3dColor();
  const rgb = parseHexRgb(color);
  if (rgb && rgb.r >= 0xd6 && rgb.g >= 0xd6 && rgb.b >= 0xd6) return getWalkFloor3dColor();
  return color;
}

/** 3D scene clear colour — follows the active themed scene palette. */
function getSceneBgColor(): string {
  return SCENE3D_STYLE.sceneBg;
}

function setWayfinderTheme(next: WayfinderTheme): void {
  wayfinderTheme = next;
  // Swap the 3D map palette FIRST so scene-rebuild listeners read new colours.
  applyScene3dPalette(next);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-wf-theme', next);
    if (document.body) document.body.setAttribute('data-wf-theme', next);
    try {
      localStorage.setItem('wayfinder-theme', next);
    } catch {
      /* storage may be unavailable */
    }
  }
  wayfinderThemeListeners.forEach((fn) => {
    try {
      fn(next);
    } catch {
      /* listener errors must not break theme switching */
    }
  });
}

function initWayfinderTheme(): void {
  if (typeof document === 'undefined') return;
  setWayfinderTheme('light');
}

/** Glass-building walls — moderate height. */
const BORDER_WALL_HEIGHT = 1.75;
/** Interior walls match exterior height so rooms read as full glass walls. */
const INTERIOR_WALL_POP_HEIGHT = BORDER_WALL_HEIGHT;
const INTERIOR_ROOM_FILL_HEIGHT = 0.42;
const INTERIOR_WALL_CAP_HEIGHT = 0.08;
/** Thin glass panes. */
const BORDER_WALL_THICKNESS = 0.055;
const INTERIOR_WALL_THICKNESS = 0.045;
const FLOOR_THICKNESS = 0.08;
/** Furniture stays low — not scaled with tall glass walls. */
const OBJECT_BLOCK_HEIGHT = 0.52;
/** Route ribbon sits above furniture so it stays visible in 3D. */
const ROUTE_LIFT = OBJECT_BLOCK_HEIGHT + 0.08;
/** Slight tilt off straight-down so orbit drag is not gimbal-locked after route framing. */
const ROUTE_VIEW_POLAR = 0.08;
/** Flip navigation camera 180° on Y so the route reads from the user side. */
const NAV_CAMERA_Y_ROTATION = Math.PI;
/** Scale for 3D start arrow / destination pin on the route. */
const NAV_ENDPOINT_MARKER_SCALE = 1.45;
/** Destination pin — smaller than the start ring. */
const NAV_DEST_PIN_SCALE = NAV_ENDPOINT_MARKER_SCALE * 0.72;
/** Zone name labels sit on top of object blocks, not on the floor beneath them. */
const ZONE_LABEL_LIFT = OBJECT_BLOCK_HEIGHT + 0.06;
/** Zone labels on the floor — max visible characters before ellipsis. */
const ZONE_LABEL_MAX_CHARS = 20;
/** Zone tap framing: mild pull-back so labels stay on-screen (not over-zoomed). */
const ZONE_FOCUS_ZOOM_RELAX = 1.35;
/** Hard cap on 2D canvas scale when focusing a zone (prevents text leaving the viewport). */
const ZONE_FOCUS_MAX_SCALE = 22;

/**
 * Extra world padding so a zone's full name label fits in the focus frame
 * (selected labels can extend past the zone box).
 */
function zoneLabelFocusPadding(zone: FloorBlock): { padX: number; padZ: number } {
  const raw = zone.label?.trim() || '';
  const b = zoneBounds(zone);
  const zoneW = Math.max(0.4, b.maxX - b.minX);
  const zoneD = Math.max(0.4, b.maxZ - b.minZ);
  if (!raw) {
    return { padX: Math.max(1.4, zoneW * 0.2), padZ: Math.max(1.4, zoneD * 0.2) };
  }
  // Match full-name pill sizing used by makeZoneFloorLabelMesh({ fullName: true }).
  const labelW = Math.min(14, Math.max(2.8, raw.length * 0.4));
  const labelH = 1.05;
  const padX = Math.max(1.6, (labelW - zoneW) * 0.5 + 1.35);
  const padZ = Math.max(1.6, (labelH - zoneD) * 0.5 + 1.35);
  return { padX, padZ };
}

/**
 * 2D focus padding — based on the zone box only.
 * Do not expand for long labels (that zoomed the map out too wide).
 */
function zoneLabelFocusPadding2d(zone: FloorBlock): { padX: number; padZ: number } {
  const b = zoneBounds(zone);
  const zoneW = Math.max(0.4, b.maxX - b.minX);
  const zoneD = Math.max(0.4, b.maxZ - b.minZ);
  return {
    padX: Math.max(1.2, zoneW * 0.22),
    padZ: Math.max(1.2, zoneD * 0.22),
  };
}

function formatZoneLabelText(label: string | undefined): string {
  const text = label?.trim() || '';
  if (!text) return '';
  if (text.length <= ZONE_LABEL_MAX_CHARS) return text;
  return text.slice(0, ZONE_LABEL_MAX_CHARS) + '…';
}
// Navigation route ribbon on the floor.
const ROUTE_RADIUS = 0.065;
const ROUTE_HALO_SCALE = 1.6;
const ROUTE_CORE_SCALE = 0.5;
const PLATE_THICKNESS = 0.14;
/** Allow 2D canvas page + 3D orbit; 2D button switches between them. */
const MAP_VIEW_3D_ONLY = false;
/** Fallback visual step only when floorY values are missing/identical. Prefer real floorY. */
const STACK_PLATE_STEP = 3.2;
const STACK_BORDER_WALL_HEIGHT = 0.85;
const STACK_INTERIOR_WALL_POP_HEIGHT = STACK_BORDER_WALL_HEIGHT;
const STACK_INTERIOR_ROOM_FILL_HEIGHT = 0.1;
const STACK_INTERIOR_WALL_CAP_HEIGHT = 0.03;
const PLAN_LINE_LIFT = 0.052;

/** CSS pixels covered by the bottom nav panel over the map (for camera framing). */
function measureMapBottomInsetPx(mapEl: HTMLElement): number {
  if (typeof document === 'undefined') return 0;
  const mapRect = mapEl.getBoundingClientRect();
  if (mapRect.height < 1) return 0;
  let inset = 0;
  const stack = document.querySelector('.mini3dgta-fs-bottom-stack');
  if (stack) {
    const sr = stack.getBoundingClientRect();
    const overlap = mapRect.bottom - sr.top + 12;
    if (overlap > 0) inset = Math.max(inset, overlap);
  }
  return Math.min(inset, mapRect.height * 0.58);
}

function hex(color: string): THREE.Color {
  return new THREE.Color(color as THREE.ColorRepresentation);
}

const sketchHatchTextureCache = new Map<string, THREE.CanvasTexture>();

type SketchHatchOpts = {
  angle?: number;
  spacing?: number;
  lineWidth?: number;
  cross?: boolean;
  repeat?: number;
};

function getSketchHatchTexture(
  lineColor: string,
  bgColor: string,
  opts?: SketchHatchOpts,
): THREE.CanvasTexture {
  const angle = opts?.angle ?? 48;
  const spacing = opts?.spacing ?? 8;
  const lineWidth = opts?.lineWidth ?? 1.15;
  const cross = opts?.cross ?? false;
  const repeat = opts?.repeat ?? 4;
  const key = `${lineColor}|${bgColor}|${angle}|${spacing}|${lineWidth}|${cross}|${repeat}`;
  const cached = sketchHatchTextureCache.get(key);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

  const drawHatch = (deg: number) => {
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = lineWidth;
    ctx.translate(size / 2, size / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.translate(-size / 2, -size / 2);
    const span = size * 2;
    for (let i = -span; i < span; i += spacing) {
      ctx.beginPath();
      ctx.moveTo(i, -span);
      ctx.lineTo(i + span, span);
      ctx.stroke();
    }
    ctx.restore();
  };

  drawHatch(angle);
  if (cross) drawHatch(-angle);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  sketchHatchTextureCache.set(key, tex);
  return tex;
}

function sketchHatchMat(
  lineColor: string,
  bgColor: string,
  opts?: SketchHatchOpts,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: getSketchHatchTexture(lineColor, bgColor, opts),
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
}

/** Blueprint blue ink for wall edges + vertical stripes. */
const WALL_EDGE_BLUE = '#3D6AA8';
const WALL_EDGE_BLUE_DARK = '#2A4F82';

/** Vertical blue stripe paint for wall faces. */
function getVerticalStripeTexture(
  lineColor: string,
  bgColor: string,
  opts?: { spacing?: number; lineWidth?: number; repeatX?: number; repeatY?: number },
): THREE.CanvasTexture {
  const spacing = opts?.spacing ?? 10;
  const lineWidth = opts?.lineWidth ?? 1.6;
  const repeatX = opts?.repeatX ?? 6;
  const repeatY = opts?.repeatY ?? 2;
  const key = `vstripe|${lineColor}|${bgColor}|${spacing}|${lineWidth}|${repeatX}|${repeatY}`;
  const cached = sketchHatchTextureCache.get(key);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'butt';
  for (let x = spacing * 0.5; x < size; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  sketchHatchTextureCache.set(key, tex);
  return tex;
}

/** Plain whitish glass (ends / underside — no stripes). */
function glassWallPlainMat(border: boolean): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: hex(border ? '#D0E4F6' : '#DEEAF8'),
    emissive: hex('#EEF5FC'),
    emissiveIntensity: 0.12,
    roughness: 0.55,
    metalness: 0.02,
    transmission: 0.12,
    thickness: border ? 0.3 : 0.22,
    ior: 1.4,
    clearcoat: 0.2,
    clearcoatRoughness: 0.3,
    transparent: true,
    opacity: border ? 0.72 : 0.62,
    depthWrite: true,
    side: THREE.FrontSide,
  });
}

/** Vertical blue stripes painted on a wall face (inside or outside). */
function glassWallStripeMat(border: boolean): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map: getVerticalStripeTexture(
      border ? WALL_EDGE_BLUE_DARK : WALL_EDGE_BLUE,
      border ? '#D0E4F6' : '#DEEAF8',
      {
        spacing: border ? 7 : 9,
        lineWidth: border ? 2.4 : 2.0,
        repeatX: 10,
        repeatY: 1,
      },
    ),
    color: 0xffffff,
    emissive: hex('#EEF5FC'),
    emissiveIntensity: 0.1,
    roughness: 0.6,
    metalness: 0.02,
    transmission: 0.08,
    thickness: border ? 0.28 : 0.2,
    ior: 1.4,
    clearcoat: 0.15,
    clearcoatRoughness: 0.35,
    transparent: true,
    opacity: border ? 0.78 : 0.68,
    depthWrite: true,
    // FrontSide: +Z paints one side of the wall, -Z paints the other.
    side: THREE.FrontSide,
  });
}

/** Soft pale blue glass top wash (no stripes on cap). */
function glassWallTopMat(border: boolean): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: hex(border ? '#CEE4F6' : '#E0EEFA'),
    emissive: hex('#F6FAFE'),
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.02,
    transmission: 0.28,
    thickness: 0.2,
    ior: 1.38,
    clearcoat: 0.35,
    clearcoatRoughness: 0.22,
    transparent: true,
    opacity: border ? 0.5 : 0.4,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/**
 * BoxGeometry face materials: plain whitish glass on all sides (no vertical stripes).
 */
function glassWallFaceMaterials(border: boolean): THREE.Material[] {
  const plain = glassWallPlainMat(border);
  const top = glassWallTopMat(border);
  // BoxGeometry groups: +X, -X, +Y, -Y, +Z, -Z
  return [plain, plain, top, plain, plain, plain];
}

function wallEdgeLineMat(border: boolean): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: hex(border ? WALL_EDGE_BLUE_DARK : WALL_EDGE_BLUE),
    transparent: true,
    opacity: border ? 0.95 : 0.85,
    depthTest: true,
  });
}

/** Push the 12 edges of an oriented wall box into a flat position array. */
function pushWallBoxEdges(
  out: number[],
  cx: number,
  cy: number,
  cz: number,
  len: number,
  height: number,
  thickness: number,
  rotY: number,
): void {
  const hx = len * 0.5;
  const hy = height * 0.5;
  const hz = thickness * 0.5;
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const corner = (lx: number, ly: number, lz: number): [number, number, number] => {
    const wx = cx + lx * cos - lz * sin;
    const wz = cz + lx * sin + lz * cos;
    return [wx, cy + ly, wz];
  };
  const c000 = corner(-hx, -hy, -hz);
  const c100 = corner(hx, -hy, -hz);
  const c010 = corner(-hx, hy, -hz);
  const c110 = corner(hx, hy, -hz);
  const c001 = corner(-hx, -hy, hz);
  const c101 = corner(hx, -hy, hz);
  const c011 = corner(-hx, hy, hz);
  const c111 = corner(hx, hy, hz);
  const edges: Array<[[number, number, number], [number, number, number]]> = [
    [c000, c100],
    [c100, c110],
    [c110, c010],
    [c010, c000],
    [c001, c101],
    [c101, c111],
    [c111, c011],
    [c011, c001],
    [c000, c001],
    [c100, c101],
    [c010, c011],
    [c110, c111],
  ];
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

function sketchWallSideMat(border: boolean): THREE.MeshPhysicalMaterial {
  return glassWallPlainMat(border);
}

function sketchWallTopMat(border: boolean): THREE.MeshPhysicalMaterial {
  return glassWallTopMat(border);
}

function routeGlossMaterial(
  color: string,
  opts?: { opacity?: number; emissiveIntensity?: number; gloss?: boolean },
): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
  const opacity = opts?.opacity ?? 1;
  const emissiveIntensity =
    opts?.emissiveIntensity ?? (color === EXPOFP_ROUTE_ACTIVE ? 0.68 : 0.3);
  const c = hex(color);
  const useGloss = opts?.gloss !== false && opacity >= 0.85;
  if (useGloss) {
    return new THREE.MeshPhysicalMaterial({
      color: c,
      emissive: c,
      emissiveIntensity,
      roughness: 0.05,
      metalness: 0.48,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 0.95,
    });
  }
  return new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: emissiveIntensity * 0.65,
    roughness: 0.12,
    metalness: 0.32,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 0.7,
  });
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * World Y for a floor plate in multi-floor 3D.
 * Uses the same authored floorY as POIs — no fixed artificial gap between floors.
 */
function floorPlateDisplayY(
  layers: { floorY: number }[],
  index: number,
  verticalStack: boolean,
): number {
  const layer = layers[index];
  if (!layer) return 0;
  if (!verticalStack) return layer.floorY;

  // Prefer real floorY so plate spacing matches POI heights.
  const y0 = layers[0]?.floorY ?? 0;
  const hasDistinctYs = layers.some(
    (l, i) => i > 0 && Math.abs(l.floorY - layers[0].floorY) > 0.05,
  );
  if (hasDistinctYs) return layer.floorY;

  // Degenerate authoring (all floors share one Y): space by wall height so plates don't overlap.
  return y0 + index * Math.max(STACK_PLATE_STEP, BORDER_WALL_HEIGHT + 0.35);
}

function floorCorridorColor(floorIndex: number): string {
  const palette = SCENE3D_STYLE.floorCorridors;
  return palette[((floorIndex % palette.length) + palette.length) % palette.length];
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

function isExteriorPerimeterWall(seg: WallSeg, map: Floor2DMap): boolean {
  const mx = (seg.x1 + seg.x2) / 2;
  const mz = (seg.z1 + seg.z2) / 2;
  const margin = map.cellSize * 0.55;
  return (
    mx <= map.minX + margin ||
    mx >= map.maxX - margin ||
    mz <= map.minZ + margin ||
    mz >= map.maxZ - margin
  );
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

function shadedWallMat(color: string, roughness = 0.82, doubleSided = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(color),
    roughness,
    metalness: 0.04,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function addWallTopCap(
  group: THREE.Group,
  cx: number,
  cz: number,
  rotY: number,
  len: number,
  thickness: number,
  floorY: number,
  height: number,
  border: boolean,
): void {
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(len + 0.018, 0.04, thickness + 0.018),
    glassWallTopMat(border),
  );
  top.position.set(cx, floorY + height + 0.02, cz);
  top.rotation.y = rotY;
  top.renderOrder = 6;
  group.add(top);
}

function solidFillMat(color: string, roughness = 0.92): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(color),
    roughness,
    metalness: 0.08,
    flatShading: false,
  });
}

/** Softer object blues (same family as wall edges, less saturated). */
const OBJECT_SHADE_BLUE = '#7A9BC4';
const OBJECT_SHADE_BLUE_TOP = '#5E82B0';

/** Object sides / body — muted wall-edge blue. */
function objectWallColors(_o: FloorBlock): { side: string; top: string } {
  return { side: OBJECT_SHADE_BLUE, top: OBJECT_SHADE_BLUE_TOP };
}

/** Side / stroke color for objects (2D + 3D). */
function objectBaseColor(o: FloorBlock): string {
  return objectWallColors(o).side;
}

function objectTopColor(o: FloorBlock): string {
  return objectWallColors(o).top;
}

/** Side / body — soft wall-edge blue. */
function objectSideMat(_color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(OBJECT_SHADE_BLUE),
    emissive: hex(OBJECT_SHADE_BLUE),
    emissiveIntensity: 0.04,
    roughness: 0.78,
    metalness: 0.03,
  });
}

/** Top face — slightly deeper soft blue. */
function objectTopMat(_color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(OBJECT_SHADE_BLUE_TOP),
    emissive: hex(OBJECT_SHADE_BLUE),
    emissiveIntensity: 0.03,
    roughness: 0.74,
    metalness: 0.03,
  });
}

/** Soft contact shadow under each object — disabled (black discs under walls/objects). */
function addObjectContactShadow(
  _group: THREE.Group,
  _cx: number,
  _cz: number,
  _floorY: number,
  _radius: number,
): void {
  // Intentionally empty — removes random black circles on the floor.
}

function addObjectTopCap(
  group: THREE.Group,
  cx: number,
  cz: number,
  w: number,
  d: number,
  topY: number,
  _topColor: string,
): void {
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.04, w - 0.02), 0.026, Math.max(0.04, d - 0.02)),
    objectTopMat(SKETCH_INK_LIGHT),
  );
  cap.position.set(cx, topY + 0.013, cz);
  cap.castShadow = false;
  group.add(cap);
}

const GENERIC_OBJECT_FILLS = new Set([
  '#ffffff',
  '#fff',
  '#fafaf8',
  '#f5f5f5',
  '#f8f8f8',
  '#eeeeee',
  '#eee',
  '#b8b4ac',
  '#e4e2de',
  '#e6e4e0',
  '#d8d4cc',
  '#d4cfc6',
  '#e0d8ce',
  '#d0d6de',
  '#d0d9cc',
  '#a8a49e',
  '#d8d4ce',
  '#c8c4be',
  '#aeaaa4',
  '#9a9590',
  '#8e8a84',
  '#eceef1',
  '#e8eaed',
  '#a39e96',
  '#ada8a0',
  '#929aa4',
  '#98a494',
  '#6b8f74',
  '#6f9178',
  '#678b70',
  '#759882',
  '#527a5c',
  '#7a9a84',
  '#6e8e7a',
  '#b8cfba',
  '#b2c9b4',
  '#f0eeea',
]);

const STRUCTURE_OBJECT_KINDS = new Set([
  'door',
  'double-door',
  'window',
  'wall',
  'pillar',
  'column',
  'railing',
  'stairs',
  'escalator',
  'elevator',
]);

function parseHexRgb(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim();
  if (c === 'transparent') return null;
  if (!c.startsWith('#')) return null;
  let h = c.slice(1);
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  if (h.length !== 6) return null;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function normalizeHexColor(color: string): string {
  let c = color.trim().toLowerCase();
  if (!c.startsWith('#')) return c;
  if (c.length === 4) {
    c = `#${c
      .slice(1)
      .split('')
      .map((ch) => ch + ch)
      .join('')}`;
  }
  return c;
}

function isNearWhiteColor(color: string): boolean {
  const rgb = parseHexRgb(color);
  if (!rgb) return false;
  return rgb.r >= 0xec && rgb.g >= 0xec && rgb.b >= 0xec;
}

function isGenericObjectFill(fill?: string): boolean {
  if (!fill || fill === 'transparent') return true;
  if (isNearWhiteColor(fill)) return true;
  return GENERIC_OBJECT_FILLS.has(normalizeHexColor(fill));
}

function mixHexColors(a: string, b: string, amount: number): string {
  const from = parseHexRgb(a);
  const to = parseHexRgb(b);
  if (!from || !to) return a;
  const t = Math.max(0, Math.min(1, amount));
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  const r = mix(from.r, to.r);
  const g = mix(from.g, to.g);
  const bl = mix(from.b, to.b);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

function isStructureObjectKind(kind?: string): boolean {
  return kind ? STRUCTURE_OBJECT_KINDS.has(kind) : false;
}

function cyberBuildingMat(
  base: string,
  opts?: { emissive?: string; emissiveIntensity?: number; metalness?: number; roughness?: number },
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(base),
    roughness: opts?.roughness ?? 0.86,
    metalness: opts?.metalness ?? 0.04,
    emissive: hex(opts?.emissive ?? '#000000'),
    emissiveIntensity: opts?.emissiveIntensity ?? 0,
  });
}

/** Ground shadow disc — disabled (same black-circle artifacts). */
function addGroundShadowDisc(
  _group: THREE.Group,
  _x: number,
  _z: number,
  _floorY: number,
  _radius = 0.42,
): void {
  // Intentionally empty.
}

function addCyberRoofCap(
  group: THREE.Group,
  cx: number,
  cz: number,
  w: number,
  d: number,
  floorY: number,
  topY: number,
): void {
  const capH = 0.08;
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.08, w - 0.06), capH, Math.max(0.08, d - 0.06)),
    cyberBuildingMat(getWalkFloor3dColor(), { roughness: 0.78, metalness: 0.02 }),
  );
  cap.position.set(cx, topY + capH / 2, cz);
  group.add(cap);
}

type WallHeights = { border: number; roomFill: number; wallCap: number };

/** Void cells connected to the map edge (outside the building). */
function markExteriorVoidCells(map: Floor2DMap, walk: Uint8Array): Uint8Array {
  const exterior = new Uint8Array(map.cols * map.rows);
  const queue: number[] = [];

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const i = r * map.cols + c;
      if (walk[i]) continue;
      if (c === 0 || r === 0 || c === map.cols - 1 || r === map.rows - 1) {
        exterior[i] = 1;
        queue.push(i);
      }
    }
  }

  while (queue.length) {
    const i = queue.shift()!;
    const c = i % map.cols;
    const r = (i / map.cols) | 0;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let d = 0; d < dirs.length; d++) {
      const nc = c + dirs[d][0];
      const nr = r + dirs[d][1];
      if (nc < 0 || nr < 0 || nc >= map.cols || nr >= map.rows) continue;
      const ni = nr * map.cols + nc;
      if (walk[ni] || exterior[ni]) continue;
      exterior[ni] = 1;
      queue.push(ni);
    }
  }
  return exterior;
}

/** All non-walk void inside the building footprint (rooms, not exterior). */
function interiorRoomMask(map: Floor2DMap, walk: Uint8Array): Uint8Array {
  const exterior = markExteriorVoidCells(map, walk);
  const interior = new Uint8Array(map.cols * map.rows);
  for (let i = 0; i < walk.length; i++) {
    if (!walk[i] && !exterior[i]) interior[i] = 1;
  }
  return interior;
}

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

  const thickness = border ? BORDER_WALL_THICKNESS : INTERIOR_WALL_THICKNESS;
  const rotY = Math.atan2(dz, dx);
  const cx = (seg.x1 + seg.x2) / 2;
  const cz = (seg.z1 + seg.z2) / 2;
  const faceMats = glassWallFaceMaterials(border);

  if (border) {
    const height = heights?.border ?? BORDER_WALL_HEIGHT;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(len, height, thickness),
      faceMats,
    );
    body.position.set(cx, floorY + height / 2, cz);
    body.rotation.y = rotY;
    body.renderOrder = 5;
    group.add(body);
    addWallTopCap(group, cx, cz, rotY, len, thickness, floorY, height, border);
    {
      const edgePos: number[] = [];
      pushWallBoxEdges(edgePos, cx, floorY + height / 2, cz, len, height, thickness, rotY);
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
      const edgeLines = new THREE.LineSegments(edgeGeo, wallEdgeLineMat(border));
      edgeLines.renderOrder = 8;
      group.add(edgeLines);
    }
    return;
  }

  if (heights) {
    // Match exterior wall height in stacked / multi-floor views too.
    const height = heights.border;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(len, height, thickness),
      faceMats,
    );
    body.position.set(cx, floorY + height / 2, cz);
    body.rotation.y = rotY;
    body.renderOrder = 5;
    group.add(body);
    addWallTopCap(group, cx, cz, rotY, len, thickness, floorY, height, border);
    {
      const edgePos: number[] = [];
      pushWallBoxEdges(edgePos, cx, floorY + height / 2, cz, len, height, thickness, rotY);
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
      const edgeLines = new THREE.LineSegments(edgeGeo, wallEdgeLineMat(border));
      edgeLines.renderOrder = 8;
      group.add(edgeLines);
    }
    return;
  }

  const height = INTERIOR_WALL_POP_HEIGHT;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(len, height, thickness),
    faceMats,
  );
  body.position.set(cx, floorY + height / 2, cz);
  body.rotation.y = rotY;
  body.renderOrder = 5;
  group.add(body);
  addWallTopCap(group, cx, cz, rotY, len, thickness, floorY, height, border);
  {
    const edgePos: number[] = [];
    pushWallBoxEdges(edgePos, cx, floorY + height / 2, cz, len, height, thickness, rotY);
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    const edgeLines = new THREE.LineSegments(edgeGeo, wallEdgeLineMat(border));
    edgeLines.renderOrder = 8;
    group.add(edgeLines);
  }
}

function roomVolumeColor(store: FloorBlock, index: number, zones: FloorBlock[]): string {
  if (store.fill && store.fill !== 'transparent') {
    return sanitizeFloorSurfaceColor(store.fill);
  }
  const cx = store.x + store.w / 2;
  const cz = store.z + store.d / 2;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (pointInsideBlock(cx, cz, zone) && zone.fill && zone.fill !== 'transparent') {
      return sanitizeFloorSurfaceColor(zone.fill);
    }
  }
  const labelColor = zoneInteriorColorFromLabel(store.label, index);
  if (labelColor !== MAP_PALETTE.interiorFill) {
    return sanitizeFloorSurfaceColor(labelColor);
  }
  const palette = SCENE3D_STYLE.roomFills;
  return sanitizeFloorSurfaceColor(
    palette[((index % palette.length) + palette.length) % palette.length],
  );
}

function addInteriorRoomVolumesFromStores(
  group: THREE.Group,
  stores: FloorBlock[],
  zones: FloorBlock[],
  floorY: number,
  highlightPoints: { x: number; z: number }[] = [],
  fillHeight = INTERIOR_ROOM_FILL_HEIGHT,
): void {
  const floorTop = floorY + 0.024;
  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    let fillColor = roomVolumeColor(store, i, zones);
    for (let hi = 0; hi < highlightPoints.length; hi++) {
      const p = highlightPoints[hi];
      if (pointInsideBlock(p.x, p.z, store)) {
        fillColor = SCENE3D_STYLE.highlight;
        break;
      }
    }
    const hMul = 0.86 + (i % 7) * 0.1;
    const roomH = fillHeight * hMul;
    const cx = store.x + store.w / 2;
    const cz = store.z + store.d / 2;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(
        Math.max(0.05, store.w - 0.04),
        roomH,
        Math.max(0.05, store.d - 0.04),
      ),
      cyberBuildingMat(fillColor, { roughness: 0.88, metalness: 0.03 }),
    );
    body.position.set(cx, floorTop + roomH / 2, cz);
    group.add(body);
    addCyberRoofCap(group, cx, cz, store.w, store.d, floorY, floorTop + roomH);
  }
}

function poiHighlightPoints(
  pois: NavMapPoi[],
  originId: string,
  destId: string,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  if (originId) {
    const o = pois.find((p) => p.id === originId);
    if (o) out.push({ x: o.x, z: o.z });
  }
  if (destId && destId !== originId) {
    const d = pois.find((p) => p.id === destId);
    if (d) out.push({ x: d.x, z: d.z });
  }
  return out;
}

function addInteriorRoomVolumes(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
  fillHeight = INTERIOR_ROOM_FILL_HEIGHT,
): void {
  const interior = interiorRoomMask(map, walk);
  const used = new Uint8Array(map.cols * map.rows);
  const cell = map.cellSize;
  const floorTop = floorY + 0.024;

  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const start = r * map.cols + c;
      if (!interior[start] || used[start]) continue;

      let w = 1;
      while (c + w < map.cols) {
        const i = r * map.cols + c + w;
        if (!interior[i] || used[i]) break;
        w++;
      }

      let h = 1;
      outer: while (r + h < map.rows) {
        for (let dc = 0; dc < w; dc++) {
          const i = (r + h) * map.cols + c + dc;
          if (!interior[i] || used[i]) break outer;
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
      const inset = 0.02;

      const hMul = 0.9 + ((r * map.cols + c) % 5) * 0.08;
      const roomH = fillHeight * hMul;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(boxW - inset, roomH, boxD - inset),
        cyberBuildingMat(getWalkFloor3dColor(), { roughness: 0.88, metalness: 0.03 }),
      );
      body.position.set(cx, floorTop + roomH / 2, cz);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      addCyberRoofCap(group, cx, cz, boxW, boxD, floorY, floorTop + roomH);
    }
  }
}

function addInteriorRooms(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  zones: FloorBlock[],
  floorY: number,
  highlightPoints: { x: number; z: number }[] = [],
  fillHeight = INTERIOR_ROOM_FILL_HEIGHT,
): void {
  if (map.stores.length > 0) {
    addInteriorRoomVolumesFromStores(group, map.stores, zones, floorY, highlightPoints, fillHeight);
    return;
  }
  addInteriorRoomVolumes(group, map, walk, floorY, fillHeight);
}

const _wallBatchMatrix = new THREE.Matrix4();
const _wallBatchQuat = new THREE.Quaternion();
const _wallBatchScale = new THREE.Vector3();
const _wallBatchPos = new THREE.Vector3();
const _wallBatchYAxis = new THREE.Vector3(0, 1, 0);

function addWallBlueEdgeBatch(
  group: THREE.Group,
  walls: WallSeg[],
  wallIndices: number[],
  floorY: number,
  height: number,
  thickness: number,
  border: boolean,
): void {
  if (!wallIndices.length) return;
  const positions: number[] = [];
  for (let i = 0; i < wallIndices.length; i++) {
    const seg = walls[wallIndices[i]];
    const dx = seg.x2 - seg.x1;
    const dz = seg.z2 - seg.z1;
    const len = hypot2(dx, dz);
    if (len < WALL_EPS) continue;
    const rotY = Math.atan2(dz, dx);
    const cx = (seg.x1 + seg.x2) / 2;
    const cz = (seg.z1 + seg.z2) / 2;
    pushWallBoxEdges(positions, cx, floorY + height / 2, cz, len, height, thickness, rotY);
  }
  if (positions.length < 6) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geo, wallEdgeLineMat(border));
  lines.renderOrder = 8;
  group.add(lines);
}

function addWallInstancedBatch(
  group: THREE.Group,
  walls: WallSeg[],
  wallIndices: number[],
  floorY: number,
  height: number,
  thickness: number,
  border: boolean,
): void {
  const count = wallIndices.length;
  if (!count) return;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mats = glassWallFaceMaterials(border);
  const inst = new THREE.InstancedMesh(geo, mats, count);
  let placed = 0;
  for (let i = 0; i < count; i++) {
    const seg = walls[wallIndices[i]];
    const dx = seg.x2 - seg.x1;
    const dz = seg.z2 - seg.z1;
    const len = hypot2(dx, dz);
    if (len < WALL_EPS) continue;
    const rotY = Math.atan2(dz, dx);
    const cx = (seg.x1 + seg.x2) / 2;
    const cz = (seg.z1 + seg.z2) / 2;
    _wallBatchQuat.setFromAxisAngle(_wallBatchYAxis, rotY);
    _wallBatchScale.set(len, height, thickness);
    _wallBatchPos.set(cx, floorY + height / 2, cz);
    _wallBatchMatrix.compose(_wallBatchPos, _wallBatchQuat, _wallBatchScale);
    inst.setMatrixAt(placed++, _wallBatchMatrix);
  }
  if (!placed) return;
  if (placed < count) inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = false;
  inst.receiveShadow = false;
  inst.renderOrder = 5;
  group.add(inst);
  addWallBlueEdgeBatch(group, walls, wallIndices, floorY, height, thickness, border);
}

/** Instanced wall extrusions for large floors — border walls taller than interior. */
function addWallMeshesBatched(
  group: THREE.Group,
  walls: WallSeg[],
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
  stacked = false,
): void {
  const borderHeight = stacked ? STACK_BORDER_WALL_HEIGHT : BORDER_WALL_HEIGHT;
  const interiorHeight = stacked ? STACK_INTERIOR_WALL_POP_HEIGHT : INTERIOR_WALL_POP_HEIGHT;
  const borderIdx: number[] = [];
  const interiorIdx: number[] = [];
  for (let i = 0; i < walls.length; i++) {
    if (isBorderWallSegment(walls[i], map, walk)) borderIdx.push(i);
    else interiorIdx.push(i);
  }
  addWallInstancedBatch(
    group,
    walls,
    borderIdx,
    floorY,
    borderHeight,
    BORDER_WALL_THICKNESS,
    true,
  );
  addWallInstancedBatch(
    group,
    walls,
    interiorIdx,
    floorY,
    interiorHeight,
    INTERIOR_WALL_THICKNESS,
    false,
  );
}

function addWallMeshes(
  group: THREE.Group,
  walls: WallSeg[],
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
  stacked = false,
): void {
  if (walls.length === 0) return;
  addWallMeshesBatched(group, walls, map, walk, floorY, stacked);
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
    new THREE.LineBasicMaterial({ color: hex(WALL_EDGE_BLUE), transparent: true, opacity: 0.9 }),
  );
  lines.renderOrder = 12;
  group.add(lines);
}

function addStorePlanRects(group: THREE.Group, stores: FloorBlock[], floorY: number): void {
  if (stores.length === 0) return;
  const y = floorY + PLAN_LINE_LIFT - 0.004;
  const fillMat = new THREE.MeshBasicMaterial({
    color: hex(MAP_PALETTE.interiorFill),
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: hex(MAP_PALETTE.wall) });
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
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const mat = new THREE.LineBasicMaterial({ color: hex(objectBaseColor(o)) });
    const cx = o.x + o.w / 2;
    const cz = o.z + o.d / 2;
    const hw = o.w / 2;
    const hd = o.d / 2;
    const rot = objectRotationRad(o);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corner = (lx: number, lz: number) =>
      new THREE.Vector3(cx + lx * cos - lz * sin, y, cz + lx * sin + lz * cos);
    const pts = [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
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
  skipWallLines = false,
): void {
  if (!skipWallLines) addWallPlanLines(group, map.walls, floorY);
  addStorePlanRects(group, map.stores, floorY);
  addZonePlanOutlines(group, zones, floorY);
  addObjectPlanRects(group, objects, floorY);
}

function roomFillColor(): THREE.Color {
  return hex(SCENE3D_STYLE.interiorBlock);
}

function makeFloorLabelSprite(label: string): THREE.Sprite {
  const text = (label.trim() || 'Floor').slice(0, 24);
  const texDpr = labelTextureDpr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 20;
  const font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  const logicalW = Math.ceil(textW + 24);
  const logicalH = 36;
  canvas.width = Math.ceil(logicalW * texDpr);
  canvas.height = Math.ceil(logicalH * texDpr);
  ctx.scale(texDpr, texDpr);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(4, 4, logicalW - 8, logicalH - 8);
  ctx.strokeStyle = MAP_PALETTE.wall;
  ctx.lineWidth = 2;
  ctx.strokeRect(4.5, 4.5, logicalW - 9, logicalH - 9);
  ctx.fillStyle = '#1e293b';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, logicalW / 2, logicalH / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(logicalW * 0.0065, logicalH * 0.0065, 1);
  return sprite;
}

/** Zone name painted above objects — truncated to the zone box unless fullName. */
function makeZoneFloorLabelMesh(
  zone: FloorBlock,
  index: number,
  opts?: { fullName?: boolean },
): THREE.Mesh | null {
  const raw = zone.label?.trim() || '';
  if (!raw) return null;
  const fullName = opts?.fullName === true;
  const { stroke: textColor } = zoneVisualStyle(zone, index);
  const b = zoneBounds(zone);
  const zoneW = Math.max(0.4, b.maxX - b.minX);
  const zoneD = Math.max(0.4, b.maxZ - b.minZ);
  // Keep truncated labels inside the zone; selected full names may extend past it.
  const maxWorldW = fullName
    ? Math.max(zoneW * 1.35, Math.min(14, raw.length * 0.42))
    : Math.max(0.55, zoneW * 0.88);
  const maxWorldH = fullName
    ? Math.max(0.45, Math.min(1.4, zoneD * 0.7))
    : Math.max(0.28, Math.min(zoneD * 0.55, 1.15));

  const texDpr = labelTextureDpr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  let fontSize = fullName ? 48 : 44;
  const padX = fullName ? 16 : 10;
  const padY = fullName ? 12 : 8;
  let text = raw;
  let logicalW = 0;
  let logicalH = 0;

  for (let attempt = 0; attempt < 8; attempt++) {
    const font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.font = font;
    if (fullName) {
      text = raw;
    } else {
      const maxTextPx = Math.max(12, maxWorldW / 0.016 - padX * 2);
      text = fitTextToWidth(ctx, raw, maxTextPx);
    }
    if (!text) {
      fontSize = Math.max(18, fontSize - 4);
      continue;
    }
    const textW = ctx.measureText(text).width;
    logicalW = Math.max(36, Math.ceil(textW + padX * 2));
    logicalH = Math.max(28, Math.ceil(fontSize + padY * 2));
    let worldW = logicalW * 0.016;
    let worldH = worldW * (logicalH / logicalW);
    if (worldW <= maxWorldW && worldH <= maxWorldH) break;
    const shrink = Math.min(maxWorldW / worldW, maxWorldH / worldH, 0.92);
    fontSize = Math.max(16, Math.floor(fontSize * shrink));
  }

  if (!text) return null;
  const font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  logicalW = Math.max(36, Math.ceil(textW + padX * 2));
  logicalH = Math.max(28, Math.ceil(fontSize + padY * 2));
  canvas.width = Math.ceil(logicalW * texDpr);
  canvas.height = Math.ceil(logicalH * texDpr);
  ctx.setTransform(texDpr, 0, 0, texDpr, 0, 0);
  ctx.clearRect(0, 0, logicalW, logicalH);

  if (fullName) {
    const radius = 10;
    ctx.beginPath();
    canvasRoundRect(ctx, 2, 2, logicalW - 4, logicalH - 4, radius);
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fill();
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.96)';
  ctx.lineWidth = Math.max(3, fontSize * 0.12);
  ctx.strokeText(text, logicalW / 2, logicalH / 2);
  ctx.fillStyle = textColor;
  ctx.fillText(text, logicalW / 2, logicalH / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  let worldW = logicalW * 0.016;
  let worldH = worldW * (logicalH / logicalW);
  const fit = Math.min(1, maxWorldW / worldW, maxWorldH / worldH);
  worldW *= fit;
  worldH *= fit;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = fullName ? 36 : 30;
  return mesh;
}

/** Full zone name labels for the currently selected / route endpoint zones. */
function addSelectedZoneFullLabels(
  group: THREE.Group,
  zones: FloorBlock[],
  floorY: number,
  selectedIds: Set<string>,
): void {
  if (!selectedIds.size || !zones.length) return;
  const labelY = floorY + ZONE_LABEL_LIFT + 0.03;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (!selectedIds.has(zone.id)) continue;
    const labelMesh = makeZoneFloorLabelMesh(zone, i, { fullName: true });
    if (!labelMesh) continue;
    const c = zoneCentroid(zone);
    labelMesh.position.set(c.x, labelY, c.z);
    group.add(labelMesh);
  }
}

function collectSelectedZoneIds(
  selectedPoiId: string | undefined,
  originId: string | undefined,
  destId: string | undefined,
  extra?: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const addRouteId = (id: string | undefined) => {
    if (!id) return;
    if (isZoneRouteId(id)) out.add(id.slice(ZONE_ROUTE_PREFIX.length));
    else out.add(id);
  };
  addRouteId(selectedPoiId);
  addRouteId(originId);
  addRouteId(destId);
  if (extra) {
    for (const id of extra) out.add(id);
  }
  return out;
}

/** Flat POI name painted on the floor plane (not a floating popup / billboard). */
function makePoiFloorLabelMesh(name: string, selected = false): THREE.Mesh | null {
  const text = name.trim().slice(0, 28);
  if (!text) return null;
  const texDpr = labelTextureDpr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = selected ? 30 : 26;
  const font = `${selected ? 700 : 600} ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  const padX = 14;
  const padY = 8;
  const logicalW = Math.max(40, Math.ceil(textW + padX * 2));
  const logicalH = Math.max(28, Math.ceil(fontSize + padY * 2));
  canvas.width = Math.ceil(logicalW * texDpr);
  canvas.height = Math.ceil(logicalH * texDpr);
  ctx.scale(texDpr, texDpr);

  ctx.clearRect(0, 0, logicalW, logicalH);
  const radius = 8;
  const pillX = 2;
  const pillY = 2;
  const pillW = logicalW - 4;
  const pillH = logicalH - 4;
  ctx.beginPath();
  canvasRoundRect(ctx, pillX, pillY, pillW, pillH, radius);
  ctx.fillStyle = selected ? 'rgba(255,255,255,0.97)' : 'rgba(255,255,255,0.9)';
  ctx.fill();
  ctx.strokeStyle = selected ? 'rgba(6,78,59,0.42)' : 'rgba(15,23,42,0.16)';
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.stroke();

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = selected ? 4 : 3;
  ctx.strokeText(text, logicalW / 2, logicalH / 2);
  ctx.fillStyle = selected ? '#064E3B' : '#0f172a';
  ctx.fillText(text, logicalW / 2, logicalH / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const worldH = selected ? 0.62 : 0.54;
  const worldW = worldH * (logicalW / logicalH);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 8;
  return mesh;
}

/** Max world-XZ distance to count as clicking a floor POI label (not empty floor). */
const POI_FLOOR_LABEL_TAP_RADIUS = 1.05;
/** Nearby search radius after tapping an empty map point. */
const POI_NEARBY_TAP_RADIUS = 28;
/** How many nearby POIs to offer in the tap popup. */
const POI_NEARBY_TAP_LIMIT = 10;

function addPoiFloorLabels3d(
  parent: THREE.Object3D,
  pois: NavMapPoi[],
  floorY: number,
  originId: string,
  destId: string,
  selectedId?: string,
  hideRouteEndpoints = false,
): void {
  if (!pois.length) return;
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    const name = (p.name ?? '').trim();
    if (!name) continue;
    // Route From/To use anchored 3D markers — avoid duplicate floor name under the pin.
    if (originId && p.id === originId) continue;
    if (destId && p.id === destId) continue;
    const selected = Boolean(selectedId && p.id === selectedId);
    // Names render as crisp HTML overlays — keep only an invisible pick pad in 3D.
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), hitMat);
    hit.rotation.x = -Math.PI / 2;
    hit.position.set(p.x, floorY + 0.05, p.z);
    hit.userData.wfPoiId = p.id;
    parent.add(hit);
  }
}

function zoneTint(zone: FloorBlock, index: number): THREE.Color {
  if (zone.fill && zone.fill !== 'transparent') return hex(zone.fill);
  if (zone.stroke && zone.stroke !== 'transparent') return hex(zone.stroke);
  return hex(usZoneColorFromLabel(zone.label, index));
}

function addZoneFill(group: THREE.Group, zone: FloorBlock, floorY: number, tint: THREE.Color): void {
  const y = floorY + 0.04;
  const mat = cyberBuildingMat('#' + tint.getHexString(), {
    roughness: 0.9,
    metalness: 0.02,
  });
  mat.transparent = true;
  mat.opacity = 0.14;
  mat.depthWrite = false;
  if (isPolygonZone(zone) && zone.points && zone.points.length >= 3) {
    const shape = new THREE.Shape();
    // Shape lives in XY; rotateX(-π/2) maps shape.y → world −z, so use −z here.
    shape.moveTo(zone.points[0].x, -zone.points[0].z);
    for (let i = 1; i < zone.points.length; i++) {
      shape.lineTo(zone.points[i].x, -zone.points[i].z);
    }
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

/** Pulsing border + fill highlight for a selected zone. */
function makeZoneBlinkGroup(
  zone: FloorBlock,
  floorY: number,
  fillColor: string,
  strokeColor: string,
  pulse: number,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.wfZoneBlink = true;
  const fillY = floorY + 0.05;
  const borderY = floorY + ZONE_LABEL_LIFT + 0.02;
  const fillColorHex = hex(zoneBlinkFillColor(fillColor, strokeColor, pulse));
  const borderColor = hex(zoneBlinkStrokeColor(strokeColor, pulse));

  let fillMesh: THREE.Mesh;
  if (isPolygonZone(zone) && zone.points && zone.points.length >= 3) {
    const shape = new THREE.Shape();
    shape.moveTo(zone.points[0].x, -zone.points[0].z);
    for (let i = 1; i < zone.points.length; i++) {
      shape.lineTo(zone.points[i].x, -zone.points[i].z);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    fillMesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: fillColorHex,
        transparent: true,
        opacity: 0.1 + pulse * 0.16,
        depthWrite: false,
        depthTest: false,
      }),
    );
    fillMesh.position.y = fillY;
  } else {
    fillMesh = new THREE.Mesh(
      new THREE.BoxGeometry(zone.w, 0.012, zone.d),
      new THREE.MeshBasicMaterial({
        color: fillColorHex,
        transparent: true,
        opacity: 0.1 + pulse * 0.16,
        depthWrite: false,
        depthTest: false,
      }),
    );
    fillMesh.position.set(zone.x + zone.w / 2, fillY, zone.z + zone.d / 2);
  }
  fillMesh.renderOrder = 52;
  group.add(fillMesh);

  const borderPts = zoneOutlinePoints(zone, borderY);
  const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts);
  const border = new THREE.LineLoop(
    borderGeo,
    new THREE.LineBasicMaterial({
      color: borderColor,
      transparent: true,
      opacity: 0.5 + pulse * 0.22,
      depthWrite: false,
      depthTest: false,
    }),
  );
  border.renderOrder = 55;
  group.add(border);

  group.userData.wfBlinkFill = fillMesh;
  group.userData.wfBlinkBorder = border;
  return group;
}

function updateZoneBlinkGroup(
  group: THREE.Group,
  zone: FloorBlock,
  floorY: number,
  fillColor: string,
  strokeColor: string,
  pulse: number,
): void {
  const fillColorHex = hex(zoneBlinkFillColor(fillColor, strokeColor, pulse));
  const borderColor = hex(zoneBlinkStrokeColor(strokeColor, pulse));
  const fill = group.userData.wfBlinkFill as THREE.Mesh | undefined;
  const border = group.userData.wfBlinkBorder as THREE.LineLoop | undefined;
  if (fill) {
    const mat = fill.material as THREE.MeshBasicMaterial;
    mat.color.copy(fillColorHex);
    mat.opacity = 0.1 + pulse * 0.16;
    const fillY = floorY + 0.05;
    const borderY = floorY + ZONE_LABEL_LIFT + 0.02;
    if (isPolygonZone(zone) && zone.points && zone.points.length >= 3) {
      fill.position.y = fillY;
    } else {
      fill.position.set(zone.x + zone.w / 2, fillY, zone.z + zone.d / 2);
    }
    if (border) {
      const pts = zoneOutlinePoints(zone, borderY);
      border.geometry.dispose();
      border.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    }
  }
  if (border) {
    const mat = border.material as THREE.LineBasicMaterial;
    mat.color.copy(borderColor);
    mat.opacity = 0.5 + pulse * 0.22;
  }
}

function disposeZoneBlinkGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (let i = 0; i < mats.length; i++) mats[i]?.dispose();
    }
  });
}

const ZONE_BLINK_MS = 1600;

function zoneBlinkFillColor(fill: string, stroke: string, pulse: number): string {
  const base =
    fill && fill !== 'transparent'
      ? fill
      : stroke && stroke !== 'transparent'
        ? stroke
        : '#B8C4D0';
  return mixHexColors(base, '#FFFFFF', 0.06 + pulse * 0.2);
}

function zoneBlinkStrokeColor(stroke: string, pulse: number): string {
  const base = stroke && stroke !== 'transparent' ? stroke : FLOOR2D_STYLE.accent;
  return mixHexColors(base, '#FFFFFF', 0.1 + pulse * 0.25);
}

function zoneBlinkPulse(now = performance.now()): number {
  const phase = (now % ZONE_BLINK_MS) / ZONE_BLINK_MS;
  return 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
}

/** 0→1 looping phase for the ExpoFP-style route draw animation. */
function routeAnimProgress(now = performance.now()): number {
  return (now % ROUTE_ANIM_MS) / ROUTE_ANIM_MS;
}

/** Slice a polyline by arc-length fraction (for animated route reveal). */
function slicePolylineXZ(
  points: { x: number; z: number }[],
  progress: number,
): { x: number; z: number }[] {
  if (points.length < 2) return points;
  if (progress <= 0) return [points[0], points[0]];
  if (progress >= 1) return points;

  let total = 0;
  const segLens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    segLens.push(len);
    total += len;
  }
  if (total < 1e-6) return [points[0]];

  const target = total * progress;
  let acc = 0;
  const out: { x: number; z: number }[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const segLen = segLens[i - 1];
    if (acc + segLen >= target) {
      const t = segLen > 0 ? (target - acc) / segLen : 0;
      out.push({
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        z: points[i - 1].z + (points[i].z - points[i - 1].z) * t,
      });
      return out;
    }
    acc += segLen;
    out.push(points[i]);
  }
  return out;
}

const ROUTE_TUBE_SIDES = 14;
const ROUTE_UP = new THREE.Vector3(0, 1, 0);
const ROUTE_DIR = new THREE.Vector3();
const ROUTE_MID = new THREE.Vector3();

/** Chain short cylinders along the path — avoids CatmullRom tube squash at corners. */
function addRouteCylinderChain(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  radius: number,
  mat: THREE.Material,
  renderOrder: number,
): void {
  if (points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    ROUTE_DIR.subVectors(b, a);
    const len = ROUTE_DIR.length();
    if (len < 0.025) continue;
    const geo = new THREE.CylinderGeometry(radius, radius, len, ROUTE_TUBE_SIDES, 1);
    const mesh = new THREE.Mesh(geo, mat);
    ROUTE_MID.addVectors(a, b).multiplyScalar(0.5);
    mesh.position.copy(ROUTE_MID);
    mesh.quaternion.setFromUnitVectors(ROUTE_UP, ROUTE_DIR.normalize());
    mesh.renderOrder = renderOrder;
    parent.add(mesh);
  }
}

function addSingleRouteTube(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  color: string,
  opacity = 1,
  radius = ROUTE_RADIUS,
): void {
  if (points.length < 2) return;
  const isActive = color === EXPOFP_ROUTE_ACTIVE;
  const mat = routeGlossMaterial(color, {
    opacity,
    emissiveIntensity: isActive ? 0.72 : 0.28,
    gloss: isActive,
  });
  addRouteCylinderChain(
    parent,
    points,
    radius,
    mat,
    isActive ? 18 : 16,
  );
}

function addRouteTubeSegment(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
): void {
  if (points.length < 2) return;
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.42);
  const segs = Math.min(Math.max(points.length, 8), 32);
  const geo = new THREE.TubeGeometry(curve, segs, ROUTE_RADIUS, 6, false);

  const haloMat = new THREE.MeshBasicMaterial({
    color: hex(NAV_ROUTE_BLUE_LIGHT),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(geo, haloMat);
  halo.scale.setScalar(ROUTE_HALO_SCALE);
  halo.renderOrder = 8;
  parent.add(halo);

  const tubeMat = new THREE.MeshStandardMaterial({
    color: hex(NAV_ROUTE_VIVID),
    emissive: hex(NAV_ROUTE_BLUE_EMISSIVE),
    emissiveIntensity: 0.32,
    roughness: 0.28,
    metalness: 0.04,
  });
  const tube = new THREE.Mesh(geo, tubeMat);
  tube.renderOrder = 9;
  parent.add(tube);
}

type RouteAnimEntry = {
  path: { x: number; z: number }[];
  floorY: number;
  activeHolder: THREE.Group;
};

function addExpoFpRoute3d(
  parent: THREE.Object3D,
  path: { x: number; z: number }[],
  floorY: number,
  entries: RouteAnimEntry[],
): void {
  if (path.length < 2) return;
  const y = floorY + ROUTE_LIFT;
  const fullPts = path.map((p) => new THREE.Vector3(p.x, y, p.z));
  addExpoFpRoute3dWorldPoints(parent, fullPts, entries, path, floorY);
}

/** Draw a route that already has world XYZ (used for stair-mouth connectors between floors). */
function addExpoFpRoute3dWorldPoints(
  parent: THREE.Object3D,
  fullPts: THREE.Vector3[],
  entries: RouteAnimEntry[],
  animPath?: { x: number; z: number }[],
  animFloorY?: number,
): void {
  if (fullPts.length < 2) return;
  const glowMat = routeGlossMaterial(NAV_GLOSS_NAVY_DEEP, {
    opacity: 0.52,
    emissiveIntensity: 0.2,
    gloss: false,
  });
  addRouteCylinderChain(parent, fullPts, ROUTE_RADIUS * 1.55, glowMat, 15);
  addSingleRouteTube(parent, fullPts, EXPOFP_ROUTE_PALE, 0.92, ROUTE_RADIUS * 0.95);
  const holder = new THREE.Group();
  parent.add(holder);
  // Vertical / 3D gap routes stay fully drawn (no flat XZ anim wash).
  if (animPath && animPath.length >= 2 && animFloorY != null) {
    entries.push({ path: animPath, floorY: animFloorY, activeHolder: holder });
  } else {
    addSingleRouteTube(holder, fullPts, EXPOFP_ROUTE_ACTIVE, 1, ROUTE_RADIUS * 1.08);
  }
}

function addGlowingNavigationRoute(
  parent: THREE.Object3D,
  path: { x: number; z: number }[],
  floorY: number,
  entries: RouteAnimEntry[],
): void {
  addExpoFpRoute3d(parent, path, floorY, entries);
}

function refreshExpoFpRouteActive(entry: RouteAnimEntry, progress: number): void {
  disposeObject3D(entry.activeHolder);
  entry.activeHolder.clear();
  const sliced = slicePolylineXZ(entry.path, progress);
  if (sliced.length < 2) return;
  const y = entry.floorY + ROUTE_LIFT;
  const pts = sliced.map((p) => new THREE.Vector3(p.x, y, p.z));
  const glowMat = routeGlossMaterial(NAV_GLOSS_NAVY_DEEP, {
    opacity: 0.55,
    emissiveIntensity: 0.22,
    gloss: false,
  });
  addRouteCylinderChain(entry.activeHolder, pts, ROUTE_RADIUS * 1.65, glowMat, 17);
  addSingleRouteTube(entry.activeHolder, pts, EXPOFP_ROUTE_ACTIVE, 1, ROUTE_RADIUS * 1.08);
}

function routeHeadingFromPath(
  path: { x: number; z: number }[],
  atStart: boolean,
  anchor?: { x: number; z: number } | null,
): number {
  if (path.length < 2) return 0;
  const minSeg = 0.25;

  if (atStart) {
    const from = anchor ?? path[0];
    for (let i = 0; i < path.length; i++) {
      const dx = path[i].x - from.x;
      const dz = path[i].z - from.z;
      const len = Math.hypot(dx, dz);
      if (len >= minSeg) return Math.atan2(dx, dz);
    }
    const dx = path[1].x - path[0].x;
    const dz = path[1].z - path[0].z;
    return Math.atan2(dx, dz);
  }

  for (let i = path.length - 2; i >= 0; i--) {
    const dx = path[i + 1].x - path[i].x;
    const dz = path[i + 1].z - path[i].z;
    if (Math.hypot(dx, dz) >= minSeg) return Math.atan2(dx, dz);
  }
  const a = path[path.length - 2];
  const b = path[path.length - 1];
  return Math.atan2(b.x - a.x, b.z - a.z);
}

function drawNavStartFlatIcon(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  headingRad = 0,
): void {
  // SVG-style navigation start: filled circle + direction chevron (no bitmap).
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.36;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(headingRad);
  ctx.fillStyle = NAV_MARKER_NAVY;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = NAV_MARKER_NAVY_BRIGHT;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.42);
  ctx.lineTo(r * 0.34, r * 0.28);
  ctx.lineTo(0, r * 0.12);
  ctx.lineTo(-r * 0.34, r * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNavDestFlatPin(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // SVG map-pin path (viewBox 0 0 24 36), scaled into w×h — crisp vector, no image.
  const sx = w / 24;
  const sy = h / 36;
  ctx.save();
  ctx.scale(sx, sy);
  ctx.beginPath();
  ctx.moveTo(12, 1.5);
  ctx.bezierCurveTo(7.03, 1.5, 3, 5.53, 3, 10.5);
  ctx.bezierCurveTo(3, 17.25, 12, 34.5, 12, 34.5);
  ctx.bezierCurveTo(12, 34.5, 21, 17.25, 21, 10.5);
  ctx.bezierCurveTo(21, 5.53, 16.97, 1.5, 12, 1.5);
  ctx.closePath();
  ctx.fillStyle = NAV_MARKER_NAVY_BRIGHT;
  ctx.fill();
  ctx.strokeStyle = NAV_MARKER_NAVY;
  ctx.lineWidth = 1.35;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(12, 10.5, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();
}

function navMarkerMat(color = NAV_MARKER_NAVY): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: hex(color),
    depthTest: false,
  });
}

function navGlossMat(color = NAV_MARKER_NAVY, highlight = false): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: hex(color),
    emissive: hex(highlight ? NAV_GLOSS_NAVY_HIGHLIGHT : NAV_GLOSS_NAVY),
    emissiveIntensity: highlight ? 0.35 : 0.22,
    roughness: 0.28,
    metalness: 0.12,
    clearcoat: 0.55,
    clearcoatRoughness: 0.12,
    depthTest: false,
  });
}

function navNeonMat(color = NAVIA_NEON, emissive = 0.75): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex(color),
    emissive: hex(color),
    emissiveIntensity: emissive,
    roughness: 0.22,
    metalness: 0.04,
  });
}

/** Flat direction marker on the floor — double-ring glossy logo-blue dot (start). */
function makeNavStartArrowProcedural(): THREE.Group {
  const marker = new THREE.Group();
  const s = NAV_ENDPOINT_MARKER_SCALE;
  const mat = navGlossMat(NAV_MARKER_NAVY);
  const matBright = navGlossMat(NAV_MARKER_NAVY_BRIGHT, true);
  const outer = new THREE.Mesh(new THREE.RingGeometry(0.1 * s, 0.2 * s, 36), mat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = 0.04 * s;
  outer.renderOrder = 42;
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.07 * s, 28), matBright);
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.045 * s;
  inner.renderOrder = 43;
  marker.add(outer, inner);
  return marker;
}

/** 3D start: flat logo-blue ring dot on the route. */
function makeNavStartMarker3d(_headingRad: number): THREE.Group {
  const g = new THREE.Group();
  g.add(makeNavStartArrowProcedural());
  return g;
}

/** 3D destination: tall glossy logo-blue pin with hollow head + floor ring dot. */
function makeNavDestMarker3d(): THREE.Group {
  const g = new THREE.Group();
  const s = NAV_DEST_PIN_SCALE;

  const floorMat = navGlossMat(NAV_MARKER_NAVY);
  const floorBright = navGlossMat(NAV_MARKER_NAVY_BRIGHT, true);
  const outerRing = new THREE.Mesh(new THREE.RingGeometry(0.1 * s, 0.2 * s, 36), floorMat);
  outerRing.rotation.x = -Math.PI / 2;
  outerRing.position.y = 0.012 * s;
  outerRing.renderOrder = 41;
  const innerDot = new THREE.Mesh(new THREE.CircleGeometry(0.065 * s, 28), floorBright);
  innerDot.rotation.x = -Math.PI / 2;
  innerDot.position.y = 0.018 * s;
  innerDot.renderOrder = 42;

  const profile = [
    new THREE.Vector2(0.004 * s, 0),
    new THREE.Vector2(0.085 * s, 0.14 * s),
    new THREE.Vector2(0.22 * s, 0.4 * s),
    new THREE.Vector2(0.22 * s, 0.6 * s),
    new THREE.Vector2(0.13 * s, 0.76 * s),
    new THREE.Vector2(0, 0.8 * s),
  ];
  const pinBody = new THREE.Mesh(
    new THREE.LatheGeometry(profile, 48),
    navGlossMat(NAV_MARKER_NAVY_BRIGHT, true),
  );
  pinBody.renderOrder = 44;

  const pinOutline = new THREE.Mesh(
    new THREE.LatheGeometry(profile, 48),
    new THREE.MeshBasicMaterial({
      color: hex(NAV_GLOSS_NAVY),
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      depthTest: false,
    }),
  );
  pinOutline.renderOrder = 45;

  const hole = new THREE.Mesh(
    new THREE.TorusGeometry(0.1 * s, 0.022 * s, 14, 36),
    navMarkerMat('#FFFFFF'),
  );
  hole.rotation.x = Math.PI / 2;
  hole.position.set(0, 0.52 * s, 0);
  hole.renderOrder = 46;

  const holeRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.1 * s, 0.01 * s, 10, 36),
    navGlossMat(NAV_GLOSS_NAVY),
  );
  holeRing.rotation.x = Math.PI / 2;
  holeRing.position.set(0, 0.52 * s, 0);
  holeRing.renderOrder = 47;

  g.add(outerRing, innerDot, pinBody, pinOutline, hole, holeRing);
  return g;
}

function addRouteEndpointMarkers3d(
  group: THREE.Group,
  origin: { x: number; z: number } | null | undefined,
  dest: { x: number; z: number } | null | undefined,
  path: { x: number; z: number }[],
  floorY: number,
): void {
  const markerY = floorY + ROUTE_LIFT + 0.02;
  if (origin) {
    const start = makeNavStartMarker3d(routeHeadingFromPath(path, true, origin));
    start.position.set(origin.x, markerY, origin.z);
    group.add(start);
  }
  if (dest) {
    const pin = makeNavDestMarker3d();
    pin.position.set(dest.x, markerY, dest.z);
    group.add(pin);
  }
}

/** Upright anchored pin at a selected POI (shown when that place is picked, label stays on floor elsewhere). */
function addSelectedPoiAnchor3d(
  group: THREE.Group,
  pois: NavMapPoi[],
  selectedId: string | undefined,
  floorY: number,
  originId: string,
  destId: string,
  hideRouteEndpoints: boolean | undefined,
): void {
  if (!selectedId) return;
  // While the navigation route is shown, From/To already have start/dest markers.
  if (hideRouteEndpoints && (selectedId === originId || selectedId === destId)) return;
  const poi = pois.find((p) => p.id === selectedId);
  if (!poi) return;
  const pin = makeNavDestMarker3d();
  pin.position.set(poi.x, floorY, poi.z);
  pin.userData.wfPoiId = selectedId;
  group.add(pin);
}

function addZoneFills(group: THREE.Group, zones: FloorBlock[], floorY: number): void {
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    addZoneFill(group, zone, floorY, zoneTint(zone, i));
  }
}

function addZoneFloorLabels(group: THREE.Group, zones: FloorBlock[], floorY: number): void {
  const labelY = floorY + ZONE_LABEL_LIFT;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const labelMesh = makeZoneFloorLabelMesh(zone, i);
    if (!labelMesh) continue;
    const c = zoneCentroid(zone);
    labelMesh.position.set(c.x, labelY, c.z);
    group.add(labelMesh);
  }
}

function addZoneLabelsAndFills(group: THREE.Group, zones: FloorBlock[], floorY: number): void {
  addZoneFills(group, zones, floorY);
  addZoneFloorLabels(group, zones, floorY);
}

/** Walkable floor — seamless white surface (no visible tile grid). */
function addBuildingFloorTiles(
  group: THREE.Group,
  map: Floor2DMap,
  walk: Uint8Array,
  floorY: number,
): void {
  const cell = map.cellSize;
  const mat = new THREE.MeshStandardMaterial({
    color: hex('#FFFFFF'),
    roughness: 0.96,
    metalness: 0,
  });
  const geo = new THREE.BoxGeometry(cell * 1.02, 0.02, cell * 1.02);
  let count = 0;
  for (let i = 0; i < walk.length; i++) if (walk[i]) count++;
  if (!count) return;
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  let idx = 0;
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const i = r * map.cols + c;
      if (!walk[i]) continue;
      m.makeTranslation(map.minX + (c + 0.5) * cell, floorY + 0.018, map.minZ + (r + 0.5) * cell);
      inst.setMatrixAt(idx++, m);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.receiveShadow = true;
  inst.castShadow = false;
  group.add(inst);
}

function chairCountForObject(o: FloorBlock): number {
  if (typeof o.count === 'number' && o.count > 0) {
    return Math.max(1, Math.min(CHAIR_ROW_MAX, Math.round(o.count)));
  }
  const areaUnits = (o.w / CHAIR_ROW_UNIT) * (o.d / CHAIR_ROW_UNIT);
  const dens = (CHAIR_ROW_UNIT / (CHAIR_ROW_UNIT + CHAIR_ROW_GAP)) ** 2;
  return Math.max(1, Math.min(CHAIR_ROW_MAX, Math.round(areaUnits * dens)));
}

function objectFootprintHeight(kind: string | undefined): number {
  const wallH = BORDER_WALL_HEIGHT;
  const half = OBJECT_BLOCK_HEIGHT;
  switch (kind) {
    case 'door':
    case 'double-door':
    case 'window':
    case 'railing':
    case 'banner':
      return wallH * 0.92;
    case 'wall':
      return wallH;
    case 'pillar':
    case 'column':
    case 'elevator':
      return wallH;
    case 'stairs':
    case 'escalator':
      return wallH * 0.55;
    case 'stage':
      return half * 0.35;
    case 'rug':
      return 0.02;
    case 'screen':
    case 'led-wall':
    case 'billboard':
    case 'sign':
      return half * 0.95;
    case 'plant':
    case 'tree':
    case 'statue':
    case 'fountain':
      return half * 0.9;
    case 'chair':
    case 'chair-row':
    case 'chair-round':
    case 'armchair':
    case 'stool':
      return half * 0.72;
    case 'sofa':
    case 'sofa-l':
    case 'bench':
    case 'seating-block':
      return half * 0.78;
    case 'table':
    case 'table-round':
    case 'desk':
    case 'counter':
    case 'bar':
    case 'reception':
      return half * 0.7;
    case 'bed':
    case 'bed-single':
    case 'bed-double':
    case 'bed-king':
    case 'crib':
    case 'bunk-bed':
      return half * 0.55;
    case 'cabinet':
    case 'shelf':
    case 'wardrobe':
    case 'locker':
    case 'closet':
    case 'dresser':
    case 'nightstand':
    case 'fridge':
    case 'stove':
    case 'washer':
    case 'dishwasher':
    case 'elevator':
      return half * 0.95;
    case 'toilet':
    case 'bathtub':
    case 'kitchen-sink':
    case 'bathroom-sink':
    case 'shower':
      return half * 0.5;
    case 'booth':
    case 'photo-booth':
    case 'ticket':
      return half * 0.85;
    case 'fireplace':
      return half * 0.9;
    case 'stairs-house':
      return wallH * 0.55;
    case 'charging':
    case 'charging-station':
    case 'phone-charging':
    case 'usb-hub':
    case 'power-outlet':
      return half * 0.55;
    case 'ev-charger':
      return half * 0.95;
    case 'wifi':
    case 'water-fountain':
      return half * 0.65;
    case 'restroom':
    case 'accessible-restroom':
    case 'baby-changing':
    case 'prayer-room':
      return half * 0.7;
    case 'first-aid':
    case 'aed':
      return half * 0.6;
    case 'wheelchair':
      return half * 0.55;
    case 'podium':
      return half * 0.75;
    case 'statue':
      return half * 0.95;
    case 'trash':
    case 'recycling':
    case 'smoking':
      return half * 0.55;
    case 'extinguisher':
      return half * 0.7;
    case 'coat-check':
      return half * 0.85;
    case 'car':
    case 'car-compact':
    case 'suv':
      return half * 0.85;
    case 'van':
    case 'bus':
      return half * 1.15;
    case 'truck':
    case 'pickup':
    case 'forklift':
      return half * 1.05;
    case 'bike':
    case 'motorcycle':
    case 'scooter':
      return half * 0.55;
    case 'bike-rack':
      return half * 0.45;
    case 'parking-spot':
    case 'ev-parking':
      return 0.03;
    case 'cart':
      return half * 0.55;
    case 'wheelchair-vehicle':
      return half * 0.55;
    default:
      return half;
  }
}

function addBoxAt(
  group: THREE.Group,
  cx: number,
  cz: number,
  w: number,
  d: number,
  floorY: number,
  height: number,
  sideColor: string,
  topColor: string,
  yLift = 0.02,
): void {
  if (w < 0.02 || d < 0.02 || height < 0.01) return;
  // Box face order: +x, -x, +y(top), -y(bottom), +z, -z
  const side = objectSideMat(sideColor);
  const top = objectTopMat(topColor);
  const bot = objectSideMat(sideColor);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), [
    side,
    side,
    top,
    bot,
    side,
    side,
  ]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(cx, floorY + yLift + height / 2, cz);
  addObjectContactShadow(group, cx, cz, floorY, Math.max(w, d) * 0.42);
  group.add(mesh);
  if (height >= 0.04) {
    addObjectTopCap(group, cx, cz, w, d, floorY + yLift + height, topColor);
  }
}

function addCylinderAt(
  group: THREE.Group,
  cx: number,
  cz: number,
  radius: number,
  floorY: number,
  height: number,
  sideColor: string,
  topColor: string,
  yLift = 0.02,
): void {
  if (radius < 0.015 || height < 0.01) return;
  // Cylinder materials: [side, top, bottom]
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), [
    objectSideMat(sideColor),
    objectTopMat(topColor),
    objectSideMat(sideColor),
  ]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(cx, floorY + yLift + height / 2, cz);
  addObjectContactShadow(group, cx, cz, floorY, radius * 1.15);
  group.add(mesh);
}

/** Individual chairs in a rows×cols grid with gaps — matches 2d editor chair-row. */
function addChairRowBlocks(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const n = chairCountForObject(o);
  const aspect = o.w / Math.max(1e-6, o.d);
  const { cols, rows } = chairGridDims(n, aspect);
  const cellW = o.w / cols;
  const cellH = o.d / rows;
  const gapFrac = CHAIR_ROW_GAP / (CHAIR_ROW_UNIT + CHAIR_ROW_GAP);
  const padX = cellW * gapFrac * 0.5;
  const padZ = cellH * gapFrac * 0.5;
  const seatH = objectFootprintHeight('chair');
  const backH = seatH * 1.35;
  const { side, top } = objectWallColors(o);
  let i = 0;
  for (let r = 0; r < rows && i < n; r++) {
    for (let c = 0; c < cols && i < n; c++) {
      const cw = Math.max(0.08, cellW - padX * 2);
      const cd = Math.max(0.08, cellH - padZ * 2);
      const cx = o.x + c * cellW + padX + cw / 2;
      const cz = o.z + r * cellH + padZ + cd / 2;
      // Seat
      addBoxAt(group, cx, cz, cw * 0.92, cd * 0.72, floorY, seatH * 0.55, side, top);
      // Backrest (toward −Z edge of cell, like 2d symbol)
      addBoxAt(
        group,
        cx,
        cz - cd * 0.32,
        cw * 0.92,
        cd * 0.12,
        floorY,
        backH,
        side,
        top,
      );
      i++;
    }
  }
}

function addSingleChairBlock(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const h = objectFootprintHeight(o.kind);
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  if (o.kind === 'chair-round' || o.kind === 'stool' || o.shape === 'circle') {
    addCylinderAt(group, cx, cz, Math.min(o.w, o.d) * 0.42, floorY, h * 0.55, side, top);
    addCylinderAt(group, cx, cz, Math.min(o.w, o.d) * 0.18, floorY, h, side, top);
    return;
  }
  addBoxAt(group, cx, cz, o.w * 0.88, o.d * 0.7, floorY, h * 0.55, side, top);
  addBoxAt(group, cx, cz - o.d * 0.32, o.w * 0.88, o.d * 0.12, floorY, h * 1.15, side, top);
}

function addTableMesh(group: THREE.Group, o: FloorBlock, floorY: number, round = false): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'table');
  const topH = Math.max(0.05, h * 0.12);
  if (round || o.shape === 'circle' || o.kind === 'table-round') {
    const r = Math.min(o.w, o.d) * 0.45;
    addCylinderAt(group, cx, cz, r, floorY + h - topH, topH, side, top, 0);
    addCylinderAt(group, cx, cz, r * 0.12, floorY, h - topH, side, top);
    return;
  }
  // Counter / bar / reception: solid apron (no skinny legs)
  if (o.kind === 'counter' || o.kind === 'bar' || o.kind === 'reception' || o.kind === 'kitchen-island') {
    addBoxAt(group, cx, cz, o.w * 0.94, o.d * 0.88, floorY, h * 0.88, side, top);
    addBoxAt(group, cx, cz, o.w * 0.98, o.d * 0.95, floorY + h * 0.88, topH, side, top, 0);
    return;
  }
  addBoxAt(group, cx, cz, o.w * 0.92, o.d * 0.92, floorY + h - topH, topH, side, top, 0);
  const legW = Math.max(0.05, Math.min(o.w, o.d) * 0.08);
  const insetX = o.w * 0.12;
  const insetZ = o.d * 0.12;
  for (const [lx, lz] of [
    [o.x + insetX, o.z + insetZ],
    [o.x + o.w - insetX, o.z + insetZ],
    [o.x + insetX, o.z + o.d - insetZ],
    [o.x + o.w - insetX, o.z + o.d - insetZ],
  ] as [number, number][]) {
    addBoxAt(group, lx, lz, legW, legW, floorY, h - topH, side, top);
  }
}

function addBoothMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight(o.kind ?? 'booth');
  const t = Math.max(0.06, Math.min(o.w, o.d) * 0.1);
  // Three walls; opening on min-Z (2d booth opening at top of symbol)
  addBoxAt(group, o.x + o.w / 2, o.z + o.d - t / 2, o.w, t, floorY, h, side, top);
  addBoxAt(group, o.x + t / 2, o.z + o.d / 2, t, o.d, floorY, h, side, top);
  addBoxAt(group, o.x + o.w - t / 2, o.z + o.d / 2, t, o.d, floorY, h, side, top);
  addBoxAt(group, o.x + o.w / 2, o.z + o.d / 2, o.w * 0.7, o.d * 0.55, floorY, h * 0.2, side, top);
}

function addPlantMesh(group: THREE.Group, o: FloorBlock, floorY: number, tree = false): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind);
  const r = Math.min(o.w, o.d) * (tree ? 0.22 : 0.28);
  addCylinderAt(group, cx, cz, r * (tree ? 0.45 : 0.55), floorY, h * (tree ? 0.18 : 0.28), side, top);
  addCylinderAt(group, cx, cz, r * (tree ? 0.12 : 0.18), floorY + h * (tree ? 0.15 : 0.25), h * (tree ? 0.45 : 0.35), side, top, 0);
  const foliage = new THREE.Mesh(
    new THREE.SphereGeometry(r * (tree ? 1.55 : 1.05), 12, 10),
    objectTopMat(top),
  );
  foliage.position.set(cx, floorY + h * (tree ? 0.78 : 0.7), cz);
  foliage.castShadow = true;
  group.add(foliage);
}

function addFountainMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('fountain');
  const r = Math.min(o.w, o.d) * 0.42;
  addCylinderAt(group, cx, cz, r, floorY, h * 0.28, side, top);
  addCylinderAt(group, cx, cz, r * 0.72, floorY + h * 0.22, h * 0.12, side, top, 0);
  addCylinderAt(group, cx, cz, r * 0.12, floorY + h * 0.28, h * 0.55, side, top, 0);
  addCylinderAt(group, cx, cz, r * 0.28, floorY + h * 0.78, h * 0.08, side, top, 0);
}

function addBedMesh(group: THREE.Group, o: FloorBlock, floorY: number, bunk = false): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const h = objectFootprintHeight(o.kind ?? 'bed');
  // Mattress (2d: 0.15–0.88) + headboard (2d: 0.15–0.38)
  addBoxAt(group, cx, o.z + o.d * 0.515, o.w * 0.84, o.d * 0.7, floorY, h * 0.5, side, top);
  addBoxAt(group, cx, o.z + o.d * 0.265, o.w * 0.84, o.d * 0.23, floorY, h * 1.05, side, top);
  if (o.kind === 'crib') {
    const railT = Math.max(0.03, Math.min(o.w, o.d) * 0.05);
    addBoxAt(group, o.x + o.w * 0.08, o.z + o.d * 0.5, railT, o.d * 0.78, floorY, h * 0.95, side, top);
    addBoxAt(group, o.x + o.w * 0.92, o.z + o.d * 0.5, railT, o.d * 0.78, floorY, h * 0.95, side, top);
    addBoxAt(group, cx, o.z + o.d * 0.88, o.w * 0.84, railT, floorY, h * 0.95, side, top);
  }
  if (bunk) {
    addBoxAt(group, cx, o.z + o.d * 0.515, o.w * 0.84, o.d * 0.7, floorY + h * 0.85, h * 0.45, side, top, 0);
    addBoxAt(group, o.x + o.w * 0.1, o.z + o.d * 0.5, o.w * 0.06, o.d * 0.85, floorY, h * 1.35, side, top);
    addBoxAt(group, o.x + o.w * 0.9, o.z + o.d * 0.5, o.w * 0.06, o.d * 0.85, floorY, h * 1.35, side, top);
  }
}

function addApplianceMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'fridge');
  addBoxAt(group, cx, cz, o.w * 0.92, o.d * 0.92, floorY, h, side, top);
  // Face panel / handle strip (2d horizontal line near top)
  addBoxAt(group, cx, o.z + o.d * 0.08, o.w * 0.78, o.d * 0.06, floorY + h * 0.55, h * 0.35, side, top, 0);
}

function addLockerBankMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'locker');
  addBoxAt(group, cx, cz, o.w * 0.94, o.d * 0.9, floorY, h, side, top);
  const doors = o.kind === 'parcel-locker' ? 4 : 3;
  const doorW = (o.w * 0.8) / doors;
  for (let i = 0; i < doors; i++) {
    const dx = o.x + o.w * 0.1 + doorW * (i + 0.5);
    addBoxAt(group, dx, o.z + o.d * 0.12, doorW * 0.85, o.d * 0.08, floorY + h * 0.12, h * 0.76, side, top, 0);
  }
}

function addElevatorMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight('elevator');
  const t = Math.max(0.06, Math.min(o.w, o.d) * 0.08);
  // Cabin walls, open on min-Z
  addBoxAt(group, o.x + o.w / 2, o.z + o.d - t / 2, o.w, t, floorY, h, side, top);
  addBoxAt(group, o.x + t / 2, o.z + o.d / 2, t, o.d, floorY, h, side, top);
  addBoxAt(group, o.x + o.w - t / 2, o.z + o.d / 2, t, o.d, floorY, h, side, top);
  addBoxAt(group, o.x + o.w / 2, o.z + o.d / 2, o.w * 0.85, o.d * 0.7, floorY, h * 0.08, side, top);
}

function addToiletMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const h = objectFootprintHeight('toilet');
  // Tank (2d top) + bowl (2d lower ellipse)
  addBoxAt(group, cx, o.z + o.d * 0.25, o.w * 0.5, o.d * 0.3, floorY, h * 0.9, side, top);
  addCylinderAt(group, cx, o.z + o.d * 0.65, Math.min(o.w, o.d) * 0.28, floorY, h * 0.42, side, top);
}

function addBathtubMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('bathtub');
  // Oval tub body (2d ellipse)
  addCylinderAt(group, cx, cz, Math.min(o.w, o.d) * 0.38, floorY, h * 0.55, side, top);
  addBoxAt(group, cx, cz, o.w * 0.72, o.d * 0.42, floorY + h * 0.2, h * 0.1, side, top, 0);
}

function addSinkMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'kitchen-sink');
  addBoxAt(group, cx, cz, o.w * 0.9, o.d * 0.7, floorY, h * 0.55, side, top);
  addBoxAt(group, cx, cz, o.w * 0.55, o.d * 0.4, floorY + h * 0.35, h * 0.12, side, top, 0);
  addCylinderAt(group, cx, o.z + o.d * 0.28, Math.min(o.w, o.d) * 0.05, floorY + h * 0.45, h * 0.2, side, top, 0);
}

function addFireplaceMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('fireplace');
  addBoxAt(group, cx, cz, o.w * 0.92, o.d * 0.7, floorY, h, side, top);
  addBoxAt(group, cx, o.z + o.d * 0.15, o.w * 0.55, o.d * 0.2, floorY + h * 0.15, h * 0.55, side, top, 0);
}

function addScreenMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'screen');
  const thick = Math.max(0.05, Math.min(o.w, o.d) * 0.14);
  // Screen panel (2d mid band) + stand
  addBoxAt(group, cx, cz, o.w * 0.88, thick, floorY + h * 0.28, h * 0.5, side, top, 0);
  addBoxAt(group, cx, cz, thick * 0.7, thick * 0.7, floorY, h * 0.32, side, top);
  addBoxAt(group, cx, cz, o.w * 0.28, o.d * 0.55, floorY, h * 0.06, side, top);
}

function addDoorMesh(group: THREE.Group, o: FloorBlock, floorY: number, double = false): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight(double ? 'double-door' : 'door');
  const thick = Math.max(0.04, Math.min(o.w, o.d) * 0.35);
  if (double) {
    addBoxAt(group, o.x + o.w * 0.28, o.z + o.d / 2, o.w * 0.4, thick, floorY, h, side, top, 0.01);
    addBoxAt(group, o.x + o.w * 0.72, o.z + o.d / 2, o.w * 0.4, thick, floorY, h, side, top, 0.01);
  } else {
    addBoxAt(group, o.x + o.w * 0.42, o.z + o.d / 2, o.w * 0.55, thick, floorY, h, side, top, 0.01);
  }
  // Jamb
  addBoxAt(group, o.x + o.w * 0.08, o.z + o.d / 2, Math.max(0.04, o.w * 0.08), thick * 1.2, floorY, h, side, top, 0.01);
}

function addWindowMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('window');
  const thick = Math.max(0.04, o.d);
  addBoxAt(group, cx, cz, o.w * 0.92, thick, floorY + h * 0.25, h * 0.5, side, top, 0.01);
  addBoxAt(group, cx, cz, Math.max(0.03, o.w * 0.04), thick * 1.1, floorY + h * 0.25, h * 0.5, side, top, 0.01);
}

function addRailingMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight('railing');
  const posts = Math.max(2, Math.round(o.w / 0.45));
  const postW = Math.max(0.04, Math.min(o.w, o.d) * 0.35);
  for (let i = 0; i < posts; i++) {
    const t = posts === 1 ? 0.5 : i / (posts - 1);
    addBoxAt(group, o.x + o.w * (0.08 + t * 0.84), o.z + o.d / 2, postW, postW, floorY, h * 0.92, side, top);
  }
  addBoxAt(group, o.x + o.w / 2, o.z + o.d / 2, o.w * 0.92, postW * 0.8, floorY + h * 0.88, h * 0.08, side, top, 0);
}

function addShelfMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('shelf');
  const levels = 3;
  for (let i = 0; i < levels; i++) {
    const y0 = floorY + (h * (i + 0.15)) / levels;
    addBoxAt(group, cx, cz, o.w * 0.92, o.d * 0.9, y0, Math.max(0.04, h * 0.06), side, top, 0);
  }
  addBoxAt(group, o.x + o.w * 0.08, cz, Math.max(0.04, o.w * 0.06), o.d * 0.9, floorY, h, side, top);
  addBoxAt(group, o.x + o.w * 0.92, cz, Math.max(0.04, o.w * 0.06), o.d * 0.9, floorY, h, side, top);
}

function addPodiumMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('podium');
  addBoxAt(group, cx, cz, o.w * 0.7, o.d * 0.7, floorY, h * 0.55, side, top);
  addBoxAt(group, cx, cz, o.w * 0.95, o.d * 0.55, floorY + h * 0.55, h * 0.4, side, top, 0);
}

function addStatueMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('statue');
  const r = Math.min(o.w, o.d) * 0.35;
  addCylinderAt(group, cx, cz, r * 1.1, floorY, h * 0.18, side, top);
  addCylinderAt(group, cx, cz, r * 0.55, floorY + h * 0.15, h * 0.55, side, top, 0);
  addCylinderAt(group, cx, cz, r * 0.7, floorY + h * 0.68, h * 0.28, side, top, 0);
}

function addBinMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'trash');
  const r = Math.min(o.w, o.d) * 0.38;
  addCylinderAt(group, cx, cz, r, floorY, h * 0.85, side, top);
  addCylinderAt(group, cx, cz, r * 1.08, floorY + h * 0.78, h * 0.1, side, top, 0);
}

function addExtinguisherMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('extinguisher');
  const r = Math.min(o.w, o.d) * 0.28;
  addCylinderAt(group, cx, cz, r, floorY, h * 0.85, side, top);
  addCylinderAt(group, cx, cz, r * 0.45, floorY + h * 0.82, h * 0.15, side, top, 0);
}

function addChargingDeskMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'charging');
  addBoxAt(group, cx, cz, o.w * 0.88, o.d * 0.7, floorY, h * 0.75, side, top);
  addBoxAt(group, cx, cz, o.w * 0.94, o.d * 0.8, floorY + h * 0.75, h * 0.12, side, top, 0);
  const slots = o.kind === 'charging-station' || o.kind === 'usb-hub' ? 3 : 1;
  for (let i = 0; i < slots; i++) {
    const t = slots === 1 ? 0.5 : (i + 1) / (slots + 1);
    addCylinderAt(group, o.x + o.w * t, cz, Math.min(o.w, o.d) * 0.06, floorY + h * 0.82, h * 0.12, side, top, 0);
  }
}

function addEvChargerMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('ev-charger');
  addBoxAt(group, cx, cz, o.w * 0.44, o.d * 0.66, floorY + h * 0.08, h * 0.78, side, top, 0);
  addBoxAt(group, cx, cz, o.w * 0.55, o.d * 0.55, floorY, h * 0.12, side, top);
  addBoxAt(group, o.x + o.w * 0.78, cz, o.w * 0.12, o.d * 0.12, floorY + h * 0.35, h * 0.35, side, top, 0);
}

function addWifiMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('wifi');
  const r = Math.min(o.w, o.d) * 0.18;
  addCylinderAt(group, cx, cz, r * 0.7, floorY, h * 0.55, side, top);
  addCylinderAt(group, cx, cz, r * 1.6, floorY + h * 0.5, h * 0.12, side, top, 0);
  addCylinderAt(group, cx, cz, r * 0.35, floorY + h * 0.58, h * 0.28, side, top, 0);
}

function addWaterFountainMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('water-fountain');
  addBoxAt(group, cx, o.z + o.d * 0.62, o.w * 0.55, o.d * 0.4, floorY, h * 0.55, side, top);
  addBoxAt(group, cx, o.z + o.d * 0.48, o.w * 0.6, o.d * 0.2, floorY + h * 0.5, h * 0.12, side, top, 0);
  addCylinderAt(group, cx, o.z + o.d * 0.35, Math.min(o.w, o.d) * 0.06, floorY + h * 0.55, h * 0.3, side, top, 0);
}

function addFacilityCabinetMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(o.kind ?? 'first-aid');
  addBoxAt(group, cx, cz, o.w * 0.88, o.d * 0.55, floorY + h * 0.2, h * 0.7, side, top, 0);
  addBoxAt(group, cx, cz, o.w * 0.5, o.d * 0.35, floorY, h * 0.22, side, top);
}

function addWheelchairMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('wheelchair');
  addBoxAt(group, cx, cz, o.w * 0.55, o.d * 0.45, floorY + h * 0.25, h * 0.35, side, top, 0);
  addBoxAt(group, cx, o.z + o.d * 0.28, o.w * 0.55, o.d * 0.12, floorY + h * 0.25, h * 0.7, side, top, 0);
  const wr = Math.min(o.w, o.d) * 0.22;
  addCylinderAt(group, o.x + o.w * 0.22, o.z + o.d * 0.65, wr, floorY, wr * 0.35, side, top);
  addCylinderAt(group, o.x + o.w * 0.78, o.z + o.d * 0.65, wr, floorY, wr * 0.35, side, top);
}

function addRestroomMarkerMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight(o.kind ?? 'restroom');
  const t = Math.max(0.05, Math.min(o.w, o.d) * 0.06);
  // Low cubicle walls (open front) — reads as WC room marker, not a flat plate
  addBoxAt(group, o.x + o.w / 2, o.z + o.d - t / 2, o.w * 0.92, t, floorY, h * 0.85, side, top);
  addBoxAt(group, o.x + t / 2, o.z + o.d / 2, t, o.d * 0.85, floorY, h * 0.85, side, top);
  addBoxAt(group, o.x + o.w - t / 2, o.z + o.d / 2, t, o.d * 0.85, floorY, h * 0.85, side, top);
  addBoxAt(group, o.x + o.w / 2, o.z + o.d / 2, o.w * 0.5, o.d * 0.4, floorY, h * 0.12, side, top);
}

function addCoatCheckMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('coat-check');
  addBoxAt(group, cx, cz, o.w * 0.92, o.d * 0.7, floorY, h * 0.55, side, top);
  addBoxAt(group, o.x + o.w * 0.1, cz, Math.max(0.04, o.w * 0.05), o.d * 0.5, floorY, h, side, top);
  addBoxAt(group, o.x + o.w * 0.9, cz, Math.max(0.04, o.w * 0.05), o.d * 0.5, floorY, h, side, top);
  addBoxAt(group, cx, cz, o.w * 0.85, Math.max(0.04, o.d * 0.08), floorY + h * 0.88, h * 0.08, side, top, 0);
}

function addStageMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight('stage');
  // 2d stage: wider back (ny~0.55) tapering to front (ny~0.85)
  addBoxAt(group, o.x + o.w / 2, o.z + o.d * 0.7, o.w * 0.9, o.d * 0.35, floorY, h, side, top);
  addBoxAt(group, o.x + o.w / 2, o.z + o.d * 0.48, o.w * 0.98, o.d * 0.22, floorY, h * 1.05, side, top);
}

function addShowerMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('shower');
  addBoxAt(group, cx, cz, o.w * 0.88, o.d * 0.88, floorY, h * 0.1, side, top);
  addCylinderAt(group, cx, o.z + o.d * 0.35, Math.min(o.w, o.d) * 0.05, floorY, h * 0.85, side, top);
  addCylinderAt(group, cx, o.z + o.d * 0.35, Math.min(o.w, o.d) * 0.14, floorY + h * 0.78, h * 0.08, side, top, 0);
}

function addArmchairMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('armchair');
  addBoxAt(group, cx, cz + o.d * 0.05, o.w * 0.7, o.d * 0.55, floorY, h * 0.5, side, top);
  addBoxAt(group, cx, o.z + o.d * 0.18, o.w * 0.7, o.d * 0.14, floorY, h, side, top);
  addBoxAt(group, o.x + o.w * 0.12, cz + o.d * 0.05, o.w * 0.14, o.d * 0.55, floorY, h * 0.75, side, top);
  addBoxAt(group, o.x + o.w * 0.88, cz + o.d * 0.05, o.w * 0.14, o.d * 0.55, floorY, h * 0.75, side, top);
}

function addVehicleWheels(
  group: THREE.Group,
  o: FloorBlock,
  floorY: number,
  side: string,
  top: string,
  positions: Array<[number, number]>,
  radiusFrac = 0.12,
): void {
  const wr = Math.min(o.w, o.d) * radiusFrac;
  const wh = Math.max(0.06, wr * 0.55);
  for (const [nx, nz] of positions) {
    addCylinderAt(group, o.x + o.w * nx, o.z + o.d * nz, wr, floorY, wh, side, top);
  }
}

/** Sedan / SUV / compact — body + cabin + four wheels. */
function addCarMesh(group: THREE.Group, o: FloorBlock, floorY: number, tall = false): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(tall ? 'suv' : 'car');
  const bodyH = h * (tall ? 0.55 : 0.48);
  addBoxAt(group, cx, cz, o.w * 0.84, o.d * 0.56, floorY + 0.06, bodyH, side, top, 0);
  addBoxAt(group, cx, cz, o.w * 0.44, o.d * 0.48, floorY + 0.06 + bodyH * 0.85, h * (tall ? 0.42 : 0.35), side, top, 0);
  addVehicleWheels(
    group,
    o,
    floorY,
    side,
    top,
    [
      [0.22, 0.18],
      [0.78, 0.18],
      [0.22, 0.82],
      [0.78, 0.82],
    ],
    0.1,
  );
}

/** Van / bus — longer boxy cabin with window notches. */
function addVanMesh(group: THREE.Group, o: FloorBlock, floorY: number, bus = false): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(bus ? 'bus' : 'van');
  addBoxAt(group, cx, cz, o.w * 0.9, o.d * 0.6, floorY + 0.07, h * 0.72, side, top, 0);
  // Cab nose
  addBoxAt(group, o.x + o.w * 0.16, cz, o.w * 0.22, o.d * 0.55, floorY + 0.07, h * 0.55, side, top, 0);
  // Roof ridge / window band
  addBoxAt(group, o.x + o.w * 0.58, cz, o.w * 0.55, o.d * 0.42, floorY + 0.07 + h * 0.55, h * 0.28, side, top, 0);
  if (bus) {
    for (const nx of [0.4, 0.55, 0.7, 0.85]) {
      addBoxAt(group, o.x + o.w * nx, cz, o.w * 0.06, o.d * 0.38, floorY + 0.07 + h * 0.35, h * 0.28, side, top, 0);
    }
  }
  addVehicleWheels(
    group,
    o,
    floorY,
    side,
    top,
    [
      [0.18, 0.16],
      [0.82, 0.16],
      [0.18, 0.84],
      [0.82, 0.84],
    ],
    0.09,
  );
}

/** Truck / pickup / forklift — cab + cargo bed. */
function addTruckMesh(group: THREE.Group, o: FloorBlock, floorY: number, forklift = false): void {
  const { side, top } = objectWallColors(o);
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(forklift ? 'forklift' : 'truck');
  // Cab
  addBoxAt(group, o.x + o.w * 0.18, cz, o.w * 0.28, o.d * 0.55, floorY + 0.07, h * 0.7, side, top, 0);
  // Cargo / mast
  if (forklift) {
    addBoxAt(group, o.x + o.w * 0.62, cz, o.w * 0.45, o.d * 0.45, floorY + 0.07, h * 0.35, side, top, 0);
    addBoxAt(group, o.x + o.w * 0.88, cz, o.w * 0.08, o.d * 0.55, floorY + 0.07, h * 0.95, side, top, 0);
    addBoxAt(group, o.x + o.w * 0.95, cz, o.w * 0.12, o.d * 0.12, floorY + 0.07 + h * 0.35, h * 0.08, side, top, 0);
  } else {
    addBoxAt(group, o.x + o.w * 0.64, cz, o.w * 0.58, o.d * 0.62, floorY + 0.07, h * 0.85, side, top, 0);
  }
  addVehicleWheels(
    group,
    o,
    floorY,
    side,
    top,
    [
      [0.16, 0.16],
      [0.5, 0.16],
      [0.82, 0.16],
      [0.16, 0.84],
      [0.5, 0.84],
      [0.82, 0.84],
    ],
    0.08,
  );
}

/** Bicycle — two wheels + thin frame. */
function addBicycleMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('bike');
  const wr = Math.min(o.w, o.d) * 0.28;
  addCylinderAt(group, o.x + o.w * 0.22, cz, wr, floorY, wr * 0.35, side, top);
  addCylinderAt(group, o.x + o.w * 0.78, cz, wr, floorY, wr * 0.35, side, top);
  addBoxAt(group, o.x + o.w * 0.5, cz, o.w * 0.45, Math.max(0.04, o.d * 0.12), floorY + wr * 0.4, h * 0.35, side, top, 0);
  addBoxAt(group, o.x + o.w * 0.45, o.z + o.d * 0.35, o.w * 0.08, o.d * 0.35, floorY + wr * 0.4, h * 0.55, side, top, 0);
  addBoxAt(group, o.x + o.w * 0.78, o.z + o.d * 0.32, o.w * 0.12, Math.max(0.04, o.d * 0.08), floorY + wr * 0.5 + h * 0.35, h * 0.12, side, top, 0);
}

/** Motorcycle / scooter. */
function addMotorcycleMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('motorcycle');
  const wr = Math.min(o.w, o.d) * 0.22;
  addCylinderAt(group, o.x + o.w * 0.2, cz, wr, floorY, wr * 0.4, side, top);
  addCylinderAt(group, o.x + o.w * 0.8, cz, wr, floorY, wr * 0.4, side, top);
  addBoxAt(group, o.x + o.w * 0.5, cz, o.w * 0.42, o.d * 0.35, floorY + wr * 0.35, h * 0.55, side, top, 0);
  addBoxAt(group, o.x + o.w * 0.46, o.z + o.d * 0.32, o.w * 0.22, o.d * 0.18, floorY + wr * 0.35 + h * 0.45, h * 0.2, side, top, 0);
}

/** Bike rack rails. */
function addBikeRackMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight('bike-rack');
  const t = Math.max(0.04, Math.min(o.w, o.d) * 0.04);
  addBoxAt(group, o.x + o.w / 2, o.z + o.d * 0.2, o.w * 0.84, t, floorY, h, side, top);
  addBoxAt(group, o.x + o.w / 2, o.z + o.d * 0.8, o.w * 0.84, t, floorY, h, side, top);
  for (const nx of [0.25, 0.4, 0.55, 0.7]) {
    addBoxAt(group, o.x + o.w * nx, o.z + o.d / 2, t, o.d * 0.55, floorY, h * 0.9, side, top);
  }
}

/** Flat parking bay pad (EV gets a small charger stub). */
function addParkingSpotMesh(group: THREE.Group, o: FloorBlock, floorY: number, ev = false): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(ev ? 'ev-parking' : 'parking-spot');
  addBoxAt(group, cx, cz, o.w * 0.92, o.d * 0.88, floorY, Math.max(0.02, h), side, top, 0.005);
  const t = Math.max(0.04, Math.min(o.w, o.d) * 0.03);
  addBoxAt(group, cx, o.z + t / 2, o.w * 0.92, t, floorY, 0.08, side, top);
  addBoxAt(group, cx, o.z + o.d - t / 2, o.w * 0.92, t, floorY, 0.08, side, top);
  addBoxAt(group, o.x + t / 2, cz, t, o.d * 0.88, floorY, 0.08, side, top);
  addBoxAt(group, o.x + o.w - t / 2, cz, t, o.d * 0.88, floorY, 0.08, side, top);
  if (ev) {
    addBoxAt(group, o.x + o.w * 0.12, o.z + o.d * 0.2, o.w * 0.08, o.d * 0.12, floorY, 0.45, side, top);
  }
}

/** Shopping cart / trolley. */
function addCartMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight('cart');
  addBoxAt(group, cx, cz - o.d * 0.05, o.w * 0.7, o.d * 0.45, floorY + 0.08, h * 0.55, side, top, 0);
  addBoxAt(group, o.x + o.w * 0.15, cz - o.d * 0.05, Math.max(0.03, o.w * 0.06), o.d * 0.4, floorY + 0.08, h * 0.85, side, top, 0);
  addBoxAt(group, o.x + o.w * 0.85, cz - o.d * 0.05, Math.max(0.03, o.w * 0.06), o.d * 0.4, floorY + 0.08, h * 0.85, side, top, 0);
  const wr = Math.min(o.w, o.d) * 0.12;
  addCylinderAt(group, o.x + o.w * 0.3, o.z + o.d * 0.78, wr, floorY, wr * 0.4, side, top);
  addCylinderAt(group, o.x + o.w * 0.7, o.z + o.d * 0.78, wr, floorY, wr * 0.4, side, top);
}

function addKindedObjectMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const kind = o.kind || '';
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(kind);
  const isCircle = o.shape === 'circle';

  if (kind === 'chair-row') {
    addChairRowBlocks(group, o, floorY);
    return;
  }
  if (kind === 'armchair') {
    addArmchairMesh(group, o, floorY);
    return;
  }
  if (kind === 'chair' || kind === 'chair-round' || kind === 'stool') {
    addSingleChairBlock(group, o, floorY);
    return;
  }
  if (kind === 'sofa' || kind === 'seating-block') {
    addSofaMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'bench') {
    addSofaMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'sofa-l') {
    addSofaLMesh(group, o, floorY);
    return;
  }
  if (
    kind === 'table' ||
    kind === 'table-round' ||
    kind === 'desk' ||
    kind === 'counter' ||
    kind === 'coffee-table' ||
    kind === 'dining-table' ||
    kind === 'kitchen-island' ||
    kind === 'reception' ||
    kind === 'bar'
  ) {
    addTableMesh(group, o, floorY, kind === 'table-round');
    return;
  }
  if (
    kind === 'bed' ||
    kind === 'bed-single' ||
    kind === 'bed-double' ||
    kind === 'bed-king' ||
    kind === 'crib'
  ) {
    addBedMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'bunk-bed') {
    addBedMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'booth' || kind === 'photo-booth' || kind === 'ticket' || kind === 'info' || kind === 'atm') {
    addBoothMesh(group, o, floorY);
    return;
  }
  if (kind === 'plant') {
    addPlantMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'tree') {
    addPlantMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'fountain') {
    addFountainMesh(group, o, floorY);
    return;
  }
  if (
    kind === 'stove' ||
    kind === 'fridge' ||
    kind === 'dishwasher' ||
    kind === 'washer' ||
    kind === 'vending' ||
    kind === 'printer' ||
    kind === 'cabinet' ||
    kind === 'wardrobe' ||
    kind === 'closet' ||
    kind === 'dresser' ||
    kind === 'nightstand'
  ) {
    addApplianceMesh(group, o, floorY);
    return;
  }
  if (kind === 'locker' || kind === 'parcel-locker') {
    addLockerBankMesh(group, o, floorY);
    return;
  }
  if (kind === 'elevator') {
    addElevatorMesh(group, o, floorY);
    return;
  }
  if (kind === 'coat-check') {
    addCoatCheckMesh(group, o, floorY);
    return;
  }
  if (kind === 'toilet') {
    addToiletMesh(group, o, floorY);
    return;
  }
  if (kind === 'bathtub') {
    addBathtubMesh(group, o, floorY);
    return;
  }
  if (kind === 'kitchen-sink' || kind === 'bathroom-sink') {
    addSinkMesh(group, o, floorY);
    return;
  }
  if (kind === 'fireplace') {
    addFireplaceMesh(group, o, floorY);
    return;
  }
  if (kind === 'shower') {
    addShowerMesh(group, o, floorY);
    return;
  }
  if (
    kind === 'screen' ||
    kind === 'led-wall' ||
    kind === 'billboard' ||
    kind === 'sign' ||
    kind === 'tv-stand'
  ) {
    addScreenMesh(group, o, floorY);
    return;
  }
  if (kind === 'door') {
    addDoorMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'double-door') {
    addDoorMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'window') {
    addWindowMesh(group, o, floorY);
    return;
  }
  if (kind === 'railing') {
    addRailingMesh(group, o, floorY);
    return;
  }
  if (kind === 'shelf') {
    addShelfMesh(group, o, floorY);
    return;
  }
  if (kind === 'wall' || kind === 'banner') {
    addBoxAt(group, cx, cz, o.w, Math.max(0.04, o.d), floorY, h, side, top, 0.01);
    return;
  }
  if (kind === 'stairs' || kind === 'stairs-house') {
    const steps = 5;
    const stepD = o.d / steps;
    const stepH = h / steps;
    for (let s = 0; s < steps; s++) {
      addBoxAt(
        group,
        cx,
        o.z + stepD * (s + 0.5),
        o.w * 0.96,
        stepD * 0.92,
        floorY,
        stepH * (s + 1),
        side,
        top,
        0.01,
      );
    }
    return;
  }
  if (kind === 'escalator') {
    const steps = 6;
    const stepD = o.d / steps;
    const stepH = h / steps;
    for (let s = 0; s < steps; s++) {
      addBoxAt(
        group,
        cx,
        o.z + stepD * (s + 0.5),
        o.w * 0.9,
        stepD * 0.88,
        floorY + stepH * s * 0.15,
        stepH * (s + 1),
        side,
        top,
        0.01,
      );
    }
    return;
  }
  if (kind === 'pillar') {
    addCylinderAt(group, cx, cz, Math.min(o.w, o.d) * 0.38, floorY, h, side, top);
    return;
  }
  if (kind === 'column') {
    addBoxAt(group, cx, cz, o.w * 0.72, o.d * 0.72, floorY, h, side, top);
    return;
  }
  if (kind === 'podium') {
    addPodiumMesh(group, o, floorY);
    return;
  }
  if (kind === 'statue') {
    addStatueMesh(group, o, floorY);
    return;
  }
  if (kind === 'trash' || kind === 'recycling') {
    addBinMesh(group, o, floorY);
    return;
  }
  if (kind === 'extinguisher') {
    addExtinguisherMesh(group, o, floorY);
    return;
  }
  if (kind === 'rug') {
    addBoxAt(group, cx, cz, o.w, o.d, floorY, Math.max(0.02, h), side, top, 0.005);
    return;
  }
  if (kind === 'stage') {
    addStageMesh(group, o, floorY);
    return;
  }
  if (
    kind === 'charging' ||
    kind === 'charging-station' ||
    kind === 'phone-charging' ||
    kind === 'usb-hub' ||
    kind === 'power-outlet'
  ) {
    addChargingDeskMesh(group, o, floorY);
    return;
  }
  if (kind === 'ev-charger') {
    addEvChargerMesh(group, o, floorY);
    return;
  }
  if (kind === 'wifi') {
    addWifiMesh(group, o, floorY);
    return;
  }
  if (kind === 'water-fountain') {
    addWaterFountainMesh(group, o, floorY);
    return;
  }
  if (kind === 'first-aid' || kind === 'aed') {
    addFacilityCabinetMesh(group, o, floorY);
    return;
  }
  if (kind === 'wheelchair') {
    addWheelchairMesh(group, o, floorY);
    return;
  }
  if (kind === 'smoking') {
    addBinMesh(group, o, floorY);
    return;
  }
  if (
    kind === 'restroom' ||
    kind === 'accessible-restroom' ||
    kind === 'baby-changing' ||
    kind === 'prayer-room'
  ) {
    addRestroomMarkerMesh(group, o, floorY);
    return;
  }
  if (kind === 'car' || kind === 'car-compact') {
    addCarMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'suv') {
    addCarMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'van') {
    addVanMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'bus') {
    addVanMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'truck' || kind === 'pickup') {
    addTruckMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'forklift') {
    addTruckMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'bike') {
    addBicycleMesh(group, o, floorY);
    return;
  }
  if (kind === 'motorcycle' || kind === 'scooter') {
    addMotorcycleMesh(group, o, floorY);
    return;
  }
  if (kind === 'bike-rack') {
    addBikeRackMesh(group, o, floorY);
    return;
  }
  if (kind === 'parking-spot') {
    addParkingSpotMesh(group, o, floorY, false);
    return;
  }
  if (kind === 'ev-parking') {
    addParkingSpotMesh(group, o, floorY, true);
    return;
  }
  if (kind === 'cart') {
    addCartMesh(group, o, floorY);
    return;
  }
  if (kind === 'wheelchair-vehicle') {
    addWheelchairMesh(group, o, floorY);
    return;
  }

  // Fallback for any future catalog kind
  if (isCircle) {
    addCylinderAt(group, cx, cz, Math.min(o.w, o.d) * 0.42, floorY, h * 0.7, side, top);
  } else {
    addBoxAt(group, cx, cz, o.w * 0.9, o.d * 0.9, floorY, Math.min(h, Math.max(0.15, h * 0.55)), side, top);
  }
}

/** Straight sofa / bench — seat + backrest + cushion dividers (matches 2d symbol). */
function addSofaMesh(
  group: THREE.Group,
  o: FloorBlock,
  floorY: number,
  bench = false,
): void {
  const { side, top } = objectWallColors(o);
  const cx = o.x + o.w / 2;
  const cz = o.z + o.d / 2;
  const h = objectFootprintHeight(bench ? 'bench' : 'sofa');
  const seatH = h * 0.55;
  // Seat body (2d: y 0.25–0.82)
  addBoxAt(group, cx, cz + o.d * 0.04, o.w * 0.88, o.d * 0.57, floorY, seatH, side, top);
  // Backrest along the back edge (2d: top of sofa)
  addBoxAt(
    group,
    cx,
    o.z + o.d * 0.18,
    o.w * 0.88,
    o.d * 0.14,
    floorY,
    h,
    side,
    top,
  );
  if (!bench) {
    // Armrests
    addBoxAt(
      group,
      o.x + o.w * 0.08,
      cz + o.d * 0.04,
      o.w * 0.08,
      o.d * 0.57,
      floorY,
      h * 0.85,
      side,
      top,
    );
    addBoxAt(
      group,
      o.x + o.w * 0.92,
      cz + o.d * 0.04,
      o.w * 0.08,
      o.d * 0.57,
      floorY,
      h * 0.85,
      side,
      top,
    );
    // Cushion dividers at ~1/3 and 2/3 (2d vertical lines)
    for (const nx of [0.33, 0.66]) {
      addBoxAt(
        group,
        o.x + o.w * nx,
        cz + o.d * 0.04,
        Math.max(0.03, o.w * 0.02),
        o.d * 0.5,
        floorY,
        seatH * 1.08,
        side,
        top,
        seatH * 0.02,
      );
    }
  }
}

/**
 * L-sofa — matches 2d `sofa-l` footprint:
 * vertical arm (left) + horizontal arm (bottom-right).
 */
function addSofaLMesh(group: THREE.Group, o: FloorBlock, floorY: number): void {
  const { side, top } = objectWallColors(o);
  const h = objectFootprintHeight('sofa-l');
  const seatH = h * 0.55;
  // Left / vertical leg: x 0.08–0.55, z 0.08–0.92
  const leftW = o.w * 0.47;
  const leftD = o.d * 0.84;
  const leftCx = o.x + o.w * 0.08 + leftW / 2;
  const leftCz = o.z + o.d * 0.08 + leftD / 2;
  addBoxAt(group, leftCx, leftCz, leftW, leftD, floorY, seatH, side, top);
  // Backrest along left outer edge
  addBoxAt(
    group,
    o.x + o.w * 0.12,
    leftCz,
    o.w * 0.1,
    leftD * 0.92,
    floorY,
    h,
    side,
    top,
  );
  // Bottom / horizontal leg: x 0.55–0.92, z 0.55–0.92
  const botW = o.w * 0.37;
  const botD = o.d * 0.37;
  const botCx = o.x + o.w * 0.55 + botW / 2;
  const botCz = o.z + o.d * 0.55 + botD / 2;
  addBoxAt(group, botCx, botCz, botW, botD, floorY, seatH, side, top);
  // Backrest along bottom outer edge
  addBoxAt(
    group,
    botCx,
    o.z + o.d * 0.88,
    botW * 0.92,
    o.d * 0.1,
    floorY,
    h,
    side,
    top,
  );
}

function addObjectBlocks(group: THREE.Group, objects: FloorBlock[], floorY: number): void {
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const rot = objectRotationRad(o);
    const needsPivot = Math.abs(rot) > 1e-6;
    const target: THREE.Group = needsPivot ? new THREE.Group() : group;
    const local: FloorBlock = needsPivot
      ? { ...o, x: -o.w / 2, z: -o.d / 2 }
      : o;

    if (local.kind) {
      addKindedObjectMesh(target, local, floorY);
    } else {
      // Legacy freehand objects (no catalog kind) — width×depth box at half wall height.
      const h = OBJECT_BLOCK_HEIGHT;
      const { side, top } = objectWallColors(local);
      const cx = local.x + local.w / 2;
      const cz = local.z + local.d / 2;
      if (local.shape === 'circle') {
        addCylinderAt(target, cx, cz, Math.min(local.w, local.d) * 0.45, floorY, h, side, top);
      } else {
        addBoxAt(target, cx, cz, local.w, local.d, floorY, h, side, top);
      }
    }

    if (needsPivot) {
      // Match 2D editor: positive degrees rotate clockwise on the map (y-down).
      // Three.js +Y is CCW from above, so negate.
      target.position.set(o.x + o.w / 2, 0, o.z + o.d / 2);
      target.rotation.y = -rot;
      group.add(target);
    }
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
  pois?: NavMapPoi[];
  stairMouths?: StairMouth[];
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
  routeOrigin?: { x: number; z: number } | null;
  routeDest?: { x: number; z: number } | null;
  verticalPlateStack?: boolean;
  showWalls?: boolean;
  showInteriorVolumes?: boolean;
  showObjects?: boolean;
  /** View-all browse: lightweight tiles on non-active floors. */
  lightweightPlates?: boolean;
  activeFloorId?: string | null;
  /** Stair mouths on the active floor (single-floor 3D markers). */
  stairMouths?: StairMouth[];
  /** Active floor index for single-floor 3D corridor tint. */
  floorIndex?: number;
  /** Highlighted POI id for floor-name labels. */
  selectedPoiId?: string;
  /** Hide From/To POI name labels while a navigation route is shown. */
  hideRouteEndpointLabels?: boolean;
};

type FloorDisplayLayer = Floor2DScene3dFloorLayer & {
  displayY: number;
};

function addStairMouthRouteMarkers3d(
  parent: THREE.Object3D,
  link: FloorRouteConnector,
  leaveY: number,
  enterY: number,
): void {
  const mat = new THREE.MeshBasicMaterial({ color: hex(NAVIA_NEON) });
  const pts = [
    { x: link.from.x, y: leaveY + ROUTE_LIFT + 0.12, z: link.from.z },
    { x: link.to.x, y: enterY + ROUTE_LIFT + 0.12, z: link.to.z },
  ];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 20), mat);
    disc.position.set(p.x, p.y, p.z);
    parent.add(disc);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.55, 28),
      new THREE.MeshBasicMaterial({
        color: hex(NAVIA_NEON_BRIGHT),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, p.y + 0.02, p.z);
    parent.add(ring);
  }
}

type NavCameraFrame = {
  origin: { x: number; y: number; z: number };
  dest: { x: number; y: number; z: number };
  path: { x: number; y: number; z: number }[];
};

class Floor2DScene3d {
  readonly domElement: HTMLCanvasElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly content: THREE.Group;
  private readonly staticRoot: THREE.Group;
  private readonly dynamicRoot: THREE.Group;
  private readonly routeTubeMat: THREE.MeshPhysicalMaterial;
  private keyLight!: THREE.DirectionalLight;
  private readonly routeAnimEntries: RouteAnimEntry[] = [];
  private raf = 0;
  private visible = false;
  private renderLoopActive = false;
  private needsRender = false;
  private controlActive = false;
  private cameraAnimRaf = 0;
  /** Bumped when the user takes over so in-flight route zooms stop. */
  private cameraAnimGen = 0;
  private lastStaticKey = '';
  private lastSyncData: Floor2DScene3dSync | null = null;
  private onCameraChange: (() => void) | null = null;
  private staticPlateGen = 0;
  private zoneBlinkAnimating = false;
  private readonly zoneBlinkRoot: THREE.Group;
  private readonly zoneBlinkMeshes = new Map<string, THREE.Group>();
  private readonly mapParent: HTMLElement;
  /** When true, orbit is locked to a top-down (2D) angle; pan/zoom still work. */
  private topDownLocked = false;

  constructor(parent: HTMLElement) {
    this.mapParent = parent;
    this.domElement = document.createElement('canvas');
    this.domElement.className = 'wf-sketch-canvas';
    this.domElement.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none;z-index:2;';
    parent.appendChild(this.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = hex(getSceneBgColor());
    onWayfinderTheme(() => {
      // Re-colour the whole 3D map: swap background + rebuild static geometry
      // (walls/floor/rooms/zones) so it matches the new theme palette.
      this.scene.background = hex(getSceneBgColor());
      this.lastStaticKey = '';
      if (this.lastSyncData) this.sync(this.lastSyncData, false);
      this.needsRender = true;
    });
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.domElement,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(deviceRenderDpr());
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    // Pencil sketch — depth from cross-hatch, not cast shadows.
    this.renderer.shadowMap.enabled = false;

    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.rotateSpeed = 1.15;
    this.controls.zoomSpeed = 0.92;
    this.controls.panSpeed = 0.85;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 600;
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = Math.PI - 0.06;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.addEventListener('start', () => {
      // User took over — stop any programmed route fly so the camera stays free to orbit.
      if (this.cameraAnimRaf) {
        cancelAnimationFrame(this.cameraAnimRaf);
        this.cameraAnimRaf = 0;
      }
      this.cameraAnimGen++;
      this.controlActive = true;
      this.startRenderLoop();
    });
    this.controls.addEventListener('end', () => {
      this.controlActive = false;
      this.needsRender = true;
    });
    this.controls.addEventListener('change', () => {
      this.requestRender();
      this.onCameraChange?.();
    });

    // Soft even lighting for blueprint glass walls.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xf0f5fa, 0.72));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.42);
    key.position.set(-42, 68, -28);
    key.castShadow = false;
    this.keyLight = key;
    this.scene.add(key);
    this.scene.add(key.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.32);
    fill.position.set(36, 24, 48);
    this.scene.add(fill);

    this.content = new THREE.Group();
    this.staticRoot = new THREE.Group();
    this.dynamicRoot = new THREE.Group();
    this.zoneBlinkRoot = new THREE.Group();
    this.content.add(this.staticRoot);
    this.content.add(this.dynamicRoot);
    this.content.add(this.zoneBlinkRoot);
    this.scene.add(this.content);
    this.routeTubeMat = routeGlossMaterial(EXPOFP_ROUTE_ACTIVE, {
      emissiveIntensity: 0.72,
      gloss: true,
    }) as THREE.MeshPhysicalMaterial;
    this.routeTubeMat.depthTest = false;
  }

  requestRender(): void {
    this.needsRender = true;
    if (this.visible) this.startRenderLoop();
  }

  private startRenderLoop(): void {
    if (this.renderLoopActive) return;
    this.renderLoopActive = true;
    this.scheduleFrame();
  }

  private stopRenderLoop(): void {
    this.renderLoopActive = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private scheduleFrame(): void {
    if (!this.renderLoopActive) return;
    this.raf = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (): void => {
    if (!this.renderLoopActive || !this.visible) {
      this.stopRenderLoop();
      return;
    }
    this.scheduleFrame();
    this.controls.update();
    const animating = this.routeAnimEntries.length > 0 || this.zoneBlinkAnimating;
    if (animating) {
      const progress = routeAnimProgress();
      for (let i = 0; i < this.routeAnimEntries.length; i++) {
        refreshExpoFpRouteActive(this.routeAnimEntries[i], progress);
      }
      this.needsRender = true;
    }
    if (!this.needsRender && !this.controlActive && !animating) return;
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
  };

  /** Raycast tap position onto the active floor plane (world XZ). */
  pickFloorPoint(
    clientX: number,
    clientY: number,
    floorY: number,
    rect: DOMRect,
  ): { x: number; z: number } | null {
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, z: hit.z };
  }

  /**
   * Prefer hitting a POI floor-label mesh; otherwise a tight world hit near a label.
   * Empty floor taps return null so From/To is not filled.
   */
  pickPoiIdAt(
    clientX: number,
    clientY: number,
    floorY: number,
    rect: DOMRect,
    pois: NavMapPoi[],
  ): string | null {
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hits = raycaster.intersectObjects(this.dynamicRoot.children, true);
    for (let i = 0; i < hits.length; i++) {
      let obj: THREE.Object3D | null = hits[i].object;
      while (obj) {
        const id = obj.userData?.wfPoiId;
        if (typeof id === 'string' && id) return id;
        obj = obj.parent;
      }
    }
    const floor = this.pickFloorPoint(clientX, clientY, floorY, rect);
    if (!floor || !pois.length) return null;
    let bestId = '';
    let bestDist = POI_FLOOR_LABEL_TAP_RADIUS;
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      if (!(p.name ?? '').trim()) continue;
      const d = Math.hypot(p.x - floor.x, p.z - floor.z);
      if (d < bestDist) {
        bestDist = d;
        bestId = p.id;
      }
    }
    return bestId || null;
  }

  projectToScreen(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
  ): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, y, z);
    v.project(this.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * width, y: ((-v.y + 1) / 2) * height };
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.domElement.style.display = on ? 'block' : 'none';
    this.domElement.style.pointerEvents = on ? 'auto' : 'none';
    this.controls.enabled = on;
    if (on) {
      this.requestRender();
    } else {
      this.stopRenderLoop();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  setOnCameraChange(handler: (() => void) | null): void {
    this.onCameraChange = handler;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(deviceRenderDpr());
    this.renderer.setSize(w, h, false);
    this.applyCameraViewportInset();
    this.requestRender();
  }

  private measureBottomInsetPx(): number {
    return measureMapBottomInsetPx(this.mapParent);
  }

  /** Extra zoom-out so content fits in the band above the bottom nav panel. */
  private bottomBarPadFactor(): number {
    const bottom = this.measureBottomInsetPx();
    const h = Math.max(1, this.domElement.clientHeight);
    if (bottom <= 10) return 1;
    return 1 + (bottom / h) * 0.55;
  }

  /**
   * Nudge the orbit target on Z so the map centroid sits in the middle of the
   * visible band above the bottom dock (matches 2D fit oy).
   */
  private bottomBarCenterShiftZ(spanZ: number): number {
    const bottom = this.measureBottomInsetPx();
    const h = Math.max(1, this.domElement.clientHeight);
    if (bottom <= 10) return 0;
    return (bottom / h) * Math.max(spanZ, 4) * 0.36;
  }

  /** When the camera target is the destination, shift it so the pin sits above the bottom bar. */
  private bottomBarAnchorShiftZ(cameraDist: number): number {
    const bottom = this.measureBottomInsetPx();
    const h = Math.max(1, this.domElement.clientHeight);
    if (bottom <= 10) return 0;
    const vfovRad = (this.camera.fov * Math.PI) / 180;
    const worldSpanV = 2 * cameraDist * Math.tan(vfovRad / 2);
    return (bottom / h) * worldSpanV * 0.24;
  }

  /** Distance for nav framing — fits full route span and both endpoints. */
  private navRouteCameraDistance(
    uSpan: number,
    vSpan: number,
    targetForward: number,
    pad: number,
    uBehind = 0,
  ): number {
    const bottom = this.measureBottomInsetPx();
    const h = Math.max(1, this.domElement.clientHeight);
    const w = Math.max(1, this.domElement.clientWidth);
    const effectiveH = Math.max(h - bottom, h * 0.5);
    const aspect = Math.max(w / effectiveH, 0.4);
    const vfovRad = (this.camera.fov * Math.PI) / 180;
    const hfovRad = 2 * Math.atan(Math.tan(vfovRad / 2) * aspect);
    const tilt = Math.cos(ROUTE_VIEW_POLAR);

    const uBelow = targetForward + uBehind;
    const uAbove = Math.max(uSpan - targetForward, 0);
    const uPadded = (uBelow + uAbove) * (1 + pad);
    const vPadded = Math.max(vSpan, 4) * (1 + pad);

    const distV = uPadded / (2 * Math.tan(vfovRad / 2) * tilt);
    const distH = vPadded / (2 * Math.tan(hfovRad / 2) * tilt);
    return Math.max(distV, distH, 8);
  }

  private navEndpointsOnScreen(
    origin: { x: number; y: number; z: number },
    dest: { x: number; y: number; z: number },
    marginPx: number,
  ): boolean {
    const w = Math.max(1, this.domElement.clientWidth);
    const h = Math.max(1, this.domElement.clientHeight);
    const bottom = this.measureBottomInsetPx();
    const cy = origin.y + BORDER_WALL_HEIGHT * 0.08;
    const o = this.projectToScreen(origin.x, cy, origin.z, w, h);
    const d = this.projectToScreen(dest.x, dest.y + BORDER_WALL_HEIGHT * 0.08, dest.z, w, h);
    if (!o || !d) return false;
    const top = marginPx;
    const bottomLimit = h - bottom - marginPx;
    const inBounds = (p: { x: number; y: number }) =>
      p.x >= marginPx &&
      p.x <= w - marginPx &&
      p.y >= top &&
      p.y <= bottomLimit;
    return inBounds(o) && inBounds(d);
  }

  private fitNavCameraToEndpoints(
    origin: { x: number; y: number; z: number },
    dest: { x: number; y: number; z: number },
    headingRad: number,
    path: { x: number; y: number; z: number }[],
    stacked: boolean,
    pad: number,
  ): void {
    const cameraHeading = headingRad + NAV_CAMERA_Y_ROTATION;
    const sinH = Math.sin(headingRad);
    const cosH = Math.cos(headingRad);

    const fitPoints = path.length >= 2 ? path.slice() : [];
    fitPoints.push(origin, dest);

    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = 0; i < fitPoints.length; i++) {
      const p = fitPoints[i];
      const dx = p.x - origin.x;
      const dz = p.z - origin.z;
      const u = dx * sinH + dz * cosH;
      const v = dx * cosH - dz * sinH;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }

    const padAlong = 4;
    const padAcross = 3;
    uMin -= padAlong * 0.4;
    uMax += padAlong;
    vMin -= padAcross;
    vMax += padAcross;

    const uSpan = Math.max(uMax - uMin, 6);
    const vSpan = Math.max(vMax - vMin, 6);
    const vCenter = (vMin + vMax) / 2;
    const uBehind = Math.max(-uMin, 0);
    const targetForward = Math.max(uMax * 0.3, 2);

    let dist = this.navRouteCameraDistance(uSpan, vSpan, targetForward, pad, uBehind);
    const cy = origin.y + BORDER_WALL_HEIGHT * 0.08;
    const bottom = this.measureBottomInsetPx();
    const h = Math.max(1, this.domElement.clientHeight);
    const vfovRad = (this.camera.fov * Math.PI) / 180;
    const dockShift = (bottom / Math.max(h, 1)) * dist * Math.tan(vfovRad / 2) * 0.2;

    const placeCamera = (distance: number) => {
      const uTarget = Math.max(uMax * 0.34 + dockShift, 2);
      const tx = origin.x + sinH * uTarget + cosH * vCenter;
      const tz = origin.z + cosH * uTarget - sinH * vCenter;
      this.setTopDownCamera(tx, cy, tz, distance, uSpan, cameraHeading, false, true);
      this.applyCameraViewportInset();
    };

    this.controls.minDistance = 3;
    this.controls.maxDistance = Math.max(800, dist * 5);
    this.unlockOrbitLimits(stacked);

    for (let attempt = 0; attempt < 8; attempt++) {
      placeCamera(dist);
      if (this.navEndpointsOnScreen(origin, dest, 12)) break;
      dist *= 1.1;
    }

    this.controls.update();
    this.requestRender();
  }

  /**
   * Top-down navigation from the start: user at bottom, full route + both zones visible.
   */
  setNavigationCamera(
    origin: { x: number; y: number; z: number },
    dest: { x: number; y: number; z: number },
    headingRad: number,
    path: { x: number; y: number; z: number }[],
    stacked = false,
    pad = 0.12,
  ): void {
    this.fitNavCameraToEndpoints(origin, dest, headingRad, path, stacked, pad);
  }

  private setTopDownCamera(
    cx: number,
    cy: number,
    cz: number,
    dist: number,
    spanZ: number,
    headingRad?: number | null,
    destAnchor = false,
    skipTargetNudge = false,
  ): void {
    // In 2D lock mode always stay straight overhead (no route polar tilt).
    if (this.topDownLocked) headingRad = null;
    const shiftZ = skipTargetNudge
      ? 0
      : destAnchor
        ? this.bottomBarAnchorShiftZ(dist)
        : this.bottomBarCenterShiftZ(spanZ);
    const tz = cz + shiftZ;
    const target = new THREE.Vector3(cx, cy, tz);
    this.controls.target.copy(target);

    const off = new THREE.Vector3();
    if (headingRad != null) {
      // Align From → To toward the top of the screen, with a small polar tilt so orbit stays free.
      const phi = ROUTE_VIEW_POLAR;
      const theta = headingRad;
      const sinPhi = Math.sin(phi);
      off.set(
        dist * sinPhi * Math.sin(theta),
        dist * Math.cos(phi),
        dist * sinPhi * Math.cos(theta),
      );
      this.camera.up.set(-Math.sin(headingRad), 0, -Math.cos(headingRad));
    } else {
      off.set(0, dist, 0.001);
      this.camera.up.set(0, 1, 0);
    }
    this.camera.position.copy(target).add(off);
    if (headingRad != null) {
      this.camera.lookAt(target);
    }
    this.applyCameraViewportInset();
  }

  /** Keep projection full-frame; framing uses visible height + target shift only. */
  private applyCameraViewportInset(): void {
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private staticKeyFor(data: Floor2DScene3dSync): string {
    const objectSig = (objects: FloorBlock[]) => {
      let s = '';
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        s += `${o.id}:${o.kind ?? ''}:${o.count ?? 0}:${o.rotation ?? 0};`;
      }
      return s;
    };
    if (data.multiFloor && data.floors && data.floors.length > 0) {
      const stack = data.verticalPlateStack ? '1' : '0';
      const lw = data.lightweightPlates ? '1' : '0';
      const parts: string[] = [`stack:${stack}`, `lw:${lw}`, `act:${data.activeFloorId ?? ''}`];
      for (let i = 0; i < data.floors.length; i++) {
        const f = data.floors[i];
        parts.push(
          `${f.floorId}|${f.floorY}|${f.map.cols}x${f.map.rows}|${f.walk.length}|${f.map.walls.length}|${objectSig(f.objects)}|${f.zones.length}`,
        );
      }
      return parts.join(';');
    }
    const map = data.map;
    return `single|${map.cols}x${map.rows}|${data.walk.length}|${map.walls.length}|${objectSig(data.objects)}|${data.zones.length}|${data.floorIndex ?? 0}`;
  }

  sync(data: Floor2DScene3dSync, refitCamera = false): void {
    this.lastSyncData = data;
    this.routeAnimEntries.length = 0;
    disposeObject3D(this.dynamicRoot);
    this.dynamicRoot.clear();

    const staticKey = this.staticKeyFor(data);
    if (staticKey !== this.lastStaticKey) {
      disposeObject3D(this.staticRoot);
      this.staticRoot.clear();
      this.lastStaticKey = staticKey;
      this.staticPlateGen++;
      const plateGen = this.staticPlateGen;
      if (data.multiFloor && data.floors && data.floors.length > 0) {
        if (data.floors.length > 1) {
          this.buildStaticMultiFloorIncremental(data, plateGen);
        } else {
          this.buildStaticMultiFloor(data);
          this.applyShadowFlags();
        }
      } else {
        this.buildStaticSingleFloor(data);
        this.applyShadowFlags();
      }
    }
    this.configureShadowForMap(data.map);

    if (data.multiFloor && data.floors && data.floors.length > 0) {
      this.buildDynamicMultiFloor(data);
    } else {
      this.buildDynamicSingleFloor(data);
    }

    if (refitCamera) {
      if (data.multiFloor && data.floors && data.floors.length > 0) {
        const sorted = [...data.floors].sort((a, b) => a.floorY - b.floorY);
        const verticalStack = data.verticalPlateStack ?? false;
        const displayLayers: FloorDisplayLayer[] = sorted.map((layer, i) => ({
          ...layer,
          displayY: floorPlateDisplayY(sorted, i, verticalStack),
        }));
        this.fitCameraMulti(data.map, displayLayers, verticalStack);
      } else {
        this.fitCameraTopDown(data.map);
      }
    }
    this.requestRender();
  }

  syncDynamic(data: Floor2DScene3dSync, refitCamera = false): void {
    this.routeAnimEntries.length = 0;
    disposeObject3D(this.dynamicRoot);
    this.dynamicRoot.clear();

    if (data.multiFloor && data.floors && data.floors.length > 0) {
      this.buildDynamicMultiFloor(data);
    } else {
      this.buildDynamicSingleFloor(data);
    }

    if (refitCamera) {
      if (data.multiFloor && data.floors && data.floors.length > 0) {
        const sorted = [...data.floors].sort((a, b) => a.floorY - b.floorY);
        const verticalStack = data.verticalPlateStack ?? false;
        const displayLayers: FloorDisplayLayer[] = sorted.map((layer, i) => ({
          ...layer,
          displayY: floorPlateDisplayY(sorted, i, verticalStack),
        }));
        this.fitCameraMulti(data.map, displayLayers, verticalStack);
      } else {
        this.fitCameraTopDown(data.map);
      }
    }
    this.requestRender();
  }

  private buildStaticSingleFloor(data: Floor2DScene3dSync): void {
    const map = data.map;
    const walk = data.walk;
    const floorY = map.sliceY;
    const large = isLargeFloorMap(map, walk);
    addBuildingFloorTiles(this.staticRoot, map, walk, floorY);
    if (!large) {
      addInteriorRooms(this.staticRoot, map, walk, data.zones, floorY, []);
    }
    addWallMeshes(this.staticRoot, map.walls, map, walk, floorY);
    addFloorPlanDrawings(this.staticRoot, map, data.zones, data.objects, floorY, large);
    addZoneFills(this.staticRoot, data.zones, floorY);
    if (data.showObjects !== false) addObjectBlocks(this.staticRoot, data.objects, floorY);
    addZoneFloorLabels(this.staticRoot, data.zones, floorY);
  }

  private buildDynamicSingleFloor(data: Floor2DScene3dSync): void {
    const floorY = data.map.sliceY;
    this.addRoutePath(data.path, floorY, this.dynamicRoot);
    addRouteEndpointMarkers3d(
      this.dynamicRoot,
      data.routeOrigin,
      data.routeDest,
      data.path,
      floorY,
    );
    addSelectedZoneFullLabels(
      this.dynamicRoot,
      data.zones,
      floorY,
      collectSelectedZoneIds(data.selectedPoiId, data.originId, data.destId),
    );
  }

  private buildStaticMultiFloor(data: Floor2DScene3dSync): void {
    this.syncMultiFloorStatic(data);
  }

  private buildDynamicMultiFloor(data: Floor2DScene3dSync): void {
    this.syncMultiFloorDynamic(data);
  }

  private buildStaticMultiFloorIncremental(data: Floor2DScene3dSync, gen: number): void {
    const sorted = [...data.floors!].sort((a, b) => a.floorY - b.floorY);
    const verticalStack = data.verticalPlateStack ?? false;
    const displayLayers: FloorDisplayLayer[] = sorted.map((layer, i) => ({
      ...layer,
      displayY: floorPlateDisplayY(sorted, i, verticalStack),
    }));
    let index = 0;
    const step = () => {
      if (gen !== this.staticPlateGen) return;
      if (index >= displayLayers.length) {
        if (verticalStack) {
          this.unlockOrbitLimits(true);
        } else {
          this.unlockOrbitLimits(false);
        }
        this.applyShadowFlags();
        this.requestRender();
        return;
      }
      this.appendMultiFloorStaticPlate(displayLayers[index], data, sorted, verticalStack);
      index++;
      this.requestRender();
      requestAnimationFrame(step);
    };
    step();
  }

  private appendMultiFloorStaticPlate(
    layer: FloorDisplayLayer,
    data: Floor2DScene3dSync,
    sorted: Floor2DScene3dFloorLayer[],
    verticalStack: boolean,
  ): void {
    const showWalls = data.showWalls ?? !verticalStack;
    const showObjects = data.showObjects ?? showWalls;
    const map = data.map;
    const plate = new THREE.Group();
    const walk = layer.walk;
    const floorMap = layer.map;
    const y = layer.displayY;
    const walkForMesh =
      walk.length === floorMap.cols * floorMap.rows
        ? walk
        : new Uint8Array(floorMap.cols * floorMap.rows);
    const platePois =
      layer.pois ??
      data.pois.filter(
        (p) => Math.abs(nearestFloorYForPoi(p.y, data.floorLevels ?? []) - layer.floorY) < 0.25,
      );
    const plateHighlights = poiHighlightPoints(
      endpointPoisOnly(platePois, data.originId, data.destId),
      data.originId,
      data.destId,
    );
    const isActivePlate = Boolean(data.activeFloorId && layer.floorId === data.activeFloorId);
    const lightweight = Boolean(data.lightweightPlates && !isActivePlate);

    if (lightweight) {
      if (walk.length > 0) {
        addBuildingFloorTiles(plate, floorMap, walk, y);
      }
      if (floorMap.walls.length > 0) {
        addWallPlanLines(plate, floorMap.walls, y);
      }
      addZoneFills(plate, layer.zones, y);
      addZoneFloorLabels(plate, layer.zones, y);
      const label = makeFloorLabelSprite(layer.label);
      label.position.set(map.minX + 1.2, y + 1.1, map.minZ + 1.2);
      plate.add(label);
      this.staticRoot.add(plate);
      return;
    }

    if (walk.length > 0) {
      addBuildingFloorTiles(plate, floorMap, walk, y);
      if (!isLargeFloorMap(floorMap, walk)) {
        addInteriorRooms(
          plate,
          floorMap,
          walk,
          layer.zones,
          y,
          plateHighlights,
          verticalStack ? STACK_INTERIOR_ROOM_FILL_HEIGHT : INTERIOR_ROOM_FILL_HEIGHT,
        );
      }
    }
    addZoneFills(plate, layer.zones, y);
    if (showObjects) addObjectBlocks(plate, layer.objects, y);
    if (showWalls) {
      const largeFloor = isLargeFloorMap(floorMap, walkForMesh);
      addWallMeshes(plate, floorMap.walls, floorMap, walkForMesh, y, verticalStack);
      addFloorPlanDrawings(plate, floorMap, layer.zones, layer.objects, y, largeFloor);
    } else if (verticalStack) {
      addFloorPlanDrawings(plate, floorMap, layer.zones, layer.objects, y);
    }
    addZoneFloorLabels(plate, layer.zones, y);

    const label = makeFloorLabelSprite(layer.label);
    label.position.set(map.minX + 1.2, y + 1.1, map.minZ + 1.2);
    plate.add(label);
    this.staticRoot.add(plate);
  }

  private syncMultiFloorStatic(data: Floor2DScene3dSync): void {
    const sorted = [...data.floors!].sort((a, b) => a.floorY - b.floorY);
    const verticalStack = data.verticalPlateStack ?? false;
    const displayLayers: FloorDisplayLayer[] = sorted.map((layer, i) => ({
      ...layer,
      displayY: floorPlateDisplayY(sorted, i, verticalStack),
    }));

    for (let li = 0; li < displayLayers.length; li++) {
      this.appendMultiFloorStaticPlate(displayLayers[li], data, sorted, verticalStack);
    }

    if (verticalStack) {
      this.unlockOrbitLimits(true);
    } else {
      this.unlockOrbitLimits(false);
    }
  }

  private syncMultiFloorDynamic(data: Floor2DScene3dSync): void {
    const floorLevels = data.floorLevels ?? data.floors!.map((f) => ({ floorY: f.floorY }));
    const sorted = [...data.floors!].sort((a, b) => a.floorY - b.floorY);
    const verticalStack = data.verticalPlateStack ?? false;
    const displayLayers: FloorDisplayLayer[] = sorted.map((layer, i) => ({
      ...layer,
      displayY: floorPlateDisplayY(sorted, i, verticalStack),
    }));

    for (let li = 0; li < displayLayers.length; li++) {
      const layer = displayLayers[li];
      const y = layer.displayY;
      this.addRoutePath(layer.path, y, this.dynamicRoot);
    }

    const endpoints = {
      routeOrigin: data.routeOrigin ?? null,
      routeDest: data.routeDest ?? null,
    };
    if (endpoints.routeOrigin || endpoints.routeDest) {
      const originLayer = displayLayers.find((f) =>
        endpoints.routeOrigin
          ? Math.hypot(f.path[0]?.x - endpoints.routeOrigin.x, f.path[0]?.z - endpoints.routeOrigin.z) < 2.5 ||
            (data.originId && f.pois?.some((p) => p.id === data.originId))
          : false,
      );
      const leaveSeg = displayLayers.find((f) => f.path.length >= 2) ?? displayLayers[0];
      const destLayer =
        displayLayers.find((f) => data.destId && f.pois?.some((p) => p.id === data.destId)) ??
        displayLayers[displayLayers.length - 1];
      const startPath =
        (originLayer && originLayer.path.length >= 2 ? originLayer.path : null) ??
        (leaveSeg?.path.length >= 2 ? leaveSeg.path : data.path);
      const startY = originLayer?.displayY ?? leaveSeg?.displayY ?? data.map.sliceY;
      const destY = destLayer?.displayY ?? startY;

      if (endpoints.routeOrigin) {
        addRouteEndpointMarkers3d(
          this.dynamicRoot,
          endpoints.routeOrigin,
          null,
          startPath,
          startY,
        );
      }
      if (endpoints.routeDest) {
        addRouteEndpointMarkers3d(this.dynamicRoot, null, endpoints.routeDest, [], destY);
      }
    }

    const connectors = data.connectors ?? [];
    for (let ci = 0; ci < connectors.length; ci++) {
      this.addGapRoute(connectors[ci], displayLayers, this.dynamicRoot);
    }

    const selectedZoneIds = collectSelectedZoneIds(data.selectedPoiId, data.originId, data.destId);
    for (let li = 0; li < displayLayers.length; li++) {
      const layer = displayLayers[li];
      addSelectedZoneFullLabels(this.dynamicRoot, layer.zones, layer.displayY, selectedZoneIds);
    }
  }

  private addRouteLine(points: THREE.Vector3[], parent: THREE.Object3D): void {
    if (points.length < 2) return;
    // Keep full XYZ so multi-floor stair connectors climb between plates.
    addExpoFpRoute3dWorldPoints(parent, points, this.routeAnimEntries);
    this.startRenderLoop();
    this.requestRender();
  }

  private addRoutePath(
    path: { x: number; z: number }[],
    floorY: number,
    parent: THREE.Object3D = this.dynamicRoot,
  ): void {
    if (path.length < 2) return;
    addExpoFpRoute3d(parent, path, floorY, this.routeAnimEntries);
    this.startRenderLoop();
    this.requestRender();
  }

  private addGapRoute(
    link: FloorRouteConnector,
    floors: FloorDisplayLayer[],
    parent: THREE.Object3D = this.dynamicRoot,
  ): void {
    let leave = floors.find((f) => f.floorId === link.fromFloorId);
    let enter = floors.find((f) => f.floorId === link.toFloorId);

    // Fallback: if a plate layer is missing, still draw the climb using connector world Y.
    if (!leave || !enter) {
      const sorted = [...floors].sort((a, b) => a.floorY - b.floorY);
      const synth = (floorId: string, xz: { x: number; z: number }, yHint: number): FloorDisplayLayer | null => {
        const existing = floors.find((f) => f.floorId === floorId);
        if (existing) return existing;
        const idx = Math.max(
          0,
          sorted.findIndex((f) => Math.abs(f.floorY - yHint) < 0.25),
        );
        const displayY =
          sorted.length > 0
            ? floorPlateDisplayY(sorted, Math.min(idx, sorted.length - 1), true)
            : yHint;
        return {
          floorId,
          label: floorId,
          floorY: yHint,
          displayY,
          map: floors[0]?.map ?? (this.lastSyncData?.map as Floor2DMap),
          walk: new Uint8Array(0),
          objects: [],
          zones: [],
          path: [{ x: xz.x, z: xz.z }],
        } as FloorDisplayLayer;
      };
      // Prefer Y from connector via samples when present.
      const fromY = link.via[0]?.y ?? leave?.floorY ?? 0;
      const toY = link.via[link.via.length - 1]?.y ?? enter?.floorY ?? fromY + 3;
      leave = leave ?? synth(link.fromFloorId, link.from, fromY) ?? undefined;
      enter = enter ?? synth(link.toFloorId, link.to, toY) ?? undefined;
      if (!leave || !enter) return;
    }

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
            : i / Math.max(1, link.via.length - 1);
        const y = leaveY + t * (enterY - leaveY) + ROUTE_LIFT;
        points.push(new THREE.Vector3(v.x, y, v.z));
      }
    } else if (Math.abs(enterY - leaveY) > 0.05) {
      const steps = 10;
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        points.push(
          new THREE.Vector3(
            link.from.x + (link.to.x - link.from.x) * t,
            leaveY + (enterY - leaveY) * t + ROUTE_LIFT,
            link.from.z + (link.to.z - link.from.z) * t,
          ),
        );
      }
    }

    points.push(new THREE.Vector3(link.to.x, enterY + ROUTE_LIFT, link.to.z));

    const deduped: THREE.Vector3[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].distanceToSquared(deduped[deduped.length - 1]) > 1e-6) deduped.push(points[i]);
    }

    this.addRouteLine(deduped, parent);
    addStairMouthRouteMarkers3d(parent, link, leaveY, enterY);
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
    const ySpan = Math.max(
      maxY - minY + (verticalStack ? BORDER_WALL_HEIGHT + 0.8 : BORDER_WALL_HEIGHT * 2.5),
      5,
    );
    this.controls.target.set(cx, midY, cz);
    const spanX = Math.max(map.maxX - map.minX, 4);
    const spanZ = Math.max(map.maxZ - map.minZ, 4);
    let dist = this.topDownCameraDistance(spanX, spanZ, verticalStack ? 1.22 : 1.08);
    if (verticalStack) {
      dist = Math.max(dist, ySpan * 1.15);
    }
    this.camera.position.set(cx, midY + dist, cz + 0.001);
    this.controls.minDistance = 4;
    this.controls.maxDistance = Math.max(800, dist * 4);
    this.unlockOrbitLimits(verticalStack);
    this.applyCameraViewportInset();
    this.controls.update();
  }

  /** Set walls to cast shadows and the floor/rooms to receive them. */
  private applyShadowFlags(): void {
    this.staticRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh as THREE.Mesh).isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }

  /** Fit the shadow-casting directional light's frustum to the current map. */
  private configureShadowForMap(map: Floor2DMap): void {
    if (!this.keyLight) return;
    const cx = (map.minX + map.maxX) / 2;
    const cz = (map.minZ + map.maxZ) / 2;
    const cy = map.sliceY;
    const spanX = Math.max(map.maxX - map.minX, 8);
    const spanZ = Math.max(map.maxZ - map.minZ, 8);
    const half = Math.max(spanX, spanZ) * 0.62 + 4;
    const h = Math.max(half * 1.1, 40);
    const light = this.keyLight;
    light.position.set(cx - half * 0.45, cy + h, cz - half * 0.35);
    light.target.position.set(cx, cy, cz);
    light.target.updateMatrixWorld();
    const sc = light.shadow.camera as THREE.OrthographicCamera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = h * 2 + Math.max(spanX, spanZ);
    sc.updateProjectionMatrix();
  }

  /** Frame the orbit camera to show the full floor plate (compact auto-zoom). */
  fitCameraToMap(map: Floor2DMap): void {
    this.fitCameraTopDown(map);
    this.requestRender();
  }

  /** Compute camera height for a straight-down view that fits the given map span. */
  private topDownCameraDistance(
    spanX: number,
    spanZ: number,
    pad = 1.08,
    bottomInsetPx = this.measureBottomInsetPx(),
  ): number {
    const span = Math.max(spanX, spanZ, 4);
    const w = Math.max(1, this.domElement.clientWidth);
    const h = Math.max(1, this.domElement.clientHeight);
    const effectiveH = Math.max(h - bottomInsetPx, h * 0.42);
    const aspect = Math.max(w / effectiveH, 0.4);
    const vfovRad = (this.camera.fov * Math.PI) / 180;
    const hfovRad = 2 * Math.atan(Math.tan(vfovRad / 2) * aspect);
    const padded = span * pad;
    const distV = padded / (2 * Math.tan(vfovRad / 2));
    const distH = (spanX * pad) / (2 * Math.tan(hfovRad / 2));
    return Math.max(distV, distH, 8);
  }

  /** Place the camera directly above the map center (top-down). Orbit stays free after. */
  private fitCameraTopDown(map: Floor2DMap): void {
    const cx = (map.minX + map.maxX) / 2;
    const cz = (map.minZ + map.maxZ) / 2;
    const spanX = Math.max(map.maxX - map.minX, 4);
    const spanZ = Math.max(map.maxZ - map.minZ, 4);
    const cy = map.sliceY + BORDER_WALL_HEIGHT * 0.06;
    const bottom = this.measureBottomInsetPx();
    const dist = this.topDownCameraDistance(spanX, spanZ, 1.06, bottom);
    const tz = cz + this.bottomBarCenterShiftZ(spanZ);
    this.controls.target.set(cx, cy, tz);
    this.camera.position.set(cx, cy + dist, tz + 0.001);
    this.camera.up.set(0, 1, 0);
    this.controls.minDistance = 4;
    this.controls.maxDistance = Math.max(600, dist * 4);
    this.unlockOrbitLimits(false);
    this.applyCameraViewportInset();
    this.controls.update();
  }

  /** Dolly the orbit camera in/out (factor < 1 zooms in). */
  zoomBy(factor: number): void {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const nextLen = offset.length() * factor;
    if (nextLen < this.controls.minDistance || nextLen > this.controls.maxDistance) return;
    offset.multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.needsRender = true;
    this.onCameraChange?.();
  }

  /** Keep orbit free — or re-apply top-down lock when 2D mode is on. */
  private unlockOrbitLimits(stacked = false): void {
    this.applyOrbitLimits(stacked);
  }

  /** Apply free 3D orbit or locked top-down (2D) limits. */
  private applyOrbitLimits(_stacked = false): void {
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    if (this.topDownLocked) {
      this.controls.enableRotate = false;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = 0.001;
      return;
    }
    this.controls.enableRotate = true;
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = Math.PI - 0.06;
  }

  isTopDownLocked(): boolean {
    return this.topDownLocked;
  }

  /**
   * Lock camera to a straight top-down angle (2D). Pan/zoom stay enabled.
   * Turning off restores free 3D orbit.
   */
  setTopDownLocked(on: boolean): void {
    if (this.cameraAnimRaf) {
      cancelAnimationFrame(this.cameraAnimRaf);
      this.cameraAnimRaf = 0;
      this.cameraAnimGen++;
    }
    this.topDownLocked = on;
    if (on) {
      this.snapCameraToTopDown();
    } else {
      this.camera.up.set(0, 1, 0);
    }
    this.applyOrbitLimits();
    this.controls.update();
    this.needsRender = true;
    this.onCameraChange?.();
  }

  /** Move camera straight above the current target, keeping distance. */
  private snapCameraToTopDown(): void {
    const target = this.controls.target;
    const dist = Math.max(
      this.controls.minDistance,
      Math.min(
        this.controls.maxDistance,
        Math.max(this.camera.position.distanceTo(target), 8),
      ),
    );
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(target.x, target.y + dist, target.z + 0.001);
    this.camera.lookAt(target);
    this.applyCameraViewportInset();
  }

  /**
   * Pan/dolly toward a world point while keeping the current camera angle.
   * Does not snap to top-down or lock orbit.
   */
  animateCameraToPoint(
    x: number,
    y: number,
    z: number,
    durationMs = 480,
    targetDist?: number,
  ): void {
    if (this.cameraAnimRaf) cancelAnimationFrame(this.cameraAnimRaf);
    this.unlockOrbitLimits();

    const startTarget = this.controls.target.clone();
    const startPos = this.camera.position.clone();
    const offset = new THREE.Vector3().subVectors(startPos, startTarget);
    const curDist = Math.max(offset.length(), 0.01);
    const endDist = Math.max(
      this.controls.minDistance,
      Math.min(this.controls.maxDistance, targetDist ?? Math.min(curDist, Math.max(curDist * 0.72, 10))),
    );
    if (this.topDownLocked) {
      offset.set(0, endDist, 0.001);
    } else {
      offset.multiplyScalar(endDist / curDist);
    }
    const endTarget = new THREE.Vector3(x, y, z);
    const endPos = endTarget.clone().add(offset);

    const animGen = ++this.cameraAnimGen;
    const t0 = performance.now();
    this.startRenderLoop();
    const step = (now: number) => {
      if (animGen !== this.cameraAnimGen || !this.cameraAnimRaf) return;
      const u = easeOutCubic(Math.min(1, (now - t0) / durationMs));
      this.controls.target.lerpVectors(startTarget, endTarget, u);
      this.camera.position.lerpVectors(startPos, endPos, u);
      this.controls.update();
      this.needsRender = true;
      this.onCameraChange?.();
      if (u < 1) {
        this.cameraAnimRaf = requestAnimationFrame(step);
      } else {
        this.cameraAnimRaf = 0;
        this.unlockOrbitLimits();
        this.controls.update();
        this.requestRender();
      }
    };
    this.cameraAnimRaf = requestAnimationFrame(step);
  }

  private fitCamera(map: Floor2DMap): void {
    this.fitCameraTopDown(map);
  }

  /** Frame the orbit camera — navFrame fits the full route top-down from the start side. */
  fitCameraToPath(
    points: { x: number; y: number; z: number }[],
    stacked = false,
    pad = 0.18,
    headingRad?: number | null,
    navFrame?: NavCameraFrame | null,
  ): void {
    if (navFrame && headingRad != null) {
      this.setNavigationCamera(
        navFrame.origin,
        navFrame.dest,
        headingRad,
        navFrame.path,
        stacked,
        pad,
      );
      return;
    }
    if (points.length < 1) return;

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

    if (points.length === 1) {
      const minSpan = 6;
      minX -= minSpan / 2;
      maxX += minSpan / 2;
      minZ -= minSpan / 2;
      maxZ += minSpan / 2;
    }

    let cx = (minX + maxX) / 2;
    let cz = (minZ + maxZ) / 2;
    let cy = (minY + maxY) / 2 + BORDER_WALL_HEIGHT * 0.08;

    const spanX = Math.max(maxX - minX, 4);
    const spanZ = Math.max(maxZ - minZ, 4);
    const spanY = Math.max(maxY - minY, stacked ? BORDER_WALL_HEIGHT * 0.8 : 1.2);

    let dist = this.topDownCameraDistance(
      spanX,
      spanZ,
      (1.24 + pad * 2) * this.bottomBarPadFactor(),
    );
    if (stacked) {
      dist = Math.max(dist, spanY * 1.15);
    }

    this.controls.minDistance = 3;
    this.controls.maxDistance = Math.max(800, dist * 5);
    this.unlockOrbitLimits(stacked);
    this.setTopDownCamera(cx, cy, cz, dist, spanZ, headingRad, false);
    this.controls.update();
    if (headingRad != null) {
      this.camera.up.set(0, 1, 0);
      this.controls.update();
    }
    this.requestRender();
  }

  /** Smoothly fly the orbit camera to frame path/endpoint points (top-down, start→end aligned). */
  animateCameraToPath(
    points: { x: number; y: number; z: number }[],
    stacked = false,
    durationMs = 580,
    headingRad?: number | null,
    navFrame?: NavCameraFrame | null,
  ): void {
    if (!navFrame && points.length < 1) return;
    if (this.cameraAnimRaf) cancelAnimationFrame(this.cameraAnimRaf);

    const startTarget = this.controls.target.clone();
    const startPos = this.camera.position.clone();
    const startUp = this.camera.up.clone();
    const savedTarget = this.controls.target.clone();
    const savedPos = this.camera.position.clone();
    const savedUp = this.camera.up.clone();
    this.fitCameraToPath(points, stacked, 0.18, headingRad, navFrame);
    const endTarget = this.controls.target.clone();
    const endPos = this.camera.position.clone();
    const endUp = this.camera.up.clone();
    this.controls.target.copy(savedTarget);
    this.camera.position.copy(savedPos);
    this.camera.up.copy(savedUp);

    const t0 = performance.now();
    const animGen = ++this.cameraAnimGen;
    this.startRenderLoop();
    const step = (now: number) => {
      // User orbit cancels this fly via bumping cameraAnimGen / clearing cameraAnimRaf.
      if (animGen !== this.cameraAnimGen || !this.cameraAnimRaf) return;
      const u = easeOutCubic(Math.min(1, (now - t0) / durationMs));
      this.controls.target.lerpVectors(startTarget, endTarget, u);
      this.camera.position.lerpVectors(startPos, endPos, u);
      this.camera.up.lerpVectors(startUp, endUp, u).normalize();
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.needsRender = true;
      this.onCameraChange?.();
      if (u < 1) {
        this.cameraAnimRaf = requestAnimationFrame(step);
      } else {
        this.cameraAnimRaf = 0;
        // One-shot framing only — restore standard up vector and leave orbit fully free.
        this.camera.up.set(0, 1, 0);
        this.controls.update();
        this.unlockOrbitLimits(stacked);
      }
    };
    this.cameraAnimRaf = requestAnimationFrame(step);
  }

  /**
   * Fly to a zone from a top-down angle. Frames the full name label — no over-zoom.
   * Orbit/pan/zoom stay enabled when the animation ends.
   */
  animateCameraToZoneTopDown(zone: FloorBlock, floorY: number, durationMs = 520): void {
    if (this.cameraAnimRaf) cancelAnimationFrame(this.cameraAnimRaf);
    this.unlockOrbitLimits();

    const b = zoneBounds(zone);
    const labelPad = zoneLabelFocusPadding(zone);
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const spanX = Math.max(b.maxX - b.minX + labelPad.padX * 2, 7);
    const spanZ = Math.max(b.maxZ - b.minZ + labelPad.padZ * 2, 7);
    const cy = floorY + BORDER_WALL_HEIGHT * 0.06;
    const dist =
      this.topDownCameraDistance(spanX, spanZ, 1.32 * this.bottomBarPadFactor()) *
      ZONE_FOCUS_ZOOM_RELAX;
    const shiftZ = this.bottomBarCenterShiftZ(spanZ);

    const startTarget = this.controls.target.clone();
    const startPos = this.camera.position.clone();
    const endTarget = new THREE.Vector3(cx, cy, cz + shiftZ);
    const endPos = new THREE.Vector3(cx, cy + dist, cz + shiftZ + 0.001);

    const animGen = ++this.cameraAnimGen;
    const t0 = performance.now();
    this.startRenderLoop();
    const step = (now: number) => {
      if (animGen !== this.cameraAnimGen || !this.cameraAnimRaf) return;
      const u = easeOutCubic(Math.min(1, (now - t0) / durationMs));
      this.controls.target.lerpVectors(startTarget, endTarget, u);
      this.camera.position.lerpVectors(startPos, endPos, u);
      this.controls.update();
      this.needsRender = true;
      this.onCameraChange?.();
      if (u < 1) {
        this.cameraAnimRaf = requestAnimationFrame(step);
      } else {
        this.cameraAnimRaf = 0;
        this.unlockOrbitLimits();
        this.applyCameraViewportInset();
        this.controls.update();
        this.requestRender();
      }
    };
    this.cameraAnimRaf = requestAnimationFrame(step);
  }

  setZoneBlinkAnimating(active: boolean): void {
    this.zoneBlinkAnimating = active;
    if (active) this.startRenderLoop();
    else this.requestRender();
  }

  updateZoneBlinkOverlays(
    entries: { zone: FloorBlock; floorY: number; zoneIndex: number }[],
    blinkIds: ReadonlySet<string>,
    pulse: number,
  ): void {
    const keep = new Set<string>();
    for (let ei = 0; ei < entries.length; ei++) {
      const { zone, floorY, zoneIndex } = entries[ei];
      if (!blinkIds.has(zone.id)) continue;
      keep.add(zone.id);
      const { fill, stroke } = zoneVisualStyle(zone, zoneIndex);
      let group = this.zoneBlinkMeshes.get(zone.id);
      if (!group) {
        group = makeZoneBlinkGroup(zone, floorY, fill, stroke, pulse);
        this.zoneBlinkRoot.add(group);
        this.zoneBlinkMeshes.set(zone.id, group);
      } else {
        updateZoneBlinkGroup(group, zone, floorY, fill, stroke, pulse);
      }
    }
    for (const [id, group] of this.zoneBlinkMeshes) {
      if (keep.has(id)) continue;
      this.zoneBlinkRoot.remove(group);
      disposeZoneBlinkGroup(group);
      this.zoneBlinkMeshes.delete(id);
    }
    this.requestRender();
  }

  clearZoneBlinkOverlays(): void {
    for (const group of this.zoneBlinkMeshes.values()) {
      this.zoneBlinkRoot.remove(group);
      disposeZoneBlinkGroup(group);
    }
    this.zoneBlinkMeshes.clear();
    this.requestRender();
  }

  dispose(): void {
    if (this.cameraAnimRaf) cancelAnimationFrame(this.cameraAnimRaf);
    this.stopRenderLoop();
    this.controls.dispose();
    this.clearZoneBlinkOverlays();
    disposeObject3D(this.staticRoot);
    disposeObject3D(this.dynamicRoot);
    this.routeTubeMat.dispose();
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
  private poiById = new Map<string, NavMapPoi>();
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
  /** User picked a single floor — do not auto-switch back to view-all for multi-floor routes. */
  private viewStackManual = false;
  private routeSegments: FloorRouteSegment[] = [];
  private routeConnectors: FloorRouteConnector[] = [];
  private routeError: string | null = null;
  private badgeStartLabel = '';
  private badgeDestLabel = '';
  private cachedPreview: Floor2DMap | null = null;
  private previewDirty = true;
  private readonly floorPreviewCache = new Map<string, Floor2DMap>();
  private scene3dDirty = true;
  private renderingPaused = false;
  private stackLayoutDirty = true;
  private panning = false;
  private tapX = 0;
  private tapY = 0;
  private scene3dTapBound = false;
  private mapTapHandler: ((worldX: number, worldZ: number) => void) | null = null;
  private tapLayer: HTMLElement;
  private tapPins: HTMLElement;
  private poiLabelsRoot: HTMLElement;
  private tapHighlight: { click: { x: number; z: number }; pois: NavMapPoi[] } | null = null;
  private tapPickHandler: ((id: string) => void) | null = null;
  private readonly scheduleDraw: () => void;
  private readonly scheduleResize: () => void;
  private readonly scheduleCameraFit: () => void;
  private readonly scheduleViewStackSceneSync: () => void;
  private routeAnimFrame = 0;
  private navRouteVisible = false;
  private selectedPoiId = '';
  private preferSmoothCamera = false;
  private viewAnimRaf = 0;
  private zoneBlinkRaf = 0;
  private readonly blinkZoneIds = new Set<string>();
  /** Cached floor-id key for multi-floor nav static scene rebuilds. */
  private lastRouteViewFloorKey = '';
  /** Bumps when view-all preload should cancel (floor switch / exit view-all). */
  private viewStackPreloadGen = 0;

  constructor(mapParent: HTMLElement) {
    if (typeof getComputedStyle !== 'undefined' && getComputedStyle(mapParent).position === 'static') {
      mapParent.style.position = 'relative';
    }

    this.mapWrap = mapParent;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'floor2d-canvas';
    this.mapWrap.appendChild(this.canvas);

    this.tapLayer = document.createElement('div');
    this.tapLayer.className = 'mini3dgta-tap-layer';
    this.tapPins = document.createElement('div');
    this.tapPins.className = 'mini3dgta-tap-pins';
    this.poiLabelsRoot = document.createElement('div');
    this.poiLabelsRoot.className = 'wf-poi-labels';
    this.tapLayer.appendChild(this.tapPins);
    this.tapLayer.appendChild(this.poiLabelsRoot);
    this.mapWrap.appendChild(this.tapLayer);

    this.scheduleDraw = rafCoalesce(() => this.drawNow());
    this.scheduleResize = debounceFn(() => this.resizeNow(), 120);
    this.scheduleCameraFit = rafCoalesce(() => this.fitCameraNow());
    this.scheduleViewStackSceneSync = rafCoalesce(() => {
      if (!this.scene3dDirty || !this.scene3dWanted()) return;
      this.syncScene3dIfNeeded(false);
    });
    this.syncBadgeLabels();

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.scene3dWanted()) return;
      // Stop any in-flight 2D zoom so the user can pan freely.
      if (this.viewAnimRaf) {
        cancelAnimationFrame(this.viewAnimRaf);
        this.viewAnimRaf = 0;
      }
      this.drag = true;
      this.panning = false;
      this.tapX = e.clientX;
      this.tapY = e.clientY;
      this.lx = e.clientX;
      this.ly = e.clientY;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.canvas.classList.add('is-dragging');
      e.preventDefault();
    });
    const endDrag = (e?: PointerEvent) => {
      if (
        e &&
        !this.scene3dWanted() &&
        !this.panning &&
        this.mapTapHandler &&
        this.map
      ) {
        const moved = Math.hypot(e.clientX - this.tapX, e.clientY - this.tapY);
        if (moved < 12) {
          const rect = this.canvas.getBoundingClientRect();
          const dpr = this.canvas.width / Math.max(1, rect.width);
          const sx = (e.clientX - rect.left) * dpr;
          const sy = (e.clientY - rect.top) * dpr;
          const wx = (sx - this.ox) / this.scale;
          const wz = (sy - this.oy) / this.scale;
          this.mapTapHandler(wx, wz);
        }
      }
      this.drag = false;
      this.panning = false;
      this.canvas.classList.remove('is-dragging');
      if (e) {
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };
    this.canvas.addEventListener('pointerup', (e) => endDrag(e));
    this.canvas.addEventListener('pointercancel', (e) => endDrag(e));
    this.canvas.addEventListener('lostpointercapture', () => {
      this.drag = false;
      this.panning = false;
      this.canvas.classList.remove('is-dragging');
    });
    this.canvas.addEventListener(
      'pointermove',
      (e) => {
        if (!this.drag || this.scene3dWanted()) return;
        if (Math.hypot(e.clientX - this.tapX, e.clientY - this.tapY) > 6) this.panning = true;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = this.canvas.width / Math.max(1, rect.width);
        this.ox += (e.clientX - this.lx) * dpr;
        this.oy += (e.clientY - this.ly) * dpr;
        this.lx = e.clientX;
        this.ly = e.clientY;
        // Draw immediately while dragging so pan feels live (skip RAF coalesce lag).
        this.drawNow();
        e.preventDefault();
      },
      { passive: false },
    );
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.scene3dWanted() || this.renderingPaused) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.12 : 0.9;
        this.zoomMap(factor);
      },
      { passive: false },
    );

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.scheduleResize()).observe(this.mapWrap);
    }
  }

  private invalidatePreview(): void {
    this.previewDirty = true;
    this.cachedPreview = null;
    this.floorPreviewCache.clear();
  }

  /** Pause canvas/WebGL work while the fullscreen overlay is hidden. */
  setRenderingPaused(paused: boolean): void {
    this.renderingPaused = paused;
    if (paused) {
      this.scene3d?.setVisible(false);
      return;
    }
    this.updateScene3dVisibility();
    if (!this.scene3dWanted()) this.draw();
  }

  private ensureScene3d(): Floor2DScene3d {
    if (!this.scene3d) {
      this.scene3d = new Floor2DScene3d(this.mapWrap);
      const w = Math.max(1, this.mapWrap.clientWidth);
      const h = Math.max(1, this.mapWrap.clientHeight);
      this.scene3d.resize(w, h);
      this.scene3dDirty = true;
      this.bindScene3dTap();
      this.scene3d.setOnCameraChange(() => {
        if (this.tapHighlight) this.updateTapOverlay();
        this.updatePoiLabelsOverlay();
      });
    }
    return this.scene3d;
  }

  setMapTapHandler(handler: ((worldX: number, worldZ: number) => void) | null): void {
    this.mapTapHandler = handler;
  }

  setTapPickHandler(handler: ((id: string) => void) | null): void {
    this.tapPickHandler = handler;
  }

  private tapPickPhase(): 'from' | 'to' {
    if (!this.originId) return 'from';
    return 'to';
  }

  showTapNearby(clickX: number, clickZ: number, pois: NavMapPoi[]): void {
    this.tapHighlight = { click: { x: clickX, z: clickZ }, pois };
    this.updateTapOverlay();
    this.scheduleDraw();
    if (this.scene3dWanted()) this.scene3d?.requestRender();
  }

  clearTapNearby(): void {
    this.tapHighlight = null;
    this.tapPins.innerHTML = '';
    this.scheduleDraw();
  }

  private worldToOverlayPx(x: number, z: number, floorY: number): { x: number; y: number } | null {
    const w = Math.max(1, this.mapWrap.clientWidth);
    const h = Math.max(1, this.mapWrap.clientHeight);
    if (this.scene3dWanted() && this.scene3d?.isVisible()) {
      return this.scene3d.projectToScreen(x, floorY + 0.2, z, w, h);
    }
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    return { x: this.wx(x) / dpr, y: this.wz(z) / dpr };
  }

  private updateTapOverlay(): void {
    if (!this.tapHighlight || !this.map) {
      this.tapPins.innerHTML = '';
      return;
    }
    const floorY = this.getActiveFloorY();
    const { click, pois } = this.tapHighlight;

    // While the user is orbiting, only reposition existing pins — do not rebuild
    // the overlay (recreating full-screen capture made the map feel locked).
    const existingPins = this.tapPins.querySelectorAll('.mini3dgta-tap-poi-pin');
    if (
      this.scene3dWanted() &&
      this.scene3d &&
      existingPins.length === pois.filter((p) => (p.name ?? '').trim()).length &&
      existingPins.length > 0
    ) {
      let pi = 0;
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        if (!(p.name ?? '').trim()) continue;
        const el = existingPins[pi++] as HTMLElement | undefined;
        if (!el) break;
        const px = this.worldToOverlayPx(p.x, p.z, p.y ?? floorY);
        if (!px) {
          el.style.visibility = 'hidden';
          continue;
        }
        el.style.visibility = 'visible';
        el.style.left = `${px.x}px`;
        el.style.top = `${px.y}px`;
      }
      return;
    }

    this.tapPins.innerHTML = '';
    const clickPx = this.worldToOverlayPx(click.x, click.z, floorY);
    if (clickPx) {
      const dot = document.createElement('div');
      dot.className = 'mini3dgta-tap-click';
      dot.style.left = `${clickPx.x}px`;
      dot.style.top = `${clickPx.y}px`;
      this.tapPins.appendChild(dot);
      window.setTimeout(() => {
        if (dot.parentElement) dot.remove();
      }, 600);
    }

    // Nearby POIs as clickable popup pins — pick one for From / To.
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      const name = (p.name ?? '').trim();
      if (!name) continue;
      const px = this.worldToOverlayPx(p.x, p.z, p.y ?? floorY);
      if (!px) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini3dgta-tap-poi-pin';
      btn.style.left = `${px.x}px`;
      btn.style.top = `${px.y}px`;
      btn.title = name;
      const dotEl = document.createElement('span');
      dotEl.className = 'mini3dgta-tap-poi-pin__dot';
      const labelEl = document.createElement('span');
      labelEl.className = 'mini3dgta-tap-poi-pin__label';
      labelEl.textContent = name;
      btn.appendChild(labelEl);
      btn.appendChild(dotEl);
      btn.addEventListener('pointerdown', (e) => {
        // Keep map orbit free — only the pin itself consumes the tap.
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.tapPickHandler?.(p.id);
      });
      this.tapPins.appendChild(btn);
    }
  }

  /** Zone labels render on the 3D floor — keep overlay layer empty. */
  private updatePoiLabelsOverlay(): void {
    this.poiLabelsRoot.innerHTML = '';
  }

  setNavRouteVisible(visible: boolean): void {
    if (this.navRouteVisible === visible) return;
    this.navRouteVisible = visible;
    if (!visible) {
      this.stopRouteAnimLoop();
      this.lastRouteViewFloorKey = '';
      this.markScene3dDirty();
    } else {
      if (this.routeConnectors.length > 0) {
        this.ensureMultiFloorRouteView();
        this.markScene3dDirty();
      }
      this.syncRouteAnimLoop();
    }
    this.syncZoneBlinkState();
    this.updatePoiLabelsOverlay();
    if (this.scene3dWanted()) {
      if (this.scene3dDirty) this.syncScene3dIfNeeded(false);
      else this.syncScene3dDynamicOnly(false);
    } else {
      this.scheduleDraw();
    }
  }

  clearNavigationRoute(): void {
    this.setRoutePlan([], [], undefined);
  }

  setSelectedPoi(id: string): void {
    this.selectedPoiId = id;
    this.updatePoiLabelsOverlay();
    if (this.scene3dWanted()) {
      this.syncScene3dDynamicOnly(false);
    } else {
      this.scheduleDraw();
    }
  }

  setPreferSmoothCamera(prefer: boolean): void {
    this.preferSmoothCamera = prefer;
  }

  /** Smoothly focus a world point — keeps current orbit angle, never locks top-down. */
  smoothZoomToWorldPoint(x: number, z: number, _headingRad?: number | null): void {
    if (this.viewAnimRaf) cancelAnimationFrame(this.viewAnimRaf);
    const floorY = this.getActiveFloorY();
    if (this.scene3dWanted() && this.scene3d) {
      this.scene3d.animateCameraToPoint(x, floorY, z, 480);
      return;
    }
    if (!this.map || this.usesStackedLayout()) return;

    const minSpan = 5.5;
    const pad = 0.2;
    const bboxW = minSpan * (1 + pad * 2);
    const bboxH = minSpan * (1 + pad * 2);
    const dpr = deviceRenderDpr();
    const w = Math.max(1, this.mapWrap.clientWidth) * dpr;
    const h = Math.max(1, this.mapWrap.clientHeight) * dpr;
    const endScale = Math.min(Math.max(Math.min((w * 0.72) / bboxW, (h * 0.72) / bboxH), 0.35), 90);
    const endOx = w / 2 - x * endScale;
    const endOy = h / 2 - z * endScale;

    const startScale = this.scale;
    const startOx = this.ox;
    const startOy = this.oy;
    const t0 = performance.now();
    const durationMs = 480;
    const step = (now: number) => {
      const u = easeOutCubic(Math.min(1, (now - t0) / durationMs));
      this.scale = startScale + (endScale - startScale) * u;
      this.ox = startOx + (endOx - startOx) * u;
      this.oy = startOy + (endOy - startOy) * u;
      this.scheduleDraw();
      if (u < 1) {
        this.viewAnimRaf = requestAnimationFrame(step);
      } else {
        this.viewAnimRaf = 0;
        this.updatePoiLabelsOverlay();
      }
    };
    this.viewAnimRaf = requestAnimationFrame(step);
  }

  /** Smoothly frame a zone so its full name fits on screen — no over-zoom / no clipped Y. */
  smoothZoomToZone(zone: FloorBlock, floorYOverride?: number, floorId?: string | null): void {
    if (this.viewAnimRaf) cancelAnimationFrame(this.viewAnimRaf);
    const b = zoneBounds(zone);
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    let floorY = floorYOverride;
    if (floorY === undefined) {
      if (this.viewStack && floorId) {
        floorY = this.plateDisplayYForFloor(floorId);
      } else {
        floorY = this.getActiveFloorY();
      }
    }
    if (this.scene3dWanted() && this.scene3d) {
      this.scene3d.animateCameraToZoneTopDown(zone, floorY, 520);
      this.updatePoiLabelsOverlay();
      return;
    }
    if (!this.map || (this.usesStackedLayout() && this.viewStack)) return;

    const dpr = deviceRenderDpr();
    const w = Math.max(1, this.mapWrap.clientWidth) * dpr;
    const h = Math.max(1, this.mapWrap.clientHeight) * dpr;
    const bottom = measureMapBottomInsetPx(this.mapWrap) * dpr;
    const visH = Math.max(h - bottom, h * 0.42);
    // Frame the zone itself — do not pull out for long label text.
    const labelPad = zoneLabelFocusPadding2d(zone);
    const bboxW = Math.max(b.maxX - b.minX + labelPad.padX * 2, 4);
    const bboxH = Math.max(b.maxZ - b.minZ + labelPad.padZ * 2, 4);
    const pad = 0.22;
    const paddedW = bboxW * (1 + pad * 2);
    const paddedH = bboxH * (1 + pad * 2);
    const fitScale = Math.min((w * 0.88) / paddedW, (visH * 0.88) / paddedH);
    const endScale = Math.min(
      Math.max(fitScale / 1.12, 0.25),
      ZONE_FOCUS_MAX_SCALE,
    );
    const endOx = w / 2 - cx * endScale;
    // Center in the visible band above the bottom nav (fixes text clipped on Y).
    const endOy = (h - bottom) / 2 - cz * endScale;

    const startScale = this.scale;
    const startOx = this.ox;
    const startOy = this.oy;
    const t0 = performance.now();
    const durationMs = 520;
    const step = (now: number) => {
      const u = easeOutCubic(Math.min(1, (now - t0) / durationMs));
      this.scale = startScale + (endScale - startScale) * u;
      this.ox = startOx + (endOx - startOx) * u;
      this.oy = startOy + (endOy - startOy) * u;
      this.scheduleDraw();
      if (u < 1) {
        this.viewAnimRaf = requestAnimationFrame(step);
      } else {
        this.viewAnimRaf = 0;
        this.updatePoiLabelsOverlay();
      }
    };
    this.viewAnimRaf = requestAnimationFrame(step);
  }

  focusZoneByRouteId(routeId: string): void {
    if (!isZoneRouteId(routeId)) return;
    const zid = routeId.slice(ZONE_ROUTE_PREFIX.length);
    const hit = this.findZoneInFloors(zid);
    if (!hit) return;
    const { floor, zone } = hit;
    this.smoothZoomToZone(zone, floor.floorY, floor.id);
  }

  private findZoneInFloors(zoneId: string): { floor: FloorLevel; zone: FloorBlock } | null {
    return findZoneInFloors(zoneId, this.floors, this.activeFloorId, this.zones);
  }

  private plateDisplayYForFloor(floorId: string): number {
    const sorted = this.floorsForScene3dView();
    const verticalStack = this.usesStackedPlate3d();
    const idx = sorted.findIndex((f) => f.id === floorId);
    if (idx < 0) return this.getActiveFloorY();
    return floorPlateDisplayY(sorted, idx, verticalStack);
  }

  private isNavigationRouteShowing(): boolean {
    if (!this.navRouteVisible) return false;
    if (this.routeSegments.length > 0) {
      for (let i = 0; i < this.routeSegments.length; i++) {
        if (this.routeSegments[i].path.length >= 2) return true;
      }
      return false;
    }
    return this.path.length >= 2;
  }

  private pendingBlinkZoneIds(): Set<string> {
    const out = new Set<string>();
    if (isZoneRouteId(this.originId)) {
      out.add(this.originId.slice(ZONE_ROUTE_PREFIX.length));
    }
    if (isZoneRouteId(this.destId)) {
      out.add(this.destId.slice(ZONE_ROUTE_PREFIX.length));
    }
    return out;
  }

  private blinkZoneRenderEntries(): { zone: FloorBlock; floorY: number; zoneIndex: number }[] {
    const out: { zone: FloorBlock; floorY: number; zoneIndex: number }[] = [];
    if (!this.blinkZoneIds.size) return out;

    const stacked3d = this.usesStackedPlate3d();
    const sorted = this.floorsForScene3dView();

    if (this.floors.length > 0) {
      for (let fi = 0; fi < sorted.length; fi++) {
        const floor = sorted[fi];
        const zones = zonesForFloorLevel(floor, this.activeFloorId, this.zones);
        let floorY: number;
        if (stacked3d) {
          floorY = floorPlateDisplayY(sorted, fi, true);
        } else if (floor.id === this.activeFloorId && this.map) {
          floorY = this.map.sliceY;
        } else {
          floorY = floor.floorY;
        }
        for (let zi = 0; zi < zones.length; zi++) {
          if (!this.blinkZoneIds.has(zones[zi].id)) continue;
          out.push({ zone: zones[zi], floorY, zoneIndex: zi });
        }
      }
      return out;
    }

    for (let i = 0; i < this.zones.length; i++) {
      if (!this.blinkZoneIds.has(this.zones[i].id)) continue;
      out.push({
        zone: this.zones[i],
        floorY: this.map?.sliceY ?? this.getActiveFloorY(),
        zoneIndex: i,
      });
    }
    return out;
  }

  syncZoneBlinkState(): void {
    const next = this.pendingBlinkZoneIds();
    this.blinkZoneIds.clear();
    for (const id of next) this.blinkZoneIds.add(id);
    if (this.blinkZoneIds.size > 0) this.startZoneBlinkLoop();
    else this.stopZoneBlinkLoop();
    if (!this.scene3dWanted()) this.scheduleDraw();
  }

  private startZoneBlinkLoop(): void {
    if (this.zoneBlinkRaf) return;
    this.scene3d?.setZoneBlinkAnimating(true);
    const tick = () => {
      if (this.blinkZoneIds.size === 0) {
        this.zoneBlinkRaf = 0;
        this.scene3d?.setZoneBlinkAnimating(false);
        this.scene3d?.clearZoneBlinkOverlays();
        return;
      }
      const pulse = zoneBlinkPulse();
      if (this.scene3dWanted() && this.scene3d) {
        this.scene3d.updateZoneBlinkOverlays(
          this.blinkZoneRenderEntries(),
          this.blinkZoneIds,
          pulse,
        );
      } else {
        this.scheduleDraw();
      }
      this.zoneBlinkRaf = requestAnimationFrame(tick);
    };
    this.zoneBlinkRaf = requestAnimationFrame(tick);
  }

  private stopZoneBlinkLoop(): void {
    if (this.zoneBlinkRaf) {
      cancelAnimationFrame(this.zoneBlinkRaf);
      this.zoneBlinkRaf = 0;
    }
    this.scene3d?.setZoneBlinkAnimating(false);
    this.scene3d?.clearZoneBlinkOverlays();
    this.scheduleDraw();
  }

  /** Heading along the route from the user (first segment, else From → To). */
  private routeTravelHeadingRad(): number | null {
    const pts = this.navRouteVisible ? this.getRoutePathPoints() : [];
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[1];
      const hx = b.x - a.x;
      const hz = b.z - a.z;
      if (hx * hx + hz * hz > 1e-6) return Math.atan2(hx, hz);
    }
    const sliceY = this.getActiveFloorY();
    const o = this.originId ? this.resolveEndpoint(this.originId, sliceY) : null;
    const d = this.destId ? this.resolveEndpoint(this.destId, sliceY) : null;
    if (o && d) {
      const hx = d.x - o.x;
      const hz = d.z - o.z;
      if (hx * hx + hz * hz > 1e-6) return Math.atan2(hx, hz);
    }
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const hx = b.x - a.x;
      const hz = b.z - a.z;
      if (hx * hx + hz * hz > 1e-6) return Math.atan2(hx, hz);
    }
    return null;
  }

  private drawTapHighlight(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.tapHighlight || !this.map || this.scene3dWanted()) return;
    const { click, pois } = this.tapHighlight;
    const r = Math.max(8, 10 * dpr);
    ctx.save();
    ctx.strokeStyle = 'rgba(61,255,138,0.45)';
    ctx.fillStyle = 'rgba(61,255,138,0.14)';
    ctx.lineWidth = Math.max(2, 2.5 * dpr);
    ctx.beginPath();
    ctx.arc(this.wx(click.x), this.wz(click.z), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      ctx.fillStyle = NAVIA_NEON;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, 2 * dpr);
      ctx.beginPath();
      ctx.arc(this.wx(p.x), this.wz(p.z), r * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private bindScene3dTap(): void {
    if (!this.scene3d || this.scene3dTapBound) return;
    this.scene3dTapBound = true;
    const el = this.scene3d.domElement;
    let downX = 0;
    let downY = 0;
    el.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    el.addEventListener('pointerup', (e) => {
      if (!this.scene3dWanted() || !this.map) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 14) return;
      const rect = el.getBoundingClientRect();
      const floorY = this.getActiveFloorY();
      if (!this.mapTapHandler) return;
      const hit = this.scene3d!.pickFloorPoint(e.clientX, e.clientY, floorY, rect);
      if (hit) this.mapTapHandler(hit.x, hit.z);
    });
  }

  private previewMapForFloorCached(floor: FloorLevel): Floor2DMap {
    if (!this.map) throw new Error('previewMapForFloorCached requires map');
    if (floor.id === this.activeFloorId) return this.map;
    const hit = this.floorPreviewCache.get(floor.id);
    if (hit) return hit;
    return routingMapForFloor(this.map, floor);
  }

  private isViewAllBrowseMode(): boolean {
    return this.viewStack && !this.isActiveMultiFloorNav();
  }

  /** Floors shown in stacked 3D — route chain, view-all, or the selected floor plus its subfloors. */
  private floorsForScene3dView(): FloorLevel[] {
    const routeFloors = this.routeNavigationFloors();
    if (routeFloors && routeFloors.length >= 2) {
      // Always include every floor referenced by stair connectors (mouth leave/enter).
      const byId = new Map(this.floors.map((f) => [f.id, f]));
      const seen = new Set(routeFloors.map((f) => f.id));
      const out = [...routeFloors];
      for (let i = 0; i < this.routeConnectors.length; i++) {
        const link = this.routeConnectors[i];
        for (const id of [link.fromFloorId, link.toFloorId]) {
          if (seen.has(id)) continue;
          const floor = byId.get(id);
          if (!floor) continue;
          seen.add(id);
          out.push(floor);
        }
      }
      return out.sort((a, b) => a.floorY - b.floorY);
    }
    if (this.viewStack) return this.sortedFloors();
    return floorFamily(this.floors, this.activeFloorId);
  }

  private async resolveWalkForFloorLevelAsync(floor: FloorLevel): Promise<Uint8Array | null> {
    const sync = this.walkForFloorLevel(floor);
    if (sync) return sync;
    const floorMap = routingMapForFloor(this.map!, floor);
    if (typeof floor.walkGridPacked === 'string' && floor.walkGridPacked.length > 0) {
      const decoded = await decodeWalkGridPackedAsync(
        floor.walkGridPacked,
        floorMap.cols,
        floorMap.rows,
      );
      if (decoded) walkGridCache.set(walkGridCacheKey(floor.id), decoded);
      return decoded;
    }
    return null;
  }

  /** Progressively cache walk grids for stacked floors — never blocks the UI thread. */
  async ensureAllFloorPreviews(gen?: number): Promise<void> {
    if (!this.map) return;
    const floors = this.floorsForScene3dView();
    if (floors.length < 2) return;
    const myGen = gen ?? this.viewStackPreloadGen;
    if (this.activeFloorId && this.map) {
      this.floorPreviewCache.set(this.activeFloorId, this.map);
    }

    for (let i = 0; i < floors.length; i++) {
      if (myGen !== this.viewStackPreloadGen) return;
      const floor = floors[i];
      if (floor.id === this.activeFloorId) continue;
      if (this.floorPreviewCache.has(floor.id)) continue;

      const walk = await this.resolveWalkForFloorLevelAsync(floor);
      await yieldToMain();
      if (myGen !== this.viewStackPreloadGen) return;

      const floorMap = routingMapForFloor(this.map, floor);
      let preview: Floor2DMap = floorMap;
      if (walk) {
        const walls = await resolveFloorWalls(floor.id, walk, floorMap);
        preview = {
          ...floorMap,
          walls,
          objects: cloneFloorBlocks(floor.objects ?? []),
          zones: cloneFloorBlocks(floor.zones ?? []),
          corridors: [],
          blocks: [],
          stores: [],
        };
        walkGridCache.set(walkGridCacheKey(floor.id), walk);
      }
      this.floorPreviewCache.set(floor.id, preview);

      this.markScene3dDirty();
      this.scheduleViewStackSceneSync();
      await yieldToMain();
    }
    this.scheduleDraw();
  }

  private markScene3dDirty(): void {
    this.scene3dDirty = true;
  }

  private syncScene3dIfNeeded(refitCamera = false): void {
    if (!this.scene3dWanted() || !this.map) return;
    const scene3d = this.ensureScene3d();
    if (!this.scene3dDirty) {
      if (refitCamera) this.syncScene3dDynamicOnly(true);
      else scene3d.requestRender();
      return;
    }
    this.scene3dDirty = false;
    this.syncScene3d(refitCamera);
  }

  /** Fast path when returning from AR — keep cached static meshes, refresh route only. */
  warmResume3d(): void {
    this.renderingPaused = false;
    this.updateScene3dVisibility();
    if (!this.scene3dWanted() || !this.map) {
      if (!this.scene3dWanted()) this.draw();
      return;
    }
    const scene3d = this.ensureScene3d();
    requestAnimationFrame(() => {
      const w = Math.max(1, this.mapWrap.clientWidth);
      const h = Math.max(1, this.mapWrap.clientHeight);
      scene3d.resize(w, h);
      if (this.scene3dDirty) this.syncScene3dIfNeeded(false);
      else this.syncScene3dDynamicOnly(false);
      scene3d.requestRender();
    });
  }

  private syncScene3dDynamicOnly(refitCamera = false): void {
    if (!this.scene3dWanted() || !this.map) return;
    const scene3d = this.ensureScene3d();
    if (this.usesStackedPlate3d()) {
      const layers = this.buildMultiFloorSceneLayers();
      scene3d.syncDynamic(this.multiFloorScene3dPayload(layers, refitCamera), refitCamera);
      return;
    }

    if (!this.walk) return;
    scene3d.syncDynamic(
      this.scene3dSyncPayload({ path: this.activeFloorRoutePath(), floorIndex: this.activeFloorIndex() }),
      refitCamera,
    );
  }

  draw(): void {
    this.scheduleDraw();
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

  isTopDownView(): boolean {
    return !this.iso3d && !this.viewStack;
  }

  /** Switch to the flat 2D map page (same palette as 3D). Off = free 3D orbit. */
  setTopDownView(on: boolean): void {
    if (on) {
      if (this.viewStack) this.leaveViewStack();
      this.setIso3d(false);
      this.fitViewToMap();
      return;
    }
    this.setIso3d(true);
  }

  toggleTopDownView(): boolean {
    const next = !this.isTopDownView();
    this.setTopDownView(next);
    return next;
  }

  /** True when viewing one floor (not the multi-floor stack / view-all mode). */
  isSingleFloorView(): boolean {
    if (this.viewStack) return false;
    if (this.floors.length <= 1) return true;
    return Boolean(this.activeFloorId);
  }

  setIso3d(on: boolean): void {
    if (MAP_VIEW_3D_ONLY && !on) return;
    if (this.iso3d === on) {
      if (on && this.scene3dWanted()) {
        requestAnimationFrame(() => this.syncScene3dIfNeeded(false));
      }
      return;
    }
    this.iso3d = on;
    this.updateScene3dVisibility();
    if (this.iso3d) this.ensureMultiFloorRouteView();
    const finish = () => {
      if (this.scene3dWanted()) {
        // Fast toggle: dynamic-only sync when geometry is cached — no camera jump.
        if (this.scene3dDirty) this.syncScene3dIfNeeded(false);
        else this.syncScene3dDynamicOnly(false);
      } else {
        this.draw();
      }
      this.onIso3dChange?.(this.iso3d);
    };
    if (this.iso3d) requestAnimationFrame(finish);
    else finish();
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

  private isActiveMultiFloorNav(): boolean {
    return this.navRouteVisible && this.routeConnectors.length > 0;
  }

  /** Floors involved in the active cross-floor route (origin → … → destination). */
  private routeNavigationFloors(): FloorLevel[] | null {
    if (!this.isActiveMultiFloorNav()) return null;
    if (this.routeSegments.length > 0) {
      const byId = new Map(this.floors.map((f) => [f.id, f]));
      const chain: FloorLevel[] = [];
      for (let i = 0; i < this.routeSegments.length; i++) {
        const f = byId.get(this.routeSegments[i].floorId);
        if (f) chain.push(f);
      }
      if (chain.length >= 2) return chain;
    }
    const sliceY = this.getActiveFloorY();
    const o = this.originId ? this.resolveEndpoint(this.originId, sliceY) : null;
    const d = this.destId ? this.resolveEndpoint(this.destId, sliceY) : null;
    if (!o || !d) return null;
    const oFloor = floorForY(o.y, this.floors);
    const dFloor = floorForY(d.y, this.floors);
    if (!oFloor || !dFloor || oFloor.id === dFloor.id) return null;
    return buildFloorChain(this.floors, oFloor, dFloor, this.routeConnectors);
  }

  private routeViewFloorKey(floors: FloorLevel[]): string {
    return floors.map((f) => f.id).join('|');
  }

  private buildMultiFloorSceneLayers(): Floor2DScene3dFloorLayer[] {
    const viewFloors = this.floorsForScene3dView();
    return viewFloors.map((floor, i) => {
      const preview = this.previewMapForFloorCached(floor);
      const walk = this.walkForFloorLevel(floor);
      const isActive = floor.id === this.activeFloorId;
      const seg = this.routeSegments.find((s) => s.floorId === floor.id);
      const path = this.pathForScene3d(floor.id, seg);
      const platePois = this.poisForDisplay(
        filterPoisByFloorY(this.pois, floor.floorY, this.floors),
      );
      return {
        floorId: floor.id,
        label: floorDisplayLabel(floor, i),
        floorY: floor.floorY,
        map: isActive ? this.map! : preview,
        walk: walk ?? new Uint8Array(0),
        objects: floor.objects ?? (isActive ? this.objects : []),
        zones: floor.zones ?? (isActive ? this.zones : []),
        path,
        pois: platePois,
        stairMouths: floor.stairMouths,
      };
    });
  }

  private multiFloorScene3dPayload(
    layers: Floor2DScene3dFloorLayer[],
    _refitCamera: boolean,
  ): Floor2DScene3dSync {
    const endpoints = this.routeEndpointsForScene();
    const browseAll = this.isViewAllBrowseMode();
    const showStairNav = this.navRouteVisible && this.routeConnectors.length > 0;
    return {
      multiFloor: true,
      map: this.map!,
      floors: layers,
      connectors: showStairNav ? this.routeConnectors : [],
      floorLevels: this.floors,
      walk: this.walk ?? new Uint8Array(0),
      objects: this.objects,
      zones: this.zones,
      path: this.path,
      pois: this.poisForDisplay(),
      originId: this.originId,
      destId: this.destId,
      routeOrigin: endpoints.routeOrigin,
      routeDest: endpoints.routeDest,
      selectedPoiId: this.selectedPoiId,
      hideRouteEndpointLabels: this.navRouteVisible,
      verticalPlateStack: true,
      lightweightPlates: browseAll,
      activeFloorId: this.activeFloorId,
      showWalls: !browseAll,
      showInteriorVolumes: false,
      showObjects: !browseAll,
    };
  }

  /** Load walk-grid previews only for floors used in the active route. */
  private async ensureRouteFloorPreviews(floors: FloorLevel[]): Promise<void> {
    if (!this.map || floors.length === 0) return;
    let built = false;
    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      if (floor.id === this.activeFloorId && this.map) {
        this.floorPreviewCache.set(floor.id, this.map);
        continue;
      }
      if (this.floorPreviewCache.has(floor.id)) continue;
      const walk = await this.resolveWalkForFloorLevelAsync(floor);
      if (!walk) continue;
      const floorMap = routingMapForFloor(this.map, floor);
      const walls = await resolveFloorWalls(floor.id, walk, floorMap);
      const preview: Floor2DMap = {
        ...floorMap,
        walls,
        objects: cloneFloorBlocks(floor.objects ?? []),
        zones: cloneFloorBlocks(floor.zones ?? []),
        corridors: [],
        blocks: [],
        stores: [],
      };
      walkGridCache.set(walkGridCacheKey(floor.id), walk);
      this.floorPreviewCache.set(floor.id, preview);
      built = true;
    }
    if (built) {
      this.markScene3dDirty();
      if (this.scene3dWanted()) this.syncScene3dIfNeeded(false);
    }
  }

  private scene3dWanted(): boolean {
    if (!this.map) return false;
    if (MAP_VIEW_3D_ONLY) return this.iso3d || this.viewStack;
    return this.iso3d || this.viewStack;
  }

  private usesStackedPlate3d(): boolean {
    if (this.isActiveMultiFloorNav()) return true;
    if (this.viewStack) return this.usesStackedLayout();
    return floorFamily(this.floors, this.activeFloorId).length >= 2;
  }

  private updateScene3dVisibility(): void {
    const show = this.scene3dWanted() && !this.renderingPaused;
    if (show) {
      this.ensureScene3d().setVisible(true);
    } else {
      this.scene3d?.setVisible(false);
    }
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
    this.viewStackManual = !this.viewStack;
    this.stackLayoutDirty = true;
    if (this.viewStack) {
      this.viewStackPreloadGen++;
      const preloadGen = this.viewStackPreloadGen;
      this.enableMultiFloor3dView();
      this.markScene3dDirty();
      if (this.scene3dWanted()) {
        this.syncScene3dIfNeeded(true);
      }
      void this.ensureAllFloorPreviews(preloadGen);
    } else {
      this.viewStackPreloadGen++;
      this.exitViewStack();
    }
    this.onFloorsChange?.();
    return this.viewStack;
  }

  activateViewAllFloors(): void {
    if (!this.usesStackedLayout()) return;
    this.viewStackManual = false;
    if (!this.viewStack) {
      this.toggleViewStack();
      return;
    }
    this.viewStackPreloadGen++;
    void this.ensureAllFloorPreviews(this.viewStackPreloadGen);
    this.onFloorsChange?.();
  }

  poisForDisplay(_source?: NavMapPoi[]): NavMapPoi[] {
    return [];
  }

  leaveViewStack(): void {
    if (!this.viewStack) return;
    this.viewStackManual = true;
    this.exitViewStack();
    this.onFloorsChange?.();
  }

  /** Restore single-floor 3D after leaving view-all stack mode. */
  private exitViewStack(): void {
    this.viewStack = false;
    this.viewStackPreloadGen++;
    this.stackLayoutDirty = true;
    this.multiFloor3dAuto = false;
    if (MAP_VIEW_3D_ONLY) this.iso3d = true;
    this.updateScene3dVisibility();
    this.markScene3dDirty();
    this.invalidatePreview();
    this.fit();
    if (this.scene3dWanted()) {
      this.syncScene3dIfNeeded(true);
    } else {
      this.draw();
    }
  }

  private isMultiFloorRoute(): boolean {
    if (this.routeConnectors.length > 0) return true;
    return this.routeSegments.length > 1 && this.routeSegments.some((s) => s.path.length >= 2);
  }

  /** Multi-floor routes need stacked plates so stair-mouth connectors are visible. */
  private ensureMultiFloorRouteView(): boolean {
    if (!this.usesStackedLayout()) return false;
    if (!this.isActiveMultiFloorNav() && this.routeConnectors.length === 0) return false;
    if (this.viewStack) {
      this.enableMultiFloor3dView();
      this.updateScene3dVisibility();
      return false;
    }
    this.viewStack = true;
    this.viewStackManual = false;
    if (MAP_VIEW_3D_ONLY) this.iso3d = true;
    this.enableMultiFloor3dView();
    this.updateScene3dVisibility();
    this.markScene3dDirty();
    this.onFloorsChange?.();
    return true;
  }

  private pathForScene3d(floorId: string, seg: FloorRouteSegment | undefined): { x: number; z: number }[] {
    if (!this.navRouteVisible) return [];
    if (!seg || seg.path.length < 2) return [];
    return pathForFloor3dPlate(floorId, seg, this.routeConnectors);
  }

  private activeFloorRoutePath(): { x: number; z: number }[] {
    if (!this.navRouteVisible) return [];
    if (!this.activeFloorId) return this.path;
    const seg = this.routeSegments.find((s) => s.floorId === this.activeFloorId);
    return this.pathForScene3d(this.activeFloorId, seg);
  }

  /** Toggle extruded 3D walls with orbit / tilt (drag to rotate view). */
  toggleIso3d(): boolean {
    if (MAP_VIEW_3D_ONLY) {
      if (!this.iso3d) this.setIso3d(true);
      return true;
    }
    this.iso3d = !this.iso3d;
    this.updateScene3dVisibility();
    if (this.iso3d) this.ensureMultiFloorRouteView();
    if (this.scene3dWanted()) {
      if (this.scene3dDirty) {
        this.syncScene3dIfNeeded(false);
      } else {
        this.syncScene3dDynamicOnly(false);
      }
    } else {
      this.draw();
    }
    this.onIso3dChange?.(this.iso3d);
    return this.iso3d;
  }

  private syncScene3d(refitCamera = false): void {
    if (!this.scene3dWanted() || !this.map) return;
    const scene3d = this.ensureScene3d();

    if (this.usesStackedPlate3d()) {
      const layers = this.buildMultiFloorSceneLayers();
      scene3d.sync(this.multiFloorScene3dPayload(layers, refitCamera), refitCamera);
      return;
    }

    if (!this.walk) return;
    scene3d.sync(
      this.scene3dSyncPayload({ path: this.activeFloorRoutePath(), floorIndex: this.activeFloorIndex() }),
      refitCamera,
    );
  }

  dispose(): void {
    if (this.viewAnimRaf) cancelAnimationFrame(this.viewAnimRaf);
    this.stopZoneBlinkLoop();
    this.scene3d?.dispose();
    this.scene3d = null;
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
    ensureStairMouthConnectivity(this.floors);
    this.activeFloorId = activeFloorId;
    this.invalidatePreview();
    this.markScene3dDirty();
    this.stackLayoutDirty = true;
    this.fit();
    this.onFloorsChange?.();
    this.draw();
    if (this.scene3dWanted()) this.syncScene3dIfNeeded();
  }

  setRoutePlan(
    segments: FloorRouteSegment[],
    connectors: FloorRouteConnector[],
    error?: string,
  ): void {
    const hasRoute = segments.some((s) => s.path.length >= 2);
    this.routeSegments = segments;
    this.routeConnectors = connectors;
    this.routeError = hasRoute ? (error ?? null) : (error ?? null);
    if (hasRoute) {
      this.preferSmoothCamera = true;
    }
    if (segments.length === 1) {
      this.path = segments[0].path.map((p) => ({ x: p.x, z: p.z }));
    } else {
      this.path = [];
    }
    // Cross-floor routes: force stacked 3D so mouth→mouth green path is visible.
    if (connectors.length > 0 && this.navRouteVisible) {
      this.ensureMultiFloorRouteView();
      this.markScene3dDirty();
    } else {
      this.ensureMultiFloorRouteView();
    }
    const multiFloorRoute = this.isActiveMultiFloorNav();
    const routeFloors = this.routeNavigationFloors();
    if (routeFloors && routeFloors.length >= 2) {
      const floorKey = this.routeViewFloorKey(routeFloors);
      if (floorKey !== this.lastRouteViewFloorKey) {
        this.lastRouteViewFloorKey = floorKey;
        this.markScene3dDirty();
        void this.ensureRouteFloorPreviews(routeFloors);
      }
    } else if (!multiFloorRoute) {
      this.lastRouteViewFloorKey = '';
    }

    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      if (this.scene3dWanted()) {
        if (this.scene3dDirty) this.syncScene3dIfNeeded(multiFloorRoute || connectors.length > 0);
        else this.syncScene3dDynamicOnly(multiFloorRoute || connectors.length > 0);
      }
      this.scheduleCameraFit();
      this.draw();
      this.syncRouteAnimLoop();
      this.syncZoneBlinkState();
      return;
    }

    if (!multiFloorRoute && this.lastRouteViewFloorKey) {
      this.lastRouteViewFloorKey = '';
      this.markScene3dDirty();
    }
    if (this.scene3dWanted()) {
      this.syncScene3dDynamicOnly(false);
      this.scheduleCameraFit();
    } else {
      this.scheduleCameraFit();
      this.draw();
    }
    this.syncRouteAnimLoop();
    this.syncZoneBlinkState();
  }

  getFloorMap(): Floor2DMap | null {
    return this.map;
  }

  computeAndSetRoute(
    origin: { x: number; y: number; z: number },
    destination: { x: number; y: number; z: number },
  ): { valid: boolean; error?: string } {
    if (!this.map) {
      this.setRoutePlan([], [], 'Floor map not ready');
      return { valid: false, error: 'Floor map not ready' };
    }
    let plan: MultiFloorRoutePlan;
    const originFloor = floorForY(origin.y, this.floors);
    const destFloor = floorForY(destination.y, this.floors);
    const crossFloor =
      Boolean(originFloor && destFloor && originFloor.id !== destFloor.id);
    if (crossFloor) {
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
    this.setRoutePlan(plan.segments, plan.connectors, plan.error);
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
    this.path = pts.map((p) => ({ x: p.x, z: p.z }));
    this.syncRouteAnimLoop();
    this.syncZoneBlinkState();
    if (this.scene3dWanted()) {
      this.syncScene3dDynamicOnly(false);
    } else {
      this.scheduleDraw();
    }
  }

  setPois(pois: NavMapPoi[], originId: string, destId: string): void {
    this.pois = pois;
    this.poiById.clear();
    for (let i = 0; i < pois.length; i++) this.poiById.set(pois[i].id, pois[i]);
    this.originId = originId;
    this.destId = destId;
    this.syncZoneBlinkState();
    this.updatePoiLabelsOverlay();
    if (this.scene3dWanted()) {
      this.syncScene3dDynamicOnly(false);
    } else {
      this.scheduleDraw();
    }
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

  private routeEndpointsForScene(): {
    routeOrigin: { x: number; z: number } | null;
    routeDest: { x: number; z: number } | null;
  } {
    if (!this.navRouteVisible) {
      return { routeOrigin: null, routeDest: null };
    }
    const sliceY = this.getActiveFloorY();
    const o = this.originId ? this.resolveEndpoint(this.originId, sliceY) : null;
    const d = this.destId ? this.resolveEndpoint(this.destId, sliceY) : null;
    return {
      routeOrigin: o ? { x: o.x, z: o.z } : null,
      routeDest: d ? { x: d.x, z: d.z } : null,
    };
  }

  private scene3dSyncPayload(
    extra: Partial<Floor2DScene3dSync> & Pick<Floor2DScene3dSync, 'path'>,
  ): Floor2DScene3dSync {
    const endpoints = this.routeEndpointsForScene();
    return {
      map: this.map!,
      walk: this.walk!,
      objects: this.objects,
      zones: this.zones,
      pois: this.poisForDisplay(),
      originId: this.originId,
      destId: this.destId,
      routeOrigin: endpoints.routeOrigin,
      routeDest: endpoints.routeDest,
      selectedPoiId: this.selectedPoiId,
      hideRouteEndpointLabels: this.navRouteVisible,
      ...extra,
    };
  }

  private activeFloorIndex(): number {
    for (let i = 0; i < this.floors.length; i++) {
      if (this.floors[i].id === this.activeFloorId) return i;
    }
    return 0;
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
      const hit = this.findZoneInFloors(zid);
      if (hit) {
        const c = zoneCentroid(hit.zone);
        return {
          x: c.x,
          y: hit.floor.floorY,
          z: c.z,
          name: hit.zone.label || 'Zone',
        };
      }
      return null;
    }
    const hit = this.poiById.get(id);
    if (hit) return { x: hit.x, y: hit.y, z: hit.z, name: hit.name };
    return null;
  }

  private wx(x: number): number {
    return x * this.scale + this.ox;
  }
  private wz(z: number): number {
    return z * this.scale + this.oy;
  }

  resize(): void {
    this.resizeNow();
  }

  /** Request a 2D canvas redraw (e.g. after language change). */
  redraw(): void {
    this.scheduleDraw();
  }

  /** Refresh cached endpoint badge strings (no `t()` on every canvas paint). */
  refreshI18nBadges(): void {
    this.syncBadgeLabels();
    this.redraw();
  }

  private syncBadgeLabels(): void {
    this.badgeStartLabel = t('start');
    this.badgeDestLabel = t('destinationBadge');
  }

  private resizeNow(): void {
    if (this.renderingPaused) return;
    const w = Math.max(1, this.mapWrap.clientWidth);
    const h = Math.max(1, this.mapWrap.clientHeight);
    if (w < 2 || h < 2) return;
    const dpr = deviceRenderDpr();
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.stackLayoutDirty = true;
    this.scene3d?.resize(w, h);
    if (!this.scene3dWanted()) this.fit();
    if (this.scene3dWanted()) {
      this.scene3d?.requestRender();
      if (this.tapHighlight) this.updateTapOverlay();
      this.updatePoiLabelsOverlay();
    } else {
      this.drawNow();
    }
  }

  fit(): void {
    if (!this.map) return;
    if (this.usesStackedPlate3d()) return;
    if (this.usesStackedLayout() && this.viewStack) {
      this.stackLayoutDirty = true;
      this.fitStackedView();
      return;
    }
    const p = this.mapWrap;
    if (!p) return;
    const dpr = deviceRenderDpr();
    const w = Math.max(1, p.clientWidth) * dpr;
    const h = Math.max(1, p.clientHeight) * dpr;
    const bottomCss = measureMapBottomInsetPx(p);
    const bottom = bottomCss * dpr;
    const visH = Math.max(h - bottom, h * 0.45);
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    const cx = (this.map.minX + this.map.maxX) / 2;
    const cz = (this.map.minZ + this.map.maxZ) / 2;
    this.scale = Math.min((w * 0.88) / mapW, (visH * 0.88) / mapH);
    this.ox = w / 2 - cx * this.scale;
    this.oy = (h - bottom) / 2 - cz * this.scale;
  }

  /** Zoom/pan the 2D canvas or 3D camera so the active route fills the viewport. */
  fitToRoute(): void {
    this.preferSmoothCamera = true;
    this.scheduleCameraFit();
  }

  /** Frame origin → destination (uses route path when available). */
  fitViewToEndpointsOrRoute(): void {
    this.preferSmoothCamera = true;
    this.scheduleCameraFit();
  }

  /** Auto-zoom to show the full floor plate (compact on load). */
  fitViewToMap(): void {
    if (!this.map) return;
    if (this.scene3dWanted() && this.scene3d) {
      this.scene3d.fitCameraToMap(this.map);
      this.updatePoiLabelsOverlay();
      return;
    }
    this.fit();
    this.draw();
  }

  /** Zoom the map view in (factor < 1) or out (factor > 1). */
  zoomMap(factor: number): void {
    if (this.renderingPaused) return;
    if (this.scene3dWanted() && this.scene3d) {
      this.scene3d.zoomBy(factor);
      this.updatePoiLabelsOverlay();
      return;
    }
    if (!this.map || this.usesStackedLayout()) return;
    const dpr = this.canvas.width / Math.max(1, this.mapWrap.clientWidth);
    const cx = (this.mapWrap.clientWidth / 2) * dpr;
    const cy = (this.mapWrap.clientHeight / 2) * dpr;
    const wx = (cx - this.ox) / this.scale;
    const wz = (cy - this.oy) / this.scale;
    this.scale = Math.max(0.2, Math.min(this.scale * factor, 120));
    this.ox = cx - wx * this.scale;
    this.oy = cy - wz * this.scale;
    this.scheduleDraw();
  }

  /** Re-frame the map to fit the floor plate. */
  recenterMap(): void {
    this.fitViewToMap();
  }

  private fitCameraNow(): void {
    if (!this.map) return;
    // Only frame when something just asked for a smooth route zoom.
    // Re-snapping on every route rebuild locks the view and blocks free rotate.
    if (!this.preferSmoothCamera) return;
    this.preferSmoothCamera = false;
    this.smoothFitCameraNow();
  }

  private routeNavFrame(): NavCameraFrame | null {
    if (!this.navRouteVisible || !this.originId || !this.destId) return null;
    const sliceY = this.getActiveFloorY();
    const o = this.resolveEndpoint(this.originId, sliceY);
    const d = this.resolveEndpoint(this.destId, sliceY);
    if (!o || !d) return null;

    let path = this.getRoutePathPoints();
    if (path.length < 2) {
      path = [
        { x: o.x, y: o.y, z: o.z },
        { x: d.x, y: d.y, z: d.z },
      ];
    }

    if (this.usesStackedPlate3d()) {
      const stackedPath = this.routePointsForStacked3d(path);
      const stackedEndpoints = this.routePointsForStacked3d([
        { x: o.x, y: o.y, z: o.z },
        { x: d.x, y: d.y, z: d.z },
      ]);
      return {
        origin: stackedEndpoints[0],
        dest: stackedEndpoints[1],
        path: stackedPath,
      };
    }

    return {
      origin: { x: o.x, y: o.y, z: o.z },
      dest: { x: d.x, y: d.y, z: d.z },
      path,
    };
  }

  private smoothFitCameraNow(): void {
    if (!this.map) return;
    const heading = this.routeTravelHeadingRad();
    const navFrame = this.routeNavFrame();
    if (this.scene3dWanted() && this.scene3d && navFrame && heading != null) {
      this.scene3d.animateCameraToPath([], this.usesStackedPlate3d(), 620, heading, navFrame);
      return;
    }
    const routePts = this.getRoutePathPoints();
    if (routePts.length >= 2) {
      if (this.scene3dWanted() && this.scene3d) {
        const stacked = this.usesStackedPlate3d();
        const fitPts = stacked ? this.routePointsForStacked3d(routePts) : routePts;
        this.scene3d.animateCameraToPath(fitPts, stacked, 620, heading);
      } else {
        this.fitViewToPoints(routePts);
      }
      return;
    }
    const sliceY = this.getActiveFloorY();
    const o = this.originId ? this.resolveEndpoint(this.originId, sliceY) : null;
    const d = this.destId ? this.resolveEndpoint(this.destId, sliceY) : null;
    if (o && d && heading != null) {
      if (this.scene3dWanted() && this.scene3d) {
        const frame: NavCameraFrame = this.routeNavFrame() ?? {
          origin: { x: o.x, y: o.y, z: o.z },
          dest: { x: d.x, y: d.y, z: d.z },
          path: [
            { x: o.x, y: o.y, z: o.z },
            { x: d.x, y: d.y, z: d.z },
          ],
        };
        this.scene3d.animateCameraToPath([], this.usesStackedPlate3d(), 620, heading, frame);
      } else {
        this.smoothZoomToWorldPoint(d.x, d.z, heading);
      }
      return;
    }
    if (o) {
      this.smoothZoomToWorldPoint(o.x, o.z, heading);
      return;
    }
    if (d) {
      this.smoothZoomToWorldPoint(d.x, d.z, heading);
    }
  }

  private fitViewToPoints(pts: { x: number; y: number; z: number }[]): void {
    if (pts.length < 1) return;

    if (this.scene3dWanted() && this.scene3d) {
      const stacked = this.usesStackedPlate3d();
      const fitPts = stacked ? this.routePointsForStacked3d(pts) : pts;
      this.scene3d.fitCameraToPath(
        fitPts,
        stacked,
        0.12,
        this.routeTravelHeadingRad(),
        this.routeNavFrame(),
      );
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
    if (pts.length === 1) {
      const minSpan = 6;
      minX -= minSpan / 2;
      maxX += minSpan / 2;
      minZ -= minSpan / 2;
      maxZ += minSpan / 2;
    }
    const bboxW = Math.max(maxX - minX, 2);
    const bboxH = Math.max(maxZ - minZ, 2);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const pad = 0.22;
    const paddedW = bboxW * (1 + pad * 2);
    const paddedH = bboxH * (1 + pad * 2);
    const dpr = deviceRenderDpr();
    const w = Math.max(1, this.mapWrap.clientWidth) * dpr;
    const h = Math.max(1, this.mapWrap.clientHeight) * dpr;
    const bottom = measureMapBottomInsetPx(this.mapWrap) * dpr;
    const visH = Math.max(h - bottom, h * 0.45);
    this.scale = Math.min((w * 0.84) / paddedW, (visH * 0.84) / paddedH);
    this.ox = w / 2 - cx * this.scale;
    this.oy = (h - bottom) / 2 - cz * this.scale;
    this.draw();
  }

  private routePointsForStacked3d(pts: { x: number; y: number; z: number }[]): {
    x: number;
    y: number;
    z: number;
  }[] {
    const floors = this.floorsForScene3dView();
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
      // Use real floorY so routes/camera fit match POI heights (not a fixed plate step).
      out.push({
        x: p.x,
        y: floorPlateDisplayY(floors, bestIdx, true),
        z: p.z,
      });
    }
    return out;
  }

  private fitStackedView(): void {
    if (!this.map) return;
    const p = this.mapWrap;
    if (!p) return;
    const dpr = deviceRenderDpr();
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
    this.stackLayoutDirty = false;
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
    const need = floorMap.cols * floorMap.rows;
    const cached = getCachedWalkGrid(floor.id, need);
    if (cached) return cached;
    const rootCached = getCachedWalkGrid('__root__', need);
    if (rootCached && floorMap.cols === this.map.cols && floorMap.rows === this.map.rows) return rootCached;
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

  /** Draw a catalog/freehand object with saved editor rotation (degrees). */
  private drawFloorObject(
    ctx: CanvasRenderingContext2D,
    o: FloorBlock,
    dpr: number,
    lineW: number,
  ): void {
    const cx = o.x + o.w / 2;
    const cz = o.z + o.d / 2;
    const sx = this.wx(cx);
    const sy = this.wz(cz);
    const w = o.w * this.scale;
    const h = o.d * this.scale;
    const rot = objectRotationRad(o);
    if (!o.kind && o.shape === 'polygon' && o.points && o.points.length >= 3) {
      this.drawShape(
        ctx,
        this.wx(o.x),
        this.wz(o.z),
        w,
        h,
        'polygon',
        objectBaseColor(o),
        WALL_EDGE_BLUE,
        lineW,
        false,
        o.points,
      );
      return;
    }
    ctx.save();
    ctx.translate(sx, sy);
    if (Math.abs(rot) > 1e-6) ctx.rotate(rot);
    if (o.kind) {
      drawFloorPlanSymbol(
        ctx,
        o.kind,
        -w / 2,
        -h / 2,
        w,
        h,
        WALL_EDGE_BLUE,
        Math.max(1.5, 1.85 * dpr),
        { count: o.count },
      );
    } else {
      this.drawShape(
        ctx,
        -w / 2,
        -h / 2,
        w,
        h,
        o.shape || 'rectangle',
        objectBaseColor(o),
        WALL_EDGE_BLUE,
        lineW,
        false,
      );
    }
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
    fullName = false,
  ): void {
    const raw = label?.trim() || '';
    if (!raw || w < 10 || h < 10) return;
    const pad = Math.max(3, 4 * dpr);
    const maxFont = fullName
      ? Math.min(Math.max(h * 0.38, 13 * dpr), 18 * dpr)
      : Math.min(h * 0.42, w * 0.2, 16 * dpr);
    const fontSize = Math.max(8 * dpr, maxFont);
    ctx.save();
    ctx.font = `800 ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = fullName ? raw : fitTextToWidth(ctx, raw, Math.max(4, w - pad * 2));
    if (!text) {
      ctx.restore();
      return;
    }
    const cx = x + w / 2;
    const cy = y + h / 2;

    if (fullName) {
      const tw = ctx.measureText(text).width;
      const bx = cx - tw / 2 - pad;
      const by = cy - fontSize / 2 - pad * 0.6;
      const bw = tw + pad * 2;
      const bh = fontSize + pad * 1.2;
      ctx.beginPath();
      canvasRoundRect(ctx, bx, by, bw, bh, Math.min(8 * dpr, bh / 2));
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.2, 1.4 * dpr);
      ctx.stroke();
    }

    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(2, fontSize * 0.22);
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  private selectedZoneIdSet(): Set<string> {
    return collectSelectedZoneIds(
      this.selectedPoiId,
      this.originId,
      this.destId,
      this.blinkZoneIds,
    );
  }

  private previewMap(): Floor2DMap | null {
    if (!this.map || !this.walk) return null;
    if (!this.previewDirty && this.cachedPreview) return this.cachedPreview;
    this.cachedPreview = this.map;
    this.previewDirty = false;
    return this.cachedPreview;
  }

  private drawWalkGrid(ctx: CanvasRenderingContext2D, preview: Floor2DMap): void {
    if (!this.walk) return;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    const corridors = preview.corridors;
    if (corridors.length > 0) {
      for (let i = 0; i < corridors.length; i++) {
        const b = corridors[i];
        ctx.fillRect(this.wx(b.x), this.wz(b.z), b.w * this.scale, b.d * this.scale);
      }
      return;
    }
    const m = preview;
    const cellCount = m.cols * m.rows;
    if (cellCount > HUGE_GRID_CELLS) {
      const bmp = getWalkGridBitmap(this.walk, m.cols, m.rows, `walk-${m.cols}x${m.rows}`);
      const x0 = this.wx(m.minX);
      const y0 = this.wz(m.minZ);
      const w = (m.maxX - m.minX) * this.scale;
      const h = (m.maxZ - m.minZ) * this.scale;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, x0, y0, w, h);
      return;
    }
    const cellPx = m.cellSize * this.scale;
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
    const lineW = Math.max(0.5, 0.55 * dpr);
    ctx.lineWidth = lineW;
    ctx.strokeStyle = FLOOR2D_STYLE.wallLight;
    ctx.globalAlpha = 1;
    for (let i = 0; i < m.stores.length; i++) {
      const b = m.stores[i];
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      const roomLabel = b.label?.trim() || '';
      const fill =
        b.fill && b.fill !== 'transparent'
          ? b.fill
          : zoneInteriorColorFromLabel(roomLabel, i);
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + lineW * 0.5, y + lineW * 0.5, Math.max(1, w - lineW), Math.max(1, h - lineW));
      if (roomLabel) {
        ctx.save();
        ctx.globalAlpha = FLOOR2D_STYLE.poiLabelOpacity;
        this.drawZoneLabel(ctx, x, y, w, h, roomLabel, dpr, FLOOR2D_STYLE.poiLabel);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawWalls(_ctx: CanvasRenderingContext2D, _m: Floor2DMap, _dpr: number, _walk?: Uint8Array): void {
    // Wall lines removed from 2D map — keep floor / zones / objects only.
  }

  private drawRouteOnPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: FloorPathPoint[] | { x: number; z: number }[],
  ): void {
    this.drawExpoFpRouteOnPath(ctx, dpr, path);
  }

  /** NAVIA-style: neon green glow + animated traveling segment. */
  private drawExpoFpRouteOnPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: FloorPathPoint[] | { x: number; z: number }[],
  ): void {
    if (path.length < 2) return;
    // Slim route on the 2D map page.
    const lw = Math.max(2.2, 2.6 * dpr);
    const progress = routeAnimProgress();

    const strokePolyline = (pts: typeof path, color: string, width: number, glow = 0) => {
      ctx.save();
      if (glow > 0) {
        ctx.shadowColor = EXPOFP_ROUTE_ACTIVE;
        ctx.shadowBlur = glow * dpr;
      }
      ctx.beginPath();
      ctx.moveTo(this.wx(pts[0].x), this.wz(pts[0].z));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(this.wx(pts[i].x), this.wz(pts[i].z));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    };

    strokePolyline(path, EXPOFP_ROUTE_PALE, lw + 1.2 * dpr, 1.5);

    const active = slicePolylineXZ(path, progress);
    if (active.length >= 2) {
      strokePolyline(active, EXPOFP_ROUTE_ACTIVE, lw + 2.2 * dpr, 4);
      strokePolyline(active, NAV_ROUTE_BLACK_GREEN_BRIGHT, lw + 0.6 * dpr, 0);
      strokePolyline(active, NAV_ROUTE_GLOSS_HIGHLIGHT, lw * 0.45, 0);
      const head = active[active.length - 1];
      const hx = this.wx(head.x);
      const hy = this.wz(head.z);
      ctx.save();
      ctx.shadowColor = EXPOFP_ROUTE_ACTIVE;
      ctx.shadowBlur = 3 * dpr;
      ctx.fillStyle = EXPOFP_ROUTE_ACTIVE;
      ctx.beginPath();
      ctx.arc(hx, hy, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private hasActiveRoute(): boolean {
    if (!this.navRouteVisible) return false;
    if (this.path.length >= 2) return true;
    for (let i = 0; i < this.routeSegments.length; i++) {
      if (this.routeSegments[i].path.length >= 2) return true;
    }
    return false;
  }

  private syncRouteAnimLoop(): void {
    if (this.renderingPaused || !this.hasActiveRoute()) {
      this.stopRouteAnimLoop();
      return;
    }
    if (this.routeAnimFrame) return;
    let lastDraw = 0;
    const tick = (now: number) => {
      if (this.renderingPaused || !this.hasActiveRoute()) {
        this.stopRouteAnimLoop();
        return;
      }
      this.routeAnimFrame = requestAnimationFrame(tick);
      // Skip while the user is panning, and throttle redraws so 2D stays responsive.
      if (this.drag || this.panning) return;
      if (!this.iso3d && !this.usesStackedPlate3d()) {
        if (now - lastDraw < 80) return;
        lastDraw = now;
        this.scheduleDraw();
      }
    };
    this.routeAnimFrame = requestAnimationFrame(tick);
  }

  private stopRouteAnimLoop(): void {
    if (this.routeAnimFrame) cancelAnimationFrame(this.routeAnimFrame);
    this.routeAnimFrame = 0;
  }

  private drawRouteScreenPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    points: { x: number; y: number }[],
    stroke: string = FLOOR2D_STYLE.route,
  ): void {
    if (points.length < 2) return;
    const lw = Math.max(2.2, 2.6 * dpr);
    const outline = lw + Math.max(1.2, 1.4 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = FLOOR2D_STYLE.routeOutline;
    ctx.lineWidth = outline;
    ctx.stroke();
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
    ctx.strokeStyle = 'rgba(59,102,204,0.42)';
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
      this.drawRouteScreenPath(ctx, dpr, screenPts, EXPOFP_ROUTE_ACTIVE);
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
    const linked = !!(mouth.linkedFloorId && mouth.linkedMouthId);
    const r = Math.max(5, 6 * dpr);
    ctx.save();
    ctx.fillStyle = linked ? STAIR_MOUTH_LINK_COLOR : STAIR_MOUTH_MARKER_COLOR;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (linked) {
      ctx.strokeStyle = STAIR_MOUTH_LINK_COLOR;
      ctx.lineWidth = Math.max(1.25, 1.5 * dpr);
      ctx.beginPath();
      ctx.arc(px, py, r + 3 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
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

    ctx.fillStyle = MAP_PALETTE.background;
    ctx.fillRect(x0, y0, cardW, cardH);

    ctx.strokeStyle = isActive ? FLOOR2D_STYLE.accent : '#cccccc';
    ctx.lineWidth = isActive ? 2 * dpr : 1 * dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cardW - 1, cardH - 1);

    const fontSize = Math.max(10, 11 * dpr);
    ctx.font = `600 ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = MAP_PALETTE.zoneLabel;
    ctx.fillText(title, x0 + 10 * dpr, y0 + 8 * dpr);
  }

  private drawWalkGridForFloor(ctx: CanvasRenderingContext2D, walk: Uint8Array, preview?: Floor2DMap): void {
    if (!this.map) return;
    const m = preview ?? this.map;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    const corridors = m.corridors;
    if (corridors && corridors.length > 0) {
      for (let i = 0; i < corridors.length; i++) {
        const b = corridors[i];
        ctx.fillRect(this.wx(b.x), this.wz(b.z), b.w * this.scale, b.d * this.scale);
      }
      return;
    }
    const cellCount = m.cols * m.rows;
    if (cellCount > HUGE_GRID_CELLS) {
      const bmp = getWalkGridBitmap(walk, m.cols, m.rows, `walk-${m.cols}x${m.rows}`);
      const x0 = this.wx(m.minX);
      const y0 = this.wz(m.minZ);
      const w = (m.maxX - m.minX) * this.scale;
      const h = (m.maxZ - m.minZ) * this.scale;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, x0, y0, w, h);
      return;
    }
    const cellPx = m.cellSize * this.scale;
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
    const floors = this.routeNavigationFloors() ?? this.floorsForScene3dView();
    const mapH = this.map.maxZ - this.map.minZ;
    const gapPx = this.stackGapPx(dpr);
    const pad = this.platePadPx(dpr);

    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const dy = this.stackLayerDy(i, mapH, gapPx, dpr);
      const bounds = this.plateBounds(i, mapH, gapPx, dpr);
      const isActive = floor.id === this.activeFloorId;
      const preview = this.previewMapForFloorCached(floor);
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

      if (walk) this.drawWalkGridForFloor(ctx, walk, preview);
      this.drawStores(ctx, preview, dpr);
      const seg = this.routeSegments.find((s) => s.floorId === floor.id);
      if (seg) {
        const trimmed = this.trimPathForFloor(floor.id, seg.path);
        this.drawRouteOnPath(ctx, dpr, trimmed);
      } else if (floor.id === this.activeFloorId) {
        this.drawRoute(ctx, dpr);
      }
      this.drawWalls(ctx, preview, dpr, walk ?? undefined);

      const objLineW = Math.max(1.25, 1.5 * dpr);
      for (let oi = 0; oi < objects.length; oi++) {
        this.drawFloorObject(ctx, objects[oi], dpr, objLineW);
      }

      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        const stroke = z.stroke || FLOOR2D_STYLE.accent;
        const fillColor =
          z.fill && z.fill !== 'transparent'
            ? z.fill
            : z.stroke && z.stroke !== 'transparent'
              ? z.stroke
              : zoneInteriorColorFromLabel(z.label, zi);
        ctx.save();
        ctx.globalAlpha = 0.22;
        this.drawZoneFill(ctx, z, fillColor);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = FLOOR2D_STYLE.zoneStrokeOpacity;
        this.drawZoneOutline(ctx, z, stroke, Math.max(2, 2.5 * dpr), dpr);
        ctx.restore();
        if (this.blinkZoneIds.has(z.id)) {
          const pulse = zoneBlinkPulse();
          const blinkStroke = zoneBlinkStrokeColor(stroke, pulse);
          const blinkFill = zoneBlinkFillColor(fillColor, stroke, pulse);
          ctx.save();
          ctx.globalAlpha = 0.14 + pulse * 0.12;
          this.drawZoneFill(ctx, z, blinkFill);
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = 0.5 + pulse * 0.18;
          this.drawZoneOutline(ctx, z, blinkStroke, Math.max(2, 2.5 * dpr) * (1.2 + pulse * 0.25), dpr);
          ctx.restore();
        }
        if (z.label?.trim()) {
          const b = zoneBounds(z);
          const zx = this.wx(b.minX);
          const zy = this.wz(b.minZ);
          const zw = Math.max(1, (b.maxX - b.minX) * this.scale);
          const zh = Math.max(1, (b.maxZ - b.minZ) * this.scale);
          const fullName = this.selectedZoneIdSet().has(z.id);
          ctx.save();
          ctx.globalAlpha = FLOOR2D_STYLE.zoneLabelOpacity;
          this.drawZoneLabel(ctx, zx, zy, zw, zh, z.label, dpr, FLOOR2D_STYLE.zoneLabel, fullName);
          ctx.restore();
        }
      }

      this.drawPois(ctx, dpr, floor);

      ctx.restore();
      ctx.restore();
    }

    if (this.isActiveMultiFloorNav()) {
      this.drawGapStairRoutes(ctx, dpr, floors, mapH, gapPx);
    }

    if (this.routeError) {
      ctx.font = `600 ${Math.max(10, 12 * dpr)}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(this.routeError, this.canvas.width * 0.5, this.canvas.height - 18 * dpr);
    }
  }

  private drawRoute(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.navRouteVisible) return;
    const floorId = this.activeFloorId;

    if (this.routeSegments.length > 1) {
      if (!floorId) return;
      const seg = this.routeSegments.find((s) => s.floorId === floorId);
      if (seg) {
        this.drawExpoFpRouteOnPath(ctx, dpr, this.trimPathForFloor(floorId, seg.path));
      }
      return;
    }

    if (this.path.length < 2) return;
    this.drawExpoFpRouteOnPath(ctx, dpr, this.path);
  }

  private drawZones(ctx: CanvasRenderingContext2D, dpr: number): void {
    const lineW = Math.max(2, 2.5 * dpr);
    const selectedZones = this.selectedZoneIdSet();
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const { fill: fillColor, stroke } = zoneVisualStyle(z, i);

      ctx.save();
      ctx.globalAlpha = 0.22;
      this.drawZoneFill(ctx, z, fillColor);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = FLOOR2D_STYLE.zoneStrokeOpacity;
      this.drawZoneOutline(ctx, z, stroke, lineW, dpr);
      ctx.restore();

      if (this.blinkZoneIds.has(z.id)) {
        const pulse = zoneBlinkPulse();
        const blinkStroke = zoneBlinkStrokeColor(stroke, pulse);
        const blinkFill = zoneBlinkFillColor(fillColor, stroke, pulse);
        ctx.save();
        ctx.globalAlpha = 0.14 + pulse * 0.12;
        this.drawZoneFill(ctx, z, blinkFill);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.5 + pulse * 0.18;
        this.drawZoneOutline(ctx, z, blinkStroke, lineW * (1.2 + pulse * 0.25), dpr);
        ctx.restore();
      }

      const label = z.label?.trim();
      if (label) {
        const b = zoneBounds(z);
        const zx = this.wx(b.minX);
        const zy = this.wz(b.minZ);
        const zw = Math.max(1, (b.maxX - b.minX) * this.scale);
        const zh = Math.max(1, (b.maxZ - b.minZ) * this.scale);
        const fullName = selectedZones.has(z.id);
        ctx.save();
        ctx.globalAlpha = FLOOR2D_STYLE.zoneLabelOpacity;
        this.drawZoneLabel(ctx, zx, zy, zw, zh, label, dpr, stroke, fullName);
        ctx.restore();
      }
    }
  }

  private drawOriginMarker(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    dpr: number,
    headingRad = 0,
  ): void {
    const size = 36 * dpr;
    ctx.save();
    ctx.translate(px - size / 2, py - size / 2);
    drawNavStartFlatIcon(ctx, size, size, headingRad);
    ctx.restore();
  }

  private drawDestinationMarker(ctx: CanvasRenderingContext2D, px: number, py: number, dpr: number): void {
    const w = 30 * dpr;
    const h = 40 * dpr;
    ctx.save();
    ctx.translate(px - w / 2, py - h * 0.88);
    drawNavDestFlatPin(ctx, w, h);
    ctx.restore();
  }

  private drawEndpointBadge(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    label: string,
    color: string,
    dpr: number,
  ): void {
    const s = dpr;
    const padX = 7 * s;
    const padY = 3 * s;
    ctx.save();
    ctx.font = `700 ${9 * s}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const bw = tw + padX * 2;
    const bh = 14 * s;
    const bx = px - bw / 2;
    const by = py;
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * s;
    const r = 7 * s;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, px, by + bh / 2);
    ctx.restore();
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
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(px, py, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawPoiNameLabel(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    name: string,
    dpr: number,
    selected = false,
  ): void {
    const fontSize = selected ? Math.max(12, 14 * dpr) : Math.max(10, 12 * dpr);
    const labelY = py + (selected ? 10 : 8) * dpr;
    ctx.save();
    ctx.font = `${selected ? 700 : 500} ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = selected ? 3.5 * dpr : 2.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.strokeText(name, px, labelY);
    ctx.fillStyle = selected ? 'rgba(15,23,42,0.92)' : 'rgba(100,116,139,0.78)';
    ctx.fillText(name, px, labelY);
    ctx.restore();
  }

  private drawPois(ctx: CanvasRenderingContext2D, dpr: number, floorFilter?: FloorLevel): void {
    const sliceY = floorFilter?.floorY ?? this.getActiveFloorY();
    if (!this.navRouteVisible) return;

    const drawEndpoint = (id: string, kind: 'From' | 'To') => {
      const ep = this.resolveEndpoint(id, sliceY);
      if (!ep) return;
      const px = this.wx(ep.x);
      const py = this.wz(ep.z);
      if (kind === 'From') {
        const heading = routeHeadingFromPath(this.activeFloorRoutePath(), true, ep);
        this.drawOriginMarker(ctx, px, py, dpr, heading);
      } else {
        this.drawDestinationMarker(ctx, px, py, dpr);
      }
    };

    if (this.originId) drawEndpoint(this.originId, 'From');
    if (this.destId && this.destId !== this.originId) {
      drawEndpoint(this.destId, 'To');
    }
  }

  private drawNow(): void {
    if (this.renderingPaused) return;
    if (this.usesStackedPlate3d()) {
      if (this.scene3dDirty) {
        this.enableMultiFloor3dView();
        this.syncScene3dIfNeeded(false);
      } else {
        this.scene3d?.requestRender();
      }
      this.updatePoiLabelsOverlay();
      return;
    }
    if (this.iso3d) {
      if (this.scene3dDirty) this.syncScene3dIfNeeded(false);
      else this.scene3d?.requestRender();
      if (this.tapHighlight) this.updateTapOverlay();
      this.updatePoiLabelsOverlay();
      return;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.map || !this.walk) return;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = FLOOR2D_STYLE.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.usesStackedLayout() && this.viewStack) {
      if (this.stackLayoutDirty) this.fitStackedView();
      this.drawStackedFloorsView(ctx, dpr);
      return;
    }

    const preview = this.previewMap();
    if (!preview) return;

    this.drawWalkGrid(ctx, preview);
    this.drawStores(ctx, preview, dpr);
    this.drawRoute(ctx, dpr);
    this.drawWalls(ctx, preview, dpr, this.walk);

    const objLineW = Math.max(1.25, 1.5 * dpr);
    for (let i = 0; i < this.objects.length; i++) {
      this.drawFloorObject(ctx, this.objects[i], dpr, objLineW);
    }

    this.drawZones(ctx, dpr);
    this.drawPois(ctx, dpr);
    this.drawTapHighlight(ctx, dpr);
    this.updatePoiLabelsOverlay();

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

// NavMe circular logo for the nav panel header.
const NAVME_LOGO_URL = new URL('./Assets/NavMe_wb.png', import.meta.url).href;

const MAP_TOGGLE_ICON_SVG =
  '<svg class="mini3dgta-map-toggle__svg" viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M4 17.5 12 21.5 20 17.5 12 13.5Z" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round"/>' +
  '<path d="M4 13.5 12 17.5 20 13.5 12 9.5Z" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round"/>' +
  '<path d="M4 9.5 12 13.5 20 9.5 12 5.5Z" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round"/>' +
  '</svg>';

const NAV_AR_ICON_SVG =
  '<svg class="mini3dgta-fs-nav-ar-btn__svg" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M7 3H3v4M17 3h4v4M7 21H3v-4M17 21h4v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '</svg>';

/** Opens the AR experience URL from NAVME_CONFIG.viewInArUrl (set in behaviors.ts). */
function openViewInArExperience(): void {
  if (typeof window === 'undefined') return;
  const url = (NAVME_CONFIG.viewInArUrl || '').trim();
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function injectMini3dGtaUiStyles(): void {
  if (typeof document === 'undefined') return;
  const css = `
.mini3dgta-map-toggle{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 16px;border:1.5px solid ${NAVME_UI_BLUE};border-radius:999px;background:rgba(255,255,255,.97);box-shadow:0 4px 18px rgba(59,102,204,.14),0 2px 8px rgba(0,0,0,.06);cursor:pointer;pointer-events:auto;color:${NAVME_UI_BLUE};font:600 14px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;letter-spacing:-.01em;white-space:nowrap;transition:transform .15s ease,box-shadow .15s ease,background .15s ease}
.mini3dgta-map-toggle__svg{display:block;flex:0 0 auto;pointer-events:none;color:${NAVME_UI_BLUE}}
.mini3dgta-map-toggle__label--nav{display:none}
body.zcomponent-localized:not(.navme-surface-scanning) .mini3dgta-map-toggle__label--scan{display:none}
body.zcomponent-localized:not(.navme-surface-scanning) .mini3dgta-map-toggle__label--nav{display:inline}
.mini3dgta-map-toggle:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(59,102,204,.2),0 3px 10px rgba(0,0,0,.08)}
.mini3dgta-map-toggle:active{transform:translateY(0)}
.mini3dgta-fs-overlay{position:fixed;inset:0;z-index:2147483645;display:none;background:#ffffff;pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:#1e293b}
body.mini3dgta-fs-open #nav-bottom-anchor,body.mini3dgta-fs-open .gcu-dest-search-root{opacity:0!important;visibility:hidden!important;pointer-events:none!important}
body.mini3dgta-fs-open .mini3dgta-map-toggle{display:none!important}
body.mini3dgta-fs-open .spatial-grid,body.mini3dgta-fs-open .ar-crosshair{display:none!important}
body.navme-map-immersive .splash,body.navme-map-immersive #readyState,body.navme-map-immersive .navme-scanner-ui{display:none!important;pointer-events:none!important}
body.navme-map-immersive.navme-surface-scanning .splash,body.navme-map-immersive.navme-surface-scanning #readyState{display:none!important}
.mini3dgta-fs-body{position:absolute;inset:0}
.floor2d-layout{display:flex;flex:1;min-height:0;min-width:0;width:100%;position:absolute;inset:0}
.floor2d-zone-sidebar{display:none!important}
.mini3dgta-fs-map{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden;background:#ffffff}
.mini3dgta-fs-map::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:1;opacity:.03;mix-blend-mode:multiply;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E")}
.wf-sketch-canvas,.floor2d-canvas{filter:none}
.mini3dgta-fs-bottom-stack{position:absolute;left:50%;bottom:max(12px,env(safe-area-inset-bottom,12px));transform:translateX(-50%);z-index:9;display:flex;flex-direction:column;align-items:center;gap:10px;width:min(calc(100vw - 20px),430px);pointer-events:none}
.mini3dgta-fs-nav-ar-btn{position:absolute;top:max(12px,env(safe-area-inset-top,0px));left:14px;right:auto;z-index:8;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:6px 12px;border:1.5px solid ${NAVME_UI_BLUE};border-radius:999px;background:rgba(255,255,255,.98);box-shadow:0 3px 12px rgba(59,102,204,.12),0 1px 4px rgba(0,0,0,.05);cursor:pointer;pointer-events:auto;color:${NAVME_UI_BLUE};font:600 12px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;letter-spacing:-.01em;white-space:nowrap}
.mini3dgta-fs-nav-ar-btn__svg{display:block;flex:0 0 auto;width:14px;height:14px;color:${NAVME_UI_BLUE}}
.mini3dgta-fs-nav-ar-btn:hover{background:#fff;box-shadow:0 4px 14px rgba(59,102,204,.18)}
.mini3dgta-fs-map--has-project-bar .mini3dgta-fs-nav-ar-btn{top:max(68px,calc(env(safe-area-inset-top,10px) + 58px));left:14px;right:auto}
.mini3dgta-fs-float-dock{display:flex;flex-direction:column;gap:12px;width:100%;padding:14px 14px 12px;background:rgba(255,255,255,.98);border:1.5px solid ${NAVME_UI_BLUE};border-radius:18px;box-shadow:0 8px 28px rgba(59,130,246,.12),0 2px 8px rgba(0,0,0,.06);pointer-events:auto;box-sizing:border-box;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.mini3dgta-fs-dock-header{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%}
.mini3dgta-fs-dock-logo{flex:0 0 auto;height:40px;width:40px;border-radius:50%;overflow:hidden;pointer-events:none;background:transparent}
.mini3dgta-fs-dock-logo img{display:block;height:100%;width:100%;object-fit:cover;padding:0;box-sizing:border-box}
.mini3dgta-fs-dock-brand{flex:1 1 auto;min-width:0;font:800 15px/1.15 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:-.02em;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini3dgta-fs-dock-routes{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%;min-width:0}
.mini3dgta-fs-dock-field{display:flex;flex-direction:column;gap:5px;flex:1 1 0;min-width:0}
.mini3dgta-fs-dock-field--floor{flex:0 1 auto;width:min(148px,42vw);max-width:160px;margin-left:auto}
.mini3dgta-fs-dock-field__label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;line-height:1.2}
.mini3dgta-fs-dock-field__label--from,.mini3dgta-fs-dock-field__label--to{color:${NAV_ROUTE_RED}}
.mini3dgta-fs-dock-arrow{align-self:center;padding:0;margin:-2px 0;font-size:14px;line-height:1;color:#94a3b8;flex-shrink:0}
.mini3dgta-fs-select{box-sizing:border-box;min-width:0;width:100%;min-height:44px;padding:10px 28px 10px 11px;border-radius:12px;border:1px solid rgba(60,60,67,.14);background-color:#f8fafc;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;color:#1e293b;font-size:16px;font-weight:600;line-height:1.25;cursor:pointer;appearance:none;-webkit-appearance:none;touch-action:manipulation}
.mini3dgta-fs-select:focus{outline:none;border-color:${NAVME_UI_BLUE};box-shadow:0 0 0 2px ${NAVME_UI_BLUE_SOFT}}
.floor2d-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;background:#ffffff;position:relative;z-index:1}
.floor2d-canvas:active,.floor2d-canvas.is-dragging{cursor:grabbing}
.mini3dgta-status{position:absolute;top:max(14px,env(safe-area-inset-top,0px));left:12px;right:12px;z-index:6;max-width:calc(100% - 24px);padding:10px 12px;border-radius:12px;font:12px/1.4 system-ui,sans-serif;color:#1e293b;background:#fff;border:1px solid rgba(59,102,204,.22);pointer-events:none;display:none}
.mini3dgta-status__phase{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${NAVME_UI_BLUE};margin-bottom:4px}
.mini3dgta-status__phase--error{color:#dc2626}
.mini3dgta-status__phase--done{color:#16a34a}
.mini3dgta-status__message{margin:0;font-size:12px;line-height:1.45;color:#475569}
.mini3dgta-fs-search-box{position:relative;width:100%;display:flex;align-items:center;gap:4px}
.mini3dgta-fs-search-input{box-sizing:border-box;flex:1;min-width:0;min-height:44px;padding:10px 11px;border-radius:12px;border:1px solid rgba(60,60,67,.14);background:#f8fafc;color:#1e293b;font-size:16px;font-weight:600;line-height:1.25;cursor:pointer;touch-action:manipulation}
.mini3dgta-fs-search-clear{flex:0 0 auto;width:28px;height:28px;border-radius:8px;border:1px solid rgba(60,60,67,.14);background:#fff;color:#64748b;font-size:13px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
.mini3dgta-fs-search-clear:hover{background:#fef2f2;border-color:#fecaca;color:${NAV_ROUTE_RED}}
.mini3dgta-fs-search-clear[hidden]{display:none!important}
.mini3dgta-fs-search-input::placeholder{color:#94a3b8;font-weight:500}
.mini3dgta-fs-search-input:focus{outline:none;border-color:${NAVME_UI_BLUE};box-shadow:0 0 0 2px ${NAVME_UI_BLUE_SOFT}}
/* Legacy 2D/3D walls toggle hidden — map is 3D-only; use top-down lock instead */
.mini3dgta-fs-view3d{display:none!important}
.mini3dgta-fs-view2d-lock{position:absolute;top:max(12px,env(safe-area-inset-top,0px));right:14px;z-index:8;display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:44px;padding:0 14px;border-radius:12px;border:1.5px solid ${NAVME_UI_BLUE};background:rgba(255,255,255,.98);color:${NAVME_UI_BLUE};cursor:pointer;box-shadow:0 2px 12px rgba(59,130,246,.14);pointer-events:auto;font:700 13px/1 system-ui,sans-serif;letter-spacing:.04em;transition:transform .15s ease,background .15s ease,color .15s ease}
.mini3dgta-fs-view2d-lock:hover{transform:translateY(-1px)}
.mini3dgta-fs-view2d-lock--active{background:${NAVME_UI_BLUE};color:#fff}
.mini3dgta-fs-map--has-project-bar .mini3dgta-fs-view2d-lock{top:max(68px,calc(env(safe-area-inset-top,10px) + 58px))}
.mini3dgta-tap-layer{position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden}
.mini3dgta-tap-pins{position:absolute;inset:0;pointer-events:none}
.mini3dgta-tap-click{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid rgba(59,102,204,.75);background:rgba(59,102,204,.18);box-shadow:0 0 0 6px rgba(59,102,204,.1);pointer-events:none}
.mini3dgta-tap-poi-pin{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:4px;border:none;background:transparent;padding:0;cursor:pointer;pointer-events:auto;z-index:6;touch-action:manipulation}
.mini3dgta-tap-poi-pin__dot{width:12px;height:12px;border-radius:50%;background:${NAV_ROUTE_BLUE};border:2px solid #fff;box-shadow:0 0 0 3px rgba(59,102,204,.22),0 2px 8px rgba(0,0,0,.18)}
.mini3dgta-tap-poi-pin__label{max-width:120px;padding:4px 8px;border-radius:8px;background:#fff;border:1px solid rgba(59,102,204,.2);box-shadow:0 2px 10px rgba(0,0,0,.1);font:600 11px/1.2 system-ui,sans-serif;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini3dgta-nearby-rail{position:absolute;left:12px;right:12px;bottom:max(168px,calc(12px + env(safe-area-inset-bottom,0px) + 156px));z-index:6;display:flex;gap:8px;overflow-x:auto;padding:8px 10px;background:#fff;border:1.5px solid rgba(59,102,204,.22);border-radius:14px;box-shadow:0 6px 24px rgba(59,102,204,.1);pointer-events:auto;-webkit-overflow-scrolling:touch;align-items:center}
.mini3dgta-nearby-rail[hidden]{display:none!important}
.mini3dgta-nearby-rail__hint{flex:0 0 auto;font:700 11px/1.3 system-ui,sans-serif;color:${NAV_ROUTE_RED};padding:4px 8px;white-space:nowrap}
.mini3dgta-nearby-rail__item{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 10px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;cursor:pointer;font:inherit;color:inherit}
.mini3dgta-nearby-rail__item:hover{background:#eff6ff;border-color:rgba(59,102,204,.28)}
.mini3dgta-nearby-rail__name{font:600 12px/1.2 system-ui,sans-serif;color:#1e293b;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini3dgta-fs-picker-sheet{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;justify-content:flex-end;pointer-events:none}
.mini3dgta-fs-picker-sheet[hidden]{display:none!important}
.mini3dgta-fs-picker-sheet__backdrop{position:absolute;inset:0;background:rgba(15,23,42,.35);pointer-events:auto}
.mini3dgta-fs-picker-sheet__panel{position:relative;max-height:min(72vh,520px);background:#fff;border:1.5px solid rgba(59,102,204,.22);border-radius:18px 18px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.15);display:flex;flex-direction:column;pointer-events:auto;padding-bottom:max(12px,env(safe-area-inset-bottom,0px))}
.mini3dgta-fs-picker-sheet__header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 8px;border-bottom:1px solid #e2e8f0}
.mini3dgta-fs-picker-sheet__title{font-size:15px;font-weight:700;color:#1e293b}
.mini3dgta-fs-picker-sheet__close{width:36px;height:36px;border:none;border-radius:10px;background:#f1f5f9;color:#334155;font-size:18px;cursor:pointer}
.mini3dgta-fs-picker-sheet__search{margin:10px 14px 0;padding:10px 12px;border-radius:12px;border:1px solid rgba(60,60,67,.14);background:#f8fafc;color:#1e293b;font-size:16px;line-height:1.25;touch-action:manipulation}
.mini3dgta-fs-picker-sheet__search:focus{outline:none;border-color:${NAVME_UI_BLUE}}
.mini3dgta-fs-picker-sheet__hint{margin:8px 16px 0;font-size:11px;color:#64748b;line-height:1.35}
.mini3dgta-fs-picker-sheet__list{flex:1;overflow-y:auto;margin:10px 0 0;padding:0 8px 8px;-webkit-overflow-scrolling:touch}
.mini3dgta-fs-picker-sheet__row{display:flex;align-items:center;gap:8px;width:100%;padding:12px 10px;border:none;border-radius:12px;background:transparent;text-align:left;cursor:pointer;color:#1e293b}
.mini3dgta-fs-picker-sheet__row:hover,.mini3dgta-fs-picker-sheet__row:focus{background:#f1f5f9;outline:none}
.mini3dgta-fs-picker-sheet__row-name{flex:1;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini3dgta-fs-picker-sheet__row-meta{flex:0 0 auto;font-size:11px;font-weight:600;color:#64748b}
.mini3dgta-fs-picker-sheet__chip{padding:5px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:11px;font-weight:700;cursor:pointer}
.mini3dgta-fs-picker-sheet__chip--from,.mini3dgta-fs-picker-sheet__chip--to{border-color:#fca5a5;color:${NAV_ROUTE_RED}}
.mini3dgta-project-bar{position:absolute;top:max(10px,env(safe-area-inset-top,10px));left:12px;right:96px;z-index:8;display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,.98);border:1.5px solid ${NAVME_UI_BLUE};border-radius:14px;box-shadow:0 4px 18px rgba(59,102,204,.12);pointer-events:auto;box-sizing:border-box}
.mini3dgta-project-bar__label{flex:0 0 auto;font:700 10px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#64748b;white-space:nowrap}
.mini3dgta-project-bar__select{box-sizing:border-box;flex:1 1 0;min-width:0;min-height:44px;padding:10px 28px 10px 11px;border-radius:12px;border:1px solid rgba(60,60,67,.14);background-color:#f8fafc;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;color:#1e293b;font-size:16px;font-weight:600;line-height:1.25;cursor:pointer;appearance:none;-webkit-appearance:none;touch-action:manipulation}
.mini3dgta-project-bar__select:focus{outline:none;border-color:${NAVME_UI_BLUE};box-shadow:0 0 0 2px ${NAVME_UI_BLUE_SOFT}}
.mini3dgta-project-bar__select:disabled{opacity:.65;cursor:wait}
.mini3dgta-project-bar__refresh{flex:0 0 auto;min-height:44px;padding:0 14px;border:1.5px solid ${NAVME_UI_BLUE};border-radius:12px;background:${NAVME_UI_BLUE};color:#fff;font:700 14px/1 system-ui,sans-serif;cursor:pointer;touch-action:manipulation;white-space:nowrap}
.mini3dgta-project-bar__refresh:disabled{opacity:.55;cursor:wait}
.mini3dgta-fs-map--has-project-bar .mini3dgta-status{top:calc(max(10px,env(safe-area-inset-top,10px)) + 64px)}
.mini3dgta-fs-map--has-project-bar .mini3dgta-fs-view3d{top:max(68px,calc(env(safe-area-inset-top,10px) + 58px))}
@media (max-width:520px){.mini3dgta-project-bar{left:10px;right:10px;flex-wrap:wrap}.mini3dgta-project-bar__label{width:100%}.mini3dgta-fs-bottom-stack{width:calc(100vw - 16px);max-width:none}.mini3dgta-fs-dock-field--floor{width:min(140px,44vw)}.mini3dgta-nearby-rail{bottom:max(200px,calc(12px + env(safe-area-inset-bottom,0px) + 176px))}}

/* ── Wayfinder: modern glassy chrome (both themes), inspired by uip-event ── */
.mini3dgta-fs-float-dock,.mini3dgta-project-bar,.mini3dgta-status,.mini3dgta-nearby-rail,.mini3dgta-map-toggle,.mini3dgta-fs-nav-ar-btn,.mini3dgta-fs-view3d,.mini3dgta-fs-view2d-lock,.wf-theme-toggle,.mini3dgta-fs-picker-sheet__panel{backdrop-filter:saturate(140%) blur(14px);-webkit-backdrop-filter:saturate(140%) blur(14px)}
.wf-theme-toggle{position:absolute;top:max(12px,env(safe-area-inset-top,0px));right:14px;z-index:8;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;border:1.5px solid ${NAVME_UI_BLUE};background:rgba(255,255,255,.98);color:${NAVME_UI_BLUE};cursor:pointer;box-shadow:0 2px 12px rgba(16,185,129,.14);pointer-events:auto;font-size:18px;line-height:1;padding:0;transition:transform .15s ease,background .15s ease}
.wf-theme-toggle:hover{transform:translateY(-1px)}
.mini3dgta-fs-dock-logo{background:transparent}
.mini3dgta-fs-dock-logo img{padding:0}
.wf-theme-toggle__svg{display:block;width:20px;height:20px}
.mini3dgta-fs-map--has-project-bar .wf-theme-toggle{top:max(68px,calc(env(safe-area-inset-top,10px) + 58px))}
/* View-3D toggle sits to the LEFT of the theme toggle so both are reachable */
.mini3dgta-fs-view3d{right:66px}
.mini3dgta-fs-map--has-project-bar .mini3dgta-fs-view3d{right:66px}

/* ── Wayfinder DARK theme (NavMe logo navy + electric blue) ── */
body[data-wf-theme="dark"] .mini3dgta-fs-overlay{background:${NAVME_DARK_BG};color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-fs-map{background:${NAVME_DARK_BG}}
body[data-wf-theme="dark"] .floor2d-canvas{background:${NAVME_DARK_BG}}
body[data-wf-theme="dark"] .mini3dgta-fs-float-dock,body[data-wf-theme="dark"] .mini3dgta-project-bar,body[data-wf-theme="dark"] .mini3dgta-status,body[data-wf-theme="dark"] .mini3dgta-nearby-rail,body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__panel,body[data-wf-theme="dark"] .wf-nav-panel{background:rgba(17,28,48,.94);border-color:rgba(59,130,246,.42);box-shadow:0 10px 34px rgba(0,0,0,.55),0 0 0 1px rgba(59,130,246,.1)}
body[data-wf-theme="dark"] .mini3dgta-map-toggle,body[data-wf-theme="dark"] .mini3dgta-fs-nav-ar-btn,body[data-wf-theme="dark"] .mini3dgta-fs-view3d,body[data-wf-theme="dark"] .mini3dgta-fs-view2d-lock,body[data-wf-theme="dark"] .wf-theme-toggle{background:rgba(17,28,48,.92);color:${NAVME_UI_BLUE_BRIGHT};border-color:rgba(59,130,246,.45)}
body[data-wf-theme="dark"] .mini3dgta-fs-view3d--active,body[data-wf-theme="dark"] .mini3dgta-fs-view2d-lock--active{background:${NAVME_UI_BLUE};color:#fff}
body[data-wf-theme="dark"] .mini3dgta-fs-select,body[data-wf-theme="dark"] .mini3dgta-fs-search-input,body[data-wf-theme="dark"] .mini3dgta-project-bar__select,body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__search,body[data-wf-theme="dark"] .wf-nav-panel .mini3dgta-fs-select,body[data-wf-theme="dark"] .wf-nav-panel .mini3dgta-fs-search-input{background-color:rgba(255,255,255,.06);color:#E8EEF8;border-color:rgba(255,255,255,.14)}
body[data-wf-theme="dark"] .mini3dgta-fs-select,body[data-wf-theme="dark"] .mini3dgta-project-bar__select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235BA3FF' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")}
body[data-wf-theme="dark"] .mini3dgta-fs-search-input::placeholder{color:#64748b}
body[data-wf-theme="dark"] .mini3dgta-fs-dock-field__label,body[data-wf-theme="dark"] .mini3dgta-project-bar__label,body[data-wf-theme="dark"] .mini3dgta-status__message,body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__hint{color:#94A3B8}
body[data-wf-theme="dark"] .mini3dgta-status{color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-fs-dock-logo{background:transparent}
body[data-wf-theme="dark"] .mini3dgta-fs-dock-brand{color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-nearby-rail__item{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.10);color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-nearby-rail__item:hover{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.4)}
body[data-wf-theme="dark"] .mini3dgta-nearby-rail__name{color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-tap-poi-pin__label{background:rgba(17,28,48,.94);border-color:rgba(59,130,246,.4);color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__header{border-color:rgba(255,255,255,.08)}
body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__title,body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__row,body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__row-name{color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__row:hover,body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__row:focus{background:rgba(255,255,255,.06)}
body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__close{background:rgba(255,255,255,.08);color:#E8EEF8}
body[data-wf-theme="dark"] .mini3dgta-fs-picker-sheet__chip{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16);color:#E8EEF8}
body[data-wf-theme="dark"] .wf-map-controls__zoom,body[data-wf-theme="dark"] .wf-map-controls__loc{background:rgba(17,28,48,.94);border-color:rgba(59,130,246,.35);color:${NAVME_UI_BLUE_BRIGHT}}
body[data-wf-theme="dark"] .wf-map-controls__btn{color:#E8EEF8}
body[data-wf-theme="dark"] .wf-nav-panel__hint{color:#94a3b8}

/* ═══ Wayfinder — single compact navigation panel ═══ */
.wf-nav-panel{display:flex;flex-direction:column;gap:8px;width:100%;padding:10px 12px;border-radius:16px;background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.08);box-shadow:0 8px 28px rgba(15,23,42,.14);backdrop-filter:saturate(150%) blur(16px);-webkit-backdrop-filter:saturate(150%) blur(16px);pointer-events:auto;box-sizing:border-box}
.wf-nav-panel__header{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%}
.wf-nav-panel__header .mini3dgta-fs-dock-logo{flex:0 0 auto;height:36px;width:36px;border-radius:50%;order:0}
.wf-nav-panel__header .mini3dgta-fs-dock-logo img{max-width:none;width:100%;height:100%;padding:0;object-fit:cover}
.wf-nav-panel__header .mini3dgta-fs-dock-brand{flex:1 1 auto;min-width:0;order:0;font:800 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:-.02em;color:#0f172a}
.wf-nav-panel__header .mini3dgta-fs-dock-field--floor{flex:0 1 auto;width:min(148px,42vw);max-width:168px;min-width:0;margin-left:auto;order:1}
.wf-nav-panel__header .mini3dgta-fs-dock-field__label{display:none}
.wf-nav-panel .mini3dgta-fs-dock-field{gap:4px;min-width:0}
.wf-nav-panel .mini3dgta-fs-dock-routes .mini3dgta-fs-dock-field__label{display:none}
.wf-nav-panel .mini3dgta-fs-select,.wf-nav-panel .mini3dgta-fs-search-input{min-height:38px;font-size:14px;border-radius:11px;background:#f5f7fa;border-color:rgba(15,23,42,.1)}
.wf-nav-panel .mini3dgta-fs-dock-routes{display:flex;flex-direction:row;align-items:stretch;gap:8px;width:100%}
.wf-nav-panel .mini3dgta-fs-dock-routes .mini3dgta-fs-dock-field{flex:1 1 0;min-width:0}
.wf-nav-panel .mini3dgta-fs-dock-routes .mini3dgta-fs-dock-field[hidden]{display:none!important}
.mini3dgta-fs-navigate-btn{flex:1 1 0;min-width:0;min-height:38px;padding:0 14px;border:none;border-radius:11px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font:700 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(37,99,235,.28);transition:opacity .15s,transform .12s}
.mini3dgta-fs-navigate-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
.mini3dgta-fs-navigate-btn:not(:disabled):active{transform:scale(.98)}
.wf-nav-panel__hint{margin:4px 0 0;padding:0;font:400 11px/1.35 system-ui,-apple-system,sans-serif;color:#64748b;text-align:center}
body[data-wf-theme="dark"] .wf-nav-panel__hint{color:#94a3b8}

.mini3dgta-fs-bottom-stack{width:min(calc(100% - 20px),420px);max-width:none;left:50%;right:auto;transform:translateX(-50%);bottom:max(10px,env(safe-area-inset-bottom,10px));display:flex;flex-direction:column;align-items:stretch;gap:8px}

/* Zoom sits directly above the bottom panel (right-aligned, no overlap) */
.wf-map-controls{position:static;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;flex:0 0 auto;align-self:flex-end}
.wf-map-controls__zoom{display:flex;flex-direction:column;align-items:stretch;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.08);box-shadow:0 4px 16px rgba(15,23,42,.1);backdrop-filter:saturate(140%) blur(14px);-webkit-backdrop-filter:saturate(140%) blur(14px);pointer-events:auto}
.wf-map-controls__btn{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border:none;background:transparent;color:#334155;font-size:20px;line-height:1;cursor:pointer;padding:0;touch-action:manipulation}
.wf-map-controls__btn:hover{background:${NAVME_UI_BLUE_SOFT};color:${NAVME_UI_BLUE}}
.wf-map-controls__btn:active{background:${NAVME_UI_BLUE_SOFT}}
.wf-map-controls__btn + .wf-map-controls__btn{border-top:1px solid rgba(15,23,42,.08)}
.wf-map-controls__loc{width:40px;height:40px;border-radius:50%;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.96);color:${NAVME_UI_BLUE};cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(15,23,42,.1);backdrop-filter:saturate(140%) blur(14px);-webkit-backdrop-filter:saturate(140%) blur(14px);pointer-events:auto;touch-action:manipulation}
.wf-map-controls__loc:hover{background:${NAVME_UI_BLUE_SOFT}}
.wf-map-controls__loc svg{width:19px;height:19px;display:block}

/* 2D/3D toggle — top-right, separate from bottom panel */
.mini3dgta-fs-map > .mini3dgta-fs-view3d{display:none!important}

/* Directions card From/To rows with coloured indicator dots */
.mini3dgta-fs-dock-field__label--from,.mini3dgta-fs-dock-field__label--to{display:inline-flex;align-items:center;gap:6px;color:#64748b}
.mini3dgta-fs-dock-field__label--from::before,.mini3dgta-fs-dock-field__label--to::before{content:"";width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.mini3dgta-fs-dock-field__label--from::before{background:${EXPOFP_START_BLUE}}
.mini3dgta-fs-dock-field__label--to::before{background:${EXPOFP_DEST_ORANGE}}

.mini3dgta-nearby-rail{display:none!important}

/* Loading/status toast */
.mini3dgta-status{left:50%;right:auto;transform:translateX(-50%);top:max(14px,env(safe-area-inset-top,0px));width:auto;max-width:min(80vw,340px);text-align:center}

@media (max-width:400px){.wf-nav-panel .mini3dgta-fs-dock-routes{flex-direction:row}}
`;
  const existing = document.getElementById('mini3dgta-ui-styles');
  if (existing) {
    existing.textContent = css;
    return;
  }
  const s = document.createElement('style');
  s.id = 'mini3dgta-ui-styles';
  s.textContent = css;
  document.head.appendChild(s);
}

function mkDockField(
  labelKey: NavmeStringKey,
  labelClass: string,
  selectClass: string,
  fieldClass = '',
): { wrap: HTMLDivElement; sel: HTMLSelectElement; refreshLabel: () => void } {
  const wrap = document.createElement('div');
  wrap.className = 'mini3dgta-fs-dock-field' + (fieldClass ? ' ' + fieldClass : '');
  const lbl = document.createElement('span');
  lbl.className = 'mini3dgta-fs-dock-field__label ' + labelClass;
  const refreshLabel = () => {
    lbl.textContent = t(labelKey);
  };
  refreshLabel();
  const sel = document.createElement('select');
  sel.className = 'mini3dgta-fs-select ' + selectClass;
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return { wrap, sel, refreshLabel };
}

type EndpointOption = { id: string; label: string; group: 'zone' | 'poi' };

type EndpointSearchField = {
  wrap: HTMLDivElement;
  getValue(): string;
  setValue(id: string, labelOverride?: string): void;
  setPlaceholder(placeholder: string): void;
  setOptions(options: EndpointOption[], placeholder: string, excludeId?: string): void;
  onPick(handler: () => void): void;
  onClear(handler: () => void): void;
  refreshLabels(): void;
};

type EndpointPickerSheet = {
  root: HTMLElement;
  open(opts: {
    title: string;
    hint?: string;
    options?: EndpointOption[];
    nearby?: { poi: NavMapPoi; dist: number }[];
    pickMode: 'single' | 'from-to' | 'nearby';
    onPick: (id: string, label: string, role?: 'from' | 'to') => void;
  }): void;
  close(): void;
};

function createEndpointPickerSheet(parent: HTMLElement): EndpointPickerSheet {
  const root = document.createElement('div');
  root.className = 'mini3dgta-fs-picker-sheet';
  root.hidden = true;

  const backdrop = document.createElement('div');
  backdrop.className = 'mini3dgta-fs-picker-sheet__backdrop';

  const panel = document.createElement('div');
  panel.className = 'mini3dgta-fs-picker-sheet__panel';

  const header = document.createElement('div');
  header.className = 'mini3dgta-fs-picker-sheet__header';
  const titleEl = document.createElement('span');
  titleEl.className = 'mini3dgta-fs-picker-sheet__title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mini3dgta-fs-picker-sheet__close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', t('close'));
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mini3dgta-fs-picker-sheet__search';
  search.autocomplete = 'off';
  search.inputMode = 'search';
  search.setAttribute('enterkeyhint', 'search');

  const hint = document.createElement('p');
  hint.className = 'mini3dgta-fs-picker-sheet__hint';

  const list = document.createElement('div');
  list.className = 'mini3dgta-fs-picker-sheet__list';

  panel.appendChild(header);
  panel.appendChild(search);
  panel.appendChild(hint);
  panel.appendChild(list);
  root.appendChild(backdrop);
  root.appendChild(panel);
  parent.appendChild(root);

  let onPickCb: ((id: string, label: string, role?: 'from' | 'to') => void) | null = null;
  let pickMode: 'single' | 'from-to' | 'nearby' = 'single';
  let options: EndpointOption[] = [];
  let nearby: { poi: NavMapPoi; dist: number }[] = [];

  const close = () => {
    root.hidden = true;
    onPickCb = null;
    search.value = '';
    list.innerHTML = '';
  };

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);

  const renderList = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();

    if (nearby.length > 0 && (pickMode === 'from-to' || pickMode === 'nearby')) {
      const rows = nearby.filter((n) => poiMatchesQuery(n.poi, q));
      if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'mini3dgta-fs-picker-sheet__hint';
        empty.textContent = t('noNearbyPlaces');
        list.appendChild(empty);
        return;
      }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (pickMode === 'nearby') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'mini3dgta-fs-picker-sheet__row';
          const name = document.createElement('span');
          name.className = 'mini3dgta-fs-picker-sheet__row-name';
          name.textContent = row.poi.name;
          const meta = document.createElement('span');
          meta.className = 'mini3dgta-fs-picker-sheet__row-meta';
          meta.textContent = row.dist < 1 ? '<1m' : `${row.dist.toFixed(0)}m`;
          btn.appendChild(name);
          btn.appendChild(meta);
          btn.addEventListener('click', () => {
            onPickCb?.(row.poi.id, row.poi.name);
            close();
          });
          list.appendChild(btn);
          continue;
        }
        const btn = document.createElement('div');
        btn.className = 'mini3dgta-fs-picker-sheet__row';
        const name = document.createElement('span');
        name.className = 'mini3dgta-fs-picker-sheet__row-name';
        name.textContent = row.poi.name;
        const meta = document.createElement('span');
        meta.className = 'mini3dgta-fs-picker-sheet__row-meta';
        meta.textContent = row.dist < 1 ? '<1m' : `${row.dist.toFixed(0)}m`;
        const actions = document.createElement('div');
        actions.className = 'mini3dgta-fs-picker-sheet__row-actions';
        const fromBtn = document.createElement('button');
        fromBtn.type = 'button';
        fromBtn.className = 'mini3dgta-fs-picker-sheet__chip mini3dgta-fs-picker-sheet__chip--from';
        fromBtn.textContent = t('from');
        fromBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          onPickCb?.(row.poi.id, row.poi.name, 'from');
          close();
        });
        const toBtn = document.createElement('button');
        toBtn.type = 'button';
        toBtn.className = 'mini3dgta-fs-picker-sheet__chip mini3dgta-fs-picker-sheet__chip--to';
        toBtn.textContent = t('to');
        toBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          onPickCb?.(row.poi.id, row.poi.name, 'to');
          close();
        });
        actions.appendChild(fromBtn);
        actions.appendChild(toBtn);
        btn.appendChild(name);
        btn.appendChild(meta);
        btn.appendChild(actions);
        list.appendChild(btn);
      }
      return;
    }

    const matches = options.filter((o) => endpointMatchesQuery(o.label, q));
    matches.sort((a, b) => {
      if (a.group !== b.group) return a.group === 'zone' ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    const limit = Math.min(matches.length, 48);
    for (let i = 0; i < limit; i++) {
      const opt = matches[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini3dgta-fs-picker-sheet__row';
      const name = document.createElement('span');
      name.className = 'mini3dgta-fs-picker-sheet__row-name';
      name.textContent = opt.label;
      btn.appendChild(name);
      if (opt.group !== 'zone') {
        const meta = document.createElement('span');
        meta.className = 'mini3dgta-fs-picker-sheet__row-meta';
        meta.textContent = 'Place';
        btn.appendChild(meta);
      }
      btn.addEventListener('click', () => {
        onPickCb?.(opt.id, opt.label);
        close();
      });
      list.appendChild(btn);
    }
    if (limit === 0) {
      const empty = document.createElement('p');
      empty.className = 'mini3dgta-fs-picker-sheet__hint';
      empty.textContent = t('noMatches');
      list.appendChild(empty);
    }
  };

  search.addEventListener('input', renderList);

  return {
    root,
    open(opts) {
      onPickCb = opts.onPick;
      pickMode = opts.pickMode;
      options = opts.options ?? [];
      nearby = opts.nearby ?? [];
      titleEl.textContent = opts.title;
      hint.textContent = opts.hint ?? '';
      hint.style.display = opts.hint ? '' : 'none';
      search.value = '';
      search.placeholder =
        pickMode === 'from-to' || pickMode === 'nearby'
          ? t('filterNearbyPlaceholder')
          : t('searchPlacesPlaceholder');
      root.hidden = false;
      renderList();
      window.setTimeout(() => search.focus(), 50);
    },
    close,
  };
}

function mkSearchEndpointField(
  labelKey: NavmeStringKey,
  labelClass: string,
  inputClass: string,
  picker: EndpointPickerSheet,
  fieldClass = '',
  resolveOptions?: () => EndpointOption[],
): EndpointSearchField {
  const wrap = document.createElement('div');
  wrap.className = 'mini3dgta-fs-dock-field' + (fieldClass ? ' ' + fieldClass : '');
  const lbl = document.createElement('span');
  lbl.className = 'mini3dgta-fs-dock-field__label ' + labelClass;

  const box = document.createElement('div');
  box.className = 'mini3dgta-fs-search-box';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'mini3dgta-fs-search-input ' + inputClass;
  input.autocomplete = 'off';
  input.readOnly = true;
  input.inputMode = 'search';
  input.setAttribute('enterkeyhint', 'search');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'mini3dgta-fs-search-clear';
  clearBtn.textContent = '✕';
  clearBtn.hidden = true;

  const refreshLabels = () => {
    lbl.textContent = t(labelKey);
    clearBtn.setAttribute('aria-label', t('clearLabel', { label: t(labelKey) }));
  };
  refreshLabels();

  box.appendChild(input);
  box.appendChild(clearBtn);
  wrap.appendChild(lbl);
  wrap.appendChild(box);

  let selectedId = '';
  let allOptions: EndpointOption[] = [];
  let placeholder = t('searchPlaceholder');
  let pickHandler: (() => void) | null = null;
  let clearHandler: (() => void) | null = null;

  const syncClearBtn = () => {
    clearBtn.hidden = !selectedId;
  };

  const openPicker = () => {
    picker.close();
    picker.open({
      title: t('selectLabel', { label: t(labelKey) }),
      options: resolveOptions ? resolveOptions() : allOptions,
      pickMode: 'single',
      onPick: (id, label) => {
        selectedId = id;
        input.value = label;
        pickHandler?.();
      },
    });
  };

  input.addEventListener('click', (e) => {
    e.preventDefault();
    openPicker();
  });

  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectedId = '';
    input.value = '';
    input.placeholder = placeholder;
    syncClearBtn();
    clearHandler?.();
  });

  return {
    wrap,
    getValue: () => selectedId,
    setValue(id: string, labelOverride?: string) {
      selectedId = id;
      const hit = labelOverride ?? allOptions.find((o) => o.id === id)?.label ?? '';
      input.value = hit;
      if (!id) input.placeholder = placeholder;
      syncClearBtn();
    },
    setPlaceholder(ph: string) {
      placeholder = ph;
      if (!selectedId) input.placeholder = ph;
    },
    setOptions(options, ph, excludeId) {
      placeholder = ph;
      input.placeholder = ph;
      allOptions = options.filter((o) => o.id !== excludeId);
      if (selectedId && !allOptions.some((o) => o.id === selectedId)) {
        selectedId = '';
        input.value = '';
      } else if (selectedId) {
        const hit = allOptions.find((o) => o.id === selectedId);
        if (hit) input.value = hit.label;
      }
    },
    onPick(handler) {
      pickHandler = handler;
    },
    onClear(handler) {
      clearHandler = handler;
    },
    refreshLabels,
  };
}

export function setMini3dGtaMapToggleOpen(btn: HTMLButtonElement, open: boolean): void {
  btn.classList.toggle('mini3dgta-map-toggle--open', open);
  if (!open) applyMapToggleIcon(btn);
}

function applyMapToggleIcon(btn: HTMLButtonElement): void {
  btn.classList.remove('mini3dgta-map-toggle--open');
  btn.setAttribute('aria-label', t('openMapAria'));
  btn.innerHTML =
    MAP_TOGGLE_ICON_SVG +
    '<span class="mini3dgta-map-toggle__label mini3dgta-map-toggle__label--scan">' +
    t('map3d') +
    '</span>' +
    '<span class="mini3dgta-map-toggle__label mini3dgta-map-toggle__label--nav">' +
    t('navigationIn3d') +
    '</span>';
}

/** Keep the AR map button labels in sync when the user switches language. */
onNavmeLanguageChange(() => {
  const dock = document.getElementById(MAP_TOGGLE_DOCK_ID);
  const btn = dock?.querySelector('button.mini3dgta-map-toggle');
  if (btn instanceof HTMLButtonElement && !btn.classList.contains('mini3dgta-map-toggle--open')) {
    applyMapToggleIcon(btn);
  }
});

export interface Mini3dGtaMapButtonHandlers {
  onOpen: () => void;
  onClose: () => void;
}

/** 2D/3D map toggle — becomes ✕ while the map is open (see {@link Mini3dGtaEmbed}). */
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
  applyMapToggleIcon(btn);
  btn.addEventListener('click', () => {
    if (btn.classList.contains('mini3dgta-map-toggle--open')) handlers.onClose();
    else handlers.onOpen();
  });
  mountToNavMapToggleFloat(btn);
  return btn;
}

// ——— App bootstrap ———
export interface GtaConfig {
  defaultMapCode: string;
}

const DEFAULT_GTA: GtaConfig = {
  defaultMapCode: 'MAP_D43LZMMLU6BJ',
};

export interface Mini3dGtaMountOptions extends Partial<GtaConfig> {
  deferLoadUntilMapOpen?: boolean;
  suppressMapToggle?: boolean;
  /** Open fullscreen map as soon as floor data is ready (standalone viewer). */
  autoOpenFullscreen?: boolean;
  /** Hide the “Navigate in AR” control (closes map back to camera). */
  hideNavigateInAr?: boolean;
  /** POI type text field + refresh button (standalone / mobile). Off by default. */
  showPoiTypeField?: boolean;
  /** POI type / tenant to load automatically (defaults to NAVME_CONFIG.tenant from behaviors.ts). */
  poiType?: string;
  /** Sync external logo / ✕ button when fullscreen opens or closes. */
  onFullscreenChange?: (open: boolean) => void;
  /** When set, this button is kept visible as ✕ while the map is open. */
  externalMapToggle?: HTMLButtonElement;
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
  getRouteState(): Mini3dGtaRouteState | null;
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

function nearestPoisAt(
  x: number,
  z: number,
  pois: NavMapPoi[],
  limit = 10,
  maxDist = 35,
  spatial?: PoiSpatialGrid | null,
): { poi: NavMapPoi; dist: number }[] {
  if (spatial) return spatial.query(x, z, maxDist, limit);
  const out: { poi: NavMapPoi; dist: number }[] = [];
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    const dist = Math.hypot(p.x - x, p.z - z);
    if (dist <= maxDist) out.push({ poi: p, dist });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, limit);
}

function findPoiIdByPosition(pois: NavMapPoi[], x: number, y: number, z: number): string {
  const tol = 0.15;
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    if (Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol && Math.abs(p.z - z) < tol) {
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
  const autoOpenFullscreen = options.autoOpenFullscreen === true;
  const hideNavigateInAr = options.hideNavigateInAr === true;
  // POI selector removed — the POI type now loads automatically (see main.ts / behaviors.ts).
  const showPoiTypeField = options.showPoiTypeField === true;
  const navigationBridge = options.navigationBridge ?? null;
  /** Defer Supabase + map build until the user opens the fullscreen map (saves startup CPU/GPU). */
  const deferLoad = options.deferLoadUntilMapOpen !== false;

  injectMini3dGtaUiStyles();

  let activePoiType = (options.poiType ?? NAVME_CONFIG.tenant).trim() || NAVME_CONFIG.tenant;
  let reloadSeq = 0;

  let mapView: ViewOnly2DMap | null = null;
  let pois: NavMapPoi[] = [];
  let floorSliceY = -1.6;
  let savedPayload: NavmeFloorEditPayload | null = null;
  let currentPath: { x: number; y: number; z: number }[] = [];
  let currentZones: FloorBlock[] = [];
  let currentFloors: FloorLevel[] = [];
  let projectLoaded = false;
  let mapUiOpen = false;
  let pendingOrigin: { x: number; y: number; z: number } | null = null;
  let pendingDestination: { x: number; y: number; z: number } | null = null;
  let pendingRouteEndpoints: { originId: string; destId: string } | null = null;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const toggle = document.createElement('button');
  toggle.className = 'mini3dgta-map-toggle';
  toggle.type = 'button';
  if (!suppressMapToggle) {
    applyMapToggleIcon(toggle);
  }

  const overlay = document.createElement('div');
  overlay.className = 'mini3dgta-fs-overlay';

  const endpointPicker = createEndpointPickerSheet(overlay);

  let originField!: EndpointSearchField;
  let destField!: EndpointSearchField;

  originField = mkSearchEndpointField(
    'from',
    'mini3dgta-fs-dock-field__label--from',
    'mini3dgta-fs-search-input--origin',
    endpointPicker,
    '',
    () => buildEndpointOptions(destField.getValue()),
  );
  destField = mkSearchEndpointField(
    'to',
    'mini3dgta-fs-dock-field__label--to',
    'mini3dgta-fs-search-input--dest',
    endpointPicker,
    '',
    () => buildEndpointOptions(originField.getValue()),
  );
  const floorField = mkDockField(
    'floor',
    'mini3dgta-fs-dock-field__label--floor',
    'mini3dgta-fs-select--floor',
    'mini3dgta-fs-dock-field--floor',
  );

  // NavMe logo (left) + brand name + floor selector (right).
  const dockLogo = document.createElement('div');
  dockLogo.className = 'mini3dgta-fs-dock-logo';
  const logoImg = document.createElement('img');
  logoImg.src = NAVME_LOGO_URL;
  logoImg.alt = 'NavMe';
  logoImg.draggable = false;
  dockLogo.appendChild(logoImg);

  const dockBrand = document.createElement('div');
  dockBrand.className = 'mini3dgta-fs-dock-brand';
  dockBrand.textContent = NAVME_BRAND_NAME;

  const view3dBtn = document.createElement('button');
  view3dBtn.type = 'button';
  view3dBtn.className = 'mini3dgta-fs-view3d';
  view3dBtn.textContent = t('view3d');
  view3dBtn.title = t('switchTo2dView');
  view3dBtn.style.display = 'none';

  const view2dLockBtn = document.createElement('button');
  view2dLockBtn.type = 'button';
  view2dLockBtn.className = 'mini3dgta-fs-view2d-lock';
  view2dLockBtn.textContent = t('view2dLock');
  view2dLockBtn.title = t('lockTopDownView');
  view2dLockBtn.setAttribute('aria-pressed', 'false');
  view2dLockBtn.setAttribute('aria-label', t('lockTopDownView'));

  const syncView2dLockBtn = () => {
    const on = mapView?.isTopDownView() ?? false;
    view2dLockBtn.classList.toggle('mini3dgta-fs-view2d-lock--active', on);
    view2dLockBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    view2dLockBtn.title = on ? t('unlockTopDownView') : t('lockTopDownView');
    view2dLockBtn.setAttribute('aria-label', on ? t('unlockTopDownView') : t('lockTopDownView'));
  };
  view2dLockBtn.onclick = () => {
    if (!mapView) return;
    mapView.toggleTopDownView();
    syncView2dLockBtn();
  };

  const dockRoutes = document.createElement('div');
  dockRoutes.className = 'mini3dgta-fs-dock-routes';
  dockRoutes.appendChild(originField.wrap);

  const navigateBtn = document.createElement('button');
  navigateBtn.type = 'button';
  navigateBtn.className = 'mini3dgta-fs-navigate-btn';
  navigateBtn.textContent = t('navigate');
  navigateBtn.disabled = true;
  dockRoutes.appendChild(navigateBtn);
  dockRoutes.appendChild(destField.wrap);
  destField.wrap.hidden = true;

  const mapTapHint = document.createElement('p');
  mapTapHint.className = 'wf-nav-panel__hint';
  mapTapHint.textContent = t('mapTapPoiHintFrom');

  const navPanel = document.createElement('div');
  navPanel.className = 'wf-nav-panel';
  const navPanelHeader = document.createElement('div');
  navPanelHeader.className = 'wf-nav-panel__header';
  navPanelHeader.appendChild(dockLogo);
  navPanelHeader.appendChild(dockBrand);
  navPanelHeader.appendChild(floorField.wrap);
  navPanel.appendChild(navPanelHeader);
  navPanel.appendChild(dockRoutes);
  navPanel.appendChild(mapTapHint);

  const navArBtn = document.createElement('button');
  navArBtn.type = 'button';
  navArBtn.className = 'mini3dgta-fs-nav-ar-btn';
  const navArLabel = document.createElement('span');
  const refreshNavArBtn = () => {
    navArBtn.setAttribute('aria-label', t('viewInAr'));
    navArLabel.textContent = t('viewInAr');
  };
  refreshNavArBtn();
  navArBtn.innerHTML = NAV_AR_ICON_SVG;
  navArBtn.appendChild(navArLabel);

  const bottomStack = document.createElement('div');
  bottomStack.className = 'mini3dgta-fs-bottom-stack';
  if (hideNavigateInAr) navArBtn.style.display = 'none';

  const projectBar = document.createElement('div');
  projectBar.className = 'mini3dgta-project-bar';
  projectBar.hidden = !showPoiTypeField;
  const projectLabel = document.createElement('span');
  projectLabel.className = 'mini3dgta-project-bar__label';
  projectLabel.textContent = t('poiType');
  const poiTypeSelect = document.createElement('select');
  poiTypeSelect.className = 'mini3dgta-project-bar__select';
  const projectRefreshBtn = document.createElement('button');
  projectRefreshBtn.type = 'button';
  projectRefreshBtn.className = 'mini3dgta-project-bar__refresh';
  projectRefreshBtn.textContent = t('refresh');
  projectBar.appendChild(projectLabel);
  projectBar.appendChild(poiTypeSelect);
  projectBar.appendChild(projectRefreshBtn);

  function getSelectedPoiType(): string {
    return poiTypeSelect.value.trim();
  }

  async function refreshPoiTypeOptions(): Promise<void> {
    const prev = getSelectedPoiType() || activePoiType;
    poiTypeSelect.disabled = true;
    projectRefreshBtn.disabled = true;
    clearSelectOptions(poiTypeSelect);

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('choosePoiType');
    poiTypeSelect.appendChild(placeholder);

    const types = await fetchNavmeLoginTypes();
    for (let i = 0; i < types.length; i++) {
      const opt = document.createElement('option');
      opt.value = types[i];
      opt.textContent = types[i];
      poiTypeSelect.appendChild(opt);
    }

    if (types.length === 0) {
      placeholder.textContent = t('noProjects');
      poiTypeSelect.disabled = true;
      return;
    }

    const hit = types.find((label) => label.toLowerCase() === prev.toLowerCase());
    poiTypeSelect.value = hit ?? types[0];
    poiTypeSelect.disabled = false;
    projectRefreshBtn.disabled = false;
  }

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
  const statusMessage = document.createElement('p');
  statusMessage.className = 'mini3dgta-status__message';
  status.appendChild(statusPhase);
  status.appendChild(statusMessage);
  status.style.display = 'none';

  // ── Single navigation panel (floor + from/to + 2D/3D) ──
  const mapControls = document.createElement('div');
  mapControls.className = 'wf-map-controls';
  const zoomStack = document.createElement('div');
  zoomStack.className = 'wf-map-controls__zoom';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.className = 'wf-map-controls__btn';
  zoomInBtn.textContent = '+';
  zoomInBtn.setAttribute('aria-label', 'Zoom in');
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.className = 'wf-map-controls__btn';
  zoomOutBtn.textContent = '−';
  zoomOutBtn.setAttribute('aria-label', 'Zoom out');
  zoomStack.appendChild(zoomInBtn);
  zoomStack.appendChild(zoomOutBtn);
  const recenterBtn = document.createElement('button');
  recenterBtn.type = 'button';
  recenterBtn.className = 'wf-map-controls__loc';
  recenterBtn.setAttribute('aria-label', 'Re-center map');
  recenterBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  mapControls.appendChild(zoomStack);
  mapControls.appendChild(recenterBtn);
  zoomInBtn.onclick = () => mapView?.zoomMap(0.82);
  zoomOutBtn.onclick = () => mapView?.zoomMap(1.22);
  recenterBtn.onclick = () => mapView?.recenterMap();

  bottomStack.appendChild(mapControls);
  bottomStack.appendChild(navPanel);

  mountRoot.appendChild(view3dBtn);
  view3dBtn.style.display = 'none';
  mountRoot.appendChild(view2dLockBtn);
  mountRoot.appendChild(navArBtn);
  mountRoot.appendChild(status);
  mountRoot.appendChild(bottomStack);

  overlay.appendChild(fsBody);
  initWayfinderTheme();

  if (!suppressMapToggle) {
    mountToNavMapToggleFloat(toggle);
    document.body.appendChild(overlay);
  } else if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(overlay);
  }

  let lastStatusLevel: 'loading' | 'done' | 'error' = 'loading';

  const setStatus = (msg: string, level: 'loading' | 'done' | 'error' = 'loading') => {
    // Hide the Wayfinder progress banner (e.g. "Analyzing rooms…") — keep errors only.
    if (level !== 'error') {
      status.style.display = 'none';
      if (level === 'done') lastStatusLevel = 'done';
      return;
    }
    lastStatusLevel = level;
    statusMessage.textContent = msg;
    status.style.display = msg ? 'block' : 'none';
    statusPhase.className = 'mini3dgta-status__phase mini3dgta-status__phase--error';
    statusPhase.textContent = t('statusError');
  };

  function syncView3dButtonVisibility(): void {
    view3dBtn.style.display = 'none';
  }

  function ensureSingleFloor3dDefault(): void {
    if (!mapView) return;
    if (!mapView.isSingleFloorView()) return;
    if (mapView.isIso3d()) mapView.warmResume3d();
    else mapView.setIso3d(true);
  }

  function resumeMapAfterOpen(): void {
    if (!mapView || !projectLoaded) return;
    ensureSingleFloor3dDefault();
    syncMapImmersive();
  }

  const scheduleRebuildRoute = rafCoalesce(() => {
    rebuildRoute();
  });

  /** Navigation line only appears after destination is chosen via a map POI tap. */
  let navRouteVisible = false;
  /** When false, only the From field is shown until the user taps Navigate. */
  let destPickActive = false;

  function refreshDestPickUi(): void {
    const hasFrom = Boolean(originField.getValue());
    const hasTo = Boolean(destField.getValue());
    if (hasTo) destPickActive = true;
    if (destPickActive) {
      destField.wrap.hidden = false;
      navigateBtn.hidden = true;
    } else {
      destField.wrap.hidden = true;
      navigateBtn.hidden = false;
    }
    navigateBtn.disabled = !hasFrom;
    refreshMapTapHint();
  }

  function refreshFloorSelect(): void {
    const prev = floorField.sel.value;
    clearSelectOptions(floorField.sel);
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = currentFloors.length ? t('chooseFloor') : t('noFloors');
    floorField.sel.appendChild(o0);
    const tops = topLevelFloors(currentFloors);
    const showViewAll = tops.length >= 2 && Boolean(mapView?.isIso3d());
    if (showViewAll) {
      const viewAll = document.createElement('option');
      viewAll.value = '__view_all__';
      viewAll.textContent = t('viewAllFloors');
      floorField.sel.appendChild(viewAll);
    }
    for (let i = 0; i < tops.length; i++) {
      const top = tops[i];
      const subs = subfloorsOf(currentFloors, top.id);
      const parentName = floorDisplayLabel(top, i);
      const appendOption = (floor: FloorLevel, label: string, target: HTMLElement) => {
        const o = document.createElement('option');
        o.value = floor.id;
        o.textContent = label;
        target.appendChild(o);
      };
      if (subs.length === 0) {
        appendOption(top, parentName, floorField.sel);
        continue;
      }
      const group = document.createElement('optgroup');
      group.label = parentName;
      appendOption(top, parentName, group);
      for (let s = 0; s < subs.length; s++) {
        appendOption(subs[s], floorDisplayLabel(subs[s], s, parentName), group);
      }
      floorField.sel.appendChild(group);
    }
    if (mapView?.isViewStack() && showViewAll) {
      floorField.sel.value = '__view_all__';
    } else {
      const activeId = mapView?.getActiveFloorId() ?? null;
      if (activeId && floorField.sel.querySelector('option[value="' + activeId + '"]')) {
        floorField.sel.value = activeId;
      } else if (prev && prev !== '__view_all__' && floorField.sel.querySelector('option[value="' + prev + '"]')) {
        floorField.sel.value = prev;
      }
    }
    syncView3dButtonVisibility();
  }

  function poisForRouteUi(): NavMapPoi[] {
    if (!mapView || mapView.isViewStack()) return pois;
    const activeFloorId = mapView.getActiveFloorId();
    if (!activeFloorId || currentFloors.length <= 1) return pois;
    const family = floorFamily(currentFloors, activeFloorId);
    if (family.length <= 1) {
      const floor = family[0] ?? currentFloors.find((f) => f.id === activeFloorId);
      if (!floor) return pois;
      return filterPoisByFloorY(pois, floor.floorY, currentFloors);
    }
    const seen = new Set<string>();
    const out: NavMapPoi[] = [];
    for (let fi = 0; fi < family.length; fi++) {
      const part = filterPoisByFloorY(pois, family[fi].floorY, currentFloors);
      for (let pi = 0; pi < part.length; pi++) {
        if (seen.has(part[pi].id)) continue;
        seen.add(part[pi].id);
        out.push(part[pi]);
      }
    }
    return out;
  }

  let loadProjectPromise: Promise<void> | null = null;
  function ensureProjectLoaded(): Promise<void> {
    if (projectLoaded) return Promise.resolve();
    if (deferLoad && !mapUiOpen) return Promise.resolve();
    if (!loadProjectPromise) loadProjectPromise = loadProject();
    return loadProjectPromise;
  }

  function applyPendingRouteEndpoints(): void {
    if (pendingOrigin) {
      const id = findPoiIdByPosition(pois, pendingOrigin.x, pendingOrigin.y, pendingOrigin.z);
      if (id) originField.setValue(id);
      pendingOrigin = null;
    }
    if (pendingDestination) {
      const id = findPoiIdByPosition(pois, pendingDestination.x, pendingDestination.y, pendingDestination.z);
      if (id) destField.setValue(id);
      pendingDestination = null;
    }
    if (pendingRouteEndpoints) {
      if (pendingRouteEndpoints.originId) originField.setValue(pendingRouteEndpoints.originId);
      if (pendingRouteEndpoints.destId) destField.setValue(pendingRouteEndpoints.destId);
      if (pendingRouteEndpoints.destId) destPickActive = true;
      pendingRouteEndpoints = null;
    }
    refreshEndpointFields();
    refreshDestPickUi();
    scheduleRebuildRoute();
  }

  function floorsForZoneSearch(): FloorLevel[] {
    if (!mapView || currentFloors.length <= 1) return currentFloors;
    if (mapView.isViewStack()) return currentFloors;
    const activeFloorId = mapView.getActiveFloorId();
    if (!activeFloorId) return currentFloors;
    return floorFamily(currentFloors, activeFloorId);
  }

  function buildEndpointOptions(excludeId?: string): EndpointOption[] {
    const opts: EndpointOption[] = [];
    const seen = new Set<string>();
    const activeFloorId = mapView?.getActiveFloorId() ?? null;
    const viewAll = mapView?.isViewStack() ?? false;
    const multiFloor = viewAll && currentFloors.length > 1;
    const floors = floorsForZoneSearch();
    for (let fi = 0; fi < floors.length; fi++) {
      const floor = floors[fi];
      const floorIndex = currentFloors.findIndex((f) => f.id === floor.id);
      const zones = zonesForFloorLevel(floor, activeFloorId, currentZones);
      for (let zi = 0; zi < zones.length; zi++) {
        const zone = zones[zi];
        const zoneRouteId = ZONE_ROUTE_PREFIX + zone.id;
        if (excludeId && zoneRouteId === excludeId) continue;
        if (seen.has(zoneRouteId)) continue;
        seen.add(zoneRouteId);
        const label = zone.label?.trim();
        if (!label) continue;
        opts.push({
          id: zoneRouteId,
          label: zoneEndpointLabel(zone, floor, Math.max(0, floorIndex), multiFloor),
          group: 'zone',
        });
      }
    }
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }

  let routePoiSpatial: PoiSpatialGrid | null = null;
  let routePoiSpatialKey = '';

  function rebuildRoutePoiSpatial(): void {
    const routePois = poisForRouteUi();
    const floorKey = mapView?.getActiveFloorId() ?? 'all';
    const key = `${floorKey}|${routePois.length}`;
    if (key === routePoiSpatialKey && routePoiSpatial) return;
    routePoiSpatialKey = key;
    routePoiSpatial = routePois.length > 20 ? new PoiSpatialGrid(routePois) : null;
  }

  function syncMapEndpointMarkers(): void {
    if (!mapView) return;
    mapView.setPois(pois, originField.getValue(), destField.getValue());
  }

  const scheduleRefreshEndpointFields = rafCoalesce(() => {
    refreshEndpointFieldsNow();
  });

  function refreshEndpointFields(): void {
    scheduleRefreshEndpointFields();
  }

  function resolveRouteUiLabel(id: string): string {
    if (!id || !isZoneRouteId(id)) return '';
    const zid = id.slice(ZONE_ROUTE_PREFIX.length);
    const activeFloorId = mapView?.getActiveFloorId() ?? null;
    const hit = findZoneInFloors(zid, currentFloors, activeFloorId, currentZones);
    if (!hit) return 'Zone';
    const floorIndex = currentFloors.findIndex((f) => f.id === hit.floor.id);
    return zoneEndpointLabel(hit.zone, hit.floor, Math.max(0, floorIndex), currentFloors.length > 1);
  }

  function zoneRouteFloorId(routeId: string): string | null {
    if (!isZoneRouteId(routeId)) return null;
    const zid = routeId.slice(ZONE_ROUTE_PREFIX.length);
    const activeFloorId = mapView?.getActiveFloorId() ?? null;
    return findZoneInFloors(zid, currentFloors, activeFloorId, currentZones)?.floor.id ?? null;
  }

  function focusEndpointInView(id: string): void {
    if (!mapView || !id) return;
    const hasFrom = Boolean(originField.getValue());
    const hasTo = Boolean(destField.getValue());
    if (navRouteVisible && hasFrom && hasTo) {
      mapView.fitViewToEndpointsOrRoute();
      return;
    }
    if (isZoneRouteId(id)) {
      const targetFloorId = zoneRouteFloorId(id);
      if (
        targetFloorId &&
        targetFloorId !== mapView.getActiveFloorId() &&
        !mapView.isViewStack()
      ) {
        void applySavedFloorAsync(targetFloorId).then((ok) => {
          if (ok) mapView?.focusZoneByRouteId(id);
        });
        return;
      }
      mapView.focusZoneByRouteId(id);
      return;
    }
    const ep = mapView.resolveEndpoint(id, floorSliceY);
    if (ep) mapView.smoothZoomToWorldPoint(ep.x, ep.z);
  }

  function shouldRouteCameraFly(): boolean {
    return Boolean(originField.getValue() && destField.getValue());
  }

  function refreshMapTapHint(): void {
    const hasFrom = Boolean(originField.getValue());
    const hasTo = Boolean(destField.getValue());
    if (hasFrom && hasTo && navRouteVisible) {
      mapTapHint.style.display = 'none';
      return;
    }
    mapTapHint.style.display = '';
    if (!hasFrom) {
      mapTapHint.textContent = t('mapTapPoiHintFrom');
    } else if (!destPickActive) {
      mapTapHint.textContent = t('tapNavigateForDestination');
    } else {
      mapTapHint.textContent = t('mapTapPoiHintTo');
    }
  }

  function refreshEndpointFieldsNow(): void {
    const clearInvalidEndpoint = (get: () => string, clear: (id: string) => void) => {
      const value = get();
      if (value && !isZoneRouteId(value)) {
        clear('');
        return;
      }
      if (isZoneRouteId(value)) {
        const zid = value.slice(ZONE_ROUTE_PREFIX.length);
        const activeFloorId = mapView?.getActiveFloorId() ?? null;
        if (!findZoneInFloors(zid, currentFloors, activeFloorId, currentZones)) clear('');
      }
    };
    clearInvalidEndpoint(() => originField.getValue(), (id) => originField.setValue(id));
    clearInvalidEndpoint(() => destField.getValue(), (id) => destField.setValue(id));

    const destVal = destField.getValue();
    const originVal = originField.getValue();
    originField.setPlaceholder(t('searchFromPlaceholder'));
    destField.setPlaceholder(t('searchToPlaceholder'));
    originField.setValue(originVal, resolveRouteUiLabel(originVal));
    destField.setValue(destVal, resolveRouteUiLabel(destVal));
    rebuildRoutePoiSpatial();
    syncMapEndpointMarkers();
    refreshDestPickUi();
    refreshMapTapHint();
  }

  function fillEndpointSelects(): void {
    refreshEndpointFields();
  }

  function rebuildRoute(): void {
    if (deferLoad && !mapUiOpen) return;
    if (!mapView) {
      void ensureProjectLoaded().then(() => rebuildRoute());
      return;
    }
    const o = originField.getValue() ? mapView.resolveEndpoint(originField.getValue(), floorSliceY) : null;
    const d = destField.getValue() ? mapView.resolveEndpoint(destField.getValue(), floorSliceY) : null;
    if (!o || !d || !navRouteVisible) {
      mapView.setNavRouteVisible(false);
      mapView.clearNavigationRoute();
      currentPath = [];
      if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
      mapView.setPois(pois, originField.getValue(), destField.getValue());
      return;
    }

    const origin = o;
    const dest = d;
    requestAnimationFrame(() => {
      if (!mapView) return;
      const result = mapView.computeAndSetRoute(origin, dest);
      currentPath = mapView.getRoutePathPoints();

      if (navigationBridge) {
        if (currentPath.length >= 2) {
          applyWaypointsToNavigationRoute(navigationBridge, currentPath);
        } else {
          clearNavRouteWaypointPoints(navigationBridge);
        }
      }

      if (result.error) {
        setStatus(result.error, 'error');
      }
      mapView.setPois(pois, originField.getValue(), destField.getValue());
    });
  }

  function getTapPickPhase(): 'from' | 'to' {
    if (!originField.getValue()) return 'from';
    if (!destPickActive) return 'from';
    return 'to';
  }

  function assignTapEndpoint(id: string, role?: 'from' | 'to'): void {
    const phase = role ?? getTapPickPhase();
    const label = resolveRouteUiLabel(id) || 'Location';

    mapView?.setSelectedPoi(id);
    endpointPicker.close();

    if (phase === 'from') {
      navRouteVisible = false;
      mapView?.setNavRouteVisible(false);
      mapView?.clearNavigationRoute();
      if (destField.getValue() === id) destField.setValue('');
      originField.setValue(id, label);
      mapView?.clearTapNearby();
      syncMapEndpointMarkers();
      scheduleRefreshEndpointFields();
      refreshDestPickUi();
      focusEndpointInView(id);
      return;
    }

    if (!destPickActive) return;
    if (originField.getValue() === id) return;
    navRouteVisible = true;
    mapView?.setNavRouteVisible(true);
    destField.setValue(id, label);
    mapView?.clearTapNearby();
    syncMapEndpointMarkers();
    scheduleRefreshEndpointFields();
    refreshDestPickUi();
    mapView?.setPreferSmoothCamera(true);
    scheduleRebuildRoute();
  }

  function applyTapPoiPick(id: string): void {
    requestAnimationFrame(() => {
      assignTapEndpoint(id);
    });
  }

  function openNearbyPoiPopup(
    worldX: number,
    worldZ: number,
    ranked: { poi: NavMapPoi; dist: number }[],
  ): void {
    const nearbyPois = ranked.map((r) => r.poi);
    // Map pins only — no bottom search/destination sheet.
    endpointPicker.close();
    mapView?.smoothZoomToWorldPoint(worldX, worldZ);
    mapView?.showTapNearby(worldX, worldZ, nearbyPois);
  }

  function syncMapImmersive(): void {
    if (typeof document === 'undefined') return;
    const immersive = mapUiOpen && Boolean(mapView?.isIso3d());
    document.body.classList.toggle('navme-map-immersive', immersive);
  }

  function handleMapTapAt(worldX: number, worldZ: number): void {
    const activeFloorId = mapView?.getActiveFloorId() ?? null;
    const searchFloors = mapView?.isViewStack() ? currentFloors : floorsForZoneSearch();
    if (searchFloors.length > 1) {
      for (let fi = searchFloors.length - 1; fi >= 0; fi--) {
        const floor = searchFloors[fi];
        const zones = zonesForFloorLevel(floor, activeFloorId, currentZones);
        const zoneHit = findZoneAtPoint(worldX, worldZ, zones);
        if (zoneHit) {
          assignTapEndpoint(ZONE_ROUTE_PREFIX + zoneHit.id);
          return;
        }
      }
    } else {
      const zoneHit = findZoneAtPoint(worldX, worldZ, currentZones);
      if (zoneHit) {
        assignTapEndpoint(ZONE_ROUTE_PREFIX + zoneHit.id);
        return;
      }
    }
    mapView?.clearTapNearby();
    endpointPicker.close();
    mapView?.smoothZoomToWorldPoint(worldX, worldZ);
  }

  async function applySavedFloorAsync(floorId: string | null): Promise<boolean> {
    if (!savedPayload) return false;
    const built = await buildMapFromSavedPayloadCachedAsync(savedPayload, floorId, (msg) =>
      setStatus(msg, 'loading'),
    );
    if ('error' in built) {
      setStatus(built.error, 'error');
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
    ensureSingleFloor3dDefault();
    mapView?.fitViewToMap();
    void mapView.ensureAllFloorPreviews();
    scheduleRebuildRoute();
    return true;
  }

  async function loadProject(): Promise<void> {
    const poiType = activePoiType;
    setStatus(t('loadingSavedFloorMap'), 'loading');
    const login = await fetchLoginByType(poiType);
    const mapCode = login?.map_code?.trim() || cfg.defaultMapCode?.trim() || '';
    if (!mapCode) {
      setStatus('', 'done');
      projectLoaded = true;
      resolveReady?.();
      resolveReady = null;
      return;
    }

    pois = await fetchPois(poiType);
    rebuildRoutePoiSpatial();
    const floorEdit = await fetchFloorEdit(poiType, mapCode);
    if (!floorEdit?.payload) {
      setStatus('', 'done');
      savedPayload = null;
      mapView?.setPath([]);
      currentPath = [];
      projectLoaded = true;
      resolveReady?.();
      resolveReady = null;
      return;
    }

    savedPayload = floorEdit.payload;
    floorSliceY = floorEdit.sliceY;
    clearFloorBuildCache();
    clearWalkGridCache();

    if (!mapView) {
      mapView = new ViewOnly2DMap(mountRoot);
      mapView.setMapTapHandler(handleMapTapAt);
      mapView.setTapPickHandler(applyTapPoiPick);
      mapView.setOnFloorSelect((floorId) => {
        void applySavedFloorAsync(floorId);
      });
      mapView.setOnFloorsChange(() => {
        refreshFloorSelect();
        syncView3dButtonVisibility();
      });
      mapView.setOnIso3dChange((on) => {
        overlay.classList.toggle('mini3dgta-fs-overlay--iso3d', on);
        view3dBtn.classList.toggle('mini3dgta-fs-view3d--active', on);
        view3dBtn.textContent = on ? t('view2d') : t('view3d');
        refreshFloorSelect();
        syncView3dButtonVisibility();
        syncView2dLockBtn();
        syncMapImmersive();
        if (!on) mapView?.fitViewToMap();
      });
    }

    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
    mapView.resize();

    const builtOk = await applySavedFloorAsync(null);
    if (!builtOk) return;

    applyPendingRouteEndpoints();
    fillEndpointSelects();
    refreshDestPickUi();
    ensureSingleFloor3dDefault();
    mapView?.fitViewToMap();
    projectLoaded = true;
    resolveReady?.();
    resolveReady = null;
    setStatus('', 'done');

    void preloadOtherFloorWalkGrids(savedPayload, mapView?.getActiveFloorId() ?? null);
  }

  async function reloadProject(refreshList = false): Promise<void> {
    if (refreshList) await refreshPoiTypeOptions();
    const want = getSelectedPoiType();
    if (!want) {
      setStatus(t('poiTypeRequired'), 'error');
      return;
    }
    activePoiType = want;
    reloadSeq++;
    const seq = reloadSeq;

    originField.setValue('');
    destField.setValue('');
    destPickActive = false;
    mapView?.clearTapNearby();
    mapView?.setPath([]);
    currentPath = [];
    currentZones = [];
    currentFloors = [];
    if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);

    clearFloorBuildCache();
    clearWalkGridCache();
    savedPayload = null;
    loadProjectPromise = null;
    projectLoaded = false;

    projectRefreshBtn.disabled = true;
    try {
      await loadProject();
      if (seq !== reloadSeq) return;
      fillEndpointSelects();
      if (mapUiOpen) resumeMapAfterOpen();
    } finally {
      if (seq === reloadSeq) projectRefreshBtn.disabled = false;
    }
  }

  const syncMapToggle = (open: boolean) => {
    if (options.externalMapToggle) {
      options.externalMapToggle.style.display = open ? 'none' : '';
      if (!open) setMini3dGtaMapToggleOpen(options.externalMapToggle, false);
    }
    if (!suppressMapToggle) setMini3dGtaMapToggleOpen(toggle, open);
    options.onFullscreenChange?.(open);
  };

  const setOpen = (open: boolean) => {
    mapUiOpen = open;
    overlay.style.display = open ? 'block' : 'none';
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('mini3dgta-fs-open', open);
    }
    syncMapToggle(open);

    if (open) {
      if (!NAVME_STANDALONE) setArExperiencePaused(true);
      mapView?.setRenderingPaused(false);
      void (async () => {
        if (!projectLoaded) await loadProject();
        else applyPendingRouteEndpoints();
        resumeMapAfterOpen();
      })();
      return;
    }

    mapView?.clearTapNearby();
    mapView?.setRenderingPaused(true);
    syncMapImmersive();
    if (!NAVME_STANDALONE) {
      requestAnimationFrame(() => {
        setArExperiencePaused(false);
      });
    }
  };

  navArBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openViewInArExperience();
  });

  if (!suppressMapToggle) {
    toggle.onclick = () => {
      if (toggle.classList.contains('mini3dgta-map-toggle--open')) setOpen(false);
      else setOpen(true);
    };
  }

  // 2D/3D toggle removed — map stays in 3D mode.
  projectRefreshBtn.addEventListener('click', () => {
    void reloadProject(true);
  });
  poiTypeSelect.addEventListener('change', () => {
    const want = getSelectedPoiType();
    if (!want || want.toLowerCase() === activePoiType.toLowerCase()) return;
    void reloadProject(false);
  });

  floorField.sel.addEventListener('change', () => {
    const floorId = floorField.sel.value;
    if (floorId === '__view_all__') {
      mapView?.activateViewAllFloors();
      fillEndpointSelects();
      syncView3dButtonVisibility();
      return;
    }
    if (floorId) {
      mapView?.leaveViewStack();
      void applySavedFloorAsync(floorId).then(() => {
        fillEndpointSelects();
        scheduleRebuildRoute();
      });
    }
  });

  function clearRouteAfterEndpointChange(): void {
    navRouteVisible = false;
    destPickActive = false;
    mapView?.setNavRouteVisible(false);
    mapView?.setSelectedPoi('');
    mapView?.setPath([]);
    currentPath = [];
    if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
    refreshEndpointFields();
    refreshDestPickUi();
    scheduleRebuildRoute();
  }

  navigateBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!originField.getValue()) return;
    destPickActive = true;
    destField.setValue('');
    navRouteVisible = false;
    mapView?.setNavRouteVisible(false);
    mapView?.clearNavigationRoute();
    refreshDestPickUi();
    syncMapEndpointMarkers();
  });

  originField.onClear(() => {
    clearRouteAfterEndpointChange();
    mapView?.clearTapNearby();
  });
  destField.onClear(() => {
    clearRouteAfterEndpointChange();
    mapView?.clearTapNearby();
  });

  originField.onPick(() => {
    if (destField.getValue() === originField.getValue()) destField.setValue('');
    refreshEndpointFields();
    const pickedId = originField.getValue();
    if (destPickActive && originField.getValue() && destField.getValue()) {
      navRouteVisible = true;
      mapView?.setNavRouteVisible(true);
      mapView?.setPreferSmoothCamera(true);
      focusEndpointInView(destField.getValue());
    } else if (pickedId) {
      navRouteVisible = false;
      mapView?.setNavRouteVisible(false);
      mapView?.clearNavigationRoute();
      currentPath = [];
      if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
      focusEndpointInView(pickedId);
    } else {
      navRouteVisible = false;
      mapView?.setNavRouteVisible(false);
      mapView?.clearNavigationRoute();
      currentPath = [];
      if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
    }
    refreshDestPickUi();
    scheduleRebuildRoute();
  });
  destField.onPick(() => {
    if (!destPickActive) return;
    if (originField.getValue() === destField.getValue()) originField.setValue('');
    refreshEndpointFields();
    const pickedId = destField.getValue();
    if (originField.getValue() && destField.getValue()) {
      navRouteVisible = true;
      mapView?.setNavRouteVisible(true);
      mapView?.setPreferSmoothCamera(true);
      focusEndpointInView(pickedId);
    } else if (pickedId) {
      navRouteVisible = false;
      mapView?.setNavRouteVisible(false);
      mapView?.clearNavigationRoute();
      currentPath = [];
      if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
      focusEndpointInView(pickedId);
    } else {
      navRouteVisible = false;
      mapView?.setNavRouteVisible(false);
      mapView?.clearNavigationRoute();
      currentPath = [];
      if (navigationBridge) clearNavRouteWaypointPoints(navigationBridge);
    }
    refreshDestPickUi();
    scheduleRebuildRoute();
  });

  if (deferLoad && typeof window !== 'undefined') {
    window.addEventListener(
      'zcomponent-localized',
      () => {
        void ensureProjectLoaded();
      },
      { once: true },
    );
  }

  if (!deferLoad) {
    void (async () => {
      if (showPoiTypeField) {
        setStatus(t('loadingProjects'), 'loading');
        await refreshPoiTypeOptions();
      }
      const picked = getSelectedPoiType();
      if (picked) activePoiType = picked;
      await loadProject();
      if (autoOpenFullscreen) setOpen(true);
    })();
  }

  const applyMini3dGtaI18n = () => {
    if (!suppressMapToggle) applyMapToggleIcon(toggle);
    applyPoiDisplayNames(pois);
    originField.refreshLabels();
    destField.refreshLabels();
    floorField.refreshLabel();
    refreshNavArBtn();
    projectLabel.textContent = t('poiType');
    projectRefreshBtn.textContent = t('refresh');
    if (poiTypeSelect.options.length > 0 && !poiTypeSelect.value) {
      poiTypeSelect.options[0].textContent =
        poiTypeSelect.options.length > 1 ? t('choosePoiType') : t('noProjects');
    }
    view3dBtn.title = t('switchTo2dView');
    if (mapView?.isIso3d()) view3dBtn.textContent = t('view2d');
    else view3dBtn.textContent = t('view3d');
    view2dLockBtn.textContent = t('view2dLock');
    syncView2dLockBtn();
    refreshFloorSelect();
    originField.setPlaceholder(t('searchFromPlaceholder'));
    destField.setPlaceholder(t('searchToPlaceholder'));
    const originVal = originField.getValue();
    const destVal = destField.getValue();
    if (originVal) originField.setValue(originVal, resolveRouteUiLabel(originVal));
    if (destVal) destField.setValue(destVal, resolveRouteUiLabel(destVal));
    syncMapEndpointMarkers();
    refreshMapTapHint();
    statusPhase.textContent =
      lastStatusLevel === 'error' ? t('statusError') : lastStatusLevel === 'done' ? t('statusReady') : 'NavMe';
    if (mapUiOpen && mapView) mapView.refreshI18nBadges();
  };

  const unsubLang = onNavmeLanguageChange(applyMini3dGtaI18n);

  const dispose = () => {
    unsubLang();
    setArExperiencePaused(false);
    if (typeof document !== 'undefined') {
      document.body.classList.remove('mini3dgta-fs-open');
      document.body.classList.remove('navme-map-immersive');
    }
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
      if (deferLoad && !mapUiOpen) {
        pendingOrigin = { x, y, z };
        return;
      }
      void ensureProjectLoaded().then(() => {
        const id = findPoiIdByPosition(pois, x, y, z);
        if (id) originField.setValue(id);
        fillEndpointSelects();
        if (originField.getValue() && destField.getValue()) {
          navRouteVisible = true;
          mapView?.setNavRouteVisible(true);
        }
        scheduleRebuildRoute();
      });
    },
    setDestination(x: number, y: number, z: number) {
      if (deferLoad && !mapUiOpen) {
        pendingDestination = { x, y, z };
        return;
      }
      void ensureProjectLoaded().then(() => {
        const id = findPoiIdByPosition(pois, x, y, z);
        if (id) destField.setValue(id);
        fillEndpointSelects();
        if (originField.getValue() && destField.getValue()) {
          navRouteVisible = true;
          mapView?.setNavRouteVisible(true);
        }
        scheduleRebuildRoute();
      });
    },
    rebuildRoute() {
      rebuildRoute();
    },
    setRouteEndpoints(originId: string, destId: string) {
      if (deferLoad && !mapUiOpen) {
        pendingRouteEndpoints = { originId, destId };
        return;
      }
      void ensureProjectLoaded().then(() => {
        if (originId) originField.setValue(originId);
        if (destId) destField.setValue(destId);
        fillEndpointSelects();
        scheduleRebuildRoute();
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
}

/**
 * @zcomponent
 * NavMe 2D navigation — saved floor map only (navme_floor_edits).
 */
export class Mini3dGtaEmbed extends Component<Mini3dGtaEmbedConstructionProps> {
  private _handle: Mini3dGtaHandle | null = null;
  private _anchor: HTMLDivElement | null = null;
  private _mapBtn: HTMLButtonElement | null = null;
  private _navBridge: Mini3dGtaNavRouteSync | null = null;
  protected zcomponent = this.getZComponentInstance(Scene);

  constructor(contextManager: ContextManager, constructorProps: Mini3dGtaEmbedConstructionProps) {
    super(contextManager, constructorProps);

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
        deferLoadUntilMapOpen: true,
        navigationBridge: this._navBridge,
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
        tryMount();
      };

      if (typeof queueMicrotask === 'function') {
        queueMicrotask(bootstrap);
      } else {
        setTimeout(bootstrap, 0);
      }

      if (!ensureLogoButton() && typeof document !== 'undefined') {
        const onDomReady = () => {
          ensureLogoButton();
          tryMount();
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
        } else {
          onDomReady();
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