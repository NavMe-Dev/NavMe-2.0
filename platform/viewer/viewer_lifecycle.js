/* Privacy-safe, local-only lifecycle diagnostics. No URLs, keys, POIs or search text. */
(function (root) {
  "use strict";
  if (root.WFViewerLifecycle) return;
  const doc = root.document, events = [], counts = Object.create(null), frames = new WeakMap();
  const documentId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const allowedEvents = new Set(["document.load", "page.show", "page.hide", "page.visibility", "viewer.mount", "viewer.unmount",
    "iframe.create", "iframe.destroy", "iframe.source", "iframe.load", "iframe.context-observability", "sdk.init.start", "sdk.init.success",
    "sdk.init.failure", "model.change", "navigation", "loading", "app.phase", "javascript.error", "webgl.context.lost",
    "webgl.context.restored", "recovery", "operation.stale"]);
  const enums = {
    reason: new Set(["initial", "model-change", "reuse", "duplicate", "stale", "retry", "user", "failure", "timeout", "context-loss", "cleanup", "unknown"]),
    action: new Set(["search-open", "search-input", "search-close", "poi-select", "poi-details", "destination-select", "route-preview", "route-exit", "camera-focus", "camera-move", "camera-rotate", "camera-zoom", "sidebar", "building-change", "auth-retry", "background-open"]),
    phase: new Set(["idle", "loading", "connecting", "starting", "ready", "visible", "complete", "failed", "waiting", "playing", "paused", "error",
      "appphase.loading", "appphase.connecting", "appphase.starting", "appphase.waiting", "appphase.playing", "appphase.error"]),
    visibility: new Set(["visible", "hidden", "prerender", "unloaded"]),
    source: new Set(["none", "blank", "matterport", "other"]),
    previousSource: new Set(["none", "blank", "matterport", "other"]),
    scope: new Set(["parent", "same-origin-frame", "cross-origin-frame"]),
    kind: new Set(["javascript", "resource", "network", "authorization", "webgl", "unhandled-rejection", "unknown"]),
    navigationType: new Set(["navigate", "reload", "back_forward", "prerender", "unknown"])
  };
  let frame = null, sourceObserver = null, treeObserver = null, frameLoad = null, frameDocument = null;
  let frameSequence = 0, stopped = false;
  function fingerprint(value) {
    if (typeof value !== "string" || !value) return undefined;
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return "model-" + (hash >>> 0).toString(16);
  }
  function record(event, meta) {
    if (!allowedEvents.has(event) || stopped) return;
    const safe = {};
    for (const key of Object.keys(meta || {})) {
      const value = meta[key];
      if (enums[key] && enums[key].has(value)) safe[key] = value;
      else if (["attempt", "generation", "frameId", "revision", "durationMs", "modelVersion"].includes(key) && Number.isFinite(value) && value >= 0) safe[key] = value;
      else if (["persisted", "visible", "retryable", "discarded"].includes(key) && typeof value === "boolean") safe[key] = value;
      else if (key === "modelId" || key === "previousModelId") safe[key] = fingerprint(value);
    }
    const entry = {time: new Date().toISOString(), elapsedMs: Math.round(root.performance ? root.performance.now() : 0), event, ...safe};
    events.push(entry); if (events.length > 256) events.shift();
    counts[event] = (counts[event] || 0) + 1;
  }
  function describeSource(value) {
    if (!value) return {source: "none"};
    if (value === "about:blank") return {source: "blank"};
    try {
      const url = new URL(value, root.location.href);
      return {source: /(^|\.)matterport\.com$/i.test(url.hostname) ? "matterport" : "other", modelId: url.searchParams.get("m") || undefined};
    } catch (_) { return {source: "other"}; }
  }
  function contextLost(event) { record("webgl.context.lost", {scope: event.currentTarget === doc ? "parent" : "same-origin-frame"}); }
  function contextRestored(event) { record("webgl.context.restored", {scope: event.currentTarget === doc ? "parent" : "same-origin-frame"}); }
  function clearFrameDocument() {
    if (!frameDocument) return;
    frameDocument.removeEventListener("webglcontextlost", contextLost, true);
    frameDocument.removeEventListener("webglcontextrestored", contextRestored, true);
    frameDocument = null;
  }
  function releaseFrame(removed) {
    if (!frame) return;
    if (removed) record("iframe.destroy", {frameId: frames.get(frame).id});
    if (sourceObserver) sourceObserver.disconnect();
    if (frameLoad) frame.removeEventListener("load", frameLoad);
    clearFrameDocument(); sourceObserver = null; frameLoad = null; frame = null;
  }
  function bindFrame(next) {
    if (!next || stopped || frame === next) return;
    releaseFrame(true); frame = next;
    if (!frames.has(next)) frames.set(next, {id: ++frameSequence, revision: 0});
    const identity = frames.get(next);
    record("iframe.create", {frameId: identity.id});
    function sourceChanged(oldValue) {
      identity.revision++;
      record("iframe.source", {frameId: identity.id, revision: identity.revision,
        previousSource: describeSource(oldValue).source, ...describeSource(next.getAttribute("src"))});
    }
    if (next.getAttribute("src")) sourceChanged(null);
    sourceObserver = new MutationObserver(changes => changes.forEach(change => sourceChanged(change.oldValue)));
    sourceObserver.observe(next, {attributes: true, attributeFilter: ["src"], attributeOldValue: true});
    frameLoad = () => {
      record("iframe.load", {frameId: identity.id, revision: identity.revision, ...describeSource(next.getAttribute("src"))});
      clearFrameDocument();
      try {
        frameDocument = next.contentDocument;
        if (frameDocument) {
          frameDocument.addEventListener("webglcontextlost", contextLost, true);
          frameDocument.addEventListener("webglcontextrestored", contextRestored, true);
        }
      } catch (_) { frameDocument = null; }
      record("iframe.context-observability", {frameId: identity.id, scope: frameDocument ? "same-origin-frame" : "cross-origin-frame"});
    };
    next.addEventListener("load", frameLoad);
  }
  function scan(changes) {
    // Removing and reinserting the same iframe can reload its document even
    // when isConnected is already true again by the observer callback.
    const removed = frame && (changes || []).some(change => Array.from(change.removedNodes || []).some(node =>
      node === frame || (typeof node.contains === "function" && node.contains(frame))));
    if (frame && (removed || !frame.isConnected)) releaseFrame(true);
    const found = doc.getElementById("mpFrame");
    if (found) bindFrame(found);
  }
  function classify(error) {
    let value = "";
    try { value = String(error && (error.message || error.name) || ""); } catch (_) {}
    if (/webgl|context lost|gpu|out of memory/i.test(value)) return "webgl";
    if (/unauthori[sz]ed|forbidden|authentication/i.test(value)) return "authorization";
    if (/network|failed to fetch|load failed/i.test(value)) return "network";
    return "javascript";
  }
  function onError(event) { record("javascript.error", {kind: event.error ? classify(event.error) : typeof event.message === "string" ? "javascript" : "resource"}); }
  function onRejection(event) { record("javascript.error", {kind: classify(event.reason)}); }
  function onVisibility() { record("page.visibility", {visibility: doc.visibilityState}); }
  function onShow(event) { record("page.show", {persisted: event.persisted}); }
  function onHide(event) {
    record("page.hide", {persisted: event.persisted});
    if (!event.persisted) destroy(); // BFCache keeps the same document and viewer identity.
  }
  function destroy() {
    if (stopped) return;
    record("viewer.unmount", {reason: "cleanup"});
    releaseFrame(false); if (treeObserver) treeObserver.disconnect();
    root.removeEventListener("pageshow", onShow); root.removeEventListener("pagehide", onHide);
    root.removeEventListener("error", onError, true); root.removeEventListener("unhandledrejection", onRejection);
    doc.removeEventListener("visibilitychange", onVisibility);
    doc.removeEventListener("webglcontextlost", contextLost, true); doc.removeEventListener("webglcontextrestored", contextRestored, true);
    stopped = true;
  }
  root.WFViewerLifecycle = {
    record, bindFrame, destroy,
    snapshot: () => ({documentId, counts: {...counts}, events: events.map(entry => ({...entry})),
      limitations: ["Cross-origin iframe navigation and WebGL events require browser or SDK evidence; parent iframe load alone does not prove an iframe reload."]})
  };
  let navigationType = "unknown";
  try { navigationType = root.performance.getEntriesByType("navigation")[0].type; } catch (_) {}
  record("document.load", {navigationType, discarded:doc.wasDiscarded}); record("viewer.mount", {reason: "initial"});
  root.addEventListener("pageshow", onShow); root.addEventListener("pagehide", onHide);
  root.addEventListener("error", onError, true); root.addEventListener("unhandledrejection", onRejection);
  doc.addEventListener("visibilitychange", onVisibility);
  doc.addEventListener("webglcontextlost", contextLost, true); doc.addEventListener("webglcontextrestored", contextRestored, true);
  treeObserver = new MutationObserver(scan);
  treeObserver.observe(doc.documentElement, {childList: true, subtree: true}); scan();
})(window);
