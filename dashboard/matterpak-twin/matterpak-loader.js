/**
 * Browser Matterpak ZIP → mesh assets (no dashboard / Multiset deps).
 *
 * Matterpak layout (typical):
 *   *.obj + *.mtl + *_NNN.jpg atlas tiles
 *   cloud.xyz (point cloud — skipped; often >1GB)
 *   colorplan.pdf / ceilingcolorplan.pdf (optional)
 */
import { unzipSync, strFromU8 } from 'fflate';

const SKIP_EXT = new Set(['.xyz', '.pdf', '.txt', '.md']);
const MESH_EXT = new Set(['.obj', '.mtl']);
const TEX_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function basename(path) {
  const p = String(path || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function extname(name) {
  const n = String(name || '').toLowerCase();
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i) : '';
}

/**
 * @param {File|Blob|ArrayBuffer} file
 * @param {{ onProgress?: (msg: string, pct?: number) => void }} [opts]
 */
export async function loadMatterpakZip(file, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  onProgress('Reading ZIP…', 5);
  const buf =
    file instanceof ArrayBuffer
      ? new Uint8Array(file)
      : new Uint8Array(await file.arrayBuffer());

  onProgress('Unpacking (skipping cloud.xyz)…', 15);
  /** @type {Record<string, Uint8Array>} */
  let files;
  try {
    files = unzipSync(buf, {
      filter: (file) => {
        const name = basename(file.name);
        const ext = extname(name);
        if (!name || name.startsWith('.')) return false;
        if (SKIP_EXT.has(ext)) return false;
        if (name.toLowerCase() === 'cloud.xyz') return false;
        return MESH_EXT.has(ext) || TEX_EXT.has(ext);
      },
    });
  } catch (err) {
    throw new Error(
      err?.message
        ? `Could not read ZIP: ${err.message}`
        : 'Could not read Matterpak ZIP',
    );
  }

  const entries = Object.keys(files);
  if (!entries.length) {
    throw new Error('No OBJ/MTL/textures found in ZIP (is this a Matterpak?)');
  }

  onProgress(`Found ${entries.length} mesh assets…`, 35);

  /** @type {Map<string, string>} lowercased basename → object URL */
  const blobUrls = new Map();
  /** @type {string[]} */
  const objectUrls = [];

  const revokeAll = () => {
    for (const url of objectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* */
      }
    }
    objectUrls.length = 0;
    blobUrls.clear();
  };

  let objName = null;
  let mtlName = null;
  let objText = null;
  let mtlText = null;

  for (const path of entries) {
    const name = basename(path);
    const ext = extname(name);
    const data = files[path];
    if (!data) continue;

    if (ext === '.obj' && !objName) {
      objName = name;
      objText = strFromU8(data);
      continue;
    }
    if (ext === '.mtl' && !mtlName) {
      mtlName = name;
      mtlText = strFromU8(data);
      continue;
    }
    if (TEX_EXT.has(ext)) {
      const mime =
        ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      objectUrls.push(url);
      blobUrls.set(name.toLowerCase(), url);
    }
  }

  if (!objName || !objText) {
    revokeAll();
    throw new Error('Matterpak ZIP is missing the .obj mesh');
  }
  if (!mtlName || !mtlText) {
    revokeAll();
    throw new Error('Matterpak ZIP is missing the .mtl materials file');
  }

  onProgress(`OBJ ${objName} · ${blobUrls.size} textures`, 55);

  return {
    objName,
    mtlName,
    objText,
    mtlText,
    textureCount: blobUrls.size,
    assetCount: entries.length,
    /** Resolve MTL map_Kd filenames to blob URLs. */
    resolveTextureUrl(fileName) {
      const key = basename(fileName).toLowerCase();
      return blobUrls.get(key) || null;
    },
    revokeAll,
  };
}
