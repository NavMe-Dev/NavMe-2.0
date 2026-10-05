/**
 * Media panel — split list + edit (drawer UI).
 */

import * as THREE from 'three';
import {
  mediaData,
  getMediaObjects,
  updateMediaTransformById,
  saveMediaToDbById,
  removeMediaFromDbById,
  deleteMediaFromSceneByIdSafe,
  mediaItemById,
  mediaIndexById,
  isMatterportMediaRow,
} from '../ar/media.js';
import {
  flyTo,
  attachGizmo,
  detachGizmo,
  setGizmoDragCallback,
  setGizmoDragEndCallback,
  setGizmoMode,
} from '../ar/scene.js';
import { getMultisetAnchor } from '../ar/scene.js';
import { isMatterportMapActive } from '../ar/matterport-map.js';
import { showToast } from './toast.js';
import { askConfirm, isConfirmDialogOpen } from './confirm-dialog.js';
import { deleteProjectMediaFile } from '../services/media-storage.js';
import { storagePathFromPublicUrl } from '../utils/media-files.js';
import { openMediaModal } from './media-modal.js';
import { openSplatViewerModal } from './splat-viewer-modal.js';
import { downloadMediaAsPng } from '../utils/download-media-png.js';
import { iconSave, iconDelete, iconMediaImage, iconMediaVideo, iconMediaModel, iconDownload } from './icons.js';
import { t } from '../config/i18n.js';

let selectedIndex = -1;
// The stable DB id of the selected media. This — not the array index — is the
// source of truth for every write/delete, so realtime reordering of the shared
// `mediaData` array (or an await gap while a confirm dialog is open) can never
// redirect an operation onto a different media row. selectedIndex is kept only
// for synchronous UI convenience and is always re-derived from selectedId.
let selectedId = null;
let gizmoMode = 'translate';

/**
 * @param {HTMLElement} container
 * @param {{ onMediaChange?: () => void, onStartPlaceOnMap?: () => void, onEditMedia?: (saved: Record<string, unknown>, context?: { previewUrl?: string }) => void }} [options]
 */
