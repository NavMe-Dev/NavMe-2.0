/**
 * Treasure Hunt admin panel — Levels, Treasures, Tasks/Tokens, Cheats, Players.
 * Split list + edit pattern (mirrors Media/POI), glass theme.
 */

import {
  fetchTreasureLevels,
  insertTreasureLevel,
  updateTreasureLevel,
  deleteTreasureLevel,
  fetchTreasureItems,
  insertTreasureItem,
  updateTreasureItem,
  deleteTreasureItem,
  fetchTreasureTasks,
  insertTreasureTask,
  updateTreasureTask,
  deleteTreasureTask,
  fetchTreasureTaskTokens,
  insertTreasureTaskToken,
  updateTreasureTaskToken,
  deleteTreasureTaskToken,
  fetchTreasureCheats,
  insertTreasureCheat,
  updateTreasureCheat,
  deleteTreasureCheat,
  fetchTreasureProgressSummary,
} from '../services/treasure-api.js';
import { uploadProjectMedia } from '../services/media-storage.js';
import { classifyMediaFile } from '../utils/media-files.js';
import { getPoiType } from '../config/poi-session.js';
import {
  treasureData,
  hydrateTreasuresFromSupabase,
  upsertTreasureLocal,
  remountTreasureItem,
  updateTreasureTransform,
  updateHintTransform,
  deleteTreasureFromScene,
  getTreasureObjects,
  refreshTreasureGroup,
} from '../ar/treasure.js';
import {
  flyTo,
  attachGizmo,
  detachGizmo,
  setGizmoDragCallback,
  setGizmoDragEndCallback,
  setGizmoMode,
  getMultisetAnchor,
} from '../ar/scene.js';
import { createArBillboardPngFile } from '../utils/ar-billboard.js';
import { showToast } from './toast.js';
import { askConfirm } from './confirm-dialog.js';
import { iconSave, iconDelete, iconAdd } from './icons.js';
import { t } from '../config/i18n.js';

const TABS = [
  { id: 'levels', label: t('treasurePanel.tabLevels') },
  { id: 'items', label: t('treasurePanel.tabTreasures') },
  { id: 'tasks', label: t('treasurePanel.tabTasks') },
  { id: 'cheats', label: t('treasurePanel.tabCheats') },
  { id: 'players', label: t('treasurePanel.tabPlayers') },
];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   onTreasureChange?: () => void,
 *   onStartPlaceTreasure?: () => void,
 *   onStartPlaceTaskDest?: () => void,
 *   onStartPlaceToken?: () => void,
 *   onStartPlaceHint?: () => void,
 * }} [options]
 */
