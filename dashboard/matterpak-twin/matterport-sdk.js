/**
 * Matterport Showcase Embed SDK helpers (parent page).
 * Used only in Get XYZ compare mode to read world coordinates.
 */
import { getMatterportSdkKey } from './matterport.js';

const SDK_BOOTSTRAP =
  'https://static.matterport.com/showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js';

/** @type {Promise<void> | null} */
let bootstrapPromise = null;

function loadSdkBootstrap() {
  if (typeof window !== 'undefined' && window.MP_SDK?.connect) {
    return Promise.resolve();
  }
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SDK_BOOTSTRAP}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Matterport SDK script failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = SDK_BOOTSTRAP;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Matterport SDK script failed to load'));
    document.head.appendChild(s);
  });
  return bootstrapPromise;
}

/**
 * Human-readable SDK connect failures (esp. KeyReferrerMismatch).
 * @param {unknown} err
 */
export function formatMatterportSdkError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || err || 'SDK connect failed');
  const origin = typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:3010';

  if (
    name === 'KeyReferrerMismatchError' ||
    /Key\/referrer mismatch|KeyReferrerMismatch/i.test(msg)
  ) {
    return (
      `SDK key not allowed for ${origin}. In Matterport → Account Settings → Developer Tools, ` +
      `add this exact URL to the application key’s allowed domains: ${origin}/ ` +
      `(also add http://localhost:3010/ if you use localhost). Until then, enter Matterport XYZ manually below.`
    );
  }
  if (/applicationKey|SDK key|missing/i.test(msg)) {
    return msg;
  }
  return msg;
}

/**
 * Connect Embed SDK. applicationKey must already be on the iframe URL
 * (passing it to connect() is deprecated and triggers KeyReferrerMismatch more often).
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Promise<any>}
 */
export async function connectMatterportSdk(iframe) {
  const key = getMatterportSdkKey();
  if (!key) {
    throw new Error('VITE_MATTERPORT_SDK_KEY missing — needed for live Matterport XYZ');
  }
  if (!iframe?.contentWindow) {
    throw new Error('Matterport iframe not ready');
  }
  const src = iframe.src || '';
  if (!src.includes('applicationKey=')) {
    throw new Error(
      'Iframe URL is missing applicationKey — reload compare with SDK key in the Showcase URL',
    );
  }

  await loadSdkBootstrap();
  if (!window.MP_SDK?.connect) {
    throw new Error('MP_SDK.connect unavailable after bootstrap');
  }

  // Modern embed connect — key must already be on the iframe URL.
  // Do NOT pass applicationKey here (deprecated + noisier KeyReferrerMismatch).
  return window.MP_SDK.connect(iframe);
}

/**
 * Move Showcase toward a world XYZ (same frame as Matterpak when models match).
 * Prefer nearest sweep (inside), else dollhouse lookAt.
 *
 * @param {any} sdk
 * @param {{ x: number, y: number, z: number }} point
 */
