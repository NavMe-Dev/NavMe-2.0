/**
 * Matterport Model API helpers (Node / Vite middleware).
 * Secrets: MATTERPORT_TOKEN_ID, MATTERPORT_TOKEN_SECRET (never VITE_*).
 */

const MODEL_API = 'https://api.matterport.com/api/models/graph';

/**
 * @returns {string}
 */
export function matterportAuthHeader() {
  const id = String(process.env.MATTERPORT_TOKEN_ID || '').trim();
  const secret = String(process.env.MATTERPORT_TOKEN_SECRET || '').trim();
  if (!id || !secret) {
    throw new Error('MATTERPORT_TOKEN_ID / MATTERPORT_TOKEN_SECRET not configured on the server');
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/**
 * @param {string} modelId
 * @returns {Promise<{ id: string, name: string | null, mattertags: Array<Record<string, unknown>> }>}
 */
export async function fetchModelWithMattertags(modelId) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('modelId is required');

  const res = await fetch(MODEL_API, {
    method: 'POST',
    headers: {
      Authorization: matterportAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `query ($id: ID!) {
        model(id: $id) {
          id
          name
          mattertags {
            id
            label
            description
            enabled
            anchorPosition { x y z }
          }
        }
      }`,
      variables: { id },
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Matterport HTTP ${res.status}`);
  }
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(String(payload.errors[0]?.message || 'Matterport API error'));
  }
  const model = payload?.data?.model;
  if (!model?.id) throw new Error('Matterport model not found or inaccessible for this API token');
  return {
    id: String(model.id),
    name: model.name != null ? String(model.name) : null,
    mattertags: Array.isArray(model.mattertags) ? model.mattertags : [],
  };
}

/**
 * @param {string} query
 * @param {Record<string, unknown>} [variables]
 */
async function graph(query, variables = undefined) {
  const res = await fetch(MODEL_API, {
    method: 'POST',
    headers: {
      Authorization: matterportAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Matterport HTTP ${res.status}`);
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(String(payload.errors[0]?.message || 'Matterport API error'));
  }
  return payload?.data ?? {};
}

/**
 * Every model whose MatterPak add-on is already unlocked, with the geo anchor.
 *
 * `bundles` is not exposed on ModelSearchResult, so the per-model lookups are
 * batched into one request with GraphQL aliases rather than N round trips.
 * Nothing here unlocks anything — `unlockModelBundle` is a paid mutation and is
 * deliberately never called.
 *
 * @returns {Promise<Array<{
 *   id: string, name: string, address: string | null,
 *   lat: number | null, lon: number | null, altitude: number | null,
 * }>>}
 */
export async function fetchMatterpakModels() {
  const list = await graph('{ models(pageSize: 100) { results { id name } } }');
  const results = list?.models?.results ?? [];
  if (!results.length) return [];

  // One batched request: m0..mN aliases over the same field set.
  const aliases = results
    .map(
      (r, i) => `m${i}: model(id: "${String(r.id).replace(/"/g, '')}") {
        id
        name
        geolocation { lat long altitude }
        address { address }
        bundles { id availability }
      }`,
    )
    .join('\n');
  const data = await graph(`{ ${aliases} }`);

  const out = [];
  for (let i = 0; i < results.length; i += 1) {
    const m = data[`m${i}`];
    if (!m?.id) continue;
    const pak = (m.bundles ?? []).find((b) => b?.id === 'mp:matterpak');
    if (pak?.availability !== 'unlocked') continue;
    const g = m.geolocation ?? {};
    const num = (v) => (v == null || v === '' ? null : Number(v));
    out.push({
      id: String(m.id),
      name: String(m.name ?? '').trim() || String(m.id),
      address: m.address?.address ? String(m.address.address) : null,
      lat: num(g.lat),
      lon: num(g.long),
      altitude: num(g.altitude),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Signed download links for a model's geometry, straight from Matterport.
 *
 * `downloadUrl` is a short-lived pre-signed CDN link (see `validUntil`), so it
 * must be minted per request and never persisted. The CDN echoes the caller's
 * Origin back in Access-Control-Allow-Origin, so the browser can fetch the mesh
 * itself — only this lookup needs the server-side token pair.
 *
 * `status` is 'available' once the MatterPak add-on is unlocked for the model,
 * and 'locked' when it has not been purchased.
 *
 * @param {string} modelId
 * @returns {Promise<{
 *   id: string,
 *   name: string | null,
 *   meshes: Array<{
 *     id: string, format: string, resolution: string, status: string,
 *     filename: string | null, downloadUrl: string | null, validUntil: string | null,
 *   }>,
 * }>}
 */
export async function fetchModelMeshAssets(modelId) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('modelId is required');

  const data = await graph(
    `query ($id: ID!) {
      model(id: $id) {
        id
        name
        geolocation { lat long altitude }
        address { address }
        assets {
          meshes {
            id
            format
            resolution
            status
            filename
            downloadUrl
            validUntil
          }
        }
      }
    }`,
    { id },
  );

  const model = data?.model;
  if (!model?.id) throw new Error('Matterport model not found or inaccessible for this API token');

  const g = model.geolocation ?? {};
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const meshes = Array.isArray(model.assets?.meshes) ? model.assets.meshes : [];
  return {
    id: String(model.id),
    name: model.name != null ? String(model.name) : null,
    address: model.address?.address ? String(model.address.address) : null,
    // Matterport exposes only a single anchor point here; `geocoordinates`,
    // which carries the true-north rotation, is org-policy gated off.
    lat: num(g.lat),
    lon: num(g.long),
    altitude: num(g.altitude),
    meshes: meshes.map((m) => ({
      id: String(m?.id || ''),
      format: String(m?.format || ''),
      resolution: String(m?.resolution || ''),
      status: String(m?.status || ''),
      filename: m?.filename != null ? String(m.filename) : null,
      downloadUrl: m?.downloadUrl != null ? String(m.downloadUrl) : null,
      validUntil: m?.validUntil != null ? String(m.validUntil) : null,
    })),
  };
}

/**
 * @param {unknown} tag
 */
export function normalizeMattertag(tag) {
  const t = tag && typeof tag === 'object' ? /** @type {Record<string, unknown>} */ (tag) : {};
  const pos = t.anchorPosition && typeof t.anchorPosition === 'object'
    ? /** @type {Record<string, unknown>} */ (t.anchorPosition)
    : {};
  return {
    id: String(t.id || ''),
    label: String(t.label || '').trim() || '(untitled tag)',
    description: String(t.description || '').trim(),
    enabled: t.enabled !== false,
    pos_x: Number(pos.x),
    pos_y: Number(pos.y),
    pos_z: Number(pos.z),
  };
}
