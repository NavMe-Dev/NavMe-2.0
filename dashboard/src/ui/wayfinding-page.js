/**
 * Standalone `/wayfinding` page — plan a route between two POIs inside the
 * Matterport space.
 *
 * Separate from the editor on purpose: the editor's Matterport view exists to
 * place POIs, and its toolbars, gizmos and place-handlers all assume that. This
 * page mounts the same Showcase host with none of that authoring chrome, so the
 * space is purely for viewing a route.
 *
 * The navmesh here is the **uploaded** `.navmesh` only
 * (`ensureNavMeshAvailable({ allowGenerate: false })`). Baking one from the
 * geometric mesh takes tens of seconds and can differ from what the AR
 * experience actually ships — a wayfinding preview that disagrees with the live
 * app would be worse than no preview, so if the upload is missing this page says
 * so rather than quietly generating a different mesh.
 */

import '../styles/global.css';
import '../styles/enterprise-theme.css';
import '../styles/glass-theme.css';
import '../styles/glass-animations.css';
import '../styles/wayfinding.css';

import { t } from '../config/i18n.js';
import { initTheme } from '../config/theme.js';
import { BRAND_NAME } from '../config/brand.js';
import { iconNavigate } from './icons.js';
import { renderForm } from './form.js';
import { showToast } from './toast.js';
import { authenticateLoginNavme } from '../services/supabase.js';
import { setPoiSession, getPoiType } from '../config/poi-session.js';
import { getProjectSession, clearProjectSession } from '../config/project-session.js';

