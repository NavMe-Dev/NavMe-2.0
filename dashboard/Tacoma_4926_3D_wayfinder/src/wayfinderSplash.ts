const NAVME_LOGO_URL = new URL('./Assets/NavMe_wb.png', import.meta.url).href;

const SPLASH_MIN_MS = 2400;
const SPLASH_FADE_MS = 700;

let splashEl: HTMLElement | null = null;

function injectSplashStyles(): void {
  if (document.getElementById('wf-splash-styles')) return;
  const style = document.createElement('style');
  style.id = 'wf-splash-styles';
  style.textContent = `
.wf-splash{
  position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(120% 90% at 50% 18%,#ffffff 0%,#f4f7fb 52%,#e8eef6 100%);
  transition:opacity ${SPLASH_FADE_MS}ms ease,visibility ${SPLASH_FADE_MS}ms ease;
}
.wf-splash--hide{opacity:0;visibility:hidden;pointer-events:none}
.wf-splash__inner{display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;text-align:center}
.wf-splash__logo{
  width:min(48vw,180px);height:auto;display:block;border-radius:50%;
  animation:wfSplashLogoIn 1.05s cubic-bezier(.22,1,.36,1) both;
  filter:drop-shadow(0 8px 28px rgba(59,130,246,.22));
}
.wf-splash__product{
  margin:0;font:700 clamp(22px,5.5vw,32px)/1.15 -apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;
  letter-spacing:-.02em;color:#0f172a;
  animation:wfSplashTextIn 1.05s cubic-bezier(.22,1,.36,1) .22s both;
}
.wf-splash__product span{
  background:linear-gradient(90deg,#5BA3FF 0%,#3B82F6 52%,#2563EB 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.wf-splash__pulse{
  width:min(42vw,160px);height:3px;border-radius:999px;margin-top:4px;overflow:hidden;
  background:rgba(59,130,246,.14);
  animation:wfSplashTextIn 1s ease .45s both;
}
.wf-splash__pulse::after{
  content:"";display:block;width:42%;height:100%;border-radius:inherit;
  background:linear-gradient(90deg,#5BA3FF,#3B82F6);
  animation:wfSplashPulse 1.35s ease-in-out infinite;
}
@keyframes wfSplashLogoIn{
  from{opacity:0;transform:translateY(18px) scale(.94)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
@keyframes wfSplashTextIn{
  from{opacity:0;transform:translateY(12px)}
  to{opacity:1;transform:translateY(0)}
}
@keyframes wfSplashPulse{
  0%{transform:translateX(-120%)}
  100%{transform:translateX(320%)}
}
`;
  document.head.appendChild(style);
}

export function mountWayfinderSplash(): void {
  if (typeof document === 'undefined' || splashEl) return;
  injectSplashStyles();
  const root = document.createElement('div');
  root.className = 'wf-splash';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-label', 'Loading NavMe Spatial Studio');
  root.innerHTML = `
    <div class="wf-splash__inner">
      <img class="wf-splash__logo" src="${NAVME_LOGO_URL}" width="180" height="180" alt="NavMe" decoding="async" />
      <p class="wf-splash__product"><span>NavMe Spatial Studio</span></p>
      <div class="wf-splash__pulse" aria-hidden="true"></div>
    </div>
  `;
  document.body.appendChild(root);
  splashEl = root;
  document.documentElement.style.background = '#ffffff';
  document.body.style.background = '#ffffff';
}

export function dismissSplashWhenReady(ready: Promise<void>): void {
  if (!splashEl) return;
  const minDelay = new Promise<void>((resolve) => window.setTimeout(resolve, SPLASH_MIN_MS));
  void Promise.all([ready.catch(() => undefined), minDelay]).then(() => {
    if (!splashEl) return;
    splashEl.classList.add('wf-splash--hide');
    window.setTimeout(() => {
      splashEl?.remove();
      splashEl = null;
      document.documentElement.style.background = '';
      document.body.style.background = '';
    }, SPLASH_FADE_MS + 40);
  });
}
