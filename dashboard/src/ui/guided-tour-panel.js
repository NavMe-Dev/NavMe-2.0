/**
 * Guided Tours panel — list + roadmap editor (START → ordered POI stops).
 */
import {
  guidedToursData,
  computeTourStats,
  hydrateGuidedToursFromSupabase,
} from '../ar/guided-tours.js';
import { poisData, poiDisplayName } from '../ar/pois.js';
import {
  insertGuidedTourRow,
  updateGuidedTourRow,
  deleteGuidedTourRow,
  replaceGuidedTourStops,
} from '../services/supabase.js';
import {
  getCategoryIconPickerSections,
  renderCategoryIcon,
} from '../config/category-icons.js';
import { iconSave, iconDelete, iconAdd, iconGrip, iconNavigate } from './icons.js';

/** Pencil for the collapsed tour-icon trigger. */
function iconEditPencil() {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'class="ui-icon" aria-hidden="true">' +
    '<path d="M12 20h9"/>' +
    '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
    '</svg>'
  );
}
import { showToast } from './toast.js';
import { askConfirm } from './confirm-dialog.js';
import { t } from '../config/i18n.js';

const DEFAULT_TOUR_ICON_KEY = 'route';

/**
 * @param {HTMLElement} container
 * @param {{ onToursChange?: () => void }} [options]
 */
