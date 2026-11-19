'use strict';
(() => {
  const api = window.coffee;
  const $ = (id) => document.getElementById(id);
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let s = null;

  const set = (key, value) => api.send('settings:set', { key, value });

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('on'), 1800);
  }

  // =====================================================================
  // Navigation: category icons, scroll spy, deep links (#extensions)
  // =====================================================================
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const NAV_ICONS = {
    palette: svg('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.6-.8 1.6-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a4.5 4.5 0 0 0 4.5-4.5C20.5 6.7 16.7 3.5 12 3.5z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="7.5" r="1" fill="currentColor"/><circle cx="14.5" cy="7.5" r="1" fill="currentColor"/>'),
    tabs: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9.5h17M9 5v4.5"/>'),
    home: svg('<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V19h12V9.5"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    shield: svg('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/>'),
    bolt: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
    download: svg('<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/>'),
    import: svg('<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M4 12h11"/><path d="M11 8l4 4-4 4"/>'),
    globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z"/>'),
    puzzle: svg('<path d="M9 4.5a2 2 0 0 1 4 0V6h3.5a1.5 1.5 0 0 1 1.5 1.5V11h-1.5a2 2 0 0 0 0 4H18v3.5a1.5 1.5 0 0 1-1.5 1.5H13v-1.5a2 2 0 0 0-4 0V20H5.5A1.5 1.5 0 0 1 4 18.5V15h1.5a2 2 0 0 0 0-4H4V7.5A1.5 1.5 0 0 1 5.5 6H9z"/>'),
    info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>'),
  };
  const links = [...document.querySelectorAll('#navLinks a')];
  for (const a of links) a.insertAdjacentHTML('afterbegin', NAV_ICONS[a.dataset.i] || '');
  const sections = [...document.querySelectorAll('main section')];

  function highlight(id) {
    for (const a of links) a.classList.toggle('on', a.getAttribute('href') === `#${id}`);
  }
  // The section nearest the top of the viewport is the current one.
  let spyRaf = 0;
  function spy() {
    cancelAnimationFrame(spyRaf);
    spyRaf = requestAnimationFrame(() => {
      const visible = sections.filter((x) => !x.hidden);
      let current = visible[0];
      for (const sec of visible) if (sec.getBoundingClientRect().top <= 120) current = sec;
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = visible[visible.length - 1];
      if (current) highlight(current.id);
    });
  }
  window.addEventListener('scroll', spy, { passive: true });
  for (const a of links) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = $(a.getAttribute('href').slice(1));
      if (!target) return;
      history.replaceState(null, '', a.getAttribute('href'));
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      highlight(target.id);
    });
  }
  function jumpToHash() {
    const id = location.hash.slice(1);
    const target = id && $(id);
    if (target) { target.scrollIntoView({ block: 'start' }); highlight(id); } else spy();
  }
  window.addEventListener('hashchange', jumpToHash);

  // =====================================================================
  // Search: show only matching rows (and sections whose topic matches)
  // =====================================================================
  const search = $('search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const sec of sections) {
      const topic = `${sec.querySelector('h2').textContent} ${sec.dataset.keywords || ''}`.toLowerCase();
      const topicHit = !!q && topic.includes(q);
      const rows = [...sec.querySelectorAll('.row')];
      let rowHit = false;
      for (const r of rows) {
        const hit = !q || topicHit || r.textContent.toLowerCase().includes(q);
        r.classList.toggle('filtered', !hit);
        r.style.display = hit ? '' : 'none';
        if (hit) rowHit = true;
      }
      // Sections without rows (none) or with the theme grid count as topic-only.
      const show = !q || topicHit || rowHit;
      sec.hidden = !show;
      if (show) any = true;
      const link = links.find((a) => a.getAttribute('href') === `#${sec.id}`);
      if (link) link.classList.toggle('dim', !show);
    }
    $('noResults').hidden = any;
    $('noResults').querySelector('span').textContent = search.value.trim();
    if (q) window.scrollTo({ top: 0 });
    spy();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement !== search)) {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
  });

  // =====================================================================
  // Appearance
  // =====================================================================
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
    const current = s.theme.preset;
    for (const p of s.presets) {
      const b = document.createElement('button');
      b.className = `theme${current === p.id ? ' on' : ''}`;
      b.innerHTML = `${preview(p)}<div class="label"><span>${p.name}</span>${CHECK}</div>`;
      b.onclick = () => {
        s.theme = { preset: p.id, custom: s.theme.custom };
        set('theme', s.theme);
        renderThemes();
      };
      wrap.appendChild(b);
    }
    const c = document.createElement('button');
    c.className = `theme custom-card${current === 'custom' ? ' on' : ''}`;
    c.innerHTML = `<div class="preview"></div><div class="label"><span>Custom</span>${CHECK}</div>`;
    c.onclick = () => {
      // Start the custom theme from whatever is active now.
      const base = s.theme.custom || s.presets.find((p) => p.id === s.theme.preset) || s.presets[0];
      s.theme = { preset: 'custom', custom: { bg: base.bg, surface: base.surface, text: base.text, accent: base.accent } };
      set('theme', s.theme);
      renderThemes();
    };
    wrap.appendChild(c);

    const editor = $('custom');
    editor.hidden = current !== 'custom';
    if (current === 'custom' && s.theme.custom) {
      for (const input of editor.querySelectorAll('input[type=color]')) input.value = s.theme.custom[input.dataset.k];
    }
  }

  // Live preview while dragging the color picker, throttled to one update per frame.
  let raf = 0;
  for (const input of document.querySelectorAll('#custom input[type=color]')) {
    input.addEventListener('input', () => {
      s.theme.custom = { ...s.theme.custom, [input.dataset.k]: input.value };
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; set('theme', { preset: 'custom', custom: s.theme.custom }); });
    });
  }

  // =====================================================================
  // Render everything from the current settings
  // =====================================================================
  function render() {
    const engine = $('engine');
    engine.innerHTML = s.engines.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    engine.value = s.searchEngine;
    $('bookmarksBar').checked = s.bookmarksBar;
    for (const b of document.querySelectorAll('#tabLayout button')) {
      const on = b.dataset.v === (s.tabLayout || 'vertical');
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('compactSidebar').checked = !!s.compactSidebar;
    $('compactRow').classList.toggle('disabled', s.tabLayout === 'horizontal');
    $('tabTitles').checked = s.tabTitles !== false;
    $('newtabShortcuts').checked = s.newtabShortcuts !== false;
    const n = s.hiddenShortcuts || 0;
    $('hiddenCount').textContent = n ? `${n} site${n === 1 ? '' : 's'} hidden from the new tab page` : 'Remove a shortcut with the × that appears when you hover it';
    $('restoreShortcuts').disabled = !n;
    $('restoreSession').checked = s.restoreSession;
    $('adblock').checked = s.adblock;
    $('blocked').textContent = `${s.blockedTotal.toLocaleString()} ads and trackers blocked so far`;
    $('sleepMinutes').value = String(s.sleepMinutes);
    $('downloadDir').textContent = s.downloadDir;
    $('aboutLine').textContent = `Coffee ${s.version} · Chromium ${s.chrome} · Electron ${s.electron}`;
    renderExceptions();
    renderExtensions();
    renderThemes();
    renderUpdate();
  }

  // ---- ad blocker exceptions ----
  function renderExceptions() {
    const list = s.adblockExceptions || [];
    $('exceptionsRow').hidden = !list.length;
    $('exceptionsInfo').textContent = list.length
      ? `Ads and trackers are allowed on ${list.length} site${list.length === 1 ? '' : 's'}`
      : 'Sites where ads and trackers are allowed';
    const box = $('exceptionList');
    box.textContent = '';
    for (const site of list) {
      const chip = Object.assign(document.createElement('span'), { className: 'chip' });
      const x = Object.assign(document.createElement('button'), { textContent: '×', title: `Block ads on ${site} again` });
      x.setAttribute('aria-label', `Remove ${site}`);
      x.onclick = () => api.send('adblock:allow', { site, allow: false });
      chip.append(site, x);
      box.appendChild(chip);
    }
  }

  const siteOf = (id) => $(id).value.trim();
  function addException() {
    const site = siteOf('exceptionInput');
    if (!site) return;
    api.send('adblock:allow', { site, allow: true });
    $('exceptionInput').value = '';
    toast(`Ads allowed on ${site}`);
  }

  // ---- clearing per site / by date ----
  async function fillSites(listId, channel) {
    const rows = (await api.invoke(channel)) || [];
    $(listId).replaceChildren(...rows.map((r) => Object.assign(document.createElement('option'), { value: r.site, label: `${r.count}` })));
  }

  const RANGE_TEXT = { today: 'today', yesterday: 'yesterday', '3days': 'the last 3 days', '7days': 'the last 7 days', all: 'all time' };
  function clearSiteField(inputId, channel, done) {
    const site = siteOf(inputId);
    if (!site) { $(inputId).focus(); return; }
    api.send(channel, { site });
    $(inputId).value = '';
    toast(done(site));
    setTimeout(refreshSiteLists, 400);
  }
  function refreshSiteLists() {
    fillSites('historySites', 'history:sites');
    fillSites('cookieSites', 'cookies:sites');
  }

  async function renderDefaultBrowser() {
    const st = (await api.invoke('browser:default')) || {};
    $('defaultTitle').textContent = st.isDefault ? 'Coffee is your default browser' : 'Coffee is not your default browser';
    $('defaultInfo').textContent = st.isDefault ? 'Links from other apps open here' : st.name ? `Currently ${st.name}` : 'Links from other apps open in another browser';
    $('makeDefault').hidden = !!st.isDefault;
  }

  // ---- extensions (applies after a restart) ----
  function renderExtensions() {
    $('extensionsOn').checked = !!s.extensions;
    const pending = !!s.extensions !== !!s.extensionsRunning;
    $('extRestartRow').hidden = !pending;
    $('extStoreRow').hidden = !(s.extensions && s.extensionsRunning);
    $('extInfo').textContent = pending
      ? (s.extensions ? 'Extensions turn on after a restart' : 'Extensions turn off after a restart')
      : (s.extensionsRunning ? 'Extensions are on' : 'Coffee loads nothing extra while this is off');
  }
  $('extensionsOn').onchange = (e) => { s.extensions = e.target.checked; set('extensions', s.extensions); renderExtensions(); };
  $('relaunch').onclick = () => api.send('app:relaunch');
  $('openStore').onclick = () => api.send('nav:go', { url: 'https://chromewebstore.google.com/category/extensions' });

  // ---- updates ----
  function renderUpdate() {
    const u = s.update || {};
    const btn = $('upd-btn');
    $('upd-title').textContent = `Coffee ${s.version}`;
    const text = {
      dev: 'Updates are disabled when running from source',
      idle: 'Coffee updates itself automatically',
      checking: 'Checking for updates…',
      latest: "You're on the latest version",
      downloading: `Downloading ${u.version || 'update'}… ${Math.round((u.progress || 0) * 100)}%`,
      ready: `Version ${u.version} is ready to install`,
      error: `Couldn't check for updates${u.error ? ` (${u.error})` : ''}`,
    }[u.state] || '';
    $('upd-status').textContent = text;
    btn.textContent = u.state === 'ready' ? 'Restart now' : 'Check for updates';
    btn.disabled = u.state === 'dev' || u.state === 'checking' || u.state === 'downloading';
    btn.classList.toggle('primary', u.state === 'ready');
  }
  $('upd-btn').onclick = () => api.send(s.update && s.update.state === 'ready' ? 'update:install' : 'update:check');

  // ---- simple controls ----
  $('engine').onchange = (e) => set('searchEngine', e.target.value);
  $('bookmarksBar').onchange = (e) => set('bookmarksBar', e.target.checked);
  for (const b of document.querySelectorAll('#tabLayout button')) b.onclick = () => set('tabLayout', b.dataset.v);
  $('compactSidebar').onchange = (e) => set('compactSidebar', e.target.checked);
  $('tabTitles').onchange = (e) => set('tabTitles', e.target.checked);
  $('runSetup').onclick = () => { location.href = 'coffee://welcome/'; };
  $('newtabShortcuts').onchange = (e) => set('newtabShortcuts', e.target.checked);
  $('restoreShortcuts').onclick = () => { api.send('shortcuts:restore'); toast('Shortcuts restored'); };
  $('restoreSession').onchange = (e) => set('restoreSession', e.target.checked);
  $('adblock').onchange = (e) => set('adblock', e.target.checked);
  $('sleepMinutes').onchange = (e) => set('sleepMinutes', Number(e.target.value));
  $('clearHistory').onclick = () => {
    const range = $('historyRange').value;
    api.send('history:clear-range', { range });
    toast(`History cleared for ${RANGE_TEXT[range] || range}`);
    setTimeout(refreshSiteLists, 400);
  };
  $('clearHistorySite').onclick = () => clearSiteField('historySiteInput', 'history:clear-site', (site) => `History cleared for ${site}`);
  $('clearCookieSite').onclick = () => clearSiteField('cookieSiteInput', 'cookies:clear-site', (site) => `Cookies and site data cleared for ${site}`);
  $('historySiteInput').onkeydown = (e) => { if (e.key === 'Enter') $('clearHistorySite').click(); };
  $('cookieSiteInput').onkeydown = (e) => { if (e.key === 'Enter') $('clearCookieSite').click(); };
  $('exceptionAdd').onclick = addException;
  $('exceptionInput').onkeydown = (e) => { if (e.key === 'Enter') addException(); };
  $('viewHistory').onclick = () => { location.href = 'coffee://history/'; };
  $('clearData').onclick = () => { api.send('data:clear'); toast('Cookies and site data cleared'); setTimeout(refreshSiteLists, 400); };
  $('makeDefault').onclick = () => { api.send('browser:set-default'); };
  window.addEventListener('focus', renderDefaultBrowser);
  $('changeDir').onclick = async () => { $('downloadDir').textContent = await api.invoke('downloads:choose-dir'); };

  // ---- import from another browser ----
  async function setupImport() {
    const browsers = await api.invoke('import:detect');
    const sel = $('importFrom');
    sel.textContent = '';
    for (const b of browsers || []) {
      for (const p of b.profiles) {
        const o = document.createElement('option');
        o.value = `${b.id}|${p.dir}`;
        o.textContent = b.profiles.length > 1 ? `${b.name}: ${p.name}` : b.name;
        sel.appendChild(o);
      }
    }
    const none = !sel.options.length;
    if (none) {
      $('importInfo').textContent = 'No Chrome, Edge, Brave or Vivaldi profiles found on this computer';
      sel.hidden = true;
    }
    $('importRun').disabled = none;
  }
  $('importRun').onclick = async () => {
    const [browser, profile] = $('importFrom').value.split('|');
    const btn = $('importRun');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    const r = await api.invoke('import:run', { browser, profile, bookmarks: $('importBookmarks').checked, history: $('importHistory').checked });
    btn.textContent = 'Import';
    btn.disabled = false;
    if (!r || !r.ok) { $('importInfo').textContent = (r && r.error) || 'Import failed'; toast('Import failed'); return; }
    const parts = [];
    if (r.bookmarks || r.folders) parts.push(`${r.bookmarks.toLocaleString()} bookmarks${r.folders ? ` in ${r.folders} folders` : ''}`);
    if (r.history) parts.push(`${r.history.toLocaleString()} history entries`);
    $('importInfo').textContent = parts.length ? `Imported ${parts.join(' and ')}` : 'Nothing new to import';
    toast('Import complete');
  };
  setupImport();
  refreshSiteLists();
  renderDefaultBrowser();

  api.on('settings', (next) => {
    const editingCustom = s && s.theme.preset === 'custom' && document.activeElement && document.activeElement.type === 'color';
    // Keep the user's not-yet-applied extensions choice while it awaits a restart.
    s = next;
    if (!editingCustom) render();
  });
  api.invoke('settings:get').then((d) => {
    s = d;
    render();
    requestAnimationFrame(jumpToHash);
  });
})();
