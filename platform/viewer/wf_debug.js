/* Wayfinding client debug logger (no bundler).
   When platform debug is on (global or per-building), verbose console + batched POST
   to /api/v1/public/debug/logs for the admin Dashboard.
   Usage: WFDebug.init({ building, client }); WFDebug.info("tour", "hop", {i:1});
   Also hooks console.* while enabled (prefix [wf]). */
(function (root) {
  "use strict";

  var STATE = {
    enabled: false,
    building: null,
    client: "viewer",
    endpoint: "/api/v1/public/debug/logs",
    statusUrl: "/api/v1/public/debug/status",
    queue: [],
    timer: null,
    hooked: false,
    orig: null,
    pollTimer: null,
    lastStatusAt: 0
  };

  function now() { return Date.now() / 1000; }

  function flatten(args) {
    try {
      return Array.prototype.map.call(args, function (a) {
        if (a == null) return String(a);
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.name + ": " + a.message;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(" ");
    } catch (e) {
      return String(args);
    }
  }

  function enqueue(level, source, message, meta) {
    if (!STATE.enabled) return;
    var msg = String(message == null ? "" : message);
    if (msg.length > 3500) msg = msg.slice(0, 3500) + "…";
    STATE.queue.push({
      level: level || "info",
      source: source || "client",
      message: msg,
      building: STATE.building || undefined,
      ts: now(),
      meta: meta && typeof meta === "object" ? meta : undefined,
      client: STATE.client
    });
    if (STATE.queue.length >= 40) flush();
    else if (!STATE.timer) STATE.timer = setTimeout(flush, 1500);
  }

  function flush() {
    if (STATE.timer) { clearTimeout(STATE.timer); STATE.timer = null; }
    if (!STATE.enabled || !STATE.queue.length) { STATE.queue = []; return; }
    var batch = STATE.queue.splice(0, 100);
    var body = JSON.stringify({
      entries: batch,
      building: STATE.building || undefined,
      client: STATE.client
    });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(STATE.endpoint, blob)) return;
      }
    } catch (e) { /* fall through */ }
    try {
      fetch(STATE.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
        credentials: "same-origin"
      }).catch(function () {});
    } catch (e2) { /* ignore */ }
  }

  function hookConsole() {
    if (STATE.hooked) return;
    STATE.orig = {};
    ["debug", "log", "info", "warn", "error"].forEach(function (k) {
      var level = k === "log" ? "info" : k;
      STATE.orig[k] = console[k];
      console[k] = function () {
        try { STATE.orig[k].apply(console, arguments); } catch (e) {}
        if (!STATE.enabled) return;
        enqueue(level, "console." + STATE.client, flatten(arguments));
      };
    });
    STATE.hooked = true;
  }

  function unhookConsole() {
    if (!STATE.hooked || !STATE.orig) return;
    ["debug", "log", "info", "warn", "error"].forEach(function (k) {
      if (STATE.orig[k]) console[k] = STATE.orig[k];
    });
    STATE.hooked = false;
    STATE.orig = null;
  }

  function applyEnabled(on) {
    var was = STATE.enabled;
    STATE.enabled = !!on;
    if (STATE.enabled) {
      hookConsole();
      if (!was) enqueue("info", "wf_debug", "debug mode ON", { building: STATE.building, client: STATE.client });
    } else {
      if (was) {
        // one last flush of "off" via direct fetch won't work if gated; just stop
        STATE.queue = [];
      }
      unhookConsole();
    }
  }

  function fetchStatus() {
    var q = STATE.building ? ("?b=" + encodeURIComponent(STATE.building)) : "";
    return fetch(STATE.statusUrl + q, { cache: "no-store", credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        STATE.lastStatusAt = Date.now();
        applyEnabled(!!(j && j.enabled));
        return STATE.enabled;
      })
      .catch(function () { return STATE.enabled; });
  }

  function init(opts) {
    opts = opts || {};
    if (opts.building) STATE.building = String(opts.building);
    if (opts.client) STATE.client = String(opts.client);
    if (opts.endpoint) STATE.endpoint = opts.endpoint;
    if (opts.statusUrl) STATE.statusUrl = opts.statusUrl;
    // Hint from published config.json (may be stale vs live global toggle)
    if (opts.hint === true) applyEnabled(true);
    fetchStatus();
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollTimer = setInterval(fetchStatus, 12000);
    try {
      window.addEventListener("pagehide", flush);
      window.addEventListener("beforeunload", flush);
    } catch (e) {}
    return api;
  }

  function setBuilding(slug) {
    STATE.building = slug ? String(slug) : null;
    fetchStatus();
  }

  var api = {
    init: init,
    setBuilding: setBuilding,
    refresh: fetchStatus,
    isEnabled: function () { return !!STATE.enabled; },
    flush: flush,
    log: function (level, source, message, meta) { enqueue(level, source, message, meta); },
    debug: function (source, message, meta) { enqueue("debug", source, message, meta); },
    info: function (source, message, meta) { enqueue("info", source, message, meta); },
    warn: function (source, message, meta) { enqueue("warn", source, message, meta); },
    error: function (source, message, meta) { enqueue("error", source, message, meta); }
  };

  root.WFDebug = api;
})(typeof window !== "undefined" ? window : globalThis);
