import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fetchAllMedia, insertMediaRow, updateMediaRow, deleteMediaRow, getSupabaseUrl } from '../services/supabase.js';
import { logUserActivity, rememberEntitiesXyz } from '../services/user-logs.js';
import { isMatterportMediaRow } from '../services/matterport-url.js';
import { getForceGeometricMesh } from '../config/map-view-preference.js';
import { storagePathFromPublicUrl, NAVMESH_MIME } from '../utils/media-files.js';
import { getPublicMediaUrl } from '../services/media-storage.js';

export { isMatterportMediaRow };

/** Recast / ZComponent uploaded navmesh row. */
export function isNavmeshMediaRow(item) {
  if (!item) return false;
  if (item.media_type === 'navmesh') return true;
  if (String(item.mime_type || '') === NAVMESH_MIME) return true;
  return /\.navmesh$/i.test(String(item.file_name || item.media_url || ''));
}

/** In-memory media rows synced with `navme_media`. */
export const mediaData = [];

const mediaObjects = [];
let mediaGroupRef = null;
let mediaGroupVisible = true;
let sharedGltfLoader = null;

export function setMediaGltfLoader(loader) {
  sharedGltfLoader = loader;
}

export function normalizeMediaRow(row) {
  return {
    id: row.id,
    poi_type: row.poi_type,
    media_url: normalizeMediaUrl(row.media_url),
    media_url_ios: row.media_url_ios ? normalizeMediaUrl(row.media_url_ios) : null,
    media_type: row.media_type,
    mime_type: row.mime_type,
    file_name: row.file_name,
    label: row.label ?? row.file_name ?? 'Media',
    pos_x: Number(row.pos_x),
    pos_y: Number(row.pos_y),
    pos_z: Number(row.pos_z),
    rot_x: Number(row.rot_x),
    rot_y: Number(row.rot_y),
    rot_z: Number(row.rot_z),
    scale_x: Number(row.scale_x ?? 1),
    scale_y: Number(row.scale_y ?? 1),
    scale_z: Number(row.scale_z ?? 1),
    width: Number(row.width ?? 1),
    height: Number(row.height ?? 1),
    is_active: row.is_active !== false,
    redirect_link: row.redirect_link ?? null,
  };
}

export async function hydrateMediaFromSupabase() {
  mediaData.length = 0;
  const rows = await fetchAllMedia();
  rows.forEach((row) => mediaData.push(normalizeMediaRow(row)));
  rememberEntitiesXyz('media', mediaData);
}

/** Merge a saved DB row into in-memory mediaData (insert or update). */
export function upsertMediaFromSaved(row) {
  const normalized = normalizeMediaRow(row);
  const idx = mediaData.findIndex((m) => String(m.id) === String(normalized.id));
  if (idx >= 0) {
    const previewUrl = mediaData[idx]._previewUrl;
    mediaData[idx] = normalized;
    if (previewUrl) mediaData[idx]._previewUrl = previewUrl;
    if (mediaObjects[idx]) mediaObjects[idx].item = mediaData[idx];
    return idx;
  }
  mediaData.push(normalized);
  mediaObjects.push({ root: null, item: normalized });
  return mediaData.length - 1;
}

function resolveMediaSource(item) {
  const preview = String(item?._previewUrl || '').trim();
  const url = String(item?.media_url || '').trim();
  // Stale blob: previews (revoked after save/reload) must not win over a real URL.
  if (preview && !preview.startsWith('blob:')) {
    return normalizeMediaUrl(preview);
  }
  return normalizeMediaUrl(url);
}

