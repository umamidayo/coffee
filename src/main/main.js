'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, session, ipcMain, protocol, net, nativeTheme, clipboard, dialog, shell, screen,
} = require('electron');

const data = require('./data');
const themes = require('./themes');
const adblock = require('./adblock');
const downloads = require('./downloads');
const Overlay = require('./overlay');
const updater = require('./updater');
const compat = require('./compat');
const importer = require('./importer');
const { TabManager, NEWTAB, isInternal, displayUrl } = require('./tabs');

// ---------------------------------------------------------------------------
// Process-level setup (must happen before `ready`).
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Electron honors a single registration before startup, so every custom
// scheme goes here. `crx` serves extension icons (only used when extensions
// are turned on); registering it here also stops the extension library from
// re-registering schemes and dropping `coffee`.
protocol.registerSchemesAsPrivileged([
  { scheme: 'coffee', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: 'crx', privileges: { bypassCSP: true } },
]);

// Electron's honest user agent, kept for Google sign-in (see compat.js).
const ELECTRON_UA = app.userAgentFallback;

// Present as a normal Chrome so sites don't serve degraded pages.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, 'i'), '');

app.commandLine.appendSwitch('enable-features', 'ParallelDownloading');

const ROOT = path.join(__dirname, '..');
const UI_PRELOAD = path.join(ROOT, 'preload', 'ui.js');
const PAGES = path.join(ROOT, 'pages');

// Layout metrics, mirrored in src/ui/ui.css.
const SIDEBAR_W = 56;
const TOPBAR_H = 46;
const BOOKMARKS_H = 32;
const TABSTRIP_H = 38;  // tabs on top
const PEEK_W = 248;     // compact sidebar panel
const RADIUS = 0;       // page runs to the window edges: no frame
const M = 12; // shadow margin around overlay panels (matches overlay.css)

let win = null;
let ui = null;
let overlay = null;
let tabs = null;
let webSession = null;
let theme = themes.resolve(data.settings.data.theme);
let htmlFullscreenTab = null;
let sessionTimer = null;

const emit = (ev, payload) => {
  if (ui && !ui.isDestroyed()) ui.send(`ev:${ev}`, payload);
};

/** Move keyboard focus out of the page and into the address bar. */
/**
 * Open (or step through) find in page. Like the address bar, the find box
 * lives in the browser chrome, so keyboard focus must move there from the
 * page first or typing would keep going to the page.
 */
function openFind(which = 'find:open') {
  if (!ui || ui.isDestroyed()) return;
  ui.focus();
  emit(which);
}

