'use strict';
// Tab lifecycle. A tab's WebContentsView is created lazily (restored and
// background tabs cost nothing until opened) and destroyed again when the tab
// sleeps, while its URL, title, icon and back/forward history are kept.
const path = require('path');
const { WebContentsView } = require('electron');
const data = require('./data');

const INTERNAL_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const NEWTAB = 'coffee://newtab/';
let nextId = 1;

function isInternal(url) {
  return typeof url === 'string' && url.startsWith('coffee://');
}

/** URL shown to the user (error pages show the URL that failed). */
function displayUrl(url) {
  if (!url || url.startsWith(NEWTAB)) return '';
  if (url.startsWith('coffee://error/')) {
    try { return new URL(url).searchParams.get('url') || ''; } catch { return ''; }
  }
  return url;
}

class Tab {
  constructor(mgr, init = {}) {
    this.mgr = mgr;
    this.id = nextId++;
    this.url = init.url || NEWTAB;
    this.title = init.title || '';
    this.favicon = init.favicon || '';
    this.entries = init.entries || null; // navigation history to restore
    this.entryIndex = init.entryIndex;
    this.view = null;
    this.loading = false;
    this.audible = false;
    this.muted = false;
    this.blocked = 0;
    this.lastActive = Date.now();
    this.htmlFullscreen = false;
    this.zoom = 0;
    this.find = null;
  }

