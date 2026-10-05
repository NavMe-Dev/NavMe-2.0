/**
 * Matterport as the project map inside the NavMe 3D editor.
 * Replaces MultiSet mesh / splat when a matterport media link is active.
 */
import {
  getMatterportSdkKey,
  matterportShowcaseUrl,
  parseMatterportModelId,
  isMatterportMediaRow,
} from '../services/matterport-url.js';
import * as THREE from 'three';
import { iconPlacePoi, iconPlaceFacility, iconPlaceMedia, iconFootprint, iconClose } from '../ui/icons.js';
import { t } from '../config/i18n.js';
import { resolveMediaDisplayUrl } from './media.js';
import {
  getPoiExpectedNormal,
  getPoiExpectedPosition,
  getPoiNavigationPosition,
  isSuperAdminMapRole,
  poiExpectedDiffersFromPlaced,
  poisData,
  poiDisplayName,
  poiDisplayDescription,
} from './pois.js';

const SDK_BOOTSTRAP =
  'https://static.matterport.com/showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js';

/** @type {Promise<void> | null} */
let bootstrapPromise = null;

/** @type {HTMLElement | null} */
let hostEl = null;
/** @type {HTMLIFrameElement | null} */
let iframeEl = null;
/** @type {HTMLElement | null} */
let clickCatcher = null;
/** @type {HTMLElement | null} */
let placeCursor = null;
/**
 * Selected entity to drag-move on the Matterport map (gizmo substitute).
 * @type {{ kind: 'poi' | 'facility' | 'media', id: string, index: number } | null}
 */
let moveTarget = null;
/** @type {((pt: { x: number, y: number, z: number }, target: NonNullable<typeof moveTarget>, phase: 'move' | 'end') => void) | null} */
let onMoveEntity = null;
/** @type {(() => void) | null} */
let onMoveDismiss = null;
let moveDragging = false;
/** When true, click-catcher captures pointer so the user can drag-reposition. */
let moveCaptureArmed = false;
/**
 * Which entity kinds the active sidebar panel wants on screen. Showcase tags
 * persist once added, so panel switches toggle opacity instead of re-adding.
 * @type {{ poi: boolean, facility: boolean, media: boolean }}
 */
let entityKindVisible = { poi: true, facility: true, media: true };
/** @type {HTMLElement | null} */
let loadingCover = null;
/** @type {ReturnType<typeof setInterval> | null} */
let progressPulseTimer = null;
let progressValue = 0;
/** @type {HTMLElement | null} */
let placeBar = null;
/** @type {any} */
let mpSdk = null;
/** @type {(() => void) | null} */
let stopWatch = null;
/** @type {{ x: number, y: number, z: number } | null} */
let livePoint = null;
/** @type {string} */
let activeMode = 'default';
/** @type {((pt: { x: number, y: number, z: number }, mode: string) => void) | null} */
let onPlace = null;
/** @type {Map<string, string>} */
const tagByEntityKey = new Map();
/** Tag ids for media overlays — billboards allowed (unlike POI pins). */
const mediaTagIds = new Set();
/** POI pin tags — Showcase billboard on hover; no click-to-navigate. */
const poiHoverTagIds = new Set();
/**
 * Every Showcase tag NavMe created this session (POI / facility / media / preview).
 * Space-authored Matterport tags are removed; these must never be.
 */
const managedShowcaseTagIds = new Set();
/** @type {Map<string, { label: string, description: string, poiId?: string | null }>} */
const poiMetaByTagId = new Map();
/** @type {HTMLElement | null} */
let poiDetailEl = null;
/** Tag id currently shown in our POI detail drawer (replaces laggy Showcase dock). */
let poiDetailTagId = null;
/** Showcase tag opened for hover (closed when the pointer leaves). */
let hoverOpenedTagId = null;
/** Last POI pin activation we notified (debounce openTags chatter). */
let lastActivatedPoiTagId = null;
/** @type {((info: {
 *   tagId: string,
 *   kind: 'poi' | 'media',
 *   id: string,
 *   poiId?: string,
 *   mediaId?: string,
 *   label: string,
 * }) => void) | null} */
let onPoiPinActivated = null;
/** Showcase tag id whose label billboard is allowed (selected POI). */
let selectedLabelTagId = null;
/** @type {Map<string, string>} mediaKey → attachment id */
const mediaAttachmentByKey = new Map();
/** @type {HTMLElement | null} */
let mediaOverlayEl = null;
/** @type {((patch: Record<string, number>, phase: 'change' | 'end') => void) | null} */
let onMediaTransform = null;
/** @type {Record<string, unknown> | null} */
let mediaPreviewItem = null;
/** @type {'translate' | 'rotate' | 'scale'} */
let mediaOverlayMode = 'translate';
/** @type {{ x: number, y: number, mode: string } | null} */
let mediaStageDrag = null;
let active = false;
/** Bumped by clearMatterportMap / new loads so in-flight Showcase loads abort cleanly. */
let matterportLoadGeneration = 0;
/** Cached Sweep.data collection — avoids re-subscribing on every POI click. */
let cachedSweepCollection = null;
/** Invalidates in-flight go-to when a newer POI/media click starts. */
let goToGeneration = 0;
/** Prevent overlapping fade go-tos (stops blink loop). */
let goToInFlight = false;
/** @type {string} */
let lastGoToKey = '';
let lastGoToAt = 0;
/** @type {any} */
let baseView = null;
/** @type {any} */
let defurnishView = null;
let defurnishAvailable = false;
/** @type {((available: boolean, active: boolean) => void) | null} */
let onDefurnishState = null;
/** @type {((pose: Record<string, unknown>) => void) | null} */
let onCameraPose = null;
/** @type {'dollhouse' | 'floorplan' | 'inside' | 'other' | null} */
let currentViewMode = null;
/** @type {Record<string, unknown> | null} */
let lastCameraPose = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let hoverRayTimer = null;
let placeInFlight = false;
/** @type {{ x: number, y: number } | null} */
let pointerDownAt = null;
/** Place-mode: green pin only while the pointer is held (not free hover). */
let placePointerActive = false;
/**
 * Matterport-style place/move preview: a real Showcase Tag (tilts with surface normal).
 * @type {string | null}
 */
let placePreviewTagId = null;
/** @type {HTMLButtonElement | null} */
let placeCancelBtn = null;
/** Surface normal at the live placement hit (unit vector). */
let liveNormal = { x: 0, y: 1, z: 0 };
/** Stem length in meters (Matterport tag scale). */
const PLACE_STEM_M = 0.32;
/** @type {THREE.Group | null} */
let placeGizmo = null; // legacy Three.js gizmo — cleared if present
/** Throttle Tag.editPosition while dragging the preview. */
let placePreviewEditInFlight = false;
/** @type {{ x: number, y: number, z: number, nx: number, ny: number, nz: number } | null} */
let placePreviewPending = null;
/** Last time we spent 2 extra rays estimating a surface normal. */
let lastNormalSampleMs = 0;
/** Coalesce pointermove into one update per animation frame. */
let hoverRaf = 0;
/** @type {PointerEvent | MouseEvent | null} */
let pendingHoverEvent = null;

/** @type {any} */
let overlayObject = null;
/** @type {any} */
let overlayRoot = null;
/** @type {any} */
let mpThree = null;
/** @type {Promise<void> | null} */
let overlayReady = null;
/** @type {any} */
let heatmapOverlay = null;
/** @type {any} */
let userTrailOverlay = null;
/** @type {string[]} */
let heatTrailTagIds = [];
/** World XYZ for 2D screen-projected orange heat dots (exact Y). */
let heatWorldPoints = [];
/** Navigation route polyline in world XYZ (2D screen-projected). */
let navWorldPoints = [];
/** Y shift applied to nav dots at draw time (sweeps are at eye height). */
let navYOffset = 0;
/** @type {HTMLCanvasElement | null} */
let heatCanvas = null;
/** @type {(() => void) | null} */
let stopHeatPoseWatch = null;
/** @type {any} */
let navRouteOverlay = null;
/** @type {any} */
let navmeshOverlay = null;
let navmeshOverlayVisible = false;
/** @type {HTMLCanvasElement | null} */
let overlayCanvas = null;
/** @type {THREE.WebGLRenderer | null} */
let overlayRenderer = null;
/** @type {THREE.PerspectiveCamera | null} */
let overlayCamera = null;
let overlayRaf = 0;
/** @type {(() => void) | null} */
let stopPoseWatch = null;
/** @type {ResizeObserver | null} */
let overlayResizeObs = null;

function loadSdkBootstrap() {
  if (typeof window !== 'undefined' && window.MP_SDK?.connect) {
    return Promise.resolve();
  }
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_BOOTSTRAP;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Space SDK script failed'));
    document.head.appendChild(s);
  });
  return bootstrapPromise;
}

function asTagId(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    const sid = value.id || value.sid || value.tagId;
    if (typeof sid === 'string' && sid) return sid;
  }
  return null;
}

/**
 * @param {HTMLElement} viewportBody
 */
function isPlaceMode(mode = activeMode) {
  return (
    mode === 'add-poi' ||
    mode === 'add-facility' ||
    mode === 'add-media' ||
    mode === 'walk'
  );
}

/** POI / amenity / media use the Matterport tag-style floor gizmo (not Go-to). */
function isTagPlaceMode(mode = activeMode) {
  return mode === 'add-poi' || mode === 'add-facility' || mode === 'add-media';
}

function isMoveMode() {
  return Boolean(active && moveTarget && !isPlaceMode());
}

/** Floor disc + stem pin for add OR armed move (same Matterport Edit look). */
function usesPlaceGizmo() {
  return isTagPlaceMode() || (isMoveMode() && moveCaptureArmed);
}

function placePreviewColor(modeKey = placeGizmoModeKey()) {
  if (String(modeKey).includes('move')) return { r: 0.96, g: 0.62, b: 0.04 };
  if (String(modeKey).includes('media')) return { r: 0.49, g: 0.23, b: 0.93 };
  if (String(modeKey).includes('facility')) return { r: 0.01, g: 0.52, b: 0.78 };
  return { r: 0.06, g: 0.46, b: 0.43 };
}

function placeGizmoModeKey() {
  if (isMoveMode()) {
    return `move:${moveTarget?.kind || 'poi'}`;
  }
  return activeMode;
}

function moveEntityTagKey(target = moveTarget) {
  if (!target) return null;
  if (target.kind === 'poi') return `poi:${target.id}`;
  if (target.kind === 'facility') return `fac:${target.id}`;
  if (target.kind === 'media') return `media:${target.id}`;
  return null;
}

function vec3(x, y, z) {
  return { x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 };
}

function vecSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecCross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function vecNormalize(v) {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!len || !Number.isFinite(len)) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function vecDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function stemFromNormal(normal = liveNormal, length = PLACE_STEM_M) {
  const n = vecNormalize(normal || { x: 0, y: 1, z: 0 });
  return { x: n.x * length, y: n.y * length, z: n.z * length };
}

/**
 * Prefer outward-facing normal (toward camera) so the stem sticks out of the surface.
 * @param {{ x: number, y: number, z: number }} point
 * @param {{ x: number, y: number, z: number }} normal
 */
function faceNormalTowardCamera(point, normal) {
  const n = vecNormalize(normal);
  const cam = lastCameraPose?.position || overlayCamera?.position;
  if (!cam) return n;
  const toCam = vecSub(vec3(cam.x, cam.y, cam.z), point);
  if (vecDot(n, toCam) < 0) {
    return { x: -n.x, y: -n.y, z: -n.z };
  }
  return n;
}

async function seedMoveGizmoFromEntity() {
  if (!moveTarget) return;
  if (moveTarget.kind === 'poi') {
    const poi = poisData[moveTarget.index];
    if (poi) {
      // Move always starts from navigation XYZ — never expected (wall click).
      const nav = getPoiNavigationPosition(poi);
      livePoint = { ...nav };
      liveNormal = { x: 0, y: 1, z: 0 };
      return;
    }
  }
  if (!mpSdk) return;
  const key = moveEntityTagKey(moveTarget);
  const tagId = key ? tagByEntityKey.get(key) : null;
  if (!tagId) return;
  try {
    const data = await mpSdk.Tag?.getData?.(tagId);
    const pos = data?.anchorPosition || data?.position;
    const stem = data?.stemVector;
    if (pos && Number.isFinite(Number(pos.x))) {
      livePoint = { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };
      if (stem && Number.isFinite(Number(stem.x))) {
        liveNormal = faceNormalTowardCamera(livePoint, vecNormalize(vec3(stem.x, stem.y, stem.z)));
      } else {
        liveNormal = { x: 0, y: 1, z: 0 };
      }
    }
  } catch {
    /* Tag.getData may be unavailable — preview waits for first pointer hit */
  }
}

async function setMoveEntityTagHidden(hidden) {
  if (!mpSdk || !moveTarget) return;
  // Hide nav + expected while moving so only the move preview pin is interactive.
  const keys = [moveEntityTagKey()].filter(Boolean);
  if (moveTarget.kind === 'poi') {
    keys.push(`poi-expected:${moveTarget.id}`);
  }
  for (const key of keys) {
    const tagId = tagByEntityKey.get(key);
    if (!tagId) continue;
    try {
      await mpSdk.Tag?.editOpacity?.(tagId, hidden ? 0 : 1);
    } catch {
      /* */
    }
  }
}

/** Keep entity pins hidden while Move POI is armed (after a mid-move save sync). */
export async function ensureMatterportMovePinsHidden() {
  if (!moveCaptureArmed) return;
  await setMoveEntityTagHidden(true);
}

/** @param {string} key An entry of tagByEntityKey, e.g. `poi-expected:12`. */
function entityKindForTagKey(key) {
  if (key.startsWith('poi:') || key.startsWith('poi-expected:')) return 'poi';
  if (key.startsWith('fac:')) return 'facility';
  if (key.startsWith('media:')) return 'media';
  return null;
}

/** Re-apply entityKindVisible to every managed tag. */
async function applyEntityKindVisibility() {
  if (!mpSdk || !active) return;
  const moveKeys = new Set(
    moveCaptureArmed
      ? [moveEntityTagKey(), moveTarget?.kind === 'poi' ? `poi-expected:${moveTarget.id}` : null]
      : [],
  );
  for (const [key, tagId] of tagByEntityKey) {
    // The move preview owns its entity's pins — don't fight setMoveEntityTagHidden.
    if (moveKeys.has(key)) continue;
    const kind = entityKindForTagKey(key);
    if (!kind) continue;
    const show = entityKindVisible[kind];
    try {
      await mpSdk.Tag?.editOpacity?.(tagId, show ? 1 : 0);
      // A 0-opacity tag still hit-tests; kill its actions so it can't be clicked.
      await mpSdk.Tag?.allowAction?.(tagId, {
        opening: show && !mediaTagIds.has(tagId) ? true : show,
        navigating: false,
        docking: show,
      });
    } catch {
      /* tag may have been removed between sync and toggle */
    }
  }
}

/**
 * Show only the entity kinds belonging to the active sidebar panel.
 * Omitted kinds default to hidden.
 * @param {{ poi?: boolean, facility?: boolean, media?: boolean }} kinds
 */
export async function setMatterportEntityKindsVisible(kinds = {}) {
  entityKindVisible = {
    poi: Boolean(kinds.poi),
    facility: Boolean(kinds.facility),
    media: Boolean(kinds.media),
  };
  await applyEntityKindVisibility();
}

function clearPlaceGizmo() {
  if (placeGizmo && overlayRoot) {
    overlayRoot.remove(placeGizmo);
  }
  disposePlaceGizmoObject(placeGizmo);
  placeGizmo = null;
  void clearPlacePreviewTag();
}

function disposePlaceGizmoObject(obj) {
  if (!obj) return;
  obj.traverse?.((child) => {
    child.geometry?.dispose?.();
    const mat = child.material;
    if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
    else {
      mat?.map?.dispose?.();
      mat?.dispose?.();
    }
  });
}

async function clearPlacePreviewTag() {
  const id = placePreviewTagId;
  placePreviewTagId = null;
  placePreviewPending = null;
  if (!id || !mpSdk) return;
  managedShowcaseTagIds.delete(id);
  try {
    if (mpSdk.Tag?.remove) await mpSdk.Tag.remove(id);
    else if (mpSdk.Mattertag?.remove) await mpSdk.Mattertag.remove(id);
  } catch {
    /* */
  }
}

/**
 * @param {{ x: number, y: number, z: number }} point
 * @param {{ x: number, y: number, z: number }} normal
 */
async function syncPlacePreviewTag(point, normal = liveNormal) {
  if (!usesPlaceGizmo() || !mpSdk || !point) return;
  const n = faceNormalTowardCamera(point, normal || liveNormal);
  liveNormal = n;
  placePreviewPending = {
    x: point.x,
    y: point.y,
    z: point.z,
    nx: n.x,
    ny: n.y,
    nz: n.z,
  };
  if (placePreviewEditInFlight) return;
  placePreviewEditInFlight = true;
  try {
    while (placePreviewPending && usesPlaceGizmo() && mpSdk) {
      const next = placePreviewPending;
      placePreviewPending = null;
      const anchorPosition = { x: next.x, y: next.y, z: next.z };
      const stemVector = stemFromNormal({ x: next.nx, y: next.ny, z: next.nz });
      if (!placePreviewTagId) {
        const color = placePreviewColor();
        const desc = {
          label: '',
          description: '',
          anchorPosition,
          stemVector,
          color,
        };
        let id = null;
        try {
          let ids = await mpSdk.Tag?.add?.(desc);
          id = asTagId(Array.isArray(ids) ? ids[0] : ids);
          if (!id) {
            ids = await mpSdk.Tag?.add?.([desc]);
            id = asTagId(Array.isArray(ids) ? ids[0] : ids);
          }
        } catch {
          /* */
        }
        if (!id && mpSdk.Mattertag?.add) {
          try {
            const ids = await mpSdk.Mattertag.add([desc]);
            id = asTagId(Array.isArray(ids) ? ids[0] : ids);
          } catch {
            /* */
          }
        }
        if (id) {
          // Register BEFORE any await so Tag.data hide cannot remove the move/place pin.
          managedShowcaseTagIds.add(id);
          placePreviewTagId = id;
          try {
            await silenceTagBillboard(mpSdk, id);
          } catch {
            /* */
          }
        }
      } else {
        try {
          if (mpSdk.Tag?.editPosition) {
            await mpSdk.Tag.editPosition(placePreviewTagId, { anchorPosition, stemVector });
          } else if (mpSdk.Mattertag?.editPosition) {
            await mpSdk.Mattertag.editPosition(placePreviewTagId, { anchorPosition, stemVector });
          }
        } catch {
          /* recreate next loop */
          managedShowcaseTagIds.delete(placePreviewTagId);
          placePreviewTagId = null;
          placePreviewPending = next;
        }
      }
    }
  } finally {
    placePreviewEditInFlight = false;
    // Flush any update that arrived while we were in-flight.
    if (placePreviewPending && usesPlaceGizmo()) {
      const queued = placePreviewPending;
      placePreviewPending = null;
      void syncPlacePreviewTag(
        { x: queued.x, y: queued.y, z: queued.z },
        { x: queued.nx, y: queued.ny, z: queued.nz },
      );
    }
  }
}

/**
 * @param {{ x: number, y: number, z: number } | null} point
 * @param {{ x: number, y: number, z: number } | null} [normal]
 */
function syncPlaceGizmoPosition(point = livePoint, normal = liveNormal) {
  if (!usesPlaceGizmo()) return;
  if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) return;
  void syncPlacePreviewTag(point, normal || liveNormal);
}

async function ensurePlaceGizmo() {
  if (!usesPlaceGizmo() || !active || !mpSdk) {
    clearPlaceGizmo();
    return;
  }
  // Drop legacy Three.js disc if it was left from an older session build.
  if (placeGizmo) {
    if (overlayRoot) overlayRoot.remove(placeGizmo);
    disposePlaceGizmoObject(placeGizmo);
    placeGizmo = null;
  }
  if (livePoint) {
    await syncPlacePreviewTag(livePoint, liveNormal);
  }
}

function syncPlaceCancelBtn() {
  if (!placeCancelBtn) return;
  // Cancel X is for Add POI / amenity / media. Move uses the Move POI bar.
  const show = active && isTagPlaceMode();
  placeCancelBtn.classList.toggle('hidden', !show);
  placeCancelBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function cancelTagPlacement() {
  if (isMoveMode()) {
    void dismissMatterportMoveBar();
    return;
  }
  if (!isTagPlaceMode()) return;
  window.dispatchEvent(new CustomEvent('spacecheck-scene-tool-cancel'));
}

/** Catcher blocks Showcase when placing, or when move-capture is armed / dragging. */
function catcherCapturing() {
  return active && (isPlaceMode() || (isMoveMode() && (moveCaptureArmed || moveDragging)));
}

function catcherActive() {
  return active && (isPlaceMode() || isMoveMode());
}

/**
 * Screen pixels relative to the Showcase iframe (top-left origin).
 * @param {number} clientX
 * @param {number} clientY
 */
function iframeScreenPoint(clientX, clientY) {
  if (!iframeEl) return null;
  const rect = iframeEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scaleX = iframeEl.clientWidth / rect.width;
  const scaleY = iframeEl.clientHeight / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/**
 * @param {{ x: number, y: number }} screen
 * @param {{ sampleNormal?: boolean }} [opts]
 * @returns {Promise<{ point: { x: number, y: number, z: number }, normal: { x: number, y: number, z: number } } | null>}
 */
async function worldHitFromScreen(screen, opts = {}) {
  if (!mpSdk?.Renderer?.getWorldPositionData) {
    return livePoint ? { point: livePoint, normal: liveNormal } : null;
  }
  try {
    const data = await mpSdk.Renderer.getWorldPositionData(screen, undefined, true);
    const pos = data?.position;
    if (!pos || !Number.isFinite(Number(pos.x))) return null;
    const point = { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };

    // One ray per frame for smooth tracking. Re-sample normal only when asked / stale.
    const now = performance.now();
    const shouldSampleNormal =
      opts.sampleNormal === true || now - lastNormalSampleMs > 140;
    let normal = liveNormal || { x: 0, y: 1, z: 0 };
    if (shouldSampleNormal) {
      lastNormalSampleMs = now;
      const eps = 10;
      try {
        const [right, up] = await Promise.all([
          mpSdk.Renderer.getWorldPositionData({ x: screen.x + eps, y: screen.y }, undefined, true),
          mpSdk.Renderer.getWorldPositionData({ x: screen.x, y: screen.y - eps }, undefined, true),
        ]);
        const rp = right?.position;
        const upPos = up?.position;
        if (
          rp &&
          upPos &&
          Number.isFinite(Number(rp.x)) &&
          Number.isFinite(Number(upPos.x))
        ) {
          const pr = { x: Number(rp.x), y: Number(rp.y), z: Number(rp.z) };
          const pu = { x: Number(upPos.x), y: Number(upPos.y), z: Number(upPos.z) };
          const candidate = vecNormalize(vecCross(vecSub(pr, point), vecSub(pu, point)));
          if (Math.hypot(candidate.x, candidate.y, candidate.z) > 0.1) {
            normal = faceNormalTowardCamera(point, candidate);
          }
        }
      } catch {
        /* keep previous normal */
      }
    }

    return { point, normal };
  } catch {
    return null;
  }
}

/**
 * @param {{ x: number, y: number }} screen
 * @returns {Promise<{ x: number, y: number, z: number } | null>}
 */
async function worldPointFromScreen(screen) {
  const hit = await worldHitFromScreen(screen);
  if (!hit) return null;
  liveNormal = hit.normal;
  return hit.point;
}

/**
 * @param {PointerEvent | MouseEvent} e
 */
async function updateHoverPoint(e) {
  const screen = iframeScreenPoint(e.clientX, e.clientY);
  if (!screen) return;
  const hit = await worldHitFromScreen(screen);
  if (!hit) return;
  livePoint = hit.point;
  liveNormal = hit.normal;
  setPlaceHint();
  syncPlaceGizmoPosition(hit.point, hit.normal);
}

/**
 * @param {PointerEvent} e
 */
async function onCatcherClick(e) {
  if (!isPlaceMode() || !onPlace || placeInFlight) return;
  // Ignore drags (orbit/pan attempts) — only real clicks place.
  if (pointerDownAt) {
    const dx = e.clientX - pointerDownAt.x;
    const dy = e.clientY - pointerDownAt.y;
    if (dx * dx + dy * dy > 36) return;
  }
  const screen = iframeScreenPoint(e.clientX, e.clientY);
  if (!screen) return;
  placeInFlight = true;
  try {
    const hit = await worldHitFromScreen(screen, { sampleNormal: true });
    const point = hit?.point || livePoint;
    if (!point) return;
    livePoint = point;
    if (hit?.normal) liveNormal = hit.normal;
    setPlaceHint();
    onPlace({ ...point, normal: { ...liveNormal } }, activeMode);
  } finally {
    placeInFlight = false;
  }
}

function placeCursorIcon(mode = activeMode) {
  if (mode === 'add-facility') return iconPlaceFacility();
  if (mode === 'add-media') return iconPlaceMedia();
  if (mode === 'walk') return iconFootprint();
  return iconPlacePoi();
}

function placeCursorClass(mode = activeMode) {
  if (isMoveMode()) return 'is-move';
  if (mode === 'add-facility') return 'is-facility';
  if (mode === 'add-media') return 'is-media';
  if (mode === 'walk') return 'is-walk';
  return 'is-poi';
}

/**
 * @param {number} clientX
 * @param {number} clientY
 */
function movePlaceCursor(clientX, clientY) {
  if (!placeCursor || !hostEl) return;
  const rect = hostEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  placeCursor.style.transform = `translate(${x}px, ${y}px) translate(-50%, -90%)`;
}

function syncPlaceCursor() {
  if (!placeCursor) return;
  // Matterport-style 3D gizmo for add + move — hide the HTML pin cursor.
  const show = catcherCapturing() && !usesPlaceGizmo();
  placeCursor.classList.toggle('is-visible', show);
  placeCursor.classList.remove('is-poi', 'is-facility', 'is-media', 'is-walk', 'is-move');
  placeCursor.classList.add(placeCursorClass());
  const iconHost = placeCursor.querySelector('.matterport-place-cursor-icon');
  if (iconHost) {
    if (isMoveMode()) {
      const kind = moveTarget?.kind;
      iconHost.innerHTML =
        kind === 'facility'
          ? iconPlaceFacility()
          : kind === 'media'
            ? iconPlaceMedia()
            : iconPlacePoi();
    } else {
      iconHost.innerHTML = placeCursorIcon();
    }
  }
  if (clickCatcher) {
    clickCatcher.style.cursor = catcherCapturing() ? (usesPlaceGizmo() ? 'crosshair' : 'none') : '';
    clickCatcher.title = isMoveMode()
      ? 'Move the pin on the floor to reposition'
      : isTagPlaceMode()
        ? 'Move the pin on the floor, then click to place'
        : 'Click a spot to place';
  }
}

function ensureMoveCloseButton() {
  if (!placeBar) return null;
  let closeBtn = placeBar.querySelector('#matterport-move-close');
  if (!closeBtn) {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'matterport-move-close';
    closeBtn.id = 'matterport-move-close';
    closeBtn.title = 'Close and return to walkthrough';
    closeBtn.setAttribute('aria-label', 'Close move bar');
    closeBtn.innerHTML = iconClose();
    placeBar.appendChild(closeBtn);
  }
  if (!closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void dismissMatterportMoveBar();
    });
  }
  return closeBtn;
}

