'use strict';
/* global Icons */
// Passing hints over the page: the link status bubble and tab hover cards.
// Main says what to show; we draw it, measure it and report the size, and
// main places the view to fit.
(() => {
  const api = window.coffee;
  const root = document.getElementById('root');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** "host" + "/the/rest" for a URL, decoded for reading. */
  function splitUrl(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return { host: '', rest: url };
      let rest = u.pathname + u.search + u.hash;
      try { rest = decodeURI(rest); } catch { /* keep it encoded */ }
      if (rest === '/') rest = '';
      return { host: u.host.replace(/^www\./, ''), rest };
    } catch {
      return { host: '', rest: url };
    }
  }

  function urlMarkup(url) {
    const { host, rest } = splitUrl(url);
    return `${host ? `<b>${esc(host)}</b>` : ''}${esc(rest)}`;
  }

  // ---------- link status bubble ----------
  function renderStatus(d, update) {
    let b = root.querySelector('.status');
    if (!b) {
      root.textContent = '';
      b = document.createElement('div');
      b.className = 'status';
      root.appendChild(b);
    } else if (!update) {
      b.style.animation = 'none';
      void b.offsetWidth;
      b.style.animation = '';
    }
    b.classList.toggle('right', d.side === 'right');
    b.style.maxWidth = `${Math.max(120, d.maxWidth)}px`;
    b.innerHTML = urlMarkup(d.url);
    return b;
  }

  // ---------- tab hover card ----------
  function renderCard(d) {
    root.textContent = '';
    const c = document.createElement('div');
    c.className = `card${d.side === 'below' ? ' below' : ''}`;
    const notes = [];
    if (d.muted) notes.push(`${Icons.mute}<span>Muted</span>`);
    else if (d.audible) notes.push(`${Icons.volume}<span>Playing audio</span>`);
    if (d.pip) notes.push(`${Icons.pip}<span>Video popped out</span>`);
    if (d.private) notes.push(`${Icons.mask}<span>Private</span>`);
    if (d.split) notes.push(`${Icons.split}<span>In split view</span>`);
    if (d.sleeping) notes.push('<span class="zz">z</span><span>Sleeping · reloads when opened</span>');
    const url = d.url ? `<div class="u">${urlMarkup(d.url)}</div>` : '';
    c.innerHTML = `<div class="head"><div class="t"></div>${url}${notes.length ? `<div class="notes">${notes.map((n) => `<span class="note">${n}</span>`).join('')}</div>` : ''}</div>`
      + (d.thumb ? `<div class="thumb"><img alt="" src="${d.thumb}"></div>` : '');
    c.querySelector('.t').textContent = d.title || 'New Tab';
    root.appendChild(c);
    return c;
  }

  // ---------- toast (a short confirmation, e.g. "Link copied") ----------
  function renderToast(d) {
    root.textContent = '';
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `${Icons.check}<span></span>`;
    t.lastChild.textContent = d.text;
    root.appendChild(t);
    return t;
  }

  // ---------- full screen: which site, and how to leave ----------
  function renderFsNotice(d) {
    root.textContent = '';
    const n = document.createElement('div');
    n.className = 'fsn';
    const site = d.host ? `<b class="site"></b> is now full screen` : 'This page is now full screen';
    n.innerHTML = `<span class="fsn-ico">${Icons.fullscreen}</span><div class="fsn-text"><div class="fsn-what">${site}</div>`
      + '<div class="fsn-how">Press <kbd>Esc</kbd> to exit full screen</div></div><i class="fsn-time"></i>';
    if (d.host) n.querySelector('.site').textContent = d.host;
    root.appendChild(n);
    return n;
  }

  const renderers = { status: renderStatus, tabcard: renderCard, toast: renderToast, fsnotice: renderFsNotice };

  api.on('float:show', ({ kind, data, seq, update }) => {
    const fn = renderers[kind];
    if (!fn) return;
    document.body.className = `k-${kind}`;
    const node = fn(data, update);
    const report = () => {
      const r = node.getBoundingClientRect();
      const pad = kind === 'status' ? 0 : 24; // room for the shadow
      api.send('float:size', { seq, width: r.width + pad, height: r.height + pad });
    };
    // Wait for a preview image so the card is measured at its final height.
    const img = node.querySelector('img');
    if (img && !img.complete) {
      img.onload = report;
      img.onerror = () => { img.closest('.thumb').remove(); report(); };
    } else {
      report();
    }
  });
  api.on('float:hide', () => { root.textContent = ''; });
})();
