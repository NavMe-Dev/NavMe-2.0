/** Shared inline SVG icons (stroke, 24×24 viewBox). */

function svg(className, paths, size = 16) {
  return `<svg class="ui-icon${className ? ` ${className}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const iconMoon = () =>
  svg('ui-icon-moon', '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', 18);

export const iconSun = () =>
  svg('ui-icon-sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>', 18);

export const iconSave = () =>
  svg('ui-icon-save', '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>');

export const iconDelete = () =>
  svg('ui-icon-delete', '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 18);

export const iconAdd = () =>
  svg('ui-icon-add', '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');

export const iconEdit = () =>
  svg('ui-icon-edit', '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>');

export const iconBox = () =>
  svg('ui-icon-box', '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>');

/** Treasure chest — open box with gold coins spilling out */
const TREASURE_CHEST_PATHS =
  /* Open lid (hinged back) */
  '<path d="M4.2 10.6 5.6 4.4a1.2 1.2 0 0 1 1.15-.85h10.5a1.2 1.2 0 0 1 1.15.85L19.8 10.6"/>' +
  '<path d="M6.4 6.1h11.2"/>' +
  /* Chest body */
  '<path d="M3.6 10.6h16.8v7.8c0 .75-.6 1.35-1.35 1.35H4.95c-.75 0-1.35-.6-1.35-1.35V10.6z"/>' +
  /* Inner rim */
  '<path d="M5.1 10.6v1.15h13.8V10.6"/>' +
  /* Gold mound inside */
  '<path d="M7.1 14.2c1.1-1.55 2.5-2.35 4.9-2.35s3.8.8 4.9 2.35"/>' +
  /* Coins */
  '<circle cx="9.2" cy="14.55" r="1.15"/>' +
  '<circle cx="12" cy="13.85" r="1.25"/>' +
  '<circle cx="14.85" cy="14.55" r="1.15"/>' +
  '<circle cx="10.55" cy="16.35" r="1.05"/>' +
  '<circle cx="13.5" cy="16.25" r="1.05"/>';

export const iconTreasure = () => svg('ui-icon-treasure', TREASURE_CHEST_PATHS, 24);

export const iconGrip = () =>
  svg('ui-icon-grip', '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>', 14);

export const iconClose = () =>
  svg('ui-icon-close', '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 14);

export const iconDownload = () =>
  svg(
    'ui-icon-download',
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    16,
  );

/** QR code glyph for Generate QR actions. */
export const iconQrCode = () =>
  svg(
    'ui-icon-qr',
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14h1v1h-1z"/><path d="M17 17h1v1h-1z"/><path d="M20 17h1v4h-4v-1"/><path d="M14 20h1v1h-1z"/>',
    16,
  );

/** Small padlock for locked feature controls. */
export const iconLock = () =>
  svg(
    'ui-icon-lock',
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    9,
  );

export const iconHelp = () =>
  svg(
    'ui-icon-help',
    '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
    18,
  );

export const iconRefresh = () =>
  svg('ui-icon-refresh', '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 16);

export const iconArrowLeft = () =>
  svg('ui-icon-arrow-left', '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 16);

export const iconChevronRight = () =>
  svg('ui-icon-chevron-right', '<polyline points="9 18 15 12 9 6"/>', 18);

export const iconSearch = () =>
  svg('ui-icon-search', '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/>', 18);

/** Funnel / category filter */
export const iconFilter = () =>
  svg(
    'ui-icon-filter',
    '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    16,
  );

export const iconUsers = () =>
  svg(
    'ui-icon-users',
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    18,
  );

/** Activity / user logs pulse */
export const iconActivity = () =>
  svg(
    'ui-icon-activity',
    '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    18,
  );

export const iconLogout = () =>
  svg(
    'ui-icon-logout',
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    16,
  );

export const iconMapPin = () =>
  svg('ui-icon-map-pin', '<path d="M12 21s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>', 18);

/** Navigate / route arrow */
export const iconNavigate = () =>
  svg(
    'ui-icon-navigate',
    '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    16,
  );

/** Cut navigation — route arrow with slash */
export const iconNavigateOff = () =>
  svg(
    'ui-icon-navigate-off',
    '<polygon points="3 11 22 2 13 21 11 13 3 11"/>' +
      '<line x1="3" y1="3" x2="21" y2="21" stroke-width="2.25"/>',
    16,
  );

export const iconKey = () =>
  svg('ui-icon-key', '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>', 18);

export const iconCopy = () =>
  svg(
    'ui-icon-copy',
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    16,
  );

/** 3D map / editor — cube wireframe */
export const iconEditor3d = () =>
  svg(
    'ui-icon-editor-3d',
    '<path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5L12 3z"/><path d="M12 12 20 7.5M12 12V21M12 12 4 7.5"/>',
    16,
  );

export const iconEye = () =>
  svg('ui-icon-eye', '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 18);

export const iconEyeOff = () =>
  svg('ui-icon-eye-off', '<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4.1"/><path d="M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7a10.9 10.9 0 0 0 4.3-.9"/>', 18);

/** Globe — languages / localization */
export const iconGlobe = () =>
  svg(
    'ui-icon-globe',
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15.3 15.3 0 0 1 4 9 15.3 15.3 0 0 1-4 9 15.3 15.3 0 0 1-4-9 15.3 15.3 0 0 1 4-9z"/>',
    18,
  );

/** Prohibited / no-entry — zone block restriction */
export const iconZoneBlock = () =>
  svg(
    'ui-icon-zone-block',
    '<circle cx="12" cy="12" r="8"/><line x1="7.5" y1="7.5" x2="16.5" y2="16.5"/>',
    18,
  );

/** Nav sidebar — centered image frame (no plus) */
const MEDIA_NAV_PATHS =
  '<rect x="4.5" y="5.5" width="15" height="13" rx="2.25"/>' +
  '<path d="M5 17L8 11.5L10.5 14L13 10.5L17.5 17Z" fill="currentColor" stroke="none"/>' +
  '<circle cx="14.5" cy="8.75" r="1.65" fill="currentColor" stroke="none"/>';

/** Nav menu — media only (no plus) */
export const iconMedia = () => svg('ui-icon-media', MEDIA_NAV_PATHS, 24);

/** Go to — simple target circle (not clock-like) */
export const iconFootprint = () =>
  svg(
    'ui-icon-go-nav',
    '<circle cx="12" cy="12" r="8.25"/>' +
      '<circle cx="12" cy="12" r="3"/>',
    20,
  );

/** Map pin — place POI on click */
export const iconPlacePoi = () =>
  svg(
    'ui-icon-place-poi',
    '<path d="M12 21s-6.5-5.2-6.5-10.2a6.5 6.5 0 1 1 13 0C18.5 15.8 12 21 12 21z"/>' +
      '<circle cx="12" cy="10.8" r="2.15"/>',
    20,
  );

/**
 * Amenities — wayfinding signboard with clear direction arrows (easy navigation).
 */
const AMENITY_SIGNBOARD_PATHS =
  /* Post + base */
  '<path d="M12 3.1v17.7"/>' +
  '<path d="M8.2 20.8h7.6"/>' +
  /* Upper board pointing left */
  '<path d="M12 5.2H6.4L4.4 7.35 6.4 9.5H12z"/>' +
  '<path d="M10.4 7.35H7.35"/>' +
  '<path d="M8.2 6.35 7.1 7.35 8.2 8.35"/>' +
  /* Lower board pointing right */
  '<path d="M12 11.3h5.6l2 2.15-2 2.15H12z"/>' +
  '<path d="M13.6 13.45h3.05"/>' +
  '<path d="M15.8 12.45 16.9 13.45 15.8 14.45"/>';

export const iconPlaceFacility = () =>
  svg('ui-icon-place-facility', AMENITY_SIGNBOARD_PATHS, 20);

/** Amenities mark for sidebar / panels. */
export const iconFacilityColor = () =>
  svg('ui-icon-facility ui-icon-facility--color', AMENITY_SIGNBOARD_PATHS, 24);

/** Default amenities mark */
export const iconFacility = iconFacilityColor;

/** Scene toolbar — place media (image frame) */
export const iconPlaceMedia = () =>
  svg(
    'ui-icon-place-media',
    '<rect x="3.5" y="5" width="17" height="14" rx="2.25"/>' +
      '<circle cx="9" cy="10" r="1.6"/>' +
      '<path d="M3.8 16.5 8.2 12l2.8 2.6 3.2-3.8 5.8 5.7"/>',
    20,
  );

/** Zone block — prohibited / no-entry block symbol */
export const iconPlaceBlock = () =>
  svg(
    'ui-icon-place-block',
    '<circle cx="12" cy="12" r="8.25"/>' +
      '<line x1="7.2" y1="7.2" x2="16.8" y2="16.8"/>',
    20,
  );

/** Alias used elsewhere for add-media tool */
export const iconAddMedia = iconPlaceMedia;

/** Nav sidebar — category tags (distinct from POI pin / media frame) */
const CATEGORY_TAGS_PATHS =
  '<path d="M12.5 3.5H8.2a1.5 1.5 0 0 0-1.06.44L3.44 7.64a1.5 1.5 0 0 0 0 2.12l6.8 6.8a1.5 1.5 0 0 0 2.12 0l4.7-4.7a1.5 1.5 0 0 0 .44-1.06V7.5a4 4 0 0 0-4-4z"/>' +
  '<circle cx="9.25" cy="8.25" r="1.15" fill="currentColor" stroke="none"/>' +
  '<path d="M15.5 7.5h2.2a1.5 1.5 0 0 1 1.06.44l2.8 2.8a1.5 1.5 0 0 1 0 2.12l-5.1 5.1"/>';

export const iconCategory = () => svg('ui-icon-category', CATEGORY_TAGS_PATHS, 24);

/** Wheelchair — mark stair areas for accessibility routing */
export const iconWheelchair = () =>
  svg(
    'ui-icon-wheelchair',
    '<circle cx="8.5" cy="6.5" r="2.25"/>' +
      '<path d="M5 10.5h7.5"/>' +
      '<path d="M12.5 10.5 15 18.5"/>' +
      '<circle cx="17.5" cy="18.5" r="2.25"/>' +
      '<path d="M5 10.5v2.5a3 3 0 0 0 3 3h2.5"/>',
    18,
  );

export const iconPlaceStairs = iconWheelchair;

/** Dollhouse / overview — cube house silhouette */
export const iconDollhouse = () =>
  svg(
    'ui-icon-dollhouse',
    '<path d="M3 10.5 12 3.5l9 7"/>' +
      '<path d="M5.5 9.5V20h13V9.5"/>' +
      '<path d="M10 20v-6h4v6"/>',
    18,
  );

/** Floor plan — top-down plan */
export const iconFloorPlan = () =>
  svg(
    'ui-icon-floorplan',
    '<rect x="4" y="4" width="16" height="16" rx="1.5"/>' +
      '<path d="M4 10h16"/>' +
      '<path d="M10 10v10"/>' +
      '<path d="M14 4v6"/>',
    18,
  );

/** Explore / walkthrough — Lucide-style walking person */
export const iconExploreSpace = () =>
  svg(
    'ui-icon-explore-space',
    '<circle cx="13" cy="4" r="2"/>' +
      '<path d="m7 21 3-4"/>' +
      '<path d="m16 21-2-4-3-3 1-6"/>' +
      '<path d="m6 12 2-3 4-1 3 3 3 1"/>',
    18,
  );

/** Hide furniture / defurnish */
export const iconHideFurniture = () =>
  svg(
    'ui-icon-hide-furniture',
    '<path d="M4 14h16v4H4z"/>' +
      '<path d="M6 14V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5"/>' +
      '<path d="M8 18v2"/>' +
      '<path d="M16 18v2"/>' +
      '<line x1="4" y1="4" x2="20" y2="20" stroke-width="2"/>',
    18,
  );

/** Navigation mesh — show overlay (mesh visible) */
export const iconNavMeshShow = () =>
  svg(
    'ui-icon-navmesh-show',
    '<path d="M12 3 4.5 7.5v9L12 21l7.5-4.5v-9L12 3Z"/>' +
      '<path d="M12 12 4.5 7.5"/>' +
      '<path d="M12 12v9"/>' +
      '<path d="M12 12 19.5 7.5"/>',
    18,
  );

/** Navigation mesh — hide overlay (mesh with slash) */
export const iconNavMeshHide = () =>
  svg(
    'ui-icon-navmesh-hide',
    '<path d="M12 3 4.5 7.5v9L12 21l7.5-4.5v-9L12 3Z"/>' +
      '<path d="M12 12 4.5 7.5"/>' +
      '<path d="M12 12v9"/>' +
      '<path d="M12 12 19.5 7.5"/>' +
      '<line x1="4" y1="4" x2="20" y2="20" stroke-width="2.25"/>',
    18,
  );

/** @deprecated use iconNavMeshShow / iconNavMeshHide */
export const iconNavMesh = iconNavMeshShow;

/** Media list — image plane */
export const iconMediaImage = () =>
  svg(
    'ui-icon-media-image',
    '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M5 17L8.5 11.5L11 14L14 10L19 17Z" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.75" fill="currentColor" stroke="none"/>',
    18,
  );

/** Media list — video */
export const iconMediaVideo = () =>
  svg(
    'ui-icon-media-video',
    '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 9.5L21 7v10l-5-2.5V9.5Z"/>',
    18,
  );

/** Media list — 3D model */
export const iconMediaModel = () => iconBox();
