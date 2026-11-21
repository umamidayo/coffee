'use strict';
// Persistent user data: settings, bookmarks, history, session.
const { app } = require('electron');
const Store = require('./store');
const sites = require('./sites');

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
  bookmarksButton: false,  // toolbar button that opens your bookmarks as a menu (works with or without the bar)
  tabLayout: 'vertical',   // 'vertical' (side) | 'horizontal' (top)
  compactSidebar: false,   // side tabs hidden until the mouse reaches the left edge
  tabTitles: true,         // titles on every tab layout (false = icons only)
  adblockExceptions: [],   // sites (and their subdomains) where ads and trackers aren't blocked
  homePage: '',            // address the Home button / Alt+Home opens ('' = the new tab page)
  showHome: false,         // Home button in the toolbar
  newtabShortcuts: true,   // shortcut tiles on the new tab page
  hiddenShortcuts: [],     // hosts removed from the new tab page
  onboarded: false,        // finished (or skipped) the welcome setup
  extensions: false,       // opt-in Chrome extension support (takes effect on restart)
  sleepMinutes: 30,
  restoreSession: true,
  theme: { preset: 'coffee', custom: null, saved: [] },
  downloadDir: app.getPath('downloads'),
  windowBounds: null,
  maximized: false,
  permissions: {},
  blockedTotal: 0,
});

// People who used Coffee before the welcome setup existed shouldn't see it.
if (settings.existed && !settings.loadedKeys.has('onboarded')) settings.data.onboarded = true;
// The old unsaved "Custom" theme slot couldn't be edited after saving or
// removed; custom themes are now all saved themes. Keep its colors as one.
{
  const th = settings.data.theme;
  if (th && th.custom && typeof th.custom === 'object') {
    const saved = Array.isArray(th.saved) ? th.saved : (th.saved = []);
    const id = `custom${Date.now().toString(36)}`;
    const same = saved.find((x) => ['bg', 'surface', 'text', 'accent'].every((k) => x[k] === th.custom[k]));
    if (!same) saved.push({ id, name: 'Custom', bg: th.custom.bg, surface: th.custom.surface, text: th.custom.text, accent: th.custom.accent });
    if (th.preset === 'custom') th.preset = `saved:${same ? same.id : id}`;
    th.custom = null;
    settings.save();
  }
}

// Multiple windows and split view used to be switches (once one "experimental"
// switch); they're always on now.
if ('experimental' in settings.data || 'multiWindow' in settings.data || 'splitView' in settings.data) {
  delete settings.data.experimental;
  delete settings.data.multiWindow;
  delete settings.data.splitView;
  settings.save();
}
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

/**
 * Merge imported history entries; returns how many were new. Visit counts
 * take the larger value (not the sum), so importing twice changes nothing.
 */
function importHistory(entries) {
  let n = 0;
  for (const e of entries) {
    if (!isRecordable(e.url)) continue;
    const h = history.get(e.url);
    if (h) {
      h.visits = Math.max(h.visits, e.visits);
      h.last = Math.max(h.last, e.last);
      if (!h.title && e.title) h.title = e.title;
      if (!h.favicon && e.favicon) h.favicon = e.favicon;
    } else {
      history.set(e.url, { url: e.url, title: e.title, favicon: e.favicon || '', visits: e.visits, last: e.last });
      n++;
    }
  }
  persistHistory();
  return n;
}

/**
 * History for the history page: newest first, optionally filtered by a search
 * query (title or address), paged by `offset`.
 */
