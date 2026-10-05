/**
 * Persist project (tenant) login across page refreshes until explicit logout.
 * Stored in localStorage — cleared only by clearProjectSession().
 */
const STORAGE_KEY = 'navme_project_session';

/**
 * @param {{ email: string, password: string }} payload
 */
export function saveProjectSession(payload) {
  const email = String(payload?.email ?? '').trim();
  const password = String(payload?.password ?? '');
  if (!email || !password) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        email,
        password,
        at: Date.now(),
      }),
    );
  } catch (err) {
    console.warn('[session] could not save project session:', err);
  }
}

/**
 * @returns {{ email: string, password: string } | null}
 */
export function getProjectSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const email = String(parsed?.email ?? '').trim();
    const password = String(parsed?.password ?? '');
    if (!email || !password) return null;
    return { email, password };
  } catch {
    return null;
  }
}

export function clearProjectSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
