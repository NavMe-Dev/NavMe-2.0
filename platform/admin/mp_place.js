/* Matterport Showcase placer for admin (no bundler).
   Connects SDK when applicationKey + whitelisted host allow it.
   Converts Showcase Y-up positions to Matterport model Z-up XY used by pipeline doors.
   Exposes window.MpPlace. */
(function (root) {
  "use strict";

  const SDK_BOOTSTRAP = "https://static.matterport.com/showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js";
  let sdkScriptPromise = null;

  /** Model Z-up (x,y horizontal) ↔ Showcase Camera / Sweep Y-up (x, y-up, z≈-y). */
  function modelToSdk(p) {
    if (!p || p.x == null || p.y == null) return null;
    return { x: +p.x, y: (p.z != null ? +p.z : 0), z: -(+p.y) };
  }

  function sdkToModel(p) {
    if (!p || p.x == null || p.z == null) return null;
    return { x: +p.x, y: -(+p.z), z: (p.y != null ? +p.y : 0) };
  }

  function round3(n) {
    return Math.round(Number(n) * 1000) / 1000;
  }

  function loadSdkScript() {
    if (root.MP_SDK) return Promise.resolve();
    if (sdkScriptPromise) return sdkScriptPromise;
    sdkScriptPromise = new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = SDK_BOOTSTRAP;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load Matterport SDK bootstrap")); };
      document.head.appendChild(s);
    });
    return sdkScriptPromise;
  }

  function phaseConsts(sdk) {
    const P = (sdk && sdk.App && sdk.App.Phase) || {};
    return {
      PLAYING: P.PLAYING || "appphase.playing",
      WAITING: P.WAITING || "appphase.waiting",
      STARTING: P.STARTING || "appphase.starting",
      LOADING: P.LOADING || "appphase.loading",
      ERROR: P.ERROR || "appphase.error"
    };
  }

  async function readPhase(sdk) {
    try {
      if (sdk.App && sdk.App.state && typeof sdk.App.state.getLatest === "function") {
        const st = sdk.App.state.getLatest();
        if (st && st.phase) return st.phase;
      }
    } catch (_) { /* ignore */ }
    return await new Promise(function (resolve) {
      let done = false;
      let unsub = null;
      const fin = function (p) {
        if (done) return;
        done = true;
        try { if (unsub) unsub(); } catch (_) { /* ignore */ }
        resolve(p);
      };
      try { unsub = sdk.App.state.subscribe(function (st) { fin(st && st.phase); }); }
      catch (_) { fin(null); }
      setTimeout(function () { fin(null); }, 1500);
    });
  }

  async function waitPlaying(sdk, timeoutMs, onWaiting) {
    if (!sdk || !sdk.App || !sdk.App.state) return false;
    const Ph = phaseConsts(sdk);
    const deadline = Date.now() + (timeoutMs || 60000);
    let prompted = false;
    while (Date.now() < deadline) {
      const phase = await readPhase(sdk);
      if (phase === Ph.ERROR) return false;
      if (phase === Ph.PLAYING) return true;
      if ((phase === Ph.WAITING || phase === Ph.LOADING || phase === Ph.STARTING || !phase) && !prompted) {
        prompted = true;
        if (typeof onWaiting === "function") onWaiting(phase || Ph.WAITING);
      }
      const remaining = Math.max(500, deadline - Date.now());
      try {
        await Promise.race([
          sdk.App.state.waitUntil(function (st) { return st && st.phase === Ph.PLAYING; }),
          new Promise(function (r) { setTimeout(r, Math.min(4000, remaining)); })
        ]);
      } catch (_) {
        await new Promise(function (r) { setTimeout(r, 400); });
      }
    }
    return false;
  }

  function waitIframeLoad(iframe, timeoutMs) {
    return new Promise(function (resolve) {
      let settled = false;
      const done = function () {
        if (settled) return;
        settled = true;
        iframe.removeEventListener("load", onLoad);
        resolve();
      };
      const onLoad = function () {
        try {
          const src = iframe.getAttribute("src") || "";
          if (!src || src === "about:blank") return;
        } catch (_) { /* ignore */ }
        done();
      };
      iframe.addEventListener("load", onLoad);
      setTimeout(done, timeoutMs || 12000);
    });
  }

  function isEphemeralHost() {
    try {
      const h = location.hostname || "";
      return /\.trycloudflare\.com$/i.test(h) || /\.loca\.lt$/i.test(h) || /\.ngrok/i.test(h);
    } catch (_) { return false; }
  }

  function domainHint() {
    const host = (typeof location !== "undefined" && location.host) || "this host";
    let msg = "Whitelist “" + host + "” under Matterport → Account Settings → Developer Tools → SDK key domains. ";
    if (isEphemeralHost()) {
      msg += "trycloudflare hosts often fail whitelist; open Spatial Studio on http://127.0.0.1:8780 (or a stable domain) for twin click-to-place. ";
    }
    msg += "Map and typed model XY still work.";
    return msg;
  }

  /**
   * Attach SDK to an iframe already pointing at Showcase (with applicationKey in URL).
   * Returns a session object or throws / returns {ok:false, error}.
   */
  async function connect(opts) {
    const iframe = opts && opts.iframe;
    const applicationKey = (opts && opts.applicationKey) || "";
    const onStatus = (opts && opts.onStatus) || function () {};
    if (!iframe) return { ok: false, error: "No iframe" };
    if (!applicationKey) {
      return { ok: false, error: "Matterport SDK key not configured on the server.", hint: domainHint() };
    }

    onStatus("Loading Matterport SDK…");
    try { await loadSdkScript(); }
    catch (e) {
      return { ok: false, error: (e && e.message) || "SDK bootstrap failed", hint: domainHint() };
    }
    if (!root.MP_SDK || !root.MP_SDK.connect) {
      return { ok: false, error: "MP_SDK.connect unavailable after bootstrap.", hint: domainHint() };
    }

    onStatus("Connecting SDK…");
    let sdk = null;
    try {
      sdk = await root.MP_SDK.connect(iframe, applicationKey, "");
    } catch (e) {
      return {
        ok: false,
        error: (e && (e.message || String(e))) || "SDK connect failed",
        hint: domainHint()
      };
    }

    onStatus("Waiting for twin (tap Enter in Showcase if stuck on launch)…");
    const ready = await waitPlaying(sdk, (opts && opts.timeoutMs) || 90000, function () {
      onStatus("Tap Enter inside the Matterport window to leave the launch screen…");
    });
    if (!ready) {
      try { if (sdk.disconnect) sdk.disconnect(); } catch (_) { /* ignore */ }
      return {
        ok: false,
        error: "Showcase never reached PLAYING (launch screen or domain block).",
        hint: domainHint()
      };
    }

    let lastHit = null;
    let currentSweep = null;
    const unsubs = [];

    try {
      if (sdk.Pointer && sdk.Pointer.intersection && sdk.Pointer.intersection.subscribe) {
        unsubs.push(sdk.Pointer.intersection.subscribe(function (hit) {
          if (!hit || !hit.position) return;
          lastHit = {
            position: { x: hit.position.x, y: hit.position.y, z: hit.position.z },
            normal: hit.normal ? { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } : null,
            object: hit.object,
            floorIndex: hit.floorIndex != null ? hit.floorIndex : hit.floorId,
            at: Date.now()
          };
        }));
      }
    } catch (_) { /* ignore */ }

    try {
      if (sdk.Sweep && sdk.Sweep.current && sdk.Sweep.current.subscribe) {
        unsubs.push(sdk.Sweep.current.subscribe(function (sw) {
          currentSweep = sw || null;
        }));
      }
    } catch (_) { /* ignore */ }

    function pointerModelXY() {
      if (!lastHit || !lastHit.position) return null;
      const m = sdkToModel(lastHit.position);
      if (!m) return null;
      const out = { x: round3(m.x), y: round3(m.y), z: round3(m.z), source: "pointer", object: lastHit.object };
      if (lastHit.normal) {
        const n = sdkToModel(lastHit.normal);
        if (n) out.normal = { x: round3(n.x), y: round3(n.y), z: round3(n.z) };
        out.normalSdk = { x: +lastHit.normal.x, y: +lastHit.normal.y, z: +lastHit.normal.z };
      }
      return out;
    }

    function sweepModelXY() {
      const sw = currentSweep;
      if (!sw || !sw.sid) return null;
      const pos = sw.position || (sw.puckPosition) || null;
      if (!pos) return null;
      const m = sdkToModel(pos);
      if (!m) return null;
      return {
        x: round3(m.x),
        y: round3(m.y),
        z: round3(m.z),
        source: "sweep",
        sid: sw.sid,
        floorSequence: sw.floorInfo && sw.floorInfo.sequence
      };
    }

    function disconnect() {
      unsubs.forEach(function (u) {
        try { if (typeof u === "function") u(); } catch (_) { /* ignore */ }
      });
      try { if (sdk && sdk.disconnect) sdk.disconnect(); } catch (_) { /* ignore */ }
      sdk = null;
      lastHit = null;
      currentSweep = null;
    }

    onStatus("Connected. Aim at the door (pointer) or stand at a sweep, then place.");
    return {
      ok: true,
      sdk: sdk,
      disconnect: disconnect,
      pointerModelXY: pointerModelXY,
      sweepModelXY: sweepModelXY,
      hasPointer: function () { return !!(lastHit && lastHit.position); },
      hasSweep: function () { return !!(currentSweep && currentSweep.sid && currentSweep.position); }
    };
  }

  /** Parse applicationKey from a Showcase URL if present. */
  function keyFromShowcaseUrl(url) {
    try {
      const m = String(url || "").match(/[?&]applicationKey=([^&#]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    } catch (_) { return ""; }
  }

  root.MpPlace = {
    modelToSdk: modelToSdk,
    sdkToModel: sdkToModel,
    round3: round3,
    loadSdkScript: loadSdkScript,
    waitIframeLoad: waitIframeLoad,
    connect: connect,
    keyFromShowcaseUrl: keyFromShowcaseUrl,
    domainHint: domainHint,
    isEphemeralHost: isEphemeralHost
  };
})(typeof window !== "undefined" ? window : globalThis);
