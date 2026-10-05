/**
 * First-time product tour for project admins / editors (not superadmin /access).
 * Spotlight coachmarks over live dashboard chrome.
 */

import { getAuthSession, isProjectAdminSession } from '../config/auth-session.js';
import { hasSuperadminSession } from '../config/superadmin.js';
import { BRAND_NAME } from '../config/brand.js';
import { isMatterportMapActive } from '../ar/matterport-map.js';
import { iconClose } from './icons.js';
import { t } from '../config/i18n.js';

const TOUR_VERSION = 'v2';

/** @type {HTMLElement | null} */
let rootEl = null;
/** @type {ReturnType<typeof buildSteps>} */
let steps = [];
let stepIndex = 0;
let active = false;
/** @type {(() => void) | null} */
let onOpenPanel = null;
/** @type {Record<string, boolean>} */
let gates = {};

function storageKey() {
  const s = getAuthSession();
  const id = String(s?.accountId || s?.email || 'anon').trim().toLowerCase();
  return `navme_editor_tour_${TOUR_VERSION}_${id}`;
}

export function hasCompletedProductTour() {
  try {
    return localStorage.getItem(storageKey()) === '1';
  } catch {
    return false;
  }
}

export function markProductTourComplete() {
  try {
    localStorage.setItem(storageKey(), '1');
  } catch {
    /* */
  }
}

export function resetProductTourProgress() {
  try {
    localStorage.removeItem(storageKey());
  } catch {
    /* */
  }
}

/**
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
function queryVisible(selector) {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) return null;
  if (el.hidden) return null;
  if (el.classList.contains('hidden')) return null;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return el;
}

/**
 * @param {{
 *   featureGates?: Record<string, boolean>,
 *   openPanel?: (id: string) => void,
 * }} ctx
 */
