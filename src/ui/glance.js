'use strict';
/* global Icons */
// Glance's backdrop and bar. Main places the preview page inside #frame (below
// the bar) and tells us where that is; clicks outside it close Glance.
(() => {
  const api = window.coffee;
  const $ = (id) => document.getElementById(id);
  $('tab').innerHTML = `${Icons.window}<span>Open as tab</span>`;
  $('split').innerHTML = Icons.split;
  $('copy').innerHTML = Icons.copy;
  $('close').innerHTML = Icons.close;
  $('back').innerHTML = Icons.back;
  $('fwd').innerHTML = Icons.forward;
  $('reload').innerHTML = Icons.reload;

  let closing = false;
  const send = (what) => { if (!closing) api.send(`glance:${what}`); };
  $('tab').onclick = () => send('expand');
  $('split').onclick = () => send('split');
  $('copy').onclick = () => send('copy');
  $('close').onclick = () => send('close');
  $('back').onclick = () => send('back');
  $('fwd').onclick = () => send('forward');
  $('reload').onclick = () => send(document.body.classList.contains('loading') ? 'stop' : 'reload');
  $('backdrop').addEventListener('mousedown', (e) => { if (e.button === 0) send('close'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send('close');
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send('expand');
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  /** Where the preview sits (this view's coordinates): the frame wraps it, the bar sits on top. */
  api.on('glance:place', (r) => {
    const f = $('frame');
    f.style.left = `${r.x}px`;
    f.style.top = `${r.y - r.bar}px`;
    f.style.width = `${r.width}px`;
    f.style.height = `${r.height + r.bar}px`;
  });
  api.on('glance:page', (p) => {
    $('title').textContent = p.title || p.host || 'Loading…';
    $('host').textContent = p.host || '';
    document.body.classList.toggle('loading', !!p.loading);
    $('back').disabled = !p.canGoBack;
    $('fwd').disabled = !p.canGoForward;
    $('reload').innerHTML = p.loading ? Icons.stop : Icons.reload;
    $('reload').title = p.loading ? 'Stop' : 'Reload';
    document.body.classList.toggle('secure', !!p.secure);
    const ico = $('ico');
    if (p.favicon && ico.dataset.src !== p.favicon) {
      ico.dataset.src = p.favicon;
      ico.innerHTML = '';
      const img = new Image();
      img.alt = '';
      img.src = p.favicon;
      img.onerror = () => { ico.innerHTML = Icons.globe; };
      ico.appendChild(img);
    } else if (!p.favicon && ico.dataset.src !== '') {
      ico.dataset.src = '';
      ico.innerHTML = Icons.globe;
    }
  });
  api.on('glance:show', () => { closing = false; document.body.className = 'open'; });
  api.on('glance:hide', () => { closing = true; document.body.classList.add('closing'); });
})();
