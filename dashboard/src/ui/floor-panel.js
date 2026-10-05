/**
 * Floors panel — super admin only.
 * Opens at camera Y with a light slice plane; name + assign in the drawer.
 * Assign UI mirrors destination-search: search + category pills + POI rows with select.
 */
import {
  floorsData,
  addFloorWithDb,
  saveFloorToDb,
  removeFloorFromDb,
  hydrateFloorsFromSupabase,
} from '../ar/floors.js';
import { poisData, poiDisplayName } from '../ar/pois.js';
import { categoriesData, categoryDisplayName, getCategoryById } from '../ar/categories.js';
import { updatePoiRow } from '../services/supabase.js';
import { renderCategoryIcon } from '../config/category-icons.js';
import {
  getCamera,
  addFloorMarker,
  attachFloorGizmo,
  detachFloorGizmo,
  removeFloorMarker,
  getFloorMarkerY,
  constrainFloorMarkerXZ,
  setGizmoDragCallback,
  setGizmoDragEndCallback,
  detachGizmo,
} from '../ar/scene.js';
import { iconSave, iconDelete, iconAdd, iconFloorPlan } from './icons.js';
import { showToast } from './toast.js';
import { consumeTranslationFailures } from '../services/poi-translate.js';
import { askConfirm } from './confirm-dialog.js';
import { t } from '../config/i18n.js';

/**
 * @param {HTMLElement} container
 * @param {{ onFloorsChange?: () => void }} [options]
 */
