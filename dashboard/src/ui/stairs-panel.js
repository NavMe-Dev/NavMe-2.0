/**
 * Stairs panel — wheelchair accessibility zones only (separate from block restrictions).
 */
import {
  blocksData,
  addBlockWithDb,
  removeBlockFromDb,
  saveBlockToDb,
  refreshBlockGroup,
  setBlocksVisible,
  getBlockMeshById,
  blockFieldsFromMesh,
  updateBlockInScene,
  setSelectedBlockId,
  isStairsZone,
} from '../ar/blocks.js';
import {
  getMultisetAnchor,
  flyTo,
  attachGizmo,
  detachGizmo,
  setGizmoMode,
  setGizmoDragCallback,
  setGizmoDragEndCallback,
} from '../ar/scene.js';
import { getPoiType } from '../config/poi-session.js';
import { iconSave, iconDelete, iconAdd } from './icons.js';
import { askConfirm, isConfirmDialogOpen } from './confirm-dialog.js';
import { t } from '../config/i18n.js';

let selectedStairsId = null;
let stairsGizmoMode = 'translate';

function newZoneId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `zone-${crypto.randomUUID()}`;
  }
  return `zone-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function stairsBlocks() {
  return blocksData.filter((block) => isStairsZone(block));
}

function stairsBlockFlags() {
  return { is_active: true, is_blocked: false };
}

/**
 * @param {HTMLElement} container
 * @param {{ onStairsChange?: () => void, onEnsureStairsVisible?: () => void, onStartDrawOnMap?: () => void }} [options]
 */
export function createStairsPanel(container, options = {}) {
  const onStairsChange = options.onStairsChange;
  const onEnsureStairsVisible = options.onEnsureStairsVisible;
  const onStartDrawOnMap = options.onStartDrawOnMap;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'stairs-list-panel';

  listPanel.innerHTML = `
    <div class="zone-panel-header poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${t('stairsPanel.title')}</div>
      </div>
      <p class="block-panel-hint">${t('stairsPanel.hint')}</p>
      <button type="button" class="btn-save stairs-add-btn" id="btn-add-stairs-on-map">${iconAdd()} ${t('stairsPanel.markOnMapButton')}</button>
    </div>
    <div class="zone-list block-list" id="stairs-list"></div>
  `;

  container.appendChild(listPanel);

  const editDialog = document.createElement('div');
  editDialog.className = 'poi-add-dialog poi-edit-dialog hidden';
  editDialog.id = 'stairs-edit-dialog';
  editDialog.setAttribute('role', 'dialog');
  editDialog.setAttribute('aria-modal', 'true');
  editDialog.setAttribute('aria-labelledby', 'stairs-edit-dialog-title');
  editDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-edit"></div>
    <div class="poi-add-dialog-card poi-edit-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="stairs-edit-dialog-title">${t('stairsPanel.editDialogTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-edit" aria-label="${t('stairsPanel.close')}">&times;</button>
      </div>
      <div class="poi-edit-dialog-body">
        <div class="block-coords" id="stairs-coords">
          <div class="block-detail-fields">
            <div class="media-gizmo-modes block-gizmo-modes">
              <button type="button" class="gizmo-mode-btn active" data-mode="translate">${t('stairsPanel.moveMode')}</button>
              <button type="button" class="gizmo-mode-btn" data-mode="scale">${t('stairsPanel.resizeMode')}</button>
            </div>
            <div class="coord-group poi-add-field">
              <span class="field-label">${t('stairsPanel.markerNameLabel')}</span>
              <input type="text" id="stairs-zone-name" />
            </div>
            <div class="coord-inputs block-fields-move" id="stairs-fields-move">
              <div class="coord-group">
                <span class="field-label field-label--x">${t('stairsPanel.fieldX')}</span>
                <input type="number" id="stairs-x" step="any" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label field-label--y">${t('stairsPanel.fieldY')}</span>
                <input type="number" id="stairs-y" step="any" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label field-label--z">${t('stairsPanel.fieldZ')}</span>
                <input type="number" id="stairs-z" step="any" inputmode="decimal" />
              </div>
            </div>
            <div class="coord-inputs block-fields-size hidden" id="stairs-fields-size">
              <div class="coord-group">
                <span class="field-label">${t('stairsPanel.scaleWidthLabel')}</span>
                <input type="number" id="stairs-width" step="any" min="0.1" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label">${t('stairsPanel.scaleHeightLabel')}</span>
                <input type="number" id="stairs-depth" step="any" min="0.1" inputmode="decimal" />
              </div>
            </div>
            <p class="block-stairs-edit-note poi-add-field">${t('stairsPanel.alwaysOpenNote')}</p>
          </div>
        </div>
      </div>
      <div class="poi-add-dialog-actions poi-edit-dialog-actions" id="stairs-actions-row">
        <button type="button" class="btn-save btn-delete" id="btn-delete-stairs" title="${t('stairsPanel.deleteTitle')}">${iconDelete()}</button>
        <button type="button" class="btn-secondary" data-action="close-edit">${t('stairsPanel.cancel')}</button>
        <button type="button" class="btn-save" id="btn-save-stairs">${iconSave()} ${t('stairsPanel.save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(editDialog);

  const addDialog = document.createElement('div');
  addDialog.className = 'poi-add-dialog hidden';
  addDialog.id = 'stairs-add-dialog';
  addDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close"></div>
    <div class="poi-add-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title">${t('stairsPanel.addDialogTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close" aria-label="${t('stairsPanel.close')}">&times;</button>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('stairsPanel.markerNameLabel')}</span>
        <input type="text" id="new-stairs-name" placeholder="${t('stairsPanel.markerNamePlaceholder')}" />
      </div>
      <div class="coord-inputs poi-add-coords">
        <div class="coord-group">
          <span class="field-label field-label--x">${t('stairsPanel.fieldX')}</span>
          <input type="number" id="new-stairs-x" step="any" inputmode="decimal" />
        </div>
        <div class="coord-group">
          <span class="field-label field-label--y">${t('stairsPanel.fieldY')}</span>
          <input type="number" id="new-stairs-y" step="any" inputmode="decimal" />
        </div>
        <div class="coord-group">
          <span class="field-label field-label--z">${t('stairsPanel.fieldZ')}</span>
          <input type="number" id="new-stairs-z" step="any" inputmode="decimal" />
        </div>
      </div>
      <div class="coord-inputs poi-add-coords">
        <div class="coord-group">
          <span class="field-label">${t('stairsPanel.widthLabel')}</span>
          <input type="number" id="new-stairs-width" step="any" min="0.1" />
        </div>
        <div class="coord-group">
          <span class="field-label">${t('stairsPanel.depthLabel')}</span>
          <input type="number" id="new-stairs-depth" step="any" min="0.1" />
        </div>
      </div>
      <div class="poi-add-dialog-actions">
        <button type="button" class="btn-secondary" data-action="close">${t('stairsPanel.cancel')}</button>
        <button type="button" class="btn-save" id="btn-add-stairs">${iconAdd()} ${t('stairsPanel.addStairMarker')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(addDialog);

  const listEl = listPanel.querySelector('#stairs-list');
  const moveFields = editDialog.querySelector('#stairs-fields-move');
  const sizeFields = editDialog.querySelector('#stairs-fields-size');
  const zoneNameInput = editDialog.querySelector('#stairs-zone-name');
  const inputX = editDialog.querySelector('#stairs-x');
  const inputY = editDialog.querySelector('#stairs-y');
  const inputZ = editDialog.querySelector('#stairs-z');
  const inputWidth = editDialog.querySelector('#stairs-width');
  const inputDepth = editDialog.querySelector('#stairs-depth');
  const btnSave = editDialog.querySelector('#btn-save-stairs');
  const btnDelete = editDialog.querySelector('#btn-delete-stairs');

  const newName = addDialog.querySelector('#new-stairs-name');
  const newX = addDialog.querySelector('#new-stairs-x');
  const newY = addDialog.querySelector('#new-stairs-y');
  const newZ = addDialog.querySelector('#new-stairs-z');
  const newWidth = addDialog.querySelector('#new-stairs-width');
  const newDepth = addDialog.querySelector('#new-stairs-depth');

  function buildListItem(block) {
    const item = document.createElement('div');
    item.className = `poi-item zone-list-item${selectedStairsId === block.id ? ' active' : ''}`;

    const label = document.createElement('span');
    label.className = 'zone-item-label';
    label.textContent = `${block.zone_name || block.label || 'Stairs'} · ${Number(block.width).toFixed(1)}×${Number(block.depth).toFixed(1)}`;
    item.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'zone-state-btn is-open zone-state-btn--fixed';
    badge.textContent = t('stairsPanel.openBadge');
    badge.title = t('stairsPanel.openBadgeTitle');
    item.appendChild(badge);

    item.addEventListener('click', () => selectStairs(block));
    return item;
  }

  function refreshList() {
    const poiType = getPoiType();
    const stairs = stairsBlocks();

    if (!stairs.length) {
      listEl.innerHTML = `<div class="zone-loading">${t('stairsPanel.emptyList', { poiType: poiType || t('stairsPanel.defaultProjectLabel') })}</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const block of stairs) {
      listEl.appendChild(buildListItem(block));
    }
  }

  function updateFieldVisibility(mode = stairsGizmoMode) {
    stairsGizmoMode = mode;
    moveFields?.classList.toggle('hidden', mode !== 'translate');
    sizeFields?.classList.toggle('hidden', mode !== 'scale');
  }

  function setStairsGizmoMode(mode) {
    editDialog.querySelectorAll('.block-gizmo-modes .gizmo-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    setGizmoMode(mode);
    updateFieldVisibility(mode);
  }

  function attachStairsGizmo(blockId) {
    const mesh = getBlockMeshById(blockId);
    if (!mesh) return;
    attachGizmo(mesh);
    setStairsGizmoMode(stairsGizmoMode === 'scale' ? 'scale' : 'translate');
  }

  function applyInputsToMesh() {
    if (!selectedStairsId) return;
    updateBlockInScene(selectedStairsId, {
      pos_x: Number(inputX.value) || 0,
      pos_y: Number(inputY.value) || 0,
      pos_z: Number(inputZ.value) || 0,
      width: Math.max(Number(inputWidth.value) || 1, 0.1),
      depth: Math.max(Number(inputDepth.value) || 1, 0.1),
    });
    attachStairsGizmo(selectedStairsId);
  }

  function closeEditDialog() {
    editDialog.classList.add('hidden');
  }

  function openEditDialog() {
    closeAddDialog();
    editDialog.classList.remove('hidden');
  }

  function selectStairs(block) {
    if (!isStairsZone(block)) return;
    selectedStairsId = block.id;
    setSelectedBlockId(block.id);
    setBlocksVisible(true);
    onEnsureStairsVisible?.();
    zoneNameInput.value = block.zone_name || block.label || '';
    inputX.value = Number(block.pos_x ?? 0).toFixed(4);
    inputY.value = Number(block.pos_y ?? 0).toFixed(4);
    inputZ.value = Number(block.pos_z ?? 0).toFixed(4);
    inputWidth.value = Number(block.width ?? 1).toFixed(4);
    inputDepth.value = Number(block.depth ?? 1).toFixed(4);
    setStairsGizmoMode('translate');
    openEditDialog();
    refreshList();
    flyTo(Number(block.pos_x), Number(block.pos_y), Number(block.pos_z), { close: true });
    attachStairsGizmo(block.id);
  }

  function deselect() {
    selectedStairsId = null;
    setSelectedBlockId(null);
    detachGizmo();
    closeEditDialog();
    refreshList();
  }

  function openAddDialog(preset = {}) {
    deselect();
    const name = preset.name ?? `Stairs ${stairsBlocks().length + 1}`;
    newName.value = name;
    newX.value = Number(preset.pos_x ?? preset.x ?? 0).toFixed(4);
    newY.value = Number(preset.pos_y ?? preset.y ?? 0).toFixed(4);
    newZ.value = Number(preset.pos_z ?? preset.z ?? 0).toFixed(4);
    newWidth.value = Number(preset.width ?? 1).toFixed(4);
    newDepth.value = Number(preset.depth ?? 1).toFixed(4);
    addDialog.classList.remove('hidden');
    requestAnimationFrame(() => newName.focus());
  }

  function closeAddDialog() {
    addDialog.classList.add('hidden');
  }

  async function quickAddStairsBlock(preset = {}) {
    const zoneName = `Stairs ${stairsBlocks().length + 1}`;
    await addBlockWithDb({
      zone_id: newZoneId(),
      zone_name: zoneName,
      label: zoneName,
      pos_x: Number(preset.pos_x ?? preset.x ?? 0),
      pos_y: Number(preset.pos_y ?? preset.y ?? 0),
      pos_z: Number(preset.pos_z ?? preset.z ?? 0),
      width: Math.max(Number(preset.width ?? 1), 0.1),
      depth: Math.max(Number(preset.depth ?? 1), 0.1),
      ...stairsBlockFlags(),
      zone_type: 'stairs',
    });
    refreshList();
    onStairsChange?.();
  }

  listPanel.querySelector('#btn-add-stairs-on-map')?.addEventListener('click', () => {
    onStartDrawOnMap?.();
  });

  addDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close"]')) closeAddDialog();
  });

  editDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) deselect();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isConfirmDialogOpen()) return;
    if (!addDialog.classList.contains('hidden')) {
      closeAddDialog();
      return;
    }
    if (!editDialog.classList.contains('hidden')) deselect();
  });

  addDialog.querySelector('#btn-add-stairs')?.addEventListener('click', async () => {
    const zoneName = newName.value.trim() || `Stairs ${stairsBlocks().length + 1}`;
    try {
      await addBlockWithDb({
        zone_id: newZoneId(),
        zone_name: zoneName,
        label: zoneName,
        pos_x: Number(newX.value),
        pos_y: Number(newY.value),
        pos_z: Number(newZ.value),
        width: Math.max(Number(newWidth.value), 0.1),
        depth: Math.max(Number(newDepth.value), 0.1),
        ...stairsBlockFlags(),
        zone_type: 'stairs',
      });
      closeAddDialog();
      refreshList();
      onStairsChange?.();
    } catch (err) {
      alert(err.message || t('stairsPanel.errorAddFailed'));
    }
  });

  btnSave?.addEventListener('click', async () => {
    if (!selectedStairsId) return;
    try {
      applyInputsToMesh();
      await saveBlockToDb(selectedStairsId, {
        zone_name: zoneNameInput.value.trim() || 'Stairs',
        label: zoneNameInput.value.trim() || 'Stairs',
        pos_x: Number(inputX.value),
        pos_y: Number(inputY.value),
        pos_z: Number(inputZ.value),
        width: Math.max(Number(inputWidth.value), 0.1),
        depth: Math.max(Number(inputDepth.value), 0.1),
        zone_type: 'stairs',
        ...stairsBlockFlags(),
      });
      attachStairsGizmo(selectedStairsId);
      refreshList();
      onStairsChange?.();
    } catch (err) {
      alert(err.message || t('stairsPanel.errorSaveFailed'));
    }
  });

  btnDelete?.addEventListener('click', async () => {
    if (!selectedStairsId) return;
    const stairsId = selectedStairsId;
    const ok = await askConfirm({
      title: t('stairsPanel.confirmDeleteTitle'),
      message: t('stairsPanel.confirmDeleteMessage'),
      confirmLabel: t('stairsPanel.deleteLabel'),
      cancelLabel: t('stairsPanel.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await removeBlockFromDb(stairsId);
      deselect();
      onStairsChange?.();
    } catch (err) {
      alert(err.message || t('stairsPanel.errorDeleteFailed'));
    }
  });

  [inputX, inputY, inputZ, inputWidth, inputDepth].forEach((el) => {
    el?.addEventListener('input', () => applyInputsToMesh());
  });

  editDialog.querySelectorAll('.block-gizmo-modes .gizmo-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setStairsGizmoMode(btn.dataset.mode));
  });

  function wireGizmoHandlers() {
    setGizmoDragCallback(() => {
      if (!selectedStairsId) return;
      const mesh = getBlockMeshById(selectedStairsId);
      if (!mesh) return;
      const fields = blockFieldsFromMesh(mesh);
      if (!fields) return;
      inputX.value = fields.pos_x.toFixed(4);
      inputY.value = fields.pos_y.toFixed(4);
      inputZ.value = fields.pos_z.toFixed(4);
      inputWidth.value = fields.width.toFixed(4);
      inputDepth.value = fields.depth.toFixed(4);
    });

    setGizmoDragEndCallback(async () => {
      if (!selectedStairsId) return;
      const mesh = getBlockMeshById(selectedStairsId);
      if (mesh) {
        const fields = blockFieldsFromMesh(mesh);
        if (fields) {
          mesh.scale.set(1, 1, 1);
          updateBlockInScene(selectedStairsId, fields);
          inputX.value = fields.pos_x.toFixed(4);
          inputY.value = fields.pos_y.toFixed(4);
          inputZ.value = fields.pos_z.toFixed(4);
          inputWidth.value = fields.width.toFixed(4);
          inputDepth.value = fields.depth.toFixed(4);
        }
      }
      try {
        await saveBlockToDb(selectedStairsId, {
          pos_x: Number(inputX.value),
          pos_y: Number(inputY.value),
          pos_z: Number(inputZ.value),
          width: Math.max(Number(inputWidth.value), 0.1),
          depth: Math.max(Number(inputDepth.value), 0.1),
        });
        attachStairsGizmo(selectedStairsId);
      } catch (err) {
        console.error('[stairs-panel] save after gizmo:', err);
      }
    });
  }

  wireGizmoHandlers();

  return {
    element: listPanel,
    show() {
      listPanel.classList.remove('hidden');
      wireGizmoHandlers();
      refreshBlockGroup(getMultisetAnchor());
      refreshList();
    },
    hide() {
      listPanel.classList.add('hidden');
      closeAddDialog();
      deselect();
    },
    refresh: refreshList,
    openAddDialog,
    quickAddStairsBlock,
    deselect,
    selectById(id) {
      const block = blocksData.find((b) => b.id === id && isStairsZone(b));
      if (block) selectStairs(block);
    },
    getSelectedId() {
      return selectedStairsId;
    },
    wireGizmoHandlers,
  };
}
