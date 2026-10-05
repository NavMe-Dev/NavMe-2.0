/**
 * NavigationRoute — dashboard port of the ZComponent NavigationRoute.
 *
 * Builds a path on the Recast nav mesh between origin, optional waypoints,
 * and destination. Path queries run in world space (navmesh is world-baked);
 * rendered path points are converted into MultisetAnchor local space.
 */
import * as THREE from 'three';
import { NavMeshQuery } from 'recast-navigation';
import { getNavMesh } from './navigation-mesh.js';
import { getMultisetAnchor } from './scene.js';

const ROUTE_COLOR = 0xffffff;
const ROUTE_WIDTH = 3;
const ORIGIN_COLOR = 0x00ff88;
const DEST_COLOR = 0xff3366;

/**
 * Same as @zcomponent NavigationRoute / recast-navigation NavMeshQuery defaults.
 * Only points within ±1m of the navmesh (X/Y/Z) will snap — elevated POIs beyond
 * that will not get a route (identical to experience).
 */
const QUERY_HALF_EXTENTS = { x: 1, y: 1, z: 1 };

function createMarker(color, radius = 0.25) {
  const geo = new THREE.SphereGeometry(radius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    transparent: true,
    opacity: 0.85,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  return mesh;
}

function createCameraHelper() {
  const group = new THREE.Group();
  group.name = 'RouteCameraHelper';

  const bodyGeo = new THREE.BoxGeometry(0.3, 0.2, 0.4);
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
  group.add(new THREE.Mesh(bodyGeo, bodyMat));

  const lensGeo = new THREE.CylinderGeometry(0.06, 0.1, 0.15, 8);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, wireframe: true });
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.27;
  group.add(lens);

  return group;
}

function toPoint(input) {
  if (!input) return null;
  if (input.isVector3) return { x: input.x, y: input.y, z: input.z };
  if (typeof input.x === 'number') return { x: input.x, y: input.y, z: input.z };
  return null;
}

/**
 * ZComponent-style path between two nav-mesh points.
 */
function computePath(navQuery, startPoint, endPoint) {
  const start = toPoint(startPoint);
  const end = toPoint(endPoint);
  if (!start || !end) {
    return {
      success: false,
      path: [],
      error: { name: 'Invalid path endpoints' },
    };
  }

  try {
    let result = navQuery.computePath(start, end);
    // Some builds accept Vector3 — try once more if plain objects fail.
    if ((!result?.success || !result.path || result.path.length < 2) && THREE.Vector3) {
      result = navQuery.computePath(
        new THREE.Vector3(start.x, start.y, start.z),
        new THREE.Vector3(end.x, end.y, end.z),
      );
    }
    if (!result?.success || !result.path || result.path.length < 2) {
      return {
        success: false,
        path: [],
        error: { name: 'Unable to compute path on nav mesh' },
      };
    }
    return { success: true, path: result.path, error: null };
  } catch (err) {
    return {
      success: false,
      path: [],
      error: { name: err instanceof Error ? err.message : 'Path computation failed' },
    };
  }
}

/**
 * Exact Zappar NavigationRoute snap:
 *   navQuery.findClosestPoint({ x, y, z })
 * with default halfExtents {1,1,1} — no extra floor seeds / tall search boxes.
 */
function findClosestPointStatus(navQuery, point) {
  const sample = toPoint(point);
  if (!sample) return { ok: false, point: null };

  let result;
  try {
    result = navQuery.findClosestPoint(sample, { halfExtents: QUERY_HALF_EXTENTS });
  } catch {
    return { ok: false, point: null };
  }

  // Zappar checks `.status`; JS API also exposes `.success`.
  const ok = Boolean(result?.success ?? result?.status);
  if (ok && result.point) {
    return { ok: true, point: result.point };
  }
  return { ok: false, point: null };
}

