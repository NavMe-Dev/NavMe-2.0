export const SUPERADMIN_EMAIL = 'superadmin@navme.space';

const SESSION_KEY = 'navme_superadmin_session';

export function isSuperadminCredentials(email, password) {
  return (
    String(email ?? '')
      .trim()
      .toLowerCase() === SUPERADMIN_EMAIL.toLowerCase() && String(password ?? '') === 'Superadmin'
  );
}

export function setSuperadminSession(email, password) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      email: String(email ?? '').trim(),
      password: String(password ?? ''),
      at: Date.now(),
    }),
  );
}

export function getSuperadminSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.email || !parsed?.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasSuperadminSession() {
  return Boolean(getSuperadminSession());
}

export function clearSuperadminSession() {
  sessionStorage.removeItem(SESSION_KEY);
}
