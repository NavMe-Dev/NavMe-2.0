/**
 * NavMe Spatial Studio shell (immersive editor layout).
 * Top bar · sidebar · 3D viewport · right drawer · contextual stats dock.
 */
import { BRAND_NAME, brandLogoHtml } from '../config/brand.js';
import { bindThemeToggle } from '../config/theme.js';
import { iconSun, iconMoon, iconMedia, iconFacilityColor, iconTreasure, iconZoneBlock as zoneBlockIcon, iconNavMeshShow, iconNavigate, iconBox, iconHelp, iconLock, iconFloorPlan } from './icons.js';
import { poisData, isSuperAdminMapRole } from '../ar/pois.js';
import { facilitiesData } from '../ar/facilities.js';
import { guidedToursData } from '../ar/guided-tours.js';
import { mediaData } from '../ar/media.js';
import { getTreasureCount } from '../ar/treasure.js';
import { blocksData, isStairsZone } from '../ar/blocks.js';
import { getUsersCount, getUsersBreakdown } from './user-panel.js';
import { dashboardAmbientHtml } from './spatial-hero.js';
import { hasSuperadminSession } from '../config/superadmin.js';
import { isProjectAdminSession, isSubAdminSession } from '../config/auth-session.js';
import { showToast } from './toast.js';
import { t, getLanguage, setLanguage } from '../config/i18n.js';
import { NAVME_LANGUAGES } from '../config/languages.js';
import { fetchTenantLanguages } from '../services/supabase.js';
import { getPoiType } from '../config/poi-session.js';

const PANEL_LOCK_LABELS = {
  facilities: () => t('dashboard.lockLabel.amenities'),
  blocks: () => t('dashboard.lockLabel.zones'),
  stairs: () => t('dashboard.lockLabel.zones'),
  users: () => t('dashboard.lockLabel.tracking'),
  treasure: () => t('dashboard.lockLabel.treasure'),
  media: () => t('dashboard.lockLabel.media'),
  'guided-tours': () => t('dashboard.lockLabel.guidedTours'),
};

const SIDEBAR_ITEMS = [
  { id: 'pois', icon: svgPin, label: () => t('dashboard.sidebar.pois') },
  { id: 'floors', icon: svgFloors, label: () => t('dashboard.sidebar.floors'), superAdminOnly: true },
  { id: 'facilities', icon: svgFacility, label: () => t('dashboard.sidebar.facilities') },
  { id: 'guided-tours', icon: svgGuidedTours, label: () => t('dashboard.sidebar.guidedTours') },
  { id: 'media', icon: svgMedia, label: () => t('dashboard.sidebar.media') },
  { id: 'treasure', icon: svgTreasure, label: () => t('dashboard.sidebar.treasure') },
  { id: 'blocks', icon: svgZoneBlock, label: () => t('dashboard.sidebar.zones') },
  { id: 'users', icon: svgUsers, label: () => t('dashboard.sidebar.tracking') },
  { id: 'analytics', icon: svgAnalytics, label: () => t('dashboard.sidebar.userAnalytics'), href: '/analytics' },
  { id: 'wayfinding', icon: svgWayfinding, label: () => t('dashboard.sidebar.wayfinding'), href: '/wayfinding' },
  { id: 'gmap', icon: () => sidebarIcon(iconNavigate), label: () => 'GMap', hidden: true },
  { id: 'profile', icon: svgProfile, label: () => t('dashboard.sidebar.profile') },
];

let activePanel = 'pois';
/** @type {((panelId: string) => void) | null} */
let onPanelChangeCallback = null;
let onLogoutCallback = null;
/** @type {(() => void) | null} */
let onHelpTourCallback = null;

/**
 * Superadmin and project admins configure which languages a project exposes, so
 * they keep the full catalog. Sub-admins and plain project logins only get the
 * languages the project has actually enabled.
 */
function canUseAllLanguages() {
  return hasSuperadminSession() || isProjectAdminSession();
}

