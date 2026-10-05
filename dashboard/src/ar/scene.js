/**
 * 3D Scene → Standard 3D Map Viewer
 *
 * No camera overlay — just a Three.js scene with OrbitControls
 * to display the downloaded map mesh in VPS coordinates.
 *
 * Hierarchy:
 *   Scene
 *   ├── AmbientLight
 *   ├── DirectionalLight
 *   └── multisetAnchor (Group — pose from VPS)
 *         └── Map Mesh (loaded GLB)
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { addPOIsToScene, getPOIObjects, poisData, setHoveredPoiLabel } from './pois.js';
import { addFacilitiesToScene, getFacilityObjects } from './facilities.js';
import { getBlockMeshes } from './blocks.js';
import { refreshMediaGroup } from './media.js';
import { tickNavigation } from './navigation-controller.js';
import {
  cancelLazyMapTextures,
  lazyLoadMapTextures,
  stashMapTextures,
} from './map-texture-loader.js';
import { getDeviceTier, getRecommendedPixelRatio } from '../utils/device-tier.js';
import {
  createDropInSplatViewer,
  splatSceneOptionFromItem,
  applySplatMapRotation,
  waitForSplatViewerIdle,
  yieldToMain,
  getSafeMaxSplatCountPerViewer,
  peekPlyVertexCount,
} from './splat-gaussian.js';
import {
  getMatterportTagId,
  shouldUseMatterportCamera,
  matterportGoToPoint,
  onMatterportCameraPose,
} from './matterport-map.js';

let renderer, scene, camera, controls;
let transformControls;
let multisetAnchor;
let isInitialized = false;
let _container = null;

/** Index of POI last clicked on the 3D canvas or list; press F to fly the camera there. */
let lastPickedPoiIndex = -1;

/** @param {number} index */
export function setLastPickedPoiIndex(index) {
  if (typeof index === 'number' && index >= 0 && index < poisData.length) {
    lastPickedPoiIndex = index;
  }
}

export function getLastPickedPoiIndex() {
  return lastPickedPoiIndex;
}

/** @type {((index: number) => void) | null} */
let onPoiPickedFromCanvas = null;

/** @param {(index: number) => void} cb */
export function setOnPoiPickedFromCanvas(cb) {
  onPoiPickedFromCanvas = cb;
}

/** @type {((blockId: string | number) => void) | null} */
let onBlockPickedFromCanvas = null;

/** @param {(blockId: string | number) => void} cb */
export function setOnBlockPickedFromCanvas(cb) {
  onBlockPickedFromCanvas = cb;
}

/** @type {((index: number) => void) | null} */
let onFacilityPickedFromCanvas = null;

/** @param {(index: number) => void} cb */
export function setOnFacilityPickedFromCanvas(cb) {
  onFacilityPickedFromCanvas = cb;
}
const poiPickRaycaster = new THREE.Raycaster();
const poiPickNdc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/** @typedef {'default' | 'walk' | 'add-poi' | 'add-facility' | 'add-media' | 'add-treasure' | 'draw-block' | 'draw-stairs'} SceneInteractionMode */
let sceneInteractionMode = 'default';
/** @type {((point: THREE.Vector3, mode: SceneInteractionMode) => void) | null} */
let onSceneMapClick = null;
/** @type {((rect: { pos_x: number, pos_y: number, pos_z: number, width: number, depth: number }) => void) | null} */
let onSceneBlockDraw = null;
let placementPreview = null;
let blockDrawPreview = null;
/** @type {THREE.Vector3 | null} */
let blockDrawStartPt = null;
let blockDrawActive = false;

/** Callback fired whenever the gizmo moves the attached object */
let onGizmoDrag = null;
/** Fired once when the user releases the gizmo after dragging */
let onGizmoDragEnd = null;

/**
 * Register a callback for gizmo drag events.
 * @param {(position: {x:number, y:number, z:number}) => void} cb
 */
export function setGizmoDragCallback(cb) {
  onGizmoDrag = cb;
}

/** @param {() => void} cb */
export function setGizmoDragEndCallback(cb) {
  onGizmoDragEnd = cb;
}

/** Expose the scene so external modules can add/remove 3D objects. */
export function getScene() {
  return scene;
}

/** VPS / map root group — loaded GLB and POIs attach here. */
export function getMultisetAnchor() {
  return multisetAnchor;
}

/** Axis-aligned bounds of the loaded MapMesh in MultisetAnchor-local space (for heat maps). */
export function getMapMeshBounds() {
  const root = multisetAnchor?.getObjectByName('MapMesh');
  if (!root || !multisetAnchor) return null;
  root.updateWorldMatrix(true, true);
  const worldBox = new THREE.Box3().setFromObject(root);
  if (worldBox.isEmpty()) return null;
  // Keep bounds in anchor-local space so navnode XYZ and heat planes stay consistent
  // after Matterport dollhouse alignment scales/moves the anchor.
  const inv = new THREE.Matrix4().copy(multisetAnchor.matrixWorld).invert();
  const localBox = worldBox.clone().applyMatrix4(inv);
  return localBox.isEmpty() ? null : localBox;
}

/** Bumped to cancel in-flight multi-splat loads when map is cleared / reloaded. */
let splatMapLoadGeneration = 0;

export async function clearMapMesh() {
  if (!multisetAnchor) return;
  splatMapLoadGeneration += 1;
  cancelLazyMapTextures();
  const existing = multisetAnchor.getObjectByName('MapMesh');
  if (!existing) return;
  const viewers = [];
  const seen = new Set();
  const pushViewer = (v) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    viewers.push(v);
  };
  if (Array.isArray(existing.userData?.splatViewers)) {
    existing.userData.splatViewers.forEach(pushViewer);
  }
  pushViewer(existing.userData?.splatViewer);
  for (const splatViewer of viewers) {
    if (!splatViewer?.dispose) continue;
    try {
      await Promise.resolve(splatViewer.dispose());
    } catch {
      /* ignore dispose races */
    }
  }
  existing.traverse((child) => {
    if (child.isMesh || child.isPoints) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m) return;
        m.map?.dispose();
        m.dispose();
      });
    }
  });
  multisetAnchor.remove(existing);
  setSplatMapRenderStyle(false);
}

/**
 * Replace MultiSet GLB with uploaded Gaussian splat (.ply) as the map.
 * One DropInViewer per file — combining PLYs in one viewer overflows GPU
 * DataTextures (e.g. 4096×32768 > MAX_TEXTURE_SIZE).
 * Loads files one-by-one: first splat paints ASAP. Locked rotation X=-90°.
 * @param {Array<Record<string, unknown>>} splatItems
 * @param {{ frameCamera?: boolean | 'origin' | 'fit', onProgress?: (msg: string) => void }} [options]
 */
