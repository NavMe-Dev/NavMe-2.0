/**
 * NavMe Spatial Studio — POI editor + media (NavMe enterprise UI).
 * Routes: `/` editor, `/media` manager, `/access` superadmin, `/analytics` user analytics,
 *         `/wayfinding` route planner, `/c/:id` credentials.
 */
import './styles/global.css';
import './styles/enterprise-theme.css';
import './styles/glass-theme.css';
import './styles/media.css';
import './styles/glass-animations.css';
import './styles/spatial-decor.css';
import './styles/product-tour.css';
import './styles/floors.css';
import { initTheme, onThemeChange, getTheme } from './config/theme.js';
import { t } from './config/i18n.js';
import { initButtonRipples } from './ui/button-ripple.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { getAppRoute } from './app-routes.js';
import { renderForm } from './ui/form.js';
import { createStatusBar } from './ui/status.js';
import { getM2MToken } from './services/multiset-auth.js';
import { loadRawMapMesh, loadTexturedMapMesh, clearMapMeshLoaderCache } from './services/map-mesh-loader.js';
import {
  initScene,
  applySceneTheme,
  canCreateWebGLContext,
  getMultisetAnchor,
  setMapDisplayMode,
  getMapDisplayMode,
  scheduleFrameCameraToMap,
  setOnPoiPickedFromCanvas,
  setSceneInteractionMode,
  setOnSceneMapClick,
  hidePlacementPreview,
  hideBlockDrawPreview,
  cancelBlockDraw,
  setOnSceneBlockDraw,
  detachGizmo,
  flyTo,
  setOnBlockPickedFromCanvas,
  setOnFacilityPickedFromCanvas,
  getSceneInteractionMode,
  addSplatMap,
  clearMapMesh,
  getLastPickedPoiIndex,
  getMapMeshBounds,
  setMatterportMeshCompositor,
  resetMatterportMapAlign,
  alignMultisetAnchorToMatterport,
  setMatterportDollhouseMeshOverlay,
  setMatterportSceneMarkersVisible,
} from './ar/scene.js';
import { createSceneToolbar } from './ui/scene-toolbar.js';
import { createRoutePlanner } from './ui/route-planner.js';
import { hydratePoisFromSupabase, refreshPOIGroup, setPOIGroupVisible, poisData, addPOIWithDb, updatePOIPosition, updatePOIExpectedPosition, savePoiToDb, setSelectedPoiLabel, getPoiMapPosition, getPoiNavigationPosition, getPoiExpectedPosition, isSuperAdminMapRole } from './ar/pois.js';
import { hydrateCategoriesFromSupabase } from './ar/categories.js';
import { hydrateFloorsFromSupabase } from './ar/floors.js';
import { createFloorPanel } from './ui/floor-panel.js';
import { hydrateGuidedToursFromSupabase } from './ar/guided-tours.js';
import { createGuidedTourPanel } from './ui/guided-tour-panel.js';
import {
  hydrateFacilitiesFromSupabase,
  refreshFacilityGroup,
  setFacilityGroupVisible,
  facilitiesData,
  addFacilityWithDb,
  updateFacilityPosition,
  saveFacilityToDb,
} from './ar/facilities.js';
import {
  hydrateMediaFromSupabase,
  refreshMediaGroup,
  setMediaGltfLoader,
  setMediaGroupVisible,
  getMediaObjects,
  applySavedMediaRow,
  remountMediaItem,
  mediaData,
  getActiveSplatMaps,
  projectUsesSplatMap,
  getActiveMatterportUrl,
  getActiveMatterportMaps,
  projectUsesMatterportMap,
  isMatterportMediaRow,
  addMediaWithDb,
  updateMediaTransform,
  saveMediaToDb,
} from './ar/media.js';
import {
  ensureMatterportHost,
  loadMatterportMap,
  clearMatterportMap,
  isMatterportMapActive,
  shouldUseMatterportCamera,
  setMatterportPlaceHandler,
  setMatterportToolMode,
  syncMatterportEntityTags,
  matterportGoToPoint,
  matterportSetViewMode,
  onMatterportViewModeChange,
  matterportToggleDefurnish,
  onMatterportDefurnishChange,
  getMatterportFloors,
  matterportMoveToFloor,
  onMatterportFloorChange,
  setMatterportMoveTarget,
  setMatterportEntityKindsVisible,
  setMatterportSelectedLabel,
  setMatterportMoveHandler,
  setMatterportMoveDismissHandler,
  ensureMatterportMovePinsHidden,
  setOnMatterportPoiPinActivated,
  getMatterportTagId,
  getMatterportSweepBounds,
  setMatterportMediaPreview,
  setMatterportMediaTransformHandler,
  syncMatterportMediaOverlayPosition,
  setMatterportHeatmapOverlay,
  clearMatterportHeatmapOverlay,
  showMatterportNavmeshOverlay,
  hideMatterportNavmeshOverlay,
  isMatterportNavmeshVisible,
  setMatterportNavRouteOverlay,
  clearMatterportNavRouteOverlay,
  refreshMatterportAnnotOverlay,
} from './ar/matterport-map.js';
import {
  hydrateTreasuresFromSupabase,
  refreshTreasureGroup,
  setTreasureGltfLoader,
  setTreasureGroupVisible,
} from './ar/treasure.js';
import {
  buildNavigationSetup,
  syncNavigationToLatestPoi,
  navigateToPoi,
  clearNavigationRoute,
  isNavigationRouteVisible,
  setNavigationVisualVisible,
  getNavigationPathWorldPoints,
} from './ar/navigation-controller.js';
import { createPOIPanel } from './ui/poi-panel.js';
import { createFacilityPanel } from './ui/facility-panel.js';
import { createMediaPanel } from './ui/media-panel.js';
import { createTreasurePanel } from './ui/treasure-panel.js';
import { createUserPanel } from './ui/user-panel.js';
import { createProfilePanel } from './ui/profile-panel.js';
import { createGmapPanel } from './ui/gmap-panel.js';
import { createBlockPanel } from './ui/block-panel.js';
import { createStairsPanel } from './ui/stairs-panel.js';
import { openMediaModal } from './ui/media-modal.js';
import { createDashboard } from './ui/dashboard.js';
import { maybeStartProductTour, startProductTour, resetProductTourProgress } from './ui/product-tour.js';
import { initMediaAdminPage } from './ui/media-admin-page.js';
import { initAccessControlPage } from './ui/access-control-page.js';
import { initUserAnalyticsPage } from './ui/user-analytics-page.js';
import { initWayfindingPage } from './ui/wayfinding-page.js';
import { initCredentialPage } from './ui/credential-page.js';
import { setPoiSession, clearPoiSession, getPoiType, getMapCode } from './config/poi-session.js';
import { clearNavMeshVisualization, showNavMeshVisualization, hideNavMeshVisualization, isNavMeshVisualizationVisible, clearNavMesh, hasNavMesh } from './ar/navigation-mesh.js';
import { showGlobalHeatmap, clearGlobalHeatmap, clearUserHeatmap } from './ar/nav-heatmap.js';
import { iconNavMeshShow, iconNavMeshHide, iconNavigate, iconNavigateOff, iconDollhouse, iconFloorPlan, iconExploreSpace, iconHideFurniture, iconPlacePoi, iconClose, iconBox } from './ui/icons.js';
import { showToast } from './ui/toast.js';
import {
  prepareGotoWalkable,
  snapGotoToWalkable,
  snapPlacementToNavMesh,
  ensureNavMeshForPlacement,
  walkPoseFromPoint,
  clearWalkableGotoPoints,
} from './ar/goto-walk.js';
import { clearAllMarkers, clearHistoryRoute } from './ar/user-tracking.js';
import { fetchNavnodesForHeatmap, isSupabaseConfigured, authenticateLoginNavme, authenticateNavmeAccount, fetchProjectFeaturesByPoiType } from './services/supabase.js';
import { parseDbBool } from './utils/parse-db-bool.js';
import { hydrateBlocksFromSupabase, refreshBlockGroup, setBlocksVisible, setBlockLayerFilter, isStairsZone, blocksData, addBlockWithDb } from './ar/blocks.js';
import { getPendingProjectLogin, clearPendingProjectLogin } from './config/project-login-bridge.js';
import { getProjectSession, saveProjectSession, clearProjectSession } from './config/project-session.js';
import { setAuthSession, getAuthSession, clearAuthSession, isSubAdminSession } from './config/auth-session.js';
import { setForceGeometricMesh, clearForceGeometricMesh, getForceGeometricMesh } from './config/map-view-preference.js';
import { MULTISET_MAP } from './config/spacecheck-access.js';
import { getDefaultOrganizationId } from './config/organization.js';
import './styles/minimal-theme.css';
import './styles/meniscus-sidebar.css';
import { hasSuperadminSession, clearSuperadminSession } from './config/superadmin.js';
import { startMediaRealtime, stopMediaRealtime, markMediaLocalWrite } from './services/media-realtime.js';
import { getDracoWorkerLimit } from './utils/device-tier.js';
import { cancelLazyMapTextures } from './ar/map-texture-loader.js';

const app = document.getElementById('app');
initTheme();
initButtonRipples(app);

const appRoute = getAppRoute();
if (appRoute === 'media-admin') {
  initMediaAdminPage(app);
} else if (appRoute === 'access-control') {
  initAccessControlPage(app);
} else if (appRoute === 'user-analytics') {
  initUserAnalyticsPage(app);
} else if (appRoute === 'wayfinding') {
  initWayfindingPage(app);
} else if (appRoute === 'credential') {
  initCredentialPage(app);
} else {
  bootEditor(app);
}

