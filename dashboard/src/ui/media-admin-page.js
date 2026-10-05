/**
 * Standalone `/media` manager — table, filters, CRUD (all poi_types).
 */

import {
  fetchAllMedia,
  updateMediaRow,
  deleteMediaRow,
  authenticateLoginNavme,
  insertMediaRow,
} from '../services/supabase.js';
import { deleteProjectMediaFile } from '../services/media-storage.js';
import { uploadProjectMedia } from '../services/media-storage.js';
import { storagePathFromPublicUrl } from '../utils/media-files.js';
import { classifyMediaFile } from '../utils/media-files.js';
import { downloadMediaAsPng } from '../utils/download-media-png.js';
import '../styles/global.css';
import '../styles/enterprise-theme.css';
import '../styles/glass-theme.css';
import '../styles/glass-animations.css';
import { initTheme, bindThemeToggle } from '../config/theme.js';
import { BRAND_NAME } from '../config/brand.js';
import { iconSun, iconMoon } from './icons.js';
import { renderForm } from './form.js';
import { openMediaModal } from './media-modal.js';
import { openSplatViewerModal } from './splat-viewer-modal.js';
import { showToast } from './toast.js';
import { askConfirm } from './confirm-dialog.js';
import { setPoiSession, clearPoiSession, getPoiType } from '../config/poi-session.js';
import { getProjectSession, clearProjectSession } from '../config/project-session.js';
import { t } from '../config/i18n.js';

/**
 * @param {HTMLElement} container
 */
