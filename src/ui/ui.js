'use strict';
/* global Icons */
// Browser chrome logic. Plain DOM, keyed updates, no framework.
(() => {
  const api = window.coffee;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  const state = {
    tabs: [],
    activeId: null,
    bookmarks: [],
    settings: {},
    overlay: null,
  };
  const active = () => state.tabs.find((t) => t.id === state.activeId) || null;

  // ---------- static icons ----------
  $('brand').innerHTML = Icons.logo;
  $('new-tab').innerHTML = Icons.plus;
  $('settings-btn').innerHTML = Icons.settings;
  $('back').innerHTML = Icons.back;
  $('forward').innerHTML = Icons.forward;
  $('reload').innerHTML = Icons.reload;
  $('omni-star').innerHTML = Icons.star;
  $('downloads-btn').insertAdjacentHTML('afterbegin', Icons.download);
  $('menu-btn').innerHTML = Icons.menu;
  $('win-min').innerHTML = Icons.minimize;
  $('win-max').innerHTML = Icons.maximize;
  $('win-close').innerHTML = Icons.winClose;
  document.querySelector('.find-icon').innerHTML = Icons.search;
  $('find-prev').innerHTML = Icons.arrowUp;
  $('find-next').innerHTML = Icons.arrowDown;
  $('find-close').innerHTML = Icons.close;

  const rectOf = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  // ---------- overlay dismissal ----------
  // Clicking anywhere in the chrome closes an open popup. A button that opened
  // the current popup acts as a toggle instead of immediately reopening it.
  let suppressClick = null;
  document.addEventListener('mousedown', (e) => {
    const type = state.overlay;
    if (!type || type === 'suggest' || type === 'tooltip') return;
    const toggle = e.target.closest('[data-toggle]');
    if (toggle && toggle.dataset.toggle === type) suppressClick = toggle;
    api.send('overlay:close');
  }, true);
  document.addEventListener('click', (e) => {
    if (suppressClick && suppressClick.contains(e.target)) {
      e.stopPropagation();
      e.preventDefault();
    }
    suppressClick = null;
  }, true);
  api.on('overlay', (type) => { state.overlay = type; });

  // ---------- window ----------
  $('win-min').onclick = () => api.send('win:minimize');
  $('win-max').onclick = () => api.send('win:maximize');
  $('win-close').onclick = () => api.send('win:close');
  function applyWindow(w) {
    document.body.classList.toggle('fullscreen', !!w.fullscreen);
    document.body.classList.toggle('blurred', !w.focused);
    $('win-max').innerHTML = w.maximized ? Icons.restore : Icons.maximize;
    $('win-max').setAttribute('aria-label', w.maximized ? 'Restore' : 'Maximize');
  }
  api.on('window', applyWindow);

  // =====================================================================
  // Tabs
  // =====================================================================
  const tabsEl = $('tabs');
  const highlight = $('tab-highlight');
  const tabNodes = new Map(); // id -> element
  const SPINNER = '<svg class="spinner" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14"/></svg>';

  function letterFor(t) {
    try { return new URL(t.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase() || '•'; } catch { return (t.title || '•').charAt(0).toUpperCase(); }
  }

  function iconMarkup(t) {
    if (t.newtab) return `<span class="glyph">${Icons.sparkle}</span>`;
    if (t.internal) return `<span class="glyph">${Icons.settings}</span>`;
    if (t.favicon) return `<img src="${encodeURI(t.favicon)}" alt="" draggable="false">`;
    if (t.url) return `<span class="letter">${letterFor(t)}</span>`;
    return `<span class="glyph">${Icons.globe}</span>`;
  }

  function createTabNode(t) {
    const n = el('div', 'tab entering');
    n.dataset.id = t.id;
    n.innerHTML = `<div class="tab-icon"></div>${SPINNER}<span class="audio"></span><button class="tab-close" tabindex="-1" aria-label="Close tab">${Icons.close}</button>`;
    n.addEventListener('animationend', () => n.classList.remove('entering'), { once: true });
    n._icon = n.firstChild;
    n._audio = n.querySelector('.audio');
    n._iconKey = '';
    bindTab(n);
    return n;
  }

  function updateTabNode(n, t) {
    const key = t.newtab ? 'new' : t.internal ? 'int' : t.favicon || `l:${t.url}`;
    if (key !== n._iconKey) {
      n._iconKey = key;
      n._icon.innerHTML = iconMarkup(t);
      const img = n._icon.querySelector('img');
      if (img) img.onerror = () => { n._icon.innerHTML = `<span class="letter">${letterFor(t)}</span>`; };
    }
    n.classList.toggle('active', t.id === state.activeId);
    n.classList.toggle('loading', t.loading && !t.newtab);
    n.classList.toggle('sleeping', t.sleeping && t.id !== state.activeId);
    n.classList.toggle('audible', t.audible && !t.muted);
    n.classList.toggle('muted', t.muted);
    if (t.audible || t.muted) n._audio.innerHTML = t.muted ? Icons.mute : Icons.volume;
    n._title = t.title;
  }

  /** FLIP: animate siblings from their old position to the new one. */
  function flip(mutate, skip) {
    const before = new Map();
    for (const n of tabsEl.querySelectorAll('.tab:not(.leaving)')) if (n !== skip) before.set(n, n.offsetTop);
    mutate();
    for (const [n, top] of before) {
      if (!n.isConnected || n.classList.contains('leaving')) continue;
      const dy = top - n.offsetTop;
      if (!dy) continue;
      n.style.transition = 'none';
      n.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        n.style.transition = 'transform .3s var(--spring), background .15s';
        n.style.transform = '';
      });
    }
  }

  function renderTabs() {
    if (drag && drag.active) { pendingRender = true; return; }
    const ids = new Set(state.tabs.map((t) => t.id));
    flip(() => {
      for (const [id, n] of tabNodes) {
        if (ids.has(id)) continue;
        tabNodes.delete(id);
        // Leave the flow immediately so neighbours slide into place.
        n.classList.add('leaving');
        n.style.position = 'absolute';
        n.style.top = `${n.offsetTop}px`;
        setTimeout(() => n.remove(), 220);
      }
      let prev = highlight;
      for (const t of state.tabs) {
        let n = tabNodes.get(t.id);
        if (!n) { n = createTabNode(t); tabNodes.set(t.id, n); }
        updateTabNode(n, t);
        if (prev.nextSibling !== n) prev.after(n);
        prev = n;
      }
      // Leaving nodes are absolutely positioned; keep them after live tabs.
      for (const n of tabsEl.querySelectorAll('.tab.leaving')) tabsEl.appendChild(n);
    });
    moveHighlight();
  }

  function moveHighlight() {
    const n = tabNodes.get(state.activeId);
    if (!n) { highlight.classList.remove('on'); return; }
    const y = n.offsetTop;
    if (!highlight.classList.contains('on')) {
      highlight.style.transition = 'none';
      highlight.style.transform = `translateY(${y}px)`;
      void highlight.offsetTop;
      highlight.style.transition = '';
      highlight.classList.add('on');
    } else {
      highlight.style.transform = `translateY(${y}px)`;
    }
    if (!drag || !drag.active) n.scrollIntoView({ block: 'nearest' });
  }

  // ---------- tab interactions: click, middle-click, menu, drag ----------
  let drag = null;
  let pendingRender = false;

  function bindTab(n) {
    const id = () => Number(n.dataset.id);
    n.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tab-close')) return;
      if (e.button === 0) {
        if (id() !== state.activeId) {
          state.activeId = id();
          for (const [tid, node] of tabNodes) node.classList.toggle('active', tid === state.activeId);
          moveHighlight();
          api.send('tab:activate', { id: id() });
        }
        drag = { node: n, id: id(), startY: e.clientY, grab: e.clientY - n.getBoundingClientRect().top, active: false, pointer: e.pointerId };
      }
    });
    n.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); api.send('tab:close', { id: id() }); } });
    n.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    n.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); api.send('tab:close', { id: id() }); });
    n._audio.addEventListener('pointerdown', (e) => { e.stopPropagation(); api.send('tab:mute', { id: id() }); });
    n.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      hideTip();
      api.send('tab:menu', { id: id(), x: e.clientX, y: e.clientY });
    });
    n.addEventListener('mouseenter', () => showTip(n));
    n.addEventListener('mouseleave', hideTip);
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < 5) return;
      drag.active = true;
      hideTip();
      drag.node.classList.add('dragging');
      tabsEl.classList.add('drag-active');
      try { drag.node.setPointerCapture(drag.pointer); } catch { /* ignore */ }
    }
    const live = [...tabsEl.querySelectorAll('.tab:not(.leaving)')];
    const base = tabsEl.getBoundingClientRect().top;
    const slot = 44;
    const from = live.indexOf(drag.node);
    const to = Math.max(0, Math.min(live.length - 1, Math.round((e.clientY - drag.grab - base) / slot)));
    if (to !== from) {
      flip(() => {
        const others = live.filter((x) => x !== drag.node);
        if (to >= others.length) others[others.length - 1].after(drag.node);
        else others[to].before(drag.node);
      }, drag.node);
    }
    const natural = base + drag.node.offsetTop;
    drag.node.style.transform = `translateY(${e.clientY - drag.grab - natural}px)`;
    moveHighlight();
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    const live = [...tabsEl.querySelectorAll('.tab:not(.leaving)')];
    const index = live.indexOf(d.node);
    d.node.style.transition = 'transform .28s var(--spring)';
    d.node.style.transform = '';
    d.node.classList.remove('dragging');
    tabsEl.classList.remove('drag-active');
    setTimeout(() => { d.node.style.transition = ''; }, 300);
    // Reflect locally right away; main confirms with a fresh snapshot.
    const t = state.tabs.find((x) => x.id === d.id);
    state.tabs = state.tabs.filter((x) => x.id !== d.id);
    state.tabs.splice(index, 0, t);
    api.send('tab:move', { id: d.id, index });
    if (pendingRender) { pendingRender = false; renderTabs(); }
    moveHighlight();
  });

  $('new-tab').onclick = () => api.send('tab:new');
  $('update-btn').onclick = () => api.send('update:install');

  // Right-click empty sidebar space: new tab / reopen recently closed tabs.
  $('sidebar').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab')) return;
    e.preventDefault();
    hideTip();
    api.send('sidebar:menu', { x: e.clientX, y: e.clientY });
  });
  $('settings-btn').onclick = () => api.send('settings:open');

  // ---------- tooltips (rendered in the overlay so they float over the page) ----------
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '12px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  let tipTimer = null;
  let tipWarm = 0;
  function showTip(n) {
    clearTimeout(tipTimer);
    if (drag && drag.active) return;
    const delay = Date.now() - tipWarm < 600 ? 0 : 450;
    tipTimer = setTimeout(() => {
      if (!n.matches(':hover') || !n.isConnected) return;
      const text = (n._title || 'New Tab').slice(0, 80);
      const r = n.getBoundingClientRect();
      api.send('tooltip:show', { text, x: r.right + 10, y: r.top + r.height / 2, width: Math.min(measure.measureText(text).width, 420) });
      tipWarm = Date.now();
    }, delay);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (state.overlay === 'tooltip') { tipWarm = Date.now(); api.send('tooltip:hide'); }
  }

  // =====================================================================
  // Navigation buttons
  // =====================================================================
  $('back').onclick = () => api.send('nav:back');
  $('forward').onclick = () => api.send('nav:forward');
  $('reload').onclick = (e) => {
    const t = active();
    if (t && t.loading && !t.newtab) api.send('nav:stop');
    else {
      $('reload').classList.remove('spin-once');
      void $('reload').offsetWidth;
      $('reload').classList.add('spin-once');
      api.send('nav:reload', { hard: e.shiftKey || e.ctrlKey });
    }
  };
  for (const id of ['back', 'forward']) {
    $(id).addEventListener('auxclick', (e) => { if (e.button === 1) api.send(id === 'back' ? 'nav:back' : 'nav:forward'); });
  }

  // =====================================================================
  // Omnibox
  // =====================================================================
  const omni = $('omnibox');
  const input = $('omni-input');
  const display = $('omni-display');
  const shield = $('omni-shield');
  const star = $('omni-star');
  const zoomPill = $('omni-zoom');
  let editing = false;
  let hoverUrl = '';
  let suggestions = [];
  let selected = 0;
  let suggestSeq = 0;
  let justFocused = false;

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const INTERNAL_NAMES = { settings: 'Settings' };
  function prettyUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'coffee:') {
        return `<span class="host">Coffee</span> · ${escapeHtml(INTERNAL_NAMES[u.hostname] || u.hostname)}`;
      }
      if (!/^https?:$/.test(u.protocol)) return `<span class="host">${escapeHtml(url)}</span>`;
      const host = u.host.replace(/^www\./, '');
      let rest = decodeURI(u.pathname + u.search + u.hash);
      if (rest === '/') rest = '';
      return `<span class="host">${escapeHtml(host)}</span>${escapeHtml(rest)}`;
    } catch {
      return escapeHtml(url);
    }
  }

  function renderOmni() {
    const t = active();
    const url = t ? t.url : '';
    if (!editing && document.activeElement !== input) input.value = url;
    const showing = hoverUrl || url;
    display.classList.toggle('hovering', !!hoverUrl);
    display.innerHTML = showing ? prettyUrl(showing) : '';
    omni.classList.toggle('show-display', !!showing && document.activeElement !== input);

    // Shield / security indicator
    const web = /^https?:/.test(url);
    const insecure = url.startsWith('http:') && !/^http:\/\/(localhost|127\.)/.test(url);
    shield.hidden = !web;
    shield.classList.toggle('insecure', insecure);
    shield.classList.toggle('active', !insecure && !!state.settings.adblock && t && t.blocked > 0);
    const blocked = state.settings.adblock && t ? t.blocked : 0;
    shield.innerHTML = (insecure ? Icons.unlock : state.settings.adblock ? Icons.shield : Icons.shieldOff)
      + `<span class="count${blocked ? ' on' : ''}">${blocked > 99 ? '99+' : blocked || ''}</span>`;
    shield.title = insecure ? 'Connection is not secure' : '';

    // Bookmark star
    const bookmarked = web && state.bookmarks.some((b) => b.url === url);
    star.hidden = !web;
    star.classList.toggle('on', bookmarked);
    star.innerHTML = bookmarked ? Icons.starFilled : Icons.star;

    zoomPill.hidden = !(t && t.zoom);
    if (t && t.zoom) zoomPill.textContent = `${t.zoom}%`;

    // Nav buttons
    $('back').disabled = !(t && t.canGoBack);
    $('forward').disabled = !(t && t.canGoForward);
    const loading = t && t.loading && !t.newtab;
    $('reload').innerHTML = loading ? Icons.stop : Icons.reload;
    $('reload').setAttribute('aria-label', loading ? 'Stop' : 'Reload');
  }

  function sendOmniRect() { api.send('omni:rect', { rect: rectOf(omni) }); }

  function showSuggestions() {
    api.send('suggest:show', { rect: rectOf(omni), items: suggestions, selected });
  }

  async function updateSuggestions() {
    const q = input.value;
    const seq = ++suggestSeq;
    if (!q.trim()) { suggestions = []; api.send('overlay:close', { type: 'suggest' }); return; }
    const items = await api.invoke('suggest', { q });
    if (seq !== suggestSeq || document.activeElement !== input) return;
    suggestions = items || [];
    selected = 0;
    showSuggestions();
  }

  input.addEventListener('focus', () => {
    omni.classList.add('focused');
    omni.classList.remove('show-display');
    input.select();
    justFocused = true;
    sendOmniRect();
  });
  input.addEventListener('mouseup', (e) => {
    // First click selects everything (like every major browser).
    if (justFocused) { e.preventDefault(); input.select(); }
    justFocused = false;
  });
  input.addEventListener('blur', () => {
    omni.classList.remove('focused');
    setTimeout(() => {
      if (document.activeElement === input) return;
      editing = false;
      suggestions = [];
      api.send('overlay:close', { type: 'suggest' });
      renderOmni();
    }, 140);
  });
  input.addEventListener('input', () => {
    if (!editing) api.send('urlbar:typing');
    editing = true;
    justFocused = false;
    updateSuggestions();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      showSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = suggestions[selected];
      const value = input.value.trim();
      if (!value) return;
      const target = pick && editing ? pick.url : value;
      api.send('nav:go', { url: target, newTab: e.altKey });
      editing = false;
      suggestions = [];
      api.send('overlay:close', { type: 'suggest' });
      input.blur();
      api.send('page:focus');
    } else if (e.key === 'Escape') {
      if (suggestions.length && state.overlay === 'suggest') {
        suggestions = [];
        api.send('overlay:close', { type: 'suggest' });
      } else {
        editing = false;
        input.value = active() ? active().url : '';
        input.blur();
        api.send('page:focus');
      }
    }
  });

  api.on('focus-urlbar', () => {
    if (!editing) input.value = active() ? active().url : '';
    input.focus();
    input.select();
  });
  api.on('urlbar:blur', () => { editing = false; input.blur(); });
  api.on('page-focus', () => { if (document.activeElement === input) input.blur(); });
  api.on('hover-url', (url) => {
    hoverUrl = url || '';
    if (document.activeElement !== input) renderOmni();
  });

  shield.onclick = () => api.send('shield:menu', { rect: rectOf(shield) });
  shield.dataset.toggle = 'menu';
  star.onclick = () => {
    if (!star.classList.contains('on')) { star.classList.remove('pop'); void star.offsetWidth; star.classList.add('pop'); }
    api.send('bookmark:star', { rect: rectOf(star) });
  };
  star.dataset.toggle = 'bookmark';
  zoomPill.onclick = () => api.send('zoom:reset');

  // ---------- find in page ----------
  const find = $('find');
  const findInput = $('find-input');
  const findCount = $('find-count');
  function openFind() {
    find.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) api.send('find', { text: findInput.value });
  }
  function closeFind() {
    if (find.hidden) return;
    find.hidden = true;
    findCount.textContent = '';
    api.send('find:stop');
    api.send('page:focus');
  }
  findInput.addEventListener('input', () => api.send('find', { text: findInput.value }));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); api.send('find', { text: findInput.value, forward: !e.shiftKey, next: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('find-next').onclick = () => api.send('find', { text: findInput.value, forward: true, next: true });
  $('find-prev').onclick = () => api.send('find', { text: findInput.value, forward: false, next: true });
  $('find-close').onclick = closeFind;
  api.on('find:open', openFind);
  api.on('find:close', () => { find.hidden = true; findCount.textContent = ''; });
  api.on('find:next', () => { if (!find.hidden) $('find-next').click(); else openFind(); });
  api.on('find:prev', () => { if (!find.hidden) $('find-prev').click(); else openFind(); });
  api.on('find:result', (r) => {
    findCount.textContent = findInput.value ? `${r.matches ? r.active : 0}/${r.matches}` : '';
    find.classList.toggle('none', !!findInput.value && r.matches === 0);
  });

  // =====================================================================
  // Downloads & menu
  // =====================================================================
  const dlBtn = $('downloads-btn');
  dlBtn.dataset.toggle = 'downloads';
  dlBtn.onclick = () => api.send('downloads:toggle', { rect: rectOf(dlBtn) });
  const ring = dlBtn.querySelector('.ring circle');
  function applyDownloads(d) {
    dlBtn.classList.toggle('active', d.active > 0);
    dlBtn.classList.toggle('indeterminate', d.active > 0 && d.progress < 0);
    ring.style.strokeDashoffset = d.active > 0 && d.progress >= 0 ? String(94.25 * (1 - d.progress)) : '94.25';
  }
  api.on('downloads', applyDownloads);
  api.on('downloads:started', () => {
    dlBtn.classList.remove('bump');
    void dlBtn.offsetWidth;
    dlBtn.classList.add('bump');
  });

  const menuBtn = $('menu-btn');
  menuBtn.dataset.toggle = 'menu';
  menuBtn.onclick = () => {
    const r = menuBtn.getBoundingClientRect();
    api.send('app:menu', { x: r.right, y: r.bottom + 4 });
  };

  // =====================================================================
  // Bookmarks bar
  // =====================================================================
  const bmBar = $('bookmarks-bar');
  function renderBookmarks() {
    bmBar.textContent = '';
    if (!state.bookmarks.length) return; // the bar hides itself when empty
    const frag = document.createDocumentFragment();
    state.bookmarks.forEach((b, i) => {
      const n = el('button', 'bm');
      n.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
      const icon = b.favicon ? `<img src="${encodeURI(b.favicon)}" alt="" draggable="false">` : `<span class="bm-glyph">${Icons.globe}</span>`;
      n.innerHTML = `${icon}<span></span>`;
      n.lastChild.textContent = b.title || b.url;
      n.title = `${b.title}\n${b.url}`;
      const img = n.querySelector('img');
      if (img) img.onerror = () => { img.outerHTML = `<span class="bm-glyph">${Icons.globe}</span>`; };
      n.onclick = (e) => api.send('bookmark:open', { id: b.id, background: e.ctrlKey, newTab: e.shiftKey });
      n.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('bookmark:open', { id: b.id, background: true }); });
      n.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); api.send('bookmark:menu', { id: b.id, x: e.clientX, y: e.clientY }); });
      frag.appendChild(n);
    });
    bmBar.appendChild(frag);
  }

  // =====================================================================
  // Loading bar
  // =====================================================================
  const bar = $('loading-bar');
  let barTab = null;
  let barLoading = false;
  function renderLoading() {
    const t = active();
    const loading = !!(t && t.loading && !t.newtab);
    const sameTab = barTab === (t && t.id);
    barTab = t && t.id;
    if (loading && (!barLoading || !sameTab)) {
      bar.classList.remove('done', 'loading');
      void bar.offsetWidth; // restart the animation
      bar.classList.add('loading');
    } else if (!loading && barLoading) {
      bar.classList.remove('loading');
      if (sameTab) bar.classList.add('done');
    }
    barLoading = loading;
  }

  // =====================================================================
  // Settings & wiring
  // =====================================================================
  function applySettings(s) {
    state.settings = s;
    document.body.classList.toggle('no-bookmarks', !s.bookmarksBarShown);
    const up = s.update || {};
    $('update-btn').hidden = up.state !== 'ready';
    if (up.version) $('update-btn').title = `Coffee ${up.version} is ready — restart to install`;
    input.placeholder = `Search ${s.searchEngineName || ''} or enter address`.replace('  ', ' ');
    renderOmni();
    sendOmniRect();
  }

  let lastActiveId = null;
  api.on('tabs', (snap) => {
    state.tabs = snap.tabs;
    state.activeId = snap.activeId;
    if (snap.activeId !== lastActiveId) {
      lastActiveId = snap.activeId;
      editing = false;
      hoverUrl = '';
      // Switching tabs always shows the new tab's address, even mid-focus.
      const t = active();
      input.value = t ? t.url : '';
    }
    renderTabs();
    renderOmni();
    renderLoading();
  });
  api.on('bookmarks', (b) => { state.bookmarks = b; renderBookmarks(); renderOmni(); });
  api.on('settings', applySettings);

  window.addEventListener('resize', sendOmniRect);

  api.invoke('init').then((d) => {
    state.bookmarks = d.bookmarks;
    applySettings(d.settings);
    applyWindow(d.window);
    applyDownloads(d.downloads);
    renderBookmarks();
    state.tabs = d.snapshot.tabs;
    state.activeId = d.snapshot.activeId;
    lastActiveId = state.activeId;
    renderTabs();
    renderOmni();
  });
})();