async function createMapGltfLoader() {
  await MeshoptDecoder.ready;
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/gltf/`);
  dracoLoader.setWorkerLimit(getDracoWorkerLimit());
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

function createTextureProgressHandler(statusBar, isActive) {
  return (loaded, total) => {
    if (typeof isActive === 'function' && !isActive()) return;
    if (!total) return;
    if (loaded >= total) {
      statusBar.show(t('main.mapTextures.ready'), 'success');
      setTimeout(() => statusBar.hide(), 2200);
      return;
    }
    statusBar.show(t('main.mapTextures.loading', { loaded, total }), 'loading');
  };
}

/**
 * Astra-style staged map load callbacks (status bar progress).
 * @param {{ statusBar: ReturnType<typeof createStatusBar>, isActive?: () => boolean }} opts
 */
function createMapLoadCallbacks({ statusBar, isActive }) {
  return {
    createGltfLoader: createMapGltfLoader,
    onStage: (message) => {
      if (typeof isActive === 'function' && !isActive()) return;
      statusBar.show(message, 'loading');
    },
    onTextureProgress: createTextureProgressHandler(statusBar, isActive),
  };
}

function bootEditor(container) {
  onThemeChange((theme) => applySceneTheme(theme));

  const dashboard = createDashboard(container);
  const statusBar = createStatusBar(dashboard.statusSlot ?? dashboard.viewportBody ?? container);

  /** After X on move bar, keep it closed until selection changes. */
  let matterportMoveDismissedKey = null;
  /** Mesh-map Move POI bar dismissed for this selection key until POI changes. */
  let meshMoveDismissedKey = null;
  /** @type {HTMLElement | null} */
  let meshMoveBar = null;
  let meshMoveArmed = false;

  const poiPanel = createPOIPanel(dashboard.slots.pois, {
    onPoiListChange: () => dashboard.refreshStats(),
    onSelectionChange: (index) => {
      setSelectedPoiLabel(index);
      if (index >= 0) {
        matterportMoveDismissedKey = null;
        meshMoveDismissedKey = null;
        mediaPanel.deselect?.();
        facilityPanel.deselect?.();
      }
      meshMoveArmed = false;
      poiPanel.stopMeshMove?.();
      syncNavToggleBtn();
      // Defer Showcase sync so Edit POI paints on the same click frame.
      requestAnimationFrame(() => {
        syncMatterportMoveSelection();
        syncMeshMoveBar();
      });
    },
    onEditOpenChange: (open) => {
      // Move XYZ shows only while Edit is open; clear dismiss so Edit can reopen it.
      if (open) matterportMoveDismissedKey = null;
      requestAnimationFrame(() => {
        syncMatterportMoveSelection();
        syncMeshMoveBar();
      });
    },
    onXyzTargetChange: () => {
      meshMoveArmed = false;
      poiPanel.stopMeshMove?.();
      requestAnimationFrame(() => {
        syncMatterportMoveSelection();
        syncMeshMoveBar();
      });
    },
    onStartAddPoi: () => {
      dashboard.openPanel?.('pois');
      if (sceneToolbar) {
        sceneToolbar.setMode('add-poi');
      } else {
        document.querySelector('.scene-tool-btn[data-mode="add-poi"]')?.click();
      }
    },
  });

  const facilityPanel = createFacilityPanel(dashboard.slots.facilities, {
    onFacilityListChange: () => dashboard.refreshStats('facilities'),
    onSelectionChange: (index) => {
      if (index >= 0) {
        poiPanel.deselect?.();
        mediaPanel.deselect?.();
        setMatterportMediaPreview(null);
      }
      syncMatterportMoveSelection();
    },
  });

  const floorPanel = createFloorPanel(dashboard.slots.floors, {
    onFloorsChange: () => {
      poiPanel.refreshFloorOptions?.();
      poiPanel.refresh?.();
    },
  });
  const guidedTourPanel = createGuidedTourPanel(dashboard.slots['guided-tours'], {
    onToursChange: () => dashboard.refreshStats('guided-tours'),
  });
  dashboard.setSidebarPanelVisible?.('floors', isSuperAdminMapRole());
  let sceneToolbar;

  const mediaPanel = createMediaPanel(dashboard.slots.media, {
    onMediaChange: () => dashboard.refreshStats('media'),
    onStartPlaceOnMap: () => startPlaceMediaOnMap(),
    onEditMedia: (saved, context) => handleMediaSaved(saved, context),
    onSelectionChange: (index) => {
      if (index >= 0) {
        matterportMoveDismissedKey = null;
        poiPanel.deselect?.();
        facilityPanel.deselect?.();
      }
      syncMatterportMoveSelection();
      if (!isMatterportMapActive()) {
        setMatterportMediaPreview(null);
        return;
      }
      if (index >= 0 && index < mediaData.length && !isMatterportMediaRow(mediaData[index])) {
        setMatterportMediaPreview(mediaData[index]);
      } else {
        setMatterportMediaPreview(null);
      }
    },
  });

  /** Matterport "navigate to POI" state (no navmesh route line). */
  let matterportNavPoiIndex = -1;

  function matterportSelectionKey(kind, id) {
    if (id == null) return null;
    return `${kind}:${id}`;
  }

  function ensureMeshMoveBar() {
    const body = dashboard.viewportBody || dashboard.element.querySelector('#viewport-body');
    if (!body) return null;
    if (meshMoveBar?.isConnected) return meshMoveBar;

    meshMoveBar = document.createElement('div');
    meshMoveBar.id = 'mesh-move-bar';
    meshMoveBar.className = 'matterport-place-bar mesh-move-bar float-glass chrome-layer hidden';
    meshMoveBar.innerHTML = `
      <div class="matterport-place-copy">
        <span class="matterport-place-icon" aria-hidden="true">${iconPlacePoi()}</span>
        <div class="matterport-place-text">
          <span class="matterport-place-title" id="mesh-move-title">${t('main.meshMove.title')}</span>
          <code class="matterport-place-xyz" id="mesh-move-xyz">${t('main.meshMove.clickToDrag')}</code>
        </div>
      </div>
      <button type="button" class="matterport-move-arm" id="mesh-move-arm" aria-pressed="false">
        ${t('main.meshMove.title')}
      </button>
      <button
        type="button"
        class="matterport-move-close"
        id="mesh-move-close"
        title="${t('main.meshMove.stopMoving')}"
        aria-label="${t('main.meshMove.stopMoving')}"
      >${iconClose()}</button>
    `;
    body.appendChild(meshMoveBar);

    meshMoveBar.querySelector('#mesh-move-arm')?.addEventListener('click', () => {
      if (meshMoveArmed) {
        meshMoveArmed = false;
        poiPanel.stopMeshMove?.();
        syncMeshMoveBar();
        return;
      }
      const ok = poiPanel.startMeshMove?.();
      if (!ok) {
        statusBar.show(t('main.meshMove.selectPoiToMove'), 'error');
        setTimeout(() => statusBar.hide(), 2000);
        return;
      }
      meshMoveArmed = true;
      syncMeshMoveBar();
    });

    meshMoveBar.querySelector('#mesh-move-close')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const poiIdx = poiPanel.getSelectedIndex?.() ?? -1;
      if (poiIdx >= 0 && poisData[poiIdx]?.id) {
        meshMoveDismissedKey = matterportSelectionKey('poi', poisData[poiIdx].id);
      } else {
        meshMoveDismissedKey = null;
      }
      meshMoveArmed = false;
      poiPanel.stopMeshMove?.();
      if (meshMoveBar) {
        meshMoveBar.classList.add('hidden');
        meshMoveBar.classList.remove('is-move');
      }
    });

    return meshMoveBar;
  }

  function syncMeshMoveBar() {
    const bar = ensureMeshMoveBar();
    if (!bar) return;

    // Move POI is geometric-mesh only — never on Matterport / splat project maps.
    const onGeometricMesh =
      getForceGeometricMesh() ||
      (!projectUsesMatterportMap() && !projectUsesSplatMap() && !isMatterportMapActive());
    if (
      !onGeometricMesh ||
      isMatterportMapActive() ||
      shouldUseMatterportCamera() ||
      splatMapMode
    ) {
      meshMoveArmed = false;
      poiPanel.stopMeshMove?.();
      bar.classList.add('hidden');
      bar.classList.remove('is-move');
      return;
    }

    const poiIdx = poiPanel.getSelectedIndex?.() ?? -1;
    const poi = poiIdx >= 0 && poiIdx < poisData.length ? poisData[poiIdx] : null;
    if (!poi?.id) {
      meshMoveArmed = false;
      poiPanel.stopMeshMove?.();
      bar.classList.add('hidden');
      bar.classList.remove('is-move');
      return;
    }

    const key = matterportSelectionKey('poi', poi.id);
    if (key && meshMoveDismissedKey === key) {
      meshMoveArmed = false;
      poiPanel.stopMeshMove?.();
      bar.classList.add('hidden');
      bar.classList.remove('is-move');
      return;
    }

    bar.classList.remove('hidden');
    bar.classList.add('is-move');
    const title = bar.querySelector('#mesh-move-title');
    const xyz = bar.querySelector('#mesh-move-xyz');
    const arm = bar.querySelector('#mesh-move-arm');
    if (title) title.textContent = String(poi.poi_name || t('main.meshMove.title'));
    const xyzTarget = poiPanel.getXyzEditTarget?.() === 'expected' ? 'expected' : 'nav';
    const editingExpected = xyzTarget === 'expected' && isSuperAdminMapRole();
    if (xyz) {
      const pos = editingExpected ? getPoiExpectedPosition(poi) : getPoiNavigationPosition(poi);
      xyz.textContent = meshMoveArmed
        ? t('main.meshMove.xyzValue', { x: Number(pos.x).toFixed(3), y: Number(pos.y).toFixed(3), z: Number(pos.z).toFixed(3) })
        : editingExpected
          ? t('main.meshMove.clickToDragExpected')
          : t('main.meshMove.clickToDragNav');
    }
    if (arm) {
      arm.textContent = meshMoveArmed
        ? t('main.meshMove.doneMoving')
        : editingExpected
          ? t('main.meshMove.moveExpected')
          : t('main.meshMove.title');
      arm.classList.toggle('active', meshMoveArmed);
      arm.setAttribute('aria-pressed', meshMoveArmed ? 'true' : 'false');
    }

    if (meshMoveArmed) {
      poiPanel.startMeshMove?.();
    } else {
      poiPanel.stopMeshMove?.();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('spacecheck-poi-dragging-xy', (ev) => {
      if (!meshMoveArmed || !meshMoveBar || meshMoveBar.classList.contains('hidden')) return;
      const d = ev.detail;
      if (!d) return;
      const xyz = meshMoveBar.querySelector('#mesh-move-xyz');
      if (xyz) {
        xyz.textContent = t('main.meshMove.xyzValue', { x: Number(d.x).toFixed(3), y: Number(d.y).toFixed(3), z: Number(d.z).toFixed(3) });
      }
    });
  }

  function syncMatterportMoveSelection() {
    if (!isMatterportMapActive()) {
      setMatterportMoveTarget(null);
      void setMatterportSelectedLabel(null);
      return;
    }
    // Place tools own the catcher — don't fight them.
    const toolMode = sceneToolbar?.getMode?.() || 'default';
    if (
      toolMode === 'add-poi' ||
      toolMode === 'add-facility' ||
      toolMode === 'add-media' ||
      toolMode === 'walk'
    ) {
      setMatterportMoveTarget(null);
      void setMatterportSelectedLabel(null);
      return;
    }
    // Move XYZ for POIs only while Edit is open (select alone stays clean).
    const poiIdx = poiPanel.getSelectedIndex?.() ?? -1;
    const poiEditOpen = Boolean(poiPanel.isEditOpen?.());
    if (poiIdx >= 0 && poiIdx < poisData.length && poisData[poiIdx]?.id && poiEditOpen) {
      const poi = poisData[poiIdx];
      const label = String(poi.poi_name || 'POI');
      const key = matterportSelectionKey('poi', poi.id);
      if (key && matterportMoveDismissedKey === key) {
        setMatterportMoveTarget(null);
        void setMatterportSelectedLabel({ kind: 'poi', id: poi.id, label });
        return;
      }
      if (key && matterportMoveDismissedKey && matterportMoveDismissedKey !== key) {
        matterportMoveDismissedKey = null;
      }
      const navPos = getPoiNavigationPosition(poi);
      const expectedPos = getPoiExpectedPosition(poi);
      const editingExpected =
        poiPanel.getXyzEditTarget?.() === 'expected' && isSuperAdminMapRole();
      const movePos = editingExpected ? expectedPos : navPos;
      setMatterportMoveTarget({
        kind: 'poi',
        id: String(poi.id),
        index: poiIdx,
        label,
        xyzTarget: editingExpected ? 'expected' : 'nav',
        x: movePos.x,
        y: movePos.y,
        z: movePos.z,
      });
      void setMatterportSelectedLabel({ kind: 'poi', id: poi.id, label });
      return;
    }
    // POI selected but Edit closed — hide Move XYZ; keep name pin if selected.
    if (poiIdx >= 0 && poiIdx < poisData.length && poisData[poiIdx]?.id) {
      const poi = poisData[poiIdx];
      setMatterportMoveTarget(null);
      void setMatterportSelectedLabel({
        kind: 'poi',
        id: poi.id,
        label: String(poi.poi_name || 'POI'),
      });
      return;
    }
    const mediaIdx = mediaPanel.getSelectedIndex?.() ?? -1;
    if (
      mediaIdx >= 0 &&
      mediaIdx < mediaData.length &&
      mediaData[mediaIdx]?.id &&
      !isMatterportMediaRow(mediaData[mediaIdx])
    ) {
      const key = matterportSelectionKey('media', mediaData[mediaIdx].id);
      if (key && matterportMoveDismissedKey === key) {
        setMatterportMoveTarget(null);
        void setMatterportSelectedLabel(null);
        return;
      }
      if (key && matterportMoveDismissedKey && matterportMoveDismissedKey !== key) {
        matterportMoveDismissedKey = null;
      }
      const item = mediaData[mediaIdx];
      setMatterportMoveTarget({
        kind: 'media',
        id: String(item.id),
        index: mediaIdx,
        label: String(item.label || 'Media'),
        x: Number(item.pos_x ?? item.x),
        y: Number(item.pos_y ?? item.y),
        z: Number(item.pos_z ?? item.z),
      });
      void setMatterportSelectedLabel(null);
      return;
    }
    matterportMoveDismissedKey = null;
    setMatterportMoveTarget(null);
    void setMatterportSelectedLabel(null);
  }

  setMatterportMoveHandler((pt, target, phase) => {
    if (target.kind === 'poi') {
      const editingExpected =
        (target.xyzTarget === 'expected' || poiPanel.getXyzEditTarget?.() === 'expected') &&
        isSuperAdminMapRole();
      const apply = (point) => {
        if (editingExpected) {
          updatePOIExpectedPosition(target.index, point.x, point.y, point.z);
        } else {
          // Move updates navigation XYZ only — never expected (exact click).
          updatePOIPosition(target.index, point.x, point.y, point.z);
        }
        if (phase === 'end') {
          // Keep Edit open / Move armed — only refresh XYZ fields, don't re-fly.
          poiPanel.selectByIndex?.(target.index, {
            fly: false,
            openEdit: true,
            xyzTarget: editingExpected ? 'expected' : 'nav',
          });
          savePoiToDb(target.index, { translate: false })
            .then(() => {
              if (poisData[target.index]) {
                return syncMatterportEntityTags({ pois: [poisData[target.index]] });
              }
            })
            .then(() => ensureMatterportMovePinsHidden())
            .catch((err) => console.warn('[space-map] poi move save', err));
        }
      };
      if (phase === 'end' && !editingExpected) {
        void snapPointOntoNavMesh(pt).then((snapped) => {
          apply({
            x: snapped.x,
            y: isMatterportMapActive() ? Number(snapped.y) + 0.3 : snapped.y,
            z: snapped.z,
          });
        });
        return;
      }
      apply(pt);
      return;
    }
    if (target.kind === 'media') {
      updateMediaTransform(target.index, { pos_x: pt.x, pos_y: pt.y, pos_z: pt.z });
      syncMatterportMediaOverlayPosition(pt);
      mediaPanel.selectByIndex?.(target.index, { fly: false, attach: false });
      if (phase === 'end') {
          saveMediaToDb(target.index, { logAction: 'moved' }).catch((err) =>
          console.warn('[space-map] media move save', err),
        );
        const tagId = getMatterportTagId('media', mediaData[target.index]?.id);
        if (tagId) {
          void syncMatterportEntityTags({ media: [mediaData[target.index]] });
        }
      }
    }
  });

  setMatterportMoveDismissHandler(() => {
    const poiIdx = poiPanel.getSelectedIndex?.() ?? -1;
    if (poiIdx >= 0 && poisData[poiIdx]?.id) {
      matterportMoveDismissedKey = matterportSelectionKey('poi', poisData[poiIdx].id);
    } else {
      const mediaIdx = mediaPanel.getSelectedIndex?.() ?? -1;
      if (mediaIdx >= 0 && mediaData[mediaIdx]?.id) {
        matterportMoveDismissedKey = matterportSelectionKey('media', mediaData[mediaIdx].id);
      } else {
        matterportMoveDismissedKey = null;
      }
    }
    sceneToolbar?.setMode?.('default');
    setMatterportToolMode('default');
    statusBar.show(t('main.walkthrough.navigateFreely'), 'success');
    setTimeout(() => statusBar.hide(), 2200);
  });

  setMatterportMediaTransformHandler((patch, phase) => {
    const idx = mediaPanel.getSelectedIndex?.() ?? -1;
    if (idx < 0 || idx >= mediaData.length) return;
    updateMediaTransform(idx, patch);
    mediaPanel.selectByIndex?.(idx, { fly: false, attach: false });
    if (phase === 'end') {
      saveMediaToDb(idx, {
        logAction:
          patch.scale_x != null || patch.scale_y != null || patch.scale_z != null || patch.width != null || patch.height != null
            ? 'scaled'
            : patch.pos_x != null || patch.pos_y != null || patch.pos_z != null
              ? 'moved'
              : 'updated',
      }).catch((err) => console.warn('[space-map] media transform save', err));
      if (patch.pos_x != null || patch.pos_y != null || patch.pos_z != null) {
        void syncMatterportEntityTags({ media: [mediaData[idx]] });
      }
    }
  });

  /** @type {'treasure'|'task-dest'|'token'|'hint'|null} */
  let treasurePlaceMode = null;

  const treasurePanel = createTreasurePanel(dashboard.slots.treasure, {
    onTreasureChange: () => dashboard.refreshStats('treasure'),
    onStartPlaceTreasure: () => startPlaceTreasureOnMap('treasure'),
    onStartPlaceTaskDest: () => startPlaceTreasureOnMap('task-dest'),
    onStartPlaceToken: () => startPlaceTreasureOnMap('token'),
    onStartPlaceHint: () => startPlaceTreasureOnMap('hint'),
  });

  /**
   * Heat map on Matterport: keep current view (walkthrough / dollhouse) and
   * paint the fast 2D overlay — do not force dollhouse.
   */
  async function prepareMatterportHeatOverlays(statusLabel = t('main.heatMap.loading')) {
    if (!isMatterportMapActive()) return { ok: false, error: t('main.space3d.notActive') };
    statusBar.show(statusLabel, 'loading');

    setMatterportMeshCompositor(true);
    setMatterportSceneMarkersVisible(false);
    clearGlobalHeatmap();
    clearUserHeatmap();
    hideNavMeshVisualization();
    return { ok: true };
  }

  /**
   * Heat map / navmesh on Matterport: open dollhouse and use Showcase overlays
   * (not the Three.js canvas — that was covering the space with a black screen).
   */
  async function prepareMatterportDollhouseOverlays(statusLabel = t('main.dollhouse.opening')) {
    if (!isMatterportMapActive()) return { ok: false, error: t('main.space3d.notActive') };
    statusBar.show(statusLabel, 'loading');

    setMatterportMeshCompositor(true);
    setMatterportSceneMarkersVisible(false);
    clearGlobalHeatmap();
    clearUserHeatmap();
    hideNavMeshVisualization();

    const modeResult = await matterportSetViewMode('dollhouse');
    if (!modeResult.ok) {
      return { ok: false, error: modeResult.error || t('main.dollhouse.openFailed') };
    }
    setMpModeActive('dollhouse');
    return { ok: true };
  }

  /**
   * Keep geometric navmesh ready in the background (even while Matterport is visible).
   * Aligns the MultiSet mesh to Showcase so placement snaps land in Matterport XYZ.
   * @param {{ force?: boolean, silent?: boolean }} [opts]
   */
  async function ensureBackgroundNavMeshForPlacement(opts = {}) {
    try {
      if (isMatterportMapActive()) {
        const mpBox = await getMatterportSweepBounds();
        if (mpBox && !mpBox.isEmpty()) {
          alignMultisetAnchorToMatterport({
            matterportBox: mpBox,
            pois: poisData,
          });
        }
      }
      // Placement only needs the navmesh query — skip heavy walkable-point sampling.
      const result = await ensureNavMeshForPlacement({
        force: Boolean(opts.force),
        sampleWalkable: false,
        onProgress: opts.silent
          ? undefined
          : (msg) => statusBar.show(msg, 'loading'),
      });
      return result;
    } catch (err) {
      console.warn('[navmesh] background prep failed', err);
      return { ok: false, error: err?.message || String(err), count: 0 };
    }
  }

  /**
   * Snap a placement click onto the walkable geometric navmesh.
   * Opens the dialog immediately; snaps when the mesh is ready (no long hang).
   * @param {{ x: number, y: number, z: number }} pt
   */
  async function snapPointOntoNavMesh(pt) {
    if (!pt) return pt;
    // Fast path: mesh already loaded — snap without awaiting prep.
    if (hasNavMesh()) {
      const snapped = snapPlacementToNavMesh(pt);
      if (snapped) return { x: snapped.x, y: snapped.y, z: snapped.z };
      return pt;
    }
    const prep = await ensureBackgroundNavMeshForPlacement({ silent: true });
    if (!prep?.ok) return pt;
    const snapped = snapPlacementToNavMesh(pt);
    if (!snapped) return pt;
    return { x: snapped.x, y: snapped.y, z: snapped.z };
  }

  function leaveMatterportDollhouseOverlays() {
    if (!isMatterportMapActive()) return;
    setMatterportDollhouseMeshOverlay(false);
    resetMatterportMapAlign();
    // Navmesh chrome is dollhouse-oriented; heat uses the 2D canvas in any mode.
    hideNavMeshVisualization();
    hideMatterportNavmeshOverlay();
    syncNavmeshBtn(false);
  }

  const userPanel = createUserPanel(dashboard.slots.users, {
    onUserSelect: (user) => {
      if (!user) return;
      // Only flip Display mode off combined heat — do NOT clear Matterport overlays
      // here (async clear was racing and wiping the per-user orange points).
      const modeSelect = dashboard.element.querySelector('#map-display-mode');
      if (modeSelect && modeSelect.value === 'heatmap') {
        modeSelect.value = 'shaded';
        clearGlobalHeatmap();
        setMapDisplayMode('shaded');
      }
    },
    onUsersChange: () => dashboard.refreshStats('users'),
    onMapHeatmapRefresh: async (opts = {}) => {
      if (!getPoiType() || !isSupabaseConfigured()) return;

      const modeSelect = dashboard.element.querySelector('#map-display-mode');
      if (modeSelect) modeSelect.value = 'heatmap';
      setMapDisplayMode('heatmap');
      clearUserHeatmap();

      const filter = opts.filter === 'logged' || opts.filter === 'guest' ? opts.filter : 'all';
      const userIds = Array.isArray(opts.userIds) ? opts.userIds : null;
      const label =
        filter === 'logged' ? t('main.heatMap.loggedInUsers') : filter === 'guest' ? t('main.heatMap.guests') : t('main.heatMap.allUsers');

      const points = await fetchNavnodesForHeatmap(
        userIds ? { userIds } : {},
      );
      if (!points.length) {
        clearGlobalHeatmap();
        void clearMatterportHeatmapOverlay();
        statusBar.show(t('main.heatMap.noPointsFor', { label }), 'error');
        setTimeout(() => statusBar.hide(), 2200);
        return;
      }
      if (isMatterportMapActive()) {
        const prep = await prepareMatterportHeatOverlays(t('main.heatMap.loading'));
        if (!prep.ok) {
          statusBar.show(prep.error || t('main.heatMap.failed'), 'error');
          setTimeout(() => statusBar.hide(), 3200);
          return;
        }
        const overlay = await setMatterportHeatmapOverlay(points);
        if (!overlay.ok) {
          statusBar.show(overlay.error || t('main.heatMap.overlayFailed'), 'error');
          setTimeout(() => statusBar.hide(), 2500);
          return;
        }
      } else {
        showGlobalHeatmap(points);
      }
      statusBar.show(t('main.heatMap.pointsCount', { count: points.length, label }), 'success');
      setTimeout(() => statusBar.hide(), 2000);
    },
  });

  const profilePanel = createProfilePanel(dashboard.slots.profile);
  const gmapPanel = createGmapPanel(dashboard.slots.gmap);

  let startStairsDraw = () => {};
  let stopStairsDraw = () => {};

  const blockPanel = createBlockPanel(dashboard.slots.blocks, {
    onBlocksChange: () => {
      refreshBlockGroup(getMultisetAnchor());
      dashboard.refreshStats('blocks');
      dashboard.refreshStats('stairs');
    },
    onEnsureBlocksVisible: () => {
      applySceneLayers('blocks');
    },
  });

  const stairsPanel = createStairsPanel(dashboard.slots.stairs, {
    onStairsChange: () => {
      refreshBlockGroup(getMultisetAnchor());
      dashboard.refreshStats('stairs');
      dashboard.refreshStats('blocks');
    },
    onEnsureStairsVisible: () => {
      applySceneLayers('stairs');
    },
    onStartDrawOnMap: () => startStairsDraw(),
  });

  setOnSceneBlockDraw(async (rect) => {
    hideBlockDrawPreview();
    cancelBlockDraw();

    if (getSceneInteractionMode() === 'draw-stairs') {
      dashboard.openPanel('stairs');
      applySceneLayers('stairs');
      try {
        await stairsPanel.quickAddStairsBlock(rect);
        statusBar.show(t('main.stairs.markerSaved'), 'success');
        setTimeout(() => statusBar.hide(), 1800);
        setSceneInteractionMode('draw-stairs');
      } catch (err) {
        statusBar.show(err.message || t('main.stairs.markFailed'), 'error');
        setSceneInteractionMode('draw-stairs');
      }
      return;
    }

    dashboard.openPanel('blocks');
    applySceneLayers('blocks');
    blockPanel.openAddDialog(rect);
    sceneToolbar.setMode('default');
    setSceneInteractionMode('default');
  });

  const formUI = renderForm(container, (creds) => onFormSubmit(creds, { statusBar, formUI }));

  restoreOrPendingLogin();

  async function restoreOrPendingLogin() {
    const pending = getPendingProjectLogin();
    const savedAuth = getAuthSession();
    const saved = pending
      ? { email: pending.email, password: pending.password, fromPending: true }
      : savedAuth
        ? { email: savedAuth.email, password: savedAuth.password, fromPending: false }
        : (() => {
            const session = getProjectSession();
            return session ? { ...session, fromPending: false } : null;
          })();

    if (!saved) return;

    formUI.hide();
    formUI.disable();
    statusBar.show(
      pending ? t('main.login.signingInTo', { poiType: pending.poiType }) : t('main.login.restoringSession'),
      'loading',
    );

    try {
      const cachedRole = savedAuth?.role;
      const cachedClientId = String(savedAuth?.clientId ?? '').trim();
      const cachedClientSecret = String(savedAuth?.clientSecret ?? '').trim();
      const cachedPoiType = String(savedAuth?.poiType ?? '').trim();
      const cachedMapCode = String(savedAuth?.mapCode ?? '').trim();
      let loginData =
        !pending &&
        (cachedRole === 'project_admin' || cachedRole === 'sub_admin') &&
        cachedClientId &&
        cachedClientSecret &&
        cachedPoiType &&
        cachedMapCode
          ? {
              clientId: cachedClientId,
              clientSecret: cachedClientSecret,
              mapCode: cachedMapCode,
              poiType: cachedPoiType,
              organizationId: getDefaultOrganizationId(),
            }
          : null;

      if (!loginData) {
        try {
          const auth = await authenticateNavmeAccount({
            email: saved.email,
            password: saved.password,
          });
          if (auth?.isSuperadmin || auth?.role === 'superadmin') {
            window.location.href = '/access';
            return;
          }
          if (auth?.poiType && auth?.mapCode && (auth.role === 'project_admin' || auth.role === 'sub_admin')) {
            setAuthSession({
              accountId: auth.accountId,
              email: saved.email,
              password: saved.password,
              role: auth.role,
              poiType: auth.poiType,
              mapCode: auth.mapCode,
              memberId: auth.memberId,
              clientId: auth.clientId,
              clientSecret: auth.clientSecret,
            });
            loginData = {
              clientId: auth.clientId || MULTISET_MAP.clientId,
              clientSecret: auth.clientSecret || MULTISET_MAP.clientSecret,
              mapCode: auth.mapCode,
              poiType: auth.poiType,
              organizationId: auth.organizationId || getDefaultOrganizationId(),
            };
          }
        } catch (err) {
          if (String(err?.message ?? '').includes('Superadmin')) throw err;
          console.warn('[auth] restore via authenticate_navme_account failed:', err);
        }
      }

      if (!loginData) {
        loginData = await authenticateLoginNavme({
          email: saved.email,
          password: saved.password,
        });
      }
      if (!loginData) {
        throw new Error(pending ? t('main.login.invalidProjectCredentials') : t('main.login.sessionExpired'));
      }

      if (pending) clearPendingProjectLogin();
      // Normal user restore must not keep a leftover /access superadmin session
      // (that incorrectly unlocked Geometric mesh + bypassed feature flags).
      if (!saved.fromPending) {
        clearSuperadminSession();
        clearForceGeometricMesh();
      } else {
        // Superadmin "Login to project" / Geometric mesh hand-off from /access.
        setForceGeometricMesh(Boolean(pending?.forceGeometricMesh));
      }
      saveProjectSession({ email: saved.email, password: saved.password });

      await onFormSubmit(
        {
          clientId: loginData.clientId,
          clientSecret: loginData.clientSecret,
          mapCode: loginData.mapCode,
          poiType: loginData.poiType,
          organizationId: loginData.organizationId,
        },
        { statusBar, formUI },
      );
    } catch (err) {
      if (pending) clearPendingProjectLogin();
      clearProjectSession();
      clearAuthSession();
      console.error(err);
      statusBar.show(err.message || t('main.login.failed'), 'error');
      formUI.enable();
      formUI.show();
      formUI.setError(err.message || (pending ? t('main.login.autoLoginFailed') : t('main.login.sessionRestoreFailed')));
    }
  }

  function handleLogout() {
    beginMapMeshLoad();
    sessionToken = null;
    mapLoader = null;
    activeMeshQuality = 'raw';
    splatMapMode = false;
    setMapQualityUiEnabled(true);
    if (mapMeshQualitySelect) mapMeshQualitySelect.value = 'raw';
    clearMapMeshLoaderCache();
    stopMediaRealtime();
    clearProjectSession();
    clearAuthSession();
    clearForceGeometricMesh();
    clearPoiSession();
    clearGlobalHeatmap();
    clearUserHeatmap();
    clearAllMarkers();
    clearHistoryRoute();
    clearNavMeshVisualization();
    statusBar.hide();
    poiPanel.hide();
    facilityPanel.hide();
    mediaPanel.hide();
    treasurePanel.hide();
    userPanel.hide();
    profilePanel.hide();
    gmapPanel.hide();
    blockPanel.hide();
    stairsPanel.hide();
    document.body.classList.remove('navme-logs-report-open');
    dashboard.element?.classList.remove('logs-focus');
    dashboard.hide();
    formUI.resetAfterLogout();
    formUI.show();
    window.location.reload();
  }

  dashboard.onLogout(handleLogout);
  dashboard.onHelpTour?.(() => {
    if (hasSuperadminSession()) return;
    resetProductTourProgress();
    startProductTour({
      force: true,
      featureGates,
      openPanel: (id) => dashboard.openPanel?.(id),
    });
  });

  function scheduleEditorTour(opts = {}) {
    if (hasSuperadminSession()) return;
    const requireMatterport = Boolean(opts.afterMatterport);
    const startedAt = performance.now();
    const maxWaitMs = 45000;

    const tryStart = () => {
      if (hasSuperadminSession()) return;
      // Never overlay the tour on the Matterport loading cover.
      if (document.body.classList.contains('matterport-loading')) {
        if (performance.now() - startedAt < maxWaitMs) {
          window.setTimeout(tryStart, 200);
        }
        return;
      }
      if (requireMatterport && !isMatterportMapActive()) {
        if (performance.now() - startedAt < maxWaitMs) {
          window.setTimeout(tryStart, 200);
        }
        return;
      }
      dashboard.openPanel?.('pois');
      maybeStartProductTour({
        featureGates,
        openPanel: (id) => dashboard.openPanel?.(id),
        // Short beat after Showcase is visible — not tied to mesh download.
        delayMs: 700,
      });
    };

    window.setTimeout(tryStart, 300);
  }

  setOnPoiPickedFromCanvas((index) => {
    dashboard.openPanel('pois');
    // Select + fly (fast on Matterport); never open the edit sidebar on map pick.
    poiPanel.selectByIndex(index, { openEdit: false });
  });

  setOnMatterportPoiPinActivated((info) => {
    const kind = info?.kind === 'media' ? 'media' : 'poi';
    const entityId = String(info?.poiId || info?.mediaId || info?.id || '');
    if (!entityId) return;
    matterportMoveDismissedKey = null;

    if (kind === 'media') {
      const index = mediaData.findIndex((m) => String(m.id) === entityId);
      if (index < 0) return;
      // Same as list selection: open Media panel + edit (selectMedia always opens edit).
      dashboard.openPanel('media');
      mediaPanel.selectByIndex(index, { fly: false, attach: false });
      return;
    }

    const index = poisData.findIndex((p) => String(p.id) === entityId);
    if (index < 0) return;
    // Open edit; fly once via select (do not call go-to again — that loops fades).
    dashboard.openPanel('pois');
    poiPanel.selectByIndex(index, { openEdit: true, fly: true });
  });

  setOnFacilityPickedFromCanvas((index) => {
    dashboard.openPanel('facilities');
    facilityPanel.selectByIndex(index);
  });

  setOnBlockPickedFromCanvas((blockId) => {
    const block = blocksData.find((b) => b.id === blockId);
    if (block && isStairsZone(block)) {
      dashboard.openPanel('stairs');
      stairsPanel.selectById(blockId);
      return;
    }
    dashboard.openPanel('blocks');
    blockPanel.selectById(blockId);
  });

  const viewportBody = dashboard.element.querySelector('#viewport-body');
  const sceneOverlay = dashboard.element.querySelector('#scene-overlay-ui');
  ensureMatterportHost(viewportBody || dashboard.viewportBody);

  async function handleMediaSaved(saved, context = {}) {
    const anchor = getMultisetAnchor();
    const previewUrl = context.previewUrl;
    let index = -1;
    try {
      if (saved?.id) markMediaLocalWrite(saved.id);
      dashboard.openPanel('media');
      applySceneLayers('media');
      index = await applySavedMediaRow(saved, anchor, { previewUrl });
      mediaPanel.refresh({ fly: false });
      if (index >= 0) {
        mediaPanel.selectByIndex(index, { fly: true });
        if (!getMediaObjects()[index]?.root) {
          if (previewUrl) mediaData[index]._previewUrl = previewUrl;
          await remountMediaItem(index, anchor);
          mediaPanel.selectByIndex(index, { fly: false });
        }
      }
      dashboard.refreshStats('media');
    } catch (err) {
      console.error('[media] scene refresh failed:', err);
      statusBar.show(t('main.media.savedReloadingPreview'), 'loading');
      try {
        await hydrateMediaFromSupabase();
        const anchorRetry = getMultisetAnchor();
        if (anchorRetry) {
          setMediaGroupVisible(true);
          await refreshMediaGroup(anchorRetry);
        }
        mediaPanel.refresh({ fly: false });
        dashboard.refreshStats('media');
        statusBar.show(t('main.media.previewUpdated'), 'success');
        setTimeout(() => statusBar.hide(), 2200);
      } catch (retryErr) {
        console.error(retryErr);
        statusBar.show(t('main.media.savedPreviewMissing'), 'error');
      }
    } finally {
      if (index >= 0 && mediaData[index]) {
        delete mediaData[index]._previewUrl;
      }
      if (previewUrl && saved?.media_type !== 'video') {
        URL.revokeObjectURL(previewUrl);
      }
    }
  }

  function startPlaceMediaOnMap() {
    if (!featureGates.media) {
      statusBar.show(t('main.media.disabledForProject'), 'error');
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }
    dashboard.openPanel('media');
    mediaPanel.deselect?.();
    detachGizmo();
    sceneToolbar.setMode('default');
    setSceneInteractionMode('add-media');
    statusBar.show(t('main.media.clickToPlace'), 'loading');
    setTimeout(() => statusBar.hide(), 2800);
  }

  function startPlaceTreasureOnMap(kind = 'treasure') {
    if (!featureGates.treasure) {
      statusBar.show(t('main.treasure.disabledForProject'), 'error');
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }
    treasurePlaceMode = kind;
    if (kind === 'hint') {
      // Do not reopen/deselect the treasure panel — that cleared the selection before.
      detachGizmo();
      sceneToolbar.setMode('default');
      setSceneInteractionMode('add-treasure');
      statusBar.show(t('main.treasure.clickToPlaceHint'), 'loading');
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }
    dashboard.openPanel('treasure');
    treasurePanel.deselect?.();
    detachGizmo();
    sceneToolbar.setMode('default');
    setSceneInteractionMode('add-treasure');
    const msg =
      kind === 'task-dest'
        ? t('main.treasure.clickToSetTaskDest')
        : kind === 'token'
          ? t('main.treasure.clickToPlaceToken')
          : t('main.treasure.clickToPlace');
    statusBar.show(msg, 'loading');
    setTimeout(() => statusBar.hide(), 2800);
  }

  sceneToolbar = createSceneToolbar(sceneOverlay, {
    onToolActivate: (mode, panelId) => {
      if (panelId) dashboard.openPanel(panelId);
      stopStairsDraw();
    },
    onModeChange: (mode) => {
      if (
        mode === 'add-poi' ||
        mode === 'add-facility' ||
        mode === 'add-media' ||
        mode === 'walk' ||
        mode === 'draw-block'
      ) {
        detachGizmo();
        if (mode === 'add-media') mediaPanel.deselect?.();
        if (mode === 'add-poi') poiPanel.deselect?.();
        if (mode === 'add-facility') facilityPanel.deselect?.();
        if (mode === 'draw-block') blockPanel.deselect?.();
      }
      if (mode !== 'draw-block') {
        cancelBlockDraw();
      }
      if (mode !== 'default') stopStairsDraw();
      setSceneInteractionMode(mode);
      setMatterportToolMode(mode);
      syncMatterportMoveSelection();

      if (mode === 'walk') {
        // Matterport: Go-to opens Showcase walkthrough (inside), not mesh navmesh.
        if (isMatterportMapActive() || projectUsesMatterportMap()) {
          matterportMoveDismissedKey = null;
          setMatterportMoveTarget(null);
          void matterportSetViewMode('inside').then((result) => {
            if (result?.ok) {
              statusBar.show(t('main.walkthrough.navigateSpace'), 'success');
            } else {
              statusBar.show(result?.error || t('main.walkthrough.openFailed'), 'error');
            }
            setTimeout(() => statusBar.hide(), 2600);
          });
          // Exit tool mode so Showcase receives pointer events immediately.
          sceneToolbar.setMode('default');
          setSceneInteractionMode('default');
          setMatterportToolMode('default');
          setMpModeActive?.('inside');
          return;
        }
        statusBar.show(t('main.goto.preparing'), 'loading');
        prepareGotoWalkable({
          count: 500,
          onProgress: (msg) => statusBar.show(msg, 'loading'),
        }).then((result) => {
          if (!result.ok) {
            statusBar.show(result.error || t('main.goto.walkableMeshFailed'), 'error');
            setTimeout(() => statusBar.hide(), 3600);
            return;
          }
          statusBar.show(
            t('main.goto.ready', { count: result.count }),
            'success',
          );
          setTimeout(() => statusBar.hide(), 2600);
        });
        return;
      }

      if (isMatterportMapActive()) {
        if (mode === 'add-poi') {
          statusBar.show(t('main.addPoi.movePinThenClick'), 'loading');
          void ensureBackgroundNavMeshForPlacement({ silent: true });
        } else if (mode === 'add-facility') {
          statusBar.show(t('main.addFacility.movePinThenClick'), 'loading');
        } else if (mode === 'add-media') {
          statusBar.show(t('main.addMedia.movePinThenClick'), 'loading');
        }
        setTimeout(() => statusBar.hide(), 2400);
      } else if (mode === 'add-poi') {
        void ensureBackgroundNavMeshForPlacement({ silent: true });
      }
    },
    onCancel: () => {
      hidePlacementPreview();
      cancelBlockDraw();
      stopStairsDraw();
      setSceneInteractionMode('default');
      setMatterportToolMode('default');
    },
  });

  window.addEventListener('spacecheck-scene-tool-cancel', () => {
    hidePlacementPreview();
    cancelBlockDraw();
    stopStairsDraw();
    sceneToolbar.setMode('default');
    setMatterportToolMode('default');
  });

  async function handleScenePlacementClick(pt, mode) {
    if (mode === 'walk') {
      // Space-map projects: never fall through to mesh Go-to / navmesh snap.
      if (isMatterportMapActive() || projectUsesMatterportMap()) {
        if (!isMatterportMapActive()) {
          statusBar.show(t('main.space3d.openFirst'), 'error');
          setTimeout(() => statusBar.hide(), 2400);
          return;
        }
        const result = await matterportGoToPoint(pt);
        if (!result.ok) {
          statusBar.show(result.error || t('main.goto.failed'), 'error');
          setTimeout(() => statusBar.hide(), 2400);
        }
        return;
      }
      let dest = snapGotoToWalkable(pt);
      if (!dest) {
        // Lazy-prepare if user clicked before sampling finished.
        const prep = await prepareGotoWalkable({ count: 500 });
        if (prep.ok) dest = snapGotoToWalkable(pt);
      }
      if (!dest) {
        statusBar.show(t('main.goto.noWalkablePoint'), 'error');
        setTimeout(() => statusBar.hide(), 2400);
        return;
      }
      const pose = walkPoseFromPoint(dest);
      flyTo(pose.endPos.x, dest.y, pose.endPos.z, {
        walk: true,
        endPos: pose.endPos,
        endTarget: pose.endTarget,
        speed: 0.05,
      });
      return;
    }
    if (mode === 'add-poi') {
      hidePlacementPreview();
      dashboard.openPanel('pois');
      sceneToolbar.setMode('default');
      setSceneInteractionMode('default');
      setMatterportToolMode('default');

      const applySnap = (snapped, fromClick) => {
        // Navigation / moved point = snapped walkable XYZ (Matterport raises Y slightly).
        const poiY = isMatterportMapActive()
          ? Number(snapped.y) + 0.3
          : snapped.y;
        const placed = { x: Number(snapped.x), y: Number(poiY), z: Number(snapped.z) };
        // Expected = exact click, always (never overwrite with the nav snap).
        const expected = {
          x: Number(fromClick.x),
          y: Number(fromClick.y),
          z: Number(fromClick.z),
        };
        const normal = fromClick?.normal && Number.isFinite(Number(fromClick.normal.x))
          ? {
              x: Number(fromClick.normal.x),
              y: Number(fromClick.normal.y),
              z: Number(fromClick.normal.z),
            }
          : { x: 0, y: 1, z: 0 };
        const movedOffMesh =
          Math.hypot(
            Number(snapped.x) - Number(fromClick.x),
            Number(snapped.z) - Number(fromClick.z),
          ) > 0.35;
        poiPanel.openAddDialog({
          x: placed.x,
          y: placed.y,
          z: placed.z,
          expected,
          normal,
          name: '',
        });
        if (movedOffMesh) {
          statusBar.show(t('main.addPoi.movedOntoNavMesh'), 'success');
          setTimeout(() => statusBar.hide(), 2200);
        } else {
          statusBar.hide();
        }
      };

      // Open immediately so the UI never hangs waiting on navmesh bake/import.
      if (hasNavMesh()) {
        const snapped = snapPlacementToNavMesh(pt) || pt;
        applySnap(snapped, pt);
        return;
      }
      poiPanel.openAddDialog({
        x: pt.x,
        y: isMatterportMapActive() ? Number(pt.y) + 0.3 : pt.y,
        z: pt.z,
        expected: { x: pt.x, y: pt.y, z: pt.z },
        normal: pt?.normal && Number.isFinite(Number(pt.normal.x))
          ? { x: Number(pt.normal.x), y: Number(pt.normal.y), z: Number(pt.normal.z) }
          : { x: 0, y: 1, z: 0 },
        name: '',
      });
      statusBar.show(t('main.addPoi.refiningOntoMesh'), 'loading');
      void snapPointOntoNavMesh(pt).then((snapped) => {
        applySnap(snapped || pt, pt);
      });
      return;
    }
    if (mode === 'add-facility') {
      hidePlacementPreview();
      dashboard.openPanel('facilities');
      facilityPanel.openAddDialog({ x: pt.x, y: pt.y, z: pt.z, name: '' });
      sceneToolbar.setMode('default');
      setSceneInteractionMode('default');
      setMatterportToolMode('default');
      return;
    }
    if (mode === 'add-media') {
      hidePlacementPreview();
      dashboard.openPanel('media');
      openMediaModal({
        placement: { x: pt.x, y: pt.y, z: pt.z },
        onSaved: (saved, context) => handleMediaSaved(saved, context),
      });
      sceneToolbar.setMode('default');
      setSceneInteractionMode('default');
      setMatterportToolMode('default');
      return;
    }
    if (mode === 'add-treasure') {
      hidePlacementPreview();
      const placement = { x: pt.x, y: pt.y, z: pt.z };
      if (treasurePlaceMode === 'hint') {
        await treasurePanel.applyHintPlacement(placement);
      } else {
        dashboard.openPanel('treasure');
        if (treasurePlaceMode === 'task-dest') {
          treasurePanel.applyTaskDestination(placement);
        } else if (treasurePlaceMode === 'token') {
          treasurePanel.openNewTokenAt(placement);
        } else {
          treasurePanel.openNewTreasureAt(placement);
        }
      }
      treasurePlaceMode = null;
      sceneToolbar.setMode('default');
      setSceneInteractionMode('default');
      setMatterportToolMode('default');
    }
  }

  setOnSceneMapClick(handleScenePlacementClick);
  setMatterportPlaceHandler(handleScenePlacementClick);

  const mapModeSelect = dashboard.element.querySelector('#map-display-mode');
  const mapMeshQualitySelect = dashboard.element.querySelector('#map-mesh-quality');

  let sessionToken = null;
  let mapLoader = null;
  let mapMeshLoading = false;
  let activeMeshQuality = 'raw';
  let mapLoadGeneration = 0;
  let splatMapMode = false;

  function setMapQualityUiEnabled(enabled) {
    if (!mapMeshQualitySelect) return;
    mapMeshQualitySelect.disabled = !enabled;
    const wrap = mapMeshQualitySelect.closest('.viewport-map-style');
    if (wrap) wrap.classList.toggle('hidden', !enabled);
  }

  function beginMapMeshLoad() {
    mapLoadGeneration += 1;
    cancelLazyMapTextures();
    return mapLoadGeneration;
  }

  function isMapMeshLoadCurrent(loadId) {
    return loadId === mapLoadGeneration;
  }

  async function refreshOverlayGroups() {
    const anchor = getMultisetAnchor();
    if (anchor) {
      refreshPOIGroup(anchor);
      refreshFacilityGroup(anchor);
      await refreshMediaGroup(anchor);
      await refreshTreasureGroup(anchor);
      refreshBlockGroup(anchor);
    }
    if (isMatterportMapActive()) {
      try {
        await syncMatterportEntityTags({
          pois: poisData,
          facilities: facilitiesData,
          media: mediaData,
        });
      } catch (err) {
        console.warn('[matterport] tag sync', err);
      }
      syncMatterportMoveSelection();
    }
  }

  async function loadSplatAsMap(statusMessage = t('main.splatMap.loading'), loadId = null) {
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      return { ok: false, aborted: true };
    }
    const splatItems = getActiveSplatMaps();
    if (!splatItems.length) return { ok: false, error: t('main.splatMap.noFilesUploaded') };
    setMatterportMeshCompositor(false);
    clearMatterportMap();
    statusBar.show(statusMessage, 'loading');
    clearNavMesh();
    clearWalkableGotoPoints();
    syncNavmeshBtn(false);
    syncDollhouseBtn();
    const result = await addSplatMap(splatItems, {
      frameCamera: 'origin',
      onProgress: (msg) => {
        if (loadId != null && !isMapMeshLoadCurrent(loadId)) return;
        statusBar.show(msg, 'loading');
      },
    });
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      return { ok: false, aborted: true };
    }
    if (!result.ok) return result;
    await refreshOverlayGroups();
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      return { ok: false, aborted: true };
    }
    splatMapMode = true;
    setMapQualityUiEnabled(false);
    return result;
  }

  async function loadGeometricMeshUnderMatterport(loadId = null) {
    if (!sessionToken || !getMapCode()) return { ok: false, skipped: true };
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      return { ok: false, aborted: true };
    }
    const meshResult = await loadRawMapMesh(
      sessionToken,
      getMapCode(),
      {
        ...createMapLoadCallbacks({
          statusBar,
          isActive: () => loadId == null || isMapMeshLoadCurrent(loadId),
        }),
        frameCamera: false,
      },
    );
    return meshResult;
  }

  async function loadMatterportAsMap(statusMessage = t('main.space3d.loading'), loadId = null, opts = {}) {
    const url = getActiveMatterportUrl();
    if (!url) return { ok: false, error: t('main.space3d.noLinkSaved') };
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      return { ok: false, aborted: true };
    }
    statusBar.show(statusMessage, 'loading');
    clearNavMesh();
    clearWalkableGotoPoints();
    syncNavmeshBtn(false);
    splatMapMode = false;
    setMapQualityUiEnabled(false);
    // Transparent Three.js layer immediately so the photoreal view is never covered.
    setMatterportMeshCompositor(true);
    const result = await loadMatterportMap(url, {
      onStatus: (msg, kind) => {
        if (loadId != null && !isMapMeshLoadCurrent(loadId)) return;
        statusBar.show(msg, kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'loading');
      },
    });
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      clearMatterportMap();
      setMatterportMeshCompositor(false);
      return { ok: false, aborted: true };
    }
    if (result?.aborted) {
      clearMatterportMap();
      setMatterportMeshCompositor(false);
      return { ok: false, aborted: true };
    }

    // Showcase is playable — start User guide here (don’t wait for raw mesh download).
    if ((result?.ok || result?.browsingOnly) && typeof opts.onShowcaseReady === 'function') {
      try {
        opts.onShowcaseReady();
      } catch (err) {
        console.warn('[tour] onShowcaseReady failed', err);
      }
    }

    // Pin POI names as soon as Showcase is ready — don't wait for the underlay mesh.
    try {
      await syncMatterportEntityTags({
        pois: poisData,
        facilities: facilitiesData,
        media: mediaData,
      });
    } catch (err) {
      console.warn('[space-map] early tag sync', err);
    }
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      clearMatterportMap();
      setMatterportMeshCompositor(false);
      return { ok: false, aborted: true };
    }

    try {
      await loadGeometricMeshUnderMatterport(loadId);
    } catch (err) {
      console.warn('[space-map] geometric mesh overlay failed', err);
    }
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      clearMatterportMap();
      setMatterportMeshCompositor(false);
      return { ok: false, aborted: true };
    }
    setMatterportMeshCompositor(true);
    // Build walkable navmesh from the geometric underlay (hidden) so POI
    // placement can snap onto it while Showcase stays visible.
    void ensureBackgroundNavMeshForPlacement({ silent: true, force: true });
    // Refresh Three.js overlays + re-assert tags after underlay settles.
    await refreshOverlayGroups();
    if (loadId != null && !isMapMeshLoadCurrent(loadId)) {
      clearMatterportMap();
      setMatterportMeshCompositor(false);
      return { ok: false, aborted: true };
    }
    try {
      await syncMatterportEntityTags({
        pois: poisData,
        facilities: facilitiesData,
        media: mediaData,
      });
    } catch (err) {
      console.warn('[space-map] tag sync', err);
    }
    syncDollhouseBtn();
    return result.ok || result.browsingOnly
      ? { ok: true, browsingOnly: Boolean(result.browsingOnly), error: result.error }
      : result;
  }

  /**
   * Astra-style: raw first, textured on demand (raw stays visible while textured downloads).
   * @param {'raw'|'textured'} quality
   */
  async function reloadMapMesh(quality) {
    if (projectUsesMatterportMap() || isMatterportMapActive()) {
      const loadId = beginMapMeshLoad();
      const result = await loadMatterportAsMap(t('main.space3d.reloading'), loadId);
      if (!isMapMeshLoadCurrent(loadId) || result.aborted) return;
      if (!result.ok) {
        statusBar.show(result.error || t('main.space3d.unavailable'), 'error');
        setTimeout(() => statusBar.hide(), 3200);
        return;
      }
      statusBar.show(
        result.browsingOnly
          ? t('main.space3d.openWhitelistDomain')
          : t('main.space3d.ready'),
        result.browsingOnly ? 'error' : 'success',
      );
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }

    if (splatMapMode || projectUsesSplatMap()) {
      const loadId = beginMapMeshLoad();
      const result = await loadSplatAsMap(t('main.splatMap.reloading'), loadId);
      if (!isMapMeshLoadCurrent(loadId) || result.aborted) return;
      if (!result.ok) {
        statusBar.show(result.error || t('main.splatMap.unavailable'), 'error');
        setTimeout(() => statusBar.hide(), 3200);
        return;
      }
      const skipNote =
        result.skippedOversized > 0
          ? t('main.splatMap.skipNoteTooLarge', { count: result.skippedOversized })
          : result.failed
            ? t('main.splatMap.skipNoteSkipped', { count: result.failed })
            : '';
      const fileWord = result.count === 1 ? t('main.splatMap.fileSingular') : t('main.splatMap.filePlural');
      statusBar.show(
        t('main.splatMap.readyWithCount', { count: result.count, fileWord, skipNote }),
        'success',
      );
      setTimeout(() => statusBar.hide(), 2400);
      return;
    }

    if (!sessionToken || !getMapCode()) return;

    const preferTextured = quality === 'textured';
    const loadId = beginMapMeshLoad();
    mapMeshLoading = true;
    if (mapMeshQualitySelect) mapMeshQualitySelect.disabled = true;

    try {
      const callbacks = createMapLoadCallbacks({
        statusBar,
        isActive: () => isMapMeshLoadCurrent(loadId),
      });
      const loaderFn = preferTextured ? loadTexturedMapMesh : loadRawMapMesh;
      // Switching back to raw clears plan cache only when forcing a fresh raw pass
      if (!preferTextured) clearMapMeshLoaderCache();

      const result = await loaderFn(sessionToken, getMapCode(), callbacks);
      if (!isMapMeshLoadCurrent(loadId)) return;

      if (!result.ok) {
        statusBar.show(result.error || t('main.mapMesh.unavailableForQuality'), 'error');
        if (mapMeshQualitySelect) mapMeshQualitySelect.value = activeMeshQuality;
        setTimeout(() => statusBar.hide(), 3500);
        return;
      }

      await refreshOverlayGroups();
      if (!isMapMeshLoadCurrent(loadId)) return;

      const navSetup = await buildNavigationSetup();
      if (!isMapMeshLoadCurrent(loadId)) return;
      if (!navSetup.ok) {
        console.warn('[navigation]', navSetup.error);
        statusBar.show(
          navSetup.error || t('main.navigation.unavailableStillEditable'),
          'error',
        );
        setTimeout(() => statusBar.hide(), 3500);
      }
      syncNavigationToLatestPoi();
      setNavigationVisualVisible(false);
      syncNavToggleBtn();

      activeMeshQuality = result.quality === 'textured' ? 'textured' : 'raw';
      if (mapMeshQualitySelect) mapMeshQualitySelect.value = activeMeshQuality;

      if (navSetup.ok) {
        statusBar.show(
          activeMeshQuality === 'textured'
            ? t('main.mapMesh.texturedReady')
            : t('main.mapMesh.rawReady'),
          'success',
        );
        setTimeout(() => statusBar.hide(), 2800);
      }
    } catch (err) {
      console.error(err);
      statusBar.show(err.message || t('main.mapMesh.reloadFailed'), 'error');
      if (mapMeshQualitySelect) mapMeshQualitySelect.value = activeMeshQuality;
    } finally {
      if (isMapMeshLoadCurrent(loadId)) {
        mapMeshLoading = false;
        if (mapMeshQualitySelect) mapMeshQualitySelect.disabled = false;
      }
    }
  }

  mapMeshQualitySelect?.addEventListener('change', () => {
    const next = mapMeshQualitySelect.value === 'textured' ? 'textured' : 'raw';
    if (next === activeMeshQuality) return;
    reloadMapMesh(next);
  });

  mapModeSelect?.addEventListener('change', async () => {
    const v = mapModeSelect.value;
    if (v === 'heatmap') {
      clearUserHeatmap();
      if (!getPoiType()) {
        statusBar.show(t('main.heatMap.signInToLoad'), 'error');
        setTimeout(() => statusBar.hide(), 2500);
        mapModeSelect.value = 'shaded';
        setMapDisplayMode('shaded');
        return;
      }
      setMapDisplayMode('heatmap');
      if (!isSupabaseConfigured()) {
        statusBar.show(t('main.heatMap.configureDbToLoad'), 'error');
        setTimeout(() => statusBar.hide(), 2500);
        mapModeSelect.value = 'shaded';
        setMapDisplayMode('shaded');
        return;
      }
      statusBar.show(t('main.heatMap.loadingCombined'), 'loading');
      try {
        const points = await fetchNavnodesForHeatmap();
        if (!points.length) {
          statusBar.show(t('main.heatMap.noNavnodeData', { poiType: getPoiType() || t('main.common.unknown') }), 'error');
          setTimeout(() => statusBar.hide(), 2500);
          mapModeSelect.value = 'shaded';
          setMapDisplayMode('shaded');
          clearGlobalHeatmap();
          void clearMatterportHeatmapOverlay();
          return;
        }
        if (isMatterportMapActive()) {
          const prep = await prepareMatterportHeatOverlays(t('main.heatMap.loading'));
          if (!prep.ok) {
            throw new Error(prep.error || t('main.heatMap.failed'));
          }
          const overlay = await setMatterportHeatmapOverlay(points);
          if (!overlay.ok) {
            throw new Error(overlay.error || t('main.heatMap.overlayFailed'));
          }
        } else {
          showGlobalHeatmap(points);
        }
        dashboard.openPanel('users');
        userPanel.setMode('heatmap');
        statusBar.show(t('main.heatMap.pointsCountAllUsers', { count: points.length }), 'success');
        setTimeout(() => statusBar.hide(), 3200);
      } catch (err) {
        console.error(err);
        clearGlobalHeatmap();
        void clearMatterportHeatmapOverlay();
        statusBar.show(err.message || t('main.heatMap.failedToLoad'), 'error');
        setTimeout(() => statusBar.hide(), 2500);
        mapModeSelect.value = 'shaded';
        setMapDisplayMode('shaded');
      }
      return;
    }
    clearGlobalHeatmap();
    void clearMatterportHeatmapOverlay();
    if (isMatterportMapActive()) {
      setMatterportDollhouseMeshOverlay(false);
      resetMatterportMapAlign();
    }
    setMapDisplayMode('shaded');
  });

  sceneToolbar.setMode('default');
  applySceneLayers('pois');

  /** Active project feature gates (editor nav + map layers). */
  let featureGates = {
    facilities: true,
    blocks: true,
    users: true,
    treasure: true,
    media: true,
    guidedTours: true,
  };

  function setSceneToolLocked(mode, locked) {
    if (typeof sceneToolbar?.setToolLocked === 'function') {
      sceneToolbar.setToolLocked(mode, locked);
      return;
    }
    // Fallback if toolbar API is missing: keep visible, mute via class.
    const isLocked = Boolean(locked);
    document.querySelectorAll(`.scene-tool-btn[data-mode="${mode}"]`).forEach((btn) => {
      btn.hidden = false;
      btn.style.removeProperty('display');
      btn.classList.toggle('is-locked', isLocked);
      btn.dataset.locked = isLocked ? '1' : '0';
      if (isLocked) {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
        if (sceneToolbar?.getMode?.() === mode) {
          sceneToolbar.setMode('default');
        }
      }
    });
    sceneToolbar?.layout?.();
  }

  /**
   * Apply navme_project_features to sidebar + map + scene tools.
   * Superadmin session bypasses gates (sees everything).
   * @param {Record<string, unknown> | null} featureRow
   * @param {{ bypass?: boolean }} [opts]
   */
  function applyProjectFeatureGates(featureRow, opts = {}) {
    // Only bypass when browsing a project from /access (superadmin session present).
    // Normal project_admin / sub_admin logins must honor feature flags.
    const bypass = Boolean(opts.bypass) || hasSuperadminSession();
    if (bypass) {
      featureGates = {
        facilities: true,
        blocks: true,
        users: true,
        treasure: true,
        media: true,
        guidedTours: true,
      };
    } else {
      const row = featureRow ?? {};
      featureGates = {
        facilities: parseDbBool(row.facilities, false),
        blocks: parseDbBool(row.block_enabled, true),
        users:
          parseDbBool(row.people_search, false) || parseDbBool(row.save_location, false),
        treasure: parseDbBool(row.treasure, false),
        media: parseDbBool(row.custom_media, true),
        guidedTours: parseDbBool(row.guided_tours, false),
      };
    }

    dashboard.setSidebarPanelLocked?.('facilities', !featureGates.facilities);
    dashboard.setSidebarPanelLocked?.('guided-tours', !featureGates.guidedTours);
    dashboard.setSidebarPanelLocked?.('blocks', !featureGates.blocks);
    dashboard.setSidebarPanelLocked?.('users', !featureGates.users);
    dashboard.setSidebarPanelLocked?.('treasure', !featureGates.treasure);
    dashboard.setSidebarPanelLocked?.('media', !featureGates.media);
    // Admins nav is role-based (never for sub-admins), not a project feature flag.
    dashboard.syncTeamNavVisibility?.();

    const gmapEnabled = bypass && parseDbBool((featureRow ?? {}).navme_gmap_enabled, false);
    dashboard.setSidebarPanelVisible?.('gmap', gmapEnabled);
    if (!gmapEnabled) gmapPanel.hide();

    setSceneToolLocked('add-facility', !featureGates.facilities);
    setSceneToolLocked('draw-block', !featureGates.blocks);
    setSceneToolLocked('add-media', !featureGates.media);
    // Stairs draw lives under blocks feature.
    setSceneToolLocked('draw-stairs', !featureGates.blocks);

    if (!featureGates.facilities) {
      setFacilityGroupVisible(false);
      facilityPanel.hide();
    }
    if (!featureGates.guidedTours) {
      guidedTourPanel.hide();
    }
    if (!featureGates.blocks) {
      setBlocksVisible(false);
      blockPanel.hide();
      stairsPanel.hide();
      stopStairsDraw();
    }
    if (!featureGates.treasure) {
      setTreasureGroupVisible(false);
      treasurePanel.hide();
    }
    if (!featureGates.users) {
      clearAllMarkers();
      clearUserHeatmap();
      clearHistoryRoute();
      userPanel.hide();
    }
    if (!featureGates.media) {
      setMediaGroupVisible(false);
      mediaPanel.hide();
    }

    applySceneLayers(dashboard.getEditorMode?.() || 'pois');
  }

  /**
   * Show only the 3D layer that matches the active sidebar panel.
   * Disabled feature flags keep those layers hidden even if that panel is somehow active.
   * @param {'pois' | 'facilities' | 'media' | 'treasure' | 'users' | 'blocks' | 'stairs'} panelId
   */
  function applySceneLayers(panelId) {
    // Matterport owns POI/facility markers via Showcase tags — keep Three.js billboards off.
    if (isMatterportMapActive()) {
      setMatterportSceneMarkersVisible(false);
      // Showcase tags are the POI/amenity/media markers here — filter them to the
      // active panel the same way the Three.js groups are filtered below.
      void setMatterportEntityKindsVisible({
        poi: panelId === 'pois' || panelId === 'guided-tours',
        facility: panelId === 'facilities' && featureGates.facilities,
        media: panelId === 'media' && featureGates.media,
      });
      setMediaGroupVisible(panelId === 'media' && featureGates.media);
      setBlocksVisible(
        (panelId === 'blocks' || panelId === 'stairs') && featureGates.blocks,
      );
      if (panelId === 'blocks') setBlockLayerFilter('zones');
      else if (panelId === 'stairs') setBlockLayerFilter('stairs');
      else setBlockLayerFilter('all');
      if (panelId === 'profile' || panelId === 'users') {
        setMediaGroupVisible(false);
        setBlocksVisible(false);
      }
      return;
    }
    setPOIGroupVisible(panelId === 'pois' || panelId === 'guided-tours');
    setFacilityGroupVisible(panelId === 'facilities' && featureGates.facilities);
    setMediaGroupVisible(panelId === 'media' && featureGates.media);
    setTreasureGroupVisible(panelId === 'treasure' && featureGates.treasure);
    const showBlocks =
      (panelId === 'blocks' || panelId === 'stairs') && featureGates.blocks;
    setBlocksVisible(showBlocks);
    if (panelId === 'blocks') {
      setBlockLayerFilter('zones');
    } else if (panelId === 'stairs') {
      setBlockLayerFilter('stairs');
    } else {
      setBlockLayerFilter('all');
    }
    if (panelId === 'users' || panelId === 'profile') {
      setPOIGroupVisible(false);
      setFacilityGroupVisible(false);
      setMediaGroupVisible(false);
      setTreasureGroupVisible(false);
      setBlocksVisible(false);
    }
  }

  const navmeshBtn = dashboard.element.querySelector('#btn-show-navmesh');
  const navToggleBtn = dashboard.element.querySelector('#btn-toggle-navigation');
  const routePlannerBtn = dashboard.element.querySelector('#btn-route-planner');
  // Route planning is Matterport-only: the overlay it draws into lives there.
  const routePlanner = createRoutePlanner(
    dashboard.element.querySelector('#viewport') ?? dashboard.element,
    routePlannerBtn,
  );
  const geometricMeshBtn = dashboard.element.querySelector('#btn-geometric-mesh');
  /** @type {HTMLElement | null} */
  let mpModesEl = null;
  /** @type {HTMLElement | null} */
  let mpFloorsEl = null;
  /** @type {HTMLElement[]} */
  let mpModeBtns = [];
  /** @type {HTMLButtonElement | null} */
  let mpFurnitureBtn = null;
  let mpModeClicksBound = false;
  /** @type {(() => void) | null} */
  let stopMpModeWatch = null;
  /** @type {(() => void) | null} */
  let stopMpFloorWatch = null;
  /** @type {number | null} */
  let mpActiveFloorSeq = null;
  let stairsDrawActive = false;

  function ensureMpModesToolbar() {
    const body = dashboard.viewportBody || dashboard.element.querySelector('#viewport-body');
    // Drop any old top-bar copy from earlier builds.
    dashboard.element
      .querySelector('.viewport-map-controls--leading > #viewport-mp-modes')
      ?.remove();

    let el = /** @type {HTMLElement | null} */ (
      body?.querySelector('#viewport-mp-modes') || dashboard.element.querySelector('#viewport-mp-modes')
    );
    if (!el && body) {
      el = document.createElement('div');
      el.id = 'viewport-mp-modes';
      el.className = 'viewport-mp-modes matterport-scene-tools float-glass chrome-layer';
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-label', t('main.mpTools.ariaLabel'));
      el.hidden = true;
      el.innerHTML = `
        <button type="button" class="matterport-scene-tool-btn" id="btn-mp-dollhouse" data-mp-mode="dollhouse" title="${t('main.mpTools.dollhouse')}" aria-label="${t('main.mpTools.dollhouse')}" aria-pressed="false">
          <span class="viewport-accessibility-icon">${iconDollhouse()}</span>
        </button>
        <button type="button" class="matterport-scene-tool-btn" id="btn-mp-floorplan" data-mp-mode="floorplan" title="${t('main.mpTools.floorPlan')}" aria-label="${t('main.mpTools.floorPlan')}" aria-pressed="false">
          <span class="viewport-accessibility-icon">${iconFloorPlan()}</span>
        </button>
        <button type="button" class="matterport-scene-tool-btn" id="btn-mp-explore" data-mp-mode="inside" title="${t('main.mpTools.walk')}" aria-label="${t('main.mpTools.walkThroughSpace')}" aria-pressed="false">
          <span class="viewport-accessibility-icon">${iconExploreSpace()}</span>
        </button>
        <button type="button" class="matterport-scene-tool-btn" id="btn-mp-furniture" data-mp-action="defurnish" title="${t('main.mpTools.hideFurniture')}" aria-label="${t('main.mpTools.hideFurniture')}" aria-pressed="false" hidden>
          <span class="viewport-accessibility-icon">${iconHideFurniture()}</span>
        </button>
      `;
      body.appendChild(el);
    } else if (el && body && el.parentElement !== body) {
      body.appendChild(el);
    }

    // Ensure furniture button exists on older injected toolbars.
    if (el && !el.querySelector('#btn-mp-furniture')) {
      const furniture = document.createElement('button');
      furniture.type = 'button';
      furniture.className = 'matterport-scene-tool-btn';
      furniture.id = 'btn-mp-furniture';
      furniture.setAttribute('data-mp-action', 'defurnish');
      furniture.title = t('main.mpTools.hideFurniture');
      furniture.setAttribute('aria-label', t('main.mpTools.hideFurniture'));
      furniture.setAttribute('aria-pressed', 'false');
      furniture.hidden = true;
      furniture.innerHTML = `<span class="viewport-accessibility-icon">${iconHideFurniture()}</span>`;
      el.appendChild(furniture);
    }

    // Icon-only: strip leftover labels from older markup.
    el?.querySelectorAll('.viewport-accessibility-label').forEach((node) => node.remove());
    el?.classList.add('matterport-scene-tools', 'float-glass', 'chrome-layer');

    mpModesEl = el;
    mpModeBtns = Array.from(el?.querySelectorAll('[data-mp-mode]') || []);
    mpFurnitureBtn = /** @type {HTMLButtonElement | null} */ (el?.querySelector('#btn-mp-furniture'));

    if (!mpModeClicksBound && el) {
      mpModeClicksBound = true;
      for (const btn of mpModeBtns) {
        btn.addEventListener('click', async () => {
          const modeKey = btn.getAttribute('data-mp-mode');
          if (!modeKey || !isMatterportMapActive()) {
            statusBar.show(t('main.space3d.openFirst'), 'error');
            setTimeout(() => statusBar.hide(), 2800);
            return;
          }
          for (const b of mpModeBtns) b.disabled = true;
          if (mpFurnitureBtn) mpFurnitureBtn.disabled = true;
          const result = await matterportSetViewMode(
            /** @type {'dollhouse' | 'floorplan' | 'inside'} */ (modeKey),
          );
          for (const b of mpModeBtns) b.disabled = false;
          if (mpFurnitureBtn) mpFurnitureBtn.disabled = false;
          if (!result.ok) {
            statusBar.show(result.error || t('main.mpTools.switchViewFailed'), 'error');
            setTimeout(() => statusBar.hide(), 3200);
            return;
          }
          setMpModeActive(modeKey);
        });
      }
      mpFurnitureBtn?.addEventListener('click', async () => {
        if (!isMatterportMapActive()) return;
        mpFurnitureBtn.disabled = true;
        const result = await matterportToggleDefurnish();
        mpFurnitureBtn.disabled = false;
        if (!result.ok) {
          statusBar.show(result.error || t('main.mpTools.hideFurnitureUnavailable'), 'error');
          setTimeout(() => statusBar.hide(), 3200);
          return;
        }
        mpFurnitureBtn.classList.toggle('active', Boolean(result.active));
        mpFurnitureBtn.setAttribute('aria-pressed', result.active ? 'true' : 'false');
        mpFurnitureBtn.title = result.active ? t('main.mpTools.showFurniture') : t('main.mpTools.hideFurniture');
      });
    }
    return el;
  }

  function setMpModeActive(modeKey) {
    for (const btn of mpModeBtns) {
      const on = btn.getAttribute('data-mp-mode') === modeKey;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function ensureMpFloorsToolbar() {
    const body = dashboard.viewportBody || dashboard.element.querySelector('#viewport-body');
    let el = /** @type {HTMLElement | null} */ (
      body?.querySelector('#viewport-mp-floors') || dashboard.element.querySelector('#viewport-mp-floors')
    );
    if (!el && body) {
      el = document.createElement('div');
      el.id = 'viewport-mp-floors';
      el.className = 'viewport-mp-floors matterport-floor-tools float-glass chrome-layer';
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-label', t('main.mpFloors.ariaLabel'));
      el.hidden = true;
      el.innerHTML = `<div class="matterport-floor-list" id="viewport-mp-floor-list"></div>`;
      body.appendChild(el);
    } else if (el && body && el.parentElement !== body) {
      body.appendChild(el);
    }
    mpFloorsEl = el;
    return el;
  }

  function setMpFloorActive(sequence) {
    mpActiveFloorSeq = sequence == null ? null : Number(sequence);
    const list = mpFloorsEl?.querySelector('#viewport-mp-floor-list');
    if (!list) return;
    list.querySelectorAll('[data-mp-floor]').forEach((btn) => {
      const raw = btn.getAttribute('data-mp-floor');
      const isAll = raw === 'all';
      const on = isAll
        ? mpActiveFloorSeq === -1
        : Number(raw) === mpActiveFloorSeq;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderMpFloorButtons(floors, currentSequence) {
    ensureMpFloorsToolbar();
    const list = mpFloorsEl?.querySelector('#viewport-mp-floor-list');
    if (!list) return;

    // Single-floor spaces don't need All / 1 controls.
    if (!floors?.length || floors.length <= 1) {
      list.innerHTML = '';
      if (mpFloorsEl) {
        mpFloorsEl.hidden = true;
        mpFloorsEl.classList.remove('is-visible');
      }
      return;
    }

    const items = [
      { key: 'all', label: t('main.mpFloors.allLabel'), title: t('main.mpFloors.showAllFloors') },
      ...[...floors]
        .sort((a, b) => b.sequence - a.sequence)
        .map((f) => {
          const n = Number(f.sequence);
          const label = Number.isFinite(n) ? String(n + 1) : String(f.name || '?');
          return {
            key: String(n),
            label,
            title: f.name ? t('main.mpFloors.floorNamed', { name: f.name }) : t('main.mpFloors.floorNumbered', { label }),
          };
        }),
    ];

    list.innerHTML = items
      .map(
        (item) => `
        <button
          type="button"
          class="matterport-floor-btn"
          data-mp-floor="${item.key}"
          title="${item.title.replace(/"/g, '&quot;')}"
          aria-label="${item.title.replace(/"/g, '&quot;')}"
          aria-pressed="false"
        >${item.label}</button>`,
      )
      .join('');

    list.querySelectorAll('[data-mp-floor]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!isMatterportMapActive()) return;
        const raw = btn.getAttribute('data-mp-floor');
        const target = raw === 'all' ? 'all' : Number(raw);
        list.querySelectorAll('[data-mp-floor]').forEach((b) => {
          b.disabled = true;
        });
        const result = await matterportMoveToFloor(target);
        list.querySelectorAll('[data-mp-floor]').forEach((b) => {
          b.disabled = false;
        });
        if (!result.ok) {
          statusBar.show(result.error || t('main.mpFloors.switchFailed'), 'error');
          setTimeout(() => statusBar.hide(), 3200);
          return;
        }
        setMpFloorActive(result.sequence ?? (raw === 'all' ? -1 : Number(raw)));
      });
    });

    if (mpFloorsEl) {
      mpFloorsEl.hidden = false;
      mpFloorsEl.classList.add('is-visible');
    }
    setMpFloorActive(
      currentSequence == null || !Number.isFinite(Number(currentSequence))
        ? null
        : Number(currentSequence),
    );
  }

  async function refreshMpFloorsToolbar() {
    ensureMpFloorsToolbar();
    if (!isMatterportMapActive()) {
      if (mpFloorsEl) {
        mpFloorsEl.hidden = true;
        mpFloorsEl.classList.remove('is-visible');
      }
      return;
    }
    const result = await getMatterportFloors();
    if (!result.ok || !result.floors.length || result.floors.length <= 1) {
      if (mpFloorsEl) {
        mpFloorsEl.hidden = true;
        mpFloorsEl.classList.remove('is-visible');
        const list = mpFloorsEl.querySelector('#viewport-mp-floor-list');
        if (list) list.innerHTML = '';
      }
      return;
    }
    renderMpFloorButtons(result.floors, result.currentSequence);
  }

  function syncMatterportModeToolbar() {
    ensureMpModesToolbar();
    ensureMpFloorsToolbar();
    const on = isMatterportMapActive();
    // Keep Go-to visible — on Matterport it enters Showcase walkthrough.
    sceneToolbar?.setGotoVisible?.(true);
    if (mpModesEl) {
      mpModesEl.hidden = !on;
      mpModesEl.classList.toggle('is-visible', on);
    }
    for (const btn of mpModeBtns) btn.disabled = !on;
    if (mpFurnitureBtn) mpFurnitureBtn.disabled = !on;
    if (navmeshBtn) {
      if (on || !hasSuperadminSession()) {
        hideNavMeshVisualization();
        hideMatterportNavmeshOverlay();
        syncNavmeshBtn(false);
      } else {
        setMatterportMeshCompositor(false);
        hideMatterportNavmeshOverlay();
        syncNavmeshBtn(isNavMeshVisualizationVisible());
      }
    }
    syncGeometricMeshBtn();
    syncNavToggleBtn();
    syncMeshMoveBar();
    if (stopMpModeWatch) {
      stopMpModeWatch();
      stopMpModeWatch = null;
    }
    if (stopMpFloorWatch) {
      stopMpFloorWatch();
      stopMpFloorWatch = null;
    }
    onMatterportDefurnishChange(null);
    if (on) {
      stopMpModeWatch = onMatterportViewModeChange((modeKey) => {
        if (modeKey !== 'other') setMpModeActive(modeKey);
        if (modeKey !== 'dollhouse') leaveMatterportDollhouseOverlays();
        refreshMatterportAnnotOverlay();
      });
      onMatterportDefurnishChange((available, isActive) => {
        if (!mpFurnitureBtn) return;
        mpFurnitureBtn.hidden = !available;
        mpFurnitureBtn.classList.toggle('active', Boolean(isActive));
        mpFurnitureBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        mpFurnitureBtn.title = isActive ? t('main.mpTools.showFurniture') : t('main.mpTools.hideFurniture');
      });
      stopMpFloorWatch = onMatterportFloorChange((info) => {
        if (info.viewingAll) setMpFloorActive(-1);
        else if (info.sequence != null) setMpFloorActive(info.sequence);
      });
      void refreshMpFloorsToolbar();
      syncMatterportMoveSelection();
    } else {
      if (mpFurnitureBtn) mpFurnitureBtn.hidden = true;
      if (mpFloorsEl) {
        mpFloorsEl.hidden = true;
        mpFloorsEl.classList.remove('is-visible');
        const list = mpFloorsEl.querySelector('#viewport-mp-floor-list');
        if (list) list.innerHTML = '';
      }
      setMatterportMoveTarget(null);
      matterportNavPoiIndex = -1;
      void clearMatterportNavRouteOverlay();
      clearNavigationRoute();
    }
  }

  // Keep older call sites working
  function syncDollhouseBtn() {
    syncMatterportModeToolbar();
  }

  function syncNavToggleBtn() {
    const selectedIndex = poiPanel.getSelectedIndex?.() ?? -1;
    const hasSelectedPoi = selectedIndex >= 0 && selectedIndex < poisData.length;
    const active =
      isNavigationRouteVisible() ||
      (isMatterportMapActive() && matterportNavPoiIndex >= 0);
    // Superadmin-only: Show navigation / Clear navigation.
    if (navToggleBtn) {
      if (!hasSuperadminSession()) {
        navToggleBtn.hidden = true;
        navToggleBtn.style.display = 'none';
      } else {
        navToggleBtn.style.display = '';
        navToggleBtn.hidden = isMatterportMapActive() ? false : !(hasSelectedPoi || active);
      }
    }
    if (routePlannerBtn) {
      const showPlanner = hasSuperadminSession() && isMatterportMapActive();
      routePlannerBtn.hidden = !showPlanner;
      routePlannerBtn.style.display = showPlanner ? '' : 'none';
      // Leaving the Matterport view would strand an open panel over the 3D map.
      if (!showPlanner) routePlanner.close();
      else routePlanner.refresh();
    }
    const navLabel = navToggleBtn?.querySelector('[data-nav-toggle-label]');
    if (navLabel) navLabel.textContent = active ? t('dashboard.navigation.clearLabel') : t('dashboard.navigation.showLabel');
    navToggleBtn?.classList.toggle('active', active);
    navToggleBtn?.setAttribute('aria-pressed', active ? 'true' : 'false');
    navToggleBtn?.setAttribute(
      'title',
      active
        ? t('main.navigation.clearTitle')
        : t('main.navigation.navigateToSelectedPoi'),
    );
    navToggleBtn?.setAttribute(
      'aria-label',
      active
        ? t('main.navigation.clearRouteAriaLabel')
        : t('main.navigation.navigateToSelectedPoi'),
    );
    const iconHost = navToggleBtn?.querySelector('[data-nav-toggle-icon]');
    if (iconHost) iconHost.innerHTML = active ? iconNavigateOff() : iconNavigate();
  }

  function syncNavmeshBtn(visible) {
    const on = Boolean(visible);
    // Superadmin-only; MultiSet mesh maps only (not Matterport).
    if (navmeshBtn) {
      const show = hasSuperadminSession() && !isMatterportMapActive();
      navmeshBtn.hidden = !show;
      navmeshBtn.style.display = show ? '' : 'none';
      if (!show && on) {
        hideNavMeshVisualization();
        hideMatterportNavmeshOverlay();
      }
    }
    navmeshBtn?.classList.toggle('active', on && hasSuperadminSession());
    navmeshBtn?.setAttribute('aria-pressed', on && hasSuperadminSession() ? 'true' : 'false');
    navmeshBtn?.setAttribute(
      'title',
      on ? t('main.navmesh.hideOverlayTitle') : t('main.navmesh.showGeneratedTitle'),
    );
    const label = navmeshBtn?.querySelector('.viewport-accessibility-label');
    if (label) label.textContent = on ? t('main.navmesh.hideLabel') : t('main.navmesh.showLabel');
    const iconHost = navmeshBtn?.querySelector('[data-navmesh-icon]');
    if (iconHost) iconHost.innerHTML = on ? iconNavMeshHide() : iconNavMeshShow();
  }

  startStairsDraw = function startStairsDrawMode() {
    if (!featureGates.blocks) {
      statusBar.show(t('main.blocks.disabledForProject'), 'error');
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }
    dashboard.openPanel('stairs');
    stairsPanel.deselect?.();
    detachGizmo();
    sceneToolbar.setMode('default');
    applySceneLayers('stairs');
    setSceneInteractionMode('draw-stairs');
    stairsDrawActive = true;
    statusBar.show(t('main.stairs.dragToMark'), 'loading');
    setTimeout(() => statusBar.hide(), 3800);
  };

  stopStairsDraw = function stopStairsDrawMode() {
    if (!stairsDrawActive && getSceneInteractionMode() !== 'draw-stairs') return;
    cancelBlockDraw();
    setSceneInteractionMode('default');
    stairsDrawActive = false;
  };

  function syncGeometricMeshBtn() {
    if (!geometricMeshBtn) return;
    const hasMatterport = getActiveMatterportMaps().length > 0;
    const hasSplat = getActiveSplatMaps().length > 0;
    const hasAltMap = hasMatterport || hasSplat;
    const show = hasSuperadminSession() && hasAltMap;
    geometricMeshBtn.hidden = !show;
    geometricMeshBtn.style.display = show ? '' : 'none';
    const on = getForceGeometricMesh();
    geometricMeshBtn.classList.toggle('active', on);
    geometricMeshBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = geometricMeshBtn.querySelector('.viewport-accessibility-label');
    const iconHost = geometricMeshBtn.querySelector('.viewport-accessibility-icon');
    if (on) {
      // Geometric mesh is active — offer switch back to space map.
      if (hasMatterport) {
        geometricMeshBtn.title = t('main.geometricMesh.switchToWalkthrough');
        geometricMeshBtn.setAttribute('aria-label', t('main.geometricMesh.switchToWalkthrough'));
        if (label) label.textContent = t('main.geometricMesh.walkthroughViewLabel');
        if (iconHost) iconHost.innerHTML = iconExploreSpace();
      } else {
        geometricMeshBtn.title = t('main.geometricMesh.backToSplatMap');
        geometricMeshBtn.setAttribute('aria-label', t('main.geometricMesh.backToSplatMap'));
        if (label) label.textContent = t('main.geometricMesh.splatMapLabel');
        if (iconHost) iconHost.innerHTML = iconBox();
      }
    } else {
      geometricMeshBtn.title = t('main.geometricMesh.useInsteadOfSpaceMap');
      geometricMeshBtn.setAttribute('aria-label', t('main.geometricMesh.useGeometricMesh'));
      if (label) label.textContent = t('main.geometricMesh.label');
      if (iconHost) iconHost.innerHTML = iconBox();
    }
  }

  async function switchMapToGeometricMesh() {
    if (!sessionToken || !getMapCode()) {
      statusBar.show(t('main.mapMesh.sessionNotReady'), 'error');
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }
    setForceGeometricMesh(true);
    syncGeometricMeshBtn();
    // Bump load generation first so any in-flight Matterport/splat load aborts.
    const loadId = beginMapMeshLoad();
    statusBar.show(t('main.geometricMesh.loading'), 'loading');
    clearNavMesh();
    clearWalkableGotoPoints();
    syncNavmeshBtn(false);
    splatMapMode = false;
    setMapQualityUiEnabled(true);
    clearMatterportMap();
    setMatterportMeshCompositor(false);
    setMatterportMoveTarget(null);
    void setMatterportSelectedLabel(null);
    syncMatterportModeToolbar();
    syncMeshMoveBar();
    await clearMapMesh();
    if (!isMapMeshLoadCurrent(loadId)) return;
    clearMapMeshLoaderCache();
    const meshResult = await loadRawMapMesh(
      sessionToken,
      getMapCode(),
      createMapLoadCallbacks({
        statusBar,
        isActive: () => isMapMeshLoadCurrent(loadId),
      }),
    );
    if (!isMapMeshLoadCurrent(loadId)) return;
    await refreshOverlayGroups();
    applySceneLayers(dashboard.getEditorMode?.() || 'pois');
    syncMatterportModeToolbar();
    syncMeshMoveBar();
    if (!meshResult.ok) {
      statusBar.show(meshResult.error || t('main.geometricMesh.failedToLoad'), 'error');
      setTimeout(() => statusBar.hide(), 3500);
      return;
    }
    try {
      await buildNavigationSetup();
      setNavigationVisualVisible(false);
      syncNavToggleBtn();
    } catch (err) {
      console.warn('[navigation] after geometric mesh switch:', err);
    }
    scheduleFrameCameraToMap();
    // Restore Three.js gizmo for the selected POI on geometric mesh.
    const poiIdx = poiPanel.getSelectedIndex?.() ?? -1;
    if (poiIdx >= 0) {
      poiPanel.selectByIndex?.(poiIdx, { fly: false });
    }
    syncMeshMoveBar();
    statusBar.show(t('main.geometricMesh.readyDragGizmo'), 'success');
    setTimeout(() => statusBar.hide(), 2800);
  }

  async function switchMapToProjectDefault() {
    setForceGeometricMesh(false);
    syncGeometricMeshBtn();
    const loadId = beginMapMeshLoad();
    clearNavMesh();
    clearWalkableGotoPoints();
    syncNavmeshBtn(false);
    syncMeshMoveBar();
    await clearMapMesh();
    if (!isMapMeshLoadCurrent(loadId)) return;

    if (projectUsesMatterportMap()) {
      const mpResult = await loadMatterportAsMap(t('main.space3d.loading'), loadId);
      if (!isMapMeshLoadCurrent(loadId) || mpResult.aborted) return;
      applySceneLayers(dashboard.getEditorMode?.() || 'pois');
      syncMatterportModeToolbar();
      syncMeshMoveBar();
      syncMatterportMoveSelection();
      if (!mpResult.ok) {
        statusBar.show(mpResult.error || t('main.space3d.failedToLoad'), 'error');
        setTimeout(() => statusBar.hide(), 3500);
        return;
      }
      statusBar.show(t('main.space3d.readyOpenEdit'), 'success');
      setTimeout(() => statusBar.hide(), 2800);
      return;
    }

    if (projectUsesSplatMap()) {
      splatMapMode = true;
      setMapQualityUiEnabled(false);
      const splatFileWord = getActiveSplatMaps().length === 1 ? t('main.splatMap.fileSingular') : t('main.splatMap.filePlural');
      const splatResult = await loadSplatAsMap(
        t('main.splatMap.loadingWithCount', { count: getActiveSplatMaps().length, fileWord: splatFileWord }),
        loadId,
      );
      if (!isMapMeshLoadCurrent(loadId) || splatResult.aborted) return;
      applySceneLayers(dashboard.getEditorMode?.() || 'pois');
      syncMatterportModeToolbar();
      syncMeshMoveBar();
      if (!splatResult.ok) {
        statusBar.show(splatResult.error || t('main.splatMap.failedToLoad'), 'error');
        setTimeout(() => statusBar.hide(), 3500);
        return;
      }
      statusBar.show(t('main.splatMap.ready'), 'success');
      setTimeout(() => statusBar.hide(), 2400);
      return;
    }

    await switchMapToGeometricMesh();
  }

  geometricMeshBtn?.addEventListener('click', async () => {
    if (!hasSuperadminSession()) return;
    // Allow interrupting an in-flight Matterport/splat load immediately.
    geometricMeshBtn.disabled = true;
    try {
      if (getForceGeometricMesh()) {
        await switchMapToProjectDefault();
      } else {
        await switchMapToGeometricMesh();
      }
    } catch (err) {
      console.error('[map] geometric mesh toggle:', err);
      statusBar.show(String(err?.message ?? err), 'error');
      setTimeout(() => statusBar.hide(), 3200);
    } finally {
      geometricMeshBtn.disabled = false;
      syncGeometricMeshBtn();
      syncMeshMoveBar();
    }
  });

  navmeshBtn?.addEventListener('click', async () => {
    if (!hasSuperadminSession()) return;
    if (isMatterportMapActive()) {
      if (isNavMeshVisualizationVisible() || isMatterportNavmeshVisible()) {
        hideNavMeshVisualization();
        hideMatterportNavmeshOverlay();
        setMatterportDollhouseMeshOverlay(false);
        resetMatterportMapAlign();
        syncNavmeshBtn(false);
        statusBar.show(t('main.navmesh.hidden'), 'success');
        setTimeout(() => statusBar.hide(), 1600);
        return;
      }

      navmeshBtn.disabled = true;
      const prep = await prepareMatterportDollhouseOverlays(t('main.dollhouse.openingShowingNavmesh'));
      if (!prep.ok) {
        navmeshBtn.disabled = false;
        syncNavmeshBtn(false);
        statusBar.show(prep.error || t('main.dollhouse.prepareNavmeshFailed'), 'error');
        setTimeout(() => statusBar.hide(), 4200);
        return;
      }

      statusBar.show(t('main.navmesh.showingWalkableOverlay'), 'loading');
      const result = await showMatterportNavmeshOverlay();
      navmeshBtn.disabled = false;
      if (!result.ok) {
        syncNavmeshBtn(false);
        statusBar.show(result.error || t('main.navmesh.showFailed'), 'error');
        setTimeout(() => statusBar.hide(), 4200);
        return;
      }
      syncNavmeshBtn(true);
      statusBar.show(t('main.navmesh.visibleInDollhouse'), 'success');
      setTimeout(() => statusBar.hide(), 2000);
      return;
    }

    if (isNavMeshVisualizationVisible()) {
      hideNavMeshVisualization();
      syncNavmeshBtn(false);
      statusBar.show(t('main.navmesh.hidden'), 'success');
      setTimeout(() => statusBar.hide(), 1600);
      return;
    }

    navmeshBtn.disabled = true;
    statusBar.show(t('main.navmesh.building'), 'loading');
    const result = await showNavMeshVisualization();
    navmeshBtn.disabled = false;

    if (!result.ok) {
      syncNavmeshBtn(false);
      statusBar.show(result.error || t('main.navmesh.showFailed'), 'error');
      setTimeout(() => statusBar.hide(), 4200);
      return;
    }

    syncNavmeshBtn(true);
    statusBar.show(t('main.navmesh.visible'), 'success');
    setTimeout(() => statusBar.hide(), 2000);
  });

  ensureMpModesToolbar();

  navToggleBtn?.addEventListener('click', async () => {
    if (!hasSuperadminSession()) return;
    // Active route / Matterport nav focus → cut / hide
    if (isNavigationRouteVisible() || (isMatterportMapActive() && matterportNavPoiIndex >= 0)) {
      clearNavigationRoute();
      matterportNavPoiIndex = -1;
      void clearMatterportNavRouteOverlay();
      syncNavToggleBtn();
      showToast(t('main.navigation.clearedToast'), 'success');
      return;
    }

    let index = poiPanel.getSelectedIndex?.() ?? -1;
    if (index < 0) index = getLastPickedPoiIndex();
    if (index < 0 || index >= poisData.length) {
      showToast(t('main.navigation.selectPoiFirstToast'), 'info');
      return;
    }

    const poi = poisData[index];
    navToggleBtn.disabled = true;

    // Matterport: pathfind on hidden geometric mesh, draw route points on Showcase only.
    if (isMatterportMapActive()) {
      showToast(t('main.navigation.buildingRouteTo', { poiName: poi.poi_name }), 'info');
      try {
        const result = await navigateToPoi(index, { showVisual: false });
        if (!result.ok) {
          showToast(result.error || t('main.navigation.couldNotNavigate'), 'error');
          syncNavToggleBtn();
          return;
        }
        const pathPoints =
          result.pathPoints?.length >= 2
            ? result.pathPoints
            : getNavigationPathWorldPoints();
        if (!pathPoints.length) {
          showToast(t('main.navigation.noPathPoints'), 'error');
          syncNavToggleBtn();
          return;
        }
        const overlay = await setMatterportNavRouteOverlay(pathPoints);
        if (!overlay.ok) {
          showToast(overlay.error || t('main.navigation.couldNotDrawRoute'), 'error');
          syncNavToggleBtn();
          return;
        }
        matterportNavPoiIndex = index;
        poiPanel.selectByIndex?.(index, { fly: false });
        // Stays in walkthrough — the overlay redraws against camera pose, so the
        // route is visible from inside the space without jumping to dollhouse.
        showToast(t('main.navigation.routeTo', { poiName: poi.poi_name }), 'success');
        syncNavToggleBtn();
      } catch (err) {
        console.error('[navigation] matterport navigate:', err);
        void clearMatterportNavRouteOverlay();
        showToast(err?.message ?? t('main.navigation.failed'), 'error');
        syncNavToggleBtn();
      } finally {
        navToggleBtn.disabled = false;
      }
      return;
    }

    showToast(t('main.navigation.buildingRouteTo', { poiName: poi.poi_name }), 'info');
    try {
      const result = await navigateToPoi(index);
      if (!result.ok) {
        showToast(result.error || t('main.navigation.couldNotNavigate'), 'error');
        syncNavToggleBtn();
        return;
      }
      poiPanel.selectByIndex?.(index);
      showToast(t('main.navigation.navigatingTo', { poiName: poi.poi_name }), 'success');
      syncNavToggleBtn();
    } catch (err) {
      console.error('[navigation] map navigate:', err);
      showToast(err?.message ?? t('main.navigation.failed'), 'error');
      syncNavToggleBtn();
    } finally {
      navToggleBtn.disabled = false;
    }
  });
  syncNavToggleBtn();

  /** In-app entity clipboard for Cmd/Ctrl+C / Cmd/Ctrl+V (POI, media, facility, block, stairs). */
  let entityClipboard = null;
  const PASTE_OFFSET = 0.5;

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return Boolean(el.closest?.('input, textarea, select, [contenteditable="true"]'));
  }

  function newCopiedZoneId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `zone-${crypto.randomUUID()}`;
    }
    return `zone-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function captureSelectedEntity() {
    const poiIdx = poiPanel.getSelectedIndex?.() ?? -1;
    if (poiIdx >= 0 && poiIdx < poisData.length) {
      const p = poisData[poiIdx];
      return {
        type: 'poi',
        data: {
          poi_name: p.poi_name,
          description: p.description ?? '',
          category_type: p.category_type ?? null,
          category_ids: Array.isArray(p.category_ids) ? [...p.category_ids] : p.category_type ? [p.category_type] : [],
          pos_x: Number(p.pos_x),
          pos_y: Number(p.pos_y),
          pos_z: Number(p.pos_z),
          expected_pos_x: Number(p.expected_pos_x ?? p.pos_x),
          expected_pos_y: Number(p.expected_pos_y ?? p.pos_y),
          expected_pos_z: Number(p.expected_pos_z ?? p.pos_z),
        },
      };
    }

    const mediaIdx = mediaPanel.getSelectedIndex?.() ?? -1;
    if (mediaIdx >= 0 && mediaIdx < mediaData.length) {
      const m = mediaData[mediaIdx];
      return {
        type: 'media',
        data: {
          label: m.label,
          media_url: m.media_url,
          media_type: m.media_type,
          mime_type: m.mime_type,
          file_name: m.file_name,
          pos_x: Number(m.pos_x),
          pos_y: Number(m.pos_y),
          pos_z: Number(m.pos_z),
          rot_x: Number(m.rot_x ?? 0),
          rot_y: Number(m.rot_y ?? 0),
          rot_z: Number(m.rot_z ?? 0),
          scale_x: Number(m.scale_x ?? 1),
          scale_y: Number(m.scale_y ?? 1),
          scale_z: Number(m.scale_z ?? 1),
          width: Number(m.width ?? 1),
          height: Number(m.height ?? 1),
          is_active: m.is_active !== false,
          redirect_link: m.redirect_link ?? null,
        },
      };
    }

    const facIdx = facilityPanel.getSelectedIndex?.() ?? -1;
    if (facIdx >= 0 && facIdx < facilitiesData.length) {
      const f = facilitiesData[facIdx];
      return {
        type: 'facility',
        data: {
          facility_name: f.facility_name,
          facility_category: f.facility_category || 'general',
          facility_group: f.facility_group || '',
          floor_name: f.floor_name || '',
          icon_key: f.icon_key,
          pos_x: Number(f.pos_x),
          pos_y: Number(f.pos_y),
          pos_z: Number(f.pos_z),
          is_active: f.is_active !== false,
        },
      };
    }

    const blockId = blockPanel.getSelectedId?.();
    if (blockId != null) {
      const b = blocksData.find((row) => String(row.id) === String(blockId) && !isStairsZone(row));
      if (b) {
        return {
          type: 'block',
          data: {
            zone_name: b.zone_name || b.label || 'Block',
            label: b.label || b.zone_name || 'Block',
            pos_x: Number(b.pos_x),
            pos_y: Number(b.pos_y),
            pos_z: Number(b.pos_z),
            width: Number(b.width ?? 1),
            depth: Number(b.depth ?? 1),
            is_blocked: Boolean(b.is_blocked),
            is_active: true,
            zone_type: 'zone',
          },
        };
      }
    }

    const stairsId = stairsPanel.getSelectedId?.();
    if (stairsId != null) {
      const s = blocksData.find((row) => String(row.id) === String(stairsId) && isStairsZone(row));
      if (s) {
        return {
          type: 'stairs',
          data: {
            zone_name: s.zone_name || s.label || 'Stairs',
            label: s.label || s.zone_name || 'Stairs',
            pos_x: Number(s.pos_x),
            pos_y: Number(s.pos_y),
            pos_z: Number(s.pos_z),
            width: Number(s.width ?? 1),
            depth: Number(s.depth ?? 1),
            is_blocked: false,
            is_active: true,
            zone_type: 'stairs',
          },
        };
      }
    }

    return null;
  }

  async function pasteEntityClipboard() {
    if (!entityClipboard?.type || !entityClipboard.data) {
      showToast(t('main.clipboard.nothingToPaste'), 'info');
      return;
    }

    const d = entityClipboard.data;
    const ox = PASTE_OFFSET;

    try {
      if (entityClipboard.type === 'poi') {
        const idx = await addPOIWithDb({
          ...d,
          poi_name: `${d.poi_name} copy`,
          pos_x: d.pos_x + ox,
          expected_pos_x: Number(d.expected_pos_x ?? d.pos_x) + ox,
          expected_pos_y: Number(d.expected_pos_y ?? d.pos_y),
          expected_pos_z: Number(d.expected_pos_z ?? d.pos_z),
        });
        dashboard.openPanel('pois');
        poiPanel.refresh();
        poiPanel.selectByIndex?.(idx);
        dashboard.refreshStats();
        if (isMatterportMapActive() && poisData[idx]) {
          void syncMatterportEntityTags({ pois: [poisData[idx]] });
        }
        showToast(t('main.clipboard.poiPasted'), 'success');
        return;
      }

      if (entityClipboard.type === 'media') {
        const idx = await addMediaWithDb({
          ...d,
          label: `${d.label || 'Media'} copy`,
          pos_x: d.pos_x + ox,
        });
        dashboard.openPanel('media');
        mediaPanel.refresh({ fly: false });
        mediaPanel.selectByIndex?.(idx, { fly: true });
        dashboard.refreshStats('media');
        showToast(t('main.clipboard.mediaPasted'), 'success');
        return;
      }

      if (entityClipboard.type === 'facility') {
        const idx = await addFacilityWithDb({
          ...d,
          facility_name: `${d.facility_name} copy`,
          pos_x: d.pos_x + ox,
        });
        dashboard.openPanel('facilities');
        facilityPanel.refresh();
        facilityPanel.selectByIndex?.(idx);
        dashboard.refreshStats('facilities');
        showToast(t('main.clipboard.amenityPasted'), 'success');
        return;
      }

      if (entityClipboard.type === 'block') {
        const inserted = await addBlockWithDb({
          ...d,
          zone_id: newCopiedZoneId(),
          zone_name: `${d.zone_name} copy`,
          label: `${d.label} copy`,
          pos_x: d.pos_x + ox,
        });
        dashboard.openPanel('blocks');
        blockPanel.refresh();
        if (inserted?.id) blockPanel.selectById?.(inserted.id);
        dashboard.refreshStats('blocks');
        showToast(t('main.clipboard.blockPasted'), 'success');
        return;
      }

      if (entityClipboard.type === 'stairs') {
        const inserted = await addBlockWithDb({
          ...d,
          zone_id: newCopiedZoneId(),
          zone_name: `${d.zone_name} copy`,
          label: `${d.label} copy`,
          pos_x: d.pos_x + ox,
        });
        dashboard.openPanel('stairs');
        stairsPanel.refresh();
        if (inserted?.id) stairsPanel.selectById?.(inserted.id);
        dashboard.refreshStats('stairs');
        showToast(t('main.clipboard.stairsPasted'), 'success');
      }
    } catch (err) {
      console.error('[clipboard] paste failed:', err);
      showToast(err?.message || t('main.clipboard.pasteFailed'), 'error');
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (isTypingTarget(e.target)) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 'c') {
      const captured = captureSelectedEntity();
      if (!captured) {
        showToast(t('main.clipboard.selectEntityToCopy'), 'info');
        return;
      }
      e.preventDefault();
      entityClipboard = captured;
      const copyLabel =
        captured.type === 'facility'
          ? t('main.clipboard.typeAmenity')
          : captured.type === 'poi'
            ? t('main.clipboard.typePoi')
            : String(captured.type).charAt(0).toUpperCase() + String(captured.type).slice(1);
      showToast(t('main.clipboard.copiedToast', { copyLabel }), 'success');
      return;
    }
    if (key === 'v') {
      e.preventDefault();
      pasteEntityClipboard();
    }
  });

  dashboard.onPanelChange((panelId) => {
    // Soft-redirect if a gated panel was opened while the feature is off
    const gated = {
      facilities: 'facilities',
      blocks: 'blocks',
      stairs: 'blocks',
      users: 'users',
      treasure: 'treasure',
      media: 'media',
      'guided-tours': 'guidedTours',
    };
    const gateKey = gated[panelId];
    if (gateKey && !featureGates[gateKey]) {
      const labels = {
        facilities: t('main.featureLabel.amenities'),
        blocks: t('main.featureLabel.zones'),
        users: t('main.featureLabel.tracking'),
        treasure: t('main.featureLabel.treasure'),
        media: t('main.featureLabel.media'),
        guidedTours: t('main.featureLabel.guidedTours'),
      };
      showToast(t('main.featureGate.notEnabled', { label: labels[gateKey] || t('main.featureLabel.thisFeature') }), 'info');
      dashboard.openPanel('pois');
      return;
    }

    applySceneLayers(panelId);
    detachGizmo();
    poiPanel.hide();
    floorPanel.hide();
    guidedTourPanel.hide();
    facilityPanel.hide();
    mediaPanel.hide();
    treasurePanel.hide();
    userPanel.hide();
    profilePanel.hide();
    gmapPanel.hide();
    blockPanel.hide();
    stairsPanel.hide();
    mediaPanel.deselect?.();
    treasurePanel.deselect?.();
    facilityPanel.deselect?.();
    userPanel.deselect?.();
    blockPanel.deselect?.();
    stairsPanel.deselect?.();
    cancelBlockDraw();
    if (panelId !== 'stairs') stopStairsDraw();

    document.body.classList.toggle('navme-logs-report-open', panelId === 'profile');
    if (mpModesEl) {
      const showModes = isMatterportMapActive() && panelId !== 'profile';
      mpModesEl.hidden = !showModes;
      mpModesEl.classList.toggle('is-visible', showModes);
    }
    if (mpFloorsEl && panelId === 'profile') {
      mpFloorsEl.hidden = true;
      mpFloorsEl.classList.remove('is-visible');
    }

    if (panelId === 'profile') {
      if (dashboard.element?.dataset.openProfileTab === 'admins') {
        profilePanel.openAdmins();
        delete dashboard.element.dataset.openProfileTab;
      } else {
        profilePanel.show();
      }
      return;
    }
    if (panelId === 'gmap') {
      gmapPanel.show();
      return;
    }
    if (panelId === 'floors') {
      if (!isSuperAdminMapRole()) {
        dashboard.openPanel('pois');
        return;
      }
      floorPanel.show();
      floorPanel.refresh();
    } else if (panelId === 'guided-tours') {
      guidedTourPanel.show();
      guidedTourPanel.refresh();
    } else if (panelId === 'media') {
      mediaPanel.show();
      mediaPanel.refresh();
      mediaPanel.wireGizmoHandlers?.();
    } else if (panelId === 'treasure') {
      treasurePanel.show();
      treasurePanel.refresh();
    } else if (panelId === 'facilities') {
      facilityPanel.show();
      facilityPanel.wireGizmoHandlers?.();
    } else if (panelId === 'users') {
      userPanel.show();
    } else if (panelId === 'blocks') {
      blockPanel.show();
      blockPanel.refresh?.();
      blockPanel.wireGizmoHandlers?.();
    } else if (panelId === 'stairs') {
      stairsPanel.show();
      stairsPanel.refresh?.();
      stairsPanel.wireGizmoHandlers?.();
    } else {
      poiPanel.show();
      poiPanel.refresh();
      poiPanel.wireGizmoHandlers?.();
      if (isMatterportMapActive()) {
        void syncMatterportEntityTags({
          pois: poisData,
          facilities: facilitiesData,
          media: mediaData,
        });
      }
    }

    if (panelId !== 'users') {
      clearUserHeatmap();
      clearAllMarkers();
      clearHistoryRoute();
    }
  });

  async function onFormSubmit(creds, ctx) {
    const { statusBar, formUI } = ctx;
    formUI.disable();
    formUI.hide();
    statusBar.show(t('main.session.opening'), 'loading');

    try {
      if (!canCreateWebGLContext()) {
        throw new Error(t('main.session.webglDisabled'));
      }

      setPoiSession({
        poiType: creds.poiType,
        mapCode: creds.mapCode,
        organizationId: creds.organizationId,
      });
      dashboard.syncTeamNavVisibility?.();

      statusBar.show(t('main.session.authenticating'), 'loading');
      const authResult = await getM2MToken(creds.clientId, creds.clientSecret);
      const token = authResult.token;

      statusBar.show(t('main.session.loading3dViewer'), 'loading');
      formUI.hide();
      dashboard.show();
      initScene(dashboard.viewport);
      applySceneTheme(getTheme());

      statusBar.show(t('main.session.loadingPoisAndMedia'), 'loading');
      sessionToken = token;
      const loadId = beginMapMeshLoad();
      clearMapMeshLoaderCache();
      const loader = await createMapGltfLoader();
      mapLoader = loader;
      activeMeshQuality = 'raw';
      splatMapMode = false;
      if (mapMeshQualitySelect) mapMeshQualitySelect.value = 'raw';
      setMapQualityUiEnabled(true);
      setMediaGltfLoader(loader);
      setTreasureGltfLoader(loader);

      await Promise.all([
        hydratePoisFromSupabase().then(() =>
          hydrateGuidedToursFromSupabase().catch((err) => {
            console.warn('[guided-tours] hydrate skipped:', err);
          }),
        ),
        hydrateCategoriesFromSupabase(),
        hydrateFloorsFromSupabase().catch((err) => {
          console.warn('[floors] hydrate skipped:', err);
        }),
        hydrateFacilitiesFromSupabase(),
        hydrateMediaFromSupabase(),
        hydrateTreasuresFromSupabase(),
        hydrateBlocksFromSupabase(),
      ]);
      dashboard.setSidebarPanelVisible?.('floors', isSuperAdminMapRole());
      poiPanel.refreshFloorOptions?.();
      guidedTourPanel.refresh();
      syncGeometricMeshBtn();
      syncNavmeshBtn(isNavMeshVisualizationVisible());
      syncNavToggleBtn();

      // Project feature flags → sidebar + map layers (superadmin session sees all)
      try {
        const featureRow = await fetchProjectFeaturesByPoiType(getPoiType());
        applyProjectFeatureGates(featureRow, { bypass: hasSuperadminSession() });
      } catch (err) {
        console.warn('[features] Could not load project features:', err);
        applyProjectFeatureGates(null, { bypass: hasSuperadminSession() });
      }
      syncGeometricMeshBtn();
      syncNavmeshBtn(false);
      syncNavToggleBtn();

      dashboard.refreshStats();

      startMediaRealtime({
        onChange: () => {
          mediaPanel.refresh({ fly: false });
          dashboard.refreshStats('media');
        },
      });

      // 3D space Showcase link → map instead of mesh/splat (unless SA forced geometric mesh).
      if (projectUsesMatterportMap() && !getForceGeometricMesh()) {
        if (!isMapMeshLoadCurrent(loadId)) return;
        const mpResult = await loadMatterportAsMap(t('main.space3d.loading'), loadId, {
          onShowcaseReady: () => scheduleEditorTour({ afterMatterport: true }),
        });
        if (!isMapMeshLoadCurrent(loadId) || mpResult.aborted) return;

        applySceneLayers(dashboard.getEditorMode());
        poiPanel.show();
        poiPanel.refresh();
        facilityPanel.refresh();
        mediaPanel.refresh();
        sceneToolbar.setMode('default');
        setMatterportToolMode('default');
        syncDollhouseBtn();
        syncMeshMoveBar();
        dashboard.refreshStats();

        if (!mpResult.ok) {
          statusBar.show(mpResult.error || t('main.space3d.failedToLoad'), 'error');
          setTimeout(() => statusBar.hide(), 4200);
          return;
        }
        statusBar.show(
          mpResult.browsingOnly
            ? t('main.space3d.openSdkNotWhitelisted')
            : t('main.space3d.readyAddFromToolbar'),
          mpResult.browsingOnly ? 'error' : 'success',
        );
        setTimeout(() => statusBar.hide(), 3200);
        return;
      }

      // Superadmin forced geometric mesh (or toggled mid Matterport load).
      if (getForceGeometricMesh() && (projectUsesMatterportMap() || projectUsesSplatMap())) {
        if (!isMapMeshLoadCurrent(loadId)) return;
        await switchMapToGeometricMesh();
        poiPanel.show();
        poiPanel.refresh();
        facilityPanel.refresh();
        mediaPanel.refresh();
        sceneToolbar.setMode('default');
        dashboard.refreshStats();
        scheduleEditorTour();
        return;
      }

      // If this project has uploaded .ply splats, use them as the map (no MultiSet mesh).
      if (projectUsesSplatMap() && !getForceGeometricMesh()) {
        if (!isMapMeshLoadCurrent(loadId)) return;
        await clearMapMesh();
        const initialSplatFileWord = getActiveSplatMaps().length === 1 ? t('main.splatMap.fileSingular') : t('main.splatMap.filePlural');
        const splatResult = await loadSplatAsMap(
          t('main.splatMap.loadingWithCount', { count: getActiveSplatMaps().length, fileWord: initialSplatFileWord }),
          loadId,
        );
        if (!isMapMeshLoadCurrent(loadId) || splatResult.aborted) return;

        applySceneLayers(dashboard.getEditorMode());
        poiPanel.show();
        poiPanel.refresh();
        facilityPanel.refresh();
        mediaPanel.refresh();
        sceneToolbar.setMode('default');
        dashboard.refreshStats();
        // Keep camera at origin for splat maps (do not frame-to-fit — fog + far camera = blank).

        if (!splatResult.ok) {
          statusBar.show(splatResult.error || t('main.splatMap.failedToLoad'), 'error');
          setTimeout(() => statusBar.hide(), 3500);
          return;
        }

        const skipNote =
          splatResult.skippedOversized > 0
            ? t('main.splatMap.skipNoteTooLarge', { count: splatResult.skippedOversized })
            : splatResult.failed
              ? t('main.splatMap.skipNoteSkipped', { count: splatResult.failed })
              : '';
        const resultFileWord = splatResult.count === 1 ? t('main.splatMap.fileSingular') : t('main.splatMap.filePlural');
        statusBar.show(
          t('main.splatMap.readyWithCountAtOrigin', { count: splatResult.count, fileWord: resultFileWord, skipNote }),
          'success',
        );
        setTimeout(() => statusBar.hide(), 2800);
        scheduleEditorTour();
        return;
      }

      statusBar.show(t('main.mapMesh.loading'), 'loading');
      setMatterportMeshCompositor(false);
      clearMatterportMap();
      syncDollhouseBtn();
      const meshResult = await loadRawMapMesh(
        token,
        creds.mapCode,
        createMapLoadCallbacks({
          statusBar,
          isActive: () => isMapMeshLoadCurrent(loadId),
        }),
      );
      if (!isMapMeshLoadCurrent(loadId)) return;
      const anchor = getMultisetAnchor();

      if (!meshResult.ok) {
        if (anchor) {
          refreshPOIGroup(anchor);
          refreshFacilityGroup(anchor);
          await refreshMediaGroup(anchor);
          await refreshTreasureGroup(anchor);
          refreshBlockGroup(anchor);
        }
        applySceneLayers(dashboard.getEditorMode());
        poiPanel.show();
        poiPanel.refresh();
        facilityPanel.refresh();
        mediaPanel.refresh();
        sceneToolbar.setMode('default');
        scheduleFrameCameraToMap();
        statusBar.show(meshResult.error || t('main.mapMesh.noGlbStillEditable'), 'error');
        setTimeout(() => statusBar.hide(), 3500);
        return;
      }

      await refreshOverlayGroups();

      statusBar.show(t('main.navigation.building'), 'loading');
      const navSetup = await buildNavigationSetup();
      if (!isMapMeshLoadCurrent(loadId)) return;
      if (!navSetup.ok) {
        console.warn('[navigation]', navSetup.error);
        statusBar.show(
          navSetup.error || t('main.navigation.unavailableStillEditable'),
          'error',
        );
        setTimeout(() => statusBar.hide(), 3500);
      }
      syncNavigationToLatestPoi();
      setNavigationVisualVisible(false);
      syncNavToggleBtn();

      applySceneLayers(dashboard.getEditorMode());
      poiPanel.show();
      poiPanel.refresh();
      facilityPanel.refresh();
      mediaPanel.refresh();
      sceneToolbar.setMode('default');
      dashboard.refreshStats();
      if (navSetup.ok) {
        statusBar.show(t('main.mapMesh.rawReadySwitchToTextured'), 'success');
        setTimeout(() => statusBar.hide(), 2800);
      }
      scheduleEditorTour();
    } catch (err) {
      console.error(err);
      statusBar.show(err.message || t('main.session.error'), 'error');
      if (!sessionToken) {
        sessionToken = null;
        mapLoader = null;
        activeMeshQuality = 'raw';
        formUI.enable();
        dashboard.hide();
        formUI.show();
        return;
      }
      applySceneLayers(dashboard.getEditorMode());
      poiPanel.show();
      poiPanel.refresh();
      facilityPanel.refresh();
      mediaPanel.refresh();
      sceneToolbar.setMode('default');
      dashboard.refreshStats();
      setTimeout(() => statusBar.hide(), 4000);
    }
  }
}
