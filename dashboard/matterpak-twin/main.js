/**
 * Standalone Matterpak + Matterport lab (port 3010).
 * No login · not wired into the NavMe dashboard.
 */
import { loadMatterpakZip } from './matterpak-loader.js';
import { createTwinViewer } from './twin-viewer.js';
import {
  getMatterportSdkKey,
  matterportShowcaseUrl,
  parseMatterportModelId,
} from './matterport.js';
import {
  connectMatterportSdk,
  formatMatterportSdkError,
  goToMatterportWorldPoint,
  removeCompareDot,
  upsertCompareDot,
  watchMatterportWorldPoint,
} from './matterport-sdk.js';

const stage = document.getElementById('stage');
const viewport = document.getElementById('viewport');
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const barWrap = document.getElementById('bar-wrap');
const bar = document.getElementById('bar');
const tools = document.getElementById('tools');
const xyzReadout = document.getElementById('xyz-readout');
const xyzValues = document.getElementById('xyz-values');
const mpIframe = document.getElementById('mp-iframe');
const mpUrlInput = document.getElementById('mp-url');
const mpStatus = document.getElementById('mp-status');
const cmpPackEl = document.getElementById('cmp-pack-xyz');
const cmpMpEl = document.getElementById('cmp-mp-xyz');
const cmpDeltaEl = document.getElementById('cmp-delta-xyz');
const cmpStatusEl = document.getElementById('cmp-status');
const cmpManual = document.getElementById('cmp-manual');
const btnGetXyz = document.getElementById('btn-get-xyz');
let compareWantsLiveSdk = true;

const viewer = createTwinViewer(viewport);

/** @type {{ revokeAll?: () => void } | null} */
let currentPack = null;
/** @type {'matterpak' | 'matterport' | 'compare'} */
let activeMode = 'matterpak';

/** @type {{ x: number, y: number, z: number } | null} */
let packXyz = null;
/** @type {{ x: number, y: number, z: number, source?: string } | null} */
let liveMpXyz = null;
/** @type {{ x: number, y: number, z: number, source?: string } | null} */
let lockedMpXyz = null;
/** @type {any} */
let mpSdk = null;
/** @type {(() => void) | null} */
let stopMpWatch = null;
let mpSdkConnecting = false;
/** @type {string | null} */
let mpPackTagId = null;
/** @type {string | null} */
let mpLiveTagId = null;

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind ? `is-${kind}` : '';
}

function setMpStatus(msg, kind = '') {
  mpStatus.textContent = msg;
  mpStatus.className = kind ? `is-${kind}` : '';
}

function setCmpStatus(msg, kind = '') {
  if (!cmpStatusEl) return;
  cmpStatusEl.textContent = msg;
  cmpStatusEl.className = kind ? `is-${kind}` : '';
}

