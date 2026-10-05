/**
 * Dashboard activity log — write after successful mutations, read for User logs UI.
 */

import { getAuthSession, isProjectAdminSession, isSubAdminSession } from '../config/auth-session.js';
import { getPoiType } from '../config/poi-session.js';
import { getSuperadminSession, hasSuperadminSession } from '../config/superadmin.js';
import { fetchUserLogRows, insertUserLogRow, isSupabaseConfigured } from './supabase.js';

/** @typedef {'created'|'updated'|'moved'|'scaled'|'deleted'|'assigned'|'enabled'|'disabled'} UserLogAction */
/** @typedef {'poi'|'media'|'facility'|'block'|'stairs'|'treasure'|'sub_admin'|'project_admin'|'tenant'|'editor'} UserLogEntityType */

const ACCOUNT_ENTITY_TYPES = new Set(['sub_admin', 'project_admin', 'tenant', 'editor']);

/** @type {Set<UserLogAction>} */
const LOG_ACTIONS = new Set([
  'created',
  'updated',
  'moved',
  'scaled',
  'deleted',
  'assigned',
  'enabled',
  'disabled',
]);

/** @type {Set<UserLogEntityType>} */
const LOG_ENTITY_TYPES = new Set([
  'poi',
  'media',
  'facility',
  'block',
  'stairs',
  'treasure',
  'sub_admin',
  'project_admin',
  'tenant',
  'editor',
]);

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const debounceTimers = new Map();
/** @type {Map<string, { x: number, y: number, z: number }>} */
const lastXyz = new Map();
/** @type {Map<string, { x: number, y: number, z: number }>} */
const lastScale = new Map();
/** @type {Map<string, object>} */
const pendingBurst = new Map();

/**
 * @param {unknown} record
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function xyzOf(record) {
  if (!record || typeof record !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (record);
  if (row.pos_x != null || row.pos_y != null || row.pos_z != null) {
    return { x: Number(row.pos_x) || 0, y: Number(row.pos_y) || 0, z: Number(row.pos_z) || 0 };
  }
  if (row.dest_x != null || row.dest_y != null || row.dest_z != null) {
    return { x: Number(row.dest_x) || 0, y: Number(row.dest_y) || 0, z: Number(row.dest_z) || 0 };
  }
  if (row.hint_x != null || row.hint_y != null || row.hint_z != null) {
    return { x: Number(row.hint_x) || 0, y: Number(row.hint_y) || 0, z: Number(row.hint_z) || 0 };
  }
  if (row.x != null || row.y != null || row.z != null) {
    return { x: Number(row.x) || 0, y: Number(row.y) || 0, z: Number(row.z) || 0 };
  }
  return null;
}

/**
 * @param {unknown} record
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function scaleOf(record) {
  if (!record || typeof record !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (record);
  if (row.scale_x != null || row.scale_y != null || row.scale_z != null) {
    return {
      x: Number(row.scale_x) || 0,
      y: Number(row.scale_y) || 0,
      z: Number(row.scale_z) || 0,
    };
  }
  if (row.scale != null) {
    const s = Number(row.scale) || 0;
    return { x: s, y: s, z: s };
  }
  if (row.x != null || row.y != null || row.z != null) {
    return { x: Number(row.x) || 0, y: Number(row.y) || 0, z: Number(row.z) || 0 };
  }
  return null;
}

/**
 * @param {{ x?: number, y?: number, z?: number } | null | undefined} pos
 */
export function formatXyz(pos) {
  if (!pos) return '';
  const n = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(3) : '—';
  };
  return `(${n(pos.x)}, ${n(pos.y)}, ${n(pos.z)})`;
}

function transformKey(entityType, entityId) {
  return `${entityType}:${entityId ?? ''}`;
}

/**
 * Seed last-known XYZ so the next move can show a from-position.
 * @param {UserLogEntityType} entityType
 * @param {string | number | null | undefined} entityId
 * @param {unknown} record
 */
export function rememberEntityXyz(entityType, entityId, record) {
  const pos = xyzOf(record);
  if (entityId == null || !pos) return;
  lastXyz.set(transformKey(entityType, entityId), pos);
  const scale = scaleOf(record);
  if (scale) lastScale.set(transformKey(entityType, entityId), scale);
}

/**
 * @param {UserLogEntityType} entityType
 * @param {Array<Record<string, unknown>>} rows
 */
