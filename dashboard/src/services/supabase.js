/**
 * Supabase REST client — metadigilabs NavMe Suhashouse (`navme_*` tables).
 *
 * Set in `.env` (Vite):
 *   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
 *   VITE_SUPABASE_ANON_KEY=<anon_jwt>
 */

import { parseJsonResponse } from '../utils/parse-json-response.js';
import { getPoiType } from '../config/poi-session.js';
import { getDefaultOrganizationId } from '../config/organization.js';
import { MULTISET_MAP } from '../config/spacecheck-access.js';
import { getAuthAccountId, ownershipFilterParams } from '../config/auth-session.js';
import { MATTERPORT_MIME, parseMatterportModelId } from './matterport-url.js';
import { NAVMESH_MIME } from '../utils/media-files.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export function getSupabaseUrl() {
  return SUPABASE_URL;
}

export function getSupabaseAnonKey() {
  return SUPABASE_ANON_KEY;
}

export function isSupabaseConfigured() {
  return Boolean(String(SUPABASE_URL).trim() && String(SUPABASE_ANON_KEY).trim());
}

const baseHeaders = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

function ensureConfig() {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. For local dev, create `.env` next to package.json. On Render, set both variables on the service and redeploy so the build can embed them.'
    );
  }
}

async function query(path) {
  ensureConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: baseHeaders });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Database ${res.status}: ${t || res.statusText}`);
  }
  const data = await parseJsonResponse(res, 'Database');
  return data == null ? [] : data;
}

async function mutate(method, path, body = null) {
  ensureConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...baseHeaders, Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Database ${method} ${res.status}: ${text || res.statusText}`);
  }
  if (method === 'DELETE') return null;
  return parseJsonResponse(res, 'Database');
}

function poiTypeFilterParam() {
  const poiType = getPoiType();
  if (!poiType) return '';
  return `poi_type=ilike.${encodeURIComponent(poiType)}`;
}

function withOwnershipInsert(body) {
  const id = getAuthAccountId();
  if (!id) return body;
  return { ...body, created_by: id };
}

function withOwnershipQuery(path) {
  const extra = ownershipFilterParams();
  return extra ? `${path}${extra}` : path;
}

