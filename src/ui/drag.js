'use strict';
/* global Icons */
// A tab being dragged out of the tab strip. Main moves these windows; we draw.
(() => {
  const api = window.coffee;
  const root = document.getElementById('root');
  const mode = new URLSearchParams(location.search).get('mode') === 'hint' ? 'hint' : 'ghost';
  document.body.className = mode;

  if (mode === 'hint') {
    root.innerHTML = '<div class="hint"><span class="label"></span></div>';
    const hint = root.firstChild;
    api.on('drag:hint', (h) => {
      hint.querySelector('.label').textContent = h.label || '';
      // new / place: an outline of the window, where it will open or move to.
      hint.dataset.kind = h.kind || '';
      // Replay the fade so each new place visibly lights up.
      hint.classList.remove('show');
      void hint.offsetWidth;
      hint.classList.add('show');
    });
    api.on('drag:end', (e) => hint.classList.add(e.dropped ? 'dropped' : 'gone'));
    return;
  }

  root.innerHTML = `<div class="card">
      <div class="head"><span class="ico"></span><span class="title"></span><span class="priv" hidden>${Icons.mask}</span></div>
      <div class="thumb"></div>
      <div class="zone" hidden><span></span></div>
    </div>`;
  const card = root.firstChild;
  const $ = (sel) => card.querySelector(sel);

  // Ask the browser to move the card on every frame drawn, so it keeps pace
  // with the screen (a timer alone would step at about 64 times a second).
  const frame = () => { api.send('drag:frame'); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);

  api.on('drag:tab', (t) => {
    $('.title').textContent = t.title || 'New Tab';
    $('.priv').hidden = !t.private;
    const ico = $('.ico');
    ico.textContent = '';
    if (t.favicon) {
      const img = new Image();
      img.alt = '';
      img.src = t.favicon;
      img.onerror = () => {
        if (t.letter) { ico.textContent = t.letter; ico.classList.add('letter'); } else ico.innerHTML = Icons.globe;
      };
      ico.appendChild(img);
    } else if (t.letter) {
      ico.textContent = t.letter;
      ico.classList.add('letter');
    } else {
      ico.innerHTML = Icons.globe;
    }
  });
  api.on('drag:thumb', (src) => {
    $('.thumb').style.backgroundImage = `url("${src}")`;
    $('.thumb').classList.add('has');
  });
  api.on('drag:zone', (z) => {
    const zone = $('.zone');
    zone.hidden = !z.label;
    zone.firstChild.textContent = z.label || '';
    zone.dataset.kind = z.kind || '';
    // Over a spot where nothing would happen, the card fades back.
    card.classList.toggle('idle', z.kind === 'none');
  });
  // Released: the card drops into place, or fades away when nothing happens.
  api.on('drag:end', (e) => card.classList.add(e.dropped ? 'dropped' : 'gone'));
})();
