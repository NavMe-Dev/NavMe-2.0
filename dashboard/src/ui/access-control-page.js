/**
 * Standalone `/access` dashboard — tenant-style project cards + per-project feature toggles.
 */

import {
  fetchProjectLogins,
  fetchAllProjectFeatures,
  fetchTenantLanguages,
  initTenantLanguagesAdmin,
  upsertTenantLanguageAdmin,
  insertProjectLogin,
  updateProjectLogin,
  deleteProjectLogin,
  upsertProjectFeaturesAdmin,
  upsertProjectExperienceUrlsAdmin,
  deleteProjectFeaturesAdmin,
  fetchAllMedia,
  insertMediaRow,
  updateMediaRow,
  deleteMediaRow,
  adminAssignProjectAdmin,
  adminListProjectMembers,
  projectAdminUpsertSubAdmin,
  adminGmapUpsertBuilding,
  adminGmapGetBuilding,
  adminGmapSyncPois,
} from '../services/supabase.js';
import { uploadProjectMedia, deleteProjectMediaFile } from '../services/media-storage.js';
import { classifyMediaFile, storagePathFromPublicUrl, NAVMESH_MIME } from '../utils/media-files.js';
import {
  isSuperadminCredentials,
  setSuperadminSession,
  getSuperadminSession,
  clearSuperadminSession,
  SUPERADMIN_EMAIL,
} from '../config/superadmin.js';
import { offerBrowserPasswordSave } from '../utils/browser-password.js';
import '../styles/global.css';
import '../styles/enterprise-theme.css';
import '../styles/glass-theme.css';
import '../styles/glass-animations.css';
import '../styles/spatial-decor.css';
import '../styles/media.css';
import '../styles/access-control.css';
import { initTheme, bindThemeToggle } from '../config/theme.js';
import { BRAND_NAME } from '../config/brand.js';
import {
  iconSun,
  iconMoon,
  iconArrowLeft,
  iconEditor3d,
  iconFloorPlan,
  iconChevronRight,
  iconSearch,
  iconUsers,
  iconActivity,
  iconLogout,
  iconAdd,
  iconClose,
  iconSave,
  iconEdit,
  iconDelete,
  iconMapPin,
  iconCopy,
  iconDownload,
  iconQrCode,
  iconZoneBlock,
  iconGlobe,
  iconEye,
  iconEyeOff,
  iconNavigate,
  iconBox,
  iconMedia,
  iconFacilityColor,
  iconTreasure,
} from './icons.js';
import { getDefaultOrganizationId } from '../config/organization.js';
import { setPendingProjectLogin } from '../config/project-login-bridge.js';
import { parseDbBool } from '../utils/parse-db-bool.js';
import { MULTISET_MAP } from '../config/spacecheck-access.js';
import { NAVME_LANGUAGES } from '../config/languages.js';
import { showToast } from './toast.js';
import { openSplatViewerModal } from './splat-viewer-modal.js';
import { parseMatterportModelId, isMatterportMediaRow, MATTERPORT_MIME } from '../services/matterport-url.js';
import { logUserActivity } from '../services/user-logs.js';
import {
  generateQrDataUrl,
  loadImageFromFile,
  validateLogoFile,
} from '../utils/qr-with-logo.js';
import { loadUserLogsFeed } from './user-logs-panel.js';
import { askConfirm } from './confirm-dialog.js';
import { getLanguage, setLanguage, t } from '../config/i18n.js';

function languageSwitcherHtml() {
  const current = getLanguage();
  const options = NAVME_LANGUAGES.map(
    (lang) => `<option value="${lang.code}"${lang.code === current ? ' selected' : ''}>${lang.nativeLabel}</option>`,
  ).join('');
  const label = t('dashboard.languageSwitcher.ariaLabel');
  return `<select class="topbar-action-btn topbar-lang-select" id="access-language-select" aria-label="${label}" title="${label}">${options}</select>`;
}

const DETAIL_SECTIONS = ['admins', 'features', 'assets', 'gmap', 'logs'];

const ACCESS_UI_FEATURES = [
  {
    key: 'people_search',
    label: t('accessControl.features.peopleSearch.label'),
    desc: t('accessControl.features.peopleSearch.desc'),
    icon: iconUsers,
  },
  {
    key: 'save_location',
    label: t('accessControl.features.saveLocation.label'),
    desc: t('accessControl.features.saveLocation.desc'),
    icon: iconMapPin,
  },
  {
    key: 'block_enabled',
    label: t('accessControl.features.blockEnabled.label'),
    desc: t('accessControl.features.blockEnabled.desc'),
    icon: iconZoneBlock,
  },
  {
    key: 'mini3d_gta_embed',
    label: t('accessControl.features.mini3dGtaEmbed.label'),
    desc: t('accessControl.features.mini3dGtaEmbed.desc'),
    icon: iconEditor3d,
  },
  {
    key: 'custom_media',
    label: t('accessControl.features.customMedia.label'),
    desc: t('accessControl.features.customMedia.desc'),
    icon: iconMedia,
  },
  {
    key: 'languages',
    label: t('accessControl.features.languages.label'),
    desc: t('accessControl.features.languages.desc'),
    icon: iconGlobe,
  },
  {
    key: 'fps_display',
    label: t('accessControl.features.fpsDisplay.label'),
    desc: t('accessControl.features.fpsDisplay.desc'),
    icon: iconEye,
  },
  {
    key: 'localization_display',
    label: t('accessControl.features.localizationDisplay.label'),
    desc: t('accessControl.features.localizationDisplay.desc'),
    icon: iconNavigate,
  },
  {
    key: 'navme_robo_companion',
    label: t('accessControl.features.navmeRoboCompanion.label'),
    desc: t('accessControl.features.navmeRoboCompanion.desc'),
    icon: iconBox,
    // Which character walks with the user. Only meaningful while the toggle is
    // on, so the picker is disabled when it is off.
    choice: {
      key: 'companion_model',
      label: 'Character',
      options: [
        { value: 'guidebot', label: 'NavMe Guide Bot' },
        { value: 'ramanujan', label: 'Ramanujan' },
      ],
    },
  },
  {
    key: 'facilities',
    label: t('accessControl.features.facilities.label'),
    desc: t('accessControl.features.facilities.desc'),
    icon: iconFacilityColor,
  },
  {
    key: 'treasure',
    label: t('accessControl.features.treasure.label'),
    desc: t('accessControl.features.treasure.desc'),
    icon: iconTreasure,
  },
  {
    key: 'guided_tours',
    label: t('accessControl.features.guidedTours.label'),
    desc: t('accessControl.features.guidedTours.desc'),
    icon: iconNavigate,
  },
  {
    key: 'matterport_navigation',
    label: 'Matterport Navigation',
    desc:
      'Offer 3D navigation as an alternative to AR. On weak Android devices, where localisation ' +
      'stays under 60%, the experience suggests switching to the 3D map instead of degrading in AR.',
    icon: iconNavigate,
  },
  {
    key: 'navme_gmap_enabled',
    label: 'NavMe GMap Structure',
    desc: 'Provisions a NavMe wayfinding building for this project. When enabled, go to the GMap panel to set the Matterport model SID and trigger provisioning.',
    icon: iconNavigate,
  },
  {
    key: 'walkthrough_mode',
    label: 'Walkthrough Mode',
    desc: 'Choose how the experience starts: AR first, Walkthrough first, or Hybrid (AR on capable devices).',
    icon: iconNavigate,
    choice: {
      key: 'walkthrough_mode',
      label: 'Start Mode',
      options: [
        { value: 'walkthrough_first', label: 'Walkthrough First (3D view)' },
        { value: 'ar_first', label: 'AR First (camera view)' },
        { value: 'hybrid', label: 'Hybrid (smart detection)' },
      ],
    },
    isChoiceOnly: true,
  },
];

const DEFAULT_FEATURES = {
  people_search: true,
  save_location: true,
  block_enabled: true,
  mini3d_gta_embed: false,
  languages: false,
  custom_media: true,
  assistant: false,
  snapshot: false,
  whatsapp: false,
  feedback: false,
  fps_display: false,
  localization_display: false,
  navme_robo_companion: false,
  companion_model: 'guidebot',
  facilities: false,
  treasure: false,
  guided_tours: false,
  matterport_navigation: false,
  navme_gmap_enabled: false,
  walkthrough_mode: 'walkthrough_first',
};

/** Text settings that must not go through the boolean coercion below. */
const FEATURE_CHOICE_KEYS = ['companion_model', 'walkthrough_mode'];
const FEATURE_FLAG_KEYS = Object.keys(DEFAULT_FEATURES).filter(
  (k) => !FEATURE_CHOICE_KEYS.includes(k),
);

function normalizeFeatureRow(row) {
  const normalized = { ...DEFAULT_FEATURES };
  if (!row || typeof row !== 'object') return normalized;
  for (const key of FEATURE_FLAG_KEYS) {
    normalized[key] = parseDbBool(row[key], DEFAULT_FEATURES[key]);
  }
  for (const key of FEATURE_CHOICE_KEYS) {
    const raw = String(row[key] ?? '').trim().toLowerCase();
    if (raw) normalized[key] = raw;
  }
  return normalized;
}

function isFeatureEnabled(features, key) {
  return parseDbBool(features?.[key], DEFAULT_FEATURES[key]);
}

function experienceUrlsFromRow(row) {
  return {
    project_url: String(row?.project_url ?? '').trim(),
    whitelabeled_url: String(row?.whitelabeled_url ?? '').trim(),
  };
}

function languageMeta(code) {
  return NAVME_LANGUAGES.find((lang) => lang.code === code) ?? {
    code,
    label: code.toUpperCase(),
    nativeLabel: code.toUpperCase(),
  };
}

function normalizeLanguageRows(rows) {
  const byCode = new Map(
    (Array.isArray(rows) ? rows : []).map((row) => [String(row.lang_code ?? ''), row]),
  );

  return NAVME_LANGUAGES.map((lang, index) => {
    const row = byCode.get(lang.code);
    return {
      lang_code: lang.code,
      native_label: String(row?.native_label ?? lang.nativeLabel),
      is_enabled: parseDbBool(row?.is_enabled, lang.code === 'en'),
      sort_order: Number(row?.sort_order ?? index + 1),
      id: row?.id ?? null,
    };
  });
}

function enabledLanguageCount(languages) {
  return languages.filter((row) => parseDbBool(row.is_enabled, false)).length;
}

/**
 * @param {HTMLElement} container
 */
