/** Floor-plan line symbols (architectural drawing style, 0–1 normalized inside bbox). */

import { chairGridDims, CHAIR_ROW_GAP, CHAIR_ROW_UNIT } from './objectCatalog';

export type SymbolDrawOptions = { count?: number };

type Sym = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: string,
  lw: number,
) => void;

function strokeOnly(
  ctx: CanvasRenderingContext2D,
  stroke: string,
  lw: number,
  draw: (p: (nx: number, ny: number) => [number, number]) => void,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.fillStyle = 'transparent';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const p = (nx: number, ny: number): [number, number] => [x + nx * w, y + ny * h];
  draw(p);
  ctx.restore();
}

function fillStroke(
  ctx: CanvasRenderingContext2D,
  stroke: string,
  fill: string,
  lw: number,
  draw: (p: (nx: number, ny: number) => [number, number]) => void,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const p = (nx: number, ny: number): [number, number] => [x + nx * w, y + ny * h];
  draw(p);
  ctx.restore();
}

const rectOutline: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.08, 0.12), p(0.92, 0.12), p(0.92, 0.88), p(0.08, 0.88)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.stroke();
  }, x, y, w, h);
};

const chair: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.2, 0.2), p(0.8, 0.2), p(0.8, 0.85), p(0.2, 0.85)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const [s, e] = [p(0.35, 0.85), p(0.65, 0.85)];
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(e[0], e[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const chairRound: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const c = p(0.5, 0.5);
    const rx = w * 0.38;
    const ry = h * 0.38;
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }, x, y, w, h);
};

const sofa: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [tl, tr, br, bl] = [p(0.06, 0.25), p(0.94, 0.25), p(0.94, 0.82), p(0.06, 0.82)];
    ctx.beginPath();
    ctx.moveTo(tl[0], tl[1]);
    ctx.lineTo(tr[0], tr[1]);
    ctx.lineTo(br[0], br[1]);
    ctx.lineTo(bl[0], bl[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    for (const nx of [0.33, 0.66]) {
      const [a, b] = [p(nx, 0.25), p(nx, 0.82)];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }, x, y, w, h);
};

const table: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.1, 0.2), p(0.9, 0.2), p(0.9, 0.8), p(0.1, 0.8)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const [c1, c2, c3, c4] = [p(0.1, 0.2), p(0.9, 0.8), p(0.9, 0.2), p(0.1, 0.8)];
    ctx.beginPath();
    ctx.moveTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]);
    ctx.moveTo(c3[0], c3[1]);
    ctx.lineTo(c4[0], c4[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const tableRound: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const c = p(0.5, 0.5);
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], w * 0.4, h * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], w * 0.15, h * 0.15, 0, 0, Math.PI * 2);
    ctx.stroke();
  }, x, y, w, h);
};

const door: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b] = [p(0.15, 0.1), p(0.15, 0.9)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    const hinge = p(0.15, 0.1);
    const r = Math.min(w, h) * 0.75;
    ctx.beginPath();
    ctx.arc(hinge[0], hinge[1], r, 0, Math.PI / 2);
    ctx.stroke();
  }, x, y, w, h);
};

const doubleDoor: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const mid = p(0.5, 0.1);
    const [l, r] = [p(0.1, 0.1), p(0.9, 0.1)];
    ctx.beginPath();
    ctx.moveTo(l[0], l[1]);
    ctx.lineTo(l[0], p(0.1, 0.9)[1]);
    ctx.moveTo(r[0], r[1]);
    ctx.lineTo(r[0], p(0.9, 0.9)[1]);
    ctx.moveTo(mid[0], mid[1]);
    ctx.lineTo(mid[0], p(0.5, 0.9)[1]);
    ctx.stroke();
    const r1 = Math.min(w, h) * 0.38;
    ctx.beginPath();
    ctx.arc(l[0], l[1], r1, 0, Math.PI / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(r[0], r[1], r1, Math.PI / 2, Math.PI);
    ctx.stroke();
  }, x, y, w, h);
};

