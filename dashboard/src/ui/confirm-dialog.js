/**
 * In-app confirm dialog (native window.confirm is unreliable in some embeds).
 */

import { iconClose, iconDelete } from './icons.js';
import { t } from '../config/i18n.js';

const CONFIRM_DIALOG_SELECTOR = 'dialog.profile-confirm-dialog';

/**
 * True when the event target is inside an open confirm dialog.
 * Use in outside-click / deselect handlers so Delete does not clear selection first.
 * @param {EventTarget | null | undefined} target
 */
export function isConfirmDialogTarget(target) {
  return target instanceof Element && Boolean(target.closest(CONFIRM_DIALOG_SELECTOR));
}

/** True while a confirm dialog is open. */
export function isConfirmDialogOpen() {
  return Boolean(document.querySelector(`${CONFIRM_DIALOG_SELECTOR}[open]`));
}

/**
 * @param {{
 *   title?: string,
 *   message: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   danger?: boolean,
 * }} opts
 * @returns {Promise<boolean>}
 */
export function askConfirm(opts) {
  const title = String(opts.title || t('confirmDialog.areYouSure'));
  const message = String(opts.message || '');
  const confirmLabel = String(opts.confirmLabel || t('confirmDialog.delete'));
  const cancelLabel = String(opts.cancelLabel || t('confirmDialog.cancel'));
  const danger = opts.danger !== false;

  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'access-dialog profile-dialog profile-confirm-dialog';
    dlg.setAttribute('data-navme-confirm', '1');
    dlg.innerHTML = `
      <form class="access-dialog-card float-glass" data-confirm-form>
        <header class="access-dialog-header">
          <div class="access-dialog-heading">
            <span class="access-dialog-icon" aria-hidden="true">${danger ? iconDelete() : iconClose()}</span>
            <div>
              <h3>${escapeHtml(title)}</h3>
              <p>${escapeHtml(message)}</p>
            </div>
          </div>
          <button type="button" class="access-dialog-close btn-ripple-host" data-confirm-cancel aria-label="${t('confirmDialog.close')}">${iconClose()}</button>
        </header>
        <footer class="access-dialog-actions">
          <button type="button" class="access-action-btn btn-ripple-host" data-confirm-cancel>
            <span>${escapeHtml(cancelLabel)}</span>
          </button>
          <button type="button" class="access-save-btn btn-ripple-host${danger ? ' profile-confirm-danger' : ''}" data-confirm-ok>
            <span>${escapeHtml(confirmLabel)}</span>
          </button>
        </footer>
      </form>
    `;
    document.body.appendChild(dlg);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };

    dlg.querySelectorAll('[data-confirm-cancel]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      });
    });
    dlg.querySelector('[data-confirm-ok]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    });
    dlg.querySelector('[data-confirm-form]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) finish(false);
    });

    dlg.showModal();
    /** @type {HTMLButtonElement | null} */ (dlg.querySelector('[data-confirm-ok]'))?.focus();
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
