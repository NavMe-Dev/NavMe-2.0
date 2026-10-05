/* NavMe public chat widget (Option 3 phase 1).
   Floating FAB + sheet; same-origin POST /api/v1/public/chat. No LLM keys in the browser. */
(function () {
  const API_CONFIG = "/api/v1/public/config";
  const API_CHAT = "/api/v1/public/chat";
  const STATE = { open: false, busy: false, enabled: false, configured: true, history: [] };

  function $(id) { return document.getElementById(id); }

  function buildingSlug() {
    try {
      if (window.WF && WF.building && WF.building.slug) return WF.building.slug;
      const q = new URLSearchParams(location.search);
      return q.get("b") || null;
    } catch (_) { return null; }
  }

  function localeHint() {
    try {
      if (window.WFi18n && typeof WFi18n.getLang === "function") return WFi18n.getLang();
      return document.documentElement.lang || "en";
    } catch (_) { return "en"; }
  }

  function ensureDom() {
    if ($("wfChatRoot")) return;
    const root = document.createElement("div");
    root.id = "wfChatRoot";
    root.className = "wf-chat-root";
    root.hidden = true;
    root.innerHTML = `
      <button type="button" id="wfChatFab" class="wf-chat-fab fab" aria-label="Open wayfinding chat" aria-controls="wfChatPanel" aria-expanded="false">
        <span class="ms fill" aria-hidden="true">chat</span>
      </button>
      <div id="wfChatPanel" class="wf-chat-panel" role="dialog" aria-modal="false" aria-labelledby="wfChatTitle" hidden>
        <header class="wf-chat-head">
          <div class="wf-chat-title-wrap">
            <span class="ms fill" aria-hidden="true">smart_toy</span>
            <div>
              <div id="wfChatTitle" class="wf-chat-title">NavMe assistant</div>
              <div id="wfChatSub" class="wf-chat-sub">Ask about places and directions</div>
            </div>
          </div>
          <button type="button" id="wfChatClose" class="ib sm" aria-label="Close chat"><span class="ms">close</span></button>
        </header>
        <div id="wfChatLog" class="wf-chat-log" role="log" aria-live="polite"></div>
        <form id="wfChatForm" class="wf-chat-form" autocomplete="off">
          <input id="wfChatInput" type="text" maxlength="800" placeholder="Where is the bathroom?" aria-label="Chat message" />
          <button type="submit" id="wfChatSend" class="wf-chat-send" aria-label="Send"><span class="ms fill">send</span></button>
        </form>
      </div>`;
    document.body.appendChild(root);
    $("wfChatFab").addEventListener("click", () => setOpen(!STATE.open));
    $("wfChatClose").addEventListener("click", () => setOpen(false));
    $("wfChatForm").addEventListener("submit", onSubmit);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && STATE.open) setOpen(false);
    });
  }

  function setOpen(open) {
    STATE.open = !!open;
    const panel = $("wfChatPanel");
    const fab = $("wfChatFab");
    if (!panel || !fab) return;
    panel.hidden = !STATE.open;
    fab.setAttribute("aria-expanded", STATE.open ? "true" : "false");
    fab.classList.toggle("on", STATE.open);
    if (STATE.open) {
      if (!$("wfChatLog").children.length) {
        addBubble("assistant", welcomeText());
      }
      setTimeout(() => { try { $("wfChatInput").focus(); } catch (_) {} }, 50);
    }
  }

  function welcomeText() {
    if (!STATE.configured) {
      return "Chat UI is on, but no LLM is configured on the server. Ask an admin to set WF_CHAT_LLM_BASE_URL (and API key if needed), or point it at local Ollama.";
    }
    const b = buildingSlug();
    return b
      ? `Hi — ask me about places in this building (${b}), or for walking directions. I only use published map data.`
      : "Hi — ask which buildings are published, or pick a building (?b=) and ask for places / directions.";
  }

  function formatPoiLabel(h) {
    if (!h || typeof h !== "object") return "Place";
    const name = (h.name || h.id || "Place");
    const codeRaw = (h.code != null ? String(h.code) : "").trim();
    const code = codeRaw && codeRaw.toLowerCase() !== String(name).toLowerCase() ? ` (${codeRaw})` : "";
    const floor = h.floor != null && h.floor !== "" ? `, floor ${h.floor}` : "";
    return `${name}${code}${floor}`;
  }

  function actionFromHit(h, slug) {
    const id = h && (h.id || h.key);
    if (!id || !slug) return null;
    const params = new URLSearchParams({ b: slug, to: id });
    return {
      type: "deep_link",
      url: "/?" + params.toString(),
      poi_id: id,
      label: formatPoiLabel(h),
      intent: "select",
      name: h.name || undefined,
      floor: h.floor != null ? h.floor : undefined,
    };
  }

  /** Never show raw tool JSON in the bubble — format POI lists if the server/LLM slipped. */
  function humanizeReply(text, actions) {
    const raw = (text == null ? "" : String(text)).trim();
    const outActions = Array.isArray(actions) ? actions.slice() : [];
    if (!raw) return { text: raw, actions: outActions };
    const looksJson = /^\s*\{/.test(raw) || /"results"\s*:/.test(raw) || /```(?:json)?/.test(raw);
    if (!looksJson) return { text: raw, actions: outActions };
    let payload = null;
    try {
      let t = raw;
      const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (fence) t = fence[1].trim();
      payload = JSON.parse(t);
    } catch (_) {
      const m = raw.match(/\{\s*"results"\s*:/);
      if (m) {
        const start = m.index;
        let depth = 0, end = -1;
        for (let i = start; i < raw.length; i++) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end > start) {
          try { payload = JSON.parse(raw.slice(start, end)); } catch (__) { payload = null; }
        }
      }
    }
    if (!payload || typeof payload !== "object") return { text: raw, actions: outActions };
    const hits = Array.isArray(payload.results) ? payload.results : null;
    if (hits) {
      if (!hits.length) {
        return { text: "I could not find that place in the published catalogue.", actions: outActions };
      }
      const slug = payload.slug || buildingSlug();
      const head = hits.length === 1
        ? "I found this place — tap to show it on the map:"
        : "I found these places — tap one to show it on the map:";
      if (slug && !outActions.length) {
        hits.slice(0, 8).forEach((h) => {
          const a = actionFromHit(h, slug);
          if (a) outActions.push(a);
        });
      } else {
        // Enrich existing actions with labels when missing
        enrichActionLabels(outActions, hits);
      }
      return { text: head, actions: outActions };
    }
    if (payload.poi && typeof payload.poi === "object") {
      const h = payload.poi;
      const slug = payload.slug || buildingSlug();
      if (slug && !outActions.length) {
        const a = actionFromHit(h, slug);
        if (a) outActions.push(a);
      } else {
        enrichActionLabels(outActions, [h]);
      }
      return { text: "I found this place — tap to show it on the map:", actions: outActions };
    }
    if (payload.results || payload.poi || payload.buildings || payload.length_m != null) {
      return { text: "I found matching places on the map. Please try asking again.", actions: outActions };
    }
    return { text: raw, actions: outActions };
  }

  function enrichActionLabels(actions, hits) {
    if (!actions || !hits) return;
    const byId = {};
    hits.forEach((h) => {
      const id = h && (h.id || h.key);
      if (id) byId[id] = h;
    });
    actions.forEach((a) => {
      if (!a || a.label) return;
      let id = a.poi_id;
      if (!id && a.url) {
        try { id = new URL(a.url, location.origin).searchParams.get("to"); } catch (_) {}
      }
      if (id && byId[id]) {
        a.poi_id = id;
        a.label = formatPoiLabel(byId[id]);
        if (!a.intent) a.intent = "select";
      }
    });
  }

  function labelForAction(a) {
    if (!a) return "Place";
    if (a.label) return a.label;
    if (a.name) {
      const floor = a.floor != null && a.floor !== "" ? `, floor ${a.floor}` : "";
      return a.name + floor;
    }
    if (a.intent === "directions") return "Open directions";
    try {
      const to = a.url ? new URL(a.url, location.origin).searchParams.get("to") : null;
      if (to && !/^poi_/i.test(to)) return to;
    } catch (_) {}
    return a.intent === "directions" ? "Open directions" : "Show on map";
  }

  function poiIdFromAction(a) {
    if (!a) return null;
    if (a.poi_id) return a.poi_id;
    try {
      return a.url ? new URL(a.url, location.origin).searchParams.get("to") : null;
    } catch (_) { return null; }
  }

  function renderActions(container, actions) {
    if (!container || !actions || !actions.length) return;
    const existing = container.querySelector(".wf-chat-actions");
    if (existing) existing.remove();
    const row = document.createElement("div");
    row.className = "wf-chat-actions";
    actions.forEach((a) => {
      if (!a || a.type !== "deep_link" || !a.url) return;
      const btn = document.createElement("button");
      btn.type = "button";
      const intent = a.intent || (function () {
        try {
          return new URL(a.url, location.origin).searchParams.get("from") ? "directions" : "select";
        } catch (_) { return "select"; }
      })();
      btn.className = "wf-chat-chip" + (intent === "directions" ? " dirs" : "");
      const icon = intent === "directions" ? "directions" : "location_on";
      const label = labelForAction(a);
      btn.innerHTML = `<span class="ms fill" aria-hidden="true">${icon}</span><span class="wf-chat-chip-label"></span>`;
      btn.querySelector(".wf-chat-chip-label").textContent = label;
      btn.title = intent === "directions" ? `Directions to ${label}` : `Show ${label} on map`;
      btn.setAttribute("aria-label", btn.title);
      btn.addEventListener("click", () => applyDeepLink(a));
      row.appendChild(btn);
    });
    if (row.children.length) container.appendChild(row);
  }

  function setBubbleContent(div, text, actions) {
    if (!div) return;
    let body = div.querySelector(".wf-chat-text");
    if (!body) {
      body = document.createElement("div");
      body.className = "wf-chat-text";
      div.appendChild(body);
    }
    const acts = Array.isArray(actions) ? actions : [];
    // When we have labeled place chips, prefer a short intro (drop bullet dump to avoid duplicate list)
    let display = text || "";
    if (acts.some((a) => a && a.label) && /\n\s*-\s+/.test(display)) {
      const first = display.split("\n").find((ln) => ln.trim() && !/^\s*-\s+/.test(ln));
      display = (first || "I found these places — tap one to show it on the map:").trim();
    }
    body.textContent = display;
    renderActions(div, acts);
  }

  function addBubble(role, text, actions) {
    const log = $("wfChatLog");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "wf-chat-bubble " + (role === "user" ? "user" : "assistant");
    setBubbleContent(div, text, actions);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function applyDeepLink(actionOrUrl) {
    try {
      const a = typeof actionOrUrl === "string" ? { type: "deep_link", url: actionOrUrl } : (actionOrUrl || {});
      const u = new URL(a.url, location.origin);
      const to = a.poi_id || u.searchParams.get("to");
      const from = u.searchParams.get("from");
      const step = u.searchParams.get("mode") === "stepfree";
      const b = u.searchParams.get("b");
      const curB = buildingSlug();
      const intent = a.intent || (from ? "directions" : "select");
      if (b && curB && b !== curB) {
        location.href = u.pathname + u.search;
        return;
      }
      if (window.wfUI && to) {
        if (intent === "directions" || from) {
          if (typeof wfUI.openDirections === "function") {
            wfUI.openDirections(from || null, to, step);
            setOpen(false);
            return;
          }
        }
        if (typeof wfUI.selectPlace === "function") {
          wfUI.selectPlace(to);
          setOpen(false);
          return;
        }
      }
      location.href = u.pathname + u.search;
    } catch (e) {
      console.warn("wf_chat deep_link", e);
      try {
        location.href = typeof actionOrUrl === "string" ? actionOrUrl : actionOrUrl.url;
      } catch (_) {}
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (STATE.busy) return;
    const input = $("wfChatInput");
    const text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    addBubble("user", text);
    STATE.history.push({ role: "user", content: text });
    STATE.busy = true;
    $("wfChatSend").disabled = true;
    addBubble("assistant", "…");
    const pending = $("wfChatLog").lastElementChild;
    try {
      const r = await fetch(API_CHAT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: STATE.history.slice(-10),
          building: buildingSlug(),
          locale: localeHint(),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (data && (data.detail || data.message)) || ("Chat error " + r.status);
        setBubbleContent(pending, typeof msg === "string" ? msg : JSON.stringify(msg), []);
        return;
      }
      const rawReply = data.message || "(empty reply)";
      if (data.configured === false) STATE.configured = false;
      const humanized = humanizeReply(rawReply, data.actions || []);
      const reply = humanized.text || rawReply;
      STATE.history.push({ role: "assistant", content: reply });
      setBubbleContent(pending, reply, humanized.actions || []);
    } catch (err) {
      setBubbleContent(pending, "Network error talking to chat. Try again.", []);
      console.warn("wf_chat", err);
    } finally {
      STATE.busy = false;
      $("wfChatSend").disabled = false;
      try { $("wfChatLog").scrollTop = $("wfChatLog").scrollHeight; } catch (_) {}
    }
  }

  async function init() {
    ensureDom();
    let enabled = false;
    let configured = true;
    try {
      const r = await fetch(API_CONFIG, { cache: "no-store" });
      if (r.ok) {
        const cfg = await r.json();
        enabled = !!cfg.chat_enabled;
        configured = cfg.chat_configured !== false;
      }
    } catch (_) { enabled = false; }
    STATE.enabled = enabled;
    STATE.configured = configured;
    const root = $("wfChatRoot");
    if (!root) return;
    root.hidden = !enabled;
    if (!enabled) return;
    const sub = $("wfChatSub");
    if (sub && !configured) sub.textContent = "LLM not configured — replies explain setup";
  }

  window.WFChat = { init, setOpen, STATE, humanizeReply, applyDeepLink, formatPoiLabel };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { init(); });
  } else {
    init();
  }
})();
