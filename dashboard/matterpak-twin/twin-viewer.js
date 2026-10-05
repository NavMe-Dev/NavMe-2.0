/**
 * Three.js dollhouse viewer for Matterpak textured OBJ.
 * Standalone — does not import dashboard scene/modules.
 * Go-to snaps to nearest hidden navmesh point.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import {
  buildTwinNavMesh,
  clearTwinNavMesh,
  getNavmeshDefaultView,
  snapToNearestNavPoint,
} from './navmesh.js';

const GOTO_DURATION_MS = 700;
const GOTO_DISTANCE = 2.8;
const GOTO_EYE_LIFT = 1.55;
const CLICK_SLOP_PX = 8;

/**
 * Detect dominant up axis from flat surfaces (floors/ceilings), same idea as twin-builder.
 * @param {THREE.Object3D} root
 * @returns {0|1|2} 0=X, 1=Y, 2=Z
 */
function detectDominantUpAxis(root) {
  const votes = [0, 0, 0];
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    const pos = child.geometry.attributes.position;
    const idx = child.geometry.index;
    const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
    // Sample up to ~20k tris for speed on dense Matterpaks.
    const stride = Math.max(1, Math.ceil(triCount / 20000));

    for (let t = 0; t < triCount; t += stride) {
      let ia;
      let ib;
      let ic;
      if (idx) {
        ia = idx.getX(t * 3);
        ib = idx.getX(t * 3 + 1);
        ic = idx.getX(t * 3 + 2);
      } else {
        ia = t * 3;
        ib = t * 3 + 1;
        ic = t * 3 + 2;
      }
      vA.fromBufferAttribute(pos, ia).applyMatrix4(child.matrixWorld);
      vB.fromBufferAttribute(pos, ib).applyMatrix4(child.matrixWorld);
      vC.fromBufferAttribute(pos, ic).applyMatrix4(child.matrixWorld);
      cb.subVectors(vC, vB);
      ab.subVectors(vA, vB);
      cb.cross(ab);
      const area = cb.length();
      if (area < 1e-10) continue;
      cb.multiplyScalar(1 / area);
      for (let ax = 0; ax < 3; ax++) {
        if (Math.abs(cb.getComponent(ax)) > 0.95) votes[ax] += area;
      }
    }
  });

  let best = 1;
  let bestV = votes[1];
  for (let ax = 0; ax < 3; ax++) {
    if (votes[ax] > bestV) {
      bestV = votes[ax];
      best = ax;
    }
  }
  return /** @type {0|1|2} */ (best);
}

/**
 * Match NavMe dashboard / twin-builder: bring Matterpak into Three.js Y-up.
 * Z-up packs get the same X=-90° treatment as splat maps.
 * @param {THREE.Object3D} object
 */
function orientMatterpakYUp(object) {
  object.rotation.set(0, 0, 0);
  object.updateMatrixWorld(true);
  const up = detectDominantUpAxis(object);
  if (up === 2) {
    // Z-up → Y-up (dashboard splat map uses X=-90°)
    object.rotation.x = -Math.PI / 2;
  } else if (up === 0) {
    // X-up → Y-up
    object.rotation.z = Math.PI / 2;
  }
  // up === 1 already Y-up
  object.updateMatrixWorld(true);
  return up;
}

/**
 * @param {HTMLElement} host
 */
