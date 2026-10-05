/**
 * POI Panel UI
 * Shows a scrollable list of POIs. Clicking one shows editable fields in the right panel.
 * Add POI is only via the scene toolbar (modal dialog).
 */

import {
  poisData,
  addPOIWithDb,
  deletePOI,
  ensureExpectedMesh,
  getPOIObjects,
  getPoiExpectedPosition,
  getPoiMapPosition,
  getPoiNavigationPosition,
  isSuperAdminMapRole,
  poiDisplayName,
  poiHasMissingNameTranslations,
  removePoiFromDb,
  savePoiToDb,
  translateMissingPoiNames,
  updatePOIDescription,
  updatePOIExpectedPosition,
  updatePOIName,
  updatePOIPosition,
} from '../ar/pois.js';
import { categoriesData, categoryDisplayName, getCategoryById, addCategoryWithDb, saveCategoryToDb, removeCategoryFromDb, deleteCategoryLocal } from '../ar/categories.js';
import { floorsData } from '../ar/floors.js';
import {
  getCategoryIconPickerSections,
  getDefaultCategoryIconKey,
  renderCategoryIcon,
} from '../config/category-icons.js';
import {
  flyTo,
  attachGizmo,
  detachGizmo,
  setGizmoDragCallback,
  setGizmoDragEndCallback,
  setLastPickedPoiIndex,
} from '../ar/scene.js';
import {
  isMatterportMapActive,
  shouldUseMatterportCamera,
  syncMatterportEntityTags,
  removeMatterportEntityTag,
  previewMatterportPoiPin,
  commitMatterportPoiPin,
  clearMatterportPoiPreview,
} from '../ar/matterport-map.js';
import {
  iconSave,
  iconDelete,
  iconAdd,
  iconSearch,
  iconFilter,
  iconEdit,
  iconCategory,
  iconChevronRight,
  iconGlobe,
} from './icons.js';
import { showToast } from './toast.js';
import { askConfirm, isConfirmDialogTarget, isConfirmDialogOpen } from './confirm-dialog.js';
import { t } from '../config/i18n.js';
import { getAuthSession, isProjectAdminSession } from '../config/auth-session.js';
import { adminListProjectMembers, projectAdminAssignEntity } from '../services/supabase.js';
import { consumeTranslationFailures } from '../services/poi-translate.js';
import {
  acceptMatterportTagAsPoi,
  fetchPendingMatterportTags,
  getActiveMatterportModelId,
  isSuperAdminEditor,
} from '../services/matterport-pending-api.js';

/** Default label + origin for quick adds (Journey “+” and empty-name manual add). */
export const DEFAULT_NEW_POI_NAME = 'New POI';

let selectedIndex = -1;
let inputName, inputDescription, inputX, inputY, inputZ;
let filterCategoryId = '';
let filterSearchQuery = '';
/** @type {string[]} */
let editSelectedCategoryIds = [];
/** @type {string[]} */
let addSelectedCategoryIds = [];
let categoryDialogIconKey = getDefaultCategoryIconKey();
/** @type {'edit' | 'add' | 'manage'} */
let categoryDialogTarget = 'edit';
/** When set, category dialog is editing this existing category id. */
let editingCategoryId = '';

/**
 * @param {HTMLElement} container
 * @param {{
 *   onPoiListChange?: () => void,
 *   onSelectionChange?: (index: number) => void,
 *   onStartAddPoi?: () => void,
 *   onEditOpenChange?: (open: boolean) => void,
 *   onXyzTargetChange?: (target: 'nav' | 'expected') => void,
 * }} [options]
 */
