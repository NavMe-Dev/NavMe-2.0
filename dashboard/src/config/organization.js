/**
 * Single shared organization for all NavMe projects.
 * Override with VITE_DEFAULT_ORGANIZATION_ID in `.env` / Render env if needed.
 */
const DEFAULT_ORGANIZATION_ID =
  String(import.meta.env.VITE_DEFAULT_ORGANIZATION_ID ?? '').trim() ||
  'db204331-02bd-4fa4-9c5d-569ea1d9329f';

export function getDefaultOrganizationId() {
  return DEFAULT_ORGANIZATION_ID;
}