function historyList({ q = '', offset = 0, limit = 150 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  let list = [...history.values()];
  if (query) {
    const words = query.split(/\s+/);
    list = list.filter((h) => {
      const hay = `${h.title || ''} ${h.url}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  list.sort((a, b) => b.last - a.last);
  const start = Math.max(0, Number(offset) || 0);
  const items = list.slice(start, start + limit).map((h) => ({ url: h.url, title: h.title, favicon: h.favicon || '', last: h.last, visits: h.visits }));
  return { items, total: list.length, more: start + limit < list.length };
}

function deleteHistory(urls) {
  let n = 0;
  for (const u of urls || []) if (history.delete(String(u))) n++;
  if (n) persistHistory();
  return n;
}

function clearHistory() {
  const n = history.size;
  history.clear();
  persistHistory();
  return n;
}

/** Start of the local day `n` days ago. */
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

/** Remove entries whose last visit falls in [from, to); returns how many. */
function clearHistorySpan(from, to) {
  let n = 0;
  for (const [url, h] of history) {
    if (h.last >= from && h.last < to) { history.delete(url); n++; }
  }
  if (n) persistHistory();
  return n;
}

/** Clear by calendar day: today, yesterday, the last 3 / 7 days (today included), or everything. */
function clearHistoryRange(range) {
  switch (range) {
    case 'today': return clearHistorySpan(daysAgo(0), Infinity);
    case 'yesterday': return clearHistorySpan(daysAgo(1), daysAgo(0));
    case '3days': return clearHistorySpan(daysAgo(2), Infinity);
    case '7days': return clearHistorySpan(daysAgo(6), Infinity);
    case 'all': return clearHistory();
    default: return 0;
  }
}

/** Sites that appear in history, most visited first. */
function historySites() {
  const map = new Map();
  for (const h of history.values()) {
    const host = sites.hostOf(h.url);
    if (host) map.set(host, (map.get(host) || 0) + 1);
  }
  return [...map].map(([site, count]) => ({ site, count })).sort((a, b) => b.count - a.count || a.site.localeCompare(b.site)).slice(0, 500);
}

/** Remove every page of a site (and its subdomains). */
function clearHistorySite(site) {
  const wanted = sites.normalizeHost(site);
  if (!wanted) return 0;
  let n = 0;
  for (const [url, h] of history) {
    if (sites.matches(sites.hostOf(h.url), wanted)) { history.delete(url); n++; }
  }
  if (n) persistHistory();
  return n;
}

// ---- Bookmarks & folders ----------------------------------------------------
// One ordered list of items: { id, type: 'bookmark' | 'folder', parent, title,
// url?, favicon? }. `parent` is a folder id, or null for the bookmarks bar.
// Sibling order is the order within the list.

// Bookmarks saved before folders existed have no type/parent: they live on the bar.
for (const b of bookmarks.data) {
  if (!b.type) b.type = 'bookmark';
  if (b.parent === undefined) b.parent = null;
}

let bmSeq = Date.now();
const newId = () => String(bmSeq++);
const itemById = (id) => bookmarks.data.find((b) => b.id === id) || null;
const isFolder = (id) => { const f = itemById(id); return !!f && f.type === 'folder'; };
const validParent = (parent) => (parent && isFolder(parent) ? parent : null);

function findBookmark(url) {
  return bookmarks.data.find((b) => b.type === 'bookmark' && b.url === url);
}

function children(parent = null) {
  return bookmarks.data.filter((b) => b.parent === parent);
}

/** Ids of a folder and everything inside it. */
function subtree(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bookmarks.data) {
      if (b.parent && out.has(b.parent) && !out.has(b.id)) { out.add(b.id); grew = true; }
    }
  }
  return out;
}

function addBookmark({ url, title, favicon, parent = null }) {
  if (!url) return null;
  const existing = findBookmark(url);
  if (existing) return existing;
  const b = { id: newId(), type: 'bookmark', parent: validParent(parent), url, title: title || url, favicon: favicon || '' };
  bookmarks.data.push(b);
  bookmarks.save();
  return b;
}

function addFolder(title, parent = null) {
  const f = { id: newId(), type: 'folder', parent: validParent(parent), title: String(title || 'New folder').slice(0, 120) };
  bookmarks.data.push(f);
  bookmarks.save();
  return f;
}

/** Remove a bookmark, or a folder together with everything inside it. */
function removeBookmark(id) {
  const gone = subtree(id);
  bookmarks.data = bookmarks.data.filter((b) => !gone.has(b.id));
  bookmarks.save();
}

function updateBookmark(id, patch) {
  const b = itemById(id);
  if (!b) return;
  if (typeof patch.title === 'string') b.title = patch.title.slice(0, 300);
  if (typeof patch.favicon === 'string' && b.type === 'bookmark') b.favicon = patch.favicon;
  if ('parent' in patch && validParent(patch.parent) !== b.parent) moveBookmark(id, { parent: patch.parent });
  bookmarks.save();
}

/**
 * Move an item into `parent` (null = bar) at sibling position `index`
 * (default: last). A folder can't be moved into itself or its descendants.
 */
function moveBookmark(id, { parent = null, index = Infinity } = {}) {
  const item = itemById(id);
  if (!item) return;
  const target = validParent(parent);
  if (item.type === 'folder' && target && subtree(id).has(target)) return;
  bookmarks.data.splice(bookmarks.data.indexOf(item), 1);
  item.parent = target;
  const siblings = children(target);
  if (index >= siblings.length) {
    // After the last sibling (or at the end if the folder is empty).
    const last = siblings[siblings.length - 1];
    bookmarks.data.splice(last ? bookmarks.data.indexOf(last) + 1 : bookmarks.data.length, 0, item);
  } else {
    bookmarks.data.splice(bookmarks.data.indexOf(siblings[Math.max(0, index)]), 0, item);
  }
  bookmarks.save();
}

/** Folders as a flat, indented list for pickers: [{ id, title, depth }]. */
function folderTree() {
  const out = [];
  const walk = (parent, depth) => {
    for (const f of children(parent)) {
      if (f.type !== 'folder') continue;
      out.push({ id: f.id, title: f.title, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function allBookmarks() {
  return bookmarks.data.filter((b) => b.type === 'bookmark');
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

/**
 * Inline autocomplete: what the address bar should complete `typed` to.
 * Whole sites first ("goo" -> "google.com", ranked by visits across all of
 * the site's pages); once a "/" is typed, specific pages ("github.com/u" ->
 * "github.com/umamidayo"). Returns { text, url } or null.
 */
function inlineCompletion(typed) {
  const q = String(typed || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (!q || /\s/.test(q)) return null;
  const cands = new Map();
  const consider = (url, weight) => {
    let u;
    try { u = new URL(url); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const host = u.hostname.replace(/^www\./, '');
    let text;
    let target;
    if (host.startsWith(q)) {
      text = host;
      target = `${u.protocol}//${u.host}/`;
    } else if (q.includes('/')) {
      const bare = stripUrl(url).toLowerCase();
      if (!bare.startsWith(q)) return;
      text = stripUrl(url);
      target = url;
    } else {
      return;
    }
    const c = cands.get(text) || { text, url: target, score: 0 };
    c.score += weight;
    cands.set(text, c);
  };
  const now = Date.now();
  for (const h of history.values()) {
    const days = (now - h.last) / 86400000;
    consider(h.url, h.visits + (days < 1 ? 5 : days < 7 ? 2 : 0));
  }
  for (const b of allBookmarks()) consider(b.url, 20);
  let best = null;
  for (const c of cands.values()) {
    // Prefer more visits; on a tie, the shorter (more general) completion.
    if (!best || c.score > best.score || (c.score === best.score && c.text.length < best.text.length)) best = c;
  }
  return best ? { text: best.text, url: best.url } : null;
}

function suggest(query, { inline = true } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  if (!q) return out;
  const direct = toUrl(q);
  const isSearch = direct === searchUrl(q);
  const eng = SEARCH_ENGINES[settings.data.searchEngine] || SEARCH_ENGINES.google;
  // First row is what Enter does: the inline completion when there is one.
  const completion = inline ? inlineCompletion(query) : null;
  if (completion) out.push({ kind: 'url', title: completion.text, sub: 'Open', url: completion.url, inline: completion.text });
  out.push(isSearch
    ? { kind: 'search', title: q, sub: `Search ${eng.name}`, url: direct }
    : { kind: 'url', title: stripUrl(direct), sub: 'Open', url: direct });

  const seen = new Set([direct]);
  if (completion) seen.add(completion.url);
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
  for (const b of allBookmarks()) {
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

function hostKey(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function hideShortcut(url) {
  const host = hostKey(url);
  if (!host) return;
  const list = settings.data.hiddenShortcuts || (settings.data.hiddenShortcuts = []);
  if (!list.includes(host)) list.push(host);
  if (list.length > 500) list.splice(0, list.length - 500);
  settings.save();
}

/** New tab shortcuts: bar bookmarks first, then most-visited sites. */
function shortcuts(n = 8) {
  const hidden = new Set(settings.data.hiddenShortcuts || []);
  const seen = new Set();
  const out = [];
  const add = (it) => {
    const host = hostKey(it.url);
    if (!host || hidden.has(host) || seen.has(host)) return;
    seen.add(host);
    out.push({ url: it.url, title: it.title, favicon: it.favicon || '' });
  };
  for (const b of children(null)) if (b.type === 'bookmark') add(b);
  for (const s of topSites(n * 2)) add(s);
  return out.slice(0, n);
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
  clearHistoryRange,
  clearHistorySite,
  historySites,
  historyList,
  deleteHistory,
  importHistory,
  findBookmark,
  addBookmark,
  addFolder,
  removeBookmark,
  updateBookmark,
  moveBookmark,
  children,
  subtree,
  folderTree,
  allBookmarks,
  itemById,
  toUrl,
  suggest,
  topSites,
  shortcuts,
  hideShortcut,
  Store,
};