export function createPOIPanel(container, options = {}) {
  const onPoiListChange = options.onPoiListChange;
  const onSelectionChange = options.onSelectionChange;
  const onStartAddPoi = options.onStartAddPoi;
  const onEditOpenChange = options.onEditOpenChange;
  const onXyzTargetChange = options.onXyzTargetChange;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'poi-list-panel';

  listPanel.innerHTML = `
    <div class="poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${t('poiPanel.title')}</div>
        <div class="poi-panel-header-actions">
          <button type="button" class="admin-refresh-btn" id="poi-translate-names-btn" title="${t('poiPanel.translateNamesTitle')}" aria-label="${t('poiPanel.translateNamesTitle')}">
            ${iconGlobe()}
          </button>
          <button type="button" class="admin-refresh-btn" id="poi-add-category-btn" title="${t('poiPanel.addCategory')}" aria-label="${t('poiPanel.addCategory')}">
            ${iconCategory()}
          </button>
          <button type="button" class="admin-refresh-btn" id="poi-add-poi-btn" title="${t('poiPanel.addPoiHeaderTitle')}" aria-label="${t('poiPanel.addPoiAriaLabel')}">
            ${iconAdd()}
          </button>
        </div>
      </div>
      <div class="poi-list-mode-tabs hidden" id="poi-list-mode-tabs" role="tablist" aria-label="${t('poiPanel.poiViewsAriaLabel')}">
        <button type="button" class="poi-list-mode-tab active" data-poi-list-mode="all" role="tab" aria-selected="true">${t('poiPanel.tabAllPois')}</button>
        <button type="button" class="poi-list-mode-tab" data-poi-list-mode="pending" role="tab" aria-selected="false">${t('poiPanel.tabPendingPois')}</button>
      </div>
      <div class="poi-list-toolbar" role="search">
        <div class="poi-list-search">
          <span class="poi-list-search-icon" aria-hidden="true">${iconSearch()}</span>
          <input
            type="search"
            id="poi-search"
            class="poi-list-search-input"
            placeholder="${t('poiPanel.searchPlaceholder')}"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="poi-list-filter">
            <button
              type="button"
              class="poi-list-filter-btn"
              id="poi-category-filter-btn"
              title="${t('poiPanel.filterByCategory')}"
              aria-label="${t('poiPanel.filterByCategory')}"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-controls="poi-category-filter-menu"
            >
              <span class="poi-list-filter-btn-icon" aria-hidden="true">${iconFilter()}</span>
              <span class="poi-list-filter-dot" id="poi-category-filter-dot" hidden></span>
            </button>
            <div
              class="poi-list-filter-menu hidden"
              id="poi-category-filter-menu"
              role="listbox"
              aria-label="${t('poiPanel.categoriesAriaLabel')}"
            ></div>
          </div>
        </div>
      </div>
    </div>
    <div class="poi-list" id="poi-list"></div>
  `;

  container.appendChild(listPanel);

  const panel = listPanel;

  // Sidebar edit (same pattern as media) — not a modal popup over the map.
  const editDialog = document.createElement('div');
  editDialog.className = 'scene-float-panel scene-float-panel--edit float-glass drawer-frost hidden';
  editDialog.id = 'poi-edit-panel';
  editDialog.innerHTML = `
    <div class="poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title" id="poi-edit-dialog-title">${t('poiPanel.editPoi')}</div>
      </div>
    </div>
    <div class="poi-coords" id="poi-coords">
      <div class="poi-coords-title hidden" id="poi-selected-name" aria-hidden="true"></div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.nameLabel')}</span>
        <input type="text" id="poi-name" value="" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.descriptionLabel')}</span>
        <textarea id="poi-description" rows="2" placeholder="${t('poiPanel.descriptionPlaceholder')}"></textarea>
      </div>
      <details class="poi-edit-fold">
        <summary class="poi-edit-fold-summary">
          <span class="poi-edit-fold-chevron" aria-hidden="true">${iconChevronRight()}</span>
          <span class="poi-edit-fold-label">${t('poiPanel.categoriesLabel')}</span>
        </summary>
        <div class="poi-edit-fold-body">
          <div class="poi-category-chips" id="poi-category-chips" role="group" aria-label="${t('poiPanel.poiCategoriesAriaLabel')}"></div>
          <p class="poi-category-hint">${t('poiPanel.categoryHint')}</p>
        </div>
      </details>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.floorLabel')}</span>
        <select id="poi-floor-select">
          <option value="">${t('poiPanel.floorNone')}</option>
        </select>
        <p class="poi-category-hint">${t('poiPanel.floorHint')}</p>
      </div>
      <details class="poi-edit-fold">
        <summary class="poi-edit-fold-summary">
          <span class="poi-edit-fold-chevron" aria-hidden="true">${iconChevronRight()}</span>
          <span class="poi-edit-fold-label">${t('poiPanel.positionLabel')}</span>
        </summary>
        <div class="poi-edit-fold-body poi-xyz-block">
          <div class="poi-xyz-mode-row hidden" id="poi-xyz-mode-row" role="group" aria-label="${t('poiPanel.xyzEditTargetAriaLabel')}">
            <button type="button" class="poi-xyz-mode-btn active" data-xyz-target="nav" id="poi-xyz-mode-nav">
              ${t('poiPanel.navigationXyz')}
            </button>
            <button type="button" class="poi-xyz-mode-btn" data-xyz-target="expected" id="poi-xyz-mode-expected">
              ${t('poiPanel.expectedXyz')}
            </button>
          </div>
          <p class="poi-category-hint" id="poi-xyz-hint">${t('poiPanel.walkableMovedHint')}</p>
          <div class="poi-xyz-grid" role="group" aria-label="${t('poiPanel.positionXyzAriaLabel')}">
            <label class="poi-xyz-field" for="poi-x">
              <span class="poi-xyz-axis poi-xyz-axis--x">${t('poiPanel.axisX')}</span>
              <input type="number" id="poi-x" value="0" step="any" inputmode="decimal" />
            </label>
            <label class="poi-xyz-field" for="poi-y">
              <span class="poi-xyz-axis poi-xyz-axis--y">${t('poiPanel.axisY')}</span>
              <input type="number" id="poi-y" value="0" step="any" inputmode="decimal" />
            </label>
            <label class="poi-xyz-field" for="poi-z">
              <span class="poi-xyz-axis poi-xyz-axis--z">${t('poiPanel.axisZ')}</span>
              <input type="number" id="poi-z" value="0" step="any" inputmode="decimal" />
            </label>
          </div>
        </div>
      </details>
      <details class="poi-edit-fold hidden" id="poi-assign-row">
        <summary class="poi-edit-fold-summary">
          <span class="poi-edit-fold-chevron" aria-hidden="true">${iconChevronRight()}</span>
          <span class="poi-edit-fold-label">${t('poiPanel.assignLabel')}</span>
        </summary>
        <div class="poi-edit-fold-body poi-assign-row">
          <label class="visually-hidden" for="poi-assign-select">${t('poiPanel.assignLabel')}</label>
          <div class="poi-assign-controls">
            <select id="poi-assign-select">
              <option value="">${t('poiPanel.selectSubAdminOption')}</option>
            </select>
            <button type="button" class="btn-secondary" id="poi-assign-btn">${t('poiPanel.assignButton')}</button>
          </div>
        </div>
      </details>
    </div>
  `;
  container.appendChild(editDialog);

  const actionsPanel = document.createElement('div');
  actionsPanel.className = 'scene-float-panel scene-float-panel--actions float-glass drawer-frost hidden';
  actionsPanel.id = 'poi-actions-panel';
  actionsPanel.innerHTML = `
    <div class="poi-actions-row" id="poi-actions-row">
      <button type="button" class="btn-save btn-delete btn-delete-poi poi-btn-delete" id="btn-delete-poi" title="${t('poiPanel.deletePoi')}" aria-label="${t('poiPanel.deletePoi')}">
        ${iconDelete()}
      </button>
      <button type="button" class="btn-secondary" data-action="close-edit">${t('poiPanel.doneButton')}</button>
      <button type="button" class="btn-save poi-btn-save" id="btn-save-poi">
        <span class="icon">${iconSave()}</span> ${t('poiPanel.saveDetailsButton')}
      </button>
    </div>
  `;
  container.appendChild(actionsPanel);

  const addDialogHost = document.body;
  const addDialog = document.createElement('div');
  addDialog.className = 'poi-add-dialog hidden';
  addDialog.id = 'poi-add-dialog';
  addDialog.setAttribute('role', 'dialog');
  addDialog.setAttribute('aria-modal', 'true');
  addDialog.setAttribute('aria-labelledby', 'poi-add-dialog-title');
  addDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close"></div>
    <div class="poi-add-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="poi-add-dialog-title">${t('poiPanel.addNewPoiTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close" aria-label="${t('poiPanel.closeAriaLabel')}">&times;</button>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.nameLabel')}</span>
        <input type="text" id="new-poi-name" placeholder="${t('poiPanel.namePlaceholder')}" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.descriptionLabel')}</span>
        <textarea id="new-poi-description" rows="3" placeholder="${t('poiPanel.descriptionOptionalPlaceholder')}"></textarea>
      </div>
      <div class="coord-group poi-add-field">
        <div class="facility-category-row">
          <span class="field-label">${t('poiPanel.categoriesLabel')}</span>
          <button type="button" class="admin-refresh-btn" id="new-poi-add-category-btn" title="${t('poiPanel.addCategory')}" aria-label="${t('poiPanel.addCategory')}">
            ${iconAdd()}
          </button>
        </div>
        <div class="poi-category-chips" id="new-poi-category-chips" role="group" aria-label="${t('poiPanel.newPoiCategoriesAriaLabel')}"></div>
        <p class="poi-category-hint">${t('poiPanel.categoryHint')}</p>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.floorLabel')}</span>
        <select id="new-poi-floor-select">
          <option value="">${t('poiPanel.floorNone')}</option>
        </select>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.navigationXyz')}</span>
        <p class="poi-category-hint">${t('poiPanel.navXyzHintAdd')}</p>
        <div class="coord-inputs poi-add-coords">
          <div class="coord-group">
            <span class="field-label field-label--x">${t('poiPanel.axisX')}</span>
            <input type="number" id="new-poi-x" value="0" step="any" inputmode="decimal" />
          </div>
          <div class="coord-group">
            <span class="field-label field-label--y">${t('poiPanel.axisY')}</span>
            <input type="number" id="new-poi-y" value="0" step="any" inputmode="decimal" />
          </div>
          <div class="coord-group">
            <span class="field-label field-label--z">${t('poiPanel.axisZ')}</span>
            <input type="number" id="new-poi-z" value="0" step="any" inputmode="decimal" />
          </div>
        </div>
      </div>
      <div class="poi-add-dialog-actions">
        <button type="button" class="btn-secondary" data-action="close">${t('poiPanel.cancelButton')}</button>
        <button type="button" class="btn-save" id="btn-add-poi">
          <span class="icon">${iconAdd()}</span> ${t('poiPanel.addPoiButton')}
        </button>
      </div>
    </div>
  `;
  addDialogHost.appendChild(addDialog);

  const categoryDialog = document.createElement('div');
  categoryDialog.className = 'poi-add-dialog hidden';
  categoryDialog.id = 'poi-category-dialog';
  categoryDialog.setAttribute('role', 'dialog');
  categoryDialog.setAttribute('aria-modal', 'true');
  categoryDialog.setAttribute('aria-labelledby', 'poi-category-dialog-title');
  categoryDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-cat"></div>
    <div class="poi-add-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="poi-category-dialog-title">${t('poiPanel.addCategoryDialogTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-cat" aria-label="${t('poiPanel.closeAriaLabel')}">&times;</button>
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.categoryNameLabel')}</span>
        <input type="text" id="new-poi-cat-name" placeholder="${t('poiPanel.categoryNamePlaceholder')}" />
      </div>
      <div class="coord-group poi-add-field">
        <span class="field-label">${t('poiPanel.iconLabel')}</span>
        <div class="category-icon-toolbar">
          <div class="category-icon-preview" id="new-poi-cat-icon-preview"></div>
          <input
            type="search"
            id="new-poi-cat-icon-search"
            class="category-icon-search"
            placeholder="${t('poiPanel.searchIconsPlaceholder')}"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="category-icon-picker">
          <div class="category-icon-grid" id="new-poi-cat-icon-grid" role="listbox" aria-label="${t('poiPanel.categoryIconAriaLabel')}"></div>
        </div>
      </div>
      <div class="poi-add-dialog-actions">
        <button type="button" class="btn-secondary" data-action="close-cat">${t('poiPanel.cancelButton')}</button>
        <button type="button" class="btn-save" id="btn-save-poi-category">
          <span class="icon">${iconAdd()}</span> ${t('poiPanel.addCategoryButton')}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(categoryDialog);

  const listEl = listPanel.querySelector('#poi-list');
  const selectedNameEl = editDialog.querySelector('#poi-selected-name');
  const editDialogTitle = editDialog.querySelector('#poi-edit-dialog-title');
  inputName = editDialog.querySelector('#poi-name');
  inputDescription = editDialog.querySelector('#poi-description');
  inputX = editDialog.querySelector('#poi-x');
  inputY = editDialog.querySelector('#poi-y');
  inputZ = editDialog.querySelector('#poi-z');
  const editCategoryChipsEl = editDialog.querySelector('#poi-category-chips');
  const editFloorSelect = editDialog.querySelector('#poi-floor-select');
  const categoryFilterBtn = listPanel.querySelector('#poi-category-filter-btn');
  const categoryFilterMenu = listPanel.querySelector('#poi-category-filter-menu');
  const categoryFilterDot = listPanel.querySelector('#poi-category-filter-dot');
  const searchInputEl = listPanel.querySelector('#poi-search');
  const btnHeaderAddPoi = listPanel.querySelector('#poi-add-poi-btn');
  const btnHeaderAddCategory = listPanel.querySelector('#poi-add-category-btn');
  const btnTranslateNames = listPanel.querySelector('#poi-translate-names-btn');
  const listModeTabs = listPanel.querySelector('#poi-list-mode-tabs');
  const btnSave = actionsPanel.querySelector('#btn-save-poi');
  const btnDelete = actionsPanel.querySelector('#btn-delete-poi');
  const assignRow = editDialog.querySelector('#poi-assign-row');
  const assignSelect = editDialog.querySelector('#poi-assign-select');
  const assignBtn = editDialog.querySelector('#poi-assign-btn');
  const btnAdd = addDialog.querySelector('#btn-add-poi');
  const newPoiName = addDialog.querySelector('#new-poi-name');
  const newPoiDescription = addDialog.querySelector('#new-poi-description');
  const newPoiX = addDialog.querySelector('#new-poi-x');
  const newPoiY = addDialog.querySelector('#new-poi-y');
  const newPoiZ = addDialog.querySelector('#new-poi-z');
  const addFloorSelect = addDialog.querySelector('#new-poi-floor-select');
  /** Original click XYZ for `expected_pos_*` (kept when snap updates placed XYZ). */
  let pendingExpected = null;
  /** Surface normal at the click — keeps wall tilt after Add. */
  let pendingNormal = null;
  /** True when the Showcase preview pin was bound to a saved POI. */
  let previewPinCommitted = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let previewPinTimer = null;
  /** @type {'all' | 'pending'} */
  let listMode = 'all';
  /** @type {Array<Record<string, unknown>>} */
  let pendingMatterportTags = [];
  let pendingTagsLoading = false;
  /** Super-admin XYZ target: navigation (`pos_*`) or expected (`expected_pos_*`). */
  /** @type {'nav' | 'expected'} */
  let xyzEditTarget = 'nav';

  const xyzModeRow = editDialog.querySelector('#poi-xyz-mode-row');
  const xyzHintEl = editDialog.querySelector('#poi-xyz-hint');
  const xyzModeNavBtn = editDialog.querySelector('#poi-xyz-mode-nav');
  const xyzModeExpectedBtn = editDialog.querySelector('#poi-xyz-mode-expected');

  function syncXyzModeUi() {
    const isSuper = isSuperAdminMapRole();
    xyzModeRow?.classList.toggle('hidden', !isSuper);
    xyzModeNavBtn?.classList.toggle('active', xyzEditTarget === 'nav');
    xyzModeExpectedBtn?.classList.toggle('active', xyzEditTarget === 'expected');
    const xyzFoldLabel = editDialog
      .querySelector('.poi-xyz-block')
      ?.closest('details')
      ?.querySelector('.poi-edit-fold-label');
    if (xyzFoldLabel) {
      xyzFoldLabel.textContent =
        isSuper && xyzEditTarget === 'expected'
          ? t('poiPanel.expectedXyzExactClick')
          : isSuper
            ? t('poiPanel.navigationXyzMoved')
            : t('poiPanel.positionLabel');
    }
    if (xyzHintEl) {
      xyzHintEl.textContent =
        isSuper && xyzEditTarget === 'expected'
          ? t('poiPanel.exactMapClickHint')
          : t('poiPanel.walkableMovedHint');
    }
  }

  /**
   * @param {'nav' | 'expected'} target
   * @param {{ fillInputs?: boolean }} [opts]
   */
  function setXyzEditTarget(target, opts = {}) {
    xyzEditTarget = target === 'expected' && isSuperAdminMapRole() ? 'expected' : 'nav';
    syncXyzModeUi();
    if (opts.fillInputs !== false && selectedIndex >= 0) {
      fillXyzInputsFromPoi(poisData[selectedIndex]);
    }
    onXyzTargetChange?.(xyzEditTarget);
  }

  /** @param {Record<string, unknown> | null | undefined} poi */
  function fillXyzInputsFromPoi(poi) {
    if (!poi) return;
    const pos =
      xyzEditTarget === 'expected' && isSuperAdminMapRole()
        ? getPoiExpectedPosition(poi)
        : getPoiNavigationPosition(poi);
    inputX.value = pos.x.toFixed(4);
    inputY.value = pos.y.toFixed(4);
    inputZ.value = pos.z.toFixed(4);
  }

  xyzModeNavBtn?.addEventListener('click', () => setXyzEditTarget('nav'));
  xyzModeExpectedBtn?.addEventListener('click', () => setXyzEditTarget('expected'));

  function scheduleMatterportPreviewPin() {
    if (!isMatterportMapActive()) return;
    if (previewPinTimer) clearTimeout(previewPinTimer);
    previewPinTimer = setTimeout(() => {
      previewPinTimer = null;
      const x = parseFloat(newPoiX.value) || 0;
      const y = parseFloat(newPoiY.value) || 0;
      const z = parseFloat(newPoiZ.value) || 0;
      const label = newPoiName.value.trim() || DEFAULT_NEW_POI_NAME;
      // Form XYZ = navigation; pendingExpected = exact click — never copy nav into expected.
      void previewMatterportPoiPin({ x, y, z }, label, pendingExpected, pendingNormal);
    }, 40);
  }

  [newPoiX, newPoiY, newPoiZ, newPoiName].forEach((el) => {
    el?.addEventListener('input', () => scheduleMatterportPreviewPin());
  });
  const addCategoryChipsEl = addDialog.querySelector('#new-poi-category-chips');
  const btnNewAddCategory = addDialog.querySelector('#new-poi-add-category-btn');
  const catNameInput = categoryDialog.querySelector('#new-poi-cat-name');
  const catIconPreviewEl = categoryDialog.querySelector('#new-poi-cat-icon-preview');
  const catIconSearchInput = categoryDialog.querySelector('#new-poi-cat-icon-search');
  const catIconGridEl = categoryDialog.querySelector('#new-poi-cat-icon-grid');
  const btnSaveCategory = categoryDialog.querySelector('#btn-save-poi-category');
  const categoryDialogTitleEl = categoryDialog.querySelector('#poi-category-dialog-title');

  function poiCategoryIds(poi) {
    if (Array.isArray(poi?.category_ids) && poi.category_ids.length) {
      return poi.category_ids.map((id) => String(id)).filter(Boolean);
    }
    return poi?.category_type ? [String(poi.category_type)] : [];
  }

  function renderCategoryChips(container, selectedIds, onChange) {
    if (!container) return;
    const selected = new Set((selectedIds || []).map(String));
    if (!categoriesData.length) {
      container.innerHTML = `<div class="poi-category-empty">${t('poiPanel.noCategoriesYet')}</div>`;
      return;
    }
    container.innerHTML = categoriesData
      .map((cat) => {
        const id = String(cat.id);
        const on = selected.has(id);
        return `
          <button type="button" class="poi-category-chip${on ? ' is-active' : ''}${on && selectedIds[0] === id ? ' is-primary' : ''}" data-category-id="${escapeHtml(id)}" aria-pressed="${on ? 'true' : 'false'}">
            <span class="poi-category-chip-icon">${renderCategoryIcon(cat.icon_key)}</span>
            <span>${escapeHtml(categoryDisplayName(cat))}</span>
          </button>`;
      })
      .join('');
    container.querySelectorAll('[data-category-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-category-id');
        if (!id) return;
        const next = [...selected];
        const idx = next.indexOf(id);
        if (idx >= 0) next.splice(idx, 1);
        else next.push(id);
        onChange(next);
      });
    });
  }

  function refreshCategoryUi() {
    renderCategoryChips(editCategoryChipsEl, editSelectedCategoryIds, (ids) => {
      editSelectedCategoryIds = ids;
      refreshCategoryUi();
    });
    renderCategoryChips(addCategoryChipsEl, addSelectedCategoryIds, (ids) => {
      addSelectedCategoryIds = ids;
      refreshCategoryUi();
    });
    fillFloorSelect(editFloorSelect, editFloorSelect?.value);
    fillFloorSelect(addFloorSelect, addFloorSelect?.value);
    if (categoryFilterMenu) {
      const current = filterCategoryId;
      const items = [
        {
          id: '',
          label: t('poiPanel.allCategoriesOption'),
          iconHtml: iconFilter(),
          active: !current,
          manageable: false,
        },
        ...categoriesData.map((cat) => {
          const id = String(cat.id);
          return {
            id,
            label: categoryDisplayName(cat),
            iconHtml: renderCategoryIcon(cat.icon_key),
            active: id === current,
            manageable: true,
          };
        }),
      ];
      categoryFilterMenu.innerHTML = `${items
        .map(
          (item) => `
          <div class="poi-list-filter-row${item.active ? ' is-active' : ''}" data-category-id="${escapeHtml(item.id)}">
            <button
              type="button"
              class="poi-list-filter-option"
              role="option"
              data-category-id="${escapeHtml(item.id)}"
              aria-selected="${item.active ? 'true' : 'false'}"
            >
              <span class="poi-list-filter-option-icon" aria-hidden="true">${item.iconHtml}</span>
              <span class="poi-list-filter-option-label">${escapeHtml(item.label)}</span>
              ${item.active ? '<span class="poi-list-filter-check" aria-hidden="true">✓</span>' : ''}
            </button>
            ${
              item.manageable
                ? `<div class="poi-list-filter-actions">
                    <button type="button" class="poi-list-filter-action" data-action="edit-category" data-category-id="${escapeHtml(item.id)}" title="${t('poiPanel.editCategoryTitle')}" aria-label="${t('poiPanel.editCategoryAriaLabel', { label: escapeHtml(item.label) })}">${iconEdit()}</button>
                    <button type="button" class="poi-list-filter-action poi-list-filter-action--danger" data-action="delete-category" data-category-id="${escapeHtml(item.id)}" title="${t('poiPanel.deleteCategoryBtnTitle')}" aria-label="${t('poiPanel.deleteCategoryAriaLabel', { label: escapeHtml(item.label) })}">${iconDelete()}</button>
                  </div>`
                : ''
            }
          </div>`,
        )
        .join('')}
        <button type="button" class="poi-list-filter-add-category" data-action="add-category">
          <span class="poi-list-filter-add-category-icon" aria-hidden="true">${iconAdd()}</span>
          ${t('poiPanel.addCategory')}
        </button>`;
      categoryFilterMenu.querySelectorAll('.poi-list-filter-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          filterCategoryId = btn.getAttribute('data-category-id') || '';
          closeCategoryFilterMenu();
          syncCategoryFilterBtn();
          deselectPOI();
          rebuildList();
          refreshCategoryUi();
        });
      });
      categoryFilterMenu.querySelectorAll('[data-action="edit-category"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-category-id') || '';
          closeCategoryFilterMenu();
          openCategoryDialog('manage', id);
        });
      });
      categoryFilterMenu.querySelectorAll('[data-action="delete-category"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-category-id') || '';
          closeCategoryFilterMenu();
          void deleteCategoryById(id);
        });
      });
      categoryFilterMenu.querySelector('[data-action="add-category"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCategoryFilterMenu();
        openCategoryDialog('edit');
      });
    }
    syncCategoryFilterBtn();
  }

  function syncCategoryFilterBtn() {
    const active = Boolean(filterCategoryId);
    categoryFilterBtn?.classList.toggle('is-filtered', active);
    categoryFilterBtn?.setAttribute(
      'title',
      active
        ? t('poiPanel.filteredByCategory', { name: getCategoryById(filterCategoryId)?.name || t('poiPanel.categoryFallback') })
        : t('poiPanel.filterByCategory'),
    );
    if (categoryFilterDot) categoryFilterDot.hidden = !active;
  }

  function openCategoryFilterMenu() {
    if (!categoryFilterMenu) return;
    categoryFilterMenu.classList.remove('hidden');
    categoryFilterBtn?.setAttribute('aria-expanded', 'true');
    categoryFilterBtn?.classList.add('is-open');
  }

  function closeCategoryFilterMenu() {
    if (!categoryFilterMenu) return;
    categoryFilterMenu.classList.add('hidden');
    categoryFilterBtn?.setAttribute('aria-expanded', 'false');
    categoryFilterBtn?.classList.remove('is-open');
  }

  function toggleCategoryFilterMenu() {
    if (categoryFilterMenu?.classList.contains('hidden')) openCategoryFilterMenu();
    else closeCategoryFilterMenu();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function poiMatchesFilter(poi) {
    if (filterCategoryId && !poiCategoryIds(poi).includes(filterCategoryId)) return false;
    const q = filterSearchQuery.trim().toLowerCase();
    if (!q) return true;
    const name = String(poi.poi_name || '').toLowerCase();
    const desc = String(poi.description || '').toLowerCase();
    const localizedName = poiDisplayName(poi).toLowerCase();
    if (name.includes(q) || desc.includes(q) || localizedName.includes(q)) return true;
    const ids = poiCategoryIds(poi);
    return ids.some((id) => {
      const cat = getCategoryById(id);
      if (!cat) return false;
      return (
        String(cat.name || '').toLowerCase().includes(q) ||
        categoryDisplayName(cat).toLowerCase().includes(q)
      );
    });
  }

  function showMatterportPendingTabs() {
    return isMatterportMapActive() && isSuperAdminEditor();
  }

  function syncListModeTabs() {
    const show = showMatterportPendingTabs();
    listModeTabs?.classList.toggle('hidden', !show);
    if (!show && listMode !== 'all') {
      listMode = 'all';
    }
    listModeTabs?.querySelectorAll('[data-poi-list-mode]').forEach((btn) => {
      const mode = btn.getAttribute('data-poi-list-mode') || 'all';
      const active = mode === listMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  async function loadPendingMatterportTags() {
    if (!showMatterportPendingTabs()) {
      pendingMatterportTags = [];
      return;
    }
    const modelId = getActiveMatterportModelId();
    if (!modelId) {
      pendingMatterportTags = [];
      return;
    }
    pendingTagsLoading = true;
    rebuildList();
    try {
      const result = await fetchPendingMatterportTags(modelId);
      pendingMatterportTags = result.pending || [];
    } catch (err) {
      console.warn('[poi] pending tags', err);
      pendingMatterportTags = [];
      showToast(err?.message || t('poiPanel.loadPendingTagsError'), 'error');
    } finally {
      pendingTagsLoading = false;
      rebuildList();
    }
  }

  function rebuildList() {
    syncListModeTabs();
    listEl.innerHTML = '';

    if (listMode === 'pending' && showMatterportPendingTabs()) {
      if (pendingTagsLoading) {
        listEl.innerHTML = `<div class="category-empty">${t('poiPanel.loadingMatterportTags')}</div>`;
        return;
      }
      if (!pendingMatterportTags.length) {
        listEl.innerHTML = `<div class="category-empty">${t('poiPanel.noPendingMatterportTags')}</div>`;
        return;
      }
      pendingMatterportTags.forEach((tag) => {
        const item = document.createElement('div');
        item.className = 'poi-item poi-item--pending';
        const xyz = `${Number(tag.pos_x).toFixed(2)}, ${Number(tag.pos_y).toFixed(2)}, ${Number(tag.pos_z).toFixed(2)}`;
        item.innerHTML = `
          <button type="button" class="poi-item-main poi-item-main--static poi-item-main--pending-goto" title="${t('poiPanel.goToTagTitle')}">
            <span class="poi-item-label">${escapeHtml(String(tag.label || t('poiPanel.tagFallback')))}</span>
            <span class="poi-item-pending-meta">${t('poiPanel.pendingXyz', { xyz: escapeHtml(xyz) })}</span>
          </button>
          <button type="button" class="poi-item-edit-btn poi-item-accept-btn" title="${t('poiPanel.acceptAsPoiTitle')}" aria-label="${t('poiPanel.acceptAriaLabel', { label: escapeHtml(String(tag.label || t('poiPanel.tagFallbackLower'))) })}">
            ${t('poiPanel.acceptButton')}
          </button>
        `;
        item.querySelector('.poi-item-main--pending-goto')?.addEventListener('click', () => {
          const x = Number(tag.pos_x) || 0;
          const y = Number(tag.pos_y) || 0;
          const z = Number(tag.pos_z) || 0;
          listEl.querySelectorAll('.poi-item').forEach((el) => el.classList.remove('active'));
          item.classList.add('active');
          flyTo(x, y, z, {
            durationMs: isMatterportMapActive() ? 900 : undefined,
            sweepFrom: { x, y, z },
          });
        });
        item.querySelector('.poi-item-accept-btn')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          if (btn instanceof HTMLButtonElement) btn.disabled = true;
          try {
            const idx = await acceptMatterportTagAsPoi({
              tagId: String(tag.id),
              label: String(tag.label || 'POI'),
              description: String(tag.description || ''),
              pos_x: Number(tag.pos_x),
              pos_y: Number(tag.pos_y),
              pos_z: Number(tag.pos_z),
            });
            const live = poisData[idx];
            if (live) {
              void syncMatterportEntityTags({ pois: [live] });
            }
            showToast(t('poiPanel.acceptedAsPoi', { label: tag.label || t('poiPanel.tagFallbackLower') }), 'success');
            listMode = 'all';
            await loadPendingMatterportTags();
            rebuildList();
            onPoiListChange?.();
            if (idx >= 0) selectPOI(idx, { openEdit: true, fly: true });
          } catch (err) {
            showToast(err?.message || t('poiPanel.acceptFailed'), 'error');
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
          }
        });
        listEl.appendChild(item);
      });
      return;
    }

    poisData.forEach((poi, index) => {
      if (!poiMatchesFilter(poi)) return;
      const ids = poiCategoryIds(poi);
      const cat = getCategoryById(ids[0]);
      const extra = ids.length > 1 ? ` <span class="poi-item-cat-count">+${ids.length - 1}</span>` : '';
      const item = document.createElement('div');
      item.className = 'poi-item';
      item.dataset.index = String(index);
      const isSuper = isSuperAdminMapRole();
      item.innerHTML = `
        <button type="button" class="poi-item-main" data-index="${index}">
          ${
            cat
              ? `<span class="poi-item-icon">${renderCategoryIcon(cat.icon_key)}</span>`
              : ''
          }
          <span class="poi-item-label">${escapeHtml(poiDisplayName(poi))}${extra}</span>
        </button>
        ${
          isSuper
            ? `<div class="poi-item-edit-actions">
          <button type="button" class="poi-item-edit-btn poi-item-edit-nav" data-index="${index}" title="${t('poiPanel.editNavXyzTitle')}" aria-label="${t('poiPanel.editNavXyzAriaLabel', { name: escapeHtml(poiDisplayName(poi)) })}">
            ${t('poiPanel.navButton')}
          </button>
          <button type="button" class="poi-item-edit-btn poi-item-edit-expected" data-index="${index}" title="${t('poiPanel.editExpectedXyzTitle')}" aria-label="${t('poiPanel.editExpectedXyzAriaLabel', { name: escapeHtml(poiDisplayName(poi)) })}">
            ${t('poiPanel.expButton')}
          </button>
        </div>`
            : `<button type="button" class="poi-item-edit-btn" data-index="${index}" title="${t('poiPanel.editPoi')}" aria-label="${t('poiPanel.editPoiAriaLabel', { name: escapeHtml(poiDisplayName(poi)) })}">
          ${iconEdit()}
        </button>`
        }
      `;
      item.querySelector('.poi-item-main')?.addEventListener('click', () =>
        selectPOI(index, { openEdit: false }),
      );
      if (isSuper) {
        item.querySelector('.poi-item-edit-nav')?.addEventListener('click', (e) => {
          e.stopPropagation();
          selectPOI(index, { openEdit: true, fly: false, xyzTarget: 'nav' });
        });
        item.querySelector('.poi-item-edit-expected')?.addEventListener('click', (e) => {
          e.stopPropagation();
          selectPOI(index, { openEdit: true, fly: false, xyzTarget: 'expected' });
        });
      } else {
        item.querySelector('.poi-item-edit-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          selectPOI(index, { openEdit: true, fly: false });
        });
      }
      if (index === selectedIndex) item.classList.add('active');
      listEl.appendChild(item);
    });
    if (!listEl.children.length) {
      const emptyMsg =
        filterSearchQuery.trim() || filterCategoryId
          ? t('poiPanel.noPoisMatchSearch')
          : t('poiPanel.noPoisYet');
      listEl.innerHTML = `<div class="category-empty">${emptyMsg}</div>`;
    }
  }

  function updateCatIconPreview() {
    if (catIconPreviewEl) catIconPreviewEl.innerHTML = renderCategoryIcon(categoryDialogIconKey);
  }

  function renderCatIconGrid() {
    const query = catIconSearchInput?.value ?? '';
    const sections = getCategoryIconPickerSections(query);
    catIconGridEl.innerHTML = sections
      .map((section) => {
        const groupLabel = section.icons.length
          ? `<div class="category-icon-group-label">${escapeHtml(section.label)}</div>`
          : `<div class="category-icon-group-label category-icon-group-label--empty">${escapeHtml(section.label)}</div>`;
        const options = section.icons
          .map((opt) => {
            const active = opt.key === categoryDialogIconKey ? ' active' : '';
            return `<button type="button" class="category-icon-option${active}" data-icon-key="${opt.key}" title="${escapeHtml(opt.label)}" aria-label="${escapeHtml(opt.label)}">${renderCategoryIcon(opt.key)}</button>`;
          })
          .join('');
        return `<div class="category-icon-group">${groupLabel}<div class="category-icon-group-grid">${options}</div></div>`;
      })
      .join('');
    catIconGridEl.querySelectorAll('.category-icon-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        categoryDialogIconKey = btn.dataset.iconKey || getDefaultCategoryIconKey();
        updateCatIconPreview();
        renderCatIconGrid();
      });
    });
  }

  function syncCategoryDialogChrome() {
    const isEditing = Boolean(editingCategoryId);
    if (categoryDialogTitleEl) {
      categoryDialogTitleEl.textContent = isEditing
        ? t('poiPanel.editCategoryDialogTitle')
        : t('poiPanel.addCategoryDialogTitle');
    }
    if (btnSaveCategory) {
      btnSaveCategory.innerHTML = isEditing
        ? `<span class="icon">${iconSave()}</span> ${t('poiPanel.saveCategoryButton')}`
        : `<span class="icon">${iconAdd()}</span> ${t('poiPanel.addCategoryButton')}`;
    }
  }

  function openCategoryDialog(target = 'edit', categoryId = '') {
    categoryDialogTarget = target;
    editingCategoryId = String(categoryId || '');
    const existing = editingCategoryId ? getCategoryById(editingCategoryId) : null;
    if (existing) {
      categoryDialogIconKey = existing.icon_key || getDefaultCategoryIconKey();
      if (catNameInput) catNameInput.value = existing.name || '';
    } else {
      editingCategoryId = '';
      categoryDialogIconKey = getDefaultCategoryIconKey();
      if (catNameInput) catNameInput.value = '';
    }
    if (catIconSearchInput) catIconSearchInput.value = '';
    syncCategoryDialogChrome();
    updateCatIconPreview();
    renderCatIconGrid();
    categoryDialog.classList.remove('hidden');
    requestAnimationFrame(() => catNameInput?.focus());
  }

  function closeCategoryDialog() {
    categoryDialog.classList.add('hidden');
    editingCategoryId = '';
    syncCategoryDialogChrome();
  }

  function stripCategoryFromPois(categoryId) {
    const id = String(categoryId || '');
    if (!id) return;
    poisData.forEach((poi) => {
      const ids = Array.isArray(poi.category_ids)
        ? poi.category_ids.map(String).filter((cid) => cid && cid !== id)
        : [];
      poi.category_ids = ids;
      if (String(poi.category_type || '') === id) {
        poi.category_type = ids[0] ?? null;
      }
    });
    editSelectedCategoryIds = editSelectedCategoryIds.filter((cid) => cid !== id);
    addSelectedCategoryIds = addSelectedCategoryIds.filter((cid) => cid !== id);
    if (filterCategoryId === id) filterCategoryId = '';
  }

  async function deleteCategoryById(categoryId) {
    const id = String(categoryId || '');
    const index = categoriesData.findIndex((c) => String(c.id) === id);
    if (index < 0) return;
    const cat = categoriesData[index];
    const ok = await askConfirm({
      title: t('poiPanel.deleteCategoryTitle'),
      message: t('poiPanel.deleteCategoryMessage', { name: categoryDisplayName(cat) }),
      confirmLabel: t('poiPanel.deleteConfirmLabel'),
      cancelLabel: t('poiPanel.cancelButton'),
      danger: true,
    });
    if (!ok) return;
    try {
      await removeCategoryFromDb(index);
      deleteCategoryLocal(index);
      stripCategoryFromPois(id);
      refreshCategoryUi();
      rebuildList();
      if (selectedIndex >= 0) selectPOI(selectedIndex, { fly: false });
      onPoiListChange?.();
      showToast(t('poiPanel.categoryDeleted'), 'success');
    } catch (err) {
      console.error(err);
      showToast(err?.message || t('poiPanel.deleteCategoryError'), 'error');
    }
  }

  rebuildList();
  refreshCategoryUi();

  categoryFilterBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCategoryFilterMenu();
  });

  document.addEventListener(
    'click',
    (e) => {
      if (!categoryFilterMenu || categoryFilterMenu.classList.contains('hidden')) return;
      const t = e.target;
      if (categoryFilterMenu.contains(t) || categoryFilterBtn?.contains(t)) return;
      closeCategoryFilterMenu();
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCategoryFilterMenu();
  });

  searchInputEl?.addEventListener('input', () => {
    filterSearchQuery = searchInputEl.value || '';
    rebuildList();
  });

  btnHeaderAddPoi?.addEventListener('click', () => {
    onStartAddPoi?.();
  });
  listModeTabs?.querySelectorAll('[data-poi-list-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-poi-list-mode') === 'pending' ? 'pending' : 'all';
      if (mode === listMode) {
        if (mode === 'pending') void loadPendingMatterportTags();
        return;
      }
      listMode = mode;
      if (mode === 'pending') void loadPendingMatterportTags();
      else rebuildList();
    });
  });
  btnHeaderAddCategory?.addEventListener('click', () => openCategoryDialog('manage'));
  btnTranslateNames?.addEventListener('click', async () => {
    if (btnTranslateNames.disabled) return;
    const pending = poisData.filter((poi) => poiHasMissingNameTranslations(poi)).length;
    if (!pending) {
      showToast(t('poiPanel.allNamesTranslated'), 'info');
      return;
    }
    btnTranslateNames.disabled = true;
    btnTranslateNames.setAttribute('aria-busy', 'true');
    showToast(t('poiPanel.translatingNames', { pending }), 'info');
    try {
      const result = await translateMissingPoiNames(({ current, total, label }) => {
        btnTranslateNames.title = t('poiPanel.translatingProgress', { current, total, label });
      });
      consumeTranslationFailures();
      if (result.attempted === 0) {
        showToast(t('poiPanel.allNamesTranslated'), 'info');
      } else if (result.stillMissing) {
        showToast(
          t('poiPanel.translationPartial', {
            filledLangs: result.filledLangs || 0,
            translated: result.translated,
            stillMissing: result.stillMissing,
          }),
          'info',
        );
      } else {
        showToast(t('poiPanel.translationComplete', { translated: result.translated }), 'success');
      }
    } catch (err) {
      console.error(err);
      showToast(err?.message || t('poiPanel.translateNamesError'), 'error');
    } finally {
      btnTranslateNames.disabled = false;
      btnTranslateNames.removeAttribute('aria-busy');
      btnTranslateNames.title = t('poiPanel.translateNamesTitle');
    }
  });
  btnNewAddCategory?.addEventListener('click', () => openCategoryDialog('add'));

  categoryDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-cat"]')) closeCategoryDialog();
  });
  catIconSearchInput?.addEventListener('input', () => renderCatIconGrid());
  btnSaveCategory?.addEventListener('click', async () => {
    const name = catNameInput?.value.trim();
    if (!name) {
      showToast(t('poiPanel.enterCategoryName'), 'error');
      return;
    }
    btnSaveCategory.disabled = true;
    try {
      if (editingCategoryId) {
        const index = categoriesData.findIndex((c) => String(c.id) === String(editingCategoryId));
        if (index < 0) throw new Error(t('poiPanel.categoryNotFoundError'));
        categoriesData[index].name = name;
        categoriesData[index].icon_key = categoryDialogIconKey;
        await saveCategoryToDb(index, { translate: true });
        categoriesData.sort((a, b) => {
          const order = a.sort_order - b.sort_order;
          if (order !== 0) return order;
          return String(a.name).localeCompare(String(b.name));
        });
        refreshCategoryUi();
        rebuildList();
        if (selectedIndex >= 0) selectPOI(selectedIndex, { fly: false });
        closeCategoryDialog();
        showToast(t('poiPanel.categorySaved'), 'success');
        onPoiListChange?.();
        return;
      }

      await addCategoryWithDb({ name, icon_key: categoryDialogIconKey });
      const created = categoriesData.find(
        (c) => String(c.name).toLowerCase() === name.toLowerCase(),
      );
      const newId = created ? String(created.id) : '';
      if (newId) {
        if (categoryDialogTarget === 'add') {
          if (!addSelectedCategoryIds.includes(newId)) addSelectedCategoryIds.push(newId);
        } else if (!editSelectedCategoryIds.includes(newId)) {
          editSelectedCategoryIds.push(newId);
        }
      }
      refreshCategoryUi();
      rebuildList();
      closeCategoryDialog();
      showToast(t('poiPanel.categoryAdded'), 'success');
      onPoiListChange?.();
    } catch (err) {
      console.error(err);
      showToast(err?.message || (editingCategoryId ? t('poiPanel.saveCategoryError') : t('poiPanel.addCategoryError')), 'error');
    } finally {
      btnSaveCategory.disabled = false;
    }
  });

  function panelContains(target) {
    return (
      listPanel.contains(target) ||
      editDialog.contains(target) ||
      actionsPanel.contains(target)
    );
  }

  function isSceneViewportTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('#viewport-body') ||
        target.closest('#viewport-3d') ||
        target.tagName === 'CANVAS',
    );
  }

  function closeEditDialog() {
    const wasOpen = !editDialog.classList.contains('hidden');
    editDialog.classList.add('hidden');
    actionsPanel.classList.add('hidden');
    if (wasOpen) onEditOpenChange?.(false);
  }

  async function syncAssignRow() {
    if (!assignRow || !assignSelect) return;
    if (!isProjectAdminSession()) {
      assignRow.classList.add('hidden');
      return;
    }
    const session = getAuthSession();
    const poi = selectedIndex >= 0 ? poisData[selectedIndex] : null;
    if (!session?.poiType || !poi?.id) {
      assignRow.classList.add('hidden');
      return;
    }
    assignRow.classList.remove('hidden');
    try {
      const members = await adminListProjectMembers({
        email: session.email,
        password: session.password,
        poiType: session.poiType,
      });
      const subs = members.filter((m) => String(m.role) === 'sub_admin' && m.is_active);
      // Prefer explicit assignee; fall back to creator when the shop owner created the POI.
      const assigned = String(poi.assigned_to ?? '').trim();
      const createdBy = String(poi.created_by ?? '').trim();
      const subIds = new Set(subs.map((m) => String(m.account_id)));
      let current = '';
      if (assigned && subIds.has(assigned)) current = assigned;
      else if (createdBy && subIds.has(createdBy)) current = createdBy;

      assignSelect.innerHTML =
        `<option value="">${t('poiPanel.selectSubAdminOption')}</option>` +
        subs
          .map((m) => {
            const id = String(m.account_id);
            const name = String(m.display_name || m.email);
            const isCreator = createdBy && id === createdBy;
            const isAssignee = assigned && id === assigned;
            let suffix = '';
            if (isAssignee) suffix = ` ${t('poiPanel.assignedSuffix')}`;
            else if (isCreator) suffix = ` ${t('poiPanel.createdBySuffix')}`;
            return `<option value="${id}"${id === current ? ' selected' : ''}>${name}${suffix}</option>`;
          })
          .join('');
      if (current) assignSelect.value = current;
    } catch (err) {
      console.warn('[poi] could not load sub-admins for assign:', err);
      assignRow.classList.add('hidden');
    }
  }

  function openEditDialog() {
    closeAddDialog();
    const wasHidden = editDialog.classList.contains('hidden');
    editDialog.classList.remove('hidden');
    actionsPanel.classList.remove('hidden');
    if (wasHidden) onEditOpenChange?.(true);
    // Assign row can wait — don't block first paint of Edit.
    queueMicrotask(() => {
      void syncAssignRow();
    });
  }

  function isEditOpen() {
    return !editDialog.classList.contains('hidden');
  }

  listPanel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.poi-item')) return;
    deselectPOI();
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (listPanel.classList.contains('hidden') && editDialog.classList.contains('hidden')) return;
      if (isConfirmDialogTarget(e.target)) return;
      if (panelContains(e.target)) return;
      if (addDialog.contains(e.target)) return;
      if (categoryDialog.contains(e.target)) return;
      if (isSceneViewportTarget(e.target)) return;
      deselectPOI();
    },
    true,
  );

  function deselectPOI() {
    if (selectedIndex < 0) {
      closeEditDialog();
      return;
    }
    selectedIndex = -1;
    xyzEditTarget = 'nav';
    syncXyzModeUi();
    closeEditDialog();
    listEl.querySelectorAll('.poi-item').forEach((el) => el.classList.remove('active'));
    detachGizmo();
    onSelectionChange?.(-1);
  }

  function selectPOI(index, opts = {}) {
    selectedIndex = index;
    setLastPickedPoiIndex(index);
    const poi = poisData[index];

    listEl.querySelectorAll('.poi-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.index) === index);
    });

    selectedNameEl.textContent = poiDisplayName(poi);
    if (editDialogTitle) editDialogTitle.textContent = poiDisplayName(poi) || t('poiPanel.editPoi');
    // The input stays the English source: Save re-translates from it.
    inputName.value = poi.poi_name;
    inputDescription.value = poi.description ?? '';
    editSelectedCategoryIds = poiCategoryIds(poi);
    refreshCategoryUi();
    fillFloorSelect(editFloorSelect, poi.floor_id);
    // XYZ fields target nav or expected (super admin). Default nav for others.
    if (opts.xyzTarget === 'expected' || opts.xyzTarget === 'nav') {
      setXyzEditTarget(opts.xyzTarget, { fillInputs: false });
    } else if (!isSuperAdminMapRole()) {
      xyzEditTarget = 'nav';
    }
    syncXyzModeUi();
    fillXyzInputsFromPoi(poi);

    if (opts.openEdit === true) {
      openEditDialog();
      // Super-admin Nav/Exp opens Position fold so XYZ is immediately visible.
      if (opts.xyzTarget === 'nav' || opts.xyzTarget === 'expected') {
        const xyzDetails = editDialog.querySelector('.poi-xyz-block')?.closest('details');
        if (xyzDetails) xyzDetails.open = true;
      }
      // Focus after paint so opening Edit isn't delayed by input focus.
      requestAnimationFrame(() => inputName?.focus());
    } else {
      // Selecting any POI closes the edit sidebar.
      closeEditDialog();
    }

    // Matterport: one fade to the POI on select. Edit can still fly when opts.fly === true.
    const wantFly =
      opts.fly === true
        ? true
        : opts.fly === false
          ? false
          : opts.openEdit !== true &&
            (shouldUseMatterportCamera() || isMatterportMapActive());
    if (wantFly) {
      const lookPos = getPoiMapPosition(poi);
      const navPos = getPoiNavigationPosition(poi);
      flyTo(lookPos.x, lookPos.y, lookPos.z, {
        entityKind: 'poi',
        entityId: poi.id,
        durationMs: shouldUseMatterportCamera() || isMatterportMapActive() ? 900 : undefined,
        sweepFrom: navPos,
      });
    }

    const objs = getPOIObjects();
    // Mesh gizmo is armed via the Move POI bar (non-Matterport) — don't attach on select.
    detachGizmo();
    onSelectionChange?.(index);
  }

  function fillAddDialogDefaults({
    name = '',
    description = '',
    category_type = '',
    category_ids = null,
    x = 0,
    y = 0,
    z = 0,
    expected = null,
    normal = null,
  } = {}) {
    newPoiName.value = name;
    newPoiDescription.value = description;
    if (Array.isArray(category_ids) && category_ids.length) {
      addSelectedCategoryIds = category_ids.map(String);
    } else if (category_type) {
      addSelectedCategoryIds = [String(category_type)];
    } else {
      addSelectedCategoryIds = [];
    }
    refreshCategoryUi();
    newPoiX.value = Number(x).toFixed(4);
    newPoiY.value = Number(y).toFixed(4);
    newPoiZ.value = Number(z).toFixed(4);
    if (expected && Number.isFinite(Number(expected.x))) {
      pendingExpected = {
        x: Number(expected.x),
        y: Number(expected.y),
        z: Number(expected.z),
      };
    } else {
      pendingExpected = { x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 };
    }
    if (normal && Number.isFinite(Number(normal.x))) {
      const len = Math.hypot(Number(normal.x), Number(normal.y), Number(normal.z)) || 1;
      pendingNormal = {
        x: Number(normal.x) / len,
        y: Number(normal.y) / len,
        z: Number(normal.z) / len,
      };
    } else {
      pendingNormal = { x: 0, y: 1, z: 0 };
    }
    previewPinCommitted = false;
    scheduleMatterportPreviewPin();
  }

  function fillFloorSelect(selectEl, selectedId) {
    if (!selectEl) return;
    const current = String(selectedId ?? selectEl.value ?? '').trim();
    selectEl.innerHTML =
      `<option value="">${t('poiPanel.floorNone')}</option>` +
      floorsData
        .map((f) => {
          const id = String(f.id);
          const sel = id === current ? ' selected' : '';
          return `<option value="${id}"${sel}>${escapeAttr(f.name)}</option>`;
        })
        .join('');
    if (current && ![...selectEl.options].some((o) => o.value === current)) {
      // Floor missing from list (deleted) — keep None
      selectEl.value = '';
    } else {
      selectEl.value = current;
    }
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function openAddDialog(preset = {}) {
    deselectPOI();
    fillAddDialogDefaults(preset);
    fillFloorSelect(addFloorSelect, '');
    addDialog.classList.remove('hidden');
    requestAnimationFrame(() => newPoiName.focus());
  }

  function closeAddDialog() {
    addDialog.classList.add('hidden');
    pendingExpected = null;
    pendingNormal = null;
    if (previewPinTimer) {
      clearTimeout(previewPinTimer);
      previewPinTimer = null;
    }
    if (!previewPinCommitted && isMatterportMapActive()) {
      void clearMatterportPoiPreview();
    }
    previewPinCommitted = false;
  }

  addDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close"]')) closeAddDialog();
  });

  editDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) closeEditDialog();
  });
  actionsPanel.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) closeEditDialog();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !categoryDialog.classList.contains('hidden')) {
      if (isConfirmDialogOpen()) return;
      closeCategoryDialog();
      return;
    }
    if (e.key === 'Escape' && !addDialog.classList.contains('hidden')) {
      if (isConfirmDialogOpen()) return;
      closeAddDialog();
      return;
    }
    if (e.key === 'Escape' && !editDialog.classList.contains('hidden')) {
      if (isConfirmDialogOpen()) return;
      closeEditDialog();
    }
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let xyzSaveTimer = null;

  function applyXyzFromInputs({ save = false, syncScene = true } = {}) {
    if (selectedIndex < 0) return null;
    const x = parseFloat(inputX.value) || 0;
    const y = parseFloat(inputY.value) || 0;
    const z = parseFloat(inputZ.value) || 0;
    const editingExpected = xyzEditTarget === 'expected' && isSuperAdminMapRole();
    if (editingExpected) {
      updatePOIExpectedPosition(selectedIndex, x, y, z);
    } else {
      updatePOIPosition(selectedIndex, x, y, z);
    }
    const objs = getPOIObjects();
    const mapPos = getPoiMapPosition(poisData[selectedIndex]);
    if (objs[selectedIndex]?.label) {
      objs[selectedIndex].label.position.set(mapPos.x, mapPos.y + 0.85, mapPos.z);
    }
    if (syncScene && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('spacecheck-poi-dragging-xy', {
          detail: { index: selectedIndex, x, y, z, target: editingExpected ? 'expected' : 'nav' },
        }),
      );
    }
    if (isMatterportMapActive() && poisData[selectedIndex]) {
      void syncMatterportEntityTags({ pois: [poisData[selectedIndex]] });
    }
    if (save) {
      if (xyzSaveTimer) clearTimeout(xyzSaveTimer);
      xyzSaveTimer = setTimeout(() => {
        xyzSaveTimer = null;
        if (selectedIndex < 0) return;
        savePoiToDb(selectedIndex, { translate: false }).catch((err) =>
          console.error('[poi-panel] xyz auto-save:', err),
        );
      }, 280);
    }
    return { x, y, z };
  }

  for (const el of [inputX, inputY, inputZ]) {
    el?.addEventListener('input', () => applyXyzFromInputs({ save: false }));
    el?.addEventListener('change', () => applyXyzFromInputs({ save: true }));
  }

  assignBtn?.addEventListener('click', async () => {
    if (selectedIndex < 0) return;
    const session = getAuthSession();
    const poi = poisData[selectedIndex];
    const assigneeAccountId = String(assignSelect?.value ?? '').trim();
    if (!session || !poi?.id || !assigneeAccountId) {
      showToast(t('poiPanel.selectSubAdminToAssign'), 'error');
      return;
    }
    assignBtn.disabled = true;
    try {
      await projectAdminAssignEntity({
        email: session.email,
        password: session.password,
        table: 'navme_pois',
        rowId: poi.id,
        assigneeAccountId,
      });
      poisData[selectedIndex].assigned_to = assigneeAccountId;
      showToast(t('poiPanel.poiAssigned'), 'success');
      void syncAssignRow();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    } finally {
      assignBtn.disabled = false;
    }
  });

  btnSave.addEventListener('click', async () => {
    if (selectedIndex < 0) return;
    const name = inputName.value.trim();
    const description = inputDescription.value.trim();
    // XYZ auto-saves from the position fields — this button saves name / description / categories.
    applyXyzFromInputs({ save: true, syncScene: true });
    if (name) {
      updatePOIName(selectedIndex, name);
      selectedNameEl.textContent = name;
      if (editDialogTitle) editDialogTitle.textContent = name || t('poiPanel.editPoi');
    }
    updatePOIDescription(selectedIndex, description);
    poisData[selectedIndex].category_ids = [...editSelectedCategoryIds];
    poisData[selectedIndex].category_type = editSelectedCategoryIds[0] ?? null;
    const floorVal = String(editFloorSelect?.value ?? '').trim();
    poisData[selectedIndex].floor_id = floorVal || null;
    rebuildList();
    selectPOI(selectedIndex, { fly: false });

    btnSave.disabled = true;
    btnSave.textContent = t('poiPanel.translatingEllipsis');
    try {
      await savePoiToDb(selectedIndex, { translate: true });
      onPoiListChange?.();
      btnSave.textContent = t('poiPanel.savedButton');
      const failed = consumeTranslationFailures();
      if (failed.length) {
        showToast(t('poiPanel.poiSavedTranslationFailed'), 'info');
      } else {
        showToast(t('poiPanel.savedWithTranslations'), 'success');
      }
    } catch (err) {
      console.error(err);
      btnSave.textContent = t('poiPanel.retryButton');
      showToast(err?.message || t('poiPanel.saveTranslationFailed'), 'error');
    } finally {
      setTimeout(() => {
        btnSave.disabled = false;
        btnSave.innerHTML = `<span class="icon">${iconSave()}</span> ${t('poiPanel.saveDetailsButton')}`;
      }, 1400);
    }
  });

  btnAdd.addEventListener('click', async () => {
    const name = newPoiName.value.trim() || DEFAULT_NEW_POI_NAME;
    const description = newPoiDescription.value.trim();
    const x = parseFloat(newPoiX.value) || 0;
    const y = parseFloat(newPoiY.value) || 0;
    const z = parseFloat(newPoiZ.value) || 0;
    btnAdd.disabled = true;
    try {
      const idx = await addPOIWithDb({
        poi_name: name,
        description,
        category_ids: [...addSelectedCategoryIds],
        category_type: addSelectedCategoryIds[0] ?? null,
        floor_id: String(addFloorSelect?.value ?? '').trim() || null,
        pos_x: x,
        pos_y: y,
        pos_z: z,
        expected_pos_x: pendingExpected?.x ?? x,
        expected_pos_y: pendingExpected?.y ?? y,
        expected_pos_z: pendingExpected?.z ?? z,
        expected_normal_x: pendingNormal?.x ?? 0,
        expected_normal_y: pendingNormal?.y ?? 1,
        expected_normal_z: pendingNormal?.z ?? 0,
      });
      rebuildList();
      selectPOI(idx, { fly: isMatterportMapActive() });
      if (isMatterportMapActive() && poisData[idx]) {
        previewPinCommitted = true;
        await commitMatterportPoiPin(poisData[idx]);
      }
      closeAddDialog();
      onPoiListChange?.();
      if (isMatterportMapActive()) {
        showToast(t('poiPanel.poiAddedMatterport'), 'success');
      } else {
        showToast(t('poiPanel.poiAddedGizmo'), 'success');
      }
    } catch (err) {
      console.error(err);
      alert(t('poiPanel.couldNotAddPoi', { message: err.message }));
    } finally {
      btnAdd.disabled = false;
    }
  });

  btnDelete.addEventListener('click', async () => {
    if (selectedIndex < 0) return;
    const index = selectedIndex;
    const name = poisData[index] ? poiDisplayName(poisData[index]) : t('poiPanel.thisPoiFallback');
    const ok = await askConfirm({
      title: t('poiPanel.deletePoiConfirmTitle'),
      message: t('poiPanel.deletePoiConfirmMessage', { name }),
      confirmLabel: t('poiPanel.deleteConfirmLabel'),
      cancelLabel: t('poiPanel.cancelButton'),
      danger: true,
    });
    if (!ok) return;
    if (index < 0 || index >= poisData.length) return;
    btnDelete.disabled = true;
    const removedId = poisData[index]?.id;
    try {
      await removePoiFromDb(index);
    } catch (err) {
      console.error(err);
    }
    deletePOI(index);
    if (isMatterportMapActive() && removedId != null) {
      void removeMatterportEntityTag('poi', removedId);
    }
    detachGizmo();
    selectedIndex = -1;
    closeEditDialog();
    listEl.querySelectorAll('.poi-item').forEach((el) => el.classList.remove('active'));
    onSelectionChange?.(-1);
    rebuildList();
    onPoiListChange?.();
    btnDelete.disabled = false;
  });

  function wirePoiGizmoHandlers() {
    setGizmoDragCallback((transform) => {
      if (selectedIndex < 0) return;
      const pos = transform.position;
      inputX.value = pos.x.toFixed(4);
      inputY.value = pos.y.toFixed(4);
      inputZ.value = pos.z.toFixed(4);
      const editingExpected = xyzEditTarget === 'expected' && isSuperAdminMapRole();
      if (editingExpected) {
        updatePOIExpectedPosition(selectedIndex, pos.x, pos.y, pos.z);
      } else {
        updatePOIPosition(selectedIndex, pos.x, pos.y, pos.z);
      }

      const objs = getPOIObjects();
      const mapPos = getPoiMapPosition(poisData[selectedIndex]);
      if (objs[selectedIndex]) {
        objs[selectedIndex].label.position.set(mapPos.x, mapPos.y + 0.85, mapPos.z);
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('spacecheck-poi-dragging-xy', {
            detail: {
              index: selectedIndex,
              x: pos.x,
              y: pos.y,
              z: pos.z,
              target: editingExpected ? 'expected' : 'nav',
            },
          }),
        );
      }
    });

    setGizmoDragEndCallback(() => {
      if (selectedIndex < 0) return;
      const idx = selectedIndex;
      const p = poisData[idx];
      const editingExpected = xyzEditTarget === 'expected' && isSuperAdminMapRole();
      if (p && typeof window !== 'undefined') {
        const pos = editingExpected ? getPoiExpectedPosition(p) : getPoiNavigationPosition(p);
        window.dispatchEvent(
          new CustomEvent('spacecheck-poi-moved-xy', {
            detail: {
              index: idx,
              x: pos.x,
              y: pos.y,
              z: pos.z,
              target: editingExpected ? 'expected' : 'nav',
            },
          }),
        );
      }
      savePoiToDb(selectedIndex, { translate: false }).catch((err) =>
        console.error('[poi-panel] save after gizmo:', err),
      );
    });
  }

  wirePoiGizmoHandlers();

  function onExternalPoiXY(ev) {
    const d = ev.detail;
    if (!d || typeof d.index !== 'number') return;
    if (selectedIndex !== d.index) return;
    inputX.value = Number(d.x).toFixed(4);
    inputY.value = Number(d.y).toFixed(4);
    inputZ.value = Number(d.z).toFixed(4);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('spacecheck-poi-dragging-xy', onExternalPoiXY);
    window.addEventListener('spacecheck-poi-moved-xy', onExternalPoiXY);
  }

  return {
    show() {
      listPanel.classList.remove('hidden');
      wirePoiGizmoHandlers();
      syncListModeTabs();
      if (listMode === 'pending') void loadPendingMatterportTags();
      else rebuildList();
    },
    wireGizmoHandlers: wirePoiGizmoHandlers,
    hide() {
      listPanel.classList.add('hidden');
      deselectPOI();
    },
    deselect() {
      deselectPOI();
    },
    selectByIndex(index, opts = {}) {
      if (index >= 0 && index < poisData.length) selectPOI(index, opts);
    },
    getSelectedIndex() {
      return selectedIndex;
    },
    /** Attach translate gizmo for mesh-map Move POI (no-op on Matterport). */
    startMeshMove() {
      if (shouldUseMatterportCamera()) return false;
      if (selectedIndex < 0) return false;
      const objs = getPOIObjects();
      const editingExpected = xyzEditTarget === 'expected' && isSuperAdminMapRole();
      let mesh = null;
      if (editingExpected) {
        mesh = ensureExpectedMesh(selectedIndex) ?? objs[selectedIndex]?.expectedMesh;
      } else {
        mesh = objs[selectedIndex]?.mesh;
      }
      if (!mesh) return false;
      attachGizmo(mesh);
      return true;
    },
    stopMeshMove() {
      detachGizmo();
    },
    isEditOpen,
    getXyzEditTarget() {
      return xyzEditTarget === 'expected' && isSuperAdminMapRole() ? 'expected' : 'nav';
    },
    setXyzEditTarget(target) {
      setXyzEditTarget(target === 'expected' ? 'expected' : 'nav');
    },
    refresh() {
      refreshCategoryUi();
      rebuildList();
      if (selectedIndex >= 0 && selectedIndex < poisData.length) {
        // Keep Edit open across refresh (panel switch used to close it).
        selectPOI(selectedIndex, { fly: false, openEdit: isEditOpen() });
      } else {
        selectedIndex = -1;
        closeEditDialog();
        detachGizmo();
      }
    },
    refreshFloorOptions() {
      const editVal =
        selectedIndex >= 0
          ? poisData[selectedIndex]?.floor_id
          : editFloorSelect?.value;
      fillFloorSelect(editFloorSelect, editVal);
      fillFloorSelect(addFloorSelect, addFloorSelect?.value);
    },
    openAddDialog,
    /** @deprecated Use openAddDialog — opens the add dialog at origin. */
    addDefaultPoiAtOrigin() {
      openAddDialog({ x: 0, y: 0, z: 0, name: '' });
    },
  };
}
