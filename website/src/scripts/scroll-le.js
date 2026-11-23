// Law-enforcement rows (preview): each picture has a row of its own, at full brightness, with no text on top.
//   recorder  not-for: the lit shelf dims from the outside in, the recorder stays lit (lit still + dim still, soft radial mask)
//   book      policy: the log book closes (frame atlas reused from the home page record cards, scripts/scroll-records.js)
// Scroll drives it both ways with a short ease; the loop stops when settled. Reduced motion and data saver: one settled still, no frame data.
// Nothing is fetched before the row is within 1.5 viewports, and the decoded pictures are released beyond 3 viewports.
import { PHONE, REDUCED, clamp, still, syncMode, whenNear } from './scroll-env.js';

const TAU = 90; // ms; follow is settled in about 270 ms
const REC = { cx: 0.34, cy: 0.425, top: 0.2, span: 0.62, ky: 0.5 }; // the recorder's centre, the part of the picture shown, and the squash of the lit ellipse
const BOOK = { sy: 0.725, sx0: 0.1206, sx1: 0.8735, d: { N: 48, cols: 8, fw: 562, fh: 400 }, m: { N: 32, cols: 8, fw: 349, fh: 248 } }; // scroll-records.js META.le; frame 0 closed .. N-1 open

const ss = (x) => x * x * (3 - 2 * x);
const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor, m = c.match(/[\d.]+/g); if (m && (m.length < 4 || +m[3] > 0.9)) return `rgb(${m[0]},${m[1]},${m[2]})`; } return '#121311'; };
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function feather(ctx, w, h, f) { // edges fade to transparent
  ctx.globalCompositeOperation = 'destination-out';
  const fx = w * f, fy = h * f;
  for (const [x, y, gw, gh, x0, y0, x1, y1] of [[0, 0, fx, h, 0, 0, fx, 0], [w - fx, 0, fx, h, w, 0, w - fx, 0], [0, 0, w, fy, 0, 0, 0, fy], [0, h - fy, w, fy, 0, h, 0, h - fy]]) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x, y, gw, gh);
  }
  ctx.globalCompositeOperation = 'source-over';
}
// The picture's floor is near black but not exactly the section colour: lift it to the section colour (per-channel max), then fade the edges.
function grade(src, bg, f) {
  const c = mk(src.width, src.height), x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'lighten'; x.drawImage(src, 0, 0); x.globalCompositeOperation = 'source-over';
  feather(x, c.width, c.height, f); return c;
}
const load = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(url); return createImageBitmap(await r.blob()); };

