/**
 * GMap Structure panel — sidebar for superadmin sessions.
 * Slug is resolved from the Matterport SID via the wayfinding API,
 * so slug-drift between Supabase and wayfinding never breaks sync.
 */
import { adminGmapUpsertBuilding, adminGmapGetBuilding, adminGmapSyncPois, fetchMatterportSidForProject, getSupabaseAnonKey } from '../services/supabase.js';
import { getSuperadminSession } from '../config/superadmin.js';
import { getPoiType } from '../config/poi-session.js';
import { parseMatterportModelId } from '../services/matterport-url.js';
import { showToast } from './toast.js';

async function wfFetch(baseUrl, path, opts = {}) {
  const headers = { 'x-supabase-anon-key': getSupabaseAnonKey(), ...opts.headers };
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { ...opts, headers });
}

// The wayfinding slug is URL-safe; our poi_type is free text ("POI Navme") and is what
// Supabase matches on. Hand both over so the wizard doesn't have to guess one from the
// other — slugifying the poi_type is exactly what makes the POI sync come back empty.
function openWizard(url, slug, sid, poiType) {
  const params = new URLSearchParams({ slug, sid: sid || '', poi_type: poiType || '', anon_key: getSupabaseAnonKey() });
  window.open(`${url}/admin/#/new?${params}`, '_blank');
}

const inputStyle = 'width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--color-border,#ddd);border-radius:7px;font-size:13px;background:var(--color-surface,#fff)';
const labelStyle = 'font-size:12px;font-weight:500;display:block;margin-bottom:3px';

function panelHtml() {
  return `
<div class="gmap-panel" style="display:flex;flex-direction:column;height:100%;overflow:hidden">
  <div style="padding:16px 16px 10px;border-bottom:1px solid var(--color-border,#e5e7eb)">
    <h2 style="font-size:15px;font-weight:600;margin:0 0 3px">NavMe GMap Structure</h2>
    <p style="font-size:12px;opacity:.6;margin:0" id="gmap-p-subtitle"></p>
  </div>

  <!-- STEP: need wayfinding URL -->
  <div id="gmap-step-url" style="flex:1;overflow-y:auto;padding:14px 16px">
    <p style="font-size:13px;margin:0 0 12px">Enter the wayfinding server URL to link this project.</p>
    <label style="${labelStyle}">Wayfinding Server URL</label>
    <input id="gmap-p-wfurl" type="url" placeholder="http://127.0.0.1:8780" style="${inputStyle};margin-bottom:14px" autocomplete="off">
    <button type="button" id="gmap-url-go" class="btn-start" style="width:100%;font-size:13px;padding:9px">Connect</button>
    <p id="gmap-url-status" style="font-size:12px;opacity:.7;margin:8px 0 0;text-align:center"></p>
  </div>

  <!-- STEP: loading -->
  <div id="gmap-step-loading" style="display:none;padding:20px 16px;font-size:13px;opacity:.65">Loading…</div>

  <!-- STEP: manage -->
  <div id="gmap-step-manage" style="display:none;flex:1;overflow-y:auto;padding:14px 16px">

    <!-- Building detail card -->
    <div style="background:var(--color-surface-2,#f5f5f5);border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px" id="gmap-m-name">—</div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;line-height:1.6;opacity:.8" id="gmap-m-details"></div>
    </div>

    <!-- Onboarding banner: shown when building not yet ready -->
    <div id="gmap-m-onboarding" style="display:none;background:#fff8ed;border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.5">
      <strong>⚠️ Onboarding required</strong><br>
      Complete building setup in Wayfinding Admin: enter details, upload MatterPak, run the pipeline.
      <div id="gmap-m-status-badge" style="margin-top:4px;opacity:.65;font-size:11px"></div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px">
      <button type="button" id="gmap-p-open" class="btn-start" style="font-size:13px;padding:9px">Open Wayfinding Admin</button>
      <button type="button" id="gmap-p-sync" style="font-size:13px;padding:9px;background:var(--color-surface-2,#f0f0f0);border:1px solid var(--color-border,#ddd);border-radius:8px;cursor:pointer">Sync POIs → Wayfinding</button>
    </div>
    <p id="gmap-m-status" style="font-size:12px;opacity:.7;margin:10px 0 0;text-align:center"></p>
  </div>
</div>`;
}