function languageSwitcherHtml(langs = NAVME_LANGUAGES) {
  const available = langs.length ? langs : NAVME_LANGUAGES;
  // Never fall back to the full catalog here: a saved language that is no longer
  // offered must not re-expose every option to a restricted user.
  const current = available.some((lang) => lang.code === getLanguage())
    ? getLanguage()
    : available[0].code;
  const options = available
    .map(
      (lang) =>
        `<option value="${lang.code}"${lang.code === current ? ' selected' : ''}>${lang.nativeLabel}</option>`,
    )
    .join('');
  return `
    <select class="topbar-action-btn topbar-lang-select" id="topbar-lang-select" aria-label="${t('dashboard.languageSwitcher.ariaLabel')}" title="${t('dashboard.languageSwitcher.ariaLabel')}">
      ${options}
    </select>`;
}

/** Restrict the language switcher to the languages enabled for this tenant (poi_type). */
async function enabledLanguagesForTenant() {
  if (canUseAllLanguages()) return NAVME_LANGUAGES;
  const poiType = getPoiType();
  if (!poiType) return NAVME_LANGUAGES;
  try {
    const rows = await fetchTenantLanguages(poiType);
    const enabledCodes = new Set(
      rows.filter((row) => row.is_enabled === true || row.is_enabled === 'true' || row.is_enabled === 't')
        .map((row) => String(row.lang_code)),
    );
    enabledCodes.add('en');
    const filtered = NAVME_LANGUAGES.filter((lang) => enabledCodes.has(lang.code));
    return filtered.length ? filtered : NAVME_LANGUAGES;
  } catch {
    // A failed lookup must not strand the user with no switcher at all.
    return NAVME_LANGUAGES;
  }
}

/**
 * @param {HTMLElement} container
 */
