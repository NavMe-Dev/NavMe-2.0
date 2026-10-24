/* Venue-scoped Explore presentation; routing and selection stay with the existing UI. */
(function (root) {
  'use strict';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function imageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return /^(https?:\/\/|\/(?!\/)|\.\.?\/)/i.test(value) ? value : null;
  }
  function cards(pois, data, options) {
    const {venue, venueName, thumbnail = () => null, shops = {}, localize = (names, fallback) => fallback} = options;
    if (!data || data.building_slug !== venue) return [];
    const metadata = new Map((data.pois || []).map(p => [String(p.id), p]));
    const seen = new Set();
    return (pois || []).filter(p => {
      if (!p || p.id == null || seen.has(String(p.id)) || !metadata.has(String(p.id))) return false;
      if ((p.building_slug && p.building_slug !== venue) || (p.venue && p.venue !== venue)) return false;
      seen.add(String(p.id)); return true;
    }).map(p => {
      const meta = metadata.get(String(p.id)), shop = shops[String(p.id)] || {};
      return {id: String(p.id), name: localize(meta.names, meta.name || p.name), building: venueName,
        floor: localize(meta.floor_names, meta.floor_name) || null,
        image: imageUrl(meta.image_url) || imageUrl(p.photo_url) || imageUrl(shop.cover_image_url) || imageUrl(thumbnail(p.nearest_node))};
    });
  }
  function gridHtml(items, labels) {
    return `<div class="explore-grid">${items.map(p => `<button type="button" class="explore-card" data-explore-poi="${escape(p.id)}">
      <span class="explore-photo"><span class="ms explore-placeholder" aria-hidden="true">image</span>${p.image ? `<img src="${escape(p.image)}" alt="${escape(p.name)}" loading="lazy" decoding="async">` : ''}</span>
      <span class="explore-card-body"><span class="explore-name">${escape(p.name)}</span>
      <span class="explore-building"><span class="ms" aria-hidden="true">apartment</span><span>${escape(p.building)}</span></span>
      <span class="explore-floor">${escape(p.floor || labels.floorUnavailable)}</span></span></button>`).join('')}</div>`;
  }
  function create({fetchData, apply, now = Date.now}) {
    const cache = new Map(); let venue = null, generation = 0, state = null;
    function publish(next) { state = next; apply(next); }
    async function load(slug, retry = false) {
      const changed = slug !== venue;
      if (changed) {venue = slug; generation++; publish({venue, status: 'loading', data: null});}
      if (!venue) return;
      if (retry) {cache.delete(slug); generation++; publish({venue, status: 'loading', data: null});}
      const ticket = generation;
      let entry = cache.get(slug);
      if (!entry || (entry.expires && entry.expires <= now())) {
        entry = {expires: 0}; cache.set(slug, entry);
        entry.promise = Promise.resolve().then(() => fetchData(slug)).then(data => {
          if (!data || data.building_slug !== slug || !Array.isArray(data.pois) || !Array.isArray(data.facilities)) throw new Error('Invalid venue data');
          entry.data = data; entry.expires = now() + 300000; return data;
        }).catch(error => {if (cache.get(slug) === entry) cache.delete(slug); throw error;});
      }
      try {
        const data = entry.data || await entry.promise;
        if (ticket === generation && slug === venue && (state.status !== 'ready' || state.data !== data)) publish({venue, status: 'ready', data});
      } catch (_) {
        if (ticket === generation && slug === venue) publish({venue, status: 'error', data: null});
      }
      return state;
    }
    return {load, get: () => state};
  }
  const api = {cards, gridHtml, create, imageUrl};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WFExplore = api;
})(typeof window !== 'undefined' ? window : globalThis);
