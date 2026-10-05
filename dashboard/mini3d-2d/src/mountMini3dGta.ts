import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  DEFAULT_GTA,
  DEFER_NAV_MESH,
  DEFER_NAV_MESH_2D,
  DRACO_DECODER_PATH,
  FLOOR_SLICE_Y,
  MAP_LAZY_BACKGROUND_CONCURRENCY,
  MAP_LAZY_EAGER_COUNT,
  MAP_LAZY_FLOOR_REBUILD_MS,
  SLICE_REBUILD_DEBOUNCE_MS,
  type GtaConfig,
  MULTISET_PUBLIC_API,
} from './config';
import { buildFloor2DFromMapAsync, type FloorGridCache } from './floor2dBuild';
import { clearStairPortalCache } from './floor2dMultiRoute';
import { Floor2DView } from './floor2dView';
import { fetchAnalyzedFloorPlanFromMap } from './fetchFloorPlan';
import type { Floor2DTool, ZoneDrawMode } from './floor2dView';
import {
  buildMultiSetEndpoints,
  getM2MTokenCached,
  lazyLoadMapMeshes,
  type MapSetMeshEntry,
  resolveGlbCorsProxyPostUrl,
  resolveMultiSetApiBase,
} from './multiset';
import { applyMapTransparentGhostMaterial, disposeMapChildren } from './mapMaterials';
import { OBJECT_CATALOG, type ObjectCatalogItem } from './objectCatalog';
import { drawFloorPlanSymbolPreview } from './objectSymbols';
import { clearNavMesh, ensureNavMeshForMap, getNavMesh, isNavMeshReady } from './navmesh';
import { buildMultiFloorPlanFromNavMesh } from './navmeshToFloorPlan';
import { createRouteAndBreadcrumbs, type RouteAndBreadcrumbsHandle } from './route';

const MAP_NAV_HINT = ' Right-drag pan · Shift+drag or Shift+scroll rotate · scroll zoom';
import {
  buildDemoPoisFromMap,
  fillRouteEndpointSelect,
  findNavMapPoi,
  getNavMapPois,
  setNavMapPois,
} from './pois';
import { applySavedFloorEditToMap, floorMapFromSavedEditAsync, savedPayloadHasWalk } from './data/floorEditPayload';
import {
  fetchNavmeLoginTypes,
  fetchNavmePoisByPoiType,
  getPoiTypeFromUrl,
  NavmeProjectConfigError,
  resolveNavmeProject,
} from './data/navmeData';
import { fetchNavmeFloorEdit, saveNavmeFloorEdit, type NavmeFloorEditRow } from './data/navmeFloorEdits';
import { isSupabaseConfigured } from './data/supabaseClient';
import {
  applyNavMeLogoToToggleButton,
  createMini3dGtaMapButton,
  injectMini3dGtaUiStyles,
  POI_PIN_SVG_DEST,
  POI_PIN_SVG_ORIGIN,
} from './ui';

