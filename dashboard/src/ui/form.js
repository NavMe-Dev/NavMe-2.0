/**
 * Enterprise glass login — RBAC `authenticate_navme_account` → dashboard session.
 */

import { BRAND_NAME, brandLogoHtml } from '../config/brand.js';
import { bindThemeToggle } from '../config/theme.js';
import { authenticateNavmeAccount, authenticateLoginNavme } from '../services/supabase.js';
import { isSuperadminCredentials, setSuperadminSession, clearSuperadminSession } from '../config/superadmin.js';
import { setAuthSession, clearAuthSession } from '../config/auth-session.js';
import { saveProjectSession } from '../config/project-session.js';
import { offerBrowserPasswordSave } from '../utils/browser-password.js';
import { iconEye, iconEyeOff, iconSun, iconMoon } from './icons.js';
import { MULTISET_MAP } from '../config/spacecheck-access.js';
import { getDefaultOrganizationId } from '../config/organization.js';
import { clearForceGeometricMesh } from '../config/map-view-preference.js';
import { getLanguage, setLanguage, t } from '../config/i18n.js';
import { NAVME_LANGUAGES } from '../config/languages.js';

/**
 * @param {HTMLElement} container
 * @param {(creds: { clientId: string; clientSecret: string; mapCode: string; poiType: string; organizationId: string }) => void} onSubmit
 */