function syncMoveArmButton() {
  const btn = placeBar?.querySelector('#matterport-move-arm');
  const closeBtn = ensureMoveCloseButton();
  if (!btn) return;
  const show = isMoveMode();
  btn.hidden = !show;
  if (closeBtn) {
    closeBtn.hidden = !show;
    if (show) closeBtn.removeAttribute('hidden');
  }
  btn.classList.toggle('active', moveCaptureArmed);
  btn.setAttribute('aria-pressed', moveCaptureArmed ? 'true' : 'false');
  const idleLabel = moveTarget?.kind === 'media' ? 'Move media' : 'Move POI';
  btn.textContent = moveCaptureArmed ? 'Done moving' : idleLabel;
}

function syncClickCatcher() {
  if (!clickCatcher) return;
  const capturing = catcherCapturing();
  // Keep catcher in place-mode always; in move-mode only while armed/dragging
  // so Showcase navigation still works when a POI is selected.
  clickCatcher.classList.toggle('hidden', !capturing);
  clickCatcher.setAttribute('aria-hidden', capturing ? 'false' : 'true');
  syncPlaceCursor();
  syncMoveArmButton();
}

/**
 * Arm / disarm Move POI — pin only appears while armed.
 * @param {boolean} armed
 */
async function setMoveCaptureArmed(armed) {
  moveCaptureArmed = Boolean(armed);
  moveDragging = false;
  // Drop any stuck in-flight edit from a prior place/move session.
  placePreviewEditInFlight = false;
  placePreviewPending = null;
  const xyz = placeBar?.querySelector('#matterport-place-xyz');
  const hint = placeBar?.querySelector('#matterport-place-hint');
  if (hint) {
    hint.textContent = moveTarget?.kind === 'media' ? 'Move media' : 'Move POI';
  }
  if (xyz) {
    xyz.textContent = moveCaptureArmed
      ? 'Click or drag on the map to reposition'
      : 'Click Move POI to reposition';
  }
  syncClickCatcher();
  syncPlaceCancelBtn();
  if (moveCaptureArmed) {
    // Seed XYZ first (sets livePoint), hide entity pins, then create amber preview.
    await seedMoveGizmoFromEntity();
    void setMoveEntityTagHidden(true);
    // Await so the pin is visible before the user starts dragging.
    await ensurePlaceGizmo();
  } else {
    clearPlaceGizmo();
    if (moveTarget?.kind === 'poi' && poisData[moveTarget.index]) {
      try {
        await syncMatterportEntityTags({ pois: [poisData[moveTarget.index]] });
      } catch (err) {
        console.warn('[space-map] move sync', err);
      }
    } else if (moveTarget?.kind === 'media') {
      /* media sync handled by move handler */
    }
    await setMoveEntityTagHidden(false);
  }
}

/**
 * Enable drag-to-move for a selected POI or media on the Matterport map.
 * Pin appears only after the user clicks Move POI.
 * @param {{ kind: 'poi' | 'media', id: string, index: number, label?: string, x?: number, y?: number, z?: number } | null} target
 */
export function setMatterportMoveTarget(target) {
  const kind = target?.kind;
  const next =
    target &&
    target.id != null &&
    (kind === 'poi' || kind === 'media')
      ? {
          kind,
          id: String(target.id),
          index: Number(target.index) || 0,
          label: String(target.label || '').trim(),
        }
      : null;

  const entityTitle = (t) => {
    if (!t) return '';
    return t.kind === 'media' ? 'Move media' : 'Move POI';
  };

  // Same selection — keep arm / drag state; only refresh labels.
  if (
    moveTarget &&
    next &&
    moveTarget.kind === next.kind &&
    moveTarget.id === next.id &&
    moveTarget.index === next.index
  ) {
    moveTarget.label = next.label || moveTarget.label;
    if (placeBar) {
      placeBar.classList.remove('hidden');
      placeBar.classList.add('is-move');
      placeBar.classList.remove('is-place');
      const hint = placeBar.querySelector('#matterport-place-hint');
      const xyz = placeBar.querySelector('#matterport-place-xyz');
      if (hint) hint.textContent = entityTitle(moveTarget);
      if (xyz && !moveCaptureArmed && !moveDragging) {
        xyz.textContent = 'Click Move POI to reposition';
      }
      syncMoveArmButton();
    }
    syncPlaceCancelBtn();
    return;
  }

  if (moveTarget) {
    void setMoveEntityTagHidden(false);
  }

  moveTarget = next;
  moveDragging = false;
  // Wait for Move POI click before showing the pin.
  moveCaptureArmed = false;
  clearPlaceGizmo();
  syncClickCatcher();
  if (moveTarget && placeBar) {
    placeBar.classList.remove('hidden');
    placeBar.classList.add('is-move');
    placeBar.classList.remove('is-place');
    const hint = placeBar.querySelector('#matterport-place-hint');
    const xyz = placeBar.querySelector('#matterport-place-xyz');
    const iconSlot = placeBar.querySelector('#matterport-place-icon');
    if (hint) hint.textContent = entityTitle(moveTarget);
    if (xyz) xyz.textContent = 'Click Move POI to reposition';
    if (iconSlot) {
      iconSlot.innerHTML = moveTarget.kind === 'media' ? iconPlaceMedia() : iconPlacePoi();
    }
    syncMoveArmButton();
  } else if (!isPlaceMode()) {
    placeBar?.classList.add('hidden');
    placeBar?.classList.remove('is-move', 'is-place');
    syncMoveArmButton();
  }
  syncPlaceCancelBtn();
}

/**
 * Keep Matterport POI name available on hover (no camera navigate).
 * Pass null to clear the “selected” highlight only.
 * @param {{ kind?: 'poi' | 'media', id?: string | number, label?: string } | null} entity
 */
export async function setMatterportSelectedLabel(entity) {
  if (!mpSdk || !active) {
    selectedLabelTagId = null;
    return;
  }

  const prevId = selectedLabelTagId;
  selectedLabelTagId = null;

  // Close previous selection billboard but keep hover enabled for POI pins.
  if (prevId && !mediaTagIds.has(prevId)) {
    try {
      await mpSdk.Tag?.close?.(prevId);
    } catch {
      /* */
    }
    if (poiHoverTagIds.has(prevId)) {
      try {
        await mpSdk.Tag?.allowAction?.(prevId, {
          opening: true,
          navigating: false,
          docking: true,
        });
      } catch {
        /* */
      }
    }
  }

  if (!entity?.id || entity.kind === 'media') {
    return;
  }

  const tagId = getMatterportTagId(entity.kind || 'poi', entity.id);
  if (!tagId) return;

  selectedLabelTagId = tagId;
  poiHoverTagIds.add(tagId);
  if (entity.label) {
    const prev = poiMetaByTagId.get(tagId);
    poiMetaByTagId.set(tagId, {
      label: String(entity.label),
      description: prev?.description || '',
      poiId: prev?.poiId ?? String(entity.id),
    });
  }
  try {
    await mpSdk.Tag?.allowAction?.(tagId, {
      opening: true,
      navigating: false,
      docking: true,
    });
  } catch {
    /* */
  }
  if (entity.label && mpSdk.Tag?.editBillboard) {
    try {
      await mpSdk.Tag.editBillboard(tagId, {
        label: String(entity.label),
        description: poiMetaByTagId.get(tagId)?.description || '',
      });
    } catch {
      /* */
    }
  }
  // Do not Tag.open / navigate — hover shows the name; camera stays where the user left it.
}

/**
 * @param {(pt: { x: number, y: number, z: number }, target: NonNullable<typeof moveTarget>, phase: 'move' | 'end') => void} fn
 */
export function setMatterportMoveHandler(fn) {
  onMoveEntity = typeof fn === 'function' ? fn : null;
}

/**
 * Called when the user closes the Move POI / media bar (X).
 * @param {(() => void) | null} fn
 */
export function setMatterportMoveDismissHandler(fn) {
  onMoveDismiss = typeof fn === 'function' ? fn : null;
}

/**
 * Fired when the user clicks a red POI pin / media pin (or View more).
 * @param {((info: {
 *   tagId: string,
 *   kind: 'poi' | 'media',
 *   id: string,
 *   poiId?: string,
 *   mediaId?: string,
 *   label: string,
 * }) => void) | null} fn
 */
export function setOnMatterportPoiPinActivated(fn) {
  onPoiPinActivated = typeof fn === 'function' ? fn : null;
}

/**
 * Close the move bar, release the click catcher, and return Showcase to walkthrough (inside).
 */
export async function dismissMatterportMoveBar() {
  await setMoveEntityTagHidden(false);
  moveTarget = null;
  moveDragging = false;
  moveCaptureArmed = false;
  placeBar?.classList.add('hidden');
  placeBar?.classList.remove('is-move', 'is-place');
  clearPlaceGizmo();
  syncPlaceCancelBtn();
  syncClickCatcher();
  try {
    await matterportSetViewMode('inside');
  } catch {
    /* */
  }
  try {
    onMoveDismiss?.();
  } catch (err) {
    console.warn('[space-map] move dismiss handler', err);
  }
}

async function applyMoveAtEvent(e, phase) {
  if (!moveTarget || !onMoveEntity) return;
  const screen = iframeScreenPoint(e.clientX, e.clientY);
  if (!screen) return;
  const hit = await worldHitFromScreen(screen, { sampleNormal: phase === 'end' });
  const point = hit?.point || livePoint;
  if (!point) return;
  livePoint = point;
  if (hit?.normal) liveNormal = hit.normal;
  setPlaceHint();
  // Live preview pin follows the pointer; Showcase entity tags stay hidden until Done.
  syncPlaceGizmoPosition(point, liveNormal);
  const xyz = placeBar?.querySelector('#matterport-place-xyz');
  if (xyz) {
    xyz.textContent = `X ${point.x.toFixed(3)}   Y ${point.y.toFixed(3)}   Z ${point.z.toFixed(3)}`;
  }
  onMoveEntity({ ...point }, moveTarget, phase);
}

/**
 * @param {number} pct
 * @param {string} [label]
 */
function setLoadingProgress(pct, label) {
  if (!loadingCover || !loadingCover.isConnected) {
    loadingCover = hostEl?.querySelector('#matterport-loading-cover') || null;
  }
  if (!loadingCover) return;
  progressValue = Math.min(100, Math.max(0, Number(pct) || 0));
  const fill = loadingCover.querySelector('.matterport-loading-fill');
  const text = loadingCover.querySelector('.matterport-loading-label');
  const pctEl = loadingCover.querySelector('.matterport-loading-pct');
  if (fill) fill.style.width = `${progressValue}%`;
  if (text && label) text.textContent = label;
  if (pctEl) pctEl.textContent = `${Math.round(progressValue)}%`;
}

function stopProgressPulse() {
  if (progressPulseTimer) {
    clearInterval(progressPulseTimer);
    progressPulseTimer = null;
  }
}

function startProgressPulse() {
  stopProgressPulse();
  progressValue = 6;
  setLoadingProgress(6, t('main.space3d.loading'));
  progressPulseTimer = setInterval(() => {
    if (progressValue >= 88) return;
    progressValue += (88 - progressValue) * 0.045 + 0.35;
    setLoadingProgress(progressValue, t('main.space3d.loading'));
  }, 120);
}

/**
 * Ramp to 100% over ~2s (covers lingering Powered-by), then hide cover.
 * @returns {Promise<void>}
 */
function finishProgressThenHide() {
  stopProgressPulse();
  return new Promise((resolve) => {
    const start = performance.now();
    const from = Math.max(progressValue, 88);
    const duration = 3000;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) * (1 - t);
      setLoadingProgress(from + (100 - from) * eased, t < 0.95 ? 'Preparing map…' : 'Ready');
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }
      setTimeout(() => {
        setLoadingCover(false);
        resolve();
      }, 180);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * @param {boolean} show
 */
function setLoadingCover(show) {
  if (!loadingCover || !loadingCover.isConnected) {
    loadingCover = hostEl?.querySelector('#matterport-loading-cover') || null;
  }
  if (!loadingCover) return;
  if (show) {
    loadingCover.classList.remove('is-hidden');
    loadingCover.setAttribute('aria-hidden', 'false');
    document.body.classList.add('matterport-loading');
    startProgressPulse();
  } else {
    stopProgressPulse();
    loadingCover.classList.add('is-hidden');
    loadingCover.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('matterport-loading');
  }
}

/**
 * Wait until Showcase is interactive so we can start the final progress hold.
 * @param {any} sdk
 * @param {number} [timeoutMs]
 */
function waitUntilPlaying(sdk, timeoutMs = 18000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const playing = sdk?.App?.Phase?.PLAYING || 'appphase.playing';

    const onPlaying = () => {
      clearTimeout(timer);
      finish();
    };

    try {
      const maybeState = sdk?.App?.state;
      if (maybeState?.getSnapshot) {
        const snap = maybeState.getSnapshot();
        if (snap?.phase === playing) {
          onPlaying();
          return;
        }
      }
      const sub = sdk.App.state.subscribe((state) => {
        if (state?.phase !== playing) return;
        try {
          if (typeof sub === 'function') sub();
          else sub?.cancel?.();
        } catch {
          /* */
        }
        onPlaying();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export function ensureMatterportHost(viewportBody) {
  if (
    hostEl?.isConnected &&
    placeBar?.isConnected &&
    clickCatcher?.isConnected &&
    loadingCover?.isConnected &&
    placeCursor?.isConnected
  ) {
    hostEl.querySelectorAll('.matterport-brand-shield, .matterport-logo-mask').forEach((el) => el.remove());
    if (!loadingCover.querySelector('.matterport-loading-panel')) {
      loadingCover.innerHTML = `
        <div class="matterport-loading-panel float-glass">
          <div class="matterport-loading-row">
            <span class="matterport-loading-label">${t('main.space3d.loading')}</span>
            <span class="matterport-loading-pct">0%</span>
          </div>
          <div class="matterport-loading-track" aria-hidden="true">
            <div class="matterport-loading-fill" style="width:0%"></div>
          </div>
        </div>
      `;
    }
    mediaOverlayEl = hostEl.querySelector('#matterport-media-overlay');
    hostEl.querySelector('#matterport-poi-hover-tip')?.remove();
    wirePoiDetailDrawer(hostEl);
    iframeEl = hostEl.querySelector('#matterport-map-iframe');
    if (!hostEl.querySelector('#matterport-scene-overlay')) {
      const canvas = document.createElement('canvas');
      canvas.id = 'matterport-scene-overlay';
      canvas.className = 'matterport-scene-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      if (iframeEl) iframeEl.after(canvas);
      else hostEl.appendChild(canvas);
    }
    if (!hostEl.querySelector('#matterport-heat-overlay')) {
      const heat = document.createElement('canvas');
      heat.id = 'matterport-heat-overlay';
      heat.className = 'matterport-heat-overlay';
      heat.setAttribute('aria-hidden', 'true');
      const sceneOverlay = hostEl.querySelector('#matterport-scene-overlay');
      if (sceneOverlay) sceneOverlay.after(heat);
      else if (iframeEl) iframeEl.after(heat);
      else hostEl.appendChild(heat);
    }
    heatCanvas = hostEl.querySelector('#matterport-heat-overlay');
    ensureMoveCloseButton();
    return hostEl;
  }
  // Rebuild if an older host without dashboard-styled place chrome exists.
  if (hostEl?.isConnected) hostEl.remove();
  if (placeBar?.isConnected) placeBar.remove();
  hostEl = document.createElement('div');
  hostEl.id = 'matterport-map-host';
  hostEl.className = 'matterport-map-host hidden';
  hostEl.innerHTML = `
    <iframe
      id="matterport-map-iframe"
      title="3D space map"
      allow="xr-spatial-tracking; fullscreen; autoplay; clipboard-write"
      referrerpolicy="strict-origin-when-cross-origin"
    ></iframe>
    <canvas id="matterport-scene-overlay" class="matterport-scene-overlay" aria-hidden="true"></canvas>
    <canvas id="matterport-heat-overlay" class="matterport-heat-overlay" aria-hidden="true"></canvas>
    <div
      id="matterport-click-catcher"
      class="matterport-click-catcher hidden"
      aria-hidden="true"
      title="Click a spot to place"
    ></div>
    <div id="matterport-place-cursor" class="matterport-place-cursor" aria-hidden="true">
      <span class="matterport-place-cursor-axes" aria-hidden="true">
        <span class="axis-x"></span>
        <span class="axis-y"></span>
        <span class="axis-z"></span>
      </span>
      <span class="matterport-place-cursor-icon">${iconPlacePoi()}</span>
    </div>
    <button
      type="button"
      id="matterport-place-cancel"
      class="matterport-place-cancel hidden"
      title="Cancel"
      aria-label="Cancel placement"
      aria-hidden="true"
    >${iconClose()}</button>
    <div class="matterport-loading-cover" id="matterport-loading-cover" aria-hidden="false">
      <div class="matterport-loading-panel float-glass">
        <div class="matterport-loading-row">
          <span class="matterport-loading-label">${t('main.space3d.loading')}</span>
          <span class="matterport-loading-pct">0%</span>
        </div>
        <div class="matterport-loading-track" aria-hidden="true">
          <div class="matterport-loading-fill" style="width:0%"></div>
        </div>
      </div>
    </div>
    <div id="matterport-poi-detail" class="matterport-poi-detail hidden" aria-hidden="true">
      <div class="matterport-poi-detail-card" role="dialog" aria-modal="false" aria-labelledby="matterport-poi-detail-title">
        <div class="matterport-poi-detail-head">
          <button type="button" class="matterport-poi-detail-close" id="matterport-poi-detail-close" aria-label="Close">${iconClose()}</button>
          <div class="matterport-poi-detail-head-text">
            <span class="matterport-poi-detail-kicker">POI</span>
            <h3 class="matterport-poi-detail-title" id="matterport-poi-detail-title"></h3>
          </div>
        </div>
        <div class="matterport-poi-detail-body" id="matterport-poi-detail-body"></div>
      </div>
    </div>
    <div id="matterport-media-overlay" class="matterport-media-overlay hidden" aria-hidden="true">
      <div class="matterport-media-overlay-card float-glass">
        <div class="matterport-media-overlay-head">
          <span class="matterport-media-overlay-title" id="matterport-media-overlay-title">Media</span>
          <button type="button" class="matterport-media-overlay-close" id="matterport-media-overlay-close" aria-label="Close media preview">×</button>
        </div>
        <div class="matterport-media-overlay-body" id="matterport-media-overlay-body"></div>
        <div class="matterport-media-overlay-tools" id="matterport-media-overlay-tools">
          <div class="matterport-media-mode-row" role="group" aria-label="Transform mode">
            <button type="button" class="matterport-media-mode-btn active" data-mp-media-mode="translate">Move</button>
            <button type="button" class="matterport-media-mode-btn" data-mp-media-mode="rotate">Rotate</button>
            <button type="button" class="matterport-media-mode-btn" data-mp-media-mode="scale">Scale</button>
          </div>
          <div class="matterport-media-fields" data-mp-fields="translate">
            <label>X <input type="number" step="any" data-mp-field="pos_x" /></label>
            <label>Y <input type="number" step="any" data-mp-field="pos_y" /></label>
            <label>Z <input type="number" step="any" data-mp-field="pos_z" /></label>
          </div>
          <div class="matterport-media-fields hidden" data-mp-fields="rotate">
            <label>Rx° <input type="number" step="1" data-mp-field="rot_x_deg" /></label>
            <label>Ry° <input type="number" step="1" data-mp-field="rot_y_deg" /></label>
            <label>Rz° <input type="number" step="1" data-mp-field="rot_z_deg" /></label>
          </div>
          <div class="matterport-media-fields hidden" data-mp-fields="scale">
            <label class="mp-plane-only">W <input type="number" step="0.1" min="0.1" data-mp-field="width" /></label>
            <label class="mp-plane-only">H <input type="number" step="0.1" min="0.1" data-mp-field="height" /></label>
            <label class="mp-model-only hidden">Sx <input type="number" step="0.01" min="0.01" data-mp-field="scale_x" /></label>
            <label class="mp-model-only hidden">Sy <input type="number" step="0.01" min="0.01" data-mp-field="scale_y" /></label>
            <label class="mp-model-only hidden">Sz <input type="number" step="0.01" min="0.01" data-mp-field="scale_z" /></label>
          </div>
        </div>
        <p class="matterport-media-overlay-hint" id="matterport-media-overlay-hint"></p>
      </div>
    </div>
  `;

  // Hint chrome only — placement is click-on-surface (no confirm button).
  placeBar = document.createElement('div');
  placeBar.id = 'matterport-place-bar';
  placeBar.className = 'matterport-place-bar float-glass chrome-layer hidden';
  placeBar.innerHTML = `
    <div class="matterport-place-copy">
      <span class="matterport-place-icon" id="matterport-place-icon" aria-hidden="true">${iconPlacePoi()}</span>
      <div class="matterport-place-text">
        <span class="matterport-place-title" id="matterport-place-hint">Add POI</span>
        <code class="matterport-place-xyz" id="matterport-place-xyz">Click a spot on the map</code>
      </div>
    </div>
    <button type="button" class="matterport-move-arm" id="matterport-move-arm" hidden aria-pressed="false">
      Done moving
    </button>
    <button
      type="button"
      class="matterport-move-close"
      id="matterport-move-close"
      title="Close and return to walkthrough"
      aria-label="Close move bar"
      hidden
    >${iconClose()}</button>
  `;

  viewportBody.appendChild(hostEl);
  viewportBody.appendChild(placeBar);
  mediaOverlayEl = hostEl.querySelector('#matterport-media-overlay');
  hostEl.querySelector('#matterport-poi-hover-tip')?.remove();
  wirePoiDetailDrawer(hostEl);
  mediaOverlayEl?.querySelector('#matterport-media-overlay-close')?.addEventListener('click', () => {
    // Hide AR tools only — keep media selected in the sidebar for continued edits.
    setMatterportMediaPreview(null);
  });
  // Clicks inside the AR editor must not fall through / dismiss selection.
  mediaOverlayEl?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  mediaOverlayEl?.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  wireMediaOverlayTools(mediaOverlayEl);
  placeBar.querySelector('#matterport-move-arm')?.addEventListener('click', () => {
    if (!isMoveMode()) return;
    void setMoveCaptureArmed(!moveCaptureArmed);
  });
  placeBar.querySelector('#matterport-move-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void dismissMatterportMoveBar();
  });
  iframeEl = hostEl.querySelector('#matterport-map-iframe');
  clickCatcher = hostEl.querySelector('#matterport-click-catcher');
  placeCursor = hostEl.querySelector('#matterport-place-cursor');
  placeCancelBtn = hostEl.querySelector('#matterport-place-cancel');
  loadingCover = hostEl.querySelector('#matterport-loading-cover');
  placeCancelBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelTagPlacement();
  });
  clickCatcher?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerDownAt = { x: e.clientX, y: e.clientY };
    if (isMoveMode() && moveCaptureArmed) {
      moveDragging = true;
      try {
        clickCatcher.setPointerCapture?.(e.pointerId);
      } catch {
        /* */
      }
      void applyMoveAtEvent(e, 'move');
      return;
    }
    if (isPlaceMode()) {
      placePointerActive = true;
      void updateHoverPoint(e);
    }
  });
  clickCatcher?.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (isMoveMode() && moveCaptureArmed && moveDragging) {
      void applyMoveAtEvent(e, 'end');
      moveDragging = false;
      pointerDownAt = null;
      try {
        clickCatcher.releasePointerCapture?.(e.pointerId);
      } catch {
        /* */
      }
      return;
    }
    if (isPlaceMode() && placePointerActive) {
      placePointerActive = false;
      void onCatcherClick(e);
      pointerDownAt = null;
      return;
    }
    void onCatcherClick(e);
    pointerDownAt = null;
    moveDragging = false;
    placePointerActive = false;
  });
  clickCatcher?.addEventListener('pointermove', (e) => {
    if (!catcherCapturing()) return;
    movePlaceCursor(e.clientX, e.clientY);
    pendingHoverEvent = e;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const ev = pendingHoverEvent;
      pendingHoverEvent = null;
      if (!ev || !catcherCapturing()) return;
      // Move: the pin is dropped where the pointer was released and stays there.
      // Only an active drag relocates it — free hover moves the cursor alone.
      if (isMoveMode() && moveCaptureArmed) {
        if (moveDragging) void applyMoveAtEvent(ev, 'move');
        return;
      }
      // Add: the pin tracks the pointer so the user aims before clicking.
      if (isPlaceMode()) void updateHoverPoint(ev);
    });
  });
  clickCatcher?.addEventListener('pointercancel', (e) => {
    moveDragging = false;
    placePointerActive = false;
    pointerDownAt = null;
    try {
      clickCatcher.releasePointerCapture?.(e.pointerId);
    } catch {
      /* */
    }
  });
  clickCatcher?.addEventListener('pointerleave', () => {
    if (!moveDragging) placeCursor?.classList.remove('is-visible');
    pendingHoverEvent = null;
    if (isPlaceMode()) {
      placePointerActive = false;
      clearPlaceGizmo();
    }
  });
  clickCatcher?.addEventListener('pointerenter', () => {
    if (catcherCapturing()) syncPlaceCursor();
  });
  window.addEventListener('keydown', onKeyDown);
  return hostEl;
}

function onKeyDown(e) {
  if (!active) return;
  if (e.key === 'Escape' && isTagPlaceMode()) {
    e.preventDefault();
    cancelTagPlacement();
    return;
  }
  if (e.key === 'Escape' && isMoveMode() && moveCaptureArmed) {
    e.preventDefault();
    void setMoveCaptureArmed(false);
    return;
  }
  if (e.key !== 'Enter') return;
  if (!livePoint || !onPlace || !isPlaceMode()) return;
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  e.preventDefault();
  onPlace({ ...livePoint, normal: { ...liveNormal } }, activeMode);
}

function setPlaceHint() {
  if (!placeBar) return;
  const hint = placeBar.querySelector('#matterport-place-hint');
  const xyz = placeBar.querySelector('#matterport-place-xyz');
  const iconSlot = placeBar.querySelector('#matterport-place-icon');
  if (!hint || !xyz) return;

  // Move mode owns the copy — don't overwrite with the generic "Place" fallback.
  if (isMoveMode()) {
    hint.textContent =
      moveTarget?.kind === 'media' ? 'Move media' : 'Move POI';
    if (iconSlot) {
      iconSlot.innerHTML = moveTarget?.kind === 'media' ? iconPlaceMedia() : iconPlacePoi();
    }
    if (!moveDragging) {
      xyz.textContent = moveCaptureArmed
        ? livePoint
          ? `X ${livePoint.x.toFixed(3)}   Y ${livePoint.y.toFixed(3)}   Z ${livePoint.z.toFixed(3)}`
          : 'Drag the pin on the map to reposition'
        : 'Click Move POI to reposition';
    }
    placeBar.classList.add('is-move');
    placeBar.classList.remove('is-place');
    return;
  }

  placeBar.classList.remove('is-move');
  placeBar.classList.toggle('is-place', isPlaceMode());

  const configs = {
    'add-poi': {
      title: 'Add POI',
      icon: iconPlacePoi(),
      idle: 'Click a spot on the map',
    },
    'add-facility': {
      title: 'Add amenity',
      icon: iconPlaceFacility(),
      idle: 'Click a spot on the map',
    },
    'add-media': {
      title: 'Add media',
      icon: iconPlaceMedia(),
      idle: 'Click a spot on the map',
    },
    walk: {
      title: 'Go to',
      icon: iconFootprint(),
      idle: 'Click a spot to go there',
    },
  };
  const cfg = configs[activeMode];
  if (!cfg) return;

  hint.textContent = cfg.title;
  if (iconSlot) iconSlot.innerHTML = cfg.icon;
  xyz.textContent = livePoint
    ? `X ${livePoint.x.toFixed(3)}   Y ${livePoint.y.toFixed(3)}   Z ${livePoint.z.toFixed(3)}`
    : cfg.idle;
}

