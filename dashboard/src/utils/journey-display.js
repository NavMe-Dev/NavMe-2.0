/**
 * Journey labels for dashboard UI - DB timestamps (UTC) shown in Eastern time.
 */

const EASTERN_TIMEZONE = 'America/New_York';

/** @param {string | number | Date | null | undefined} value */
export function formatEasternDateTime(value) {
  if (value == null || value === '') return 'Unknown time';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

/** Top bar date in US Eastern — e.g. "Tue, May 19" */
export function formatEasternDateHeader(value = new Date()) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Live clock in Eastern time - e.g. "3:45:12 PM" */
export function formatEasternClock(value = new Date()) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

/**
 * Display name: `username - Mon, Jan 1, 2026, 3:45:12 PM`
 * @param {Record<string, unknown> | null | undefined} journeyRow — `pj_journeys` row
 * @param {Record<string, unknown>[]} reviewRows — reviews in this journey
 */
export function buildJourneyDisplayLabel(journeyRow, reviewRows = []) {
  const first = reviewRows[0];
  const user =
    journeyRow?.user_name ??
    journeyRow?.user_email ??
    first?.journey_user_name ??
    first?.journey_user_email ??
    first?.user_name ??
    first?.user_email ??
    'Unknown user';
  const ts =
    journeyRow?.started_at ??
    journeyRow?.created_at ??
    journeyRow?.completed_at ??
    first?.created_at ??
    first?.updated_at;
  return `${String(user).trim()} · ${formatEasternDateTime(ts)}`;
}

/** @param {Record<string, unknown>} row */
export function journeyIdFromRow(row) {
  const id = row?.journey_id ?? row?.journeyId ?? row?.route_id ?? row?.routeId;
  return id == null ? '' : String(id);
}
