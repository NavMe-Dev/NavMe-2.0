/**
 * Download a media row (image or video frame) as a PNG file.
 */

const PROXY_PATH = '/api/media-fetch';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function pngFileName(value) {
  const raw = String(value ?? 'media').replace(/\.[^.]+$/, '');
  const safe = raw.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return `${safe || 'media'}.png`;
}

/**
 * @param {Blob} blob
 * @param {string} fileName
 */
function triggerDownload(blob, fileName) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 2500);
}

/**
 * @param {string} url
 * @returns {Promise<Blob>}
 */
async function fetchMediaBlob(url) {
  const src = String(url ?? '').trim();
  if (!src) throw new Error('No media file to download.');

  if (src.startsWith('blob:') || src.startsWith('data:')) {
    const res = await fetch(src);
    if (!res.ok) throw new Error('Could not read the current media file.');
    return res.blob();
  }

  try {
    const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
    if (res.ok) return res.blob();
  } catch {
    // CORS or mixed-content — fall through to same-origin proxy.
  }

  const proxyRes = await fetch(PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: src }),
  });
  if (!proxyRes.ok) {
    const detail = await proxyRes.text().catch(() => '');
    throw new Error(detail || `Could not fetch media (${proxyRes.status}).`);
  }
  return proxyRes.blob();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not create PNG.'));
    }, 'image/png');
  });
}

/**
 * @param {Blob} blob
 * @returns {Promise<HTMLImageElement>}
 */
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not decode image.'));
    };
    img.src = objectUrl;
  });
}

/**
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function imageBlobToPng(blob) {
  const img = await blobToImage(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  if (!canvas.width || !canvas.height) throw new Error('Image has no dimensions.');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create PNG.');
  ctx.drawImage(img, 0, 0);
  return canvasToPngBlob(canvas);
}

/**
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function videoBlobToPng(blob) {
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = objectUrl;

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Could not decode video.'));
    });

    await new Promise((resolve) => {
      video.onseeked = () => resolve();
      const duration = Number(video.duration);
      const t = Number.isFinite(duration) && duration > 0 ? Math.min(0.1, duration * 0.01) : 0;
      video.currentTime = t;
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error('Video has no dimensions.');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create PNG.');
    ctx.drawImage(video, 0, 0);
    return canvasToPngBlob(canvas);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * @param {{ media_url?: string, _previewUrl?: string, media_type?: string, mime_type?: string, label?: string, file_name?: string } | null | undefined} item
 */
export async function downloadMediaAsPng(item) {
  const url = String(item?._previewUrl || item?.media_url || '').trim();
  if (!url) throw new Error('No media file to download.');

  const mediaType = String(item?.media_type || '');
  const mime = String(item?.mime_type || '');
  const isImage = mediaType === 'image' || mime.startsWith('image/');
  const isVideo = mediaType === 'video' || mime.startsWith('video/');

  if (!isImage && !isVideo) {
    throw new Error('PNG download is available for images and videos.');
  }

  const blob = await fetchMediaBlob(url);
  const pngBlob = isVideo ? await videoBlobToPng(blob) : await imageBlobToPng(blob);
  triggerDownload(pngBlob, pngFileName(item?.label || item?.file_name || 'media'));
  return pngBlob;
}
