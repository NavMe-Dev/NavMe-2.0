/**
 * SVG icon catalog for POI categories (Lucide icons; keys stored in navme_categories.icon_key).
 */
import { icons, createElement } from 'lucide';

const DEFAULT_ICON_KEY = 'map-pin';
const ICON_SIZE = 18;
const SEARCH_RESULT_LIMIT = 120;

/** @typedef {{ key: string, label: string }} CategoryIconOption */

/** Legacy keys from the pre-Lucide catalog → Lucide kebab-case keys. */
const LEGACY_ICON_ALIASES = {
  'map-pin': 'map-pin',
  facility: 'building2',
  media: 'image',
  box: 'box',
  users: 'users',
  eye: 'eye',
  key: 'key-round',
  'editor-3d': 'axis-3d',
  wheelchair: 'accessibility',
  'zone-block': 'ban',
  search: 'search',
  save: 'save',
  image: 'image',
  video: 'video',
  food: 'utensils',
  info: 'info',
  shop: 'store',
  'building-2': 'building2',
  building2: 'building2',
  university: 'school2',
  stars: 'sparkles',
  'paintbrush-vertical': 'paintbrush2',
  museum: 'landmark',
  gallery: 'gallery-horizontal',
  painting: 'palette',
  aerospace: 'rocket',
  institute: 'graduation-cap',
  restroom: 'toilet',
  restrooms: 'toilet',
  toilet: 'toilet',
  bathroom: 'bath',
  bathrooms: 'bath',
  washroom: 'bath',
  washrooms: 'bath',
  shower: 'shower-head',
  pantry: 'refrigerator',
  kitchen: 'utensils',
  cafeteria: 'utensils-crossed',
  canteen: 'utensils-crossed',
  dining: 'utensils-crossed',
  restaurant: 'utensils',
  cafe: 'coffee',
  coffee: 'coffee',
  'break-room': 'coffee',
  breakroom: 'coffee',
  lounge: 'sofa',
  lobby: 'door-open',
  reception: 'concierge-bell',
  conference: 'presentation',
  meeting: 'users',
  'meeting-room': 'users',
  meetingroom: 'users',
  boardroom: 'presentation',
  storage: 'warehouse',
  storeroom: 'warehouse',
  locker: 'lock',
  lockers: 'lock',
  laundry: 'washing-machine',
  gym: 'dumbbell',
  fitness: 'dumbbell',
  vending: 'cup-soda',
  water: 'droplets',
  fountain: 'glass-water',
  nursery: 'baby',
  'mothers-room': 'baby',
  medical: 'stethoscope',
  clinic: 'stethoscope',
  pharmacy: 'pill',
  firstaid: 'cross',
  'first-aid': 'cross',
  printer: 'printer',
  copyroom: 'printer',
  'copy-room': 'printer',
  mailroom: 'mail',
  mail: 'mail',
  entrance: 'door-open',
  exit: 'door-closed',
  elevator: 'move-vertical',
  lift: 'move-vertical',
  stairs: 'footprints',
  stair: 'footprints',
  stairway: 'footprints',
  parking: 'circle-parking',
  garage: 'square-parking',
  security: 'shield',
  prayer: 'church',
  chapel: 'church',
  smoking: 'cigarette',
  expo: 'presentation',
  'ar-expo': 'glasses',
  arexpo: 'scan-eye',
  registration: 'clipboard-check',
  register: 'clipboard-check',
  checkin: 'clipboard-check',
  'check-in': 'clipboard-check',
  'badge-pickup': 'id-card',
  badge: 'badge-check',
  stage: 'mic-vocal',
  'main-stage': 'mic-vocal',
  keynote: 'mic-vocal',
  auditorium: 'theater',
  breakout: 'door-open',
  'breakout-rooms': 'door-open',
  'breakout-room': 'door-open',
  workshop: 'presentation',
  session: 'presentation',
  lunch: 'utensils-crossed',
  'dining-lunch': 'utensils-crossed',
  breakfast: 'coffee',
  brunch: 'utensils-crossed',
  networking: 'handshake',
  'networking-lounge': 'coffee',
  helpdesk: 'info',
  'help-desk': 'info',
  help: 'circle-help',
  information: 'info',
  infodesk: 'info',
  'info-desk': 'info',
  emergency: 'siren',
  'emergency-exit': 'log-out',
  'emergency-exits': 'log-out',
  evacuation: 'siren',
  'fire-exit': 'log-out',
  assembly: 'users',
  'assembly-point': 'map-pin',
  charging: 'battery-charging',
  'charging-station': 'battery-charging',
  wifi: 'wifi',
  av: 'projector',
  'av-desk': 'projector',
  press: 'mic',
  'press-room': 'mic',
  'green-room': 'sofa',
  'coat-check': 'shirt',
  'lost-and-found': 'package-search',
  vendor: 'store',
  booth: 'layout-grid',
  exhibitor: 'layout-template',
  sponsor: 'award',
  vip: 'crown',
  shuttle: 'bus',
  taxi: 'car',
  transport: 'bus',
  queue: 'users',
  waiting: 'armchair',
  queueing: 'users',
  museum: 'landmark',
  gallery: 'gallery-horizontal',
  exhibition: 'gallery-horizontal',
  painting: 'palette',
  paint: 'paintbrush',
  artwork: 'frame',
  art: 'palette',
  sculpture: 'landmark',
  culture: 'landmark',
  heritage: 'landmark',
  institute: 'graduation-cap',
  institution: 'building',
  academy: 'graduation-cap',
  college: 'school2',
  campus: 'school',
  research: 'microscope',
  laboratory: 'flask-conical',
  lab: 'flask-conical',
  library: 'library',
  education: 'book-open',
  aerospace: 'rocket',
  aviation: 'plane',
  aircraft: 'plane',
  airport: 'plane-takeoff',
  astronomy: 'telescope',
  observatory: 'telescope',
  planet: 'orbit',
  cosmos: 'sparkles',
  nasa: 'rocket',
  science: 'atom',
  planetarium: 'orbit',
};

