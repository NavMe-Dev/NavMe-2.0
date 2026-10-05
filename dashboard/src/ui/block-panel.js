/**
 * Block panel — list/edit navme_blocks; add via 3D map drag (like POIs).
 * Restriction zones only — stair areas live in stairs-panel.js.
 */
import {
  blocksData,
  addBlockWithDb,
  removeBlockFromDb,
  saveBlockToDb,
  refreshBlockGroup,
  setBlocksVisible,
  getBlocksVisible,
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
import { parseDbBool } from '../utils/parse-db-bool.js';
import { iconSave, iconDelete, iconAdd } from './icons.js';
import { askConfirm, isConfirmDialogOpen } from './confirm-dialog.js';
import { t } from '../config/i18n.js';

let selectedBlockId = null;
let blockGizmoMode = 'translate';

function newZoneId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `zone-${crypto.randomUUID()}`;
  }
  return `zone-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param {HTMLElement} container
 * @param {{ onBlocksChange?: () => void, onEnsureBlocksVisible?: () => void }} [options]
 */
export function createBlockPanel(container, options = {}) {
  const onBlocksChange = options.onBlocksChange;
  const onEnsureBlocksVisible = options.onEnsureBlocksVisible;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'block-list-panel';

  listPanel.innerHTML = `
    <div class="zone-panel-header poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${t('blockPanel.title')}</div>
      </div>
      <p class="block-panel-hint">${t('blockPanel.hint')}</p>
    </div>
    <div class="zone-list block-list" id="block-list"></div>
  `;

  container.appendChild(listPanel);

  const editDialog = document.createElement('div');
  editDialog.className = 'poi-add-dialog poi-edit-dialog hidden';
  editDialog.id = 'block-edit-dialog';
  editDialog.setAttribute('role', 'dialog');
  editDialog.setAttribute('aria-modal', 'true');
  editDialog.setAttribute('aria-labelledby', 'block-edit-dialog-title');
  editDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-edit"></div>
    <div class="poi-add-dialog-card poi-edit-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="block-edit-dialog-title">${t('blockPanel.editDialogTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-edit" aria-label="${t('blockPanel.close')}">&times;</button>
      </div>
      <div class="poi-edit-dialog-body">
        <div class="block-coords" id="block-coords">
          <div class="block-detail-fields">
            <div class="media-gizmo-modes block-gizmo-modes">
              <button type="button" class="gizmo-mode-btn active" data-mode="translate">${t('blockPanel.moveMode')}</button>
              <button type="button" class="gizmo-mode-btn" data-mode="scale">${t('blockPanel.resizeMode')}</button>
            </div>
            <div class="coord-group poi-add-field">
              <span class="field-label">${t('blockPanel.zoneNameLabel')}</span>
              <input type="text" id="block-zone-name" />
            </div>
            <div class="coord-inputs block-fields-move" id="block-fields-move">
              <div class="coord-group">
                <span class="field-label field-label--x">${t('blockPanel.fieldX')}</span>
                <input type="number" id="block-x" step="any" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label field-label--y">${t('blockPanel.fieldY')}</span>
                <input type="number" id="block-y" step="any" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label field-label--z">${t('blockPanel.fieldZ')}</span>
                <input type="number" id="block-z" step="any" inputmode="decimal" />
              </div>
            </div>
            <div class="coord-inputs block-fields-size hidden" id="block-fields-size">
              <div class="coord-group">
                <span class="field-label">${t('blockPanel.scaleWidthLabel')}</span>
                <input type="number" id="block-width" step="any" min="0.1" inputmode="decimal" />
              </div>
              <div class="coord-group">
                <span class="field-label">${t('blockPanel.scaleHeightLabel')}</span>
                <input type="number" id="block-depth" step="any" min="0.1" inputmode="decimal" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="poi-add-dialog-actions poi-edit-dialog-actions" id="block-actions-row">
        <button type="button" class="btn-save btn-delete" id="btn-delete-block" title="${t('blockPanel.deleteTitle')}">${iconDelete()}</button>
        <button type="button" class="btn-secondary" data-action="close-edit">${t('blockPanel.cancel')}</button>
        <button type="button" class="btn-save" id="btn-save-block">${iconSave()} ${t('blockPanel.save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(editDialog);

  const addDialog = document.createElement('div');
  addDialog.className = 'poi-add-dialog hidden';
  addDialog.id = 'block-add-dialog';
  addDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close"></div>
    <div class="poi-add-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title">${t('blockPanel.addDialogTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close" aria-label="${t('blockPanel.close')}">&times;</button>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('blockPanel.zoneNameLabel')}</span>
        <input type="text" id="new-block-name" placeholder="${t('blockPanel.blockNamePlaceholder')}" />
      </div>
      <div class="coord-inputs poi-add-coords">
        <div class="coord-group">
          <span class="field-label field-label--x">${t('blockPanel.fieldX')}</span>
          <input type="number" id="new-block-x" step="any" inputmode="decimal" />
        </div>
        <div class="coord-group">
          <span class="field-label field-label--y">${t('blockPanel.fieldY')}</span>
          <input type="number" id="new-block-y" step="any" inputmode="decimal" />
        </div>
        <div class="coord-group">
          <span class="field-label field-label--z">${t('blockPanel.fieldZ')}</span>
          <input type="number" id="new-block-z" step="any" inputmode="decimal" />
        </div>
      </div>
      <div class="coord-inputs poi-add-coords">
        <div class="coord-group">
          <span class="field-label">${t('blockPanel.widthLabel')}</span>
          <input type="number" id="new-block-width" step="any" min="0.1" />
        </div>
        <div class="coord-group">
          <span class="field-label">${t('blockPanel.depthLabel')}</span>
          <input type="number" id="new-block-depth" step="any" min="0.1" />
        </div>
      </div>
      <div class="poi-add-dialog-actions">
        <button type="button" class="btn-secondary" data-action="close">${t('blockPanel.cancel')}</button>
        <button type="button" class="btn-save" id="btn-add-block">${iconAdd()} ${t('blockPanel.addBlockButton')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(addDialog);

  const listEl = listPanel.querySelector('#block-list');
  const moveFields = editDialog.querySelector('#block-fields-move');
  const sizeFields = editDialog.querySelector('#block-fields-size');
  const zoneNameInput = editDialog.querySelector('#block-zone-name');
  const inputX = editDialog.querySelector('#block-x');
  const inputY = editDialog.querySelector('#block-y');
  const inputZ = editDialog.querySelector('#block-z');
  const inputWidth = editDialog.querySelector('#block-width');
  const inputDepth = editDialog.querySelector('#block-depth');
  const btnSave = editDialog.querySelector('#btn-save-block');
  const btnDelete = editDialog.querySelector('#btn-delete-block');

  const newName = addDialog.querySelector('#new-block-name');
  const newX = addDialog.querySelector('#new-block-x');
  const newY = addDialog.querySelector('#new-block-y');
  const newZ = addDialog.querySelector('#new-block-z');
  const newWidth = addDialog.querySelector('#new-block-width');
  const newDepth = addDialog.querySelector('#new-block-depth');

  function restrictionBlocks() {
    return blocksData.filter((block) => !isStairsZone(block));
  }

  function blockFlagsFromBlocked(blocked) {
    return { is_active: true, is_blocked: blocked };
  }

  function isBlockBlocked(block) {
    return parseDbBool(block?.is_blocked, false);
  }

  function buildBlockListItem(block) {
    const item = document.createElement('div');
    item.className = `poi-item zone-list-item${selectedBlockId === block.id ? ' active' : ''}`;

    const label = document.createElement('span');
    label.className = 'zone-item-label';
    label.textContent = `${block.zone_name || block.label || 'Block'} · ${Number(block.width).toFixed(1)}×${Number(block.depth).toFixed(1)}`;

    item.appendChild(label);

    const blocked = isBlockBlocked(block);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `zone-state-btn${blocked ? ' is-blocked' : ' is-open'}`;
    toggle.textContent = blocked ? t('blockPanel.blockedBadge') : t('blockPanel.openBadge');
    toggle.title = blocked ? t('blockPanel.blockedBadgeTitle') : t('blockPanel.openBadgeTitle');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBlockState(block, !blocked);
    });
    item.appendChild(toggle);

    item.addEventListener('click', () => selectBlock(block));
    return item;
  }

  function applyBlockState(blockId, blocked) {
    updateBlockInScene(blockId, blockFlagsFromBlocked(blocked));
    refreshList();
  }

  async function toggleBlockState(block, blocked) {
    applyBlockState(block.id, blocked);
    try {
      await saveBlockToDb(block.id, blockFlagsFromBlocked(blocked));
      onBlocksChange?.();
    } catch (err) {
      alert(err.message || t('blockPanel.errorUpdateStateFailed'));
    }
  }

  function refreshList() {
    const poiType = getPoiType();
    const zones = restrictionBlocks();

    if (!zones.length) {
      listEl.innerHTML = `<div class="zone-loading">${t('blockPanel.emptyList', { poiType: poiType || t('blockPanel.defaultProjectLabel') })}</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const block of zones) {
      listEl.appendChild(buildBlockListItem(block));
    }
  }

  function updateBlockFieldVisibility(mode = blockGizmoMode) {
    blockGizmoMode = mode;
    moveFields?.classList.toggle('hidden', mode !== 'translate');
    sizeFields?.classList.toggle('hidden', mode !== 'scale');
  }

  function setBlockGizmoMode(mode) {
    editDialog.querySelectorAll('.block-gizmo-modes .gizmo-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    setGizmoMode(mode);
    updateBlockFieldVisibility(mode);
  }

  function attachBlockGizmo(blockId) {
    const mesh = getBlockMeshById(blockId);
    if (!mesh) return;
    attachGizmo(mesh);
    setBlockGizmoMode(blockGizmoMode === 'scale' ? 'scale' : 'translate');
  }

  function applyInputsToMesh() {
    if (!selectedBlockId) return;
    updateBlockInScene(selectedBlockId, {
      pos_x: Number(inputX.value) || 0,
      pos_y: Number(inputY.value) || 0,
      pos_z: Number(inputZ.value) || 0,
      width: Math.max(Number(inputWidth.value) || 1, 0.1),
      depth: Math.max(Number(inputDepth.value) || 1, 0.1),
    });
    attachBlockGizmo(selectedBlockId);
  }

  function closeEditDialog() {
    editDialog.classList.add('hidden');
  }

  function openEditDialog() {
    closeAddDialog();
    editDialog.classList.remove('hidden');
  }

  function selectBlock(block) {
    if (isStairsZone(block)) return;
    selectedBlockId = block.id;
    setSelectedBlockId(block.id);
    setBlocksVisible(true);
    onEnsureBlocksVisible?.();
    zoneNameInput.value = block.zone_name || block.label || '';
    inputX.value = Number(block.pos_x ?? 0).toFixed(4);
    inputY.value = Number(block.pos_y ?? 0).toFixed(4);
    inputZ.value = Number(block.pos_z ?? 0).toFixed(4);
    inputWidth.value = Number(block.width ?? 1).toFixed(4);
    inputDepth.value = Number(block.depth ?? 1).toFixed(4);
    setBlockGizmoMode('translate');
    openEditDialog();
    refreshList();
    flyTo(Number(block.pos_x), Number(block.pos_y), Number(block.pos_z), { close: true });
    attachBlockGizmo(block.id);
  }

  function deselect() {
    selectedBlockId = null;
    setSelectedBlockId(null);
    detachGizmo();
    closeEditDialog();
    refreshList();
  }

  function openAddDialog(preset = {}) {
    deselect();
    const name = preset.name ?? `Block ${restrictionBlocks().length + 1}`;
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

  addDialog.querySelector('#btn-add-block')?.addEventListener('click', async () => {
    const zoneName = newName.value.trim() || `Block ${restrictionBlocks().length + 1}`;
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
        ...blockFlagsFromBlocked(true),
        zone_type: 'zone',
      });
      closeAddDialog();
      refreshList();
      onBlocksChange?.();
    } catch (err) {
      alert(err.message || t('blockPanel.errorAddFailed'));
    }
  });

  btnSave?.addEventListener('click', async () => {
    if (!selectedBlockId) return;
    try {
      applyInputsToMesh();
      const row = blocksData.find((b) => b.id === selectedBlockId);
      await saveBlockToDb(selectedBlockId, {
        zone_name: zoneNameInput.value.trim() || 'Block',
        label: zoneNameInput.value.trim() || 'Block',
        pos_x: Number(inputX.value),
        pos_y: Number(inputY.value),
        pos_z: Number(inputZ.value),
        width: Math.max(Number(inputWidth.value), 0.1),
        depth: Math.max(Number(inputDepth.value), 0.1),
        zone_type: row?.zone_type ?? 'zone',
        ...blockFlagsFromBlocked(isBlockBlocked(row)),
      });
      attachBlockGizmo(selectedBlockId);
      refreshList();
      onBlocksChange?.();
    } catch (err) {
      alert(err.message || t('blockPanel.errorSaveFailed'));
    }
  });

  btnDelete?.addEventListener('click', async () => {
    if (!selectedBlockId) return;
    const blockId = selectedBlockId;
    const ok = await askConfirm({
      title: t('blockPanel.confirmDeleteTitle'),
      message: t('blockPanel.confirmDeleteMessage'),
      confirmLabel: t('blockPanel.deleteLabel'),
      cancelLabel: t('blockPanel.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await removeBlockFromDb(blockId);
      deselect();
      onBlocksChange?.();
    } catch (err) {
      alert(err.message || t('blockPanel.errorDeleteFailed'));
    }
  });

  [inputX, inputY, inputZ, inputWidth, inputDepth].forEach((el) => {
    el?.addEventListener('input', () => applyInputsToMesh());
  });

  editDialog.querySelectorAll('.block-gizmo-modes .gizmo-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setBlockGizmoMode(btn.dataset.mode));
  });

  function wireBlockGizmoHandlers() {
    setGizmoDragCallback(() => {
      if (!selectedBlockId) return;
      const mesh = getBlockMeshById(selectedBlockId);
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
      if (!selectedBlockId) return;
      const mesh = getBlockMeshById(selectedBlockId);
      if (mesh) {
        const fields = blockFieldsFromMesh(mesh);
        if (fields) {
          mesh.scale.set(1, 1, 1);
          updateBlockInScene(selectedBlockId, fields);
          inputX.value = fields.pos_x.toFixed(4);
          inputY.value = fields.pos_y.toFixed(4);
          inputZ.value = fields.pos_z.toFixed(4);
          inputWidth.value = fields.width.toFixed(4);
          inputDepth.value = fields.depth.toFixed(4);
        }
      }
      try {
        await saveBlockToDb(selectedBlockId, {
          pos_x: Number(inputX.value),
          pos_y: Number(inputY.value),
          pos_z: Number(inputZ.value),
          width: Math.max(Number(inputWidth.value), 0.1),
          depth: Math.max(Number(inputDepth.value), 0.1),
        });
        attachBlockGizmo(selectedBlockId);
      } catch (err) {
        console.error('[block-panel] save after gizmo:', err);
      }
    });
  }

  wireBlockGizmoHandlers();

  return {
    element: listPanel,
    show() {
      listPanel.classList.remove('hidden');
      wireBlockGizmoHandlers();
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
    deselect,
    selectById(id) {
      const block = blocksData.find((b) => b.id === id && !isStairsZone(b));
      if (block) selectBlock(block);
    },
    getSelectedId() {
      return selectedBlockId;
    },
    wireGizmoHandlers: wireBlockGizmoHandlers,
    setBlocksLayerVisible(visible) {
      setBlocksVisible(visible);
      refreshBlockGroup(getMultisetAnchor());
    },
    getBlocksLayerVisible: getBlocksVisible,
  };
}
