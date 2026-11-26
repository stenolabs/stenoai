// Scroll-driven WebP frame sequences on a canvas: the voice waveform, the cable pull and the closing doors on the home page.
//   <div data-scroll-seq data-src="/dir" data-src-phone="/dir" data-frames="97" data-start=".9" data-end=".45"><canvas></canvas></div>
// Frames are <src>/0000.webp ... (data-src-phone on phones). In flow layout (phones, short windows: the footage sits above the text)
// every other attribute can carry a -phone variant.
// Progress: 0 when the element's top is at data-start x viewport height, 1 when data-target's top is at data-end x viewport height
// (data-target = a selector, or "bottom" = the element's bottom; default its top). Inside a pinned .stage (not in flow layout)
// progress follows the stage's scroll length instead. data-map="a,b": frames 0..N-1 over progress a..b (values outside 0..1 trim the ends).
// data-centre=".55": instead of data-end, progress is 1 when the element's centre reaches that fraction of the viewport height.
// data-place: right | region (data-region = left edge as a fraction, at least data-region-after's right edge + 24px; data-region-top px) | center; with data-anchor="x,y,w" the frame is
// aligned to the real element data-target (the frame's x,y,w); otherwise it fills the element.
// data-dim (+ data-dim-pad): soft holes in the picture behind text. data-lit + data-lit-items: step highlight by progress.
// data-light="a,b": --lit (0..1) on the section's h2 between progress a and b.
import { PHONE, FLOW, REDUCED, MAXPX, clamp, decodeBlob, still, syncMode, whenNear } from './scroll-env.js';

const TAU = 65; // ms; 95% settled in about 200 ms
// Several sets can be near at once (films and deploy are about a screen apart): bitmaps are decoded one at a time across all sets, off the main thread,
// and off-screen sets start fetching 450 ms apart, so a slow phone or a 4x-throttled laptop never gets one long task.
// Sets in the viewport skip the queue and draw their current frame (or nearest available frame) at once.
const decHi = [], decLo = [];
let decBusy = false;
function runDec() {
  if (decBusy) return;
  const job = decHi.shift() || decLo.shift();
  if (!job) return;
  decBusy = true;
  Promise.resolve().then(job.fn).then(job.res, job.rej).finally(() => { decBusy = false; runDec(); });
}
const serial = (fn, urgent = false) => new Promise((res, rej) => {
  (urgent ? decHi : decLo).push({ fn, res, rej });
  runDec();
});
const offQ = [];
let offTimer = 0, lastOff = 0;
function pumpOff() {
  offTimer = 0;
  while (offQ.length) {
    const item = offQ.shift();
    if (item.cancelled) continue;
    lastOff = performance.now();
    item.fn();
    if (offQ.length) offTimer = setTimeout(pumpOff, 450);
    return;
  }
}
const stagger = (fn, now_ = false) => {
  if (now_) { fn(); return null; }
  const item = { fn, cancelled: false };
  offQ.push(item);
  if (!offTimer) {
    const wait = Math.max(0, 450 - (performance.now() - lastOff));
    offTimer = setTimeout(pumpOff, wait);
  }
  return item;
};