function buildSteps(ctx) {
  const g = ctx.featureGates || {};
  const mp = isMatterportMapActive();
  /** @type {Array<{
   *   id: string,
   *   title: string,
   *   body: string,
   *   selector?: string,
   *   panel?: string,
   *   placement?: 'auto' | 'bottom' | 'top' | 'left' | 'right',
   * }>} */
  const all = [
    {
      id: 'welcome',
      title: t('productTour.welcomeTitle', { brand: BRAND_NAME }),
      body: t('productTour.welcomeBody'),
    },
    {
      id: 'sidebar',
      title: t('productTour.sidebarTitle'),
      body: t('productTour.sidebarBody'),
      selector: '#sidebar-nav',
      placement: 'right',
    },
    {
      id: 'pois',
      title: t('productTour.poisTitle'),
      body: t('productTour.poisBody'),
      selector: '.sidebar-btn[data-panel="pois"]',
      panel: 'pois',
      placement: 'right',
    },
    {
      id: 'poi-list',
      title: t('productTour.poiListTitle'),
      body: t('productTour.poiListBody'),
      selector: '#poi-list-panel, #poi-list',
      panel: 'pois',
      placement: 'left',
    },
    {
      id: 'poi-item',
      title: t('productTour.poiItemTitle'),
      body: t('productTour.poiItemBody'),
      selector: '#poi-list .poi-item, #poi-list .poi-item-main',
      panel: 'pois',
      placement: 'left',
      optional: true,
    },
    {
      id: 'poi-edit-btn',
      title: t('productTour.poiEditTitle'),
      body: t('productTour.poiEditBody'),
      selector: '#poi-list .poi-item-edit-btn',
      panel: 'pois',
      placement: 'left',
      optional: true,
    },
    {
      id: 'viewport',
      title: t('productTour.viewportTitle'),
      body: mp
        ? t('productTour.viewportBodyMp')
        : t('productTour.viewportBodyMesh'),
      selector: '#viewport',
      placement: 'left',
    },
    {
      id: 'toolbar',
      title: t('productTour.toolbarTitle'),
      body: t('productTour.toolbarBody'),
      selector: '#scene-toolbar, #scene-tool-dock',
      placement: 'top',
    },
    {
      id: 'add-poi',
      title: t('productTour.addPoiTitle'),
      body: t('productTour.addPoiBody'),
      selector: '.scene-tool-btn[data-mode="add-poi"]',
      placement: 'top',
    },
    {
      id: 'display',
      title: t('productTour.displayTitle'),
      body: t('productTour.displayBody'),
      selector: '#map-display-mode',
      placement: 'bottom',
    },
    {
      id: 'mp-modes',
      title: t('productTour.mpModesTitle'),
      body: t('productTour.mpModesBody'),
      selector: '#viewport-mp-modes',
      placement: 'left',
    },
    {
      id: 'stats',
      title: t('productTour.statsTitle'),
      body: t('productTour.statsBody'),
      selector: '#topbar-stat',
      placement: 'bottom',
    },
    {
      id: 'media',
      title: t('productTour.mediaTitle'),
      body: t('productTour.mediaBody'),
      selector: '.sidebar-btn[data-panel="media"]',
      panel: 'media',
      placement: 'right',
    },
    {
      id: 'facilities',
      title: t('productTour.facilitiesTitle'),
      body: t('productTour.facilitiesBody'),
      selector: '.sidebar-btn[data-panel="facilities"]',
      panel: 'facilities',
      placement: 'right',
    },
    {
      id: 'zones',
      title: t('productTour.zonesTitle'),
      body: t('productTour.zonesBody'),
      selector: '.sidebar-btn[data-panel="blocks"]',
      panel: 'blocks',
      placement: 'right',
    },
    {
      id: 'users',
      title: t('productTour.usersTitle'),
      body: t('productTour.usersBody'),
      selector: '.sidebar-btn[data-panel="users"]',
      panel: 'users',
      placement: 'right',
    },
    {
      id: 'editors',
      title: t('productTour.editorsTitle'),
      body: t('productTour.editorsBody'),
      selector: '.sidebar-btn[data-panel="profile"]',
      panel: 'profile',
      placement: 'right',
    },
    {
      id: 'user-guide',
      title: t('productTour.userGuideTitle'),
      body: t('productTour.userGuideBody'),
      selector: '#topbar-help',
      placement: 'bottom',
    },
    {
      id: 'theme',
      title: t('productTour.themeTitle'),
      body: t('productTour.themeBody'),
      selector: '#theme-toggle',
      placement: 'bottom',
    },
    {
      id: 'done',
      title: t('productTour.doneTitle'),
      body: t('productTour.doneBody'),
    },
  ];

  return all.filter((step) => {
    if (step.id === 'media' && g.media === false) return false;
    if (step.id === 'facilities' && g.facilities === false) return false;
    if (step.id === 'zones' && g.blocks === false) return false;
    if (step.id === 'users' && g.users === false) return false;
    if (step.id === 'editors' && !isProjectAdminSession()) return false;
    if (step.id === 'mp-modes' && !mp) return false;
    if (step.optional) {
      const sel = step.selector?.split(',')[0]?.trim();
      if (sel && !document.querySelector(sel)) return false;
    }
    if (step.selector) {
      if (step.id === 'mp-modes' || step.id === 'display' || step.id === 'toolbar' || step.id === 'add-poi') {
        const sel = step.selector.split(',')[0].trim();
        return Boolean(queryVisible(sel) || document.querySelector(sel));
      }
    }
    return true;
  });
}

