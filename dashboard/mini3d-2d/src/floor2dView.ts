import type { NavMesh } from 'recast-navigation';
import {
  filterPoisByFloorY,
  findNavMapPoi,
  nearestFloorYForPoi,
  parseFloorRouteId,
  parseZoneRouteId,
  type NavMapPoi,
} from './pois';
import {
  applyRegionEdit,
  cloneRegionBlock,
  hitRegionHandle,
  hitTestRegion,
  regionCentroid,
  type RegionDrawMode,
} from './labeledRegion';
import { buildFloorEditPayload, type NavmeFloorEditPayload } from './data/floorEditPayload';
import {
  applyWalkGridEdits,
  cloneFloorLevels,
  defaultFloorLabel,
  defaultSubfloorLabel,
  floorLevelSliceMatches,
  FLOOR2D_STYLE,
  isBorderWallSegment,
  isTopLevelFloor,
  markEnclosedVoidCells,
  nextZoneColors,
  parentFloorOf,
  subfloorsOf,
  topLevelFloors,
  zoneFillFromStroke,
  ZONE_COLOR_OPTIONS,
  normalizeObjectRotation,
  paintRectOnWalk,
  paintConvexPolygonOnWalk,
  walkGridFromBlocks,
  zoneDisplayLabel,
  type Floor2DMap,
  type FloorBlock,
  type FloorLevel,
  type FloorPoint,
  type FloorShape,
} from './floor2d';
import { findPathOnFloorGrid, snapWorldToWalkCell, type FloorPathPoint } from './floor2dRoute';
import {
  computeMultiFloorRoute,
  getFloorWalkGrid,
  previewMapForFloor,
  routeUsesManualStairMouths,
  trimPathForFloorPlate,
  type FloorRouteConnector,
  type FloorRouteSegment,
  type RouteBreakPoint,
} from './floor2dMultiRoute';
import {
  getMouthById,
  hitTestStairMouth,
  linkStairMouths,
  newStairMouthId,
  resolveFloorWalkGrid,
  routingMapForFloor,
  STAIR_MOUTH_LINK_COLOR,
  STAIR_MOUTH_MARKER_COLOR,
  unlinkStairMouth,
  type StairMouth,
} from './stairMouth';
import { Floor2DScene3d } from './floor2dScene3d';
import { chairGridFootprint, type ObjectCatalogItem } from './objectCatalog';
import { drawFloorPlanSymbol } from './objectSymbols';
import { extractNavMeshSlice2D, extractNavMeshTris3D, type NavMeshSliceTri, type NavMeshTri3D } from './navmesh2d';
import {
  boundsFromPoints,
  dist2,
  isPolygonZone,
  syncZoneBounds,
  zoneCentroid,
  type ZoneEditHandle,
  type ZonePoint,
  type ZoneResizeCorner,
} from './zoneGeometry';

export type Floor2DViewOptions = {
  onPoiClick?: (poi: NavMapPoi) => void;
};

/** Top-level floor editor display (editing stays on plan2d). */
export type FloorViewMode = 'plan2d' | 'plan3d' | 'nav3d';

export type Floor2DTool =
  | 'pan'
  | 'add'
  | 'cut'
  | 'object'
  | 'object-edit'
  | 'zone'
  | 'zone-edit'
  | 'stair-mouth'
  | 'stair-mouth-edit';
export type ZoneDrawMode = RegionDrawMode;
export type PaintShape = 'rectangle' | 'circle' | 'triangle' | 'draw';

type EditSnapshot = { walk: Uint8Array; objects: FloorBlock[]; zones: FloorBlock[] };

const MIN_BLOCK = 0.1;
const MIN_SCREEN_RECT_PX = 4;
const VIEW_ROT_EPS = 1e-4;
const BRUSH_RADIUS_PX = 10;
const MAX_HISTORY = 50;
const HANDLE_RADIUS_PX = 9;
const CLOSE_POLY_DIST_PX = 14;
/** Above this, draw merged corridor rects instead of per-cell fills. */
const HEAVY_GRID_CELLS = 250_000;

const PAINT_SHAPE_ICONS: Record<PaintShape, string> = {
  rectangle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="14" rx="1"/></svg>',
  circle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>',
  triangle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5 L20 19 L4 19 Z"/></svg>',
  draw:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20 L4 14 L14 4 L20 10 L10 20 Z"/></svg>',
};

function normRect(x0: number, z0: number, x1: number, z1: number): FloorBlock {
  const x = Math.min(x0, x1);
  const z = Math.min(z0, z1);
  return {
    id: '',
    x,
    z,
    w: Math.abs(x1 - x0),
    d: Math.abs(z1 - z0),
    fill: FLOOR2D_STYLE.corridor,
    label: '',
  };
}

function cloneBlocks(blocks: FloorBlock[]): FloorBlock[] {
  return blocks.map((o) => ({
    ...o,
    points: o.points?.map((p) => ({ x: p.x, z: p.z })),
  }));
}

