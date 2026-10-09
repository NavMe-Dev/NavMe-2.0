/* threed_nav.js — Hybrid Walkthrough Navigation overlay for the public viewer.
   Route comes from the map (no From/To pickers needed here).
   Hybrid = Dijkstra across Matterport scan-point graph + dot trail + stair repair.
   Exposes window.ThreeDNav = { open(route), close() }. */
(function () {
  "use strict";

  const SDK_BOOTSTRAP = "https://static.matterport.com/showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js";
  const OVERLAY_ID   = "n3dOverlay";
  const CROP_TOP_PX  = 56;

  // Trail constants
  const EYE_HEIGHT_M   = 1.5;
  const DOT_SPACING_M  = 0.55;
  const DOT_HEIGHT_M   = 0.06;
  const VISIBLE_M      = 12;
  /**
   * Safety bound on resampled trail points, not a display budget.
   *
   * Only the VISIBLE_M window around the camera is ever projected and painted,
   * so the cost of a long trail is bounded by the window, not by this number.
   * At 320 the cap bit at ~176m and silently truncated the far end of a long
   * route — the dots just stopped, and the distance stopped with them.
   */
  const DOT_CAP        = 4000;
  const SAME_FLOOR_M   = 1.2;
  const STAIR_RISE_MAX = 0.45;
  const STAIR_RUN_MAX  = 4;
  const TRAIL_FILL     = "rgba(24,40,88,0.95)";
  const DEST_PIN       = "#182858";

  // Routing constants (ported from threednavigation.ts)
  const HOP_EXPONENT            = 1.35;
  const FLOOR_STEP_M            = 0.35;
  const TELEPORT_HOP_M          = 2.5;
  const TELEPORT_DETOUR_MAX     = 1.35;
  const LEVEL_CHANGE_DETOUR_MAX = 8;
  /**
   * Rise-over-run below which a height change is a SLOPE, not a staircase.
   *
   * `dy > FLOOR_STEP_M` alone cannot tell the two apart, and outdoors that is
   * fatal: this campus walkway climbs ~0.4m over a 13.7m hop (a 3% grade), which
   * tripped the stair branch and handed the hop to planLegMostScanPoints — the
   * planner whose entire job is to cover as MANY scan points as possible — with
   * a direct*8 budget of 110m. It did exactly that, wandering the basketball
   * court and back. Real treads run ~0.6 rise/run and a scanned flight ~0.5, so
   * 0.25 separates them with room to spare.
   */
  const STAIR_MIN_GRADE = 0.25;
  /**
   * Hard ceiling on how far a stair repair may add over the chord it replaces.
   * direct*8 is sane for a 3m chord across a flight; on a long hop it authorises
   * a detour longer than the whole route.
   */
  const LEVEL_CHANGE_DETOUR_ABS_M = 25;
  const LEVEL_CHANGE_IMPROVEMENT= 1.05;
  const LANDING_MAX_M           = 5;
  const FACE_MIN_AHEAD_M        = 1.2;
  const FACE_TARGET_FRAC        = 0.75;
  const FACE_VFOV_DEG           = 60;
  const FACE_SCREEN_BIAS_DEG    = (Math.atan(2*(FACE_TARGET_FRAC-0.5)*Math.tan(FACE_VFOV_DEG/2*Math.PI/180))*180)/Math.PI;
  const FACE_MIN_PITCH_DEG      = -58;
  const ARRIVE_RADIUS_M         = 2;
  const LEG_ARRIVE_M            = 3;

  // Module state
  let mpSdk = null, sdkPromise = null, openGen = 0;
  let sweepCollection = null, unsubSweepData = null;
  let sweeps = [];                // {sid, position:{x,y,z}, neighbours:[sid], floor:n}
  let routeSids = [];             // solved route as sweep id sequence
  // Declared staircases (NavMe Dashboard's navme_stair_chains table), as ordered runs of
  // sweep ids, lowest step first. setStairChainRows() stores the raw {sweep_numbers}
  // rows as soon as they're fetched; resolveStairChains() turns the numbers (Sweep.data
  // collection indices) into sids once `sweeps` exists, since the two can arrive in
  // either order. A building with no declared chains simply has none, and routing falls
  // back to the geometric stair planner (STAIR_MIN_GRADE etc.) exactly as before.
  let stairChains = [];
  // sid -> chain index, O(1) membership for hopCost() (called on every edge relaxation,
  // for every step the user takes — an indexOf() scan per chain per call was measurable).
  let stairChainIndexBySid = null;
  let pendingStairChainRows = null;
  let routeLegs = [];             // [{kind:"walk"|"stairs", points:[Vec3]}]
  let activeLeg = 0;
  let navPts = [];                // resampled Vec3 for active leg
  let lastPose = null, currentSweepSid = null;
  // The sweep the camera was standing on immediately before currentSweepSid — used by
  // onReachedWalkStop()'s loop guard to reject a freshly re-solved route whose very
  // first hop would send the user straight back the way they just came (see the
  // module comment above onReachedWalkStop for the "stuck rotating in a loop" bug
  // this is guarding against).
  let prevSweepSid = null;
  // Destination sweep id for the active route — set once in runNavigate(), reused by
  // every re-solve so a regenerated route always still aims at the real destination.
  let destSweepSid = null;
  // onReachedWalkStop() loop guard — see its call site for what this catches. Tracks
  // the last scan point it was asked to re-plan from and how many times in a row that
  // was the SAME point with no real movement in between.
  let noProgressSid = null, noProgressCount = 0;
  let drawRaf = 0, unsubPose = null, unsubSweep = null;
  let modelId = "", appKey = "";
  let destPtMp = null;            // destination in MP Y-up (for pin drawing)
  let destName = "";
  /** True once the arrival card has been shown for the current route. */
  let arrivedShown = false;
  /**
   * True from the moment the first route is planned until the camera has
   * actually settled on its start sweep.
   *
   * Showcase emits a Sweep.current for its OWN default start point, and that
   * event can land AFTER the route is planted. Without this guard the watcher
   * sees an id that is not on the route and "repairs" it by re-planning from
   * the default position — silently replacing the correct Basketball-Court
   * route with one starting 100m away, which is what put the dots on the
   * horizon and the distance at 60m instead of the full route.
   */
  let navLocked = false;
  /** Full navPath for the active route, in Matterport Y-up coords. Set by open(). */
  let navPathMp = [];

  // ── Coord conversion: NavMe Z-up → Matterport Y-up ─────────────────────────
  function toMp(p) { return { x: +p.x, y: +(p.z || 0), z: -(+p.y) }; }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function collectionEntries(col) {
    var out = [];
    if (!col) return out;
    if (typeof col.forEach === "function") { col.forEach(function(v){ out.push(v); }); return out; }
    if (Array.isArray(col)) return col.slice();
    if (typeof col === "object") { for (var k in col) out.push(col[k]); }
    return out;
  }

  // ── Overlay DOM ─────────────────────────────────────────────────────────────
  function ensureOverlay() {
    if ($(OVERLAY_ID)) return;
    var style = document.createElement("style");
    style.textContent = [
      "#n3dOverlay{position:fixed;inset:0;z-index:9000;background:#000;display:flex;flex-direction:column}",
      "#n3dOverlay[hidden]{display:none!important}",
      "#n3dOverlay .n3d-stage{position:relative;flex:1 1 auto;overflow:hidden}",
      "#n3dOverlay iframe{position:absolute;left:0;width:100%;",
        "top:calc(-1 * " + CROP_TOP_PX + "px);",
        "height:calc(100% + " + CROP_TOP_PX + "px + 64px);border:none}",
      "#n3dOverlay .n3d-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;background:transparent}",
      "#n3dOverlay .n3d-bar{position:absolute;top:0;left:0;right:0;z-index:10;",
        "display:flex;align-items:center;gap:8px;padding:8px 12px;",
        "padding-top:calc(8px + env(safe-area-inset-top,0px));",
        "background:linear-gradient(180deg,rgba(0,0,0,.55),transparent);pointer-events:none}",
      "#n3dOverlay .n3d-bar>*{pointer-events:auto}",
      "#n3dOverlay .n3d-close{display:inline-flex;align-items:center;gap:8px;height:40px;",
        "padding:0 14px 0 6px;border-radius:999px;border:0;",
        "background:rgba(255,255,255,.92);color:#111;cursor:pointer;font:inherit;",
        "font-size:14px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.18)}",
      "#n3dOverlay .n3d-title{color:#fff;font-size:14px;font-weight:600;",
        "font-family:-apple-system,system-ui,sans-serif;flex:1;padding-left:4px;",
        "text-shadow:0 1px 3px rgba(0,0,0,.5)}",
      "#n3dOverlay .n3d-locate{display:inline-flex;align-items:center;gap:6px;height:40px;",
        "padding:0 14px;border-radius:999px;border:0;white-space:nowrap;",
        "background:#182858;color:#fff;cursor:pointer;font:inherit;",
        "font-size:13px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25)}",
      "#n3dOverlay .n3d-locate:disabled{opacity:.55;cursor:default}",
      "#n3dOverlay .n3d-status{position:absolute;top:72px;left:50%;transform:translateX(-50%);",
        "background:rgba(0,0,0,.7);color:#fff;border-radius:8px;padding:8px 16px;",
        "font-size:13px;font-weight:500;white-space:nowrap;pointer-events:none;",
        "font-family:-apple-system,system-ui,sans-serif;z-index:11}",
      "#n3dOverlay .n3d-status[hidden]{display:none!important}",
      "#n3dOverlay .n3d-dock{position:absolute;left:50%;transform:translateX(-50%);z-index:8;",
        "bottom:calc(14px + env(safe-area-inset-bottom,0px));",
        "width:min(400px,calc(100% - 24px));box-sizing:border-box;",
        "display:flex;align-items:center;justify-content:center;gap:12px;",
        "padding:10px 16px;border-radius:20px;",
        "background:rgba(24,40,88,.9);color:#fff;",
        "box-shadow:0 8px 28px rgba(0,0,0,.35)}",
      "#n3dOverlay .n3d-dock[hidden]{display:none!important}",
      "#n3dOverlay .n3d-dist-v{font-size:22px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1}",
      "#n3dOverlay .n3d-dist-u{font-size:13px;font-weight:600;opacity:.75;margin-left:3px}",
      "#n3dOverlay .n3d-dist-lbl{font-size:11px;font-weight:600;opacity:.6;text-transform:uppercase;letter-spacing:.05em}",
      // Arrival card — "Destination reached".
      "#n3dOverlay .n3d-arrived{position:absolute;inset:0;z-index:24;display:flex;",
        "align-items:center;justify-content:center;background:rgba(15,23,42,.45);",
        "padding:20px;pointer-events:none}",
      "#n3dOverlay .n3d-arrived[hidden]{display:none!important}",
      "#n3dOverlay .n3d-arrived-card{pointer-events:auto;display:flex;flex-direction:column;",
        "align-items:center;gap:10px;width:min(320px,100%);padding:24px 20px 20px;",
        "border-radius:18px;background:#fff;box-shadow:0 18px 44px rgba(0,0,0,.3);",
        "text-align:center;font-family:-apple-system,system-ui,sans-serif}",
      "#n3dOverlay .n3d-arrived-ic{width:52px;height:52px;border-radius:999px;",
        "display:grid;place-items:center;background:#ecfdf5;color:#15803d;font-size:28px}",
      "#n3dOverlay .n3d-arrived-title{font-size:17px;font-weight:700;color:#111}",
      "#n3dOverlay .n3d-arrived-name{font-size:14px;color:rgba(0,0,0,.6)}",
      "#n3dOverlay .n3d-arrived-done{width:100%;height:50px;margin-top:8px;border:0;",
        "border-radius:14px;background:#182858;color:#fff;font-size:16px;font-weight:700;",
        "font-family:inherit;cursor:pointer}",
      "#n3dOverlay .n3d-arrived-done:active{transform:scale(.98)}",
      "body.n3d-open canvas:not(.n3d-canvas){visibility:hidden}",
    ].join("");
    document.head.appendChild(style);

    var ov = document.createElement("div");
    ov.id = OVERLAY_ID; ov.hidden = true;
    ov.setAttribute("role","dialog"); ov.setAttribute("aria-modal","true");
    ov.innerHTML = [
      '<div class="n3d-stage">',
        '<div class="n3d-bar">',
          '<button class="n3d-close" id="n3dClose" aria-label="Close">&#x2715; Back</button>',
          '<span class="n3d-title" id="n3dTitle">Walkthrough Navigation</span>',
          '<button class="n3d-locate" id="n3dLocate" aria-label="Navigate from me" title="Navigate from me">&#x1F4F7; Navigate from me</button>',
          '<input type="file" id="n3dLocateInput" accept="image/*" capture="environment" hidden>',
        '</div>',
        '<iframe id="n3dFrame" allow="xr-spatial-tracking;fullscreen" allowfullscreen></iframe>',
        '<canvas class="n3d-canvas" id="n3dCanvas" hidden></canvas>',
        '<div class="n3d-status" id="n3dStatus" hidden></div>',
        '<div class="n3d-dock" id="n3dDock" hidden>',
          '<div><div class="n3d-dist-lbl">Distance remaining</div>',
          '<div><span class="n3d-dist-v" id="n3dDistV">—</span><span class="n3d-dist-u" id="n3dDistU">m</span></div></div>',
        '</div>',
        '<div class="n3d-arrived" id="n3dArrived" hidden role="alertdialog" aria-modal="false">',
          '<div class="n3d-arrived-card">',
            '<div class="n3d-arrived-ic" aria-hidden="true">&#x2713;</div>',
            '<strong class="n3d-arrived-title">Destination reached</strong>',
            '<span class="n3d-arrived-name" id="n3dArrivedName"></span>',
            '<button class="n3d-arrived-done" id="n3dArrivedDone" type="button">Done</button>',
          '</div>',
        '</div>',
      '</div>',
    ].join("");
    document.body.appendChild(ov);
    $("n3dClose").addEventListener("click", close);
    $("n3dArrivedDone").addEventListener("click", function(){ hideArrived(); close(); });
    $("n3dLocate").addEventListener("click", startLocateFromMe);
    $("n3dLocateInput").addEventListener("change", function(e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = "";   // allow picking the same file again next time
      if (file) localizeFromImage(file);
    });
  }

  function setStatus(msg) {
    var el = $("n3dStatus"); if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false; el.textContent = msg;
  }

  function updateDistDisplay() {
    var dock = $("n3dDock"), dv = $("n3dDistV"), du = $("n3dDistU");
    if (!dock) return;
    var rem = remainingMetres();
    if (rem === null || rem < 0.5) { dock.hidden = true; return; }
    dock.hidden = false;
    if (dv) {
      if (rem >= 1000) { dv.textContent = (rem/1000).toFixed(2); if (du) du.textContent = "km"; }
      else { dv.textContent = Math.round(rem).toString(); if (du) du.textContent = "m"; }
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────────
  function resolveConfig() {
    try {
      var cfg = (window.WF && window.WF.cfg) || {};
      modelId = cfg.matterport_model_id || cfg.model_id || "Hn36TwktGgz";
      appKey  = cfg.mp_sdk_key || cfg.applicationKey || "762iznhy6un3iztccf6bpc48a";
    } catch(_) { modelId = "Hn36TwktGgz"; appKey = "762iznhy6un3iztccf6bpc48a"; }
  }

  function showcaseUrl() {
    var u = "https://my.matterport.com/show/?m=" + encodeURIComponent(modelId);
    u += "&play=1&qs=1&brand=0&title=0&logo=0&newtop=0&mls=2&lp=0&lang=en";
    u += "&dh=1&hr=0&gt=0&tourcta=0&vr=0&mt=0&help=0&search=0&f=0&pin=0&ss=0&sr=0&kb=0";
    if (appKey) u += "&applicationKey=" + encodeURIComponent(appKey);
    return u;
  }

  // ── SDK bootstrap ────────────────────────────────────────────────────────────
  function loadSdk() {
    if (window.MP_SDK) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function(res, rej) {
      var s = document.createElement("script");
      s.src = SDK_BOOTSTRAP; s.async = true;
      s.onload = res; s.onerror = function(){ rej(new Error("Matterport SDK failed")); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

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

  /**
   * Cost of one Dijkstra hop: plain 3D distance, so the main solve finds the
   * genuinely nearest-point route on flat ground instead of being biased
   * towards touching extra scan points along the way (that used to be the
   * point of a super-linear exponent here — it made two short hops beat one
   * long one covering the same ground, which reliably over-covered open
   * areas). Flat-ground gaps left behind by a real skip-edge are still filled
   * in afterwards by insertSkippedSweeps(), so nothing is lost visually.
   *
   * A level-change hop (dy > FLOOR_STEP_M) that is NOT part of a declared stair
   * chain gets a heavy penalty — ported from threednavigation.ts. Matterport's
   * own neighbour graph links the bottom of a flight straight to a point part
   * way up it, which is shorter than walking the steps, so without this the
   * search always prefers that shortcut over the real stairs whenever both ends
   * happen to sit in the graph's reachable set. The geometric repair passes
   * (STAIR_MIN_GRADE, planLegByLeastClimb, planLegMostScanPoints) still run on
   * every level change regardless and are what guarantee every step on a
   * flight is covered — this penalty only stops Dijkstra steering around a
   * declared chain in the first place.
   */
  function hopCost(a, b) {
    var cost = dist3(a, b);
    var dy = Math.abs(a.position.y - b.position.y);
    if (dy > FLOOR_STEP_M && stairChainIndexBySid) {
      var ca = stairChainIndexBySid[a.sid], cb = stairChainIndexBySid[b.sid];
      if (ca === undefined || ca !== cb) cost += 10000;
    }
    return cost;
  }

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
  /**
   * Binary min-heap keyed by cost, with lazy deletion (push duplicates on
   * decrease, skip stale pops) instead of decrease-key — simpler, and just as
   * fast in practice for a graph this size. solveRoute() re-runs on every
   * single step the user takes (watchSweepChanges -> rerouteFromSweep), so
   * going from the old O(sweeps^2) linear scan for the next node to this
   * O((V+E) log V) is what makes re-routing instant instead of visibly
   * lagging on a 990-sweep scan.
   */
  function MinHeap() { this.a = []; }
  MinHeap.prototype.push = function (id, cost) {
    var a = this.a; a.push({ id: id, cost: cost });
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      var t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a; if (!a.length) return null;
    var top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0, n = a.length;
      for (;;) {
        var l = i * 2 + 1, r = i * 2 + 2, s = i;
        if (l < n && a[l].cost < a[s].cost) s = l;
        if (r < n && a[r].cost < a[s].cost) s = r;
        if (s === i) break;
        var t = a[s]; a[s] = a[i]; a[i] = t; i = s;
      }
    }
    return top;
  };

  function solveRoute(fromSid, toSid) {
    var byId = buildSweepMap();
    if (fromSid === toSid) return [fromSid];
    var best = {}, prev = {}, done = {};
    best[fromSid] = 0;
    var heap = new MinHeap();
    heap.push(fromSid, 0);

    for (;;) {
      var top = heap.pop();
      if (!top) break;
      var curId = top.id;
      if (done[curId]) continue;          // stale entry from an earlier decrease
      done[curId] = true;
      if (curId === toSid) break;
      var cur = byId[curId]; if (!cur) continue;
      for (var j = 0; j < cur.neighbours.length; j++) {
        var nId = cur.neighbours[j];
        if (done[nId]) continue;
        var nb = byId[nId]; if (!nb) continue;
        var cost = best[curId] + hopCost(cur, nb);
        if (best[nId] === undefined || cost < best[nId]) {
          best[nId] = cost; prev[nId] = curId;
          heap.push(nId, cost);
        }
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
    var fin = applyStairChains(rep, byId);
    return fin;
  }

  function buildSweepMap() {
    var m = {};
    for (var i = 0; i < sweeps.length; i++) m[sweeps[i].sid] = sweeps[i];
    return m;
  }

  /**
   * Where a single point falls along navPathMp, in plan view (X/Z only) — same
   * projection sweepsAlongNavPath() does per scan point, factored out so a
   * re-solve from an arbitrary current position (onReachedWalkStop) can find
   * its own spot on the path without scanning the whole sweep list for it.
   * Returns null if navPathMp isn't usable (no path, or degenerate/zero length).
   */
  function projectPointOntoNavPath(pos) {
    var pts = navPathMp;
    if (!pts || pts.length < 2) return null;
    var total = 0, bestT = -1, bestDSq = Infinity, runLen = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i-1], b = pts[i];
      var dx = b.x - a.x, dz = b.z - a.z;
      var segLen = Math.sqrt(dx*dx + dz*dz);
      total += segLen;
    }
    if (total < 0.1) return null;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i-1], b = pts[i];
      var sdx = b.x - a.x, sdz = b.z - a.z;
      var segLen = Math.sqrt(sdx*sdx + sdz*sdz);
      if (segLen < 1e-6) continue;
      var t = ((pos.x - a.x)*sdx + (pos.z - a.z)*sdz) / (segLen*segLen);
      t = Math.max(0, Math.min(1, t));
      var cx = a.x + t*sdx, cz = a.z + t*sdz;
      var ex = pos.x - cx, ez = pos.z - cz;
      var dSq = ex*ex + ez*ez;
      if (dSq < bestDSq) { bestDSq = dSq; bestT = (runLen + t*segLen) / total; }
      runLen += segLen;
    }
    return bestT >= 0 ? { t: bestT, distSq: bestDSq } : null;
  }

  /**
   * Solve a route from `fromSweep` to `toSweep` — same navPath-projection-first,
   * Dijkstra-fallback logic runNavigate() uses for the very first solve, factored
   * out so onReachedWalkStop() can call it again from wherever the camera actually
   * is. When re-solving mid-route, points on navPathMp that fall BEHIND fromSweep's
   * own position on the path are dropped first — otherwise re-projecting the whole
   * path from scratch would walk the user backward through ground they already
   * covered before heading on to the destination again.
   */
  function computeRouteSids(fromSweep, toSweep) {
    var pathIds = sweepsAlongNavPath(5);
    if (pathIds.length >= 2) {
      // Drop points behind fromSweep so a re-solve from mid-route doesn't walk
      // backward through ground already covered. Prefer fromSweep's own position
      // IN this corridor-filtered list over a freshly computed path-t: near the
      // ends of the path (or any spot where two close-together scan points both
      // clamp to the same t), a lone t comparison can't tell "behind" from
      // "basically tied", which is exactly what let an earlier version of this
      // bounce the camera one hop backward before continuing on.
      var selfIdx = pathIds.indexOf(fromSweep.sid);
      if (selfIdx >= 0) {
        pathIds = pathIds.slice(selfIdx);
      } else {
        var fromProj = projectPointOntoNavPath(fromSweep.position);
        if (fromProj) {
          var kept = [];
          for (var i = 0; i < pathIds.length; i++) {
            var sw = sweeps.filter(function(s){ return s.sid === pathIds[i]; })[0];
            if (!sw) continue;
            var proj = projectPointOntoNavPath(sw.position);
            if (proj && proj.t >= fromProj.t - 1e-6) kept.push(pathIds[i]);
          }
          pathIds = kept;
        }
      }
      if (!pathIds.length || pathIds[0] !== fromSweep.sid) pathIds.unshift(fromSweep.sid);

      var lastSid = pathIds[pathIds.length - 1];
      var lastSw  = sweeps.filter(function(s){ return s.sid === lastSid; })[0];
      var heightGap = lastSw ? Math.abs(lastSw.position.y - toSweep.position.y) : 0;
      if (heightGap > 2.0 && lastSid !== toSweep.sid) {
        var bridge = solveRoute(lastSid, toSweep.sid);
        if (bridge.length > 1) bridge.shift();
        pathIds = pathIds.concat(bridge);
      } else if (pathIds[pathIds.length - 1] !== toSweep.sid) {
        pathIds.push(toSweep.sid);
      }
      return pathIds;
    }
    return solveRoute(fromSweep.sid, toSweep.sid);
  }

  /**
   * Find all scan points that lie along navPathMp, ordered by their position
   * on it. This is what makes "basketball court → advanced lab" follow the
   * correct corridor instead of Dijkstra picking the wrong one.
   *
   * Projection is in plan view (X/Z only) so floor height differences don't
   * bias which scan point is "nearest" to the path. A Y-height guard keeps
   * stair scan points on the right floor: the sweep must sit within [-0.3m,
   * +3m] of the navPath point it projects onto (navPath is at floor level,
   * sweeps are at camera height ≈ 1.5m above the floor).
   *
   * @param {number} corridorM  Maximum plan-view distance from the path.
   * @returns {string[]}  Ordered sweep ids, deduped.
   */
  function sweepsAlongNavPath(corridorM) {
    var pts = navPathMp;
    if (!pts || pts.length < 2 || !sweeps.length) return [];

    // Cumulative arc lengths in plan view (X/Z).
    var segs = [], total = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i-1], b = pts[i];
      var dx = b.x - a.x, dz = b.z - a.z;
      var len = Math.sqrt(dx*dx + dz*dz);
      segs.push(len);
      total += len;
    }
    if (total < 0.1) return [];

    // Detect whether the navPath carries real 3-D height data.
    // If the backend sends a flat (2-D) navmesh polyline every Y is 0 (or near
    // it), so bestSegY ≈ 0 for every segment.  Applying the ±3 m floor guard
    // then silently drops all scan points that are above the ground floor
    // (floor 4 sweeps sit at Y ≈ 12 m in Matterport space).  Only apply the
    // guard when the path itself spans more than 1 m in Y.
    var pathYMin = Infinity, pathYMax = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].y < pathYMin) pathYMin = pts[i].y;
      if (pts[i].y > pathYMax) pathYMax = pts[i].y;
    }
    var navPathHas3dHeight = (pathYMax - pathYMin) > 1.0;

    var corrSq = corridorM * corridorM;
    var placed = [];

    for (var si = 0; si < sweeps.length; si++) {
      var sw = sweeps[si];
      var bestT = -1, bestDSq = Infinity, bestSegY = 0;

      var runLen = 0;
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i-1], b = pts[i];
        var segLen = segs[i-1];
        if (segLen < 1e-6) { runLen += segLen; continue; }
        var sdx = b.x - a.x, sdz = b.z - a.z;
        var t = ((sw.position.x - a.x)*sdx + (sw.position.z - a.z)*sdz) / (segLen*segLen);
        t = Math.max(0, Math.min(1, t));
        var cx = a.x + t*sdx, cz = a.z + t*sdz;
        var ex = sw.position.x - cx, ez = sw.position.z - cz;
        var dSq = ex*ex + ez*ez;
        if (dSq < bestDSq) {
          bestDSq = dSq;
          bestT = (runLen + t * segLen) / total;
          bestSegY = a.y + t * (b.y - a.y);
        }
        runLen += segLen;
      }

      if (bestDSq > corrSq || bestT < 0) continue;
      // Floor guard: only apply when the navPath has real height data.
      // With a flat navPath (Y≈0 everywhere) this guard would wrongly discard
      // all upper-floor scan points, so we skip it and let splitRouteAtLevelChanges
      // handle floor ordering instead.
      if (navPathHas3dHeight) {
        var rise = sw.position.y - bestSegY;
        if (rise < -0.3 || rise > 3.0) continue;
      }

      placed.push({ sid: sw.sid, t: bestT, d: Math.sqrt(bestDSq) });
    }

    // Sort by position along the path; break ties by proximity.
    placed.sort(function(a, b) { return a.t - b.t || a.d - b.d; });

    // Deduplicate consecutive identical sweeps.
    var ids = [];
    for (var pi = 0; pi < placed.length; pi++) {
      var sid = placed[pi].sid;
      if (!ids.length || ids[ids.length-1] !== sid) ids.push(sid);
    }
    return ids;
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

  /**
   * Re-order a solved route through a declared stair chain in the chain's own
   * known-correct bottom-to-top order, instead of whatever order Dijkstra
   * happened to produce. Ported from threednavigation.ts.
   *
   * Geometry gets most of the way there but not all of it: two points at the
   * top of a flight can differ by a centimetre, which is not enough to order
   * them, and a graph full of skip links offers several plausible ways up. A
   * declared chain removes the ambiguity — these are the steps, in this order.
   */
  function applyStairChains(ids, byId) {
    if (!stairChains.length || ids.length < 2) return ids;
    var route = ids.slice();
    for (var c = 0; c < stairChains.length; c++) {
      var chain = stairChains[c];
      var pos = {};
      for (var p = 0; p < chain.length; p++) pos[chain[p]] = p;
      var hits = [];
      for (var i = 0; i < route.length; i++) { if (pos.hasOwnProperty(route[i])) hits.push(i); }
      if (hits.length < 2) continue;
      var first = hits[0], lastIdx = hits[hits.length - 1];
      // Widest span of the flight the route actually touches.
      var lo = Infinity, hi = -Infinity;
      for (var h = 0; h < hits.length; h++) {
        var pp = pos[route[hits[h]]];
        if (pp < lo) lo = pp;
        if (pp > hi) hi = pp;
      }
      if (hi - lo < 1) continue;
      var ascending = pos[route[first]] <= pos[route[lastIdx]];
      var run = chain.slice(lo, hi + 1);
      var ordered = ascending ? run : run.slice().reverse();
      // The seams must be real neighbour links, or this would invent a step.
      var before = route[first - 1];
      var after = route[lastIdx + 1];
      var tail = byId[ordered[ordered.length - 1]];
      if (!byId[ordered[0]] || !tail) continue;
      if (before && byId[before] && byId[before].neighbours.indexOf(ordered[0]) < 0) continue;
      if (after && tail.neighbours.indexOf(after) < 0) continue;
      route = route.slice(0, first).concat(ordered, route.slice(lastIdx + 1));
    }
    return collapseLoops(route);
  }

  /** Raw {sweep_numbers} rows from navme_stair_chains, as soon as they're fetched —
   *  see the module-level comment by `stairChains` for why resolution is deferred. */
  function setStairChainRows(rows) {
    pendingStairChainRows = rows || [];
    resolveStairChains();
  }

  /** Turn pending {sweep_numbers} rows (Sweep.data collection indices) into sid
   *  chains now that `sweeps` is populated. No-ops until both are available. */
  function resolveStairChains() {
    stairChains = [];
    stairChainIndexBySid = null;
    if (!pendingStairChainRows || !sweeps.length) return;
    for (var r = 0; r < pendingStairChainRows.length; r++) {
      var nums = pendingStairChainRows[r] && pendingStairChainRows[r].sweep_numbers;
      if (!Array.isArray(nums)) continue;
      var ids = [];
      for (var n = 0; n < nums.length; n++) {
        var idx = Number(nums[n]);
        if (Number.isInteger(idx) && idx >= 0 && idx < sweeps.length) ids.push(sweeps[idx].sid);
      }
      if (ids.length >= 2) stairChains.push(ids);
    }
    if (stairChains.length) {
      stairChainIndexBySid = {};
      for (var c = 0; c < stairChains.length; c++) {
        for (var i = 0; i < stairChains[c].length; i++) stairChainIndexBySid[stairChains[c][i]] = c;
      }
    }
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
  }

  function applyRouteLegs() {
    var byId = buildSweepMap(), points = [];
    for (var i = 0; i < routeSids.length; i++) {
      var sw = byId[routeSids[i]];
      if (sw) points.push({x:sw.position.x, y:sw.position.y, z:sw.position.z, sid:sw.sid});
    }
    routeLegs = splitRouteAtLevelChanges(points);
    activeLeg = 0;
    setTrailFromActiveLeg();
  }

  /**
   * Scan-point indices of `leg` that are actual navmesh-route turns (see
   * nextTurnIndex()), walked end to end — i.e. the same sparse waypoint sequence the
   * auto-fly used to land on, now used to draw the floor trail too: straight lines
   * between real turns, not a dot at every scan point along the way. Stairs legs skip
   * this and keep the dense original sequence (unchanged, per stairs being untouched).
   */
  function legWaypointIndices(leg) {
    var pts = leg.points;
    var idxs = [0];
    var i = 0;
    while (i < pts.length - 1) {
      var next = nextTurnIndex(pts, i);
      if (next <= i) break;
      idxs.push(next);
      i = next;
    }
    return idxs;
  }

  function setTrailFromActiveLeg() {
    var leg = routeLegs[activeLeg];
    if (!leg || leg.points.length < 2) { navPts = []; scheduleTrailDraw(); return; }
    var srcPts = leg.points;
    if (leg.kind === "walk") {
      srcPts = legWaypointIndices(leg).map(function(i){ return leg.points[i]; });
    }
    var verts = srcPts.map(function(p){ return {x:p.x, y:p.y-EYE_HEIGHT_M, z:p.z}; });
    navPts = resamplePolylineEven(verts, DOT_SPACING_M, DOT_CAP);
    scheduleTrailDraw();
  }

  // ── Resampling ───────────────────────────────────────────────────────────────
  function resamplePolylineEven(verts, spacing, cap) {
    if (verts.length < 2) return verts.slice();
    var step = Math.max(0.05, spacing), out = [verts[0]];
    for (var i = 1; i < verts.length; i++) {
      var a = verts[i-1], b = verts[i];
      var dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z;
      var len = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (len <= 1e-6) continue;
      // Unscanned flight: show the points that exist, invent nothing between —
      // a straight line up an unscanned staircase drives a diagonal through the
      // ceiling slab. Gated on gradient, not bare rise: a long outdoor hop that
      // climbs 0.4m is a slope and MUST be interpolated, or the trail renders as
      // a single lonely dot with the whole walkway between its endpoints empty.
      if (Math.abs(dy) > STAIR_RISE_MAX && len > STAIR_RUN_MAX &&
          isLevelChange(a.y, b.y, a.x, a.z, b.x, b.z)) {
        out.push({x:b.x,y:b.y,z:b.z,breakBefore:true});
        if (out.length >= cap) return out; continue;
      }
      var t = step/len;
      while (t<=1) {
        out.push({x:a.x+dx*t,y:a.y+dy*t,z:a.z+dz*t});
        if (out.length>=cap) return out;
        t += step/len;
      }
      var tail = out[out.length-1];
      var gap = Math.sqrt((b.x-tail.x)**2+(b.y-tail.y)**2+(b.z-tail.z)**2);
      if (gap > step*0.25) { out.push({x:b.x,y:b.y,z:b.z}); if(out.length>=cap)return out; }
      else { tail.x=b.x; tail.y=b.y; tail.z=b.z; }
    }
    return out;
  }

  // ── Remaining distance ───────────────────────────────────────────────────────
  function seg(a, b) {
    return Math.sqrt((b.x-a.x)*(b.x-a.x) + (b.y-a.y)*(b.y-a.y) + (b.z-a.z)*(b.z-a.z));
  }

  /**
   * Metres still to walk, measured along the REAL route — the scan-point
   * polyline in routeLegs, not the resampled trail.
   *
   * The resample exists to space dots for drawing and is bounded by DOT_CAP;
   * measuring along it makes the headline distance an artefact of how the dots
   * happened to be laid out. The legs are the route.
   *
   * Anchored on the settled sweep where possible rather than the live pose, so
   * the readout ticks down once per scan point instead of flickering mid-flight.
   */
  function remainingMetres() {
    if (!routeLegs.length) return null;
    var sweepPos = null;
    if (currentSweepSid) {
      var hit = sweeps.filter(function(s){ return s.sid === currentSweepSid; })[0];
      if (hit) sweepPos = hit.position;
    }
    var cam = sweepPos || (lastPose && lastPose.position) || null;

    var pts = routeLegs[activeLeg] ? routeLegs[activeLeg].points : [];
    if (!pts.length) return null;

    // Nearest point on the leg, matched in X/Z only: the camera stands at eye
    // height while the route points sit at scan height on the floor.
    var from = 0;
    if (cam) {
      var bestD = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = (pts[i].x-cam.x)*(pts[i].x-cam.x) + (pts[i].z-cam.z)*(pts[i].z-cam.z);
        if (d < bestD) { bestD = d; from = i; }
      }
    }

    var total = 0;
    for (var j = from; j < pts.length-1; j++) total += seg(pts[j], pts[j+1]);
    // Only the leg in hand is drawn, so the legs still to come must be added or
    // the readout would count down to zero at the foot of the stairs.
    for (var l = activeLeg+1; l < routeLegs.length; l++) {
      var lp = routeLegs[l].points;
      for (var k = 0; k < lp.length-1; k++) total += seg(lp[k], lp[k+1]);
    }
    return total;
  }

  /** True once the user is standing at the end of the FINAL leg. */
  function hasArrived() {
    if (!routeLegs.length || activeLeg < routeLegs.length - 1) return false;
    var pts = routeLegs[routeLegs.length-1].points;
    var end = pts[pts.length-1];
    var cam = lastPose && lastPose.position;
    if (!end || !cam) return false;
    // X/Z only: the camera stands at eye height, the route point on the floor.
    var d = Math.sqrt((end.x-cam.x)*(end.x-cam.x) + (end.z-cam.z)*(end.z-cam.z));
    return d <= ARRIVE_RADIUS_M;
  }

  function showArrived() {
    if (arrivedShown) return;
    var card = $("n3dArrived");
    if (!card) return;
    arrivedShown = true;
    var nameEl = $("n3dArrivedName");
    if (nameEl) nameEl.textContent = destName ? "You have arrived at " + destName + "." : "";
    card.hidden = false;
  }

  function hideArrived() {
    var card = $("n3dArrived");
    if (card) card.hidden = true;
    arrivedShown = false;
  }

  function maybeAdvanceLeg() {
    if (activeLeg >= routeLegs.length-1) return false;
    var leg = routeLegs[activeLeg];
    var cam = lastPose && lastPose.position;
    if (!leg || !cam) return false;
    var end = leg.points[leg.points.length-1];
    var d = Math.sqrt((end.x-cam.x)**2 + (end.y+EYE_HEIGHT_M-cam.y)**2 + (end.z-cam.z)**2);
    if (d > LEG_ARRIVE_M) return false;
    activeLeg++;
    setTrailFromActiveLeg();
    return true;
  }

  // ── Projection ───────────────────────────────────────────────────────────────
  function stageSize() {
    var canvas = $("n3dCanvas");
    return { w: Math.max(1, canvas ? canvas.clientWidth : window.innerWidth),
             h: Math.max(1, canvas ? canvas.clientHeight : window.innerHeight) };
  }

  function iframeSize() {
    var f = $("n3dFrame");
    return { w: Math.max(1, f ? f.clientWidth : window.innerWidth),
             h: Math.max(1, (f ? f.clientHeight : window.innerHeight) + CROP_TOP_PX + 64) };
  }

  function projectManually(p, pose, size) {
    var c = pose.position, r = pose.rotation;
    if (!c || !r) return null;
    var yaw = (Number(r.y)||0)*Math.PI/180, pitch = (Number(r.x)||0)*Math.PI/180;
    var cp = Math.cos(pitch);
    var f = {x:-Math.sin(yaw)*cp, y:Math.sin(pitch), z:-Math.cos(yaw)*cp};
    var rl = Math.sqrt(f.z*f.z+f.x*f.x) || 1e-6;
    var right = {x:-f.z/rl, y:0, z:f.x/rl};
    var up = {x:right.y*f.z-right.z*f.y, y:right.z*f.x-right.x*f.z, z:right.x*f.y-right.y*f.x};
    var v = {x:p.x-c.x, y:p.y-c.y, z:p.z-c.z};
    var camX = v.x*right.x+v.y*right.y+v.z*right.z;
    var camY = v.x*up.x+v.y*up.y+v.z*up.z;
    var camZ = v.x*f.x+v.y*f.y+v.z*f.z;
    if (camZ <= 0.01) return {x:0,y:0,z:-1};
    var proj = pose.projection;
    var focal = (proj && proj.length>=16 && isFinite(Number(proj[5])))
      ? (Number(proj[5])*size.h)/2
      : size.h/2/Math.tan(60*Math.PI/360);
    return {x:size.w/2+(focal*camX)/camZ, y:size.h/2-(focal*camY)/camZ, z:camZ};
  }

  function worldToScreen(p, pose) {
    var iframe = iframeSize();
    try {
      var fn = mpSdk && ((mpSdk.Conversion && mpSdk.Conversion.worldToScreen) || (mpSdk.Renderer && mpSdk.Renderer.worldToScreen));
      if (fn) {
        var s = fn(p, pose, iframe);
        if (s && isFinite(Number(s.x))) return {x:Number(s.x), y:Number(s.y)-CROP_TOP_PX, z:Number(s.z)};
      }
    } catch(_){}
    var s2 = projectManually(p, pose, iframe);
    if (!s2) return null;
    return {x:s2.x, y:s2.y-CROP_TOP_PX, z:s2.z};
  }

  // ── Trail drawing ─────────────────────────────────────────────────────────────
  function scheduleTrailDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(function(){
      drawRaf = 0;
      drawTrail();
      // Arrival only — distance is refreshed on sweep land, not every frame.
      if (navPts.length && hasArrived()) showArrived();
    });
  }

  function drawTrail() {
    var canvas = $("n3dCanvas");
    if (!canvas) return;
    var pose = lastPose;
    var size = stageSize();
    var dpr = Math.min(devicePixelRatio||1, 2);
    var bw = Math.round(size.w*dpr), bh = Math.round(size.h*dpr);
    if (canvas.width!==bw || canvas.height!==bh) { canvas.width=bw; canvas.height=bh; }
    var ctx = canvas.getContext("2d", {alpha:true});
    if (!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,size.w,size.h);

    if (navPts.length < 2 || !pose) { canvas.hidden = true; return; }
    canvas.hidden = false;

    var cam = pose.position || null;

    // Find nearest point to camera (XZ only)
    var startIdx = 0;
    if (cam) {
      var bestD = Infinity;
      for (var i = 0; i < navPts.length; i++) {
        var p = navPts[i], d = (p.x-cam.x)**2+(p.z-cam.z)**2;
        if (d < bestD) { bestD=d; startIdx=i; }
      }
      startIdx = Math.max(0, startIdx-1);
    }

    // Look-ahead window
    var endIdx = navPts.length, run = 0;
    for (var i = startIdx+1; i < navPts.length; i++) {
      var a=navPts[i-1], b=navPts[i];
      run += Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2+(b.z-a.z)**2);
      if (run > VISIBLE_M) { endIdx=i; break; }
    }

    // Flatten onto current floor plane
    var camFloorY = cam ? cam.y - EYE_HEIGHT_M : null;
    var flat = [];
    for (var i = startIdx; i < endIdx; i++) {
      var p = navPts[i];
      var onFloor = camFloorY !== null && Math.abs(p.y - camFloorY) < SAME_FLOOR_M;
      flat.push({x:p.x, y:(onFloor?camFloorY:p.y)+DOT_HEIGHT_M, z:p.z});
    }

    function camDist(q) { return cam ? Math.sqrt((q.x-cam.x)**2+(q.y-cam.y)**2+(q.z-cam.z)**2) : 6; }

    var dots = [];
    for (var i = 0; i < flat.length; i++) {
      var q = flat[i];
      var s = worldToScreen(q, pose);
      if (!s || !isFinite(s.x) || !isFinite(s.y)) continue;
      if (isFinite(s.z) && s.z < 0) continue;
      if (s.x<-40||s.y<-40||s.x>size.w+40||s.y>size.h+40) continue;
      dots.push({x:s.x, y:s.y, d:camDist(q)});
    }
    dots.sort(function(a,b){ return b.d-a.d; });

    for (var i = 0; i < dots.length; i++) {
      var dot = dots[i];
      var r = Math.max(4, Math.min(16, 46/Math.max(1.2, dot.d)));
      ctx.beginPath(); ctx.arc(dot.x, dot.y, r+1.2, 0, Math.PI*2);
      ctx.fillStyle = "rgba(255,255,255,0.72)"; ctx.fill();
      ctx.beginPath(); ctx.arc(dot.x, dot.y, r, 0, Math.PI*2);
      ctx.fillStyle = TRAIL_FILL; ctx.fill();
    }

    // Destination pin
    if (destPtMp) {
      var onFloor = camFloorY !== null && Math.abs(destPtMp.y - camFloorY) < SAME_FLOOR_M;
      var dw = {x:destPtMp.x, y:(onFloor?camFloorY:destPtMp.y)+DOT_HEIGHT_M, z:destPtMp.z};
      var scr = worldToScreen(dw, pose);
      if (scr && isFinite(scr.x) && !(isFinite(scr.z)&&scr.z<0)) {
        var d2 = camDist(dw);
        var r2 = Math.max(5, Math.max(4,Math.min(16,46/Math.max(1.2,d2)))+3);
        ctx.beginPath(); ctx.arc(scr.x, scr.y, r2+2, 0, Math.PI*2);
        ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fill();
        ctx.beginPath(); ctx.arc(scr.x, scr.y, r2, 0, Math.PI*2);
        ctx.fillStyle = DEST_PIN; ctx.fill();
        if (destName && d2 <= 28) {
          var scale = Math.max(0.65, Math.min(1.45, 9/Math.max(2.2, d2)));
          var fontPx = Math.round(13*scale), padX=10*scale, padY=6*scale;
          ctx.font = "700 "+fontPx+"px system-ui,-apple-system,sans-serif";
          ctx.textAlign="center"; ctx.textBaseline="middle";
          var tw = ctx.measureText(destName).width;
          var bw2=tw+padX*2, bh2=fontPx+padY*2, stem=14*scale;
          var cx=scr.x, top=scr.y-r2-stem-bh2;
          ctx.beginPath(); ctx.moveTo(cx,scr.y-r2); ctx.lineTo(cx,top+bh2);
          ctx.strokeStyle=DEST_PIN; ctx.lineWidth=Math.max(1.5,2*scale); ctx.stroke();
          if (ctx.roundRect) ctx.roundRect(cx-bw2/2,top,bw2,bh2,bh2/2);
          else ctx.rect(cx-bw2/2,top,bw2,bh2);
          ctx.fillStyle=DEST_PIN; ctx.fill();
          ctx.strokeStyle="rgba(255,255,255,0.92)"; ctx.lineWidth=1.25; ctx.stroke();
          ctx.fillStyle="#fff"; ctx.fillText(destName, cx, top+bh2/2);
        }
      }
    }
  }

  // ── Camera aiming ─────────────────────────────────────────────────────────────
  function refreshPose(delayMs) {
    return (delayMs>0 ? wait(delayMs) : Promise.resolve()).then(function() {
      if (mpSdk && mpSdk.Camera && mpSdk.Camera.getPose) {
        return mpSdk.Camera.getPose().then(function(p){ if(p) lastPose=p; return lastPose; }).catch(function(){ return lastPose; });
      }
      return lastPose;
    });
  }

  function rotationLookingAt(from, to, biasDeg) {
    var dx=to.x-from.x, dy=to.y-from.y, dz=to.z-from.z;
    var horiz = Math.sqrt(dx*dx+dz*dz) || 1e-6;
    var pitch = Math.atan2(dy, horiz)*180/Math.PI;
    if (biasDeg) pitch -= biasDeg;
    var maxPitch=28, minPitch=FACE_MIN_PITCH_DEG;
    if (horiz < 1.5 && pitch > maxPitch) pitch=maxPitch;
    pitch = Math.max(minPitch, Math.min(maxPitch, pitch));
    return {x:pitch, y:Math.atan2(-dx,-dz)*180/Math.PI};
  }

  function sweepTransition(instant) {
    var T = mpSdk && mpSdk.Sweep && mpSdk.Sweep.Transition;
    if (!T) return undefined;
    if (instant) return T.INSTANT || T.FADEOUT || T.MOVEFADE || undefined;
    return T.INTERPOLATE || T.FADEOUT || T.MOVEFADE || T.INSTANT || undefined;
  }

  function moveToSweep(sid, lookAt, instant) {
    var move = mpSdk && mpSdk.Sweep && mpSdk.Sweep.moveTo;
    if (!move) return Promise.resolve();
    var opts = {};
    var trans = sweepTransition(!!instant);
    if (trans) opts.transition = trans;
    if (lookAt) {
      var sw = sweeps.filter(function(s){ return s.sid===String(sid); })[0];
      var from = sw ? sw.position : (lastPose && lastPose.position);
      if (from) opts.rotation = rotationLookingAt(from, lookAt, FACE_SCREEN_BIAS_DEG);
    }
    return move(String(sid), opts).then(function(){ currentSweepSid=String(sid); }).catch(function(){
      return move(String(sid)).then(function(){ currentSweepSid=String(sid); }).catch(function(){});
    });
  }

  function facePoint(target, opts) {
    opts = opts || {};
    if (!mpSdk || !target) return Promise.resolve();
    return refreshPose(0).then(function() {
      var from = lastPose && lastPose.position;
      if (!from) return;
      var flat = Math.sqrt((target.x-from.x)**2+(target.z-from.z)**2);
      if (flat < 0.35) return;
      var rot = rotationLookingAt(from, target, opts.pitch===false ? 0 : FACE_SCREEN_BIAS_DEG);
      if (opts.pitch === false) rot.x = 0;
      var here = currentSweepSid || (lastPose&&(lastPose.sweepId||lastPose.sweep)) || null;
      if (!here) {
        var ns = nearestSweep(from);
        if (ns) here = ns.sid;
      }
      if (here && mpSdk.Sweep && mpSdk.Sweep.moveTo) {
        var moveOpts = {rotation:rot};
        var inst = mpSdk.Sweep.Transition && mpSdk.Sweep.Transition.INSTANT;
        if (inst) moveOpts.transition = inst;
        return mpSdk.Sweep.moveTo(String(here), moveOpts).then(function(){
          currentSweepSid=String(here);
        }).catch(function(){
          if (mpSdk.Camera && mpSdk.Camera.setRotation) return mpSdk.Camera.setRotation(rot, {speed:110}).catch(function(){});
        });
      } else if (mpSdk.Camera && mpSdk.Camera.setRotation) {
        return mpSdk.Camera.setRotation(rot, {speed:110}).catch(function(){});
      }
    }).then(function(){ return refreshPose(150); });
  }

  function faceNextPoint() {
    var leg = routeLegs[activeLeg];
    if (!leg || leg.points.length < 2) return Promise.resolve();
    return refreshPose(0).then(function() {
      var pose = lastPose, cam = pose && pose.position;
      if (!cam) return;
      var pts = leg.points;
      var nearestIdx=0, nearestD=Infinity;
      for (var i=0;i<pts.length;i++) {
        var d=Math.sqrt((pts[i].x-cam.x)**2+(pts[i].z-cam.z)**2);
        if(d<nearestD){nearestD=d;nearestIdx=i;}
      }
      var target=null;
      for (var i=nearestIdx;i<pts.length;i++) {
        var d=Math.sqrt((pts[i].x-cam.x)**2+(pts[i].z-cam.z)**2);
        if(d>=FACE_MIN_AHEAD_M){target=pts[i];break;}
      }
      if (!target) target=pts[pts.length-1];
      return facePoint(target, {biasDeg:FACE_SCREEN_BIAS_DEG, minPitch:FACE_MIN_PITCH_DEG});
    });
  }

  // Stairs legs are intentionally untouched by everything below: no re-solving, just
  // the original fixed-path tracking (maybeAdvanceLeg + faceNextPoint), because a
  // stair flight's scan points are already ordered by the declared chain / geometric
  // repair and re-routing mid-flight risks jumping between flights.
  //
  // Walk legs instead regenerate the route from wherever the camera actually stands
  // every time it comes to rest on a scan point (onReachedWalkStop) — the user moves
  // the camera themselves (clicking in the Matterport view, same as always); nothing
  // here moves it automatically. A naive re-solve on every single step was the earlier
  // cause of a "stuck rotating in a loop" bug: in a big open room many sweeps are
  // near-equally good, so a fresh solve could flip to a path whose first hop led
  // straight back the way the user just came. onReachedWalkStop() guards against
  // exactly that: a freshly solved route is rejected if its first hop is the sweep
  // the camera was just standing on.
  //
  // nextTurnIndex() below is no longer used to drive the camera — only to simplify
  // the floor trail (setTrailFromActiveLeg/legWaypointIndices) down to real navmesh
  // turns instead of a dot at every scan point.

  /**
   * Perpendicular distance from point p to the line through a and b, in full 3-D.
   * Degenerates to |p-a| if a and b coincide.
   */
  function perpDist3D(p, a, b) {
    var abx=b.x-a.x, aby=b.y-a.y, abz=b.z-a.z;
    var apx=p.x-a.x, apy=p.y-a.y, apz=p.z-a.z;
    var lenSq = abx*abx+aby*aby+abz*abz;
    if (lenSq < 1e-9) return Math.sqrt(apx*apx+apy*apy+apz*apz);
    var t = (apx*abx+apy*aby+apz*abz)/lenSq;
    t = Math.max(0, Math.min(1, t));
    var cx=a.x+abx*t, cy=a.y+aby*t, cz=a.z+abz*t;
    var dx=p.x-cx, dy=p.y-cy, dz=p.z-cz;
    return Math.sqrt(dx*dx+dy*dy+dz*dz);
  }

  /**
   * Turn points of the ROUTE itself — navPathMp, the navmesh polyline the backend
   * routing engine produced from the original from/to, same as what the 2D map draws
   * and turn-by-turn directions are built from — not of the scan-point sequence.
   * Scan points are real captured positions and wobble left/right by a few tens of
   * centimetres even down a dead-straight corridor; detecting turns on THEM (whether
   * by angle or by distance-from-chord) means a long straight corridor still reads as
   * a string of tiny turns. The navmesh route itself has no such capture noise — a
   * straight corridor really is straight in it — so turns found here are the real
   * ones. Computed once in open() (navPathMp doesn't change after that), each entry
   * is {t, point}: t is its fractional distance along navPathMp (same parametrization
   * projectPointOntoNavPath returns), point is its {x,y,z}.
   */
  let navPathTurns = [];

  /**
   * How far (metres, full 3-D) navPathMp may drift from a candidate straight chord
   * before that stretch counts as a real turn. Looser than a scan-point tolerance
   * would need to be, since navPathMp itself is already much cleaner.
   */
  const NAVPATH_TURN_TOLERANCE_M = 1.0;

  function computeNavPathTurns() {
    navPathTurns = [];
    var pts = navPathMp;
    if (!pts || pts.length < 2) return;
    var segs = [], total = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i-1], b = pts[i];
      var dx = b.x-a.x, dz = b.z-a.z;
      segs.push(Math.sqrt(dx*dx+dz*dz));
      total += segs[i-1];
    }
    var cum = [0];
    for (var i = 0; i < segs.length; i++) cum.push(cum[i] + segs[i]);
    function tAt(i) { return total > 0.1 ? cum[i] / total : 0; }

    var start = 0;
    while (start < pts.length - 1) {
      var farthest = start + 1;
      for (var j = start + 2; j < pts.length; j++) {
        var straight = true;
        for (var k = start + 1; k < j; k++) {
          if (perpDist3D(pts[k], pts[start], pts[j]) > NAVPATH_TURN_TOLERANCE_M) { straight = false; break; }
        }
        if (!straight) break;
        farthest = j;
      }
      navPathTurns.push({ t: tAt(farthest), point: pts[farthest] });
      start = farthest;
    }
  }

  /**
   * Farthest scan-point index at/after fromIdx that lies on the same straight run of
   * the navmesh route as pts[fromIdx] — i.e. the next real turn, snapped to the
   * nearest scan point — else the last index of this leg (a leg boundary ends a run
   * too — stairs or arrival).
   *
   * Finds the next real bend in navPathTurns strictly ahead of pts[fromIdx]'s own
   * position along the route, then snaps that navmesh-space point to whichever scan
   * point in THIS leg (at or after fromIdx+1) is physically nearest it. Used by
   * legWaypointIndices() to draw the floor trail as straight lines between real turns
   * instead of a dot at every scan point along a straight corridor.
   */
  function nextTurnIndex(pts, fromIdx) {
    var n = pts.length;
    if (fromIdx >= n - 1) return n - 1;
    var fromProj = projectPointOntoNavPath(pts[fromIdx]);
    var fromT = fromProj ? fromProj.t : 0;
    var target = null;
    for (var i = 0; i < navPathTurns.length; i++) {
      if (navPathTurns[i].t > fromT + 1e-4) { target = navPathTurns[i].point; break; }
    }
    if (!target) return n - 1;
    var bestIdx = -1, bestD = Infinity;
    for (var j = fromIdx + 1; j < n; j++) {
      var d = (pts[j].x-target.x)*(pts[j].x-target.x) + (pts[j].z-target.z)*(pts[j].z-target.z);
      if (d < bestD) { bestD = d; bestIdx = j; }
    }
    return bestIdx >= 0 ? bestIdx : n - 1;
  }

  /**
   * Called every time the camera comes to rest on a scan point while the camera is on
   * (or just arrived at) a walk leg — always from the USER physically moving there
   * (clicking a floor point in the Matterport view); nothing in this file moves the
   * camera on its own. Re-solves the route from here to the destination (see
   * computeRouteSids' module comment for why: it finds the right corridor again
   * whether the user is still on the planned route or wandered off it), rejects a
   * re-solve that would double back, then re-aims the camera — never moves it; the
   * next step is always the user's own click, same as stairs already work.
   */
  function onReachedWalkStop(sid) {
    if (!routeLegs.length) return;
    updateDistDisplay();
    scheduleTrailDraw();
    if (hasArrived()) { showArrived(); noProgressSid = null; noProgressCount = 0; return; }
    // Loop guard: if this is called again and again for the SAME scan point with no
    // real movement in between (e.g. a degenerate re-solve that can't make progress
    // from here), stop re-planning — just hold a passive re-aim until the camera
    // actually lands somewhere new (which resets this and resumes normally).
    if (sid === noProgressSid) {
      if (++noProgressCount >= 2) { faceNextPoint(); return; }
    } else {
      noProgressSid = sid; noProgressCount = 0;
    }
    var curLeg = routeLegs[activeLeg];
    if (curLeg && curLeg.kind === "stairs") {
      // Stairs: untouched — original fixed-path tracking only, no re-solving.
      maybeAdvanceLeg();
      curLeg = routeLegs[activeLeg];
      // maybeAdvanceLeg() may have just crossed OUT of the stairs leg (distance-based,
      // same as always) — if so, fall through to the walk-leg handling below in this
      // same call instead of waiting on another sweep-change event.
      if (!curLeg || curLeg.kind === "stairs") { faceNextPoint(); return; }
    }
    var fromSw = sweeps.filter(function(s){ return s.sid === sid; })[0];
    var toSw = sweeps.filter(function(s){ return s.sid === destSweepSid; })[0];
    var regenerated = false;
    if (fromSw && toSw) {
      var fresh = computeRouteSids(fromSw, toSw);
      var validFresh = fresh.length > 1 || (fresh.length === 1 && fresh[0] === destSweepSid);
      var doublesBack = !!prevSweepSid && fresh.length > 1 && fresh[1] === prevSweepSid;
      if (validFresh && !doublesBack) { routeSids = fresh; applyRouteLegs(); regenerated = true; }
    }
    if (!regenerated) maybeAdvanceLeg();
    faceNextPoint();
  }

  /** Kick off navigation for the leg the camera is standing at the start of — a
   *  passive re-aim only (no movement); the user clicks to actually move from here,
   *  same for stairs and walk legs alike. */
  function beginLegNavigation() {
    var leg = routeLegs[activeLeg];
    if (!leg) return Promise.resolve();
    return faceNextPoint();
  }

  // ── Sweep changes (always a real user move — nothing here drives the camera itself) ──
  function watchSweepChanges() {
    if (!mpSdk || !mpSdk.Sweep || !mpSdk.Sweep.current) return;
    var sub = mpSdk.Sweep.current.subscribe(function(sweep) {
      var id = sweep && sweep.sid;
      if (!id || !routeLegs.length) return;
      // Still flying to the route start — this event describes where Showcase WAS,
      // not where the user chose to be.
      if (navLocked) { currentSweepSid = id; return; }
      refreshPose(220).then(function() {
        prevSweepSid = currentSweepSid;
        currentSweepSid = id;
        onReachedWalkStop(id);
      });
    });
    if (!sub) return;
    unsubSweep = function(){ try{ if(typeof sub==="function")sub(); else if(sub.cancel)sub.cancel(); }catch(_){} };
  }

  // ── Show brand / tag cleanup ───────────────────────────────────────────────────
  function tryHideShowcaseBrand() {
    if (!mpSdk) return;
    ["logo","brand","title","about","poweredBy","header"].forEach(function(k){
      try { mpSdk.App && mpSdk.App.toggleComponent && mpSdk.App.toggleComponent(k,false); }catch(_){}
      try { mpSdk.Settings && mpSdk.Settings.set && mpSdk.Settings.set(k,false); }catch(_){}
    });
  }

  function silenceTags() {
    var Tag = mpSdk && mpSdk.Tag; if (!Tag) return;
    try { Tag.toggleSharing && Tag.toggleSharing(false); }catch(_){}
    var drop = function(id){ if(!id||!Tag.remove)return; try{void Tag.remove(id);}catch(_){} };
    function tagId(v){ if(typeof v==="string")return v; if(v&&typeof v==="object")return String(v.id||v.sid||v.tagId||""); return ""; }
    try {
      var sub = Tag.data && Tag.data.subscribe && Tag.data.subscribe({
        onAdded: function(i,item){ drop(tagId(item)||tagId(i)); },
        onCollectionUpdated: function(col){
          var c=col; if(typeof c.forEach==="function"){c.forEach(function(v){drop(tagId(v));});}
          else if(typeof c==="object"){for(var k in c)drop(tagId(c[k]));}
        }
      });
    }catch(_){}
  }

  function waitUntilPlaying(sdk, timeoutMs) {
    return new Promise(function(resolve) {
      var done=false;
      var finish=function(){ if(done)return; done=true; clearTimeout(timer); resolve(); };
      var timer=setTimeout(finish, timeoutMs||18000);
      var playing = (sdk.App&&sdk.App.Phase&&sdk.App.Phase.PLAYING)||"appphase.playing";
      try {
        var state = sdk.App && sdk.App.state;
        if (!state||!state.subscribe) return finish();
        var sub = state.subscribe(function(st){ if(st&&st.phase!==playing)return; try{if(typeof sub==="function")sub();else if(sub.cancel)sub.cancel();}catch(_){} finish(); });
      } catch(_){ finish(); }
    });
  }

  // ── Navigate from me: photo -> VPS localize -> teleport + route from there ───
  var locateBusy = false;
  function wfSlug() {
    try {
      return (window.WF && window.WF.building && window.WF.building.slug)
        || (window.WF && window.WF.cfg && window.WF.cfg.slug)
        || new URLSearchParams(location.search).get("b") || "";
    } catch (_) { return ""; }
  }

  function startLocateFromMe() {
    if (locateBusy) return;
    var input = $("n3dLocateInput");
    if (input) input.click();
  }

  /**
   * Photo -> VPS localize (SuperPoint + MegaLoc against this building's own scan,
   * see platform/vps_prototype/) -> resolve the matched sweep -> teleport there and
   * start navigation to the SAME destination this session was already opened for
   * (destPtMp, set once in open(), is untouched by this).
   *
   * The CV match genuinely takes a few seconds — CPU feature extraction, no faster
   * path exists without a GPU service — so "no lag" here means the UI stays
   * responsive and honest about progress throughout that wait, not that the match
   * itself becomes instant. Everything AFTER a successful match (teleport, route,
   * begin navigation) reuses runNavigate(), the exact same fast path as a normal
   * POI-to-POI route — no added delay once the match is in.
   */
  function localizeFromImage(file) {
    if (locateBusy) return Promise.resolve();
    locateBusy = true;
    var btn = $("n3dLocate"); if (btn) btn.disabled = true;
    setStatus("Locating you — analysing photo…");
    var fd = new FormData();
    fd.append("image", file);
    fd.append("building", wfSlug());
    fd.append("model_id", modelId);
    var t0 = Date.now();
    return fetch("/api/v1/public/vps/localize", { method: "POST", body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        var j = res.body;
        console.info("[ThreeDNav] localize result (" + (Date.now() - t0) + "ms)", j);
        if (!res.ok || !j || !j.success) {
          setStatus((j && (j.detail || j.message)) || "Could not locate you from that photo");
          return wait(2200).then(function () { setStatus(""); });
        }
        var conf = j.confidence || 0;
        // Below this, SuperPoint can still return a handful of inliers for a wrong
        // spot — too few to trust as "this is genuinely where you are."
        var MIN_CONFIDENCE = 0.25;
        if (conf < MIN_CONFIDENCE) {
          setStatus("Not confident enough (" + Math.round(conf * 100) + "%) — try a clearer shot");
          return wait(2200).then(function () { setStatus(""); });
        }
        var navNodes = (window.wf && window.wf.nav && window.wf.nav.nodes) || [];
        var match = navNodes.filter(function (n) { return n.mp_index === j.nearest_sweep; })[0];
        var here = null;
        if (match) {
          var liveSw = sweeps.filter(function (s) { return s.sid === match.id; })[0];
          if (liveSw) here = liveSw.position;
        }
        if (!here) here = toMp({ x: j.x, y: j.y, z: j.z }); // fall back to the raw estimate
        setStatus("Found you — " + Math.round(conf * 100) + "% match" + (j.floor ? ", " + j.floor : ""));
        return wait(2000).then(function () {
          setStatus("");
          return runNavigate(here);
        });
      })
      .catch(function (e) {
        console.warn("[ThreeDNav] localize failed", e);
        setStatus("Localization failed — " + ((e && e.message) || "network error"));
        return wait(2200).then(function () { setStatus(""); });
      })
      .then(function () { locateBusy = false; if (btn) btn.disabled = false; })
      .catch(function () { locateBusy = false; if (btn) btn.disabled = false; });
  }

  // ── Route + teleport after sweeps are ready ───────────────────────────────────
  function runNavigate(fromPtMp) {
    // fromPtMp and destPtMp are in Matterport Y-up coords
    var fromSweep = nearestSweep(fromPtMp);
    var toSweep   = nearestSweep(destPtMp);
    if (!fromSweep || !toSweep) {
      setStatus("Could not find scan points — routing unavailable");
      return Promise.resolve();
    }
    console.info("[ThreeDNav] FROM", fromPtMp, "→ sweep", fromSweep.sid, fromSweep.position);
    console.info("[ThreeDNav] TO  ", destPtMp, "→ sweep", toSweep.sid, toSweep.position);
    navLocked = true;
    destSweepSid = toSweep.sid;
    setStatus("Planning route…");

    routeSids = computeRouteSids(fromSweep, toSweep);
    console.info("[ThreeDNav] route sids (" + routeSids.length + ")", routeSids);
    if (!routeSids.length) {
      navLocked = false;
      setStatus("No route found"); return Promise.resolve();
    }
    applyRouteLegs();
    console.info("[ThreeDNav] legs = " + routeLegs.length, routeLegs.map(function(l){return l.kind+":"+l.points.length;}));
    setStatus("Moving to start…");
    return moveToSweep(routeSids[0], null, true)
      .then(function(){ return refreshPose(200); })
      // Settle: let any queued Sweep.current for the OLD position drain while
      // the lock is still on, so none of them can trigger a re-plan.
      .then(function(){ return wait(400); })
      .then(function(){
        currentSweepSid = routeSids[0];
        prevSweepSid = null;
        navLocked = false;
        // Fire-and-forget: a walk leg's auto-fly can run for the rest of the
        // journey (re-solving and continuing turn to turn), far longer than this
        // "settled at start" log below should wait for.
        beginLegNavigation();
      })
      .then(function(){
        scheduleTrailDraw(); updateDistDisplay(); setStatus("");
        console.info("[ThreeDNav] settled at start sweep", currentSweepSid,
          "remaining=" + Math.round(remainingMetres() || 0) + "m");
      })
      .catch(function(e){ navLocked = false; console.warn("[ThreeDNav] navigate failed", e); });
  }

  // ── Main connect ──────────────────────────────────────────────────────────────
  async function connectSdk(gen, fromPtMp) {
    var frame = $("n3dFrame");
    if (!frame) return;
    setStatus("Loading walkthrough…");
    try {
      await loadSdk();
      if (gen !== openGen) return;

      var sdk = await window.MP_SDK.connect(frame, appKey, "3.5");
      if (gen !== openGen) return;
      mpSdk = sdk;

      // CRITICAL: subscribe to Sweep.data IMMEDIATELY after connect, before
      // waiting for PLAYING. The collection emits once early; missing it means
      // the sweep graph has no data and routing cannot work.
      watchSweepData();

      // Subscribe to pose for trail drawing
      if (sdk.Camera && sdk.Camera.pose && sdk.Camera.pose.subscribe) {
        var sub = sdk.Camera.pose.subscribe(function(pose) {
          if (!pose || gen !== openGen) return;
          lastPose = pose;
          var sid = pose.sweepId || pose.sweep;
          if (sid) currentSweepSid = sid;
          if (navPts.length) scheduleTrailDraw();
        });
        unsubPose = function(){ try{ if(typeof sub==="function")sub(); else if(sub.cancel)sub.cancel(); }catch(_){} };
      }

      // Wait for showcase to be ready
      setStatus("Connecting to 3D scan…");
      await waitUntilPlaying(sdk);
      if (gen !== openGen) return;

      tryHideShowcaseBrand();
      silenceTags();

      // Read sweep graph (already being filled by watchSweepData)
      setStatus("Reading scan points…");
      sweeps = await readSweeps();
      if (gen !== openGen) return;
      resolveStairChains();   // sweep_numbers -> sids now that sweeps exists

      var edges = sweeps.reduce(function(n,sw){ return n+sw.neighbours.length; }, 0);
      console.info("[ThreeDNav] " + sweeps.length + " sweeps, " + edges + " links; worldToScreen=" + (sdk.Conversion&&sdk.Conversion.worldToScreen?"sdk":"local"));

      if (!sweeps.length) { setStatus("3D scan loaded but no scan points available"); return; }

      // Hook sweep-change watcher before navigating
      watchSweepChanges();

      // Plan route and teleport
      await runNavigate(fromPtMp);
      if (gen !== openGen) return;

    } catch(e) {
      if (gen !== openGen) return;
      console.warn("[ThreeDNav] error:", e);
      if (String(e&&e.message).indexOf("Key")>=0 || String(e&&e.message).indexOf("referrer")>=0) {
        setStatus("(Matterport key needs deployed domain — works on production)");
      } else {
        setStatus("3D scan overlay unavailable");
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  async function open(route) {
    var gen = ++openGen;

    // Teardown previous session
    if (unsubPose) { unsubPose(); unsubPose = null; }
    if (unsubSweep) { unsubSweep(); unsubSweep = null; }
    if (unsubSweepData) { unsubSweepData(); unsubSweepData = null; }
    if (drawRaf) { cancelAnimationFrame(drawRaf); drawRaf = 0; }
    mpSdk = null; lastPose = null; navPts = [];
    sweepCollection = null; sweeps = [];
    routeSids = []; routeLegs = []; activeLeg = 0;
    currentSweepSid = null; prevSweepSid = null; destSweepSid = null;
    noProgressSid = null; noProgressCount = 0;
    navLocked = false; arrivedShown = false;

    ensureOverlay();
    resolveConfig();

    // Extract route endpoints in NavMe Z-up, convert to Matterport Y-up
    var pts = route.navPath || route.smoothed || route.nodes || [];
    pts = pts.filter(function(p){ return isFinite(p.x) && isFinite(p.y); });
    if (pts.length < 2) {
      console.warn("[ThreeDNav] route has fewer than 2 points");
      return;
    }

    var fromPtMp = toMp(pts[0]);                    // FROM — nearest scan point to teleport to
    destPtMp     = toMp(pts[pts.length-1]);          // TO   — shown as destination pin
    // Store the full path in Matterport Y-up so sweepsAlongNavPath can use it.
    navPathMp    = pts.map(toMp);
    computeNavPathTurns();
    // The viewer's route object does not carry the destination label on every
    // path, so fall back to the Directions "to" field the user actually typed —
    // without it the arrival card reads a bare "Destination reached".
    destName = (route.to && (route.to.name || route.to.title)) ||
               (route.dest && (route.dest.name || route.dest.title)) ||
               (route.toName || route.destinationName) || "";
    if (!destName) {
      var toEl = document.getElementById("toQ");
      destName = (toEl && toEl.value || "").trim();
    }

    // Show overlay
    var ov = $(OVERLAY_ID);
    ov.hidden = false;
    document.body.classList.add("n3d-open");
    if (destName) {
      var title = $("n3dTitle");
      if (title) title.textContent = "To: " + destName;
    }

    var frame = $("n3dFrame");
    frame.src = showcaseUrl();

    connectSdk(gen, fromPtMp);
  }

  function close() {
    openGen++;
    if (unsubPose) { unsubPose(); unsubPose = null; }
    if (unsubSweep) { unsubSweep(); unsubSweep = null; }
    if (unsubSweepData) { unsubSweepData(); unsubSweepData = null; }
    if (drawRaf) { cancelAnimationFrame(drawRaf); drawRaf = 0; }
    mpSdk = null; lastPose = null; navPts = []; navPathMp = []; navPathTurns = [];
    sweepCollection = null; sweeps = [];
    routeSids = []; routeLegs = []; activeLeg = 0;
    currentSweepSid = null; prevSweepSid = null; destSweepSid = null;
    noProgressSid = null; noProgressCount = 0;
    navLocked = false; arrivedShown = false;
    var ov = $(OVERLAY_ID);
    if (ov) ov.hidden = true;
    var frame = $("n3dFrame");
    if (frame) frame.src = "about:blank";
    document.body.classList.remove("n3d-open");
    setStatus("");
  }

  // Diagnostics — read-only view of live state, for debugging from the console.
  window.ThreeDNav = {
    open: open,
    close: close,
    setStairChainRows: setStairChainRows,
    localizeFromImage: localizeFromImage,
    _debugRecompute: function(fromSid, toSid) {
      var fromSw = sweeps.filter(function(s){return s.sid===fromSid;})[0];
      var toSw = sweeps.filter(function(s){return s.sid===(toSid||destSweepSid);})[0];
      if (!fromSw || !toSw) return {error:"sweep not found", fromSw:!!fromSw, toSw:!!toSw};
      return {
        fromProj: projectPointOntoNavPath(fromSw.position),
        pathIdsRaw: sweepsAlongNavPath(5),
        fresh: computeRouteSids(fromSw, toSw),
        prevSweepSid: prevSweepSid
      };
    },
    get _debug() {
      return {
        sweeps: sweeps.length,
        routeSids: routeSids.slice(),
        currentSweepSid: currentSweepSid,
        startSid: routeSids[0] || null,
        atStart: currentSweepSid === routeSids[0],
        pose: lastPose ? { position: lastPose.position, rotation: lastPose.rotation } : null,
        startSweepPos: (sweeps.filter(function(s){ return s.sid === routeSids[0]; })[0] || {}).position || null,
        navPts: navPts.length,
        legs: routeLegs.length,
        activeLeg: activeLeg,
        remaining: remainingMetres(),
        routePoints: routeLegs.reduce(function(a, l){ return a.concat(l.points); }, []),
        navPathTurns: navPathTurns.length
      };
    }
  };
})();
