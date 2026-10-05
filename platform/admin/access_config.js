/* Access controls editor helpers (no bundler). Admin UI + node tests.
   Writes pipeline_config.access:
     twin: public | pin | disabled
     twin_pin: optional (sent once; server hashes → twin_pin_hash)
     tour_public: bool
     routing: { mode: all_public | exclude_edges, excluded_edge_ids: [] }
   Never invent vendor ACL — NavMe-owned gate only. */
(function (root) {
  "use strict";

  var TWIN_MODES = ["public", "pin", "disabled"];
  var ROUTING_MODES = ["all_public", "exclude_edges"];

  function asBool(v, dflt) {
    if (v === true || v === false) return v;
    if (v === "true" || v === 1 || v === "1") return true;
    if (v === "false" || v === 0 || v === "0") return false;
    return dflt;
  }

  function normalizeEdgeId(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    if (s.indexOf("|") >= 0) {
      var p = s.split("|");
      if (p.length >= 2 && p[0] && p[1]) return p[0].trim() + "|" + p[1].trim();
    }
    var parts = s.split(/[→\u2192_]+/).filter(Boolean);
    if (parts.length === 2) return parts[0].trim() + "|" + parts[1].trim();
    return s;
  }

  function normalizeEdgeIds(list) {
    var out = [];
    var seen = {};
    (list || []).forEach(function (raw) {
      var id = normalizeEdgeId(raw);
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  function parseEdgeIdPaste(text) {
    var raw = String(text || "");
    var parts = raw.split(/[\s,;]+/).filter(Boolean);
    return normalizeEdgeIds(parts);
  }

  function blank(partial) {
    var p = partial || {};
    var twin = String(p.twin || "public").toLowerCase();
    if (TWIN_MODES.indexOf(twin) < 0) twin = "public";
    var routing = (p.routing && typeof p.routing === "object") ? p.routing : {};
    var mode = String(routing.mode || p.routing_mode || "all_public").toLowerCase();
    if (ROUTING_MODES.indexOf(mode) < 0) mode = "all_public";
    return {
      twin: twin,
      twin_pin: p.twin_pin != null ? String(p.twin_pin) : "",
      clear_twin_pin: !!p.clear_twin_pin,
      has_pin_hash: !!(p.twin_pin_hash || p.has_pin_hash),
      twin_pin_hash: p.twin_pin_hash || null,
      tour_public: asBool(p.tour_public, true),
      routing_mode: mode,
      excluded_edge_ids: normalizeEdgeIds(routing.excluded_edge_ids || p.excluded_edge_ids || []),
      edge_paste: p.edge_paste != null ? String(p.edge_paste) : ""
    };
  }

  function parseAccess(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return blank();
    return blank(raw);
  }

  function serializeAccess(state) {
    var s = blank(state);
    var out = {
      twin: s.twin,
      tour_public: !!s.tour_public,
      routing: {
        mode: s.routing_mode,
        excluded_edge_ids: s.routing_mode === "exclude_edges" ? normalizeEdgeIds(s.excluded_edge_ids) : []
      }
    };
    if (s.twin === "pin") {
      if (s.clear_twin_pin) {
        out.clear_twin_pin = true;
      } else if (s.twin_pin && String(s.twin_pin).trim()) {
        out.twin_pin = String(s.twin_pin).trim();
      } else if (s.twin_pin_hash) {
        // Preserve existing hash when admin did not type a new PIN
        out.twin_pin_hash = s.twin_pin_hash;
      }
    }
    return out;
  }

  function mergePipeline(pipelineConfig, accessState) {
    var pc = JSON.parse(JSON.stringify(pipelineConfig || {}));
    pc.access = serializeAccess(accessState);
    return pc;
  }

  /** Viewer-facing flags from published config.json */
  function viewerFlags(cfg) {
    var c = cfg || {};
    var a = parseAccess(c.access);
    var twin = a.twin;
    var tourPublic = a.tour_public !== false;
    var embedAllowed = twin !== "disabled" && (twin === "pin" || tourPublic);
    return {
      twin: twin,
      twin_disabled: twin === "disabled",
      twin_pin_required: twin === "pin",
      tour_public: tourPublic,
      embed_tour_allowed: embedAllowed,
      routing_mode: a.routing_mode,
      excluded_edge_ids: a.excluded_edge_ids.slice()
    };
  }

  function edgeIdKeys(raw) {
    var id = normalizeEdgeId(raw);
    if (!id) return [];
    if (id.indexOf("|") < 0) return [id];
    var p = id.split("|");
    if (p.length < 2 || !p[0] || !p[1]) return [id];
    var a = p[0].trim() + "|" + p[1].trim();
    var b = p[1].trim() + "|" + p[0].trim();
    return a === b ? [a] : [a, b];
  }

  function exclusionSet(list) {
    var set = {};
    normalizeEdgeIds(list).forEach(function (id) {
      edgeIdKeys(id).forEach(function (k) { set[k] = true; });
    });
    return set;
  }

  function isEdgeExcluded(excludedIds, edgeId) {
    var set = exclusionSet(excludedIds);
    return edgeIdKeys(edgeId).some(function (k) { return !!set[k]; });
  }

  /** Toggle undirected edge in excluded list; returns new array (canonical stored ids). */
  function toggleEdgeExcluded(excludedIds, edgeId) {
    var id = normalizeEdgeId(edgeId);
    if (!id) return normalizeEdgeIds(excludedIds);
    var keys = edgeIdKeys(id);
    var cur = normalizeEdgeIds(excludedIds);
    var set = exclusionSet(cur);
    var on = keys.some(function (k) { return !!set[k]; });
    if (on) {
      return cur.filter(function (x) {
        return !edgeIdKeys(x).some(function (k) { return keys.indexOf(k) >= 0; });
      });
    }
    cur.push(id);
    return normalizeEdgeIds(cur);
  }

  function annotateNavFeatures(features, excludedIds) {
    var feats = features || [];
    return feats.map(function (f) {
      var pr = Object.assign({}, (f && f.properties) || {});
      if (pr.edge_id) pr.excluded = isEdgeExcluded(excludedIds, pr.edge_id);
      else pr.excluded = false;
      return Object.assign({}, f, { properties: pr });
    });
  }

  function previewImpactMessage(fullOk, restrictedOk) {
    if (fullOk && !restrictedOk) return "Public users cannot reach this with current exclusions.";
    if (!fullOk) return "No route on the full draft graph (check POI nearest nodes / connectivity).";
    if (fullOk && restrictedOk) return "Public route available under current exclusions (path may differ from the full graph).";
    return "";
  }

  root.WFAccess = {
    TWIN_MODES: TWIN_MODES,
    ROUTING_MODES: ROUTING_MODES,
    blank: blank,
    parseAccess: parseAccess,
    serializeAccess: serializeAccess,
    mergePipeline: mergePipeline,
    viewerFlags: viewerFlags,
    normalizeEdgeId: normalizeEdgeId,
    normalizeEdgeIds: normalizeEdgeIds,
    parseEdgeIdPaste: parseEdgeIdPaste,
    edgeIdKeys: edgeIdKeys,
    exclusionSet: exclusionSet,
    isEdgeExcluded: isEdgeExcluded,
    toggleEdgeExcluded: toggleEdgeExcluded,
    annotateNavFeatures: annotateNavFeatures,
    previewImpactMessage: previewImpactMessage
  };
})(typeof window !== "undefined" ? window : globalThis);