export function isMatterportMapActive() {
  return active;
}

/**
 * Follow Showcase walkthrough with the geometric-mesh camera (same XYZ).
 * @param {((pose: Record<string, unknown>) => void) | null} fn
 */
export function onMatterportCameraPose(fn) {
  onCameraPose = typeof fn === 'function' ? fn : null;
}

/** Latest Showcase camera pose (for heat-map floor Y on the URL space). */
export function getMatterportCameraPose() {
  return lastCameraPose;
}

/** True when the Showcase host is covering the viewport (even if SDK connect failed). */
export function isMatterportHostVisible() {
  if (active) return true;
  if (!hostEl || hostEl.classList.contains('hidden')) return false;
  return document.body.classList.contains('matterport-map-active');
}

/** Use Showcase camera for fly-to — never the mesh orbit camera. */
export function shouldUseMatterportCamera() {
  return isMatterportMapActive() || isMatterportHostVisible();
}

export function setMatterportPlaceHandler(fn) {
  onPlace = typeof fn === 'function' ? fn : null;
}

/**
 * @param {string} mode
 */
export function setMatterportToolMode(mode) {
  activeMode = String(mode || 'default');
  placePointerActive = false;
  if (isPlaceMode(activeMode)) {
    if (moveTarget) void setMoveEntityTagHidden(false);
    moveTarget = null;
    moveDragging = false;
    moveCaptureArmed = false;
  }
  // Move POI bar while editing; Add POI uses pin + cancel X only.
  const showBar = active && (isMoveMode() || activeMode === 'walk');
  placeBar?.classList.toggle('hidden', !showBar);
  syncClickCatcher();
  setPlaceHint();
  syncPlaceCursor();
  syncPlaceCancelBtn();
  // Place mode: no green pin until the user presses (click).
  // Move mode: never clear an armed move pin from tool-mode sync.
  if (isMoveMode() && moveCaptureArmed) {
    void ensurePlaceGizmo();
  } else if (!moveCaptureArmed) {
    clearPlaceGizmo();
  }
}

async function connectSdk() {
  if (!iframeEl) throw new Error('3D space iframe missing');
  const key = getMatterportSdkKey();
  if (!key) {
    throw new Error('VITE_MATTERPORT_SDK_KEY missing — required for 3D space map tools');
  }
  if (!iframeEl.src.includes('applicationKey=')) {
    throw new Error('Space map URL missing applicationKey');
  }
  const connectGen = matterportLoadGeneration;
  await loadSdkBootstrap();
  if (connectGen !== matterportLoadGeneration) {
    throw new Error('Space map load aborted');
  }
  if (!window.MP_SDK?.connect) throw new Error('Space SDK unavailable');
  const sdk = await window.MP_SDK.connect(iframeEl);
  if (connectGen !== matterportLoadGeneration) {
    throw new Error('Space map load aborted');
  }
  mpSdk = sdk;
  if (stopWatch) stopWatch();
  const unsubs = [];
  try {
    const sub = mpSdk.Pointer.intersection.subscribe((hit) => {
      const pos = hit?.position;
      if (!pos || !Number.isFinite(Number(pos.x))) return;
      livePoint = { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };
      const n = hit?.normal;
      if (n && Number.isFinite(Number(n.x))) {
        liveNormal = faceNormalTowardCamera(livePoint, vec3(n.x, n.y, n.z));
      }
      setPlaceHint();
      syncPlaceGizmoPosition(livePoint, liveNormal);
    });
    if (typeof sub === 'function') unsubs.push(sub);
    else if (sub?.cancel) unsubs.push(() => sub.cancel());
  } catch (err) {
    console.warn('[space-map] pointer watch failed', err);
  }

  try {
    const poseSub = mpSdk.Camera?.pose?.subscribe?.((pose) => {
      if (pose) lastCameraPose = pose;
      if (typeof onCameraPose === 'function' && pose) onCameraPose(pose);
      applyShowcasePoseToOverlay(pose);
      if (heatWorldPoints.length || navWorldPoints.length) scheduleAnnotDraw({ moving: true });
    });
    if (typeof poseSub === 'function') unsubs.push(poseSub);
    else if (poseSub?.cancel) unsubs.push(() => poseSub.cancel());
  } catch (err) {
    console.warn('[space-map] camera pose watch failed', err);
  }

  // Best-effort: hide leftover Showcase chrome if the SDK exposes it.
  tryHideShowcaseBrand(mpSdk);
  watchMatterportViews(mpSdk, unsubs);
  silenceAllShowcaseTags(mpSdk, unsubs);
  watchPoiPinClicks(mpSdk, unsubs);

  stopWatch = () => unsubs.forEach((fn) => { try { fn(); } catch { /* */ } });
  return mpSdk;
}

/**
 * Instant POI pin click → Edit (don't wait for openTags selected/docked lag).
 * @param {any} sdk
 * @param {Array<() => void>} unsubs
 */
function watchPoiPinClicks(sdk, unsubs) {
  if (!sdk) return;
  const Event = sdk.Mattertag?.Event;
  const clickEvent = Event?.CLICK || 'tag.click';
  const onClick = (sid) => {
    const tagId = asTagId(sid);
    if (!tagId) return;
    if (!poiHoverTagIds.has(tagId) && !mediaTagIds.has(tagId)) return;
    notifyTagActivated(tagId);
  };
  try {
    if (typeof sdk.Mattertag?.on === 'function') {
      sdk.Mattertag.on(clickEvent, onClick);
      unsubs.push(() => {
        try {
          sdk.Mattertag?.off?.(clickEvent, onClick);
        } catch {
          /* */
        }
      });
    }
  } catch (err) {
    console.warn('[space-map] POI pin click watch failed', err);
  }
}

/**
 * Hide Matterport space-authored tags for this Showcase session (pins + billboards).
 * NavMe POI / amenity / media pins are kept. Tag.remove is session-only (not saved to the space).
 * @param {any} sdk
 * @param {Array<() => void>} unsubs
 */
function silenceAllShowcaseTags(sdk, unsubs) {
  if (!sdk) return;

  const hideSpaceTag = (id) => {
    const tagId = asTagId(id);
    if (!tagId || isNavMeManagedTag(tagId)) return;
    // Never delete while place/move preview is active — Tag.data races Tag.add and
    // was removing the move pin before managedShowcaseTagIds could register it.
    if (usesPlaceGizmo() || placePreviewEditInFlight || placePreviewPending || placePreviewTagId) {
      return;
    }
    setTimeout(() => {
      if (isNavMeManagedTag(tagId)) return;
      if (tagId === placePreviewTagId) return;
      if (usesPlaceGizmo() || placePreviewEditInFlight || placePreviewPending) return;
      void removeSpaceAuthoredTag(sdk, tagId);
    }, 120);
  };

  const sweepCollection = (collection) => {
    try {
      const values =
        typeof collection?.values === 'function'
          ? [...collection.values()]
          : Array.isArray(collection)
            ? collection
            : collection && typeof collection === 'object'
              ? Object.values(collection)
              : [];
      for (const item of values) {
        hideSpaceTag(asTagId(item) || asTagId(item?.id) || asTagId(item?.sid) || asTagId(item?.tagId));
      }
    } catch {
      /* */
    }
  };

  try {
    // Docking must stay on so Showcase “View more” fires — we swap to our drawer instantly.
    sdk.Tag?.toggleDocking?.(true);
  } catch {
    /* */
  }
  try {
    sdk.Tag?.toggleSharing?.(false);
  } catch {
    /* */
  }

  try {
    // Tag.data observers receive (index, item, collection) — id is on item.
    const sub = sdk.Tag?.data?.subscribe?.({
      onAdded(index, item) {
        hideSpaceTag(asTagId(item) || asTagId(index));
      },
      onCollectionUpdated(collection) {
        sweepCollection(collection);
      },
    });
    if (typeof sub === 'function') unsubs.push(sub);
    else if (sub?.cancel) unsubs.push(() => sub.cancel());
  } catch (err) {
    console.warn('[space-map] tag hide subscribe failed', err);
  }

  // Replace laggy Showcase POI dock with our detail drawer; silence other tags.
  try {
    const sub = sdk.Tag?.openTags?.subscribe?.({
      onChanged(state) {
        handlePoiOpenTagsChange(sdk, state);
      },
    });
    if (typeof sub === 'function') unsubs.push(sub);
    else if (sub?.cancel) unsubs.push(() => sub.cancel());
  } catch {
    /* */
  }
}

/**
 * Session-only remove of a Matterport-authored tag (pin disappears in this iframe).
 * @param {any} sdk
 * @param {string} tagId
 */
async function removeSpaceAuthoredTag(sdk, tagId) {
  if (!sdk || !tagId || isNavMeManagedTag(tagId)) return;
  try {
    if (sdk.Tag?.remove) {
      await sdk.Tag.remove(tagId);
      return;
    }
  } catch {
    /* */
  }
  try {
    if (sdk.Mattertag?.remove) {
      await sdk.Mattertag.remove(tagId);
      return;
    }
  } catch {
    /* */
  }
  // Fallback if remove is unavailable: hide billboard + make pin invisible.
  await silenceTagBillboard(sdk, tagId);
  try {
    await sdk.Tag?.editOpacity?.(tagId, 0);
  } catch {
    /* */
  }
  try {
    await sdk.Mattertag?.editOpacity?.(tagId, 0);
  } catch {
    /* */
  }
}

/**
 * Track BASE / DEFURNISH views for the Hide furniture toggle.
 * @param {any} sdk
 * @param {Array<() => void>} unsubs
 */
function watchMatterportViews(sdk, unsubs) {
  baseView = null;
  defurnishView = null;
  defurnishAvailable = false;
  const ViewType = sdk?.View?.ViewType || {};
  const noteView = (view) => {
    if (!view) return;
    const type = view.type;
    if (type === ViewType.DEFURNISH || type === 'viewtype.defurnish') {
      defurnishView = view;
      defurnishAvailable = true;
    } else if (
      type === ViewType.BASE ||
      type === ViewType.LAYERED_BASE ||
      type === 'viewtype.base' ||
      type === 'viewtype.layeredbase'
    ) {
      if (!baseView || view.active) baseView = view;
    }
    emitDefurnishState();
  };

  try {
    const sub = sdk.View?.views?.subscribe?.({
      onAdded(_id, view) {
        noteView(view);
      },
      onCollectionUpdated(collection) {
        try {
          const values =
            typeof collection?.values === 'function'
              ? [...collection.values()]
              : Array.isArray(collection)
                ? collection
                : [];
          for (const view of values) noteView(view);
        } catch {
          /* */
        }
      },
    });
    if (typeof sub === 'function') unsubs.push(sub);
    else if (sub?.cancel) unsubs.push(() => sub.cancel());
  } catch (err) {
    console.warn('[space-map] view watch failed', err);
  }

  try {
    const featKey = sdk.App?.Feature?.Defurnish || 'feature.defurnish';
    const featSub = sdk.App?.features?.subscribe?.({
      onChanged(features) {
        if (features?.[featKey]) defurnishAvailable = true;
        emitDefurnishState();
      },
    });
    if (typeof featSub === 'function') unsubs.push(featSub);
    else if (featSub?.cancel) unsubs.push(() => featSub.cancel());
  } catch {
    /* */
  }

  try {
    const curSub = sdk.View?.current?.subscribe?.(() => {
      emitDefurnishState();
    });
    if (typeof curSub === 'function') unsubs.push(curSub);
    else if (curSub?.cancel) unsubs.push(() => curSub.cancel());
  } catch {
    /* */
  }
}

function emitDefurnishState() {
  if (typeof onDefurnishState !== 'function') return;
  const ViewType = mpSdk?.View?.ViewType || {};
  let isDefurnish = false;
  try {
    const cur = mpSdk?.View?.current;
    const snap = typeof cur?.getSnapshot === 'function' ? cur.getSnapshot() : cur;
    const type = snap?.type ?? snap?.value?.type;
    isDefurnish = type === ViewType.DEFURNISH || type === 'viewtype.defurnish' || Boolean(defurnishView?.active);
  } catch {
    isDefurnish = Boolean(defurnishView?.active);
  }
  onDefurnishState(Boolean(defurnishAvailable && defurnishView), isDefurnish);
}

/**
 * @param {(available: boolean, active: boolean) => void | null} fn
 */
export function onMatterportDefurnishChange(fn) {
  onDefurnishState = typeof fn === 'function' ? fn : null;
  if (onDefurnishState) emitDefurnishState();
}

/**
 * Toggle Hide furniture (defurnish view) when the space supports it.
 * @returns {Promise<{ ok: boolean, active?: boolean, error?: string }>}
 */