export async function goToMatterportWorldPoint(sdk, point) {
  if (!sdk || !point) {
    throw new Error('Matterport SDK not connected — cannot go to XYZ');
  }
  const target = {
    x: Number(point.x),
    y: Number(point.y),
    z: Number(point.z),
  };
  if (![target.x, target.y, target.z].every(Number.isFinite)) {
    throw new Error('Invalid XYZ for Matterport go-to');
  }

  const fly =
    sdk.Camera?.TransitionType?.FLY ||
    sdk.Camera?.Transition?.FLY ||
    'transition.fly';

  // 1) Nearest panoramic sweep → stand near the POI (inside mode).
  try {
    const collection = await readSweepCollection(sdk);
    const nearest = findNearestSweep(collection, target);
    if (nearest?.id) {
      await sdk.Sweep.moveTo(nearest.id, {
        transition: fly,
        transitionTime: 1200,
      });
      return { method: 'sweep', sweepId: nearest.id, distance: nearest.distance };
    }
  } catch (err) {
    console.warn('[matterport-sdk] nearest sweep failed, trying lookAt', err);
  }

  // 2) Dollhouse lookAt the point (works for arbitrary world XYZ).
  if (typeof sdk.Camera?.lookAt === 'function') {
    const mode = sdk.Mode?.Mode?.DOLLHOUSE || 'mode.dollhouse';
    await sdk.Camera.lookAt(target, {
      mode,
      transition: fly,
      offset: { x: 2.2, y: 1.6, z: 2.2 },
    });
    return { method: 'lookAt', sweepId: null, distance: null };
  }

  // 3) Mode.moveTo dollhouse at position.
  if (typeof sdk.Mode?.moveTo === 'function') {
    const mode = sdk.Mode?.Mode?.DOLLHOUSE || 'mode.dollhouse';
    await sdk.Mode.moveTo(mode, {
      position: { x: target.x, y: target.y + 1.55, z: target.z },
      rotation: { x: -25, y: 0 },
      transition: fly,
    });
    return { method: 'mode', sweepId: null, distance: null };
  }

  throw new Error('No Matterport camera/sweep move API available on this SDK');
}

/**
 * @param {any} sdk
 * @returns {Promise<Map<string, any> | Record<string, any>>}
 */
function readSweepCollection(sdk) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sweep.data timeout')), 6000);
    const finish = (collection) => {
      clearTimeout(timer);
      resolve(collection || {});
    };
    try {
      const sub = sdk.Sweep.data.subscribe({
        onChanged() {},
        onCollectionUpdated(collection) {
          finish(collection);
          try {
            if (typeof sub === 'function') sub();
            else sub?.cancel?.();
          } catch {
            /* */
          }
        },
      });
      // Some SDK builds invoke the observer immediately with the map.
      if (typeof sub !== 'function' && sub && typeof sub.then === 'function') {
        /* ignore */
      }
    } catch {
      try {
        sdk.Sweep.data.subscribe((collection) => finish(collection));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}

/**
 * @param {Map<string, any> | Record<string, any> | any[]} collection
 * @param {{ x: number, y: number, z: number }} target
 */
function findNearestSweep(collection, target) {
  /** @type {any[]} */
  let sweeps = [];
  if (!collection) return null;
  if (typeof collection.values === 'function') {
    sweeps = [...collection.values()];
  } else if (Array.isArray(collection)) {
    sweeps = collection;
  } else {
    sweeps = Object.values(collection);
  }

  let best = null;
  let bestD = Infinity;
  for (const sweep of sweeps) {
    if (!sweep || sweep.enabled === false) continue;
    const p = sweep.position || sweep.puckPosition;
    if (!p || !Number.isFinite(Number(p.x))) continue;
    const dx = Number(p.x) - target.x;
    const dy = Number(p.y) - target.y;
    const dz = Number(p.z) - target.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = {
        id: sweep.id || sweep.sid || sweep.uuid,
        distance: Math.sqrt(d),
      };
    }
  }
  return best;
}

/**
 * Place or move a visible Tag/Mattertag dot in Showcase.
 * @param {any} sdk
 * @param {{ x: number, y: number, z: number }} point
 * @param {{
 *   kind?: 'pack' | 'mp',
 *   existingId?: string | null,
 *   label?: string,
 * }} [opts]
 * @returns {Promise<string | null>} tag id
 */
