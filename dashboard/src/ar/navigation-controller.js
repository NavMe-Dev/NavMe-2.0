import * as THREE from 'three';
import { ensureRecastLoaded, hasNavMesh, ensureNavMeshAvailable } from './navigation-mesh.js';
import { createNavigationRoute } from './navigation-route.js';
import { createNavigationBreadcrumbs } from './navigation-breadcrumbs.js';
import { getPOIObjects, poisData } from './pois.js';
import { getCamera, getOrbitTarget, getMultisetAnchor } from './scene.js';
import { getMatterportCameraPose, isMatterportMapActive } from './matterport-map.js';

const ROUTE_ID = 'default-route';

let routeHandle = null;
let breadcrumbsHandle = null;
let destinationPoiIndex = -1;
let navigating = false;
let routeVisualVisible = false;

function getRouteEntryById(routeId) {
  if (routeId !== ROUTE_ID || !routeHandle) return null;
  return { route: routeHandle };
}

function refreshBreadcrumbs() {
  breadcrumbsHandle?.refresh(getRouteEntryById);
}

function disposeNavigationHandles() {
  try {
    routeHandle?.dispose?.();
  } catch {
    /* */
  }
  try {
    breadcrumbsHandle?.dispose?.();
  } catch {
    /* */
  }
  routeHandle = null;
  breadcrumbsHandle = null;
  destinationPoiIndex = -1;
  routeVisualVisible = false;
}

/** World position of a POI — mesh position when placed, stored coords otherwise. */
export function getPoiWorldPosition(index) {
  const poi = poisData[index];
  if (!poi) return null;
  const mesh = getPOIObjects()[index]?.mesh;
  if (mesh) {
    const v = new THREE.Vector3();
    mesh.getWorldPosition(v);
    return v;
  }
  return new THREE.Vector3(poi.pos_x, poi.pos_y, poi.pos_z);
}

function getCameraWorldPosition() {
  const camera = getCamera();
  if (!camera) return new THREE.Vector3(0, 0, 0);
  const v = new THREE.Vector3();
  camera.getWorldPosition(v);
  return v;
}

/**
 * Dashboard camera orbits high above the map — use orbit/map hit as a floor start
 * (same idea as Zappar camera → feet, but any walkable floor point).
 */
function getWalkableOrigin() {
  // Matterport: start from the Showcase camera (geometric mesh stays hidden).
  if (isMatterportMapActive()) {
    const pose = getMatterportCameraPose();
    const p = pose?.position;
    if (p && Number.isFinite(Number(p.x))) {
      return new THREE.Vector3(Number(p.x), Number(p.y), Number(p.z));
    }
  }

  const camera = getCamera();
  const orbit = getOrbitTarget();
  const mapRoot = getMultisetAnchor()?.getObjectByName('MapMesh');

  if (mapRoot) {
    const probes = [];
    if (orbit) probes.push(new THREE.Vector3(orbit.x, orbit.y + 40, orbit.z));
    if (camera) {
      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      probes.push(camPos.clone().add(new THREE.Vector3(0, 0.25, 0)));
    }

    for (const start of probes) {
      const raycaster = new THREE.Raycaster(start, new THREE.Vector3(0, -1, 0), 0, 500);
      const hits = raycaster.intersectObject(mapRoot, true);
      const hit = hits.find((h) => h.object?.isMesh);
      if (hit?.point) return hit.point.clone();
    }
  }

  if (orbit) {
    // Prefer orbit XY on the floor plane — NavigationRoute snaps Y via findClosestPoint.
    return new THREE.Vector3(orbit.x, 0, orbit.z);
  }

  const cam = getCameraWorldPosition();
  return new THREE.Vector3(cam.x, 0, cam.z);
}

/**
 * Ensure navmesh + route + breadcrumbs exist.
 * Navmesh is generated once unless forceRegen is true.
 */
