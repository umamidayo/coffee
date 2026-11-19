'use strict';
// Persistent user data: settings, bookmarks, history, session.
const { app } = require('electron');
const Store = require('./store');

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
};

const settings = new Store('settings', {
  searchEngine: 'google',
  adblock: true,
  bookmarksBar: true,
  tabLayout: 'vertical',   // 'vertical' (side) | 'horizontal' (top)
  compactSidebar: false,   // side tabs hidden until the mouse reaches the left edge
  sleepMinutes: 30,
  restoreSession: true,
  theme: { preset: 'coffee', custom: null },
  downloadDir: app.getPath('downloads'),
  windowBounds: null,
  maximized: false,
  permissions: {},
  blockedTotal: 0,
});

const bookmarks = new Store('bookmarks', []);
const session = new Store('session', { tabs: [], active: 0 }, 1500);
const historyStore = new Store('history', [], 2500);

// History lives in a Map at runtime for O(1) updates.
const history = new Map(historyStore.data.map((h) => [h.url, h]));
const HISTORY_CAP = 4000;

function persistHistory() {
  let list = [...history.values()];
  if (list.length > HISTORY_CAP) {
    list.sort((a, b) => b.last - a.last);
    list = list.slice(0, HISTORY_CAP);
    history.clear();
    for (const h of list) history.set(h.url, h);
  }
  historyStore.data = list;
  historyStore.save();
}

function isRecordable(url) {
  return /^https?:\/\//i.test(url);
}

function recordVisit(url, title, favicon) {
  if (!isRecordable(url)) return;
  const h = history.get(url) || { url, title: '', favicon: '', visits: 0, last: 0 };
  h.visits += 1;
  h.last = Date.now();
  if (title) h.title = title;
  if (favicon) h.favicon = favicon;
  history.set(url, h);
  persistHistory();
}

function updateHistoryMeta(url, { title, favicon }) {
  const h = history.get(url);
  if (!h) return;
  if (title) h.title = title;
  if (favicon) h.favicon = favicon;
  persistHistory();
}

function clearHistory() {
  history.clear();
  persistHistory();
}

// ---- Bookmarks -------------------------------------------------------------

let bmSeq = Date.now();
function findBookmark(url) {
  return bookmarks.data.find((b) => b.url === url);
}
function addBookmark({ url, title, favicon }) {
  if (!url || findBookmark(url)) return findBookmark(url);
  const b = { id: String(bmSeq++), url, title: title || url, favicon: favicon || '' };
  bookmarks.data.push(b);
  bookmarks.save();
  return b;
}
function removeBookmark(id) {
  bookmarks.data = bookmarks.data.filter((b) => b.id !== id);
  bookmarks.save();
}
function updateBookmark(id, patch) {
  const b = bookmarks.data.find((x) => x.id === id);
  if (!b) return;
  if (typeof patch.title === 'string') b.title = patch.title.slice(0, 300);
  if (typeof patch.favicon === 'string') b.favicon = patch.favicon;
  bookmarks.save();
}
function moveBookmark(id, index) {
  const i = bookmarks.data.findIndex((b) => b.id === id);
  if (i < 0) return;
  const [b] = bookmarks.data.splice(i, 1);
  bookmarks.data.splice(Math.max(0, Math.min(index, bookmarks.data.length)), 0, b);
  bookmarks.save();
}

// ---- Omnibox ---------------------------------------------------------------

function searchUrl(q) {
  const eng = SEARCH_ENGINES[settings.data.searchEngine] || SEARCH_ENGINES.google;
  return eng.url.replace('%s', encodeURIComponent(q));
}

/** Turn whatever the user typed into a URL. */
function toUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^javascript:/i.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|mailto|view-source):/i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
  if (!/\s/.test(s) && /^[^\s/?#]+\.[a-z][a-z0-9-]{1,62}\.?(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
  return searchUrl(s);
}

function stripUrl(u) {
  return u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

function suggest(query) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  if (!q) return out;
  const direct = toUrl(q);
  const isSearch = direct === searchUrl(q);
  const eng = SEARCH_ENGINES[settings.data.searchEngine] || SEARCH_ENGINES.google;
  out.push(isSearch
    ? { kind: 'search', title: q, sub: `Search ${eng.name}`, url: direct }
    : { kind: 'url', title: stripUrl(direct), sub: 'Open', url: direct });

  const seen = new Set([direct]);
  const scored = [];
  const score = (item, base) => {
    const url = item.url.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const bare = stripUrl(url);
    let s = 0;
    if (bare.startsWith(q)) s += 100;
    else if (url.includes(q)) s += 40;
    if (title.startsWith(q)) s += 60;
    else if (title.includes(q)) s += 25;
    if (!s) return 0;
    return s + base;
  };
  for (const b of bookmarks.data) {
    const s = score(b, 50);
    if (s) scored.push({ s, item: { kind: 'bookmark', title: b.title, sub: stripUrl(b.url), url: b.url, favicon: b.favicon } });
  }
  const now = Date.now();
  for (const h of history.values()) {
    const recency = Math.max(0, 30 - (now - h.last) / 86400000);
    const s = score(h, Math.min(h.visits, 40) + recency);
    if (s) scored.push({ s, item: { kind: 'history', title: h.title || stripUrl(h.url), sub: stripUrl(h.url), url: h.url, favicon: h.favicon } });
  }
  scored.sort((a, b) => b.s - a.s);
  for (const { item } of scored) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= 7) break;
  }
  if (!isSearch) {
    out.push({ kind: 'search', title: q, sub: `Search ${eng.name}`, url: searchUrl(q) });
  }
  return out;
}

function topSites(n = 8) {
  const byHost = new Map();
  for (const h of history.values()) {
    let host;
    try { host = new URL(h.url).host; } catch { continue; }
    const cur = byHost.get(host);
    const score = h.visits;
    if (!cur) byHost.set(host, { ...h, score, url: new URL(h.url).origin + '/' , title: h.title });
    else {
      cur.score += score;
      if (!cur.favicon && h.favicon) cur.favicon = h.favicon;
    }
  }
  return [...byHost.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((h) => ({ url: h.url, title: prettyHost(h.url), favicon: h.favicon }));
}

function prettyHost(u) {
  try {
    const host = new URL(u).hostname.replace(/^www\./, '');
    const name = host.split('.').slice(-2, -1)[0] || host;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return u;
  }
}

module.exports = {
  SEARCH_ENGINES,
  settings,
  bookmarks,
  session,
  history,
  recordVisit,
  updateHistoryMeta,
  clearHistory,
  findBookmark,
  addBookmark,
  removeBookmark,
  updateBookmark,
  moveBookmark,
  toUrl,
  suggest,
  topSites,
  Store,
};
