/**
 * Navigation Breadcrumbs — Mattercraft-style crumbs along a Navigation Route curve.
 * Add separately; bind a route via dropdown. Reads the route's computed pathPoints.
 */
import * as THREE from 'three';
import { getMultisetAnchor } from './scene.js';

const CRUMB_RADIUS = 0.05;
const CRUMB_OUTLINE_RADIUS = 0.07;
const CRUMB_HEIGHT = 0.05;
const MAX_CRUMBS = 500;

const _crumbMatrix = new THREE.Matrix4();
const _crumbRotation = new THREE.Matrix4();
_crumbRotation.makeRotationX(-Math.PI / 2);

function createBreadcrumbMeshes() {
  const baseMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.2, transparent: true });

  const baseGeo = new THREE.CircleGeometry(CRUMB_RADIUS);
  const outlineGeo = new THREE.CircleGeometry(CRUMB_OUTLINE_RADIUS);

  const baseMesh = new THREE.InstancedMesh(baseGeo, baseMat, MAX_CRUMBS);
  const outlineMesh = new THREE.InstancedMesh(outlineGeo, outlineMat, MAX_CRUMBS);
  const shadowMesh = new THREE.InstancedMesh(outlineGeo, shadowMat, MAX_CRUMBS);

  baseMesh.count = 0;
  outlineMesh.count = 0;
  shadowMesh.count = 0;
  baseMesh.frustumCulled = false;
  outlineMesh.frustumCulled = false;
  shadowMesh.frustumCulled = false;

  outlineMesh.position.set(0, CRUMB_HEIGHT, 0);
  baseMesh.position.set(0, CRUMB_HEIGHT + 0.001, 0);

  return { baseMesh, outlineMesh, shadowMesh, baseGeo, outlineGeo, baseMat, outlineMat, shadowMat };
}

function updateBreadcrumbsAlongPath(mesh, pathPoints, gap, trimStartDist = 0) {
  if (!pathPoints || pathPoints.length < 2) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = false;
    return;
  }

  const curve = new THREE.CurvePath();
  for (let i = 0; i < pathPoints.length - 1; i++) {
    curve.add(new THREE.LineCurve3(pathPoints[i], pathPoints[i + 1]));
  }

  const length = curve.getLength();
  if (length < 0.001) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = false;
    return;
  }

  let totalPoints = Math.floor(length / gap) + 1;
  totalPoints = Math.min(totalPoints, MAX_CRUMBS);
  const trim = Math.min(Math.max(0, Number(trimStartDist) || 0), length);
  if (trim >= length - 1e-6) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = false;
    return;
  }

  const offsetAtStart = (length - (totalPoints - 1) * gap) / length;
  const pt = new THREE.Vector3();
  const tangent = new THREE.Vector3();

  let n = 0;
  for (let i = 0; i < totalPoints; i++) {
    const dist = offsetAtStart * length + i * gap;
    if (dist + 1e-6 < trim) continue;
    const u = Math.min(dist / length, 1);
    curve.getPointAt(u, pt);
    curve.getTangentAt(u, tangent);

    _crumbMatrix.identity();
    _crumbMatrix.setPosition(pt);

    const target = pt.clone().add(tangent);
    _crumbMatrix.lookAt(pt, target, new THREE.Vector3(0, 1, 0));
    _crumbMatrix.multiply(_crumbRotation);

    mesh.setMatrixAt(n++, _crumbMatrix);
  }

  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.visible = n > 0;
}

/**
 * @returns {object} handle with group, mesh (selection proxy), state, methods
 */
export function createNavigationBreadcrumbs() {
  const group = new THREE.Group();
  group.name = 'NavigationBreadcrumbs';

  const breadcrumbs = createBreadcrumbMeshes();
  group.add(breadcrumbs.baseMesh);
  group.add(breadcrumbs.outlineMesh);
  group.add(breadcrumbs.shadowMesh);

  const proxyGeo = new THREE.SphereGeometry(0.08, 8, 8);
  const proxyMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });
  const proxyMesh = new THREE.Mesh(proxyGeo, proxyMat);
  proxyMesh.name = 'NavBreadcrumbsProxy';
  group.add(proxyMesh);

  const state = {
    routeId: null,
    gap: 0.3,
    visible: true,
    trimStartDistance: null,
  };

  function syncFromRoute(getRouteEntryById) {
    if (!state.routeId || !getRouteEntryById) {
      updateBreadcrumbsAlongPath(breadcrumbs.baseMesh, [], state.gap);
      updateBreadcrumbsAlongPath(breadcrumbs.outlineMesh, [], state.gap);
      updateBreadcrumbsAlongPath(breadcrumbs.shadowMesh, [], state.gap);
      return;
    }

    const routeEntry = getRouteEntryById(state.routeId);
    const path = routeEntry?.route?.state?.pathPoints;
    const pts = path && path.length >= 2 ? path : [];

    if (!state.visible || pts.length < 2) {
      updateBreadcrumbsAlongPath(breadcrumbs.baseMesh, [], state.gap);
      updateBreadcrumbsAlongPath(breadcrumbs.outlineMesh, [], state.gap);
      updateBreadcrumbsAlongPath(breadcrumbs.shadowMesh, [], state.gap);
      return;
    }

    const trim = state.trimStartDistance == null ? 0 : state.trimStartDistance;
    updateBreadcrumbsAlongPath(breadcrumbs.baseMesh, pts, state.gap, trim);
    updateBreadcrumbsAlongPath(breadcrumbs.outlineMesh, pts, state.gap, trim);
    updateBreadcrumbsAlongPath(breadcrumbs.shadowMesh, pts, state.gap, trim);
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
    breadcrumbs.baseGeo.dispose();
    breadcrumbs.outlineGeo.dispose();
    breadcrumbs.baseMat.dispose();
    breadcrumbs.outlineMat.dispose();
    breadcrumbs.shadowMat.dispose();
    proxyGeo.dispose();
    proxyMat.dispose();
  }

  addToScene();

  return {
    group,
    mesh: proxyMesh,
    get state() { return state; },

    setRouteId(routeId) {
      state.routeId = routeId || null;
    },

    setGap(gap) {
      state.gap = Math.max(0.05, gap);
    },

    setBreadcrumbColor(baseColor, outlineColor) {
      if (baseColor) breadcrumbs.baseMat.color.set(baseColor);
      if (outlineColor) breadcrumbs.outlineMat.color.set(outlineColor);
    },

    setVisible(v) {
      state.visible = v;
      group.visible = v;
    },

    /**
     * Hide crumbs behind current journey position.
     * Pass null to show full route.
     */
    setTrimStartDistance(dist) {
      state.trimStartDistance = dist == null ? null : Math.max(0, Number(dist) || 0);
    },

    refresh(getRouteEntryById) {
      syncFromRoute(getRouteEntryById);
    },

    dispose,
  };
}