const window: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.08, 0.35), p(0.92, 0.35), p(0.92, 0.65), p(0.08, 0.65)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.moveTo(d[0], d[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();
    const mid = p(0.5, 0.35);
    ctx.beginPath();
    ctx.moveTo(mid[0], mid[1]);
    ctx.lineTo(p(0.5, 0.65)[0], p(0.5, 0.65)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const wall: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw * 2.2, (p) => {
    const [a, b] = [p(0.05, 0.5), p(0.95, 0.5)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const pillar: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const c = p(0.5, 0.5);
    ctx.beginPath();
    ctx.arc(c[0], c[1], Math.min(w, h) * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.2, 0.2)[0], p(0.2, 0.2)[1]);
    ctx.lineTo(p(0.8, 0.8)[0], p(0.8, 0.8)[1]);
    ctx.moveTo(p(0.8, 0.2)[0], p(0.8, 0.2)[1]);
    ctx.lineTo(p(0.2, 0.8)[0], p(0.2, 0.8)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const stairs: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const [a, b] = [p(0.1, 0.15 + t * 0.7), p(0.9, 0.15 + t * 0.7)];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }, x, y, w, h);
};

const plant: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const c = p(0.5, 0.5);
    ctx.beginPath();
    ctx.arc(c[0], c[1], Math.min(w, h) * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const r0 = Math.min(w, h) * 0.12;
      const r1 = Math.min(w, h) * 0.38;
      ctx.beginPath();
      ctx.moveTo(c[0] + Math.cos(ang) * r0, c[1] + Math.sin(ang) * r0);
      ctx.lineTo(c[0] + Math.cos(ang) * r1, c[1] + Math.sin(ang) * r1);
      ctx.stroke();
    }
  }, x, y, w, h);
};

const stage: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.05, 0.55), p(0.95, 0.55), p(0.88, 0.85), p(0.12, 0.85)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }, x, y, w, h);
};

const bed: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.08, 0.15), p(0.92, 0.15), p(0.92, 0.88), p(0.08, 0.88)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const [p1, p2, p3, p4] = [p(0.08, 0.15), p(0.92, 0.15), p(0.92, 0.38), p(0.08, 0.38)];
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]);
    ctx.lineTo(p4[0], p4[1]);
    ctx.closePath();
    ctx.stroke();
  }, x, y, w, h);
};

const bunkBed: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const outline = [p(0.1, 0.12), p(0.9, 0.12), p(0.9, 0.88), p(0.1, 0.88)];
    ctx.beginPath();
    ctx.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(outline[i][0], outline[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.1, 0.5)[0], p(0.1, 0.5)[1]);
    ctx.lineTo(p(0.9, 0.5)[0], p(0.9, 0.5)[1]);
    ctx.stroke();
    for (const ny of [0.28, 0.68]) {
      ctx.beginPath();
      ctx.moveTo(p(0.1, ny)[0], p(0.1, ny)[1]);
      ctx.lineTo(p(0.9, ny)[0], p(0.9, ny)[1]);
      ctx.stroke();
    }
  }, x, y, w, h);
};

const sofaL: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    ctx.beginPath();
    ctx.moveTo(p(0.08, 0.08)[0], p(0.08, 0.08)[1]);
    ctx.lineTo(p(0.55, 0.08)[0], p(0.55, 0.08)[1]);
    ctx.lineTo(p(0.55, 0.55)[0], p(0.55, 0.55)[1]);
    ctx.lineTo(p(0.92, 0.55)[0], p(0.92, 0.55)[1]);
    ctx.lineTo(p(0.92, 0.92)[0], p(0.92, 0.92)[1]);
    ctx.lineTo(p(0.08, 0.92)[0], p(0.08, 0.92)[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }, x, y, w, h);
};

const appliance: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.12, 0.12), p(0.88, 0.12), p(0.88, 0.88), p(0.12, 0.88)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.12, 0.28)[0], p(0.12, 0.28)[1]);
    ctx.lineTo(p(0.88, 0.28)[0], p(0.88, 0.28)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const bathtub: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const c = p(0.5, 0.5);
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], w * 0.4, h * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], w * 0.28, h * 0.2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }, x, y, w, h);
};

