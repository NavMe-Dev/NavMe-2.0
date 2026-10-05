/* Platform runtime Config helpers (no bundler). Admin UI + node tests.
   Non-secrets editable; secrets are configured yes/no + write-only set/clear. */
(function (root) {
  "use strict";

  var NON_SECRETS = [
    "wf_chat_enabled",
    "wf_chat_llm_base_url",
    "wf_chat_llm_model",
    "wf_chat_rate_limit_per_min",
    "geocoder",
    "max_upload_mb",
    "public_base_url",
    "cors_origins",
    "vps_url"
  ];

  var SECRET_KEYS = [
    "WF_CHAT_LLM_API_KEY",
    "MATTERPORT_SDK_KEY",
    "JWT_SECRET",
    "DATABASE_URL",
    "WF_AR_VARIANT_LAUNCH_KEY"
  ];

  var SECRET_LABELS = {
    WF_CHAT_LLM_API_KEY: "Chat LLM API key",
    MATTERPORT_SDK_KEY: "Matterport Showcase SDK key",
    JWT_SECRET: "JWT secret",
    DATABASE_URL: "Database URL",
    WF_AR_VARIANT_LAUNCH_KEY: "Variant Launch (App Clip) key"
  };

  function asBool(v, dflt) {
    if (v === true || v === false) return v;
    if (v === "true" || v === 1 || v === "1") return true;
    if (v === "false" || v === 0 || v === "0") return false;
    return dflt;
  }

  function blankValues() {
    return {
      wf_chat_enabled: false,
      wf_chat_llm_base_url: "",
      wf_chat_llm_model: "gpt-4o-mini",
      wf_chat_rate_limit_per_min: 20,
      geocoder: "esri",
      max_upload_mb: 8192,
      public_base_url: "",
      cors_origins: "*",
      vps_url: ""
    };
  }

  function parsePayload(raw) {
    var p = raw && typeof raw === "object" ? raw : {};
    var vals = Object.assign(blankValues(), p.values || {});
    vals.wf_chat_enabled = asBool(vals.wf_chat_enabled, false);
    vals.wf_chat_rate_limit_per_min = Number(vals.wf_chat_rate_limit_per_min) || 20;
    vals.max_upload_mb = Number(vals.max_upload_mb) || 8192;
    var secrets = {};
    SECRET_KEYS.forEach(function (k) {
      secrets[k] = !!(p.secrets && p.secrets[k]);
    });
    return {
      values: vals,
      secrets: secrets,
      status: p.status || {},
      overlay_keys: p.overlay_keys || [],
      paths: p.paths || {},
      notes: p.notes || [],
      warnings: p.warnings || [],
      restart_hints: p.restart_hints || [],
      restart_note: p.restart_note || ""
    };
  }

  function serializeValues(state) {
    var v = state && state.values ? state.values : blankValues();
    return {
      wf_chat_enabled: !!v.wf_chat_enabled,
      wf_chat_llm_base_url: String(v.wf_chat_llm_base_url || "").trim(),
      wf_chat_llm_model: String(v.wf_chat_llm_model || "").trim(),
      wf_chat_rate_limit_per_min: Number(v.wf_chat_rate_limit_per_min) || 20,
      geocoder: String(v.geocoder || "esri").toLowerCase(),
      max_upload_mb: Number(v.max_upload_mb) || 8192,
      public_base_url: String(v.public_base_url || "").trim().replace(/\/$/, ""),
      cors_origins: String(v.cors_origins || "*").trim(),
      vps_url: String(v.vps_url || "").trim().replace(/\/$/, "")
    };
  }

  function buildPatch(state, secretDrafts, clearSecrets) {
    var body = { values: serializeValues(state) };
    var secrets = {};
    var clears = [];
    (SECRET_KEYS || []).forEach(function (k) {
      var d = (secretDrafts && secretDrafts[k]) || {};
      if (d.clear) clears.push(k);
      else if (d.value != null && String(d.value).length) secrets[k] = String(d.value);
    });
    (clearSecrets || []).forEach(function (k) {
      if (clears.indexOf(k) < 0) clears.push(k);
    });
    if (Object.keys(secrets).length) body.secrets = secrets;
    if (clears.length) body.clear_secrets = clears;
    return body;
  }

  function statusBadge(status) {
    var s = status || {};
    return {
      chat: s.chat_enabled ? (s.chat_configured ? "Chat on · LLM configured" : "Chat on · LLM not configured") : "Chat off",
      llm: s.llm_probe && s.llm_probe.reachable ? (s.llm_probe.ok ? "LLM reachable" : "LLM reachable (HTTP " + s.llm_probe.status + ")") : "LLM unreachable",
      vps: s.vps_configured ? "VPS configured" : "VPS not set",
      mp: s.matterport_key_present ? "Matterport key present" : "Matterport key missing",
      pub: s.public_base_url || "—"
    };
  }

  root.WFRuntimeConfig = {
    NON_SECRETS: NON_SECRETS,
    SECRET_KEYS: SECRET_KEYS,
    SECRET_LABELS: SECRET_LABELS,
    blankValues: blankValues,
    parsePayload: parsePayload,
    serializeValues: serializeValues,
    buildPatch: buildPatch,
    statusBadge: statusBadge
  };
})(typeof window !== "undefined" ? window : global);
