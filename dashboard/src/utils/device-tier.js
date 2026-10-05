/**
 * Lightweight device capability hints for renderer and map loading tuning.
 */

/** @returns {'low' | 'mid' | 'high'} */
export function getDeviceTier() {
  const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  let score = 0;
  if (typeof mem === 'number') {
    if (mem >= 8) score += 2;
    else if (mem >= 4) score += 1;
    else score -= 2;
  }

  if (cores >= 8) score += 2;
  else if (cores >= 4) score += 1;
  else score -= 1;

  if (dpr > 2) score -= 1;

  if (score <= 0) return 'low';
  if (score <= 2) return 'mid';
  return 'high';
}

/** Cap DPR so weak GPUs are not overdrawn. */
export function getRecommendedPixelRatio() {
  const tier = getDeviceTier();
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  if (tier === 'low') return Math.min(dpr, 1);
  if (tier === 'mid') return Math.min(dpr, 1.5);
  return Math.min(dpr, 2);
}

/** Max texture edge length before worker downscale. */
export function getTextureMaxSize() {
  const tier = getDeviceTier();
  if (tier === 'low') return 1024;
  if (tier === 'mid') return 2048;
  return 4096;
}

/** DRACO worker pool size tuned to CPU cores. */
export function getDracoWorkerLimit() {
  const tier = getDeviceTier();
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  if (tier === 'low') return Math.max(1, Math.min(2, cores));
  if (tier === 'mid') return Math.max(2, Math.min(4, cores));
  return Math.max(4, Math.min(8, cores));
}

/** Textures applied per idle slice during lazy upload. */
export function getTextureBatchSize() {
  const tier = getDeviceTier();
  if (tier === 'low') return 1;
  if (tier === 'mid') return 2;
  return 3;
}

/** @returns {Promise<void>} */
export function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 48 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
