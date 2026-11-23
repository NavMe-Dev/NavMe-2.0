/* Matterport public viewer (?mp=1): swaps the ArcGIS map background for the live
   Matterport Showcase embed, opening in Dollhouse before entering Inside mode. Everything else (search,
   directions, turn-by-turn) is the normal ui.js/app.js chrome running unmodified
   on top — ui.js only ever duck-types window.wf.*, it never checks how the
   background is rendered. See ui.js's isMpMode()/mpFocusSelection() for the
   POI-selection and turn-by-turn camera wiring that pairs with this file. */
(function () {
  function isMpMode() { return (window.WFQuery ? WFQuery() : new URLSearchParams(location.search)).get("mp") === "1"; }
  if (!isMpMode()) return;
  if (window.WFStartup && window.__mpBackgroundPromise) return;
  const trace = (event, meta) => { try { if (window.WFViewerLifecycle) window.WFViewerLifecycle.record(event, meta); } catch (_) {} };

  // Warm up DNS/TLS for the Showcase domains as early as possible — the iframe
  // navigation itself doesn't start until resolveConfig()'s fetch resolves, so
  // without this every mobile connection pays that handshake cost serially,
  // on top of an already-heavy embed load.
  ["https://my.matterport.com", "https://cdn-2.matterport.com", "https://static.matterport.com"].forEach((href) => {
    const l = document.createElement("link");
    l.rel = "preconnect"; l.href = href; l.crossOrigin = "";
    document.head.appendChild(l);
  });

  document.body.classList.add("mp-bg-mode");
  // Light is the default theme; dark only applies if the user explicitly picked it
  // via ui.js's Light theme toggle (localStorage wf_theme).
  try {
    if (localStorage.getItem("wf_theme") === "dark") document.body.classList.add("dark");
  } catch (_) { /* default stays light */ }
  const style = document.createElement("style");
  style.textContent = `
    body.mp-bg-mode #viewDiv { display:none !important; }
    body.mp-bg-mode .mp-overlay { position:fixed; inset:0; z-index:0; background:#000; padding:0; }
    /* Tour interior's own header bar (title/instruction/distance/play-pause-stop/close) and
       status line are hidden here — ui.js's own navBanner/navBar already show equivalent
       turn-by-turn + distance info (see ui.js mpRoutePayload/navGo), and removing this frees
       .mp-frame-wrap (flex:1) to fill the entire overlay so Matterport is the full view with
       no reserved header strip. The direction arrow and distance HUD stay — no replacement
       for those in ui.js's own chrome. */
    body.mp-bg-mode .mp-bar, body.mp-bg-mode .mp-status { display:none !important; }
    body.mp-bg-mode .mp-panel, body.mp-bg-mode .mp-frame-wrap, body.mp-bg-mode #mpFrame {
      width:100%; height:100%; border-radius:0;
    }
    /* ui.css's pre-existing body.mp-mobile rules (min-height:0, flex:1 1 auto, height:auto)
       fight this on phones — mobile viewport means Tour interior's own isCoarseMobile()
       check also sets body.mp-mobile, and that selector has the same specificity as
       body.mp-bg-mode, so whichever rule happens to apply last/first was deciding the
       outcome instead of us. Named explicitly + !important so this always wins regardless
       of mp-mobile, fixing the crop (and the chrome it hides) being desktop-only before. */
    body.mp-bg-mode.mp-mobile .mp-frame-wrap, body.mp-bg-mode .mp-frame-wrap {
      width:100% !important; height:100% !important; min-height:0 !important; flex:1 1 auto !important;
    }
    /* Showcase's own top info strip and bottom mode-switch toolbar (Dollhouse/Floorplan/
       Inside/measure icons, "View Floor Plan" button) render INSIDE the cross-origin
       my.matterport.com iframe — no CSS/DOM access from this page can target them directly,
       and the embed params that are supposed to hide them (logo=0, mt=0, newtop=0, etc. —
       see showcaseUrl()) turned out not to work on this particular Showcase bundle/account,
       verified live (still visible with every one of those params set). Cropping them off by
       oversizing the iframe and clipping the wrapper is the only remaining lever: it also
       clips a strip of the real 3D view along with the chrome, which is the accepted
       trade-off for removing chrome Showcase won't let this page hide any other way. */
    body.mp-bg-mode .mp-frame-wrap { overflow:hidden !important; }
    body.mp-bg-mode .mp-frame-wrap #mpFrame {
      top:-56px !important; height:calc(100% + 144px) !important; min-height:0 !important;
      width:100% !important; left:0 !important; border:0 !important;
    }
    /* ArcGIS-only map controls and the dev-only Map Layers panel (style/photo-plan/graph/
       mesh-debug toggles) — meaningless once the map itself is hidden. */
    body.mp-bg-mode #btn3D, body.mp-bg-mode #btnLayers, body.mp-bg-mode #btnLabels,
    body.mp-bg-mode #layersPop, body.mp-bg-mode [data-act="dev"] { display:none !important; }
    /* Keep the branded surface until Matterport starts its rendered entrance.
       Show a transparent preparation indicator over that original fly-in and
       dollhouse framing while NavMe's search/navigation UI finishes. */
    body.mp-bg-mode #mpBgLoading {
      position:absolute; inset:0; z-index:2; display:flex; flex-direction:column; align-items:center;
      justify-content:center; gap:14px; background:#000; color:#e8eaed;
      font:14px/1.4 Roboto,system-ui,-apple-system,sans-serif; text-align:center; padding:24px;
      box-sizing:border-box; opacity:1; transition:opacity .2s ease;
    }
    body.mp-bg-mode #mpBgLoading[hidden] { display:none !important; }
    body.mp-bg-mode.mp-startup-intro #mpBgLoading:not(.err) { opacity:0; }
    body.mp-bg-mode.mp-startup-complete #mpBgLoading { opacity:0; pointer-events:none; }
    body.mp-bg-mode #mpBgLoading.err { pointer-events:auto; background:rgba(0,0,0,.75); }
    body.mp-bg-mode #mpBgLoading.err .navme-bg-splash { display:flex !important; }
    body.mp-bg-mode #mpBgLoading.err > #mpBgLoadingText { display:none !important; }
    body.mp-bg-mode #mpStartupRetry {
      font:inherit; padding:10px 18px; border-radius:20px; border:0; cursor:pointer;
      background:#8ab4f8; color:#17243a;
    }
    @media (prefers-reduced-motion:reduce) {
      body.mp-bg-mode #mpBgLoading, body.mp-bg-mode .ui { transition:none; }
    }
    body.mp-bg-mode .mp-bg-spinner {
      width:36px; height:36px; border-radius:50%; border:3px solid rgba(255,255,255,.25);
      border-top-color:#8ab4f8; animation:mpBgSpin .8s linear infinite; flex-shrink:0;
    }
    body.mp-bg-mode.mp-frame-loaded .mp-bg-spinner { width:16px; height:16px; border-width:2px; }
    body.mp-bg-mode #mpBgLoading.err .mp-bg-spinner { display:none; }
    body.mp-bg-mode #mpBgLoading.err { color:#f28b82; }
    @keyframes mpBgSpin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion:reduce) { body.mp-bg-mode .mp-bg-spinner { animation:none; } }
    /* Preserve the existing logo, spinner, and milestone-based percentage. */
    body.mp-bg-mode #mpBgLoading > .mp-bg-spinner,
    body.mp-bg-mode #mpBgLoading > #mpBgLoadingText {
      display:none !important;
    }
    body.mp-bg-mode .navme-bg-splash {
      display:flex; flex-direction:column; align-items:center; gap:16px;
    }
    body.mp-bg-mode .navme-bg-splash-logo {
      width:72px; height:72px; border-radius:18px; object-fit:contain;
      background:rgba(255,255,255,.06); padding:10px; box-sizing:border-box;
    }
    body.mp-bg-mode .navme-bg-splash-title {
      font-size:16px; font-weight:600; color:#f1f3f4;
    }
    body.mp-bg-mode .navme-bg-splash-spinner {
      width:34px; height:34px; border-radius:50%; border:3px solid rgba(255,255,255,.22);
      border-top-color:#8ab4f8; animation:mpBgSpin .8s linear infinite;
    }
    body.mp-bg-mode .navme-bg-splash-pct {
      font-size:22px; font-weight:700; color:#8ab4f8; font-variant-numeric:tabular-nums;
      letter-spacing:.02em;
    }
    body.mp-bg-mode .navme-bg-splash-sub {
      font-size:12.5px; color:rgba(232,234,237,.65);
    }
    body.mp-bg-mode .navme-bg-splash-sub:empty { display:none; }
    body.mp-bg-mode .navme-bg-splash.is-err .navme-bg-splash-spinner,
    body.mp-bg-mode .navme-bg-splash.is-err .navme-bg-splash-pct { display:none; }
    body.mp-bg-mode .navme-bg-splash.is-err .navme-bg-splash-title { color:#f28b82; }
    @media (prefers-reduced-motion:reduce) { body.mp-bg-mode .navme-bg-splash-spinner { animation:none; } }
  `;
  document.head.appendChild(style);

  // Known connect-sequence milestones (see mp_preview.js's showBackground()) mapped to a
  // rough completion percentage — Matterport gives no real byte-level progress for the
  // iframe, so this is an honest best-effort indicator of "how far through the known
  // steps", not a measured download percentage.
  const STATUS_MILESTONES = [
    { match: /loading digital twin/i, pct: 12 },
    { match: /connecting to digital twin/i, pct: 45 },
    { match: /waiting for twin to be ready/i, pct: 75 },
    { match: /preparing your experience/i, pct: 92 },
    { match: /tap enter/i, pct: 95 },
  ];
  const DEFAULT_TITLE = "Loading Wayfinding";

  /** Re-skin #mpBgLoading once, the first time it exists — see the CSS block above. */
  function enhanceBgLoading(el) {
    if (!el || el.dataset.navmeEnhanced) return;
    el.dataset.navmeEnhanced = "1";
    const title = typeof DEFAULT_TITLE !== "undefined" ? DEFAULT_TITLE : "Loading Wayfinding";
    const milestones = typeof STATUS_MILESTONES !== "undefined" ? STATUS_MILESTONES : [
      { match: /loading digital twin/i, pct: 12 },
      { match: /connecting to digital twin/i, pct: 45 },
      { match: /waiting for twin to be ready/i, pct: 75 },
      { match: /preparing your experience/i, pct: 92 },
      { match: /tap enter/i, pct: 95 },
    ];
    const textEl = el.querySelector("#mpBgLoadingText");
    const shell = document.createElement("div");
    shell.className = "navme-bg-splash";
    shell.innerHTML =
      '<img class="navme-bg-splash-logo" src="img/navme-logo.png" alt="" />' +
      '<div class="navme-bg-splash-title">' + title + "</div>" +
      '<div class="navme-bg-splash-spinner" aria-hidden="true"></div>' +
      '<div class="navme-bg-splash-pct">0%</div>' +
      '<div class="navme-bg-splash-sub"></div>';
    el.insertBefore(shell, el.firstChild);

    const titleEl = shell.querySelector(".navme-bg-splash-title");
    const pctEl = shell.querySelector(".navme-bg-splash-pct");
    const subEl = shell.querySelector(".navme-bg-splash-sub");
    let shownPct = 0;
    let targetPct = 0;
    let creepTimer = null;

    function tick() {
      if (document.body.classList.contains("mp-startup-complete") || el.hidden) {
        clearInterval(creepTimer);
        creepTimer = null;
        return;
      }
      const diff = targetPct - shownPct;
      if (diff > 0.05) {
        shownPct += Math.max(0.15, diff * 0.06);
      } else {
        const ceiling = targetPct >= 90 ? 95 : 90;
        const creepDiff = ceiling - shownPct;
        if (creepDiff > 0) {
          shownPct += Math.min(0.025, creepDiff * 0.005 + 0.005);
        }
      }
      shownPct = Math.min(shownPct, 99);
      pctEl.textContent = Math.round(shownPct) + "%";
    }

    function startAnimation() {
      if (!creepTimer) {
        creepTimer = setInterval(tick, 25);
      }
    }

    function syncFromText() {
      if (document.body.classList.contains("mp-startup-complete") || el.hidden) {
        clearInterval(creepTimer);
        creepTimer = null;
        return;
      }
      const msg = (textEl && textEl.textContent) || "";
      const isErr = el.classList.contains("err");
      shell.classList.toggle("is-err", isErr);
      if (isErr) {
        clearInterval(creepTimer);
        creepTimer = null;
        titleEl.textContent = "Unable to load NavMe";
        subEl.textContent = "We couldn't load your navigation experience. Please try again.";
        return;
      }
      const hit = milestones.filter((m) => m.match.test(msg))[0];
      const nextTarget = hit ? hit.pct : targetPct;
      if (nextTarget > targetPct) {
        targetPct = nextTarget;
      }
      titleEl.textContent = title;
      subEl.textContent = "";
      startAnimation();
    }
    syncFromText();
    const mo = new MutationObserver(syncFromText);
    if (textEl) mo.observe(textEl, { childList: true, characterData: true, subtree: true });
    mo.observe(el, { attributes: true, attributeFilter: ["class", "hidden"] });
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  function watchForBgLoading() {
    const existing = document.getElementById("mpBgLoading");
    if (existing) { enhanceBgLoading(existing); return; }
    const mo = new MutationObserver(() => {
      const el = document.getElementById("mpBgLoading");
      if (el) { enhanceBgLoading(el); mo.disconnect(); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Own the existing loader until BOTH the live model and NavMe chrome are ready.
  // iframe.load and percentage milestones intentionally never advance this state.
  function createStartup() {
    let generation = 0, modelVisible = false, modelReady = false, chromeReady = false, failed = false, complete = false;
    let watchdog = null, lastStatus = "Loading digital twin…";
    const preparing = "Preparing your experience…";
    function render() {
      const el = document.getElementById("mpBgLoading");
      if (!el) return;
      if (complete && !failed) { el.hidden = true; return; }
      enhanceBgLoading(el);
      el.setAttribute("role", failed ? "alert" : "status");
      el.setAttribute("aria-live", "polite");
      el.setAttribute("aria-busy", String(!failed && !complete));
      el.classList.toggle("err", failed);
      if (failed) document.body.classList.remove("mp-startup-intro");
      const text = document.getElementById("mpBgLoadingText");
      if (text) text.textContent = failed
        ? "We couldn't load your navigation experience. Please try again."
        : (modelVisible ? preparing : lastStatus);
      el.hidden = false;
      if (failed && !document.getElementById("mpStartupRetry")) {
        const retry = document.createElement("button");
        retry.id = "mpStartupRetry"; retry.type = "button"; retry.textContent = "Try Again";
        retry.onclick = () => {
          if (window.MpPreview && window.MpPreview.recoverBackground && window.MpPreview.recoverBackground()) return;
          trace("recovery", {reason:"user", retryable:true});
          location.reload(); // Explicit retry of an incomplete page bootstrap.
        };
        const shell = el.querySelector(".navme-bg-splash");
        (shell || el).appendChild(retry);
      }
      if (modelReady && chromeReady && !failed && !complete) {
        const introWasVisible = document.body.classList.contains("mp-startup-intro");
        complete = true;
        trace("loading", {phase:"complete", generation});
        clearTimeout(watchdog);
        const pctEl = el.querySelector(".navme-bg-splash-pct");
        if (pctEl) pctEl.textContent = "100%";
        document.body.classList.add("mp-startup-complete");
        document.body.classList.remove("booting", "mp-startup-intro");
        const finish = () => {
          if (complete && !failed) el.hidden = true;
        };
        el.addEventListener("transitionend", finish, { once: true });
        // The introduction has already faded the loader, so completion emits no
        // second opacity event. Reduced motion also skips that event entirely.
        if (introWasVisible || window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
      }
    }
    const state = {
      get generation() { return generation; },
      get pending() { return !complete; },
      get chromeReady() { return chromeReady; },
      begin(gen) {
        if (generation === gen) return;
        // A required-data failure may arrive before DOMContentLoaded starts the model.
        if (failed && generation === 0) { generation = gen; render(); return; }
        generation = gen; modelVisible = false; modelReady = false; chromeReady = false; failed = false; complete = false;
        trace("loading", {phase:"loading", generation});
        window.__mpBackgroundReady = false;
        lastStatus = "Loading digital twin…";
        document.body.classList.add("booting");
        document.body.classList.remove("mp-frame-loaded", "mp-startup-complete", "mp-startup-intro");
        const retry = document.getElementById("mpStartupRetry"); if (retry) retry.remove();
        clearTimeout(watchdog);
        // A deadline reports failure; it never pretends that the model is ready.
        watchdog = setTimeout(() => state.fail(gen), 120000);
        render();
      },
      isCurrent(gen) { return generation === gen && !failed; },
      status(msg, isErr) {
        if (complete) return;
        if (isErr) { state.fail(generation); return; }
        if (msg) lastStatus = msg;
        render();
      },
      modelVisible(gen) {
        if (!state.isCurrent(gen)) return;
        modelVisible = true;
        trace("loading", {phase:"visible", generation});
        document.body.classList.add("mp-frame-loaded");
        render();
      },
      modelReady(gen) {
        if (!state.isCurrent(gen)) return;
        modelReady = true;
        trace("loading", {phase:"ready", generation});
        state.modelVisible(gen);
      },
      uiReady(gen) {
        if (!state.isCurrent(gen)) return;
        chromeReady = true; render();
      },
      fail(gen) {
        if (gen !== undefined && gen !== generation) return;
        if (complete || failed) return;
        failed = true; clearTimeout(watchdog);
        trace("loading", {phase:"failed", generation, reason:"failure"});
        render();
      },
      runtimeFailure(gen) {
        if (gen !== generation || failed) return;
        complete = false; failed = true; clearTimeout(watchdog);
        document.body.classList.remove("mp-startup-complete");
        trace("loading", {phase:"failed", generation, reason:"failure"});
        render();
      },
    };
    return state;
  }
  window.WFStartup = createStartup();
  let resolveBackground;
  window.__mpBackgroundPromise = new Promise(resolve => { resolveBackground = resolve; });

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    watchForBgLoading();
    if (!window.MpPreview || !window.MpPreview.showBackground) {
      window.WFStartup.fail(); resolveBackground(false); return;
    }
    const attempt = window.MpPreview.showBackground();
    const generation = window.WFStartup.generation;
    attempt.then((ok) => {
      if (!ok || !window.WFStartup.isCurrent(generation)) return false;
      if (!window.__mpBackgroundReady) {
        window.__mpBackgroundReady = true;
        window.dispatchEvent(new Event("mp-background-ready"));
      }
      return true;
    }).catch(() => { window.WFStartup.fail(generation); return false; }).then(resolveBackground);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Auto-requesting Fullscreen API on first tap was removed: on some Android
  // devices it pushed the viewport under the front-camera/status-bar cutout
  // instead of cleanly hiding chrome, which looked worse than just keeping the
  // normal browser UI. The apple-mobile-web-app-capable meta tags in index.html
  // still give a real, chrome-free fullscreen to anyone who explicitly adds this
  // page to their home screen — that path is user-initiated per device, so it
  // doesn't hit this same auto-trigger problem.
})();
