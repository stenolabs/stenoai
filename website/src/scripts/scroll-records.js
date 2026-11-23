// Record cards (02 / Where it's used): a closed case slides in beside a voice waveform, opens as the card scrolls into view, and
// closes again when the pointer or keyboard focus is on it. The case is a frame atlas on a canvas that melts into the card colour.
// Markup lives in MissionSectors.astro (.mission-sector-rec > .mission-sector-image > .rec). Reduced motion and data saver: the open case, still.
import { PHONE, REDUCED, clamp, idle, still, syncMode } from './scroll-env.js';

// Where things sit inside each crop (fractions of the crop) and the atlas layout, per card and size (d desktop, m phone).
const META = {"gov":{"cropW":793,"cropH":709,"ubx0":0.1084,"ubx1":0.8916,"uby0":0.0663,"uby1":0.9083,"cbx0":0.1173,"cbx1":0.8916,"cby0":0.4838,"cby1":0.9986,"sy":0.6982,"sx0":0.1198,"sx1":0.9811,"seq":{"d":{"N":48,"cols":8,"fw":562,"fh":502},"m":{"N":32,"cols":8,"fw":348,"fh":311}}},"def":{"cropW":834,"cropH":720,"ubx0":0.1091,"ubx1":0.8909,"uby0":0.0153,"uby1":0.9028,"cbx0":0.1259,"cbx1":0.8873,"cby0":0.4681,"cby1":0.9597,"sy":0.7264,"sx0":0.1499,"sx1":0.8609,"seq":{"d":{"N":48,"cols":8,"fw":563,"fh":486},"m":{"N":32,"cols":8,"fw":349,"fh":301}}},"le":{"cropW":1012,"cropH":720,"ubx0":0.1087,"ubx1":0.8913,"uby0":0.0542,"uby1":0.9583,"cbx0":0.1097,"cbx1":0.8893,"cby0":0.4903,"cby1":0.9986,"sy":0.725,"sx0":0.1206,"sx1":0.8735,"seq":{"d":{"N":48,"cols":8,"fw":562,"fh":400},"m":{"N":32,"cols":8,"fw":349,"fh":248}}}};

function bez(x1, y1, x2, y2) { // cubic-bezier easing, Newton with a bisection fallback
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const cx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t - x, d = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
      if (Math.abs(cx) < 1e-5 || Math.abs(d) < 1e-6) break; t -= cx / d;
    }
    if (t < 0 || t > 1) { let lo = 0, hi = 1; t = x; for (let i = 0; i < 20; i++) { const cx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t; if (cx < x) lo = t; else hi = t; t = (lo + hi) / 2; } }
    return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  };
}
const easeScrub = bez(.4, 0, .2, 1), easeGlide = bez(.16, .84, .3, 1), easeOpen = bez(.3, .1, .1, .5), easeWave = bez(.3, .1, .1, .5);

const cards = [...document.querySelectorAll('.mission-sector-rec')].map((a) => {
  const slot = a.querySelector('.mission-sector-image'), rec = slot.querySelector('.rec'), obj = rec.querySelector('.rec-obj'), cv = obj.querySelector('canvas'), wv = rec.querySelector('.rec-wave');
  return { a, slot, key: a.dataset.rec, m: META[a.dataset.rec], obj, cv, ctx: cv.getContext('2d'), seam: obj.querySelector('.rec-seam'), wv, wctx: wv.getContext('2d'),
    mode: 'd', gen: 0, pgen: 0, pReq: false, pm: 'd', atlas: null, poster: null, loaded: false, inView: false, E: [], Es: null, h: { cur: 0, from: 0, to: 0, t0: 0, delay: 0, dur: 0, on: false, ease: easeOpen }, hw: null, drawn: '', L: null };
});
// Phones and tablets (coarse pointer, or touch under 1280px wide) use the small atlases.
const SMALL = matchMedia('(pointer: coarse), (max-width: 1279px) and (any-pointer: coarse)');
const mode = () => (PHONE.matches || SMALL.matches ? 'm' : 'd');

