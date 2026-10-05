/**
 * Category management panel — list in drawer, edit/create in popup drawer.
 */
import {
  categoriesData,
  addCategoryWithDb,
  saveCategoryToDb,
  removeCategoryFromDb,
  deleteCategoryLocal,
  categoryDisplayName,
} from '../ar/categories.js';
import {
  getCategoryIconPickerSections,
  getDefaultCategoryIconKey,
  renderCategoryIcon,
} from '../config/category-icons.js';
import { iconSave, iconDelete, iconAdd } from './icons.js';
import { showToast } from './toast.js';
import { askConfirm } from './confirm-dialog.js';
import { t } from '../config/i18n.js';

let selectedIndex = -1;
let selectedIconKey = getDefaultCategoryIconKey();

/**
 * @param {HTMLElement} container
 * @param {{ onCategoriesChange?: () => void }} [options]
 */
export function createCategoryPanel(container, options = {}) {
  const onCategoriesChange = options.onCategoriesChange;

  const listPanel = document.createElement('div');
  listPanel.className = 'scene-float-panel scene-float-panel--list float-glass drawer-frost hidden';
  listPanel.id = 'category-list-panel';

  listPanel.innerHTML = `
    <div class="poi-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${t('categoryPanel.title')}</div>
        <button type="button" class="admin-refresh-btn category-add-btn" id="category-add-btn" title="${t('categoryPanel.newCategoryTitle')}" aria-label="${t('categoryPanel.newCategoryTitle')}">
          ${iconAdd()}
        </button>
      </div>
      <p class="category-panel-hint">${t('categoryPanel.listHint')}</p>
    </div>
    <div class="category-list" id="category-list"></div>
  `;

  container.appendChild(listPanel);

  const editDialog = document.createElement('div');
  editDialog.className = 'poi-add-dialog poi-edit-dialog hidden';
  editDialog.id = 'category-edit-dialog';
  editDialog.setAttribute('role', 'dialog');
  editDialog.setAttribute('aria-modal', 'true');
  editDialog.setAttribute('aria-labelledby', 'category-edit-dialog-title');
  editDialog.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close-edit"></div>
    <div class="poi-add-dialog-card poi-edit-dialog-card float-glass">
      <div class="poi-add-dialog-header">
        <h3 class="poi-add-dialog-title" id="category-edit-dialog-title">${t('categoryPanel.editCategoryTitle')}</h3>
        <button type="button" class="poi-add-dialog-close" data-action="close-edit" aria-label="${t('categoryPanel.closeLabel')}">&times;</button>
      </div>
      <div class="poi-edit-dialog-body">
        <div class="category-editor" id="category-editor">
          <div class="coord-group poi-add-field">
            <span class="field-label">${t('categoryPanel.categoryNameLabel')}</span>
            <input type="text" id="category-name" placeholder="${t('categoryPanel.categoryNamePlaceholder')}" />
          </div>
          <div class="coord-group poi-add-field">
            <span class="field-label">${t('categoryPanel.iconLabel')}</span>
            <div class="category-icon-toolbar">
              <div class="category-icon-preview" id="category-icon-preview"></div>
              <input
                type="search"
                id="category-icon-search"
                class="category-icon-search"
                placeholder="${t('categoryPanel.searchIconsPlaceholder')}"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="category-icon-picker">
              <div class="category-icon-grid" id="category-icon-grid" role="listbox" aria-label="${t('categoryPanel.categoryIconAriaLabel')}"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="poi-add-dialog-actions poi-edit-dialog-actions" id="category-actions-row">
        <button type="button" class="btn-save btn-delete btn-delete-poi poi-btn-delete" id="btn-delete-category" title="${t('categoryPanel.deleteCategoryTitle')}" aria-label="${t('categoryPanel.deleteCategoryTitle')}">
          ${iconDelete()}
        </button>
        <button type="button" class="btn-secondary" data-action="close-edit">${t('categoryPanel.cancel')}</button>
        <button type="button" class="btn-save poi-btn-save" id="btn-save-category">
          <span class="icon">${iconSave()}</span> ${t('categoryPanel.saveChanges')}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(editDialog);

  const listEl = listPanel.querySelector('#category-list');
  const editorTitleEl = editDialog.querySelector('#category-edit-dialog-title');
  const nameInput = editDialog.querySelector('#category-name');
  const iconPreviewEl = editDialog.querySelector('#category-icon-preview');
  const iconSearchInput = editDialog.querySelector('#category-icon-search');
  const iconGridEl = editDialog.querySelector('#category-icon-grid');
  const btnSave = editDialog.querySelector('#btn-save-category');
  const btnDelete = editDialog.querySelector('#btn-delete-category');
  const addCategoryBtn = listPanel.querySelector('#category-add-btn');

  let creatingNew = false;

  function closeEditDialog() {
    editDialog.classList.add('hidden');
  }

  function openEditDialog() {
    editDialog.classList.remove('hidden');
  }

  function renderIconOption(opt) {
    const active = opt.key === selectedIconKey ? ' active' : '';
    return `<button type="button" class="category-icon-option${active}" data-icon-key="${opt.key}" title="${escapeHtml(opt.label)}" aria-label="${escapeHtml(opt.label)}">${renderCategoryIcon(opt.key)}</button>`;
  }

  function renderIconGrid() {
    const query = iconSearchInput?.value ?? '';
    const sections = getCategoryIconPickerSections(query);

    iconGridEl.innerHTML = sections
      .map((section) => {
        const groupLabel = section.icons.length
          ? `<div class="category-icon-group-label">${escapeHtml(section.label)}</div>`
          : `<div class="category-icon-group-label category-icon-group-label--empty">${escapeHtml(section.label)}</div>`;
        const options = section.icons.map((opt) => renderIconOption(opt)).join('');
        return `<div class="category-icon-group" data-group-id="${section.id}">${groupLabel}<div class="category-icon-group-grid">${options}</div></div>`;
      })
      .join('');

    iconGridEl.querySelectorAll('.category-icon-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedIconKey = btn.dataset.iconKey || getDefaultCategoryIconKey();
        renderIconGrid();
        updateIconPreview();
      });
    });
  }

  function updateIconPreview() {
    iconPreviewEl.innerHTML = renderCategoryIcon(selectedIconKey);
  }

  function rebuildList() {
    listEl.innerHTML = '';
    if (!categoriesData.length) {
      listEl.innerHTML = `<div class="category-empty">${t('categoryPanel.emptyListMessage')}</div>`;
      return;
    }

    categoriesData.forEach((cat, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'category-item poi-item';
      item.dataset.index = String(index);
      item.innerHTML = `
        <span class="category-item-icon">${renderCategoryIcon(cat.icon_key)}</span>
        <span class="category-item-name">${escapeHtml(categoryDisplayName(cat))}</span>
      `;
      item.classList.toggle('active', index === selectedIndex);
      item.addEventListener('click', () => selectCategory(index));
      listEl.appendChild(item);
    });
  }

  function clearEditor() {
    selectedIndex = -1;
    creatingNew = false;
    closeEditDialog();
    listEl.querySelectorAll('.category-item').forEach((el) => el.classList.remove('active'));
  }

  function openEditor({ index = -1, isNew = false } = {}) {
    creatingNew = isNew;
    selectedIndex = index;
    openEditDialog();

    if (isNew) {
      editorTitleEl.textContent = t('categoryPanel.newCategoryTitle');
      nameInput.value = '';
      selectedIconKey = getDefaultCategoryIconKey();
      if (iconSearchInput) iconSearchInput.value = '';
      btnDelete.title = t('categoryPanel.cancelNewCategory');
      btnDelete.setAttribute('aria-label', t('categoryPanel.cancelNewCategory'));
    } else {
      const cat = categoriesData[index];
      if (!cat) return;
      editorTitleEl.textContent = t('categoryPanel.editCategoryTitle');
      nameInput.value = cat.name;
      selectedIconKey = cat.icon_key || getDefaultCategoryIconKey();
      btnDelete.title = t('categoryPanel.deleteCategoryTitle');
      btnDelete.setAttribute('aria-label', t('categoryPanel.deleteCategoryTitle'));
    }

    renderIconGrid();
    updateIconPreview();
    rebuildList();
    requestAnimationFrame(() => nameInput.focus());
  }

  function selectCategory(index) {
    openEditor({ index, isNew: false });
  }

  addCategoryBtn.addEventListener('click', () => openEditor({ isNew: true }));

  iconSearchInput?.addEventListener('input', () => renderIconGrid());

  editDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-edit"]')) {
      clearEditor();
      rebuildList();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editDialog.classList.contains('hidden')) {
      clearEditor();
      rebuildList();
    }
  });

  btnSave.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast(t('categoryPanel.categoryNameRequiredToast'), 'error');
      return;
    }

    btnSave.disabled = true;
    try {
      if (creatingNew) {
        const idx = await addCategoryWithDb({
          name,
          icon_key: selectedIconKey,
        });
        creatingNew = false;
        selectedIndex = idx;
        showToast(t('categoryPanel.categoryCreatedToast'), 'success');
      } else if (selectedIndex >= 0) {
        const cat = categoriesData[selectedIndex];
        cat.name = name;
        cat.icon_key = selectedIconKey;
        await saveCategoryToDb(selectedIndex);
        sortCategoriesLocal();
        showToast(t('categoryPanel.categorySavedToast'), 'success');
      }
      rebuildList();
      openEditor({ index: selectedIndex, isNew: false });
      onCategoriesChange?.();
    } catch (err) {
      console.error(err);
      showToast(err.message ?? t('categoryPanel.failedToSaveToast'), 'error');
    } finally {
      btnSave.disabled = false;
    }
  });

  btnDelete.addEventListener('click', async () => {
    if (creatingNew || selectedIndex < 0) {
      clearEditor();
      rebuildList();
      return;
    }
    const index = selectedIndex;
    const cat = categoriesData[index];
    if (!cat) return;
    const ok = await askConfirm({
      title: t('categoryPanel.deleteConfirmTitle'),
      message: t('categoryPanel.deleteConfirmMessage', { name: categoryDisplayName(cat) }),
      confirmLabel: t('categoryPanel.deleteConfirmLabel'),
      cancelLabel: t('categoryPanel.cancel'),
      danger: true,
    });
    if (!ok) return;

    btnDelete.disabled = true;
    try {
      await removeCategoryFromDb(index);
      deleteCategoryLocal(index);
      clearEditor();
      rebuildList();
      onCategoriesChange?.();
      showToast(t('categoryPanel.categoryDeletedToast'), 'success');
    } catch (err) {
      console.error(err);
      showToast(err.message ?? t('categoryPanel.failedToDeleteToast'), 'error');
    } finally {
      btnDelete.disabled = false;
    }
  });

  function sortCategoriesLocal() {
    categoriesData.sort((a, b) => {
      const order = a.sort_order - b.sort_order;
      if (order !== 0) return order;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  rebuildList();
  renderIconGrid();

  return {
    show() {
      listPanel.classList.remove('hidden');
      rebuildList();
    },
    hide() {
      listPanel.classList.add('hidden');
      clearEditor();
    },
    refresh() {
      rebuildList();
      if (selectedIndex >= 0 && selectedIndex < categoriesData.length) {
        selectCategory(selectedIndex);
      } else {
        clearEditor();
      }
    },
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
