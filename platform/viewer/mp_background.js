/* Matterport public viewer (?mp=1): swaps the ArcGIS map background for the live
   Matterport Showcase embed, left in Dollhouse mode. Everything else (search,
   directions, turn-by-turn) is the normal ui.js/app.js chrome running unmodified
   on top — ui.js only ever duck-types window.wf.*, it never checks how the
   background is rendered. See ui.js's isMpMode()/mpFocusSelection() for the
   POI-selection and turn-by-turn camera wiring that pairs with this file. */
(function () {
  function isMpMode() { return new URLSearchParams(location.search).get("mp") === "1"; }
  if (!isMpMode()) return;

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
  // The search/directions/POI chrome (ui.js) is still ArcGIS-light-themed by default —
  // over the always-black Matterport background that reads as mismatched white cards
  // floating on black. Default to the existing dark palette (ui.css body.dark vars) for
  // mp=1, but respect an explicit saved choice from ui.js's Light theme toggle — this
  // is only a default, not a lock.
  try {
    if (localStorage.getItem("wf_theme") !== "light") document.body.classList.add("dark");
  } catch (_) { document.body.classList.add("dark"); }
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
    body.mp-bg-mode .mp-frame-wrap #mpFrame, body.mp-bg-mode.mp-mobile .mp-frame-wrap #mpFrame {
      top:-56px !important; height:calc(100% + 128px) !important; min-height:0 !important;
      width:100% !important; left:0 !important; border:0 !important;
    }
    /* ArcGIS-only map controls and the dev-only Map Layers panel (style/photo-plan/graph/
       mesh-debug toggles) — meaningless once the map itself is hidden. */
    body.mp-bg-mode #btn3D, body.mp-bg-mode #btnLayers, body.mp-bg-mode #btnLabels,
    body.mp-bg-mode #layersPop, body.mp-bg-mode [data-act="dev"] { display:none !important; }
    /* Loading feedback while the Showcase iframe/SDK connect (mp_preview.js setStatus()
       mirrors its messages here since .mp-status is hidden above) — without this the
       background was a plain black screen with no indication anything was happening,
       which read as "stuck" rather than "loading", especially over slower mobile networks.
       Before the iframe has loaded there's nothing underneath to see, so this covers it
       fully opaque. Once mp_preview.js adds .mp-frame-loaded (iframe has real content —
       which can include Matterport's own "tap to enter" gate), it must stop covering/
       blocking the iframe or that gate becomes impossible to see or tap; it shrinks to a
       small, click-through status pill instead. */
    body.mp-bg-mode #mpBgLoading {
      position:absolute; inset:0; z-index:2; display:flex; flex-direction:column; align-items:center;
      justify-content:center; gap:14px; background:#000; color:#e8eaed;
      font:14px/1.4 Roboto,system-ui,-apple-system,sans-serif; text-align:center; padding:24px;
    }
    body.mp-bg-mode #mpBgLoading[hidden] { display:none !important; }
    /* Once the iframe has real content, drop the status pill entirely instead of shrinking
       it into a bottom toast — "Connecting to digital twin…" / "Tap Enter…" etc. read as
       noise once the scene itself is already visible underneath. The full-bleed splash
       above (shown before .mp-frame-loaded) is untouched; this only removes what used to
       replace it. */
    body.mp-bg-mode.mp-frame-loaded #mpBgLoading { display:none !important; }
    body.mp-bg-mode .mp-bg-spinner {
      width:36px; height:36px; border-radius:50%; border:3px solid rgba(255,255,255,.25);
      border-top-color:#8ab4f8; animation:mpBgSpin .8s linear infinite; flex-shrink:0;
    }
    body.mp-bg-mode.mp-frame-loaded .mp-bg-spinner { width:16px; height:16px; border-width:2px; }
    body.mp-bg-mode #mpBgLoading.err .mp-bg-spinner { display:none; }
    body.mp-bg-mode #mpBgLoading.err { color:#f28b82; }
    @keyframes mpBgSpin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion:reduce) { body.mp-bg-mode .mp-bg-spinner { animation:none; } }
    /* NavMe-branded splash — see enhanceBgLoading() below. mp_preview.js's setStatus()
       keeps writing its raw status string into #mpBgLoadingText exactly as before (Tour
       interior, which shares that function, is completely untouched); this only re-skins
       the mp-bg-mode presentation of it. Hidden once Showcase has real content so its own
       "tap to enter" gate (if any) is visible/tappable — the original small spinner+text
       pill takes back over at that point, unchanged from before this existed. */
    body.mp-bg-mode:not(.mp-frame-loaded) #mpBgLoading > .mp-bg-spinner,
    body.mp-bg-mode:not(.mp-frame-loaded) #mpBgLoading > #mpBgLoadingText {
      display:none !important;
    }
    body.mp-bg-mode.mp-frame-loaded #mpBgLoading .navme-bg-splash { display:none !important; }
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
      font-size:12.5px; color:rgba(232,234,237,.65); min-height:1.4em;
    }
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
    { match: /tap enter/i, pct: 92, sub: "Tap inside the window below to continue" },
  ];
  const DEFAULT_TITLE = "Loading NavMe Wayfinding";

  /** Re-skin #mpBgLoading once, the first time it exists — see the CSS block above. */
  function enhanceBgLoading(el) {
    if (!el || el.dataset.navmeEnhanced) return;
    el.dataset.navmeEnhanced = "1";
    const textEl = el.querySelector("#mpBgLoadingText");
    const shell = document.createElement("div");
    shell.className = "navme-bg-splash";
    shell.innerHTML =
      '<img class="navme-bg-splash-logo" src="img/navme-logo.png" alt="" />' +
      '<div class="navme-bg-splash-title">' + DEFAULT_TITLE + "</div>" +
      '<div class="navme-bg-splash-spinner" aria-hidden="true"></div>' +
      '<div class="navme-bg-splash-pct">0%</div>' +
      '<div class="navme-bg-splash-sub"></div>';
    el.insertBefore(shell, el.firstChild);

    const titleEl = shell.querySelector(".navme-bg-splash-title");
    const pctEl = shell.querySelector(".navme-bg-splash-pct");
    const subEl = shell.querySelector(".navme-bg-splash-sub");
    let shownPct = 0;
    let creepTimer = null;

    function stepToward(target) {
      clearInterval(creepTimer);
      creepTimer = setInterval(() => {
        // Ease toward the target, never reaching it on its own — the next real
        // status (or completion) always supplies the actual jump, same spirit
        // as a classic "creep to 90%, snap to 100% on finish" progress bar.
        const cap = Math.max(0, target - 2);
        if (shownPct >= cap) { clearInterval(creepTimer); return; }
        shownPct += (cap - shownPct) * 0.12 + 0.4;
        pctEl.textContent = Math.round(Math.min(shownPct, cap)) + "%";
      }, 180);
    }

    function syncFromText() {
      const msg = (textEl && textEl.textContent) || "";
      const isErr = el.classList.contains("err");
      shell.classList.toggle("is-err", isErr);
      if (isErr) {
        titleEl.textContent = "Could not load the digital twin";
        subEl.textContent = msg;
        return;
      }
      const hit = STATUS_MILESTONES.filter((m) => m.match.test(msg))[0];
      const target = hit ? hit.pct : Math.max(shownPct, 30);
      titleEl.textContent = DEFAULT_TITLE;
      subEl.textContent = (hit && hit.sub) || "";
      if (target > shownPct) {
        shownPct = Math.min(shownPct, target - 2 < 0 ? 0 : target - 2);
        pctEl.textContent = Math.round(shownPct) + "%";
        stepToward(target);
      }
    }
    syncFromText();
    const mo = new MutationObserver(syncFromText);
    if (textEl) mo.observe(textEl, { childList: true, characterData: true, subtree: true });
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
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

  function boot() {
    if (!window.MpPreview || !window.MpPreview.showBackground) { setTimeout(boot, 150); return; }
    watchForBgLoading();
    // ui.js's boot sequence waits on this (see mpBackgroundReady()) so the NavMe chrome
    // (search bar, chips, directions...) doesn't fade in over a still-loading/blank
    // Matterport scene — it was previously timed off i18n+deep-link only, unrelated to
    // whether the twin had actually finished connecting. Resolves either way (true or
    // false) — a connect failure shouldn't leave the rest of the UI hidden forever.
    window.MpPreview.showBackground().finally(() => {
      window.__mpBackgroundReady = true;
      window.dispatchEvent(new Event("mp-background-ready"));
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Fullscreen must be requested from a user gesture (browsers reject a bare
  // programmatic call). A single pointerdown listener turned out unreliable in
  // practice (some browsers only treat click/touchend as a "real" activation,
  // and a denied/ignored request shouldn't permanently disarm the attempt), so
  // this listens on every common gesture type and keeps trying — each handler
  // bails immediately once fullscreen is actually active.
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function goFullscreen() {
    if (isFullscreen()) return;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el).catch(() => {});
  }
  ["pointerdown", "click", "touchend"].forEach((evt) => document.addEventListener(evt, goFullscreen, true));
  document.addEventListener("fullscreenchange", () => {
    if (isFullscreen()) ["pointerdown", "click", "touchend"].forEach((evt) => document.removeEventListener(evt, goFullscreen, true));
  });
})();
