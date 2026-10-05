/**
 * Route planner for the Matterport view.
 *
 * The existing Navigate button routes from wherever the camera is to one
 * selected POI, which suits walking the space. Planning a route needs both ends
 * chosen deliberately, so this adds a From / To picker over the same machinery:
 *
 *   navigateBetweenPois()  → recast navmesh pathfinding (same navmesh the AR
 *                            experience uses, via NavigationRoute/NavMeshQuery)
 *   setMatterportNavRouteOverlay() → draws the resulting world polyline on the
 *                            Showcase overlay, so the route appears inside the
 *                            Matterport view rather than the three.js map.
 *
 * Nothing here re-implements pathfinding; it only chooses the endpoints and
 * hands the resulting polyline to the overlay.
 */

import { poisData, poiDisplayName } from '../ar/pois.js';
import {
  navigateBetweenPois,
  clearNavigationRoute,
  getNavigationPathWorldPoints,
  getPoiWorldPosition,
} from '../ar/navigation-controller.js';
import {
  setMatterportNavRouteOverlay,
  clearMatterportNavRouteOverlay,
  isMatterportMapActive,
  matterportSweepPath,
  matterportMoveToSweep,
} from '../ar/matterport-map.js';
import { showToast } from './toast.js';
import { t } from '../config/i18n.js';

/** Straight-line length of the computed polyline, in metres. */
function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {HTMLElement} viewportEl element the panel is appended to
 * @param {HTMLButtonElement | null} toggleBtn button that opens/closes the panel
 */
