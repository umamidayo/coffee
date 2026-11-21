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
    // The frame (sidebar + toolbar) can have its own color or gradient; the page area shows the base colors.
    const frame = p.frame2 ? `linear-gradient(${p.angle ?? 135}deg, ${p.frame || p.bg}, ${p.frame2})` : (p.frame || p.bg);
    const accent = p.accent2 ? `linear-gradient(135deg, ${p.accent}, ${p.accent2})` : p.accent;
    return `<div class="preview" style="background:${frame}">
      <div class="pv-side"><i style="background:${p.accent}"></i><i style="background:${p.text}"></i><i style="background:${p.text}"></i></div>
      <div class="pv-main">
        <div class="pv-top"><div class="pv-omni" style="background:${p.text}"></div></div>
        <div class="pv-page" style="background:${p.surface}">
          <div class="pv-line" style="background:${p.text}; width:70%"></div>
          <div class="pv-line short" style="background:${p.text}"></div>
        </div>
      </div>
      <div class="pv-dot" style="background:${accent}"></div>
    </div>`;
  }

  // Your own themes are saved themes: picking one shows its editor, and every
  // change is applied and saved as you make it.
  const SAVED_PREFIX = 'saved:';
  const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  const editingId = () => (s.theme.preset.startsWith(SAVED_PREFIX) ? s.theme.preset.slice(SAVED_PREFIX.length) : null);
  const editing = () => (s.theme.saved || []).find((t) => t.id === editingId()) || null;

  // Settings come back from the browser after each change; while edits are in
  // flight those copies can be a step behind, so the page's own theme wins
  // until things settle (see the 'settings' listener).
  let themeEditedAt = 0;
  function applyTheme(next) {
    themeEditedAt = Date.now();
    s.theme = next;
    set('theme', s.theme);
  }

  /** Ask first: resolves true to go ahead. Cancel is focused, so Enter alone doesn't delete. */
  function confirmDialog({ title, text, ok = 'Delete', swatch = null }) {
    const m = $('confirm');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = ok;
    $('confirmSwatch').hidden = !swatch;
    if (swatch) $('confirmSwatch').innerHTML = swatch;
    m.hidden = false;
    m.classList.remove('leave');
    const last = document.activeElement;
    requestAnimationFrame(() => $('confirmNo').focus());
    return new Promise((resolve) => {
      const done = (yes) => {
        m.classList.add('leave');
        setTimeout(() => { m.hidden = true; m.classList.remove('leave'); }, 140);
        document.removeEventListener('keydown', onKey, true);
        if (last && last.focus && !yes) last.focus();
        resolve(yes);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === $('confirmNo') ? $('confirmYes') : $('confirmNo')).focus(); }
      };
      document.addEventListener('keydown', onKey, true);
      $('confirmNo').onclick = () => done(false);
      $('confirmYes').onclick = () => done(true);
      m.onmousedown = (e) => { if (e.target === m) done(false); };
    });
  }

  async function deleteSaved(id) {
    const t = (s.theme.saved || []).find((x) => x.id === id);
    if (!t) return;
    const yes = await confirmDialog({
      title: `Delete “${t.name}”?`,
      text: "This theme will be gone for good. You can't undo this.",
      ok: 'Delete theme',
      swatch: preview(t),
    });
    if (!yes) return;
    const left = s.theme.saved.filter((x) => x.id !== id);
    const preset = s.theme.preset === `${SAVED_PREFIX}${id}` ? 'coffee' : s.theme.preset;
    applyTheme({ ...s.theme, saved: left, preset });
    toast(`Deleted “${t.name}”`);
    renderThemes();
  }

  function renderThemes() {
    const wrap = $('themes');
    wrap.textContent = '';
    const current = s.theme.preset;
    const saved = s.theme.saved || [];
    for (const p of s.presets) {
      const b = document.createElement('button');
      b.className = `theme${current === p.id ? ' on' : ''}`;
      b.innerHTML = `${preview(p)}<div class="label"><span>${p.name}</span>${CHECK}</div>`;
      // A preset is a starting point: "Customize" makes your own copy of it to change.
      const acts = document.createElement('span');
      acts.className = 'theme-acts';
      const copy = Object.assign(document.createElement('span'), { className: 'theme-act', title: `Customize: make your own copy of ${p.name}`, innerHTML: PENCIL });
      copy.setAttribute('role', 'button');
      copy.setAttribute('aria-label', `Customize ${p.name}`);
      copy.onclick = (e) => { e.stopPropagation(); createFrom(p, `${p.name} (custom)`); };
      acts.appendChild(copy);
      b.appendChild(acts);
      b.onclick = () => { applyTheme({ ...s.theme, preset: p.id }); renderThemes(); };
      wrap.appendChild(b);
    }
    for (const t of saved) {
      const id = `${SAVED_PREFIX}${t.id}`;
      const b = document.createElement('button');
      b.className = `theme mine${current === id ? ' on' : ''}`;
      b.innerHTML = `${preview(t)}<div class="label"><span></span>${CHECK}</div>`;
      b.querySelector('.label span').textContent = t.name;
      const acts = document.createElement('span');
      acts.className = 'theme-acts';
      const edit = Object.assign(document.createElement('span'), { className: 'theme-act', title: 'Edit this theme', innerHTML: PENCIL });
      const del = Object.assign(document.createElement('span'), { className: 'theme-act del', title: 'Delete this theme', textContent: '×' });
      for (const [el, label] of [[edit, `Edit ${t.name}`], [del, `Delete ${t.name}`]]) {
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', label);
      }
      edit.onclick = (e) => {
        e.stopPropagation();
        if (current !== id) applyTheme({ ...s.theme, preset: id });
        renderThemes();
        $('custom').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        $('themeName').focus();
      };
      del.onclick = (e) => { e.stopPropagation(); deleteSaved(t.id); };
      acts.append(edit, del);
      b.appendChild(acts);
      b.onclick = () => { applyTheme({ ...s.theme, preset: id }); renderThemes(); };
      wrap.appendChild(b);
    }
    // "New theme": a saved theme straight away, starting from the colors in use now.
    const c = document.createElement('button');
    c.className = 'theme custom-card';
    c.disabled = saved.length >= 24;
    c.title = c.disabled ? 'You can keep up to 24 themes. Delete one to make another.' : '';
    c.innerHTML = '<div class="preview"></div><div class="label"><span>New theme</span></div>';
    c.onclick = () => createFrom(editing() || s.presets.find((p) => p.id === s.theme.preset) || s.presets[0], `My theme ${saved.length + 1}`);
    wrap.appendChild(c);
    renderEditor();
  }

  /** A new theme of your own, starting from `base` (a preset or one of yours), opened in the editor. */
  function createFrom(base, name) {
    const saved = s.theme.saved || [];
    if (saved.length >= 24) { toast('You can keep up to 24 themes. Delete one to make another.'); return; }
    const { id: _i, name: _n, mode: _m, ...colors } = base;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const used = new Set(saved.map((t) => t.name));
    let unique = name.slice(0, 32);
    for (let n = 2; used.has(unique); n++) unique = `${name.slice(0, 28)} ${n}`;
    applyTheme({ ...s.theme, saved: [...saved, { ...colors, id, name: unique }], preset: `${SAVED_PREFIX}${id}` });
    renderThemes();
    $('custom').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('themeName').focus();
    $('themeName').select();
  }

  // ---- the editor ----
  function renderEditor() {
    const t = editing();
    const ed = $('custom');
    ed.hidden = !t;
    if (!t) return;
    if (document.activeElement !== $('themeName')) $('themeName').value = t.name;
    for (const input of ed.querySelectorAll('input[type=color]')) {
      const k = input.dataset.k;
      // Extras without a value start from a sensible color.
      input.value = t[k] || (k === 'frame' ? t.bg : k === 'frame2' ? t.accent : k === 'accent2' ? t.accent : '#000000');
      const hex = input.closest('.swatch-wrap')?.querySelector('.hex');
      if (hex && document.activeElement !== hex) { hex.value = input.value; hex.classList.remove('bad'); }
    }
    const mode = t.frame2 ? 'gradient' : t.frame ? 'solid' : 'same';
    for (const b of document.querySelectorAll('#frameMode button')) b.classList.toggle('on', b.dataset.v === mode);
    $('frameColors').hidden = mode === 'same';
    $('frame2Swatch').hidden = mode !== 'gradient';
    $('angleCtl').hidden = mode !== 'gradient';
    $('frameLabel').textContent = mode === 'gradient' ? 'From' : 'Frame';
    $('frameAngle').value = String(t.angle ?? 135);
    $('angleVal').textContent = `${t.angle ?? 135}°`;
    $('accent2On').checked = !!t.accent2;
    $('accent2Colors').hidden = !t.accent2;
  }

  /** Change the theme being edited; applied (and saved) once per frame while dragging a picker. */
  let raf = 0;
  function updateEditing(patch, { now = false } = {}) {
    const t = editing();
    if (!t) return;
    const next = { ...t, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    themeEditedAt = Date.now();
    s.theme = { ...s.theme, saved: s.theme.saved.map((x) => (x.id === t.id ? next : x)) };
    const push = () => { raf = 0; themeEditedAt = Date.now(); set('theme', s.theme); };
    if (now) { cancelAnimationFrame(raf); push(); renderThemes(); return; }
    if (!raf) raf = requestAnimationFrame(push);
  }

  for (const input of document.querySelectorAll('#custom input[type=color]')) {
    input.addEventListener('input', () => {
      updateEditing({ [input.dataset.k]: input.value });
      const hex = input.closest('.swatch-wrap')?.querySelector('.hex');
      if (hex && document.activeElement !== hex) { hex.value = input.value; hex.classList.remove('bad'); }
    });
    // Refresh the card previews once the picker is let go (not on every step).
    input.addEventListener('change', () => renderThemes());
  }

  // ---- copy & paste colors ----
  // Every color gets its hex code (type or paste into it) and Copy / Paste
  // buttons that use the system clipboard, so a color can go from one part of
  // the theme to another, or come in from anywhere else (#hex, #abc, rgb()).
  /** A color in text form, as #rrggbb, or null. */
  function parseColor(text) {
    const t = String(text || '').trim().toLowerCase();
    let m = t.match(/^#?([0-9a-f]{6})$/);
    if (m) return `#${m[1]}`;
    m = t.match(/^#?([0-9a-f]{3})$/);
    if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
    m = t.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/);
    if (m && m.slice(1, 4).every((v) => Number(v) <= 255)) return `#${m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
    return null;
  }
  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>';
  const PASTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3.5h6V5"/><path d="M9 12h6M9 16h4"/></svg>';
  for (const label of document.querySelectorAll('#custom label.swatch')) {
    const input = label.querySelector('input[type=color]');
    const name = label.querySelector('span').textContent;
    // The label opens the picker, so the extra controls sit beside it, not inside it.
    const wrap = document.createElement('div');
    wrap.className = 'swatch-wrap';
    if (label.id) { wrap.id = label.id; label.removeAttribute('id'); }
    label.replaceWith(wrap);
    wrap.appendChild(label);
    const row = document.createElement('div');
    row.className = 'hexrow';
    row.innerHTML = `<input class="hex" type="text" maxlength="24" spellcheck="false" autocomplete="off" aria-label="${name} color code">`
      + `<button class="mini" data-act="copy" title="Copy ${name} color">${COPY_ICON}</button>`
      + `<button class="mini" data-act="paste" title="Paste a color into ${name}">${PASTE_ICON}</button>`;
    wrap.appendChild(row);
    const hex = row.querySelector('.hex');
    const set = (color) => {
      input.value = color;
      hex.value = color;
      hex.classList.remove('bad');
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    };
    hex.addEventListener('input', () => {
      const c = parseColor(hex.value);
      hex.classList.toggle('bad', !c && hex.value.trim() !== '');
      if (c) { input.value = c; input.dispatchEvent(new Event('input')); }
    });
    hex.addEventListener('blur', () => { hex.value = input.value; hex.classList.remove('bad'); renderThemes(); });
    hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') hex.blur(); });
    row.querySelector('[data-act=copy]').onclick = () => {
      api.send('clipboard:write-text', { text: input.value });
      toast(`Copied ${input.value}`);
    };
    row.querySelector('[data-act=paste]').onclick = async () => {
      const text = await api.invoke('clipboard:read-text').catch(() => '');
      const c = parseColor(text);
      if (!c) { toast(text ? `“${String(text).slice(0, 24)}” isn't a color` : 'Copy a color first'); return; }
      set(c);
      toast(`Pasted ${c} into ${name}`);
    };
  }
  $('themeName').addEventListener('input', () => {
    const name = $('themeName').value.replace(/\s+/g, ' ').trimStart().slice(0, 32);
    updateEditing({ name: name || 'My theme' });
    const card = document.querySelector('#themes .theme.mine.on .label span');
    if (card) card.textContent = name || 'My theme';
  });
  $('themeName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('themeName').blur(); });
  $('deleteTheme').onclick = () => { const t = editing(); if (t) deleteSaved(t.id); };
  for (const b of document.querySelectorAll('#frameMode button')) {
    b.onclick = () => {
      const t = editing();
      if (!t) return;
      if (b.dataset.v === 'same') updateEditing({ frame: null, frame2: null, angle: null }, { now: true });
      else if (b.dataset.v === 'solid') updateEditing({ frame: t.frame || $('custom').querySelector('[data-k=frame]').value, frame2: null, angle: null }, { now: true });
      else updateEditing({ frame: t.frame || t.bg, frame2: t.frame2 || t.accent, angle: t.angle ?? 135 }, { now: true });
    };
  }
  $('frameAngle').addEventListener('input', () => {
    $('angleVal').textContent = `${$('frameAngle').value}°`;
    updateEditing({ angle: Number($('frameAngle').value) });
  });
  $('frameAngle').addEventListener('change', () => renderThemes());
  $('accent2On').onchange = () => {
    const t = editing();
    if (!t) return;
    updateEditing({ accent2: $('accent2On').checked ? (t.accent2 || $('custom').querySelector('[data-k=accent2]').value) : null }, { now: true });
  };

  // =====================================================================
  // Render everything from the current settings
  // =====================================================================
  function render() {
    $('notesLink').textContent = s.whatsNewTitle ? `Coffee ${s.version}: ${s.whatsNewTitle}` : 'See what changed in this version';
    const engine = $('engine');
    engine.innerHTML = s.engines.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    engine.value = s.searchEngine;
    $('bookmarksBar').checked = s.bookmarksBar;
    $('bookmarksButton').checked = !!s.bookmarksButton;
    for (const b of document.querySelectorAll('#tabLayout button')) {
      const on = b.dataset.v === (s.tabLayout || 'vertical');
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('compactSidebar').checked = !!s.compactSidebar;
    $('compactRow').classList.toggle('disabled', s.tabLayout === 'horizontal');
    $('tabTitles').checked = s.tabTitles !== false;
    $('newtabShortcuts').checked = s.newtabShortcuts !== false;
    $('showHome').checked = !!s.showHome;
    if (document.activeElement !== $('homePageInput')) $('homePageInput').value = s.homePage || '';
    $('homeInfo').textContent = s.homePage ? 'Opens this address' : 'Leave blank to use the new tab page';
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

  function renderDefaultBrowser(st) {
    st = st || {};
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
  $('bookmarksButton').onchange = (e) => set('bookmarksButton', e.target.checked);
  for (const b of document.querySelectorAll('#tabLayout button')) b.onclick = () => set('tabLayout', b.dataset.v);
  $('compactSidebar').onchange = (e) => set('compactSidebar', e.target.checked);
  $('tabTitles').onchange = (e) => set('tabTitles', e.target.checked);
  $('showHome').onchange = (e) => set('showHome', e.target.checked);
  function saveHomePage() {
    const v = $('homePageInput').value.trim();
    set('homePage', v);
    // The main process rejects anything that isn't a web address and keeps the old value.
    setTimeout(async () => {
      const cur = await api.invoke('settings:get');
      if (cur) s = cur;
      $('homePageInput').value = s.homePage || '';
      toast(!v ? 'Home page set to the new tab page' : s.homePage ? 'Home page saved' : 'That isn’t a web address');
    }, 150);
  }
  $('homePageSave').onclick = saveHomePage;
  $('homePageInput').onkeydown = (e) => { if (e.key === 'Enter') saveHomePage(); };
  $('runSetup').onclick = () => { location.href = 'coffee://welcome/'; };
  $('notesBtn').onclick = () => api.send('whatsnew:open');
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
  api.on('browser', renderDefaultBrowser);
  const checkDefaultBrowser = async () => renderDefaultBrowser(await api.invoke('browser:default'));
  window.addEventListener('focus', checkDefaultBrowser);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDefaultBrowser(); });
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
  checkDefaultBrowser();

  api.on('settings', (next) => {
    // Don't redraw the theme editor under a color picker or the name field mid-edit.
    const editingCustom = s && document.activeElement && (document.activeElement.type === 'color' || document.activeElement.id === 'themeName' || document.activeElement.id === 'frameAngle');
    // Keep the user's not-yet-applied extensions choice while it awaits a restart.
    // A theme edit made in the last moment beats an older copy coming back.
    if (s && Date.now() - themeEditedAt < 1000) next = { ...next, theme: s.theme };
    s = next;
    if (!editingCustom) render();
  });
  api.invoke('settings:get').then((d) => {
    s = d;
    render();
    requestAnimationFrame(jumpToHash);
  });
})();
