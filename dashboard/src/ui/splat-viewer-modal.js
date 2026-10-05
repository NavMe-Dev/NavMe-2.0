import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { iconClose } from './icons.js';
import { t } from '../config/i18n.js';
import {
  createDropInSplatViewer,
  applySplatMapRotation,
  GaussianSplats3D,
  SPLAT_IDENTITY_QUAT,
} from '../ar/splat-gaussian.js';

/**
 * Gaussian splat viewer (textured 3DGS). Rotation locked to X=-90°, Z=0°.
 * @param {{ url: string, title?: string }} opts
 */
export function openSplatViewerModal(opts) {
  const url = String(opts?.url ?? '').trim();
  if (!url) throw new Error(t('splatViewer.missingUrl'));

  const title = String(opts?.title ?? t('splatViewer.defaultTitle'));
  const overlay = document.createElement('div');
  overlay.className = 'media-modal-overlay poi-add-dialog splat-viewer-overlay';
  overlay.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close"></div>
    <div class="media-modal media-modal-card splat-viewer-card" role="dialog" aria-label="${t('splatViewer.dialogLabel')}">
      <header class="poi-add-dialog-header media-modal-header">
        <h2 class="poi-add-dialog-title">${title}</h2>
        <button type="button" class="poi-add-dialog-close media-modal-close" data-action="close" aria-label="${t('splatViewer.close')}">${iconClose()}</button>
      </header>
      <div class="splat-viewer-body">
        <canvas class="splat-viewer-canvas" id="splat-viewer-canvas"></canvas>
        <p class="splat-viewer-status">${t('splatViewer.loading')}</p>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('#splat-viewer-canvas');
  const statusEl = overlay.querySelector('.splat-viewer-status');
  const rect = () => canvas.getBoundingClientRect();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(1, rect().width), Math.max(1, rect().height), false);
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f1c);
  const camera = new THREE.PerspectiveCamera(
    55,
    Math.max(1, rect().width) / Math.max(1, rect().height),
    0.01,
    5000,
  );
  camera.position.set(0, 0, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, -1);
  controls.update();

  const dropIn = createDropInSplatViewer();
  scene.add(dropIn);

  let frame = 0;
  let disposed = false;

  const onResize = () => {
    if (disposed) return;
    const w = Math.max(1, rect().width);
    const h = Math.max(1, rect().height);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  window.addEventListener('resize', onResize);

  const animate = () => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(animate);
  };

  const close = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', onResize);
    controls.dispose();
    Promise.resolve(dropIn.dispose()).catch(() => {});
    renderer.dispose();
    overlay.remove();
  };

  overlay.querySelectorAll('[data-action="close"]').forEach((el) => el.addEventListener('click', close));
  animate();

  dropIn
    .addSplatScene(url, {
      format: GaussianSplats3D.SceneFormat.Ply,
      showLoadingUI: false,
      splatAlphaRemovalThreshold: 1,
      position: [0, 0, 0],
      rotation: [...SPLAT_IDENTITY_QUAT],
      scale: [1, 1, 1],
    })
    .then(() => {
      if (disposed) return;
      applySplatMapRotation(dropIn);
      camera.position.set(0, 0, 0);
      controls.target.set(0, 0, -1);
      controls.update();
      if (statusEl) statusEl.remove();
    })
    .catch((err) => {
      console.error('[splat-viewer]', err);
      const body = overlay.querySelector('.splat-viewer-body');
      if (body) {
        body.innerHTML = `<p class="media-preview-model">${t('splatViewer.loadError')}</p>`;
      }
    });
}