function setProgress(msg, pct) {
  setStatus(msg, 'warn');
  if (typeof pct === 'number' && Number.isFinite(pct)) {
    barWrap.classList.add('show');
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}

function fmtXyz(point) {
  if (!point) return '—';
  return `X ${point.x.toFixed(3)}\nY ${point.y.toFixed(3)}\nZ ${point.z.toFixed(3)}`;
}

function showHudXyz(point) {
  if (!point) {
    xyzReadout.classList.remove('show');
    return;
  }
  xyzValues.textContent = `X ${point.x.toFixed(3)}   Y ${point.y.toFixed(3)}   Z ${point.z.toFixed(3)}`;
  xyzReadout.classList.add('show');
}

function updateCompareReadout() {
  const mpShown = lockedMpXyz || liveMpXyz;
  if (cmpPackEl) cmpPackEl.textContent = fmtXyz(packXyz);
  if (cmpMpEl) {
    const src = lockedMpXyz
      ? `locked · ${lockedMpXyz.source || 'mp'}`
      : liveMpXyz
        ? `live · ${liveMpXyz.source || 'mp'}`
        : '';
    cmpMpEl.textContent = mpShown
      ? `${fmtXyz(mpShown)}${src ? `\n(${src})` : ''}`
      : '—';
  }
  if (cmpDeltaEl) {
    if (packXyz && mpShown) {
      cmpDeltaEl.textContent = fmtXyz({
        x: packXyz.x - mpShown.x,
        y: packXyz.y - mpShown.y,
        z: packXyz.z - mpShown.z,
      });
    } else {
      cmpDeltaEl.textContent = '—';
    }
  }
}

function setPackPoint(point) {
  packXyz = point
    ? { x: point.x, y: point.y, z: point.z }
    : null;
  showHudXyz(packXyz);
  updateCompareReadout();
}

function disconnectMpSdk() {
  if (stopMpWatch) {
    stopMpWatch();
    stopMpWatch = null;
  }
  const sdk = mpSdk;
  const packId = mpPackTagId;
  const liveId = mpLiveTagId;
  mpSdk = null;
  liveMpXyz = null;
  mpPackTagId = null;
  mpLiveTagId = null;
  if (sdk) {
    removeCompareDot(sdk, packId);
    removeCompareDot(sdk, liveId);
  }
}

async function placePackDotOnMatterport(point) {
  if (!mpSdk || !point) return;
  try {
    mpPackTagId = await upsertCompareDot(mpSdk, point, {
      kind: 'pack',
      existingId: mpPackTagId,
      label: 'Matterpak POI',
    });
  } catch (err) {
    console.warn('[compare-xyz] pack dot', err);
  }
}

async function placeMpDotOnMatterport(point) {
  if (!mpSdk || !point) return;
  try {
    mpLiveTagId = await upsertCompareDot(mpSdk, point, {
      kind: 'mp',
      existingId: mpLiveTagId,
      label: 'Matterport POI',
    });
  } catch (err) {
    console.warn('[compare-xyz] mp dot', err);
  }
}

/**
 * Matterport XYZ → green dot (+ optional fly) on Matterpak.
 * @param {{ x: number, y: number, z: number } | null} point
 * @param {{ fly?: boolean }} [opts]
 */
function showMatterportOnMatterpak(point, opts = {}) {
  if (!point) {
    viewer.setMatterportMarker(null);
    return;
  }
  // Prefer snapped nav point when available so Go-to feels the same.
  let dest = point;
  if (viewer.navReady && opts.fly) {
    // goToPoint path uses snap only on mesh click; here use raw XYZ (same space).
    dest = point;
  }
  viewer.setMatterportMarker(dest, { fly: Boolean(opts.fly) });
  if (packXyz) viewer.setPackMarker(packXyz);
}

async function attachMpSdkForCompare() {
  if (!mpIframe?.src || mpIframe.src === 'about:blank') return;
  if (mpSdkConnecting) return;
  if (!compareWantsLiveSdk) return;
  if (!getMatterportSdkKey()) {
    cmpManual?.classList.add('show');
    setCmpStatus('No SDK key — enter Matterport XYZ manually', 'warn');
    return;
  }
  if (!mpIframe.src.includes('applicationKey=')) {
    // Public embed (no key) — viewing works; XYZ must be manual until domain is whitelisted.
    cmpManual?.classList.add('show');
    setCmpStatus(
      `Live SDK needs applicationKey + domain whitelist for ${location.origin}. Using manual XYZ for now.`,
      'warn',
    );
    return;
  }
  mpSdkConnecting = true;
  setCmpStatus('Connecting Matterport SDK for XYZ…', 'warn');
  try {
    disconnectMpSdk();
    mpSdk = await connectMatterportSdk(mpIframe);
    stopMpWatch = watchMatterportWorldPoint(mpSdk, (pt) => {
      if (lockedMpXyz) return;
      liveMpXyz = pt;
      updateCompareReadout();
    });
    cmpManual?.classList.remove('show');
    setCmpStatus(
      'Compare on — click left POI → Matterport flies there (needs SDK). Or use Go → Matterport',
      'ok',
    );
  } catch (err) {
    console.error('[compare-xyz]', err);
    const friendly = formatMatterportSdkError(err);
    setCmpStatus(friendly, 'err');
    cmpManual?.classList.add('show');
    // Reload Showcase without applicationKey so the room still plays; XYZ via manual entry.
    if (/Key\/referrer mismatch|KeyReferrerMismatch/i.test(String(err?.message || err?.name || ''))) {
      compareWantsLiveSdk = false;
      loadMatterportFromInput({ forceSdkKey: false, forCompare: true, skipSdkAttach: true });
    }
  } finally {
    mpSdkConnecting = false;
  }
}

/**
 * @param {'matterpak' | 'matterport' | 'compare'} mode
 */
function setMode(mode) {
  const next =
    mode === 'matterport' ? 'matterport' : mode === 'compare' ? 'compare' : 'matterpak';
  const changed = next !== activeMode;
  activeMode = next;

  stage?.classList.toggle('compare-mode', activeMode === 'compare');
  btnGetXyz?.classList.toggle('active', activeMode === 'compare');

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const m = btn.getAttribute('data-mode');
    btn.classList.toggle(
      'active',
      activeMode === 'compare' ? false : m === activeMode,
    );
  });

  document.querySelectorAll('.mode-panel').forEach((panel) => {
    const m = panel.getAttribute('data-mode');
    if (activeMode === 'compare') {
      panel.classList.add('active');
    } else {
      panel.classList.toggle('active', m === activeMode);
    }
  });

  if (activeMode === 'compare') {
    viewer.setGotoMode(true);
    document.getElementById('btn-goto')?.classList.add('active');
    compareWantsLiveSdk = true;
    updateCompareReadout();
    // Load Matterport with SDK key only when Get XYZ opens compare.
    requestAnimationFrame(() => {
      loadMatterportFromInput({ forceSdkKey: true, forCompare: true });
      window.dispatchEvent(new Event('resize'));
    });
    return;
  }

  // Leaving compare — stop SDK watch; keep iframe if user stays on Matterport.
  disconnectMpSdk();
  lockedMpXyz = null;
  liveMpXyz = null;
  compareWantsLiveSdk = true;
  cmpManual?.classList.remove('show');
  viewer.setMatterportMarker(null);
  updateCompareReadout();
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

  if (activeMode === 'matterport' && changed) {
    requestAnimationFrame(() => loadMatterportFromInput({ forceSdkKey: false }));
  }
}

