'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, WebContentsView, session, ipcMain, protocol, net, nativeTheme, clipboard, dialog, shell, screen, safeStorage,
} = require('electron');

// Running from source (`npm start`) gets a profile of its own, "Coffee (dev)",
// next to the installed app's "Coffee". The installed app encrypts its cookie
// store (the enableCookieEncryption fuse); plain Electron doesn't, and opening
// an encrypted store without it drops every saved cookie: you'd be signed out
// of every site in the installed app after each run from source. It also lets
// both run at the same time. (Only when nothing chose the folder already, such
// as --user-data-dir or a test.) Must happen before anything reads the folder.
if (!app.isPackaged && path.basename(app.getPath('userData')) === 'Coffee') {
  app.setPath('userData', path.join(path.dirname(app.getPath('userData')), 'Coffee (dev)'));
}

const data = require('./data');
const themes = require('./themes');
const adblock = require('./adblock');
const downloads = require('./downloads');
const Overlay = require('./overlay');
const Float = require('./float');
const updater = require('./updater');
const compat = require('./compat');
const importer = require('./importer');
const sites = require('./sites');
const patchNotes = require('./patch-notes');
const { parse: parseDomain } = require('tldts-experimental');
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
const SIDEBAR_TITLES_W = 216; // side tabs with titles
const TOPBAR_H = 46;
const BOOKMARKS_H = 32;
const TABSTRIP_H = 38;  // tabs on top
const PEEK_W = 248;     // compact sidebar panel
const RADIUS = 0;       // page runs to the window edges: no frame
const M = 12; // shadow margin around overlay panels (matches overlay.css)

/**
 * One window's state: its BrowserWindow, chrome page, overlay and tab manager,
 * plus things that belong to that window alone (the tab in HTML fullscreen,
 * the compact-sidebar edge watcher, where popups were last anchored).
 */
function newWindowState() {
  return {
    win: null, ui: null, overlay: null, float: null, tabs: null,
    private: false, // a private window: every tab in it is private
    glance: null,   // the link open in Glance, if any
    fsWatch: null, fsNoticeAt: 0, // full screen: watching for the pointer at the top edge
    fullscreenTab: null,
    peekTimer: null, peekArmed: true, lastFocus: Date.now(),
    omniRect: null, starRect: null, downloadsRect: null, extRect: null,
    folderAnchor: null, folderFromButton: false,
  };
}

// `W` is the window the current handler acts on.
let W = newWindowState();
let webSession = null;
let theme = themes.resolve(data.settings.data.theme);
let sessionTimer = null;
let quitting = false; // the app is shutting down: the session was already saved with every window

// Every open window's state.
const winStates = [];

/** Run `fn` with `W` set to `state` (a window's own state), then restore the previous window. */
function inWindow(state, fn) {
  const prev = W;
  W = state;
  try { return fn(); } finally { W = prev; }
}

/** Run `fn` once for each open window, with `W` set to it. */
function eachWindow(fn) {
  for (const s of [...winStates]) {
    if (s.win && !s.win.isDestroyed() && s.tabs) inWindow(s, () => fn(s));
  }
}

/** The window and tab that own a page's webContents, in any window. */
function findTab(wc) {
  if (!wc) return null;
  for (const s of winStates) {
    const tab = s.tabs && s.tabs.byWebContents(wc);
    if (tab) return { state: s, tab };
  }
  return null;
}

/** Save the session soon (it walks every tab's history, so saves are batched). */
function scheduleSessionSave() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { if (!quitting) saveAllSessions(); }, 2000);
}

const emit = (ev, payload) => {
  if (W.ui && !W.ui.isDestroyed()) W.ui.send(`ev:${ev}`, payload);
};

/** Move keyboard focus out of the page and into the address bar. */
/**
 * Open (or step through) find in page. Like the address bar, the find box
 * lives in the browser chrome, so keyboard focus must move there from the
 * page first or typing would keep going to the page.
 */
function openFind(which = 'find:open') {
  if (!W.ui || W.ui.isDestroyed()) return;
  W.ui.focus();
  if (which !== 'find:open') return emit(which);
  // Like Chrome and Firefox: text selected on the page is what you look for.
  const wc = activeWc();
  const state = W;
  if (!wc) return emit(which, {});
  wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'String(getSelection())' }])
    .catch(() => '')
    .then((sel) => {
      const text = String(sel || '').trim();
      inWindow(state, () => emit(which, { text: text && text.length <= 200 && !/\n/.test(text) ? text : '' }));
    });
}

// Find results list: every match on the page with the words around it and the
// heading it sits under, so you can see them all at once instead of stepping
// through with Enter. Runs in the isolated world, so the page can't see or break it.
// shortcut: main frame only (matches inside iframes still count and highlight, but aren't listed).
const FIND_LIMIT = 300;
const FIND_SCAN = `(async (q, goto, limit) => {
  // Walking the page is the slow part (it forces style), so the text index is
  // built once and reused for every keystroke until the page changes, and it's
  // built in small slices so the page keeps scrolling and painting meanwhile.
  const W = window;
  if (!W.coffeeFindObs) {
    W.coffeeFindObs = new MutationObserver(() => { W.coffeeFindIx = null; W.coffeeFindBuild = null; });
    W.coffeeFindObs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  const build = async () => {
    const vis = new Map();
    const shown = (el) => {
      if (!vis.has(el)) vis.set(el, !el.closest('script,style,noscript,template,head') && el.checkVisibility({ visibilityProperty: true }));
      return vis.get(el);
    };
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const BLOCK = 'p,li,dt,dd,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,figcaption,div,section,article,header,footer,nav,aside,main,form,label,button';
    const nodes = []; const starts = []; const heads = []; let text = ''; let head = ''; let block = null;
    let t0 = performance.now(); let c = 0;
    for (let n; (n = walker.nextNode());) {
      if (++c % 200 === 0 && performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r)); t0 = performance.now(); }
      const el = n.parentElement;
      if (!el || !n.data || !shown(el)) continue;
      const h = el.closest('h1,h2,h3,h4,h5,h6');
      if (h) head = h.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80);
      // A line break between blocks: snippets stop at their own paragraph, and no match spans two.
      const b = el.closest(BLOCK);
      if (b !== block) { text += '\\n'; block = b; }
      nodes.push(n); starts.push(text.length); heads.push(head); text += n.data;
    }
    return { nodes, starts, heads, text };
  };
  let ix = W.coffeeFindIx;
  if (!ix) {
    // One build at a time; if the page changes mid-build, use the result but don't keep it.
    if (!W.coffeeFindBuild) { const p = W.coffeeFindBuild = build().then((r) => { if (W.coffeeFindBuild === p) W.coffeeFindIx = r; return r; }); }
    ix = await W.coffeeFindBuild;
  }
  const { nodes, starts, heads, text } = ix;
  const at = (i) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= i) lo = m; else hi = m - 1; } return lo; };
  const re = new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'gi');
  const flat = (s) => s.replace(/\\s+/g, ' ');
  const out = []; let m; let k = 0;
  while ((m = re.exec(text)) && out.length < limit) {
    const i = m.index; const j = at(i);
    if (goto === k) { getSelection().collapse(nodes[j], i - starts[j]); return true; }
    if (goto < 0) {
      const end = i + m[0].length;
      const pre = text.slice(Math.max(0, i - 60), i).split('\\n').pop();
      const post = text.slice(end, end + 80).split('\\n')[0];
      const p = flat(pre).trimStart();
      out.push({ pre: p.length > 40 ? '… ' + p.slice(-40).replace(/^\\S*\\s/, '') : p, hit: flat(m[0]), post: flat(post).trimEnd(), section: heads[j] });
    }
    k++;
  }
  return goto < 0 ? out : false;
})`;

function findScan(wc, text, goto = -1) {
  const code = `${FIND_SCAN}(${JSON.stringify(text)}, ${goto}, ${FIND_LIMIT})`;
  return wc.executeJavaScriptInIsolatedWorld(1001, [{ code }]).catch(() => (goto < 0 ? [] : false));
}

function findListOn() {
  return data.settings.data.findList !== false;
}

/** Show (or refresh) the results list under the find box. */
async function showFindList(text) {
  const wc = activeWc();
  const state = W;
  if (!wc || !text || !findListOn() || !W.findRect) return W.overlay.isOpen('findlist') && W.overlay.close();
  const seq = (W.findSeq = (W.findSeq || 0) + 1);
  const items = await findScan(wc, text);
  inWindow(state, () => {
    if (seq !== W.findSeq || !W.tabs.active || W.tabs.active.find !== text) return; // a newer search, or find closed
    const r = W.findRect;
    const rows = new Set(items.map((x) => x.section)).size + items.length; // headings + matches
    const height = 40 + (items.length ? Math.min(rows, 12) * 30 : 30) + 8 + 2 * M;
    // Narrow and under the find box's right end, so it hides less of the page you're searching.
    const width = Math.min(r.width, 440) + 2 * M;
    W.overlay.open('findlist', { x: r.x + r.width - width + M, y: r.y + r.height + 6 - M, width, height },
      { items, query: text, active: W.findActive || 0, matches: W.findMatches, limit: FIND_LIMIT },
      { onPick: (p) => {
        const tab = W.tabs.active;
        if (!tab || !tab.wc || tab.find !== text) return;
        W.ui.focus(); // keep typing in the find box
        findScan(tab.wc, text, Number(p.index)).then((ok) => {
          if (ok && tab.wc && tab.find === text) tab.wc.findInPage(text, { findNext: true, forward: true });
        });
      } });
  });
}

/**
 * Chromium only scrolls to a match that's off screen, so one sitting under the
 * results list counts as "visible" and you'd never see it. Scroll it into the
 * clear part of the page below the list instead.
 * shortcut: scrolls the window only, so pages that scroll an inner box keep the old behaviour.
 */
function keepMatchClearOfList(tab, area) {
  if (!tab.view || !tab.wc) return;
  const v = tab.view.getBounds(); // area is in the same units (DIPs), relative to the page view
  const o = W.overlay.view.getBounds();
  const list = { x: o.x + M - v.x, y: o.y + M - v.y, right: o.x + o.width - M - v.x, bottom: o.y + o.height - M - v.y };
  const covered = area.x < list.right && area.x + area.width > list.x && area.y < list.bottom && area.y + area.height > list.y;
  if (!covered) return;
  const target = list.bottom + (v.height - list.bottom) / 2;
  const dy = Math.round((area.y + area.height / 2 - target) / tab.wc.getZoomFactor());
  tab.wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `scrollBy(0, ${dy})` }]).catch(() => {});
}