export function createDashboard(container) {
  const el = document.createElement('div');
  el.className = 'dashboard hidden immersive-shell glass-shell';
  el.id = 'dashboard';

  el.innerHTML = `
    ${dashboardAmbientHtml()}
    <header class="topbar float-glass">
      <div class="topbar-left">
        <span class="topbar-logo-icon">${brandLogoHtml('brand-logo brand-logo--topbar', 40)}</span>
        <div class="topbar-brand-block">
          <span class="topbar-logo-text">${BRAND_NAME}</span>
        </div>
      </div>
      <div class="topbar-right">
        <div class="topbar-status-slot" id="topbar-status-slot" aria-live="polite"></div>
        <div class="topbar-stat clay-pill" id="topbar-stat" aria-live="polite">
          <div class="topbar-stat-panel active" data-panel="pois">
            <strong class="topbar-stat-value" id="stat-pois">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.pois')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="facilities" hidden>
            <strong class="topbar-stat-value" id="stat-facilities">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.facilities')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="guided-tours" hidden>
            <strong class="topbar-stat-value" id="stat-guided-tours">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.guidedTours')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="media" hidden>
            <strong class="topbar-stat-value" id="stat-media">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.media')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="treasure" hidden>
            <strong class="topbar-stat-value" id="stat-treasure">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.treasures')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="users" hidden>
            <div class="topbar-stat-users" id="stat-users-breakdown">
              <div class="topbar-stat-user-chip topbar-stat-user-chip--logged">
                <strong class="topbar-stat-value" id="stat-users-logged">--</strong>
                <span class="topbar-stat-label">${t('dashboard.stat.loggedIn')}</span>
              </div>
              <div class="topbar-stat-user-chip topbar-stat-user-chip--guest">
                <strong class="topbar-stat-value" id="stat-users-guest">--</strong>
                <span class="topbar-stat-label">${t('dashboard.stat.guests')}</span>
              </div>
            </div>
          </div>
          <div class="topbar-stat-panel" data-panel="blocks" hidden>
            <strong class="topbar-stat-value" id="stat-blocks">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.zoneRestrictions')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="stairs" hidden>
            <strong class="topbar-stat-value" id="stat-stairs">--</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.stairMarkers')}</span>
          </div>
          <div class="topbar-stat-panel" data-panel="profile" hidden>
            <strong class="topbar-stat-value" id="stat-profile">${t('dashboard.stat.profile')}</strong>
            <span class="topbar-stat-label">${t('dashboard.stat.profileSub')}</span>
          </div>
        </div>
        ${languageSwitcherHtml()}
        <button type="button" class="topbar-action-btn topbar-help-btn btn-ripple-host" id="topbar-help" title="${t('dashboard.help.label')}" aria-label="${t('dashboard.help.ariaLabel')}">
          <span class="topbar-help-icon" aria-hidden="true">${iconHelp()}</span>
          <span class="topbar-help-label">${t('dashboard.help.label')}</span>
        </button>
        <button type="button" class="topbar-action-btn theme-toggle btn-ripple-host" id="theme-toggle" aria-label="${t('dashboard.themeToggle.ariaLabel')}">
          <span class="theme-toggle-icon theme-toggle-icon--sun">${iconSun()}</span>
          <span class="theme-toggle-icon theme-toggle-icon--moon">${iconMoon()}</span>
        </button>
        <button type="button" class="topbar-action-btn topbar-logout btn-ripple-host${hasSuperadminSession() ? ' topbar-back-superadmin' : ''}" id="topbar-logout" title="${hasSuperadminSession() ? t('dashboard.logout.backToSuperadmin') : t('dashboard.logout.signOut')}">${hasSuperadminSession() ? t('dashboard.logout.backToSuperadmin') : t('dashboard.logout.logOut')}</button>
      </div>
    </header>

    <nav class="sidebar-nav-block float-glass" id="sidebar-nav" aria-label="${t('dashboard.sidebarNav.ariaLabel')}"></nav>

    <main class="viewport scene-stage scene-float float-glass" id="viewport">
      <div class="scene-hud-clip">
      <div class="viewport-tabs viewport-tabs--display-only" id="viewport-tabs">
        <div class="viewport-map-controls viewport-map-controls--leading">
          <button type="button" class="viewport-accessibility-btn" id="btn-show-navmesh" title="${t('dashboard.navmesh.toggleTitle')}" aria-pressed="false" hidden>
            <span class="viewport-accessibility-icon" data-navmesh-icon>${iconNavMeshShow()}</span>
            <span class="viewport-accessibility-label">${t('dashboard.navmesh.showLabel')}</span>
          </button>
          <button type="button" class="viewport-accessibility-btn viewport-nav-toggle-btn" id="btn-toggle-navigation" title="${t('dashboard.navigation.toggleTitle')}" aria-label="${t('dashboard.navigation.toggleAriaLabel')}" aria-pressed="false" hidden>
            <span class="viewport-accessibility-icon" data-nav-toggle-icon>${iconNavigate()}</span>
            <span class="viewport-accessibility-label" data-nav-toggle-label>${t('dashboard.navigation.showLabel')}</span>
          </button>
          <button type="button" class="viewport-accessibility-btn viewport-route-planner-btn" id="btn-route-planner" title="${t('dashboard.routePlanner.title')}" aria-label="${t('dashboard.routePlanner.ariaLabel')}" aria-expanded="false" hidden>
            <span class="viewport-accessibility-icon">${iconNavigate()}</span>
            <span class="viewport-accessibility-label">${t('dashboard.routePlanner.label')}</span>
          </button>
          <button type="button" class="viewport-accessibility-btn" id="btn-geometric-mesh" title="${t('dashboard.geometricMesh.title')}" aria-pressed="false" hidden>
            <span class="viewport-accessibility-icon">${iconBox()}</span>
            <span class="viewport-accessibility-label">${t('dashboard.geometricMesh.label')}</span>
          </button>
        </div>
        <div class="viewport-map-controls viewport-map-controls--trailing">
          <div class="viewport-map-style" title="${t('dashboard.mapQuality.title')}">
            <label for="map-mesh-quality">${t('dashboard.mapQuality.label')}</label>
            <select id="map-mesh-quality" class="map-display-select">
              <option value="raw" selected>${t('dashboard.mapQuality.raw')}</option>
              <option value="textured">${t('dashboard.mapQuality.textured')}</option>
            </select>
          </div>
          <div class="viewport-map-style" title="${t('dashboard.mapDisplay.title')}">
            <label for="map-display-mode">${t('dashboard.mapDisplay.label')}</label>
            <select id="map-display-mode" class="map-display-select">
              <option value="shaded" selected>${t('dashboard.mapDisplay.shaded')}</option>
              <option value="heatmap">${t('dashboard.mapDisplay.heatmap')}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="viewport-body" id="viewport-body">
        <div class="viewport-3d active" id="viewport-3d"></div>
        <div class="scene-overlay-ui chrome-layer" id="scene-overlay-ui"></div>
      </div>
      </div>
    </main>

    <button type="button" class="drawer-backdrop" id="drawer-backdrop" aria-label="${t('dashboard.drawer.closeAriaLabel')}" hidden></button>
    <aside class="right-panel float-drawer float-glass" id="right-panel" aria-label="${t('dashboard.drawer.panelsAriaLabel')}">
      <div class="drawer-mobile-header">
        <span class="drawer-mobile-title" id="drawer-mobile-title">${t('dashboard.drawer.editorTitle')}</span>
        <button type="button" class="drawer-close-btn btn-ripple-host" id="drawer-close-btn" title="${t('dashboard.drawer.closeAriaLabel')}" aria-label="${t('dashboard.drawer.closeAriaLabel')}">&times;</button>
      </div>
      <div class="drawer-panel-stack" id="drawer-panel-stack">
        <div class="panel-slot active" data-panel="pois" id="slot-pois"></div>
        <div class="panel-slot" data-panel="floors" id="slot-floors"></div>
        <div class="panel-slot" data-panel="facilities" id="slot-facilities"></div>
        <div class="panel-slot" data-panel="guided-tours" id="slot-guided-tours"></div>
        <div class="panel-slot" data-panel="media" id="slot-media"></div>
        <div class="panel-slot" data-panel="treasure" id="slot-treasure"></div>
        <div class="panel-slot" data-panel="blocks" id="slot-blocks"></div>
        <div class="panel-slot" data-panel="stairs" id="slot-stairs"></div>
        <div class="panel-slot" data-panel="users" id="slot-users"></div>
        <div class="panel-slot" data-panel="profile" id="slot-profile"></div>
        <div class="panel-slot" data-panel="gmap" id="slot-gmap"></div>
      </div>
    </aside>
  `;

  container.appendChild(el);

  const drawerBackdrop = el.querySelector('#drawer-backdrop');
  const drawerCloseBtn = el.querySelector('#drawer-close-btn');
  const drawerTitleEl = el.querySelector('#drawer-mobile-title');

  drawerBackdrop?.addEventListener('click', () => closeDrawer(el));
  drawerCloseBtn?.addEventListener('click', () => closeDrawer(el));

  const bindLanguageSelect = (select) => {
    select?.addEventListener('change', (e) => {
      setLanguage(e.target.value);
      window.location.reload();
    });
  };
  bindLanguageSelect(el.querySelector('#topbar-lang-select'));

  enabledLanguagesForTenant().then((langs) => {
    const codes = langs.map((lang) => lang.code);
    // The saved language is no longer offered for this project (or the user is
    // restricted): switch to an allowed one and reload so every panel re-renders.
    if (!codes.includes(getLanguage())) {
      setLanguage(codes.includes('en') ? 'en' : codes[0]);
      window.location.reload();
      return;
    }
    // Filtering preserves order, so an equal length means the full catalog.
    if (codes.length === NAVME_LANGUAGES.length) return;
    const existing = el.querySelector('#topbar-lang-select');
    if (!existing) return;
    const fresh = document.createElement('div');
    fresh.innerHTML = languageSwitcherHtml(langs);
    const newSelect = fresh.firstElementChild;
    existing.replaceWith(newSelect);
    bindLanguageSelect(newSelect);
  });

  const sidebarNavEl = el.querySelector('#sidebar-nav');
  SIDEBAR_ITEMS.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sidebar-btn btn-ripple-host${item.id === activePanel ? ' active' : ''}`;
    btn.dataset.panel = item.id;
    const label = item.label();
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `${item.icon()}<span class="sidebar-label">${label}</span><span class="sidebar-lock" aria-hidden="true">${iconLock()}</span>`;
    if (
      item.id === 'profile' &&
      !(isProjectAdminSession() || isSubAdminSession() || hasSuperadminSession())
    ) {
      btn.hidden = true;
      btn.style.display = 'none';
    }
    if (item.superAdminOnly && !isSuperAdminMapRole()) {
      btn.hidden = true;
      btn.style.display = 'none';
    }
    if (item.hidden) {
      btn.hidden = true;
      btn.style.display = 'none';
    }
    btn.addEventListener('click', () => {
      if (btn.dataset.locked === '1') {
        const label = PANEL_LOCK_LABELS[item.id]?.() ?? item.label();
        showToast(t('dashboard.lockedToast', { label }), 'info');
        return;
      }
      // Items with an href are standalone pages, not editor drawer panels.
      if (item.href) {
        window.location.href = item.href;
        return;
      }
      setActivePanel(item.id, el);
    });
    sidebarNavEl.appendChild(btn);
  });

  if (drawerTitleEl) {
    const active = SIDEBAR_ITEMS.find((item) => item.id === activePanel);
    drawerTitleEl.textContent = active?.label() ?? t('dashboard.drawer.editorTitle');
  }

  const viewport3d = el.querySelector('#viewport-3d');
  const logoutBtn = el.querySelector('#topbar-logout');
  bindThemeToggle(el.querySelector('#theme-toggle'));

  if (hasSuperadminSession()) {
    // Superadmin browse from /access — hide end-user User guide tour.
    el.querySelector('#topbar-help')?.classList.add('hidden');
  } else {
    el.querySelector('#topbar-help')?.addEventListener('click', () => {
      onHelpTourCallback?.();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (hasSuperadminSession()) {
        window.location.href = '/access';
        return;
      }
      onLogoutCallback?.();
    });
  }

  const slots = {
    pois: el.querySelector('#slot-pois'),
    floors: el.querySelector('#slot-floors'),
    facilities: el.querySelector('#slot-facilities'),
    'guided-tours': el.querySelector('#slot-guided-tours'),
    media: el.querySelector('#slot-media'),
    treasure: el.querySelector('#slot-treasure'),
    users: el.querySelector('#slot-users'),
    blocks: el.querySelector('#slot-blocks'),
    stairs: el.querySelector('#slot-stairs'),
    profile: el.querySelector('#slot-profile'),
    gmap: el.querySelector('#slot-gmap'),
  };

  setActivePanel(activePanel, el);

  return {
    element: el,
    viewport: viewport3d,
    viewportBody: el.querySelector('#viewport-body'),
    statusSlot: el.querySelector('#topbar-status-slot'),
    slot: slots.pois,
    slotMedia: slots.media,
    slots,
    openPanel(panelId) {
      if (panelId === 'team') {
        setActivePanel('profile', el);
        el.dataset.openProfileTab = 'admins';
        return;
      }
      delete el.dataset.openProfileTab;
      let resolved = panelId;
      if (panelId === 'logs' || panelId === 'team') resolved = 'profile';
      // Already on this panel — don't refresh/rebuild (that closes Edit POI).
      if (resolved === activePanel) return;
      setActivePanel(panelId, el);
    },
    getEditorMode: () => activePanel,
    setEditorMode(panelId) {
      const id = ['media', 'treasure', 'users', 'blocks', 'stairs', 'facilities', 'floors', 'guided-tours', 'profile'].includes(panelId)
        ? panelId
        : panelId === 'team'
          ? 'profile'
          : 'pois';
      setActivePanel(id, el);
    },
    /** Profile for project admins, sub-admins, and superadmin browse. */
    syncTeamNavVisibility() {
      const showProfile =
        isProjectAdminSession() || isSubAdminSession() || hasSuperadminSession();
      this.setSidebarPanelVisible?.('profile', showProfile);
      this.setSidebarPanelVisible?.('floors', isSuperAdminMapRole());
    },
    onModeChange(cb) {
      onPanelChangeCallback = cb;
    },
    onPanelChange(cb) {
      onPanelChangeCallback = cb;
    },
    onLogout(cb) {
      onLogoutCallback = cb;
    },
    onHelpTour(cb) {
      onHelpTourCallback = typeof cb === 'function' ? cb : null;
    },
    show() {
      el.classList.remove('hidden');
      el.classList.remove('dashboard-enter');
      void el.offsetWidth;
      el.classList.add('dashboard-enter');
      refreshContextStats(el, activePanel);
    },
    hide() {
      el.classList.add('hidden');
    },
    refreshStats(panelId = activePanel) {
      refreshContextStats(el, panelId);
    },
    /**
     * Show/hide a sidebar nav button (and its drawer slot) by panel id.
     * Used for role-based items (Admins / Profile), not project feature flags.
     * @param {string} panelId
     * @param {boolean} visible
     */
    setSidebarPanelVisible(panelId, visible) {
      const show = Boolean(visible);
      const btn = el.querySelector(`.sidebar-btn[data-panel="${panelId}"]`);
      if (btn) {
        btn.hidden = !show;
        btn.style.display = show ? '' : 'none';
        if (!show) {
          btn.classList.remove('is-locked');
          btn.dataset.locked = '0';
          btn.removeAttribute('aria-disabled');
        }
      }
      const slot = slots[panelId];
      if (slot && !show) {
        slot.classList.remove('active');
      }
      if (!show && activePanel === panelId) {
        setActivePanel('pois', el);
      }
    },
    /**
     * Keep a feature sidebar button visible but locked when the project flag is off.
     * @param {string} panelId
     * @param {boolean} locked
     */
    setSidebarPanelLocked(panelId, locked) {
      const isLocked = Boolean(locked);
      const btn = el.querySelector(`.sidebar-btn[data-panel="${panelId}"]`);
      if (btn) {
        btn.hidden = false;
        btn.style.display = '';
        btn.classList.toggle('is-locked', isLocked);
        btn.dataset.locked = isLocked ? '1' : '0';
        if (isLocked) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
      }
      const slot = slots[panelId];
      if (slot && isLocked) {
        slot.classList.remove('active');
      }
      if (isLocked && activePanel === panelId) {
        setActivePanel('pois', el);
      }
    },
  };
}

function setActivePanel(panelId, dashEl) {
  const valid = ['pois', 'floors', 'facilities', 'guided-tours', 'media', 'treasure', 'users', 'blocks', 'stairs', 'gmap', 'profile'];
  // Legacy deep-links: old "logs" / "team" open Profile.
  let resolved = panelId;
  if (panelId === 'logs' || panelId === 'team') resolved = 'profile';
  if (resolved === 'floors' && !isSuperAdminMapRole()) resolved = 'pois';
  activePanel = valid.includes(resolved) ? resolved : 'pois';
  const profileFocus = activePanel === 'profile';
  dashEl.classList.toggle('drawer-open', true);
  dashEl.classList.toggle('logs-focus', profileFocus);
  dashEl.classList.remove('reviews-focus', 'insights-focus');
  dashEl.dataset.activePanel = activePanel;
  dashEl.querySelectorAll('.sidebar-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.panel === activePanel),
  );
  dashEl.querySelectorAll('.panel-slot').forEach((s) => {
    s.classList.toggle('active', s.dataset.panel === activePanel);
  });
  const backdrop = dashEl.querySelector('#drawer-backdrop');
  if (backdrop) backdrop.hidden = profileFocus ? true : false;
  const titleEl = dashEl.querySelector('#drawer-mobile-title');
  if (titleEl) {
    const active = SIDEBAR_ITEMS.find((item) => item.id === activePanel);
    titleEl.textContent = active?.label() ?? t('dashboard.drawer.editorTitle');
  }
  syncTopbarStatPanels(dashEl, activePanel);
  refreshContextStats(dashEl, activePanel);
  onPanelChangeCallback?.(activePanel);
}

function closeDrawer(dashEl) {
  if (dashEl.classList.contains('logs-focus')) {
    setActivePanel('pois', dashEl);
    return;
  }
  dashEl.classList.remove('drawer-open');
  const backdrop = dashEl.querySelector('#drawer-backdrop');
  if (backdrop) backdrop.hidden = true;
}

function syncTopbarStatPanels(dashEl, panelId) {
  dashEl.querySelectorAll('.topbar-stat-panel').forEach((panel) => {
    const on = panel.dataset.panel === panelId;
    panel.classList.toggle('active', on);
    panel.hidden = !on;
  });
}

function refreshContextStats(dashEl, panelId) {
  const poisEl = dashEl.querySelector('#stat-pois');
  const facilitiesEl = dashEl.querySelector('#stat-facilities');
  const toursEl = dashEl.querySelector('#stat-guided-tours');
  const mediaEl = dashEl.querySelector('#stat-media');
  const treasureEl = dashEl.querySelector('#stat-treasure');
  const usersLoggedEl = dashEl.querySelector('#stat-users-logged');
  const usersGuestEl = dashEl.querySelector('#stat-users-guest');
  const blocksEl = dashEl.querySelector('#stat-blocks');
  const stairsEl = dashEl.querySelector('#stat-stairs');

  if (poisEl) poisEl.textContent = String(poisData.length);
  if (facilitiesEl) facilitiesEl.textContent = String(facilitiesData.length);
  if (toursEl) toursEl.textContent = String(guidedToursData.length);
  if (mediaEl) {
    const mapSplats = mediaData.filter((m) => m.is_active && m.media_type === 'splat').length;
    mediaEl.textContent = String(Math.max(0, mediaData.length - mapSplats));
  }
  if (treasureEl) treasureEl.textContent = String(getTreasureCount());
  if (usersLoggedEl || usersGuestEl) {
    const { loggedIn, guests } = getUsersBreakdown();
    if (usersLoggedEl) usersLoggedEl.textContent = String(loggedIn);
    if (usersGuestEl) usersGuestEl.textContent = String(guests);
  } else {
    const usersEl = dashEl.querySelector('#stat-users');
    if (usersEl) usersEl.textContent = String(getUsersCount());
  }
  if (blocksEl) blocksEl.textContent = String(blocksData.filter((b) => !isStairsZone(b)).length);
  if (stairsEl) stairsEl.textContent = String(blocksData.filter((b) => isStairsZone(b)).length);

  syncTopbarStatPanels(dashEl, panelId);
}

function svgWrap(paths) {
  return `<svg class="ui-icon sidebar-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function sidebarIcon(iconFn) {
  return iconFn().replace('class="ui-icon', 'class="ui-icon sidebar-icon');
}

