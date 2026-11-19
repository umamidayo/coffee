'use strict';
// Runs at document start in every web frame (registered on the session).
// Fetches this page's cosmetic rules synchronously and injects uBO scriptlets
// into the main world before any page script can run, then keeps hiding new
// ad elements as the DOM changes. Kept tiny: it runs in every frame.
const { ipcRenderer, webFrame } = require('electron');

(() => {
  const url = location.href;
  if (!/^https?:/.test(url)) return;

  let first;
  try { first = ipcRenderer.sendSync('adblock:start', url); } catch { return; }
  if (!first) return;

  // Scriptlets first: they must patch globals (fetch, JSON, setTimeout...)
  // before any page script runs. World 0 is the page's own JavaScript world;
  // plain webFrame.executeJavaScript would run in this preload's isolated world
  // and the patches would never reach the page. Each scriptlet bundles its own
  // helpers (safeSelf, JSONPath...) at top level, so give each its own scope.
  if (first.scripts.length) {
    const code = first.scripts.map((s) => `(function(){try{\n${s}\n}catch(e){}})();`).join('\n');
    try { webFrame.executeJavaScriptInIsolatedWorld(0, [{ code }]); } catch { /* ignore */ }
  }
  if (first.styles) webFrame.insertCSS(first.styles, { cssOrigin: 'user' });

  // Generic cosmetic rules depend on which classes / ids / hrefs exist.
  const known = { classes: new Set(), ids: new Set(), hrefs: new Set() };
  const SKIP = new Set(['BR', 'HEAD', 'LINK', 'META', 'SCRIPT', 'STYLE', 'S']);

  function collect(roots) {
    const fresh = { classes: [], ids: [], hrefs: [] };
    const add = (kind, v) => { if (v && !known[kind].has(v)) { known[kind].add(v); fresh[kind].push(v); } };
    const visit = (el) => {
      if (SKIP.has(el.nodeName)) return;
      if (el.id) add('ids', el.id);
      for (const c of el.classList) add('classes', c);
      const href = el.getAttribute('href');
      if (href) add('hrefs', href);
    };
    for (const root of roots) {
      if (root.nodeType !== 1) continue;
      visit(root);
      for (const el of root.querySelectorAll('[id],[class],[href]')) visit(el);
    }
    return fresh.classes.length || fresh.ids.length || fresh.hrefs.length ? fresh : null;
  }

  function send(features) {
    if (!features) return;
    ipcRenderer.invoke('adblock:dom', url, features).then((css) => {
      if (css) webFrame.insertCSS(css, { cssOrigin: 'user' });
    }).catch(() => {});
  }

  window.addEventListener('DOMContentLoaded', () => {
    send(collect([document.documentElement]));
    if (!first.observe) return;

    // Batch mutations: at most one IPC per 50ms, and always within 1s.
    let pending = new Set();
    let timer = 0;
    let maxTimer = 0;
    const flush = () => {
      clearTimeout(timer); clearTimeout(maxTimer);
      timer = maxTimer = 0;
      const nodes = [...pending];
      pending = new Set();
      send(collect(nodes));
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') pending.add(m.target);
        else for (const n of m.addedNodes) if (n.nodeType === 1) pending.add(n);
      }
      if (pending.size > 500) return flush();
      clearTimeout(timer);
      timer = setTimeout(flush, 50);
      if (!maxTimer) maxTimer = setTimeout(flush, 1000);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'href'] });
  }, { once: true });
})();