export function createTreasurePanel(container, options = {}) {
  const onTreasureChange = options.onTreasureChange;
  const onStartPlaceTreasure = options.onStartPlaceTreasure;
  const onStartPlaceTaskDest = options.onStartPlaceTaskDest;
  const onStartPlaceToken = options.onStartPlaceToken;
  const onStartPlaceHint = options.onStartPlaceHint;

  /** @type {'levels'|'items'|'tasks'|'cheats'|'players'} */
  let activeTab = 'items';
  let levels = [];
  let items = [];
  let tasks = [];
  let tokens = [];
  let cheats = [];
  let progressSummary = { players: [], progress: [], collections: [], levels: [] };

  let selectedItemIndex = -1;
  let selectedTaskId = null;
  let selectedTokenId = null;
  /** Treasure id targeted while placing a hint on the map (survives panel deselect). */
  let hintPlaceTreasureId = null;
  let gizmoMode = 'translate';
  /** @type {'item'|'hint'|'token'|null} */
  let gizmoTarget = null;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'treasure-list-panel';

  listPanel.innerHTML = `
    <div class="media-panel-header poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${t('treasurePanel.panelTitle')}</div>
      </div>
      <div class="treasure-tabs" role="tablist" aria-label="${t('treasurePanel.tabsAriaLabel')}">
        ${TABS.map(
          (tab) =>
            `<button type="button" class="treasure-tab${tab.id === activeTab ? ' active' : ''}" data-tab="${tab.id}" role="tab">${tab.label}</button>`,
        ).join('')}
      </div>
      <div class="treasure-toolbar">
        <button type="button" class="btn-save btn-save--compact" id="treasure-btn-add">${iconAdd()} ${t('treasurePanel.addButton')}</button>
        <button type="button" class="btn-secondary btn-save--compact hidden" id="treasure-btn-place">${t('treasurePanel.placeOnMap')}</button>
      </div>
    </div>
    <div class="media-list poi-list" id="treasure-list"></div>
  `;

  container.appendChild(listPanel);

  const editDialog = document.createElement('div');
  editDialog.className = 'poi-add-dialog poi-edit-dialog hidden';
  editDialog.id = 'treasure-edit-dialog';
  editDialog.setAttribute('role', 'dialog');
  editDialog.setAttribute('aria-modal', 'true');
  editDialog.setAttribute('aria-labelledby', 'treasure-edit-title');
  editDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-edit"></div>
    <div class="poi-add-dialog-card poi-edit-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="treasure-edit-title">${t('treasurePanel.editDefaultTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-edit" aria-label="${t('treasurePanel.closeAriaLabel')}">&times;</button>
      </div>
      <div class="poi-edit-dialog-body">
        <div class="treasure-edit-body" id="treasure-edit-body"></div>
      </div>
      <div class="poi-add-dialog-actions poi-edit-dialog-actions treasure-actions-body" id="treasure-actions-body"></div>
    </div>
  `;
  document.body.appendChild(editDialog);

  const listEl = listPanel.querySelector('#treasure-list');
  const editBody = editDialog.querySelector('#treasure-edit-body');
  const actionsBody = editDialog.querySelector('#treasure-actions-body');
  const editTitle = editDialog.querySelector('#treasure-edit-title');
  const btnAdd = listPanel.querySelector('#treasure-btn-add');
  const btnPlace = listPanel.querySelector('#treasure-btn-place');

  function closeEditDialog() {
    editDialog.classList.add('hidden');
  }

  function openEditDialog() {
    editDialog.classList.remove('hidden');
  }

  function relocateActions() {
    actionsBody.innerHTML = '';
    const row = editBody.querySelector('.poi-actions-row');
    if (row) {
      // Normalize action row for dialog footer
      row.classList.add('poi-edit-dialog-actions');
      actionsBody.appendChild(row);
    }
    openEditDialog();
  }

  function clearEditor() {
    editBody.innerHTML = '';
    actionsBody.innerHTML = '';
    editTitle.textContent = t('treasurePanel.editDefaultTitle');
    closeEditDialog();
  }

  function levelLabel(levelId) {
    const lvl = levels.find((l) => String(l.id) === String(levelId));
    return lvl ? `L${lvl.level_number} · ${lvl.title}` : t('treasurePanel.noLevelOption');
  }

  function setTab(tabId) {
    activeTab = TABS.some((t) => t.id === tabId) ? tabId : 'items';
    listPanel.querySelectorAll('.treasure-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });
    selectedItemIndex = -1;
    selectedTaskId = null;
    selectedTokenId = null;
    gizmoTarget = null;
    detachGizmo();
    clearEditor();
    syncToolbar();
    rebuildList();
  }

  function syncToolbar() {
    const placeable = activeTab === 'items' || activeTab === 'tasks';
    btnPlace.classList.toggle('hidden', !placeable);
    btnPlace.textContent =
      activeTab === 'tasks' ? t('treasurePanel.placeDestination') : t('treasurePanel.placeTreasure');
    btnAdd.classList.toggle('hidden', activeTab === 'players');
  }

  async function reloadAll() {
    const [lv, it, tk, ch] = await Promise.all([
      fetchTreasureLevels(),
      fetchTreasureItems(),
      fetchTreasureTasks(),
      fetchTreasureCheats(),
    ]);
    levels = lv;
    items = it;
    tasks = tk;
    cheats = ch;
    tokens = await fetchTreasureTaskTokens();
    await hydrateTreasuresFromSupabase();
    const anchor = getMultisetAnchor();
    if (anchor) await refreshTreasureGroup(anchor);
    if (activeTab === 'players') {
      progressSummary = await fetchTreasureProgressSummary();
    }
    rebuildList();
    onTreasureChange?.();
  }

  function rebuildList() {
    listEl.innerHTML = '';
    if (activeTab === 'levels') {
      levels.forEach((row) => {
        const el = document.createElement('div');
        el.className = 'poi-item media-item';
        el.innerHTML = `<span class="media-item-label">L${row.level_number} · ${escapeHtml(row.title)}${row.is_active ? '' : ' (off)'}</span>`;
        el.addEventListener('click', () => openLevelEditor(row));
        listEl.appendChild(el);
      });
      if (!levels.length) listEl.innerHTML = `<p class="treasure-empty-hint">${t('treasurePanel.noLevelsYet')}</p>`;
      return;
    }

    if (activeTab === 'items') {
      items.forEach((row, index) => {
        const el = document.createElement('div');
        el.className = 'poi-item media-item';
        if (selectedItemIndex >= 0 && String(items[selectedItemIndex]?.id) === String(row.id)) {
          el.classList.add('active');
        }
        el.innerHTML = `<span class="media-item-label">${escapeHtml(row.name)} <span class="treasure-meta">${escapeHtml(levelLabel(row.level_id))}</span></span>`;
        el.addEventListener('click', () => selectTreasureItem(index));
        listEl.appendChild(el);
      });
      if (!items.length) listEl.innerHTML = `<p class="treasure-empty-hint">${t('treasurePanel.noTreasuresYet')}</p>`;
      return;
    }

    if (activeTab === 'tasks') {
      tasks.forEach((row) => {
        const el = document.createElement('div');
        el.className = 'poi-item media-item';
        if (String(selectedTaskId) === String(row.id)) el.classList.add('active');
        el.innerHTML = `<span class="media-item-label">${escapeHtml(row.title)} <span class="treasure-meta">${escapeHtml(levelLabel(row.level_id))}</span></span>`;
        el.addEventListener('click', () => openTaskEditor(row));
        listEl.appendChild(el);
      });
      if (!tasks.length) listEl.innerHTML = `<p class="treasure-empty-hint">${t('treasurePanel.noTasksYet')}</p>`;
      return;
    }

    if (activeTab === 'cheats') {
      cheats.forEach((row) => {
        const el = document.createElement('div');
        el.className = 'poi-item media-item';
        el.innerHTML = `<span class="media-item-label">${escapeHtml(row.title)}</span>`;
        el.addEventListener('click', () => openCheatEditor(row));
        listEl.appendChild(el);
      });
      if (!cheats.length) listEl.innerHTML = `<p class="treasure-empty-hint">${t('treasurePanel.noCheatsYet')}</p>`;
      return;
    }

    // players
    const { players, progress, levels: progLevels } = progressSummary;
    players.forEach((p) => {
      const prog = progress.filter((r) => String(r.player_id) === String(p.id));
      const summary = prog
        .map((r) => {
          const lvl = progLevels.find((l) => String(l.id) === String(r.level_id));
          return `${lvl ? `L${lvl.level_number}` : t('treasurePanel.unknownLevelAbbrev')} ${r.status} (${r.collected_count})`;
        })
        .join(' · ');
      const el = document.createElement('div');
      el.className = 'poi-item media-item';
      el.innerHTML = `<span class="media-item-label">${escapeHtml(p.display_name || p.email || p.id)}<br><span class="treasure-meta">${escapeHtml(summary || t('treasurePanel.noProgress'))}</span></span>`;
      el.addEventListener('click', () => {
        editTitle.textContent = t('treasurePanel.playerTitle');
        editBody.innerHTML = `
          <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.playerFieldName')}</span><div>${escapeHtml(p.display_name)}</div></div>
          <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.playerFieldEmail')}</span><div>${escapeHtml(p.email || t('treasurePanel.emptyValueDash'))}</div></div>
          <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.playerFieldProgress')}</span><div>${escapeHtml(summary || t('treasurePanel.emptyValueDash'))}</div></div>
          <p class="media-modal-hint">${t('treasurePanel.playerReadOnlyHint')}</p>
        `;
        actionsBody.innerHTML = '';
      });
      listEl.appendChild(el);
    });
    if (!players.length) listEl.innerHTML = `<p class="treasure-empty-hint">${t('treasurePanel.noPlayersYet')}</p>`;
  }

  function levelOptionsHtml(selectedId) {
    return levels
      .map(
        (l) =>
          `<option value="${l.id}" ${String(l.id) === String(selectedId) ? 'selected' : ''}>L${l.level_number} · ${escapeHtml(l.title)}</option>`,
      )
      .join('');
  }

  function openLevelEditor(row = null) {
    const isNew = !row?.id;
    editTitle.textContent = isNew ? t('treasurePanel.addLevelTitle') : t('treasurePanel.editLevelTitle');
    editBody.innerHTML = `
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.levelNumberLabel')}</span>
        <input type="number" id="tl-number" min="1" step="1" value="${row?.level_number ?? levels.length + 1}" /></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.titleLabel')}</span>
        <input type="text" id="tl-title" value="${escapeHtml(row?.title ?? '')}" placeholder="${t('treasurePanel.levelTitlePlaceholder')}" /></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.treasuresRequiredLabel')}</span>
        <input type="number" id="tl-required" min="1" step="1" value="${row?.treasures_required ?? 1}" /></div>
      <label class="treasure-check"><input type="checkbox" id="tl-active" ${row?.is_active !== false ? 'checked' : ''}/> ${t('treasurePanel.activeLabel')}</label>
      <div class="poi-actions-row media-panel-save-row">
        <button type="button" class="btn-save" id="tl-save"><span class="icon">${iconSave()}</span> ${t('treasurePanel.saveButton')}</button>
        ${isNew ? '' : `<button type="button" class="btn-save btn-delete" id="tl-delete" title="${t('treasurePanel.deleteTitle')}">${iconDelete()}</button>`}
      </div>
    `;
    editBody.querySelector('#tl-save').addEventListener('click', async () => {
      try {
        const payload = {
          level_number: Number(editBody.querySelector('#tl-number').value) || 1,
          title: editBody.querySelector('#tl-title').value.trim(),
          treasures_required: Number(editBody.querySelector('#tl-required').value) || 1,
          sort_order: Number(editBody.querySelector('#tl-number').value) || 1,
          is_active: editBody.querySelector('#tl-active').checked,
        };
        if (isNew) await insertTreasureLevel(payload);
        else await updateTreasureLevel(row.id, payload);
        showToast(t('treasurePanel.levelSavedToast'), 'success');
        await reloadAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    editBody.querySelector('#tl-delete')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: t('treasurePanel.confirmDeleteLevelTitle'),
        message: t('treasurePanel.confirmDeleteLevelMessage', { title: row.title }),
        confirmLabel: t('treasurePanel.confirmDeleteLabel'),
        cancelLabel: t('treasurePanel.cancelLabel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteTreasureLevel(row.id);
        showToast(t('treasurePanel.levelDeletedToast'), 'success');
        await reloadAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    relocateActions();
  }

  function selectTreasureItem(index) {
    selectedItemIndex = index;
    gizmoTarget = 'item';
    const row = items[index];
    if (!row) return;
    rebuildList();
    openItemEditor(row);
    const sceneIdx = treasureData.findIndex((t) => String(t.id) === String(row.id));
    if (sceneIdx >= 0) {
      const item = treasureData[sceneIdx];
      flyTo(item.pos_x, item.pos_y, item.pos_z);
      attachTreasureOrHintGizmo(sceneIdx, 'item');
    }
  }

  function attachTreasureOrHintGizmo(sceneIdx, target) {
    gizmoTarget = target;
    const objs = getTreasureObjects();
    const entry = objs[sceneIdx];
    if (!entry) return;
    const item = treasureData[sceneIdx];
    const obj = target === 'hint' ? entry.hintRoot : entry.root;
    if (!obj) {
      detachGizmo();
      showToast(target === 'hint' ? t('treasurePanel.errHintNotInScene') : t('treasurePanel.errTreasureNotInScene'), 'error');
      return;
    }
    if (item) {
      if (target === 'hint') flyTo(item.hint_x, item.hint_y, item.hint_z);
      else flyTo(item.pos_x, item.pos_y, item.pos_z);
    }
    gizmoMode = 'translate';
    setGizmoMode('translate');
    editBody.querySelectorAll('.gizmo-mode-btn[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === 'translate');
    });
    attachGizmo(obj);
    wireItemGizmo(sceneIdx);
    editBody.querySelectorAll('[data-gizmo-target]').forEach((b) => {
      b.classList.toggle('active', b.dataset.gizmoTarget === target);
    });
    syncTransformSectionHighlight();
  }

  function syncTransformSectionHighlight() {
    editBody.querySelector('#ti-transform-block')?.classList.toggle('treasure-transform-active', gizmoTarget === 'item');
    editBody.querySelector('#th-transform-block')?.classList.toggle('treasure-transform-active', gizmoTarget === 'hint');
  }

  function setTreasureGizmoMode(mode) {
    gizmoMode = mode;
    editBody.querySelectorAll('.gizmo-mode-btn[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    setGizmoMode(mode);
  }

  function wireItemGizmo(sceneIdx) {
    setGizmoDragCallback((transform) => {
      if ((gizmoTarget !== 'item' && gizmoTarget !== 'hint') || sceneIdx < 0) return;
      const pos = transform.position;
      const rot = transform.rotation;
      const scl = transform.scale;
      if (gizmoTarget === 'hint') {
        updateHintTransform(sceneIdx, {
          hint_x: pos.x,
          hint_y: pos.y,
          hint_z: pos.z,
          hint_rot_x: rot.x,
          hint_rot_y: rot.y,
          hint_rot_z: rot.z,
          hint_scale_x: scl.x,
          hint_scale_y: scl.y,
          hint_scale_z: scl.z,
        });
        const x = editBody.querySelector('#th-x');
        const y = editBody.querySelector('#th-y');
        const z = editBody.querySelector('#th-z');
        const rx = editBody.querySelector('#th-rotx');
        const ry = editBody.querySelector('#th-roty');
        const rz = editBody.querySelector('#th-rotz');
        const sx = editBody.querySelector('#th-sx');
        const sy = editBody.querySelector('#th-sy');
        const sz = editBody.querySelector('#th-sz');
        if (x) x.value = pos.x.toFixed(4);
        if (y) y.value = pos.y.toFixed(4);
        if (z) z.value = pos.z.toFixed(4);
        if (rx) rx.value = rot.x.toFixed(4);
        if (ry) ry.value = rot.y.toFixed(4);
        if (rz) rz.value = rot.z.toFixed(4);
        if (sx) sx.value = scl.x.toFixed(4);
        if (sy) sy.value = scl.y.toFixed(4);
        if (sz) sz.value = scl.z.toFixed(4);
        return;
      }

      const uniform = (Number(scl.x) + Number(scl.y) + Number(scl.z)) / 3;
      updateTreasureTransform(sceneIdx, {
        pos_x: pos.x,
        pos_y: pos.y,
        pos_z: pos.z,
        rot_x: rot.x,
        rot_y: rot.y,
        rot_z: rot.z,
        scale: uniform,
      });
      const x = editBody.querySelector('#ti-x');
      const y = editBody.querySelector('#ti-y');
      const z = editBody.querySelector('#ti-z');
      const rx = editBody.querySelector('#ti-rotx');
      const ry = editBody.querySelector('#ti-roty');
      const rz = editBody.querySelector('#ti-rotz');
      const sc = editBody.querySelector('#ti-scale');
      if (x) x.value = pos.x.toFixed(4);
      if (y) y.value = pos.y.toFixed(4);
      if (z) z.value = pos.z.toFixed(4);
      if (rx) rx.value = rot.x.toFixed(4);
      if (ry) ry.value = rot.y.toFixed(4);
      if (rz) rz.value = rot.z.toFixed(4);
      if (sc) sc.value = uniform.toFixed(4);
    });
    setGizmoDragEndCallback(() => {
      if ((gizmoTarget !== 'item' && gizmoTarget !== 'hint') || sceneIdx < 0) return;
      const item = treasureData[sceneIdx];
      if (!item?.id) return;
      const payload =
        gizmoTarget === 'hint'
          ? {
              hint_x: item.hint_x,
              hint_y: item.hint_y,
              hint_z: item.hint_z,
              hint_rot_x: item.hint_rot_x,
              hint_rot_y: item.hint_rot_y,
              hint_rot_z: item.hint_rot_z,
              hint_scale_x: item.hint_scale_x,
              hint_scale_y: item.hint_scale_y,
              hint_scale_z: item.hint_scale_z,
            }
          : {
              pos_x: item.pos_x,
              pos_y: item.pos_y,
              pos_z: item.pos_z,
              rot_x: item.rot_x,
              rot_y: item.rot_y,
              rot_z: item.rot_z,
              scale: item.scale,
            };
      updateTreasureItem(item.id, payload)
        .then(() => {
          const idx = items.findIndex((r) => String(r.id) === String(item.id));
          if (idx >= 0) Object.assign(items[idx], item);
        })
        .catch((err) => console.error('[treasure]', err));
    });
  }

  function openItemEditor(row = null, placement = null) {
    const isNew = !row?.id;
    editTitle.textContent = isNew ? t('treasurePanel.addTreasureTitle') : t('treasurePanel.editTreasureTitle');
    const defaultLevel = row?.level_id || levels[0]?.id || '';
    const hintTitle =
      row?.hint_title ||
      (row?.name ? t('treasurePanel.nameHintSuffix', { name: row.name }) : t('treasurePanel.defaultHintTitle'));
    const hintDesc = row?.hint || '';
    // Hint XYZ is independent — never force-link to treasure position on edit
    const hintX = row?.hint_x != null ? row.hint_x : 0;
    const hintY = row?.hint_y != null ? row.hint_y : 0;
    const hintZ = row?.hint_z != null ? row.hint_z : 0;

    editBody.innerHTML = `
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.nameLabel')}</span>
        <input type="text" id="ti-name" value="${escapeHtml(row?.name ?? '')}" placeholder="${t('treasurePanel.treasureNamePlaceholder')}" /></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.levelFieldLabel')}</span>
        <select id="ti-level">${levelOptionsHtml(defaultLevel)}</select></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.mediaFieldLabel')}</span>
        <input type="file" id="ti-file" accept=".png,.jpg,.jpeg,.webp,.glb,image/*,.glb" />
        ${row?.media_url ? `<p class="media-modal-hint">${t('treasurePanel.mediaCurrentHint', { value: escapeHtml(String(row.media_url).slice(0, 64)) })}</p>` : ''}
      </div>

      <div class="treasure-transform-block treasure-transform-active" id="ti-transform-block">
        <div class="treasure-hint-heading">${t('treasurePanel.treasurePositionHeading')}</div>
        ${
          isNew
            ? ''
            : `<div class="media-gizmo-modes treasure-target-modes">
          <button type="button" class="gizmo-mode-btn active" data-gizmo-target="item">${t('treasurePanel.editTreasureModeLabel')}</button>
          <button type="button" class="gizmo-mode-btn" data-gizmo-target="hint">${t('treasurePanel.editHintModeLabel')}</button>
        </div>
        <div class="media-gizmo-modes">
          <button type="button" class="gizmo-mode-btn active" data-mode="translate">${t('treasurePanel.moveModeLabel')}</button>
          <button type="button" class="gizmo-mode-btn" data-mode="rotate">${t('treasurePanel.rotateModeLabel')}</button>
          <button type="button" class="gizmo-mode-btn" data-mode="scale">${t('treasurePanel.scaleModeLabel')}</button>
        </div>`
        }
        <div class="coord-inputs" id="ti-fields-move">
          <div class="coord-group"><span class="field-label field-label--x">${t('treasurePanel.xLabel')}</span><input type="number" id="ti-x" step="any" value="${placement?.x ?? row?.pos_x ?? 0}" /></div>
          <div class="coord-group"><span class="field-label field-label--y">${t('treasurePanel.yLabel')}</span><input type="number" id="ti-y" step="any" value="${placement?.y ?? row?.pos_y ?? 0}" /></div>
          <div class="coord-group"><span class="field-label field-label--z">${t('treasurePanel.zLabel')}</span><input type="number" id="ti-z" step="any" value="${placement?.z ?? row?.pos_z ?? 0}" /></div>
        </div>
        <div class="coord-inputs" id="ti-fields-rotate">
          <div class="coord-group"><span class="field-label field-label--x">${t('treasurePanel.rotXLabel')}</span><input type="number" id="ti-rotx" step="any" value="${row?.rot_x ?? 0}" /></div>
          <div class="coord-group"><span class="field-label field-label--y">${t('treasurePanel.rotYLabel')}</span><input type="number" id="ti-roty" step="any" value="${row?.rot_y ?? 0}" /></div>
          <div class="coord-group"><span class="field-label field-label--z">${t('treasurePanel.rotZLabel')}</span><input type="number" id="ti-rotz" step="any" value="${row?.rot_z ?? 0}" /></div>
        </div>
        <div class="coord-inputs" id="ti-fields-scale">
          <div class="coord-group"><span class="field-label">${t('treasurePanel.scaleLabel')}</span><input type="number" id="ti-scale" step="any" min="0.01" value="${row?.scale ?? 0.35}" /></div>
        </div>
      </div>

      <div class="treasure-hint-block">
        <div class="treasure-hint-heading">${t('treasurePanel.hintBillboardHeading')}</div>
        <p class="media-modal-hint">${t('treasurePanel.hintBillboardDescription')}</p>
        <div class="ar-billboard-fields">
          <div class="coord-group poi-add-field ar-billboard-field">
            <span class="field-label">${t('treasurePanel.hintTitleLabel')}</span>
            <input type="text" id="ti-hint-title" value="${escapeHtml(hintTitle)}" placeholder="${t('treasurePanel.hintTitlePlaceholder')}" />
          </div>
          <div class="coord-group poi-add-field ar-billboard-field">
            <span class="field-label">${t('treasurePanel.hintDescLabel')}</span>
            <textarea id="ti-hint-desc" rows="3" placeholder="${t('treasurePanel.hintDescPlaceholder')}">${escapeHtml(hintDesc)}</textarea>
          </div>
        </div>
        <div class="ar-billboard-stage treasure-hint-preview" aria-hidden="true">
          <div class="ar-billboard-card" id="ti-hint-card">
            <div class="ar-billboard-title" id="ti-hint-title-preview">${escapeHtml(hintTitle)}</div>
            <div class="ar-billboard-desc" id="ti-hint-desc-preview">${escapeHtml(hintDesc || t('treasurePanel.defaultHintDescPreview'))}</div>
          </div>
        </div>
        ${row?.hint_image ? `<p class="media-modal-hint">${t('treasurePanel.hintImageSetMsg')}</p>` : ''}
      </div>

      <div class="treasure-transform-block" id="th-transform-block">
        <div class="treasure-hint-heading">${t('treasurePanel.hintPositionHeading')}</div>
        <p class="media-modal-hint">${t('treasurePanel.hintPositionDesc')}</p>
        <div class="coord-inputs" id="th-fields-move">
          <div class="coord-group"><span class="field-label field-label--x">${t('treasurePanel.hintXLabel')}</span><input type="number" id="th-x" step="any" value="${hintX}" /></div>
          <div class="coord-group"><span class="field-label field-label--y">${t('treasurePanel.hintYLabel')}</span><input type="number" id="th-y" step="any" value="${hintY}" /></div>
          <div class="coord-group"><span class="field-label field-label--z">${t('treasurePanel.hintZLabel')}</span><input type="number" id="th-z" step="any" value="${hintZ}" /></div>
        </div>
        <div class="coord-inputs" id="th-fields-rotate">
          <div class="coord-group"><span class="field-label">${t('treasurePanel.hintRotXLabel')}</span><input type="number" id="th-rotx" step="any" value="${row?.hint_rot_x ?? 0}" /></div>
          <div class="coord-group"><span class="field-label">${t('treasurePanel.hintRotYLabel')}</span><input type="number" id="th-roty" step="any" value="${row?.hint_rot_y ?? 0}" /></div>
          <div class="coord-group"><span class="field-label">${t('treasurePanel.hintRotZLabel')}</span><input type="number" id="th-rotz" step="any" value="${row?.hint_rot_z ?? 0}" /></div>
        </div>
        <div class="coord-inputs" id="th-fields-scale">
          <div class="coord-group"><span class="field-label">${t('treasurePanel.hintScaleXLabel')}</span><input type="number" id="th-sx" step="any" min="0.01" value="${row?.hint_scale_x ?? 1}" /></div>
          <div class="coord-group"><span class="field-label">${t('treasurePanel.hintScaleYLabel')}</span><input type="number" id="th-sy" step="any" min="0.01" value="${row?.hint_scale_y ?? 1}" /></div>
          <div class="coord-group"><span class="field-label">${t('treasurePanel.hintScaleZLabel')}</span><input type="number" id="th-sz" step="any" min="0.01" value="${row?.hint_scale_z ?? 1}" /></div>
        </div>
        ${
          isNew
            ? `<p class="media-modal-hint">${t('treasurePanel.hintSaveTreasureFirstMsg')}</p>`
            : `<button type="button" class="btn-secondary btn-save--compact" id="ti-place-hint">${t('treasurePanel.placeHintOnMapButton')}</button>`
        }
      </div>

      <div class="coord-inputs">
        <div class="coord-group"><span class="field-label">${t('treasurePanel.collectRadiusLabel')}</span><input type="number" id="ti-radius" step="any" min="0.05" value="${row?.collect_radius_m ?? 0.2}" /></div>
        <div class="coord-group"><span class="field-label">${t('treasurePanel.sortLabel')}</span><input type="number" id="ti-sort" step="1" value="${row?.sort_order ?? 1}" /></div>
      </div>
      <label class="treasure-check"><input type="checkbox" id="ti-hidden" ${row?.is_hidden_until_clue ? 'checked' : ''}/> ${t('treasurePanel.hiddenUntilClueLabel')}</label>
      <label class="treasure-check"><input type="checkbox" id="ti-active" ${row?.is_active !== false ? 'checked' : ''}/> ${t('treasurePanel.activeLabel')}</label>
      <div class="poi-actions-row media-panel-save-row">
        <button type="button" class="btn-save" id="ti-save"><span class="icon">${iconSave()}</span> ${t('treasurePanel.saveButton')}</button>
        ${isNew ? '' : `<button type="button" class="btn-save btn-delete" id="ti-delete">${iconDelete()}</button>`}
      </div>
    `;

    const syncHintPreview = () => {
      const titleVal = editBody.querySelector('#ti-hint-title')?.value?.trim() || t('treasurePanel.defaultHintTitle');
      const d = editBody.querySelector('#ti-hint-desc')?.value?.trim() || t('treasurePanel.defaultHintDescPreview');
      const tp = editBody.querySelector('#ti-hint-title-preview');
      const dp = editBody.querySelector('#ti-hint-desc-preview');
      if (tp) tp.textContent = titleVal;
      if (dp) dp.textContent = d;
    };
    editBody.querySelector('#ti-hint-title')?.addEventListener('input', syncHintPreview);
    editBody.querySelector('#ti-hint-desc')?.addEventListener('input', syncHintPreview);

    editBody.querySelector('#ti-place-hint')?.addEventListener('click', () => {
      if (!row?.id) {
        showToast(t('treasurePanel.errSaveTreasureFirstHint'), 'error');
        return;
      }
      hintPlaceTreasureId = String(row.id);
      const idx = items.findIndex((r) => String(r.id) === String(row.id));
      if (idx >= 0) selectedItemIndex = idx;
      onStartPlaceHint?.();
    });

    if (!isNew) {
      gizmoMode = 'translate';
      gizmoTarget = 'item';
      editBody.querySelectorAll('.gizmo-mode-btn[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => setTreasureGizmoMode(btn.dataset.mode));
      });
      editBody.querySelectorAll('[data-gizmo-target]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sceneIdx = treasureData.findIndex((t) => String(t.id) === String(row.id));
          if (sceneIdx >= 0) attachTreasureOrHintGizmo(sceneIdx, btn.dataset.gizmoTarget);
        });
      });
      syncTransformSectionHighlight();
    }

    const bindLiveTransform = () => {
      if (isNew || !row?.id) return;
      const sceneIdx = treasureData.findIndex((t) => String(t.id) === String(row.id));
      if (sceneIdx < 0) return;
      updateTreasureTransform(sceneIdx, {
        pos_x: parseFloat(editBody.querySelector('#ti-x').value) || 0,
        pos_y: parseFloat(editBody.querySelector('#ti-y').value) || 0,
        pos_z: parseFloat(editBody.querySelector('#ti-z').value) || 0,
        rot_x: parseFloat(editBody.querySelector('#ti-rotx').value) || 0,
        rot_y: parseFloat(editBody.querySelector('#ti-roty').value) || 0,
        rot_z: parseFloat(editBody.querySelector('#ti-rotz').value) || 0,
        scale: parseFloat(editBody.querySelector('#ti-scale').value) || 0.35,
      });
      updateHintTransform(sceneIdx, {
        hint_x: parseFloat(editBody.querySelector('#th-x').value) || 0,
        hint_y: parseFloat(editBody.querySelector('#th-y').value) || 0,
        hint_z: parseFloat(editBody.querySelector('#th-z').value) || 0,
        hint_rot_x: parseFloat(editBody.querySelector('#th-rotx').value) || 0,
        hint_rot_y: parseFloat(editBody.querySelector('#th-roty').value) || 0,
        hint_rot_z: parseFloat(editBody.querySelector('#th-rotz').value) || 0,
        hint_scale_x: parseFloat(editBody.querySelector('#th-sx').value) || 1,
        hint_scale_y: parseFloat(editBody.querySelector('#th-sy').value) || 1,
        hint_scale_z: parseFloat(editBody.querySelector('#th-sz').value) || 1,
      });
    };
    [
      '#ti-x', '#ti-y', '#ti-z', '#ti-rotx', '#ti-roty', '#ti-rotz', '#ti-scale',
      '#th-x', '#th-y', '#th-z', '#th-rotx', '#th-roty', '#th-rotz', '#th-sx', '#th-sy', '#th-sz',
    ].forEach((sel) => {
      editBody.querySelector(sel)?.addEventListener('change', bindLiveTransform);
    });

    editBody.querySelector('#ti-save').addEventListener('click', async () => {
      try {
        const poiType = getPoiType();
        const fileInput = editBody.querySelector('#ti-file');
        const file = fileInput.files?.[0];
        let media_url = row?.media_url;
        let media_type = row?.media_type || 'image';
        if (file) {
          const classified = classifyMediaFile(file);
          if (!classified || (classified.mediaType !== 'image' && classified.mediaType !== 'model')) {
            throw new Error(t('treasurePanel.errInvalidTreasureMedia'));
          }
          media_type = classified.mediaType === 'model' ? 'model' : 'image';
          const up = await uploadProjectMedia(file, poiType, media_type);
          media_url = up.publicUrl;
        }
        if (!media_url) throw new Error(t('treasurePanel.errNoTreasureMedia'));
        if (!editBody.querySelector('#ti-level').value) throw new Error(t('treasurePanel.errCreateLevelFirst'));

        const hint_title = editBody.querySelector('#ti-hint-title').value.trim() || t('treasurePanel.defaultHintTitle');
        const hint = editBody.querySelector('#ti-hint-desc').value.trim();
        const prevTitle = String(row?.hint_title ?? '');
        const prevHint = String(row?.hint ?? '');
        const needsBillboard = Boolean(hint) && (isNew || !row?.hint_image || hint_title !== prevTitle || hint !== prevHint);

        let hint_image = row?.hint_image || null;
        if (needsBillboard) {
          const png = await createArBillboardPngFile({
            title: hint_title,
            description: hint || t('treasurePanel.defaultHintDescFallback'),
            fileName: `Treasure_Hint_${(editBody.querySelector('#ti-name').value || 'item').trim()}.png`,
            theme: 'treasure',
          });
          const upHint = await uploadProjectMedia(png, poiType, 'image');
          hint_image = upHint.publicUrl;
        }

        const payload = {
          name: editBody.querySelector('#ti-name').value.trim() || t('treasurePanel.defaultTreasureName'),
          level_id: editBody.querySelector('#ti-level').value,
          media_type,
          media_url,
          pos_x: parseFloat(editBody.querySelector('#ti-x').value) || 0,
          pos_y: parseFloat(editBody.querySelector('#ti-y').value) || 0,
          pos_z: parseFloat(editBody.querySelector('#ti-z').value) || 0,
          rot_x: parseFloat(editBody.querySelector('#ti-rotx').value) || 0,
          rot_y: parseFloat(editBody.querySelector('#ti-roty').value) || 0,
          rot_z: parseFloat(editBody.querySelector('#ti-rotz').value) || 0,
          scale: parseFloat(editBody.querySelector('#ti-scale').value) || 0.35,
          collect_radius_m: parseFloat(editBody.querySelector('#ti-radius').value) || 0.2,
          sort_order: Number(editBody.querySelector('#ti-sort').value) || 1,
          is_hidden_until_clue: editBody.querySelector('#ti-hidden').checked,
          is_active: editBody.querySelector('#ti-active').checked,
          hint_title,
          hint: hint || null,
          hint_image,
          hint_x: parseFloat(editBody.querySelector('#th-x').value) || 0,
          hint_y: parseFloat(editBody.querySelector('#th-y').value) || 0,
          hint_z: parseFloat(editBody.querySelector('#th-z').value) || 0,
          hint_rot_x: parseFloat(editBody.querySelector('#th-rotx').value) || 0,
          hint_rot_y: parseFloat(editBody.querySelector('#th-roty').value) || 0,
          hint_rot_z: parseFloat(editBody.querySelector('#th-rotz').value) || 0,
          hint_scale_x: parseFloat(editBody.querySelector('#th-sx').value) || 1,
          hint_scale_y: parseFloat(editBody.querySelector('#th-sy').value) || 1,
          hint_scale_z: parseFloat(editBody.querySelector('#th-sz').value) || 1,
        };

        const saved = isNew
          ? await insertTreasureItem(payload)
          : await updateTreasureItem(row.id, payload);
        const idx = upsertTreasureLocal(saved);
        const anchor = getMultisetAnchor();
        if (anchor) await remountTreasureItem(idx, anchor);
        showToast(t('treasurePanel.treasureSavedToast'), 'success');
        await reloadAll();
        const newIdx = items.findIndex((r) => String(r.id) === String(saved.id));
        if (newIdx >= 0) selectTreasureItem(newIdx);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    editBody.querySelector('#ti-delete')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: t('treasurePanel.confirmDeleteTreasureTitle'),
        message: t('treasurePanel.confirmDeleteTreasureMessage', { name: row.name }),
        confirmLabel: t('treasurePanel.confirmDeleteLabel'),
        cancelLabel: t('treasurePanel.cancelLabel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteTreasureItem(row.id);
        const sceneIdx = treasureData.findIndex((tr) => String(tr.id) === String(row.id));
        if (sceneIdx >= 0) deleteTreasureFromScene(sceneIdx);
        detachGizmo();
        showToast(t('treasurePanel.treasureDeletedToast'), 'success');
        await reloadAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    relocateActions();
  }

  function cheatOptionsHtml(selectedId) {
    return [
      `<option value="">${t('treasurePanel.noneOption')}</option>`,
      ...cheats.map(
        (c) =>
          `<option value="${c.id}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(c.title)}</option>`,
      ),
    ].join('');
  }

  function openTaskEditor(row = null, placement = null) {
    const isNew = !row?.id;
    selectedTaskId = row?.id ?? null;
    rebuildList();
    editTitle.textContent = isNew ? t('treasurePanel.addTaskTitle') : t('treasurePanel.editTaskTitle');
    const defaultLevel = row?.level_id || levels[0]?.id || '';
    editBody.innerHTML = `
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.titleLabel')}</span>
        <input type="text" id="tt-title" value="${escapeHtml(row?.title ?? '')}" /></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.promptLabel')}</span>
        <textarea id="tt-prompt" rows="3">${escapeHtml(row?.prompt_text ?? '')}</textarea></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.levelFieldLabel')}</span>
        <select id="tt-level">${levelOptionsHtml(defaultLevel)}</select></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.destinationNameLabel')}</span>
        <input type="text" id="tt-dest-name" value="${escapeHtml(row?.destination_name ?? '')}" /></div>
      <div class="coord-inputs">
        <div class="coord-group"><span class="field-label field-label--x">${t('treasurePanel.destXLabel')}</span><input type="number" id="tt-dx" step="any" value="${placement?.x ?? row?.dest_x ?? 0}" /></div>
        <div class="coord-group"><span class="field-label field-label--y">${t('treasurePanel.destYLabel')}</span><input type="number" id="tt-dy" step="any" value="${placement?.y ?? row?.dest_y ?? 0}" /></div>
        <div class="coord-group"><span class="field-label field-label--z">${t('treasurePanel.destZLabel')}</span><input type="number" id="tt-dz" step="any" value="${placement?.z ?? row?.dest_z ?? 0}" /></div>
      </div>
      <div class="coord-inputs">
        <div class="coord-group"><span class="field-label">${t('treasurePanel.tokensRequiredLabel')}</span><input type="number" id="tt-tokens" min="1" value="${row?.tokens_required ?? 1}" /></div>
        <div class="coord-group"><span class="field-label">${t('treasurePanel.arriveRadiusLabel')}</span><input type="number" id="tt-arrive" step="any" value="${row?.arrive_radius_m ?? 1.5}" /></div>
        <div class="coord-group"><span class="field-label">${t('treasurePanel.sortLabel')}</span><input type="number" id="tt-sort" value="${row?.sort_order ?? 1}" /></div>
      </div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.unlocksCheatLabel')}</span>
        <select id="tt-cheat">${cheatOptionsHtml(row?.unlocks_cheat_id)}</select></div>
      <label class="treasure-check"><input type="checkbox" id="tt-active" ${row?.is_active !== false ? 'checked' : ''}/> ${t('treasurePanel.activeLabel')}</label>
      <div class="poi-actions-row media-panel-save-row">
        <button type="button" class="btn-save" id="tt-save"><span class="icon">${iconSave()}</span> ${t('treasurePanel.saveButton')}</button>
        ${isNew ? '' : `<button type="button" class="btn-save btn-delete" id="tt-delete">${iconDelete()}</button>`}
      </div>
      ${
        isNew
          ? ''
          : `<div class="treasure-token-block">
        <div class="poi-subpanel-title">${t('treasurePanel.specialTokensTitle')}</div>
        <button type="button" class="btn-secondary btn-save--compact" id="tt-add-token">${iconAdd()} ${t('treasurePanel.addTokenButton')}</button>
        <div id="tt-token-list"></div>
      </div>`
      }
    `;

    editBody.querySelector('#tt-save').addEventListener('click', async () => {
      try {
        if (!editBody.querySelector('#tt-level').value) throw new Error(t('treasurePanel.errCreateLevelFirst'));
        const payload = {
          title: editBody.querySelector('#tt-title').value.trim() || t('treasurePanel.defaultTaskName'),
          prompt_text: editBody.querySelector('#tt-prompt').value.trim(),
          level_id: editBody.querySelector('#tt-level').value,
          destination_name: editBody.querySelector('#tt-dest-name').value.trim() || t('treasurePanel.defaultDestinationName'),
          dest_x: parseFloat(editBody.querySelector('#tt-dx').value) || 0,
          dest_y: parseFloat(editBody.querySelector('#tt-dy').value) || 0,
          dest_z: parseFloat(editBody.querySelector('#tt-dz').value) || 0,
          tokens_required: Number(editBody.querySelector('#tt-tokens').value) || 1,
          arrive_radius_m: parseFloat(editBody.querySelector('#tt-arrive').value) || 1.5,
          unlocks_cheat_id: editBody.querySelector('#tt-cheat').value || null,
          sort_order: Number(editBody.querySelector('#tt-sort').value) || 1,
          is_active: editBody.querySelector('#tt-active').checked,
          task_type: 'navigate_collect',
        };
        const saved = isNew ? await insertTreasureTask(payload) : await updateTreasureTask(row.id, payload);
        showToast(t('treasurePanel.taskSavedToast'), 'success');
        await reloadAll();
        openTaskEditor(saved);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    editBody.querySelector('#tt-delete')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: t('treasurePanel.confirmDeleteTaskTitle'),
        message: t('treasurePanel.confirmDeleteTaskMessage', { title: row.title }),
        confirmLabel: t('treasurePanel.confirmDeleteLabel'),
        cancelLabel: t('treasurePanel.cancelLabel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteTreasureTask(row.id);
        showToast(t('treasurePanel.taskDeletedToast'), 'success');
        await reloadAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    if (!isNew) {
      renderTokenList(row.id);
      editBody.querySelector('#tt-add-token')?.addEventListener('click', () => {
        openTokenEditor(row.id);
      });
    }
    relocateActions();
  }

  function renderTokenList(taskId) {
    const wrap = editBody.querySelector('#tt-token-list');
    if (!wrap) return;
    const list = tokens.filter((t) => String(t.task_id) === String(taskId));
    wrap.innerHTML = list
      .map(
        (t) =>
          `<button type="button" class="treasure-token-row" data-id="${t.id}">${escapeHtml(t.name)}</button>`,
      )
      .join('') || `<p class="treasure-empty-hint">${t('treasurePanel.noTokensForTask')}</p>`;
    wrap.querySelectorAll('.treasure-token-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tok = tokens.find((t) => String(t.id) === String(btn.dataset.id));
        if (tok) openTokenEditor(taskId, tok);
      });
    });
  }

  function openTokenEditor(taskId, row = null, placement = null) {
    selectedTokenId = row?.id ?? null;
    gizmoTarget = 'token';
    editTitle.textContent = row ? t('treasurePanel.editTokenTitle') : t('treasurePanel.addTokenTitle');
    editBody.innerHTML = `
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.nameLabel')}</span>
        <input type="text" id="tk-name" value="${escapeHtml(row?.name ?? '')}" /></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.mediaLabel')}</span>
        <input type="file" id="tk-file" accept=".png,.jpg,.jpeg,.webp,.glb,image/*" />
        ${row?.media_url ? `<p class="media-modal-hint">${t('treasurePanel.mediaCurrentFileSet')}</p>` : ''}
      </div>
      <div class="coord-inputs">
        <div class="coord-group"><span class="field-label field-label--x">${t('treasurePanel.xLabel')}</span><input type="number" id="tk-x" step="any" value="${placement?.x ?? row?.pos_x ?? 0}" /></div>
        <div class="coord-group"><span class="field-label field-label--y">${t('treasurePanel.yLabel')}</span><input type="number" id="tk-y" step="any" value="${placement?.y ?? row?.pos_y ?? 0}" /></div>
        <div class="coord-group"><span class="field-label field-label--z">${t('treasurePanel.zLabel')}</span><input type="number" id="tk-z" step="any" value="${placement?.z ?? row?.pos_z ?? 0}" /></div>
      </div>
      <div class="coord-inputs">
        <div class="coord-group"><span class="field-label field-label--x">${t('treasurePanel.rotXLabel')}</span><input type="number" id="tk-rotx" step="any" value="${row?.rot_x ?? 0}" /></div>
        <div class="coord-group"><span class="field-label field-label--y">${t('treasurePanel.rotYLabel')}</span><input type="number" id="tk-roty" step="any" value="${row?.rot_y ?? 0}" /></div>
        <div class="coord-group"><span class="field-label field-label--z">${t('treasurePanel.rotZLabel')}</span><input type="number" id="tk-rotz" step="any" value="${row?.rot_z ?? 0}" /></div>
      </div>
      <div class="coord-inputs">
        <div class="coord-group"><span class="field-label">${t('treasurePanel.scaleLabel')}</span><input type="number" id="tk-scale" step="any" value="${row?.scale ?? 0.35}" /></div>
        <div class="coord-group"><span class="field-label">${t('treasurePanel.collectRadiusShortLabel')}</span><input type="number" id="tk-radius" step="any" value="${row?.collect_radius_m ?? 0.2}" /></div>
      </div>
      <label class="treasure-check"><input type="checkbox" id="tk-active" ${row?.is_active !== false ? 'checked' : ''}/> ${t('treasurePanel.activeLabel')}</label>
      <div class="poi-actions-row media-panel-save-row">
        <button type="button" class="btn-secondary" id="tk-back">${t('treasurePanel.backButton')}</button>
        <button type="button" class="btn-save" id="tk-save">${t('treasurePanel.saveButton')}</button>
        ${row ? `<button type="button" class="btn-save btn-delete" id="tk-delete">${iconDelete()}</button>` : ''}
      </div>
      <button type="button" class="btn-secondary btn-save--compact" id="tk-place">${t('treasurePanel.placeTokenOnMapButton')}</button>
    `;

    editBody.querySelector('#tk-back').addEventListener('click', () => {
      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (task) openTaskEditor(task);
    });
    editBody.querySelector('#tk-place').addEventListener('click', () => onStartPlaceToken?.());

    editBody.querySelector('#tk-save').addEventListener('click', async () => {
      try {
        const file = editBody.querySelector('#tk-file').files?.[0];
        let media_url = row?.media_url;
        let media_type = row?.media_type || 'image';
        if (file) {
          const classified = classifyMediaFile(file);
          if (!classified || (classified.mediaType !== 'image' && classified.mediaType !== 'model')) {
            throw new Error(t('treasurePanel.errInvalidTokenMedia'));
          }
          media_type = classified.mediaType === 'model' ? 'model' : 'image';
          const up = await uploadProjectMedia(file, getPoiType(), media_type);
          media_url = up.publicUrl;
        }
        if (!media_url) throw new Error(t('treasurePanel.errNoTokenMedia'));
        const payload = {
          task_id: taskId,
          name: editBody.querySelector('#tk-name').value.trim() || t('treasurePanel.defaultTokenName'),
          media_type,
          media_url,
          pos_x: parseFloat(editBody.querySelector('#tk-x').value) || 0,
          pos_y: parseFloat(editBody.querySelector('#tk-y').value) || 0,
          pos_z: parseFloat(editBody.querySelector('#tk-z').value) || 0,
          rot_x: parseFloat(editBody.querySelector('#tk-rotx').value) || 0,
          rot_y: parseFloat(editBody.querySelector('#tk-roty').value) || 0,
          rot_z: parseFloat(editBody.querySelector('#tk-rotz').value) || 0,
          scale: parseFloat(editBody.querySelector('#tk-scale').value) || 0.35,
          collect_radius_m: parseFloat(editBody.querySelector('#tk-radius').value) || 0.2,
          is_active: editBody.querySelector('#tk-active').checked,
          sort_order: row?.sort_order || 1,
        };
        if (row?.id) await updateTreasureTaskToken(row.id, payload);
        else await insertTreasureTaskToken(payload);
        showToast(t('treasurePanel.tokenSavedToast'), 'success');
        tokens = await fetchTreasureTaskTokens();
        const task = tasks.find((tk) => String(tk.id) === String(taskId));
        if (task) openTaskEditor(task);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    editBody.querySelector('#tk-delete')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: t('treasurePanel.confirmDeleteTokenTitle'),
        message: t('treasurePanel.confirmDeleteTokenMessage'),
        confirmLabel: t('treasurePanel.confirmDeleteLabel'),
        cancelLabel: t('treasurePanel.cancelLabel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteTreasureTaskToken(row.id);
        showToast(t('treasurePanel.tokenDeletedToast'), 'success');
        tokens = await fetchTreasureTaskTokens();
        const task = tasks.find((tk) => String(tk.id) === String(taskId));
        if (task) openTaskEditor(task);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    relocateActions();
  }

  function treasureOptionsHtml(selectedId) {
    return [
      `<option value="">${t('treasurePanel.noneOption')}</option>`,
      ...items.map(
        (it) =>
          `<option value="${it.id}" ${String(it.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(it.name)}</option>`,
      ),
    ].join('');
  }

  function openCheatEditor(row = null) {
    const isNew = !row?.id;
    editTitle.textContent = isNew ? t('treasurePanel.addCheatTitle') : t('treasurePanel.editCheatTitle');
    const defaultLevel = row?.level_id || levels[0]?.id || '';
    editBody.innerHTML = `
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.titleLabel')}</span>
        <input type="text" id="tc-title" value="${escapeHtml(row?.title ?? '')}" /></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.clueTextLabel')}</span>
        <textarea id="tc-clue" rows="4">${escapeHtml(row?.clue_text ?? '')}</textarea></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.levelFieldLabel')}</span>
        <select id="tc-level">${levelOptionsHtml(defaultLevel)}</select></div>
      <div class="coord-group poi-add-field"><span class="field-label">${t('treasurePanel.targetTreasureLabel')}</span>
        <select id="tc-target">${treasureOptionsHtml(row?.target_treasure_id)}</select></div>
      <label class="treasure-check"><input type="checkbox" id="tc-reveal" ${row?.reveals_treasure !== false ? 'checked' : ''}/> ${t('treasurePanel.revealsTreasureLabel')}</label>
      <div class="poi-actions-row media-panel-save-row">
        <button type="button" class="btn-save" id="tc-save"><span class="icon">${iconSave()}</span> ${t('treasurePanel.saveButton')}</button>
        ${isNew ? '' : `<button type="button" class="btn-save btn-delete" id="tc-delete">${iconDelete()}</button>`}
      </div>
    `;
    editBody.querySelector('#tc-save').addEventListener('click', async () => {
      try {
        if (!editBody.querySelector('#tc-level').value) throw new Error(t('treasurePanel.errCreateLevelFirst'));
        const payload = {
          title: editBody.querySelector('#tc-title').value.trim() || t('treasurePanel.defaultClueName'),
          clue_text: editBody.querySelector('#tc-clue').value.trim(),
          level_id: editBody.querySelector('#tc-level').value,
          target_treasure_id: editBody.querySelector('#tc-target').value || null,
          reveals_treasure: editBody.querySelector('#tc-reveal').checked,
        };
        if (isNew) await insertTreasureCheat(payload);
        else await updateTreasureCheat(row.id, payload);
        showToast(t('treasurePanel.cheatSavedToast'), 'success');
        await reloadAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    editBody.querySelector('#tc-delete')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: t('treasurePanel.confirmDeleteCheatTitle'),
        message: t('treasurePanel.confirmDeleteCheatMessage', { title: row.title }),
        confirmLabel: t('treasurePanel.confirmDeleteLabel'),
        cancelLabel: t('treasurePanel.cancelLabel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteTreasureCheat(row.id);
        showToast(t('treasurePanel.cheatDeletedToast'), 'success');
        await reloadAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    relocateActions();
  }

  listPanel.querySelectorAll('.treasure-tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setTab(btn.dataset.tab);
      if (activeTab === 'players') {
        try {
          progressSummary = await fetchTreasureProgressSummary();
          rebuildList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });
  });

  btnAdd.addEventListener('click', () => {
    if (activeTab === 'levels') openLevelEditor(null);
    else if (activeTab === 'items') openItemEditor(null);
    else if (activeTab === 'tasks') openTaskEditor(null);
    else if (activeTab === 'cheats') openCheatEditor(null);
  });

  btnPlace.addEventListener('click', () => {
    if (activeTab === 'items') onStartPlaceTreasure?.();
    else if (activeTab === 'tasks') onStartPlaceTaskDest?.();
  });

  editDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) {
      clearEditor();
      selectedItemIndex = -1;
      selectedTaskId = null;
      selectedTokenId = null;
      gizmoTarget = null;
      detachGizmo();
      rebuildList();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editDialog.classList.contains('hidden')) {
      clearEditor();
      selectedItemIndex = -1;
      selectedTaskId = null;
      selectedTokenId = null;
      gizmoTarget = null;
      detachGizmo();
      rebuildList();
    }
  });

  return {
    show() {
      listPanel.classList.remove('hidden');
      syncToolbar();
    },
    hide() {
      listPanel.classList.add('hidden');
      clearEditor();
      detachGizmo();
      gizmoTarget = null;
    },
    async refresh() {
      try {
        await reloadAll();
      } catch (err) {
        console.warn('[treasure] refresh:', err);
        showToast(err.message || t('treasurePanel.errFailedLoadTreasures'), 'error');
      }
    },
    deselect() {
      selectedItemIndex = -1;
      detachGizmo();
      gizmoTarget = null;
      // Keep hintPlaceTreasureId so map-click placement still knows which treasure
    },
    openNewTreasureAt(placement) {
      setTab('items');
      openItemEditor(null, placement);
    },
    async applyHintPlacement(placement) {
      const treasureId = hintPlaceTreasureId
        || (selectedItemIndex >= 0 ? items[selectedItemIndex]?.id : null);
      if (!treasureId) {
        showToast(t('treasurePanel.errSelectTreasureFirst'), 'error');
        return;
      }
      const row = items.find((r) => String(r.id) === String(treasureId));
      if (!row?.id) {
        showToast(t('treasurePanel.errSelectTreasureFirst'), 'error');
        return;
      }
      const hint_x = Number(placement?.x) || 0;
      const hint_y = Number(placement?.y) || 0;
      const hint_z = Number(placement?.z) || 0;
      try {
        const saved = await updateTreasureItem(row.id, { hint_x, hint_y, hint_z });
        Object.assign(row, saved || { hint_x, hint_y, hint_z });
        const listIdx = items.findIndex((r) => String(r.id) === String(row.id));
        if (listIdx >= 0) {
          selectedItemIndex = listIdx;
          Object.assign(items[listIdx], row);
        }
        const sceneIdx = treasureData.findIndex((t) => String(t.id) === String(row.id));
        if (sceneIdx >= 0) {
          updateHintTransform(sceneIdx, { hint_x, hint_y, hint_z });
          const idx = upsertTreasureLocal({ ...treasureData[sceneIdx], ...row, hint_x, hint_y, hint_z });
          const anchor = getMultisetAnchor();
          if (anchor) await remountTreasureItem(idx, anchor);
        }
        hintPlaceTreasureId = String(row.id);
        openItemEditor(row);
        const afterIdx = treasureData.findIndex((tr) => String(tr.id) === String(row.id));
        if (afterIdx >= 0) attachTreasureOrHintGizmo(afterIdx, 'hint');
        showToast(t('treasurePanel.hintPlacedToast'), 'success');
      } catch (err) {
        showToast(err.message || t('treasurePanel.errFailedPlaceHint'), 'error');
      }
    },
    applyTaskDestination(placement) {
      setTab('tasks');
      const row = tasks.find((tk) => String(tk.id) === String(selectedTaskId)) || null;
      openTaskEditor(row, placement);
    },
    openNewTokenAt(placement) {
      if (!selectedTaskId) {
        showToast(t('treasurePanel.errSelectTaskFirst'), 'error');
        return;
      }
      openTokenEditor(selectedTaskId, null, placement);
    },
    getSelectedTaskId: () => selectedTaskId,
  };
}