export function renderForm(container, onSubmit) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay form-overlay form-overlay--glass';
  overlay.id = 'form-overlay';

  overlay.innerHTML = `
    <select class="topbar-action-btn topbar-lang-select form-language-select" id="login-language-select" aria-label="${t('dashboard.languageSwitcher.ariaLabel')}">
      ${NAVME_LANGUAGES.map((lang) => `<option value="${lang.code}"${lang.code === getLanguage() ? ' selected' : ''}>${lang.nativeLabel}</option>`).join('')}
    </select>
    <button type="button" class="theme-toggle theme-toggle--floating btn-ripple-host" id="login-theme-toggle" aria-label="${t('form.switchTheme')}">
      <span class="theme-toggle-icon theme-toggle-icon--sun">${iconSun()}</span>
      <span class="theme-toggle-icon theme-toggle-icon--moon">${iconMoon()}</span>
    </button>
    <div class="form-card float-glass">
        <div class="form-brand">${brandLogoHtml('brand-logo brand-logo--login', 128)}</div>
        <h1 class="form-brand-title">${BRAND_NAME}</h1>
        <p class="subtitle">${t('form.subtitle')}</p>
        <p class="form-error hidden" id="login-error" role="alert"></p>
        <form id="cred-form" autocomplete="on">
          <div class="form-group">
            <label for="login-email">${t('form.email')}</label>
            <input id="login-email" name="email" type="email" autocomplete="username" required />
          </div>
          <div class="form-group">
            <label for="login-password">${t('form.password')}</label>
            <div class="password-field">
              <input id="login-password" name="password" type="password" autocomplete="current-password" required />
              <button type="button" class="password-toggle" id="password-toggle" aria-label="${t('form.showPassword')}" aria-pressed="false" title="${t('form.showPassword')}">
                ${iconEye()}
              </button>
            </div>
          </div>
          <button type="submit" class="btn-start" id="btn-start">${t('form.signIn')}</button>
        </form>
      </div>
  `;

  container.appendChild(overlay);
  bindThemeToggle(overlay.querySelector('#login-theme-toggle'));
  overlay.querySelector('#login-language-select')?.addEventListener('change', (event) => {
    setLanguage(event.target.value);
    window.location.reload();
  });

  const form = overlay.querySelector('#cred-form');
  const errEl = overlay.querySelector('#login-error');
  const btnStart = overlay.querySelector('#btn-start');
  const passwordInput = overlay.querySelector('#login-password');
  const passwordToggle = overlay.querySelector('#password-toggle');

  if (passwordToggle && passwordInput) {
    passwordToggle.addEventListener('click', () => {
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      passwordToggle.innerHTML = show ? iconEyeOff() : iconEye();
      passwordToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      passwordToggle.setAttribute('aria-label', show ? t('form.hidePassword') : t('form.showPassword'));
    });
  }

  /**
   * The RBAC auth RPC rejects deactivated members with "no active project membership".
   * @param {unknown} err
   */
  function blockedAccountMessage(err) {
    const raw = String(err?.message ?? err ?? '');
    if (!raw) return null;
    if (/no active project membership|inactive|deactivat|disabled|blocked/i.test(raw)) {
      return t('form.accessBlocked');
    }
    return null;
  }

  function setError(msg) {
    if (!msg) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
      return;
    }
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('');
    const email = form.querySelector('#login-email').value.trim();
    const password = form.querySelector('#login-password').value;
    btnStart.disabled = true;
    btnStart.classList.add('is-loading');
    try {
      let auth = null;
      let authError = null;
      try {
        auth = await authenticateNavmeAccount({ email, password });
      } catch (err) {
        authError = err;
        console.warn('[auth] authenticate_navme_account failed, falling back:', err);
      }

      if (auth?.isSuperadmin || auth?.role === 'superadmin') {
        setSuperadminSession(email, password);
        setAuthSession({
          accountId: auth.accountId,
          email,
          password,
          role: 'superadmin',
          poiType: null,
          mapCode: null,
          memberId: null,
        });
        await offerBrowserPasswordSave(email, password);
        window.location.href = '/access';
        return;
      }

      if (auth?.poiType && auth?.mapCode && (auth.role === 'project_admin' || auth.role === 'sub_admin')) {
        clearSuperadminSession();
        clearForceGeometricMesh();
        setAuthSession({
          accountId: auth.accountId,
          email,
          password,
          role: auth.role,
          poiType: auth.poiType,
          mapCode: auth.mapCode,
          memberId: auth.memberId,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
        });
        await offerBrowserPasswordSave(email, password);
        onSubmit({
          clientId: auth.clientId || MULTISET_MAP.clientId,
          clientSecret: auth.clientSecret || MULTISET_MAP.clientSecret,
          mapCode: auth.mapCode,
          poiType: auth.poiType,
          organizationId: auth.organizationId || getDefaultOrganizationId(),
        });
        return;
      }

      if (isSuperadminCredentials(email, password)) {
        setSuperadminSession(email, password);
        clearAuthSession();
        clearForceGeometricMesh();
        await offerBrowserPasswordSave(email, password);
        window.location.href = '/access';
        return;
      }

      clearSuperadminSession();
      clearForceGeometricMesh();
      const loginData = await authenticateLoginNavme({ email, password });
      if (!loginData) {
        setError(blockedAccountMessage(authError) ?? t('form.invalidCredentials'));
        btnStart.disabled = false;
        btnStart.classList.remove('is-loading');
        return;
      }
      console.warn('[auth] Using legacy authenticate_login_navme fallback');
      clearAuthSession();
      saveProjectSession({ email, password });
      await offerBrowserPasswordSave(email, password);
      onSubmit({
        clientId: loginData.clientId,
        clientSecret: loginData.clientSecret,
        mapCode: loginData.mapCode,
        poiType: loginData.poiType,
        organizationId: loginData.organizationId,
      });
    } catch (err) {
      setError(t('form.loginFailed', { error: String(err?.message ?? err) }));
      btnStart.disabled = false;
      btnStart.classList.remove('is-loading');
    }
  });

  return {
    hide() {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.pointerEvents = 'none';
      overlay.style.opacity = '0';
      overlay.style.visibility = 'hidden';
    },
    show() {
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
      overlay.style.display = 'flex';
      overlay.style.pointerEvents = 'auto';
      overlay.style.visibility = 'visible';
      overlay.style.opacity = '1';
      btnStart.disabled = false;
      setError('');
    },
    disable() {
      btnStart.disabled = true;
    },
    enable() {
      btnStart.disabled = false;
      btnStart.classList.remove('is-loading');
    },
    setError,
    resetAfterLogout() {
      form.reset();
      btnStart.disabled = false;
      setError('');
    },
  };
}
