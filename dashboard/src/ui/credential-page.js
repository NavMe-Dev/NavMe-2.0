/**
 * Public credential landing page — `/c/:publicId` on dashboard.navme.space
 */

import { getCredentialPublicIdFromPath } from '../app-routes.js';
import { resolveProjectApiCredential } from '../services/supabase.js';
import { partnerPoisApiUrl } from '../config/partner-api.js';
import { initTheme } from '../config/theme.js';
import { iconLock, iconCopy } from './icons.js';
import { showToast } from './toast.js';
import { t } from '../config/i18n.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {HTMLElement} container
 */
export function initCredentialPage(container) {
  initTheme();
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'credential-share-page glass-shell';
  page.innerHTML = `
    <header class="credential-share-topbar">
      <img src="/NavMe_wb.png" alt="NavMe" class="topbar-logo-img" />
      <span class="credential-share-brand">${t('credentialPage.brandTitle')}</span>
    </header>
    <main class="credential-share-main">
      <section class="credential-share-card float-glass" data-cred-panel>
        <p class="credential-share-loading">${t('credentialPage.loading')}</p>
      </section>
    </main>
  `;
  container.appendChild(page);

  const panel = /** @type {HTMLElement} */ (page.querySelector('[data-cred-panel]'));
  const publicId = getCredentialPublicIdFromPath();

  void (async () => {
    if (!publicId) {
      panel.innerHTML = `
        <span class="credential-share-icon" aria-hidden="true">${iconLock()}</span>
        <h1>${t('credentialPage.notFoundTitle')}</h1>
        <p>${t('credentialPage.missingId')}</p>`;
      return;
    }
    try {
      const row = await resolveProjectApiCredential(publicId);
      if (!row) throw new Error(t('credentialPage.notFoundTitle'));
      const name = String(row.name ?? t('credentialPage.defaultName'));
      const project = String(row.poi_type ?? '—');
      const shareUrl = String(row.share_url ?? window.location.href);
      const scopes = [
        row.scope_query ? t('credentialPage.scopeRead') : null,
        row.scope_write ? t('credentialPage.scopeWrite') : null,
        row.scope_delete ? t('credentialPage.scopeDelete') : null,
      ]
        .filter(Boolean)
        .join(', ') || t('credentialPage.scopeNone');
      const apiUrl = partnerPoisApiUrl(String(row.public_id ?? publicId));
      const curl = `curl -sS '${apiUrl}' \\\n  -H 'X-NavMe-Key: YOUR_NAVME_KEY'`;
      panel.innerHTML = `
        <span class="credential-share-icon" aria-hidden="true">${iconLock()}</span>
        <p class="credential-share-kicker">${t('credentialPage.validCredential')}</p>
        <h1>${escapeHtml(name)}</h1>
        <p class="credential-share-lead">${t('credentialPage.lead')}</p>
        <dl class="credential-share-meta">
          <div>
            <dt>${t('credentialPage.labelProject')}</dt>
            <dd>${escapeHtml(project)}</dd>
          </div>
          <div>
            <dt>${t('credentialPage.labelAccess')}</dt>
            <dd>${escapeHtml(scopes)}</dd>
          </div>
          <div>
            <dt>${t('credentialPage.labelPageUrl')}</dt>
            <dd>
              <code title="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl)}</code>
              <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(shareUrl)}" data-copy-label="${escapeHtml(t('credentialPage.labelPageUrl'))}" title="${escapeHtml(t('credentialPage.copyPageUrlTitle'))}">${iconCopy()}</button>
            </dd>
          </div>
          <div>
            <dt>${t('credentialPage.labelNavmeApi')}</dt>
            <dd>
              <code title="${escapeHtml(apiUrl)}">${escapeHtml(apiUrl || '—')}</code>
              <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(apiUrl)}" data-copy-label="${escapeHtml(t('credentialPage.labelNavmeApi'))}" title="${escapeHtml(t('credentialPage.copyNavmeApiTitle'))}"${apiUrl ? '' : ' disabled'}>${iconCopy()}</button>
            </dd>
          </div>
          <div>
            <dt>${t('credentialPage.labelCredentialId')}</dt>
            <dd><code>${escapeHtml(String(row.public_id ?? publicId))}</code></dd>
          </div>
        </dl>
        <div class="credential-share-example">
          <div class="credential-share-example-head">
            <span>${t('credentialPage.example')}</span>
            <button type="button" class="access-copy-map-btn" data-copy="${escapeHtml(curl)}" data-copy-label="${escapeHtml(t('credentialPage.example'))}" title="${escapeHtml(t('credentialPage.copyExampleTitle'))}">${iconCopy()}</button>
          </div>
          <pre><code>${escapeHtml(curl)}</code></pre>
        </div>
        <div class="credential-share-try">
          <label for="credential-try-key">${t('credentialPage.tryLabel')}</label>
          <div class="credential-share-try-row">
            <input id="credential-try-key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t('credentialPage.tryPlaceholder'))}" />
            <button type="button" class="access-save-btn" data-try-pois>${t('credentialPage.fetchPois')}</button>
          </div>
          <p class="credential-share-try-meta" data-try-meta hidden></p>
          <ul class="credential-share-poi-list" data-try-list hidden></ul>
        </div>`;

      panel.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const text = btn.getAttribute('data-copy') || '';
          const label = btn.getAttribute('data-copy-label') || t('credentialPage.defaultCopyLabel');
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
            showToast(t('credentialPage.copiedToast', { label }), 'success');
          } catch {
            showToast(t('credentialPage.copyFailedToast', { label: label.toLowerCase() }), 'error');
          }
        });
      });

      const tryBtn = /** @type {HTMLButtonElement | null} */ (panel.querySelector('[data-try-pois]'));
      const tryInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#credential-try-key'));
      const tryMeta = /** @type {HTMLElement | null} */ (panel.querySelector('[data-try-meta]'));
      const tryList = /** @type {HTMLElement | null} */ (panel.querySelector('[data-try-list]'));
      tryBtn?.addEventListener('click', async () => {
        const key = String(tryInput?.value || '').trim();
        if (!key) {
          showToast(t('credentialPage.enterKey'), 'error');
          return;
        }
        if (!apiUrl) {
          showToast(t('credentialPage.apiUrlUnavailable'), 'error');
          return;
        }
        tryBtn.disabled = true;
        try {
          const res = await fetch(apiUrl, {
            headers: { 'X-NavMe-Key': key },
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(payload?.error || t('credentialPage.requestFailed', { status: res.status }));
          }
          const pois = Array.isArray(payload?.pois) ? payload.pois : [];
          if (tryMeta) {
            tryMeta.hidden = false;
            tryMeta.textContent = t('credentialPage.poiCountMeta', {
              count: payload?.count ?? pois.length,
              project: payload?.project || project,
            });
          }
          if (tryList) {
            tryList.hidden = false;
            tryList.innerHTML = pois.length
              ? pois
                  .slice(0, 40)
                  .map((p) => `<li>${escapeHtml(p?.name || t('credentialPage.untitled'))}</li>`)
                  .join('')
              : `<li class="credential-share-empty">${t('credentialPage.noPois')}</li>`;
          }
          showToast(t('credentialPage.poisLoaded'), 'success');
        } catch (err) {
          if (tryMeta) {
            tryMeta.hidden = false;
            tryMeta.textContent = err instanceof Error ? err.message : t('credentialPage.requestFailedFallback');
          }
          if (tryList) {
            tryList.hidden = true;
            tryList.innerHTML = '';
          }
          showToast(err instanceof Error ? err.message : t('credentialPage.couldNotFetchPois'), 'error');
        } finally {
          tryBtn.disabled = false;
        }
      });
    } catch (err) {
      console.warn('[credential page]', err);
      panel.innerHTML = `
        <span class="credential-share-icon" aria-hidden="true">${iconLock()}</span>
        <h1>${t('credentialPage.notFoundTitle')}</h1>
        <p>${t('credentialPage.invalidOrRemoved')}</p>`;
    }
  })();
}
