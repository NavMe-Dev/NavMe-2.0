/**
 * User tracking panel — list + tabs in drawer; markers, routes, heat map in scene only.
 */
import {
  fetchUsersForProject,
  fetchNavnodesForUser,
  fetchLatestNavnodeForUser,
  isSupabaseConfigured,
} from '../services/supabase.js';
import { clearUserHeatmap } from '../ar/nav-heatmap.js';
import {
  isMatterportMapActive,
  clearMatterportHeatmapOverlay,
  setMatterportUserTrailOverlay,
  clearMatterportUserTrailOverlay,
} from '../ar/matterport-map.js';
import {
  addUserMarker,
  updateUserMarker,
  hasUserMarker,
  clearAllMarkers,
  drawHistoryRoute,
  clearHistoryRoute,
  drawUserTrailPoints,
  clearUserTrailPoints,
  setMarkersVisible,
  setHistoryRouteVisible,
  setUserTrailPointsVisible,
} from '../ar/user-tracking.js';
import { flyTo } from '../ar/scene.js';
import { iconRefresh } from './icons.js';
import { t } from '../config/i18n.js';

const POLL_INTERVAL = 5000;
const DOT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#8b5cf6', '#14b8a6'];
/** Orange trail for per-user heat map XYZ points. */
const USER_HEAT_ORANGE = 0xf97316;

/** @type {Record<string, unknown>[]} */
let usersCache = [];
/** @type {string | number | null} */
let selectedUserId = null;
/** @type {'live' | 'history' | 'heatmap'} */
let mode = 'live';
let pollTimer = null;

/**
 * @param {HTMLElement} container
 * @param {{
 *   onUserSelect?: (user: Record<string, unknown> | null) => void,
 *   onUsersChange?: () => void,
 *   onMapHeatmapRefresh?: (opts?: {
 *     filter?: 'all' | 'logged' | 'guest',
 *     userIds?: string[] | null,
 *   }) => void | Promise<void>,
 * }} [options]
 */
