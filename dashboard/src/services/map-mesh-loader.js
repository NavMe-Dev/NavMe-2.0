/**
 * Map loading (Astra_Zeneca_Simulation style):
 * - Default: raw Mesh.glb only (lightweight, stays responsive)
 * - On demand: TexturedMesh.glb — raw stays visible until textured geometry is ready
 */
import { yieldToMain } from '../utils/device-tier.js';
import { addMesh, setMapPerformanceMode } from '../ar/scene.js';
import { t } from '../config/i18n.js';
import {
  resolveMapMeshPlan,
  downloadMeshByKey,
} from './multiset-mesh.js';

/**
 * @typedef {{
 *   onStage?: (message: string, percent: number) => void,
 *   onDownloadProgress?: (loaded: number, total: number|null, label: string) => void,
 *   onTextureProgress?: (loaded: number, total: number) => void,
 *   createGltfLoader?: () => Promise<import('three/addons/loaders/GLTFLoader.js').GLTFLoader>,
 * }} MapLoadCallbacks
 */

/** @type {Awaited<ReturnType<typeof resolveMapMeshPlan>> | null} */
let cachedPlan = null;

/**
 * Load raw mesh only. Does not download textured mesh.
 * @param {string} token
 * @param {string} mapOrSetCode
 * @param {MapLoadCallbacks} [callbacks]
 */
export async function loadMapMeshLazy(token, mapOrSetCode, callbacks = {}) {
  return loadRawMapMesh(token, mapOrSetCode, callbacks);
}

/**
 * @param {string} token
 * @param {string} mapOrSetCode
 * @param {MapLoadCallbacks} [callbacks]
 */
export async function loadRawMapMesh(token, mapOrSetCode, callbacks = {}) {
  const { onStage, onDownloadProgress, createGltfLoader } = callbacks;
  const frameCamera = callbacks.frameCamera !== false;
  if (typeof createGltfLoader !== 'function') {
    return { ok: false, error: 'GLTF loader factory missing', quality: 'none' };
  }

  onStage?.(t('mapMeshLoader.fetchingMetadata'), 2);
  const plan = await resolveMapMeshPlan(token, mapOrSetCode);
  cachedPlan = plan;

  const loader = await createGltfLoader();
  const parts = [];
  const totalMaps = plan.length;
  let downloaded = 0;

  for (let i = 0; i < plan.length; i++) {
    const row = plan[i];
    const rawKey = row.plainKey || row.fallbackKey;
    if (!rawKey) {
      console.warn(`[map-loader] ${row.mapCode}: no raw mesh key`);
      continue;
    }

    const label = row.mapName || row.mapCode;
    const basePct = 8 + Math.round((i / Math.max(totalMaps, 1)) * 70);
    onStage?.(
      totalMaps > 1
        ? t('mapMeshLoader.downloadingRawMultiple', { index: i + 1, count: totalMaps, label })
        : t('mapMeshLoader.downloadingRawSingle'),
      basePct,
    );

    const rawBuffer = await downloadMeshByKey(token, rawKey, (loaded, total) => {
      onDownloadProgress?.(loaded, total, 'raw');
      if (total) {
        const local = Math.round((loaded / total) * (70 / Math.max(totalMaps, 1)));
        onStage?.(
          totalMaps > 1
            ? t('mapMeshLoader.downloadingRawProgressMultiple', {
                index: i + 1,
                count: totalMaps,
                loaded: formatBytes(loaded),
                total: formatBytes(total),
              })
            : t('mapMeshLoader.downloadingRawProgressSingle', {
                loaded: formatBytes(loaded),
                total: formatBytes(total),
              }),
          Math.min(88, basePct + local),
        );
      }
    });

    if (!rawBuffer) {
      console.warn(`[map-loader] ${row.mapCode}: raw download failed`);
      continue;
    }

    downloaded += 1;
    await yieldToMain();
    const gltf = await parseGltf(loader, rawBuffer);
    parts.push({
      scene: gltf.scene,
      relativePose: row.relativePose,
      mapCode: row.mapCode,
    });
  }

  if (!parts.length) {
    return { ok: false, error: 'No downloadable raw mesh found for this map', quality: 'none' };
  }

  onStage?.(t('mapMeshLoader.showingRawGeometry'), 92);
  await yieldToMain();
  setMapPerformanceMode('raw');
  addMesh(parts, { lazyTextures: false, frameCamera });
  onStage?.(t('main.mapMesh.rawReady'), 100);

  const hasTextured = plan.some(
    (row) => row.texturedKey && row.texturedKey !== row.plainKey,
  );

  return {
    ok: true,
    quality: 'raw',
    hasTextured,
    loadedCount: downloaded,
    totalCount: totalMaps,
  };
}