export async function upsertCompareDot(sdk, point, opts = {}) {
  if (!sdk || !point) return null;
  const kind = opts.kind === 'mp' ? 'mp' : 'pack';
  const color =
    kind === 'mp'
      ? { r: 0.2, g: 0.83, b: 0.6 }
      : { r: 0.23, g: 0.53, b: 1.0 };
  const label =
    opts.label ||
    (kind === 'mp' ? 'Matterport POI' : 'Matterpak POI');
  const anchorPosition = {
    x: Number(point.x),
    y: Number(point.y),
    z: Number(point.z),
  };
  const stemVector = { x: 0, y: 0.35, z: 0 };

  // Move existing tag if we have an id.
  if (opts.existingId) {
    try {
      if (typeof sdk.Tag?.editPosition === 'function') {
        await sdk.Tag.editPosition(opts.existingId, { anchorPosition, stemVector });
        return opts.existingId;
      }
      if (typeof sdk.Mattertag?.editPosition === 'function') {
        await sdk.Mattertag.editPosition(opts.existingId, { anchorPosition, stemVector });
        return opts.existingId;
      }
    } catch (err) {
      console.warn('[matterport-sdk] editPosition failed, re-adding tag', err);
      await removeCompareDot(sdk, opts.existingId);
    }
  }

  const descriptor = {
    label,
    description: `${label} · X ${anchorPosition.x.toFixed(3)} Y ${anchorPosition.y.toFixed(3)} Z ${anchorPosition.z.toFixed(3)}`,
    anchorPosition,
    stemVector,
    color,
  };

  if (typeof sdk.Tag?.add === 'function') {
    const ids = await sdk.Tag.add(descriptor);
    return Array.isArray(ids) ? ids[0] : ids;
  }
  if (typeof sdk.Mattertag?.add === 'function') {
    const ids = await sdk.Mattertag.add([descriptor]);
    return Array.isArray(ids) ? ids[0] : ids;
  }
  throw new Error('Tag/Mattertag API unavailable — cannot place Matterport dot');
}

/**
 * @param {any} sdk
 * @param {string | null | undefined} tagId
 */
export async function removeCompareDot(sdk, tagId) {
  if (!sdk || !tagId) return;
  try {
    if (typeof sdk.Tag?.remove === 'function') {
      await sdk.Tag.remove(tagId);
      return;
    }
    if (typeof sdk.Mattertag?.remove === 'function') {
      await sdk.Mattertag.remove(tagId);
    }
  } catch (err) {
    console.warn('[matterport-sdk] remove tag failed', err);
  }
}

/**
 * Subscribe to pointer floor/mesh intersection (best POI XYZ).
 * Falls back to camera pose if pointer API is missing.
 *
 * @param {any} sdk
 * @param {(pt: { x: number, y: number, z: number, source: string } | null) => void} onPoint
 * @returns {() => void} unsubscribe
 */
export function watchMatterportWorldPoint(sdk, onPoint) {
  /** @type {Array<() => void>} */
  const unsubs = [];

  const emit = (pos, source) => {
    if (!pos || !Number.isFinite(Number(pos.x))) {
      onPoint(null);
      return;
    }
    onPoint({
      x: Number(pos.x),
      y: Number(pos.y),
      z: Number(pos.z),
      source,
    });
  };

  try {
    if (sdk?.Pointer?.intersection?.subscribe) {
      const sub = sdk.Pointer.intersection.subscribe((hit) => {
        const pos = hit?.position || hit?.object?.position || hit;
        emit(pos, 'pointer');
      });
      if (typeof sub === 'function') unsubs.push(sub);
      else if (sub?.cancel) unsubs.push(() => sub.cancel());
      else if (sub?.unsubscribe) unsubs.push(() => sub.unsubscribe());
    }
  } catch (err) {
    console.warn('[matterport-sdk] Pointer.intersection failed', err);
  }

  try {
    if (sdk?.Camera?.pose?.subscribe) {
      const sub = sdk.Camera.pose.subscribe((pose) => {
        emit(pose?.position, 'camera');
      });
      if (typeof sub === 'function') unsubs.push(sub);
      else if (sub?.cancel) unsubs.push(() => sub.cancel());
      else if (sub?.unsubscribe) unsubs.push(() => sub.unsubscribe());
    }
  } catch (err) {
    console.warn('[matterport-sdk] Camera.pose failed', err);
  }

  return () => {
    unsubs.forEach((fn) => {
      try {
        fn();
      } catch {
        /* */
      }
    });
  };
}
