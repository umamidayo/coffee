'use strict';
/* global Icons */
// Renders every popup. Main decides the view's bounds; we fill it.
(() => {
  const api = window.coffee;
  const root = document.getElementById('root');
  let current = null; // { type, data }
  let keyHandler = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pick = (payload) => api.send('overlay:pick', payload);
  const close = () => api.send('overlay:close');

  function panel(cls, instant) {
    root.textContent = '';
    const p = document.createElement('div');
    p.className = `panel ${cls}${instant ? ' instant' : ''}`;
    root.appendChild(p);
    return p;
  }

  // ---------- menu ----------
  function renderMenu(data) {
    const p = panel('menu');
    let sel = -1;
    const rows = [];
    data.items.forEach((it, i) => {
      if (it.sep) { p.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); return; }
      const r = document.createElement('div');
      r.className = `mi${it.disabled ? ' disabled' : ''}`;
      r.innerHTML = `<span class="check">${it.checked ? Icons.check : ''}</span><span class="label">${esc(it.label)}</span>${it.accel ? `<span class="accel">${esc(it.accel)}</span>` : ''}`;
      r.addEventListener('mouseenter', () => setSel(rows.indexOf(entry)));
      r.addEventListener('mouseup', (e) => { if (e.button !== 1 && !it.disabled) pick({ index: i }); });
      const entry = { r, i, it };
      rows.push(entry);
      p.appendChild(r);
    });
    function setSel(n) {
      if (sel >= 0 && rows[sel]) rows[sel].r.classList.remove('sel');
      sel = n;
      if (sel >= 0 && rows[sel]) rows[sel].r.classList.add('sel');
    }
    keyHandler = (e) => {
      const enabled = rows.map((x, k) => (x.it.disabled ? -1 : k)).filter((k) => k >= 0);
      if (!enabled.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const pos = enabled.indexOf(sel);
        const next = e.key === 'ArrowDown'
          ? enabled[(pos + 1) % enabled.length]
          : enabled[(pos - 1 + enabled.length) % enabled.length];
        setSel(pos < 0 && e.key === 'ArrowUp' ? enabled[enabled.length - 1] : next);
      } else if (e.key === 'Enter' && sel >= 0) {
        e.preventDefault();
        pick({ index: rows[sel].i });
      }
    };
  }

  // ---------- omnibox suggestions ----------
  const kindIcon = { search: Icons.search, url: Icons.globe, bookmark: Icons.starFilled, history: Icons.history };
  function renderSuggest(data, reopen) {
    const p = panel('suggest', reopen);
    data.items.forEach((it, i) => {
      const r = document.createElement('div');
      r.className = `si${i === data.selected ? ' sel' : ''}`;
      if (reopen) r.style.animation = 'none';
      else r.style.animationDelay = `${i * 14}ms`;
      const icon = it.favicon && it.kind !== 'search'
        ? `<img src="${encodeURI(it.favicon)}" alt="">`
        : kindIcon[it.kind] || Icons.globe;
      r.innerHTML = `<span class="ic">${icon}</span><span class="t">${esc(it.title)}</span><span class="s">${esc(it.sub)}</span>`;
      const img = r.querySelector('img');
      if (img) img.onerror = () => { img.outerHTML = kindIcon[it.kind] || Icons.globe; };
      // mousedown, not click: the omnibox blurs as soon as focus moves here.
      r.addEventListener('mousedown', (e) => { e.preventDefault(); pick({ url: it.url, newTab: e.button === 1 }); });
      p.appendChild(r);
    });
  }

  // ---------- tooltip ----------
  function renderTip(data) {
    const p = panel('tip');
    p.textContent = data.text;
  }

  // ---------- downloads ----------
  const fmtBytes = (n) => {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
  };
  const fmtTime = (s) => (s < 60 ? `${Math.ceil(s)}s` : s < 3600 ? `${Math.ceil(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

  function dlStatus(d) {
    if (d.state === 'progressing') {
      if (d.paused) return `Paused · ${fmtBytes(d.received)}${d.total ? ` of ${fmtBytes(d.total)}` : ''}`;
      const left = d.total && d.speed > 0 ? ` · ${fmtTime((d.total - d.received) / d.speed)} left` : '';
      return `${fmtBytes(d.received)}${d.total ? ` of ${fmtBytes(d.total)}` : ''}${d.speed ? ` · ${fmtBytes(d.speed)}/s` : ''}${left}`;
    }
    if (d.state === 'completed') return `${fmtBytes(d.total || d.received)} · ${new URL(d.url).hostname.replace(/^www\./, '')}`;
    if (d.state === 'cancelled') return 'Cancelled';
    return 'Failed';
  }

  function dlRow(d, i, animate) {
    const r = document.createElement('div');
    const failed = d.state === 'cancelled' || d.state === 'interrupted';
    r.className = `dl ${d.state}${failed ? ' failed' : ''}`;
    r.dataset.id = d.id;
    if (!animate) r.style.animation = 'none';
    else r.style.animationDelay = `${i * 25}ms`;
    let acts = '';
    if (d.state === 'progressing') {
      acts = `<button class="act" data-a="${d.paused ? 'resume' : 'pause'}" title="${d.paused ? 'Resume' : 'Pause'}">${d.paused ? Icons.play : Icons.pause}</button>`
        + `<button class="act" data-a="cancel" title="Cancel">${Icons.close}</button>`;
    } else if (d.state === 'completed') {
      acts = `<button class="act" data-a="show" title="Show in folder">${Icons.folder}</button>`
        + `<button class="act" data-a="remove" title="Remove from list">${Icons.close}</button>`;
    } else {
      acts = `<button class="act" data-a="remove" title="Remove from list">${Icons.close}</button>`;
    }
    const pct = d.total ? d.received / d.total : 0;
    const bar = d.state === 'progressing'
      ? `<div class="bar${d.total ? '' : ' ind'}"><i style="transform:scaleX(${d.total ? pct : 1})"></i></div>`
      : '';
    r.innerHTML = `<div class="fi">${d.state === 'progressing' ? Icons.download : Icons.file}</div>`
      + `<div class="meta"><div class="name">${esc(d.filename)}</div><div class="status">${esc(dlStatus(d))}</div>${bar}</div>`
      + `<div class="acts">${acts}</div>`;
    r.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (a) api.send('downloads:action', { id: d.id, what: a.dataset.a });
      else if (d.state === 'completed') api.send('downloads:action', { id: d.id, what: 'open' });
    });
    return r;
  }

  function renderDownloads(data, update) {
    if (update && root.querySelector('.downloads')) {
      // Patch rows in place so progress updates don't restart animations.
      const list = root.querySelector('.dl-list');
      if (!list || !data.items.length) return renderDownloads(data, false);
      const existing = new Map([...list.children].map((n) => [n.dataset.id, n]));
      const frag = document.createDocumentFragment();
      data.items.forEach((d, i) => {
        const fresh = dlRow(d, i, !existing.has(d.id));
        frag.appendChild(fresh);
      });
      list.textContent = '';
      list.appendChild(frag);
      return;
    }
    const p = panel('downloads');
    p.innerHTML = `<div class="dl-head"><h1>Downloads</h1><button class="icon-btn dl-folder" data-folder title="Open downloads folder" aria-label="Open downloads folder">${Icons.folder}</button>${data.items.length ? '<button class="link-btn" data-clear>Clear</button>' : ''}</div>`;
    p.querySelector('[data-folder]').onclick = () => api.send('downloads:folder');
    if (!data.items.length) {
      p.insertAdjacentHTML('beforeend', `<div class="empty">${Icons.download}<span>No downloads yet</span></div>`);
      return;
    }
    const list = document.createElement('div');
    list.className = 'dl-list';
    data.items.forEach((d, i) => list.appendChild(dlRow(d, i, true)));
    p.appendChild(list);
    p.querySelector('[data-clear]').onclick = () => api.send('downloads:action', { what: 'clear' });
  }

  // ---------- bookmark editor ----------
  function renderBookmark(data) {
    const p = panel('form');
    p.innerHTML = `<h1>${Icons.starFilled}${data.created ? 'Bookmark added' : 'Edit bookmark'}</h1>
      <input class="field" id="bm-title" maxlength="300">
      <div class="sub-url"></div>
      <label class="field-label">Folder</label>
      <select class="field" id="bm-folder"></select>
      <div class="row"><button class="btn" id="bm-remove">Remove</button><button class="btn primary" id="bm-done">Done</button></div>`;
    const field = p.querySelector('#bm-title');
    const folder = p.querySelector('#bm-folder');
    field.value = data.title || '';
    p.querySelector('.sub-url').textContent = data.url;
    // Folder picker: the bar, then every folder indented by depth.
    const opts = [{ id: '', title: 'Bookmarks bar', depth: 0 }, ...(data.folders || []).map((f) => ({ ...f, depth: f.depth + 1 }))];
    for (const f of opts) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = `${'\u2003'.repeat(f.depth)}${f.title}`;
      folder.appendChild(o);
    }
    folder.value = data.parent || '';
    const save = (withFolder) => {
      const msg = { id: data.id, title: field.value.trim() || data.url };
      if (withFolder) msg.parent = folder.value || null;
      api.send('bookmark:update', msg);
    };
    p.querySelector('#bm-done').onclick = () => { save(true); close(); };
    p.querySelector('#bm-remove').onclick = () => api.send('bookmark:remove', { id: data.id });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(true); close(); } });
    field.addEventListener('input', () => save(false));
    folder.addEventListener('change', () => save(true));
    requestAnimationFrame(() => { field.focus(); field.select(); });
  }

  // ---------- bookmark folder dropdown ----------
  function renderFolder(data, reopen) {
    const p = panel('menu bmf', reopen);
    let html = '';
    if (data.back) html += `<div class="mi bmf-back" data-nav="${esc(data.back.id)}"><span class="check">${Icons.back}</span><span class="label">${esc(data.back.title)}</span></div><div class="msep"></div>`;
    if (!data.items.length) html += `<div class="mi disabled"><span class="check"></span><span class="label">${data.root ? 'No bookmarks yet. Press Ctrl+D to add one' : 'This folder is empty'}</span></div>`;
    p.innerHTML = `${html}<div class="bmf-list"></div>`;
    const list = p.querySelector('.bmf-list');
    for (const b of data.items) {
      const r = document.createElement('div');
      r.className = `mi bmf-item${b.type === 'folder' ? ' bmf-sub' : ''}`;
      const icon = b.type === 'folder' ? `<span class="bmf-ico bmf-folder">${Icons.folder}</span>`
        : b.favicon ? `<img class="bmf-ico" src="${encodeURI(b.favicon)}" alt="">` : `<span class="bmf-ico">${Icons.globe}</span>`;
      r.innerHTML = `${icon}<span class="label"></span>${b.type === 'folder' ? `<span class="accel">${Icons.forward}</span>` : ''}`;
      r.querySelector('.label').textContent = b.title || b.url;
      r.title = b.type === 'folder' ? b.title : `${b.title}\n${b.url}`;
      const img = r.querySelector('img');
      if (img) img.onerror = () => { img.outerHTML = `<span class="bmf-ico">${Icons.globe}</span>`; };
      if (b.type === 'folder') {
        r.addEventListener('click', () => api.send('bmfolder:nav', { id: b.id }));
      } else {
        r.addEventListener('click', (e) => api.send('bookmark:open', { id: b.id, newTab: e.shiftKey, background: e.ctrlKey }));
        r.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('bookmark:open', { id: b.id, background: true, keepOpen: true }); });
      }
      list.appendChild(r);
    }
    if (data.items.some((b) => b.type === 'bookmark')) {
      p.insertAdjacentHTML('beforeend', `<div class="msep"></div><div class="mi bmf-all"><span class="check"></span><span class="label">Open all in new tabs</span></div>`);
      p.querySelector('.bmf-all').onclick = () => api.send('bmfolder:openall', { id: data.id });
    }
    const back = p.querySelector('.bmf-back');
    if (back) back.onclick = () => api.send('bmfolder:nav', { id: back.dataset.nav });
    for (const r of p.querySelectorAll('.mi:not(.disabled)')) {
      r.addEventListener('mouseenter', () => r.classList.add('sel'));
      r.addEventListener('mouseleave', () => r.classList.remove('sel'));
    }
  }

  // ---------- folder name editor ----------
  function renderFolderEditor(data) {
    const p = panel('form');
    p.innerHTML = `<h1>${Icons.folder}${data.rename ? 'Rename folder' : 'New folder'}</h1>
      <input class="field" id="fd-title" maxlength="120" placeholder="Folder name">
      <div class="row"><button class="btn" id="fd-cancel">Cancel</button><button class="btn primary" id="fd-save">${data.rename ? 'Save' : 'Create'}</button></div>`;
    const field = p.querySelector('#fd-title');
    field.value = data.title || '';
    const save = () => pick({ title: field.value });
    p.querySelector('#fd-save').onclick = save;
    p.querySelector('#fd-cancel').onclick = close;
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    requestAnimationFrame(() => { field.focus(); field.select(); });
  }

  // ---------- extensions panel ----------
  function renderExtensions(data) {
    const p = panel('menu extp');
    p.innerHTML = `<div class="extp-head">Extensions</div><div class="extp-list"></div>
      <div class="msep"></div><div class="mi extp-store"><span class="check">${Icons.plus}</span><span class="label">Get extensions from the Chrome Web Store</span></div>`;
    const list = p.querySelector('.extp-list');
    if (!data.list.length) {
      list.innerHTML = '<div class="extp-empty">No extensions yet</div>';
    }
    for (const e of data.list) {
      const r = document.createElement('div');
      r.className = 'extp-item';
      const icon = new Image();
      icon.className = 'extp-ico';
      icon.alt = '';
      icon.src = `crx://extension-icon/${encodeURIComponent(e.id)}/32/2?partition=persist:web`;
      icon.onerror = () => { icon.replaceWith(Object.assign(document.createElement('span'), { className: 'extp-ico extp-letter', textContent: (e.name || '?').charAt(0).toUpperCase() })); };
      const meta = document.createElement('div');
      meta.className = 'extp-meta';
      meta.innerHTML = '<div class="extp-name"></div><div class="extp-ver"></div>';
      meta.firstChild.textContent = e.name;
      meta.lastChild.textContent = `Version ${e.version}`;
      r.title = e.description || e.name;
      const acts = document.createElement('div');
      acts.className = 'extp-acts';
      if (e.options) {
        const o = Object.assign(document.createElement('button'), { className: 'act', title: 'Options', innerHTML: Icons.settings });
        o.onclick = () => api.send('ext:options', { id: e.id });
        acts.appendChild(o);
      }
      const rm = Object.assign(document.createElement('button'), { className: 'act', title: 'Remove', innerHTML: Icons.trash });
      rm.onclick = () => { r.classList.add('removing'); api.send('ext:remove', { id: e.id }); };
      acts.appendChild(rm);
      r.append(icon, meta, acts);
      list.appendChild(r);
    }
    const store = p.querySelector('.extp-store');
    store.onclick = () => api.send('ext:store');
    store.addEventListener('mouseenter', () => store.classList.add('sel'));
    store.addEventListener('mouseleave', () => store.classList.remove('sel'));
  }

  // ---------- extension install confirmation ----------
  function renderExtInstall(data) {
    const p = panel('form extinstall');
    p.innerHTML = `<h1><span class="exti-ico"></span><span class="exti-title"></span></h1>
      <p class="exti-lead"></p><ul class="exti-perms"></ul>
      <div class="row"><button class="btn" id="exti-cancel">Cancel</button><button class="btn primary" id="exti-ok">Add extension</button></div>`;
    const ico = p.querySelector('.exti-ico');
    if (data.icon) ico.appendChild(Object.assign(new Image(), { src: data.icon, alt: '' }));
    else ico.innerHTML = Icons.puzzle;
    p.querySelector('.exti-title').textContent = `Add “${data.name}”?`;
    p.querySelector('.exti-lead').textContent = data.permissions.length ? 'It will be able to:' : 'It doesn’t ask for any special access.';
    const ul = p.querySelector('.exti-perms');
    for (const perm of data.permissions) ul.appendChild(Object.assign(document.createElement('li'), { textContent: perm }));
    p.querySelector('#exti-ok').onclick = () => pick({ ok: true });
    p.querySelector('#exti-cancel').onclick = close;
    requestAnimationFrame(() => p.querySelector('#exti-cancel').focus());
  }

  // ---------- confirmation ----------
  function renderConfirm(data) {
    const p = panel('form');
    p.innerHTML = `<h1>${Icons.trash}<span></span></h1><p></p>
      <div class="row"><button class="btn" id="cf-cancel">Cancel</button><button class="btn danger" id="cf-ok"></button></div>`;
    p.querySelector('h1 span').textContent = data.title;
    p.querySelector('p').textContent = data.message;
    p.querySelector('#cf-ok').textContent = data.confirm || 'OK';
    p.querySelector('#cf-ok').onclick = () => pick({ ok: true });
    p.querySelector('#cf-cancel').onclick = close;
    requestAnimationFrame(() => p.querySelector('#cf-cancel').focus());
  }

  // ---------- permission prompt ----------
  function renderPermission(data) {
    const p = panel('form');
    p.innerHTML = `<h1>${Icons.shield}Permission request</h1>
      <p><b></b> wants to <span class="what"></span>.</p>
      <div class="row"><button class="btn" id="pm-block">Block</button><button class="btn primary" id="pm-allow">Allow</button></div>`;
    p.querySelector('b').textContent = data.host;
    p.querySelector('.what').textContent = data.what;
    p.querySelector('#pm-allow').onclick = () => pick({ allow: true });
    p.querySelector('#pm-block').onclick = () => pick({ allow: false });
    requestAnimationFrame(() => p.querySelector('#pm-allow').focus());
  }

  // ---------- compact sidebar peek ----------
  let peekStrip = null;
  let peekLeave = null;
  function renderSidebar(data) {
    const p = panel('peek');
    p.innerHTML = `<div class="peek-scroll"><div class="peek-tabs"></div>
        <button class="peek-btn peek-new">${Icons.plus}<span>New tab</span></button></div>
      <div class="peek-foot"><button class="peek-btn peek-settings">${Icons.settings}<span>Settings</span></button></div>`;
    // Activate on click (not pointerdown) so tabs can still be dragged here.
    const titles = data.titles !== false;
    p.classList.toggle('peek-icons', !titles);
    peekStrip = new window.TabStrip(p.querySelector('.peek-tabs'), { api, orientation: 'vertical', titles, activateOn: 'click' });
    peekStrip.render(data);
    p.querySelector('.peek-new').onclick = () => api.send('tab:new');
    p.querySelector('.peek-settings').onclick = () => api.send('settings:open');
    p.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tab')) return;
      e.preventDefault();
      api.send('sidebar:menu', { x: e.clientX, y: e.clientY });
    });
    // Slide away shortly after the mouse leaves (not mid-drag).
    p.addEventListener('mouseleave', () => {
      clearTimeout(peekLeave);
      peekLeave = setTimeout(() => { if (!peekStrip || !peekStrip.dragging) close(); }, 280);
    });
    p.addEventListener('mouseenter', () => clearTimeout(peekLeave));
  }

  const renderers = {
    sidebar: renderSidebar,
    bmfolder: renderFolder,
    folder: renderFolderEditor,
    confirm: renderConfirm,
    extensions: renderExtensions,
    extinstall: renderExtInstall,
    menu: renderMenu,
    suggest: renderSuggest,
    tooltip: renderTip,
    downloads: renderDownloads,
    bookmark: renderBookmark,
    permission: renderPermission,
  };

  function dropPeek() {
    clearTimeout(peekLeave);
    if (peekStrip) { peekStrip.destroy(); peekStrip = null; }
  }

  api.on('overlay:show', ({ type, data, reopen }) => {
    keyHandler = null;
    dropPeek();
    document.body.className = `t-${type}`;
    current = { type, data };
    const fn = renderers[type];
    if (fn) fn(data, reopen);
  });
  api.on('overlay:update', ({ type, data }) => {
    if (!current || current.type !== type) return;
    current.data = data;
    if (type === 'downloads') renderDownloads(data, true);
    if (type === 'sidebar' && peekStrip) peekStrip.render(data);
  });
  api.on('overlay:hide', () => {
    dropPeek();
    current = null;
    keyHandler = null;
    root.textContent = '';
  });

  document.addEventListener('keydown', (e) => { if (keyHandler) keyHandler(e); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
