export type NavmeStringKey =
  | 'pickStartFrom'
  | 'pickDestinationTo'
  | 'tapChangeDestinationTo'
  | 'close'
  | 'from'
  | 'to'
  | 'noNearbyPlaces'
  | 'noMatches'
  | 'filterNearbyPlaceholder'
  | 'searchPlacesPlaceholder'
  | 'selectLabel'
  | 'searchPlaceholder'
  | 'clearLabel'
  | 'openMapAria'
  | 'map3d'
  | 'navigationIn3d'
  | 'statusError'
  | 'statusReady'
  | 'chooseFloor'
  | 'noFloors'
  | 'viewAllFloors'
  | 'searchFromPlaceholder'
  | 'searchToPlaceholder'
  | 'navigateInAr'
  | 'viewInAr'
  | 'view3d'
  | 'view2d'
  | 'view2dLock'
  | 'switchTo2dView'
  | 'lockTopDownView'
  | 'unlockTopDownView'
  | 'openingMap'
  | 'loadingSavedFloorMap'
  | 'fromTapForDestination'
  | 'chooseDifferentDestination'
  | 'tapChooseStartFrom'
  | 'tapChooseDestinationTo'
  | 'mapTapPoiHintFrom'
  | 'mapTapPoiHintTo'
  | 'noNearbyLocation'
  | 'start'
  | 'destinationBadge'
  | 'floor'
  | 'poiType'
  | 'choosePoiType'
  | 'loadingProjects'
  | 'noProjects'
  | 'refresh'
  | 'directions'
  | 'whereToGo'
  | 'findRoute'
  | 'poiTypeRequired'
  | 'navigate'
  | 'tapNavigateForDestination';

const STRINGS: Record<NavmeStringKey, string> = {
  pickStartFrom: 'Tap a place for start',
  pickDestinationTo: 'Tap a place for destination',
  tapChangeDestinationTo: 'Tap to change destination',
  close: 'Close',
  from: 'From',
  to: 'To',
  noNearbyPlaces: 'No nearby places',
  noMatches: 'No matches',
  filterNearbyPlaceholder: 'Filter nearby…',
  searchPlacesPlaceholder: 'Search zones…',
  selectLabel: 'Select {label}',
  searchPlaceholder: 'Search…',
  clearLabel: 'Clear {label}',
  openMapAria: 'Open floor map',
  map3d: 'Map',
  navigationIn3d: 'Navigation',
  statusError: 'Error',
  statusReady: 'Ready',
  chooseFloor: 'Choose floor',
  noFloors: 'No floors',
  viewAllFloors: 'View all floors',
  searchFromPlaceholder: 'Your location',
  searchToPlaceholder: 'Where to?',
  navigateInAr: 'Navigate in AR',
  viewInAr: 'View in AR',
  view3d: '3D Walls',
  view2d: '2D Map',
  view2dLock: '2D',
  switchTo2dView: 'Switch to 2D map view',
  lockTopDownView: 'Open 2D map',
  unlockTopDownView: 'Return to 3D view',
  openingMap: 'Opening map…',
  loadingSavedFloorMap: 'Loading saved floor map…',
  fromTapForDestination: 'From: {label} — tap destination',
  chooseDifferentDestination: 'Choose a different destination',
  tapChooseStartFrom: 'Tap the map to choose start',
  tapChooseDestinationTo: 'Tap the map to choose destination',
  mapTapPoiHintFrom: 'Tap a zone to select start',
  mapTapPoiHintTo: 'Tap a zone to select destination',
  noNearbyLocation: 'No nearby location on this floor',
  start: 'Start',
  destinationBadge: 'Destination',
  floor: 'Floor',
  poiType: 'POI type',
  choosePoiType: 'Choose project…',
  loadingProjects: 'Loading projects…',
  noProjects: 'No projects in navme_logins',
  refresh: 'Refresh',
  directions: 'Directions',
  whereToGo: 'Where do you want to go?',
  findRoute: 'Find Route',
  poiTypeRequired: 'Choose a POI type first',
  navigate: 'Navigate',
  tapNavigateForDestination: 'Tap Navigate to choose destination',
};

type LangListener = () => void;
const listeners = new Set<LangListener>();

export function t(key: NavmeStringKey, vars?: Record<string, string>): string {
  let out = STRINGS[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(`{${k}}`, v);
    }
  }
  return out;
}

export function onNavmeLanguageChange(fn: LangListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const BOTTOM_CHROME_ID = 'nav-bottom-anchor';

/** Bottom chrome container for map toggle (standalone uses #nav-bottom-anchor in index.html). */
export function ensureNavmeBottomChrome(): HTMLElement {
  if (typeof document === 'undefined') {
    throw new Error('document unavailable');
  }
  let el = document.getElementById(BOTTOM_CHROME_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BOTTOM_CHROME_ID;
    el.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:100;display:flex;align-items:flex-end;justify-content:center;padding:12px;pointer-events:none';
    document.body.appendChild(el);
  }
  return el;
}
