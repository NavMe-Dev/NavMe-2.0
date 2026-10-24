/* Optional venue title lookup. Independent of renderer/startup readiness. */
(function (root) {
  "use strict";
  const clean = value => typeof value === "string" ? value.trim() : "";
  const rank = source => ({ "matterport-sdk": 4, matterport: 3, "synchronized-matterport": 2, navme: 1, fallback: 0 }[source] || 0);
  function create({ fetchInfo, apply, diagnostic = () => {} }) {
    let generation = 0, identity = "", state = null, pending = null;
    function load(context) {
      const slug = clean(context.slug), modelId = clean(context.modelId), key = slug + "|" + modelId;
      if (identity === key && state) return pending || Promise.resolve(state);
      identity = key;
      const ticket = ++generation;
      state = { building_slug: slug, model_id: modelId, name: clean(context.name) || "Venue information",
        address: clean(context.address), description: clean(context.description), source: clean(context.name) ? "navme" : "fallback" };
      apply(state); // Reset immediately on venue changes; never leave the old name visible.
      if (!slug) return Promise.resolve(state);
      pending = Promise.resolve().then(() => fetchInfo(slug)).then(info => {
        if (ticket !== generation || info.building_slug !== slug || info.model_id !== modelId) return state;
        if (clean(info.name) && rank(info.source) >= rank(state.source)) {
          state = { ...state, ...info, name: clean(info.name) }; apply(state);
        }
        return state;
      }).catch(() => {
        if (ticket === generation) diagnostic("Venue metadata unavailable; using the current NavMe display name");
        return state;
      });
      return pending;
    }
    function acceptSdk(details, context) {
      if (!state || details.sid !== context.modelId || identity !== clean(context.slug) + "|" + clean(context.modelId) || !clean(details.name)) return false;
      state = { ...state, name: clean(details.name), source: "matterport-sdk",
        address: clean(details.formattedAddress || details.address) || state.address,
        description: clean(details.description || details.summary) || state.description };
      apply(state); return true;
    }
    return { load, acceptSdk, get: () => state };
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = { create }; return; }
  function apply(state) {
    root.document.querySelectorAll("[data-bname], [data-venue-title]").forEach(el => { el.textContent = state.name; });
    root.document.querySelectorAll("[data-venue-address]").forEach(el => { el.textContent = state.address; el.hidden = !state.address; });
    root.document.querySelectorAll("[data-venue-description]").forEach(el => { el.textContent = state.description; el.hidden = !state.description; });
    root.dispatchEvent(new Event("wf-venue-info"));
  }
  const controller = create({
    fetchInfo: async slug => {
      const base = ((root.WF_CONFIG && root.WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
      const response = await fetch(base + "buildings/" + encodeURIComponent(slug) + "/venue-info");
      if (!response.ok) throw new Error("Venue information unavailable");
      return response.json();
    }, apply,
    diagnostic: message => { if (typeof root.wfDbg === "function") root.wfDbg("warn", "viewer.venue", message); else console.warn(message); },
  });
  function context() {
    const wf = root.WF || {}, cfg = wf.cfg || {}, b = wf.building || {};
    return { slug: b.slug || cfg.slug, modelId: cfg.matterport_model_id || cfg.model_id,
      name: b.name || cfg.name, address: b.address || cfg.address, description: cfg.description || (cfg.branding || {}).description };
  }
  root.WFVenueInfo = { ...controller, render: () => { if (controller.get()) apply(controller.get()); } };
  if (root.WF && root.WF.ready) root.WF.ready.then(() => controller.load(context())).catch(() => {});
  root.addEventListener("wf-pois-updated", () => { void controller.load(context()); });
})(typeof window !== "undefined" ? window : globalThis);