export function rememberEntitiesXyz(entityType, rows) {
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    rememberEntityXyz(entityType, row?.id, row);
  });
}

export function canViewUserLogs() {
  if (isSubAdminSession()) return false;
  return isProjectAdminSession() || hasSuperadminSession() || getAuthSession()?.role === 'superadmin';
}

/** Profile → User logs: project admin / superadmin / sub-admin (own rows only). */
export function canViewProfileActivity() {
  if (isSubAdminSession()) return true;
  return canViewUserLogs();
}

/**
 * @returns {{ email: string, role: string, accountId: string | null, poiType: string | null } | null}
 */
function getActor() {
  const session = getAuthSession();
  if (session?.email && session?.role) {
    return {
      email: session.email,
      role: session.role,
      accountId: session.accountId ? String(session.accountId) : null,
      poiType: session.poiType || getPoiType() || null,
    };
  }
  const sa = getSuperadminSession();
  if (sa?.email) {
    return {
      email: String(sa.email),
      role: 'superadmin',
      accountId: null,
      poiType: getPoiType() || null,
    };
  }
  return null;
}

/**
 * @param {UserLogAction} action
 */
function actionVerb(action) {
  switch (action) {
    case 'created':
      return 'created';
    case 'updated':
      return 'updated';
    case 'moved':
      return 'moved';
    case 'scaled':
      return 'scaled';
    case 'deleted':
      return 'deleted';
    case 'assigned':
      return 'assigned';
    case 'enabled':
      return 'enabled';
    case 'disabled':
      return 'disabled';
    default: {
      const _never = /** @type {never} */ (action);
      return String(_never);
    }
  }
}

/**
 * @param {UserLogEntityType} entityType
 */
function entityKindLabel(entityType) {
  switch (entityType) {
    case 'poi':
      return 'POI';
    case 'media':
      return 'media';
    case 'facility':
      return 'amenity';
    case 'block':
      return 'zone';
    case 'stairs':
      return 'stairs';
    case 'treasure':
      return 'treasure';
    case 'sub_admin':
      return 'sub-admin';
    case 'project_admin':
      return 'project admin';
    case 'tenant':
      return 'tenant';
    case 'editor':
      return 'editor';
    default: {
      const _never = /** @type {never} */ (entityType);
      return String(_never);
    }
  }
}

/**
 * @param {{
 *   actorEmail: string,
 *   action: UserLogAction,
 *   entityType: UserLogEntityType,
 *   entityLabel?: string | null,
 * }} opts
 */
export function buildLogSummary({ actorEmail, action, entityType, entityLabel }) {
  const quoted = entityLabel ? ` “${String(entityLabel).trim()}”` : '';
  return `${actorEmail} ${actionVerb(action)} ${entityKindLabel(entityType)}${quoted}`;
}

/**
 * Fire-and-forget activity row. Never throws to callers.
 * Move/scale events for the same entity are coalesced (~1.5s).
 *
 * @param {{
 *   action: UserLogAction,
 *   entityType: UserLogEntityType,
 *   entityId?: string | number | null,
 *   entityLabel?: string | null,
 *   poiType?: string | null,
 *   createdEmail?: string | null,
 *   xyz?: unknown,
 *   scale?: unknown,
 *   details?: Record<string, unknown> | null,
 * }} opts
 */
