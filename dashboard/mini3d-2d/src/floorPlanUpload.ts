import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist';

// Vite-friendly worker for PDF rendering
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export type FloorPlanAssetKind = 'png' | 'jpeg' | 'svg' | 'pdf' | 'unknown';

export type FloorPlanAsset = {
  fileName: string;
  /** Suggested floor index 1-based when detected from name; null = unassigned. */
  floorIndex: number | null;
  label: string;
  kind: FloorPlanAssetKind;
  /** Rasterized image as data URL (PNG). */
  dataUrl: string;
  width: number;
  height: number;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const PDF_EXT = /\.pdf$/i;
const ZIP_EXT = /\.zip$/i;

function kindFromName(name: string): FloorPlanAssetKind {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'jpeg';
  if (n.endsWith('.svg')) return 'svg';
  if (n.endsWith('.pdf')) return 'pdf';
  return 'unknown';
}

/** Detect floor number / ground from Matterport-style and common names. */
export function detectFloorIndexFromName(fileName: string): number | null {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const upper = base.toUpperCase();

  if (/COMPOSITE|COMBINED|ALL[_-]?FLOORS|OVERVIEW/.test(upper)) return null;

  if (/\b(GF|GROUND|GND|LL|BASEMENT|B1|LOWER)\b/.test(upper)) return 1;

  const patterns = [
    /FLOOR[_\s-]*(\d+)/i,
    /LEVEL[_\s-]*(\d+)/i,
    /LVL[_\s-]*(\d+)/i,
    /\bF(\d+)\b/i,
    /\bL(\d+)\b/i,
    /_(\d+)$/,
  ];
  for (const re of patterns) {
    const m = base.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0 && n < 200) return Math.max(1, n);
    }
  }
  return null;
}

function labelForAsset(fileName: string, floorIndex: number | null): string {
  if (floorIndex === 1) return 'Ground Floor';
  if (floorIndex != null) return `Floor ${floorIndex}`;
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return base || 'Floor plan';
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(blob);
  });
}

async function canvasToPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return canvas.toDataURL('image/png');
}

async function rasterizeImageBlob(blob: Blob, fileName: string): Promise<FloorPlanAsset> {
  const dataUrl = await blobToDataUrl(blob);
  const img = await loadImageElement(dataUrl);
  const canvas = document.createElement('canvas');
  const w = Math.max(1, img.naturalWidth || img.width);
  const h = Math.max(1, img.naturalHeight || img.height);
  // Cap huge scans for memory / tracing
  const maxDim = 2048;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const outUrl = await canvasToPngDataUrl(canvas);
  const floorIndex = detectFloorIndexFromName(fileName);
  return {
    fileName,
    floorIndex,
    label: labelForAsset(fileName, floorIndex),
    kind: kindFromName(fileName),
    dataUrl: outUrl,
    width: canvas.width,
    height: canvas.height,
  };
}

async function rasterizePdfBlob(blob: Blob, fileName: string): Promise<FloorPlanAsset[]> {
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const out: FloorPlanAsset[] = [];
  const pageCount = pdf.numPages;
  for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    const maxDim = 2048;
    const scale = Math.min(2, maxDim / Math.max(viewport.width, viewport.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const dataUrl = await canvasToPngDataUrl(canvas);
    const name =
      pageCount > 1 ? fileName.replace(/\.pdf$/i, `_p${pageNo}.pdf`) : fileName;
    let floorIndex = detectFloorIndexFromName(name);
    if (floorIndex == null && pageCount > 1) floorIndex = pageNo;
    out.push({
      fileName: name,
      floorIndex,
      label: labelForAsset(name, floorIndex),
      kind: 'pdf',
      dataUrl,
      width: canvas.width,
      height: canvas.height,
    });
  }
  return out;
}

async function parseZip(file: File): Promise<FloorPlanAsset[]> {
  const zip = await JSZip.loadAsync(file);
  const assets: FloorPlanAsset[] = [];
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('__MACOSX') || name.startsWith('.')) continue;
    const short = name.replace(/^.*[\\/]/, '');
    if (IMAGE_EXT.test(short)) {
      const blob = await entry.async('blob');
      const type = short.toLowerCase().endsWith('.svg')
        ? 'image/svg+xml'
        : short.toLowerCase().match(/jpe?g$/)
          ? 'image/jpeg'
          : 'image/png';
      assets.push(await rasterizeImageBlob(new Blob([blob], { type }), short));
    } else if (PDF_EXT.test(short)) {
      const blob = await entry.async('blob');
      assets.push(...(await rasterizePdfBlob(new Blob([blob], { type: 'application/pdf' }), short)));
    }
  }
  return assets;
}

/**
 * Accept zip / png / jpeg / svg / pdf (or a FileList) and return rasterized floor-plan assets.
 * Prefers per-floor files over composites when both exist.
 */
export async function parseFloorPlanUploads(files: FileList | File[]): Promise<FloorPlanAsset[]> {
  const list = Array.from(files);
  if (list.length === 0) return [];

  const assets: FloorPlanAsset[] = [];
  for (const file of list) {
    const name = file.name;
    if (ZIP_EXT.test(name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
      assets.push(...(await parseZip(file)));
      continue;
    }
    if (PDF_EXT.test(name) || file.type === 'application/pdf') {
      assets.push(...(await rasterizePdfBlob(file, name)));
      continue;
    }
    if (IMAGE_EXT.test(name) || file.type.startsWith('image/')) {
      assets.push(await rasterizeImageBlob(file, name));
      continue;
    }
    // Unknown extension: try as image, then pdf
    try {
      assets.push(await rasterizeImageBlob(file, name));
    } catch {
      try {
        assets.push(...(await rasterizePdfBlob(file, name)));
      } catch {
        console.warn('[floorPlanUpload] skipped unsupported file', name);
      }
    }
  }

  // Drop composites when numbered floors exist
  const hasNumbered = assets.some((a) => a.floorIndex != null);
  const filtered = hasNumbered
    ? assets.filter((a) => {
        const u = a.fileName.toUpperCase();
        return !/COMPOSITE|COMBINED|OVERVIEW/.test(u) || a.floorIndex != null;
      })
    : assets;

  // Stable order by floor index then name
  filtered.sort((a, b) => {
    const ai = a.floorIndex ?? 999;
    const bi = b.floorIndex ?? 999;
    if (ai !== bi) return ai - bi;
    return a.fileName.localeCompare(b.fileName);
  });

  // Prefer PNG over SVG for same floor index (cleaner raster for tracing)
  const byFloor = new Map<number, FloorPlanAsset>();
  const unassigned: FloorPlanAsset[] = [];
  for (const a of filtered) {
    if (a.floorIndex == null) {
      unassigned.push(a);
      continue;
    }
    const prev = byFloor.get(a.floorIndex);
    if (!prev) {
      byFloor.set(a.floorIndex, a);
      continue;
    }
    // Prefer raster png/jpeg over svg
    const score = (x: FloorPlanAsset) => (x.kind === 'svg' ? 0 : x.kind === 'pdf' ? 1 : 2);
    if (score(a) > score(prev)) byFloor.set(a.floorIndex, a);
  }

  const numbered = [...byFloor.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  return numbered.length > 0 ? [...numbered, ...unassigned] : filtered;
}

export const FLOOR_PLAN_ACCEPT =
  '.zip,.png,.jpg,.jpeg,.svg,.pdf,image/*,application/pdf,application/zip';