function layout(c) {
  const m = c.m, W = c.slot.clientWidth, H = c.slot.clientHeight, lab = c.slot.querySelector('.mission-sector-image-label'), h3 = c.slot.querySelector('h3');
  const winTop = lab ? lab.offsetTop + lab.offsetHeight : 30, winBot = (h3 ? h3.offsetTop : H) - 4;
  const sW = .72 * W / ((m.cbx1 - m.cbx0) * m.cropW), sH = (winBot - winTop) / (m.cropH * (1 - m.uby0)), s = Math.min(sW, sH);
  const cw = m.cropW * s, ch = m.cropH * s, left = .97 * W - m.ubx1 * cw, top = winBot - ch;
  c.obj.style.cssText = `left:${left}px;top:${top}px;width:${cw}px;height:${ch}px`;
  c.seam.style.left = `${m.sx0 * 100}%`; c.seam.style.width = `${(Math.min(m.sx1, m.cbx1) - m.sx0) * 100}%`; c.seam.style.top = `${m.sy * 100}%`;
  const len = Math.max(40, left + m.ubx0 * cw - 6), wh = Math.round(.40 * H), dpr = Math.min(2, devicePixelRatio || 1), midY = top + ((m.cby0 + Math.min(m.cby1, .9)) / 2) * ch;
  c.wv.style.cssText = `left:0;top:${midY - wh / 2}px;width:${len}px;height:${wh}px`; c.wv.width = Math.round(len * dpr); c.wv.height = Math.round(wh * dpr);
  c.L = { W, H, left, len, wh, dpr, hidex: left + m.ubx1 * cw + 24 };
  c.drawn = '';
}
// gen changes on every load and unload: a result from an earlier one (other mode, or unloaded since) is ignored.
const fetchImg = (c, gen, src, set, key = 'gen', onErr) => { const im = new Image(); im.src = src; im.decode().then(() => { if (gen !== c[key]) return; set(im); c.drawn = ''; schedule(); }, () => { if (gen === c[key]) onErr?.(); }); }; // decode() keeps the large atlas off the main thread
const loadAtlas = (c, gen) => { if (!still() && !c.atlas) fetchImg(c, gen, `/scroll/rec/${c.key}-${c.mode}.webp`, (im) => { c.atlas = im; }); };
// The poster (a few KB) is fetched as soon as the section is within 2 viewports, right away and not in an idle slot: it is what replaces the card photo,
// and three cards that enter together must not be swapped one after another. Atlases come later (within 1.5 viewports, staggered, in idle time).
function loadPoster(c) {
  if (c.poster || c.pReq) return;
  c.pReq = true; c.pm = c.mode = mode(); const gen = c.pgen;
  fetchImg(c, gen, `/scroll/rec/${c.key}-poster-${c.pm}.webp`, (im) => { c.poster = im; c.pReq = false; c.a.classList.add('rec-ready'); }, 'pgen', () => { c.pReq = false; }); // the photo goes only now
}
function load(c) {
  c.loaded = true; c.mode = mode(); const gen = ++c.gen;
  loadPoster(c);
  if (!still()) setTimeout(() => gen === c.gen && loadAtlas(c, gen), 500 * cards.indexOf(c)); // staggered: each large atlas is uploaded to the GPU on its own
}
function unload(c) { c.gen++; c.loaded = false; c.atlas = null; c.drawn = ''; } // beyond 1.5 viewports the decoded atlas is released
function unloadPoster(c) { c.pgen++; c.pReq = false; c.poster = null; c.drawn = ''; c.a.classList.remove('rec-ready'); } // beyond 3 viewports the poster goes too
function drawObj(c, pos) {
  const sq = c.m.seq[c.mode], idx = Math.round(clamp(pos) * (sq.N - 1)), key = `${idx}:${c.atlas ? 1 : 0}:${c.poster ? 1 : 0}`;
  if (key === c.drawn) return; c.drawn = key;
  if (c.cv.width !== sq.fw) { c.cv.width = sq.fw; c.cv.height = sq.fh; }
  c.ctx.clearRect(0, 0, sq.fw, sq.fh);
  if (c.atlas) c.ctx.drawImage(c.atlas, (idx % sq.cols) * sq.fw, ((idx / sq.cols) | 0) * sq.fh, sq.fw, sq.fh, 0, 0, sq.fw, sq.fh);
  else if (c.poster) c.ctx.drawImage(c.poster, 0, 0, sq.fw, sq.fh);
}
function drawWave(c, reveal, op, tsec) {
  const L = c.L, ctx = c.wctx; ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0); ctx.clearRect(0, 0, L.len, L.wh);
  if (op <= .002 || reveal <= .002) return;
  const step = L.len < 140 ? 5 : 7, bw = step * .5, n = Math.floor(L.len / step), g = ctx.createLinearGradient(0, 0, L.len, 0);
  g.addColorStop(0, '#566D48'); g.addColorStop(.6, '#7C9A6A'); g.addColorStop(1, '#9DB88D');
  ctx.globalAlpha = op; ctx.shadowColor = 'rgba(86,109,72,.8)'; ctx.shadowBlur = 8;
  for (let j = 0; j < n; j++) {
    const t = (j + .5) / n; if (t > reveal) break;
    const env = Math.pow(Math.sin(Math.PI * t), .85), a1 = Math.abs(Math.sin(j * .83 + tsec * 7) * Math.cos(j * .31 + 1 + tsec * 3.1) + .35 * Math.sin(j * 2.1 + tsec * 5)) * .75 + .25;
    const hh = Math.max(3, L.wh * env * Math.min(1, a1)); ctx.fillStyle = (a1 > .8 && env > .5) ? '#9DB88D' : g;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(j * step + 1, (L.wh - hh) / 2, bw, hh, bw / 2); else ctx.rect(j * step + 1, (L.wh - hh) / 2, bw, hh); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
// Scroll progress: 0 when the card's top is at 95% of the viewport height, 1 at 45% (a travel of half the viewport).
const etarget = (c) => clamp((innerHeight * .95 - c.slot.getBoundingClientRect().top) / (innerHeight * .50));
let raf = 0, last = 0, act = performance.now(), freeze = null; // act: last scroll or hover; 4 s later the waveform clock and the loop stop
const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
function frame(now) {
  raf = 0; if (!cards.some((c) => c.inView)) { last = 0; return; }
  if (now - act > 4000) freeze ??= now; else freeze = null;
  const dt = last ? Math.min(.1, (now - last) / 1000) : .016; last = now; let busy = false;
  const tops = cards.map((c) => c.slot.getBoundingClientRect().top), row = Math.abs(tops[0] - tops[2]) < 20; // three across: the cards open one after another
  cards.forEach((c, i) => {
    if (!c.L || !c.inView) return;
    const et = still() ? 1 : etarget(c), hist = c.E;
    if (!hist.length || hist[hist.length - 1][1] !== et || now - hist[hist.length - 1][0] > 400) hist.push([now, et]);
    while (hist.length > 2 && hist[1][0] < now - 1000) hist.shift();
    const lagT = now - (row ? i * 150 : 0); let ecs = hist[0][1]; for (const q of hist) if (q[0] <= lagT) ecs = q[1];
    if (c.Es === null) c.Es = ecs; else c.Es += (ecs - c.Es) * (1 - Math.exp(-dt / .07));
    if (Math.abs(ecs - c.Es) < .0004) c.Es = ecs;
    if (Math.abs(et - c.Es) > .0004 || ecs !== et) busy = true;
    const h = c.h; // hover tween: reverses from the current value, never jumps
    if (h.on) { const u = now - h.t0 - h.delay; if (u <= 0) { h.cur = h.from; busy = true; } else if (u >= h.dur) { h.cur = h.to; h.on = false; } else { h.cur = h.from + (h.to - h.from) * h.ease(u / h.dur); busy = true; } }
    const Es = still() ? 1 : c.Es, g = still() ? 1 : easeScrub(clamp(Es / .5)), posS = still() ? 1 : clamp((Es - .55) / .45), pos = posS * (1 - h.cur);
    c.obj.style.transform = `translate3d(${-(1 - g) * c.L.hidex}px,0,0)`;
    c.obj.style.visibility = (!still() && g <= .001) ? 'hidden' : 'visible';
    drawObj(c, pos);
    c.seam.style.setProperty('--s', (.55 * clamp((posS - .5) / .5)).toFixed(3));
    let rv = 0, op = 0; // waveform: the scroll-driven part and the hover-run part
    if (!still()) {
      rv = clamp((Es - .26) / .3); op = clamp((Es - .26) / .06) * (1 - clamp((Es - .82) / .14));
      if (c.hw !== null) { const uu = (now - c.hw - 300) / 1450; if (uu >= 1) c.hw = null; else if (uu > 0) { const rh = easeWave(clamp(uu / .38)), oh = uu < .08 ? uu / .08 : uu < .7 ? 1 : 1 - (uu - .7) / .3; rv = Math.max(rv, rh); op = Math.max(op, oh); busy = true; } else busy = true; }
      if (op > .002 && freeze === null) busy = true;
    }
    drawWave(c, rv, op, (freeze ?? now) / 1000);
  });
  if (busy) schedule(); else last = 0;
}
function setHover(c, on) {
  const h = c.h, now = performance.now(); act = now;
  h.from = h.cur; h.to = on ? 1 : 0; h.t0 = now; h.on = true; h.ease = on ? easeOpen : easeGlide;
  h.delay = on ? 300 : 400; h.dur = (on ? 550 : 1250) * Math.abs(h.to - h.from) + 1;
  if (on && !still()) c.hw = now;
  schedule();
}
cards.forEach((c) => {
  const a = c.a, hot = (on) => { a.classList.toggle('rec-hot', on); if (!still()) setHover(c, on); };
  layout(c);
  a.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') hot(true); });
  a.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') hot(false); });
  a.addEventListener('focusin', () => { if (a.matches(':focus-visible')) hot(true); });
  a.addEventListener('focusout', () => hot(false));
  new IntersectionObserver((es) => { c.inView = es[es.length - 1].isIntersecting; if (c.inView) { act = performance.now(); schedule(); } }, { rootMargin: '20% 0px' }).observe(a);
  // Nothing is fetched until the card is within 2 viewports (poster) or 1.5 viewports (atlas); beyond 3 viewports both are released and fetched again (from cache) on return.
  new IntersectionObserver((es) => { if (es[es.length - 1].isIntersecting) loadPoster(c); }, { rootMargin: '200% 0px' }).observe(a);
  new IntersectionObserver((es) => { if (es[es.length - 1].isIntersecting && !c.loaded) idle(() => load(c)); }, { rootMargin: '150% 0px' }).observe(a);
  new IntersectionObserver((es) => { if (!es[es.length - 1].isIntersecting && (c.loaded || c.poster)) { unload(c); unloadPoster(c); } }, { rootMargin: '300% 0px' }).observe(a);
});
addEventListener('scroll', () => { act = performance.now(); schedule(); }, { passive: true });
const remode = () => { cards.forEach((c) => { layout(c); if ((c.loaded || c.poster) && mode() !== c.pm) { unload(c); unloadPoster(c); if (c.inView) load(c); else loadPoster(c); } }); schedule(); };
addEventListener('resize', remode);
addEventListener('pageshow', (e) => { if (e.persisted) remode(); });
SMALL.addEventListener('change', remode);
// Reduced motion changed: take effect at once (motion allowed again fetches the atlas, a still draws the open case).
REDUCED.addEventListener('change', () => { cards.forEach((c) => { c.drawn = ''; if (c.loaded) loadAtlas(c, c.gen); }); schedule(); });
document.fonts?.ready.then(() => { cards.forEach(layout); schedule(); });
syncMode();
schedule();