export function initMediaAdminPage(container) {
  initTheme();
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'media-admin-page';
  page.innerHTML = `
    <header class="media-admin-topbar">
      <img src="/NavMe_wb.png" alt="${BRAND_NAME}" class="topbar-logo-img" />
      <div>
        <h1>${t('mediaAdmin.title')}</h1>
        <p class="media-admin-subtitle">${t('mediaAdmin.subtitle')}</p>
      </div>
      <div class="media-admin-topbar-actions">
        <button type="button" class="theme-toggle btn-ripple-host" id="media-theme-toggle" aria-label="${t('mediaAdmin.switchTheme')}">
          <span class="theme-toggle-icon theme-toggle-icon--sun">${iconSun()}</span>
          <span class="theme-toggle-icon theme-toggle-icon--moon">${iconMoon()}</span>
        </button>
        <a href="/" class="btn-secondary">${t('mediaAdmin.backToBrand', { brand: BRAND_NAME })}</a>
        <button type="button" class="btn-logout" id="media-admin-logout">${t('mediaAdmin.logout')}</button>
      </div>
    </header>
    <main class="media-admin-main hidden" id="media-admin-main">
      <div class="media-admin-filters">
        <input type="search" id="filter-search" placeholder="${t('mediaAdmin.searchPlaceholder')}" />
        <input type="text" id="filter-poi-type" placeholder="${t('mediaAdmin.filterPoiTypePlaceholder')}" />
        <select id="filter-media-type">
          <option value="">${t('mediaAdmin.allTypes')}</option>
          <option value="image">${t('mediaAdmin.typeImage')}</option>
          <option value="video">${t('mediaAdmin.typeVideo')}</option>
          <option value="model">${t('mediaAdmin.type3dModel')}</option>
          <option value="splat">${t('mediaAdmin.typeSplat')}</option>
        </select>
        <select id="filter-active">
          <option value="">${t('mediaAdmin.allStatus')}</option>
          <option value="true">${t('mediaAdmin.statusActive')}</option>
          <option value="false">${t('mediaAdmin.statusInactive')}</option>
        </select>
        <button type="button" class="btn-secondary" id="btn-media-admin-bulk-splat">${t('mediaAdmin.splatLoadButton')}</button>
        <button type="button" class="btn-save btn-save--compact" id="btn-media-admin-add">${t('mediaAdmin.addMediaButton')}</button>
      </div>
      <div class="media-admin-table-wrap">
        <table class="media-admin-table">
          <thead>
            <tr>
              <th>${t('mediaAdmin.colPreview')}</th>
              <th>${t('mediaAdmin.colLabel')}</th>
              <th>poi_type</th>
              <th>${t('mediaAdmin.colType')}</th>
              <th>${t('mediaAdmin.colRedirect')}</th>
              <th>${t('mediaAdmin.colActive')}</th>
              <th>${t('mediaAdmin.colCreated')}</th>
              <th>${t('mediaAdmin.colActions')}</th>
            </tr>
          </thead>
          <tbody id="media-admin-tbody"></tbody>
        </table>
      </div>
    </main>
  `;
  container.appendChild(page);
  bindThemeToggle(page.querySelector('#media-theme-toggle'));

  const mainEl = page.querySelector('#media-admin-main');
  const tbody = page.querySelector('#media-admin-tbody');

  let rows = [];

  async function loadRows() {
    const search = page.querySelector('#filter-search').value.trim();
    const poiType = page.querySelector('#filter-poi-type').value.trim();
    const mediaType = page.querySelector('#filter-media-type').value;
    const activeRaw = page.querySelector('#filter-active').value;
    const isActive = activeRaw === '' ? null : activeRaw === 'true';

    rows = await fetchAllMedia({
      allTypes: true,
      poiType: poiType || undefined,
      mediaType: mediaType || undefined,
      isActive,
      search: search || undefined,
    });
    renderTable();
  }

  function previewCell(row) {
    if (row.media_type === 'image') {
      return `<img src="${row.media_url}" alt="" class="media-admin-thumb" loading="lazy" />`;
    }
    if (row.media_type === 'video') {
      return `<video src="${row.media_url}" class="media-admin-thumb" muted preload="metadata"></video>`;
    }
    if (row.media_type === 'splat') {
      return '<span class="media-admin-thumb media-admin-thumb--model">PLY</span>';
    }
    return '<span class="media-admin-thumb media-admin-thumb--model">3D</span>';
  }

  function renderTable() {
    tbody.innerHTML = rows
      .map(
        (row) => `
      <tr data-id="${row.id}">
        <td>${previewCell(row)}</td>
        <td>${escapeHtml(row.label || '—')}</td>
        <td><code>${escapeHtml(row.poi_type)}</code></td>
        <td>${escapeHtml(row.media_type)}</td>
        <td>${row.redirect_link ? `<a href="${escapeHtml(row.redirect_link)}" target="_blank" rel="noopener noreferrer">${t('mediaAdmin.linkText')}</a>` : '—'}</td>
        <td><span class="badge ${row.is_active !== false ? 'badge--ok' : 'badge--off'}">${row.is_active !== false ? t('mediaAdmin.yes') : t('mediaAdmin.no')}</span></td>
        <td>${formatDate(row.created_at)}</td>
        <td class="media-admin-actions">
          ${row.media_type === 'splat' ? `<button type="button" data-action="view-splat">${t('mediaAdmin.viewButton')}</button>` : ''}
          ${row.media_type === 'image' || row.media_type === 'video' ? `<button type="button" data-action="download-png">${t('mediaAdmin.downloadPngButton')}</button>` : ''}
          <button type="button" data-action="edit">${t('mediaAdmin.editButton')}</button>
          <button type="button" data-action="toggle">${row.is_active !== false ? t('mediaAdmin.deactivateButton') : t('mediaAdmin.activateButton')}</button>
          <button type="button" data-action="delete" class="danger">${t('mediaAdmin.deleteButton')}</button>
        </td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn));
    });
  }

  async function handleAction(btn) {
    const tr = btn.closest('tr');
    const id = tr?.dataset.id;
    const row = rows.find((r) => String(r.id) === String(id));
    if (!row) return;

    if (btn.dataset.action === 'edit') {
      openMediaModal({ row, onSaved: () => loadRows() });
      return;
    }

    if (btn.dataset.action === 'view-splat') {
      openSplatViewerModal({ url: row.media_url, title: row.label || row.file_name || t('mediaAdmin.splatViewerFallbackTitle') });
      return;
    }

    if (btn.dataset.action === 'download-png') {
      btn.disabled = true;
      try {
        await downloadMediaAsPng(row);
        showToast(t('mediaAdmin.toastDownloadedPng'), 'success');
      } catch (err) {
        showToast(err.message ?? t('mediaAdmin.toastDownloadPngFailed'), 'error');
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (btn.dataset.action === 'toggle') {
      try {
        await updateMediaRow(id, { is_active: row.is_active === false });
        showToast(t('mediaAdmin.toastStatusUpdated'), 'success');
        await loadRows();
      } catch (err) {
        showToast(err.message, 'error');
      }
      return;
    }

    if (btn.dataset.action === 'delete') {
      const ok = await askConfirm({
        title: t('mediaAdmin.confirmDeleteTitle'),
        message: t('mediaAdmin.confirmDeleteMessage', { name: row.label || row.file_name }),
        confirmLabel: t('mediaAdmin.deleteButton'),
        cancelLabel: t('mediaAdmin.cancelButton'),
        danger: true,
      });
      if (!ok) return;
      const deleteStorage = await askConfirm({
        title: t('mediaAdmin.confirmDeleteStorageTitle'),
        message: t('mediaAdmin.confirmDeleteStorageMessage'),
        confirmLabel: t('mediaAdmin.yes'),
        cancelLabel: t('mediaAdmin.no'),
        danger: true,
      });
      try {
        await deleteMediaRow(id);
        if (deleteStorage) {
          const path = storagePathFromPublicUrl(row.media_url);
          if (path) await deleteProjectMediaFile(path);
        }
        showToast(t('mediaAdmin.toastDeleted'), 'success');
        await loadRows();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  }

  page.querySelector('#btn-media-admin-add').addEventListener('click', () => {
    openMediaModal({ onSaved: () => loadRows() });
  });

  page.querySelector('#btn-media-admin-bulk-splat').addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.ply';
    picker.multiple = true;
    picker.addEventListener('change', async () => {
      const files = Array.from(picker.files || []);
      if (!files.length) return;
      const typedPoiType = page.querySelector('#filter-poi-type').value.trim();
      const poiType = typedPoiType || getPoiType();
      if (!poiType) {
        showToast(t('mediaAdmin.toastSetPoiTypeFirst'), 'error');
        return;
      }
      let ok = 0;
      let failed = 0;
      for (const file of files) {
        try {
          const classified = classifyMediaFile(file);
          if (!classified || classified.mediaType !== 'splat') {
            failed += 1;
            continue;
          }
          const uploaded = await uploadProjectMedia(file, poiType, 'splat');
          await insertMediaRow({
            poi_type: poiType,
            media_url: uploaded.publicUrl,
            media_type: 'splat',
            mime_type: classified.mimeType,
            file_name: file.name,
            label: file.name.replace(/\.[^.]+$/, ''),
            rot_x: -Math.PI / 2,
            rot_y: 0,
            rot_z: 0,
            scale_x: 1,
            scale_y: 1,
            scale_z: 1,
            pos_x: 0,
            pos_y: 0,
            pos_z: 0,
            width: 1,
            height: 1,
            is_active: true,
          });
          ok += 1;
        } catch (err) {
          console.error('[splat-upload]', err);
          failed += 1;
        }
      }
      await loadRows();
      showToast(t('mediaAdmin.toastSplatUploadComplete', { ok, failed }), failed ? 'error' : 'success');
    });
    picker.click();
  });

  ['filter-search', 'filter-poi-type', 'filter-media-type', 'filter-active'].forEach((id) => {
    page.querySelector(`#${id}`).addEventListener('change', () => loadRows());
    page.querySelector(`#${id}`).addEventListener('input', debounce(() => loadRows(), 320));
  });

  page.querySelector('#media-admin-logout').addEventListener('click', () => {
    clearProjectSession();
    clearPoiSession();
    window.location.href = '/';
  });

  const formUI = renderForm(container, async (creds) => {
    setPoiSession({
      poiType: creds.poiType,
      mapCode: creds.mapCode,
      organizationId: creds.organizationId,
    });
    formUI.hide();
    mainEl.classList.remove('hidden');
    await loadRows();
  });

  // Restore saved project session on refresh
  (async () => {
    const saved = getProjectSession();
    if (!saved) return;
    formUI.hide();
    formUI.disable();
    try {
      const loginData = await authenticateLoginNavme(saved);
      if (!loginData) {
        clearProjectSession();
        formUI.enable();
        formUI.show();
        return;
      }
      setPoiSession({
        poiType: loginData.poiType,
        mapCode: loginData.mapCode,
        organizationId: loginData.organizationId,
      });
      formUI.hide();
      mainEl.classList.remove('hidden');
      await loadRows();
    } catch (err) {
      console.error(err);
      clearProjectSession();
      formUI.enable();
      formUI.show();
    }
  })();

  return { showLogin: () => formUI.show() };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