import { isSuperAdminMapRole } from '../ar/pois.js';
import { fetchMatterportProjects } from '../services/supabase.js';
import { poisData, hydratePoisFromSupabase, poiDisplayName } from '../ar/pois.js';
import {
  getStairChains,
  hydrateStairChainsFromSupabase,
  stairChainsData,
  addStairChain,
  saveStairChain,
  removeStairChain,
} from '../ar/stair-chains.js';
import {
  floorsData,
  hydrateFloorsFromSupabase,
  getFloorById,
  getFloorNameById,
} from '../ar/floors.js';
import {
  categoriesData,
  hydrateCategoriesFromSupabase,
  getCategoryLabel,
  categoryDisplayName,
} from '../ar/categories.js';
import { renderCategoryIcon } from '../config/category-icons.js';
import {
  hydrateMediaFromSupabase,
  getActiveMatterportUrl,
  getActiveNavMeshMap,
} from '../ar/media.js';
import { ensureNavMeshAvailable, hasNavMesh } from '../ar/navigation-mesh.js';
import {
  ensureMatterportHost,
  loadMatterportMap,
  isMatterportMapActive,
  setMatterportNavRouteOverlay,
  splitRouteAtLevelChanges,
  clearMatterportNavRouteOverlay,
  matterportSweepPath,
  matterportGoToNearestSweep,
  matterportSnapPathToSweeps,
  matterportSetViewMode,
  getMatterportCameraPose,
  matterportCurrentSweep,
  matterportListSweeps,
  matterportSweepPathVia,
  setMatterportStairChains,
} from '../ar/matterport-map.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Straight-line length of a polyline, in metres. */
function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/** World position of a POI from its stored coordinates. */
function poiPosition(poi) {
  if (!poi) return null;
  const x = Number(poi.pos_x);
  const y = Number(poi.pos_y);
  const z = Number(poi.pos_z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

/**
 * @param {HTMLElement} container
 */
export function initWayfindingPage(container) {
  initTheme();
  container.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'wf-page';
  page.innerHTML = `
    <header class="wf-bar">
      <a href="/" class="wf-back" aria-label="${t('wayfindingPage.backAriaLabel')}">
        <span class="wf-back-chevron" aria-hidden="true">‹</span>
        <img src="/NavMe_wb.png" alt="${BRAND_NAME}" class="wf-bar-logo" />
      </a>

      <select id="wf-project" class="wf-project" aria-label="${t('wayfindingPage.projectAriaLabel')}"></select>

      <div class="wf-bar-distance hidden" id="wf-distance">
        <span class="wf-distance-value" id="wf-distance-value">—</span>
        <span class="wf-distance-label">${t('wayfindingPage.distanceToGo')}</span>
      </div>
    </header>

    <main class="wf-main hidden" id="wf-main">
      <div class="wf-stage">
        <div class="wf-space" id="wf-space"></div>
        <div class="wf-space-empty" id="wf-space-empty">
          <p>${t('wayfindingPage.noSpaceLinkedShort')}</p>
          <p class="wf-hint">${t('wayfindingPage.addMatterportLinkHint')}</p>
        </div>

        <p class="wf-status" id="wf-status">${t('wayfindingPage.loadingProject')}</p>

        <!-- Tapping a field opens the search panel; picking a destination routes
             immediately, so there is no separate Navigate step. -->
        <div class="wf-dock">
          <button type="button" class="wf-picker" id="wf-pick-from" data-role="from">
            <span class="wf-picker-label">${t('wayfindingPage.startLabel')}</span>
            <span class="wf-picker-value" id="wf-from-value">${t('wayfindingPage.chooseStart')}</span>
          </button>

          <button type="button" class="wf-swap" id="wf-swap" title="${t('wayfindingPage.swapTitle')}" aria-label="${t('wayfindingPage.swapAriaLabel')}">⇅</button>

          <button type="button" class="wf-picker" id="wf-pick-to" data-role="to">
            <span class="wf-picker-label">${t('wayfindingPage.destinationLabel')}</span>
            <span class="wf-picker-value" id="wf-to-value">${t('wayfindingPage.chooseDestination')}</span>
          </button>

          <button type="button" class="wf-icon-btn wf-icon-btn--clear" id="wf-clear" title="${t('wayfindingPage.clearRouteTitle')}" aria-label="${t('wayfindingPage.clearRouteAriaLabel')}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Destination search, exactly matching the AR experience's panel. -->
        <div class="n3d-search" id="wf-search-overlay" hidden>
          <div class="n3d-sheet" role="dialog" aria-modal="true" aria-labelledby="wf-search-title">
            <div class="n3d-shead">
              <div class="n3d-shead-top">
                <h2 class="n3d-stitle" id="wf-search-title">${t('wayfindingPage.chooseDestination')}</h2>
                <button type="button" class="n3d-sclose" id="wf-search-close" aria-label="${t('wayfindingPage.closeAriaLabel')}">&times;</button>
              </div>
              <input type="text" class="n3d-sinput" id="wf-search-input"
                     placeholder="${t('wayfindingPage.searchDestinationsPlaceholder')}" autocomplete="off"
                     autocapitalize="none" spellcheck="false" inputmode="search" />
              <div class="n3d-cats-row">
                <div class="n3d-pills" id="wf-search-pills" role="tablist" aria-label="${t('wayfindingPage.categoriesAriaLabel')}"></div>
                <div class="n3d-cat-more-wrap">
                  <button type="button" class="n3d-cat-more" aria-label="All categories" aria-haspopup="listbox" aria-expanded="false">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="n3d-cat-dropdown" hidden role="listbox" aria-label="All categories"></div>
                </div>
              </div>
            </div>
            <ul class="n3d-results" id="wf-search-results" role="listbox"></ul>
          </div>
        </div>

        <button type="button" class="wf-edit-stairs-btn" id="btn-open-stairs-edit" aria-label="Edit stairs">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          Edit Stairs
        </button>
      </div>
    </main>

    <div class="wf-stairs hidden" id="wf-stairs" aria-label="${t('wayfindingPage.editStairsAriaLabel')}">
      <div class="wf-stairs-head">
        <strong>${t('wayfindingPage.editStairsHeading')}</strong>
        <button type="button" class="wf-stairs-close" id="wf-stairs-close" aria-label="${t('wayfindingPage.closeAriaLabel')}">×</button>
      </div>
      <p class="wf-stairs-hint">
        ${t('wayfindingPage.stairsHint', { action: t('wayfindingPage.addCurrentPointButton') })}
      </p>
      <div class="wf-stairs-row">
        <input type="text" id="wf-stairs-name" class="wf-stairs-name" placeholder="${t('wayfindingPage.stairsNamePlaceholder')}" />
      </div>
      <div class="wf-stairs-row">
        <select id="wf-stairs-from" class="map-display-select"></select>
        <span>→</span>
        <select id="wf-stairs-to" class="map-display-select"></select>
      </div>
      <div class="wf-stairs-points" id="wf-stairs-points"></div>
      <div class="wf-stairs-actions">
        <button type="button" class="btn-secondary" id="wf-stairs-add">${t('wayfindingPage.addCurrentPointButton')}</button>
        <button type="button" class="btn-secondary" id="wf-stairs-undo">${t('wayfindingPage.undoButton')}</button>
        <button type="button" class="btn-save" id="wf-stairs-save">${t('wayfindingPage.saveFlightButton')}</button>
      </div>
      <ul class="wf-stairs-list" id="wf-stairs-list"></ul>
    </div>

    <div class="wf-meta" id="wf-meta">
      <label class="wf-meta-field">
        <span>${t('wayfindingPage.routeAlongLabel')}</span>
        <select id="wf-mode" class="map-display-select">
          <option value="hybrid" selected>${t('wayfindingPage.modeHybridOption')}</option>
          <option value="sweeps">${t('wayfindingPage.modeSweepsOption')}</option>
          <option value="navmesh">${t('wayfindingPage.modeNavmeshOption')}</option>
        </select>
      </label>
      <span class="wf-navmesh-state" id="wf-navmesh-state">${t('wayfindingPage.checkingNavmesh')}</span>
    </div>
  `;
  container.appendChild(page);


  const mainEl = page.querySelector('#wf-main');
  const modeSel = page.querySelector('#wf-mode');
  const statusEl = page.querySelector('#wf-status');
  const navmeshStateEl = page.querySelector('#wf-navmesh-state');
  const distanceEl = page.querySelector('#wf-distance');
  const distanceValueEl = page.querySelector('#wf-distance-value');
  const spaceEl = page.querySelector('#wf-space');
  const spaceEmptyEl = page.querySelector('#wf-space-empty');
  const fromValueEl = page.querySelector('#wf-from-value');
  const toValueEl = page.querySelector('#wf-to-value');
  const searchOverlay = page.querySelector('#wf-search-overlay');
  const searchInput = page.querySelector('#wf-search-input');
  const searchResults = page.querySelector('#wf-search-results');
  const searchTitle = page.querySelector('#wf-search-title');
  const searchPills = page.querySelector('#wf-search-pills');
  /** Active category filter; null means All. */
  let activeCategoryId = null;
  /** Height of the walkthrough camera above the floor plane, in metres. */
  const CAMERA_ABOVE_FLOOR_M = 1.3;
  /** Floor nearest the camera when the panel opened — resolved from slice_y. */
  let currentFloorId = null;

  /** Chosen POI indices; -1 until picked. */
  let fromIdx = -1;
  let toIdx = -1;
  /** Which field the open search panel is filling. */
  let pickingRole = null;

  let busy = false;
  let navmeshReady = false;
  /** Scan points the current route runs through, for off-route detection. */
  let routeSweepIds = new Set();
  /** Drawn polyline, used for off-route detection when there are no sweep ids. */
  let routeWorldPoints = [];
  /**
   * A cross-floor route is shown one leg at a time — walk to the stairs, climb
   * them, walk to the destination — because drawing all of it at once puts the
   * far-floor half in the air behind a ceiling, competing with the part you are
   * actually walking.
   */
  let routeLegs = [];
  let activeLeg = 0;
  let routeSource = 'sweeps';
  /** Scan numbers for the drawn route, parallel to routeDrawPoints. */
  let routeSweepNumbers = [];
  /** The points the numbers line up with. */
  let routeDrawPoints = [];
  let routeActive = false;
  let rerouting = false;
  let lastKnownSweepId = null;
  let offRouteTimer = null;

  function setStatus(text, tone = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `wf-status${tone ? ` is-${tone}` : ''}`;
  }

  function poiName(i) {
    return poisData[i] ? poiDisplayName(poisData[i]) : t('wayfindingPage.poiFallbackName', { num: i + 1 });
  }

  function syncPickers() {
    if (fromValueEl) {
      fromValueEl.textContent = fromIdx >= 0 ? poiName(fromIdx) : t('wayfindingPage.chooseStart');
      fromValueEl.classList.toggle('is-empty', fromIdx < 0);
    }
    if (toValueEl) {
      toValueEl.textContent = toIdx >= 0 ? poiName(toIdx) : t('wayfindingPage.chooseDestination');
      toValueEl.classList.toggle('is-empty', toIdx < 0);
    }
  }

  /** Kept for the boot path — POIs arrive after the page is built. */
  function fillPoiSelects() {
    syncPickers();
  }

  /** Straight-line metres from the scan point you are standing on. */
  function distanceFromHere(poi) {
    const pose = getMatterportCameraPose();
    const cam = pose?.position;
    if (!cam) return null;
    const x = Number(poi.pos_x);
    const y = Number(poi.pos_y);
    const z = Number(poi.pos_z);
    if (![x, y, z].every(Number.isFinite)) return null;
    // The camera sits at eye height on a sweep; POIs are stored at floor level.
    // Comparing like with like keeps a POI at your feet from ranking behind one
    // across the room purely because of the 1.5 m offset.
    return Math.hypot(x - cam.x, y - (cam.y - 1.5), z - cam.z);
  }

  function formatMetres(m) {
    if (!Number.isFinite(m)) return '';
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    if (m >= 100) return `${Math.round(m)} m`;
    return `${m.toFixed(1)} m`;
  }

  function poiCategoryIds(poi) {
    if (Array.isArray(poi?.category_ids) && poi.category_ids.length) return poi.category_ids;
    return poi?.category_type ? [String(poi.category_type)] : [];
  }


  /**
   * Floor the camera is on, by nearest slice_y — the same rule the AR panel
   * uses. Resolved once when the panel opens, not tracked live, so the list
   * cannot reshuffle under the user's finger while they read it.
   */
  function resolveCurrentFloorId() {
    if (!floorsData.length) return null;
    const pose = getMatterportCameraPose();
    const y = Number(pose?.position?.y);
    if (!Number.isFinite(y)) return null;
    // Camera sits above the floor plane. 1.3 m is measured from this space's
    // own scan clusters (sweep medians sit 1.27-1.32 m above each floor's
    // slice_y), not assumed from a nominal tripod height.
    const floorY = y - CAMERA_ABOVE_FLOOR_M;
    let best = null;
    let bestD = Infinity;
    for (const f of floorsData) {
      const d = Math.abs(Number(f.slice_y) - floorY);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best?.id ?? null;
  }

  function floorNameOf(poi) {
    const id = poi?.floor_id ? String(poi.floor_id) : '';
    if (!id) return '';
    return getFloorNameById(id) || '';
  }

  /** Vertical distance from the camera's floor, for ordering other floors. */
  function floorDelta(poi) {
    const f = poi?.floor_id ? getFloorById(String(poi.floor_id)) : null;
    const pose = getMatterportCameraPose();
    const camY = Number(pose?.position?.y);
    if (!Number.isFinite(camY)) return Number.POSITIVE_INFINITY;
    const base = camY - CAMERA_ABOVE_FLOOR_M;
    if (f && Number.isFinite(Number(f.slice_y))) return Math.abs(Number(f.slice_y) - base);
    const py = Number(poi?.pos_y);
    return Number.isFinite(py) ? Math.abs(py - base) : Number.POSITIVE_INFINITY;
  }


  function renderCategoryPills() {
    if (!searchPills) return;
    // Only categories actually in use — an empty filter is worse than no pill.
    const used = new Set();
    for (const poi of poisData) for (const id of poiCategoryIds(poi)) used.add(id);

    const pills = [{ id: null, label: t('wayfindingPage.allCategoriesPill'), iconKey: 'circle-check' }];
    for (const cat of categoriesData) {
      if (!used.has(String(cat.id))) continue;
      pills.push({
        id: String(cat.id),
        label: getCategoryLabel(cat.id) || categoryDisplayName(cat) || t('wayfindingPage.categoryFallback'),
        iconKey: cat.icon_key,
      });
    }

    searchPills.innerHTML = pills
      .map((p) => {
        const active = (p.id ?? null) === activeCategoryId;
        return `<button type="button" role="tab" class="n3d-pill${active ? ' active' : ''}"
                  data-cat="${p.id ?? ''}" aria-selected="${active}">
                  <span class="n3d-pill-icon" aria-hidden="true">${renderCategoryIcon(p.iconKey)}</span>
                  <span class="n3d-pill-label">${escapeHtml(p.label)}</span>
                </button>`;
      })
      .join('');
  }

  function renderSearchResults(query) {
    if (!searchResults) return;
    const q = String(query ?? '').trim().toLowerCase();
    const exclude = pickingRole === 'from' ? toIdx : fromIdx;

    const rows = [];
    for (let i = 0; i < poisData.length; i += 1) {
      if (i === exclude) continue; // cannot start and end at the same POI
      const poi = poisData[i];
      const name = poiName(i);
      if (q && !name.toLowerCase().includes(q)) continue;
      if (activeCategoryId && !poiCategoryIds(poi).includes(activeCategoryId)) continue;
      rows.push({
        i,
        name,
        dist: distanceFromHere(poi),
        floor: floorNameOf(poi),
        // 0 = your floor, 1 = another tagged floor, 2 = untagged.
        tier: currentFloorId
          ? String(poi.floor_id ?? '') === currentFloorId
            ? 0
            : poi.floor_id
              ? 1
              : 2
          : 0,
        delta: floorDelta(poi),
      });
    }

    // Your own floor first, then the nearest other floor, then distance within
    // it. Without the floor tier a POI two storeys up can sit above one in the
    // next room purely because the straight line is shorter — which is not what
    // "nearest" means to someone on foot.
    rows.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 1 && a.delta !== b.delta) return a.delta - b.delta;
      const aOk = Number.isFinite(a.dist);
      const bOk = Number.isFinite(b.dist);
      if (aOk && bOk) return a.dist - b.dist;
      if (aOk) return -1;
      if (bOk) return 1;
      return a.name.localeCompare(b.name);
    });

    const shown = rows.slice(0, 200); // keep long lists responsive

    if (!shown.length) {
      searchResults.innerHTML = `<li class="n3d-empty">${
        q || activeCategoryId
          ? t('wayfindingPage.noDestinationMatches')
          : t('wayfindingPage.noDestinationsYet')
      }</li>`;
      return;
    }

    searchResults.innerHTML = shown
      .map(
        (r) =>
          `<li><button type="button" class="n3d-item" data-idx="${r.i}" role="option">
             <span class="n3d-item-l">${escapeHtml(r.name)}</span>
             ${r.floor ? `<span class="n3d-item-f">${escapeHtml(r.floor)}</span>` : ''}
             ${r.dist != null ? `<span class="n3d-item-d">${formatMetres(r.dist)}</span>` : ''}
           </button></li>`,
      )
      .join('');
  }

  function openSearch(role) {
    pickingRole = role;
    if (searchTitle) {
      searchTitle.textContent = role === 'from' ? t('wayfindingPage.chooseStart') : t('wayfindingPage.chooseDestination');
    }
    if (searchInput) searchInput.value = '';
    activeCategoryId = null;
    // Which floor you are on can change between opens — re-resolve each time.
    // Still needed: results are ordered your-floor-first even without a filter.
    currentFloorId = resolveCurrentFloorId();
    renderCategoryPills();
    renderSearchResults('');
    if (searchOverlay) searchOverlay.hidden = false;
    // Focus after paint so the mobile keyboard does not fight the open animation.
    setTimeout(() => searchInput?.focus(), 60);
  }

  function closeSearch() {
    if (searchOverlay) searchOverlay.hidden = true;
    pickingRole = null;
  }

  /**
   * Picking a POI is the whole interaction: as soon as both ends are known the
   * route runs. No separate Navigate button.
   */
  async function choosePoi(idx) {
    if (pickingRole === 'from') fromIdx = idx;
    else if (pickingRole === 'to') toIdx = idx;
    const role = pickingRole;
    closeSearch();
    syncPickers();

    if (role === 'from') {
      // Walk to the start straight away, so the space matches the choice.
      // No lookAt: the heading is the user's to control, so we move them
      // without ever turning the view for them.
      const a = poiPosition(poisData[fromIdx]);
      if (a && isMatterportMapActive()) {
        setStatus(t('wayfindingPage.movingToStart'));
        await matterportGoToNearestSweep(a);
      }
    }

    if (fromIdx >= 0 && toIdx >= 0) await runNavigate();
    else setStatus(fromIdx < 0 ? t('wayfindingPage.chooseStartWarn') : t('wayfindingPage.chooseDestinationWarn'));
  }

  /** Navmesh is only needed for navmesh mode; camera-point mode never touches it. */


  /**
   * Which declared flights a trip has to use, in order.
   *
   * Chains carry the NavMe floors they join, so the floors form a small graph
   * and the flights between two of them are just the shortest path across it.
   * Breadth-first because the fewest flights is always the right answer — a
   * route that climbs and descends again is never what someone wants.
   *
   * @param {string|null} fromFloorId
   * @param {string|null} toFloorId
   * @returns {number[][]} chains oriented in the direction of travel
   */
  function chainsBetweenFloors(fromFloorId, toFloorId) {
    if (!fromFloorId || !toFloorId || fromFloorId === toFloorId) return [];
    if (!stairChainsData.length) return [];

    // Undirected edges: a flight can be walked either way.
    const edges = new Map();
    for (const c of stairChainsData) {
      if (!c.from_floor_id || !c.to_floor_id || c.sweep_numbers.length < 2) continue;
      for (const [a, b, reversed] of [
        [c.from_floor_id, c.to_floor_id, false],
        [c.to_floor_id, c.from_floor_id, true],
      ]) {
        if (!edges.has(a)) edges.set(a, []);
        edges.get(a).push({ to: b, chain: c, reversed });
      }
    }

    const prev = new Map([[fromFloorId, null]]);
    const queue = [fromFloorId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toFloorId) break;
      for (const e of edges.get(cur) ?? []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, edge: e });
        queue.push(e.to);
      }
    }
    if (!prev.has(toFloorId)) return [];

    const out = [];
    for (let f = toFloorId; prev.get(f); f = prev.get(f).from) {
      const { chain, reversed } = prev.get(f).edge;
      const nums = chain.sweep_numbers.slice();
      out.unshift(reversed ? nums.reverse() : nums);
    }
    return out;
  }

  /** The NavMe floor a POI sits on. */
  function floorIdOf(poi) {
    return poi?.floor_id ? String(poi.floor_id) : null;
  }


  // ---- Project picker ---------------------------------------------------
  const projectEl = page.querySelector('#wf-project');

  /**
   * Fill the picker with every project that has a Matterport space.
   *
   * This page runs standalone, so it cannot inherit a project from the
   * dashboard's session — it has to offer the choice itself. Picking one sets
   * the poi_type session that every Supabase read is scoped by, so POIs,
   * floors, media, navmesh and stair chains all follow the selection.
   */
  async function fillProjectPicker() {
    if (!projectEl) return;
    try {
      const projects = await fetchMatterportProjects();
      if (!projects.length) {
        projectEl.hidden = true;
        return;
      }
      const active = getPoiType();
      projectEl.innerHTML = projects
        .map(
          (p) =>
            `<option value="${escapeHtml(p.poi_type)}"${
              p.poi_type === active ? ' selected' : ''
            }>${escapeHtml(p.poi_type)}</option>`,
        )
        .join('');
      // No session yet (standalone load) — open the first project.
      if (!active) {
        setPoiSession({ poiType: projects[0].poi_type });
        projectEl.value = projects[0].poi_type;
      }
    } catch (err) {
      console.warn('[wayfinding] could not list projects', err);
      projectEl.hidden = true;
    }
  }

  /** Switch project: reset everything that is scoped to the old one. */
  async function switchProject(poiType) {
    if (!poiType || poiType === getPoiType()) return;
    await runClear();
    fromIdx = -1;
    toIdx = -1;
    syncPickers();
    distanceEl?.classList.add('hidden');
    setPoiSession({ poiType });
    // Chains and navmesh belong to the old space — drop them before reloading.
    stairChainsData.length = 0;
    navmeshReady = false;
    await boot();
  }

  projectEl?.addEventListener('change', () => {
    void switchProject(projectEl.value);
  });

  // ---- Stairs editor (super admin only) --------------------------------
  const stairsEl = page.querySelector('#wf-stairs');
  const stairsNameEl = page.querySelector('#wf-stairs-name');
  const stairsFromEl = page.querySelector('#wf-stairs-from');
  const stairsToEl = page.querySelector('#wf-stairs-to');
  const stairsPointsEl = page.querySelector('#wf-stairs-points');
  const stairsListEl = page.querySelector('#wf-stairs-list');
  /** Scan numbers picked for the flight being built, in walking order. */
  let stairDraft = [];
  let editingChainId = null;

  function renderStairDraft() {
    if (!stairsPointsEl) return;
    stairsPointsEl.innerHTML = stairDraft.length
      ? stairDraft.map((n, i) => `<span class="wf-stairs-chip">${escapeHtml(t('wayfindingPage.stairPointLabel', { index: i + 1, n }))}</span>`).join('')
      : `<span class="wf-stairs-empty">${t('wayfindingPage.noStairPointsYet')}</span>`;
  }

  function renderStairList() {
    if (!stairsListEl) return;
    if (!stairChainsData.length) {
      stairsListEl.innerHTML = `<li class="wf-stairs-empty">${t('wayfindingPage.noFlightsSaved')}</li>`;
      return;
    }
    stairsListEl.innerHTML = stairChainsData
      .map(
        (c) => `<li>
          <span class="wf-stairs-list-name">${escapeHtml(c.name)}</span>
          <span class="wf-stairs-list-pts">${c.sweep_numbers.join(' → ')}</span>
          <button type="button" class="wf-stairs-edit" data-id="${c.id}">${t('wayfindingPage.editButton')}</button>
          <button type="button" class="wf-stairs-del" data-id="${c.id}">${t('wayfindingPage.deleteButton')}</button>
        </li>`,
      )
      .join('');
  }

  function fillStairFloorSelects() {
    const opts = floorsData
      .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`)
      .join('');
    if (stairsFromEl) stairsFromEl.innerHTML = `<option value="">${t('wayfindingPage.fromFloorPlaceholder')}</option>${opts}`;
    if (stairsToEl) stairsToEl.innerHTML = `<option value="">${t('wayfindingPage.toFloorPlaceholder')}</option>${opts}`;
  }

  /** Add the scan point the camera is standing on to the draft. */
  async function addCurrentStairPoint() {
    const here = await matterportCurrentSweep();
    if (!here.ok) return setStatus(here.error || t('wayfindingPage.noScanPointHere'), 'error');
    const listed = await matterportListSweeps();
    if (!listed.ok) return setStatus(listed.error, 'error');
    const n = listed.sweeps.findIndex((sw) => sw.id === here.sweep.id);
    if (n < 0) return setStatus(t('wayfindingPage.couldNotIdentifyScanPoint'), 'error');
    if (stairDraft[stairDraft.length - 1] === n) {
      return setStatus(t('wayfindingPage.scanAlreadyLastPoint', { n }), 'warn');
    }
    stairDraft.push(n);
    renderStairDraft();
    setStatus(
      stairDraft.length === 1
        ? t('wayfindingPage.addedScanPointOne', { n })
        : t('wayfindingPage.addedScanPointOther', { n, count: stairDraft.length }),
      'ok',
    );
  }

  async function saveStairDraft() {
    if (stairDraft.length < 2) {
      return setStatus(t('wayfindingPage.flightNeedsTwoPoints'), 'warn');
    }
    const name =
      String(stairsNameEl?.value ?? '').trim() ||
      t('wayfindingPage.defaultStairsName', { from: stairDraft[0], to: stairDraft[stairDraft.length - 1] });
    const patch = {
      name,
      from_floor_id: stairsFromEl?.value || null,
      to_floor_id: stairsToEl?.value || null,
      sweep_numbers: stairDraft.slice(),
    };
    try {
      if (editingChainId) await saveStairChain(editingChainId, patch);
      else await addStairChain(patch);
      // The router must pick the change up immediately.
      await setMatterportStairChains(getStairChains());
      stairDraft = [];
      editingChainId = null;
      if (stairsNameEl) stairsNameEl.value = '';
      renderStairDraft();
      renderStairList();
      setStatus(t('wayfindingPage.savedFlight', { name }), 'ok');
    } catch (err) {
      console.error('[wayfinding] save stairs failed', err);
      setStatus(err?.message ?? t('wayfindingPage.couldNotSaveFlight'), 'error');
    }
  }

  stairsEl?.querySelector('#wf-stairs-add')?.addEventListener('click', () => void addCurrentStairPoint());
  stairsEl?.querySelector('#wf-stairs-undo')?.addEventListener('click', () => {
    stairDraft.pop();
    renderStairDraft();
  });
  stairsEl?.querySelector('#wf-stairs-save')?.addEventListener('click', () => void saveStairDraft());
  stairsEl?.querySelector('#wf-stairs-close')?.addEventListener('click', () => {
    stairsEl.classList.add('hidden');
  });
  stairsListEl?.addEventListener('click', async (e) => {
    const edit = e.target?.closest?.('.wf-stairs-edit');
    const del = e.target?.closest?.('.wf-stairs-del');
    if (edit) {
      const c = stairChainsData.find((x) => x.id === edit.dataset.id);
      if (!c) return;
      editingChainId = c.id;
      stairDraft = c.sweep_numbers.slice();
      if (stairsNameEl) stairsNameEl.value = c.name;
      if (stairsFromEl) stairsFromEl.value = c.from_floor_id ?? '';
      if (stairsToEl) stairsToEl.value = c.to_floor_id ?? '';
      renderStairDraft();
      return;
    }
    if (del) {
      try {
        await removeStairChain(del.dataset.id);
        await setMatterportStairChains(getStairChains());
        renderStairList();
        setStatus(t('wayfindingPage.flightDeleted'), 'ok');
      } catch (err) {
        setStatus(err?.message ?? t('wayfindingPage.couldNotDeleteFlight'), 'error');
      }
    }
  });

  /**
   * Tell the router which scan points form each staircase, so a cross-floor
   * route walks every step instead of taking the graph's skip links.
   */
  async function declareStairChains() {
    try {
      await hydrateStairChainsFromSupabase();
      const chains = getStairChains();
      if (chains.length) await setMatterportStairChains(chains);
      renderStairList();
      // Editing flights is a super-admin job: it changes how everyone routes.
      if (isSuperAdminMapRole()) {
        fillStairFloorSelects();
        renderStairDraft();
        stairsEl?.classList.remove('hidden');
      }
    } catch (err) {
      console.warn('[wayfinding] could not declare stair chains', err);
    }
  }

  async function prepareNavmesh() {
    const uploaded = getActiveNavMeshMap();
    if (!uploaded) {
      navmeshReady = false;
      if (navmeshStateEl) {
        navmeshStateEl.textContent = t('wayfindingPage.noNavmeshUploaded');
        navmeshStateEl.className = 'wf-navmesh-state is-warn';
      }
      return;
    }
    if (navmeshStateEl) navmeshStateEl.textContent = t('wayfindingPage.loadingUploadedNavmesh');
    try {
      // allowGenerate:false — never silently bake a different mesh. See file header.
      const res = await ensureNavMeshAvailable({ allowGenerate: false, visualize: false });
      navmeshReady = Boolean(res?.success) && hasNavMesh();
      if (navmeshStateEl) {
        navmeshStateEl.textContent = navmeshReady
          ? t('wayfindingPage.loadedNavmesh', {
              label: uploaded.label || uploaded.media_url?.split('/').pop() || t('wayfindingPage.uploadedNavmeshFallbackLabel'),
            })
          : res?.error || t('wayfindingPage.navmeshCouldNotLoad');
        navmeshStateEl.className = `wf-navmesh-state ${navmeshReady ? 'is-ok' : 'is-error'}`;
      }
    } catch (err) {
      navmeshReady = false;
      if (navmeshStateEl) {
        navmeshStateEl.textContent = err?.message ?? t('wayfindingPage.navmeshLoadFailed');
        navmeshStateEl.className = 'wf-navmesh-state is-error';
      }
    }
  }

  /** Stats from the last hybrid snap, surfaced in the status line. */
  let lastSnapStats = null;

  /**
   * Predicate used to keep hybrid routes on walkable ground. Delegates to the
   * router's own navmesh query so both agree on what "on the navmesh" means.
   */
  async function buildNavmeshProbe() {
    if (!hasNavMesh()) return null;
    try {
      const { createNavmeshProbe } = await import('../ar/navigation-route.js');
      return createNavmeshProbe({ toleranceM: 1.0 });
    } catch (err) {
      console.warn('[wayfinding] navmesh probe unavailable', err);
      return null;
    }
  }

  /**
   * Re-route when you walk onto a scan point that is not on the current route.
   *
   * Polled rather than driven by a camera event: Matterport fires pose updates
   * continuously while moving, and re-routing mid-transition would rebuild the
   * trail dozens of times per move. Sampling on a timer and acting only when
   * the scan point you are standing on actually CHANGES keeps it to one
   * re-route per wrong turn.
   */
  /** Human label for a leg, e.g. "Leg 2 of 3 · Take the stairs up". */
  function legLabel(i) {
    const leg = routeLegs[i];
    if (!leg) return '';
    const of = ` (${i + 1}/${routeLegs.length})`;
    if (leg.kind === 'stairs') {
      const pts = leg.points;
      const up = pts[pts.length - 1].y > pts[0].y;
      return `${up ? t('wayfindingPage.stairsUpLabel') : t('wayfindingPage.stairsDownLabel')}${of}`;
    }
    if (i === 0) return `${t('wayfindingPage.walkToStairs')}${of}`;
    if (i === routeLegs.length - 1) return `${t('wayfindingPage.walkToDestination')}${of}`;
    return `${t('wayfindingPage.continueWalking')}${of}`;
  }

  /** Draw only the leg the user is on. */
  async function drawActiveLeg() {
    const leg = routeLegs[activeLeg];
    if (!leg) return { ok: false };
    // Number the steps on a staircase, so the drawn route can be checked
    // against Matterport's own scan list. Numbering a long corridor would just
    // be clutter, so only stair legs get labels.
    const labels =
      leg.kind === 'stairs' && routeSweepNumbers.length
        ? leg.points.map((p) => {
            const i = routeDrawPoints.findIndex(
              (q) => q.x === p.x && q.y === p.y && q.z === p.z,
            );
            return i >= 0 ? routeSweepNumbers[i] : null;
          })
        : null;
    return setMatterportNavRouteOverlay(leg.points, { source: routeSource, labels });
  }

  /**
   * Advance when the user reaches the end of the current leg.
   * Compared in 3D so arriving at the foot of the stairs does not count as
   * reaching the top of them.
   */
  const LEG_ARRIVE_M = 3;
  async function maybeAdvanceLeg(sweep) {
    if (activeLeg >= routeLegs.length - 1) return false;
    const leg = routeLegs[activeLeg];
    const end = leg?.points?.[leg.points.length - 1];
    if (!end) return false;
    const d = Math.hypot(sweep.x - end.x, sweep.y - end.y, sweep.z - end.z);
    if (d > LEG_ARRIVE_M) return false;
    activeLeg += 1;
    await drawActiveLeg();
    setStatus(legLabel(activeLeg), 'ok');
    return true;
  }

  const OFF_ROUTE_POLL_MS = 1200;
  /** How far off a navmesh polyline counts as having left the route. */
  const OFF_ROUTE_M = 3;

  function stopOffRouteWatch() {
    if (offRouteTimer) {
      clearInterval(offRouteTimer);
      offRouteTimer = null;
    }
  }

  function startOffRouteWatch() {
    stopOffRouteWatch();
    offRouteTimer = setInterval(() => {
      void checkOffRoute();
    }, OFF_ROUTE_POLL_MS);
  }

  async function checkOffRoute() {
    // Never fight an in-flight navigate, and only while a route is on screen.
    if (!routeActive || busy || rerouting) return;
    if (toIdx < 0 || !isMatterportMapActive()) return;

    let here;
    try {
      here = await matterportCurrentSweep();
    } catch {
      return;
    }
    if (!here?.ok) return;

    const id = here.sweep.id;
    // Only act on an actual change of scan point — standing still is not a turn.
    if (id === lastKnownSweepId) return;
    lastKnownSweepId = id;

    // Reached the end of this leg? Show the next one instead of re-routing.
    if (await maybeAdvanceLeg(here.sweep)) return;

    // Still on the planned route: nothing to do.
    if (routeSweepIds.size) {
      if (routeSweepIds.has(id)) return;
    } else if (routeWorldPoints.length >= 2) {
      // Navmesh mode: no scan points to match, so ask how far the sweep you
      // just stepped onto sits from the drawn path.
      const sw = here.sweep;
      let best = Infinity;
      for (let i = 1; i < routeWorldPoints.length; i += 1) {
        const a = routeWorldPoints[i - 1];
        const b = routeWorldPoints[i];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        let t = 0;
        if (len2 > 1e-9) {
          t = ((sw.x - a.x) * abx + (sw.z - a.z) * abz) / len2;
          t = Math.max(0, Math.min(1, t));
        }
        const dx = sw.x - (a.x + abx * t);
        const dz = sw.z - (a.z + abz * t);
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      if (Math.sqrt(best) <= OFF_ROUTE_M) return;
    } else {
      return; // nothing to compare against yet
    }

    rerouting = true;
    try {
      // runNavigate already pins the start to the scan point you stand on, so
      // the rebuilt route simply picks you up where you are. Silent, and with
      // no camera move, so walking off-route feels like the trail re-joining
      // you rather than the page refreshing.
      await runNavigate({ silent: true });
    } finally {
      rerouting = false;
    }
  }

  /**
   * @param {{ silent?: boolean }} [opts] silent suppresses the progress status,
   *   used by the automatic off-route rebuild so walking around does not make
   *   the status line flicker between "finding" and the result.
   */
  async function runNavigate(opts = {}) {
    if (busy) return;
    if (fromIdx < 0) return setStatus(t('wayfindingPage.chooseStartWarn'), 'warn');
    if (toIdx < 0) return setStatus(t('wayfindingPage.chooseDestinationWarn'), 'warn');
    if (fromIdx === toIdx) return setStatus(t('wayfindingPage.startDestinationSame'), 'warn');
    if (!isMatterportMapActive()) return setStatus(t('wayfindingPage.spaceStillLoading'), 'warn');

    const from = fromIdx;
    const to = toIdx;
    const mode = modeSel?.value === 'navmesh'
      ? 'navmesh'
      : modeSel?.value === 'sweeps'
        ? 'sweeps'
        : 'hybrid';
    if (mode === 'navmesh' && !navmeshReady) {
      return setStatus(t('wayfindingPage.noUsableNavmesh'), 'error');
    }

    const a = poiPosition(poisData[from]);
    const b = poiPosition(poisData[to]);
    if (!a || !b) return setStatus(t('wayfindingPage.poisNoPosition'), 'error');

    busy = true;
    const silent = opts.silent === true;
    if (!silent) setStatus(t('wayfindingPage.findingRoute'));

    try {
      let points = [];
      let routeIds = [];

      // Route from the scan point you are standing on, not from the POI marker.
      // Selecting a start already walks the camera there, so in the normal flow
      // this IS the start — but if you then move, the route follows your feet.
      let startSweepId = null;
      try {
        const here = await matterportCurrentSweep();
        if (here.ok) {
          startSweepId = here.sweep.id;
          // Baseline for off-route detection, so the freshly built route is
          // never immediately treated as a wrong turn.
          lastKnownSweepId = startSweepId;
        }
      } catch {
        /* no camera pose yet — fall back to the POI-nearest sweep */
      }

      // Flights required for this trip, from the NavMe floors on each chain.
      const viaChains = chainsBetweenFloors(
        floorIdOf(poisData[from]),
        floorIdOf(poisData[to]),
      );

      let usedMode = mode;
      /** True when the route was built through declared staircases. */
      let usedStairChains = false;
      lastSnapStats = null;
      if (mode === 'hybrid') {
        if (viaChains.length) {
          // Crossing floors: the declared flights are not optional, so route
          // through them rather than letting the navmesh pick a way up.
          const res = await matterportSweepPathVia(a, b, viaChains, { startSweepId });
          if (res.ok && res.points.length >= 2) {
            points = res.points;
            routeIds = res.sweepIds ?? [];
            routeSweepNumbers = res.sweepNumbers ?? [];
            usedStairChains = true;
          }
        }
        if (points.length < 2) {
          // Shape from the navmesh, vertices from the camera points: follows real
          // walkable geometry without ever landing somewhere you cannot stand.
          const { navigateBetweenPois, getNavigationPathWorldPoints } = await import(
            '../ar/navigation-controller.js'
          );
          if (!navmeshReady) {
            setStatus(t('wayfindingPage.hybridNeedsNavmesh'), 'warn');
          }
          let dense = [];
          if (navmeshReady) {
            const res = await navigateBetweenPois(Number(from), Number(to), { showVisual: false });
            if (res.ok) {
              dense = res.pathPoints?.length >= 2 ? res.pathPoints : getNavigationPathWorldPoints();
            }
          }
          if (dense.length >= 2) {
            const snapped = await matterportSnapPathToSweeps(dense, {
              isOnNavmesh: await buildNavmeshProbe(),
              startSweepId,
            });
            if (snapped.ok) {
              points = snapped.points;
              routeIds = snapped.sweepIds ?? [];
              routeSweepNumbers = snapped.sweepNumbers ?? [];
              lastSnapStats = snapped;
            }
          }
          // No navmesh, or nothing snapped — the sweep graph still gets you there.
          if (points.length < 2) {
            usedMode = 'sweeps';
            const res = viaChains.length
              ? await matterportSweepPathVia(a, b, viaChains, { startSweepId })
              : await matterportSweepPath(a, b, { startSweepId });
            if (!res.ok) {
              await clearMatterportNavRouteOverlay();
              return setStatus(res.error || t('wayfindingPage.noRouteFound'), 'error');
            }
            points = res.points;
            routeIds = res.sweepIds ?? [];
            routeSweepNumbers = res.sweepNumbers ?? [];
          }
        }
      } else if (mode === 'sweeps') {
        const res = viaChains.length
          ? await matterportSweepPathVia(a, b, viaChains, { startSweepId })
          : await matterportSweepPath(a, b, { startSweepId });
        if (!res.ok) {
          await clearMatterportNavRouteOverlay();
          return setStatus(res.error || t('wayfindingPage.noCameraPointRoute'), 'error');
        }
        if (viaChains.length) usedStairChains = true;
        // Draw ONLY sweep positions. POI coordinates come from the AR/navmesh
        // space and do not share a vertical origin with Matterport, so splicing
        // them into the drawn path made the trail climb the building facade.
        // They are still what selects the nearest sweeps — just not drawn.
        points = res.points;
        routeIds = res.sweepIds ?? [];
        routeSweepNumbers = res.sweepNumbers ?? [];
      } else {
        const { navigateToPoi, navigateBetweenPois, getNavigationPathWorldPoints } =
          await import('../ar/navigation-controller.js');
        // navigateToPoi routes from the walkable origin — in Matterport that is
        // the Showcase camera, i.e. the scan point you are standing on. That is
        // what makes the navmesh route start at your feet like the other modes,
        // and re-start from wherever you are when it rebuilds.
        let res = await navigateToPoi(Number(to), { showVisual: false });
        if (!res.ok) {
          // No usable origin (no camera pose yet) — fall back to POI → POI.
          res = await navigateBetweenPois(Number(from), Number(to), { showVisual: false });
        }
        if (!res.ok) {
          await clearMatterportNavRouteOverlay();
          return setStatus(res.error || t('wayfindingPage.noNavmeshRoute'), 'error');
        }
        points = res.pathPoints?.length >= 2 ? res.pathPoints : getNavigationPathWorldPoints();
      }

      if (points.length < 2) return setStatus(t('wayfindingPage.noDrawablePoints'), 'error');

      // Draw the sweep positions exactly as they are. In walkthrough you are
      // already standing on a sweep, so there is nothing to prepend — and an
      // extra non-sweep vertex would put a dot off the scan rings.
      const drawPoints = points;

      routeSource = mode === 'navmesh' ? 'navmesh' : 'sweeps';
      routeDrawPoints = drawPoints;
      // Break the route where it changes level, then show only the first leg.
      routeLegs = splitRouteAtLevelChanges(drawPoints);
      activeLeg = 0;
      const overlay = routeLegs.length
        ? await drawActiveLeg()
        : await setMatterportNavRouteOverlay(drawPoints, { source: routeSource });
      if (!overlay?.ok) {
        return setStatus(overlay?.error || t('wayfindingPage.couldNotDrawRoute'), 'error');
      }

      // Remember which scan points this route runs through, so stepping onto a
      // scan point that is not on it can trigger a re-route.
      routeSweepIds = new Set(routeIds);
      // Navmesh routes have no scan-point list, so off-route is measured
      // against the polyline instead. Without this the empty set made EVERY
      // move look off-route, rebuilding the path on every single step.
      routeWorldPoints = routeIds.length ? [] : points.map((q) => ({ x: q.x, y: q.y, z: q.z }));
      routeActive = true;
      startOffRouteWatch();

      const metres = polylineLength(points);
      if (distanceEl && distanceValueEl) {
        distanceValueEl.textContent = `${metres.toFixed(1)} m`;
        distanceEl.classList.remove('hidden');
      }

      const fromName = poisData[Number(from)] ? poiDisplayName(poisData[Number(from)]) : t('wayfindingPage.startFallback');
      const toName = poisData[Number(to)] ? poiDisplayName(poisData[Number(to)]) : t('wayfindingPage.destinationFallback');
      // Report the navmesh check: how many scan points on the chosen route are
      // off the navmesh (0 is the goal), not just the space-wide count.
      const check =
        usedMode === 'hybrid' && lastSnapStats?.totalSweeps
          ? lastSnapStats.offNavmeshOnRoute
            ? ` · ${
                lastSnapStats.offNavmeshOnRoute === 1
                  ? t('wayfindingPage.offNavmeshPointSingular', { count: lastSnapStats.offNavmeshOnRoute })
                  : t('wayfindingPage.offNavmeshPointPlural', { count: lastSnapStats.offNavmeshOnRoute })
              }`
            : ` · ${t('wayfindingPage.allPointsOnNavmesh')}`
          : '';
      const modeLabel =
        usedMode === 'hybrid'
          ? `${t('wayfindingPage.hybridModeLabel')}${check}`
          : usedMode === 'sweeps'
            ? mode === 'hybrid'
              ? t('wayfindingPage.cameraPointsUnavailableLabel')
              : t('wayfindingPage.cameraPointsLabel')
            : t('wayfindingPage.navmeshLabel');
      const routeLabel = usedStairChains
        ? t('wayfindingPage.viaStaircases', {
            count: viaChains.length,
            word: viaChains.length === 1 ? t('wayfindingPage.staircaseSingular') : t('wayfindingPage.staircasePlural'),
          })
        : modeLabel;
      setStatus(
        routeLegs.length > 1
          ? `${fromName} → ${toName} · ${legLabel(0)}`
          : `${fromName} → ${toName} · ${routeLabel}`,
        'ok',
      );
    } catch (err) {
      console.error('[wayfinding] navigate failed', err);
      setStatus(err?.message ?? t('wayfindingPage.navigationFailed'), 'error');
      showToast(err?.message ?? t('wayfindingPage.navigationFailedToast'), 'error');
    } finally {
      busy = false;
    }
  }

  async function runClear() {
    // Stop watching first: a poll landing mid-clear would rebuild the route we
    // are in the middle of tearing down.
    routeActive = false;
    stopOffRouteWatch();
    routeSweepIds = new Set();
    routeWorldPoints = [];
    routeLegs = [];
    activeLeg = 0;
    routeSweepNumbers = [];
    routeDrawPoints = [];
    lastKnownSweepId = null;
    await clearMatterportNavRouteOverlay();
    distanceEl?.classList.add('hidden');
    setStatus(t('wayfindingPage.routeCleared'));
  }

  // A route watcher outliving the page would keep polling the SDK forever.
  window.addEventListener('beforeunload', stopOffRouteWatch);
  window.addEventListener('pagehide', stopOffRouteWatch);

  /** Load POIs, media, the Matterport space and the navmesh for this project. */
  async function boot() {
    setStatus(t('wayfindingPage.loadingProject'));
    try {
      // Must run first: every read below is scoped by the selected project.
      await fillProjectPicker();
      await Promise.all([
        hydratePoisFromSupabase(),
        hydrateMediaFromSupabase(),
        hydrateCategoriesFromSupabase().catch(() => []),
        // Floors are optional — a project without them just loses the filter.
        hydrateFloorsFromSupabase().catch(() => []),
      ]);
      fillPoiSelects();

      if (!poisData.length) {
        setStatus(t('wayfindingPage.noPoisYet'), 'warn');
      } else {
        setStatus(t('wayfindingPage.pickStartDestination'));
      }

      const url = getActiveMatterportUrl();
      if (!url) {
        spaceEl?.classList.add('hidden');
        spaceEmptyEl?.classList.add('is-visible');
        setStatus(t('wayfindingPage.noSpaceLinkedLong'), 'error');
        return;
      }

      ensureMatterportHost(spaceEl);
      const loaded = await loadMatterportMap(url, {
        // Strip the Showcase control bar — this page is walkthrough-only.
        minimalChrome: true,
        onStatus: (msg, kind) => setStatus(msg, kind === 'error' ? 'error' : ''),
      });
      if (!loaded.ok) {
        setStatus(loaded.error || t('wayfindingPage.couldNotLoadSpace'), 'error');
        return;
      }

      // Lock to walkthrough: dollhouse/floorplan are hidden, and any route
      // drawing must not leave the viewer in an overhead mode.
      try {
        await matterportSetViewMode('inside');
      } catch {
        /* already inside, or the SDK rejected it — not worth failing over */
      }

      // Needs the space live — chains are declared by scan index.
      await declareStairChains();
      await prepareNavmesh();
      setStatus(poisData.length ? t('wayfindingPage.pickStartDestination') : t('wayfindingPage.noPoisOnProject'));
    } catch (err) {
      console.error('[wayfinding] boot failed', err);
      setStatus(err?.message ?? t('wayfindingPage.couldNotLoadProject'), 'error');
    }
  }

  page.querySelector('#wf-pick-from')?.addEventListener('click', (e) => {
    e.preventDefault();
    openSearch('from');
  });
  page.querySelector('#wf-pick-to')?.addEventListener('click', (e) => {
    e.preventDefault();
    openSearch('to');
  });

  searchInput?.addEventListener('input', () => renderSearchResults(searchInput.value));
  searchPills?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.n3d-pill');
    if (!btn) return;
    activeCategoryId = btn.dataset.cat || null;
    renderCategoryPills();
    renderSearchResults(searchInput?.value ?? '');
  });
  searchResults?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.n3d-item');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx)) void choosePoi(idx);
  });
  page.querySelector('#wf-search-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeSearch();
  });
  page.querySelector('#btn-open-stairs-edit')?.addEventListener('click', () => {
    page.querySelector('#wf-stairs')?.classList.remove('hidden');
  });
  searchOverlay?.addEventListener('click', (e) => {
    if (e.target === searchOverlay) closeSearch();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchOverlay && !searchOverlay.hidden) closeSearch();
  });

  modeSel?.addEventListener('change', () => {
    // Re-run with the new mode when a route is already set up.
    if (fromIdx >= 0 && toIdx >= 0) void runNavigate();
  });

  page.querySelector('#wf-swap')?.addEventListener('click', (e) => {
    e.preventDefault();
    const a = fromIdx;
    fromIdx = toIdx;
    toIdx = a;
    syncPickers();
    if (fromIdx >= 0 && toIdx >= 0) void runNavigate();
  });

  page.querySelector('#wf-clear')?.addEventListener('click', (e) => {
    e.preventDefault();
    fromIdx = -1;
    toIdx = -1;
    syncPickers();
    void runClear();
  });

  const formUI = renderForm(container, async (creds) => {
    setPoiSession({
      poiType: creds.poiType,
      mapCode: creds.mapCode,
      organizationId: creds.organizationId,
    });
    formUI.hide();
    mainEl.classList.remove('hidden');
    await boot();
  });

  // Restore a saved project session on refresh — same flow as the other pages.
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
      await boot();
    } catch (err) {
      console.error(err);
      clearProjectSession();
      formUI.enable();
      formUI.show();
    }
  })();

  return { showLogin: () => formUI.show(), refresh: fillPoiSelects, poiType: () => getPoiType() };
}