/**
 * Rewrite stale / wrong-project Supabase public URLs to the configured project host.
 * Also accepts bare storage paths.
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeMediaUrl(raw) {
  const src = String(raw || '').trim();
  if (!src) return '';
  if (src.startsWith('blob:') || src.startsWith('data:')) return src;

  const marker = '/storage/v1/object/public/project-media/';
  try {
    const base = getSupabaseUrl()?.replace(/\/$/, '') || '';
    if (!base) return src;

    // Bare object path → public URL
    if (!/^https?:\/\//i.test(src) && !src.startsWith('//')) {
      const path = src.replace(/^\/+/, '');
      if (path.includes('/')) return getPublicMediaUrl(path);
      return src;
    }

    const path = storagePathFromPublicUrl(src);
    if (path) return getPublicMediaUrl(path);

    // Different supabase project host but same public path shape
    const u = new URL(src.startsWith('//') ? `https:${src}` : src);
    const idx = u.pathname.indexOf(marker);
    if (idx >= 0) {
      const objectPath = decodeURIComponent(u.pathname.slice(idx + marker.length));
      return getPublicMediaUrl(objectPath);
    }
    return u.toString();
  } catch {
    return src;
  }
}

export function resolveMediaDisplayUrl(item) {
  return resolveMediaSource(item);
}

function loadTexture(url, attempts = 3) {
  return new Promise((resolve, reject) => {
    const tryLoad = (left) => {
      new THREE.TextureLoader().load(
        url,
        resolve,
        undefined,
        (err) => {
          if (left <= 1) reject(err);
          else setTimeout(() => tryLoad(left - 1), 350);
        },
      );
    };
    tryLoad(attempts);
  });
}

function applyTransform(group, item) {
  group.position.set(item.pos_x, item.pos_y, item.pos_z);
  group.rotation.set(item.rot_x, item.rot_y, item.rot_z);
  group.scale.set(item.scale_x, item.scale_y, item.scale_z);
}

function disposeObject3D(obj) {
  obj.traverse((child) => {
    if (child.isMesh || child.isPoints) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m) return;
        m.map?.dispose();
        m.dispose();
      });
    }
    if (child.isVideoTexture) {
      const video = child.image;
      if (video?.pause) video.pause();
    }
  });
}

async function buildImagePlane(item) {
  const tex = await loadTexture(resolveMediaSource(item));
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true });
  const geo = new THREE.PlaneGeometry(item.width, item.height);
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

async function buildVideoPlane(item) {
  const previewUrl = item._previewUrl;
  const video = document.createElement('video');
  video.src = previewUrl || item.media_url;
  video.crossOrigin = previewUrl ? null : 'anonymous';
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});

  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  // WebM VP9 with alpha (AlphaMode) needs transparent material — same as image planes.
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  const geo = new THREE.PlaneGeometry(item.width, item.height);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.videoEl = video;
  return mesh;
}

async function buildModel(item) {
  const loader = sharedGltfLoader ?? new GLTFLoader();
  const source = resolveMediaSource(item);
  const gltf = await new Promise((resolve, reject) => {
    loader.load(source, resolve, undefined, reject);
  });
  const root = gltf.scene;
  root.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = false;
      c.receiveShadow = false;
    }
  });
  return root;
}

async function buildSplat(item) {
  // Overlay path unused when splat is the map; keep a lightweight placeholder.
  const geo = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `SplatPlaceholder_${item.id ?? 'item'}`;
  mesh.userData.splatUrl = item._previewUrl || item.media_url;
  return mesh;
}

/** Active splat rows used as the project map (instead of MultiSet mesh). */
export function getActiveSplatMaps() {
  return mediaData.filter((item) => item.is_active && item.media_type === 'splat');
}

