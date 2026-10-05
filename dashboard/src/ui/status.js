/**
 * Status bar pill in the topbar (left of #topbar-stat).
 */

import { t } from '../config/i18n.js';

/** @param {HTMLElement} container */
export function createStatusBar(container) {
  const bar = document.createElement('div');
  bar.className = 'status-bar hidden';
  bar.id = 'status-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<span class="dot loading pulse"></span><span class="text"></span>`;
  container.appendChild(bar);

  const dot = bar.querySelector('.dot');
  const text = bar.querySelector('.text');

  return {
    /** @param {string} msg @param {'loading'|'success'|'error'} type */
    show(msg, type = 'loading') {
      dot.className = `dot ${type}${type === 'loading' ? ' pulse' : ''}`;
      text.textContent = msg;
      bar.classList.remove('hidden');
    },
    hide() {
      bar.classList.add('hidden');
    },
  };
}

/**
 * Confidence badge (bottom of screen).
 */
export function createConfidenceBadge(container) {
  const badge = document.createElement('div');
  badge.className = 'confidence-badge';
  badge.id = 'confidence-badge';
  container.appendChild(badge);

  return {
    /** @param {number} value 0-1 */
    update(value) {
      badge.textContent = t('status.vpsConfidence', { value: (value * 100).toFixed(0) });
      badge.classList.add('visible');
    },
    hide() {
      badge.classList.remove('visible');
    },
  };
}