export function createFloorPanel(container, options = {}) {
  const onFloorsChange = options.onFloorsChange;

  const listPanel = document.createElement('div');
  listPanel.className =
    'scene-float-panel scene-float-panel--list float-glass drawer-frost floor-panel hidden';
  listPanel.id = 'floor-list-panel';
  listPanel.innerHTML = `
    <div class="floor-panel-header">
      <div class="floor-panel-header-row">
        <div class="floor-panel-title-wrap">
          <span class="floor-panel-kicker">${t('floorPanel.kickerSuperAdmin')}</span>
          <div class="floor-panel-title">${t('floorPanel.title')}</div>
        </div>
        <button type="button" class="floor-add-btn" id="floor-add-btn" title="${t('floorPanel.addFloor')}" aria-label="${t('floorPanel.addFloor')}">
          ${iconAdd()}
          <span>${t('floorPanel.addFloor')}</span>
        </button>
      </div>
      <p class="floor-panel-hint">${t('floorPanel.addFloorHint')}</p>
    </div>
    <div class="floor-list" id="floor-list"></div>
  `;
  container.appendChild(listPanel);

  const detailsPanel = document.createElement('div');
  detailsPanel.className =
    'scene-float-panel scene-float-panel--edit float-glass drawer-frost floor-details hidden';
  detailsPanel.id = 'floor-details-panel';
  detailsPanel.innerHTML = `
    <div class="floor-details-header">
      <button type="button" class="floor-back-btn" id="floor-details-back" aria-label="${t('floorPanel.back')}">←</button>
      <div class="floor-details-titles">
        <span class="floor-panel-kicker" id="floor-details-step">${t('floorPanel.stepNameAssign')}</span>
        <div class="floor-panel-title" id="floor-details-title">${t('floorPanel.newFloor')}</div>
      </div>
    </div>
    <div class="floor-details-body">
      <div class="floor-y-chip" id="floor-y-chip" aria-live="polite">
        <span class="floor-y-chip-label">${t('floorPanel.sliceY')}</span>
        <strong class="floor-y-chip-value" id="floor-details-y">0.00</strong>
        <button type="button" class="floor-y-chip-btn" id="floor-readjust-slice">${t('floorPanel.adjustPlane')}</button>
      </div>
      <label class="floor-field">
        <span class="floor-field-label">${t('floorPanel.floorNameLabel')}</span>
        <input type="text" id="floor-name-input" class="floor-field-input" placeholder="${t('floorPanel.floorNamePlaceholder')}" autocomplete="off" />
      </label>
      <div class="floor-assign-block">
        <div class="floor-assign-head">
          <span class="floor-field-label">${t('floorPanel.assignPois')}</span>
          <button type="button" class="floor-text-btn" id="floor-select-all-pois">${t('floorPanel.selectAll')}</button>
        </div>
        <input type="text" id="floor-poi-search" class="floor-dest-search-input" placeholder="${t('floorPanel.searchDestinationsPlaceholder')}" autocomplete="off" />
        <div class="floor-dest-categories-row">
          <div id="floor-category-assign" class="floor-dest-categories" role="tablist" aria-label="${t('floorPanel.categoriesAriaLabel')}"></div>
          <div class="floor-dest-category-more-wrap" id="floor-category-more-wrap" hidden>
            <button type="button" class="floor-dest-category-more" id="floor-category-more" aria-label="${t('floorPanel.allCategoriesAriaLabel')}" aria-expanded="false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="floor-dest-category-dropdown" id="floor-category-dropdown" role="listbox" hidden></div>
          </div>
        </div>
        <div id="floor-poi-assign" class="floor-poi-assign floor-dest-poi-list" role="group" aria-label="${t('floorPanel.poisAriaLabel')}"></div>
      </div>
    </div>
    <div class="floor-details-actions">
      <button type="button" class="btn-secondary" id="floor-details-cancel">${t('floorPanel.cancel')}</button>
      <button type="button" class="btn-save floor-save-btn" id="floor-save-btn">
        <span class="icon">${iconSave()}</span> ${t('floorPanel.saveFloor')}
      </button>
    </div>
  `;
  container.appendChild(detailsPanel);

  /** @type {number} */
  let editingIndex = -1;
  /** @type {Set<string>} */
  let selectedPoiIds = new Set();
  /** @type {string | null} null = All */
  let selectedCategoryId = null;
  /** @type {import('three').Group | null} */
  let sliceMarker = null;
  let lockX = 0;
  let lockZ = 0;
  let sliceYValue = 0;
  let yLabelRaf = 0;
  let pendingYLabel = null;

  const listEl = listPanel.querySelector('#floor-list');
  const addBtn = listPanel.querySelector('#floor-add-btn');
  const nameInput = detailsPanel.querySelector('#floor-name-input');
  const detailsYEl = detailsPanel.querySelector('#floor-details-y');
  const detailsTitle = detailsPanel.querySelector('#floor-details-title');
  const searchInput = detailsPanel.querySelector('#floor-poi-search');
  const catHost = detailsPanel.querySelector('#floor-category-assign');
  const poiHost = detailsPanel.querySelector('#floor-poi-assign');
  const moreWrap = detailsPanel.querySelector('#floor-category-more-wrap');
  const moreBtn = detailsPanel.querySelector('#floor-category-more');
  const dropdownEl = detailsPanel.querySelector('#floor-category-dropdown');
  const selectAllBtn = detailsPanel.querySelector('#floor-select-all-pois');
  const saveBtn = detailsPanel.querySelector('#floor-save-btn');

  /** @type {Map<string, string>} */
  const iconHtmlCache = new Map();
  /** @type {Map<string, HTMLButtonElement>} */
  const poiRowById = new Map();
  /** @type {Map<string, Set<string>>} */
  const poiCatIdsById = new Map();
  /** @type {Map<string, string>} */
  const poiNameLowerById = new Map();
  let searchFilterRaf = 0;
  let assignBuildToken = 0;

  function closeCategoryDropdown() {
    if (!dropdownEl || !moreBtn) return;
    dropdownEl.hidden = true;
    moreBtn.classList.remove('is-open');
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleCategoryDropdown() {
    if (!dropdownEl || !moreBtn || moreWrap?.hidden) return;
    const open = dropdownEl.hidden;
    dropdownEl.hidden = !open;
    moreBtn.classList.toggle('is-open', open);
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /** @param {string | null | undefined} key */
  function cachedCategoryIcon(key) {
    const k = String(key ?? 'map-pin');
    let html = iconHtmlCache.get(k);
    if (html == null) {
      html = renderCategoryIcon(k);
      iconHtmlCache.set(k, html);
    }
    return html;
  }

  /** @param {any} poi */
  function collectPoiCategoryIds(poi) {
    /** @type {Set<string>} */
    const set = new Set();
    const type = String(poi.category_type ?? '');
    if (type) set.add(type);
    if (Array.isArray(poi.category_ids)) {
      for (const id of poi.category_ids) {
        const s = String(id ?? '');
        if (s) set.add(s);
      }
    }
    return set;
  }

  /** @param {string | null} catId */
  function selectCategory(catId) {
    const next = catId == null || catId === '' ? null : String(catId);
    if (selectedCategoryId === next) return;
    selectedCategoryId = next;
    closeCategoryDropdown();
    syncCategoryActiveState();
    applyAssignFilter();
    const activePill = catHost?.querySelector(
      `.floor-dest-category-pill[data-category-id="${next ?? ''}"]`,
    );
    activePill?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  function syncCategoryActiveState() {
    const activeId = selectedCategoryId ?? '';
    catHost?.querySelectorAll('.floor-dest-category-pill').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const id = el.dataset.categoryId ?? '';
      const active = activeId === id;
      el.classList.toggle('floor-dest-category-pill--active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    dropdownEl?.querySelectorAll('.floor-dest-category-dropdown-item').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const id = el.dataset.categoryId ?? '';
      const active = activeId === id;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  /** @param {HTMLButtonElement} row @param {boolean} selected */
  function paintRowSelected(row, selected) {
    row.classList.toggle('is-selected', selected);
    row.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb instanceof HTMLInputElement) cb.checked = selected;
  }

  /** @param {string} id @param {boolean} selected */
  function setPoiSelected(id, selected) {
    if (selected) selectedPoiIds.add(id);
    else selectedPoiIds.delete(id);
    const row = poiRowById.get(id);
    if (row) paintRowSelected(row, selected);
  }

  function applyAssignFilter() {
    if (!poiHost) return;
    const q = String(searchInput?.value ?? '')
      .trim()
      .toLowerCase();
    let visibleCount = 0;
    let selectedVisible = 0;

    for (const [id, row] of poiRowById) {
      const cats = poiCatIdsById.get(id);
      const matchCat = !selectedCategoryId || (cats != null && cats.has(selectedCategoryId));
      const nameLower = poiNameLowerById.get(id) ?? '';
      const matchQ = !q || nameLower.includes(q);
      const show = Boolean(matchCat && matchQ);
      if (row.hidden === show) row.hidden = !show;
      if (show) {
        visibleCount += 1;
        if (selectedPoiIds.has(id)) selectedVisible += 1;
      }
    }

    let empty = poiHost.querySelector('.floor-dest-poi-empty');
    if (visibleCount === 0) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'floor-dest-poi-empty';
        empty.textContent = t('floorPanel.noDestinationsMatch');
        poiHost.appendChild(empty);
      }
      empty.hidden = false;
    } else if (empty) {
      empty.hidden = true;
    }

    if (selectAllBtn) {
      const allSelected = visibleCount > 0 && selectedVisible === visibleCount;
      selectAllBtn.textContent = allSelected ? t('floorPanel.deselectAll') : t('floorPanel.selectAll');
      selectAllBtn.dataset.mode = allSelected ? 'deselect' : 'select';
    }
  }

  function scheduleAssignFilter() {
    if (searchFilterRaf) return;
    searchFilterRaf = requestAnimationFrame(() => {
      searchFilterRaf = 0;
      applyAssignFilter();
    });
  }

  function cameraY() {
    try {
      const cam = getCamera?.();
      const y = Number(cam?.position?.y);
      return Number.isFinite(y) ? y : 0;
    } catch {
      return 0;
    }
  }

  function syncLiveY(y) {
    sliceYValue = Number(y) || 0;
    pendingYLabel = formatY(sliceYValue);
    if (yLabelRaf) return;
    yLabelRaf = requestAnimationFrame(() => {
      yLabelRaf = 0;
      if (pendingYLabel == null) return;
      if (detailsYEl && detailsYEl.textContent !== pendingYLabel) {
        detailsYEl.textContent = pendingYLabel;
      }
      pendingYLabel = null;
    });
  }

  function clearSlicePlane() {
    setGizmoDragCallback(null);
    setGizmoDragEndCallback(null);
    if (yLabelRaf) {
      cancelAnimationFrame(yLabelRaf);
      yLabelRaf = 0;
    }
    pendingYLabel = null;
    if (sliceMarker) {
      removeFloorMarker(sliceMarker);
      sliceMarker = null;
    } else {
      detachFloorGizmo();
    }
  }

  function startSlicePlane(initialY) {
    clearSlicePlane();
    detachGizmo();
    const y = Number.isFinite(initialY) ? initialY : cameraY();
    sliceMarker = addFloorMarker(y, floorsData.length);
    if (!sliceMarker) {
      showToast(t('floorPanel.sceneNotReady'), 'error');
      return false;
    }
    lockX = sliceMarker.position.x;
    lockZ = sliceMarker.position.z;
    attachFloorGizmo(sliceMarker);
    // Write label immediately once (no rAF wait on open).
    sliceYValue = getFloorMarkerY(sliceMarker);
    if (detailsYEl) detailsYEl.textContent = formatY(sliceYValue);

    setGizmoDragCallback((payload) => {
      const pos = payload?.position ?? payload;
      const yNow = Number(pos?.y);
      if (sliceMarker) {
        sliceMarker.position.x = lockX;
        sliceMarker.position.z = lockZ;
      }
      if (Number.isFinite(yNow)) syncLiveY(yNow);
    });
    setGizmoDragEndCallback(() => {
      constrainFloorMarkerXZ(sliceMarker, lockX, lockZ);
      const yEnd = getFloorMarkerY(sliceMarker);
      sliceYValue = yEnd;
      if (detailsYEl) detailsYEl.textContent = formatY(yEnd);
    });
    return true;
  }

  function openDetails(index = -1) {
    editingIndex = index;
    const floor = index >= 0 ? floorsData[index] : null;
    listPanel.classList.add('hidden');

    detailsTitle.textContent = floor ? floor.name || t('floorPanel.editFloor') : t('floorPanel.newFloor');
    nameInput.value = floor?.name ?? '';
    selectedPoiIds = new Set(
      floor?.id
        ? poisData
            .filter((p) => String(p.floor_id ?? '') === String(floor.id))
            .map((p) => String(p.id))
        : [],
    );
    searchInput.value = '';
    selectedCategoryId = null;
    closeCategoryDropdown();

    const startY = floor?.slice_y ?? cameraY();
    if (!startSlicePlane(startY)) {
      listPanel.classList.remove('hidden');
      return;
    }

    // Paint panel first; build assign DOM on next frame so open doesn't hitch.
    detailsPanel.classList.remove('hidden');
    nameInput.focus();
    requestAnimationFrame(() => {
      if (detailsPanel.classList.contains('hidden')) return;
      buildAssignUi();
    });
  }

  function cancelAll() {
    editingIndex = -1;
    selectedPoiIds = new Set();
    selectedCategoryId = null;
    if (searchFilterRaf) {
      cancelAnimationFrame(searchFilterRaf);
      searchFilterRaf = 0;
    }
    assignBuildToken += 1;
    closeCategoryDropdown();
    clearSlicePlane();
    detailsPanel.classList.add('hidden');
    listPanel.classList.remove('hidden');
    rebuildList();
  }

  function buildAssignUi() {
    if (!catHost || !dropdownEl || !moreWrap || !poiHost) return;
    closeCategoryDropdown();
    catHost.replaceChildren();
    dropdownEl.replaceChildren();
    poiHost.replaceChildren();
    poiRowById.clear();
    poiCatIdsById.clear();
    poiNameLowerById.clear();

    /** @type {Set<string>} */
    const catsWithPois = new Set();
    for (const poi of poisData) {
      const id = String(poi.id ?? '');
      if (!id) continue;
      const cats = collectPoiCategoryIds(poi);
      poiCatIdsById.set(id, cats);
      poiNameLowerById.set(id, poiDisplayName(poi).toLowerCase());
      for (const c of cats) catsWithPois.add(c);
    }

    /** @type {{ id: string, name: string, iconKey: string }[]} */
    const pills = [{ id: '', name: t('floorPanel.allPillName'), iconKey: 'map-pin' }];
    for (const cat of categoriesData) {
      const catId = String(cat.id);
      if (!catsWithPois.has(catId)) continue;
      pills.push({
        id: catId,
        name: categoryDisplayName(cat) || t('floorPanel.categoryFallback'),
        iconKey: String(cat.icon_key ?? 'map-pin'),
      });
    }

    const pillFrag = document.createDocumentFragment();
    const dropFrag = document.createDocumentFragment();
    for (const pill of pills) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floor-dest-category-pill';
      btn.setAttribute('role', 'tab');
      btn.dataset.categoryId = pill.id;
      const isActive = (selectedCategoryId ?? '') === pill.id;
      if (isActive) btn.classList.add('floor-dest-category-pill--active');
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.innerHTML = `
        <span class="floor-dest-category-pill-icon" aria-hidden="true">${cachedCategoryIcon(pill.iconKey)}</span>
        <span>${escapeHtml(pill.name)}</span>
      `;
      pillFrag.appendChild(btn);

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'floor-dest-category-dropdown-item';
      item.setAttribute('role', 'option');
      item.dataset.categoryId = pill.id;
      if (isActive) item.classList.add('is-active');
      item.setAttribute('aria-selected', isActive ? 'true' : 'false');
      item.innerHTML = `
        <span class="floor-dest-category-dropdown-item-icon" aria-hidden="true">${cachedCategoryIcon(pill.iconKey)}</span>
        <span class="floor-dest-category-dropdown-item-label">${escapeHtml(pill.name)}</span>
      `;
      dropFrag.appendChild(item);
    }
    catHost.appendChild(pillFrag);
    dropdownEl.appendChild(dropFrag);
    moreWrap.hidden = pills.length <= 1;

    const token = ++assignBuildToken;
    const pois = poisData.filter((p) => p?.id);
    let index = 0;
    const CHUNK = 40;

    const pump = () => {
      if (token !== assignBuildToken || detailsPanel.classList.contains('hidden')) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(index + CHUNK, pois.length);
      for (; index < end; index += 1) {
        const poi = pois[index];
        const id = String(poi.id);
        const name = poiDisplayName(poi) || t('floorPanel.poiFallback');
        const cat = getCategoryById(poi.category_type);
        const selected = selectedPoiIds.has(id);

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `floor-dest-poi-item${selected ? ' is-selected' : ''}`;
        row.dataset.poiId = id;
        row.setAttribute('aria-pressed', selected ? 'true' : 'false');
        row.innerHTML = `
          <span class="floor-dest-poi-check" aria-hidden="true">
            <input type="checkbox" tabindex="-1" ${selected ? 'checked' : ''} />
          </span>
          <span class="floor-dest-poi-icon">${cachedCategoryIcon(cat?.icon_key ?? 'map-pin')}</span>
          <span class="floor-dest-poi-label">${escapeHtml(name)}</span>
        `;
        poiRowById.set(id, row);
        frag.appendChild(row);
      }
      poiHost.appendChild(frag);
      if (index < pois.length) {
        requestAnimationFrame(pump);
        return;
      }
      applyAssignFilter();
    };
    pump();
  }

  function renderAssignLists() {
    buildAssignUi();
  }

  function rebuildList() {
    listEl.replaceChildren();
    if (!floorsData.length) {
      const empty = document.createElement('div');
      empty.className = 'floor-empty';
      empty.innerHTML = `
        <div class="floor-empty-icon" aria-hidden="true">${iconFloorPlan()}</div>
        <strong>${t('floorPanel.noFloorsYet')}</strong>
        <p>${t('floorPanel.noFloorsHint')}</p>
      `;
      listEl.appendChild(empty);
      return;
    }

    floorsData.forEach((floor, index) => {
      const count = poisData.filter((p) => String(p.floor_id ?? '') === String(floor.id)).length;
      const card = document.createElement('div');
      card.className = 'floor-card';

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'floor-card-main';
      item.innerHTML = `
        <span class="floor-card-icon" aria-hidden="true">${iconFloorPlan()}</span>
        <span class="floor-card-body">
          <span class="floor-card-title">${escapeHtml(floor.name)}</span>
          <span class="floor-card-meta">
            <span class="floor-card-pill">${t('floorPanel.yValue', { value: formatY(floor.slice_y) })}</span>
            <span>${count === 1 ? t('floorPanel.poiCountSingular', { count }) : t('floorPanel.poiCountPlural', { count })}</span>
          </span>
        </span>
      `;
      item.addEventListener('click', () => openDetails(index));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'floor-card-delete';
      del.title = t('floorPanel.deleteFloor');
      del.setAttribute('aria-label', t('floorPanel.deleteFloorAriaLabel', { name: floor.name }));
      del.innerHTML = iconDelete();
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await askConfirm({
          title: t('floorPanel.deleteFloorConfirmTitle'),
          message: t('floorPanel.deleteFloorConfirmMessage', { name: floor.name }),
          confirmLabel: t('floorPanel.delete'),
          cancelLabel: t('floorPanel.cancel'),
          danger: true,
        });
        if (!ok) return;
        try {
          const floorId = String(floor.id);
          await removeFloorFromDb(index);
          poisData.forEach((p) => {
            if (String(p.floor_id ?? '') === floorId) p.floor_id = null;
          });
          rebuildList();
          onFloorsChange?.();
          showToast(t('floorPanel.floorDeleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(err?.message || t('floorPanel.couldNotDeleteFloor'), 'error');
        }
      });

      card.appendChild(item);
      card.appendChild(del);
      listEl.appendChild(card);
    });
  }

  /**
   * @param {string} floorId
   */
  async function applyPoiAssignments(floorId) {
    const fid = String(floorId);
    const jobs = [];
    for (let i = 0; i < poisData.length; i++) {
      const poi = poisData[i];
      const id = String(poi.id ?? '');
      if (!id) continue;
      const want = selectedPoiIds.has(id);
      const had = String(poi.floor_id ?? '') === fid;
      if (want && !had) {
        jobs.push(
          updatePoiRow(id, { floor_id: fid }).then(() => {
            poi.floor_id = fid;
          }),
        );
      } else if (!want && had) {
        jobs.push(
          updatePoiRow(id, { floor_id: null }).then(() => {
            poi.floor_id = null;
          }),
        );
      }
    }
    const CHUNK = 12;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await Promise.all(jobs.slice(i, i + CHUNK));
    }
  }

  addBtn?.addEventListener('click', () => openDetails(-1));
  detailsPanel.querySelector('#floor-details-back')?.addEventListener('click', () => cancelAll());
  detailsPanel.querySelector('#floor-details-cancel')?.addEventListener('click', () => cancelAll());
  detailsPanel.querySelector('#floor-readjust-slice')?.addEventListener('click', () => {
    // Re-place at current slice Y (or camera if missing) and re-attach Y gizmo.
    const y = Number.isFinite(sliceYValue) ? sliceYValue : cameraY();
    if (startSlicePlane(y)) {
      showToast(t('floorPanel.dragYArrow'), 'info');
    }
  });
  searchInput?.addEventListener('input', () => scheduleAssignFilter());
  catHost?.addEventListener('click', (e) => {
    const pill = e.target instanceof Element ? e.target.closest('.floor-dest-category-pill') : null;
    if (!pill || !(pill instanceof HTMLElement)) return;
    const id = pill.dataset.categoryId ?? '';
    selectCategory(id === '' ? null : id);
  });
  dropdownEl?.addEventListener('click', (e) => {
    const item = e.target instanceof Element
      ? e.target.closest('.floor-dest-category-dropdown-item')
      : null;
    if (!item || !(item instanceof HTMLElement)) return;
    const id = item.dataset.categoryId ?? '';
    selectCategory(id === '' ? null : id);
  });
  poiHost?.addEventListener('click', (e) => {
    const row = e.target instanceof Element ? e.target.closest('.floor-dest-poi-item') : null;
    if (!row || !(row instanceof HTMLElement) || row.hidden) return;
    e.preventDefault();
    const id = row.dataset.poiId;
    if (!id) return;
    setPoiSelected(id, !selectedPoiIds.has(id));
    // Selection only — skip full filter pass.
    if (selectAllBtn) {
      let visibleCount = 0;
      let selectedVisible = 0;
      for (const [poiId, r] of poiRowById) {
        if (r.hidden) continue;
        visibleCount += 1;
        if (selectedPoiIds.has(poiId)) selectedVisible += 1;
      }
      const allSelected = visibleCount > 0 && selectedVisible === visibleCount;
      selectAllBtn.textContent = allSelected ? t('floorPanel.deselectAll') : t('floorPanel.selectAll');
      selectAllBtn.dataset.mode = allSelected ? 'deselect' : 'select';
    }
  });
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCategoryDropdown();
  });
  detailsPanel.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('#floor-category-more-wrap')) return;
    closeCategoryDropdown();
  });
  selectAllBtn?.addEventListener('click', () => {
    const deselect = selectAllBtn.dataset.mode === 'deselect';
    for (const [id, row] of poiRowById) {
      if (row.hidden) continue;
      setPoiSelected(id, !deselect);
    }
    applyAssignFilter();
  });

  saveBtn?.addEventListener('click', async () => {
    const name = String(nameInput.value ?? '').trim();
    const slice_y = Number(getFloorMarkerY(sliceMarker) || sliceYValue);
    if (!name) {
      showToast(t('floorPanel.enterFloorName'), 'error');
      nameInput.focus();
      return;
    }
    if (!Number.isFinite(slice_y)) {
      showToast(t('floorPanel.setValidSliceHeight'), 'error');
      return;
    }
    saveBtn.disabled = true;
    const prevHtml = saveBtn.innerHTML;
    saveBtn.textContent = t('floorPanel.translating');
    consumeTranslationFailures();
    try {
      let floorId =
        editingIndex >= 0 ? String(floorsData[editingIndex]?.id ?? '') : '';
      if (editingIndex >= 0) {
        await saveFloorToDb(editingIndex, { name, slice_y, translate: true });
        const still = floorsData.find((f) => String(f.id) === floorId);
        if (still) floorId = String(still.id);
      } else {
        const idx = await addFloorWithDb({ name, slice_y });
        floorId = String(floorsData[idx]?.id ?? '');
      }
      if (!floorId) throw new Error(t('floorPanel.floorNotSaved'));
      await applyPoiAssignments(floorId);
      onFloorsChange?.();
      cancelAll();
      const failed = consumeTranslationFailures();
      if (failed.length) {
        showToast(
          t('floorPanel.floorSavedTranslationFailed'),
          'info',
        );
      } else {
        showToast(t('floorPanel.floorSavedWithTranslations'), 'success');
      }
    } catch (err) {
      console.error(err);
      showToast(err?.message || t('floorPanel.couldNotSaveFloor'), 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = prevHtml;
    }
  });

  return {
    show() {
      if (!detailsPanel.classList.contains('hidden')) return;
      listPanel.classList.remove('hidden');
      rebuildList();
    },
    hide() {
      listPanel.classList.add('hidden');
      detailsPanel.classList.add('hidden');
      clearSlicePlane();
      editingIndex = -1;
      if (searchFilterRaf) {
        cancelAnimationFrame(searchFilterRaf);
        searchFilterRaf = 0;
      }
      assignBuildToken += 1;
    },
    refresh() {
      if (!detailsPanel.classList.contains('hidden')) renderAssignLists();
      else rebuildList();
    },
    async reload() {
      await hydrateFloorsFromSupabase();
      rebuildList();
    },
  };
}

function formatY(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(Math.abs(n) >= 10 ? 1 : 2);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