export async function matterportToggleDefurnish() {
  if (!mpSdk || !active) return { ok: false, error: '3D space map not ready' };
  if (!defurnishView) {
    return {
      ok: false,
      error: 'Hide furniture is not available for this space',
    };
  }
  try {
    const ViewType = mpSdk.View?.ViewType || {};
    const cur = mpSdk.View?.current;
    const snap = typeof cur?.getSnapshot === 'function' ? cur.getSnapshot() : null;
    const curType = snap?.type ?? defurnishView?.active;
    const isDefurnish =
      curType === ViewType.DEFURNISH ||
      curType === 'viewtype.defurnish' ||
      curType === true;

    if (isDefurnish) {
      if (baseView?.setActive) await baseView.setActive(false);
      else return { ok: false, error: 'Furnished view unavailable' };
      emitDefurnishState();
      return { ok: true, active: false };
    }

    await defurnishView.setActive(false);
    emitDefurnishState();
    return { ok: true, active: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * @param {any} sdk
 */
function tryHideShowcaseBrand(sdk) {
  // Do not call App.hideUI / toggleUI — that removes side + bottom controls.
  // Only attempt brand/header toggles when the SDK exposes them.
  try {
    const hideKeys = ['logo', 'brand', 'title', 'about', 'poweredBy', 'header'];
    for (const key of hideKeys) {
      sdk?.App?.toggleComponent?.(key, false);
      sdk?.Settings?.set?.(key, false);
    }
  } catch {
    /* brand chrome may require a white-label / MLS plan */
  }
}

/**
 * @param {string} urlOrId
 * @param {{ onStatus?: (msg: string, kind?: string) => void }} [opts]
 */
export async function loadMatterportMap(urlOrId, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const id = parseMatterportModelId(urlOrId);
  if (!id) return { ok: false, error: 'Invalid 3D space URL or model ID' };
  if (!hostEl) return { ok: false, error: '3D space host not mounted' };

  const src = matterportShowcaseUrl(id, {
    play: true,
    useSdkKey: true,
    // Wayfinding hides the Showcase controls; the editor keeps them.
    minimalChrome: opts.minimalChrome === true,
  });
  if (!src) return { ok: false, error: 'Could not build space map URL' };

  const loadGen = ++matterportLoadGeneration;
  const stillCurrent = () => loadGen === matterportLoadGeneration;

  active = true;
  hostEl.classList.remove('hidden');
  document.body.classList.add('matterport-map-active');
  setLoadingCover(true);

  await new Promise((resolve) => {
    if (!stillCurrent()) {
      resolve();
      return;
    }
    const onLoad = () => {
      iframeEl?.removeEventListener('load', onLoad);
      resolve();
    };
    iframeEl?.addEventListener('load', onLoad);
    iframeEl.src = src;
  });

  if (!stillCurrent()) {
    return { ok: false, aborted: true };
  }

  try {
    const sdk = await connectSdk();
    if (!stillCurrent()) {
      try {
        // Drop a late connect so it can't overwrite a newer map mode.
        if (mpSdk === sdk) mpSdk = null;
      } catch {
        /* */
      }
      return { ok: false, aborted: true };
    }
    setLoadingProgress(Math.max(progressValue, 90), 'Almost ready…');
    await waitUntilPlaying(sdk);
    if (!stillCurrent()) {
      return { ok: false, aborted: true };
    }
    await finishProgressThenHide();
    if (!stillCurrent()) {
      return { ok: false, aborted: true };
    }
    syncClickCatcher();
    onStatus('3D space ready — click the map to add POI / amenity / media', 'success');
    return { ok: true, modelId: id };
  } catch (err) {
    if (!stillCurrent()) {
      return { ok: false, aborted: true };
    }
    setLoadingCover(false);
    const msg = String(err?.message || err);
    const origin = typeof location !== 'undefined' ? location.origin : '';
    const friendly = /Key\/referrer mismatch|KeyReferrerMismatch/i.test(msg)
      ? `Space map SDK key not allowed for ${origin}. In the space map developer settings, add this exact origin on the same SDK key used in the build: ${origin}`
      : /VITE_MATTERPORT_SDK_KEY missing|URL missing applicationKey/i.test(msg)
        ? `Space map SDK key missing from this deploy. Set VITE_MATTERPORT_SDK_KEY on the host and rebuild (Vite bakes it in at build time).`
        : msg.replace(/Matterport/gi, 'Space').replace(/MultiSet/gi, 'map service').replace(/Supabase/gi, 'database');
    onStatus(friendly, 'error');
    return { ok: false, error: friendly, browsingOnly: true };
  }
}

export function clearMatterportMap() {
  // Invalidate any in-flight Showcase load (geometric mesh / splat switch).
  matterportLoadGeneration += 1;
  goToGeneration += 1;
  cachedSweepCollection = null;
  active = false;
  setLoadingCover(false);
  document.body.classList.remove('matterport-map-active');
  document.body.classList.remove('matterport-loading');
  hostEl?.classList.add('hidden');
  placeBar?.classList.add('hidden');
  clickCatcher?.classList.add('hidden');
  placeCursor?.classList.remove('is-visible');
  if (hoverRayTimer) {
    clearTimeout(hoverRayTimer);
    hoverRayTimer = null;
  }
  if (stopWatch) {
    stopWatch();
    stopWatch = null;
  }
  teardownMpOverlays();
  onCameraPose = null;
  lastCameraPose = null;
  currentViewMode = null;
  mpSdk = null;
  livePoint = null;
  placeInFlight = false;
  pointerDownAt = null;
  moveTarget = null;
  moveDragging = false;
  onMoveEntity = null;
  baseView = null;
  defurnishView = null;
  defurnishAvailable = false;
  onDefurnishState = null;
  tagByEntityKey.clear();
  mediaTagIds.clear();
  poiHoverTagIds.clear();
  managedShowcaseTagIds.clear();
  poiMetaByTagId.clear();
  lastActivatedPoiTagId = null;
  hidePoiDetailDrawer();
  hoverOpenedTagId = null;
  selectedLabelTagId = null;
  mediaAttachmentByKey.clear();
  setMatterportMediaPreview(null);
  if (iframeEl) {
    iframeEl.removeAttribute('src');
  }
  activeMode = 'default';
  placeCancelBtn = null;
  liveNormal = { x: 0, y: 1, z: 0 };
  placePreviewTagId = null;
}

/**
 * True when this Showcase tag was created/owned by NavMe (not Matterport space authoring).
 * @param {string | null | undefined} tagId
 */
function isNavMeManagedTag(tagId) {
  if (!tagId) return false;
  if (managedShowcaseTagIds.has(tagId)) return true;
  if (mediaTagIds.has(tagId) || poiHoverTagIds.has(tagId)) return true;
  if (selectedLabelTagId != null && tagId === selectedLabelTagId) return true;
  if (heatTrailTagIds.includes(tagId)) return true;
  for (const id of tagByEntityKey.values()) {
    if (id === tagId) return true;
  }
  return false;
}

/**
 * @param {any} sdk
 * @param {string | null | undefined} tagId
 */
function isBillboardAllowed(tagId) {
  return (
    mediaTagIds.has(tagId) ||
    poiHoverTagIds.has(tagId) ||
    (selectedLabelTagId != null && tagId === selectedLabelTagId)
  );
}

/**
 * @param {HTMLElement | null} root
 */
function wirePoiDetailDrawer(root) {
  if (!root) return;
  let el = root.querySelector('#matterport-poi-detail');
  if (!el) {
    el = document.createElement('div');
    el.id = 'matterport-poi-detail';
    el.className = 'matterport-poi-detail hidden';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="matterport-poi-detail-card" role="dialog" aria-modal="false" aria-labelledby="matterport-poi-detail-title">
        <div class="matterport-poi-detail-head">
          <button type="button" class="matterport-poi-detail-close" id="matterport-poi-detail-close" aria-label="Close">${iconClose()}</button>
          <div class="matterport-poi-detail-head-text">
            <span class="matterport-poi-detail-kicker">POI</span>
            <h3 class="matterport-poi-detail-title" id="matterport-poi-detail-title"></h3>
          </div>
        </div>
        <div class="matterport-poi-detail-body" id="matterport-poi-detail-body"></div>
      </div>
    `;
    const mediaOverlay = root.querySelector('#matterport-media-overlay');
    if (mediaOverlay) mediaOverlay.before(el);
    else root.appendChild(el);
  }
  poiDetailEl = el;
  // Remove legacy Edit POI button if an older drawer is still in the DOM.
  el.querySelector('.matterport-poi-detail-actions')?.remove();
  const closeBtn = el.querySelector('#matterport-poi-detail-close');
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePoiDetailDrawer();
    });
  }
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => e.stopPropagation());
}

function hidePoiDetailDrawer() {
  if (!poiDetailEl) {
    poiDetailEl = hostEl?.querySelector('#matterport-poi-detail') || null;
  }
  poiDetailTagId = null;
  if (!poiDetailEl) return;
  poiDetailEl.classList.add('hidden');
  poiDetailEl.setAttribute('aria-hidden', 'true');
}

/**
 * Open Edit in the dashboard for a Showcase POI or media pin.
 * @param {string} tagId
 */
function notifyTagActivated(tagId) {
  if (!tagId || !onPoiPinActivated) return;
  if (lastActivatedPoiTagId === tagId) return;

  let kind = null;
  let entityId = '';
  let label = '';

  if (poiHoverTagIds.has(tagId)) {
    kind = 'poi';
    const meta = poiMetaByTagId.get(tagId);
    entityId = meta?.poiId ? String(meta.poiId) : '';
    label = String(meta?.label || 'POI');
    if (!entityId) {
      for (const [key, id] of tagByEntityKey.entries()) {
        if (id !== tagId) continue;
        if (key.startsWith('poi-expected:')) {
          entityId = key.slice('poi-expected:'.length);
          break;
        }
        if (key.startsWith('poi:')) {
          entityId = key.slice(4);
          break;
        }
      }
    }
  } else if (mediaTagIds.has(tagId)) {
    kind = 'media';
    for (const [key, id] of tagByEntityKey.entries()) {
      if (id === tagId && key.startsWith('media:')) {
        entityId = key.slice(6);
        break;
      }
    }
    label = 'Media';
  }

  if (!kind || !entityId || entityId === '__pending__') return;
  lastActivatedPoiTagId = tagId;
  onPoiPinActivated({
    tagId,
    kind,
    id: entityId,
    poiId: kind === 'poi' ? entityId : undefined,
    mediaId: kind === 'media' ? entityId : undefined,
    label,
  });
}

/** @deprecated use notifyTagActivated */
function notifyPoiPinActivated(tagId, _opts = {}) {
  notifyTagActivated(tagId);
}

/**
 * Fast HTML “View more” panel — replaces Showcase’s laggy docked drawer.
 * Opens Edit first; does not Tag.close (that caused a Showcase refresh).
 * @param {string} tagId
 * @param {any} [sdk]
 */
async function showPoiDetailDrawer(tagId, sdk = mpSdk) {
  if (!tagId || !poiHoverTagIds.has(tagId)) return;
  notifyTagActivated(tagId);

  wirePoiDetailDrawer(hostEl);
  if (!poiDetailEl) return;

  const meta = poiMetaByTagId.get(tagId);
  const titleEl = poiDetailEl.querySelector('#matterport-poi-detail-title');
  const bodyEl = poiDetailEl.querySelector('#matterport-poi-detail-body');
  if (titleEl) titleEl.textContent = meta?.label || 'POI';
  if (bodyEl) {
    const desc = String(meta?.description || '').trim();
    bodyEl.textContent = desc || 'No description for this POI.';
  }
  poiDetailTagId = tagId;
  poiDetailEl.classList.remove('hidden');
  poiDetailEl.setAttribute('aria-hidden', 'false');
  void sdk;
}

/**
 * When Showcase docks a POI (View more), swap to our drawer.
 * Hover must keep the Showcase billboard — do not close/silence selected POI tags.
 * @param {any} sdk
 * @param {unknown} state
 */
function handlePoiOpenTagsChange(sdk, state) {
  const hovered = asTagId(state?.hovered ?? state?.hover);
  const docked = asTagId(state?.docked);
  const selected = state?.selected;
  const selectedIds = selected instanceof Set
    ? [...selected]
    : Array.isArray(selected)
      ? selected
      : typeof selected === 'string'
        ? [selected]
        : [];

  if (hovered && poiHoverTagIds.has(hovered) && hovered !== poiDetailTagId) {
    if (hoverOpenedTagId !== hovered) {
      void ensurePoiHoverBillboard(sdk, hovered);
    }
  } else if (!hovered && hoverOpenedTagId && hoverOpenedTagId !== poiDetailTagId) {
    hoverOpenedTagId = null;
  }

  if (docked && poiHoverTagIds.has(docked)) {
    notifyTagActivated(docked);
    void showPoiDetailDrawer(docked, sdk);
  }

  // Pin click → Edit (POI or media), same as list Edit button.
  for (const raw of selectedIds) {
    const id = asTagId(raw);
    if (!id) continue;
    if (poiHoverTagIds.has(id) || mediaTagIds.has(id)) {
      notifyTagActivated(id);
    }
  }

  if (!selectedIds.length && !docked) {
    lastActivatedPoiTagId = null;
  }

  const ids = [...selectedIds.map(asTagId), docked, hovered].filter(Boolean);
  for (const id of ids) {
    if (isNavMeManagedTag(id)) continue;
    try {
      sdk.Tag.close?.(id);
    } catch {
      /* */
    }
    void removeSpaceAuthoredTag(sdk, id);
  }
}

async function ensurePoiHoverBillboard(sdk, tagId) {
  if (!sdk || !tagId || !poiHoverTagIds.has(tagId)) return;
  hoverOpenedTagId = tagId;
  // Native hover opening only — do NOT Tag.open here.
  // Programmatic open marks the pin `selected` and delays/blocks real click → Edit.
  try {
    await sdk.Tag?.allowAction?.(tagId, {
      opening: true,
      navigating: false,
      docking: true,
    });
  } catch {
    /* */
  }
}

async function silenceTagBillboard(sdk, tagId) {
  if (!sdk || typeof tagId !== 'string' || !tagId || isBillboardAllowed(tagId)) return;
  try {
    // Empty allowlist → no hover billboard, no click-to-navigate in Showcase.
    if (sdk.Tag?.allowAction) {
      await sdk.Tag.allowAction(tagId, {});
      return;
    }
  } catch {
    /* */
  }
  try {
    if (sdk.Tag?.close) await sdk.Tag.close(tagId);
  } catch {
    /* */
  }
}

/**
 * @param {any} sdk
 * @param {{ x: number, y: number, z: number }} point
 * @param {{
 *   label: string,
 *   description?: string,
 *   color: { r: number, g: number, b: number },
 *   existingId?: string | null,
 *   allowOpen?: boolean,
 *   allowHover?: boolean,
 *   poiId?: string | number | null,
 *   normal?: { x: number, y: number, z: number } | null,
 *   stemVector?: { x: number, y: number, z: number } | null,
 * }} opts
 */
async function upsertTag(sdk, point, opts) {
  const anchorPosition = { x: point.x, y: point.y, z: point.z };
  const stemVector =
    opts.stemVector && Number.isFinite(Number(opts.stemVector.x))
      ? {
          x: Number(opts.stemVector.x),
          y: Number(opts.stemVector.y),
          z: Number(opts.stemVector.z),
        }
      : stemFromNormal(opts.normal || liveNormal || { x: 0, y: 1, z: 0 });
  const allowOpen = Boolean(opts.allowOpen);
  const allowHover = Boolean(opts.allowHover) || allowOpen;
  const description = opts.description != null ? String(opts.description) : '';

  const rememberPoiMeta = (tagId) => {
    if (!tagId || !allowHover || allowOpen) return;
    poiMetaByTagId.set(tagId, {
      label: String(opts.label || 'POI'),
      description,
      poiId: opts.poiId != null ? String(opts.poiId) : null,
    });
  };

  const refreshBillboard = async (tagId) => {
    if (!tagId || !sdk.Tag?.editBillboard) return;
    try {
      await sdk.Tag.editBillboard(tagId, {
        label: String(opts.label || ''),
        description,
      });
    } catch {
      /* */
    }
  };

  const enableHoverOnly = async (tagId) => {
    if (!tagId) return;
    poiHoverTagIds.add(tagId);
    rememberPoiMeta(tagId);
    try {
      // opening → Showcase black card; docking → “View more” can expand; no camera jump.
      await sdk.Tag?.allowAction?.(tagId, {
        opening: true,
        navigating: false,
        docking: true,
      });
    } catch {
      /* */
    }
    await refreshBillboard(tagId);
  };

  const enableMediaOpen = async (tagId) => {
    if (!tagId) return;
    mediaTagIds.add(tagId);
    try {
      // opening → hover shows label; navigating:false → click does not yank the camera.
      await sdk.Tag?.allowAction?.(tagId, { opening: true, navigating: false });
    } catch {
      /* */
    }
  };

  if (opts.existingId) {
    const existingId = asTagId(opts.existingId);
    try {
      if (existingId && sdk.Tag?.editPosition) {
        managedShowcaseTagIds.add(existingId);
        await sdk.Tag.editPosition(existingId, { anchorPosition, stemVector });
        if (allowOpen) await enableMediaOpen(existingId);
        else if (allowHover) await enableHoverOnly(existingId);
        else await silenceTagBillboard(sdk, existingId);
        return existingId;
      }
      if (existingId && sdk.Mattertag?.editPosition) {
        managedShowcaseTagIds.add(existingId);
        await sdk.Mattertag.editPosition(existingId, { anchorPosition, stemVector });
        if (!allowOpen && !allowHover) await silenceTagBillboard(sdk, existingId);
        else if (allowHover) await enableHoverOnly(existingId);
        return existingId;
      }
    } catch {
      /* re-add */
    }
  }
  const desc = {
    label: opts.label,
    description,
    anchorPosition,
    stemVector,
    color: opts.color,
  };
  let id = null;
  if (sdk.Tag?.add) {
    try {
      let ids = await sdk.Tag.add(desc);
      id = asTagId(Array.isArray(ids) ? ids[0] : ids);
      if (!id) {
        ids = await sdk.Tag.add([desc]);
        id = asTagId(Array.isArray(ids) ? ids[0] : ids);
      }
    } catch {
      /* try Mattertag below */
    }
  }
  if (!id && sdk.Mattertag?.add) {
    try {
      const ids = await sdk.Mattertag.add([desc]);
      id = asTagId(Array.isArray(ids) ? ids[0] : ids);
    } catch {
      /* */
    }
  }
  // Register allowlist before any await so Tag.data hide cannot remove the new pin.
  if (id) managedShowcaseTagIds.add(id);
  if (id && allowHover) poiHoverTagIds.add(id);
  if (id && allowOpen) mediaTagIds.add(id);
  if (id && allowOpen) {
    await enableMediaOpen(id);
  } else if (id && allowHover) {
    await enableHoverOnly(id);
  } else {
    await silenceTagBillboard(sdk, id);
  }
  return id;
}

/**
 * Best-effort: attach image/video URL to a Showcase tag billboard.
 * @param {any} sdk
 * @param {string} tagId
 * @param {string} mediaKey
 * @param {string} url
 */
async function attachUrlToTag(sdk, tagId, mediaKey, url) {
  if (!sdk?.Tag?.registerAttachment || !tagId || !url) return;
  if (mediaAttachmentByKey.has(mediaKey)) return;
  try {
    const ids = await sdk.Tag.registerAttachment(url);
    const aid = Array.isArray(ids) ? ids[0] : ids;
    if (!aid) return;
    await sdk.Tag.attach(tagId, aid);
    mediaAttachmentByKey.set(mediaKey, aid);
  } catch (err) {
    console.warn('[space-map] media attach failed', err);
  }
}

/**
 * Sync POI / facility / media markers into Showcase as tags.
 * Media also gets an HTML overlay preview (Three.js planes are covered by the iframe).
 * @param {{
 *   pois?: Array<{ id: string, poi_name?: string, name?: string, pos_x: number, pos_y: number, pos_z: number }>,
 *   facilities?: Array<{ id: string, facility_name?: string, name?: string, pos_x: number, pos_y: number, pos_z: number }>,
 *   media?: Array<{
 *     id: string,
 *     label?: string,
 *     media_type?: string,
 *     media_url?: string,
 *     is_active?: boolean,
 *     pos_x: number,
 *     pos_y: number,
 *     pos_z: number,
 *   }>,
 * }} data
 */
export async function syncMatterportEntityTags(data = {}) {
  if (!mpSdk || !active) return;
  const jobs = [];

  for (const poi of data.pois || []) {
    const key = `poi:${poi.id}`;
    const expectedKey = `poi-expected:${poi.id}`;
    const label = poiDisplayName(poi) || String(poi.name || 'POI');
    const description = String(poiDisplayDescription(poi) || poi.description || '').trim();
    const superAdmin = isSuperAdminMapRole();
    const nav = getPoiNavigationPosition(poi);
    const expected = getPoiExpectedPosition(poi);
    const differs = poiExpectedDiffersFromPlaced(poi, 0.02);
    const expectedNormal = getPoiExpectedNormal(poi);
    const expectedStem = stemFromNormal(expectedNormal, PLACE_STEM_M);
    // Nav pin stays upright on the floor.
    const navStem = { x: 0, y: PLACE_STEM_M, z: 0 };

    const removeManagedTag = (tagKey) => {
      const staleId = tagByEntityKey.get(tagKey);
      if (!staleId) return;
      tagByEntityKey.delete(tagKey);
      poiHoverTagIds.delete(staleId);
      poiMetaByTagId.delete(staleId);
      managedShowcaseTagIds.delete(staleId);
      jobs.push(
        Promise.resolve().then(async () => {
          try {
            await mpSdk.Tag?.remove?.(staleId);
          } catch {
            /* */
          }
        }),
      );
    };

    // Navigation pin (red) — super admin only. Move tools only ever touch this pin.
    if (superAdmin) {
      jobs.push(
        upsertTag(mpSdk, nav, {
          label: `${label} (nav)`,
          description: `${description || label} — navigation XYZ (pos)`,
          color: { r: 1, g: 0.2, b: 0.4 },
          existingId: tagByEntityKey.get(key),
          allowHover: true,
          poiId: poi.id,
          stemVector: navStem,
        }).then((id) => {
          if (id) {
            tagByEntityKey.set(key, id);
            poiHoverTagIds.add(id);
            poiMetaByTagId.set(id, {
              label: `${label} (nav)`,
              description,
              poiId: String(poi.id),
            });
          }
        }),
      );
    }

    // Expected pin (amber) — exact click. Frozen; Move/navmesh must never relocate it.
    const showExpected = !superAdmin || differs;
    if (showExpected) {
      // End admin may still have expected under poi: from older sync — adopt that tag.
      const existingExpectedId =
        tagByEntityKey.get(expectedKey) || (!superAdmin ? tagByEntityKey.get(key) : null);
      jobs.push(
        upsertTag(mpSdk, expected, {
          label: superAdmin ? `${label} (expected)` : label,
          description: superAdmin ? 'Expected XYZ — exact click' : description,
          color: { r: 0.96, g: 0.62, b: 0.04 },
          existingId: existingExpectedId,
          allowHover: true,
          poiId: poi.id,
          stemVector: expectedStem,
        }).then((id) => {
          if (!id) return;
          tagByEntityKey.set(expectedKey, id);
          poiHoverTagIds.add(id);
          poiMetaByTagId.set(id, {
            label: superAdmin ? `${label} (expected)` : label,
            description: superAdmin ? 'Expected XYZ — exact click' : description,
            poiId: String(poi.id),
          });
          if (!superAdmin) {
            const primaryId = tagByEntityKey.get(key);
            if (primaryId === id) {
              tagByEntityKey.delete(key);
            } else if (primaryId) {
              // Leftover nav pin under poi: — remove so only expected remains.
              tagByEntityKey.delete(key);
              poiHoverTagIds.delete(primaryId);
              poiMetaByTagId.delete(primaryId);
              managedShowcaseTagIds.delete(primaryId);
              void mpSdk.Tag?.remove?.(primaryId).catch(() => {});
            }
          }
        }),
      );
    } else {
      removeManagedTag(expectedKey);
    }

    // End admin never keeps a separate nav Showcase pin.
    if (!superAdmin && !showExpected) {
      removeManagedTag(key);
    }
  }

  for (const fac of data.facilities || []) {
    const key = `fac:${fac.id}`;
    const label = String(fac.facility_name || fac.name || 'Amenity');
    jobs.push(
      upsertTag(
        mpSdk,
        { x: Number(fac.pos_x), y: Number(fac.pos_y), z: Number(fac.pos_z) },
        {
          label,
          color: { r: 0.12, g: 0.72, b: 0.78 },
          existingId: tagByEntityKey.get(key),
        },
      ).then((id) => {
        if (id) tagByEntityKey.set(key, id);
      }),
    );
  }

  for (const item of data.media || []) {
    if (!item?.id || item.is_active === false) continue;
    if (isMatterportMediaRow(item)) continue;
    const type = String(item.media_type || '');
    if (type === 'splat') continue;
    const key = `media:${item.id}`;
    const label = String(item.label || 'Media');
    const url = String(item.media_url || item._previewUrl || '').trim();
    jobs.push(
      upsertTag(
        mpSdk,
        { x: Number(item.pos_x), y: Number(item.pos_y), z: Number(item.pos_z) },
        {
          label,
          description: type === 'image' || type === 'video' ? 'Media overlay' : label,
          color: { r: 0.75, g: 0.4, b: 1 },
          existingId: tagByEntityKey.get(key),
          allowOpen: true,
        },
      ).then(async (id) => {
        if (!id) return;
        tagByEntityKey.set(key, id);
        mediaTagIds.add(id);
        if ((type === 'image' || type === 'video') && url) {
          await attachUrlToTag(mpSdk, id, key, url);
        }
      }),
    );
  }

  await Promise.allSettled(jobs);

  // Re-assert Showcase billboards — Tag.data silence can race Tag.add/allowAction.
  for (const id of poiHoverTagIds) {
    try {
      await mpSdk.Tag?.allowAction?.(id, {
        opening: true,
        navigating: false,
        docking: true,
      });
    } catch {
      /* */
    }
  }
  for (const id of mediaTagIds) {
    try {
      await mpSdk.Tag?.allowAction?.(id, { opening: true, navigating: false });
    } catch {
      /* */
    }
  }

  // Tags are added at full opacity — re-apply the active panel's filter so a
  // sync never resurfaces a kind the current panel hides.
  await applyEntityKindVisibility();
}

/**
 * @param {(patch: Record<string, number>, phase: 'change' | 'end') => void} fn
 */
export function setMatterportMediaTransformHandler(fn) {
  onMediaTransform = typeof fn === 'function' ? fn : null;
}

/**
 * @param {HTMLElement | null} overlay
 */
function wireMediaOverlayTools(overlay) {
  if (!overlay || overlay.dataset.toolsWired === '1') return;
  overlay.dataset.toolsWired = '1';

  overlay.querySelectorAll('[data-mp-media-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mp-media-mode') || 'translate';
      mediaOverlayMode = /** @type {'translate' | 'rotate' | 'scale'} */ (mode);
      overlay.querySelectorAll('[data-mp-media-mode]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      overlay.querySelectorAll('[data-mp-fields]').forEach((row) => {
        row.classList.toggle('hidden', row.getAttribute('data-mp-fields') !== mode);
      });
      const stage = overlay.querySelector('.matterport-media-stage');
      if (stage) stage.dataset.mode = mode;
    });
  });

  const emitFromInputs = (phase) => {
    if (!onMediaTransform || !mediaPreviewItem) return;
    const patch = {};
    overlay.querySelectorAll('[data-mp-field]').forEach((input) => {
      const key = input.getAttribute('data-mp-field');
      if (!key) return;
      const n = parseFloat(input.value);
      if (!Number.isFinite(n)) return;
      if (key === 'rot_x_deg') patch.rot_x = (n * Math.PI) / 180;
      else if (key === 'rot_y_deg') patch.rot_y = (n * Math.PI) / 180;
      else if (key === 'rot_z_deg') patch.rot_z = (n * Math.PI) / 180;
      else patch[key] = n;
    });
    onMediaTransform(patch, phase);
    Object.assign(mediaPreviewItem, patch);
    applyMediaPreviewVisual(overlay, mediaPreviewItem);
  };

  overlay.querySelectorAll('[data-mp-field]').forEach((input) => {
    input.addEventListener('input', () => emitFromInputs('change'));
    input.addEventListener('change', () => emitFromInputs('end'));
  });

  // Drag on the preview stage to tweak transform live in the panel.
  overlay.addEventListener('pointerdown', (e) => {
    const stage = e.target?.closest?.('.matterport-media-stage');
    if (!stage || !mediaPreviewItem) return;
    if (e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture?.(e.pointerId);
    mediaStageDrag = { x: e.clientX, y: e.clientY, mode: mediaOverlayMode };
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!mediaStageDrag || !mediaPreviewItem) return;
    const dx = e.clientX - mediaStageDrag.x;
    const dy = e.clientY - mediaStageDrag.y;
    mediaStageDrag.x = e.clientX;
    mediaStageDrag.y = e.clientY;
    const patch = {};
    if (mediaStageDrag.mode === 'translate') {
      patch.pos_x = Number(mediaPreviewItem.pos_x || 0) + dx * 0.01;
      patch.pos_y = Number(mediaPreviewItem.pos_y || 0) - dy * 0.01;
    } else if (mediaStageDrag.mode === 'rotate') {
      patch.rot_y = Number(mediaPreviewItem.rot_y || 0) + (dx * Math.PI) / 180;
      patch.rot_x = Number(mediaPreviewItem.rot_x || 0) + (dy * Math.PI) / 180;
    } else {
      const factor = 1 + (-dy + dx) * 0.005;
      const type = String(mediaPreviewItem.media_type || '');
      if (type === 'image' || type === 'video') {
        patch.width = Math.max(0.1, Number(mediaPreviewItem.width || 1) * factor);
        patch.height = Math.max(0.1, Number(mediaPreviewItem.height || 1) * factor);
      } else {
        patch.scale_x = Math.max(0.01, Number(mediaPreviewItem.scale_x || 1) * factor);
        patch.scale_y = Math.max(0.01, Number(mediaPreviewItem.scale_y || 1) * factor);
        patch.scale_z = Math.max(0.01, Number(mediaPreviewItem.scale_z || 1) * factor);
      }
    }
    Object.assign(mediaPreviewItem, patch);
    fillMediaOverlayInputs(overlay, mediaPreviewItem);
    applyMediaPreviewVisual(overlay, mediaPreviewItem);
    onMediaTransform?.(patch, 'change');
  });
  const endDrag = (e) => {
    if (!mediaStageDrag) return;
    mediaStageDrag = null;
    if (mediaPreviewItem) {
      // Final sync / save
      const patch = {
        pos_x: Number(mediaPreviewItem.pos_x) || 0,
        pos_y: Number(mediaPreviewItem.pos_y) || 0,
        pos_z: Number(mediaPreviewItem.pos_z) || 0,
        rot_x: Number(mediaPreviewItem.rot_x) || 0,
        rot_y: Number(mediaPreviewItem.rot_y) || 0,
        rot_z: Number(mediaPreviewItem.rot_z) || 0,
        width: Number(mediaPreviewItem.width) || 1,
        height: Number(mediaPreviewItem.height) || 1,
        scale_x: Number(mediaPreviewItem.scale_x) || 1,
        scale_y: Number(mediaPreviewItem.scale_y) || 1,
        scale_z: Number(mediaPreviewItem.scale_z) || 1,
      };
      onMediaTransform?.(patch, 'end');
    }
    try {
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* */
    }
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
}

/**
 * @param {HTMLElement} overlay
 * @param {Record<string, unknown>} item
 */
function fillMediaOverlayInputs(overlay, item) {
  const set = (field, value) => {
    const el = overlay.querySelector(`[data-mp-field="${field}"]`);
    if (el) el.value = String(value);
  };
  set('pos_x', Number(item.pos_x || 0).toFixed(4));
  set('pos_y', Number(item.pos_y || 0).toFixed(4));
  set('pos_z', Number(item.pos_z || 0).toFixed(4));
  set('rot_x_deg', Math.round(((Number(item.rot_x) || 0) * 180) / Math.PI));
  set('rot_y_deg', Math.round(((Number(item.rot_y) || 0) * 180) / Math.PI));
  set('rot_z_deg', Math.round(((Number(item.rot_z) || 0) * 180) / Math.PI));
  set('width', Number(item.width || 1).toFixed(2));
  set('height', Number(item.height || 1).toFixed(2));
  set('scale_x', Number(item.scale_x || 1).toFixed(3));
  set('scale_y', Number(item.scale_y || 1).toFixed(3));
  set('scale_z', Number(item.scale_z || 1).toFixed(3));

  const type = String(item.media_type || '');
  const isPlane = type === 'image' || type === 'video';
  overlay.querySelectorAll('.mp-plane-only').forEach((el) => el.classList.toggle('hidden', !isPlane));
  overlay.querySelectorAll('.mp-model-only').forEach((el) => el.classList.toggle('hidden', isPlane));
}

/**
 * Apply rotate / scale / pan to the in-panel preview (live WYSIWYG).
 * @param {HTMLElement} overlay
 * @param {Record<string, unknown>} item
 */
function applyMediaPreviewVisual(overlay, item) {
  if (!overlay || !item) return;
  const media =
    overlay.querySelector('.matterport-media-overlay-media') ||
    overlay.querySelector('.matterport-media-placeholder');
  const stage = overlay.querySelector('.matterport-media-stage');
  if (!media) return;
  const type = String(item.media_type || '');
  if (type !== 'image' && type !== 'video') {
    media.style.transform = '';
    return;
  }
  const w = Math.max(0.1, Number(item.width) || 1);
  const h = Math.max(0.1, Number(item.height) || 1);
  const rx = ((Number(item.rot_x) || 0) * 180) / Math.PI;
  const ry = ((Number(item.rot_y) || 0) * 180) / Math.PI;
  const rz = ((Number(item.rot_z) || 0) * 180) / Math.PI;
  const sx = Math.min(2.2, Math.max(0.25, w / 1.2));
  const sy = Math.min(2.2, Math.max(0.25, h / 1.2));
  const panX = ((Number(item.pos_x) || 0) % 5) * 6;
  const panY = ((Number(item.pos_y) || 0) % 5) * -6;
  media.style.transform = `translate(${panX}px, ${panY}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${sx}, ${sy})`;
  media.style.transformOrigin = 'center center';
  if (stage) {
    stage.style.perspective = '700px';
    stage.dataset.mode = mediaOverlayMode;
  }
}

/**
 * Load image/video into the overlay body.
 * Missing storage objects (404) show a placeholder so Move/Rotate/Scale still work.
 * @param {HTMLElement} body
 * @param {string} type
 * @param {string} url
 * @param {string} label
 * @param {Record<string, unknown>} item
 */
function mountMediaPreviewElement(body, type, url, label, item) {
  body.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'matterport-media-stage';
  stage.dataset.mode = mediaOverlayMode;

  const showPlaceholder = (message) => {
    stage.innerHTML = `
      <div class="matterport-media-placeholder matterport-media-overlay-media" aria-hidden="true">
        <span class="matterport-media-placeholder-label">${label || 'Media'}</span>
      </div>
      <div class="matterport-media-overlay-fallback">${message}</div>
    `;
    body.appendChild(stage);
    applyMediaPreviewVisual(body.closest('.matterport-media-overlay') || body.parentElement, item);
  };

  if (!url) {
    showPlaceholder('No media URL — re-upload via Edit file &amp; label.');
    return;
  }

  if (type === 'image') {
    const img = document.createElement('img');
    img.alt = label;
    img.className = 'matterport-media-overlay-media';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.draggable = false;
    img.onerror = () => {
      showPlaceholder(
        'Image file is missing from storage (old project URL or deleted file). Re-upload via <strong>Edit file &amp; label</strong>, then transform works here.',
      );
    };
    img.onload = () => {
      applyMediaPreviewVisual(body.closest('.matterport-media-overlay') || body.parentElement, item);
    };
    img.src = url;
    stage.appendChild(img);
    body.appendChild(stage);
    return;
  }
  if (type === 'video') {
    const video = document.createElement('video');
    video.className = 'matterport-media-overlay-media';
    video.controls = true;
    video.playsInline = true;
    video.muted = true;
    video.loop = true;
    video.crossOrigin = 'anonymous';
    video.src = url;
    video.onerror = () => {
      showPlaceholder('Video file is missing from storage — re-upload via Edit file &amp; label.');
    };
    stage.appendChild(video);
    body.appendChild(stage);
    void video.play().catch(() => {});
  }
}

/**
 * Show / hide an HTML media preview + transform tools over the Matterport view.
 * @param {Record<string, unknown> | null} item
 */
export function setMatterportMediaPreview(item) {
  if (!mediaOverlayEl) {
    mediaOverlayEl = hostEl?.querySelector('#matterport-media-overlay') || null;
  }
  if (!mediaOverlayEl) return;
  wireMediaOverlayTools(mediaOverlayEl);

  const body = mediaOverlayEl.querySelector('#matterport-media-overlay-body');
  const title = mediaOverlayEl.querySelector('#matterport-media-overlay-title');
  const hint = mediaOverlayEl.querySelector('#matterport-media-overlay-hint');
  const tools = mediaOverlayEl.querySelector('#matterport-media-overlay-tools');
  if (!body) return;

  body.querySelectorAll('video').forEach((v) => {
    try {
      v.pause();
    } catch {
      /* */
    }
  });
  body.querySelectorAll('img').forEach((img) => {
    if (img.src?.startsWith('blob:')) URL.revokeObjectURL(img.src);
  });
  body.innerHTML = '';

  if (!item || !active) {
    mediaPreviewItem = null;
    const closeBtn = mediaOverlayEl.querySelector('#matterport-media-overlay-close');
    if (closeBtn === document.activeElement) /** @type {HTMLElement} */ (closeBtn).blur();
    mediaOverlayEl.classList.add('hidden');
    mediaOverlayEl.setAttribute('aria-hidden', 'true');
    return;
  }

  mediaPreviewItem = { ...item };
  const type = String(item.media_type || '');
  const url = resolveMediaDisplayUrl(item);
  if (title) title.textContent = String(item.label || 'Media');

  if (type === 'image' || type === 'video') {
    mountMediaPreviewElement(
      body,
      type,
      url,
      String(item.label || 'Media'),
      mediaPreviewItem,
    );
    if (hint) {
      hint.textContent =
        'Drag preview to Move / Rotate / Scale · values save with Media → Save';
    }
    tools?.classList.remove('hidden');
  } else if (type === 'model' || type === 'splat') {
    body.innerHTML = `<div class="matterport-media-overlay-fallback">${
      type === 'splat' ? 'Splat' : '3D model'
    } can’t render inside the space viewer — use Move / Scale values, pin shows position.</div>`;
    if (hint) hint.textContent = 'Transform values still save · open mesh map to see the model';
    tools?.classList.remove('hidden');
  } else {
    body.innerHTML =
      '<div class="matterport-media-overlay-fallback">No preview URL for this media.</div>';
    if (hint) hint.textContent = '';
    tools?.classList.add('hidden');
  }

  fillMediaOverlayInputs(mediaOverlayEl, mediaPreviewItem);
  applyMediaPreviewVisual(mediaOverlayEl, mediaPreviewItem);

  mediaOverlayEl.classList.remove('hidden');
  mediaOverlayEl.setAttribute('aria-hidden', 'false');
  // Keep the HTML transform tools as the AR editor — do not Tag.open
  // (Showcase tag click/close was dismissing the layer while editing).
}

/**
 * Keep overlay XYZ fields in sync while dragging media on the map.
 * @param {{ x: number, y: number, z: number }} pt
 */
export function syncMatterportMediaOverlayPosition(pt) {
  if (!mediaOverlayEl || !pt || mediaOverlayEl.classList.contains('hidden')) return;
  const set = (field, value) => {
    const el = mediaOverlayEl.querySelector(`[data-mp-field="${field}"]`);
    if (el) el.value = Number(value).toFixed(4);
  };
  set('pos_x', pt.x);
  set('pos_y', pt.y);
  set('pos_z', pt.z);
  if (mediaPreviewItem) {
    mediaPreviewItem.pos_x = pt.x;
    mediaPreviewItem.pos_y = pt.y;
    mediaPreviewItem.pos_z = pt.z;
    applyMediaPreviewVisual(mediaOverlayEl, mediaPreviewItem);
  }
}

/**
 * Switch Showcase view mode (replaces in-player Dollhouse / Floor plan / Explore pills).
 * @param {'dollhouse' | 'floorplan' | 'inside'} modeKey
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
export async function matterportSetViewMode(modeKey) {
  if (!mpSdk || !active) {
    return { ok: false, error: '3D space map not ready' };
  }
  const ModeEnum = mpSdk.Mode?.Mode || {};
  const map = {
    dollhouse: ModeEnum.DOLLHOUSE || 'mode.dollhouse',
    floorplan: ModeEnum.FLOORPLAN || 'mode.floorplan',
    inside: ModeEnum.INSIDE || 'mode.inside',
  };
  const target = map[modeKey];
  if (!target) return { ok: false, error: 'Unknown view mode' };
  try {
    const fly = mpSdk.Camera?.TransitionType?.FLY || 'transition.fly';
    if (typeof mpSdk.Mode?.moveTo !== 'function') {
      return { ok: false, error: 'View mode switch unavailable' };
    }
    await mpSdk.Mode.moveTo(target, { transition: fly });
    currentViewMode = modeKey;
    return { ok: true, mode: modeKey };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** @deprecated use matterportSetViewMode('dollhouse') */
export async function matterportEnterDollhouse() {
  return matterportSetViewMode('dollhouse');
}

/**
 * Subscribe to Showcase mode changes for toolbar active state.
 * @param {(modeKey: 'dollhouse' | 'floorplan' | 'inside' | 'other') => void} fn
 * @returns {() => void}
 */
export function onMatterportViewModeChange(fn) {
  if (typeof fn !== 'function') return () => {};
  if (!mpSdk?.Mode?.current?.subscribe) return () => {};
  const ModeEnum = mpSdk.Mode?.Mode || {};
  const toKey = (mode) => {
    if (mode === ModeEnum.DOLLHOUSE || mode === 'mode.dollhouse') return 'dollhouse';
    if (mode === ModeEnum.FLOORPLAN || mode === 'mode.floorplan') return 'floorplan';
    if (mode === ModeEnum.INSIDE || mode === 'mode.inside') return 'inside';
    return 'other';
  };
  try {
    const sub = mpSdk.Mode.current.subscribe((mode) => {
      const key = toKey(mode);
      currentViewMode = key;
      fn(key);
    });
    if (typeof sub === 'function') return sub;
    if (sub?.cancel) return () => sub.cancel();
  } catch {
    /* */
  }
  return () => {};
}

export function getMatterportViewMode() {
  return currentViewMode;
}

/**
 * Axis-aligned bounds of Showcase scan points (Matterport world).
 * Used to align the geometric MultiSet mesh to the photoreal space.
 * @returns {Promise<import('three').Box3 | null>}
 */
export async function getMatterportSweepBounds() {
  if (!active || !mpSdk) return null;
  try {
    const collection = await readSweepCollection(mpSdk);
    const sweeps = sweepListFromCollection(collection);
    if (!sweeps.length) return null;
    const box = new THREE.Box3();
    for (const s of sweeps) {
      box.expandByPoint(new THREE.Vector3(s.x, s.y, s.z));
    }
    return box.isEmpty() ? null : box;
  } catch (err) {
    console.warn('[space-map] sweep bounds failed', err);
    return null;
  }
}

/**
 * List floors for the custom floor picker (Showcase bottom floors UI is cropped).
 * @returns {Promise<{ ok: boolean, floors: { sequence: number, id?: string, name: string }[], currentSequence: number | null, error?: string }>}
 */
export async function getMatterportFloors() {
  if (!mpSdk?.Floor || !active) {
    return { ok: false, floors: [], currentSequence: null, error: '3D space map not ready' };
  }
  try {
    /** @type {{ sequence: number, id?: string, name: string }[]} */
    let floors = [];
    let currentSequence = /** @type {number | null} */ (null);

    if (mpSdk.Floor.data?.subscribe) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          const sub = mpSdk.Floor.data.subscribe({
            onCollectionUpdated(collection) {
              const list = Object.values(collection || {})
                .map((f) => ({
                  sequence: Number(f?.sequence),
                  id: f?.id != null ? String(f.id) : undefined,
                  name: String(f?.name || '').trim() || `Floor ${Number(f?.sequence) + 1}`,
                }))
                .filter((f) => Number.isFinite(f.sequence))
                .sort((a, b) => a.sequence - b.sequence);
              floors = list;
              finish();
              try {
                if (typeof sub === 'function') sub();
                else sub?.cancel?.();
              } catch {
                /* */
              }
            },
          });
          setTimeout(finish, 1200);
        } catch {
          finish();
        }
      });
    }

    if (!floors.length && typeof mpSdk.Floor.getData === 'function') {
      const data = await mpSdk.Floor.getData();
      const names = Array.isArray(data?.floorNames) ? data.floorNames : [];
      const total = Number(data?.totalFloors) || names.length || 0;
      floors = Array.from({ length: total }, (_, i) => ({
        sequence: i,
        name: String(names[i] || '').trim() || `Floor ${i + 1}`,
      }));
      if (Number.isFinite(Number(data?.currentFloor))) {
        currentSequence = Number(data.currentFloor);
      }
    }

    if (currentSequence == null && mpSdk.Floor.current) {
      try {
        const snap =
          typeof mpSdk.Floor.current.getSnapshot === 'function'
            ? mpSdk.Floor.current.getSnapshot()
            : null;
        if (snap && Number.isFinite(Number(snap.sequence))) {
          currentSequence = Number(snap.sequence);
        }
      } catch {
        /* */
      }
    }

    return { ok: true, floors, currentSequence };
  } catch (err) {
    return { ok: false, floors: [], currentSequence: null, error: err?.message || String(err) };
  }
}

/**
 * @param {number | 'all'} indexOrAll — floor sequence, or 'all' for every floor
 * @returns {Promise<{ ok: boolean, sequence?: number, error?: string }>}
 */
export async function matterportMoveToFloor(indexOrAll) {
  if (!mpSdk?.Floor || !active) {
    return { ok: false, error: '3D space map not ready' };
  }
  try {
    if (indexOrAll === 'all' || indexOrAll === -1) {
      if (typeof mpSdk.Floor.showAll !== 'function') {
        return { ok: false, error: 'Show all floors unavailable' };
      }
      await mpSdk.Floor.showAll();
      return { ok: true, sequence: -1 };
    }
    const index = Number(indexOrAll);
    if (!Number.isFinite(index)) return { ok: false, error: 'Invalid floor' };
    if (typeof mpSdk.Floor.moveTo !== 'function') {
      return { ok: false, error: 'Floor switch unavailable' };
    }
    await mpSdk.Floor.moveTo(index);
    return { ok: true, sequence: index };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * @param {(info: { sequence: number | null, name?: string, viewingAll: boolean }) => void} fn
 * @returns {() => void}
 */
export function onMatterportFloorChange(fn) {
  if (typeof fn !== 'function') return () => {};
  if (!mpSdk?.Floor?.current?.subscribe) return () => {};
  try {
    const sub = mpSdk.Floor.current.subscribe((currentFloor) => {
      if (currentFloor?.sequence === -1) {
        fn({ sequence: -1, name: currentFloor?.name, viewingAll: true });
        return;
      }
      if (currentFloor?.sequence === undefined) return;
      fn({
        sequence: Number(currentFloor.sequence),
        name: currentFloor?.name,
        viewingAll: false,
      });
    });
    if (typeof sub === 'function') return sub;
    if (sub?.cancel) return () => sub.cancel();
  } catch {
    /* */
  }
  return () => {};
}

/**
 * @param {any} sdk
 * @returns {Promise<Record<string, any>>}
 */
function readSweepCollection(sdk) {
  if (cachedSweepCollection) return Promise.resolve(cachedSweepCollection);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sweep.data timeout')), 2500);
    const finish = (collection) => {
      clearTimeout(timer);
      cachedSweepCollection = collection || {};
      resolve(cachedSweepCollection);
    };
    try {
      const sub = sdk.Sweep.data.subscribe({
        onChanged() {},
        onCollectionUpdated(collection) {
          finish(collection);
          try {
            if (typeof sub === 'function') sub();
            else sub?.cancel?.();
          } catch {
            /* */
          }
        },
      });
    } catch {
      try {
        sdk.Sweep.data.subscribe((collection) => finish(collection));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}

/**
 * Horizontal yaw from `from` toward `to` (level pitch — vertical handled separately).
 * @param {{ x: number, y: number, z: number }} from
 * @param {{ x: number, y: number, z: number }} to
 */
function rotationYawToward(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const yaw = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return { x: 0, y: yaw };
}

/**
 * Matterport Sweep / Camera rotation that looks from `from` toward `to`.
 * Pitch is clamped so wall/high pins stay near screen center (not straight up).
 * @param {{ x: number, y: number, z: number }} from
 * @param {{ x: number, y: number, z: number }} to
 * @param {{ maxPitch?: number, minPitch?: number }} [opts]
 */
function rotationLookingAt(from, to, opts = {}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horiz = Math.sqrt(dx * dx + dz * dz) || 1e-6;
  let pitch = (Math.atan2(dy, horiz) * 180) / Math.PI;
  const maxPitch = Number.isFinite(opts.maxPitch) ? opts.maxPitch : 28;
  const minPitch = Number.isFinite(opts.minPitch) ? opts.minPitch : -35;
  // Standing almost under a high pin → soften pitch so the camera isn't skyward.
  if (horiz < 1.5 && pitch > maxPitch) {
    pitch = maxPitch;
  }
  pitch = Math.max(minPitch, Math.min(maxPitch, pitch));
  const yaw = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return {
    x: pitch,
    y: yaw,
  };
}

function matterportShowcaseSize() {
  const w = iframeEl?.clientWidth || hostEl?.clientWidth || 1;
  const h = iframeEl?.clientHeight || hostEl?.clientHeight || 1;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/**
 * @param {{ x: number, y: number, z: number }} worldPos
 * @param {Record<string, unknown>} pose
 */
function matterportWorldToScreen(worldPos, pose) {
  if (!mpSdk || !pose) return null;
  const size = matterportShowcaseSize();
  try {
    if (typeof mpSdk.Conversion?.worldToScreen === 'function') {
      const p = mpSdk.Conversion.worldToScreen(worldPos, pose, size);
      return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
    }
    if (typeof mpSdk.Renderer?.worldToScreen === 'function') {
      const p = mpSdk.Renderer.worldToScreen(worldPos, pose, size);
      return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
    }
  } catch {
    /* */
  }
  return null;
}

async function refreshMatterportCameraPose(delayMs = 0) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (typeof mpSdk?.Camera?.getPose === 'function') {
    try {
      lastCameraPose = await mpSdk.Camera.getPose();
    } catch {
      /* keep last subscription pose */
    }
  }
  return lastCameraPose;
}

/**
 * At the current sweep: face the POI horizontally, then adjust pitch only so
 * the pin sits on the vertical center line of the screen.
 * @param {{ x: number, y: number, z: number }} from
 * @param {{ x: number, y: number, z: number }} target
 */
async function matterportCenterTargetVertically(from, target) {
  if (!mpSdk?.Camera || !from) return false;

  const yawRot = rotationYawToward(from, target);
  try {
    if (typeof mpSdk.Camera.setRotation === 'function') {
      await mpSdk.Camera.setRotation(yawRot, { speed: 140 });
    }
  } catch {
    /* continue with whatever pose we have */
  }
  await refreshMatterportCameraPose(320);

  const size = matterportShowcaseSize();
  const centerY = size.h / 2;

  for (let i = 0; i < 10; i++) {
    const pose = lastCameraPose;
    if (!pose) break;

    const screen = matterportWorldToScreen(target, pose);
    if (!screen || !Number.isFinite(screen.y)) {
      // Fallback when screen projection is unavailable.
      await matterportFaceTargetFrom(from, target);
      return true;
    }

    const dy = screen.y - centerY;
    if (Math.abs(dy) < 5) return true;

    const pitchStep = Math.max(-10, Math.min(10, -dy * 0.055));
    const cur = pose.rotation || yawRot;
    const curY = Number(cur.y ?? yawRot.y);
    let moved = false;

    if (typeof mpSdk.Camera.rotate === 'function') {
      try {
        await mpSdk.Camera.rotate(0, pitchStep, { speed: 160 });
        moved = true;
      } catch {
        /* try setRotation */
      }
    }
    if (!moved && typeof mpSdk.Camera.setRotation === 'function') {
      const curX = Number(cur.x ?? 0);
      // Keep framing comfortable — never tilt skyward past ~28°.
      const nextX = Math.max(-32, Math.min(28, curX + pitchStep));
      try {
        await mpSdk.Camera.setRotation({ x: nextX, y: curY }, { speed: 160 });
        moved = true;
      } catch {
        return false;
      }
    }
    if (!moved) return false;

    await refreshMatterportCameraPose(280);
  }

  return true;
}

/**
 * Rotate in place at the current sweep so the camera faces `target`.
 * Does not change sweep / walkthrough position.
 * @param {{ x: number, y: number, z: number }} from
 * @param {{ x: number, y: number, z: number }} target
 */
async function matterportFaceTargetFrom(from, target) {
  if (!mpSdk?.Camera?.setRotation || !from) return false;
  try {
    await mpSdk.Camera.setRotation(rotationLookingAt(from, target), {
      speed: 140,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Map<string, any> | Record<string, any> | any[]} collection
 * @param {{ x: number, y: number, z: number }} target
 * @param {{ horizontalBias?: boolean }} [opts]
 */
function findNearestSweep(collection, target, opts = {}) {
  const entries = Array.isArray(collection)
    ? collection
    : collection instanceof Map
      ? [...collection.values()]
      : Object.values(collection || {});
  const horizontalBias = opts.horizontalBias !== false;
  let best = null;
  let bestDist = Infinity;
  for (const sweep of entries) {
    if (!sweep || sweep.enabled === false) continue;
    const id = sweep.id || sweep.sid || sweep.uuid;
    const pos = sweep.position || sweep.pose?.position || sweep.location;
    if (!id || !pos) continue;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (![x, y, z].every(Number.isFinite)) continue;
    const dx = x - target.x;
    const dy = y - target.y;
    const dz = z - target.z;
    // Prefer floor distance — wall/expected Y offsets often pick the wrong/"next" sweep.
    const dist = horizontalBias
      ? Math.sqrt(dx * dx + dz * dz) + Math.abs(dy) * 0.15
      : Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < bestDist) {
      bestDist = dist;
      best = {
        id: String(id),
        distance: dist,
        position: { x, y, z },
      };
    }
  }
  return best;
}

/**
 * @param {string | null | undefined} tagId
 */
async function ensureMatterportTagVisible(tagId) {
  const id = asTagId(tagId);
  if (!id || !mpSdk) return;
  try {
    await mpSdk.Tag?.editOpacity?.(id, 1);
  } catch {
    /* */
  }
  try {
    await mpSdk.Tag?.allowAction?.(id, {
      opening: true,
      navigating: false,
      docking: true,
    });
  } catch {
    /* */
  }
}

function disposeMpObject3D(obj) {
  if (!obj) return;
  obj.traverse?.((child) => {
    child.geometry?.dispose?.();
    const mats = child.material
      ? Array.isArray(child.material)
        ? child.material
        : [child.material]
      : [];
    for (const mat of mats) {
      mat.map?.dispose?.();
      mat.dispose?.();
    }
  });
  obj.parent?.remove?.(obj);
}

function teardownMpOverlays() {
  clearPlaceGizmo();
  try {
    overlayObject?.stop?.();
  } catch {
    /* */
  }
  if (overlayRaf) {
    cancelAnimationFrame(overlayRaf);
    overlayRaf = 0;
  }
  try {
    stopPoseWatch?.();
  } catch {
    /* */
  }
  stopPoseWatch = null;
  overlayResizeObs?.disconnect();
  overlayResizeObs = null;
  overlayRenderer?.dispose?.();
  overlayRenderer = null;
  overlayCamera = null;
  overlayCanvas?.classList.remove('is-active');
  overlayObject = null;
  overlayRoot = null;
  mpThree = null;
  overlayReady = null;
  heatmapOverlay = null;
  userTrailOverlay = null;
  heatTrailTagIds = [];
  navRouteOverlay = null;
  navmeshOverlay = null;
  navmeshOverlayVisible = false;
}

function poseProjectionArray(pose) {
  const proj = pose?.projection || pose?.projectionMatrix;
  if (!proj || typeof proj.length !== 'number' || proj.length < 16) return null;
  return proj;
}

/**
 * Showcase Camera.pose.rotation is pitch/yaw in degrees (Vector2), not radians.
 * Projection is often a Float32Array — Array.isArray() misses it.
 * @param {Record<string, unknown>} pose
 */
function applyShowcasePoseToOverlay(pose) {
  if (!overlayCamera || !pose) return;
  const p = pose.position;
  const r = pose.rotation;
  if (p) overlayCamera.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
  if (r) {
    if (Number.isFinite(Number(r.w))) {
      overlayCamera.quaternion.set(
        Number(r.x) || 0,
        Number(r.y) || 0,
        Number(r.z) || 0,
        Number(r.w),
      );
    } else {
      overlayCamera.rotation.order = 'YXZ';
      overlayCamera.rotation.set(
        THREE.MathUtils.degToRad(Number(r.x) || 0),
        THREE.MathUtils.degToRad(Number(r.y) || 0),
        0,
      );
    }
  }
  const proj = poseProjectionArray(pose);
  if (proj) {
    overlayCamera.projectionMatrix.fromArray(proj);
    overlayCamera.projectionMatrixInverse.copy(overlayCamera.projectionMatrix).invert();
  }
}

function resizeMpOverlayCanvas() {
  if (!overlayCanvas || !overlayRenderer || !overlayCamera || !iframeEl) return;
  const w = Math.max(1, iframeEl.clientWidth);
  const h = Math.max(1, iframeEl.clientHeight);
  overlayRenderer.setSize(w, h, false);
  if (lastCameraPose) {
    applyShowcasePoseToOverlay(lastCameraPose);
    return;
  }
  overlayCamera.aspect = w / h;
  overlayCamera.updateProjectionMatrix();
}

function startMpOverlayLoop() {
  if (overlayRaf) return;
  const tick = () => {
    overlayRaf = requestAnimationFrame(tick);
    // Skip empty WebGL clears — huge win when only the 2D heat/nav canvas is active.
    if (!overlayRenderer || !overlayRoot || !overlayCamera) return;
    if (!overlayRoot.children.length) return;
    overlayRenderer.render(overlayRoot, overlayCamera);
  };
  overlayRaf = requestAnimationFrame(tick);
}

function watchMpCameraPose(sdk) {
  if (!sdk?.Camera?.pose || !overlayCamera || stopPoseWatch) return;
  try {
    const sub = sdk.Camera.pose.subscribe((pose) => {
      if (pose) lastCameraPose = pose;
      applyShowcasePoseToOverlay(pose);
      if (heatWorldPoints.length || navWorldPoints.length) scheduleAnnotDraw({ moving: true });
    });
    stopPoseWatch = () => {
      try {
        if (typeof sub === 'function') sub();
        else sub?.cancel?.();
      } catch {
        /* */
      }
    };
  } catch (err) {
    console.warn('[space-map] camera pose overlay failed', err);
  }
}

function ensureMpOverlayCanvas() {
  overlayCanvas = hostEl?.querySelector('#matterport-scene-overlay') || overlayCanvas;
  if (!overlayCanvas || !iframeEl) throw new Error('Space overlay canvas missing');
  if (!overlayRenderer) {
    overlayRenderer = new THREE.WebGLRenderer({
      canvas: overlayCanvas,
      alpha: true,
      antialias: true,
    });
    overlayRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    overlayRenderer.setClearColor(0x000000, 0);
    overlayRenderer.autoClear = true;
    overlayCamera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000);
    overlayRoot = new THREE.Scene();
    mpThree = THREE;
  }
  overlayCanvas.classList.add('is-active');
  resizeMpOverlayCanvas();
  if (!overlayResizeObs && typeof ResizeObserver !== 'undefined' && hostEl) {
    overlayResizeObs = new ResizeObserver(() => {
      resizeMpOverlayCanvas();
      if (heatWorldPoints.length || navWorldPoints.length) scheduleAnnotDraw({ moving: true });
    });
    overlayResizeObs.observe(hostEl);
  }
  watchMpCameraPose(mpSdk);
  startMpOverlayLoop();
  if (lastCameraPose) applyShowcasePoseToOverlay(lastCameraPose);
}

async function ensureMpOverlayScene() {
  if (!active || !mpSdk) {
    throw new Error('Space overlay unavailable');
  }
  // Always composite heat / navmesh on our transparent canvas. Matterport Scene
  // objects sit inside the photoreal mesh and disappear in dollhouse.
  ensureMpOverlayCanvas();
  if (!overlayRoot || !mpThree) {
    throw new Error('Could not attach overlays to the space');
  }
}

function sweepListFromCollection(collection) {
  const entries = Array.isArray(collection)
    ? collection
    : collection instanceof Map
      ? [...collection.values()]
      : Object.values(collection || {});
  const sweeps = [];
  for (const sweep of entries) {
    if (!sweep || sweep.enabled === false) continue;
    const id = String(sweep.id || sweep.sid || sweep.uuid || '');
    const pos = sweep.position || sweep.pose?.position || sweep.location;
    if (!id || !pos) continue;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (![x, y, z].every(Number.isFinite)) continue;
    const neighbors = Array.isArray(sweep.neighbors)
      ? sweep.neighbors.map((n) => String(n?.id || n || '')).filter(Boolean)
      : [];
    const floorKey = String(
      sweep.floorInfo?.id || sweep.floorId || sweep.floor || 'default',
    );
    sweeps.push({ id, x, y, z, neighbors, floorKey });
  }
  return sweeps;
}

function fanGeometryFromPoints(THREE, pts, y) {
  if (!THREE || pts.length < 3) return null;
  const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
  const cz = pts.reduce((sum, p) => sum + p.z, 0) / pts.length;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx),
  );
  const verts = [cx, y, cz];
  for (const p of sorted) verts.push(p.x, y, p.z);
  const indices = [];
  for (let i = 0; i < sorted.length; i += 1) {
    indices.push(0, i + 1, ((i + 1) % sorted.length) + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildMpNavmeshGroup(THREE, sweeps) {
  const group = new THREE.Group();
  group.name = 'NavmeMpNavmesh';
  const byFloor = new Map();
  for (const sweep of sweeps) {
    const list = byFloor.get(sweep.floorKey) || [];
    list.push(sweep);
    byFloor.set(sweep.floorKey, list);
  }

  const discMat = new THREE.MeshBasicMaterial({
    color: 0x4ade80,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const meshMat = new THREE.MeshBasicMaterial({
    color: 0x22ff66,
    transparent: true,
    opacity: 0.34,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x16a34a,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });

  const byId = new Map(sweeps.map((s) => [s.id, s]));
  const linePos = [];
  const seenEdge = new Set();

  for (const pts of byFloor.values()) {
    const ys = pts.map((p) => p.y).sort((a, b) => a - b);
    const floorY = ys[Math.floor(ys.length / 2)] + 0.04;
    const geo = fanGeometryFromPoints(THREE, pts, floorY);
    if (geo) {
      const mesh = new THREE.Mesh(geo, meshMat);
      mesh.renderOrder = 3;
      group.add(mesh);
      if (THREE.EdgesGeometry) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMat);
        edges.renderOrder = 4;
        group.add(edges);
      }
    }
    for (const p of pts) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.22, 18), discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(p.x, p.y + 0.05, p.z);
      disc.renderOrder = 5;
      group.add(disc);
      for (const nid of p.neighbors) {
        const other = byId.get(nid);
        if (!other) continue;
        const key = p.id < nid ? `${p.id}|${nid}` : `${nid}|${p.id}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        linePos.push(p.x, p.y + 0.06, p.z, other.x, other.y + 0.06, other.z);
      }
    }
  }

  if (linePos.length >= 6) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.renderOrder = 6;
    group.add(lines);
  }
  return group;
}

