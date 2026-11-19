'use strict';
// History page: newest first, grouped by day, searchable, with per-entry delete.
(() => {
  const api = window.coffee;
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const dayFmtYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  let query = '';
  let offset = 0;
  let loading = false;
  let more = true;
  let seq = 0;
  let lastDay = null;
  let lastCard = null;

  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function dayLabel(t) {
    const today = startOfDay(Date.now());
    const day = startOfDay(t);
    if (day === today) return 'Today';
    if (day === today - 86400000) return 'Yesterday';
    return new Date(t).getFullYear() === new Date().getFullYear() ? dayFmt.format(t) : dayFmtYear.format(t);
  }

  function entry(h) {
    const a = document.createElement('a');
    a.className = 'entry';
    a.href = h.url;
    a.title = h.url;
    const time = Object.assign(document.createElement('span'), { className: 'time', textContent: timeFmt.format(h.last) });
    let ico;
    if (h.favicon) {
      ico = Object.assign(new Image(), { className: 'ico', src: h.favicon, alt: '' });
      ico.onerror = () => ico.replaceWith(letterIcon(h));
    } else {
      ico = letterIcon(h);
    }
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: h.title || host(h.url) });
    const where = Object.assign(document.createElement('span'), { className: 'host', textContent: host(h.url) });
    const del = Object.assign(document.createElement('button'), { className: 'del', title: 'Remove from history', innerHTML: X });
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.send('history:delete', { urls: [h.url] });
      a.classList.add('removing');
      setTimeout(() => {
        const card = a.parentElement;
        a.remove();
        // Drop the day heading when its last entry goes.
        if (card && !card.children.length) card.parentElement.remove();
        updateCount(-1);
      }, 200);
    });
    const delSite = Object.assign(document.createElement('button'), { className: 'del site', textContent: 'Clear site', title: `Remove everything from ${host(h.url)}` });
    delSite.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.send('history:clear-site', { site: host(h.url) });
      setTimeout(() => load(true), 150);
    });
    a.append(time, ico, title, where, delSite, del);
    return a;
  }

  function letterIcon(h) {
    return Object.assign(document.createElement('span'), { className: 'ico letter', textContent: host(h.url).charAt(0).toUpperCase() });
  }

  let total = 0;
  function updateCount(delta = 0) {
    total += delta;
    $('count').textContent = total ? `${total.toLocaleString()} ${total === 1 ? 'page' : 'pages'}${query ? ` matching “${query}”` : ''}` : '';
    $('empty').hidden = total > 0;
    $('empty').textContent = query ? `No history matches “${query}”` : 'Pages you visit will show up here.';
  }

  async function load(reset = false) {
    if (reset) {
      offset = 0; more = true; lastDay = null; lastCard = null;
      list.textContent = '';
    }
    if (loading || !more) return;
    loading = true;
    const mine = ++seq;
    const r = await api.invoke('history:list', { q: query, offset });
    loading = false;
    if (mine !== seq) return;
    for (const h of r.items) {
      const day = startOfDay(h.last);
      if (day !== lastDay) {
        lastDay = day;
        const section = document.createElement('section');
        section.className = 'day';
        section.appendChild(Object.assign(document.createElement('h2'), { textContent: dayLabel(h.last) }));
        lastCard = Object.assign(document.createElement('div'), { className: 'card' });
        section.appendChild(lastCard);
        list.appendChild(section);
      }
      lastCard.appendChild(entry(h));
    }
    offset += r.items.length;
    more = r.more;
    total = r.total;
    updateCount();
    // Keep filling until the page scrolls (or everything is shown).
    if (more && document.documentElement.scrollHeight <= window.innerHeight + 200) load();
  }

  // Older entries load as you scroll down.
  new IntersectionObserver((e) => { if (e[0].isIntersecting) load(); }, { rootMargin: '600px' }).observe($('more'));

  let timer = 0;
  $('search').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = $('search').value.trim(); seq++; loading = false; load(true); }, 150);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement !== $('search'))) {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    }
  });

  // Clearing asks for a second click instead of a dialog.
  const clearBtn = $('clearAll');
  const range = $('range');
  let armed = 0;
  const disarm = () => {
    clearTimeout(armed);
    armed = 0;
    clearBtn.textContent = 'Clear';
    clearBtn.classList.remove('confirm');
  };
  range.addEventListener('change', disarm);
  clearBtn.addEventListener('click', () => {
    if (!armed) {
      clearBtn.textContent = 'Click again to clear';
      clearBtn.classList.add('confirm');
      armed = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    api.send('history:clear-range', { range: range.value });
    setTimeout(() => load(true), 150);
  });

  load(true);
})();
