import { clamp, REDUCED, still, syncMode } from './scroll-env.js';
import { films } from '../content/films.js';

const dialog = document.querySelector('#film-dialog');

function init(screen) {
  const videos = Array.from(screen.querySelectorAll('[data-film-preview]'));
  const reel = screen.closest('[data-film-reel]');
  let selected = 0;
  let near = false;
  let visible = false;
  let nearObserver;

  function updatePreviews() {
    const staticMode = still();
    const canPlay = visible && !document.hidden && !dialog?.open;
    videos.forEach((video, index) => {
      if (staticMode) {
        if (!video.hasAttribute('src')) return;
        video.pause();
        video.removeAttribute('data-playing');
        video.removeAttribute('src');
        video.load();
        return;
      }
      if (index === selected && (near || visible)) {
        if (!video.hasAttribute('src')) {
          video.preload = 'auto';
          video.defaultMuted = video.muted = true;
          video.src = video.dataset.src;
        }
        if (canPlay && video.paused) video.play().catch(() => {});
        if (canPlay) return;
      }
      video.pause();
    });
  }

  for (const video of videos) {
    video.addEventListener('playing', () => { video.dataset.playing = ''; });
  }

  function observeNear() {
    nearObserver?.disconnect();
    nearObserver = new IntersectionObserver(([entry]) => {
      near = entry.isIntersecting;
      updatePreviews();
    }, { rootMargin: `${Math.floor(innerHeight * 1.5)}px 0px` });
    nearObserver.observe(screen);
  }

  const viewportObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    updatePreviews();
  });
  viewportObserver.observe(screen);
  observeNear();
  addEventListener('resize', observeNear, { passive: true });
  REDUCED.addEventListener('change', updatePreviews);
  navigator.connection?.addEventListener('change', () => { syncMode(); updatePreviews(); });
  document.addEventListener('visibilitychange', updatePreviews);
  dialog?.addEventListener('toggle', updatePreviews);

  if (!reel) return;
  const stage = reel.querySelector('.film-stage');
  const names = reel.querySelector('[data-film-names]');
  const choices = Array.from(names.querySelectorAll('button'));
  const sectorLink = reel.querySelector('.film-sector-link');
  const watch = reel.querySelector('[data-film-open]');
  const length = watch.querySelector('.film-length-inline');
  let scrollStep = 0;
  let frame = 0;

  function select(index) {
    if (index === selected) return;
    choices[selected].removeAttribute('aria-current');
    choices[index].setAttribute('aria-current', 'true');
    const film = films[index];
    screen.style.setProperty('--film-index', index);
    sectorLink.href = `/enterprise/${film.slug}/`;
    sectorLink.querySelector('span').textContent = `${film.name} page`;
    watch.href = film.src;
    watch.dataset.filmOpen = film.slug;
    watch.setAttribute('aria-label', `Watch the ${film.name} film, ${film.length}`);
    length.textContent = film.length;
    selected = index;
    updatePreviews();
  }

  choices.forEach((button, index) => button.addEventListener('click', () => select(index)));
  names.addEventListener('keydown', (event) => {
    const index = choices.indexOf(event.target);
    if (index < 0) return;
    const key = event.key;
    let next;
    if (key === 'ArrowRight' || key === 'ArrowDown') next = (index + 1) % choices.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (index + choices.length - 1) % choices.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = choices.length - 1;
    else return;
    event.preventDefault();
    select(next);
    choices[next].focus({ preventScroll: true });
  });

  function updateScroll() {
    frame = 0;
    const style = getComputedStyle(stage);
    if (style.position !== 'sticky') return;
    const distance = reel.offsetHeight - stage.offsetHeight;
    const progress = clamp((parseFloat(style.top) - reel.getBoundingClientRect().top) / Math.max(1, distance));
    const index = Math.min(choices.length - 1, Math.floor(progress * choices.length));
    // A click or key press holds until the page crosses another scroll step.
    if (index === scrollStep) return;
    scrollStep = index;
    select(index);
  }

  const queueScroll = () => { if (!frame) frame = requestAnimationFrame(updateScroll); };
  reel.dataset.filmReady = '';
  addEventListener('scroll', queueScroll, { passive: true });
  addEventListener('resize', queueScroll, { passive: true });
  addEventListener('pageshow', queueScroll);
  REDUCED.addEventListener('change', queueScroll);
  queueScroll();
}

for (const screen of document.querySelectorAll('[data-film-screen]')) init(screen);
