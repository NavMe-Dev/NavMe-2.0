/**
 * Seed AR-billboard hint images for maclab + GCU treasures.
 * Usage: node scripts/seed-treasure-hints.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadEnv() {
  const envPath = path.join(root, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();
const SUPABASE_URL = env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const HEADERS = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

/** Unique title + description per treasure name (fallback uses name). */
const HINTS = {
  // maclab
  'Token Desk': {
    title: 'Desk Discovery',
    description: 'Where keyboards click and ideas start — search the desk closely.',
  },
  'Token POIs 2': {
    title: 'POI Corridor',
    description: 'Follow the point-of-interest markers. Your prize is near the second stop.',
  },
  'Token Entry': {
    title: 'At the Threshold',
    description: 'Every adventure begins at the door. Check near the entrance.',
  },
  'Token Origin': {
    title: 'Map Origin',
    description: 'Return to where the map begins. The token sits at the origin point.',
  },
  'Hidden Token': {
    title: 'Secret Mission',
    description: 'This one stays hidden until you finish the special mission nearby.',
  },
  // GCU
  'L2 Token 1': {
    title: 'Level 2 Clue 1',
    description: 'Scan this campus corner carefully — something shiny is waiting.',
  },
  'Token Court': {
    title: 'Court Whisper',
    description: 'The courtyard holds a quiet prize. Look where students gather.',
  },
  'Token Sports': {
    title: 'Sports Side',
    description: 'Energy lives near the sports zone. Hunt around the activity area.',
  },
  'L2 Token 2': {
    title: 'Level 2 Clue 2',
    description: 'Same landmark energy as the court — check a slightly higher perch.',
  },
  'L2 Token 3': {
    title: 'Level 2 Clue 3',
    description: 'Drift toward the quieter edge of campus. The token prefers calm corners.',
  },
  'Token Greenhouse': {
    title: 'Greenhouse Glow',
    description: 'Green leaves, warm glass — search beside the greenhouse path.',
  },
  'Token Crystal': {
    title: 'Crystal Trail',
    description: 'Follow the sparkle. A crystal-bright token hides near this spot.',
  },
  'L2 Token 4': {
    title: 'Level 2 Clue 4',
    description: 'Sports energy again — look a step higher than the ground markers.',
  },
  'L2 Token 5': {
    title: 'Level 2 Clue 5',
    description: 'Near the campus spine. Pause, look up, then look again.',
  },
  'Hidden Campus Token': {
    title: 'Campus Secret',
    description: 'Not every prize is obvious. This hidden campus token rewards curious eyes.',
  },
  'L2 Token 6': {
    title: 'Level 2 Clue 6',
    description: 'Between pathways and plazas — search the mid-campus bend.',
  },
  'L2 Token 7': {
    title: 'Level 2 Clue 7',
    description: 'Climb a little in your mind. This token sits higher than the rest.',
  },
  'L2 Token 8': {
    title: 'Level 2 Clue 8',
    description: 'Greenhouse side once more — check the approach from a new angle.',
  },
  'L2 Token 9': {
    title: 'Level 2 Clue 9',
    description: 'A round number landmark. Stand near 120 and sweep the surroundings.',
  },
  'L2 Token 10': {
    title: 'Level 2 Clue 10',
    description: 'Final stretch. Look midway across the campus walk for the last spark.',
  },
};

function wrapLines(ctx, text, maxWidth) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim() || ' ';
  const paragraphs = raw.split('\n');
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
      if (ctx.measureText(next).width <= maxWidth) line = next;
      else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

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

