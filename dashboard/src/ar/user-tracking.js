/**
 * User Tracking — 3D markers and route lines in the scene.
 */
import * as THREE from 'three';
import { getScene, getMultisetAnchor } from './scene.js';
import { MESH_HEATMAP_Y_OFFSET } from './nav-heatmap.js';

const USER_COLORS = [
  0x6366f1,
  0x22c55e,
  0xf59e0b,
  0xef4444,
  0x06b6d4,
  0xec4899,
  0x8b5cf6,
  0x14b8a6,
];

const markers = new Map();
let historyGroup = null;
/** @type {THREE.Group | null} */
let userTrailGroup = null;

function colorForIndex(i) {
  return USER_COLORS[i % USER_COLORS.length];
}

function mountToScene(group) {
  const anchor = getMultisetAnchor();
  const scene = getScene();
  if (anchor) anchor.add(group);
  else if (scene) scene.add(group);
}

function unmountFromScene(group) {
  const anchor = getMultisetAnchor();
  const scene = getScene();
  if (group.parent) group.parent.remove(group);
  else if (anchor) anchor.remove(group);
  else if (scene) scene.remove(group);
}

function disposeObject3D(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });
}

function createLabelCanvas(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = 'Bold 28px Inter, Arial';
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const pad = 12;
  canvas.width = tw + pad * 2;
  canvas.height = 44;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10,10,20,0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
  ctx.fill();
  ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  return canvas;
}

export function addUserMarker(userId, name, x, y, z, colorIndex = 0) {
  if (!getScene()) return null;

  removeUserMarker(userId);

  const color = colorForIndex(colorIndex);
  const group = new THREE.Group();
  group.name = `user-marker-${userId}`;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 24, 24),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }),
  );
  group.add(sphere);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.36, 32),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.45 }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const labelCanvas = createLabelCanvas(name, color);
  const tex = new THREE.CanvasTexture(labelCanvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  const aspect = labelCanvas.width / labelCanvas.height;
  sprite.scale.set(aspect * 0.7, 0.7, 1);
  sprite.position.y = 0.65;
  group.add(sprite);

  group.position.set(x, y, z);
  mountToScene(group);
  markers.set(userId, group);
  return group;
}

export function hasUserMarker(userId) {
  return markers.has(userId);
}

export function updateUserMarker(userId, x, y, z) {
  const group = markers.get(userId);
  if (!group) return;
  group.position.set(x, y, z);
}

export function removeUserMarker(userId) {
  const group = markers.get(userId);
  if (!group) return;
  unmountFromScene(group);
  disposeObject3D(group);
  markers.delete(userId);
}

export function clearAllMarkers() {
  for (const userId of [...markers.keys()]) {
    removeUserMarker(userId);
  }
}

export function drawHistoryRoute(points, colorIndex = 0) {
  clearHistoryRoute();
  if (!getScene() || points.length === 0) return;

  historyGroup = new THREE.Group();
  historyGroup.name = 'user-history-route';

  const color = colorForIndex(colorIndex);
  const verts = points.map(
    (p) => new THREE.Vector3(Number(p.pos_x), Number(p.pos_y), Number(p.pos_z)),
  );

  const lineGeo = new THREE.BufferGeometry().setFromPoints(verts);
  historyGroup.add(
    new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
    ),
  );

  const dotGeo = new THREE.SphereGeometry(0.07, 12, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color });
  verts.forEach((v) => {
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.copy(v);
    historyGroup.add(dot);
  });

  const startMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x22c55e }),
  );
  startMesh.position.copy(verts[0]);
  historyGroup.add(startMesh);

  const endMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xef4444 }),
  );
  endMesh.position.copy(verts[verts.length - 1]);
  historyGroup.add(endMesh);

  mountToScene(historyGroup);
}

export function clearHistoryRoute() {
  if (!historyGroup) return;
  unmountFromScene(historyGroup);
  disposeObject3D(historyGroup);
  historyGroup = null;
}

/**
 * Orange / colored XYZ dots for a single user's heat-map trail (mesh map).
 * @param {Array<{ pos_x: number, pos_y: number, pos_z: number }>} points
 * @param {number} [color=0xf97316]
 */
export function drawUserTrailPoints(points, color = 0xf97316) {
  clearUserTrailPoints();
  if (!getScene() || !points?.length) return;

  /** Match geometric-mesh heat plane lift in nav-heatmap.js */
  const verts = [];
  for (const p of points) {
    const x = Number(p.pos_x);
    const y = Number(p.pos_y) + MESH_HEATMAP_Y_OFFSET;
    const z = Number(p.pos_z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      verts.push(new THREE.Vector3(x, y, z));
    }
  }
  if (!verts.length) return;

  const maxPoints = 1800;
  const sampled =
    verts.length <= maxPoints
      ? verts
      : (() => {
          const out = [];
          const step = (verts.length - 1) / (maxPoints - 1);
          for (let i = 0; i < maxPoints; i += 1) {
            out.push(verts[Math.round(i * step)]);
          }
          return out;
        })();

  userTrailGroup = new THREE.Group();
  userTrailGroup.name = 'user-heat-trail';

  const lineGeo = new THREE.BufferGeometry().setFromPoints(sampled);
  userTrailGroup.add(
    new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    ),
  );

  const count = sampled.length;
  const sphereGeo = new THREE.SphereGeometry(0.09, 10, 10);
  const sphereMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const instanced = new THREE.InstancedMesh(sphereGeo, sphereMat, count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i += 1) {
    dummy.position.copy(sampled[i]);
    dummy.updateMatrix();
    instanced.setMatrixAt(i, dummy.matrix);
  }
  instanced.instanceMatrix.needsUpdate = true;
  userTrailGroup.add(instanced);

  const startMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0x22c55e }),
  );
  startMesh.position.copy(sampled[0]);
  userTrailGroup.add(startMesh);

  const endMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0xef4444 }),
  );
  endMesh.position.copy(sampled[sampled.length - 1]);
  userTrailGroup.add(endMesh);

  mountToScene(userTrailGroup);
}

export function clearUserTrailPoints() {
  if (!userTrailGroup) return;
  unmountFromScene(userTrailGroup);
  disposeObject3D(userTrailGroup);
  userTrailGroup = null;
}

export function setMarkersVisible(visible) {
  for (const group of markers.values()) {
    group.visible = visible;
  }
}

export function setHistoryRouteVisible(visible) {
  if (historyGroup) historyGroup.visible = visible;
}

export function setUserTrailPointsVisible(visible) {
  if (userTrailGroup) userTrailGroup.visible = visible;
}
