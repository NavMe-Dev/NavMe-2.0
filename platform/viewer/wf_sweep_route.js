/* wf_sweep_route.js — Hybrid sweep-graph routing over a Matterport scan.
 *
 * Single source of truth for the "hybrid navigation" rule, shared by:
 *   - threed_nav.js  (Walkthrough Wayfinding — dot trail you walk yourself)
 *   - mp_preview.js  (Tour interior — the same route, auto-played)
 *
 * Dijkstra across Matterport's own neighbour graph, then repaired geometrically
 * so the path runs THROUGH every scan point rather than teleporting over them.
 * Ported from GCU Production's threednavigation.ts.
 *
 * Exposes window.WFSweepRoute.
 */
(function () {
  "use strict";

  // ── Routing constants (ported from threednavigation.ts) ─────────────────────
  var HOP_EXPONENT             = 1.35;
  var FLOOR_STEP_M             = 0.35;
  var TELEPORT_HOP_M           = 2.5;
  var TELEPORT_DETOUR_MAX      = 1.35;
  var LEVEL_CHANGE_DETOUR_MAX  = 8;
  var LEVEL_CHANGE_IMPROVEMENT = 1.05;
  var LANDING_MAX_M            = 5;

  /**
   * Rise-over-run below which a height change is a SLOPE, not a staircase.
   *
   * `dy > FLOOR_STEP_M` alone cannot tell the two apart, and outdoors that is
   * fatal: a campus walkway climbing ~0.4m over a 13.7m hop (a 3% grade) tripped
   * the stair branch and was handed to planLegMostScanPoints — the planner whose
   * entire job is to cover as MANY scan points as possible — with a direct*8
   * budget of 110m. It did exactly that, touring the basketball court and back.
   * Real treads run ~0.6 rise/run and a scanned flight ~0.5, so 0.25 separates
   * them with room to spare.
   */
  var STAIR_MIN_GRADE = 0.25;
  /**
   * Hard ceiling on how far a stair repair may add over the chord it replaces.
   * direct*8 is sane for a 3m chord across a flight; on a long hop it authorises
   * a detour longer than the whole route.
   */
  var LEVEL_CHANGE_DETOUR_ABS_M = 25;

  /** NavMe model is Z-up (x east, y north, z up); Matterport is Y-up. */
  function toMp(p) { return { x: +p.x, y: +(p.z || 0), z: -(+p.y) }; }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function collectionEntries(col) {
    var out = [];
    if (!col) return out;
    if (typeof col.forEach === "function") { col.forEach(function(v){ out.push(v); }); return out; }
    if (Array.isArray(col)) return col.slice();
    if (typeof col === "object") { for (var k in col) out.push(col[k]); }
    return out;
  }

  // Module-level sweep collection, filled by watchSweepData().
  var sweepCollection = null, unsubSweepData = null;
  var sweeps = [];

  // ── Sweep.data subscription — MUST happen immediately after connect ──────────
  // The collection emits once, early, before PLAYING. Subscribing after PLAYING
  // misses it. This is exactly what watchSweepData() does in threednavigation.ts.
  function watchSweepData() {
    var sweep = mpSdk && mpSdk.Sweep;
    if (!sweep || !sweep.data || !sweep.data.subscribe) return;
    function keep(col) { if (col) sweepCollection = col; }
    var sub;
    try {
      sub = sweep.data.subscribe({ onCollectionUpdated: keep, onChanged: function(){} });
    } catch(_) {
      try { sub = sweep.data.subscribe(keep); } catch(__) { return; }
    }
    if (!sub) return;
    unsubSweepData = function() {
      try { if (typeof sub === "function") sub(); else if (sub.cancel) sub.cancel(); } catch(_){}
    };
  }

  function awaitSweepCollection(timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    var started = Date.now();
    function poll() {
      if (collectionEntries(sweepCollection).length) return Promise.resolve(sweepCollection);
      if (Date.now() - started > timeoutMs) return Promise.resolve(null);
      return wait(100).then(poll);
    }
    return poll();
  }

  // ── Parse sweep data into our graph format ───────────────────────────────────
  function readSweeps() {
    return awaitSweepCollection(12000).then(function(col) {
      var entries = collectionEntries(col);
      if (!entries.length) {
        console.warn("[ThreeDNav] Sweep.data timed out — routing will not work");
        return [];
      }
      var out = [];
      for (var i = 0; i < entries.length; i++) {
        var sw = entries[i];
        if (!sw || sw.enabled === false) continue;
        var sid = String(sw.id || sw.sid || sw.uuid || "");
        var pose = sw.pose;
        var pos = sw.position || (pose && pose.position) || sw.location;
        if (!sid || !pos) continue;
        var x = Number(pos.x), y = Number(pos.y), z = Number(pos.z);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        var nbRaw = sw.neighbors || sw.neighbours || [];
        var neighbours = [];
        if (Array.isArray(nbRaw)) {
          for (var j = 0; j < nbRaw.length; j++) {
            var n = nbRaw[j];
            var nid = typeof n === "string" ? n : String((n && (n.id || n.sid)) || "");
            if (nid) neighbours.push(nid);
          }
        }
        var floorInfo = sw.floorInfo;
        out.push({
          sid: sid,
          position: { x: x, y: y, z: z },
          neighbours: neighbours,
          floor: Number((floorInfo && floorInfo.id) || sw.floorId || sw.floor || 0) || 0
        });
      }
      return out;
    });
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────────
  function dist3(a, b) {
    var dx = a.position.x - b.position.x, dy = a.position.y - b.position.y, dz = a.position.z - b.position.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  // Scan points are recorded at tripod/eye height, route points at FLOOR level.
  // So the band around a route point is asymmetric: a sweep standing on the same
  // floor sits between -0.3m (slight dip) and +2.8m (tall tripod) ABOVE it.
  // A symmetric band would let the floor above win and send the route upstairs.
  var SWEEP_ABOVE_FLOOR_MIN_M = -0.3;
  var SWEEP_ABOVE_FLOOR_MAX_M = 2.8;

  function nearestSweepWithDistance(p) {
    // Pass 1 — only scan points standing on the floor the point belongs to.
    var best = null, bestD = Infinity;
    for (var i = 0; i < sweeps.length; i++) {
      var s = sweeps[i];
      var rise = s.position.y - p.y;
      if (rise < SWEEP_ABOVE_FLOOR_MIN_M || rise > SWEEP_ABOVE_FLOOR_MAX_M) continue;
      var dx = s.position.x - p.x, dz = s.position.z - p.z;
      // Floor already fixed, so plan distance is the whole question.
      var d = Math.sqrt(dx*dx + dz*dz);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) return { sweep: best, distance: bestD };

    // Pass 2 — nothing scanned on that floor. Better a reachable point on
    // another one than no route at all.
    best = null; bestD = Infinity;
    for (var j = 0; j < sweeps.length; j++) {
      var s2 = sweeps[j];
      var dx2 = s2.position.x - p.x, dy2 = s2.position.y - p.y, dz2 = s2.position.z - p.z;
      var d2 = Math.sqrt(dx2*dx2 + dz2*dz2) + Math.abs(dy2) * 0.15;
      if (d2 < bestD) { bestD = d2; best = s2; }
    }
    return best ? { sweep: best, distance: bestD } : null;
  }

  function nearestSweep(p) {
    var hit = nearestSweepWithDistance(p);
    return hit ? hit.sweep : null;
  }

  function pointSegDistSq(p, a, b) {
    var abx = b.position.x-a.position.x, aby = b.position.y-a.position.y, abz = b.position.z-a.position.z;
    var lenSq = abx*abx + aby*aby + abz*abz;
    var t = 0;
    if (lenSq > 1e-9) {
      t = ((p.position.x-a.position.x)*abx + (p.position.y-a.position.y)*aby + (p.position.z-a.position.z)*abz) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    var cx = a.position.x + abx*t - p.position.x;
    var cy = a.position.y + aby*t - p.position.y;
    var cz = a.position.z + abz*t - p.position.z;
    return cx*cx + cy*cy + cz*cz;
  }

  function hopCost(a, b) { return Math.pow(dist3(a, b), HOP_EXPONENT); }

  /**
   * Is the step from a to b a change of LEVEL (stairs / lift) rather than a
   * walk up a slope? Height alone is not enough — see STAIR_MIN_GRADE.
   */
  function isLevelChange(ay, by, ax, az, bx, bz) {
    var dy = Math.abs(by - ay);
    if (dy <= FLOOR_STEP_M) return false;
    var horiz = Math.sqrt((bx-ax)*(bx-ax) + (bz-az)*(bz-az));
    // Vertical-only hop (a lift) has no run to divide by — always a level change.
    if (horiz < 0.1) return true;
    return dy / horiz >= STAIR_MIN_GRADE;
  }

  function sweepsCrossLevels(u, v) {
    return isLevelChange(u.position.y, v.position.y, u.position.x, u.position.z, v.position.x, v.position.z);
  }

  // ── Dijkstra ─────────────────────────────────────────────────────────────────
  function solveRoute(fromSid, toSid) {
    var byId = buildSweepMap();
    if (fromSid === toSid) return [fromSid];
    var best = {}, prev = {}, unvisited = {};
    for (var i = 0; i < sweeps.length; i++) { unvisited[sweeps[i].sid] = true; }
    best[fromSid] = 0;

    for (;;) {
      var curId = null, curCost = Infinity;
      for (var id in unvisited) {
        if (best[id] !== undefined && best[id] < curCost) { curCost = best[id]; curId = id; }
      }
      if (!curId || curId === toSid) break;
      delete unvisited[curId];
      var cur = byId[curId]; if (!cur) continue;
      for (var j = 0; j < cur.neighbours.length; j++) {
        var nId = cur.neighbours[j];
        if (!unvisited[nId]) continue;
        var nb = byId[nId]; if (!nb) continue;
        var cost = curCost + hopCost(cur, nb);
        if (best[nId] === undefined || cost < best[nId]) { best[nId] = cost; prev[nId] = curId; }
      }
    }

    if (best[toSid] === undefined) return [];
    var raw = [];
    for (var id2 = toSid; id2 !== undefined; id2 = prev[id2]) {
      raw.unshift(id2);
      if (id2 === fromSid) break;
    }
    var ins = insertSkippedSweeps(raw, byId);
    var rep = repairTeleports(ins, byId);
    var fin = collapseLoops(rep);
    return fin;
  }

  function buildSweepMap() {
    var m = {};
    for (var i = 0; i < sweeps.length; i++) m[sweeps[i].sid] = sweeps[i];
    return m;
  }

  // ── Route repair (ported from threednavigation.ts) ────────────────────────────
  function collapseLoops(ids) {
    var out = [], seenAt = {};
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (seenAt[id] !== undefined) {
        var prior = seenAt[id];
        out.length = prior + 1;
        for (var k in seenAt) { if (seenAt[k] > prior) delete seenAt[k]; }
      } else {
        seenAt[id] = out.length;
        out.push(id);
      }
    }
    return out;
  }

  function insertSkippedSweeps(ids, byId) {
    if (ids.length < 2) return ids;
    var maxR2 = 1.6 * 1.6;
    var route = ids.slice();
    for (var pass = 0; pass < 3; pass++) {
      var out = [route[0]], added = 0;
      for (var i = 1; i < route.length; i++) {
        var u = byId[route[i-1]], v = byId[route[i]];
        if (!u || !v) { out.push(route[i]); continue; }
        if (Math.abs(v.position.y - u.position.y) > FLOOR_STEP_M) { out.push(route[i]); continue; }
        var onRoute = {};
        for (var x = 0; x < route.length; x++) onRoute[route[x]] = true;
        var between = [];
        for (var k = 0; k < sweeps.length; k++) {
          var cand = sweeps[k];
          if (onRoute[cand.sid]) continue;
          if (u.neighbours.indexOf(cand.sid) < 0 || cand.neighbours.indexOf(v.sid) < 0) continue;
          if (pointSegDistSq(cand, u, v) > maxR2) continue;
          var ax = v.position.x-u.position.x, ay = v.position.y-u.position.y, az = v.position.z-u.position.z;
          var len2 = ax*ax+ay*ay+az*az;
          if (len2 <= 1e-9) continue;
          var t = ((cand.position.x-u.position.x)*ax+(cand.position.y-u.position.y)*ay+(cand.position.z-u.position.z)*az)/len2;
          if (t <= 0.02 || t >= 0.98) continue;
          between.push({ id: cand.sid, t: t });
        }
        between.sort(function(a,b){ return a.t-b.t; });
        for (var b = 0; b < between.length; b++) { out.push(between[b].id); added++; }
        out.push(route[i]);
      }
      route = out;
      if (!added) break;
    }
    return route;
  }

  function planLegByDistance(u, v, byId) {
    var best = {}, prev = {}, seen = {};
    best[u.sid] = 0;
    for (;;) {
      var curId = null, curCost = Infinity;
      for (var id in best) { if (!seen[id] && best[id] < curCost) { curCost = best[id]; curId = id; } }
      if (!curId || curId === v.sid) break;
      seen[curId] = true;
      var cur = byId[curId]; if (!cur) continue;
      for (var j = 0; j < cur.neighbours.length; j++) {
        var nId = cur.neighbours[j];
        if (seen[nId]) continue;
        var nb = byId[nId]; if (!nb) continue;
        if (curId === u.sid && nId === v.sid) continue;
        var c = curCost + dist3(cur, nb);
        if (best[nId] === undefined || c < best[nId]) { best[nId] = c; prev[nId] = curId; }
      }
    }
    if (best[v.sid] === undefined) return [];
    var leg = [];
    for (var id2 = v.sid; id2 !== undefined && id2 !== u.sid; id2 = prev[id2]) leg.unshift(id2);
    return leg;
  }

  function planLegMostScanPoints(u, v, byId, maxDist) {
    var dir = v.position.y >= u.position.y ? 1 : -1;
    var loY = Math.min(u.position.y, v.position.y) - 0.3;
    var hiY = Math.max(u.position.y, v.position.y) + 0.3;
    var nodes = [];
    for (var i = 0; i < sweeps.length; i++) {
      var n = sweeps[i];
      if (n.position.y >= loY && n.position.y <= hiY) nodes.push(n);
    }
    nodes.sort(function(a,b){ return dir*(a.position.y-b.position.y) || (a.sid<b.sid?-1:a.sid>b.sid?1:0); });
    var rank = {};
    for (var r = 0; r < nodes.length; r++) rank[nodes[r].sid] = r;
    if (rank[u.sid] === undefined || rank[v.sid] === undefined) return [];
    var best = {}, prev = {};
    best[u.sid] = {count:0, dist:0};
    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      var cur = best[node.sid]; if (!cur) continue;
      for (var j = 0; j < node.neighbours.length; j++) {
        var nId = node.neighbours[j];
        var nb = byId[nId]; if (!nb || rank[nId] === undefined) continue;
        if (rank[nId] <= rank[node.sid]) continue;
        var d = cur.dist + dist3(node, nb);
        if (d > maxDist) continue;
        var cand = {count: cur.count+1, dist: d, prev: node.sid};
        var ex = best[nId];
        if (!ex || cand.count > ex.count || (cand.count===ex.count && cand.dist < ex.dist)) best[nId] = cand;
      }
    }
    if (!best[v.sid]) return [];
    var leg = [];
    for (var id = v.sid; id !== undefined && id !== u.sid; id = best[id] && best[id].prev) {
      leg.unshift(id);
      if (leg.length > nodes.length) return [];
    }
    return leg;
  }

  function planLegByLeastClimb(u, v, byId) {
    function better(a,b) { if(!b)return true; if(Math.abs(a.rise-b.rise)>1e-6)return a.rise<b.rise; return a.dist<b.dist; }
    var best = {}, prev = {}, seen = {};
    best[u.sid] = {rise:0, dist:0};
    for (;;) {
      var curId = null, curLabel = null;
      for (var id in best) { if (!seen[id] && better(best[id], curLabel)) { curLabel = best[id]; curId = id; } }
      if (!curId || curId === v.sid) break;
      seen[curId] = true;
      var cur = byId[curId]; if (!cur) continue;
      for (var j = 0; j < cur.neighbours.length; j++) {
        var nId = cur.neighbours[j];
        if (seen[nId]) continue;
        var nb = byId[nId]; if (!nb) continue;
        if (curId === u.sid && nId === v.sid) continue;
        var label = {rise: Math.max(curLabel.rise, Math.abs(nb.position.y-cur.position.y)), dist: curLabel.dist+dist3(cur,nb)};
        if (better(label, best[nId] || null)) { best[nId] = label; prev[nId] = curId; }
      }
    }
    if (!best[v.sid]) return [];
    var leg = [];
    for (var id2 = v.sid; id2 !== undefined && id2 !== u.sid; id2 = prev[id2]) leg.unshift(id2);
    return leg;
  }

  function repairTeleports(ids, byId) {
    if (ids.length < 2) return ids;
    var out = [ids[0]];
    for (var i = 1; i < ids.length; i++) {
      var u = byId[ids[i-1]], v = byId[ids[i]];
      if (!u || !v) { out.push(ids[i]); continue; }
      var direct = dist3(u, v);
      var dy = Math.abs(v.position.y - u.position.y);
      var crossesLevels = sweepsCrossLevels(u, v);
      if (!crossesLevels && direct <= TELEPORT_HOP_M) { out.push(ids[i]); continue; }
      // Budget is capped in absolute metres as well as proportionally: a stair
      // repair adds a flight, never a tour of the building.
      var budget = crossesLevels
        ? Math.min(direct * LEVEL_CHANGE_DETOUR_MAX, direct + LEVEL_CHANGE_DETOUR_ABS_M)
        : direct * TELEPORT_DETOUR_MAX;
      var leg = [];
      if (crossesLevels) {
        leg = planLegMostScanPoints(u, v, byId, budget);
        if (leg.length <= 1) leg = planLegByLeastClimb(u, v, byId);
      } else {
        leg = planLegByDistance(u, v, byId);
      }
      if (leg.length <= 1) { out.push(ids[i]); continue; }
      var legDist = 0, legRise = 0, prev = u;
      for (var l = 0; l < leg.length; l++) {
        var node = byId[leg[l]]; if (!node) continue;
        legDist += dist3(prev, node);
        legRise = Math.max(legRise, Math.abs(node.position.y - prev.position.y));
        prev = node;
      }
      if (legDist > budget) { out.push(ids[i]); continue; }
      if (crossesLevels && legRise > dy * LEVEL_CHANGE_IMPROVEMENT) { out.push(ids[i]); continue; }
      var already = {}, upcoming = {};
      for (var a = 0; a < out.length; a++) already[out[a]] = true;
      for (var b = i+1; b < ids.length; b++) upcoming[ids[b]] = true;
      var doublesBack = false;
      for (var m = 0; m < leg.length-1; m++) { if (already[leg[m]] || upcoming[leg[m]]) { doublesBack=true; break; } }
      if (doublesBack) { out.push(ids[i]); continue; }
      for (var ll = 0; ll < leg.length; ll++) out.push(leg[ll]);
    }
    return collapseLoops(out);
  }

  function applyRepairs(raw, byId) {
    return collapseLoops(repairTeleports(insertSkippedSweeps(raw, byId), byId));
  }

  // ── Level-split into legs ─────────────────────────────────────────────────────
  function splitRouteAtLevelChanges(points) {
    if (!points || points.length < 2) return points && points.length ? [{kind:"walk",points:points.slice()}] : [];
    var minRise = 0.8;
    var kinds = [];
    for (var i = 1; i < points.length; i++) {
      var a0 = points[i-1], b0 = points[i];
      // Same gradient test as the repair pass — otherwise a gently sloping
      // outdoor walkway reads as a staircase and the trail is chopped into legs
      // that hide most of the route.
      kinds.push(isLevelChange(a0.y, b0.y, a0.x, a0.z, b0.x, b0.z) ? "stairs" : "walk");
    }

    function totalRise(from, to) {
      var r=0; for(var i=from+1;i<=to;i++) r+=Math.abs(points[i].y-points[i-1].y); return r;
    }
    function runLen(from, to) {
      var d=0; for(var i=from+1;i<=to;i++){var a=points[i-1],b=points[i];d+=Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2+(b.z-a.z)**2);} return d;
    }

    var raw = [], start = 0;
    for (var i = 1; i <= kinds.length; i++) {
      if (i===kinds.length || kinds[i]!==kinds[start]) { raw.push({kind:kinds[start],from:start,to:i}); start=i; }
    }

    var merged = [];
    for (var j=0; j<raw.length; j++) {
      var seg = raw[j];
      var kind = (seg.kind==="stairs" && totalRise(seg.from,seg.to) < minRise) ? "walk" : seg.kind;
      var last = merged[merged.length-1];
      if (last && last.kind===kind) last.to=seg.to; else merged.push({kind:kind,from:seg.from,to:seg.to});
    }

    var withLandings = [];
    for (var j=0; j<merged.length; j++) {
      var seg = merged[j];
      var prevSeg = withLandings[withLandings.length-1];
      var next = merged[j+1];
      var isLanding = seg.kind==="walk" && prevSeg && prevSeg.kind==="stairs" && next && next.kind==="stairs" && runLen(seg.from,seg.to)<=LANDING_MAX_M;
      if (isLanding) { prevSeg.to=seg.to; continue; }
      if (prevSeg && prevSeg.kind===seg.kind) prevSeg.to=seg.to; else withLandings.push({kind:seg.kind,from:seg.from,to:seg.to});
    }

    var final = [];
    for (var j=0; j<withLandings.length; j++) {
      var seg = withLandings[j];
      var prevSeg = final[final.length-1];
      if (prevSeg && prevSeg.kind===seg.kind) prevSeg.to=seg.to; else final.push({kind:seg.kind,from:seg.from,to:seg.to});
    }

    return final.map(function(seg){ return {kind:seg.kind, points:points.slice(seg.from, seg.to+1)}; });
  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Plan a route between two points given in Matterport Y-up world coords.
   * Returns null when either end cannot be snapped to a scan point.
   */
  function routeBetween(allSweeps, fromMp, toMp2) {
    sweeps = allSweeps || [];
    if (!sweeps.length) return null;
    var a = nearestSweep(fromMp), b = nearestSweep(toMp2);
    if (!a || !b) return null;
    var sids = solveRoute(a.sid, b.sid);
    if (!sids.length) return null;
    var byId = buildSweepMap();
    var points = [];
    for (var i = 0; i < sids.length; i++) {
      var sw = byId[sids[i]];
      if (sw) points.push({ x: sw.position.x, y: sw.position.y, z: sw.position.z });
    }
    return {
      sids: sids,
      points: points,
      legs: splitRouteAtLevelChanges(points),
      fromSweep: a,
      toSweep: b
    };
  }

  /** Convenience: route straight from a NavMe route object's navPath endpoints. */
  function routeForNavPath(allSweeps, navPath) {
    var pts = (navPath || []).filter(function (p) {
      return p && isFinite(p.x) && isFinite(p.y);
    });
    if (pts.length < 2) return null;
    return routeBetween(allSweeps, toMp(pts[0]), toMp(pts[pts.length - 1]));
  }

  function setSweeps(s) { sweeps = s || []; }
  function getSweeps() { return sweeps; }

  window.WFSweepRoute = {
    toMp: toMp,
    collectionEntries: collectionEntries,
    watchSweepData: watchSweepData,
    awaitSweepCollection: awaitSweepCollection,
    readSweeps: readSweeps,
    setSweeps: setSweeps,
    getSweeps: getSweeps,
    nearestSweep: nearestSweep,
    nearestSweepWithDistance: nearestSweepWithDistance,
    solveRoute: solveRoute,
    splitRouteAtLevelChanges: splitRouteAtLevelChanges,
    routeBetween: routeBetween,
    routeForNavPath: routeForNavPath,
    isLevelChange: isLevelChange,
    STAIR_MIN_GRADE: STAIR_MIN_GRADE
  };
})();