export function logUserActivity(opts) {
  const action = opts?.action;
  const entityType = opts?.entityType;
  if (!LOG_ACTIONS.has(action) || !LOG_ENTITY_TYPES.has(entityType)) return;

  const key = `${entityType}:${opts.entityId ?? ''}:${action}`;
  const posKey = transformKey(entityType, opts.entityId);
  const to = xyzOf(opts.xyz) ?? xyzOf(opts.details?.to) ?? null;
  const toScale = scaleOf(opts.scale) ?? scaleOf(opts.details?.toScale) ?? null;
  const prevBurst = pendingBurst.get(key);
  const prevDetails =
    prevBurst && typeof prevBurst === 'object'
      ? /** @type {Record<string, unknown>} */ (prevBurst).details
      : null;
  const prevFrom = prevDetails && typeof prevDetails === 'object' ? prevDetails.from : null;
  const prevFromScale = prevDetails && typeof prevDetails === 'object' ? prevDetails.fromScale : null;
  const from = xyzOf(opts.details?.from) ?? xyzOf(prevFrom) ?? lastXyz.get(posKey) ?? null;
  const fromScale =
    scaleOf(opts.details?.fromScale) ?? scaleOf(prevFromScale) ?? lastScale.get(posKey) ?? null;

  /** @type {Record<string, unknown>} */
  const details = {
    ...(opts.details && typeof opts.details === 'object' ? opts.details : {}),
  };
  if (action === 'moved') {
    if (from) details.from = from;
    if (to) details.to = to;
    delete details.fromScale;
    delete details.toScale;
  } else if (action === 'scaled') {
    if (fromScale) details.fromScale = fromScale;
    if (toScale) details.toScale = toScale;
    delete details.from;
    delete details.to;
  } else {
    delete details.from;
    delete details.to;
    delete details.fromScale;
    delete details.toScale;
  }

  const merged = {
    ...opts,
    details,
  };

  if (action === 'moved' || action === 'scaled') {
    pendingBurst.set(key, merged);
    const prev = debounceTimers.get(key);
    if (prev) clearTimeout(prev);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        const latest = pendingBurst.get(key) ?? merged;
        pendingBurst.delete(key);
        void writeLog(latest);
      }, 1500),
    );
    return;
  }
  void writeLog(merged);
}

/**
 * @param {Parameters<typeof logUserActivity>[0]} opts
 */
async function writeLog(opts) {
  if (!isSupabaseConfigured()) return;
  const actor = getActor();
  if (!actor) return;

  const poiType = String(opts.poiType ?? actor.poiType ?? getPoiType() ?? '').trim() || null;
  const entityLabel = opts.entityLabel != null ? String(opts.entityLabel).trim() : '';
  const summary = buildLogSummary({
    actorEmail: actor.email,
    action: opts.action,
    entityType: opts.entityType,
    entityLabel,
  });
  if (opts.entityId != null) {
    const to = xyzOf(opts.details?.to) ?? xyzOf(opts.xyz);
    if (to) lastXyz.set(transformKey(opts.entityType, opts.entityId), to);
    const toScale = scaleOf(opts.details?.toScale) ?? scaleOf(opts.scale) ?? scaleOf(opts.xyz);
    if (toScale) lastScale.set(transformKey(opts.entityType, opts.entityId), toScale);
  }

  try {
    await insertUserLogRow({
      poi_type: poiType,
      actor_email: actor.email,
      actor_role: actor.role,
      actor_account_id: actor.accountId,
      action: opts.action,
      entity_type: opts.entityType,
      entity_id: opts.entityId != null ? String(opts.entityId) : null,
      entity_label: entityLabel || null,
      created_email: opts.createdEmail != null ? String(opts.createdEmail).trim() || null : null,
      summary,
      details: opts.details ?? null,
    });
  } catch (err) {
    console.warn('[user-logs] insert failed:', err);
  }
}

/**
 * @param {{ poiType?: string | null, global?: boolean, limit?: number }} [opts]
 */
export async function fetchVisibleUserLogs({ poiType = null, global = false, limit = 400 } = {}) {
  if (!canViewProfileActivity()) return [];

  const session = getAuthSession();
  const isSuper = hasSuperadminSession() || session?.role === 'superadmin';
  const scopePoi = String(poiType || getPoiType() || '').trim() || null;
  const isSub = isSubAdminSession();

  if (isSub) {
    if (!scopePoi) return [];
    const accountId = session?.accountId ? String(session.accountId) : null;
    const email = session?.email ? String(session.email) : null;
    const rows = await fetchUserLogRows({
      poiType: scopePoi,
      limit,
      actorAccountId: accountId,
      actorEmail: accountId ? null : email,
    });
    // Defense-in-depth: never show other actors to sub-admins.
    return rows.filter((row) => {
      if (accountId && String(row.actor_account_id ?? '') === accountId) return true;
      if (!accountId && email && String(row.actor_email ?? '').toLowerCase() === email.toLowerCase()) {
        return true;
      }
      return false;
    });
  }

  if (!isSuper) {
    if (!scopePoi) return [];
    const rows = await fetchUserLogRows({ poiType: scopePoi, limit });
    return rows.filter((row) => {
      const type = String(row.entity_type ?? '');
      if (ACCOUNT_ENTITY_TYPES.has(type) && String(row.actor_role ?? '') === 'superadmin') {
        return false;
      }
      return true;
    });
  }

  const rows = await fetchUserLogRows({
    poiType: global ? null : scopePoi,
    limit,
  });
  return rows;
}
