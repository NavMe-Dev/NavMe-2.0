/**
 * Pending Matterport tags → Accept as NavMe POIs (Matterport projects only).
 */
import {
  getSupabaseUrl,
  getSupabaseAnonKey,
  insertPoiRow,
  replacePoiCategoryLinks,
} from './supabase.js';
import { getActiveMatterportUrl } from '../ar/media.js';
import { parseMatterportModelId } from './matterport-url.js';
import { poisData, normalizePoiRow, sortPoisDataInPlace } from '../ar/pois.js';
import { hasSuperadminSession } from '../config/superadmin.js';
import { getAuthSession } from '../config/auth-session.js';

/**
 * @returns {boolean}
 */
export function isSuperAdminEditor() {
  return Boolean(hasSuperadminSession() || getAuthSession()?.role === 'superadmin');
}

/**
 * @returns {string}
 */
export function getActiveMatterportModelId() {
  return parseMatterportModelId(getActiveMatterportUrl()) || '';
}

/**
 * Matterport Cloud organization id for Edit deep-links
 * (e.g. https://my.matterport.com/models/{id}?organization=…).
 */
const MATTERPORT_EDIT_ORG =
  String(import.meta.env.VITE_MATTERPORT_ORGANIZATION_ID || 'TiE3TUbvCc2').trim();

/**
 * @param {string} modelId
 */
export function openMatterportEditForModel(modelId) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('No Matterport model id');
  // Deep-link into Matterport Cloud Edit (Add Tag / Add Media), not the model overview.
  const url = new URL(`https://my.matterport.com/models/${encodeURIComponent(id)}/edit`);
  if (MATTERPORT_EDIT_ORG) {
    url.searchParams.set('organization', MATTERPORT_EDIT_ORG);
  }
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
}

/**
 * @param {{ id?: string, matterport_tag_id?: string | null }[]} [pois]
 * @returns {Set<string>}
 */
export function acceptedMatterportTagIdSet(pois = poisData) {
  const set = new Set();
  for (const p of pois || []) {
    const id = String(p?.matterport_tag_id || '').trim();
    if (id) set.add(id);
  }
  return set;
}

/**
 * @param {string} modelId
 * @returns {Promise<{ modelId: string, modelName: string | null, tags: Array<Record<string, unknown>> }>}
 */
async function fetchMatterportTagsRaw(modelId) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('modelId is required');

  // Prefer local Vite proxy (has secrets from .env).
  try {
    const local = await fetch(`/api/matterport/tags?modelId=${encodeURIComponent(id)}`);
    if (local.ok) {
      const data = await local.json();
      if (Array.isArray(data?.tags)) return data;
    }
  } catch {
    /* fall through to Edge Function */
  }

  const base = String(getSupabaseUrl() || '').replace(/\/$/, '');
  const anon = getSupabaseAnonKey();
  if (!base || !anon) throw new Error('Supabase is not configured');

  const res = await fetch(`${base}/functions/v1/matterport-tags?modelId=${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${anon}`,
      apikey: anon,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.error || `Matterport tags HTTP ${res.status}`));
  }
  return data;
}

/**
 * @param {string} [modelId]
 * @returns {Promise<{ modelId: string, modelName: string | null, pending: Array<Record<string, unknown>>, acceptedTagIds: string[] }>}
 */
export async function fetchPendingMatterportTags(modelId = getActiveMatterportModelId()) {
  const raw = await fetchMatterportTagsRaw(modelId);
  const accepted = acceptedMatterportTagIdSet();
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const pending = tags.filter((t) => {
    const id = String(t?.id || '').trim();
    return id && !accepted.has(id);
  });
  return {
    modelId: String(raw.modelId || modelId),
    modelName: raw.modelName != null ? String(raw.modelName) : null,
    pending,
    acceptedTagIds: [...accepted],
  };
}

/**
 * Accept a Matterport tag as a live NavMe POI at the tag XYZ.
 * @param {{
 *   tagId: string,
 *   label?: string,
 *   description?: string,
 *   pos_x: number,
 *   pos_y: number,
 *   pos_z: number,
 *   categoryIds?: string[],
 * }} tag
 * @returns {Promise<number>} index in poisData
 */
export async function acceptMatterportTagAsPoi(tag) {
  const tagId = String(tag?.tagId || '').trim();
  if (!tagId) throw new Error('tagId is required');
  if (acceptedMatterportTagIdSet().has(tagId)) {
    throw new Error('This Matterport tag was already accepted');
  }

  const x = Number(tag.pos_x);
  const y = Number(tag.pos_y);
  const z = Number(tag.pos_z);
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error('Tag is missing a valid XYZ position');
  }

  const categoryIds = Array.isArray(tag.categoryIds)
    ? tag.categoryIds.map((id) => String(id)).filter(Boolean)
    : [];
  const primary = categoryIds[0] ?? null;
  const poiName = String(tag.label || 'POI').trim() || 'POI';

  const inserted = await insertPoiRow({
    poi_name: poiName,
    description: tag.description ?? null,
    category_type: primary,
    pos_x: x,
    pos_y: y,
    pos_z: z,
    expected_pos_x: x,
    expected_pos_y: y,
    expected_pos_z: z,
    matterport_tag_id: tagId,
    approval_status: 'accepted',
    is_active: true,
    show_in_ar: true,
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const normalized = normalizePoiRow(row, categoryIds);
  if (normalized.id && categoryIds.length) {
    await replacePoiCategoryLinks(normalized.id, categoryIds);
  }
  poisData.push(normalized);
  sortPoisDataInPlace();
  return poisData.findIndex((p) => p.id === normalized.id);
}
