const html = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const phone = matchMedia('(max-width: 767px)');

const controls = [...document.querySelectorAll('[data-rm-toggle]')].map((button) => ({
  button,
  targets: button.getAttribute('aria-controls').split(/\s+/).map((id) => document.getElementById(id)),
})).filter(({ targets }) => targets.every(Boolean));

function syncControls() {
  for (const { button, targets } of controls) {
    const open = targets.every((target) => target.hasAttribute('data-rm-open'));
    const label = open ? 'Read less' : 'Read more';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', `${label}: ${button.dataset.rmToggle}`);
    button.firstElementChild.textContent = label;
  }
}

for (const { button, targets } of controls) {
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'false';
    for (const target of targets) target.toggleAttribute('data-rm-open', open);
    syncControls();
    // ResizeObservers in the scroll players remeasure the page after the fold.
    if (!open) {
      const { top, bottom } = button.getBoundingClientRect();
      if (top < 0 || bottom > innerHeight) button.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });
}
html.dataset.rmLive = '';

const panel = document.getElementById('rm-panel');
const cardsById = new Map();
let openCardFromHash;

function setUnavailable(button, unavailable) {
  button.setAttribute('aria-disabled', String(unavailable));
}

if (panel?.showModal) {
  const body = panel.querySelector('.rm-panel-body');
  const bar = panel.querySelector('.rm-panel-bar');
  const close = bar.querySelector('.rm-close');
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  bar.append(status);
  const panelSteps = [...bar.querySelectorAll('[data-rm-step]')];
  let current;
  let opener;
  let returnHash;
  let scrollPoint;
  let backdropPress = false;

  function show(card, fromHash = false) {
    const alreadyOpen = panel.open;
    if (!alreadyOpen) {
      if (fromHash) {
        card.element.scrollIntoView({ block: 'center', inline: 'start', behavior: 'instant' });
      }
      scrollPoint = { left: scrollX, top: scrollY, behavior: 'instant' };
      opener = card.button;
      returnHash = fromHash ? '' : location.hash;
    } else {
      current.button.setAttribute('aria-expanded', 'false');
    }

    const article = document.createElement('article');
    article.className = `rm-panel-article ${card.element.className.replace('rm-card', '').trim()}`;
    for (const child of card.element.children) {
      if (!child.matches('.rm-card-open, .rm-card-preview')) article.append(child.cloneNode(true));
    }
    article.querySelector('h3').id = 'rm-panel-title';
    for (const img of article.querySelectorAll('img')) {
      // A larger reader can use the existing responsive image candidates.
      img.loading = 'eager';
      img.sizes = '(max-width: 767px) calc(100vw - 40px), 608px';
    }
    body.className = `rm-panel-body ${card.row.element.className}`;
    body.replaceChildren(article);
    panel.scrollTop = 0;
    current = card;
    card.button.setAttribute('aria-expanded', 'true');
    for (const button of panelSteps) {
      const target = card.row.cards[card.index + Number(button.dataset.rmStep)];
      setUnavailable(button, !target);
      const direction = button.dataset.rmStep === '-1' ? 'Previous card' : 'Next card';
      button.setAttribute('aria-label', target ? `${direction}: ${target.button.getAttribute('aria-label')}` : direction);
    }
    if (!alreadyOpen) {
      html.classList.add('rm-lock');
      panel.showModal();
      close.focus({ preventScroll: true });
    }
    status.textContent = alreadyOpen
      ? `${card.button.getAttribute('aria-label')}, ${card.index + 1} of ${card.row.cards.length}`
      : '';
    if (!fromHash) history.replaceState(history.state, '', `#${card.element.id}`);
  }

  for (const element of document.querySelectorAll('[data-rm-row]')) {
    const nav = element.nextElementSibling;
    const counter = nav.querySelector('[data-rm-count]');
    const steps = [...nav.querySelectorAll('[data-rm-step]')];
    const row = { element, cards: [] };
    row.cards = [...element.querySelectorAll('[data-rm-card]')].map((element, index) => ({
      element,
      index,
      row,
      button: element.querySelector('.rm-card-open'),
    }));

    const start = (card) => card.element.offsetLeft - row.cards[0].element.offsetLeft;
    const active = () => row.cards.reduce((closest, card) => (
      Math.abs(start(card) - element.scrollLeft) < Math.abs(start(closest) - element.scrollLeft) ? card : closest
    ), row.cards[0]);
    const update = () => {
      if (!phone.matches) return;
      const { index } = active();
      const value = `${index + 1} of ${row.cards.length}`;
      if (counter.textContent !== value) counter.textContent = value;
      for (const button of steps) setUnavailable(button, !row.cards[index + Number(button.dataset.rmStep)]);
    };
    element.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(element);
    for (const button of steps) {
      button.addEventListener('click', () => {
        const target = row.cards[active().index + Number(button.dataset.rmStep)];
        if (target) element.scrollTo({ left: start(target), behavior: reduce.matches ? 'instant' : 'smooth' });
      });
    }
    for (const card of row.cards) {
      cardsById.set(card.element.id, card);
      card.button.addEventListener('click', () => show(card));
    }
  }

  for (const button of panelSteps) {
    button.addEventListener('click', () => {
      const target = current.row.cards[current.index + Number(button.dataset.rmStep)];
      if (target) show(target);
    });
  }
  close.addEventListener('click', () => panel.close());
  panel.addEventListener('pointerdown', (event) => { backdropPress = event.target === panel; });
  panel.addEventListener('click', (event) => {
    if (backdropPress && event.target === panel) panel.close();
    backdropPress = false;
  });
  panel.addEventListener('touchmove', (event) => {
    if (event.target === panel) event.preventDefault();
  }, { passive: false });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const tabbable = [...panel.querySelectorAll('button, a[href]')];
    const wrap = event.shiftKey ? tabbable[0] : tabbable.at(-1);
    if (document.activeElement === wrap) {
      event.preventDefault();
      (event.shiftKey ? tabbable.at(-1) : tabbable[0]).focus();
    }
  });
  panel.addEventListener('close', () => {
    const panelHash = `#${current.element.id}`;
    if (location.hash === panelHash) history.replaceState(history.state, '', returnHash || location.pathname + location.search);
    current.button.setAttribute('aria-expanded', 'false');
    current = null;
    backdropPress = false;
    body.replaceChildren();
    html.classList.remove('rm-lock');
    scrollTo(scrollPoint);
    opener.focus({ preventScroll: true });
  });

  openCardFromHash = (id) => {
    const card = cardsById.get(id);
    if (card) show(card, true);
    else if (panel.open) panel.close();
    return Boolean(card);
  };
  html.dataset.rmCards = '';
}

function openHash() {
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  if (openCardFromHash?.(id)) return;
  const target = document.getElementById(id);
  const fold = target?.closest('[data-rm-fold]');
  if (!fold) return;
  fold.setAttribute('data-rm-open', '');
  syncControls();
  target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

if (location.hash) openHash();
window.addEventListener('hashchange', openHash);