/**
 * Small lift off the floor, to avoid z-fighting with the surface.
 */
const NAV_DOT_HEIGHT_M = 0.06;
/**
 * Matterport sweep positions are recorded at CAMERA height — roughly eye level,
 * not floor level. Drawing the trail at raw sweep Y therefore floats it at head
 * height. Subtract this to put the dots on the ground where a path belongs.
 */
const SWEEP_EYE_HEIGHT_M = 1.5;
/**
 * How the route trail is drawn: 'dots' for discrete markers on each resampled
 * point, 'ribbon' for one continuous band. Both honour the same distance
 * window and the same stair breaks.
 */
const ROUTE_STYLE = 'dots';
/** How far ahead the route is drawn, in metres. */
const ROUTE_VISIBLE_M = 12;
/** Half-width of the route ribbon, in metres — world units, so it tapers. */
const ROUTE_HALF_WIDTH_M = 0.17;
/**
 * Gap between route dots, in metres — the same for camera-point, hybrid and
 * navmesh routes so all three read identically.
 */
const NAV_DOT_SPACING_M = 0.55;
/**
 * How much height counts when finding the scan point nearest a position.
 * Above 1 so a point on the correct floor beats a marginally closer one on the
 * floor below — which is what happens near voids, stairwells and atria.
 */
const NEAREST_SWEEP_HEIGHT_WEIGHT = 2;
/** Longest flat run between two flights still counted as a landing, in metres. */
const LANDING_MAX_M = 5;
/** Beyond this the scan number is too small to read, so it is not drawn. */
const NAV_LABEL_MAX_DIST_M = 14;
/**
 * A route segment is left un-interpolated only when it both RISES more than
 * this and RUNS longer than STAIR_INTERP_MAX_RUN_M — i.e. there is unscanned
 * staircase between the two points. Short rising segments are the treads
 * themselves and are filled in normally.
 */
const STAIR_INTERP_MAX_RISE_M = 0.45;
/**
 * Longest rising segment still treated as a single straight run of steps.
 * Measured: consecutive scan points on this space's flights sit 2.1-3.1 m
 * apart, while a segment spanning an unscanned flight is far longer.
 */
const STAIR_INTERP_MAX_RUN_M = 4;
/**
 * Cost multiplier for routing through a scan point that is off the navmesh.
 *
 * Deliberately mild. A large multiplier looks safer but is not: an uploaded
 * navmesh frequently fails to cover staircases, which flags every stair scan
 * point as off-mesh and makes the direct neighbour link across the stairwell
 * cheaper than climbing — producing a route that teleports from the bottom of
 * the stairs to the top. This value discourages off-mesh points without ever
 * being able to buy a physically impossible hop; `repairTeleports` is the
 * structural backstop.
 */
const OFF_NAVMESH_PENALTY = 2;

/** Adaptive budgets — keep heat/nav off the critical path on low-spec devices. */
function overlayPerfProfile() {
  const cores = Number(navigator.hardwareConcurrency) || 4;
  const mem = Number(navigator.deviceMemory) || 4;
  const low = mem <= 2 || cores <= 2;
  const mid = !low && (mem <= 4 || cores <= 4);
  // Walkthrough (inside) projects every frame — keep denser clouds lighter.
  const inside = currentViewMode === 'inside';
  return {
    heatCap: inside ? (low ? 120 : mid ? 180 : 240) : low ? 160 : mid ? 280 : 420,
    heatCell: inside ? (low ? 0.3 : mid ? 0.22 : 0.18) : low ? 0.24 : mid ? 0.18 : 0.14,
    navCap: low ? 40 : mid ? 64 : 96,
    dprCap: 1,
    movingHeatMax: inside ? (low ? 36 : mid ? 52 : 64) : low ? 48 : mid ? 72 : 96,
    movingMinGapMs: inside ? (low ? 160 : 120) : low ? 140 : 100,
    idleSettleMs: inside ? 160 : 200,
    drawBudgetMs: inside ? (low ? 3 : 4) : low ? 4 : 6,
  };
}

/**
 * Fast downsample — no giant intermediate arrays.
 * @param {Array<{ x: number, y: number, z: number }>} verts
 * @param {number} maxPts
 */
/**
 * Resample a polyline so points sit at a fixed spacing in WORLD metres.
 *
 * Spacing has to be world-space, not screen-space: with perspective, evenly
 * spaced screen dots bunch up towards the horizon and read as a smear rather
 * than a trail of footsteps on the floor.
 *
 * @param {Array<{x:number,y:number,z:number}>} verts
 * @param {number} spacing metres between dots
 * @param {number} maxPts  hard cap, so a long route cannot flood the canvas
 */