function focusUrlbar() {
  if (!ui || ui.isDestroyed()) return;
  ui.focus();
  emit('focus-urlbar', { select: true });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme() {
  theme = themes.resolve(data.settings.data.theme);
  nativeTheme.themeSource = theme.mode;
  if (win) win.setBackgroundColor(theme.vars['--bg']);
  const targets = [ui, overlay && overlay.wc];
  if (tabs) {
    for (const t of tabs.tabs) {
      if (t.wc && isInternal(t.url)) targets.push(t.wc);
      t.applyBackground();
    }
  }
  for (const wc of targets) if (wc && !wc.isDestroyed()) wc.send('ev:theme', theme);
}

// ---------------------------------------------------------------------------
// Window & layout
// ---------------------------------------------------------------------------

function windowState() {
  return {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen() && !htmlFullscreenTab,
    focused: win.isFocused(),
  };
}

function bookmarksBarShown() {
  return !!data.settings.data.bookmarksBar && data.children(null).length > 0;
}

const tabsOnTop = () => data.settings.data.tabLayout === 'horizontal';
const compactSidebar = () => !tabsOnTop() && !!data.settings.data.compactSidebar;

/** Where the chrome ends and the page begins (mirrors src/ui/ui.css). */
function chromeTop() {
  return TOPBAR_H + (bookmarksBarShown() ? BOOKMARKS_H : 0);
}

function pageBounds() {
  const [w, h] = win.getContentSize();
  if (htmlFullscreenTab) return { bounds: { x: 0, y: 0, width: w, height: h }, radius: 0 };
  const top = chromeTop() + (tabsOnTop() ? TABSTRIP_H : 0);
  const left = tabsOnTop() || compactSidebar() ? 0 : SIDEBAR_W;
  return {
    bounds: { x: left, y: top, width: Math.max(0, w - left), height: Math.max(0, h - top) },
    radius: RADIUS,
  };
}

// ---------------------------------------------------------------------------
// Compact sidebar: the side tabs are hidden; touching the left edge of the
// window slides a panel out over the page (in the overlay, so the page never
// resizes). The page covers the edge, so the cursor is sampled cheaply while
// the window is focused and compact mode is on, instead of listening for
// mouse events.
// ---------------------------------------------------------------------------

let peekTimer = null;
let peekArmed = true;

function updatePeekWatch() {
  const want = !!win && compactSidebar() && win.isFocused() && !htmlFullscreenTab;
  if (want && !peekTimer) peekTimer = setInterval(peekTick, 40);
  else if (!want && peekTimer) { clearInterval(peekTimer); peekTimer = null; }
  if (!want && overlay && overlay.isOpen('sidebar')) overlay.close();
}

function peekTick() {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getContentBounds();
  const x = p.x - b.x;
  const y = p.y - b.y;
  const top = chromeTop();
  // Edge hit: the first couple of pixels (or the resize border just outside).
  const atEdge = x <= 2 && x >= -10 && y >= top && y <= b.height;
  if (atEdge && peekArmed) {
    peekArmed = false;
    if (!overlay.isOpen() || overlay.type === 'tooltip') showPeek();
  } else if (x > 16) {
    peekArmed = true; // re-arm once the cursor has moved away from the edge
  }
}

const peekTitles = () => data.settings.data.tabTitles !== false;

function showPeek() {
  const [, h] = win.getContentSize();
  const top = chromeTop();
  const width = peekTitles() ? PEEK_W : SIDEBAR_W + 8;
  overlay.open('sidebar', { x: 0, y: top, width: width + M, height: h - top }, { ...tabs.snapshot(), titles: peekTitles() });
}

function toggleTabLayout() { setSetting('tabLayout', tabsOnTop() ? 'vertical' : 'horizontal'); }
function toggleCompact() { setSetting('compactSidebar', !data.settings.data.compactSidebar); }

function layout() {
  const tab = tabs && tabs.active;
  if (!tab || !tab.view) return;
  const { bounds, radius } = pageBounds();
  tab.view.setBounds(bounds);
  tab.view.setBorderRadius(radius);
}

/** Pin a privileged webContents to its own page: no navigation, popups, or webviews. */
function lockDown(wc) {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

function createWindow() {
  const s = data.settings.data;
  const b = s.windowBounds || {};
  win = new BrowserWindow({
    width: b.width || 1360,
    height: b.height || 860,
    x: b.x,
    y: b.y,
    minWidth: 520,
    minHeight: 360,
    frame: false,
    show: false,
    title: 'Coffee',
    icon: path.join(ROOT, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: theme.vars['--bg'],
    webPreferences: {
      preload: UI_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  ui = win.webContents;
  ui.loadFile(path.join(ROOT, 'ui', 'index.html'));
  if (s.maximized) win.maximize();

  win.once('ready-to-show', () => { win.show(); updatePeekWatch(); });

  overlay = new Overlay(win, UI_PRELOAD);
  overlay.onState = (type) => emit('overlay', type);
  overlay.wc.on('before-input-event', (e, input) => onInput(e, input, null));
  ui.on('before-input-event', (e, input) => onInput(e, input, null));
  // The chrome and overlay carry the privileged preload: never let them load
  // anything else (e.g. a link or file dropped onto the title bar).
  lockDown(ui);
  lockDown(overlay.wc);

  const sendState = () => { layout(); emit('window', windowState()); };
  win.on('resize', layout);
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, sendState);
  win.on('focus', () => { emit('window', windowState()); updatePeekWatch(); });
  win.on('blur', () => {
    emit('window', windowState());
    updatePeekWatch();
    if (overlay.type !== 'suggest') overlay.close();
  });

  // Mouse back/forward buttons.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
    else if (cmd === 'browser-forward') goForward();
  });

  win.on('close', () => {
    data.settings.data.maximized = win.isMaximized();
    data.settings.data.windowBounds = win.getNormalBounds();
    data.settings.save();
    tabs.saveSession();
  });
  win.on('closed', () => {
    tabs.destroy();
    win = null;
  });

  tabs = new TabManager(win, webSession, {
    radius: () => pageBounds().radius,
    themeBg: () => theme.vars['--bg'],
    layout,
    render: (snap) => {
      emit('tabs', snap);
      overlay.update('sidebar', { ...snap, titles: peekTitles() });
      // Session snapshots walk every tab's history, so keep them rare.
      clearTimeout(sessionTimer);
      sessionTimer = setTimeout(() => tabs && tabs.saveSession(), 2000);
    },
    activated: (tab) => {
      if (ext) ext.tabSelected(tab);
      if (overlay.isOpen()) overlay.close();
      if (tab.url.startsWith(NEWTAB)) {
        // A freshly shown page takes keyboard focus as it attaches and loads,
        // without a 'focus' event, so keep handing focus back to the address
        // bar while it settles (until you type there or click the page).
        tab.urlbarUntil = Date.now() + 2500;
        focusUrlbar();
        const reclaim = () => {
          if (tab !== tabs.active || !(tab.urlbarUntil > Date.now()) || !ui || ui.isDestroyed()) return;
          if (!ui.isFocused()) focusUrlbar();
        };
        for (const ms of [30, 120, 300, 700]) setTimeout(reclaim, ms);
        if (tab.wc) {
          tab.wc.once('dom-ready', reclaim);
          tab.wc.once('did-finish-load', () => { reclaim(); setTimeout(reclaim, 50); });
        }
      }
      else if (tab.wc) tab.wc.focus();
      emit('find:close');
    },
    bookmarksChanged: bookmarksChanged,
    htmlFullscreen: (tab, on) => {
      htmlFullscreenTab = on ? tab : null;
      win.setFullScreen(on);
      updatePeekWatch();
      layout();
      emit('window', windowState());
    },
    found: (tab, r) => {
      if (tab === tabs.active) emit('find:result', { active: r.activeMatchOrdinal, matches: r.matches });
    },
    hoverUrl: (tab, url) => { if (tab === tabs.active) emit('hover-url', url); },
    contextMenu: (tab, params) => pageMenu(tab, params),
    input: (e, input, tab) => onInput(e, input, tab),
    pageFocus: (tab) => {
      if (tab === tabs.active && tab.urlbarUntil > Date.now()) {
        focusUrlbar();
        return;
      }
      if (overlay.isOpen() && overlay.type !== 'tooltip') overlay.close();
      if (tab === tabs.active) emit('page-focus');
    },
    zoom: (tab, dir) => zoom(dir, tab),
    privateSession: getPrivateSession,
    privateEnded: endPrivateBrowsing,
    viewCreated: (tab) => { if (ext) ext.tabCreated(tab, win); },
    viewDestroyed: (tab) => { if (ext) ext.tabRemoved(tab); },
  });
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function activeWc() {
  const t = tabs && tabs.active;
  return t ? t.wc : null;
}

function navigate(url, { newTab = false, background = false } = {}) {
  if (!url) return;
  if (newTab || background) {
    tabs.create({ url, background, after: tabs.active });
    return;
  }
  const tab = tabs.active;
  if (!tab) return tabs.create({ url });
  tab.ensureView();
  tab.wc.loadURL(url).catch(() => {});
  tab.wc.focus();
}

function goBack() { const wc = activeWc(); if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
function goForward() { const wc = activeWc(); if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }

function reload(hard = false) {
  const tab = tabs.active;
  if (!tab || !tab.wc) return;
  if (tab.url.startsWith('coffee://error/')) {
    const u = displayUrl(tab.url);
    if (u) return tab.wc.loadURL(u).catch(() => {});
  }
  if (hard) tab.wc.reloadIgnoringCache();
  else tab.wc.reload();
}

function zoom(dir, tab = tabs.active) {
  const wc = tab && tab.wc;
  if (!wc) return;
  const levels = [-3.8, -3, -2.2, -1.6, -1, -0.5, 0, 0.5, 1, 1.6, 2.2, 3, 3.8, 5];
  const cur = wc.getZoomLevel();
  let next = 0;
  if (dir > 0) next = levels.find((l) => l > cur + 0.01) ?? cur;
  else if (dir < 0) next = [...levels].reverse().find((l) => l < cur - 0.01) ?? cur;
  wc.setZoomLevel(next);
  tab.zoom = Math.round(100 * 1.2 ** next);
  if (tab.zoom === 100) tab.zoom = 0;
  tabs.changed();
}

function bookmarksChanged() {
  emit('bookmarks', data.bookmarks.data);
  emit('settings', publicSettings());
  layout();
}

function toggleBookmarksBar() {
  data.settings.data.bookmarksBar = !data.settings.data.bookmarksBar;
  data.settings.save();
  layout();
  emit('settings', publicSettings());
}

function publicSettings() {
  const s = data.settings.data;
  return {
    bookmarksBar: s.bookmarksBar,
    bookmarksBarShown: bookmarksBarShown(),
    tabLayout: tabsOnTop() ? 'horizontal' : 'vertical',
    compactSidebar: !!data.settings.data.compactSidebar,
    tabTitles: data.settings.data.tabTitles !== false,
    extensions: !!ext,
    adblock: s.adblock,
    searchEngine: s.searchEngine,
    update: updater.status,
    searchEngineName: (data.SEARCH_ENGINES[s.searchEngine] || data.SEARCH_ENGINES.google).name,
  };
}

function openSettings(section) {
  const url = `coffee://settings/${section ? `#${String(section).replace(/[^a-z-]/g, '')}` : ''}`;
  const existing = tabs.tabs.find((t) => t.url.startsWith('coffee://settings'));
  if (existing) {
    tabs.activate(existing.id);
    if (section && existing.wc) existing.wc.loadURL(url).catch(() => {});
  } else {
    tabs.create({ url });
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (work no matter which surface has focus)
// ---------------------------------------------------------------------------

function onInput(e, input, tab) {
  if (input.type !== 'keyDown') return;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const ctrl = input.control || input.meta;
  const { shift, alt } = input;
  let handled = true;

  if (ctrl && !alt) {
    if (key === 't' && !shift) tabs.create();
    else if (key === 'n' && shift) tabs.create({ private: true });
    else if (key === 't' && shift) tabs.reopenClosed();
    else if ((key === 'w' && !shift) || key === 'F4') tabs.active && tabs.close(tabs.activeId);
    else if (key === 'Tab' || key === 'PageDown' || key === 'PageUp') tabs.cycle(key === 'PageUp' || (key === 'Tab' && shift) ? -1 : 1);
    else if (/^[1-9]$/.test(key) && !shift) {
      const n = Number(key);
      const t = n === 9 ? tabs.tabs[tabs.tabs.length - 1] : tabs.tabs[n - 1];
      if (t) tabs.activate(t.id);
    }
    else if (key === 'l' || key === 'k' || key === 'e') focusUrlbar();
    else if (key === 'r' || key === 'F5') reload(shift || key === 'F5');
    else if (key === 'd' && !shift) starBookmark();
    else if (key === 'b' && shift) toggleBookmarksBar();
    else if (key === 'j') toggleDownloads();
    else if (key === 'f' && !shift) openFind();
    else if (key === 'g') openFind(shift ? 'find:prev' : 'find:next');
    else if (key === '=' || key === '+') zoom(1);
    else if (key === '-' || key === '_') zoom(-1);
    else if (key === '0') zoom(0);
    else if (key === 'p' && !shift) activeWc() && activeWc().print();
    else if (key === 'i' && shift) toggleDevTools();
    else if (key === ',') openSettings();
    else if (key === 'u' && !shift) { const t = tabs.active; if (t && /^https?:/.test(t.url)) navigate(`view-source:${t.url}`, { newTab: true }); }
    else handled = false;
  } else if (alt && !ctrl) {
    if (key === 'ArrowLeft') goBack();
    else if (key === 'ArrowRight') goForward();
    else if (key === 'd') focusUrlbar();
    else if (key === 'Home') navigate(NEWTAB);
    else handled = false;
  } else if (!ctrl && !alt) {
    if (key === 'F5') reload(false);
    else if (key === 'F6') focusUrlbar();
    else if (key === 'F11') { htmlFullscreenTab = null; win.setFullScreen(!win.isFullScreen()); }
    else if (key === 'F12') toggleDevTools();
    else if (key === 'Escape' && htmlFullscreenTab && tab === htmlFullscreenTab) {
      tab.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
    }
    else if (key === 'Escape' && overlay.isOpen()) overlay.close();
    else if (key === 'Escape' && tab && tab.wc && tab.wc.isLoading()) { tab.wc.stop(); handled = false; }
    else handled = false;
  } else handled = false;

  if (handled) e.preventDefault();
}

function toggleDevTools() {
  const wc = activeWc();
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

// ---------------------------------------------------------------------------
// Overlay popups
// ---------------------------------------------------------------------------

function menuSize(items) {
  let h = 10;
  for (const it of items) h += it.sep ? 9 : 30;
  return { width: 256 + 2 * M, height: h + 2 * M };
}

/** Show a context menu at window coords (x, y). */
function showMenu(x, y, items) {
  const visible = items.filter((it, i) => !(it.sep && (i === 0 || items[i - 1].sep || i === items.length - 1)));
  const size = menuSize(visible);
  const [w, h] = win.getContentSize();
  let left = x - M + 2;
  let top = y - M + 2;
  if (left + size.width > w) left = x - size.width + M - 2;
  if (top + size.height > h) top = Math.max(0, y - size.height + M - 2);
  overlay.open('menu', { x: left, y: top, ...size },
    { items: visible.map(({ label, accel, disabled, sep, checked }) => ({ label, accel, disabled, sep, checked })) },
    { focus: true, onPick: (p) => { const it = visible[p.index]; if (it && !it.disabled && it.action) it.action(); } });
}

function pageMenu(tab, params) {
  const wc = tab.wc;
  if (!wc) return;
  const items = [];
  const sep = { sep: true };

  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 4)) items.push({ label: s, action: () => wc.replaceMisspelling(s) });
    if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', disabled: true });
    items.push({ label: 'Add to dictionary', action: () => webSession.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push(sep);
  }
  if (params.linkURL) {
    items.push(
      { label: 'Open link in new tab', action: () => tabs.create({ url: params.linkURL, background: true, after: tab, private: tab.private }) },
      { label: 'Open link in private tab', action: () => tabs.create({ url: params.linkURL, after: tab, private: true }) },
      { label: 'Copy link address', action: () => clipboard.writeText(params.linkURL) },
      sep,
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Open image in new tab', action: () => tabs.create({ url: params.srcURL, background: true, after: tab }) },
      { label: 'Copy image', action: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', action: () => clipboard.writeText(params.srcURL) },
      { label: 'Save image', action: () => wc.downloadURL(params.srcURL) },
      sep,
    );
  }
  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: 'Undo', accel: 'Ctrl+Z', disabled: !f.canUndo, action: () => wc.undo() },
      { label: 'Redo', accel: 'Ctrl+Y', disabled: !f.canRedo, action: () => wc.redo() },
      sep,
      { label: 'Cut', accel: 'Ctrl+X', disabled: !f.canCut, action: () => wc.cut() },
      { label: 'Copy', accel: 'Ctrl+C', disabled: !f.canCopy, action: () => wc.copy() },
      { label: 'Paste', accel: 'Ctrl+V', disabled: !f.canPaste, action: () => wc.paste() },
      { label: 'Select all', accel: 'Ctrl+A', action: () => wc.selectAll() },
      sep,
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim();
    const short = text.length > 22 ? `${text.slice(0, 22)}…` : text;
    items.push(
      { label: 'Copy', accel: 'Ctrl+C', action: () => wc.copy() },
      { label: `Search for “${short}”`, action: () => tabs.create({ url: data.toUrl(text), after: tab }) },
      sep,
    );
  }
  if (!params.linkURL && !params.isEditable && !params.selectionText) {
    items.push(
      { label: 'Back', accel: 'Alt+←', disabled: !wc.navigationHistory.canGoBack(), action: goBack },
      { label: 'Forward', accel: 'Alt+→', disabled: !wc.navigationHistory.canGoForward(), action: goForward },
      { label: 'Reload', accel: 'Ctrl+R', action: () => reload() },
      sep,
      { label: 'Print…', accel: 'Ctrl+P', action: () => wc.print() },
      { label: 'View page source', accel: 'Ctrl+U', disabled: !/^https?:/.test(tab.url), action: () => navigate(`view-source:${tab.url}`, { newTab: true }) },
      sep,
    );
  }
  if (ext && !tab.private) {
    const extra = ext.contextMenuItems(wc, params);
    if (extra.length) items.push(...extra, sep);
  }
  items.push({ label: 'Inspect', accel: 'F12', action: () => { wc.inspectElement(params.x, params.y); } });

  const { bounds } = pageBounds();
  showMenu(bounds.x + params.x, bounds.y + params.y, items);
}

function tabMenu(id, x, y) {
  const tab = tabs.get(id);
  if (!tab) return;
  const i = tabs.tabs.indexOf(tab);
  const shown = displayUrl(tab.url);
  showMenu(x, y, [
    { label: 'Reload', action: () => { tab.ensureView(); tab.wc.reload(); } },
    { label: 'Duplicate', disabled: !shown, action: () => tabs.create({ url: shown, after: tab }) },
    { label: tab.muted ? 'Unmute tab' : 'Mute tab', action: () => {
      tab.muted = !tab.muted;
      if (tab.wc) tab.wc.setAudioMuted(tab.muted);
      tabs.changed();
    } },
    { label: 'Copy link', disabled: !shown, action: () => clipboard.writeText(shown) },
    { label: 'Put to sleep', disabled: tab.id === tabs.activeId || !tab.wc, action: () => tab.sleep() },
    { sep: true },
    { label: 'Close tab', accel: 'Ctrl+W', action: () => tabs.close(tab.id) },
    { label: 'Close other tabs', disabled: tabs.tabs.length < 2, action: () => {
      for (const t of [...tabs.tabs]) if (t !== tab) tabs.close(t.id);
    } },
    { label: 'Close tabs below', disabled: i === tabs.tabs.length - 1, action: () => {
      for (const t of tabs.tabs.slice(i + 1)) tabs.close(t.id);
    } },
  ]);
}

function sidebarMenu(x, y) {
  const recent = tabs.closed.slice(-8).reverse();
  const items = [
    { label: 'New tab', accel: 'Ctrl+T', action: () => tabs.create() },
    { label: 'New private tab', accel: 'Ctrl+Shift+N', action: () => tabs.create({ private: true }) },
    { label: 'Reopen closed tab', accel: 'Ctrl+Shift+T', disabled: !recent.length, action: () => tabs.reopenClosed() },
  ];
  if (recent.length) {
    items.push({ sep: true }, { label: 'Recently closed', disabled: true });
    recent.forEach((c, i) => {
      const title = c.init.title || displayUrl(c.init.url) || 'Untitled';
      items.push({ label: title.length > 34 ? `${title.slice(0, 33)}…` : title, action: () => tabs.reopenClosed(tabs.closed.length - 1 - i) });
    });
  }
  showMenu(x, y, items);
}

function bookmarkMenu(id, x, y) {
  const bm = data.itemById(id);
  if (!bm) return;
  if (bm.type === 'folder') {
    const inside = data.allBookmarks().filter((b) => data.subtree(id).has(b.id));
    showMenu(x, y, [
      { label: `Open all (${inside.length})`, disabled: !inside.length, action: () => openAll(inside) },
      { sep: true },
      { label: 'New folder inside…', action: () => folderEditor({ parent: id }) },
      { label: 'Rename…', action: () => folderEditor({ id }) },
      { label: 'Delete folder', action: () => deleteItem(id) },
    ]);
    return;
  }
  showMenu(x, y, [
    { label: 'Open', action: () => navigate(bm.url) },
    { label: 'Open in new tab', action: () => navigate(bm.url, { background: true }) },
    { label: 'Copy link', action: () => clipboard.writeText(bm.url) },
    { sep: true },
    { label: 'Edit…', action: () => editBookmark(bm, null) },
    { label: 'Delete', action: () => deleteItem(id) },
  ]);
}

/** Right-click on empty bookmarks-bar space. */
function bookmarksBarMenu(x, y) {
  const tab = tabs.active;
  const url = tab && displayUrl(tab.url);
  showMenu(x, y, [
    { label: 'New folder…', action: () => folderEditor({ parent: null }) },
    { label: 'Bookmark this page', accel: 'Ctrl+D', disabled: !url || isInternal(url), action: () => starBookmark() },
    { sep: true },
    { label: 'Hide bookmarks bar', accel: 'Ctrl+Shift+B', action: toggleBookmarksBar },
  ]);
}

function openAll(list) {
  for (const b of list.slice(0, 30)) tabs.create({ url: b.url, background: true, after: tabs.active });
}

/** Delete a bookmark; a non-empty folder asks first. */
function deleteItem(id) {
  const item = data.itemById(id);
  if (!item) return;
  const count = data.subtree(id).size - 1;
  if (item.type !== 'folder' || count === 0) {
    data.removeBookmark(id);
    bookmarksChanged();
    return;
  }
  const [w, h] = win.getContentSize();
  const width = 340 + 2 * M;
  const height = 132 + 2 * M;
  overlay.open('confirm', { x: (w - width) / 2, y: Math.max(TOPBAR_H, h / 2 - height), width, height }, {
    title: `Delete “${item.title}”?`,
    message: `This also deletes the ${count} ${count === 1 ? 'item' : 'items'} inside it.`,
    confirm: 'Delete',
  }, { focus: true, onPick: (p) => { if (p.ok) { data.removeBookmark(id); bookmarksChanged(); } } });
}

/** Create ({ parent }) or rename ({ id }) a folder. */
function folderEditor({ id = null, parent = null }) {
  const folder = id ? data.itemById(id) : null;
  const [w] = win.getContentSize();
  const width = 320 + 2 * M;
  overlay.open('folder', { x: (w - width) / 2, y: TOPBAR_H + 4, width, height: 132 + 2 * M },
    { title: folder ? folder.title : '', rename: !!folder },
    { focus: true, onPick: (p) => {
      const title = String(p.title || '').trim() || 'New folder';
      if (folder) data.updateBookmark(id, { title });
      else data.addFolder(title, parent);
      bookmarksChanged();
    } });
}

/** Dropdown listing a folder's contents, anchored under its bar button. */
let folderAnchor = null;
function openFolder(id, rect) {
  const folder = data.itemById(id);
  if (!folder || folder.type !== 'folder') return;
  if (rect) folderAnchor = rect;
  const r = folderAnchor || { x: 80, y: TOPBAR_H, width: 0, height: BOOKMARKS_H - 4 };
  const items = data.children(id).map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url || '', favicon: b.favicon || '' }));
  const back = folder.parent ? data.itemById(folder.parent) : null;
  const rows = Math.min(Math.max(items.length, 1), 12);
  const width = 280 + 2 * M;
  const height = 8 + (back ? 34 : 0) + rows * 32 + (items.some((b) => b.type === 'bookmark') ? 41 : 0) + 8 + 2 * M;
  overlay.open('bmfolder', { x: r.x - M, y: r.y + r.height + 4 - M, width, height },
    { id, title: folder.title, items, back: back ? { id: back.id, title: back.title } : null },
    { focus: true });
}

let lastStarRect = null;
function starBookmark(rect) {
  if (rect) lastStarRect = rect;
  const tab = tabs.active;
  const url = tab && displayUrl(tab.url);
  if (!url || isInternal(url)) return;
  let bm = data.findBookmark(url);
  const created = !bm;
  if (!bm) {
    bm = data.addBookmark({ url, title: tab.title, favicon: tab.favicon });
    bookmarksChanged();
  }
  editBookmark(bm, lastStarRect, created);
}

function editBookmark(bm, rect, created = false) {
  const [w] = win.getContentSize();
  const width = 320 + 2 * M;
  const r = rect || { x: w - 360, y: TOPBAR_H - 6, width: 0, height: 0 };
  overlay.open('bookmark', { x: r.x + r.width - width + M + 6, y: r.y + r.height + 6 - M, width, height: 214 + 2 * M },
    { id: bm.id, title: bm.title, url: bm.url, created, parent: bm.parent || '', folders: data.folderTree() },
    { focus: true });
}

function toggleDownloads(rect) {
  if (overlay.isOpen('downloads')) return overlay.close();
  const r = rect || lastDownloadsRect;
  if (!r) return;
  lastDownloadsRect = r;
  const sum = downloads.summary();
  const n = Math.min(Math.max(sum.items.length, 1), 6);
  const width = 360 + 2 * M;
  const height = (sum.items.length ? 50 + n * 58 + 8 : 150) + 2 * M;
  overlay.open('downloads', { x: r.x + r.width - width + M + 4, y: r.y + r.height + 4 - M, width, height }, sum, { focus: true });
}
let lastDownloadsRect = null;

function showSuggest({ rect, items, selected }) {
  if (!items || !items.length) return overlay.isOpen('suggest') && overlay.close();
  const height = 12 + items.length * 40 + 2 * M;
  overlay.open('suggest', { x: rect.x - M, y: rect.y + rect.height + 6 - M, width: rect.width + 2 * M, height },
    { items, selected },
    { onPick: (p) => { emit('urlbar:blur'); navigate(p.url, { newTab: p.newTab }); } });
}

function showTooltip({ text, x, y, width }) {
  if (overlay.isOpen() && overlay.type !== 'tooltip') return;
  const w = Math.ceil(width) + 22 + 2 * M;
  overlay.open('tooltip', { x: x - M, y: y - 15 - M, width: w, height: 30 + 2 * M }, { text });
}

function shieldMenu(rect) {
  const tab = tabs.active;
  const on = data.settings.data.adblock;
  const n = tab ? tab.blocked : 0;
  showMenu(rect.x, rect.y + rect.height + 4, [
    { label: on ? `${n} ${n === 1 ? 'ad or tracker' : 'ads & trackers'} blocked here` : 'Ad blocking is off', disabled: true },
    { label: `${data.settings.data.blockedTotal.toLocaleString()} blocked in total`, disabled: true },
    { sep: true },
    { label: on ? 'Turn off ad blocking' : 'Turn on ad blocking', action: () => setSetting('adblock', !on) },
  ]);
}

// ---------------------------------------------------------------------------
// Extensions (opt-in; nothing is loaded unless the setting is on)
// ---------------------------------------------------------------------------

let ext = null;

async function startExtensions() {
  const mod = require('./extensions');
  await mod.init({
    ses: webSession,
    uiSession: session.defaultSession,
    win: () => win,
    tabs,
    confirmInstall: confirmExtensionInstall,
  });
  ext = mod;
  emit('settings', publicSettings());
}

/** Ask before an extension is installed, listing what it may access. */
function confirmExtensionInstall(details) {
  return new Promise((resolve) => {
    const m = details.manifest || {};
    const perms = [...(m.permissions || []), ...(m.host_permissions || [])].map(String);
    const readable = [];
    if (perms.some((p) => /<all_urls>|^\*:\/\/\*\/\*|^https?:\/\/\*\/\*/.test(p))) readable.push('Read and change data on all websites');
    else if (perms.some((p) => /:\/\//.test(p))) readable.push('Read and change data on some websites');
    if (perms.includes('tabs') || perms.includes('history')) readable.push('Read your browsing history');
    if (perms.includes('cookies')) readable.push('Read and change cookies');
    if (perms.includes('downloads')) readable.push('Manage your downloads');
    if (perms.includes('clipboardRead')) readable.push('Read your clipboard');
    const [w, h] = win.getContentSize();
    const width = 380 + 2 * M;
    const height = 150 + readable.length * 22 + 2 * M;
    let icon = '';
    try { icon = details.icon && !details.icon.isEmpty() ? details.icon.resize({ width: 32 }).toDataURL() : ''; } catch { /* no icon */ }
    win.focus();
    overlay.open('extinstall', { x: (w - width) / 2, y: Math.max(TOPBAR_H, h / 2 - height), width, height }, {
      name: details.localizedName || m.name || 'this extension',
      icon,
      permissions: readable,
    }, { focus: true, onPick: (p) => resolve(!!p.ok), onClose: () => resolve(false) });
  });
}

function showExtensionsPanel(rect) {
  if (rect) lastExtRect = rect;
  const r = lastExtRect || { x: win.getContentSize()[0] - 200, y: 8, width: 32, height: 32 };
  const list = ext ? ext.list() : [];
  const width = 320 + 2 * M;
  const height = 50 + Math.max(1, Math.min(list.length, 7)) * 52 + 54 + 2 * M;
  overlay.open('extensions', { x: r.x + r.width - width + M + 4, y: r.y + r.height + 4 - M, width, height }, { list }, { focus: true });
}
let lastExtRect = null;

// ---------------------------------------------------------------------------
// Sessions: the normal profile and private browsing
// ---------------------------------------------------------------------------

/** Everything a browsing session needs, normal or private. */
function prepareSession(ses, { private: priv = false } = {}) {
  ses.setUserAgent(app.userAgentFallback);
  ses.setSpellCheckerLanguages(['en-US']);
  registerInternalProtocol(ses);
  setupPermissions(ses, { private: priv });
  compat.attach(ses);
  if (priv) {
    adblock.attach(ses); // follows the global on/off switch
    attachDownloads(ses, { private: true });
  }
}

function attachDownloads(ses, opts = {}) {
  downloads.attach(ses, () => data.settings.data.downloadDir, (sum) => {
    emit('downloads', { ...sum, items: undefined });
    overlay.update('downloads', sum);
  }, (entry, wc) => {
    emit('downloads:started', { filename: entry.filename });
    // A tab opened only to start a download is useless afterwards.
    const tab = wc && tabs.byWebContents(wc);
    if (tab && !wc.getURL() && tabs.tabs.length > 1) tabs.close(tab.id);
  }, opts);
}

// Private tabs share one in-memory session (nothing is written to disk).
// It is created on first use and wiped when the last private tab closes.
let privateSession = null;
function getPrivateSession() {
  if (!privateSession) {
    privateSession = session.fromPartition('coffee-private'); // no "persist:" = memory only
    prepareSession(privateSession, { private: true });
  }
  return privateSession;
}

function endPrivateBrowsing() {
  if (!privateSession) return;
  const ses = privateSession;
  ses.clearStorageData().catch(() => {});
  ses.clearCache().catch(() => {});
  ses.clearAuthCache().catch(() => {});
  ses.clearHostResolverCache().catch(() => {});
  downloads.clearPrivate();
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock', 'speaker-selection']);
const ASK = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images copied to the clipboard',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices',
  'display-capture': 'see your screen',
  'idle-detection': 'know when you are actively using this device',
  'window-management': 'manage windows on all your displays',
  openExternal: 'open an external application',
};

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function setupPermissions(ses, { private: priv = false } = {}) {
  const decisions = () => data.settings.data.permissions;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    const origin = originOf(details.requestingUrl || wc.getURL());
    if (origin.startsWith('coffee://')) return callback(permission === 'clipboard-read');
    const key = `${origin}|${permission}`;
    if (key in decisions()) return callback(decisions()[key]);
    const what = ASK[permission];
    const tab = tabs.byWebContents(wc);
    if (!what || !tab || tab !== tabs.active) return callback(false);
    let answered = false;
    const answer = (allow, remember) => {
      if (answered) return;
      answered = true;
      if (remember && !priv) { decisions()[key] = allow; data.settings.save(); }
      callback(allow);
    };
    const host = origin.replace(/^https?:\/\//, '');
    const omni = lastOmniRect || { x: SIDEBAR_W + 120, y: 8, width: 400, height: 32 };
    overlay.open('permission', { x: omni.x - M, y: omni.y + omni.height + 6 - M, width: 340 + 2 * M, height: 128 + 2 * M },
      { host, what: permission === 'openExternal' && details.externalURL ? `open ${new URL(details.externalURL).protocol.replace(':', '')} links` : what },
      { focus: true, onPick: (p) => answer(!!p.allow, true), onClose: () => answer(false, false) });
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    const v = decisions()[`${originOf(requestingOrigin)}|${permission}`];
    return v === true;
  });
}
let lastOmniRect = null;

// ---------------------------------------------------------------------------
// Settings changes from coffee://settings
// ---------------------------------------------------------------------------

function setSetting(key, value) {
  const s = data.settings.data;
  switch (key) {
    case 'searchEngine':
      if (data.SEARCH_ENGINES[value]) s.searchEngine = value;
      break;
    case 'adblock':
      s.adblock = !!value;
      adblock.setEnabled(webSession, s.adblock, onBlocked);
      break;
    case 'bookmarksBar':
      s.bookmarksBar = !!value;
      layout();
      break;
    case 'tabLayout':
      s.tabLayout = value === 'horizontal' ? 'horizontal' : 'vertical';
      layout();
      updatePeekWatch();
      break;
    case 'compactSidebar':
      s.compactSidebar = !!value;
      layout();
      updatePeekWatch();
      break;
    case 'tabTitles':
      s.tabTitles = !!value;
      if (overlay.isOpen('sidebar')) overlay.close();
      break;
    case 'newtabShortcuts':
      s.newtabShortcuts = !!value;
      break;
    case 'extensions':
      s.extensions = !!value; // takes effect after a restart
      break;
    case 'sleepMinutes':
      s.sleepMinutes = [0, 5, 15, 30, 60, 120].includes(Number(value)) ? Number(value) : 30;
      break;
    case 'restoreSession':
      s.restoreSession = !!value;
      break;
    case 'theme': {
      const v = value || {};
      const preset = v.preset === 'custom' || themes.PRESETS.some((p) => p.id === v.preset) ? v.preset : 'coffee';
      s.theme = { preset, custom: v.custom ? themes.sanitizeCustom(v.custom) : s.theme.custom };
      applyTheme();
      break;
    }
    default:
      return;
  }
  data.settings.save();
  emit('settings', publicSettings());
  broadcastSettings();
}

function settingsPayload() {
  const s = data.settings.data;
  return {
    searchEngine: s.searchEngine,
    engines: Object.entries(data.SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
    adblock: s.adblock,
    bookmarksBar: s.bookmarksBar,
    tabLayout: s.tabLayout,
    compactSidebar: !!s.compactSidebar,
    tabTitles: s.tabTitles !== false,
    newtabShortcuts: s.newtabShortcuts !== false,
    extensions: !!s.extensions,
    extensionsRunning: !!ext,
    hiddenShortcuts: (s.hiddenShortcuts || []).length,
    sleepMinutes: s.sleepMinutes,
    restoreSession: s.restoreSession,
    theme: s.theme,
    presets: themes.PRESETS,
    downloadDir: s.downloadDir,
    blockedTotal: s.blockedTotal,
    version: app.getVersion(),
    update: updater.status,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
}

function broadcastSettings() {
  for (const t of tabs.tabs) {
    if (t.wc && t.url.startsWith('coffee://settings')) t.wc.send('ev:settings', settingsPayload());
  }
}

// ---------------------------------------------------------------------------
// Ad-block counters
// ---------------------------------------------------------------------------

let blockedSaveTimer = null;
function onBlocked(wcId) {
  const s = data.settings.data;
  s.blockedTotal += 1;
  if (!blockedSaveTimer) blockedSaveTimer = setTimeout(() => { blockedSaveTimer = null; data.settings.save(); }, 5000);
  if (!tabs || !wcId) return;
  const tab = tabs.tabs.find((t) => t.wc && t.wc.id === wcId);
  if (tab) { tab.blocked += 1; tabs.changed(); }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const INTERNAL_SEND = new Set(['nav:go', 'settings:set', 'history:clear', 'data:clear', 'update:check', 'update:install', 'newtab:hide', 'shortcuts:restore', 'welcome:done', 'app:relaunch']);
const INTERNAL_INVOKE = new Set(['newtab:data', 'settings:get', 'downloads:choose-dir', 'import:detect', 'import:run']);

function senderKind(e) {
  const wc = e.sender;
  if (wc === ui) return 'ui';
  if (overlay && wc === overlay.wc) return 'overlay';
  const url = e.senderFrame ? e.senderFrame.url : wc.getURL();
  if (url && url.startsWith('coffee://')) return 'internal';
  return null;
}

ipcMain.on('theme:sync', (e) => {
  e.returnValue = senderKind(e) ? theme : null;
});

ipcMain.on('cmd', (e, type, p = {}) => {
  const kind = senderKind(e);
  if (!kind || (kind === 'internal' && !INTERNAL_SEND.has(type))) return;
  p = p || {};
  switch (type) {
    // tabs
    case 'tab:new': tabs.create({ ...(p.url ? { url: data.toUrl(p.url) } : {}), private: !!p.private }); break;
    case 'tab:close': tabs.close(p.id); break;
    case 'tab:activate': tabs.activate(p.id); break;
    case 'tab:move': tabs.move(p.id, p.index); break;
    case 'tab:menu': tabMenu(p.id, p.x, p.y); break;
    case 'sidebar:menu': sidebarMenu(p.x, p.y); break;
    case 'update:install': updater.install(); break;
    case 'update:check': updater.check(); break;
    case 'tab:mute': {
      const t = tabs.get(p.id);
      if (t) { t.muted = !t.muted; if (t.wc) t.wc.setAudioMuted(t.muted); tabs.changed(); }
      break;
    }
    case 'tooltip:show': showTooltip(p); break;
    case 'tooltip:hide': if (overlay.isOpen('tooltip')) overlay.close(); break;

    // navigation
    case 'nav:go': {
      const url = data.toUrl(p.url);
      if (url) navigate(url, { newTab: !!p.newTab, background: !!p.background });
      break;
    }
    case 'nav:back': goBack(); break;
    case 'nav:forward': goForward(); break;
    case 'nav:reload': reload(!!p.hard); break;
    case 'nav:stop': { const wc = activeWc(); if (wc) wc.stop(); break; }
    case 'nav:home': navigate(NEWTAB); break;
    case 'page:focus': { const t = tabs.active; if (t) t.urlbarUntil = 0; const wc = activeWc(); if (wc) wc.focus(); break; }
    case 'urlbar:typing': if (tabs.active) tabs.active.urlbarUntil = 0; break;

    // window
    case 'win:minimize': win.minimize(); break;
    case 'win:maximize':
      if (win.isFullScreen()) win.setFullScreen(false);
      else if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'win:close': win.close(); break;

    // overlay
    case 'suggest:show': lastOmniRect = p.rect; showSuggest(p); break;
    case 'omni:rect': lastOmniRect = p.rect; break;
    case 'overlay:close': if (!p.type || overlay.isOpen(p.type)) overlay.close(); break;
    case 'overlay:pick': if (kind === 'overlay') overlay.pick(p); break;

    // features
    case 'downloads:toggle': toggleDownloads(p.rect); break;
    case 'downloads:action':
      downloads.action(p.id, p.what);
      if (p.what === 'open' || p.what === 'show') overlay.close();
      break;
    case 'bookmark:star': starBookmark(p.rect); break;
    case 'bookmark:open': {
      const bm = data.itemById(p.id);
      if (bm && bm.type === 'bookmark') navigate(bm.url, { newTab: !!p.newTab, background: !!p.background });
      if (kind === 'overlay' && !p.keepOpen) overlay.close();
      break;
    }
    case 'bookmark:menu': bookmarkMenu(p.id, p.x, p.y); break;
    case 'bookmark:update': {
      const patch = { title: p.title };
      if ('parent' in p) patch.parent = p.parent || null;
      data.updateBookmark(p.id, patch);
      bookmarksChanged();
      break;
    }
    case 'bookmark:remove': data.removeBookmark(p.id); bookmarksChanged(); overlay.close(); break;
    case 'bookmark:move':
      data.moveBookmark(p.id, { parent: p.parent || null, index: Number.isFinite(p.index) ? p.index : Infinity });
      bookmarksChanged();
      break;
    case 'bmbar:menu': bookmarksBarMenu(p.x, p.y); break;
    case 'welcome:done': {
      // Finished or skipped the welcome setup: never show it automatically again.
      data.settings.data.onboarded = true;
      data.settings.save();
      const t = tabs.byWebContents(e.sender);
      if (t && t.wc) t.wc.loadURL(NEWTAB).catch(() => {});
      break;
    }
    case 'newtab:hide': data.hideShortcut(String(p.url || '')); broadcastSettings(); break;
    case 'shortcuts:restore':
      data.settings.data.hiddenShortcuts = [];
      data.settings.save();
      broadcastSettings();
      break;
    case 'bmfolder:open': openFolder(p.id, p.rect); break;
    case 'bmfolder:nav': openFolder(p.id); break;
    case 'bmfolder:openall': openAll(data.children(p.id).filter((b) => b.type === 'bookmark')); overlay.close(); break;
    case 'shield:menu': shieldMenu(p.rect); break;
    case 'app:menu': showMenu(p.x, p.y, [
      { label: 'New tab', accel: 'Ctrl+T', action: () => tabs.create() },
    { label: 'New private tab', accel: 'Ctrl+Shift+N', action: () => tabs.create({ private: true }) },
      { label: 'Reopen closed tab', accel: 'Ctrl+Shift+T', disabled: !tabs.closed.length, action: () => tabs.reopenClosed() },
      { sep: true },
      { label: 'Downloads', accel: 'Ctrl+J', action: () => toggleDownloads() },
      { label: 'Bookmarks bar', accel: 'Ctrl+Shift+B', checked: data.settings.data.bookmarksBar, action: toggleBookmarksBar },
      { label: tabsOnTop() ? 'Move tabs to the side' : 'Move tabs to the top', action: toggleTabLayout },
      { label: 'Compact sidebar', checked: compactSidebar(), disabled: tabsOnTop(), action: toggleCompact },
      { label: 'Find in page', accel: 'Ctrl+F', action: () => openFind() },
      { label: 'Full screen', accel: 'F11', checked: win.isFullScreen(), action: () => win.setFullScreen(!win.isFullScreen()) },
      { sep: true },
      { label: 'Extensions', action: () => (ext ? showExtensionsPanel() : openSettings('extensions')) },
      { label: 'Settings', accel: 'Ctrl+,', action: () => openSettings() },
    ]); break;
    case 'find': {
      const wc = activeWc();
      const tab = tabs.active;
      if (!wc || !p.text) { if (wc) wc.stopFindInPage('clearSelection'); emit('find:result', { active: 0, matches: 0 }); break; }
      tab.find = p.text;
      wc.findInPage(p.text, { forward: p.forward !== false, findNext: !!p.next });
      break;
    }
    case 'find:stop': {
      const wc = activeWc();
      if (wc) wc.stopFindInPage('keepSelection');
      if (tabs.active) tabs.active.find = null;
      break;
    }
    case 'zoom:reset': zoom(0); break;
    case 'settings:open': openSettings(p.section); break;
    case 'app:relaunch':
      // Applies settings that need a restart (e.g. extensions).
      tabs.saveSession();
      data.Store.flushAll();
      app.relaunch();
      app.quit();
      break;
    case 'ext:panel': showExtensionsPanel(p.rect); break;
    case 'ext:remove':
      if (ext) ext.remove(String(p.id || '')).then(() => { emit('ext:changed'); if (overlay.isOpen('extensions')) showExtensionsPanel(); });
      break;
    case 'ext:options': {
      const e = ext && ext.list().find((x) => x.id === p.id);
      if (e && e.options) tabs.create({ url: `chrome-extension://${e.id}/${e.options.replace(/^\//, '')}` });
      overlay.close();
      break;
    }
    case 'ext:store': navigate('https://chromewebstore.google.com/category/extensions', { newTab: true }); overlay.close(); break;
    case 'settings:set': setSetting(p.key, p.value); break;
    case 'history:clear': data.clearHistory(); break;
    case 'data:clear':
      webSession.clearStorageData().catch(() => {});
      webSession.clearCache().catch(() => {});
      break;
    default:
  }
});

ipcMain.handle('invoke', async (e, type, p = {}) => {
  const kind = senderKind(e);
  if (!kind || (kind === 'internal' && !INTERNAL_INVOKE.has(type))) return null;
  p = p || {};
  switch (type) {
    case 'init':
      return {
        snapshot: tabs.snapshot(),
        settings: publicSettings(),
        bookmarks: data.bookmarks.data,
        downloads: { ...downloads.summary(), items: undefined },
        window: windowState(),
      };
    case 'suggest': return data.suggest(p.q, { inline: p.inline !== false });
    case 'newtab:data':
      return { show: data.settings.data.newtabShortcuts !== false, shortcuts: data.shortcuts(8) };
    case 'settings:get': return settingsPayload();
    case 'import:detect': return importer.detect();
    case 'import:run': {
      const result = importer.run({
        browser: String(p.browser || ''),
        profile: String(p.profile || ''),
        bookmarks: p.bookmarks !== false,
        history: p.history !== false,
      });
      bookmarksChanged();
      return result;
    }
    case 'downloads:choose-dir': {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: data.settings.data.downloadDir });
      if (!r.canceled && r.filePaths[0]) {
        data.settings.data.downloadDir = r.filePaths[0];
        data.settings.save();
      }
      return data.settings.data.downloadDir;
    }
    default: return null;
  }
});

// ---------------------------------------------------------------------------
// Internal pages: coffee://newtab, coffee://settings, coffee://error
// ---------------------------------------------------------------------------

function registerInternalProtocol(ses) {
  const hosts = new Set(['newtab', 'settings', 'error', 'welcome']);
  ses.protocol.handle('coffee', async (req) => {
    const u = new URL(req.url);
    if (!hosts.has(u.hostname)) return new Response('Not found', { status: 404 });
    // /shared/* is served on every host so pages can use it same-origin.
    const shared = u.pathname.startsWith('/shared/');
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(shared ? 8 : 1));
    const base = path.join(PAGES, shared ? 'shared' : u.hostname);
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    // Internal pages may never be framed (blocks clickjacking of Settings).
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    headers.set('X-Frame-Options', 'DENY');
    return new Response(res.body, { status: res.status, headers });
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function urlsFromArgv(argv) {
  const out = [];
  for (const a of argv.slice(app.isPackaged ? 1 : 2)) {
    if (/^(https?|file):\/\//i.test(a)) out.push(a);
    else if (/^[a-z]:[\\/]/i.test(a) && /\.(html?|xhtml|svg|pdf|txt)$/i.test(a)) out.push(pathToFileURL(a).toString());
  }
  return out;
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const urls = urlsFromArgv(argv);
  for (const u of urls) tabs.create({ url: u });
});

app.setAppUserModelId('app.coffee.browser');

app.whenReady().then(async () => {
  nativeTheme.themeSource = theme.mode;
  webSession = session.fromPartition('persist:web');
  compat.setup(webSession, ELECTRON_UA);
  prepareSession(webSession);

  const blockerReady = data.settings.data.adblock
    ? adblock.setEnabled(webSession, true, onBlocked)
    : Promise.resolve();

  createWindow();
  updater.init(() => { emit('settings', publicSettings()); broadcastSettings(); });

  attachDownloads(webSession);

  if (data.settings.data.extensions) {
    startExtensions().catch((err) => console.error('Extensions failed to start:', err));
  }

  // Give the blocker a moment so the first page loads with blocking on.
  await Promise.race([blockerReady, new Promise((r) => setTimeout(r, 1200))]);

  const saved = data.session.data;
  const argvUrls = urlsFromArgv(process.argv);
  if (data.settings.data.restoreSession && saved.tabs && saved.tabs.length) {
    for (const t of saved.tabs) {
      // The setup page is never restored; it opens fresh if setup isn't done.
      if (String(t.url || '').startsWith('coffee://welcome')) continue;
      tabs.create({ background: true, init: { url: t.url || NEWTAB, title: t.title, favicon: t.favicon, entries: t.entries, entryIndex: t.entryIndex } });
    }
    const target = tabs.tabs[Math.min(saved.active || 0, tabs.tabs.length - 1)];
    if (target && !argvUrls.length) tabs.activate(target.id);
  }
  for (const u of argvUrls) tabs.create({ url: u });
  if (!tabs.tabs.length && data.settings.data.onboarded) tabs.create();
  // First run: open the welcome setup (theme, tabs, search engine...).
  if (!data.settings.data.onboarded) tabs.create({ url: 'coffee://welcome/' });
  else if (!tabs.active) tabs.activate(tabs.tabs[0].id);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => data.Store.flushAll());
app.on('will-quit', () => data.Store.flushAll());

// Links in internal pages that point outside the browser (mailto:, etc.).
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => {
    if (/^(mailto|tel):/i.test(url)) { ev.preventDefault(); shell.openExternal(url); }
  });
});
