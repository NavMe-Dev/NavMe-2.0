/* Matterport public viewer (?mp=1): swaps the ArcGIS map background for the live
   Matterport Showcase embed, left in Dollhouse mode. Everything else (search,
   directions, turn-by-turn) is the normal ui.js/app.js chrome running unmodified
   on top — ui.js only ever duck-types window.wf.*, it never checks how the
   background is rendered. See ui.js's isMpMode()/mpFocusSelection() for the
   POI-selection and turn-by-turn camera wiring that pairs with this file. */
(function () {
  function isMpMode() { return new URLSearchParams(location.search).get("mp") === "1"; }
  if (!isMpMode()) return;

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
  `;
  document.head.appendChild(style);

  function boot() {
    if (!window.MpPreview || !window.MpPreview.showBackground) { setTimeout(boot, 150); return; }
    window.MpPreview.showBackground();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