export async function addSplatMap(splatItems, options = {}) {
  if (!multisetAnchor) return { ok: false, error: 'Scene not ready' };
  const items = (Array.isArray(splatItems) ? splatItems : []).filter(
    (item) => (item?.media_url || item?._previewUrl) && item?.is_active !== false,
  );
  if (!items.length) return { ok: false, error: 'No splat files for this project' };

  // clearMapMesh bumps generation (cancels in-flight loads); capture token after that.
  await clearMapMesh();
  const loadGen = splatMapLoadGeneration;
  if (!multisetAnchor) return { ok: false, error: 'Scene not ready' };

  const sceneOptions = items
    .map((item) => splatSceneOptionFromItem(item))
    .filter((opt) => opt.path);

  if (!sceneOptions.length) {
    return { ok: false, error: 'No splat URLs available' };
  }

  const mapRoot = new THREE.Group();
  mapRoot.name = 'MapMesh';
  mapRoot.userData.mapKind = 'splat';
  mapRoot.userData.splatLoadGeneration = loadGen;
  mapRoot.userData.splatViewers = [];

  // Orientation on the parent so every per-file viewer inherits it.
  const splatRoot = new THREE.Group();
  splatRoot.name = 'SplatGaussianRoot';
  applySplatMapRotation(splatRoot);
  mapRoot.add(splatRoot);

  // Mount shell immediately so the viewport is not stuck empty for minutes.
  multisetAnchor.add(mapRoot);
  setSplatMapRenderStyle(true);

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const total = sceneOptions.length;
  const safeMaxSplats = getSafeMaxSplatCountPerViewer(renderer);
  // Allow a small overage to avoid rejecting borderline files (~10M vs ~10M rounding).
  // We still hard-skip clearly oversized files that are likely to crash texture packing.
  const hardSkipSplats = Math.floor(safeMaxSplats * 1.1);
  let loaded = 0;
  let failed = 0;
  let skippedOversized = 0;
  let firstReady = false;

  const updateContentBounds = () => {
    const viewers = mapRoot.userData.splatViewers || [];
    let box = null;
    for (const dropIn of viewers) {
      const splatMesh = dropIn?.viewer?.splatMesh;
      if (!splatMesh?.calculatedSceneCenter) continue;
      const c = splatMesh.calculatedSceneCenter;
      const r = Math.max(Number(splatMesh.maxSplatDistanceFromSceneCenter) || 0, 25);
      const b = new THREE.Box3(
        new THREE.Vector3(c.x - r, c.y - r * 0.5, c.z - r),
        new THREE.Vector3(c.x + r, c.y + r * 0.5, c.z + r),
      );
      box = box ? box.union(b) : b.clone();
    }
    mapRoot.userData.contentBounds =
      box ||
      new THREE.Box3(new THREE.Vector3(-40, -10, -40), new THREE.Vector3(40, 20, 40));
  };

  const ensureColliderAndBounds = () => {
    if (!mapRoot.getObjectByName('SplatMapCollider')) {
      const collider = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshBasicMaterial({
          visible: false,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      collider.name = 'SplatMapCollider';
      collider.rotation.x = -Math.PI / 2;
      collider.position.set(0, 0, 0);
      collider.userData.excludeFromBounds = true;
      mapRoot.add(collider);
    }
    updateContentBounds();
  };

  const onFirstReady = async () => {
    if (firstReady) return;
    firstReady = true;
    applySplatMapRotation(splatRoot);
    ensureColliderAndBounds();
    addPOIsToScene(multisetAnchor);
    addFacilitiesToScene(multisetAnchor);
    await refreshMediaGroup(multisetAnchor).catch((err) => console.warn('[media] refresh:', err));

    const frameMode = options.frameCamera;
    if (frameMode === false) {
      // leave camera
    } else if (frameMode === 'fit') {
      scheduleFrameCameraToMap();
    } else {
      placeCameraAtOrigin();
      schedulePlaceCameraAtOrigin();
    }
    onProgress?.(`First splat ready — loading remaining ${Math.max(total - 1, 0)}…`);
  };

  for (let i = 0; i < sceneOptions.length; i++) {
    if (loadGen !== splatMapLoadGeneration) {
      return { ok: false, error: 'Splat load cancelled', count: loaded, failed };
    }

    const opt = sceneOptions[i];
    const label = items[i]?.label || items[i]?.file_name || `file ${i + 1}`;
    onProgress?.(`Loading splat ${i + 1}/${total}: ${label}`);

    // Skip files that alone would exceed GPU texture packing (avoids 4096×32768 crash).
    try {
      const vertexCount = await peekPlyVertexCount(opt.path);
      if (vertexCount != null && vertexCount > hardSkipSplats) {
        skippedOversized += 1;
        const approxCountM = (vertexCount / 1e6).toFixed(1);
        const approxSafeM = (safeMaxSplats / 1e6).toFixed(1);
        console.warn(
          `[splat-map] Skip ${label}: ~${approxCountM}M splats ` +
            `exceeds GPU-safe ~${approxSafeM}M per file`,
        );
        onProgress?.(
          `Skipped ${label} (too large for GPU) — turn off other eyes or use a smaller PLY`,
        );
        await yieldToMain(16);
        continue;
      }
      if (vertexCount != null && vertexCount > safeMaxSplats) {
        const approxCountM = (vertexCount / 1e6).toFixed(1);
        const approxSafeM = (safeMaxSplats / 1e6).toFixed(1);
        console.warn(
          `[splat-map] Large ${label}: ~${approxCountM}M splats ` +
            `(GPU-safe ~${approxSafeM}M). Trying load anyway.`,
        );
      }
    } catch {
      /* peek failed — still try load */
    }

    const dropIn = createDropInSplatViewer();
    dropIn.name = `SplatGaussianViewer_${i}`;
    splatRoot.add(dropIn);
    mapRoot.userData.splatViewers.push(dropIn);
    // Back-compat: first viewer also on splatViewer
    if (!mapRoot.userData.splatViewer) {
      mapRoot.userData.splatViewer = dropIn;
    }

    try {
      await yieldToMain(16);

      const loadPromise = dropIn.addSplatScene(opt.path, {
        ...opt,
        // Each file is its own viewer — progressive is safe for every file.
        progressiveLoad: true,
        showLoadingUI: false,
        onProgress: (percentComplete, percentCompleteLabel) => {
          if (loadGen !== splatMapLoadGeneration) return;
          const pct = percentCompleteLabel || `${Math.round(percentComplete || 0)}%`;
          onProgress?.(`Splat ${i + 1}/${total}: ${pct}`);
        },
      });

      await new Promise((resolve, reject) => {
        loadPromise.then(resolve).catch(reject);
      });

      await waitForSplatViewerIdle(dropIn);
      await yieldToMain(32);

      loaded += 1;
      applySplatMapRotation(splatRoot);
      if (loaded === 1) {
        await onFirstReady();
      } else {
        ensureColliderAndBounds();
        onProgress?.(`Loaded ${loaded}/${total} splats…`);
      }
    } catch (err) {
      failed += 1;
      console.warn('[splat-map] Failed file', label, err);
      // Remove failed viewer so it does not sit empty in the scene.
      try {
        splatRoot.remove(dropIn);
        const list = mapRoot.userData.splatViewers;
        const idx = list.indexOf(dropIn);
        if (idx >= 0) list.splice(idx, 1);
        if (mapRoot.userData.splatViewer === dropIn) {
          mapRoot.userData.splatViewer = list[0] || null;
        }
        await Promise.resolve(dropIn.dispose?.());
      } catch {
        /* ignore */
      }
      onProgress?.(
        `Skipped ${label} (${failed} failed) — continuing ${i + 2 <= total ? i + 2 : total}/${total}…`,
      );
      await yieldToMain(50);
    }
  }

  if (loadGen !== splatMapLoadGeneration) {
    return { ok: false, error: 'Splat load cancelled', count: loaded, failed };
  }

  if (loaded === 0) {
    await clearMapMesh();
    const reason =
      skippedOversized > 0
        ? `Splat files exceed GPU texture limit (${skippedOversized} too large). Use smaller PLYs or fewer eye-on files.`
        : failed
          ? `Could not load any splat files (${failed} failed)`
          : 'Could not load splat .ply files';
    return { ok: false, error: reason, count: 0, failed, skippedOversized };
  }

  ensureColliderAndBounds();
  applySplatMapRotation(splatRoot);

  if (!firstReady) {
    await onFirstReady();
  }

  if (skippedOversized > 0) {
    onProgress?.(
      `Loaded ${loaded} splat(s); skipped ${skippedOversized} over GPU texture limit`,
    );
  }

  return { ok: true, count: loaded, failed, skippedOversized };
}

/** Keep orbit camera at world origin looking forward — splat map start pose. */
export function placeCameraAtOrigin() {
  if (!camera || !controls || !renderer) return false;
  flyAnimation = null;
  camera.position.set(0, 0, 0);
  controls.target.set(0, 0, -1);
  controls.minDistance = 0.05;
  controls.maxDistance = 2000;
  camera.near = 0.01;
  camera.far = 5000;
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  controls.update();
  return true;
}

/** Double-rAF so origin wins over any late auto-frame / resize. */
export function schedulePlaceCameraAtOrigin() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      placeCameraAtOrigin();
    });
  });
}

/** Fog washes out distance; keep geometric / mesh maps crisp (splats also stay fog-free). */
function setSplatMapRenderStyle(enabled) {
  if (!renderer || !scene) return;
  scene.fog = null;
  if (enabled) {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
  } else {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
  }
}

export function isSplatMapActive() {
  const mapMesh = multisetAnchor?.getObjectByName('MapMesh');
  return mapMesh?.userData?.mapKind === 'splat';
}

export function getCamera() {
  return camera;
}

/** OrbitControls look-at target (often near the map floor). */
export function getOrbitTarget() {
  return controls?.target?.clone() ?? null;
}

export function getCanvas() {
  return renderer ? renderer.domElement : null;
}

export function setOrbitEnabled(enabled) {
  if (controls) controls.enabled = enabled;
}

let ghostMeshOverlay = false;

