/** File validation and metadata for `navme_media` uploads. */

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const MODEL_EXT = new Set(['glb', 'gltf']);
const SPLAT_EXT = new Set(['ply']);
const NAVMESH_EXT = new Set(['navmesh']);

/** MIME used when storing Recast / ZComponent `.navmesh` files. */
export const NAVMESH_MIME = 'application/vnd.recast.navmesh';

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  ply: 'application/octet-stream',
  navmesh: NAVMESH_MIME,
};

/**
 * @param {File} file
 * @returns {{ mediaType: 'image'|'video'|'model'|'splat'|'navmesh', mimeType: string, ext: string } | null}
 */
export function classifyMediaFile(file) {
  const name = String(file?.name ?? '');
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!ext) return null;

  let mediaType = null;
  if (IMAGE_EXT.has(ext)) mediaType = 'image';
  else if (VIDEO_EXT.has(ext)) mediaType = 'video';
  else if (MODEL_EXT.has(ext)) mediaType = 'model';
  else if (SPLAT_EXT.has(ext)) mediaType = 'splat';
  else if (NAVMESH_EXT.has(ext)) mediaType = 'navmesh';
  if (!mediaType) return null;

  return {
    mediaType,
    mimeType: MIME_BY_EXT[ext] ?? (file.type || 'application/octet-stream'),
    ext,
  };
}

/**
 * @param {string} poiType
 * @param {'image'|'video'|'model'|'splat'|'navmesh'} mediaType
 * @param {string} fileName
 */
export function buildStorageObjectPath(poiType, mediaType, fileName) {
  const safeType = String(poiType ?? 'unknown').replace(/[^\w.-]+/g, '_');
  const safeName = String(fileName ?? 'file').replace(/[^\w.-]+/g, '_');
  const stamp = Date.now();
  return `${safeType}/${mediaType}/${stamp}_${safeName}`;
}

/**
 * Extract storage object path from a public Supabase media URL.
 * @param {string} mediaUrl
 * @returns {string | null}
 */
export function storagePathFromPublicUrl(mediaUrl) {
  const marker = '/storage/v1/object/public/project-media/';
  const idx = String(mediaUrl ?? '').indexOf(marker);
  if (idx < 0) return null;
  return decodeURIComponent(mediaUrl.slice(idx + marker.length));
}
