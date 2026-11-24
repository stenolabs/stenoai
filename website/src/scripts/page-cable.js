// The page cable (Enterprise): a thin grey network cable runs down the left gutter from the top of the page, makes one real-radius bend
// and runs horizontally into the empty band between the hero and the first section, where its plug sits in a socket on a low wall plate.
// While that band moves from 72% to 38% of the screen height the plug slides out and lies free with a small droop; the cable then draws up
// out of view. Scrolling up plugs it back in. Everything is built here (no markup without JavaScript). It is absolutely positioned in the
// document (it scrolls natively); one rAF loop moves a few transforms and opacities and stops when settled.
import cableCss from '../page-cable.css?inline';
if (!document.getElementById('pc-css')) {
  const s = document.createElement('style');
  s.id = 'pc-css';
  s.textContent = cableCss;
  document.head.append(s);
}
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const main = document.querySelector('main');
const first = main?.querySelector('.mission-section-top')?.closest('section'); // the first section after the hero
if (main && first && !navigator.connection?.saveData) {
  // Asset pixels: plug 380x79 lying right (cable axis row 42.36, tip x 374.7, 21px lead), side-view socket 250x200 (housing lip x 1.78, housing centre row 99.8; the plug's boot shoulder is at x 242.3),
  // wall clip 86x96 (cable axis x 43).
  const A = { plugLen: 380, plugH: 79, axis: 42.36, tip: 374.7, lead: 21, sockW: 250, sockH: 200, lip: 1.78, row: 99.82, shoulder: 242.3, clipH: 96, clipW: 86, clipAxis: 43 };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const smooth = (x, a, b) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const ease = (t) => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const PL = 90, VTAU = 110, FADE = 400, STEP = 1.2;
  const root = document.createElement('div'); root.className = 'pc'; root.setAttribute('aria-hidden', 'true'); document.body.append(root);
  let G = null, dir = 1, vs = 0, raf = 0, last = 0, lastY = 0, tScroll = -1e9, qd = 0, pp = {}, far = false;
  const px = (v) => `${Math.round(v * 100) / 100}px`;
  const el = (cls, tag = 'div', css = '', src) => { const e = document.createElement(tag); e.className = cls; if (css) e.style.cssText = css; if (src) { e.src = src; e.alt = ''; e.decoding = 'async'; } return e; };
  const abs = (e) => { const r = e.getBoundingClientRect(); return { t: r.top + scrollY, b: r.bottom + scrollY, l: r.left, r: r.right }; };

  // Bottom of the last thing the previous section shows (text, pictures): the top of the empty band.
  function contentBottom(sec) {
    let b = abs(sec).t;
    const tw = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.height) b = Math.max(b, q.bottom + scrollY); }
    for (const e of sec.querySelectorAll('img,video,svg,picture')) if (!e.closest('[data-scroll-seq]')) b = Math.max(b, abs(e).b);
    return b;
  }
  // The path of the cable axis from the start down the gutter (with a sag between clips), round the bend and right to the plug: samples {x,y,a (heading),s}.
  function buildPath() {
    const g = G, pts = [], amp = g.phone ? 2 : g.tablet ? 2.5 : [3.5, 5], yv = g.yb - g.R;
    const sag = (y) => { const yc = g.yClip; const [y0, y1, a] = y < yc ? [g.yStart, yc, amp[0] ?? amp] : [yc, yv, -(amp[1] ?? amp)]; const t = (y - y0) / (y1 - y0); const u = Math.sin(Math.PI * t); return a * (u * u + .25 * u * u * Math.sin(2 * Math.PI * t + 1.3)); };
    for (let y = g.yStart; y < yv; y += STEP) pts.push({ x: g.cx + sag(y), y, part: 'v' });
    for (let k = 0; k <= 24; k++) { const th = (k / 24) * Math.PI / 2; pts.push({ x: g.cx + g.R - g.R * Math.cos(th), y: yv + g.R * Math.sin(th), a: Math.PI / 2 - th, part: 'a' }); }
    for (let x = g.xb + STEP; x < g.xPlug + 4; x += STEP) pts.push({ x, y: g.yb, a: 0, part: 'h' });
    let s = 0; pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); p.s = s; });
    pts.forEach((p, i) => { if (p.a !== undefined) return; const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; p.a = Math.atan2(b.y - a.y, b.x - a.x); });
    return pts;
  }
  function sweep(cv, pts, ox, oy, w, h, clearOnly) { // the cable: a matte grey body, a soft shade on one side and a thin cool rim on the other (the side facing up/right)
    const ctx = cv.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2), cw = G.cw;
    if (!clearOnly) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (clearOnly) ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    const line = (off, lw, col) => { ctx.beginPath(); pts.forEach((p, i) => { const x = p.x - ox + Math.sin(p.a) * off, y = p.y - oy - Math.cos(p.a) * off; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke(); };
    line(0, cw, 'rgb(60,61,62)'); line(-.27 * cw, .46 * cw, 'rgba(34,35,36,.55)'); line(.3 * cw, .3 * cw, 'rgba(110,116,121,.5)'); line(.43 * cw, Math.max(.9, .13 * cw), 'rgba(160,170,179,.8)');
  }
  // One continuous, tangent-continuous path for bend + cubic droop run + boot lead-in (zero slope at bend end and at boot).
  function bendRunPts(xBoot, d, leadLen) {
    const g = G, yv = g.yb - g.R, pts = [{ x: g.cx, y: yv - 4, a: Math.PI / 2 }, { x: g.cx, y: yv - 2, a: Math.PI / 2 }];
    const nArc = 40;
    for (let k = 0; k <= nArc; k++) { const th = (k / nArc) * Math.PI / 2; pts.push({ x: g.cx + g.R - g.R * Math.cos(th), y: yv + g.R * Math.sin(th), a: Math.PI / 2 - th }); }
    const L = xBoot - g.xb;
    if (L > .5) {
      const nRun = Math.max(16, Math.ceil(L / 1.5));
      for (let k = 1; k <= nRun; k++) {
        const u = k / nRun, y = g.yb + d * (3 * u * u - 2 * u * u * u), slope = (d / L) * 6 * u * (1 - u);
        pts.push({ x: g.xb + L * u, y, a: Math.atan2(slope, 1) });
      }
    }
    if (leadLen > .5) {
      const x0 = Math.max(g.xb, xBoot), y0 = L > .5 ? g.yb + d : g.yb;
      pts.push({ x: x0 + leadLen * .5, y: y0, a: 0 }, { x: x0 + leadLen, y: y0, a: 0 });
    }
    return pts;
  }
  const at = (s) => { const P = G.pts; let lo = 0, hi = P.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].s < s) lo = m + 1; else hi = m; } return P[lo]; };

  let anchor = first; while (anchor.parentElement && anchor.parentElement !== main) anchor = anchor.parentElement;
  let prev = anchor.previousElementSibling; while (prev && prev.tagName === 'SCRIPT') prev = prev.previousElementSibling;

  function measure() {
    qd = 0;
    const vh = innerHeight, phone = innerWidth < 768, tablet = !phone && innerWidth < 1100;
    const wrap = first.querySelector('.mission-wrap') || main.querySelector('.mission-wrap'); if (!wrap) return;
    const L = abs(wrap).l, gut = phone ? 20 : Math.min(L, 56);
    const kp = (phone ? 120 : tablet ? 160 : 220) / A.plugLen, cw = phone ? 6.6 : tablet ? 8.8 : 12, kc = cw / 44, R = phone ? 36 : tablet ? 44 : 60;
    const cx = Math.round(phone ? 10 : L - gut / 2);
    const yStart = Math.round(abs(main).t);
    const bandTop = prev ? contentBottom(prev) : yStart, eye = first.querySelector('.mission-section-top'), bandBot = abs(eye).t, line = abs(first).t, yb = Math.round(line > bandTop + 30 && line < bandBot - 30 ? line : (bandTop + bandBot) / 2); // the cable meets the plate on the band's tone-change line
    const mKey = `${innerWidth}:${vh}:${Math.round(L)}:${yStart}:${yb}:${Math.round(bandTop)}:${Math.round(bandBot)}`;
    if (G && G.mKey === mKey) return;
    // No clear band: no cable rather than a crowded one.
    if ([...main.querySelectorAll('[data-scroll-seq]')].some((e) => { const r = abs(e); return r.t < bandBot && r.b > bandTop && getComputedStyle(e).display !== 'none'; })) { G = null; root.replaceChildren(); return; }
    const plateH = A.sockH * kp, run = phone ? 80 : tablet ? 112 : 150;
    const clearSlide = (A.tip - A.shoulder + A.lip - 1) * kp + 3; // pull distance needed for the plug tip to clear the housing's left lip
    const slide = Math.round(clearSlide + (phone ? 8 : tablet ? 12 : 15));
    const maxDroop = 10 * (kp / (220 / A.plugLen)), leadMax = 9 * kp;
    const xb = cx + R, xPlug = xb + run, plateL = xPlug + A.shoulder * kp - A.lip * kp, plateR = plateL + A.sockW * kp; // the housing's lip sits at the boot's shoulder when plugged in
    const yClip = yStart + Math.round((yb - R - yStart) * .55);
    const sStart = yb - .72 * vh, U = .34 * vh;
    G = { mKey, vh, phone, tablet, kp, cw, R, cx, yStart, yb, slide, clearSlide, maxDroop, leadMax, xb, xPlug, yClip, sStart, U, pts: [], bKey: '' };
    G.pts = buildPath();
    const W = Math.ceil(plateR + 6), Hh = Math.ceil(yb + Math.max(plateH / 2, maxDroop + (A.plugH - A.axis) * kp) + 8 - yStart);
    root.style.cssText = `top:${yStart}px;width:${W}px;height:${Hh}px`;
    root.replaceChildren();
    const win = el('pc-win', 'div', `width:${W}px;height:${Hh}px`), asm = el('pc-asm', 'div', `width:${W}px;height:${Hh}px`);
    const yv = yb - R, vw = Math.ceil(cx + cw + 8), vh2 = Math.max(1, yv - yStart);
    const bw = Math.ceil(xPlug + leadMax + 4), bh = Math.ceil(R + maxDroop + cw / 2 + 6);
    const sc = el('pc-sc', 'canvas', `left:0;top:0;width:${vw}px;height:${vh2}px`);
    const bc = el('pc-bc', 'canvas', `left:0;top:${yv - yStart}px;width:${bw}px;height:${bh}px`);
    const plug = el('pc-plug', 'img', `width:${px(A.plugLen * kp)}`, '/page-cable/plugh.webp');
    asm.append(sc, bc, plug);
    G.pulses = []; const n = Math.max(1, Math.round(G.pts[G.pts.length - 1].s / 520));
    for (let i = 0; i < n; i++) { const pe = el('pc-pulse', 'i', `width:${px(cw + 9)};height:${PL}px`); asm.append(pe); G.pulses.push({ el: pe, off: (i / n) * (G.pts[G.pts.length - 1].s + PL) }); }
    win.append(asm); root.append(win);
    const cs = A.clipH * kc, glow = el('pc-glow');
    glow.style.cssText = `left:${px(cx - 24)};top:${px(yClip - yStart - 24)};width:48px;height:48px`;
    root.append(glow, el('pc-clip', 'img', `left:${px(cx - A.clipAxis * kc)};top:${px(yClip - yStart - cs / 2)};width:${px(A.clipW * kc)}`, '/page-cable/clip.webp'));
    root.append(el('pc-plate', 'img', `left:${px(plateL)};top:${px(yb - yStart - A.row * kp)};width:${px(A.sockW * kp)}`, '/page-cable/sock.webp'));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    bc.width = Math.round(bw * dpr); bc.height = Math.round(bh * dpr);
    Object.assign(G, { asm, bc, plug, glow, sc, yv, bw, bh });
    sweep(sc, G.pts.filter((p) => p.part === 'v').concat([{ x: cx, y: yv, a: Math.PI / 2 }, { x: cx, y: yv + 4, a: Math.PI / 2 }]), 0, yStart, vw, vh2, false);
    pp = {}; far = false; render(true);
  }
  const set = (k, e, prop, v) => { if (pp[k] !== v) { e.style[prop] = v; pp[k] = v; } };
  function render(force) {
    if (!G) return;
    const y = scrollY, quiet = REDUCED.matches, q = quiet ? G.U : y - G.sStart, now = performance.now();
    if (force) { pp = {}; G.bKey = ''; }
    const p = clamp(q / G.U);
    const slideT = ease(clamp(p / .74)), curSlide = slideT * G.slide;
    const droopT = curSlide >= G.clearSlide ? ease(clamp((p - .62) / .34)) : 0;
    const drawT = quiet ? 0 : ease(clamp((q - G.U - .05 * G.vh) / (.5 * G.vh)));
    const lag = quiet ? 0 : clamp(vs * 1.6, -2, 2);
    const tailT = clamp(drawT / .5), vT = ease(clamp((drawT - .4) / .6)); // draw-up: the free end retracts left along the run and fades at the bend, then the gutter cable shortens from the bottom
    const xBoot = G.xPlug - curSlide - tailT * Math.max(0, G.xPlug - G.slide - G.xb);
    const d = droopT * G.maxDroop * (1 - tailT);
    const leadLen = G.leadMax * (1 - smooth(tailT, .5, .9));
    const bKey = `${xBoot.toFixed(2)}:${d.toFixed(2)}:${leadLen.toFixed(2)}`;
    if (bKey !== G.bKey) { G.bKey = bKey; sweep(G.bc, bendRunPts(xBoot, d, leadLen), 0, G.yv, G.bw, G.bh, true); }
    set('asm', G.asm, 'transform', `translate3d(${lag.toFixed(2)}px,0,0)`);
    set('sc', G.sc, 'transform', `scaleY(${Math.max(.001, 1 - vT).toFixed(4)})`);
    set('bc', G.bc, 'opacity', (1 - smooth(tailT, .75, 1)).toFixed(3));
    set('plugt', G.plug, 'transform', `translate3d(${xBoot.toFixed(2)}px,${(G.yb - G.yStart + d - A.axis * G.kp).toFixed(2)}px,0)`);
    set('plugo', G.plug, 'opacity', (1 - smooth(tailT, .55, .95)).toFixed(3));
    const act = quiet ? 0 : 1 - smooth(now - tScroll, 0, FADE), env = act * (1 - smooth(q, 0, .3 * G.U)), S = G.pts[G.pts.length - 1].s;
    let near = 0;
    G.pulses.forEach((pu, i) => {
      const period = S + PL, s = ((1.6 * y + pu.off) % period + period) % period;
      let e = env * smooth(s, 0, 40) * smooth(period - s, 0, 40);
      const pt = e > .002 ? at(clamp(s, 0, S)) : null;
      if (pt && pt.x > xBoot) e = 0;
      set('po' + i, pu.el, 'opacity', e.toFixed(3));
      if (e > .002) { const rot = pt.a - Math.PI / 2 + (dir < 0 ? Math.PI : 0), w = G.cw + 9;
        set('pt' + i, pu.el, 'transform', `translate(${pt.x.toFixed(1)}px,${(pt.y - G.yStart).toFixed(1)}px) rotate(${rot.toFixed(4)}rad) translate(${(-w / 2).toFixed(1)}px,${dir < 0 ? 0 : -PL}px)`);
        const dClip = Math.hypot(pt.x - G.cx, pt.y - G.yClip); near = Math.max(near, e * Math.max(0, 1 - dClip / (PL * .8))); }
    });
    set('glow', G.glow, 'opacity', near.toFixed(3));
  }
  function tick(now) {
    const dt = clamp(now - last, 1, 64), y = scrollY; last = now;
    const v = (y - lastY) / dt; lastY = y; vs += (v - vs) * (1 - Math.exp(-dt / VTAU)); if (Math.abs(v) > .02) dir = v > 0 ? 1 : -1;
    render();
    if (Math.abs(vs) < .01 && Math.abs(v) < .01 && now - tScroll > FADE + 50) { vs = 0; raf = 0; render(); return; } // settled: the loop stops
    raf = requestAnimationFrame(tick);
  }
  const onScroll = () => {
    if (REDUCED.matches || !G) return;
    if (scrollY > G.yb + G.vh) {
      if (!far) { far = true; vs = 0; render(); }
      return;
    }
    far = false;
    tScroll = performance.now();
    if (raf) return;
    last = tScroll; lastY = scrollY;
    raf = requestAnimationFrame(tick);
  };
  const queue = () => { if (!qd) qd = requestAnimationFrame(measure); };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', queue, { passive: true });
  addEventListener('orientationchange', queue);
  addEventListener('pageshow', (e) => { if (e.persisted) { lastY = scrollY; queue(); } });
  REDUCED.addEventListener('change', () => render(true));
  const ro = new ResizeObserver(queue);
  ro.observe(document.documentElement);
  ro.observe(first);
  if (prev) ro.observe(prev);
  document.fonts?.ready.then(queue);
  addEventListener('load', queue);
  lastY = scrollY; queue();
}