function ensureRoot() {
  if (rootEl?.isConnected) return rootEl;
  const el = document.createElement('div');
  el.id = 'product-tour';
  el.className = 'product-tour hidden';
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="product-tour-scrim" aria-hidden="true"></div>
    <div class="product-tour-spotlight" id="product-tour-spotlight" aria-hidden="true"></div>
    <div class="product-tour-card float-glass" role="dialog" aria-modal="true" aria-labelledby="product-tour-title">
      <div class="product-tour-card-head">
        <div class="product-tour-progress" id="product-tour-progress"></div>
        <button type="button" class="product-tour-close" data-tour-action="skip" aria-label="${t('productTour.skipTourAriaLabel')}">${iconClose()}</button>
      </div>
      <h2 class="product-tour-title" id="product-tour-title"></h2>
      <p class="product-tour-body" id="product-tour-body"></p>
      <div class="product-tour-actions">
        <button type="button" class="btn-secondary product-tour-btn product-tour-skip" data-tour-action="skip" id="product-tour-skip">${t('productTour.skip')}</button>
        <div class="product-tour-actions-end">
          <button type="button" class="btn-secondary product-tour-btn" data-tour-action="back" id="product-tour-back">${t('productTour.back')}</button>
          <button type="button" class="btn-save product-tour-btn" data-tour-action="next" id="product-tour-next">${t('productTour.next')}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const action = e.target?.closest?.('[data-tour-action]')?.getAttribute('data-tour-action');
    if (action === 'skip') finish(true);
    else if (action === 'next') next();
    else if (action === 'back') back();
  });
  rootEl = el;
  return el;
}

/**
 * @param {DOMRect} rect
 * @param {'auto' | 'bottom' | 'top' | 'left' | 'right'} placement
 */
