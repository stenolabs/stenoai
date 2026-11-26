// Shared by the scroll players (frame sequences and record cards).
export const PHONE = matchMedia('(max-width: 767px)');
export const MAXPX = 12e6; // canvas pixels per element, well under the 16.7 MP iOS limit
// Flow layout: the footage sits in a box above the text. Otherwise the stage is pinned (tablets 800px tall and laptops 720px tall, mirrored in scroll.css),
// unless the text does not fit the pinned panel (enlarged text): checkFit then sets html[data-nofit] and the stage falls back to flow.
const FLOWQ = matchMedia('(max-width: 767px), (max-height: 719px), (max-width: 911px) and (max-height: 799px)');
const flowSubs = [];
export const FLOW = {
  get matches() { return FLOWQ.matches || document.documentElement.hasAttribute('data-nofit'); },
  addEventListener(_, fn) { flowSubs.push(fn); FLOWQ.addEventListener('change', fn); },
};
export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
export const clamp = (x) => Math.max(0, Math.min(1, x));
// Reduced motion and data saver: one settled still, no frame data, no scroll-driven motion.
export const still = () => REDUCED.matches || !!navigator.connection?.saveData;
// html[data-ss] = "on" (scroll-driven) or "still"; absent without JavaScript. The inline script in index.astro sets it
// before first paint, this keeps it right when the preference changes.
export const syncMode = () => { document.documentElement.dataset.ss = still() ? 'still' : 'on'; };
// Decode an image blob off the main thread where supported, with a clean Image fallback that always revokes its object URL.
export function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    im.src = url;
  });
}
// Nothing is fetched until the element is within 1.5 viewports (or custom margin), and not before the page has loaded and gone idle.
export const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
export function whenNear(el, fn, rootMargin = '150% 0px', onLeave) {
  let inside = false;
  const run = () => { if (inside) fn(); };
  const go = () => (document.readyState === 'complete' ? idle(run) : addEventListener('load', () => idle(run), { once: true }));
  const io = new IntersectionObserver((es) => {
    inside = es[es.length - 1].isIntersecting;
    if (inside) {
      if (!onLeave) io.disconnect();
      go();
    } else onLeave?.();
  }, { rootMargin });
  io.observe(el);
}

// Extra fit tests registered by other players: either a function () => boolean (page-wide) or { stage, test } for an ownFit stage.
export const fitTests = [];

// Pinned panels cut their text when it is taller than the screen. Measured with the pinned layout on; the answer decides flow or pinned.
// A stage marked data-own-fit (Stage ownFit) decides for itself: it gets data-nofit on the stage element and the rest of the page is not affected.
// Every other stage keeps the page-wide html[data-nofit].
export function checkFit() {
  const root = document.documentElement, was = root.hasAttribute('data-nofit');
  const own = [...document.querySelectorAll('.stage[data-own-fit]')], wasOwn = own.map((s) => s.hasAttribute('data-nofit'));
  root.removeAttribute('data-nofit');
  own.forEach((s) => s.removeAttribute('data-nofit'));
  let fits = true;
  if (root.dataset.ss === 'on' && !FLOWQ.matches) {
    const customStages = new Set(fitTests.filter((f) => typeof f !== 'function' && f.stage).map((f) => f.stage));
    for (const panel of document.querySelectorAll('.stage-panel')) {
      const stage = panel.closest('.stage');
      if (stage && customStages.has(stage)) continue;
      const t = panel.querySelector('.stage-text'), a = t?.firstElementChild, z = t?.lastElementChild, r = panel.getBoundingClientRect();
      if (!a || (a.getBoundingClientRect().top >= r.top && z.getBoundingClientRect().bottom <= r.bottom + 1)) continue;
      if (stage?.hasAttribute('data-own-fit')) stage.setAttribute('data-nofit', ''); else fits = false;
    }
    for (const f of fitTests) {
      if (typeof f === 'function') {
        if (fits && !f()) fits = false;
      } else if (f.stage?.hasAttribute('data-own-fit')) {
        if (!f.test()) f.stage.setAttribute('data-nofit', '');
      } else if (fits && !f.test()) {
        fits = false;
      }
    }
  }
  if (!fits) root.setAttribute('data-nofit', '');
  if (!fits !== was || own.some((s, i) => s.hasAttribute('data-nofit') !== wasOwn[i])) flowSubs.forEach((fn) => fn());
}
REDUCED.addEventListener('change', () => { syncMode(); checkFit(); });
addEventListener('resize', checkFit);
addEventListener('load', checkFit);
document.fonts?.ready.then(checkFit);
checkFit();