const shower: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.15, 0.15), p(0.85, 0.15), p(0.85, 0.85), p(0.15, 0.85)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p(0.5, 0.35)[0], p(0.5, 0.35)[1], Math.min(w, h) * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.5, 0.35)[0], p(0.5, 0.35)[1]);
    ctx.lineTo(p(0.5, 0.7)[0], p(0.5, 0.7)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const toilet: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.25, 0.1), p(0.75, 0.1), p(0.75, 0.4), p(0.25, 0.4)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const ctr = p(0.5, 0.65);
    ctx.beginPath();
    ctx.ellipse(ctr[0], ctr[1], w * 0.22, h * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }, x, y, w, h);
};

const kitchenSink: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.1, 0.2), p(0.9, 0.2), p(0.9, 0.8), p(0.1, 0.8)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(p(0.2, 0.32)[0], p(0.2, 0.32)[1], w * 0.6, h * 0.36);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p(0.5, 0.28)[0], p(0.5, 0.28)[1], Math.min(w, h) * 0.04, 0, Math.PI * 2);
    ctx.stroke();
  }, x, y, w, h);
};

const fireplace: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.08, 0.25), p(0.92, 0.25), p(0.92, 0.85), p(0.08, 0.85)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.25, 0.85)[0], p(0.25, 0.85)[1]);
    ctx.lineTo(p(0.35, 0.45)[0], p(0.35, 0.45)[1]);
    ctx.lineTo(p(0.5, 0.7)[0], p(0.5, 0.7)[1]);
    ctx.lineTo(p(0.65, 0.4)[0], p(0.65, 0.4)[1]);
    ctx.lineTo(p(0.75, 0.85)[0], p(0.75, 0.85)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const booth: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.1, 0.1), p(0.9, 0.1), p(0.9, 0.9), p(0.1, 0.9)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const opening = p(0.5, 0.1);
    ctx.beginPath();
    ctx.moveTo(p(0.35, 0.1)[0], p(0.35, 0.1)[1]);
    ctx.lineTo(p(0.65, 0.1)[0], p(0.65, 0.1)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const screen: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.08, 0.4), p(0.92, 0.4), p(0.92, 0.6), p(0.08, 0.6)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.5, 0.6)[0], p(0.5, 0.6)[1]);
    ctx.lineTo(p(0.5, 0.75)[0], p(0.5, 0.75)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

const restroom: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.1, 0.1), p(0.9, 0.1), p(0.9, 0.9), p(0.1, 0.9)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = `600 ${Math.max(8, h * 0.28)}px system-ui,sans-serif`;
    ctx.fillStyle = stroke;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WC', p(0.5, 0.5)[0], p(0.5, 0.5)[1]);
  }, x, y, w, h);
};

/** Plug / charging point — small counter with lightning. */
const chargingPoint: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.12, 0.28), p(0.88, 0.28), p(0.88, 0.78), p(0.12, 0.78)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Lightning bolt
    ctx.beginPath();
    ctx.moveTo(p(0.52, 0.34)[0], p(0.52, 0.34)[1]);
    ctx.lineTo(p(0.38, 0.52)[0], p(0.38, 0.52)[1]);
    ctx.lineTo(p(0.5, 0.52)[0], p(0.5, 0.52)[1]);
    ctx.lineTo(p(0.42, 0.72)[0], p(0.42, 0.72)[1]);
    ctx.lineTo(p(0.64, 0.48)[0], p(0.64, 0.48)[1]);
    ctx.lineTo(p(0.5, 0.48)[0], p(0.5, 0.48)[1]);
    ctx.closePath();
    ctx.stroke();
  }, x, y, w, h);
};

