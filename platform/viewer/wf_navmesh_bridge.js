/* Bridges the pure-Recast navmesh router into the public viewer, as window.WFNav.
 *
 * WFRouting.route() is the old sweep-graph router (ngraph over doors/corridors/stairs).
 * WFNav.routeNavmesh() below computes the route ONLY on the building's Recast navmesh —
 * the same mesh and the same computePath the AR app uses — and then shapes the result
 * so the viewer's existing map-drawing code can consume it unchanged.
 *
 * The navmesh path is never modified to fit that shape: floors are assigned by reading
 * each point's height, and lon/lat is a straight projection of the point. Guidance is
 * derived afterwards and cannot feed back into the geometry.
 */
(function () {
  "use strict";
  // Own namespace: window.WF is the viewer's app object (created later by wf-boot.js),
  // so attaching here would be silently overwritten.
  var WF = window.WFNav = window.WFNav || {};
  var cfg = null;          // { floors:[{id,label,elevation}], modelToLL(x,y) }
  var ready = false;

  /** slug: building slug. opts.modelToLL(x, y) -> [lon, lat]. opts.floors as above. */
  WF.initNavmesh = async function (slug, opts) {
    opts = opts || {};
    cfg = { floors: opts.floors || [], modelToLL: opts.modelToLL,
            levelYs: opts.levelYs || [], sweeps: opts.sweeps || [] };
    var r = await fetch("/api/v1/public/dashboard/buildings/" + encodeURIComponent(slug) + "/navmesh-url",
                        { headers: opts.headers || {} });
    if (!r.ok) throw new Error("no navmesh for " + slug + " (" + r.status + ")");
    var nm = await r.json();
    await window.WFNavmeshRoute.load(nm.url, slug);
    ready = true;
    return nm;
  };

  WF.navmeshReady = function () { return ready; };

  /**
   * Route between two {x,y,z} Matterport-SDK points, purely on the navmesh.
   * Returns the viewer-shaped result plus `steps` (turn-by-turn) and the raw `path`.
   */
  WF.routeNavmesh = function (from, to) {
    if (!ready) return null;
    var r = window.WFNavmeshRoute.route(from, to);
    if (!r.ok) return { error: r.error };

    var floors = (cfg && cfg.floors) || [];
    var toLL = cfg && cfg.modelToLL;
    // SDK is Y-up; model space is Z-up and the mapping for this building is
    // model = (x, -z, y). The y negation matters: without it the route lands south of
    // the building instead of inside it (verified against the POI footprint).
    var pts = r.path.map(function (p) {
      var f = window.WFNavmeshRoute.floorAt(p.y, floors);
      return { x: p.x, y: -p.z, z: p.y, floor: f ? f.id : null,
               lonlat: toLL ? toLL(p.x, -p.z) : null };
    });

    // ONE leg holding every point. Splitting per floor meant the map drew only the
    // leg for the active floor, which visually cut the route in half. The route is a
    // single continuous path on one navmesh and is always drawn whole; floor is left
    // null so no floor filter can drop it.
    var legs = [{ floor: null, outdoor: false, points: pts }];

    var steps = window.WFNavmeshRoute.guidance(r.path, {
      floors: floors, levelYs: (cfg && cfg.levelYs) || [],
      sweeps: (cfg && cfg.sweeps) || []     // nearest Matterport sweep per step
    });

    return {
      source: "navmesh",
      total_m: r.length_m,
      time_s: Math.round(r.length_m / 1.35),
      legs: legs,
      navPath: pts,
      smoothed: pts,
      nodes: pts,
      links: [],
      sweep_ids: [],            // not derivable from the mesh; tour nav falls back
      steps: steps,
      path: r.path,
      start_gap_m: r.start_gap_m, end_gap_m: r.end_gap_m, partial: r.partial
    };
  };
})();