function applyGhostRenderer() {
  if (!renderer || !scene) return;
  renderer.setClearColor(0x000000, 0);
  renderer.setClearAlpha(0);
  renderer.autoClear = true;
  scene.background = null;
  scene.fog = null;
  renderer.toneMapping = THREE.NoToneMapping;
  if (renderer.domElement) {
    const el = renderer.domElement;
    el.style.background = 'transparent';
    el.style.pointerEvents = 'none';
    // Keep WebGL from covering Showcase when the buffer is opaque for any reason.
    el.style.mixBlendMode = 'normal';
  }
  try {
    const gl = renderer.getContext();
    if (gl && !gl.getContextAttributes?.()?.alpha) {
      console.warn('[scene] WebGL context has no alpha — Matterport may be covered');
    }
  } catch {
    /* */
  }
}

function applyGhostMeshMaterials(enabled) {
  const root = multisetAnchor?.getObjectByName('MapMesh');
  if (!root) return;
  // Never draw the geometric GLB over Matterport — keep it for bounds / nav / heat only.
  if (enabled) {
    if (root.userData._ghostVisibleBackup === undefined) {
      root.userData._ghostVisibleBackup = root.visible;
    }
    root.visible = false;
  } else if (root.userData._ghostVisibleBackup !== undefined) {
    root.visible = root.userData._ghostVisibleBackup;
    delete root.userData._ghostVisibleBackup;
  }
}

const MP_ALIGN_ROOT = 'MatterportAlignRoot';

/**
 * Group that holds MapMesh / heat / navmesh for MultiSet→Matterport registration.
 * POIs stay on MultisetAnchor so they keep matching Showcase tags.
 */
export function getMatterportAlignRoot() {
  if (!multisetAnchor) return null;
  let root = multisetAnchor.getObjectByName(MP_ALIGN_ROOT);
  if (!root) {
    root = new THREE.Group();
    root.name = MP_ALIGN_ROOT;
    multisetAnchor.add(root);
  }
  return root;
}

function ensureMapMeshUnderAlignRoot() {
  const alignRoot = getMatterportAlignRoot();
  const mesh = multisetAnchor?.getObjectByName('MapMesh');
  if (!alignRoot || !mesh) return mesh;
  if (mesh.parent !== alignRoot) {
    alignRoot.attach(mesh);
  }
  return mesh;
}

/**
 * Undo MultiSet↔Matterport mesh align. Never leave MultisetAnchor itself transformed
 * (that desyncs Three.js POIs from Matterport tags).
 */
export function resetMatterportMapAlign() {
  if (!multisetAnchor) return;

  // Legacy bug: whole-anchor transform — always clear it.
  if (multisetAnchor.userData._mpAlignBackup) {
    const b = multisetAnchor.userData._mpAlignBackup;
    multisetAnchor.position.copy(b.position);
    multisetAnchor.quaternion.copy(b.quaternion);
    multisetAnchor.scale.copy(b.scale);
    delete multisetAnchor.userData._mpAlignBackup;
  } else {
    multisetAnchor.position.set(0, 0, 0);
    multisetAnchor.quaternion.identity();
    multisetAnchor.scale.set(1, 1, 1);
  }

  const alignRoot = multisetAnchor.getObjectByName(MP_ALIGN_ROOT);
  if (alignRoot) {
    alignRoot.position.set(0, 0, 0);
    alignRoot.quaternion.identity();
    alignRoot.scale.set(1, 1, 1);
    delete alignRoot.userData._mpAligned;
  }
  multisetAnchor.updateMatrixWorld(true);
}

/**
 * Align only the geometric map (and heat/nav parented under AlignRoot) to Matterport.
 * POI / facility markers stay on MultisetAnchor at Matterport XYZ so they match tags.
 * @param {{
 *   matterportBox: THREE.Box3,
 *   pois?: Array<{ poi_name?: string, name?: string, pos_x: number, pos_y: number, pos_z: number }>,
 * }} opts
 */
export function alignMultisetAnchorToMatterport(opts = {}) {
  const mpBox = opts.matterportBox;
  if (!multisetAnchor || !mpBox || mpBox.isEmpty()) {
    return { ok: false, error: 'Space map bounds unavailable' };
  }
  resetMatterportMapAlign();
  ensureMapMeshUnderAlignRoot();
  const alignRoot = getMatterportAlignRoot();
  const meshBox = getMapMeshBounds();
  if (!alignRoot || !meshBox || meshBox.isEmpty()) {
    return { ok: false, error: 'Geometric map not loaded' };
  }

  const meshSize = meshBox.getSize(new THREE.Vector3());
  const mpSize = mpBox.getSize(new THREE.Vector3());
  const meshCenter = meshBox.getCenter(new THREE.Vector3());

  let sx = meshSize.x > 0.2 ? mpSize.x / meshSize.x : 1;
  let sz = meshSize.z > 0.2 ? mpSize.z / meshSize.z : 1;
  let s = (sx + sz) / 2;
  if (!Number.isFinite(s) || s <= 0) s = 1;
  s = Math.min(6, Math.max(0.12, s));

  // Target = POI centroid (Matterport-authored) when it sits in the scan, else sweep center.
  const pois = Array.isArray(opts.pois) ? opts.pois : [];
  const club =
    pois.find((p) => /clubhouse/i.test(String(p.poi_name || p.name || ''))) || null;
  const poiPts = pois
    .map((p) => new THREE.Vector3(Number(p.pos_x), Number(p.pos_y), Number(p.pos_z)))
    .filter((v) => [v.x, v.y, v.z].every(Number.isFinite));

  const mpCenter = mpBox.getCenter(new THREE.Vector3());
  let target = mpCenter.clone();
  if (club) {
    const c = new THREE.Vector3(Number(club.pos_x), Number(club.pos_y), Number(club.pos_z));
    if ([c.x, c.y, c.z].every(Number.isFinite)) target.copy(c);
  } else if (poiPts.length) {
    const c = new THREE.Vector3();
    for (const p of poiPts) c.add(p);
    c.multiplyScalar(1 / poiPts.length);
    const pad = Math.max(mpSize.x, mpSize.z, 4) * 0.35;
    if (mpBox.clone().expandByScalar(pad).containsPoint(c)) target.copy(c);
  }

  const meshFloor = meshBox.min.y;
  const mpFloor = mpBox.min.y;

  alignRoot.scale.set(s, s, s);
  alignRoot.position.set(
    target.x - s * meshCenter.x,
    mpFloor - s * meshFloor,
    target.z - s * meshCenter.z,
  );
  alignRoot.userData._mpAligned = true;
  alignRoot.updateMatrixWorld(true);
  return { ok: true, scale: s, target: { x: target.x, y: target.y, z: target.z } };
}

/**
 * Hide Three.js POI/facility billboards while Matterport tags own those markers.
 * Prevents a second, drifting marker layer over Showcase.
 * @param {boolean} visible
 */
export function setMatterportSceneMarkersVisible(visible) {
  if (!multisetAnchor) return;
  for (const name of ['POIGroup', 'FacilityGroup', 'TreasureGroup']) {
    const g = multisetAnchor.getObjectByName(name);
    if (g) g.visible = Boolean(visible);
  }
}

/**
 * @deprecated Mesh is never shown over Matterport; kept as a no-op for call sites.
 * @param {boolean} [_enabled]
 */
export function setMatterportDollhouseMeshOverlay(_enabled) {
  // Intentionally empty — geometric MapMesh stays hidden; only heat / nav helpers render.
}

/**
 * Drive the geometric-mesh camera from Showcase pose (same XYZ / look).
 * @param {Record<string, unknown>} pose
 */
