/**
 * Add / edit Media — file upload or AR Billboard (PNG), label, optional redirect link.
 * poi_type, placement, and is_active use session defaults / panel gizmo.
 */

import { classifyMediaFile } from '../utils/media-files.js';
import { createArBillboardPngFile } from '../utils/ar-billboard.js';
import { downloadMediaAsPng } from '../utils/download-media-png.js';
import { uploadProjectMedia } from '../services/media-storage.js';
import { insertMediaRow, updateMediaRow } from '../services/supabase.js';
import { showToast } from './toast.js';
import { getPoiType } from '../config/poi-session.js';
import { iconClose, iconDownload } from './icons.js';
import { t } from '../config/i18n.js';

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const FILE_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.mp4,.webm,.mov,.glb,.gltf,.ply,image/*,video/*';

/**
 * @param {object} options
 * @param {Record<string, unknown> | null} [options.row]
 * @param {{ x?: number, y?: number, z?: number }} [options.placement]
 * @param {(saved: Record<string, unknown>, context?: { previewUrl?: string }) => void} [options.onSaved]
 */
export function openMediaModal(options = {}) {
  const { row = null, placement = {}, onSaved } = options;
  const isEdit = Boolean(row?.id);
  const existingRedirect = String(row?.redirect_link ?? '').trim();

  const overlay = document.createElement('div');
  overlay.className = 'media-modal-overlay poi-add-dialog';
  overlay.innerHTML = `
    <div class="poi-add-dialog-backdrop" data-action="close"></div>
    <div class="media-modal media-modal-card poi-add-dialog-card float-glass" role="dialog" aria-labelledby="media-modal-title">
      <header class="poi-add-dialog-header media-modal-header">
        <h2 class="poi-add-dialog-title" id="media-modal-title">${isEdit ? t('mediaModal.editTitle') : t('mediaModal.addTitle')}</h2>
        <button type="button" class="poi-add-dialog-close media-modal-close" data-action="close" aria-label="${t('mediaModal.closeAriaLabel')}">${iconClose()}</button>
      </header>
      <form class="media-modal-form" id="media-modal-form">
        <div class="media-source-picker" role="tablist" aria-label="${t('mediaModal.mediaSourceAriaLabel')}">
          <button type="button" class="media-source-btn active" data-source="upload" role="tab" aria-selected="true">
            ${t('mediaModal.uploadFileTab')}
          </button>
          <button type="button" class="media-source-btn" data-source="billboard" role="tab" aria-selected="false">
            ${t('mediaModal.arBillboardTab')}
          </button>
        </div>
        <div class="media-modal-section media-source-panel" data-source-panel="upload">
          <label class="media-upload-zone" id="media-upload-zone">
            <span class="media-upload-zone-title">${t('mediaModal.chooseFileTitle')}</span>
            <span class="media-upload-zone-hint">${t('mediaModal.chooseFileHint')}</span>
            <input type="file" id="media-file" class="media-file-input" accept="${FILE_ACCEPT}" />
          </label>
          <div class="media-preview hidden" id="media-preview"></div>
          <button type="button" class="btn-secondary media-download-png-btn hidden" id="media-download-png">
            <span class="icon">${iconDownload()}</span> ${t('mediaModal.downloadPngButton')}
          </button>
          <div class="media-ios-upload hidden" id="media-ios-upload-wrap">
            <label class="media-upload-zone media-upload-zone--ios" id="media-ios-upload-zone">
              <span class="media-upload-zone-title">${t('mediaModal.iosUploadTitle')}</span>
              <span class="media-upload-zone-hint">${t('mediaModal.iosUploadHint')}</span>
              <input type="file" id="media-file-ios" class="media-file-input" accept=".mov,video/quicktime,video/mp4" />
            </label>
            <p class="media-modal-hint">${t('mediaModal.ffmpegHint')}</p>
          </div>
          ${isEdit ? `<p class="media-modal-hint">${t('mediaModal.keepCurrentFileHint')}</p>` : ''}
        </div>
        <div class="media-modal-section media-source-panel hidden" data-source-panel="billboard">
          <div class="ar-billboard-fields">
            <div class="coord-group poi-add-field ar-billboard-field">
              <span class="field-label">${t('mediaModal.titleLabel')}</span>
              <input type="text" id="billboard-title" placeholder="${t('mediaModal.titlePlaceholder')}" value="${escapeAttr(row?.label || t('mediaModal.defaultBillboardTitle'))}" />
            </div>
            <div class="coord-group poi-add-field ar-billboard-field">
              <span class="field-label">${t('mediaModal.descriptionLabel')}</span>
              <textarea id="billboard-desc" rows="4" placeholder="${t('mediaModal.descriptionPlaceholder')}">${t('mediaModal.defaultBillboardDesc')}</textarea>
            </div>
          </div>
          <div class="ar-billboard-stage" aria-hidden="true">
            <div class="ar-billboard-card" id="billboard-card">
              <div class="ar-billboard-title" id="billboard-title-preview">${escapeHtml(row?.label || t('mediaModal.defaultBillboardTitle'))}</div>
              <div class="ar-billboard-desc" id="billboard-desc-preview">${t('mediaModal.defaultBillboardDesc')}</div>
            </div>
          </div>
          <p class="media-modal-hint">${isEdit ? t('mediaModal.billboardHintEdit') : t('mediaModal.billboardHintAdd')}</p>
        </div>
        <div class="coord-group poi-add-field">
          <span class="field-label">${t('mediaModal.displayNameLabel')}</span>
          <input type="text" id="media-label" placeholder="${t('mediaModal.displayNamePlaceholder')}" value="${escapeAttr(row?.label ?? '')}" />
        </div>
        <div class="coord-group poi-add-field media-redirect-field">
          <span class="field-label">${t('mediaModal.redirectQuestionLabel')}</span>
          <div class="media-redirect-toggle" role="radiogroup" aria-label="${t('mediaModal.redirectQuestionLabel')}">
            <label class="media-redirect-option">
              <input type="radio" name="media-redirect" id="media-redirect-no" value="no" ${existingRedirect ? '' : 'checked'} />
              <span>${t('mediaModal.no')}</span>
            </label>
            <label class="media-redirect-option">
              <input type="radio" name="media-redirect" id="media-redirect-yes" value="yes" ${existingRedirect ? 'checked' : ''} />
              <span>${t('mediaModal.yes')}</span>
            </label>
          </div>
        </div>
        <div class="coord-group poi-add-field media-redirect-link-wrap ${existingRedirect ? '' : 'hidden'}" id="media-redirect-link-wrap">
          <span class="field-label">${t('mediaModal.redirectLinkLabel')}</span>
          <input type="url" id="media-redirect-link" placeholder="https://example.com" value="${escapeAttr(existingRedirect)}" />
        </div>
        <footer class="poi-add-dialog-actions media-modal-footer">
          <button type="button" class="btn-secondary" data-action="close">${t('mediaModal.cancelButton')}</button>
          <button type="submit" class="btn-save" id="media-save">${isEdit ? t('mediaModal.saveButton') : t('mediaModal.addMediaButton')}</button>
        </footer>
      </form>
    </div>
  `;

  document.body.appendChild(overlay);

  let uploadedMeta = null;
  let uploadedIosMeta = null;
  let previewObjectUrl = null;
  let detectedType = row?.media_type ?? null;
  /** @type {'upload' | 'billboard'} */
  let mediaSource = 'upload';
  let labelTouched = Boolean(String(row?.label ?? '').trim());

  const fileInput = overlay.querySelector('#media-file');
  const iosFileInput = overlay.querySelector('#media-file-ios');
  const iosUploadWrap = overlay.querySelector('#media-ios-upload-wrap');
  const previewEl = overlay.querySelector('#media-preview');
  const downloadPngBtn = overlay.querySelector('#media-download-png');
  const uploadZone = overlay.querySelector('#media-upload-zone');
  const saveBtn = overlay.querySelector('#media-save');
  const labelInput = overlay.querySelector('#media-label');
  const redirectYes = overlay.querySelector('#media-redirect-yes');
  const redirectNo = overlay.querySelector('#media-redirect-no');
  const redirectLinkWrap = overlay.querySelector('#media-redirect-link-wrap');
  const redirectLinkInput = overlay.querySelector('#media-redirect-link');
  const modalCard = overlay.querySelector('.media-modal-card');

  const titleInput = overlay.querySelector('#billboard-title');
  const descInput = overlay.querySelector('#billboard-desc');
  const titlePreview = overlay.querySelector('#billboard-title-preview');
  const descPreview = overlay.querySelector('#billboard-desc-preview');

  function syncRedirectLinkField(fromUserToggle = false) {
    const enabled = redirectYes.checked;
    redirectLinkWrap.classList.toggle('hidden', !enabled);
    if (!enabled && fromUserToggle) {
      redirectLinkInput.value = '';
    } else if (enabled && !redirectLinkInput.value.trim() && existingRedirect) {
      redirectLinkInput.value = existingRedirect;
    }
  }

  redirectYes.addEventListener('change', () => syncRedirectLinkField(true));
  redirectNo.addEventListener('change', () => syncRedirectLinkField(true));
  syncRedirectLinkField(false);

  labelInput.addEventListener('input', () => {
    labelTouched = true;
  });

  function syncSaveButton() {
    if (mediaSource === 'billboard') {
      const title = titleInput?.value.trim() ?? '';
      const desc = descInput?.value.trim() ?? '';
      saveBtn.disabled = !(title || desc);
      return;
    }
    if (isEdit) {
      saveBtn.disabled = false;
      return;
    }
    const hasNewFile = Boolean(uploadedMeta?.file || fileInput.files?.[0]);
    saveBtn.disabled = !hasNewFile;
  }

  function setMediaSource(source) {
    mediaSource = source;
    overlay.querySelectorAll('.media-source-btn').forEach((btn) => {
      const active = btn.dataset.source === source;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    overlay.querySelectorAll('[data-source-panel]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.sourcePanel !== source);
    });
    modalCard?.classList.toggle('media-modal-card--billboard', source === 'billboard');

    if (source === 'billboard') {
      syncBillboardPreview();
      if (!labelTouched && titleInput) {
        labelInput.value = titleInput.value.trim();
      }
    }
    syncSaveButton();
  }

  function syncBillboardPreview() {
    if (!titlePreview || !descPreview || !titleInput || !descInput) return;
    const title = titleInput.value.trim() || t('mediaModal.defaultBillboardTitle');
    const desc =
      descInput.value.trim() ||
      t('mediaModal.defaultBillboardDesc');
    titlePreview.innerHTML = escapeHtml(title).replace(/\n/g, '<br>');
    descPreview.innerHTML = escapeHtml(desc).replace(/\n/g, '<br>');
    if (!labelTouched) {
      labelInput.value = titleInput.value.trim();
    }
    syncSaveButton();
  }

  overlay.querySelectorAll('.media-source-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMediaSource(btn.dataset.source === 'billboard' ? 'billboard' : 'upload'));
  });
  titleInput?.addEventListener('input', syncBillboardPreview);
  descInput?.addEventListener('input', syncBillboardPreview);

  function syncVideoIosUpload() {
    const show = mediaSource === 'upload' && detectedType === 'video';
    iosUploadWrap?.classList.toggle('hidden', !show);
  }

  function syncDownloadButton(type) {
    const canDownload = type === 'image' || type === 'video';
    const hasFile = Boolean(previewObjectUrl || row?.media_url);
    downloadPngBtn?.classList.toggle('hidden', !(canDownload && hasFile));
  }

  function renderPreview(url, type) {
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'media-type-detected';
    tag.textContent =
      type === 'image'
        ? t('mediaModal.previewImage')
        : type === 'video'
          ? t('mediaModal.previewVideo')
          : type === 'splat'
            ? t('mediaModal.previewSplat')
            : t('mediaModal.previewModel');
    previewEl.appendChild(tag);
    if (type === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = t('mediaModal.previewAlt');
      previewEl.appendChild(img);
    } else if (type === 'video') {
      const vid = document.createElement('video');
      vid.src = url;
      vid.controls = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.loop = true;
      vid.className = 'media-preview-video';
      previewEl.appendChild(vid);
      vid.play().catch(() => {});
    } else if (type === 'model') {
      const p = document.createElement('p');
      p.className = 'media-preview-model';
      p.textContent = t('mediaModal.modelPreviewPending');
      previewEl.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.className = 'media-preview-model';
      p.textContent = t('mediaModal.splatPreviewPending');
      previewEl.appendChild(p);
    }
    syncDownloadButton(type);
  }

  if (row?.media_url) renderPreview(row.media_url, row.media_type);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      uploadedMeta = null;
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
      }
      detectedType = row?.media_type ?? null;
      previewEl.classList.add('hidden');
      previewEl.innerHTML = '';
      downloadPngBtn?.classList.add('hidden');
      uploadZone.classList.remove('media-upload-zone--ready');
      syncVideoIosUpload();
      syncSaveButton();
      return;
    }
    const classified = classifyMediaFile(file);
    if (!classified) {
      showToast(t('mediaModal.toastUnsupportedFile'), 'error');
      fileInput.value = '';
      syncSaveButton();
      return;
    }
    uploadedMeta = { file, ...classified };
    detectedType = classified.mediaType;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(file);
    renderPreview(previewObjectUrl, classified.mediaType);
    uploadZone.classList.add('media-upload-zone--ready');
    syncVideoIosUpload();
    syncSaveButton();
  });

  downloadPngBtn?.addEventListener('click', async () => {
    const mediaType = detectedType ?? row?.media_type;
    downloadPngBtn.disabled = true;
    try {
      await downloadMediaAsPng({
        media_url: row?.media_url,
        _previewUrl: previewObjectUrl,
        media_type: mediaType,
        mime_type: uploadedMeta?.mimeType ?? row?.mime_type,
        label: labelInput.value.trim() || row?.label,
        file_name: uploadedMeta?.file?.name ?? row?.file_name,
      });
      showToast(t('mediaModal.toastDownloadedPng'), 'success');
    } catch (err) {
      showToast(err.message ?? t('mediaModal.toastDownloadPngFailed'), 'error');
    } finally {
      downloadPngBtn.disabled = false;
    }
  });

  iosFileInput?.addEventListener('change', () => {
    const file = iosFileInput.files?.[0];
    if (!file) {
      uploadedIosMeta = null;
      return;
    }
    const classified = classifyMediaFile(file);
    if (!classified || classified.mediaType !== 'video' || classified.ext !== 'mov') {
      showToast(t('mediaModal.toastIosFileInvalid'), 'error');
      iosFileInput.value = '';
      uploadedIosMeta = null;
      return;
    }
    uploadedIosMeta = { file, ...classified };
  });

  if (row?.media_url_ios) {
    syncVideoIosUpload();
  }

  syncSaveButton();

  function close() {
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
    overlay.remove();
  }

  overlay.querySelectorAll('[data-action="close"]').forEach((el) => {
    el.addEventListener('click', close);
  });

  overlay.querySelector('#media-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;

    try {
      const poiType = getPoiType() || row?.poi_type;
      if (!poiType) throw new Error(t('mediaModal.errSignInRequired'));

      let mediaUrl = row?.media_url ?? '';
      let mediaUrlIos = row?.media_url_ios ?? null;
      let mimeType = row?.mime_type ?? null;
      let fileName = row?.file_name ?? null;
      let mediaType = detectedType ?? row?.media_type;

      if (mediaSource === 'billboard') {
        const title = titleInput.value.trim() || t('mediaModal.defaultBillboardTitle');
        const description = descInput.value.trim();
        const safeLabel = (labelInput.value.trim() || title).replace(/[^\w.-]+/g, '_').slice(0, 48);
        const file = await createArBillboardPngFile({
          title,
          description,
          fileName: `${safeLabel || 'AR_Billboard'}.png`,
        });
        const classified = classifyMediaFile(file);
        if (!classified) throw new Error(t('mediaModal.errBillboardCreateFailed'));
        uploadedMeta = { file, ...classified };
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = URL.createObjectURL(file);
      }

      if (uploadedMeta?.file) {
        const up = await uploadProjectMedia(uploadedMeta.file, poiType, uploadedMeta.mediaType);
        mediaUrl = up.publicUrl;
        mimeType = uploadedMeta.mimeType;
        fileName = uploadedMeta.file.name;
        mediaType = uploadedMeta.mediaType;
      } else if (!isEdit) {
        throw new Error(mediaSource === 'billboard' ? t('mediaModal.errBillboardFailed') : t('mediaModal.errChooseFile'));
      }

      if (uploadedIosMeta?.file) {
        const upIos = await uploadProjectMedia(uploadedIosMeta.file, poiType, 'video');
        mediaUrlIos = upIos.publicUrl;
      }

      if (!mediaType) throw new Error(t('mediaModal.errDetectMediaType'));

      const label =
        labelInput.value.trim() ||
        (mediaSource === 'billboard' ? titleInput?.value.trim() : '') ||
        fileName?.replace(/\.[^.]+$/, '') ||
        t('mediaModal.defaultLabel');

      let redirectLink = null;
      if (redirectYes.checked) {
        redirectLink = redirectLinkInput.value.trim();
        if (!redirectLink) {
          throw new Error(t('mediaModal.errRedirectLinkRequired'));
        }
        if (!/^https?:\/\//i.test(redirectLink)) {
          redirectLink = `https://${redirectLink}`;
        }
      }

      const payload = {
        poi_type: poiType,
        media_url: mediaUrl,
        media_url_ios: mediaUrlIos,
        media_type: mediaType,
        mime_type: mimeType,
        file_name: fileName,
        label,
        pos_x: placement.x ?? row?.pos_x ?? 0,
        pos_y: placement.y ?? row?.pos_y ?? 0,
        pos_z: placement.z ?? row?.pos_z ?? 0,
        rot_x: row?.rot_x ?? (!isEdit && mediaType === 'splat' ? -Math.PI / 2 : 0),
        rot_y: row?.rot_y ?? 0,
        rot_z: row?.rot_z ?? 0,
        scale_x: row?.scale_x ?? 1,
        scale_y: row?.scale_y ?? 1,
        scale_z: row?.scale_z ?? 1,
        width: row?.width ?? 1,
        height: row?.height ?? 1,
        is_active: row?.is_active ?? true,
        redirect_link: redirectLink,
      };

      let saved;
      if (isEdit) {
        const updated = await updateMediaRow(row.id, payload);
        saved = Array.isArray(updated) ? updated[0] : updated;
      } else {
        const inserted = await insertMediaRow(payload);
        saved = Array.isArray(inserted) ? inserted[0] : inserted;
      }

      showToast(isEdit ? t('mediaModal.toastMediaUpdated') : t('mediaModal.toastMediaAdded'), 'success');
      const previewUrl = uploadedMeta?.file ? previewObjectUrl ?? undefined : undefined;
      previewObjectUrl = null;
      await Promise.resolve(onSaved?.(saved, { previewUrl }));
      close();
    } catch (err) {
      console.error(err);
      showToast(err.message ?? String(err), 'error');
    } finally {
      syncSaveButton();
    }
  });
}