function createGltfLoaderWithDraco(): { loader: GLTFLoader; draco: DRACOLoader } {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return { loader, draco };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

export interface Mini3dGtaMountOptions extends Partial<GtaConfig> {
  updateDocumentTitle?: boolean;
  /** When false, GLB + nav mesh start on page load (default true = wait for map open). */
  deferLoadUntilMapOpen?: boolean;
  suppressMapToggle?: boolean;
  /** Open fullscreen map immediately; no logo button click (default false). */
  autoStartFullscreen?: boolean;
  /** `2d` = top-down block floor plan at `floorSliceY`; `3d` = orbit GLB view. */
  viewMode?: '2d' | '3d';
  /** Y-up slice height for 2D floor (default {@link FLOOR_SLICE_Y}). */
  floorSliceY?: number;
}

export interface Mini3dGtaHandle {
  readonly rootElement: HTMLElement;
  readonly ready: Promise<void>;
  openFullscreen(): void;
  closeFullscreen(): void;
  setOrigin(x: number, y: number, z: number): void;
  setDestination(x: number, y: number, z: number): void;
  rebuildRoute(): void;
  getRouteState(): RouteAndBreadcrumbsHandle['state'] | null;
  dispose(): void;
}

const NOTIFY_BASE_STYLE =
  'position:absolute;top:8px;left:8px;right:8px;z-index:2;max-width:calc(100% - 16px);padding:10px 12px;border-radius:var(--float-radius,8px);font:12px/1.4 var(--font-body,system-ui,sans-serif);color:var(--text-1,#0b1a2e);background:var(--bg-surface,#fff);border:1px solid var(--border-base,#e6ebf2);pointer-events:none;';

export function mountMini3dGta(
  _container: HTMLElement,
  options: Mini3dGtaMountOptions = {},
): Mini3dGtaHandle {
  const cfg = { ...DEFAULT_GTA, ...options };
  const updateDocumentTitle = options.updateDocumentTitle === true;
  const autoStart = options.autoStartFullscreen === true;
  const viewMode = options.viewMode ?? '2d';
  const use2d = viewMode === '2d';
  let floorSliceY = options.floorSliceY ?? FLOOR_SLICE_Y;
  const deferHeavy = !autoStart && options.deferLoadUntilMapOpen !== false;
  const suppressMapToggle = options.suppressMapToggle === true || autoStart;

  let mountRoot: HTMLElement;
  let viewport: HTMLElement;
  let fsOverlay: HTMLElement | null = null;
  let toggleBtn: HTMLButtonElement | null = null;
  let originSelect: HTMLSelectElement | null = null;
  let destSelect: HTMLSelectElement | null = null;
  let mapOverlayLayer: HTMLDivElement | null = null;
  const poiLabelEls = new Map<string, HTMLSpanElement>();
  let originPinEl: HTMLDivElement | null = null;
  let destPinEl: HTMLDivElement | null = null;
  const overlayProject = new THREE.Vector3();
  let resizeViewportFn: (() => void) | null = null;
  let rebuildMapOverlayFn: (() => void) | null = null;
  let setFullscreenOpenFn: ((open: boolean) => void) | null = null;
  let applyPoiSelectionsFn: (() => void) | null = null;
  let floor2dView: Floor2DView | null = null;
  let floorAnalyzeGen = 0;
  let floorBuildGen = 0;
  let mapLoadGen = 0;
  let lazyFloorDebounce: ReturnType<typeof setTimeout> | null = null;
  let sliceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let floorGridCache: FloorGridCache | null = null;
  let floorBuildInFlight = false;
  let floorLoadedFromSaved = false;
  let syncFloor2dRouteFn: (() => void) | null = null;
  let navMeshBuilding = false;
  let navMesh2dPromise: Promise<{ success: boolean; error?: string; durationMs: number }> | null = null;
  let pendingFloorEdit: NavmeFloorEditRow | null = null;
  let saveInFlight = false;
  /** Within 2d editor: plan2d | plan3d (From VPS converts navmesh → plan then opens plan3d). */
  type EditorDisplayMode = 'plan2d' | 'plan3d';
  let editorDisplayMode: EditorDisplayMode = 'plan2d';
  let renderGlbOrbit = false;

  const uiCanvas = document.createElement('canvas');
  uiCanvas.style.cssText = use2d
    ? 'display:none;width:100%;height:100%;touch-action:none;'
    : 'display:block;width:100%;height:100%;touch-action:none;';

  const uiNotify = document.createElement('div');
  uiNotify.setAttribute('role', 'status');
  const uiPhase = document.createElement('div');
  const uiStatus = document.createElement('p');
  uiStatus.style.cssText = 'margin:0;font-size:12px;line-height:1.45;color:var(--text-2,#5c6b80);';
  uiNotify.append(uiPhase, uiStatus);

  injectMini3dGtaUiStyles();

  if (!suppressMapToggle) {
    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'mini3dgta-map-toggle';
    applyNavMeLogoToToggleButton(toggleBtn);
  }

  fsOverlay = document.createElement('div');
  fsOverlay.className = 'mini3dgta-fs-overlay';

  const toolbar = document.createElement('div');
  toolbar.className = 'mini3dgta-fs-toolbar';

  const mkField = (
    labelText: string,
    fieldClass: string,
    labelClass: string,
    selectClass: string,
    pinIcon: string,
  ) => {
    const wrap = document.createElement('label');
    wrap.className = 'mini3dgta-fs-field ' + fieldClass;
    const labelRow = document.createElement('span');
    labelRow.className = 'mini3dgta-fs-field__label ' + labelClass;
    labelRow.innerHTML = pinIcon + '<span>' + labelText + '</span>';
    const select = document.createElement('select');
    select.className = 'mini3dgta-fs-select ' + selectClass;
    wrap.append(labelRow, select);
    return { wrap, select };
  };

  const originPinIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="#fff"/></svg>';
  const destPinIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="#fff"/></svg>';

  const originField = mkField('Origin', 'mini3dgta-fs-field--origin', 'mini3dgta-fs-field__label--origin', 'mini3dgta-fs-select--origin', originPinIcon);
  const destField = mkField('Destination', 'mini3dgta-fs-field--dest', 'mini3dgta-fs-field__label--dest', 'mini3dgta-fs-select--dest', destPinIcon);
  originSelect = originField.select;
  destSelect = destField.select;
  fillRouteEndpointSelect(originSelect, 'Choose origin…');
  fillRouteEndpointSelect(destSelect, 'Choose destination…');

  const poiTypeField = document.createElement('label');
  poiTypeField.className = 'mini3dgta-fs-field mini3dgta-fs-field--project';
  const poiTypeLabel = document.createElement('span');
  poiTypeLabel.className = 'mini3dgta-fs-field__label';
  poiTypeLabel.innerHTML = '<span>Project</span>';
  const poiTypeSelect = document.createElement('select');
  poiTypeSelect.className = 'mini3dgta-fs-select mini3dgta-fs-select--project';
  poiTypeField.append(poiTypeLabel, poiTypeSelect);

  const sliceField = document.createElement('label');
  sliceField.className = 'mini3dgta-fs-field mini3dgta-fs-field--slice';
  sliceField.style.display = use2d ? 'flex' : 'none';
  const sliceLabel = document.createElement('span');
  sliceLabel.className = 'mini3dgta-fs-field__label';
  sliceLabel.innerHTML = '<span>Floor slice (Y)</span>';
  const sliceInput = document.createElement('input');
  sliceInput.type = 'number';
  sliceInput.step = '0.1';
  sliceInput.value = String(floorSliceY);
  sliceInput.className = 'mini3dgta-fs-select';
  sliceInput.title =
    'Change Y to slice a height — draw/cut, then Add Floor. Click sidebar levels to switch back.';
  sliceField.append(sliceLabel, sliceInput);

  const mapCodeField = document.createElement('label');
  mapCodeField.className = 'mini3dgta-fs-field mini3dgta-fs-field--map';
  const mapCodeLabel = document.createElement('span');
  mapCodeLabel.className = 'mini3dgta-fs-field__label';
  mapCodeLabel.innerHTML = '<span>Map code</span>';
  const mapCodeInput = document.createElement('input');
  mapCodeInput.type = 'text';
  mapCodeInput.className = 'mini3dgta-fs-input mini3dgta-fs-input--map';
  mapCodeInput.placeholder = 'MAP_… or MSET_…';
  mapCodeInput.autocomplete = 'off';
  mapCodeInput.spellcheck = false;
  mapCodeField.append(mapCodeLabel, mapCodeInput);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'mini3dgta-fs-refresh';
  refreshBtn.textContent = 'Refresh';

  const toolsBar = document.createElement('div');
  toolsBar.className = 'mini3dgta-fs-tools';
  toolsBar.style.display = use2d ? 'flex' : 'none';

  const analyzeBtn = document.createElement('button');
  analyzeBtn.type = 'button';
  analyzeBtn.className = 'mini3dgta-fs-analyze';
  analyzeBtn.textContent = 'Structure Analyze';

  const paintFloorBtn = document.createElement('button');
  paintFloorBtn.type = 'button';
  paintFloorBtn.className = 'mini3dgta-fs-tool';
  paintFloorBtn.textContent = 'Paint Floor';
  paintFloorBtn.title = 'Drag to add walkable floor at the current Y slice.' + MAP_NAV_HINT;

  const floorBtn = document.createElement('button');
  floorBtn.type = 'button';
  floorBtn.className = 'mini3dgta-fs-tool';
  floorBtn.textContent = 'Add Floor';
  floorBtn.title = 'Save current Y as a new level (Floor 1, Floor 2, …)';

  const subfloorBtn = document.createElement('button');
  subfloorBtn.type = 'button';
  subfloorBtn.className = 'mini3dgta-fs-tool';
  subfloorBtn.textContent = 'Add Subfloor';
  subfloorBtn.title =
    'Create a small subfloor at the current Y (for stair intersections) — a popup asks which floor it belongs to. Shown with its parent; hidden from View all floors.';

  const renameFloorBtn = document.createElement('button');
  renameFloorBtn.type = 'button';
  renameFloorBtn.className = 'mini3dgta-fs-tool';
  renameFloorBtn.textContent = 'Rename Floor';
  renameFloorBtn.title = 'Rename the active floor or subfloor';
  renameFloorBtn.disabled = true;

  const deleteFloorBtn = document.createElement('button');
  deleteFloorBtn.type = 'button';
  deleteFloorBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--danger';
  deleteFloorBtn.textContent = 'Delete Floor';
  deleteFloorBtn.title = 'Delete the active floor (and its subfloors) or subfloor';
  deleteFloorBtn.disabled = true;

  const cutBtn = document.createElement('button');
  cutBtn.type = 'button';
  cutBtn.className = 'mini3dgta-fs-tool';
  cutBtn.textContent = 'Cut';
  cutBtn.title = 'Drag to carve empty space (remove floor area).' + MAP_NAV_HINT;

  const objectBtn = document.createElement('button');
  objectBtn.type = 'button';
  objectBtn.className = 'mini3dgta-fs-tool';
  objectBtn.textContent = 'Object';
  objectBtn.title = 'Place floor-plan symbols — chairs, doors, tables, stages, etc.' + MAP_NAV_HINT;

  const editObjectBtn = document.createElement('button');
  editObjectBtn.type = 'button';
  editObjectBtn.className = 'mini3dgta-fs-tool';
  editObjectBtn.textContent = 'Edit Object';
  editObjectBtn.title =
    'Select object: drag to move, corner handles to resize, top handle or R to rotate, pinch/⌘+scroll or +/- to scale. Copy/Paste supported.' +
    MAP_NAV_HINT;

  const copyObjectBtn = document.createElement('button');
  copyObjectBtn.type = 'button';
  copyObjectBtn.className = 'mini3dgta-fs-tool';
  copyObjectBtn.textContent = 'Copy Object';
  copyObjectBtn.title = 'Copy the selected object (⌘/Ctrl+C)';
  copyObjectBtn.disabled = true;
  copyObjectBtn.style.display = 'none';

  const pasteObjectBtn = document.createElement('button');
  pasteObjectBtn.type = 'button';
  pasteObjectBtn.className = 'mini3dgta-fs-tool';
  pasteObjectBtn.textContent = 'Paste Object';
  pasteObjectBtn.title = 'Paste the copied object at the mouse position (⌘/Ctrl+V)';
  pasteObjectBtn.disabled = true;
  pasteObjectBtn.style.display = 'none';

  const rotateObjectBtn = document.createElement('button');
  rotateObjectBtn.type = 'button';
  rotateObjectBtn.className = 'mini3dgta-fs-tool';
  rotateObjectBtn.textContent = 'Rotate 90°';
  rotateObjectBtn.title = 'Rotate selected object 90° (R). Shift+R rotates the other way.';
  rotateObjectBtn.disabled = true;
  rotateObjectBtn.style.display = 'none';

  const biggerObjectBtn = document.createElement('button');
  biggerObjectBtn.type = 'button';
  biggerObjectBtn.className = 'mini3dgta-fs-tool';
  biggerObjectBtn.textContent = 'Bigger';
  biggerObjectBtn.title = 'Make selected object larger (+ / ] or pinch)';
  biggerObjectBtn.disabled = true;
  biggerObjectBtn.style.display = 'none';

  const smallerObjectBtn = document.createElement('button');
  smallerObjectBtn.type = 'button';
  smallerObjectBtn.className = 'mini3dgta-fs-tool';
  smallerObjectBtn.textContent = 'Smaller';
  smallerObjectBtn.title = 'Make selected object smaller (− / [ or pinch)';
  smallerObjectBtn.disabled = true;
  smallerObjectBtn.style.display = 'none';

  const deleteObjectBtn = document.createElement('button');
  deleteObjectBtn.type = 'button';
  deleteObjectBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--danger';
  deleteObjectBtn.textContent = 'Delete Object';
  deleteObjectBtn.title = 'Delete the selected object';
  deleteObjectBtn.disabled = true;
  deleteObjectBtn.style.display = 'none';

  const zoneBtn = document.createElement('button');
  zoneBtn.type = 'button';
  zoneBtn.className = 'mini3dgta-fs-tool';
  zoneBtn.textContent = 'Add Zone';
  zoneBtn.title = 'Draw new zones — rectangle or polygon.' + MAP_NAV_HINT;

  const stairMouthBtn = document.createElement('button');
  stairMouthBtn.type = 'button';
  stairMouthBtn.className = 'mini3dgta-fs-tool';
  stairMouthBtn.textContent = 'Stair Mouth';
  stairMouthBtn.title =
    'Click walkable floor to add stair mouths (auto-creates a floor level if needed). Switch floors and click to link pairs; orange ring = linked';

  const editStairMouthBtn = document.createElement('button');
  editStairMouthBtn.type = 'button';
  editStairMouthBtn.className = 'mini3dgta-fs-tool';
  editStairMouthBtn.textContent = 'Edit Mouth';
  editStairMouthBtn.title = 'Select a stair mouth and drag to reposition it on the walkable floor';

  const deleteStairMouthBtn = document.createElement('button');
  deleteStairMouthBtn.type = 'button';
  deleteStairMouthBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--danger';
  deleteStairMouthBtn.textContent = 'Delete Mouth';
  deleteStairMouthBtn.title = 'Delete the selected stair mouth';
  deleteStairMouthBtn.disabled = true;
  deleteStairMouthBtn.style.display = 'none';

  const unlinkStairMouthBtn = document.createElement('button');
  unlinkStairMouthBtn.type = 'button';
  unlinkStairMouthBtn.className = 'mini3dgta-fs-tool';
  unlinkStairMouthBtn.textContent = 'Unlink Mouth';
  unlinkStairMouthBtn.title = 'Break the link between the selected mouth and its paired mouth on another floor';
  unlinkStairMouthBtn.disabled = true;
  unlinkStairMouthBtn.style.display = 'none';

  const editZoneBtn = document.createElement('button');
  editZoneBtn.type = 'button';
  editZoneBtn.className = 'mini3dgta-fs-tool';
  editZoneBtn.textContent = 'Edit Zone';
  editZoneBtn.title = 'Select zones, drag to reshape, pick a color in the sidebar, then Save.' + MAP_NAV_HINT;

  const deleteZoneBtn = document.createElement('button');
  deleteZoneBtn.type = 'button';
  deleteZoneBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--danger';
  deleteZoneBtn.textContent = 'Delete Zone';
  deleteZoneBtn.title = 'Delete the selected zone';
  deleteZoneBtn.disabled = true;
  deleteZoneBtn.style.display = 'none';

  const shapeBar = document.createElement('div');
  shapeBar.className = 'mini3dgta-fs-shapes';
  shapeBar.style.display = 'none';
  const rectShapeBtn = document.createElement('button');
  rectShapeBtn.type = 'button';
  rectShapeBtn.className = 'mini3dgta-fs-shape mini3dgta-fs-shape--active';
  rectShapeBtn.textContent = 'Rectangle';
  const circleShapeBtn = document.createElement('button');
  circleShapeBtn.type = 'button';
  circleShapeBtn.className = 'mini3dgta-fs-shape';
  circleShapeBtn.textContent = 'Circle';
  shapeBar.append(rectShapeBtn, circleShapeBtn);

  const zoneShapeBar = document.createElement('div');
  zoneShapeBar.className = 'mini3dgta-fs-shapes mini3dgta-fs-zone-shapes';
  zoneShapeBar.style.display = 'none';
  const zoneRectBtn = document.createElement('button');
  zoneRectBtn.type = 'button';
  zoneRectBtn.className = 'mini3dgta-fs-shape mini3dgta-fs-shape--active';
  zoneRectBtn.textContent = 'Rectangle';
  zoneRectBtn.title = 'Drag rectangle zone';
  const zonePolyBtn = document.createElement('button');
  zonePolyBtn.type = 'button';
  zonePolyBtn.className = 'mini3dgta-fs-shape';
  zonePolyBtn.textContent = 'Polygon';
  zonePolyBtn.title = 'Click corners, Enter or click first point to close';
  zoneShapeBar.append(zoneRectBtn, zonePolyBtn);

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'mini3dgta-fs-tool';
  undoBtn.textContent = 'Undo';
  undoBtn.title = 'Undo last Add or Cut (Ctrl+Z)';
  undoBtn.disabled = true;

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'mini3dgta-fs-tool';
  redoBtn.textContent = 'Redo';
  redoBtn.title = 'Redo (Ctrl+Shift+Z)';
  redoBtn.disabled = true;

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mini3dgta-fs-save';
  saveBtn.textContent = 'Save';
  saveBtn.title = 'Save floor map, regions, and zones to database';
  saveBtn.disabled = true;

  const navMeshBtn = document.createElement('button');
  navMeshBtn.type = 'button';
  navMeshBtn.className = 'mini3dgta-fs-tool';
  navMeshBtn.textContent = 'NavMesh';
  navMeshBtn.title = 'Show or hide walkable nav mesh overlay';

  const panBtn = document.createElement('button');
  panBtn.type = 'button';
  panBtn.className = 'mini3dgta-fs-tool mini3dgta-fs-tool--active';
  panBtn.textContent = 'Pan';

  const viewModeBar = document.createElement('div');
  viewModeBar.className = 'mini3dgta-fs-shapes mini3dgta-fs-viewmodes';
  viewModeBar.title = 'Switch between 2D editor, 3D from plan, and 3D from navmesh';

  const viewPlan2dBtn = document.createElement('button');
  viewPlan2dBtn.type = 'button';
  viewPlan2dBtn.className = 'mini3dgta-fs-shape mini3dgta-fs-shape--active';
  viewPlan2dBtn.textContent = '2D';
  viewPlan2dBtn.title = '2D floor-plan editor';

  const viewPlan3dBtn = document.createElement('button');
  viewPlan3dBtn.type = 'button';
  viewPlan3dBtn.className = 'mini3dgta-fs-shape';
  viewPlan3dBtn.textContent = '3D Plan';
  viewPlan3dBtn.title = 'Extrude the painted 2D map into 3D walls (orbit)';

  const viewNav3dBtn = document.createElement('button');
  viewNav3dBtn.type = 'button';
  viewNav3dBtn.className = 'mini3dgta-fs-shape';
  viewNav3dBtn.textContent = 'From VPS';
  viewNav3dBtn.title =
    'Bake full VPS GLB navmesh, detect all floors, convert to walls, show complete 3D structure';

  viewModeBar.append(viewPlan2dBtn, viewPlan3dBtn, viewNav3dBtn);

  const uploadPlanBtn = document.createElement('button');
  uploadPlanBtn.type = 'button';
  uploadPlanBtn.className = 'mini3dgta-fs-tool';
  uploadPlanBtn.textContent = 'Upload Plan';
  uploadPlanBtn.title =
    'Upload ZIP / PNG / JPEG / SVG / PDF — converts to painted floor + cuts (no image overlay; add objects yourself)';

  const uploadPlanInput = document.createElement('input');
  uploadPlanInput.type = 'file';
  uploadPlanInput.accept =
    '.zip,.png,.jpg,.jpeg,.svg,.pdf,image/*,application/pdf,application/zip';
  uploadPlanInput.multiple = true;
  uploadPlanInput.style.display = 'none';

  toolsBar.append(
    analyzeBtn,
    paintFloorBtn,
    floorBtn,
    subfloorBtn,
    renameFloorBtn,
    deleteFloorBtn,
    cutBtn,
    objectBtn,
    editObjectBtn,
    copyObjectBtn,
    pasteObjectBtn,
    rotateObjectBtn,
    biggerObjectBtn,
    smallerObjectBtn,
    deleteObjectBtn,
    zoneBtn,
    stairMouthBtn,
    editStairMouthBtn,
    deleteStairMouthBtn,
    unlinkStairMouthBtn,
    editZoneBtn,
    deleteZoneBtn,
    zoneShapeBar,
    shapeBar,
    undoBtn,
    redoBtn,
    saveBtn,
    navMeshBtn,
    panBtn,
    viewModeBar,
    uploadPlanBtn,
    uploadPlanInput,
  );

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mini3dgta-fs-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close map');
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'mini3dgta-fs-back';
  backBtn.textContent = 'Back';
  backBtn.setAttribute('aria-label', 'Go back');
  toolbar.append(originField.wrap, destField.wrap, sliceField, backBtn, closeBtn);

  const fsBody = document.createElement('div');
  fsBody.style.cssText = 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column;';

  const floor2dLayout = document.createElement('div');
  floor2dLayout.className = 'floor2d-layout';
  floor2dLayout.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0;';

  mountRoot = document.createElement('div');
  mountRoot.className = 'mini3dgta-fs-map';
  viewport = mountRoot;
  if (!deferHeavy || autoStart) viewport.appendChild(uiCanvas);

  const materialsPalette = document.createElement('div');
  materialsPalette.className = 'floor2d-materials';
  const matButtons: HTMLButtonElement[] = [];
  const clearMatActive = () =>
    matButtons.forEach((b) => b.classList.remove('floor2d-mat--active'));
  {
    const head = document.createElement('div');
    head.className = 'floor2d-materials__head';
    const title = document.createElement('span');
    title.textContent = 'Symbols';
    const freehandBtn = document.createElement('button');
    freehandBtn.type = 'button';
    freehandBtn.className = 'floor2d-materials__freehand';
    freehandBtn.textContent = 'Freehand';
    freehandBtn.title = 'Draw a plain rectangle/circle object (no material)';
    freehandBtn.addEventListener('click', () => {
      clearMatActive();
      showCountPanel(null);
      const view = ensureFloor2dView();
      view.setObjectMaterial(null);
      view.setObjectShape('rectangle');
      view.setTool('object');
    });
    head.append(title, freehandBtn);

    const countPanel = document.createElement('div');
    countPanel.className = 'floor2d-materials__count';
    countPanel.hidden = true;
    const countLabel = document.createElement('label');
    countLabel.className = 'floor2d-materials__count-label';
    countLabel.textContent = 'Number of chairs';
    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.className = 'floor2d-materials__count-input';
    countInput.min = '1';
    countInput.max = '100';
    countInput.step = '1';
    countInput.value = '4';
    countInput.title = 'Total chairs to fill the rectangle as a rows × columns grid';
    const syncCountFromView = () => {
      const view = floor2dView;
      if (!view) return;
      countInput.value = String(view.getObjectParamCount());
    };
    const applyCountToView = () => {
      const view = ensureFloor2dView();
      view.setObjectParamCount(Number(countInput.value));
    };
    countInput.addEventListener('change', applyCountToView);
    countInput.addEventListener('input', applyCountToView);
    countPanel.append(countLabel, countInput);

    const showCountPanel = (mat: ObjectCatalogItem | null) => {
      const show = !!mat?.countParam || mat?.kind === 'chair-row';
      countPanel.hidden = !show;
      if (show) syncCountFromView();
    };

    const body = document.createElement('div');
    body.className = 'floor2d-materials__body';
    for (const cat of OBJECT_CATALOG) {
      const catLabel = document.createElement('div');
      catLabel.className = 'floor2d-materials__cat';
      catLabel.textContent = cat.label;
      const grid = document.createElement('div');
      grid.className = 'floor2d-materials__grid';
      for (const it of cat.items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'floor2d-mat';
        const preview = document.createElement('canvas');
        preview.className = 'floor2d-mat__preview';
        preview.width = 36;
        preview.height = 36;
        drawFloorPlanSymbolPreview(
          preview,
          it.kind,
          '#455a64',
          it.kind === 'chair-row' ? 4 : undefined,
        );
        const name = document.createElement('span');
        name.className = 'floor2d-mat__name';
        name.textContent = it.label;
        btn.append(preview, name);
        btn.title =
          it.countParam || it.kind === 'chair-row'
            ? `${it.label} — set N, then drag a rectangle to fill with N chairs (rows × cols)`
            : `${it.label} · ${it.w}×${it.d} m — click to place, drag to size`;
        btn.addEventListener('click', () => {
          clearMatActive();
          btn.classList.add('floor2d-mat--active');
          const view = ensureFloor2dView();
          view.setObjectMaterial(it as ObjectCatalogItem);
          view.setTool('object');
          showCountPanel(it as ObjectCatalogItem);
        });
        matButtons.push(btn);
        grid.appendChild(btn);
      }
      body.append(catLabel, grid);
    }
    materialsPalette.append(head, countPanel, body);
  }
  mountRoot.appendChild(materialsPalette);

  mapOverlayLayer = document.createElement('div');
  mapOverlayLayer.className = 'mini3dgta-map-overlay';
  mapOverlayLayer.setAttribute('aria-hidden', 'true');
  mountRoot.appendChild(mapOverlayLayer);
  uiNotify.style.cssText = NOTIFY_BASE_STYLE;
  uiPhase.style.cssText =
    'font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--accent,#2b6fed);margin-bottom:4px;';
  mountRoot.appendChild(uiNotify);
  if (use2d) {
    mapOverlayLayer.style.display = 'none';
  }
  floor2dLayout.appendChild(mountRoot);
  fsBody.appendChild(floor2dLayout);
  fsOverlay.append(toolbar, toolsBar, fsBody);

  document.body.appendChild(fsOverlay);
  if (toggleBtn) document.body.appendChild(toggleBtn);

  function setNotify(phase: string, message: string, level: 'loading' | 'done' | 'error' = 'loading') {
    uiPhase.textContent = phase;
    uiStatus.textContent = message;
    uiNotify.style.display = level === 'done' ? 'none' : 'block';
    uiPhase.style.color =
      level === 'loading'
        ? 'var(--accent,#2b6fed)'
        : level === 'done'
          ? 'var(--accent-hover,#1d4ed8)'
          : 'var(--red,#dc2626)';
    if (updateDocumentTitle) {
      if (level === 'loading') document.title = `${phase} — ${cfg.baseTitle}`;
      else if (level === 'done') document.title = `${cfg.baseTitle} — ready`;
      else document.title = `${cfg.baseTitle} — error`;
    }
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f0);
  const camera = new THREE.PerspectiveCamera(55, 2, 0.05, 5000);
  camera.position.set(0, 2.5, 8);
  const renderer = new THREE.WebGLRenderer({ canvas: uiCanvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const controls = new OrbitControls(camera, uiCanvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(4, 12, 6);
  scene.add(dir);
  const mapRoot = new THREE.Group();
  mapRoot.name = 'MapMesh';
  scene.add(mapRoot);
  let routeHandle: RouteAndBreadcrumbsHandle | null = null;
  const mapBounds = new THREE.Box3();

  function fitCameraToMap() {
    mapBounds.setFromObject(mapRoot);
    if (!mapBounds.isEmpty()) {
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      mapBounds.getCenter(center);
      mapBounds.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const dist = maxDim * 1.2;
      controls.target.copy(center);
      camera.position.set(center.x + dist * 0.35, center.y + dist * 0.25, center.z + dist);
      camera.near = Math.max(0.01, dist / 2000);
      camera.far = dist * 50;
      camera.updateProjectionMatrix();
    }
    controls.update();
  }

  function clearGlbNavOverlay() {
    // retained no-op for dispose paths; GLB+raw overlay removed in favor of structure convert
  }

  function syncViewModeButtons() {
    const mode = editorDisplayMode;
    viewPlan2dBtn.classList.toggle('mini3dgta-fs-shape--active', mode === 'plan2d');
    viewPlan3dBtn.classList.toggle('mini3dgta-fs-shape--active', mode === 'plan3d');
    viewNav3dBtn.classList.toggle('mini3dgta-fs-shape--active', false);
  }

  function setUiCanvasVisible(on: boolean) {
    if (!viewport.contains(uiCanvas)) viewport.appendChild(uiCanvas);
    uiCanvas.style.display = on ? 'block' : 'none';
    renderGlbOrbit = on;
    if (on) {
      const w = Math.max(1, viewport.clientWidth);
      const h = Math.max(1, viewport.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
  }

  async function applyEditorDisplayMode(mode: EditorDisplayMode) {
    editorDisplayMode = mode;
    syncViewModeButtons();
    const view = ensureFloor2dView();
    clearGlbNavOverlay();
    setUiCanvasVisible(false);
    if (mapOverlayLayer) mapOverlayLayer.style.display = 'none';
    view.setExternalViewHidden(false);
    view.setViewMode(mode === 'plan3d' ? 'plan3d' : 'plan2d');
  }

  /**
   * Bake navmesh from the loaded VPS GLB → detect all floor Y plates →
   * convert each into walls/corridors → replace the whole building plan →
   * open 3D Plan with every level at its real height.
   */
  async function convertVpsNavMeshToStructure() {
    const view = ensureFloor2dView();
    if (mapRoot.children.length === 0) {
      setNotify('From VPS', 'Load a VPS GLB map first', 'error');
      return;
    }

    setNotify('From VPS', 'Building navmesh from full VPS GLB…', 'loading');
    const navResult = await ensureNavMeshFor2d();
    if (!navResult.success) {
      setNotify('From VPS', navResult.error || 'Failed to bake navmesh from GLB', 'error');
      return;
    }

    const nav = getNavMesh();
    if (!nav || !isNavMeshReady()) {
      setNotify('From VPS', 'Navmesh not ready', 'error');
      return;
    }

    setNotify('From VPS', 'Detecting floors from GLB + converting full building…', 'loading');
    await yieldToBrowser();
    const result = buildMultiFloorPlanFromNavMesh(nav, { mapRoot });
    if (!result || result.floors.length === 0) {
      setNotify('From VPS', 'No walkable navmesh found in the VPS GLB', 'error');
      return;
    }

    view.replaceAllFloorsFromNavMesh(result.map, result.floorLevels);
    const active = view.getActiveFloor();
    floorSliceY = active?.floorY ?? result.floors[result.floors.length - 1].floorY;
    sliceInput.value = String(floorSliceY);
    updatePaintFloorTitle();
    await applyEditorDisplayMode('plan3d');
    viewNav3dBtn.classList.add('mini3dgta-fs-shape--active');
    viewPlan3dBtn.classList.add('mini3dgta-fs-shape--active');
    const yList = result.floors.map((f) => f.floorY.toFixed(2)).join(', ');
    setNotify(
      'From VPS',
      `Full building — ${result.floors.length} floor(s) at Y=[${yList}]; ${result.stairLinks} stair link(s); ${result.walkCells} cells`,
      'done',
    );
    syncFloor2dRouteFn?.();
  }

  function projectMapPoint(x: number, y: number, z: number) {
    overlayProject.set(x, y, z);
    overlayProject.project(camera);
    const w = Math.max(1, viewport.clientWidth);
    const h = Math.max(1, viewport.clientHeight);
    const visible = overlayProject.z >= -1 && overlayProject.z <= 1;
    return { x: (overlayProject.x * 0.5 + 0.5) * w, y: (-overlayProject.y * 0.5 + 0.5) * h, visible };
  }

  function placeOverlayEl(el: HTMLElement, x: number, y: number, z: number, anchor: 'pin' | 'label') {
    const p = projectMapPoint(x, y, z);
    if (!p.visible) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.transform = anchor === 'label' ? 'translate(-50%, 4px)' : 'translate(-50%, -100%)';
  }

  function resolveRouteEndpoint(id: string): { x: number; y: number; z: number; name: string } | null {
    if (!id) return null;
    const from2d = floor2dView?.resolveRouteEndpoint(id, floorSliceY);
    if (from2d) return from2d;
    const poi = findNavMapPoi(id);
    if (poi) return { x: poi.x, y: poi.y, z: poi.z, name: poi.name };
    return null;
  }

  function getRouteZonesForSelect() {
    return floor2dView?.getRouteZones() ?? [];
  }

  function getRouteFloorsForSelect() {
    return floor2dView?.getRouteFloors() ?? [];
  }

  /** POIs for origin/destination dropdowns — filtered by active floor or all when viewing every floor. */
  function getPoisForRouteUi(): ReturnType<typeof getNavMapPois> {
    const all = getNavMapPois();
    if (!use2d || !floor2dView) return all;
    return floor2dView.poisForDisplay(getNavMapPois());
  }

  /** POIs shown on the map for the active floor selection. */
  function getPoisForActiveFloor(): ReturnType<typeof getNavMapPois> {
    if (!use2d || !floor2dView) return getNavMapPois();
    return floor2dView.poisForDisplay(getNavMapPois());
  }

  function syncFloor2dPoiDisplay() {
    if (!use2d || !floor2dView || !originSelect || !destSelect) return;
    floor2dView.setPois(getNavMapPois(), originSelect.value, destSelect.value);
    floor2dView.draw();
  }

  function updateMapOverlayPositions() {
    if (!mapOverlayLayer || fsOverlay?.style.display !== 'flex') return;
    const overlayPois = use2d ? getPoisForActiveFloor() : getNavMapPois();
    for (const poi of overlayPois) {
      const label = poiLabelEls.get(poi.id);
      if (label) placeOverlayEl(label, poi.x, poi.y + 0.32, poi.z, 'label');
    }
    if (originPinEl && originSelect?.value) {
      const o = resolveRouteEndpoint(originSelect.value);
      if (o) {
        originPinEl.classList.remove('mini3dgta-route-pin--hidden');
        placeOverlayEl(originPinEl, o.x, o.y + 0.35, o.z, 'pin');
      } else originPinEl.classList.add('mini3dgta-route-pin--hidden');
    }
    if (destPinEl && destSelect?.value) {
      const d = resolveRouteEndpoint(destSelect.value);
      if (d) {
        destPinEl.classList.remove('mini3dgta-route-pin--hidden');
        placeOverlayEl(destPinEl, d.x, d.y + 0.35, d.z, 'pin');
      } else destPinEl.classList.add('mini3dgta-route-pin--hidden');
    }
  }

  function rebuildMapOverlay() {
    if (!mapOverlayLayer) return;
    mapOverlayLayer.innerHTML = '';
    poiLabelEls.clear();
    originPinEl = null;
    destPinEl = null;
    const overlayPois = use2d ? getPoisForActiveFloor() : getNavMapPois();
    for (const poi of overlayPois) {
      const label = document.createElement('span');
      label.className = 'mini3dgta-poi-label';
      label.textContent = poi.name;
      label.title = poi.name;
      mapOverlayLayer.appendChild(label);
      poiLabelEls.set(poi.id, label);
    }
    if (originSelect?.value) {
      originPinEl = document.createElement('div');
      originPinEl.className = 'mini3dgta-route-pin';
      originPinEl.innerHTML = POI_PIN_SVG_ORIGIN;
      mapOverlayLayer.appendChild(originPinEl);
    }
    if (destSelect?.value) {
      destPinEl = document.createElement('div');
      destPinEl.className = 'mini3dgta-route-pin';
      destPinEl.innerHTML = POI_PIN_SVG_DEST;
      mapOverlayLayer.appendChild(destPinEl);
    }
    updateMapOverlayPositions();
  }

  function refreshPoiSelects() {
    if (!originSelect || !destSelect) return;
    const pois = getPoisForRouteUi();
    const zones = getRouteZonesForSelect();
    const floors = getRouteFloorsForSelect();
    const floorLevels = floor2dView?.getFloorLevels() ?? [];
    const o = originSelect.value;
    const d = destSelect.value;
    fillRouteEndpointSelect(
      originSelect,
      'Choose origin…',
      pois,
      zones,
      floors,
      d || undefined,
      o,
      floorLevels,
    );
    fillRouteEndpointSelect(
      destSelect,
      'Choose destination…',
      pois,
      zones,
      floors,
      o || undefined,
      d,
      floorLevels,
    );
    syncFloor2dPoiDisplay();
    applyPoiSelectionsFn?.();
  }

  function syncPoiSelectionsToRoute() {
    if (!originSelect || !destSelect) return;
    const pois = getPoisForActiveFloor();
    if (!originSelect.value && pois.length > 0) originSelect.value = pois[0].id;
    if (!destSelect.value && pois.length > 1) {
      const second = pois[1].id !== originSelect.value ? pois[1] : pois.length > 2 ? pois[2] : null;
      if (second) destSelect.value = second.id;
    }
    refreshPoiSelects();
  }

  function ensureNavMeshFor2d(): Promise<{ success: boolean; error?: string; durationMs: number }> {
    if (isNavMeshReady()) {
      return Promise.resolve({ success: true, durationMs: 0 });
    }
    if (navMesh2dPromise) return navMesh2dPromise;
    navMeshBuilding = true;
    navMeshBtn.disabled = true;
    setNotify('Nav mesh', 'Building walkable nav mesh (background)…', 'loading');
    navMesh2dPromise = (async () => {
      try {
        clearStairPortalCache();
        const navResult = await ensureNavMeshForMap(mapRoot);
        if (!navResult.success) {
          setNotify('Nav mesh failed', navResult.error || 'Unknown error', 'error');
        } else {
          refreshNavMeshOverlay();
        }
        return navResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotify('Nav mesh failed', message, 'error');
        return { success: false, error: message, durationMs: 0 };
      } finally {
        navMeshBuilding = false;
        navMeshBtn.disabled = false;
        navMesh2dPromise = null;
      }
    })();
    return navMesh2dPromise;
  }

  function attachRoute() {
    if (use2d) {
      rebuildFloor2dRoute();
      return;
    }
    if (routeHandle) {
      scene.remove(routeHandle.group);
      routeHandle.dispose();
      routeHandle = null;
    }
    routeHandle = createRouteAndBreadcrumbs(() => getNavMesh(), {
      hideSphereMarkers: true,
    });
    syncPoiSelectionsToRoute();
    scene.add(routeHandle.group);
  }

  let routeRebuildRaf = 0;

  function scheduleRebuildFloor2dRoute(): void {
    if (!use2d) return;
    if (routeRebuildRaf) cancelAnimationFrame(routeRebuildRaf);
    routeRebuildRaf = requestAnimationFrame(() => {
      routeRebuildRaf = 0;
      rebuildFloor2dRoute();
    });
  }

  function rebuildFloor2dRoute(): { valid: boolean; error: string | null } {
    if (!use2d || !floor2dView || !originSelect || !destSelect) {
      floor2dView?.setPath([]);
      return { valid: false, error: null };
    }
    const o = originSelect.value ? resolveRouteEndpoint(originSelect.value) : null;
    const d = destSelect.value ? resolveRouteEndpoint(destSelect.value) : null;
    if (!o || !d) {
      floor2dView.setPath([]);
      syncFloor2dPoiDisplay();
      return { valid: false, error: null };
    }
    if (DEFER_NAV_MESH_2D && !isNavMeshReady() && !navMesh2dPromise) {
      void ensureNavMeshFor2d().then(() => {
        rebuildFloor2dRoute();
        syncFloor2dRouteFn?.();
      });
      return { valid: false, error: null };
    }
    floor2dView.flushCurrentFloorState();
    const result = floor2dView.computeAndSetRoute(getNavMesh(), o, d);
    syncFloor2dPoiDisplay();
    return { valid: result.valid, error: result.error ?? null };
  }

  function updatePaintFloorTitle() {
    paintFloorBtn.title = `Drag to paint walkable floor at Y = ${floorSliceY}.${MAP_NAV_HINT}`;
  }
  updatePaintFloorTitle();

  function ensureFloor2dView(): Floor2DView {
    if (!floor2dView) {
      floor2dView = new Floor2DView(mountRoot);
      floor2dView.setOnToolChange((tool: Floor2DTool) => {
        panBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'pan');
        paintFloorBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'add');
        cutBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'cut');
        objectBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'object');
        editObjectBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'object-edit');
        zoneBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'zone');
        stairMouthBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'stair-mouth');
        editStairMouthBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'stair-mouth-edit');
        editZoneBtn.classList.toggle('mini3dgta-fs-tool--active', tool === 'zone-edit');
        shapeBar.style.display = tool === 'object' ? 'inline-flex' : 'none';
        materialsPalette.classList.toggle('floor2d-materials--visible', tool === 'object');
        if (tool !== 'object') clearMatActive();
        const objectEditUi = tool === 'object-edit';
        copyObjectBtn.style.display = objectEditUi ? 'inline-block' : 'none';
        pasteObjectBtn.style.display = objectEditUi ? 'inline-block' : 'none';
        rotateObjectBtn.style.display = objectEditUi ? 'inline-block' : 'none';
        biggerObjectBtn.style.display = objectEditUi ? 'inline-block' : 'none';
        smallerObjectBtn.style.display = objectEditUi ? 'inline-block' : 'none';
        deleteObjectBtn.style.display = objectEditUi ? 'inline-block' : 'none';
        if (!objectEditUi) {
          copyObjectBtn.disabled = true;
          rotateObjectBtn.disabled = true;
          biggerObjectBtn.disabled = true;
          smallerObjectBtn.disabled = true;
          deleteObjectBtn.disabled = true;
        } else {
          pasteObjectBtn.disabled = !(floor2dView?.hasObjectClipboard() ?? false);
        }
        zoneShapeBar.style.display = tool === 'zone' ? 'inline-flex' : 'none';
        deleteZoneBtn.style.display = tool === 'zone-edit' ? 'inline-block' : 'none';
        if (tool !== 'zone-edit') deleteZoneBtn.disabled = true;
        deleteStairMouthBtn.style.display = tool === 'stair-mouth-edit' ? 'inline-block' : 'none';
        unlinkStairMouthBtn.style.display = tool === 'stair-mouth-edit' ? 'inline-block' : 'none';
        if (tool !== 'stair-mouth-edit') {
          deleteStairMouthBtn.disabled = true;
          unlinkStairMouthBtn.disabled = true;
        }
        updatePaintFloorTitle();
      });
      floor2dView.setOnFloorActivate((floor) => {
        floorSliceY = floor.floorY;
        sliceInput.value = String(floorSliceY);
        updatePaintFloorTitle();
        const hasFloor = !!floor2dView?.getActiveFloorId();
        deleteFloorBtn.disabled = !hasFloor;
        renameFloorBtn.disabled = !hasFloor;
        refreshPoiSelects();
        refreshNavMeshOverlay();
        syncFloor2dRouteFn?.();
      });
      floor2dView.setOnZoneSelectionChange((zoneId) => {
        deleteZoneBtn.disabled = !zoneId;
      });
      floor2dView.setOnObjectSelectionChange((objectId) => {
        deleteObjectBtn.disabled = !objectId;
        copyObjectBtn.disabled = !objectId;
        rotateObjectBtn.disabled = !objectId;
        biggerObjectBtn.disabled = !objectId;
        smallerObjectBtn.disabled = !objectId;
      });
      floor2dView.setOnObjectClipboardChange((hasClipboard) => {
        pasteObjectBtn.disabled = !hasClipboard;
      });
      floor2dView.setOnStairMouthSelectionChange((sel) => {
        deleteStairMouthBtn.disabled = !sel.mouthId;
        unlinkStairMouthBtn.disabled = !sel.linked;
      });
      floor2dView.setOnDirtyChange(() => {
        saveBtn.disabled = !floor2dView?.hasMap() || saveInFlight;
      });
      floor2dView.setOnHistoryChange((canUndo, canRedo) => {
        undoBtn.disabled = !canUndo;
        redoBtn.disabled = !canRedo;
      });
      floor2dView.setOnZonesChange(() => {
        refreshPoiSelects();
        applyPoiSelectionsFn?.();
      });
      floor2dView.setOnFloorsChange(() => {
        floor2dView?.fit();
        refreshPoiSelects();
        applyPoiSelectionsFn?.();
        floor2dView?.draw();
      });
      floor2dView.setOnViewStackChange(() => {
        syncViewModeButtons();
        refreshPoiSelects();
      });
      floor2dView.setOnIso3dChange(() => {
        syncViewModeButtons();
      });
      floor2dView.setOnViewModeChange(() => {
        syncViewModeButtons();
      });
      floor2dView.setOnRouteRebuild(() => {
        applyPoiSelectionsFn?.();
      });
    }
    return floor2dView;
  }

  function refreshNavMeshOverlay() {
    if (!use2d || !floor2dView?.isNavMeshVisible()) return;
    floor2dView.refreshNavMeshOverlay(getNavMesh(), floorSliceY);
  }

  function scheduleLazyFloorRebuild() {
    if (lazyFloorDebounce) clearTimeout(lazyFloorDebounce);
    lazyFloorDebounce = setTimeout(() => {
      lazyFloorDebounce = null;
      void show2dFloorFromMesh({
        preserveFloors: true,
        activeFloorId: floor2dView?.getActiveFloorId() ?? null,
      });
    }, MAP_LAZY_FLOOR_REBUILD_MS);
  }

  async function waitForFloorBuildSlot(): Promise<void> {
    while (floorBuildInFlight) {
      await yieldToBrowser();
    }
  }

  function hasSavedFloorForProject(): boolean {
    if (!pendingFloorEdit) return false;
    if (pendingFloorEdit.map_code.trim().toUpperCase() !== activeMapCode.trim().toUpperCase()) {
      return false;
    }
    return savedPayloadHasWalk(pendingFloorEdit.floor_data);
  }

  /** Apply saved paint from DB onto the 2D canvas. Does not skip 3D mesh / nav mesh loading. */
  async function applySavedDrawingFromDb(options: { activeFloorId?: string | null } = {}): Promise<boolean> {
    if (!use2d || !pendingFloorEdit) return false;
    setNotify('Floor', 'Loading saved drawing from database…', 'loading');
    await yieldToBrowser();
    const map = await floorMapFromSavedEditAsync(pendingFloorEdit.floor_data);
    if (!map) {
      console.warn('[Mini3dGta] Saved floor_data could not be parsed for display');
      return false;
    }

    floorSliceY = pendingFloorEdit.floor_slice_y;
    sliceInput.value = String(floorSliceY);
    updatePaintFloorTitle();

    const view = ensureFloor2dView();
    floorGridCache = {
      minX: map.minX,
      maxX: map.maxX,
      minZ: map.minZ,
      maxZ: map.maxZ,
      cellSize: map.cellSize,
      cols: map.cols,
      rows: map.rows,
    };
    mapPipelineRunning = false;
    refreshBtn.disabled = false;

    const match =
      (options.activeFloorId
        ? map.floors?.find((f) => f.id === options.activeFloorId)
        : null) ??
      map.floors?.find((f) => Math.abs(f.floorY - map.sliceY) < 1e-4) ??
      map.floors?.[0] ??
      null;
    view.setMap(map, { preserveFloors: false, activeFloorId: match?.id ?? null });
    const hasFloor = !!view.getActiveFloorId();
    deleteFloorBtn.disabled = !hasFloor;
    renameFloorBtn.disabled = !hasFloor;
    refreshPoiSelects();
    saveBtn.disabled = saveInFlight;
    refreshNavMeshOverlay();
    syncFloor2dRouteFn?.();
    setNotify('Ready', 'Loaded saved drawing', 'done');
    console.log(`[Mini3dGta] Applied saved drawing for ${activePoiType} / ${activeMapCode}`);
    return true;
  }

  async function show2dFloorFromMesh(
    options: {
      preserveFloors?: boolean;
      activeFloorId?: string | null;
      forceLoadSaved?: boolean;
      /** Full mesh scan at current slice Y — ignores saved DB snapshot. */
      fromMeshOnly?: boolean;
    } = {},
  ) {
    if (!use2d || mapRoot.children.length === 0) return;
    const gen = ++floorBuildGen;
    const view = ensureFloor2dView();
    const hasMemoryFloors = view.getFloorLevels().length > 0;
    const preserveFloors = options.preserveFloors ?? hasMemoryFloors;
    if (preserveFloors && hasMemoryFloors) view.flushCurrentFloorState();

    floorBuildInFlight = true;
    floorLoadedFromSaved = false;
    setNotify('Floor', 'Building 2D floor from 3D mesh…', 'loading');
    try {
      const base = await buildFloor2DFromMapAsync(
        mapRoot,
        floorSliceY,
        { gridCache: null },
        (pct, label) => {
          if (gen === floorBuildGen) setNotify('Floor', label, 'loading');
        },
      );
      if (gen !== floorBuildGen) return;

      floorGridCache = {
        minX: base.minX,
        maxX: base.maxX,
        minZ: base.minZ,
        maxZ: base.maxZ,
        cellSize: base.cellSize,
        cols: base.cols,
        rows: base.rows,
      };

      const savedEdit =
        !options.fromMeshOnly &&
        pendingFloorEdit?.floor_data &&
        pendingFloorEdit.map_code === activeMapCode.trim().toUpperCase()
          ? pendingFloorEdit
          : null;
      const shouldApplySaved =
        savedEdit != null && (options.forceLoadSaved === true || !preserveFloors);
      let map = shouldApplySaved
        ? applySavedFloorEditToMap(base, savedEdit.floor_data)
        : base;
      if (preserveFloors && hasMemoryFloors) {
        map = { ...map, floors: view.getFloorLevels() };
      }
      view.setMap(map, {
        preserveFloors,
        activeFloorId:
          options.activeFloorId !== undefined ? options.activeFloorId : view.getActiveFloorId(),
      });
      {
        const hasFloor = !!view.getActiveFloorId();
        deleteFloorBtn.disabled = !hasFloor;
        renameFloorBtn.disabled = !hasFloor;
      }
      refreshPoiSelects();
      saveBtn.disabled = saveInFlight;
      refreshNavMeshOverlay();
      syncFloor2dRouteFn?.();
      if (gen === floorBuildGen) {
        setNotify('Ready', 'Floor plan ready (from 3D mesh)', 'done');
      }
    } finally {
      if (gen === floorBuildGen) floorBuildInFlight = false;
    }
  }

  function switchToFloorLevel(floorY: number, activeFloorId: string | null) {
    floorSliceY = floorY;
    sliceInput.value = String(floorSliceY);
    updatePaintFloorTitle();
    pendingFloorEdit = null;
    const view = floor2dView;
    if (view?.hasMap() && activeFloorId) {
      view.activateFloorLevel(activeFloorId);
      return;
    }
    void show2dFloorFromMesh({ preserveFloors: true, activeFloorId });
  }

  async function loadFloorEditForProject(poiType: string, mapCode: string): Promise<void> {
    floor2dView?.clearFloorLevels();
    floorLoadedFromSaved = false;
    pendingFloorEdit = await fetchNavmeFloorEdit(poiType, mapCode);
    if (pendingFloorEdit) {
      floorSliceY = pendingFloorEdit.floor_slice_y;
      sliceInput.value = String(floorSliceY);
      console.log(
        `[Mini3dGta] Loaded floor edit for ${poiType} / ${mapCode} (slice Y=${floorSliceY}, ${pendingFloorEdit.floor_data.objects.length} objects, ${pendingFloorEdit.floor_data.zones.length} zones, ${pendingFloorEdit.floor_data.floors.length} floors)`,
      );
    } else {
      console.log(`[Mini3dGta] No saved floor edit for ${poiType} / ${mapCode}`);
    }
  }

  async function runStructureAnalyze() {
    if (!use2d || mapRoot.children.length === 0) return;
    const gen = ++floorAnalyzeGen;
    analyzeBtn.disabled = true;
    setNotify('Analyze', 'Python structure analysis…', 'loading');
    try {
      await fetchAnalyzedFloorPlanFromMap(mapRoot, floorSliceY);
      if (gen !== floorAnalyzeGen) return;
      await show2dFloorFromMesh({ preserveFloors: true, activeFloorId: floor2dView?.getActiveFloorId() ?? null });
      setNotify('Ready', 'Floor map ready — Add/Cut/Object, then Save', 'done');
    } catch (err) {
      setNotify('Analyze', err instanceof Error ? err.message : String(err), 'error');
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  function syncFloor2dRoute() {
    if (!use2d || !floor2dView) return;
    rebuildFloor2dRoute();
  }
  syncFloor2dRouteFn = syncFloor2dRoute;

  function resize() {
    const w = Math.max(1, viewport.clientWidth);
    const h = Math.max(1, viewport.clientHeight);
    if (use2d && !renderGlbOrbit) {
      floor2dView?.resize();
      return;
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(viewport);
  resize();
  resizeViewportFn = resize;
  rebuildMapOverlayFn = rebuildMapOverlay;

  let raf = 0;
  let disposed = false;
  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (!use2d || renderGlbOrbit) {
      controls.update();
      if (fsOverlay?.style.display === 'flex') updateMapOverlayPositions();
      renderer.render(scene, camera);
    }
  }
  tick();

  const { loader: gltfLoader, draco: dracoLoader } = createGltfLoaderWithDraco();
  let activePoiType = getPoiTypeFromUrl();
  let activeClientId = '';
  let activeClientSecret = '';
  let activeMapCode = '';
  mapCodeInput.value = activeMapCode;
  let projectReady: Promise<void> = Promise.resolve();
  let projectConfigError: string | null = null;

  async function refreshPoisForProject() {
    const pois = await fetchNavmePoisByPoiType(activePoiType);
    if (pois.length > 0) {
      setNavMapPois(pois);
    } else if (mapRoot.children.length > 0) {
      setNavMapPois(buildDemoPoisFromMap(mapRoot));
    } else {
      setNavMapPois([]);
    }
    refreshPoiSelects();
    rebuildMapOverlayFn?.();
    syncFloor2dRouteFn?.();
  }

  async function applyNavmeProject(poiType: string, reloadMapAfter = false) {
    activePoiType = poiType;
    try {
      const project = await resolveNavmeProject(poiType);
      activeClientId = project.clientId;
      activeClientSecret = project.clientSecret;
      activeMapCode = project.mapCode;
      mapCodeInput.value = activeMapCode;
      projectConfigError = null;
      console.log(
        `[Mini3dGta] navme_logins → poi_type=${project.poiType}, map_code=${project.mapCode}, client_id=${project.clientId.slice(0, 8)}…`,
      );
      await loadFloorEditForProject(poiType, activeMapCode);
      await refreshPoisForProject();
      if (reloadMapAfter) reloadMap({ skipFloorEdit: true });
      else if (use2d && mapRoot.children.length > 0 && !floorLoadedFromSaved) {
        void show2dFloorFromMesh({ forceLoadSaved: true });
      }
    } catch (err) {
      projectConfigError =
        err instanceof NavmeProjectConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      activeClientId = '';
      activeClientSecret = '';
      console.error('[Mini3dGta]', projectConfigError);
      setNotify('Config', projectConfigError, 'error');
      throw err;
    }
  }

  projectReady = (async () => {
    if (!isSupabaseConfigured()) {
      projectConfigError =
        'Supabase not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to read navme_logins';
      console.error(`[Mini3dGta] ${projectConfigError}`);
      setNotify('Config', projectConfigError, 'error');
      poiTypeSelect.replaceChildren();
      const opt = document.createElement('option');
      opt.value = activePoiType;
      opt.textContent = activePoiType;
      poiTypeSelect.appendChild(opt);
      return;
    }
    const types = await fetchNavmeLoginTypes();
    poiTypeSelect.replaceChildren();
    const list = types.length > 0 ? types : [activePoiType];
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      poiTypeSelect.appendChild(opt);
    }
    const match =
      list.find((t) => t.trim().toLowerCase() === activePoiType.trim().toLowerCase()) || list[0];
    poiTypeSelect.value = match;
    try {
      await applyNavmeProject(match);
    } catch {
      /* error already surfaced via setNotify */
    }
  })();

  let mapPipelinePromise: Promise<void> | null = null;
  let mapPipelineRunning = false;

  function cancelMapLoad(): void {
    mapLoadGen++;
    floorBuildGen++;
    floorGridCache = null;
    floorLoadedFromSaved = false;
    mapPipelinePromise = null;
    mapPipelineRunning = false;
    refreshBtn.disabled = false;
    if (lazyFloorDebounce) {
      clearTimeout(lazyFloorDebounce);
      lazyFloorDebounce = null;
    }
    if (use2d) floor2dView?.setPath([]);
  }

  const runMapPipeline = (options: { forceMesh?: boolean } = {}): Promise<void> => {
    const loadGen = ++mapLoadGen;
    const mapCode = activeMapCode.trim();
    const poiType = activePoiType;
    const LOG = '[Mini3dGta]';

    mapPipelinePromise = (async () => {
      await projectReady;
      if (loadGen !== mapLoadGen) return;

      if (use2d && floorLoadedFromSaved && !options.forceMesh) {
        console.log(`${LOG} Saved floor active — skipping 3D mesh download`);
        mapPipelineRunning = false;
        refreshBtn.disabled = false;
        return;
      }

      if (options.forceMesh) floorLoadedFromSaved = false;

      mapPipelineRunning = true;
      refreshBtn.disabled = true;
      console.log(`${LOG} Loading map ${mapCode} for ${poiType} (gen ${loadGen})`);
      clearNavMesh();
      navMesh2dPromise = null;
      disposeMapChildren(mapRoot);
      if (routeHandle) {
        scene.remove(routeHandle.group);
        routeHandle.dispose();
        routeHandle = null;
      }
      setNotify('Starting', `Loading ${mapCode}…`, 'loading');
      try {
        if (projectConfigError) {
          setNotify('Config', projectConfigError, 'error');
          return;
        }
        if (!activeClientId || !activeClientSecret) {
          setNotify(
            'Config',
            'MultiSet credentials missing — set client_id and client_secret in navme_logins',
            'error',
          );
          return;
        }
        const apiBase = resolveMultiSetApiBase(cfg);
        if (apiBase === MULTISET_PUBLIC_API) {
          console.warn(`${LOG} Direct api.multiset.ai may fail in browser — use proxy`);
        }
        const ms = buildMultiSetEndpoints(cfg);
        const glbProxy = resolveGlbCorsProxyPostUrl(cfg, apiBase);
        setNotify('Loading', mapCode.startsWith('MSET_') ? 'Fetching map set…' : 'Loading map…', 'loading');
        const { token } = await getM2MTokenCached(activeClientId, activeClientSecret, ms.tokenUrl);

        const mapMeshGroup = new THREE.Group();
        mapMeshGroup.name = 'MapMesh';
        mapRoot.add(mapMeshGroup);

        let floorPreviewShown = false;
        let mapSetTotal = 1;
        let parsedOk = 0;

        const attachParsedMesh = async (entry: MapSetMeshEntry): Promise<boolean> => {
          const glbBuffer = entry.glbBuffer;
          if (!glbBuffer) return false;
          await yieldToBrowser();
          const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
            gltfLoader.parse(glbBuffer, '', resolve, reject);
          });
          if (loadGen !== mapLoadGen) return false;
          if (entry.mapCode) gltf.scene.name = `MapMesh_${entry.mapCode}`;
          if (entry.relativePose) {
            const { position, quaternion } = entry.relativePose;
            gltf.scene.position.set(position.x, position.y, position.z);
            gltf.scene.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
            gltf.scene.updateMatrix();
          }
          mapMeshGroup.add(gltf.scene);
          gltf.scene.updateMatrixWorld(true);
          return true;
        };

        const entries = await lazyLoadMapMeshes(token, mapCode, ms, glbProxy, {
          preferSmallerMesh: use2d,
          eagerCount: MAP_LAZY_EAGER_COUNT,
          backgroundConcurrency: MAP_LAZY_BACKGROUND_CONCURRENCY,
          waitBeforeAttach: waitForFloorBuildSlot,
          onProgress: (done, total, label, phase) => {
            if (loadGen !== mapLoadGen) return;
            mapSetTotal = total;
            const phaseLabel = phase === 'eager' ? 'Loading' : 'Background';
            setNotify(
              phaseLabel,
              total > 1
                ? `${phase === 'eager' ? 'Downloading' : 'Background'} ${done}/${total} (${label})…`
                : 'Loading map…',
              'loading',
            );
          },
          onEntry: async (entry, index, total) => {
            if (loadGen !== mapLoadGen) return;
            mapSetTotal = total;
            if (!entry.glbBuffer) return;

            setNotify(
              'Parse',
              total > 1 ? `Parsing mesh ${index + 1}/${total}…` : 'Parsing GLB mesh…',
              'loading',
            );
            const attached = await attachParsedMesh(entry);
            if (!attached) return;
            parsedOk++;

            if (use2d && !floorPreviewShown) {
              floorPreviewShown = true;
              mapPipelineRunning = false;
              refreshBtn.disabled = false;
              if (!floorLoadedFromSaved) {
                if (hasSavedFloorForProject()) {
                  void applySavedDrawingFromDb();
                } else {
                  void show2dFloorFromMesh({ forceLoadSaved: true });
                }
              }
              setNotify(
                'Ready',
                floorLoadedFromSaved
                  ? 'Saved floor map — 3D mesh loading in background'
                  : total > 1
                    ? 'Map editable — remaining meshes load in background'
                    : '2D floor map — Add/Cut/Object, then Save',
                'done',
              );
            } else if (use2d && total > 1 && !floorLoadedFromSaved) {
              if (index === total - 1) {
                if (lazyFloorDebounce) clearTimeout(lazyFloorDebounce);
                lazyFloorDebounce = null;
                void show2dFloorFromMesh({
                  preserveFloors: true,
                  activeFloorId: floor2dView?.getActiveFloorId() ?? null,
                });
                setNotify('Ready', `All ${total} maps loaded — Add/Cut/Object, then Save`, 'done');
              } else {
                setNotify(
                  'Background',
                  `Mesh ${index + 1}/${total} loaded — floor updates when complete`,
                  'loading',
                );
              }
            } else if (use2d && total > 1 && floorLoadedFromSaved) {
              setNotify(
                'Background',
                `Mesh ${index + 1}/${total} loaded`,
                index === total - 1 ? 'done' : 'loading',
              );
            }
          },
        });

        if (loadGen !== mapLoadGen) return;

        const loaded = entries.filter((entry) => entry.glbBuffer);
        if (!loaded.length) {
          const failed = entries.map((e) => e.mapName || e.mapCode).join(', ');
          setNotify(
            'Stopped',
            entries.length > 1
              ? `No GLB loaded from map set (${failed || mapCode}).`
              : 'No GLB found for this map code.',
            'error',
          );
          return;
        }

        if (use2d && !floorPreviewShown && !floorLoadedFromSaved) {
          if (hasSavedFloorForProject()) {
            void applySavedDrawingFromDb();
            floorPreviewShown = true;
          } else {
            await show2dFloorFromMesh({ forceLoadSaved: true });
          }
        }

        await yieldToBrowser();
        if (mapMeshGroup.children.length) mapMeshGroup.updateMatrixWorld(true);
        if (!use2d) fitCameraToMap();
        await refreshPoisForProject();
        rebuildMapOverlay();

        const summary =
          mapSetTotal > 1
            ? parsedOk === mapSetTotal
              ? `All ${mapSetTotal} maps loaded`
              : `${parsedOk}/${mapSetTotal} maps loaded`
            : null;
        if (!floorPreviewShown || mapSetTotal === 1) {
          setNotify(
            'Ready',
            use2d
              ? summary
                ? `${summary} — Add/Cut/Object, then Save`
                : '2D floor map — Add/Cut/Object, then Save'
              : summary
                ? `${summary} — preparing navigation…`
                : 'Map visible — preparing navigation…',
            'done',
          );
        }
        await yieldToBrowser();
        if (!use2d) requestAnimationFrame(() => applyMapTransparentGhostMaterial(mapMeshGroup));

        const finishNavAndRoute = async () => {
          if (use2d && DEFER_NAV_MESH_2D) {
            attachRoute();
            const hasRouteEndpoints = Boolean(originSelect?.value && destSelect?.value);
            if (hasRouteEndpoints) {
              void ensureNavMeshFor2d().then(() => {
                const route = rebuildFloor2dRoute();
                if (!route.valid) {
                  setNotify('Path', route.error || 'Could not build path on nav mesh', 'error');
                }
              });
            }
            return;
          }

          if (use2d) {
            navMeshBuilding = true;
            navMeshBtn.disabled = true;
            setNotify('Nav mesh', 'Building walkable nav mesh…', 'loading');
            try {
              clearStairPortalCache();
              const navResult = await ensureNavMeshForMap(mapRoot);
              if (!navResult.success) {
                setNotify('Nav mesh failed', navResult.error || 'Unknown error', 'error');
              }
              refreshNavMeshOverlay();
            } catch (err) {
              console.warn('[navmesh] build failed:', err);
              setNotify('Nav mesh failed', err instanceof Error ? err.message : String(err), 'error');
            } finally {
              navMeshBuilding = false;
              navMeshBtn.disabled = false;
            }
            attachRoute();
            const route = rebuildFloor2dRoute();
            const hasRouteEndpoints = Boolean(originSelect?.value && destSelect?.value);
            if (hasRouteEndpoints && !route.valid) {
              setNotify('Path', route.error || 'Could not build path on nav mesh', 'error');
              return;
            }
            setNotify('Ready', 'Floor navigation ready (nav mesh route)', 'done');
            return;
          }

          navMeshBuilding = true;
          navMeshBtn.disabled = true;
          setNotify('Nav mesh', 'Building walkable nav mesh…', 'loading');
          try {
            const navResult = await ensureNavMeshForMap(mapRoot);
            if (!navResult.success) {
              setNotify('Nav mesh failed', navResult.error || 'Unknown error', 'error');
              return;
            }
            attachRoute();
            syncFloor2dRouteFn?.();
            refreshNavMeshOverlay();
            const hasRouteEndpoints = Boolean(originSelect?.value && destSelect?.value);
            if (hasRouteEndpoints && !routeHandle?.state.valid) {
              setNotify('Path', routeHandle?.state.error || 'Could not build path', 'error');
              return;
            }
            setNotify('Ready', `Navigation ready (${(navResult.durationMs / 1000).toFixed(1)}s)`, 'done');
          } catch (err) {
            console.error('[navmesh]', err);
            setNotify('Nav mesh failed', err instanceof Error ? err.message : String(err), 'error');
          } finally {
            navMeshBuilding = false;
            navMeshBtn.disabled = false;
          }
        };

        if (DEFER_NAV_MESH) void finishNavAndRoute();
        else {
          setNotify('Nav mesh', 'Building walkable nav mesh…', 'loading');
          await finishNavAndRoute();
        }
      } catch (err) {
        console.error(LOG, err);
        if (loadGen === mapLoadGen) {
          setNotify('Error', err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        if (loadGen === mapLoadGen) {
          mapPipelineRunning = false;
          refreshBtn.disabled = false;
          mapPipelinePromise = null;
        }
      }
    })();
    return mapPipelinePromise;
  };

  const reloadMap = (options: { skipFloorEdit?: boolean; forceMesh?: boolean } = {}) => {
    const next = mapCodeInput.value.trim().toUpperCase();
    if (!next) return;
    cancelMapLoad();
    activeMapCode = next;
    mapCodeInput.value = next;
    const finish = () => void runMapPipeline({ forceMesh: options.forceMesh === true });
    if (options.skipFloorEdit) {
      finish();
      return;
    }
    void loadFloorEditForProject(activePoiType, activeMapCode).then(finish);
  };

  refreshBtn.addEventListener('click', () => reloadMap({ forceMesh: true }));
  mapCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') reloadMap();
  });
  poiTypeSelect.addEventListener('change', () => {
    void applyNavmeProject(poiTypeSelect.value, true);
  });

  const setFullscreenOpen = (open: boolean) => {
    if (!fsOverlay) return;
    fsOverlay.style.display = open ? 'flex' : 'none';
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggleBtn.classList.toggle('mini3dgta-map-toggle--hidden', open);
    }
    if (open) {
      if (!viewport.contains(uiCanvas)) viewport.appendChild(uiCanvas);
      resizeViewportFn?.();
      rebuildMapOverlayFn?.();
      if (deferHeavy) {
        void runMapPipeline();
      }
    }
  };
  setFullscreenOpenFn = setFullscreenOpen;

  if (toggleBtn) toggleBtn.addEventListener('click', () => setFullscreenOpen(fsOverlay!.style.display !== 'flex'));
  closeBtn.addEventListener('click', () => setFullscreenOpen(false));
  backBtn.addEventListener('click', () => {
    const fallbackUrl = '/access';
    if (window.history.length > 1) {
      const startHref = window.location.href;
      window.history.back();
      window.setTimeout(() => {
        if (window.location.href === startHref) {
          window.location.href = fallbackUrl;
        }
      }, 220);
      return;
    }
    window.location.href = fallbackUrl;
  });

  applyPoiSelectionsFn = () => {
    if (!originSelect || !destSelect) return;
    if (use2d) {
      scheduleRebuildFloor2dRoute();
    } else if (routeHandle) {
      const o = originSelect.value ? resolveRouteEndpoint(originSelect.value) : null;
      const d = destSelect.value ? resolveRouteEndpoint(destSelect.value) : null;
      if (o) routeHandle.setOrigin(o.x, o.y, o.z);
      if (d) routeHandle.setDestination(d.x, d.y, d.z);
    }
    rebuildMapOverlayFn?.();
    syncFloor2dRouteFn?.();
  };

  const scheduleSliceRebuild = () => {
    if (sliceDebounceTimer) clearTimeout(sliceDebounceTimer);
    sliceDebounceTimer = setTimeout(() => {
      sliceDebounceTimer = null;
      void (async () => {
        if (mapRoot.children.length === 0) {
          setNotify('Loading', 'Loading 3D mesh for slice…', 'loading');
          await runMapPipeline({ forceMesh: true });
          if (mapRoot.children.length === 0) {
            setNotify('Error', 'Could not load 3D mesh for slicing', 'error');
            return;
          }
        }
        void show2dFloorFromMesh({
          preserveFloors: true,
          activeFloorId: floor2dView?.getActiveFloorId() ?? null,
          fromMeshOnly: true,
        });
      })();
    }, SLICE_REBUILD_DEBOUNCE_MS);
  };

  function editInPlan2d(tool: Floor2DTool) {
    void applyEditorDisplayMode('plan2d').then(() => ensureFloor2dView().setTool(tool));
  }

  analyzeBtn.addEventListener('click', () => void runStructureAnalyze());
  paintFloorBtn.addEventListener('click', () => editInPlan2d('add'));
  floorBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    const floor = view.addFloorLevel(floorSliceY);
    switchToFloorLevel(floor.floorY, floor.id);
  });
  subfloorBtn.addEventListener('click', () => {
    void (async () => {
      const view = ensureFloor2dView();
      if (view.getFloorLevels().filter((f) => !f.parentFloorId).length === 0) {
        setNotify('Subfloor', 'Add a floor first — subfloors attach to a parent floor', 'error');
        return;
      }
      await applyEditorDisplayMode('plan2d');
      const sub = await view.promptAddSubfloor(floorSliceY);
      if (!sub) return;
      switchToFloorLevel(sub.floorY, sub.id);
      const hasFloor = !!view.getActiveFloorId();
      deleteFloorBtn.disabled = !hasFloor;
      renameFloorBtn.disabled = !hasFloor;
    })();
  });
  renameFloorBtn.addEventListener('click', () => {
    void ensureFloor2dView().renameActiveFloor();
  });
  deleteFloorBtn.addEventListener('click', () => {
    if (floor2dView?.deleteActiveFloor()) {
      const active = floor2dView.getActiveFloor();
      if (active) switchToFloorLevel(active.floorY, active.id);
      else void show2dFloorFromMesh({ preserveFloors: true, activeFloorId: null });
      const hasFloor = !!floor2dView.getActiveFloorId();
      deleteFloorBtn.disabled = !hasFloor;
      renameFloorBtn.disabled = !hasFloor;
    }
  });
  cutBtn.addEventListener('click', () => editInPlan2d('cut'));
  objectBtn.addEventListener('click', () => editInPlan2d('object'));
  editObjectBtn.addEventListener('click', () => editInPlan2d('object-edit'));
  copyObjectBtn.addEventListener('click', () => {
    floor2dView?.copySelectedObject();
  });
  pasteObjectBtn.addEventListener('click', () => {
    floor2dView?.pasteObjectClipboard();
  });
  rotateObjectBtn.addEventListener('click', () => {
    floor2dView?.rotateSelectedObject(90);
  });
  biggerObjectBtn.addEventListener('click', () => {
    floor2dView?.scaleSelectedObject(1.15);
  });
  smallerObjectBtn.addEventListener('click', () => {
    floor2dView?.scaleSelectedObject(1 / 1.15);
  });
  deleteObjectBtn.addEventListener('click', () => {
    floor2dView?.deleteSelectedObject();
  });
  zoneBtn.addEventListener('click', () => editInPlan2d('zone'));
  stairMouthBtn.addEventListener('click', () => editInPlan2d('stair-mouth'));
  editStairMouthBtn.addEventListener('click', () => editInPlan2d('stair-mouth-edit'));
  deleteStairMouthBtn.addEventListener('click', () => {
    floor2dView?.deleteSelectedStairMouth();
  });
  unlinkStairMouthBtn.addEventListener('click', () => {
    floor2dView?.unlinkSelectedStairMouth();
  });
  editZoneBtn.addEventListener('click', () => editInPlan2d('zone-edit'));
  deleteZoneBtn.addEventListener('click', () => {
    floor2dView?.deleteSelectedZone();
  });
  const setZoneDrawMode = (mode: ZoneDrawMode) => {
    const view = ensureFloor2dView();
    view.setZoneDrawMode(mode);
    zoneRectBtn.classList.toggle('mini3dgta-fs-shape--active', mode === 'rectangle');
    zonePolyBtn.classList.toggle('mini3dgta-fs-shape--active', mode === 'polygon');
  };
  zoneRectBtn.addEventListener('click', () => setZoneDrawMode('rectangle'));
  zonePolyBtn.addEventListener('click', () => setZoneDrawMode('polygon'));
  rectShapeBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    view.setObjectShape('rectangle');
    rectShapeBtn.classList.add('mini3dgta-fs-shape--active');
    circleShapeBtn.classList.remove('mini3dgta-fs-shape--active');
  });
  circleShapeBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    view.setObjectShape('circle');
    circleShapeBtn.classList.add('mini3dgta-fs-shape--active');
    rectShapeBtn.classList.remove('mini3dgta-fs-shape--active');
  });
  navMeshBtn.addEventListener('click', () => {
    const view = ensureFloor2dView();
    const next = !view.isNavMeshVisible();
    if (next && navMeshBuilding) {
      setNotify('NavMesh', 'Nav mesh is still building — please wait…', 'loading');
      return;
    }
    if (next && !isNavMeshReady()) {
      void ensureNavMeshFor2d().then((result) => {
        if (!result.success) return;
        view.setNavMeshVisible(true, getNavMesh(), floorSliceY);
        navMeshBtn.classList.add('mini3dgta-fs-tool--active');
      });
      return;
    }
    view.setNavMeshVisible(next, getNavMesh(), floorSliceY);
    navMeshBtn.classList.toggle('mini3dgta-fs-tool--active', next);
  });
  undoBtn.addEventListener('click', () => floor2dView?.undo());
  redoBtn.addEventListener('click', () => floor2dView?.redo());
  panBtn.addEventListener('click', () => ensureFloor2dView().setTool('pan'));
  viewPlan2dBtn.addEventListener('click', () => {
    void applyEditorDisplayMode('plan2d');
  });
  viewPlan3dBtn.addEventListener('click', () => {
    void applyEditorDisplayMode('plan3d');
  });
  viewNav3dBtn.addEventListener('click', () => {
    void convertVpsNavMeshToStructure();
  });

  uploadPlanBtn.addEventListener('click', () => uploadPlanInput.click());
  uploadPlanInput.addEventListener('change', () => {
    const files = uploadPlanInput.files;
    if (!files || files.length === 0) return;
    void (async () => {
      try {
        setNotify('Upload Plan', 'Reading floor plan file(s)…', 'loading');
        const { parseFloorPlanUploads } = await import('./floorPlanUpload');
        const assets = await parseFloorPlanUploads(files);
        uploadPlanInput.value = '';
        if (assets.length === 0) {
          setNotify('Upload Plan', 'No PNG / JPEG / SVG / PDF found in upload', 'error');
          return;
        }
        setNotify(
          'Upload Plan',
          `Found ${assets.length} plan(s) — painting floor + cutting voids…`,
          'loading',
        );
        const view = ensureFloor2dView();
        const result = await view.applyUploadedFloorPlans(assets, {
          trace: true,
          sliceYStart: floorSliceY,
        });
        const active = view.getActiveFloor();
        if (active) {
          floorSliceY = active.floorY;
          sliceInput.value = String(floorSliceY);
          updatePaintFloorTitle();
        }
        await applyEditorDisplayMode('plan2d');
        setNotify(
          'Upload Plan',
          `Painted ${result.floors} floor(s) — ${result.paintedCells} walk cells, ${result.cutCells} cut. Add objects when ready.`,
          'done',
        );
        syncFloor2dRouteFn?.();
      } catch (err) {
        console.error('[Upload Plan]', err);
        setNotify(
          'Upload Plan',
          err instanceof Error ? err.message : 'Failed to import floor plan',
          'error',
        );
      }
    })();
  });

  saveBtn.addEventListener('click', () => {
    void (async () => {
      const view = floor2dView;
      if (!view?.hasMap()) return;
      if (view.isDirty()) view.saveEdits();
      const activeFloor = view.getActiveFloor();
      const saveSliceY = activeFloor?.floorY ?? floorSliceY;
      const state = view.getEditStateForSave();
      const payload = view.exportEditPayload(saveSliceY, activeMapCode);
      if (!state || !payload) {
        setNotify('Save', 'Nothing to save yet', 'error');
        return;
      }
      saveInFlight = true;
      saveBtn.disabled = true;
      setNotify('Saving', 'Writing floor map to database…', 'loading');
      const result = await saveNavmeFloorEdit(
        activePoiType,
        activeMapCode,
        saveSliceY,
        state.map,
        state.walk,
        state.objects,
        state.zones,
        state.floors,
      );
      saveInFlight = false;
      saveBtn.disabled = !view.hasMap();
      if (result.ok) {
        pendingFloorEdit = {
          poi_type: activePoiType,
          map_code: activeMapCode.trim().toUpperCase(),
          floor_slice_y: saveSliceY,
          floor_data: payload,
        };
        setNotify(
          'Saved',
          `Floor map saved (${payload.objects.length} object(s), ${payload.floors.length} floor(s), ${payload.zones.length} zone(s), Y=${saveSliceY})`,
          'done',
        );
      } else {
        setNotify('Save failed', result.error || 'Could not write to database', 'error');
      }
    })();
  });
  const onFloorEditKeydown = (e: KeyboardEvent) => {
    if (!use2d || fsOverlay?.style.display !== 'flex' || !floor2dView) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    if (e.shiftKey) floor2dView.redo();
    else floor2dView.undo();
  };
  window.addEventListener('keydown', onFloorEditKeydown);

  function applySliceYChange(newY: number) {
    if (!Number.isFinite(newY)) return;
    const view = floor2dView;
    const prevY = floorSliceY;
    if (view?.getActiveFloor()) {
      view.flushCurrentFloorState();
    }
    floorSliceY = newY;
    sliceInput.value = String(floorSliceY);
    updatePaintFloorTitle();
    pendingFloorEdit = null;

    const existing = view?.getFloorLevels().find((f) => Math.abs(f.floorY - newY) < 1e-4);
    if (existing) {
      switchToFloorLevel(existing.floorY, existing.id);
      return;
    }

    view?.clearActiveFloor();
    scheduleSliceRebuild();
    refreshNavMeshOverlay();
  }

  sliceInput.addEventListener('input', () => {
    applySliceYChange(parseFloat(sliceInput.value));
  });

  originSelect.addEventListener('change', () => {
    if (destSelect && originSelect && destSelect.value === originSelect.value) destSelect.value = '';
    refreshPoiSelects();
    applyPoiSelectionsFn?.();
  });
  destSelect.addEventListener('change', () => {
    if (originSelect && destSelect && originSelect.value === destSelect.value) originSelect.value = '';
    refreshPoiSelects();
    applyPoiSelectionsFn?.();
  });

  const ready = (async () => {
    await projectReady;
    if (!deferHeavy) await runMapPipeline();
  })();

  if (autoStart) {
    queueMicrotask(() => setFullscreenOpen(true));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    dracoLoader.dispose();
    if (routeHandle) {
      scene.remove(routeHandle.group);
      routeHandle.dispose();
      routeHandle = null;
    }
    clearNavMesh();
    clearGlbNavOverlay();
    disposeMapChildren(mapRoot);
    mapOverlayLayer?.replaceChildren();
    poiLabelEls.clear();
    if (sliceDebounceTimer) clearTimeout(sliceDebounceTimer);
    if (lazyFloorDebounce) clearTimeout(lazyFloorDebounce);
    window.removeEventListener('keydown', onFloorEditKeydown);
    floor2dView?.dispose();
    floor2dView = null;
    toggleBtn?.remove();
    fsOverlay?.remove();
  }

  return {
    rootElement: mountRoot,
    ready,
    openFullscreen: () => setFullscreenOpenFn?.(true),
    closeFullscreen: () => setFullscreenOpenFn?.(false),
    setOrigin(x, y, z) {
      routeHandle?.setOrigin(x, y, z);
    },
    setDestination(x, y, z) {
      routeHandle?.setDestination(x, y, z);
    },
    rebuildRoute: () => routeHandle?.rebuild(),
    getRouteState: () => routeHandle?.state ?? null,
    dispose,
  };
}

export { createMini3dGtaMapButton };