export function applyMatterportPoseToCamera(pose) {
  if (!ghostMeshOverlay || !camera || !controls || !pose) return;
  flyAnimation = null;
  const p = pose.position;
  const r = pose.rotation;
  if (p) {
    camera.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
  }
  if (r) {
    if (Number.isFinite(Number(r.w))) {
      camera.quaternion.set(Number(r.x) || 0, Number(r.y) || 0, Number(r.z) || 0, Number(r.w));
    } else {
      camera.rotation.set(Number(r.x) || 0, Number(r.y) || 0, Number(r.z) || 0);
    }
  }
  const proj = pose.projection || pose.projectionMatrix;
  if (Array.isArray(proj) && proj.length === 16) {
    camera.projectionMatrix.fromArray(proj);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  controls.target.copy(camera.position).addScaledVector(forward, 2);
}

/**
 * Transparent geometric mesh composited over the photoreal space map.
 * Navmesh / heat map / POIs stay on this mesh; camera follows Showcase XYZ.
 * @param {boolean} enabled
 */
export function setMatterportMeshCompositor(enabled) {
  ghostMeshOverlay = Boolean(enabled);
  if (ghostMeshOverlay) {
    resetMatterportMapAlign();
    applyGhostRenderer();
    applyGhostMeshMaterials(true);
    setMatterportSceneMarkersVisible(false);
    setOrbitEnabled(false);
    onMatterportCameraPose(applyMatterportPoseToCamera);
    // Never let the main WebGL canvas obscure Showcase (opaque clear / bad pose = black screen).
    if (renderer?.domElement) {
      renderer.domElement.style.visibility = 'hidden';
      renderer.domElement.style.opacity = '0';
    }
  } else {
    onMatterportCameraPose(null);
    resetMatterportMapAlign();
    applyGhostMeshMaterials(false);
    setMatterportSceneMarkersVisible(true);
    setOrbitEnabled(true);
    if (renderer?.domElement) {
      renderer.domElement.style.pointerEvents = '';
      renderer.domElement.style.visibility = '';
      renderer.domElement.style.opacity = '';
    }
    applySceneTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  }
}

export function isMatterportMeshCompositorActive() {
  return ghostMeshOverlay;
}

const SCENE_BG = {
  light: 0xeef4fb,
  dark: 0x0f1219,
};

/** Sync Three.js canvas with light / dark glass shell. @param {'light' | 'dark'} theme */
export function applySceneTheme(theme) {
  if (!renderer || !scene) return;
  if (ghostMeshOverlay) {
    applyGhostRenderer();
    return;
  }
  const color = theme === 'dark' ? SCENE_BG.dark : SCENE_BG.light;
  renderer.setClearColor(color, 1);
  scene.background = new THREE.Color(color);
  // No distance fog — it made geometric mesh look smoky / washed out.
  scene.fog = null;
}

/**
 * Fast capability check before creating Three renderer.
 * @returns {boolean}
 */
export function canCreateWebGLContext() {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    return Boolean(gl);
  } catch {
    return false;
  }
}

/**
 * Create a best-effort WebGL context (prefer WebGL2, fallback WebGL1).
 * @returns {{ canvas: HTMLCanvasElement, context: WebGL2RenderingContext | WebGLRenderingContext } | null}
 */
function createBestEffortWebGLContext() {
  try {
    const canvas = document.createElement('canvas');
    const tier = getDeviceTier();
    const attempts = [
      { webgl2: true, antialias: tier !== 'low', powerPreference: 'high-performance' },
      { webgl2: true, antialias: false, powerPreference: 'default' },
      { webgl2: true, antialias: false, powerPreference: 'low-power' },
      { webgl2: false, antialias: false, powerPreference: 'default' },
    ];

    for (const attempt of attempts) {
      const attrs = {
        antialias: attempt.antialias,
        alpha: true,
        premultipliedAlpha: true,
        powerPreference: attempt.powerPreference,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false,
      };

      const context = attempt.webgl2
        ? canvas.getContext('webgl2', attrs)
        : canvas.getContext('webgl', attrs) ||
          canvas.getContext('experimental-webgl', attrs);

      if (context) {
        return { canvas, context, antialias: attempt.antialias, tier };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Initialize the 3D viewer scene.
 * @param {HTMLElement} container
 */
export function initScene(container) {
  const ctxPack = createBestEffortWebGLContext();
  if (!ctxPack) {
    throw new Error(
      'WebGL is unavailable in this browser/session. Enable hardware acceleration or open in a non-sandboxed browser session.'
    );
  }
  _container = container;
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  // Renderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: ctxPack.canvas,
      context: ctxPack.context,
      antialias: ctxPack.antialias,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: ctxPack.tier === 'low' ? 'low-power' : 'high-performance',
    });
  } catch {
    throw new Error(
      'WebGL renderer initialization failed. Check GPU access/hardware acceleration and browser sandbox restrictions.'
    );
  }
  renderer.setPixelRatio(getRecommendedPixelRatio());
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.fog = null;

  applySceneTheme('light');

  // Camera
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
  camera.position.set(5, 8, 12);
  camera.lookAt(0, 0, 0);

  // Orbit controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 200;
  controls.target.set(0, 0, 0);

  // TransformControls (gizmo)
  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode('translate');
  transformControls.setSize(0.8);
  scene.add(transformControls.getHelper());

  // Disable orbit while dragging the gizmo
  transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
    if (!event.value && onGizmoDragEnd) onGizmoDragEnd();
  });

  // Fire callback on gizmo change (object-change fires per-frame while dragging)
  transformControls.addEventListener('objectChange', () => {
    const obj = transformControls.object;
    if (!obj) return;
    
    if (onGizmoDrag) {
      onGizmoDrag({
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
      });
    }
  });

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = false;
  scene.add(dirLight);

  const hemiLight = new THREE.HemisphereLight(0xcbd5e1, 0x334155, 0.48);
  scene.add(hemiLight);

  // MultiSet anchor group — mesh goes here
  multisetAnchor = new THREE.Group();
  multisetAnchor.name = 'MultiSetAnchor';
  scene.add(multisetAnchor);

  // Handle resize
  window.addEventListener('resize', onResize);
  setupViewportAutoFrame(container);

  installSceneInteractionHandlers();

  isInitialized = true;
  animate();
}

/** Re-frame once when the viewport first gets real dimensions (before map paint). */
function setupViewportAutoFrame(container) {
  if (typeof ResizeObserver === 'undefined') return;
  let didLayoutFrame = false;
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w < 16 || h < 16) return;
    onResize();
    if (!didLayoutFrame) {
      didLayoutFrame = true;
      scheduleFrameCameraToMap();
    }
  });
  ro.observe(container);
}

function isBlockDrawMode(mode = sceneInteractionMode) {
  return mode === 'draw-block' || mode === 'draw-stairs';
}

function blockDrawPreviewColor(mode = sceneInteractionMode) {
  return mode === 'draw-stairs' ? 0x7c3aed : 0xa855f7;
}

/**
 * @param {SceneInteractionMode} mode
 */
export function setSceneInteractionMode(mode) {
  sceneInteractionMode =
    mode === 'walk' ||
    mode === 'add-poi' ||
    mode === 'add-facility' ||
    mode === 'add-media' ||
    mode === 'add-treasure' ||
    mode === 'draw-block' ||
    mode === 'draw-stairs'
      ? mode
      : 'default';
  updateSceneCursor();
  if (sceneInteractionMode !== 'default') {
    setHoveredPoiLabel(-1);
  }
  if (
    sceneInteractionMode !== 'add-poi' &&
    sceneInteractionMode !== 'add-facility' &&
    sceneInteractionMode !== 'add-media' &&
    sceneInteractionMode !== 'add-treasure'
  ) {
    hidePlacementPreview();
  }
  if (!isBlockDrawMode(sceneInteractionMode)) {
    cancelBlockDraw();
  }
}

/** @param {(rect: { pos_x: number, pos_y: number, pos_z: number, width: number, depth: number }) => void} cb */
export function setOnSceneBlockDraw(cb) {
  onSceneBlockDraw = cb;
}

