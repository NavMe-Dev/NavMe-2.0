/* Media panel editor helpers (no bundler). Admin UI + node tests.
   Writes pipeline_config.media_panels for Option 4 (Tag hotspot → glass_v1 HUD).
   Kinds: image | video | text. Optional redirect buttons (CTA) on any kind.
   Empty list stays empty. */
(function (root) {
  "use strict";

  var KINDS = { image: true, video: true, text: true };
  var ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
  var URL_SAFE = /^(https?:\/\/|\/|#|mailto:|tel:)/i;

  function round3(n) {
    return Math.round(Number(n) * 1000) / 1000;
  }

  function numOrNull(v) {
    if (v === "" || v == null) return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function cloneVec(src) {
    if (!src || typeof src !== "object") return null;
    var x = numOrNull(src.x), y = numOrNull(src.y), z = numOrNull(src.z);
    if (x == null || y == null) return null;
    return { x: x, y: y, z: z == null ? 0 : z };
  }

  function normalizeButtons(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    raw.forEach(function (b) {
      if (!b || typeof b !== "object") return;
      var label = String(b.label != null ? b.label : (b.text || "")).trim();
      var url = String(b.url != null ? b.url : (b.href || "")).trim();
      if (!label && !url) return;
      out.push({ label: label, url: url });
    });
    return out;
  }

  function serializeButtons(list, strict) {
    var out = [];
    (list || []).forEach(function (b, i) {
      if (!b || typeof b !== "object") return;
      var label = String(b.label != null ? b.label : "").trim();
      var url = String(b.url != null ? b.url : "").trim();
      // Incomplete rows are always dropped (draft UI may leave empties)
      if (!label || !url) return;
      if (strict && url.indexOf("://") !== -1 && !URL_SAFE.test(url)) {
        throw new Error("Button " + (i + 1) + ": unsupported url scheme");
      }
      out.push({ label: label, url: url });
    });
    return out;
  }

  function blankRow(partial) {
    var p = partial || {};
    var kind = String(p.kind || "image").toLowerCase();
    if (!KINDS[kind]) kind = "image";
    return {
      _k: p._k || ("m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)),
      id: p.id || "",
      name: p.name || "",
      kind: kind,
      src: p.src || "",
      body: p.body != null ? String(p.body) : "",
      poster: p.poster || "",
      floor: p.floor || "",
      model: p.model && typeof p.model === "object"
        ? { x: p.model.x != null ? p.model.x : "", y: p.model.y != null ? p.model.y : "", z: p.model.z != null ? p.model.z : "" }
        : { x: "", y: "", z: "" },
      normal: p.normal && typeof p.normal === "object"
        ? { x: p.normal.x != null ? p.normal.x : "", y: p.normal.y != null ? p.normal.y : "", z: p.normal.z != null ? p.normal.z : "" }
        : { x: "", y: "", z: "" },
      sweep_sid: p.sweep_sid || "",
      poi_key: p.poi_key || "",
      style: p.style || "glass_v1",
      published: p.published !== false,
      buttons: normalizeButtons(p.buttons)
    };
  }

  function parsePanels(raw) {
    var list = Array.isArray(raw) ? raw : [];
    return list.map(function (e, i) {
      return blankRow({
        _k: "saved-" + i + "-" + ((e && e.id) || "x"),
        id: (e && e.id) || "",
        name: (e && e.name) || "",
        kind: (e && e.kind) || "image",
        src: (e && (e.src || e.url)) || "",
        body: (e && (e.body != null ? e.body : e.text)) || "",
        poster: (e && e.poster) || "",
        floor: (e && e.floor) || "",
        model: cloneVec(e && e.model) || { x: "", y: "", z: "" },
        normal: cloneVec(e && e.normal) || { x: "", y: "", z: "" },
        sweep_sid: (e && e.sweep_sid) || "",
        poi_key: (e && (e.poi_key || e.poi_id)) || "",
        style: (e && e.style) || "glass_v1",
        published: !(e && e.published === false),
        buttons: (e && e.buttons) || (e && e.ctas) || []
      });
    });
  }

  function modelComplete(m) {
    if (!m) return false;
    return numOrNull(m.x) != null && numOrNull(m.y) != null;
  }

  function panelHasContent(kind, src, body) {
    if (kind === "text") return !!(body && String(body).trim()) || !!(src && String(src).trim());
    return !!(src && String(src).trim());
  }

  function serializePanels(list, opts) {
    var strict = !(opts && opts.strict === false);
    var ids = {};
    var out = [];
    (list || []).forEach(function (e) {
      var id = String(e.id || "").trim();
      if (!ID_RE.test(id)) {
        throw new Error("Media id must start with a letter and use only letters, numbers, _ or - (" + (id || "blank") + ")");
      }
      if (ids[id]) throw new Error("Duplicate media id: " + id);
      ids[id] = true;
      var kind = String(e.kind || "image").toLowerCase();
      if (!KINDS[kind]) {
        if (strict) throw new Error(id + ": kind must be image, video, or text");
        kind = "image";
      }
      var src = String(e.src || "").trim();
      var body = e.body != null ? String(e.body) : "";
      if (kind !== "text") {
        if (!src && strict) throw new Error(id + ": media URL or upload required");
      } else {
        if (!String(body).trim() && !src && strict) {
          throw new Error(id + ": text panel needs a body (or optional src)");
        }
      }
      var model = cloneVec(e.model);
      if (!model && strict) throw new Error(id + ": place the panel (model x,y[,z] missing)");
      var normal = cloneVec(e.normal);
      var name = String(e.name || "").trim() || id;
      var buttons = serializeButtons(e.buttons, strict);
      var rec = {
        id: id,
        name: name,
        kind: kind,
        style: String(e.style || "glass_v1").trim() || "glass_v1",
        published: e.published !== false
      };
      if (kind === "text") {
        rec.body = body;
        if (src) rec.src = src;
      } else {
        rec.src = src;
      }
      if (model) {
        rec.model = { x: round3(model.x), y: round3(model.y), z: round3(model.z != null ? model.z : 0) };
      }
      if (normal) {
        rec.normal = { x: round3(normal.x), y: round3(normal.y), z: round3(normal.z != null ? normal.z : 0) };
      }
      var floor = String(e.floor || "").trim();
      if (floor) rec.floor = floor;
      var poster = String(e.poster || "").trim();
      if (poster && kind === "video") rec.poster = poster;
      var sweep = String(e.sweep_sid || "").trim();
      if (sweep) rec.sweep_sid = sweep;
      var poi = String(e.poi_key || "").trim();
      if (poi) rec.poi_key = poi;
      if (buttons.length) rec.buttons = buttons;
      if (!strict && (!panelHasContent(kind, src, body) || !model)) rec.draft = true;
      out.push(rec);
    });
    return out;
  }

  function mergePipeline(pipelineConfig, panels) {
    var pc = JSON.parse(JSON.stringify(pipelineConfig || {}));
    pc.media_panels = panels;
    return pc;
  }

  function applyPlacement(row, xy, how) {
    if (!row) return null;
    if (!row.model || typeof row.model !== "object") row.model = { x: "", y: "", z: "" };
    if (!row.normal || typeof row.normal !== "object") row.normal = { x: "", y: "", z: "" };
    if (xy && xy.x != null) row.model.x = round3(xy.x);
    if (xy && xy.y != null) row.model.y = round3(xy.y);
    if (xy && xy.z != null) row.model.z = round3(xy.z);
    if (xy && xy.normal && typeof xy.normal === "object") {
      if (xy.normal.x != null) row.normal.x = round3(xy.normal.x);
      if (xy.normal.y != null) row.normal.y = round3(xy.normal.y);
      if (xy.normal.z != null) row.normal.z = round3(xy.normal.z);
    }
    if (xy && xy.sid) row.sweep_sid = String(xy.sid);
    if (how && !row.floor && xy && xy.floor) row.floor = String(xy.floor);
    return row.model;
  }

  function blankButton() {
    return { label: "", url: "" };
  }

  root.WFMediaPanels = {
    KINDS: KINDS,
    round3: round3,
    blankRow: blankRow,
    blankButton: blankButton,
    parsePanels: parsePanels,
    serializePanels: serializePanels,
    mergePipeline: mergePipeline,
    applyPlacement: applyPlacement,
    modelComplete: modelComplete,
    normalizeButtons: normalizeButtons,
    panelHasContent: panelHasContent
  };
})(typeof window !== "undefined" ? window : globalThis);
