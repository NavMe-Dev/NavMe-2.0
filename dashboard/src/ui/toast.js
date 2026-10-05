let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'toast-host';
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * @param {string} message
 * @param {'success'|'error'|'info'} [type]
 */
export function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  ensureHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--visible'));
  setTimeout(() => {
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}
