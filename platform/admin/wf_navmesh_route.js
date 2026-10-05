/* Pure navmesh routing, shared by the public viewer and the admin route tester.
 *
 * The route is produced ONLY by Recast on the building's navmesh — findClosestPoint +
 * computePath between two POI xyz positions. There is no sweep graph, no door/corridor
 * logic and no stair graph anywhere in this file: the navmesh is a single 3D surface in
 * which stairs are walkable slopes, so floor changes fall out of the geometry itself.
 *
 * Guidance is derived from the finished polyline and never feeds back into it — turns and
 * floor/stair labels are read off the points after the fact, so adding or changing guidance
 * cannot alter the route that Recast produced.
 *
 * Coordinates are Matterport SDK space (Y-up: y is elevation), matching both the navmesh
 * and the x/y/z returned by the navme-pois endpoint, so no transform is applied.
 */
(function (global) {
  "use strict";

  var RT = null;        // the bundled recast runtime (window.NavMeshRT)
  var navMesh = null;   // imported mesh for the current building
  var navKey = "";      // which building/url the loaded mesh belongs to
  var initPromise = null;

  function rt() {
    if (!RT) RT = global.NavMeshRT;
    if (!RT) throw new Error("recast-navigation bundle not loaded (vendor/recast-navigation.js)");
    return RT;
  }

  /** Load + import the navmesh for a building. Cached per url. */
  async function load(url, key) {
    if (navMesh && navKey === (key || url)) return navMesh;
    if (!initPromise) initPromise = rt().init();
    await initPromise;
    var res = await fetch(url);
    if (!res.ok) throw new Error("navmesh download failed (" + res.status + ")");
    var bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) throw new Error("navmesh file is empty");
    if (navMesh) { try { navMesh.destroy(); } catch (e) { /* already gone */ } }
    var out = rt().importNavMesh(bytes);
    if (!out || !out.navMesh) throw new Error("could not import navmesh");
    navMesh = out.navMesh;
    navKey = key || url;
    return navMesh;
  }

  function isLoaded() { return !!navMesh; }

  function dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  /** Route strictly on the navmesh between two {x,y,z} points. */
  function route(from, to) {
    if (!navMesh) return { ok: false, error: "No navmesh loaded" };
    var q;
    try { q = new (rt().NavMeshQuery)(navMesh); }
    catch (e) { return { ok: false, error: "NavMeshQuery failed: " + e.message }; }

    var a = q.findClosestPoint({ x: from.x, y: from.y, z: from.z });
    var b = q.findClosestPoint({ x: to.x, y: to.y, z: to.z });
    if (!a || !a.point) return { ok: false, error: "Start is not on the navmesh" };
    if (!b || !b.point) return { ok: false, error: "Destination is not on the navmesh" };

    var res;
    try { res = q.computePath(a.point, b.point); }
    catch (e) { return { ok: false, error: "computePath: " + e.message }; }

    var pts = (res && res.path) ? res.path : (Array.isArray(res) ? res : []);
    if (!pts.length) return { ok: false, error: "No path between those points" };

    var path = pts.map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
    var length = 0;
    for (var i = 1; i < path.length; i++) length += dist3(path[i], path[i - 1]);

    // How far the mesh-snapped ends sit from the requested POIs. Reported, never corrected —
    // nudging the endpoints would mean the drawn route is no longer the mesh's own path.
    var startGap = dist3(path[0], from);
    var endGap = dist3(path[path.length - 1], to);

    return { ok: true, path: path, length_m: Math.round(length * 10) / 10,
             start_gap_m: Math.round(startGap * 10) / 10,
             end_gap_m: Math.round(endGap * 10) / 10,
             partial: endGap > 2 };
  }

  // ---------------------------------------------------------------- guidance

  /** Compass-style bearing in the horizontal plane (x east, z depth). */
  function bearing(a, b) {
    return Math.atan2(b.x - a.x, -(b.z - a.z)) * 180 / Math.PI;
  }

  function turnWord(deg) {
    var a = Math.abs(deg);
    if (a < 20) return null;                      // not a real turn, just drift
    if (a < 50) return deg > 0 ? "Bear right" : "Bear left";
    if (a < 120) return deg > 0 ? "Turn right" : "Turn left";
    return deg > 0 ? "Sharp right" : "Sharp left";
  }

  /** Floor whose elevation is closest to y. floors: [{id,label,elevation}] */
  function floorAt(y, floors) {
    if (!floors || !floors.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < floors.length; i++) {
      var e = floors[i].elevation;
      if (e == null) continue;
      var d = Math.abs(y - e);
      if (d < bestD) { bestD = d; best = floors[i]; }
    }
    return best;
  }

  /**
   * Whether floor elevations are far enough apart to name a floor from a height.
   * Some buildings come through with overlapping or out-of-order elevations (GCU has
   * F2 at 3.43 and F3 at 3.04). Naming floors from those values produces confident
   * nonsense, so when they overlap we say "a level" instead of inventing a number.
   */
  function elevationsUsable(floors) {
    var es = (floors || []).map(function (f) { return f.elevation; })
                           .filter(function (e) { return e != null; })
                           .sort(function (a, b) { return a - b; });
    if (es.length < 2) return false;
    for (var i = 1; i < es.length; i++) if (es[i] - es[i - 1] < 1.5) return false;
    return true;
  }

  /**
   * Derive level bands from the actual spread of POI heights.
   *
   * Both nominal floor sources for this building are unreliable — config.json has
   * overlapping elevations (F2 3.43 / F3 3.04) and every Supabase POI is tagged F1
   * regardless of where it really is. Clustering the heights we can observe gives a
   * self-consistent set of levels, numbered bottom-up, which is honest about what is
   * actually known. Purely cosmetic: this labels guidance and never touches the route.
   *
   * ys: array of POI y values. n: expected level count (from the floor list).
   */
  function deriveLevels(ys, n) {
    var v = (ys || []).filter(function (y) { return y != null && isFinite(y); })
                      .slice().sort(function (a, b) { return a - b; });
    if (v.length < 2) return null;
    n = Math.max(1, Math.min(n || 0, v.length));
    // Split at the largest gaps — floors are separated by empty vertical space.
    var gaps = [];
    for (var i = 1; i < v.length; i++) gaps.push({ at: i, size: v[i] - v[i - 1] });
    gaps.sort(function (a, b) { return b.size - a.size; });
    var cuts = gaps.slice(0, Math.max(0, n - 1))
                   .filter(function (g) { return g.size > 1.2; })
                   .map(function (g) { return g.at; })
                   .sort(function (a, b) { return a - b; });
    if (!cuts.length) return null;
    var bands = [], from = 0;
    cuts.concat([v.length]).forEach(function (c) {
      var part = v.slice(from, c);
      if (part.length) bands.push({ lo: part[0], hi: part[part.length - 1],
                                    mid: (part[0] + part[part.length - 1]) / 2 });
      from = c;
    });
    bands.forEach(function (b, i) { b.label = "Level " + (i + 1); });
    return bands;
  }

  function levelAt(y, bands) {
    if (!bands || !bands.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < bands.length; i++) {
      var d = (y >= bands[i].lo && y <= bands[i].hi) ? 0
            : Math.min(Math.abs(y - bands[i].lo), Math.abs(y - bands[i].hi));
      if (d < bestD) { bestD = d; best = bands[i]; }
    }
    return best;
  }

  function floorName(y, floors, usable) {
    if (!usable) return null;
    var f = floorAt(y, floors);
    return f ? (f.label || f.id) : null;
  }

  /**
   * Turn-by-turn steps read off a finished route. Pure post-processing over the
   * polyline — it only reads `path`, so guidance can never alter the geometry Recast
   * produced.
   *
   * Every segment is classified by its own pitch (angle above horizontal) and by the
   * heading change at each vertex:
   *   pitch >= ELEVATOR_MIN_DEG (default 75, i.e. the 80-100 deg vertical case) -> elevator
   *   pitch in [STAIR_MIN_DEG, ELEVATOR_MIN_DEG)  (default 35-75)               -> stairs
   *   otherwise                                                                  -> flat walking
   *   heading change >= MIN_TURN_DEG (default 30) at a vertex                    -> a turn
   * Consecutive segments of the same kind are merged, so one staircase is one step
   * rather than one instruction per tread.
   */
  function guidance(path, opts) {
    opts = opts || {};
    var floors = opts.floors || [];
    var MIN_TURN_DEG = opts.minTurnDeg != null ? opts.minTurnDeg : 30;
    var STAIR_MIN_DEG = opts.stairMinDeg != null ? opts.stairMinDeg : 35;
    var ELEVATOR_MIN_DEG = opts.elevatorMinDeg != null ? opts.elevatorMinDeg : 75;
    if (!path || path.length < 2) return [];

    var usable = elevationsUsable(floors);
    var bands = (!usable && opts.levelYs) ? deriveLevels(opts.levelYs, (floors || []).length) : null;
    function nameAt(y) {
      if (bands) { var bd = levelAt(y, bands); return bd ? bd.label : null; }
      return floorName(y, floors, usable);
    }

    // --- classify every segment by its pitch, then merge equal neighbours -----
    var segs = [];
    for (var i = 0; i < path.length - 1; i++) {
      var p0 = path[i], p1 = path[i + 1];
      var dy = p1.y - p0.y;
      var run = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      var pitch = Math.atan2(Math.abs(dy), run) * 180 / Math.PI;   // 0 = flat, 90 = vertical
      var kind = pitch >= ELEVATOR_MIN_DEG ? "elevator"
               : pitch >= STAIR_MIN_DEG   ? "stairs"
               : "flat";
      var last = segs[segs.length - 1];
      if (last && last.kind === kind && (kind === "flat" || (last.rise > 0) === (dy > 0))) {
        last.to = i + 1; last.rise += dy; last.run += run; last.pitch = Math.max(last.pitch, pitch);
      } else {
        segs.push({ kind: kind, from: i, to: i + 1, rise: dy, run: run, pitch: pitch });
      }
    }

    var steps = [];
    var startName = nameAt(path[0].y) || opts.startFloor;
    steps.push({ type: "start", i: 0, point: path[0], dist_m: 0,
                 floor: startName || null,
                 arrow: "\u25CF", dir: "start", rotate: 0,
                 text: "Start" + (startName ? " on " + startName : "") });

    function heading(p, q) { return Math.atan2(q.x - p.x, -(q.z - p.z)) * 180 / Math.PI; }
    function turnAt(k) {
      if (k <= 0 || k >= path.length - 1) return 0;
      var d = heading(path[k], path[k + 1]) - heading(path[k - 1], path[k]);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    }
    /** Arrow for a step: direction comes from the measured angle, not the wording. */
    function turnArrow(d) {
      var m = Math.abs(d), right = d > 0;
      if (m < MIN_TURN_DEG) return { arrow: "\u2191", dir: "straight", rotate: 0 };          // up
      if (m < 60)  return { arrow: right ? "\u2197" : "\u2196", dir: right ? "slight-right" : "slight-left", rotate: Math.round(d) };
      if (m < 120) return { arrow: right ? "\u2192" : "\u2190", dir: right ? "right" : "left", rotate: Math.round(d) };
      if (m < 160) return { arrow: right ? "\u2198" : "\u2199", dir: right ? "sharp-right" : "sharp-left", rotate: Math.round(d) };
      return { arrow: "\u21B6", dir: "u-turn", rotate: Math.round(d) };
    }
    function turnWordFor(d) {
      var m = Math.abs(d);
      if (m < MIN_TURN_DEG) return null;
      if (m < 60) return d > 0 ? "Bear right" : "Bear left";
      if (m < 120) return d > 0 ? "Turn right" : "Turn left";
      return d > 0 ? "Sharp right" : "Sharp left";
    }

    for (var s2 = 0; s2 < segs.length; s2++) {
      var seg = segs[s2];
      var up = seg.rise > 0;
      var toName = nameAt(path[seg.to].y);

      if (seg.kind === "elevator") {
        steps.push({ type: "elevator", i: seg.from, point: path[seg.from],
          rise_m: Math.round(seg.rise * 10) / 10, pitch_deg: Math.round(seg.pitch),
          floor: toName || null, dist_m: 0,
          arrow: up ? "\u21C8" : "\u21CA", dir: up ? "elevator-up" : "elevator-down", rotate: 0,
          text: "Take the elevator " + (up ? "up" : "down") + (toName ? " to " + toName : "") });
        continue;
      }
      if (seg.kind === "stairs") {
        steps.push({ type: up ? "stairs_up" : "stairs_down", i: seg.from, point: path[seg.from],
          rise_m: Math.round(seg.rise * 10) / 10, pitch_deg: Math.round(seg.pitch),
          floor: toName || null, dist_m: Math.round(seg.run),
          arrow: up ? "\u2B06" : "\u2B07", dir: up ? "stairs-up" : "stairs-down", rotate: 0,
          text: "Take the stairs " + (up ? "up" : "down") + (toName ? " to " + toName : "") });
        continue;
      }

      // Flat run: walk, breaking at each real turn.
      var acc = 0;
      for (var k = seg.from; k < seg.to; k++) {
        acc += Math.hypot(path[k + 1].x - path[k].x, path[k + 1].z - path[k].z);
        var d = turnAt(k + 1);
        var w = turnWordFor(d);
        if (!w) continue;
        if (acc >= 1) {
          steps.push({ type: "walk", i: k, point: path[k + 1], dist_m: Math.round(acc),
                       arrow: "\u2191", dir: "straight", rotate: 0,
                       text: "Walk ahead " + Math.round(acc) + " m" });
        }
        var ar = turnArrow(d);
        steps.push({ type: "turn", i: k + 1, point: path[k + 1], turn_deg: Math.round(d),
                     arrow: ar.arrow, dir: ar.dir, rotate: ar.rotate, text: w });
        acc = 0;
      }
      if (acc >= 1) {
        steps.push({ type: "walk", i: seg.to, point: path[seg.to], dist_m: Math.round(acc),
                     arrow: "\u2191", dir: "straight", rotate: 0,
                     text: "Walk ahead " + Math.round(acc) + " m" });
      }
    }

    // Attach the nearest Matterport sweep to every step, so the UI can show the real
    // captured view at that spot (Showcase opens at this sweep id).
    // opts.sweeps: [{id,x,y,z}] in MODEL space; step points are SDK space, and
    // model = (x, -z, y) for this building.
    if (opts.sweeps && opts.sweeps.length) {
      for (var si = 0; si < steps.length; si++) {
        var sp = steps[si].point; if (!sp) continue;
        var mx = sp.x, my = -sp.z, mz = sp.y;
        var best = null, bd = Infinity;
        for (var w2 = 0; w2 < opts.sweeps.length; w2++) {
          var sw = opts.sweeps[w2];
          var d2 = (sw.x - mx) * (sw.x - mx) + (sw.y - my) * (sw.y - my) + (sw.z - mz) * (sw.z - mz);
          if (d2 < bd) { bd = d2; best = sw; }
        }
        if (best) { steps[si].sweep = best.id; steps[si].sweep_dist_m = Math.round(Math.sqrt(bd) * 10) / 10; }
      }
    }

    var endName = nameAt(path[path.length - 1].y) || opts.endFloor;
    steps.push({ type: "arrive", i: path.length - 1, point: path[path.length - 1], dist_m: 0,
                 floor: endName || null,
                 arrow: "\u25C9", dir: "arrive", rotate: 0,
                 text: "Arrive" + (endName ? " on " + endName : "") });
    return steps;
  }

  /** Floors the route passes through, in order of first appearance. */
  function floorsUsed(path, floors) {
    var seen = [], out = [];
    for (var i = 0; i < path.length; i++) {
      var f = floorAt(path[i].y, floors);
      if (f && seen.indexOf(f.id) === -1) { seen.push(f.id); out.push(f); }
    }
    return out;
  }

  global.WFNavmeshRoute = {
    load: load, isLoaded: isLoaded, route: route, deriveLevels: deriveLevels,
    guidance: guidance, floorsUsed: floorsUsed, floorAt: floorAt
  };
})(window);