/**
 * Build a predicate that answers "does this world point lie on the navmesh?".
 *
 * Used by hybrid Matterport routing to reject scan points that sit off the
 * walkable surface (on a plinth, behind a rope, inside a display case). It
 * reuses findClosestPointStatus so "on the navmesh" means exactly what it means
 * to pathfinding — one definition, not two that can drift apart.
 *
 * Queries are world space: the navmesh is world-baked (worldToRouteLocal exists
 * only for rendering), so points go in unconverted.
 *
 * @param {{ toleranceM?: number }} [opts] how far off the mesh still counts as on it
 * @returns {((p:{x:number,y:number,z:number}) => boolean) | null} null when no navmesh is loaded
 */
export function createNavmeshProbe(opts = {}) {
  const navMesh = getNavMesh();
  if (!navMesh) return null;

  const tolerance = Number(opts.toleranceM) > 0 ? Number(opts.toleranceM) : 1.0;

  let navQuery;
  try {
    navQuery = new NavMeshQuery(navMesh);
  } catch {
    return null;
  }

  return (point) => {
    const res = findClosestPointStatus(navQuery, point);
    // A point the navmesh cannot resolve at all is off-mesh.
    if (!res.ok || !res.point) return false;
    const d = Math.hypot(
      res.point.x - point.x,
      res.point.y - point.y,
      res.point.z - point.z,
    );
    return d <= tolerance;
  };
}

function worldToRouteLocal(worldVec) {
  const out = worldVec.clone();
  const anchor = getMultisetAnchor();
  if (anchor) {
    anchor.updateWorldMatrix(true, false);
    anchor.worldToLocal(out);
  }
  return out;
}

/**
 * @returns {object} Navigation route handle compatible with navigation-controller
 */
