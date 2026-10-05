import type { FloorShape } from './floor2d';

/** A placeable map "material" (furniture, structure, decor, …). */
export type ObjectCatalogItem = {
  /** Stable identifier saved on the block (e.g. "chair", "double-door"). */
  kind: string;
  label: string;
  category: string;
  /** Default footprint in meters (X width × Z depth). */
  w: number;
  d: number;
  shape: FloorShape;
  fill: string;
  stroke: string;
  /** Legacy palette key (symbols are drawn as line art, not emoji). */
  icon: string;
  /** When true, palette shows a count control before placement. */
  countParam?: boolean;
};

export type ObjectCatalogCategory = {
  id: string;
  label: string;
  items: ObjectCatalogItem[];
};

// Clean architectural-drawing look: white fill, dark line work. The distinct
// shape comes from the drawn floor-plan symbol (see objectSymbols.ts), not color.
const CATEGORY_STYLE: Record<string, { fill: string; stroke: string }> = {
  furniture: { fill: '#ffffff', stroke: '#37474f' },
  seating: { fill: '#ffffff', stroke: '#37474f' },
  house: { fill: '#ffffff', stroke: '#37474f' },
  vehicles: { fill: '#ffffff', stroke: '#37474f' },
  event: { fill: '#ffffff', stroke: '#37474f' },
  structure: { fill: '#ffffff', stroke: '#37474f' },
  decor: { fill: '#ffffff', stroke: '#37474f' },
  facilities: { fill: '#ffffff', stroke: '#37474f' },
};

function item(
  category: string,
  kind: string,
  label: string,
  icon: string,
  w: number,
  d: number,
  shape: FloorShape = 'rectangle',
  countParam = false,
): ObjectCatalogItem {
  const style = CATEGORY_STYLE[category] ?? { fill: '#eeeeee', stroke: '#9e9e9e' };
  return { kind, label, category, w, d, shape, fill: style.fill, stroke: style.stroke, icon, countParam };
}

/** Single chair cell size in meters (used for grid layout). */
export const CHAIR_ROW_UNIT = 0.5;
export const CHAIR_ROW_GAP = 0.08;
export const CHAIR_ROW_MAX = 100;

/** Choose cols×rows for N chairs, matching the drawn rectangle aspect. */
export function chairGridDims(count: number, aspectWoverD = 1): { cols: number; rows: number } {
  const n = Math.max(1, Math.min(CHAIR_ROW_MAX, Math.round(count)));
  const aspect = Math.max(0.15, aspectWoverD);
  let bestCols = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const gridAspect = cols / rows;
    const empty = cols * rows - n;
    const aspectErr = Math.abs(Math.log(gridAspect / aspect));
    const score = aspectErr * 2 + empty * 0.12;
    if (score < bestScore) {
      bestScore = score;
      bestCols = cols;
    }
  }
  return { cols: bestCols, rows: Math.ceil(n / bestCols) };
}

/** Default footprint for click-to-place (near-square grid). */
export function chairGridFootprint(count: number): { w: number; d: number } {
  const n = Math.max(1, Math.min(CHAIR_ROW_MAX, Math.round(count)));
  const { cols, rows } = chairGridDims(n, 1);
  return {
    w: cols * CHAIR_ROW_UNIT + (cols - 1) * CHAIR_ROW_GAP,
    d: rows * CHAIR_ROW_UNIT + (rows - 1) * CHAIR_ROW_GAP,
  };
}

/** @deprecated Use chairGridFootprint — kept for existing call sites. */
export function chairRowFootprint(count: number): { w: number; d: number } {
  return chairGridFootprint(count);
}

