/* Tour mode editor helpers (no bundler). Admin UI + node tests.
   Writes pipeline_config.tour_modes for Directions tour buttons.
   Modes: embed_showcase (Sweep hops), mesh_tour (GLB walk), bundle_scene (scaffold).
   Bundle free-cam is Dollhouse-only per Matterport docs — do not claim INSIDE free-cam. */
(function (root) {
  "use strict";

  var DEFAULTS = {
    embed_showcase: true,
    mesh_tour: false,
    bundle_scene: false,
    bundle_url: "",
    bundle_camera: "dollhouse",
    bundle_note: ""
  };

  function asBool(v, dflt) {
    if (v === true || v === false) return v;
    if (v === "true" || v === 1 || v === "1") return true;
    if (v === "false" || v === 0 || v === "0") return false;
    return dflt;
  }

  function blank(partial) {
    var p = partial || {};
    var cam = String(p.bundle_camera || p.camera_mode || DEFAULTS.bundle_camera).toLowerCase();
    if (cam !== "dollhouse") cam = "dollhouse"; // only documented free-cam mode
    return {
      embed_showcase: asBool(p.embed_showcase, DEFAULTS.embed_showcase),
      mesh_tour: asBool(p.mesh_tour, DEFAULTS.mesh_tour),
      bundle_scene: asBool(p.bundle_scene, DEFAULTS.bundle_scene),
      bundle_url: String(p.bundle_url != null ? p.bundle_url : (p.bundle && p.bundle.url) || "").trim(),
      bundle_camera: cam,
      bundle_note: String(p.bundle_note != null ? p.bundle_note : (p.bundle && p.bundle.note) || "").trim()
    };
  }

  function parseTourModes(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return blank();
    return blank(raw);
  }

  function serializeTourModes(state, opts) {
    var s = blank(state);
    var out = {
      embed_showcase: !!s.embed_showcase,
      mesh_tour: !!s.mesh_tour,
      bundle_scene: !!s.bundle_scene,
      bundle_camera: "dollhouse"
    };
    if (s.bundle_url) out.bundle_url = s.bundle_url;
    if (s.bundle_note) out.bundle_note = s.bundle_note;
    // Honest availability flags for publish/viewer (may be filled later)
    out.bundle_configured = !!(s.bundle_url && String(s.bundle_url).trim());
    if (opts && opts.has_glb != null) out.has_glb = !!opts.has_glb;
    return out;
  }

  function mergePipeline(pipelineConfig, tourModes) {
    var pc = JSON.parse(JSON.stringify(pipelineConfig || {}));
    pc.tour_modes = serializeTourModes(tourModes);
    return pc;
  }

  /** Viewer-facing flags from published config.json (defaults when unset). */
  function viewerFlags(cfg) {
    var c = cfg || {};
    var tm = parseTourModes(c.tour_modes);
    var hasGlb = c.has_glb === true
      || (tm.has_glb === true)
      || !!(c.files && c.files.model_glb)
      || !!(c.files && c.files.glb);
    var bundleUrl = tm.bundle_url || "";
    var bundleConfigured = !!bundleUrl || tm.bundle_configured === true;
    return {
      embed_showcase: tm.embed_showcase !== false,
      mesh_tour: !!tm.mesh_tour && hasGlb,
      mesh_tour_enabled: !!tm.mesh_tour,
      has_glb: hasGlb,
      bundle_scene: !!tm.bundle_scene,
      bundle_url: bundleUrl,
      bundle_configured: bundleConfigured,
      bundle_camera: "dollhouse",
      bundle_available: !!tm.bundle_scene && bundleConfigured,
      bundle_note: tm.bundle_note || ""
    };
  }

  root.WFTourModes = {
    DEFAULTS: DEFAULTS,
    blank: blank,
    parseTourModes: parseTourModes,
    serializeTourModes: serializeTourModes,
    mergePipeline: mergePipeline,
    viewerFlags: viewerFlags
  };
})(typeof window !== "undefined" ? window : globalThis);
