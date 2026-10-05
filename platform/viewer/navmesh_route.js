/* Navmesh pathfinding: A* over triangle adjacency + the Simple Stupid Funnel Algorithm.
   JS port of wfpipe/navmesh_route.py (api/pipeline, server-side) — same algorithm, same safety
   fixes, kept in sync by hand since the two runtimes don't share code. See that file's header
   for the full rationale (why a navmesh instead of the sweep graph, what the clamping guards
   against). Mesh data comes from out/navmesh.json (built by wfpipe.steps.navmesh): per floor,
   {"verts": [[x,y],...], "tris": [[i,j,k],...]}. This module does no I/O. */
(function () {
  function centroid(verts, tri) {
    const a = verts[tri[0]], b = verts[tri[1]], c = verts[tri[2]];
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  }
  function sign(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }
  function pointInTriangle(px, py, verts, tri) {
    const a = verts[tri[0]], b = verts[tri[1]], c = verts[tri[2]];
    const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
    const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
    const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0, hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }
  function nearestPointOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    return [ax + dx * t, ay + dy * t];
  }
  function nearestPointOnTriangle(px, py, verts, tri) {
    const a = verts[tri[0]], b = verts[tri[1]], c = verts[tri[2]];
    let best = null, bestD = Infinity;
    for (const [p1, p2] of [[a, b], [b, c], [c, a]]) {
      const q = nearestPointOnSegment(px, py, p1[0], p1[1], p2[0], p2[1]);
      const d = (q[0] - px) ** 2 + (q[1] - py) ** 2;
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }
  function findTriangle(px, py, verts, tris) {
    for (let i = 0; i < tris.length; i++) {
      if (pointInTriangle(px, py, verts, tris[i])) return { tri: i, exact: true };
    }
    if (!tris.length) return { tri: null, exact: false };
    let bestI = null, bestD = Infinity;
    for (let i = 0; i < tris.length; i++) {
      const c = centroid(verts, tris[i]);
      const d = (c[0] - px) ** 2 + (c[1] - py) ** 2;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return { tri: bestI, exact: false };
  }
  function buildAdjacency(tris) {
    const edgeOwner = new Map();
    const key = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
    tris.forEach((tri, i) => {
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3], k = key(a, b);
        if (!edgeOwner.has(k)) edgeOwner.set(k, []);
        edgeOwner.get(k).push(i);
      }
    });
    const neighbours = tris.map(() => [null, null, null]);
    tris.forEach((tri, i) => {
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        const owners = (edgeOwner.get(key(a, b)) || []).filter(o => o !== i);
        if (owners.length) neighbours[i][e] = owners[0];
      }
    });
    return neighbours;
  }
  function astarTriangles(tris, verts, neighbours, startTri, goalTri) {
    if (startTri === goalTri) return [startTri];
    const goalC = centroid(verts, tris[goalTri]);
    const h = i => { const c = centroid(verts, tris[i]); return Math.hypot(c[0] - goalC[0], c[1] - goalC[1]); };
    const open = [[h(startTri), 0, startTri]];
    const cameFrom = new Map(), gScore = new Map([[startTri, 0]]), visited = new Set();
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [, g, cur] = open.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      if (cur === goalTri) {
        const path = [cur]; let c = cur;
        while (cameFrom.has(c)) { c = cameFrom.get(c); path.push(c); }
        return path.reverse();
      }
      const cc = centroid(verts, tris[cur]);
      for (const nb of neighbours[cur]) {
        if (nb === null || visited.has(nb)) continue;
        const nc = centroid(verts, tris[nb]);
        const ng = g + Math.hypot(nc[0] - cc[0], nc[1] - cc[1]);
        if (ng < (gScore.has(nb) ? gScore.get(nb) : Infinity)) {
          gScore.set(nb, ng); cameFrom.set(nb, cur);
          open.push([ng + h(nb), ng, nb]);
        }
      }
    }
    return null;
  }
  function sharedEdge(triA, triB) {
    const shared = triA.filter(v => triB.includes(v));
    return shared.length === 2 ? shared : null;
  }
  function triarea2(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay); }
  function eq(p, q) { return p[0] === q[0] && p[1] === q[1]; }
  function funnel(start, goal, portals) {
    const path = [start];
    let apex = start, left = portals[0][0], right = portals[0][1];
    let apexI = 0, leftI = 0, rightI = 0;
    let i = 1;
    while (i < portals.length) {
      const pl = portals[i][0], pr = portals[i][1];
      if (triarea2(apex[0], apex[1], right[0], right[1], pr[0], pr[1]) <= 0) {
        if (eq(apex, right) || triarea2(apex[0], apex[1], left[0], left[1], pr[0], pr[1]) > 0) {
          right = pr; rightI = i;
        } else {
          path.push(left);
          apex = left; apexI = leftI;
          left = apex; right = apex; leftI = rightI = apexI;
          i = apexI + 1;
          continue;
        }
      }
      if (triarea2(apex[0], apex[1], left[0], left[1], pl[0], pl[1]) >= 0) {
        if (eq(apex, left) || triarea2(apex[0], apex[1], right[0], right[1], pl[0], pl[1]) < 0) {
          left = pl; leftI = i;
        } else {
          path.push(right);
          apex = right; apexI = rightI;
          left = apex; right = apex; leftI = rightI = apexI;
          i = apexI + 1;
          continue;
        }
      }
      i++;
    }
    path.push(goal);
    const out = [path[0]];
    for (let k = 1; k < path.length; k++) if (!eq(path[k], out[out.length - 1])) out.push(path[k]);
    return out;
  }

  /** Build and cache triangle adjacency once per floor mesh (routing.js calls this at init,
      not per route — rebuilding per request would be wasted work for an interactive viewer). */
  function prepareFloorMesh(floorMesh) {
    if (!floorMesh || !floorMesh.verts || !floorMesh.tris || !floorMesh.tris.length) return null;
    return { verts: floorMesh.verts, tris: floorMesh.tris, neighbours: buildAdjacency(floorMesh.tris) };
  }

  const MAX_SNAP_DIST = 3.0;

  /** prepared: output of prepareFloorMesh(). Returns [[x,y],...] or null. */
  function routeOnMesh(prepared, startXY, goalXY) {
    if (!prepared) return null;
    const { verts, tris, neighbours } = prepared;
    let start = startXY, goal = goalXY;
    const sf = findTriangle(start[0], start[1], verts, tris);
    const gf = findTriangle(goal[0], goal[1], verts, tris);
    if (sf.tri === null || gf.tri === null) return null;
    // Non-exact snaps must never keep the raw input coordinate in the output geometry: it can
    // sit on the wrong side of a wall from the triangle it snapped to, and a straight line
    // from there would cut through that wall. Clamp onto the snapped triangle's own boundary;
    // if even that is implausibly far, the "nearest" triangle is an unrelated fragment on a
    // sparse mesh, not a real snap — give up and let the caller fall back to the sweep graph.
    if (!sf.exact) {
      const c = nearestPointOnTriangle(start[0], start[1], verts, tris[sf.tri]);
      if (Math.hypot(c[0] - start[0], c[1] - start[1]) > MAX_SNAP_DIST) return null;
      start = c;
    }
    if (!gf.exact) {
      const c = nearestPointOnTriangle(goal[0], goal[1], verts, tris[gf.tri]);
      if (Math.hypot(c[0] - goal[0], c[1] - goal[1]) > MAX_SNAP_DIST) return null;
      goal = c;
    }
    if (sf.tri === gf.tri) return [start, goal];
    const triPath = astarTriangles(tris, verts, neighbours, sf.tri, gf.tri);
    if (!triPath) return null;
    const portals = [[start, start]];
    for (let k = 0; k < triPath.length - 1; k++) {
      const edge = sharedEdge(tris[triPath[k]], tris[triPath[k + 1]]);
      if (!edge) return null; // adjacency inconsistency — safe sweep-graph fallback upstream
      let l = verts[edge[0]], r = verts[edge[1]];
      const c = centroid(verts, tris[triPath[k]]);
      if (triarea2(c[0], c[1], l[0], l[1], r[0], r[1]) < 0) { const t = l; l = r; r = t; }
      portals.push([l, r]);
    }
    portals.push([goal, goal]);
    return funnel(start, goal, portals);
  }

  window.WFNavmesh = { prepareFloorMesh, routeOnMesh };
})();
