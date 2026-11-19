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
    p.innerHTML = `<div class="dl-head"><h1>Downloads</h1>${data.items.length ? '<button class="link-btn" data-clear>Clear</button>' : ''}</div>`;
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
      <div class="row"><button class="btn" id="bm-remove">Remove</button><button class="btn primary" id="bm-done">Done</button></div>`;
    const field = p.querySelector('#bm-title');
    field.value = data.title || '';
    p.querySelector('.sub-url').textContent = data.url;
    const save = () => api.send('bookmark:update', { id: data.id, title: field.value.trim() || data.url });
    p.querySelector('#bm-done').onclick = () => { save(); close(); };
    p.querySelector('#bm-remove').onclick = () => api.send('bookmark:remove', { id: data.id });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); close(); } });
    field.addEventListener('input', save);
    requestAnimationFrame(() => { field.focus(); field.select(); });
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

  const renderers = {
    menu: renderMenu,
    suggest: renderSuggest,
    tooltip: renderTip,
    downloads: renderDownloads,
    bookmark: renderBookmark,
    permission: renderPermission,
  };

  api.on('overlay:show', ({ type, data, reopen }) => {
    keyHandler = null;
    current = { type, data };
    const fn = renderers[type];
    if (fn) fn(data, reopen);
  });
  api.on('overlay:update', ({ type, data }) => {
    if (!current || current.type !== type) return;
    current.data = data;
    if (type === 'downloads') renderDownloads(data, true);
  });
  api.on('overlay:hide', () => {
    current = null;
    keyHandler = null;
    root.textContent = '';
  });

  document.addEventListener('keydown', (e) => { if (keyHandler) keyHandler(e); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