export function createNavigationRoute() {
  const group = new THREE.Group();
  group.name = 'NavigationRoute';

  const originMarker = createMarker(ORIGIN_COLOR, 0.3);
  const destMarker = createMarker(DEST_COLOR, 0.3);
  const cameraHelper = createCameraHelper();

  group.add(originMarker);
  group.add(destMarker);
  group.add(cameraHelper);

  let routeLine = null;
  /** @type {THREE.CurvePath|null} */
  let curve = null;
  let curveVersion = 0;
  /** @type {THREE.Object3D[]} */
  const waypoints = [];

  /** @type {THREE.Vector3[]} */
  let lastGeneratedPoints = [];
  /** @type {unknown} */
  let lastGeneratedNavMesh = undefined;

  const listeners = {
    onRouteValid: new Set(),
    onRouteInvalid: new Set(),
    onRouteChange: new Set(),
  };

  const state = {
    origin: new THREE.Vector3(0, 0, 0),
    destination: new THREE.Vector3(2, 0, 2),
    /** Snapped walkable floor points used for the last successful path. */
    originFloor: new THREE.Vector3(0, 0, 0),
    destinationFloor: new THREE.Vector3(2, 0, 2),
    pathPoints: /** @type {THREE.Vector3[]} */ ([]),
    valid: false,
    error: /** @type {string|null} */ (null),
    destinationObjectId: /** @type {string|null} */ (null),
  };

  function emit(name, payload) {
    for (const fn of listeners[name]) {
      try {
        fn(payload);
      } catch (err) {
        console.warn(`[NavigationRoute] ${name} listener error:`, err);
      }
    }
  }

  function pointsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!a[i].equals(b[i])) return false;
    }
    return true;
  }

  function clearRoute(message = 'Route cleared') {
    if (routeLine) {
      group.remove(routeLine);
      routeLine.geometry?.dispose();
      routeLine.material?.dispose();
      routeLine = null;
    }
    curve = null;
    curveVersion += 1;
    state.pathPoints = [];
    state.valid = false;
    state.error = message;
    lastGeneratedPoints = [];
    lastGeneratedNavMesh = undefined;
    emit('onRouteInvalid', message);
    emit('onRouteChange');
  }

  /**
   * Mirror of Zappar NavigationRoute._update:
   * points → findClosestPoint (default ±1m) → computePath → CurvePath.
   * Origin is a floor/orbit point (not Zappar camera); no cameraPositionOffset.
   */
  function rebuildLine({ force = false } = {}) {
    const navMesh = getNavMesh();
    if (!navMesh) {
      clearRoute('No navigation mesh');
      return;
    }

    /** @type {THREE.Vector3[]} world-space query points */
    const points = [state.origin.clone()];
    for (const wp of waypoints) {
      const v = new THREE.Vector3();
      wp.getWorldPosition(v);
      points.push(v);
    }
    points.push(state.destination.clone());

    if (points.length < 2) {
      clearRoute('Route needs at least two points');
      return;
    }

    let hasChanged = force || lastGeneratedNavMesh !== navMesh;
    if (!hasChanged && !pointsEqual(points, lastGeneratedPoints)) {
      hasChanged = true;
    }
    if (!hasChanged) return;

    lastGeneratedNavMesh = navMesh;
    lastGeneratedPoints = points.map((p) => p.clone());

    const navQuery = new NavMeshQuery(navMesh);
    navQuery.defaultQueryHalfExtents = { ...QUERY_HALF_EXTENTS };

    /** @type {THREE.Vector3[]} */
    const denseWorldPoints = [];
    /** @type {string|undefined} */
    let error;
    /** @type {THREE.Vector3 | null} */
    let firstSnap = null;
    /** @type {THREE.Vector3 | null} */
    let lastSnap = null;

    // Loop through each pair of points and find a path between them (Zappar).
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];

      const closestStart = findClosestPointStatus(navQuery, {
        x: start.x,
        y: start.y,
        z: start.z,
      });
      const closestEnd = findClosestPointStatus(navQuery, {
        x: end.x,
        y: end.y,
        z: end.z,
      });

      if (!closestStart.ok || !closestEnd.ok) {
        error = `Unable to find path between point ${i} and point ${i + 1}`;
        break;
      }

      const startSnap = new THREE.Vector3(
        closestStart.point.x,
        closestStart.point.y,
        closestStart.point.z,
      );
      const endSnap = new THREE.Vector3(
        closestEnd.point.x,
        closestEnd.point.y,
        closestEnd.point.z,
      );
      if (!firstSnap) firstSnap = startSnap.clone();
      lastSnap = endSnap.clone();

      const path = computePath(navQuery, closestStart.point, closestEnd.point);
      if (!path.success) {
        error = path.error?.name ?? `Unable to find path between point ${i} and point ${i + 1}`;
        break;
      }

      for (const entry of path.path) {
        denseWorldPoints.push(new THREE.Vector3(entry.x, entry.y, entry.z));
      }
    }

    if (firstSnap) {
      state.originFloor.copy(firstSnap);
      originMarker.position.copy(worldToRouteLocal(firstSnap));
    } else {
      originMarker.position.copy(worldToRouteLocal(state.origin));
    }
    if (lastSnap) {
      state.destinationFloor.copy(lastSnap);
      destMarker.position.copy(worldToRouteLocal(lastSnap));
    } else {
      destMarker.position.copy(worldToRouteLocal(state.destination));
    }
    cameraHelper.visible = false;

    if (routeLine) {
      group.remove(routeLine);
      routeLine.geometry?.dispose();
      routeLine.material?.dispose();
      routeLine = null;
    }

    if (denseWorldPoints.length >= 2) {
      const denseLocalPoints = denseWorldPoints.map((p) => worldToRouteLocal(p));

      curve = new THREE.CurvePath();
      for (let i = 0; i < denseLocalPoints.length - 1; i++) {
        curve.add(new THREE.LineCurve3(denseLocalPoints[i], denseLocalPoints[i + 1]));
      }
      curve.updateArcLengths();

      state.pathPoints = denseLocalPoints;
      state.valid = !error;
      state.error = error ?? null;

      const lineGeo = new THREE.BufferGeometry().setFromPoints(denseLocalPoints);
      const lineMat = new THREE.LineBasicMaterial({
        color: ROUTE_COLOR,
        linewidth: ROUTE_WIDTH,
        depthTest: false,
      });
      routeLine = new THREE.Line(lineGeo, lineMat);
      routeLine.renderOrder = 998;
      group.add(routeLine);
    } else {
      curve = null;
      state.pathPoints = [];
      state.valid = false;
      state.error = error ?? 'No valid path on nav mesh';
    }

    curveVersion += 1;

    if (error) {
      emit('onRouteInvalid', error);
    } else if (state.valid) {
      emit('onRouteValid');
    }
    emit('onRouteChange');
  }

  function addToScene() {
    const anchor = getMultisetAnchor();
    if (anchor) anchor.add(group);
  }

  function removeFromScene() {
    const anchor = getMultisetAnchor();
    if (anchor) anchor.remove(group);
  }

  function dispose() {
    removeFromScene();
    if (routeLine) {
      routeLine.geometry?.dispose();
      routeLine.material?.dispose();
    }
    originMarker.geometry?.dispose();
    originMarker.material?.dispose();
    destMarker.geometry?.dispose();
    destMarker.material?.dispose();
    listeners.onRouteValid.clear();
    listeners.onRouteInvalid.clear();
    listeners.onRouteChange.clear();
  }

  // Don't force-build with dummy (0,0,0)->(2,0,2) — wait for real endpoints.
  addToScene();

  return {
    group,
    originMarker,
    destMarker,
    cameraHelper,
    get state() {
      return state;
    },
    get curve() {
      return curve;
    },
    get curveVersion() {
      return curveVersion;
    },

    setOrigin(x, y, z) {
      state.origin.set(x, y, z);
      rebuildLine({ force: true });
    },
    setDestination(x, y, z) {
      state.destination.set(x, y, z);
      rebuildLine({ force: true });
    },
    /**
     * Set origin + destination then rebuild once (Zappar-style endpoints).
     * Snap uses default halfExtents ±1m — same height allowance as experience.
     */
    setEndpoints(origin, destination) {
      if (origin) state.origin.set(origin.x, origin.y, origin.z);
      if (destination) state.destination.set(destination.x, destination.y, destination.z);
      rebuildLine({ force: true });
    },
    /** @deprecated Camera offset unused — floor snap replaces Zappar feet offset. */
    setCameraOffsetY() {},
    /** @deprecated Camera offset unused — floor snap replaces Zappar feet offset. */
    setCameraPositionOffset() {},
    /** @deprecated Dashboard always uses floor points, not camera feet. */
    setOriginIsCamera() {},
    /** @deprecated Dashboard always uses floor points, not camera feet. */
    setDestinationIsCamera() {},

    addWaypoint(object3d) {
      if (!object3d || waypoints.includes(object3d)) return;
      waypoints.push(object3d);
      rebuildLine({ force: true });
    },
    clearWaypoints() {
      waypoints.length = 0;
      rebuildLine({ force: true });
    },

    bindDestinationObject(objectId) {
      state.destinationObjectId = objectId || null;
    },

    tick(getObjectById) {
      if (!state.destinationObjectId) return;
      const entry = getObjectById(state.destinationObjectId);
      if (!entry || !entry.mesh) {
        state.destinationObjectId = null;
        return;
      }
      const p = new THREE.Vector3();
      entry.mesh.getWorldPosition(p);
      if (
        Math.abs(p.x - state.destination.x) > 0.001 ||
        Math.abs(p.y - state.destination.y) > 0.001 ||
        Math.abs(p.z - state.destination.z) > 0.001
      ) {
        state.destination.copy(p);
        rebuildLine({ force: true });
      }
    },

    on(eventName, fn) {
      if (!listeners[eventName]) return () => {};
      listeners[eventName].add(fn);
      return () => listeners[eventName].delete(fn);
    },

    rebuild: () => rebuildLine({ force: true }),
    dispose,
  };
}