  get wc() {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  serialize() {
    const wc = this.wc;
    const shown = displayUrl(this.url);
    return {
      id: this.id,
      url: shown,
      title: this.title || (shown ? shown.replace(/^https?:\/\//, '') : 'New Tab'),
      favicon: this.favicon,
      loading: this.loading,
      audible: this.audible,
      muted: this.muted,
      blocked: this.blocked,
      sleeping: !wc,
      internal: isInternal(this.url) && !this.url.startsWith('coffee://error/'),
      newtab: this.url.startsWith(NEWTAB),
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      zoom: this.zoom,
    };
  }

  ensureView() {
    if (this.wc) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.mgr.session,
        preload: INTERNAL_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Lets the (sandboxed) ad-block preload run in iframes too, e.g. embedded videos.
        nodeIntegrationInSubFrames: true,
        webSecurity: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    this.view = view;
    view.setBorderRadius(this.mgr.radius());
    this.applyBackground();
    this.bind(view.webContents);

    const entries = this.entries;
    this.entries = null;
    if (entries && entries.length) {
      view.webContents.navigationHistory
        .restore({ entries, index: Math.min(this.entryIndex ?? entries.length - 1, entries.length - 1) })
        .catch(() => view.webContents.loadURL(this.url).catch(() => {}));
    } else {
      view.webContents.loadURL(this.url).catch(() => {});
    }
    if (this.muted) view.webContents.setAudioMuted(true);
    return view;
  }

  applyBackground() {
    if (!this.view) return;
    // Internal pages paint with the theme; the web gets the conventional white.
    this.view.setBackgroundColor(isInternal(this.url) ? this.mgr.themeBg() : '#ffffff');
  }

  bind(wc) {
    const mgr = this.mgr;
    const changed = () => mgr.changed(this);

    wc.on('did-start-loading', () => { this.loading = true; changed(); });
    wc.on('did-stop-loading', () => { this.loading = false; changed(); });

    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && !details.isReload) {
        this.blocked = 0;
      }
    });

    wc.on('did-navigate', (_e, url) => {
      const wasInternal = isInternal(this.url);
      this.url = url;
      if (wasInternal !== isInternal(url)) this.applyBackground();
      if (isInternal(url)) this.favicon = '';
      data.recordVisit(url, wc.getTitle(), '');
      changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      data.recordVisit(url, wc.getTitle(), this.favicon);
      changed();
    });

    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      data.updateHistoryMeta(this.url, { title });
      changed();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (isInternal(this.url)) return;
      const icon = favicons.find((f) => /\.svg($|\?)/i.test(f)) || favicons[0] || '';
      if (icon === this.favicon) return;
      this.favicon = icon;
      data.updateHistoryMeta(this.url, { favicon: icon });
      const bm = data.findBookmark(this.url);
      if (bm && !bm.favicon) { data.updateBookmark(bm.id, { favicon: icon }); mgr.hooks.bookmarksChanged(); }
      changed();
    });

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 = ERR_ABORTED (user navigated away / download started)
      if (!isMainFrame || code === -3 || isInternal(url)) return;
      const err = new URL('coffee://error/');
      err.searchParams.set('url', url);
      err.searchParams.set('code', String(code));
      err.searchParams.set('desc', desc);
      wc.loadURL(err.toString()).catch(() => {});
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.loading = false;
      const err = new URL('coffee://error/');
      err.searchParams.set('url', this.url);
      err.searchParams.set('code', 'crashed');
      err.searchParams.set('desc', 'The page stopped responding.');
      setTimeout(() => { if (this.wc) this.wc.loadURL(err.toString()).catch(() => {}); }, 50);
      changed();
    });

    wc.on('audio-state-changed', (e) => { this.audible = e.audible; changed(); });

    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; mgr.hooks.htmlFullscreen(this, true); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; mgr.hooks.htmlFullscreen(this, false); });

    wc.on('found-in-page', (_e, result) => mgr.hooks.found(this, result));
    wc.on('update-target-url', (_e, url) => mgr.hooks.hoverUrl(this, url));
    wc.on('context-menu', (_e, params) => mgr.hooks.contextMenu(this, params));
    wc.on('before-input-event', (e, input) => mgr.hooks.input(e, input, this));
    wc.on('focus', () => mgr.hooks.pageFocus(this));
    wc.on('zoom-changed', (_e, dir) => mgr.hooks.zoom(this, dir === 'in' ? 1 : -1));

    // Web content may not navigate to (or frame) coffee:// pages; only the
    // browser itself opens those. Internal pages may still link out to the web.
    const fromWeb = () => !isInternal(wc.getURL());
    wc.on('will-navigate', (e) => { if (isInternal(e.url) && fromWeb()) e.preventDefault(); });
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame && isInternal(e.url)) e.preventDefault(); });

    wc.setWindowOpenHandler((details) => {
      const { url, disposition } = details;
      if (isInternal(url) && fromWeb()) return { action: 'deny' };
      // Real popups (OAuth, payment windows) need window.opener, so allow them.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: { session: mgr.session, sandbox: true, contextIsolation: true },
          },
        };
      }
      if (/^https?:|^about:blank/.test(url) || (isInternal(url) && !fromWeb())) {
        mgr.create({ url, background: disposition === 'background-tab', after: this });
      }
      return { action: 'deny' };
    });
  }

  /** Free the renderer but remember where we were. */
  sleep() {
    const wc = this.wc;
    if (!wc) return;
    try {
      this.entries = wc.navigationHistory.getAllEntries();
      this.entryIndex = wc.navigationHistory.getActiveIndex();
    } catch { this.entries = null; }
    this.destroyView();
    this.loading = false;
    this.audible = false;
    this.mgr.changed(this);
  }

  destroyView() {
    const view = this.view;
    this.view = null;
    if (!view) return;
    try { this.mgr.win.contentView.removeChildView(view); } catch { /* not attached */ }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}

class TabManager {
  constructor(win, ses, hooks) {
    this.win = win;
    this.session = ses;
    this.hooks = hooks;
    this.tabs = [];
    this.activeId = null;
    this.closed = []; // for "reopen closed tab"
    this.pending = false;
    this.sleepTimer = setInterval(() => this.sleepIdle(), 60 * 1000);
  }

  radius() { return this.hooks.radius(); }
  themeBg() { return this.hooks.themeBg(); }