export function createGmapPanel(slot) {
  if (!slot) return { show() {}, hide() {}, load() {} };

  slot.innerHTML = panelHtml();

  const subtitleEl   = slot.querySelector('#gmap-p-subtitle');
  const stepUrl      = slot.querySelector('#gmap-step-url');
  const stepLoading  = slot.querySelector('#gmap-step-loading');
  const stepManage   = slot.querySelector('#gmap-step-manage');
  const wfUrlEl      = slot.querySelector('#gmap-p-wfurl');
  const urlGoBtn     = slot.querySelector('#gmap-url-go');
  const urlStatus    = slot.querySelector('#gmap-url-status');
  const mNameEl      = slot.querySelector('#gmap-m-name');
  const mDetailsEl   = slot.querySelector('#gmap-m-details');
  const mOnboarding  = slot.querySelector('#gmap-m-onboarding');
  const mStatusBadge = slot.querySelector('#gmap-m-status-badge');
  const openBtn      = slot.querySelector('#gmap-p-open');
  const syncBtn      = slot.querySelector('#gmap-p-sync');
  const manageStatus = slot.querySelector('#gmap-m-status');

  let _building = null;       // { slug, wayfinding_admin_url, matterport_sid }
  let _buildingStatus = null;
  let _mapCode = '';

  function showStep(step) {
    stepUrl.style.display     = step === 'url'     ? '' : 'none';
    stepLoading.style.display = step === 'loading' ? '' : 'none';
    stepManage.style.display  = step === 'manage'  ? '' : 'none';
  }

  function setStatus(el, msg, ok = null) {
    el.textContent = msg;
    el.style.color = ok === true ? 'var(--color-success,#22c55e)' : ok === false ? 'var(--color-error,#ef4444)' : '';
  }

  function renderDetail(info) {
    if (!info) return;
    mNameEl.textContent = info.name || info.slug || '—';
    const rows = [];
    if (info.slug)                rows.push('Slug', info.slug);
    if (info.matterport_model_id) rows.push('Model SID', info.matterport_model_id);
    if (info.status)              rows.push('Status', info.status);
    if (info.address)             rows.push('Address', info.address);
    if (info.lat != null)         rows.push('Lat / Lon', `${Number(info.lat).toFixed(5)}, ${Number(info.lon).toFixed(5)}`);
    if (info.floors?.length)      rows.push('Floors', info.floors.map(f => f.label || f.id).join(', '));
    mDetailsEl.innerHTML = '';
    for (let i = 0; i < rows.length; i += 2) {
      mDetailsEl.innerHTML += `<span style="opacity:.55">${rows[i]}</span><span>${rows[i+1]}</span>`;
    }
    subtitleEl.textContent = info.name || info.slug;
  }

  function applyStatusUI(info) {
    const status = (info?.status) || _buildingStatus;
    const ready = status === 'ready' || status === 'published';
    mOnboarding.style.display = ready ? 'none' : '';
    mStatusBadge.textContent  = status ? `Current status: ${status}` : '';
    syncBtn.disabled    = false;
    syncBtn.style.opacity = '1';
    syncBtn.style.cursor  = 'pointer';
  }

  // Resolve the real building slug: try stored slug first, then SID lookup.
  // Returns the detail object { slug, name, status, address, lat, lon, ... } or null.
  async function resolveBuilding(url, storedSlug, sid) {
    // 1. Try stored slug
    if (storedSlug) {
      const r = await wfFetch(url, `/api/v1/public/dashboard/buildings/${storedSlug}/status`).catch(() => null);
      if (r?.ok) return await r.json();
    }
    // 2. Stored slug 404 or missing — look up by Matterport SID
    if (sid) {
      const r2 = await wfFetch(url, `/api/v1/public/dashboard/buildings/by-sid/${sid}`).catch(() => null);
      if (r2?.ok) return await r2.json();
    }
    return null;
  }

  async function loadBuildingStatus() {
    const b = _building;
    if (!b?.wayfinding_admin_url) return;
    const url = b.wayfinding_admin_url.replace(/\/$/, '');
    const info = await resolveBuilding(url, b.slug, _mapCode);
    if (info) {
      _buildingStatus = info.status;
      // Heal slug mismatch in local state + Supabase
      if (info.slug !== b.slug) {
        _building.slug = info.slug;
        const sa = getSuperadminSession();
        const poiType = getPoiType();
        if (sa && poiType) {
          adminGmapUpsertBuilding({
            email: sa.email, password: sa.password, poiType: String(poiType),
            accountEmail: b.account_email || '', slug: info.slug,
            matterportSid: info.matterport_model_id || _mapCode || null,
            wayfindingAdminUrl: b.wayfinding_admin_url,
          }).catch(() => {});
        }
      }
      renderDetail(info);
    }
    applyStatusUI(info);
  }

  // ─── Connect button ───
  urlGoBtn.addEventListener('click', async () => {
    const base = wfUrlEl.value.trim().replace(/\/$/, '');
    if (!base) { setStatus(urlStatus, 'Enter a wayfinding server URL.', false); return; }
    urlGoBtn.disabled = true;
    setStatus(urlStatus, 'Fetching project data…');
    try {
      const sa = getSuperadminSession();
      const poiType = getPoiType();
      if (!sa || !poiType) throw new Error('No superadmin session');

      _mapCode = (await fetchMatterportSidForProject(String(poiType))) || '';
      // Try to find existing building in wayfinding by SID first
      const info = _mapCode ? await resolveBuilding(base, null, _mapCode) : null;
      const slug = info?.slug || String(poiType).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

      setStatus(urlStatus, 'Saving link to NavMe DB…');
      await adminGmapUpsertBuilding({
        email: sa.email, password: sa.password, poiType: String(poiType),
        accountEmail: '', slug, matterportSid: _mapCode || null, wayfindingAdminUrl: base,
      });

      _building = { slug, wayfinding_admin_url: base, matterport_sid: _mapCode };
      _buildingStatus = info?.status || null;

      if (info) {
        renderDetail(info);
      } else {
        mNameEl.textContent = slug;
        mDetailsEl.innerHTML = `<span style="opacity:.55">Model SID</span><span>${_mapCode || '—'}</span>`;
        subtitleEl.textContent = slug;
      }
      applyStatusUI(info);
      showStep('manage');
      showToast('Linked!', { type: 'success' });

      if (!info) {
        // Building doesn't exist yet — open wizard
        openWizard(base, slug, _mapCode, String(poiType));
      }
    } catch (e) {
      setStatus(urlStatus, 'Error: ' + e.message, false);
    } finally {
      urlGoBtn.disabled = false;
    }
  });

  // ─── Open Wayfinding Admin ───
  openBtn.addEventListener('click', () => {
    const b = _building;
    const url = (b?.wayfinding_admin_url || '').replace(/\/$/, '');
    const slug = b?.slug || '';
    if (!url || !slug) return;
    const ready = _buildingStatus === 'ready' || _buildingStatus === 'published';
    if (ready) {
      window.open(`${url}/admin/#/b/${slug}/routes`, '_blank');
    } else {
      openWizard(url, slug, b.matterport_sid || _mapCode, String(getPoiType() || ''));
    }
  });

  // ─── Sync POIs ───
  syncBtn.addEventListener('click', async () => {
    const poiType = getPoiType();
    const b = _building;
    if (!poiType || !b) return;
    syncBtn.disabled = true;
    setStatus(manageStatus, 'Syncing POIs…');
    try {
      const result = await adminGmapSyncPois(String(poiType));
      const count = typeof result === 'number' ? result : result?.synced ?? result?.count ?? 0;
      setStatus(manageStatus, `✓ ${count} POIs synced to Supabase. Pushing to wayfinding…`);

      const url = (b.wayfinding_admin_url || '').replace(/\/$/, '');
      if (url && b.slug) {
        // slug addresses the building; poi_type is the verbatim Supabase filter key.
        const r = await wfFetch(url, `/api/v1/public/dashboard/buildings/${encodeURIComponent(b.slug)}/sync-pois`
          + `?poi_type=${encodeURIComponent(String(poiType))}`, { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (r.ok) setStatus(manageStatus, `✓ ${j.created ?? 0} created, ${j.updated ?? 0} updated in wayfinding.`, true);
        else setStatus(manageStatus, `Supabase synced. Wayfinding: ${j.detail || r.status}`, false);
      } else {
        setStatus(manageStatus, `✓ ${count} POIs synced to Supabase.`, true);
      }
    } catch (e) {
      setStatus(manageStatus, 'Sync failed: ' + e.message, false);
    } finally {
      syncBtn.disabled = false;
    }
  });

  // ─── Entry point ───
  async function load() {
    const sa = getSuperadminSession();
    const poiType = getPoiType();
    if (!sa || !poiType) { subtitleEl.textContent = 'No session'; return; }

    showStep('loading');
    stepLoading.textContent = 'Checking building…';

    try {
      const existing = await adminGmapGetBuilding({ email: sa.email, password: sa.password, poiType: String(poiType) });
      if (existing?.slug || existing?.wayfinding_admin_url) {
        _building = existing;
        // Always resolve SID from navme_media (authoritative)
        _mapCode = (await fetchMatterportSidForProject(String(poiType)))
          || parseMatterportModelId(existing.matterport_sid) || '';
        _building.matterport_sid = _mapCode || null;

        // Show placeholder while status loads
        mNameEl.textContent = existing.slug;
        mDetailsEl.innerHTML = `<span style="opacity:.55">Slug</span><span>${existing.slug}</span>` +
          (_mapCode ? `<span style="opacity:.55">Model SID</span><span>${_mapCode}</span>` : '');
        subtitleEl.textContent = existing.slug;
        applyStatusUI(null);
        showStep('manage');
        loadBuildingStatus(); // async — updates name/address/floors/slug
        return;
      }
    } catch { /* first time */ }

    subtitleEl.textContent = 'New building';
    showStep('url');
  }

  return {
    show() { slot.hidden = false; load(); },
    hide() { slot.hidden = true; },
    load,
  };
}
