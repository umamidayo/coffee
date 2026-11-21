'use strict';
// What's new: this version's patch notes in full, and the three before it
// folded up underneath. The notes come from src/main/patch-notes.js.
(() => {
  const api = window.coffee;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => {
    const t = new Date(`${d}T12:00:00`);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  };

  const body = (n) => (n.sections || [])
    .map((sec) => `${sec.heading ? `<h3>${esc(sec.heading)}</h3>` : ''}<ul>${(sec.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`)
    .join('');

  function render({ version, notes }) {
    const [cur, ...earlier] = notes || [];
    $('sub').textContent = `You're on Coffee ${version}.`;
    if (!cur || cur.version !== version) {
      $('current').innerHTML = `<p class="empty">There are no notes for Coffee ${esc(version)}.</p>`;
    } else {
      $('current').innerHTML = `<div class="meta"><span class="ver">Coffee ${esc(cur.version)}</span><span class="tag">This version</span><span class="date">${esc(fmtDate(cur.date))}</span></div>`
        + `${cur.title ? `<h2>${esc(cur.title)}</h2>` : ''}<div class="body">${body(cur)}</div>`;
    }
    $('earlier').innerHTML = earlier.length
      ? `<h4 class="label">Earlier versions</h4><div class="card">${earlier.map((n) => `<details class="old">`
        + `<summary><span class="ver">Coffee ${esc(n.version)}</span>${n.title ? `<span class="sum">${esc(n.title)}</span>` : ''}<span class="date">${esc(fmtDate(n.date))}</span></summary>`
        + `<div class="body">${body(n)}</div></details>`).join('')}</div>`
      : '';
  }

  api.invoke('whatsnew:data').then(render);
})();
