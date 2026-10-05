/* NavMe Spatial Assistant admin chat (Option 4 phase 1).
   Floating FAB on all admin pages when JWT present.
   POST /api/v1/admin/chat with Bearer token. No LLM keys in the browser.
   Sends full Studio hash context (building + tab + path) on every turn. */
(function () {
  const API_CHAT = "/api/v1/admin/chat";
  const TAB_LABELS = {
    overview: "Overview",
    georef: "Georeference",
    floors: "Floors",
    elevators: "Elevators",
    media: "Media",
    tour: "Tour",
    access: "Access",
    pois: "POIs",
    routes: "Routes",
    publish: "Publish",
    jobs: "Jobs",
    dashboard: "Dashboard",
    buildings: "Buildings",
    wizard: "Add building",
    "scan-plans": "Scan planning",
    "scan-plan": "Scan plan",
    login: "Login",
    debug: "Dashboard",
  };
  const STATE = {
    open: false,
    busy: false,
    enabled: false,
    configured: true,
    history: [],
    token: "",
  };

  function $(id) { return document.getElementById(id); }

  function readToken() {
    try {
      if (window.WFAdminStore && WFAdminStore.token) return WFAdminStore.token;
      return localStorage.getItem("wf_admin_token") || "";
    } catch (_) { return ""; }
  }

  /** Parse location.hash into { path, building, tab, page }. */
  function routeContext() {
    let h = "";
    try { h = (location.hash || "").replace(/^#/, ""); } catch (_) { h = ""; }
    h = (h || "/").trim() || "/";
    if (h.charAt(0) !== "/") h = "/" + h;
    const out = { path: h, building: null, tab: null, page: "buildings" };
    if (h === "/" || h === "") {
      out.page = "buildings";
      out.tab = "buildings";
      return out;
    }
    if (h === "/dashboard" || h === "/debug") {
      out.page = "dashboard";
      out.tab = "dashboard";
      return out;
    }
    if (h === "/new") {
      out.page = "wizard";
      out.tab = "wizard";
      return out;
    }
    if (h === "/scan-plan" || h === "/scan-plans") {
      out.page = "scan-plans";
      out.tab = "scan-plans";
      return out;
    }
    let m = h.match(/^\/scan-plan\/([^/]+)/);
    if (m) {
      out.page = "scan-plan";
      out.tab = "scan-plan";
      return out;
    }
    m = h.match(/^\/b\/([^/]+)(?:\/([a-z][\w-]*))?/);
    if (m) {
      try { out.building = decodeURIComponent(m[1]); } catch (_) { out.building = m[1]; }
      out.tab = (m[2] || "overview").toLowerCase();
      out.page = "building";
      return out;
    }
    if (h === "/login") {
      out.page = "login";
      out.tab = "login";
      return out;
    }
    out.page = "buildings";
    out.tab = "buildings";
    return out;
  }

  function buildingSlug() {
    return routeContext().building;
  }

  function shortBuildingLabel(slug) {
    if (!slug) return "";
    // Prefer short alias for known long slugs in subtitle
    if (slug.indexOf("gcu") === 0) return "GCU";
    if (slug.indexOf("4926-tacoma") === 0) return "Tacoma";
    if (slug.indexOf("greenland") === 0) return "Greenland";
    if (slug.indexOf("11328") === 0) return "11328";
    // Truncate long slugs
    return slug.length > 18 ? slug.slice(0, 16) + "…" : slug;
  }

  function contextSubtitle() {
    const ctx = routeContext();
    const tabLabel = TAB_LABELS[ctx.tab] || (ctx.tab ? ctx.tab : null);
    if (ctx.building && tabLabel) {
      return shortBuildingLabel(ctx.building) + " · " + tabLabel;
    }
    if (ctx.building) return shortBuildingLabel(ctx.building) + " · Access, jobs, routes…";
    if (tabLabel && ctx.page !== "buildings") return tabLabel + " · Ask NavMe Spatial Assistant…";
    return "Ask NavMe Spatial Assistant about Access, buildings, jobs, routes…";
  }

  function updateSubtitle() {
    const sub = $("wfAdminChatSub");
    if (sub && STATE.enabled) sub.textContent = contextSubtitle();
  }

  function localeHint() {
    try {
      if (window.WFi18n && typeof WFi18n.getLang === "function") return WFi18n.getLang();
      if (window.WFi18n && typeof WFi18n.getLocale === "function") return WFi18n.getLocale();
      return document.documentElement.lang || "en";
    } catch (_) { return "en"; }
  }

  function ensureDom() {
    if ($("wfAdminChatRoot")) return;
    const root = document.createElement("div");
    root.id = "wfAdminChatRoot";
    root.className = "wf-chat-root wf-admin-chat-root";
    root.hidden = true;
    root.innerHTML = `
      <button type="button" id="wfAdminChatFab" class="wf-chat-fab" aria-label="Open NavMe Spatial Assistant" aria-controls="wfAdminChatPanel" aria-expanded="false">
        <img class="wf-chat-fab-logo" src="img/navme-logo.png" alt="" width="42" height="42">
      </button>
      <div id="wfAdminChatPanel" class="wf-chat-panel" role="dialog" aria-modal="false" aria-labelledby="wfAdminChatTitle" hidden>
        <header class="wf-chat-head">
          <div class="wf-chat-title-wrap">
            <img class="wf-chat-brand-logo" src="img/navme-logo.png" alt="NavMe Spatial Assistant" width="32" height="32">
            <div>
              <div id="wfAdminChatTitle" class="wf-chat-title">NavMe Spatial Assistant</div>
              <div id="wfAdminChatSub" class="wf-chat-sub">Ask NavMe Spatial Assistant about Access, buildings, jobs, routes…</div>
            </div>
          </div>
          <button type="button" id="wfAdminChatClose" class="wf-chat-ib" aria-label="Close NavMe Spatial Assistant"><span class="ms">close</span></button>
        </header>
        <div id="wfAdminChatLog" class="wf-chat-log" role="log" aria-live="polite"></div>
        <form id="wfAdminChatForm" class="wf-chat-form" autocomplete="off">
          <input id="wfAdminChatInput" type="text" maxlength="800" placeholder="What does twin=pin mean?" aria-label="Message for NavMe Spatial Assistant" />
          <button type="submit" id="wfAdminChatSend" class="wf-chat-send" aria-label="Send message to NavMe Spatial Assistant"><span class="ms fill">send</span></button>
        </form>
      </div>`;
    document.body.appendChild(root);
    $("wfAdminChatFab").addEventListener("click", () => setOpen(!STATE.open));
    $("wfAdminChatClose").addEventListener("click", () => setOpen(false));
    $("wfAdminChatForm").addEventListener("submit", onSubmit);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && STATE.open) setOpen(false);
    });
    window.addEventListener("hashchange", () => {
      updateSubtitle();
    });
  }

  function setOpen(open) {
    STATE.open = !!open;
    const panel = $("wfAdminChatPanel");
    const fab = $("wfAdminChatFab");
    if (!panel || !fab) return;
    panel.hidden = !STATE.open;
    fab.setAttribute("aria-expanded", STATE.open ? "true" : "false");
    fab.classList.toggle("on", STATE.open);
    if (STATE.open) {
      updateSubtitle();
      if (!$("wfAdminChatLog").children.length) {
        addBubble("assistant", welcomeText());
      }
      setTimeout(() => { try { $("wfAdminChatInput").focus(); } catch (_) {} }, 50);
    }
  }

  function welcomeText() {
    if (!STATE.configured) {
      return "NavMe Spatial Assistant is on, but no LLM is configured on the server. Set WF_CHAT_LLM_BASE_URL (and API key if needed), or point it at local Ollama.";
    }
    const ctx = routeContext();
    if (ctx.building) {
      const tabLabel = TAB_LABELS[ctx.tab] || ctx.tab || "Overview";
      return (
        "Hi - I'm NavMe Spatial Assistant. You're on " + tabLabel +
        " for " + ctx.building +
        ". Ask about Access, entrances, jobs, or routes here — I use this building context. Read-only; use the Access tab to Save or Publish."
      );
    }
    return "Hi - I'm NavMe Spatial Assistant. Ask about Access, buildings, jobs, or routes. Open a building (#/b/<slug>/…) for building context. Read-only.";
  }

  function setBubbleContent(div, text, actions) {
    if (!div) return;
    let body = div.querySelector(".wf-chat-text");
    if (!body) {
      body = document.createElement("div");
      body.className = "wf-chat-text";
      div.appendChild(body);
    }
    body.textContent = text || "";
    const existing = div.querySelector(".wf-chat-actions");
    if (existing) existing.remove();
    if (actions && actions.length) {
      const row = document.createElement("div");
      row.className = "wf-chat-actions";
      actions.forEach((a) => {
        if (!a || a.type !== "deep_link" || !a.url) return;
        const btn = document.createElement("a");
        btn.className = "wf-chat-chip";
        btn.href = a.url;
        const isAdminHash = a.intent === "admin_nav" || /^#\/b\//.test(a.url) || /\/admin\/#\/b\//.test(a.url);
        if (isAdminHash) {
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            let h = a.url;
            const hashIdx = h.indexOf("#");
            if (hashIdx >= 0) h = h.slice(hashIdx + 1);
            else h = h.replace(/^\/?/, "");
            try { location.hash = h; } catch (_) {}
          });
        } else {
          btn.target = "_blank";
          btn.rel = "noopener";
        }
        btn.textContent = a.label || (isAdminHash ? "Open in Studio" : "Open viewer");
        row.appendChild(btn);
      });
      if (row.children.length) div.appendChild(row);
    }
  }

  function addBubble(role, text, actions) {
    const log = $("wfAdminChatLog");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "wf-chat-bubble " + (role === "user" ? "user" : "assistant");
    setBubbleContent(div, text, actions);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (STATE.busy) return;
    const tok = readToken();
    if (!tok) {
      addBubble("assistant", "Sign in to use NavMe Spatial Assistant.");
      syncVisibility();
      return;
    }
    const input = $("wfAdminChatInput");
    const text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    addBubble("user", text);
    STATE.history.push({ role: "user", content: text });
    STATE.busy = true;
    $("wfAdminChatSend").disabled = true;
    addBubble("assistant", "…");
    const pending = $("wfAdminChatLog").lastElementChild;
    const ctx = routeContext();
    try {
      const r = await fetch(API_CHAT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + tok,
        },
        body: JSON.stringify({
          messages: STATE.history.slice(-10),
          building: ctx.building,
          tab: ctx.tab,
          path: ctx.path,
          page: ctx.page,
          route: ctx.path,
          locale: localeHint(),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401) {
        setBubbleContent(pending, "Session expired - please sign in again.", []);
        return;
      }
      if (!r.ok) {
        const msg = (data && (data.detail || data.message)) || ("Chat error " + r.status);
        setBubbleContent(pending, typeof msg === "string" ? msg : JSON.stringify(msg), []);
        return;
      }
      const reply = data.message || "(empty reply)";
      if (data.configured === false) STATE.configured = false;
      STATE.history.push({ role: "assistant", content: reply });
      setBubbleContent(pending, reply, data.actions || []);
    } catch (err) {
      setBubbleContent(pending, "Network error talking to chat. Try again.", []);
      console.warn("wf_admin_chat", err);
    } finally {
      STATE.busy = false;
      $("wfAdminChatSend").disabled = false;
      try { $("wfAdminChatLog").scrollTop = $("wfAdminChatLog").scrollHeight; } catch (_) {}
    }
  }

  function syncVisibility() {
    ensureDom();
    const tok = readToken();
    STATE.token = tok;
    // Show when logged in; chat_enabled is enforced by API (404 if off).
    STATE.enabled = !!tok;
    const root = $("wfAdminChatRoot");
    if (!root) return;
    root.hidden = !STATE.enabled;
    if (!STATE.enabled) {
      setOpen(false);
      STATE.history = [];
      const log = $("wfAdminChatLog");
      if (log) log.innerHTML = "";
    } else {
      updateSubtitle();
    }
  }

  function openAssistant(prefill) {
    syncVisibility();
    if (!STATE.enabled) return;
    setOpen(true);
    if (prefill) {
      try { $("wfAdminChatInput").value = prefill; $("wfAdminChatInput").focus(); } catch (_) {}
    }
  }

  function init() {
    ensureDom();
    syncVisibility();
    // Poll token lightly (Vue store / localStorage after login)
    setInterval(syncVisibility, 1500);
  }

  window.WFAdminChat = {
    init, setOpen, openAssistant, syncVisibility, STATE,
    buildingSlug, routeContext, contextSubtitle,
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