function focusUrlbar() {
  if (!W.ui || W.ui.isDestroyed()) return;
  W.ui.focus();
  emit('focus-urlbar', { select: true });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme() {
  theme = themes.resolve(data.settings.data.theme);
  nativeTheme.themeSource = theme.mode;
  eachWindow(() => {
    W.win.setBackgroundColor(theme.vars['--bg']);
    const targets = [W.ui, W.overlay && W.overlay.wc, W.float && W.float.wc];
    for (const t of W.tabs.tabs) {
      if (t.wc && isInternal(t.url)) targets.push(t.wc);
      t.applyBackground();
    }
    for (const wc of targets) if (wc && !wc.isDestroyed()) wc.send('ev:theme', theme);
  });
}

// ---------------------------------------------------------------------------
// Window & layout
// ---------------------------------------------------------------------------

function windowState() {
  if (!W.win || W.win.isDestroyed()) return { maximized: false, fullscreen: false, focused: false };
  return {
    maximized: W.win.isMaximized(),
    fullscreen: W.win.isFullScreen() && !W.fullscreenTab,
    focused: W.win.isFocused(),
    private: !!W.private,
  };
}

function bookmarksBarShown() {
  return !!data.settings.data.bookmarksBar && data.children(null).length > 0;
}

const tabsOnTop = () => data.settings.data.tabLayout === 'horizontal';
// Opt-in features (Settings → Tabs).
const compactSidebar = () => !tabsOnTop() && !!data.settings.data.compactSidebar;
const sidebarWidth = () => (data.settings.data.tabTitles !== false ? SIDEBAR_TITLES_W : SIDEBAR_W);

/** Where the chrome ends and the page begins (mirrors src/ui/ui.css). */
function chromeTop() {
  return TOPBAR_H + (bookmarksBarShown() ? BOOKMARKS_H : 0);
}

function pageBounds() {
  const [w, h] = W.win.getContentSize();
  if (W.fullscreenTab) return { bounds: { x: 0, y: 0, width: w, height: h }, radius: 0 };
  const top = chromeTop() + (tabsOnTop() ? TABSTRIP_H : 0);
  const left = tabsOnTop() || compactSidebar() ? 0 : sidebarWidth();
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


function updatePeekWatch() {
  const want = !!W.win && compactSidebar() && W.win.isFocused() && !W.fullscreenTab;
  const state = W;
  if (want && !W.peekTimer) W.peekTimer = setInterval(() => inWindow(state, peekTick), 40);
  else if (!want && W.peekTimer) { clearInterval(W.peekTimer); W.peekTimer = null; }
  if (!want && W.overlay && W.overlay.isOpen('sidebar')) W.overlay.close();
}

function peekTick() {
  if (!W.win || W.win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = W.win.getContentBounds();
  const x = p.x - b.x;
  const y = p.y - b.y;
  const top = chromeTop();
  // Edge hit: the first couple of pixels (or the resize border just outside).
  const atEdge = x <= 2 && x >= -10 && y >= top && y <= b.height;
  if (atEdge && W.peekArmed) {
    W.peekArmed = false;
    if (!W.overlay.isOpen() || W.overlay.type === 'tooltip') showPeek();
  } else if (x > 16) {
    W.peekArmed = true; // re-arm once the cursor has moved away from the edge
  }
}

const peekTitles = () => data.settings.data.tabTitles !== false;

function showPeek() {
  const [, h] = W.win.getContentSize();
  const top = chromeTop();
  const width = peekTitles() ? PEEK_W : SIDEBAR_W + 8;
  W.overlay.open('sidebar', { x: 0, y: top, width: width + M, height: h - top }, { ...W.tabs.snapshot(), titles: peekTitles() });
}

function toggleTabLayout() { setSetting('tabLayout', tabsOnTop() ? 'vertical' : 'horizontal'); }
function toggleCompact() { setSetting('compactSidebar', !data.settings.data.compactSidebar); }
function toggleTabTitles() { setSetting('tabTitles', data.settings.data.tabTitles === false); }

// Split view metrics (mirrored in src/ui/ui.css): the gap between the two
// tabs holds a draggable divider; a thin bar above each tab marks the active one.
const SPLIT_GAP = 8;
const SPLIT_BAR = 3;

function layout() {
  if (!W.tabs || !W.win || W.win.isDestroyed()) return;
  const t = W.tabs;
  const views = t.visibleIds().map((id) => t.get(id)).filter((x) => x && x.view);
  if (!views.length) return;
  const { bounds, radius } = pageBounds();
  for (const v of views) v.view.setBorderRadius(radius);
  if (W.float) W.float.hide('status');
  if (W.glance) layoutGlance();

  // A tab in HTML fullscreen (a video) covers the whole window, even in a split.
  const fs = W.fullscreenTab;
  if (fs && fs.view && views.includes(fs)) {
    fs.view.setBounds(bounds);
    W.win.contentView.addChildView(fs.view); // above its split partner
    if (W.float && W.float.isShowing()) W.win.contentView.addChildView(W.float.view); // the full-screen notice stays on top
    for (const v of views) if (v !== fs) v.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    emit('split', null);
    return;
  }

  if (views.length === 2 && t.pair) {
    const left = t.get(t.pair.left);
    const right = t.get(t.pair.right);
    const avail = Math.max(0, bounds.width - SPLIT_GAP);
    const lw = Math.round(avail * t.splitRatio);
    const top = bounds.y + SPLIT_BAR;
    const height = Math.max(0, bounds.height - SPLIT_BAR);
    const rx = bounds.x + lw + SPLIT_GAP;
    left.view.setBounds({ x: bounds.x, y: top, width: lw, height });
    right.view.setBounds({ x: rx, y: top, width: avail - lw, height });
    emit('split', {
      left: { x: bounds.x, width: lw },
      right: { x: rx, width: avail - lw },
      gap: { x: bounds.x + lw, width: SPLIT_GAP },
      top: bounds.y,
      page: { x: bounds.x, width: bounds.width },
      active: t.activeId === left.id ? 'left' : 'right',
    });
    return;
  }

  views[0].view.setBounds(bounds);
  emit('split', null);
}

/** Pin a privileged webContents to its own page: no navigation, popups, or webviews. */
function lockDown(wc) {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

/**
 * Open a browser window. `opts.bounds` places it (otherwise the last saved
 * size and position); `opts.maximized` overrides the saved maximized state;
 * `opts.inactive` shows it without taking focus.
 */
function createWindow(opts = {}) {
  const s = data.settings.data;
  const b = opts.bounds || s.windowBounds || {};
  const state = newWindowState();
  state.private = !!opts.private;
  winStates.push(state);
  W = state;
  W.win = new BrowserWindow({
    width: b.width || 1360,
    height: b.height || 860,
    x: b.x,
    y: b.y,
    minWidth: 520,
    minHeight: 360,
    frame: false,
    show: false,
    title: opts.private ? 'Coffee (Private)' : 'Coffee',
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
  W.ui = W.win.webContents;
  // The frame page's <title> would replace "(Private)" in the taskbar and Alt+Tab.
  if (state.private) W.win.on('page-title-updated', (e) => e.preventDefault());
  W.ui.loadFile(path.join(ROOT, 'ui', 'index.html'));
  if (opts.maximized !== undefined ? opts.maximized : s.maximized) W.win.maximize();

  // Bound to this window's own state (see `bind` below).
  state.win.once('ready-to-show', () => inWindow(state, () => {
    if (!state.win || state.win.isDestroyed()) return;
    if (opts.inactive) state.win.showInactive();
    else state.win.show();
    updatePeekWatch();
  }));

  W.overlay = new Overlay(W.win, UI_PRELOAD);
  W.overlay.onState = (type) => inWindow(state, () => emit('overlay', type));
  W.overlay.wc.on('before-input-event', (e, input) => inWindow(state, () => onInput(e, input, null)));
  W.ui.on('before-input-event', (e, input) => inWindow(state, () => onInput(e, input, null)));
  // The chrome and overlay carry the privileged preload: never let them load
  // anything else (e.g. a link or file dropped onto the title bar).
  lockDown(W.ui);
  lockDown(W.overlay.wc);
  // Link status bubble and tab hover cards (they can show while a popup is open).
  W.float = new Float(W.win, UI_PRELOAD);
  lockDown(W.float.wc);

  // Coffee's own right-click menus everywhere on the frame: cut/copy/paste in
  // the address bar and find box, and the tabs-and-window menu anywhere else
  // that has no menu of its own (tabs, bookmarks, Back/Forward have theirs).
  W.ui.on('context-menu', (_e, params) => inWindow(state, () => {
    if (params.isEditable) chromeEditMenu(params);
    else sidebarMenu(params.x, params.y);
  }));
  // The title bar and other drag areas would get Windows' own menu instead.
  W.win.on('system-context-menu', (e, point) => {
    e.preventDefault();
    inWindow(state, () => {
      const c = state.win.getContentBounds();
      sidebarMenu(point.x - c.x, point.y - c.y);
    });
  });

  // Window-level events run against this window's own state, not whichever
  // window happens to be current.
  const bind = (fn) => (...args) => inWindow(state, () => fn(...args));
  const sendState = bind(() => { layout(); emit('window', windowState()); });
  W.win.on('resize', bind(layout));
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) W.win.on(ev, sendState);
  // The focused window becomes the current one (for a second launch, a new window...).
  W.win.on('focus', () => { W = state; state.lastFocus = Date.now(); });
  W.win.on('focus', bind(() => { emit('window', windowState()); updatePeekWatch(); refreshDefaultBrowser(); }));
  W.win.on('blur', bind(() => {
    W.float.hide('tabcard');
    emit('window', windowState());
    updatePeekWatch();
    if (!['suggest', 'splitdrag', 'findlist'].includes(W.overlay.type)) W.overlay.close();
  }));

  // Mouse back/forward buttons.
  W.win.on('app-command', bind((_e, cmd) => {
    // While Glance is open, the mouse's back / forward buttons move through Glance.
    const dir = cmd === 'browser-backward' ? -1 : cmd === 'browser-forward' ? 1 : 0;
    if (!dir) return;
    if (W.glance && !W.glance.closing) { glanceHistory(dir); return; }
    if (dir < 0) goBack(); else goForward();
  }));

  W.win.on('close', () => {
    data.settings.data.maximized = state.win.isMaximized();
    data.settings.data.windowBounds = state.win.getNormalBounds();
    data.settings.save();
    // When the whole app is quitting, the session was already saved with every
    // window in before-quit; saving again here would drop windows closed first.
    if (!quitting) saveAllSessions();
  });
  // Not run through inWindow: it changes which window is current, and
  // inWindow would put the closed window back afterwards.
  W.win.on('closed', () => {
    clearInterval(state.peekTimer);
    state.peekTimer = null;
    const hadPrivate = state.tabs.tabs.some((t) => t.private);
    state.tabs.destroy();
    try { if (!state.overlay.wc.isDestroyed()) state.overlay.wc.close(); } catch { /* already gone */ }
    state.float.destroy();
    clearInterval(state.fsWatch);
    if (state.glance) {
      for (const v of [state.glance.chrome, state.glance.view]) { try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* gone */ } }
      state.glance = null;
    }
    state.win = null;
    const i = winStates.indexOf(state);
    if (i >= 0) winStates.splice(i, 1);
    // Hand "current" to a window that's still open. With none left, `W`
    // keeps pointing at the closed state; nothing reads it then.
    if (W === state && winStates.length) W = winStates[winStates.length - 1];
    if (tabDrag && tabDrag.from === state) finishTabDrag(false);
    if (hadPrivate && !anyPrivateTabs()) endPrivateBrowsing();
    // Forget the closed window in the saved session (other windows stay).
    if (winStates.length && !quitting) scheduleSessionSave();
  });

  const hooks = {
    radius: () => pageBounds().radius,
    themeBg: () => theme.vars['--bg'],
    layout,
    render: (snap) => {
      emit('tabs', snap);
      W.overlay.update('sidebar', { ...snap, titles: peekTitles() });
      scheduleSessionSave();
    },
    activated: (tab, opts = {}) => {
      if (ext) ext.tabSelected(tab);
      if (W.overlay.isOpen()) W.overlay.close();
      W.float.hide();
      if (W.glance && !W.glance.closing) closeGlance({ instant: true });
      if (tab.url.startsWith(NEWTAB) && !opts.fromPage) {
        // A freshly shown page takes keyboard focus as it attaches and loads,
        // without a 'focus' event, so keep handing focus back to the address
        // bar while it settles (until you type there or click the page).
        tab.urlbarUntil = Date.now() + 2500;
        focusUrlbar();
        // Timers fire outside this handler, so they name their own window.
        const reclaim = () => inWindow(state, () => {
          if (!state.tabs || tab !== state.tabs.active || !(tab.urlbarUntil > Date.now()) || !W.ui || W.ui.isDestroyed()) return;
          if (!W.ui.isFocused()) focusUrlbar();
        });
        for (const ms of [30, 120, 300, 700]) setTimeout(reclaim, ms);
        if (tab.wc) {
          tab.wc.once('dom-ready', reclaim);
          tab.wc.once('did-finish-load', () => { reclaim(); setTimeout(reclaim, 50); });
        }
      }
      else if (tab.wc && !opts.fromPage) tab.wc.focus();
      emit('find:close');
      if (W.overlay.isOpen('findlist')) W.overlay.close();
    },
    bookmarksChanged: bookmarksChanged,
    htmlFullscreen: (tab, on) => {
      if (!on && W.fullscreenTab && W.fullscreenTab !== tab) return; // another tab is the fullscreen one
      W.fullscreenTab = on ? tab : null;
      W.win.setFullScreen(on);
      updatePeekWatch();
      layout();
      emit('window', windowState());
      // Say which site went full screen (and how to leave), once the window has settled.
      if (on) {
        closeGlance({ instant: true });
        setTimeout(() => inWindow(state, () => { if (W.fullscreenTab === tab) showFullscreenNotice(tab); }), 350);
      }
      watchFullscreenEdge(on);
    },
    found: (tab, r) => {
      if (tab !== W.tabs.active) return;
      emit('find:result', { active: r.activeMatchOrdinal, matches: r.matches });
      // Chromium reports progress many times per search; redraw the list only when it says something new.
      if (!r.finalUpdate && r.activeMatchOrdinal === W.findActive) return;
      if (r.activeMatchOrdinal) W.findActive = r.activeMatchOrdinal;
      W.findMatches = r.matches;
      W.overlay.update('findlist', { active: r.activeMatchOrdinal, matches: r.matches });
      if (r.finalUpdate && r.selectionArea && W.overlay.isOpen('findlist')) keepMatchClearOfList(tab, r.selectionArea);
    },
    hoverUrl: (tab, url) => showStatus(tab, url),
    contextMenu: (tab, params) => pageMenu(tab, params),
    input: (e, input, tab) => onInput(e, input, tab),
    pageFocus: (tab) => {
      // Clicking into the other half of a split makes it the active tab, so
      // the address bar, back/forward and shortcuts act on the page in use.
      if (tab.id === W.tabs.pane) {
        W.tabs.activate(tab.id, { fromPage: true });
        emit('page-focus');
        return;
      }
      if (tab === W.tabs.active && tab.urlbarUntil > Date.now()) {
        focusUrlbar();
        return;
      }
      if (W.overlay.isOpen() && W.overlay.type !== 'tooltip') W.overlay.close();
      if (tab === W.tabs.active) emit('page-focus');
    },
    zoom: (tab, dir) => zoom(dir, tab),
    privateSession: getPrivateSession,
    // Private tabs in other windows still use the private session.
    privateEnded: () => { if (!anyPrivateTabs()) endPrivateBrowsing(); },
    viewCreated: (tab) => { if (ext) ext.tabCreated(tab, W.win); },
    viewDestroyed: (tab) => { if (ext) ext.tabRemoved(tab); },
    keepPip,
  };
  // Each hook runs against this window's own state.
  const boundHooks = Object.fromEntries(Object.entries(hooks).map(([k, fn]) => [k, bind(fn)]));
  W.tabs = new TabManager(W.win, webSession, boundHooks, { private: state.private });
  // Leave the new window current: it's the one in front after it's created.
  W = state;
  return state;
}

/** Whether any open window still has a private tab. */
function anyPrivateTabs() {
  return winStates.some((st) => st.tabs && st.tabs.tabs.some((t) => t.private));
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function activeWc() {
  const t = W.tabs && W.tabs.active;
  return t ? t.wc : null;
}

function navigate(url, { newTab = false, background = false } = {}) {
  if (!url) return;
  if (newTab || background) {
    W.tabs.create({ url, background, after: W.tabs.active });
    return;
  }
  const tab = W.tabs.active;
  if (!tab) return W.tabs.create({ url });
  // A popped-out video keeps playing: its page is handed off, not replaced.
  if (tab.pip && tab.handoff({ url })) return;
  tab.ensureView();
  tab.wc.loadURL(url).catch(() => {});
  tab.wc.focus();
}

/** Back (-1) or forward (1) in the active tab, keeping a popped-out video playing. */
function goHistory(offset) {
  const tab = W.tabs.active;
  const wc = tab && tab.wc;
  if (!wc) return;
  const h = wc.navigationHistory;
  if (offset < 0 ? !h.canGoBack() : !h.canGoForward()) return;
  if (tab.pip && tab.handoff({ offset })) return;
  if (offset < 0) h.goBack();
  else h.goForward();
}
function goBack() { goHistory(-1); }
function goForward() { goHistory(1); }

function reload(hard = false) {
  const tab = W.tabs.active;
  if (!tab || !tab.wc) return;
  if (tab.url.startsWith('coffee://error/')) {
    const u = displayUrl(tab.url);
    if (u) return tab.wc.loadURL(u).catch(() => {});
  }
  if (hard) tab.wc.reloadIgnoringCache();
  else tab.wc.reload();
}

function zoom(dir, tab = W.tabs.active) {
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
  W.tabs.changed();
}

/** Bookmarks are shared by every window (the bar can appear or vanish, so re-layout too). */
function bookmarksChanged() {
  eachWindow(() => {
    emit('bookmarks', data.bookmarks.data);
    emit('settings', publicSettings());
    layout();
  });
}

/** Re-apply settings that change the chrome's look or layout, in every window. */
function refreshWindows() {
  eachWindow(() => {
    layout();
    updatePeekWatch();
    emit('settings', publicSettings());
  });
}

function toggleBookmarksBar() {
  data.settings.data.bookmarksBar = !data.settings.data.bookmarksBar;
  data.settings.save();
  refreshWindows();
}

function publicSettings() {
  const s = data.settings.data;
  return {
    bookmarksBar: s.bookmarksBar,
    bookmarksBarShown: bookmarksBarShown(),
    bookmarksButton: !!s.bookmarksButton,
    findList: findListOn(),
    tabLayout: tabsOnTop() ? 'horizontal' : 'vertical',
    compactSidebar: !!data.settings.data.compactSidebar,
    tabTitles: data.settings.data.tabTitles !== false,
    extensions: !!ext,
    adblock: s.adblock,
    adblockExceptions: s.adblockExceptions || [],
    showHome: !!s.showHome,
    searchEngine: s.searchEngine,
    update: updater.status,
    searchEngineName: (data.SEARCH_ENGINES[s.searchEngine] || data.SEARCH_ENGINES.google).name,
  };
}

/** Open the history page, reusing an open one. */
function openHistory() {
  if (W.private) return inNormalWindow(openHistory);
  const existing = W.tabs.tabs.find((t) => t.url.startsWith('coffee://history'));
  if (existing) W.tabs.activate(existing.id);
  else W.tabs.create({ url: 'coffee://history/' });
}

function openWhatsNew() {
  if (W.private) return inNormalWindow(openWhatsNew);
  const existing = W.tabs.tabs.find((t) => t.url.startsWith('coffee://whats-new'));
  if (existing) W.tabs.activate(existing.id);
  else W.tabs.create({ url: 'coffee://whats-new/' });
}

function openSettings(section) {
  if (W.private) return inNormalWindow(() => openSettings(section));
  const url = `coffee://settings/${section ? `#${String(section).replace(/[^a-z-]/g, '')}` : ''}`;
  const existing = W.tabs.tabs.find((t) => t.url.startsWith('coffee://settings'));
  if (existing) {
    W.tabs.activate(existing.id);
    if (section && existing.wc) existing.wc.loadURL(url).catch(() => {});
  } else {
    W.tabs.create({ url });
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (work no matter which surface has focus)
// ---------------------------------------------------------------------------

function onInput(e, input, tab) {
  if (input.type !== 'keyDown') return;
  if (input.key === 'Escape' && cancelTabDrag()) { e.preventDefault(); return; }
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const ctrl = input.control || input.meta;
  const { shift, alt } = input;
  let handled = true;

  if (ctrl && !alt) {
    if (key === 'n' && !shift) openNewWindow();
    else if (key === 't' && !shift) W.tabs.create();
    else if (key === 'n' && shift) openPrivateWindow();
    else if (key === 't' && shift) W.tabs.reopenClosed();
    else if ((key === 'w' && !shift) || key === 'F4') W.tabs.active && W.tabs.close(W.tabs.activeId);
    else if (key === 'w' && shift) W.win.close();
    else if ((key === 'PageDown' || key === 'PageUp') && shift) moveActiveTab(key === 'PageUp' ? -1 : 1);
    else if (key === 'Tab' || key === 'PageDown' || key === 'PageUp') W.tabs.cycle(key === 'PageUp' || (key === 'Tab' && shift) ? -1 : 1);
    else if (key === 'a' && shift) showTabSearch();
    else if (key === 'c' && shift) copyPageUrl();
    else if (key === 'm' && !shift) { if (W.tabs.active) toggleMute(W.tabs.active); }
    else if (/^[1-9]$/.test(key) && !shift) {
      const n = Number(key);
      const t = n === 9 ? W.tabs.tabs[W.tabs.tabs.length - 1] : W.tabs.tabs[n - 1];
      if (t) W.tabs.activate(t.id);
    }
    else if (key === 'l' || key === 'k' || key === 'e') focusUrlbar();
    else if (key === 'r' || key === 'F5') reload(shift || key === 'F5');
    else if (key === 'd' && !shift) starBookmark();
    else if (key === 'b' && shift) toggleBookmarksBar();
    else if (key === 'j') toggleDownloads();
    else if (key === 'h' && !shift) openHistory();
    else if (key === 'f' && !shift) openFind();
    else if (key === 'g') openFind(shift ? 'find:prev' : 'find:next');
    else if (key === '=' || key === '+') zoom(1);
    else if (key === '-' || key === '_') zoom(-1);
    else if (key === '0') zoom(0);
    else if (key === 'p' && !shift) activeWc() && activeWc().print();
    // From the browser's own UI. In a page, the page gets Ctrl+S first (preload/compat.js).
    else if (key === 's' && !shift && !tab) savePageAs();
    else if (key === 'i' && shift) toggleDevTools();
    else if (key === ',') openSettings();
    else if (key === 'u' && !shift) { const t = W.tabs.active; if (t && /^https?:/.test(t.url)) navigate(`view-source:${t.url}`, { newTab: true }); }
    else handled = false;
  } else if (alt && !ctrl) {
    if (key === 'ArrowLeft') goBack();
    else if (key === 'ArrowRight') goForward();
    else if (key === 'd') focusUrlbar();
    else if (key === 'p') toggleVideoPopout(W.tabs.active);
    else if (key === 'Home') navigate(homeUrl());
    else handled = false;
  } else if (!ctrl && !alt) {
    if (key === 'F5') reload(false);
    else if (key === 'F6') focusUrlbar();
    else if (key === 'F11') { W.fullscreenTab = null; W.win.setFullScreen(!W.win.isFullScreen()); }
    else if (key === 'F12') toggleDevTools();
    else if (key === 'Escape' && W.fullscreenTab && tab === W.fullscreenTab) {
      tab.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
    }
    else if (key === 'Escape' && W.overlay.isOpen()) W.overlay.close();
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

// Row heights, mirrored in src/ui/overlay.css (.mi, .mzoom, .msep).
function menuSize(items) {
  let h = 10;
  for (const it of items) h += it.sep ? 9 : it.zoom ? 36 : 30;
  return { width: 264 + 2 * M, height: h + 2 * M };
}

/**
 * Show a menu at window coords (x, y). Items: { label, accel, icon, checked,
 * disabled, action(pick) } or { sep } or { zoom: { value, fullscreen }, action }.
 * `opts.reopen`: refresh a menu that's already open, in place.
 */
function showMenu(x, y, items, opts = {}) {
  // No separators at the ends or twice in a row.
  const visible = items.filter((it, i, a) => !(it.sep && (i === 0 || a[i - 1].sep || i === a.length - 1)));
  const size = menuSize(visible);
  const [w, h] = W.win.getContentSize();
  let left = x - M + 2;
  let top = y - M + 2;
  if (opts.alignRight) left = x - size.width + M;
  if (left + size.width > w) left = x - size.width + M - 2;
  if (left < 0) left = 0;
  if (top + size.height > h) top = Math.max(0, y - size.height + M - 2);
  W.overlay.open('menu', { x: left, y: top, ...size },
    { items: visible.map(({ label, accel, disabled, sep, checked, icon, zoom: z }) => ({ label, accel, disabled, sep, checked, icon, zoom: z })) },
    { focus: true, onPick: (p) => { const it = visible[p.index]; if (it && !it.disabled && it.action) it.action(p); } });
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
      { label: 'Open link in new tab', action: () => W.tabs.create({ url: params.linkURL, background: true, after: tab }) },
      { label: 'Open link in Glance', accel: 'Alt+Click', icon: 'search', action: () => openGlance(tab, params.linkURL) },
      { label: 'Open link in split view', icon: 'split', action: () => openLinkInSplit(tab, params.linkURL) },
      ...(!tab.private ? [{ label: 'Open link in new window', icon: 'window', action: () => openNewWindow(params.linkURL) }] : []),
      ...(!W.private ? [{ label: 'Open link in private window', icon: 'mask', action: () => openInPrivateWindow(params.linkURL) }] : []),
      { label: 'Copy link address', action: () => clipboard.writeText(params.linkURL) },
      ...(cleanUrl(params.linkURL) !== params.linkURL ? [{ label: 'Copy clean link', action: () => { clipboard.writeText(cleanUrl(params.linkURL)); toast('Copied link without tracking'); } }] : []),
      sep,
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Open image in new tab', action: () => W.tabs.create({ url: params.srcURL, background: true, after: tab }) },
      { label: 'Copy image', action: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', action: () => clipboard.writeText(params.srcURL) },
      { label: 'Save image as…', action: () => saveImageAs(wc, params, displayUrl(tab.url)) },
      sep,
    );
  }
  if (params.mediaType === 'video') {
    items.push(
      { label: tab.pip ? 'Close pop-out video' : 'Pop out video', accel: 'Alt+P', action: () => toggleVideoPopout(tab, params.frame) },
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
      ...(looksLikeAddress(text)
        ? [{ label: `Go to ${short}`, action: () => W.tabs.create({ url: data.toUrl(text), after: tab }) }]
        // Searching opens in Glance, so the results float over the page you're reading.
        : [
          { label: `Search for “${short}”`, icon: 'search', action: () => openGlance(tab, data.toUrl(text)) },
          { label: 'Search in new tab', action: () => W.tabs.create({ url: data.toUrl(text), after: tab }) },
        ]),
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
      { label: 'Save page as…', accel: 'Ctrl+S', disabled: !canSavePage(tab), action: () => savePageAs(tab) },
      { label: 'View page source', accel: 'Ctrl+U', disabled: !/^https?:/.test(tab.url), action: () => navigate(`view-source:${tab.url}`, { newTab: true }) },
      sep,
    );
  }
  if (ext && !tab.private) {
    const extra = ext.contextMenuItems(wc, params);
    if (extra.length) items.push(...extra, sep);
  }
  items.push({ label: 'Inspect', accel: 'F12', action: () => { wc.inspectElement(params.x, params.y); } });

  // The menu goes where the click was, in whichever half of a split the tab is.
  const bounds = tab.view ? tab.view.getBounds() : pageBounds().bounds;
  showMenu(bounds.x + params.x, bounds.y + params.y, items);
}

function tabMenu(id, x, y) {
  const tab = W.tabs.get(id);
  if (!tab) return;
  const i = W.tabs.tabs.indexOf(tab);
  const shown = displayUrl(tab.url);
  showMenu(x, y, [
    { label: 'Reload', action: () => { tab.ensureView(); tab.wc.reload(); } },
    { label: 'Duplicate', disabled: !shown, action: () => W.tabs.duplicate(tab) },
    { label: tab.muted ? 'Unmute tab' : 'Mute tab', accel: 'Ctrl+M', action: () => toggleMute(tab) },
    { label: 'Copy link', disabled: !shown, action: () => clipboard.writeText(shown) },
    { label: 'Put to sleep', disabled: W.tabs.shown.has(tab.id) || !tab.wc || tab.pip, action: () => tab.sleep() },
    ...(tab.pip || (tab.wc && tab.playing) ? [
      { label: tab.pip ? 'Close pop-out video' : 'Pop out video', accel: 'Alt+P', action: () => toggleVideoPopout(tab) },
    ] : []),
    { sep: true },
    ...splitAndWindowItems(tab),
    { label: 'Close tab', accel: 'Ctrl+W', action: () => W.tabs.close(tab.id) },
    { label: 'Close other tabs', disabled: W.tabs.tabs.length < 2, action: () => {
      for (const t of [...W.tabs.tabs]) if (t !== tab) W.tabs.close(t.id);
    } },
    { label: tabsOnTop() ? 'Close tabs to the right' : 'Close tabs below', disabled: i === W.tabs.tabs.length - 1, action: () => {
      for (const t of W.tabs.tabs.slice(i + 1)) W.tabs.close(t.id);
    } },
  ]);
}

/** A short label for a window: the title of its active tab. */
function windowLabel(state) {
  const t = state.tabs && state.tabs.active;
  const title = (t && (t.title || displayUrl(t.url))) || 'New Tab';
  return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

/**
 * Open a link beside the page it's on. In a split, it takes the other side
 * (the tab there stays open); otherwise the page and the link split the view.
 */
function openLinkInSplit(tab, url) {
  const t = W.tabs;
  const fresh = t.create({ url, background: true, after: tab });
  let side = 'right';
  if (t.pair && t.pair.left !== tab.id && t.pair.right === tab.id) side = 'left';
  t.splitAt(fresh.id, side, tab.id);
}

/** Tab menu items for split view and moving between windows. */
function splitAndWindowItems(tab) {
  const items = [];
  const t = W.tabs;
  const paired = t.pair && (t.pair.left === tab.id || t.pair.right === tab.id);
  if (paired) {
    items.push(
      { label: 'Swap sides', icon: 'swap', action: () => t.swapPanes() },
      { label: 'Close split view', icon: 'split', action: () => t.unsplit() },
    );
  } else {
    items.push({ label: 'Open beside current tab', icon: 'split', disabled: tab.id === t.activeId || !t.active, action: () => t.split(tab.id) });
  }
  const from = W;
  items.push({ label: 'Move to new window', icon: 'window', disabled: t.tabs.length < 2, action: () => moveTabToNewWindow(from, tab.id) });
  for (const other of winStates.filter((s) => s !== from && s.win && !s.win.isDestroyed() && s.private === from.private).slice(0, 4)) {
    items.push({ label: `Move to window: ${windowLabel(other)}`, action: () => moveTabToWindow(from, tab.id, other, Infinity) });
  }
  if (items.length) items.push({ sep: true });
  return items;
}

// ---------------------------------------------------------------------------
// Video pop-out (picture in picture): a page's video plays in a small
// always-on-top window while you use other tabs, windows or apps.
//
// The floating window has two buttons. "Back to tab" returns the video to
// the tab it came from (even after you went elsewhere in that tab, or closed
// it); its X closes the video. Chromium pauses the video on X and leaves it
// playing on "Back to tab", which is how the two are told apart.
// ---------------------------------------------------------------------------

// Run in each frame: how good a candidate this frame's best video is, and
// whether the frame already has a popped-out video.
const PIP_PROBE = `(() => {
  const vids = [];
  const walk = (root) => {
    for (const v of root.querySelectorAll('video')) vids.push(v);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  let best = 0;
  for (const v of vids) {
    if (v.readyState < 1) continue;
    const r = v.getBoundingClientRect();
    const score = 1 + r.width * r.height + (!v.paused && !v.ended ? 1e9 : 0) + (!v.muted ? 1e8 : 0);
    if (score > best) best = score;
  }
  return { score: best, pip: !!document.pictureInPictureElement };
})()`;

// Run in the chosen frame, with a user gesture: pop out its best video.
const PIP_START = `(async () => {
  const vids = [];
  const walk = (root) => {
    for (const v of root.querySelectorAll('video')) vids.push(v);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const score = (v) => {
    const r = v.getBoundingClientRect();
    return r.width * r.height + (!v.paused && !v.ended ? 1e9 : 0) + (!v.muted ? 1e8 : 0);
  };
  const v = vids.filter((x) => x.readyState >= 1).sort((a, b) => score(b) - score(a))[0];
  if (!v) return false;
  // Some sites turn pop-out off for their player; the person asked for it.
  v.disablePictureInPicture = false;
  v.removeAttribute('disablepictureinpicture');
  await v.requestPictureInPicture();
  window[Symbol.for('coffee.pipVideo')] = v;
  return true;
})()`;

// Run in that frame: settles when the floating window closes, saying which
// button closed it (X pauses the video; "Back to tab" leaves it playing).
const PIP_WAIT = `new Promise((resolve) => {
  const v = window[Symbol.for('coffee.pipVideo')];
  if (!v || document.pictureInPictureElement !== v) { resolve({ back: false }); return; }
  v.addEventListener('leavepictureinpicture', () => {
    // Read at once: X pauses the video before the window closes, while a page
    // that's out of sight may have its video paused just after (Back to tab).
    resolve({ back: !v.paused && !v.ended });
  }, { once: true });
})`;

/** Every live frame of a page (main frame first). */
function framesOf(wc) {
  try { return wc.mainFrame.framesInSubtree.filter((f) => !f.detached); } catch { return []; }
}

/**
 * Pages whose popped-out video outlived their place in a tab (you went back,
 * followed a link, or closed the tab or window). They keep running out of
 * sight, so the video plays on, until the floating video is closed (the page
 * is let go) or sent "Back to tab" (the page goes back into a tab).
 */
const pipKept = new Set();
// Pages whose floating video Coffee itself is closing (or replacing): when it
// closes, that's not a "Back to tab".
const pipClosing = new WeakSet();

function keepPip(view, origin) {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  view.origin = origin || {};
  view.missed = 0;
  pipKept.add(view);
  wc.once('destroyed', () => { if (pipKept.delete(view)) popoutChanged(); });
  popoutChanged();
  watchPip();
}

function releaseKept(view) {
  pipKept.delete(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  popoutChanged();
  // The last window was closed while the video played: now the app can go.
  if (!winStates.length && !pipKept.size) app.quit();
}

/** Bring the window forward and give it focus. */
function bringForward(state) {
  const w = state.win;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/**
 * "Back to tab" for a page that was handed off: it goes back into the tab it
 * came from, replacing what that tab shows now (the video carries on playing
 * there). If that tab is gone, the page opens in a new tab instead.
 */
function returnKept(view) {
  pipKept.delete(view);
  popoutChanged();
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  disarmPipGuard(wc);
  const origin = view.origin || {};
  const home = origin.tab && winStates.find((s) => s.tabs && s.tabs.tabs.includes(origin.tab));
  if (home) {
    inWindow(home, () => {
      origin.tab.takeView(view, origin);
      home.tabs.activate(origin.tab.id);
    });
    bringForward(home);
    return;
  }
  // Back into a window of its own kind (a private page only goes to a private window).
  const priv = !!origin.private;
  const fits = (s) => s.win && !s.win.isDestroyed() && s.tabs && s.private === priv;
  const state = (winStates.includes(W) && fits(W)) ? W : ([...winStates].reverse().find(fits) || createWindow({ private: priv }));
  inWindow(state, () => {
    const tab = state.tabs.create({ background: true, init: { url: wc.getURL(), title: origin.title, favicon: origin.favicon } });
    tab.muted = !!origin.muted;
    tab.takeView(view, origin);
    state.tabs.activate(tab.id);
  });
  bringForward(state);
}

/** The floating window of page `wc` closed. `back`: by "Back to tab". */
function pipEnded(wc, back) {
  if (pipClosing.has(wc)) { pipClosing.delete(wc); back = false; }
  const kept = [...pipKept].find((v) => v.webContents === wc);
  if (kept) {
    if (back) returnKept(kept);
    else releaseKept(kept);
    return;
  }
  const found = findTab(wc);
  if (!found) return;
  if (found.tab.pip) setPip(found.tab, false);
  // "Back to tab" while the tab is out of view: show it.
  if (back) {
    inWindow(found.state, () => found.state.tabs.activate(found.tab.id));
    bringForward(found.state);
  }
}

/** Tell every window whether a video is playing popped out from a page no tab shows. */
function popoutChanged() {
  eachWindow(() => emit('popout', pipKept.size > 0));
}

/** Close the floating video of page `wc` (Coffee's own doing, not "Back to tab"). */
async function exitPip(wc) {
  if (!wc || wc.isDestroyed()) return;
  pipClosing.add(wc);
  await Promise.all(framesOf(wc).map((f) => f.executeJavaScript('document.pictureInPictureElement && document.exitPictureInPicture()', true).catch(() => {})));
}

/** Close any popped-out video that's playing from a page no tab shows. */
async function closeKeptPopouts() {
  for (const view of [...pipKept]) {
    await exitPip(view.webContents);
    releaseKept(view);
  }
}

/**
 * Pop the page's video out into a floating window, or bring it back. With
 * nothing playing here, it closes a video still popped out from a page you left.
 */
async function toggleVideoPopout(tab, preferFrame) {
  const wc = tab && tab.wc;
  if (!wc) { if (pipKept.size) closeKeptPopouts(); return; }
  const probes = await Promise.all(framesOf(wc).map((f) => f.executeJavaScript(PIP_PROBE)
    .then((r) => (r ? { f, ...r } : null), () => null)));
  const live = probes.filter(Boolean);
  if (live.some((x) => x.pip)) {
    await exitPip(wc);
    setPip(tab, false);
    return;
  }
  const candidates = live.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const pick = candidates.find((x) => x.f === preferFrame) || candidates[0];
  // Nothing to pop out here (or nothing playing, while a video from a page
  // you left is still out): the button / Alt+P closes that one.
  if (!pick || (pipKept.size && !preferFrame && !tab.playing && !tab.audible)) {
    if (pipKept.size) closeKeptPopouts();
    return;
  }
  // Only one video can be popped out at a time: the one out now gets replaced.
  for (const t of allTabs()) if (t !== tab && t.pip && t.wc) pipClosing.add(t.wc);
  for (const v of pipKept) pipClosing.add(v.webContents);
  const ok = await pick.f.executeJavaScript(PIP_START, true).catch(() => false);
  if (!ok) return;
  for (const t of allTabs()) if (t !== tab && t.pip) setPip(t, false);
  setPip(tab, true);
  // Settles when the floating window closes, wherever the page is by then.
  pick.f.executeJavaScript(PIP_WAIT).then((r) => pipEnded(wc, !!(r && r.back))).catch(() => pipEnded(wc, false));
}

function setPip(tab, on) {
  if (tab.pip === on) return;
  tab.pip = on;
  tab.mgr.changed();
  if (on) { watchPip(); armPipGuard(tab); }
  else disarmPipGuard(tab.wc);
}

// A backstop for the above: now and then (only while a video is popped out),
// check the floating windows are still open.
let pipTimer = null;
function watchPip() {
  if (pipTimer) return;
  pipTimer = setInterval(async () => {
    const tabs = allTabs().filter((t) => t.pip);
    if (!tabs.length && !pipKept.size) { clearInterval(pipTimer); pipTimer = null; return; }
    const isOpen = async (wc) => (await Promise.all(framesOf(wc).map((f) => f.executeJavaScript('!!document.pictureInPictureElement').catch(() => false)))).some(Boolean);
    for (const t of tabs) {
      if (!t.wc || !(await isOpen(t.wc))) setPip(t, false);
    }
    for (const view of [...pipKept]) {
      if (view.webContents.isDestroyed()) { releaseKept(view); continue; }
      // Several misses in a row: the close was never reported, so let it go.
      view.missed = (await isOpen(view.webContents)) ? 0 : view.missed + 1;
      if (view.missed >= 3) releaseKept(view);
    }
  }, 1000);
}

// Sites like YouTube change pages without loading a new one: clicking a link
// (the logo, the home page, another video) rewrites the page in place, and the
// player, with its popped-out video, goes away. While a video is popped out,
// this catches such clicks (and plain search forms) before the site sees them
// and resolves with where they lead, so the browser can hand the page off
// (the video keeps playing) and open that address in the tab instead.
const PIP_GUARD = `new Promise((resolve) => {
  const key = Symbol.for('coffee.pipGuard');
  if (window[key]) window[key]();
  const plain = (e) => !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
  const elsewhere = (u) => /^(https?|file):$/.test(u.protocol) && u.href.split('#')[0] !== location.href.split('#')[0];
  const onClick = (e) => {
    if (!plain(e)) return;
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement && n.href);
    if (!a || a.hasAttribute('download')) return;
    const target = (a.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self' && target !== '_top') return;
    let u;
    try { u = new URL(a.href, location.href); } catch { return; }
    if (!elsewhere(u)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done({ url: u.href });
  };
  const onSubmit = (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement) || (f.method || 'get').toLowerCase() !== 'get') return;
    let u;
    try { u = new URL(f.action || location.href, location.href); } catch { return; }
    u.search = new URLSearchParams(new FormData(f)).toString();
    if (!elsewhere(u)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done({ url: u.href });
  };
  function done(result) {
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('submit', onSubmit, true);
    delete window[key];
    resolve(result || null);
  }
  window[key] = () => done(null);
  window.addEventListener('click', onClick, true);
  window.addEventListener('submit', onSubmit, true);
})`;

function armPipGuard(tab) {
  const wc = tab.wc;
  if (!wc) return;
  wc.mainFrame.executeJavaScript(PIP_GUARD).then((r) => {
    if (r && r.url && tab.wc === wc && tab.pip) tab.handoff({ url: r.url });
  }).catch(() => { /* page went away */ });
}

function disarmPipGuard(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.mainFrame.executeJavaScript("(window[Symbol.for('coffee.pipGuard')] || (() => {}))()").catch(() => {});
}

/**
 * Right-click on the browser's own frame: empty tab space, the title bar,
 * toolbar buttons. Tabs, recently closed tabs, and the window itself (in
 * place of Windows' own menu for the title bar).
 */
function sidebarMenu(x, y, { windowItems = true } = {}) {
  const recent = W.tabs.closed.slice(-5).reverse();
  const items = [
    { label: 'New tab', accel: 'Ctrl+T', icon: 'plus', action: () => W.tabs.create() },
    { label: 'New window', accel: 'Ctrl+N', icon: 'window', action: () => openNewWindow() },
    { label: 'New private window', accel: 'Ctrl+Shift+N', icon: 'mask', action: () => openPrivateWindow() },
    { label: 'Reopen closed tab', accel: 'Ctrl+Shift+T', icon: 'reload', disabled: !recent.length, action: () => W.tabs.reopenClosed() },
  ];
  if (recent.length) {
    items.push({ sep: true }, { label: 'Recently closed', disabled: true });
    recent.forEach((c, i) => {
      const title = c.init.title || displayUrl(c.init.url) || 'Untitled';
      items.push({ label: title.length > 34 ? `${title.slice(0, 33)}…` : title, action: () => W.tabs.reopenClosed(W.tabs.closed.length - 1 - i) });
    });
  }
  if (windowItems) {
    const win = W.win;
    const max = win.isMaximized();
    items.push(
      { sep: true },
      { label: 'Minimize', icon: 'minimize', action: () => win.minimize() },
      { label: max ? 'Restore' : 'Maximize', icon: max ? 'restore' : 'maximize', disabled: win.isFullScreen(), action: () => (max ? win.unmaximize() : win.maximize()) },
      { label: 'Close window', accel: 'Alt+F4', icon: 'winClose', action: () => win.close() },
    );
  }
  showMenu(x, y, items);
}

/** The ⋯ menu, grouped: open things · find your stuff · this page · watch & view · layout · app. */
function appMenu(x, y, opts = {}) {
  const t = W.tabs;
  const tab = t.active;
  const wc = activeWc();
  const s = data.settings.data;
  const fs = W.win.isFullScreen();
  // "Split view" splits with the tab you were on before this one.
  const partner = t.prevActiveId && t.prevActiveId !== t.activeId && t.get(t.prevActiveId) ? t.prevActiveId : null;
  const popout = (tab && tab.pip) || (pipKept.size && !(tab && (tab.playing || tab.audible)));
  const reopen = () => appMenu(x, y, { reopen: true });
  showMenu(x, y, [
    { label: 'New tab', accel: 'Ctrl+T', icon: 'plus', action: () => t.create() },
    { label: 'New window', accel: 'Ctrl+N', icon: 'window', action: () => openNewWindow() },
    { label: 'New private window', accel: 'Ctrl+Shift+N', icon: 'mask', action: () => openPrivateWindow() },
    { sep: true },
    { label: 'History', accel: 'Ctrl+H', icon: 'history', action: openHistory },
    { label: 'Downloads', accel: 'Ctrl+J', icon: 'download', action: () => toggleDownloads() },
    { label: 'Bookmarks', icon: 'bookmarks', action: () => openFolder(BM_ROOT, { x: x - 300, y: y - 6, width: 300, height: 0 }, true) },
    { label: 'Reopen closed tab', accel: 'Ctrl+Shift+T', icon: 'reload', disabled: !t.closed.length, action: () => t.reopenClosed() },
    { label: 'Search tabs', accel: 'Ctrl+Shift+A', icon: 'search', action: showTabSearch },
    { sep: true },
    {
      zoom: { value: tab && tab.zoom ? tab.zoom : 100, fullscreen: fs },
      action: (p) => {
        if (p.action === 'fullscreen') { W.fullscreenTab = null; W.win.setFullScreen(!fs); return; }
        zoom(p.action === 'in' ? 1 : p.action === 'out' ? -1 : 0);
        reopen(); // show the new level
      },
    },
    { label: 'Find in page', accel: 'Ctrl+F', icon: 'search', disabled: !wc, action: () => openFind() },
    { label: 'Print…', accel: 'Ctrl+P', icon: 'printer', disabled: !wc, action: () => wc.print() },
    { label: 'Save page as…', accel: 'Ctrl+S', icon: 'download', disabled: !canSavePage(tab), action: () => savePageAs(tab) },
    { sep: true },
    { label: popout ? 'Close pop-out video' : 'Pop out video', accel: 'Alt+P', icon: 'pip', disabled: !wc && !pipKept.size, action: () => toggleVideoPopout(tab) },
    t.pair
      ? { label: 'Close split view', icon: 'split', action: () => t.unsplit() }
      : { label: 'Split view with previous tab', icon: 'split', disabled: !partner, action: () => t.split(partner) },
    { sep: true },
    { label: 'Bookmarks bar', accel: 'Ctrl+Shift+B', checked: !!s.bookmarksBar, action: toggleBookmarksBar },
    { label: 'Tabs on top', checked: tabsOnTop(), action: toggleTabLayout },
    { label: 'Compact sidebar', checked: compactSidebar(), disabled: tabsOnTop(), action: toggleCompact },
    { label: 'Show tab titles', checked: s.tabTitles !== false, action: toggleTabTitles },
    { sep: true },
    { label: 'Extensions', icon: 'puzzle', action: () => (ext ? showExtensionsPanel() : openSettings('extensions')) },
    { label: 'Settings', accel: 'Ctrl+,', icon: 'settings', action: () => openSettings() },
  ], { reopen: opts.reopen });
}

/** Cut / copy / paste for the address bar and the find box (they're part of the browser's own page). */
async function chromeEditMenu(params) {
  const state = W;
  const ui = W.ui;
  const f = params.editFlags || {};
  const omni = inRect({ x: params.x, y: params.y }, W.omniRect);
  // Edits go back to the field the menu was opened on.
  const edit = (fn) => () => { ui.focus(); fn(); };
  // (Reading the clipboard is asynchronous; the menu shows in its own window after.)
  const clip = String((await clipboard.readText()) || '').trim();
  if (!state.win || state.win.isDestroyed()) return;
  inWindow(state, () => showEditMenu(params, { f, omni, edit, clip, ui }));
}

function showEditMenu(params, { f, omni, edit, clip, ui }) {
  const short = clip.length > 24 ? `${clip.slice(0, 24)}…` : clip;
  const pasteGo = looksLikeAddress(clip) ? 'Paste and go' : `Paste and search for “${short}”`;
  showMenu(params.x, params.y, [
    { label: 'Undo', accel: 'Ctrl+Z', disabled: !f.canUndo, action: edit(() => ui.undo()) },
    { label: 'Redo', accel: 'Ctrl+Y', disabled: !f.canRedo, action: edit(() => ui.redo()) },
    { sep: true },
    { label: 'Cut', accel: 'Ctrl+X', icon: 'cut', disabled: !f.canCut, action: edit(() => ui.cut()) },
    { label: 'Copy', accel: 'Ctrl+C', icon: 'copy', disabled: !f.canCopy, action: edit(() => ui.copy()) },
    { label: 'Paste', accel: 'Ctrl+V', icon: 'paste', disabled: !f.canPaste, action: edit(() => ui.paste()) },
    ...(omni && clip ? [{ label: pasteGo, action: () => { emit('urlbar:blur'); navigate(data.toUrl(clip)); } }] : []),
    { label: 'Delete', disabled: !f.canDelete, action: edit(() => ui.delete()) },
    { sep: true },
    { label: 'Select all', accel: 'Ctrl+A', action: edit(() => ui.selectAll()) },
  ]);
}

/** Right-click (or hold) on Back / Forward: the pages you can go back or forward to. */
function historyMenu(dir, x, y) {
  const tab = W.tabs.active;
  const wc = tab && tab.wc;
  if (!wc) return;
  const h = wc.navigationHistory;
  const entries = h.getAllEntries();
  const at = h.getActiveIndex();
  const list = (dir < 0 ? entries.map((e, i) => [e, i]).slice(0, at).reverse() : entries.map((e, i) => [e, i]).slice(at + 1)).slice(0, 12);
  if (!list.length) return;
  const items = list.map(([e, i]) => {
    const title = e.title || displayUrl(e.url) || e.url;
    return {
      label: title.length > 40 ? `${title.slice(0, 39)}…` : title,
      action: () => {
        if (tab.pip && tab.handoff({ offset: i - h.getActiveIndex() })) return;
        h.goToIndex(i);
      },
    };
  });
  items.push({ sep: true }, { label: 'Show full history', accel: 'Ctrl+H', icon: 'history', action: openHistory });
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
  const tab = W.tabs.active;
  const url = tab && displayUrl(tab.url);
  showMenu(x, y, [
    { label: 'New folder…', action: () => folderEditor({ parent: null }) },
    { label: 'Bookmark this page', accel: 'Ctrl+D', disabled: !url || isInternal(url), action: () => starBookmark() },
    { sep: true },
    { label: 'Hide bookmarks bar', accel: 'Ctrl+Shift+B', action: toggleBookmarksBar },
  ]);
}

function openAll(list) {
  for (const b of list.slice(0, 30)) W.tabs.create({ url: b.url, background: true, after: W.tabs.active });
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
  const [w, h] = W.win.getContentSize();
  const width = 340 + 2 * M;
  const height = 132 + 2 * M;
  W.overlay.open('confirm', { x: (w - width) / 2, y: Math.max(TOPBAR_H, h / 2 - height), width, height }, {
    title: `Delete “${item.title}”?`,
    message: `This also deletes the ${count} ${count === 1 ? 'item' : 'items'} inside it.`,
    confirm: 'Delete',
  }, { focus: true, onPick: (p) => { if (p.ok) { data.removeBookmark(id); bookmarksChanged(); } } });
}

/** Create ({ parent }) or rename ({ id }) a folder. */
function folderEditor({ id = null, parent = null }) {
  const folder = id ? data.itemById(id) : null;
  const [w] = W.win.getContentSize();
  const width = 320 + 2 * M;
  W.overlay.open('folder', { x: (w - width) / 2, y: TOPBAR_H + 4, width, height: 132 + 2 * M },
    { title: folder ? folder.title : '', rename: !!folder },
    { focus: true, onPick: (p) => {
      const title = String(p.title || '').trim() || 'New folder';
      if (folder) data.updateBookmark(id, { title });
      else data.addFolder(title, parent);
      bookmarksChanged();
    } });
}

/** Dropdown listing a folder's contents, anchored under its bar button. */
// W.folderFromButton: opened from the toolbar button, so top-level folders get a way back to the root.
const BM_ROOT = 'root';       // the toolbar button's top-level view (not a real folder)
function openFolder(id, rect, fromButton) {
  const isRoot = id === BM_ROOT;
  const folder = isRoot ? { id: BM_ROOT, title: 'Bookmarks', parent: null } : data.itemById(id);
  if (!folder || (!isRoot && folder.type !== 'folder')) return;
  if (rect) W.folderAnchor = rect;
  if (typeof fromButton === 'boolean') W.folderFromButton = fromButton;
  const r = W.folderAnchor || { x: 80, y: TOPBAR_H, width: 0, height: BOOKMARKS_H - 4 };
  const items = data.children(isRoot ? null : id).map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url || '', favicon: b.favicon || '' }));
  let back = null;
  if (!isRoot) {
    if (folder.parent) { const p = data.itemById(folder.parent); if (p) back = { id: p.id, title: p.title }; }
    else if (W.folderFromButton) back = { id: BM_ROOT, title: 'Bookmarks' };
  }
  const rows = Math.min(Math.max(items.length, 1), 12);
  const width = 280 + 2 * M;
  const height = 8 + (back ? 34 : 0) + rows * 32 + (items.some((b) => b.type === 'bookmark') ? 41 : 0) + 8 + 2 * M;
  const [w] = W.win.getContentSize();
  const x = Math.max(0, Math.min(r.x - M, w - width));
  W.overlay.open('bmfolder', { x, y: r.y + r.height + 4 - M, width, height },
    { id, root: isRoot, title: folder.title, items, back },
    { focus: true });
}

function starBookmark(rect) {
  if (rect) W.starRect = rect;
  const tab = W.tabs.active;
  const url = tab && displayUrl(tab.url);
  if (!url || isInternal(url)) return;
  let bm = data.findBookmark(url);
  const created = !bm;
  if (!bm) {
    bm = data.addBookmark({ url, title: tab.title, favicon: tab.favicon });
    bookmarksChanged();
  }
  editBookmark(bm, W.starRect, created);
}

function editBookmark(bm, rect, created = false) {
  const [w] = W.win.getContentSize();
  const width = 320 + 2 * M;
  const r = rect || { x: w - 360, y: TOPBAR_H - 6, width: 0, height: 0 };
  W.overlay.open('bookmark', { x: r.x + r.width - width + M + 6, y: r.y + r.height + 6 - M, width, height: 214 + 2 * M },
    { id: bm.id, title: bm.title, url: bm.url, created, parent: bm.parent || '', folders: data.folderTree() },
    { focus: true });
}

function toggleDownloads(rect) {
  if (W.overlay.isOpen('downloads')) return W.overlay.close();
  const r = rect || W.downloadsRect;
  if (!r) return;
  W.downloadsRect = r;
  const sum = downloads.summary();
  const n = Math.min(Math.max(sum.items.length, 1), 6);
  const width = 360 + 2 * M;
  const height = (sum.items.length ? 50 + n * 58 + 8 : 150) + 2 * M;
  W.overlay.open('downloads', { x: r.x + r.width - width + M + 4, y: r.y + r.height + 4 - M, width, height }, sum, { focus: true });
}

function showSuggest({ rect, items, selected }) {
  if (!items || !items.length) return W.overlay.isOpen('suggest') && W.overlay.close();
  const height = 12 + items.length * 40 + 2 * M;
  W.overlay.open('suggest', { x: rect.x - M, y: rect.y + rect.height + 6 - M, width: rect.width + 2 * M, height },
    { items, selected },
    { onPick: (p) => {
      emit('urlbar:blur');
      if (p.tab && !p.newTab && switchToTab(Number(p.tab))) return;
      navigate(p.url, { newTab: p.newTab });
    } });
}

// ---------------------------------------------------------------------------
// Link status bubble: the address of the link under the pointer, in the
// bottom corner of the page it's on (the right corner when the pointer is
// down in the left one).
// ---------------------------------------------------------------------------

function showStatus(tab, url) {
  const f = W.float;
  if (!f) return;
  if (!url || !tab.view || !W.tabs.visibleIds().includes(tab.id)) {
    clearTimeout(W.statusTimer);
    W.statusUrl = '';
    W.statusLong = false;
    f.hide('status', 120);
    return;
  }
  const b = tab.view.getBounds();
  if (b.width < 40 || b.height < 40) return;
  const c = W.win.getContentBounds();
  const cur = screen.getCursorScreenPoint();
  const px = cur.x - c.x;
  const py = cur.y - c.y;
  // Like Chrome: resting on the same link a moment shows its whole address.
  clearTimeout(W.statusTimer);
  const long = W.statusUrl === url && W.statusLong;
  W.statusUrl = url;
  W.statusLong = long;
  if (!long) {
    const state = W;
    W.statusTimer = setTimeout(() => inWindow(state, () => {
      if (state.statusUrl !== url || !state.float.isShowing('status')) return;
      state.statusLong = true;
      showStatus(tab, url);
    }), 1600);
  }
  const maxWidth = Math.round(long ? b.width - 24 : b.width * (b.width < 700 ? 0.8 : 0.5));
  // Pointer in the bottom-left corner, where the bubble would cover it: use the right one.
  const right = px < b.x + maxWidth + 24 && py > b.y + b.height - 60;
  f.show('status', { url, maxWidth, side: right ? 'right' : 'left' }, ({ width, height }) => ({
    x: right ? b.x + b.width - width : b.x,
    y: b.y + b.height - height,
  }));
}

// ---------------------------------------------------------------------------
// Tab hover cards: what a tab is (title, address, preview of the page) when
// you rest the pointer on it. Strips in the overlay (the compact peek panel)
// send rects relative to the overlay, so those are moved into the window.
// ---------------------------------------------------------------------------

function showTabCard({ id, rect, side }, kind) {
  const tab = W.tabs.get(Number(id));
  if (!tab || !rect) return;
  let { x, y, width, height } = rect;
  if (kind === 'overlay') {
    const o = W.overlay.view.getBounds();
    x += o.x;
    y += o.y;
  }
  const s = tab.serialize();
  const onScreen = W.tabs.visibleIds().includes(tab.id);
  const t = W.tabs;
  const below = side === 'below';
  const card = {
    title: s.title,
    url: s.newtab ? '' : s.url,
    audible: s.audible,
    muted: s.muted,
    private: s.private,
    pip: s.pip,
    sleeping: s.sleeping && !onScreen && !s.newtab,
    split: !!t.pair && (t.pair.left === tab.id || t.pair.right === tab.id),
    // A page you can already see needs no preview.
    thumb: !onScreen && !s.newtab ? tab.thumb || '' : '',
    side: below ? 'below' : 'right',
  };
  const S = 12; // the card's shadow margin (float.css)
  W.float.show('tabcard', card, () => (below
    ? { x: x - S, y: y + height + 2 }
    : { x: x + width + 2, y: y - S }));
}

// ---------------------------------------------------------------------------
// Open tabs everywhere: "Switch to tab" in the address bar, and tab search
// (Ctrl+Shift+A) across every window.
// ---------------------------------------------------------------------------

/** Every open tab in every window, as { st, tab }. */
function allOpenTabs() {
  const out = [];
  for (const st of winStates) {
    if (!st.tabs || !st.win || st.win.isDestroyed()) continue;
    for (const tab of st.tabs.tabs) out.push({ st, tab });
  }
  return out;
}

/** Bring a tab (in whichever window has it) to the front. */
function switchToTab(id) {
  const hit = allOpenTabs().find((x) => x.tab.id === id);
  if (!hit) return false;
  const { st } = hit;
  inWindow(st, () => {
    if (st.win.isMinimized()) st.win.restore();
    st.win.focus();
    st.tabs.activate(id);
  });
  return true;
}

const bareUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

/**
 * Address bar suggestions, where pages already open in a tab offer to switch
 * to it instead of opening them again (Chrome, Firefox and Arc do this).
 */
function suggestWithTabs(q, inline) {
  const items = data.suggest(q, { inline });
  const query = String(q || '').trim().toLowerCase();
  if (!query) return items;
  const cur = W.tabs.active;
  const priv = !!(cur && cur.private);
  const open = new Map(); // address -> tab
  for (const { tab } of allOpenTabs()) {
    const url = displayUrl(tab.url);
    if (!url || tab === cur || tab.private !== priv || isInternal(tab.url)) continue;
    if (!open.has(url)) open.set(url, tab);
  }
  if (!open.size) return items;
  const asTab = (tab) => ({
    kind: 'tab', title: tab.title || bareUrl(displayUrl(tab.url)), sub: 'Switch to tab', url: displayUrl(tab.url), favicon: tab.favicon, tab: tab.id,
  });
  const used = new Set();
  const out = items.map((it) => {
    const tab = (it.kind === 'history' || it.kind === 'bookmark') && open.get(it.url);
    if (!tab || used.has(tab.id)) return it;
    used.add(tab.id);
    return asTab(tab);
  });
  // Open tabs that match but aren't in the list yet go right after what Enter does.
  const words = query.split(/\s+/).filter(Boolean);
  const extra = [];
  for (const tab of open.values()) {
    if (used.has(tab.id) || extra.length >= 2) continue;
    const hay = `${tab.title} ${bareUrl(displayUrl(tab.url))}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) extra.push(asTab(tab));
  }
  let lead = 0;
  while (lead < out.length && lead < 2 && (out[lead].kind === 'url' || out[lead].inline)) lead++;
  out.splice(lead, 0, ...extra);
  return out.slice(0, 9);
}

function tabSearchItems() {
  return allOpenTabs()
    .filter(({ st }) => st.private === W.private) // private and normal tabs stay apart, as in Chrome
    .map(({ st, tab }) => {
      const s = tab.serialize();
      return {
        id: tab.id,
        title: s.title,
        url: s.newtab ? '' : s.url,
        favicon: s.newtab || s.internal ? '' : s.favicon,
        newtab: s.newtab,
        active: st === W && tab.id === W.tabs.activeId,
        audible: s.audible && !s.muted,
        muted: s.muted,
        private: s.private,
        win: st === W ? '' : windowLabel(st),
        last: st === W && tab.id === W.tabs.activeId ? Infinity : tab.lastActive || 0,
      };
    })
    .sort((a, b) => b.last - a.last)
    .map(({ last, ...rest }) => rest);
}

/** Tab search: every open tab, most recently used first; type to filter. */
function showTabSearch() {
  if (W.overlay.isOpen('tabsearch')) { W.overlay.close(); return; }
  const [w] = W.win.getContentSize();
  const width = Math.min(480, w - 32) + 2 * M;
  const page = pageBounds().bounds;
  const count = allOpenTabs().length;
  const height = 53 + Math.max(2, Math.min(count, 10)) * 46 + 10 + 2 * M;
  const refresh = () => W.overlay.update('tabsearch', { items: tabSearchItems() });
  W.overlay.open('tabsearch', { x: page.x + (page.width - width) / 2, y: page.y + 8 - M, width, height },
    { items: tabSearchItems() },
    { focus: true, onPick: (p) => {
      const id = Number(p.close || p.id);
      if (p.close) {
        const hit = allOpenTabs().find((x) => x.tab.id === id);
        if (hit) inWindow(hit.st, () => hit.st.tabs.close(id));
        if (W.overlay.isOpen('tabsearch')) refresh();
        return;
      }
      switchToTab(id);
    } });
}

// ---------------------------------------------------------------------------
// Copying addresses
// ---------------------------------------------------------------------------

/** Query parameters that only track where a link was shared or clicked. */
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|twclid|ttclid|li_fat_id|igshid|igsh|yclid|ysclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|oly_anon_id|oly_enc_id|vero_id|wickedid|rb_clickid|s_cid|srsltid|ref_src|ref_url|si)$/i;
/** Hosts where `si` is a share-tracking id (elsewhere it may mean something). */
const SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/i;

/** `url` without tracking parameters (Firefox's "Copy clean link"). */
function cleanUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    const drop = [...u.searchParams.keys()].filter((k) => TRACKING_PARAM.test(k) && (k.toLowerCase() !== 'si' || SI_HOSTS.test(u.hostname)));
    if (!drop.length) return url;
    for (const k of drop) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Whether text reads as a web address rather than words to search for. */
function looksLikeAddress(text) {
  const t = String(text || '').trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || (!/\s/.test(t) && /\.[a-z]{2,}(?:[:/?#]|$)/i.test(t));
}

// ---------------------------------------------------------------------------
// Save page as (Ctrl+S): the whole page with its images and styles, one
// .mhtml file, or a PDF.
// ---------------------------------------------------------------------------

function canSavePage(tab) {
  const url = tab && displayUrl(tab.url);
  return !!(tab && tab.wc && url && !isInternal(tab.url) && !url.startsWith('view-source:'));
}

async function savePageAs(tab = W.tabs.active) {
  if (!canSavePage(tab)) return;
  const state = W;
  const wc = tab.wc;
  let host = '';
  try { host = new URL(displayUrl(tab.url)).hostname; } catch { /* keep empty */ }
  const name = String(wc.getTitle() || host || 'page').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'page';
  const dir = data.settings.data.downloadDir || app.getPath('downloads');
  const r = await dialog.showSaveDialog(state.win, {
    title: 'Save page as',
    defaultPath: path.join(dir, `${name}.html`),
    filters: [
      { name: 'Webpage, complete', extensions: ['html', 'htm'] },
      { name: 'Webpage, single file', extensions: ['mhtml'] },
      { name: 'PDF', extensions: ['pdf'] },
    ],
  });
  if (r.canceled || !r.filePath || wc.isDestroyed()) return;
  const file = r.filePath;
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.pdf') await fs.promises.writeFile(file, await wc.printToPDF({ printBackground: true, preferCSSPageSize: true }));
    else await wc.savePage(file, ext === '.mhtml' || ext === '.mht' ? 'MHTML' : 'HTMLComplete');
    if (state.win && !state.win.isDestroyed()) inWindow(state, () => toast(`Saved ${path.basename(file)}`));
  } catch (err) {
    console.error('Save page failed:', err.message);
    if (state.win && !state.win.isDestroyed()) inWindow(state, () => toast("Couldn't save this page"));
  }
}

/** Ctrl+Shift+C: copy the page's address (Arc and Edge have this). */
function copyPageUrl() {
  const tab = W.tabs.active;
  const url = tab && displayUrl(tab.url);
  if (!url) return;
  clipboard.writeText(url);
  toast('Link copied');
}

/** A short note at the top of the page that fades by itself. */
function toast(text) {
  const f = W.float;
  if (!f) return;
  const page = pageBounds().bounds;
  f.show('toast', { text }, ({ width }) => ({ x: page.x + (page.width - width) / 2, y: page.y + 10 }));
  f.hide('toast', 1800);
}

function toggleMute(tab) {
  tab.muted = !tab.muted;
  if (tab.wc) tab.wc.setAudioMuted(tab.muted);
  W.tabs.changed();
}

/** Ctrl+Shift+PageUp / PageDown: move the tab one place along the strip. */
function moveActiveTab(dir) {
  const t = W.tabs;
  const tab = t.active;
  if (!tab) return;
  const i = t.tabs.indexOf(tab) + dir;
  if (i >= 0 && i < t.tabs.length) t.move(tab.id, i);
}

/** Middle-click Back / Forward / Reload: that page in a new tab beside this one. */
function duplicateActive(offset) {
  const tab = W.tabs.active;
  if (tab && displayUrl(tab.url)) W.tabs.duplicate(tab, { offset, background: true });
}


// ---------------------------------------------------------------------------
// Save image as: the image's own bytes (from the web, a data: URL, or a blob:
// the page made), named for what it really is, saved where you choose.
// ---------------------------------------------------------------------------

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tiff' };

/** { bytes, mime } from a data: URL. */
function decodeDataUrl(u) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/is.exec(u);
  if (!m) throw new Error('not a data URL');
  return { mime: (m[1] || 'application/octet-stream').toLowerCase(), bytes: m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8') };
}

/**
 * The Referer a browser sends by default (strict-origin-when-cross-origin):
 * the whole page address to the same origin, just the origin to another one
 * (none from https to plain http).
 */
function referrerFor(pageUrl, target) {
  try {
    const p = new URL(pageUrl);
    const t = new URL(target);
    if (!/^https?:$/.test(p.protocol)) return '';
    if (p.protocol === 'https:' && t.protocol === 'http:') return '';
    if (p.origin === t.origin) { p.hash = ''; return p.href; }
    return `${p.origin}/`;
  } catch {
    return '';
  }
}

async function saveImageAs(wc, params, pageUrl) {
  const src = params && params.srcURL;
  if (!wc || wc.isDestroyed() || !src) return;
  const state = W;
  const say = (text) => { if (state.win && !state.win.isDestroyed()) inWindow(state, () => toast(text)); };
  let got;
  try {
    if (/^data:/i.test(src)) {
      got = decodeDataUrl(src);
    } else if (/^blob:/i.test(src)) {
      // Made by the page: only the page (the frame that made it) can read it.
      const frame = params.frame && !params.frame.detached ? params.frame : wc.mainFrame;
      const dataUrl = await frame.executeJavaScript(`fetch(${JSON.stringify(src)}).then((r) => r.blob()).then((b) => new Promise((ok, no) => { const f = new FileReader(); f.onload = () => ok(f.result); f.onerror = no; f.readAsDataURL(b); }))`);
      got = decodeDataUrl(String(dataUrl));
    } else if (/^https?:/i.test(src)) {
      // Through the tab's own session (its cookies), saying which page it's from:
      // image hosts that refuse "hotlinked" requests accept it then. The referrer
      // follows the web's default rule (strict-origin-when-cross-origin): the
      // full address for the same site, only the origin for another site.
      // Chromium cancels a request whose referrer says more than that.
      const headers = { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
      const referrer = referrerFor(pageUrl, src);
      let res = null;
      try {
        res = await wc.session.fetch(src, { headers: referrer ? { ...headers, Referer: referrer } : headers });
      } catch { /* refused: try once more without a referrer */ }
      if (!res || !res.ok) res = await wc.session.fetch(src, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      got = { mime: String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), bytes: Buffer.from(await res.arrayBuffer()) };
    } else {
      throw new Error('unsupported address');
    }
  } catch (err) {
    console.error('Save image failed:', err.message);
    say("Couldn't get this image");
    return;
  }
  // A name from the address, with the extension of what the image really is.
  let base = 'image';
  try {
    if (/^https?:/i.test(src)) base = decodeURIComponent(new URL(src).pathname.split('/').pop() || '').replace(/\.[a-z0-9]{1,5}$/i, '') || 'image';
  } catch { /* keep "image" */ }
  base = base.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 100) || 'image';
  const ext = IMAGE_EXT[got.mime] || (/\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(src) || [])[1] || 'png';
  const dir = data.settings.data.downloadDir || app.getPath('downloads');
  const r = await dialog.showSaveDialog(state.win, {
    title: 'Save image as',
    defaultPath: path.join(dir, `${base}.${ext}`),
    filters: [{ name: `${ext.toUpperCase()} image`, extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return;
  try {
    await fs.promises.writeFile(r.filePath, got.bytes);
    say(`Saved ${path.basename(r.filePath)}`);
  } catch (err) {
    console.error('Save image failed:', err.message);
    say("Couldn't save the image there");
  }
}

// ---------------------------------------------------------------------------
// Full screen: when a page makes itself full screen, a notice names the site
// and how to leave. A full-screen page can draw anything, including a fake
// address bar or a fake login box ("full-screen phishing"); this can't be
// hidden by the page. It shows again when the pointer touches the top edge.
// ---------------------------------------------------------------------------

function showFullscreenNotice(tab) {
  const f = W.float;
  if (!f || !W.fullscreenTab || !W.win || W.win.isDestroyed()) return;
  let host = '';
  try {
    const u = new URL(displayUrl(tab.url));
    if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^www\./, '');
    else if (u.protocol === 'file:') host = 'A file on this computer';
  } catch { /* unknown */ }
  W.fsNoticeAt = Date.now();
  f.show('fsnotice', { host, secure: tab.url.startsWith('https:') }, ({ width }) => {
    const [w] = W.win.getContentSize();
    return { x: Math.round((w - width) / 2), y: 14 };
  });
  f.hide('fsnotice', 4600);
}

function watchFullscreenEdge(on) {
  const state = W;
  clearInterval(state.fsWatch);
  state.fsWatch = null;
  if (!on) { if (state.float) state.float.hide('fsnotice'); return; }
  state.fsWatch = setInterval(() => inWindow(state, () => {
    if (!state.fullscreenTab || !state.win || state.win.isDestroyed()) { clearInterval(state.fsWatch); state.fsWatch = null; return; }
    if (!state.win.isFocused()) return;
    const p = screen.getCursorScreenPoint();
    const b = state.win.getContentBounds();
    const atTop = p.y - b.y <= 2 && p.x >= b.x && p.x < b.x + b.width;
    if (atTop && !state.float.isShowing('fsnotice') && Date.now() - (state.fsNoticeAt || 0) > 1500) showFullscreenNotice(state.fullscreenTab);
  }), 150);
}

// ---------------------------------------------------------------------------
// Glance: a link opened in a floating preview over the page (Alt+click, or
// "Open link in Glance"), without making a tab. "Open as tab" hands the live
// page to a new tab, as it is, without loading it again.
// ---------------------------------------------------------------------------

const GLANCE_BAR = 44;

/** Where the preview goes: centered over the page, the bar above it. */
function glanceRect() {
  const b = pageBounds().bounds;
  const side = Math.max(24, Math.round(b.width * 0.07));
  const width = Math.max(360, Math.min(1280, b.width - 2 * side));
  const top = 24 + GLANCE_BAR;
  return { x: b.x + Math.round((b.width - width) / 2), y: b.y + top, width, height: Math.max(200, b.height - top - 24) };
}

function sendGlance(g, ev, payload) {
  const wc = g.chrome.webContents;
  if (wc.isDestroyed()) return;
  if (g.ready) wc.send(`ev:${ev}`, payload);
  else g.queue.set(ev, payload);
}

function glancePageInfo(g) {
  const wc = g.view.webContents;
  if (wc.isDestroyed()) return;
  let host = '';
  const url = wc.getURL() || g.url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* none */ }
  const title = wc.getTitle();
  const h = wc.navigationHistory;
  sendGlance(g, 'glance:page', {
    title: title && title !== url ? title : '', host, favicon: g.favicon || '', loading: wc.isLoading(), secure: url.startsWith('https:'),
    canGoBack: h.canGoBack(), canGoForward: h.canGoForward(),
  });
}

/** Lay the preview out (window resized, page moved); `from` animates it in from a rect. */
function layoutGlance(from) {
  const g = W.glance;
  if (!g || g.closing) return;
  const b = pageBounds().bounds;
  g.chrome.setBounds(b);
  const r = glanceRect();
  sendGlance(g, 'glance:place', { x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height, bar: GLANCE_BAR });
  clearInterval(g.anim);
  if (!from) { g.view.setBounds(r); return; }
  // Grow from the link to the preview's place.
  const t0 = Date.now();
  const D = 240;
  const step = () => {
    const k = Math.min(1, (Date.now() - t0) / D);
    const e = 1 - (1 - k) ** 3;
    const lerp = (a, c) => Math.round(a + (c - a) * e);
    if (!g.view.webContents.isDestroyed()) g.view.setBounds({ x: lerp(from.x, r.x), y: lerp(from.y, r.y), width: Math.max(1, lerp(from.width, r.width)), height: Math.max(1, lerp(from.height, r.height)) });
    if (k >= 1) clearInterval(g.anim);
  };
  step();
  g.anim = setInterval(step, 12);
}

function openGlance(tab, url, from) {
  if (!/^https?:/i.test(String(url || ''))) return;
  const state = W;
  if (!state.win || state.win.isDestroyed()) return;
  if (state.glance && !state.glance.closing) { state.glance.view.webContents.loadURL(url).catch(() => {}); return; }
  if (state.overlay.isOpen()) state.overlay.close();
  const chrome = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  chrome.setBackgroundColor('#00000000');
  lockDown(chrome.webContents);
  const view = new WebContentsView({
    webPreferences: {
      session: tab.session, preload: path.join(ROOT, 'preload', 'internal.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webSecurity: true, spellcheck: true,
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setBorderRadius(12);
  const g = { chrome, view, tab, url, favicon: '', ready: false, queue: new Map(), closing: false, anim: null };
  state.glance = g;
  const wc = view.webContents;
  const live = () => state.glance === g && !g.closing;
  const info = () => inWindow(state, () => { if (live()) glancePageInfo(g); });
  for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) wc.on(ev, info);
  wc.on('page-favicon-updated', (_e, icons) => { g.favicon = icons[0] || ''; info(); });
  wc.setWindowOpenHandler(({ url: u, disposition }) => {
    if (disposition === 'new-window') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { session: tab.session, sandbox: true, contextIsolation: true } } };
    if (/^https?:/i.test(u)) inWindow(state, () => state.tabs.create({ url: u, background: disposition === 'background-tab' }));
    return { action: 'deny' };
  });
  wc.on('context-menu', (_e, params) => inWindow(state, () => { if (live()) glanceMenu(g, params); }));
  // A click in Glance (its page, bar or backdrop) while a menu is open closes the
  // menu, and does only that: it doesn't also close Glance or press a button.
  const dismissMenu = (_e, mouse) => inWindow(state, () => {
    if (mouse.type !== 'mouseDown' || !state.overlay.isOpen() || state.overlay.type === 'tooltip') return;
    state.overlay.close();
    g.menuClosedAt = Date.now();
  });
  wc.on('before-mouse-event', dismissMenu);
  chrome.webContents.on('before-mouse-event', dismissMenu);
  wc.on('before-input-event', (e, input) => inWindow(state, () => {
    if (!live()) return;
    if (input.type === 'keyDown' && input.key === 'Escape' && !wc.isLoading()) { e.preventDefault(); closeGlance(); return; }
    if (input.type === 'keyDown' && input.alt && !input.control && !input.meta && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
      e.preventDefault();
      glanceHistory(input.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt) {
      if (input.key.toLowerCase() === 'w') { e.preventDefault(); closeGlance(); return; }
      if (input.key === 'Enter') { e.preventDefault(); expandGlance(); return; }
    }
    onInput(e, input, null);
  }));
  chrome.webContents.once('did-finish-load', () => {
    g.ready = true;
    for (const [ev, payload] of g.queue) chrome.webContents.send(`ev:${ev}`, payload);
    g.queue.clear();
    chrome.webContents.send('ev:theme', theme);
  });
  chrome.webContents.loadFile(path.join(ROOT, 'ui', 'glance.html'));
  state.win.contentView.addChildView(chrome);
  state.win.contentView.addChildView(view);
  sendGlance(g, 'glance:show', {});
  glancePageInfo(g);
  const b = pageBounds().bounds;
  const start = from && from.width > 0 ? from : { x: b.x + b.width / 2 - 60, y: b.y + b.height / 2 - 40, width: 120, height: 80 };
  layoutGlance(start);
  wc.loadURL(url).catch(() => {});
  wc.focus();
}

/** The click that reached Glance's bar only closed a menu (see dismissMenu in openGlance). */
function glanceClickJustClosedMenu() {
  return !!(W.glance && Date.now() - (W.glance.menuClosedAt || 0) < 400);
}

/** Back (-1) / forward (1) in Glance's own history. */
function glanceHistory(dir) {
  const g = W.glance;
  if (!g || g.closing) return false;
  const h = g.view.webContents.navigationHistory;
  if (dir < 0 ? !h.canGoBack() : !h.canGoForward()) return true;
  if (dir < 0) h.goBack(); else h.goForward();
  return true;
}

/** Close Glance: shrink away, then let the page go (unless it became a tab). */
function closeGlance({ instant = false, keepPage = false } = {}) {
  const state = W;
  const g = state.glance;
  if (!g || g.closing) return;
  g.closing = true;
  clearInterval(g.anim);
  sendGlance(g, 'glance:hide', {});
  const finish = () => {
    clearInterval(g.anim);
    if (state.glance === g) state.glance = null;
    if (state.win && !state.win.isDestroyed()) {
      try { state.win.contentView.removeChildView(g.chrome); } catch { /* gone */ }
      if (!keepPage) { try { state.win.contentView.removeChildView(g.view); } catch { /* gone */ } }
    }
    if (!g.chrome.webContents.isDestroyed()) g.chrome.webContents.close();
    if (!keepPage && !g.view.webContents.isDestroyed()) g.view.webContents.close();
    const t = state.tabs && state.tabs.active;
    if (!keepPage && t && t.wc && state.win && !state.win.isDestroyed() && state.win.isFocused()) t.wc.focus();
  };
  if (instant || keepPage) { finish(); return; }
  // Shrink a little toward the middle as the backdrop fades.
  const r = g.view.getBounds();
  const t0 = Date.now();
  g.anim = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / 140);
    const s = 1 - 0.06 * k;
    if (!g.view.webContents.isDestroyed()) {
      g.view.setBounds({ x: Math.round(r.x + (r.width * (1 - s)) / 2), y: Math.round(r.y + (r.height * (1 - s)) / 2), width: Math.round(r.width * s), height: Math.round(r.height * s) });
    }
    if (k >= 1) finish();
  }, 12);
}

/** Make the previewed page a real tab (and optionally split it beside the page it came from). */
function expandGlance({ split = false } = {}) {
  const state = W;
  const g = state.glance;
  if (!g || g.closing) return;
  const wc = g.view.webContents;
  if (wc.isDestroyed()) return closeGlance({ instant: true });
  const parent = state.tabs.tabs.includes(g.tab) ? g.tab : state.tabs.active;
  closeGlance({ keepPage: true });
  try { state.win.contentView.removeChildView(g.view); } catch { /* not attached */ }
  const t = state.tabs.create({ background: true, after: parent, init: { url: wc.getURL() || g.url, title: wc.getTitle(), favicon: g.favicon } });
  t.takeView(g.view, { title: wc.getTitle(), favicon: g.favicon });
  t.playing = false;
  t.loading = wc.isLoading();
  if (split && parent) state.tabs.splitAt(t.id, 'right', parent.id);
  else state.tabs.activate(t.id);
}

function glanceMenu(g, params) {
  const wc = g.view.webContents;
  const items = [];
  const sep = { sep: true };
  if (params.linkURL) {
    items.push(
      { label: 'Open link here', action: () => wc.loadURL(params.linkURL).catch(() => {}) },
      { label: 'Open link in new tab', action: () => W.tabs.create({ url: params.linkURL, background: true }) },
      { label: 'Copy link address', action: () => clipboard.writeText(params.linkURL) },
      sep,
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Copy image', action: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Save image as…', action: () => saveImageAs(wc, params, wc.getURL()) },
      sep,
    );
  }
  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: 'Cut', accel: 'Ctrl+X', disabled: !f.canCut, action: () => wc.cut() },
      { label: 'Copy', accel: 'Ctrl+C', disabled: !f.canCopy, action: () => wc.copy() },
      { label: 'Paste', accel: 'Ctrl+V', disabled: !f.canPaste, action: () => wc.paste() },
      sep,
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    items.push({ label: 'Copy', accel: 'Ctrl+C', action: () => wc.copy() }, sep);
  }
  items.push(
    { label: 'Back', disabled: !wc.navigationHistory.canGoBack(), action: () => wc.navigationHistory.goBack() },
    { label: 'Forward', disabled: !wc.navigationHistory.canGoForward(), action: () => wc.navigationHistory.goForward() },
    { label: 'Reload', action: () => wc.reload() },
    sep,
    { label: 'Open as tab', accel: 'Ctrl+Enter', icon: 'window', action: () => expandGlance() },
    { label: 'Open in split view', icon: 'split', action: () => expandGlance({ split: true }) },
    { label: 'Close Glance', accel: 'Esc', action: () => closeGlance() },
    sep,
    { label: 'Inspect', accel: 'F12', action: () => wc.inspectElement(params.x, params.y) },
  );
  const b = g.view.getBounds();
  showMenu(b.x + params.x, b.y + params.y, items);
}

/** The ad blocker exception that covers `host`, if any. */
function exceptionFor(host) {
  return (data.settings.data.adblockExceptions || []).find((x) => sites.matches(host, x)) || null;
}

/** Turn ad blocking off (`allow`) or back on for a site and its subdomains. */
function setAdblockException(site, allow) {
  const host = sites.normalizeHost(site);
  if (!host) return false;
  const s = data.settings.data;
  const list = (s.adblockExceptions || []).filter((x) => x !== host);
  if (allow) list.push(host);
  s.adblockExceptions = list.sort();
  adblock.setExceptions(s.adblockExceptions);
  data.settings.save();
  eachWindow(() => emit('settings', publicSettings()));
  broadcastSettings();
  return true;
}

function shieldMenu(rect) {
  const tab = W.tabs.active;
  const on = data.settings.data.adblock;
  const n = tab ? tab.blocked : 0;
  const host = tab && !tab.private ? sites.hostOf(displayUrl(tab.url)) : '';
  const allowed = host ? exceptionFor(host) : null;
  const items = [
    { label: !on ? 'Ad blocking is off' : allowed ? 'Ad blocking is paused on this site' : `${n} ${n === 1 ? 'ad or tracker' : 'ads & trackers'} blocked here`, disabled: true },
    { label: `${data.settings.data.blockedTotal.toLocaleString()} blocked in total`, disabled: true },
    { sep: true },
    { label: on ? 'Turn off ad blocking' : 'Turn on ad blocking', action: () => setSetting('adblock', !on) },
  ];
  if (on && host) {
    items.push({
      label: allowed ? 'Resume blocking on this site' : 'Pause blocking on this site',
      action: () => { if (setAdblockException(allowed || host, !allowed)) reload(); },
    });
  }
  if (host) {
    const site = cookieSite(host);
    items.push({ label: 'Clear cookies for this site', action: () => { clearSiteData(site).catch(() => {}); } });
  }
  showMenu(rect.x, rect.y + rect.height + 4, items);
}

// ---------------------------------------------------------------------------
// Cookies and site data, per site
// ---------------------------------------------------------------------------

/** The site a cookie domain belongs to (example.com for .www.example.com). */
function cookieSite(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return parseDomain(d).domain || d;
}

/** Sites that have cookies, with a count each. */
async function cookieSites() {
  const map = new Map();
  for (const c of await webSession.cookies.get({})) {
    const site = cookieSite(c.domain);
    if (site) map.set(site, (map.get(site) || 0) + 1);
  }
  return [...map].map(([site, count]) => ({ site, count })).sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * Remove a site's cookies and stored data (local storage, IndexedDB, caches).
 * A registrable domain (example.com) covers all its subdomains; a longer host
 * (mail.example.com) covers just that host and below. Returns cookies removed.
 */
async function clearSiteData(input) {
  const site = sites.normalizeHost(input);
  if (!site) return 0;
  const origins = new Set();
  for (const h of [site, `www.${site}`]) for (const p of ['https', 'http']) origins.add(`${p}://${h}`);
  for (const h of data.history.values()) {
    const host = sites.hostOf(h.url);
    if (sites.matches(host, site)) { try { origins.add(new URL(h.url).origin); } catch { /* skip */ } }
  }
  let n = 0;
  for (const c of await webSession.cookies.get({})) {
    const d = c.domain.replace(/^\./, '').toLowerCase();
    if (cookieSite(d) !== site && !sites.matches(d, site)) continue;
    origins.add(`${c.secure ? 'https' : 'http'}://${d}`);
    try { await webSession.cookies.remove(`${c.secure ? 'https' : 'http'}://${d}${c.path || '/'}`, c.name); n++; } catch { /* already gone */ }
  }
  await Promise.all([...origins].map((origin) => webSession.clearStorageData({ origin }).catch(() => {})));
  return n;
}

// ---------------------------------------------------------------------------
// Default browser
// ---------------------------------------------------------------------------

/** Where the installed Coffee lives; also matches when running from source (npm start). */
function coffeeExePaths() {
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Coffee', 'Coffee.exe');
  return [process.execPath, app.getPath('exe'), installed].filter(Boolean).map((p) => path.resolve(p).toLowerCase());
}

async function defaultBrowserStatus() {
  try {
    const info = await app.getApplicationInfoForProtocol('https://');
    const handler = info.path ? path.resolve(info.path).toLowerCase() : '';
    const same = !!handler && coffeeExePaths().includes(handler);
    return { isDefault: same, name: info.name || '' };
  } catch {
    return { isDefault: false, name: '' };
  }
}

/** Re-check after the user changes the default in Windows, then tell any open Settings tab. */
async function refreshDefaultBrowser() {
  const st = await defaultBrowserStatus();
  for (const t of allTabs()) {
    if (t.wc && t.url.startsWith('coffee://settings')) t.wc.send('ev:browser', st);
  }
}

/** Every tab in every open window. */
function allTabs() {
  return winStates.flatMap((s) => (s.tabs ? s.tabs.tabs : []));
}

/** Windows doesn't let apps set themselves as default; open the page where the user picks Coffee. */
function openDefaultBrowserSettings() {
  if (process.platform === 'win32') {
    shell.openExternal('ms-settings:defaultapps?registeredAppUser=Coffee').catch(() => {});
  } else {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  }
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
    // Extensions act on whichever window is current (the focused one).
    win: () => W.win,
    tabs: () => W.tabs,
    windows: () => winStates.filter((s) => s.tabs && s.win && !s.win.isDestroyed()),
    findTab: (wc) => { const f = findTab(wc); return f ? f.tab : null; },
    newWindow: (url) => openNewWindow(url),
    confirmInstall: confirmExtensionInstall,
  });
  ext = mod;
  eachWindow(() => emit('settings', publicSettings()));
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
    const [w, h] = W.win.getContentSize();
    const width = 380 + 2 * M;
    const height = 150 + readable.length * 22 + 2 * M;
    let icon = '';
    try { icon = details.icon && !details.icon.isEmpty() ? details.icon.resize({ width: 32 }).toDataURL() : ''; } catch { /* no icon */ }
    W.win.focus();
    W.overlay.open('extinstall', { x: (w - width) / 2, y: Math.max(TOPBAR_H, h / 2 - height), width, height }, {
      name: details.localizedName || m.name || 'this extension',
      icon,
      permissions: readable,
    }, { focus: true, onPick: (p) => resolve(!!p.ok), onClose: () => resolve(false) });
  });
}

function showExtensionsPanel(rect) {
  if (rect) W.extRect = rect;
  const r = W.extRect || { x: W.win.getContentSize()[0] - 200, y: 8, width: 32, height: 32 };
  const list = ext ? ext.list() : [];
  const width = 320 + 2 * M;
  const height = 50 + Math.max(1, Math.min(list.length, 7)) * 52 + 54 + 2 * M;
  W.overlay.open('extensions', { x: r.x + r.width - width + M + 4, y: r.y + r.height + 4 - M, width, height }, { list }, { focus: true });
}

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
    // Downloads are shared: every window's button and panel show progress.
    eachWindow(() => {
      emit('downloads', { ...sum, items: undefined });
      W.overlay.update('downloads', sum);
    });
  }, (entry, wc) => {
    const found = findTab(wc);
    inWindow(found ? found.state : W, () => {
      emit('downloads:started', { filename: entry.filename });
      // A tab opened only to start a download is useless afterwards.
      const tab = found && found.tab;
      if (tab && !wc.getURL() && W.tabs.tabs.length > 1) W.tabs.close(tab.id);
    });
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
    // Ask in the window that shows the tab; only a tab on screen may ask.
    const found = findTab(wc);
    if (!what || !found || !found.state.tabs.shown.has(found.tab.id)) return callback(false);
    let answered = false;
    const answer = (allow, remember) => {
      if (answered) return;
      answered = true;
      if (remember && !priv) { decisions()[key] = allow; data.settings.save(); }
      callback(allow);
    };
    const host = origin.replace(/^https?:\/\//, '');
    inWindow(found.state, () => {
      const omni = W.omniRect || { x: SIDEBAR_W + 120, y: 8, width: 400, height: 32 };
      W.overlay.open('permission', { x: omni.x - M, y: omni.y + omni.height + 6 - M, width: 340 + 2 * M, height: 128 + 2 * M },
        { host, what: permission === 'openExternal' && details.externalURL ? `open ${new URL(details.externalURL).protocol.replace(':', '')} links` : what },
        { focus: true, onPick: (p) => answer(!!p.allow, true), onClose: () => answer(false, false) });
    });
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    const v = decisions()[`${originOf(requestingOrigin)}|${permission}`];
    return v === true;
  });
}

// ---------------------------------------------------------------------------
// Settings changes from coffee://settings
// ---------------------------------------------------------------------------

/** A typed home page as a full http(s) address, or '' if it isn't one. */
function normalizeHomePage(input) {
  let s = String(input || '').trim();
  if (!s || /\s/.test(s)) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return '';
    return u.href;
  } catch {
    return '';
  }
}

const homeUrl = () => data.settings.data.homePage || NEWTAB;

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
    // Layout changes are applied to every window by refreshWindows() below.
    case 'bookmarksBar':
      s.bookmarksBar = !!value;
      break;
    case 'findList':
      s.findList = !!value;
      eachWindow(() => { if (!s.findList && W.overlay.isOpen('findlist')) W.overlay.close(); });
      break;
    case 'bookmarksButton':
      s.bookmarksButton = !!value;
      if (!s.bookmarksButton) eachWindow(() => { if (W.overlay.isOpen('bmfolder')) W.overlay.close(); });
      break;
    case 'tabLayout':
      s.tabLayout = value === 'horizontal' ? 'horizontal' : 'vertical';
      break;
    case 'compactSidebar':
      s.compactSidebar = !!value;
      break;
    case 'tabTitles':
      s.tabTitles = !!value;
      eachWindow(() => { if (W.overlay.isOpen('sidebar')) W.overlay.close(); });
      break;
    case 'newtabShortcuts':
      s.newtabShortcuts = !!value;
      break;
    case 'homePage':
      if (!String(value || '').trim()) s.homePage = '';
      else {
        const url = normalizeHomePage(value);
        if (!url) break;
        s.homePage = url;
      }
      break;
    case 'showHome':
      s.showHome = !!value;
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
      const saved = themes.sanitizeSaved(v.saved !== undefined ? v.saved : s.theme.saved);
      const savedIds = new Set(saved.map((x) => `saved:${x.id}`));
      // Custom themes are all saved themes now (see data.js); there's no separate "custom" slot.
      const preset = themes.PRESETS.some((p) => p.id === v.preset) || savedIds.has(v.preset) ? v.preset : 'coffee';
      s.theme = { preset, custom: null, saved };
      applyTheme();
      break;
    }
    default:
      return;
  }
  data.settings.save();
  refreshWindows();
  broadcastSettings();
}