function init(el) {
  const canvas = el.querySelector('canvas'), ctx = canvas.getContext('2d');
  const stage = el.closest('.stage'), sec = el.closest('section'), host = el.parentElement;
  const N = +el.dataset.frames;
  const A = (k) => (FLOW.matches && el.dataset[k + 'Phone'] !== undefined ? el.dataset[k + 'Phone'] : el.dataset[k]);
  const dir = () => (PHONE.matches ? el.dataset.srcPhone : el.dataset.src);
  const url = (i) => `${dir()}/${String(i).padStart(4, '0')}.webp`;
  let blobs = [], bmps = new Map(), pending = new Set(), prio = [], seen = new Set(), loadedKey = '', started = false, visible = false, inView = false, near = false, stItem = null;
  let cur = 0, target = 0, raf = 0, last = 0, drawn = -1, rects = [];
  const M = { x0: 0, pin: false, sTop: 0, sH: 0, pH: 1, top: 0, end: 0, vh: 1, w: 0, h: 0, dpr: 1, s: 0, ox: 0, oy: 0 };

  function measure() {
    const sy = scrollY, r = el.getBoundingClientRect(), tgt = A('target'), an = A('anchor')?.split(',').map(Number);
    const t = tgt && tgt !== 'bottom' ? document.querySelector(tgt) : null, tr = t?.getBoundingClientRect();
    M.vh = innerHeight; M.top = r.top + sy; M.w = r.width; M.h = r.height;
    M.end = tr ? tr.top + sy : tgt === 'bottom' ? M.top + r.height : M.top;
    M.pin = !!stage && !FLOW.matches && !stage.hasAttribute('data-nofit') && document.documentElement.dataset.ss === 'on';
    if (M.pin) {
      const q = stage.getBoundingClientRect();
      M.sTop = q.top + sy; M.sH = q.height;
      M.pH = stage.firstElementChild?.offsetHeight || innerHeight;
    }
    if (an && tr) { M.s = tr.width / an[2]; M.ox = tr.left - r.left - an[0] * M.s; M.oy = tr.top - r.top - an[1] * M.s; } else M.s = 0;
    const ra = A('regionAfter') && sec.querySelector(A('regionAfter'))?.getBoundingClientRect(); // region starts after this element (inside the section)
    M.x0 = Math.max(+A('region') * r.width, ra ? ra.right - r.left + 24 : 0);
    M.dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAXPX / Math.max(1, r.width * r.height)));
    const cw = Math.round(r.width * M.dpr), ch = Math.round(r.height * M.dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; drawn = -1; }
    rects = dimRects(r);
  }
  // Soft-edged holes (destination-out) over every text rectangle in the host section, so text never sits on bright footage.
  function dimRects(r) {
    const dimA = +A('dim') || 0; if (!dimA || (still() && stage)) return [];
    const out = [], tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      if (!n.textContent.trim() || n.parentElement.closest('.platform-console-wrap,[data-scroll-seq],script,style')) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const q of rg.getClientRects()) if (q.width > 1 && q.bottom > r.top && q.top < r.bottom && q.right > r.left && q.left < r.right) out.push([q.left - r.left, q.top - r.top, q.width, q.height]);
    }
    return out;
  }
  function dim() {
    if (!rects.length) return;
    const pad = +A('dimPad') || 18, L = +A('dimPad') ? 12 : 7, a = 1 - Math.pow(1 - (+A('dim') || 0), 1 / L);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = `rgba(0,0,0,${a})`;
    for (const [x, y, w, h] of rects) for (let k = 0; k < L; k++) { const e = pad * (1 - k / L); ctx.fillRect(x - e, y - e, w + 2 * e, h + 2 * e); }
    ctx.globalCompositeOperation = 'source-over';
  }
  function progress() {
    if (M.pin) return clamp((scrollY - M.sTop) / Math.max(1, M.sH - M.pH));
    const s0 = M.top - +A('start') * M.vh, s1 = A('centre') ? M.top + M.h / 2 - +A('centre') * M.vh : M.end - +A('end') * M.vh; // data-centre: finished when the picture's centre is at that fraction of the viewport
    return clamp((scrollY - s0) / (s1 - s0));
  }

  function wantFrame(p = cur) {
    if (still()) return N - 1;
    const mp = (A('map') || '0,1').split(',').map(Number);
    return Math.round(clamp((p - mp[0]) / (mp[1] - mp[0])) * (N - 1));
  }
  async function decode(i, urgent = false) {
    if (bmps.has(i) || !blobs[i]) return;
    const k = loadedKey;
    const blob = blobs[i];
    const b = await serial(() => (k !== loadedKey || (!visible && !still()) ? null : decodeBlob(blob)), urgent);
    if (!b) return;
    if (k !== loadedKey || (!visible && !still())) { b.close?.(); return; } // stale, or arrived while off screen (the settled still is kept)
    bmps.set(i, b);
  }
  const release = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } bmps.forEach((b) => b.close?.()); bmps = new Map(); pending.clear(); drawn = -1; }; // far off screen: frames are decoded again on return
  function nearest(i) { // closest decoded frame; scrubbing never shows a blank canvas
    for (let d = 0; d < N; d++) { if (bmps.has(i - d)) return i - d; if (bmps.has(i + d)) return i + d; }
    return -1;
  }
  function nearestBlob(i) { // closest already-fetched blob when no bitmap is decoded yet
    for (let d = 0; d < N; d++) { if (blobs[i - d]) return i - d; if (blobs[i + d]) return i + d; }
    return -1;
  }
  const WIN = [0, 1, -1, 2, -2, 3, -3, 4, 5, 6];
  function paint(force) {
    const want = wantFrame(cur);
    onProgress(cur);
    if (!M.w || !M.h || !canvas.width || !canvas.height) return;
    if (want === drawn && !force) return;
    for (const d of WIN) { const j = want + d; if (j >= 0 && j < N && !bmps.has(j) && blobs[j] && !pending.has(j)) { pending.add(j); decode(j, d === 0 && drawn < 0).then(() => { pending.delete(j); if (visible) paint(true); }).catch(() => {}); } } // a bad frame stays in pending: never retried
    const f = nearest(want);
    if (f < 0) {
      const bj = nearestBlob(want);
      if (bj >= 0 && !pending.has(bj)) { pending.add(bj); decode(bj, true).then(() => { pending.delete(bj); if (visible) paint(true); }).catch(() => {}); }
      return;
    }
    const b = bmps.get(f), W = M.w, H = M.h, ar = b.width / b.height, place = still() && stage ? 'center' : A('place');
    let dx = 0, dy = 0, dw = W, dh = W / ar;
    if (M.s) { dw = b.width * M.s; dh = b.height * M.s; dx = M.ox; dy = M.oy; }
    else if (place === 'right') { dw = Math.min(0.76 * W, 0.9 * H * ar); dh = dw / ar; dx = W - dw; dy = (H - dh) / 2; }
    else if (place === 'region') { const x0 = M.x0, rw = W - x0, y0 = +A('regionTop') || 0, rh = H - y0; dw = Math.min(rw, rh * ar); dh = dw / ar; dx = x0 + (rw - dw) / 2; dy = y0 + (rh - dh) / 2; }
    else if (place === 'center') { dh = Math.min(0.9 * H, 0.9 * W / ar); dw = dh * ar; dx = (W - dw) / 2; dy = (H - dh) / 2; }
    ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.drawImage(b, dx, dy, dw, dh);
    dim(); drawn = f === want ? want : -1; // a stand-in frame is redrawn as soon as the exact one is decoded
    for (const [k, v] of bmps) if (Math.abs(k - want) > 8) { v.close?.(); bmps.delete(k); }
  }
  function tick(now) {
    const dt = Math.min(now - last, 64); last = now;
    cur += (target - cur) * (1 - Math.exp(-dt / TAU));
    if (Math.abs(target - cur) < 0.0004) { cur = target; raf = 0; paint(); return; } // settled: the loop stops
    paint(); raf = requestAnimationFrame(tick);
  }
  function onScroll() {
    if (!visible || still()) return;
    target = progress();
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function prioritize(i) {
    if (i < 0 || i >= N || blobs[i] || prio.includes(i)) return;
    prio.push(i);
  }
  async function fetchOne(i, k, urgent = false) {
    try {
      const r = await fetch(url(i), urgent ? { priority: 'high' } : undefined); if (k !== loadedKey) return; if (!r.ok) throw new Error(String(r.status)); blobs[i] = await r.blob();
      if (k !== loadedKey) return;
      if (still() || (visible && (drawn < 0 || Math.abs(i - wantFrame()) < 4))) {
        await decode(i, drawn < 0);
        if (visible && k === loadedKey) { if (still()) cur = target = 1; paint(true); }
      }
    } catch { /* a missing frame is skipped: the nearest decoded one is shown */ }
  }
  async function load() {
    // The page already provides the responsive poster in still mode.
    if (still() && el.hasAttribute('data-static-poster')) return;
    const k = PHONE.matches ? 'phone' : 'desktop'; if (loadedKey === k) return;
    loadedKey = k; blobs = []; seen = new Set(); release();
    const order = [...Array(N).keys()];
    if (still()) order.splice(0, order.length, N - 1); // one settled frame
    else order.sort((a, b) => (a % 8 ? (a % 4 ? (a % 2 ? 3 : 2) : 1) : 0) - (b % 8 ? (b % 4 ? (b % 2 ? 3 : 2) : 1) : 0) || a - b); // coarse frames first
    let q = 0;
    const nextFrame = () => {
      while (prio.length) { const i = prio.shift(); if (!seen.has(i)) { seen.add(i); return { i, urgent: true }; } }
      while (q < order.length) { const i = order[q++]; if (!seen.has(i)) { seen.add(i); return { i, urgent: false }; } }
      return null;
    };
    const worker = async () => {
      for (let item = nextFrame(); item && k === loadedKey; item = nextFrame()) await fetchOne(item.i, k, item.urgent);
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  function settle() { measure(); target = still() ? 1 : progress(); cur = target; paint(true); }
  function remeasure() { measure(); if (visible && loadedKey) { target = still() ? 1 : progress(); if (!raf) { cur = target; paint(true); } } }
  function cancelScheduledLoad() {
    if (stItem) { stItem.cancelled = true; stItem = null; }
  }
  function startNow() {
    cancelScheduledLoad();
    started = true;
    visible = true;
    measure();
    target = still() ? 1 : progress();
    cur = target;
    const w = wantFrame(cur);
    if (!loadedKey) {
      prioritize(w);
      load().then(() => visible && settle());
    } else {
      settle();
      if (drawn < 0 && !blobs[w] && !seen.has(w)) { seen.add(w); fetchOne(w, loadedKey, true); }
    }
  }
  function scheduleLoad() {
    if (inView) { startNow(); return; }
    if (stItem || loadedKey) return;
    stItem = stagger(() => {
      stItem = null;
      if (!near && !visible && !still()) return;
      measure();
      load().then(() => visible && settle());
    }, false);
  }

  // Step highlight (cable; in flow layout it follows the list's own travel) and "Keep control." light (doors) follow the settled progress.
  const items = el.dataset.lit ? [...sec.querySelectorAll(el.dataset.litItems)] : [], lit = el.dataset.lit?.split(',').map(Number);
  const light = el.dataset.light?.split(',').map(Number), h2 = light && sec.querySelector('h2');
  const setLit = (p, T) => { let k = 0; T.forEach((t, i) => { if (p >= t) k = i; }); items.forEach((e, i) => e.classList.toggle('is-lit', i === k)); };
  function onProgress(p) {
    if (items.length && !FLOW.matches) setLit(p, lit);
    if (light) h2.style.setProperty('--lit', clamp((p - light[0]) / (light[1] - light[0])).toFixed(3));
  }
  if (items.length) {
    const list = items[0].parentElement, T = el.dataset.litPhone.split(',').map(Number);
    let listVisible = false;
    new IntersectionObserver((es) => { listVisible = es[es.length - 1].isIntersecting; }, { rootMargin: '20% 0px' }).observe(list);
    addEventListener('scroll', () => {
      if (!listVisible || !FLOW.matches || document.documentElement.dataset.ss !== 'on') return;
      const r = list.getBoundingClientRect(), s0 = r.top - 0.9 * innerHeight, e0 = r.bottom - 0.45 * innerHeight;
      setLit(clamp(-s0 / (e0 - s0)), T);
    }, { passive: true });
  }
  if (items.length) setLit(0, lit);

  whenNear(el, () => { near = started = true; scheduleLoad(); }, el.dataset.near || '150% 0px', () => {
    near = false;
    cancelScheduledLoad();
  });
  // More than 2 viewports away: the encoded frames are dropped too (fetched again from the cache on return).
  new IntersectionObserver((es) => {
    if (es[es.length - 1].isIntersecting || still()) return;
    if (loadedKey) {
      release(); blobs = []; prio = []; seen = new Set(); loadedKey = '';
    }
  }, { rootMargin: '200% 0px' }).observe(el);
  new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting;
    if (visible) { measure(); if (loadedKey) settle(); else if (inView) startNow(); } else release();
  }, { rootMargin: '20% 0px' }).observe(el);
  new IntersectionObserver((es) => {
    inView = es[es.length - 1].isIntersecting;
    if (inView) startNow();
  }, { rootMargin: '0px' }).observe(el);
  const r0 = el.getBoundingClientRect();
  if (r0.height > 0 && r0.bottom > 0 && r0.top < innerHeight) { inView = true; startNow(); }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', remeasure, { passive: true });
  addEventListener('pageshow', (e) => { if (!e.persisted) return; remeasure(); if (inView && !loadedKey) startNow(); });
  new ResizeObserver(remeasure).observe(document.documentElement);
  PHONE.addEventListener('change', () => { if (started && (near || visible || still())) load().then(() => visible && settle()); });
  FLOW.addEventListener('change', remeasure);
  REDUCED.addEventListener('change', () => { loadedKey = ''; if (started && (near || visible || still())) load().then(() => visible && settle()); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remeasure(); });
  document.fonts?.ready.then(remeasure);
}

syncMode();
document.querySelectorAll('[data-scroll-seq]').forEach(init);