export async function buildNavigationSetup({ forceRegen = false } = {}) {
  try {
    await ensureRecastLoaded();

    if (forceRegen || !hasNavMesh()) {
      const navResult = await ensureNavMeshAvailable({
        visualize: false,
        force: forceRegen,
      });
      if (!navResult?.success) {
        return { ok: false, error: navResult?.error || 'Failed to generate navigation mesh' };
      }
      disposeNavigationHandles();
    }

    if (!routeHandle) {
      routeHandle = createNavigationRoute();
    }
    if (!breadcrumbsHandle) {
      breadcrumbsHandle = createNavigationBreadcrumbs();
      breadcrumbsHandle.setRouteId(ROUTE_ID);
    }

    refreshBreadcrumbs();
    setNavigationVisualVisible(false);
    return { ok: true };
  } catch (err) {
    console.error('[navigation] setup failed:', err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Navigation setup failed',
    };
  }
}

export function hasNavigationRoute() {
  return Boolean(routeHandle);
}

export function setNavigationDestinationToPoi(index) {
  if (!routeHandle || index < 0 || index >= poisData.length) return false;

  const dest = getPoiWorldPosition(index);
  if (!dest) return false;

  destinationPoiIndex = index;
  routeHandle.setDestination(dest.x, dest.y, dest.z);
  refreshBreadcrumbs();
  return routeHandle.state.valid;
}

export function syncNavigationToLatestPoi() {
  if (!poisData.length) return false;
  return setNavigationDestinationToPoi(poisData.length - 1);
}

function applyEndpointsRoute(origin, dest) {
  // Same as Zappar: pass world points; findClosestPoint snaps within ±1m only.
  if (typeof routeHandle.setEndpoints === 'function') {
    routeHandle.setEndpoints(origin, dest);
  } else {
    routeHandle.setOrigin(origin.x, origin.y, origin.z);
    routeHandle.setDestination(dest.x, dest.y, dest.z);
  }

  return routeHandle.state.valid && routeHandle.state.pathPoints.length >= 2;
}

function applyOriginToPoiRoute(dest) {
  return applyEndpointsRoute(getWalkableOrigin(), dest);
}

/**
 * Route between two chosen POIs.
 *
 * navigateToPoi() always starts from the camera, which is what you want while
 * walking the space. Planning a route on a floor plan needs both ends chosen
 * explicitly, so this takes a From and a To and does no origin fallback — if
 * the pair has no path, that is the answer, not a cue to substitute a different
 * starting point.
 *
 * @param {number} fromIndex index into poisData
 * @param {number} toIndex   index into poisData
 * @param {{ showVisual?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, pathPoints?: Array<{x:number,y:number,z:number}> }>}
 */
export async function navigateBetweenPois(fromIndex, toIndex, opts = {}) {
  if (navigating) return { ok: false, error: 'Navigation already in progress' };
  if (fromIndex < 0 || fromIndex >= poisData.length) {
    return { ok: false, error: 'Pick a valid start POI' };
  }
  if (toIndex < 0 || toIndex >= poisData.length) {
    return { ok: false, error: 'Pick a valid destination POI' };
  }
  if (fromIndex === toIndex) {
    return { ok: false, error: 'Start and destination are the same POI' };
  }

  const showVisual = opts.showVisual !== false;
  navigating = true;
  try {
    // Yield so the click can paint before pathfinding blocks the thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const setup = await buildNavigationSetup({ forceRegen: false });
    if (!setup.ok) return setup;

    routeHandle?.group && getMultisetAnchor()?.add(routeHandle.group);

    const origin = getPoiWorldPosition(fromIndex);
    const dest = getPoiWorldPosition(toIndex);
    if (!origin) return { ok: false, error: 'Start POI has no position on this map' };
    if (!dest) return { ok: false, error: 'Destination POI has no position on this map' };

    if (!applyEndpointsRoute(origin, dest)) {
      setNavigationVisualVisible(false);
      return {
        ok: false,
        error:
          routeHandle?.state?.error ||
          'No walkable path between those two POIs on this navmesh',
      };
    }

    destinationPoiIndex = toIndex;
    refreshBreadcrumbs();
    setNavigationVisualVisible(showVisual);
    return { ok: true, pathPoints: getNavigationPathWorldPoints() };
  } finally {
    navigating = false;
  }
}

/**
 * Navigate from current view → POI.
 * Tries origin → POI first; if that fails, tries any other POI → selected POI.
 * Navmesh is created once; route rebuilds every call.
 *
 * @param {number} index
 * @param {{ showVisual?: boolean }} [opts]
 *   showVisual — when false, compute path but keep mesh route graphics hidden
 *   (Matterport shows the route as an overlay instead).
 * @returns {Promise<{ ok: boolean, error?: string, pathPoints?: Array<{ x: number, y: number, z: number }> }>}
 */