/** Multi-slot charging station desk. */
const chargingStation: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.06, 0.2), p(0.94, 0.2), p(0.94, 0.8), p(0.06, 0.8)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    for (const nx of [0.28, 0.5, 0.72]) {
      ctx.beginPath();
      ctx.moveTo(p(nx, 0.32)[0], p(nx, 0.32)[1]);
      ctx.lineTo(p(nx, 0.68)[0], p(nx, 0.68)[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p(nx, 0.5)[0], p(nx, 0.5)[1], Math.min(w, h) * 0.06, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** EV charger pedestal. */
const evCharger: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.28, 0.12), p(0.72, 0.12), p(0.72, 0.78), p(0.28, 0.78)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.4, 0.78)[0], p(0.4, 0.78)[1]);
    ctx.lineTo(p(0.4, 0.9)[0], p(0.4, 0.9)[1]);
    ctx.lineTo(p(0.6, 0.9)[0], p(0.6, 0.9)[1]);
    ctx.lineTo(p(0.6, 0.78)[0], p(0.6, 0.78)[1]);
    ctx.stroke();
    // Cable
    ctx.beginPath();
    ctx.moveTo(p(0.72, 0.4)[0], p(0.72, 0.4)[1]);
    ctx.quadraticCurveTo(p(0.92, 0.5)[0], p(0.92, 0.5)[1], p(0.78, 0.7)[0], p(0.78, 0.7)[1]);
    ctx.stroke();
    // Lightning mark on face
    ctx.beginPath();
    ctx.moveTo(p(0.54, 0.25)[0], p(0.54, 0.25)[1]);
    ctx.lineTo(p(0.42, 0.45)[0], p(0.42, 0.45)[1]);
    ctx.lineTo(p(0.52, 0.45)[0], p(0.52, 0.45)[1]);
    ctx.lineTo(p(0.44, 0.65)[0], p(0.44, 0.65)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

/** Wall power outlet. */
const powerOutlet: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.15, 0.2), p(0.85, 0.2), p(0.85, 0.8), p(0.15, 0.8)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.stroke();
    for (const nx of [0.35, 0.65]) {
      ctx.beginPath();
      ctx.moveTo(p(nx, 0.35)[0], p(nx, 0.35)[1]);
      ctx.lineTo(p(nx, 0.55)[0], p(nx, 0.55)[1]);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p(0.5, 0.68)[0], p(0.5, 0.68)[1], Math.min(w, h) * 0.06, 0, Math.PI * 2);
    ctx.stroke();
  }, x, y, w, h);
};

/** Wi‑Fi hotspot circle with arcs. */
const wifi: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const c = p(0.5, 0.7);
    ctx.beginPath();
    ctx.arc(c[0], c[1], Math.min(w, h) * 0.06, 0, Math.PI * 2);
    ctx.stroke();
    for (const r of [0.18, 0.3, 0.42]) {
      ctx.beginPath();
      ctx.arc(c[0], c[1], Math.min(w, h) * r, -Math.PI * 0.75, -Math.PI * 0.25);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** Water fountain. */
const waterFountain: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const [a, b, c, d] = [p(0.2, 0.45), p(0.8, 0.45), p(0.75, 0.85), p(0.25, 0.85)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.5, 0.45)[0], p(0.5, 0.45)[1]);
    ctx.lineTo(p(0.5, 0.2)[0], p(0.5, 0.2)[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p(0.5, 0.2)[0], p(0.5, 0.2)[1], Math.min(w, h) * 0.08, Math.PI, 0);
    ctx.stroke();
  }, x, y, w, h);
};