function truncateLabel(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

export class Floor2DView {
  readonly canvas: HTMLCanvasElement;
  private scene3d: Floor2DScene3d | null = null;
  private viewMode: FloorViewMode = 'plan2d';
  /** When true, both 2D canvas and scene3d are hidden (e.g. GLB+navmesh uses mount canvas). */
  private externalViewHidden = false;
  private navMesh3dTris: NavMeshTri3D[] = [];
  /** After From VPS: plan3d shows every floor at real Y (full building). */
  private fullBuilding3d = false;
  private multiFloor3dAuto = false;
  /** Multi-floor 3D stacked plates (View Stack); off = single-floor 2D paper. */
  private viewStack = false;
  private map: Floor2DMap | null = null;
  private editWalk: Uint8Array | null = null;
  private editObjects: FloorBlock[] = [];
  private editZones: FloorBlock[] = [];
  private editFloors: FloorLevel[] = [];
  private activeFloorId: string | null = null;
  private objectShape: FloorShape = 'rectangle';
  /** Selected catalog material (chair, door, …); null = freehand rectangle/circle. */
  private objectMaterial: ObjectCatalogItem | null = null;
  /** Chair count for parametric materials (e.g. row of chairs). */
  private objectParamCount = 4;
  private paintShape: PaintShape = 'rectangle';
  private tool: Floor2DTool = 'pan';
  private dirty = false;
  private draft: { sx0: number; sy0: number; sx1: number; sy1: number } | null = null;
  private brushStroke: { lastSx: number; lastSy: number } | null = null;
  private path: { x: number; z: number }[] = [];
  private routeSegments: FloorRouteSegment[] = [];
  private routeConnectors: FloorRouteConnector[] = [];
  private routeError: string | null = null;
  private routeDebugForward: FloorRouteSegment[] = [];
  private routeDebugReverse: FloorRouteSegment[] = [];
  private routeBreakPoints: RouteBreakPoint[] = [];
  private pois: NavMapPoi[] = [];
  private originId = '';
  private destId = '';
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  /** Radians; 0 = north-up. Shift+drag or Shift+wheel while editing; Ctrl+wheel zooms at cursor. */
  private viewRotation = 0;
  private cachedPreviewMap: Floor2DMap | null = null;
  private previewDirty = true;
  private drawRaf = 0;
  private navPanning = false;
  private rotateDragging = false;
  private rotateStartAngle = 0;
  private rotateStartViewRotation = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private objectIdSeq = 0;
  private zoneIdSeq = 0;
  private floorIdSeq = 0;
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];
  private showNavMesh = false;
  private navMeshTris: NavMeshSliceTri[] = [];
  private onToolChange?: (tool: Floor2DTool) => void;
  private onDirtyChange?: (dirty: boolean) => void;
  private onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  private onZonesChange?: () => void;
  private onFloorsChange?: () => void;
  private onRouteRebuild?: () => void;
  private onIso3dChange?: (on: boolean) => void;
  private onViewModeChange?: (mode: FloorViewMode) => void;
  private onZoneSelectionChange?: (zoneId: string | null) => void;
  private onObjectSelectionChange?: (objectId: string | null) => void;
  private onStairMouthSelectionChange?: (sel: {
    mouthId: string | null;
    floorId: string | null;
    linked: boolean;
  }) => void;
  private onFloorActivate?: (floor: FloorLevel) => void;
  private onViewStackChange?: (on: boolean) => void;
  private selectedStairMouthId: string | null = null;
  private selectedStairMouthFloorId: string | null = null;
  private pendingLinkMouthId: string | null = null;
  private pendingLinkFloorId: string | null = null;
  private zoneDialog: HTMLDivElement | null = null;
  private zoneNameInput: HTMLInputElement | null = null;
  private zoneDialogResolve: ((name: string | null) => void) | null = null;
  private zoneSidebar: HTMLElement | null = null;
  private paintShapeToolbar: HTMLElement | null = null;
  private paintShapeBtns: Partial<Record<PaintShape, HTMLButtonElement>> = {};
  private zoneListEl: HTMLElement | null = null;
  private zoneColorPanelEl: HTMLElement | null = null;
  private zoneColorSwatchesEl: HTMLElement | null = null;
  private zoneCustomColorInput: HTMLInputElement | null = null;
  private floorListEl: HTMLElement | null = null;
  private subfloorListEl: HTMLElement | null = null;
  private zoneDrawMode: ZoneDrawMode = 'rectangle';
  private selectedZoneId: string | null = null;
  private selectedObjectId: string | null = null;
  /** In-app clipboard for copy/paste of a placed object. */
  private objectClipboard: FloorBlock | null = null;
  /** Increments on each paste so copies land offset from each other. */
  private objectPasteCount = 0;
  private onObjectClipboardChange: ((hasClipboard: boolean) => void) | null = null;
  private polygonDraft: { points: ZonePoint[]; cursorX: number; cursorZ: number } | null = null;
  private zoneEdit: {
    block: FloorBlock;
    handle: ZoneEditHandle;
    startWorld: { x: number; z: number };
    snapshot: FloorBlock;
    historyPushed: boolean;
  } | null = null;
  private objectEdit: {
    block: FloorBlock;
    mode: 'move' | 'resize' | 'rotate';
    corner?: ZoneResizeCorner;
    startWorld: { x: number; z: number };
    snapshot: FloorBlock;
    historyPushed: boolean;
    startAngle?: number;
  } | null = null;
  private objectScaleGesture = false;
  private objectScaleGestureTimer: ReturnType<typeof setTimeout> | null = null;
  private mouthEdit: {
    floorId: string;
    mouthId: string;
    startWorld: { x: number; z: number };
    snapshot: { x: number; z: number };
    historyPushed: boolean;
  } | null = null;
  constructor(parent: HTMLElement, _options: Floor2DViewOptions = {}) {
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    this.buildZoneSidebar(parent);
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;cursor:grab;background:' +
      FLOOR2D_STYLE.background +
      ';position:relative;z-index:1;';
    parent.appendChild(this.canvas);
    this.buildPaintShapeToolbar(parent);
    this.scene3d = new Floor2DScene3d(parent);
    this.buildZoneNameDialog(parent);
    this.bindPointer();
    this.bindKeyboard();
  }

  isIso3d(): boolean {
    return this.viewMode === 'plan3d';
  }

  getViewMode(): FloorViewMode {
    return this.viewMode;
  }

  setOnViewModeChange(cb: (mode: FloorViewMode) => void): void {
    this.onViewModeChange = cb;
  }

  /**
   * Hide floor2d canvas + scene3d so mount can show the GLB orbit canvas
   * (nav3d mesh+overlay mode).
   */
  setExternalViewHidden(on: boolean): void {
    if (this.externalViewHidden === on) return;
    this.externalViewHidden = on;
    this.updateScene3dVisibility();
  }

  isExternalViewHidden(): boolean {
    return this.externalViewHidden;
  }

  setViewMode(mode: FloorViewMode): void {
    if (mode === this.viewMode && !this.externalViewHidden) return;
    const prev = this.viewMode;
    this.viewMode = mode;
    this.externalViewHidden = false;
    if (mode !== 'plan2d') {
      this.tool = 'pan';
      this.canvas.style.cursor = 'grab';
      this.onToolChange?.('pan');
    }
    this.updateScene3dVisibility();
    if (this.scene3dWanted()) {
      this.syncScene3d(true);
    } else if (mode === 'plan2d') {
      this.draw();
    }
    if (prev !== mode || mode === 'plan3d') {
      this.onIso3dChange?.(mode === 'plan3d');
    }
    this.onViewModeChange?.(mode);
  }

  private scene3dWanted(): boolean {
    if (this.externalViewHidden) return false;
    return this.viewMode === 'plan3d' || this.viewMode === 'nav3d' || this.viewStack;
  }

  private updateScene3dVisibility(): void {
    if (this.externalViewHidden) {
      this.scene3d?.setVisible(false);
      this.canvas.style.display = 'none';
      return;
    }
    const show = this.scene3dWanted();
    this.scene3d?.setVisible(show);
    this.canvas.style.display = show ? 'none' : 'block';
  }

  /** Toggle extruded 3D walls with orbit / tilt (drag to rotate view). */
  toggleIso3d(): boolean {
    this.setViewMode(this.viewMode === 'plan3d' ? 'plan2d' : 'plan3d');
    return this.isIso3d();
  }

  isMultiFloor3dAuto(): boolean {
    return this.multiFloor3dAuto;
  }

  setOnIso3dChange(cb: (on: boolean) => void): void {
    this.onIso3dChange = cb;
  }

  private enableMultiFloor3dView(): void {
    if (!this.scene3d || !this.map) return;
    this.multiFloor3dAuto = true;
    this.updateScene3dVisibility();
  }

  private usesStackedPlate3d(): boolean {
    return this.viewStack && this.usesStackedLayout() && this.tool === 'pan';
  }

  isViewStack(): boolean {
    return this.viewStack;
  }

  toggleViewStack(): boolean {
    if (!this.usesStackedLayout()) {
      this.viewStack = false;
      return false;
    }
    this.viewStack = !this.viewStack;
    if (this.viewStack) {
      this.tool = 'pan';
      this.canvas.style.cursor = 'grab';
      this.onToolChange?.('pan');
      this.enableMultiFloor3dView();
      this.syncScene3d(true);
    } else {
      this.disableMultiFloor3dView();
      this.fit();
      if (this.scene3dWanted()) this.syncScene3d(true);
      else this.draw();
    }
    this.onViewStackChange?.(this.viewStack);
    this.refreshFloorSidebar();
    return this.viewStack;
  }

  setViewStack(on: boolean): void {
    if (on === this.viewStack) return;
    if (on && !this.usesStackedLayout()) return;
    if (on) this.toggleViewStack();
    else if (this.viewStack) this.toggleViewStack();
  }

  private disableMultiFloor3dView(): void {
    if (!this.multiFloor3dAuto) return;
    this.multiFloor3dAuto = false;
    this.updateScene3dVisibility();
  }

  setIso3d(on: boolean): void {
    if (on === this.isIso3d()) return;
    this.setViewMode(on ? 'plan3d' : 'plan2d');
  }

  /** Cache navmesh tris for 3D diagram mode (call after bake). */
  setNavMesh3dSource(navMesh: NavMesh | null, sliceY: number | null = null): void {
    if (!navMesh) {
      this.navMesh3dTris = [];
    } else {
      try {
        this.navMesh3dTris = extractNavMeshTris3D(navMesh, sliceY);
      } catch {
        this.navMesh3dTris = [];
      }
    }
    if (this.viewMode === 'nav3d' && this.scene3dWanted()) {
      this.syncScene3d(true);
    }
  }

  private syncScene3d(refitCamera = false): void {
    if (!this.scene3dWanted() || !this.scene3d || !this.map) return;

    if (this.viewMode === 'nav3d' && !this.viewStack) {
      this.scene3d.syncNavMeshDiagram(
        this.navMesh3dTris,
        {
          map: this.map,
          path: this.path,
          pois: this.pois,
          originId: this.originId,
          destId: this.destId,
          floorYHint: this.map.sliceY,
        },
        refitCamera,
      );
      return;
    }

    const showFullBuilding =
      this.fullBuilding3d &&
      this.viewMode === 'plan3d' &&
      topLevelFloors(this.editFloors).length >= 2 &&
      !this.getActiveFloor()?.parentFloorId &&
      !this.viewStack;

    if (this.usesStackedPlate3d() || showFullBuilding) {
      const floors = this.sortedFloors();
      const layers = floors.map((floor) => {
        const preview = previewMapForFloor(this.map!, floor, this.editFloors);
        const walk = this.walkForFloorLevel(floor);
        const isActive = floor.id === this.activeFloorId;
        const seg = this.routeSegments.find((s) => s.floorId === floor.id);
        const path = seg
          ? this.trimPathForFloor(floor.id, seg.path).map((p) => ({ x: p.x, z: p.z }))
          : [];
        const fwd = this.routeDebugForward.find((s) => s.floorId === floor.id);
        const rev = this.routeDebugReverse.find((s) => s.floorId === floor.id);
        const platePois = filterPoisByFloorY(this.pois, floor.floorY, this.editFloors);
        return {
          floorId: floor.id,
          label: floor.label.trim() || 'Floor',
          floorY: floor.floorY,
          map: preview,
          walk: walk ?? new Uint8Array(0),
          objects: floor.objects ?? (isActive ? this.editObjects : []),
          zones: floor.zones ?? (isActive ? this.editZones : []),
          path,
          debugPaths: routeUsesManualStairMouths(this.routeConnectors)
            ? []
            : [
                ...(fwd
                  ? [{
                      color: '#16a34a',
                      path: this.trimPathForFloor(floor.id, fwd.path).map((p) => ({ x: p.x, z: p.z })),
                    }]
                  : []),
                ...(rev
                  ? [{
                      color: '#ea580c',
                      path: this.trimPathForFloor(floor.id, rev.path).map((p) => ({ x: p.x, z: p.z })),
                    }]
                  : []),
              ],
          pois: platePois,
        };
      });
      this.scene3d.sync(
        {
          multiFloor: true,
          map: this.map,
          floors: layers,
          connectors: this.routeConnectors,
          floorLevels: this.editFloors,
          walk: this.editWalk ?? new Uint8Array(0),
          objects: this.editObjects,
          zones: this.editZones,
          path: this.path,
          pois: this.pois,
          originId: this.originId,
          destId: this.destId,
          // Stacked plates = artificial spacing; full VPS building = real floorY.
          verticalPlateStack: !showFullBuilding,
          showWalls: true,
          showInteriorVolumes: true,
          showObjects: true,
        },
        refitCamera,
      );
      return;
    }

    if (!this.editWalk) return;
    const preview = this.previewMap();
    if (!preview) return;
    this.scene3d.sync(
      {
        map: preview,
        walk: this.editWalk,
        objects: this.editObjects,
        zones: this.editZones,
        stores: preview.stores,
        path: this.path,
        pois: this.pois,
        originId: this.originId,
        destId: this.destId,
      },
      refitCamera,
    );
  }

  private buildZoneSidebar(mapParent: HTMLElement): void {
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

    const subfloorHeader = document.createElement('div');
    subfloorHeader.className = 'floor2d-zone-sidebar__header floor2d-zone-sidebar__header--zones';
    subfloorHeader.textContent = 'Subfloors';

    const subfloorHint = document.createElement('div');
    subfloorHint.className = 'floor2d-zone-sidebar__hint';
    subfloorHint.textContent =
      'Independent plans with the same paint, cut, object, zone, and stair tools';

    const subfloorList = document.createElement('div');
    subfloorList.className = 'floor2d-zone-list floor2d-subfloor-list';

    const zoneHeader = document.createElement('div');
    zoneHeader.className = 'floor2d-zone-sidebar__header floor2d-zone-sidebar__header--zones';
    zoneHeader.textContent = 'Zones';

    const zoneHint = document.createElement('div');
    zoneHint.className = 'floor2d-zone-sidebar__hint';
    zoneHint.textContent = 'Click a zone to zoom — use Edit Zone to change or delete';

    const zoneColorPanel = document.createElement('div');
    zoneColorPanel.className = 'floor2d-zone-colors';
    zoneColorPanel.hidden = true;
    const zoneColorLabel = document.createElement('div');
    zoneColorLabel.className = 'floor2d-zone-colors__label';
    zoneColorLabel.textContent = 'Zone color';
    const zoneColorSwatches = document.createElement('div');
    zoneColorSwatches.className = 'floor2d-zone-colors__grid';
    for (const color of ZONE_COLOR_OPTIONS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'floor2d-zone-colors__swatch';
      sw.style.background = color;
      sw.title = color;
      sw.setAttribute('aria-label', `Set zone color ${color}`);
      sw.addEventListener('click', () => this.setSelectedZoneColor(color));
      zoneColorSwatches.appendChild(sw);
    }
    const customRow = document.createElement('div');
    customRow.className = 'floor2d-zone-colors__custom';
    const customLabel = document.createElement('span');
    customLabel.className = 'floor2d-zone-colors__custom-label';
    customLabel.textContent = 'Custom';
    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.className = 'floor2d-zone-colors__picker';
    customInput.value = '#e53935';
    customInput.title = 'Pick a custom zone color';
    customInput.addEventListener('input', () => {
      this.setSelectedZoneColor(customInput.value);
    });
    customRow.append(customLabel, customInput);

    const zoneList = document.createElement('div');
    zoneList.className = 'floor2d-zone-list';

    zoneColorPanel.append(zoneColorLabel, zoneColorSwatches, customRow);
    sidebar.append(
      floorHeader,
      floorHint,
      floorList,
      subfloorHeader,
      subfloorHint,
      subfloorList,
      zoneHeader,
      zoneHint,
      zoneColorPanel,
      zoneList,
    );
    layout.insertBefore(sidebar, mapParent);

    this.zoneSidebar = sidebar;
    this.floorListEl = floorList;
    this.subfloorListEl = subfloorList;
    this.zoneColorPanelEl = zoneColorPanel;
    this.zoneColorSwatchesEl = zoneColorSwatches;
    this.zoneCustomColorInput = customInput;
    this.zoneListEl = zoneList;
  }

  private buildPaintShapeToolbar(mapParent: HTMLElement): void {
    const bar = document.createElement('div');
    bar.className = 'floor2d-paint-tools';
    bar.setAttribute('aria-label', 'Paint shape');

    const label = document.createElement('div');
    label.className = 'floor2d-paint-tools__label';
    label.textContent = 'Shape';
    bar.appendChild(label);

    const shapes: { id: PaintShape; title: string }[] = [
      { id: 'rectangle', title: 'Box — drag a rectangle' },
      { id: 'circle', title: 'Circle — drag an ellipse' },
      { id: 'triangle', title: 'Triangle — drag to size' },
      { id: 'draw', title: 'Draw — freehand brush' },
    ];

    for (const { id, title } of shapes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floor2d-paint-shape' + (id === this.paintShape ? ' floor2d-paint-shape--active' : '');
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = PAINT_SHAPE_ICONS[id];
      btn.addEventListener('click', () => this.setPaintShape(id));
      bar.appendChild(btn);
      this.paintShapeBtns[id] = btn;
    }

    mapParent.appendChild(bar);
    this.paintShapeToolbar = bar;
  }

  private syncPaintShapeToolbar(): void {
    if (!this.paintShapeToolbar) return;
    const show = this.tool === 'add' || this.tool === 'cut';
    this.paintShapeToolbar.classList.toggle('floor2d-paint-tools--visible', show);
    for (const [shape, btn] of Object.entries(this.paintShapeBtns) as [PaintShape, HTMLButtonElement][]) {
      btn.classList.toggle('floor2d-paint-shape--active', shape === this.paintShape);
    }
  }

  private buildZoneNameDialog(parent: HTMLElement): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'floor2d-zone-dialog';
    backdrop.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'floor2d-zone-dialog__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'floor2d-zone-dialog-title');

    const title = document.createElement('div');
    title.id = 'floor2d-zone-dialog-title';
    title.className = 'floor2d-zone-dialog__title';
    title.textContent = 'Zone name';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'floor2d-zone-dialog__input';
    input.placeholder = 'e.g. Food Court, Restrooms';
    input.maxLength = 64;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'floor2d-zone-dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'floor2d-zone-dialog__btn floor2d-zone-dialog__btn--cancel';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'floor2d-zone-dialog__btn floor2d-zone-dialog__btn--ok';
    okBtn.textContent = 'Add Zone';

    const closeDialog = (name: string | null) => {
      backdrop.style.display = 'none';
      const resolve = this.zoneDialogResolve;
      this.zoneDialogResolve = null;
      resolve?.(name);
    };

    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      closeDialog(value);
    };

    cancelBtn.addEventListener('click', () => closeDialog(null));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog(null);
      }
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeDialog(null);
    });

    actions.append(cancelBtn, okBtn);
    panel.append(title, input, actions);
    backdrop.append(panel);
    parent.appendChild(backdrop);

    this.zoneDialog = backdrop;
    this.zoneNameInput = input;
    this.zoneDialogOkBtn = okBtn;
    this.zoneDialogTitle = title;
  }

  private zoneDialogOkBtn: HTMLButtonElement | null = null;
  private zoneDialogTitle: HTMLDivElement | null = null;

  private askRegionName(
    kind: 'zone' | 'floor',
    defaultName = '',
    mode: 'create' | 'rename' = 'create',
  ): Promise<string | null> {
    if (!this.zoneDialog || !this.zoneNameInput || !this.zoneDialogOkBtn || !this.zoneDialogTitle) {
      return Promise.resolve(defaultName.trim() || null);
    }
    const noun = kind === 'floor' ? 'floor' : 'zone';
    this.zoneDialogTitle.textContent = mode === 'rename' ? `Rename ${noun}` : `${noun[0].toUpperCase()}${noun.slice(1)} name`;
    this.zoneDialogOkBtn.textContent = mode === 'rename' ? 'Save' : kind === 'floor' ? 'Add Floor' : 'Add Zone';
    this.zoneNameInput.value = defaultName;
    this.zoneDialog.style.display = 'flex';
    this.zoneNameInput.focus();
    this.zoneNameInput.select();
    return new Promise((resolve) => {
      this.zoneDialogResolve = resolve;
    });
  }

  private askZoneName(defaultName = '', mode: 'create' | 'rename' = 'create'): Promise<string | null> {
    return this.askRegionName('zone', defaultName, mode);
  }

  private askFloorName(defaultName = '', mode: 'create' | 'rename' = 'create'): Promise<string | null> {
    return this.askRegionName('floor', defaultName, mode);
  }

  /** Popup listing top-level floors — user picks which floor the subfloor belongs to. */
  private askSubfloorParent(): Promise<string | null> {
    const tops = topLevelFloors(this.editFloors);
    if (tops.length === 0) return Promise.resolve(null);

    const parent = this.canvas.parentElement ?? document.body;
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'floor2d-zone-dialog';

      const panel = document.createElement('div');
      panel.className = 'floor2d-zone-dialog__panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');

      const title = document.createElement('div');
      title.className = 'floor2d-zone-dialog__title';
      title.textContent = 'Subfloor of which floor?';

      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:220px;overflow-y:auto';

      const close = (value: string | null) => {
        backdrop.remove();
        resolve(value);
      };

      for (const floor of tops) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'floor2d-zone-item';
        const dot = document.createElement('span');
        dot.className = 'floor2d-zone-item__dot';
        dot.style.background = FLOOR2D_STYLE.floorRegionBorder;
        const name = document.createElement('span');
        name.className = 'floor2d-zone-item__name';
        name.textContent = floor.label.trim() || 'Floor';
        btn.append(dot, name);
        btn.addEventListener('click', () => close(floor.id));
        list.appendChild(btn);
      }

      const actions = document.createElement('div');
      actions.className = 'floor2d-zone-dialog__actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'floor2d-zone-dialog__btn floor2d-zone-dialog__btn--cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => close(null));
      actions.appendChild(cancelBtn);

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(null);
      });

      panel.append(title, list, actions);
      backdrop.appendChild(panel);
      parent.appendChild(backdrop);
    });
  }

  /** Add Subfloor flow: popup to pick parent floor, then create at the given Y. */
  async promptAddSubfloor(floorY?: number): Promise<FloorLevel | null> {
    const parentId = await this.askSubfloorParent();
    if (!parentId) return null;
    return this.addSubfloorLevel(parentId, floorY);
  }

  private async commitNewZone(rect: FloorBlock, shape: 'rectangle' | 'polygon' = 'rectangle', points?: ZonePoint[]): Promise<void> {
    const zoneName = await this.askZoneName('', 'create');
    if (!zoneName) {
      this.draw();
      return;
    }
    this.pushHistory();
    const colors = nextZoneColors(this.editZones.length);
    const zone: FloorBlock = {
      ...rect,
      id: `zone-${++this.zoneIdSeq}`,
      fill: colors.fill,
      label: zoneName,
      shape,
      stroke: colors.stroke,
    };
    if (shape === 'polygon' && points?.length) {
      zone.points = points.map((p) => ({ x: p.x, z: p.z }));
      syncZoneBounds(zone);
    }
    this.editZones.push(zone);
    this.selectZone(zone.id);
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.draw();
  }

  private async finishPolygonDraft(): Promise<void> {
    const pts = this.polygonDraft?.points;
    this.polygonDraft = null;
    if (!pts || pts.length < 3) {
      this.draw();
      return;
    }
    const bounds = boundsFromPoints(pts);
    await this.commitNewZone(
      { id: '', x: bounds.x, z: bounds.z, w: bounds.w, d: bounds.d, fill: 'transparent', label: '' },
      'polygon',
      pts,
    );
  }

  /** Save the current canvas edits onto the active floor level. */
  flushCurrentFloorState(): void {
    if (!this.activeFloorId || !this.map || !this.editWalk) return;
    const floor = this.editFloors.find((f) => f.id === this.activeFloorId);
    if (!floor) return;
    floor.walkGrid = Array.from(this.editWalk);
    floor.objects = cloneBlocks(this.editObjects);
    floor.zones = cloneBlocks(this.editZones);
    floor.gridCols = this.map.cols;
    floor.gridRows = this.map.rows;
    floor.gridCellSize = this.map.cellSize;
    floor.gridMinX = this.map.minX;
    floor.gridMinZ = this.map.minZ;
  }

  private captureCurrentEditsToFloor(floor: FloorLevel): void {
    if (!this.map || !this.editWalk) return;
    floor.walkGrid = Array.from(this.editWalk);
    floor.objects = cloneBlocks(this.editObjects);
    floor.zones = cloneBlocks(this.editZones);
    floor.gridCols = this.map.cols;
    floor.gridRows = this.map.rows;
    floor.gridCellSize = this.map.cellSize;
    floor.gridMinX = this.map.minX;
    floor.gridMinZ = this.map.minZ;
  }

  /** Load a named floor's saved walk/objects/zones onto the canvas. */
  private applyFloorLevelToCanvas(floor: FloorLevel): void {
    if (!this.map) return;
    const need = this.map.cols * this.map.rows;
    const hasSavedWalk =
      Array.isArray(floor.walkGrid) &&
      floor.walkGrid.length === need &&
      (floor.gridCols === undefined || floor.gridCols === this.map.cols) &&
      (floor.gridRows === undefined || floor.gridRows === this.map.rows);
    if (hasSavedWalk && floor.walkGrid) {
      this.editWalk = new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
      this.editObjects = cloneBlocks(floor.objects ?? []);
      this.editZones = cloneBlocks(floor.zones ?? []);
      if (floor.gridCols !== this.map.cols || floor.gridRows !== this.map.rows) {
        floor.gridCols = this.map.cols;
        floor.gridRows = this.map.rows;
        floor.gridCellSize = this.map.cellSize;
        floor.gridMinX = this.map.minX;
        floor.gridMinZ = this.map.minZ;
      }
      return;
    }
    const blocks = this.map.corridors.length > 0 ? this.map.corridors : this.map.blocks;
    this.editWalk = walkGridFromBlocks(this.map, blocks);
    this.editObjects = cloneBlocks(floor.objects ?? []);
    this.editZones = cloneBlocks(floor.zones ?? []);
    if (floorLevelSliceMatches(this.map, floor) && !floor.walkGrid?.length) {
      this.captureCurrentEditsToFloor(floor);
    }
  }

  /** Register current slice Y as a new named level (Floor 1, Floor 2, …). */
  addFloorLevel(floorY: number): FloorLevel {
    this.flushCurrentFloorState();
    const isFirstLevel = topLevelFloors(this.editFloors).length === 0;
    const floor: FloorLevel = {
      id: `floor-${++this.floorIdSeq}`,
      label: defaultFloorLabel(topLevelFloors(this.editFloors).length + 1),
      floorY,
    };
    if (
      isFirstLevel &&
      this.map &&
      Math.abs((this.map.sliceY ?? floorY) - floorY) < 1e-4
    ) {
      this.captureCurrentEditsToFloor(floor);
    }
    this.editFloors.push(floor);
    this.activeFloorId = floor.id;
    if (!isFirstLevel && this.map) {
      const blocks = this.map.corridors.length > 0 ? this.map.corridors : this.map.blocks;
      this.editWalk = walkGridFromBlocks(this.map, blocks);
      this.editObjects = [];
      this.editZones = [];
      this.clearHistory();
    }
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
    this.draw();
    return floor;
  }

  /**
   * Create a subfloor under a parent floor (stair intersection plate).
   * Uses the current Y slice; defaults parent to the active floor's parent/top-level.
   */
  addSubfloorLevel(parentFloorId?: string, floorY?: number): FloorLevel | null {
    this.flushCurrentFloorState();
    const active = this.getActiveFloor();
    const parentId =
      parentFloorId ??
      (active ? parentFloorOf(this.editFloors, active)?.id : null) ??
      topLevelFloors(this.editFloors)[0]?.id;
    if (!parentId) return null;
    const parent = this.editFloors.find((f) => f.id === parentId && isTopLevelFloor(f));
    if (!parent) return null;

    const y = floorY ?? this.map?.sliceY ?? parent.floorY;
    const childCount = subfloorsOf(this.editFloors, parent.id).length;
    const sub: FloorLevel = {
      id: `subfloor-${++this.floorIdSeq}`,
      label: defaultSubfloorLabel(parent, childCount + 1),
      floorY: y,
      parentFloorId: parent.id,
    };
    this.editFloors.push(sub);
    this.activeFloorId = sub.id;
    if (this.map) {
      this.map = { ...this.map, sliceY: sub.floorY };
      // Start blank — user paints the small stair intersection area.
      this.editWalk = new Uint8Array(this.map.cols * this.map.rows);
      this.editObjects = [];
      this.editZones = [];
      this.clearHistory();
      this.captureCurrentEditsToFloor(sub);
    }
    this.invalidatePreview();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyFloorsChange();
    this.onFloorActivate?.(sub);
    this.fit();
    this.draw();
    return sub;
  }

  getActiveFloor(): FloorLevel | null {
    return this.editFloors.find((f) => f.id === this.activeFloorId) ?? null;
  }

  /** Stair mouths live on floor levels — ensure one exists for the current map slice. */
  private ensureActiveFloorForMouths(): FloorLevel | null {
    if (!this.map) return null;
    const current = this.getActiveFloor();
    if (current) return current;

    const sliceY = this.map.sliceY;
    const match = this.editFloors.find((f) => Math.abs(f.floorY - sliceY) < 1e-4);
    if (match) {
      this.activeFloorId = match.id;
      this.refreshFloorSidebar();
      return match;
    }

    return this.addFloorLevel(sliceY);
  }

  getActiveFloorId(): string | null {
    return this.activeFloorId;
  }

  getFloorLevels(): FloorLevel[] {
    return cloneFloorLevels(this.editFloors);
  }

  clearFloorLevels(): void {
    this.editFloors = [];
    this.activeFloorId = null;
    this.floorIdSeq = 0;
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
  }

  clearActiveFloor(): void {
    this.activeFloorId = null;
    this.refreshFloorSidebar();
  }

  async renameActiveFloor(): Promise<boolean> {
    const floor = this.getActiveFloor();
    if (!floor) return false;
    const name = await this.askFloorName(floor.label, 'rename');
    if (!name || name === floor.label) return false;
    floor.label = name;
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
    return true;
  }

  activateFloorLevel(floorId: string): FloorLevel | null {
    const floor = this.editFloors.find((f) => f.id === floorId);
    if (!floor || !this.map) return null;
    this.flushCurrentFloorState();
    this.activeFloorId = floor.id;
    this.map = { ...this.map, sliceY: floor.floorY };
    if (this.viewStack) {
      this.viewStack = false;
      this.disableMultiFloor3dView();
      this.onViewStackChange?.(false);
    }

    this.applyFloorLevelToCanvas(floor);
    this.invalidatePreview();
    this.clearHistory();

    this.selectedZoneId = null;
    this.polygonDraft = null;
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.fit();
    this.onFloorActivate?.(floor);
    this.draw();
    return floor;
  }

  activateViewAllFloors(): void {
    if (!this.usesStackedLayout()) return;
    if (!this.viewStack) this.toggleViewStack();
    else {
      this.syncScene3d(false);
      this.refreshFloorSidebar();
    }
  }

  /** POIs for map + origin/destination lists from the current floor selection. */
  poisForDisplay(source?: NavMapPoi[]): NavMapPoi[] {
    const list = source ?? this.pois;
    if (this.viewStack) return list;
    const active = this.getActiveFloor();
    if (!active || list.length === 0) return list;
    return filterPoisByFloorY(list, active.floorY, this.editFloors);
  }

  setZoneDrawMode(mode: ZoneDrawMode): void {
    this.zoneDrawMode = mode;
    this.polygonDraft = null;
    this.draw();
  }

  getZoneDrawMode(): ZoneDrawMode {
    return this.zoneDrawMode;
  }

  selectZone(id: string | null): void {
    this.selectedZoneId = id;
    this.onZoneSelectionChange?.(id);
    this.refreshZoneSidebar();
    this.draw();
  }

  /** Change stroke/fill for the selected zone (Edit Zone tool). Persists on save. */
  setSelectedZoneColor(stroke: string): void {
    if (!this.selectedZoneId) return;
    const zone = this.editZones.find((z) => z.id === this.selectedZoneId);
    if (!zone) return;
    const next = stroke.trim();
    if (!next || zone.stroke === next) return;
    this.pushHistory();
    zone.stroke = next;
    zone.fill = zoneFillFromStroke(next);
    this.refreshZoneSidebar();
    this.onRouteRebuild?.();
    this.draw();
  }

  private refreshZoneColorPanel(): void {
    if (!this.zoneColorPanelEl || !this.zoneColorSwatchesEl) return;
    const show = this.isZoneEditTool() && !!this.selectedZoneId;
    this.zoneColorPanelEl.hidden = !show;
    if (!show) return;
    const zone = this.editZones.find((z) => z.id === this.selectedZoneId);
    const stroke = (zone?.stroke || FLOOR2D_STYLE.accent).toLowerCase();
    for (const btn of this.zoneColorSwatchesEl.querySelectorAll<HTMLButtonElement>('.floor2d-zone-colors__swatch')) {
      btn.classList.toggle('floor2d-zone-colors__swatch--active', btn.title.toLowerCase() === stroke);
    }
    if (this.zoneCustomColorInput && /^#[0-9a-f]{6}$/i.test(stroke)) {
      this.zoneCustomColorInput.value = stroke;
    }
  }

  focusZone(zone: FloorBlock): void {
    this.focusRegion(zone);
  }

  private focusRegion(block: FloorBlock): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const vw = Math.max(1, parent.clientWidth);
    const vh = Math.max(1, parent.clientHeight);
    const pad = 48;
    const zoomW = Math.max(block.w, 0.5);
    const zoomH = Math.max(block.d, 0.5);
    const c = regionCentroid(block);
    this.canvas.width = Math.floor(vw * dpr);
    this.canvas.height = Math.floor(vh * dpr);
    this.scale = Math.min((vw - pad) / zoomW, (vh - pad) / zoomH) * dpr;
    this.offsetX = this.canvas.width / 2 - c.x * this.scale;
    this.offsetY = this.canvas.height / 2 - c.z * this.scale;
    this.draw();
  }

  private refreshFloorSidebar(): void {
    if (!this.floorListEl || !this.subfloorListEl) return;
    this.floorListEl.replaceChildren();
    this.subfloorListEl.replaceChildren();
    const tops = topLevelFloors(this.editFloors);
    const subs = this.editFloors.filter((f) => !!f.parentFloorId);
    if (tops.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'floor2d-zone-list__empty';
      empty.textContent = 'No floors yet — use Add Floor';
      this.floorListEl.appendChild(empty);
    }
    // View all = top-level floors only (subfloors never appear as stack peers)
    if (tops.length >= 2) {
      const viewAllBtn = document.createElement('button');
      viewAllBtn.type = 'button';
      viewAllBtn.className = 'floor2d-zone-item floor2d-zone-item--view-all';
      if (this.viewStack) viewAllBtn.classList.add('floor2d-zone-item--floor-active');
      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = '#5b8def';
      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      name.textContent = 'View all floors';
      viewAllBtn.append(dot, name);
      viewAllBtn.addEventListener('click', () => {
        this.activateViewAllFloors();
      });
      this.floorListEl.appendChild(viewAllBtn);
    }

    const appendFloorBtn = (
      floor: FloorLevel,
      indexLabel: string,
      target: HTMLElement,
      isSubfloor: boolean,
    ) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'floor2d-zone-item' + (isSubfloor ? ' floor2d-zone-item--subfloor' : '');
      if (floor.id === this.activeFloorId && !this.viewStack) {
        btn.classList.add('floor2d-zone-item--floor-active');
      }

      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = isSubfloor ? '#f59e0b' : FLOOR2D_STYLE.floorRegionBorder;

      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      const parent = floor.parentFloorId
        ? this.editFloors.find((f) => f.id === floor.parentFloorId)
        : null;
      name.textContent =
        (floor.label.trim() || indexLabel) +
        (parent ? ` · ${parent.label.trim() || 'Floor'}` : '');

      btn.append(dot, name);
      btn.addEventListener('click', () => {
        this.activateFloorLevel(floor.id);
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.activeFloorId = floor.id;
        void this.renameActiveFloor();
      });
      target.appendChild(btn);
    };

    for (let i = 0; i < tops.length; i++) {
      appendFloorBtn(tops[i], `Floor ${i + 1}`, this.floorListEl, false);
    }

    if (subs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'floor2d-zone-list__empty';
      empty.textContent = 'No subfloors yet — use Add Subfloor';
      this.subfloorListEl.appendChild(empty);
    } else {
      for (let i = 0; i < subs.length; i++) {
        appendFloorBtn(subs[i], `Subfloor ${i + 1}`, this.subfloorListEl, true);
      }
    }
  }

  private refreshZoneSidebar(): void {
    if (!this.zoneListEl) return;
    this.zoneListEl.replaceChildren();
    if (this.editZones.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'floor2d-zone-list__empty';
      empty.textContent = 'No zones yet — use Add Zone';
      this.zoneListEl.appendChild(empty);
      this.refreshZoneColorPanel();
      return;
    }
    for (const zone of this.editZones) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floor2d-zone-item';
      if (zone.id === this.selectedZoneId && this.isZoneEditTool()) {
        btn.classList.add('floor2d-zone-item--active');
      }

      const dot = document.createElement('span');
      dot.className = 'floor2d-zone-item__dot';
      dot.style.background = zone.stroke || FLOOR2D_STYLE.accent;

      const name = document.createElement('span');
      name.className = 'floor2d-zone-item__name';
      name.textContent = zone.label.trim() || 'Untitled zone';

      btn.append(dot, name);
      btn.addEventListener('click', () => {
        if (this.isZoneEditTool()) this.selectZone(zone.id);
        this.focusZone(zone);
      });
      this.zoneListEl.appendChild(btn);
    }
    this.refreshZoneColorPanel();
  }

  setOnToolChange(fn: (tool: Floor2DTool) => void): void {
    this.onToolChange = fn;
  }

  setOnDirtyChange(fn: (dirty: boolean) => void): void {
    this.onDirtyChange = fn;
  }

  setOnHistoryChange(fn: (canUndo: boolean, canRedo: boolean) => void): void {
    this.onHistoryChange = fn;
  }

  setOnZonesChange(fn: () => void): void {
    this.onZonesChange = fn;
  }

  setOnFloorsChange(fn: () => void): void {
    this.onFloorsChange = fn;
  }

  setOnRouteRebuild(fn: () => void): void {
    this.onRouteRebuild = fn;
  }

  setOnZoneSelectionChange(fn: (zoneId: string | null) => void): void {
    this.onZoneSelectionChange = fn;
    fn(this.selectedZoneId);
  }

  setOnStairMouthSelectionChange(
    fn: (sel: { mouthId: string | null; floorId: string | null; linked: boolean }) => void,
  ): void {
    this.onStairMouthSelectionChange = fn;
    fn(this.stairMouthSelectionState());
  }

  setOnFloorActivate(fn: (floor: FloorLevel) => void): void {
    this.onFloorActivate = fn;
  }

  setOnViewStackChange(fn: (on: boolean) => void): void {
    this.onViewStackChange = fn;
  }

  deleteSelectedZone(): boolean {
    if (!this.selectedZoneId) return false;
    this.pushHistory();
    this.editZones = this.editZones.filter((z) => z.id !== this.selectedZoneId);
    this.selectZone(null);
    this.notifyZonesChange();
    this.draw();
    return true;
  }

  selectObject(id: string | null): void {
    this.selectedObjectId = id;
    this.onObjectSelectionChange?.(id);
    this.draw();
  }

  deleteSelectedObject(): boolean {
    if (!this.selectedObjectId) return false;
    this.pushHistory();
    this.editObjects = this.editObjects.filter((o) => o.id !== this.selectedObjectId);
    this.objectEdit = null;
    this.selectObject(null);
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  /** Copy the selected object into the in-app clipboard (Edit Object tool). */
  copySelectedObject(): boolean {
    const src = this.editObjects.find((o) => o.id === this.selectedObjectId);
    if (!src) return false;
    this.objectClipboard = {
      ...src,
      points: src.points?.map((p) => ({ x: p.x, z: p.z })),
    };
    this.objectPasteCount = 0;
    this.onObjectClipboardChange?.(true);
    return true;
  }

  hasObjectClipboard(): boolean {
    return this.objectClipboard !== null;
  }

  /**
   * Paste the clipboard object. If the pointer is over the map, places the
   * copy centered there; otherwise offsets from the original.
   */
  pasteObjectClipboard(): boolean {
    const clip = this.objectClipboard;
    if (!clip || !this.map) return false;
    this.objectPasteCount += 1;
    let nx: number;
    let nz: number;
    if (this.lastPointerWorld) {
      const c = regionCentroid(clip);
      nx = this.lastPointerWorld.x - (c.x - clip.x);
      nz = this.lastPointerWorld.z - (c.z - clip.z);
    } else {
      const ox = 0.5 * this.objectPasteCount;
      const oz = 0.5 * this.objectPasteCount;
      nx = clip.x + ox;
      nz = clip.z + oz;
    }
    const dx = nx - clip.x;
    const dz = nz - clip.z;
    const copy: FloorBlock = {
      ...clip,
      id: `obj-${++this.objectIdSeq}`,
      x: nx,
      z: nz,
      points: clip.points?.map((p) => ({ x: p.x + dx, z: p.z + dz })),
      rotation: clip.rotation,
    };
    this.pushHistory();
    this.editObjects.push(copy);
    this.selectObject(copy.id);
    if (!this.isObjectEditTool()) this.setTool('object-edit');
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  /** Rotate selected object by delta degrees (default +90). */
  rotateSelectedObject(deltaDeg = 90): boolean {
    const obj = this.editObjects.find((o) => o.id === this.selectedObjectId);
    if (!obj) return false;
    this.pushHistory();
    obj.rotation = normalizeObjectRotation((obj.rotation ?? 0) + deltaDeg);
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  /** Uniformly scale selected object around its center. */
  scaleSelectedObject(factor: number, opts?: { history?: boolean }): boolean {
    const obj = this.editObjects.find((o) => o.id === this.selectedObjectId);
    if (!obj || !Number.isFinite(factor) || factor <= 0) return false;
    const f = Math.max(0.25, Math.min(4, factor));
    const cx = obj.x + obj.w / 2;
    const cz = obj.z + obj.d / 2;
    const nw = Math.max(MIN_BLOCK, obj.w * f);
    const nd = Math.max(MIN_BLOCK, obj.d * f);
    if (opts?.history !== false) this.pushHistory();
    obj.w = nw;
    obj.d = nd;
    obj.x = cx - nw / 2;
    obj.z = cz - nd / 2;
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  setOnObjectSelectionChange(fn: (objectId: string | null) => void): void {
    this.onObjectSelectionChange = fn;
    fn(this.selectedObjectId);
  }

  setOnObjectClipboardChange(fn: (hasClipboard: boolean) => void): void {
    this.onObjectClipboardChange = fn;
    fn(this.objectClipboard !== null);
  }

  deleteSelectedStairMouth(): boolean {
    const floorId = this.selectedStairMouthFloorId ?? this.activeFloorId;
    const floor = floorId ? this.editFloors.find((f) => f.id === floorId) : null;
    if (!floor?.stairMouths?.length || !this.selectedStairMouthId) return false;
    const mouth = floor.stairMouths.find((m) => m.id === this.selectedStairMouthId);
    if (!mouth) return false;
    this.pushHistory();
    if (mouth.linkedFloorId && mouth.linkedMouthId) {
      const linkedFloor = this.editFloors.find((f) => f.id === mouth.linkedFloorId);
      if (linkedFloor) unlinkStairMouth(linkedFloor, mouth.linkedMouthId);
    }
    floor.stairMouths = floor.stairMouths.filter((m) => m.id !== mouth.id);
    if (!floor.stairMouths.length) floor.stairMouths = undefined;
    if (this.map) {
      this.map = { ...this.map, floors: cloneFloorLevels(this.editFloors) };
    }
    this.selectStairMouth(null, null);
    this.pendingLinkMouthId = null;
    this.pendingLinkFloorId = null;
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  unlinkSelectedStairMouth(): boolean {
    const floorId = this.selectedStairMouthFloorId ?? this.activeFloorId;
    const floor = floorId ? this.editFloors.find((f) => f.id === floorId) : null;
    if (!floor?.stairMouths?.length || !this.selectedStairMouthId) return false;
    const mouth = floor.stairMouths.find((m) => m.id === this.selectedStairMouthId);
    if (!mouth?.linkedFloorId || !mouth.linkedMouthId) return false;
    this.pushHistory();
    const linkedFloor = this.editFloors.find((f) => f.id === mouth.linkedFloorId);
    if (linkedFloor) unlinkStairMouth(linkedFloor, mouth.linkedMouthId);
    unlinkStairMouth(floor, mouth.id);
    if (this.map) {
      this.map = { ...this.map, floors: cloneFloorLevels(this.editFloors) };
    }
    this.notifyStairMouthSelection();
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  deleteActiveFloor(): boolean {
    if (!this.activeFloorId) return false;
    this.flushCurrentFloorState();
    const removed = this.activeFloorId;
    const removedFloor = this.editFloors.find((f) => f.id === removed);
    this.pushHistory();

    // Deleting a parent also removes its subfloors.
    const removeIds = new Set<string>([removed]);
    if (removedFloor && isTopLevelFloor(removedFloor)) {
      for (const child of subfloorsOf(this.editFloors, removed)) {
        removeIds.add(child.id);
      }
    }

    // Break stair-mouth links that point at any removed floor.
    for (const f of this.editFloors) {
      if (removeIds.has(f.id) || !f.stairMouths?.length) continue;
      for (const m of f.stairMouths) {
        if (m.linkedFloorId && removeIds.has(m.linkedFloorId)) {
          m.linkedFloorId = undefined;
          m.linkedMouthId = undefined;
        }
      }
    }

    const parentId = removedFloor?.parentFloorId;
    this.editFloors = this.editFloors.filter((f) => !removeIds.has(f.id));
    if (this.selectedStairMouthFloorId && removeIds.has(this.selectedStairMouthFloorId)) {
      this.selectStairMouth(null, null);
    }

    // Prefer parent after deleting a subfloor; otherwise first top-level.
    this.activeFloorId =
      (parentId && this.editFloors.some((f) => f.id === parentId) ? parentId : null) ??
      topLevelFloors(this.editFloors)[0]?.id ??
      this.editFloors[0]?.id ??
      null;
    const next = this.getActiveFloor();
    if (next && this.map) {
      this.map = { ...this.map, sliceY: next.floorY };
      this.applyFloorLevelToCanvas(next);
    }
    if (this.map) {
      this.map = { ...this.map, floors: cloneFloorLevels(this.editFloors) };
    }
    this.refreshFloorSidebar();
    this.notifyFloorsChange();
    if (next) this.onFloorActivate?.(next);
    this.onRouteRebuild?.();
    this.draw();
    return true;
  }

  /** Zones available as origin/destination (navigate to center point). */
  getRouteZones(): { id: string; label: string }[] {
    return this.editZones.map((z) => ({
      id: z.id,
      label: z.label.trim() || 'Untitled zone',
    }));
  }

  /** Named floors and subfloors for origin/destination routing. */
  getRouteFloors(): { id: string; label: string; floorY?: number }[] {
    return this.editFloors.map((f) => ({
      id: f.id,
      label:
        (f.parentFloorId ? 'Subfloor: ' : '') +
        (f.label.trim() || (f.parentFloorId ? 'Untitled subfloor' : 'Untitled floor')),
      floorY: f.floorY,
    }));
  }

  /**
   * Route on painted walkable floor (A* grid) — avoids objects/blocks, not Recast nav mesh.
   */
  computeRoutePath(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    floorY: number,
  ): { path: { x: number; y: number; z: number }[]; error?: string } {
    if (!this.map || !this.editWalk) {
      return { path: [], error: 'Floor map not ready' };
    }
    const out = findPathOnFloorGrid(
      this.map,
      this.editWalk,
      this.editObjects,
      startX,
      startZ,
      endX,
      endZ,
      floorY,
    );
    if ('error' in out) return { path: [], error: out.error };
    return { path: out.path };
  }

  usesStackedLayout(): boolean {
    return topLevelFloors(this.editFloors).length >= 2;
  }

  private finishMouthLink(
    floorAId: string,
    mouthAId: string,
    floorBId: string,
    mouthBId: string,
  ): boolean {
    const ok = linkStairMouths(this.editFloors, floorAId, mouthAId, floorBId, mouthBId);
    if (ok) {
      this.pendingLinkMouthId = null;
      this.pendingLinkFloorId = null;
      this.onRouteRebuild?.();
      this.notifyFloorsChange();
    }
    return ok;
  }

  private pendingLinkFloorLabel(): string | null {
    if (!this.pendingLinkFloorId) return null;
    const floor = this.editFloors.find((f) => f.id === this.pendingLinkFloorId);
    return floor?.label?.trim() || null;
  }

  hasValidRoute(): boolean {
    if (this.routeSegments.length > 0) {
      return this.routeSegments.some((s) => s.path.length >= 2);
    }
    return this.path.length >= 2;
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
    const refit3d = this.routeSegments.length === 0 && segments.length > 0;
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
    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      this.syncScene3d(refit3d);
      return;
    }
    this.draw();
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
    const plan = computeMultiFloorRoute(
      this.map,
      this.editFloors,
      navMesh,
      origin,
      destination,
      this.editWalk,
      this.activeFloorId,
      this.editObjects,
    );
    const mouthOnly = routeUsesManualStairMouths(plan.connectors);
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

  resolveRouteEndpoint(
    id: string,
    sliceY: number,
  ): { x: number; y: number; z: number; name: string } | null {
    const floorId = parseFloorRouteId(id);
    if (floorId) {
      const floor = this.editFloors.find((f) => f.id === floorId);
      if (!floor || !this.map) return null;
      const x = (this.map.minX + this.map.maxX) * 0.5;
      const z = (this.map.minZ + this.map.maxZ) * 0.5;
      return { x, y: floor.floorY, z, name: floor.label.trim() || 'Untitled floor' };
    }
    const zoneId = parseZoneRouteId(id);
    if (zoneId) {
      const zone = this.editZones.find((z) => z.id === zoneId);
      if (!zone) return null;
      const c = zoneCentroid(zone);
      return { x: c.x, y: sliceY, z: c.z, name: zone.label.trim() || 'Untitled zone' };
    }
    const poi = this.pois.find((p) => p.id === id) ?? findNavMapPoi(id);
    if (poi) return { x: poi.x, y: poi.y, z: poi.z, name: poi.name };
    return null;
  }

  private notifyZonesChange(): void {
    this.onZonesChange?.();
  }

  private notifyFloorsChange(): void {
    this.onFloorsChange?.();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap || !this.editWalk) return false;
    this.redoStack.push(this.cloneSnapshot()!);
    this.editWalk = snap.walk;
    this.editObjects = cloneBlocks(snap.objects);
    this.editZones = cloneBlocks(snap.zones);
    this.invalidatePreview();
    if (this.selectedZoneId && !this.editZones.some((z) => z.id === this.selectedZoneId)) {
      this.selectedZoneId = null;
    }
    if (this.selectedObjectId && !this.editObjects.some((o) => o.id === this.selectedObjectId)) {
      this.selectedObjectId = null;
      this.onObjectSelectionChange?.(null);
    }
    this.flushCurrentFloorState();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.syncEditState();
    this.draw();
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap || !this.editWalk) return false;
    this.undoStack.push(this.cloneSnapshot()!);
    this.editWalk = snap.walk;
    this.editObjects = cloneBlocks(snap.objects);
    this.editZones = cloneBlocks(snap.zones);
    this.invalidatePreview();
    if (this.selectedZoneId && !this.editZones.some((z) => z.id === this.selectedZoneId)) {
      this.selectedZoneId = null;
    }
    if (this.selectedObjectId && !this.editObjects.some((o) => o.id === this.selectedObjectId)) {
      this.selectedObjectId = null;
      this.onObjectSelectionChange?.(null);
    }
    this.flushCurrentFloorState();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.syncEditState();
    this.draw();
    return true;
  }

  setTool(tool: Floor2DTool): void {
    this.tool = tool;
    if (tool !== 'zone') this.polygonDraft = null;
    if (tool !== 'zone-edit') this.zoneEdit = null;
    if (tool !== 'object-edit') this.objectEdit = null;
    if (tool !== 'stair-mouth-edit') this.mouthEdit = null;
    if (tool !== 'stair-mouth' && tool !== 'stair-mouth-edit') {
      this.pendingLinkMouthId = null;
      this.pendingLinkFloorId = null;
      this.selectedStairMouthId = null;
      this.selectedStairMouthFloorId = null;
      this.notifyStairMouthSelection();
    }
    if (tool === 'zone') this.selectedZoneId = null;
    else if (tool !== 'zone-edit') this.selectedZoneId = null;
    if (tool !== 'object-edit') this.selectedObjectId = null;
    else this.onObjectSelectionChange?.(this.selectedObjectId);
    if (tool === 'pan') this.canvas.style.cursor = 'grab';
    else if (tool === 'zone-edit' || tool === 'object-edit' || tool === 'stair-mouth-edit') {
      this.canvas.style.cursor = 'default';
    }
    else this.canvas.style.cursor = 'crosshair';
    this.onToolChange?.(tool);
    this.refreshZoneSidebar();
    this.syncPaintShapeToolbar();
    if ((tool === 'stair-mouth' || tool === 'stair-mouth-edit') && this.viewStack) {
      this.viewStack = false;
      this.disableMultiFloor3dView();
      this.onViewStackChange?.(false);
    }
    if (tool === 'stair-mouth' || tool === 'stair-mouth-edit') {
      this.ensureActiveFloorForMouths();
    }
    if (this.usesStackedLayout()) {
      this.fit();
      if (tool === 'pan' && this.viewStack) this.enableMultiFloor3dView();
      else if (this.multiFloor3dAuto) this.disableMultiFloor3dView();
    }
    this.draw();
  }

  private isZoneEditTool(): boolean {
    return this.tool === 'zone-edit';
  }

  private isObjectEditTool(): boolean {
    return this.tool === 'object-edit';
  }

  getTool(): Floor2DTool {
    return this.tool;
  }

  setObjectShape(shape: FloorShape): void {
    this.objectShape = shape;
    this.objectMaterial = null;
    this.draw();
  }

  getObjectShape(): FloorShape {
    return this.objectShape;
  }

  /** Choose a catalog material to place with the Object tool (null = freehand). */
  setObjectMaterial(material: ObjectCatalogItem | null): void {
    this.objectMaterial = material;
    if (material) this.objectShape = material.shape;
    this.draw();
  }

  getObjectMaterial(): ObjectCatalogItem | null {
    return this.objectMaterial;
  }

  setObjectParamCount(count: number): void {
    this.objectParamCount = Math.max(1, Math.min(100, Math.round(count)));
    this.draw();
  }

  getObjectParamCount(): number {
    return this.objectParamCount;
  }

  private materialFootprint(mat: ObjectCatalogItem): { w: number; d: number } {
    if (mat.kind === 'chair-row') return chairGridFootprint(this.objectParamCount);
    return { w: mat.w, d: mat.d };
  }

  private buildMaterialBlock(
    mat: ObjectCatalogItem,
    cx: number,
    cz: number,
    footprint?: { w: number; d: number },
  ): FloorBlock {
    const { w, d } = footprint ?? this.materialFootprint(mat);
    const block: FloorBlock = {
      id: `obj-${++this.objectIdSeq}`,
      x: cx - w / 2,
      z: cz - d / 2,
      w,
      d,
      fill: FLOOR2D_STYLE.object,
      stroke: FLOOR2D_STYLE.interiorWall,
      label: '',
      shape: mat.shape,
      kind: mat.kind,
    };
    if (mat.countParam || mat.kind === 'chair-row') {
      block.count = this.objectParamCount;
    }
    return block;
  }

  /** Drop a catalog material centered at world (x, z) using its default footprint. */
  private placeMaterialAt(mat: ObjectCatalogItem, cx: number, cz: number): void {
    if (!this.map) return;
    this.pushHistory();
    this.editObjects.push(this.buildMaterialBlock(mat, cx, cz));
    this.onRouteRebuild?.();
    this.draw();
  }

  setPaintShape(shape: PaintShape): void {
    if (this.paintShape === shape) return;
    this.paintShape = shape;
    this.draft = null;
    this.brushStroke = null;
    this.syncPaintShapeToolbar();
    this.draw();
  }

  getPaintShape(): PaintShape {
    return this.paintShape;
  }

  private isPaintTool(): boolean {
    return this.tool === 'add' || this.tool === 'cut';
  }

  isDirty(): boolean {
    return this.dirty;
  }

  saveEdits(): boolean {
    if (!this.map || !this.editWalk) return false;
    this.flushCurrentFloorState();
    this.map = applyWalkGridEdits(this.map, this.editWalk, this.editObjects, this.editZones, this.editFloors);
    this.clearHistory();
    this.draw();
    return true;
  }

  hasMap(): boolean {
    return this.map !== null && this.editWalk !== null;
  }

  /** Snapshot for DB persistence (includes walk grid + named zones). */
  exportEditPayload(sliceY: number, mapCode: string): NavmeFloorEditPayload | null {
    if (!this.map || !this.editWalk) return null;
    this.flushCurrentFloorState();
    const active = this.getActiveFloor();
    return buildFloorEditPayload(
      this.map,
      this.editWalk,
      this.editObjects,
      this.editZones,
      this.editFloors,
      active?.floorY ?? sliceY,
      mapCode,
    );
  }

  getEditStateForSave(): {
    map: Floor2DMap;
    walk: Uint8Array;
    objects: FloorBlock[];
    zones: FloorBlock[];
    floors: FloorLevel[];
  } | null {
    if (!this.map || !this.editWalk) return null;
    this.flushCurrentFloorState();
    return {
      map: { ...this.map, floors: cloneFloorLevels(this.editFloors) },
      walk: this.editWalk,
      objects: cloneBlocks(this.editObjects),
      zones: cloneBlocks(this.editZones),
      floors: cloneFloorLevels(this.editFloors),
    };
  }

  setMap(map: Floor2DMap, options: { preserveFloors?: boolean; activeFloorId?: string | null } = {}): void {
    const preserveFloors = options.preserveFloors === true;
    const incomingFloors = map.floors ?? [];

    if (!preserveFloors) {
      if (incomingFloors.length > 0) {
        this.editFloors = cloneFloorLevels(incomingFloors);
        this.floorIdSeq = this.editFloors.reduce((max, f) => {
          const m = /^(?:floor|subfloor)-(\d+)$/.exec(f.id);
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0);
        const match =
          this.editFloors.find((f) => Math.abs(f.floorY - map.sliceY) < 1e-4) ??
          this.editFloors[0] ??
          null;
        this.activeFloorId = options.activeFloorId ?? match?.id ?? null;
      } else if (this.editFloors.length === 0) {
        this.activeFloorId = options.activeFloorId ?? null;
      } else if (options.activeFloorId !== undefined) {
        this.activeFloorId = options.activeFloorId;
      }
    } else if (options.activeFloorId !== undefined) {
      this.activeFloorId = options.activeFloorId;
    }

    this.map = { ...map, floors: cloneFloorLevels(this.editFloors) };
    const active = this.getActiveFloor();
    if (active) {
      this.applyFloorLevelToCanvas(active);
    } else {
      const blocks = map.corridors.length > 0 ? map.corridors : map.blocks;
      this.editWalk = walkGridFromBlocks(map, blocks);
      this.editObjects = cloneBlocks(map.objects ?? []);
      this.editZones = cloneBlocks(map.zones ?? []);
    }
    this.invalidatePreview();

    this.objectIdSeq = this.editObjects.reduce((max, o) => {
      const m = /^obj-(\d+)$/.exec(o.id);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    this.zoneIdSeq = this.editZones.reduce((max, z) => {
      const m = /^zone-(\d+)$/.exec(z.id);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    this.selectedZoneId = null;
    this.polygonDraft = null;
    this.clearHistory();
    if (map.corridors.length > 0 || map.blocks.length > 0) {
      this.cachedPreviewMap = {
        ...this.map,
        objects: cloneBlocks(this.editObjects),
        zones: cloneBlocks(this.editZones),
        floors: cloneFloorLevels(this.editFloors),
      };
      this.previewDirty = false;
    } else {
      this.invalidatePreview();
    }
    this.fit();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.notifyFloorsChange();
    this.draw();
  }

  /**
   * Replace the active floor's walk/walls/corridors with a navmesh-derived plan
   * (same data 2D + 3D Plan use). Keeps objects, zones, and floor list.
   */
  replaceStructureFromNavMesh(map: Floor2DMap, walk: Uint8Array): void {
    this.fullBuilding3d = false;
    this.flushCurrentFloorState();
    const objects = cloneBlocks(this.editObjects);
    const zones = cloneBlocks(this.editZones);
    const floors = cloneFloorLevels(this.editFloors);

    this.map = {
      ...map,
      objects,
      zones,
      floors,
      sliceY: map.sliceY,
    };
    this.editWalk = new Uint8Array(walk);
    this.editObjects = objects;
    this.editZones = zones;

    const active = this.getActiveFloor();
    if (active) {
      active.walkGrid = Array.from(walk);
      active.objects = cloneBlocks(objects);
      active.zones = cloneBlocks(zones);
      active.gridCols = map.cols;
      active.gridRows = map.rows;
      active.gridCellSize = map.cellSize;
      active.gridMinX = map.minX;
      active.gridMinZ = map.minZ;
    } else if (floors.length === 0) {
      const floor: FloorLevel = {
        id: `floor-${++this.floorIdSeq}`,
        label: defaultFloorLabel(1),
        floorY: map.sliceY,
        walkGrid: Array.from(walk),
        objects: cloneBlocks(objects),
        zones: cloneBlocks(zones),
        gridCols: map.cols,
        gridRows: map.rows,
        gridCellSize: map.cellSize,
        gridMinX: map.minX,
        gridMinZ: map.minZ,
      };
      this.editFloors = [floor];
      this.activeFloorId = floor.id;
      this.map.floors = cloneFloorLevels(this.editFloors);
    }

    this.dirty = true;
    this.onDirtyChange?.(true);
    this.clearHistory();
    this.invalidatePreview();
    this.cachedPreviewMap = {
      ...this.map,
      corridors: map.corridors,
      stores: map.stores,
      walls: map.walls,
      blocks: map.blocks,
      objects: cloneBlocks(this.editObjects),
      zones: cloneBlocks(this.editZones),
      floors: cloneFloorLevels(this.editFloors),
    };
    this.previewDirty = false;
    this.fit();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.notifyFloorsChange();
    if (this.scene3dWanted()) this.syncScene3d(true);
    else this.draw();
  }

  /**
   * Replace the entire floor list with a full-building navmesh convert
   * (all Y plates from the VPS GLB). Enables full-building 3D Plan.
   */
  replaceAllFloorsFromNavMesh(
    map: Floor2DMap,
    floorLevels: FloorLevel[],
    activeFloorId?: string | null,
  ): void {
    if (floorLevels.length === 0) return;

    this.fullBuilding3d = topLevelFloors(floorLevels).length >= 2;
    this.editFloors = cloneFloorLevels(floorLevels);
    this.floorIdSeq = this.editFloors.reduce((max, f) => {
      const m = /^(?:floor|subfloor)-(\d+)$/.exec(f.id);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, this.editFloors.length);

    const preferId = activeFloorId ?? null;
    const active =
      (preferId ? this.editFloors.find((f) => f.id === preferId) : null) ??
      this.editFloors[this.editFloors.length - 1] ??
      this.editFloors[0];
    this.activeFloorId = active.id;

    this.map = {
      ...map,
      sliceY: active.floorY,
      floors: cloneFloorLevels(this.editFloors),
      objects: [],
      zones: [],
    };

    this.applyFloorLevelToCanvas(active);
    this.dirty = true;
    this.onDirtyChange?.(true);
    this.clearHistory();
    this.invalidatePreview();
    this.fit();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.notifyFloorsChange();
    if (this.scene3dWanted()) this.syncScene3d(true);
    else this.draw();
  }

  isFullBuilding3d(): boolean {
    return this.fullBuilding3d;
  }

  /**
   * Convert uploaded floor-plan files into painted walk + cut voids
   * (same data as Add Floor / Cut tools). Does not show the source image.
   */
  async applyUploadedFloorPlans(
    assets: {
      dataUrl: string;
      fileName: string;
      floorIndex: number | null;
      label: string;
      width: number;
      height: number;
    }[],
    options: {
      trace?: boolean;
      metersWide?: number;
      sliceYStart?: number;
      floorHeight?: number;
    } = {},
  ): Promise<{ floors: number; traced: number; paintedCells: number; cutCells: number }> {
    if (assets.length === 0) return { floors: 0, traced: 0, paintedCells: 0, cutCells: 0 };
    const { traceFloorPlanImage } = await import('./floorPlanTrace');
    const doTrace = options.trace !== false;
    const floorHeight = options.floorHeight ?? 3.2;
    const sliceYStart = options.sliceYStart ?? this.map?.sliceY ?? 0;

    this.flushCurrentFloorState();

    // Assign assets to floor slots
    const slots: {
      asset: (typeof assets)[0];
      index: number;
      label: string;
      floorY: number;
    }[] = [];

    const numbered = assets.filter((a) => a.floorIndex != null);
    const unassigned = assets.filter((a) => a.floorIndex == null);

    if (numbered.length > 0) {
      const sorted = [...numbered].sort(
        (a, b) => (a.floorIndex ?? 0) - (b.floorIndex ?? 0),
      );
      for (const asset of sorted) {
        const idx = asset.floorIndex ?? 1;
        slots.push({
          asset,
          index: idx,
          label: asset.label,
          floorY: sliceYStart + (idx - 1) * floorHeight,
        });
      }
    } else if (unassigned.length === 1 && this.getActiveFloor()) {
      const active = this.getActiveFloor()!;
      slots.push({
        asset: unassigned[0],
        index: 1,
        label: active.label || unassigned[0].label,
        floorY: active.floorY,
      });
    } else {
      unassigned.forEach((asset, i) => {
        slots.push({
          asset,
          index: i + 1,
          label: asset.label || defaultFloorLabel(i + 1),
          floorY: sliceYStart + i * floorHeight,
        });
      });
    }

    const newFloors: FloorLevel[] = [];
    let traced = 0;
    let paintedCells = 0;
    let cutCells = 0;
    let baseMap: Floor2DMap | null = null;
    // Uploads define their own world frame — do not stretch into an existing VPS map.
    let sharedFrame: {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      cellSize: number;
    } | null = null;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      let walk: Uint8Array | null = null;
      let layerMap: Floor2DMap | null = null;

      if (doTrace) {
        try {
          const result = await traceFloorPlanImage(slot.asset.dataUrl, {
            sliceY: slot.floorY,
            metersWide: options.metersWide ?? 28,
            fitToMap: sharedFrame,
            ignoreFitToMap: !sharedFrame,
            cellSize: sharedFrame ? Math.min(sharedFrame.cellSize, 0.12) : 0.12,
            wallThreshold: 0.35,
          });
          walk = result.walk;
          layerMap = result.map;
          paintedCells += result.walkCells;
          cutCells += walk.length - result.walkCells;
          if (!sharedFrame) {
            sharedFrame = {
              minX: result.map.minX,
              maxX: result.map.maxX,
              minZ: result.map.minZ,
              maxZ: result.map.maxZ,
              cellSize: result.map.cellSize,
            };
          }
          if (!baseMap) baseMap = result.map;
          traced++;
        } catch (err) {
          console.warn('[applyUploadedFloorPlans] trace failed', slot.asset.fileName, err);
        }
      }

      if (!layerMap && baseMap) {
        layerMap = {
          ...baseMap,
          sliceY: slot.floorY,
          corridors: [],
          stores: [],
          walls: [],
          blocks: [],
          objects: [],
          zones: [],
          floors: [],
        };
        walk = new Uint8Array(baseMap.cols * baseMap.rows);
      }

      if (!layerMap || !walk) continue;

      const existing =
        slots.length === 1
          ? this.getActiveFloor()
          : this.editFloors.find((f) => Math.abs(f.floorY - slot.floorY) < 0.05);

      const floor: FloorLevel = {
        id: existing?.id ?? `floor-${++this.floorIdSeq}`,
        label: slot.label,
        floorY: existing?.floorY ?? slot.floorY,
        walkGrid: Array.from(walk),
        objects: existing?.objects ? cloneBlocks(existing.objects) : [],
        zones: existing?.zones ? cloneBlocks(existing.zones) : [],
        stairMouths: existing?.stairMouths ? [...existing.stairMouths] : [],
        gridCols: layerMap.cols,
        gridRows: layerMap.rows,
        gridCellSize: layerMap.cellSize,
        gridMinX: layerMap.minX,
        gridMinZ: layerMap.minZ,
      };
      newFloors.push(floor);
      if (!baseMap) baseMap = layerMap;
    }

    if (newFloors.length === 0 || !baseMap) {
      return { floors: 0, traced: 0, paintedCells: 0, cutCells: 0 };
    }

    if (newFloors.length === 1 && this.editFloors.length > 1 && this.getActiveFloor()) {
      const updated = newFloors[0];
      const idx = this.editFloors.findIndex((f) => f.id === updated.id);
      if (idx >= 0) this.editFloors[idx] = updated;
      else this.editFloors.push(updated);
      this.map = {
        ...baseMap,
        sliceY: updated.floorY,
        floors: cloneFloorLevels(this.editFloors),
        objects: updated.objects ?? [],
        zones: updated.zones ?? [],
      };
      this.activeFloorId = updated.id;
      this.applyFloorLevelToCanvas(updated);
    } else {
      this.fullBuilding3d = newFloors.length >= 2;
      this.editFloors = cloneFloorLevels(newFloors);
      const active = this.editFloors[0];
      this.activeFloorId = active.id;
      this.map = {
        ...baseMap,
        sliceY: active.floorY,
        floors: cloneFloorLevels(this.editFloors),
        objects: [],
        zones: [],
      };
      this.applyFloorLevelToCanvas(active);
    }

    // Rebuild corridors/walls from walk — same as Save after painting/cutting
    if (this.map && this.editWalk) {
      this.map = applyWalkGridEdits(
        this.map,
        this.editWalk,
        this.editObjects,
        this.editZones,
        this.editFloors,
      );
    }

    this.dirty = true;
    this.onDirtyChange?.(true);
    this.clearHistory();
    this.invalidatePreview();
    this.fit();
    this.refreshFloorSidebar();
    this.refreshZoneSidebar();
    this.notifyZonesChange();
    this.notifyFloorsChange();
    this.setViewMode('plan2d');
    this.draw();
    return {
      floors: this.editFloors.length,
      traced,
      paintedCells,
      cutCells,
    };
  }

  setPath(points: { x: number; y: number; z: number }[]): void {
    this.routeSegments = [];
    this.routeConnectors = [];
    this.routeError = null;
    this.routeDebugForward = [];
    this.routeDebugReverse = [];
    this.routeBreakPoints = [];
    this.path = points.map((p) => ({ x: p.x, z: p.z }));
    this.draw();
  }

  setPois(pois: NavMapPoi[], originId: string, destId: string): void {
    this.pois = pois;
    this.originId = originId;
    this.destId = destId;
    this.draw();
  }

  isNavMeshVisible(): boolean {
    return this.showNavMesh;
  }

  setNavMeshVisible(visible: boolean, navMesh: NavMesh | null, sliceY: number): void {
    this.showNavMesh = visible;
    if (!visible || !navMesh) {
      this.navMeshTris = [];
      this.draw();
      return;
    }
    try {
      this.navMeshTris = extractNavMeshSlice2D(navMesh, sliceY);
    } catch {
      this.navMeshTris = [];
    }
    this.draw();
  }

  refreshNavMeshOverlay(navMesh: NavMesh | null, sliceY: number): void {
    if (!this.showNavMesh) return;
    this.setNavMeshVisible(true, navMesh, sliceY);
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.scene3d?.resize(w, h);
    this.draw();
  }

  fit(): void {
    if (!this.map) return;
    if (this.usesStackedPlate3d()) {
      return;
    }
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.scale = Math.min((w * 0.9) / mapW, (h * 0.9) / mapH) * dpr;
    this.offsetX = (this.canvas.width - mapW * this.scale) / 2 - this.map.minX * this.scale;
    this.offsetY = (this.canvas.height - mapH * this.scale) / 2 - this.map.minZ * this.scale;
  }

  private fitStackedView(): void {
    if (!this.map) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    const mapW = this.map.maxX - this.map.minX;
    const mapH = this.map.maxZ - this.map.minZ;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const layerCount = this.editFloors.length;
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
    this.offsetX = (this.canvas.width - mapW * this.scale) / 2 - this.map.minX * this.scale;
    this.offsetY = (this.canvas.height - contentH) / 2 - this.map.minZ * this.scale;
  }

  /** Top-level floors only — used for View-all stacking / 3D plates. */
  private sortedFloors(): FloorLevel[] {
    return [...topLevelFloors(this.editFloors)].sort((a, b) => a.floorY - b.floorY);
  }

  /** Visible air gap between stacked floor plates. */
  private stackGapPx(dpr: number): number {
    return 48 * dpr;
  }

  private plateThicknessPx(dpr: number): number {
    return 7 * dpr;
  }

  private platePadPx(dpr: number): number {
    return 8 * dpr;
  }

  /** Lower floor at bottom; each higher floor stacks upward. */
  private stackLayerDy(layerIndex: number, mapH: number, gapPx: number, dpr: number): number {
    const pad = this.platePadPx(dpr);
    const plateThickness = this.plateThicknessPx(dpr);
    const plateH = mapH * this.scale + pad * 2 + plateThickness;
    return -layerIndex * (plateH + gapPx);
  }

  private layerDyForFloorId(
    floorId: string,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
    dpr: number,
  ): number {
    const idx = floors.findIndex((f) => f.id === floorId);
    return idx >= 0 ? this.stackLayerDy(idx, mapH, gapPx, dpr) : 0;
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

  private cloneSnapshot(): EditSnapshot | null {
    if (!this.editWalk) return null;
    return {
      walk: new Uint8Array(this.editWalk),
      objects: cloneBlocks(this.editObjects),
      zones: cloneBlocks(this.editZones),
    };
  }

  private pushHistory(): void {
    this.invalidatePreview();
    const snap = this.cloneSnapshot();
    if (!snap) return;
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncEditState();
  }

  private clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.syncEditState();
  }

  private syncEditState(): void {
    const dirty = this.undoStack.length > 0;
    if (this.dirty !== dirty) {
      this.dirty = dirty;
      this.onDirtyChange?.(dirty);
    }
    this.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  private invalidatePreview(): void {
    this.previewDirty = true;
    this.cachedPreviewMap = null;
  }

  private previewMap(): Floor2DMap | null {
    if (!this.map || !this.editWalk) return null;
    if (!this.previewDirty && this.cachedPreviewMap) return this.cachedPreviewMap;
    this.cachedPreviewMap = applyWalkGridEdits(
      this.map,
      this.editWalk,
      this.editObjects,
      this.editZones,
      this.editFloors,
    );
    this.previewDirty = false;
    return this.cachedPreviewMap;
  }

  private scheduleDraw(): void {
    if (this.drawRaf) return;
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = 0;
      this.draw();
    });
  }

  private wx(x: number): number {
    return x * this.scale + this.offsetX;
  }

  private wz(z: number): number {
    return z * this.scale + this.offsetY;
  }

  private canvasCenterDevice(): { cx: number; cy: number } {
    return { cx: this.canvas.width / 2, cy: this.canvas.height / 2 };
  }

  private unrotateScreen(sx: number, sy: number): { sx: number; sy: number } {
    if (Math.abs(this.viewRotation) < 1e-6) return { sx, sy };
    const { cx, cy } = this.canvasCenterDevice();
    const dx = sx - cx;
    const dy = sy - cy;
    const cos = Math.cos(-this.viewRotation);
    const sin = Math.sin(-this.viewRotation);
    return { sx: cx + dx * cos - dy * sin, sy: cy + dx * sin + dy * cos };
  }

  private rotateScreen(sx: number, sy: number): { sx: number; sy: number } {
    if (Math.abs(this.viewRotation) < 1e-6) return { sx, sy };
    const { cx, cy } = this.canvasCenterDevice();
    const dx = sx - cx;
    const dy = sy - cy;
    const cos = Math.cos(this.viewRotation);
    const sin = Math.sin(this.viewRotation);
    return { sx: cx + dx * cos - dy * sin, sy: cy + dx * sin + dy * cos };
  }

  private worldToDevice(x: number, z: number): { sx: number; sy: number } {
    const flatSx = x * this.scale + this.offsetX;
    const flatSy = z * this.scale + this.offsetY;
    return this.rotateScreen(flatSx, flatSy);
  }

  private pointerAngleFromCenter(clientX: number, clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx);
  }

  private beginViewNavigation(e: PointerEvent): boolean {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      this.navPanning = true;
      this.canvas.style.cursor = 'grabbing';
      return true;
    }
    if (e.button === 0 && e.shiftKey) {
      e.preventDefault();
      this.rotateDragging = true;
      this.rotateStartAngle = this.pointerAngleFromCenter(e.clientX, e.clientY);
      this.rotateStartViewRotation = this.viewRotation;
      this.canvas.style.cursor = 'grab';
      return true;
    }
    return false;
  }

  private screenToDevice(clientX: number, clientY: number): { sx: number; sy: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    let sy = (clientY - rect.top) * dpr;
    if (this.viewStack && this.usesStackedLayout() && this.tool !== 'pan' && this.map && this.activeFloorId) {
      const floors = this.sortedFloors();
      const gapPx = this.stackGapPx(dpr);
      const mapH = this.map.maxZ - this.map.minZ;
      sy -= this.layerDyForFloorId(this.activeFloorId, floors, mapH, gapPx, dpr);
    }
    return { sx: (clientX - rect.left) * dpr, sy };
  }

  private deviceToWorld(sx: number, sy: number): { x: number; z: number } {
    const unrot = this.unrotateScreen(sx, sy);
    return {
      x: (unrot.sx - this.offsetX) / this.scale,
      z: (unrot.sy - this.offsetY) / this.scale,
    };
  }

  private draftScreenRect(): { left: number; top: number; w: number; h: number } | null {
    if (!this.draft) return null;
    const left = Math.min(this.draft.sx0, this.draft.sx1);
    const top = Math.min(this.draft.sy0, this.draft.sy1);
    const w = Math.abs(this.draft.sx1 - this.draft.sx0);
    const h = Math.abs(this.draft.sy1 - this.draft.sy0);
    return { left, top, w, h };
  }

  /** Screen-rect corners → world X/Z (matches on-screen rectangle after map rotation). */
  private draftWorldCorners(): FloorPoint[] | null {
    const box = this.draftScreenRect();
    if (!box || box.w < 1 || box.h < 1) return null;
    const { left, top, w, h } = box;
    const deviceCorners = [
      { sx: left, sy: top },
      { sx: left + w, sy: top },
      { sx: left + w, sy: top + h },
      { sx: left, sy: top + h },
    ];
    return deviceCorners.map(({ sx, sy }) => this.deviceToWorld(sx, sy));
  }

  private draftScreenTriangle(): { sx: number; sy: number }[] | null {
    const box = this.draftScreenRect();
    if (!box || box.w < 1 || box.h < 1) return null;
    const { left, top, w, h } = box;
    return [
      { sx: left + w / 2, sy: top },
      { sx: left + w, sy: top + h },
      { sx: left, sy: top + h },
    ];
  }

  private paintDeviceEllipseOnWalk(
    centerSx: number,
    centerSy: number,
    radiusX: number,
    radiusY: number,
    value: 0 | 1,
  ): void {
    if (!this.map || !this.editWalk || radiusX < 0.5 || radiusY < 0.5) return;
    const bboxCorners = [
      { sx: centerSx - radiusX, sy: centerSy - radiusY },
      { sx: centerSx + radiusX, sy: centerSy - radiusY },
      { sx: centerSx + radiusX, sy: centerSy + radiusY },
      { sx: centerSx - radiusX, sy: centerSy + radiusY },
    ].map((p) => this.deviceToWorld(p.sx, p.sy));
    const bounds = boundsFromPoints(bboxCorners);
    const cell = this.map.cellSize;
    const c0 = Math.max(0, Math.floor((bounds.x - this.map.minX) / cell));
    const c1 = Math.min(this.map.cols - 1, Math.ceil((bounds.x + bounds.w - this.map.minX) / cell) - 1);
    const r0 = Math.max(0, Math.floor((bounds.z - this.map.minZ) / cell));
    const r1 = Math.min(this.map.rows - 1, Math.ceil((bounds.z + bounds.d - this.map.minZ) / cell) - 1);
    const rx2 = Math.max(radiusX * radiusX, 1e-6);
    const ry2 = Math.max(radiusY * radiusY, 1e-6);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const wx = this.map.minX + (c + 0.5) * cell;
        const wz = this.map.minZ + (r + 0.5) * cell;
        const dev = this.worldToDevice(wx, wz);
        const dx = dev.sx - centerSx;
        const dy = dev.sy - centerSy;
        if ((dx * dx) / rx2 + (dy * dy) / ry2 <= 1) {
          this.editWalk[r * this.map.cols + c] = value;
        }
      }
    }
    this.dirty = true;
  }

  private paintBrushAtDevice(sx: number, sy: number, value: 0 | 1): void {
    this.paintDeviceEllipseOnWalk(sx, sy, BRUSH_RADIUS_PX, BRUSH_RADIUS_PX, value);
  }

  private paintBrushStroke(sx0: number, sy0: number, sx1: number, sy1: number, value: 0 | 1): void {
    const dist = Math.hypot(sx1 - sx0, sy1 - sy0);
    const steps = Math.max(1, Math.ceil(dist / (BRUSH_RADIUS_PX * 0.45)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.paintBrushAtDevice(sx0 + (sx1 - sx0) * t, sy0 + (sy1 - sy0) * t, value);
    }
  }

  private applyPaintShape(value: 0 | 1): boolean {
    if (!this.map || !this.editWalk) return false;
    if (this.paintShape === 'rectangle') {
      const corners = this.draftWorldCorners();
      if (!corners) return false;
      const bounds = boundsFromPoints(corners);
      const rect: FloorBlock = { id: '', fill: '', label: '', ...bounds };
      if (rect.w < MIN_BLOCK || rect.d < MIN_BLOCK) return false;
      const axisAligned = Math.abs(this.viewRotation) < VIEW_ROT_EPS;
      if (axisAligned) paintRectOnWalk(this.map, this.editWalk, rect, value);
      else paintConvexPolygonOnWalk(this.map, this.editWalk, corners, value);
      return true;
    }
    if (this.paintShape === 'circle') {
      const box = this.draftScreenRect();
      if (!box || box.w < MIN_SCREEN_RECT_PX || box.h < MIN_SCREEN_RECT_PX) return false;
      this.paintDeviceEllipseOnWalk(box.left + box.w / 2, box.top + box.h / 2, box.w / 2, box.h / 2, value);
      return true;
    }
    if (this.paintShape === 'triangle') {
      const tri = this.draftScreenTriangle();
      if (!tri) return false;
      const box = this.draftScreenRect();
      if (!box || box.w < MIN_SCREEN_RECT_PX || box.h < MIN_SCREEN_RECT_PX) return false;
      const corners = tri.map((p) => this.deviceToWorld(p.sx, p.sy));
      paintConvexPolygonOnWalk(this.map, this.editWalk, corners, value);
      return true;
    }
    return false;
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; z: number } {
    const { sx, sy } = this.screenToDevice(clientX, clientY);
    return this.deviceToWorld(sx, sy);
  }

  private zoomAtScreen(clientX: number, clientY: number, factor: number): void {
    const { sx, sy } = this.screenToDevice(clientX, clientY);
    const world = this.deviceToWorld(sx, sy);
    const unrot = this.unrotateScreen(sx, sy);
    const newScale = Math.max(0.2, Math.min(80, this.scale * factor));
    this.scale = newScale;
    this.offsetX = unrot.sx - world.x * newScale;
    this.offsetY = unrot.sy - world.z * newScale;
  }

  private handleRadiusWorld(): number {
    return HANDLE_RADIUS_PX / Math.max(this.scale, 0.001);
  }

  private applyZoneEdit(x: number, z: number): void {
    if (!this.zoneEdit) return;
    const { block, handle, startWorld, snapshot } = this.zoneEdit;
    applyRegionEdit(block, handle, snapshot, startWorld, x, z);
  }

  private applyObjectEdit(x: number, z: number): void {
    if (!this.objectEdit) return;
    const { block, mode, corner, startWorld, snapshot, startAngle } = this.objectEdit;
    if (mode === 'move') {
      applyRegionEdit(block, { kind: 'move' }, snapshot, startWorld, x, z);
      block.rotation = snapshot.rotation;
      return;
    }
    if (mode === 'rotate') {
      const cx = snapshot.x + snapshot.w / 2;
      const cz = snapshot.z + snapshot.d / 2;
      const ang = Math.atan2(z - cz, x - cx);
      const base = startAngle ?? Math.atan2(startWorld.z - cz, startWorld.x - cx);
      const deltaDeg = ((ang - base) * 180) / Math.PI;
      block.rotation = normalizeObjectRotation((snapshot.rotation ?? 0) + deltaDeg);
      block.x = snapshot.x;
      block.z = snapshot.z;
      block.w = snapshot.w;
      block.d = snapshot.d;
      return;
    }
    if (mode === 'resize' && corner) {
      // Resize in the object's local axes, keeping center fixed for rotated objects.
      const rot = ((snapshot.rotation ?? 0) * Math.PI) / 180;
      const cx = snapshot.x + snapshot.w / 2;
      const cz = snapshot.z + snapshot.d / 2;
      const dx = x - cx;
      const dz = z - cz;
      const c = Math.cos(-rot);
      const s = Math.sin(-rot);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      let hw = snapshot.w / 2;
      let hd = snapshot.d / 2;
      if (corner === 'ne' || corner === 'se') hw = Math.max(MIN_BLOCK / 2, Math.abs(lx));
      if (corner === 'nw' || corner === 'sw') hw = Math.max(MIN_BLOCK / 2, Math.abs(lx));
      if (corner === 'sw' || corner === 'se') hd = Math.max(MIN_BLOCK / 2, Math.abs(lz));
      if (corner === 'nw' || corner === 'ne') hd = Math.max(MIN_BLOCK / 2, Math.abs(lz));
      // Use distance from center to pointer in local space for that corner's quadrant.
      hw = Math.max(MIN_BLOCK / 2, Math.abs(lx));
      hd = Math.max(MIN_BLOCK / 2, Math.abs(lz));
      block.w = hw * 2;
      block.d = hd * 2;
      block.x = cx - hw;
      block.z = cz - hd;
      block.rotation = snapshot.rotation;
    }
  }

  private objectLocalCorners(block: FloorBlock): { corner: ZoneResizeCorner; x: number; z: number }[] {
    const cx = block.x + block.w / 2;
    const cz = block.z + block.d / 2;
    const hw = block.w / 2;
    const hd = block.d / 2;
    const rot = ((block.rotation ?? 0) * Math.PI) / 180;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const mapCorner = (corner: ZoneResizeCorner, lx: number, lz: number) => ({
      corner,
      x: cx + lx * c - lz * s,
      z: cz + lx * s + lz * c,
    });
    return [
      mapCorner('nw', -hw, -hd),
      mapCorner('ne', hw, -hd),
      mapCorner('sw', -hw, hd),
      mapCorner('se', hw, hd),
    ];
  }

  private objectRotateReachWorld(block: FloorBlock): number {
    return block.d / 2 + Math.max(0.5, this.handleRadiusWorld() * 3.5);
  }

  private objectRotateHandleWorld(block: FloorBlock): { x: number; z: number } {
    const cx = block.x + block.w / 2;
    const cz = block.z + block.d / 2;
    const rot = ((block.rotation ?? 0) * Math.PI) / 180;
    // Must match drawObjectSelection: local (0, -reach) after ctx.rotate(rot)
    // → world offset (sin(rot)*reach, -cos(rot)*reach).
    const reach = this.objectRotateReachWorld(block);
    return {
      x: cx + Math.sin(rot) * reach,
      z: cz - Math.cos(rot) * reach,
    };
  }

  private beginObjectEditPointer(w: { x: number; z: number }): boolean {
    this.lastPointerWorld = { x: w.x, z: w.z };
    const thresh = this.handleRadiusWorld();
    const rotThresh2 = (thresh * 2.2) * (thresh * 2.2);
    const cornerThresh2 = thresh * thresh;

    const tryHandles = (obj: FloorBlock): boolean => {
      if (isPolygonZone(obj)) return false;
      const rotHandle = this.objectRotateHandleWorld(obj);
      if (dist2(w.x, w.z, rotHandle.x, rotHandle.z) <= rotThresh2) {
        this.selectObject(obj.id);
        const cx = obj.x + obj.w / 2;
        const cz = obj.z + obj.d / 2;
        this.objectEdit = {
          block: obj,
          mode: 'rotate',
          startWorld: w,
          snapshot: cloneRegionBlock(obj),
          historyPushed: false,
          startAngle: Math.atan2(w.z - cz, w.x - cx),
        };
        this.dragging = true;
        this.canvas.style.cursor = 'crosshair';
        return true;
      }
      for (const c of this.objectLocalCorners(obj)) {
        if (dist2(w.x, w.z, c.x, c.z) <= cornerThresh2) {
          this.selectObject(obj.id);
          this.objectEdit = {
            block: obj,
            mode: 'resize',
            corner: c.corner,
            startWorld: w,
            snapshot: cloneRegionBlock(obj),
            historyPushed: false,
          };
          this.dragging = true;
          this.canvas.style.cursor = 'nwse-resize';
          return true;
        }
      }
      return false;
    };

    // Prefer handles on the already-selected object, then on whatever is under the pointer.
    const selected = this.editObjects.find((o) => o.id === this.selectedObjectId);
    if (selected && tryHandles(selected)) return true;

    const hit = hitTestRegion(this.editObjects, w.x, w.z);
    if (hit) {
      if (hit.id !== selected?.id && tryHandles(hit)) return true;
      this.selectObject(hit.id);
      this.objectEdit = {
        block: hit,
        mode: 'move',
        startWorld: w,
        snapshot: cloneRegionBlock(hit),
        historyPushed: false,
      };
      this.dragging = true;
      this.canvas.style.cursor = 'grabbing';
      return true;
    }

    // Allow grabbing the rotate handle even if it sits outside the object bbox.
    for (let i = this.editObjects.length - 1; i >= 0; i--) {
      if (tryHandles(this.editObjects[i])) return true;
    }

    this.selectObject(null);
    this.objectEdit = null;
    return false;
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (this.tool === 'zone') {
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.finishPolygonDraft();
        } else if (e.key === 'Escape') {
          this.polygonDraft = null;
          this.draw();
        }
        return;
      }

      if (this.isZoneEditTool()) {
        if (e.key === 'Escape') {
          this.zoneEdit = null;
          this.selectZone(null);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedZoneId) {
          e.preventDefault();
          this.deleteSelectedZone();
        }
        return;
      }

      if (this.isObjectEditTool()) {
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        if (e.key === 'Escape') {
          this.objectEdit = null;
          this.selectObject(null);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedObjectId) {
          e.preventDefault();
          this.deleteSelectedObject();
        } else if (mod && key === 'c' && this.selectedObjectId) {
          e.preventDefault();
          this.copySelectedObject();
        } else if (mod && key === 'v' && this.objectClipboard) {
          e.preventDefault();
          this.pasteObjectClipboard();
        } else if (key === 'r' && this.selectedObjectId) {
          e.preventDefault();
          this.rotateSelectedObject(e.shiftKey ? -90 : 90);
        } else if ((e.key === '=' || e.key === '+') && this.selectedObjectId) {
          e.preventDefault();
          this.scaleSelectedObject(1.1);
        } else if ((e.key === '-' || e.key === '_') && this.selectedObjectId) {
          e.preventDefault();
          this.scaleSelectedObject(1 / 1.1);
        } else if (e.key === ']' && this.selectedObjectId) {
          e.preventDefault();
          this.scaleSelectedObject(1.1);
        } else if (e.key === '[' && this.selectedObjectId) {
          e.preventDefault();
          this.scaleSelectedObject(1 / 1.1);
        }
        return;
      }

      // Paste works from Object / Edit Object; Copy is Edit Object only (above).
      if (this.tool === 'object') {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'v' && this.objectClipboard) {
          e.preventDefault();
          this.pasteObjectClipboard();
        }
      }

      if (this.tool === 'stair-mouth' || this.tool === 'stair-mouth-edit') {
        if (e.key === 'Escape') {
          this.pendingLinkMouthId = null;
          this.pendingLinkFloorId = null;
          this.selectStairMouth(null, null);
          this.mouthEdit = null;
          this.draw();
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedStairMouthId) {
          e.preventDefault();
          this.deleteSelectedStairMouth();
        }
        return;
      }
    });
  }

  private beginZoneEditPointer(w: { x: number; z: number }): boolean {
    const handleHit = hitRegionHandle(
      this.editZones,
      this.selectedZoneId,
      w.x,
      w.z,
      this.handleRadiusWorld(),
    );
    if (handleHit) {
      this.selectZone(handleHit.block.id);
      this.zoneEdit = {
        block: handleHit.block,
        handle: handleHit.handle,
        startWorld: w,
        snapshot: cloneRegionBlock(handleHit.block),
        historyPushed: false,
      };
      this.canvas.style.cursor = 'grabbing';
      return true;
    }

    const zoneHit = hitTestRegion(this.editZones, w.x, w.z);
    if (zoneHit) {
      this.selectZone(zoneHit.id);
      this.zoneEdit = {
        block: zoneHit,
        handle: { kind: 'move' },
        startWorld: w,
        snapshot: cloneRegionBlock(zoneHit),
        historyPushed: false,
      };
      this.canvas.style.cursor = 'grab';
      return true;
    }

    this.selectZone(null);
    return false;
  }

  private bindPointer(): void {
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('pointerdown', (e) => {
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      if (this.beginViewNavigation(e)) {
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }

      this.canvas.setPointerCapture(e.pointerId);

      if (this.tool === 'pan') {
        this.dragging = true;
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      const w = this.screenToWorld(e.clientX, e.clientY);

      if (this.isZoneEditTool()) {
        this.beginZoneEditPointer(w);
        return;
      }

      if (this.isObjectEditTool()) {
        this.beginObjectEditPointer(w);
        return;
      }

      if (this.tool === 'stair-mouth') {
        this.placeStairMouthAt(w);
        return;
      }

      if (this.tool === 'stair-mouth-edit') {
        this.beginStairMouthEditPointer(w);
        return;
      }

      if (this.isPaintTool() && this.paintShape === 'draw') {
        this.dragging = true;
        this.pushHistory();
        const dev = this.screenToDevice(e.clientX, e.clientY);
        this.brushStroke = { lastSx: dev.sx, lastSy: dev.sy };
        const value: 0 | 1 = this.tool === 'add' ? 1 : 0;
        this.paintBrushAtDevice(dev.sx, dev.sy, value);
        this.onRouteRebuild?.();
        this.draw();
        return;
      }

      if (this.tool === 'zone') {
        // Add Zone: never select or edit existing zones — draw only.
        if (this.zoneDrawMode === 'polygon') {
          const closeDist = CLOSE_POLY_DIST_PX / Math.max(this.scale, 0.001);
          if (this.polygonDraft && this.polygonDraft.points.length >= 3) {
            const first = this.polygonDraft.points[0];
            if (dist2(w.x, w.z, first.x, first.z) <= closeDist * closeDist) {
              void this.finishPolygonDraft();
              return;
            }
          }
          if (!this.polygonDraft) {
            this.polygonDraft = { points: [], cursorX: w.x, cursorZ: w.z };
          }
          this.polygonDraft.points.push({ x: w.x, z: w.z });
          this.polygonDraft.cursorX = w.x;
          this.polygonDraft.cursorZ = w.z;
          this.draw();
          return;
        }

        const dev = this.screenToDevice(e.clientX, e.clientY);
        this.draft = { sx0: dev.sx, sy0: dev.sy, sx1: dev.sx, sy1: dev.sy };
        this.draw();
        return;
      }

      const dev = this.screenToDevice(e.clientX, e.clientY);
      this.draft = { sx0: dev.sx, sy0: dev.sy, sx1: dev.sx, sy1: dev.sy };
      this.draw();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.navPanning) {
        const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
        this.offsetX += (e.clientX - this.lastX) * dpr;
        this.offsetY += (e.clientY - this.lastY) * dpr;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.scheduleDraw();
        return;
      }

      if (this.rotateDragging) {
        const angle = this.pointerAngleFromCenter(e.clientX, e.clientY);
        this.viewRotation = this.rotateStartViewRotation + (angle - this.rotateStartAngle);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.scheduleDraw();
        return;
      }

      if (this.tool === 'pan' && this.dragging) {
        const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
        this.offsetX += (e.clientX - this.lastX) * dpr;
        this.offsetY += (e.clientY - this.lastY) * dpr;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.scheduleDraw();
        return;
      }

      if (this.zoneEdit) {
        const moved = Math.hypot(e.clientX - this.lastX, e.clientY - this.lastY);
        if (!this.zoneEdit.historyPushed && moved > 4) {
          this.pushHistory();
          this.zoneEdit.historyPushed = true;
        }
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.applyZoneEdit(w.x, w.z);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.draw();
        return;
      }

      if (this.objectEdit) {
        const moved = Math.hypot(e.clientX - this.lastX, e.clientY - this.lastY);
        if (!this.objectEdit.historyPushed && moved > 4) {
          this.pushHistory();
          this.objectEdit.historyPushed = true;
        }
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.lastPointerWorld = { x: w.x, z: w.z };
        this.applyObjectEdit(w.x, w.z);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.canvas.style.cursor =
          this.objectEdit.mode === 'resize'
            ? 'nwse-resize'
            : this.objectEdit.mode === 'rotate'
              ? 'crosshair'
              : 'grabbing';
        this.draw();
        return;
      }

      if (this.mouthEdit) {
        const moved = Math.hypot(e.clientX - this.lastX, e.clientY - this.lastY);
        if (!this.mouthEdit.historyPushed && moved > 4) {
          this.pushHistory();
          this.mouthEdit.historyPushed = true;
        }
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.applyStairMouthEdit(w.x, w.z);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.draw();
        return;
      }

      if (this.polygonDraft) {
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.polygonDraft.cursorX = w.x;
        this.polygonDraft.cursorZ = w.z;
        this.draw();
        return;
      }

      if (this.brushStroke && this.isPaintTool() && this.paintShape === 'draw' && this.dragging) {
        const dev = this.screenToDevice(e.clientX, e.clientY);
        const value: 0 | 1 = this.tool === 'add' ? 1 : 0;
        this.paintBrushStroke(this.brushStroke.lastSx, this.brushStroke.lastSy, dev.sx, dev.sy, value);
        this.brushStroke.lastSx = dev.sx;
        this.brushStroke.lastSy = dev.sy;
        this.onRouteRebuild?.();
        this.scheduleDraw();
        return;
      }

      if (this.draft) {
        const dev = this.screenToDevice(e.clientX, e.clientY);
        this.draft.sx1 = dev.sx;
        this.draft.sy1 = dev.sy;
        this.draw();
        return;
      }

      // Track pointer for paste-at-cursor while hovering in object edit mode.
      if (this.isObjectEditTool() || this.tool === 'object') {
        const w = this.screenToWorld(e.clientX, e.clientY);
        this.lastPointerWorld = { x: w.x, z: w.z };
        if (this.isObjectEditTool() && !this.objectEdit) {
          const selected = this.editObjects.find((o) => o.id === this.selectedObjectId);
          if (selected && !isPolygonZone(selected)) {
            const thresh = this.handleRadiusWorld();
            const rotThresh2 = (thresh * 2.2) * (thresh * 2.2);
            const rotH = this.objectRotateHandleWorld(selected);
            if (dist2(w.x, w.z, rotH.x, rotH.z) <= rotThresh2) {
              this.canvas.style.cursor = 'crosshair';
              return;
            }
            for (const c of this.objectLocalCorners(selected)) {
              if (dist2(w.x, w.z, c.x, c.z) <= thresh * thresh) {
                this.canvas.style.cursor = 'nwse-resize';
                return;
              }
            }
          }
          const hit = hitTestRegion(this.editObjects, w.x, w.z);
          this.canvas.style.cursor = hit ? 'grab' : 'default';
        }
      }
    });

    const end = (e: PointerEvent) => {
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }

      if (this.navPanning || this.rotateDragging) {
        this.navPanning = false;
        this.rotateDragging = false;
        this.canvas.style.cursor =
          this.tool === 'pan' ? 'grab' : this.isZoneEditTool() || this.isObjectEditTool() || this.tool === 'stair-mouth-edit' ? 'default' : 'crosshair';
        return;
      }

      if (this.zoneEdit) {
        this.zoneEdit = null;
        this.dragging = false;
        this.canvas.style.cursor = this.isZoneEditTool() ? 'default' : 'crosshair';
        this.refreshZoneSidebar();
        this.onRouteRebuild?.();
        this.draw();
        return;
      }

      if (this.objectEdit) {
        const moved = this.objectEdit.historyPushed;
        this.objectEdit = null;
        this.dragging = false;
        this.canvas.style.cursor = this.isObjectEditTool() ? 'default' : 'crosshair';
        if (moved) this.onRouteRebuild?.();
        this.draw();
        return;
      }

      if (this.mouthEdit) {
        this.mouthEdit = null;
        this.dragging = false;
        this.canvas.style.cursor = this.tool === 'stair-mouth-edit' ? 'default' : 'crosshair';
        this.onRouteRebuild?.();
        this.draw();
        return;
      }

      if (this.brushStroke) {
        this.brushStroke = null;
        this.dragging = false;
        this.canvas.style.cursor = 'crosshair';
        this.draw();
        return;
      }

      if (this.draft && this.map && this.editWalk) {
        const box = this.draftScreenRect();
        const corners = this.draftWorldCorners();
        const screenValid = !!box && box.w >= MIN_SCREEN_RECT_PX && box.h >= MIN_SCREEN_RECT_PX;
        const axisAligned = Math.abs(this.viewRotation) < VIEW_ROT_EPS;

        if (screenValid && corners) {
          const bounds = boundsFromPoints(corners);
          const rect: FloorBlock = { id: '', fill: '', label: '', ...bounds };
          const worldValid = rect.w >= MIN_BLOCK && rect.d >= MIN_BLOCK;

          if (worldValid && this.tool === 'zone' && this.zoneDrawMode === 'rectangle') {
            this.draft = null;
            this.dragging = false;
            this.canvas.style.cursor = 'crosshair';
            this.draw();
            void this.commitNewZone(
              { id: '', ...bounds, fill: 'transparent', label: '' },
              axisAligned ? 'rectangle' : 'polygon',
              axisAligned ? undefined : corners,
            );
            return;
          }

          if (this.isPaintTool() && this.paintShape !== 'draw' && screenValid) {
            this.pushHistory();
            this.applyPaintShape(this.tool === 'add' ? 1 : 0);
            this.onRouteRebuild?.();
          } else if (worldValid && this.tool === 'object') {
            const mat = this.objectMaterial;
            this.pushHistory();
            if (mat?.kind === 'chair-row') {
              // Fill the dragged rectangle with an N-chair rows×cols grid.
              const c = regionCentroid(rect);
              this.editObjects.push(
                this.buildMaterialBlock(mat, c.x, c.z, { w: rect.w, d: rect.d }),
              );
            } else {
              const obj: FloorBlock = {
                ...rect,
                id: `obj-${++this.objectIdSeq}`,
                fill: FLOOR2D_STYLE.object,
                stroke: FLOOR2D_STYLE.interiorWall,
                label: '',
                shape: this.objectShape,
                kind: mat?.kind,
              };
              if (!axisAligned && this.objectShape === 'rectangle') {
                obj.shape = 'polygon';
                obj.points = corners.map((p) => ({ x: p.x, z: p.z }));
              }
              this.editObjects.push(obj);
            }
            this.onRouteRebuild?.();
          }
        } else if (this.tool === 'object' && this.objectMaterial) {
          // A click (no meaningful drag): drop the material at its default size.
          const start = this.deviceToWorld(this.draft.sx0, this.draft.sy0);
          this.placeMaterialAt(this.objectMaterial, start.x, start.z);
        }
        this.draft = null;
      }
      this.dragging = false;
      this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
      this.draw();
    };

    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Pinch (Ctrl/⌘+wheel) on a selected object → resize it.
        if (
          this.isObjectEditTool() &&
          this.selectedObjectId &&
          (e.ctrlKey || e.metaKey) &&
          !e.shiftKey
        ) {
          const factor = e.deltaY > 0 ? 1 / 1.08 : 1.08;
          if (!this.objectScaleGesture) {
            this.pushHistory();
            this.objectScaleGesture = true;
          }
          this.scaleSelectedObject(factor, { history: false });
          if (this.objectScaleGestureTimer) clearTimeout(this.objectScaleGestureTimer);
          this.objectScaleGestureTimer = setTimeout(() => {
            this.objectScaleGesture = false;
            this.objectScaleGestureTimer = null;
          }, 400);
          return;
        }
        if (e.shiftKey) {
          const step = (e.deltaY > 0 ? 1 : -1) * (Math.PI / 36);
          this.viewRotation += step;
        } else {
          const factor = e.deltaY > 0 ? 0.9 : 1.1;
          if (e.ctrlKey || e.metaKey) {
            this.zoomAtScreen(e.clientX, e.clientY, factor);
          } else {
            this.scale = Math.max(0.2, Math.min(80, this.scale * factor));
          }
        }
        this.draw();
      },
      { passive: false },
    );

    this.canvas.addEventListener('dblclick', (e) => {
      if (!this.map) return;
      const w = this.screenToWorld(e.clientX, e.clientY);
      if (this.isZoneEditTool()) {
        const zoneHit = hitTestRegion(this.editZones, w.x, w.z);
        if (zoneHit) {
          void (async () => {
            const name = await this.askZoneName(zoneHit.label, 'rename');
            if (name && name !== zoneHit.label) {
              this.pushHistory();
              zoneHit.label = name;
              this.refreshZoneSidebar();
              this.notifyZonesChange();
            }
            this.draw();
          })();
        }
        return;
      }
    });
  }

  private drawShape(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    shape: FloorShape | undefined,
    fill: string,
    stroke: string,
    lineW: number,
    dashed: boolean,
  ): void {
    ctx.save();
    ctx.lineWidth = lineW;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([6, 4]);
    if (shape === 'circle') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
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
      const sw = Math.max(1, w - lineW);
      const sh = Math.max(1, h - lineW);
      ctx.strokeRect(x + inset, y + inset, sw, sh);
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
    ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = x + w / 2;
    const cy = y + h / 2;
    const text = truncateLabel(label, 28);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3 * dpr, y + 3 * dpr, w - 6 * dpr, h - 6 * dpr);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  private drawNavMesh(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.showNavMesh || this.navMeshTris.length === 0) return;
    ctx.fillStyle = FLOOR2D_STYLE.navMesh;
    ctx.strokeStyle = FLOOR2D_STYLE.navMeshStroke;
    ctx.lineWidth = Math.max(0.5, 0.75 * dpr);
    for (const tri of this.navMeshTris) {
      ctx.beginPath();
      ctx.moveTo(this.wx(tri.ax), this.wz(tri.az));
      ctx.lineTo(this.wx(tri.bx), this.wz(tri.bz));
      ctx.lineTo(this.wx(tri.cx), this.wz(tri.cz));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawEnclosedRooms(
    ctx: CanvasRenderingContext2D,
    m: Floor2DMap,
    walk: Uint8Array,
  ): void {
    if (m.cols * m.rows > HEAVY_GRID_CELLS) return;
    const enclosed = markEnclosedVoidCells(m, walk);
    const cellPx = m.cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.interiorFill;
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        const i = r * m.cols + c;
        if (!enclosed[i] || walk[i]) continue;
        const x = m.minX + c * m.cellSize;
        const z = m.minZ + r * m.cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx, cellPx);
      }
    }
  }

  private drawFloorBlocks(ctx: CanvasRenderingContext2D, blocks: FloorBlock[]): void {
    if (!blocks.length) return;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    for (const b of blocks) {
      ctx.fillRect(this.wx(b.x), this.wz(b.z), b.w * this.scale, b.d * this.scale);
    }
  }

  private drawFloorFill(ctx: CanvasRenderingContext2D, m: Floor2DMap, walk: Uint8Array): void {
    const blocks = m.corridors.length > 0 ? m.corridors : m.blocks;
    if (m.cols * m.rows >= HEAVY_GRID_CELLS || blocks.length > 0) {
      this.drawFloorBlocks(ctx, blocks);
      return;
    }
    this.drawWalkGrid(ctx, walk);
  }

  private drawWalkGrid(ctx: CanvasRenderingContext2D, walkOverride?: Uint8Array | null): void {
    const walk = walkOverride ?? this.editWalk;
    if (!this.map || !walk) return;
    const { minX, minZ, cellSize, cols, rows } = this.map;
    const cellPx = cellSize * this.scale;
    ctx.fillStyle = FLOOR2D_STYLE.corridor;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!walk[r * cols + c]) continue;
        const x = minX + c * cellSize;
        const z = minZ + r * cellSize;
        ctx.fillRect(this.wx(x), this.wz(z), cellPx, cellPx);
      }
    }
  }

  private drawStores(ctx: CanvasRenderingContext2D, m: Floor2DMap, dpr: number): void {
    const lineW = Math.max(0.75, 0.85 * dpr);
    ctx.lineWidth = lineW;
    ctx.strokeStyle = FLOOR2D_STYLE.interiorWall;
    m.stores.forEach((b) => {
      ctx.fillStyle = FLOOR2D_STYLE.interiorFill;
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + lineW * 0.5, y + lineW * 0.5, w - lineW, h - lineW);
      this.drawZoneLabel(ctx, x, y, w, h, zoneDisplayLabel(b, this.pois), dpr, FLOOR2D_STYLE.zoneLabel);
    });
  }

  private drawObjects(ctx: CanvasRenderingContext2D, dpr: number, objects?: FloorBlock[]): void {
    const lineW = Math.max(1, 1.15 * dpr);
    const stroke = FLOOR2D_STYLE.interiorWall;
    for (const b of objects ?? this.editObjects) {
      if (b.kind) {
        this.drawRotatedObjectSymbol(ctx, b, stroke, lineW);
        if (b.id === this.selectedObjectId && this.isObjectEditTool()) {
          this.drawObjectSelection(ctx, b, dpr);
        }
        continue;
      }

      const objStroke = b.stroke || FLOOR2D_STYLE.objectBorder;
      if (b.shape === 'polygon' && b.points && b.points.length >= 3) {
        ctx.save();
        ctx.fillStyle = b.fill || FLOOR2D_STYLE.object;
        ctx.strokeStyle = objStroke;
        ctx.lineWidth = lineW;
        ctx.beginPath();
        for (let i = 0; i < b.points.length; i++) {
          const p = b.points[i];
          const sx = this.wx(p.x);
          const sy = this.wz(p.z);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        if (b.id === this.selectedObjectId && this.isObjectEditTool()) {
          this.drawObjectSelection(ctx, b, dpr);
        }
        continue;
      }
      this.drawRotatedFreehandObject(ctx, b, objStroke, lineW);
      if (b.id === this.selectedObjectId && this.isObjectEditTool()) {
        this.drawObjectSelection(ctx, b, dpr);
      }
    }
  }

  private drawRotatedObjectSymbol(
    ctx: CanvasRenderingContext2D,
    b: FloorBlock,
    stroke: string,
    lineW: number,
  ): void {
    const cx = b.x + b.w / 2;
    const cz = b.z + b.d / 2;
    const sx = this.wx(cx);
    const sy = this.wz(cz);
    const w = b.w * this.scale;
    const h = b.d * this.scale;
    const rot = ((b.rotation ?? 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(rot);
    drawFloorPlanSymbol(ctx, b.kind, -w / 2, -h / 2, w, h, stroke, lineW, { count: b.count });
    ctx.restore();
  }

  private drawRotatedFreehandObject(
    ctx: CanvasRenderingContext2D,
    b: FloorBlock,
    stroke: string,
    lineW: number,
  ): void {
    const cx = b.x + b.w / 2;
    const cz = b.z + b.d / 2;
    const sx = this.wx(cx);
    const sy = this.wz(cz);
    const w = b.w * this.scale;
    const h = b.d * this.scale;
    const rot = ((b.rotation ?? 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(rot);
    this.drawShape(
      ctx,
      -w / 2,
      -h / 2,
      w,
      h,
      b.shape ?? 'rectangle',
      b.fill || FLOOR2D_STYLE.object,
      stroke,
      lineW,
      false,
    );
    ctx.restore();
  }

  private drawObjectSelection(ctx: CanvasRenderingContext2D, b: FloorBlock, dpr: number): void {
    const pad = 3 * dpr;
    const lineW = Math.max(1.5, 2 * dpr);
    ctx.save();
    ctx.strokeStyle = FLOOR2D_STYLE.accent;
    ctx.lineWidth = lineW;
    ctx.setLineDash([5 * dpr, 4 * dpr]);

    if (b.shape === 'polygon' && b.points && b.points.length >= 3) {
      ctx.beginPath();
      for (let i = 0; i < b.points.length; i++) {
        const p = b.points[i];
        const sx = this.wx(p.x);
        const sy = this.wz(p.z);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    const cx = b.x + b.w / 2;
    const cz = b.z + b.d / 2;
    const sx = this.wx(cx);
    const sy = this.wz(cz);
    const w = b.w * this.scale + pad * 2;
    const h = b.d * this.scale + pad * 2;
    const rot = ((b.rotation ?? 0) * Math.PI) / 180;
    ctx.translate(sx, sy);
    ctx.rotate(rot);
    if (b.shape === 'circle') {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    ctx.setLineDash([]);

    // Corner resize handles
    const hr = Math.max(4, HANDLE_RADIUS_PX * 0.55 * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = FLOOR2D_STYLE.accent;
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    for (const [lx, ly] of [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [-w / 2, h / 2],
      [w / 2, h / 2],
    ] as const) {
      ctx.beginPath();
      ctx.arc(lx, ly, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Rotate handle (above object in local −Y, matches objectRotateHandleWorld)
    const reach = this.objectRotateReachWorld(b) * this.scale;
    ctx.beginPath();
    ctx.moveTo(0, -h / 2);
    ctx.lineTo(0, -reach);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -reach, hr * 1.4, 0, Math.PI * 2);
    ctx.fillStyle = FLOOR2D_STYLE.accent;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    ctx.stroke();
    ctx.restore();
  }

  private drawZoneOutline(
    ctx: CanvasRenderingContext2D,
    zone: FloorBlock,
    stroke: string,
    lineW: number,
    dashed: boolean,
    selected: boolean,
  ): void {
    const fill = zoneFillFromStroke(stroke, zone.fill);
    ctx.save();
    ctx.lineWidth = selected ? lineW + 1 : lineW;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([6, 4]);
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
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
    } else {
      const x = this.wx(zone.x);
      const y = this.wz(zone.z);
      const w = zone.w * this.scale;
      const h = zone.d * this.scale;
      this.drawShape(ctx, x, y, w, h, zone.shape ?? 'rectangle', fill, stroke, lineW, dashed);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawZoneHandles(ctx: CanvasRenderingContext2D, zone: FloorBlock, dpr: number): void {
    const r = Math.max(4, HANDLE_RADIUS_PX * 0.55 * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = zone.stroke || FLOOR2D_STYLE.accent;
    ctx.lineWidth = Math.max(1.5, 2 * dpr);

    const drawHandle = (wx: number, wz: number) => {
      const sx = this.wx(wx);
      const sy = this.wz(wz);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    if (isPolygonZone(zone) && zone.points) {
      for (const p of zone.points) drawHandle(p.x, p.z);
      return;
    }

    drawHandle(zone.x, zone.z);
    drawHandle(zone.x + zone.w, zone.z);
    drawHandle(zone.x, zone.z + zone.d);
    drawHandle(zone.x + zone.w, zone.z + zone.d);
  }

  private drawRegionPolygonDraft(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    draft: { points: ZonePoint[]; cursorX: number; cursorZ: number } | null,
    stroke: string,
  ): void {
    if (!draft || draft.points.length === 0) return;
    const pts = draft.points;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, 2.5 * dpr);
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(this.wx(pts[0].x), this.wz(pts[0].z));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(this.wx(pts[i].x), this.wz(pts[i].z));
    }
    ctx.lineTo(this.wx(draft.cursorX), this.wz(draft.cursorZ));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = stroke;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(this.wx(p.x), this.wz(p.z), Math.max(3, 4 * dpr), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPolygonDraft(ctx: CanvasRenderingContext2D, dpr: number): void {
    const preview = nextZoneColors(this.editZones.length);
    this.drawRegionPolygonDraft(ctx, dpr, this.polygonDraft, preview.stroke);
  }

  private drawZones(ctx: CanvasRenderingContext2D, dpr: number, zones?: FloorBlock[]): void {
    const lineW = Math.max(2, 2.5 * dpr);
    const list = zones ?? this.editZones;
    for (const b of list) {
      const stroke = b.stroke || FLOOR2D_STYLE.accent;
      const selected = b.id === this.selectedZoneId;
      this.drawZoneOutline(ctx, b, stroke, lineW, true, selected);
      const x = this.wx(b.x);
      const y = this.wz(b.z);
      const w = b.w * this.scale;
      const h = b.d * this.scale;
      this.drawZoneLabel(ctx, x, y, w, h, b.label, dpr, stroke);
      if (selected && this.isZoneEditTool()) this.drawZoneHandles(ctx, b, dpr);
    }
  }

  private snapWalkPoint(x: number, z: number): { x: number; z: number } {
    if (!this.map || !this.editWalk) return { x, z };
    return snapWorldToWalkCell(this.map, this.editWalk, this.editObjects, x, z) ?? { x, z };
  }

  private activeFloorMouths(): StairMouth[] {
    return this.getActiveFloor()?.stairMouths ?? [];
  }

  private snapWalkPointForFloor(floor: FloorLevel, x: number, z: number): { x: number; z: number } {
    if (!this.map) return { x, z };
    const walk = this.walkForFloorLevel(floor);
    if (!walk) return { x, z };
    const floorMap = previewMapForFloor(this.map, floor, this.editFloors);
    const objects =
      floor.id === this.activeFloorId ? this.editObjects : (floor.objects ?? []);
    return snapWorldToWalkCell(floorMap, walk, objects, x, z) ?? { x, z };
  }

  private stairMouthSelectionState(): {
    mouthId: string | null;
    floorId: string | null;
    linked: boolean;
  } {
    if (!this.selectedStairMouthId) {
      return { mouthId: null, floorId: null, linked: false };
    }
    const floorId = this.selectedStairMouthFloorId ?? this.activeFloorId;
    const floor = floorId ? this.editFloors.find((f) => f.id === floorId) : null;
    const mouth = floor?.stairMouths?.find((m) => m.id === this.selectedStairMouthId);
    return {
      mouthId: this.selectedStairMouthId,
      floorId: floorId ?? null,
      linked: !!(mouth?.linkedFloorId && mouth?.linkedMouthId),
    };
  }

  private notifyStairMouthSelection(): void {
    this.onStairMouthSelectionChange?.(this.stairMouthSelectionState());
  }

  private selectStairMouth(floorId: string | null, mouthId: string | null): void {
    this.selectedStairMouthFloorId = floorId;
    this.selectedStairMouthId = mouthId;
    this.notifyStairMouthSelection();
    this.refreshFloorSidebar();
  }

  private beginStairMouthEditPointer(w: { x: number; z: number }): boolean {
    this.flushCurrentFloorState();
    const floor = this.ensureActiveFloorForMouths();
    if (!floor) return false;
    const hit = hitTestStairMouth(floor.stairMouths, w.x, w.z);
    if (hit) {
      this.selectStairMouth(floor.id, hit.id);
      this.mouthEdit = {
        floorId: floor.id,
        mouthId: hit.id,
        startWorld: w,
        snapshot: { x: hit.x, z: hit.z },
        historyPushed: false,
      };
      this.canvas.style.cursor = 'grabbing';
      return true;
    }
    this.selectStairMouth(null, null);
    return false;
  }

  private applyStairMouthEdit(x: number, z: number): void {
    if (!this.mouthEdit) return;
    const floor = this.editFloors.find((f) => f.id === this.mouthEdit!.floorId);
    const mouth = floor?.stairMouths?.find((m) => m.id === this.mouthEdit!.mouthId);
    if (!mouth || !floor) return;
    const snap = this.snapWalkPointForFloor(floor, x, z);
    mouth.x = snap.x;
    mouth.z = snap.z;
    if (this.map) {
      this.map = { ...this.map, floors: cloneFloorLevels(this.editFloors) };
    }
  }

  private addStairMouthToFloor(floorId: string, mouth: StairMouth): FloorLevel | null {
    const floor = this.editFloors.find((f) => f.id === floorId);
    if (!floor) return null;
    if (!floor.stairMouths) floor.stairMouths = [];
    floor.stairMouths.push(mouth);
    if (this.map) {
      this.map = { ...this.map, floors: cloneFloorLevels(this.editFloors) };
    }
    return floor;
  }

  private placeStairMouthAt(w: { x: number; z: number }, targetFloor?: FloorLevel): void {
    this.flushCurrentFloorState();
    const floor = targetFloor ?? this.ensureActiveFloorForMouths();
    if (!floor || !this.map) return;

    const hit = hitTestStairMouth(floor.stairMouths, w.x, w.z);
    if (hit) {
      this.selectStairMouth(floor.id, hit.id);
      if (
        this.pendingLinkMouthId &&
        this.pendingLinkFloorId &&
        this.pendingLinkFloorId !== floor.id
      ) {
        this.pushHistory();
        this.finishMouthLink(
          this.pendingLinkFloorId,
          this.pendingLinkMouthId,
          floor.id,
          hit.id,
        );
      } else if (!hit.linkedMouthId) {
        this.pendingLinkMouthId = hit.id;
        this.pendingLinkFloorId = floor.id;
      }
      this.draw();
      return;
    }

    const snap = this.snapWalkPointForFloor(floor, w.x, w.z);
    const mouth: StairMouth = { id: newStairMouthId(), x: snap.x, z: snap.z };
    this.pushHistory();
    this.addStairMouthToFloor(floor.id, mouth);
    this.selectStairMouth(floor.id, mouth.id);

    if (
      this.pendingLinkMouthId &&
      this.pendingLinkFloorId &&
      this.pendingLinkFloorId !== floor.id
    ) {
      this.finishMouthLink(
        this.pendingLinkFloorId,
        this.pendingLinkMouthId,
        floor.id,
        mouth.id,
      );
    } else {
      this.pendingLinkMouthId = mouth.id;
      this.pendingLinkFloorId = floor.id;
    }
    this.onRouteRebuild?.();
    this.refreshFloorSidebar();
    this.draw();
  }

  private drawStairMouthMarker(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    mouth: StairMouth,
    floor: FloorLevel,
    selected: boolean,
  ): void {
    const px = this.wx(mouth.x);
    const py = this.wz(mouth.z);
    const r = Math.max(5, 6 * dpr);
    const linked = !!(mouth.linkedFloorId && mouth.linkedMouthId);
    const pending =
      !linked &&
      mouth.id === this.pendingLinkMouthId &&
      floor.id === this.pendingLinkFloorId;
    ctx.save();
    if (linked) {
      ctx.strokeStyle = STAIR_MOUTH_LINK_COLOR;
      ctx.lineWidth = Math.max(3, 3.5 * dpr);
      ctx.beginPath();
      ctx.arc(px, py, r + 4 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    } else if (pending) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = Math.max(2.5, 3 * dpr);
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.arc(px, py, r + 5 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = STAIR_MOUTH_MARKER_COLOR;
    ctx.strokeStyle = selected ? '#fbbf24' : linked ? STAIR_MOUTH_LINK_COLOR : '#ffffff';
    ctx.lineWidth = selected ? Math.max(2.5, 3 * dpr) : Math.max(1.5, 2 * dpr);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (linked) {
      const partnerFloor = this.editFloors.find((f) => f.id === mouth.linkedFloorId);
      const label = partnerFloor?.label?.trim() || 'linked';
      const fontSize = Math.max(8, 9 * dpr);
      ctx.font = `600 ${fontSize}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = STAIR_MOUTH_LINK_COLOR;
      ctx.fillText(`↔ ${label}`, px, py + r + 4 * dpr);
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
    for (const mouth of mouths) {
      const selected =
        mouth.id === this.selectedStairMouthId && floor.id === this.selectedStairMouthFloorId;
      this.drawStairMouthMarker(ctx, dpr, mouth, floor, selected);
    }
  }

  private drawStairMouthLinkHint(ctx: CanvasRenderingContext2D, dpr: number): void {
    const fontSize = Math.max(10, 11 * dpr);
    ctx.save();
    ctx.font = `600 ${fontSize}px system-ui,sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (this.tool === 'stair-mouth-edit') {
      ctx.fillStyle = '#b45309';
      const sel = this.stairMouthSelectionState();
      ctx.fillText(
        sel.mouthId
          ? 'Drag the selected mouth to move it — Delete removes it; Unlink breaks the pair'
          : 'Click a stair mouth to select, then drag to reposition',
        12 * dpr,
        12 * dpr,
      );
      ctx.restore();
      return;
    }

    if (this.tool === 'stair-mouth') {
      ctx.fillStyle = '#b45309';
      if (!this.pendingLinkMouthId || !this.pendingLinkFloorId) {
        const active = this.getActiveFloor();
        ctx.fillText(
          active
            ? `Click walkable floor on ${active.label.trim() || 'this floor'} to place a stair mouth — switch floors to link pairs`
            : 'Click walkable floor to place a stair mouth',
          12 * dpr,
          12 * dpr,
        );
        ctx.restore();
        return;
      }
    }

    if (this.tool !== 'stair-mouth' || !this.pendingLinkMouthId || !this.pendingLinkFloorId) {
      ctx.restore();
      return;
    }
    const fromLabel = this.pendingLinkFloorLabel();
    const active = this.getActiveFloor();
    if (!fromLabel || !active) {
      ctx.restore();
      return;
    }
    ctx.fillStyle = '#b45309';
    const onOtherFloor = active.id !== this.pendingLinkFloorId;
    ctx.fillText(
      onOtherFloor
        ? `Linking from ${fromLabel} — click walkable area to pair this stair mouth`
        : `Stair mouth placed — switch another floor and click to link (or add more mouths here)`,
      12 * dpr,
      12 * dpr,
    );
    ctx.restore();
  }

  /** Orange preview lines between linked mouths across stacked floor gaps. */
  private drawStairMouthGapLinks(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
  ): void {
    const drawn = new Set<string>();
    for (const floor of floors) {
      for (const mouth of floor.stairMouths ?? []) {
        if (!mouth.linkedFloorId || !mouth.linkedMouthId) continue;
        const key = [floor.id, mouth.id, mouth.linkedFloorId, mouth.linkedMouthId]
          .sort()
          .join('|');
        if (drawn.has(key)) continue;
        drawn.add(key);

        const partnerFloor = floors.find((f) => f.id === mouth.linkedFloorId);
        const partner = partnerFloor ? getMouthById(partnerFloor, mouth.linkedMouthId) : null;
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
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawWalls(
    ctx: CanvasRenderingContext2D,
    m: Floor2DMap,
    dpr: number,
    walkOverride?: Uint8Array | null,
  ): void {
    if (m.cols * m.rows >= HEAVY_GRID_CELLS) return;
    const walk = walkOverride ?? this.editWalk;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    for (const seg of m.walls) {
      const border = walk ? isBorderWallSegment(seg, m, walk) : true;
      ctx.strokeStyle = border ? FLOOR2D_STYLE.borderWall : FLOOR2D_STYLE.interiorWall;
      ctx.lineWidth = border ? Math.max(2.2, 2.5 * dpr) : Math.max(0.9, 1 * dpr);
      ctx.beginPath();
      ctx.moveTo(this.wx(seg.x1), this.wz(seg.z1));
      ctx.lineTo(this.wx(seg.x2), this.wz(seg.z2));
      ctx.stroke();
    }
  }

  private drawDraftScreen(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (this.brushStroke && this.isPaintTool() && this.paintShape === 'draw') {
      const { lastSx, lastSy } = this.brushStroke;
      ctx.save();
      ctx.strokeStyle = this.tool === 'cut' ? '#e57373' : FLOOR2D_STYLE.interiorWall;
      ctx.fillStyle = this.tool === 'cut' ? 'rgba(245,245,245,0.35)' : 'rgba(224,224,224,0.35)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(lastSx, lastSy, BRUSH_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }

    const box = this.draftScreenRect();
    if (!box || box.w < 1 || box.h < 1) return;
    const { left, top, w, h } = box;
    const fillAdd = 'rgba(224,224,224,0.55)';
    const strokeAdd = FLOOR2D_STYLE.interiorWall;
    const fillCut = 'rgba(245,245,245,0.8)';
    const strokeCut = '#e57373';

    if (this.tool === 'cut') {
      if (this.isPaintTool() && this.paintShape === 'circle') {
        this.drawScreenEllipseDraft(ctx, left, top, w, h, fillCut, strokeCut, dpr);
      } else if (this.isPaintTool() && this.paintShape === 'triangle') {
        this.drawScreenTriangleDraft(ctx, left, top, w, h, fillCut, strokeCut, dpr);
      } else {
        ctx.fillStyle = fillCut;
        ctx.strokeStyle = strokeCut;
        ctx.fillRect(left, top, w, h);
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.strokeRect(left, top, w, h);
        ctx.setLineDash([]);
      }
    } else if (this.tool === 'object') {
      const mat = this.objectMaterial;
      if (mat) {
        drawFloorPlanSymbol(
          ctx,
          mat.kind,
          left,
          top,
          w,
          h,
          FLOOR2D_STYLE.interiorWall,
          1.15 * dpr,
          mat.kind === 'chair-row' ? { count: this.objectParamCount } : undefined,
        );
      } else {
        this.drawShape(
          ctx,
          left,
          top,
          w,
          h,
          this.objectShape,
          'rgba(255,255,255,0.85)',
          FLOOR2D_STYLE.objectBorder,
          1.5 * dpr,
          false,
        );
      }
    } else if (this.tool === 'zone' && this.zoneDrawMode === 'rectangle') {
      const preview = nextZoneColors(this.editZones.length);
      this.drawShape(
        ctx,
        left,
        top,
        w,
        h,
        'rectangle',
        preview.fill,
        preview.stroke,
        2 * dpr,
        true,
      );
    } else if (this.isPaintTool() && this.paintShape === 'circle') {
      this.drawScreenEllipseDraft(ctx, left, top, w, h, fillAdd, strokeAdd, dpr);
    } else if (this.isPaintTool() && this.paintShape === 'triangle') {
      this.drawScreenTriangleDraft(ctx, left, top, w, h, fillAdd, strokeAdd, dpr);
    } else {
      ctx.fillStyle = fillAdd;
      ctx.strokeStyle = strokeAdd;
      ctx.fillRect(left, top, w, h);
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.strokeRect(left, top, w, h);
      ctx.setLineDash([]);
    }
  }

  private drawScreenEllipseDraft(
    ctx: CanvasRenderingContext2D,
    left: number,
    top: number,
    w: number,
    h: number,
    fill: string,
    stroke: string,
    dpr: number,
  ): void {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.ellipse(left + w / 2, top + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawScreenTriangleDraft(
    ctx: CanvasRenderingContext2D,
    left: number,
    top: number,
    w: number,
    h: number,
    fill: string,
    stroke: string,
    dpr: number,
  ): void {
    const tri = [
      { x: left + w / 2, y: top },
      { x: left + w, y: top + h },
      { x: left, y: top + h },
    ];
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(tri[0].x, tri[0].y);
    ctx.lineTo(tri[1].x, tri[1].y);
    ctx.lineTo(tri[2].x, tri[2].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawRouteOnPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    path: FloorPathPoint[] | { x: number; z: number }[],
    color = FLOOR2D_STYLE.route,
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
    ctx.roundRect(x0, y0, boxW, boxH, 8 * dpr);
    ctx.fill();
    ctx.stroke();

    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach((row, i) => {
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
    });
  }

  private drawRouteBreakPoints(ctx: CanvasRenderingContext2D, dpr: number, floorId?: string): void {
    const pts = floorId
      ? this.routeBreakPoints.filter((b) => b.floorId === floorId)
      : this.routeBreakPoints;
    if (pts.length === 0) return;

    const fontSize = Math.max(9, 10 * dpr);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (const bp of pts) {
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
    const mouthOnly = routeUsesManualStairMouths(this.routeConnectors);
    const drawPaths = phase === 'paths' || phase === 'all';
    const drawOverlays = phase === 'overlays' || phase === 'all';

    if (this.routeSegments.length > 1) {
      if (!floorId) return;
      const seg = this.routeSegments.find((s) => s.floorId === floorId);
      if (drawOverlays && !mouthOnly) this.drawRouteDebugForFloor(ctx, dpr, floorId);
      if (drawPaths && seg) {
        this.drawRouteOnPath(ctx, dpr, this.trimPathForFloor(floorId, seg.path));
      }
      if (drawOverlays && !mouthOnly) this.drawRouteBreakPoints(ctx, dpr, floorId);
      return;
    }
    if (drawOverlays && floorId && !mouthOnly) this.drawRouteDebugForFloor(ctx, dpr, floorId);
    if (drawPaths) this.drawRouteOnPath(ctx, dpr, this.path);
    if (drawOverlays && !mouthOnly) {
      this.drawRouteBreakPoints(ctx, dpr, floorId ?? undefined);
      this.drawRouteDebugLegend(ctx, dpr);
    }
  }

  private trimPathForFloor(floorId: string, path: FloorPathPoint[]): FloorPathPoint[] {
    return trimPathForFloorPlate(floorId, path, this.routeConnectors);
  }

  private drawRouteScreenPath(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    points: { x: number; y: number }[],
  ): void {
    if (points.length < 2) return;
    const lw = Math.max(7, 8 * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = FLOOR2D_STYLE.route;
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

  /** Stair / lift route drawn in the air gap between floor plates. */
  private drawGapStairRoutes(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    floors: FloorLevel[],
    mapH: number,
    gapPx: number,
  ): void {
    if (this.routeConnectors.length === 0) return;
    for (const link of this.routeConnectors) {
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

      const screenPts: { x: number; y: number }[] = [ { x: exitSx, y: exitSy } ];

      if (goingUp) {
        screenPts.push({ x: exitSx, y: lowerBounds.y0 + lowerBounds.dy });
        const ySpan = upperFloor.floorY - lowerFloor.floorY;
        if (link.via.length >= 1 && Math.abs(ySpan) > 1e-4) {
          for (const v of link.via) {
            const t = Math.max(0, Math.min(1, (v.y - lowerFloor.floorY) / ySpan));
            screenPts.push({ x: this.wx(v.x), y: gapBottom + t * (gapTop - gapBottom) });
          }
        }
        screenPts.push({ x: enterSx, y: upperBounds.y1 + upperBounds.dy });
      } else {
        screenPts.push({ x: exitSx, y: upperBounds.y1 + upperBounds.dy });
        const ySpan = lowerFloor.floorY - upperFloor.floorY;
        if (link.via.length >= 1 && Math.abs(ySpan) > 1e-4) {
          for (const v of link.via) {
            const t = Math.max(0, Math.min(1, (v.y - upperFloor.floorY) / ySpan));
            screenPts.push({ x: this.wx(v.x), y: gapTop + t * (gapBottom - gapTop) });
          }
        }
        screenPts.push({ x: enterSx, y: lowerBounds.y0 + lowerBounds.dy });
      }

      screenPts.push({ x: enterSx, y: enterSy });
      this.drawRouteScreenPath(ctx, dpr, screenPts);
      this.drawStepTicksInGap(ctx, dpr, screenPts, gapTop, gapBottom);
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

    ctx.fillStyle = 'rgba(15,23,42,0.06)';
    ctx.fillRect(x0 + 3 * dpr, y1 + thickness + 2 * dpr, cardW, 5 * dpr);

    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(x0, y1, cardW, thickness);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x0, y1, cardW, Math.max(2, thickness * 0.45));

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, cardW, cardH);

    ctx.strokeStyle = isActive ? FLOOR2D_STYLE.accent : '#94a3b8';
    ctx.lineWidth = isActive ? 2.5 * dpr : 1.5 * dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cardW - 1, cardH - 1);

    const fontSize = Math.max(10, 12 * dpr);
    ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#1e293b';
    ctx.fillText(title, x0 + 10 * dpr, y0 + 8 * dpr);
  }

  /** Cache: keyed by the walkGrid array identity — invalidates automatically when a floor is re-flushed. */
  private floorWalkCache = new WeakMap<number[], Uint8Array>();

  private walkForFloorLevel(floor: FloorLevel): Uint8Array | null {
    if (!this.map) return null;
    if (floor.id === this.activeFloorId && this.editWalk) return this.editWalk;
    const floorMap = routingMapForFloor(this.map, floor);
    const need = floorMap.cols * floorMap.rows;
    if (floor.walkGrid?.length === need) {
      const cached = this.floorWalkCache.get(floor.walkGrid);
      if (cached) return cached;
      const walk = new Uint8Array(floor.walkGrid.map((v) => (v ? 1 : 0)));
      this.floorWalkCache.set(floor.walkGrid, walk);
      return walk;
    }
    const fromGrid = resolveFloorWalkGrid(floorMap, floor, this.editWalk, this.activeFloorId);
    if (fromGrid) return fromGrid;
    return getFloorWalkGrid(floorMap, floor);
  }

  private drawPoisOnFloor(ctx: CanvasRenderingContext2D, dpr: number, floor: FloorLevel): void {
    const fontSize = Math.max(9, 11 * dpr);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const sliceY = floor.floorY;

    const drawEndpoint = (id: string, color: string) => {
      const ep = this.resolveRouteEndpoint(id, sliceY);
      if (!ep) return;
      if (Math.abs(nearestFloorYForPoi(ep.y, this.editFloors) - floor.floorY) > 0.2) return;
      const px = this.wx(ep.x);
      const py = this.wz(ep.z);
      const label = truncateLabel(ep.name, 22);
      this.drawPoiMarker(ctx, px, py, color, dpr, 7);
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(label, px, py - 16 * dpr);
    };

    if (this.originId) drawEndpoint(this.originId, FLOOR2D_STYLE.origin);
    if (this.destId && this.destId !== this.originId) {
      drawEndpoint(this.destId, FLOOR2D_STYLE.destination);
    }

    for (const poi of this.pois) {
      if (poi.id === this.originId || poi.id === this.destId) continue;
      if (Math.abs(nearestFloorYForPoi(poi.y, this.editFloors) - floor.floorY) > 0.2) continue;
      const px = this.wx(poi.x);
      const py = this.wz(poi.z);
      const label = truncateLabel(poi.name, 22);
      this.drawPoiMarker(ctx, px, py, FLOOR2D_STYLE.poiMarker, dpr);
      ctx.textAlign = 'left';
      ctx.fillStyle = FLOOR2D_STYLE.poiLabel;
      ctx.fillText(label, px + 13 * dpr, py);
    }
  }

  private drawStackedFloorsView(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.map) return;
    const floors = this.sortedFloors();
    const mapH = this.map.maxZ - this.map.minZ;
    const gapPx = this.stackGapPx(dpr);
    const pad = this.platePadPx(dpr);
    const mouthOnly = routeUsesManualStairMouths(this.routeConnectors);

    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const dy = this.stackLayerDy(i, mapH, gapPx, dpr);
      const bounds = this.plateBounds(i, mapH, gapPx, dpr);
      const isActive = floor.id === this.activeFloorId;
      const preview = previewMapForFloor(this.map, floor, this.editFloors);
      const walk = this.walkForFloorLevel(floor);
      const objects = floor.objects ?? (isActive ? this.editObjects : []);
      const zones = floor.zones ?? (isActive ? this.editZones : []);
      const title = floor.label.trim() || `Floor ${i + 1}`;

      ctx.save();
      ctx.translate(0, dy);
      this.drawPlateSlab(ctx, bounds, dpr, isActive, title);

      ctx.save();
      ctx.beginPath();
      ctx.rect(bounds.x0 + pad * 0.25, bounds.y0 + pad * 0.25, bounds.x1 - bounds.x0 - pad * 0.5, bounds.y1 - bounds.y0 - pad * 0.5);
      ctx.clip();

      if (walk) {
        this.drawFloorFill(ctx, preview, walk);
        this.drawEnclosedRooms(ctx, preview, walk);
      }
      this.drawStores(ctx, preview, dpr);
      const seg = this.routeSegments.find((s) => s.floorId === floor.id);
      if (seg) {
        const trimmed = this.trimPathForFloor(floor.id, seg.path);
        this.drawRouteOnPath(ctx, dpr, trimmed);
      }
      this.drawWalls(ctx, preview, dpr, walk);
      this.drawObjects(ctx, dpr, objects);
      this.drawZones(ctx, dpr, zones);
      this.drawStairMouthsOnFloor(ctx, dpr, floor);

      if (!mouthOnly) this.drawRouteDebugForFloor(ctx, dpr, floor.id);
      if (!mouthOnly) this.drawRouteBreakPoints(ctx, dpr, floor.id);

      this.drawPoisOnFloor(ctx, dpr, floor);
      ctx.restore();
      ctx.restore();
    }

    this.drawGapStairRoutes(ctx, dpr, floors, mapH, gapPx);
    this.drawStairMouthGapLinks(ctx, dpr, floors, mapH, gapPx);
    if (!mouthOnly) this.drawRouteDebugLegend(ctx, dpr);

    if (this.routeError) {
      ctx.font = `600 ${Math.max(10, 12 * dpr)}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b91c1c';
      ctx.fillText(this.routeError, this.canvas.width * 0.5, this.canvas.height - 18 * dpr);
    }
  }

  private drawPoiMarker(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    fill: string,
    dpr: number,
    radius = 10,
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
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const sliceY = this.map?.sliceY ?? 0;
    const visible = new Set(this.poisForDisplay().map((p) => p.id));

    const drawEndpoint = (id: string, color: string) => {
      const ep = this.resolveRouteEndpoint(id, sliceY);
      if (!ep) return;
      const poi = this.pois.find((p) => p.id === id);
      if (poi && !visible.has(id)) return;
      const px = this.wx(ep.x);
      const py = this.wz(ep.z);
      const label = truncateLabel(ep.name, 22);
      this.drawPoiMarker(ctx, px, py, color, dpr, 7);
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(label, px, py - 16 * dpr);
    };

    if (this.originId) drawEndpoint(this.originId, FLOOR2D_STYLE.origin);
    if (this.destId && this.destId !== this.originId) {
      drawEndpoint(this.destId, FLOOR2D_STYLE.destination);
    }
    for (const poi of this.pois) {
      if (poi.id === this.originId || poi.id === this.destId) continue;
      if (!visible.has(poi.id)) continue;
      const px = this.wx(poi.x);
      const py = this.wz(poi.z);
      const maxLen = 22;
      const label = poi.name.length > maxLen ? poi.name.slice(0, maxLen - 1) + '…' : poi.name;
      this.drawPoiMarker(ctx, px, py, FLOOR2D_STYLE.poiMarker, dpr);
      ctx.textAlign = 'left';
      ctx.fillStyle = FLOOR2D_STYLE.poiLabel;
      ctx.fillText(label, px + 13 * dpr, py);
    }
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.map) return;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const preview = this.previewMap();
    if (!preview) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = FLOOR2D_STYLE.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.usesStackedPlate3d()) {
      this.enableMultiFloor3dView();
      this.syncScene3d(false);
      return;
    }

    ctx.save();
    const { cx, cy } = this.canvasCenterDevice();
    ctx.translate(cx, cy);
    ctx.rotate(this.viewRotation);
    ctx.translate(-cx, -cy);

    const activeFloor = this.getActiveFloor();
    this.drawFloorFill(ctx, preview, this.editWalk!);
    if (this.editWalk) this.drawEnclosedRooms(ctx, preview, this.editWalk);
    this.drawNavMesh(ctx, dpr);
    this.drawStores(ctx, preview, dpr);
    this.drawRoute(ctx, dpr, 'paths');
    this.drawWalls(ctx, preview, dpr, this.editWalk);
    this.drawObjects(ctx, dpr);
    this.drawZones(ctx, dpr);
    if (activeFloor) {
      this.drawStairMouthsOnFloor(ctx, dpr, activeFloor);
    }
    this.drawStairMouthLinkHint(ctx, dpr);
    this.drawPolygonDraft(ctx, dpr);
    this.drawRoute(ctx, dpr, 'overlays');
    this.drawPois(ctx, dpr);
    ctx.restore();

    this.drawDraftScreen(ctx, dpr);

    if (this.scene3dWanted()) this.syncScene3d();
  }

  dispose(): void {
    this.scene3d?.dispose();
    this.scene3d = null;
    this.zoneDialog?.remove();
    this.zoneSidebar?.remove();
    this.paintShapeToolbar?.remove();
    this.zoneDialog = null;
    this.zoneNameInput = null;
    this.zoneDialogOkBtn = null;
    this.zoneDialogTitle = null;
    this.zoneSidebar = null;
    this.paintShapeToolbar = null;
    this.paintShapeBtns = {};
    this.zoneListEl = null;
    this.floorListEl = null;
    this.subfloorListEl = null;
    this.canvas.remove();
  }
}
