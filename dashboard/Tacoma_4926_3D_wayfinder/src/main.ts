import { mountMini3dGta } from './Mini3dGtaEmbed';
import { NAVME_CONFIG } from './behaviors';
import { dismissSplashWhenReady, mountWayfinderSplash } from './wayfinderSplash';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

document.body.classList.add('zcomponent-localized');

const backBtn = document.createElement('button');
backBtn.type = 'button';
backBtn.textContent = 'Back';
backBtn.setAttribute('aria-label', 'Go back');
backBtn.style.cssText =
  'position:fixed;top:max(12px,env(safe-area-inset-top,0px));left:max(12px,env(safe-area-inset-left,0px));z-index:2147483646;padding:8px 14px;border:1.5px solid #2b6fed;border-radius:999px;background:#ffffff;color:#2b6fed;font:600 13px/1.2 Inter,system-ui,sans-serif;cursor:pointer;';
backBtn.addEventListener('click', () => {
  if (window.history.length > 1) {
    const startHref = window.location.href;
    window.history.back();
    window.setTimeout(() => {
      if (window.location.href === startHref) window.location.href = '/access';
    }, 220);
    return;
  }
  window.location.href = '/access';
});
document.body.appendChild(backBtn);

mountWayfinderSplash();

const handle = mountMini3dGta(app, {
  defaultMapCode: import.meta.env.VITE_DEFAULT_MAP_CODE || 'MAP_D43LZMMLU6BJ',
  deferLoadUntilMapOpen: false,
  suppressMapToggle: true,
  autoOpenFullscreen: true,
  hideNavigateInAr: false,
  // POI type comes from behaviors.ts (NAVME_CONFIG.tenant / DEFAULT_POI_TYPE).
  poiType: NAVME_CONFIG.tenant,
  onFullscreenChange(open) {
    document.title = 'NavMe Spatial Studio';
  },
});

dismissSplashWhenReady(handle.ready);
