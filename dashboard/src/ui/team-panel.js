/**
 * Project-admin / superadmin Admins panel — create/edit/disable sub-admins for the session poi_type.
 * Layout mirrors the superadmin Access Control page: search toolbar, card grid, modal dialog.
 */

import {
  adminListProjectMembers,
  projectAdminUpsertSubAdmin,
  projectAdminDeleteSubAdmin,
} from '../services/supabase.js';
import { logUserActivity } from '../services/user-logs.js';
import {
  getAuthSession,
  isProjectAdminSession,
  isSubAdminSession,
} from '../config/auth-session.js';
import { getSuperadminSession, hasSuperadminSession } from '../config/superadmin.js';
import { getPoiType } from '../config/poi-session.js';
import {
  iconRefresh,
  iconAdd,
  iconUsers,
  iconCopy,
  iconEye,
  iconEyeOff,
  iconEdit,
  iconSave,
  iconClose,
  iconSearch,
  iconDelete,
} from './icons.js';
import { showToast } from './toast.js';
import { askConfirm } from './confirm-dialog.js';
import { t } from '../config/i18n.js';

/**
 * @returns {{ email: string, password: string, poiType: string } | null}
 */
function teamCreds() {
  if (isSubAdminSession()) return null;
  const session = getAuthSession();
  const poiType = String(session?.poiType || getPoiType() || '').trim();
  if (!poiType) return null;

  if (session && (session.role === 'project_admin' || session.role === 'superadmin')) {
    return {
      email: session.email,
      password: session.password,
      poiType,
    };
  }

  const sa = getSuperadminSession();
  if (sa && hasSuperadminSession()) {
    return {
      email: sa.email,
      password: sa.password,
      poiType,
    };
  }

  if (isProjectAdminSession() && session) {
    return {
      email: session.email,
      password: session.password,
      poiType,
    };
  }

  return null;
}

/**
 * @param {HTMLElement} container
 * @param {{ onChange?: () => void, embedded?: boolean }} [options]
 */