// Alt+click on a link (see preload/compat.js): Glance. From Glance itself, it opens there.
ipcMain.on('glance:open', (e, p = {}) => {
  const url = String((p && p.url) || '');
  if (!/^https?:/i.test(url)) return;
  const inGlance = winStates.find((s) => s.glance && s.glance.view.webContents === e.sender);
  if (inGlance) { inGlance.glance.view.webContents.loadURL(url).catch(() => {}); return; }
  const hit = findTab(e.sender);
  if (!hit || !hit.tab.view) return;
  const b = hit.tab.view.getBounds();
  const r = p.rect || {};
  const from = Number.isFinite(r.x) ? { x: b.x + Math.round(r.x), y: b.y + Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) } : null;
  inWindow(hit.state, () => openGlance(hit.tab, url, from));
});

// Ctrl+S that the page itself didn't handle (see preload/compat.js).
ipcMain.on('page:save-shortcut', (e) => {
  const hit = findTab(e.sender);
  if (hit) inWindow(hit.state, () => savePageAs(hit.tab));
});

/** -1 / 0 / 1 for version strings like 0.1.16. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Patch notes for this version and the three before it, newest first. */
function notesForThisVersion() {
  const v = app.getVersion();
  return patchNotes
    .filter((n) => compareVersions(n.version, v) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, 4);
}