/** Search boosts — typing these terms surfaces curated expo / AR expo icons. */
const ICON_SEARCH_KEYWORD_BOOSTS = {
  expo: [
    'tent',
    'tent-tree',
    'ticket',
    'tickets',
    'podium',
    'presentation',
    'projector',
    'spotlight',
    'theater',
    'party-popper',
    'handshake',
    'megaphone',
    'badge',
    'gallery-horizontal',
    'gallery-thumbnails',
    'layout-template',
    'monitor-play',
    'users',
    'users-round',
    'globe',
    'rocket',
    'signpost',
    'store',
    'building2',
    'flag',
    'mic',
  ],
  exhibition: [
    'tent',
    'presentation',
    'podium',
    'projector',
    'spotlight',
    'theater',
    'gallery-horizontal',
    'layout-template',
    'ticket',
    'handshake',
  ],
  tradeshow: [
    'tent',
    'presentation',
    'store',
    'badge',
    'handshake',
    'users',
    'megaphone',
    'ticket',
  ],
  'ar expo': [
    'glasses',
    'hat-glasses',
    'scan-eye',
    'scan-face',
    'scan-line',
    'scan-qr-code',
    'headset',
    'view',
    'cuboid',
    'axis-3d',
    'box',
    'boxes',
    'monitor-play',
    'projector',
    'presentation',
    'spotlight',
    'layout-grid',
    'sparkles',
    'wand-sparkles',
    'smartphone',
    'tablet-smartphone',
    'bot',
    'lightbulb',
    'scan',
  ],
  arexpo: [
    'glasses',
    'scan-eye',
    'headset',
    'view',
    'cuboid',
    'axis-3d',
    'monitor-play',
    'projector',
    'sparkles',
    'wand-sparkles',
  ],
  immersive: [
    'glasses',
    'headset',
    'view',
    'cuboid',
    'axis-3d',
    'scan-eye',
    'monitor-play',
    'sparkles',
  ],
  restroom: ['toilet', 'bath', 'shower-head', 'accessibility'],
  bathroom: ['bath', 'shower-head', 'toilet', 'droplets'],
  washroom: ['bath', 'shower-head', 'toilet'],
  pantry: ['refrigerator', 'microwave', 'utensils', 'chef-hat', 'coffee', 'sandwich', 'cookie'],
  kitchen: ['utensils', 'chef-hat', 'microwave', 'refrigerator', 'sandwich'],
  cafeteria: ['utensils-crossed', 'utensils', 'coffee', 'sandwich'],
  laundry: ['washing-machine', 'shirt', 'wind'],
  lounge: ['sofa', 'armchair', 'coffee', 'users'],
  meeting: ['users', 'presentation', 'monitor', 'briefcase'],
  conference: ['presentation', 'users', 'monitor', 'mic'],
  reception: ['concierge-bell', 'door-open', 'users'],
  lobby: ['door-open', 'sofa', 'concierge-bell'],
  storage: ['warehouse', 'package', 'archive', 'boxes'],
  locker: ['lock', 'key-round', 'lock-keyhole'],
  vending: ['cup-soda', 'coffee', 'sandwich', 'cookie'],
  medical: ['stethoscope', 'heart-pulse', 'pill', 'cross', 'hospital'],
  printer: ['printer', 'copy', 'file-text'],
  mailroom: ['mail', 'mailbox', 'mails', 'package'],
  parking: ['circle-parking', 'square-parking', 'car', 'truck'],
  elevator: ['move-vertical', 'arrow-up-down'],
  stairs: ['footprints', 'move-vertical'],
  gym: ['dumbbell', 'heart-pulse', 'activity'],
  nursery: ['baby', 'heart', 'accessibility'],
  registration: ['clipboard-check', 'clipboard-list', 'ticket-check', 'id-card', 'badge-check'],
  register: ['clipboard-check', 'ticket-check', 'id-card', 'badge-check'],
  stage: ['mic-vocal', 'mic', 'podium', 'spotlight', 'theater', 'presentation'],
  keynote: ['mic-vocal', 'mic', 'podium', 'spotlight', 'presentation'],
  breakout: ['door-open', 'layout-grid', 'users', 'presentation'],
  dining: ['utensils-crossed', 'utensils', 'chef-hat', 'wine', 'coffee'],
  lunch: ['utensils-crossed', 'utensils', 'sandwich', 'coffee'],
  networking: ['handshake', 'coffee', 'users-round', 'users', 'wine'],
  help: ['info', 'circle-help', 'badge-help', 'concierge-bell', 'hand-helping'],
  'help desk': ['info', 'circle-help', 'concierge-bell', 'badge-help'],
  emergency: ['siren', 'log-out', 'fire-extinguisher', 'door-closed', 'shield-alert'],
  exit: ['log-out', 'door-closed', 'arrow-right-from-line', 'siren'],
  pantry: ['refrigerator', 'microwave', 'utensils', 'chef-hat', 'coffee', 'sandwich', 'cookie', 'cup-soda'],
  charging: ['battery-charging', 'plug', 'plug-zap', 'smartphone-charging'],
  transport: ['bus', 'car', 'train', 'plane', 'tram-front', 'circle-parking'],
  vendor: ['store', 'shopping-bag', 'layout-grid', 'badge'],
  sponsor: ['award', 'trophy', 'medal', 'handshake', 'star'],
  vip: ['crown', 'gem', 'sparkles', 'sofa', 'wine'],
  workshop: ['presentation', 'lightbulb', 'users', 'monitor', 'book-open'],
  press: ['mic', 'camera', 'video', 'newspaper'],
  safety: ['shield-alert', 'siren', 'fire-extinguisher', 'cross', 'heart-pulse'],
  museum: [
    'landmark',
    'gallery-horizontal',
    'gallery-vertical',
    'frame',
    'palette',
    'paintbrush',
    'image',
    'images',
    'scroll',
    'book-image',
    'columns',
    'pyramid',
    'castle',
    'ticket',
    'camera',
  ],
  gallery: [
    'gallery-horizontal',
    'gallery-vertical',
    'gallery-thumbnails',
    'frame',
    'image',
    'images',
    'palette',
    'paintbrush',
  ],
  painting: [
    'palette',
    'paintbrush',
    'paintbrush2',
    'brush',
    'paint-bucket',
    'paint-roller',
    'swatch-book',
    'frame',
    'image',
    'images',
    'pen-tool',
  ],
  art: [
    'palette',
    'paintbrush',
    'brush',
    'frame',
    'image',
    'swatch-book',
    'sparkles',
    'pen-tool',
    'pencil',
  ],
  institute: [
    'graduation-cap',
    'school2',
    'school',
    'building',
    'building2',
    'book-open',
    'library',
    'library-big',
    'microscope',
    'flask-conical',
    'atom',
    'presentation',
    'briefcase',
    'landmark',
  ],
  education: [
    'graduation-cap',
    'school2',
    'school',
    'book-open',
    'book-text',
    'library',
    'notebook-pen',
    'presentation',
    'microscope',
  ],
  research: [
    'microscope',
    'flask-conical',
    'beaker',
    'atom',
    'telescope',
    'binoculars',
    'book-open',
    'lightbulb',
  ],
  space: [
    'rocket',
    'orbit',
    'satellite',
    'satellite-dish',
    'telescope',
    'atom',
    'earth',
    'globe',
    'moon',
    'moon-star',
    'sparkles',
    'eclipse',
    'sun-moon',
    'radar',
    'antenna',
    'space',
    'astroid',
  ],
  aerospace: [
    'rocket',
    'plane',
    'plane-takeoff',
    'plane-landing',
    'orbit',
    'satellite',
    'satellite-dish',
    'radar',
    'antenna',
    'telescope',
    'globe',
    'earth',
    'navigation',
    'compass',
  ],
  astronomy: [
    'telescope',
    'orbit',
    'moon-star',
    'sparkles',
    'eclipse',
    'sun-moon',
    'satellite',
    'binoculars',
  ],
  aviation: [
    'plane',
    'plane-takeoff',
    'plane-landing',
    'tickets-plane',
    'radar',
    'navigation',
    'compass',
    'globe',
  ],
};

