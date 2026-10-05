/**
 * 3D viewport tools — all four actions visible; each opens its nav panel + tool mode.
 */
import {
  iconFootprint,
  iconPlacePoi,
  iconPlaceFacility,
  iconPlaceMedia,
  iconPlaceBlock,
  iconClose,
  iconLock,
} from './icons.js';
import { mountMeniscusNav } from './meniscus-sidebar.js';
import { showToast } from './toast.js';
import { t } from '../config/i18n.js';

/** @typedef {'default' | 'walk' | 'add-poi' | 'add-facility' | 'add-media' | 'draw-block'} SceneToolMode */

/** @type {Record<string, 'pois' | 'facilities' | 'media' | 'blocks' | null>} */
const MODE_PANEL = {
  walk: null,
  'add-poi': 'pois',
  'add-facility': 'facilities',
  'add-media': 'media',
  'draw-block': 'blocks',
};

const TOOL_LOCK_LABELS = {
  'add-facility': 'sceneToolbar.lockLabelAmenities',
  'add-media': 'sceneToolbar.lockLabelMedia',
  'draw-block': 'sceneToolbar.lockLabelZones',
  'draw-stairs': 'sceneToolbar.lockLabelZones',
};

/**
 * @param {HTMLElement} viewportBody
 * @param {{
 *   onModeChange?: (mode: SceneToolMode) => void,
 *   onCancel?: () => void,
 *   onToolActivate?: (mode: SceneToolMode, panelId: 'pois' | 'facilities' | 'media' | 'blocks' | null) => void,
 * }} [options]
 */
export function createSceneToolbar(viewportBody, options = {}) {
  const onModeChange = options.onModeChange;
  const onCancel = options.onCancel;
  const onToolActivate = options.onToolActivate;
  let activeMode = 'default';

  const root = document.createElement('div');
  root.className = 'scene-toolbar chrome-layer';
  root.id = 'scene-toolbar';
  root.innerHTML = `
    <div class="scene-toolbar-inner meniscus-dock float-glass" id="scene-tool-dock">
      <svg class="meniscus-skin" aria-hidden="true">
        <path class="meniscus-fill"></path>
      </svg>
      <div class="meniscus-bead" aria-hidden="true"></div>
      <div class="meniscus-tabs" role="tablist" aria-label="${t('sceneToolbar.ariaSceneTools')}">
        <button type="button" class="scene-tool-btn" data-mode="walk" title="${t('sceneToolbar.goToTitle')}" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconFootprint()}</span>
          <span class="scene-tool-label">${t('sceneToolbar.goToLabel')}</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="add-poi" data-panel="pois" title="${t('sceneToolbar.addPoiTitle')}" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlacePoi()}</span>
          <span class="scene-tool-label">${t('sceneToolbar.addPoiLabel')}</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="add-facility" data-panel="facilities" title="${t('sceneToolbar.addAmenityTitle')}" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlaceFacility()}</span>
          <span class="scene-tool-label">${t('sceneToolbar.addAmenityLabel')}</span>
          <span class="scene-tool-lock" aria-hidden="true">${iconLock()}</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="add-media" data-panel="media" title="${t('sceneToolbar.addMediaTitle')}" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlaceMedia()}</span>
          <span class="scene-tool-label">${t('sceneToolbar.addMediaLabel')}</span>
          <span class="scene-tool-lock" aria-hidden="true">${iconLock()}</span>
        </button>
        <button type="button" class="scene-tool-btn" data-mode="draw-block" data-panel="blocks" title="${t('sceneToolbar.drawZoneTitle')}" aria-pressed="false" role="tab">
          <span class="scene-tool-icon">${iconPlaceBlock()}</span>
          <span class="scene-tool-label">${t('sceneToolbar.addBlockLabel')}</span>
          <span class="scene-tool-lock" aria-hidden="true">${iconLock()}</span>
        </button>
      </div>
    </div>
    <button type="button" class="scene-tool-cancel hidden" id="scene-tool-cancel" title="${t('sceneToolbar.exitToolTitle')}" aria-label="${t('sceneToolbar.exitAriaLabel')}">
      ${iconClose()}
    </button>
  `;

  viewportBody.appendChild(root);

  const dock = root.querySelector('#scene-tool-dock');
  const cancelBtn = root.querySelector('#scene-tool-cancel');
  const buttons = root.querySelectorAll('.scene-tool-btn');

  const meniscus = mountMeniscusNav(dock, {
    tabSelector: '.scene-tool-btn',
    toggleable: true,
    onSelect: (id) => {
      if (!id) {
        applyMode('default');
        onCancel?.();
        return;
      }
      const btn = dock.querySelector(`.scene-tool-btn[data-mode="${id}"]`);
      if (btn?.dataset.locked === '1') {
        const labelKey = TOOL_LOCK_LABELS[id];
        const label = labelKey ? t(labelKey) : t('sceneToolbar.lockLabelDefault');
        showToast(t('sceneToolbar.featureNotEnabled', { label }), 'info');
        meniscus.clear(true);
        return;
      }
      const mode = /** @type {SceneToolMode} */ (id);
      applyMode(mode);
      onToolActivate?.(mode, MODE_PANEL[mode] ?? null);
    },
  });

  /**
   * @param {SceneToolMode} mode
   */
  function applyMode(mode) {
    const next =
      mode === 'walk' ||
      mode === 'add-poi' ||
      mode === 'add-facility' ||
      mode === 'add-media' ||
      mode === 'draw-block'
        ? mode
        : 'default';
    activeMode = next;
    buttons.forEach((btn) => {
      const on = btn.dataset.mode === activeMode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    cancelBtn.classList.toggle('hidden', activeMode === 'default');
    onModeChange?.(activeMode);
  }

  function setMode(mode) {
    applyMode(mode);
    if (activeMode === 'default') meniscus.clear(true);
    else meniscus.goTo(activeMode, true);
  }

  function cancel() {
    setMode('default');
    onCancel?.();
  }

  cancelBtn.addEventListener('click', cancel);

  return {
    element: root,
    setMode,
    cancel,
    getMode: () => activeMode,
    /** Hide Go-to on Matterport (Showcase walkthrough replaces mesh Go-to). */
    setGotoVisible(visible) {
      const walkBtn = root.querySelector('.scene-tool-btn[data-mode="walk"]');
      if (!walkBtn) return;
      walkBtn.hidden = !visible;
      if (!visible && activeMode === 'walk') cancel();
      requestAnimationFrame(() => meniscus.layout(false));
    },
    /**
     * Keep a tool visible but locked when the project feature flag is off.
     * @param {string} mode
     * @param {boolean} locked
     */
    setToolLocked(mode, locked) {
      const isLocked = Boolean(locked);
      root.querySelectorAll(`.scene-tool-btn[data-mode="${mode}"]`).forEach((btn) => {
        btn.hidden = false;
        btn.style.removeProperty('display');
        btn.classList.toggle('is-locked', isLocked);
        btn.dataset.locked = isLocked ? '1' : '0';
        if (isLocked) {
          btn.setAttribute('aria-disabled', 'true');
          btn.classList.remove('active');
          btn.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-selected', 'false');
          if (activeMode === mode) {
            applyMode('default');
            meniscus.clear(true);
          }
        } else {
          btn.removeAttribute('aria-disabled');
        }
      });
      requestAnimationFrame(() => meniscus.layout(false));
    },
    layout() {
      meniscus.layout(false);
    },
  };
}
