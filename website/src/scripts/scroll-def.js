// Defence page scroll motion (preview): the terrain route (D1), the mast lamp (D2) and the posture stills (D3).
// Decorative and aria-hidden. Scroll plays, scroll up rewinds, eased follow, the loop stops when settled.
// html[data-ss] "on" | "still" (reduced motion, data saver) is set before first paint by the inline script and absent without JavaScript.
import { PHONE, FLOW, clamp, still, syncMode, whenNear } from './scroll-env.js';

const TAU = 65; // ms; 95% settled in about 200 ms
const ease = (x) => x * x * (3 - 2 * x);
const load = async (url) => createImageBitmap(await (await fetch(url)).blob());

// Draws `base`, then `over` through a soft mask that `maskFn(mctx, W, H)` paints in white. cover-fits both with a normalised focus.
function player(el, draw, busy) {
  const canvas = el.querySelector('canvas'), ctx = canvas.getContext('2d');
  const mask = document.createElement('canvas'), mctx = mask.getContext('2d');
  let imgs = null, W = 0, H = 0, dpr = 1, cur = 0, target = 0, raf = 0, last = 0, visible = false, started = false;
  const size = () => {
    const r = canvas.getBoundingClientRect(); W = r.width; H = r.height;
    dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = mask.width = cw; canvas.height = mask.height = ch; }
  };
  const paint = () => { if (!imgs || !W) return; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); mctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw({ ctx, mctx, mask, imgs, W, H, p: cur, el }); };
  const tick = (now) => {
    const dt = Math.min(now - last, 64); last = now;
    cur += (target - cur) * (1 - Math.exp(-dt / TAU));
    if (Math.abs(target - cur) < 0.0004) { cur = target; if (!(busy && busy(now))) { raf = 0; paint(); return; } }
    paint(); raf = requestAnimationFrame(tick);
  };
  const go = (t, snap) => { target = t; if (snap) { cur = t; paint(); } else if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  const kick = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  return { size, paint, go, kick, set imgs(v) { imgs = v; }, get imgs() { return imgs; }, get started() { return started; }, start() { started = true; },
    get visible() { return visible; }, set visible(v) { visible = v; } };
}

// ---- D1: the route lights point by point with the eight cards ----
// Pinned stage (laptops, tablets): the stage's own scroll length drives it and the card list opens one card at a time, one route point per card.
// Flow layout (phones, short screens, or text that does not fit): the picture sits above the cards and follows its own travel through the screen.
function terrain(el) {
  const sec = el.closest('section'), cards = [...sec.querySelectorAll('.sector-case')], route = JSON.parse(el.dataset.route), N = cards.length;
  const stage = el.closest('.stage'), M = { pin: false, sTop: 0, sH: 0 };
  let pulse = null; // the active point flares once when its card opens: 0.8 s, then it stops
  const pl = player(el, ({ ctx, mctx, mask, imgs, W, H, p }) => {
    const [dark, lit] = imgs, s = Math.max(W / dark.width, H / dark.height) * 1.2;
    const dw = dark.width * s, dh = dark.height * s, dx = (W - dw) / 2, dy = (H - dh) / 2; // zoomed so the model, not its black surround, fills the box
    ctx.clearRect(0, 0, W, H); ctx.drawImage(dark, dx, dy, dw, dh);
    const pts = route.path.map(([x, y]) => [dx + x * dw, dy + y * dh]), idx = route.wp; // idx[k] = path index of waypoint k
    const f = Math.floor(p), upto = p >= N - 1 ? pts.length - 1 : idx[f] + (idx[f + 1] - idx[f]) * (p - f); // p = 0..N-1: the route reaches waypoint p
    mctx.globalCompositeOperation = 'source-over'; mctx.clearRect(0, 0, W, H);
    mctx.lineCap = mctx.lineJoin = 'round'; mctx.strokeStyle = '#fff';
    const base = W * 0.07, m = Math.floor(upto);
    for (let k = 0; k < 6; k++) { // soft edge: layered strokes
      mctx.globalAlpha = 1 / 6 + (k === 0 ? 0 : 0.1); mctx.lineWidth = base * (1.7 - k * 0.2);
      mctx.beginPath(); mctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i <= m && i < pts.length; i++) mctx.lineTo(pts[i][0], pts[i][1]);
      if (m + 1 < pts.length) { const t = upto - m, a = pts[m], b = pts[m + 1]; mctx.lineTo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); }
      mctx.stroke();
    }
    mctx.globalAlpha = 1; mctx.globalCompositeOperation = 'source-in'; mctx.drawImage(lit, dx, dy, dw, dh); mctx.globalCompositeOperation = 'source-over';
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(mask, 0, 0, W, H); // the lit layer is additive light
    if (pulse) { // one soft ring growing out of the point that just lit, fading as it goes
      const t = (performance.now() - pulse.t0) / 800;
      if (t >= 0 && t < 1) {
        const [x, y] = pts[idx[pulse.k]], r = W * (0.012 + 0.05 * t), g = ctx.createRadialGradient(x, y, 0, x, y, r), a = 0.75 * (1 - t) * (1 - t);
        g.addColorStop(0, `rgba(157,184,141,${a})`); g.addColorStop(0.55, `rgba(157,184,141,${a * 0.5})`); g.addColorStop(1, 'rgba(157,184,141,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      } else if (t >= 1) pulse = null;
    }
    ctx.globalCompositeOperation = 'source-over';
  }, () => pulse !== null);
  const measure = () => {
    M.pin = !!stage && getComputedStyle(stage.firstElementChild).position === 'sticky'; // the CSS decides (same test as the stage panel)
    if (M.pin) { const q = stage.getBoundingClientRect(); M.sTop = q.top + scrollY; M.sH = q.height; }
  };
  const prog = () => {
    if (M.pin) return (N - 1) * clamp((clamp((scrollY - M.sTop) / (M.sH - innerHeight)) - 0.06) / 0.86); // 6% to settle in, 8% to read the last card
    const r = el.getBoundingClientRect(); return (N - 1) * clamp((innerHeight * 0.85 - r.top) / (innerHeight * 0.6));
  };
  let shown = -1;
  const open = (p) => { // pinned: the card nearest the route head is open
    const k = M.pin ? Math.round(p) : -1; if (k === shown) return; shown = k;
    cards.forEach((c, i) => c.classList.toggle('is-lit', i === k));
    if (k >= 0 && !still()) { pulse = { k, t0: performance.now() + 270 }; pl.kick(); } // the pulse waits for the card to open (CSS: the closing card goes first)
  };
  const onScroll = () => { if (pl.visible && !still()) { const t = prog(); open(t); pl.go(t); } };
  const settle = () => { measure(); pl.size(); const t = still() ? N - 1 : prog(); open(t); pl.go(t, true); };
  const url = (n) => `${PHONE.matches ? el.dataset.srcPhone : el.dataset.src}/${n}.webp`;
  whenNear(el, async () => { pl.start(); pl.imgs = await Promise.all([load(url('terrain-dark')), load(url('terrain-lit'))]); if (pl.visible) settle(); });
  new IntersectionObserver((es) => { pl.visible = es[es.length - 1].isIntersecting; if (pl.visible && pl.imgs) settle(); }, { rootMargin: '10% 0px' }).observe(stage || el);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { if (pl.visible && pl.imgs) settle(); }, { passive: true });
  new ResizeObserver(() => { if (pl.visible && pl.imgs) settle(); }).observe(el);
  FLOW.addEventListener('change', () => { shown = -2; if (pl.imgs) settle(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pl.visible && pl.imgs) settle(); });
  if (!still()) { cards[0].classList.add('is-lit'); shown = 0; }
}

