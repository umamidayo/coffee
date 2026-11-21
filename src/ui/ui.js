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
    popout: false, // a video popped out from a page no tab shows is playing
    paneId: null, // split view: the tab shown beside the active one
    pair: null,   // split view: [left id, right id]
    bookmarks: [],
    settings: {},
    overlay: null,
  };
  const active = () => state.tabs.find((t) => t.id === state.activeId) || null;

  // ---------- static icons ----------
  $('new-tab').innerHTML = `${Icons.plus}<span>New tab</span>`;
  $('new-tab-top').innerHTML = Icons.plus;
  $('settings-btn').innerHTML = `${Icons.settings}<span>Settings</span>`;
  $('back').innerHTML = Icons.back;
  $('forward').innerHTML = Icons.forward;
  $('reload').innerHTML = Icons.reload;
  $('home').innerHTML = Icons.home;
  $('bookmarks-btn').innerHTML = Icons.bookmarks;
  $('omni-star').innerHTML = Icons.star;
  $('omni-pip').innerHTML = Icons.pip;
  $('omni-private').innerHTML = `${Icons.mask}<span>Private</span>`;
  $('omni-private').title = "Private window: history isn't saved, and cookies and site data are deleted when you close all private windows";
  $('downloads-btn').insertAdjacentHTML('afterbegin', Icons.download);
  $('menu-btn').innerHTML = Icons.menu;
  $('ext-btn').innerHTML = Icons.puzzle;
  $('win-min').innerHTML = Icons.minimize;
  $('win-max').innerHTML = Icons.maximize;
  $('win-close').innerHTML = Icons.winClose;
  document.querySelector('.find-icon').innerHTML = Icons.search;
  $('find-prev').innerHTML = Icons.arrowUp;
  $('find-next').innerHTML = Icons.arrowDown;
  $('find-close').innerHTML = Icons.close;

  // Hover hints for the buttons, with their shortcuts.
  const tips = {
    back: 'Back (Alt+Left) · right-click for history · middle-click opens in a new tab',
    forward: 'Forward (Alt+Right) · right-click for history · middle-click opens in a new tab',
    home: 'Home (Alt+Home) · Ctrl-click opens a new tab',
    'bookmarks-btn': 'Bookmarks',
    'ext-btn': 'Extensions',
    'downloads-btn': 'Downloads (Ctrl+J)',
    'menu-btn': 'Menu',
    'new-tab': 'New tab (Ctrl+T)',
    'new-tab-top': 'New tab (Ctrl+T)',
    'settings-btn': 'Settings (Ctrl+,)',
    'win-min': 'Minimize',
    'win-close': 'Close',
    'find-prev': 'Previous match (Shift+Enter)',
    'find-next': 'Next match (Enter)',
    'find-close': 'Close (Esc)',
  };
  for (const [id, text] of Object.entries(tips)) $(id).title = text;

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
    if (toggle && toggle.dataset.toggle === type
      && (!toggle.dataset.toggleId || toggle.dataset.toggleId === openFolderId)) suppressClick = toggle;
    api.send('overlay:close');
  }, true);
  document.addEventListener('click', (e) => {
    if (suppressClick && suppressClick.contains(e.target)) {
      e.stopPropagation();
      e.preventDefault();
    }
    suppressClick = null;
  }, true);
  api.on('overlay', (type) => {
    state.overlay = type;
    // While a menu or panel is open, the title bar and other drag areas stop
    // dragging the window: Windows takes clicks there before this page sees
    // them, so a click on the title bar couldn't close the menu otherwise.
    document.body.classList.toggle('popup-open', !!type && !['suggest', 'sidebar', 'splitdrag'].includes(type));
  });

  // ---------- window ----------
  $('win-min').onclick = () => api.send('win:minimize');
  $('win-max').onclick = () => api.send('win:maximize');
  $('win-close').onclick = () => api.send('win:close');
  function applyWindow(w) {
    document.body.classList.toggle('fullscreen', !!w.fullscreen);
    document.body.classList.toggle('private-window', !!w.private);
    document.body.classList.toggle('blurred', !w.focused);
    $('win-max').innerHTML = w.maximized ? Icons.restore : Icons.maximize;
    $('win-max').setAttribute('aria-label', w.maximized ? 'Restore' : 'Maximize');
    $('win-max').title = w.maximized ? 'Restore' : 'Maximize';
  }
  api.on('window', applyWindow);

  // =====================================================================
  // Tabs: a side strip (icons) or a top strip (icons + titles)
  // =====================================================================
  // Resting on a tab shows its hover card (title, address, page preview).
  const sideStrip = new window.TabStrip($('tabs'), { api, orientation: 'vertical', titles: false });
  const topStrip = new window.TabStrip($('htabs'), { api, orientation: 'horizontal', titles: true });
  let tabLayout = 'vertical';
  const strip = () => (tabLayout === 'horizontal' ? topStrip : sideStrip);

  function renderTabs() {
    // Only the visible strip is kept up to date.
    strip().render({ tabs: state.tabs, activeId: state.activeId, paneId: state.paneId, pair: state.pair });
  }

  function applyLayout(s) {
    const layout = s.tabLayout === 'horizontal' ? 'horizontal' : 'vertical';
    document.body.classList.toggle('tabs-top', layout === 'horizontal');
    document.body.classList.toggle('tabs-side', layout === 'vertical');
    document.body.classList.toggle('compact', layout === 'vertical' && !!s.compactSidebar);
    const titles = s.tabTitles !== false;
    document.body.classList.toggle('tab-titles', titles);
    topStrip.setTitles(titles);
    sideStrip.setTitles(titles);
    if (layout !== tabLayout) {
      tabLayout = layout;
      renderTabs();
      requestAnimationFrame(() => strip().relayout());
    }
  }

  $('new-tab').onclick = () => api.send('tab:new');
  $('new-tab-top').onclick = () => api.send('tab:new');
  $('update-btn').onclick = () => api.send('update:install');

  // Double-click empty space in the side bar: new tab (Edge and Firefox vertical tabs).
  $('tabs-scroll').addEventListener('dblclick', (e) => {
    if (e.target.closest('.tab, button')) return;
    api.send('tab:new');
  });

  // Right-click empty tab space: new tab / reopen recently closed tabs.
  for (const area of [$('sidebar'), $('tabstrip')]) {
    area.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tab')) return;
      e.preventDefault();
      api.send('sidebar:menu', { x: e.clientX, y: e.clientY });
    });
  }
  $('settings-btn').onclick = () => api.send('settings:open');

  // =====================================================================
  // Navigation buttons
  // =====================================================================
  $('back').onclick = () => api.send('nav:back');
  $('forward').onclick = () => api.send('nav:forward');
  $('home').onclick = (e) => api.send('nav:home', { newTab: e.ctrlKey || e.shiftKey });
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
  // Middle-click (or Ctrl-click) Back / Forward / Reload: that page in a new tab (Chrome).
  for (const id of ['back', 'forward', 'reload']) {
    const cmd = { back: 'nav:back', forward: 'nav:forward', reload: 'nav:reload' }[id];
    $(id).addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    $(id).addEventListener('auxclick', (e) => { if (e.button === 1) api.send(cmd, { newTab: true }); });
  }
  for (const id of ['back', 'forward']) {
    $(id).addEventListener('click', (e) => {
      if (!e.ctrlKey) return;
      e.stopImmediatePropagation();
      api.send(id === 'back' ? 'nav:back' : 'nav:forward', { newTab: true });
    }, true);
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
  let suggestions = [];
  let selected = 0;
  let suggestSeq = 0;
  let justFocused = false;

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const INTERNAL_NAMES = { settings: 'Settings', welcome: 'Welcome', history: 'History', 'whats-new': "What's new" };
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
    // (A hovered link's address shows in the status bubble over the page, not here.)
    display.innerHTML = url ? prettyUrl(url) : '';
    omni.classList.toggle('show-display', !!url && document.activeElement !== input);

    // Private tab indicator
    const priv = !!(t && t.private);
    document.body.classList.toggle('private-active', priv);
    $('omni-private').hidden = !priv;

    // Shield / security indicator
    const web = /^https?:/.test(url);
    const insecure = url.startsWith('http:') && !/^http:\/\/(localhost|127\.)/.test(url);
    shield.hidden = !web;
    shield.classList.toggle('insecure', insecure);
    shield.classList.toggle('active', !insecure && !!state.settings.adblock && t && t.blocked > 0);
    const blocked = state.settings.adblock && t ? t.blocked : 0;
    shield.innerHTML = (insecure ? Icons.unlock : state.settings.adblock ? Icons.shield : Icons.shieldOff)
      + `<span class="count${blocked ? ' on' : ''}">${blocked > 99 ? '99+' : blocked || ''}</span>`;
    shield.title = insecure ? 'Connection is not secure'
      : !state.settings.adblock ? 'Ad blocking is off'
        : `Ad blocking: ${blocked} blocked on this page · click for options`;

    // Bookmark star
    const bookmarked = web && state.bookmarks.some((b) => b.url === url);
    star.hidden = !web;
    star.classList.toggle('on', bookmarked);
    star.innerHTML = bookmarked ? Icons.starFilled : Icons.star;
    star.title = bookmarked ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';

    zoomPill.hidden = !(t && t.zoom);
    if (t && t.zoom) { zoomPill.textContent = `${t.zoom}%`; zoomPill.title = `Zoom ${t.zoom}% · click to reset (Ctrl+0)`; }

    // Pop-out video: offered while the page plays media, and kept (lit) while
    // a video popped out from a page you've left is still playing.
    const pip = $('omni-pip');
    const media = !!(t && t.media);
    const closes = !!(t && t.pip) || (state.popout && !media);
    pip.hidden = !media && !state.popout;
    pip.classList.toggle('on', !!(t && t.pip) || state.popout);
    pip.title = closes ? 'Close pop-out video (Alt+P)' : 'Pop out video (Alt+P)';

    // Nav buttons
    $('back').disabled = !(t && t.canGoBack);
    $('forward').disabled = !(t && t.canGoForward);
    const loading = t && t.loading && !t.newtab;
    $('reload').innerHTML = loading ? Icons.stop : Icons.reload;
    $('reload').setAttribute('aria-label', loading ? 'Stop' : 'Reload');
    $('reload').title = loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R) · Shift-click to bypass the cache';
  }

  function sendOmniRect() { api.send('omni:rect', { rect: rectOf(omni) }); }

  function showSuggestions() {
    api.send('suggest:show', { rect: rectOf(omni), items: suggestions, selected });
  }

  async function updateSuggestions(allowInline = true) {
    const q = input.value;
    const seq = ++suggestSeq;
    if (!q.trim()) { suggestions = []; api.send('overlay:close', { type: 'suggest' }); return; }
    const items = await api.invoke('suggest', { q, inline: allowInline });
    if (seq !== suggestSeq || document.activeElement !== input) return;
    suggestions = items || [];
    selected = 0;
    // Inline autocomplete: "goo" becomes "goo|gle.com" with the added part
    // selected, so Enter opens it and typing simply continues over it.
    const first = suggestions[0];
    if (allowInline && first && first.inline && input.value === q && input.selectionStart === q.length
      && first.inline.length > q.length && first.inline.toLowerCase().startsWith(q.toLowerCase())) {
      input.value = q + first.inline.slice(q.length);
      input.setSelectionRange(q.length, input.value.length);
    }
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
  input.addEventListener('input', (e) => {
    if (!editing) api.send('urlbar:typing');
    editing = true;
    justFocused = false;
    // Backspace/Delete removes the completion and must not bring it back.
    const deleting = typeof e.inputType === 'string' && e.inputType.startsWith('delete');
    updateSuggestions(!deleting);
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
      if (pick && editing && pick.tab && !e.altKey && !e.ctrlKey) {
        api.send('tab:switch', { id: pick.tab });
      } else {
        // Ctrl+Enter: "coffee" goes to www.coffee.com (Chrome and Firefox).
        const word = e.ctrlKey && /^[a-z0-9-]+$/i.test(value) ? `www.${value}.com` : null;
        const target = word || (pick && editing ? pick.url : value);
        api.send('nav:go', { url: target, newTab: e.altKey });
      }
      editing = false;
      suggestions = [];
      api.send('overlay:close', { type: 'suggest' });
      input.blur();
      api.send('page:focus');
    } else if (e.key === 'Delete' && e.shiftKey && suggestions[selected] && suggestions[selected].kind === 'history') {
      // Shift+Delete forgets the highlighted page from history (Chrome).
      e.preventDefault();
      api.send('history:delete', { urls: [suggestions[selected].url] });
      setTimeout(() => updateSuggestions(false), 60);
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

  shield.onclick = () => api.send('shield:menu', { rect: rectOf(shield) });
  shield.dataset.toggle = 'menu';
  star.onclick = () => {
    if (!star.classList.contains('on')) { star.classList.remove('pop'); void star.offsetWidth; star.classList.add('pop'); }
    api.send('bookmark:star', { rect: rectOf(star) });
  };
  star.dataset.toggle = 'bookmark';
  zoomPill.onclick = () => api.send('zoom:reset');
  $('omni-pip').onclick = () => api.send('pip:toggle');
  api.on('popout', (on) => { state.popout = !!on; renderOmni(); });

  // A tab dragged here from another window: the frame lights up, and a
  // placeholder in the tab strip follows the pointer to where it would land.
  let incomingIdx = null;
  api.on('drag:incoming', (t) => {
    document.body.classList.toggle('drop-target', !!t);
    incomingIdx = null;
    if (t) strip().showIncoming(t);
    else strip().hideIncoming();
  });
  api.on('drag:over', (p) => {
    const i = strip().incomingAt(p.x, p.y);
    if (i !== null && i !== incomingIdx) { incomingIdx = i; api.send('tab:drop-index', { index: i }); }
  });

  // Back / Forward: right-click lists the pages to go back or forward to.
  for (const [id, dir] of [['back', -1], ['forward', 1]]) {
    $(id).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = $(id).getBoundingClientRect();
      api.send('nav:history-menu', { dir, x: r.left, y: r.bottom + 4 });
    });
  }

  // ---------- split view: active-half bars and the divider ----------
  const split = $('split');
  const divider = $('split-divider');
  let splitGeo = null;
  const place = (node, x, width, top, height) => {
    node.style.left = `${x}px`;
    node.style.width = `${width}px`;
    node.style.top = `${top}px`;
    if (height !== undefined) node.style.height = `${height}px`;
  };
  api.on('split', (g) => {
    splitGeo = g;
    split.hidden = !g;
    if (!g) return;
    place($('split-bar-left'), g.left.x, g.left.width, g.top);
    place($('split-bar-right'), g.right.x, g.right.width, g.top);
    $('split-bar-left').classList.toggle('on', g.active === 'left');
    $('split-bar-right').classList.toggle('on', g.active === 'right');
    place(divider, g.gap.x, g.gap.width, g.top);
  });
  // Dragging the divider resizes the halves. The pages sit above this
  // document, so main also lays a transparent overlay over them that keeps
  // reporting the pointer; whichever of the two sees it sends the ratio.
  let splitRaf = 0;
  const ratioAt = (clientX) => {
    const g = splitGeo;
    const half = g.gap.width / 2;
    return (clientX - g.page.x - half) / Math.max(1, g.page.width - g.gap.width);
  };
  let lastPress = 0;
  divider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !splitGeo) return;
    e.preventDefault();
    // A double press puts the divider back in the middle. (Not 'dblclick':
    // the drag overlay covers the divider between the two clicks.)
    const now = Date.now();
    if (now - lastPress < 380) { lastPress = 0; api.send('split:resize', { ratio: 0.5, done: true }); return; }
    lastPress = now;
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    api.send('split:drag');
  });
  divider.addEventListener('pointermove', (e) => {
    if (!divider.classList.contains('dragging') || !splitGeo) return;
    const ratio = ratioAt(e.clientX);
    cancelAnimationFrame(splitRaf);
    splitRaf = requestAnimationFrame(() => api.send('split:resize', { ratio }));
  });
  const endDrag = (e) => {
    if (!divider.classList.contains('dragging')) return;
    divider.classList.remove('dragging');
    cancelAnimationFrame(splitRaf);
    api.send('split:resize', { ratio: splitGeo ? ratioAt(e.clientX) : 0.5, done: true });
  };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('lostpointercapture', () => divider.classList.remove('dragging'));

  // ---------- find in page ----------
  const find = $('find');
  const findInput = $('find-input');
  const findCount = $('find-count');
  function openFind(p) {
    find.hidden = false;
    if (p && p.text) findInput.value = p.text;
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

  // =====================================================================
  // Extensions (only when turned on in Settings)
  // =====================================================================
  const extBox = $('ext-actions');
  const bmBtn = $('bookmarks-btn');
  bmBtn.dataset.toggle = 'bmfolder';
  bmBtn.dataset.toggleId = 'root';
  bmBtn.onclick = () => { openFolderId = 'root'; api.send('bmbutton:open', { rect: rectOf(bmBtn) }); };
  const extBtn = $('ext-btn');
  extBtn.dataset.toggle = 'extensions';
  extBtn.onclick = () => api.send('ext:panel', { rect: rectOf(extBtn) });
  let extOn = false;
  let extState = null;
  let extRaf = 0;
  async function refreshExtensions() {
    if (!extOn) return;
    try { extState = await api.ext.getState(); } catch { extState = null; }
    renderExtensions();
  }
  function renderExtensions() {
    cancelAnimationFrame(extRaf);
    extRaf = requestAnimationFrame(() => {
      const t = active();
      const tabId = t && t.wcId > 0 ? t.wcId : (extState && extState.activeTabId) || -1;
      const actions = (extState && extState.actions) || [];
      extBox.hidden = !extOn || !actions.length;
      extBox.textContent = '';
      for (const a of actions.slice(0, 8)) {
        const tabInfo = (a.tabs && a.tabs[tabId]) || {};
        const info = { ...a, ...tabInfo };
        const b = el('button', 'ext-action');
        b.title = info.title || a.title || '';
        const qs = new URLSearchParams({ tabId: String(tabId), partition: 'persist:web' });
        if (info.iconModified) qs.set('t', info.iconModified);
        const img = new Image();
        img.alt = '';
        img.draggable = false;
        img.src = `crx://extension-icon/${a.id}/32/2?${qs}`;
        img.onerror = () => { img.replaceWith(el('span', 'letter', (b.title || '?').charAt(0).toUpperCase())); };
        b.appendChild(img);
        if (info.text) {
          const badge = el('span', 'badge');
          badge.textContent = info.text;
          if (info.color) badge.style.background = info.color;
          b.appendChild(badge);
        }
        const fire = (e) => {
          if (e.type === 'contextmenu') e.preventDefault();
          const r = rectOf(b);
          api.send('overlay:close');
          api.ext.activate({ eventType: e.type, extensionId: a.id, tabId, alignment: 'bottom left', anchorRect: { x: r.x, y: r.y, width: r.width, height: r.height } });
        };
        b.addEventListener('click', fire);
        b.addEventListener('contextmenu', fire);
        extBox.appendChild(b);
      }
    });
  }
  function applyExtensions(on) {
    extBtn.hidden = !on;
    if (on === extOn) return;
    extOn = on;
    if (on) {
      api.ext.observe().catch(() => {});
      api.ext.onUpdate(refreshExtensions);
      refreshExtensions();
    } else {
      extBox.hidden = true;
    }
  }
  api.on('ext:changed', refreshExtensions);

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
  let bmSeen = new Set();   // ids already shown: only new items animate in
  let openFolderId = null;  // folder whose dropdown is open (for toggling)
  const BM_MIME = 'application/x-coffee-bookmark';

  function renderBookmarks() {
    bmBar.textContent = '';
    const items = state.bookmarks.filter((b) => (b.parent || null) === null);
    if (!items.length) { bmSeen = new Set(); return; } // the bar hides itself when empty
    const frag = document.createDocumentFragment();
    let fresh = 0;
    for (const b of items) {
      const folder = b.type === 'folder';
      const n = el('button', folder ? 'bm bm-folder' : 'bm');
      n.dataset.id = b.id;
      n.draggable = true;
      if (!bmSeen.has(b.id)) n.style.animationDelay = `${Math.min(fresh++, 12) * 18}ms`;
      else n.style.animation = 'none';
      let icon;
      if (folder) icon = `<span class="bm-glyph bm-folder-ico">${Icons.folder}</span>`;
      else if (b.favicon) icon = `<img src="${encodeURI(b.favicon)}" alt="" draggable="false">`;
      else icon = `<span class="bm-glyph">${Icons.globe}</span>`;
      n.innerHTML = `${icon}<span></span>`;
      n.lastChild.textContent = b.title || b.url;
      n.title = folder ? b.title : `${b.title}\n${b.url}`;
      const img = n.querySelector('img');
      if (img) img.onerror = () => { img.outerHTML = `<span class="bm-glyph">${Icons.globe}</span>`; };
      if (folder) {
        n.dataset.toggle = 'bmfolder';
        n.dataset.toggleId = b.id;
        n.onclick = () => { openFolderId = b.id; api.send('bmfolder:open', { id: b.id, rect: rectOf(n) }); };
      } else {
        n.onclick = (e) => api.send('bookmark:open', { id: b.id, background: e.ctrlKey, newTab: e.shiftKey });
        n.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('bookmark:open', { id: b.id, background: true }); });
      }
      n.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); api.send('bookmark:menu', { id: b.id, x: e.clientX, y: e.clientY }); });
      frag.appendChild(n);
    }
    bmSeen = new Set(items.map((b) => b.id));
    bmBar.appendChild(frag);
  }

  // Right-click empty bar space: new folder, etc.
  bmBar.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.bm')) return;
    e.preventDefault();
    api.send('bmbar:menu', { x: e.clientX, y: e.clientY });
  });

  // ---- drag & drop: reorder on the bar, or drop onto a folder to file it ----
  let dragId = null;
  const clearDrop = () => { for (const n of bmBar.querySelectorAll('.drop-into, .drop-before, .drop-after')) n.classList.remove('drop-into', 'drop-before', 'drop-after'); };

  /** Where would a drop at clientX land relative to item n? */
  function dropZone(n, clientX) {
    const r = n.getBoundingClientRect();
    const f = (clientX - r.left) / r.width;
    if (n.classList.contains('bm-folder') && n.dataset.id !== dragId && f > 0.25 && f < 0.75) return 'into';
    return f < 0.5 ? 'before' : 'after';
  }

  bmBar.addEventListener('dragstart', (e) => {
    const n = e.target.closest('.bm');
    if (!n) return;
    dragId = n.dataset.id;
    e.dataTransfer.setData(BM_MIME, dragId);
    e.dataTransfer.effectAllowed = 'move';
    n.classList.add('dragging');
    if (state.overlay) api.send('overlay:close');
  });
  bmBar.addEventListener('dragend', () => {
    dragId = null;
    clearDrop();
    for (const n of bmBar.querySelectorAll('.dragging')) n.classList.remove('dragging');
  });
  bmBar.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const n = e.target.closest('.bm');
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDrop();
    if (n && n.dataset.id !== dragId) n.classList.add(`drop-${dropZone(n, e.clientX)}`);
  });
  bmBar.addEventListener('dragleave', (e) => { if (!bmBar.contains(e.relatedTarget)) clearDrop(); });
  bmBar.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = dragId;
    clearDrop();
    if (!id) return;
    const n = e.target.closest('.bm');
    const others = [...bmBar.querySelectorAll('.bm')].filter((x) => x.dataset.id !== id);
    if (!n || n.dataset.id === id) {
      // Dropped on empty bar space: move to the end of the bar.
      if (!n) api.send('bookmark:move', { id, parent: null, index: others.length });
      return;
    }
    const zone = dropZone(n, e.clientX);
    if (zone === 'into') {
      api.send('bookmark:move', { id, parent: n.dataset.id });
    } else {
      const index = others.indexOf(n) + (zone === 'after' ? 1 : 0);
      api.send('bookmark:move', { id, parent: null, index });
    }
  });

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
    applyLayout(s);
    $('home').hidden = !s.showHome;
    $('bookmarks-btn').hidden = !s.bookmarksButton;
    applyExtensions(!!s.extensions);
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
    state.paneId = snap.paneId || null;
    state.pair = snap.pair || null;
    if (snap.activeId !== lastActiveId) {
      lastActiveId = snap.activeId;
      editing = false;
      // Switching tabs always shows the new tab's address, even mid-focus.
      const t = active();
      input.value = t ? t.url : '';
    }
    renderTabs();
    renderOmni();
    renderLoading();
    if (extOn) renderExtensions();
  });
  api.on('bookmarks', (b) => { state.bookmarks = b; renderBookmarks(); renderOmni(); });
  api.on('settings', applySettings);

  let relayoutRaf = 0;
  window.addEventListener('resize', () => {
    sendOmniRect();
    cancelAnimationFrame(relayoutRaf);
    relayoutRaf = requestAnimationFrame(() => strip().relayout());
  });

  api.invoke('init').then((d) => {
    state.bookmarks = d.bookmarks;
    state.popout = !!d.popout;
    applySettings(d.settings);
    applyWindow(d.window);
    applyDownloads(d.downloads);
    renderBookmarks();
    state.tabs = d.snapshot.tabs;
    state.activeId = d.snapshot.activeId;
    state.paneId = d.snapshot.paneId || null;
    state.pair = d.snapshot.pair || null;
    lastActiveId = state.activeId;
    renderTabs();
    renderOmni();
  });
})();