async function callRpc(name, payload) {
  ensureConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Database ${res.status}: ${t || res.statusText}`);
  }
  return parseJsonResponse(res, 'Database');
}

/**
 * RBAC login via `authenticate_navme_account`.
 * @returns {Promise<null | {
 *   accountId: string,
 *   email: string,
 *   isSuperadmin: boolean,
 *   role: 'superadmin'|'project_admin'|'sub_admin'|null,
 *   poiType: string|null,
 *   mapCode: string|null,
 *   clientId: string,
 *   clientSecret: string,
 *   memberId: string|null,
 *   organizationId: string,
 * }>}
 */
export async function authenticateNavmeAccount({ email, password }) {
  const cleanEmail = String(email ?? '').trim();
  const cleanPassword = String(password ?? '');
  if (!cleanEmail || !cleanPassword) return null;

  try {
    const rows = await callRpc('authenticate_navme_account', {
      p_email: cleanEmail,
      p_password: cleanPassword,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.account_id) return null;

    const isSuperadmin = Boolean(row.is_superadmin) || String(row.role ?? '') === 'superadmin';
    const role = isSuperadmin
      ? 'superadmin'
      : String(row.role ?? '').trim() || null;
    const poiType = String(row.poi_type ?? '').trim() || null;
    const mapCode = String(row.map_code ?? '').trim() || null;
    const clientId = String(row.client_id ?? '').trim() || MULTISET_MAP.clientId;
    const clientSecret = String(row.client_secret ?? '').trim() || MULTISET_MAP.clientSecret;

    return {
      accountId: String(row.account_id),
      email: String(row.email ?? cleanEmail).trim(),
      isSuperadmin,
      role,
      poiType,
      mapCode,
      clientId,
      clientSecret,
      memberId: row.member_id ? String(row.member_id) : null,
      organizationId: getDefaultOrganizationId(),
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    // Account not in navme_accounts / Invalid credentials / RPC or table missing → legacy logins.
    const tryLegacy =
      msg.includes('404') ||
      msg.includes('does not exist') ||
      msg.includes('Invalid credentials') ||
      msg.includes('P0001') ||
      msg.includes('42P01') ||
      msg.includes('PGRST202');
    if (!tryLegacy) throw err;

    console.warn('[auth] authenticate_navme_account failed — trying legacy login');
    const legacy = await authenticateLoginNavme({ email, password });
    if (!legacy) return null;
    return {
      accountId: '',
      email: cleanEmail,
      isSuperadmin: false,
      role: 'project_admin',
      poiType: legacy.poiType,
      mapCode: legacy.mapCode,
      clientId: legacy.clientId,
      clientSecret: legacy.clientSecret,
      memberId: null,
      organizationId: legacy.organizationId,
    };
  }
}

export async function adminAssignProjectAdmin({
  email,
  password,
  poiType,
  adminEmail,
  adminPassword,
  displayName = null,
}) {
  const rows = await callRpc('admin_assign_project_admin', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_poi_type: String(poiType ?? '').trim(),
    p_admin_email: String(adminEmail ?? '').trim(),
    p_admin_password: String(adminPassword ?? ''),
    p_display_name: displayName != null ? String(displayName) : null,
  });
  return Array.isArray(rows) ? rows[0] ?? rows : rows;
}

export async function projectAdminUpsertSubAdmin({
  email,
  password,
  subEmail,
  subPassword,
  displayName = null,
  active = true,
  poiType = null,
}) {
  const rows = await callRpc('project_admin_upsert_sub_admin', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_sub_email: String(subEmail ?? '').trim(),
    p_sub_password: String(subPassword ?? ''),
    p_display_name: displayName != null ? String(displayName) : null,
    p_active: Boolean(active),
    p_poi_type: poiType != null ? String(poiType).trim() : null,
  });
  return Array.isArray(rows) ? rows[0] ?? rows : rows;
}

export async function projectAdminDeleteSubAdmin({
  email,
  password,
  subEmail,
  poiType = null,
}) {
  const rows = await callRpc('project_admin_delete_sub_admin', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_sub_email: String(subEmail ?? '').trim(),
    p_poi_type: poiType != null ? String(poiType).trim() : null,
  });
  return Array.isArray(rows) ? rows[0] ?? rows : rows;
}

export async function adminListProjectMembers({ email, password, poiType }) {
  const rows = await callRpc('admin_list_project_members', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_poi_type: String(poiType ?? '').trim(),
  });
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
}

export async function projectAdminAssignEntity({
  email,
  password,
  table,
  rowId,
  assigneeAccountId,
}) {
  return callRpc('project_admin_assign_entity', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_table: String(table ?? '').trim(),
    p_row_id: rowId,
    p_assignee_account_id: assigneeAccountId,
  });
}

/**
 * Load own account profile fields (display name, email) after credential check.
 * @returns {Promise<{ accountId: string, email: string, displayName: string | null }>}
 */
export async function accountGetOwnProfile({ email, password }) {
  const rows = await callRpc('account_get_own_profile', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.account_id) {
    throw new Error('Could not load profile');
  }
  return {
    accountId: String(row.account_id),
    email: String(row.email ?? '').trim(),
    displayName: row.display_name != null ? String(row.display_name) : null,
  };
}

/**
 * Update own display name / email / password. Requires current password.
 * @returns {Promise<{ accountId: string, email: string, displayName: string | null }>}
 */
export async function accountUpdateOwnProfile({
  email,
  password,
  displayName = null,
  newEmail = null,
  newPassword = null,
}) {
  const rows = await callRpc('account_update_own_profile', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_display_name: displayName,
    p_new_email: newEmail != null ? String(newEmail).trim() : null,
    p_new_password: newPassword != null && String(newPassword).length ? String(newPassword) : null,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.account_id) {
    throw new Error('Could not update profile');
  }
  return {
    accountId: String(row.account_id),
    email: String(row.email ?? '').trim(),
    displayName: row.display_name != null ? String(row.display_name) : null,
  };
}

/**
 * Login via `navme_logins` (email + password) and resolve POI scope metadata.
 */
export async function authenticateLoginNavme({ email, password }) {
  ensureConfig();
  const cleanEmail = String(email ?? '').trim();
  const cleanPassword = String(password ?? '');
  if (!cleanEmail || !cleanPassword) return null;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/authenticate_login_navme`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      p_email: cleanEmail,
      p_password: cleanPassword,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Database ${res.status}: ${t || res.statusText}`);
  }

  const rows = await parseJsonResponse(res, 'Database');
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;

  const poiType = String(row.poi_type ?? '').trim();
  const mapCode = String(row.map_code ?? '').trim();
  const clientId = String(row.client_id ?? '').trim() || MULTISET_MAP.clientId;
  const clientSecret = String(row.client_secret ?? '').trim() || MULTISET_MAP.clientSecret;
  if (!poiType || !mapCode) return null;

  return { poiType, mapCode, clientId, clientSecret, organizationId: getDefaultOrganizationId() };
}

/** @deprecated Use authenticateLoginNavme */
export const authenticateLoginArropins = authenticateLoginNavme;

export function fetchAllPois() {
  const filter = poiTypeFilterParam();
  const base = filter ? `?select=*&${filter}&order=poi_name.asc` : '?select=*&order=poi_name.asc';
  return query(withOwnershipQuery(`navme_pois${base}`));
}

export function insertPoiRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('POI session is missing category context.');
  }
  return mutate(
    'POST',
    'navme_pois',
    withOwnershipInsert({
      ...body,
      poi_type: poiType,
      organization_id: getDefaultOrganizationId(),
      is_active: body.is_active ?? true,
      show_in_ar: body.show_in_ar ?? true,
    }),
  );
}

export function updatePoiRow(id, data) {
  return mutate('PATCH', `navme_pois?id=eq.${id}`, data);
}

export function deletePoiRow(id) {
  return mutate('DELETE', `navme_pois?id=eq.${id}`);
}

// ——— Categories (`navme_categories`) ———

export function fetchAllCategories() {
  const filter = poiTypeFilterParam();
  const base = filter
    ? `?select=*&${filter}&order=sort_order.asc,name.asc`
    : '?select=*&order=sort_order.asc,name.asc';
  return query(withOwnershipQuery(`navme_categories${base}`));
}

export function insertCategoryRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('Category session is missing project context.');
  }
  return mutate(
    'POST',
    'navme_categories',
    withOwnershipInsert({
      ...body,
      poi_type: poiType,
      organization_id: getDefaultOrganizationId(),
    }),
  );
}

export function updateCategoryRow(id, data) {
  return mutate('PATCH', `navme_categories?id=eq.${id}`, {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export function deleteCategoryRow(id) {
  return mutate('DELETE', `navme_categories?id=eq.${id}`);
}

// ——— Floors (`navme_floors`) ———

export function fetchAllFloors() {
  const filter = poiTypeFilterParam();
  const base = filter
    ? `?select=*&${filter}&order=sort_order.asc,slice_y.asc,name.asc`
    : '?select=*&order=sort_order.asc,slice_y.asc,name.asc';
  return query(`navme_floors${base}`);
}

/**
 * Every project that has a Matterport space, for the standalone wayfinding
 * picker. Deliberately NOT scoped by the current poi_type — this is the list
 * used to choose which project to open.
 */
export async function fetchMatterportProjects() {
  const rows = await query(
    'navme_media?select=poi_type,media_url,media_type,is_active&is_active=eq.true',
  );
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = String(row?.media_url ?? '');
    const type = String(row?.media_type ?? '');
    const isMatterport = /matterport\.com/i.test(url) || /matterport/i.test(type);
    if (!isMatterport) continue;
    const poiType = String(row?.poi_type ?? '').trim();
    if (poiType && !seen.has(poiType)) seen.set(poiType, url);
  }
  return [...seen.entries()]
    .map(([poi_type, media_url]) => ({ poi_type, media_url }))
    .sort((a, b) => a.poi_type.localeCompare(b.poi_type));
}

/** Staircases declared by a super admin (navme_stair_chains). */
export function fetchAllStairChains() {
  const filter = poiTypeFilterParam();
  const base = filter
    ? `?select=*&${filter}&is_active=eq.true&order=sort_order.asc`
    : '?select=*&is_active=eq.true&order=sort_order.asc';
  return query(`navme_stair_chains${base}`);
}

export function insertStairChainRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('Stair chain session is missing project context.');
  }
  return mutate('POST', 'navme_stair_chains', { ...body, poi_type: poiType });
}

export function updateStairChainRow(id, patch) {
  return mutate('PATCH', `navme_stair_chains?id=eq.${encodeURIComponent(id)}`, patch);
}

export function deleteStairChainRow(id) {
  return mutate('DELETE', `navme_stair_chains?id=eq.${encodeURIComponent(id)}`);
}

export function insertFloorRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('Floor session is missing project context.');
  }
  return mutate('POST', 'navme_floors', {
    ...body,
    poi_type: poiType,
    organization_id: body.organization_id ?? getDefaultOrganizationId(),
  });
}

export function updateFloorRow(id, data) {
  return mutate('PATCH', `navme_floors?id=eq.${id}`, {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export function deleteFloorRow(id) {
  return mutate('DELETE', `navme_floors?id=eq.${id}`);
}

// ——— Guided tours (`navme_guided_tours` + `navme_guided_tour_stops`) ———

export function fetchAllGuidedTours() {
  const filter = poiTypeFilterParam();
  const base = filter
    ? `?select=*&${filter}&order=sort_order.asc,name.asc`
    : '?select=*&order=sort_order.asc,name.asc';
  return query(`navme_guided_tours${base}`);
}

/** @param {Array<string|number>} tourIds */
export function fetchGuidedTourStops(tourIds = []) {
  const ids = (Array.isArray(tourIds) ? tourIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  if (!ids.length) return Promise.resolve([]);
  const list = ids.map((id) => encodeURIComponent(id)).join(',');
  return query(
    `navme_guided_tour_stops?select=tour_id,poi_id,sort_order&tour_id=in.(${list})&order=sort_order.asc`,
  );
}

export function insertGuidedTourRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('Guided tour session is missing project context.');
  }
  // Same pattern as floors: `navme_guided_tours` has no `created_by` column.
  return mutate('POST', 'navme_guided_tours', {
    ...body,
    poi_type: poiType,
    organization_id: getDefaultOrganizationId(),
  });
}

export function updateGuidedTourRow(id, data) {
  return mutate('PATCH', `navme_guided_tours?id=eq.${id}`, {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export function deleteGuidedTourRow(id) {
  return mutate('DELETE', `navme_guided_tours?id=eq.${id}`);
}

/** Replace all stops for one guided tour. */
export async function replaceGuidedTourStops(tourId, stops = []) {
  const id = String(tourId ?? '').trim();
  if (!id) throw new Error('tour id is required');

  const rows = [];
  const seen = new Set();
  const list = Array.isArray(stops) ? stops : [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const poiId = String(
      typeof raw === 'object' && raw != null ? raw.poi_id ?? raw.poiId : raw ?? '',
    ).trim();
    if (!poiId || seen.has(poiId)) continue;
    seen.add(poiId);
    const sortOrder =
      typeof raw === 'object' && raw != null && raw.sort_order != null
        ? Number(raw.sort_order) || 0
        : i;
    rows.push({ tour_id: id, poi_id: poiId, sort_order: sortOrder });
  }

  await mutate('DELETE', `navme_guided_tour_stops?tour_id=eq.${encodeURIComponent(id)}`);
  if (!rows.length) return [];
  return mutate('POST', 'navme_guided_tour_stops', rows);
}

// ——— POI ↔ categories (many-to-many) ———

/** @param {Array<string|number>} poiIds */
export function fetchPoiCategoryLinks(poiIds = []) {
  const ids = (Array.isArray(poiIds) ? poiIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  if (!ids.length) return Promise.resolve([]);
  const list = ids.map((id) => encodeURIComponent(id)).join(',');
  return query(
    `navme_poi_categories?select=poi_id,category_id,sort_order&poi_id=in.(${list})&order=sort_order.asc`,
  );
}

/** Replace all category links for one POI (order = primary first). */
export async function replacePoiCategoryLinks(poiId, categoryIds = []) {
  const id = String(poiId ?? '').trim();
  if (!id) throw new Error('poi id is required');

  const unique = [];
  const seen = new Set();
  for (const raw of categoryIds) {
    const cid = String(raw ?? '').trim();
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    unique.push(cid);
  }

  await mutate('DELETE', `navme_poi_categories?poi_id=eq.${encodeURIComponent(id)}`);
  if (!unique.length) return [];

  const rows = unique.map((category_id, sort_order) => ({
    poi_id: id,
    category_id,
    sort_order,
  }));
  return mutate('POST', 'navme_poi_categories', rows);
}

// ——— Facilities (`navme_facilities`) ———

export function fetchAllFacilities() {
  const filter = poiTypeFilterParam();
  const base = filter ? `?select=*&${filter}&order=facility_name.asc` : '?select=*&order=facility_name.asc';
  return query(withOwnershipQuery(`navme_facilities${base}`));
}

export function insertFacilityRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('POI session is missing category context.');
  }
  return mutate(
    'POST',
    'navme_facilities',
    withOwnershipInsert({
      ...body,
      poi_type: poiType,
      organization_id: getDefaultOrganizationId(),
      is_active: body.is_active ?? true,
    }),
  );
}

export function updateFacilityRow(id, data) {
  const poiType = getPoiType();
  const filter = poiType
    ? `?id=eq.${id}&poi_type=ilike.${encodeURIComponent(poiType)}`
    : `?id=eq.${id}`;
  return mutate('PATCH', `navme_facilities${filter}`, data);
}

export function deleteFacilityRow(id) {
  const poiType = getPoiType();
  const filter = poiType
    ? `?id=eq.${id}&poi_type=ilike.${encodeURIComponent(poiType)}`
    : `?id=eq.${id}`;
  return mutate('DELETE', `navme_facilities${filter}`);
}

// ——— Media (`navme_media`) ———

function mediaFilterParams({ poiType, mediaType, isActive, search, ownership } = {}) {
  const parts = [];
  // Exact match, not ilike: project ids routinely contain underscores, and in
  // PostgREST `ilike` a literal `_` is a single-char wildcard — so `ilike` could
  // pull a sibling project's media into this project's shared in-memory list.
  // insert/update/delete and the realtime channel all scope by `eq`, so `eq`
  // here keeps the fetched set consistent with every other media operation.
  if (poiType) parts.push(`poi_type=eq.${encodeURIComponent(poiType)}`);
  if (mediaType) parts.push(`media_type=eq.${encodeURIComponent(mediaType)}`);
  if (isActive === true) parts.push('is_active=eq.true');
  if (isActive === false) parts.push('is_active=eq.false');

  const ownInner = ownership
    ? String(ownership)
        .replace(/^&/, '')
        .replace(/^or=\(/, '')
        .replace(/\)$/, '')
    : '';
  let searchInner = '';
  if (search) {
    const q = encodeURIComponent(`%${search}%`);
    searchInner = `label.ilike.${q},file_name.ilike.${q}`;
  }

  if (ownInner && searchInner) {
    parts.push(`and=(or(${ownInner}),or(${searchInner}))`);
  } else if (ownInner) {
    parts.push(`or=(${ownInner})`);
  } else if (searchInner) {
    parts.push(`or=(${searchInner})`);
  }

  return parts.length ? `&${parts.join('&')}` : '';
}

/**
 * Project map assets (Matterport space + splat maps + uploaded navmesh) are tenant
 * infrastructure — visible to all roles on the poi_type, not subject to sub-admin ownership.
 * @param {string} poiType
 */
async function fetchProjectMapMediaRows(poiType) {
  const clean = String(poiType ?? '').trim();
  if (!clean) return [];
  const mpMime = encodeURIComponent(MATTERPORT_MIME);
  const navMime = encodeURIComponent(NAVMESH_MIME);
  const qs =
    // Exact poi_type match (see mediaFilterParams): `ilike` would let a project
    // whose id is a wildcard-prefix of another leak map assets across projects.
    `?select=*&poi_type=eq.${encodeURIComponent(clean)}` +
    `&or=(media_type.eq.matterport,media_type.eq.splat,media_type.eq.navmesh,mime_type.eq.${mpMime},mime_type.eq.${navMime})` +
    `&order=created_at.desc`;
  return query(`navme_media${qs}`);
}

function mergeMediaRowsById(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      const id = String(row?.id ?? '');
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, row);
    }
  }
  return [...byId.values()];
}

/**
 * @param {{ poiType?: string, mediaType?: string, isActive?: boolean | null, search?: string, allTypes?: boolean, skipOwnership?: boolean }} [opts]
 */
export async function fetchAllMedia(opts = {}) {
  const useSessionType = !opts.allTypes && !opts.poiType;
  const poiType = opts.poiType ?? (useSessionType ? getPoiType() : '');
  const ownership =
    opts.allTypes || opts.skipOwnership ? '' : ownershipFilterParams();
  const filter = mediaFilterParams({
    poiType: poiType || undefined,
    mediaType: opts.mediaType,
    isActive: opts.isActive,
    search: opts.search,
    ownership,
  });
  const qs = `?select=*${filter}&order=created_at.desc`;
  const rows = await query(`navme_media${qs}`);

  // Sub-admins must still receive the project's Matterport / splat map rows.
  if (ownership && poiType && !opts.mediaType) {
    const mapRows = await fetchProjectMapMediaRows(poiType);
    return mergeMediaRowsById(rows, mapRows);
  }
  return rows;
}

export function insertMediaRow(body) {
  const poiType = String(body.poi_type ?? getPoiType() ?? '').trim();
  if (!poiType) {
    throw new Error('poi_type is required for media.');
  }
  const mediaType = String(body.media_type ?? '').trim();
  const defaultRotX = mediaType === 'splat' ? -Math.PI / 2 : 0;
  const defaultRotZ = 0;
  return mutate(
    'POST',
    'navme_media',
    withOwnershipInsert({
      poi_type: poiType,
      media_url: body.media_url,
      media_url_ios: body.media_url_ios ?? null,
      media_type: mediaType,
      mime_type: body.mime_type ?? null,
      file_name: body.file_name ?? null,
      label: body.label ?? null,
      pos_x: body.pos_x ?? 0,
      pos_y: body.pos_y ?? 0,
      pos_z: body.pos_z ?? 0,
      rot_x: body.rot_x ?? defaultRotX,
      rot_y: body.rot_y ?? 0,
      rot_z: body.rot_z ?? defaultRotZ,
      scale_x: body.scale_x ?? 1,
      scale_y: body.scale_y ?? 1,
      scale_z: body.scale_z ?? 1,
      width: body.width ?? 1,
      height: body.height ?? 1,
      is_active: body.is_active ?? true,
      redirect_link: body.redirect_link ?? null,
    }),
  );
}

export function updateMediaRow(id, data) {
  return mutate('PATCH', `navme_media?id=eq.${id}`, {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export function deleteMediaRow(id) {
  return mutate('DELETE', `navme_media?id=eq.${id}`);
}

// ——— Navnodes (`navme_navnode`) — heat map ———

function isMissingColumnError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /42703|column .* does not exist|PGRST/i.test(msg);
}

/** Map DB row to heatmap / tracking shape. */
export function normalizeNavnodeRow(r) {
  if (!r || typeof r !== 'object') return r;
  return {
    ...r,
    pos_x: Number(r.pos_x ?? r.x ?? 0),
    pos_y: Number(r.pos_y ?? r.y ?? 0),
    pos_z: Number(r.pos_z ?? r.z ?? 0),
    recorded_at: r.recorded_at ?? r.created_at ?? r.updated_at ?? null,
  };
}

/**
 * Navnode scope matches POIs/media: filter by session poi_type only.
 * Navrows often use a different organization_id than navme_pois for the same poi_type.
 */
function navnodeFilterParams() {
  const filter = poiTypeFilterParam();
  return filter ? `&${filter}` : '';
}

function rowMatchesSessionPoiType(row) {
  const poiType = getPoiType();
  if (!poiType) return false;
  const rowType = String(row?.poi_type ?? '').trim();
  if (!rowType) return false;
  return rowType.toLowerCase() === poiType.toLowerCase();
}

function filterNavnodesForSession(rows) {
  const poiType = getPoiType();
  if (!poiType) return [];
  return (rows || []).filter(rowMatchesSessionPoiType);
}

async function fetchUserIdsForPoiType(poiType) {
  const enc = encodeURIComponent(poiType);
  const pageSize = 1000;
  const ids = new Set();
  let offset = 0;

  while (offset < 50000) {
    const rows = await query(
      `navme_navnode?select=user_id&poi_type=ilike.${enc}&user_id=not.is.null&limit=${pageSize}&offset=${offset}`,
    );
    const batch = Array.isArray(rows) ? rows : [];
    for (const row of batch) {
      if (row?.user_id) ids.add(String(row.user_id));
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return [...ids];
}

const NAVNODE_TIME_COL = ['recorded_at'];

/** Only columns that exist on `navme_navnode` (no created_at / updated_at). */
const NAVNODE_HEAT_SELECT = 'pos_x,pos_y,pos_z,poi_type,user_id,recorded_at';

/**
 * @param {string} filterSuffix
 * @param {{ maxRows?: number, newestFirst?: boolean }} [opts]
 */
async function queryNavnodesOrdered(filterSuffix, opts = {}) {
  const maxRows = Math.max(200, Math.min(8000, Number(opts.maxRows) || 4000));
  const newestFirst = Boolean(opts.newestFirst);
  const pageSize = Math.min(1000, maxRows);
  const dir = newestFirst ? 'desc' : 'asc';

  // Prefer ordered by recorded_at; fall back to unordered if that column is missing.
  for (const tcol of NAVNODE_TIME_COL) {
    try {
      const all = [];
      let offset = 0;
      while (all.length < maxRows) {
        const take = Math.min(pageSize, maxRows - all.length);
        const rows = await query(
          `navme_navnode?select=${NAVNODE_HEAT_SELECT}${filterSuffix}&order=${tcol}.${dir}&limit=${take}&offset=${offset}`,
        );
        const batch = Array.isArray(rows) ? rows : [];
        all.push(...filterNavnodesForSession(batch.map(normalizeNavnodeRow)));
        if (batch.length < take) break;
        offset += take;
      }
      if (newestFirst) all.reverse();
      return all;
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
    }
  }

  const rows = await query(
    `navme_navnode?select=${NAVNODE_HEAT_SELECT}${filterSuffix}&limit=${maxRows}`,
  );
  return filterNavnodesForSession((Array.isArray(rows) ? rows : []).map(normalizeNavnodeRow));
}

/**
 * Combined navnodes for Display → Heat map (session poi_type only).
 * @param {{ userIds?: string[] | null }} [opts]
 *   When `userIds` is a non-empty array, only those users' points are returned.
 *   When omitted / null, all project navnodes are returned.
 */
export async function fetchNavnodesForHeatmap(opts = {}) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('Sign in with a project (poi_type) before loading the heat map.');
  }

  const userIds = Array.isArray(opts.userIds)
    ? [...new Set(opts.userIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
    : null;

  if (userIds && !userIds.length) return [];

  let filter = navnodeFilterParams();
  if (userIds) {
    const idList = userIds.map((id) => encodeURIComponent(id)).join(',');
    filter += `&user_id=in.(${idList})`;
  }

  return queryNavnodesOrdered(filter, { maxRows: 5000, newestFirst: true });
}

// ——— Users (`navme_users`) ———

export async function fetchUsersForProject() {
  const poiType = getPoiType();
  if (!poiType) return [];

  const userIds = await fetchUserIdsForPoiType(poiType);
  if (!userIds.length) return [];

  const idList = userIds.map((id) => encodeURIComponent(id)).join(',');
  return query(`navme_users?select=*&id=in.(${idList})&order=user_name.asc`);
}

/**
 * Navnode trail for one user in the active project.
 * @param {string} userId
 */
export async function fetchNavnodesForUser(userId) {
  const cleanId = String(userId ?? '').trim();
  if (!cleanId) return [];

  const poiType = getPoiType();
  if (!poiType) return [];

  return queryNavnodesOrdered(
    `${navnodeFilterParams()}&user_id=eq.${encodeURIComponent(cleanId)}`,
    { maxRows: 2500, newestFirst: true },
  );
}

/**
 * Latest navnode for a user (live position).
 * @param {string} userId
 */
export async function fetchLatestNavnodeForUser(userId) {
  const rows = await fetchNavnodesForUser(userId);
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

// ——— Blocks (`navme_blocks`) ———

function blocksFilterParams() {
  const filter = poiTypeFilterParam();
  return filter ? `&${filter}` : '';
}

function newZoneId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `zone-${crypto.randomUUID()}`;
  }
  return `zone-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function fetchAllBlocks() {
  const poiType = getPoiType();
  if (!poiType) {
    return Promise.resolve([]);
  }
  const qs = `?select=*${blocksFilterParams()}&order=zone_name.asc`;
  return query(withOwnershipQuery(`navme_blocks${qs}`));
}

export function insertBlockRow(body) {
  const poiType = getPoiType();
  if (!poiType) {
    throw new Error('POI session is missing category context.');
  }
  const zoneId = String(body.zone_id ?? newZoneId()).trim();
  const zoneName = String(body.zone_name ?? body.label ?? 'New block').trim() || 'New block';
  return mutate(
    'POST',
    'navme_blocks',
    withOwnershipInsert({
      organization_id: getDefaultOrganizationId(),
      zone_id: zoneId,
      zone_name: zoneName,
      label: body.label ?? zoneName,
      zone_type: body.zone_type ?? 'zone',
      poi_type: poiType,
      pos_x: Number(body.pos_x ?? 0),
      pos_y: Number(body.pos_y ?? 0),
      pos_z: Number(body.pos_z ?? 0),
      width: Math.max(Number(body.width ?? 1), 0.1),
      depth: Math.max(Number(body.depth ?? 1), 0.1),
      is_blocked: body.is_blocked ?? false,
      is_active: body.is_active ?? true,
      floor_name: body.floor_name ?? null,
      notes: body.notes ?? null,
    }),
  );
}

export function updateBlockRow(id, data) {
  const poiType = getPoiType();
  const filter = poiType
    ? `?id=eq.${id}&poi_type=ilike.${encodeURIComponent(poiType)}`
    : `?id=eq.${id}`;
  return mutate('PATCH', `navme_blocks${filter}`, {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export function deleteBlockRow(id) {
  const poiType = getPoiType();
  const filter = poiType
    ? `?id=eq.${id}&poi_type=ilike.${encodeURIComponent(poiType)}`
    : `?id=eq.${id}`;
  return mutate('DELETE', `navme_blocks${filter}`);
}

// ——— Access control (`navme_logins` + `navme_project_features`) ———

export const PROJECT_FEATURE_FIELDS = [
  { key: 'people_search', label: 'People search' },
  { key: 'save_location', label: 'Save location' },
  { key: 'block_enabled', label: 'Block / zones' },
  { key: 'mini3d_gta_embed', label: 'Mini 3D embed' },
  { key: 'languages', label: 'Languages' },
  { key: 'custom_media', label: 'Media' },
  { key: 'assistant', label: 'Assistant' },
  { key: 'snapshot', label: 'Snapshot' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'fps_display', label: 'FPS display' },
  { key: 'localization_display', label: 'Localization display' },
  { key: 'navme_robo_companion', label: 'NavMe Robo Companion' },
  { key: 'facilities', label: 'Amenities' },
  { key: 'treasure', label: 'Treasure hunt' },
  { key: 'guided_tours', label: 'Guided Tours' },
];

/** All project logins except the superadmin row. */
export async function fetchProjectLogins() {
  const rows = await query('navme_logins?select=*&order=poi_type.asc');
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => String(row.email ?? '').trim().toLowerCase() !== 'superadmin@navme.space',
  );
}

export async function fetchAllProjectFeatures() {
  return query('navme_project_features?select=*&order=poi_type.asc');
}

/** Feature flags row for one project (`poi_type`). */
export async function fetchProjectFeaturesByPoiType(poiType) {
  const poi = String(poiType ?? '').trim();
  if (!poi) return null;
  const rows = await query(
    `navme_project_features?select=*&poi_type=ilike.${encodeURIComponent(poi)}&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function fetchTenantLanguages(poiType) {
  const poi = encodeURIComponent(String(poiType ?? '').trim());
  return query(`navme_tenant_languages?select=*&poi_type=eq.${poi}&order=sort_order.asc`);
}

export async function initTenantLanguagesAdmin({ email, password, poiType }) {
  const rows = await callRpc('admin_init_tenant_languages', {
    p_email: email,
    p_password: password,
    p_poi_type: poiType,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function upsertTenantLanguageAdmin({ email, password, poiType, langCode, isEnabled }) {
  const row = await callRpc('admin_upsert_tenant_language', {
    p_email: email,
    p_password: password,
    p_poi_type: poiType,
    p_lang_code: langCode,
    p_is_enabled: Boolean(isEnabled),
  });
  return Array.isArray(row) ? row[0] : row;
}

export async function insertProjectLogin(body) {
  const email = String(body.email ?? '').trim();
  const poiType = String(body.poi_type ?? '').trim();
  if (!email) throw new Error('Tenant login email is required');
  if (!poiType) throw new Error('Project name (poi_type) is required');

  const emailClash = await findProjectLoginEmailConflict(email);
  if (emailClash) {
    throw new Error(formatLoginEmailConflictError(email, emailClash));
  }

  try {
    return await mutate('POST', 'navme_logins', {
      email,
      password: String(body.password ?? ''),
      poi_type: poiType,
      map_code: String(body.map_code ?? '').trim(),
      client_id: String(body.client_id ?? '').trim(),
      client_secret: String(body.client_secret ?? '').trim(),
    });
  } catch (err) {
    throw remapLoginMutationError(err, email);
  }
}

/**
 * Case-insensitive email lookup used to avoid UNIQUE(email) 409s on save.
 * @param {string} email
 * @param {{ excludeId?: string | null }} [opts]
 */
export async function findProjectLoginEmailConflict(email, opts = {}) {
  const clean = String(email ?? '').trim();
  if (!clean) return null;
  // Quote so `@` and dots are not treated as PostgREST filter syntax.
  const quoted = `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  let rows = [];
  try {
    rows = await query(
      `navme_logins?select=id,email,poi_type&email=ilike.${encodeURIComponent(quoted)}`,
    );
  } catch {
    rows = await query('navme_logins?select=id,email,poi_type');
  }
  const list = Array.isArray(rows) ? rows : [];
  const excludeId = opts.excludeId != null ? String(opts.excludeId) : null;
  const needle = clean.toLowerCase();
  return (
    list.find((row) => {
      if (excludeId && String(row.id) === excludeId) return false;
      return String(row.email ?? '').trim().toLowerCase() === needle;
    }) || null
  );
}

function formatLoginEmailConflictError(email, clash) {
  const project = String(clash?.poi_type ?? '').trim() || 'another project';
  return `Email "${email}" is already used by "${project}". Choose a different tenant login email.`;
}

function remapLoginMutationError(err, email) {
  const msg = String(err?.message ?? err ?? '');
  if (
    msg.includes('23505') ||
    msg.includes('409') ||
    /duplicate key|unique constraint|navme_logins_email_key/i.test(msg)
  ) {
    return new Error(
      `Email "${email}" is already taken by another tenant. Choose a different login email.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export async function updateProjectLogin(id, data) {
  const loginId = String(id ?? '').trim();
  if (!loginId) throw new Error('Missing tenant login id');

  const existingRows = await query(`navme_logins?select=*&id=eq.${encodeURIComponent(loginId)}&limit=1`);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (!existing) throw new Error('Tenant login not found');

  const patch = {};
  /** @type {string | null} */
  let warning = null;

  if (data.email != null) {
    const email = String(data.email).trim();
    if (!email) throw new Error('Tenant login email is required');
    const existingEmail = String(existing.email ?? '').trim();
    if (email.toLowerCase() !== existingEmail.toLowerCase()) {
      const clash = await findProjectLoginEmailConflict(email, { excludeId: loginId });
      if (clash) {
        // Don't block map/password/secret updates — keep the current email.
        warning = `${formatLoginEmailConflictError(email, clash)} Other fields were saved; email left as "${existingEmail}".`;
      } else {
        patch.email = email;
      }
    } else if (email !== existingEmail) {
      // Same address, different casing — still unique-safe on this row.
      patch.email = email;
    }
  }
  if (data.password != null && String(data.password).length) {
    const nextPassword = String(data.password);
    if (nextPassword !== String(existing.password ?? '')) patch.password = nextPassword;
  }
  if (data.poi_type != null) {
    const poiType = String(data.poi_type).trim();
    if (poiType && poiType !== String(existing.poi_type ?? '').trim()) patch.poi_type = poiType;
  }
  if (data.map_code != null) {
    const mapCode = String(data.map_code).trim();
    if (mapCode !== String(existing.map_code ?? '').trim()) patch.map_code = mapCode;
  }
  if (data.client_id != null) {
    const clientId = String(data.client_id).trim();
    if (clientId !== String(existing.client_id ?? '').trim()) patch.client_id = clientId;
  }
  if (data.client_secret != null && String(data.client_secret).length) {
    const clientSecret = String(data.client_secret).trim();
    if (clientSecret !== String(existing.client_secret ?? '').trim()) {
      patch.client_secret = clientSecret;
    }
  }

  if (!Object.keys(patch).length) {
    if (warning) throw new Error(warning);
    return [existing];
  }

  try {
    const rows = await mutate('PATCH', `navme_logins?id=eq.${encodeURIComponent(loginId)}`, patch);
    if (warning) {
      const err = new Error(warning);
      err.name = 'LoginEmailKeptError';
      err.saved = true;
      err.rows = rows;
      throw err;
    }
    return rows;
  } catch (err) {
    if (err?.name === 'LoginEmailKeptError') throw err;
    // Last resort: if email in patch still 409s, retry without email.
    const msg = String(err?.message ?? err ?? '');
    if (patch.email && (msg.includes('409') || msg.includes('23505') || /duplicate key|unique constraint/i.test(msg))) {
      const { email: _drop, ...rest } = patch;
      if (Object.keys(rest).length) {
        const rows = await mutate('PATCH', `navme_logins?id=eq.${encodeURIComponent(loginId)}`, rest);
        const kept = new Error(
          `Email "${patch.email}" is already taken. Other fields were saved; email left as "${existing.email}".`,
        );
        kept.name = 'LoginEmailKeptError';
        kept.saved = true;
        kept.rows = rows;
        throw kept;
      }
    }
    throw remapLoginMutationError(err, patch.email || existing.email);
  }
}

export async function deleteProjectLogin(id) {
  return mutate('DELETE', `navme_logins?id=eq.${id}`);
}

/**
 * @param {{ email: string, password: string, poiType: string, loginId?: string | null, features: Record<string, boolean> }} opts
 */
export async function upsertProjectFeaturesAdmin(opts) {
  const features = opts.features ?? {};
  const row = await callRpc('admin_upsert_project_features', {
    p_email: opts.email,
    p_password: opts.password,
    p_poi_type: opts.poiType,
    p_login_id: opts.loginId ?? null,
    p_people_search: Boolean(features.people_search),
    p_save_location: Boolean(features.save_location),
    p_block_enabled: Boolean(features.block_enabled),
    p_mini3d_gta_embed: Boolean(features.mini3d_gta_embed),
    p_custom_media: Boolean(features.custom_media),
    p_assistant: Boolean(features.assistant),
    p_snapshot: Boolean(features.snapshot),
    p_whatsapp: Boolean(features.whatsapp),
    p_feedback: Boolean(features.feedback),
    p_languages: Boolean(features.languages),
    p_fps_display: Boolean(features.fps_display),
    p_localization_display: Boolean(features.localization_display),
    p_navme_robo_companion: Boolean(features.navme_robo_companion),
    p_facilities: Boolean(features.facilities),
    p_treasure: Boolean(features.treasure),
    p_guided_tours: Boolean(features.guided_tours),
    p_matterport_navigation: Boolean(features.matterport_navigation),
    p_navme_gmap_enabled: Boolean(features.navme_gmap_enabled),
    // Omitted (null) means "leave as is" — only send it when the caller chose.
    p_companion_model: features.companion_model ?? null,
    p_walkthrough_mode: features.walkthrough_mode ?? null,
  });
  return Array.isArray(row) ? row[0] : row;
}

export async function adminGmapUpsertBuilding({ email, password, poiType, accountEmail, slug, matterportSid = null, wayfindingAdminUrl = null }) {
  const row = await callRpc('admin_gmap_upsert_building', {
    p_email: email,
    p_password: password,
    p_poi_type: poiType,
    p_account_email: accountEmail,
    p_slug: slug,
    p_matterport_sid: matterportSid,
    p_wayfinding_admin_url: wayfindingAdminUrl,
  });
  return Array.isArray(row) ? row[0] : row;
}

export async function adminGmapSyncPois(poiType) {
  const row = await callRpc('sync_navme_pois_to_gmap', { p_poi_type: poiType });
  return Array.isArray(row) ? row[0] : row;
}

export async function adminGmapGetBuilding({ email, password, poiType }) {
  const row = await callRpc('admin_gmap_get_building', {
    p_email: email,
    p_password: password,
    p_poi_type: poiType,
  });
  return Array.isArray(row) ? row[0] : row;
}

export async function fetchLoginMapCode(poiType) {
  const poi = String(poiType ?? '').trim();
  if (!poi) return null;
  const rows = await query(`navme_logins?select=map_code,email&poi_type=ilike.${encodeURIComponent(poi)}&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? { mapCode: row.map_code?.trim() || null, email: row.email?.trim() || null } : null;
}

// Returns the active Matterport model SID for a project from navme_media
// (the same one added in the superadmin "3D Space" section of the access page)
export async function fetchMatterportSidForProject(poiType) {
  const poi = String(poiType ?? '').trim();
  if (!poi) return null;
  // Space rows are stored either as media_type=matterport, or as model + the
  // matterport mime marker (DBs without the check-constraint migration).
  const mime = encodeURIComponent('application/vnd.matterport.space');
  const rows = await query(
    `navme_media?select=media_url,file_name,media_type,mime_type` +
    `&poi_type=ilike.${encodeURIComponent(poi)}&is_active=eq.true` +
    `&or=(media_type.eq.matterport,mime_type.eq.${mime})&limit=1`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  // file_name holds the bare model SID; fall back to parsing the showcase URL.
  return parseMatterportModelId(row.file_name) || parseMatterportModelId(row.media_url) || null;
}

export async function upsertProjectExperienceUrlsAdmin(opts) {
  const row = await callRpc('admin_upsert_project_experience_urls', {
    p_email: opts.email,
    p_password: opts.password,
    p_poi_type: opts.poiType,
    p_project_url: opts.projectUrl ?? '',
    p_whitelabeled_url: opts.whitelabeledUrl ?? '',
  });
  return Array.isArray(row) ? row[0] : row;
}

export async function projectListApiCredentials({ email, password, poiType = null }) {
  const rows = await callRpc('project_list_api_credentials', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_poi_type: poiType != null ? String(poiType).trim() : null,
  });
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
}

export async function projectCreateApiCredential({
  email,
  password,
  name,
  poiType = null,
  scopeQuery = true,
  scopeWrite = true,
  scopeDelete = false,
}) {
  const rows = await callRpc('project_create_api_credential', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_name: String(name ?? '').trim(),
    p_poi_type: poiType != null ? String(poiType).trim() : null,
    p_scope_query: Boolean(scopeQuery),
    p_scope_write: Boolean(scopeWrite),
    p_scope_delete: Boolean(scopeDelete),
  });
  return Array.isArray(rows) ? rows[0] ?? rows : rows;
}

export async function projectDeleteApiCredential({ email, password, credentialId, poiType = null }) {
  return callRpc('project_delete_api_credential', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_credential_id: credentialId,
    p_poi_type: poiType != null ? String(poiType).trim() : null,
  });
}

export async function projectGetApiCredential({ email, password, credentialId, poiType = null }) {
  const rows = await callRpc('project_get_api_credential', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_credential_id: credentialId,
    p_poi_type: poiType != null ? String(poiType).trim() : null,
  });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

export async function projectExportApiCredential({ email, password, credentialId, poiType = null }) {
  const rows = await callRpc('project_export_api_credential', {
    p_email: String(email ?? '').trim(),
    p_password: String(password ?? ''),
    p_credential_id: credentialId,
    p_poi_type: poiType != null ? String(poiType).trim() : null,
  });
  return Array.isArray(rows) ? rows[0] ?? rows : rows;
}

export async function resolveProjectApiCredential(publicId) {
  const rows = await callRpc('resolve_project_api_credential', {
    p_public_id: String(publicId ?? '').trim().toLowerCase(),
  });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

export async function deleteProjectFeaturesAdmin({ email, password, poiType }) {
  await callRpc('admin_delete_project_features', {
    p_email: email,
    p_password: password,
    p_poi_type: poiType,
  });
}

/**
 * @param {Record<string, unknown>} body
 */
export async function insertUserLogRow(body) {
  return mutate('POST', 'navme_user_logs', body);
}

/**
 * @param {{ poiType?: string | null, limit?: number, actorAccountId?: string | null, actorEmail?: string | null }} [opts]
 */
export async function fetchUserLogRows({
  poiType = null,
  limit = 400,
  actorAccountId = null,
  actorEmail = null,
} = {}) {
  const cap = Math.min(Math.max(Number(limit) || 400, 1), 1000);
  let path = `navme_user_logs?select=*&order=created_at.desc&limit=${cap}`;
  const pt = String(poiType ?? '').trim();
  if (pt) path += `&poi_type=eq.${encodeURIComponent(pt)}`;
  const actorId = String(actorAccountId ?? '').trim();
  if (actorId) {
    path += `&actor_account_id=eq.${encodeURIComponent(actorId)}`;
  } else {
    const email = String(actorEmail ?? '').trim();
    if (email) path += `&actor_email=eq.${encodeURIComponent(email)}`;
  }
  const rows = await query(path);
  return Array.isArray(rows) ? rows : [];
}
