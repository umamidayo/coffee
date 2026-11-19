'use strict';
// Preload for the browser UI and the overlay. Exposes a tiny message API.
const { contextBridge, ipcRenderer } = require('electron');

function applyTheme(t) {
  if (!t) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.dataset.mode = t.mode;
  root.style.colorScheme = t.mode;
}
function whenRoot(fn) {
  if (document.documentElement) return fn();
  const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); fn(); } });
  mo.observe(document, { childList: true });
}

// Synchronously fetch the theme so the first frame is already painted right.
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
