'use strict';
// Tab lifecycle. A tab's WebContentsView is created lazily (restored and
// background tabs cost nothing until opened) and destroyed again when the tab
// sleeps, while its URL, title, icon and back/forward history are kept.
const path = require('path');
const { WebContentsView } = require('electron');
const data = require('./data');

const INTERNAL_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const NEWTAB = 'coffee://newtab/';
const NEWTAB_PRIVATE = 'coffee://newtab/?private';
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
    // Private tabs use a separate in-memory session and leave no history.
    this.private = !!init.private;
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
    this.playing = false; // media (video or audio) is playing
    this.pip = false;     // a video from this tab is popped out (picture in picture)
    this.boundTo = new WeakSet(); // pages this tab listens to (see bind)
  }

  get session() {
    return this.private ? this.mgr.hooks.privateSession() : this.mgr.session;
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
      private: this.private,
      wcId: wc ? wc.id : -1,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      zoom: this.zoom,
      media: !!wc && (this.playing || this.audible || this.pip),
      pip: this.pip,
    };
  }

  ensureView() {
    if (this.wc) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
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
    if (this.mgr.hooks.viewCreated) this.mgr.hooks.viewCreated(this);
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
    this.boundTo.add(wc);
    // Always the tab's *current* manager: a tab can move to another window
    // while its page keeps running, and its events must follow it there.
    const mgr = () => this.mgr;
    const changed = () => mgr().changed(this);
    // Only the tab's current page speaks for it: a page handed off to keep a
    // popped-out video playing (see handoff) must no longer change the tab.
    const on = (ev, fn) => wc.on(ev, (...args) => { if (this.wc === wc) fn(...args); });

    on('did-start-loading', () => { this.loading = true; changed(); });
    on('did-stop-loading', () => { this.loading = false; changed(); });

    on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && !details.isReload) {
        this.blocked = 0;
      }
    });

    on('did-navigate', (_e, url) => {
      const wasInternal = isInternal(this.url);
      this.url = url;
      if (wasInternal !== isInternal(url)) this.applyBackground();
      if (isInternal(url)) this.favicon = '';
      if (!this.private) data.recordVisit(url, wc.getTitle(), '');
      changed();
    });
    on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      if (!this.private) data.recordVisit(url, wc.getTitle(), this.favicon);
      changed();
    });

    on('page-title-updated', (_e, title) => {
      this.title = title;
      if (!this.private) data.updateHistoryMeta(this.url, { title });
      changed();
    });
    on('page-favicon-updated', (_e, favicons) => {
      if (isInternal(this.url)) return;
      const icon = favicons.find((f) => /\.svg($|\?)/i.test(f)) || favicons[0] || '';
      if (icon === this.favicon) return;
      this.favicon = icon;
      if (!this.private) data.updateHistoryMeta(this.url, { favicon: icon });
      const bm = data.findBookmark(this.url);
      if (bm && !bm.favicon) { data.updateBookmark(bm.id, { favicon: icon }); mgr().hooks.bookmarksChanged(); }
      changed();
    });

    on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 = ERR_ABORTED (user navigated away / download started)
      if (!isMainFrame || code === -3 || isInternal(url)) return;
      const err = new URL('coffee://error/');
      err.searchParams.set('url', url);
      err.searchParams.set('code', String(code));
      err.searchParams.set('desc', desc);
      wc.loadURL(err.toString()).catch(() => {});
    });

    on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.loading = false;
      const err = new URL('coffee://error/');
      err.searchParams.set('url', this.url);
      err.searchParams.set('code', 'crashed');
      err.searchParams.set('desc', 'The page stopped responding.');
      setTimeout(() => { if (this.wc) this.wc.loadURL(err.toString()).catch(() => {}); }, 50);
      changed();
    });

    on('audio-state-changed', (e) => { this.audible = e.audible; changed(); });
    on('media-started-playing', () => { this.playing = true; changed(); });
    on('media-paused', () => { this.playing = false; changed(); });

    on('enter-html-full-screen', () => { this.htmlFullscreen = true; mgr().hooks.htmlFullscreen(this, true); });
    on('leave-html-full-screen', () => { this.htmlFullscreen = false; mgr().hooks.htmlFullscreen(this, false); });

    on('found-in-page', (_e, result) => mgr().hooks.found(this, result));
    on('update-target-url', (_e, url) => mgr().hooks.hoverUrl(this, url));
    on('context-menu', (_e, params) => mgr().hooks.contextMenu(this, params));
    on('before-input-event', (e, input) => mgr().hooks.input(e, input, this));
    on('focus', () => mgr().hooks.pageFocus(this));
    // Clicking into the page ends the "keep the address bar focused" window.
    on('before-mouse-event', (_e, mouse) => { if (mouse.type === 'mouseDown') this.urlbarUntil = 0; });
    on('zoom-changed', (_e, dir) => mgr().hooks.zoom(this, dir === 'in' ? 1 : -1));

    // Web content may not navigate to (or frame) coffee:// pages; only the
    // browser itself opens those. Internal pages may still link out to the web.
    // (Not guarded by `on`: these hold for a handed-off page too.)
    const fromWeb = () => !isInternal(wc.getURL());
    wc.on('will-navigate', (e) => { if (isInternal(e.url) && fromWeb()) e.preventDefault(); });
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame && isInternal(e.url)) e.preventDefault(); });

    // Leaving a page whose video is popped out (a link, a script) hands the
    // page off so the video keeps playing; the tab goes on to the new page.
    // (The handoff waits for the event to return: swapping a page out from
    // inside Chromium's navigation callbacks crashes the browser.)
    const handoffSoon = (url) => setImmediate(() => { if (this.wc === wc && this.pip) this.handoff({ url }); });
    on('will-navigate', (e) => {
      if (!this.pip || (isInternal(e.url) && fromWeb())) return;
      e.preventDefault();
      handoffSoon(e.url);
    });
    // Navigations will-navigate doesn't cover (e.g. history.back() from the page).
    on('did-start-navigation', (details) => {
      if (!this.pip || !details.isMainFrame || details.isSameDocument || details.url === wc.getURL()) return;
      setImmediate(() => { if (this.wc === wc && !wc.isDestroyed()) wc.stop(); });
      handoffSoon(details.url);
    });

    wc.setWindowOpenHandler((details) => {
      const { url, disposition } = details;
      if (this.wc !== wc) return { action: 'deny' }; // a handed-off page opens nothing
      if (isInternal(url) && fromWeb()) return { action: 'deny' };
      // Real popups (OAuth, payment windows) need window.opener, so allow them.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: { session: this.session, sandbox: true, contextIsolation: true },
          },
        };
      }
      if (/^https?:|^about:blank/.test(url) || (isInternal(url) && !fromWeb())) {
        mgr().create({ url, background: disposition === 'background-tab', after: this, private: this.private });
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
    this.playing = false;
    this.pip = false;
    this.mgr.changed(this);
  }

  /**
   * Leave the current page without stopping its popped-out video. The page is
   * handed to the browser to keep playing out of sight (until the floating
   * video is closed), and the tab carries on with a fresh page at `target`:
   * `{ offset: -1 | 1 }` for back/forward, or `{ url }`. History is kept.
   */
  handoff(target) {
    const wc = this.wc;
    if (!wc) return false;
    let entries = [];
    let index = 0;
    try {
      entries = wc.navigationHistory.getAllEntries();
      index = wc.navigationHistory.getActiveIndex();
    } catch { /* fall back to just the target */ }
    if (target.offset) {
      index += target.offset;
      if (!entries[index]) return false;
    } else if (entries[index - 1] && entries[index - 1].url === target.url) {
      index -= 1; // the page went back
    } else if (entries[index + 1] && entries[index + 1].url === target.url) {
      index += 1; // the page went forward
    } else {
      entries = entries.slice(0, index + 1).concat({ url: target.url, title: '' });
      index = entries.length - 1;
    }
    const view = this.view;
    const origin = this.origin();
    if (this.mgr.hooks.viewDestroyed) this.mgr.hooks.viewDestroyed(this);
    try { this.mgr.win.contentView.removeChildView(view); } catch { /* not attached */ }
    this.view = null;
    this.pip = false;
    this.playing = false;
    this.audible = false;
    this.loading = false;
    this.find = null;
    this.entries = entries;
    this.entryIndex = index;
    this.url = entries[index].url;
    this.title = entries[index].title || '';
    this.mgr.hooks.keepPip(view, origin);
    if (this.mgr.shown.has(this.id)) {
      this.mgr.syncViews(); // a fresh page takes the old one's place
      if (this.mgr.activeId === this.id && this.wc) this.wc.focus();
    }
    this.mgr.changed(this);
    return true;
  }

  destroyView() {
    const view = this.view;
    if (view && this.mgr.hooks.viewDestroyed) this.mgr.hooks.viewDestroyed(this);
    this.view = null;
    if (!view) return;
    try { this.mgr.win.contentView.removeChildView(view); } catch { /* not attached */ }
    // Closing a tab (or its window) doesn't stop its popped-out video: the
    // page keeps playing out of sight until the floating video is closed.
    if (this.pip && !view.webContents.isDestroyed() && this.mgr.hooks.keepPip) {
      this.pip = false;
      this.mgr.hooks.keepPip(view, this.origin());
      return;
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** What a handed-off page needs to find its way back here ("Back to tab"). */
  origin() {
    return { tab: this, title: this.title, favicon: this.favicon, private: this.private, muted: this.muted };
  }

  /**
   * Make `view` (a page handed off earlier, still running) this tab's page
   * again, replacing whatever the tab shows now. Its history comes with it.
   */
  takeView(view, origin = {}) {
    const old = this.view;
    if (old) {
      if (this.mgr.hooks.viewDestroyed) this.mgr.hooks.viewDestroyed(this);
      try { this.mgr.win.contentView.removeChildView(old); } catch { /* not attached */ }
      if (!old.webContents.isDestroyed()) old.webContents.close();
    }
    const wc = view.webContents;
    this.view = view;
    this.entries = null;
    this.url = wc.getURL();
    this.title = wc.getTitle() || origin.title || '';
    if (origin.favicon) this.favicon = origin.favicon;
    this.loading = wc.isLoading();
    this.audible = wc.isCurrentlyAudible();
    this.playing = true;
    this.pip = false;
    this.find = null;
    if (!this.boundTo.has(wc)) this.bind(wc); // a new tab for a page whose tab was closed
    wc.setAudioMuted(this.muted);
    view.setBorderRadius(this.mgr.radius());
    this.applyBackground();
    if (this.mgr.hooks.viewCreated) this.mgr.hooks.viewCreated(this);
    this.mgr.changed(this);
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
    // Split view: two tabs shown side by side ({ left, right } tab ids). The
    // pair stays together while you visit other tabs; it's on screen whenever
    // one of its tabs is the active one.
    this.pair = null;
    this.splitRatio = 0.5; // share of the width given to the left tab
    this.shown = new Set(); // ids of tabs whose views are attached to the window
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

  /** Tab ids that belong on screen: the active tab, plus its partner when it's in the split. */
  visibleIds() {
    const p = this.pair;
    if (p && (this.activeId === p.left || this.activeId === p.right)) return [p.left, p.right];
    return this.activeId !== null ? [this.activeId] : [];
  }

  /** The other tab on screen beside the active one, if the split is showing. */
  get pane() {
    const ids = this.visibleIds();
    return ids.length === 2 ? ids.find((id) => id !== this.activeId) : null;
  }

  /** Attach the views that belong on screen, detach the rest, then lay them out. */
  syncViews() {
    const want = this.visibleIds();
    for (const id of this.shown) {
      if (want.includes(id)) continue;
      const t = this.get(id);
      if (t && t.view) {
        try { this.win.contentView.removeChildView(t.view); } catch { /* not attached */ }
      }
    }
    for (const id of want) {
      const t = this.get(id);
      if (!t) continue;
      this.win.contentView.addChildView(t.ensureView());
      t.lastActive = Date.now();
    }
    this.shown = new Set(want);
    this.hooks.layout();
  }

  create({ url = NEWTAB, background = false, after = null, index = null, init = null, private: priv = false } = {}) {
    if (priv && url === NEWTAB) url = NEWTAB_PRIVATE;
    const tab = new Tab(this, init || { url, private: priv });
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

  /**
   * Make a tab the active one. In a split, picking either half just moves the
   * focus there (the address bar follows); picking any other tab shows it alone.
   * `opts.fromPage`: the user clicked into the page itself.
   */
  activate(id, opts = {}) {
    const tab = this.get(id);
    if (!tab) return;
    const prev = this.active;
    if (prev && prev !== tab) {
      this.prevActiveId = prev.id; // the tab you were on, e.g. to split with
      if (prev.find) {
        if (prev.wc) prev.wc.stopFindInPage('clearSelection');
        prev.find = null;
      }
    }
    this.activeId = id;
    tab.lastActive = Date.now();
    this.syncViews();
    this.hooks.activated(tab, opts);
    this.changed();
  }

  /** Show `id` beside the active tab (split view). */
  split(id) {
    const tab = this.get(id);
    const cur = this.active;
    if (!tab || !cur || tab === cur) return false;
    this.pair = { left: cur.id, right: tab.id };
    this.syncViews();
    this.changed();
    return true;
  }

  /** Show tab `id` on one side (`left` | `right`) of a split with `partnerId`, and make it active. */
  splitAt(id, side, partnerId) {
    if (!this.get(id) || !this.get(partnerId) || id === partnerId) return false;
    this.pair = side === 'left' ? { left: id, right: partnerId } : { left: partnerId, right: id };
    this.activate(id);
    return true;
  }

  /**
   * Which tab would share the page with `id` if it were dropped on `side`:
   * the tab already on the other side of a split on screen, otherwise the
   * active tab (or, when `id` is the active one, the tab you were on before).
   */
  splitPartner(id, side) {
    if (this.pane !== null && this.pair) {
      const other = side === 'left' ? this.pair.right : this.pair.left;
      const same = side === 'left' ? this.pair.left : this.pair.right;
      return other !== id ? other : same;
    }
    if (this.activeId !== null && this.activeId !== id) return this.activeId;
    const prev = this.prevActiveId;
    return prev && prev !== id && this.get(prev) ? prev : null;
  }

  /** Back to one tab. Both tabs stay open; only the active one stays on screen. */
  unsplit() {
    if (!this.pair) return;
    this.pair = null;
    this.syncViews();
    this.changed();
  }

  /** Swap which tab is on the left and which is on the right. */
  swapPanes() {
    if (!this.pair) return;
    this.pair = { left: this.pair.right, right: this.pair.left };
    this.hooks.layout();
    this.changed();
  }

  /** Set how much of the width the left tab gets (0.2 to 0.8). */
  setSplitRatio(r) {
    if (!Number.isFinite(r)) return;
    this.splitRatio = Math.max(0.2, Math.min(0.8, r));
    this.hooks.layout();
  }

  /** Take `id` out of the split (if it's in it). Returns its partner's id, or null. */
  unpair(id) {
    const p = this.pair;
    if (!p || (p.left !== id && p.right !== id)) return null;
    this.pair = null;
    return p.left === id ? p.right : p.left;
  }

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    // Private tabs are never offered for reopening.
    if (!tab.private && tab.url && !tab.url.startsWith(NEWTAB)) {
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
    // Closing one half of the split leaves the other half as a normal tab.
    const partner = this.unpair(id);
    this.tabs.splice(i, 1);
    this.shown.delete(id);
    tab.destroyView();
    if (tab.private && !this.tabs.some((t) => t.private)) this.hooks.privateEnded();
    if (this.tabs.length === 0) {
      this.activeId = null;
      this.create();
      return;
    }
    if (wasActive) {
      // Prefer the split partner, then the opener, then the tab to the right, like Chrome.
      const opener = tab.openerId && this.get(tab.openerId);
      const next = (partner && this.get(partner)) || opener || this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeId = null;
      this.activate(next.id);
    } else {
      if (partner) this.syncViews(); // the other half now fills the page
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
      if (this.shown.has(t.id) || !t.wc || t.audible || t.pip || t.lastActive > cutoff) continue;
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
    return {
      tabs: this.tabs.map((t) => t.serialize()),
      activeId: this.activeId,
      paneId: this.pane,
      pair: this.pair ? [this.pair.left, this.pair.right] : null,
    };
  }

  /** This window's tabs and active index, for the session file (private tabs are never saved). */
  sessionData() {
    const kept = this.tabs.filter((t) => !t.private);
    const tabs = kept.map((t) => {
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
    return { tabs, active: Math.max(0, kept.indexOf(this.active)) };
  }

  destroy() {
    clearInterval(this.sleepTimer);
    for (const t of this.tabs) t.destroyView();
  }

  /**
   * Take a tab out of this window without destroying its page (for a move to
   * another window). The view is detached here; `adopt` attaches it elsewhere.
   */
  release(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const tab = this.tabs[i];
    const wasActive = this.activeId === id;
    const partner = this.unpair(id);
    this.tabs.splice(i, 1);
    this.shown.delete(id);
    if (tab.view && this.win && !this.win.isDestroyed()) {
      try { this.win.contentView.removeChildView(tab.view); } catch { /* not attached */ }
    }
    if (tab.find) { if (tab.wc) tab.wc.stopFindInPage('clearSelection'); tab.find = null; }
    if (this.hooks.viewDestroyed) this.hooks.viewDestroyed(tab);
    if (wasActive) {
      this.activeId = null;
      if (this.tabs.length) {
        const next = (partner && this.get(partner)) || this.tabs[Math.min(i, this.tabs.length - 1)];
        this.activate(next.id);
      } else {
        this.changed();
      }
    } else {
      if (partner) this.syncViews();
      this.changed();
    }
    return tab;
  }

  /** Put a tab that came from another window into this one, keeping its page alive. */
  adopt(tab, index = this.tabs.length) {
    tab.mgr = this;
    tab.openerId = undefined;
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    if (tab.view && this.hooks.viewCreated) this.hooks.viewCreated(tab);
    if (tab.view) tab.view.setBorderRadius(this.radius());
    this.activate(tab.id);
  }
}

module.exports = { TabManager, NEWTAB, NEWTAB_PRIVATE, isInternal, displayUrl };