function ensureBlockDrawPreview() {
  if (blockDrawPreview || !scene) return blockDrawPreview;
  const box = new THREE.BoxGeometry(1, 0.15, 1);
  const edges = new THREE.EdgesGeometry(box);
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0xa855f7, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  const fill = new THREE.Mesh(
    box,
    new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const g = new THREE.Group();
  g.name = 'BlockDrawPreview';
  g.add(fill);
  g.add(line);
  g.visible = false;
  scene.add(g);
  blockDrawPreview = g;
  return g;
}

function updateBlockDrawPreview(start, end) {
  const g = ensureBlockDrawPreview();
  if (!g || !start || !end) return;
  const color = blockDrawPreviewColor();
  const line = g.children.find((c) => c.isLineSegments);
  const fill = g.children.find((c) => c.isMesh);
  if (line?.material?.color) line.material.color.setHex(color);
  if (fill?.material?.color) fill.material.color.setHex(color);
  const width = Math.max(Math.abs(end.x - start.x), 0.1);
  const depth = Math.max(Math.abs(end.z - start.z), 0.1);
  const posY = (start.y + end.y) / 2;
  g.position.set((start.x + end.x) / 2, posY + 0.08, (start.z + end.z) / 2);
  g.scale.set(width, 1, depth);
  g.visible = true;
}

export function hideBlockDrawPreview() {
  if (blockDrawPreview) blockDrawPreview.visible = false;
}

export function cancelBlockDraw() {
  blockDrawActive = false;
  blockDrawStartPt = null;
  hideBlockDrawPreview();
  setOrbitEnabled(true);
}

/** @returns {SceneInteractionMode} */
export function getSceneInteractionMode() {
  return sceneInteractionMode;
}

/** @param {(point: THREE.Vector3, mode: SceneInteractionMode) => void} cb */
export function setOnSceneMapClick(cb) {
  onSceneMapClick = cb;
}

/**
 * Raycast the map mesh (or ground plane) from screen coordinates.
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ mapOnly?: boolean }} [options] — mapOnly: only hit MapMesh (no infinite ground). Use for Go-to.
 * @returns {THREE.Vector3 | null}
 */
export function raycastMapPoint(clientX, clientY, options = {}) {
  const canvas = renderer?.domElement;
  if (!canvas || !camera) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  poiPickNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  poiPickNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  poiPickRaycaster.setFromCamera(poiPickNdc, camera);

  const mapRoot =
    multisetAnchor?.getObjectByName('MapMesh') ?? scene?.getObjectByName('MapMesh');
  if (mapRoot) {
    const hits = poiPickRaycaster.intersectObject(mapRoot, true);
    const meshHit = hits.find((h) => h.object?.isMesh && h.object.visible !== false);
    if (meshHit) {
      const pt = meshHit.point.clone();
      return clampPointToMapBounds(pt);
    }
  }

  if (options.mapOnly) return null;

  const hit = new THREE.Vector3();
  if (!poiPickRaycaster.ray.intersectPlane(groundPlane, hit)) return null;
  return clampPointToMapBounds(hit);
}

/** @returns {THREE.Box3 | null} */
export function getMapContentBounds() {
  const mapMesh = multisetAnchor?.getObjectByName('MapMesh');
  const cached = mapMesh?.userData?.contentBounds;
  if (cached?.isBox3 && !cached.isEmpty()) return cached.clone();
  const box = computeMapContentBox();
  return box.isEmpty() ? null : box;
}

/**
 * Keep a world point inside the map AABB (XZ primarily) so Go-to cannot leave the map.
 * @param {THREE.Vector3} point
 * @param {number} [margin=0.35]
 * @returns {THREE.Vector3}
 */
export function clampPointToMapBounds(point, margin = 0.35) {
  const box = getMapContentBounds();
  if (!box || !point) return point;
  const size = box.getSize(new THREE.Vector3());
  const m = Math.min(
    margin,
    Math.max(0, size.x * 0.5 - 0.05),
    Math.max(0, size.z * 0.5 - 0.05),
  );
  const out = point.clone();
  out.x = THREE.MathUtils.clamp(out.x, box.min.x + m, box.max.x - m);
  out.z = THREE.MathUtils.clamp(out.z, box.min.z + m, box.max.z - m);
  if (size.y > 0.2) {
    out.y = THREE.MathUtils.clamp(out.y, box.min.y, box.max.y);
  }
  return out;
}

function ensurePlacementPreview() {
  if (placementPreview || !scene) return placementPreview;
  const g = new THREE.Group();
  g.name = 'PlacementPreview';

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.42, 40),
    new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x14b8a6, depthTest: false }),
  );
  dot.position.y = 0.12;
  g.add(dot);

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.35, 8),
    new THREE.MeshBasicMaterial({ color: 0x0d9488, depthTest: false }),
  );
  stem.position.y = 0.28;
  g.add(stem);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x2dd4bf, depthTest: false }),
  );
  head.position.y = 0.5;
  g.add(head);

  g.visible = false;
  scene.add(g);
  placementPreview = g;
  return g;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
const PLACEMENT_COLORS = {
  poi: { ring: 0x2dd4bf, dot: 0x14b8a6, stem: 0x0d9488, head: 0x2dd4bf },
  facility: { ring: 0x38bdf8, dot: 0x0ea5e9, stem: 0x0284c7, head: 0x7dd3fc },
  media: { ring: 0xc084fc, dot: 0xa855f7, stem: 0x9333ea, head: 0xe9d5ff },
};

function applyPlacementPreviewColors(kind) {
  const g = placementPreview;
  if (!g) return;
  const c = PLACEMENT_COLORS[kind === 'media' ? 'media' : kind === 'facility' ? 'facility' : 'poi'];
  const ring = g.children[0];
  const dot = g.children[1];
  const stem = g.children[2];
  const head = g.children[3];
  if (ring?.material?.color) ring.material.color.setHex(c.ring);
  if (dot?.material?.color) dot.material.color.setHex(c.dot);
  if (stem?.material?.color) stem.material.color.setHex(c.stem);
  if (head?.material?.color) head.material.color.setHex(c.head);
}

export function showPlacementPreview(x, y, z) {
  const g = ensurePlacementPreview();
  if (!g) return;
  applyPlacementPreviewColors(
    sceneInteractionMode === 'add-media' || sceneInteractionMode === 'add-treasure'
      ? 'media'
      : sceneInteractionMode === 'add-facility'
        ? 'facility'
        : 'poi',
  );
  g.position.set(x, y, z);
  g.visible = true;
}

export function hidePlacementPreview() {
  if (placementPreview) placementPreview.visible = false;
}

const FOOTPRINT_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2'%3E%3Ccircle cx='12' cy='12' r='7'/%3E%3C/svg%3E\") 12 12, crosshair";

const ADD_POI_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%230d9488' stroke-width='2'%3E%3Cpath d='M12 21s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11z'/%3E%3Cline x1='12' y1='7' x2='12' y2='13'/%3E%3Cline x1='9' y1='10' x2='15' y2='10'/%3E%3C/svg%3E\") 12 22, crosshair";

const ADD_MEDIA_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%239333ea' stroke-width='2'%3E%3Crect x='4' y='5' width='16' height='14' rx='2'/%3E%3Cline x1='12' y1='8' x2='12' y2='14'/%3E%3Cline x1='9' y1='11' x2='15' y2='11'/%3E%3C/svg%3E\") 12 22, crosshair";

const DRAW_BLOCK_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23a855f7' stroke-width='2'%3E%3Crect x='4' y='4' width='16' height='16' rx='1'/%3E%3C/svg%3E\") 12 12, crosshair";

function updateSceneCursor() {
  const canvas = renderer?.domElement;
  if (!canvas) return;
  if (sceneInteractionMode === 'walk') {
    canvas.style.cursor = FOOTPRINT_CURSOR;
  } else if (sceneInteractionMode === 'add-media' || sceneInteractionMode === 'add-treasure') {
    canvas.style.cursor = ADD_MEDIA_CURSOR;
  } else if (sceneInteractionMode === 'add-poi' || sceneInteractionMode === 'add-facility') {
    canvas.style.cursor = ADD_POI_CURSOR;
  } else if (isBlockDrawMode(sceneInteractionMode)) {
    canvas.style.cursor = DRAW_BLOCK_CURSOR;
  } else {
    canvas.style.cursor = '';
  }
}

