'use strict';
// Preload attached to every tab. It only exposes anything on Coffee's own
// coffee:// pages; regular websites see nothing. The main process also checks
// the sender URL and limits what internal pages may do.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'coffee:') {
  const applyTheme = (t) => {
    if (!t) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
    root.dataset.mode = t.mode;
    root.style.colorScheme = t.mode;
  };
  const whenRoot = (fn) => {
    if (document.documentElement) return fn();
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); fn(); } });
    mo.observe(document, { childList: true });
  };
  { const t = ipcRenderer.sendSync('theme:sync'); whenRoot(() => applyTheme(t)); }
  ipcRenderer.on('ev:theme', (_e, t) => applyTheme(t));

  contextBridge.exposeInMainWorld('coffee', {
    send: (type, payload) => ipcRenderer.send('cmd', type, payload),
    invoke: (type, payload) => ipcRenderer.invoke('invoke', type, payload),
    on: (event, cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on(`ev:${event}`, listener);
      return () => ipcRenderer.removeListener(`ev:${event}`, listener);
    },
  });
}