// ---- D2: the mast lamp goes out, the case keeps its green seam ----
function mast(el) {
  const m = JSON.parse(el.dataset.region); // [cx, cy, rx, ry] normalised to the image
  const pl = player(el, ({ ctx, mctx, mask, imgs, W, H, p }) => {
    const [a, b] = imgs, s = Math.max(W / a.width, H / a.height) * (W > 600 ? 1.2 : 1), dw = a.width * s, dh = a.height * s;
    const dx = Math.min(0, Math.max(W - dw, W / 2 - 0.46 * dw)), dy = (H - dh) / 2; // the mast and the case fill the box: lamp and seam read at 1440
    ctx.clearRect(0, 0, W, H); ctx.drawImage(a, dx, dy, dw, dh);
    const t = ease(p); if (t <= 0.001) return;
    const cx = dx + m[0] * dw, cy = dy + m[1] * dh, rx = m[2] * dw, ry = m[3] * dh;
    mctx.globalCompositeOperation = 'source-over'; mctx.clearRect(0, 0, W, H);
    mctx.save(); mctx.translate(cx, cy); mctx.scale(rx, ry);
    const g = mctx.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, '#fff'); g.addColorStop(0.62, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = g; mctx.beginPath(); mctx.arc(0, 0, 1, 0, 7); mctx.fill(); mctx.restore();
    mctx.globalCompositeOperation = 'source-in'; mctx.drawImage(b, dx, dy, dw, dh); mctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = t; ctx.drawImage(mask, 0, 0, W, H); ctx.globalAlpha = 1;
  });
  const prog = () => { const r = el.getBoundingClientRect(), c = r.top + r.height / 2; return clamp((innerHeight * 0.55 - c) / (innerHeight * 0.2)); }; // lit until the picture's centre is at 55% of the viewport, out by 35%
  const onScroll = () => { if (pl.visible && !still()) pl.go(prog()); };
  const settle = () => { pl.size(); pl.go(still() ? 0 : prog(), true); }; // reduced motion and data saver: the start still (lamp lit)
  const url = (n) => `${PHONE.matches ? el.dataset.srcPhone : el.dataset.src}/${n}.webp`;
  whenNear(el, async () => { pl.start(); pl.imgs = await Promise.all([load(url('mast-start')), load(url('mast-end'))]); if (pl.visible) settle(); });
  new IntersectionObserver((es) => { pl.visible = es[es.length - 1].isIntersecting; if (pl.visible && pl.imgs) settle(); }, { rootMargin: '10% 0px' }).observe(el);
  addEventListener('scroll', onScroll, { passive: true });
  new ResizeObserver(() => { if (pl.visible && pl.imgs) settle(); }).observe(el);
}

syncMode();
document.querySelectorAll('[data-def-terrain]').forEach(terrain);
document.querySelectorAll('[data-def-mast]').forEach(mast);
