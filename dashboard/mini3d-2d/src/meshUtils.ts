import * as THREE from 'three';
import { yieldToMain } from './schedYield';

const _boundsTmp = new THREE.Box3();

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();

export function forEachWorldTriangle(
  root: THREE.Object3D,
  fn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3) => void,
): void {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry?.attributes?.position) return;
    const geo = obj.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    _m.copy(obj.matrixWorld);
    const idx = geo.index;
    const emit = (ia: number, ib: number, ic: number) => {
      _va.fromBufferAttribute(pos, ia).applyMatrix4(_m);
      _vb.fromBufferAttribute(pos, ib).applyMatrix4(_m);
      _vc.fromBufferAttribute(pos, ic).applyMatrix4(_m);
      _ab.subVectors(_vb, _va);
      _ac.subVectors(_vc, _va);
      _n.crossVectors(_ab, _ac);
      if (_n.lengthSq() < 1e-12) return;
      _n.normalize();
      fn(_va, _vb, _vc, _n.clone());
    };
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        emit(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) emit(i, i + 1, i + 2);
    }
  });
}

export type CollectedFloorTriangles = {
  positions: Float32Array;
  triCount: number;
};

/** Bounds without blocking the main thread on huge map sets. */
export async function computeBoxFromObjectAsync(
  root: THREE.Object3D,
  yieldEvery = 32,
): Promise<THREE.Box3> {
  const box = new THREE.Box3();
  const targets: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && (obj as THREE.Mesh).geometry) targets.push(obj);
  });
  for (let i = 0; i < targets.length; i++) {
    const obj = targets[i];
    obj.updateWorldMatrix(false, true);
    _boundsTmp.setFromObject(obj);
    if (!_boundsTmp.isEmpty()) box.union(_boundsTmp);
    if (i > 0 && i % yieldEvery === 0) await yieldToMain();
  }
  return box;
}

/** Collect horizontal floor-slice triangles for async / worker rasterization. */
export async function collectWorldFloorTrianglesAsync(
  root: THREE.Object3D,
  sliceY: number,
  band: number,
  options: {
    yieldEvery?: number;
    normalMinY?: number;
    includeAllOrientations?: boolean;
    onProgress?: (meshesDone: number, meshCount: number) => void;
  } = {},
): Promise<CollectedFloorTriangles> {
  const yieldEvery = options.yieldEvery ?? 8000;
  const normalMinY = options.normalMinY ?? 0.35;
  const includeAll = options.includeAllOrientations === true;
  const tris: number[] = [];
  let triBudget = 0;

  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry?.attributes?.position) meshes.push(obj);
  });

  for (let mi = 0; mi < meshes.length; mi++) {
    const obj = meshes[mi];
    obj.updateWorldMatrix(false, true);
    const geo = obj.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    _m.copy(obj.matrixWorld);
    const idx = geo.index;

    const emit = (ia: number, ib: number, ic: number) => {
      _va.fromBufferAttribute(pos, ia).applyMatrix4(_m);
      _vb.fromBufferAttribute(pos, ib).applyMatrix4(_m);
      _vc.fromBufferAttribute(pos, ic).applyMatrix4(_m);
      const yMin = Math.min(_va.y, _vb.y, _vc.y);
      const yMax = Math.max(_va.y, _vb.y, _vc.y);
      if (yMax < sliceY - band || yMin > sliceY + band) return;
      if (!includeAll) {
        _ab.subVectors(_vb, _va);
        _ac.subVectors(_vc, _va);
        _n.crossVectors(_ab, _ac);
        if (_n.lengthSq() < 1e-12) return;
        _n.normalize();
        if (_n.y <= normalMinY) return;
      }
      tris.push(_va.x, _va.z, _va.y, _vb.x, _vb.z, _vb.y, _vc.x, _vc.z, _vc.y);
      triBudget++;
      if (triBudget % yieldEvery === 0) {
        // yield is async — caller awaits between meshes; intra-mesh we batch
      }
    };

    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        emit(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) emit(i, i + 1, i + 2);
    }

    options.onProgress?.(mi + 1, meshes.length);
    await yieldToMain();
  }

  return { positions: new Float32Array(tris), triCount: tris.length / 9 };
}
