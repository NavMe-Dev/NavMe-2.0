/**
 * Coerce Postgres / PostgREST boolean values (true, "true", "false", "f", etc.).
 * @param {unknown} value
 * @param {boolean} [defaultValue=false]
 * @returns {boolean}
 */
export function parseDbBool(value, defaultValue = false) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 't' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === 'f' || v === '0' || v === 'no' || v === '') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
}