async function handleFile(file) {
  if (!file) return;
  if (currentPack?.revokeAll) currentPack.revokeAll();
  currentPack = null;
  tools.classList.remove('show');
  xyzReadout.classList.remove('show');
  packXyz = null;
  updateCompareReadout();
  bar.style.width = '0%';
  barWrap.classList.add('show');

  const label = file.name || 'matterpak.zip';
  setProgress(`Loading ${label}…`, 2);

  try {
    const pack = await loadMatterpakZip(file, { onProgress: setProgress });
    currentPack = pack;
    await viewer.loadFromMatterpak({
      ...pack,
      onProgress: setProgress,
    });
    if (viewer.navReady) {
      setStatus(
        `Ready · Go to a POI, then Get XYZ to compare with Matterport`,
        'ok',
      );
    } else {
      setStatus(`Mesh loaded · navmesh unavailable — Go to needs a successful navmesh`, 'warn');
    }
    bar.style.width = '100%';
    tools.classList.add('show');
    setTimeout(() => barWrap.classList.remove('show'), 800);
  } catch (err) {
    console.error('[matterpak-twin]', err);
    setStatus(err?.message || 'Failed to build twin from ZIP', 'err');
    barWrap.classList.remove('show');
  }
}

/** @type {string} */
let loadedMatterportId = '';
/** @type {boolean} */
let loadedWithSdkKey = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let mpConnectTimer = null;

function clearMpConnectTimer() {
  if (mpConnectTimer) {
    clearTimeout(mpConnectTimer);
    mpConnectTimer = null;
  }
}

/**
 * @param {{ forceSdkKey?: boolean, forCompare?: boolean, skipSdkAttach?: boolean }} [opts]
 */