async function createBillboardPng(title, description) {
  const p = {
    ink: '#0a1626',
    navy: '#142438',
    gold: '#e8c547',
    goldDeep: '#c8962e',
    cream: '#fff8e7',
    muted: 'rgba(244, 239, 228, 0.78)',
    reflection: 'rgba(255, 248, 231, 0.14)',
  };
  const bgPath = path.join(root, 'public', 'treasurehuntdrawingbg.png');
  const treasureBgImg = fs.existsSync(bgPath) ? await loadImage(bgPath).catch(() => null) : null;

  const scale = 2;
  const cardW = 420;
  const pad = 32;
  const radius = 20;
  const titleSize = 30;
  const descSize = 17;
  const titleGap = 12;
  const titleLineHeight = 1.25;
  const descLineHeight = 1.65;
  const goldBarH = 4;
  const contentW = cardW - pad * 2;

  const measure = createCanvas(1, 1).getContext('2d');
  measure.font = `700 ${titleSize}px "DM Sans", system-ui, sans-serif`;
  const titleLines = wrapLines(measure, title, contentW);
  measure.font = `400 ${descSize}px "DM Sans", system-ui, sans-serif`;
  const descLines = wrapLines(measure, description, contentW);

  const titleBlockH = titleLines.length * titleSize * titleLineHeight;
  const descBlockH = descLines.length * descSize * descLineHeight;
  const cardH = Math.ceil(pad * 2 + goldBarH + titleBlockH + titleGap + descBlockH);
  const shadowPad = 20;

  const canvas = createCanvas(
    Math.round((cardW + shadowPad * 2) * scale),
    Math.round((cardH + shadowPad * 2) * scale),
  );
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const ox = shadowPad;
  const oy = shadowPad;
  const centerX = ox + cardW / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(10, 22, 38, 0.45)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 6;
  roundRectPath(ctx, ox, oy, cardW, cardH, radius);
  ctx.fillStyle = p.navy;
  ctx.fill();
  ctx.restore();

  roundRectPath(ctx, ox, oy, cardW, cardH, radius);
  const grad = ctx.createLinearGradient(ox, oy, ox, oy + cardH);
  grad.addColorStop(0, p.navy);
  grad.addColorStop(1, p.ink);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  roundRectPath(ctx, ox, oy, cardW, cardH, radius);
  ctx.clip();
  if (treasureBgImg) {
    const iw = treasureBgImg.width;
    const ih = treasureBgImg.height;
    const cover = Math.max(cardW / iw, cardH / ih);
    const dw = iw * cover;
    const dh = ih * cover;
    ctx.globalAlpha = 0.42;
    ctx.drawImage(treasureBgImg, ox + (cardW - dw) / 2, oy + (cardH - dh) / 2, dw, dh);
    ctx.globalAlpha = 1;
  }
  const veil = ctx.createLinearGradient(ox, oy, ox, oy + cardH);
  veil.addColorStop(0, 'rgba(10, 22, 38, 0.55)');
  veil.addColorStop(0.45, 'rgba(10, 22, 38, 0.72)');
  veil.addColorStop(1, 'rgba(10, 22, 38, 0.82)');
  ctx.fillStyle = veil;
  ctx.fillRect(ox, oy, cardW, cardH);

  const barGrad = ctx.createLinearGradient(ox, oy, ox + cardW, oy);
  barGrad.addColorStop(0, p.goldDeep);
  barGrad.addColorStop(0.5, p.gold);
  barGrad.addColorStop(1, p.goldDeep);
  ctx.fillStyle = barGrad;
  ctx.fillRect(ox, oy, cardW, goldBarH);
  ctx.fillStyle = p.reflection;
  ctx.fillRect(ox, oy + goldBarH, cardW, 40);
  ctx.restore();

  roundRectPath(ctx, ox + 0.5, oy + 0.5, cardW - 1, cardH - 1, radius);
  ctx.strokeStyle = 'rgba(232, 197, 71, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = p.cream;
  ctx.font = `700 ${titleSize}px "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let y = oy + pad + goldBarH * 0.5;
  for (const line of titleLines) {
    ctx.fillText(line, centerX, y);
    y += titleSize * titleLineHeight;
  }
  y += titleGap;

  ctx.strokeStyle = p.gold;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX - 36, y - titleGap / 2);
  ctx.lineTo(centerX + 36, y - titleGap / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = p.muted;
  ctx.font = `400 ${descSize}px "DM Sans", system-ui, sans-serif`;
  for (const line of descLines) {
    ctx.fillText(line, centerX, y);
    y += descSize * descLineHeight;
  }

  return canvas.toBuffer('image/png');
}

async function uploadPng(poiType, fileName, buffer) {
  const objectPath = `${poiType}/image/${Date.now()}_${fileName.replace(/[^\w.-]+/g, '_')}`;
  const url = `${SUPABASE_URL}/storage/v1/object/project-media/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`Upload ${res.status}: ${await res.text()}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/project-media/${objectPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

async function fetchTreasures() {
  const url = `${SUPABASE_URL}/rest/v1/treasure_items?select=*&poi_type=in.(maclab,GCU)&order=poi_type.asc,sort_order.asc`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${await res.text()}`);
  return res.json();
}

async function patchTreasure(id, body) {
  const url = `${SUPABASE_URL}/rest/v1/treasure_items?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`PATCH ${id} ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

function hintFor(row) {
  const preset = HINTS[row.name];
  if (preset) return preset;
  return {
    title: `${row.name} Hint`,
    description: row.hint || 'Search this spot carefully for a hidden treasure.',
  };
}

async function main() {
  const rows = await fetchTreasures();
  console.log(`Found ${rows.length} treasures (maclab + GCU)`);
  for (const row of rows) {
    const { title, description } = hintFor(row);
    const png = await createBillboardPng(title, description);
    const safe = String(row.name || 'treasure').replace(/[^\w.-]+/g, '_');
    const publicUrl = await uploadPng(row.poi_type, `Hint_${safe}.png`, png);
    const hintScale = row.poi_type === 'maclab' ? 0.55 : 1.2;
    const patch = {
      hint_title: title,
      hint: description,
      hint_image: publicUrl,
      hint_x: Number(row.pos_x) || 0,
      hint_y: (Number(row.pos_y) || 0) + (row.poi_type === 'maclab' ? 0.75 : 1.8),
      hint_z: Number(row.pos_z) || 0,
      hint_rot_x: 0,
      hint_rot_y: 0,
      hint_rot_z: 0,
      hint_scale_x: hintScale,
      hint_scale_y: hintScale,
      hint_scale_z: hintScale,
    };
    await patchTreasure(row.id, patch);
    console.log(`✓ ${row.poi_type} · ${row.name}`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
