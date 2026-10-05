/* Path A scaffold: Matterport Bundle Scene entry (Dollhouse free-cam only per docs).
   Does NOT invent INSIDE continuous camera. Opens configured self-hosted showcase URL
   or shows a clear unavailable state. */
(function (root) {
  "use strict";

  var ov = null, iframe = null, statusEl = null;

  function flags() {
    var cfg = (root.WF && root.WF.cfg) || {};
    if (root.WFTourModes && WFTourModes.viewerFlags) return WFTourModes.viewerFlags(cfg);
    var tm = cfg.tour_modes || {};
    return {
      bundle_scene: !!tm.bundle_scene,
      bundle_url: tm.bundle_url || "",
      bundle_configured: !!(tm.bundle_url || tm.bundle_configured),
      bundle_available: !!tm.bundle_scene && !!(tm.bundle_url || tm.bundle_configured),
      bundle_note: tm.bundle_note || "",
      bundle_camera: "dollhouse"
    };
  }

  function ensureOverlay() {
    ov = document.getElementById("bundleOverlay");
    if (ov) {
      iframe = document.getElementById("bundleFrame");
      statusEl = document.getElementById("bundleStatus");
      return ov;
    }
    ov = document.createElement("div");
    ov.id = "bundleOverlay";
    ov.className = "mp-overlay";
    ov.hidden = true;
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Bundle scene");
    ov.innerHTML =
      '<div class="mp-chrome">' +
      '  <div class="mp-title"><span class="ms">view_in_ar</span><span>Bundle scene</span></div>' +
      '  <button type="button" class="ib" id="bundleClose" aria-label="Close"><span class="ms">close</span></button>' +
      '</div>' +
      '<div id="bundleStatus" class="mp-status" style="padding:8px 12px;background:#fff8e1;color:#5d4037;font:13px/1.4 Roboto,Arial,sans-serif"></div>' +
      '<iframe id="bundleFrame" title="Matterport Bundle Showcase" allow="xr-spatial-tracking; fullscreen; clipboard-write" allowfullscreen style="flex:1;border:0;width:100%;background:#111"></iframe>';
    document.body.appendChild(ov);
    iframe = document.getElementById("bundleFrame");
    statusEl = document.getElementById("bundleStatus");
    document.getElementById("bundleClose").onclick = close;
    return ov;
  }

  function close() {
    if (!ov) return;
    ov.hidden = true;
    if (iframe) iframe.src = "about:blank";
    document.body.classList.remove("mp-open");
  }

  function buildBundleSrc(f) {
    var base = (f.bundle_url || "").trim();
    if (!base) return "";
    var model = (root.WF && root.WF.cfg && root.WF.cfg.matterport_model_id) || "";
    try {
      var u = new URL(base, location.href);
      if (model && !u.searchParams.get("m")) u.searchParams.set("m", model);
      // applicationKey left to host page / bundle connect; public bundles do not expose the key
      u.searchParams.set("play", "1");
      // Prefer dollhouse for any free-cam experiments (docs: free-cam only in dollhouse)
      if (!u.searchParams.get("mode")) u.searchParams.set("mode", "dollhouse");
      return u.href;
    } catch (e) {
      return base;
    }
  }

  function open(route) {
    var f = flags();
    ensureOverlay();
    if (!f.bundle_scene) {
      statusEl.textContent = "Bundle Scene is disabled in Tour settings.";
      iframe.src = "about:blank";
      ov.hidden = false;
      document.body.classList.add("mp-open");
      return;
    }
    if (!f.bundle_configured || !f.bundle_url) {
      statusEl.textContent =
        "Bundle Scene enabled but no showcase URL is configured. Self-host Matterport Showcase Bundle, set the URL in Spatial Studio → Tour, then re-publish. " +
        "Free camera is Dollhouse-only per Matterport docs — INSIDE continuous walk along the mesh is not available on documented APIs.";
      iframe.src = "about:blank";
      ov.hidden = false;
      document.body.classList.add("mp-open");
      return;
    }
    var note = f.bundle_note
      ? f.bundle_note + " · "
      : "";
    statusEl.textContent =
      note +
      "Scaffold: loading self-hosted Bundle. Free-cam control applies in Dollhouse mode only (Matterport docs). " +
      "This is not Embed Tour interior and does not claim INSIDE free-cam along the walk grid.";
    iframe.src = buildBundleSrc(f);
    ov.hidden = false;
    document.body.classList.add("mp-open");
    // Soft attempt: if Bundle window exposes MP_SDK after load, switch to dollhouse (best-effort; may fail without key).
    iframe.onload = function () {
      try {
        var w = iframe.contentWindow;
        if (!w || !w.MP_SDK) return;
        // Connect requires applicationKey — public viewer does not have it. Leave iframe as Showcase UI.
        statusEl.textContent += " Showcase loaded. SDK connect needs a domain-whitelisted key (admin / Bundle host).";
      } catch (e) {
        // Cross-origin bundle host: expected; status already explains limits.
      }
    };
  }

  function available() {
    var f = flags();
    return !!f.bundle_scene; // button can show; open() explains if URL missing
  }

  root.BundlePreview = { open: open, close: close, available: available, flags: flags };
})(typeof window !== "undefined" ? window : globalThis);