function loadMatterportFromInput(opts = {}) {
  const raw = mpUrlInput?.value || '';
  const id = parseMatterportModelId(raw);
  if (!id) {
    setMpStatus('Enter a valid Matterport show URL or model SID', 'err');
    if (opts.forCompare) setCmpStatus('Set a Matterport URL first', 'err');
    return;
  }

  const useSdk =
    Boolean(opts.forceSdkKey) ||
    Boolean(document.getElementById('mp-use-sdk')?.checked) ||
    Boolean(opts.forCompare && compareWantsLiveSdk && getMatterportSdkKey());

  const url = matterportShowcaseUrl(id, { play: true, useSdkKey: useSdk });
  if (!url) {
    setMpStatus('Could not build Showcase URL', 'err');
    return;
  }

  const same =
    id === loadedMatterportId &&
    loadedWithSdkKey === useSdk &&
    mpIframe?.src &&
    mpIframe.src.includes(`m=${id}`);

  if (same) {
    setMpStatus(`Already loaded ${id}`, 'ok');
    if (opts.forCompare && !opts.skipSdkAttach) {
      attachMpSdkForCompare();
    }
    return;
  }

  clearMpConnectTimer();
  disconnectMpSdk();
  if (!opts.skipSdkAttach) {
    lockedMpXyz = null;
    liveMpXyz = null;
    updateCompareReadout();
  }

  setMpStatus(
    useSdk
      ? `Loading ${id} in this panel (SDK key)…`
      : `Loading ${id} in this panel…`,
    'warn',
  );
  if (opts.forCompare) {
    setCmpStatus(
      useSdk
        ? `Loading Matterport ${id} with SDK key…`
        : `Loading Matterport ${id} (public embed — manual XYZ)`,
      'warn',
    );
  }

  mpIframe.removeAttribute('src');
  requestAnimationFrame(() => {
    loadedMatterportId = id;
    loadedWithSdkKey = useSdk;
    mpIframe.src = url;
    mpConnectTimer = setTimeout(() => {
      const msg = `Still connecting for ${id}…`;
      setMpStatus(msg, 'warn');
      if (activeMode === 'compare') setCmpStatus(msg, 'warn');
    }, 25000);
  });
}

mpIframe?.addEventListener('load', () => {
  if (!loadedMatterportId || !mpIframe.src || mpIframe.src === 'about:blank') return;
  clearMpConnectTimer();
  setMpStatus(`Loaded in Matterport panel · ${loadedMatterportId}`, 'ok');
  if (activeMode === 'compare') {
    setTimeout(() => attachMpSdkForCompare(), 400);
  }
});

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMode(btn.getAttribute('data-mode') || 'matterpak');
  });
});

fileInput?.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  handleFile(file);
  fileInput.value = '';
});

drop?.addEventListener('dragenter', (e) => {
  e.preventDefault();
  drop.classList.add('is-drag');
});
drop?.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('is-drag');
});
drop?.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
drop?.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-drag');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

document.getElementById('btn-reset')?.addEventListener('click', () => viewer.resetView());
document.getElementById('btn-fit')?.addEventListener('click', () => viewer.fit());
document.getElementById('btn-goto')?.addEventListener('click', (e) => {
  viewer.setGotoMode(!viewer.gotoMode);
  e.currentTarget.classList.toggle('active', viewer.gotoMode);
  setStatus(
    viewer.gotoMode
      ? 'Go to on — click → nearest walkable navmesh point'
      : 'Go to off — orbit only',
    'ok',
  );
});

btnGetXyz?.addEventListener('click', () => {
  if (activeMode === 'compare') {
    setMode('matterpak');
    setStatus('Closed XYZ comparison', 'ok');
    return;
  }
  if (!currentPack) {
    setStatus('Upload a Matterpak ZIP first, then Get XYZ', 'warn');
    return;
  }
  setMode('compare');
  setStatus('Compare mode — same POI XYZ in one panel', 'ok');
});

document.getElementById('cmp-go-mp')?.addEventListener('click', () => {
  flyMatterportToPackPoint(packXyz);
});

document.getElementById('cmp-go-pack')?.addEventListener('click', () => {
  flyMatterpakToMpPoint(lockedMpXyz || liveMpXyz);
});

document.getElementById('cmp-lock-mp')?.addEventListener('click', () => {
  if (!liveMpXyz && !lockedMpXyz) {
    setCmpStatus('No Matterport point yet — wait for SDK or enter XYZ manually', 'warn');
    return;
  }
  if (lockedMpXyz) {
    lockedMpXyz = null;
    setCmpStatus('Matterport unlocked — live tracking again', 'ok');
  } else {
    lockedMpXyz = { ...liveMpXyz };
    showMatterportOnMatterpak(lockedMpXyz, { fly: true });
    placeMpDotOnMatterport(lockedMpXyz);
    setCmpStatus('Matterport XYZ locked · green dot on Matterpak + tag on Showcase', 'ok');
  }
  updateCompareReadout();
});

