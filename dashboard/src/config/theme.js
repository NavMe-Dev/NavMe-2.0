/**
 * Light / dark glass theme — persisted preference + system fallback.
 * Inspired by frosted glass UI with dual themes (Awwwards / Henning Tillmann).
 */

const STORAGE_KEY = 'navme-theme';
const THEME_EVENT = 'navme-theme-change';

/** @typedef {'light' | 'dark'} AppTheme */

/** @returns {AppTheme} */
export function getSystemTheme() {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

/** @returns {AppTheme} */
export function getTheme() {
  const current = document.documentElement.dataset.theme;
  return current === 'dark' ? 'dark' : 'light';
}

/** @param {AppTheme} theme */
export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: next } }));
}

/** Resolve saved preference or OS setting and apply to `<html>`. */
export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  const theme = saved === 'dark' || saved === 'light' ? saved : getSystemTheme();
  setTheme(theme);

  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      try {
        if (localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        /* ignore */
      }
      setTheme(e.matches ? 'dark' : 'light');
    });
  }
}

export function toggleTheme() {
  document.documentElement.classList.add('theme-transition');
  setTheme(getTheme() === 'light' ? 'dark' : 'light');
  window.setTimeout(() => {
    document.documentElement.classList.remove('theme-transition');
  }, 450);
}

/** @param {(theme: AppTheme) => void} callback */
export function onThemeChange(callback) {
  callback(getTheme());
  window.addEventListener(THEME_EVENT, (e) => {
    callback(e.detail?.theme === 'dark' ? 'dark' : 'light');
  });
}

/** @param {HTMLElement | null | undefined} button */
export function bindThemeToggle(button) {
  if (!button) return;

  const sync = () => {
    const theme = getTheme();
    button.dataset.theme = theme;
    button.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
    button.title = theme === 'dark' ? 'Light mode' : 'Dark mode';
  };

  button.addEventListener('click', () => toggleTheme());
  window.addEventListener(THEME_EVENT, sync);
  sync();
}
