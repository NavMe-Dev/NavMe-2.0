function wfDbg(level, source, message, meta) {
  try { if (window.WFDebug && WFDebug.isEnabled()) WFDebug.log(level, source, message, meta); } catch (_) {}
}
/* Hybrid routing: Matterport sweep graph (pruned) + doors + stairs + elevators + OSM footways.
   A* via ngraph.path (MIT) on an ngraph.graph (BSD-3); bearings via turf (MIT).
   Output keeps ordered Matterport sweep ids + XYZ for Showcase Sweep.moveTo.
   sweep_ids = LOS/collinear-shortcut sequence (straighter Tour); sweep_ids_raw = full A* sweeps.
   Map polyline + turn-by-turn use the SAME geometric path as Tour (sweep/hard shortcut pts).
   A* soft-prefers edges aimed at dest (DEST_ALIGN_WEIGHT); stairs/elevators unweighted. */
(function () {
  const WF = {};
  let nav, grid, graph, nodes = {}, walk = {}, zcm = {}, navmeshByFloor = {};
  const STAIR_PENALTY = 15, WALK_MPS = 1.2;
  const ELEVATOR_WAIT_S = 20, ELEVATOR_PER_FLOOR_S = 4;

  function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function isElevator(l) { const d = l && l.data; return !!(d && (d.source === 'elevator' || d.elevator)); }
  function elevName(d) {
    if (!nav || !nav.elevators || !d.elevator) return 'elevator';
    const el = nav.elevators.find(e => e.id === d.elevator);
    return (el && el.name) ? el.name : 'elevator';
  }
  function elevFloorDelta(l, a, b) {
    if (l.data.floor_delta != null) return Math.max(1, l.data.floor_delta);
    if (!nav || !nav.floors) return 1;
    const ids = Object.keys(nav.floors);
    const ia = ids.indexOf(a.floor), ib = ids.indexOf(b.floor);
    if (ia >= 0 && ib >= 0) return Math.max(1, Math.abs(ia - ib));
    return 1;
  }

  WF.init = function (navData, gridData, navmeshData) {
    nav = navData; grid = gridData;
    graph = createGraph();
    nav.nodes.forEach(n => { nodes[n.id] = n; graph.addNode(n.id, n); });
    nav.edges.forEach(e => {
      // Elevator length already includes wait+climb metres-equivalent; no STAIR_PENALTY.
      const cost = e.length + (e.stairs ? STAIR_PENALTY : 0);
      graph.addLink(e.u, e.v, Object.assign({ cost }, e));
    });
    for (const F of Object.keys(grid.floors)) {
      walk[F] = b64ToBytes(grid.floors[F].walk);
      const zb = b64ToBytes(grid.floors[F].z_cm); zcm[F] = new Int16Array(zb.buffer);
    }
    // Triangle adjacency is built once per floor here, not per route call — see
    // WFNavmesh.prepareFloorMesh. Missing/empty for a floor just means that floor keeps the
    // existing sweep-graph line (map_legs() below falls back automatically).
    navmeshByFloor = {};
    if (navmeshData && navmeshData.floors && window.WFNavmesh) {
      for (const F of Object.keys(navmeshData.floors)) {
        navmeshByFloor[F] = WFNavmesh.prepareFloorMesh(navmeshData.floors[F]);
      }
    }
    return WF;
  };
  WF.nodes = () => nodes;

  // Soft penalty so A* prefers edges aimed at the destination (same floor, non-transition).
  // Tradeoff: may pick a slightly longer corridor that points at dest over a short zig-zag of scan neighbours.
  // Stairs / elevators / cross-floor edges keep raw cost (never re-weighted here).
  const DEST_ALIGN_WEIGHT = 0.12;

  // ---------- A* ----------
  WF.route = function (fromId, toId, opts = {}) {
    const stepFree = !!opts.stepFree;
    const dest = nodes[toId];
    const alignW = (opts.destAlignWeight != null) ? +opts.destAlignWeight : DEST_ALIGN_WEIGHT;
    const finder = ngraphPath.aStar(graph, {
      oriented: false,
      distance(a, b, link) {
        let c = link.data.cost;
        if (alignW > 0 && dest && a.data && b.data
            && a.data.floor === b.data.floor
            && !link.data.stairs && !link.data.cross_floor && !isElevator(link)) {
          const dx = b.data.x - a.data.x, dy = b.data.y - a.data.y;
          const len = Math.hypot(dx, dy);
          const tx = dest.x - a.data.x, ty = dest.y - a.data.y;
          const tlen = Math.hypot(tx, ty);
          if (len > 0.05 && tlen > 0.5) {
            const cos = (dx * tx + dy * ty) / (len * tlen);
            c += (1 - cos) * alignW * len;   // 0 when aligned; up to ~2*alignW*len when reverse
          }
        }
        return c;
      },
      heuristic(a, b) { const p = a.data, q = b.data; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); },
      blocked(a, b, link) { return stepFree && !link.data.step_free; }
    });
    const path = finder.find(fromId, toId);           // ngraph.path returns end -> start
    if (!path || path.length === 0 || (path.length === 1 && fromId !== toId)) return null;
    const ids = path.map(n => n.id).reverse();
    const links = [];
    for (let i = 0; i < ids.length - 1; i++) links.push(graph.getLink(ids[i], ids[i + 1]) || graph.getLink(ids[i + 1], ids[i]));
    return buildResult(ids, links, opts);
  };

  // ---------- line-of-sight smoothing on the walk grid ----------
  function cell(F, x, y) {
    const i = Math.floor((x - grid.x0) / grid.res), j = Math.floor((y - grid.y0) / grid.res);
    if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return null;
    const k = j * grid.nx + i; return { w: walk[F][k], z: zcm[F][k] };
  }
  function los(F, p, q) {
    const d = Math.hypot(q.x - p.x, q.y - p.y), n = Math.max(2, Math.ceil(d / 0.1));
    let zprev = null;
    for (let s = 0; s <= n; s++) {
      const t = s / n, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
      const endZone = (t * d < 0.4) || ((1 - t) * d < 0.4);   // sweep spots can be unscanned (tripod) -> tolerate ends
      const c = cell(F, x, y);
      if (!c || c.w !== 1) { if (endZone) continue; return false; }
      const z = c.z / 100; if (zprev !== null && Math.abs(z - zprev) > 0.25) return false; zprev = z;
    }
    return true;
  }
  WF.los = los;
  function hasGraphEdge(aId, bId) {
    if (!aId || !bId || !graph) return false;
    return !!(graph.getLink(aId, bId) || graph.getLink(bId, aId));
  }
  /** cos of turn at b for a→b→c; 1 = straight, -1 = uturn. */
  function turnCos(a, b, c) {
    const dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = c.x - b.x, dy2 = c.y - b.y;
    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
    if (l1 < 0.05 || l2 < 0.05) return 1;
    return (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
  }
  /** Graph+collinear fallback when walk-grid LOS fails (dense scan zig-zag in open corridor). */
  function collinearGraphSkip(pts, i, k, cosMin) {
    for (let m = i; m < k; m++) {
      if (!hasGraphEdge(pts[m].id, pts[m + 1].id)) return false;
    }
    for (let m = i + 1; m < k; m++) {
      if (turnCos(pts[m - 1], pts[m], pts[m + 1]) < cosMin) return false;
    }
    return true;
  }
  const COLLINEAR_COS = 0.92; // ~23° max turn to treat as collinear shortcut
  function canShortcut(pts, i, k) {
    if (pts[k].floor !== pts[i].floor) return false;
    for (let m = i + 1; m < k; m++) {
      if (pts[m].hard || pts[m].floor !== pts[i].floor) return false;
    }
    if (walk[pts[i].floor] && los(pts[i].floor, pts[i], pts[k])) return true;
    return collinearGraphSkip(pts, i, k, COLLINEAR_COS);
  }
  function smooth(pts) {        // pts: [{x,y,z,floor,hard}] ; hard points are never removed
    if (pts.length <= 2) return pts.slice();
    const out = [pts[0]]; let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      for (let k = pts.length - 1; k > i + 1; k--) {
        if (canShortcut(pts, i, k)) { j = k; break; }
      }
      out.push(pts[j]); i = j;
    }
    return out;
  }

  // ---------- result + instructions ----------
  function buildResult(ids, links, opts) {
    const seq = ids.map(id => nodes[id]);
    let total = 0, time = 0, rise = 0, walkLen = 0;
    const cm = (nav && nav.cost_model) || {};
    const waitS = cm.elevator_wait_s != null ? cm.elevator_wait_s : ELEVATOR_WAIT_S;
    const perFloorS = cm.elevator_per_floor_s != null ? cm.elevator_per_floor_s : ELEVATOR_PER_FLOOR_S;
    links.forEach((l, i) => {
      total += l.data.length;
      if (l.data.stairs) { rise += l.data.dz; time += l.data.dz * 2.0; walkLen += l.data.length; }
      else if (isElevator(l)) { time += waitS + perFloorS * elevFloorDelta(l, seq[i], seq[i + 1]); }
      else walkLen += l.data.length;
    });
    time += walkLen / WALK_MPS;
    // hard points: ends, stair/elevator edge endpoints, OSM nodes, door nodes of entrances
    const pts = seq.map((n, i) => ({ id: n.id, x: n.x, y: n.y, z: n.z, floor: n.floor, kind: n.kind, label: n.label,
      outdoor: !n.indoor && n.kind !== 'door' || n.kind === 'osm', hard: i === 0 || i === seq.length - 1 || n.kind === 'osm' || (n.kind === 'door' && n.exterior) }));
    links.forEach((l, i) => {
      if (l.data.stairs || l.data.cross_floor || isElevator(l) || l.data.source === 'elevator') {
        pts[i].hard = true; pts[i + 1].hard = true;
        // Tour uses sweeps only — keep nearest sweep on each side so FLY never jumps across stairs/elevators.
        for (let j = i; j >= 0; j--) {
          if (pts[j].kind === 'sweep') { pts[j].hard = true; break; }
        }
        for (let j = i + 1; j < pts.length; j++) {
          if (pts[j].kind === 'sweep') { pts[j].hard = true; break; }
        }
      }
    });
    const smFull = smooth(pts);
    // Shared geometric path for map polyline, legs, instructions, AND Tour:
    // keep sweeps + hard pts (ends / OSM / exterior doors / stair+elev endpoints). Drop soft
    // interior door detours so Directions turns match Sweep.moveTo chords (path2).
    // hopDoors[i] = interior doors that sat on smFull between sm[i] and sm[i+1] (announce, no turn bend).
    const sm = [];
    const hopDoors = [];
    let doorBuf = [];
    for (const p of smFull) {
      if (p.kind === 'sweep' || p.hard) {
        if (sm.length) hopDoors.push(doorBuf);
        doorBuf = [];
        if (!sm.length || sm[sm.length - 1].id !== p.id) sm.push(p);
      } else if (p.kind === 'door') {
        doorBuf.push(p);
      }
    }
    if (sm.length < 2) { sm.length = 0; hopDoors.length = 0; for (const p of smFull) sm.push(p); } // safety
    // Tour / Showcase: move along *shortcut* sweeps (LOS or collinear graph), not every A* neighbour hop.
    // Raw A* sweep list kept as sweep_ids_raw for debug. Hard pts (stairs/elevators/ends) never skipped.
    const sweepIdsRaw = seq.filter(n => n.kind === 'sweep').map(n => n.id);
    const sweepIdsTour = [];
    for (const p of sm) {
      if (p.kind === 'sweep' && p.id && (!sweepIdsTour.length || sweepIdsTour[sweepIdsTour.length - 1] !== p.id)) {
        sweepIdsTour.push(p.id);
      }
    }
    // legs: group consecutive segments by (floor, outdoor); a floor-changing segment is its own 'transition' leg
    const legsClean = [];
    for (let i = 0; i < sm.length - 1; i++) {
      const p = sm[i], q = sm[i + 1];
      const lf = p.floor === q.floor ? p.floor : 'T', od = !!(p.outdoor && q.outdoor);
      const last = legsClean[legsClean.length - 1];
      if (last && last.floor === lf && last.outdoor === od) last.points.push(q);
      else legsClean.push({ floor: lf, outdoor: od, transition: lf === 'T', toFloor: q.floor, points: [p, q] });
    }
    // Map-only cosmetic pass: re-route each same-floor leg's line across that floor's navmesh
    // (a continuous walkable surface) instead of the raw sweep-point-to-sweep-point segments,
    // so the drawn line flows through open space like a real path instead of visibly hopping
    // between scan positions. Only touches legsClean[].points (what app.js draws) — sm itself
    // (Tour/Showcase sweep sequence, turn-by-turn instructions) is never modified, since
    // Showcase can only fly between real sweeps, not arbitrary navmesh points. Falls back to
    // the existing segment untouched whenever the navmesh doesn't confidently connect the
    // leg's endpoints (no navmesh for that floor, or a genuine gap in scan coverage) — see
    // navmesh_route.js for why that fallback exists and is the safe default.
    if (window.WFNavmesh) {
      for (const leg of legsClean) {
        if (leg.transition || leg.points.length < 2) continue;
        const mesh = navmeshByFloor[leg.floor];
        if (!mesh) continue;
        const first = leg.points[0], last2 = leg.points[leg.points.length - 1];
        const meshPts = WFNavmesh.routeOnMesh(mesh, [first.x, first.y], [last2.x, last2.y]);
        if (!meshPts || meshPts.length < 2) continue;
        const fullLen = Math.hypot(last2.x - first.x, last2.y - first.y) || 1;
        const mid = meshPts.slice(1, -1).map(([x, y]) => {
          const t = Math.max(0, Math.min(1, Math.hypot(x - first.x, y - first.y) / fullLen));
          return { x, y, z: first.z + (last2.z - first.z) * t, floor: leg.floor, outdoor: leg.outdoor };
        });
        leg.points = [first, ...mid, last2];
      }
    }
    return {
      from: ids[0], to: ids[ids.length - 1], stepFree: !!opts.stepFree,
      total_m: total, time_s: time, stairs_rise_m: rise,
      sweep_ids: sweepIdsTour.length ? sweepIdsTour : sweepIdsRaw,  // shortcut sequence for Sweep.moveTo
      sweep_ids_raw: sweepIdsRaw,
      nodes: seq.map(n => ({ id: n.id, kind: n.kind, label: n.label, floor: n.floor, x: n.x, y: n.y, z: n.z, lonlat: n.lonlat })),
      links: links.map(l => ({
        u: l.fromId, v: l.toId, length: l.data.length, stairs: l.data.stairs, step_free: l.data.step_free,
        source: l.data.source || 'matterport', elevator: l.data.elevator || null
      })),
      smoothed: sm.map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, floor: p.floor, outdoor: p.outdoor })),
      legs: legsClean,
      // Flattened version of legsClean[].points: the same navmesh-smoothed walkable-surface
      // path drawn on the map (see legsClean construction above), as a single ordered point
      // list for consumers that walk the route continuously (3D fly-through, live position
      // simulation) rather than draw it leg-by-leg. Dedupes the shared point at each leg
      // boundary. Falls back to `sm` (raw sweep sequence) if navmesh re-routing never ran
      // (no WFNavmesh / no per-floor mesh), since legsClean.points is then just `sm` unchanged.
      navPath: legsClean.reduce((out, leg) => {
        const pts = leg.points;
        for (let i = 0; i < pts.length; i++) {
          if (i === 0 && out.length && out[out.length - 1].x === pts[0].x && out[out.length - 1].y === pts[0].y && out[out.length - 1].floor === pts[0].floor) continue;
          out.push({ x: pts[i].x, y: pts[i].y, z: pts[i].z, floor: pts[i].floor, outdoor: pts[i].outdoor });
        }
        return out;
      }, []),
      instructions: instructions(seq, links, sm, hopDoors)
    };
  }

  function instructions(seq, links, sm, hopDoors) {
    const out = [];
    const toLL = WF.modelToLL;
    const floorName = F => (nav.floors[F] || {}).label || F;
    // events on graph links: stairs, elevators, entrances
    const events = {}; let stairRun = null;
    links.forEach((l, i) => {
      const a = seq[i], b = seq[i + 1];
      if (l.data.stairs) {
        const up = b.z > a.z, name = l.data.stairs === 'stair_porch' ? 'porch steps' : (l.data.stairs === 'stair_north' ? 'north stairs' : 'steps');
        const prev = i > 0 && links[i - 1].data.stairs === l.data.stairs && (seq[i].z > seq[i - 1].z) === up ? stairRun : null;
        const run = prev || { startId: a.id, name, up, rise: 0, fromFloor: a.floor };
        run.rise += Math.abs(b.z - a.z); run.toFloor = b.floor; stairRun = run;
        const txt = (run.fromFloor !== run.toFloor ? `Take the ${name} ${up ? 'up' : 'down'} to ${floorName(run.toFloor)}` : `Take the ${name} ${up ? 'up' : 'down'}`) + ` (${run.rise.toFixed(1)} m ${up ? 'rise' : 'drop'})`;
        events[run.startId] = { txt, type: 'stairs', floor: b.floor };
      } else stairRun = null;
      if (isElevator(l)) {
        const name = elevName(l.data);
        const dest = floorName(b.floor);
        const txt = (name && name !== 'elevator') ? `Take ${name} to ${dest}` : `Take the elevator to ${dest}`;
        events[a.id] = { txt, type: 'elevator', floor: b.floor };
      } else if (!l.data.stairs && a.floor !== b.floor) {
        events[a.id] = { txt: `Continue ${b.z > a.z ? 'up' : 'down'} the slope onto ${floorName(b.floor)} level`, type: 'level' };
      }
      if (b.kind === 'door') { const what = (b.door_type || '').includes('inferred') ? 'opening' : 'door';
        events[b.id] = { txt: b.exterior ? `${a.indoor ? 'Exit' : 'Enter'} the building through the ${what}` : `Go through the ${what}`, type: 'door' }; }
    });
    function flushEvent(ev, pt) {
      if (acc > 0.5) out.push({ type: 'walk', text: `Walk ${Math.round(acc)} m`, dist: acc });
      acc = 0;
      out.push({ type: ev.type, text: ev.txt, pt: { x: pt.x, y: pt.y, z: pt.z, floor: pt.floor }, toFloor: ev.floor });
    }
    let acc = 0, prevBrg = null;
    out.push({ type: 'start', text: `Start at ${seq[0].label}${seq[0].kind === 'sweep' ? ' (' + floorName(seq[0].floor) + ')' : ''}`, pt: { x: sm[0].x, y: sm[0].y, z: sm[0].z, floor: sm[0].floor } });
    for (let i = 0; i < sm.length - 1; i++) {
      const p = sm[i], q = sm[i + 1];
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const a = toLL(p.x, p.y), b = toLL(q.x, q.y);
      const brg = d > 0.3 ? turf.bearing(turf.point(a), turf.point(b)) : prevBrg;
      if (events[p.id]) flushEvent(events[p.id], p);
      else if (prevBrg !== null && brg !== null && i > 0) {
        let t = ((brg - prevBrg + 540) % 360) - 180;
        const at = Math.abs(t);
        if (at >= 25) {
          if (acc > 0.5) out.push({ type: 'walk', text: `Walk ${Math.round(acc)} m`, dist: acc }); acc = 0;
          const side = t > 0 ? 'right' : 'left';
          out.push({ type: 'turn', text: at > 150 ? 'Turn around' : (at < 60 ? `Bear ${side}` : `Turn ${side}`), dir: at > 150 ? 'uturn' : (at < 60 ? 'slight-' + side : side), pt: { x: p.x, y: p.y, z: p.z, floor: p.floor } });
        }
      }
      // Interior doors that rode on LOS-smoothed path but were dropped from Tour geometry.
      const doors = (hopDoors && hopDoors[i]) || [];
      for (const dp of doors) {
        const ev = events[dp.id];
        if (ev && ev.type === 'door') flushEvent(ev, dp);
      }
      acc += d; if (brg !== null) prevBrg = brg;
    }
    if (events[sm[sm.length - 1].id] && events[sm[sm.length - 1].id].type === 'door') flushEvent(events[sm[sm.length - 1].id], sm[sm.length - 1]);
    if (acc > 0.5) out.push({ type: 'walk', text: `Walk ${Math.round(acc)} m`, dist: acc });
    out.push({ type: 'arrive', text: `Arrive at ${seq[seq.length - 1].label}`, pt: { x: sm[sm.length - 1].x, y: sm[sm.length - 1].y, z: sm[sm.length - 1].z, floor: sm[sm.length - 1].floor } });
    return out;
  }

  // ---------- snapping ----------
  WF.snap = function (x, y, floor) {
    let best = null, bd = 1e9;
    for (const n of Object.values(nodes)) {
      if (n.kind === 'osm' && !n.id.startsWith('osm')) continue;
      const okFloor = n.floor === floor || (!n.indoor && n.kind !== 'door');
      if (!okFloor || n.kind === 'door' && n.leads_to_unscanned) continue;
      const d = Math.hypot(n.x - x, n.y - y) + (n.floor === floor ? 0 : 2);
      if (d < bd) { bd = d; best = n; }
    }
    return best ? { node: best, dist: bd } : null;
  };
  window.WFRouting = WF;
})();