export function createUserPanel(container, options = {}) {
  const onUserSelect = options.onUserSelect;
  const onUsersChange = options.onUsersChange;
  const onMapHeatmapRefresh = options.onMapHeatmapRefresh;

  const panel = document.createElement('div');
  panel.className =
    'user-panel scene-float-panel scene-float-panel--single float-glass drawer-frost hidden';
  panel.id = 'user-panel';

  panel.innerHTML = `
    <div class="user-panel-header">
      <div class="poi-panel-header-row">
        <div class="poi-panel-title">${escapeHtml(t('userPanel.title'))}</div>
        <button type="button" class="admin-refresh-btn" id="user-refresh-btn" title="${escapeHtml(t('userPanel.refreshTitle'))}" aria-label="${escapeHtml(t('userPanel.refreshAriaLabel'))}">${iconRefresh()}</button>
      </div>
      <div class="user-count-summary" id="user-count-summary" aria-live="polite">
        <button type="button" class="user-count-chip user-count-chip--total is-active" id="user-filter-total" aria-pressed="true" title="${escapeHtml(t('userPanel.filterAllTitle'))}">
          <strong id="user-count-total">0</strong>
          <span>${escapeHtml(t('userPanel.totalLabel'))}</span>
        </button>
        <button type="button" class="user-count-chip user-count-chip--logged" id="user-filter-logged" aria-pressed="false" title="${escapeHtml(t('userPanel.filterLoggedTitle'))}">
          <strong id="user-count-logged">0</strong>
          <span>${escapeHtml(t('userPanel.loggedInLabel'))}</span>
        </button>
        <button type="button" class="user-count-chip user-count-chip--guest" id="user-filter-guest" aria-pressed="false" title="${escapeHtml(t('userPanel.filterGuestTitle'))}">
          <strong id="user-count-guest">0</strong>
          <span>${escapeHtml(t('userPanel.guestsLabel'))}</span>
        </button>
      </div>
      <div class="user-tabs" role="tablist">
        <button type="button" class="user-tab active" data-mode="live" role="tab">${escapeHtml(t('userPanel.tabLive'))}</button>
        <button type="button" class="user-tab" data-mode="history" role="tab">${escapeHtml(t('userPanel.tabHistory'))}</button>
        <button type="button" class="user-tab" data-mode="heatmap" role="tab">${escapeHtml(t('userPanel.tabHeatmap'))}</button>
      </div>
    </div>
    <div class="user-list" id="user-list">
      <div class="user-loading">${escapeHtml(t('userPanel.loadingUsers'))}</div>
    </div>
  `;

  container.appendChild(panel);

  /** @type {'all' | 'logged' | 'guest'} */
  let listFilter = 'all';

  const listEl = panel.querySelector('#user-list');
  const countTotalEl = panel.querySelector('#user-count-total');
  const countLoggedEl = panel.querySelector('#user-count-logged');
  const countGuestEl = panel.querySelector('#user-count-guest');
  const filterTotalBtn = panel.querySelector('#user-filter-total');
  const filterLoggedBtn = panel.querySelector('#user-filter-logged');
  const filterGuestBtn = panel.querySelector('#user-filter-guest');
  const refreshBtn = panel.querySelector('#user-refresh-btn');
  const tabLive = panel.querySelector('[data-mode="live"]');
  const tabHistory = panel.querySelector('[data-mode="history"]');
  const tabHeatmap = panel.querySelector('[data-mode="heatmap"]');

  tabLive?.addEventListener('click', () => switchMode('live'));
  tabHistory?.addEventListener('click', () => switchMode('history'));
  tabHeatmap?.addEventListener('click', () => switchMode('heatmap'));
  refreshBtn?.addEventListener('click', () => refresh({ refreshHeatmap: true }));

  filterTotalBtn?.addEventListener('click', () => setListFilter('all'));
  filterLoggedBtn?.addEventListener('click', () => setListFilter('logged'));
  filterGuestBtn?.addEventListener('click', () => setListFilter('guest'));

  function audienceHeatmapOpts() {
    if (listFilter === 'all') {
      return { filter: 'all', userIds: null };
    }
    return {
      filter: listFilter,
      userIds: filteredUsers().map((u) => String(u.id)),
    };
  }

  function setListFilter(next) {
    listFilter = next === 'logged' || next === 'guest' ? next : 'all';
    filterTotalBtn?.classList.toggle('is-active', listFilter === 'all');
    filterLoggedBtn?.classList.toggle('is-active', listFilter === 'logged');
    filterGuestBtn?.classList.toggle('is-active', listFilter === 'guest');
    filterTotalBtn?.setAttribute('aria-pressed', listFilter === 'all' ? 'true' : 'false');
    filterLoggedBtn?.setAttribute('aria-pressed', listFilter === 'logged' ? 'true' : 'false');
    filterGuestBtn?.setAttribute('aria-pressed', listFilter === 'guest' ? 'true' : 'false');
    renderUserList();

    // Audience chips drive the main combined heat map while on the Heat map tab.
    selectedUserId = null;
    highlightSelected();
    clearUserHeatmap();
    clearUserTrailPoints();
    void clearMatterportUserTrailOverlay();
    if (mode === 'heatmap') {
      applyAudienceHeatmap();
    }
  }

  async function applyAudienceHeatmap() {
    try {
      await onMapHeatmapRefresh?.(audienceHeatmapOpts());
    } catch (err) {
      console.error('[users] audience heat map:', err);
    }
  }

  function switchMode(newMode) {
    mode = newMode;
    tabLive?.classList.toggle('active', mode === 'live');
    tabHistory?.classList.toggle('active', mode === 'history');
    tabHeatmap?.classList.toggle('active', mode === 'heatmap');
    setMarkersVisible(mode === 'live');
    setHistoryRouteVisible(mode === 'history');
    setUserTrailPointsVisible(mode === 'heatmap');
    void clearSceneViz().then(() => {
      selectedUserId = null;
      highlightSelected();
      onUserSelect?.(null);
      if (mode === 'live') startPolling();
      else stopPolling();
      if (mode === 'heatmap') {
        applyAudienceHeatmap();
      }
    });
  }

  function updateCountSummary() {
    const { loggedIn, guests, total } = getUsersBreakdown();
    if (countTotalEl) countTotalEl.textContent = String(total);
    if (countLoggedEl) countLoggedEl.textContent = String(loggedIn);
    if (countGuestEl) countGuestEl.textContent = String(guests);
  }

  async function clearSceneViz() {
    clearAllMarkers();
    clearHistoryRoute();
    clearUserTrailPoints();
    clearUserHeatmap();
    await clearMatterportHeatmapOverlay();
  }

  /**
   * @param {{ refreshHeatmap?: boolean }} [opts]
   */
  async function refresh(opts = {}) {
    if (!isSupabaseConfigured()) {
      listEl.innerHTML = `<div class="user-empty">${escapeHtml(t('userPanel.databaseNotConfigured'))}</div>`;
      updateCountSummary();
      return;
    }
    listEl.innerHTML = `<div class="user-loading">${escapeHtml(t('userPanel.loadingUsers'))}</div>`;
    try {
      usersCache = await fetchUsersForProject();
      updateCountSummary();
      renderUserList();
      onUsersChange?.();
      if (mode === 'live') startPolling();

      if (opts.refreshHeatmap) {
        await refreshHeatmapViews();
      }
    } catch (err) {
      updateCountSummary();
      listEl.innerHTML = `<div class="user-empty">${escapeHtml(t('userPanel.failedToLoadUsers'))}<span class="user-err-detail">${escapeHtml(err.message || String(err))}</span></div>`;
    }
  }

  async function refreshHeatmapViews() {
    if (mode === 'heatmap' && selectedUserId != null) {
      const user = usersCache.find((u) => String(u.id) === String(selectedUserId));
      if (user) {
        await showUserHeatmapView(user);
        highlightSelected();
        return;
      }
    }
    await applyAudienceHeatmap();
  }

  function filteredUsers() {
    if (listFilter === 'logged') return usersCache.filter((u) => !isGuestUser(u));
    if (listFilter === 'guest') return usersCache.filter((u) => isGuestUser(u));
    return usersCache;
  }

  function renderUserList() {
    if (!usersCache.length) {
      listEl.innerHTML = `<div class="user-empty">${escapeHtml(t('userPanel.noUsersForProject'))}</div>`;
      return;
    }
    const rows = filteredUsers();
    if (!rows.length) {
      const emptyLabel =
        listFilter === 'guest'
          ? t('userPanel.noGuestUsers')
          : listFilter === 'logged'
            ? t('userPanel.noLoggedInUsers')
            : t('userPanel.noUsersForProject');
      listEl.innerHTML = `<div class="user-empty">${escapeHtml(emptyLabel)}</div>`;
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((user) => {
      const index = usersCache.findIndex((u) => String(u.id) === String(user.id));
      const item = document.createElement('div');
      const guest = isGuestUser(user);
      item.className = `user-item${selectedUserId === user.id ? ' active' : ''}${guest ? ' user-item--guest' : ''}`;
      item.dataset.userId = String(user.id);
      const isLive = isRecentlySeen(user.last_seen_at);
      const roleLabel = guest ? escapeHtml(t('userPanel.guestRole')) : escapeHtml(user.role || t('userPanel.loggedInLabel'));
      item.innerHTML = `
        <span class="user-dot" style="background:${isLive ? '#00ff88' : dotColor(Math.max(0, index))}"></span>
        <span class="user-name">${escapeHtml(user.user_name || user.email || t('userPanel.defaultUserName'))}</span>
        <span class="user-role${guest ? ' user-role--guest' : ' user-role--logged'}">${roleLabel}</span>
      `;
      item.addEventListener('click', () => onUserClick(user, Math.max(0, index)));
      listEl.appendChild(item);
    });
  }

  function highlightSelected() {
    listEl.querySelectorAll('.user-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.userId === String(selectedUserId ?? ''));
    });
  }

  async function onUserClick(user, colorIndex) {
    selectedUserId = user.id;
    highlightSelected();
    onUserSelect?.(user);
    await clearSceneViz();

    if (mode === 'live') {
      setMarkersVisible(true);
      setHistoryRouteVisible(false);
      setUserTrailPointsVisible(false);
      await showLivePosition(user, colorIndex);
    } else if (mode === 'history') {
      setMarkersVisible(false);
      setHistoryRouteVisible(true);
      setUserTrailPointsVisible(false);
      await showHistory(user, colorIndex);
    } else {
      setMarkersVisible(false);
      setHistoryRouteVisible(false);
      setUserTrailPointsVisible(true);
      await showUserHeatmapView(user);
    }
  }

  async function showLivePosition(user, colorIndex) {
    try {
      const latest = await fetchLatestNavnodeForUser(user.id);
      if (!latest) return;
      const x = Number(latest.pos_x);
      const y = Number(latest.pos_y);
      const z = Number(latest.pos_z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      addUserMarker(
        user.id,
        String(user.user_name || user.email || t('userPanel.defaultUserName')),
        x,
        y,
        z,
        colorIndex,
      );
      flyTo(x, y, z);
    } catch (err) {
      console.error('[users] live position:', err);
    }
  }

  async function showHistory(user, colorIndex) {
    try {
      const points = await fetchNavnodesForUser(user.id);
      if (!points.length) return;
      drawHistoryRoute(points, colorIndex);
      const first = points[0];
      flyTo(Number(first.pos_x), Number(first.pos_y), Number(first.pos_z));
    } catch (err) {
      console.error('[users] history:', err);
    }
  }

  async function showUserHeatmapView(user) {
    try {
      const points = await fetchNavnodesForUser(user.id);
      if (!points.length) {
        console.warn('[users] heat map: no navnodes for', user.id);
        return;
      }
      clearUserHeatmap();
      if (isMatterportMapActive()) {
        // Don't block the panel on dollhouse fit — overlay paints progressively.
        const overlay = await setMatterportUserTrailOverlay(points);
        if (!overlay.ok && !overlay.empty) {
          console.warn('[users] Matterport trail:', overlay.error);
        } else if (overlay.ok) {
          console.info('[users] Matterport heat points:', overlay.count ?? points.length);
        }
        return;
      }
      drawUserTrailPoints(points, USER_HEAT_ORANGE);
      const first = points[0];
      flyTo(Number(first.pos_x), Number(first.pos_y), Number(first.pos_z));
    } catch (err) {
      console.error('[users] heat map:', err);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollLivePositions, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollLivePositions() {
    if (mode !== 'live') return;
    for (let i = 0; i < usersCache.length; i++) {
      const user = usersCache[i];
      try {
        const latest = await fetchLatestNavnodeForUser(user.id);
        if (!latest) continue;
        const x = Number(latest.pos_x);
        const y = Number(latest.pos_y);
        const z = Number(latest.pos_z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (hasUserMarker(user.id)) {
          updateUserMarker(user.id, x, y, z);
        } else if (user.id === selectedUserId) {
          addUserMarker(
            user.id,
            String(user.user_name || user.email || t('userPanel.defaultUserName')),
            x,
            y,
            z,
            i,
          );
        }
      } catch {
        // ignore per-user poll errors
      }
    }
  }

  function deselect() {
    selectedUserId = null;
    void clearSceneViz();
    stopPolling();
    highlightSelected();
    onUserSelect?.(null);
  }

  return {
    element: panel,
    show() {
      panel.classList.remove('hidden');
      refresh();
    },
    hide() {
      panel.classList.add('hidden');
      stopPolling();
      selectedUserId = null;
      void clearSceneViz();
    },
    refresh,
    deselect,
    clearHeatmap: clearUserHeatmap,
    /** @param {'live' | 'history' | 'heatmap'} newMode */
    setMode(newMode) {
      if (newMode !== 'live' && newMode !== 'history' && newMode !== 'heatmap') return;
      switchMode(newMode);
    },
    getMode: () => mode,
  };
}

function dotColor(i) {
  return DOT_COLORS[i % DOT_COLORS.length];
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isRecentlySeen(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return false;
  return Date.now() - d.getTime() < 5 * 60 * 1000;
}

/** Guest app logins use addresses like `user1.xxx@guest.navme`. */
export function isGuestUser(user) {
  const email = String(user?.email ?? '').trim().toLowerCase();
  return email.includes('@guest.navme');
}

/** Live user counts for the scene stats dock / panel summary. */
export function getUsersBreakdown() {
  let loggedIn = 0;
  let guests = 0;
  for (const user of usersCache) {
    if (isGuestUser(user)) guests += 1;
    else loggedIn += 1;
  }
  return { loggedIn, guests, total: usersCache.length };
}

/** @deprecated Prefer getUsersBreakdown().total */
export function getUsersCount() {
  return usersCache.length;
}
