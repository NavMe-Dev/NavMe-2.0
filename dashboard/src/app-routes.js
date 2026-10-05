/**
 * Lightweight path routing for Vite SPA (Render rewrites all paths to index.html).
 */

export function getAppRoute() {
  const path = (window.location.pathname || '/').replace(/\/$/, '') || '/';
  if (path === '/media' || path.endsWith('/media') || path === '/ar-media' || path.endsWith('/ar-media')) {
    return 'media-admin';
  }
  if (path === '/access' || path.endsWith('/access')) {
    return 'access-control';
  }
  if (path === '/analytics' || path.endsWith('/analytics')) {
    return 'user-analytics';
  }
  if (path === '/wayfinding' || path.endsWith('/wayfinding')) {
    return 'wayfinding';
  }
  if (/^\/c\/[a-zA-Z0-9_-]+$/.test(path) || /\/c\/[a-zA-Z0-9_-]+$/.test(path)) {
    return 'credential';
  }
  return 'editor';
}

/** @returns {string | null} */
export function getCredentialPublicIdFromPath() {
  const path = (window.location.pathname || '/').replace(/\/$/, '') || '/';
  const match = path.match(/\/c\/([a-zA-Z0-9_-]+)$/);
  return match?.[1] ? String(match[1]).toLowerCase() : null;
}
