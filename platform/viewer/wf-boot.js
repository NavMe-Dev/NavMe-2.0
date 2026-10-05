/* Boot loader: resolves venue -> building, loads config.json, prepares window.WF before app.js / ui.js run.
   URL params: ?venue=<slug>&b=<building-slug>  (+ the usual to/from/floor/style/mode/view/me deep-link params) */
(function () {
  const C = window.WF_CONFIG || {};
  const q = new URLSearchParams(location.search);
  const J = (u) => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + " " + u); return r.json(); });
  const join = (a, b) => a.replace(/\/?$/, "/") + b.replace(/^\//, "");
  window.WF = { ready: null, base: "", cfg: null, manifest: null, others: [] };
  window.WF.ready = (async () => {
    let base, manifest = null;
    if (C.dataBase) {
      base = C.dataBase;
    } else {
      const venue = q.get("venue") || C.venue || "all";
      manifest = await J(join(C.apiBase, `venues/${venue}/manifest.json`));
      if (!manifest.buildings.length) throw new Error("No published buildings yet – publish one in the admin.");
      const slug = q.get("b") || C.building || manifest.buildings[0].slug;
      const b = manifest.buildings.find(x => x.slug === slug) || manifest.buildings[0];
      base = join(C.apiBase, b.data);
      window.WF.building = b;
      window.WF.others = manifest.buildings.filter(x => x.slug !== b.slug).map(x => ({ ...x, dataUrl: join(C.apiBase, x.data) }));
    }
    const cfg = await J(join(base, "config.json"));
    Object.assign(window.WF, { base, cfg, manifest, D: (f) => join(base, f) });
    // Debug mode: ship verbose logs to admin Dashboard when enabled (live status + published hint)
    try {
      if (window.WFDebug) {
        const slug = (window.WF.building && window.WF.building.slug) || (cfg && cfg.slug) || (q.get("b") || null);
        WFDebug.init({
          building: slug,
          client: "platform-viewer",
          hint: !!(cfg && cfg.debug)
        });
      }
    } catch (e) { /* ignore */ }
    // branding / titles
    const br = Object.assign({}, (manifest && manifest.branding) || {}, cfg.branding || {});
    document.title = (br.title || cfg.name || "NavMe") + " · NavMe";
    if (br.primary_color) document.documentElement.style.setProperty("--blue", br.primary_color);
    document.querySelectorAll("[data-bname]").forEach(el => el.textContent = cfg.name || "");
    document.querySelectorAll("[data-baddr]").forEach(el => el.textContent = cfg.address || "");
    // i18n: enabled languages from venue+building branding (en always on)
    const enabled = (br.enabled_languages || br.enabledLanguages || ["en"]);
    window.WF.branding = br;
    if (window.WFi18n) {
      window.WF.i18nReady = window.WFi18n.init({ enabled }).then(() => {
        const slot = document.getElementById("langSwitcher");
        if (slot) {
          const list = window.WFi18n.getEnabled();
          if (list.length > 1) {
            slot.hidden = false;
            window.WFi18n.mountSwitcher(slot, { className: "wf-lang-switch" });
          } else slot.hidden = true;
        }
        return window.WFi18n;
      }).catch(e => console.warn("i18n init failed", e));
    } else {
      window.WF.i18nReady = Promise.resolve(null);
    }
    // floor pickers (UI + dev panel) generated from config (top floor first in the vertical picker)
    const fl = cfg.floors.slice().sort((a, b) => a.ordinal - b.ordinal);
    const fp = document.getElementById("floorPicker");
    if (fp) {
      const allBtn = fl.length > 1
        ? `<button data-floor="all" role="radio" aria-label="All floors" title="All floors">All</button>`
        : "";
      fp.innerHTML = allBtn + fl.slice().reverse().map(f => `<button data-floor="${f.id}" role="radio" aria-label="${f.label}">${f.short}</button>`).join("");
    }
    const dfl = document.getElementById("devFloors");
    if (dfl) {
      const allDev = fl.length > 1 ? `<button class="floor" data-floor="all">All floors</button>` : "";
      dfl.innerHTML = allDev + fl.map(f => `<button class="floor" data-floor="${f.id}">${f.label}</button>`).join("");
    }
    return window.WF;
  })();
  window.WF.ready.catch(e => {
    console.error(e);
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:16px Roboto,Arial;background:#fff;z-index:999;padding:24px;text-align:center";
    const msg = (window.WFi18n && WFi18n.t) ? WFi18n.t("viewer.loadError", { msg: e.message }) : ("Could not load map data: " + e.message);
    d.textContent = msg; document.body.appendChild(d);
  });
})();
