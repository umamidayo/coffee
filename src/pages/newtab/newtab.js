'use strict';
(() => {
  const clock = document.getElementById('clock');
  const greeting = document.getElementById('greeting');
  const tiles = document.getElementById('tiles');
  const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';

  function tick() {
    const now = new Date();
    clock.textContent = fmt.format(now).replace(/\s?[AP]M$/i, '');
    const h = now.getHours();
    const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    greeting.textContent = `${part} · ${day.format(now)}`;
    // Wake exactly at the next minute boundary instead of polling.
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 20);
  }
  tick();

  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

  function tile(it, i) {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = it.url;
    a.style.animationDelay = `${120 + i * 35}ms`;
    const face = document.createElement('div');
    face.className = 'face';
    const letter = () => {
      face.textContent = '';
      const s = document.createElement('span');
      s.className = 'letter';
      s.textContent = host(it.url).charAt(0).toUpperCase();
      face.appendChild(s);
    };
    if (it.favicon) {
      const img = document.createElement('img');
      img.src = it.favicon;
      img.alt = '';
      img.onerror = letter;
      face.appendChild(img);
    } else letter();
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = it.title || host(it.url);
    // Remove from the new tab page (doesn't touch history or bookmarks).
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Remove';
    remove.innerHTML = CLOSE;
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.coffee.send('newtab:hide', { url: it.url });
      a.classList.add('removing');
      a.addEventListener('animationend', () => { a.remove(); load(false); }, { once: true });
    });
    a.append(remove, face, name);
    return a;
  }

  let shown = new Set();
  async function load(animate = true) {
    const { show, shortcuts } = await window.coffee.invoke('newtab:data');
    document.body.classList.toggle('no-shortcuts', !show);
    if (!show) { tiles.textContent = ''; shown = new Set(); return; }
    const key = shortcuts.map((s) => s.url).join('|');
    if (!animate && key === [...shown].join('|')) return;
    tiles.textContent = '';
    shortcuts.forEach((it, i) => {
      const t = tile(it, i);
      if (!animate && shown.has(it.url)) t.style.animation = 'none';
      tiles.appendChild(t);
    });
    shown = new Set(shortcuts.map((s) => s.url));
  }
  load();
  // Pick up setting changes when you come back to this tab.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
})();
