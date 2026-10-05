export const MULTISET_PUBLIC_API = 'https://api.multiset.ai';

export const NAVME_MULTISET_PROXY_BASE =
  'https://vfpgtifzqznfdtecmpsc.supabase.co/functions/v1/multiset-proxy';

export const DEFER_NAV_MESH = true;
/** In 2D editor, build nav mesh only when routing or NavMesh overlay is requested. */
export const DEFER_NAV_MESH_2D = true;
/** Parallel GLB downloads for MSET_* map sets (background phase). */
export const MAP_DOWNLOAD_CONCURRENCY = 6;
/** Meshes to download before showing the map (rest load in background). */
export const MAP_LAZY_EAGER_COUNT = 1;
/** Background download threads after the first mesh is shown. */
export const MAP_LAZY_BACKGROUND_CONCURRENCY = 2;
/** Network timeout per map download / auth request (large GLBs). */
export const MAP_FETCH_TIMEOUT_MS = 180_000;
/** Debounce floor rebuild while background meshes stream in. */
export const MAP_LAZY_FLOOR_REBUILD_MS = 1_500;
/** Debounce Y-slice spinner / input before re-slicing the mesh. */
export const SLICE_REBUILD_DEBOUNCE_MS = 800;
/** Agent / erosion radius in world units (meters). */
export const NAV_MESH_AGENT_RADIUS = 0.02;
/** Horizontal voxel size (reference-style; fine values OOM on large maps). */
export const NAV_MESH_CELL_SIZE = 0.1;
/** Vertical voxel size. */
export const NAV_MESH_CELL_HEIGHT = 0.05;
/** Agent height / climb in world units (converted to voxels at bake time). */
export const NAV_MESH_WALKABLE_HEIGHT = 2;
export const NAV_MESH_WALKABLE_CLIMB = 0.3;
export const FAST_NAV_MESH = true;
export const FALLBACK_FULL_NAV_MESH = true;
/**
 * Snap + path query box. Keep Y modest (2–4 m) so POIs snap to the same floor slice —
 * a huge Y (e.g. 50) lets findNearestPoly pick walkable mesh on another level and the
 * route line cuts through voids on the 2D map.
 */
export const NAV_MESH_QUERY_HALF_EXTENTS = { x: 4, y: 3, z: 4 };
/** Extra vertical band when snapping at a known floor slice Y (2D navigation). */
export const NAV_MESH_FLOOR_QUERY_HALF_EXTENTS_Y = 2.5;
/** Corner cut distance when softening nav route bends. */
export const ROUTE_CORNER_SOFTEN_DIST = 0.55;
/** Y offset for non-camera POI snap sampling (NavigationRoute cameraPositionOffset[1]). */
export const ROUTE_CAMERA_POSITION_OFFSET_Y = 0;
export const USE_LOAD_CACHE = true;
export const GLB_CACHE_NAME = 'navme-mini3d-glb-v1';

export const DRACO_DECODER_PATH =
  'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/jsm/libs/draco/gltf/';

export const MAP_GHOST_OPACITY = 0.4;

/** Horizontal slice height (Y-up): 2D floor plan is top-down X–Z at this Y. */
export const FLOOR_SLICE_Y = -1.6;

export interface GtaConfig {
  defaultMapCode: string;
  baseTitle: string;
  multiSetApiBaseUrl?: string;
  glbCorsProxyPostUrl?: string;
}

export const DEFAULT_GTA: GtaConfig = {
  defaultMapCode: '',
  baseTitle: 'NavMe Spatial Studio',
};