function init(el) {
  const kind = el.dataset.le, sec = el.closest('section'), canvas = el.querySelector('canvas'), ctx = canvas.getContext('2d');
  let imgs = null, mode = '', started = false, visible = false, cur = 0, target = 0, raf = 0, last = 0, W = 0, H = 0, dpr = 1, bg = '#121311', drawn = '', comp, mask;

  function size() {
    const r = el.getBoundingClientRect(); W = r.width; H = r.height; dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(12e6 / Math.max(1, W * H)));
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr); if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; drawn = ''; }
  }
  const progress = () => { const q = el.getBoundingClientRect(), vh = innerHeight; return clamp((vh * 0.92 - q.top) / (vh * 0.5 + q.height)); }; // the row's own travel through the screen
  function place(iw, ih) {
    if (kind === 'recorder') { // the table with the recorder: the part from REC.top down, REC.span of the height, fills the row (phones: the whole width)
      let dh = H / REC.span, dw = dh * iw / ih; if (PHONE.matches || dw > W) { dw = Math.min(dw, W); dh = dw * ih / iw; }
      return [(W - dw) / 2, H / 2 - (REC.top + REC.span / 2) * dh, dw, dh];
    }
    const dh = H, dw = dh * iw / ih; return [(W - dw) / 2, 0, dw, dh];
  }
  function draw(p) {
    if (!imgs) return; const key = p + '|' + W + 'x' + H; if (key === drawn) return; drawn = key;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    if (kind === 'book') {
      const m = PHONE.matches ? BOOK.m : BOOK.d, fw = m.fw, fh = m.fh, idx = imgs.poster ? m.N - 1 : Math.round((1 - clamp(p / 0.88)) * (m.N - 1)), q = imgs.poster ? 0 : p;
      const f = imgs.frame ||= mk(fw, fh), x = f.getContext('2d'); x.clearRect(0, 0, fw, fh);
      x.fillStyle = bg; x.fillRect(0, 0, fw, fh); x.globalCompositeOperation = 'lighten';
      if (imgs.poster) x.drawImage(imgs.atlas, 0, 0, fw, fh); else x.drawImage(imgs.atlas, (idx % m.cols) * fw, ((idx / m.cols) | 0) * fh, fw, fh, 0, 0, fw, fh);
      x.globalCompositeOperation = 'source-over';
      const seam = clamp((q - 0.7) / 0.18) * 0.55; // the green line in the gap as the cover comes down
      if (seam > 0.003) { const sx = BOOK.sx0 * fw, sw = (BOOK.sx1 - BOOK.sx0) * fw, sy = BOOK.sy * fh, g = x.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, `rgba(157,184,141,${seam})`); g.addColorStop(.45, `rgba(86,109,72,${seam * .36})`); g.addColorStop(.7, 'rgba(86,109,72,0)');
        x.save(); x.translate(sx + sw / 2, sy); x.scale(sw / 2, 14); x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, 7); x.fill(); x.restore(); }
      feather(x, fw, fh, 0.05);
      const [dx, dy, dw, dh] = place(fw, fh); ctx.drawImage(f, dx, dy, dw, dh); return;
    }
    // recorder: the lit shelf; the dim one shows outside a ellipse that shrinks onto the recorder (which stays inside it, so it keeps its full light)
    const w = imgs.dark.width, h = imgs.dark.height; comp ||= mk(w, h); mask ||= mk(w, h);
    const c = comp.getContext('2d'), m = mask.getContext('2d');
    c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h); c.drawImage(imgs.lit, 0, 0);
    m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'source-over'; m.clearRect(0, 0, w, h);
    const R = (0.8 - 0.51 * ss(clamp(p))) * w, cx = REC.cx * w, cy = REC.cy * h, g = m.createRadialGradient(0, 0, R * 0.86, 0, 0, R);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)'); m.save(); m.translate(cx, cy); m.scale(1, REC.ky); m.fillStyle = g; m.fillRect(-2 * w, -2 * h / REC.ky, 4 * w, 4 * h / REC.ky); m.restore(); // an ellipse around the recorder
    m.globalCompositeOperation = 'source-in'; m.drawImage(imgs.dark, 0, 0); c.drawImage(mask, 0, 0);
    const [dx, dy, dw, dh] = place(w, h); ctx.drawImage(comp, dx, dy, dw, dh);
  }
  const settledState = () => (kind === 'recorder' ? 1 : 0); // still: the recorder alone lit; the book open (the poster)
  function tick(now) {
    const dt = Math.min(now - last, 64); last = now; cur += (target - cur) * (1 - Math.exp(-dt / TAU));
    if (Math.abs(target - cur) < 0.0004) { cur = target; raf = 0; draw(cur); return; }
    draw(cur); raf = requestAnimationFrame(tick);
  }
  function onScroll() { if (!visible || still()) return; target = progress(); if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  function settle() { size(); target = still() ? settledState() : progress(); cur = target; drawn = ''; draw(cur); }

  async function fetchAll() {
    const k = PHONE.matches ? 'm' : 'd', key = k + (still() ? 's' : ''); if (mode === key) return; mode = key; imgs = null; comp = mask = null;
    bg = bgOf(sec);
    try {
      if (kind === 'book') { const a = await load(`/scroll/rec/le-${still() ? 'poster-' : ''}${k}.webp`); if (mode !== key) return; imgs = { atlas: a, poster: still() }; } // still: the 5 KB open-case poster, not the atlas
      else { const got = await Promise.all(['dark', 'lit'].map((n) => load(`/scroll/le/recorder3-${n}-${k}.webp`))); if (mode !== key) return; imgs = {}; ['dark', 'lit'].forEach((n, i) => { imgs[n] = grade(got[i], bg, 0.05); got[i].close?.(); }); }
    } catch { imgs = null; }
  }
  const start = () => { started = true; fetchAll().then(() => visible && settle()); };
  whenNear(el, start);
  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible && started) { if (!imgs) fetchAll().then(settle); else settle(); } }, { rootMargin: '20% 0px' }).observe(el);
  new IntersectionObserver((es) => { const on = es[es.length - 1].isIntersecting; if (!on && imgs) { imgs.atlas?.close?.(); imgs = null; mode = ''; comp = mask = null; } else if (on && started && !imgs) fetchAll().then(() => visible && settle()); }, { rootMargin: '300% 0px' }).observe(el);
  const remeasure = () => { if (visible && imgs) { size(); drawn = ''; target = still() ? settledState() : progress(); cur = target; draw(cur); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', remeasure, { passive: true });
  new ResizeObserver(remeasure).observe(document.documentElement);
  PHONE.addEventListener('change', () => { if (started) fetchAll().then(() => visible && settle()); });
  REDUCED.addEventListener('change', () => { mode = ''; if (started) fetchAll().then(() => visible && settle()); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible && imgs) remeasure(); });
  document.fonts?.ready.then(remeasure);
}
syncMode();
document.querySelectorAll('[data-le]').forEach(init);