/** Top-down car body with wheels. */
const car: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const body = [p(0.08, 0.22), p(0.92, 0.22), p(0.92, 0.78), p(0.08, 0.78)];
    ctx.beginPath();
    ctx.moveTo(body[0][0], body[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(body[i][0], body[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.28, 0.3)[0], p(0.28, 0.3)[1]);
    ctx.lineTo(p(0.72, 0.3)[0], p(0.72, 0.3)[1]);
    ctx.lineTo(p(0.72, 0.7)[0], p(0.72, 0.7)[1]);
    ctx.lineTo(p(0.28, 0.7)[0], p(0.28, 0.7)[1]);
    ctx.closePath();
    ctx.stroke();
    const wr = Math.min(w, h) * 0.08;
    for (const [nx, ny] of [
      [0.22, 0.18],
      [0.78, 0.18],
      [0.22, 0.82],
      [0.78, 0.82],
    ] as const) {
      const c = p(nx, ny);
      ctx.beginPath();
      ctx.arc(c[0], c[1], wr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** Longer van / bus body. */
const van: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const body = [p(0.05, 0.2), p(0.95, 0.2), p(0.95, 0.8), p(0.05, 0.8)];
    ctx.beginPath();
    ctx.moveTo(body[0][0], body[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(body[i][0], body[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.28, 0.2)[0], p(0.28, 0.2)[1]);
    ctx.lineTo(p(0.28, 0.8)[0], p(0.28, 0.8)[1]);
    ctx.stroke();
    for (const nx of [0.4, 0.58, 0.76]) {
      ctx.beginPath();
      ctx.rect(p(nx, 0.32)[0], p(nx, 0.32)[1], w * 0.12, h * 0.36);
      ctx.stroke();
    }
    const wr = Math.min(w, h) * 0.07;
    for (const [nx, ny] of [
      [0.18, 0.16],
      [0.82, 0.16],
      [0.18, 0.84],
      [0.82, 0.84],
    ] as const) {
      const c = p(nx, ny);
      ctx.beginPath();
      ctx.arc(c[0], c[1], wr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** Truck with cab + cargo box. */
const truck: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    ctx.beginPath();
    ctx.moveTo(p(0.05, 0.22)[0], p(0.05, 0.22)[1]);
    ctx.lineTo(p(0.32, 0.22)[0], p(0.32, 0.22)[1]);
    ctx.lineTo(p(0.32, 0.78)[0], p(0.32, 0.78)[1]);
    ctx.lineTo(p(0.05, 0.78)[0], p(0.05, 0.78)[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.34, 0.18)[0], p(0.34, 0.18)[1]);
    ctx.lineTo(p(0.95, 0.18)[0], p(0.95, 0.18)[1]);
    ctx.lineTo(p(0.95, 0.82)[0], p(0.95, 0.82)[1]);
    ctx.lineTo(p(0.34, 0.82)[0], p(0.34, 0.82)[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const wr = Math.min(w, h) * 0.07;
    for (const [nx, ny] of [
      [0.16, 0.16],
      [0.5, 0.16],
      [0.82, 0.16],
      [0.16, 0.84],
      [0.5, 0.84],
      [0.82, 0.84],
    ] as const) {
      const c = p(nx, ny);
      ctx.beginPath();
      ctx.arc(c[0], c[1], wr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** Bicycle top-down. */
const bicycle: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const wr = Math.min(w, h) * 0.22;
    const front = p(0.78, 0.5);
    const rear = p(0.22, 0.5);
    ctx.beginPath();
    ctx.arc(front[0], front[1], wr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rear[0], rear[1], wr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rear[0], rear[1]);
    ctx.lineTo(p(0.45, 0.35)[0], p(0.45, 0.35)[1]);
    ctx.lineTo(front[0], front[1]);
    ctx.moveTo(p(0.45, 0.35)[0], p(0.45, 0.35)[1]);
    ctx.lineTo(p(0.5, 0.65)[0], p(0.5, 0.65)[1]);
    ctx.lineTo(rear[0], rear[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.72, 0.32)[0], p(0.72, 0.32)[1]);
    ctx.lineTo(p(0.82, 0.32)[0], p(0.82, 0.32)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

/** Motorcycle / scooter. */
const motorcycle: Sym = (ctx, x, y, w, h, stroke, lw) => {
  fillStroke(ctx, stroke, '#fff', lw, (p) => {
    const wr = Math.min(w, h) * 0.18;
    const front = p(0.8, 0.5);
    const rear = p(0.2, 0.5);
    ctx.beginPath();
    ctx.arc(front[0], front[1], wr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rear[0], rear[1], wr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.28, 0.38)[0], p(0.28, 0.38)[1]);
    ctx.lineTo(p(0.7, 0.38)[0], p(0.7, 0.38)[1]);
    ctx.lineTo(p(0.72, 0.62)[0], p(0.72, 0.62)[1]);
    ctx.lineTo(p(0.3, 0.62)[0], p(0.3, 0.62)[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p(0.35, 0.32)[0], p(0.35, 0.32)[1]);
    ctx.lineTo(p(0.58, 0.32)[0], p(0.58, 0.32)[1]);
    ctx.stroke();
  }, x, y, w, h);
};

/** Bike rack — row of bike slots. */
const bikeRack: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.08, 0.2), p(0.92, 0.2), p(0.92, 0.8), p(0.08, 0.8)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.stroke();
    for (const nx of [0.25, 0.4, 0.55, 0.7]) {
      ctx.beginPath();
      ctx.moveTo(p(nx, 0.25)[0], p(nx, 0.25)[1]);
      ctx.lineTo(p(nx, 0.75)[0], p(nx, 0.75)[1]);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** Parking bay outline with P mark. */
const parkingSpot: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    const [a, b, c, d] = [p(0.06, 0.1), p(0.94, 0.1), p(0.94, 0.9), p(0.06, 0.9)];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(p(0.06, 0.1)[0], p(0.06, 0.1)[1]);
    ctx.lineTo(p(0.94, 0.1)[0], p(0.94, 0.1)[1]);
    ctx.moveTo(p(0.06, 0.9)[0], p(0.06, 0.9)[1]);
    ctx.lineTo(p(0.94, 0.9)[0], p(0.94, 0.9)[1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }, x, y, w, h);
  ctx.save();
  ctx.fillStyle = stroke;
  ctx.font = `700 ${Math.max(8, Math.min(w, h) * 0.28)}px system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', x + w * 0.5, y + h * 0.5);
  ctx.restore();
};

/** Shopping cart / trolley. */
const cart: Sym = (ctx, x, y, w, h, stroke, lw) => {
  strokeOnly(ctx, stroke, lw, (p) => {
    ctx.beginPath();
    ctx.moveTo(p(0.15, 0.25)[0], p(0.15, 0.25)[1]);
    ctx.lineTo(p(0.85, 0.25)[0], p(0.85, 0.25)[1]);
    ctx.lineTo(p(0.78, 0.7)[0], p(0.78, 0.7)[1]);
    ctx.lineTo(p(0.22, 0.7)[0], p(0.22, 0.7)[1]);
    ctx.closePath();
    ctx.stroke();
    for (const nx of [0.35, 0.5, 0.65]) {
      ctx.beginPath();
      ctx.moveTo(p(nx, 0.28)[0], p(nx, 0.28)[1]);
      ctx.lineTo(p(nx, 0.68)[0], p(nx, 0.68)[1]);
      ctx.stroke();
    }
    const wr = Math.min(w, h) * 0.08;
    for (const nx of [0.3, 0.7]) {
      const c = p(nx, 0.82);
      ctx.beginPath();
      ctx.arc(c[0], c[1], wr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, x, y, w, h);
};

/** Label-in-box helper for facility text marks. */
const labeledBox =
  (label: string): Sym =>
  (ctx, x, y, w, h, stroke, lw) => {
    fillStroke(ctx, stroke, '#fff', lw, (p) => {
      const [a, b, c, d] = [p(0.1, 0.15), p(0.9, 0.15), p(0.9, 0.85), p(0.1, 0.85)];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(d[0], d[1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.font = `600 ${Math.max(7, Math.min(w, h) * 0.28)}px system-ui,sans-serif`;
      ctx.fillStyle = stroke;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, p(0.5, 0.5)[0], p(0.5, 0.5)[1]);
    }, x, y, w, h);
  };

/** Fill a bounding box with N chair symbols in a rows×cols grid. */
function chairGrid(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: string,
  lw: number,
  count = 4,
): void {
  const n = Math.max(1, Math.min(100, Math.round(count)));
  const aspect = w / Math.max(1e-6, h);
  const { cols, rows } = chairGridDims(n, aspect);
  const cellW = w / cols;
  const cellH = h / rows;
  const gapFrac = CHAIR_ROW_GAP / (CHAIR_ROW_UNIT + CHAIR_ROW_GAP);
  const padX = cellW * gapFrac * 0.5;
  const padY = cellH * gapFrac * 0.5;
  let i = 0;
  for (let r = 0; r < rows && i < n; r++) {
    for (let c = 0; c < cols && i < n; c++) {
      chair(
        ctx,
        x + c * cellW + padX,
        y + r * cellH + padY,
        Math.max(2, cellW - padX * 2),
        Math.max(2, cellH - padY * 2),
        stroke,
        lw,
      );
      i++;
    }
  }
}

const SYMBOLS: Record<string, Sym> = {
  chair,
  'chair-round': chairRound,
  armchair: chair,
  sofa,
  bench: table,
  stool: chairRound,
  'seating-block': sofa,
  table,
  'table-round': tableRound,
  desk: table,
  counter: table,
  cabinet: rectOutline,
  shelf: wall,
  bed,
  'bed-single': bed,
  'bed-double': bed,
  'bed-king': bed,
  'bunk-bed': bunkBed,
  crib: bed,
  nightstand: rectOutline,
  dresser: rectOutline,
  closet: rectOutline,
  'sofa-l': sofaL,
  'coffee-table': table,
  'tv-stand': screen,
  'dining-table': table,
  'kitchen-island': table,
  'kitchen-sink': kitchenSink,
  stove: appliance,
  fridge: appliance,
  dishwasher: appliance,
  washer: appliance,
  bathtub,
  shower,
  toilet,
  'bathroom-sink': kitchenSink,
  fireplace,
  'stairs-house': stairs,
  car,
  'car-compact': car,
  suv: car,
  van,
  bus: van,
  truck,
  pickup: truck,
  bike: bicycle,
  motorcycle,
  scooter: motorcycle,
  'bike-rack': bikeRack,
  'parking-spot': parkingSpot,
  'ev-parking': parkingSpot,
  'wheelchair-vehicle': labeledBox('♿'),
  cart,
  forklift: truck,
  wardrobe: rectOutline,
  stage,
  podium: pillar,
  booth,
  'photo-booth': booth,
  reception: table,
  bar: table,
  ticket: booth,
  'coat-check': rectOutline,
  door,
  'double-door': doubleDoor,
  window,
  wall,
  pillar,
  column: pillar,
  railing: wall,
  stairs,
  escalator: stairs,
  elevator: rectOutline,
  plant,
  tree: plant,
  billboard: screen,
  sign: screen,
  banner: wall,
  screen,
  'led-wall': screen,
  fountain: plant,
  rug: rectOutline,
  statue: pillar,
  charging: chargingPoint,
  'charging-station': chargingStation,
  'phone-charging': chargingPoint,
  'ev-charger': evCharger,
  'power-outlet': powerOutlet,
  'usb-hub': chargingStation,
  wifi,
  'water-fountain': waterFountain,
  restroom,
  'accessible-restroom': labeledBox('♿'),
  'baby-changing': labeledBox('BABY'),
  'prayer-room': labeledBox('PR'),
  info: labeledBox('i'),
  atm: labeledBox('ATM'),
  vending: rectOutline,
  printer: rectOutline,
  trash: chairRound,
  recycling: labeledBox('♻'),
  extinguisher: pillar,
  'first-aid': labeledBox('+'),
  aed: labeledBox('AED'),
  locker: rectOutline,
  'parcel-locker': labeledBox('📦'),
  wheelchair: labeledBox('♿'),
  smoking: labeledBox('🚬'),
};

/** Draw a floor-plan symbol for a catalog kind inside screen bbox. */
export function drawFloorPlanSymbol(
  ctx: CanvasRenderingContext2D,
  kind: string | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: string,
  lineW: number,
  opts?: SymbolDrawOptions,
): void {
  if (w < 2 || h < 2) return;
  if (kind === 'chair-row') {
    const areaUnits = (w / CHAIR_ROW_UNIT) * (h / CHAIR_ROW_UNIT);
    const n =
      opts?.count ??
      Math.max(1, Math.round(areaUnits * (CHAIR_ROW_UNIT / (CHAIR_ROW_UNIT + CHAIR_ROW_GAP)) ** 2));
    chairGrid(ctx, x, y, w, h, stroke, lineW, n);
    return;
  }
  const sym = kind ? SYMBOLS[kind] : undefined;
  if (sym) sym(ctx, x, y, w, h, stroke, lineW);
  else rectOutline(ctx, x, y, w, h, stroke, lineW);
}

/** Tiny preview for the materials palette button. */
export function drawFloorPlanSymbolPreview(
  canvas: HTMLCanvasElement,
  kind: string,
  stroke = '#455a64',
  count?: number,
): void {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, size, size);
  drawFloorPlanSymbol(ctx, kind, 4, 4, size - 8, size - 8, stroke, 1.2, { count });
}