function resamplePolylineEven(verts, spacing, maxPts) {
  if (verts.length < 2) return verts.slice();
  const step = Math.max(0.05, spacing);
  const out = [verts[0]];
  let carry = 0;

  for (let i = 1; i < verts.length; i += 1) {
    const a = verts[i - 1];
    const b = verts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const segLen = Math.hypot(dx, dy, dz);
    if (segLen <= 1e-6) continue;

    // Interpolate up a flight, but never across an unscanned one.
    //
    // A rising segment between two scan points a few metres apart runs straight
    // along the treads, so filling it in reads correctly and keeps the trail
    // continuous on stairs. A rising segment that is also LONG is different:
    // there is unscanned staircase in between, the real path bends at a
    // landing, and a straight line would drive a diagonal through the ceiling
    // slab. Only that case is left empty, showing the scan points that exist
    // and inventing nothing between them.
    if (Math.abs(dy) > STAIR_INTERP_MAX_RISE_M && segLen > STAIR_INTERP_MAX_RUN_M) {
      // breakBefore tells the renderer to start a new ribbon here instead of
      // joining across the stairwell.
      out.push(
        b.label == null
          ? { x: b.x, y: b.y, z: b.z, breakBefore: true }
          : { x: b.x, y: b.y, z: b.z, breakBefore: true, label: b.label },
      );
      if (out.length >= maxPts) return out;
      carry = 0;
      continue;
    }

    let t = (step - carry) / segLen;
    while (t <= 1) {
      out.push({ x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t });
      if (out.length >= maxPts) return out;
      t += step / segLen;
    }

    // Always land a dot ON the scan point itself.
    //
    // Even spacing alone walks straight past the route's own vertices, so a
    // scan point can end up with no dot on it and the trail cuts the corner at
    // every turn. On a staircase, where each vertex IS a step, that reads as
    // the route skipping points it actually visits. Emitting the vertex and
    // restarting the spacing from there keeps the gaps even and guarantees
    // every scan point on the route is drawn.
    const tail = out[out.length - 1];
    if (
      !tail ||
      Math.hypot(b.x - tail.x, b.y - tail.y, b.z - tail.z) > step * 0.25
    ) {
      out.push(b.label == null ? { x: b.x, y: b.y, z: b.z } : { x: b.x, y: b.y, z: b.z, label: b.label });
      if (out.length >= maxPts) return out;
    } else {
      // Close enough that two dots would overlap — move it onto the vertex.
      tail.x = b.x;
      tail.y = b.y;
      tail.z = b.z;
      if (b.label != null) tail.label = b.label;
    }
    carry = 0;
  }

  const last = verts[verts.length - 1];
  const tail = out[out.length - 1];
  // Always land exactly on the destination, even if it falls mid-step.
  if (Math.hypot(last.x - tail.x, last.y - tail.y, last.z - tail.z) > step * 0.35) {
    out.push(last);
  }
  return out;
}

function downsamplePolyline(verts, maxPts) {
  if (!verts.length || verts.length <= maxPts) return verts.slice();
  const out = new Array(maxPts);
  const step = (verts.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i += 1) {
    out[i] = verts[Math.round(i * step)];
  }
  return out;
}

/**
 * Collapse near-duplicates (keeps Y). Speeds up dense trails.
 * @param {Array<{ x: number, y: number, z: number }>} verts
 * @param {number} cell
 * @param {number} [hardCap]
 */
function dedupeWorldPoints(verts, cell = 0.05, hardCap = Infinity) {
  const seen = new Set();
  const out = [];
  const inv = 1 / Math.max(0.01, cell);
  for (const v of verts) {
    const key = `${Math.round(v.x * inv)}:${Math.round(v.y * inv)}:${Math.round(v.z * inv)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= hardCap) break;
  }
  return out;
}

/**
 * Stream-sample + dedupe without blocking on 50k-row arrays.
 * @param {Array<{ pos_x?: number, pos_y?: number, pos_z?: number, x?: number, y?: number, z?: number }> | null | undefined} points
 * @param {number} [maxPoints]
 * @param {number} [cell]
 */
function normalizeHeatWorldPoints(points, maxPoints, cell) {
  const profile = overlayPerfProfile();
  const cap = Math.max(80, Math.min(profile.heatCap, Number(maxPoints) || profile.heatCap));
  const cellSize = cell ?? profile.heatCell;
  if (!points?.length) return [];

  // Pre-stride so we never touch more than ~cap*4 source samples.
  const stride = Math.max(1, Math.ceil(points.length / (cap * 4)));
  const seen = new Set();
  const inv = 1 / Math.max(0.01, cellSize);
  const verts = [];
  for (let i = 0; i < points.length && verts.length < cap; i += stride) {
    const p = points[i];
    const x = Number(p.pos_x ?? p.x);
    const y = Number(p.pos_y ?? p.y);
    const z = Number(p.pos_z ?? p.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const key = `${Math.round(x * inv)}:${Math.round(y * inv)}:${Math.round(z * inv)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verts.push({ x, y, z });
  }
  return verts;
}

function ensureHeatCanvas() {
  heatCanvas =
    hostEl?.querySelector('#matterport-heat-overlay') ||
    document.getElementById('matterport-heat-overlay') ||
    heatCanvas;
  if (!heatCanvas && hostEl) {
    const heat = document.createElement('canvas');
    heat.id = 'matterport-heat-overlay';
    heat.className = 'matterport-heat-overlay';
    heat.setAttribute('aria-hidden', 'true');
    const sceneOverlay = hostEl.querySelector('#matterport-scene-overlay');
    if (sceneOverlay) sceneOverlay.after(heat);
    else if (iframeEl) iframeEl.after(heat);
    else hostEl.appendChild(heat);
    heatCanvas = heat;
  }
  return heatCanvas;
}

function clearAnnotCanvas() {
  if (!heatCanvas) return;
  const ctx = heatCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, heatCanvas.width, heatCanvas.height);
  if (!heatWorldPoints.length && !navWorldPoints.length) {
    heatCanvas.classList.remove('is-active');
  }
}

let annotDrawRaf = 0;
let annotIdleTimer = 0;
let annotThrottleTimer = 0;
let lastAnnotDrawMs = 0;
let annotGeneration = 0;

/**
 * Coalesce redraws. While the camera moves, paint a light preview;
 * after settle, paint the full heat set — never blocks input.
 * @param {{ moving?: boolean, force?: boolean }} [opts]
 */
function scheduleAnnotDraw(opts = {}) {
  const moving = Boolean(opts.moving);
  const force = Boolean(opts.force);
  const profile = overlayPerfProfile();

  if (moving && !force) {
    clearTimeout(annotIdleTimer);
    annotIdleTimer = setTimeout(() => {
      scheduleAnnotDraw({ force: true });
    }, profile.idleSettleMs);

    if (annotDrawRaf || annotThrottleTimer) return;
    const now = performance.now();
    const gap = profile.movingMinGapMs - (now - lastAnnotDrawMs);
    const runLight = () => {
      annotThrottleTimer = 0;
      if (annotDrawRaf) return;
      annotDrawRaf = requestAnimationFrame(() => {
        annotDrawRaf = 0;
        lastAnnotDrawMs = performance.now();
        drawAnnotOverlay2d({ light: true });
      });
    };
    if (gap > 0) {
      annotThrottleTimer = setTimeout(runLight, gap);
    } else {
      runLight();
    }
    return;
  }

  if (annotDrawRaf) return;
  annotDrawRaf = requestAnimationFrame(() => {
    annotDrawRaf = 0;
    lastAnnotDrawMs = performance.now();
    drawAnnotOverlay2d({ light: false });
  });
}

/**
 * Single 2D pass: navigation route + heat dots.
 * `light` mode skips most heat projections so orbit stays smooth.
 * @param {{ light?: boolean }} [opts]
 */
function drawAnnotOverlay2d(opts = {}) {
  const light = Boolean(opts.light);
  const canvas = ensureHeatCanvas();
  if (!canvas || !active) return;
  if (!heatWorldPoints.length && !navWorldPoints.length) {
    clearAnnotCanvas();
    return;
  }
  const pose = lastCameraPose;
  if (!pose || !mpSdk) return;

  canvas.classList.add('is-active');

  const profile = overlayPerfProfile();
  const size = matterportShowcaseSize();
  const dpr = Math.min(window.devicePixelRatio || 1, profile.dprCap);
  const cssW = size.w;
  const cssH = size.h;
  if (cssW < 2 || cssH < 2) return;

  const bufW = Math.max(1, Math.round(cssW * dpr));
  const bufH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== bufW || canvas.height !== bufH) {
    canvas.width = bufW;
    canvas.height = bufH;
  }

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (
    typeof mpSdk.Conversion?.worldToScreen !== 'function' &&
    typeof mpSdk.Renderer?.worldToScreen !== 'function'
  ) {
    return;
  }

  /** @param {{ x: number, y: number, z: number }} v */
  const project = (v) => {
    const scr = matterportWorldToScreen(v, pose);
    if (!scr || !Number.isFinite(scr.x) || !Number.isFinite(scr.y)) return null;
    if (Number.isFinite(scr.z) && scr.z < 0) return null;
    if (scr.x < -40 || scr.y < -40 || scr.x > cssW + 40 || scr.y > cssH + 40) return null;
    return scr;
  };

  // Ribbon edges are projected individually and must survive leaving the
  // viewport — culling one edge would tear a hole in the band.
  const projectRaw = (v) => {
    const scr = matterportWorldToScreen(v, pose);
    if (!scr || !Number.isFinite(scr.x) || !Number.isFinite(scr.y)) return null;
    if (Number.isFinite(scr.z) && scr.z < 0) return null;
    return scr;
  };

  if (navWorldPoints.length >= 2) {
    // Round waypoint dots rather than one stroked line: each dot is a step on
    // the floor, and sizing them by camera distance is what sells them as lying
    // on the ground instead of floating on the glass.
    const camPos = pose?.position ?? null;

    // Window onto the route, anchored where the viewer stands. Matching on X/Z
    // only: the camera is at eye height while the dots are on the floor, so a
    // 3D distance would always pick the wrong point.
    let startIdx = 0;
    if (camPos) {
      let bestD = Infinity;
      for (let i = 0; i < navWorldPoints.length; i += 1) {
        const wp = navWorldPoints[i];
        const d = (wp.x - camPos.x) ** 2 + (wp.z - camPos.z) ** 2;
        if (d < bestD) {
          bestD = d;
          startIdx = i;
        }
      }
      // One dot behind, so the trail passes through your feet rather than
      // starting abruptly in front of you.
      startIdx = Math.max(0, startIdx - 1);
    }

    // The window is measured in SCAN POINTS, not dots: connectors only exist to
    // join them, so counting them would shrink the visible run to a metre or two.
    // Window measured in METRES walked, not point count: the route is drawn as
    // a continuous band now, so "how far ahead can I see" is the thing that
    // matters, and it stays constant whatever the point spacing happens to be.
    let endIdx = navWorldPoints.length;
    let run = 0;
    for (let i = startIdx + 1; i < navWorldPoints.length; i += 1) {
      const a = navWorldPoints[i - 1];
      const b = navWorldPoints[i];
      run += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (run > ROUTE_VISIBLE_M) {
        endIdx = i;
        break;
      }
    }
    const reachedEnd = endIdx >= navWorldPoints.length;

    // Flatten onto the floor you are standing on. Sweep heights jitter by a few
    // centimetres (tripod, operator), which makes the dots bob instead of
    // reading as a path lying on a plane. Dots more than a floor apart keep
    // their own height, so stairs and upper levels still separate correctly.
    const camFloorY = camPos ? camPos.y - SWEEP_EYE_HEIGHT_M : null;
    const SAME_FLOOR_M = 1.2;

    // Collect the visible run as floor-plane points, split into strips wherever
    // the trail must not be joined up (stairs).
    const strips = [];
    let cur = [];
    for (let i = startIdx; i < endIdx; i += 1) {
      const wp = navWorldPoints[i];
      const ownFloorY = wp.y + navYOffset;
      const onSameFloor =
        camFloorY !== null && Math.abs(ownFloorY - camFloorY) < SAME_FLOOR_M;
      const planeY = onSameFloor ? camFloorY : ownFloorY;
      if (wp.breakBefore && cur.length) {
        strips.push(cur);
        cur = [];
      }
      cur.push({ x: wp.x, y: planeY + NAV_DOT_HEIGHT_M, z: wp.z });
    }
    if (cur.length) strips.push(cur);

    const camDist = (q) =>
      camPos ? Math.hypot(q.x - camPos.x, q.y - camPos.y, q.z - camPos.z) : 6;

    /**
     * Build one ribbon: offset each point sideways by a fixed width in WORLD
     * metres, then project both edges. Offsetting in world space (rather than
     * stroking a fixed pixel width) is what makes the band lie on the floor and
     * taper naturally with distance.
     */
    const ribbonPath = (pts) => {
      if (pts.length < 2) return null;
      const left = [];
      const right = [];
      for (let i = 0; i < pts.length; i += 1) {
        const prev = pts[i - 1] ?? pts[i];
        const next = pts[i + 1] ?? pts[i];
        let dx = next.x - prev.x;
        let dz = next.z - prev.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        dx /= len;
        dz /= len;
        // Perpendicular on the floor plane.
        const px = -dz * ROUTE_HALF_WIDTH_M;
        const pz = dx * ROUTE_HALF_WIDTH_M;
        const l = projectRaw({ x: pts[i].x + px, y: pts[i].y, z: pts[i].z + pz });
        const r = projectRaw({ x: pts[i].x - px, y: pts[i].y, z: pts[i].z - pz });
        if (!l || !r) continue;
        left.push(l);
        right.push(r);
      }
      if (left.length < 2) return null;
      return { left, right };
    };

    if (strips.length) {
      ctx.save();
      // Farthest strip first, so nearer stretches draw over it.
      strips.sort((a, b) => camDist(b[0]) - camDist(a[0]));

      if (ROUTE_STYLE === 'dots') {
        // Discrete markers, sized by camera distance so they read as sitting on
        // the floor. Drawn farthest-first within each strip for correct overlap.
        const dotRadius = (d) => Math.max(4, Math.min(16, 46 / Math.max(1.2, d)));
        const dots = [];
        for (const strip of strips) {
          for (const q of strip) {
                const scr = project(q);
            if (scr) dots.push({ x: scr.x, y: scr.y, d: camDist(q), label: q.label });
          }
        }
        dots.sort((a, b) => b.d - a.d);
        for (const dot of dots) {
          const r = dotRadius(dot.d);
          ctx.beginPath();
          ctx.arc(dot.x, dot.y, r + 1.2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(220, 38, 38, 0.95)';
          ctx.fill();
        }

        // Scan numbers, drawn after every dot so no dot can cover a label.
        // Only points that carry one are labelled, and only when near enough
        // for the text to be legible.
        for (const dot of dots) {
          if (dot.label == null || dot.d > NAV_LABEL_MAX_DIST_M) continue;
          const size = Math.max(10, Math.min(16, dotRadius(dot.d) * 1.15));
          const text = String(dot.label);
          ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const ty = dot.y - dotRadius(dot.d) - size * 0.85;
          const w = ctx.measureText(text).width;
          // Pill behind the number keeps it readable over any floor.
          const padX = size * 0.4;
          const h = size * 1.35;
          ctx.beginPath();
          ctx.roundRect(dot.x - w / 2 - padX, ty - h / 2, w + padX * 2, h, h / 2);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(text, dot.x, ty);
        }
      } else {
        for (const strip of strips) {
          const band = ribbonPath(strip);
          if (!band) continue;
          const { left, right } = band;

          ctx.beginPath();
          ctx.moveTo(left[0].x, left[0].y);
          for (let i = 1; i < left.length; i += 1) ctx.lineTo(left[i].x, left[i].y);
          for (let i = right.length - 1; i >= 0; i -= 1) ctx.lineTo(right[i].x, right[i].y);
          ctx.closePath();

          ctx.fillStyle = 'rgba(220, 38, 38, 0.9)';
          ctx.fill();
          // Thin light edge keeps the band readable on dark and light floors.
          ctx.lineJoin = 'round';
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.stroke();
        }
      }

      // Endpoints, drawn last so they sit above the band.
      const radiusFor = (d) => Math.max(4, Math.min(16, 46 / Math.max(1.2, d)));
      const drawEnd = (world, color) => {
        const scr = project(world);
        if (!scr) return;
        const r = Math.max(5, radiusFor(camDist(world)) + 3);
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, r + 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      };
      const firstStrip = strips.find((st) => st.length);
      const lastStrip = strips[strips.length - 1];
      if (startIdx === 0 && firstStrip) drawEnd(firstStrip[0], '#22c55e');
      if (reachedEnd && lastStrip?.length) {
        drawEnd(lastStrip[lastStrip.length - 1], '#7f1d1d');
      }
      ctx.restore();
    }
  }

  if (!heatWorldPoints.length) return;

  const heatLimit = light
    ? Math.min(heatWorldPoints.length, profile.movingHeatMax)
    : heatWorldPoints.length;
  const stride = light
    ? Math.max(1, Math.ceil(heatWorldPoints.length / heatLimit))
    : heatWorldPoints.length > 300
      ? 2
      : 1;
  const radius = light ? 2 : Math.max(2, Math.min(3.5, Math.min(cssW, cssH) * 0.0032));
  const sizePx = radius * 2;
  ctx.fillStyle = 'rgba(249, 115, 22, 0.88)';

  const t0 = performance.now();
  let drawn = 0;
  for (let i = 0; i < heatWorldPoints.length; i += stride) {
    if (drawn >= heatLimit) break;
    if (performance.now() - t0 > profile.drawBudgetMs) break;
    const scr = project(heatWorldPoints[i]);
    if (!scr) continue;
    // fillRect is far cheaper than arc() for dense clouds
    ctx.fillRect(scr.x - radius, scr.y - radius, sizePx, sizePx);
    drawn += 1;
  }
}

/**
 * Default to dollhouse; fit is deferred so UI never waits on lookAt.
 * @param {{ forceDollhouse?: boolean, fitPoints?: Array<{ x: number, y: number, z: number }> }} [opts]
 */
async function preferDollhouseForOverlay(opts = {}) {
  const force = opts.forceDollhouse !== false;
  if (force && currentViewMode !== 'dollhouse') {
    await matterportSetViewMode('dollhouse');
  }
  scheduleAnnotDraw({ force: true });
  // Fit in background — don't await (prevents hang on Show navigation / heat).
  if (opts.fitPoints?.length) {
    const fitSample = downsamplePolyline(opts.fitPoints, 48);
    void matterportFitWorldPoints(fitSample, { alreadyDollhouse: true }).then(() => {
      scheduleAnnotDraw({ force: true });
    });
  } else {
    void refreshMatterportCameraPose(0).then(() => scheduleAnnotDraw({ force: true }));
  }
}

/**
 * Frame dollhouse camera so world points fit on screen (Camera.lookAt + distance from bounds).
 * @param {Array<{ x: number, y: number, z: number }>} points
 * @param {{ alreadyDollhouse?: boolean, padding?: number }} [opts]
 */
