/**
 * Gaussian splat helpers (textured 3DGS via @mkkellogg/gaussian-splats-3d).
 *
 * Locked map orientation (degrees): X = -90, Y = 0, Z = 0
 * (+90 left the scene upside-down; Z only yaws and cannot fix that.)
 * Applied on the DropInViewer Object3D.
 */
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

/** Locked rotations in degrees (matches editor UI). */
export const SPLAT_MAP_ROT_DEG = Object.freeze({ x: -90, y: 0, z: 0 });

/** Locked rotations in radians for Three.js. */
export const SPLAT_MAP_ROT_X = THREE.MathUtils.degToRad(SPLAT_MAP_ROT_DEG.x);
export const SPLAT_MAP_ROT_Y = THREE.MathUtils.degToRad(SPLAT_MAP_ROT_DEG.y);
export const SPLAT_MAP_ROT_Z = THREE.MathUtils.degToRad(SPLAT_MAP_ROT_DEG.z);

/** Identity quaternion — scene files load unrotated; we rotate the DropInViewer group. */
export const SPLAT_IDENTITY_QUAT = Object.freeze([0, 0, 0, 1]);

/**
 * Apply locked map orientation to a DropInViewer / Object3D.
 * @param {THREE.Object3D} object3d
 */
export function applySplatMapRotation(object3d) {
  if (!object3d) return;
  object3d.rotation.order = 'XYZ';
  object3d.rotation.set(SPLAT_MAP_ROT_X, SPLAT_MAP_ROT_Y, SPLAT_MAP_ROT_Z);
  object3d.updateMatrixWorld(true);
}

/**
 * @param {Record<string, unknown>} [options]
 * @returns {import('@mkkellogg/gaussian-splats-3d').DropInViewer}
 */
export function createDropInSplatViewer(options = {}) {
  return new GaussianSplats3D.DropInViewer({
    antialiased: true,
    gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false,
    sphericalHarmonicsDegree: 0,
    // Keep multi-file loads from locking the tab / running out of RAM
    optimizeSplatData: false,
    freeIntermediateSplatData: true,
    halfPrecisionCovariancesOnGPU: true,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    ...options,
  });
}

/** Yield so the UI can paint between heavy splat loads. */
export function yieldToMain(ms = 0) {
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, ms);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(done);
    } else {
      done();
    }
  });
}

/**
 * Wait until DropInViewer can accept another addSplatScene call.
 * @param {{ viewer?: { isLoadingOrUnloading?: () => boolean } }} dropIn
 * @param {number} [timeoutMs]
 */
export async function waitForSplatViewerIdle(dropIn, timeoutMs = 180_000) {
  const viewer = dropIn?.viewer;
  if (!viewer?.isLoadingOrUnloading) return;
  const start = performance.now();
  while (viewer.isLoadingOrUnloading()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for previous splat to finish loading');
    }
    await yieldToMain(40);
  }
}

/**
 * GPU max 2D texture dimension (WebGL). Library packs splats at width 4096 and
 * grows height by powers of 2 — height must stay ≤ this value.
 * @param {THREE.WebGLRenderer | null | undefined} renderer
 */
export function getMaxTextureSize(renderer) {
  try {
    const gl = renderer?.getContext?.();
    const n = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE);
    if (typeof n === 'number' && n > 0) return n;
  } catch {
    /* ignore */
  }
  return 8192;
}

/**
 * Safe splat count for one DropInViewer (single combined texture atlas).
 * Covariance packing uses ~1.5 texels/splat uncompressed; keep headroom under
 * both library MAX_TEXTURE_TEXELS (16M) and GPU max height.
 * @param {THREE.WebGLRenderer | null | undefined} renderer
 */
export function getSafeMaxSplatCountPerViewer(renderer) {
  const maxDim = getMaxTextureSize(renderer);
  // Library texture width is fixed at 4096; height must be ≤ maxDim.
  const maxHeight = Math.min(maxDim, 16384);
  const texelBudget = Math.min(4096 * maxHeight, 16_777_216);
  // ~1.5× for covariance packing + 15% headroom
  return Math.floor((texelBudget / 1.5) * 0.85);
}

/**
 * Read PLY `element vertex N` from the start of a URL (range request when possible).
 * @param {string} url
 * @returns {Promise<number | null>}
 */
export async function peekPlyVertexCount(url) {
  if (!url) return null;
  try {
    let res = await fetch(url, {
      headers: { Range: 'bytes=0-65535' },
      mode: 'cors',
    });
    if (!res.ok && res.status !== 206) {
      res = await fetch(url, { mode: 'cors' });
    }
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('ascii').decode(
      buf.byteLength > 65536 ? buf.slice(0, 65536) : buf,
    );
    const end = text.indexOf('end_header');
    const header = end >= 0 ? text.slice(0, end) : text.slice(0, 4096);
    const m = header.match(/element\s+vertex\s+(\d+)/i);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Build DropInViewer scene options for one media row.
 * Orientation is applied on the viewer group: X=-90°, Y=0°, Z=0°.
 * @param {{ media_url?: string, _previewUrl?: string, pos_x?: number, pos_y?: number, pos_z?: number, scale_x?: number, scale_y?: number, scale_z?: number, file_name?: string }} item
 */
export function splatSceneOptionFromItem(item) {
  const path = String(item._previewUrl || item.media_url || '').trim();
  return {
    path,
    format: GaussianSplats3D.SceneFormat.Ply,
    splatAlphaRemovalThreshold: 1,
    showLoadingUI: false,
    position: [Number(item.pos_x) || 0, Number(item.pos_y) || 0, Number(item.pos_z) || 0],
    rotation: [...SPLAT_IDENTITY_QUAT],
    scale: [
      Number(item.scale_x ?? 1) || 1,
      Number(item.scale_y ?? 1) || 1,
      Number(item.scale_z ?? 1) || 1,
    ],
  };
}

/** @deprecated use applySplatMapRotation */
export function splatMapRotationQuaternion() {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(SPLAT_MAP_ROT_X, SPLAT_MAP_ROT_Y, SPLAT_MAP_ROT_Z, 'XYZ'),
  );
  return [q.x, q.y, q.z, q.w];
}

export { GaussianSplats3D };