function installSceneInteractionHandlers() {
  const canvas = renderer.domElement;
  let downX = 0;
  let downY = 0;
  /** @type {number} */
  let placementMoveRaf = 0;
  /** @type {{ x: number, y: number } | null} */
  let pendingPlacementMove = null;
  /** @type {number} */
  let hoverMoveRaf = 0;
  /** @type {{ x: number, y: number } | null} */
  let pendingHoverMove = null;

  const flushPlacementPreview = () => {
    placementMoveRaf = 0;
    const pending = pendingPlacementMove;
    pendingPlacementMove = null;
    if (!pending) return;
    if (
      sceneInteractionMode !== 'add-poi' &&
      sceneInteractionMode !== 'add-facility' &&
      sceneInteractionMode !== 'add-media' &&
      sceneInteractionMode !== 'add-treasure'
    ) {
      return;
    }
    const pt = raycastMapPoint(pending.x, pending.y);
    if (pt) showPlacementPreview(pt.x, pt.y, pt.z);
    else hidePlacementPreview();
  };

  const flushPoiHoverLabel = () => {
    hoverMoveRaf = 0;
    const pending = pendingHoverMove;
    pendingHoverMove = null;
    if (!pending) return;
    if (sceneInteractionMode !== 'default') {
      setHoveredPoiLabel(-1);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    poiPickNdc.x = ((pending.x - rect.left) / rect.width) * 2 - 1;
    poiPickNdc.y = -((pending.y - rect.top) / rect.height) * 2 + 1;
    poiPickRaycaster.setFromCamera(poiPickNdc, camera);
    const poiMeshes = getPOIObjects()
      .map((o) => o.mesh)
      .filter(Boolean);
    if (!poiMeshes.length) {
      setHoveredPoiLabel(-1);
      return;
    }
    const hits = poiPickRaycaster.intersectObjects(poiMeshes, false);
    if (!hits.length) {
      setHoveredPoiLabel(-1);
      return;
    }
    const idx = hits[0].object?.userData?.poiIndex;
    setHoveredPoiLabel(typeof idx === 'number' ? idx : -1);
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    if (isBlockDrawMode(sceneInteractionMode)) {
      const pt = raycastMapPoint(e.clientX, e.clientY);
      if (pt) {
        blockDrawStartPt = pt.clone();
        blockDrawActive = true;
        setOrbitEnabled(false);
        updateBlockDrawPreview(blockDrawStartPt, blockDrawStartPt);
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (isBlockDrawMode(sceneInteractionMode) && blockDrawActive && blockDrawStartPt) {
      const pt = raycastMapPoint(e.clientX, e.clientY);
      if (pt) updateBlockDrawPreview(blockDrawStartPt, pt);
      return;
    }
    if (
      sceneInteractionMode === 'add-poi' ||
      sceneInteractionMode === 'add-facility' ||
      sceneInteractionMode === 'add-media' ||
      sceneInteractionMode === 'add-treasure'
    ) {
      pendingPlacementMove = { x: e.clientX, y: e.clientY };
      if (!placementMoveRaf) {
        placementMoveRaf = requestAnimationFrame(flushPlacementPreview);
      }
      return;
    }
    // Default mode: show POI name on hover (geometric mesh).
    pendingHoverMove = { x: e.clientX, y: e.clientY };
    if (!hoverMoveRaf) {
      hoverMoveRaf = requestAnimationFrame(flushPoiHoverLabel);
    }
  });

  canvas.addEventListener('pointerleave', () => {
    pendingPlacementMove = null;
    pendingHoverMove = null;
    setHoveredPoiLabel(-1);
    if (
      sceneInteractionMode === 'add-poi' ||
      sceneInteractionMode === 'add-facility' ||
      sceneInteractionMode === 'add-media' ||
      sceneInteractionMode === 'add-treasure'
    ) {
      hidePlacementPreview();
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;

    if (isBlockDrawMode(sceneInteractionMode) && blockDrawActive && blockDrawStartPt) {
      blockDrawActive = false;
      setOrbitEnabled(true);
      const pt = raycastMapPoint(e.clientX, e.clientY);
      hideBlockDrawPreview();
      if (pt) {
        const width = Math.abs(pt.x - blockDrawStartPt.x);
        const depth = Math.abs(pt.z - blockDrawStartPt.z);
        if (width >= 0.25 && depth >= 0.25 && onSceneBlockDraw) {
          onSceneBlockDraw({
            pos_x: (blockDrawStartPt.x + pt.x) / 2,
            pos_y: (blockDrawStartPt.y + pt.y) / 2,
            pos_z: (blockDrawStartPt.z + pt.z) / 2,
            width,
            depth,
          });
        }
      }
      blockDrawStartPt = null;
      return;
    }

    const distSq = (e.clientX - downX) ** 2 + (e.clientY - downY) ** 2;
    if (distSq > 64) return;

    if (
      sceneInteractionMode === 'walk' ||
      sceneInteractionMode === 'add-poi' ||
      sceneInteractionMode === 'add-facility' ||
      sceneInteractionMode === 'add-media' ||
      sceneInteractionMode === 'add-treasure'
    ) {
      const pt = raycastMapPoint(e.clientX, e.clientY, {
        mapOnly: sceneInteractionMode === 'walk',
      });
      if (pt && onSceneMapClick) onSceneMapClick(pt, sceneInteractionMode);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    poiPickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    poiPickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    poiPickRaycaster.setFromCamera(poiPickNdc, camera);
    const blockMeshes = getBlockMeshes();
    const poiMeshes = getPOIObjects()
      .map((o) => o.mesh)
      .filter(Boolean);
    const facilityMeshes = getFacilityObjects()
      .map((o) => o.mesh)
      .filter(Boolean);
    const pickables = [...blockMeshes, ...poiMeshes, ...facilityMeshes];
    const hits = poiPickRaycaster.intersectObjects(pickables, false);
    if (hits.length > 0) {
      const obj = hits[0].object;
      if (obj.userData.blockId != null) {
        if (onBlockPickedFromCanvas) onBlockPickedFromCanvas(obj.userData.blockId);
        return;
      }
      const facilityIdx = obj.userData.facilityIndex;
      if (typeof facilityIdx === 'number' && facilityIdx >= 0) {
        if (onFacilityPickedFromCanvas) onFacilityPickedFromCanvas(facilityIdx);
        return;
      }
      const idx = obj.userData.poiIndex;
      if (typeof idx === 'number' && idx >= 0) {
        lastPickedPoiIndex = idx;
        if (onPoiPickedFromCanvas) onPoiPickedFromCanvas(idx);
      }
    }
  });

  window.addEventListener('keydown', onFlyToPickedPoiKeydown);
  window.addEventListener('keydown', onSceneToolEscapeKeydown);
}

function onSceneToolEscapeKeydown(e) {
  if (e.key !== 'Escape') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (sceneInteractionMode === 'default') return;
  setSceneInteractionMode('default');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('spacecheck-scene-tool-cancel'));
  }
}

function onFlyToPickedPoiKeydown(e) {
  if (e.key?.toLowerCase?.() !== 'f') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (lastPickedPoiIndex < 0) return;
  const p = poisData[lastPickedPoiIndex];
  if (!p) return;
  e.preventDefault();
  flyTo(p.pos_x, p.pos_y, p.pos_z, {
    entityKind: 'poi',
    entityId: p.id,
  });
}

function onResize() {
  if (!camera || !renderer) return;
  const w = _container ? _container.clientWidth : window.innerWidth;
  const h = _container ? _container.clientHeight : window.innerHeight;
  if (!ghostMeshOverlay) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.setSize(w, h);
}

let flyAnimation = null;

function animate() {
  requestAnimationFrame(animate);
  if (!isInitialized) return;

  // Handle fly-to animation (Showcase pose drives the camera in compositor mode)
  if (flyAnimation && !ghostMeshOverlay) {
    const now = performance.now();
    const dur = Math.max(1, flyAnimation.durationMs || 1200);
    const raw = Math.min(1, (now - flyAnimation.t0) / dur);
    const t = easeInOutQuint(raw);
    if (raw >= 1) {
      camera.position.copy(flyAnimation.endPos);
      controls.target.copy(flyAnimation.endTarget);
      flyAnimation = null;
    } else {
      camera.position.lerpVectors(flyAnimation.startPos, flyAnimation.endPos, t);
      controls.target.lerpVectors(flyAnimation.startTarget, flyAnimation.endTarget, t);
      // Soft lift through the middle of the flight so long moves feel less linear.
      if (flyAnimation.arcLift > 0) {
        const arc = Math.sin(Math.PI * raw) * flyAnimation.arcLift;
        camera.position.y += arc;
      }
    }
  }

  tickNavigation();
  // OrbitControls must not overwrite Showcase-driven pose (that paints a black void over the iframe).
  if (ghostMeshOverlay) {
    applyGhostRenderer();
    if (controls) controls.enabled = false;
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
}

function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

/**
 * Smoothly fly the camera to look at a point (x, y, z).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ close?: boolean, walk?: boolean, endPos?: THREE.Vector3, endTarget?: THREE.Vector3, speed?: number, durationMs?: number, tagId?: string | null, entityKind?: string, entityId?: string | number, sweepFrom?: { x: number, y: number, z: number } | null }} [options]
 *   — close: legacy near-zoom; walk: free-flow stand-on-point; endPos/endTarget override pose
 *   — sweepFrom: Matterport only — walkable XYZ used to pick the sweep (look-at stays x,y,z)
 */
export function flyTo(x, y, z, options = {}) {
  // Matterport / space map: always fly Showcase to the nearest sweep facing the point.
  if (shouldUseMatterportCamera()) {
    flyAnimation = null;
    const tagId =
      options.tagId ||
      (options.entityKind && options.entityId != null
        ? getMatterportTagId(options.entityKind, options.entityId)
        : null);
    const dest = { x: Number(x), y: Number(y), z: Number(z) };
    void matterportGoToPoint(dest, {
      tagId,
      preferSweep: true,
      transition: 'fade',
      transitionTime: options.durationMs ?? 900,
      sweepFrom: options.sweepFrom || null,
    });
    return;
  }

  if (!camera || !controls) return;
  // Ensure orbit isn't left disabled after compositor / gizmo sessions.
  controls.enabled = true;

  let endPos;
  let endTarget;

  if (options.endPos && options.endTarget) {
    endPos = options.endPos.clone();
    endTarget = options.endTarget.clone();
  } else if (options.walk) {
    // Free-flow: stand at the point (eye height) and look ahead — no partial steps / no hard clamp.
    const feet = new THREE.Vector3(x, y, z);
    endPos = feet.clone();
    endPos.y += 1.55;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    endTarget = endPos.clone().add(forward.multiplyScalar(3));
    endTarget.y = feet.y + 0.2;
  } else {
    const clamped = clampPointToMapBounds(new THREE.Vector3(x, y, z));
    endTarget = clamped.clone();
    endTarget.y += 0.25;
    if (options.close) {
      const toTarget = clamped.clone().sub(camera.position);
      const dist = toTarget.length();
      if (dist > 0.15) {
        toTarget.normalize();
        const step = Math.min(dist * 0.85, Math.max(dist - 0.4, 0));
        endPos = camera.position.clone().add(toTarget.multiplyScalar(step));
      } else {
        endPos = camera.position.clone();
      }
      endPos.y = Math.max(endPos.y, clamped.y + 1.35);
    } else {
      // Keep current view direction; settle at a comfortable orbit distance.
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 1e-4) offset.set(3, 5, 8);
      const dist = Math.min(12, Math.max(4.5, offset.length()));
      offset.normalize().multiplyScalar(dist);
      endPos = clamped.clone().add(offset);
      endPos.y = Math.max(endPos.y, clamped.y + 2.0);
    }
  }

  const startPos = camera.position.clone();
  const travel = startPos.distanceTo(endPos);
  // Distance-aware duration so short hops stay calm and long moves stay silky.
  let durationMs = options.durationMs;
  if (!(durationMs > 0)) {
    if (options.speed > 0) {
      // Legacy speed (~0.02–0.05 per frame) → approximate ms.
      durationMs = Math.round(1000 / (options.speed * 60));
    } else if (options.walk) {
      durationMs = Math.min(1600, Math.max(900, 700 + travel * 55));
    } else if (options.close) {
      durationMs = Math.min(1400, Math.max(750, 650 + travel * 70));
    } else {
      durationMs = Math.min(1800, Math.max(1100, 900 + travel * 45));
    }
  }
  const arcLift = options.walk ? 0 : Math.min(1.8, travel * 0.06);

  flyAnimation = {
    t0: performance.now(),
    durationMs,
    arcLift,
    startPos,
    endPos,
    startTarget: controls.target.clone(),
    endTarget,
  };
}

/**
 * Apply a VPS pose to the MultiSet anchor group.
 * @param {{x: number, y: number, z: number}} position
 * @param {{x: number, y: number, z: number, w: number}} quaternion
 */
export function applyVPSPose(position, quaternion) {
  if (!multisetAnchor) return;
  multisetAnchor.position.set(position.x, position.y, position.z);
  multisetAnchor.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
}

/** 'shaded' | 'wireframe' | 'heatmap' */
let mapDisplayMode = 'shaded';
/** Per-user heat map (user panel) also renders the map as wireframe. */
let userHeatmapWireframe = false;

function isMapWireframeActive() {
  return mapDisplayMode === 'wireframe' || mapDisplayMode === 'heatmap' || userHeatmapWireframe;
}

function applyMapMeshWireframe(wireframe) {
  if (typeof document !== 'undefined' && document.body.classList.contains('matterport-map-active')) {
    return;
  }
  const root = multisetAnchor?.getObjectByName('MapMesh');
  if (!root) return;
  root.traverse((child) => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (mat && 'wireframe' in mat) {
          mat.wireframe = wireframe;
          mat.needsUpdate = true;
        }
      }
    }
  });
}