/** Curated browse groups — search still searches the full Lucide set. */
const CATEGORY_ICON_GROUP_DEFS = [
  {
    id: 'event-venue',
    label: 'Event venue & wayfinding',
    keys: [
      'clipboard-check',
      'mic-vocal',
      'door-open',
      'utensils-crossed',
      'coffee',
      'toilet',
      'info',
      'log-out',
      'refrigerator',
      'handshake',
      'ticket',
      'ticket-check',
      'id-card',
      'badge-check',
      'presentation',
      'podium',
      'spotlight',
      'theater',
      'layout-grid',
      'users-round',
      'circle-help',
      'concierge-bell',
      'siren',
      'fire-extinguisher',
      'shield-alert',
      'arrow-right-from-line',
      'door-closed',
      'signpost',
      'flag',
      'map-pin',
      'microwave',
      'chef-hat',
      'utensils',
      'sandwich',
      'wine',
      'sofa',
      'armchair',
      'wifi',
      'battery-charging',
      'plug',
      'circle-parking',
      'bus',
      'car',
      'luggage',
      'store',
      'award',
      'crown',
      'gift',
      'camera',
      'video',
      'projector',
      'megaphone',
      'cross',
      'stethoscope',
      'heart-pulse',
      'accessibility',
      'move-vertical',
      'footprints',
      'baby',
      'lock',
      'mailbox',
      'printer',
      'package',
      'trees',
      'qr-code',
      'scan-line',
    ],
  },
  {
    id: 'food-beverage',
    label: 'Food, pantry & dining',
    keys: [
      'utensils-crossed',
      'utensils',
      'refrigerator',
      'microwave',
      'chef-hat',
      'coffee',
      'cup-soda',
      'glass-water',
      'wine',
      'beer',
      'sandwich',
      'cookie',
      'pizza',
      'apple',
      'milk',
      'egg-fried',
      'cooking-pot',
      'cake-slice',
      'ice-cream-cone',
      'popcorn',
    ],
  },
  {
    id: 'safety-services',
    label: 'Safety, help & services',
    keys: [
      'info',
      'circle-help',
      'badge-help',
      'concierge-bell',
      'hand-helping',
      'siren',
      'log-out',
      'fire-extinguisher',
      'shield-alert',
      'shield-check',
      'cross',
      'stethoscope',
      'heart-pulse',
      'pill',
      'hospital',
      'accessibility',
      'baby',
      'bell',
      'bell-ring',
      'phone',
      'mail',
      'printer',
      'wifi',
      'battery-charging',
      'plug',
    ],
  },
  {
    id: 'places',
    label: 'Places & buildings',
    keys: [
      'map-pin',
      'map-pinned',
      'map-pin-house',
      'home',
      'building',
      'building2',
      'hotel',
      'warehouse',
      'factory',
      'store',
      'school',
      'university',
      'hospital',
      'church',
      'landmark',
      'land-plot',
      'tent',
      'castle',
      'columns',
      'pyramid',
      'library',
      'graduation-cap',
    ],
  },
  {
    id: 'museum-art',
    label: 'Museum, art & culture',
    keys: [
      'landmark',
      'gallery-horizontal',
      'gallery-vertical',
      'gallery-thumbnails',
      'palette',
      'paintbrush',
      'paintbrush2',
      'brush',
      'paint-bucket',
      'paint-roller',
      'swatch-book',
      'frame',
      'image',
      'images',
      'book-image',
      'scroll',
      'columns',
      'pyramid',
      'castle',
      'theater',
      'clapperboard',
      'film',
      'camera',
      'ticket',
      'sparkles',
      'pen-tool',
      'pencil',
      'notebook-pen',
    ],
  },
  {
    id: 'institute-education',
    label: 'Institute & education',
    keys: [
      'graduation-cap',
      'school2',
      'school',
      'building',
      'building2',
      'landmark',
      'library',
      'library-big',
      'book-open',
      'book-text',
      'book-marked',
      'notebook',
      'notebook-pen',
      'presentation',
      'briefcase',
      'microscope',
      'flask-conical',
      'beaker',
      'atom',
      'lightbulb',
      'users',
      'clipboard-list',
      'award',
      'medal',
      'trophy',
    ],
  },
  {
    id: 'space-aerospace',
    label: 'Space & aerospace',
    keys: [
      'rocket',
      'orbit',
      'satellite',
      'satellite-dish',
      'telescope',
      'atom',
      'earth',
      'globe',
      'moon',
      'moon-star',
      'sparkles',
      'eclipse',
      'sun-moon',
      'space',
      'astroid',
      'radar',
      'antenna',
      'plane',
      'plane-takeoff',
      'plane-landing',
      'tickets-plane',
      'navigation',
      'compass',
      'binoculars',
      'cpu',
      'bot',
      'circuit-board',
    ],
  },
  {
    id: 'hospitality',
    label: 'Hospitality & residence',
    keys: [
      'bed',
      'bed-double',
      'bed-single',
      'house-heart',
      'house-wifi',
      'concierge-bell',
      'luggage',
      'bath',
      'coffee',
      'utensils',
      'utensils-crossed',
      'wine',
      'sofa',
      'armchair',
      'door-open',
      'door-closed',
    ],
  },
  {
    id: 'industry',
    label: 'Industry & manufacturing',
    keys: [
      'factory',
      'warehouse',
      'hard-hat',
      'construction',
      'forklift',
      'truck',
      'truck-electric',
      'hammer',
      'drill',
      'anvil',
      'pickaxe',
      'cog',
      'boxes',
      'package',
      'container',
      'barrel',
      'weight',
      'ruler',
      'wrench',
      'pipeline',
    ],
  },
  {
    id: 'ar-tech',
    label: 'AR, tech & navigation',
    keys: [
      'glasses',
      'scan',
      'scan-eye',
      'scan-line',
      'scan-qr-code',
      'view',
      'axis-3d',
      'box',
      'layers',
      'monitor',
      'smartphone',
      'cpu',
      'bot',
      'sparkles',
      'navigation',
      'compass',
      'route',
      'map',
      'locate-fixed',
    ],
  },
  {
    id: 'expo',
    label: 'Expo & events',
    keys: [
      'tent',
      'tent-tree',
      'ticket',
      'tickets',
      'podium',
      'presentation',
      'projector',
      'spotlight',
      'theater',
      'party-popper',
      'handshake',
      'megaphone',
      'badge',
      'gallery-horizontal',
      'gallery-thumbnails',
      'layout-template',
      'monitor-play',
      'users',
      'users-round',
      'globe',
      'rocket',
      'signpost',
      'flag',
      'store',
      'mic',
      'lightbulb',
    ],
  },
  {
    id: 'ar-expo',
    label: 'AR expo & immersive',
    keys: [
      'glasses',
      'hat-glasses',
      'scan-eye',
      'scan-face',
      'scan-line',
      'scan-qr-code',
      'headset',
      'view',
      'cuboid',
      'axis-3d',
      'box',
      'boxes',
      'monitor-play',
      'projector',
      'presentation',
      'spotlight',
      'layout-grid',
      'sparkles',
      'wand-sparkles',
      'smartphone',
      'tablet-smartphone',
      'bot',
      'lightbulb',
      'scan',
      'cpu',
    ],
  },
  {
    id: 'workplace-amenities',
    label: 'Restroom, pantry & workplace',
    keys: [
      'toilet',
      'bath',
      'shower-head',
      'refrigerator',
      'microwave',
      'utensils',
      'utensils-crossed',
      'chef-hat',
      'coffee',
      'sandwich',
      'cookie',
      'cup-soda',
      'glass-water',
      'droplets',
      'washing-machine',
      'sofa',
      'armchair',
      'door-open',
      'door-closed',
      'concierge-bell',
      'presentation',
      'users',
      'printer',
      'mail',
      'mailbox',
      'warehouse',
      'package',
      'lock',
      'baby',
      'stethoscope',
      'heart-pulse',
      'pill',
      'cross',
      'dumbbell',
      'cigarette',
    ],
  },
  {
    id: 'facilities',
    label: 'Amenities & access',
    keys: [
      'toilet',
      'bath',
      'shower-head',
      'accessibility',
      'move-vertical',
      'footprints',
      'circle-parking',
      'square-parking',
      'door-open',
      'shield',
      'shield-ban',
      'ban',
      'key-round',
      'badge-check',
      'info',
      'circle-help',
      'bell',
      'wifi',
      'refrigerator',
      'microwave',
      'washing-machine',
      'concierge-bell',
    ],
  },
  {
    id: 'retail-food',
    label: 'Retail, food & services',
    keys: [
      'shopping-bag',
      'shopping-cart',
      'store',
      'receipt',
      'credit-card',
      'banknote',
      'scissors',
      'stethoscope',
      'pill',
      'heart-pulse',
      'dumbbell',
      'trees',
      'flower-2',
      'dog',
      'cat',
      'baby',
    ],
  },
  {
    id: 'media',
    label: 'Media & signage',
    keys: [
      'image',
      'images',
      'video',
      'clapperboard',
      'camera',
      'mic',
      'volume-2',
      'presentation',
      'megaphone',
      'signpost',
      'flag',
      'bookmark',
    ],
  },
];

function pascalToKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function kebabToLabel(key) {
  return key
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** @returns {Map<string, import('lucide').IconNode>} */
function buildIconNodeMap() {
  /** @type {Map<string, import('lucide').IconNode>} */
  const keyToNode = new Map();
  const nodeSigToKey = new Map();

  for (const [pascalName, node] of Object.entries(icons)) {
    const key = pascalToKebab(pascalName);
    const sig = JSON.stringify(node);
    if (!nodeSigToKey.has(sig)) {
      nodeSigToKey.set(sig, key);
      keyToNode.set(key, node);
    }
  }

  return keyToNode;
}

const iconNodeByKey = buildIconNodeMap();

/** @type {CategoryIconOption[]} */
const allIconOptions = [...iconNodeByKey.keys()]
  .sort((a, b) => a.localeCompare(b))
  .map((key) => ({ key, label: kebabToLabel(key) }));

/** @param {string[]} keys */
function toExistingOptions(keys) {
  const seen = new Set();
  /** @type {CategoryIconOption[]} */
  const options = [];

  for (const rawKey of keys) {
    const normalized = normalizeCategoryKey(rawKey);
    const alias = LEGACY_ICON_ALIASES[normalized] ?? LEGACY_ICON_ALIASES[String(rawKey ?? '').trim()];
    const candidate = alias || normalized;
    // Skip unknown keys (don't silently collapse them to the default map-pin).
    if (!iconNodeByKey.has(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    options.push({ key: candidate, label: kebabToLabel(candidate) });
  }

  return options;
}

/** @type {{ id: string, label: string, icons: CategoryIconOption[] }[]} */
export const CATEGORY_ICON_GROUPS = CATEGORY_ICON_GROUP_DEFS.map((group) => ({
  id: group.id,
  label: group.label,
  icons: toExistingOptions(group.keys),
})).filter((group) => group.icons.length > 0);

export const CATEGORY_ICON_COUNT = iconNodeByKey.size;

function normalizeCategoryKey(key) {
  return String(key ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

/** @param {string | null | undefined} key */
function resolveIconKey(key) {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return DEFAULT_ICON_KEY;

  const normalized = normalizeCategoryKey(trimmed);
  const alias = LEGACY_ICON_ALIASES[normalized] ?? LEGACY_ICON_ALIASES[trimmed];
  if (alias && iconNodeByKey.has(alias)) return alias;
  if (iconNodeByKey.has(normalized)) return normalized;
  if (iconNodeByKey.has(trimmed)) return trimmed;

  return DEFAULT_ICON_KEY;
}

/** @param {string} key @param {number} [size] */
function renderLucideIcon(key, size = ICON_SIZE) {
  const resolved = resolveIconKey(key);
  const node = iconNodeByKey.get(resolved);
  if (!node) return renderLucideIcon(DEFAULT_ICON_KEY, size);

  const svg = createElement(node, {
    width: size,
    height: size,
    class: 'ui-icon category-lucide-icon',
    'aria-hidden': 'true',
  });

  return svg.outerHTML;
}

export function getDefaultCategoryIconKey() {
  return DEFAULT_ICON_KEY;
}

/** @param {string | null | undefined} key @param {string} [fallbackKey] */
export function renderCategoryIcon(key, fallbackKey = DEFAULT_ICON_KEY) {
  const resolved = resolveIconKey(key);
  if (iconNodeByKey.has(resolved)) return renderLucideIcon(resolved);
  return renderLucideIcon(fallbackKey);
}

/** @param {string | null | undefined} key */
export function getCategoryIconLabel(key) {
  return kebabToLabel(resolveIconKey(key));
}

/**
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {CategoryIconOption[]}
 */
export function searchCategoryIcons(query, options = {}) {
  const limit = options.limit ?? SEARCH_RESULT_LIMIT;
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const seen = new Set();
  /** @type {CategoryIconOption[]} */
  const results = [];

  const addKey = (key) => {
    const resolved = resolveIconKey(key);
    if (!iconNodeByKey.has(resolved) || seen.has(resolved)) return;
    seen.add(resolved);
    results.push({ key: resolved, label: kebabToLabel(resolved) });
  };

  const keywordMatchesQuery = (keyword, searchQuery) => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    const normalizedSearch = searchQuery.trim().toLowerCase();
    if (!normalizedSearch) return false;
    if (normalizedSearch === normalizedKeyword) return true;
    if (normalizedKeyword.includes(' ')) {
      return (
        normalizedSearch.includes(normalizedKeyword) ||
        normalizedSearch.replace(/\s+/g, '') === normalizedKeyword.replace(/\s+/g, '')
      );
    }
    if (normalizedKeyword.startsWith(normalizedSearch) && normalizedSearch.length >= 3) return true;
    if (normalizedSearch.includes(normalizedKeyword)) return true;
    return false;
  };

  const keywordMatches = Object.entries(ICON_SEARCH_KEYWORD_BOOSTS)
    .filter(([keyword]) => keywordMatchesQuery(keyword, q))
    .sort((a, b) => b[0].length - a[0].length);

  const activeKeywordBoosts = keywordMatches.filter(([keyword], _, matches) => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return !matches.some(([other]) => {
      if (other === keyword) return false;
      const normalizedOther = other.trim().toLowerCase();
      return (
        normalizedOther.includes(normalizedKeyword) &&
        normalizedOther.length > normalizedKeyword.length &&
        keywordMatchesQuery(other, q)
      );
    });
  });

  for (const [, keys] of activeKeywordBoosts) {
    for (const key of keys) addKey(key);
  }

  for (const option of allIconOptions) {
    if (option.key.includes(q) || option.label.toLowerCase().includes(q)) {
      addKey(option.key);
    }
    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

/**
 * Sections for the icon picker UI.
 * @param {string} [query]
 * @returns {{ id: string, label: string, icons: CategoryIconOption[] }[]}
 */
export function getCategoryIconPickerSections(query = '') {
  const trimmed = query.trim();
  if (trimmed) {
    const iconsFound = searchCategoryIcons(trimmed);
    if (!iconsFound.length) {
      return [{ id: 'empty', label: 'No icons found', icons: [] }];
    }
    return [{ id: 'search', label: `Results (${iconsFound.length})`, icons: iconsFound }];
  }

  return CATEGORY_ICON_GROUPS;
}
