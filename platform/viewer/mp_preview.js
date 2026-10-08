function wfDbg(level, source, message, meta) {
  try { if (window.WFDebug && WFDebug.isEnabled()) WFDebug.log(level, source, message, meta); } catch (_) {}
}
/* Matterport Showcase digital-twin route walkthrough ("Tour interior").
   Exposes window.MpPreview = { open(route), close() }.
   Loads application key from data/sdk_config.json (prototype) or a public API
   when configured; keys are domain-bound and intended for client embeds. */
(function () {
  "use strict";

  const DEFAULT_MODEL = "Hn36TwktGgz";
  const SDK_BOOTSTRAP = "https://static.matterport.com/showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js";
  const SHOW_BASE = "https://my.matterport.com/show/";

  let mpSdk = null;
  let playing = false;
  let stopped = true;
  let stepI = 0;
  let sweepIds = [];
  let sweepNodes = []; // {id,x,y,z} ordered, kind===sweep
  let routeDest = null; // final look target (last path node)
  let destName = null;  // destination POI name for display
  let modelId = DEFAULT_MODEL;
  let applicationKey = "";
  let accessToken = "";  // X-WF-Access / ?access= for twin=pin
  let connectError = "";
  let sdkScriptPromise = null;
  let openGen = 0;
  let navPathTour = false; // when true: INSTANT transitions + zero dwell (computed from navPath)
  let tourNavSteps = [];  // same turn-by-turn instructions Start Preview shows (route._navSteps)

  // Tour interior UX (1A HUD arrow + distance + 3A look-ahead; NO orbit peek) — Embed SDK only
  const HUD_TURN_EMPHASIS_DEG = 30;   // larger chevron when turn > 30° (never hide)
  const FACE_ROTATE_SPEED = 90;       // smooth setRotation after land (3A)
  let routeTotalM = null;             // route.total_m when provided (full path, info only)
  let cumDistM = [];                  // cumDistM[i] = meters along sweep path from start to sweep i
  let segDistM = [];                  // segDistM[i] = meters from sweep i → i+1 (last = to dest if any)
  let tourPaceScale = 1;              // multiplies FLY/dwell timing: >1 slower (small route), <1 faster (big route)

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    try {
      if (window.wfUI && typeof window.wfUI.toast === "function") return window.wfUI.toast(msg);
    } catch (_) { /* ignore */ }
    const t = $("toast");
    if (!t) return;
    t.innerHTML = `<span>${esc(msg)}</span>`;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2800);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let overlayBound = false;
  /** Back-fill elements the static index.html overlay may predate. */
  function patchOverlayParity(ov) {
    if (!ov) return;
    if (!$("mpDest")) {
      const bar = ov.querySelector(".mp-bar");
      const title = bar && bar.querySelector(".mp-title");
      if (bar && title) {
        const d = document.createElement("div");
        d.className = "mp-dest-label";
        d.id = "mpDest";
        d.hidden = true;
        title.insertAdjacentElement("afterend", d);
      }
    }
    if (!$("mpInstr")) {
      const bar = ov.querySelector(".mp-bar");
      const dest = $("mpDest");
      if (bar) {
        const d = document.createElement("div");
        d.className = "mp-dest-label mp-instr";
        d.id = "mpInstr";
        d.hidden = true;
        if (dest) dest.insertAdjacentElement("afterend", d);
        else bar.insertBefore(d, bar.firstChild.nextSibling);
      }
    }
    if (!$("mpBgLoading")) {
      const wrap = ov.querySelector(".mp-frame-wrap");
      const frame = $("mpFrame");
      if (wrap) {
        const d = document.createElement("div");
        d.className = "mp-bg-loading"; d.id = "mpBgLoading"; d.hidden = true;
        d.innerHTML = '<div class="mp-bg-spinner" aria-hidden="true"></div><div id="mpBgLoadingText"></div>';
        if (frame) frame.insertAdjacentElement("afterend", d);
        else wrap.insertBefore(d, wrap.firstChild);
      }
    }
  }

  function ensureOverlay() {
    let ov = $("mpOverlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "mpOverlay";
      ov.className = "mp-overlay";
      ov.hidden = true;
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-label", "Tour interior");
      ov.innerHTML = `
      <div class="mp-panel">
        <header class="mp-bar">
          <div class="mp-title"><span class="ms">view_in_ar</span><span>Tour interior</span></div>
          <div class="mp-dest-label" id="mpDest" hidden></div>
          <div class="mp-dest-label mp-instr" id="mpInstr" hidden></div>
          <div class="mp-step" id="mpStep">—</div>
          <div class="mp-actions">
            <button type="button" class="mp-btn" id="mpPlay" aria-label="Play"><span class="ms">play_arrow</span></button>
            <button type="button" class="mp-btn" id="mpPause" aria-label="Pause"><span class="ms">pause</span></button>
            <button type="button" class="mp-btn" id="mpStop" aria-label="Stop"><span class="ms">stop</span></button>
            <a class="mp-btn" id="mpOpenTab" href="#" target="_blank" rel="noopener" aria-label="Open in new tab"><span class="ms">open_in_new</span></a>
            <button type="button" class="mp-btn mp-close" id="mpClose" aria-label="Close"><span class="ms">close</span></button>
          </div>
        </header>
        <div class="mp-status" id="mpStatus" hidden></div>
        <div class="mp-frame-wrap">
          <iframe id="mpFrame" title="Matterport digital twin" allow="xr-spatial-tracking;gyroscope;accelerometer;autoplay;fullscreen;clipboard-write" allowfullscreen webkitallowfullscreen mozallowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
          <div id="mpBgLoading" class="mp-bg-loading" hidden><div class="mp-bg-spinner" aria-hidden="true"></div><div id="mpBgLoadingText"></div></div>
          <div id="mpDirArrow" class="mp-dir-arrow" hidden aria-hidden="true"><div class="mp-dir-arr" aria-hidden="true">➤</div></div>
          <div id="mpDistHud" class="mp-dist-hud" hidden aria-hidden="true"><span class="mp-dist-val" id="mpDistRem">—</span><span class="mp-dist-leg" id="mpDistLegRow" hidden><span class="mp-dist-sep" aria-hidden="true">·</span><span class="mp-dist-leg-val" id="mpDistLeg">—</span></span></div>
        </div>
      </div>`;
      document.body.appendChild(ov);
    }
    // index.html also ships a static #mpOverlay. When that one is present the template
    // above never runs, so anything added here must be back-filled.
    patchOverlayParity(ov);
    ensureDirArrowMount();
    ensureDistHudMount();
    ensureGlassHud();
    if (!overlayBound) {
      const closeBtn = $("mpClose"), playBtn = $("mpPlay"), pauseBtn = $("mpPause"), stopBtn = $("mpStop");
      // Go through window.MpPreview.close (not the bare local close()) so tour.html's
      // override — which navigates back to returnUrl after closing — actually fires;
      // a direct call to the closed-over local function would bypass that monkey-patch.
      if (closeBtn) closeBtn.onclick = () => window.MpPreview.close();
      if (playBtn) playBtn.onclick = () => play();
      if (pauseBtn) pauseBtn.onclick = () => pause();
      if (stopBtn) stopBtn.onclick = () => stopWalk();
      ov.addEventListener("keydown", (e) => { if (e.key === "Escape") window.MpPreview.close(); });
      overlayBound = true;
    }
    return ov;
  }

  function setStatus(msg, isErr) {
    const el = $("mpStatus");
    if (el) {
      if (!msg) { el.hidden = true; el.textContent = ""; }
      else { el.hidden = false; el.textContent = msg; el.classList.toggle("err", !!isErr); }
    }
    // mp_background.js hides .mp-bar/.mp-status entirely (Tour interior's own header has
    // no place in a full-bleed background), which silently dropped every status update —
    // the public MP viewer showed a plain black screen with zero loading feedback for the
    // whole connect sequence. Mirror the same messages into a centered spinner instead,
    // scoped to mp-bg-mode only so normal Tour interior (which still has .mp-status) is
    // unaffected.
    if (document.body.classList.contains("mp-bg-mode")) {
      const bg = $("mpBgLoading"), bgText = $("mpBgLoadingText");
      if (bg && bgText) {
        if (!msg) { bg.hidden = true; }
        else { bg.hidden = false; bgText.textContent = msg; bg.classList.toggle("err", !!isErr); }
      }
    }
  }

  function updateStep() {
    const el = $("mpStep");
    if (!el) return;
    if (!sweepIds.length) { el.textContent = ""; return; }
    if (stepI >= sweepIds.length) { el.textContent = ""; return; }
    const rem = remainingDistM(stepI);
    el.textContent = (rem != null && rem > 0.5) ? fmtMeters(rem) : "";
  }

  function updateDest() {
    const el = $("mpDest");
    if (!el) return;
    if (destName) {
      el.textContent = "→ " + destName;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /** Nearest turn-by-turn instruction (from the same list Start Preview shows) to a point. */
  function nearestTourStepText(pt) {
    if (!tourNavSteps.length || !pt || pt.x == null) return null;
    let best = null, bd = Infinity;
    tourNavSteps.forEach(s => {
      if (!s || !s.pt || s.pt.x == null) return;
      if (s.pt.floor != null && pt.floor != null && s.pt.floor !== pt.floor) return;
      const d = Math.hypot(s.pt.x - pt.x, s.pt.y - pt.y);
      if (d < bd) { bd = d; best = s; }
    });
    return best;
  }

  function updateTourInstruction(pt, isLast) {
    const el = $("mpInstr");
    if (!el) return;
    if (isLast) {
      el.textContent = destName ? ("You have arrived at " + destName) : "You have arrived";
      el.hidden = false;
      return;
    }
    const step = nearestTourStepText(pt);
    if (step && step.text) {
      el.textContent = step.text;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function showcaseUrl(key, startSweep) {
    // dh=1: Dollhouse must be enabled in the embed itself, or Mode.moveTo(DOLLHOUSE) from the
    // SDK silently no-ops during the tour's cinematic opening shot (matches threed_nav.js's dh=1).
    // f=0: hides Showcase's own floor-selector control. Without this, Inside mode starts
    // pinned to Floor 1, and switching to Dollhouse inherits that same floor filter — the
    // dollhouse opening shot renders only Floor 1, badge and all, instead of the whole
    // building. The working Mattercraft build (threed_nav.js) carries this same param for
    // exactly that reason; it never calls Floor.showAll() at all, because f=0 means there is
    // no floor filter to begin with.
    // logo=0/newtop=0/mt=0/gt=0/vr=0/search=0/pin=0/sr=0/kb=0/lp=0: the rest of Showcase's own
    // chrome (watermark logo, bottom mode-switch toolbar, guided-tour prompt, VR/search/pin/
    // share buttons, keyboard-shortcut hint, loading-progress bar) — same param set threed_nav.js
    // already uses for its own chromeless walkthrough. None of these are reachable via CSS/DOM:
    // the iframe is cross-origin (my.matterport.com), so hiding them is only possible through
    // Showcase's own embed parameters, never by styling into the iframe from this page.
    let u = `${SHOW_BASE}?m=${encodeURIComponent(modelId)}&play=1&qs=1&brand=0&title=0&help=0&tourcta=0&dh=1&f=0&hr=0&mls=2&logo=0&newtop=0&mt=0&gt=0&vr=0&search=0&pin=0&sr=0&kb=0&lp=0`;
    if (startSweep) u += `&ss=${encodeURIComponent(startSweep)}`;
    if (key) u += `&applicationKey=${encodeURIComponent(key)}`;
    return u;
  }

  function loadSdkScript() {
    if (window.MP_SDK) return Promise.resolve();
    if (sdkScriptPromise) return sdkScriptPromise;
    sdkScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SDK_BOOTSTRAP;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Matterport SDK bootstrap"));
      document.head.appendChild(s);
    });
    return sdkScriptPromise;
  }

  function readAccessPolicy() {
    try {
      const cfg = (window.WF && window.WF.cfg) || {};
      if (window.WFAccess && WFAccess.viewerFlags) return WFAccess.viewerFlags(cfg);
      const a = cfg.access || {};
      const twin = a.twin || "public";
      const tourPublic = a.tour_public !== false;
      return {
        twin,
        twin_disabled: twin === "disabled",
        twin_pin_required: twin === "pin",
        tour_public: tourPublic,
        embed_tour_allowed: twin !== "disabled" && (twin === "pin" || tourPublic)
      };
    } catch (_) {
      return { twin: "public", twin_disabled: false, twin_pin_required: false, tour_public: true, embed_tour_allowed: true };
    }
  }

  function promptAccessPin() {
    try {
      const stored = sessionStorage.getItem("wf_access_pin") || "";
      if (stored) return stored;
    } catch (_) { /* ignore */ }
    const pin = window.prompt("Enter access PIN for this building's digital twin:", "");
    if (pin == null) return null; // cancelled
    const trimmed = String(pin).trim();
    if (!trimmed) return null;
    try { sessionStorage.setItem("wf_access_pin", trimmed); } catch (_) { /* ignore */ }
    return trimmed;
  }

  async function resolveConfig() {
    modelId = DEFAULT_MODEL;
    applicationKey = "";

    // window.WF.cfg (building slug, model id, access policy) is filled in asynchronously
    // by wf-boot.js once window.WF.ready resolves. Every read of window.WF.cfg below
    // (readAccessPolicy included) silently falls back to {} until then — reliably
    // populated in practice only because showBackground() happens to run after a human
    // clicks a building, which takes far longer than wf-boot's own fetch. That's not a
    // guarantee: a fast re-trigger or a slow /manifest.json response can still race it,
    // silently resolving against an empty cfg — which is exactly how this loaded the
    // wrong (hardcoded default) Matterport model intermittently. Wait for it explicitly.
    if (window.WF && window.WF.ready && typeof window.WF.ready.then === "function") {
      try { await window.WF.ready; } catch (_) { /* boot failed — fall through, cfg stays {} */ }
    }

    const policy = readAccessPolicy();
    if (policy.twin_disabled) {
      const err = new Error("Digital twin is disabled for this building");
      err.code = "twin_disabled";
      throw err;
    }
    if (!policy.embed_tour_allowed && !policy.twin_pin_required) {
      const err = new Error("Tour / Embed is not public for this building");
      err.code = "tour_not_public";
      throw err;
    }
    if (policy.twin_pin_required && !accessToken) {
      const pin = promptAccessPin();
      if (!pin) {
        const err = new Error("Access PIN required");
        err.code = "pin_required";
        throw err;
      }
      accessToken = pin;
    }

    // Building config from platform boot (preferred model id)
    try {
      const cfg = (window.WF && window.WF.cfg) || {};
      if (cfg.matterport_model_id) modelId = cfg.matterport_model_id;
      else if (cfg.model_id) modelId = cfg.model_id;
    } catch (_) { /* ignore */ }

    // Fire the prototype config fetch and the platform endpoint fetch together — step 2
    // only *depends* on step 1 for precedence when applying results (step 2's model_id
    // always wins; step 1's applicationKey is used only as a fallback), not for the
    // request itself. Awaiting them one after another was a full extra network round
    // trip before the Showcase iframe could even start loading — costly on mobile.
    const protoPromise = fetch("data/sdk_config.json", { cache: "no-store" }).catch(() => null);
    const cfg0 = (window.WF && window.WF.cfg) || window.WF_CONFIG || {};
    const slug0 = cfg0.slug || (window.WF && window.WF.building && window.WF.building.slug) || cfg0.building;
    const apiBase0 = (cfg0.apiBase || (window.WF_CONFIG && window.WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
    let platformPromise = null;
    if (slug0 && apiBase0) {
      const headers0 = {};
      let url0 = `${apiBase0}buildings/${encodeURIComponent(slug0)}/matterport`;
      if (accessToken) {
        headers0["X-WF-Access"] = accessToken;
        url0 += (url0.indexOf("?") >= 0 ? "&" : "?") + "access=" + encodeURIComponent(accessToken);
      }
      platformPromise = fetch(url0, { cache: "no-store", headers: headers0 }).catch(() => null);
    }

    // 1) Prototype: data/sdk_config.json
    try {
      const r = await protoPromise;
      if (r && r.ok) {
        const d = await r.json();
        if (d.modelId) modelId = d.modelId;
        if (d.applicationKey) applicationKey = d.applicationKey;
      }
    } catch (_) { /* ignore */ }

    // 2) Platform public endpoint — always refresh model_id for this building;
    //    fill key only when local config did not provide one.
    //    When twin=pin, send X-WF-Access / ?access=.
    try {
      const cfg = (window.WF && window.WF.cfg) || window.WF_CONFIG || {};
      const slug = cfg.slug || (window.WF && window.WF.building && window.WF.building.slug) || cfg.building;
      const apiBase = (cfg.apiBase || (window.WF_CONFIG && window.WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
      if (slug && apiBase && platformPromise) {
        const r = await platformPromise;
        if (!r) { /* network error already swallowed */ }
        else if (r.status === 403) {
          let detail = "Access denied";
          try { const j = await r.json(); detail = j.detail || detail; } catch (_) { /* ignore */ }
          // Wrong PIN — clear session and retry once via prompt
          try { sessionStorage.removeItem("wf_access_pin"); } catch (_) { /* ignore */ }
          accessToken = "";
          if (policy.twin_pin_required) {
            const pin2 = promptAccessPin();
            if (pin2) {
              accessToken = pin2;
              const headers2 = { "X-WF-Access": pin2 };
              const url2 = `${apiBase}buildings/${encodeURIComponent(slug)}/matterport?access=${encodeURIComponent(pin2)}`;
              const r2 = await fetch(url2, { cache: "no-store", headers: headers2 });
              if (r2.ok) {
                const d2 = await r2.json();
                if (d2.model_id) modelId = d2.model_id;
                if (d2.application_key && !applicationKey) applicationKey = d2.application_key;
              } else {
                const err = new Error(detail);
                err.code = "access_denied";
                throw err;
              }
            } else {
              const err = new Error(detail);
              err.code = "access_denied";
              throw err;
            }
          } else {
            const err = new Error(detail);
            err.code = "access_denied";
            throw err;
          }
        } else if (r.ok) {
          const d = await r.json();
          if (d.model_id) modelId = d.model_id;
          if (d.application_key && !applicationKey) applicationKey = d.application_key;
        }
      }
    } catch (e) {
      if (e && e.code) throw e;
      /* ignore network — fall through to admin showcase */
    }

    // 3) Admin showcase (only if an admin token is present and still no key)
    try {
      const tok = localStorage.getItem("wf_admin_token") || sessionStorage.getItem("wf_admin_token");
      const cfg = (window.WF && window.WF.cfg) || {};
      const slug = cfg.slug || (window.WF && window.WF.building && window.WF.building.slug);
      if (tok && slug && !applicationKey) {
        const r = await fetch(`/api/v1/admin/buildings/${encodeURIComponent(slug)}/showcase`, {
          headers: { Authorization: `Bearer ${tok}` }, cache: "no-store"
        });
        if (r.ok) {
          const d = await r.json();
          if (d.url) {
            try {
              const u = new URL(d.url);
              const m = u.searchParams.get("m");
              const k = u.searchParams.get("applicationKey");
              if (m) modelId = m;
              if (k) applicationKey = k;
            } catch (_) { /* ignore */ }
          }
        }
      }
    } catch (_) { /* ignore */ }

    // DEFAULT_MODEL is a hardcoded fallback for local/prototype testing, completely
    // unrelated to any real building. If nothing above (building boot config, the
    // platform's own /matterport endpoint, or an admin override) actually resolved a
    // real model id for THIS building — e.g. the platform endpoint 404s/500s from a
    // transient network hiccup or cold-start — silently proceeding would load whatever
    // random model DEFAULT_MODEL happens to be, with no indication anything was wrong.
    // Fail loudly instead: showing an error is strictly better than showing the wrong
    // building's digital twin.
    if (modelId === DEFAULT_MODEL) {
      const err = new Error("Could not resolve this building's Matterport model — refusing to fall back to an unrelated default model. Check your connection and retry.");
      err.code = "model_unresolved";
      throw err;
    }

    return { modelId, applicationKey };
  }

  // ── Hybrid Dijkstra routing (for when route.sweep_ids is empty) ──────────────
  // Mirrors the algorithm in threed_nav.js so "Tour interior" can compute its
  // own sweep path from route.navPath when the server provides none.
  const RT_HOP_EXP = 1.35;
  const RT_FLOOR_STEP_M = 0.35;
  const RT_TELEPORT_HOP_M = 2.5;
  const RT_TELEPORT_DETOUR_MAX = 1.35;
  const RT_LEVEL_CHANGE_DETOUR_MAX = 8;
  const RT_LEVEL_CHANGE_DETOUR_ABS_M = 25;
  const RT_LEVEL_CHANGE_IMPROVEMENT = 1.05;
  const RT_STAIR_MIN_GRADE = 0.25;

  // NavMe Z-up {x=east,y=north,z=up} → Matterport Y-up
  function rtToMp(p) { return { x: +p.x, y: +(p.z || 0), z: -(+p.y) }; }

  function parseSweepEntries(vals) {
    const out = [];
    for (const sw of vals) {
      if (!sw || sw.enabled === false) continue;
      const sid = String(sw.id || sw.sid || sw.uuid || "");
      const pos = sw.position || (sw.pose && sw.pose.position) || sw.location;
      if (!sid || !pos) continue;
      const x = Number(pos.x), y = Number(pos.y), z = Number(pos.z);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      const nbRaw = sw.neighbors || sw.neighbours || [];
      const neighbours = [];
      if (Array.isArray(nbRaw)) {
        for (const n of nbRaw) {
          const nid = typeof n === "string" ? n : String((n && (n.id || n.sid)) || "");
          if (nid) neighbours.push(nid);
        }
      }
      out.push({ sid, position: { x, y, z }, neighbours });
    }
    return out;
  }

  // Read full sweep data (positions + neighbours) from the SDK.
  // Model.getData() returns every sweep immediately and reliably — verified live (990
  // sweeps, available right after connect, no further waiting needed). Sweep.data (the
  // observable collection) was tried first originally, but its subscribe event never
  // actually fires in this environment/model — confirmed by direct testing, both via
  // object-form and function-form callbacks, with and without an early subscribe set up
  // right after connect (matching threed_nav.js's documented "emits once, early" pattern
  // for its own build/model) — so it's kept only as a last-resort fallback, not relied on.
  // Sweep positions don't change during a connection — re-fetching/re-parsing all of
  // them (990 for GCU) on every single POI click, arrow step, and walk hop was the real
  // cause of "point to point" lag and mobile CPU heat: the slowest fallback path even
  // sets up an SDK subscription and waits up to 8s. Cache per sdk instance so a fresh
  // connect (new object from connectSdk()) naturally invalidates it.
  let _sweepCache = null, _sweepCacheSdk = null;
  async function rtReadSweeps(sdk) {
    if (_sweepCacheSdk === sdk && _sweepCache) return _sweepCache;
    const result = await rtReadSweepsUncached(sdk);
    if (result.length) { _sweepCache = result; _sweepCacheSdk = sdk; }
    return result;
  }

  async function rtReadSweepsUncached(sdk) {
    try {
      if (sdk && sdk.Model && typeof sdk.Model.getData === "function") {
        const d = await sdk.Model.getData();
        const parsed = parseSweepEntries((d && d.sweeps) || []);
        if (parsed.length) return parsed;
      }
    } catch (e) { console.warn("[MpPreview] Model.getData failed", e); }

    const sweepApi = sdk && sdk.Sweep;
    if (!sweepApi || !sweepApi.data) return [];

    // Direct dict read (the observable sometimes doubles as a keyed snapshot)
    try {
      const data = sweepApi.data;
      if (typeof data === "object" && !Array.isArray(data)) {
        const vals = Object.values(data).filter(v => v && typeof v === "object");
        const parsed = parseSweepEntries(vals);
        if (parsed.length) return parsed;
      }
    } catch (_) { /* ignore */ }

    // Subscribe, last resort
    let col = null, sub = null;
    try {
      await new Promise((resolve) => {
        try {
          sub = sweepApi.data.subscribe({
            onCollectionUpdated: (c) => { if (c) { col = c; resolve(); } },
            onChanged: () => {}
          });
        } catch (_) {
          try { sub = sweepApi.data.subscribe((c) => { if (c) { col = c; resolve(); } }); }
          catch (__) { resolve(); }
        }
        setTimeout(resolve, 8000);
      });
    } catch (_) { /* ignore */ }
    try {
      if (sub) { if (typeof sub === "function") sub(); else if (sub.cancel) sub.cancel(); }
    } catch (_) { /* ignore */ }
    if (!col) return [];
    let entries;
    if (Array.isArray(col)) entries = col;
    else if (typeof col.forEach === "function") { entries = []; col.forEach(v => entries.push(v)); }
    else entries = Object.values(col);
    return parseSweepEntries(entries);
  }

  function rtDist3(a, b) {
    const dx = a.position.x - b.position.x, dy = a.position.y - b.position.y, dz = a.position.z - b.position.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  function rtNearestSweep(rtSweeps, p) {
    let best = null, bestD = Infinity;
    for (const s of rtSweeps) {
      const rise = s.position.y - p.y;
      if (rise < -0.3 || rise > 2.8) continue;
      const dx = s.position.x - p.x, dz = s.position.z - p.z;
      const d = Math.sqrt(dx*dx + dz*dz);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) return best;
    bestD = Infinity;
    for (const s of rtSweeps) {
      const dx = s.position.x - p.x, dy = s.position.y - p.y, dz = s.position.z - p.z;
      const d = Math.sqrt(dx*dx + dz*dz) + Math.abs(dy) * 0.15;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  function rtIsLevelChange(ay, by, ax, az, bx, bz) {
    const dy = Math.abs(by - ay);
    if (dy <= RT_FLOOR_STEP_M) return false;
    const horiz = Math.sqrt((bx-ax)*(bx-ax) + (bz-az)*(bz-az));
    if (horiz < 0.1) return true;
    return dy / horiz >= RT_STAIR_MIN_GRADE;
  }

  function rtSweepsCrossLevels(u, v) {
    return rtIsLevelChange(u.position.y, v.position.y, u.position.x, u.position.z, v.position.x, v.position.z);
  }

  function rtCollapseLoops(ids) {
    const out = [], seenAt = {};
    for (const id of ids) {
      if (seenAt[id] !== undefined) {
        const prior = seenAt[id];
        out.length = prior + 1;
        for (const k in seenAt) { if (seenAt[k] > prior) delete seenAt[k]; }
      } else {
        seenAt[id] = out.length;
        out.push(id);
      }
    }
    return out;
  }

  function rtPointSegDistSq(p, a, b) {
    const abx = b.position.x-a.position.x, aby = b.position.y-a.position.y, abz = b.position.z-a.position.z;
    const lenSq = abx*abx + aby*aby + abz*abz;
    let t = 0;
    if (lenSq > 1e-9) {
      t = ((p.position.x-a.position.x)*abx + (p.position.y-a.position.y)*aby + (p.position.z-a.position.z)*abz) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = a.position.x + abx*t - p.position.x;
    const cy = a.position.y + aby*t - p.position.y;
    const cz = a.position.z + abz*t - p.position.z;
    return cx*cx + cy*cy + cz*cz;
  }

  function rtInsertSkippedSweeps(ids, rtSweeps, byId) {
    if (ids.length < 2) return ids;
    const maxR2 = 1.6 * 1.6;
    let route = ids.slice();
    for (let pass = 0; pass < 3; pass++) {
      const out = [route[0]]; let added = 0;
      for (let i = 1; i < route.length; i++) {
        const u = byId[route[i-1]], v = byId[route[i]];
        if (!u || !v) { out.push(route[i]); continue; }
        if (Math.abs(v.position.y - u.position.y) > RT_FLOOR_STEP_M) { out.push(route[i]); continue; }
        const onRoute = {};
        for (const x of route) onRoute[x] = true;
        const between = [];
        for (const cand of rtSweeps) {
          if (onRoute[cand.sid]) continue;
          if (!u.neighbours.includes(cand.sid) || !cand.neighbours.includes(v.sid)) continue;
          if (rtPointSegDistSq(cand, u, v) > maxR2) continue;
          const ax = v.position.x-u.position.x, ay = v.position.y-u.position.y, az = v.position.z-u.position.z;
          const len2 = ax*ax+ay*ay+az*az;
          if (len2 <= 1e-9) continue;
          const t = ((cand.position.x-u.position.x)*ax+(cand.position.y-u.position.y)*ay+(cand.position.z-u.position.z)*az)/len2;
          if (t <= 0.02 || t >= 0.98) continue;
          between.push({ id: cand.sid, t });
        }
        between.sort((a, b) => a.t - b.t);
        for (const bw of between) { out.push(bw.id); added++; }
        out.push(route[i]);
      }
      route = out;
      if (!added) break;
    }
    return route;
  }

  function rtPlanLegByDistance(u, v, byId) {
    const best = {}, prev = {}, seen = {};
    best[u.sid] = 0;
    for (;;) {
      let curId = null, curCost = Infinity;
      for (const id in best) { if (!seen[id] && best[id] < curCost) { curCost = best[id]; curId = id; } }
      if (!curId || curId === v.sid) break;
      seen[curId] = true;
      const cur = byId[curId]; if (!cur) continue;
      for (const nId of cur.neighbours) {
        if (seen[nId]) continue;
        const nb = byId[nId]; if (!nb) continue;
        if (curId === u.sid && nId === v.sid) continue;
        const c = curCost + rtDist3(cur, nb);
        if (best[nId] === undefined || c < best[nId]) { best[nId] = c; prev[nId] = curId; }
      }
    }
    if (best[v.sid] === undefined) return [];
    const leg = [];
    for (let id = v.sid; id !== undefined && id !== u.sid; id = prev[id]) leg.unshift(id);
    return leg;
  }

  function rtPlanLegByLeastClimb(u, v, byId) {
    function better(a, b) { if (!b) return true; if (Math.abs(a.rise-b.rise) > 1e-6) return a.rise < b.rise; return a.dist < b.dist; }
    const best = {}, prev = {}, seen = {};
    best[u.sid] = { rise: 0, dist: 0 };
    for (;;) {
      let curId = null, curLabel = null;
      for (const id in best) { if (!seen[id] && better(best[id], curLabel)) { curLabel = best[id]; curId = id; } }
      if (!curId || curId === v.sid) break;
      seen[curId] = true;
      const cur = byId[curId]; if (!cur) continue;
      for (const nId of cur.neighbours) {
        if (seen[nId]) continue;
        const nb = byId[nId]; if (!nb) continue;
        if (curId === u.sid && nId === v.sid) continue;
        const label = { rise: Math.max(curLabel.rise, Math.abs(nb.position.y - cur.position.y)), dist: curLabel.dist + rtDist3(cur, nb) };
        if (better(label, best[nId] || null)) { best[nId] = label; prev[nId] = curId; }
      }
    }
    if (!best[v.sid]) return [];
    const leg = [];
    for (let id = v.sid; id !== undefined && id !== u.sid; id = prev[id]) leg.unshift(id);
    return leg;
  }

  function rtPlanLegMostScanPoints(u, v, rtSweeps, byId, maxDist) {
    const dir = v.position.y >= u.position.y ? 1 : -1;
    const loY = Math.min(u.position.y, v.position.y) - 0.3;
    const hiY = Math.max(u.position.y, v.position.y) + 0.3;
    const nodes = rtSweeps.filter(n => n.position.y >= loY && n.position.y <= hiY);
    nodes.sort((a, b) => dir*(a.position.y-b.position.y) || (a.sid<b.sid?-1:a.sid>b.sid?1:0));
    const rank = {};
    nodes.forEach((n, r) => { rank[n.sid] = r; });
    if (rank[u.sid] === undefined || rank[v.sid] === undefined) return [];
    const best = {};
    best[u.sid] = { count: 0, dist: 0 };
    for (const node of nodes) {
      const cur = best[node.sid]; if (!cur) continue;
      for (const nId of node.neighbours) {
        const nb = byId[nId]; if (!nb || rank[nId] === undefined) continue;
        if (rank[nId] <= rank[node.sid]) continue;
        const d = cur.dist + rtDist3(node, nb);
        if (d > maxDist) continue;
        const cand = { count: cur.count+1, dist: d, prev: node.sid };
        const ex = best[nId];
        if (!ex || cand.count > ex.count || (cand.count === ex.count && cand.dist < ex.dist)) best[nId] = cand;
      }
    }
    if (!best[v.sid]) return [];
    const leg = [];
    for (let id = v.sid; id !== undefined && id !== u.sid; id = best[id] && best[id].prev) {
      leg.unshift(id);
      if (leg.length > nodes.length) return [];
    }
    return leg;
  }

  function rtRepairTeleports(ids, rtSweeps, byId) {
    if (ids.length < 2) return ids;
    const out = [ids[0]];
    for (let i = 1; i < ids.length; i++) {
      const u = byId[ids[i-1]], v = byId[ids[i]];
      if (!u || !v) { out.push(ids[i]); continue; }
      const direct = rtDist3(u, v);
      const dy = Math.abs(v.position.y - u.position.y);
      const crossesLevels = rtSweepsCrossLevels(u, v);
      if (!crossesLevels && direct <= RT_TELEPORT_HOP_M) { out.push(ids[i]); continue; }
      const budget = crossesLevels
        ? Math.min(direct * RT_LEVEL_CHANGE_DETOUR_MAX, direct + RT_LEVEL_CHANGE_DETOUR_ABS_M)
        : direct * RT_TELEPORT_DETOUR_MAX;
      let leg = [];
      if (crossesLevels) {
        leg = rtPlanLegMostScanPoints(u, v, rtSweeps, byId, budget);
        if (leg.length <= 1) leg = rtPlanLegByLeastClimb(u, v, byId);
      } else {
        leg = rtPlanLegByDistance(u, v, byId);
      }
      if (leg.length <= 1) { out.push(ids[i]); continue; }
      let legDist = 0, legRise = 0, prev = u;
      for (const sid of leg) {
        const node = byId[sid]; if (!node) continue;
        legDist += rtDist3(prev, node);
        legRise = Math.max(legRise, Math.abs(node.position.y - prev.position.y));
        prev = node;
      }
      if (legDist > budget) { out.push(ids[i]); continue; }
      if (crossesLevels && legRise > dy * RT_LEVEL_CHANGE_IMPROVEMENT) { out.push(ids[i]); continue; }
      const already = {}, upcoming = {};
      for (const id of out) already[id] = true;
      for (let b = i+1; b < ids.length; b++) upcoming[ids[b]] = true;
      let doublesBack = false;
      for (let m = 0; m < leg.length-1; m++) { if (already[leg[m]] || upcoming[leg[m]]) { doublesBack=true; break; } }
      if (doublesBack) { out.push(ids[i]); continue; }
      for (const sid of leg) out.push(sid);
    }
    return rtCollapseLoops(out);
  }

  function rtDijkstra(fromSid, toSid, rtSweeps, byId) {
    if (fromSid === toSid) return [fromSid];
    const best = {}, prev = {}, unvisited = {};
    for (const s of rtSweeps) unvisited[s.sid] = true;
    best[fromSid] = 0;
    for (;;) {
      let curId = null, curCost = Infinity;
      for (const id in unvisited) {
        if (best[id] !== undefined && best[id] < curCost) { curCost = best[id]; curId = id; }
      }
      if (!curId || curId === toSid) break;
      delete unvisited[curId];
      const cur = byId[curId]; if (!cur) continue;
      for (const nId of cur.neighbours) {
        if (!unvisited[nId]) continue;
        const nb = byId[nId]; if (!nb) continue;
        const cost = curCost + Math.pow(rtDist3(cur, nb), RT_HOP_EXP);
        if (best[nId] === undefined || cost < best[nId]) { best[nId] = cost; prev[nId] = curId; }
      }
    }
    if (best[toSid] === undefined) return [];
    const raw = [];
    for (let id = toSid; id !== undefined; id = prev[id]) {
      raw.unshift(id);
      if (id === fromSid) break;
    }
    return raw;
  }

  // Sample stops from navPath: FROM + up to (maxTurns) sharpest turns + gap-fillers every
  // maxGapM along long straight runs (so a long corridor isn't one giant uninterrupted jump)
  // + TO. maxTotal is a safety cap — thins evenly (keeping FROM/TO) if gap-filling overshoots.
  function rtSampleKeyPoints(pts, maxTurns, maxGapM, maxTotal) {
    if (pts.length <= 2) return pts.slice();
    // Score every interior point by how sharp the turn is (1 - dot product).
    const scored = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
      const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y;
      const dx2 = next.x - cur.x,  dy2 = next.y - cur.y;
      const len1 = Math.sqrt(dx1*dx1 + dy1*dy1);
      const len2 = Math.sqrt(dx2*dx2 + dy2*dy2);
      if (len1 < 0.5 || len2 < 0.5) continue;
      const dot = (dx1*dx2 + dy1*dy2) / (len1 * len2);
      const sharpness = 1 - dot; // 0 = straight, 2 = U-turn
      if (sharpness > 0.1) scored.push({ pt: pts[i], sharpness, i });
    }
    scored.sort((a, b) => b.sharpness - a.sharpness);
    const keptIdx = new Set(scored.slice(0, maxTurns).map(s => s.i));
    keptIdx.add(0);
    keptIdx.add(pts.length - 1);

    // Fill long straight gaps so no single hop spans more than maxGapM metres.
    if (maxGapM > 0) {
      let acc = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i];
        acc += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + ((b.z || 0) - (a.z || 0)) ** 2);
        if (keptIdx.has(i)) { acc = 0; continue; }
        if (acc >= maxGapM) { keptIdx.add(i); acc = 0; }
      }
    }

    let orderedIdx = [...keptIdx].sort((a, b) => a - b);
    // Safety cap — thin evenly (always keeping first/last) if gap-filling overshot.
    if (maxTotal && orderedIdx.length > maxTotal) {
      const stride = (orderedIdx.length - 1) / (maxTotal - 1);
      const thinned = [];
      for (let k = 0; k < maxTotal; k++) thinned.push(orderedIdx[Math.round(k * stride)]);
      orderedIdx = [...new Set(thinned)];
    }
    return orderedIdx.map(i => pts[i]);
  }

  // When route.sweep_ids is empty but route.navPath exists:
  // 1. Sample key turning points from navPath (FROM + direction-change guides + TO)
  // 2. Snap each to the nearest Matterport scan point
  // 3. Set sweepIds/sweepNodes for fast INSTANT-transition auto-play
  async function fillSweepIdsFromNavPath(sdk, route) {
    const pts = (route.navPath || route.smoothed || route.nodes || [])
      .filter(p => isFinite(p.x) && isFinite(p.y));
    if (pts.length < 2) return;

    const rtSweeps = await rtReadSweeps(sdk);
    if (!rtSweeps.length) {
      console.warn("[MpPreview] Sweep data unavailable — cannot compute tour route from navPath");
      return;
    }
    const byId = {};
    for (const s of rtSweeps) byId[s.sid] = s;

    // FROM + up to 22 sharpest turns + a stop at least every 5m of straight corridor + TO,
    // capped at 40 total stops — many more scan points than before so the tour reads as a
    // walk through the space rather than a handful of long jumps.
    const keyPts = rtSampleKeyPoints(pts, 22, 5, 40);

    // For each key waypoint, find the nearest scan point in Matterport Y-up space.
    const ids = [];
    for (const p of keyPts) {
      const mp = rtToMp(p);
      const sw = rtNearestSweep(rtSweeps, mp);
      if (sw && (!ids.length || ids[ids.length - 1] !== sw.sid)) ids.push(sw.sid);
    }
    if (!ids.length) return;

    // Update module state; use NavMe Z-up coords for sweepNodes so modelToSdk works.
    sweepIds = ids;
    sweepNodes = ids.map(sid => {
      const s = byId[sid];
      return s ? { id: sid, x: s.position.x, y: -s.position.z, z: s.position.y } : { id: sid };
    });
    stepI = 0;
    // Point at the destination POI's own xyz when passed (more exact than the navPath's
    // terminal point, which often stops at a doorway rather than the POI's in-room position).
    if (route._destXYZ && route._destXYZ.x != null) {
      routeDest = route._destXYZ;
    } else {
      const destPt = pts[pts.length - 1];
      routeDest = { x: destPt.x, y: destPt.y, z: destPt.z || 0 };
    }
    navPathTour = true;
    buildSweepDistances({});
    updateStep();
    console.info("[MpPreview] Tour route from navPath:", ids.length, "key waypoints");
  }
  // ─────────────────────────────────────────────────────────────────────────────

  function dedupeConsecutive(ids) {
    const out = [];
    for (const id of ids || []) {
      if (!id) continue;
      if (!out.length || out[out.length - 1] !== id) out.push(id);
    }
    return out;
  }

  function prepareRoute(route) {
    navPathTour = false;
    const ids = dedupeConsecutive(route && route.sweep_ids);
    const allNodes = (route && route.nodes) || [];
    const nodes = allNodes.filter(n => n && n.kind === "sweep");
    const byId = new Map();
    for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    sweepNodes = ids.map(id => byId.get(id) || { id });
    sweepIds = ids;
    stepI = 0;
    // Final look target: the destination POI's own xyz when the caller passed one — more
    // exact than the path's terminal node, which often stops at a doorway/corridor point
    // rather than the POI's actual in-room position. Falls back to the path-derived point.
    routeDest = (route && route._destXYZ && route._destXYZ.x != null) ? route._destXYZ : null;
    if (!routeDest) {
      for (let k = allNodes.length - 1; k >= 0; k--) {
        const n = allNodes[k];
        if (n && n.x != null && n.y != null) { routeDest = n; break; }
      }
    }
    if (!routeDest && sweepNodes.length) routeDest = sweepNodes[sweepNodes.length - 1];
    routeTotalM = (route && route.total_m != null && Number.isFinite(+route.total_m)) ? +route.total_m : null;
    buildSweepDistances(route);
    return ids;
  }

  /** Horizontal meters in model Z-up (x,y). Prefer route link lengths when they match consecutive sweeps. */
  function horizM(a, b) {
    if (!a || !b || a.x == null || b.x == null || a.y == null || b.y == null) return null;
    return Math.hypot((+b.x) - (+a.x), (+b.y) - (+a.y));
  }

  function buildSweepDistances(route) {
    segDistM = [];
    cumDistM = [];
    const n = sweepNodes.length;
    if (!n) return;
    // Optional: map of undirected sweep-pair → length from route.links
    const linkLen = new Map();
    const links = (route && route.links) || [];
    for (const L of links) {
      if (!L || L.length == null) continue;
      const u = L.u, v = L.v;
      if (u == null || v == null) continue;
      const key = u < v ? u + "|" + v : v + "|" + u;
      if (!linkLen.has(key)) linkLen.set(key, +L.length);
    }
    cumDistM = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) {
      let d = null;
      const a = sweepNodes[i], b = sweepNodes[i + 1];
      if (a && b && a.id && b.id) {
        const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
        if (linkLen.has(key)) d = linkLen.get(key);
      }
      if (d == null || !Number.isFinite(d)) d = horizM(a, b);
      if (d == null || !Number.isFinite(d)) d = 0;
      segDistM[i] = Math.max(0, d);
      cumDistM[i + 1] = cumDistM[i] + segDistM[i];
    }
    // Last "leg" toward dest if dest is beyond final sweep
    if (n >= 1 && routeDest) {
      const last = sweepNodes[n - 1];
      const same = last && routeDest.id && last.id === routeDest.id;
      const near = last && routeDest.x != null && last.x != null &&
        Math.hypot((+routeDest.x) - (+last.x), (+routeDest.y) - (+last.y)) < 0.15;
      if (!same && !near) {
        const d = horizM(last, routeDest);
        segDistM[n - 1] = (d != null && Number.isFinite(d)) ? Math.max(0, d) : 0;
      } else {
        segDistM[n - 1] = 0;
      }
    } else {
      segDistM[n - 1] = 0;
    }
    const totalM = cumDistM[n - 1] + (segDistM[n - 1] || 0);
    tourPaceScale = computeTourPaceScale(totalM);
  }

  /** Big routes play faster (less dead time covering lots of ground); small routes play
   *  slower (more cinematic lingering since there isn't much distance to cover anyway). */
  function computeTourPaceScale(totalM) {
    if (!Number.isFinite(totalM) || totalM <= 0) return 1;
    const SHORT_M = 20, SHORT_SCALE = 1.5;   // short hop between neighbouring rooms
    const LONG_M = 200, LONG_SCALE = 0.6;    // long cross-building trek
    if (totalM <= SHORT_M) return SHORT_SCALE;
    if (totalM >= LONG_M) return LONG_SCALE;
    const t = (totalM - SHORT_M) / (LONG_M - SHORT_M);
    return SHORT_SCALE + (LONG_SCALE - SHORT_SCALE) * t;
  }

  /** Remaining meters from stop i to end of tour (sweeps + final dest leg). */
  function remainingDistM(i) {
    const n = sweepNodes.length;
    if (!n || i == null || i < 0) return null;
    if (i >= n - 1) {
      const lastLeg = segDistM[n - 1];
      return (lastLeg != null && Number.isFinite(lastLeg)) ? lastLeg : 0;
    }
    const totalPath = cumDistM[n - 1] != null ? cumDistM[n - 1] : 0;
    const at = cumDistM[i] != null ? cumDistM[i] : 0;
    const tail = segDistM[n - 1] || 0;
    const fromSweeps = Math.max(0, totalPath - at + tail);
    // Fallback: scale route.total_m when sweep xyz/links yielded nothing usable
    if (fromSweeps < 0.05 && routeTotalM != null && routeTotalM > 0 && n > 1) {
      return Math.max(0, routeTotalM * ((n - 1 - i) / (n - 1)));
    }
    return fromSweeps;
  }

  function nextLegDistM(i) {
    if (i == null || i < 0 || i >= segDistM.length) return null;
    const d = segDistM[i];
    return (d != null && Number.isFinite(d) && d > 0.05) ? d : null;
  }

  function fmtMeters(m) {
    if (m == null || !Number.isFinite(m)) return "—";
    if (m < 1) return "<1 m";
    if (m >= 1000) return (m / 1000).toFixed(1) + " km";
    return Math.round(m) + " m";
  }

  // MatterPak / nav graph: Z-up, horizontal x,y. Showcase Camera: Y-up (x, y-up, z≈-y).

  function modelToSdk(p) {
    if (!p || p.x == null || p.y == null) return null;
    return { x: +p.x, y: (p.z != null ? +p.z : 0), z: -(+p.y) };
  }

  function normDeltaDeg(d) {
    return ((d + 540) % 360) - 180;
  }

  /** Build 1A nav pointer via DOM (createElementNS) — never inject SVG via innerHTML/HTML parse. */
  function buildNavPointerInner() {
    const inner = document.createElement("div");
    inner.className = "mp-dir-arr";
    inner.setAttribute("aria-hidden", "true");
    try {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "mp-dir-svg");
      svg.setAttribute("viewBox", "0 0 72 72");
      svg.setAttribute("focusable", "false");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(NS, "path");
      path.setAttribute("fill", "#1a73e8");
      path.setAttribute("stroke", "#ffffff");
      path.setAttribute("stroke-width", "3.5");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("d", "M36 6 L62 58 L36 46 L10 58 Z");
      svg.appendChild(path);
      inner.appendChild(svg);
    } catch (_) {
      // Fallback: simple blue glyph (pre-tour1e working arrow)
      inner.textContent = "➤";
    }
    return inner;
  }

  function ensureDirArrowMount() {
    const wrap = document.querySelector("#mpOverlay .mp-frame-wrap");
    if (!wrap) return null;
    let el = $("mpDirArrow");
    if (!el) {
      el = document.createElement("div");
      el.id = "mpDirArrow";
      el.className = "mp-dir-arrow";
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
      el.appendChild(buildNavPointerInner());
      wrap.appendChild(el);
    } else if (el.parentElement !== wrap) {
      // Re-parent if static shell / ensureOverlay diverged
      wrap.appendChild(el);
    }
    // Upgrade legacy text glyph → DOM SVG pointer (safe; no HTML-string SVG)
    if (!el.querySelector(".mp-dir-svg")) {
      el.textContent = "";
      el.appendChild(buildNavPointerInner());
    }
    // Keep above iframe compositor layer (Safari/WebKit paints transformed iframes on top)
    el.style.zIndex = "30";
    el.style.pointerEvents = "none";
    return el;
  }

  function hideDirArrow() {
    const el = $("mpDirArrow");
    if (el) {
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
      el.classList.remove("big", "subtle", "visible");
    }
  }

  /** Small distance label under nav pointer (no pill panel). */
  const DIST_LABEL_HTML =
    '<span class="mp-dist-val" id="mpDistRem">—</span>' +
    '<span class="mp-dist-leg" id="mpDistLegRow" hidden>' +
    '<span class="mp-dist-sep" aria-hidden="true">·</span>' +
    '<span class="mp-dist-leg-val" id="mpDistLeg">—</span>' +
    '</span>';

  function ensureDistHudMount() {
    const wrap = document.querySelector("#mpOverlay .mp-frame-wrap");
    if (!wrap) return null;
    let el = $("mpDistHud");
    if (!el) {
      el = document.createElement("div");
      el.id = "mpDistHud";
      el.className = "mp-dist-hud";
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = DIST_LABEL_HTML;
      wrap.appendChild(el);
    } else if (el.parentElement !== wrap) {
      wrap.appendChild(el);
    }
    // Upgrade legacy pill chip markup → plain label
    if (!el.querySelector("#mpDistRem") || el.querySelector(".mp-dist-rem") || el.querySelector(".mp-dist-lbl")) {
      el.innerHTML = DIST_LABEL_HTML;
    }
    el.style.zIndex = "30";
    el.style.pointerEvents = "none";
    return el;
  }

  function hideDistHud() {
    const el = $("mpDistHud");
    if (el) {
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
      el.classList.remove("visible");
    }
  }

  function updateDistHud(i) {
    const el = ensureDistHudMount();
    if (!el) return;
    if (!playing || stopped || !sweepIds.length) {
      hideDistHud();
      return;
    }
    const idx = i != null ? i : stepI;
    const rem = remainingDistM(idx);
    const leg = nextLegDistM(idx);
    const remEl = $("mpDistRem");
    const legEl = $("mpDistLeg");
    const legRow = $("mpDistLegRow");
    if (remEl) remEl.textContent = fmtMeters(rem);
    if (legEl) legEl.textContent = leg != null ? fmtMeters(leg) : "";
    if (legRow) legRow.hidden = leg == null;
    el.hidden = false;
    el.removeAttribute("hidden");
    el.setAttribute("aria-hidden", "false");
    el.classList.add("visible");
  }

  async function getPoseYaw() {
    if (!mpSdk || !mpSdk.Camera) return null;
    try {
      if (typeof mpSdk.Camera.getPose === "function") {
        const pose = await mpSdk.Camera.getPose();
        if (pose && pose.rotation && pose.rotation.y != null) return +pose.rotation.y;
      }
    } catch (_) { /* ignore */ }
    try {
      if (mpSdk.Camera.pose && typeof mpSdk.Camera.pose.getLatest === "function") {
        const pose = mpSdk.Camera.pose.getLatest();
        if (pose && pose.rotation && pose.rotation.y != null) return +pose.rotation.y;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * 1A: Nav pointer — ALWAYS visible while tour is playing; tip points toward next waypoint
   * (or dest at last). SVG tip is screen-up at 0°, so rotate(rel) only (no -90° ➤ offset).
   * Do NOT use low-opacity "subtle" when aligned.
   */
  async function updateDirArrow(i) {
    const el = ensureDirArrowMount();
    if (!el) return;
    if (!playing || stopped || !sweepIds.length) {
      hideDirArrow();
      return;
    }
    const want = headingToward(i != null ? i : stepI);
    // Keep pointer up even if heading unknown (still signals "touring").
    const poseYaw = await getPoseYaw();
    let rel = 0;
    if (want != null && Number.isFinite(want) && poseYaw != null) {
      rel = normDeltaDeg(want - poseYaw);
    }
    const absRel = Math.abs(rel);
    el.hidden = false;
    el.removeAttribute("hidden");
    el.setAttribute("aria-hidden", "false");
    el.classList.add("visible");
    el.classList.toggle("big", absRel > HUD_TURN_EMPHASIS_DEG);
    el.classList.remove("subtle"); // never fade — always high-contrast while playing
    const glyph = el.querySelector(".mp-dir-arr");
    if (glyph) {
      glyph.style.transform = `rotate(${rel}deg)`;
      glyph.style.opacity = "1";
    }
  }

  /**
   * Showcase / Three.js yaw (deg): identity looks down −Z; positive y turns right.
   * Forward = (−sin(y), 0, −cos(y)) ⇒ y = atan2(−dx, −dz). Using atan2(dx, dz) faces REVERSE.
   * `from`/`to` are Showcase Y-up positions ({x,y,z}).
   */
  function yawSdk(from, to) {
    if (!from || !to || from.x == null || to.x == null) return null;
    const dx = (+to.x) - (+from.x);
    const dz = (+to.z) - (+from.z);
    if (Math.hypot(dx, dz) < 1e-4) return null;
    return Math.atan2(-dx, -dz) * 180 / Math.PI;
  }

  /** Look-ahead: current sweep → next (or dest). Model Z-up via modelToSdk. */
  function headingToward(i) {
    const a = modelToSdk(sweepNodes[i]);
    let b = null;
    if (i + 1 < sweepNodes.length) b = modelToSdk(sweepNodes[i + 1]);
    else if (routeDest) b = modelToSdk(routeDest);
    return yawSdk(a, b);
  }


  async function sdkSweepPosition(id) {
    if (!mpSdk || !id) return null;
    try {
      const data = mpSdk.Sweep && mpSdk.Sweep.data;
      if (!data) return null;
      let sw = null;
      if (typeof data.get === "function") sw = data.get(id);
      else if (data[id]) sw = data[id];
      if (!sw && typeof data.then === "function") {
        const m = await data;
        sw = (m && m.get) ? m.get(id) : (m && m[id]);
      }
      if (sw && sw.position) return { x: sw.position.x, y: sw.position.y, z: sw.position.z };
    } catch (_) { /* ignore */ }
    const n = sweepNodes.find(s => s && s.id === id);
    return modelToSdk(n);
  }

  /** @returns {boolean|undefined} false if pose is ~reverse (>90°) of want; true/undefined otherwise */
  async function assertFacingYaw(wantYaw, label) {
    if (wantYaw == null || !Number.isFinite(wantYaw)) return;
    try {
      const got = await getPoseYaw();
      if (got == null) return;
      const delta = Math.abs(normDeltaDeg(wantYaw - got));
      if (delta > 15) {
        console.warn("look-ahead yaw mismatch", { label: label || "face", want: wantYaw, got, delta });
      }
      if (delta > 90) return false; // treat as reverse — caller should try lookAt
      return true;
    } catch (_) { /* ignore */ }
  }

  /**
   * 3A: Point camera along the route toward the **next waypoint** (or dest on last stop).
   * Prefer smooth Camera.setRotation({speed}); lookAt second; INSTANT Sweep.moveTo last (avoid remount thrash).
   */
  async function faceAlongRoute(i) {
    if (!mpSdk || !mpSdk.Camera) return;
    const fromId = sweepIds[i];
    const from = await sdkSweepPosition(fromId) || modelToSdk(sweepNodes[i]);
    let to = null;
    // Look-ahead: next sweep when available — not always final dest (indoor corridors).
    if (i + 1 < sweepIds.length) {
      to = await sdkSweepPosition(sweepIds[i + 1]) || modelToSdk(sweepNodes[i + 1]);
    } else if (routeDest) {
      to = modelToSdk(routeDest);
    } else if (i > 0) {
      const prev = await sdkSweepPosition(sweepIds[i - 1]) || modelToSdk(sweepNodes[i - 1]);
      if (prev && from) {
        to = { x: from.x + (from.x - prev.x), y: from.y, z: from.z + (from.z - prev.z) };
      }
    }
    if (!from || !to) return;
    const yaw = yawSdk(from, to);
    if (yaw == null) return;

    // moveTo() already set this same look-ahead heading as the in-flight rotation target,
    // so the camera should already be facing here — skip if close to avoid any perceptible
    // residual snap on arrival (this call is now just a safety net, not the primary turn).
    try {
      const got = await getPoseYaw();
      if (got != null && Math.abs(normDeltaDeg(yaw - got)) < 6) return;
    } catch (_) { /* ignore */ }
    const target = { x: to.x, y: from.y, z: to.z }; // level pitch

    // Prefer smooth setRotation with Showcase −Z forward yaw; lookAt recovers if pose still reverse.
    if (typeof mpSdk.Camera.setRotation === "function") {
      try {
        await mpSdk.Camera.setRotation({ x: 0, y: yaw }, { speed: FACE_ROTATE_SPEED });
        const ok = await assertFacingYaw(yaw, "setRotation+speed");
        if (ok !== false) return;
      } catch (e) { console.warn("Camera.setRotation(speed) failed", e); }
      try {
        await mpSdk.Camera.setRotation({ x: 0, y: yaw });
        const ok = await assertFacingYaw(yaw, "setRotation");
        if (ok !== false) return;
      } catch (e2) { console.warn("Camera.setRotation failed", e2); }
    }

    try {
      if (typeof mpSdk.Camera.lookAt === "function") {
        await mpSdk.Camera.lookAt(target);
        await assertFacingYaw(yaw, "lookAt");
        return;
      }
    } catch (e) { console.warn("Camera.lookAt failed", e); }

    // Last resort: same-sweep INSTANT with rotation (can thrash WebGL — avoid if possible)
    try {
      await mpSdk.Sweep.moveTo(fromId, {
        rotation: { x: 0, y: yaw },
        transition: (mpSdk.Sweep.Transition && mpSdk.Sweep.Transition.INSTANT) || undefined,
      });
      await assertFacingYaw(yaw, "moveTo-instant");
    } catch (_) { /* ignore */ }
  }


  /** Setting the same iframe src twice is a no-op in browsers, so re-entering MP mode
   *  a second time needs an about:blank reset to force a fresh navigation — but on
   *  first load the iframe has no src at all yet, so that detour (one wasted
   *  navigation + a flat 40ms sleep) can be skipped, letting the real — already
   *  slow-on-mobile — Showcase bundle start loading immediately. Returns true if the
   *  reset ran (caller should still re-check its own gen before navigating to url). */
  async function resetFrameIfNeeded(iframe) {
    const curSrc = iframe.getAttribute("src") || "";
    if (!curSrc || curSrc === "about:blank") return false;
    iframe.src = "about:blank";
    await new Promise(r => setTimeout(r, 40));
    return true;
  }

  function waitIframeLoad(iframe, gen) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        iframe.removeEventListener("load", onLoad);
        resolve();
      };
      const onLoad = () => {
        try {
          const src = iframe.getAttribute("src") || "";
          if (!src || src === "about:blank") return; // ignore blank reset
        } catch (_) { /* ignore */ }
        done();
      };
      iframe.addEventListener("load", onLoad);
      setTimeout(done, 12000);
      // If already complete for a real URL
      try {
        const src = iframe.getAttribute("src") || "";
        if (src && src !== "about:blank" && iframe.contentWindow) {
          // cannot read cross-origin readyState; rely on load / timeout
        }
      } catch (_) { /* ignore */ }
      void gen;
    });
  }

  function phaseConsts(sdk) {
    const P = (sdk && sdk.App && sdk.App.Phase) || {};
    return {
      PLAYING: P.PLAYING || "appphase.playing",
      WAITING: P.WAITING || "appphase.waiting",
      STARTING: P.STARTING || "appphase.starting",
      LOADING: P.LOADING || "appphase.loading",
      ERROR: P.ERROR || "appphase.error",
    };
  }

  async function readPhase(sdk) {
    try {
      if (sdk.App.state && typeof sdk.App.state.getLatest === "function") {
        const st = sdk.App.state.getLatest();
        if (st && st.phase) return st.phase;
      }
    } catch (_) { /* ignore */ }
    return await new Promise((resolve) => {
      let done = false;
      const fin = (p) => { if (done) return; done = true; try { unsub && unsub(); } catch (_) {} resolve(p); };
      let unsub = null;
      try {
        unsub = sdk.App.state.subscribe((st) => fin(st && st.phase));
      } catch (_) { fin(null); }
      setTimeout(() => fin(null), 1500);
    });
  }

  async function waitPlaying(sdk, timeoutMs, onWaiting) {
    if (!sdk || !sdk.App || !sdk.App.state) return false;
    const Ph = phaseConsts(sdk);
    const deadline = Date.now() + (timeoutMs || 60000);
    let prompted = false;
    try {
      // Poll + waitUntil so we never treat WAITING as ready (older bug: empty Phase made waitUntil resolve immediately).
      while (Date.now() < deadline) {
        const phase = await readPhase(sdk);
        if (phase === Ph.ERROR) {
          connectError = "Showcase reported an error phase";
          return false;
        }
        if (phase === Ph.PLAYING) return true;
        if ((phase === Ph.WAITING || phase === Ph.LOADING || phase === Ph.STARTING || !phase) && !prompted) {
          prompted = true;
          if (typeof onWaiting === "function") onWaiting(phase || Ph.WAITING);
        }
        const remaining = Math.max(500, deadline - Date.now());
        try {
          await Promise.race([
            sdk.App.state.waitUntil(st => st && st.phase === Ph.PLAYING),
            new Promise((r) => setTimeout(r, Math.min(4000, remaining)))
          ]);
        } catch (_) {
          await new Promise(r => setTimeout(r, 400));
        }
      }
      connectError = "timeout waiting for PLAYING (still on Matterport launch/Enter screen?)";
      return false;
    } catch (e) {
      connectError = (connectError || "") + (connectError ? "; " : "") + ((e && e.message) || "Showcase not ready");
      return false;
    }
  }

  async function connectSdk(iframe) {
    connectError = "";
    if (!applicationKey) return null;
    await loadSdkScript();
    if (!window.MP_SDK || !window.MP_SDK.connect) {
      connectError = "Matterport SDK bootstrap loaded but MP_SDK.connect is unavailable.";
      return null;
    }
    try {
      mpSdk = await window.MP_SDK.connect(iframe, applicationKey, "");
      window.__mpSdk = mpSdk;   // debug handle for console inspection
      return mpSdk;
    } catch (e) {
      connectError = (e && (e.message || String(e))) || "SDK connect failed";
      mpSdk = null;
      return null;
    }
  }

  async function knownSweepIds(sdk) {
    try {
      const data = sdk.Sweep && sdk.Sweep.data;
      if (!data) return null;
      if (typeof data === "object" && !Array.isArray(data)) return new Set(Object.keys(data));
    } catch (_) { /* ignore */ }
    try {
      if (sdk.Sweep && typeof sdk.Sweep.getData === "function") {
        const d = await sdk.Sweep.getData();
        if (d && typeof d === "object") return new Set(Object.keys(d));
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  // ── Floor control for ui.js's floor-picker buttons (Showcase's own floor explorer is
  // hidden — see f=0 in showcaseUrl). Matterport's native Floor API turned out to be a dead
  // end for this content: Floor.getData() reports totalFloors:1 here (floors were never
  // tagged in Matterport's own capture tool), so Floor.moveTo() is a silent no-op — verified
  // live (moveTo(0) resolves but currentFloor stays -1). Our 5 floors are a NavMe-only
  // construct, built from each sweep's real height (WF.cfg.floors[].elevation, same SDK Y-up
  // units as sweep.position.y — see WFNavmeshRoute.floorAt, already used by the navmesh
  // router for the same height→floor lookup).
  //
  // First version flew the camera into a representative sweep on that floor (Sweep.moveTo),
  // which switches Showcase out of Dollhouse into first-person Panorama mode — not what was
  // asked for ("show the floors in the dollhouse view"). Camera.lookAt(target), verified live,
  // re-centres the Dollhouse orbit on a point WITHOUT leaving Dollhouse mode (confirmed via
  // Camera.getPose(): mode stayed "mode.dollhouse", position moved toward the target, rotation
  // unchanged) — so floor buttons now stay in Dollhouse and just refocus on that floor. ──
  function sweepFloorId(sdkY) {
    try {
      const floors = (window.WF && WF.cfg && WF.cfg.floors) || [];
      if (window.WFNavmeshRoute && WFNavmeshRoute.floorAt) {
        const f = WFNavmeshRoute.floorAt(sdkY, floors);
        return f ? f.id : null;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async function ensureDollhouse() {
    const Mode = mpSdk.Mode;
    if (Mode && Mode.moveTo && Mode.Mode) {
      const dh = Mode.Mode.DOLLHOUSE || Mode.Mode.Dollhouse || "mode.dollhouse";
      await Mode.moveTo(dh, { transition: (Mode.Transition && Mode.Transition.FLY) || undefined });
    }
  }

  /** floorId: one of WF.cfg.floors[].id (e.g. "F1"), or "all"/falsy to reset to the default,
   *  unfiltered Dollhouse overview this background view already opens into. */
  async function setFloor(floorId) {
    if (!mpSdk) return false;
    if (!floorId || floorId === "all") {
      try { await ensureDollhouse(); return true; }
      catch (e) { console.warn("[MpPreview] setFloor(all) failed", e); return false; }
    }
    const rtSweeps = await rtReadSweeps(mpSdk);
    if (!rtSweeps.length) return false;
    const onFloor = rtSweeps.filter(s => sweepFloorId(s.position.y) === floorId);
    if (!onFloor.length) return false;
    // Centroid of that floor's sweeps — the point the Dollhouse camera re-centres on.
    const cx = onFloor.reduce((a, s) => a + s.position.x, 0) / onFloor.length;
    const cy = onFloor.reduce((a, s) => a + s.position.y, 0) / onFloor.length;
    const cz = onFloor.reduce((a, s) => a + s.position.z, 0) / onFloor.length;
    try {
      await ensureDollhouse();
      await mpSdk.Camera.lookAt({ x: cx, y: cy, z: cz });
      return true;
    } catch (e) { console.warn("[MpPreview] setFloor lookAt failed", e); return false; }
  }

  /** Camera.zoomBy is only valid in first-person Inside mode (pose.mode === "mode.inside" —
   *  verified live; Dollhouse rejects it with "Zoom controls are currently only supported in
   *  Panorama mode", a misleading message since the real mode string is "inside" not
   *  "panorama"). Dollhouse has NO zoom/dolly API at all: moveInDirection is Inside-only too,
   *  orbit() turned out to be an auto-spin toggle (not a manual nudge), and Camera.lookAt —
   *  the only way to reposition in Dollhouse — snaps to ITS OWN preferred framing distance for
   *  whatever point it's given, not a proportional move toward it (verified live: aiming it at
   *  a point just 10m ahead from ~200 units out away moved the camera 146 units in one step,
   *  the opposite of a gentle zoom step). So Dollhouse zoom is left as a no-op here — the
   *  dollhouse view still supports native pinch/scroll zoom by interacting with it directly. */
  async function zoomBy(delta) {
    if (!mpSdk || !mpSdk.Camera) return false;
    try {
      const pose = await mpSdk.Camera.getPose();
      if (pose && pose.mode === "mode.inside" && typeof mpSdk.Camera.zoomBy === "function") {
        await mpSdk.Camera.zoomBy(delta);
        return true;
      }
    } catch (e) { console.warn("[MpPreview] zoomBy failed", e); }
    return false;
  }

  /** "Your location" has no GPS/map meaning in mp mode — repurposed as a home/reset button. */
  async function resetView() { return setFloor(null); }

  async function alignSweepIds(sdk) {
    const known = await knownSweepIds(sdk);
    if (!known || !known.size || !sweepIds.length) return sweepIds;
    const missing = sweepIds.filter(id => !known.has(id));
    if (!missing.length) return sweepIds;
    // case-insensitive remap
    const lower = new Map([...known].map(id => [id.toLowerCase(), id]));
    const mapped = sweepIds.map(id => (known.has(id) ? id : (lower.get(String(id).toLowerCase()) || id)));
    const stillBad = mapped.filter(id => !known.has(id));
    sweepIds = mapped;
    sweepNodes = sweepIds.map((id, i) => Object.assign({}, sweepNodes[i] || {}, { id }));
    if (stillBad.length === sweepIds.length) {
      setStatus("Route sweep IDs do not match this Matterport model (" + modelId + "). Twin is open for manual look-around.", true);
      return [];
    }
    if (stillBad.length) {
      sweepIds = mapped.filter(id => known.has(id));
      setStatus("Some route sweeps are missing in this model — touring " + sweepIds.length + " matched stops.", false);
    }
    updateStep();
    return sweepIds;
  }

  /** FLY duration from hop length (metres). Longer, sweeping pans feel more like a tracked
   *  movie shot than a snap-cut; short neighbour hops still stay reasonably brisk. Scaled by
   *  tourPaceScale so the whole tour speeds up on big routes and slows down on small ones. */
  function flyTransitionMs(hopM) {
    let base;
    if (hopM == null || !Number.isFinite(hopM) || hopM <= 0) base = 1400;
    else if (hopM < 1.5) base = 1100;
    else if (hopM < 4) base = 1700;
    else if (hopM < 8) base = 2600;
    else if (hopM < 15) base = 3600;
    else base = 4400; // cap — very long LOS shortcuts
    return Math.round(base * tourPaceScale);
  }

  async function moveTo(i) {
    if (!mpSdk || i < 0 || i >= sweepIds.length) return false;
    const id = sweepIds[i];
    const tr = mpSdk.Sweep.Transition;
    // navPathTour: same distance-scaled cinematic FLY as the standard branch — this used
    // to be a hardcoded fast 600ms regardless of hop length, which read as "teleporting".
    if (navPathTour) {
      const isLastStop = i === sweepIds.length - 1;
      const hopM = (i > 0 && segDistM[i - 1] != null) ? +segDistM[i - 1] : 0;
      let tFly = flyTransitionMs(hopM);
      if (isLastStop && i > 0) tFly = Math.min(Math.round(tFly * 1.5), 4500);
      // Rotate toward the NEXT waypoint (look-ahead) DURING the flight itself, so the turn
      // happens smoothly mid-transit and the camera lands already facing where it's going
      // next — instead of arriving facing backward and snap-rotating after stopping.
      const navOpts = { transition: (tr && tr.FLY) || "transition.fly", transitionTime: tFly };
      const hNav = headingToward(i);
      if (hNav != null && Number.isFinite(hNav)) navOpts.rotation = { x: 0, y: hNav };
      try {
        await mpSdk.Sweep.moveTo(id, navOpts);
      } catch (e) {
        console.warn("Sweep.moveTo failed", id, e);
        return false;
      }
      // Safety-net correction only — the in-flight rotation above should already have
      // landed on this heading, so faceAlongRoute is a no-op unless something drifted.
      try { await faceAlongRoute(i); } catch (_) { /* ignore */ }
      stepI = i;
      updateStep();
      try { await updateDirArrow(i); } catch (_) { /* ignore */ }
      try { updateDistHud(i); } catch (_) { /* ignore */ }
      try { updateTourInstruction(sweepNodes[i], i === sweepIds.length - 1); } catch (_) { /* ignore */ }
      return true;
    }
    // Standard FLY transition for routes with server-provided sweep IDs.
    const hopM = (i > 0 && segDistM[i - 1] != null) ? +segDistM[i - 1] : 0;
    const isLastStop = i === sweepIds.length - 1;
    let tFly = i === 0 ? Math.round(1000 * tourPaceScale) : flyTransitionMs(hopM);
    if (isLastStop && i > 0) tFly = Math.min(Math.round(tFly * 1.5), 4500); // slower arrival at destination
    const opts = { transition: (tr && tr.FLY) || "transition.fly", transitionTime: tFly };
    // Rotate toward the NEXT waypoint (look-ahead) during the flight so the turn happens
    // mid-transit, landing already facing onward instead of snap-rotating after arrival.
    const h = headingToward(i);
    if (h != null && Number.isFinite(h)) opts.rotation = { x: 0, y: h };
    try {
      await mpSdk.Sweep.moveTo(id, opts);
    } catch (e1) {
      try {
        await mpSdk.Sweep.moveTo(id, { transition: (tr && tr.FLY) || "transition.fly", transitionTime: tFly });
      } catch (e2) {
        console.warn("Sweep.moveTo failed", id, e2); wfDbg("warn","tour.sweep","Sweep.moveTo failed "+id+" "+(e2&&e2.message||e2));
        return false;
      }
    }
    try { await faceAlongRoute(i); } catch (e3) { console.warn("faceAlongRoute", e3); }
    stepI = i;
    updateStep();
    try { await updateDirArrow(i); } catch (_) { /* ignore */ }
    try { updateDistHud(i); } catch (_) { /* ignore */ }
    try { updateTourInstruction(sweepNodes[i], i === sweepIds.length - 1); } catch (_) { /* ignore */ }
    return true;
  }

  async function play() {
    if (!mpSdk) {
      setStatus(applicationKey
        ? (connectError || "SDK not connected — open Showcase manually or whitelist this domain in Matterport.")
        : "SDK key not configured — Showcase is open for manual exploration (no auto-walk).", true);
      return;
    }
    if (!sweepIds.length) {
      setStatus("This route has no indoor Matterport sweeps to tour.", true);
      return;
    }
    const Ph = phaseConsts(mpSdk);
    const phase = await readPhase(mpSdk);
    if (phase && phase !== Ph.PLAYING) {
      setStatus("Tap Enter inside the Matterport window first (still on the launch screen). Then press Play.", true);
      return;
    }
    playing = true;
    stopped = false;
    setStatus("Touring interior…");
    try { await updateDirArrow(stepI); } catch (_) { /* ignore */ }
    try { updateDistHud(stepI); } catch (_) { /* ignore */ }
    let moved = 0, failed = 0;
    for (let i = stepI; i < sweepIds.length; i++) {
      if (!playing || stopped) break;
      const ok = await moveTo(i);
      if (ok) moved++; else failed++;
      if (!playing || stopped) break;
      // Stay facing next waypoint only (3A) — no orbit peek / left-right wiggle
      try { await updateDirArrow(i); } catch (_) { /* ignore */ }
      try { updateDistHud(i); } catch (_) { /* ignore */ }
      // Short dwell only — FLY transitions are long enough to read the space mid-flight,
      // so a short dwell keeps consecutive hops feeling like one continuous pan. Scaled by
      // tourPaceScale (clamped) so it stays in step with the FLY speed.
      const dwellScale = Math.max(0.5, Math.min(1.6, tourPaceScale));
      await new Promise(r => setTimeout(r, Math.round((i < 2 ? 400 : 220) * dwellScale)));
    }
    if (playing && !stopped) {
      playing = false;
      hideDirArrow();
      hideDistHud();
      if (!moved && failed) {
        setStatus("Could not move the camera along the route (Sweep.moveTo failed). Check that this domain is whitelisted for the SDK key and the model matches the building.", true);
      } else if (failed) {
        setStatus("Tour finished with " + failed + " skipped stop(s).");
      } else {
        setStatus("Tour complete.");
      }
    }
  }

  function pause() {
    playing = false;
    hideDirArrow();
    hideDistHud();
    setStatus("Paused.");
  }

  function stopWalk() {
    playing = false;
    stopped = true;
    stepI = 0;
    updateStep();
    hideDirArrow();
    hideDistHud();
    setStatus("Stopped.");
  }

  function isCoarseMobile() {
    try {
      return !!(window.matchMedia && (
        window.matchMedia("(max-width: 900px)").matches ||
        window.matchMedia("(pointer: coarse)").matches
      ));
    } catch (_) { return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || ""); }
  }

  function handoffToTourPage(route) {
    const cfg = (window.WF && window.WF.cfg) || {};
    const payload = {
      v: 1,
      route: {
        sweep_ids: (route && route.sweep_ids) || [],
        nodes: (route && route.nodes) || [],
        total_m: (route && route.total_m != null) ? route.total_m : undefined,
        links: (route && route.links) || undefined,
        navPath: (route && route.navPath) || undefined,
        smoothed: (route && route.smoothed) || undefined,
        _destXYZ: (route && route._destXYZ) || undefined,
        _destName: (route && route._destName) || undefined,
        _fromName: (route && route._fromName) || undefined,
      },
      returnUrl: location.href,
      cfg: {
        slug: cfg.slug || (window.WF && window.WF.building && window.WF.building.slug) || null,
        matterport_model_id: cfg.matterport_model_id || cfg.model_id || null,
        apiBase: (cfg.apiBase || (window.WF_CONFIG && window.WF_CONFIG.apiBase) || "/api/v1/public/"),
      },
      building: (window.WF && window.WF.building) || null,
      wfConfig: window.WF_CONFIG || null,
    };
    try {
      sessionStorage.setItem("wf_mp_tour_v1", JSON.stringify(payload));
    } catch (e) {
      try { ensureOverlay(); setStatus("Could not save tour for fullscreen page: " + (e && e.message || e), true); }
      catch (_) { alert("Could not save tour for fullscreen page"); }
      return false;
    }
    const dest = new URL("tour.html", location.href);
    location.assign(dest.href);
    return true;
  }


  // ---- Media-in-twin Option 4: Tag hotspot → glass_v1 HUD (image/video/text + CTA buttons) ----
  let mediaPanels = [];
  let tagSidToPanel = Object.create(null);
  let mediaTagUnsubs = [];
  let mediaTagsInjected = false;

  function modelToSdkPos(p) {
    if (!p || p.x == null || p.y == null) return null;
    return { x: +p.x, y: (p.z != null ? +p.z : 0), z: -(+p.y) };
  }

  function modelToSdkVec(n) {
    if (!n || n.x == null || n.y == null) return null;
    return { x: +n.x, y: (n.z != null ? +n.z : 0), z: -(+n.y) };
  }

  function resolveMediaUrl(src) {
    if (!src) return "";
    const s = String(src).trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s) || s.startsWith("blob:") || s.startsWith("data:")) return s;
    if (s.startsWith("/api/")) return s;
    const cfg = (window.WF && window.WF.cfg) || window.WF_CONFIG || {};
    const slug = cfg.slug || (window.WF && window.WF.building && window.WF.building.slug) || "";
    const apiBase = (cfg.apiBase || (window.WF_CONFIG && window.WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
    if (s.startsWith("media/") && slug) {
      return apiBase + "buildings/" + encodeURIComponent(slug) + "/data/" + s.replace(/^\//, "");
    }
    // relative path under published data
    if (slug && !s.includes("://")) {
      return apiBase + "buildings/" + encodeURIComponent(slug) + "/data/" + s.replace(/^\//, "");
    }
    return s;
  }

  async function loadMediaPanels() {
    mediaPanels = [];
    const cfg = (window.WF && window.WF.cfg) || {};
    if (Array.isArray(cfg.media_panels) && cfg.media_panels.length) {
      mediaPanels = cfg.media_panels.filter(p => p && p.published !== false);
      return mediaPanels;
    }
    const slug = cfg.slug || (window.WF && window.WF.building && window.WF.building.slug);
    const apiBase = (cfg.apiBase || (window.WF_CONFIG && window.WF_CONFIG.apiBase) || "/api/v1/public/").replace(/\/?$/, "/");
    const files = (cfg.files && cfg.files.media_panels) || "media_panels.json";
    if (slug) {
      try {
        const r = await fetch(apiBase + "buildings/" + encodeURIComponent(slug) + "/data/" + files, { cache: "no-store" });
        if (r.ok) {
          const d = await r.json();
          const list = Array.isArray(d) ? d : (d.panels || d.media_panels || []);
          mediaPanels = list.filter(p => p && p.published !== false);
          if (mediaPanels.length) return mediaPanels;
        }
      } catch (_) { /* ignore */ }
    }
    // Draft fallback: admin JWT → pipeline_config.media_panels (pre-publish preview)
    try {
      const tok = localStorage.getItem("wf_admin_token") || sessionStorage.getItem("wf_admin_token");
      if (tok && slug) {
        const r = await fetch("/api/v1/admin/buildings/" + encodeURIComponent(slug), {
          headers: { Authorization: "Bearer " + tok }, cache: "no-store"
        });
        if (r.ok) {
          const d = await r.json();
          const list = (d.pipeline_config && d.pipeline_config.media_panels) || [];
          mediaPanels = (Array.isArray(list) ? list : []).filter(p => p && p.published !== false);
        }
      }
    } catch (_) { /* ignore */ }
    return mediaPanels;
  }

  function ensureGlassHud() {
    const wrap = document.querySelector("#mpOverlay .mp-frame-wrap");
    if (!wrap) return null;
    let el = $("mpMediaGlass");
    if (!el) {
      el = document.createElement("div");
      el.id = "mpMediaGlass";
      el.className = "mp-media-glass";
      el.hidden = true;
      el.innerHTML = `
        <div class="mp-media-glass-card" id="mpMediaGlassCard" role="dialog" aria-modal="true" aria-label="Media panel">
          <button type="button" class="mp-media-glass-close" id="mpMediaGlassClose" aria-label="Close">×</button>
          <div class="mp-media-glass-title" id="mpMediaGlassTitle"></div>
          <div class="mp-media-glass-well" id="mpMediaGlassWell"></div>
          <div class="mp-media-glass-body" id="mpMediaGlassBody" hidden></div>
          <div class="mp-media-glass-ctas" id="mpMediaGlassCtas" hidden></div>
        </div>`;
      wrap.appendChild(el);
      const closeBtn = $("mpMediaGlassClose");
      if (closeBtn) closeBtn.onclick = (e) => { e.preventDefault(); closeGlassHud(); };
      el.addEventListener("click", (e) => { if (e.target === el) closeGlassHud(); });
    }
    return el;
  }

  function closeGlassHud() {
    const el = $("mpMediaGlass");
    if (!el) return;
    const well = $("mpMediaGlassWell");
    if (well) {
      const vid = well.querySelector("video");
      if (vid) { try { vid.pause(); } catch (_) {} }
      well.innerHTML = "";
    }
    const body = $("mpMediaGlassBody");
    if (body) { body.innerHTML = ""; body.hidden = true; }
    const ctas = $("mpMediaGlassCtas");
    if (ctas) { ctas.innerHTML = ""; ctas.hidden = true; }
    el.hidden = true;
  }

  /** Lightweight markdown → safe HTML (escape text; bold/italic/code/links/breaks). */
  function renderPanelMarkdown(src) {
    const raw = String(src == null ? "" : src);
    // Tokenize links on raw text so hrefs are not double-escaped
    const parts = [];
    let last = 0;
    const linkRe = /\[([^\]\n]{1,80})\]\(([^)\s]{1,500})\)/g;
    let m;
    while ((m = linkRe.exec(raw)) !== null) {
      parts.push({ t: "text", v: raw.slice(last, m.index) });
      const u = String(m[2]).trim();
      if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(u)) {
        parts.push({ t: "a", label: m[1], url: u });
      } else {
        parts.push({ t: "text", v: m[0] });
      }
      last = m.index + m[0].length;
    }
    parts.push({ t: "text", v: raw.slice(last) });
    function fmtInline(chunk) {
      let s = esc(chunk);
      s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
      return s;
    }
    let html = parts.map(function (p) {
      if (p.t === "a") {
        return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' + esc(p.label) + "</a>";
      }
      return fmtInline(p.v);
    }).join("");
    html = html.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>");
    return "<p>" + html + "</p>";
  }

  function safeCtaUrl(url) {
    const u = String(url || "").trim();
    if (!u) return "";
    if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(u)) return u;
    return "";
  }

  function openCtaUrl(url) {
    const u = safeCtaUrl(url);
    if (!u) return;
    try {
      if (u.startsWith("/") || u.startsWith("#")) {
        window.open(u, "_blank", "noopener,noreferrer");
      } else {
        window.open(u, "_blank", "noopener,noreferrer");
      }
    } catch (_) {
      try { location.assign(u); } catch (__) {}
    }
  }

  function renderGlassCtas(panel) {
    const host = $("mpMediaGlassCtas");
    if (!host) return;
    host.innerHTML = "";
    const list = Array.isArray(panel.buttons) ? panel.buttons : (Array.isArray(panel.ctas) ? panel.ctas : []);
    let n = 0;
    list.forEach(function (b) {
      if (!b) return;
      const label = String(b.label != null ? b.label : (b.text || "")).trim();
      const url = safeCtaUrl(b.url != null ? b.url : b.href);
      if (!label || !url) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mp-media-glass-cta";
      btn.textContent = label;
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openCtaUrl(url);
      });
      host.appendChild(btn);
      n += 1;
    });
    host.hidden = n === 0;
  }

  function openGlassHud(panel) {
    if (!panel) return;
    ensureOverlay();
    const el = ensureGlassHud();
    if (!el) return;
    const title = $("mpMediaGlassTitle");
    const well = $("mpMediaGlassWell");
    const bodyEl = $("mpMediaGlassBody");
    const card = $("mpMediaGlassCard");
    if (title) title.textContent = panel.name || panel.id || "Media";
    if (well) { well.innerHTML = ""; well.hidden = false; well.classList.remove("text-only"); }
    if (bodyEl) { bodyEl.innerHTML = ""; bodyEl.hidden = true; }
    const url = resolveMediaUrl(panel.src);
    const kind = String(panel.kind || "image").toLowerCase();
    const bodyText = panel.body != null ? String(panel.body) : (panel.text != null ? String(panel.text) : "");
    if (card) {
      // Prefer dark glass for video; text panels use light readable glass.
      card.classList.toggle("dark", kind === "video");
      card.classList.toggle("text-panel", kind === "text");
    }
    if (kind === "text") {
      if (url && well) {
        const img = document.createElement("img");
        img.alt = panel.name || panel.id || "Image";
        img.src = url;
        well.appendChild(img);
        well.classList.add("text-hero");
      } else if (well) {
        well.hidden = true;
        well.classList.add("text-only");
      }
      if (bodyEl) {
        if (bodyText.trim()) {
          bodyEl.innerHTML = renderPanelMarkdown(bodyText);
          bodyEl.hidden = false;
        } else {
          bodyEl.hidden = true;
        }
      }
    } else if (!url) {
      if (well) well.innerHTML = "<p style='color:#fff;padding:16px;font:13px system-ui'>No media URL</p>";
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.controls = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.preload = "metadata";
      v.muted = true; // Safari autoplay policy; user can unmute via controls
      if (panel.poster) v.poster = resolveMediaUrl(panel.poster);
      v.src = url;
      if (well) well.appendChild(v);
      try { v.play().catch(() => {}); } catch (_) {}
    } else {
      const img = document.createElement("img");
      img.alt = panel.name || panel.id || "Image";
      img.src = url;
      if (well) well.appendChild(img);
    }
    renderGlassCtas(panel);
    el.hidden = false;
  }

  function clearMediaTags() {
    mediaTagUnsubs.forEach(u => { try { if (typeof u === "function") u(); } catch (_) {} });
    mediaTagUnsubs = [];
    tagSidToPanel = Object.create(null);
    mediaTagsInjected = false;
    closeGlassHud();
  }

  async function injectMediaTags(sdk) {
    clearMediaTags();
    if (!sdk || !sdk.Tag || typeof sdk.Tag.add !== "function") return 0;
    await loadMediaPanels();
    const panels = (mediaPanels || []).filter(p => {
      if (!p || !p.model || p.model.x == null || p.model.y == null) return false;
      const k = String(p.kind || "image").toLowerCase();
      if (k === "text") {
        const body = (p.body != null ? String(p.body) : (p.text != null ? String(p.text) : "")).trim();
        const btns = Array.isArray(p.buttons) ? p.buttons : [];
        return !!(body || p.src || btns.length);
      }
      return !!p.src;
    });
    if (!panels.length) return 0;
    const payloads = [];
    const order = [];
    for (const p of panels) {
      const anchor = modelToSdkPos(p.model);
      if (!anchor) continue;
      let stem = modelToSdkVec(p.normal);
      if (!stem || (Math.abs(stem.x) + Math.abs(stem.y) + Math.abs(stem.z)) < 1e-6) {
        stem = { x: 0, y: 0.35, z: 0 };
      } else {
        // Normalize to ~0.35 m stem length
        const len = Math.hypot(stem.x, stem.y, stem.z) || 1;
        const s = 0.35 / len;
        stem = { x: stem.x * s, y: stem.y * s, z: stem.z * s };
      }
      const kind = String(p.kind || "").toLowerCase();
      const tagColor = kind === "video"
        ? { r: 0.49, g: 0.3, b: 1 }
        : (kind === "text" ? { r: 0.05, g: 0.62, b: 0.43 } : { r: 0.1, g: 0.45, b: 0.91 });
      payloads.push({
        label: p.name || p.id || "Media",
        description: "",
        anchorPosition: anchor,
        stemVector: stem,
        color: tagColor,
      });
      order.push(p);
    }
    if (!payloads.length) return 0;
    let ids = [];
    try {
      ids = await sdk.Tag.add(payloads);
    } catch (e1) {
      // Some SDK builds take one object at a time
      ids = [];
      for (const one of payloads) {
        try {
          const got = await sdk.Tag.add(one);
          if (Array.isArray(got)) ids.push(...got);
          else if (got) ids.push(got);
        } catch (e2) {
          console.warn("Tag.add failed", e2);
        }
      }
    }
    if (!Array.isArray(ids)) ids = ids ? [ids] : [];
    ids.forEach((sid, i) => {
      if (sid && order[i]) tagSidToPanel[sid] = order[i];
    });
    const onOpen = (sid) => {
      const id = typeof sid === "string" ? sid : (sid && (sid.id || sid.sid || sid.tagId));
      const panel = id && tagSidToPanel[id];
      if (!panel) return;
      openGlassHud(panel);
      // Dismiss Matterport billboard dock so our glass card is the playback surface
      try {
        if (sdk.Tag && typeof sdk.Tag.close === "function") sdk.Tag.close(id);
      } catch (_) { /* ignore */ }
    };
    try {
      if (sdk.Tag.open && typeof sdk.Tag.open.subscribe === "function") {
        mediaTagUnsubs.push(sdk.Tag.open.subscribe(onOpen));
      }
    } catch (_) { /* ignore */ }
    try {
      // Fallback: some builds expose click
      if (sdk.Tag.click && typeof sdk.Tag.click.subscribe === "function") {
        mediaTagUnsubs.push(sdk.Tag.click.subscribe(onOpen));
      }
    } catch (_) { /* ignore */ }
    mediaTagsInjected = ids.length > 0;
    return ids.length;
  }


  async function open(route) {
    // iOS Safari often leaves nested map-overlay iframes black; run the walk on a dedicated page.
    if (!window.__WF_MP_TOUR_PAGE && isCoarseMobile()) {
      if (handoffToTourPage(route || {})) return;
    }
    const gen = ++openGen;
    destName = (route && route._destName) || null;
    tourNavSteps = Array.isArray(route && route._navSteps) ? route._navSteps : [];
    ensureOverlay();
    const ov = $("mpOverlay");
    ov.hidden = false;
    document.body.classList.add("mp-open");
    try {
      const mobile = window.matchMedia && window.matchMedia("(max-width: 900px), (pointer: coarse)").matches;
      document.body.classList.toggle("mp-mobile", !!mobile);
    } catch (_) { document.body.classList.add("mp-mobile"); }
    setStatus("Loading digital twin…");
    updateStep();
    updateDest();

    try {
      await resolveConfig();
    } catch (e) {
      const msg = (e && e.message) || "Digital twin unavailable";
      toast(msg);
      setStatus(msg, true);
      try { ov.hidden = true; document.body.classList.remove("mp-open"); } catch (_) {}
      return;
    }
    if (gen !== openGen) return;
    const ids = prepareRoute(route || {});
    updateStep();

    const startedOutdoors = !!(route && route.nodes && route.nodes.length && route.nodes[0].kind !== "sweep" && ids.length);
    if (startedOutdoors) toast("Starting at building entrance");

    if (!ids.length) {
      setStatus("No indoor sweeps on this route — outdoor-only segments are skipped. Showcase is open for manual look-around.", true);
    }

    // No starting sweep on the MAIN iframe load — Matterport's own default with no ss=
    // param is Dollhouse with no floor selected (confirmed against a bare /show/?m= link),
    // which is exactly the opening shot we want. Forcing ss=<sweep> here was what caused
    // the Inside-mode-at-a-floor flash before our JS even got a chance to run: that flash
    // was the iframe's OWN initial render, which happens before Mode.moveTo/Floor.showAll
    // can execute, so no amount of reordering those calls could have fixed it.
    const url = showcaseUrl(applicationKey, null);
    const tab = $("mpOpenTab");
    // The "open in new tab" link is separate manual exploration — still jump it to the
    // route's start sweep for convenience there.
    if (tab) tab.href = showcaseUrl(applicationKey, ids[0] || null);

    const iframe = $("mpFrame");
    mpSdk = null;
    playing = false;
    stopped = true;
    stepI = 0;
    updateStep();

    // Attach load listener BEFORE navigating so we do not miss the event
    const loadP = waitIframeLoad(iframe, gen);
    await resetFrameIfNeeded(iframe);
    if (gen !== openGen) return;
    iframe.src = url;
    await loadP;
    if (gen !== openGen) return;

    if (!applicationKey) {
      setStatus("Matterport SDK key not found (data/sdk_config.json). Showcase opened without SDK — explore manually; auto-walk disabled.", true);
      return;
    }

    setStatus("Connecting to digital twin…");
    const sdk = await connectSdk(iframe);
    if (gen !== openGen) return;
    if (!sdk) {
      setStatus(
        "Could not connect Matterport SDK (" + (connectError || "unknown") + "). " +
        "Add this site’s host (localhost and your trycloudflare.com tunnel) under Matterport → Account Settings → Developer Tools → SDK key domains. Showcase remains usable manually.",
        true
      );
      return;
    }

    setStatus("Waiting for twin to be ready…");
    const ready = await waitPlaying(sdk, 90000, (phase) => {
      // User needs to tap the Matterport "Enter" launch screen before anything else can run.
      setStatus(
        "Tap Enter inside the Matterport window to leave the dark launch screen" +
        (phase ? " (" + phase.replace(/^appphase\./, "") + ")" : "") +
        ". The tour will start automatically after that.",
        false
      );
    });
    if (gen !== openGen) return;
    if (!ready) {
      setStatus(
        "Still on the Matterport launch screen (" + (connectError || "timeout") + "). Tap Enter in the Matterport view, then press Play here.",
        true
      );
      return;
    }

    // ── Step 1: View Dollhouse — same as clicking Showcase's own "View Dollhouse" button. ──
    setStatus("Entering building…");
    try {
      const Mode = sdk.Mode;
      if (Mode && Mode.moveTo && Mode.Mode) {
        const dh = Mode.Mode.DOLLHOUSE || Mode.Mode.Dollhouse || "mode.dollhouse";
        await Mode.moveTo(dh, { transition: (Mode.Transition && Mode.Transition.FLY) || undefined });
      }
    } catch (e) { console.warn("[Tour] dollhouse moveTo failed", e && (e.message || e)); }
    if (gen !== openGen) return;

    // ── Compute route while the dollhouse view is up ─────────────
    if (!sweepIds.length && route && (route.navPath || route.smoothed || route.nodes)) {
      await fillSweepIdsFromNavPath(sdk, route);
      if (gen !== openGen) return;
    }

    const aligned = await alignSweepIds(sdk);
    if (gen !== openGen) return;
    updateStep();

    if (!aligned.length) {
      setStatus(ids.length
        ? "Connected, but route sweeps do not match model " + modelId + ". Explore manually."
        : "Connected. No sweep path on this route.");
      return;
    }

    const tab2 = $("mpOpenTab");
    if (tab2) tab2.href = showcaseUrl(applicationKey, aligned[0] || null);

    // Give the dollhouse view a moment on screen before walking in, same as a person
    // pausing there after clicking the button.
    await new Promise(r => setTimeout(r, 1500));
    if (gen !== openGen) return;

    // ── Step 2: Walkthrough — fly to the first scan point on the route, same as clicking
    // Showcase's "walk" button at that spot. Sweep.moveTo switches Showcase out of
    // Dollhouse mode on its own. ──
    const h0 = headingToward(0);
    console.info("[Tour] Step 2: walkthrough at first sweep", aligned[0], "heading", h0);
    try {
      const tr = sdk.Sweep && sdk.Sweep.Transition;
      const entryOpts = { transition: (tr && tr.FLY) || "transition.fly", transitionTime: Math.round(3000 * tourPaceScale) };
      if (h0 != null && Number.isFinite(h0)) entryOpts.rotation = { x: 0, y: h0 };
      await sdk.Sweep.moveTo(aligned[0], entryOpts);
    } catch (_) { /* ignore — play() covers it */ }
    await new Promise(r => setTimeout(r, 700));
    if (gen !== openGen) return;

    // Step 3: Smooth camera tilt to face along the route toward the next waypoint.
    console.info("[Tour] Step 3: faceAlongRoute(0)");
    try { await faceAlongRoute(0); } catch (_) { /* ignore */ }
    if (gen !== openGen) return;

    // play() starts from sweep index 1 — we already landed at sweep 0 above.
    stepI = 1;
    updateStep();
    setStatus("Starting interior tour…" + (document.body.classList.contains("mp-mobile")
      ? " If the view stays black, tap the open-in-new icon for a full Matterport window."
      : ""));
    await play();
  }

  function close() {
    openGen++;
    playing = false;
    stopped = true;
    hideDirArrow();
    hideDistHud();
    clearMediaTags();
    tourNavSteps = [];
    { const el = $("mpInstr"); if (el) el.hidden = true; }
    try { if (mpSdk && mpSdk.disconnect) mpSdk.disconnect(); } catch (_) { /* ignore */ }
    mpSdk = null;
    const iframe = $("mpFrame");
    if (iframe) iframe.src = "about:blank";
    const ov = $("mpOverlay");
    if (ov) ov.hidden = true;
    document.body.classList.remove("mp-open", "mp-mobile");
    setStatus("");
  }

  // ── Matterport public viewer (background mode) ──────────────────────────────
  // Lighter-weight sibling of open(): connects the same Showcase iframe/SDK and
  // drops straight into Dollhouse (f=0 already means no floor filter — see
  // showcaseUrl()'s comment — so unlike open() there is no route/tour to prepare
  // here), then leaves it idle as the page's permanent background. mp_background.js
  // calls this once; focusAt() (below) handles every camera move after that.
  async function showBackground() {
    const gen = ++openGen;
    ensureOverlay();
    const ov = $("mpOverlay");
    ov.hidden = false;
    document.body.classList.add("mp-open");
    document.body.classList.remove("mp-frame-loaded");
    setStatus("Loading digital twin…");
    try {
      await resolveConfig();
    } catch (e) {
      setStatus((e && e.message) || "Digital twin unavailable", true);
      return false;
    }
    if (gen !== openGen) return false;
    const url = showcaseUrl(applicationKey, null);
    const iframe = $("mpFrame");
    mpSdk = null;
    const loadP = waitIframeLoad(iframe, gen);
    await resetFrameIfNeeded(iframe);
    if (gen !== openGen) return false;
    iframe.src = url;
    await loadP;
    if (gen !== openGen) return false;
    // From here on the iframe is rendering Matterport's own UI, which can include its
    // branded "tap to enter" gate — the loading overlay must stop covering/blocking it
    // (see the mp-frame-loaded CSS in mp_background.js) or that gate becomes untappable.
    document.body.classList.add("mp-frame-loaded");
    if (!applicationKey) { setStatus("Matterport SDK key not found (data/sdk_config.json).", true); return false; }
    setStatus("Connecting to digital twin…");
    const sdk = await connectSdk(iframe);
    if (gen !== openGen) return false;
    if (!sdk) { setStatus("Could not connect Matterport SDK (" + (connectError || "unknown") + ").", true); return false; }
    setStatus("Waiting for twin to be ready…");
    const ready = await waitPlaying(sdk, 90000, () => setStatus("Tap Enter inside the Matterport window to continue."));
    if (gen !== openGen) return false;
    if (!ready) { setStatus("Still on the Matterport launch screen (" + (connectError || "timeout") + "). Tap Enter, then try again.", true); return false; }
    try {
      const Mode = sdk.Mode;
      if (Mode && Mode.moveTo && Mode.Mode) {
        const dh = Mode.Mode.DOLLHOUSE || Mode.Mode.Dollhouse || "mode.dollhouse";
        await Mode.moveTo(dh, { transition: (Mode.Transition && Mode.Transition.FLY) || undefined });
      }
    } catch (e) { console.warn("[MpBackground] dollhouse moveTo failed", e && (e.message || e)); }
    if (gen !== openGen) return false;
    setStatus("");
    return true;
  }

  /**
   * Single-shot camera move: fly to the real Matterport sweep nearest `target`
   * (model Z-up {x,y,z}), optionally facing toward `face` (also model Z-up).
   * Used for POI "to"/"from" selection and turn-by-turn step clicks in MP
   * background mode — the same Sweep.moveTo + yawSdk mechanics moveTo()/
   * faceAlongRoute() use internally for the auto-played tour, just standalone.
   */
  async function focusAt(target, face) {
    if (!mpSdk || !target || target.x == null || target.y == null) return false;
    const rtSweeps = await rtReadSweeps(mpSdk);
    if (!rtSweeps.length) return false;
    const mpTarget = modelToSdk(target);
    const sw = rtNearestSweep(rtSweeps, mpTarget);
    if (!sw) return false;
    const tr = mpSdk.Sweep && mpSdk.Sweep.Transition;
    const opts = { transition: (tr && tr.FLY) || "transition.fly", transitionTime: 1200 };
    const mpFace = (face && face.x != null) ? modelToSdk(face) : null;
    const yaw = mpFace ? yawSdk(sw.position, mpFace) : null;
    if (yaw != null && Number.isFinite(yaw)) opts.rotation = { x: 0, y: yaw };
    try {
      await mpSdk.Sweep.moveTo(sw.sid, opts);
    } catch (e) {
      console.warn("[MpBackground] focusAt moveTo failed", sw.sid, e && (e.message || e));
      return false;
    }
    return true;
  }

  function sdkToModel(p) {
    if (!p || p.x == null || p.y == null) return null;
    return { x: +p.x, y: -(+p.z), z: +p.y };
  }

  function ensurePickOverlay() {
    const wrap = document.querySelector("#mpOverlay .mp-frame-wrap");
    if (!wrap) return null;
    let el = $("mpPickBar");
    if (!el) {
      el = document.createElement("div");
      el.id = "mpPickBar";
      el.className = "mp-pick-bar";
      el.hidden = true;
      el.innerHTML = `
        <div class="mp-pick-hint" id="mpPickHint">Tap/drag to orbit the dollhouse, aim at where you are, then confirm.</div>
        <div class="mp-pick-actions">
          <button type="button" class="pill" id="mpPickCancel">Cancel</button>
          <button type="button" class="pill primary" id="mpPickGo">Go here</button>
        </div>`;
      wrap.appendChild(el);
    } else if (el.parentElement !== wrap) {
      wrap.appendChild(el);
    }
    return el;
  }

  let pickGen = 0;
  /** "Pick on map" for MP mode: switch to Dollhouse, let the user aim (orbit/pan — native
   *  Showcase dollhouse controls, untouched), track Pointer.intersection for the live 3D
   *  point under the pointer, and on confirm walk there (same focusAt() FLY used by
   *  POI selection) and resolve with the picked point so the caller can set it as the
   *  route's "from". Resolves null if the user cancels or nothing was ever picked.
   *  There's no reliable cross-origin click signal from the iframe (Pointer.intersection
   *  itself just tracks hover/drag continuously) — hence the explicit confirm button
   *  instead of a single tap-to-commit gesture. */
  async function pickOnMap() {
    if (!mpSdk) return null;
    const gen = ++pickGen;
    const bar = ensurePickOverlay();
    const goBtn = $("mpPickGo"), cancelBtn = $("mpPickCancel");
    if (!bar || !goBtn || !cancelBtn) return null;
    try {
      const Mode = mpSdk.Mode;
      if (Mode && Mode.moveTo && Mode.Mode) {
        const dh = Mode.Mode.DOLLHOUSE || Mode.Mode.Dollhouse || "mode.dollhouse";
        await Mode.moveTo(dh, { transition: (Mode.Transition && Mode.Transition.FLY) || undefined });
      }
    } catch (e) { console.warn("[MpBackground] pickOnMap dollhouse moveTo failed", e && (e.message || e)); }
    if (gen !== pickGen) return null;
    let lastHit = null;
    const sub = mpSdk.Pointer.intersection.subscribe((d) => {
      if (d && d.object === "intersectedobject.model") lastHit = d;
    });
    bar.hidden = false;
    goBtn.disabled = true;
    const stopWatch = setInterval(() => { goBtn.disabled = !lastHit; }, 150);
    const result = await new Promise((resolve) => {
      goBtn.onclick = () => resolve(lastHit);
      cancelBtn.onclick = () => resolve(null);
    });
    clearInterval(stopWatch);
    try { sub.cancel(); } catch (_) { /* ignore */ }
    bar.hidden = true;
    if (gen !== pickGen || !result) return null;
    const modelPt = sdkToModel(result.position);
    if (!modelPt) return null;
    modelPt.floorIndex = result.floorIndex;
    try { await focusAt(modelPt, null); } catch (_) { /* ignore — point is still valid even if the fly-there animation fails */ }
    return modelPt;
  }

  // ── "Start Preview" walkthrough: the exact same sweep-by-sweep engine Tour interior
  // uses (prepareRoute/fillSweepIdsFromNavPath/alignSweepIds/moveTo — FLY transitions,
  // rotate-toward-next-waypoint mid-flight, faceAlongRoute correction on arrival) driven
  // by ui.js's own Start Preview buttons instead of the Tour overlay's play/pause/stop. ──
  let walkGen = 0;

  /** Prepare the module's sweepIds/sweepNodes/distances for `route`, reusing mpSdk
   *  that's already connected in mp background mode (see showBackground()). */
  async function prepareWalk(route) {
    tourNavSteps = Array.isArray(route && route._navSteps) ? route._navSteps : [];
    destName = (route && route._destName) || null;
    const ids = prepareRoute(route || {});
    if (!ids.length && mpSdk && route && (route.navPath || route.smoothed || route.nodes)) {
      try { await fillSweepIdsFromNavPath(mpSdk, route); } catch (_) { /* ignore */ }
    }
    if (mpSdk && sweepIds.length) {
      try { await alignSweepIds(mpSdk); } catch (_) { /* ignore */ }
    }
    stepI = 0;
    updateStep();
    return sweepIds.length;
  }

  /** Nearest prepared sweep-stop index (from prepareWalk) to a model Z-up point. */
  function nearestIndexForPoint(pt) {
    if (!sweepNodes.length || !pt || pt.x == null) return -1;
    let best = -1, bd = Infinity;
    sweepNodes.forEach((n, i) => {
      if (!n || n.x == null) return;
      if (n.floor != null && pt.floor != null && n.floor !== pt.floor) return;
      const d = Math.hypot(n.x - pt.x, n.y - pt.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Walk (FLY + rotate, same as Tour's play()) from the current stop to sweep index
   *  `targetIdx`, one hop at a time. Cancellable — a newer call supersedes an older one
   *  still in flight (e.g. the user tapping Next again before the camera lands).
   *  `onStep`, if given, fires after each landed hop with the real route distance still
   *  remaining to the destination from THAT exact scan point (same calculation moveTo()
   *  already uses for the arrow/distance HUD) — lets a caller (ui.js's nav banner) show a
   *  remaining-distance readout that ticks down per scan point instead of per instruction. */
  async function walkToIndex(targetIdx, onStep) {
    if (!mpSdk || targetIdx < 0 || targetIdx >= sweepIds.length) return false;
    const gen = ++walkGen;
    const dir = targetIdx >= stepI ? 1 : -1;
    let i = stepI;
    while (i !== targetIdx) {
      if (gen !== walkGen) return false;
      i += dir;
      const ok = await moveTo(i);
      if (gen !== walkGen) return false;
      if (ok && typeof onStep === "function") {
        try { onStep({ index: i, remainingM: remainingDistM(i), nextLegM: nextLegDistM(i) }); } catch (_) { /* ignore */ }
      }
      if (!ok) break;
    }
    return true;
  }

  /** Cancel any in-flight walkToIndex loop (e.g. on exiting Start Preview). */
  function cancelWalkTo() { walkGen++; }

  /** Where walkToIndex/moveTo last actually landed, and how many stops prepareWalk found —
   *  lets a caller (ui.js's Next/Prev arrows) step exactly one scan point at a time instead
   *  of jumping to wherever a turn-by-turn instruction's nearest sweep happens to be. */
  function currentSweepIndex() { return stepI; }
  function totalSweepStops() { return sweepIds.length; }

  window.MpPreview = {
    open, close, showBackground, focusAt, setFloor, zoomBy, resetView,
    prepareWalk, nearestIndexForPoint, walkToIndex, cancelWalkTo,
    currentSweepIndex, totalSweepStops, pickOnMap
  };
})();
