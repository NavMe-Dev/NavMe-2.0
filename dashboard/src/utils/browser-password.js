/**
 * Ask the browser password manager to store credentials (Chrome Credential Management API).
 * Falls back silently when unsupported; form autocomplete attrs still help elsewhere.
 *
 * @param {string} email
 * @param {string} password
 */
export async function offerBrowserPasswordSave(email, password) {
  const id = String(email ?? '').trim();
  const pwd = String(password ?? '');
  if (!id || !pwd) return;
  try {
    if (typeof window === 'undefined' || !window.PasswordCredential || !navigator.credentials?.store) {
      return;
    }
    const cred = new window.PasswordCredential({
      id,
      password: pwd,
      name: id,
    });
    await navigator.credentials.store(cred);
  } catch {
    // User denied prompt or browser blocked — ignore
  }
}
