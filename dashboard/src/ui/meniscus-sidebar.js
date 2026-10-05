/**
 * Horizontal meniscus dock — liquid bead on the top edge.
 * Geometry from https://github.com/hasib41/meniscus-liquid-nav
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const reach = (s, rb, by) => Math.sqrt(Math.max((s + rb) ** 2 - (s - by) ** 2, 1));

/**
 * @param {HTMLElement} el
 * @returns {string}
 */
function tabId(el) {
  return el.dataset.mode || el.dataset.panel || '';
}

/**
 * @param {HTMLElement} dock
 * @param {{
 *   onSelect?: (id: string | null) => void,
 *   tabSelector?: string,
 *   toggleable?: boolean,
 * }} [options]
 */
export function mountMeniscusNav(dock, options = {}) {
  const onSelect = options.onSelect;
  const tabSelector = options.tabSelector || '.scene-tool-btn';
  const toggleable = Boolean(options.toggleable);
  const svg = dock.querySelector('.meniscus-skin');
  const fillP = dock.querySelector('.meniscus-fill');
  const bead = dock.querySelector('.meniscus-bead');
  if (!svg || !fillP || !bead) {
    return { layout() {}, goTo() {}, clear() {}, destroy() {} };
  }

  const G = { W: 0, H: 0, R: 17, D: 56, RB: 35, S: 17, CY: 0, slots: [], span: 80 };
  let x = 0;
  let v = 0;
  let target = 0;
  let dragging = false;
  let idle = true;
  let raf = 0;
  let last = 0;
  let current = -1;
  let pid = null;
  let startX = 0;
  let suppressClick = false;
  /** @type {ResizeObserver | null} */
  let ro = null;

  const visibleTabs = () =>
    [...dock.querySelectorAll(tabSelector)].filter(
      (t) => !t.hidden && t.style.display !== 'none',
    );

  function measure() {
    const tabs = visibleTabs();
    const r = dock.getBoundingClientRect();
    const W = Math.round(r.width);
    const H = Math.round(r.height);
    if (W < 40 || H < 30) return false;

    G.slots = tabs.map((t) => {
      const b = t.getBoundingClientRect();
      return b.left - r.left + b.width / 2;
    });
    G.span = G.slots.length > 1 ? G.slots[1] - G.slots[0] : W * 0.18;
    G.W = W;
    G.H = H;
    G.R = clamp(H * 0.2, 13, 20);
    G.CY = 0;

    let D = Math.min(H * 0.68, G.span * 0.78);
    const room = (G.slots[0] ?? W / 2) - G.R - 6;
    for (let i = 0; i < 3; i += 1) {
      const hw = reach(D * 0.22, D / 2 + 6, G.CY);
      if (hw <= room) break;
      D *= room / Math.max(hw, 1);
    }
    G.D = Math.max(Math.round(D), 30);
    G.S = G.D * 0.22;
    G.RB = G.D / 2 + 6;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    dock.style.setProperty('--dock-r', `${G.R.toFixed(1)}px`);
    dock.style.setProperty('--bead-d', `${G.D}px`);
    dock.style.setProperty('--bead-cy', `${G.CY}px`);
    dock.style.setProperty('--rise', `${(H / 2 - G.CY).toFixed(1)}px`);
    return true;
  }

  function trough(bx, by, rb, sL, sR) {
    const { W, H, R } = G;
    const wing = (s, side) => {
      const L = s + rb;
      const half = reach(s, rb, by);
      const sx = bx + side * half;
      return {
        sx,
        s,
        tx: sx + ((bx - sx) / L) * s,
        ty: s + ((by - s) / L) * s,
      };
    };
    const A = wing(sL, -1);
    const B = wing(sR, +1);
    const a0 = Math.atan2(A.ty - by, A.tx - bx);
    const a1 = Math.atan2(B.ty - by, B.tx - bx);
    let sweep = ((a0 - a1) * 180) / Math.PI;
    while (sweep < 0) sweep += 360;
    const large = sweep > 180 ? 1 : 0;
    const n = (val) => val.toFixed(2);

    return (
      `M0 ${n(R)}` +
      `A${n(R)} ${n(R)} 0 0 1 ${n(R)} 0` +
      `L${n(clamp(A.sx, R, W - R))} 0` +
      `A${n(sL)} ${n(sL)} 0 0 1 ${n(A.tx)} ${n(A.ty)}` +
      `A${n(rb)} ${n(rb)} 0 ${large} 0 ${n(B.tx)} ${n(B.ty)}` +
      `A${n(sR)} ${n(sR)} 0 0 1 ${n(clamp(B.sx, R, W - R))} 0` +
      `L${n(W - R)} 0` +
      `A${n(R)} ${n(R)} 0 0 1 ${n(W)} ${n(R)}` +
      `L${n(W)} ${n(H - R)}` +
      `A${n(R)} ${n(R)} 0 0 1 ${n(W - R)} ${n(H)}` +
      `L${n(R)} ${n(H)}` +
      `A${n(R)} ${n(R)} 0 0 1 0 ${n(H - R)}` +
      `Z`
    );
  }

  function flatPath() {
    const { W, H, R } = G;
    const n = (val) => val.toFixed(2);
    return (
      `M0 ${n(R)}` +
      `A${n(R)} ${n(R)} 0 0 1 ${n(R)} 0` +
      `L${n(W - R)} 0` +
      `A${n(R)} ${n(R)} 0 0 1 ${n(W)} ${n(R)}` +
      `L${n(W)} ${n(H - R)}` +
      `A${n(R)} ${n(R)} 0 0 1 ${n(W - R)} ${n(H)}` +
      `L${n(R)} ${n(H)}` +
      `A${n(R)} ${n(R)} 0 0 1 0 ${n(H - R)}` +
      `Z`
    );
  }

  function paint() {
    if (idle || current < 0) {
      fillP.setAttribute('d', flatPath());
      bead.style.opacity = '0';
      visibleTabs().forEach((t) => t.style.setProperty('--t', '0'));
      return;
    }

    bead.style.opacity = '1';
    const tabs = visibleTabs();
    const q = clamp(v / 1100, -1, 1) * (dragging ? 0.5 : 1);
    const mag = Math.abs(q);
    const sL = clamp(G.S * (1 + 0.06 * mag + 0.4 * q), G.S * 0.55, G.S * 2.1);
    const sR = clamp(G.S * (1 + 0.06 * mag - 0.4 * q), G.S * 0.55, G.S * 2.1);
    fillP.setAttribute('d', trough(x, G.CY, G.RB, sL, sR));

    const sx = 1 + 0.07 * mag;
    bead.style.transform = `translate3d(${x.toFixed(2)}px,0,0) scale(${sx.toFixed(3)},${(1 / sx).toFixed(3)})`;

    for (let i = 0; i < tabs.length; i += 1) {
      const dx = Math.abs(x - (G.slots[i] ?? 0));
      tabs[i].style.setProperty(
        '--t',
        smooth(clamp(1 - dx / (G.span * 0.55), 0, 1)).toFixed(3),
      );
    }
  }

  function loop(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const K = dragging ? 900 : 142;
    const C = dragging ? 52 : 19.3;
    let step = dt;
    while (step > 0) {
      const h = Math.min(step, 1 / 240);
      v += (-K * (x - target) - C * v) * h;
      x += v * h;
      step -= h;
    }
    paint();
    if (Math.abs(x - target) > 0.05 || Math.abs(v) > 0.6 || dragging) run();
    else {
      x = target;
      v = 0;
      paint();
    }
  }

  function run() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function jump(to) {
    target = to;
    if (reduced() && !dragging) {
      x = to;
      v = 0;
      paint();
      return;
    }
    run();
  }

  function markTabs(i) {
    const tabs = visibleTabs();
    tabs.forEach((t, n) => {
      t.classList.toggle('active', n === i);
      t.setAttribute('aria-selected', String(n === i));
      t.setAttribute('aria-pressed', String(n === i));
      t.tabIndex = n === i ? 0 : -1;
    });
  }

  /**
   * @param {number} i
   * @param {{ fromUser?: boolean, animate?: boolean }} [opts]
   */
  function select(i, opts = {}) {
    const fromUser = Boolean(opts.fromUser);
    const animate = opts.animate !== false;
    const tabs = visibleTabs();
    if (tabs.length === 0) return;

    if (toggleable && fromUser && !dragging && i === current && !idle) {
      clear(true);
      onSelect?.(null);
      return;
    }

    current = ((i % tabs.length) + tabs.length) % tabs.length;
    idle = false;
    dock.classList.remove('is-idle');
    markTabs(current);
    const slot = G.slots[current];
    if (typeof slot === 'number') {
      if (animate) jump(slot);
      else {
        x = target = slot;
        v = 0;
        paint();
      }
    }
    if (fromUser) {
      const id = tabId(tabs[current]);
      if (id) onSelect?.(id);
    }
  }

  function goTo(id, animate = true) {
    if (!measure()) return;
    if (!id) {
      clear(animate);
      return;
    }
    const tabs = visibleTabs();
    const i = tabs.findIndex((t) => tabId(t) === id);
    if (i < 0) {
      clear(animate);
      return;
    }
    select(i, { fromUser: false, animate });
  }

  function clear(animate = false) {
    idle = true;
    current = -1;
    dock.classList.add('is-idle');
    visibleTabs().forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
      t.setAttribute('aria-pressed', 'false');
      t.style.setProperty('--t', '0');
    });
    if (!measure()) return;
    const mid = G.W / 2;
    if (animate && !reduced()) jump(mid);
    else {
      x = target = mid;
      v = 0;
    }
    paint();
  }

  function layout(animate = false) {
    if (!measure()) return;
    const tabs = visibleTabs();
    const active = tabs.findIndex((t) => t.classList.contains('active'));
    if (active < 0) {
      clear(false);
      dock.classList.add('is-ready');
      return;
    }
    current = active;
    idle = false;
    dock.classList.remove('is-idle');
    const slot = G.slots[current] ?? G.W / 2;
    if (animate) jump(slot);
    else {
      x = target = slot;
      v = 0;
      paint();
    }
    dock.classList.add('is-ready');
  }

  dock.addEventListener('click', (e) => {
    if (suppressClick) return;
    const btn = e.target instanceof Element ? e.target.closest(tabSelector) : null;
    if (!btn || btn.hidden) return;
    const tabs = visibleTabs();
    const i = tabs.indexOf(btn);
    if (i >= 0) select(i, { fromUser: true });
  });

  dock.querySelector('.meniscus-tabs')?.addEventListener('keydown', (e) => {
    const tabs = visibleTabs();
    if (tabs.length === 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = null;
    const from = current < 0 ? 0 : current;
    if (typeof step === 'number') next = from + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    select(next, { fromUser: true });
    visibleTabs()[current]?.focus();
  });

  dock.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pid = e.pointerId;
    startX = e.clientX;
    suppressClick = false;
  });

  dock.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    if (!dragging && Math.abs(e.clientX - startX) < 7) return;
    if (!dragging) {
      dragging = true;
      suppressClick = true;
      idle = false;
      dock.classList.add('is-dragging');
      dock.classList.remove('is-idle');
      dock.setPointerCapture(pid);
    }
    e.preventDefault();
    const left = dock.getBoundingClientRect().left;
    const lastSlot = G.slots[G.slots.length - 1] ?? 0;
    target = clamp(e.clientX - left, G.slots[0] ?? 0, lastSlot);
    run();
  });

  function release(e) {
    if (e.pointerId !== pid) return;
    pid = null;
    if (!dragging) return;
    dragging = false;
    dock.classList.remove('is-dragging');
    let near = 0;
    let nd = Infinity;
    G.slots.forEach((s, i) => {
      const d = Math.abs(target - s);
      if (d < nd) {
        nd = d;
        near = i;
      }
    });
    select(near, { fromUser: true });
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }

  dock.addEventListener('pointerup', release);
  dock.addEventListener('pointercancel', release);

  ro = new ResizeObserver(() => layout(false));
  ro.observe(dock);
  document.fonts?.ready.then(() => layout(false));

  layout(false);

  return {
    layout,
    goTo,
    clear,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    },
  };
}

/**
 * @param {HTMLElement} dock
 * @param {{ onSelect?: (id: string | null) => void }} [options]
 */
export function mountMeniscusSidebar(dock, options = {}) {
  return mountMeniscusNav(dock, {
    onSelect: options.onSelect,
    tabSelector: '.sidebar-btn',
    toggleable: false,
  });
}
