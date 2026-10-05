/* Shared UI i18n for viewer + admin. Vanilla JSON dictionaries (no bundler).
   Load: <script src="/locales/i18n.js"></script> then await WFi18n.init({ enabled, base }).
   POI/room names are not translated — only UI chrome. */
(function (global) {
  "use strict";
  const LS = "wf_lang";
  const RTL = new Set(["ar", "he", "fa", "ur"]);
  const CATALOG = [
    { code: "en", native: "English" },
    { code: "es", native: "Español" },
    { code: "fr", native: "Français" },
    { code: "de", native: "Deutsch" },
    { code: "hi", native: "हिन्दी" },
    { code: "kn", native: "ಕನ್ನಡ" },
    { code: "ar", native: "العربية" }
  ];
  const CACHE = {};
  let dict = {};
  let locale = "en";
  let enabled = ["en"];
  let base = "/locales";
  const listeners = [];

  function lookup(obj, key) {
    if (!obj || !key) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === "string") return obj[key];
    const parts = key.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[p];
    }
    return typeof cur === "string" ? cur : undefined;
  }

  function t(key, vars) {
    let s = lookup(dict, key);
    if (s == null && locale !== "en" && CACHE.en) s = lookup(CACHE.en, key);
    if (s == null) s = key;
    if (!vars) return s;
    return s.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  }

  function normalizeEnabled(list) {
    const allow = new Set(CATALOG.map(c => c.code));
    const s = new Set();
    (Array.isArray(list) ? list : ["en"]).forEach(c => { if (allow.has(c)) s.add(c); });
    s.add("en");
    return CATALOG.map(c => c.code).filter(c => s.has(c));
  }

  function resolveBase(explicit) {
    if (explicit) return explicit.replace(/\/?$/, "");
    // Prefer absolute /locales (FastAPI mount / viewer symlink); fall back to relative.
    const path = location.pathname || "/";
    if (path.indexOf("/admin") === 0) return "/locales";
    return "/locales";
  }

  async function fetchLocale(code) {
    if (CACHE[code]) return CACHE[code];
    const r = await fetch(base + "/" + code + ".json", { cache: "no-cache" });
    if (!r.ok) throw new Error("locale " + code + " " + r.status);
    const j = await r.json();
    CACHE[code] = j;
    return j;
  }

  function applyDocument(code, meta) {
    const dir = (meta && meta.dir) || (RTL.has(code) ? "rtl" : "ltr");
    document.documentElement.lang = code;
    document.documentElement.dir = dir;
    document.documentElement.setAttribute("data-locale", code);
  }

  function applyDom(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(el => {
      const k = el.getAttribute("data-i18n");
      if (k) el.textContent = t(k);
    });
    scope.querySelectorAll("[data-i18n-html]").forEach(el => {
      const k = el.getAttribute("data-i18n-html");
      if (k) el.innerHTML = t(k);
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      const k = el.getAttribute("data-i18n-placeholder");
      if (k) el.setAttribute("placeholder", t(k));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
      const k = el.getAttribute("data-i18n-aria-label");
      if (k) el.setAttribute("aria-label", t(k));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach(el => {
      const k = el.getAttribute("data-i18n-title");
      if (k) el.setAttribute("title", t(k));
    });
  }

  async function setLocale(code, opts) {
    opts = opts || {};
    if (!CATALOG.some(c => c.code === code)) code = "en";
    if (!enabled.includes(code)) code = enabled[0] || "en";
    let data;
    try {
      data = await fetchLocale(code);
    } catch (e) {
      if (code !== "en") {
        code = "en";
        data = await fetchLocale("en");
      } else throw e;
    }
    if (!CACHE.en && code !== "en") {
      try { await fetchLocale("en"); } catch (e) { /* ignore */ }
    }
    dict = data;
    locale = code;
    if (opts.persist !== false) {
      try { localStorage.setItem(LS, code); } catch (e) { /* ignore */ }
    }
    applyDocument(code, data.meta);
    applyDom();
    listeners.slice().forEach(fn => { try { fn(code); } catch (e) { console.error(e); } });
    return code;
  }

  function setEnabled(list) {
    enabled = normalizeEnabled(list);
    if (!enabled.includes(locale)) {
      return setLocale(enabled[0] || "en");
    }
    return Promise.resolve(locale);
  }

  function enabledCatalog() {
    return CATALOG.filter(c => enabled.includes(c.code));
  }

  function mountSwitcher(el, opts) {
    if (!el) return null;
    opts = opts || {};
    const sel = document.createElement("select");
    sel.className = (opts.className || "wf-lang-switch") + "";
    sel.setAttribute("aria-label", t("common.language"));
    function refill() {
      const cur = locale;
      sel.innerHTML = "";
      enabledCatalog().forEach(c => {
        const o = document.createElement("option");
        o.value = c.code;
        o.textContent = c.native;
        if (c.code === cur) o.selected = true;
        sel.appendChild(o);
      });
      sel.hidden = enabledCatalog().length < 2 && !opts.alwaysShow;
    }
    refill();
    sel.onchange = () => { setLocale(sel.value); };
    el.innerHTML = "";
    if (opts.label !== false) {
      const lab = document.createElement("label");
      lab.className = "wf-lang-label";
      lab.appendChild(document.createTextNode(""));
      const span = document.createElement("span");
      span.setAttribute("data-i18n", "common.language");
      span.textContent = t("common.language");
      lab.appendChild(span);
      lab.appendChild(sel);
      el.appendChild(lab);
    } else {
      el.appendChild(sel);
    }
    const unsub = onChange(() => { refill(); sel.setAttribute("aria-label", t("common.language")); applyDom(el); });
    return { el: sel, refresh: refill, destroy: unsub };
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  async function init(opts) {
    opts = opts || {};
    base = resolveBase(opts.base);
    enabled = normalizeEnabled(opts.enabled);
    let want = opts.locale;
    if (!want) {
      try { want = localStorage.getItem(LS) || ""; } catch (e) { want = ""; }
    }
    if (!want || !enabled.includes(want)) want = enabled[0] || "en";
    await setLocale(want, { persist: !!localStorage.getItem(LS) });
    return api;
  }

  const api = {
    t, init, setLocale, setEnabled, getLocale: () => locale, getEnabled: () => enabled.slice(),
    catalog: CATALOG, enabledCatalog, applyDom, mountSwitcher, onChange, RTL,
    ready: null
  };
  global.WFi18n = api;
})(typeof window !== "undefined" ? window : globalThis);