export async function navigateToPoi(index, opts = {}) {
  if (navigating) {
    return { ok: false, error: 'Navigation already in progress' };
  }
  if (index < 0 || index >= poisData.length) {
    return { ok: false, error: 'Invalid POI' };
  }

  const showVisual = opts.showVisual !== false;

  navigating = true;
  try {
    // Yield so the click/UI can paint before pathfinding.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // One-time navmesh — never force-regen just because a route failed.
    const setup = await buildNavigationSetup({ forceRegen: false });
    if (!setup.ok) return setup;

    // Ensure route group is parented under the current map anchor (map may reload).
    routeHandle?.group && getMultisetAnchor()?.add(routeHandle.group);

    const dest = getPoiWorldPosition(index);
    if (!dest) return { ok: false, error: 'POI position not found' };

    destinationPoiIndex = index;

    // 1) View origin → selected POI
    if (applyOriginToPoiRoute(dest)) {
      refreshBreadcrumbs();
      setNavigationVisualVisible(showVisual);
      return { ok: true, pathPoints: getNavigationPathWorldPoints() };
    }

    // 2) Fallback: any other POI → selected POI (same pathfinding, different origin)
    for (let i = 0; i < poisData.length; i++) {
      if (i === index) continue;
      const origin = getPoiWorldPosition(i);
      if (!origin) continue;
      if (applyEndpointsRoute(origin, dest)) {
        refreshBreadcrumbs();
        setNavigationVisualVisible(showVisual);
        return { ok: true, pathPoints: getNavigationPathWorldPoints() };
      }
    }

    setNavigationVisualVisible(false);
    return {
      ok: false,
      error: routeHandle?.state?.error || 'Unable to find path between origin and destination',
    };
  } finally {
    navigating = false;
  }
}

/**
 * World-space polyline for the active route (local route points → world).
 * @returns {Array<{ x: number, y: number, z: number }>}
 */
export function getNavigationPathWorldPoints() {
  const pts = routeHandle?.state?.pathPoints;
  const group = routeHandle?.group;
  if (!Array.isArray(pts) || pts.length < 2 || !group) return [];
  group.updateWorldMatrix(true, false);
  return pts.map((p) => {
    const v = p.clone();
    group.localToWorld(v);
    return { x: v.x, y: v.y, z: v.z };
  });
}

export function getNavigationDestinationIndex() {
  return destinationPoiIndex;
}

export function tickNavigation() {
  if (!routeHandle || destinationPoiIndex < 0 || !routeVisualVisible) return;

  const dest = getPoiWorldPosition(destinationPoiIndex);
  if (!dest) return;

  const { destination } = routeHandle.state;
  if (
    Math.abs(dest.x - destination.x) > 0.001 ||
    Math.abs(dest.y - destination.y) > 0.001 ||
    Math.abs(dest.z - destination.z) > 0.001
  ) {
    // Keep elevated POI coords; rebuild snaps destination to floor again.
    routeHandle.setDestination(dest.x, dest.y, dest.z);
    refreshBreadcrumbs();
  }
}

/** Hide/show route line, origin/destination markers, camera helper, and breadcrumbs. */
export function setNavigationVisualVisible(visible) {
  const on = Boolean(visible);
  routeVisualVisible = on;
  if (routeHandle?.group) routeHandle.group.visible = on;
  if (routeHandle?.originMarker) routeHandle.originMarker.visible = on;
  if (routeHandle?.destMarker) routeHandle.destMarker.visible = on;
  // Keep camera helper off — it clutters the map for dashboard routing.
  if (routeHandle?.cameraHelper) routeHandle.cameraHelper.visible = false;
  breadcrumbsHandle?.setVisible(on);
}

/** Whether a navigation route is currently shown on the map. */
export function isNavigationRouteVisible() {
  return routeVisualVisible && destinationPoiIndex >= 0;
}

/**
 * Cut / clear the active navigation route so it no longer shows on the map.
 */
export function clearNavigationRoute() {
  destinationPoiIndex = -1;
  setNavigationVisualVisible(false);
  return { ok: true };
}