export function initAccessControlPage(container) {
  initTheme();
  container.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'glass-shell access-control-page';
  page.innerHTML = `
    <div class="access-ambient" aria-hidden="true">
      <div class="spatial-ambient-bg"></div>
    </div>

    <header class="access-topbar float-glass">
      <img src="/NavMe_wb.png" alt="${BRAND_NAME}" class="topbar-logo-img" />
      <div class="access-topbar-copy">
        <h1 id="access-page-title">${t('accessControl.header.title')}</h1>
        <p class="access-subtitle" id="access-page-subtitle">${t('accessControl.header.subtitle')}</p>
      </div>
      <div class="access-topbar-actions">
        ${languageSwitcherHtml()}
        <a href="/" class="topbar-action-btn access-editor-link btn-ripple-host" title="${t('accessControl.header.backToBrand', { brand: BRAND_NAME })}">
          <span class="access-icon-slot" aria-hidden="true">${iconArrowLeft()}${iconEditor3d()}</span>
          <span>${BRAND_NAME}</span>
        </a>
        <button type="button" class="topbar-action-btn theme-toggle btn-ripple-host" id="access-theme-toggle" aria-label="${t('accessControl.header.switchTheme')}">
          <span class="theme-toggle-icon theme-toggle-icon--sun">${iconSun()}</span>
          <span class="theme-toggle-icon theme-toggle-icon--moon">${iconMoon()}</span>
        </button>
        <button type="button" class="topbar-action-btn topbar-logout access-logout-btn btn-ripple-host" id="access-logout" title="${t('accessControl.header.signOut')}">
          <span class="access-icon-slot" aria-hidden="true">${iconLogout()}</span>
          <span>${t('accessControl.header.logOut')}</span>
        </button>
      </div>
    </header>

    <div class="access-page-scroll" id="access-page-scroll">
      <div class="access-login-wrap" id="access-login-wrap">
        <div class="access-login-card float-glass">
          <div class="access-login-badge">${iconUsers()} ${t('accessControl.login.superadmin')}</div>
          <h2>${t('accessControl.login.heading')}</h2>
          <p class="access-login-hint">${t('accessControl.login.hint', { email: SUPERADMIN_EMAIL })}</p>
          <p class="form-error hidden" id="access-login-error" role="alert"></p>
          <form id="access-login-form" autocomplete="on" method="post" action="/access">
            <div class="form-group">
              <label for="access-email">${t('accessControl.login.emailLabel')}</label>
              <input id="access-email" name="email" type="email" autocomplete="username" required />
            </div>
            <div class="form-group">
              <label for="access-password">${t('accessControl.login.passwordLabel')}</label>
              <input id="access-password" name="password" type="password" autocomplete="current-password" required />
            </div>
            <button type="submit" class="btn-start" id="access-login-btn">${t('accessControl.login.signIn')}</button>
          </form>
        </div>
      </div>

      <main class="access-main hidden" id="access-main">
        <div class="access-shell" id="access-shell">
          <nav class="access-hud" id="access-hud" aria-label="${t('accessControl.hud.accessCommand')}">
            <div class="access-hud-rail" aria-hidden="true"></div>
            <button type="button" class="access-hud-node btn-ripple-host is-active" data-hud="tenants" aria-current="page">
              <span class="access-hud-orb">${iconUsers()}</span>
              <span class="access-hud-label">${t('accessControl.hud.tenants')}</span>
            </button>
            <button type="button" class="access-hud-node btn-ripple-host" data-hud="logs">
              <span class="access-hud-orb">${iconActivity()}</span>
              <span class="access-hud-label">${t('accessControl.hud.userLogs')}</span>
            </button>
          </nav>

          <div class="access-shell-body">
            <section class="access-view access-view--grid" id="access-grid-view">
              <div class="access-toolbar float-glass">
                <label class="access-search-field">
                  <span class="access-search-icon" aria-hidden="true">${iconSearch()}</span>
                  <input type="search" id="access-search" placeholder="${t('accessControl.toolbar.searchPlaceholder')}" />
                </label>
                <button type="button" class="access-add-tenant-btn btn-ripple-host" id="btn-add-project">
                  <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
                  <span>${t('accessControl.toolbar.newProjectTenant')}</span>
                </button>
              </div>
              <div class="access-card-grid" id="access-card-grid" role="list"></div>
            </section>

            <section class="access-view access-view--logs hidden" id="access-logs-view">
              <div class="access-feature-panel float-glass access-user-logs-panel access-user-logs-panel--page">
                <div class="access-feature-panel-head access-user-logs-head">
                  <div>
                    <h2>${t('accessControl.logs.userLogs')}</h2>
                    <p>${t('accessControl.logs.globalDesc')}</p>
                  </div>
                </div>
                <div class="user-logs-feed" id="access-global-logs"></div>
              </div>
            </section>
          </div>
        </div>

        <section class="access-view access-view--detail hidden" id="access-detail-view">
          <button type="button" class="access-back-btn btn-ripple-host" id="access-back-btn">
            <span class="access-icon-slot" aria-hidden="true">${iconArrowLeft()}</span>
            <span>${t('accessControl.detail.allProjectTenants')}</span>
          </button>
          <div class="access-detail-hero float-glass" id="access-detail-hero"></div>

          <div class="access-detail-shell" id="access-detail-shell">
            <nav class="access-hud access-detail-hud" id="access-detail-hud" aria-label="${t('accessControl.detail.tenantSections')}">
              <div class="access-hud-rail" aria-hidden="true"></div>
              <button type="button" class="access-hud-node btn-ripple-host is-active" data-detail="admins" aria-current="page">
                <span class="access-hud-orb">${iconUsers()}</span>
                <span class="access-hud-label">${t('accessControl.hud.admins')}</span>
              </button>
              <button type="button" class="access-hud-node btn-ripple-host" data-detail="features">
                <span class="access-hud-orb">${iconGlobe()}</span>
                <span class="access-hud-label">${t('accessControl.hud.features')}</span>
              </button>
              <button type="button" class="access-hud-node btn-ripple-host" data-detail="assets">
                <span class="access-hud-orb">${iconBox()}</span>
                <span class="access-hud-label">${t('accessControl.hud.mapLoad')}</span>
              </button>
              <button type="button" class="access-hud-node btn-ripple-host" data-detail="gmap">
                <span class="access-hud-orb">${iconNavigate()}</span>
                <span class="access-hud-label">GMap</span>
              </button>
              <button type="button" class="access-hud-node btn-ripple-host" data-detail="logs">
                <span class="access-hud-orb">${iconActivity()}</span>
                <span class="access-hud-label">${t('accessControl.hud.userLogs')}</span>
              </button>
            </nav>

            <div class="access-detail-body">
              <div class="access-detail-pane" data-detail-pane="admins">
          <div class="access-feature-panel float-glass" id="access-project-admin-panel">
            <div class="access-feature-panel-head">
              <h2>${t('accessControl.admins.heading')}</h2>
              <p>${t('accessControl.admins.desc')}</p>
            </div>
            <div class="access-project-admin-body" id="access-project-admin-body">
              <div class="access-cred-stack" id="access-tenant-cred-card"></div>
              <p class="access-project-admin-current" id="access-project-admin-current">${t('accessControl.common.loading')}</p>
              <div class="access-cred-stack" id="access-admin-cred-card"></div>
              <form class="access-team-form" id="access-project-admin-form">
                <h3 class="access-team-form-title">${t('accessControl.admins.assignFormTitle')}</h3>
                <div class="access-team-form-grid">
                  <div class="form-group">
                    <label for="access-admin-email">${t('accessControl.admins.adminEmailLabel')}</label>
                    <input id="access-admin-email" type="email" required autocomplete="off" placeholder="admin@company.com" />
                  </div>
                  <div class="form-group">
                    <label for="access-admin-password">${t('accessControl.admins.passwordLabel')}</label>
                    <input id="access-admin-password" type="password" required autocomplete="new-password" placeholder="${t('accessControl.admins.setPasswordPlaceholder')}" />
                  </div>
                  <div class="form-group">
                    <label for="access-admin-name">${t('accessControl.admins.displayNameLabel')}</label>
                    <input id="access-admin-name" type="text" autocomplete="off" placeholder="${t('accessControl.admins.optionalNamePlaceholder')}" />
                  </div>
                </div>
                <button type="submit" class="access-save-btn btn-ripple-host" id="access-admin-assign-btn">
                  <span>${t('accessControl.admins.saveProjectAdmin')}</span>
                </button>
              </form>
              <form class="access-team-form access-team-form--sub" id="access-subadmin-form">
                <h3 class="access-team-form-title">${t('accessControl.admins.addSubAdminTitle')}</h3>
                <p class="access-field-help">${t('accessControl.admins.subAdminHelp')}</p>
                <div class="access-team-form-grid">
                  <div class="form-group">
                    <label for="access-sub-email">${t('accessControl.admins.subAdminEmailLabel')}</label>
                    <input id="access-sub-email" type="email" required autocomplete="off" placeholder="editor@company.com" />
                  </div>
                  <div class="form-group">
                    <label for="access-sub-password">${t('accessControl.admins.passwordLabel')}</label>
                    <input id="access-sub-password" type="password" required autocomplete="new-password" placeholder="${t('accessControl.admins.setPasswordPlaceholder')}" />
                  </div>
                  <div class="form-group">
                    <label for="access-sub-name">${t('accessControl.admins.displayNameLabel')}</label>
                    <input id="access-sub-name" type="text" autocomplete="off" placeholder="${t('accessControl.admins.optionalNamePlaceholder')}" />
                  </div>
                </div>
                <button type="submit" class="access-save-btn btn-ripple-host" id="access-sub-add-btn">
                  <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
                  <span>${t('accessControl.admins.addSubAdmin')}</span>
                </button>
              </form>
              <div class="access-subadmin-list" id="access-subadmin-list"></div>
            </div>
          </div>
              </div>

              <div class="access-detail-pane hidden" data-detail-pane="features">
          <div class="access-feature-panel float-glass" id="access-features-panel">
            <div class="access-feature-panel-head">
              <h2>${t('accessControl.featuresPanel.heading')}</h2>
              <p>${t('accessControl.featuresPanel.desc')}</p>
            </div>
            <div class="access-experience-urls" id="access-experience-urls">
              <div class="form-group access-form-group">
                <label for="access-project-url">${t('accessControl.urls.projectUrlLabel')}</label>
                <div class="access-dialog-field-row">
                  <input id="access-project-url" type="url" spellcheck="false" autocomplete="off" placeholder="https://navme.space/…" />
                  <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="access-project-url" title="${t('accessControl.urls.copyProjectUrl')}" aria-label="${t('accessControl.urls.copyProjectUrl')}">
                    ${iconCopy()}
                  </button>
                </div>
              </div>
              <div class="form-group access-form-group">
                <label for="access-whitelabeled-url">${t('accessControl.urls.whitelabeledUrlLabel')}</label>
                <div class="access-dialog-field-row">
                  <input id="access-whitelabeled-url" type="url" spellcheck="false" autocomplete="off" placeholder="https://wayfinding.example.com/…" />
                  <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="access-whitelabeled-url" title="${t('accessControl.urls.copyWhitelabeledUrl')}" aria-label="${t('accessControl.urls.copyWhitelabeledUrl')}">
                    ${iconCopy()}
                  </button>
                  <button type="button" class="access-generate-qr-btn btn-ripple-host" id="access-whitelabel-generate-qr" title="${t('accessControl.urls.generateQrTitle')}" aria-label="${t('accessControl.urls.generateQrAria')}">
                    ${iconQrCode()}
                    <span>${t('accessControl.urls.generateQr')}</span>
                  </button>
                </div>
              </div>
              <button type="button" class="access-save-btn btn-ripple-host" id="access-experience-urls-save">
                <span class="access-icon-slot" aria-hidden="true">${iconSave()}</span>
                <span>${t('accessControl.urls.saveExperienceUrls')}</span>
              </button>
            </div>
            <div class="access-switch-list" id="access-switch-list"></div>
          </div>
          <div class="access-feature-panel access-language-panel float-glass hidden" id="access-language-panel">
            <div class="access-feature-panel-head">
              <h2>${t('accessControl.languages.heading')}</h2>
              <p>${t('accessControl.languages.desc')}</p>
            </div>
            <div class="access-switch-list" id="access-language-list"></div>
          </div>
              </div>

              <div class="access-detail-pane hidden" data-detail-pane="assets">
          <div class="access-feature-panel access-splat-panel float-glass" id="access-splat-panel">
            <div class="access-feature-panel-head access-splat-panel-head">
              <div class="access-splat-panel-copy">
                <h2>${t('accessControl.assets.splat.heading')}</h2>
                <p>${t('accessControl.assets.splat.descPre')} <code>.ply</code> ${t('accessControl.assets.splat.descMid')} <span id="access-splat-poi-label">poi_type</span>${t('accessControl.assets.splat.descPost')}</p>
              </div>
              <div class="access-splat-toolbar">
                <button type="button" class="access-save-btn btn-ripple-host" id="access-splat-upload-btn">
                  <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
                  <span>${t('accessControl.assets.splat.uploadButton')}</span>
                </button>
                <input type="file" id="access-splat-file-input" class="hidden" accept=".ply,application/octet-stream" multiple />
                <span class="access-splat-status" id="access-splat-status" aria-live="polite"></span>
              </div>
            </div>
            <div class="access-splat-list" id="access-splat-list"></div>
          </div>

          <div class="access-feature-panel access-splat-panel float-glass" id="access-matterport-panel">
            <div class="access-feature-panel-head access-splat-panel-head">
              <div class="access-splat-panel-copy">
                <h2>${t('accessControl.assets.space.heading')}</h2>
                <p>
                  ${t('accessControl.assets.space.descPre')}
                  <span id="access-matterport-poi-label">poi_type</span>.
                  ${t('accessControl.assets.space.descPost', { brand: BRAND_NAME })}
                </p>
              </div>
            </div>
            <div class="access-matterport-form">
              <label class="field-label" for="access-matterport-url">${t('accessControl.assets.space.urlLabel')}</label>
              <div class="access-splat-toolbar access-matterport-toolbar">
                <input
                  id="access-matterport-url"
                  type="url"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="${t('accessControl.assets.space.urlPlaceholder')}"
                />
                <button type="button" class="access-save-btn btn-ripple-host" id="access-matterport-save-btn">
                  <span>${t('accessControl.assets.space.saveLink')}</span>
                </button>
                <button type="button" class="access-action-btn btn-ripple-host" id="access-matterport-clear-btn">
                  <span>${t('accessControl.common.clear')}</span>
                </button>
              </div>
              <span class="access-splat-status" id="access-matterport-status" aria-live="polite"></span>
              <div class="access-splat-list" id="access-matterport-list"></div>
            </div>
          </div>

          <div class="access-feature-panel access-splat-panel float-glass" id="access-navmesh-panel">
            <div class="access-feature-panel-head access-splat-panel-head">
              <div class="access-splat-panel-copy">
                <h2>${t('accessControl.assets.navmesh.heading')}</h2>
                <p>
                  ${t('accessControl.assets.navmesh.descPre')} <code>.navmesh</code> ${t('accessControl.assets.navmesh.descExample')} <code>generated.navmesh</code>) ${t('accessControl.assets.navmesh.descFor')}
                  <span id="access-navmesh-poi-label">poi_type</span>.
                  ${t('accessControl.assets.navmesh.descPost', { brand: BRAND_NAME })}
                </p>
              </div>
              <div class="access-splat-toolbar">
                <button type="button" class="access-save-btn btn-ripple-host" id="access-navmesh-upload-btn">
                  <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
                  <span>${t('accessControl.assets.navmesh.uploadButton')}</span>
                </button>
                <input type="file" id="access-navmesh-file-input" class="hidden" accept=".navmesh,application/octet-stream" />
                <span class="access-splat-status" id="access-navmesh-status" aria-live="polite"></span>
              </div>
            </div>
            <div class="access-splat-list" id="access-navmesh-list"></div>
          </div>
              </div>

              <div class="access-detail-pane hidden" data-detail-pane="gmap">
                <div class="access-feature-panel float-glass" id="access-gmap-panel">
                  <div class="access-feature-panel-head">
                    <h3>NavMe GMap Structure</h3>
                    <p class="access-field-help">Provision a NavMe wayfinding building and keep its POIs in sync with this project's POIs. Enable the toggle in Features first.</p>
                  </div>
                  <div class="access-feature-panel-body">
                    <label class="access-field-label" for="gmap-slug">Building Slug</label>
                    <input class="access-field-input" id="gmap-slug" type="text" placeholder="e.g. gcu-omr-with-library" autocomplete="off">
                    <label class="access-field-label" for="gmap-account-email">Account Email</label>
                    <input class="access-field-input" id="gmap-account-email" type="email" placeholder="e.g. gcu@navme.space" autocomplete="off">
                    <label class="access-field-label" for="gmap-sid">Matterport Model SID <span style="font-weight:400;opacity:.65">(optional)</span></label>
                    <input class="access-field-input" id="gmap-sid" type="text" placeholder="e.g. SobWn3R6iaf" autocomplete="off">
                    <label class="access-field-label" for="gmap-wf-url">Wayfinding Admin URL <span style="font-weight:400;opacity:.65">(e.g. http://localhost:8780)</span></label>
                    <input class="access-field-input" id="gmap-wf-url" type="url" placeholder="http://localhost:8780" autocomplete="off">
                    <div class="access-gmap-actions" style="display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap">
                      <button type="button" class="access-btn access-btn--primary" id="gmap-save-btn">Save</button>
                      <button type="button" class="access-btn" id="gmap-open-btn" disabled>Open Wayfinding Admin</button>
                      <button type="button" class="access-btn" id="gmap-sync-btn" disabled>Sync POIs → Wayfinding</button>
                    </div>
                    <p id="gmap-status" style="font-size:13px;opacity:.75;margin-top:8px"></p>
                  </div>
                </div>
              </div>

              <div class="access-detail-pane hidden" data-detail-pane="logs">
          <div class="access-feature-panel float-glass access-user-logs-panel" id="access-project-logs-panel">
            <div class="access-feature-panel-head access-user-logs-head">
              <div>
                <h2>${t('accessControl.logs.userLogs')}</h2>
                <p>${t('accessControl.logs.projectDesc')}</p>
              </div>
            </div>
            <div class="user-logs-feed" id="access-project-logs"></div>
          </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>

    <dialog class="access-dialog" id="access-project-dialog">
      <form method="dialog" class="access-dialog-card float-glass" id="access-project-form">
        <header class="access-dialog-header">
          <div class="access-dialog-heading">
            <span class="access-dialog-icon" aria-hidden="true">${iconUsers()}</span>
            <div>
              <h3 id="access-dialog-title">${t('accessControl.dialog.newProjectTenant')}</h3>
              <p id="access-dialog-subtitle">${t('accessControl.dialog.registerSubtitle')}</p>
            </div>
          </div>
          <button type="button" class="access-dialog-close btn-ripple-host" id="access-dialog-close" aria-label="${t('accessControl.common.close')}">${iconClose()}</button>
        </header>
        <div class="access-dialog-body">
          <div class="form-group access-form-group">
            <label for="dialog-poi-type">${t('accessControl.dialog.projectNameLabel')} <span class="access-label-hint">(poi_type)</span></label>
            <div class="access-dialog-field-row">
              <input id="dialog-poi-type" type="text" required placeholder="e.g. IIPC, maclab" />
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="dialog-poi-type" title="${t('accessControl.dialog.copyProjectName')}" aria-label="${t('accessControl.dialog.copyProjectName')}">
                ${iconCopy()}
              </button>
            </div>
            <p class="access-field-help">${t('accessControl.dialog.projectNameHelp')}</p>
          </div>
          <div class="form-group access-form-group">
            <label for="dialog-email">${t('accessControl.dialog.tenantEmailLabel')}</label>
            <div class="access-dialog-field-row">
              <input
                id="dialog-email"
                type="email"
                required
                placeholder="name@navme.space"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                data-lpignore="true"
                data-1p-ignore="true"
              />
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="dialog-email" title="${t('accessControl.dialog.copyEmail')}" aria-label="${t('accessControl.dialog.copyEmail')}">
                ${iconCopy()}
              </button>
            </div>
            <p class="access-field-help">${t('accessControl.dialog.emailUniqueHelp')}</p>
          </div>
          <div class="form-group access-form-group">
            <label for="dialog-password">${t('accessControl.dialog.tenantPasswordLabel')}</label>
            <div class="access-dialog-field-row">
              <input id="dialog-password" name="password" type="password" autocomplete="new-password" required placeholder="${t('accessControl.dialog.securePasswordPlaceholder')}" />
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-toggle-secret="dialog-password" title="${t('accessControl.common.showPassword')}" aria-label="${t('accessControl.common.showPassword')}" aria-pressed="false">
                ${iconEye()}
              </button>
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="dialog-password" title="${t('accessControl.dialog.copyPassword')}" aria-label="${t('accessControl.dialog.copyPassword')}">
                ${iconCopy()}
              </button>
            </div>
          </div>
          <div class="form-group access-form-group">
            <label for="dialog-map-code">${t('accessControl.dialog.mapCodeLabel')}</label>
            <div class="access-dialog-field-row">
              <input id="dialog-map-code" type="text" required placeholder="${t('accessControl.dialog.mapCodePlaceholder')}" />
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="dialog-map-code" title="${t('accessControl.dialog.copyMapCode')}" aria-label="${t('accessControl.dialog.copyMapCode')}">
                ${iconCopy()}
              </button>
            </div>
            <p class="access-field-help">${t('accessControl.dialog.mapCodeHelp', { brand: BRAND_NAME })}</p>
          </div>
          <div class="form-group access-form-group">
            <label for="dialog-client-id">${t('accessControl.dialog.clientIdLabel')}</label>
            <div class="access-dialog-field-row">
              <input id="dialog-client-id" type="text" required placeholder="${t('accessControl.dialog.clientIdPlaceholder')}" />
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="dialog-client-id" title="${t('accessControl.dialog.copyClientId')}" aria-label="${t('accessControl.dialog.copyClientId')}">
                ${iconCopy()}
              </button>
            </div>
          </div>
          <div class="form-group access-form-group">
            <label for="dialog-client-secret">${t('accessControl.dialog.clientSecretLabel')}</label>
            <div class="access-dialog-field-row">
              <input id="dialog-client-secret" type="password" required placeholder="${t('accessControl.dialog.clientSecretPlaceholder')}" autocomplete="off" />
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-toggle-secret="dialog-client-secret" title="${t('accessControl.common.showClientSecret')}" aria-label="${t('accessControl.common.showClientSecret')}" aria-pressed="false">
                ${iconEye()}
              </button>
              <button type="button" class="access-copy-map-btn btn-ripple-host" data-copy-input="dialog-client-secret" title="${t('accessControl.dialog.copyClientSecret')}" aria-label="${t('accessControl.dialog.copyClientSecret')}">
                ${iconCopy()}
              </button>
            </div>
            <p class="access-field-help">${t('accessControl.dialog.clientSecretHelp')}</p>
          </div>
        </div>
        <footer class="access-dialog-actions">
          <button type="button" class="access-action-btn btn-ripple-host" id="access-dialog-cancel">
            <span class="access-icon-slot" aria-hidden="true">${iconClose()}</span>
            <span>${t('accessControl.common.cancel')}</span>
          </button>
          <button type="submit" class="access-save-btn btn-ripple-host" id="access-dialog-save">
            <span class="access-icon-slot" aria-hidden="true">${iconSave()}</span>
            <span id="access-dialog-save-label">${t('accessControl.dialog.createTenant')}</span>
          </button>
        </footer>
      </form>
    </dialog>

    <dialog class="access-dialog access-qr-dialog" id="access-whitelabel-qr-dialog" aria-labelledby="access-qr-dialog-title">
      <form method="dialog" class="access-dialog-form access-qr-dialog-form" id="access-whitelabel-qr-form">
        <header class="access-dialog-head">
          <div>
            <h2 id="access-qr-dialog-title">${t('accessControl.qr.heading')}</h2>
            <p class="access-qr-dialog-url" id="access-qr-dialog-url"></p>
          </div>
          <button type="button" class="access-copy-map-btn btn-ripple-host" id="access-qr-dialog-close" title="${t('accessControl.common.close')}" aria-label="${t('accessControl.common.close')}">
            ${iconClose()}
          </button>
        </header>
        <div class="access-qr-dialog-body">
          <div class="access-qr-preview" id="access-qr-preview" aria-live="polite">
            <img id="access-qr-image" alt="${t('accessControl.qr.imageAlt')}" hidden />
            <p class="access-qr-status" id="access-qr-status">${t('accessControl.qr.generating')}</p>
          </div>
          <div class="access-qr-logo-panel">
            <span class="access-qr-logo-title">${t('accessControl.qr.centerLogo')} <span class="access-qr-logo-optional">(${t('accessControl.common.optional')})</span></span>
            <div class="access-qr-logo-row">
              <span class="access-qr-logo-thumb" id="access-qr-logo-thumb" aria-hidden="true"></span>
              <div class="access-qr-logo-actions">
                <label class="access-action-btn access-qr-logo-btn" for="access-qr-logo-input">
                  <span>${t('accessControl.qr.uploadImage')}</span>
                </label>
                <input
                  type="file"
                  id="access-qr-logo-input"
                  class="access-qr-logo-input"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                />
                <button type="button" class="access-action-btn access-qr-logo-remove" id="access-qr-logo-remove" hidden>
                  <span>${t('accessControl.common.remove')}</span>
                </button>
              </div>
            </div>
            <p class="access-qr-logo-hint" id="access-qr-logo-hint">
              ${t('accessControl.qr.logoHint')}
            </p>
          </div>
        </div>
        <footer class="access-dialog-actions">
          <button type="button" class="access-action-btn btn-ripple-host" id="access-qr-dialog-cancel">
            <span class="access-icon-slot" aria-hidden="true">${iconClose()}</span>
            <span>${t('accessControl.common.close')}</span>
          </button>
          <button type="button" class="access-save-btn btn-ripple-host" id="access-qr-download-btn" disabled>
            <span class="access-icon-slot" aria-hidden="true">${iconDownload()}</span>
            <span>${t('accessControl.qr.downloadQr')}</span>
          </button>
        </footer>
      </form>
    </dialog>
  `;
  container.appendChild(page);
  const projectDialog = page.querySelector('#access-project-dialog');
  if (projectDialog) document.body.appendChild(projectDialog);
  const whitelabelQrDialog = page.querySelector('#access-whitelabel-qr-dialog');
  if (whitelabelQrDialog) document.body.appendChild(whitelabelQrDialog);
  bindThemeToggle(page.querySelector('#access-theme-toggle'));
  page.querySelector('#access-language-select')?.addEventListener('change', (event) => {
    setLanguage(event.target.value);
    window.location.reload();
  });

  const loginWrap = page.querySelector('#access-login-wrap');
  const mainEl = page.querySelector('#access-main');
  const shellEl = page.querySelector('#access-shell');
  const hudEl = page.querySelector('#access-hud');
  const gridView = page.querySelector('#access-grid-view');
  const logsView = page.querySelector('#access-logs-view');
  const detailView = page.querySelector('#access-detail-view');
  const detailHudEl = page.querySelector('#access-detail-hud');
  const detailPanes = () => detailView?.querySelectorAll('[data-detail-pane]') ?? [];
  const cardGrid = page.querySelector('#access-card-grid');
  const switchList = page.querySelector('#access-switch-list');
  const languagePanel = page.querySelector('#access-language-panel');
  const languageList = page.querySelector('#access-language-list');
  const splatPanel = page.querySelector('#access-splat-panel');
  const splatList = page.querySelector('#access-splat-list');
  const splatStatus = page.querySelector('#access-splat-status');
  const splatUploadBtn = page.querySelector('#access-splat-upload-btn');
  const splatFileInput = page.querySelector('#access-splat-file-input');
  const splatPoiLabel = page.querySelector('#access-splat-poi-label');
  const matterportPoiLabel = page.querySelector('#access-matterport-poi-label');
  const matterportUrlInput = page.querySelector('#access-matterport-url');
  const matterportStatus = page.querySelector('#access-matterport-status');
  const matterportList = page.querySelector('#access-matterport-list');
  const matterportSaveBtn = page.querySelector('#access-matterport-save-btn');
  const matterportClearBtn = page.querySelector('#access-matterport-clear-btn');
  const navmeshPoiLabel = page.querySelector('#access-navmesh-poi-label');
  const navmeshList = page.querySelector('#access-navmesh-list');
  const navmeshStatus = page.querySelector('#access-navmesh-status');
  const navmeshUploadBtn = page.querySelector('#access-navmesh-upload-btn');
  const navmeshFileInput = page.querySelector('#access-navmesh-file-input');
  const projectUrlInput = page.querySelector('#access-project-url');
  const whitelabeledUrlInput = page.querySelector('#access-whitelabeled-url');
  const experienceUrlsSaveBtn = page.querySelector('#access-experience-urls-save');
  const whitelabelGenerateQrBtn = page.querySelector('#access-whitelabel-generate-qr');
  const qrDialogUrlEl = whitelabelQrDialog?.querySelector('#access-qr-dialog-url');
  const qrImageEl = whitelabelQrDialog?.querySelector('#access-qr-image');
  const qrStatusEl = whitelabelQrDialog?.querySelector('#access-qr-status');
  const qrDownloadBtn = whitelabelQrDialog?.querySelector('#access-qr-download-btn');
  const qrLogoInput = whitelabelQrDialog?.querySelector('#access-qr-logo-input');
  const qrLogoRemoveBtn = whitelabelQrDialog?.querySelector('#access-qr-logo-remove');
  const qrLogoThumbEl = whitelabelQrDialog?.querySelector('#access-qr-logo-thumb');
  const qrLogoHintEl = whitelabelQrDialog?.querySelector('#access-qr-logo-hint');
  /** Decoded logo for the centre of the QR; null renders a plain code. */
  let qrLogoImg = null;
  /** @type {string | null} */
  let qrDataUrl = null;
  /** @type {string} */
  let qrSourceUrl = '';
  const detailHero = page.querySelector('#access-detail-hero');
  const pageTitle = page.querySelector('#access-page-title');
  const pageSubtitle = page.querySelector('#access-page-subtitle');
  const pageScroll = page.querySelector('#access-page-scroll');
  const dialog = projectDialog;
  const loginForm = page.querySelector('#access-login-form');
  const loginErr = page.querySelector('#access-login-error');
  const searchInput = page.querySelector('#access-search');

  /** @type {Array<Record<string, unknown>>} */
  let logins = [];
  /** @type {Map<string, Record<string, unknown>>} */
  let featuresByPoi = new Map();
  /** @type {string | null} */
  let editingLoginId = null;
  /** Original email when the edit dialog opened — used if autofill swaps in another tenant's email. */
  let editingOriginalEmail = null;
  /** @type {Record<string, unknown> | null} */
  let activeLogin = null;
  /** @type {Record<string, boolean>} */
  let activeFeatures = { ...DEFAULT_FEATURES };
  /** @type {Array<Record<string, unknown>>} */
  let activeLanguages = [];
  /** @type {Array<Record<string, unknown>>} */
  let activeSplats = [];
  /** @type {Array<Record<string, unknown>>} */
  let activeMatterports = [];
  /** @type {Array<Record<string, unknown>>} */
  let activeNavmeshes = [];
  /** @type {boolean} */
  let splatUploading = false;
  /** @type {boolean} */
  let matterportSaving = false;
  /** @type {boolean} */
  let navmeshUploading = false;
  /** @type {string | null} */
  let savingLanguageCode = null;

  function scrollToTop() {
    pageScroll.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function adminCreds() {
    const session = getSuperadminSession();
    if (!session) return null;
    return { email: session.email, password: session.password };
  }

  async function copyText(value, label) {
    const text = String(value ?? '').trim();
    if (!text) {
      showToast(t('accessControl.toast.nothingToCopy', { label }), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('accessControl.toast.copied', { label }), 'success');
    } catch {
      showToast(t('accessControl.toast.couldNotCopy', { label: label.toLowerCase() }), 'error');
    }
  }

  function maskSecret(value) {
    const raw = String(value ?? '');
    if (!raw) return '—';
    return '•'.repeat(Math.min(12, Math.max(8, raw.length)));
  }

  function credRowHtml(label, value, { secret = false } = {}) {
    const raw = String(value ?? '');
    const shown = secret ? maskSecret(raw) : raw || '—';
    return `
      <div class="access-cred-row"${secret ? ` data-secret="${escapeHtml(raw)}"` : ''}>
        <span class="access-cred-label">${escapeHtml(label)}</span>
        <code class="access-cred-value">${escapeHtml(shown)}</code>
        <div class="access-cred-actions">
          ${
            secret
              ? `<button type="button" class="access-copy-map-btn btn-ripple-host" data-action="toggle-secret" title="${escapeHtml(t('accessControl.cred.show', { label }))}" aria-label="${escapeHtml(t('accessControl.cred.show', { label }))}" aria-pressed="false">${iconEye()}</button>`
              : ''
          }
          <button type="button" class="access-copy-map-btn btn-ripple-host" data-action="copy-value" data-copy-label="${escapeHtml(label)}" data-copy-value="${escapeHtml(raw)}" title="${escapeHtml(t('accessControl.cred.copy', { label }))}" aria-label="${escapeHtml(t('accessControl.cred.copy', { label }))}">${iconCopy()}</button>
        </div>
      </div>`;
  }

  function bindCredCard(root) {
    if (!root) return;
    root.querySelectorAll('[data-action="toggle-secret"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.access-cred-row');
        const code = row?.querySelector('.access-cred-value');
        const secret = row?.getAttribute('data-secret') ?? '';
        if (!row || !code) return;
        const reveal = btn.getAttribute('aria-pressed') !== 'true';
        code.textContent = reveal ? secret || '—' : maskSecret(secret);
        btn.setAttribute('aria-pressed', reveal ? 'true' : 'false');
        btn.setAttribute('aria-label', reveal ? t('accessControl.common.hidePassword') : t('accessControl.common.showPassword'));
        btn.title = reveal ? t('accessControl.common.hidePassword') : t('accessControl.common.showPassword');
        btn.innerHTML = reveal ? iconEyeOff() : iconEye();
      });
    });
    root.querySelectorAll('[data-action="copy-value"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyText(btn.getAttribute('data-copy-value'), btn.getAttribute('data-copy-label') || t('accessControl.common.value'));
      });
    });
    root.querySelectorAll('[data-action="copy-all"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyText(btn.getAttribute('data-copy-all'), btn.getAttribute('data-copy-label') || t('accessControl.common.credentials'));
      });
    });
  }

  function credCardHtml({ title, badge, fields, copyAll }) {
    return `
      <article class="access-cred-card">
        <div class="access-cred-card-head">
          <div>
            <h3>${escapeHtml(title)}</h3>
            ${badge ? `<span class="access-cred-badge">${escapeHtml(badge)}</span>` : ''}
          </div>
          ${
            copyAll
              ? `<button type="button" class="access-action-btn btn-ripple-host" data-action="copy-all" data-copy-all="${escapeHtml(copyAll)}" data-copy-label="${escapeHtml(title)}">
                  ${iconCopy()}
                  <span>${t('accessControl.cred.copyAll')}</span>
                </button>`
              : ''
          }
        </div>
        <div class="access-cred-fields">
          ${fields}
        </div>
      </article>`;
  }

  function renderTenantCredCard() {
    const host = page.querySelector('#access-tenant-cred-card');
    if (!host) return;
    if (!activeLogin) {
      host.innerHTML = '';
      return;
    }
    const email = String(activeLogin.email ?? '');
    const password = String(activeLogin.password ?? '');
    const mapCode = String(activeLogin.map_code ?? '');
    const clientId = String(activeLogin.client_id ?? '');
    const clientSecret = String(activeLogin.client_secret ?? '');
    const copyAll = [
      `${t('accessControl.cred.emailField')}: ${email}`,
      `${t('accessControl.cred.passwordField')}: ${password}`,
      `${t('accessControl.cred.mapCodeField')}: ${mapCode}`,
      clientId ? `${t('accessControl.cred.clientIdField')}: ${clientId}` : '',
      clientSecret ? `${t('accessControl.cred.clientSecretField')}: ${clientSecret}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    host.innerHTML = credCardHtml({
      title: t('accessControl.cred.tenantLogin'),
      badge: String(activeLogin.poi_type ?? ''),
      copyAll,
      fields:
        credRowHtml(t('accessControl.cred.emailField'), email) +
        credRowHtml(t('accessControl.cred.passwordField'), password, { secret: true }) +
        credRowHtml(t('accessControl.cred.mapCodeField'), mapCode) +
        (clientId ? credRowHtml(t('accessControl.cred.clientIdField'), clientId) : '') +
        (clientSecret ? credRowHtml(t('accessControl.cred.clientSecretField'), clientSecret, { secret: true }) : ''),
    });
    bindCredCard(host);
  }

  async function loadProjectAdminMembers() {
    const currentEl = page.querySelector('#access-project-admin-current');
    const listEl = page.querySelector('#access-subadmin-list');
    const adminCard = page.querySelector('#access-admin-cred-card');
    renderTenantCredCard();
    if (!currentEl || !listEl || !activeLogin) return;
    const creds = adminCreds();
    if (!creds) {
      currentEl.textContent = t('accessControl.admins.signInToManage');
      listEl.innerHTML = '';
      if (adminCard) adminCard.innerHTML = '';
      return;
    }
    currentEl.textContent = t('accessControl.common.loading');
    listEl.innerHTML = '';
    if (adminCard) adminCard.innerHTML = '';
    try {
      const members = await adminListProjectMembers({
        email: creds.email,
        password: creds.password,
        poiType: String(activeLogin.poi_type ?? ''),
      });
      const admin = members.find((m) => String(m.role) === 'project_admin' && m.is_active);
      const subs = members.filter((m) => String(m.role) === 'sub_admin');
      currentEl.textContent = admin
        ? t('accessControl.admins.currentAdmin', {
            email: admin.email,
            name: admin.display_name ? ` (${admin.display_name})` : '',
          })
        : t('accessControl.admins.noActiveAdmin');
      if (admin && adminCard) {
        const pwd = String(admin.password ?? '');
        const copyAll = [
          `${t('accessControl.cred.roleField')}: ${t('accessControl.admins.projectAdminBadge')}`,
          `${t('accessControl.cred.nameField')}: ${admin.display_name || ''}`,
          `${t('accessControl.cred.emailField')}: ${admin.email}`,
          `${t('accessControl.cred.passwordField')}: ${pwd}`,
        ].join('\n');
        adminCard.innerHTML = credCardHtml({
          title: admin.display_name || admin.email,
          badge: t('accessControl.admins.projectAdminBadge'),
          copyAll,
          fields:
            credRowHtml(t('accessControl.cred.emailField'), admin.email) +
            credRowHtml(t('accessControl.cred.passwordField'), pwd, { secret: true }) +
            (admin.display_name ? credRowHtml(t('accessControl.admins.displayNameLabel'), admin.display_name) : ''),
        });
        bindCredCard(adminCard);
      }
      if (!subs.length) {
        listEl.innerHTML = `<p class="access-field-help">${t('accessControl.admins.noSubAdmins')}</p>`;
      } else {
        listEl.innerHTML = `
          <h3 class="access-subadmin-heading">${t('accessControl.admins.subAdminsHeading')}</h3>
          <div class="access-cred-stack">
            ${subs
              .map((m) => {
                const pwd = String(m.password ?? '');
                const copyAll = [
                  `${t('accessControl.cred.roleField')}: ${t('accessControl.admins.subAdminBadge')}`,
                  `${t('accessControl.cred.nameField')}: ${m.display_name || ''}`,
                  `${t('accessControl.cred.emailField')}: ${m.email}`,
                  `${t('accessControl.cred.passwordField')}: ${pwd}`,
                ].join('\n');
                return credCardHtml({
                  title: m.display_name || m.email,
                  badge: m.is_active ? t('accessControl.admins.subAdminBadge') : t('accessControl.common.inactive'),
                  copyAll,
                  fields:
                    credRowHtml(t('accessControl.cred.emailField'), m.email) +
                    credRowHtml(t('accessControl.cred.passwordField'), pwd, { secret: true }),
                });
              })
              .join('')}
          </div>`;
        bindCredCard(listEl);
      }
    } catch (err) {
      currentEl.textContent = String(err?.message ?? err);
    }
  }

  function showLogin() {
    loginWrap.classList.remove('hidden');
    mainEl.classList.add('hidden');
  }

  function showDashboard() {
    loginWrap.classList.add('hidden');
    mainEl.classList.remove('hidden');
  }

  function setLoginError(msg) {
    if (!msg) {
      loginErr.textContent = '';
      loginErr.classList.add('hidden');
      return;
    }
    loginErr.textContent = msg;
    loginErr.classList.remove('hidden');
  }

  function featuresForLogin(login) {
    const poi = String(login.poi_type ?? '');
    const byPoi =
      featuresByPoi.get(poi.toLowerCase()) ??
      [...featuresByPoi.values()].find((f) => String(f.login_id) === String(login.id));
    return normalizeFeatureRow(byPoi);
  }

  function featureRowForLogin(login) {
    const poi = String(login?.poi_type ?? '');
    return (
      featuresByPoi.get(poi.toLowerCase()) ??
      [...featuresByPoi.values()].find((f) => String(f.login_id) === String(login?.id)) ??
      null
    );
  }

  function fillExperienceUrlInputs(login) {
    const urls = experienceUrlsFromRow(featureRowForLogin(login));
    if (projectUrlInput) projectUrlInput.value = urls.project_url;
    if (whitelabeledUrlInput) whitelabeledUrlInput.value = urls.whitelabeled_url;
  }

  function enabledCount(features) {
    return ACCESS_UI_FEATURES.filter((f) => isFeatureEnabled(features, f.key)).length;
  }

  function projectAccent(name) {
    const palette = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#db2777', '#4f46e5'];
    let hash = 0;
    const s = String(name ?? '');
    for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
  }

  function projectInitial(name) {
    const clean = String(name ?? '?').trim();
    return clean.charAt(0).toUpperCase();
  }

  function launchProjectEditor(login) {
    const email = String(login.email ?? '').trim();
    const password = String(login.password ?? '');
    const poiType = String(login.poi_type ?? '').trim();
    const mapCode = String(login.map_code ?? '').trim();
    if (!email || !password) {
      showToast(t('accessControl.toast.missingLoginEmailOrPassword'), 'error');
      return;
    }
    if (!poiType || !mapCode) {
      showToast(t('accessControl.toast.missingPoiTypeOrMapCode'), 'error');
      return;
    }
    setPendingProjectLogin({
      email,
      password,
      poiType,
      mapCode,
      organizationId: getDefaultOrganizationId(),
    });
    window.location.href = '/';
  }

  function launch2dEditor(login) {
    const poiType = String(login.poi_type ?? '').trim();
    if (!poiType) {
      showToast(t('accessControl.toast.missingPoiType'), 'error');
      return;
    }
    const url = new URL('/2d/', window.location.origin);
    url.searchParams.set('poi_type', poiType);
    window.location.href = url.toString();
  }

  function launch3dWayfinder(login) {
    const poiType = String(login.poi_type ?? '').trim();
    if (!poiType) {
      showToast(t('accessControl.toast.missingPoiType'), 'error');
      return;
    }
    const url = new URL('/3d-view/', window.location.origin);
    url.searchParams.set('poi_type', poiType);
    window.location.href = url.toString();
  }

  function filteredLogins() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return logins;
    return logins.filter((row) => {
      const urls = experienceUrlsFromRow(featureRowForLogin(row));
      const hay = [row.poi_type, row.email, row.map_code, urls.project_url, urls.whitelabeled_url]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  }

  function setHudActive(id) {
    hudEl?.querySelectorAll('.access-hud-node').forEach((node) => {
      const on = node.dataset.hud === id;
      node.classList.toggle('is-active', on);
      if (on) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
  }

  function setDetailSection(section, { updateUrl = true } = {}) {
    const next = DETAIL_SECTIONS.includes(section) ? section : 'admins';
    detailHudEl?.querySelectorAll('[data-detail]').forEach((node) => {
      const on = node.dataset.detail === next;
      node.classList.toggle('is-active', on);
      if (on) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    detailPanes().forEach((pane) => {
      pane.classList.toggle('hidden', pane.dataset.detailPane !== next);
    });
    if (updateUrl && activeLogin) {
      const url = new URL(window.location.href);
      url.searchParams.set('project', String(activeLogin.poi_type ?? ''));
      if (next === 'admins') url.searchParams.delete('section');
      else url.searchParams.set('section', next);
      history.replaceState({ view: 'detail', id: activeLogin.id, section: next }, '', url.pathname + url.search);
    }
    if (next === 'logs' && activeLogin) {
      void loadUserLogsFeed(page.querySelector('#access-project-logs'), {
        poiType: String(activeLogin.poi_type ?? ''),
        global: false,
      });
    }
    if (next === 'gmap' && activeLogin) {
      void loadGmapPanel(activeLogin);
    }
    scrollToTop();
  }

  async function loadGmapPanel(login) {
    const slugEl = page.querySelector('#gmap-slug');
    const emailEl = page.querySelector('#gmap-account-email');
    const sidEl = page.querySelector('#gmap-sid');
    const wfUrlEl = page.querySelector('#gmap-wf-url');
    const statusEl = page.querySelector('#gmap-status');
    const saveBtn = page.querySelector('#gmap-save-btn');
    const openBtn = page.querySelector('#gmap-open-btn');
    const syncBtn = page.querySelector('#gmap-sync-btn');
    if (!slugEl || !saveBtn) return;

    const setStatus = (msg, ok = null) => {
      statusEl.textContent = msg;
      statusEl.style.color = ok === true ? 'var(--color-success, #2d8a4e)' : ok === false ? 'var(--color-error, #c0392b)' : '';
    };

    const refreshButtons = () => {
      const slug = slugEl.value.trim();
      const wfUrl = wfUrlEl.value.trim();
      const hasSlug = !!slug;
      openBtn.disabled = !(hasSlug && wfUrl);
      syncBtn.disabled = !hasSlug;
    };
    slugEl.addEventListener('input', refreshButtons);
    wfUrlEl.addEventListener('input', refreshButtons);

    setStatus('Loading…');
    const sa = getSuperadminSession();
    try {
      const existing = await adminGmapGetBuilding({ email: sa.email, password: sa.password, poiType: String(login.poi_type) });
      if (existing) {
        slugEl.value = existing.slug || '';
        emailEl.value = existing.account_email || '';
        sidEl.value = existing.matterport_sid || '';
        wfUrlEl.value = existing.wayfinding_admin_url || '';
        setStatus(existing.provisioned ? '✓ Provisioned' : 'Saved — not yet provisioned on wayfinding server.', existing.provisioned || null);
      } else {
        emailEl.value = login.email || '';
        setStatus('No building record yet — fill in the slug and save.');
      }
    } catch (e) {
      setStatus('');
    }
    refreshButtons();

    saveBtn.onclick = async () => {
      const slug = slugEl.value.trim();
      const accountEmail = emailEl.value.trim();
      const sid = sidEl.value.trim() || null;
      const wfUrl = wfUrlEl.value.trim() || null;
      if (!slug || !accountEmail) { setStatus('Slug and account email are required.', false); return; }
      saveBtn.disabled = true; setStatus('Saving…');
      try {
        await adminGmapUpsertBuilding({ email: sa.email, password: sa.password, poiType: String(login.poi_type), accountEmail, slug, matterportSid: sid, wayfindingAdminUrl: wfUrl });
        setStatus('✓ Saved.', true);
        showToast('GMap building saved.', { type: 'success' });
        refreshButtons();
      } catch (e) {
        setStatus('Error: ' + e.message, false);
        showToast('Failed to save.', { type: 'error' });
      } finally { saveBtn.disabled = false; }
    };

    openBtn.onclick = () => {
      const slug = slugEl.value.trim();
      const base = wfUrlEl.value.trim().replace(/\/$/, '');
      if (slug && base) window.open(`${base}/admin/#/b/${slug}/routes`, '_blank');
    };

    syncBtn.onclick = async () => {
      const slug = slugEl.value.trim();
      if (!slug) return;
      syncBtn.disabled = true; setStatus('Syncing POIs to Supabase…');
      try {
        const count = await adminGmapSyncPois(String(login.poi_type));
        setStatus(`✓ ${count ?? 0} POIs synced to Supabase.`, true);
        showToast(`${count ?? 0} POIs synced.`, { type: 'success' });
        // Also trigger the wayfinding server pull if URL is set
        const wfUrl = wfUrlEl.value.trim().replace(/\/$/, '');
        if (wfUrl) {
          setStatus(`✓ ${count ?? 0} POIs synced to Supabase. Pushing to wayfinding…`);
          const token = sa._token || '';
          fetch(`${wfUrl}/api/v1/admin/buildings/${encodeURIComponent(slug)}/pois/sync-supabase`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          }).then(async r => {
            const j = await r.json().catch(() => ({}));
            if (r.ok) setStatus(`✓ Wayfinding synced — ${j.created ?? 0} created, ${j.updated ?? 0} updated.`, true);
            else setStatus(`Supabase synced. Wayfinding error: ${j.detail || r.status}`, false);
          }).catch(e => setStatus(`Supabase synced. Wayfinding unreachable: ${e.message}`, false));
        }
      } catch (e) {
        setStatus('Sync error: ' + e.message, false);
        showToast('Sync failed.', { type: 'error' });
      } finally { syncBtn.disabled = false; }
    };
  }

  function hideAllViews() {
    gridView.classList.add('hidden');
    logsView.classList.add('hidden');
    detailView.classList.add('hidden');
  }

  function showGridView() {
    activeLogin = null;
    activeSplats = [];
    hideAllViews();
    shellEl?.classList.remove('hidden');
    detailView.classList.add('hidden');
    gridView.classList.remove('hidden');
    setHudActive('tenants');
    pageTitle.textContent = t('accessControl.header.title');
    pageSubtitle.textContent = t('accessControl.header.subtitle');
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    url.searchParams.delete('view');
    history.replaceState({ view: 'grid' }, '', url.pathname + url.search);
    renderCards();
    scrollToTop();
  }

  function showLogsView() {
    activeLogin = null;
    activeSplats = [];
    hideAllViews();
    shellEl?.classList.remove('hidden');
    detailView.classList.add('hidden');
    logsView.classList.remove('hidden');
    setHudActive('logs');
    pageTitle.textContent = t('accessControl.logs.userLogs');
    pageSubtitle.textContent = t('accessControl.logs.activityAcrossAllProjects');
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    url.searchParams.set('view', 'logs');
    history.replaceState({ view: 'logs' }, '', url.pathname + url.search);
    void loadUserLogsFeed(page.querySelector('#access-global-logs'), { global: true });
    scrollToTop();
  }

  function showDetailView(login) {
    activeLogin = login;
    activeFeatures = featuresForLogin(login);
    activeLanguages = [];
    hideAllViews();
    shellEl?.classList.add('hidden');
    detailView.classList.remove('hidden');
    pageTitle.textContent = String(login.poi_type ?? t('accessControl.detail.projectFallback'));
    pageSubtitle.textContent = t('accessControl.detail.configureFeatureAccess');
    fillExperienceUrlInputs(login);

    const accent = projectAccent(login.poi_type);
    const enabled = enabledCount(activeFeatures);
    const email = String(login.email ?? '');
    detailHero.innerHTML = `
      <div class="access-detail-avatar" style="--accent:${accent}">${escapeHtml(projectInitial(login.poi_type))}</div>
      <div class="access-detail-meta">
        <h2>${escapeHtml(login.poi_type)}</h2>
        <p class="access-detail-email">${escapeHtml(email)}</p>
        <div class="access-detail-chips">
          <span class="access-chip access-chip--map">
            <code class="access-map-code">${escapeHtml(login.map_code)}</code>
            <button type="button" class="access-copy-map-btn btn-ripple-host" id="access-copy-map-code" title="${t('accessControl.dialog.copyMapCode')}" aria-label="${t('accessControl.dialog.copyMapCode')}">
              ${iconCopy()}
            </button>
          </span>
          <span class="access-chip access-chip--status">${t('accessControl.detail.enabledCount', { enabled, total: ACCESS_UI_FEATURES.length })}</span>
          <span class="access-chip access-chip--languages hidden" id="access-language-status-chip"></span>
        </div>
      </div>
      <div class="access-detail-actions">
        <button type="button" class="access-save-btn btn-ripple-host" id="access-open-editor">
          <span class="access-icon-slot" aria-hidden="true">${iconEditor3d()}</span>
          <span>${t('accessControl.detail.loginToProject')}</span>
        </button>
        <button type="button" class="access-action-btn btn-ripple-host" id="access-open-2d-editor">
          <span class="access-icon-slot" aria-hidden="true">${iconFloorPlan()}</span>
          <span>${t('accessControl.detail.editIn2d')}</span>
        </button>
        <button type="button" class="access-action-btn btn-ripple-host" id="access-open-3d-wayfinder">
          <span class="access-icon-slot" aria-hidden="true">${iconEditor3d()}</span>
          <span>${t('accessControl.detail.viewIn3d')}</span>
        </button>
        <button type="button" class="access-action-btn btn-ripple-host" id="access-edit-project">
          <span class="access-icon-slot" aria-hidden="true">${iconEdit()}</span>
          <span>${t('accessControl.detail.editTenantLogin')}</span>
        </button>
        <button type="button" class="access-action-btn access-action-btn--danger btn-ripple-host" id="access-delete-project">
          <span class="access-icon-slot" aria-hidden="true">${iconDelete()}</span>
          <span>${t('accessControl.detail.deleteTenant')}</span>
        </button>
      </div>
    `;

    detailHero.querySelector('#access-copy-map-code')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mapCode = String(login.map_code ?? '').trim();
      if (!mapCode) return;
      try {
        await navigator.clipboard.writeText(mapCode);
        showToast(t('accessControl.toast.mapCodeCopied'), 'success');
      } catch {
        showToast(t('accessControl.toast.couldNotCopyMapCode'), 'error');
      }
    });

    detailHero.querySelector('#access-open-editor')?.addEventListener('click', () => {
      if (activeLogin) launchProjectEditor(activeLogin);
    });

    detailHero.querySelector('#access-open-2d-editor')?.addEventListener('click', () => {
      if (activeLogin) launch2dEditor(activeLogin);
    });

    detailHero.querySelector('#access-open-3d-wayfinder')?.addEventListener('click', () => {
      if (activeLogin) launch3dWayfinder(activeLogin);
    });

    detailHero.querySelector('#access-edit-project')?.addEventListener('click', () => {
      if (activeLogin) openProjectDialog(activeLogin);
    });

    detailHero.querySelector('#access-delete-project')?.addEventListener('click', async () => {
      if (!activeLogin) return;
      const ok = await askConfirm({
        title: t('accessControl.confirm.deleteProjectTitle'),
        message: t('accessControl.confirm.deleteProjectMessage', { poiType: activeLogin.poi_type }),
        confirmLabel: t('accessControl.common.delete'),
        cancelLabel: t('accessControl.common.cancel'),
        danger: true,
      });
      if (!ok) return;
      const creds = adminCreds();
      if (!creds) {
        showLogin();
        return;
      }
      try {
        await deleteProjectFeaturesAdmin({
          email: creds.email,
          password: creds.password,
          poiType: activeLogin.poi_type,
        });
        await deleteProjectLogin(activeLogin.id);
        logUserActivity({
          action: 'deleted',
          entityType: 'tenant',
          entityId: activeLogin.id,
          entityLabel: String(activeLogin.poi_type ?? ''),
          createdEmail: String(activeLogin.email ?? ''),
          poiType: String(activeLogin.poi_type ?? ''),
        });
        showToast(t('accessControl.toast.projectDeleted'), 'success');
        await loadData();
      } catch (err) {
        showToast(String(err?.message ?? err), 'error');
      }
    });

    renderSwitches();
    syncLanguagePanelVisibility();
    if (splatPoiLabel) splatPoiLabel.textContent = String(login.poi_type ?? 'poi_type');
    if (matterportPoiLabel) matterportPoiLabel.textContent = String(login.poi_type ?? 'poi_type');
    if (navmeshPoiLabel) navmeshPoiLabel.textContent = String(login.poi_type ?? 'poi_type');
    loadActiveSplats().catch((err) => showToast(String(err?.message ?? err), 'error'));
    loadActiveMatterport().catch((err) => showToast(String(err?.message ?? err), 'error'));
    loadActiveNavmeshes().catch((err) => showToast(String(err?.message ?? err), 'error'));
    loadProjectAdminMembers().catch((err) => showToast(String(err?.message ?? err), 'error'));
    void loadUserLogsFeed(page.querySelector('#access-project-logs'), {
      poiType: String(login.poi_type ?? ''),
      global: false,
    });
    if (isFeatureEnabled(activeFeatures, 'languages')) {
      loadActiveLanguages().catch((err) => showToast(String(err?.message ?? err), 'error'));
    }

    const sectionParam = new URLSearchParams(window.location.search).get('section');
    setDetailSection(sectionParam || 'admins', { updateUrl: false });

    const url = new URL(window.location.href);
    url.searchParams.set('project', String(login.poi_type ?? ''));
    history.pushState({ view: 'detail', id: login.id, section: sectionParam || 'admins' }, '', url.pathname + url.search);
    scrollToTop();
  }

  function renderCards() {
    const rows = filteredLogins();
    if (!rows.length) {
      cardGrid.innerHTML = `
        <div class="access-empty float-glass">
          <span class="access-empty-icon" aria-hidden="true">${iconUsers()}</span>
          <p>${t('accessControl.cards.emptyState')}</p>
          <button type="button" class="access-add-tenant-btn btn-ripple-host" id="access-empty-add">
            <span class="access-icon-slot" aria-hidden="true">${iconAdd()}</span>
            <span>${t('accessControl.toolbar.newProjectTenant')}</span>
          </button>
        </div>`;
      cardGrid.querySelector('#access-empty-add')?.addEventListener('click', () => openProjectDialog());
      return;
    }

    cardGrid.innerHTML = rows
      .map((login) => {
        const features = featuresForLogin(login);
        const accent = projectAccent(login.poi_type);
        const enabled = enabledCount(features);
        return `
        <article class="access-tenant-card float-glass" data-id="${login.id}" style="--accent:${accent}">
          <button type="button" class="access-tenant-card-main" data-id="${login.id}">
            <span class="access-tenant-body">
              <span class="access-tenant-name">${escapeHtml(login.poi_type)}</span>
              <span class="access-tenant-email">${escapeHtml(login.email)}</span>
            </span>
            <span class="access-tenant-footer">
              <span class="access-tenant-chip">${t('accessControl.cards.featuresCount', { enabled, total: ACCESS_UI_FEATURES.length })}</span>
              <span class="access-card-arrow" aria-hidden="true">${iconChevronRight()}</span>
            </span>
          </button>
          <button type="button" class="access-tenant-login-btn btn-ripple-host" data-id="${login.id}" data-action="login" title="${t('accessControl.cards.openFor', { brand: BRAND_NAME, poiType: escapeHtml(login.poi_type) })}">
            <span class="access-icon-slot" aria-hidden="true">${iconEditor3d()}</span>
            <span>${t('accessControl.cards.login')}</span>
          </button>
        </article>`;
      })
      .join('');

    cardGrid.querySelectorAll('.access-tenant-card-main').forEach((btn) => {
      btn.addEventListener('click', () => {
        const login = logins.find((row) => String(row.id) === String(btn.dataset.id));
        if (login) showDetailView(login);
      });
    });

    cardGrid.querySelectorAll('.access-tenant-login-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const login = logins.find((row) => String(row.id) === String(btn.dataset.id));
        if (login) launchProjectEditor(login);
      });
    });
  }

  function applySwitchAppearance(btn, on) {
    btn.classList.toggle('access-switch--on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.disabled = false;
  }

  function updateFeatureStatusChip() {
    const enabled = enabledCount(activeFeatures);
    const statusChip = detailHero.querySelector('.access-chip--status');
    if (statusChip) statusChip.textContent = t('accessControl.detail.enabledCount', { enabled, total: ACCESS_UI_FEATURES.length });
    updateLanguageStatusChip();
  }

  function updateLanguageStatusChip() {
    const chip = detailHero.querySelector('#access-language-status-chip');
    if (!chip) return;
    const languagesOn = isFeatureEnabled(activeFeatures, 'languages');
    if (!languagesOn) {
      chip.classList.add('hidden');
      return;
    }
    const enabled = enabledLanguageCount(activeLanguages);
    chip.textContent = t('accessControl.languages.enabledCount', { enabled, total: NAVME_LANGUAGES.length });
    chip.classList.remove('hidden');
  }

  function syncLanguagePanelVisibility() {
    const showLanguages = isFeatureEnabled(activeFeatures, 'languages');
    languagePanel?.classList.toggle('hidden', !showLanguages);
    updateLanguageStatusChip();
  }

  async function loadActiveLanguages() {
    if (!activeLogin) return;
    const poiType = activeLogin.poi_type;
    let rows = await fetchTenantLanguages(poiType);
    if (!rows.length) {
      const creds = adminCreds();
      if (!creds) {
        showLogin();
        return;
      }
      rows = await initTenantLanguagesAdmin({
        email: creds.email,
        password: creds.password,
        poiType,
      });
    }
    activeLanguages = normalizeLanguageRows(rows);
    renderLanguageSwitches();
    updateLanguageStatusChip();
  }

  function renderLanguageSwitches() {
    if (!languageList) return;
    languageList.innerHTML = activeLanguages
      .map((row) => {
        const meta = languageMeta(row.lang_code);
        const on = parseDbBool(row.is_enabled, false);
        return `
        <div class="access-switch-row access-language-row" data-lang="${escapeHtml(row.lang_code)}">
          <span class="access-switch-icon access-language-code" aria-hidden="true">${escapeHtml(String(row.lang_code).toUpperCase())}</span>
          <div class="access-switch-copy">
            <span class="access-switch-label">${escapeHtml(meta.nativeLabel)}</span>
            <span class="access-switch-desc">${escapeHtml(meta.label)}</span>
          </div>
          <button type="button"
            class="access-switch ${on ? 'access-switch--on' : ''}"
            role="switch"
            aria-checked="${on ? 'true' : 'false'}"
            aria-label="${escapeHtml(meta.nativeLabel)}">
            <span class="access-switch-track"><span class="access-switch-thumb"></span></span>
          </button>
        </div>`;
      })
      .join('');

    languageList.querySelectorAll('.access-switch').forEach((btn) => {
      btn.addEventListener('click', () => handleLanguageToggle(btn));
    });
  }

  async function persistTenantLanguage(langCode, enabled) {
    if (!activeLogin) return null;
    const creds = adminCreds();
    if (!creds) {
      showLogin();
      return null;
    }
    const savedRow = await upsertTenantLanguageAdmin({
      email: creds.email,
      password: creds.password,
      poiType: activeLogin.poi_type,
      langCode,
      isEnabled: enabled,
    });
    if (savedRow && typeof savedRow === 'object') {
      activeLanguages = normalizeLanguageRows(
        activeLanguages.map((row) =>
          row.lang_code === langCode
            ? { ...row, ...savedRow, is_enabled: parseDbBool(savedRow.is_enabled, enabled) }
            : row,
        ),
      );
    } else {
      activeLanguages = normalizeLanguageRows(
        activeLanguages.map((row) =>
          row.lang_code === langCode ? { ...row, is_enabled: enabled } : row,
        ),
      );
    }
    return savedRow;
  }

  async function handleLanguageToggle(btn) {
    const row = btn.closest('.access-language-row');
    const langCode = row?.dataset.lang;
    if (!langCode || !activeLogin || savingLanguageCode) return;
    if (btn.disabled) return;

    const current = activeLanguages.find((item) => item.lang_code === langCode);
    const next = !parseDbBool(current?.is_enabled, false);
    savingLanguageCode = langCode;
    btn.disabled = true;
    applySwitchAppearance(btn, next);
    activeLanguages = activeLanguages.map((item) =>
      item.lang_code === langCode ? { ...item, is_enabled: next } : item,
    );
    updateLanguageStatusChip();

    try {
      await persistTenantLanguage(langCode, next);
    } catch (err) {
      activeLanguages = activeLanguages.map((item) =>
        item.lang_code === langCode ? { ...item, is_enabled: !next } : item,
      );
      renderLanguageSwitches();
      updateLanguageStatusChip();
      showToast(String(err?.message ?? err), 'error');
      savingLanguageCode = null;
      return;
    }

    renderLanguageSwitches();
    updateLanguageStatusChip();
    const label = languageMeta(langCode).nativeLabel;
    showToast(next ? t('accessControl.toast.languageEnabled', { label }) : t('accessControl.toast.languageDisabled', { label }), 'success');
    savingLanguageCode = null;
  }

  function setSplatStatus(text) {
    if (splatStatus) splatStatus.textContent = text || '';
  }

  async function loadActiveSplats() {
    if (!activeLogin) return;
    const poiType = String(activeLogin.poi_type ?? '').trim();
    if (!poiType) {
      activeSplats = [];
      renderSplatList();
      return;
    }
    setSplatStatus(t('accessControl.assets.splat.loadingStatus'));
    try {
      const rows = await fetchAllMedia({
        allTypes: true,
        poiType,
        mediaType: 'splat',
      });
      activeSplats = Array.isArray(rows) ? rows : [];
      renderSplatList();
      const visibleCount = activeSplats.filter((r) => r.is_active !== false).length;
      setSplatStatus(
        t('accessControl.assets.splat.statusCount', { visible: visibleCount, total: activeSplats.length }),
      );
    } catch (err) {
      activeSplats = [];
      renderSplatList();
      setSplatStatus('');
      throw err;
    }
  }

  function renderSplatList() {
    if (!splatList) return;
    if (!activeSplats.length) {
      splatList.innerHTML = `
        <div class="access-splat-empty">
          <span class="access-switch-icon" aria-hidden="true">${iconMedia()}</span>
          <p>${t('accessControl.assets.splat.emptyPre')} <code>.ply</code> ${t('accessControl.assets.splat.emptyPost')}</p>
        </div>`;
      return;
    }

    splatList.innerHTML = activeSplats
      .map((row) => {
        const label = String(row.label || row.file_name || t('accessControl.assets.splat.defaultLabel'));
        const fileName = String(row.file_name || '—');
        const visible = row.is_active !== false;
        return `
        <div class="access-splat-row${visible ? '' : ' is-hidden-splat'}" data-id="${escapeHtml(row.id)}">
          <span class="access-switch-icon" aria-hidden="true">${iconMedia()}</span>
          <div class="access-switch-copy">
            <span class="access-switch-label">${escapeHtml(label)}</span>
            <span class="access-switch-desc">${escapeHtml(fileName)}${visible ? '' : ` · ${t('accessControl.assets.splat.hiddenFromMap')}`}</span>
          </div>
          <div class="access-splat-row-actions">
            <button type="button" class="access-action-btn access-splat-eye-btn btn-ripple-host${visible ? ' is-visible' : ''}" data-action="toggle-splat-eye" title="${visible ? t('accessControl.assets.splat.hideTitle') : t('accessControl.assets.splat.showTitle')}" aria-pressed="${visible ? 'true' : 'false'}" aria-label="${visible ? t('accessControl.assets.splat.hideAria') : t('accessControl.assets.splat.showAria')}">
              ${visible ? iconEye() : iconEyeOff()}
            </button>
            <button type="button" class="access-action-btn btn-ripple-host" data-action="view-splat" title="${t('accessControl.assets.splat.openViewer')}">${t('accessControl.common.view')}</button>
            <button type="button" class="access-action-btn access-action-btn--danger btn-ripple-host" data-action="delete-splat" title="${t('accessControl.assets.splat.deleteTitle')}">${t('accessControl.common.delete')}</button>
          </div>
        </div>`;
      })
      .join('');

    splatList.querySelectorAll('[data-action="toggle-splat-eye"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeSplats.find((item) => String(item.id) === String(id));
        if (!row?.id) return;
        const next = row.is_active === false;
        btn.disabled = true;
        try {
          await updateMediaRow(row.id, { is_active: next });
          row.is_active = next;
          renderSplatList();
          const visibleCount = activeSplats.filter((r) => r.is_active !== false).length;
          setSplatStatus(
            t('accessControl.assets.splat.statusCount', { visible: visibleCount, total: activeSplats.length }),
          );
          showToast(
            next
              ? t('accessControl.toast.splatWillLoad', { label: row.label || row.file_name })
              : t('accessControl.toast.splatHidden', { label: row.label || row.file_name }),
            'success',
          );
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
          btn.disabled = false;
        }
      });
    });

    splatList.querySelectorAll('[data-action="view-splat"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeSplats.find((item) => String(item.id) === String(id));
        if (!row?.media_url) return;
        openSplatViewerModal({
          url: row.media_url,
          title: row.label || row.file_name || t('accessControl.assets.splat.viewerTitle'),
        });
      });
    });

    splatList.querySelectorAll('[data-action="delete-splat"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeSplats.find((item) => String(item.id) === String(id));
        if (!row?.id) return;
        const ok = await askConfirm({
          title: t('accessControl.confirm.deleteSplatTitle'),
          message: t('accessControl.confirm.deleteNamedMessage', { label: row.label || row.file_name }),
          confirmLabel: t('accessControl.common.delete'),
          cancelLabel: t('accessControl.common.cancel'),
          danger: true,
        });
        if (!ok) return;
        const deleteStorage = await askConfirm({
          title: t('accessControl.confirm.deleteFromStorageTitle'),
          message: t('accessControl.confirm.deleteFromStorageMessage'),
          confirmLabel: t('accessControl.common.yes'),
          cancelLabel: t('accessControl.common.no'),
          danger: true,
        });
        try {
          await deleteMediaRow(row.id);
          if (deleteStorage) {
            const path = storagePathFromPublicUrl(row.media_url);
            if (path) await deleteProjectMediaFile(path);
          }
          showToast(t('accessControl.toast.splatDeleted'), 'success');
          await loadActiveSplats();
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
        }
      });
    });
  }

  async function uploadSplatFiles(files) {
    if (!activeLogin || splatUploading) return;
    const poiType = String(activeLogin.poi_type ?? '').trim();
    if (!poiType) {
      showToast(t('accessControl.toast.missingPoiType'), 'error');
      return;
    }

    const plyFiles = Array.from(files || []).filter((file) => {
      const classified = classifyMediaFile(file);
      return classified?.mediaType === 'splat';
    });
    if (!plyFiles.length) {
      showToast(t('accessControl.toast.chooseSplatFiles'), 'error');
      return;
    }

    splatUploading = true;
    splatUploadBtn.disabled = true;
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < plyFiles.length; i += 1) {
      const file = plyFiles[i];
      const sizeMb = file.size ? (file.size / (1024 * 1024)).toFixed(1) : '?';
      setSplatStatus(t('accessControl.assets.uploadingFile', { current: i + 1, total: plyFiles.length, name: file.name, sizeMb }));
      // Keep UI responsive between large files
      await new Promise((r) => setTimeout(r, 0));
      try {
        const classified = classifyMediaFile(file);
        if (!classified || classified.mediaType !== 'splat') {
          failed += 1;
          continue;
        }
        const uploaded = await uploadProjectMedia(file, poiType, 'splat', {
          onProgress: (pct) => {
            setSplatStatus(
              t('accessControl.assets.uploadingProgress', { current: i + 1, total: plyFiles.length, name: file.name, pct }),
            );
          },
        });
        await insertMediaRow({
          poi_type: poiType,
          media_url: uploaded.publicUrl,
          media_type: 'splat',
          mime_type: classified.mimeType,
          file_name: file.name,
          label: file.name.replace(/\.[^.]+$/, ''),
          rot_x: -Math.PI / 2,
          rot_y: 0,
          rot_z: 0,
          scale_x: 1,
          scale_y: 1,
          scale_z: 1,
          pos_x: 0,
          pos_y: 0,
          pos_z: 0,
          width: 1,
          height: 1,
          is_active: true,
        });
        ok += 1;
        // Refresh list after each success so the page never feels stuck.
        await loadActiveSplats();
        setSplatStatus(
          t('accessControl.assets.uploadedCount', { ok, total: plyFiles.length, failedSuffix: failed ? ` (${failed} failed)` : '' }),
        );
      } catch (err) {
        console.error('[access-splat-upload]', err);
        failed += 1;
        showToast(t('accessControl.toast.fileError', { name: file.name, message: String(err?.message ?? err) }), 'error');
      }
    }

    splatUploading = false;
    splatUploadBtn.disabled = false;
    await loadActiveSplats();
    showToast(t('accessControl.toast.splatUploadComplete', { ok, failed }), failed ? 'error' : 'success');
  }

  function setMatterportStatus(text) {
    if (matterportStatus) matterportStatus.textContent = text || '';
  }

  async function loadActiveMatterport() {
    if (!activeLogin) return;
    const poiType = String(activeLogin.poi_type ?? '').trim();
    if (!poiType) {
      activeMatterports = [];
      renderMatterportList();
      return;
    }
    setMatterportStatus(t('accessControl.assets.space.loadingStatus'));
    try {
      const rows = await fetchAllMedia({
        allTypes: true,
        poiType,
      });
      activeMatterports = (Array.isArray(rows) ? rows : []).filter((r) => isMatterportMediaRow(r));
      const active = activeMatterports.find((r) => r.is_active !== false) || activeMatterports[0];
      if (matterportUrlInput) {
        const sidOnly = active ? parseMatterportModelId(String(active.media_url || '')) : '';
        matterportUrlInput.value = sidOnly || '';
      }
      renderMatterportList();
      setMatterportStatus(
        active
          ? t('accessControl.assets.space.statusActive', { brand: BRAND_NAME })
          : t('accessControl.assets.space.statusNone'),
      );
    } catch (err) {
      activeMatterports = [];
      renderMatterportList();
      setMatterportStatus('');
      throw err;
    }
  }

  function renderMatterportList() {
    if (!matterportList) return;
    if (!activeMatterports.length) {
      matterportList.innerHTML = `
        <div class="access-splat-empty">
          <span class="access-switch-icon" aria-hidden="true">${iconNavigate()}</span>
          <p>${t('accessControl.assets.space.emptyState')}</p>
        </div>`;
      return;
    }
    matterportList.innerHTML = activeMatterports
      .map((row) => {
        const visible = row.is_active !== false;
        const url = String(row.media_url || '');
        const sid = parseMatterportModelId(url) || '—';
        return `
        <div class="access-splat-row${visible ? '' : ' is-hidden-splat'}" data-id="${escapeHtml(row.id)}">
          <span class="access-switch-icon" aria-hidden="true">${iconNavigate()}</span>
          <div class="access-switch-copy">
            <span class="access-switch-label">${t('accessControl.assets.space.rowLabel', { sid: escapeHtml(sid) })}</span>
            <span class="access-switch-desc">${visible ? t('accessControl.assets.space.activeMap') : t('accessControl.common.inactive')}</span>
          </div>
          <div class="access-splat-row-actions">
            <button type="button" class="access-action-btn access-splat-eye-btn btn-ripple-host${visible ? ' is-visible' : ''}" data-action="toggle-mp-eye" title="${visible ? t('accessControl.assets.space.disableMap') : t('accessControl.assets.space.enableMap')}" aria-pressed="${visible ? 'true' : 'false'}">
              ${visible ? iconEye() : iconEyeOff()}
            </button>
            <button type="button" class="access-action-btn access-action-btn--danger btn-ripple-host" data-action="delete-mp" title="${t('accessControl.assets.space.deleteLinkTitle')}">${t('accessControl.common.delete')}</button>
          </div>
        </div>`;
      })
      .join('');

    matterportList.querySelectorAll('[data-action="toggle-mp-eye"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeMatterports.find((r) => String(r.id) === String(id));
        if (!row) return;
        const next = row.is_active === false;
        try {
          await updateMediaRow(row.id, { is_active: next });
          row.is_active = next;
          // Only one active Matterport map at a time.
          if (next) {
            await Promise.all(
              activeMatterports
                .filter((r) => String(r.id) !== String(id) && r.is_active !== false)
                .map((r) => updateMediaRow(r.id, { is_active: false }).then(() => { r.is_active = false; })),
            );
          }
          renderMatterportList();
          const active = activeMatterports.find((r) => r.is_active !== false);
          if (matterportUrlInput) {
            matterportUrlInput.value = active
              ? parseMatterportModelId(String(active.media_url || '')) || ''
              : '';
          }
          setMatterportStatus(
            active ? t('accessControl.assets.space.mapEnabled') : t('accessControl.assets.space.mapDisabledStatus'),
          );
          showToast(next ? t('accessControl.assets.space.mapEnabled') : t('accessControl.assets.space.mapDisabled'), 'success');
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
        }
      });
    });

    matterportList.querySelectorAll('[data-action="delete-mp"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeMatterports.find((r) => String(r.id) === String(id));
        if (!row) return;
        const ok = await askConfirm({
          title: t('accessControl.confirm.removeSpaceLinkTitle'),
          message: t('accessControl.confirm.removeSpaceLinkMessage'),
          confirmLabel: t('accessControl.common.remove'),
          cancelLabel: t('accessControl.common.cancel'),
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteMediaRow(row.id);
          await loadActiveMatterport();
          showToast(t('accessControl.toast.spaceLinkRemoved'), 'success');
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
        }
      });
    });
  }

  async function saveMatterportLink() {
    if (!activeLogin || matterportSaving) return;
    const poiType = String(activeLogin.poi_type ?? '').trim();
    const raw = String(matterportUrlInput?.value || '').trim();
    const sid = parseMatterportModelId(raw);
    if (!poiType) {
      showToast(t('accessControl.toast.missingPoiType'), 'error');
      return;
    }
    if (!sid) {
      showToast(t('accessControl.toast.invalidShowUrl'), 'error');
      return;
    }
    const normalized = `https://my.matterport.com/show/?m=${sid}`;
    matterportSaving = true;
    matterportSaveBtn.disabled = true;
    setMatterportStatus(t('accessControl.assets.space.savingStatus'));
    try {
      // Deactivate existing space rows, then upsert one active link.
      await Promise.all(
        activeMatterports.map((r) =>
          r.is_active === false ? Promise.resolve() : updateMediaRow(r.id, { is_active: false }),
        ),
      );
      const existing = activeMatterports[0];
      if (existing?.id) {
        await updateMediaRow(existing.id, {
          media_url: normalized,
          file_name: sid,
          label: `3D space ${sid}`,
          is_active: true,
          // Keep compatible type until DB migration adds `matterport`
          media_type: 'model',
          mime_type: MATTERPORT_MIME,
        });
      } else {
        await insertMediaRow({
          poi_type: poiType,
          media_url: normalized,
          media_type: 'model',
          mime_type: MATTERPORT_MIME,
          file_name: sid,
          label: `3D space ${sid}`,
          pos_x: 0,
          pos_y: 0,
          pos_z: 0,
          is_active: true,
        });
      }
      await loadActiveMatterport();
      showToast(t('accessControl.toast.spaceLinkSaved', { brand: BRAND_NAME }), 'success');
    } catch (err) {
      console.error('[access-space-map]', err);
      showToast(String(err?.message ?? err), 'error');
      setMatterportStatus(t('accessControl.common.saveFailed'));
    } finally {
      matterportSaving = false;
      matterportSaveBtn.disabled = false;
    }
  }

  async function clearMatterportLink() {
    if (!activeLogin || !activeMatterports.length) {
      if (matterportUrlInput) matterportUrlInput.value = '';
      setMatterportStatus(t('accessControl.assets.space.noLink'));
      return;
    }
    const ok = await askConfirm({
      title: t('accessControl.confirm.clearSpaceLinkTitle'),
      message: t('accessControl.confirm.clearSpaceLinkMessage'),
      confirmLabel: t('accessControl.common.clear'),
      cancelLabel: t('accessControl.common.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await Promise.all(activeMatterports.map((r) => deleteMediaRow(r.id)));
      await loadActiveMatterport();
      showToast(t('accessControl.toast.spaceLinkCleared'), 'success');
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    }
  }

  function setNavmeshStatus(text) {
    if (navmeshStatus) navmeshStatus.textContent = text || '';
  }

  async function loadActiveNavmeshes() {
    if (!activeLogin) return;
    const poiType = String(activeLogin.poi_type ?? '').trim();
    if (!poiType) {
      activeNavmeshes = [];
      renderNavmeshList();
      return;
    }
    setNavmeshStatus(t('accessControl.assets.navmesh.loadingStatus'));
    try {
      const rows = await fetchAllMedia({
        allTypes: true,
        poiType,
        mediaType: 'navmesh',
      });
      activeNavmeshes = Array.isArray(rows) ? rows : [];
      renderNavmeshList();
      const activeCount = activeNavmeshes.filter((r) => r.is_active !== false).length;
      setNavmeshStatus(
        activeCount
          ? t('accessControl.assets.navmesh.statusActive', { active: activeCount, total: activeNavmeshes.length })
          : activeNavmeshes.length
            ? t('accessControl.assets.navmesh.statusUploadedNoneActive', { total: activeNavmeshes.length })
            : t('accessControl.assets.navmesh.statusNone'),
      );
    } catch (err) {
      activeNavmeshes = [];
      renderNavmeshList();
      setNavmeshStatus('');
      throw err;
    }
  }

  function renderNavmeshList() {
    if (!navmeshList) return;
    if (!activeNavmeshes.length) {
      navmeshList.innerHTML = `
        <div class="access-splat-empty">
          <span class="access-switch-icon" aria-hidden="true">${iconNavigate()}</span>
          <p>${t('accessControl.assets.navmesh.emptyPre')} <code>.navmesh</code> ${t('accessControl.assets.navmesh.emptyPost')}</p>
        </div>`;
      return;
    }

    navmeshList.innerHTML = activeNavmeshes
      .map((row) => {
        const label = String(row.label || row.file_name || t('accessControl.assets.navmesh.defaultLabel'));
        const fileName = String(row.file_name || '—');
        const visible = row.is_active !== false;
        return `
        <div class="access-splat-row${visible ? '' : ' is-hidden-splat'}" data-id="${escapeHtml(row.id)}">
          <span class="access-switch-icon" aria-hidden="true">${iconNavigate()}</span>
          <div class="access-switch-copy">
            <span class="access-switch-label">${escapeHtml(label)}</span>
            <span class="access-switch-desc">${escapeHtml(fileName)}${visible ? ` · ${t('accessControl.assets.navmesh.usedInEditor')}` : ` · ${t('accessControl.common.inactiveLower')}`}</span>
          </div>
          <div class="access-splat-row-actions">
            <button type="button" class="access-action-btn access-splat-eye-btn btn-ripple-host${visible ? ' is-visible' : ''}" data-action="toggle-navmesh-eye" title="${visible ? t('accessControl.assets.navmesh.deactivateTitle') : t('accessControl.assets.navmesh.useTitle')}" aria-pressed="${visible ? 'true' : 'false'}" aria-label="${visible ? t('accessControl.assets.navmesh.deactivateAria') : t('accessControl.assets.navmesh.activateAria')}">
              ${visible ? iconEye() : iconEyeOff()}
            </button>
            <button type="button" class="access-action-btn access-action-btn--danger btn-ripple-host" data-action="delete-navmesh" title="${t('accessControl.assets.navmesh.deleteTitle')}">${t('accessControl.common.delete')}</button>
          </div>
        </div>`;
      })
      .join('');

    navmeshList.querySelectorAll('[data-action="toggle-navmesh-eye"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeNavmeshes.find((item) => String(item.id) === String(id));
        if (!row?.id) return;
        const next = row.is_active === false;
        btn.disabled = true;
        try {
          if (next) {
            // Only one active navmesh per project.
            await Promise.all(
              activeNavmeshes
                .filter((item) => String(item.id) !== String(row.id) && item.is_active !== false)
                .map((item) => updateMediaRow(item.id, { is_active: false })),
            );
          }
          await updateMediaRow(row.id, { is_active: next });
          await loadActiveNavmeshes();
          showToast(
            next
              ? t('accessControl.toast.navmeshWillBeUsed', { label: row.label || row.file_name })
              : t('accessControl.toast.navmeshDeactivated', { label: row.label || row.file_name }),
            'success',
          );
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
          btn.disabled = false;
        }
      });
    });

    navmeshList.querySelectorAll('[data-action="delete-navmesh"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.access-splat-row')?.dataset.id;
        const row = activeNavmeshes.find((item) => String(item.id) === String(id));
        if (!row?.id) return;
        const ok = await askConfirm({
          title: t('accessControl.confirm.deleteNavmeshTitle'),
          message: t('accessControl.confirm.deleteNamedMessage', { label: row.label || row.file_name }),
          confirmLabel: t('accessControl.common.delete'),
          cancelLabel: t('accessControl.common.cancel'),
          danger: true,
        });
        if (!ok) return;
        const deleteStorage = await askConfirm({
          title: t('accessControl.confirm.deleteFromStorageTitle'),
          message: t('accessControl.confirm.deleteFromStorageMessage'),
          confirmLabel: t('accessControl.common.yes'),
          cancelLabel: t('accessControl.common.no'),
          danger: true,
        });
        try {
          await deleteMediaRow(row.id);
          if (deleteStorage) {
            const path = storagePathFromPublicUrl(row.media_url);
            if (path) await deleteProjectMediaFile(path);
          }
          showToast(t('accessControl.toast.navmeshDeleted'), 'success');
          await loadActiveNavmeshes();
        } catch (err) {
          showToast(String(err?.message ?? err), 'error');
        }
      });
    });
  }

  async function uploadNavmeshFiles(files) {
    if (!activeLogin || navmeshUploading) return;
    const poiType = String(activeLogin.poi_type ?? '').trim();
    if (!poiType) {
      showToast(t('accessControl.toast.missingPoiType'), 'error');
      return;
    }

    const navFiles = Array.from(files || []).filter((file) => {
      const classified = classifyMediaFile(file);
      if (classified?.mediaType === 'navmesh') return true;
      return /\.navmesh$/i.test(String(file?.name || ''));
    });
    if (!navFiles.length) {
      showToast(t('accessControl.toast.chooseNavmeshFile'), 'error');
      return;
    }

    navmeshUploading = true;
    if (navmeshUploadBtn) navmeshUploadBtn.disabled = true;
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < navFiles.length; i += 1) {
      const file = navFiles[i];
      const sizeMb = file.size ? (file.size / (1024 * 1024)).toFixed(1) : '?';
      setNavmeshStatus(t('accessControl.assets.uploadingFile', { current: i + 1, total: navFiles.length, name: file.name, sizeMb }));
      await new Promise((r) => setTimeout(r, 0));
      try {
        const classified = classifyMediaFile(file) || {
          mediaType: 'navmesh',
          mimeType: NAVMESH_MIME,
        };
        // Prefer newest upload as the single active navmesh.
        await Promise.all(
          activeNavmeshes
            .filter((r) => r.is_active !== false)
            .map((r) => updateMediaRow(r.id, { is_active: false })),
        );
        const uploaded = await uploadProjectMedia(file, poiType, 'navmesh', {
          onProgress: (pct) => {
            setNavmeshStatus(
              t('accessControl.assets.uploadingProgress', { current: i + 1, total: navFiles.length, name: file.name, pct }),
            );
          },
        });
        await insertMediaRow({
          poi_type: poiType,
          media_url: uploaded.publicUrl,
          media_type: 'navmesh',
          mime_type: classified.mimeType || NAVMESH_MIME,
          file_name: file.name,
          label: file.name.replace(/\.[^.]+$/, ''),
          pos_x: 0,
          pos_y: 0,
          pos_z: 0,
          is_active: true,
        });
        ok += 1;
        await loadActiveNavmeshes();
        setNavmeshStatus(
          t('accessControl.assets.uploadedCount', { ok, total: navFiles.length, failedSuffix: failed ? ` (${failed} failed)` : '' }),
        );
      } catch (err) {
        console.error('[access-navmesh-upload]', err);
        failed += 1;
        showToast(t('accessControl.toast.fileError', { name: file.name, message: String(err?.message ?? err) }), 'error');
      }
    }

    navmeshUploading = false;
    if (navmeshUploadBtn) navmeshUploadBtn.disabled = false;
    await loadActiveNavmeshes();
    showToast(
      t('accessControl.toast.navmeshUploadComplete', { ok, failed }),
      failed ? 'error' : 'success',
    );
  }

  function renderSwitches() {
    switchList.innerHTML = ACCESS_UI_FEATURES.map((field) => {
      const on = isFeatureEnabled(activeFeatures, field.key);
      return `
        <div class="access-switch-row" data-feature="${field.key}">
          <span class="access-switch-icon" aria-hidden="true">${field.icon()}</span>
          <div class="access-switch-copy">
            <span class="access-switch-label">${escapeHtml(field.label)}</span>
            <span class="access-switch-desc">${escapeHtml(field.desc)}</span>
          </div>
          <button type="button"
            class="access-switch ${on ? 'access-switch--on' : ''}"
            role="switch"
            aria-checked="${on ? 'true' : 'false'}"
            aria-label="${escapeHtml(field.label)}">
            <span class="access-switch-track"><span class="access-switch-thumb"></span></span>
          </button>
          ${
            field.choice
              ? `<label class="access-switch-choice${on ? '' : ' is-disabled'}">
                   <span>${escapeHtml(field.choice.label)}</span>
                   <select data-choice="${field.choice.key}" ${on ? '' : 'disabled'}>
                     ${field.choice.options
                       .map(
                         (o) =>
                           `<option value="${escapeHtml(o.value)}"${
                             String(activeFeatures[field.choice.key] ?? '') === o.value
                               ? ' selected'
                               : ''
                           }>${escapeHtml(o.label)}</option>`,
                       )
                       .join('')}
                   </select>
                 </label>`
              : ''
          }
        </div>`;
    }).join('');

    switchList.querySelectorAll('select[data-choice]').forEach((sel) => {
      sel.addEventListener('change', () => {
        activeFeatures = { ...activeFeatures, [sel.dataset.choice]: sel.value };
        void persistActiveFeatures();
      });
    });

    switchList.querySelectorAll('.access-switch').forEach((btn) => {
      btn.addEventListener('click', () => handleSwitchToggle(btn));
    });
  }

  async function persistActiveFeatures() {
    if (!activeLogin) return null;
    const creds = adminCreds();
    if (!creds) {
      showLogin();
      return null;
    }
    const savedRow = await upsertProjectFeaturesAdmin({
      email: creds.email,
      password: creds.password,
      poiType: activeLogin.poi_type,
      loginId: activeLogin.id,
      features: activeFeatures,
    });
    if (savedRow && typeof savedRow === 'object') {
      const normalized = normalizeFeatureRow(savedRow);
      activeFeatures = normalized;
      featuresByPoi.set(String(activeLogin.poi_type).toLowerCase(), {
        ...savedRow,
        ...normalized,
        poi_type: activeLogin.poi_type,
        login_id: activeLogin.id,
      });
    } else {
      featuresByPoi.set(String(activeLogin.poi_type).toLowerCase(), {
        ...featuresByPoi.get(String(activeLogin.poi_type).toLowerCase()),
        ...activeFeatures,
        poi_type: activeLogin.poi_type,
        login_id: activeLogin.id,
      });
    }
    return savedRow;
  }

  async function persistExperienceUrls() {
    if (!activeLogin) return null;
    const creds = adminCreds();
    if (!creds) {
      showLogin();
      return null;
    }
    const savedRow = await upsertProjectExperienceUrlsAdmin({
      email: creds.email,
      password: creds.password,
      poiType: activeLogin.poi_type,
      projectUrl: projectUrlInput?.value ?? '',
      whitelabeledUrl: whitelabeledUrlInput?.value ?? '',
    });
    if (savedRow && typeof savedRow === 'object') {
      const existing = featuresByPoi.get(String(activeLogin.poi_type).toLowerCase()) || {};
      featuresByPoi.set(String(activeLogin.poi_type).toLowerCase(), {
        ...existing,
        ...savedRow,
        poi_type: activeLogin.poi_type,
        login_id: activeLogin.id,
      });
      fillExperienceUrlInputs(activeLogin);
    }
    renderCards();
    return savedRow;
  }

  /** @type {string | null} */
  let savingFeatureKey = null;

  async function handleSwitchToggle(btn) {
    const row = btn.closest('.access-switch-row');
    const key = row?.dataset.feature;
    if (!key || !activeLogin || savingFeatureKey) return;
    if (btn.disabled) return;

    const next = !isFeatureEnabled(activeFeatures, key);
    savingFeatureKey = key;
    btn.disabled = true;
    applySwitchAppearance(btn, next);
    activeFeatures = { ...activeFeatures, [key]: next };
    updateFeatureStatusChip();

    try {
      await persistActiveFeatures();
      if (key === 'languages') {
        syncLanguagePanelVisibility();
        if (next) {
          await loadActiveLanguages();
        }
      }
    } catch (err) {
      activeFeatures = { ...activeFeatures, [key]: !next };
      renderSwitches();
      updateFeatureStatusChip();
      showToast(String(err?.message ?? err), 'error');
      savingFeatureKey = null;
      return;
    }

    renderSwitches();
    updateFeatureStatusChip();
    syncLanguagePanelVisibility();
    renderCards();
    showToast(
      next
        ? t('accessControl.toast.featureEnabled', { feature: ACCESS_UI_FEATURES.find((f) => f.key === key)?.label ?? t('accessControl.common.feature') })
        : t('accessControl.toast.featureDisabled', { feature: ACCESS_UI_FEATURES.find((f) => f.key === key)?.label ?? t('accessControl.common.feature') }),
      'success',
    );
    savingFeatureKey = null;
  }

  async function loadData() {
    const [loginRows, featureRows] = await Promise.all([fetchProjectLogins(), fetchAllProjectFeatures()]);
    logins = loginRows;
    featuresByPoi = new Map(
      featureRows.map((row) => [String(row.poi_type ?? '').toLowerCase(), row]),
    );

    const projectParam = new URLSearchParams(window.location.search).get('project');
    const viewParam = new URLSearchParams(window.location.search).get('view');
    if (projectParam) {
      const match = logins.find((row) => String(row.poi_type).toLowerCase() === projectParam.toLowerCase());
      if (match) {
        showDetailView(match);
        return;
      }
    }
    if (viewParam === 'logs') {
      showLogsView();
      return;
    }
    showGridView();
  }

  function openProjectDialog(login = null) {
    editingLoginId = login?.id ?? null;
    editingOriginalEmail = login?.email ? String(login.email).trim() : null;
    const isEdit = Boolean(login);
    dialog.querySelector('#access-dialog-title').textContent = isEdit ? t('accessControl.dialog.editProjectTenant') : t('accessControl.dialog.newProjectTenant');
    dialog.querySelector('#access-dialog-subtitle').textContent = isEdit
      ? t('accessControl.dialog.updateSubtitle')
      : t('accessControl.dialog.registerSubtitle');
    dialog.querySelector('#access-dialog-save-label').textContent = isEdit ? t('accessControl.common.saveChanges') : t('accessControl.dialog.createTenant');
    const emailInput = dialog.querySelector('#dialog-email');
    emailInput.value = login?.email ?? '';
    dialog.querySelector('#dialog-password').value = login?.password ?? '';
    dialog.querySelector('#dialog-poi-type').value = login?.poi_type ?? '';
    dialog.querySelector('#dialog-map-code').value = login?.map_code ?? '';
    dialog.querySelector('#dialog-client-id').value = login?.client_id ?? MULTISET_MAP.clientId;
    dialog.querySelector('#dialog-client-secret').value = login?.client_secret ?? MULTISET_MAP.clientSecret;
    dialog.querySelector('#dialog-password').required = !isEdit;
    dialog.querySelector('#dialog-poi-type').disabled = isEdit;

    // Block password-manager autofill from swapping this tenant's email to another
    // saved login (that causes UNIQUE email 409 on save).
    if (isEdit) {
      emailInput.setAttribute('readonly', 'readonly');
      const unlockEmail = () => emailInput.removeAttribute('readonly');
      emailInput.addEventListener('focus', unlockEmail, { once: true });
      emailInput.addEventListener('pointerdown', unlockEmail, { once: true });
    } else {
      emailInput.removeAttribute('readonly');
    }

    // Reset secret fields to hidden
    ['dialog-password', 'dialog-client-secret'].forEach((id) => {
      const input = dialog.querySelector(`#${id}`);
      const toggle = dialog.querySelector(`[data-toggle-secret="${id}"]`);
      if (input) input.type = 'password';
      if (toggle) {
        toggle.innerHTML = iconEye();
        toggle.setAttribute('aria-pressed', 'false');
        toggle.title = id === 'dialog-password' ? t('accessControl.common.showPassword') : t('accessControl.common.showClientSecret');
        toggle.setAttribute(
          'aria-label',
          id === 'dialog-password' ? t('accessControl.common.showPassword') : t('accessControl.common.showClientSecret'),
        );
      }
    });

    dialog.showModal();
  }

  async function copyDialogField(inputId, label) {
    const input = dialog.querySelector(`#${inputId}`);
    const value = String(input?.value ?? '').trim();
    if (!value) {
      showToast(t('accessControl.toast.nothingToCopy', { label }), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast(t('accessControl.toast.copied', { label }), 'success');
    } catch {
      showToast(t('accessControl.toast.couldNotCopy', { label: label.toLowerCase() }), 'error');
    }
  }

  dialog.querySelectorAll('[data-copy-input]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inputId = btn.getAttribute('data-copy-input');
      const labels = {
        'dialog-poi-type': t('accessControl.dialog.projectNameLabel'),
        'dialog-email': t('accessControl.cred.emailField'),
        'dialog-password': t('accessControl.cred.passwordField'),
        'dialog-map-code': t('accessControl.cred.mapCodeField'),
        'dialog-client-id': t('accessControl.cred.clientIdField'),
        'dialog-client-secret': t('accessControl.cred.clientSecretField'),
      };
      copyDialogField(inputId, labels[inputId] || t('accessControl.common.value'));
    });
  });

  dialog.querySelectorAll('[data-toggle-secret]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inputId = btn.getAttribute('data-toggle-secret');
      const input = dialog.querySelector(`#${inputId}`);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? iconEyeOff() : iconEye();
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      const hideLabel = inputId === 'dialog-password' ? t('accessControl.common.hidePassword') : t('accessControl.common.hideClientSecret');
      const showLabel = inputId === 'dialog-password' ? t('accessControl.common.showPassword') : t('accessControl.common.showClientSecret');
      btn.title = show ? hideLabel : showLabel;
      btn.setAttribute('aria-label', show ? hideLabel : showLabel);
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoginError('');
    const email = page.querySelector('#access-email').value.trim();
    const password = page.querySelector('#access-password').value;
    if (!isSuperadminCredentials(email, password)) {
      setLoginError(t('accessControl.login.invalidCredentials'));
      return;
    }
    setSuperadminSession(email, password);
    await offerBrowserPasswordSave(email, password);
    showDashboard();
    try {
      await loadData();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    }
  });

  page.querySelector('#access-logout').addEventListener('click', () => {
    clearSuperadminSession();
    window.location.href = '/';
  });

  page.querySelector('#btn-add-project').addEventListener('click', () => openProjectDialog());
  page.querySelector('#access-back-btn').addEventListener('click', () => showGridView());
  hudEl?.querySelectorAll('[data-hud]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dest = btn.dataset.hud;
      if (dest === 'logs') showLogsView();
      else showGridView();
    });
  });

  detailHudEl?.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.detail;
      if (!section || !activeLogin) return;
      setDetailSection(section);
    });
  });

  page.querySelector('#access-experience-urls')?.querySelectorAll('[data-copy-input]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inputId = btn.getAttribute('data-copy-input');
      const input = page.querySelector(`#${inputId}`);
      const label = inputId === 'access-whitelabeled-url' ? t('accessControl.urls.whitelabeledUrlLabel') : t('accessControl.urls.projectUrlLabel');
      void copyText(input?.value, label);
    });
  });

  function closeWhitelabelQrDialog() {
    // Drop the logo so reopening the dialog starts from a plain QR.
    qrLogoImg = null;
    if (qrLogoInput) qrLogoInput.value = '';
    syncQrLogoUi();
    if (!whitelabelQrDialog) return;
    if (typeof whitelabelQrDialog.close === 'function' && whitelabelQrDialog.open) {
      whitelabelQrDialog.close();
    } else {
      whitelabelQrDialog.removeAttribute('open');
    }
  }

  async function openWhitelabelQrDialog() {
    const raw = String(whitelabeledUrlInput?.value ?? '').trim();
    if (!raw) {
      showToast(t('accessControl.toast.enterWhitelabeledUrlFirst'), 'error');
      whitelabeledUrlInput?.focus();
      return;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      showToast(t('accessControl.toast.enterValidUrl'), 'error');
      whitelabeledUrlInput?.focus();
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      showToast(t('accessControl.toast.urlMustStartWithHttp'), 'error');
      return;
    }

    qrSourceUrl = parsed.toString();
    qrDataUrl = null;
    if (qrDialogUrlEl) qrDialogUrlEl.textContent = qrSourceUrl;
    if (qrImageEl) {
      qrImageEl.hidden = true;
      qrImageEl.removeAttribute('src');
    }
    if (qrStatusEl) {
      qrStatusEl.hidden = false;
      qrStatusEl.textContent = t('accessControl.qr.generating');
    }
    if (qrDownloadBtn) qrDownloadBtn.disabled = true;

    if (whitelabelQrDialog) {
      if (typeof whitelabelQrDialog.showModal === 'function') whitelabelQrDialog.showModal();
      else whitelabelQrDialog.setAttribute('open', '');
    }

    await renderWhitelabelQr();
  }

  /**
   * Render (or re-render) the preview from the current URL and logo. Called on
   * open and again whenever the logo is added or removed, so what you see in
   * the dialog is exactly the PNG that Download produces.
   */
  async function renderWhitelabelQr() {
    if (!qrSourceUrl) return;
    if (qrStatusEl) {
      qrStatusEl.hidden = false;
      qrStatusEl.textContent = t('accessControl.qr.generating');
    }
    if (qrDownloadBtn) qrDownloadBtn.disabled = true;

    try {
      const dataUrl = await generateQrDataUrl(qrSourceUrl, qrLogoImg);
      qrDataUrl = dataUrl;
      if (qrImageEl) {
        qrImageEl.src = dataUrl;
        qrImageEl.hidden = false;
      }
      if (qrStatusEl) qrStatusEl.hidden = true;
      if (qrDownloadBtn) qrDownloadBtn.disabled = false;
    } catch (err) {
      console.error(err);
      qrDataUrl = null;
      if (qrImageEl) qrImageEl.hidden = true;
      if (qrStatusEl) {
        qrStatusEl.hidden = false;
        qrStatusEl.textContent = t('accessControl.qr.couldNotGenerate');
      }
      showToast(String(err?.message ?? err), 'error');
    }
  }

  function syncQrLogoUi() {
    const has = Boolean(qrLogoImg);
    if (qrLogoRemoveBtn) qrLogoRemoveBtn.hidden = !has;
    if (qrLogoThumbEl) {
      qrLogoThumbEl.replaceChildren();
      qrLogoThumbEl.classList.toggle('is-empty', !has);
      if (has) {
        const img = document.createElement('img');
        img.src = qrLogoImg.src;
        img.alt = '';
        qrLogoThumbEl.appendChild(img);
      }
    }
  }

  async function onQrLogoPicked(file) {
    const reason = validateLogoFile(file);
    if (reason) {
      showToast(reason, 'error');
      if (qrLogoInput) qrLogoInput.value = '';
      return;
    }
    try {
      qrLogoImg = await loadImageFromFile(file);
      syncQrLogoUi();
      if (qrLogoHintEl) {
        // Level H is what makes the logo safe; say so rather than implying magic.
        qrLogoHintEl.textContent = t('accessControl.qr.logoAddedHint');
      }
      await renderWhitelabelQr();
    } catch (err) {
      console.error(err);
      qrLogoImg = null;
      syncQrLogoUi();
      showToast(String(err?.message ?? err), 'error');
    } finally {
      // Clear the input so re-picking the same file still fires a change event.
      if (qrLogoInput) qrLogoInput.value = '';
    }
  }

  async function clearQrLogo() {
    qrLogoImg = null;
    if (qrLogoInput) qrLogoInput.value = '';
    syncQrLogoUi();
    if (qrLogoHintEl) {
      qrLogoHintEl.textContent = t('accessControl.qr.logoHint');
    }
    await renderWhitelabelQr();
  }

  function downloadWhitelabelQr() {
    if (!qrDataUrl) {
      showToast(t('accessControl.toast.generateQrFirst'), 'error');
      return;
    }
    const poi = String(activeLogin?.poi_type ?? 'project')
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `${poi}-whitelabel-qr${qrLogoImg ? '-logo' : ''}.png`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(t('accessControl.toast.qrDownloaded'), 'success');
  }

  whitelabelGenerateQrBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openWhitelabelQrDialog();
  });
  whitelabelQrDialog?.querySelector('#access-qr-dialog-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeWhitelabelQrDialog();
  });
  whitelabelQrDialog?.querySelector('#access-qr-dialog-cancel')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeWhitelabelQrDialog();
  });
  qrDownloadBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    downloadWhitelabelQr();
  });
  qrLogoInput?.addEventListener('change', (e) => {
    const file = e.target?.files?.[0];
    if (file) void onQrLogoPicked(file);
  });
  qrLogoRemoveBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    void clearQrLogo();
  });
  whitelabelQrDialog?.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeWhitelabelQrDialog();
  });

  experienceUrlsSaveBtn?.addEventListener('click', async () => {
    if (!activeLogin || experienceUrlsSaveBtn.disabled) return;
    experienceUrlsSaveBtn.disabled = true;
    try {
      await persistExperienceUrls();
      showToast(t('accessControl.toast.experienceUrlsSaved'), 'success');
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    } finally {
      experienceUrlsSaveBtn.disabled = false;
    }
  });

  page.querySelector('#access-project-admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeLogin) return;
    const creds = adminCreds();
    if (!creds) {
      showLogin();
      return;
    }
    const form = e.currentTarget;
    const adminEmail = form.querySelector('#access-admin-email').value.trim();
    const adminPassword = form.querySelector('#access-admin-password').value;
    const displayName = form.querySelector('#access-admin-name').value.trim();
    const btn = form.querySelector('#access-admin-assign-btn');
    btn.disabled = true;
    try {
      await adminAssignProjectAdmin({
        email: creds.email,
        password: creds.password,
        poiType: String(activeLogin.poi_type ?? ''),
        adminEmail,
        adminPassword,
        displayName: displayName || null,
      });
      logUserActivity({
        action: 'assigned',
        entityType: 'project_admin',
        entityLabel: adminEmail,
        createdEmail: adminEmail,
        poiType: String(activeLogin.poi_type ?? ''),
      });
      showToast(t('accessControl.toast.projectAdminAssigned'), 'success');
      form.reset();
      await loadProjectAdminMembers();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  page.querySelector('#access-subadmin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeLogin) return;
    const creds = adminCreds();
    if (!creds) {
      showLogin();
      return;
    }
    const form = e.currentTarget;
    const subEmail = form.querySelector('#access-sub-email').value.trim();
    const subPassword = form.querySelector('#access-sub-password').value;
    const displayName = form.querySelector('#access-sub-name').value.trim();
    const btn = form.querySelector('#access-sub-add-btn');
    btn.disabled = true;
    try {
      await projectAdminUpsertSubAdmin({
        email: creds.email,
        password: creds.password,
        subEmail,
        subPassword,
        displayName: displayName || null,
        active: true,
        poiType: String(activeLogin.poi_type ?? ''),
      });
      logUserActivity({
        action: 'created',
        entityType: 'sub_admin',
        entityLabel: subEmail,
        createdEmail: subEmail,
        poiType: String(activeLogin.poi_type ?? ''),
      });
      showToast(t('accessControl.toast.subAdminCreated'), 'success');
      form.reset();
      await loadProjectAdminMembers();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  splatUploadBtn?.addEventListener('click', () => {
    if (!activeLogin) {
      showToast(t('accessControl.toast.openProjectFirst'), 'error');
      return;
    }
    if (splatUploading) return;
    splatFileInput?.click();
  });

  splatFileInput?.addEventListener('change', async () => {
    const files = Array.from(splatFileInput.files || []);
    splatFileInput.value = '';
    if (!files.length) return;
    await uploadSplatFiles(files);
  });

  matterportSaveBtn?.addEventListener('click', () => {
    if (!activeLogin) {
      showToast(t('accessControl.toast.openProjectFirst'), 'error');
      return;
    }
    saveMatterportLink();
  });
  matterportClearBtn?.addEventListener('click', () => {
    if (!activeLogin) {
      showToast(t('accessControl.toast.openProjectFirst'), 'error');
      return;
    }
    clearMatterportLink();
  });
  matterportUrlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveMatterportLink();
    }
  });

  navmeshUploadBtn?.addEventListener('click', () => {
    if (!activeLogin) {
      showToast(t('accessControl.toast.openProjectFirst'), 'error');
      return;
    }
    if (navmeshUploading) return;
    navmeshFileInput?.click();
  });

  navmeshFileInput?.addEventListener('change', async () => {
    const files = Array.from(navmeshFileInput.files || []);
    navmeshFileInput.value = '';
    if (!files.length) return;
    await uploadNavmeshFiles(files);
  });

  dialog.querySelector('#access-dialog-cancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('#access-dialog-close').addEventListener('click', () => dialog.close());

  dialog.querySelector('#access-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const creds = adminCreds();
    if (!creds) {
      showLogin();
      return;
    }

    const payload = {
      email: dialog.querySelector('#dialog-email').value.trim(),
      password: dialog.querySelector('#dialog-password').value,
      poi_type: dialog.querySelector('#dialog-poi-type').value.trim(),
      map_code: dialog.querySelector('#dialog-map-code').value.trim(),
      client_id: dialog.querySelector('#dialog-client-id').value.trim(),
      client_secret: dialog.querySelector('#dialog-client-secret').value.trim(),
    };

    // Autofill often swaps Sparkhouse ↔ Sparkhouse uptown emails and triggers UNIQUE 409.
    // If the typed email belongs to another tenant, keep this row's original email.
    if (editingLoginId && editingOriginalEmail) {
      const typed = payload.email.toLowerCase();
      const original = editingOriginalEmail.toLowerCase();
      if (typed && typed !== original) {
        const clash = logins.find(
          (row) =>
            String(row.id) !== String(editingLoginId) &&
            String(row.email ?? '')
              .trim()
              .toLowerCase() === typed,
        );
        if (clash) {
          payload.email = editingOriginalEmail;
          showToast(
            t('accessControl.toast.emailKept', {
              original: editingOriginalEmail,
              typed: dialog.querySelector('#dialog-email').value.trim(),
              poiType: clash.poi_type,
            }),
            'error',
          );
          const emailInput = dialog.querySelector('#dialog-email');
          if (emailInput) emailInput.value = editingOriginalEmail;
        }
      } else if (!typed) {
        payload.email = editingOriginalEmail;
      }
    }

    try {
      if (editingLoginId) {
        await updateProjectLogin(editingLoginId, payload);
      } else {
        const savedLogin = await insertProjectLogin(payload);
        const loginRow = Array.isArray(savedLogin) ? savedLogin[0] : savedLogin;
        await upsertProjectFeaturesAdmin({
          email: creds.email,
          password: creds.password,
          poiType: payload.poi_type,
          loginId: loginRow?.id ?? null,
          features: { ...DEFAULT_FEATURES },
        });
        await initTenantLanguagesAdmin({
          email: creds.email,
          password: creds.password,
          poiType: payload.poi_type,
        });
      }
      logUserActivity({
        action: editingLoginId ? 'updated' : 'created',
        entityType: 'tenant',
        entityId: editingLoginId || null,
        entityLabel: payload.poi_type,
        createdEmail: payload.email,
        poiType: payload.poi_type,
      });
      dialog.close();
      showToast(editingLoginId ? t('accessControl.toast.tenantUpdated') : t('accessControl.toast.tenantCreated'), 'success');
      await loadData();
      if (activeLogin && editingLoginId && String(activeLogin.id) === String(editingLoginId)) {
        const refreshed = logins.find((row) => String(row.id) === String(editingLoginId));
        if (refreshed) showDetailView(refreshed);
      }
    } catch (err) {
      if (err?.name === 'LoginEmailKeptError' && err.saved) {
        dialog.close();
        showToast(String(err.message), 'error');
        await loadData();
        if (activeLogin && editingLoginId && String(activeLogin.id) === String(editingLoginId)) {
          const refreshed = logins.find((row) => String(row.id) === String(editingLoginId));
          if (refreshed) showDetailView(refreshed);
        }
        return;
      }
      showToast(String(err?.message ?? err), 'error');
    }
  });

  searchInput.addEventListener('input', () => renderCards());

  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const projectParam = params.get('project');
    const viewParam = params.get('view');
    if (viewParam === 'logs') {
      showLogsView();
      return;
    }
    if (!projectParam) {
      showGridView();
      return;
    }
    const match = logins.find((row) => String(row.poi_type).toLowerCase() === projectParam.toLowerCase());
    if (match) showDetailView(match);
    else showGridView();
  });

  if (getSuperadminSession()) {
    showDashboard();
    loadData().catch((err) => showToast(String(err?.message ?? err), 'error'));
  } else {
    showLogin();
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