export async function matterportFitWorldPoints(points, opts = {}) {
  if (!active || !mpSdk?.Camera?.lookAt || !points?.length) {
    return { ok: false, error: 'Cannot fit view' };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let count = 0;
  // Bounds from a sparse sample only
  const step = Math.max(1, Math.ceil(points.length / 64));
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const x = Number(p.x ?? p.pos_x);
    const y = Number(p.y ?? p.pos_y);
    const z = Number(p.z ?? p.pos_z);
    if (![x, y, z].every(Number.isFinite)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    count += 1;
  }
  if (!count) return { ok: false, error: 'No valid points to fit' };

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const sx = Math.max(0.5, maxX - minX);
  const sy = Math.max(0.5, maxY - minY);
  const sz = Math.max(0.5, maxZ - minZ);
  const horiz = Math.hypot(sx, sz);
  const diag = Math.hypot(horiz, sy);
  const padding = Number.isFinite(opts.padding) ? opts.padding : 1.35;
  const dist = Math.max(3.5, (diag * 0.5 * padding) / Math.tan((55 * Math.PI) / 360));

  if (!opts.alreadyDollhouse) {
    await matterportSetViewMode('dollhouse');
  }

  const ModeEnum = mpSdk.Mode?.Mode || {};
  const dollhouse = ModeEnum.DOLLHOUSE || 'mode.dollhouse';
  const fly =
    mpSdk.Camera?.TransitionType?.INSTANT ||
    mpSdk.Camera?.TransitionType?.FLY ||
    'transition.instant';

  const offset = {
    x: dist * 0.42,
    y: Math.max(dist * 0.72, sy * 1.1 + 2.5),
    z: dist * 0.55,
  };

  try {
    await mpSdk.Camera.lookAt(
      { x: cx, y: cy, z: cz },
      { mode: dollhouse, transition: fly, offset },
    );
  } catch (err) {
    console.warn('[space-map] fit lookAt failed', err);
    return { ok: false, error: err?.message || 'lookAt failed' };
  }

  await refreshMatterportCameraPose(40);
  scheduleAnnotDraw({ force: true });
  return { ok: true, center: { x: cx, y: cy, z: cz }, dist };
}

/**
 * Progressive heat load — paint a preview first, then the full sample.
 * Stays in the current Showcase mode (walkthrough / dollhouse / floor plan).
 * @param {Array<{ x: number, y: number, z: number }>} sampled
 */
async function showHeatWorldPoints(sampled) {
  const gen = ++annotGeneration;
  if (heatmapOverlay) {
    disposeMpObject3D(heatmapOverlay);
    heatmapOverlay = null;
  }
  if (userTrailOverlay) {
    disposeMpObject3D(userTrailOverlay);
    userTrailOverlay = null;
  }
  heatTrailTagIds = [];

  ensureHeatCanvas();
  // Instant preview so UI never feels stuck on large trails.
  const previewN = currentViewMode === 'inside' ? 48 : 80;
  heatWorldPoints = sampled.slice(0, Math.min(previewN, sampled.length));
  scheduleAnnotDraw({ force: true });

  // Refresh pose only — do not yank into dollhouse (walkthrough must keep heat).
  void refreshMatterportCameraPose(0).then(() => {
    if (gen !== annotGeneration) return;
    scheduleAnnotDraw({ force: true });
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  if (gen !== annotGeneration) return;
  heatWorldPoints = sampled;
  scheduleAnnotDraw({ force: true });
}

/**
 * Combined heat map — orange XYZ dots (exact Y), screen-projected.
 * Works in walkthrough (inside), dollhouse, and floor plan.
 * @param {Array<{ pos_x: number, pos_y: number, pos_z: number }> | null} points
 */
export async function setMatterportHeatmapOverlay(points) {
  if (!active) return { ok: false, error: 'Space map is not active' };
  await clearMatterportUserTrailOverlay();
  if (!points?.length) {
    heatWorldPoints = [];
    scheduleAnnotDraw({ force: true });
    return { ok: true, empty: true };
  }
  // Yield so the click/UI can paint before we sample.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sampled = normalizeHeatWorldPoints(points);
  if (!sampled.length) return { ok: false, error: 'No heat map points to show' };
  await showHeatWorldPoints(sampled);
  return { ok: true, count: sampled.length };
}

export async function clearMatterportHeatmapOverlay() {
  if (heatmapOverlay) {
    disposeMpObject3D(heatmapOverlay);
    heatmapOverlay = null;
  }
  await clearMatterportUserTrailOverlay();
  return { ok: true };
}

/**
 * Per-user XYZ heat on Matterport — orange points at exact recorded positions.
 * Visible in walkthrough and dollhouse via 2D projection (no mode switch).
 * @param {Array<{ pos_x?: number, pos_y?: number, pos_z?: number, x?: number, y?: number, z?: number }> | null} points
 * @param {{ maxPoints?: number }} [opts]
 */
export async function setMatterportUserTrailOverlay(points, opts = {}) {
  if (!active || !mpSdk) return { ok: false, error: 'Space map is not active' };

  if (heatmapOverlay) {
    disposeMpObject3D(heatmapOverlay);
    heatmapOverlay = null;
  }
  await clearMatterportUserTrailOverlay();

  if (!points?.length) return { ok: true, empty: true };

  await new Promise((resolve) => setTimeout(resolve, 0));
  const sampled = normalizeHeatWorldPoints(points, opts.maxPoints);
  if (!sampled.length) return { ok: false, error: 'No valid XYZ points for this user' };

  await showHeatWorldPoints(sampled);
  return { ok: true, count: sampled.length };
}

export async function clearMatterportUserTrailOverlay() {
  annotGeneration += 1;
  if (annotIdleTimer) {
    clearTimeout(annotIdleTimer);
    annotIdleTimer = 0;
  }
  if (annotThrottleTimer) {
    clearTimeout(annotThrottleTimer);
    annotThrottleTimer = 0;
  }
  if (annotDrawRaf) {
    cancelAnimationFrame(annotDrawRaf);
    annotDrawRaf = 0;
  }
  if (heatTrailTagIds.length && mpSdk?.Tag?.remove) {
    const ids = heatTrailTagIds.slice();
    heatTrailTagIds = [];
    try {
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await mpSdk.Tag.remove(...ids.slice(i, i + CHUNK));
      }
    } catch {
      /* */
    }
  } else {
    heatTrailTagIds = [];
  }
  if (userTrailOverlay) {
    disposeMpObject3D(userTrailOverlay);
    userTrailOverlay = null;
  }
  heatWorldPoints = [];
  scheduleAnnotDraw({ force: true });
  return { ok: true };
}

/**
 * Draw a navigation route on Matterport as a fast 2D polyline (mesh pathfind stays hidden).
 * Dollhouse by default; stays visible in explore when the camera mode changes.
 * @param {Array<{ x: number, y: number, z: number }> | null} points
 * @param {{ color?: number }} [opts]
 */

export async function setMatterportNavRouteOverlay(points, _opts = {}) {
  // 'sweeps' routes come from camera positions and must be dropped to the floor.
  navYOffset = _opts.source === 'sweeps' ? -SWEEP_EYE_HEIGHT_M : 0;
  if (!active) return { ok: false, error: 'Space map is not active' };
  if (navRouteOverlay) {
    disposeMpObject3D(navRouteOverlay);
    navRouteOverlay = null;
  }
  if (!points?.length) {
    navWorldPoints = [];
    scheduleAnnotDraw({ force: true });
    return { ok: true, empty: true };
  }

  const labels = Array.isArray(_opts.labels) ? _opts.labels : null;
  const verts = [];
  points.forEach((p, i) => {
    const x = Number(p.x ?? p.pos_x);
    const y = Number(p.y ?? p.pos_y);
    const z = Number(p.z ?? p.pos_z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      const label = labels?.[i];
      verts.push(label == null ? { x, y, z } : { x, y, z, label });
    }
  });
  if (verts.length < 2) return { ok: false, error: 'Route needs at least 2 points' };

  const profile = overlayPerfProfile();
  // Sweep routes keep their scan positions as ANCHORS — those are the points you
  // can actually stand on, and the dots must land on the scan rings. But sweeps
  // sit 2-4 m apart, so anchors alone read as disconnected dots. Fill the gaps
  // with smaller connector dots along each segment: consecutive anchors are
  // graph neighbours, so the straight line between them is genuinely walkable.
  // Every mode renders the same way: resample the route polyline at one fixed
  // spacing, every dot the same size. Camera-point and hybrid routes still
  // TRAVEL scan point to scan point — the scan points remain vertices of this
  // polyline — but the dots are placed evenly along it rather than clustering
  // on the scan positions, which is what made those modes look different from
  // the navmesh view.
  navWorldPoints = resamplePolylineEven(
    verts,
    NAV_DOT_SPACING_M,
    Math.max(profile.navCap, 320),
  ).map((pt) => ({ ...pt, anchor: true }));

  ensureHeatCanvas();
  scheduleAnnotDraw({ force: true });
  // Walkthrough routes must stay in walkthrough: yanking the camera to dollhouse
  // is exactly what breaks the "standing in the space" feel. Opt in explicitly.
  const forceDollhouse = _opts.forceDollhouse === true;
  void preferDollhouseForOverlay({
    forceDollhouse,
    fitPoints: forceDollhouse ? navWorldPoints : undefined,
  });
  return { ok: true, count: navWorldPoints.length };
}

/**
 * Cost of one hop between neighbouring scan points.
 *
 * Deliberately superlinear in distance. Matterport's neighbour graph contains
 * long-range links that skip right over intermediate scan points, and with a
 * plain Euclidean cost a single long hop ties with (or beats) the chain of
 * short hops that follows the same line — so the walkthrough teleports past
 * scan points you should have walked through. Raising distance to a power
 * makes two short hops cheaper than one long one covering the same ground,
 * which biases the search towards visiting every scan point on the way.
 */
const HOP_EXPONENT = 1.35;
function hopCost(a, b) {
  let cost = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) ** HOP_EXPONENT;
  const dy = Math.abs(a.y - b.y);
  if (dy > 0.35 && stairChains.length > 0) {
    let inSameChain = false;
    for (const chain of stairChains) {
      if (chain.includes(a.id) && chain.includes(b.id)) {
        inSameChain = true;
        break;
      }
    }
    if (!inSameChain) {
      cost += 10000;
    }
  }
  return cost;
}

/**
 * Re-insert scan points that the route stepped over.
 *
 * Even with the hop bias, a direct neighbour link can still win over a detour.
 * This walks each consecutive pair and splices back any scan point that lies
 * in the corridor between them, so the camera stops at every scan point in the
 * route's zone instead of jumping.
 *
 * A candidate must be a genuine graph neighbour of both ends — inserting a
 * point that is merely nearby would invent a step Matterport cannot actually
 * move through.
 *
 * @param {string[]} ids route as sweep ids
 * @param {Map<string, object>} byId sweep lookup
 * @param {number} corridorM how far off the segment still counts as "on the way"
 * @param {Set<string>} [exclude] sweeps that must never be spliced back in —
 *   hybrid passes its off-navmesh set here, so filling a gap can never undo
 *   the navmesh check that deliberately routed around those points
 */
function insertSkippedSweeps(ids, byId, corridorM = 1.6, exclude = null) {
  if (ids.length < 2) return ids;
  const maxR2 = corridorM * corridorM;

  // A few passes, because filling one gap can expose another.
  let route = ids.slice();
  for (let pass = 0; pass < 3; pass += 1) {
    const out = [route[0]];
    let added = 0;

    for (let i = 1; i < route.length; i += 1) {
      const u = byId.get(route[i - 1]);
      const v = byId.get(route[i]);
      if (!u || !v) {
        out.push(route[i]);
        continue;
      }
      // Leave level changes alone. This inserts by proximity to the straight
      // line between two points, which has no notion of climb order — on a
      // staircase it happily splices the point above the target in before it,
      // producing 176 → 178 → 177. Stair hops are repaired later by a planner
      // that walks them in height order.
      if (Math.abs(v.y - u.y) > FLOOR_STEP_M) {
        out.push(route[i]);
        continue;
      }
      const onRoute = new Set(route);
      const between = [];

      for (const cand of byId.values()) {
        if (onRoute.has(cand.id)) continue;
        if (exclude?.has(cand.id)) continue;
        // Must be walkable from both ends, or the inserted step is fictional.
        if (!u.neighbors?.includes(cand.id) || !cand.neighbors?.includes(v.id)) continue;
        if (pointSegDistSq(cand, u, v) > maxR2) continue;

        // Keep only candidates that actually lie between u and v, ordered by
        // how far along the segment they sit.
        const ax = v.x - u.x;
        const ay = v.y - u.y;
        const az = v.z - u.z;
        const len2 = ax * ax + ay * ay + az * az;
        if (len2 <= 1e-9) continue;
        const t = ((cand.x - u.x) * ax + (cand.y - u.y) * ay + (cand.z - u.z) * az) / len2;
        if (t <= 0.02 || t >= 0.98) continue;
        between.push({ id: cand.id, t });
      }

      between.sort((a, b) => a.t - b.t);
      for (const b of between) {
        out.push(b.id);
        added += 1;
      }
      out.push(route[i]);
    }

    route = out;
    if (!added) break;
  }
  return route;
}

/**
 * Leg planner for a level change: cover as many scan points as possible.
 *
 * Minimising distance skips stairs; minimising the largest climb is better but
 * still free to pick a two-hop route over the six-hop flight that actually
 * exists. What a staircase demands is the opposite objective — walk through
 * every scan point on the way up.
 *
 * Restricting the search to points whose height lies between the two ends, and
 * only allowing steps that progress in the direction of travel, makes the
 * search space a DAG. Longest-path-by-node-count is then exact in one pass in
 * height order, with total distance capped so it cannot wander off the flight.
 *
 * @param {object} u start sweep
 * @param {object} v end sweep
 * @param {Map<string, object>} byId
 * @param {number} maxDist total distance budget for the leg
 * @returns {string[]} intermediate + end ids, or [] when unreachable
 */
function planLegMostScanPoints(u, v, byId, maxDist) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const dir = v.y >= u.y ? 1 : -1;
  // Stay inside the flight: a small margin absorbs landings sitting level with
  // the floor above or below.
  const loY = Math.min(u.y, v.y) - 0.3;
  const hiY = Math.max(u.y, v.y) + 0.3;

  const nodes = [];
  for (const n of byId.values()) {
    if (n.y >= loY && n.y <= hiY) nodes.push(n);
  }
  // Order along the direction of travel; ties broken by id so the order is
  // total and the edge relation below is acyclic.
  nodes.sort((a, b) => dir * (a.y - b.y) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rank = new Map(nodes.map((n, i) => [n.id, i]));
  if (!rank.has(u.id) || !rank.has(v.id)) return [];

  const best = new Map([[u.id, { count: 0, dist: 0, prev: undefined }]]);
  for (const n of nodes) {
    const cur = best.get(n.id);
    if (!cur) continue;
    for (const nId of n.neighbors ?? []) {
      const nb = byId.get(nId);
      if (!nb || !rank.has(nId)) continue;
      // Forward only — this is what keeps the search a DAG.
      if (rank.get(nId) <= rank.get(n.id)) continue;
      const d = cur.dist + dist(n, nb);
      if (d > maxDist) continue;
      const cand = { count: cur.count + 1, dist: d, prev: n.id };
      const ex = best.get(nId);
      if (!ex || cand.count > ex.count || (cand.count === ex.count && cand.dist < ex.dist)) {
        best.set(nId, cand);
      }
    }
  }

  if (!best.has(v.id)) return [];
  const leg = [];
  for (let id = v.id; id !== undefined && id !== u.id; id = best.get(id)?.prev) {
    leg.unshift(id);
    if (leg.length > nodes.length) return [];
  }
  return leg;
}

/**
 * Declared staircases, as ordered runs of scan-point indices (Sweep.data order),
 * lowest step first. Set with setMatterportStairChains().
 *
 * Inferring a flight from geometry gets most of the way but not all: two points
 * at the top of a flight can differ in height by a centimetre, which is not
 * enough to order them, and a graph full of skip links offers many plausible
 * ways up. A declared chain removes the ambiguity — these are the steps, in
 * this order.
 *
 * @type {string[][]} resolved to sweep ids
 */
let stairChains = [];

/**
 * Declare the staircases of the current space.
 *
 * @param {number[][]} chainsOfIndices runs of Sweep.data indices, lowest first
 * @returns {Promise<{ok:boolean, chains?:number, error?:string}>}
 */
export async function setMatterportStairChains(chainsOfIndices) {
  const listed = await matterportListSweeps();
  if (!listed.ok) return { ok: false, error: listed.error };
  const sweeps = listed.sweeps;
  const out = [];
  for (const chain of chainsOfIndices ?? []) {
    const ids = [];
    for (const i of chain) {
      const sw = sweeps[i];
      if (sw) ids.push(sw.id);
    }
    if (ids.length >= 2) out.push(ids);
  }
  stairChains = out;
  return { ok: true, chains: out.length };
}

/**
 * Fill in every step of any declared staircase the route touches.
 *
 * Only the span the route already uses is rewritten: from the first declared
 * step it visits to the last, in chain order. That covers the gaps without
 * inventing a detour up a staircase the route was never on, and because the
 * steps of a chain are consecutive neighbours the result stays a valid walk.
 *
 * @param {string[]} ids route as sweep ids
 * @param {Map<string, object>} byId
 * @returns {string[]}
 */
function applyStairChains(ids, byId) {
  if (!stairChains.length || ids.length < 2) return ids;
  let route = ids.slice();

  for (const chain of stairChains) {
    const pos = new Map(chain.map((id, i) => [id, i]));
    const hits = [];
    route.forEach((id, i) => {
      if (pos.has(id)) hits.push(i);
    });
    if (hits.length < 2) continue;

    const first = hits[0];
    const lastIdx = hits[hits.length - 1];
    // Widest span of the flight the route actually touches.
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of hits) {
      const p = pos.get(route[i]);
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    if (hi - lo < 1) continue;

    const ascending = pos.get(route[first]) <= pos.get(route[lastIdx]);
    const run = chain.slice(lo, hi + 1);
    const ordered = ascending ? run : run.slice().reverse();

    // The seams must be real neighbour links, or we would invent a step.
    const before = route[first - 1];
    const after = route[lastIdx + 1];
    const head = byId.get(ordered[0]);
    const tail = byId.get(ordered[ordered.length - 1]);
    if (!head || !tail) continue;
    if (before && !(byId.get(before)?.neighbors ?? []).includes(ordered[0])) continue;
    if (after && !(tail.neighbors ?? []).includes(after)) continue;

    route = [...route.slice(0, first), ...ordered, ...route.slice(lastIdx + 1)];
  }
  return collapseLoops(route);
}

/**
 * Replace hops that jump over walkable ground with the walk itself.
 *
 * Dijkstra returns a valid path through Matterport's neighbour graph, but the
 * graph contains long-range links — most damagingly across a stairwell, where
 * the bottom and top landings are neighbours. Cost tuning alone cannot be
 * trusted to reject those: an uploaded navmesh that misses the stairs makes
 * every stair sweep expensive, and the teleport becomes the cheap option.
 *
 * So this checks the geometry directly. For every long hop it re-plans that
 * single leg on pure distance — no navmesh penalty, no exclusions — and takes
 * the result whenever it visits more scan points without being materially
 * longer. Climbing a staircase is barely longer than the chord across it, so
 * the real walk wins and the teleport disappears.
 *
 * @param {string[]} ids route as sweep ids
 * @param {Map<string, object>} byId sweep lookup
 * @returns {string[]} route with teleports expanded into walks
 */
const TELEPORT_HOP_M = 2.5;
const TELEPORT_DETOUR_MAX = 1.35;
/**
 * Steepest rise/run a person can actually walk. Real stair flights sit around
 * 0.5–0.9; anything above this is not a surface, it is a hole in the graph.
 */
/** Minimum height change before a hop is treated as crossing levels. */
const FLOOR_STEP_M = 0.35;
/**
 * Detour budget for a hop that changes level. Generous on purpose: a staircase
 * walked step by step is far longer than the chord across the stairwell, and
 * switchbacks are longer still.
 */
const LEVEL_CHANGE_DETOUR_MAX = 8;
/**
 * A level-change detour is rejected if its largest climb is worse than the
 * direct hop's by more than this factor. Deliberately near 1: on a real flight
 * the step that replaces a skip often climbs almost exactly as much (a 1.28 m
 * skip replaced by a 1.29 m step), and demanding a big improvement threw away
 * the very scan points we are trying to recover. Detours that merely wander are
 * caught by the look-ahead rule instead.
 */
const LEVEL_CHANGE_IMPROVEMENT = 1.05;

/**
 * Shortest path for one leg, on plain distance, excluding the direct u→v link.
 * @returns {string[]} intermediate + end ids, or [] when unreachable
 */
function planLegByDistance(u, v, byId) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const best = new Map([[u.id, 0]]);
  const prev = new Map();
  const seen = new Set();
  for (;;) {
    let curId = null;
    let curCost = Infinity;
    for (const [id, c] of best) {
      if (!seen.has(id) && c < curCost) {
        curCost = c;
        curId = id;
      }
    }
    if (curId === null || curId === v.id) break;
    seen.add(curId);
    const cur = byId.get(curId);
    if (!cur) continue;
    for (const nId of cur.neighbors ?? []) {
      if (seen.has(nId)) continue;
      const nb = byId.get(nId);
      if (!nb) continue;
      if (curId === u.id && nId === v.id) continue;
      const c = curCost + dist(cur, nb);
      if (c < (best.get(nId) ?? Infinity)) {
        best.set(nId, c);
        prev.set(nId, curId);
      }
    }
  }
  if (!best.has(v.id)) return [];
  const leg = [];
  for (let id = v.id; id !== undefined && id !== u.id; id = prev.get(id)) leg.unshift(id);
  return leg;
}

/**
 * Stair-aware leg planner: minimise the LARGEST single climb, then distance.
 *
 * Matterport's neighbour graph links the bottom of a flight straight to points
 * part-way up and to the landing above — real links, and each is shorter than
 * walking the steps. Any distance-based search therefore skips scan points on
 * the stairs, however the cost is shaped: excluding the worst link just makes
 * it take the next-shortest skip.
 *
 * Minimising the biggest rise instead expresses what climbing stairs actually
 * is: take them one step at a time. On a flight scanned every few steps this
 * recovers the full chain in order, because any shortcut necessarily contains a
 * single larger climb than the steps it bypasses.
 *
 * Labels compare lexicographically: (largest rise on the path, total distance).
 *
 * @returns {string[]} intermediate + end ids, or [] when unreachable
 */
function planLegByLeastClimb(u, v, byId) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const better = (a, b) => {
    if (!b) return true;
    if (Math.abs(a.rise - b.rise) > 1e-6) return a.rise < b.rise;
    return a.dist < b.dist;
  };
  const best = new Map([[u.id, { rise: 0, dist: 0 }]]);
  const prev = new Map();
  const seen = new Set();
  for (;;) {
    let curId = null;
    let curLabel = null;
    for (const [id, label] of best) {
      if (seen.has(id)) continue;
      if (better(label, curLabel)) {
        curLabel = label;
        curId = id;
      }
    }
    if (curId === null || curId === v.id) break;
    seen.add(curId);
    const cur = byId.get(curId);
    if (!cur) continue;
    for (const nId of cur.neighbors ?? []) {
      if (seen.has(nId)) continue;
      const nb = byId.get(nId);
      if (!nb) continue;
      if (curId === u.id && nId === v.id) continue;
      const label = {
        rise: Math.max(curLabel.rise, Math.abs(nb.y - cur.y)),
        dist: curLabel.dist + dist(cur, nb),
      };
      if (better(label, best.get(nId) ?? null)) {
        best.set(nId, label);
        prev.set(nId, curId);
      }
    }
  }
  if (!best.has(v.id)) return [];
  const leg = [];
  for (let id = v.id; id !== undefined && id !== u.id; id = prev.get(id)) leg.unshift(id);
  return leg;
}

function repairTeleports(ids, byId) {
  if (ids.length < 2) return ids;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const out = [ids[0]];
  for (let i = 1; i < ids.length; i += 1) {
    const u = byId.get(ids[i - 1]);
    const v = byId.get(ids[i]);
    if (!u || !v) {
      out.push(ids[i]);
      continue;
    }
    const direct = dist(u, v);
    const dy = Math.abs(v.y - u.y);
    // Any real height change means stairs (or a lift), where the straight line
    // between two scan points cuts through the structure.
    const crossesLevels = dy > FLOOR_STEP_M;
    if (!crossesLevels && direct <= TELEPORT_HOP_M) {
      out.push(ids[i]);
      continue;
    }

    const detourBudget = direct * (crossesLevels ? LEVEL_CHANGE_DETOUR_MAX : TELEPORT_DETOUR_MAX);
    // On stairs, cover every scan point; fall back to least-climb if the
    // height-ordered search finds nothing (e.g. a lift, where the ends are not
    // joined by a walkable run at all).
    let leg = [];
    if (crossesLevels) {
      leg = planLegMostScanPoints(u, v, byId, detourBudget);
      if (leg.length <= 1) leg = planLegByLeastClimb(u, v, byId);
    } else {
      leg = planLegByDistance(u, v, byId);
    }
    // Needs to actually walk through something.
    if (leg.length <= 1) {
      out.push(ids[i]);
      continue;
    }

    let legDist = 0;
    let legRise = 0;
    let prevNode = u;
    for (const id of leg) {
      const node = byId.get(id);
      if (!node) continue;
      legDist += dist(prevNode, node);
      legRise = Math.max(legRise, Math.abs(node.y - prevNode.y));
      prevNode = node;
    }

    const detourMax = crossesLevels ? LEVEL_CHANGE_DETOUR_MAX : TELEPORT_DETOUR_MAX;
    if (legDist > direct * detourMax) {
      out.push(ids[i]);
      continue;
    }
    // On a level change the replacement must genuinely break the climb into
    // smaller steps. A merely fractional improvement is not a better route: the
    // direct link is excluded while planning, so the search is forced to detour
    // and will happily return a sideways hop that climbs just as hard, which
    // shows up as a visible zigzag at the top of a flight.
    if (crossesLevels && legRise > dy * LEVEL_CHANGE_IMPROVEMENT) {
      out.push(ids[i]);
      continue;
    }
    // A repair must not detour through a scan point the route already visited,
    // nor one it is about to visit. Either way the walk doubles back on itself
    // — that is what produced a visible zigzag at the top of a flight.
    const already = new Set(out);
    const upcoming = new Set(ids.slice(i + 1));
    if (
      leg.some(
        (id, k) => k < leg.length - 1 && (already.has(id) || upcoming.has(id)),
      )
    ) {
      out.push(ids[i]);
      continue;
    }

    for (const id of leg) out.push(id);
  }
  return collapseLoops(out);
}

/**
 * Remove cycles from a walk.
 *
 * Repairs and insertions are local decisions, so between them they can leave
 * the route stepping out and back to a point it already stood on. Returning to
 * an earlier scan point means everything in between was a loop: dropping it
 * leaves a strictly shorter walk that is still valid, because the point before
 * the loop and the point after it are the same node.
 *
 * @param {string[]} ids
 * @returns {string[]}
 */
function collapseLoops(ids) {
  const out = [];
  const seenAt = new Map();
  for (const id of ids) {
    const prior = seenAt.get(id);
    if (prior !== undefined) {
      // Drop everything after the first visit, then stand here again.
      out.length = prior + 1;
      for (const [key, pos] of [...seenAt]) if (pos > prior) seenAt.delete(key);
      continue;
    }
    seenAt.set(id, out.length);
    out.push(id);
  }
  return out;
}

/**
 * Split a route where it changes level.
 *
 * A cross-floor route reads badly drawn end to end: the part on the far floor
 * hangs in the air behind a ceiling and competes with the part you are actually
 * walking. Splitting it at the staircase gives three legs to show one at a time
 * — walk to the stairs, climb them, walk to the destination.
 *
 * Segments share their boundary point, so leg N ends exactly where leg N+1
 * begins and nothing is lost between them.
 *
 * @param {Array<{x:number,y:number,z:number}>} points route polyline
 * @param {{ stepM?: number, minRiseM?: number }} [opts]
 * @returns {Array<{kind:'walk'|'stairs', points:Array<object>, rise:number}>}
 */