function svgPin() {
  return svgWrap(
    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>',
  );
}

function svgFloors() {
  return sidebarIcon(iconFloorPlan);
}

function svgFacility() {
  return sidebarIcon(iconFacilityColor);
}

function svgGuidedTours() {
  return sidebarIcon(iconNavigate);
}

function svgMedia() {
  return sidebarIcon(iconMedia);
}

function svgTreasure() {
  return sidebarIcon(iconTreasure);
}

function svgWayfinding() {
  /* Route with waypoints — POI to POI planning */
  return svgWrap(
    '<circle cx="6" cy="19" r="2.5"/>' +
      '<circle cx="18" cy="5" r="2.5"/>' +
      '<path d="M8.4 17.6c3-1.2 3.4-4 1.6-5.6s-1-4.4 2-5.6"/>',
  );
}

function svgAnalytics() {
  /* Bar chart — AR session analytics */
  return svgWrap(
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/>' +
      '<rect x="7" y="12" width="3" height="5" rx="1"/>' +
      '<rect x="12" y="8" width="3" height="9" rx="1"/>' +
      '<rect x="17" y="4" width="3" height="13" rx="1"/>',
  );
}

function svgUsers() {
  /* Radar — live tracking signal */
  return svgWrap(
    '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/>' +
      '<path d="M4 6h.01"/>' +
      '<path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/>' +
      '<path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/>' +
      '<path d="M12 18h.01"/>' +
      '<path d="M17.99 11.66A6 6 0 0 1 15.5 15.5"/>' +
      '<circle cx="12" cy="12" r="2"/>',
  );
}

function svgProfile() {
  /* Circle-user — clear profile mark */
  return svgWrap(
    '<circle cx="12" cy="12" r="10"/>' +
      '<circle cx="12" cy="10" r="3"/>' +
      '<path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  );
}

function svgZoneBlock() {
  return sidebarIcon(zoneBlockIcon);
}