export function createTeamPanel(container, options = {}) {
  const onChange = options.onChange;
  const embedded = Boolean(options.embedded);

  const panel = document.createElement('div');
  panel.className = embedded
    ? 'team-panel team-panel--embedded user-panel'
    : 'team-panel user-panel scene-float-panel scene-float-panel--single float-glass drawer-frost hidden';
  panel.id = embedded ? 'profile-team-panel' : 'team-panel';

  panel.innerHTML = `
    <div class="access-toolbar team-toolbar">
      <label class="access-search-field">
        <span class="access-search-icon" aria-hidden="true">${iconSearch()}</span>
        <input type="search" id="team-search" placeholder="${t('teamPanel.searchPlaceholder')}" />
      </label>
      <button type="button" class="access-action-btn" id="team-refresh-btn" title="${t('teamPanel.refresh')}">
        <span class="access-icon-slot" aria-hidden="true">${iconRefresh()}</span>
        <span>${t('teamPanel.refresh')}</span>
      </button>
      <button type="button" class="access-add-tenant-btn btn-ripple-host" id="team-add-open">
        <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
        <span>${t('teamPanel.newSubAdmin')}</span>
      </button>
    </div>
    <div class="access-card-grid team-card-grid" id="team-member-list" role="list"></div>
  `;

  container.appendChild(panel);

  const dialog = document.createElement('dialog');
  dialog.className = 'access-dialog team-admin-dialog';
  dialog.id = 'team-admin-dialog';
  dialog.innerHTML = `
    <form class="access-dialog-card float-glass" id="team-admin-form">
      <header class="access-dialog-header">
        <div class="access-dialog-heading">
          <span class="access-dialog-icon" aria-hidden="true">${iconUsers()}</span>
          <div>
            <h3 id="team-dialog-title">${t('teamPanel.newSubAdmin')}</h3>
            <p id="team-dialog-subtitle">${t('teamPanel.subAdminDescription')}</p>
          </div>
        </div>
        <button type="button" class="access-dialog-close btn-ripple-host" data-action="close-dialog" aria-label="${t('teamPanel.close')}">${iconClose()}</button>
      </header>
      <div class="access-dialog-body">
        <div class="form-group access-form-group">
          <label for="team-dialog-email">${t('teamPanel.email')}</label>
          <div class="access-dialog-field-row">
            <input id="team-dialog-email" type="email" required autocomplete="off" placeholder="${t('teamPanel.emailPlaceholder')}" />
            <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="team-dialog-email" title="${t('teamPanel.copyEmail')}" aria-label="${t('teamPanel.copyEmail')}">
              ${iconCopy()}
            </button>
          </div>
          <p class="access-field-help" id="team-dialog-email-help">${t('teamPanel.emailHelp')}</p>
        </div>
        <div class="form-group access-form-group">
          <label for="team-dialog-password">${t('teamPanel.password')}</label>
          <div class="access-dialog-field-row">
            <input id="team-dialog-password" type="password" required autocomplete="new-password" placeholder="${t('teamPanel.passwordPlaceholder')}" />
            <button type="button" class="access-copy-map-btn btn-ripple-host" data-toggle-secret="team-dialog-password" title="${t('teamPanel.showPassword')}" aria-label="${t('teamPanel.showPassword')}" aria-pressed="false">
              ${iconEye()}
            </button>
            <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="team-dialog-password" title="${t('teamPanel.copyPassword')}" aria-label="${t('teamPanel.copyPassword')}">
              ${iconCopy()}
            </button>
          </div>
          <p class="access-field-help" id="team-dialog-password-help">${t('teamPanel.passwordHelp')}</p>
        </div>
        <div class="form-group access-form-group">
          <label for="team-dialog-name">${t('teamPanel.displayName')}</label>
          <div class="access-dialog-field-row">
            <input id="team-dialog-name" type="text" autocomplete="off" placeholder="${t('teamPanel.displayNamePlaceholder')}" />
          </div>
        </div>
      </div>
      <footer class="access-dialog-actions">
        <button type="button" class="access-action-btn btn-ripple-host" data-action="close-dialog">
          <span class="access-icon-slot" aria-hidden="true">${iconClose()}</span>
          <span>${t('teamPanel.cancel')}</span>
        </button>
        <button type="submit" class="access-save-btn btn-ripple-host" id="team-dialog-save">
          <span class="access-icon-slot" aria-hidden="true">${iconSave()}</span>
          <span id="team-dialog-save-label">${t('teamPanel.addSubAdmin')}</span>
        </button>
      </footer>
    </form>
  `;
  document.body.appendChild(dialog);

  const listEl = /** @type {HTMLElement} */ (panel.querySelector('#team-member-list'));
  const searchInput = /** @type {HTMLInputElement} */ (panel.querySelector('#team-search'));
  const refreshBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('#team-refresh-btn'));
  const addOpenBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('#team-add-open'));
  const form = /** @type {HTMLFormElement} */ (dialog.querySelector('#team-admin-form'));
  const dialogTitle = /** @type {HTMLElement} */ (dialog.querySelector('#team-dialog-title'));
  const dialogSubtitle = /** @type {HTMLElement} */ (dialog.querySelector('#team-dialog-subtitle'));
  const dialogEmail = /** @type {HTMLInputElement} */ (dialog.querySelector('#team-dialog-email'));
  const dialogPassword = /** @type {HTMLInputElement} */ (dialog.querySelector('#team-dialog-password'));
  const dialogName = /** @type {HTMLInputElement} */ (dialog.querySelector('#team-dialog-name'));
  const dialogEmailHelp = /** @type {HTMLElement} */ (dialog.querySelector('#team-dialog-email-help'));
  const dialogPasswordHelp = /** @type {HTMLElement} */ (dialog.querySelector('#team-dialog-password-help'));
  const dialogSaveBtn = /** @type {HTMLButtonElement} */ (dialog.querySelector('#team-dialog-save'));
  const dialogSaveLabel = /** @type {HTMLElement} */ (dialog.querySelector('#team-dialog-save-label'));

  /** @type {Array<Record<string, unknown>>} */
  let members = [];
  /** @type {Record<string, unknown> | null} */
  let editingMember = null;
  let searchTerm = '';

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function copyText(value, label) {
    const text = String(value ?? '').trim();
    if (!text) {
      showToast(t('teamPanel.nothingToCopy', { label }), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('teamPanel.copiedSuccess', { label }), 'success');
    } catch {
      showToast(t('teamPanel.copyFailed', { label: label.toLowerCase() }), 'error');
    }
  }

  function resetSecretToggle(showPlain = false) {
    const toggle = dialog.querySelector('[data-toggle-secret="team-dialog-password"]');
    dialogPassword.type = showPlain ? 'text' : 'password';
    if (toggle) {
      toggle.innerHTML = showPlain ? iconEyeOff() : iconEye();
      toggle.setAttribute('aria-pressed', showPlain ? 'true' : 'false');
      toggle.title = showPlain ? t('teamPanel.hidePassword') : t('teamPanel.showPassword');
      toggle.setAttribute('aria-label', showPlain ? t('teamPanel.hidePassword') : t('teamPanel.showPassword'));
    }
  }

  function closeDialog() {
    editingMember = null;
    if (dialog.open) dialog.close();
    form.reset();
    resetSecretToggle(false);
  }

  /**
   * @param {Record<string, unknown> | null} member
   */
  function openDialog(member = null) {
    if (member && String(member.role) !== 'sub_admin') return;
    const isEdit = Boolean(member);
    editingMember = member;
    dialogTitle.textContent = isEdit ? t('teamPanel.editSubAdmin') : t('teamPanel.newSubAdmin');
    dialogSubtitle.textContent = isEdit
      ? t('teamPanel.editSubAdminDescription')
      : t('teamPanel.subAdminDescription');
    dialogSaveLabel.textContent = isEdit ? t('teamPanel.saveChanges') : t('teamPanel.addSubAdmin');
    dialogEmail.value = isEdit ? String(member?.email ?? '') : '';
    dialogEmail.readOnly = isEdit;
    dialogEmailHelp.textContent = isEdit
      ? t('teamPanel.emailLocked')
      : t('teamPanel.emailHelp');
    dialogPassword.value = isEdit ? String(member?.password ?? '') : '';
    dialogPassword.required = true;
    dialogPassword.placeholder = isEdit ? t('teamPanel.currentPasswordPlaceholder') : t('teamPanel.passwordPlaceholder');
    dialogPasswordHelp.textContent = isEdit
      ? t('teamPanel.currentPasswordHelp')
      : t('teamPanel.passwordHelp');
    dialogName.value = isEdit ? String(member?.display_name ?? '') : '';
    resetSecretToggle(isEdit);
    dialog.showModal();
    (isEdit ? dialogName : dialogEmail).focus();
  }

  function visibleMembers() {
    const term = searchTerm.trim().toLowerCase();
    const sorted = [
      ...members.filter((m) => String(m.role) === 'project_admin'),
      ...members.filter((m) => String(m.role) === 'sub_admin'),
    ];
    if (!term) return sorted;
    return sorted.filter((m) =>
      [m.display_name, m.email, m.role].some((field) =>
        String(field ?? '')
          .toLowerCase()
          .includes(term),
      ),
    );
  }

  function renderList() {
    const rows = visibleMembers();
    if (!rows.length) {
      const isFiltered = Boolean(searchTerm.trim()) && members.length > 0;
      listEl.innerHTML = `
        <div class="access-empty team-empty">
          <span class="access-empty-icon" aria-hidden="true">${iconUsers()}</span>
          <p>${isFiltered ? t('teamPanel.noSearchResults') : t('teamPanel.noAdmins')}</p>
          ${
            isFiltered
              ? ''
              : `<button type="button" class="access-add-tenant-btn btn-ripple-host" data-action="empty-add">
                   <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
                   <span>${t('teamPanel.newSubAdmin')}</span>
                 </button>`
          }
        </div>`;
      listEl
        .querySelector('[data-action="empty-add"]')
        ?.addEventListener('click', () => openDialog());
      return;
    }

    const card = (m) => {
      const isSub = String(m.role) === 'sub_admin';
      const role = isSub ? t('teamPanel.roleSubAdmin') : t('teamPanel.roleProjectAdmin');
      const active = Boolean(m.is_active);
      const name = String(m.display_name || String(m.email).split('@')[0] || m.email);
      return `
        <article class="access-tenant-card team-admin-card" data-account-id="${escapeHtml(m.account_id)}" role="listitem">
          <span class="access-tenant-card-accent" aria-hidden="true"></span>
          <div class="team-admin-card-top">
            <span class="access-tenant-chip team-admin-chip${active ? '' : ' team-admin-chip--off'}">${escapeHtml(role)}${active ? '' : escapeHtml(t('teamPanel.inactiveSuffix'))}</span>
          </div>
          <div class="access-tenant-body">
            <span class="access-tenant-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="access-tenant-email" title="${escapeHtml(m.email)}">${escapeHtml(m.email)}</span>
          </div>
          ${
            isSub
              ? `<div class="access-tenant-footer team-admin-footer">
                   <button type="button" class="access-action-btn team-edit-btn" title="${t('teamPanel.editSubAdmin')}">
                     <span class="access-icon-slot" aria-hidden="true">${iconEdit()}</span>
                     <span>${t('teamPanel.edit')}</span>
                   </button>
                   <button type="button" class="access-action-btn${active ? ' access-action-btn--danger' : ''} team-toggle-active" data-active="${active ? '1' : '0'}">${active ? t('teamPanel.disable') : t('teamPanel.enable')}</button>
                   <button type="button" class="access-action-btn access-action-btn--danger team-delete-btn" title="${t('teamPanel.deleteSubAdmin')}">
                     <span class="access-icon-slot" aria-hidden="true">${iconDelete()}</span>
                     <span>${t('teamPanel.delete')}</span>
                   </button>
                 </div>`
              : ''
          }
        </article>`;
    };

    listEl.innerHTML = rows.map(card).join('');

    listEl.querySelectorAll('.team-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.team-admin-card');
        const accountId = row?.dataset.accountId;
        const member = members.find((m) => String(m.account_id) === String(accountId));
        if (member) openDialog(member);
      });
    });

    listEl.querySelectorAll('.team-toggle-active').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.team-admin-card');
        const accountId = row?.dataset.accountId;
        const member = members.find((m) => String(m.account_id) === String(accountId));
        if (!member) return;
        const creds = teamCreds();
        if (!creds) return;
        const nextActive = btn.dataset.active !== '1';
        btn.disabled = true;
        try {
          await projectAdminUpsertSubAdmin({
            email: creds.email,
            password: creds.password,
            subEmail: String(member.email),
            subPassword: '',
            displayName: member.display_name ? String(member.display_name) : null,
            active: nextActive,
            poiType: creds.poiType,
          });
          logUserActivity({
            action: nextActive ? 'enabled' : 'disabled',
            entityType: 'sub_admin',
            entityId: member.account_id,
            entityLabel: String(member.email),
            createdEmail: String(member.email),
            poiType: creds.poiType,
          });
          showToast(nextActive ? t('teamPanel.subAdminEnabled') : t('teamPanel.subAdminDisabled'), 'success');
          await loadMembers();
          onChange?.();
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll('.team-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.team-admin-card');
        const accountId = row?.dataset.accountId;
        const member = members.find((m) => String(m.account_id) === String(accountId));
        if (!member) return;
        const label = String(member.display_name || member.email);
        const ok = await askConfirm({
          title: t('teamPanel.deleteSubAdminConfirmTitle'),
          message: t('teamPanel.deleteSubAdminConfirmMessage', { label }),
          confirmLabel: t('teamPanel.delete'),
          cancelLabel: t('teamPanel.cancel'),
          danger: true,
        });
        if (!ok) return;
        const creds = teamCreds();
        if (!creds) return;
        btn.disabled = true;
        try {
          await projectAdminDeleteSubAdmin({
            email: creds.email,
            password: creds.password,
            subEmail: String(member.email),
            poiType: creds.poiType,
          });
          logUserActivity({
            action: 'deleted',
            entityType: 'sub_admin',
            entityId: member.account_id,
            entityLabel: String(member.email),
            createdEmail: String(member.email),
            poiType: creds.poiType,
          });
          showToast(t('teamPanel.subAdminDeleted'), 'success');
          await loadMembers();
          onChange?.();
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function loadMembers() {
    const creds = teamCreds();
    if (!creds) {
      members = [];
      renderList();
      return;
    }
    try {
      members = await adminListProjectMembers({
        email: creds.email,
        password: creds.password,
        poiType: creds.poiType,
      });
    } catch (err) {
      console.error(err);
      showToast(String(err?.message ?? err), 'error');
      members = [];
    }
    renderList();
  }

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value;
    renderList();
  });

  addOpenBtn.addEventListener('click', () => {
    if (isSubAdminSession()) {
      showToast(t('teamPanel.subAdminsCannotManage'), 'error');
      return;
    }
    openDialog();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-dialog"]')) closeDialog();
  });
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog();
  });

  dialog.querySelectorAll('[data-copy-input]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = dialog.querySelector(`#${btn.getAttribute('data-copy-input')}`);
      copyText(input?.value, input === dialogEmail ? 'Email' : 'Password');
    });
  });

  dialog.querySelectorAll('[data-toggle-secret]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const reveal = btn.getAttribute('aria-pressed') !== 'true';
      dialogPassword.type = reveal ? 'text' : 'password';
      btn.setAttribute('aria-pressed', reveal ? 'true' : 'false');
      btn.title = reveal ? t('teamPanel.hidePassword') : t('teamPanel.showPassword');
      btn.setAttribute('aria-label', reveal ? t('teamPanel.hidePassword') : t('teamPanel.showPassword'));
      btn.innerHTML = reveal ? iconEyeOff() : iconEye();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubAdminSession()) {
      showToast(t('teamPanel.subAdminsCannotManage'), 'error');
      return;
    }
    const creds = teamCreds();
    if (!creds) {
      showToast(t('teamPanel.onlyAdminsCanManage'), 'error');
      return;
    }
    const isEdit = Boolean(editingMember);
    const subEmail = isEdit ? String(editingMember?.email ?? '') : dialogEmail.value.trim();
    const subPassword = dialogPassword.value;
    const displayName = dialogName.value.trim();
    const active = isEdit ? Boolean(editingMember?.is_active) : true;
    dialogSaveBtn.disabled = true;
    const prevLabel = dialogSaveLabel.textContent;
    dialogSaveLabel.textContent = t('teamPanel.saving');
    try {
      await projectAdminUpsertSubAdmin({
        email: creds.email,
        password: creds.password,
        subEmail,
        // Empty password keeps the existing password (RPC skips password update).
        subPassword,
        displayName: displayName || null,
        active,
        poiType: creds.poiType,
      });
      logUserActivity({
        action: isEdit ? 'updated' : 'created',
        entityType: 'sub_admin',
        entityId: isEdit ? editingMember?.account_id : undefined,
        entityLabel: subEmail,
        createdEmail: subEmail,
        poiType: creds.poiType,
        details: isEdit
          ? { display_name: displayName || null, password_changed: Boolean(subPassword) }
          : undefined,
      });
      showToast(isEdit ? t('teamPanel.subAdminUpdated') : t('teamPanel.subAdminCreated'), 'success');
      closeDialog();
      await loadMembers();
      onChange?.();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    } finally {
      dialogSaveBtn.disabled = false;
      dialogSaveLabel.textContent = prevLabel;
    }
  });

  refreshBtn.addEventListener('click', () => loadMembers());

  return {
    show() {
      if (isSubAdminSession()) {
        panel.classList.add('hidden');
        return;
      }
      panel.classList.remove('hidden');
      void loadMembers();
    },
    hide() {
      if (!embedded) panel.classList.add('hidden');
      closeDialog();
    },
    refresh: loadMembers,
    getMembers: () => members.slice(),
  };
}
