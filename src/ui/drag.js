'use strict';
/* global Icons */
// A tab being dragged out of the tab strip. Main moves these windows; we draw.
(() => {
  const api = window.coffee;
  const root = document.getElementById('root');
  const mode = new URLSearchParams(location.search).get('mode') === 'hint' ? 'hint' : 'ghost';
  document.body.className = mode;

  if (mode === 'hint') {
    root.innerHTML = '<div class="hint"><span class="label"></span></div>'
      + `<div class="sp" hidden>
          <div class="sp-glow"></div><div class="sp-divider"></div>
          <div class="sp-half" data-half="left"><div class="sp-chip"><span class="sp-ico"></span><span class="sp-title"></span></div><div class="sp-note"></div></div>
          <div class="sp-half" data-half="right"><div class="sp-chip"><span class="sp-ico"></span><span class="sp-title"></span></div><div class="sp-note"></div></div>
        </div>`;
    const hint = root.querySelector('.hint');
    const sp = root.querySelector('.sp');
    // Keep frames coming. This window is shown and hidden by the browser, and a
    // hidden window draws nothing: without frames being asked for, its fade-in
    // and slide animations never reach the screen (it stayed invisible).
    const tick = () => requestAnimationFrame(tick);
    requestAnimationFrame(tick);
    const icon = (el, t) => {
      el.textContent = '';
      el.className = 'sp-ico';
      if (t.favicon) {
        const img = new Image();
        img.alt = '';
        img.src = t.favicon;
        img.onerror = () => { img.remove(); el.innerHTML = Icons.globe; };
        el.appendChild(img);
      } else if (t.newtab) el.innerHTML = Icons.sparkle;
      else if (t.letter) { el.textContent = t.letter; el.classList.add('letter'); } else el.innerHTML = Icons.globe;
    };
    const fill = (half, t, lands) => {
      half.classList.toggle('lands', lands);
      icon(half.querySelector('.sp-ico'), t);
      half.querySelector('.sp-title').textContent = t.title || 'New Tab';
      half.querySelector('.sp-note').textContent = lands ? 'Opens here' : 'Stays here';
    };
    api.on('drag:hint', (h) => {
      const split = h.kind === 'split' && h.preview;
      const wasSplit = !sp.hidden && hint.hidden;
      hint.hidden = !!split;
      sp.hidden = !split;
      if (split) {
        // Split view: the whole page, both halves, the divider; the highlight
        // slides to the side the tab will land on.
        const { side, tab, partner } = h.preview;
        sp.dataset.side = side;
        fill(sp.querySelector('[data-half=left]'), side === 'left' ? tab : partner, side === 'left');
        fill(sp.querySelector('[data-half=right]'), side === 'right' ? tab : partner, side === 'right');
        if (!wasSplit) { sp.classList.remove('show'); void sp.offsetWidth; sp.classList.add('show'); }
        return;
      }
      hint.querySelector('.label').textContent = h.label || '';
      // new / place: an outline of the window, where it will open or move to.
      hint.dataset.kind = h.kind || '';
      // Replay the fade so each new place visibly lights up.
      hint.classList.remove('show');
      void hint.offsetWidth;
      hint.classList.add('show');
    });
    api.on('drag:end', (e) => {
      for (const el of [hint, sp]) el.classList.add(e.dropped ? 'dropped' : 'gone');
    });
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
