export type NavmePoiLocalized = {
  defaultName: string;
  names: Record<string, string>;
  name: string;
};

export function getPoiDisplayName(poi: NavmePoiLocalized, lang = 'en'): string {
  const localized = poi.names[lang]?.trim();
  if (localized) return localized;
  return poi.defaultName?.trim() || poi.name?.trim() || 'POI';
}

export function parsePoiNamesFromRow(row: Record<string, unknown>): {
  defaultName: string;
  names: Record<string, string>;
} {
  const defaultName = String(row.name ?? row.poi_name ?? row.title ?? '').trim();
  const names: Record<string, string> = {};
  const rawNames = row.names ?? row.localized_names;
  if (rawNames && typeof rawNames === 'object' && !Array.isArray(rawNames)) {
    for (const [k, v] of Object.entries(rawNames as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) names[k] = v.trim();
    }
  }
  if (defaultName) names.en = names.en ?? defaultName;
  return { defaultName: defaultName || 'POI', names };
}

export function applyPoiDisplayNames<T extends NavmePoiLocalized>(pois: T[], lang = 'en'): T[] {
  for (let i = 0; i < pois.length; i++) {
    pois[i].name = getPoiDisplayName(pois[i], lang);
  }
  return pois;
}

export function poiMatchesQuery(poi: NavmePoiLocalized, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (poi.name.toLowerCase().includes(q)) return true;
  if (poi.defaultName.toLowerCase().includes(q)) return true;
  for (const v of Object.values(poi.names)) {
    if (v.toLowerCase().includes(q)) return true;
  }
  return false;
}
