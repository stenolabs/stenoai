// Shared by the scroll players (frame sequences and record cards).
export const PHONE = matchMedia('(max-width: 767px)');
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
REDUCED.addEventListener('change', syncMode);
// Nothing is fetched until the element is within 1.5 viewports, and not before the page has loaded and gone idle.
export const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
export function whenNear(el, fn) {
  const go = () => (document.readyState === 'complete' ? idle(fn) : addEventListener('load', () => idle(fn), { once: true }));
  const io = new IntersectionObserver((es) => { if (es[es.length - 1].isIntersecting) { io.disconnect(); go(); } }, { rootMargin: '150% 0px' });
  io.observe(el);
}

// Pinned panels cut their text when it is taller than the screen. Measured with the pinned layout on; the answer decides flow or pinned.
export function checkFit() {
  const root = document.documentElement, was = root.hasAttribute('data-nofit');
  root.removeAttribute('data-nofit');
  let fits = true;
  if (root.dataset.ss === 'on' && !FLOWQ.matches) {
    for (const panel of document.querySelectorAll('.stage-panel')) {
      const t = panel.querySelector('.stage-text'), a = t?.firstElementChild, z = t?.lastElementChild, r = panel.getBoundingClientRect();
      if (a && (a.getBoundingClientRect().top < r.top || z.getBoundingClientRect().bottom > r.bottom + 1)) fits = false;
    }
  }
  if (!fits) root.setAttribute('data-nofit', '');
  if (!fits !== was) flowSubs.forEach((fn) => fn());
}
addEventListener('resize', checkFit);
addEventListener('load', checkFit);
document.fonts?.ready.then(checkFit);
checkFit();