export function createGuidedTourPanel(container, options = {}) {
  const onToursChange = options.onToursChange;

  const listPanel = document.createElement('div');
  listPanel.className =
    'scene-float-panel scene-float-panel--list float-glass drawer-frost floor-panel guided-tour-panel hidden';
  listPanel.id = 'guided-tour-list-panel';
  listPanel.innerHTML = `
    <div class="floor-panel-header">
      <div class="floor-panel-header-row">
        <div class="floor-panel-title-wrap">
          <div class="floor-panel-title">${t('guidedTourPanel.title')}</div>
        </div>
        <button type="button" class="floor-add-btn" id="tour-add-btn" title="${t('guidedTourPanel.addTour')}" aria-label="${t('guidedTourPanel.addTour')}">
          ${iconAdd()}
          <span>${t('guidedTourPanel.addTour')}</span>
        </button>
      </div>
      <p class="floor-panel-hint">${t('guidedTourPanel.listHint')}</p>
    </div>
    <div class="floor-list" id="tour-list"></div>
  `;
  container.appendChild(listPanel);

  const detailsPanel = document.createElement('div');
  detailsPanel.className =
    'scene-float-panel scene-float-panel--edit float-glass drawer-frost floor-details guided-tour-details hidden';
  detailsPanel.id = 'guided-tour-details-panel';
  detailsPanel.innerHTML = `
    <div class="floor-details-header">
      <button type="button" class="floor-back-btn" id="tour-details-back" aria-label="${t('guidedTourPanel.back')}">←</button>
      <div class="floor-details-titles">
        <span class="floor-panel-kicker" id="tour-details-step">${t('guidedTourPanel.nameAndRoadmap')}</span>
        <div class="floor-panel-title" id="tour-details-title">${t('guidedTourPanel.newTourTitle')}</div>
      </div>
    </div>
    <div class="floor-details-body">
      <label class="floor-field">
        <span class="floor-field-label">${t('guidedTourPanel.tourNameLabel')}</span>
        <input type="text" id="tour-name-input" class="floor-field-input" placeholder="${t('guidedTourPanel.tourNamePlaceholder')}" autocomplete="off" />
      </label>
      <div class="floor-field">
        <span class="floor-field-label">${t('guidedTourPanel.tourIconLabel')}</span>
        <!-- Collapsed by default: the full grid pushed the stop list off screen. -->
        <div class="tour-icon-field">
          <button
            type="button"
            class="tour-icon-trigger"
            id="tour-icon-trigger"
            aria-expanded="false"
            aria-haspopup="listbox"
          >
            <span class="category-icon-preview" id="tour-icon-preview" aria-hidden="true"></span>
            <span class="tour-icon-trigger-label" id="tour-icon-label">${t('guidedTourPanel.chooseIcon')}</span>
            <span class="tour-icon-trigger-edit" aria-hidden="true">${iconEditPencil()}</span>
          </button>
          <div class="tour-icon-popover hidden" id="tour-icon-popover">
            <input
              type="search"
              id="tour-icon-search"
              class="category-icon-search floor-field-input"
              placeholder="${t('guidedTourPanel.searchIconsPlaceholder')}"
              autocomplete="off"
            />
            <div class="category-icon-picker">
              <div class="category-icon-grid" id="tour-icon-grid" role="listbox" aria-label="${t('guidedTourPanel.tourIconLabel')}"></div>
            </div>
          </div>
        </div>
      </div>
      <label class="floor-field">
        <span class="floor-field-label">${t('guidedTourPanel.paceLabel')}</span>
        <select id="tour-pace-select" class="map-display-select floor-field-input">
          <option value="relaxed">${t('guidedTourPanel.paceRelaxed')}</option>
          <option value="standard" selected>${t('guidedTourPanel.paceStandard')}</option>
          <option value="express">${t('guidedTourPanel.paceExpress')}</option>
        </select>
      </label>
      <label class="coord-group poi-add-field facility-active-toggle">
        <input type="checkbox" id="tour-active" checked />
        <span class="field-label">${t('guidedTourPanel.activeLabel')}</span>
      </label>
      <div class="floor-y-chip" id="tour-stats-chip" aria-live="polite">
        <span class="floor-y-chip-label">${t('guidedTourPanel.expectedLabel')}</span>
        <strong class="floor-y-chip-value" id="tour-stats-value">—</strong>
      </div>
      <div class="floor-assign-block">
        <div class="floor-assign-head">
          <span class="floor-field-label">${t('guidedTourPanel.roadmapLabel')}</span>
        </div>
        <div class="roadmap-inner">
          <div class="roadmap-chain roadmap-chain--vertical" id="tour-roadmap-chain"></div>
          <p class="roadmap-hint">${t('guidedTourPanel.roadmapHint')}</p>
        </div>
        <div class="floor-assign-block hidden" id="tour-stop-picker">
          <div class="floor-assign-head">
            <span class="floor-field-label">${t('guidedTourPanel.addStopSectionLabel')}</span>
            <button type="button" class="floor-text-btn" id="tour-picker-close">${t('guidedTourPanel.done')}</button>
          </div>
          <input type="text" id="tour-poi-search" class="floor-dest-search-input" placeholder="${t('guidedTourPanel.searchDestinationsPlaceholder')}" autocomplete="off" />
          <div id="tour-poi-picker-list" class="floor-poi-assign floor-dest-poi-list" role="listbox" aria-label="${t('guidedTourPanel.availableDestinations')}"></div>
        </div>
      </div>
    </div>
    <div class="floor-details-actions">
      <button type="button" class="btn-secondary" id="tour-details-cancel">${t('guidedTourPanel.cancel')}</button>
      <button type="button" class="btn-save floor-save-btn" id="tour-save-btn">
        <span class="icon">${iconSave()}</span> ${t('guidedTourPanel.saveTour')}
      </button>
    </div>
  `;
  container.appendChild(detailsPanel);

  const listEl = listPanel.querySelector('#tour-list');
  const addBtn = listPanel.querySelector('#tour-add-btn');
  const nameInput = detailsPanel.querySelector('#tour-name-input');
  const paceSelect = detailsPanel.querySelector('#tour-pace-select');
  const activeInput = detailsPanel.querySelector('#tour-active');
  const detailsTitle = detailsPanel.querySelector('#tour-details-title');
  const statsValue = detailsPanel.querySelector('#tour-stats-value');
  const chainEl = detailsPanel.querySelector('#tour-roadmap-chain');
  const pickerEl = detailsPanel.querySelector('#tour-stop-picker');
  const pickerListEl = detailsPanel.querySelector('#tour-poi-picker-list');
  const searchInput = detailsPanel.querySelector('#tour-poi-search');
  const saveBtn = detailsPanel.querySelector('#tour-save-btn');
  const iconPreviewEl = detailsPanel.querySelector('#tour-icon-preview');
  const iconSearchInput = detailsPanel.querySelector('#tour-icon-search');
  const iconGridEl = detailsPanel.querySelector('#tour-icon-grid');
  const iconTriggerEl = detailsPanel.querySelector('#tour-icon-trigger');
  const iconPopoverEl = detailsPanel.querySelector('#tour-icon-popover');
  const iconLabelEl = detailsPanel.querySelector('#tour-icon-label');
  let iconPickerOpen = false;

  /** @type {string | null} */
  let editingId = null;
  /** @type {Array<{ poi_id: string, poi_name: string, pos_x: number, pos_y: number, pos_z: number }>} */
  let draftStops = [];
  /** @type {string | null} */
  let dragId = null;
  let pickerOpen = false;
  let draftIconKey = DEFAULT_TOUR_ICON_KEY;

  function closeEditor() {
    editingId = null;
    draftStops = [];
    dragId = null;
    pickerOpen = false;
    draftIconKey = DEFAULT_TOUR_ICON_KEY;
    pickerEl?.classList.add('hidden');
    setPickingState(false);
    if (searchInput) searchInput.value = '';
    closeIconPicker();
    detailsPanel.classList.add('hidden');
    listPanel.classList.remove('hidden');
    rebuildList();
  }

  /** Human label for an icon key, read from the same sections the grid uses. */
  function tourIconLabel(key) {
    for (const section of getCategoryIconPickerSections('')) {
      for (const opt of section.icons) {
        if (opt.key === key) return opt.label;
      }
    }
    return t('guidedTourPanel.chooseIcon');
  }

  function updateTourIconPreview() {
    if (iconPreviewEl) iconPreviewEl.innerHTML = renderCategoryIcon(draftIconKey);
    if (iconLabelEl) iconLabelEl.textContent = tourIconLabel(draftIconKey);
  }

  function openIconPicker() {
    if (iconPickerOpen || !iconPopoverEl) return;
    iconPickerOpen = true;
    iconPopoverEl.classList.remove('hidden');
    iconTriggerEl?.setAttribute('aria-expanded', 'true');
    // Always open on the full list, never on a leftover filter.
    if (iconSearchInput) iconSearchInput.value = '';
    // Rendered lazily — building every icon SVG on each editor open was wasted work.
    renderTourIconGrid();
    iconSearchInput?.focus();
  }

  function closeIconPicker() {
    if (!iconPickerOpen || !iconPopoverEl) return;
    iconPickerOpen = false;
    iconPopoverEl.classList.add('hidden');
    iconTriggerEl?.setAttribute('aria-expanded', 'false');
    if (iconSearchInput) iconSearchInput.value = '';
  }

  function renderTourIconGrid() {
    if (!iconGridEl) return;
    const query = iconSearchInput?.value ?? '';
    const sections = getCategoryIconPickerSections(query);
    iconGridEl.innerHTML = sections
      .map((section) => {
        const groupLabel = section.icons.length
          ? `<div class="category-icon-group-label">${escapeHtml(section.label)}</div>`
          : `<div class="category-icon-group-label category-icon-group-label--empty">${escapeHtml(section.label)}</div>`;
        const options = section.icons
          .map((opt) => {
            const active = opt.key === draftIconKey ? ' active' : '';
            return `<button type="button" class="category-icon-option${active}" data-icon-key="${opt.key}" title="${escapeHtml(opt.label)}" aria-label="${escapeHtml(opt.label)}">${renderCategoryIcon(opt.key)}</button>`;
          })
          .join('');
        return `<div class="category-icon-group">${groupLabel}<div class="category-icon-group-grid">${options}</div></div>`;
      })
      .join('');
    iconGridEl.querySelectorAll('.category-icon-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        draftIconKey = btn.dataset.iconKey || DEFAULT_TOUR_ICON_KEY;
        updateTourIconPreview();
        closeIconPicker();
      });
    });
  }

  function openEditor(tour) {
    editingId = tour?.id ? String(tour.id) : null;
    draftStops = (Array.isArray(tour?.stops) ? tour.stops : [])
      .map((stop) => {
        const fromPoi = stopFromPoiId(String(stop.poi_id ?? ''));
        if (fromPoi) return fromPoi;
        const poiId = String(stop.poi_id ?? '').trim();
        if (!poiId) return null;
        return {
          poi_id: poiId,
          poi_name: String(stop.poi_name ?? 'POI'),
          pos_x: Number(stop.pos_x) || 0,
          pos_y: Number(stop.pos_y) || 0,
          pos_z: Number(stop.pos_z) || 0,
        };
      })
      .filter(Boolean);
    if (nameInput) nameInput.value = tour?.name ? String(tour.name) : '';
    if (paceSelect) paceSelect.value = normalizePace(tour?.pace);
    draftIconKey = String(tour?.icon_key ?? DEFAULT_TOUR_ICON_KEY).trim() || DEFAULT_TOUR_ICON_KEY;
    if (iconSearchInput) iconSearchInput.value = '';
    closeIconPicker();
    updateTourIconPreview();
    if (activeInput instanceof HTMLInputElement) {
      activeInput.checked = tour ? tour.is_active !== false : true;
    }
    if (detailsTitle) {
      detailsTitle.textContent = editingId ? t('guidedTourPanel.editTourTitle') : t('guidedTourPanel.newTourTitle');
    }
    pickerOpen = false;
    pickerEl?.classList.add('hidden');
    setPickingState(false);
    if (searchInput) searchInput.value = '';
    listPanel.classList.add('hidden');
    detailsPanel.classList.remove('hidden');
    renderRoadmap();
    updateStatsChip();
    nameInput?.focus();
  }

  function rebuildList() {
    if (!listEl) return;
    listEl.replaceChildren();
    if (!guidedToursData.length) {
      const empty = document.createElement('div');
      empty.className = 'floor-empty';
      empty.innerHTML = `
        <div class="floor-empty-icon" aria-hidden="true">${iconNavigate()}</div>
        <strong>${t('guidedTourPanel.emptyTitle')}</strong>
        <p>${t('guidedTourPanel.emptyHint')}</p>
      `;
      listEl.appendChild(empty);
      return;
    }

    guidedToursData.forEach((tour) => {
      const stops = Array.isArray(tour.stops) ? tour.stops : [];
      const stopCount = stops.length;
      const mins = tour.expected_duration_min == null ? '—' : String(tour.expected_duration_min);
      const pace = capitalize(normalizePace(tour.pace));
      const card = document.createElement('div');
      card.className = 'floor-card';

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'floor-card-main';
      item.innerHTML = `
        <span class="floor-card-icon" aria-hidden="true">${renderCategoryIcon(tour.icon_key || DEFAULT_TOUR_ICON_KEY)}</span>
        <span class="floor-card-body">
          <span class="floor-card-title">${escapeHtml(String(tour.name ?? 'Tour'))}</span>
          <span class="floor-card-meta">
            <span class="floor-card-pill">${
              stopCount === 1
                ? t('guidedTourPanel.stopCountSingular', { count: stopCount })
                : t('guidedTourPanel.stopCountPlural', { count: stopCount })
            }</span>
            <span>${escapeHtml(pace)}</span>
            <span>${t('guidedTourPanel.minutesValue', { minutes: escapeHtml(mins) })}</span>
          </span>
        </span>
      `;
      item.addEventListener('click', () => openEditor(tour));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'floor-card-delete';
      del.title = t('guidedTourPanel.deleteTourTitle');
      del.setAttribute('aria-label', t('guidedTourPanel.deleteTourAriaLabel', { name: tour.name }));
      del.innerHTML = iconDelete();
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteTour(tour);
      });

      card.appendChild(item);
      card.appendChild(del);
      listEl.appendChild(card);
    });
  }

  function renderRoadmap() {
    if (!chainEl) return;
    chainEl.replaceChildren();
    dragId = null;

    const start = document.createElement('div');
    start.className = 'roadmap-node roadmap-node--start';
    start.innerHTML = `<span class="roadmap-node-label">${t('guidedTourPanel.startLabel')}</span>`;
    start.draggable = false;
    chainEl.appendChild(start);

    const conn0 = document.createElement('div');
    conn0.className = 'roadmap-connector';
    conn0.textContent = '↓';
    chainEl.appendChild(conn0);

    draftStops.forEach((stop, i) => {
      const card = document.createElement('div');
      card.className = 'roadmap-node roadmap-node--poi';
      card.draggable = true;
      card.dataset.poiId = stop.poi_id;
      card.innerHTML = `
        <span class="roadmap-node-seq">${i + 1}</span>
        <span class="roadmap-node-name">${escapeHtml(stop.poi_name)}</span>
        <span class="roadmap-node-drag">${iconGrip()}</span>
        <button type="button" class="roadmap-node-remove" title="${t('guidedTourPanel.removeStopTitle')}" aria-label="${t('guidedTourPanel.removeStopAriaLabel', { name: escapeHtml(stop.poi_name) })}">${iconDelete()}</button>
      `;
      card.addEventListener('dragstart', (e) => {
        dragId = stop.poi_id;
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        dragId = null;
        card.classList.remove('dragging');
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        const targetId = stop.poi_id;
        if (dragId && dragId !== targetId) {
          reorderStops(dragId, targetId);
        }
      });
      const removeBtn = card.querySelector('.roadmap-node-remove');
      if (removeBtn instanceof HTMLElement) removeBtn.draggable = false;
      removeBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
      removeBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        draftStops = draftStops.filter((s) => s.poi_id !== stop.poi_id);
        renderRoadmap();
        updateStatsChip();
        if (pickerOpen) renderPicker();
      });
      chainEl.appendChild(card);

      const conn = document.createElement('div');
      conn.className = 'roadmap-connector';
      conn.textContent = '↓';
      chainEl.appendChild(conn);
    });

    const addStopBtn = document.createElement('button');
    addStopBtn.type = 'button';
    addStopBtn.className = 'roadmap-node roadmap-node--add';
    addStopBtn.title = t('guidedTourPanel.addStopButtonTitle');
    addStopBtn.innerHTML = `<span class="roadmap-plus">${iconAdd()}</span>`;
    addStopBtn.addEventListener('click', () => {
      if (!poisData.length) {
        showToast(t('guidedTourPanel.noDestinationsToast'), 'info');
        return;
      }
      if (!availablePois().length) {
        showToast(t('guidedTourPanel.allDestinationsAddedToast'), 'info');
      }
      pickerOpen = true;
      pickerEl?.classList.remove('hidden');
      setPickingState(true);
      renderPicker();
      searchInput?.focus();
      keepPickerInView();
    });
    chainEl.appendChild(addStopBtn);
  }

  /**
   * Mirror picker state onto the panel so CSS can rebalance the space between
   * the stop chain and the destination list.
   */
  function setPickingState(open) {
    detailsPanel.classList.toggle('is-picking', Boolean(open));
  }

  /** Keep the newest stop visible inside the (now scrollable) chain. */
  function scrollChainToEnd() {
    if (!chainEl) return;
    chainEl.scrollTop = chainEl.scrollHeight;
  }

  /**
   * Bring the picker back into view after a stop is added. The picker is
   * sticky, so this only matters when the body happens to be scrolled above it.
   */
  function keepPickerInView() {
    if (!pickerOpen || !pickerEl) return;
    try {
      pickerEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch {
      pickerEl.scrollIntoView(false);
    }
  }

  function renderPicker() {
    if (!pickerListEl) return;
    pickerListEl.replaceChildren();
    const q = String(searchInput?.value ?? '')
      .trim()
      .toLowerCase();

    // Show every matching destination, including ones already on the tour.
    // Hiding them made a POI that exists look missing ("No matching
    // destinations") when it was simply already a stop.
    const onTour = new Set(draftStops.map((s) => s.poi_id));
    const rows = poisData.filter((poi) => {
      if (!String(poi.id ?? '')) return false;
      if (!q) return true;
      return poiDisplayName(poi)
        .toLowerCase()
        .includes(q);
    });

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'floor-empty';
      empty.innerHTML = `<p>${
        q ? t('guidedTourPanel.noDestinationMatch') : t('guidedTourPanel.noDestinationsEmpty')
      }</p>`;
      pickerListEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const poi of rows) {
      const id = String(poi.id ?? '');
      const added = onTour.has(id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `floor-dest-poi-item${added ? ' is-added' : ''}`;
      row.dataset.poiId = id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', added ? 'true' : 'false');
      if (added) row.title = t('guidedTourPanel.alreadyStopTitle');
      row.innerHTML = `
        <span class="floor-dest-poi-check" aria-hidden="true">
          <input type="checkbox" tabindex="-1"${added ? ' checked' : ''} />
        </span>
        <span class="floor-dest-poi-label">${escapeHtml(poiDisplayName(poi) || 'POI')}</span>
        ${added ? `<span class="floor-dest-poi-added">${t('guidedTourPanel.addedBadge')}</span>` : ''}
      `;
      row.addEventListener('click', () => {
        // Already a stop — the roadmap is where stops get removed.
        if (onTour.has(id)) return;
        const stop = stopFromPoiId(id);
        if (!stop) return;
        draftStops.push(stop);
        renderRoadmap();
        updateStatsChip();
        renderPicker();
        // Show the stop that was just added, and keep the list reachable so the
        // next one can be picked without scrolling around.
        scrollChainToEnd();
        keepPickerInView();
      });
      frag.appendChild(row);
    }
    pickerListEl.appendChild(frag);
  }

  function availablePois() {
    const selected = new Set(draftStops.map((s) => s.poi_id));
    return poisData.filter((poi) => {
      const id = String(poi.id ?? '');
      return id && !selected.has(id);
    });
  }

  function reorderStops(fromId, toId) {
    const order = draftStops.map((s) => s.poi_id);
    const fi = order.indexOf(fromId);
    const ti = order.indexOf(toId);
    if (fi < 0 || ti < 0) return;
    const [moved] = draftStops.splice(fi, 1);
    draftStops.splice(ti, 0, moved);
    renderRoadmap();
    updateStatsChip();
  }

  function updateStatsChip() {
    if (!statsValue) return;
    const pace = normalizePace(paceSelect?.value);
    const stats = computeTourStats(draftStops, pace);
    const n = draftStops.length;
    if (!n) {
      statsValue.textContent = t('guidedTourPanel.addStopsStat');
      return;
    }
    statsValue.textContent =
      n === 1
        ? t('guidedTourPanel.statsSummarySingular', { minutes: stats.expected_duration_min, count: n })
        : t('guidedTourPanel.statsSummaryPlural', { minutes: stats.expected_duration_min, count: n });
  }

  /**
   * @param {Record<string, unknown>} tour
   */
  async function deleteTour(tour) {
    const id = String(tour.id ?? '');
    if (!id) return;
    const ok = await askConfirm({
      title: t('guidedTourPanel.deleteConfirmTitle'),
      message: t('guidedTourPanel.deleteConfirmMessage', { name: tour.name }),
      confirmLabel: t('guidedTourPanel.deleteConfirmLabel'),
      cancelLabel: t('guidedTourPanel.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteGuidedTourRow(id);
      await hydrateGuidedToursFromSupabase();
      onToursChange?.();
      if (editingId === id) closeEditor();
      else rebuildList();
      showToast(t('guidedTourPanel.tourDeletedToast'), 'success');
    } catch (err) {
      console.error(err);
      showToast(err?.message || t('guidedTourPanel.couldNotDeleteTourToast'), 'error');
    }
  }

  async function saveTour() {
    const name = String(nameInput?.value ?? '').trim();
    if (!name) {
      showToast(t('guidedTourPanel.enterTourNameToast'), 'error');
      nameInput?.focus();
      return;
    }
    if (!draftStops.length) {
      showToast(t('guidedTourPanel.addAtLeastOneStopToast'), 'error');
      return;
    }
    const pace = normalizePace(paceSelect?.value);
    const isActive = activeInput instanceof HTMLInputElement ? activeInput.checked : true;
    const stats = computeTourStats(draftStops, pace);
    const payload = {
      name,
      pace,
      icon_key: draftIconKey || DEFAULT_TOUR_ICON_KEY,
      is_active: isActive,
      approx_distance_m: stats.approx_distance_m,
      expected_duration_min: stats.expected_duration_min,
    };
    const prevHtml = saveBtn?.innerHTML;
    if (saveBtn) saveBtn.disabled = true;
    let createdId = '';
    try {
      let tourId = editingId;
      if (tourId) {
        await updateGuidedTourRow(tourId, payload);
      } else {
        const inserted = await insertGuidedTourRow({
          ...payload,
          sort_order: guidedToursData.length,
        });
        const row = firstRow(inserted);
        tourId = String(row?.id ?? '');
        if (!tourId) throw new Error(t('guidedTourPanel.tourSavedWithoutIdError'));
        createdId = tourId;
      }
      try {
        await replaceGuidedTourStops(
          tourId,
          draftStops.map((stop, i) => ({ poi_id: stop.poi_id, sort_order: i })),
        );
      } catch (stopErr) {
        if (createdId) {
          try {
            await deleteGuidedTourRow(createdId);
          } catch (cleanupErr) {
            console.error(cleanupErr);
          }
        }
        throw stopErr;
      }
      await hydrateGuidedToursFromSupabase();
      onToursChange?.();
      closeEditor();
      showToast(t('guidedTourPanel.tourSavedToast'), 'success');
    } catch (err) {
      console.error(err);
      showToast(friendlyTourError(err), 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        if (prevHtml) saveBtn.innerHTML = prevHtml;
      }
    }
  }

  addBtn?.addEventListener('click', () => openEditor(null));
  detailsPanel.querySelector('#tour-details-back')?.addEventListener('click', () => closeEditor());
  detailsPanel.querySelector('#tour-details-cancel')?.addEventListener('click', () => closeEditor());
  detailsPanel.querySelector('#tour-picker-close')?.addEventListener('click', () => {
    pickerOpen = false;
    pickerEl?.classList.add('hidden');
    setPickingState(false);
  });
  searchInput?.addEventListener('input', () => {
    if (pickerOpen) renderPicker();
  });
  paceSelect?.addEventListener('change', () => updateStatsChip());
  iconSearchInput?.addEventListener('input', () => renderTourIconGrid());

  iconTriggerEl?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (iconPickerOpen) closeIconPicker();
    else openIconPicker();
  });
  // Keep clicks inside the popover from bubbling to the dismiss handler.
  iconPopoverEl?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', (event) => {
    if (!iconPickerOpen) return;
    if (iconTriggerEl?.contains(event.target) || iconPopoverEl?.contains(event.target)) return;
    closeIconPicker();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && iconPickerOpen) closeIconPicker();
  });
  saveBtn?.addEventListener('click', () => {
    saveTour().catch((err) => console.error('[guided-tours]', err));
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
      editingId = null;
      draftStops = [];
      pickerOpen = false;
      setPickingState(false);
    },
    refresh() {
      if (!detailsPanel.classList.contains('hidden')) {
        renderRoadmap();
        updateStatsChip();
        if (pickerOpen) renderPicker();
      } else {
        rebuildList();
      }
    },
    async reload() {
      await hydrateGuidedToursFromSupabase();
      rebuildList();
      onToursChange?.();
    },
  };
}

/** @param {unknown} raw */
function normalizePace(raw) {
  const pace = String(raw ?? 'standard');
  if (pace === 'relaxed' || pace === 'express') return pace;
  return 'standard';
}

/** @param {string} poiId */
function stopFromPoiId(poiId) {
  const id = String(poiId ?? '').trim();
  if (!id) return null;
  const poi = poisData.find((p) => String(p.id) === id);
  if (!poi) return null;
  return {
    poi_id: id,
    poi_name: poiDisplayName(poi) || 'POI',
    pos_x: Number(poi.pos_x) || 0,
    pos_y: Number(poi.pos_y) || 0,
    pos_z: Number(poi.pos_z) || 0,
  };
}

/** @param {unknown} result */
function firstRow(result) {
  if (Array.isArray(result)) return result[0] ?? null;
  return result ?? null;
}

/** @param {unknown} err */
function friendlyTourError(err) {
  const msg = String(err?.message ?? err);
  const lower = msg.toLowerCase();
  if (msg.includes('23505') || msg.includes('409') || lower.includes('duplicate')) {
    return t('guidedTourPanel.duplicateTourNameError');
  }
  return msg || t('guidedTourPanel.couldNotSaveTourError');
}

/** @param {string} s */
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** @param {unknown} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
