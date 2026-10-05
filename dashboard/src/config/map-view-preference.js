/**
 * Superadmin can open a project in MultiSet geometric mesh mode
 * even when a Matterport / splat map is configured.
 * Stored in sessionStorage for the editor session.
 */
const KEY = 'navme_force_geometric_mesh';

export function setForceGeometricMesh(enabled) {
  try {
    if (enabled) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function getForceGeometricMesh() {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearForceGeometricMesh() {
  setForceGeometricMesh(false);
}