function placeCard(rect, placement) {
  const card = rootEl?.querySelector('.product-tour-card');
  if (!(card instanceof HTMLElement)) return;
  const gap = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cw = card.offsetWidth || 320;
  const ch = card.offsetHeight || 180;

  let place = placement || 'auto';
  if (place === 'auto') {
    const spaceRight = vw - rect.right;
    const spaceLeft = rect.left;
    const spaceBottom = vh - rect.bottom;
    if (spaceRight > cw + gap) place = 'right';
    else if (spaceLeft > cw + gap) place = 'left';
    else if (spaceBottom > ch + gap) place = 'bottom';
    else place = 'top';
  }

  let top = rect.top;
  let left = rect.left;
  if (place === 'right') {
    left = rect.right + gap;
    top = rect.top + rect.height / 2 - ch / 2;
  } else if (place === 'left') {
    left = rect.left - cw - gap;
    top = rect.top + rect.height / 2 - ch / 2;
  } else if (place === 'bottom') {
    left = rect.left + rect.width / 2 - cw / 2;
    top = rect.bottom + gap;
  } else {
    left = rect.left + rect.width / 2 - cw / 2;
    top = rect.top - ch - gap;
  }

  left = Math.max(12, Math.min(left, vw - cw - 12));
  top = Math.max(12, Math.min(top, vh - ch - 12));
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function clearSpotlight() {
  const spot = rootEl?.querySelector('#product-tour-spotlight');
  if (spot instanceof HTMLElement) {
    spot.style.opacity = '0';
    spot.style.width = '0';
    spot.style.height = '0';
  }
  document.querySelectorAll('.product-tour-target').forEach((el) => {
    el.classList.remove('product-tour-target');
  });
}

/**
 * @param {HTMLElement | null} target
 */
function setSpotlight(target) {
  clearSpotlight();
  const spot = rootEl?.querySelector('#product-tour-spotlight');
  if (!(spot instanceof HTMLElement)) return null;
  if (!target) {
    spot.style.opacity = '0';
    return null;
  }
  target.classList.add('product-tour-target');
  target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  const rect = target.getBoundingClientRect();
  const pad = 8;
  spot.style.opacity = '1';
  spot.style.left = `${Math.round(rect.left - pad)}px`;
  spot.style.top = `${Math.round(rect.top - pad)}px`;
  spot.style.width = `${Math.round(rect.width + pad * 2)}px`;
  spot.style.height = `${Math.round(rect.height + pad * 2)}px`;
  return rect;
}

async function renderStep() {
  if (!active || !rootEl) return;
  const step = steps[stepIndex];
  if (!step) {
    finish(true);
    return;
  }

  if (step.panel && typeof onOpenPanel === 'function') {
    onOpenPanel(step.panel);
    await new Promise((r) => setTimeout(r, 220));
  }

  const title = rootEl.querySelector('#product-tour-title');
  const body = rootEl.querySelector('#product-tour-body');
  const progress = rootEl.querySelector('#product-tour-progress');
  const backBtn = rootEl.querySelector('#product-tour-back');
  const nextBtn = rootEl.querySelector('#product-tour-next');
  if (title) title.textContent = step.title;
  if (body) body.textContent = step.body;
  if (progress) progress.textContent = `${stepIndex + 1} / ${steps.length}`;
  if (backBtn instanceof HTMLButtonElement) {
    backBtn.disabled = stepIndex === 0;
  }
  if (nextBtn) {
    nextBtn.textContent = stepIndex >= steps.length - 1 ? t('productTour.finish') : t('productTour.next');
  }

  let target = null;
  if (step.selector) {
    const parts = step.selector.split(',').map((s) => s.trim());
    for (let attempt = 0; attempt < 8 && !target; attempt += 1) {
      for (const sel of parts) {
        target = queryVisible(sel);
        if (target) break;
        const raw = document.querySelector(sel);
        if (raw instanceof HTMLElement && !raw.classList.contains('hidden') && !raw.hidden) {
          target = raw;
          break;
        }
      }
      if (!target) await new Promise((r) => setTimeout(r, 60));
    }
  }

  // Optional steps with no target (e.g. empty POI list) — skip forward.
  if (step.optional && !target) {
    stepIndex += 1;
    void renderStep();
    return;
  }

  const rect = setSpotlight(target);
  const card = rootEl.querySelector('.product-tour-card');
  if (card instanceof HTMLElement) {
    if (rect) {
      placeCard(rect, step.placement || 'auto');
    } else {
      card.style.left = '50%';
      card.style.top = '50%';
      card.style.transform = 'translate(-50%, -50%)';
    }
    if (rect) card.style.transform = '';
  }
}

function next() {
  if (stepIndex >= steps.length - 1) {
    finish(true);
    return;
  }
  stepIndex += 1;
  void renderStep();
}

function back() {
  if (stepIndex <= 0) return;
  stepIndex -= 1;
  void renderStep();
}

/**
 * @param {boolean} completed
 */
function finish(completed) {
  active = false;
  clearSpotlight();
  if (rootEl) {
    rootEl.classList.add('hidden');
  }
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
  if (completed) markProductTourComplete();
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') finish(true);
  else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
  else if (e.key === 'ArrowLeft') back();
}

function onResize() {
  if (active) void renderStep();
}

/**
 * @param {{
 *   force?: boolean,
 *   featureGates?: Record<string, boolean>,
 *   openPanel?: (id: string) => void,
 * }} [opts]
 */
export function startProductTour(opts = {}) {
  if (hasSuperadminSession()) return { ok: false, reason: 'superadmin' };
  if (!opts.force && hasCompletedProductTour()) {
    return { ok: false, reason: 'done' };
  }

  gates = opts.featureGates || {};
  onOpenPanel = typeof opts.openPanel === 'function' ? opts.openPanel : null;
  steps = buildSteps({ featureGates: gates, openPanel: onOpenPanel });
  if (!steps.length) return { ok: false, reason: 'empty' };

  stepIndex = 0;
  active = true;
  const root = ensureRoot();
  root.classList.remove('hidden');
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  void renderStep();
  return { ok: true };
}

/**
 * Auto-start once after the editor is ready (first login only).
 * @param {{
 *   featureGates?: Record<string, boolean>,
 *   openPanel?: (id: string) => void,
 *   delayMs?: number,
 * }} [opts]
 */
export function maybeStartProductTour(opts = {}) {
  if (hasSuperadminSession()) return;
  if (hasCompletedProductTour()) return;
  const delay = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : 700;
  window.setTimeout(() => {
    if (hasCompletedProductTour() || isProductTourActive()) return;
    // Still on loading cover — wait a bit more rather than covering it.
    if (document.body.classList.contains('matterport-loading')) {
      window.setTimeout(() => maybeStartProductTour({ ...opts, delayMs: 400 }), 400);
      return;
    }
    // Ensure POIs drawer is open so list / edit pencil steps can highlight.
    opts.openPanel?.('pois');
    startProductTour({
      force: false,
      featureGates: opts.featureGates,
      openPanel: opts.openPanel,
    });
  }, delay);
}

export function isProductTourActive() {
  return active;
}
