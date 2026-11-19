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

  function render() {
    $('version').textContent = s.version;
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
    $('tabTitles').checked = s.tabTitles !== false;
    $('newtabShortcuts').checked = s.newtabShortcuts !== false;
    const n = s.hiddenShortcuts || 0;
    $('hiddenCount').textContent = n ? `${n} site${n === 1 ? '' : 's'} hidden from the new tab page` : 'Remove a shortcut with the × that appears when you hover it';
    $('restoreShortcuts').disabled = !n;
    $('compactRow').classList.toggle('disabled', s.tabLayout === 'horizontal');
    $('restoreSession').checked = s.restoreSession;
    $('adblock').checked = s.adblock;
    $('blocked').textContent = `${s.blockedTotal.toLocaleString()} ads and trackers blocked so far`;
    $('sleepMinutes').value = String(s.sleepMinutes);
    $('downloadDir').textContent = s.downloadDir;
    $('about').textContent = `Coffee ${s.version} · Chromium ${s.chrome} · Electron ${s.electron}`;
    renderThemes();
    renderUpdate();
  }

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
  $('clearHistory').onclick = () => { api.send('history:clear'); toast('History cleared'); };
  $('clearData').onclick = () => { api.send('data:clear'); toast('Cookies and site data cleared'); };
  $('changeDir').onclick = async () => { $('downloadDir').textContent = await api.invoke('downloads:choose-dir'); };

  api.on('settings', (next) => {
    const editingCustom = s && s.theme.preset === 'custom' && document.activeElement && document.activeElement.type === 'color';
    s = next;
    if (!editingCustom) render();
  });
  api.invoke('settings:get').then((d) => { s = d; render(); });
})();
