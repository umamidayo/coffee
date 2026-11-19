'use strict';
(() => {
  const clock = document.getElementById('clock');
  const greeting = document.getElementById('greeting');
  const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

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

  window.coffee.invoke('newtab:data').then(({ topSites, bookmarks }) => {
    const seen = new Set();
    const items = [];
    for (const it of [...bookmarks, ...topSites]) {
      const h = host(it.url);
      if (seen.has(h)) continue;
      seen.add(h);
      items.push(it);
    }
    const tiles = document.getElementById('tiles');
    items.slice(0, 8).forEach((it, i) => {
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
      a.append(face, name);
      tiles.appendChild(a);
    });
  });
})();
