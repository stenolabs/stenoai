// Scroll-driven light: a dark still and its lit edit of the same picture, joined through soft zone masks, on a canvas.
//   <div data-scroll-light data-dark="/a.webp" data-lit="/b.webp" data-zones='[{"r":[x,y,w,h],"a":.1,"b":.2,"f":.1}]' data-ratio="1.78">
// r = zone rectangle as fractions of the picture, a..b = progress over which the zone's lit level ramps 0 -> 1, f = feather as a fraction of the zone's
// smaller side, d = progress at which the zone settles to data-later (the level earlier zones keep once the next one is on).
// Progress follows the same rules as scroll-seq.js: inside a pinned .stage it follows the stage's scroll length; otherwise (phones, short windows,
// figures that are not pinned) it follows the element's own travel through the screen (data-flow-end = fraction of the viewport the element's bottom
// reaches, or the bottom of data-flow-target). data-items + zone index: step highlight of the matching cards (is-lit, is-done).
// Reduced motion and data saver: no canvas, the fully lit picture (the <img>) stays. Nothing is fetched before 1.5 viewports; it decodes off the main thread.
import { FLOW, PHONE, REDUCED, MAXPX, checkFit, clamp, decodeBlob, fitTests, still, syncMode, whenNear } from './scroll-env.js';

const TAU = 65; // ms, as scroll-seq.js: 95% settled in about 200 ms
const ease = (t) => t * t * (3 - 2 * t);