/** Active uploaded Recast `.navmesh` files for this project (prefer newest). */
export function getActiveNavMeshMaps() {
  return mediaData
    .filter((item) => item.is_active && isNavmeshMediaRow(item) && item.media_url)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

/** @returns {ReturnType<typeof getActiveNavMeshMaps>[0] | null} */
export function getActiveNavMeshMap() {
  return getActiveNavMeshMaps()[0] || null;
}

export function projectUsesUploadedNavMesh() {
  return getActiveNavMeshMaps().length > 0;
}

export function projectUsesSplatMap() {
  if (getForceGeometricMesh()) return false;
  return getActiveSplatMaps().length > 0;
}

export function getActiveMatterportMaps() {
  return mediaData.filter((item) => item.is_active && isMatterportMediaRow(item));
}

export function projectUsesMatterportMap() {
  if (getForceGeometricMesh()) return false;
  return getActiveMatterportMaps().length > 0;
}

export function getActiveMatterportUrl() {
  const row = getActiveMatterportMaps()[0];
  return row ? String(row.media_url || '').trim() : '';
}

export async function createSplatVisual(item) {
  return buildSplat(item);
}

async function createMediaVisual(item) {
  if (isNavmeshMediaRow(item)) return null;
  if (item.media_type === 'image') return buildImagePlane(item);
  if (item.media_type === 'video') return buildVideoPlane(item);
  if (item.media_type === 'model') return buildModel(item);
  if (item.media_type === 'splat') return buildSplat(item);
  const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const mat = new THREE.MeshBasicMaterial({ color: 0x888888, wireframe: true });
  return new THREE.Mesh(geo, mat);
}

export async function addMediaToScene(container) {
  const existing = container.getObjectByName('MediaGroup');
  if (existing) {
    disposeObject3D(existing);
    container.remove(existing);
  }

  mediaObjects.length = 0;
  const mediaGroup = new THREE.Group();
  mediaGroup.name = 'MediaGroup';
  mediaGroupRef = mediaGroup;
  const skipSplatOverlays = projectUsesSplatMap();
  const skipMatterportOverlays = projectUsesMatterportMap();

  for (let index = 0; index < mediaData.length; index++) {
    const item = mediaData[index];
    // When splat is the map, don't also mount splat rows as editable media overlays.
    if (skipSplatOverlays && item.media_type === 'splat') {
      mediaObjects.push({ root: null, item });
      continue;
    }
    // Matterport link is the map source — never a 3D overlay.
    if (isMatterportMediaRow(item)) {
      mediaObjects.push({ root: null, item });
      continue;
    }
    // Uploaded Recast navmesh is routing data — never a scene overlay.
    if (isNavmeshMediaRow(item)) {
      mediaObjects.push({ root: null, item });
      continue;
    }
    // Space map covers the Three.js canvas — media shows via Matterport overlay/tags instead.
    if (skipMatterportOverlays) {
      mediaObjects.push({ root: null, item });
      continue;
    }
    if (!item.is_active) {
      mediaObjects.push({ root: null, item });
      continue;
    }

    const root = new THREE.Group();
    root.name = `Media_${item.id}`;
    root.userData.mediaIndex = index;

    try {
      const visual = await createMediaVisual(item);
      root.add(visual);
      applyTransform(root, item);
      mediaGroup.add(root);
      mediaObjects.push({ root, item });
    } catch (err) {
      console.warn('[media] Failed to load', item.label, err);
      mediaObjects.push({ root: null, item });
    }
  }

  mediaGroup.visible = mediaGroupVisible;
  container.add(mediaGroup);
}

export function refreshMediaGroup(container) {
  if (!container) return Promise.resolve();
  return addMediaToScene(container);
}

/**
 * Rebuild a single media item in the scene without reloading the others.
 * @param {number} index
 * @param {THREE.Object3D | null | undefined} [container]
 */
export async function remountMediaItem(index, container = mediaGroupRef?.parent) {
  if (!container || index < 0 || index >= mediaData.length) return false;

  while (mediaObjects.length < mediaData.length) {
    mediaObjects.push({ root: null, item: mediaData[mediaObjects.length] });
  }

  if (!mediaGroupRef || mediaGroupRef.parent !== container) {
    await addMediaToScene(container);
    return Boolean(mediaObjects[index]?.root);
  }

  const item = mediaData[index];
  const existing = mediaObjects[index];
  if (existing?.root) {
    disposeObject3D(existing.root);
    mediaGroupRef.remove(existing.root);
  }

  if (
    !item.is_active ||
    (projectUsesSplatMap() && item.media_type === 'splat') ||
    isMatterportMediaRow(item) ||
    projectUsesMatterportMap()
  ) {
    mediaObjects[index] = { root: null, item };
    return false;
  }

  const root = new THREE.Group();
  root.name = `Media_${item.id}`;
  root.userData.mediaIndex = index;

  try {
    const visual = await createMediaVisual(item);
    root.add(visual);
    applyTransform(root, item);
    mediaGroupRef.add(root);
    mediaObjects[index] = { root, item };
    return true;
  } catch (err) {
    console.warn('[media] Failed to remount', item.label, err);
    mediaObjects[index] = { root: null, item };
    return false;
  }
}

/**
 * After modal save: sync local cache and remount only that item.
 * @param {Record<string, unknown> | null | undefined} saved
 * @param {THREE.Object3D | null | undefined} container
 * @param {{ previewUrl?: string }} [options]
 */
export async function applySavedMediaRow(saved, container, options = {}) {
  if (!saved?.id) {
    await hydrateMediaFromSupabase();
    if (container) await refreshMediaGroup(container);
    return -1;
  }

  const index = upsertMediaFromSaved(saved);
  if (options.previewUrl) {
    mediaData[index]._previewUrl = options.previewUrl;
  }

  setMediaGroupVisible(true);

  if (container) {
    if (!mediaGroupRef || mediaGroupRef.parent !== container) {
      await refreshMediaGroup(container);
    } else {
      await remountMediaItem(index, container);
    }
  }

  return index;
}

export function setMediaGroupVisible(visible) {
  mediaGroupVisible = Boolean(visible);
  if (mediaGroupRef) mediaGroupRef.visible = mediaGroupVisible;
}

export function getMediaObjects() {
  return mediaObjects;
}

export function updateMediaTransform(index, patch) {
  const item = mediaData[index];
  const obj = mediaObjects[index];
  if (!item || !obj) return;
  const prevW = item.width;
  const prevH = item.height;
  Object.assign(item, patch);
  if (!obj.root) return;
  applyTransform(obj.root, item);

  const wChanged = patch.width != null && Number(patch.width) !== Number(prevW);
  const hChanged = patch.height != null && Number(patch.height) !== Number(prevH);
  if ((wChanged || hChanged) && (item.media_type === 'image' || item.media_type === 'video')) {
    const mesh = obj.root.children.find((c) => c.isMesh);
    if (mesh?.geometry) {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.PlaneGeometry(item.width, item.height);
    }
  }
}

export async function addMediaWithDb(body) {
  const inserted = await insertMediaRow(body);
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const normalized = normalizeMediaRow(row);
  mediaData.push(normalized);
  const idx = mediaData.findIndex((m) => m.id === normalized.id);
  if (mediaGroupRef?.parent) {
    await remountMediaItem(idx, mediaGroupRef.parent);
  }
  logUserActivity({
    action: 'created',
    entityType: 'media',
    entityId: normalized.id,
    entityLabel: normalized.label || normalized.file_name || 'Media',
    xyz: normalized,
    scale: normalized,
  });
  return idx >= 0 ? idx : mediaData.length - 1;
}

export async function saveMediaToDb(index, { logAction = 'updated' } = {}) {
  const item = mediaData[index];
  if (!item?.id) return;
  await updateMediaRow(item.id, {
    label: item.label,
    media_url: item.media_url,
    media_url_ios: item.media_url_ios ?? null,
    media_type: item.media_type,
    mime_type: item.mime_type,
    file_name: item.file_name,
    pos_x: item.pos_x,
    pos_y: item.pos_y,
    pos_z: item.pos_z,
    rot_x: item.rot_x,
    rot_y: item.rot_y,
    rot_z: item.rot_z,
    scale_x: item.scale_x,
    scale_y: item.scale_y,
    scale_z: item.scale_z,
    width: item.width,
    height: item.height,
    is_active: item.is_active,
    redirect_link: item.redirect_link ?? null,
  });
  logUserActivity({
    action: logAction,
    entityType: 'media',
    entityId: item.id,
    entityLabel: item.label || item.file_name || 'Media',
    xyz: item,
    scale: item,
  });
}

export async function removeMediaFromDb(index) {
  const item = mediaData[index];
  if (item?.id) {
    await deleteMediaRow(item.id);
    logUserActivity({
      action: 'deleted',
      entityType: 'media',
      entityId: item.id,
      entityLabel: item.label || item.file_name || 'Media',
    });
  }
}

export function deleteMediaFromScene(index) {
  if (index < 0 || index >= mediaData.length) return;
  const obj = mediaObjects[index];
  if (obj?.root && mediaGroupRef) {
    disposeObject3D(obj.root);
    mediaGroupRef.remove(obj.root);
  }
  mediaObjects.splice(index, 1);
  mediaData.splice(index, 1);
  mediaObjects.forEach((entry, i) => {
    if (entry.root) entry.root.userData.mediaIndex = i;
  });
}

/** Remove by DB id (used by realtime DELETE). */
export function deleteMediaFromSceneById(id) {
  const index = mediaData.findIndex((m) => String(m.id) === String(id));
  if (index >= 0) deleteMediaFromScene(index);
}

// ─────────────────────────── stable-id entry points ───────────────────────────
// The shared `mediaData` array is reordered/spliced/pushed by realtime events and
// by other panels. Any operation that captures a numeric index and then awaits
// (confirm dialogs, dynamic imports, network) can have that index go stale and hit
// the WRONG media row. These id-based wrappers resolve the current index at call
// time, so a write/delete always targets the exact item the user selected.

/** Current array index for a stable media id, or -1 if it is gone. */
export function mediaIndexById(id) {
  if (id === null || id === undefined || id === '') return -1;
  return mediaData.findIndex((m) => String(m.id) === String(id));
}

/** The media item with this stable id, or null. */
export function mediaItemById(id) {
  const index = mediaIndexById(id);
  return index >= 0 ? mediaData[index] : null;
}

/** Save the DB row for a stable id (resolves current index at call time). */
export async function saveMediaToDbById(id, opts = {}) {
  const index = mediaIndexById(id);
  if (index < 0) return;
  return saveMediaToDb(index, opts);
}

/** Delete the DB row for a stable id (resolves current index at call time). */
export async function removeMediaFromDbById(id) {
  const index = mediaIndexById(id);
  if (index < 0) return;
  return removeMediaFromDb(index);
}

/** Remove one item from the scene + arrays by stable id (safe under reordering). */
export function deleteMediaFromSceneByIdSafe(id) {
  deleteMediaFromSceneById(id);
}

/** Apply a transform patch to the item with this stable id. */
export function updateMediaTransformById(id, patch) {
  const index = mediaIndexById(id);
  if (index < 0) return;
  return updateMediaTransform(index, patch);
}
