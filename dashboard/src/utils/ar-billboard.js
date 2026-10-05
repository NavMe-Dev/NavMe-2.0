/**
 * Render an AR billboard (title + description) to a PNG File.
 * Themes: default (white NavMe card) | treasure (navy / gold / cream hunt palette).
 */

const NAV_BG_SRC = `${import.meta.env.BASE_URL}login-indoor-nav-bg.png`;
const TREASURE_BG_SRC = `${import.meta.env.BASE_URL}treasurehuntdrawingbg.png`;

/** Treasure Hunt / GCU splash palette */
export const TREASURE_BILLBOARD_PALETTE = {
  ink: '#0a1626',
  navy: '#142438',
  gold: '#e8c547',
  goldDeep: '#c8962e',
  cream: '#fff8e7',
  muted: 'rgba(244, 239, 228, 0.78)',
  reflection: 'rgba(255, 248, 231, 0.14)',
};

/** @type {Map<string, HTMLImageElement>} */
const imageCache = new Map();

/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(src) {
  const cached = imageCache.get(src);
  if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapLines(ctx, text, maxWidth) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim() || ' ';
  const paragraphs = raw.split('\n');
  /** @type {string[]} */
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const next = `${line} ${words[i]}`;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
      } else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function roundRectPath(ctx, x, y, w, h, r) {
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
 * @param {{ title?: string, description?: string, fileName?: string, theme?: 'default'|'treasure' }} options
 * @returns {Promise<File>}
 */
export async function createArBillboardPngFile(options = {}) {
  const title = String(options.title ?? '').trim() || 'Welcome to NavMe';
  const description =
    String(options.description ?? '').trim() ||
    'Experience seamless indoor navigation with intelligent AR guidance.';
  const fileName = String(options.fileName ?? 'AR_Billboard.png').replace(/[^\w.-]+/g, '_');
  const theme = options.theme === 'treasure' ? 'treasure' : 'default';
  const isTreasure = theme === 'treasure';

  const navBgImg = isTreasure ? null : await loadImage(NAV_BG_SRC).catch(() => null);
  const treasureBgImg = isTreasure ? await loadImage(TREASURE_BG_SRC).catch(() => null) : null;

  const scale = 2;
  const cardW = 420;
  const pad = 32;
  const radius = 20;
  const titleSize = 30;
  const descSize = 17;
  const titleGap = 12;
  const titleLineHeight = 1.25;
  const descLineHeight = 1.65;
  const goldBarH = isTreasure ? 4 : 0;
  const contentW = cardW - pad * 2;

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('Could not create canvas for billboard.');

  measure.font = `700 ${titleSize}px "DM Sans", system-ui, sans-serif`;
  const titleLines = wrapLines(measure, title, contentW);
  measure.font = `400 ${descSize}px "DM Sans", system-ui, sans-serif`;
  const descLines = wrapLines(measure, description, contentW);

  const titleBlockH = titleLines.length * titleSize * titleLineHeight;
  const descBlockH = descLines.length * descSize * descLineHeight;
  const cardH = Math.ceil(pad * 2 + goldBarH + titleBlockH + titleGap + descBlockH);

  const shadowPad = 20;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((cardW + shadowPad * 2) * scale);
  canvas.height = Math.round((cardH + shadowPad * 2) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas for billboard.');

  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, cardW + shadowPad * 2, cardH + shadowPad * 2);

  const ox = shadowPad;
  const oy = shadowPad;
  const centerX = ox + cardW / 2;
  const p = TREASURE_BILLBOARD_PALETTE;

  // Soft shadow
  ctx.save();
  ctx.shadowColor = isTreasure ? 'rgba(10, 22, 38, 0.45)' : 'rgba(15, 23, 42, 0.12)';
  ctx.shadowBlur = isTreasure ? 22 : 18;
  ctx.shadowOffsetY = 6;
  roundRectPath(ctx, ox, oy, cardW, cardH, radius);
  ctx.fillStyle = isTreasure ? p.navy : '#ffffff';
  ctx.fill();
  ctx.restore();

  // Card base
  roundRectPath(ctx, ox, oy, cardW, cardH, radius);
  if (isTreasure) {
    const grad = ctx.createLinearGradient(ox, oy, ox, oy + cardH);
    grad.addColorStop(0, p.navy);
    grad.addColorStop(1, p.ink);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = '#ffffff';
  }
  ctx.fill();

  if (isTreasure) {
    ctx.save();
    roundRectPath(ctx, ox, oy, cardW, cardH, radius);
    ctx.clip();

    // Drawing collage as atmospheric bg
    if (treasureBgImg) {
      const iw = treasureBgImg.naturalWidth || treasureBgImg.width;
      const ih = treasureBgImg.naturalHeight || treasureBgImg.height;
      const cover = Math.max(cardW / iw, cardH / ih);
      const dw = iw * cover;
      const dh = ih * cover;
      ctx.globalAlpha = 0.42;
      ctx.drawImage(treasureBgImg, ox + (cardW - dw) / 2, oy + (cardH - dh) / 2, dw, dh);
      ctx.globalAlpha = 1;
    }

    // Dark veil so cream text stays readable while gold line-art still shows through
    const veil = ctx.createLinearGradient(ox, oy, ox, oy + cardH);
    veil.addColorStop(0, 'rgba(10, 22, 38, 0.55)');
    veil.addColorStop(0.45, 'rgba(10, 22, 38, 0.72)');
    veil.addColorStop(1, 'rgba(10, 22, 38, 0.82)');
    ctx.fillStyle = veil;
    ctx.fillRect(ox, oy, cardW, cardH);

    // Gold top accent bar
    const barGrad = ctx.createLinearGradient(ox, oy, ox + cardW, oy);
    barGrad.addColorStop(0, p.goldDeep);
    barGrad.addColorStop(0.5, p.gold);
    barGrad.addColorStop(1, p.goldDeep);
    ctx.fillStyle = barGrad;
    ctx.fillRect(ox, oy, cardW, goldBarH);

    // Soft cream reflection under the bar
    ctx.fillStyle = p.reflection;
    ctx.fillRect(ox, oy + goldBarH, cardW, 40);
    ctx.restore();
  } else if (navBgImg) {
    ctx.save();
    roundRectPath(ctx, ox, oy, cardW, cardH, radius);
    ctx.clip();

    const iw = navBgImg.naturalWidth || navBgImg.width;
    const ih = navBgImg.naturalHeight || navBgImg.height;
    const cover = Math.max(cardW / iw, cardH / ih);
    const dw = iw * cover;
    const dh = ih * cover;
    ctx.globalAlpha = 0.22;
    ctx.drawImage(navBgImg, ox + (cardW - dw) / 2, oy + (cardH - dh) / 2, dw, dh);
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, ox, oy, cardW, cardH, radius);
    ctx.clip();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.fillRect(ox, oy, cardW, cardH);
    ctx.restore();
  }

  roundRectPath(ctx, ox + 0.5, oy + 0.5, cardW - 1, cardH - 1, radius);
  ctx.strokeStyle = isTreasure ? 'rgba(232, 197, 71, 0.35)' : 'rgba(15, 23, 42, 0.1)';
  ctx.lineWidth = isTreasure ? 1.5 : 1;
  ctx.stroke();

  // Title
  ctx.fillStyle = isTreasure ? p.cream : '#0f172a';
  ctx.font = `700 ${titleSize}px "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let y = oy + pad + (isTreasure ? goldBarH * 0.5 : 0);
  if (isTreasure) {
    ctx.shadowColor = 'rgba(10, 22, 38, 0.95)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 1;
  }
  for (const line of titleLines) {
    ctx.fillText(line, centerX, y);
    y += titleSize * titleLineHeight;
  }

  y += titleGap;

  // Gold divider under title (treasure)
  if (isTreasure) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.strokeStyle = p.gold;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX - 36, y - titleGap / 2);
    ctx.lineTo(centerX + 36, y - titleGap / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Description
  ctx.fillStyle = isTreasure ? p.muted : '#334155';
  ctx.font = `400 ${descSize}px "DM Sans", system-ui, sans-serif`;
  if (isTreasure) {
    ctx.shadowColor = 'rgba(10, 22, 38, 0.9)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 1;
  }
  for (const line of descLines) {
    ctx.fillText(line, centerX, y);
    y += descSize * descLineHeight;
  }
  if (isTreasure) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Failed to export billboard PNG.'));
    }, 'image/png');
  });

  return new File([blob], fileName.endsWith('.png') ? fileName : `${fileName}.png`, {
    type: 'image/png',
  });
}