function init(el) {
  const canvas = el.querySelector('canvas'), ctx = canvas.getContext('2d');
  const stage = el.closest('.stage'), sec = el.closest('section');
  let zones = JSON.parse(el.dataset.zones); const later = el.dataset.later === undefined ? 1 : +el.dataset.later;
  const items = el.dataset.items ? [...sec.querySelectorAll(el.dataset.items)] : [];
  const A = (k) => (PHONE.matches && el.dataset[k + 'Phone']) || el.dataset[k];
  let dark = null, lit = null, tiles = [], started = false, visible = false, near = false, loadedKey = '', loadP = null;
  let ground = null, cur = 0, target = 0, raf = 0, last = 0, drawn = -1, W = 0, H = 0, dpr = 1, dx = 0, dy = 0, dw = 0, dh = 0;
  const M = { pin: false, sTop: 0, sH: 0, pH: 1, top: 0, end: 0, vh: 1 };

  function releaseTiles() {
    tiles.forEach((entry) => { if (entry) entry.t.width = entry.t.height = 0; });
    tiles = [];
  }
  function releaseAll() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    dark?.close?.(); lit?.close?.();
    dark = lit = null;
    releaseTiles();
    loadedKey = '';
    loadP = null;
    drawn = -1;
  }

  function measure() {
    const sy = scrollY, r = el.getBoundingClientRect();
    M.vh = innerHeight; M.top = r.top + sy;
    const t = el.dataset.flowTarget ? document.querySelector(el.dataset.flowTarget) : null, tr = t?.getBoundingClientRect();
    M.end = (tr ? tr.bottom + sy : r.bottom + sy);
    M.pin = !!stage && !FLOW.matches && !stage.hasAttribute('data-nofit') && document.documentElement.dataset.ss === 'on';
    if (M.pin) {
      const q = stage.getBoundingClientRect();
      M.sTop = q.top + sy; M.sH = q.height;
      M.pH = stage.firstElementChild?.offsetHeight || innerHeight;
    }
    reserve();
    W = r.width; H = r.height;
    dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAXPX / Math.max(1, W * H)));
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch || (lit && !tiles.length)) { canvas.width = cw; canvas.height = ch; drawn = -1; buildTiles(); }
  }
  // Pinned list (0 CLS, no card overlap): every row keeps its closed height and lower rows move with transform; the list reserves exact room for the tallest open card and clips above .sector-note.
  function reserve(pinned = M.pin) {
    if (!items.length) return;
    const list = items[0].parentElement;
    items.forEach((e) => { e.style.height = ''; e.style.transform = ''; });
    if (!pinned) { list.style.height = ''; list.style.minHeight = ''; ground = null; return; }
    const was = items.map((e) => e.className);
    list.style.height = ''; list.style.minHeight = '';
    stage?.classList.add('is-measuring');
    items.forEach((e) => e.classList.remove('is-lit'));
    const closed = items.map((e) => e.getBoundingClientRect().height), open = [];
    items.forEach((e, i) => {
      items.forEach((o, j) => o.classList.toggle('is-lit', i === j));
      open[i] = e.getBoundingClientRect().height;
    });
    items.forEach((e, i) => {
      e.className = was[i];
      e.style.height = closed[i] + 'px';
      e._extra = Math.max(0, open[i] - closed[i]);
      e.style.setProperty('--lit-h', open[i] + 'px');
    });
    stage?.classList.remove('is-measuring');
    const maxExtra = Math.max(...items.map((e) => e._extra));
    const total = Math.ceil(closed.reduce((a, b) => a + b, 0) + maxExtra) + 'px';
    list.style.height = total;
    list.style.minHeight = total;
    const pr = stage.querySelector('.stage-panel').getBoundingClientRect();
    const note = stage.querySelector('.sector-note');
    ground = (Math.max(list.getBoundingClientRect().bottom, note ? note.getBoundingClientRect().bottom : 0) - pr.top + 22) / pr.height;
  }
  if (items.length && stage) {
    fitTests.push({
      stage,
      test: () => {
        if (innerWidth < 912) { reserve(false); return false; }
        reserve(true);
        const ok = ground !== null && ground < 0.99;
        if (!ok) reserve(false);
        return ok;
      },
    });
  }
  function progress() {
    if (M.pin) return clamp((scrollY - M.sTop) / Math.max(1, M.sH - M.pH));
    const f = +(el.dataset.flowStart || 0.85), e = +(el.dataset.flowEnd || 0.45);
    const s0 = M.top - f * M.vh, s1 = M.end - e * M.vh;
    return clamp((scrollY - s0) / (s1 - s0));
  }
  function layout() { // the picture's rectangle inside the canvas (CSS px)
    const ar = +el.dataset.ratio || 16 / 9;
    const cover = A('fit') === 'cover';
    if (A('ground') && M.pin) { // the picture's own ground line sits at data-ground x the box height, picture height = data-hfrac x box height, right aligned
      const pr0 = stage ? stage.querySelector('.stage-panel').getBoundingClientRect() : { top: 0 }, below = el.dataset.below && Math.max(...[...document.querySelectorAll(el.dataset.below)].map((n) => n.getBoundingClientRect().bottom - pr0.top)); // the picture's top stays under the heading block
      const g = ground ?? +A('ground'), av = el.dataset.avoid && Math.max(...[...document.querySelectorAll(el.dataset.avoid)].map((n) => n.getBoundingClientRect().right));
      dh = Math.min(+A('hfrac') * H, av ? (el.getBoundingClientRect().right - av - 24) / 0.713 / ar : 1e9, (g * H - 96) / +A('gy'), below ? (g * H - below - 16) / 0.654 : 1e9); dw = dh * ar; dx = W - dw; dy = g * H - +A('gy') * dh; return;
    }
    if (cover) { dh = Math.max(H, W / ar); dw = dh * ar; } else { dw = Math.min(W, H * ar); dh = dw / ar; }
    dx = A('align') === 'right' ? W - dw : (W - dw) / 2; dy = (H - dh) / 2;
  }
  // Each zone's lit tile (the lit picture through a feathered rectangle) is made once per size; a frame only draws the tiles with their level.
  function buildTiles() {
    releaseTiles();
    if (!lit || !W || !H) return;
    layout();
    for (const z of zones) {
      const [zx, zy, zw, zh] = z.r, f = (z.f ?? 0.12) * Math.min(zw * dw, zh * dh);
      const x = Math.floor((dx + zx * dw - f) * dpr), y = Math.floor((dy + zy * dh - f) * dpr);
      const w = Math.ceil((zw * dw + 2 * f) * dpr), h = Math.ceil((zh * dh + 2 * f) * dpr), fp = f * dpr;
      if (w <= 0 || h <= 0) { tiles.push(null); continue; }
      const t = document.createElement('canvas'); t.width = w; t.height = h; const c = t.getContext('2d');
      c.drawImage(lit, dx * dpr - x, dy * dpr - y, dw * dpr, dh * dpr);
      c.globalCompositeOperation = 'destination-in';
      for (const horiz of [true, false]) { // two tent ramps multiply into a soft rectangle
        const n = horiz ? w : h, g = horiz ? c.createLinearGradient(0, 0, w, 0) : c.createLinearGradient(0, 0, 0, h), s = Math.min(0.5, fp / n);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(s, '#000'); g.addColorStop(1 - s, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(0, 0, w, h);
      }
      tiles.push({ t, x, y });
    }
  }
  const level = (z, p) => {
    let v = ease(clamp((p - z.a) / (z.b - z.a)));
    if (later < 1 && z.d !== undefined) v *= 1 - (1 - later) * ease(clamp((p - z.d) / 0.04));
    return v;
  };
  function syncItems(p) {
    if (!items.length) return;
    let k = M.pin ? 0 : -1;
    zones.forEach((z, i) => { if (p >= z.a + (z.b - z.a) * 0.4) k = i; });
    items.forEach((e, i) => {
      e.classList.toggle('is-lit', i === k);
      e.classList.toggle('is-done', i < k);
      e.style.transform = M.pin && k >= 0 && i > k ? `translateY(${items[k]._extra || 0}px)` : '';
    });
  }
  function paint(force) {
    const p = cur;
    syncItems(p);
    if (!dark || !lit || !W || !H || !canvas.width || !canvas.height) return;
    const key = p.toFixed(4) + '|' + W + 'x' + H; if (!force && key === drawn) return; drawn = key;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(dark, dx * dpr, dy * dpr, dw * dpr, dh * dpr);
    zones.forEach((z, i) => { const v = level(z, p), tile = tiles[i]; if (v > 0.002 && tile && tile.t.width > 0 && tile.t.height > 0) { ctx.globalAlpha = v; ctx.drawImage(tile.t, tile.x, tile.y); } });
    ctx.globalAlpha = 1;
    // Fade the picture's bottom (floor reflection), the box's bottom edge, and (when pinned) the left edge so the floor line never hard-clips next to the text column.
    ctx.globalCompositeOperation = 'destination-in';
    const g = ctx.createLinearGradient(0, dy * dpr, 0, (dy + dh) * dpr); g.addColorStop(0, '#000'); g.addColorStop(0.86, '#000'); g.addColorStop(0.995, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const g2 = ctx.createLinearGradient(0, 0, 0, canvas.height); g2.addColorStop(0, '#000'); g2.addColorStop(0.8, '#000'); g2.addColorStop(0.995, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (M.pin) {
      const fl = Math.min(0.14, (64 * dpr) / Math.max(1, canvas.width));
      const gl = ctx.createLinearGradient(0, 0, canvas.width, 0); gl.addColorStop(0, 'rgba(0,0,0,0)'); gl.addColorStop(fl, '#000'); gl.addColorStop(1, '#000');
      ctx.fillStyle = gl; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function tick(now) {
    const dt = Math.min(now - last, 64); last = now;
    cur += (target - cur) * (1 - Math.exp(-dt / TAU));
    if (Math.abs(target - cur) < 0.0004) { cur = target; raf = 0; paint(); return; } // settled: the loop stops
    paint(); raf = requestAnimationFrame(tick);
  }
  function onScroll() { if (!visible || still()) return; target = progress(); if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  function load() {
    const k = (PHONE.matches ? 'p' : 'd') + A('dark');
    if (loadedKey === k && (dark || loadP)) return loadP || Promise.resolve();
    releaseAll();
    loadedKey = k;
    zones = JSON.parse(A('zones'));
    const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u); return decodeBlob(await r.blob()); };
    const p = (async () => {
      try {
        const [dBmp, lBmp] = await Promise.all([get(A('dark')), get(A('lit'))]);
        if (loadedKey !== k) { dBmp.close?.(); lBmp.close?.(); return; }
        dark = dBmp; lit = lBmp;
        buildTiles();
      } finally {
        if (loadP === p) loadP = null;
      }
    })();
    loadP = p;
    return p;
  }
  function settle() { measure(); target = progress(); cur = target; paint(true); }
  function remeasure() {
    measure();
    if (still()) { reserve(false); return; }
    if (visible && dark) { target = progress(); if (!raf) { cur = target; paint(true); } }
    else if (items.length) syncItems(progress());
  }

  if (items.length && !still()) items[0].classList.add('is-lit');

  whenNear(el, () => {
    started = true;
    if (still()) return;
    measure();
    load().then(() => { el.classList.add('is-ready'); if (visible) settle(); }).catch(() => { loadedKey = ''; });
  });
  new IntersectionObserver((es) => {
    near = es[es.length - 1].isIntersecting;
    if (!started || still()) return;
    if (!near && dark) releaseAll();
    else if (near && !dark) load().then(() => { el.classList.add('is-ready'); if (visible) settle(); }).catch(() => { loadedKey = ''; });
  }, { rootMargin: '250% 0px' }).observe(el);
  new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting;
    if (visible && !still()) {
      if (dark) settle();
      else if (started) load().then(() => { el.classList.add('is-ready'); if (visible) settle(); }).catch(() => { loadedKey = ''; });
    }
  }, { rootMargin: '20% 0px' }).observe(el);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', remeasure, { passive: true });
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    remeasure();
    if (started && !still() && (near || visible) && !dark) {
      load().then(() => { el.classList.add('is-ready'); if (visible) settle(); }).catch(() => { loadedKey = ''; });
    }
  });
  new ResizeObserver(remeasure).observe(document.documentElement);
  PHONE.addEventListener('change', () => {
    if (started && !still() && (near || visible)) {
      load().then(() => { el.classList.add('is-ready'); if (visible) settle(); }).catch(() => { loadedKey = ''; });
    }
  });
  FLOW.addEventListener('change', remeasure);
  REDUCED.addEventListener('change', () => {
    if (still()) { remeasure(); return; }
    started = true;
    measure();
    if (!dark) load().then(() => { el.classList.add('is-ready'); if (visible) settle(); }).catch(() => { loadedKey = ''; });
    else settle();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remeasure(); });
  document.fonts?.ready.then(remeasure);
}

syncMode();
document.querySelectorAll('[data-scroll-light]').forEach(init);
checkFit();
