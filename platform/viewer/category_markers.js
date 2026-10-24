/* Optional Matterport dollhouse labels. No renderer, camera, or scene ownership. */
(function (root) {
  "use strict";
  const DEFAULTS = { heightOffset: 2, maxClusterGap: 25 };
  function numeric(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function options(raw) {
    const height = numeric(raw && raw.heightOffset), gap = numeric(raw && raw.maxClusterGap);
    return { heightOffset: height != null && height >= 0 ? height : DEFAULTS.heightOffset,
      maxClusterGap: gap != null && gap > 0 ? gap : DEFAULTS.maxClusterGap };
  }
  function components(points, gap) {
    const unseen = new Set(points.map((_, i) => i)), sizes = [];
    while (unseen.size) {
      const first = unseen.values().next().value, queue = [first];
      unseen.delete(first);
      for (let at = 0; at < queue.length; at++) {
        const a = points[queue[at]];
        for (const i of unseen) {
          const b = points[i];
          if (Math.hypot(a.x - b.x, a.z - b.z) <= gap) { unseen.delete(i); queue.push(i); }
        }
      }
      sizes.push(queue.length);
    }
    return sizes;
  }
  function calculate(categories, pois, config) {
    const { heightOffset, maxClusterGap } = options(config);
    const venue = config && config.venue;
    const markers = [], diagnostics = [], eligible = new Map();
    for (const c of categories || []) {
      if (c && c.id && String(c.name || "").trim()) eligible.set(String(c.id), { ...c, id: String(c.id), points: new Map() });
    }
    for (const p of pois || []) {
      if (!p || !p.id || !venue || p.venue !== venue || p.is_active === false || p.hidden === true) continue;
      const xyz = [p.x, p.y, p.z].map(numeric);
      if (xyz.includes(null)) continue;
      for (const id of new Set(p.category_ids || [])) {
        const c = eligible.get(String(id));
        if (c) c.points.set(String(p.id), { id: String(p.id), x: xyz[0], y: xyz[1], z: xyz[2] });
      }
    }
    for (const c of eligible.values()) {
      const points = [...c.points.values()];
      if (!points.length) {
        diagnostics.push({ categoryId: c.id, name: c.name, reason: "no-valid-pois" }); continue;
      }
      const groups = components(points, maxClusterGap);
      if (groups.length > 1) {
        diagnostics.push({ categoryId: c.id, name: c.name, reason: "distant-clusters", groups, maxClusterGap }); continue;
      }
      const position = { x: points.reduce((sum, p) => sum + p.x / points.length, 0),
        y: points.reduce((highest, p) => Math.max(highest, p.y), -Infinity) + heightOffset,
        z: points.reduce((sum, p) => sum + p.z / points.length, 0) };
      if (!Object.values(position).every(Number.isFinite)) {
        diagnostics.push({ categoryId: c.id, name: c.name, reason: "invalid-center" }); continue;
      }
      const { points: ignored, ...category } = c;
      markers.push({ ...category, position, poiIds: points.map(p => p.id) });
    }
    markers.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
    return { markers, diagnostics };
  }
  function isVisible(state) {
    return !!state && state.background === true && state.rendered === true && state.mode === "mode.dollhouse"
      && !state.transitioning && !state.blocked && !state.fullscreenTour && !state.failed
      && !["dir", "nav"].includes(state.uiMode);
  }
  function project(position, pose, iframeRect, containerRect, size, convert) {
    if (!pose || !pose.position || !pose.rotation || !size.w || !size.h) return null;
    // Same SDK forward-vector convention as threed_nav.js's camera-facing logic.
    const yaw = pose.rotation.y * Math.PI / 180, pitch = pose.rotation.x * Math.PI / 180;
    const cp = Math.cos(pitch), dx = position.x - pose.position.x,
      dy = position.y - pose.position.y, dz = position.z - pose.position.z;
    const depth = dx * -Math.sin(yaw) * cp + dy * Math.sin(pitch) + dz * -Math.cos(yaw) * cp;
    if (!Number.isFinite(depth) || depth <= 0.001) return null;
    let point;
    try { point = convert(position, pose, size); } catch (_) { return null; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    // The iframe is cropped/oversized to hide Showcase chrome. Project in its
    // actual viewport, then map into the visible wrapper (including the -56px crop).
    const x = iframeRect.left - containerRect.left + point.x * iframeRect.width / size.w;
    const y = iframeRect.top - containerRect.top + point.y * iframeRect.height / size.h;
    if (x < 0 || y < 0 || x > containerRect.width || y > containerRect.height) return null;
    return { x, y };
  }
  function overlaps(a, b, margin = 4) {
    return a.left < b.right + margin && a.right + margin > b.left && a.top < b.bottom + margin && a.bottom + margin > b.top;
  }
  // Place compact labels near their real projected anchors. Try several stable
  // packing orders and prefer the one that keeps the most labels, then the one
  // with the least movement. World coordinates never change.
  function layout(items, bounds, mobile, obstacles = []) {
    const padding = 6, gap = mobile ? 3 : 4, maxShift = mobile ? 120 : 80;
    const choices = new Map();
    for (const item of items) {
      const base = item.rect, row = base.bottom - base.top + gap;
      const column = Math.min((base.right - base.left) * 0.6, mobile ? 72 : 54);
      const shifts = [[0, 0]];
      if (item.previous) shifts.push([item.previous.x, item.previous.y]);
      for (const y of [0, -row, row, -2 * row, 2 * row, -3 * row, 3 * row]) {
        for (const x of [0, -column, column]) shifts.push([x, y]);
      }
      const seen = new Set(), candidates = [];
      for (const shift of shifts) {
        // Keep the entire pill inside the visible viewport, even near an edge.
        const x = Math.max(bounds.left + padding - base.left,
          Math.min(shift[0], bounds.right - padding - base.right));
        const y = Math.max(bounds.top + padding - base.top,
          Math.min(shift[1], bounds.bottom - padding - base.bottom));
        const key = Math.round(x) + "," + Math.round(y);
        if (seen.has(key) || Math.hypot(x, y) > maxShift) continue;
        seen.add(key);
        const rect = { left: base.left + x, right: base.right + x, top: base.top + y, bottom: base.bottom + y };
        if (rect.left < bounds.left + padding || rect.right > bounds.right - padding
            || rect.top < bounds.top + padding || rect.bottom > bounds.bottom - padding) continue;
        const previous = item.previous || { x: 0, y: 0 };
        candidates.push({ x, y, rect, score: x * x + y * y + 2 * ((x - previous.x) ** 2 + (y - previous.y) ** 2) });
      }
      candidates.sort((a, b) => a.score - b.score);
      choices.set(item.id, candidates);
    }
    const orders = [items,
      items.slice().sort((a, b) => choices.get(a.id).length - choices.get(b.id).length),
      items.slice().sort((a, b) => a.rect.top - b.rect.top),
      items.slice().reverse()];
    let best = new Map(), bestScore = Infinity;
    for (const bias of [0, -1, 1]) for (const order of orders) {
      const placed = new Map(), occupied = obstacles.slice();
      let score = 0;
      for (const item of order) {
        // Side-first passes can fit two columns where always choosing the
        // central position would waste every row on a single label.
        const column = Math.min((item.rect.right - item.rect.left) * 0.6, mobile ? 72 : 54);
        const candidates = bias ? choices.get(item.id).slice().sort((a, b) =>
          ((a.x - bias * column) ** 2 + a.y ** 2) - ((b.x - bias * column) ** 2 + b.y ** 2)) : choices.get(item.id);
        const candidate = candidates.find(option => !occupied.some(rect => overlaps(option.rect, rect, gap)));
        if (!candidate) continue;
        placed.set(item.id, candidate); occupied.push(candidate.rect); score += candidate.score;
      }
      if (placed.size > best.size || (placed.size === best.size && score < bestScore)) { best = placed; bestScore = score; }
    }
    return best;
  }
  function cancel(subscription) {
    if (typeof subscription === "function") subscription();
    else if (subscription && subscription.cancel) subscription.cancel();
    else if (subscription && subscription.unsubscribe) subscription.unsubscribe();
  }
  function mount({ sdk, iframe, container, getContext, getStyle, onSelect, config = {}, fetchData, diagnostic }) {
    if (!sdk || !sdk.Camera || !sdk.Camera.pose || !sdk.Conversion || !sdk.Conversion.worldToScreen || !container) return null;
    const doc = container.ownerDocument, win = doc.defaultView;
    const layer = doc.createElement("div");
    layer.id = "mpCategoryMarkers"; layer.className = "mp-category-markers"; layer.hidden = true;
    layer.setAttribute("role", "group"); layer.setAttribute("aria-label", "Place categories");
    container.appendChild(layer);
    let disposed = false, raf = null, pose = null, mode = null, transitioning = false;
    let source = null, request = 0, abort = null, venue = null, entries = [], lastPois = null, lastFilter = null, dirty = true;
    const subscriptions = [], reported = new Set();
    function report(item) {
      const key = JSON.stringify(item);
      if (reported.has(key)) return;
      reported.add(key);
      if (diagnostic) diagnostic(item);
      else console.warn("[Category markers]", item);
    }
    function schedule() {
      if (!disposed && raf === null) raf = win.requestAnimationFrame(() => { raf = null; render(); });
    }
    async function load(nextVenue) {
      const ticket = ++request;
      if (abort) abort.abort();
      abort = new win.AbortController();
      venue = nextVenue; source = null; dirty = true; reported.clear(); schedule();
      if (!venue) return;
      try {
        const data = await fetchData(venue, abort.signal);
        if (disposed || ticket !== request || data.building_slug !== venue) return;
        source = data; dirty = true; schedule();
      } catch (error) {
        if (!disposed && ticket === request && (!error || error.name !== "AbortError")) report({ venue, reason: "data-unavailable" });
      }
    }
    function rebuild(context) {
      entries.forEach(entry => entry.button.remove()); entries = [];
      if (!source || !context || context.venue !== venue || !Array.isArray(context.pois)) return;
      const ids = new Set(context.pois.filter(p => p.hidden !== true && p.is_active !== false).map(p => String(p.id)));
      const categories = context.filter && context.filter !== "__all__"
        ? (source.categories || []).filter(c => String(c.name || "").trim().toLowerCase() === context.filter)
        : source.categories;
      const result = calculate(categories, (source.pois || []).filter(p => ids.has(String(p.id))), { ...config, venue });
      result.diagnostics.forEach(report);
      for (const marker of result.markers) {
        const style = (getStyle ? getStyle(marker) : null) || {};
        const button = doc.createElement("button");
        button.type = "button"; button.className = "mp-category-marker"; button.hidden = true; button.disabled = context.uiReady === false;
        const label = style.label || marker.name;
        button.setAttribute("aria-label", label);
        const icon = doc.createElement("span"); icon.className = "ms mp-category-icon";
        icon.setAttribute("aria-hidden", "true"); icon.textContent = style.icon || "place";
        const color = Array.isArray(style.color) && style.color.length === 3 && style.color.every(v => Number.isFinite(v) && v >= 0 && v <= 255)
          ? `rgb(${style.color.join(",")})` : "#8ab4f8";
        button.style.setProperty("--category-color", color);
        const name = doc.createElement("span"); name.className = "mp-category-name"; name.textContent = label;
        const pin = doc.createElement("span"); pin.className = "ms mp-category-pin"; pin.textContent = "place"; pin.setAttribute("aria-hidden", "true");
        const leader = doc.createElement("span"); leader.className = "mp-category-leader";
        leader.setAttribute("aria-hidden", "true"); leader.hidden = true;
        button.title = label;
        button.append(icon, name, pin, leader);
        button.onclick = event => {
          event.stopPropagation();
          const now = visibility();
          if (isVisible(now)) onSelect(marker.id, marker.poiIds, marker.name);
        };
        layer.appendChild(button); entries.push({ marker, button, pin, leader, offset: null });
      }
    }
    function visibility() {
      const context = getContext() || {};
      const body = doc.body.classList;
      const bundle = doc.getElementById("bundleOverlay");
      return { ...context, mode: mode && pose && pose.mode && mode !== pose.mode ? null : (mode || (pose && pose.mode)), transitioning,
        background: body.contains("mp-bg-mode"), rendered: body.contains("mp-frame-loaded"),
        blocked: body.contains("nav") || body.contains("dir") || body.contains("n3d-open")
          || !!(bundle && !bundle.hidden && bundle.style.display !== "none"),
        fullscreenTour: !!win.__WF_MP_TOUR_PAGE || !!win.__WF_NAV_WALKTHROUGH_PAGE,
        failed: !!doc.querySelector("#mpBgLoading.err") };
    }
    function render() {
      if (disposed) return;
      const context = getContext() || {};
      if (context.venue && context.venue !== venue) { void load(context.venue); }
      if (dirty || context.pois !== lastPois || context.filter !== lastFilter) {
        lastPois = context.pois; lastFilter = context.filter; dirty = false; rebuild(context);
      }
      layer.hidden = !source || !pose || !isVisible(visibility());
      if (layer.hidden || !pose) return;
      const bounds = container.getBoundingClientRect(), frame = iframe.getBoundingClientRect();
      const size = { w: iframe.clientWidth, h: iframe.clientHeight }, candidates = [];
      for (const entry of entries) {
        const point = project(entry.marker.position, pose, frame, bounds, size, sdk.Conversion.worldToScreen);
        const button = entry.button;
        button.hidden = !point;
        if (!point) continue;
        button.style.left = point.x + "px"; button.style.top = point.y + "px";
        candidates.push({ id: entry.marker.id, point, entry, rect: button.getBoundingClientRect(), previous: entry.offset });
      }
      const obstacles = ["searchBox", "dirBox", "chipsWrap", "weatherBadge", "ctrlsTop", "ctrls", "sheet"]
        .map(id => doc.getElementById(id)).filter(el => el && !el.hidden && el.getClientRects().length)
        .map(el => el.getBoundingClientRect());
      const placed = layout(candidates, bounds, bounds.width <= 600, obstacles);
      for (const item of candidates) {
        const placement = placed.get(item.id), { button, leader } = item.entry;
        button.hidden = !placement;
        if (!placement) continue;
        item.entry.offset = { x: placement.x, y: placement.y };
        button.style.left = (item.point.x + placement.x) + "px";
        button.style.top = (item.point.y + placement.y) + "px";
        const moved = Math.hypot(placement.x, placement.y) >= 2;
        item.entry.pin.hidden = moved;
        // Join the nearest pill edge to the true world anchor; never draw a
        // connector through its own label when the label is below the point.
        const anchorX = bounds.left + item.point.x, anchorY = bounds.top + item.point.y;
        const edgeX = Math.max(placement.rect.left, Math.min(anchorX, placement.rect.right));
        const edgeY = Math.max(placement.rect.top, Math.min(anchorY, placement.rect.bottom));
        const dx = anchorX - edgeX, dy = anchorY - edgeY, length = Math.hypot(dx, dy);
        leader.hidden = !moved || length < 2;
        leader.style.left = (edgeX - placement.rect.left) + "px";
        leader.style.top = (edgeY - placement.rect.top) + "px";
        leader.style.width = length + "px";
        leader.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      }
    }
    function refresh() { dirty = true; schedule(); }
    function reload() {
      const context = getContext() || {};
      void load(context.venue);
    }
    try {
      subscriptions.push(sdk.Camera.pose.subscribe(next => { pose = next; if (next && next.mode !== "mode.dollhouse") layer.hidden = true; schedule(); }));
      if (sdk.Mode && sdk.Mode.current) subscriptions.push(sdk.Mode.current.subscribe(next => { mode = next; if (next !== "mode.dollhouse") layer.hidden = true; schedule(); }));
      if (sdk.Mode && sdk.Mode.transition) subscriptions.push(sdk.Mode.transition.subscribe(next => { transitioning = !!(next && (next.from || next.to)); if (transitioning) layer.hidden = true; schedule(); }));
      if (sdk.Camera.pose.getLatest) pose = sdk.Camera.pose.getLatest();
      if (sdk.Mode && sdk.Mode.current && sdk.Mode.current.getLatest) mode = sdk.Mode.current.getLatest();
    } catch (error) { report({ reason: "camera-unavailable" }); }
    const observer = new win.MutationObserver(schedule);
    observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
    const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
    if (resize) { resize.observe(container); resize.observe(iframe); }
    win.addEventListener("resize", schedule);
    win.addEventListener("wf-weather-updated", schedule);
    win.addEventListener("wf-category-style", refresh);
    win.addEventListener("wf-pois-updated", reload);
    doc.addEventListener("visibilitychange", schedule);
    function dispose() {
      if (disposed) return;
      disposed = true; request++;
      if (abort) abort.abort();
      if (raf !== null) win.cancelAnimationFrame(raf);
      subscriptions.forEach(sub => { try { cancel(sub); } catch (_) {} });
      observer.disconnect(); if (resize) resize.disconnect();
      win.removeEventListener("resize", schedule);
      win.removeEventListener("wf-weather-updated", schedule);
      win.removeEventListener("wf-category-style", refresh);
      win.removeEventListener("wf-pois-updated", reload);
      win.removeEventListener("pagehide", onPageHide);
      win.removeEventListener("pageshow", schedule);
      doc.removeEventListener("visibilitychange", schedule);
      layer.remove(); entries = [];
    }
    function onPageHide(event) {
      if (event.persisted) layer.hidden = true; // Safari back/forward cache keeps the SDK alive.
      else dispose();
    }
    win.addEventListener("pagehide", onPageHide);
    win.addEventListener("pageshow", schedule);
    const context = getContext() || {};
    void load(context.venue);
    return { refresh, reload, dispose, get diagnostics() { return [...reported].map(item => JSON.parse(item)); } };
  }
  const api = { calculate, components, isVisible, project, overlaps, layout, options, mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WFCategoryMarkers = api;
})(typeof window !== "undefined" ? window : globalThis);
