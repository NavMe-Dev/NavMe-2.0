/**
 * Media storage — `project-media` bucket (public read).
 */

import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from './supabase.js';
import { buildStorageObjectPath } from '../utils/media-files.js';

const BUCKET = 'project-media';

function ensureConfig() {
  if (!isSupabaseConfigured()) {
    throw new Error('Database connection is not configured.');
  }
}

function storageHeaders(contentType) {
  const key = getSupabaseAnonKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': contentType,
  };
}

/**
 * @param {string} objectPath
 */
export function getPublicMediaUrl(objectPath) {
  const base = getSupabaseUrl().replace(/\/$/, '');
  const encoded = objectPath.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `${base}/storage/v1/object/public/${BUCKET}/${encoded}`;
}

/**
 * @param {File} file
 * @param {string} poiType
 * @param {'image'|'video'|'model'|'splat'|'navmesh'} mediaType
 * @param {{ onProgress?: (pct: number) => void }} [opts]
 */
export async function uploadProjectMedia(file, poiType, mediaType, opts = {}) {
  ensureConfig();
  const objectPath = buildStorageObjectPath(poiType, mediaType, file.name);
  const url = `${getSupabaseUrl().replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${objectPath}`;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // XHR gives upload progress for large .ply batches (fetch body progress is limited).
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const headers = storageHeaders(file.type || 'application/octet-stream');
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.setRequestHeader('x-upsert', 'true');

    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable || ev.total <= 0) return;
      onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
        return;
      }
      let detail = xhr.responseText || xhr.statusText;
      try {
        const parsed = JSON.parse(xhr.responseText);
        detail = parsed?.message || parsed?.error || detail;
        if (String(parsed?.statusCode) === '413' || /too large|EntityTooLarge/i.test(detail)) {
          const sizeMb = file?.size ? (file.size / (1024 * 1024)).toFixed(1) : '?';
          reject(
            new Error(
              `File too large (${sizeMb} MB). Storage limit is now raised — retry upload. If it still fails, use a smaller .ply or split the cloud.`,
            ),
          );
          return;
        }
      } catch {
        /* keep detail */
      }
      reject(new Error(`Storage upload ${xhr.status}: ${detail}`));
    };

    xhr.onerror = () => reject(new Error('Storage upload network error'));
    xhr.onabort = () => reject(new Error('Storage upload aborted'));
    xhr.send(file);
  });

  return {
    objectPath,
    publicUrl: getPublicMediaUrl(objectPath),
  };
}

/**
 * @param {string} objectPath
 */
export async function deleteProjectMediaFile(objectPath) {
  if (!objectPath) return;
  ensureConfig();
  const base = getSupabaseUrl().replace(/\/$/, '');
  const encoded = objectPath.split('/').map((s) => encodeURIComponent(s)).join('/');
  const url = `${base}/storage/v1/object/${BUCKET}/${encoded}`;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${getSupabaseAnonKey()}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Could not delete file from storage (${res.status})`);
  }
}
