/* Boot loader: resolves venue -> building, loads config.json, prepares window.WF before app.js / ui.js run.
   URL params: ?venue=<slug>&b=<building-slug>  (+ the usual to/from/floor/style/mode/view/me deep-link params) */
(function () {
  const C = window.WF_CONFIG || {};
  // UNCC is published as a Matterport-first venue. Canonicalize even a bare
  // ?b=uncc-main-campus link before boot so every UI module sees mp=1.
  const initialUrl = new URL(location.href);
  if (initialUrl.searchParams.get("b") === "uncc-main-campus" && initialUrl.searchParams.get("mp") !== "1") {
    initialUrl.searchParams.set("mp", "1");
    history.replaceState(null, "", initialUrl.toString());
  }
  const q = new URLSearchParams(location.search);
  const J = (u) => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + " " + u); return r.json(); });
  const join = (a, b) => a.replace(/\/?$/, "/") + b.replace(/^\//, "");

  // Smart start-mode redirect: a building's NavMe Dashboard "Walkthrough Mode" setting
  // (walkthrough_first / ar_first / hybrid) decides whether landing on this viewer sends
  // the visitor straight into the AR app (project_url) or the wayfinding walkthrough
  // (walkthrough_url, e.g. this same viewer with &mp=1) — hybrid picks by device (iOS ->
  // AR, everything else -> walkthrough). Runs alongside the main boot sequence below,
  // never blocking it: most buildings have none of this configured, so this is a no-op
  // fire-and-forget check for them. Guarded on ?mp=1 already being present so the
  // walkthrough_url redirect target (which itself carries &mp=1) is never re-redirected
  // into a loop, and so a direct/explicit mp=1 link always wins over this check.
  (async function smartStartModeRedirect() {
    if (q.get("mp") === "1") return;
    const slug = q.get("b") || C.building;
    if (!slug) return;
    let info;
    try {
      const apiBase = (C.apiBase || "/api/v1/public/").replace(/\/?$/, "/");
      const r = await fetch(apiBase + "buildings/" + encodeURIComponent(slug) + "/ar-experience-ref");
      if (!r.ok) return;
      info = await r.json();
    } catch (_) { return; }
    const mode = info && info.walkthrough_mode;
    const arUrl = info && info.ar_url;
    const wtUrl = info && info.walkthrough_url;
    let target = null;
    if (mode === "ar_first") target = arUrl;
    else if (mode === "walkthrough_first") target = wtUrl;
    else if (mode === "hybrid") {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+ desktop UA
      target = isIOS ? arUrl : wtUrl;
    }
    if (target) location.replace(target);
  })();

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
    // Use the NavMe Dashboard's authored floors for the visible selector. Keep every
    // pipeline floor in cfg.floors because route graphs and generated assets use those
    // stable ids. Dashboard slice_y values share the model's vertical coordinate, so
    // each authored floor maps safely to the nearest pipeline elevation.
    const slug = (window.WF.building && window.WF.building.slug) || cfg.slug || q.get("b");
    cfg.display_floors = [];
    if (slug && C.apiBase && Array.isArray(cfg.floors)) {
      try {
        const apiBase = C.apiBase.replace(/\/?$/, "/");
        const data = await J(apiBase + "buildings/" + encodeURIComponent(slug) + "/navme-floors");
        const used = new Set();
        for (const row of (data.floors || [])) {
          const y = Number(row.slice_y);
          if (!Number.isFinite(y)) continue;
          const match = cfg.floors
            .filter(f => !used.has(f.id))
            .reduce((best, f) => !best || Math.abs(Number(f.elevation) - y) < Math.abs(Number(best.elevation) - y) ? f : best, null);
          if (!match) continue;
          used.add(match.id);
          match.label = row.name || match.label;
          match.floor_names = row.floor_names || {};
          const short = Number(row.sort_order) === 0 ? "G" : String(Number(row.sort_order));
          cfg.display_floors.push({ ...match, short, dashboard_floor_id: row.id });
        }
      } catch (_) { /* Dashboard floors are optional; routing still boots normally. */ }
    }
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
    // Every translation shipped with the public viewer is available at every venue.
    // Venue branding used to restrict this list, which could leave visitors with an
    // English-only picker even though all locale dictionaries were installed.
    const enabled = (window.WFi18n && Array.isArray(window.WFi18n.catalog))
      ? window.WFi18n.catalog.map(item => item.code)
      : ["en"];
    window.WF.branding = br;
    if (window.WFi18n) {
      window.WF.i18nReady = window.WFi18n.init({ enabled }).then(() => {
        // The drawer's "Language" row itself (click -> language-picker sheet) is owned by
        // ui.js's bindDrawer()/showLanguageSheet(); this just shows/hides the row and keeps
        // its current-language sub-label in sync, since ui.js loads after this resolves.
        const btn = document.getElementById("langSwitcher");
        if (btn) {
          const refreshLabel = () => {
            const cur = window.WFi18n.enabledCatalog().find(c => c.code === window.WFi18n.getLocale());
            const lab = document.getElementById("langCurrentLabel");
            if (lab) lab.textContent = cur ? cur.native : "";
          };
          btn.hidden = false;
          refreshLabel();
          window.WFi18n.onChange(refreshLabel);
        }
        return window.WFi18n;
      }).catch(e => console.warn("i18n init failed", e));
    } else {
      window.WF.i18nReady = Promise.resolve(null);
    }
    // floor pickers (UI + dev panel) generated from config (top floor first in the vertical picker)
    const fl = (cfg.display_floors.length ? cfg.display_floors : cfg.floors).slice().sort((a, b) => a.ordinal - b.ordinal);
    const fp = document.getElementById("floorList");
    if (fp) {
      const allBtn = !cfg.display_floors.length && fl.length > 1
        ? `<button data-floor="all" role="radio" aria-label="All floors" title="All floors">All</button>`
        : "";
      fp.innerHTML = allBtn + fl.slice().reverse().map(f => `<button data-floor="${f.id}" role="radio" aria-label="${f.label}">${f.short}</button>`).join("");
    }
    const dfl = document.getElementById("devFloors");
    if (dfl) {
      const allDev = !cfg.display_floors.length && fl.length > 1 ? `<button class="floor" data-floor="all">All floors</button>` : "";
      dfl.innerHTML = allDev + fl.map(f => `<button class="floor" data-floor="${f.id}">${f.label}</button>`).join("");
    }
    return window.WF;
  })();
  window.WF.ready.catch(e => {
    console.error(e);
    if (window.WFStartup) { window.WFStartup.fail(); return; }
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:16px Roboto,Arial;background:#fff;z-index:999;padding:24px;text-align:center";
    const msg = (window.WFi18n && WFi18n.t) ? WFi18n.t("viewer.loadError") : "We couldn't load the map right now. Please try again.";
    d.style.flexDirection = "column";
    const heading = document.createElement("h2"); heading.textContent = "Map unavailable";
    const description = document.createElement("p"); description.textContent = msg;
    const retry = document.createElement("button"); retry.textContent = "Try Again";
    retry.onclick = () => location.reload();
    d.append(heading, description, retry); document.body.appendChild(d);
  });
})();