/** Ensure embedded GLB textures use correct color space and render with authored colors. */
function prepareMapMeshMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    child.castShadow = false;
    child.receiveShadow = false;

    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      mat.wireframe = false;

      for (const key of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
        const tex = mat[key];
        if (tex?.isTexture) {
          if (key === 'map' || key === 'emissiveMap') {
            tex.colorSpace = THREE.SRGBColorSpace;
          }
          tex.needsUpdate = true;
        }
      }
      mat.needsUpdate = true;
    }
  });
}

/**
 * @typedef {Object} MapMeshPart
 * @property {THREE.Object3D} scene
 * @property {{ position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number } } | null} [relativePose]
 * @property {string} [mapCode]
 */

/**
 * Apply a map-set relative pose to a loaded GLB root.
 * @param {THREE.Object3D} root
 * @param {MapMeshPart['relativePose']} relativePose
 */
function applyMapRelativePose(root, relativePose) {
  if (!relativePose) return;
  const { position, quaternion } = relativePose;
  root.position.set(position.x, position.y, position.z);
  root.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  root.updateMatrix();
}

/**
 * Add loaded GLTF scene(s) to the MultiSet anchor group.
 * Geometry renders immediately; textures stream in on a background schedule.
 * @param {THREE.Object3D | MapMeshPart | MapMeshPart[]} gltfSceneOrParts
 * @param {{
 *   lazyTextures?: boolean,
 *   frameCamera?: boolean,
 *   onTextureProgress?: (loaded: number, total: number) => void,
 * }} [options]
 */
export function addMesh(gltfSceneOrParts, options = {}) {
  if (!multisetAnchor) return;

  /** @type {MapMeshPart[]} */
  const parts = normalizeMapMeshParts(gltfSceneOrParts);
  if (parts.length === 0) return;

  cancelLazyMapTextures();

  const existing = multisetAnchor.getObjectByName('MapMesh');
  if (existing) multisetAnchor.remove(existing);

  const useLazyTextures = options.lazyTextures !== false;
  /** @type {import('./map-texture-loader.js').StashedTextureEntry[]} */
  let textureEntries = [];

  const mapRoot = new THREE.Group();
  mapRoot.name = 'MapMesh';

  for (const part of parts) {
    const { scene, relativePose, mapCode } = part;
    if (mapCode) scene.name = `MapMesh_${mapCode}`;
    applyMapRelativePose(scene, relativePose ?? null);

    if (useLazyTextures) {
      textureEntries = textureEntries.concat(stashMapTextures(scene));
    } else {
      prepareMapMeshMaterials(scene);
    }

    mapRoot.add(scene);
  }

  multisetAnchor.add(mapRoot);
  const alignRoot = multisetAnchor.getObjectByName('MatterportAlignRoot');
  if (alignRoot) alignRoot.attach(mapRoot);
  mapRoot.updateWorldMatrix(true, true);
  const meshBox = new THREE.Box3().setFromObject(mapRoot);
  if (!meshBox.isEmpty()) mapRoot.userData.contentBounds = meshBox.clone();

  applyMapMeshWireframe(isMapWireframeActive());
  if (ghostMeshOverlay) applyGhostMeshMaterials(true);

  addPOIsToScene(multisetAnchor);
  addFacilitiesToScene(multisetAnchor);
  refreshMediaGroup(multisetAnchor).catch((err) => console.warn('[media] refresh:', err));

  if (options.frameCamera !== false && !ghostMeshOverlay) {
    scheduleFrameCameraToMap();
  }

  if (useLazyTextures && textureEntries.length > 0) {
    lazyLoadMapTextures(textureEntries, {
      onProgress: options.onTextureProgress,
    }).catch((err) => console.warn('[map-textures] lazy load:', err));
  } else if (useLazyTextures) {
    options.onTextureProgress?.(0, 0);
  }
}

/**
 * Lower GPU cost when textured map is active (Astra-style).
 * @param {'raw'|'textured'} mode
 */
export function setMapPerformanceMode(mode) {
  if (!renderer || !_container) return;
  if (ghostMeshOverlay) {
    applyGhostRenderer();
    onResize();
    return;
  }
  if (mode === 'textured') {
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.NoToneMapping;
  } else {
    renderer.setPixelRatio(getRecommendedPixelRatio());
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }
  onResize();
}

/**
 * @param {THREE.Object3D | MapMeshPart | MapMeshPart[]} input
 * @returns {MapMeshPart[]}
 */
function normalizeMapMeshParts(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.filter((part) => part?.scene);
  }
  if (input.isObject3D) {
    return [{ scene: input, relativePose: null }];
  }
  if (input.scene?.isObject3D) {
    return [input];
  }
  return [];
}

/**
 * @param {'shaded' | 'wireframe' | 'heatmap'} mode
 */
export function setMapDisplayMode(mode) {
  if (mode === 'heatmap') {
    mapDisplayMode = 'heatmap';
  } else {
    mapDisplayMode = mode === 'wireframe' ? 'wireframe' : 'shaded';
  }
  applyMapMeshWireframe(isMapWireframeActive());
}