document.getElementById('cmp-apply-manual')?.addEventListener('click', () => {
  const x = Number(document.getElementById('cmp-mx')?.value);
  const y = Number(document.getElementById('cmp-my')?.value);
  const z = Number(document.getElementById('cmp-mz')?.value);
  if (![x, y, z].every(Number.isFinite)) {
    setCmpStatus('Enter valid numeric X Y Z for Matterport', 'err');
    return;
  }
  lockedMpXyz = { x, y, z, source: 'manual' };
  liveMpXyz = lockedMpXyz;
  showMatterportOnMatterpak(lockedMpXyz, { fly: true });
  placeMpDotOnMatterport(lockedMpXyz);
  updateCompareReadout();
  setCmpStatus('Matterport XYZ applied · green dot on Matterpak', 'ok');
});

document.getElementById('cmp-close')?.addEventListener('click', () => {
  setMode('matterpak');
  setStatus('Closed XYZ comparison', 'ok');
});

document.getElementById('btn-wire')?.addEventListener('click', (e) => {
  viewer.setWireframe(!viewer.wireframe);
  e.currentTarget.classList.toggle('active', viewer.wireframe);
});
document.getElementById('btn-xray')?.addEventListener('click', (e) => {
  viewer.setXray(!viewer.xray);
  e.currentTarget.classList.toggle('active', viewer.xray);
});

async function flyMatterportToPackPoint(point = packXyz) {
  if (!point) {
    setCmpStatus('Click a Matterpak POI first (left panel)', 'warn');
    return;
  }
  if (!mpSdk) {
    setCmpStatus(
      `Cannot move Matterport yet — SDK not connected. Whitelist ${location.origin}/ on the SDK key, reopen Get XYZ, then try again.`,
      'err',
    );
    cmpManual?.classList.add('show');
    return;
  }
  setCmpStatus(
    `Flying Matterport to X ${point.x.toFixed(2)} Y ${point.y.toFixed(2)} Z ${point.z.toFixed(2)}…`,
    'warn',
  );
  try {
    await placePackDotOnMatterport(point);
    const result = await goToMatterportWorldPoint(mpSdk, point);
    const how =
      result.method === 'sweep'
        ? `nearest sweep (${result.distance?.toFixed(2) ?? '?'} m)`
        : result.method;
    setCmpStatus(`Matterport moved via ${how} · blue dot placed`, 'ok');
  } catch (err) {
    console.error('[compare-xyz] go-to', err);
    setCmpStatus(err?.message || 'Matterport go-to failed', 'err');
  }
}

function flyMatterpakToMpPoint(point = lockedMpXyz || liveMpXyz) {
  if (!point) {
    setCmpStatus('Lock a Matterport point first (or aim pointer / enter XYZ)', 'warn');
    return;
  }
  showMatterportOnMatterpak(point, { fly: true });
  placeMpDotOnMatterport(point);
  setCmpStatus(
    `Matterpak green dot · X ${point.x.toFixed(2)} Y ${point.y.toFixed(2)} Z ${point.z.toFixed(2)}`,
    'ok',
  );
}

viewer.onGoto = (point) => {
  if (!point) {
    setStatus('No walkable navmesh point near that click', 'warn');
    setPackPoint(null);
    return;
  }
  setPackPoint(point);
  setStatus(
    `Matterpak POI · X ${point.x.toFixed(2)}  Y ${point.y.toFixed(2)}  Z ${point.z.toFixed(2)}`,
    'ok',
  );
  if (activeMode === 'compare') {
    // Same POI → drive Matterport to that XYZ when SDK is live.
    flyMatterportToPackPoint(point);
  }
};

document.getElementById('mp-load-btn')?.addEventListener('click', () => {
  loadMatterportFromInput({
    forceSdkKey: activeMode === 'compare',
    forCompare: activeMode === 'compare',
  });
});
mpUrlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    loadMatterportFromInput({
      forceSdkKey: activeMode === 'compare',
      forCompare: activeMode === 'compare',
    });
  }
});

setMpStatus('Select Matterport in the nav to load here — or Get XYZ to compare', 'ok');
setMode('matterpak');