export function createRoutePlanner(viewportEl, toggleBtn) {
  if (!viewportEl) return { destroy() {} };

  const panel = document.createElement('div');
  panel.className = 'route-planner hidden';
  panel.id = 'route-planner-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('routePlanner.ariaPlanRoute'));
  panel.innerHTML = `
    <div class="route-planner-head">
      <span class="route-planner-title">${t('routePlanner.title')}</span>
      <button type="button" class="route-planner-close" id="route-planner-close" aria-label="${t('routePlanner.closeAriaLabel')}">×</button>
    </div>
    <label class="route-planner-field">
      <span>${t('routePlanner.routeAlongLabel')}</span>
      <select id="route-mode" class="map-display-select">
        <option value="sweeps" selected>${t('routePlanner.modeSweepsOption')}</option>
        <option value="navmesh">${t('routePlanner.modeNavmeshOption')}</option>
      </select>
    </label>
    <label class="route-planner-field">
      <span>${t('routePlanner.fromLabel')}</span>
      <select id="route-from" class="map-display-select"></select>
    </label>
    <button type="button" class="route-planner-swap" id="route-swap" title="${t('routePlanner.swapTitle')}">
      ${t('routePlanner.swapButton')}
    </button>
    <label class="route-planner-field">
      <span>${t('routePlanner.toLabel')}</span>
      <select id="route-to" class="map-display-select"></select>
    </label>
    <p class="route-planner-status" id="route-status">${t('routePlanner.statusDefault')}</p>
    <div class="route-planner-actions">
      <button type="button" class="btn-secondary" id="route-clear">${t('routePlanner.clearButton')}</button>
      <button type="button" class="btn-save" id="route-go">${t('routePlanner.navigateButton')}</button>
    </div>
  `;
  viewportEl.appendChild(panel);

  const modeSel = panel.querySelector('#route-mode');
  const fromSel = panel.querySelector('#route-from');
  const toSel = panel.querySelector('#route-to');
  const statusEl = panel.querySelector('#route-status');
  const goBtn = panel.querySelector('#route-go');
  const clearBtn = panel.querySelector('#route-clear');

  let open = false;
  let busy = false;
  let hasRoute = false;

  function setStatus(text, tone = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `route-planner-status${tone ? ` is-${tone}` : ''}`;
  }

  /** Rebuild both dropdowns, preserving the current choices where still valid. */
  function refreshOptions() {
    const prevFrom = fromSel?.value ?? '';
    const prevTo = toSel?.value ?? '';
    const opts = poisData
      .map(
        (poi, i) =>
          `<option value="${i}">${escapeHtml(poiDisplayName(poi) || t('routePlanner.poiFallbackName', { index: i + 1 }))}</option>`,
      )
      .join('');

    if (fromSel) fromSel.innerHTML = `<option value="">${t('routePlanner.selectStartOption')}</option>${opts}`;
    if (toSel) toSel.innerHTML = `<option value="">${t('routePlanner.selectDestinationOption')}</option>${opts}`;

    // Restore by index only while it still points at the same POI.
    if (fromSel && prevFrom !== '' && poisData[Number(prevFrom)]) fromSel.value = prevFrom;
    if (toSel && prevTo !== '' && poisData[Number(prevTo)]) toSel.value = prevTo;

    if (!poisData.length) setStatus(t('routePlanner.noPoisYet'), 'warn');
  }

  async function runNavigate() {
    if (busy) return;
    const from = Number(fromSel?.value ?? '');
    const to = Number(toSel?.value ?? '');

    if (!Number.isInteger(from) || fromSel?.value === '') {
      setStatus(t('routePlanner.pickStart'), 'warn');
      return;
    }
    if (!Number.isInteger(to) || toSel?.value === '') {
      setStatus(t('routePlanner.pickDestination'), 'warn');
      return;
    }
    if (from === to) {
      setStatus(t('routePlanner.sameStartDestination'), 'warn');
      return;
    }
    if (!isMatterportMapActive()) {
      setStatus(t('routePlanner.switchToMatterport'), 'warn');
      return;
    }

    busy = true;
    if (goBtn) goBtn.disabled = true;
    setStatus(t('routePlanner.findingPath'));

    const mode = modeSel?.value === 'navmesh' ? 'navmesh' : 'sweeps';

    try {
      let points = [];
      let firstSweepId = null;

      if (mode === 'sweeps') {
        // Treedis-style: follow Matterport's own camera points. Always walkable,
        // because it is the same graph Showcase uses to move you around.
        const a = getPoiWorldPosition(from);
        const b = getPoiWorldPosition(to);
        if (!a || !b) {
          setStatus(t('routePlanner.poisNoPosition'), 'error');
          return;
        }
        const res = await matterportSweepPath(a, b);
        if (!res.ok) {
          setStatus(res.error || t('routePlanner.noCameraRoute'), 'error');
          await clearMatterportNavRouteOverlay();
          hasRoute = false;
          return;
        }
        // Anchor the ends at the POIs so the line reaches them, not just the
        // nearest scan position.
        points = [
          { x: a.x, y: a.y, z: a.z },
          ...res.points,
          { x: b.x, y: b.y, z: b.z },
        ];
        firstSweepId = res.sweepIds?.[0] ?? null;
      } else {
        // showVisual:false keeps the three.js route hidden — Matterport draws its own.
        const result = await navigateBetweenPois(from, to, { showVisual: false });
        if (!result.ok) {
          setStatus(result.error || t('routePlanner.noRouteFound'), 'error');
          await clearMatterportNavRouteOverlay();
          hasRoute = false;
          return;
        }
        points =
          result.pathPoints?.length >= 2 ? result.pathPoints : getNavigationPathWorldPoints();
      }

      if (points.length < 2) {
        setStatus(t('routePlanner.noDrawablePoints'), 'error');
        hasRoute = false;
        return;
      }

      // forceDollhouse omitted → stays in walkthrough, which is the point.
      const overlay = await setMatterportNavRouteOverlay(points);
      if (!overlay?.ok) {
        setStatus(overlay?.error || t('routePlanner.couldNotDrawRoute'), 'error');
        hasRoute = false;
        return;
      }

      hasRoute = true;
      const metres = polylineLength(points);
      const fromName = poisData[from] ? poiDisplayName(poisData[from]) : t('routePlanner.fallbackStart');
      const toName = poisData[to] ? poiDisplayName(poisData[to]) : t('routePlanner.fallbackDestination');
      setStatus(
        t('routePlanner.routeSummary', {
          from: fromName,
          to: toName,
          metres: metres.toFixed(1),
          mode: mode === 'sweeps' ? t('routePlanner.modeCameraPoints') : t('routePlanner.modeNavmesh'),
        }),
        'ok',
      );

      // Walk the user to the start of the route so it reads from eye level.
      // Best-effort: a failed move still leaves a drawn, visible route.
      if (firstSweepId) await matterportMoveToSweep(firstSweepId);
    } catch (err) {
      console.error('[route-planner] navigate failed', err);
      setStatus(err?.message ?? t('routePlanner.navigationFailed'), 'error');
      showToast(err?.message ?? t('routePlanner.navigationFailedToast'), 'error');
    } finally {
      busy = false;
      if (goBtn) goBtn.disabled = false;
    }
  }

  async function runClear() {
    await clearMatterportNavRouteOverlay();
    clearNavigationRoute();
    hasRoute = false;
    setStatus(t('routePlanner.routeCleared'));
  }

  function setOpen(next) {
    open = Boolean(next);
    panel.classList.toggle('hidden', !open);
    toggleBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleBtn?.classList.toggle('active', open);
    if (open) refreshOptions();
  }

  toggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    setOpen(!open);
  });
  panel.querySelector('#route-planner-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    setOpen(false);
  });
  panel.querySelector('#route-swap')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!fromSel || !toSel) return;
    const a = fromSel.value;
    fromSel.value = toSel.value;
    toSel.value = a;
  });
  modeSel?.addEventListener('change', () => {
    setStatus(
      modeSel.value === 'sweeps'
        ? t('routePlanner.modeSweepsHint')
        : t('routePlanner.modeNavmeshHint'),
    );
  });
  goBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    void runNavigate();
  });
  clearBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    void runClear();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  refreshOptions();

  return {
    element: panel,
    refresh: refreshOptions,
    open: () => setOpen(true),
    close: () => setOpen(false),
    hasRoute: () => hasRoute,
    destroy() {
      panel.remove();
    },
  };
}