export const OBJECT_CATALOG: ObjectCatalogCategory[] = [
  {
    id: 'seating',
    label: 'Seating',
    items: [
      item('seating', 'chair', 'Chair', '🪑', 0.5, 0.5),
      item('seating', 'chair-row', 'Chair Grid', '▦', 2.08, 2.08, 'rectangle', true),
      item('seating', 'chair-round', 'Round Chair', '🪑', 0.6, 0.6, 'circle'),
      item('seating', 'armchair', 'Armchair', '🛋️', 0.9, 0.9),
      item('seating', 'sofa', 'Sofa', '🛋️', 2.0, 0.9),
      item('seating', 'bench', 'Bench', '🪑', 1.6, 0.5),
      item('seating', 'stool', 'Stool', '🪑', 0.4, 0.4, 'circle'),
      item('seating', 'seating-block', 'Seating Block', '💺', 4.0, 3.0),
    ],
  },
  {
    id: 'furniture',
    label: 'Furniture',
    items: [
      item('furniture', 'table', 'Table', '🍽️', 1.6, 0.9),
      item('furniture', 'table-round', 'Round Table', '🍽️', 1.2, 1.2, 'circle'),
      item('furniture', 'desk', 'Desk', '🖥️', 1.4, 0.7),
      item('furniture', 'counter', 'Counter', '🧾', 2.0, 0.6),
      item('furniture', 'cabinet', 'Cabinet', '🗄️', 1.0, 0.5),
      item('furniture', 'shelf', 'Shelf', '📚', 1.2, 0.4),
      item('furniture', 'bed', 'Bed', '🛏️', 2.0, 1.6),
      item('furniture', 'wardrobe', 'Wardrobe', '🚪', 1.2, 0.6),
    ],
  },
  {
    id: 'house',
    label: 'House & Home',
    items: [
      item('house', 'bed-single', 'Single Bed', '🛏️', 2.0, 1.0),
      item('house', 'bed-double', 'Double Bed', '🛏️', 2.0, 1.6),
      item('house', 'bed-king', 'King Bed', '🛏️', 2.2, 2.0),
      item('house', 'bunk-bed', 'Bunk Bed', '🛏️', 2.0, 1.0),
      item('house', 'crib', 'Crib', '👶', 1.2, 0.7),
      item('house', 'nightstand', 'Nightstand', '🗄️', 0.5, 0.5),
      item('house', 'dresser', 'Dresser', '🗄️', 1.4, 0.5),
      item('house', 'closet', 'Closet', '🚪', 1.6, 0.6),
      item('house', 'sofa-l', 'L-Sofa', '🛋️', 2.4, 2.0),
      item('house', 'coffee-table', 'Coffee Table', '☕', 1.2, 0.6),
      item('house', 'tv-stand', 'TV Stand', '📺', 1.6, 0.4),
      item('house', 'dining-table', 'Dining Table', '🍽️', 1.8, 1.0),
      item('house', 'kitchen-island', 'Kitchen Island', '🏝️', 2.0, 1.0),
      item('house', 'kitchen-sink', 'Kitchen Sink', '🚰', 0.8, 0.6),
      item('house', 'stove', 'Stove / Hob', '🔥', 0.7, 0.7),
      item('house', 'fridge', 'Fridge', '🧊', 0.7, 0.7),
      item('house', 'dishwasher', 'Dishwasher', '🍽️', 0.6, 0.6),
      item('house', 'washer', 'Washer', '🧺', 0.7, 0.7),
      item('house', 'bathtub', 'Bathtub', '🛁', 1.7, 0.8),
      item('house', 'shower', 'Shower', '🚿', 0.9, 0.9),
      item('house', 'toilet', 'Toilet', '🚽', 0.5, 0.7),
      item('house', 'bathroom-sink', 'Bathroom Sink', '🧼', 0.6, 0.45),
      item('house', 'fireplace', 'Fireplace', '🔥', 1.4, 0.5),
      item('house', 'stairs-house', 'Stairs', '🪜', 1.0, 2.5),
    ],
  },
  {
    id: 'vehicles',
    label: 'Vehicles',
    items: [
      item('vehicles', 'car', 'Car', '🚗', 4.5, 1.9),
      item('vehicles', 'car-compact', 'Compact Car', '🚙', 3.8, 1.7),
      item('vehicles', 'suv', 'SUV', '🚙', 4.8, 2.0),
      item('vehicles', 'van', 'Van', '🚐', 5.2, 2.1),
      item('vehicles', 'bus', 'Bus', '🚌', 10.0, 2.5),
      item('vehicles', 'truck', 'Truck', '🚚', 6.5, 2.4),
      item('vehicles', 'pickup', 'Pickup', '🛻', 5.2, 2.0),
      item('vehicles', 'bike', 'Bicycle', '🚲', 1.8, 0.5),
      item('vehicles', 'motorcycle', 'Motorcycle', '🏍️', 2.2, 0.8),
      item('vehicles', 'scooter', 'Scooter', '🛵', 1.8, 0.7),
      item('vehicles', 'bike-rack', 'Bike Rack', '🚲', 2.5, 1.2),
      item('vehicles', 'parking-spot', 'Parking Spot', '🅿️', 5.0, 2.5),
      item('vehicles', 'ev-parking', 'EV Parking', '🔌', 5.0, 2.5),
      item('vehicles', 'wheelchair-vehicle', 'Wheelchair', '♿', 1.2, 0.7),
      item('vehicles', 'cart', 'Cart / Trolley', '🛒', 1.0, 0.6),
      item('vehicles', 'forklift', 'Forklift', '🏗️', 2.5, 1.2),
    ],
  },
  {
    id: 'event',
    label: 'Event & Expo',
    items: [
      item('event', 'stage', 'Stage', '🎤', 6.0, 4.0),
      item('event', 'podium', 'Podium', '🎙️', 0.7, 0.6),
      item('event', 'booth', 'Booth / Kiosk', '🏬', 3.0, 3.0),
      item('event', 'photo-booth', 'Photo Booth', '📸', 2.0, 2.0),
      item('event', 'reception', 'Reception', '🛎️', 2.5, 1.0),
      item('event', 'bar', 'Bar Counter', '🍸', 3.0, 0.8),
      item('event', 'ticket', 'Ticket Booth', '🎫', 1.6, 1.2),
      item('event', 'coat-check', 'Coat Check', '🧥', 1.8, 0.8),
    ],
  },
  {
    id: 'structure',
    label: 'Structure',
    items: [
      item('structure', 'door', 'Door', '🚪', 0.9, 0.15),
      item('structure', 'double-door', 'Double Door', '🚪', 1.8, 0.15),
      item('structure', 'window', 'Window', '🪟', 1.2, 0.12),
      item('structure', 'wall', 'Wall Segment', '🧱', 2.0, 0.2),
      item('structure', 'pillar', 'Pillar', '⚫', 0.5, 0.5, 'circle'),
      item('structure', 'column', 'Column', '⬛', 0.5, 0.5),
      item('structure', 'railing', 'Railing', '➖', 2.0, 0.1),
      item('structure', 'stairs', 'Stairs', '🪜', 2.0, 3.0),
      item('structure', 'escalator', 'Escalator', '↗️', 1.2, 4.0),
      item('structure', 'elevator', 'Elevator', '🛗', 2.0, 2.0),
    ],
  },
  {
    id: 'decor',
    label: 'Decor',
    items: [
      item('decor', 'plant', 'Plant', '🪴', 0.6, 0.6, 'circle'),
      item('decor', 'tree', 'Tree', '🌳', 1.2, 1.2, 'circle'),
      item('decor', 'billboard', 'Billboard', '🪧', 3.0, 0.4),
      item('decor', 'sign', 'Sign', '🪧', 0.8, 0.3),
      item('decor', 'banner', 'Banner', '🎌', 2.0, 0.2),
      item('decor', 'screen', 'Screen / TV', '📺', 1.6, 0.2),
      item('decor', 'led-wall', 'LED Wall', '🖼️', 4.0, 0.3),
      item('decor', 'fountain', 'Fountain', '⛲', 2.0, 2.0, 'circle'),
      item('decor', 'rug', 'Rug', '🟫', 2.0, 1.4),
      item('decor', 'statue', 'Statue', '🗿', 0.8, 0.8, 'circle'),
    ],
  },
  {
    id: 'facilities',
    label: 'Facilities',
    items: [
      item('facilities', 'charging', 'Charging Point', '🔌', 1.0, 0.6),
      item('facilities', 'charging-station', 'Charging Station', '🔌', 1.8, 1.0),
      item('facilities', 'phone-charging', 'Phone Charging', '📱', 1.2, 0.6),
      item('facilities', 'ev-charger', 'EV Charger', '⚡', 1.2, 1.2),
      item('facilities', 'power-outlet', 'Power Outlet', '🔋', 0.6, 0.4),
      item('facilities', 'usb-hub', 'USB Hub Desk', '🔌', 1.4, 0.7),
      item('facilities', 'wifi', 'Wi‑Fi Hotspot', '📶', 0.6, 0.6, 'circle'),
      item('facilities', 'water-fountain', 'Water Fountain', '💧', 0.6, 0.6),
      item('facilities', 'restroom', 'Restroom', '🚻', 2.0, 2.0),
      item('facilities', 'accessible-restroom', 'Accessible Restroom', '♿', 2.2, 2.2),
      item('facilities', 'baby-changing', 'Baby Changing', '🍼', 1.2, 0.8),
      item('facilities', 'prayer-room', 'Prayer Room', '🙏', 2.5, 2.5),
      item('facilities', 'info', 'Info Desk', 'ℹ️', 1.5, 1.5),
      item('facilities', 'atm', 'ATM', '🏧', 0.8, 0.6),
      item('facilities', 'vending', 'Vending', '🥤', 1.0, 0.8),
      item('facilities', 'printer', 'Printer / Copy', '🖨️', 1.0, 0.8),
      item('facilities', 'trash', 'Trash Bin', '🗑️', 0.5, 0.5, 'circle'),
      item('facilities', 'recycling', 'Recycling Bin', '♻️', 0.5, 0.5, 'circle'),
      item('facilities', 'extinguisher', 'Fire Extinguisher', '🧯', 0.4, 0.4, 'circle'),
      item('facilities', 'first-aid', 'First Aid', '➕', 0.8, 0.6),
      item('facilities', 'aed', 'AED Defibrillator', '❤️', 0.7, 0.5),
      item('facilities', 'locker', 'Lockers', '🔐', 1.5, 0.5),
      item('facilities', 'parcel-locker', 'Parcel Locker', '📦', 1.8, 0.8),
      item('facilities', 'wheelchair', 'Wheelchair Access', '♿', 1.0, 1.0),
      item('facilities', 'smoking', 'Smoking Area', '🚬', 1.2, 1.2, 'circle'),
    ],
  },
];

const CATALOG_BY_KIND = new Map<string, ObjectCatalogItem>();
for (const cat of OBJECT_CATALOG) {
  for (const it of cat.items) CATALOG_BY_KIND.set(it.kind, it);
}

export function getCatalogItem(kind: string | undefined): ObjectCatalogItem | undefined {
  return kind ? CATALOG_BY_KIND.get(kind) : undefined;
}