function settingsPayload() {
  const s = data.settings.data;
  return {
    searchEngine: s.searchEngine,
    engines: Object.entries(data.SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
    adblock: s.adblock,
    adblockExceptions: s.adblockExceptions || [],
    bookmarksBar: s.bookmarksBar,
    bookmarksButton: !!s.bookmarksButton,
    tabLayout: s.tabLayout,
    compactSidebar: !!s.compactSidebar,
    tabTitles: s.tabTitles !== false,
    newtabShortcuts: s.newtabShortcuts !== false,
    homePage: s.homePage || '',
    showHome: !!s.showHome,
    extensions: !!s.extensions,
    extensionsRunning: !!ext,
    hiddenShortcuts: (s.hiddenShortcuts || []).length,
    sleepMinutes: s.sleepMinutes,
    restoreSession: s.restoreSession,
    theme: { preset: s.theme.preset, custom: s.theme.custom, saved: themes.sanitizeSaved(s.theme.saved) },
    presets: themes.PRESETS,
    downloadDir: s.downloadDir,
    blockedTotal: s.blockedTotal,
    version: app.getVersion(),
    whatsNewTitle: (notesForThisVersion().find((n) => n.version === app.getVersion()) || {}).title || '',
    update: updater.status,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
}

/** Tell every open Settings page (in any window) about a change. */
function broadcastSettings() {
  for (const t of allTabs()) {
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
  if (!wcId) return;
  const tab = allTabs().find((t) => t.wc && t.wc.id === wcId);
  if (tab) { tab.blocked += 1; tab.mgr.changed(); }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const INTERNAL_SEND = new Set(['nav:go', 'settings:set', 'history:clear', 'data:clear', 'update:check', 'update:install', 'newtab:hide', 'shortcuts:restore', 'welcome:done', 'app:relaunch', 'history:delete', 'history:clear-range', 'history:clear-site', 'cookies:clear-site', 'adblock:allow', 'browser:set-default', 'whatsnew:open', 'clipboard:write-text']);
const INTERNAL_INVOKE = new Set(['newtab:data', 'settings:get', 'downloads:choose-dir', 'import:detect', 'import:run', 'history:list', 'history:sites', 'cookies:sites', 'browser:default', 'whatsnew:data', 'clipboard:read-text']);

/** The window state that owns a sender's chrome or overlay (falls back to the current window). */
function ownerOf(e) {
  const wc = e.sender;
  return winStates.find((s) => s.ui === wc || (s.overlay && s.overlay.wc === wc) || (s.float && s.float.wc === wc) || (s.glance && s.glance.chrome.webContents === wc)) || W;
}

function senderKind(e) {
  const wc = e.sender;
  const owner = ownerOf(e);
  if (wc === owner.ui) return 'ui';
  if (owner.overlay && wc === owner.overlay.wc) return 'overlay';
  if (owner.float && wc === owner.float.wc) return 'float';
  if (owner.glance && wc === owner.glance.chrome.webContents) return 'glance';
  const url = e.senderFrame ? e.senderFrame.url : wc.getURL();
  if (url && url.startsWith('coffee://')) return 'internal';
  return null;
}

ipcMain.on('theme:sync', (e) => {
  e.returnValue = senderKind(e) ? theme : null;
});

ipcMain.on('cmd', (e, type, p = {}) => {
  // The tab drag card asks for a step every frame it draws; it may send nothing else.
  if (type === 'drag:frame') {
    if (tabDrag && !tabDrag.ghost.isDestroyed() && e.sender === tabDrag.ghost.webContents) dragTick();
    return;
  }
  const kind = senderKind(e);
  if (!kind || (kind === 'internal' && !INTERNAL_SEND.has(type))) return;
  // The hint view only reports what it drew.
  if (kind === 'float' && type !== 'float:size') return;
  // Glance's bar can only act on Glance.
  if (kind === 'glance' && !['glance:close', 'glance:expand', 'glance:split', 'glance:copy', 'glance:back', 'glance:forward', 'glance:reload', 'glance:stop'].includes(type)) return;
  inWindow(ownerOf(e), () => runCommand(e, kind, type, p));
});

function runCommand(e, kind, type, p) {
  p = p || {};
  switch (type) {
    // tabs
    case 'tab:new':
      if (p.private && !W.private) openPrivateWindow(p.url ? data.toUrl(p.url) : undefined);
      else W.tabs.create(p.url ? { url: data.toUrl(p.url) } : {});
      break;
    case 'tab:close': W.tabs.close(p.id); break;
    case 'tab:activate': W.tabs.activate(p.id); break;
    case 'tab:move': W.tabs.move(p.id, p.index); break;
    case 'tab:drag': dragTab(W, p.id, String(p.phase || ''), { strip: p.strip, kind }); break;
    case 'tab:split': W.tabs.split(p.id); break;
    case 'split:unsplit': W.tabs.unsplit(); break;
    case 'split:swap': W.tabs.swapPanes(); break;
    case 'split:drag': {
      // Dragging the divider: a transparent overlay covers both tabs so the
      // pointer keeps reporting to us while it's over either page.
      if (!W.tabs.pane) break;
      const { bounds } = pageBounds();
      W.overlay.open('splitdrag', bounds, { width: bounds.width, gap: SPLIT_GAP });
      break;
    }
    case 'split:resize':
      W.tabs.setSplitRatio(Number(p.ratio));
      if (p.done && W.overlay.isOpen('splitdrag')) W.overlay.close();
      break;
    case 'pip:toggle': toggleVideoPopout(W.tabs.active); break;
    case 'tab:menu': tabMenu(p.id, p.x, p.y); break;
    case 'sidebar:menu': sidebarMenu(p.x, p.y); break;
    case 'nav:history-menu': historyMenu(p.dir < 0 ? -1 : 1, Number(p.x) || 0, Number(p.y) || 0); break;
    case 'tab:drop-index': if (tabDrag && tabDrag.target === W) tabDrag.targetIndex = Number.isFinite(p.index) ? p.index : null; break;
    case 'update:install':
      // Installing quits the app: keep every window in the saved session.
      if (updater.status.state !== 'ready') break;
      saveAllSessions();
      quitting = true;
      // The installer closes Coffee and forces it after about a second, so
      // get sign-ins onto disk before it starts.
      prepareToQuit().finally(() => { preparedToQuit = true; updater.install(); });
      break;
    case 'update:check': updater.check(); break;
    case 'tab:mute': {
      const t = W.tabs.get(p.id);
      if (t) toggleMute(t);
      break;
    }
    case 'float:size': W.float.sized(p.seq, Number(p.width) || 0, Number(p.height) || 0); break;
    case 'tabcard:show': showTabCard(p, kind); break;
    case 'tabcard:hide': W.float.hide('tabcard'); break;
    case 'glance:close': if (!glanceClickJustClosedMenu()) closeGlance(); break;
    case 'glance:back': glanceHistory(-1); break;
    case 'glance:forward': glanceHistory(1); break;
    case 'glance:reload': if (W.glance) W.glance.view.webContents.reload(); break;
    case 'glance:stop': if (W.glance) W.glance.view.webContents.stop(); break;
    case 'glance:expand': if (!glanceClickJustClosedMenu()) expandGlance(); break;
    case 'glance:split': if (!glanceClickJustClosedMenu()) expandGlance({ split: true }); break;
    case 'glance:copy': if (W.glance) { clipboard.writeText(W.glance.view.webContents.getURL() || W.glance.url); toast('Link copied'); } break;

    // navigation
    case 'nav:go': {
      const url = data.toUrl(p.url);
      if (url) navigate(url, { newTab: !!p.newTab, background: !!p.background });
      break;
    }
    case 'nav:back': if (p.newTab) duplicateActive(-1); else goBack(); break;
    case 'nav:forward': if (p.newTab) duplicateActive(1); else goForward(); break;
    case 'nav:reload': if (p.newTab) duplicateActive(0); else reload(!!p.hard); break;
    case 'tab:switch': switchToTab(Number(p.id)); break;
    case 'tabsearch:open': showTabSearch(); break;
    case 'whatsnew:open': openWhatsNew(); break;
    // Settings' color copy & paste (short text only).
    case 'clipboard:write-text': if (typeof p.text === 'string') clipboard.writeText(p.text.slice(0, 64)); break;
    case 'nav:stop': { const wc = activeWc(); if (wc) wc.stop(); break; }
    case 'nav:home': navigate(homeUrl(), { newTab: !!p.newTab }); break;
    case 'page:focus': { const t = W.tabs.active; if (t) t.urlbarUntil = 0; const wc = activeWc(); if (wc) wc.focus(); break; }
    case 'urlbar:typing': if (W.tabs.active) W.tabs.active.urlbarUntil = 0; break;

    // window
    case 'win:minimize': W.win.minimize(); break;
    case 'win:maximize':
      if (W.win.isFullScreen()) W.win.setFullScreen(false);
      else if (W.win.isMaximized()) W.win.unmaximize();
      else W.win.maximize();
      break;
    case 'win:close': W.win.close(); break;

    // overlay
    case 'suggest:show': W.omniRect = p.rect; showSuggest(p); break;
    case 'omni:rect': W.omniRect = p.rect; break;
    case 'overlay:close': if (!p.type || W.overlay.isOpen(p.type)) W.overlay.close(); break;
    case 'overlay:pick': if (kind === 'overlay') W.overlay.pick(p); break;

    // features
    case 'downloads:toggle': toggleDownloads(p.rect); break;
    case 'downloads:folder':
      shell.openPath(data.settings.data.downloadDir).then((err) => { if (err) console.error('Open downloads folder failed:', err); });
      break;
    case 'downloads:action':
      downloads.action(p.id, p.what);
      if (p.what === 'open' || p.what === 'show') W.overlay.close();
      break;
    case 'bookmark:star': starBookmark(p.rect); break;
    case 'bookmark:open': {
      const bm = data.itemById(p.id);
      if (bm && bm.type === 'bookmark') navigate(bm.url, { newTab: !!p.newTab, background: !!p.background });
      if (kind === 'overlay' && !p.keepOpen) W.overlay.close();
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
    case 'bookmark:remove': data.removeBookmark(p.id); bookmarksChanged(); W.overlay.close(); break;
    case 'bookmark:move':
      data.moveBookmark(p.id, { parent: p.parent || null, index: Number.isFinite(p.index) ? p.index : Infinity });
      bookmarksChanged();
      break;
    case 'bmbar:menu': bookmarksBarMenu(p.x, p.y); break;
    case 'welcome:done': {
      // Finished or skipped the welcome setup: never show it automatically again.
      data.settings.data.onboarded = true;
      data.settings.save();
      const t = W.tabs.byWebContents(e.sender);
      if (t && t.wc) t.wc.loadURL(NEWTAB).catch(() => {});
      break;
    }
    case 'newtab:hide': data.hideShortcut(String(p.url || '')); broadcastSettings(); break;
    case 'shortcuts:restore':
      data.settings.data.hiddenShortcuts = [];
      data.settings.save();
      broadcastSettings();
      break;
    case 'bmfolder:open': openFolder(p.id, p.rect, false); break;
    case 'bmbutton:open': openFolder(BM_ROOT, p.rect, true); break;
    case 'bmfolder:nav': openFolder(p.id); break;
    case 'bmfolder:openall': openAll(data.children(p.id === BM_ROOT ? null : p.id).filter((b) => b.type === 'bookmark')); W.overlay.close(); break;
    case 'shield:menu': shieldMenu(p.rect); break;
    case 'app:menu': appMenu(p.x, p.y); break;
    case 'find': {
      const wc = activeWc();
      const tab = W.tabs.active;
      if (!wc || !p.text) {
        if (wc) wc.stopFindInPage('clearSelection');
        if (tab) tab.find = null;
        emit('find:result', { active: 0, matches: 0 });
        if (W.overlay.isOpen('findlist')) W.overlay.close();
        break;
      }
      const fresh = tab.find !== p.text || !p.next;
      tab.find = p.text;
      if (fresh) { W.findActive = 0; W.findMatches = undefined; }
      wc.findInPage(p.text, { forward: p.forward !== false, findNext: !!p.next });
      if (p.rect) W.findRect = p.rect;
      if (fresh) {
        // Wait for a pause in typing: one scan for the word, not one per letter.
        const state = W; const text = p.text;
        clearTimeout(W.findTimer);
        W.findTimer = setTimeout(() => inWindow(state, () => showFindList(text)), 150);
      }
      break;
    }
    case 'find:list':
      if (p.rect) W.findRect = p.rect;
      if (W.tabs.active && W.tabs.active.find) showFindList(W.tabs.active.find);
      break;
    case 'find:stop': {
      const wc = activeWc();
      if (wc) wc.stopFindInPage('keepSelection');
      if (W.tabs.active) W.tabs.active.find = null;
      if (W.overlay.isOpen('findlist')) W.overlay.close();
      break;
    }
    case 'zoom:reset': zoom(0); break;
    case 'settings:open': openSettings(p.section); break;
    case 'app:relaunch':
      // Applies settings that need a restart (e.g. extensions).
      saveAllSessions();
      quitting = true;
      data.Store.flushAll();
      app.relaunch();
      app.quit();
      break;
    case 'ext:panel': showExtensionsPanel(p.rect); break;
    case 'ext:remove':
      if (ext) ext.remove(String(p.id || '')).then(() => { emit('ext:changed'); if (W.overlay.isOpen('extensions')) showExtensionsPanel(); });
      break;
    case 'ext:options': {
      const e = ext && ext.list().find((x) => x.id === p.id);
      if (e && e.options) W.tabs.create({ url: `chrome-extension://${e.id}/${e.options.replace(/^\//, '')}` });
      W.overlay.close();
      break;
    }
    case 'ext:store': navigate('https://chromewebstore.google.com/category/extensions', { newTab: true }); W.overlay.close(); break;
    case 'settings:set': setSetting(p.key, p.value); break;
    case 'history:clear': data.clearHistory(); break;
    case 'history:delete': data.deleteHistory(Array.isArray(p.urls) ? p.urls.slice(0, 1000) : []); break;
    case 'history:clear-range': data.clearHistoryRange(String(p.range || '')); break;
    case 'history:clear-site': data.clearHistorySite(p.site); break;
    case 'cookies:clear-site': clearSiteData(p.site).catch(() => {}).then(saveSessionCookies); break;
    case 'adblock:allow': setAdblockException(p.site, !!p.allow); break;
    case 'browser:set-default': openDefaultBrowserSettings(); break;
    case 'data:clear':
      fs.rmSync(sessionCookiesFile(), { force: true }); // saved sign-ins go too
      webSession.clearStorageData().catch(() => {});
      webSession.clearCache().catch(() => {});
      break;
    default:
  }
}

ipcMain.handle('invoke', async (e, type, p = {}) => {
  const kind = senderKind(e);
  if (!kind || (kind === 'internal' && !INTERNAL_INVOKE.has(type))) return null;
  return inWindow(ownerOf(e), () => runInvoke(e, type, p));
});

async function runInvoke(e, type, p) {
  p = p || {};
  switch (type) {
    case 'init':
      return {
        snapshot: W.tabs.snapshot(),
        settings: publicSettings(),
        bookmarks: data.bookmarks.data,
        downloads: { ...downloads.summary(), items: undefined },
        window: windowState(),
        popout: pipKept.size > 0,
      };
    case 'suggest': return suggestWithTabs(p.q, p.inline !== false);
    case 'whatsnew:data': return { version: app.getVersion(), notes: notesForThisVersion() };
    case 'clipboard:read-text': return String((await clipboard.readText()) || '').trim().slice(0, 64);
    case 'newtab:data':
      return { show: data.settings.data.newtabShortcuts !== false, shortcuts: data.shortcuts(8) };
    case 'settings:get': return settingsPayload();
    case 'history:list': return data.historyList({ q: p.q, offset: p.offset });
    case 'history:sites': return data.historySites();
    case 'cookies:sites': return cookieSites();
    case 'browser:default': return defaultBrowserStatus();
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
      const r = await dialog.showOpenDialog(W.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: data.settings.data.downloadDir });
      if (!r.canceled && r.filePaths[0]) {
        data.settings.data.downloadDir = r.filePaths[0];
        data.settings.save();
      }
      return data.settings.data.downloadDir;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Internal pages: coffee://newtab, coffee://settings, coffee://error
// ---------------------------------------------------------------------------

function registerInternalProtocol(ses) {
  const hosts = new Set(['newtab', 'settings', 'error', 'welcome', 'history', 'whats-new']);
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

/**
 * Save every open window. The first window keeps the `tabs` key that older
 * builds read; any other windows go under `windows`, with their position.
 */
function saveAllSessions() {
  const [first, ...rest] = winStates.filter((s) => s.tabs && s.win && !s.win.isDestroyed() && !s.private);
  if (!first) return;
  const main = first.tabs.sessionData();
  const others = rest.map((s) => ({
    ...s.tabs.sessionData(),
    bounds: s.win.getNormalBounds(),
    maximized: s.win.isMaximized(),
  })).filter((d) => d.tabs.length);
  data.session.data = { ...data.session.data, tabs: main.tabs, active: main.active, windows: others };
  data.session.save();
}

/** Leave HTML fullscreen (a fullscreen video) before a tab changes windows. */
function dropFullscreen(state, tab) {
  if (state.fullscreenTab !== tab) return;
  state.fullscreenTab = null;
  tab.htmlFullscreen = false;
  if (tab.wc) tab.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
  if (state.win && !state.win.isDestroyed()) {
    state.win.setFullScreen(false);
    inWindow(state, () => { updatePeekWatch(); emit('window', windowState()); });
  }
}

/**
 * Move a tab to another open window, keeping its page (video, form input, login)
 * running. Returns true if it moved.
 */
function moveTabToWindow(fromState, tabId, toState, index) {
  if (!fromState || !toState || fromState === toState || !fromState.tabs || !toState.tabs) return false;
  if (fromState.private !== toState.private) return false; // private and normal tabs never share a window
  if (!toState.win || toState.win.isDestroyed()) return false;
  const tab = fromState.tabs.get(tabId);
  if (!tab) return false;
  dropFullscreen(fromState, tab);
  const moved = inWindow(fromState, () => fromState.tabs.release(tabId));
  if (!moved) return false;
  inWindow(toState, () => {
    toState.tabs.adopt(moved, index);
    if (toState.win.isMinimized()) toState.win.restore();
    toState.win.focus();
  });
  // A window with no tabs left closes itself; the last one stays open.
  if (!fromState.tabs.tabs.length && winStates.length > 1) fromState.win.close();
  return true;
}

/** Move a tab into a window of its own, placed at `bounds` (or cascaded from its window). */
function moveTabToNewWindow(fromState, tabId, bounds) {
  if (!fromState || !fromState.tabs) return false;
  const tab = fromState.tabs.get(tabId);
  // The only tab in a window is already in a window of its own.
  if (!tab || fromState.tabs.tabs.length < 2) return false;
  dropFullscreen(fromState, tab);
  const placed = bounds || cascadeFrom(fromState);
  const moved = inWindow(fromState, () => fromState.tabs.release(tabId));
  if (!moved) return false;
  const state = createWindow({ bounds: placed, maximized: bounds ? false : fromState.win.isMaximized(), private: fromState.private });
  inWindow(state, () => state.tabs.adopt(moved, 0));
  return true;
}

/**
 * The window under a screen point. Overlapping windows: the one focused most
 * recently wins, which is the one on top in nearly every case.
 */
function windowAtPoint(point) {
  const hits = winStates.filter((s) => {
    if (!s.win || s.win.isDestroyed() || !s.win.isVisible() || s.win.isMinimized()) return false;
    const b = s.win.getBounds();
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  });
  hits.sort((a, b) => (b.lastFocus || 0) - (a.lastFocus || 0));
  return hits[0] || null;
}

// ---------------------------------------------------------------------------
/// Dragging a tab out of the tab strip (split view / multiple windows). Once
// it leaves the strip, a card of the tab follows the pointer everywhere (over
// the page, other windows, the desktop), and what would happen on release is
// shown:
//   - a half of its own page lights up: split view, with the tab on that side
//   - another Coffee window lights up, its frame outlined, and a placeholder
//     tab slides into its tab strip where the tab will land
//   - outside every window, an outline of the new window appears where it
//     will open (the only tab in a window shows where its window will go)
// Everything is driven from here, by reading the pointer from the screen and
// the mouse button from the window, so it doesn't depend on the page under
// the pointer passing events along. The card asks for a step on every frame
// it draws (drag:frame), so it moves at the screen's refresh rate; a timer
// covers the time it's hidden.
// ---------------------------------------------------------------------------

const GHOST = { width: 292, height: 252, grabX: 30, grabY: 34 }; // where the pointer holds the card
const STRIP_SLACK = 24; // px around the tab strip that still count as "in the strip"
const WM_LBUTTONUP = 0x0202;
let tabDrag = null; // { from, tabId, tab, ghost, hint, strip, out, zoneKey, target, targetIndex, timer }

/** A floating, click-through window for the drag card or the drop highlight. */
function dragWindow(mode) {
  const w = new BrowserWindow({
    width: mode === 'ghost' ? GHOST.width : 100,
    height: mode === 'ghost' ? GHOST.height : 100,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { preload: UI_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, mode === 'ghost' ? 'pop-up-menu' : 'floating');
  lockDown(w.webContents);
  // Messages sent before the page has loaded would be lost: keep the latest
  // of each and replay them once it's ready.
  w.pending = new Map([['theme', theme]]);
  w.ready = false;
  w.webContents.once('did-finish-load', () => {
    w.ready = true;
    for (const [ev, payload] of w.pending) w.webContents.send(`ev:${ev}`, payload);
  });
  w.webContents.loadFile(path.join(ROOT, 'ui', 'drag.html'), { query: { mode } });
  return w;
}

function post(w, ev, payload) {
  if (!w || w.isDestroyed()) return;
  w.pending.set(ev, payload);
  if (w.ready) w.webContents.send(`ev:${ev}`, payload);
}

/** The page area of a window, in screen coordinates. */
function pageRectOnScreen(state) {
  return inWindow(state, () => {
    const c = state.win.getContentBounds();
    const { bounds } = pageBounds();
    return { x: c.x + bounds.x, y: c.y + bounds.y, width: bounds.width, height: bounds.height };
  });
}

const inRect = (p, r, slack = 0) => !!r && p.x >= r.x - slack && p.x < r.x + r.width + slack && p.y >= r.y - slack && p.y < r.y + r.height + slack;

/** Where a window opened (or moved) by dropping at `p` goes: its first tab under the pointer. */
function windowRectAt(d, p) {
  const b = d.from.win.getNormalBounds();
  return { x: Math.round(p.x - 70), y: Math.round(p.y - 64), width: b.width, height: b.height };
}

const NOTHING = { kind: 'none', label: 'Drop here to cancel' };

/** What dropping the dragged tab at screen point `p` would do. */
function dragZone(d, p) {
  // A window of the other kind (private / normal) can't take the tab: over it, the tab gets a new window.
  const under = windowAtPoint(p);
  const target = under && under.private === d.from.private ? under : null;
  const alone = d.from.tabs.tabs.length < 2;
  // A window's only tab can't leave it: anywhere but another window, the window goes along.
  if (alone && (!target || target === d.from)) return { kind: 'place', label: 'Move this window here', rect: windowRectAt(d, p) };
  if (!target) return { kind: 'new', label: 'New window', rect: windowRectAt(d, p) };
  if (target !== d.from) return { kind: 'move', state: target, label: 'Move to this window', rect: pageRectOnScreen(target) };
  const r = pageRectOnScreen(d.from);
  if (!inRect(p, r)) return NOTHING; // back over its own window's frame
  const side = p.x < r.x + r.width / 2 ? 'left' : 'right';
  const partner = d.from.tabs.splitPartner(d.tabId, side);
  if (!partner) return NOTHING;
  // The preview covers the whole page: where the tab lands, and what stays beside it.
  const p2 = d.from.tabs.get(partner);
  const ps = p2 ? p2.serialize() : {};
  return {
    kind: 'split', side, partner,
    label: side === 'left' ? 'Open on the left' : 'Open on the right',
    rect: r,
    preview: {
      side,
      tab: { title: d.card.title, favicon: d.card.favicon, letter: d.card.letter },
      partner: { title: ps.title || 'New Tab', favicon: ps.favicon || '', newtab: !!ps.newtab },
    },
  };
}

// The new-window and move-window outlines follow the pointer, so they're keyed
// by kind only; the rest by the place they light up.
const zoneKey = (z) => `${z.kind}:${z.side || ''}:${z.state ? winStates.indexOf(z.state) : ''}`;

/** Send to a window's frame and overlay (the compact peek panel's strip lives there). */
function tellWindow(state, ev, payload) {
  if (!state || !state.win || state.win.isDestroyed()) return;
  inWindow(state, () => {
    emit(ev, payload);
    if (state.overlay && !state.overlay.wc.isDestroyed()) state.overlay.wc.send(`ev:${ev}`, payload);
  });
}

/** The window the tab would move into: it lights up and makes room for the tab. */
function setDragTarget(d, state) {
  if (d.target === state) return;
  if (d.target) tellWindow(d.target, 'drag:incoming', null);
  d.target = state;
  d.targetIndex = null;
  if (state) tellWindow(state, 'drag:incoming', { id: d.tabId, title: d.card.title, favicon: d.card.favicon, private: d.card.private });
}

/** Follow the pointer: move the card, and show where the tab would land. */
function dragTick() {
  const d = tabDrag;
  if (!d) return;
  if (!d.from.win || d.from.win.isDestroyed()) { finishTabDrag(false); return; }
  const p = screen.getCursorScreenPoint();
  if (p.x === d.lx && p.y === d.ly) return; // nothing moved since the last step
  d.lx = p.x;
  d.ly = p.y;
  const out = !inRect(p, d.strip, STRIP_SLACK);
  if (out !== d.out) {
    d.out = out;
    tellWindow(d.from, 'drag:tear', { id: d.tabId, out });
    if (!out) {
      d.zoneKey = '';
      setDragTarget(d, null);
      d.ghost.hide();
      d.hint.hide();
      return;
    }
  }
  if (!out) return;
  d.ghost.setPosition(Math.round(p.x - GHOST.grabX), Math.round(p.y - GHOST.grabY));
  if (!d.ghost.isVisible()) d.ghost.showInactive();
  const zone = dragZone(d, p);
  const key = zoneKey(zone);
  const changed = key !== d.zoneKey;
  d.zoneKey = key;
  if (changed) {
    post(d.ghost, 'drag:zone', { kind: zone.kind, label: zone.label });
    setDragTarget(d, zone.kind === 'move' ? zone.state : null);
  }
  // The target window's tab strip follows the pointer to make room for the tab.
  if (d.target) {
    const c = d.target.win.getContentBounds();
    inWindow(d.target, () => emit('drag:over', { x: p.x - c.x, y: p.y - c.y }));
  }
  if (!zone.rect) {
    if (d.hint.isVisible()) d.hint.hide();
    return;
  }
  if (changed) {
    d.hint.setBounds(zone.rect);
    post(d.hint, 'drag:hint', { label: zone.label, kind: zone.kind, preview: zone.preview || null });
    if (!d.hint.isVisible()) d.hint.showInactive();
    d.ghost.moveTop(); // the card stays above the highlight
  } else if (zone.kind === 'new' || zone.kind === 'place') {
    d.hint.setPosition(zone.rect.x, zone.rect.y); // the window outline follows the pointer
  }
}

/** The tab strip reports a drag: begin (with its own rect), end (released), cancel. */
function dragTab(from, tabId, phase, info = {}) {
  if (!from || !from.tabs) return;
  if (phase === 'begin') return startTabDrag(from, tabId, info);
  const d = tabDrag;
  if (!d || d.from !== from || d.tabId !== tabId) return;
  if (phase === 'end' || phase === 'cancel') finishTabDrag(phase === 'end');
}

function startTabDrag(from, tabId, info) {
  finishTabDrag(false);
  const tab = from.tabs.get(tabId);
  if (!tab || !from.win || from.win.isDestroyed()) return;
  // The strip's rect, on screen. The compact peek panel lives in the overlay.
  const c = from.win.getContentBounds();
  const r = info.strip || {};
  const off = info.kind === 'overlay' ? from.overlay.view.getBounds() : { x: 0, y: 0 };
  const strip = { x: c.x + off.x + (Number(r.x) || 0), y: c.y + off.y + (Number(r.y) || 0), width: Number(r.width) || 0, height: Number(r.height) || 0 };
  const shown = tab.serialize();
  const card = { title: shown.title, favicon: shown.favicon, private: tab.private, letter: (shown.url.replace(/^https?:\/\/(www\.)?/, '')[0] || '').toUpperCase() };
  // Both windows are made now, hidden, so they're ready the moment the tab leaves the strip.
  const d = { from, tabId, tab, card, strip, ghost: dragWindow('ghost'), hint: dragWindow('hint'), out: false, zoneKey: '', target: null, targetIndex: null, timer: null };
  tabDrag = d;
  post(d.ghost, 'drag:tab', card);
  if (tab.wc && from.tabs.shown.has(tab.id)) {
    tab.wc.capturePage().then((img) => {
      if (tabDrag !== d || img.isEmpty()) return;
      post(d.ghost, 'drag:thumb', img.resize({ width: 520, quality: 'good' }).toDataURL());
    }).catch(() => {});
  }
  // The release, straight from the window: the page under the pointer may
  // not pass it on to the tab strip.
  if (process.platform === 'win32') {
    from.win.hookWindowMessage(WM_LBUTTONUP, () => setImmediate(() => { if (tabDrag === d) finishTabDrag(true); }));
  }
  d.timer = setInterval(dragTick, 8);
}

/** End the drag; with `drop`, do what was shown for the place under the pointer. */
function finishTabDrag(drop) {
  const d = tabDrag;
  if (!d) return;
  tabDrag = null;
  clearInterval(d.timer);
  if (process.platform === 'win32' && d.from.win && !d.from.win.isDestroyed()) {
    try { d.from.win.unhookWindowMessage(WM_LBUTTONUP); } catch { /* not hooked */ }
  }
  const p = screen.getCursorScreenPoint();
  const zone = drop && d.out && d.from.win && !d.from.win.isDestroyed() ? dragZone(d, p) : null;
  const act = !!zone && zone.kind !== 'none';
  const index = d.targetIndex;
  setDragTarget(d, null);
  // The card and highlight settle into the drop (or fade on cancel), then go.
  post(d.ghost, 'drag:end', { dropped: act });
  post(d.hint, 'drag:end', { dropped: act });
  setTimeout(() => { for (const w of [d.ghost, d.hint]) if (!w.isDestroyed()) w.destroy(); }, act ? 260 : 140);
  if (d.out) tellWindow(d.from, 'drag:done', { id: d.tabId });
  if (!act) return;
  switch (zone.kind) {
    case 'split': d.from.tabs.splitAt(d.tabId, zone.side, zone.partner); break;
    case 'move': moveTabToWindow(d.from, d.tabId, zone.state, index ?? Infinity); break;
    case 'new': moveTabToNewWindow(d.from, d.tabId, zone.rect); break;
    case 'place': {
      const w = d.from.win;
      if (w.isFullScreen()) break;
      if (w.isMaximized()) w.unmaximize();
      w.setBounds(zone.rect);
      w.focus();
      break;
    }
    default:
  }
}

/** Esc while dragging: put the tab back where it was. */
function cancelTabDrag() {
  const d = tabDrag;
  if (!d) return false;
  finishTabDrag(false);
  tellWindow(d.from, 'drag:abort', { id: d.tabId });
  return true;
}


/** Bounds for a new window: offset from `state`'s window, kept on the same screen. */
function cascadeFrom(state) {
  if (!state || !state.win || state.win.isDestroyed()) return undefined;
  const b = state.win.getNormalBounds();
  const area = screen.getDisplayMatching(b).workArea;
  let x = b.x + 32;
  let y = b.y + 32;
  if (x + Math.min(b.width, area.width) > area.x + area.width) x = area.x;
  if (y + Math.min(b.height, area.height) > area.y + area.height) y = area.y;
  return { x, y, width: Math.min(b.width, area.width), height: Math.min(b.height, area.height) };
}

/** Open another Coffee window with its own tabs (when multiple windows are on). Returns its state. */
function openNewWindow(url) {
  const state = openEmptyWindow();
  if (!state) return null;
  inWindow(state, () => state.tabs.create({ url: url || NEWTAB }));
  return state;
}

/**
 * A private window (Ctrl+Shift+N): every tab in it is private, so a link
 * clicked there can never open outside private browsing.
 */
function openPrivateWindow(url) {
  const state = openEmptyWindow({ private: true });
  inWindow(state, () => state.tabs.create(url ? { url } : {}));
  return state;
}

/** "Open link in private window": a new tab in the private window used last, or a new private window. */
function openInPrivateWindow(url) {
  const state = winStates
    .filter((s) => s.private && s.win && !s.win.isDestroyed() && s.tabs)
    .sort((a, b) => (b.lastFocus || 0) - (a.lastFocus || 0))[0];
  if (!state) return openPrivateWindow(url);
  inWindow(state, () => state.tabs.create({ url }));
  bringForward(state);
  return state;
}

/**
 * Run `fn` in a normal window: the current one, the normal window used last,
 * or a new one. Settings, History and links from other apps never open in a
 * private window.
 */
function inNormalWindow(fn) {
  let state = !W.private && W.win && !W.win.isDestroyed() ? W : winStates
    .filter((s) => !s.private && s.win && !s.win.isDestroyed() && s.tabs)
    .sort((a, b) => (b.lastFocus || 0) - (a.lastFocus || 0))[0];
  if (!state) state = openEmptyWindow({ private: false });
  const r = inWindow(state, fn);
  if (state.win.isMinimized()) state.win.restore();
  state.win.focus();
  return r;
}

/** A window with no tabs yet, cascaded from the current one. Returns its state. */
function openEmptyWindow(opts) {
  const from = W;
  const placed = { bounds: cascadeFrom(from), maximized: from.win && !from.win.isDestroyed() ? from.win.isMaximized() : undefined };
  // Only `private` given: place it like any new window.
  if (opts && Object.keys(opts).length === 1 && 'private' in opts) return createWindow({ ...placed, private: opts.private });
  return createWindow(opts || placed);
}

app.on('second-instance', (_e, argv) => {
  const urls = urlsFromArgv(argv);
  // Like Chrome: launching Coffee again opens a new window; opening a link
  // from another app adds a tab to the window you used last.
  if (winStates.length && !urls.length) {
    openNewWindow();
    return;
  }
  // No window left (a popped-out video kept the app running): open one.
  if (!winStates.length) { inWindow(createWindow(), () => { if (urls.length) for (const u of urls) W.tabs.create({ url: u }); else W.tabs.create(); }); return; }
  if (!W.win || W.win.isDestroyed()) return;
  inNormalWindow(() => { for (const u of urls) W.tabs.create({ url: u }); });
});

app.setAppUserModelId('app.coffee.browser');

// ---------------------------------------------------------------------------
// Staying signed in across restarts and updates
// ---------------------------------------------------------------------------
// Sites often sign you in only "until the browser closes" (a session cookie:
// what you get when you don't tick "Remember me"). Electron drops those on
// every restart; Chrome keeps them while it brings your tabs back. Coffee does
// the same: with "Restore tabs" on, they're saved when Coffee quits (and every
// couple of minutes, in case it doesn't get to), encrypted with the same key
// as the cookie store, and put back on the next start.
//
// Separately, the cookie store writes changes to disk only every 30 seconds or
// so; Coffee writes them out before it quits, so a quick restart (an update
// closes Coffee and may force it after a second) loses nothing.

const sessionCookiesFile = () => path.join(app.getPath('userData'), 'session-cookies.bin');

async function saveSessionCookies() {
  const file = sessionCookiesFile();
  try {
    if (!webSession || !data.settings.data.restoreSession || !(await safeStorage.isAsyncEncryptionAvailable())) {
      fs.rmSync(file, { force: true });
      return;
    }
    const list = (await webSession.cookies.get({ session: true })).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    }));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, await safeStorage.encryptStringAsync(JSON.stringify(list)));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('Could not save sign-ins:', err.message);
  }
}

/** Put back the sign-ins saved last time (they stay session cookies). */
async function restoreSessionCookies() {
  const file = sessionCookiesFile();
  let list = [];
  let reEncrypt = false;
  try {
    if (!data.settings.data.restoreSession || !fs.existsSync(file) || !(await safeStorage.isAsyncEncryptionAvailable())) return;
    // Also reads files written by the older synchronous API (same format).
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
    list = JSON.parse(result);
    reEncrypt = shouldReEncrypt;
  } catch { return; } // unreadable (e.g. a different Windows user): start fresh
  if (!Array.isArray(list)) return;
  await Promise.all(list.map((c) => webSession.cookies.set({
    url: `${c.secure ? 'https' : 'http'}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`,
    name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    ...(c.hostOnly ? {} : { domain: c.domain }),
  }).catch(() => { /* a cookie the site has since replaced or that's no longer valid */ })));
  // The encryption key was rotated: save them again under the current one.
  if (reEncrypt) saveSessionCookies();
}

/** Everything that must reach the disk before Coffee closes (bounded, so quitting never hangs). */
function prepareToQuit() {
  const work = Promise.all([
    saveSessionCookies(),
    webSession ? webSession.cookies.flushStore().catch(() => {}) : null,
  ]);
  return Promise.race([work, new Promise((r) => setTimeout(r, 1500))]);
}
let preparedToQuit = false;

app.whenReady().then(async () => {
  nativeTheme.themeSource = theme.mode;
  webSession = session.fromPartition('persist:web');
  compat.setup(webSession, ELECTRON_UA);
  prepareSession(webSession);
  adblock.setExceptions(data.settings.data.adblockExceptions);

  const blockerReady = data.settings.data.adblock
    ? adblock.setEnabled(webSession, true, onBlocked)
    : Promise.resolve();

  const first = createWindow();
  updater.init(() => { eachWindow(() => emit('settings', publicSettings())); broadcastSettings(); });

  attachDownloads(webSession);

  if (data.settings.data.extensions) {
    startExtensions().catch((err) => console.error('Extensions failed to start:', err));
  }

  // Sign-ins from last time are back before any tab loads.
  const signedIn = restoreSessionCookies();
  setInterval(saveSessionCookies, 2 * 60 * 1000);

  // Give the blocker a moment so the first page loads with blocking on.
  await Promise.race([blockerReady, new Promise((r) => setTimeout(r, 1200))]);
  await signedIn;

  const saved = data.session.data;
  const argvUrls = urlsFromArgv(process.argv);
  const restoreInit = (t) => ({ url: t.url || NEWTAB, title: t.title, favicon: t.favicon, entries: t.entries, entryIndex: t.entryIndex });
  // The first window is filled by name: another window may have opened (and
  // become current) during the wait above.
  inWindow(first, () => {
    if (data.settings.data.restoreSession && saved.tabs && saved.tabs.length) {
      for (const t of saved.tabs) {
        // The setup page is never restored; it opens fresh if setup isn't done.
        if (String(t.url || '').startsWith('coffee://welcome')) continue;
        W.tabs.create({ background: true, init: restoreInit(t) });
      }
      const target = W.tabs.tabs[Math.min(saved.active || 0, W.tabs.tabs.length - 1)];
      if (target && !argvUrls.length) W.tabs.activate(target.id);
    }
    for (const u of argvUrls) W.tabs.create({ url: u });
    if (!W.tabs.tabs.length && data.settings.data.onboarded) W.tabs.create();
    // First run: open the welcome setup (theme, tabs, search engine...).
    if (!data.settings.data.onboarded) W.tabs.create({ url: 'coffee://welcome/' });
    else if (!W.tabs.active) W.tabs.activate(W.tabs.tabs[0].id);
  });

  // The other windows from the last session come back too.
  if (data.settings.data.restoreSession && Array.isArray(saved.windows)) {
    for (const w of saved.windows) {
      const tabs = (w.tabs || []).filter((t) => !String(t.url || '').startsWith('coffee://welcome'));
      if (!tabs.length) continue;
      // Opened behind the main window, which keeps the focus.
      const state = openEmptyWindow({ ...(w.bounds ? { bounds: w.bounds, maximized: !!w.maximized } : { bounds: cascadeFrom(first) }), inactive: true });
      if (!state) break;
      inWindow(state, () => {
        for (const t of tabs) W.tabs.create({ background: true, init: restoreInit(t) });
        const target = W.tabs.tabs[Math.min(w.active || 0, W.tabs.tabs.length - 1)];
        if (target) W.tabs.activate(target.id);
      });
    }
    W = first;
  }
});

// A popped-out video keeps the app running after its last window closes, until the video is closed.
app.on('window-all-closed', () => { if (!winStates.length && !pipKept.size) app.quit(); });
app.on('before-quit', (e) => {
  // Save every window now: they close one at a time while quitting, and each
  // close would otherwise save a session missing the windows closed before it.
  if (!quitting) saveAllSessions();
  quitting = true;
  data.Store.flushAll();
  // Keep sign-ins: hold the quit until cookies are on disk (at most 1.5 s).
  if (!preparedToQuit && webSession) {
    e.preventDefault();
    preparedToQuit = true;
    prepareToQuit().finally(() => app.quit());
  }
});
app.on('will-quit', () => data.Store.flushAll());

// Links in internal pages that point outside the browser (mailto:, etc.).
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => {
    if (/^(mailto|tel):/i.test(url)) { ev.preventDefault(); shell.openExternal(url); }
  });
});
