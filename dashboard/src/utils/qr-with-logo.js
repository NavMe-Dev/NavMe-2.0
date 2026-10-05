/**
 * QR generation with an optional centered logo.
 *
 * Scannability is the whole point here, so two rules are non-negotiable:
 *
 *  1. **Error correction jumps to 'H' whenever a logo is present.** A logo
 *     physically destroys modules; level H recovers up to ~30% of codewords,
 *     level M only ~15%. Without this the code can still *look* fine and fail
 *     to scan. With no logo we stay on 'M', which keeps the pattern less dense
 *     and therefore easier to scan at distance.
 *
 *  2. **The logo is capped as a fraction of the QR's width**, not drawn at its
 *     natural size. At LOGO_WIDTH_RATIO the logo plus its white pad covers
 *     roughly 6% of the code's area — comfortably inside level H's budget, and
 *     centered so it can never touch the three finder patterns in the corners.
 *
 * The quiet-zone margin is always preserved; scanners need it to find the code.
 */

import QRCode from 'qrcode';

/** Logo edge length as a fraction of the QR edge. ~4% of total area. */
const LOGO_WIDTH_RATIO = 0.2;
/** White plate behind the logo, as a fraction of the QR edge. ~6% of area. */
const PLATE_WIDTH_RATIO = 0.25;
/** Corner rounding on the white plate, as a fraction of the plate edge. */
const PLATE_RADIUS_RATIO = 0.18;

export const QR_RENDER_SIZE = 512;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Image types a browser canvas can reliably draw. SVG is excluded on purpose. */
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * @param {File} file
 * @returns {string} empty string when acceptable, otherwise the reason
 */
export function validateLogoFile(file) {
  if (!file) return 'No file selected';
  if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
    return 'Use a PNG, JPG, WEBP or GIF image';
  }
  if (file.size > MAX_LOGO_BYTES) {
    return 'Image must be under 2 MB';
  }
  return '';
}

/** Read a File into an HTMLImageElement, rejecting anything that will not decode. */
export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not a readable image'));
      img.src = String(reader.result ?? '');
    };
    reader.readAsDataURL(file);
  });
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Render a QR code, optionally with a centered logo.
 *
 * @param {string} text                     the URL to encode
 * @param {HTMLImageElement | null} logoImg  decoded logo, or null for a plain QR
 * @param {{ size?: number, dark?: string, light?: string }} [opts]
 * @returns {Promise<string>} PNG data URL
 */
export async function generateQrDataUrl(text, logoImg = null, opts = {}) {
  const size = Number(opts.size) > 0 ? Number(opts.size) : QR_RENDER_SIZE;
  const dark = opts.dark ?? '#0f172a';
  const light = opts.light ?? '#ffffff';

  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, text, {
    // See rule 1 above — a logo is only safe at level H.
    errorCorrectionLevel: logoImg ? 'H' : 'M',
    margin: 2,
    width: size,
    color: { dark, light },
  });

  if (!logoImg) return canvas.toDataURL('image/png');

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');

  const edge = canvas.width;
  const plate = Math.round(edge * PLATE_WIDTH_RATIO);
  const logoBox = Math.round(edge * LOGO_WIDTH_RATIO);

  // Preserve the logo's aspect ratio inside its box; never upscale past the box.
  const natW = logoImg.naturalWidth || logoImg.width || 1;
  const natH = logoImg.naturalHeight || logoImg.height || 1;
  const scale = Math.min(logoBox / natW, logoBox / natH);
  const drawW = Math.max(1, Math.round(natW * scale));
  const drawH = Math.max(1, Math.round(natH * scale));

  const plateX = Math.round((edge - plate) / 2);
  const plateY = Math.round((edge - plate) / 2);

  // Opaque plate: transparent PNGs would otherwise leave QR modules showing
  // through the logo, which reads as noise to a scanner.
  ctx.save();
  ctx.fillStyle = light;
  roundedRectPath(ctx, plateX, plateY, plate, plate, plate * PLATE_RADIUS_RATIO);
  ctx.fill();
  ctx.restore();

  ctx.drawImage(
    logoImg,
    Math.round((edge - drawW) / 2),
    Math.round((edge - drawH) / 2),
    drawW,
    drawH,
  );

  return canvas.toDataURL('image/png');
}

/**
 * Coverage figures for the current ratios, so the safety margin is inspectable
 * rather than a matter of trust. Level H tolerates ~30% damage.
 */
export function logoCoverageStats() {
  const logoArea = LOGO_WIDTH_RATIO * LOGO_WIDTH_RATIO;
  const plateArea = PLATE_WIDTH_RATIO * PLATE_WIDTH_RATIO;
  return {
    logoWidthPct: LOGO_WIDTH_RATIO * 100,
    logoAreaPct: logoArea * 100,
    plateAreaPct: plateArea * 100,
    errorCorrectionBudgetPct: 30,
    headroomPct: 30 - plateArea * 100,
  };
}
