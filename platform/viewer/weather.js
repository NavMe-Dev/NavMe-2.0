/* Shared, optional venue weather. Never reads navigator.geolocation. */
(function (root) {
  "use strict";
  function create({ fetchWeather, apply, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, isActive = () => true }) {
    const cache = new Map();
    let venue = null, generation = 0, value = null, timer = null, disposed = false;
    function pause() { if (timer !== null) clearTimer(timer); timer = null; }
    async function refresh(ticket) {
      if (disposed || !venue || !isActive()) return;
      const slug = venue;
      let entry = cache.get(slug);
      if (!entry || entry.expires <= now()) {
        if (!entry || !entry.promise) {
          entry = { expires: 0 };
          entry.promise = Promise.resolve().then(() => fetchWeather(slug)).then(data => {
            if (data.building_slug !== slug) throw new Error("Weather venue mismatch");
            if (data.available && (typeof data.temperature_c !== "number" || !Number.isFinite(data.temperature_c))) throw new Error("Invalid temperature");
            return data;
          }).catch(() => ({ building_slug: slug, available: false, cache_seconds: 60 })).then(data => {
            entry.data = data;
            entry.expires = now() + Math.max(60000, Math.min(900000, (Number(data.cache_seconds) || 900) * 1000));
            entry.promise = null;
            return entry;
          });
          cache.set(slug, entry);
        }
        await entry.promise;
      }
      if (disposed || ticket !== generation || slug !== venue) return;
      if (value !== entry.data) { value = entry.data; apply(value); }
      pause();
      if (isActive()) timer = setTimer(() => { timer = null; void refresh(generation); }, Math.max(1, entry.expires - now()));
      return value;
    }
    function setVenue(slug) {
      if (disposed) return Promise.resolve();
      const next = typeof slug === "string" ? slug : null;
      if (next !== venue) { venue = next; generation++; pause(); value = null; apply(null); }
      return refresh(generation);
    }
    function resume() { if (timer === null) return refresh(generation); }
    return { setVenue, resume, pause, get: () => value, dispose() { disposed = true; generation++; pause(); } };
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = { create }; return; }
  const doc = root.document;
  const row = doc.getElementById("weatherRow"), badge = doc.getElementById("weatherBadge");
  const sidebar = doc.getElementById("sidebarWeather"), summary = doc.getElementById("sidebarWeatherSummary");
  if (!row || !badge) return;
  let data = null, updateFrame = null;
  function immersive() {
    const body = doc.body.classList, bundle = doc.getElementById("bundleOverlay");
    return body.contains("nav") || body.contains("dir") || body.contains("n3d-open")
      || !!doc.fullscreenElement || !!root.__WF_MP_TOUR_PAGE || !!root.__WF_NAV_WALKTHROUGH_PAGE
      || !!(bundle && !bundle.hidden);
  }
  function notify() { root.dispatchEvent(new Event("wf-weather-updated")); }
  function updateVisibility() {
    const popup = doc.querySelector('#acList:not([hidden]),#chipsDropdown:not([hidden]),.pop:not([hidden]),.loc-modal:not([hidden]),#drawer:not([hidden])');
    const visible = !!(data && data.available) && !immersive() && !popup;
    if (row.hidden !== !visible) row.hidden = !visible;
    if (doc.body.classList.contains("weather-visible") !== visible) {
      doc.body.classList.toggle("weather-visible", visible); notify();
    }
  }
  function display(next) {
    data = next;
    const available = !!(data && data.available);
    const temperature = available ? Math.round(data.temperature_c) + "°C" : "";
    const condition = available ? String(data.condition || "Outdoor weather") : "Unavailable";
    badge.querySelector("[data-weather-temperature]").textContent = temperature;
    badge.querySelector("[data-weather-icon]").textContent = available && /^[a-z_]+$/.test(data.icon) ? data.icon : "device_thermostat";
    badge.setAttribute("aria-label", `Outdoor weather: ${temperature} ${condition}`);
    badge.title = `Outdoor weather · ${temperature} · ${condition}`;
    if (sidebar) {
      sidebar.hidden = !data;
      summary.textContent = available ? `${temperature} · ${condition}` : "Unavailable";
      const credit = doc.getElementById("weatherCredit"); if (credit) credit.hidden = !available;
    }
    updateVisibility(); notify();
  }
  const controller = create({
    fetchWeather: async slug => {
      const base = ((root.WF_CONFIG && root.WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
      const response = await fetch(base + "buildings/" + encodeURIComponent(slug) + "/weather");
      if (!response.ok) throw new Error("Weather unavailable");
      return response.json();
    }, apply: display, isActive: () => !doc.hidden && !immersive(),
  });
  function context() {
    const wf = root.WF || {};
    return (wf.building && wf.building.slug) || (wf.cfg && wf.cfg.slug) || null;
  }
  function changed() { void controller.setVenue(context()); }
  function environment() {
    if (updateFrame !== null) return;
    updateFrame = root.requestAnimationFrame(() => {
      updateFrame = null; updateVisibility();
      if (doc.hidden || immersive()) controller.pause(); else void controller.resume();
    });
  }
  const observer = new MutationObserver(environment);
  observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
  doc.addEventListener("visibilitychange", environment);
  doc.addEventListener("fullscreenchange", environment);
  doc.addEventListener("click", environment);
  doc.addEventListener("keydown", environment);
  root.addEventListener("wf-pois-updated", changed);
  root.addEventListener("pageshow", environment);
  root.addEventListener("resize", environment);
  root.addEventListener("pagehide", event => { if (event.persisted) controller.pause(); else controller.dispose(); });
  if (root.WF && root.WF.ready) root.WF.ready.then(changed).catch(() => {});
  root.WFWeather = controller;
})(typeof window !== "undefined" ? window : globalThis);
