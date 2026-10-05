/**
 * Parse fetch Response body as JSON without throwing on empty bodies.
 * @param {Response} res
 * @param {string} [context] for error messages
 * @returns {Promise<any>} Parsed value, or null if body is empty
 */
export async function parseJsonResponse(res, context = 'API') {
  const text = await res.text();
  if (!text?.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${context}: response was not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`
    );
  }
}