/**
 * Toggle wireframe for the per-user heat map (user panel), independent of the
 * global Display mode select.
 * @param {boolean} enabled
 */
export function setUserHeatmapWireframe(enabled) {
  userHeatmapWireframe = Boolean(enabled);
  applyMapMeshWireframe(isMapWireframeActive());
}

export function getMapDisplayMode() {
  return mapDisplayMode;
}

/** @returns {THREE.Box3} */
function computeMapContentBox() {
  const box = new THREE.Box3();
  if (!multisetAnchor) return box;

  multisetAnchor.updateWorldMatrix(true, true);

  const mapMesh = multisetAnchor.getObjectByName('MapMesh');
  if (mapMesh?.userData?.mapKind === 'splat') {
    // Never use the invisible collider plane — it pulls the camera hundreds of units away
    // and fog turns the splat into a blank canvas.
    mapMesh.traverse((obj) => {
      if (obj.name === 'SplatMapCollider' || obj.userData?.excludeFromBounds) return;
      if (obj.isMesh && obj.material && obj.material.colorWrite === false) return;
      if (obj.isMesh || obj.isPoints) {
        box.expandByObject(obj);
      }
    });
    // Splat meshes often have empty classic bounds; fall back to a local origin volume.
    if (box.isEmpty()) {
      box.set(new THREE.Vector3(-20, -20, -20), new THREE.Vector3(20, 20, 20));
      box.applyMatrix4(mapMesh.matrixWorld);
    }
    return box;
  }

  if (mapMesh) {
    box.setFromObject(mapMesh);
    if (!box.isEmpty()) return box;
  }

  multisetAnchor.traverse((obj) => {
    if (
      obj.name === 'PlacementPreview' ||
      obj.name === 'BlockDrawPreview' ||
      obj.name === 'GlobalNavHeatmap' ||
      obj.name === 'UserNavHeatmap' ||
      obj.name === 'NavmeBlocks' ||
      obj.name === 'SplatMapCollider'
    ) {
      return;
    }
    if (obj.isMesh || obj.isPoints) {
      box.expandByObject(obj);
    }
  });

  return box;
}

/**
 * Orbit (0, 0, 0) — map extent only sets how close we zoom in.
 * @param {{ padding?: number }} [options]
 * @returns {boolean} true when framing ran
 */
export function frameCameraToMap(options = {}) {
  if (!camera || !controls || !renderer) return false;

  // Splat maps start at origin; go-to moves the camera afterward.
  if (isSplatMapActive()) {
    return placeCameraAtOrigin();
  }

  const target = new THREE.Vector3(0, 0, 0);
  const box = computeMapContentBox();

  let maxDim = 12;
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3());
    maxDim = Math.max(size.x, size.y, size.z, 0.01);
  }

  const padding = options.padding ?? 1.12;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const aspect = Math.max(camera.aspect, 0.25);
  const fitHeight = maxDim / (2 * Math.tan(fovRad / 2));
  const fitWidth = fitHeight / aspect;
  const distance = padding * Math.max(fitHeight, fitWidth);

  const viewDir = new THREE.Vector3(0.85, 0.65, 1).normalize();
  camera.position.copy(target).add(viewDir.multiplyScalar(distance));
  camera.lookAt(target);

  controls.target.copy(target);
  controls.minDistance = Math.max(maxDim * 0.02, 0.15);
  controls.maxDistance = Math.max(maxDim * 25, 60);
  controls.update();

  camera.near = Math.max(maxDim / 2000, 0.01);
  camera.far = Math.max(maxDim * 100, 500);
  camera.updateProjectionMatrix();

  flyAnimation = null;
  return true;
}

/**
 * Frame after layout + GLB attach (viewport may still be sizing on first paint).
 * @param {{ padding?: number }} [options]
 */
export function scheduleFrameCameraToMap(options = {}) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      onResize();
      frameCameraToMap(options);
    });
  });
}

/**
 * Attach the TransformControls gizmo to a 3D mesh.
 * @param {THREE.Object3D} mesh
 */
export function attachGizmo(mesh) {
  if (!transformControls) return;
  transformControls.attach(mesh);
}

/**
 * Switch the TransformControls mode (translate, rotate, scale).
 * @param {'translate'|'rotate'|'scale'} mode
 */
export function setGizmoMode(mode) {
  if (!transformControls) return;
  transformControls.setMode(mode);
}

/**
 * Detach the TransformControls gizmo.
 */
export function detachGizmo() {
  if (!transformControls) return;
  transformControls.detach();
}

// ── Floor Markers (Y-slice plane) — keep geometry light (no dense grids). ──

const FLOOR_COLORS = [0x1e56cf, 0x0ea5e9, 0x34d399, 0x818cf8, 0xf59e0b, 0xf43f5e];

/**
 * Lightweight flat slicing plane at Y. Drag with {@link attachFloorGizmo} (Y only).
 * @param {number} y
 * @param {number} colorIndex
 * @returns {THREE.Group | null}
 */
export function addFloorMarker(y = 0, colorIndex = 0) {
  if (!scene) return null;

  const color = FLOOR_COLORS[colorIndex % FLOOR_COLORS.length];
  const bounds = getMapMeshBounds();
  // Cap size — huge planes + lots of verts stall the editor while dragging.
  let gridSize = 48;
  let cx = 0;
  let cz = 0;
  if (bounds && !bounds.isEmpty()) {
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    gridSize = Math.min(64, Math.max(28, Math.max(size.x, size.z) * 0.85));
    cx = center.x;
    cz = center.z;
  }

  const group = new THREE.Group();
  group.name = 'FloorMarker';
  group.userData.isFloorSlice = true;

  const planeGeo = new THREE.PlaneGeometry(gridSize, gridSize, 1, 1);
  const planeMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  plane.renderOrder = 8;
  // Skip raycast on the fill — only the gizmo moves it (avoids pick cost).
  plane.raycast = () => {};
  group.add(plane);

  // 4 edge lines only (no GridHelper — that was the lag source).
  const half = gridSize * 0.5;
  const edgePositions = new Float32Array([
    -half, 0.01, -half, half, 0.01, -half,
    half, 0.01, -half, half, 0.01, half,
    half, 0.01, half, -half, 0.01, half,
    -half, 0.01, half, -half, 0.01, -half,
  ]);
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  edges.renderOrder = 10;
  edges.raycast = () => {};
  group.add(edges);

  // Small center disc — visual anchor only
  const handleGeo = new THREE.CircleGeometry(Math.min(0.9, gridSize * 0.025), 8);
  const handleMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const handle = new THREE.Mesh(handleGeo, handleMat);
  handle.rotation.x = -Math.PI / 2;
  handle.position.y = 0.02;
  handle.renderOrder = 11;
  handle.raycast = () => {};
  group.add(handle);

  group.position.set(cx, y, cz);
  scene.add(group);
  return group;
}

/**
 * Attach the gizmo to a floor marker, locked to Y-axis translate only.
 * @param {THREE.Group} marker
 */
export function attachFloorGizmo(marker) {
  if (!transformControls || !marker) return;
  transformControls.setMode('translate');
  transformControls.showX = false;
  transformControls.showZ = false;
  transformControls.showY = true;
  transformControls.setSize(1.05);
  transformControls.attach(marker);
}

/**
 * Detach the gizmo and restore all axes.
 */
export function detachFloorGizmo() {
  if (!transformControls) return;
  transformControls.detach();
  transformControls.showX = true;
  transformControls.showZ = true;
  transformControls.showY = true;
  transformControls.setSize(0.8);
}

/**
 * Remove a floor marker from the scene.
 * @param {THREE.Group} marker
 */
export function removeFloorMarker(marker) {
  if (!scene || !marker) return;
  detachFloorGizmo();
  scene.remove(marker);
  marker.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  });
}

/**
 * Get the current Y position of a floor marker.
 * @param {THREE.Group} marker
 * @returns {number}
 */
export function getFloorMarkerY(marker) {
  return marker ? marker.position.y : 0;
}

/**
 * Keep floor slice locked to vertical motion (ignore X/Z drift).
 * @param {THREE.Group | null | undefined} marker
 * @param {number} [lockX]
 * @param {number} [lockZ]
 */
export function constrainFloorMarkerXZ(marker, lockX, lockZ) {
  if (!marker) return;
  if (Number.isFinite(lockX)) marker.position.x = lockX;
  if (Number.isFinite(lockZ)) marker.position.z = lockZ;
}