/**
 * Load textured mesh on demand (after raw is already showing).
 * Raw mesh stays on screen until textured geometry is decoded and swapped in.
 * @param {string} token
 * @param {string} mapOrSetCode
 * @param {MapLoadCallbacks} [callbacks]
 */
export async function loadTexturedMapMesh(token, mapOrSetCode, callbacks = {}) {
  const { onStage, onDownloadProgress, onTextureProgress, createGltfLoader } = callbacks;
  if (typeof createGltfLoader !== 'function') {
    return { ok: false, error: 'GLTF loader factory missing', quality: 'raw' };
  }

  if (!cachedPlan?.length) {
    onStage?.('Fetching map metadata…', 2);
    cachedPlan = await resolveMapMeshPlan(token, mapOrSetCode);
  }

  const loader = await createGltfLoader();
  const plan = cachedPlan;
  const parts = [];
  const totalMaps = plan.length;
  let downloaded = 0;

  for (let i = 0; i < plan.length; i++) {
    const row = plan[i];
    const texKey =
      row.texturedKey
      || (row.plainKey ? null : row.fallbackKey);

    if (!texKey) {
      console.warn(`[map-loader] ${row.mapCode}: no textured mesh key`);
      continue;
    }

    const label = row.mapName || row.mapCode;
    const basePct = 6 + Math.round((i / Math.max(totalMaps, 1)) * 55);
    onStage?.(
      totalMaps > 1
        ? `Downloading textured mesh ${i + 1}/${totalMaps} (${label})…`
        : 'Downloading textured mesh…',
      basePct,
    );

    const texturedBuffer = await downloadMeshByKey(token, texKey, (loaded, total) => {
      onDownloadProgress?.(loaded, total, 'textured');
      if (total) {
        const local = Math.round((loaded / total) * (55 / Math.max(totalMaps, 1)));
        onStage?.(
          totalMaps > 1
            ? `Downloading textured ${i + 1}/${totalMaps}… ${formatBytes(loaded)} / ${formatBytes(total)}`
            : `Downloading textured mesh… ${formatBytes(loaded)} / ${formatBytes(total)}`,
          Math.min(70, basePct + local),
        );
      }
    });

    if (!texturedBuffer) {
      console.warn(`[map-loader] ${row.mapCode}: textured download failed`);
      continue;
    }

    // Decode while raw map is still visible — do not blank the scene.
    onStage?.(
      totalMaps > 1
        ? `Decoding textured map ${i + 1}/${totalMaps}…`
        : 'Decoding textured map…',
      72 + Math.round((i / Math.max(totalMaps, 1)) * 18),
    );
    await yieldToMain();
    let texturedGltf;
    try {
      texturedGltf = await parseGltf(loader, texturedBuffer);
    } catch (err) {
      console.warn(`[map-loader] ${row.mapCode}: textured decode failed:`, err?.message || err);
      continue;
    }

    downloaded += 1;
    parts.push({
      scene: texturedGltf.scene,
      relativePose: row.relativePose,
      mapCode: row.mapCode,
    });
  }

  if (!parts.length) {
    return {
      ok: false,
      error: 'No textured mesh available for this map',
      quality: 'raw',
    };
  }

  onStage?.('Applying textured map…', 92);
  setMapPerformanceMode('textured');
  addMesh(parts, {
    lazyTextures: true,
    frameCamera: false,
    onTextureProgress: (loaded, total) => {
      onTextureProgress?.(loaded, total);
    },
  });

  onStage?.('Textured map ready', 100);
  return {
    ok: true,
    quality: 'textured',
    loadedCount: downloaded,
    totalCount: totalMaps,
  };
}

/**
 * @param {import('three/addons/loaders/GLTFLoader.js').GLTFLoader} loader
 * @param {ArrayBuffer} buffer
 */
async function parseGltf(loader, buffer) {
  await yieldToMain();
  if (typeof loader.parseAsync === 'function') {
    return loader.parseAsync(buffer, '');
  }
  return new Promise((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function clearMapMeshLoaderCache() {
  cachedPlan = null;
}
