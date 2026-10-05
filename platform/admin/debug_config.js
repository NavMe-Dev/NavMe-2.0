/* Debug settings helpers for Spatial Studio (no bundler). */
(function (root) {
  "use strict";

  function parseOverride(raw) {
    if (raw === true) return true;
    if (raw === false) return false;
    if (!raw || typeof raw !== "object") return null;
    if (!("enabled" in raw) || raw.enabled === null || raw.enabled === undefined) return null;
    return !!raw.enabled;
  }

  function mergePipeline(pipelineConfig, override) {
    var pc = JSON.parse(JSON.stringify(pipelineConfig || {}));
    if (override === null || override === undefined || override === "inherit") {
      delete pc.debug;
    } else {
      pc.debug = { enabled: !!override };
    }
    return pc;
  }

  function overrideLabel(ov) {
    if (ov === true) return "On (override)";
    if (ov === false) return "Off (override)";
    return "Inherit global";
  }

  root.WFDebugConfig = {
    parseOverride: parseOverride,
    mergePipeline: mergePipeline,
    overrideLabel: overrideLabel
  };
})(typeof window !== "undefined" ? window : globalThis);
