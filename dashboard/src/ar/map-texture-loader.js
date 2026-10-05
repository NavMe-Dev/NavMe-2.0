/**
 * Lazy map texture upload — geometry shows first, textures stream in via worker pool.
 */
import * as THREE from 'three';
import {
  getDeviceTier,
  getTextureBatchSize,
  getTextureMaxSize,
  yieldToMain,
} from '../utils/device-tier.js';

const TEXTURE_KEYS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'];
const SRGB_KEYS = new Set(['map', 'emissiveMap']);

/** @type {Worker[] | null} */
let workerPool = null;
/** @type {number} */
let workerCursor = 0;
/** @type {Map<number, { resolve: (v: ImageBitmap | null) => void, reject: (e: Error) => void }>} */
const workerWaiters = new Map();
/** @type {number} */
let workerJobId = 0;
/** @type {AbortController | null} */
let activeLoadController = null;

function ensureWorkerPool() {
  if (workerPool) return workerPool;
  if (typeof Worker === 'undefined') {
    workerPool = [];
    return workerPool;
  }

  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const count = Math.min(4, Math.max(1, Math.floor(cores / 2)));
  workerPool = [];

  for (let i = 0; i < count; i++) {
    const worker = new Worker(new URL('./map-texture-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, bitmap, error } = event.data;
      const waiter = workerWaiters.get(id);
      if (!waiter) return;
      workerWaiters.delete(id);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve(bitmap ?? null);
    };
    worker.onerror = (err) => {
      console.warn('[map-textures] worker error:', err);
    };
    workerPool.push(worker);
  }

  return workerPool;
}

/**
 * @param {ImageBitmap} bitmap
 * @param {number} maxSize
 * @returns {Promise<ImageBitmap | null>}
 */
function downscaleInWorker(bitmap, maxSize) {
  const pool = ensureWorkerPool();
  if (!pool.length) return Promise.resolve(bitmap);

  const id = ++workerJobId;
  const worker = pool[workerCursor % pool.length];
  workerCursor += 1;

  return new Promise((resolve, reject) => {
    workerWaiters.set(id, { resolve, reject });
    worker.postMessage({ id, bitmap, maxSize }, [bitmap]);
  });
}

/**
 * @param {THREE.Texture} texture
 * @param {number} maxSize
 */
async function optimizeTextureImage(texture, maxSize) {
  const image = texture.image;
  if (!image) return;

  if (typeof createImageBitmap === 'function' && (image instanceof HTMLImageElement || image instanceof ImageBitmap)) {
    try {
      const source =
        image instanceof ImageBitmap
          ? image
          : await createImageBitmap(image, { premultiplyAlpha: 'none' });
      const max = Math.max(source.width, source.height);
      const optimized =
        max > maxSize ? await downscaleInWorker(source, maxSize) : source;
      if (optimized) {
        texture.image = optimized;
        texture.needsUpdate = true;
      }
      return;
    } catch (err) {
      console.warn('[map-textures] worker downscale skipped:', err);
    }
  }

  if (!(image instanceof HTMLImageElement) || !image.width || !image.height) return;
  const max = Math.max(image.width, image.height);
  if (max <= maxSize) return;

  const scale = maxSize / max;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  texture.image = canvas;
  texture.needsUpdate = true;
}

function configureTexture(tex, key) {
  if (!tex?.isTexture) return;
  if (SRGB_KEYS.has(key)) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = getDeviceTier() === 'low' ? 1 : 4;
  tex.needsUpdate = true;
}

/**
 * Detach texture maps so geometry can render immediately with base material colors.
 * @param {THREE.Object3D} root
 * @returns {Array<{ mat: THREE.Material, stashed: Record<string, THREE.Texture> }>}
 */
export function stashMapTextures(root) {
  /** @type {Array<{ mat: THREE.Material, stashed: Record<string, THREE.Texture> }>} */
  const entries = [];

  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    child.castShadow = false;
    child.receiveShadow = false;

    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      /** @type {Record<string, THREE.Texture>} */
      const stashed = {};

      for (const key of TEXTURE_KEYS) {
        const tex = mat[key];
        if (tex?.isTexture) {
          stashed[key] = tex;
          mat[key] = null;
        }
      }

      if (Object.keys(stashed).length > 0) {
        entries.push({ mat, stashed });
      }

      mat.wireframe = false;
      mat.needsUpdate = true;
    }
  });

  return entries;
}

/**
 * Progressively bind textures to materials without blocking the main thread.
 * @param {Array<{ mat: THREE.Material, stashed: Record<string, THREE.Texture> }>} entries
 * @param {{ onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal }} [options]
 */
export async function lazyLoadMapTextures(entries, options = {}) {
  activeLoadController?.abort();
  activeLoadController = new AbortController();
  const signal = options.signal ?? activeLoadController.signal;

  const flat = [];
  for (const entry of entries) {
    for (const [key, tex] of Object.entries(entry.stashed)) {
      flat.push({ mat: entry.mat, key, tex });
    }
  }

  const total = flat.length;
  if (!total) {
    options.onProgress?.(0, 0);
    return;
  }

  const maxSize = getTextureMaxSize();
  const batchSize = getTextureBatchSize();
  let loaded = 0;

  options.onProgress?.(0, total);

  for (let i = 0; i < flat.length; i += batchSize) {
    if (signal.aborted) return;

    await yieldToMain();
    if (signal.aborted) return;

    const batch = flat.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async ({ mat, key, tex }) => {
        if (signal.aborted) return;
        try {
          await optimizeTextureImage(tex, maxSize);
          if (signal.aborted) return;
          configureTexture(tex, key);
          mat[key] = tex;
          mat.needsUpdate = true;
        } catch (err) {
          console.warn('[map-textures] failed to apply texture:', err);
        }
      }),
    );

    loaded = Math.min(i + batch.length, total);
    options.onProgress?.(loaded, total);

    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** Cancel any in-flight lazy texture upload (e.g. before mesh reload). */
export function cancelLazyMapTextures() {
  activeLoadController?.abort();
  activeLoadController = null;
}
