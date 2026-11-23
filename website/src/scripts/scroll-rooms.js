// Light rooms (government use-cases): one dark still plus a lit edit of it with the same geometry, revealed window by window.
//   <div data-light-room data-cards=".sector-case" data-dark data-lit data-dark-phone data-lit-phone> + one <span class="lr-l"> per window (LightRoom.astro)
// Window k comes on when card k reaches the reading line (data-from x viewport height; cards in the same row are staggered by data-stagger px),
// over data-ramp px of scroll. The brightness is a pure function of the scroll position, followed with a short ease, so scrolling up turns the lights off again.
// The loop stops when settled. Reduced motion, data saver: the settled lit still only. Nothing is fetched before the room is within 1.5 viewports.
import { PHONE, clamp, still, syncMode, whenNear } from './scroll-env.js';

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
  let sTop = 0, sH = 1, tops = [], col = [], cur = lights.map(() => 0), target = cur.slice(), raf = 0, last = 0, ready = false, visible = false;

  function measure() {
    const sy = scrollY;
    tops = cards.map((c) => c.getBoundingClientRect().top + sy);
    // column index inside the row (cards sharing a top), 0 in a single column
    col = tops.map((t, i) => { let n = 0; for (let j = 0; j < i; j++) if (Math.abs(tops[j] - t) < 4) n++; return n; });
    if (stage) { const q = stage.getBoundingClientRect(); sTop = q.top + sy; sH = q.height; }
    const hdr = document.querySelector('.mission-header')?.getBoundingClientRect().bottom;
    if (hdr > 0) room.parentElement.style.setProperty('--hdr', `${Math.round(hdr)}px`);
  }
  const pinned = () => !!stage && PIN.matches && document.documentElement.dataset.ss === 'on';
  // Pinned: x runs 0..N over the stage (ends trimmed); card k is active while k <= x < k+1, door k is lit once x passes k (eased over .6 of a card).
  function pinX() { const p = clamp((scrollY - sTop) / (sH - innerHeight)); return clamp((p - 0.04) / 0.92) * cards.length; }
  function want() {
    if (pinned()) { const x = pinX(); return lights.map((_, k) => ease(clamp((x - k) / 0.6)) * (1 - (1 - LATER) * ease(clamp((x - k - 1) / 0.6)))); } // the room at full level while its card is active, then it settles to LATER
    return lights.map((_, k) => {
      const c = Math.min(k, cards.length - 1), line = innerHeight * FROM - col[c] * STAGGER;
      return ease(clamp((line - (tops[c] - scrollY)) / RAMP));
    });
  }
  // One card open at a time, and never two half-faded: the open one closes first (rows slide back), then the next opens (the CSS delays match the 440 ms).
  let shown = -1, wantK = -1, timer = 0;
  function activate() {
    wantK = pinned() && !still() ? Math.min(cards.length - 1, Math.floor(pinX())) : -1;
    if (timer || wantK === shown) return; // a switch is in flight: when it ends it opens the latest wantK
    if (shown !== -1) {
      cards[shown].classList.remove('is-active'); shown = -1;
      timer = setTimeout(() => { timer = 0; activate(); }, 440);
      return;
    }
    shown = wantK; if (shown !== -1) cards[shown].classList.add('is-active');
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

  whenNear(room, () => {
    const d = PHONE.matches ? room.dataset.darkPhone : room.dataset.dark, l = PHONE.matches ? room.dataset.litPhone : room.dataset.lit;
    room.classList.add('is-near'); // the CSS now points the layers at the pictures
    const ims = (still() ? [l] : [d, l]).map((u) => { const im = new Image(); im.src = u; return im.decode().catch(() => {}); });
    Promise.all(ims).then(() => { ready = true; settle(); room.classList.add('is-ready'); });
  });
  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible && ready) settle(); }, { rootMargin: '30% 0px' }).observe(wrap);
  addEventListener('scroll', onScroll, { passive: true });
  const remeasure = () => { if (ready) settle(); };
  addEventListener('resize', remeasure, { passive: true });
  PIN.addEventListener('change', remeasure);
  new ResizeObserver(remeasure).observe(document.documentElement);
  document.fonts?.ready.then(remeasure);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remeasure(); });
}

syncMode();
document.querySelectorAll('[data-light-room]').forEach(init);