export function createTwinViewer(host) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1419);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  camera.position.set(8, 6, 10);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 1.2, 0);
  controls.enableRotate = true;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.screenSpacePanning = true;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };

  let gotoMode = true;

  const STATE = { NONE: -1, ROTATE: 0, DOLLY: 1, PAN: 2 };
  controls._onMouseDown = (event) => {
    if (controls.enabled === false) return;

    let mouseAction = -1;
    switch (event.button) {
      case 0:
        mouseAction = controls.mouseButtons.LEFT;
        break;
      case 1:
        mouseAction = controls.mouseButtons.MIDDLE;
        break;
      case 2:
        mouseAction = controls.mouseButtons.RIGHT;
        break;
      default:
        break;
    }

    const cmdPan = Boolean(event.metaKey);

    switch (mouseAction) {
      case THREE.MOUSE.DOLLY:
        if (!controls.enableZoom) return;
        controls._handleMouseDownDolly(event);
        controls.state = STATE.DOLLY;
        break;
      case THREE.MOUSE.ROTATE:
        if (cmdPan) {
          if (!controls.enablePan) return;
          controls._handleMouseDownPan(event);
          controls.state = STATE.PAN;
        } else {
          if (!controls.enableRotate) return;
          controls._handleMouseDownRotate(event);
          controls.state = STATE.ROTATE;
        }
        break;
      case THREE.MOUSE.PAN:
        if (cmdPan) {
          if (!controls.enableRotate) return;
          controls._handleMouseDownRotate(event);
          controls.state = STATE.ROTATE;
        } else {
          if (!controls.enablePan) return;
          controls._handleMouseDownPan(event);
          controls.state = STATE.PAN;
        }
        break;
      default:
        controls.state = STATE.NONE;
        break;
    }

    if (controls.state !== STATE.NONE) {
      controls.dispatchEvent({ type: 'start' });
    }
  };

  function syncCursor() {
    renderer.domElement.style.cursor = gotoMode ? 'crosshair' : '';
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Meta') renderer.domElement.style.cursor = 'move';
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta') syncCursor();
  });

  const hemi = new THREE.HemisphereLight(0xffffff, 0x334155, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(6, 12, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x93c5fd, 0.25);
  fill.position.set(-8, 4, -6);
  scene.add(fill);

  const root = new THREE.Group();
  root.name = 'MatterpakTwinRoot';
  scene.add(root);

  const markerGeo = new THREE.SphereGeometry(0.12, 16, 16);
  const markerMat = new THREE.MeshBasicMaterial({
    color: 0x3a86ff,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const gotoMarker = new THREE.Mesh(markerGeo, markerMat);
  gotoMarker.visible = false;
  gotoMarker.renderOrder = 999;
  scene.add(gotoMarker);

  // Matterport → Matterpak POI marker (green)
  const mpMarkerGeo = new THREE.SphereGeometry(0.14, 16, 16);
  const mpMarkerMat = new THREE.MeshBasicMaterial({
    color: 0x34d399,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const mpMarker = new THREE.Mesh(mpMarkerGeo, mpMarkerMat);
  mpMarker.visible = false;
  mpMarker.renderOrder = 1000;
  scene.add(mpMarker);

  // Soft ring under Matterport marker for visibility
  const mpRingGeo = new THREE.RingGeometry(0.18, 0.28, 32);
  const mpRingMat = new THREE.MeshBasicMaterial({
    color: 0x34d399,
    side: THREE.DoubleSide,
    depthTest: false,
    transparent: true,
    opacity: 0.75,
  });
  const mpRing = new THREE.Mesh(mpRingGeo, mpRingMat);
  mpRing.rotation.x = -Math.PI / 2;
  mpRing.visible = false;
  mpRing.renderOrder = 999;
  scene.add(mpRing);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /** @type {THREE.Object3D | null} */
  let meshRoot = null;
  let wireframe = false;
  let xray = false;
  let raf = 0;
  let disposed = false;
  let navReady = false;

  /** @type {null | {
   *   t0: number,
   *   dur: number,
   *   fromCam: THREE.Vector3,
   *   toCam: THREE.Vector3,
   *   fromTarget: THREE.Vector3,
   *   toTarget: THREE.Vector3,
   * }} */
  let fly = null;

  let downX = 0;
  let downY = 0;

  /** @type {((point: THREE.Vector3|null) => void) | null} */
  let onGoto = null;

  function resize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function applyDefaultNavView() {
    fly = null;
    const view = getNavmeshDefaultView();
    if (!view) {
      if (meshRoot) fitToObject(meshRoot);
      return;
    }
    controls.target.copy(view.target);
    camera.position.copy(view.position);
    // Close walkable start — keep near/far suited to indoor zoom, not whole-site fit.
    camera.near = 0.05;
    camera.far = Math.max(400, (view.size || 12) * 40);
    camera.updateProjectionMatrix();
    controls.update();
    if (view.feet) {
      gotoMarker.position.copy(view.feet);
      gotoMarker.visible = true;
      onGoto?.(view.feet.clone());
    }
  }

  function fitToObject(object) {
    fly = null;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const dist = maxDim * 1.35;
    controls.target.copy(center);
    camera.position.set(center.x + dist * 0.55, center.y + dist * 0.45, center.z + dist * 0.7);
    camera.near = Math.max(0.05, maxDim / 400);
    camera.far = Math.max(500, maxDim * 20);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function clearMesh() {
    if (!meshRoot) return;
    root.remove(meshRoot);
    meshRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose?.();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          if (!m) return;
          if (m.map) m.map.dispose?.();
          m.dispose?.();
        });
      }
    });
    meshRoot = null;
    gotoMarker.visible = false;
    mpMarker.visible = false;
    mpRing.visible = false;
    navReady = false;
    clearTwinNavMesh();
  }

  function applyMaterialMode() {
    if (!meshRoot) return;
    meshRoot.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (!m) return;
        m.wireframe = wireframe;
        m.transparent = xray;
        m.opacity = xray ? 0.35 : 1;
        m.depthWrite = !xray;
        m.needsUpdate = true;
      });
    });
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }

  function goToPoint(point) {
    if (!point) return;

    gotoMarker.position.copy(point);
    gotoMarker.visible = true;

    const target = point.clone();
    target.y += GOTO_EYE_LIFT * 0.15;

    const fromCam = camera.position.clone();
    const fromTarget = controls.target.clone();

    let dir = new THREE.Vector3().subVectors(fromCam, fromTarget);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.55, 1);
    dir.normalize();

    const toCam = target.clone().addScaledVector(dir, GOTO_DISTANCE);
    toCam.y = Math.max(toCam.y, point.y + GOTO_EYE_LIFT);

    fly = {
      t0: performance.now(),
      dur: GOTO_DURATION_MS,
      fromCam,
      toCam,
      fromTarget,
      toTarget: target,
    };

    onGoto?.(point.clone());
  }

  /**
   * Show / hide the Matterport→Matterpak POI marker (green).
   * @param {{ x: number, y: number, z: number } | null} point
   * @param {{ fly?: boolean }} [opts]
   */
  function setMatterportMarker(point, opts = {}) {
    if (!point || !Number.isFinite(Number(point.x))) {
      mpMarker.visible = false;
      mpRing.visible = false;
      return;
    }
    const p = new THREE.Vector3(Number(point.x), Number(point.y), Number(point.z));
    mpMarker.position.copy(p);
    mpMarker.visible = true;
    mpRing.position.set(p.x, p.y + 0.02, p.z);
    mpRing.visible = true;

    if (opts.fly) {
      const target = p.clone();
      target.y += GOTO_EYE_LIFT * 0.15;
      const fromCam = camera.position.clone();
      const fromTarget = controls.target.clone();
      let dir = new THREE.Vector3().subVectors(fromCam, fromTarget);
      if (dir.lengthSq() < 1e-6) dir.set(1, 0.55, 1);
      dir.normalize();
      const toCam = target.clone().addScaledVector(dir, GOTO_DISTANCE);
      toCam.y = Math.max(toCam.y, p.y + GOTO_EYE_LIFT);
      fly = {
        t0: performance.now(),
        dur: GOTO_DURATION_MS,
        fromCam,
        toCam,
        fromTarget,
        toTarget: target,
      };
    }
  }

  function setPackMarker(point) {
    if (!point || !Number.isFinite(Number(point.x))) {
      gotoMarker.visible = false;
      return;
    }
    gotoMarker.position.set(Number(point.x), Number(point.y), Number(point.z));
    gotoMarker.visible = true;
  }

  function pickFromEvent(clientX, clientY) {
    if (!meshRoot) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(meshRoot, true);
    return hits[0]?.point?.clone() ?? null;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
  }

  function onPointerUp(e) {
    if (e.button !== 0 || !gotoMode || !meshRoot) return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (dx * dx + dy * dy > CLICK_SLOP_PX * CLICK_SLOP_PX) return;
    const t = e.target;
    if (t instanceof Element && t.closest('#hud, #tools, #badge')) return;

    const hit = pickFromEvent(e.clientX, e.clientY);
    if (!hit) return;

    const snapped = navReady ? snapToNearestNavPoint(hit) : null;
    if (!snapped) {
      onGoto?.(null);
      return;
    }
    goToPoint(snapped);
  }

  async function loadFromMatterpak(pack) {
    const onProgress = typeof pack.onProgress === 'function' ? pack.onProgress : () => {};
    clearMesh();
    fly = null;

    onProgress('Parsing materials…', 60);
    const mtlLoader = new MTLLoader();
    mtlLoader.setMaterialOptions({ side: THREE.DoubleSide });

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const resolved = pack.resolveTextureUrl(url);
      return resolved || url;
    });
    mtlLoader.manager = manager;

    const materials = mtlLoader.parse(pack.mtlText, '');
    materials.preload();

    onProgress('Building mesh…', 75);
    const objLoader = new OBJLoader(manager);
    objLoader.setMaterials(materials);
    const object = objLoader.parse(pack.objText);

    object.name = 'MatterpakMesh';
    object.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((m) => {
            if (m?.map) m.map.colorSpace = THREE.SRGBColorSpace;
          });
        }
      }
    });

    // Align to Three.js Y-up like NavMe dashboard maps (Z-up Matterpak → X=-90°).
    const detectedUp = orientMatterpakYUp(object);
    const upLabel = detectedUp === 2 ? 'Z→Y (-90° X)' : detectedUp === 0 ? 'X→Y' : 'Y-up';
    onProgress(`Orienting mesh (${upLabel})…`, 78);

    meshRoot = object;
    root.add(object);
    applyMaterialMode();
    fitToObject(object);

    onProgress('Generating hidden navmesh…', 82);
    const nav = await buildTwinNavMesh(object, { onProgress });
    navReady = Boolean(nav.ok);

    if (nav.ok) {
      applyDefaultNavView();
      onProgress(`Twin ready · ${nav.count} walkable points (navmesh hidden)`, 100);
    } else {
      onProgress(nav.error || 'Navmesh failed — mesh view only', 100);
    }

    return { object, nav };
  }

  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);

    if (fly) {
      const u = Math.min(1, (performance.now() - fly.t0) / fly.dur);
      const e = easeInOutCubic(u);
      camera.position.lerpVectors(fly.fromCam, fly.toCam, e);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
      controls.update();
      if (u >= 1) fly = null;
    } else {
      controls.update();
    }

    renderer.render(scene, camera);
  }

  function setWireframe(on) {
    wireframe = Boolean(on);
    applyMaterialMode();
  }

  function setXray(on) {
    xray = Boolean(on);
    applyMaterialMode();
  }

  function setGotoMode(on) {
    gotoMode = Boolean(on);
    syncCursor();
  }

  function resetView() {
    fly = null;
    gotoMarker.visible = false;
    if (navReady) applyDefaultNavView();
    else if (meshRoot) fitToObject(meshRoot);
  }

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    clearMesh();
    markerGeo.dispose();
    markerMat.dispose();
    mpMarkerGeo.dispose();
    mpMarkerMat.dispose();
    mpRingGeo.dispose();
    mpRingMat.dispose();
    controls.dispose();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.dispose();
    renderer.domElement.remove();
    window.removeEventListener('resize', resize);
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  syncCursor();

  window.addEventListener('resize', resize);
  resize();
  tick();

  return {
    loadFromMatterpak,
    setWireframe,
    setXray,
    setGotoMode,
    goToPoint,
    setPackMarker,
    setMatterportMarker,
    resetView,
    fit: resetView,
    set onGoto(fn) {
      onGoto = typeof fn === 'function' ? fn : null;
    },
    get gotoMode() {
      return gotoMode;
    },
    get navReady() {
      return navReady;
    },
    get wireframe() {
      return wireframe;
    },
    get xray() {
      return xray;
    },
    dispose,
  };
}
