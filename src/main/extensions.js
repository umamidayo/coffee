'use strict';
// Chrome extension support. Opt-in: this module (and the extension libraries
// it pulls in) is only loaded when "Allow extensions" is on, so people who
// don't use extensions pay nothing for it.
//
// - electron-chrome-extensions: the chrome.* APIs Electron lacks (toolbar
//   actions + popups, tabs, context menus, storage...).
// - electron-chrome-web-store: "Add to Chrome" on chromewebstore.google.com,
//   plus automatic updates of installed extensions.
// Extensions run in normal tabs only, never in private tabs (as in Chrome).
const path = require('path');
const { app, session } = require('electron');

const PARTITION = 'persist:web';
let api = null;     // ElectronChromeExtensions instance
let store = null;   // electron-chrome-web-store module
let ses = null;

/**
 * @param {object} o
 *   ses        the normal browsing session
 *   uiSession  session of the browser chrome (for crx:// icons)
 *   win()      the current (focused) browser window
 *   tabs()     the current window's TabManager
 *   windows()  every open window: [{ win, tabs }]
 *   findTab(wc) the tab showing a webContents, in any window
 *   newWindow(url) open a window (null when multi-window is off)
 *   confirmInstall(details) -> Promise<boolean>
 */
async function init(o) {
  if (api) return api;
  ses = o.ses;
  const { ElectronChromeExtensions } = require('electron-chrome-extensions');
  store = require('electron-chrome-web-store');

  api = new ElectronChromeExtensions({
    session: ses,
    createTab(details) {
      const tab = o.tabs().create({ url: details.url || undefined, background: details.active === false });
      tab.ensureView();
      return [tab.wc, tab.mgr.win];
    },
    selectTab(wc) {
      const tab = o.findTab(wc);
      if (tab) tab.mgr.activate(tab.id);
    },
    removeTab(wc) {
      const tab = o.findTab(wc);
      if (tab) tab.mgr.close(tab.id);
    },
    // "New window" requests open a window when multi-window is on, a tab otherwise.
    createWindow(details) {
      const url = Array.isArray(details.url) ? details.url[0] : details.url;
      const state = o.newWindow(url);
      if (state) return state.win;
      if (url) o.tabs().create({ url });
      return o.win();
    },
  });

  // Extension icons in the toolbar and extension panel.
  ElectronChromeExtensions.handleCRXProtocol(o.uiSession);

  await store.installChromeWebStore({
    session: ses,
    extensionsPath: path.join(app.getPath('userData'), 'Extensions'),
    autoUpdate: true,
    // Ask before anything is installed.
    beforeInstall: async (details) => ({ action: (await o.confirmInstall(details)) ? 'allow' : 'deny' }),
  });

  // Register tabs that already exist.
  for (const w of o.windows()) {
    for (const t of w.tabs.tabs) if (t.wc && !t.private) api.addTab(t.wc, w.win);
  }
  const cur = o.tabs().active;
  if (cur && cur.wc && !cur.private) api.selectTab(cur.wc);
  return api;
}

const ready = () => !!api;

function tabCreated(tab, win) { if (api && tab.wc && !tab.private) api.addTab(tab.wc, win); }
function tabSelected(tab) { if (api && tab.wc && !tab.private) api.selectTab(tab.wc); }
function tabRemoved(tab) { if (api && tab.wc && !tab.private) { try { api.removeTab(tab.wc); } catch { /* already gone */ } } }

/** Extension items for a page's context menu: [{ label, action }]. */
function contextMenuItems(wc, params) {
  if (!api) return [];
  try {
    return api.getContextMenuItems(wc, params).map((item) => ({ label: item.label, action: () => item.click && item.click() }));
  } catch {
    return [];
  }
}

/** Installed extensions for the extensions panel. */
function list() {
  if (!ses) return [];
  const all = ses.extensions ? ses.extensions.getAllExtensions() : ses.getAllExtensions();
  return all.map((e) => ({
    id: e.id,
    name: e.name,
    version: e.version,
    description: (e.manifest && e.manifest.description) || '',
    hasAction: !!(e.manifest && (e.manifest.action || e.manifest.browser_action)),
    options: e.manifest && (e.manifest.options_ui ? e.manifest.options_ui.page : e.manifest.options_page) || '',
  })).filter((e) => !/^__MSG_/.test(e.name) || e.name);
}

async function remove(id) {
  if (!store) return;
  await store.uninstallExtension(id, { session: ses, extensionsPath: path.join(app.getPath('userData'), 'Extensions') });
}

module.exports = { init, ready, tabCreated, tabSelected, tabRemoved, contextMenuItems, list, remove, PARTITION };

// Exposed for main.js (session lookup without importing electron there).
module.exports.session = () => ses || session.fromPartition(PARTITION);
