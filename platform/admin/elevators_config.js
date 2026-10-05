/* Elevator editor helpers (no bundler). Admin UI + node tests.
   Writes the pipeline_config.elevators shape from docs/ELEVATOR_OPTIONS.md.
   Does not invent shafts: an empty list stays empty. */
(function (root) {
  "use strict";

  function round3(n) {
    return Math.round(Number(n) * 1000) / 1000;
  }

  function numOrNull(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function sortFloors(ids, buildingFloors) {
    const ord = {};
    (buildingFloors || []).forEach(function (f, i) {
      ord[f.fid] = f.ordinal != null ? Number(f.ordinal) : i;
    });
    return ids.slice().sort(function (a, b) {
      const oa = Object.prototype.hasOwnProperty.call(ord, a) ? ord[a] : 9999;
      const ob = Object.prototype.hasOwnProperty.call(ord, b) ? ord[b] : 9999;
      if (oa !== ob) return oa - ob;
      return String(a).localeCompare(String(b));
    });
  }

  function cloneDoors(src) {
    const out = {};
    const s = src && typeof src === "object" ? src : {};
    Object.keys(s).forEach(function (f) {
      const d = s[f];
      if (!d || typeof d !== "object") return;
      out[f] = { x: d.x, y: d.y };
    });
    return out;
  }

  /** Merge one floor's door into row.doors without replacing the whole map. */
  function mergeDoor(row, fid, xy) {
    if (!row) return null;
    const f = String(fid || "");
    if (!f) return null;
    if (!row.doors || typeof row.doors !== "object") row.doors = {};
    const cur = row.doors[f] || {};
    const next = { x: cur.x, y: cur.y };
    if (xy && Object.prototype.hasOwnProperty.call(xy, "x")) next.x = xy.x;
    if (xy && Object.prototype.hasOwnProperty.call(xy, "y")) next.y = xy.y;
    row.doors[f] = next;
    return next;
  }

  function blankRow(partial) {
    const p = partial || {};
    return {
      _k: p._k || ("e-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)),
      id: p.id || "",
      name: p.name || "",
      floors: Array.isArray(p.floors) ? p.floors.slice() : [],
      doors: cloneDoors(p.doors),
      bbox: Array.isArray(p.bbox) ? p.bbox.slice(0, 4) : ["", "", "", ""],
      useBbox: !!p.useBbox
    };
  }

  function parseElevators(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list.map(function (e, i) {
      const doors = {};
      const src = e && e.doors && typeof e.doors === "object" ? e.doors : {};
      Object.keys(src).forEach(function (f) {
        const d = src[f];
        if (!d || typeof d !== "object") return;
        const x = numOrNull(d.x), y = numOrNull(d.y);
        if (x == null || y == null) return;
        doors[f] = { x: x, y: y };
      });
      const bbox = Array.isArray(e && e.bbox_model) ? e.bbox_model : null;
      const useBbox = !!(bbox && bbox.length >= 4 && bbox.slice(0, 4).every(function (n) { return Number.isFinite(Number(n)); }));
      return blankRow({
        _k: "saved-" + i + "-" + ((e && e.id) || "x"),
        id: (e && e.id) || "",
        name: (e && e.name) || "",
        floors: Array.isArray(e && e.floors) ? e.floors.map(String) : [],
        doors: doors,
        bbox: useBbox ? bbox.slice(0, 4).map(Number) : ["", "", "", ""],
        useBbox: useBbox
      });
    });
  }

  function doorComplete(d) {
    if (!d) return false;
    return numOrNull(d.x) != null && numOrNull(d.y) != null;
  }

  function serializeElevators(list, buildingFloors, opts) {
    const strict = !(opts && opts.strict === false);
    const ids = {};
    const out = [];
    (list || []).forEach(function (e) {
      const id = String(e.id || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(id)) {
        throw new Error("Elevator id must start with a letter and use only letters, numbers, _ or - (" + (id || "blank") + ")");
      }
      if (ids[id]) throw new Error("Duplicate elevator id: " + id);
      ids[id] = true;
      const floors = sortFloors((e.floors || []).map(function (f) { return String(f).trim(); }).filter(Boolean), buildingFloors);
      if (floors.length < 2 && strict) throw new Error(id + ": pick at least two floors");
      const uniq = {};
      floors.forEach(function (f) { uniq[f] = true; });
      if (Object.keys(uniq).length !== floors.length) throw new Error(id + ": duplicate floor");
      const doors = {};
      // In draft mode, keep any door on a known floor even if that floor is not checked yet.
      const doorKeys = strict ? floors : Object.keys(e.doors || {}).concat(floors);
      const seenDoor = {};
      doorKeys.forEach(function (f) {
        if (seenDoor[f]) return; seenDoor[f] = true;
        const d = (e.doors || {})[f];
        if (doorComplete(d)) doors[f] = { x: round3(d.x), y: round3(d.y) };
      });
      let bbox = null;
      if (e.useBbox) {
        const b = (e.bbox || []).slice(0, 4).map(numOrNull);
        if (b.length !== 4 || b.some(function (n) { return n == null; })) {
          if (strict) throw new Error(id + ": bounding box needs xmin, ymin, xmax, ymax");
        } else if (!(b[0] < b[2] && b[1] < b[3])) {
          if (strict) throw new Error(id + ": bounding box min must be less than max");
        } else {
          bbox = b.map(round3);
        }
      }
      const placed = Object.keys(doors).length;
      if (strict && !bbox && floors.length && placed !== floors.length) {
        const missing = floors.filter(function (f) { return !doors[f]; });
        throw new Error(id + ": door XY missing on " + missing.join(", ") + " (or set a bounding box)");
      }
      const name = String(e.name || "").trim() || id;
      const rec = { id: id, name: name, floors: floors };
      if (placed) rec.doors = doors;
      if (bbox) rec.bbox_model = bbox;
      if (!strict && (floors.length < 2 || (!bbox && floors.some(function (f) { return !doors[f]; })))) rec.draft = true;
      out.push(rec);
    });
    return out;
  }

  function mergePipeline(pipelineConfig, elevators) {
    const pc = JSON.parse(JSON.stringify(pipelineConfig || {}));
    pc.elevators = elevators;
    return pc;
  }

  root.WFElevators = {
    round3: round3,
    sortFloors: sortFloors,
    cloneDoors: cloneDoors,
    mergeDoor: mergeDoor,
    blankRow: blankRow,
    parseElevators: parseElevators,
    serializeElevators: serializeElevators,
    mergePipeline: mergePipeline
  };
})(typeof window !== "undefined" ? window : globalThis);
