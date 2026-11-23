// Light rooms (government & law enforcement use-cases): one dark still plus a lit edit of it with the same geometry, revealed window by window.
//   <div data-light-room data-cards=".sector-case" data-dark data-lit data-dark-phone data-lit-phone> + one <span class="lr-l"> per window (LightRoom.astro)
// Window k comes on when card k reaches the reading line (data-from x viewport height; cards in the same row are staggered by data-stagger px),
// over data-ramp px of scroll. The brightness is a pure function of the scroll position, followed with a short ease, so scrolling up turns the lights off again.
// The loop stops when settled. Reduced motion, data saver: the settled lit still only. Nothing is fetched before the room is within 1.5 viewports.
import { PHONE, REDUCED, clamp, still, syncMode, whenNear } from './scroll-env.js';

// Pinned stage (mirrored in scroll-rooms.css): a list of cards on the left, the room on the right, progress follows the stage's scroll length.
const PIN = matchMedia('(min-width: 1100px) and (min-height: 860px)');

const LATER = 0.6; // level a room keeps once the next card is active
const TAU = 65; // ms, same follow as scroll-seq.js (95% settled in about 200 ms)
const ease = (p) => p * p * (3 - 2 * p);

function init(room) {
  const wrap = room.closest('[data-light-wrap]') || room.parentElement;
  const cards = [...wrap.querySelectorAll(room.dataset.cards)];
  const lights = [...room.querySelectorAll('.lr-l')];
  const FROM = +room.dataset.from || 0.78, RAMP = +room.dataset.ramp || 170, STAGGER = +room.dataset.stagger || 40;
  const stage = room.closest('.cases-stage');
  const panel = stage?.querySelector('.cases-panel');
  let sTop = 0, sH = 1, pH = 1, tops = [], col = [], cur = lights.map(() => 0), target = cur.slice(), raf = 0, last = 0, ready = false, near = false, loadedDark = false, visible = false;

  function checkStageFit() {
    if (!stage || !panel || !cards.length) return;
    const list = cards[0].parentElement;
    cards.forEach((c) => { c.style.height = ''; c.style.transform = ''; });
    list.style.height = '';
    stage.removeAttribute('data-nofit');
    if (!PIN.matches || document.documentElement.dataset.ss !== 'on') return;
    const prev = cards.map((c) => c.classList.contains('is-active'));
    stage.classList.add('is-measuring');
    cards.forEach((c) => c.classList.remove('is-active'));
    const closed = cards.map((c) => c.getBoundingClientRect().height), open = [];
    for (let i = 0; i < cards.length; i++) {
      cards.forEach((c, j) => c.classList.toggle('is-active', i === j));
      open[i] = cards[i].getBoundingClientRect().height;
    }
    cards.forEach((c, i) => { c.classList.toggle('is-active', prev[i]); });
    const extras = open.map((h, i) => Math.max(0, h - closed[i]));
    const total = Math.ceil(closed.reduce((a, b) => a + b, 0) + Math.max(...extras));
    const listTop = list.getBoundingClientRect().top;
    const pBot = panel.getBoundingClientRect().bottom + 1;
    stage.classList.remove('is-measuring');
    if (listTop + total > pBot) {
      stage.setAttribute('data-nofit', '');
      return;
    }
    cards.forEach((c, i) => {
      c.style.height = closed[i] + 'px';
      c._extra = extras[i];
    });
    list.style.height = total + 'px';
    if (shown >= 0) cards.forEach((c, i) => { c.style.transform = i > shown ? `translateY(${cards[shown]._extra || 0}px)` : ''; });
  }

  function measure() {
    checkStageFit();
    const sy = scrollY;
    tops = cards.map((c) => c.getBoundingClientRect().top + sy);
    // column index inside the row (cards sharing a top), 0 in a single column
    col = tops.map((t, i) => { let n = 0; for (let j = 0; j < i; j++) if (Math.abs(tops[j] - t) < 4) n++; return n; });
    if (stage) {
      const q = stage.getBoundingClientRect();
      sTop = q.top + sy; sH = q.height;
      pH = panel?.offsetHeight || innerHeight;
    }
    const hdr = document.querySelector('.mission-header')?.getBoundingClientRect().bottom;
    if (hdr > 0) room.parentElement.style.setProperty('--hdr', `${Math.round(hdr)}px`);
  }
  const pinned = () => !!stage && PIN.matches && !stage.hasAttribute('data-nofit') && document.documentElement.dataset.ss === 'on';
  // Pinned: x runs 0..N over the stage (ends trimmed); card k is active while k <= x < k+1, door k is lit once x passes k (eased over .6 of a card).
  function pinX() { const p = clamp((scrollY - sTop) / Math.max(1, sH - pH)); return clamp((p - 0.04) / 0.92) * cards.length; }
  function want() {
    if (pinned()) { const x = pinX(); return lights.map((_, k) => ease(clamp((x - k) / 0.6)) * (1 - (1 - LATER) * ease(clamp((x - k - 1) / 0.6)))); } // the room at full level while its card is active, then it settles to LATER
    return lights.map((_, k) => {
      const c = Math.min(k, cards.length - 1), line = innerHeight * FROM - col[c] * STAGGER;
      return ease(clamp((line - (tops[c] - scrollY)) / RAMP));
    });
  }
  // One card open at a time, switching directly without waiting (CSS opens/closes in <= 0.22 s with transform only: 0 CLS).
  let shown = -1;
  function activate() {
    const isPin = pinned() && !still();
    const wantK = isPin ? Math.min(cards.length - 1, Math.floor(pinX())) : -1;
    if (wantK === shown) return;
    if (shown !== -1) cards[shown].classList.remove('is-active');
    shown = wantK;
    if (shown !== -1) cards[shown].classList.add('is-active');
    const shift = isPin && shown >= 0 ? cards[shown]._extra || 0 : 0;
    cards.forEach((c, i) => { c.style.transform = isPin && shown >= 0 && i > shown ? `translateY(${shift}px)` : ''; });
  }
  function paint() { activate(); lights.forEach((l, k) => { l.style.opacity = cur[k].toFixed(3); }); }
  function tick(now) {
    const dt = Math.min(now - last, 64); last = now;
    const f = 1 - Math.exp(-dt / TAU);
    let moving = false;
    cur = cur.map((v, k) => { const n = v + (target[k] - v) * f; if (Math.abs(target[k] - n) < 0.002) return target[k]; moving = true; return n; });
    paint();
    raf = moving ? requestAnimationFrame(tick) : 0; // settled: the loop stops
  }
  function onScroll() {
    if (!ready || !visible || still()) return;
    target = want();
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function settle() { measure(); cur = target = still() ? lights.map(() => 1) : want(); paint(); }
  function loadImages() {
    const d = PHONE.matches ? room.dataset.darkPhone : room.dataset.dark, l = PHONE.matches ? room.dataset.litPhone : room.dataset.lit;
    room.classList.add('is-near'); // the CSS now points the layers at the pictures
    const needDark = !still();
    if (needDark) loadedDark = true;
    const ims = (needDark ? [d, l] : [l]).map((u) => { const im = new Image(); im.src = u; return im.decode().catch(() => {}); });
    return Promise.all(ims).then(() => { ready = true; settle(); room.classList.add('is-ready'); });
  }

  whenNear(room, () => { near = true; loadImages(); });
  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible && ready) settle(); }, { rootMargin: '30% 0px' }).observe(wrap);
  addEventListener('scroll', onScroll, { passive: true });
  const remeasure = () => { if (ready) settle(); else measure(); };
  addEventListener('resize', remeasure, { passive: true });
  addEventListener('pageshow', (e) => { if (e.persisted) remeasure(); });
  PIN.addEventListener('change', remeasure);
  REDUCED.addEventListener('change', () => {
    if (!still() && near && !loadedDark) loadImages();
    else remeasure();
  });
  new ResizeObserver(remeasure).observe(document.documentElement);
  document.fonts?.ready.then(remeasure);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remeasure(); });
}

syncMode();
document.querySelectorAll('[data-light-room]').forEach(init);