export function splitRouteAtLevelChanges(points, opts = {}) {
  if (!points || points.length < 2) {
    return points?.length ? [{ kind: 'walk', points: points.slice(), rise: 0 }] : [];
  }
  const step = Number(opts.stepM) > 0 ? Number(opts.stepM) : FLOOR_STEP_M;
  // A stair leg has to be a real flight, not one raised threshold.
  const minRise = Number(opts.minRiseM) > 0 ? Number(opts.minRiseM) : 0.8;

  const kinds = [];
  for (let i = 1; i < points.length; i += 1) {
    kinds.push(Math.abs(points[i].y - points[i - 1].y) > step ? 'stairs' : 'walk');
  }

  const raw = [];
  let start = 0;
  for (let i = 1; i <= kinds.length; i += 1) {
    if (i === kinds.length || kinds[i] !== kinds[start]) {
      raw.push({ kind: kinds[start], from: start, to: i });
      start = i;
    }
  }

  const totalRise = (seg) => {
    let r = 0;
    for (let i = seg.from + 1; i <= seg.to; i += 1) {
      r += Math.abs(points[i].y - points[i - 1].y);
    }
    return r;
  };

  // Demote trivial "stair" runs to walking, then merge neighbours of like kind.
  const merged = [];
  for (const seg of raw) {
    const kind = seg.kind === 'stairs' && totalRise(seg) < minRise ? 'walk' : seg.kind;
    const last = merged[merged.length - 1];
    if (last && last.kind === kind) last.to = seg.to;
    else merged.push({ kind, from: seg.from, to: seg.to });
  }

  // Absorb landings. The flat turn between two flights reads as "walk" on rise
  // alone, which chops one staircase into two legs with a two-metre stroll in
  // the middle. A short flat run with stairs on both sides IS the staircase, so
  // fold it in and keep the flight whole.
  const runLength = (seg) => {
    let d = 0;
    for (let i = seg.from + 1; i <= seg.to; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      d += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    return d;
  };
  const withLandings = [];
  for (let i = 0; i < merged.length; i += 1) {
    const seg = merged[i];
    const prev = withLandings[withLandings.length - 1];
    const next = merged[i + 1];
    const isLanding =
      seg.kind === 'walk' &&
      prev?.kind === 'stairs' &&
      next?.kind === 'stairs' &&
      runLength(seg) <= LANDING_MAX_M;
    if (isLanding) {
      prev.to = seg.to;
      continue;
    }
    if (prev && prev.kind === seg.kind) prev.to = seg.to;
    else withLandings.push({ ...seg });
  }
  // Folding a landing in can leave two stair runs adjacent — join them.
  const final = [];
  for (const seg of withLandings) {
    const prev = final[final.length - 1];
    if (prev && prev.kind === seg.kind) prev.to = seg.to;
    else final.push({ ...seg });
  }

  return final.map((seg) => ({
    kind: seg.kind,
    points: points.slice(seg.from, seg.to + 1),
    rise: totalRise(seg),
  }));
}

export async function matterportSweepPath(from, to, opts = {}) {
  if (!active || !mpSdk?.Sweep?.data) {
    return { ok: false, error: 'Space map is not active' };
  }
  let sweeps;
  try {
    sweeps = sweepListFromCollection(await readSweepCollection(mpSdk));
  } catch (err) {
    return { ok: false, error: err?.message ?? 'Could not read sweeps' };
  }
  if (sweeps.length < 2) return { ok: false, error: 'This space has too few camera points' };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const nearest = (pt) => {
    let best = null;
    let bestD = Infinity;
    for (const s of sweeps) {
      const d = dist(s, pt);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };

  // startSweepId pins the route to where the camera actually stands, so it
  // begins at your feet rather than at the nearest sweep to a POI marker.
  const pinned = opts.startSweepId ? sweeps.find((s2) => s2.id === opts.startSweepId) : null;
  const start = pinned ?? nearest(from);
  const goal = nearest(to);
  if (!start || !goal) return { ok: false, error: 'No camera point near those POIs' };
  if (start.id === goal.id) {
    return { ok: true, points: [{ x: start.x, y: start.y, z: start.z }], sweepIds: [start.id] };
  }

  const byId = new Map(sweeps.map((s) => [s.id, s]));
  const best = new Map([[start.id, 0]]);
  const prev = new Map();
  // Small graphs (hundreds of sweeps) — a linear scan beats a heap here.
  const unvisited = new Set(sweeps.map((s) => s.id));

  while (unvisited.size) {
    let curId = null;
    let curCost = Infinity;
    for (const id of unvisited) {
      const c = best.get(id);
      if (c !== undefined && c < curCost) {
        curCost = c;
        curId = id;
      }
    }
    if (curId === null) break; // remaining nodes unreachable
    if (curId === goal.id) break;
    unvisited.delete(curId);

    const cur = byId.get(curId);
    if (!cur) continue;
    for (const nId of cur.neighbors) {
      if (!unvisited.has(nId)) continue;
      const nb = byId.get(nId);
      if (!nb) continue;
      const cost = curCost + hopCost(cur, nb);
      if (cost < (best.get(nId) ?? Infinity)) {
        best.set(nId, cost);
        prev.set(nId, curId);
      }
    }
  }

  if (!best.has(goal.id)) {
    return { ok: false, error: 'Those POIs are not connected by camera points' };
  }

  const raw = [];
  for (let id = goal.id; id !== undefined; id = prev.get(id)) {
    raw.unshift(id);
    if (id === start.id) break;
  }
  // Walk through every scan point on the way, never over them.
  const ids = applyStairChains(repairTeleports(insertSkippedSweeps(raw, byId), byId), byId);
  const points = ids.map((id) => {
    const s = byId.get(id);
    return { x: s.x, y: s.y, z: s.z };
  });
  // Scan numbers as shown in Matterport's own scan list, so a route can be
  // checked against it point by point.
  const order = new Map(sweeps.map((sw, i) => [sw.id, i]));
  const sweepNumbers = ids.map((id) => order.get(id) ?? null);
  return {
    ok: true,
    points,
    sweepIds: ids,
    sweepNumbers,
    skippedRecovered: ids.length - raw.length,
  };
}

/** Squared 3D distance from a point to a segment. */
function pointSegDistSq(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lenSq > 1e-9) {
    t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const dx = p.x - (a.x + abx * t);
  const dy = p.y - (a.y + aby * t);
  const dz = p.z - (a.z + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Hybrid route: travel the sweep graph, guided by the navmesh path.
 *
 * The naive approach — snap each navmesh point to its nearest sweep — produces
 * two defects:
 *
 *  1. Matching on X/Z alone cannot tell the bottom of a staircase from the top;
 *     they share a footprint and differ only in Y. A path point at the foot of
 *     the stairs snaps to the landing above, and the route reads as a lift.
 *  2. Nothing forces consecutive picks to be connected, so the line can jump
 *     between sweeps you cannot actually walk between.
 *
 * So instead of snapping, this runs Dijkstra over the sweep graph — every step
 * is a real `neighbors` edge, which is the only way Showcase can move you — and
 * biases the cost by how far each sweep strays from the navmesh path. The
 * result follows the navmesh corridor (up the stairs, round the turn) while
 * remaining a sequence of genuinely travelable camera points.
 *
 * Deviation is measured in 3D, so height separates stair levels properly.
 *
 * @param {Array<{x:number,y:number,z:number}>} pathPoints dense navmesh path
 * @param {{ corridorM?: number, penalty?: number, isOnNavmesh?: (p:{x:number,y:number,z:number})=>boolean }} [opts]
 *   corridorM   — deviation treated as "on the path" (metres)
 *   penalty     — how strongly to punish straying beyond it
 *   isOnNavmesh — optional predicate testing whether a floor-level point lies on
 *                 the generated navmesh. Sweeps that fail it are heavily
 *                 penalised (not deleted, which could disconnect the graph), so
 *                 the route only passes through off-mesh scan points when there
 *                 is no walkable alternative
 * @returns {Promise<{ ok:boolean, error?:string, points?:Array<{x:number,y:number,z:number}>, sweepIds?:string[], deviationM?:number }>}
 */
/**
 * Route through declared staircases, in order, covering every step.
 *
 * `applyStairChains` can only repair a flight the route already stumbled onto.
 * When the destination is on another floor the flight is not optional — it is
 * the only way up — so it is treated as a waypoint instead: walk to the foot of
 * the flight, climb every declared step, then carry on from the top. Each
 * connecting leg is an ordinary same-floor search, which is exactly what it is.
 *
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 * @param {number[][]} chains ordered flights, each already oriented in the
 *   direction of travel (first element = the step you reach first)
 * @param {{ startSweepId?: string }} [opts]
 */
export async function matterportSweepPathVia(from, to, chains, opts = {}) {
  if (!chains?.length) return matterportSweepPath(from, to, opts);

  const listed = await matterportListSweeps();
  if (!listed.ok) return { ok: false, error: listed.error };
  const sweeps = listed.sweeps;
  const order = new Map(sweeps.map((sw, i) => [sw.id, i]));

  const resolved = [];
  for (const chain of chains) {
    const run = chain.map((n) => sweeps[n]).filter(Boolean);
    if (run.length >= 2) resolved.push(run);
  }
  if (!resolved.length) return matterportSweepPath(from, to, opts);

  const outPoints = [];
  const outIds = [];
  const push = (sw) => {
    // Seams share a scan point; never record it twice.
    if (outIds[outIds.length - 1] === sw.id) return;
    outIds.push(sw.id);
    outPoints.push({ x: sw.x, y: sw.y, z: sw.z });
  };

  let cursor = from;
  let startSweepId = opts.startSweepId;
  for (const run of resolved) {
    const foot = run[0];
    const head = run[run.length - 1];
    const leg = await matterportSweepPath(cursor, { x: foot.x, y: foot.y, z: foot.z }, { startSweepId });
    startSweepId = undefined; // only pins the very first leg
    if (!leg.ok) return leg;
    for (const id of leg.sweepIds) {
      const sw = sweeps[order.get(id)];
      if (sw) push(sw);
    }
    // The flight itself, verbatim — this is the guarantee.
    for (const sw of run) push(sw);
    cursor = { x: head.x, y: head.y, z: head.z };
  }

  const tail = await matterportSweepPath(cursor, to);
  if (!tail.ok) return tail;
  for (const id of tail.sweepIds) {
    const sw = sweeps[order.get(id)];
    if (sw) push(sw);
  }

  const ids = collapseLoops(outIds);
  const byId = new Map(sweeps.map((sw) => [sw.id, sw]));
  const points = ids.map((id) => {
    const sw = byId.get(id);
    return { x: sw.x, y: sw.y, z: sw.z };
  });
  return {
    ok: true,
    points,
    sweepIds: ids,
    sweepNumbers: ids.map((id) => order.get(id) ?? null),
    viaChains: resolved.length,
  };
}

export async function matterportSnapPathToSweeps(pathPoints, opts = {}) {
  if (!active || !mpSdk?.Sweep?.data) {
    return { ok: false, error: 'Space map is not active' };
  }
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) {
    return { ok: false, error: 'Path too short to guide a route' };
  }

  let sweeps;
  try {
    sweeps = sweepListFromCollection(await readSweepCollection(mpSdk));
  } catch (err) {
    return { ok: false, error: err?.message ?? 'Could not read camera points' };
  }
  if (sweeps.length < 2) return { ok: false, error: 'This space has too few camera points' };

  const totalSweeps = sweeps.length;
  const corridor = Number(opts.corridorM) > 0 ? Number(opts.corridorM) : 2.5;
  const penalty = Number(opts.penalty) > 0 ? Number(opts.penalty) : 6;

  // Check every scan point against the generated navmesh. A sweep can sit near
  // the route yet be off the walkable surface (on a plinth, behind a rope,
  // inside a display case); routing through it sends you somewhere you cannot
  // walk.
  //
  // These are penalised rather than deleted. Deleting them can disconnect the
  // graph — one doorway or stair-landing sweep that a coarse navmesh misses is
  // often the only link between two regions, and losing it fails the whole
  // route. A large multiplier means an off-mesh sweep is only ever used when
  // there is genuinely no on-mesh way through.
  const offMesh = new Set();
  if (typeof opts.isOnNavmesh === 'function') {
    for (const sw of sweeps) {
      // The navmesh lies on the floor; sweeps are recorded at camera height.
      const probe = { x: sw.x, y: sw.y - SWEEP_EYE_HEIGHT_M, z: sw.z };
      let on = true;
      try {
        on = Boolean(opts.isOnNavmesh(probe));
      } catch {
        on = true; // a failed probe must not condemn the sweep
      }
      if (!on) offMesh.add(sw.id);
    }
    // A navmesh that rejects nearly everything is mis-scaled or misaligned.
    // Trusting it would wreck routing, so ignore the check entirely.
    if (offMesh.size > sweeps.length * 0.8) offMesh.clear();
  }
  const offNavmesh = offMesh.size;

  // Sweeps are at camera height, navmesh points at floor level. Lift the path
  // so "distance from the path" is not dominated by that constant offset.
  const guide = pathPoints.map((p) => ({ x: p.x, y: p.y + SWEEP_EYE_HEIGHT_M, z: p.z }));

  // How far each sweep sits from the guide path, in 3D.
  const deviation = new Map();
  for (const sw of sweeps) {
    let best = Infinity;
    for (let i = 1; i < guide.length; i += 1) {
      const d = pointSegDistSq(sw, guide[i - 1], guide[i]);
      if (d < best) best = d;
    }
    deviation.set(sw.id, Math.sqrt(best));
  }

  // Endpoints: nearest sweep to each end of the path, measured in 3D so a
  // staircase's foot never resolves to its landing.
  // Endpoints prefer an on-navmesh sweep, falling back to any sweep so a space
  // with no navmesh coverage still routes.
  const nearestTo = (pt) => {
    const pick = (pool) => {
      let best = null;
      let bestD = Infinity;
      for (const sw of pool) {
        const d = (sw.x - pt.x) ** 2 + (sw.y - pt.y) ** 2 + (sw.z - pt.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = sw;
        }
      }
      return best;
    };
    if (offMesh.size) {
      const onMesh = sweeps.filter((sw) => !offMesh.has(sw.id));
      if (onMesh.length) return pick(onMesh);
    }
    return pick(sweeps);
  };
  // startSweepId pins the route to the scan point the camera is standing on,
  // so navigation runs from your feet rather than from a POI marker.
  const pinnedStart = opts.startSweepId
    ? sweeps.find((sw) => sw.id === opts.startSweepId)
    : null;
  const startSweep = pinnedStart ?? nearestTo(guide[0]);
  const goalSweep = nearestTo(guide[guide.length - 1]);
  if (!startSweep || !goalSweep) return { ok: false, error: 'No camera point near the route' };
  if (startSweep.id === goalSweep.id) {
    return {
      ok: true,
      points: [{ x: startSweep.x, y: startSweep.y, z: startSweep.z }],
      sweepIds: [startSweep.id],
      deviationM: deviation.get(startSweep.id) ?? 0,
    };
  }

  const byId = new Map(sweeps.map((sw) => [sw.id, sw]));
  const best = new Map([[startSweep.id, 0]]);
  const prev = new Map();
  const unvisited = new Set(sweeps.map((sw) => sw.id));

  while (unvisited.size) {
    let curId = null;
    let curCost = Infinity;
    for (const id of unvisited) {
      const c = best.get(id);
      if (c !== undefined && c < curCost) {
        curCost = c;
        curId = id;
      }
    }
    if (curId === null) break;
    if (curId === goalSweep.id) break;
    unvisited.delete(curId);

    const cur = byId.get(curId);
    if (!cur) continue;
    for (const nId of cur.neighbors) {
      if (!unvisited.has(nId)) continue;
      const nb = byId.get(nId);
      if (!nb) continue;
      // Superlinear in distance, so the search prefers stepping through the
      // scan points in between over one long hop that skips them.
      const step = hopCost(cur, nb);
      // Straying beyond the corridor costs progressively more, so the search
      // hugs the navmesh route instead of taking graph short-cuts through walls.
      const stray = Math.max(0, (deviation.get(nId) ?? 0) - corridor);
      const offMeshCost = offMesh.has(nId) ? OFF_NAVMESH_PENALTY : 1;
      const cost = curCost + step * (1 + penalty * stray) * offMeshCost;
      if (cost < (best.get(nId) ?? Infinity)) {
        best.set(nId, cost);
        prev.set(nId, curId);
      }
    }
  }

  if (!best.has(goalSweep.id)) {
    return { ok: false, error: 'Those points are not connected by camera points' };
  }

  const raw = [];
  for (let id = goalSweep.id; id !== undefined; id = prev.get(id)) {
    raw.unshift(id);
    if (id === startSweep.id) break;
  }
  // Hybrid must travel scan point to scan point with nothing stepped over —
  // except points the navmesh check rejected, which stay off the route.
  // repairTeleports then expands any remaining long hop (stairs, mezzanines)
  // into the actual walk, ignoring the navmesh flag: a route that cannot be
  // walked is worse than one touching an unmapped scan point.
  const ids = applyStairChains(
    repairTeleports(insertSkippedSweeps(raw, byId, 1.6, offMesh), byId),
    byId,
  );
  const points = ids.map((id) => {
    const sw = byId.get(id);
    return { x: sw.x, y: sw.y, z: sw.z };
  });
  const worst = ids.reduce((m, id) => Math.max(m, deviation.get(id) ?? 0), 0);
  const order = new Map(sweeps.map((sw, i) => [sw.id, i]));
  return {
    ok: true,
    points,
    sweepIds: ids,
    sweepNumbers: ids.map((id) => order.get(id) ?? null),
    deviationM: worst,
    onNavmesh: totalSweeps - offNavmesh,
    offNavmesh,
    totalSweeps,
    // Scan points on the chosen route that are off the navmesh — 0 is the goal.
    offNavmeshOnRoute: ids.filter((id) => offMesh.has(id)).length,
    skippedRecovered: ids.length - raw.length,
  };
}

/**
 * Sweep.moveTo transition. The Sweep enum is INSTANT / FADEOUT / INTERPOLATE —
 * there is no "fly" (that belongs to Camera/Mode), and passing an unknown value
 * makes moveTo reject outright, which is why moving to a start point failed.
 */
function sweepTransitionValue() {
  const T = mpSdk?.Sweep?.Transition;
  return T?.INTERPOLATE || T?.FADEOUT || T?.INSTANT || undefined;
}

/**
 * Move to a sweep, retrying without options if the SDK rejects the transition.
 * Showcase builds disagree about the option shape, and standing in the right
 * place matters more than how we got there.
 */
async function sweepMoveToSafe(sweepId) {
  const id = String(sweepId);
  const transition = sweepTransitionValue();
  if (transition) {
    try {
      await mpSdk.Sweep.moveTo(id, { transition });
      return;
    } catch {
      /* fall through to the bare call */
    }
  }
  await mpSdk.Sweep.moveTo(id);
}

/**
 * The camera point closest to a world position.
 *
 * Matched on X/Z only: sweeps sit at camera height while POIs are stored at
 * floor level, so a 3D distance biases towards whichever floor happens to be
 * nearer in Y rather than the one you are standing on.
 *
 * @param {{x:number,y:number,z:number}} position
 * @returns {Promise<{ ok: boolean, error?: string, sweep?: {id:string,x:number,y:number,z:number}, distance?: number }>}
 */
/**
 * Every scan point in the space, with its neighbour links.
 *
 * Exposed because floor-to-floor routing has to reason about the staircase as a
 * whole — which points form the flight, and in what order — rather than one hop
 * at a time.
 *
 * @returns {Promise<{ok:boolean, sweeps?:Array<object>, error?:string}>}
 */
export async function matterportListSweeps() {
  if (!active || !mpSdk?.Sweep?.data) return { ok: false, error: 'Space map is not active' };
  try {
    const sweeps = sweepListFromCollection(await readSweepCollection(mpSdk));
    return { ok: true, sweeps };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'Could not read camera points' };
  }
}

export async function matterportNearestSweep(position) {
  if (!active || !mpSdk?.Sweep?.data) {
    return { ok: false, error: 'Space map is not active' };
  }
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    return { ok: false, error: 'Invalid position' };
  }
  let sweeps;
  try {
    sweeps = sweepListFromCollection(await readSweepCollection(mpSdk));
  } catch (err) {
    return { ok: false, error: err?.message ?? 'Could not read camera points' };
  }
  if (!sweeps.length) return { ok: false, error: 'This space has no camera points' };

  // Measured in 3D, with height weighted.
  //
  // Comparing X/Z alone looks harmless in a single-storey space and is badly
  // wrong in a multi-storey one: every floor stacks at the same X/Z, so the
  // "nearest" scan point to a first-floor POI can sit two floors above it.
  // Selecting a start then teleported the camera to the wrong floor entirely.
  //
  // Plain 3D still errs where a POI sits near a void or stairwell and the scan
  // point one floor below is marginally closer in a straight line. Landing on
  // the right floor is worth more than half a metre of proximity, so height
  // counts double when ranking. The distance reported back is the true one.
  let best = null;
  let bestScore = Infinity;
  for (const sw of sweeps) {
    const dy = (sw.y - position.y) * NEAREST_SWEEP_HEIGHT_WEIGHT;
    const score = (sw.x - position.x) ** 2 + dy ** 2 + (sw.z - position.z) ** 2;
    if (score < bestScore) {
      bestScore = score;
      best = sw;
    }
  }
  if (!best) return { ok: false, error: 'No camera point found' };
  const distance = Math.hypot(
    best.x - position.x,
    best.y - position.y,
    best.z - position.z,
  );
  return { ok: true, sweep: best, distance };
}

/**
 * Stand at the camera point nearest a world position, and optionally look
 * towards a second position once there.
 *
 * @param {{x:number,y:number,z:number}} position
 * @param {{x:number,y:number,z:number} | null} [lookAt]
 */
export async function matterportGoToNearestSweep(position, lookAt = null) {
  const near = await matterportNearestSweep(position);
  if (!near.ok) return near;

  const moved = await matterportMoveToSweep(near.sweep.id);
  if (!moved.ok) return moved;

  if (lookAt) {
    try {
      await refreshMatterportCameraPose(120);
      const cam = lastCameraPose?.position ?? near.sweep;
      const yaw = rotationYawToward(cam, lookAt);
      if (typeof mpSdk.Camera?.setRotation === 'function') {
        await mpSdk.Camera.setRotation(yaw, { speed: 120 });
      }
      await refreshMatterportCameraPose(220);
    } catch {
      /* standing in the right place already helps; heading is a bonus */
    }
  }
  return { ok: true, sweep: near.sweep, distance: near.distance };
}

/** Move the walkthrough camera to a sweep, so a route can start where you stand. */

/**
 * The scan point the camera is currently standing on.
 *
 * Navigation starts here — "from my feet" — rather than from the nearest sweep
 * to a POI marker, which can be a different point entirely.
 *
 * @returns {Promise<{ok: boolean, sweep?: object, error?: string}>}
 */
export async function matterportCurrentSweep() {
  if (!active || !mpSdk?.Sweep?.data) return { ok: false, error: 'Space map is not active' };
  try {
    await refreshMatterportCameraPose(0);
    const cam = lastCameraPose?.position;
    if (!cam) return { ok: false, error: 'No camera pose yet' };
    return await matterportNearestSweep(cam);
  } catch (err) {
    return { ok: false, error: err?.message ?? 'Could not read the camera position' };
  }
}

export async function matterportMoveToSweep(sweepId) {
  if (!active || !mpSdk?.Sweep?.moveTo || !sweepId) {
    return { ok: false, error: 'Space map is not active' };
  }
  try {
    await sweepMoveToSafe(sweepId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'Could not move to that camera point' };
  }
}

export async function clearMatterportNavRouteOverlay() {
  if (navRouteOverlay) {
    disposeMpObject3D(navRouteOverlay);
    navRouteOverlay = null;
  }
  navWorldPoints = [];
  if (annotDrawRaf) {
    cancelAnimationFrame(annotDrawRaf);
    annotDrawRaf = 0;
  }
  scheduleAnnotDraw({ force: true });
  return { ok: true };
}

/** Force heat / nav 2D overlay redraw (e.g. after walkthrough ↔ dollhouse). */
export function refreshMatterportAnnotOverlay() {
  if (!active) return;
  void refreshMatterportCameraPose(0).then(() => scheduleAnnotDraw({ force: true }));
}

export function isMatterportNavmeshVisible() {
  return navmeshOverlayVisible;
}

/**
 * Walkable overlay from scan points inside Showcase (no MultiSet mesh).
 */
export async function showMatterportNavmeshOverlay() {
  if (!active || !mpSdk) return { ok: false, error: 'Space map is not active' };
  await ensureMpOverlayScene();
  if (navmeshOverlay) {
    disposeMpObject3D(navmeshOverlay);
    navmeshOverlay = null;
  }
  const collection = await readSweepCollection(mpSdk);
  const sweeps = sweepListFromCollection(collection);
  if (!sweeps.length) {
    navmeshOverlayVisible = false;
    return { ok: false, error: 'No walkable scans in this space yet' };
  }
  const group = buildMpNavmeshGroup(mpThree, sweeps);
  overlayRoot.add(group);
  navmeshOverlay = group;
  navmeshOverlayVisible = true;
  return { ok: true, count: sweeps.length };
}

export function hideMatterportNavmeshOverlay() {
  if (navmeshOverlay) {
    disposeMpObject3D(navmeshOverlay);
    navmeshOverlay = null;
  }
  navmeshOverlayVisible = false;
}

/**
 * Matterport Camera transition — prefer fade (tag-click style) over fly-through.
 * @param {'fade' | 'fly'} [prefer]
 */
function resolveCameraTransition(prefer = 'fade') {
  const TT = mpSdk?.Camera?.TransitionType || mpSdk?.Camera?.Transition || {};
  const Matter = mpSdk?.Mattertag?.Transition || {};
  if (prefer === 'fly') {
    return TT.FLY || Matter.FLY || 'transition.fly';
  }
  return (
    TT.FADEOUT ||
    TT.MOVEFADE ||
    Matter.FADEOUT ||
    Matter.FADE ||
    'transition.fade'
  );
}

/**
 * Go to the nearest walkthrough sweep for a world point and face it.
 * Uses Matterport fade (like clicking a native tag) — no fly-through travel.
 * Newer calls cancel older in-flight go-tos so rapid POI clicks never feel stuck.
 * @param {{ x: number, y: number, z: number }} point point to look at (pin)
 * @param {{
 *   tagId?: string | null,
 *   preferSweep?: boolean,
 *   transitionTime?: number,
 *   transition?: 'fade' | 'fly',
 *   sweepFrom?: { x: number, y: number, z: number } | null,
 * }} [opts]
 */
export async function matterportGoToPoint(point, opts = {}) {
  if (!mpSdk || !point) return { ok: false, error: 'Space SDK not ready' };
  const target = {
    x: Number(point.x),
    y: Number(point.y),
    z: Number(point.z),
  };
  if (![target.x, target.y, target.z].every(Number.isFinite)) {
    return { ok: false, error: 'Invalid go-to point' };
  }

  const sweepSearch = opts.sweepFrom && Number.isFinite(Number(opts.sweepFrom.x))
    ? {
        x: Number(opts.sweepFrom.x),
        y: Number(opts.sweepFrom.y),
        z: Number(opts.sweepFrom.z),
      }
    : target;

  const goKey = [
    sweepSearch.x.toFixed(2),
    sweepSearch.y.toFixed(2),
    sweepSearch.z.toFixed(2),
    target.x.toFixed(2),
    target.y.toFixed(2),
    target.z.toFixed(2),
  ].join('|');
  const now = Date.now();
  // Skip duplicate / overlapping fades (Tag.open / re-select used to loop forever).
  if (goToInFlight || (goKey === lastGoToKey && now - lastGoToAt < 1400)) {
    return { ok: false, skipped: true };
  }
  goToInFlight = true;
  lastGoToKey = goKey;
  lastGoToAt = now;

  const gen = ++goToGeneration;
  const transitionStyle = opts.transition === 'fly' ? 'fly' : 'fade';
  const transition = resolveCameraTransition(transitionStyle);
  const ModeEnum = mpSdk.Mode?.Mode || {};
  const inside = ModeEnum.INSIDE || 'mode.inside';
  const transitionTime =
    Number(opts.transitionTime) > 0
      ? Number(opts.transitionTime)
      : transitionStyle === 'fade'
        ? 900
        : 480;

  try {
    if (typeof mpSdk.Mode?.moveTo === 'function' && currentViewMode !== 'inside') {
      try {
        await Promise.race([
          mpSdk.Mode.moveTo(inside, {
            transition,
            transitionTime: Math.min(400, transitionTime),
          }),
          new Promise((resolve) => setTimeout(resolve, 280)),
        ]);
      } catch {
        /* sweep may still work */
      }
    }
    if (gen !== goToGeneration) return { ok: false, aborted: true };

    const tagId = opts.tagId ? asTagId(opts.tagId) : null;
    if (tagId) await ensureMatterportTagVisible(tagId);

    const collection = await readSweepCollection(mpSdk);
    if (gen !== goToGeneration) return { ok: false, aborted: true };

    const nearest = findNearestSweep(collection, sweepSearch, { horizontalBias: true });
    if (!nearest?.id || typeof mpSdk.Sweep?.moveTo !== 'function') {
      return { ok: false, error: 'No nearby walkthrough point' };
    }

    const rotation = nearest.position
      ? rotationLookingAt(nearest.position, target, { maxPitch: 28, minPitch: -32 })
      : undefined;

    await Promise.race([
      mpSdk.Sweep.moveTo(nearest.id, {
        transition,
        transitionTime,
        ...(rotation ? { rotation } : {}),
      }),
      new Promise((resolve) => setTimeout(resolve, transitionTime + 400)),
    ]);

    if (gen !== goToGeneration) return { ok: false, aborted: true };

    // After sweep arrives, rotate camera to center the POI in view.
    // Use the same proven rotation math as ThreeDNavigation for consistency.
    if (nearest.position) {
      try {
        const dx = target.x - nearest.position.x;
        const dy = target.y - nearest.position.y;
        const dz = target.z - nearest.position.z;
        const horiz = Math.sqrt(dx * dx + dz * dz) || 1e-6;

        // Pitch: vertical angle, clamped to prevent extreme angles
        let pitch = (Math.atan2(dy, horiz) * 180) / Math.PI;
        const maxPitch = 28;
        const minPitch = -35;
        if (horiz < 1.5 && pitch > maxPitch) pitch = maxPitch;
        pitch = Math.max(minPitch, Math.min(maxPitch, pitch));

        // Yaw: horizontal angle using Matterport coordinate system (-Z forward, +X right)
        const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;

        // Try Sweep.moveTo with INSTANT transition first (cleanest camera move)
        let rotated = false;
        if (typeof mpSdk.Sweep?.moveTo === 'function') {
          try {
            const instant = mpSdk.Sweep.Transition?.INSTANT;
            const moveOpts = { rotation: { x: pitch, y: yaw } };
            if (instant) moveOpts.transition = instant;
            await mpSdk.Sweep.moveTo(nearest.id, moveOpts);
            rotated = true;
          } catch {
            rotated = false;
          }
        }

        // Fallback to Camera.setRotation if Sweep.moveTo fails
        if (!rotated && typeof mpSdk.Camera?.setRotation === 'function') {
          await mpSdk.Camera.setRotation(
            { x: pitch, y: yaw },
            { speed: 110 },
          );
        }
      } catch (err) {
        console.warn('[space-map] camera rotation to POI failed', err);
      }
    }

    // Do not Tag.open — that re-selects the pin and restarts go-to (blink loop).
    if (tagId) await ensureMatterportTagVisible(tagId);

    return { ok: true, method: 'sweep+fade', sweepId: nearest.id };
  } catch (err) {
    if (gen !== goToGeneration) return { ok: false, aborted: true };
    console.warn('[space-map] go-to nearest sweep failed', err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    goToInFlight = false;
  }
}

/**
 * Look up the Showcase tag id for a synced entity (poi / facility / media).
 * @param {'poi' | 'facility' | 'media'} kind
 * @param {string | number} id
 */
export function getMatterportTagId(kind, id) {
  if (id == null) return null;
  const prefix = kind === 'facility' ? 'fac' : kind === 'media' ? 'media' : 'poi';
  return (
    tagByEntityKey.get(`${prefix}:${id}`) ||
    (kind === 'poi' ? tagByEntityKey.get(`poi-expected:${id}`) : null) ||
    null
  );
}

/**
 * Remove a Showcase tag for a deleted POI / facility / media row.
 * @param {'poi' | 'facility' | 'media'} kind
 * @param {string | number} id
 */
export async function removeMatterportEntityTag(kind, id) {
  if (!mpSdk || !active || id == null) return;
  const prefix = kind === 'facility' ? 'fac' : kind === 'media' ? 'media' : 'poi';
  const keys = [`${prefix}:${id}`];
  if (kind === 'poi') keys.push(`poi-expected:${id}`);

  for (const key of keys) {
    const tagId = tagByEntityKey.get(key);
    tagByEntityKey.delete(key);
    if (!tagId) continue;
    managedShowcaseTagIds.delete(tagId);
    poiHoverTagIds.delete(tagId);
    poiMetaByTagId.delete(tagId);
    mediaTagIds.delete(tagId);
    if (selectedLabelTagId === tagId) selectedLabelTagId = null;
    if (hoverOpenedTagId === tagId) hoverOpenedTagId = null;
    try {
      await mpSdk.Tag?.remove?.(tagId);
    } catch {
      /* */
    }
  }
}

const PENDING_POI_ID = '__pending__';

/**
 * Drop a POI pin on Showcase immediately (before the row is saved).
 * @param {{ x: number, y: number, z: number }} navPoint navigation / form XYZ (`pos_*`)
 * @param {string} [label]
 * @param {{ x: number, y: number, z: number } | null} [expectedPoint] exact click (`expected_pos_*`); defaults to navPoint
 * @param {{ x: number, y: number, z: number } | null} [expectedNormal] surface normal for stem tilt
 */
export async function previewMatterportPoiPin(
  navPoint,
  label = 'New POI',
  expectedPoint = null,
  expectedNormal = null,
) {
  if (!mpSdk || !active || !navPoint) return;
  const expected = expectedPoint && Number.isFinite(Number(expectedPoint.x))
    ? expectedPoint
    : navPoint;
  const n = expectedNormal && Number.isFinite(Number(expectedNormal.x))
    ? expectedNormal
    : { x: 0, y: 1, z: 0 };
  await syncMatterportEntityTags({
    pois: [
      {
        id: PENDING_POI_ID,
        poi_name: label || 'New POI',
        description: '',
        pos_x: Number(navPoint.x),
        pos_y: Number(navPoint.y),
        pos_z: Number(navPoint.z),
        expected_pos_x: Number(expected.x),
        expected_pos_y: Number(expected.y),
        expected_pos_z: Number(expected.z),
        expected_normal_x: Number(n.x),
        expected_normal_y: Number(n.y),
        expected_normal_z: Number(n.z),
      },
    ],
  });
}

/**
 * Bind the preview pin to the saved POI id (or add a fresh pin).
 * @param {{ id?: string, poi_name?: string, name?: string, description?: string, pos_x: number, pos_y: number, pos_z: number }} poi
 */
export async function commitMatterportPoiPin(poi) {
  if (!mpSdk || !active || !poi) return;
  const pendingId = tagByEntityKey.get(`poi:${PENDING_POI_ID}`);
  if (pendingId && poi.id != null) {
    tagByEntityKey.delete(`poi:${PENDING_POI_ID}`);
    tagByEntityKey.set(`poi:${poi.id}`, pendingId);
    poiHoverTagIds.add(pendingId);
  }
  await syncMatterportEntityTags({ pois: [poi] });
}

export async function clearMatterportPoiPreview() {
  await removeMatterportEntityTag('poi', PENDING_POI_ID);
}
