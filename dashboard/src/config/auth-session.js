/**
 * Unified NavMe dashboard auth session (account / role / poi_type).
 * Keeps poi-session + project-session in sync for MultiSet / map credentials.
 */

import { setPoiSession, clearPoiSession } from './poi-session.js';
import { saveProjectSession, clearProjectSession } from './project-session.js';
import { getDefaultOrganizationId } from './organization.js';

const STORAGE_KEY = 'navme_auth_session';

/**
 * @typedef {{
 *   accountId: string,
 *   email: string,
 *   password: string,
 *   role: 'superadmin'|'project_admin'|'sub_admin',
 *   poiType: string|null,
 *   mapCode: string|null,
 *   memberId: string|null,
 *   clientId?: string|null,
 *   clientSecret?: string|null,
 * }} AuthSession
 */

/** @type {AuthSession | null} */
let memorySession = null;

/**
 * @param {AuthSession} session
 */
export function setAuthSession(session) {
  const accountId = String(session?.accountId ?? '').trim();
  const email = String(session?.email ?? '').trim();
  const password = String(session?.password ?? '');
  const role = String(session?.role ?? '').trim();
  if (!accountId || !email || !password || !role) return;

  /** @type {AuthSession} */
  const next = {
    accountId,
    email,
    password,
    role: /** @type {AuthSession['role']} */ (role),
    poiType: session.poiType ? String(session.poiType).trim() : null,
    mapCode: session.mapCode ? String(session.mapCode).trim() : null,
    memberId: session.memberId ? String(session.memberId).trim() : null,
    clientId: session.clientId ? String(session.clientId).trim() : null,
    clientSecret: session.clientSecret ? String(session.clientSecret).trim() : null,
  };

  memorySession = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, at: Date.now() }));
  } catch (err) {
    console.warn('[auth-session] could not persist:', err);
  }

  saveProjectSession({ email: next.email, password: next.password });

  if (next.poiType) {
    setPoiSession({
      poiType: next.poiType,
      mapCode: next.mapCode || '',
      organizationId: getDefaultOrganizationId(),
    });
  }
}

/** @returns {AuthSession | null} */
export function getAuthSession() {
  if (memorySession?.accountId) return memorySession;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const accountId = String(parsed?.accountId ?? '').trim();
    const email = String(parsed?.email ?? '').trim();
    const password = String(parsed?.password ?? '');
    const role = String(parsed?.role ?? '').trim();
    if (!accountId || !email || !password || !role) return null;
    memorySession = {
      accountId,
      email,
      password,
      role: /** @type {AuthSession['role']} */ (role),
      poiType: parsed.poiType ? String(parsed.poiType).trim() : null,
      mapCode: parsed.mapCode ? String(parsed.mapCode).trim() : null,
      memberId: parsed.memberId ? String(parsed.memberId).trim() : null,
      clientId: parsed.clientId ? String(parsed.clientId).trim() : null,
      clientSecret: parsed.clientSecret ? String(parsed.clientSecret).trim() : null,
    };
    return memorySession;
  } catch {
    return null;
  }
}

export function clearAuthSession() {
  memorySession = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  clearProjectSession();
  clearPoiSession();
}

export function getAuthAccountId() {
  return getAuthSession()?.accountId ?? '';
}

export function getAuthRole() {
  return getAuthSession()?.role ?? '';
}

export function isProjectAdminSession() {
  return getAuthRole() === 'project_admin';
}

export function isSubAdminSession() {
  return getAuthRole() === 'sub_admin';
}

/**
 * Extra PostgREST filter for sub-admin visibility.
 * Returns '' for project_admin / superadmin; for sub_admin:
 * `&or=(created_by.eq.${id},assigned_to.eq.${id})`
 * Legacy null `created_by` rows are intentionally excluded.
 */
export function ownershipFilterParams() {
  if (!isSubAdminSession()) return '';
  const id = getAuthAccountId();
  if (!id) return '';
  const enc = encodeURIComponent(id);
  return `&or=(created_by.eq.${enc},assigned_to.eq.${enc})`;
}
