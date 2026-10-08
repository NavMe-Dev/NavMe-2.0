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
    /* ArcGIS-only map controls — meaningless once the map itself is hidden. */
    body.mp-bg-mode #btn3D, body.mp-bg-mode #btnLayers, body.mp-bg-mode #btnLabels { display:none !important; }
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
    body.mp-bg-mode.mp-frame-loaded #mpBgLoading {
      inset:auto; bottom:18px; left:50%; transform:translateX(-50%); right:auto;
      flex-direction:row; max-width:86%; width:auto; padding:9px 16px; gap:10px;
      background:rgba(0,0,0,.72); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
      border-radius:20px; pointer-events:none;
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
  `;
  document.head.appendChild(style);

  function boot() {
    if (!window.MpPreview || !window.MpPreview.showBackground) { setTimeout(boot, 150); return; }
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
})();
