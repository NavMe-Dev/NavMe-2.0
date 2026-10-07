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
    body.mp-bg-mode .mp-overlay .mp-bar,
    body.mp-bg-mode .mp-overlay .mp-status,
    body.mp-bg-mode .mp-overlay .mp-dir-arrow,
    body.mp-bg-mode .mp-overlay .mp-dist-hud { display:none !important; }
    body.mp-bg-mode .mp-panel, body.mp-bg-mode .mp-frame-wrap, body.mp-bg-mode #mpFrame {
      width:100%; height:100%; border-radius:0;
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
