/**
 * Hand off a project session from superadmin (/access) to the 3D editor (/).
 * Stored in sessionStorage and consumed once on editor boot.
 */
const SESSION_KEY = 'navme_pending_project_login';
const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * @param {{
 *   email: string,
 *   password: string,
 *   poiType: string,
 *   mapCode: string,
 *   organizationId?: string | null,
 *   forceGeometricMesh?: boolean,
 * }} payload
 */
export function setPendingProjectLogin(payload) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      email: String(payload.email ?? '').trim(),
      password: String(payload.password ?? ''),
      poiType: String(payload.poiType ?? '').trim(),
      mapCode: String(payload.mapCode ?? '').trim(),
      organizationId: payload.organizationId ?? null,
      forceGeometricMesh: Boolean(payload.forceGeometricMesh),
      at: Date.now(),
    }),
  );
}

/**
 * @returns {{
 *   email: string,
 *   password: string,
 *   poiType: string,
 *   mapCode: string,
 *   organizationId: string | null,
 *   forceGeometricMesh: boolean,
 * } | null}
 */
export function getPendingProjectLogin() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.email || !parsed?.password || !parsed?.poiType || !parsed?.mapCode) return null;
    if (Date.now() - Number(parsed.at ?? 0) > MAX_AGE_MS) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return {
      email: String(parsed.email),
      password: String(parsed.password),
      poiType: String(parsed.poiType),
      mapCode: String(parsed.mapCode),
      organizationId: parsed.organizationId ?? null,
      forceGeometricMesh: Boolean(parsed.forceGeometricMesh),
    };
  } catch {
    return null;
  }
}

export function clearPendingProjectLogin() {
  sessionStorage.removeItem(SESSION_KEY);
}

/** @deprecated Use getPendingProjectLogin + clearPendingProjectLogin */
export function consumePendingProjectLogin() {
  const pending = getPendingProjectLogin();
  if (pending) clearPendingProjectLogin();
  return pending;
}