export function createMediaPanel(container, options = {}) {
  const onMediaChange = options.onMediaChange;
  const onEditMedia = options.onEditMedia;
  const onSelectionChange = options.onSelectionChange;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'media-list-panel';

  listPanel.innerHTML = `
    <div class="media-panel-header poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${t('mediaPanel.title')}</div>
      </div>
    </div>
    <div class="media-list poi-list" id="media-list"></div>
  `;

  container.appendChild(listPanel);

  // Sidebar edit (old pattern) — no full-screen dialog/backdrop blocking Matterport AR.
  const editPanel = document.createElement('div');
  editPanel.className = 'scene-float-panel scene-float-panel--edit float-glass drawer-frost hidden';
  editPanel.id = 'media-edit-panel';
  editPanel.innerHTML = `
    <div class="media-panel-header poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title" id="media-edit-dialog-title">${t('mediaPanel.editMediaTitle')}</div>
      </div>
    </div>
    <div class="media-coords poi-coords" id="media-coords">
      <div class="poi-coords-title hidden" id="media-selected-label" aria-hidden="true"></div>
      <div class="media-gizmo-modes">
        <button type="button" class="gizmo-mode-btn active" data-mode="translate">${t('mediaPanel.moveMode')}</button>
        <button type="button" class="gizmo-mode-btn" data-mode="rotate">${t('mediaPanel.rotateMode')}</button>
        <button type="button" class="gizmo-mode-btn" data-mode="scale">${t('mediaPanel.scaleMode')}</button>
      </div>
      <div class="coord-inputs media-fields-move" id="media-fields-move">
        <div class="coord-group"><span class="field-label field-label--x">${t('mediaPanel.axisX')}</span><input type="number" id="media-x" step="any" inputmode="decimal" /></div>
        <div class="coord-group"><span class="field-label field-label--y">${t('mediaPanel.axisY')}</span><input type="number" id="media-y" step="any" inputmode="decimal" /></div>
        <div class="coord-group"><span class="field-label field-label--z">${t('mediaPanel.axisZ')}</span><input type="number" id="media-z" step="any" inputmode="decimal" /></div>
      </div>
      <div class="coord-inputs media-fields-rotate hidden transform-axis-row" id="media-fields-rotate">
        <span class="transform-axis-row-label">${t('mediaPanel.rotationLabel')}</span>
        <div class="coord-group coord-group--axis">
          <input type="number" id="media-rotx" step="1" inputmode="decimal" aria-label="${t('mediaPanel.rotationXAriaLabel')}" />
          <span class="axis-suffix axis-suffix--x">${t('mediaPanel.axisX')}</span>
        </div>
        <div class="coord-group coord-group--axis">
          <input type="number" id="media-roty" step="1" inputmode="decimal" aria-label="${t('mediaPanel.rotationYAriaLabel')}" />
          <span class="axis-suffix axis-suffix--y">${t('mediaPanel.axisY')}</span>
        </div>
        <div class="coord-group coord-group--axis">
          <input type="number" id="media-rotz" step="1" inputmode="decimal" aria-label="${t('mediaPanel.rotationZAriaLabel')}" />
          <span class="axis-suffix axis-suffix--z">${t('mediaPanel.axisZ')}</span>
        </div>
      </div>
      <div class="coord-inputs media-fields-scale hidden" id="media-fields-scale-plane">
        <div class="coord-group"><span class="field-label">${t('mediaPanel.scaleWidthLabel')}</span><input type="number" id="media-width-edit" step="any" min="0.1" value="1" /></div>
        <div class="coord-group"><span class="field-label">${t('mediaPanel.scaleHeightLabel')}</span><input type="number" id="media-height-edit" step="any" min="0.1" value="1" /></div>
      </div>
      <div class="coord-inputs media-fields-scale hidden" id="media-fields-scale-model">
        <div class="coord-group"><span class="field-label">${t('mediaPanel.scaleXLabel')}</span><input type="number" id="media-scale-x" step="any" min="0.01" value="1" /></div>
        <div class="coord-group"><span class="field-label">${t('mediaPanel.scaleYLabel')}</span><input type="number" id="media-scale-y" step="any" min="0.01" value="1" /></div>
        <div class="coord-group"><span class="field-label">${t('mediaPanel.scaleZLabel')}</span><input type="number" id="media-scale-z" step="any" min="0.01" value="1" /></div>
      </div>
      <div class="media-panel-details">
        <button type="button" class="btn-secondary media-edit-details-btn hidden" id="btn-open-splat-viewer">${t('mediaPanel.openSplatViewerButton')}</button>
        <button type="button" class="btn-secondary media-edit-details-btn" id="btn-edit-media-details">${t('mediaPanel.editFileLabelButton')}</button>
        <button type="button" class="btn-secondary media-edit-details-btn media-download-png-btn" id="btn-download-media-png">
          <span class="icon">${iconDownload()}</span> ${t('mediaPanel.downloadPngButton')}
        </button>
      </div>
    </div>
  `;
  container.appendChild(editPanel);

  const actionsPanel = document.createElement('div');
  actionsPanel.className = 'scene-float-panel scene-float-panel--actions float-glass drawer-frost hidden';
  actionsPanel.id = 'media-actions-panel';
  actionsPanel.innerHTML = `
    <div class="poi-actions-row media-panel-save-row" id="media-actions-row">
      <button type="button" class="btn-save btn-delete poi-btn-delete" id="btn-delete-media" title="${t('mediaPanel.deleteButtonTitle')}">${iconDelete()}</button>
      <button type="button" class="btn-secondary" data-action="close-edit">${t('mediaPanel.doneButton')}</button>
      <button type="button" class="btn-save poi-btn-save" id="btn-save-media">
        <span class="icon">${iconSave()}</span> ${t('mediaPanel.saveButton')}
      </button>
    </div>
  `;
  container.appendChild(actionsPanel);

  const listEl = listPanel.querySelector('#media-list');
  const moveFields = editPanel.querySelector('#media-fields-move');
  const rotateFields = editPanel.querySelector('#media-fields-rotate');
  const planeScaleFields = editPanel.querySelector('#media-fields-scale-plane');
  const modelScaleFields = editPanel.querySelector('#media-fields-scale-model');
  const inputs = {
    x: editPanel.querySelector('#media-x'),
    y: editPanel.querySelector('#media-y'),
    z: editPanel.querySelector('#media-z'),
    rotx: editPanel.querySelector('#media-rotx'),
    roty: editPanel.querySelector('#media-roty'),
    rotz: editPanel.querySelector('#media-rotz'),
    width: editPanel.querySelector('#media-width-edit'),
    height: editPanel.querySelector('#media-height-edit'),
    scaleX: editPanel.querySelector('#media-scale-x'),
    scaleY: editPanel.querySelector('#media-scale-y'),
    scaleZ: editPanel.querySelector('#media-scale-z'),
  };
  const btnOpenSplatViewer = editPanel.querySelector('#btn-open-splat-viewer');
  const btnDownloadPng = editPanel.querySelector('#btn-download-media-png');
  const btnSave = actionsPanel.querySelector('#btn-save-media');
  const btnDelete = actionsPanel.querySelector('#btn-delete-media');
  const selectedLabelEl = editPanel.querySelector('#media-selected-label');
  const editTitleEl = editPanel.querySelector('#media-edit-dialog-title');

  function mediaTypeIcon(type) {
    if (type === 'video') return iconMediaVideo();
    if (type === 'model') return iconMediaModel();
    if (type === 'splat') return iconMediaModel();
    return iconMediaImage();
  }

  function updateFieldVisibility(mode = gizmoMode) {
    gizmoMode = mode;
    const showMove = mode === 'translate';
    const showRotate = mode === 'rotate';
    const showScale = mode === 'scale';

    moveFields.classList.toggle('hidden', !showMove);
    rotateFields.classList.toggle('hidden', !showRotate);

    const item = selectedIndex >= 0 ? mediaData[selectedIndex] : null;
    const isPlane = item && (item.media_type === 'image' || item.media_type === 'video');
    const isModel = item && (item.media_type === 'model' || item.media_type === 'splat');

    planeScaleFields.classList.toggle('hidden', !showScale || !isPlane);
    modelScaleFields.classList.toggle('hidden', !showScale || !isModel);
    btnOpenSplatViewer?.classList.toggle('hidden', !(item && item.media_type === 'splat'));
    const canDownloadPng = Boolean(item && (item.media_type === 'image' || item.media_type === 'video') && (item.media_url || item._previewUrl));
    btnDownloadPng?.classList.toggle('hidden', !canDownloadPng);
  }

  function setMediaGizmoMode(mode) {
    editPanel.querySelectorAll('.gizmo-mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    setGizmoMode(mode);
    updateFieldVisibility(mode);
  }

  function rebuildList() {
    const scrollTop = listEl.scrollTop;
    // Re-derive the selected index from the stable id — the array may have been
    // reordered/spliced by realtime since the last render.
    selectedIndex = mediaIndexById(selectedId);
    listEl.innerHTML = '';
    const skipSplatMapRows = mediaData.some((m) => m.is_active && m.media_type === 'splat');
    mediaData.forEach((item, index) => {
      // Map splats / Matterport links are the scene backdrop — keep them out of the Media editor list.
      if (skipSplatMapRows && item.media_type === 'splat') return;
      if (item.media_type === 'matterport') return;
      if (isMatterportMediaRow(item)) return;
      const row = document.createElement('div');
      row.className = 'poi-item media-item';
      row.dataset.index = index;
      row.dataset.id = String(item.id ?? '');
      if (selectedId != null && String(item.id) === String(selectedId)) {
        row.classList.add('active');
        selectedIndex = index;
      }
      const inactive = item.is_active ? '' : ` ${t('mediaPanel.inactiveSuffix')}`;
      const redirectTag = String(item.redirect_link ?? '').trim() ? ` <span class="media-item-redirect">${t('mediaPanel.redirectTag')}</span>` : '';
      const canDownloadPng = item.media_type === 'image' || item.media_type === 'video';
      row.innerHTML = `<span class="media-item-badge" aria-hidden="true">${mediaTypeIcon(item.media_type)}</span><span class="media-item-label">${item.label}${redirectTag}${inactive}</span>${canDownloadPng ? `<button type="button" class="media-item-download" data-action="download-png" title="${t('mediaPanel.downloadPngTitle')}" aria-label="${t('mediaPanel.downloadPngAriaLabel')}">${iconDownload()}</button>` : ''}`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="download-png"]')) return;
        selectMedia(mediaIndexById(row.dataset.id), { fly: true });
      });
      row.querySelector('[data-action="download-png"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleDownloadPng(item, e.currentTarget);
      });
      listEl.appendChild(row);
    });
    listEl.scrollTop = scrollTop;
  }

  function fillInputs(item) {
    inputs.x.value = item.pos_x.toFixed(4);
    inputs.y.value = item.pos_y.toFixed(4);
    inputs.z.value = item.pos_z.toFixed(4);
    // UI shows degrees (like 90 / 0 / 180); scene + DB keep radians.
    const isSplat = item.media_type === 'splat';
    const rx = isSplat ? -90 : THREE.MathUtils.radToDeg(Number(item.rot_x) || 0);
    const ry = isSplat ? 0 : THREE.MathUtils.radToDeg(Number(item.rot_y) || 0);
    const rz = isSplat ? 0 : THREE.MathUtils.radToDeg(Number(item.rot_z) || 0);
    inputs.rotx.value = String(Math.round(rx * 1000) / 1000);
    inputs.roty.value = String(Math.round(ry * 1000) / 1000);
    inputs.rotz.value = String(Math.round(rz * 1000) / 1000);
    inputs.width.value = item.width.toFixed(2);
    inputs.height.value = item.height.toFixed(2);
    inputs.scaleX.value = item.scale_x.toFixed(4);
    inputs.scaleY.value = item.scale_y.toFixed(4);
    inputs.scaleZ.value = item.scale_z.toFixed(4);
    updateFieldVisibility(gizmoMode);
  }

  function readInputsIntoItem(id) {
    const item = mediaItemById(id);
    if (!item) return;
    const isSplat = item.media_type === 'splat';
    const rotXDeg = isSplat ? -90 : parseFloat(inputs.rotx.value) || 0;
    const rotYDeg = isSplat ? 0 : parseFloat(inputs.roty.value) || 0;
    const rotZDeg = isSplat ? 0 : parseFloat(inputs.rotz.value) || 0;
    updateMediaTransformById(id, {
      pos_x: parseFloat(inputs.x.value) || 0,
      pos_y: parseFloat(inputs.y.value) || 0,
      pos_z: parseFloat(inputs.z.value) || 0,
      rot_x: THREE.MathUtils.degToRad(rotXDeg),
      rot_y: THREE.MathUtils.degToRad(rotYDeg),
      rot_z: THREE.MathUtils.degToRad(rotZDeg),
      scale_x: parseFloat(inputs.scaleX.value) || 1,
      scale_y: parseFloat(inputs.scaleY.value) || 1,
      scale_z: parseFloat(inputs.scaleZ.value) || 1,
      width: parseFloat(inputs.width.value) || 1,
      height: parseFloat(inputs.height.value) || 1,
    });
  }

  /**
   * @param {number} index
   * @param {{ fly?: boolean, attach?: boolean }} [opts]
   */
  function selectMedia(index, opts = {}) {
    const fly = opts.fly !== false;
    const attach = opts.attach !== false;
    const isOnMatterport = isMatterportMapActive();

    selectedIndex = index;
    const item = mediaData[index];
    if (!item) return;
    selectedId = item.id ?? null;
    listEl.querySelectorAll('.poi-item').forEach((el, i) => el.classList.toggle('active', i === index));
    if (selectedLabelEl) selectedLabelEl.textContent = item.label;
    if (editTitleEl) editTitleEl.textContent = String(item.label || t('mediaPanel.editMediaTitle'));

    // Only show edit panel and attach gizmo for geometric mesh maps
    if (!isOnMatterport) {
      fillInputs(item);
      setMediaGizmoMode(gizmoMode || 'translate');
      openEditPanel();
      if (attach) {
        // Resolve the scene object by stable id, never by array index: `mediaObjects`
        // is rebuilt by addMediaToScene while `mediaData` is re-hydrated/spliced
        // independently, so the two arrays can fall out of step and a positional
        // lookup would hand the gizmo a different media's root.
        const entry = getMediaObjects().find(
          (o) => o?.root && String(o.item?.id) === String(selectedId),
        );
        if (entry) {
          attachGizmo(entry.root);
        } else {
          detachGizmo();
          if (!item.is_active) {
            showToast(t('mediaPanel.toastInactiveEnableHint'), 'info');
          }
        }
      }
    } else {
      // On Matterport, close edit panel (no transform editing)
      closeEditPanel();
      detachGizmo();
    }

    if (fly) {
      flyTo(item.pos_x, item.pos_y, item.pos_z, {
        entityKind: 'media',
        entityId: item.id,
      });
    }
    onSelectionChange?.(index);
  }

  function closeEditPanel() {
    editPanel.classList.add('hidden');
    actionsPanel.classList.add('hidden');
  }

  function openEditPanel() {
    editPanel.classList.remove('hidden');
    actionsPanel.classList.remove('hidden');
  }

  async function handleDownloadPng(item, btn) {
    if (!item) return;
    if (btn && 'disabled' in btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      await downloadMediaAsPng(item);
      showToast(t('mediaPanel.toastDownloadedPng'), 'success');
    } catch (err) {
      showToast(err.message ?? t('mediaPanel.toastDownloadPngFailed'), 'error');
    } finally {
      if (btn && 'disabled' in btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
  }

  function deselectMedia() {
    selectedIndex = -1;
    selectedId = null;
    closeEditPanel();
    detachGizmo();
    onSelectionChange?.(-1);
  }

  actionsPanel.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) deselectMedia();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editPanel.classList.contains('hidden')) {
      if (isConfirmDialogOpen()) return;
      deselectMedia();
    }
  });

  editPanel.querySelectorAll('.gizmo-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMediaGizmoMode(btn.dataset.mode));
  });

  btnSave.addEventListener('click', async () => {
    if (selectedId == null) return;
    const id = selectedId;
    readInputsIntoItem(id);
    try {
      const { markMediaLocalWrite } = await import('../services/media-realtime.js');
      markMediaLocalWrite(id);
      await saveMediaToDbById(id);
      showToast(t('mediaPanel.toastMediaSaved'), 'success');
      rebuildList();
      onMediaChange?.();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  editPanel.querySelector('#btn-edit-media-details').addEventListener('click', () => {
    const item = mediaItemById(selectedId);
    if (!item) return;
    openMediaModal({
      row: { ...item },
      onSaved: (saved, context) => onEditMedia?.(saved, context),
    });
  });

  btnOpenSplatViewer?.addEventListener('click', () => {
    const item = mediaItemById(selectedId);
    if (!item || item.media_type !== 'splat') return;
    openSplatViewerModal({ url: item.media_url, title: item.label || item.file_name || t('mediaPanel.splatViewerFallbackTitle') });
  });

  btnDownloadPng?.addEventListener('click', () => {
    const item = mediaItemById(selectedId);
    if (!item) return;
    void handleDownloadPng(item, btnDownloadPng);
  });

  btnDelete.addEventListener('click', async () => {
    // Capture the stable id + a snapshot of the item BEFORE any await. The two
    // confirm dialogs below are async gaps during which realtime can reorder the
    // shared mediaData array; keying off id (never index) guarantees we delete
    // exactly the row the user chose, and never a neighbour that shifted into
    // the old index slot.
    const id = selectedId;
    const item = mediaItemById(id);
    if (id == null || !item) return;
    const mediaUrl = item.media_url;
    const label = item.label;
    const ok = await askConfirm({
      title: t('mediaPanel.confirmDeleteTitle'),
      message: t('mediaPanel.confirmDeleteMessage', { name: label }),
      confirmLabel: t('mediaPanel.deleteLabel'),
      cancelLabel: t('mediaPanel.cancelLabel'),
      danger: true,
    });
    if (!ok) return;
    const deleteStorage = await askConfirm({
      title: t('mediaPanel.confirmDeleteStorageTitle'),
      message: t('mediaPanel.confirmDeleteStorageMessage'),
      confirmLabel: t('mediaPanel.yes'),
      cancelLabel: t('mediaPanel.no'),
      danger: true,
    });
    try {
      await removeMediaFromDbById(id);
      if (deleteStorage) {
        const path = storagePathFromPublicUrl(mediaUrl);
        if (path) await deleteProjectMediaFile(path);
      }
      deleteMediaFromSceneByIdSafe(id);
      deselectMedia();
      rebuildList();
      onMediaChange?.();
      showToast(t('mediaPanel.toastMediaDeleted'), 'success');
    } catch (err) {
      showToast(err.message ?? t('mediaPanel.toastDeleteMediaFailed'), 'error');
    }
  });

  function wireMediaGizmoHandlers() {
    setGizmoDragCallback((transform) => {
      if (selectedId == null) return;
      const pos = transform.position;
      const rot = transform.rotation;
      const scl = transform.scale;
      inputs.x.value = pos.x.toFixed(4);
      inputs.y.value = pos.y.toFixed(4);
      inputs.z.value = pos.z.toFixed(4);
      inputs.rotx.value = String(Math.round(THREE.MathUtils.radToDeg(rot.x) * 1000) / 1000);
      inputs.roty.value = String(Math.round(THREE.MathUtils.radToDeg(rot.y) * 1000) / 1000);
      inputs.rotz.value = String(Math.round(THREE.MathUtils.radToDeg(rot.z) * 1000) / 1000);
      inputs.scaleX.value = scl.x.toFixed(4);
      inputs.scaleY.value = scl.y.toFixed(4);
      inputs.scaleZ.value = scl.z.toFixed(4);
      updateMediaTransformById(selectedId, {
        pos_x: pos.x,
        pos_y: pos.y,
        pos_z: pos.z,
        rot_x: rot.x,
        rot_y: rot.y,
        rot_z: rot.z,
        scale_x: scl.x,
        scale_y: scl.y,
        scale_z: scl.z,
      });
    });

    setGizmoDragEndCallback(() => {
      if (selectedId == null) return;
      const id = selectedId;
      const logAction = gizmoMode === 'scale' ? 'scaled' : gizmoMode === 'translate' ? 'moved' : 'updated';
      import('../services/media-realtime.js')
        .then(({ markMediaLocalWrite }) => {
          markMediaLocalWrite(id);
          return saveMediaToDbById(id, { logAction });
        })
        .catch((err) => console.error('[media-panel]', err));
    });
  }

  wireMediaGizmoHandlers();

  return {
    show() {
      listPanel.classList.remove('hidden');
      gizmoMode = 'translate';
      setMediaGizmoMode('translate');
      wireMediaGizmoHandlers();
    },
    hide() {
      listPanel.classList.add('hidden');
      deselectMedia();
    },
    wireGizmoHandlers: wireMediaGizmoHandlers,
    refresh(opts = {}) {
      const fly = Boolean(opts.fly);
      rebuildList();
      if (selectedId != null) {
        const idx = mediaIndexById(selectedId);
        if (idx >= 0) {
          selectMedia(idx, { fly, attach: true });
          return;
        }
      }
      deselectMedia();
    },
    deselect: deselectMedia,
    selectByIndex(index, opts = {}) {
      if (index >= 0 && index < mediaData.length) selectMedia(index, opts);
    },
    getSelectedIndex() {
      return selectedIndex;
    },
  };
}