  get active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  get(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  byWebContents(wc) {
    return this.tabs.find((t) => t.view && t.view.webContents === wc) || null;
  }

  create({ url = NEWTAB, background = false, after = null, index = null, init = null } = {}) {
    const tab = new Tab(this, init || { url });
    let i = this.tabs.length;
    if (index !== null) i = index;
    else if (after) {
      // Open next to the opener, after any tabs it already opened.
      i = this.tabs.indexOf(after) + 1;
      while (i < this.tabs.length && this.tabs[i].openerId === after.id) i++;
      tab.openerId = after.id;
    }
    this.tabs.splice(i, 0, tab);
    if (background) {
      if (!init) tab.ensureView(); // start loading right away
      this.changed();
    } else {
      this.activate(tab.id);
    }
    return tab;
  }

  activate(id) {
    const tab = this.get(id);
    if (!tab) return;
    const prev = this.active;
    if (prev && prev !== tab && prev.view) {
      if (prev.find) { prev.wc && prev.wc.stopFindInPage('clearSelection'); prev.find = null; }
      this.win.contentView.removeChildView(prev.view);
    }
    this.activeId = id;
    tab.lastActive = Date.now();
    const view = tab.ensureView();
    this.win.contentView.addChildView(view);
    this.hooks.layout();
    this.hooks.activated(tab);
    this.changed();
  }

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    if (tab.url && !tab.url.startsWith(NEWTAB)) {
      let entries = null;
      let entryIndex;
      try {
        entries = tab.wc ? tab.wc.navigationHistory.getAllEntries() : tab.entries;
        entryIndex = tab.wc ? tab.wc.navigationHistory.getActiveIndex() : tab.entryIndex;
      } catch { /* ignore */ }
      this.closed.push({ index: i, init: { url: tab.url, title: tab.title, favicon: tab.favicon, entries, entryIndex } });
      if (this.closed.length > 25) this.closed.shift();
    }
    const wasActive = tab.id === this.activeId;
    this.tabs.splice(i, 1);
    tab.destroyView();
    if (this.tabs.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (wasActive) {
      // Prefer returning to the opener, then the tab to the right, like Chrome.
      const opener = tab.openerId && this.get(tab.openerId);
      const next = opener || this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeId = null;
      this.activate(next.id);
    } else {
      this.changed();
    }
  }

  reopenClosed(i = this.closed.length - 1) {
    const [c] = this.closed.splice(i, 1);
    if (!c) return;
    const tab = this.create({ index: Math.min(c.index, this.tabs.length), init: c.init });
    return tab;
  }

  move(id, index) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.changed();
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  sleepIdle() {
    const mins = Number(data.settings.data.sleepMinutes) || 0;
    if (!mins) return;
    const cutoff = Date.now() - mins * 60 * 1000;
    for (const t of this.tabs) {
      if (t.id === this.activeId || !t.wc || t.audible || t.lastActive > cutoff) continue;
      if (t.wc.isCurrentlyAudible() || t.wc.isDevToolsOpened()) continue;
      t.sleep();
    }
  }

  /** Batch every change made in one tick into a single IPC message. */
  changed() {
    if (this.pending) return;
    this.pending = true;
    // One frame of batching: a burst of events (loading, title, favicon,
    // blocked-request counters) becomes a single IPC message.
    setTimeout(() => {
      this.pending = false;
      this.hooks.render(this.snapshot());
    }, 16);
  }

  snapshot() {
    return { tabs: this.tabs.map((t) => t.serialize()), activeId: this.activeId };
  }

  saveSession() {
    const tabs = this.tabs.map((t) => {
      let entries = t.entries;
      let entryIndex = t.entryIndex;
      if (t.wc) {
        try {
          entries = t.wc.navigationHistory.getAllEntries();
          entryIndex = t.wc.navigationHistory.getActiveIndex();
        } catch { /* ignore */ }
      }
      // Keep only a small window of history around the current entry.
      if (entries && entries.length > 20) {
        const start = Math.max(0, Math.min(entryIndex - 10, entries.length - 20));
        entries = entries.slice(start, start + 20).map((e) => ({ url: e.url, title: e.title }));
        entryIndex -= start;
      } else if (entries) {
        entries = entries.map((e) => ({ url: e.url, title: e.title }));
      }
      return { url: t.url, title: t.title, favicon: t.favicon, entries, entryIndex };
    });
    data.session.data = { tabs, active: Math.max(0, this.tabs.indexOf(this.active)) };
    data.session.save();
  }

  destroy() {
    clearInterval(this.sleepTimer);
    for (const t of this.tabs) t.destroyView();
  }
}

module.exports = { TabManager, NEWTAB, isInternal, displayUrl };
