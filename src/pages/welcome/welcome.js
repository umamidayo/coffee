'use strict';
// First-run setup. Every choice is applied immediately through the normal
// settings path, so the browser around the page changes as you pick.
(() => {
  const api = window.coffee;
  const $ = (id) => document.getElementById(id);
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const steps = [...document.querySelectorAll('.step')];
  const LAST = steps.length - 1;
  let step = 0;
  let s = null;

  const set = (key, value) => api.send('settings:set', { key, value });

  // ---- navigation -------------------------------------------------------
  $('dots').innerHTML = steps.map(() => '<i></i>').join('');
  const dots = [...$('dots').children];

  function go(n) {
    step = Math.max(0, Math.min(LAST, n));
    steps.forEach((el, i) => {
      el.classList.toggle('on', i === step);
      el.classList.toggle('past', i < step);
    });
    dots.forEach((d, i) => { d.classList.toggle('on', i === step); d.classList.toggle('done', i < step); });
    // The first and last steps have their own big button.
    document.body.classList.toggle('edge', step === 0 || step === LAST);
    $('back').disabled = step === 0;
    $('skip').hidden = step === LAST;
    const focus = steps[step].querySelector('.on, .btn.big, button');
    if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 250);
  }

  const finish = () => api.send('welcome:done');
  $('next').onclick = () => go(step + 1);
  $('back').onclick = () => go(step - 1);
  $('skip').onclick = finish;
  $('finish').onclick = finish;
  for (const b of document.querySelectorAll('[data-next]')) b.onclick = () => go(step + 1);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.closest('input')) { e.preventDefault(); if (step === LAST) finish(); else go(step + 1); }
    else if (e.key === 'ArrowRight' && step < LAST && step > 0) go(step + 1);
    else if (e.key === 'ArrowLeft' && step > 0) go(step - 1);
  });

  // ---- step 1: theme ----------------------------------------------------
  function preview(p) {
    return `<div class="preview" style="background:${p.bg}">
      <div class="pv-side"><i style="background:${p.accent}"></i><i style="background:${p.text}"></i><i style="background:${p.text}"></i></div>
      <div class="pv-main">
        <div class="pv-top"><div class="pv-omni" style="background:${p.text}"></div></div>
        <div class="pv-page" style="background:${p.surface}">
          <div class="pv-line" style="background:${p.text}; width:70%"></div>
          <div class="pv-line short" style="background:${p.text}"></div>
        </div>
      </div>
      <div class="pv-dot" style="background:${p.accent}"></div>
    </div>`;
  }
  function renderThemes() {
    const wrap = $('themes');
    wrap.textContent = '';
    for (const p of s.presets) {
      const b = document.createElement('button');
      b.className = `theme${s.theme.preset === p.id ? ' on' : ''}`;
      b.innerHTML = `${preview(p)}<div class="label">${p.name}</div>`;
      b.onclick = () => {
        s.theme = { preset: p.id, custom: s.theme.custom };
        set('theme', s.theme);
        for (const x of wrap.children) x.classList.toggle('on', x === b);
      };
      wrap.appendChild(b);
    }
  }

  // ---- step 2: tabs -----------------------------------------------------
  const layoutOf = () => (s.tabLayout === 'horizontal' ? 'top' : s.compactSidebar ? 'compact' : 'side');
  function renderLayouts() {
    const current = layoutOf();
    for (const b of document.querySelectorAll('.layout')) b.classList.toggle('on', b.dataset.layout === current);
    // Titles only matter for top tabs and the compact panel.
    $('titlesRow').classList.toggle('off', current === 'side');
    $('tabTitles').checked = s.tabTitles !== false;
  }
  for (const b of document.querySelectorAll('.layout')) {
    b.onclick = () => {
      const v = b.dataset.layout;
      s.tabLayout = v === 'top' ? 'horizontal' : 'vertical';
      s.compactSidebar = v === 'compact';
      set('tabLayout', s.tabLayout);
      set('compactSidebar', s.compactSidebar);
      renderLayouts();
    };
  }
  $('tabTitles').onchange = (e) => { s.tabTitles = e.target.checked; set('tabTitles', s.tabTitles); };

  // ---- step 3: search engine --------------------------------------------
  function renderEngines() {
    const wrap = $('engines');
    wrap.textContent = '';
    for (const e of s.engines) {
      const b = document.createElement('button');
      b.className = `engine${s.searchEngine === e.id ? ' on' : ''}`;
      b.innerHTML = `<span></span>${CHECK}`;
      b.firstChild.textContent = e.name;
      b.onclick = () => {
        s.searchEngine = e.id;
        set('searchEngine', e.id);
        for (const x of wrap.children) x.classList.toggle('on', x === b);
      };
      wrap.appendChild(b);
    }
  }

  // ---- step 4: extras ---------------------------------------------------
  for (const key of ['adblock', 'bookmarksBar', 'newtabShortcuts']) {
    $(key).onchange = (e) => set(key, e.target.checked);
  }

  api.invoke('settings:get').then((data) => {
    s = data;
    renderThemes();
    renderLayouts();
    renderEngines();
    $('adblock').checked = !!s.adblock;
    $('bookmarksBar').checked = !!s.bookmarksBar;
    $('newtabShortcuts').checked = s.newtabShortcuts !== false;
    go(0);
  });
})();
